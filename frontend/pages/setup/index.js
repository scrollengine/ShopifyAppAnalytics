import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Banner, BlockStack, Button, Form, FormLayout, Text, TextField } from '@shopify/polaris';

import AuthApiService from '../../API_Services/authService';
import AuthPanel, { AuthPanelLoading } from '../../components/auth/AuthPanel';
import { AUTH_ERROR_CODES, errorCodeOf } from '../../components/auth/authResult';
import { AUTH_ROUTES } from '../../utils/publicRoutes';

/**
 * =============================================================================
 *  /setup — step 1 of first-run setup: who will own this installation?
 * =============================================================================
 *
 *  Collects an email and a name, and asks the backend to email a verification
 *  link. The password is chosen on step 2 (`/setup/verify`, the link), so a
 *  password is never set for an address nobody has proved they read.
 *
 *  ── THE ANSWER IS THE SAME FOR EVERY ADDRESS ────────────────────────────────
 *  The backend may restrict setup to a pinned address (`SETUP_OWNER_EMAIL`) or to
 *  the operator emails of the previous single-operator build. It answers 202 with
 *  one message whether or not the address typed is permitted, and does everything
 *  address-dependent after the response. This page shows `msg` EXACTLY as sent and
 *  never words a success of its own: "a link is on its way" would be a lie for a
 *  refused address, and any difference would tell a stranger which address owns
 *  the install.
 *
 *  ── ONCE SETUP IS COMPLETE THIS PAGE IS GONE ────────────────────────────────
 *  `GET /api/auth/setup` answering `setup_complete: true` sends the visitor to
 *  /login; the backend refuses every setup request from then on (409), permanently.
 *
 *  ── WHY THE STATUS IS READ AGAIN ~5 s AFTER A REQUEST ───────────────────────
 *  The email is sent AFTER the 202 (deferred on the backend), so a mail-server
 *  failure cannot be in the response. Every setup request also makes the backend
 *  re-check the mail server (connect and login, whatever the address), and
 *  re-reading the status a few seconds later picks up `mail_last_check: 'failed'`
 *  from that check and shows the CLI fallback, instead of leaving the person
 *  waiting for an email that is not coming. It is deliberately NOT the outcome of
 *  the send: only a permitted address gets one, so a status that moved with it
 *  would tell a stranger which address owns the install.
 * =============================================================================
 */

/** One service instance for the module. Constructing one per render would build a new axios client per keystroke. */
const AUTH_API = new AuthApiService();

/** How long after a setup request the status is read again. See the file header. */
const STATUS_RECHECK_DELAY_MS = 5000;

/**
 * The recovery command for "the email is not arriving". Literal ellipses on purpose: this page must
 * not echo the typed address into a copy-and-paste command, and the person knows what to put there.
 */
const SETUP_LINK_COMMAND = 'npm run auth:admin:dist -- setup-link --email … --name …';

const STATUS_PHASES = Object.freeze({
    LOADING: 'loading',
    READY: 'ready',
    FAILED: 'failed'
});

/**
 * The origin of a URL, or '' when it will not parse.
 *
 * `new URL(...).origin` normalises case and drops a default port, so `https://Example.com:443` and
 * `https://example.com` compare equal — a raw string comparison would warn about a difference that
 * does not exist.
 *
 * @param {*} url - The configured public URL.
 * @returns {String} Its origin, or ''.
 */
const _originOf = (url) => {
    if (typeof url !== 'string' || !url) {
        return '';
    }
    try {
        return new URL(url).origin;
    } catch (e) {
        return '';
    }
};

/**
 * First-run setup, step 1.
 *
 * @returns {JSX.Element} The setup request form.
 */
function SetupPage() {
    const router = useRouter();

    const [statusPhase, setStatusPhase] = useState(STATUS_PHASES.LOADING);
    const [status, setStatus] = useState(null);
    const [statusError, setStatusError] = useState('');
    const [browserOrigin, setBrowserOrigin] = useState('');

    const [email, setEmail] = useState('');
    const [name, setName] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [result, setResult] = useState(null);
    const [alreadyComplete, setAlreadyComplete] = useState(false);

    /** One status read on mount, however many times reactStrictMode runs the effect. */
    const statusStartedRef = useRef(false);
    /** One navigation to /login, however many status reads answer "complete". */
    const redirectStartedRef = useRef(false);
    /** The pending re-read after a request; cleared on unmount and before scheduling another. */
    const recheckTimerRef = useRef(null);

    /**
     * Leaves for /login, once.
     *
     * @returns {void}
     */
    const leaveForLogin = useCallback(() => {
        if (redirectStartedRef.current) {
            return;
        }
        redirectStartedRef.current = true;
        router.replace(AUTH_ROUTES.LOGIN);
    }, [router]);

    /**
     * Reads the setup status and applies it.
     *
     * @param {Boolean} quiet - True for the background re-read: a failure then keeps what is on screen
     * rather than replacing a working form with an error.
     * @returns {Promise<void>} Resolves once applied.
     */
    const loadStatus = useCallback((quiet) => {
        return AUTH_API.getSetupStatus().then((resp) => {
            const data = resp && resp.data ? resp.data : {};
            if (resp.status && data.setup_complete === true) {
                leaveForLogin();
                return;
            }
            if (resp.status && data.setup_complete === false) {
                setStatus(data);
                setStatusError('');
                setStatusPhase(STATUS_PHASES.READY);
                return;
            }
            if (quiet) {
                return;
            }
            setStatusError(resp.msg);
            setStatusPhase(STATUS_PHASES.FAILED);
        });
    }, [leaveForLogin]);

    useEffect(() => {
        if (statusStartedRef.current) {
            return;
        }
        statusStartedRef.current = true;
        setBrowserOrigin(window.location.origin);
        loadStatus(false);
    }, [loadStatus]);

    // A re-read scheduled by a request must not fire after the page is gone.
    useEffect(() => {
        return () => {
            if (recheckTimerRef.current) {
                clearTimeout(recheckTimerRef.current);
                recheckTimerRef.current = null;
            }
        };
    }, []);

    /**
     * Retries a failed status read.
     *
     * @returns {void}
     */
    const handleRetryStatus = useCallback(() => {
        setStatusPhase(STATUS_PHASES.LOADING);
        loadStatus(false);
    }, [loadStatus]);

    /**
     * Sends the setup request.
     *
     * @returns {Promise<void>} Resolves once the response has been handled.
     */
    const handleSubmit = useCallback(async () => {
        if (submitting) {
            return;
        }
        const trimmedEmail = email.trim();
        const trimmedName = name.trim();
        if (!trimmedEmail || !trimmedName) {
            setResult({ tone: 'critical', msg: 'Enter your email address and your name.' });
            return;
        }

        setResult(null);
        setSubmitting(true);
        const resp = await AUTH_API.requestSetup(trimmedEmail, trimmedName);
        setSubmitting(false);

        if (resp.status) {
            // Exactly the server's words — see the file header.
            setResult({ tone: 'success', msg: resp.msg });
            if (recheckTimerRef.current) {
                clearTimeout(recheckTimerRef.current);
            }
            recheckTimerRef.current = setTimeout(() => {
                recheckTimerRef.current = null;
                loadStatus(true);
            }, STATUS_RECHECK_DELAY_MS);
            return;
        }
        if (resp.http_status === 409 && errorCodeOf(resp) === AUTH_ERROR_CODES.SETUP_ALREADY_COMPLETE) {
            setAlreadyComplete(true);
            return;
        }
        let tone = 'critical';
        if (resp.http_status === 429) {
            tone = 'warning';
        }
        setResult({ tone: tone, msg: resp.msg });
    }, [email, name, submitting, loadStatus]);

    if (alreadyComplete) {
        return (
            <AuthPanel title="Set up Shopify App Analytics">
                <Banner
                    tone="info"
                    title="Setup is already complete"
                    action={{ content: 'Sign in', url: AUTH_ROUTES.LOGIN }}
                >
                    <p>This installation already has an owner. Sign in, or ask the owner to invite you.</p>
                </Banner>
            </AuthPanel>
        );
    }

    if (statusPhase === STATUS_PHASES.LOADING) {
        return (
            <AuthPanel title="Set up Shopify App Analytics">
                <AuthPanelLoading label={'Checking this installation…'} />
            </AuthPanel>
        );
    }

    let statusErrorBanner = null;
    if (statusPhase === STATUS_PHASES.FAILED) {
        statusErrorBanner = (
            <Banner
                tone="warning"
                title="Could not check this installation"
                action={{ content: 'Try again', onAction: handleRetryStatus }}
            >
                <p>{statusError}</p>
            </Banner>
        );
    }

    // The link in the email is built from the backend's APP_PUBLIC_URL, never from the address this
    // page was opened on. If the two differ, the person should find out before waiting for an email
    // whose link opens somewhere they cannot reach.
    let originBanner = null;
    if (status && typeof status.public_url === 'string' && status.public_url && browserOrigin
        && _originOf(status.public_url) !== browserOrigin) {
        originBanner = (
            <Banner tone="warning" title="The link will open a different address">
                <p>
                    The verification link will open {status.public_url}; you are on {browserOrigin}. If that
                    is not how you reach this dashboard, set APP_PUBLIC_URL in the backend&rsquo;s environment
                    to the address you use and restart the backend before requesting a link.
                </p>
            </Banner>
        );
    }

    let mailBanner = null;
    if (status && (status.mail_last_check === 'failed' || status.mail_configured === false)) {
        let mailProblem = 'The backend could not reach its mail server on its last attempt.';
        if (status.mail_configured === false) {
            mailProblem = 'The backend has no mail server configured.';
        }
        mailBanner = (
            <Banner tone="critical" title="The verification email may not arrive">
                <BlockStack gap="200">
                    <p>
                        {mailProblem} Check the SMTP settings in the backend&rsquo;s environment, or print a
                        setup link on the server instead:
                    </p>
                    <code className="auth-code">{SETUP_LINK_COMMAND}</code>
                    <p>
                        Run it in the backend directory (with Docker Compose: prefix it with
                        {' '}<code>docker compose exec backend</code>). It applies the same address rules as this
                        form and prints a link to open in this browser.
                    </p>
                </BlockStack>
            </Banner>
        );
    }

    let restrictedBanner = null;
    if (status && status.setup_restricted === true) {
        restrictedBanner = (
            <Banner tone="info">
                <p>
                    Setup on this installation is limited to a pre-approved email address. Any other address
                    gets the same reply, but no email is sent.
                </p>
            </Banner>
        );
    }

    let resultBanner = null;
    if (result) {
        resultBanner = (
            <Banner tone={result.tone}>
                <p>{result.msg}</p>
            </Banner>
        );
    }

    const footer = (
        <Text as="p" tone="subdued" variant="bodySm">
            Setup runs once. When it is complete this page closes for good, and everyone else joins by
            invitation from the owner.
        </Text>
    );

    return (
        <AuthPanel
            title="Set up Shopify App Analytics"
            subtitle="Create the owner account for this installation."
            footer={footer}
        >
            {statusErrorBanner}
            {originBanner}
            {mailBanner}
            {restrictedBanner}
            {resultBanner}

            <Form onSubmit={handleSubmit}>
                <FormLayout>
                    <TextField
                        label="Email"
                        type="email"
                        value={email}
                        onChange={setEmail}
                        autoComplete="email"
                        inputMode="email"
                        helpText="We will email a link to this address. You choose your password after opening it."
                        disabled={submitting}
                    />
                    <TextField
                        label="Your name"
                        value={name}
                        onChange={setName}
                        autoComplete="name"
                        disabled={submitting}
                    />
                    <Button submit variant="primary" fullWidth loading={submitting}>
                        Send verification link
                    </Button>
                </FormLayout>
            </Form>
        </AuthPanel>
    );
}

export default SetupPage;
