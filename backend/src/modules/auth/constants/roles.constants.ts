'use strict';

/**
 * The built-in roles. They live in code, not in `gi_roles`, so they cannot be edited or deleted and
 * every install means the same thing by "Analyst".
 *
 * The permission sets nest strictly — viewer ⊂ analyst ⊂ admin ⊂ owner — which is what lets the
 * management rule ("only act on roles strictly below your own") read naturally for built-ins.
 * `test/permissionMap.test.js` (T9) asserts the nesting and that every `requires` is satisfied.
 */

import authVocab = require('../../../constants/authVocab.constants');
import permissionsConstants = require('./permissions.constants');

import type { BuiltInRoleDefinition } from '../types/auth.types';

const { ROLE_KEYS } = authVocab;
const { PERMISSIONS, ALL_PERMISSION_KEYS } = permissionsConstants;

const BUILT_IN_ROLES: Readonly<Record<'owner' | 'admin' | 'analyst' | 'viewer', BuiltInRoleDefinition>> = Object.freeze({
    /** Every key. NOT assignable: only setup, and the CLI `transfer-owner`, make an owner. */
    owner: Object.freeze({
        key: ROLE_KEYS.OWNER,
        label: 'Owner',
        description: 'Everything, including custom roles. Exactly one person; ownership moves only through the recovery CLI.',
        permissions: ALL_PERMISSION_KEYS,
        assignable: false
    }),
    /** Every key except `roles:manage`. */
    admin: Object.freeze({
        key: ROLE_KEYS.ADMIN,
        label: 'Admin',
        description: 'Everything except custom roles. Manages teammates whose role is strictly below Admin.',
        permissions: Object.freeze(ALL_PERMISSION_KEYS.filter((key) => key !== PERMISSIONS.ROLES_MANAGE)),
        assignable: true
    }),
    analyst: Object.freeze({
        key: ROLE_KEYS.ANALYST,
        label: 'Analyst',
        description: 'All dashboards including store names and money, sync health, and running the Partner sync. No billed scans, no configuration, no user management.',
        permissions: Object.freeze([
            PERMISSIONS.APPS_READ,
            PERMISSIONS.ANALYTICS_READ,
            PERMISSIONS.FINANCIALS_READ,
            PERMISSIONS.MERCHANTS_READ,
            PERMISSIONS.SYNC_READ,
            PERMISSIONS.SYNC_RUN
        ]),
        assignable: true
    }),
    viewer: Object.freeze({
        key: ROLE_KEYS.VIEWER,
        label: 'Viewer',
        description: 'All dashboards including store names and money. Read-only.',
        permissions: Object.freeze([
            PERMISSIONS.APPS_READ,
            PERMISSIONS.ANALYTICS_READ,
            PERMISSIONS.FINANCIALS_READ,
            PERMISSIONS.MERCHANTS_READ
        ]),
        assignable: true
    })
});

/** The built-in keys an invite or a role change may name. `owner` is never among them. */
const ASSIGNABLE_BUILT_IN_ROLE_KEYS: readonly string[] = Object.freeze([
    ROLE_KEYS.ADMIN,
    ROLE_KEYS.ANALYST,
    ROLE_KEYS.VIEWER
]);

/**
 * Custom role names that are refused (compared against the NFC + trim + lowercase `name_norm`), so
 * a custom role can never be mistaken for a built-in one on the users page or in an email.
 */
const RESERVED_ROLE_NAMES: readonly string[] = Object.freeze([
    ROLE_KEYS.OWNER,
    ROLE_KEYS.ADMIN,
    ROLE_KEYS.ANALYST,
    ROLE_KEYS.VIEWER
]);

/**
 * Labels for a stored role that cannot be resolved. The principal behind either label holds NO
 * permissions (fail narrow), so the label must not read like a working role.
 */
const UNRESOLVED_ROLE_LABELS = Object.freeze({
    /** `role_key: 'custom'` whose `gi_roles` row is gone or does not match `custom_role_id`. */
    MISSING_CUSTOM_ROLE: 'Removed role',
    /** A stored `role_key` this build does not know. */
    UNKNOWN_ROLE: 'Unknown role'
} as const);

export = {
    BUILT_IN_ROLES,
    ASSIGNABLE_BUILT_IN_ROLE_KEYS,
    RESERVED_ROLE_NAMES,
    UNRESOLVED_ROLE_LABELS
};
