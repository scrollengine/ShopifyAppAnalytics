'use strict';

/**
 * ============================================================================
 *  PRINCIPAL LOADING — the reads behind "who is this and what may they do"
 * ============================================================================
 *
 *  `principal.helper#resolvePrincipal` is THE derivation (spec §6, I5); this
 *  file only does the reads it needs — session → user → install → custom role —
 *  on every request, so a revocation, a disable, a role change or an ownership
 *  move takes effect on the NEXT request rather than at token expiry.
 *
 *  Published (barrel):
 *    - `loadPrincipal`         the guard's per-request load, session included.
 *    - `loadPrincipalByUserId` the same without a session.
 *  Internal (other auth services):
 *    - `loadActor`             an admin service re-loads its ACTOR from the
 *                              database by `identity.user_id` — it never trusts
 *                              a principal a controller hands in (spec §6).
 *    - `resolveUserPrincipal`  principal for a user row already read (targets,
 *                              inviters, list rows) — one spelling for all.
 *    - `targetIsOwner`         the management rule's owner test, failing NARROW
 *                              when the install document is missing.
 *    - `requirePermission`     defence in depth behind the route policy.
 *
 *  Failure reasons are `SESSION_FAILURE_REASONS` in `error.code`: every one is
 *  a 401 except DATASTORE_ERROR, which is a 503 (fail closed without signing the
 *  user out). ANY exception while loading is DATASTORE_ERROR.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import authConstants = require('../constants/auth.constants');
import identityHelper = require('../helpers/identity.helper');
import principalHelper = require('../helpers/principal.helper');
import managementHelper = require('../helpers/management.helper');
import serviceResultHelper = require('../helpers/serviceResult.helper');
import userRepository = require('../repositories/user.repository');
import roleRepository = require('../repositories/role.repository');
import authSessionRepository = require('../repositories/authSession.repository');
import systemStateRepository = require('../repositories/systemState.repository');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type { RoleDoc, SystemStateDoc, UserDoc } from '../../shared/types/entity.types';
import type { ExpectedRole, LoadedPrincipal, Principal } from '../types/auth.types';

const { AUTH_MESSAGES, AUTH_ERROR_CODES, SESSION_FAILURE_REASONS, USER_STATUSES, ROLE_KEYS } = authConstants;

/*
 * ⚠️ Return types are the unparameterised `ServiceResult` while each JSDoc `@returns` names the
 * payload — the convention every module here follows: a failure carries `data: {}`, which is not
 * assignable to a payload interface, and `as` is reserved for the models chokepoint. Success
 * payloads are built as TYPED LOCALS so a wrong field is still a compile error.
 */

/**
 * A session epoch as a comparable integer. A row that somehow lacks the field reads as 0 on BOTH
 * sides (the schema default), so a missing field never makes every session stale forever.
 *
 * @param value - `session.epoch` or `user.session_epoch`.
 * @returns The integer, or 0.
 */
const _epochOf = (value: unknown): number => {
    return typeof value === 'number' && Number.isInteger(value) ? value : 0;
};

/**
 * Reads a field off the (identity, params) pair the guard-path functions accept. The canonical form
 * is `(identity, params)`; the spec's single-argument `loadPrincipal({ user_id, session_id })` is
 * accepted too, because a guard written against either spelling must not turn every request into a
 * crash — `params` wins whenever it is given.
 *
 * @param identity - The first argument.
 * @param params - The second argument, possibly absent.
 * @param key - The field to read.
 * @returns The raw value.
 */
const _argField = (identity: unknown, params: unknown, key: string): unknown => {
    const source = params !== undefined && params !== null ? params : identity;
    if (source === null || typeof source !== 'object') {
        return undefined;
    }
    return Reflect.get(source, key);
};

/**
 * The refusal envelope for a principal load.
 *
 * @param reason - One of `SESSION_FAILURE_REASONS`.
 * @returns The envelope (`error.code = reason`).
 */
const _refuse = (reason: string): ServiceResult => {
    const msg = reason === SESSION_FAILURE_REASONS.DATASTORE_ERROR ? AUTH_MESSAGES.SESSION_CHECK_UNAVAILABLE : AUTH_MESSAGES.SESSION_INVALID;
    return serviceResultHelper.authFailure(reason, msg);
};

/**
 * Builds the principal for a user row that has already been read. Reads the custom role when the
 * stored role is `custom` (from `custom_roles` when the caller pre-fetched them, else one query), and
 * LOGS what the stored role got wrong — the principal is already narrowed either way.
 *
 * @param params0 - The parameters object.
 * @param params0.user - The `gi_users` row.
 * @param params0.install - The install document, or `null` (then nobody is the owner — narrow).
 * @param params0.custom_roles - Optional pre-fetched `gi_roles` rows keyed by id (list pages).
 * @returns The frozen principal.
 */
const resolveUserPrincipal = async ({ user, install, custom_roles }: {
    user: UserDoc;
    install: SystemStateDoc | null;
    custom_roles?: ReadonlyMap<string, RoleDoc> | null;
}): Promise<Principal> => {
    let customRole: RoleDoc | null = null;
    if (user.role_key === ROLE_KEYS.CUSTOM && identityHelper.isObjectIdLike(user.custom_role_id)) {
        const roleId = String(user.custom_role_id);
        if (custom_roles) {
            customRole = custom_roles.get(roleId) || null;
        } else {
            customRole = await roleRepository.findById(roleId);
        }
    }
    const resolved = principalHelper.resolvePrincipalWithAnomalies({ user: user, install: install, custom_role: customRole });
    const anomalies = resolved.anomalies;
    if (anomalies.unknown_role_key !== null || anomalies.missing_custom_role || anomalies.dropped_permissions.length > 0) {
        logger.customConsoleWarn('WARN: auth: a stored role did not resolve cleanly — permissions narrowed', {
            user_id: String(user._id),
            unknown_role_key: anomalies.unknown_role_key,
            missing_custom_role: anomalies.missing_custom_role,
            dropped_permissions: anomalies.dropped_permissions
        });
    }
    return resolved.principal;
};

/**
 * The management rule's `target_is_owner`. The install pointer is the only definition — and when
 * the install document is MISSING this answers TRUE ("cannot rule it out"), so every management
 * action is refused rather than letting an admin act on the real owner. Fails narrow (spec A9).
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The target user's id.
 * @param params0.install - The install document, or `null`.
 * @returns Whether the target must be treated as the owner.
 */
const targetIsOwner = ({ user_id, install }: { user_id: string; install: SystemStateDoc | null }): boolean => {
    if (!install) {
        return true;
    }
    return principalHelper.isOwnerUserId({ user_id: user_id, install: install });
};

/**
 * Defence in depth behind the route's `requirePermission`: the service re-checks the key on the
 * principal it re-loaded, so a route that lost its policy still refuses.
 *
 * @param principal - The re-loaded actor.
 * @param key - The catalogue key the action needs.
 * @returns A 403 envelope (`error: { code: 'FORBIDDEN', permission }`), or `null` when held.
 */
const requirePermission = (principal: Principal, key: string): ServiceResult | null => {
    if (principal.permissions.includes(key)) {
        return null;
    }
    return serviceResultHelper.authFailure(AUTH_ERROR_CODES.FORBIDDEN, AUTH_MESSAGES.FORBIDDEN, { permission: key });
};

/**
 * Re-loads the acting user's principal from the database (spec §6: admin services never trust a
 * principal handed in). A missing or disabled actor is SESSION_INVALID (401 — they are no longer
 * signed in in any meaningful sense); a datastore failure is DATASTORE_ERROR (503 — never 403, never
 * 401, spec A9).
 *
 * @param identity - `{ user_id }` from the guard.
 * @returns `{ ok: true, principal, install }` or `{ ok: false, failure }` (an envelope to resolve with).
 */
const loadActor = async (identity: Partial<IdentityObject> | null | undefined): Promise<
    { ok: true; principal: Principal; install: SystemStateDoc | null } | { ok: false; failure: ServiceResult }
> => {
    const userId = identity && typeof identity === 'object' ? identity.user_id : undefined;
    if (!identityHelper.isObjectIdString(userId)) {
        return { ok: false, failure: serviceResultHelper.authFailure(AUTH_ERROR_CODES.SESSION_INVALID, AUTH_MESSAGES.SESSION_INVALID) };
    }
    try {
        const user = await userRepository.findById(userId);
        if (!user || user.status !== USER_STATUSES.ACTIVE) {
            logger.customConsoleWarn('WARN: auth: acting user is missing or disabled — refusing the action', { user_id: userId });
            return { ok: false, failure: serviceResultHelper.authFailure(AUTH_ERROR_CODES.SESSION_INVALID, AUTH_MESSAGES.SESSION_INVALID) };
        }
        const install = await systemStateRepository.findInstallState();
        const principal = await resolveUserPrincipal({ user: user, install: install });
        return { ok: true, principal: principal, install: install };
    } catch (error) {
        logger.customConsoleError('ERROR: auth principal loadActor — could not re-load the acting user', error);
        return {
            ok: false,
            failure: serviceResultHelper.authFailure(AUTH_ERROR_CODES.DATASTORE_ERROR, AUTH_MESSAGES.DATASTORE_ERROR)
        };
    }
};

/**
 * Reads a management TARGET and applies THE management rule to it (spec §5) — the one front half of
 * role change, disable, enable, sessions revoke and admin password reset.
 *
 * @param params0 - The parameters object.
 * @param params0.actor - The re-loaded acting principal.
 * @param params0.install - The install document the actor was loaded with (`null` ⇒ every target
 *     counts as possibly the owner — refused, narrow).
 * @param params0.user_id - Raw target id from the path (404 unless 24-hex and present).
 * @param params0.new_permissions - The role being assigned, for a role change.
 * @returns `{ ok: true, target, target_principal, expected_role }` — `expected_role` is what the
 *     write's CAS must re-assert — or `{ ok: false, failure }` (404 NOT_FOUND / 403 FORBIDDEN with `reason`).
 */
const loadManagedTarget = async ({ actor, install, user_id, new_permissions }: {
    actor: Principal;
    install: SystemStateDoc | null;
    user_id: unknown;
    new_permissions?: readonly string[] | null;
}): Promise<
    { ok: true; target: UserDoc; target_principal: Principal; expected_role: ExpectedRole } | { ok: false; failure: ServiceResult }
> => {
    const notFound = { ok: false as const, failure: serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, AUTH_MESSAGES.NOT_FOUND) };
    if (!identityHelper.isObjectIdString(user_id)) {
        return notFound;
    }
    const target = await userRepository.findById(user_id);
    if (!target) {
        return notFound;
    }
    const targetPrincipal = await resolveUserPrincipal({ user: target, install: install });
    const decision = managementHelper.evaluateManagement({
        actor: actor,
        target_is_owner: targetIsOwner({ user_id: user_id, install: install }),
        target_user_id: user_id,
        target_permissions: targetPrincipal.permissions,
        new_permissions: new_permissions === undefined ? null : new_permissions
    });
    if (!decision.allowed) {
        return {
            ok: false,
            failure: serviceResultHelper.authFailure(AUTH_ERROR_CODES.FORBIDDEN, AUTH_MESSAGES.FORBIDDEN, { reason: decision.reason })
        };
    }
    return {
        ok: true,
        target: target,
        target_principal: targetPrincipal,
        expected_role: {
            role_key: target.role_key,
            custom_role_id: target.custom_role_id === undefined ? null : target.custom_role_id
        }
    };
};

/**
 * THE GUARD'S PER-REQUEST LOAD (spec §6, A4, A9). Order: session (exists, belongs to `user_id`, not
 * revoked, not expired) → user (exists, active, `session_epoch` equals the session's epoch) →
 * install (missing ⇒ nobody is the owner) → custom role → `resolvePrincipal`.
 *
 * Accepts `(identity, { user_id, session_id })` or the single-argument `({ user_id, session_id })`.
 *
 * @param identity - Unused beyond the single-argument form (the guard has no identity yet).
 * @param params - `{ user_id, session_id }` from `verifySessionToken`.
 * @returns Resolves `LoadedPrincipal` (`{ principal, session: { session_id, expires_at } }`), or
 *     `status: false` with `error.code` one of `SESSION_FAILURE_REASONS` (DATASTORE_ERROR ⇒ 503, the rest ⇒ 401).
 */
const loadPrincipal = (identity: unknown, params?: unknown): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        const userId = _argField(identity, params, 'user_id');
        const sessionId = _argField(identity, params, 'session_id');
        if (!identityHelper.isObjectIdString(userId) || !identityHelper.isObjectIdString(sessionId)) {
            return resolve(_refuse(SESSION_FAILURE_REASONS.NO_SESSION));
        }
        try {
            const now = new Date();
            const session = await authSessionRepository.findById(sessionId);
            if (!session) {
                return resolve(_refuse(SESSION_FAILURE_REASONS.NO_SESSION));
            }
            if (String(session.user_id) !== userId) {
                logger.customConsoleWarn('WARN: auth: a session was presented with another user\'s id', { session_id: sessionId, user_id: userId });
                return resolve(_refuse(SESSION_FAILURE_REASONS.SESSION_USER_MISMATCH));
            }
            if (session.revoked_at) {
                return resolve(_refuse(SESSION_FAILURE_REASONS.SESSION_REVOKED));
            }
            const expiresAt = session.expires_at instanceof Date ? session.expires_at : null;
            if (!expiresAt || !(expiresAt.getTime() > now.getTime())) {
                return resolve(_refuse(SESSION_FAILURE_REASONS.SESSION_EXPIRED));
            }

            const user = await userRepository.findById(userId);
            if (!user) {
                return resolve(_refuse(SESSION_FAILURE_REASONS.NO_USER));
            }
            if (user.status !== USER_STATUSES.ACTIVE) {
                return resolve(_refuse(SESSION_FAILURE_REASONS.USER_DISABLED));
            }
            if (_epochOf(session.epoch) !== _epochOf(user.session_epoch)) {
                return resolve(_refuse(SESSION_FAILURE_REASONS.SESSION_STALE));
            }

            const install = await systemStateRepository.findInstallState();
            const principal = await resolveUserPrincipal({ user: user, install: install });
            const loaded: LoadedPrincipal = {
                principal: principal,
                session: { session_id: sessionId, expires_at: expiresAt }
            };
            return resolve(promiseHelper.promiseReturnResult(true, loaded, {}, AUTH_MESSAGES.SESSION_OK));
        } catch (error) {
            logger.customConsoleError('ERROR: auth principal loadPrincipal — datastore read failed; refusing (503)', error);
            return resolve(_refuse(SESSION_FAILURE_REASONS.DATASTORE_ERROR));
        }
    });
};

/**
 * Loads a principal by user id alone — no session. Accepts `(identity, { user_id })` or
 * `({ user_id })`.
 *
 * @param identity - Unused beyond the single-argument form.
 * @param params - `{ user_id }`.
 * @returns Resolves `{ principal }`, or `status: false` with `error.code` NO_USER / USER_DISABLED
 *     (401) or DATASTORE_ERROR (503).
 */
const loadPrincipalByUserId = (identity: unknown, params?: unknown): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        const userId = _argField(identity, params, 'user_id');
        if (!identityHelper.isObjectIdString(userId)) {
            return resolve(_refuse(SESSION_FAILURE_REASONS.NO_USER));
        }
        try {
            const user = await userRepository.findById(userId);
            if (!user) {
                return resolve(_refuse(SESSION_FAILURE_REASONS.NO_USER));
            }
            if (user.status !== USER_STATUSES.ACTIVE) {
                return resolve(_refuse(SESSION_FAILURE_REASONS.USER_DISABLED));
            }
            const install = await systemStateRepository.findInstallState();
            const principal = await resolveUserPrincipal({ user: user, install: install });
            const loaded: { principal: Principal } = { principal: principal };
            return resolve(promiseHelper.promiseReturnResult(true, loaded, {}, AUTH_MESSAGES.SESSION_OK));
        } catch (error) {
            logger.customConsoleError('ERROR: auth principal loadPrincipalByUserId — datastore read failed', error);
            return resolve(_refuse(SESSION_FAILURE_REASONS.DATASTORE_ERROR));
        }
    });
};

export = {
    loadPrincipal,
    loadPrincipalByUserId,
    loadActor,
    resolveUserPrincipal,
    targetIsOwner,
    requirePermission,
    loadManagedTarget
};
