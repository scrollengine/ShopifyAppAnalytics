// ⚠️ The `.js` extension is deliberate. `backend/test/permissionParity.test.js` loads this file
// straight into Node, whose ESM resolver does not guess extensions the way webpack does. Drop it and
// the parity test cannot load the module the dashboard is built from.
import { ADMIN_ROUTES, DASHBOARD_ROUTE_PATHS, DASHBOARD_ROUTES, isRouteSelected } from './dashboardRoutes.js';

/**
 * =============================================================================
 *  Permissions, as the dashboard knows them — a COPY of the backend's catalogue.
 * =============================================================================
 *
 *  ⚠️ A CROSS-REPOSITORY STRING CONTRACT. The authority is
 *  `backend/src/modules/auth/constants/permissions.constants.ts`, and every key
 *  below must be spelled exactly as it is there. Nothing at build time checks
 *  that: a typo here compiles, lints and renders, and the result is a nav row
 *  hidden from everybody or a button that is never enabled.
 *  `backend/test/permissionParity.test.js` pins it instead — the key set here
 *  must EQUAL the backend's, so must `OWNER_ONLY_PERMISSIONS`, `PAGE_PERMISSIONS`
 *  may only name catalogue keys, and `AUDIT_ACTION_LABELS` must cover exactly the
 *  backend's `AUDIT_ACTIONS`. Change
 *  the backend catalogue and this file in the same commit, or that test fails.
 *
 *  ── NOTHING HERE IS A SECURITY BOUNDARY ─────────────────────────────────────
 *  Every route re-reads the caller's role from the database and answers 403 for
 *  a permission they do not hold. What this file decides is only what the UI
 *  OFFERS: which nav rows are drawn, which page renders "Restricted" instead of
 *  mounting, which buttons are disabled with a reason. Hiding a button is a
 *  courtesy to the reader, never the reason they cannot press it.
 *
 *  ── THE ONE RULE FOR PAGES ──────────────────────────────────────────────────
 *  A page is visible when the user holds ANY of its listed keys, because most
 *  pages have sections that need different keys (the Funnel reads counts, money
 *  and store names) and a section the user cannot read renders its own
 *  "Restricted" banner. A page listing NO keys is open to every signed-in user.
 *  A page that is not listed at all is CLOSED — see `canViewPage`.
 * =============================================================================
 */

/** Every permission key. Same names and values as the backend's `PERMISSIONS`. */
export const PERMISSIONS = Object.freeze({
    APPS_READ: 'apps:read',
    ANALYTICS_READ: 'analytics:read',
    FINANCIALS_READ: 'financials:read',
    MERCHANTS_READ: 'merchants:read',
    APPS_MANAGE: 'apps:manage',
    SYNC_READ: 'sync:read',
    SYNC_RUN: 'sync:run',
    SYNC_RUN_BILLED: 'sync:run_billed',
    USERS_READ: 'users:read',
    USERS_MANAGE: 'users:manage',
    ROLES_MANAGE: 'roles:manage',
    AUDIT_READ: 'audit:read'
});

/** The twelve keys as a list, for membership tests. */
export const PERMISSION_KEYS = Object.freeze(Object.values(PERMISSIONS));

/**
 * Keys only the owner holds and no custom role can be granted — the backend's
 * `OWNER_ONLY_PERMISSIONS`. `GET /api/roles` sends the whole catalogue with no owner-only marker,
 * so this list is the only thing that keeps the role editor from offering a key the server refuses.
 */
export const OWNER_ONLY_PERMISSIONS = Object.freeze([PERMISSIONS.ROLES_MANAGE]);

/**
 * What each key is called on screen.
 *
 * Written to complete the sentence "your role does not include …", which is where most of them
 * appear. The role editor on the Users page shows the backend's own catalogue (label, group and
 * description from `GET /api/roles`) rather than these, because that is the copy the backend
 * enforces; these are for the places that have no catalogue in hand.
 */
export const PERMISSION_LABELS = Object.freeze({
    [PERMISSIONS.APPS_READ]: 'partner app basics',
    [PERMISSIONS.ANALYTICS_READ]: 'analytics (counts and rates)',
    [PERMISSIONS.FINANCIALS_READ]: 'financials (money totals)',
    [PERMISSIONS.MERCHANTS_READ]: 'merchant details (store names)',
    [PERMISSIONS.APPS_MANAGE]: 'partner app management',
    [PERMISSIONS.SYNC_READ]: 'sync status and history',
    [PERMISSIONS.SYNC_RUN]: 'running syncs',
    [PERMISSIONS.SYNC_RUN_BILLED]: 'running BigQuery scans (billed to your GCP project)',
    [PERMISSIONS.USERS_READ]: 'viewing teammates',
    [PERMISSIONS.USERS_MANAGE]: 'managing teammates',
    [PERMISSIONS.ROLES_MANAGE]: 'managing custom roles',
    [PERMISSIONS.AUDIT_READ]: 'the security activity log'
});

/**
 * The on-screen name of a permission key.
 *
 * Falls back to the raw key rather than to a blank: a key this copy does not know (the backend
 * gained one) still says WHICH permission is missing, which is the whole content of the sentence.
 *
 * @param {String} key - A permission key.
 * @returns {String} Its label, the key itself, or a generic phrase when there is no key at all.
 */
export const permissionLabel = (key) => {
    if (typeof key !== 'string' || !key) {
        return 'the permission this needs';
    }
    return PERMISSION_LABELS[key] || key;
};

/**
 * Which permission opens each page. A page is visible when the user holds ANY listed key.
 *
 * Keyed by route PATH (the same strings `utils/dashboardRoutes.js` declares), in nav order.
 *
 * ⚠️ ADD A PAGE, ADD IT HERE. `canViewPage` is default-deny: a page missing from this map renders
 * "Restricted" for every role, including the owner. That is loud on purpose — the alternative, a new
 * page open to everyone until somebody remembers to list it, fails silently in the wrong direction.
 */
export const PAGE_PERMISSIONS = Object.freeze({
    [DASHBOARD_ROUTES.OVERVIEW]: Object.freeze([PERMISSIONS.FINANCIALS_READ]),
    [DASHBOARD_ROUTES.FUNNEL]: Object.freeze([
        PERMISSIONS.ANALYTICS_READ,
        PERMISSIONS.FINANCIALS_READ,
        PERMISSIONS.MERCHANTS_READ
    ]),
    [DASHBOARD_ROUTES.TRAFFIC_SOURCES]: Object.freeze([PERMISSIONS.ANALYTICS_READ]),
    [DASHBOARD_ROUTES.TRIAL_FUNNEL]: Object.freeze([PERMISSIONS.ANALYTICS_READ, PERMISSIONS.MERCHANTS_READ]),
    [DASHBOARD_ROUTES.LOGO_CHURN]: Object.freeze([PERMISSIONS.MERCHANTS_READ]),
    [DASHBOARD_ROUTES.STORES]: Object.freeze([PERMISSIONS.MERCHANTS_READ]),
    [DASHBOARD_ROUTES.SUBSCRIPTIONS]: Object.freeze([PERMISSIONS.MERCHANTS_READ]),
    [DASHBOARD_ROUTES.REVENUE]: Object.freeze([PERMISSIONS.FINANCIALS_READ, PERMISSIONS.MERCHANTS_READ]),
    [DASHBOARD_ROUTES.APPS]: Object.freeze([PERMISSIONS.APPS_READ]),
    [DASHBOARD_ROUTES.SYNC]: Object.freeze([PERMISSIONS.SYNC_READ]),
    [ADMIN_ROUTES.USERS]: Object.freeze([PERMISSIONS.USERS_READ]),
    [ADMIN_ROUTES.ACCOUNT]: Object.freeze([])
});

/**
 * Paths that are neither public nor a page with content of their own, so they are open to every
 * signed-in user without an entry above. `/` renders nothing and forwards to `landingRouteFor`.
 */
const UNGATED_PATHS = Object.freeze(['/']);

/**
 * The order `landingRouteFor` tries pages in: the nav's order, then the admin screens.
 * `/account` is last and needs nothing, which is what makes the answer never null.
 */
const LANDING_ORDER = Object.freeze([...DASHBOARD_ROUTE_PATHS, ADMIN_ROUTES.USERS, ADMIN_ROUTES.ACCOUNT]);

/**
 * Whether `permissions` holds at least one of `keys`.
 *
 * @param {Array<String>} permissions - The signed-in user's keys.
 * @param {Array<String>} keys - Keys, any one of which suffices.
 * @returns {Boolean} False for anything that is not an array — no answer is never a grant.
 */
export const holdsAny = (permissions, keys) => {
    if (!Array.isArray(permissions) || !Array.isArray(keys)) {
        return false;
    }
    return keys.some((key) => permissions.includes(key));
};

/**
 * The permission list that governs a pathname, or null when the page is not registered.
 *
 * The LONGEST matching route wins, so a nested page registered under its own path (a future
 * `/settings/users/[id]`, say) is judged by its own entry rather than its parent's. A nested page
 * with no entry of its own inherits the parent's, through the same separator rule the nav uses.
 *
 * @param {String} pathname - `router.pathname`.
 * @returns {Array<String>|null} The keys, `[]` for "every signed-in user", or null for unknown.
 */
export const pagePermissionsFor = (pathname) => {
    let matched = null;
    Object.keys(PAGE_PERMISSIONS).forEach((route) => {
        if (!isRouteSelected(route, pathname)) {
            return;
        }
        if (matched === null || route.length > matched.length) {
            matched = route;
        }
    });
    if (matched === null) {
        return null;
    }
    return PAGE_PERMISSIONS[matched];
};

/**
 * Whether a signed-in user with `permissions` may open `pathname`.
 *
 * DEFAULT-DENY: a pathname with no entry in `PAGE_PERMISSIONS` (and not `/`) answers false. Public
 * pages (`/login`, the token pages, `/404`) never reach this — `_app.js` checks `isPublicRoute`
 * first — so an unknown path here really is a page somebody forgot to register.
 *
 * @param {Array<String>} permissions - The signed-in user's keys.
 * @param {String} pathname - `router.pathname` (the pattern, never a URL with a query string).
 * @returns {Boolean}
 */
export const canViewPage = (permissions, pathname) => {
    if (typeof pathname !== 'string' || !pathname) {
        return false;
    }
    if (UNGATED_PATHS.includes(pathname)) {
        return true;
    }
    const required = pagePermissionsFor(pathname);
    if (required === null) {
        return false;
    }
    if (required.length === 0) {
        return true;
    }
    return holdsAny(permissions, required);
};

/**
 * Where a signed-in user should land: the first screen, in nav order, that they can open.
 *
 * NEVER NULL. Every built-in role holds `apps:read`, which opens `/apps`; and a user whose
 * permissions came back EMPTY (a custom role that was deleted from under them) still gets
 * `/account`, which needs nothing. A null here would leave `/` rendering nothing forever.
 *
 * @param {Array<String>} permissions - The signed-in user's keys.
 * @returns {String} A route path.
 */
export const landingRouteFor = (permissions) => {
    const found = LANDING_ORDER.find((route) => canViewPage(permissions, route));
    return found || ADMIN_ROUTES.ACCOUNT;
};

/**
 * Which permission starts a sync of each job type — the backend's route table for `POST /api/sync/*`.
 *
 * BigQuery scans bill the operator's GCP project, so they are their own key; the Partner API sync
 * and the smoke job are not billed. The attribution dry run ("Estimate scan") is a request to the
 * same billed route with `dry_run`, so it needs the billed key too.
 */
const SYNC_TRIGGER_PERMISSIONS = Object.freeze({
    PARTNER_SYNC: PERMISSIONS.SYNC_RUN,
    DUMMY: PERMISSIONS.SYNC_RUN,
    BIGQUERY_SYNC: PERMISSIONS.SYNC_RUN_BILLED,
    INSTALL_ATTRIBUTION_SYNC: PERMISSIONS.SYNC_RUN_BILLED
});

/**
 * The permission needed to start a job of this type.
 *
 * An unlisted type gets the STRICTER key. A trigger this copy has not heard of is likelier to be a new
 * scan than a new free job, and a button wrongly disabled with a reason is recoverable; a button
 * wrongly offered answers 403 on the click.
 *
 * @param {String} jobType - A sync job-type literal, e.g. 'PARTNER_SYNC'.
 * @returns {String} A permission key.
 */
export const syncTriggerPermissionFor = (jobType) => SYNC_TRIGGER_PERMISSIONS[jobType] || PERMISSIONS.SYNC_RUN_BILLED;

/** The `error.code` the backend puts on every 403 (`apiResponse.forbiddenResponse`). */
export const FORBIDDEN_CODE = 'FORBIDDEN';

/**
 * Whether a service response is the backend's 403 envelope, `{ status: false, error: { code:
 * 'FORBIDDEN', permission } }`.
 *
 * The ONE test for it. `dataState.js`, `ManualSyncButton` and `PartnerAppForm` all ask this question
 * and must not each spell the answer — two spellings of one decode is how one of them drifts.
 *
 * @param {Object} resp - A response envelope handed to a service callback or promise.
 * @returns {Boolean}
 */
export const isForbiddenResponse = (resp) => Boolean(
    resp
    && typeof resp === 'object'
    && resp.error
    && typeof resp.error === 'object'
    && resp.error.code === FORBIDDEN_CODE
);

/**
 * The permission key a 403 names, or null when it names none.
 *
 * @param {Object} resp - A response envelope already known to be forbidden.
 * @returns {String|null}
 */
export const forbiddenPermissionOf = (resp) => {
    if (!isForbiddenResponse(resp)) {
        return null;
    }
    const key = resp.error.permission;
    if (typeof key !== 'string' || !key) {
        return null;
    }
    return key;
};

/**
 * Human copy for every audit action the backend records (`AUDIT_ACTIONS` in
 * `backend/src/modules/auth/constants/audit.constants.ts`). Pinned to that list by the parity test.
 *
 * Past tense, and worded for what the ROW proves rather than what the user hoped for: an invitation
 * row records that one was created and handed to the mail server, never that it was delivered, and
 * its `email_status` detail says whether the server accepted it.
 */
export const AUDIT_ACTION_LABELS = Object.freeze({
    SETUP_REQUESTED: 'Setup verification requested',
    SETUP_COMPLETED: 'Setup completed and owner account created',
    SETUP_RECONCILED: 'Owner account finished at startup',
    LEGACY_OPERATORS_MARKED: 'Legacy operator accounts marked',
    LOGIN_SUCCEEDED: 'Signed in',
    LOGIN_FAILED: 'Sign-in failed',
    LOGOUT: 'Signed out',
    PASSWORD_RESET_REQUESTED: 'Password reset requested',
    PASSWORD_RESET_SENT_BY_ADMIN: 'Password reset issued by an admin',
    PASSWORD_RESET_COMPLETED: 'Password reset completed',
    PASSWORD_CHANGED: 'Password changed',
    SESSIONS_SELF_REVOKED: 'Signed out their other sessions',
    ACCOUNT_NAME_CHANGED: 'Changed their name',
    INVITE_CREATED: 'Invitation created',
    INVITE_RESENT: 'Invitation resent',
    INVITE_REVOKED: 'Invitation revoked',
    INVITE_ACCEPTED: 'Invitation accepted',
    USER_ROLE_CHANGED: 'Role changed',
    USER_DISABLED: 'User disabled',
    USER_ENABLED: 'User enabled',
    USER_SESSIONS_REVOKED: 'User signed out everywhere',
    ROLE_CREATED: 'Custom role created',
    ROLE_UPDATED: 'Custom role edited',
    ROLE_DELETED: 'Custom role deleted',
    OWNERSHIP_TRANSFERRED: 'Ownership transferred (command line)',
    OWNER_REPAIRED: 'Owner account repaired (command line)',
    CLI_SETUP_LINK_ISSUED: 'Setup link issued (command line)',
    CLI_RESET_LINK_ISSUED: 'Password reset link issued (command line)',
    CLI_SESSIONS_REVOKED: 'Sessions revoked (command line)',
    CLI_USER_ENABLED: 'User enabled (command line)'
});

/**
 * The on-screen name of an audit action. An action this copy does not know is shown by its raw key
 * rather than dropped: an activity log that hides rows it cannot label is not a log.
 *
 * @param {String} action - An `AUDIT_ACTIONS` key.
 * @returns {String}
 */
export const auditActionLabel = (action) => {
    if (typeof action !== 'string' || !action) {
        return 'Unknown action';
    }
    return AUDIT_ACTION_LABELS[action] || action;
};
