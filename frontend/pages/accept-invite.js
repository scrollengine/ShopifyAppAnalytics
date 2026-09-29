import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Banner, Button, Form, FormLayout, Text, TextField } from '@shopify/polaris';

import AuthApiService from '../API_Services/authService';
import AuthPanel, { AuthPanelLoading } from '../components/auth/AuthPanel';
import PasswordFields, { passwordPairError } from '../components/auth/PasswordFields';
import SignedInBanner from '../components/auth/SignedInBanner';
import TokenErrorBanner, { TOKEN_FLOWS } from '../components/auth/TokenErrorBanner';
import {
    AUTH_ERROR_CODES,
    TOKEN_PAGE_PHASES,
    errorCodeOf,
    formatLocalExpiry,
    isTokenFailure
} from '../components/auth/authResult';
import { FRAGMENT_TOKEN_STATES, useFragmentToken } from '../components/auth/useFragmentToken';
import { clearAuthToken } from '../utils/auth';
import { AUTH_ROUTES, LOGIN_NOTICES, loginWithNotice } from '../utils/publicRoutes';

/**
 * =============================================================================
 *  /accept-invite#token=… — join by invitation: choose a name and a password.
 * =============================================================================
 *
 *  The only way anyone but the owner gets an account; there is no sign-up.
 *
 *  The token is read from the fragment and stripped from the URL
 *  (`useFragmentToken`); `POST /api/auth/invites/inspect` says who sent it and
 *  with which role, consuming nothing. Only the "Create account" button spends
 *  the token. Success does NOT sign in — the person goes to /login with a banner.
 *
 *  Expired, withdrawn, already-used and invalid invitations each get their own
 *  copy (`TokenErrorBanner`), because only one of them is fixed by the invitee:
 *  the rest need an admin to resend, and saying so is the whole help.
 * =============================================================================
 */

/** One service instance for the module. Constructing one per render would build a new axios client per keystroke. */
const AUTH_API = new AuthApiService();

/**
 * "Alex invited you to join as Analyst." — worded around whatever the server could say.
 *
 * @param {Object|null} details - The inspect result.
 * @returns {String} One sentence.
 */
const _inviteSentence = (details) => {
    let role = '';
    if (details && typeof details.role_label === 'string' && details.role_label) {
        role = details.role_label;
    }
    let inviter = '';
    if (details && typeof details.invited_by_name === 'string' && details.invited_by_name) {
        inviter = details.invited_by_name;
    }
    if (inviter && role) {
        return `${inviter} invited you to join as ${role}.`;
    }
    if (role) {
        return `You have been invited to join as ${role}.`;
    }
    return 'You have been invited to join.';
};

/**
 * Accepting an invitation.
 *
 * @returns {JSX.Element} The account form, or the reason the invitation cannot be used.
 */
function AcceptInvitePage() {
    const router = useRouter();
    const fragment = useFragmentToken();

    const [phase, setPhase] = useState(TOKEN_PAGE_PHASES.CHECKING);
    const [tokenErrorCode, setTokenErrorCode] = useState('');
    const [inspectError, setInspectError] = useState('');
    const [alreadyMemberMessage, setAlreadyMemberMessage] = useState('');
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
     * Asks the server what the invitation is for. Consumes nothing.
     *
     * @param {String} token - The token from the fragment.
     * @returns {void}
     */
    const runInspect = useCallback((token) => {
        setPhase(TOKEN_PAGE_PHASES.CHECKING);
        setInspectError('');
        AUTH_API.inspectInvite(token).then((resp) => {
            if (resp.status) {
                setDetails(resp.data);
                setPhase(TOKEN_PAGE_PHASES.READY);
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
     * Creates the account.
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
        const resp = await AUTH_API.acceptInvite(fragment.token, trimmedName, password);

        if (resp.status) {
            setPassword('');
            setConfirm('');
            // The session this browser holds (an admin checking the link, say) is not the new account's;
            // drop it so /login shows the form instead of bouncing into someone else's dashboard.
            clearAuthToken();
            router.replace(loginWithNotice(LOGIN_NOTICES.INVITED));
            // Deliberately NOT clearing `submitting`: the navigation is in flight.
            return;
        }

        setSubmitting(false);
        if (resp.http_status === 409 && errorCodeOf(resp) === AUTH_ERROR_CODES.ALREADY_A_MEMBER) {
            setPassword('');
            setConfirm('');
            setAlreadyMemberMessage(resp.msg);
            setPhase(TOKEN_PAGE_PHASES.ALREADY_MEMBER);
            return;
        }
        if (isTokenFailure(resp)) {
            setPassword('');
            setConfirm('');
            setTokenErrorCode(errorCodeOf(resp));
            setPhase(TOKEN_PAGE_PHASES.TOKEN_ERROR);
            return;
        }
        // A password the policy refused, a rate limit, a datastore outage: the invitation is still good
        // and the form stays. The server's reason is the specific one — show it as sent.
        setFormError(resp.msg);
    }, [submitting, name, password, confirm, fragment.token, router]);

    const title = 'Join Shopify App Analytics';

    if (phase === TOKEN_PAGE_PHASES.CHECKING) {
        return (
            <AuthPanel title={title}>
                <AuthPanelLoading label={'Checking your invitation…'} />
            </AuthPanel>
        );
    }

    if (phase === TOKEN_PAGE_PHASES.TOKEN_ERROR) {
        return (
            <AuthPanel title={title}>
                <TokenErrorBanner flow={TOKEN_FLOWS.INVITE} code={tokenErrorCode} />
            </AuthPanel>
        );
    }

    if (phase === TOKEN_PAGE_PHASES.ALREADY_MEMBER) {
        return (
            <AuthPanel title={title}>
                <Banner
                    tone="warning"
                    title="You already have an account"
                    action={{ content: 'Sign in', url: AUTH_ROUTES.LOGIN }}
                    secondaryAction={{ content: 'Forgot your password?', url: AUTH_ROUTES.FORGOT_PASSWORD }}
                >
                    <p>{alreadyMemberMessage}</p>
                </Banner>
            </AuthPanel>
        );
    }

    if (phase === TOKEN_PAGE_PHASES.INSPECT_FAILED) {
        return (
            <AuthPanel title={title}>
                <Banner
                    tone="warning"
                    title="Could not check your invitation"
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
        expiryMarkup = <Text as="p" tone="subdued" variant="bodySm">This invitation works until {expiry}.</Text>;
    }

    let email = '';
    if (details && typeof details.email === 'string') {
        email = details.email;
    }

    return (
        <AuthPanel title={title} subtitle={_inviteSentence(details)}>
            <SignedInBanner>
                Creating this account clears this browser&rsquo;s session so you can sign in as the new account.
                The account you are signed in with now is not changed.
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
                        helpText="The invitation was sent to this address; you will sign in with it."
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
                        label="Password"
                        confirmLabel="Confirm password"
                    />
                    <Button submit variant="primary" fullWidth loading={submitting}>
                        Create account
                    </Button>
                    {expiryMarkup}
                </FormLayout>
            </Form>
        </AuthPanel>
    );
}

export default AcceptInvitePage;
