import AxiosClientProvider from './apiClient';

/**
 * =============================================================================
 *  The signed-in user's own account — the `@self` routes.
 * =============================================================================
 *
 *      GET   /api/account                         → { user, role, permissions, session }
 *      PATCH /api/account                         { name }
 *      POST  /api/account/password                { current_password, new_password }
 *      POST  /api/account/sessions/revoke-others
 *      POST  /api/account/logout
 *
 *  Every signed-in user may call these whatever their role; none of them can
 *  answer 403. They are the only API the session context reads.
 *
 *  ── PROMISES, AND THEY NEVER REJECT ─────────────────────────────────────────
 *  Same contract as `authService.js`: every path resolves the API's own
 *  `{ status, msg, data, error }` envelope, including refusals, so a caller
 *  renders `msg` without a try/catch. A 4xx/5xx that carries an envelope is
 *  passed through INTACT — `error.code` is how the account page tells
 *  `CURRENT_PASSWORD_INCORRECT` from a password-policy refusal, and flattening
 *  it would leave the page one generic sentence for both.
 *
 *  ── A 401 IS THE SESSION ENDING, NOT A FAILURE TO REPORT ────────────────────
 *  The axios interceptor has already cleared the token and started the redirect
 *  to /login by the time a 401 lands here. It resolves with
 *  `resource_access: 'NOT_ALLOWED'` (the marker every growth-intel service uses)
 *  so a caller can draw nothing rather than an error banner over a navigation
 *  already under way. A wrong CURRENT password is a 400 from this backend,
 *  precisely so that it can never land here and sign the user out.
 *
 *  ── TWO RESPONSES CARRY A NEW TOKEN ─────────────────────────────────────────
 *  Changing the password and "sign out my other sessions" both end every OTHER
 *  session by bumping the account's session epoch — which ends THIS token too.
 *  The server answers with a fresh `{ token, expires_at, expires_in_seconds }`
 *  for this browser, and the caller must store it at once through the session
 *  context's `applyFreshToken`, before any other request is made. This service
 *  does not store it itself: one writer of the token outside sign-in.
 * =============================================================================
 */

/** Shown when the request never reached the API. */
const NETWORK_FAILURE_MESSAGE = 'Could not reach the server. Check your connection and try again.';

/** Shown when the API refused without a message of its own. */
const GENERIC_FAILURE_MESSAGE = 'The request could not be completed. Please try again.';

/** Shown on a 401. The redirect to /login is already under way when a caller sees it. */
const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please sign in again.';

/**
 * How long sign-out waits for the server before leaving anyway.
 *
 * Sign-out is best effort by design: a backend that is down must not trap a user in a session they
 * are trying to end. The local half (dropping the token) always happens; this only bounds how long
 * the server half is given.
 */
const LOGOUT_TIMEOUT_MS = 5000;

/**
 * True when an axios error carries the API's own `{ status, … }` envelope.
 *
 * @param {Object} err - The axios error.
 * @returns {Boolean}
 */
const _hasEnvelope = (err) => {
    if (!err || !err.response || !err.response.data) {
        return false;
    }
    const body = err.response.data;
    if (typeof body !== 'object') {
        return false;
    }
    return Object.prototype.hasOwnProperty.call(body, 'status');
};

/**
 * Settles one request into an envelope. Never rejects.
 *
 * @param {Promise} request - The axios promise.
 * @param {String} label - Method name, for the console line on a transport failure.
 * @returns {Promise<Object>} `{ status, msg, data, error }`, plus `resource_access: 'NOT_ALLOWED'` on a 401.
 */
const _settle = (request, label) => request
    .then((response) => {
        const body = response ? response.data : null;
        if (body && typeof body === 'object') {
            return body;
        }
        return { status: false, msg: GENERIC_FAILURE_MESSAGE, data: {}, error: {} };
    })
    .catch((err) => {
        const httpStatus = err && err.response ? err.response.status : 0;
        if (httpStatus === 401) {
            return { status: false, msg: SESSION_EXPIRED_MESSAGE, data: {}, error: {}, resource_access: 'NOT_ALLOWED' };
        }
        if (_hasEnvelope(err)) {
            return err.response.data;
        }
        if (err && err.response) {
            return { status: false, msg: GENERIC_FAILURE_MESSAGE, data: {}, error: {} };
        }
        // The error CLASS only, never `err`: an axios error carries `config.data` (for
        // changePassword, both plaintext passwords) and `config.headers.Authorization`.
        console.log(`account.${label} transport error`, (err && (err.code || err.message)) || 'unknown');
        return { status: false, msg: NETWORK_FAILURE_MESSAGE, data: {}, error: {} };
    });

class AccountApiService {
    constructor() {
        this.apiClient = new AxiosClientProvider().getClient();
    }

    /**
     * Reads who is signed in, their role and every permission it grants.
     *
     * @returns {Promise<Object>} Resolves `{ status, msg, data: { user: { user_id, email, name,
     * created_at, last_login_at }, role: { key, label, is_owner }, permissions: String[], session:
     * { session_id, expires_at } } }`. Never rejects.
     */
    getAccount() {
        return _settle(this.apiClient.get('account'), 'getAccount');
    }

    /**
     * Renames the signed-in user.
     *
     * @param {String} name - 1–100 characters after trimming; the server validates.
     * @returns {Promise<Object>} Resolves `{ status, msg, data: { user } }` or the refusal. Never rejects.
     */
    updateName(name) {
        return _settle(this.apiClient.patch('account', { name: name }), 'updateName');
    }

    /**
     * Changes the signed-in user's password.
     *
     * ⚠️ On success the CURRENT token is dead (the session epoch moved). Store `data.token` through
     * `applyFreshToken` immediately — see the file header.
     *
     * @param {String} currentPassword - The password being replaced. Never logged, never stored.
     * @param {String} newPassword - The replacement. The server applies the policy.
     * @returns {Promise<Object>} Resolves `{ status, msg, data: { token, expires_at,
     * expires_in_seconds } }` or the refusal (`error.code` CURRENT_PASSWORD_INCORRECT,
     * PASSWORD_POLICY, VALIDATION). Never rejects.
     */
    changePassword(currentPassword, newPassword) {
        return _settle(
            this.apiClient.post('account/password', {
                current_password: currentPassword,
                new_password: newPassword
            }),
            'changePassword'
        );
    }

    /**
     * Signs the user out of every OTHER browser and device.
     *
     * ⚠️ Like `changePassword`, this ends the current token too and returns a fresh one to store.
     *
     * @returns {Promise<Object>} Resolves `{ status, msg, data: { token, expires_at,
     * expires_in_seconds, … } }` or the refusal. Never rejects.
     */
    revokeOtherSessions() {
        return _settle(this.apiClient.post('account/sessions/revoke-others', {}), 'revokeOtherSessions');
    }

    /**
     * Ends THIS session on the server. Best effort, and bounded by `LOGOUT_TIMEOUT_MS`.
     *
     * Dropping the local token is the caller's job (the session context's `logout`), and it happens
     * whatever this resolves to — a sign-out that depends on the server answering is a sign-out that
     * fails exactly when the server is the problem.
     *
     * @returns {Promise<Object>} Resolves the envelope or a failure envelope. Never rejects.
     */
    logout() {
        return _settle(this.apiClient.post('account/logout', {}, { timeout: LOGOUT_TIMEOUT_MS }), 'logout');
    }
}

export default AccountApiService;
