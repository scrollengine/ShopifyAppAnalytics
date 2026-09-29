import { Banner, BlockStack, Text } from '@shopify/polaris';

import { formatDateTime } from './adminPresentation';

/** The recovery command that bypasses email. Printed, never run from here. */
const RESET_LINK_COMMAND = 'npm run auth:admin:dist -- reset-link --email <address>';

/**
 * The outgoing-mail health banner shown on the Members and Invitations tabs.
 *
 * Driven by `mail` from GET /api/users or GET /api/invites (`getMailStatus()`: `{ configured,
 * last_check, last_ok_at, consecutive_failures }`). Renders nothing while mail is healthy or has not
 * been checked yet: "not checked" is not evidence of a fault.
 *
 * ⚠️ `last_ok_at` IS IN-PROCESS STATE on the backend and resets on restart, so a null value means
 * "no successful send since the backend last started", never "never worked". The copy says exactly
 * that.
 *
 * @param {Object} props - Component props.
 * @param {Object|null} props.mail - The mail status block, or null when the response had none.
 * @returns {JSX.Element|null}
 */
const MailStatusBanner = ({ mail }) => {
    if (!mail || typeof mail !== 'object') {
        return null;
    }

    if (mail.configured === false) {
        return (
            <Banner tone="critical" title="Outgoing email is not configured">
                <p>
                    Invitations and password-reset emails cannot be sent until SMTP is configured on the
                    backend. People who are already signed in are not affected.
                </p>
            </Banner>
        );
    }

    if (mail.last_check !== 'failed') {
        return null;
    }

    const failures = typeof mail.consecutive_failures === 'number' ? mail.consecutive_failures : null;
    let failureLine = 'The most recent attempt to reach the mail server failed';
    if (failures !== null && failures > 0) {
        failureLine = `The last ${failures} attempt${failures === 1 ? '' : 's'} to send email failed`;
    }
    let sinceLine = 'no email has been accepted since the backend last started.';
    if (mail.last_ok_at) {
        sinceLine = `the last email the mail server accepted was at ${formatDateTime(mail.last_ok_at)}.`;
    }

    return (
        <Banner tone="critical" title="Outgoing email is failing">
            <BlockStack gap="200">
                <Text as="p">{`${failureLine}; ${sinceLine}`}</Text>
                <Text as="p">
                    Invitations and password-reset emails are not being delivered. People who are already
                    signed in are not affected.
                </Text>
                <Text as="p">
                    To let someone reset their password meanwhile, run this on the server; it prints a
                    reset link without sending email:
                </Text>
                <Text as="p" fontWeight="medium">
                    <code>{RESET_LINK_COMMAND}</code>
                </Text>
            </BlockStack>
        </Banner>
    );
};

export default MailStatusBanner;
