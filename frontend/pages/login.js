import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Banner, Button, Form, FormLayout, InlineStack, Link, Text, TextField } from '@shopify/polaris';

import AuthApiService from '../API_Services/authService';
import AuthPanel from '../components/auth/AuthPanel';
import { hasAuthToken } from '../utils/auth';
import { AUTH_ROUTES, LOGIN_NOTICES, isPublicRoute } from '../utils/publicRoutes';

/**
 * Where a successful sign-in lands when nothing else was requested.
 *
 * `/`, not a dashboard screen: which screen a person can open depends on their role, and `pages/index.js`
 * is the one place that decides it (it forwards to the first screen the role can see, once the session
 * has loaded). Naming a screen here would send a role without that screen's permissions straight to a
 * "Restricted" page on every sign-in.
 */
const DEFAULT_DESTINATION = '/';

/** One service instance for the module. Constructing one per render would build a new axios client per keystroke. */
const AUTH_API = new AuthApiService();

/** The success banners the token pages ask for when they hand over to this one. */
const NOTICE_COPY = Object.freeze([
    {
        notice: LOGIN_NOTICES.SETUP_DONE,
        text: 'Setup is complete. Sign in with the email address and password you just chose.'
    },
    {
        notice: LOGIN_NOTICES.INVITED,
        text: 'Your account is ready. Sign in with the email address the invitation was sent to and the password you just chose.'
    },
    {
        notice: LOGIN_NOTICES.RESET_DONE,
        text: 'Your password has been changed and every session on your account was signed out. Sign in with the new password.'
    }
]);

/**
 * Whether a string contains a character the URL parser strips or rewrites: ASCII whitespace and
 * control characters, DEL, the C1 controls, or a backslash.
 *
 * Written as a loop rather than a regex so the control-character range needs no lint exemption.
 *
 * @param {String} value - A candidate `next`.
 * @returns {Boolean} True when any such character is present.
 */
const _hasUrlUnsafeChar = (value) => {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code <= 0x20 || (code >= 0x7F && code <= 0x9F) || code === 0x5C) {
            return true;
        }
    }
    return false;
};

/**
 * Decides where to send someone after a successful sign-in.
 *
 *  THIS IS AN OPEN-REDIRECT GUARD, not a formatting helper. `next` arrives in the query string —
 * set by the auth gate in `_app.js`, by the axios 401 interceptor, or by anyone who can get a user to
 * click a link. Passing it to `router.replace` unchecked means a crafted
 * `/login?next=https://evil.example/login` hands them a convincing copy of this form, on the referrer
 * of a real sign-in, immediately after they typed a password into the genuine one.
 *
 * So only a path on THIS origin is accepted, and the check is written as a whitelist:
 *
 *   - no whitespace, control character or backslash ANYWHERE. ⚠️ The URL parser silently deletes
 *     tab, CR and LF and reads '\' as '/', so `/%09/evil.example` arrives here as '/', TAB,
 *     '/evil.example' — which passes a "second character is not a slash" test and is then resolved
 *     by the browser (and by Next's `isLocalURL`) as `//evil.example`, another ORIGIN. That bypass
 *     was live in the two checks below until this one was added in front of them;
 *   - it must start with exactly one '/', which rejects `https://…` and any other scheme;
 *   - the second character must not be '/', which rejects the protocol-relative `//evil.example`;
 *   - it must not be a public page — the sign-in form itself, or a setup / invite / reset page that
 *     has nothing to show a signed-in person (and whose token would be long gone).
 *
 * Anything else falls back to the default rather than erroring — a mangled `next` is not worth an
 * error screen, and silently going somewhere safe is the correct failure direction.
 *
 * @param {*} nextParam - The raw `next` query value. May be a string, an array (a repeated query
 * parameter), or undefined.
 * @returns {String} A same-origin path to navigate to.
 */
const resolveDestination = (nextParam) => {
    let candidate = nextParam;

    // A repeated `?next=a&next=b` arrives as an array. Take the first and check it like any other;
    // do not join them, which would build a path that was never sent.
    if (Array.isArray(candidate)) {
        candidate = candidate[0];
    }

    if (typeof candidate !== 'string' || !candidate) {
        return DEFAULT_DESTINATION;
    }
    if (_hasUrlUnsafeChar(candidate)) {
        return DEFAULT_DESTINATION;
    }
    if (candidate[0] !== '/' || candidate[1] === '/') {
        return DEFAULT_DESTINATION;
    }

    // Compare the DECODED path, so `/%6Cogin` is recognised as /login. A path that will not decode is
    // not a path this app produced.
    let path = candidate.split(/[?#]/)[0];
    try {
        path = decodeURIComponent(path);
    } catch (e) {
        return DEFAULT_DESTINATION;
    }
    if (isPublicRoute(path)) {
        return DEFAULT_DESTINATION;
    }
    return candidate;
};

/**
 * The sign-in screen.
 *
 * ──  IT MUST NOT SAY WHICH HALF WAS WRONG ─────────────────────────────────────────────────────
 * The backend answers one message for an unknown email, a wrong password and a disabled account,
 * and pays the same bcrypt cost either way so the response TIME does not give the answer away
 * instead. This page renders `resp.msg` verbatim and adds no branch of its own on the failure — no
 * "no account with that email", no per-field error, no different wording for the cases. Any of
 * those would turn the form into an oracle for "does this person have an account here", which is
 * the one question a public endpoint should never answer.
 *
 * Field-level validation for EMPTY inputs is fine and is done here: "enter your password" is
 * knowable from the form alone and reveals nothing about which accounts exist.
 *
 * ── FIRST RUN ────────────────────────────────────────────────────────────────────────────────
 * A fresh install has no accounts, so this form cannot succeed until setup creates the owner. On
 * mount it asks `GET /api/auth/setup` and forwards to /setup when setup is not complete. The form is
 * rendered while that is in flight rather than held behind a spinner — every ordinary sign-in would
 * otherwise pay for a check that only matters once per install. If the check FAILS, the form stays
 * and a banner says the check could not be made; sign-in is not made to depend on it.
 *
 * @returns {JSX.Element} The sign-in form.
 */
function LoginPage() {
    const router = useRouter();

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [setupCheckFailedMessage, setSetupCheckFailedMessage] = useState('');

    /**
     * Guards the already-signed-in bounce. `useRouter()` returns a new object each render, so the
     * effect below can re-run before the navigation it started has committed — and a second
     * `replace` to the same URL while the first is in flight is how a redirect becomes a loop.
     */
    const bounceStartedRef = useRef(false);

    /** One setup-status check per mount, however many times reactStrictMode runs the effect. */
    const setupCheckStartedRef = useRef(false);

    // A signed-in person who navigates here (a bookmark, a back button) should carry on rather than
    // be shown a form they do not need. `hasAuthToken` only proves a token EXISTS — an expired or
    // revoked one still lands them on a page whose first request 401s, and the axios interceptor
    // sends them straight back here with the token cleared. That round trip is correct: only the API
    // can say whether a token is still good.
    //
    // Waits for `router.isReady`: this page is statically optimised, so `router.query` is EMPTY on
    // the first render and `next` would be silently dropped.
    useEffect(() => {
        if (!router.isReady || bounceStartedRef.current || !hasAuthToken()) {
            return;
        }
        bounceStartedRef.current = true;
        router.replace(resolveDestination(router.query.next));
    }, [router]);

    // First run: no owner exists yet, so send the visitor to /setup. Skipped when a token is present
    // — the bounce above takes over, and a token that turns out dead comes back here without one.
    useEffect(() => {
        if (setupCheckStartedRef.current) {
            return;
        }
        setupCheckStartedRef.current = true;
        if (hasAuthToken()) {
            return;
        }
        AUTH_API.getSetupStatus().then((resp) => {
            const data = resp && resp.data ? resp.data : {};
            if (resp.status && data.setup_complete === false) {
                router.replace(AUTH_ROUTES.SETUP);
                return;
            }
            if (resp.status && data.setup_complete === true) {
                return;
            }
            let msg = 'Could not check whether this installation has been set up. You can still try to sign in.';
            if (resp.http_status === 0) {
                msg = resp.msg;
            }
            setSetupCheckFailedMessage(msg);
        });
    }, [router]);

    /**
     * Submits the credentials and navigates on success.
     *
     * @returns {Promise<void>} Resolves once the response has been handled.
     */
    const handleSubmit = useCallback(async () => {
        if (submitting) {
            return;
        }

        const trimmedEmail = email.trim();
        if (!trimmedEmail || !password) {
            setErrorMessage('Enter your email and password.');
            return;
        }

        setErrorMessage('');
        setSubmitting(true);

        const resp = await AUTH_API.login(trimmedEmail, password);

        if (resp && resp.status) {
            // The token is already stored by the service. Clear the password from component state
            // before navigating so it does not sit in a retained React tree or a devtools snapshot.
            setPassword('');
            // `replace`, not `push`: the back button should not return to a login form the person
            // has already passed through.
            router.replace(resolveDestination(router.query.next));
            // Deliberately NOT clearing `submitting`. The navigation is in flight and the component
            // is about to unmount; re-enabling the button would let a second submit start during it.
            return;
        }

        setSubmitting(false);

        // Whatever the server said, verbatim. See the component header before making this friendlier.
        let msg = 'Could not sign you in. Please try again.';
        if (resp && resp.msg) {
            msg = resp.msg;
        }
        setErrorMessage(msg);
    }, [email, password, submitting, router]);

    let noticeBanner = null;
    const matchedNotice = NOTICE_COPY.find((entry) => router.query[entry.notice.key] === entry.notice.value);
    if (matchedNotice) {
        noticeBanner = (
            <Banner tone="success">
                <p>{matchedNotice.text}</p>
            </Banner>
        );
    }

    let setupCheckBanner = null;
    if (setupCheckFailedMessage) {
        setupCheckBanner = (
            <Banner tone="warning" title="Could not check this installation">
                <p>{setupCheckFailedMessage}</p>
            </Banner>
        );
    }

    let errorBanner = null;
    if (errorMessage) {
        errorBanner = (
            <Banner tone="critical">
                <p>{errorMessage}</p>
            </Banner>
        );
    }

    const footer = (
        <Text as="p" tone="subdued" variant="bodySm">
            There is no sign-up. Accounts are created by invitation: ask an Owner or Admin of this
            dashboard to invite you.
        </Text>
    );

    return (
        <AuthPanel
            title="Shopify App Analytics"
            subtitle={'Sign in to view your app’s performance.'}
            footer={footer}
        >
            {noticeBanner}
            {setupCheckBanner}
            {errorBanner}

            <Form onSubmit={handleSubmit}>
                <FormLayout>
                    <TextField
                        label="Email"
                        type="email"
                        value={email}
                        onChange={setEmail}
                        autoComplete="username"
                        inputMode="email"
                        disabled={submitting}
                    />
                    <TextField
                        label="Password"
                        type="password"
                        value={password}
                        onChange={setPassword}
                        autoComplete="current-password"
                        disabled={submitting}
                    />
                    <Button submit variant="primary" fullWidth loading={submitting}>
                        Sign in
                    </Button>
                    <InlineStack align="center">
                        <Link url={AUTH_ROUTES.FORGOT_PASSWORD}>Forgot your password?</Link>
                    </InlineStack>
                </FormLayout>
            </Form>
        </AuthPanel>
    );
}

export default LoginPage;
