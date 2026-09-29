/**
 * =============================================================================
 *  The routes reachable WITHOUT a session — one declaration, three readers.
 * =============================================================================
 *
 *  Read by:
 *    · `pages/_app.js` — the auth gate and the account-load hold skip these;
 *    · `API_Services/apiClient.js` — a 401 never redirects away from one of these;
 *    · `pages/login.js` — `next` may never point at one of these.
 *
 *  They used to be a literal array inside `_app.js` holding only `/login`, and
 *  the axios client kept its own `'/login'` next to a "must match" comment. With
 *  five more public pages, two copies would drift the first time a page was
 *  added to one and not the other — and the failure is silent: an emailed link
 *  that lands on a gated page bounces the invitee to /login with their token
 *  still in the URL, instead of letting them set a password.
 *
 *  ⚠️ THREE OF THESE PATHS ARE A CROSS-REPO STRING CONTRACT. The backend builds
 *  the emailed links as `${APP_PUBLIC_URL}/setup/verify#token=…`,
 *  `…/accept-invite#token=…` and `…/reset-password#token=…`
 *  (`buildAppLink` in the backend's auth module). Renaming a page here without
 *  changing the backend breaks every link already sitting in someone's inbox.
 * =============================================================================
 */

/** The public pages this app renders, by name. */
export const AUTH_ROUTES = Object.freeze({
    LOGIN: '/login',
    SETUP: '/setup',
    SETUP_VERIFY: '/setup/verify',
    ACCEPT_INVITE: '/accept-invite',
    FORGOT_PASSWORD: '/forgot-password',
    RESET_PASSWORD: '/reset-password'
});

/**
 * Every pathname reachable without a session.
 *
 * `/404` and `/_error` are here so a signed-out visitor who mistypes a URL gets
 * the error page rather than the blank screen the gate would otherwise hold them
 * on — a gate that hides Next's own error pages makes every mistake look like the
 * same broken app.
 */
export const PUBLIC_ROUTES = Object.freeze([
    AUTH_ROUTES.LOGIN,
    '/404',
    '/_error',
    AUTH_ROUTES.SETUP,
    AUTH_ROUTES.SETUP_VERIFY,
    AUTH_ROUTES.ACCEPT_INVITE,
    AUTH_ROUTES.FORGOT_PASSWORD,
    AUTH_ROUTES.RESET_PASSWORD
]);

/**
 * Whether `pathname` is one of {@link PUBLIC_ROUTES}.
 *
 * Tolerant in the directions that can only make a caller SAFER: a trailing slash,
 * letter case, and anything from the first `?` or `#` on are ignored. For the gate
 * that can only match pages that do not exist (Next routes are case-sensitive, so
 * `/Login` is the 404 page anyway); for `next` validation it rejects more.
 *
 * @param {*} pathname - A pathname: `router.pathname`, `window.location.pathname`, or the path part of a `next` value.
 * @returns {Boolean} True when the pathname is public. Anything that is not a non-empty string is not.
 */
export const isPublicRoute = (pathname) => {
    if (typeof pathname !== 'string' || !pathname) {
        return false;
    }
    let path = pathname;
    const cutAt = path.search(/[?#]/);
    if (cutAt !== -1) {
        path = path.slice(0, cutAt);
    }
    if (path.length > 1 && path.endsWith('/')) {
        path = path.slice(0, -1);
    }
    return PUBLIC_ROUTES.includes(path.toLowerCase());
};

/**
 * The query flags the token pages set when they hand over to /login, and the one
 * each means. `pages/login.js` renders a success Banner for each.
 *
 * Query strings, not state: `router.replace` with state would not survive a reload
 * of the sign-in page, and the person has just done the one thing (set a password)
 * after which a confusing screen costs the most.
 */
export const LOGIN_NOTICES = Object.freeze({
    SETUP_DONE: Object.freeze({ key: 'setup', value: 'done' }),
    INVITED: Object.freeze({ key: 'invited', value: '1' }),
    RESET_DONE: Object.freeze({ key: 'reset', value: 'done' })
});

/**
 * A `router.replace` target for /login carrying one notice flag.
 *
 * @param {{ key: String, value: String }} notice - One of {@link LOGIN_NOTICES}.
 * @returns {{ pathname: String, query: Object }} A Next URL object.
 */
export const loginWithNotice = (notice) => ({
    pathname: AUTH_ROUTES.LOGIN,
    query: { [notice.key]: notice.value }
});
