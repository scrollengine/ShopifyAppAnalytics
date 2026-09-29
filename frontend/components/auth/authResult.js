/**
 * =============================================================================
 *  Reading the auth service's envelope — the codes the public pages branch on.
 * =============================================================================
 *
 *  ⚠️ CROSS-REPO STRING CONTRACT. These are the `error.code` values the backend's
 *  public auth controller answers with. A code renamed there and not here does not
 *  error — it falls through to the generic branch, and a person with an expired
 *  invitation is told "something went wrong" instead of "ask your admin to resend".
 * =============================================================================
 */

export const AUTH_ERROR_CODES = Object.freeze({
    TOKEN_INVALID: 'TOKEN_INVALID',
    TOKEN_EXPIRED: 'TOKEN_EXPIRED',
    TOKEN_USED: 'TOKEN_USED',
    INVITE_REVOKED: 'INVITE_REVOKED',
    SETUP_ALREADY_COMPLETE: 'SETUP_ALREADY_COMPLETE',
    ALREADY_A_MEMBER: 'ALREADY_A_MEMBER',
    // Client-side only: the page opened with no token in its fragment (never sent to the server).
    TOKEN_MISSING: 'TOKEN_MISSING'
});

/**
 * The states a token page moves through. Shared so the three pages spell them one way.
 *
 *   checking       — reading the fragment, or asking the server what the link is for;
 *   ready          — the form is on screen;
 *   token_error    — the link cannot be used (see TokenErrorBanner);
 *   inspect_failed — the server could not be asked (network, 5xx, 429); the page offers a retry;
 *   setup_complete — /setup/verify only: setup was finished, by this link or another;
 *   already_member — /accept-invite only: an account with this email already exists.
 */
export const TOKEN_PAGE_PHASES = Object.freeze({
    CHECKING: 'checking',
    READY: 'ready',
    TOKEN_ERROR: 'token_error',
    INSPECT_FAILED: 'inspect_failed',
    SETUP_COMPLETE: 'setup_complete',
    ALREADY_MEMBER: 'already_member'
});

/** The codes that mean "this link cannot be used" — the form is replaced by an explanation. */
const TOKEN_FAILURE_CODES = Object.freeze([
    AUTH_ERROR_CODES.TOKEN_INVALID,
    AUTH_ERROR_CODES.TOKEN_EXPIRED,
    AUTH_ERROR_CODES.TOKEN_USED,
    AUTH_ERROR_CODES.INVITE_REVOKED
]);

/**
 * The `error.code` of an envelope.
 *
 * @param {Object} resp - An envelope from `authService`.
 * @returns {String} The code, or '' when there is none.
 */
export const errorCodeOf = (resp) => {
    if (resp && resp.error && typeof resp.error.code === 'string') {
        return resp.error.code;
    }
    return '';
};

/**
 * Whether an envelope says the emailed link itself is unusable (as opposed to, say, a password the
 * policy refused — which leaves the link valid and the form on screen).
 *
 * Only a 400 counts: the backend answers every token failure with 400, and a code on any other
 * status is not a statement about the link.
 *
 * @param {Object} resp - An envelope from `authService`.
 * @returns {Boolean} True when the page should show the link-failure explanation.
 */
export const isTokenFailure = (resp) => {
    if (!resp || resp.http_status !== 400) {
        return false;
    }
    return TOKEN_FAILURE_CODES.includes(errorCodeOf(resp));
};

/**
 * An expiry timestamp in the reader's own time zone, for display only.
 *
 * ⚠️ DISPLAY ONLY. Whether a link is still valid is decided by the server when it is used; a
 * browser clock that is wrong by an hour must not disable a working form or enable a dead one.
 *
 * @param {*} iso - The server's `expires_at`.
 * @returns {String} A localised date and time, or '' when the value is not a date.
 */
export const formatLocalExpiry = (iso) => {
    if (typeof iso !== 'string' || !iso) {
        return '';
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
