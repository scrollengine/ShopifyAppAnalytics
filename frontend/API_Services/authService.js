import AxiosClientProvider from './apiClient';
import { clearAuthToken, getAuthToken, setAuthToken } from '../utils/auth';

/**
 * =============================================================================
 *  Signing in. One endpoint, and the only one reachable without a token.
 * =============================================================================
 *
 *      POST /api/auth/login   { email, password }
 *        → { status, msg, data: { token, expires_in_seconds, expires_at, user_id, email } }
 *
 *  ── PROMISES HERE, CALLBACKS EVERYWHERE ELSE ────────────────────────────────
 *  Every service under `growth-intel/` takes a callback, because the pages that
 *  call them were ported from a dashboard written that way and must not be
 *  edited. Nothing was ported here — the login screen is new — so this one is a
 *  promise, which is what the form's submit handler wants.
 *
 *  ── IT NEVER REJECTS ────────────────────────────────────────────────────────
 *  A wrong password is a NORMAL outcome of a login form, not an exception. So
 *  every path resolves with the same `{ status, msg, data }` envelope the API
 *  itself uses, and the caller renders `msg` whatever happened. A rejected
 *  promise here would mean every caller needs a try/catch to render the one
 *  thing the endpoint most often has to say.
 *
 *  ──  IT MUST NOT BECOME MORE HELPFUL ───────────────────────────────────────
 *  The backend answers "Email or password is incorrect." for BOTH an unknown
 *  email and a wrong password, and pays the same bcrypt cost either way so the
 *  timing does not give the answer away instead. That is deliberate: a login
 *  form that distinguishes the two is an oracle for "is this person an operator
 *  of this deployment".
 *
 *  This file passes the server's message through UNCHANGED and adds no branch of
 *  its own on the response body. Do not add a friendlier "no account found" —
 *  the client cannot know it, and inventing it here would undo the defence at
 *  the only place a user can observe it.
 * =============================================================================
 */

/** The one path. Also matched by the axios 401 interceptor, which must NOT redirect on it. */
const LOGIN_PATH = 'auth/login';

/**
 * Shown when the request never reached the API, or came back shaped in a way we cannot read.
 * Distinct from a credential failure on purpose — "we could not reach the server" is a different
 * problem from "that password is wrong", and telling them apart is the difference between checking
 * your typing and checking whether the backend is running.
 */
const NETWORK_FAILURE_MESSAGE = 'Could not reach the server. Check that the backend is running and try again.';

/** Last-resort text if the API answers a failure with no message at all. Deliberately non-specific. */
const GENERIC_FAILURE_MESSAGE = 'Could not sign you in. Please try again.';

class AuthApiService {
    constructor() {
        this.apiClient = new AxiosClientProvider().getClient();
    }

    /**
     * Exchanges credentials for a bearer token and STORES it.
     *
     * Storing on success is the point of this method — every other service reads the token back out
     * of `utils/auth` per request, so a successful call here is what makes the rest of the app work,
     * with no further wiring at the call site.
     *
     * @param {String} email - The operator's email.
     * @param {String} password - The operator's password. Never logged, never stored.
     * @returns {Promise<Object>} Always resolves, never rejects: `{ status, msg, data }`. On success
     * `status` is true and `data` carries `{ token, expires_in_seconds, expires_at, user_id, email }`.
     * On failure `status` is false and `msg` is the server's own wording, which is intentionally the
     * same for a bad email and a bad password.
     */
    login(email, password) {
        return this.apiClient
            .post(LOGIN_PATH, { email: email, password: password })
            .then((response) => {
                const body = response && response.data ? response.data : {};
                if (body.status && body.data && body.data.token) {
                    setAuthToken(body.data.token);
                    return body;
                }
                // A 2xx with no token. Should not happen against this backend, but a partial
                // response must not read as a successful sign-in.
                let msg = GENERIC_FAILURE_MESSAGE;
                if (body.msg) {
                    msg = body.msg;
                }
                return { status: false, msg: msg, data: {} };
            })
            .catch((err) => {
                // The API answered, and said no — 401 for bad credentials, 400 for an incomplete
                // request. Its message is the one to show; see the file header on why we add none.
                if (err && err.response && err.response.data && err.response.data.msg) {
                    return { status: false, msg: err.response.data.msg, data: {} };
                }
                if (err && err.response) {
                    return { status: false, msg: GENERIC_FAILURE_MESSAGE, data: {} };
                }
                // No response at all: DNS, connection refused, the dev server's proxy target down.
                console.log('auth.login transport error', err);
                return { status: false, msg: NETWORK_FAILURE_MESSAGE, data: {} };
            });
    }

    /**
     * Signs the operator out by discarding the stored token.
     *
     * There is no server call, because there is nothing on the server to call: the token is a
     * self-contained JWT with an expiry and this backend keeps no session table, so "logging out" is
     * exactly "stop presenting the credential". A token copied out of storage before this runs stays
     * valid until it expires — which is a property of stateless tokens, not something this method
     * could fix, and the reason `AUTH_TOKEN_TTL_HOURS` is set at all.
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
 * Discards the stored token. Module-level twin of `AuthApiService#logout`, for a nav button that has
 * no reason to construct a service just to sign out.
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
