import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Banner, Button, Form, FormLayout, Text, TextField } from '@shopify/polaris';

import AuthApiService from '../../API_Services/authService';
import AuthPanel, { AuthPanelLoading } from '../../components/auth/AuthPanel';
import PasswordFields, { passwordPairError } from '../../components/auth/PasswordFields';
import SignedInBanner from '../../components/auth/SignedInBanner';
import TokenErrorBanner, { TOKEN_FLOWS } from '../../components/auth/TokenErrorBanner';
import {
    AUTH_ERROR_CODES,
    TOKEN_PAGE_PHASES,
    errorCodeOf,
    formatLocalExpiry,
    isTokenFailure
} from '../../components/auth/authResult';
import { FRAGMENT_TOKEN_STATES, useFragmentToken } from '../../components/auth/useFragmentToken';
import { clearAuthToken } from '../../utils/auth';
import { AUTH_ROUTES, LOGIN_NOTICES, loginWithNotice } from '../../utils/publicRoutes';

/**
 * =============================================================================
 *  /setup/verify#token=… — step 2 of first-run setup: choose the password.
 * =============================================================================
 *
 *  Opened from the verification email. The token is read from the fragment and
 *  stripped from the URL (`useFragmentToken`), then `POST /api/auth/setup/inspect`
 *  says which address it verifies — that consumes nothing, so a mail scanner that
 *  opens the link changes nothing. Only the "Finish setup" button spends the token.
 *
 *  Success creates the owner account and locks setup for good. It does NOT sign
 *  in: the person is sent to /login with a banner and signs in like anyone else,
 *  so the password they just chose is exercised once while they still remember it.
 * =============================================================================
 */

/** One service instance for the module. Constructing one per render would build a new axios client per keystroke. */
const AUTH_API = new AuthApiService();

/**
 * First-run setup, step 2.
 *
 * @returns {JSX.Element} The password form, or the reason the link cannot be used.
 */
function SetupVerifyPage() {
    const router = useRouter();
    const fragment = useFragmentToken();

    const [phase, setPhase] = useState(TOKEN_PAGE_PHASES.CHECKING);
    const [tokenErrorCode, setTokenErrorCode] = useState('');
    const [inspectError, setInspectError] = useState('');
    const [details, setDetails] = useState(null);

    const [name, setName] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [submitAttempted, setSubmitAttempted] = useState(false);
    const [formError, setFormError] = useState('');

    /** One inspect per mount, however many times reactStrictMode runs the effect. */
    const inspectStartedRef = useRef(false);

    /**
     * Asks the server what the link is for. Consumes nothing.
     *
     * @param {String} token - The token from the fragment.
     * @returns {void}
     */
    const runInspect = useCallback((token) => {
        setPhase(TOKEN_PAGE_PHASES.CHECKING);
        setInspectError('');
        AUTH_API.inspectSetupToken(token).then((resp) => {
            if (resp.status) {
                setDetails(resp.data);
                // The name typed on step 1, offered back; it can still be changed here.
                if (typeof resp.data.name === 'string') {
                    setName(resp.data.name);
                }
                setPhase(TOKEN_PAGE_PHASES.READY);
                return;
            }
            if (resp.http_status === 409) {
                setPhase(TOKEN_PAGE_PHASES.SETUP_COMPLETE);
                return;
            }
            if (isTokenFailure(resp)) {
                setTokenErrorCode(errorCodeOf(resp));
                setPhase(TOKEN_PAGE_PHASES.TOKEN_ERROR);
                return;
            }
            setInspectError(resp.msg);
            setPhase(TOKEN_PAGE_PHASES.INSPECT_FAILED);
        });
    }, []);

    useEffect(() => {
        if (fragment.state === FRAGMENT_TOKEN_STATES.READING || inspectStartedRef.current) {
            return;
        }
        inspectStartedRef.current = true;
        if (fragment.state === FRAGMENT_TOKEN_STATES.PRESENT) {
            runInspect(fragment.token);
            return;
        }
        let code = AUTH_ERROR_CODES.TOKEN_INVALID;
        if (fragment.state === FRAGMENT_TOKEN_STATES.MISSING) {
            code = AUTH_ERROR_CODES.TOKEN_MISSING;
        }
        setTokenErrorCode(code);
        setPhase(TOKEN_PAGE_PHASES.TOKEN_ERROR);
    }, [fragment, runInspect]);

    /**
     * Retries an inspect that could not reach the server.
     *
     * @returns {void}
     */
    const handleRetryInspect = useCallback(() => {
        runInspect(fragment.token);
    }, [runInspect, fragment.token]);

    /**
     * Finishes setup with the chosen name and password.
     *
     * @returns {Promise<void>} Resolves once the response has been handled.
     */
    const handleSubmit = useCallback(async () => {
        if (submitting) {
            return;
        }
        setSubmitAttempted(true);

        const trimmedName = name.trim();
        if (!trimmedName) {
            setFormError('Enter your name.');
            return;
        }
        const pairError = passwordPairError(password, confirm);
        if (pairError) {
            setFormError(pairError);
            return;
        }

        setFormError('');
        setSubmitting(true);
        const resp = await AUTH_API.completeSetup(fragment.token, trimmedName, password);

        if (resp.status) {
            setPassword('');
            setConfirm('');
            // Whatever session this browser held belongs to nobody who exists after setup (or to someone
            // else); drop it so /login shows the form instead of bouncing into a dead session.
            clearAuthToken();
            router.replace(loginWithNotice(LOGIN_NOTICES.SETUP_DONE));
            // Deliberately NOT clearing `submitting`: the navigation is in flight.
            return;
        }

        setSubmitting(false);
        if (resp.http_status === 409) {
            setPassword('');
            setConfirm('');
            setPhase(TOKEN_PAGE_PHASES.SETUP_COMPLETE);
            return;
        }
        if (isTokenFailure(resp)) {
            setPassword('');
            setConfirm('');
            setTokenErrorCode(errorCodeOf(resp));
            setPhase(TOKEN_PAGE_PHASES.TOKEN_ERROR);
            return;
        }
        // A password the policy refused, a rate limit, a datastore outage: the link is still good and
        // the form stays. The server's reason is the specific one — show it as sent.
        setFormError(resp.msg);
    }, [submitting, name, password, confirm, fragment.token, router]);

    const title = 'Finish setting up';

    if (phase === TOKEN_PAGE_PHASES.CHECKING) {
        return (
            <AuthPanel title={title}>
                <AuthPanelLoading label={'Checking your link…'} />
            </AuthPanel>
        );
    }

    if (phase === TOKEN_PAGE_PHASES.TOKEN_ERROR) {
        return (
            <AuthPanel title={title}>
                <TokenErrorBanner flow={TOKEN_FLOWS.SETUP} code={tokenErrorCode} />
            </AuthPanel>
        );
    }

    if (phase === TOKEN_PAGE_PHASES.SETUP_COMPLETE) {
        return (
            <AuthPanel title={title}>
                <Banner
                    tone="info"
                    title="Setup is already complete"
                    action={{ content: 'Sign in', url: AUTH_ROUTES.LOGIN }}
                >
                    <p>This installation already has an owner. If that is you, sign in with the password you chose.</p>
                </Banner>
            </AuthPanel>
        );
    }

    if (phase === TOKEN_PAGE_PHASES.INSPECT_FAILED) {
        return (
            <AuthPanel title={title}>
                <Banner
                    tone="warning"
                    title="Could not check your link"
                    action={{ content: 'Try again', onAction: handleRetryInspect }}
                >
                    <p>{inspectError}</p>
                </Banner>
            </AuthPanel>
        );
    }

    let formErrorBanner = null;
    if (formError) {
        formErrorBanner = (
            <Banner tone="critical">
                <p>{formError}</p>
            </Banner>
        );
    }

    let expiryMarkup = null;
    const expiry = details ? formatLocalExpiry(details.expires_at) : '';
    if (expiry) {
        expiryMarkup = <Text as="p" tone="subdued" variant="bodySm">This link works until {expiry}.</Text>;
    }

    let email = '';
    if (details && typeof details.email === 'string') {
        email = details.email;
    }

    return (
        <AuthPanel title={title} subtitle="Choose the password for the owner account.">
            <SignedInBanner>
                Finishing setup clears this browser&rsquo;s session so you can sign in as the owner.
            </SignedInBanner>
            {formErrorBanner}

            <Form onSubmit={handleSubmit}>
                <FormLayout>
                    <TextField
                        label="Email"
                        type="email"
                        value={email}
                        readOnly
                        autoComplete="username"
                        helpText="The owner account signs in with this address."
                    />
                    <TextField
                        label="Your name"
                        value={name}
                        onChange={setName}
                        autoComplete="name"
                        disabled={submitting}
                    />
                    <PasswordFields
                        password={password}
                        confirm={confirm}
                        onPasswordChange={setPassword}
                        onConfirmChange={setConfirm}
                        disabled={submitting}
                        showMismatch={submitAttempted}
                    />
                    <Button submit variant="primary" fullWidth loading={submitting}>
                        Finish setup
                    </Button>
                    {expiryMarkup}
                </FormLayout>
            </Form>
        </AuthPanel>
    );
}

export default SetupVerifyPage;
