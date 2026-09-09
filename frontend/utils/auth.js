/**
 * =============================================================================
 *  Session token storage — the ONE place the dashboard keeps its credential.
 * =============================================================================
 *
 *  The backend issues a bearer JWT from `POST /api/auth/login` and expects it
 *  back as `Authorization: Bearer <token>` on every other call. It reads no
 *  cookie and accepts no `?token=` query parameter, deliberately (see the
 *  backend's `middlewares/verifyAdmin.ts` for why).
 *
 *  ── WHY localStorage AND NOT A COOKIE ───────────────────────────────────────
 *  A cookie is attached by the browser automatically, on cross-site requests
 *  too, which is precisely what makes cookie-authenticated APIs CSRF-exposed. An
 *  Authorization header is never attached automatically, so nothing a third-party
 *  page can do causes an authenticated request to this API. That property is
 *  worth more here than the (theoretical, same-origin-only) XSS argument for
 *  httpOnly cookies — this dashboard renders no user-authored HTML.
 *
 *  ── EVERY ACCESS IS GUARDED ─────────────────────────────────────────────────
 *  These functions are called during server-side rendering and inside Safari
 *  private mode, where `window` is absent and `localStorage` THROWS on access
 *  rather than returning null. Each read and write is therefore both
 *  `typeof window` guarded and wrapped in try/catch. A storage failure degrades
 *  to "not signed in", never to a crashed render.
 * =============================================================================
 */

/** localStorage key holding the bearer token. Changing it signs everyone out. */
export const AUTH_TOKEN_KEY = 'saa.authToken';

/**
 * Reads the stored bearer token.
 *
 * @returns {String} The token, or '' when absent, unreadable, or running on the server.
 */
export const getAuthToken = () => {
    if (typeof window === 'undefined') {
        return '';
    }
    try {
        return window.localStorage.getItem(AUTH_TOKEN_KEY) || '';
    } catch (e) {
        // Private mode / storage disabled — treat as signed out.
        return '';
    }
};

/**
 * Stores the bearer token issued by `POST /api/auth/login`.
 *
 * @param {String} token - The raw JWT. A falsy value clears the stored token instead.
 * @returns {void}
 */
export const setAuthToken = (token) => {
    if (typeof window === 'undefined') {
        return;
    }
    try {
        if (token) {
            window.localStorage.setItem(AUTH_TOKEN_KEY, token);
            return;
        }
        window.localStorage.removeItem(AUTH_TOKEN_KEY);
    } catch (e) {
        // Storage blocked. The token still applies for this page's lifetime via
        // the in-memory axios call that just succeeded; the next reload signs out.
    }
};

/**
 * Clears the stored bearer token. Used on explicit logout and on any 401.
 *
 * @returns {void}
 */
export const clearAuthToken = () => setAuthToken('');

/**
 * Whether a token is present. NOT a validity check — only the API can say that,
 * and it does, with a 401 that the axios client turns into a redirect.
 *
 * @returns {Boolean} True when a non-empty token is stored.
 */
export const hasAuthToken = () => Boolean(getAuthToken());
