'use strict';

/**
 * ============================================================================
 *  USERS — the members list and what an admin may do to a member
 * ============================================================================
 *
 *  Every action (role change, disable, enable, sign out everywhere) is gated by
 *  THE management rule (`principal.service#loadManagedTarget` →
 *  `management.helper#evaluateManagement`) against an ACTOR re-loaded from the
 *  database, and its write re-asserts the target's role in the CAS filter
 *  (`expected_role`), so a decision taken against "Viewer" cannot land on
 *  someone promoted to "Admin" in between (409 TARGET_CHANGED).
 *
 *  There is no user deletion and no email change: a leaver is disabled.
 *  Disable, enable and sign-out-everywhere bump `session_epoch` in the same
 *  update (spec A4); a role change does not — permissions are re-read on every
 *  request anyway.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import mailModule = require('../../mail');
import authConstants = require('../constants/auth.constants');
import auditConstants = require('../constants/audit.constants');
import permissionsConstants = require('../constants/permissions.constants');
import identityHelper = require('../helpers/identity.helper');
import roleHelper = require('../helpers/role.helper');
import managementHelper = require('../helpers/management.helper');
import requestContextHelper = require('../helpers/requestContext.helper');
import serviceResultHelper = require('../helpers/serviceResult.helper');
import userRepository = require('../repositories/user.repository');
import roleRepository = require('../repositories/role.repository');
import inviteRepository = require('../repositories/invite.repository');
import authSessionRepository = require('../repositories/authSession.repository');
import authTokenRepository = require('../repositories/authToken.repository');
import principalService = require('./principal.service');
import inviteService = require('./invite.service');
import auditService = require('./audit.service');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type { RoleDoc, SystemStateDoc, UserDoc } from '../../shared/types/entity.types';
import type {
    ChangeUserRoleParams,
    ExpectedRole,
    ManagementDecision,
    Principal,
    SessionsRevokedResult,
    UserIdParams,
    UserRoleChangeResult,
    UserStatus,
    UserView
} from '../types/auth.types';

const {
    AUTH_MESSAGES,
    AUTH_ERROR_CODES,
    USER_STATUSES,
    TOKEN_PURPOSES,
    SESSION_REVOKE_REASONS,
    AUDIT_ACTOR_TYPES,
    AUDIT_TARGET_TYPES,
    MANAGEMENT_BLOCK_REASONS
} = authConstants;
const { AUDIT_ACTIONS, INVITE_REVOKE_REASONS } = auditConstants;
const { PERMISSIONS } = permissionsConstants;

/**
 * A stored status narrowed to the vocabulary. An unknown value reads as `disabled` (it cannot sign
 * in: the guard admits `active` only).
 *
 * @param value - `user.status`.
 * @returns `'active'` or `'disabled'`.
 */
const _status = (value: unknown): UserStatus => {
    return value === USER_STATUSES.ACTIVE ? USER_STATUSES.ACTIVE : USER_STATUSES.DISABLED;
};

/**
 * The API view of a member (spec §7.5 + A16). Role key and label come from the principal (the owner
 * reads `'owner'` / `'Owner'`); `can_manage` is the rule for the REQUESTING actor. Field by field —
 * never a spread of the row.
 *
 * @param params0 - The parameters object.
 * @param params0.user - The row (no hash).
 * @param params0.principal - Its resolved principal.
 * @param params0.decision - The management rule for the requesting actor.
 * @returns The view.
 */
const _toUserView = ({ user, principal, decision }: { user: UserDoc; principal: Principal; decision: ManagementDecision }): UserView => {
    return {
        user_id: String(user._id),
        email: user.email,
        name: user.name,
        status: _status(user.status),
        is_owner: principal.is_owner,
        role_key: principal.role_key,
        role_label: principal.role_label,
        custom_role_id: principal.custom_role_id,
        last_login_at: user.last_login_at || null,
        created_at: user.createdAt || null,
        can_manage: decision.allowed,
        manage_block_reason: decision.allowed ? null : decision.reason
    };
};

/**
 * The rule for an actor over one member (no role being assigned).
 *
 * @param actor - The requesting actor.
 * @param install - The install document (`null` ⇒ everyone is possibly the owner — refused).
 * @param user - The member row.
 * @param principal - The member's principal.
 * @returns The decision.
 */
const _decisionFor = (actor: Principal, install: SystemStateDoc | null, user: UserDoc, principal: Principal): ManagementDecision => {
    return managementHelper.evaluateManagement({
        actor: actor,
        target_is_owner: principalService.targetIsOwner({ user_id: String(user._id), install: install }),
        target_user_id: String(user._id),
        target_permissions: principal.permissions
    });
};

/**
 * Why a CAS on a member row came back empty: gone (404), already in the requested status (409
 * USER_STATUS_CONFLICT), or changed by someone else (409 TARGET_CHANGED).
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The member.
 * @param params0.status_already - When the write was a status change, the status it was setting.
 * @param params0.status_msg - What to say when it already had that status.
 * @returns The failure envelope.
 */
const _casFailure = async ({ user_id, status_already, status_msg }: {
    user_id: string;
    status_already?: string;
    status_msg?: string;
}): Promise<ServiceResult> => {
    const reread = await userRepository.findById(user_id);
    if (!reread) {
        return serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, AUTH_MESSAGES.NOT_FOUND);
    }
    if (status_already && reread.status === status_already) {
        return serviceResultHelper.authFailure(AUTH_ERROR_CODES.USER_STATUS_CONFLICT, status_msg || AUTH_MESSAGES.TARGET_CHANGED, { status: reread.status });
    }
    return serviceResultHelper.authFailure(AUTH_ERROR_CODES.TARGET_CHANGED, AUTH_MESSAGES.TARGET_CHANGED);
};

/**
 * The shared front half of every member action: id shape (404), actor re-load, `users:manage`
 * (defence in depth behind the route policy), then the target and THE management rule.
 *
 * @param identity - The actor's identity.
 * @param params - The request params (`user_id` from the path).
 * @param new_permissions - The role being assigned (role change only).
 * @returns The actor, install, target, its principal and the role the write must re-assert — or a failure.
 */
const _loadActionContext = async (identity: IdentityObject, params: unknown, new_permissions?: readonly string[]): Promise<
    | {
        ok: true;
        actor: Principal;
        install: SystemStateDoc | null;
        target: UserDoc;
        target_principal: Principal;
        expected_role: ExpectedRole;
        target_id: string;
    }
    | { ok: false; failure: ServiceResult }
> => {
    const targetId: unknown = params !== null && typeof params === 'object' ? Reflect.get(params, 'user_id') : undefined;
    if (!identityHelper.isObjectIdString(targetId)) {
        return { ok: false, failure: serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, AUTH_MESSAGES.NOT_FOUND) };
    }
    const actor = await principalService.loadActor(identity);
    if (!actor.ok) {
        return { ok: false, failure: actor.failure };
    }
    const forbidden = principalService.requirePermission(actor.principal, PERMISSIONS.USERS_MANAGE);
    if (forbidden) {
        return { ok: false, failure: forbidden };
    }
    const managed = await principalService.loadManagedTarget({
        actor: actor.principal,
        install: actor.install,
        user_id: targetId,
        new_permissions: new_permissions
    });
    if (!managed.ok) {
        return { ok: false, failure: managed.failure };
    }
    return {
        ok: true,
        actor: actor.principal,
        install: actor.install,
        target: managed.target,
        target_principal: managed.target_principal,
        expected_role: managed.expected_role,
        target_id: targetId
    };
};

/**
 * `GET /api/users` (users:read). Every member, oldest first, with `can_manage` /
 * `manage_block_reason` for the requesting actor.
 *
 * @param identity - `{ user_id }` of the actor.
 * @param _params - Unused.
 * @returns Resolves `{ items: UserView[], mail }` (`mail` = the mail module's status, spec A16).
 */
const listUsers = (identity: IdentityObject, _params?: unknown): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const actor = await principalService.loadActor(identity);
            if (!actor.ok) {
                return resolve(actor.failure);
            }
            const forbidden = principalService.requirePermission(actor.principal, PERMISSIONS.USERS_READ);
            if (forbidden) {
                return resolve(forbidden);
            }
            const users = await userRepository.listUsers();
            const roles = await roleRepository.listRoles();
            const roleMap = new Map<string, RoleDoc>(roles.map((role) => [String(role._id), role]));
            const items: UserView[] = [];
            for (const user of users) {
                const principal = await principalService.resolveUserPrincipal({ user: user, install: actor.install, custom_roles: roleMap });
                items.push(_toUserView({ user: user, principal: principal, decision: _decisionFor(actor.principal, actor.install, user, principal) }));
            }
            return resolve(promiseHelper.promiseReturnResult(true, { items: items, mail: mailModule.getMailStatus() }, {}, AUTH_MESSAGES.USERS_LISTED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth user listUsers', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `PATCH /api/users/:user_id/role` (users:manage) `{ role_key, custom_role_id? }`. Allowed on
 * disabled members (spec A16). The member's own OUTSTANDING invites are then re-checked against
 * their new role and revoked where it can no longer grant them (spec A13).
 *
 * @param identity - `{ user_id }` of the actor.
 * @param params - `{ user_id, role_key, custom_role_id?, request_ip }`.
 * @returns Resolves `UserRoleChangeResult` (`{ user, invites_revoked }`); 400 VALIDATION; 403;
 *     404 (member or custom role); 409 TARGET_CHANGED.
 */
const changeUserRole = (identity: IdentityObject, params: ChangeUserRoleParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const hasParams = params !== null && typeof params === 'object';
            if (!identityHelper.isObjectIdString(hasParams ? params.user_id : undefined)) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, AUTH_MESSAGES.NOT_FOUND));
            }
            const assignment = roleHelper.validateRoleAssignment({
                role_key: hasParams ? params.role_key : undefined,
                custom_role_id: hasParams ? params.custom_role_id : undefined
            });
            if (!assignment.ok) {
                const field = assignment.code === AUTH_ERROR_CODES.NOT_FOUND ? 'custom_role_id' : 'role_key';
                return resolve(serviceResultHelper.authFailure(assignment.code, assignment.reason, { field: field }));
            }
            const context = requestContextHelper.requestContextOf(params);

            let customRole: RoleDoc | null = null;
            if (assignment.value.custom_role_id) {
                customRole = await roleRepository.findById(assignment.value.custom_role_id);
                if (!customRole) {
                    return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, AUTH_MESSAGES.ROLE_NOT_FOUND, { field: 'custom_role_id' }));
                }
            }
            const newRole = roleHelper.resolveStoredRole({
                role_key: assignment.value.role_key,
                custom_role_id: assignment.value.custom_role_id,
                custom_role: customRole
            });
            if (newRole.permissions.length === 0) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.FORBIDDEN, AUTH_MESSAGES.FORBIDDEN, {
                    reason: MANAGEMENT_BLOCK_REASONS.ROLE_NOT_ASSIGNABLE
                }));
            }

            const loaded = await _loadActionContext(identity, params, newRole.permissions);
            if (!loaded.ok) {
                return resolve(loaded.failure);
            }
            const { actor, install, target, target_principal: before, target_id: targetId } = loaded;

            const sameKey = target.role_key === assignment.value.role_key;
            const sameCustom = String(target.custom_role_id || '') === String(assignment.value.custom_role_id || '');
            if (sameKey && sameCustom) {
                const unchanged: UserRoleChangeResult = {
                    user: _toUserView({ user: target, principal: before, decision: _decisionFor(actor, install, target, before) }),
                    invites_revoked: 0
                };
                return resolve(promiseHelper.promiseReturnResult(true, unchanged, {}, AUTH_MESSAGES.USER_ROLE_UNCHANGED));
            }

            const now = new Date();
            const updated = await userRepository.changeRole({
                user_id: targetId,
                role_key: assignment.value.role_key,
                custom_role_id: assignment.value.custom_role_id,
                expected_role: loaded.expected_role
            });
            if (!updated) {
                return resolve(await _casFailure({ user_id: targetId }));
            }
            const after = await principalService.resolveUserPrincipal({ user: updated, install: install });

            const outstanding = await inviteRepository.listOutstanding({ invited_by_user_id: targetId });
            const invitesRevoked = await inviteService.reevaluateOutstandingInvites({
                invites: outstanding,
                actor: { actor_type: AUDIT_ACTOR_TYPES.USER, actor_user_id: actor.user_id, actor_email: actor.email },
                ip: context.ip,
                now: now
            });
            await auditService.recordAuditEvent(identity, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: actor.user_id,
                actor_email: actor.email,
                action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
                target_type: AUDIT_TARGET_TYPES.USER,
                target_id: targetId,
                target_email: updated.email,
                ip: context.ip,
                details: {
                    from: { key: before.role_key, label: before.role_label },
                    to: { key: after.role_key, label: after.role_label },
                    invites_revoked: invitesRevoked
                },
                now: now
            });
            const result: UserRoleChangeResult = {
                user: _toUserView({ user: updated, principal: after, decision: _decisionFor(actor, install, updated, after) }),
                invites_revoked: invitesRevoked
            };
            return resolve(promiseHelper.promiseReturnResult(true, result, {}, AUTH_MESSAGES.USER_ROLE_CHANGED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth user changeUserRole', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `POST /api/users/:user_id/disable` (users:manage). Status → disabled and the epoch bumped in one
 * update (every session ends from the next request); session rows marked; the member's OUTSTANDING
 * invites revoked (INVITER_DISABLED); their live reset links revoked.
 *
 * @param identity - `{ user_id }` of the actor.
 * @param params - `{ user_id, request_ip }`.
 * @returns Resolves `{ user, sessions_revoked, invites_revoked }`; 403; 404; 409 USER_STATUS_CONFLICT / TARGET_CHANGED.
 */
const disableUser = (identity: IdentityObject, params: UserIdParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const loaded = await _loadActionContext(identity, params);
            if (!loaded.ok) {
                return resolve(loaded.failure);
            }
            const { actor, install, target, target_id: targetId } = loaded;
            if (target.status === USER_STATUSES.DISABLED) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.USER_STATUS_CONFLICT, AUTH_MESSAGES.USER_ALREADY_DISABLED, {
                    status: target.status
                }));
            }
            const context = requestContextHelper.requestContextOf(params);
            const now = new Date();
            const updated = await userRepository.disableUser({
                user_id: targetId,
                actor_user_id: actor.user_id,
                now: now,
                expected_role: loaded.expected_role
            });
            if (!updated) {
                return resolve(await _casFailure({
                    user_id: targetId,
                    status_already: USER_STATUSES.DISABLED,
                    status_msg: AUTH_MESSAGES.USER_ALREADY_DISABLED
                }));
            }

            let sessionsRevoked = 0;
            try {
                sessionsRevoked = await authSessionRepository.revokeAllForUser({ user_id: targetId, reason: SESSION_REVOKE_REASONS.USER_DISABLED, now: now });
                await authTokenRepository.revokeLiveTokens({ purpose: TOKEN_PURPOSES.PASSWORD_RESET, now: now, user_id: targetId });
            } catch (cleanupError) {
                // Sessions are dead by epoch and reset links refuse a disabled account; this is the audit trail.
                logger.customConsoleWarn('WARN: auth disableUser — marking sessions / reset links revoked failed (already ineffective)', cleanupError);
            }
            const outstanding = await inviteRepository.listOutstanding({ invited_by_user_id: targetId });
            const invitesRevoked = await inviteService.revokeInvites({
                invites: outstanding,
                reason: INVITE_REVOKE_REASONS.INVITER_DISABLED,
                actor: { actor_type: AUDIT_ACTOR_TYPES.USER, actor_user_id: actor.user_id, actor_email: actor.email },
                ip: context.ip,
                now: now
            });
            await auditService.recordAuditEvent(identity, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: actor.user_id,
                actor_email: actor.email,
                action: AUDIT_ACTIONS.USER_DISABLED,
                target_type: AUDIT_TARGET_TYPES.USER,
                target_id: targetId,
                target_email: updated.email,
                ip: context.ip,
                details: { sessions_revoked: sessionsRevoked, invites_revoked: invitesRevoked },
                now: now
            });
            const principal = await principalService.resolveUserPrincipal({ user: updated, install: install });
            const result = {
                user: _toUserView({ user: updated, principal: principal, decision: _decisionFor(actor, install, updated, principal) }),
                sessions_revoked: sessionsRevoked,
                invites_revoked: invitesRevoked
            };
            return resolve(promiseHelper.promiseReturnResult(true, result, {}, AUTH_MESSAGES.USER_DISABLED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth user disableUser', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `POST /api/users/:user_id/enable` (users:manage). Status → active (epoch bumped too, so nothing
 * that survived the disable comes back). Invites revoked at disable stay revoked.
 *
 * @param identity - `{ user_id }` of the actor.
 * @param params - `{ user_id, request_ip }`.
 * @returns Resolves `{ user }`; 403; 404; 409 USER_STATUS_CONFLICT / TARGET_CHANGED.
 */
const enableUser = (identity: IdentityObject, params: UserIdParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const loaded = await _loadActionContext(identity, params);
            if (!loaded.ok) {
                return resolve(loaded.failure);
            }
            const { actor, install, target, target_id: targetId } = loaded;
            if (target.status === USER_STATUSES.ACTIVE) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.USER_STATUS_CONFLICT, AUTH_MESSAGES.USER_ALREADY_ACTIVE, {
                    status: target.status
                }));
            }
            const context = requestContextHelper.requestContextOf(params);
            const now = new Date();
            const updated = await userRepository.enableUser({
                user_id: targetId,
                expected_role: loaded.expected_role
            });
            if (!updated) {
                return resolve(await _casFailure({ user_id: targetId, status_already: USER_STATUSES.ACTIVE, status_msg: AUTH_MESSAGES.USER_ALREADY_ACTIVE }));
            }
            await auditService.recordAuditEvent(identity, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: actor.user_id,
                actor_email: actor.email,
                action: AUDIT_ACTIONS.USER_ENABLED,
                target_type: AUDIT_TARGET_TYPES.USER,
                target_id: targetId,
                target_email: updated.email,
                ip: context.ip,
                now: now
            });
            const principal = await principalService.resolveUserPrincipal({ user: updated, install: install });
            const result = { user: _toUserView({ user: updated, principal: principal, decision: _decisionFor(actor, install, updated, principal) }) };
            return resolve(promiseHelper.promiseReturnResult(true, result, {}, AUTH_MESSAGES.USER_ENABLED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth user enableUser', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `POST /api/users/:user_id/sessions/revoke` (users:manage). Bumps the member's epoch (every
 * session ends from the next request) and marks the rows revoked (reason ADMIN_REVOKED).
 *
 * @param identity - `{ user_id }` of the actor.
 * @param params - `{ user_id, request_ip }`.
 * @returns Resolves `SessionsRevokedResult` (`{ revoked: n }`); 403; 404; 409 TARGET_CHANGED.
 */
const revokeUserSessions = (identity: IdentityObject, params: UserIdParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const loaded = await _loadActionContext(identity, params);
            if (!loaded.ok) {
                return resolve(loaded.failure);
            }
            const { actor, target_id: targetId } = loaded;
            const context = requestContextHelper.requestContextOf(params);
            const now = new Date();
            const bumped = await userRepository.bumpSessionEpoch({
                user_id: targetId,
                expected_role: loaded.expected_role
            });
            if (!bumped) {
                return resolve(await _casFailure({ user_id: targetId }));
            }
            const revoked = await authSessionRepository.revokeAllForUser({ user_id: targetId, reason: SESSION_REVOKE_REASONS.ADMIN_REVOKED, now: now });
            await auditService.recordAuditEvent(identity, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: actor.user_id,
                actor_email: actor.email,
                action: AUDIT_ACTIONS.USER_SESSIONS_REVOKED,
                target_type: AUDIT_TARGET_TYPES.USER,
                target_id: targetId,
                target_email: bumped.email,
                ip: context.ip,
                details: { count: revoked },
                now: now
            });
            const result: SessionsRevokedResult = { revoked: revoked };
            return resolve(promiseHelper.promiseReturnResult(true, result, {}, AUTH_MESSAGES.USER_SESSIONS_REVOKED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth user revokeUserSessions', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

export = {
    listUsers,
    changeUserRole,
    disableUser,
    enableUser,
    revokeUserSessions
};
