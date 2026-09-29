'use strict';

/**
 * The permission catalogue — every key a role can hold, in the order the role editor shows them.
 *
 *  FIXED IN CODE. Nothing reads permissions from the database except a custom role's key list, and
 * `resolvePrincipal` intersects that with this catalogue (unknown keys are dropped, never honoured).
 * A permission is never put into a JWT: it is resolved from the role on every request.
 *
 *  THE STRINGS ARE A CROSS-REPOSITORY CONTRACT. `frontend/utils/permissions.js` carries the same
 * key set (asserted by `test/permissionParity.test.js`), custom roles store them in `gi_roles`, and
 * every guarded route declares one of them. Renaming a key silently strips it from every custom role
 * that held it — change one only with a migration.
 *
 * DEPENDENCY-FREE at run time (the one import is a type, erased), so the route files, the helpers
 * and the tests can all read it.
 *
 * `requires` on each entry lists DIRECT prerequisites; `role.helper#permissionClosure` walks them
 * transitively. A custom role missing a prerequisite is refused at write time, and a stored role that
 * somehow lacks one has the dependent key dropped at read time — access only ever narrows.
 */

import type { PermissionCatalogueEntry } from '../types/auth.types';

const PERMISSIONS = Object.freeze({
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
} as const);

/**
 * The ordered catalogue. Descriptions are shown verbatim in the role editor, so each one says what
 * data the key exposes — in particular whether it names stores (`merchants:read`) or shows money
 * (`financials:read`), the two distinctions an owner actually cares about when scoping a role.
 */
const PERMISSION_CATALOGUE: readonly PermissionCatalogueEntry[] = Object.freeze([
    Object.freeze({
        key: PERMISSIONS.APPS_READ,
        label: 'View apps',
        group: 'Baseline',
        description: 'App name, sync watermarks and coverage gates. Every role must hold it.',
        requires: Object.freeze([])
    }),
    Object.freeze({
        key: PERMISSIONS.ANALYTICS_READ,
        label: 'View analytics',
        group: 'Data',
        description: 'Counts and rates: listing traffic, funnel steps, retention, time-to-paid, trial trend. No money, no store names.',
        requires: Object.freeze([PERMISSIONS.APPS_READ])
    }),
    Object.freeze({
        key: PERMISSIONS.FINANCIALS_READ,
        label: 'View financials',
        group: 'Data',
        description: 'Money aggregates: cash, MRR by plan, revenue by country. No store names.',
        requires: Object.freeze([PERMISSIONS.APPS_READ])
    }),
    Object.freeze({
        key: PERMISSIONS.MERCHANTS_READ,
        label: 'View merchants',
        group: 'Data',
        description: 'Anything that names a store: roster, detail, subscriptions, cohorts, churn lists, revenue movers.',
        requires: Object.freeze([PERMISSIONS.FINANCIALS_READ])
    }),
    Object.freeze({
        key: PERMISSIONS.APPS_MANAGE,
        label: 'Manage apps',
        group: 'Configuration',
        description: 'Register, edit and deactivate the partner app.',
        requires: Object.freeze([PERMISSIONS.APPS_READ])
    }),
    Object.freeze({
        key: PERMISSIONS.SYNC_READ,
        label: 'View sync',
        group: 'Operations',
        description: 'Sync health, the job history (payloads, error stacks) and who triggered each job.',
        requires: Object.freeze([PERMISSIONS.APPS_READ])
    }),
    Object.freeze({
        key: PERMISSIONS.SYNC_RUN,
        label: 'Run sync',
        group: 'Operations',
        description: 'Run the Partner sync and the smoke job; cancel a pending job.',
        requires: Object.freeze([PERMISSIONS.SYNC_READ])
    }),
    Object.freeze({
        key: PERMISSIONS.SYNC_RUN_BILLED,
        label: 'Run billed scans',
        group: 'Operations',
        description: 'Run BigQuery scans (billed to your GCP project), including the scan estimate.',
        requires: Object.freeze([PERMISSIONS.SYNC_READ])
    }),
    Object.freeze({
        key: PERMISSIONS.USERS_READ,
        label: 'View users',
        group: 'Administration',
        description: 'See teammates, invitations and roles.',
        requires: Object.freeze([PERMISSIONS.APPS_READ])
    }),
    Object.freeze({
        key: PERMISSIONS.USERS_MANAGE,
        label: 'Manage users',
        group: 'Administration',
        description: 'Invite, re-send or revoke invitations; change roles; disable or enable users; sign users out; send password-reset emails. Limited to roles strictly below your own.',
        requires: Object.freeze([PERMISSIONS.USERS_READ])
    }),
    Object.freeze({
        key: PERMISSIONS.ROLES_MANAGE,
        label: 'Manage roles',
        group: 'Administration',
        description: 'Create, edit and delete custom roles. Owner only — cannot be granted.',
        requires: Object.freeze([PERMISSIONS.USERS_READ])
    }),
    Object.freeze({
        key: PERMISSIONS.AUDIT_READ,
        label: 'View activity log',
        group: 'Administration',
        description: 'Read the security activity log.',
        requires: Object.freeze([PERMISSIONS.APPS_READ])
    })
]);

/** Every catalogue key, in catalogue order. The owner holds exactly this set. */
const ALL_PERMISSION_KEYS: readonly string[] = Object.freeze(PERMISSION_CATALOGUE.map((entry) => entry.key));

/**
 * Keys only the owner holds. Never grantable to a custom role (refused at write, dropped at read)
 * and absent from every assignable built-in role.
 */
const OWNER_ONLY_PERMISSIONS: readonly string[] = Object.freeze([PERMISSIONS.ROLES_MANAGE]);

/** The key every role must hold — the app list is what every page hangs off. */
const BASELINE_PERMISSION = PERMISSIONS.APPS_READ;

export = {
    PERMISSIONS,
    PERMISSION_CATALOGUE,
    ALL_PERMISSION_KEYS,
    OWNER_ONLY_PERMISSIONS,
    BASELINE_PERMISSION
};
