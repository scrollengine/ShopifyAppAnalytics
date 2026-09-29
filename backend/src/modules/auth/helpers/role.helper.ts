'use strict';

/**
 * Permission-set arithmetic and role resolution — the ONLY place a stored `(role_key,
 * custom_role_id)` pair becomes a permission list.
 *
 * `resolvePrincipal`, the invite flows (target = the invite's role), the role list and the
 * assignable-role filter all go through `resolveStoredRole`, so "what does this role grant" has one
 * spelling (recurring failure mode #1: two derivations of one fact).
 *
 * PURE: no I/O, no config, no clock. Every rule narrows: an unknown, owner-only or
 * prerequisite-less key read back from the database is dropped and reported, never honoured.
 */

import authConstants = require('../constants/auth.constants');
import permissionsConstants = require('../constants/permissions.constants');
import rolesConstants = require('../constants/roles.constants');
import identityHelper = require('./identity.helper');

import type {
    CustomRoleBody,
    CustomRoleValidation,
    PermissionCatalogueEntry,
    PermissionKey,
    ResolveStoredRoleInput,
    RoleAnomalies,
    RoleAssignmentValidation,
    RoleResolution
} from '../types/auth.types';

const { ROLE_KEYS, ROLE_PERMISSIONS_INPUT_MAX, AUTH_ERROR_CODES } = authConstants;
const { PERMISSION_CATALOGUE, OWNER_ONLY_PERMISSIONS, BASELINE_PERMISSION } = permissionsConstants;
const { BUILT_IN_ROLES, ASSIGNABLE_BUILT_IN_ROLE_KEYS, UNRESOLVED_ROLE_LABELS } = rolesConstants;

const CATALOGUE_BY_KEY: ReadonlyMap<string, PermissionCatalogueEntry> = new Map(
    PERMISSION_CATALOGUE.map((entry) => [entry.key, entry])
);

const EMPTY_PERMISSIONS: readonly string[] = Object.freeze([]);

/**
 * A short, loggable description of a stored value that failed a check.
 *
 * Never `String(value)` on a non-string: a hand-edited document can hold an object whose
 * `toString` is not a function, and `String()` would THROW inside principal resolution — turning a
 * bad role row into a failed request instead of a narrowed principal.
 *
 * @param value - The offending stored value.
 * @returns The string itself (capped at 64 characters), or `<type>` for anything else.
 */
const _describeForLog = (value: unknown): string => {
    if (typeof value === 'string') {
        return value.slice(0, 64);
    }
    return `<${value === null ? 'null' : typeof value}>`;
};

/**
 * Deduplicates and sorts (code-point order) into a new array.
 *
 * @param keys - Keys in any order, possibly repeated.
 * @returns A sorted array of distinct keys.
 */
const _sortedUnique = (keys: Iterable<string>): string[] => {
    return Array.from(new Set(keys)).sort();
};

/**
 * Every key in the set plus every key it transitively requires. Keys not in the catalogue are
 * ignored (neither kept nor expanded).
 *
 * @param keys - Permission keys.
 * @returns The closure, sorted.
 */
const permissionClosure = (keys: readonly string[]): string[] => {
    const closed = new Set<string>();
    const pending = keys.filter((key) => CATALOGUE_BY_KEY.has(key));
    while (pending.length > 0) {
        const key = pending.pop();
        if (key === undefined || closed.has(key)) {
            continue;
        }
        closed.add(key);
        const entry = CATALOGUE_BY_KEY.get(key);
        if (entry) {
            pending.push(...entry.requires);
        }
    }
    return _sortedUnique(closed);
};

/**
 * The prerequisites a set is missing: its closure minus the set itself. Empty ⇔ the set is closed
 * under `requires`.
 *
 * @param keys - Permission keys.
 * @returns The missing keys, sorted.
 */
const missingRequirements = (keys: readonly string[]): string[] => {
    const held = new Set(keys);
    return permissionClosure(keys).filter((key) => !held.has(key));
};

/**
 * Narrows a permission list READ FROM THE DATABASE to what this build will honour: catalogue keys
 * only, no owner-only key, and no key whose prerequisites are absent (iterated to a fixpoint, so
 * dropping `financials:read` also drops `merchants:read`). Without `apps:read` everything goes,
 * because every key requires it transitively.
 *
 * @param keys - The stored value. Not trusted to be an array of strings.
 * @returns `{ permissions }` sorted and deduplicated, and `{ dropped }` — what was not honoured.
 */
const sanitiseStoredPermissions = (keys: unknown): { permissions: string[]; dropped: string[] } => {
    if (!Array.isArray(keys)) {
        return { permissions: [], dropped: [] };
    }
    const dropped: string[] = [];
    const kept = new Set<string>();
    for (const key of keys) {
        if (typeof key !== 'string') {
            dropped.push(_describeForLog(key));
            continue;
        }
        if (!CATALOGUE_BY_KEY.has(key) || OWNER_ONLY_PERMISSIONS.includes(key)) {
            dropped.push(key.slice(0, 64));
            continue;
        }
        kept.add(key);
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const key of Array.from(kept)) {
            const entry = CATALOGUE_BY_KEY.get(key);
            const unmet = entry ? entry.requires.some((required) => !kept.has(required)) : true;
            if (unmet) {
                kept.delete(key);
                dropped.push(key);
                changed = true;
            }
        }
    }

    return { permissions: _sortedUnique(kept), dropped: _sortedUnique(dropped) };
};

/** Each STORABLE built-in (admin/analyst/viewer) with its permissions sorted and frozen, computed once. */
const STORABLE_BUILT_INS: ReadonlyMap<string, Pick<RoleResolution, 'role_key' | 'role_label' | 'permissions'>> = new Map(
    Object.values(BUILT_IN_ROLES)
        .filter((role) => ASSIGNABLE_BUILT_IN_ROLE_KEYS.includes(role.key))
        .map((role) => [role.key, {
            role_key: role.key,
            role_label: role.label,
            permissions: Object.freeze(_sortedUnique(role.permissions))
        }])
);

/**
 * Resolves a STORED role — never the owner, whose permissions come from the install pointer (see
 * `principal.helper`).
 *
 * - `admin` / `analyst` / `viewer` ⇒ the built-in set.
 * - `custom` ⇒ the role row's permissions, sanitised; the row must be present AND its `_id` must
 *   equal `custom_role_id` (a row for the wrong role is treated as missing).
 * - A missing custom role, or any other stored key (including a stray `'owner'`), ⇒ NO
 *   permissions. It never widens.
 *
 * @param input - The stored pair and the custom-role row read for it.
 * @param input.role_key - Stored `role_key`.
 * @param input.custom_role_id - Stored `custom_role_id`.
 * @param input.custom_role - The `gi_roles` row read by `custom_role_id`, or `null`.
 * @returns The role key, label, id and permissions (sorted, frozen), plus what was wrong.
 */
const resolveStoredRole = ({ role_key, custom_role_id, custom_role }: ResolveStoredRoleInput): RoleResolution => {
    const anomalies: RoleAnomalies = { unknown_role_key: null, missing_custom_role: false, dropped_permissions: [] };

    const builtIn = STORABLE_BUILT_INS.get(role_key);
    if (builtIn) {
        return {
            role_key: builtIn.role_key,
            role_label: builtIn.role_label,
            custom_role_id: null,
            permissions: builtIn.permissions,
            anomalies: anomalies
        };
    }

    if (role_key === ROLE_KEYS.CUSTOM) {
        const pointer = custom_role_id === null || custom_role_id === undefined ? null : String(custom_role_id);
        const matches = custom_role !== null && pointer !== null && String(custom_role._id) === pointer;
        if (!matches) {
            anomalies.missing_custom_role = true;
            return {
                role_key: ROLE_KEYS.CUSTOM,
                role_label: UNRESOLVED_ROLE_LABELS.MISSING_CUSTOM_ROLE,
                custom_role_id: pointer,
                permissions: EMPTY_PERMISSIONS,
                anomalies: anomalies
            };
        }
        const sanitised = sanitiseStoredPermissions(custom_role.permissions);
        anomalies.dropped_permissions = sanitised.dropped;
        return {
            role_key: ROLE_KEYS.CUSTOM,
            role_label: typeof custom_role.name === 'string' && custom_role.name ? custom_role.name : UNRESOLVED_ROLE_LABELS.MISSING_CUSTOM_ROLE,
            custom_role_id: pointer,
            permissions: Object.freeze(sanitised.permissions),
            anomalies: anomalies
        };
    }

    anomalies.unknown_role_key = _describeForLog(role_key);
    return {
        role_key: ROLE_KEYS.CUSTOM,
        role_label: UNRESOLVED_ROLE_LABELS.UNKNOWN_ROLE,
        custom_role_id: null,
        permissions: EMPTY_PERMISSIONS,
        anomalies: anomalies
    };
};

/**
 * Validates a custom role's body (spec §4 + A2). Checks run in field order and the first failure is
 * returned, naming the field and — for permission failures — the offending keys.
 *
 * Permissions must be: an array of strings (at most 64 entries before deduplication), every key in
 * the catalogue, no owner-only key, `apps:read` present, and closed under `requires`. Missing
 * prerequisites are REFUSED (listed in `keys`), not silently added: the editor auto-selects them,
 * so a request without them did not come from the editor.
 *
 * @param body - The unchecked request body.
 * @param body.name - Role name.
 * @param body.description - Optional description.
 * @param body.permissions - Array of catalogue keys.
 * @returns `{ ok: true, value }` ready to store, or `{ ok: false, field, reason, keys }`.
 */
const validateCustomRole = ({ name, description, permissions }: CustomRoleBody): CustomRoleValidation => {
    const nameCheck = identityHelper.validateRoleName(name);
    if (!nameCheck.ok) {
        return { ok: false, value: null, reason: nameCheck.reason, field: 'name', keys: [] };
    }

    const descriptionCheck = identityHelper.validateRoleDescription(description);
    if (!descriptionCheck.ok) {
        return { ok: false, value: null, reason: descriptionCheck.reason, field: 'description', keys: [] };
    }

    if (!Array.isArray(permissions) || permissions.length === 0) {
        return { ok: false, value: null, reason: 'Choose the permissions this role grants.', field: 'permissions', keys: [] };
    }
    if (permissions.length > ROLE_PERMISSIONS_INPUT_MAX) {
        return { ok: false, value: null, reason: 'Too many permissions in the request.', field: 'permissions', keys: [] };
    }
    const strings: string[] = [];
    for (const key of permissions) {
        if (typeof key !== 'string') {
            return { ok: false, value: null, reason: 'Every permission must be a permission key.', field: 'permissions', keys: [] };
        }
        strings.push(key);
    }
    const unique = _sortedUnique(strings);

    const unknown = unique.filter((key) => !CATALOGUE_BY_KEY.has(key));
    if (unknown.length > 0) {
        return {
            ok: false,
            value: null,
            reason: 'The request names permissions that do not exist.',
            field: 'permissions',
            keys: unknown.map((key) => key.slice(0, 64))
        };
    }

    const ownerOnly = unique.filter((key) => OWNER_ONLY_PERMISSIONS.includes(key));
    if (ownerOnly.length > 0) {
        return { ok: false, value: null, reason: 'Some permissions belong to the owner alone and cannot be granted.', field: 'permissions', keys: ownerOnly };
    }

    if (!unique.includes(BASELINE_PERMISSION)) {
        return { ok: false, value: null, reason: 'Every role must include viewing apps.', field: 'permissions', keys: [BASELINE_PERMISSION] };
    }

    const missing = missingRequirements(unique);
    if (missing.length > 0) {
        return { ok: false, value: null, reason: 'Some chosen permissions depend on others that are not selected.', field: 'permissions', keys: missing };
    }

    return {
        ok: true,
        value: {
            name: nameCheck.value.name,
            name_norm: nameCheck.value.name_norm,
            description: descriptionCheck.value,
            permissions: unique
        },
        reason: null,
        field: null,
        keys: []
    };
};

/**
 * Validates the role an invite or a role change names (spec A2) — ONE spelling for both, so the two
 * endpoints cannot disagree about what a well-formed assignment is.
 *
 *  - `role_key` must be a string naming an ASSIGNABLE built-in (`admin`, `analyst`, `viewer`) or
 *    `custom`. `owner` is refused here: ownership moves only through the CLI.
 *  - `custom_role_id` is present iff `role_key === 'custom'`. For a built-in it must be absent or
 *    `null` (stored as `null`); anything else is a 400, not silently ignored.
 *  - For `custom` it must be a string (400 otherwise) matching the 24-hex id shape (404 otherwise).
 *
 * Existence of the custom role, and the management rule, are the service's job.
 *
 * @param params0 - The unchecked request fields.
 * @param params0.role_key - Raw `role_key`.
 * @param params0.custom_role_id - Raw `custom_role_id` (may be absent).
 * @returns `{ ok: true, value: { role_key, custom_role_id } }`, or `{ ok: false, code, reason }`.
 */
const validateRoleAssignment = ({ role_key, custom_role_id }: { role_key: unknown; custom_role_id?: unknown }): RoleAssignmentValidation => {
    if (typeof role_key !== 'string') {
        return { ok: false, value: null, code: AUTH_ERROR_CODES.VALIDATION, reason: 'Choose a role.' };
    }
    if (role_key === ROLE_KEYS.CUSTOM) {
        if (typeof custom_role_id !== 'string') {
            return { ok: false, value: null, code: AUTH_ERROR_CODES.VALIDATION, reason: 'Choose which custom role to assign.' };
        }
        if (!identityHelper.isObjectIdString(custom_role_id)) {
            return { ok: false, value: null, code: AUTH_ERROR_CODES.NOT_FOUND, reason: 'That custom role does not exist.' };
        }
        return { ok: true, value: { role_key: ROLE_KEYS.CUSTOM, custom_role_id: custom_role_id }, code: null, reason: null };
    }
    const builtIn = ASSIGNABLE_BUILT_IN_ROLE_KEYS.find((key) => key === role_key);
    if (builtIn !== ROLE_KEYS.ADMIN && builtIn !== ROLE_KEYS.ANALYST && builtIn !== ROLE_KEYS.VIEWER) {
        return { ok: false, value: null, code: AUTH_ERROR_CODES.VALIDATION, reason: 'That role cannot be assigned.' };
    }
    if (custom_role_id !== undefined && custom_role_id !== null) {
        return { ok: false, value: null, code: AUTH_ERROR_CODES.VALIDATION, reason: 'A built-in role takes no custom role id.' };
    }
    return { ok: true, value: { role_key: builtIn, custom_role_id: null }, code: null, reason: null };
};

/**
 * Whether a value is a key of the permission catalogue. The route layer's `requirePermission(key)`
 * refuses at construction anything this rejects.
 *
 * @param value - Anything.
 * @returns True only for a catalogue key string.
 */
const isPermissionKey = (value: unknown): value is PermissionKey => {
    return typeof value === 'string' && CATALOGUE_BY_KEY.has(value);
};

export = {
    isPermissionKey,
    permissionClosure,
    missingRequirements,
    sanitiseStoredPermissions,
    resolveStoredRole,
    validateCustomRole,
    validateRoleAssignment
};
