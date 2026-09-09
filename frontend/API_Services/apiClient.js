import axios from 'axios';
import { clearAuthToken, getAuthToken } from '../utils/auth';

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

/** Login is the one endpoint whose 401 means "wrong password", not "session over". */
const LOGIN_PATH = 'auth/login';

/** Where an expired or missing session is sent. Must match the public route in _app.js. */
const LOGIN_ROUTE = '/login';

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
 * one that wins is whichever resolved last — so the operator can be returned to a
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
    // Already there: a redirect would reload the login form out from under the operator.
    if (window.location.pathname === LOGIN_ROUTE) {
        return;
    }
    _redirectStarted = true;
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace(`${LOGIN_ROUTE}?next=${next}`);
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
            if (token) {
                config.headers.Authorization = `Bearer ${token}`;
            }
            return config;
        });

        /**
         * A 401 means the session is gone: drop the dead token and go to /login.
         *
         * ⚠️ EXCEPT ON THE LOGIN CALL ITSELF. `POST /api/auth/login` answers 401 for
         * bad credentials; redirecting on that would reload the page out from under
         * the form and the operator would never see "email or password incorrect" —
         * it would look like the button did nothing.
         *
         * The error is still re-thrown afterwards, so each service's own `.catch`
         * runs and pages keep whatever empty/failed state they already render.
         */
        this.instance.interceptors.response.use(
            (response) => response,
            (error) => {
                const status = error && error.response ? error.response.status : 0;
                const url = error && error.config ? String(error.config.url || '') : '';
                if (status === 401 && !url.includes(LOGIN_PATH)) {
                    clearAuthToken();
                    _redirectToLogin();
                }
                return Promise.reject(error);
            }
        );
    }

    /**
     * The configured axios instance.
     *
     * @returns {import('axios').AxiosInstance} Client with the bearer + 401 interceptors installed.
     */
    getClient() {
        return this.instance;
    }
}

export default AxiosClientProvider;
