'use strict';

/**
 * THE management rule (spec §5) — who may act on whom. The only definition; the services, the
 * `can_manage` flag on the users list and the assignable-role filter all call it.
 *
 *  - Nobody acts on themselves through the admin endpoints (`/api/account` is for that).
 *  - Nobody acts on the owner through the API (ownership moves only via the CLI).
 *  - No one hands out a role carrying an owner-only key.
 *  - The owner may act on any other user and assign any assignable role.
 *  - Anyone else needs `users:manage`, the target's permissions must be a STRICT subset of theirs,
 *    and so must any role being assigned or invited. Equal sets are refused: two admins cannot
 *    disable each other.
 *
 * PURE: no I/O, no config, no clock.
 */

import authConstants = require('../constants/auth.constants');
import permissionsConstants = require('../constants/permissions.constants');
import rolesConstants = require('../constants/roles.constants');
import roleHelper = require('./role.helper');

import type {
    AssignableRole,
    CustomRoleInput,
    ManagementDecision,
    ManagementInput,
    Principal
} from '../types/auth.types';

const { MANAGEMENT_BLOCK_REASONS, ROLE_KEYS } = authConstants;
const { PERMISSIONS, OWNER_ONLY_PERMISSIONS } = permissionsConstants;
const { ASSIGNABLE_BUILT_IN_ROLE_KEYS } = rolesConstants;

/**
 * Whether `subset` ⊊ `superset` as sets. A non-array on either side is "not a subset" (refuse).
 *
 * @param subset - The smaller set.
 * @param superset - The larger set.
 * @returns True only when every member of `subset` is in `superset` and `superset` has more distinct members.
 */
const _isStrictSubset = (subset: readonly string[], superset: readonly string[]): boolean => {
    if (!Array.isArray(subset) || !Array.isArray(superset)) {
        return false;
    }
    const inner = new Set(subset);
    const outer = new Set(superset);
    if (inner.size >= outer.size) {
        return false;
    }
    for (const key of inner) {
        if (!outer.has(key)) {
            return false;
        }
    }
    return true;
};

/**
 * Builds a refusal.
 *
 * @param reason - Which rule refused.
 * @returns `{ allowed: false, reason }`.
 */
const _refuse = (reason: ManagementDecision['reason']): ManagementDecision => {
    return { allowed: false, reason: reason };
};

/**
 * Evaluates the management rule for one action.
 *
 * Applies to: invite create / resend / revoke (target = the invite's role: `target_user_id: null`,
 * `target_permissions` = `new_permissions` = the role's permissions), role change, disable, enable,
 * sessions revoke and admin-triggered password reset.
 *
 * @param input - The action.
 * @param input.actor - The acting principal, re-loaded from the database.
 * @param input.target_is_owner - From `principal.helper#isOwnerUserId` for the target.
 * @param input.target_user_id - The target user's id, or `null` for an invite.
 * @param input.target_permissions - The target's current permissions.
 * @param input.new_permissions - The role being assigned/invited, when the action assigns one.
 * @returns `{ allowed: true, reason: null }` or `{ allowed: false, reason }` (a `MANAGEMENT_BLOCK_REASONS` value).
 */
const evaluateManagement = ({ actor, target_is_owner, target_user_id, target_permissions, new_permissions }: ManagementInput): ManagementDecision => {
    if (target_user_id !== null && target_user_id !== undefined && String(target_user_id) === String(actor.user_id)) {
        return _refuse(MANAGEMENT_BLOCK_REASONS.SELF);
    }
    if (target_is_owner !== false) {
        // Anything other than an explicit `false` is treated as "may be the owner" — refuse.
        return _refuse(MANAGEMENT_BLOCK_REASONS.TARGET_IS_OWNER);
    }
    const assigning = new_permissions !== null && new_permissions !== undefined;
    if (assigning && (!Array.isArray(new_permissions) || new_permissions.some((key) => OWNER_ONLY_PERMISSIONS.includes(key)))) {
        return _refuse(MANAGEMENT_BLOCK_REASONS.ROLE_NOT_ASSIGNABLE);
    }
    if (actor.is_owner === true) {
        return { allowed: true, reason: null };
    }
    if (!actor.permissions.includes(PERMISSIONS.USERS_MANAGE)) {
        return _refuse(MANAGEMENT_BLOCK_REASONS.MISSING_USERS_MANAGE);
    }
    if (!_isStrictSubset(target_permissions, actor.permissions)) {
        return _refuse(MANAGEMENT_BLOCK_REASONS.TARGET_NOT_BELOW_ACTOR);
    }
    if (assigning && !_isStrictSubset(new_permissions, actor.permissions)) {
        return _refuse(MANAGEMENT_BLOCK_REASONS.ROLE_NOT_BELOW_ACTOR);
    }
    return { allowed: true, reason: null };
};

/**
 * The roles an actor may assign or invite with — the list the UI offers, filtered by the same rule
 * as the action itself. Built-ins first (admin, analyst, viewer), then custom roles in the order
 * given. A custom role whose stored permissions resolve to nothing is omitted.
 *
 * @param actor - The acting principal.
 * @param customRoles - The `gi_roles` rows.
 * @returns The assignable roles with their resolved permissions.
 */
const assignableRolesFor = (actor: Principal, customRoles: readonly CustomRoleInput[]): AssignableRole[] => {
    const candidates: AssignableRole[] = [];

    for (const key of ASSIGNABLE_BUILT_IN_ROLE_KEYS) {
        const role = roleHelper.resolveStoredRole({ role_key: key, custom_role_id: null, custom_role: null });
        if (role.role_key === ROLE_KEYS.ADMIN || role.role_key === ROLE_KEYS.ANALYST || role.role_key === ROLE_KEYS.VIEWER) {
            candidates.push({ role_key: role.role_key, role_id: null, label: role.role_label, permissions: role.permissions });
        }
    }

    for (const customRole of Array.isArray(customRoles) ? customRoles : []) {
        const role = roleHelper.resolveStoredRole({
            role_key: ROLE_KEYS.CUSTOM,
            custom_role_id: customRole._id,
            custom_role: customRole
        });
        if (role.permissions.length > 0) {
            candidates.push({
                role_key: ROLE_KEYS.CUSTOM,
                role_id: role.custom_role_id,
                label: role.role_label,
                permissions: role.permissions
            });
        }
    }

    return candidates.filter((candidate) => {
        return evaluateManagement({
            actor: actor,
            target_is_owner: false,
            target_user_id: null,
            target_permissions: candidate.permissions,
            new_permissions: candidate.permissions
        }).allowed;
    });
};

export = {
    evaluateManagement,
    assignableRolesFor
};
