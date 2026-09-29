import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Banner, Button, Form, FormLayout } from '@shopify/polaris';

import AuthApiService from '../API_Services/authService';
import AuthPanel, { AuthPanelLoading } from '../components/auth/AuthPanel';
import PasswordFields, { passwordPairError } from '../components/auth/PasswordFields';
import SignedInBanner from '../components/auth/SignedInBanner';
import TokenErrorBanner, { TOKEN_FLOWS } from '../components/auth/TokenErrorBanner';
import { AUTH_ERROR_CODES, TOKEN_PAGE_PHASES, errorCodeOf, isTokenFailure } from '../components/auth/authResult';
import { FRAGMENT_TOKEN_STATES, useFragmentToken } from '../components/auth/useFragmentToken';
import { clearAuthToken } from '../utils/auth';
import { LOGIN_NOTICES, loginWithNotice } from '../utils/publicRoutes';

/**
 * =============================================================================
 *  /reset-password#token=… — choose a new password from a reset email.
 * =============================================================================
 *
 *  The token is read from the fragment and stripped from the URL
 *  (`useFragmentToken`). There is NO inspect endpoint for reset links, so the
 *  form appears as soon as a well-formed token is found, and whether the link is
 *  still good is learned only when "Save new password" is pressed — an expired
 *  link is reported then, with its own copy.
 *
 *  Success signs every session of that account out (server-side) and does NOT
 *  sign in: the person goes to /login with a banner.
 * =============================================================================
 */

/** One service instance for the module. Constructing one per render would build a new axios client per keystroke. */
const AUTH_API = new AuthApiService();

/**
 * Password reset from an emailed link.
 *
 * @returns {JSX.Element} The new-password form, or the reason the link cannot be used.
 */
function ResetPasswordPage() {
    const router = useRouter();
    const fragment = useFragmentToken();

    const [phase, setPhase] = useState(TOKEN_PAGE_PHASES.CHECKING);
    const [tokenErrorCode, setTokenErrorCode] = useState('');

    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [submitAttempted, setSubmitAttempted] = useState(false);
    const [formError, setFormError] = useState('');

    /** One decision per mount, however many times reactStrictMode runs the effect. */
    const decidedRef = useRef(false);

    useEffect(() => {
        if (fragment.state === FRAGMENT_TOKEN_STATES.READING || decidedRef.current) {
            return;
        }
        decidedRef.current = true;
        if (fragment.state === FRAGMENT_TOKEN_STATES.PRESENT) {
            setPhase(TOKEN_PAGE_PHASES.READY);
            return;
        }
        let code = AUTH_ERROR_CODES.TOKEN_INVALID;
        if (fragment.state === FRAGMENT_TOKEN_STATES.MISSING) {
            code = AUTH_ERROR_CODES.TOKEN_MISSING;
        }
        setTokenErrorCode(code);
        setPhase(TOKEN_PAGE_PHASES.TOKEN_ERROR);
    }, [fragment]);

    /**
     * Saves the new password.
     *
     * @returns {Promise<void>} Resolves once the response has been handled.
     */
    const handleSubmit = useCallback(async () => {
        if (submitting) {
            return;
        }
        setSubmitAttempted(true);

        const pairError = passwordPairError(password, confirm);
        if (pairError) {
            setFormError(pairError);
            return;
        }

        setFormError('');
        setSubmitting(true);
        const resp = await AUTH_API.resetPassword(fragment.token, password);

        if (resp.status) {
            setPassword('');
            setConfirm('');
            // The server has just revoked every session of this account; the token this browser holds
            // (this account's or anyone's) must not send /login bouncing into a dead session.
            clearAuthToken();
            router.replace(loginWithNotice(LOGIN_NOTICES.RESET_DONE));
            // Deliberately NOT clearing `submitting`: the navigation is in flight.
            return;
        }

        setSubmitting(false);
        if (isTokenFailure(resp)) {
            setPassword('');
            setConfirm('');
            setTokenErrorCode(errorCodeOf(resp));
            setPhase(TOKEN_PAGE_PHASES.TOKEN_ERROR);
            return;
        }
        // A password the policy refused, a rate limit, an outage: the link is still good and the form
        // stays. The server's reason is the specific one — show it as sent.
        setFormError(resp.msg);
    }, [submitting, password, confirm, fragment.token, router]);

    const title = 'Choose a new password';

    if (phase === TOKEN_PAGE_PHASES.CHECKING) {
        return (
            <AuthPanel title={title}>
                <AuthPanelLoading label={'Reading your link…'} />
            </AuthPanel>
        );
    }

    if (phase === TOKEN_PAGE_PHASES.TOKEN_ERROR) {
        return (
            <AuthPanel title={title}>
                <TokenErrorBanner flow={TOKEN_FLOWS.RESET} code={tokenErrorCode} />
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

    return (
        <AuthPanel
            title={title}
            subtitle="Saving a new password signs out every session of the account, on every device."
        >
            <SignedInBanner>
                Saving clears this browser&rsquo;s session too, so you can sign in with the new password.
            </SignedInBanner>
            {formErrorBanner}

            <Form onSubmit={handleSubmit}>
                <FormLayout>
                    <PasswordFields
                        password={password}
                        confirm={confirm}
                        onPasswordChange={setPassword}
                        onConfirmChange={setConfirm}
                        disabled={submitting}
                        showMismatch={submitAttempted}
                    />
                    <Button submit variant="primary" fullWidth loading={submitting}>
                        Save new password
                    </Button>
                </FormLayout>
            </Form>
        </AuthPanel>
    );
}

export default ResetPasswordPage;
