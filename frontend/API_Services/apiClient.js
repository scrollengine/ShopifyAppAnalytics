import axios from 'axios';
import { clearAuthToken, getAuthToken } from '../utils/auth';
import { AUTH_ROUTES, isPublicRoute } from '../utils/publicRoutes';

/**
 * =============================================================================
 *  The one axios client. Every API service in this app is built on it.
 * =============================================================================
 *
 *  ── THREE PATTERNS THIS DELIBERATELY DOES NOT USE ───────────────────────────
 *  A common shape for a client like this is a token COOKIE, read ONCE in the
 *  constructor, sent to an absolute backend URL. Three problems come with that,
 *  and all three are avoided here:
 *
 *   1.  THE TOKEN WAS READ AT CONSTRUCTION. Services are instantiated at module
 *      load — `const API = new SomeService()` at the top of a context or a page —
 *      which happens BEFORE the user logs in. The client therefore captured
 *      whatever was there at import time, and a fresh login did not reach an
 *      already-constructed client until a full page reload. Here the token is
 *      read PER REQUEST in an interceptor, so a login takes effect immediately
 *      and a logout stops being honoured immediately.
 *
 *   2. The base URL was absolute and cross-origin, which needed CORS headers on
 *      the API. Here it is the relative `/api/`, proxied by the rewrite in
 *      next.config.js, so the browser sees a single origin.
 *
 *   3. Auth failures came back as HTTP 200 with `{ status: false }`, so no client
 *      could distinguish "not signed in" from "signed in, empty result" without
 *      inspecting the body. This backend answers a real 401 — so the redirect
 *      below is reliable, and it is the only place that decision is made.
 *
 *  ── THE RESPONSE ENVELOPE (unchanged, deliberately) ─────────────────────────
 *  Successful calls return `{ status, msg, data, error }` and every service
 *  hands `response.data` (that whole envelope) to its callback. Ported pages
 *  read `resp.status` / `resp.data` and need no edits.
 * =============================================================================
 */

/**
 * Relative on purpose — see the file header and next.config.js. Do NOT put
 * `process.env.NEXT_PUBLIC_API_BASE_URL` here: that would bake the backend's
 * hostname into the browser bundle and reintroduce the cross-origin request the
 * rewrite exists to avoid.
 */
const API_URL = '/api/';

/**
 * The public auth endpoints all live under `/api/auth/`, and a 401 from any of them means something
 * other than "session over": from `auth/login` it is "wrong password", and the token flows (setup,
 * invite, reset) never answer 401 at all by contract. So no 401 from this prefix may clear the token
 * or redirect — see the response interceptor.
 */
const AUTH_PATH_PREFIX = 'auth/';

/** Where an expired or missing session is sent. Declared once, in `utils/publicRoutes.js`. */
const LOGIN_ROUTE = AUTH_ROUTES.LOGIN;

/**
 * The request-config field recording the exact token a request was sent with ('' for none). Read
 * back by the 401 handler; see `_handleUnauthorized`. Not `headers.Authorization`: that is absent
 * for a request sent with no token, and the empty-token case must still redirect.
 */
const SENT_TOKEN_FIELD = '_saaSentToken';

/**
 * Whether a request URL is one of the public `/api/auth/*` endpoints.
 *
 * Every service passes a path relative to the `/api/` base (`'auth/login'`), but a leading slash or
 * an `api/` prefix is tolerated so a future call written as `'/api/auth/...'` is still recognised —
 * mis-classifying a login failure as an expired session reloads the form out from under the person
 * typing into it.
 *
 * @param {*} url - `error.config.url` as axios hands it over.
 * @returns {Boolean} True for an auth endpoint.
 */
const _isAuthEndpoint = (url) => {
    if (typeof url !== 'string') {
        return false;
    }
    let path = url.replace(/^\/+/, '');
    if (path.startsWith('api/')) {
        path = path.slice('api/'.length);
    }
    return path.startsWith(AUTH_PATH_PREFIX);
};

/**
 * The `next` value for the current location: pathname plus query string, NEVER the fragment, and
 * no query string at all when it mentions a token.
 *
 * The fragment is where emailed links carry their token (`#token=…`), and `next` is echoed into the
 * login URL, the browser history and the address bar. None of the token pages should ever reach
 * this function — they are public routes, skipped above — but this is the one place a URL is copied
 * into another URL, so it refuses to copy the dangerous parts whoever calls it. A query string that
 * cannot be decoded is dropped too: it cannot be checked, so it cannot be carried.
 *
 * @returns {String} A same-origin path, possibly with a query string.
 */
const _nextFromLocation = () => {
    const pathname = window.location.pathname || '/';
    let search = window.location.search || '';
    let decoded = '';
    try {
        decoded = decodeURIComponent(search);
    } catch (e) {
        search = '';
    }
    if (/token/i.test(search) || /token/i.test(decoded)) {
        search = '';
    }
    return pathname + search;
};

/**
 * Listeners told about every 403 FORBIDDEN response. Module-level for the same reason as the latch
 * below: every service builds its own client, and one subscription must hear all of them.
 */
const _forbiddenListeners = new Set();

/**
 * Subscribes to 403 FORBIDDEN responses from any service.
 *
 * Exists for the session context, which re-reads the account when the server refuses something the
 * page believed the role allowed — a role changed by an admin mid-session shows up as exactly that.
 * The listener only OBSERVES: the error still reaches the calling service unchanged, and nothing here
 * clears a token or navigates on a 403.
 *
 * @param {Function} listener - Called with `{ permission, url }`; `permission` is the key the server
 * named, or '' when it named none. A throwing listener is ignored.
 * @returns {Function} Unsubscribes the listener.
 */
export const onForbiddenResponse = (listener) => {
    if (typeof listener !== 'function') {
        return () => {};
    }
    _forbiddenListeners.add(listener);
    return () => {
        _forbiddenListeners.delete(listener);
    };
};

/**
 * Tells every {@link onForbiddenResponse} listener about one 403 FORBIDDEN response.
 *
 * @param {Object} error - The rejected axios error.
 * @returns {void}
 */
const _notifyForbidden = (error) => {
    const body = error.response.data;
    if (!body || typeof body !== 'object' || !body.error || body.error.code !== 'FORBIDDEN') {
        return;
    }
    let permission = '';
    if (typeof body.error.permission === 'string') {
        permission = body.error.permission;
    }
    const url = error.config && typeof error.config.url === 'string' ? error.config.url : '';
    _forbiddenListeners.forEach((listener) => {
        try {
            listener({ permission: permission, url: url });
        } catch (e) {
            // A broken listener must not turn a 403 into an unhandled exception inside axios.
        }
    });
};

/**
 * Whether a redirect to /login has already been started by this module.
 *
 * ⚠️ MODULE-LEVEL, and it must stay that way. Every service constructs its own
 * `AxiosClientProvider`, so an instance field would give each service its own
 * latch and defeat the whole point — the flag has to be shared by all of them.
 * A full page load is what clears it, which is exactly the lifetime wanted.
 */
let _redirectStarted = false;

/**
 * Sends an unauthenticated caller to the login screen, exactly once.
 *
 * `window.location.replace` rather than the Next router because this runs from an
 * axios interceptor that has no router instance, and because replacing the entry
 * drops the dead page from history — a back button that returns to a screen which
 * immediately 401s again is worse than no back button.
 *
 * ── ⚠️ WHY THE LATCH ────────────────────────────────────────────────────────
 * A dashboard page fires several requests in parallel — the partner-app list, the
 * page's own data, the coverage strip. When the session has expired they do not
 * fail one at a time; they all 401 within a few milliseconds of each other, and
 * every one of them lands here.
 *
 * The pathname check below cannot catch that: `window.location.pathname` is still
 * the OLD page's path until the navigation actually commits, so the second and
 * third callers see a path that is not /login and issue their own `replace()`.
 * The result is several navigations racing, each carrying its own `next`, and the
 * one that wins is whichever resolved last — so the person can be returned to a
 * different page than the one they were on. Latching on a flag set synchronously,
 * before the navigation is requested, is what makes "once" true.
 *
 * @returns {void}
 */
const _redirectToLogin = () => {
    if (typeof window === 'undefined') {
        return;
    }
    // One redirect per page load, however many requests failed. See above.
    if (_redirectStarted) {
        return;
    }
    // On ANY public page, not just /login. A redirect from /login would reload the form out from
    // under the person typing; from a token page (/setup/verify, /accept-invite, /reset-password) it
    // would throw away the only copy of a token the page has already stripped from the address bar.
    if (isPublicRoute(window.location.pathname)) {
        return;
    }
    _redirectStarted = true;
    const next = encodeURIComponent(_nextFromLocation());
    window.location.replace(`${LOGIN_ROUTE}?next=${next}`);
};

/**
 * What a 401 from a guarded endpoint does: sign out ONLY if the credential that failed is still the
 * one stored.
 *
 * ⚠️ WHY IT COMPARES. All tabs share one storage key. Change-password and "sign out my other
 * sessions" store a FRESH token the moment the server answers; a request another tab sent a moment
 * earlier with the old token then comes back 401. Clearing storage on that 401 deleted the fresh
 * token and signed the person out everywhere right after the server had told them "this one stays
 * signed in". A failed old token says nothing about a newer one, so storage is left alone and the
 * error passes through; the next request carries the new token.
 *
 * Deliberately NO automatic retry with the newer token: it may belong to a different account
 * (another person signed in in another tab), and replaying the request would perform it as them.
 *
 * @param {Object} config - `error.config` of the failed request.
 * @returns {void}
 */
const _handleUnauthorized = (config) => {
    const sent = config && typeof config[SENT_TOKEN_FIELD] === 'string' ? config[SENT_TOKEN_FIELD] : '';
    const current = getAuthToken();
    if (current === sent) {
        // The stored credential is the one refused (or there never was one).
        clearAuthToken();
        _redirectToLogin();
        return;
    }
    if (!current) {
        // Someone else already cleared it.
        _redirectToLogin();
    }
    // Otherwise a newer token was stored after this request left: leave it alone.
};

class AxiosClientProvider {
    constructor() {
        this.instance = axios.create({
            baseURL: API_URL,
            method: 'get',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        /**
         * Attach the bearer token, per request.
         *
         * Reading it here rather than in the constructor is the whole point — see
         * problem (1) in the file header.
         */
        this.instance.interceptors.request.use((config) => {
            const token = getAuthToken();
            config[SENT_TOKEN_FIELD] = token;
            if (token) {
                config.headers.Authorization = `Bearer ${token}`;
            }
            return config;
        });

        /**
         * A 401 means the session is gone: drop the dead token and go to /login — provided the token
         * that failed is still the stored one (`_handleUnauthorized`).
         *
         * ⚠️ EXCEPT ON THE PUBLIC AUTH ENDPOINTS (`auth/*`). `POST /api/auth/login`
         * answers 401 for bad credentials; redirecting on that would reload the page
         * out from under the form and the person would never see "email or password
         * incorrect" — it would look like the button did nothing. The setup, invite
         * and reset endpoints never answer 401 by contract, and if one ever did, a
         * signed-in admin testing an invite link must not be signed out by it.
         *
         * ⚠️ A 403 IS NOT A 401 AND PASSES THROUGH UNTOUCHED. 403 means "signed in,
         * but your role does not include this" (`error.code === 'FORBIDDEN'`). The
         * session is fine; clearing the token or redirecting on it would sign out
         * everyone whose role is narrower than the page they opened. Subscribers
         * registered with `onForbiddenResponse` are told about it; the error itself
         * is re-thrown exactly as it arrived.
         *
         * The error is still re-thrown afterwards, so each service's own `.catch`
         * runs and pages keep whatever empty/failed state they already render.
         */
        this.instance.interceptors.response.use(
            (response) => response,
            (error) => {
                const status = error && error.response ? error.response.status : 0;
                const url = error && error.config ? error.config.url : '';
                if (status === 401 && !_isAuthEndpoint(url)) {
                    _handleUnauthorized(error.config);
                }
                if (status === 403) {
                    _notifyForbidden(error);
                }
                return Promise.reject(error);
            }
        );
    }

    /**
     * The configured axios instance.
     *
     * @returns {import('axios').AxiosInstance} Client with the bearer, 401 and 403 interceptors installed.
     */
    getClient() {
        return this.instance;
    }
}

export default AxiosClientProvider;
