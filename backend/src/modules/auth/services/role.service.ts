'use strict';

/**
 * ============================================================================
 *  ROLES — the built-in roles (read-only) and the owner's custom roles
 * ============================================================================
 *
 *  Built-in roles live in code (`roles.constants`); only custom roles are
 *  stored. What any role GRANTS is decided by `role.helper#resolveStoredRole`
 *  alone — unknown, owner-only and prerequisite-less keys are dropped, never
 *  honoured — so the list here, the principal and the invite check agree.
 *
 *  Custom-role writes need `roles:manage`, which only the owner can hold (it is
 *  owner-only and never grantable). Editing a role's permissions can take away
 *  what its holders may grant, so their outstanding invites — and invites that
 *  name the role — are re-checked and revoked where the rule now refuses them
 *  (spec A13).
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import authConstants = require('../constants/auth.constants');
import auditConstants = require('../constants/audit.constants');
import permissionsConstants = require('../constants/permissions.constants');
import rolesConstants = require('../constants/roles.constants');
import identityHelper = require('../helpers/identity.helper');
import roleHelper = require('../helpers/role.helper');
import inviteHelper = require('../helpers/invite.helper');
import principalHelper = require('../helpers/principal.helper');
import managementHelper = require('../helpers/management.helper');
import datastoreErrorHelper = require('../helpers/datastoreError.helper');
import requestContextHelper = require('../helpers/requestContext.helper');
import serviceResultHelper = require('../helpers/serviceResult.helper');
import userRepository = require('../repositories/user.repository');
import roleRepository = require('../repositories/role.repository');
import inviteRepository = require('../repositories/invite.repository');
import principalService = require('./principal.service');
import inviteService = require('./invite.service');
import auditService = require('./audit.service');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type { InviteDoc, RoleDoc, SystemStateDoc } from '../../shared/types/entity.types';
import type {
    CustomRoleParams,
    Principal,
    RoleDeleteResult,
    RoleIdParams,
    RoleMutationResult,
    RoleView,
    UpdateCustomRoleParams
} from '../types/auth.types';

const {
    AUTH_MESSAGES,
    AUTH_ERROR_CODES,
    USER_STATUSES,
    ROLE_KEYS,
    AUDIT_ACTOR_TYPES,
    AUDIT_TARGET_TYPES
} = authConstants;
const { AUDIT_ACTIONS, INVITE_REVOKE_REASONS } = auditConstants;
const { PERMISSIONS, PERMISSION_CATALOGUE } = permissionsConstants;
const { BUILT_IN_ROLES } = rolesConstants;

/** Counts keyed by a role: a built-in key, or `custom:<role id>`. */
type RoleCounts = Map<string, { active: number; disabled: number; pending: number }>;

/**
 * The count key for a role.
 *
 * @param roleKey - A built-in key or `custom`.
 * @param roleId - The custom role id (custom only).
 * @returns `'<key>'` or `'custom:<id>'`.
 */
const _countKey = (roleKey: string, roleId: unknown): string => {
    return roleKey === ROLE_KEYS.CUSTOM ? `custom:${String(roleId)}` : roleKey;
};

/**
 * Members per role (by status) and LIVE invites per role, from one read of each list. The owner is
 * counted under `owner` (by the install pointer), never under their stored `admin`.
 *
 * @param install - The install document (a missing one ⇒ nobody is counted as owner).
 * @returns The counts.
 */
const _countRoles = async (install: SystemStateDoc | null): Promise<RoleCounts> => {
    const counts: RoleCounts = new Map();
    const bump = (key: string, field: 'active' | 'disabled' | 'pending'): void => {
        const entry = counts.get(key) || { active: 0, disabled: 0, pending: 0 };
        entry[field] += 1;
        counts.set(key, entry);
    };
    const users = await userRepository.listUsers();
    for (const user of users) {
        const isOwner = principalHelper.isOwnerUserId({ user_id: user._id, install: install });
        const key = isOwner ? ROLE_KEYS.OWNER : _countKey(user.role_key, user.custom_role_id);
        bump(key, user.status === USER_STATUSES.ACTIVE ? 'active' : 'disabled');
    }
    const now = new Date();
    const invites: InviteDoc[] = await inviteRepository.listOutstanding({});
    for (const invite of invites) {
        if (inviteHelper.inviteState({ invite: invite, now: now }) === 'pending') {
            bump(_countKey(invite.role_key, invite.custom_role_id), 'pending');
        }
    }
    return counts;
};

/**
 * Every role as the API shows it (spec §7.5 + A16): the four built-ins, then the custom roles.
 * `assignable` is "assignable BY THE REQUESTING ACTOR" (`management.helper#assignableRolesFor`).
 *
 * @param actor - The requesting actor.
 * @param install - The install document.
 * @param customRoles - The `gi_roles` rows.
 * @returns The views.
 */
const _roleViews = async (actor: Principal, install: SystemStateDoc | null, customRoles: readonly RoleDoc[]): Promise<RoleView[]> => {
    const counts = await _countRoles(install);
    const assignable = managementHelper.assignableRolesFor(actor, customRoles);
    const assignableKeys = new Set(assignable.map((role) => _countKey(role.role_key, role.role_id)));
    const countsFor = (key: string): { assigned: { active: number; disabled: number }; pending: number } => {
        const entry = counts.get(key) || { active: 0, disabled: 0, pending: 0 };
        return { assigned: { active: entry.active, disabled: entry.disabled }, pending: entry.pending };
    };

    const views: RoleView[] = [];
    for (const builtIn of [BUILT_IN_ROLES.owner, BUILT_IN_ROLES.admin, BUILT_IN_ROLES.analyst, BUILT_IN_ROLES.viewer]) {
        const counted = countsFor(builtIn.key);
        views.push({
            role_key: builtIn.key,
            role_id: null,
            label: builtIn.label,
            description: builtIn.description,
            permissions: Array.from(new Set(builtIn.permissions)).sort(),
            built_in: true,
            assignable: assignableKeys.has(builtIn.key),
            assigned_user_count: counted.assigned,
            pending_invite_count: counted.pending
        });
    }
    for (const custom of customRoles) {
        const resolved = roleHelper.resolveStoredRole({ role_key: ROLE_KEYS.CUSTOM, custom_role_id: custom._id, custom_role: custom });
        const key = _countKey(ROLE_KEYS.CUSTOM, custom._id);
        const counted = countsFor(key);
        views.push({
            role_key: ROLE_KEYS.CUSTOM,
            role_id: String(custom._id),
            label: resolved.role_label,
            description: typeof custom.description === 'string' ? custom.description : '',
            permissions: resolved.permissions,
            built_in: false,
            assignable: assignableKeys.has(key),
            assigned_user_count: counted.assigned,
            pending_invite_count: counted.pending
        });
    }
    return views;
};

/**
 * The view of one custom role, from the full list (so its counts and `assignable` are computed the
 * same way as the list's).
 *
 * @param actor - The requesting actor.
 * @param install - The install document.
 * @param roleId - The custom role.
 * @returns The view, or `null` when it is gone.
 */
const _customRoleView = async (actor: Principal, install: SystemStateDoc | null, roleId: string): Promise<RoleView | null> => {
    const roles = await roleRepository.listRoles();
    const views = await _roleViews(actor, install, roles);
    return views.find((view) => view.role_id === roleId) || null;
};

/**
 * The 400 for a custom-role body `validateCustomRole` refused.
 *
 * @param validation - The refusal.
 * @param validation.reason - The sentence.
 * @param validation.field - Which field.
 * @param validation.keys - Offending permission keys.
 * @returns The envelope (`error: { code: 'VALIDATION', field, keys }`).
 */
const _roleValidationFailure = (validation: { reason: string; field: string; keys: string[] }): ServiceResult => {
    return serviceResultHelper.authFailure(AUTH_ERROR_CODES.VALIDATION, validation.reason, { field: validation.field, keys: validation.keys });
};

/**
 * Re-loads the actor and requires a permission (defence in depth behind the route policy).
 *
 * @param identity - The actor's identity.
 * @param key - The permission.
 * @returns `{ ok: true, principal, install }` or `{ ok: false, failure }`.
 */
const _actorWith = async (identity: IdentityObject, key: string): Promise<
    { ok: true; principal: Principal; install: SystemStateDoc | null } | { ok: false; failure: ServiceResult }
> => {
    const actor = await principalService.loadActor(identity);
    if (!actor.ok) {
        return { ok: false, failure: actor.failure };
    }
    const forbidden = principalService.requirePermission(actor.principal, key);
    if (forbidden) {
        return { ok: false, failure: forbidden };
    }
    return { ok: true, principal: actor.principal, install: actor.install };
};

/**
 * `GET /api/roles` (users:read).
 *
 * @param identity - `{ user_id }` of the actor.
 * @param _params - Unused.
 * @returns Resolves `{ catalogue: PERMISSION_CATALOGUE, roles: RoleView[] }`.
 */
const listRoles = (identity: IdentityObject, _params?: unknown): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const actor = await _actorWith(identity, PERMISSIONS.USERS_READ);
            if (!actor.ok) {
                return resolve(actor.failure);
            }
            const customRoles = await roleRepository.listRoles();
            const roles = await _roleViews(actor.principal, actor.install, customRoles);
            return resolve(promiseHelper.promiseReturnResult(true, { catalogue: PERMISSION_CATALOGUE, roles: roles }, {}, AUTH_MESSAGES.ROLES_LISTED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth role listRoles', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `POST /api/roles` (roles:manage) `{ name, description, permissions }`.
 *
 * @param identity - `{ user_id }` of the actor.
 * @param params - `{ name, description, permissions, request_ip }`.
 * @returns Resolves `{ role: RoleView }` (201); 400 VALIDATION (`field`, `keys`); 403; 409 ROLE_NAME_TAKEN.
 */
const createRole = (identity: IdentityObject, params: CustomRoleParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const hasParams = params !== null && typeof params === 'object';
            const validation = roleHelper.validateCustomRole({
                name: hasParams ? params.name : undefined,
                description: hasParams ? params.description : undefined,
                permissions: hasParams ? params.permissions : undefined
            });
            if (!validation.ok) {
                return resolve(_roleValidationFailure(validation));
            }
            const actor = await _actorWith(identity, PERMISSIONS.ROLES_MANAGE);
            if (!actor.ok) {
                return resolve(actor.failure);
            }
            const context = requestContextHelper.requestContextOf(params);
            let created: RoleDoc;
            try {
                created = await roleRepository.insertRole({
                    name: validation.value.name,
                    name_norm: validation.value.name_norm,
                    description: validation.value.description,
                    permissions: validation.value.permissions,
                    created_by_user_id: actor.principal.user_id
                });
            } catch (insertError) {
                if (datastoreErrorHelper.duplicateKeyField(insertError) === 'name_norm') {
                    return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.ROLE_NAME_TAKEN, AUTH_MESSAGES.ROLE_NAME_TAKEN, { field: 'name' }));
                }
                throw insertError;
            }
            const roleId = String(created._id);
            await auditService.recordAuditEvent(identity, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: actor.principal.user_id,
                actor_email: actor.principal.email,
                action: AUDIT_ACTIONS.ROLE_CREATED,
                target_type: AUDIT_TARGET_TYPES.ROLE,
                target_id: roleId,
                ip: context.ip,
                details: { name: created.name, permissions: validation.value.permissions }
            });
            const view = await _customRoleView(actor.principal, actor.install, roleId);
            return resolve(promiseHelper.promiseReturnResult(true, { role: view }, {}, AUTH_MESSAGES.ROLE_CREATED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth role createRole', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `PATCH /api/roles/:role_id` (roles:manage) — same body as create. Holders' outstanding invites,
 * and invites naming the role, are re-checked against the new permissions (spec A13).
 *
 * @param identity - `{ user_id }` of the actor.
 * @param params - `{ role_id, name, description, permissions, request_ip }`.
 * @returns Resolves `RoleMutationResult` (`{ role, invites_revoked }`); 400; 403; 404; 409 ROLE_NAME_TAKEN.
 */
const updateRole = (identity: IdentityObject, params: UpdateCustomRoleParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const hasParams = params !== null && typeof params === 'object';
            const roleId = hasParams ? params.role_id : undefined;
            if (!identityHelper.isObjectIdString(roleId)) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, AUTH_MESSAGES.ROLE_NOT_FOUND));
            }
            const validation = roleHelper.validateCustomRole({
                name: hasParams ? params.name : undefined,
                description: hasParams ? params.description : undefined,
                permissions: hasParams ? params.permissions : undefined
            });
            if (!validation.ok) {
                return resolve(_roleValidationFailure(validation));
            }
            const actor = await _actorWith(identity, PERMISSIONS.ROLES_MANAGE);
            if (!actor.ok) {
                return resolve(actor.failure);
            }
            const context = requestContextHelper.requestContextOf(params);
            const existing = await roleRepository.findById(roleId);
            if (!existing) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, AUTH_MESSAGES.ROLE_NOT_FOUND));
            }
            const before = roleHelper.sanitiseStoredPermissions(existing.permissions).permissions;

            let updated: RoleDoc | null;
            try {
                updated = await roleRepository.updateRole({
                    role_id: roleId,
                    name: validation.value.name,
                    name_norm: validation.value.name_norm,
                    description: validation.value.description,
                    permissions: validation.value.permissions,
                    updated_by_user_id: actor.principal.user_id
                });
            } catch (updateError) {
                if (datastoreErrorHelper.duplicateKeyField(updateError) === 'name_norm') {
                    return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.ROLE_NAME_TAKEN, AUTH_MESSAGES.ROLE_NAME_TAKEN, { field: 'name' }));
                }
                throw updateError;
            }
            if (!updated) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, AUTH_MESSAGES.ROLE_NOT_FOUND));
            }
            const after = validation.value.permissions;
            const added = after.filter((key) => !before.includes(key));
            const removed = before.filter((key) => !after.includes(key));

            const now = new Date();
            let invitesRevoked = 0;
            if (added.length > 0 || removed.length > 0) {
                const affected: InviteDoc[] = await inviteRepository.listOutstanding({ custom_role_id: roleId });
                const holders = await userRepository.listUsersByCustomRole({ role_id: roleId });
                for (const holder of holders) {
                    const sent = await inviteRepository.listOutstanding({ invited_by_user_id: String(holder._id) });
                    affected.push(...sent);
                }
                invitesRevoked = await inviteService.reevaluateOutstandingInvites({
                    invites: affected,
                    actor: { actor_type: AUDIT_ACTOR_TYPES.USER, actor_user_id: actor.principal.user_id, actor_email: actor.principal.email },
                    ip: context.ip,
                    now: now
                });
            }
            await auditService.recordAuditEvent(identity, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: actor.principal.user_id,
                actor_email: actor.principal.email,
                action: AUDIT_ACTIONS.ROLE_UPDATED,
                target_type: AUDIT_TARGET_TYPES.ROLE,
                target_id: roleId,
                ip: context.ip,
                details: { name: updated.name, added: added, removed: removed, invites_revoked: invitesRevoked },
                now: now
            });
            const view = await _customRoleView(actor.principal, actor.install, roleId);
            if (!view) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, AUTH_MESSAGES.ROLE_NOT_FOUND));
            }
            const result: RoleMutationResult = { role: view, invites_revoked: invitesRevoked };
            return resolve(promiseHelper.promiseReturnResult(true, result, {}, AUTH_MESSAGES.ROLE_UPDATED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth role updateRole', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `DELETE /api/roles/:role_id` (roles:manage). Refused (409 ROLE_IN_USE) while any user — active or
 * disabled — or any LIVE invite references it; expired-but-outstanding invites naming it are then
 * revoked (ROLE_DELETED). A reference that races in resolves to NO permissions (fails narrow).
 *
 * @param identity - `{ user_id }` of the actor.
 * @param params - `{ role_id, request_ip }`.
 * @returns Resolves `RoleDeleteResult` (`{ deleted: true, role_id, invites_revoked }`); 403; 404; 409 ROLE_IN_USE.
 */
const deleteRole = (identity: IdentityObject, params: RoleIdParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const roleId = params !== null && typeof params === 'object' ? params.role_id : undefined;
            if (!identityHelper.isObjectIdString(roleId)) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, AUTH_MESSAGES.ROLE_NOT_FOUND));
            }
            const actor = await _actorWith(identity, PERMISSIONS.ROLES_MANAGE);
            if (!actor.ok) {
                return resolve(actor.failure);
            }
            const context = requestContextHelper.requestContextOf(params);
            const existing = await roleRepository.findById(roleId);
            if (!existing) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, AUTH_MESSAGES.ROLE_NOT_FOUND));
            }
            const now = new Date();
            const heldByUser = await userRepository.existsWithCustomRole({ role_id: roleId });
            const namedByLiveInvite = await inviteRepository.existsLiveWithCustomRole({ role_id: roleId, now: now });
            if (heldByUser || namedByLiveInvite) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.ROLE_IN_USE, AUTH_MESSAGES.ROLE_IN_USE, {
                    assigned: heldByUser,
                    pending_invites: namedByLiveInvite
                }));
            }
            const deleted = await roleRepository.deleteRole({ role_id: roleId });
            if (!deleted) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, AUTH_MESSAGES.ROLE_NOT_FOUND));
            }
            const leftovers = await inviteRepository.listOutstanding({ custom_role_id: roleId });
            const invitesRevoked = await inviteService.revokeInvites({
                invites: leftovers,
                reason: INVITE_REVOKE_REASONS.ROLE_DELETED,
                actor: { actor_type: AUDIT_ACTOR_TYPES.USER, actor_user_id: actor.principal.user_id, actor_email: actor.principal.email },
                ip: context.ip,
                now: now
            });
            await auditService.recordAuditEvent(identity, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: actor.principal.user_id,
                actor_email: actor.principal.email,
                action: AUDIT_ACTIONS.ROLE_DELETED,
                target_type: AUDIT_TARGET_TYPES.ROLE,
                target_id: roleId,
                ip: context.ip,
                details: { name: deleted.name, invites_revoked: invitesRevoked },
                now: now
            });
            const result: RoleDeleteResult = { deleted: true, role_id: roleId, invites_revoked: invitesRevoked };
            return resolve(promiseHelper.promiseReturnResult(true, result, {}, AUTH_MESSAGES.ROLE_DELETED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth role deleteRole', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

export = {
    listRoles,
    createRole,
    updateRole,
    deleteRole
};
