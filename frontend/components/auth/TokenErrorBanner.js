import { Banner } from '@shopify/polaris';

import { AUTH_ERROR_CODES } from './authResult';
import { AUTH_ROUTES } from '../../utils/publicRoutes';

/**
 * =============================================================================
 *  "This link cannot be used" — said specifically, with the one next step.
 * =============================================================================
 *
 *  The backend distinguishes expired, used, revoked and invalid links (only the
 *  holder of a 256-bit token can ask, so being specific leaks nothing). A generic
 *  "invalid link" for all four would send an invitee whose link merely EXPIRED
 *  hunting for a typo, when the only fix is "ask your admin to resend it".
 *
 *  The next step differs by flow, because who can fix it differs:
 *    · setup  — the would-be owner requests a new link themselves (/setup);
 *    · invite — only an admin can resend, so the copy says so;
 *    · reset  — the person requests a new link themselves (/forgot-password).
 * =============================================================================
 */

export const TOKEN_FLOWS = Object.freeze({
    SETUP: 'setup',
    INVITE: 'invite',
    RESET: 'reset'
});

/** Said on every flow when the page opened without a token — usually a reload after it was stripped. */
const RELOAD_NOTE = 'For safety this page removes the link from the address bar as soon as it opens, so reloading it '
    + 'loses the link. Open the link from the email again.';

/**
 * The copy, per flow and code. A code with no entry for a flow falls back to that flow's
 * TOKEN_INVALID entry — never to nothing.
 */
const COPY = Object.freeze({
    [TOKEN_FLOWS.SETUP]: {
        [AUTH_ERROR_CODES.TOKEN_MISSING]: {
            tone: 'critical',
            title: 'This page needs the link from your verification email',
            body: RELOAD_NOTE
        },
        [AUTH_ERROR_CODES.TOKEN_EXPIRED]: {
            tone: 'warning',
            title: 'This verification link has expired',
            body: 'Verification links work for a limited time. Go back to setup and request a new link.'
        },
        [AUTH_ERROR_CODES.TOKEN_USED]: {
            tone: 'warning',
            title: 'This verification link has already been used',
            body: 'Each link works once. Go back to setup and request a new link to continue.'
        },
        [AUTH_ERROR_CODES.TOKEN_INVALID]: {
            tone: 'critical',
            title: 'This verification link is not valid',
            body: 'Check that you opened the complete link from the email, or go back to setup and request a new link.'
        }
    },
    [TOKEN_FLOWS.INVITE]: {
        [AUTH_ERROR_CODES.TOKEN_MISSING]: {
            tone: 'critical',
            title: 'This page needs the link from your invitation email',
            body: RELOAD_NOTE
        },
        [AUTH_ERROR_CODES.TOKEN_EXPIRED]: {
            tone: 'warning',
            title: 'This invitation has expired',
            body: 'Invitations work for a limited time. Ask your admin to resend the invitation.'
        },
        [AUTH_ERROR_CODES.INVITE_REVOKED]: {
            tone: 'critical',
            title: 'This invitation was withdrawn',
            body: 'It can no longer be used. If you still need access, ask your admin to send a new invitation.'
        },
        [AUTH_ERROR_CODES.TOKEN_USED]: {
            tone: 'warning',
            title: 'This invitation has already been accepted',
            body: 'Sign in with the email address it was sent to and the password you chose. Forgot it? Use '
                + '“Forgot your password?” on the sign-in page.'
        },
        [AUTH_ERROR_CODES.TOKEN_INVALID]: {
            tone: 'critical',
            title: 'This invitation link is not valid',
            body: 'Check that you opened the complete link from the email. If it still does not work, ask your '
                + 'admin to resend the invitation.'
        }
    },
    [TOKEN_FLOWS.RESET]: {
        [AUTH_ERROR_CODES.TOKEN_MISSING]: {
            tone: 'critical',
            title: 'This page needs the link from your password-reset email',
            body: RELOAD_NOTE
        },
        [AUTH_ERROR_CODES.TOKEN_EXPIRED]: {
            tone: 'warning',
            title: 'This reset link has expired',
            body: 'Reset links work for a short time. Request a new link.'
        },
        [AUTH_ERROR_CODES.TOKEN_USED]: {
            tone: 'warning',
            title: 'This reset link has already been used',
            body: 'Each link works once. If you still need to change your password, request a new link.'
        },
        [AUTH_ERROR_CODES.TOKEN_INVALID]: {
            tone: 'critical',
            title: 'This reset link is not valid',
            body: 'Check that you opened the complete link from the email. A reset link also stops working once a '
                + 'newer one is sent or the password is changed — request a new link.'
        }
    }
});

/** The one action each flow offers, pointing at whoever can fix it. */
const ACTIONS = Object.freeze({
    [TOKEN_FLOWS.SETUP]: { content: 'Request a new link', url: AUTH_ROUTES.SETUP },
    [TOKEN_FLOWS.INVITE]: { content: 'Go to sign in', url: AUTH_ROUTES.LOGIN },
    [TOKEN_FLOWS.RESET]: { content: 'Request a new link', url: AUTH_ROUTES.FORGOT_PASSWORD }
});

/**
 * Explains why an emailed link cannot be used, and offers the next step.
 *
 * @param {Object} props - Component props.
 * @param {String} props.flow - One of {@link TOKEN_FLOWS}.
 * @param {String} props.code - One of the token codes in `AUTH_ERROR_CODES`.
 * @returns {JSX.Element} The banner.
 */
function TokenErrorBanner({ flow, code }) {
    const flowCopy = COPY[flow] || COPY[TOKEN_FLOWS.INVITE];
    const copy = flowCopy[code] || flowCopy[AUTH_ERROR_CODES.TOKEN_INVALID];
    const action = ACTIONS[flow] || ACTIONS[TOKEN_FLOWS.INVITE];

    return (
        <Banner tone={copy.tone} title={copy.title} action={action}>
            <p>{copy.body}</p>
        </Banner>
    );
}

export default TokenErrorBanner;
