import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Banner, BlockStack, Box, Button, Card, Form, FormLayout, Text, TextField } from '@shopify/polaris';

import AuthApiService from '../API_Services/authService';
import { hasAuthToken } from '../utils/auth';
import { DASHBOARD_HOME } from '../utils/dashboardRoutes';

/**
 * Where a successful sign-in lands when nothing else was requested.
 *
 * The Overview: the selected app's installs, uninstalls and gross revenue, with the install trend
 * under them, and the way on to every other screen below that. It was REVENUE while the Overview
 * was a page of links — a contents page is not a landing screen — and the reason expired when that
 * screen grew figures of its own.
 *
 * ⚠️ THE SAME CONSTANT `pages/index.js` USES, imported rather than repeated. Those two are the only
 * places that choose a landing screen, and a pair of matching literals under a "change both" comment
 * is a rule that survives exactly as long as someone reads it; if they disagree, where an operator
 * ends up depends on whether they arrived already signed in.
 */
const DEFAULT_DESTINATION = DASHBOARD_HOME;

/** One service instance for the module. Constructing one per render would build a new axios client per keystroke. */
const AUTH_API = new AuthApiService();

/**
 * Decides where to send the operator after a successful sign-in.
 *
 *  THIS IS AN OPEN-REDIRECT GUARD, not a formatting helper. `next` arrives in the query string —
 * set by the auth gate in `_app.js`, by the axios 401 interceptor, or by anyone who can get the
 * operator to click a link. Passing it to `router.replace` unchecked means a crafted
 * `/login?next=https://evil.example/login` hands them a convincing copy of this form, on the
 * referrer of a real sign-in, immediately after they typed a password into the genuine one.
 *
 * So only a path on THIS origin is accepted, and the check is written as a whitelist:
 *
 *   - it must start with exactly one '/',  which rejects `https://…` and any other scheme;
 *   - the second character must not be '/' or '\', which rejects the protocol-relative `//evil.example`
 *     (browsers resolve that to another ORIGIN) and the backslash variants some parsers normalise
 *     into it.
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
    if (candidate[0] !== '/') {
        return DEFAULT_DESTINATION;
    }
    if (candidate[1] === '/' || candidate[1] === '\\') {
        return DEFAULT_DESTINATION;
    }
    // Never bounce back to this page: the operator would sign in and land on the form again.
    if (candidate === '/login' || candidate.startsWith('/login?')) {
        return DEFAULT_DESTINATION;
    }
    return candidate;
};

/**
 * The sign-in screen. The only page in the app reachable without a token.
 *
 * ──  IT MUST NOT SAY WHICH HALF WAS WRONG ─────────────────────────────────────────────────────
 * The backend answers one message for an unknown email and for a wrong password, and pays the same
 * bcrypt cost either way so the response TIME does not give the answer away instead. This page
 * renders `resp.msg` verbatim and adds no branch of its own on the failure — no "no account with
 * that email", no per-field error, no different wording for the two cases. Any of those would turn
 * the form into an oracle for "is this person an operator of this deployment", which is the one
 * question a public endpoint should never answer.
 *
 * Field-level validation for EMPTY inputs is fine and is done here: "enter your password" is
 * knowable from the form alone and reveals nothing about which accounts exist.
 *
 * @returns {JSX.Element} The sign-in form.
 */
function LoginPage() {
    const router = useRouter();

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');

    /**
     * Guards the already-signed-in bounce. `useRouter()` returns a new object each render, so the
     * effect below can re-run before the navigation it started has committed — and a second
     * `replace` to the same URL while the first is in flight is how a redirect becomes a loop.
     */
    const bounceStartedRef = useRef(false);

    // A signed-in operator who navigates here (a bookmark, a back button) should carry on rather
    // than be shown a form they do not need. `hasAuthToken` only proves a token EXISTS — an expired
    // one still lands them on a page whose first request 401s, and the axios interceptor sends them
    // straight back here with the token cleared. That round trip is correct: only the API can say
    // whether a token is still good.
    useEffect(() => {
        if (bounceStartedRef.current || !hasAuthToken()) {
            return;
        }
        bounceStartedRef.current = true;
        router.replace(resolveDestination(router.query.next));
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
            // `replace`, not `push`: the back button should not return to a login form the operator
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

    let errorBanner = null;
    if (errorMessage) {
        errorBanner = (
            <Banner tone="critical">
                <p>{errorMessage}</p>
            </Banner>
        );
    }

    return (
        <div className="login-viewport">
            <div className="login-panel">
                <Card>
                    <BlockStack gap="500">
                        <BlockStack gap="100">
                            <Text as="h1" variant="headingLg">Shopify App Analytics</Text>
                            <Text as="p" tone="subdued">Sign in to view your app&rsquo;s performance.</Text>
                        </BlockStack>

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
                            </FormLayout>
                        </Form>

                        <Box paddingBlockStart="200">
                            <Text as="p" tone="subdued" variant="bodySm">
                                This deployment has one operator account, seeded from the backend&rsquo;s
                                environment. There is no sign-up and no password reset: to change the
                                password, remove the account row and restart the backend.
                            </Text>
                        </Box>
                    </BlockStack>
                </Card>
            </div>
        </div>
    );
}

export default LoginPage;
