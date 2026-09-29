import AxiosClientProvider from './apiClient';
import { clearAuthToken, getAuthToken, getLoginDeviceToken, setAuthToken, setLoginDeviceToken } from '../utils/auth';

/**
 * =============================================================================
 *  The public auth endpoints — everything reachable WITHOUT a session.
 * =============================================================================
 *
 *      login                 POST /api/auth/login             { email, password, device_token? }
 *      getSetupStatus        GET  /api/auth/setup
 *      requestSetup          POST /api/auth/setup             { email, name }
 *      inspectSetupToken     POST /api/auth/setup/inspect     { token }
 *      completeSetup         POST /api/auth/setup/complete    { token, name, password }
 *      inspectInvite         POST /api/auth/invites/inspect   { token }
 *      acceptInvite          POST /api/auth/invites/accept    { token, name, password }
 *      requestPasswordReset  POST /api/auth/password/forgot   { email }
 *      resetPassword         POST /api/auth/password/reset    { token, password }
 *
 *  Signed-in account calls (logout, change password) are NOT here: they need a
 *  session and live in `accountService.js`.
 *
 *  ── PROMISES HERE, CALLBACKS EVERYWHERE ELSE ────────────────────────────────
 *  Every service under `growth-intel/` takes a callback, because the pages that
 *  call them were ported from a dashboard written that way and must not be
 *  edited. Nothing was ported here — these screens are new — so these are
 *  promises, which is what a form's submit handler wants.
 *
 *  ── NOTHING HERE EVER REJECTS ───────────────────────────────────────────────
 *  A wrong password, an expired link and a refused request are NORMAL outcomes
 *  of these forms, not exceptions. Every method resolves the same envelope:
 *
 *      { status, msg, data, error, http_status }
 *
 *  `error` is always an object; a business failure carries `error.code`
 *  (TOKEN_INVALID, TOKEN_EXPIRED, INVITE_REVOKED, TOKEN_USED, PASSWORD_POLICY,
 *  SETUP_ALREADY_COMPLETE, ALREADY_A_MEMBER, RATE_LIMITED, …). `http_status` is
 *  the response's status code, or 0 when no response arrived at all. Pages
 *  branch on those two and render `msg`.
 *
 *  ──  THE SERVER'S WORDS, UNCHANGED ─────────────────────────────────────────
 *  Sign-in, forgot-password and setup-request answers are deliberately identical
 *  whether or not an account exists or an address is permitted — the backend
 *  pays the same cost either way so timing does not give the answer away
 *  instead. This file passes `msg` through UNCHANGED and invents no wording of
 *  its own from the response body. Do not add a friendlier "no account found":
 *  the client cannot know it, and inventing it here would undo the defence at
 *  the only place a person can observe it.
 *
 *  ⚠️ NEVER LOG A REQUEST HERE. An axios error carries `config.data` — the JSON
 *  body, i.e. the password or the emailed token. Transport failures are logged
 *  as `err.code` / `err.message` only.
 * =============================================================================
 */

const LOGIN_PATH = 'auth/login';
const SETUP_PATH = 'auth/setup';
const SETUP_INSPECT_PATH = 'auth/setup/inspect';
const SETUP_COMPLETE_PATH = 'auth/setup/complete';
const INVITE_INSPECT_PATH = 'auth/invites/inspect';
const INVITE_ACCEPT_PATH = 'auth/invites/accept';
const PASSWORD_FORGOT_PATH = 'auth/password/forgot';
const PASSWORD_RESET_PATH = 'auth/password/reset';

/**
 * Shown when the request never reached the API. Distinct from every server answer on purpose —
 * "we could not reach the server" is a different problem from "that password is wrong", and telling
 * them apart is the difference between checking your typing and checking whether the backend is up.
 */
const NETWORK_FAILURE_MESSAGE = 'Could not reach the server. Check that the backend is running and try again.';

/** Last-resort text if the login API answers a failure with no message at all. Deliberately non-specific. */
const LOGIN_FAILURE_MESSAGE = 'Could not sign you in. Please try again.';

/** Last-resort text for every other endpoint answering with no readable message. */
const GENERIC_FAILURE_MESSAGE = 'The server could not complete this request. Please try again.';

/**
 * Builds the envelope from an axios response (2xx, or the `response` of a non-2xx error).
 *
 * A body that is not the API's JSON envelope — the Next proxy's own error page when the backend is
 * down, say — still yields a well-formed envelope, and its `msg` names the HTTP status so the person
 * has something to report.
 *
 * @param {Object} response - An axios response.
 * @param {String} fallbackMsg - Used when the body carries no message.
 * @returns {{ status: Boolean, msg: String, data: Object, error: Object, http_status: Number }} The envelope.
 */
const _envelopeFromResponse = (response, fallbackMsg) => {
    const httpStatus = response && typeof response.status === 'number' ? response.status : 0;
    let body = {};
    if (response && response.data && typeof response.data === 'object') {
        body = response.data;
    }

    let msg = fallbackMsg;
    if (typeof body.msg === 'string' && body.msg) {
        msg = body.msg;
    } else if (httpStatus >= 400) {
        msg = `${fallbackMsg} (HTTP ${httpStatus})`;
    }

    let data = {};
    if (body.data && typeof body.data === 'object') {
        data = body.data;
    }
    let error = {};
    if (body.error && typeof body.error === 'object') {
        error = body.error;
    }

    return {
        status: body.status === true && httpStatus >= 200 && httpStatus < 300,
        msg: msg,
        data: data,
        error: error,
        http_status: httpStatus
    };
};

/**
 * Builds the envelope from a rejected axios call.
 *
 * @param {*} err - What axios rejected with.
 * @param {String} fallbackMsg - Used when the server answered with no message.
 * @param {String} label - Names the method in the transport-failure log line.
 * @returns {{ status: Boolean, msg: String, data: Object, error: Object, http_status: Number }} Always `status: false`.
 */
const _envelopeFromError = (err, fallbackMsg, label) => {
    if (err && err.response) {
        const envelope = _envelopeFromResponse(err.response, fallbackMsg);
        envelope.status = false;
        return envelope;
    }
    // No response at all: DNS, connection refused, the dev server's proxy target down. Log the class
    // only — see the file header on why the error object itself is never logged.
    let reason = 'unknown';
    if (err && (err.code || err.message)) {
        reason = err.code || err.message;
    }
    console.log(`auth.${label} transport error`, reason);
    return { status: false, msg: NETWORK_FAILURE_MESSAGE, data: {}, error: {}, http_status: 0 };
};

class AuthApiService {
    constructor() {
        this.apiClient = new AxiosClientProvider().getClient();
    }

    /**
     * POSTs a JSON body to one public endpoint and resolves the envelope, never rejecting.
     *
     * @param {String} path - Relative to `/api/`.
     * @param {Object} body - The JSON body.
     * @param {String} label - Names the method in the transport-failure log line.
     * @returns {Promise<Object>} The envelope.
     */
    _post(path, body, label) {
        return this.apiClient
            .post(path, body)
            .then((response) => _envelopeFromResponse(response, GENERIC_FAILURE_MESSAGE))
            .catch((err) => _envelopeFromError(err, GENERIC_FAILURE_MESSAGE, label));
    }

    /**
     * Exchanges credentials for a bearer token and STORES it.
     *
     * Storing on success is the point of this method — every other service reads the token back out
     * of `utils/auth` per request, so a successful call here is what makes the rest of the app work,
     * with no further wiring at the call site.
     *
     * It also sends, and on success replaces, this browser's sign-in device token (`utils/auth`),
     * which gives a returning user a rate-limit budget no one else can spend.
     *
     * @param {String} email - The person's email.
     * @param {String} password - Their password. Never logged, never stored.
     * @returns {Promise<Object>} Always resolves, never rejects: `{ status, msg, data, error, http_status }`.
     * On success `status` is true and `data` carries `{ token, expires_in_seconds, expires_at, user_id, email, device_token }`.
     * On failure `status` is false and `msg` is the server's own wording, which is intentionally the
     * same for a bad email and a bad password.
     */
    login(email, password) {
        const body = { email: email, password: password };
        const deviceToken = getLoginDeviceToken();
        if (deviceToken) {
            body.device_token = deviceToken;
        }
        return this.apiClient
            .post(LOGIN_PATH, body)
            .then((response) => {
                const envelope = _envelopeFromResponse(response, LOGIN_FAILURE_MESSAGE);
                if (envelope.status && envelope.data.token) {
                    setAuthToken(envelope.data.token);
                    setLoginDeviceToken(envelope.data.device_token);
                    return envelope;
                }
                // A 2xx with no token. Should not happen against this backend, but a partial
                // response must not read as a successful sign-in.
                return { status: false, msg: envelope.msg, data: {}, error: envelope.error, http_status: envelope.http_status };
            })
            // The API answered, and said no — 401 for bad credentials, 400 for an incomplete request.
            // Its message is the one to show; see the file header on why we add none.
            .catch((err) => _envelopeFromError(err, LOGIN_FAILURE_MESSAGE, 'login'));
    }

    /**
     * Reads whether this install has been set up.
     *
     * @returns {Promise<Object>} The envelope. On success `data` is `{ setup_complete: true }` once setup
     * is done, or, while it is not, `{ setup_complete: false, mail_configured, mail_last_check,
     * setup_restricted, public_url }`.
     */
    getSetupStatus() {
        return this.apiClient
            .get(SETUP_PATH)
            .then((response) => _envelopeFromResponse(response, GENERIC_FAILURE_MESSAGE))
            .catch((err) => _envelopeFromError(err, GENERIC_FAILURE_MESSAGE, 'getSetupStatus'));
    }

    /**
     * Asks for a setup verification email.
     *
     * The answer (202) is the same whether or not the address may set up this install — render
     * `msg` exactly as given.
     *
     * @param {String} email - The owner-to-be's email.
     * @param {String} name - Their display name.
     * @returns {Promise<Object>} The envelope. 202 `{ accepted: true }`; 409 `SETUP_ALREADY_COMPLETE`;
     * 429 `SETUP_CAPACITY` / `RATE_LIMITED`; 400 for a malformed request.
     */
    requestSetup(email, name) {
        return this._post(SETUP_PATH, { email: email, name: name }, 'requestSetup');
    }

    /**
     * Reads what a setup verification link is for, without consuming it.
     *
     * @param {String} token - The token from the link's fragment.
     * @returns {Promise<Object>} The envelope. 200 `{ email, name, expires_at }`; 400 with a `TOKEN_*`
     * code; 409 once setup is complete.
     */
    inspectSetupToken(token) {
        return this._post(SETUP_INSPECT_PATH, { token: token }, 'inspectSetupToken');
    }

    /**
     * Completes setup: creates the owner account. Does NOT sign in.
     *
     * @param {String} token - The token from the link's fragment.
     * @param {String} name - The owner's display name.
     * @param {String} password - The chosen password. Never logged, never stored.
     * @returns {Promise<Object>} The envelope. 201 `{ setup_complete: true }`; 400 with a `TOKEN_*` or
     * policy code; 409 `SETUP_ALREADY_COMPLETE`; 503 when the datastore could not be consulted.
     */
    completeSetup(token, name, password) {
        return this._post(SETUP_COMPLETE_PATH, { token: token, name: name, password: password }, 'completeSetup');
    }

    /**
     * Reads what an invitation link is for, without consuming it.
     *
     * @param {String} token - The token from the link's fragment.
     * @returns {Promise<Object>} The envelope. 200 `{ email, role_label, invited_by_name, expires_at }`;
     * 400 with a `TOKEN_*` / `INVITE_REVOKED` code.
     */
    inspectInvite(token) {
        return this._post(INVITE_INSPECT_PATH, { token: token }, 'inspectInvite');
    }

    /**
     * Accepts an invitation: creates the account. Does NOT sign in.
     *
     * @param {String} token - The token from the link's fragment.
     * @param {String} name - The new user's display name.
     * @param {String} password - The chosen password. Never logged, never stored.
     * @returns {Promise<Object>} The envelope. 201 on success; 400 with a `TOKEN_*`, `INVITE_REVOKED` or
     * policy code; 409 `ALREADY_A_MEMBER`; 503 when the datastore could not be consulted.
     */
    acceptInvite(token, name, password) {
        return this._post(INVITE_ACCEPT_PATH, { token: token, name: name, password: password }, 'acceptInvite');
    }

    /**
     * Asks for a password-reset email.
     *
     * The answer (202) is the same whether or not an account exists — render `msg` exactly as given.
     *
     * @param {String} email - The account's email.
     * @returns {Promise<Object>} The envelope. 202 always for a well-formed request; 400 for a malformed
     * one; 429 when rate limited.
     */
    requestPasswordReset(email) {
        return this._post(PASSWORD_FORGOT_PATH, { email: email }, 'requestPasswordReset');
    }

    /**
     * Sets a new password from a reset link. Signs every session of that account out; does NOT sign in.
     *
     * @param {String} token - The token from the link's fragment.
     * @param {String} password - The new password. Never logged, never stored.
     * @returns {Promise<Object>} The envelope. 200 on success; 400 with a `TOKEN_*` or policy code.
     */
    resetPassword(token, password) {
        return this._post(PASSWORD_RESET_PATH, { token: token, password: password }, 'resetPassword');
    }

    /**
     * Discards the stored token — locally, and only locally.
     *
     * ⚠️ THIS DOES NOT END THE SESSION ON THE SERVER. Sessions are server-side rows now; the dashboard's
     * sign-out is `POST /api/account/logout` (session context → accountService), which revokes the row
     * and then clears the token. Calling only this leaves the session valid until it expires or is
     * revoked. It remains for the token pages, which must drop whatever session this browser holds
     * before sending the person to /login as the account they just created.
     *
     * Navigating afterwards is the caller's job; this file has no router.
     *
     * @returns {void}
     */
    logout() {
        clearAuthToken();
    }

    /**
     * Reads the stored bearer token.
     *
     * Provided so callers can ask one object about auth rather than importing `utils/auth` as well.
     * The axios client does NOT go through this — it reads the storage helper directly, per request.
     *
     * @returns {String} The token, or '' when signed out.
     */
    getToken() {
        return getAuthToken();
    }
}

/**
 * Discards the stored token locally. Module-level twin of `AuthApiService#logout`, with the same
 * caveat: the server-side session is NOT revoked by this.
 *
 * @returns {void}
 */
export const logout = () => clearAuthToken();

/**
 * Reads the stored bearer token. Module-level twin of `AuthApiService#getToken`.
 *
 * @returns {String} The token, or '' when signed out.
 */
export const getToken = () => getAuthToken();

export default AuthApiService;
