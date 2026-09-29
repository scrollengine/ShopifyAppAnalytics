import { useCallback, useState } from 'react';
import { Banner, Button, Form, FormLayout, InlineStack, Link, Text, TextField } from '@shopify/polaris';

import AuthApiService from '../API_Services/authService';
import AuthPanel from '../components/auth/AuthPanel';
import { AUTH_ROUTES } from '../utils/publicRoutes';

/**
 * =============================================================================
 *  /forgot-password — ask for a password-reset email.
 * =============================================================================
 *
 *  ──  THE ANSWER IS THE SAME FOR EVERY ADDRESS ──────────────────────────────
 *  The backend answers 202 with one message whether or not an active account has
 *  that email, and does the lookup, throttling and sending after the response —
 *  so neither the wording nor the timing says whether the address is registered.
 *  This page shows `msg` EXACTLY as sent. Do not add "check your inbox" of its
 *  own: for an address with no account that would be a lie, and any difference
 *  between the two cases is the oracle the backend works to avoid.
 *
 *  An invitee who never accepted has no account yet, so no reset email goes to
 *  them; the line under the form points them at the one person who can help.
 * =============================================================================
 */

/** One service instance for the module. Constructing one per render would build a new axios client per keystroke. */
const AUTH_API = new AuthApiService();

/**
 * Password-reset request.
 *
 * @returns {JSX.Element} The email form.
 */
function ForgotPasswordPage() {
    const [email, setEmail] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [result, setResult] = useState(null);

    /**
     * Sends the reset request.
     *
     * @returns {Promise<void>} Resolves once the response has been handled.
     */
    const handleSubmit = useCallback(async () => {
        if (submitting) {
            return;
        }
        const trimmedEmail = email.trim();
        if (!trimmedEmail) {
            setResult({ tone: 'critical', msg: 'Enter your email address.' });
            return;
        }

        setResult(null);
        setSubmitting(true);
        const resp = await AUTH_API.requestPasswordReset(trimmedEmail);
        setSubmitting(false);

        if (resp.status) {
            // Exactly the server's words — see the file header.
            setResult({ tone: 'success', msg: resp.msg });
            return;
        }
        let tone = 'critical';
        if (resp.http_status === 429) {
            tone = 'warning';
        }
        setResult({ tone: tone, msg: resp.msg });
    }, [email, submitting]);

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
            Invited but never set a password? Ask your admin to resend the invitation.
        </Text>
    );

    return (
        <AuthPanel
            title="Reset your password"
            subtitle="Enter the email address you sign in with, and we will send a link to choose a new password."
            footer={footer}
        >
            {resultBanner}

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
                    <Button submit variant="primary" fullWidth loading={submitting}>
                        Send reset link
                    </Button>
                    <InlineStack align="center">
                        <Link url={AUTH_ROUTES.LOGIN}>Back to sign in</Link>
                    </InlineStack>
                </FormLayout>
            </Form>
        </AuthPanel>
    );
}

export default ForgotPasswordPage;
