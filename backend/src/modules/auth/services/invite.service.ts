'use strict';

/**
 * ============================================================================
 *  INVITATIONS — the only way anyone but the owner joins (spec §0.6, §7.3, A13)
 * ============================================================================
 *
 *  Admin side (users:manage + THE management rule, target = the invite's role):
 *  create, resend, revoke; list (users:read). Public side (the link holder):
 *  inspect, accept.
 *
 *  Database guarantees this file leans on (spec A13):
 *    - one OUTSTANDING invite per address: `pending_email` is unique while set,
 *      unset on accept/revoke (E11000 ⇒ 409 INVITE_PENDING);
 *    - resend is one CAS that checks the throttle, rotates the token, resets the
 *      expiry and hands the invite to the resender (null ⇒ 429 or 409);
 *    - accept is one CAS on (id, token hash, live) — a revoke racing an accept
 *      has exactly one winner; a lost accept deletes the user it inserted.
 *
 *  An invite is only as good as its inviter: at accept time the inviter must
 *  still be active and the rule must STILL let them grant the role, else the
 *  invite is revoked (INVITER_NO_LONGER_PERMITTED) and the link refused. Role
 *  changes, role edits and ownership moves re-run that check over outstanding
 *  invites (`reevaluateOutstandingInvites`) — one spelling for all of them.
 *
 *  Emails go to the address ON THE INVITE ROW, never to a request string.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import mailModule = require('../../mail');
import authConstants = require('../constants/auth.constants');
import auditConstants = require('../constants/audit.constants');
import permissionsConstants = require('../constants/permissions.constants');
import identityHelper = require('../helpers/identity.helper');
import passwordHelper = require('../helpers/password.helper');
import tokenHelper = require('../helpers/token.helper');
import roleHelper = require('../helpers/role.helper');
import inviteHelper = require('../helpers/invite.helper');
import managementHelper = require('../helpers/management.helper');
import datastoreErrorHelper = require('../helpers/datastoreError.helper');
import requestContextHelper = require('../helpers/requestContext.helper');
import serviceResultHelper = require('../helpers/serviceResult.helper');
import userRepository = require('../repositories/user.repository');
import roleRepository = require('../repositories/role.repository');
import inviteRepository = require('../repositories/invite.repository');
import systemStateRepository = require('../repositories/systemState.repository');
import installStateService = require('./installState.service');
import authTokenService = require('./authToken.service');
import authMailService = require('./authMail.service');
import passwordHashService = require('./passwordHash.service');
import principalService = require('./principal.service');
import auditService = require('./audit.service');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type { InviteDoc, RoleDoc, SystemStateDoc } from '../../shared/types/entity.types';
import type {
    AcceptInviteParams,
    AuditActorType,
    InviteCreateParams,
    InviteIdParams,
    InviteMutationResult,
    InviteView,
    ManagementDecision,
    Principal,
    RoleResolution,
    SendSlotThrottle,
    StoredRoleKey,
    TokenParams
} from '../types/auth.types';

const {
    AUTH_MESSAGES,
    AUTH_ERROR_CODES,
    USER_STATUSES,
    ROLE_KEYS,
    STORED_ROLE_KEYS,
    CREATED_VIA,
    AUDIT_ACTOR_TYPES,
    AUDIT_TARGET_TYPES,
    APP_LINK_PATHS,
    AUTH_SERVICE_ACTORS,
    MANAGEMENT_BLOCK_REASONS,
    PASSWORD_POLICY_CODES,
    PASSWORD_POLICY_MESSAGES,
    INVITE_RESEND_MIN_INTERVAL_MS,
    INVITE_MAX_SENDS_PER_WINDOW,
    INVITE_SEND_WINDOW_MS,
    INVITE_SEND_LOG_KEEP,
    INVITE_CREATE_MAX_PER_WINDOW,
    INVITE_CREATE_WINDOW_MS,
    INVITE_TTL_MIN_HOURS,
    INVITE_TTL_MAX_HOURS
} = authConstants;
const { AUDIT_ACTIONS, INVITE_REVOKE_REASONS } = auditConstants;
const { PERMISSIONS } = permissionsConstants;

const SYSTEM_IDENTITY = Object.freeze({ user_id: AUTH_SERVICE_ACTORS.SYSTEM });

/** Who an audit row for a revocation names as its actor. */
interface AuditActor {
    actor_type: AuditActorType;
    actor_user_id: string | null;
    actor_email: string | null;
}

/**
 * Narrows a stored role key to the stored vocabulary.
 *
 * @param value - `invite.role_key`.
 * @returns The key, or `null` for a value this build does not know.
 */
const _storedRoleKey = (value: unknown): StoredRoleKey | null => {
    const found = STORED_ROLE_KEYS.find((key) => key === value);
    return found === undefined ? null : found;
};

/**
 * What an invite's role grants: the ONE role resolution (`role.helper#resolveStoredRole`), with the
 * custom role read from `custom_roles` when given, else from the database.
 *
 * @param invite - The invite.
 * @param custom_roles - Optional pre-fetched custom roles by id.
 * @returns The resolution (a missing custom role ⇒ `permissions: []`, `anomalies.missing_custom_role`).
 */
const _resolveInviteRole = async (invite: InviteDoc, custom_roles?: ReadonlyMap<string, RoleDoc | null>): Promise<RoleResolution> => {
    let customRole: RoleDoc | null = null;
    if (invite.role_key === ROLE_KEYS.CUSTOM && identityHelper.isObjectIdLike(invite.custom_role_id)) {
        const roleId = String(invite.custom_role_id);
        if (custom_roles && custom_roles.has(roleId)) {
            customRole = custom_roles.get(roleId) || null;
        } else {
            customRole = await roleRepository.findById(roleId);
        }
    }
    return roleHelper.resolveStoredRole({ role_key: invite.role_key, custom_role_id: invite.custom_role_id, custom_role: customRole });
};

/**
 * THE management rule applied to an invite: the target is the invite's ROLE (no target user), and
 * the role is both the target and what is being granted (spec §5).
 *
 * @param actor - The principal acting (or the inviter, when re-checking an invite).
 * @param permissions - The invite role's resolved permissions.
 * @returns The decision; a role that grants nothing is refused as ROLE_NOT_ASSIGNABLE.
 */
const _inviteDecision = (actor: Principal, permissions: readonly string[]): ManagementDecision => {
    if (permissions.length === 0) {
        return { allowed: false, reason: MANAGEMENT_BLOCK_REASONS.ROLE_NOT_ASSIGNABLE };
    }
    return managementHelper.evaluateManagement({
        actor: actor,
        target_is_owner: false,
        target_user_id: null,
        target_permissions: permissions,
        new_permissions: permissions
    });
};

/**
 * The rule for MANAGING an existing invite (revoke; the `can_manage` flag). Same as
 * `_inviteDecision`, except that a role which now grants nothing (its custom role was deleted) does
 * not block: any users:manage holder may clear such an invite away. Resend still refuses it
 * separately (ROLE_NOT_FOUND).
 *
 * @param actor - The acting principal.
 * @param permissions - The invite role's resolved permissions.
 * @returns The decision.
 */
const _manageDecision = (actor: Principal, permissions: readonly string[]): ManagementDecision => {
    if (permissions.length > 0) {
        return _inviteDecision(actor, permissions);
    }
    return managementHelper.evaluateManagement({
        actor: actor,
        target_is_owner: false,
        target_user_id: null,
        target_permissions: permissions,
        new_permissions: permissions
    });
};

/**
 * The API view of an invite. Assembled field by field — never a spread (a spread is how a hash
 * reaches the wire).
 *
 * @param params0 - The parameters object.
 * @param params0.invite - The row.
 * @param params0.now - For the state.
 * @param params0.role_label - From the role resolution.
 * @param params0.inviter_name - The current inviter's name, or `null`.
 * @param params0.decision - The management rule for the requesting actor (ignored once accepted/revoked).
 * @returns The view.
 */
const _toInviteView = ({ invite, now, role_label, inviter_name, decision }: {
    invite: InviteDoc;
    now: Date;
    role_label: string;
    inviter_name: string | null;
    decision: ManagementDecision | null;
}): InviteView => {
    const state = inviteHelper.inviteState({ invite: invite, now: now });
    const actionable = state === 'pending' || state === 'expired';
    return {
        invite_id: String(invite._id),
        email: invite.email,
        role_key: _storedRoleKey(invite.role_key) || ROLE_KEYS.CUSTOM,
        role_label: role_label,
        custom_role_id: invite.custom_role_id ? String(invite.custom_role_id) : null,
        state: state,
        invited_by_user_id: String(invite.invited_by_user_id),
        invited_by_name: inviter_name,
        expires_at: invite.expires_at,
        created_at: invite.createdAt || null,
        last_sent_at: invite.last_sent_at || null,
        send_count: typeof invite.send_count === 'number' ? invite.send_count : 0,
        accepted_at: invite.accepted_at || null,
        revoked_at: invite.revoked_at || null,
        revoked_reason: invite.revoked_reason || null,
        can_manage: Boolean(actionable && decision && decision.allowed),
        manage_block_reason: actionable && decision && !decision.allowed ? decision.reason : null
    };
};

/**
 * The invite lifetime: `AUTH_INVITE_TTL_HOURS` clamped into 1..168 hours (spec §2).
 *
 * @param now - Issue instant.
 * @returns The expiry.
 */
const _inviteExpiry = (now: Date): Date => {
    return authTokenService.linkExpiry({
        now: now,
        minutes: config.AUTH.INVITE_TTL_HOURS * 60,
        setting: 'AUTH_INVITE_TTL_HOURS',
        min_minutes: INVITE_TTL_MIN_HOURS * 60,
        max_minutes: INVITE_TTL_MAX_HOURS * 60
    }).expires_at;
};

/**
 * The resend throttle (spec A13): ≥ 60 s since the last send, ≤ 5 sends (create included) per 24 h.
 *
 * @param now - The instant.
 * @returns The throttle for `claimResend`.
 */
const _resendThrottle = (now: Date): SendSlotThrottle => {
    return {
        now: now,
        min_interval_ms: INVITE_RESEND_MIN_INTERVAL_MS,
        max_per_window: INVITE_MAX_SENDS_PER_WINDOW,
        window_ms: INVITE_SEND_WINDOW_MS,
        keep: INVITE_SEND_LOG_KEEP
    };
};

/**
 * Revokes one OUTSTANDING invite (CAS) and audits it. Returns whether this call revoked it.
 *
 * @param params0 - The parameters object.
 * @param params0.invite - The invite.
 * @param params0.reason - One of `INVITE_REVOKE_REASONS`.
 * @param params0.actor - Who the audit row names.
 * @param params0.ip - The requesting address, when a request caused it.
 * @param params0.now - The instant.
 * @returns True when revoked by this call.
 */
const _revokeAndAudit = async ({ invite, reason, actor, ip, now }: {
    invite: InviteDoc;
    reason: string;
    actor: AuditActor;
    ip: string | null;
    now: Date;
}): Promise<boolean> => {
    const revoked = await inviteRepository.revokeInvite({
        invite_id: String(invite._id),
        actor_user_id: actor.actor_user_id,
        reason: reason,
        now: now
    });
    if (!revoked) {
        return false;
    }
    await auditService.recordAuditEvent(actor.actor_user_id ? { user_id: actor.actor_user_id } : SYSTEM_IDENTITY, {
        actor_type: actor.actor_type,
        actor_user_id: actor.actor_user_id,
        actor_email: actor.actor_email,
        action: AUDIT_ACTIONS.INVITE_REVOKED,
        target_type: AUDIT_TARGET_TYPES.INVITE,
        target_id: String(invite._id),
        target_email: invite.email,
        ip: ip,
        details: { reason: reason },
        now: now
    });
    return true;
};

/**
 * Revokes a set of OUTSTANDING invites with one reason (e.g. INVITER_DISABLED). Internal.
 *
 * @param params0 - The parameters object.
 * @param params0.invites - The invites.
 * @param params0.reason - One of `INVITE_REVOKE_REASONS`.
 * @param params0.actor - Who the audit rows name.
 * @param params0.ip - The requesting address.
 * @param params0.now - The instant.
 * @returns How many this call revoked.
 */
const revokeInvites = async ({ invites, reason, actor, ip, now }: {
    invites: readonly InviteDoc[];
    reason: string;
    actor: AuditActor;
    ip: string | null;
    now: Date;
}): Promise<number> => {
    let count = 0;
    for (const invite of invites) {
        if (await _revokeAndAudit({ invite: invite, reason: reason, actor: actor, ip: ip, now: now })) {
            count += 1;
        }
    }
    return count;
};

/**
 *  RE-RUNS THE RULE OVER OUTSTANDING INVITES after something that can change it (spec A13): a role
 * change (the target's own invites), a custom-role edit (invites naming it, and invites sent by
 * people holding it), an ownership move. Each invite's CURRENT inviter is re-loaded; an invite is
 * revoked when the inviter is gone or disabled (INVITER_DISABLED), its custom role is gone
 * (ROLE_DELETED), or the rule no longer lets the inviter grant its role (INVITER_NO_LONGER_PERMITTED).
 *
 * Call it AFTER the change is written, so the re-loaded principals reflect it.
 *
 * @param params0 - The parameters object.
 * @param params0.invites - Outstanding invites to re-check (duplicates are checked once).
 * @param params0.actor - Who the audit rows name (the admin whose action caused this, or SYSTEM/CLI).
 * @param params0.ip - The requesting address.
 * @param params0.now - The instant.
 * @returns How many invites were revoked.
 */
const reevaluateOutstandingInvites = async ({ invites, actor, ip, now }: {
    invites: readonly InviteDoc[];
    actor: AuditActor;
    ip: string | null;
    now: Date;
}): Promise<number> => {
    if (!Array.isArray(invites) || invites.length === 0) {
        return 0;
    }
    const install = await systemStateRepository.findInstallState();
    const inviters = new Map<string, { principal: Principal | null; disabled: boolean }>();
    const seen = new Set<string>();
    let count = 0;
    for (const invite of invites) {
        const inviteId = String(invite._id);
        if (seen.has(inviteId) || invite.accepted_at || invite.revoked_at) {
            continue;
        }
        seen.add(inviteId);

        const inviterId = String(invite.invited_by_user_id);
        let inviter = inviters.get(inviterId);
        if (!inviter) {
            const user = await userRepository.findById(inviterId);
            if (!user || user.status !== USER_STATUSES.ACTIVE) {
                inviter = { principal: null, disabled: Boolean(user) };
            } else {
                inviter = { principal: await principalService.resolveUserPrincipal({ user: user, install: install }), disabled: false };
            }
            inviters.set(inviterId, inviter);
        }

        const role = await _resolveInviteRole(invite);
        let reason: string | null = null;
        if (!inviter.principal) {
            reason = INVITE_REVOKE_REASONS.INVITER_DISABLED;
        } else if (role.anomalies.missing_custom_role) {
            reason = INVITE_REVOKE_REASONS.ROLE_DELETED;
        } else if (!_inviteDecision(inviter.principal, role.permissions).allowed) {
            reason = INVITE_REVOKE_REASONS.INVITER_NO_LONGER_PERMITTED;
        }
        if (reason && await _revokeAndAudit({ invite: invite, reason: reason, actor: actor, ip: ip, now: now })) {
            count += 1;
        }
    }
    return count;
};

/**
 * The email outcome of a create/resend, as the response carries it.
 *
 * @param params0 - The parameters object.
 * @param params0.invite - The invite the email was for.
 * @param params0.token - The raw token for the link (dropped after this call).
 * @param params0.actor - The acting principal (named as the inviter).
 * @param params0.role_label - The role's label.
 * @param params0.ip - The requesting address.
 * @param params0.now - The instant.
 * @returns `{ accepted, status, unconfirmed, msg }`.
 */
const _sendInviteEmail = async ({ invite, token, actor, role_label, ip, now }: {
    invite: InviteDoc;
    token: string;
    actor: Principal;
    role_label: string;
    ip: string | null;
    now: Date;
}): Promise<{ accepted: boolean; status: string; unconfirmed: boolean; msg: string }> => {
    const link = authTokenService.buildAppLink(APP_LINK_PATHS.ACCEPT_INVITE, token);
    if (!link) {
        return { accepted: false, status: mailModule.MAIL_SEND_STATUSES.FAILED, unconfirmed: false, msg: AUTH_MESSAGES.PUBLIC_URL_MISSING };
    }
    return authMailService.sendAuthEmail({
        identity: { user_id: actor.user_id },
        to: invite.email,
        template: mailModule.EMAIL_TEMPLATES.INVITE,
        vars: { now: now, expires_at: invite.expires_at, link: link, ip: ip, inviter_name: actor.name, role_label: role_label },
        trigger: mailModule.MAIL_TRIGGERS.ADMIN,
        deadline_ms: mailModule.ADMIN_SEND_DEADLINE_MS
    });
};

/**
 * `POST /api/invites` (users:manage) `{ email, role_key, custom_role_id? }`.
 *
 * @param identity - `{ user_id }` of the actor (re-loaded from the database).
 * @param params - `{ email, role_key, custom_role_id?, request_ip }`.
 * @returns Resolves `InviteMutationResult` (201) — `email_sent: false` is still a success: the
 *     invite exists; 400 VALIDATION; 403 FORBIDDEN (`reason`/`permission`); 404 (custom role);
 *     409 ALREADY_A_MEMBER (`user_id`, `status`) / INVITE_PENDING (`invite_id`); 429 RATE_LIMITED;
 *     503 INDEXES_NOT_READY.
 */
const createInvite = (identity: IdentityObject, params: InviteCreateParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const hasParams = params !== null && typeof params === 'object';
            const emailCheck = identityHelper.validateEmail(hasParams ? params.email : undefined);
            if (!emailCheck.ok) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.VALIDATION, emailCheck.reason, { field: 'email' }));
            }
            const assignment = roleHelper.validateRoleAssignment({
                role_key: hasParams ? params.role_key : undefined,
                custom_role_id: hasParams ? params.custom_role_id : undefined
            });
            if (!assignment.ok) {
                const field = assignment.code === AUTH_ERROR_CODES.NOT_FOUND ? 'custom_role_id' : 'role_key';
                return resolve(serviceResultHelper.authFailure(assignment.code, assignment.reason, { field: field }));
            }
            if (!installStateService.areAuthIndexesReady()) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.INDEXES_NOT_READY, AUTH_MESSAGES.INDEXES_NOT_READY));
            }
            const context = requestContextHelper.requestContextOf(params);
            const email = emailCheck.value;

            const actor = await principalService.loadActor(identity);
            if (!actor.ok) {
                return resolve(actor.failure);
            }
            const principal = actor.principal;
            const forbidden = principalService.requirePermission(principal, PERMISSIONS.USERS_MANAGE);
            if (forbidden) {
                return resolve(forbidden);
            }

            let customRole: RoleDoc | null = null;
            if (assignment.value.custom_role_id) {
                customRole = await roleRepository.findById(assignment.value.custom_role_id);
                if (!customRole) {
                    return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, AUTH_MESSAGES.ROLE_NOT_FOUND, { field: 'custom_role_id' }));
                }
            }
            const role = roleHelper.resolveStoredRole({
                role_key: assignment.value.role_key,
                custom_role_id: assignment.value.custom_role_id,
                custom_role: customRole
            });
            const decision = _inviteDecision(principal, role.permissions);
            if (!decision.allowed) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.FORBIDDEN, AUTH_MESSAGES.FORBIDDEN, { reason: decision.reason }));
            }

            const member = await userRepository.findByEmail(email);
            if (member) {
                // The actor holds users:read (users:manage requires it), so naming the account is fine.
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.ALREADY_A_MEMBER, AUTH_MESSAGES.ALREADY_A_MEMBER, {
                    user_id: String(member._id),
                    status: member.status
                }));
            }
            const outstanding = await inviteRepository.findOutstandingByEmail({ email: email });
            if (outstanding) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.INVITE_PENDING, AUTH_MESSAGES.INVITE_PENDING, {
                    invite_id: String(outstanding._id)
                }));
            }
            const now = new Date();
            const createdRecently = await inviteRepository.countCreatedBySince({
                user_id: principal.user_id,
                since: new Date(now.getTime() - INVITE_CREATE_WINDOW_MS)
            });
            if (createdRecently >= INVITE_CREATE_MAX_PER_WINDOW) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.RATE_LIMITED, AUTH_MESSAGES.RATE_LIMITED));
            }
            if (!authTokenService.canBuildLinks()) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.PUBLIC_URL_MISSING, AUTH_MESSAGES.PUBLIC_URL_MISSING));
            }

            const issued = authTokenService.issueToken();
            let invite: InviteDoc;
            try {
                invite = await inviteRepository.insertInvite({
                    email: email,
                    role_key: assignment.value.role_key,
                    custom_role_id: assignment.value.custom_role_id,
                    invited_by_user_id: principal.user_id,
                    token_hash: issued.token_hash,
                    expires_at: _inviteExpiry(now),
                    now: now
                });
            } catch (insertError) {
                if (datastoreErrorHelper.duplicateKeyField(insertError) === 'pending_email') {
                    return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.INVITE_PENDING, AUTH_MESSAGES.INVITE_PENDING));
                }
                throw insertError;
            }

            const outcome = await _sendInviteEmail({
                invite: invite,
                token: issued.token,
                actor: principal,
                role_label: role.role_label,
                ip: context.ip,
                now: now
            });
            await auditService.recordAuditEvent(identity, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: principal.user_id,
                actor_email: principal.email,
                action: AUDIT_ACTIONS.INVITE_CREATED,
                target_type: AUDIT_TARGET_TYPES.INVITE,
                target_id: String(invite._id),
                target_email: invite.email,
                ip: context.ip,
                details: { role_key: role.role_key, role_label: role.role_label, email_status: outcome.status },
                now: now
            });
            const result: InviteMutationResult = {
                invite: _toInviteView({ invite: invite, now: now, role_label: role.role_label, inviter_name: principal.name, decision: decision }),
                email_sent: outcome.accepted,
                email_status: outcome.status,
                link_host_is_loopback: authTokenService.isLinkHostLoopback()
            };
            const msg = serviceResultHelper.emailOutcomeMessage({
                accepted: outcome.accepted,
                unconfirmed: outcome.unconfirmed,
                success_msg: AUTH_MESSAGES.INVITE_CREATED,
                prefix: AUTH_MESSAGES.INVITE_CREATED_PREFIX,
                mail_msg: outcome.msg,
                retry_hint: AUTH_MESSAGES.EMAIL_RETRY_HINT
            });
            return resolve(promiseHelper.promiseReturnResult(true, result, {}, msg));
        } catch (error) {
            logger.customConsoleError('ERROR: auth invite createInvite', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * Loads an invite an admin action names, with the actor, the role resolution and the rule's
 * decision — the shared front half of resend and revoke.
 *
 * @param identity - The actor's identity.
 * @param inviteIdRaw - Raw `invite_id` from the path.
 * @returns `{ ok: true, principal, invite, role, decision }` or `{ ok: false, failure }`.
 */
const _loadManagedInvite = async (identity: IdentityObject, inviteIdRaw: unknown): Promise<
    { ok: true; principal: Principal; invite: InviteDoc; role: RoleResolution; decision: ManagementDecision } | { ok: false; failure: ServiceResult }
> => {
    if (!identityHelper.isObjectIdString(inviteIdRaw)) {
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
    const invite = await inviteRepository.findById(inviteIdRaw);
    if (!invite) {
        return { ok: false, failure: serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, AUTH_MESSAGES.NOT_FOUND) };
    }
    if (invite.accepted_at || invite.revoked_at) {
        return { ok: false, failure: serviceResultHelper.authFailure(AUTH_ERROR_CODES.INVITE_NOT_PENDING, AUTH_MESSAGES.INVITE_NOT_PENDING) };
    }
    const role = await _resolveInviteRole(invite);
    const decision = _manageDecision(actor.principal, role.permissions);
    return { ok: true, principal: actor.principal, invite: invite, role: role, decision: decision };
};

/**
 * `POST /api/invites/:invite_id/resend` (users:manage). Rotates the token (the old link stops
 * working), resets the expiry, makes the resender the inviter, and sends. An expired invite may be
 * resent; an accepted or revoked one may not.
 *
 * @param identity - `{ user_id }` of the actor.
 * @param params - `{ invite_id, request_ip }`.
 * @returns Resolves `InviteMutationResult`; 403; 404; 409 INVITE_NOT_PENDING / ROLE_NOT_FOUND /
 *     ALREADY_A_MEMBER; 429 RATE_LIMITED (≥ 60 s between sends, ≤ 5 per 24 h).
 */
const resendInvite = (identity: IdentityObject, params: InviteIdParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const loaded = await _loadManagedInvite(identity, params !== null && typeof params === 'object' ? params.invite_id : undefined);
            if (!loaded.ok) {
                return resolve(loaded.failure);
            }
            const { principal, invite, role } = loaded;
            const context = requestContextHelper.requestContextOf(params);
            if (role.anomalies.missing_custom_role) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.ROLE_NOT_FOUND, AUTH_MESSAGES.ROLE_NOT_FOUND));
            }
            if (!loaded.decision.allowed) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.FORBIDDEN, AUTH_MESSAGES.FORBIDDEN, { reason: loaded.decision.reason }));
            }
            const member = await userRepository.findByEmail(invite.email);
            if (member) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.ALREADY_A_MEMBER, AUTH_MESSAGES.ALREADY_A_MEMBER, {
                    user_id: String(member._id),
                    status: member.status
                }));
            }
            if (!authTokenService.canBuildLinks()) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.PUBLIC_URL_MISSING, AUTH_MESSAGES.PUBLIC_URL_MISSING));
            }

            const now = new Date();
            const issued = authTokenService.issueToken();
            const updated = await inviteRepository.claimResend({
                invite_id: String(invite._id),
                actor_user_id: principal.user_id,
                token_hash: issued.token_hash,
                expires_at: _inviteExpiry(now),
                throttle: _resendThrottle(now)
            });
            if (!updated) {
                const reread = await inviteRepository.findById(String(invite._id));
                if (!reread || reread.accepted_at || reread.revoked_at) {
                    return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.INVITE_NOT_PENDING, AUTH_MESSAGES.INVITE_NOT_PENDING));
                }
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.RATE_LIMITED, AUTH_MESSAGES.RATE_LIMITED));
            }

            const outcome = await _sendInviteEmail({
                invite: updated,
                token: issued.token,
                actor: principal,
                role_label: role.role_label,
                ip: context.ip,
                now: now
            });
            await auditService.recordAuditEvent(identity, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: principal.user_id,
                actor_email: principal.email,
                action: AUDIT_ACTIONS.INVITE_RESENT,
                target_type: AUDIT_TARGET_TYPES.INVITE,
                target_id: String(updated._id),
                target_email: updated.email,
                ip: context.ip,
                details: { email_status: outcome.status },
                now: now
            });
            const result: InviteMutationResult = {
                invite: _toInviteView({ invite: updated, now: now, role_label: role.role_label, inviter_name: principal.name, decision: loaded.decision }),
                email_sent: outcome.accepted,
                email_status: outcome.status,
                link_host_is_loopback: authTokenService.isLinkHostLoopback()
            };
            const msg = serviceResultHelper.emailOutcomeMessage({
                accepted: outcome.accepted,
                unconfirmed: outcome.unconfirmed,
                success_msg: AUTH_MESSAGES.INVITE_RESENT,
                prefix: AUTH_MESSAGES.INVITE_RESENT_PREFIX,
                mail_msg: outcome.msg,
                retry_hint: AUTH_MESSAGES.EMAIL_RETRY_HINT
            });
            return resolve(promiseHelper.promiseReturnResult(true, result, {}, msg));
        } catch (error) {
            logger.customConsoleError('ERROR: auth invite resendInvite', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `POST /api/invites/:invite_id/revoke` (users:manage). CAS on "still outstanding" (spec A13).
 *
 * @param identity - `{ user_id }` of the actor.
 * @param params - `{ invite_id, request_ip }`.
 * @returns Resolves `{ invite: InviteView }`; 403; 404; 409 INVITE_NOT_PENDING.
 */
const revokeInvite = (identity: IdentityObject, params: InviteIdParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const loaded = await _loadManagedInvite(identity, params !== null && typeof params === 'object' ? params.invite_id : undefined);
            if (!loaded.ok) {
                return resolve(loaded.failure);
            }
            const { principal, invite, role, decision } = loaded;
            if (!decision.allowed) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.FORBIDDEN, AUTH_MESSAGES.FORBIDDEN, { reason: decision.reason }));
            }
            const context = requestContextHelper.requestContextOf(params);
            const now = new Date();
            const revoked = await inviteRepository.revokeInvite({
                invite_id: String(invite._id),
                actor_user_id: principal.user_id,
                reason: INVITE_REVOKE_REASONS.MANUAL,
                now: now
            });
            if (!revoked) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.INVITE_NOT_PENDING, AUTH_MESSAGES.INVITE_NOT_PENDING));
            }
            await auditService.recordAuditEvent(identity, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: principal.user_id,
                actor_email: principal.email,
                action: AUDIT_ACTIONS.INVITE_REVOKED,
                target_type: AUDIT_TARGET_TYPES.INVITE,
                target_id: String(revoked._id),
                target_email: revoked.email,
                ip: context.ip,
                details: { reason: INVITE_REVOKE_REASONS.MANUAL },
                now: now
            });
            const inviter = await userRepository.findById(revoked.invited_by_user_id);
            const view = _toInviteView({
                invite: revoked,
                now: now,
                role_label: role.role_label,
                inviter_name: inviter ? inviter.name : null,
                decision: decision
            });
            return resolve(promiseHelper.promiseReturnResult(true, { invite: view }, {}, AUTH_MESSAGES.INVITE_REVOKED_OK));
        } catch (error) {
            logger.customConsoleError('ERROR: auth invite revokeInvite', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `GET /api/invites` (users:read). Every invite, newest first, with its state computed ONCE
 * (`invite.helper#inviteState`) and `can_manage` / `manage_block_reason` for the requesting actor.
 *
 * @param identity - `{ user_id }` of the actor.
 * @param _params - Unused.
 * @returns Resolves `{ items: InviteView[], mail }` (`mail` = the mail module's status, spec A16).
 */
const listInvites = (identity: IdentityObject, _params?: unknown): Promise<ServiceResult> => {
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
            const invites = await inviteRepository.listInvites();
            const roleIds = Array.from(new Set(invites.filter((invite) => invite.custom_role_id).map((invite) => String(invite.custom_role_id))));
            const inviterIds = Array.from(new Set(invites.map((invite) => String(invite.invited_by_user_id))));
            const roles = await roleRepository.findByIds(roleIds);
            const inviters = await userRepository.findByIds(inviterIds);
            const roleMap = new Map<string, RoleDoc | null>(roleIds.map((id) => [id, null]));
            for (const role of roles) {
                roleMap.set(String(role._id), role);
            }
            const inviterNames = new Map<string, string>(inviters.map((user) => [String(user._id), user.name]));

            const now = new Date();
            const items: InviteView[] = [];
            for (const invite of invites) {
                const role = await _resolveInviteRole(invite, roleMap);
                const decision = _manageDecision(actor.principal, role.permissions);
                items.push(_toInviteView({
                    invite: invite,
                    now: now,
                    role_label: role.role_label,
                    inviter_name: inviterNames.get(String(invite.invited_by_user_id)) || null,
                    decision: decision
                }));
            }
            return resolve(promiseHelper.promiseReturnResult(true, { items: items, mail: mailModule.getMailStatus() }, {}, AUTH_MESSAGES.INVITES_LISTED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth invite listInvites', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * The shared front half of inspect and accept: the live invite for a token, and every condition
 * that must STILL hold — the inviter active, the custom role present, the rule still letting the
 * inviter grant the role. A failed condition REVOKES the invite (it can never become valid again)
 * and answers TOKEN_INVALID.
 *
 * @param token - Raw request value.
 * @param ip - The requesting address (for the revocation's audit row).
 * @returns `{ ok: true, invite, token_hash, role_label, inviter_name }` or `{ ok: false, failure }`.
 */
const _loadAcceptableInvite = async (token: unknown, ip: string | null): Promise<
    { ok: true; invite: InviteDoc; token_hash: string; role_label: string; inviter_name: string } | { ok: false; failure: ServiceResult }
> => {
    const invalid = { ok: false as const, failure: serviceResultHelper.authFailure(AUTH_ERROR_CODES.TOKEN_INVALID, AUTH_MESSAGES.TOKEN_INVALID) };
    if (!tokenHelper.isWellFormedToken(token)) {
        return invalid;
    }
    const now = new Date();
    const tokenHash = tokenHelper.hashToken(token);
    const invite = await inviteRepository.findLiveByTokenHash({ token_hash: tokenHash, now: now });
    if (!invite) {
        const any = await inviteRepository.findAnyByTokenHash({ token_hash: tokenHash });
        const code = tokenHelper.deadLinkCode({ row: any, now: now, revoked_code: 'INVITE_REVOKED' });
        return { ok: false, failure: serviceResultHelper.authFailure(code, AUTH_MESSAGES[code]) };
    }

    const systemActor: AuditActor = { actor_type: AUDIT_ACTOR_TYPES.SYSTEM, actor_user_id: null, actor_email: null };
    const inviter = await userRepository.findById(invite.invited_by_user_id);
    if (!inviter || inviter.status !== USER_STATUSES.ACTIVE) {
        await _revokeAndAudit({ invite: invite, reason: INVITE_REVOKE_REASONS.INVITER_DISABLED, actor: systemActor, ip: ip, now: now });
        logger.customConsoleWarn('WARN: auth: an invite link was used after its inviter lost access — revoked', { invite_id: String(invite._id) });
        return invalid;
    }
    const install: SystemStateDoc | null = await systemStateRepository.findInstallState();
    const inviterPrincipal = await principalService.resolveUserPrincipal({ user: inviter, install: install });
    const role = await _resolveInviteRole(invite);
    if (role.anomalies.missing_custom_role || _storedRoleKey(invite.role_key) === null) {
        await _revokeAndAudit({ invite: invite, reason: INVITE_REVOKE_REASONS.ROLE_DELETED, actor: systemActor, ip: ip, now: now });
        return invalid;
    }
    if (!_inviteDecision(inviterPrincipal, role.permissions).allowed) {
        await _revokeAndAudit({ invite: invite, reason: INVITE_REVOKE_REASONS.INVITER_NO_LONGER_PERMITTED, actor: systemActor, ip: ip, now: now });
        logger.customConsoleWarn('WARN: auth: an invite\'s inviter may no longer grant its role — revoked', { invite_id: String(invite._id) });
        return invalid;
    }
    return { ok: true, invite: invite, token_hash: tokenHash, role_label: role.role_label, inviter_name: inviter.name };
};

/**
 * `POST /api/auth/invites/inspect` (public) `{ token }`.
 *
 * @param _identity - Empty (public).
 * @param params - `{ token, request_ip }`.
 * @returns Resolves `{ email, role_label, invited_by_name, expires_at }`; 400 TOKEN_INVALID /
 *     TOKEN_EXPIRED / TOKEN_USED / INVITE_REVOKED. Never 401.
 */
const inspectInvite = (_identity: Partial<IdentityObject> | null | undefined, params: TokenParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const context = requestContextHelper.requestContextOf(params);
            const loaded = await _loadAcceptableInvite(params !== null && typeof params === 'object' ? params.token : undefined, context.ip);
            if (!loaded.ok) {
                return resolve(loaded.failure);
            }
            const view = {
                email: loaded.invite.email,
                role_label: loaded.role_label,
                invited_by_name: loaded.inviter_name,
                expires_at: loaded.invite.expires_at
            };
            return resolve(promiseHelper.promiseReturnResult(true, view, {}, AUTH_MESSAGES.TOKEN_OK));
        } catch (error) {
            logger.customConsoleError('ERROR: auth invite inspectInvite', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `POST /api/auth/invites/accept` (public) `{ token, name, password }`. Never signs anyone in.
 *
 * Order: shape → indexes ready → the acceptable invite (above) → policy → hash → INSERT the user
 * (unique email ⇒ 409 ALREADY_A_MEMBER) → CAS the invite accepted (lost ⇒ DELETE the user just
 * inserted, 400) → supersede sibling invites → audit.
 *
 * @param _identity - Empty (public).
 * @param params - `{ token, name, password, request_ip, user_agent }`.
 * @returns Resolves `{ accepted: true }` (201); 400 TOKEN_* / VALIDATION / PASSWORD_POLICY;
 *     409 ALREADY_A_MEMBER (code only — the caller is anonymous); 503. Never 401.
 */
const acceptInvite = (_identity: Partial<IdentityObject> | null | undefined, params: AcceptInviteParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const hasParams = params !== null && typeof params === 'object';
            const token = hasParams ? params.token : undefined;
            const password = hasParams ? params.password : undefined;
            if (!tokenHelper.isWellFormedToken(token)) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.TOKEN_INVALID, AUTH_MESSAGES.TOKEN_INVALID));
            }
            const nameCheck = identityHelper.validateName(hasParams ? params.name : undefined);
            if (!nameCheck.ok) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.VALIDATION, nameCheck.reason, { field: 'name' }));
            }
            if (typeof password !== 'string' || password.length === 0) {
                return resolve(serviceResultHelper.passwordPolicyFailure({
                    code: PASSWORD_POLICY_CODES.NOT_A_STRING,
                    reason: PASSWORD_POLICY_MESSAGES.NOT_A_STRING
                }));
            }
            if (!installStateService.areAuthIndexesReady()) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.INDEXES_NOT_READY, AUTH_MESSAGES.INDEXES_NOT_READY));
            }
            const context = requestContextHelper.requestContextOf(params);
            const name = nameCheck.value;

            const loaded = await _loadAcceptableInvite(token, context.ip);
            if (!loaded.ok) {
                return resolve(loaded.failure);
            }
            const invite = loaded.invite;
            const roleKey = _storedRoleKey(invite.role_key);
            if (roleKey === null) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.TOKEN_INVALID, AUTH_MESSAGES.TOKEN_INVALID));
            }
            const policy = passwordHelper.evaluatePasswordPolicy({
                password: password,
                email: invite.email,
                name: name,
                truncates: passwordHashService.passwordTruncates
            });
            if (!policy.ok) {
                return resolve(serviceResultHelper.passwordPolicyFailure(policy));
            }
            const passwordHash = await passwordHashService.hashPassword(password);

            const userId = userRepository.newUserId();
            const now = new Date();
            try {
                await userRepository.insertUser({
                    _id: userId,
                    email: invite.email,
                    name: name,
                    password_hash: passwordHash,
                    role_key: roleKey,
                    custom_role_id: roleKey === ROLE_KEYS.CUSTOM ? invite.custom_role_id : null,
                    email_verified_at: now,
                    password_changed_at: now,
                    invited_by_user_id: invite.invited_by_user_id,
                    created_via: CREATED_VIA.INVITE
                });
            } catch (insertError) {
                if (datastoreErrorHelper.duplicateKeyField(insertError) === 'email') {
                    return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.ALREADY_A_MEMBER, AUTH_MESSAGES.ALREADY_A_MEMBER));
                }
                throw insertError;
            }

            const accepted = await inviteRepository.acceptInvite({
                invite_id: String(invite._id),
                token_hash: loaded.token_hash,
                accepted_user_id: userId,
                now: new Date()
            });
            if (!accepted) {
                // The invite was revoked, re-sent or expired in between: undo the insert (scoped to
                // created_via 'invite', so this can never remove anyone else).
                await userRepository.deleteUnacceptedInviteUser({ user_id: userId });
                const any = await inviteRepository.findAnyByTokenHash({ token_hash: loaded.token_hash });
                const code = tokenHelper.deadLinkCode({ row: any, now: new Date(), revoked_code: 'INVITE_REVOKED' });
                return resolve(serviceResultHelper.authFailure(code, AUTH_MESSAGES[code]));
            }

            try {
                const siblings = await inviteRepository.listOutstanding({ email: invite.email });
                await revokeInvites({
                    invites: siblings.filter((sibling) => String(sibling._id) !== String(invite._id)),
                    reason: INVITE_REVOKE_REASONS.SUPERSEDED,
                    actor: { actor_type: AUDIT_ACTOR_TYPES.USER, actor_user_id: userId, actor_email: invite.email },
                    ip: context.ip,
                    now: now
                });
            } catch (siblingError) {
                // At most one invite per address is outstanding (unique pending_email), so this is belt and braces.
                logger.customConsoleWarn('WARN: auth acceptInvite — could not supersede sibling invites', siblingError);
            }
            await auditService.recordAuditEvent({ user_id: userId }, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: userId,
                actor_email: invite.email,
                action: AUDIT_ACTIONS.INVITE_ACCEPTED,
                target_type: AUDIT_TARGET_TYPES.INVITE,
                target_id: String(invite._id),
                target_email: invite.email,
                ip: context.ip,
                details: { role_label: loaded.role_label },
                now: now
            });
            logger.customConsoleLog('INFO: auth: invitation accepted — account created', { user_id: userId, email: invite.email });
            return resolve(promiseHelper.promiseReturnResult(true, { accepted: true }, {}, AUTH_MESSAGES.INVITE_ACCEPTED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth invite acceptInvite', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

export = {
    createInvite,
    resendInvite,
    revokeInvite,
    listInvites,
    inspectInvite,
    acceptInvite,
    revokeInvites,
    reevaluateOutstandingInvites
};
