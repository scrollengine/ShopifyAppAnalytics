/**
 * =============================================================================
 *  The ten dashboard routes — ONE declaration, read by everyone who needs them.
 * =============================================================================
 *
 *  These paths used to live under a `/growth-intel` prefix, which made them cheap
 *  to recognise: anything starting with that string was a dashboard screen, and
 *  anything else was not. They are top-level now, so THAT TEST NO LONGER EXISTS —
 *  `/overview` and `/login` are the same shape, and no prefix separates them.
 *
 *  What replaces it is this allowlist. It is the only place the ten paths are
 *  written down, and four separate consumers read it rather than repeating it:
 *
 *    · `contexts/growthIntelContext.js` — decides whether to fetch the partner-app
 *      roster at all (see the below; this is the dangerous one);
 *    · `components/sideNavBar.js` — the `url` of every nav row and the predicate
 *      that highlights it;
 *    · `pages/overview/index.js` — the contents list the Overview renders;
 *    · `utils/permissions.js` — which permission opens each page.
 *
 *  WHY THE ROSTER GATE MATTERS MORE THAN IT LOOKS. The context fetches the
 *  partner-app list only on a dashboard route, deliberately, so `/` and `/login`
 *  do not pay for a request they never read. If this list stops recognising a
 *  route, that page does not error — it renders "No partner app is selected" and
 *  every figure on it disappears, silently. A route added to `pages/` and NOT
 *  added here is a screen that looks broken with nothing in the console.
 *
 *  ⚠️ ADD A PAGE, ADD IT HERE. The directory under `pages/` is what Next routes;
 *  this file is what the app RECOGNISES. They are two lists and only one of them
 *  is enforced by the framework. A new page ALSO needs its entry in
 *  `PAGE_PERMISSIONS` (`utils/permissions.js`): the page gate in `_app.js` is
 *  default-deny, so a page missing there renders "Restricted" for every role.
 *
 *  ⚠️ ADMIN ROUTES ARE DELIBERATELY SEPARATE. `/settings/users` and `/account`
 *  live in `ADMIN_ROUTES` below, NOT in `DASHBOARD_ROUTES`. They are not scoped
 *  by a partner app, so they must not open the roster gate: putting them in the
 *  map below would fetch the partner-app list on every visit to a screen that
 *  never reads it, and draw the partner-app picker in the nav over a page it
 *  does not scope.
 *
 *  ── ⚠️ A TAB IS NOT A ROUTE, AND MUST NOT BE ADDED HERE ─────────────────────
 *  `/revenue` carries three views behind one path (see `REVENUE_VIEWS` below).
 *  They are QUERY STRINGS on one route, not routes, and the distinction is what
 *  keeps every consumer above correct without knowing about them: `router.pathname`
 *  is `/revenue` on all three, so the roster gate opens once and the nav row
 *  lights once. Adding `'/revenue?view=churn'` to the map below would put a query
 *  string through `isRouteSelected`, which compares pathnames — it would never
 *  match anything, and the roster gate would silently be the thing that broke.
 * =============================================================================
 */

/**
 * Every dashboard screen, in the order the side nav lists them.
 *
 * The two Setup screens come last because that is where the nav puts them, and
 * because the order is what `pages/overview/index.js` renders its contents list in.
 *
 * ── WHY THERE ARE TEN AND NOT TWELVE ────────────────────────────────────────
 * `/countries` and `/revenue-churn` were their own nav rows and their own pages.
 * They are TABS of `/revenue` now — one nav row, one date control, three views —
 * so they are no longer routes and are not declared here. The old paths still
 * resolve: `next.config.js` redirects each to its tab, because bookmarks exist.
 * ⚠️ Anything that used to link to them must go through {@link revenueViewHref},
 * NOT through a redirect: a link that costs a 307 and a second request is a link
 * that will one day be pointed at a redirect we have removed.
 */
export const DASHBOARD_ROUTES = Object.freeze({
    // Performance — the seven screens scoped by the partner-app picker, plus the Overview.
    OVERVIEW: '/overview',
    FUNNEL: '/funnel',
    TRAFFIC_SOURCES: '/traffic-sources',
    TRIAL_FUNNEL: '/trial-funnel',
    LOGO_CHURN: '/logo-churn',
    STORES: '/stores',
    SUBSCRIPTIONS: '/subscriptions',
    REVENUE: '/revenue',
    // Setup — configure and feed the dataset the rest read.
    APPS: '/apps',
    SYNC: '/sync'
});

/** The same ten as a list, for the allowlist tests below. */
export const DASHBOARD_ROUTE_PATHS = Object.freeze(Object.values(DASHBOARD_ROUTES));

/**
 * The parent of every other dashboard screen, and the first one the nav lists.
 *
 * ⚠️ NOT "WHERE A SIGNED-IN USER LANDS" ANY MORE. The Overview needs
 * `financials:read`, which not every role holds, so a fixed landing screen would
 * open on "Restricted" for some of them. `pages/index.js` sends people to
 * `landingRouteFor(permissions)` in `utils/permissions.js` instead — the first
 * screen in nav order this user can open.
 */
export const DASHBOARD_HOME = DASHBOARD_ROUTES.OVERVIEW;

/**
 * The screens that are NOT dashboard screens: not scoped by a partner app, not in
 * `DASHBOARD_ROUTES`, and never a reason to fetch the partner-app roster. See the
 * file header on why they must stay out of the map above.
 *
 * `/account` is every signed-in user's own page and needs no permission.
 * `/settings/users` needs `users:read` (see `PAGE_PERMISSIONS`).
 */
export const ADMIN_ROUTES = Object.freeze({
    USERS: '/settings/users',
    ACCOUNT: '/account'
});

/**
 * =============================================================================
 *  The three views of `/revenue`, and the one way to link to them.
 * =============================================================================
 *
 *  Revenue, By country and Churn were three nav rows opening three pages. They
 *  are one page with a Polaris `Tabs` strip now, and the selected view lives in
 *  the URL rather than in `useState` — which is the whole reason these constants
 *  exist rather than three literals inside the page.
 *
 *  ── WHY THE URL AND NOT LOCAL STATE ─────────────────────────────────────────
 *  `pages/funnel/index.js` keeps its tab in `useState(0)` and is right to:
 *  nothing links to a funnel tab. Two things link to these — the Overview's
 *  contents cards, and every bookmark of the old `/countries` and `/revenue-churn`
 *  paths, which `next.config.js` now redirects HERE. A tab in local state cannot
 *  be the target of a redirect, so those bookmarks would all land on the Revenue
 *  view and the reader would have to find their way back to the screen they
 *  actually asked for. It also makes a view shareable, which is what an analytics
 *  screen is for.
 * =============================================================================
 */

/**
 * The `?view=` values `/revenue` understands.
 *
 * ⚠️ THESE STRINGS ARE IN PEOPLE'S URLS the moment this ships — the redirects in
 * `next.config.js` write them into the address bar. Renaming one silently breaks
 * every link that was shared in the meantime, and the breakage is invisible: an
 * unrecognised view falls back to the default, so the reader gets a real screen
 * showing the wrong thing rather than an error.
 */
export const REVENUE_VIEWS = Object.freeze({
    REVENUE: 'revenue',
    COUNTRIES: 'countries',
    CHURN: 'churn'
});

/** The tab order, left to right. The page builds its `Tabs` strip from this. */
export const REVENUE_VIEW_ORDER = Object.freeze([
    REVENUE_VIEWS.REVENUE,
    REVENUE_VIEWS.COUNTRIES,
    REVENUE_VIEWS.CHURN
]);

/**
 * What `/revenue` opens on with no `?view=`.
 *
 * The owner's requirement, in one constant: clicking Revenue in the nav opens the
 * Revenue view DIRECTLY — no chooser screen, no extra click.
 */
export const DEFAULT_REVENUE_VIEW = REVENUE_VIEWS.REVENUE;

/**
 * Resolve a raw `router.query.view` to one of the three views.
 *
 * EVERYTHING THAT IS NOT EXACTLY ONE OF THE THREE BECOMES THE DEFAULT, and that
 * is deliberate rather than lax. `router.query.view` is `String | String[] |
 * undefined` — an array for `?view=a&view=b`, undefined before `router.isReady`,
 * and any string at all for a hand-typed or truncated URL. The alternatives are
 * both worse than falling back: an index derived from an unknown value is `-1`,
 * which renders a tab strip with NOTHING selected and NO panel beneath it, and a
 * thrown error takes the page down over a query string. A wrong-but-real screen
 * is recoverable in one click; a blank one reads as a broken build.
 *
 * @param {String|Array|undefined} view - `router.query.view`, exactly as Next hands it over.
 * @returns {String} One of `REVENUE_VIEWS`.
 */
export const normaliseRevenueView = (view) => {
    if (typeof view !== 'string') {
        return DEFAULT_REVENUE_VIEW;
    }
    if (REVENUE_VIEW_ORDER.includes(view)) {
        return view;
    }
    return DEFAULT_REVENUE_VIEW;
};

/**
 * The href for one view of the Revenue page.
 *
 * ⚠️ THE DEFAULT VIEW GETS A BARE `/revenue`, WITH NO QUERY STRING. `/revenue` and
 * `/revenue?view=revenue` would be two URLs for one screen — the nav row links to
 * the first and the tab strip would write the second, so the row would stop
 * looking selected to anyone comparing the address bar, and every share of the
 * default view would carry a parameter that means "the default". One canonical
 * URL per view, and the shortest one is the one people land on.
 *
 * Values are taken through {@link normaliseRevenueView} first, so this can never
 * emit a link to a view the page does not have.
 *
 * @param {String} view - One of `REVENUE_VIEWS`.
 * @returns {String} A path this app can `router.push`.
 */
export const revenueViewHref = (view) => {
    const resolved = normaliseRevenueView(view);
    if (resolved === DEFAULT_REVENUE_VIEW) {
        return DASHBOARD_ROUTES.REVENUE;
    }
    return `${DASHBOARD_ROUTES.REVENUE}?view=${resolved}`;
};

/**
 * The `?view=` values `/settings/users` understands — the same pattern as
 * `REVENUE_VIEWS`, for the same reasons: a tab in the URL can be linked to,
 * bookmarked and shared, and a tab in `useState` cannot.
 *
 * ⚠️ THESE STRINGS BECOME PEOPLE'S URLS. Renaming one silently lands every shared
 * link on the default tab.
 *
 * Which tabs a given user may OPEN is not decided here: Activity needs
 * `audit:read`, and the page itself filters the strip. This file only knows which
 * views exist.
 */
export const USERS_VIEWS = Object.freeze({
    MEMBERS: 'members',
    INVITES: 'invites',
    ROLES: 'roles',
    ACTIVITY: 'activity'
});

/** The tab order, left to right. */
export const USERS_VIEW_ORDER = Object.freeze([
    USERS_VIEWS.MEMBERS,
    USERS_VIEWS.INVITES,
    USERS_VIEWS.ROLES,
    USERS_VIEWS.ACTIVITY
]);

/** What `/settings/users` opens on with no `?view=`. */
export const DEFAULT_USERS_VIEW = USERS_VIEWS.MEMBERS;

/**
 * Resolve a raw `router.query.view` to one of the Users views. Anything that is
 * not exactly one of them becomes the default, for the reasons given on
 * {@link normaliseRevenueView}.
 *
 * @param {String|Array|undefined} view - `router.query.view`, exactly as Next hands it over.
 * @returns {String} One of `USERS_VIEWS`.
 */
export const normaliseUsersView = (view) => {
    if (typeof view !== 'string') {
        return DEFAULT_USERS_VIEW;
    }
    if (USERS_VIEW_ORDER.includes(view)) {
        return view;
    }
    return DEFAULT_USERS_VIEW;
};

/**
 * The href for one view of the Users page. The default view gets a bare
 * `/settings/users` — one canonical URL per view, as {@link revenueViewHref}
 * explains.
 *
 * @param {String} view - One of `USERS_VIEWS`.
 * @returns {String} A path this app can `router.push`.
 */
export const usersViewHref = (view) => {
    const resolved = normaliseUsersView(view);
    if (resolved === DEFAULT_USERS_VIEW) {
        return ADMIN_ROUTES.USERS;
    }
    return `${ADMIN_ROUTES.USERS}?view=${resolved}`;
};

/**
 * Is `pathname` this route, or a page nested under it?
 *
 * THE TRAILING SLASH IS THE WHOLE POINT, and it is not decoration.
 * `'/revenue-churn'.startsWith('/revenue')` is TRUE, so a bare prefix test lit
 * the Revenue nav row up while you were reading Revenue Churn. That particular
 * collision is gone — `/revenue-churn` is a redirect source now and never a
 * `router.pathname` — but the rule is not: requiring `route` exactly, or `route`
 * followed by a SEPARATOR, keeps sibling routes that share a word apart while
 * still matching a real child route such as a future `/subscriptions/[key]`. The
 * next `/stores-archive` gets it for free.
 *
 * Written once here rather than per nav row, because the row that gets it wrong
 * is always the row nobody re-read.
 *
 * ⚠️ IT COMPARES PATHNAMES, NEVER URLS. `/revenue?view=churn` is not a pathname —
 * `router.pathname` is `/revenue` on every tab, which is exactly why one nav row
 * lights for all three views with no special case anywhere.
 *
 * @param {String} route - One of `DASHBOARD_ROUTES` or `ADMIN_ROUTES`.
 * @param {String} pathname - `router.pathname` (the PATTERN, so `/subscriptions/[key]`, not the filled-in URL).
 * @returns {Boolean}
 */
export const isRouteSelected = (route, pathname) => {
    if (typeof pathname !== 'string' || !pathname) return false;
    return pathname === route || pathname.startsWith(`${route}/`);
};

/**
 * Is this pathname one of the dashboard screens?
 *
 * The replacement for the old `pathname.startsWith('/growth-intel')`. `/`, `/login`,
 * `/404` and `/_error` are all outside the allowlist and answer false, which is what
 * keeps the roster fetch off the pages that never read it.
 *
 * @param {String} pathname - `router.pathname`.
 * @returns {Boolean}
 */
export const isDashboardRoute = (pathname) => (
    DASHBOARD_ROUTE_PATHS.some((route) => isRouteSelected(route, pathname))
);
