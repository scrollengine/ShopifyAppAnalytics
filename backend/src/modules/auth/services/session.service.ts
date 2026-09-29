'use strict';

/**
 * ============================================================================
 *  SESSIONS — sign in, verify a session token, sign out
 * ============================================================================
 *
 *  A session is a `gi_auth_sessions` row plus a JWT that names it (spec I4):
 *  HS256, `sub` = user id, `sid` = session id, `aud` = 'shopify-app-analytics',
 *  `exp` from AUTH_TOKEN_TTL_HOURS. The JWT carries IDS ONLY — never an email, a
 *  role or a permission; every request re-reads session + user + install + role
 *  (`principal.service#loadPrincipal`). A token without `sid`/`aud` (every
 *  single-operator-build token) is refused.
 *
 *  ── Sign-in failures are indistinguishable ──────────────────────────────────
 *  Unknown email, wrong password and disabled user answer the SAME message
 *  after the SAME work: one bcrypt comparison at the configured cost (against a
 *  dummy hash when there is no account — `passwordHash.service#verifyPassword`).
 *  A server fault is a 500, never a 401: the login limiter charges 401s only.
 *
 *  ── Session epoch (spec A4) ─────────────────────────────────────────────────
 *  Sign-in copies `session_epoch` from the SAME user read the bcrypt comparison
 *  used. A reset/disable/sign-out-everywhere that commits between that read and
 *  the session insert bumps the epoch, so the late session is refused as
 *  SESSION_STALE on its first request.
 * ============================================================================
 */

import jwt = require('jsonwebtoken');
import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import authConstants = require('../constants/auth.constants');
import auditConstants = require('../constants/audit.constants');
import identityHelper = require('../helpers/identity.helper');
import tokenHelper = require('../helpers/token.helper');
import requestContextHelper = require('../helpers/requestContext.helper');
import serviceResultHelper = require('../helpers/serviceResult.helper');
import userRepository = require('../repositories/user.repository');
import authSessionRepository = require('../repositories/authSession.repository');
import passwordHashService = require('./passwordHash.service');
import loginDeviceService = require('./loginDevice.service');
import auditService = require('./audit.service');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type {
    FreshSessionToken,
    FreshSessionWithCount,
    LoginParams,
    LoginResult,
    SessionParams,
    VerifiedSessionToken
} from '../types/auth.types';

const {
    AUTH_MESSAGES,
    AUTH_ERROR_CODES,
    USER_STATUSES,
    JWT_AUDIENCE,
    TOKEN_ALGORITHM,
    SESSION_SIGNING_KEY_LABEL,
    SESSION_REVOKE_REASONS,
    AUDIT_ACTOR_TYPES,
    AUDIT_TARGET_TYPES
} = authConstants;
const { AUDIT_ACTIONS } = auditConstants;

/** Why a sign-in failed — the AUDIT LOG may say which (it is read by admins, not by the guesser). */
const LOGIN_FAILURE_REASONS = Object.freeze({
    UNKNOWN_EMAIL: 'UNKNOWN_EMAIL',
    WRONG_PASSWORD: 'WRONG_PASSWORD',
    USER_DISABLED: 'USER_DISABLED'
} as const);

/**
 * Session lifetime in seconds from `AUTH_TOKEN_TTL_HOURS`, or 0 when unusable. A non-positive TTL
 * mints a token that is already expired ("I sign in and am immediately signed out"), so the caller
 * refuses to sign and says why in the log instead.
 *
 * @returns Seconds, or 0.
 */
const _resolveTokenTtlSeconds = (): number => {
    const hours = config.AUTH.TOKEN_TTL_HOURS;
    if (!Number.isFinite(hours) || hours <= 0) {
        return 0;
    }
    return Math.floor(hours * 60 * 60);
};

/**
 * The key session JWTs are signed and verified with: derived from JWT_SECRET, never the secret
 * itself (see `SESSION_SIGNING_KEY_LABEL` — it is what stops a rolled-back single-operator build
 * from accepting this build's tokens). Derived per call so a test that swaps the secret is honoured.
 *
 * @returns The HS256 key.
 */
const sessionSigningKey = (): Buffer => {
    return tokenHelper.deriveSigningKey(config.AUTH.JWT_SECRET, SESSION_SIGNING_KEY_LABEL);
};

/**
 * An epoch as an integer (a row lacking the field reads as 0, matching `principal.service`).
 *
 * @param value - `user.session_epoch`.
 * @returns The integer, or 0.
 */
const _epochOf = (value: unknown): number => {
    return typeof value === 'number' && Number.isInteger(value) ? value : 0;
};

/**
 * Inserts a session row and signs the JWT that names it. The ONE place a session token is minted:
 * sign-in, and the fresh session change-password and revoke-others hand back (spec A4).
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user.
 * @param params0.epoch - `session_epoch` from the user read the caller made (sign-in: the SAME read as the bcrypt compare).
 * @param params0.ip - Client address (validated) or `null`.
 * @param params0.user_agent - User-Agent (capped) or `null`.
 * @param params0.now - Issue instant.
 * @returns `{ token, expires_at, expires_in_seconds, session_id }`.
 * @throws When AUTH_TOKEN_TTL_HOURS is unusable, or on a datastore / signing error.
 */
const issueSessionToken = async ({ user_id, epoch, ip, user_agent, now }: {
    user_id: string;
    epoch: number;
    ip: string | null;
    user_agent: string | null;
    now: Date;
}): Promise<FreshSessionToken & { session_id: string }> => {
    const ttlSeconds = _resolveTokenTtlSeconds();
    if (!ttlSeconds) {
        throw new Error('AUTH_TOKEN_TTL_HOURS must be at least 1; refusing to issue an already-expired token');
    }
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const session = await authSessionRepository.insertSession({
        user_id: user_id,
        epoch: _epochOf(epoch),
        expires_at: expiresAt,
        ip: ip,
        user_agent: user_agent
    });
    const sessionId = String(session._id);
    const token = jwt.sign(
        { sid: sessionId },
        sessionSigningKey(),
        {
            algorithm: TOKEN_ALGORITHM,
            expiresIn: ttlSeconds,
            subject: user_id,
            audience: JWT_AUDIENCE
        }
    );
    return { token: token, expires_at: expiresAt, expires_in_seconds: ttlSeconds, session_id: sessionId };
};

/**
 * `POST /api/auth/login` (public). Exchanges an email and password for a session token.
 *
 * @param _identity - Empty: establishing an identity is what this call does.
 * @param params - `{ email, password, request_ip, user_agent }`.
 * @returns Resolves `LoginResult` (`{ token, expires_in_seconds, expires_at, user_id, email, device_token }`);
 *     400 CREDENTIALS_REQUIRED; 401 INVALID_CREDENTIALS (one message for every cause);
 *     500 INTERNAL_ERROR / 503 DATASTORE_ERROR on a server fault (never 401).
 */
const login = (_identity: Partial<IdentityObject> | null | undefined, params: LoginParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const hasParams = params !== null && typeof params === 'object';
            const email = identityHelper.normaliseEmail(hasParams ? params.email : undefined);
            const password = hasParams ? params.password : undefined;
            if (!email || typeof password !== 'string' || password.length === 0) {
                // Not an oracle: it describes the request, which the caller already knows.
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.CREDENTIALS_REQUIRED, AUTH_MESSAGES.CREDENTIALS_REQUIRED));
            }
            const context = requestContextHelper.requestContextOf(params);

            if (!_resolveTokenTtlSeconds()) {
                // Checked BEFORE the credential comparison, so a broken TTL cannot be probed as a
                // credential answer: every sign-in fails the same way, and the log names the cause.
                logger.customConsoleError('ERROR: auth login — AUTH_TOKEN_TTL_HOURS must be at least 1; refusing to issue an already-expired token', {
                    configured_hours: config.AUTH.TOKEN_TTL_HOURS
                });
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.INTERNAL_ERROR, AUTH_MESSAGES.LOGIN_FAILED));
            }

            const user = await userRepository.findByEmailWithHash(email);
            const storedHash = user && typeof user.password_hash === 'string' ? user.password_hash : null;
            const matches = await passwordHashService.verifyPassword(password, storedHash);

            let failure: string | null = null;
            if (!user) {
                failure = LOGIN_FAILURE_REASONS.UNKNOWN_EMAIL;
            } else if (!matches) {
                failure = LOGIN_FAILURE_REASONS.WRONG_PASSWORD;
            } else if (user.status !== USER_STATUSES.ACTIVE) {
                failure = LOGIN_FAILURE_REASONS.USER_DISABLED;
            }
            if (failure !== null || !user || !storedHash) {
                // ONE branch for every cause, so no second message can drift from this one. The log
                // and the audit row may be specific — they are read by the operator, not the guesser.
                logger.customConsoleWarn('WARN: auth: failed sign-in', { email: email, reason: failure });
                await auditService.recordAuditEvent({}, {
                    actor_type: AUDIT_ACTOR_TYPES.ANONYMOUS,
                    actor_email: email,
                    action: AUDIT_ACTIONS.LOGIN_FAILED,
                    target_type: user ? AUDIT_TARGET_TYPES.USER : null,
                    target_id: user ? String(user._id) : null,
                    ip: context.ip,
                    details: { reason: failure }
                });
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.INVALID_CREDENTIALS, AUTH_MESSAGES.INVALID_CREDENTIALS));
            }

            const userId = String(user._id);
            const now = new Date();
            // The epoch comes from the SAME read the bcrypt comparison used (spec A4).
            const issued = await issueSessionToken({
                user_id: userId,
                epoch: _epochOf(user.session_epoch),
                ip: context.ip,
                user_agent: context.user_agent,
                now: now
            });

            // Best-effort bookkeeping: neither may refuse a session already legitimately established.
            try {
                await userRepository.touchLastLogin({ user_id: userId, now: now });
            } catch (touchError) {
                logger.customConsoleWarn('WARN: auth: could not record last_login_at — the sign-in itself succeeded', touchError);
            }
            try {
                if (passwordHashService.needsRehash(storedHash)) {
                    const rehashed = await passwordHashService.hashPassword(password);
                    const replaced = await userRepository.rehashPassword({
                        user_id: userId,
                        current_password_hash: storedHash,
                        password_hash: rehashed
                    });
                    logger.customConsoleLog('INFO: auth: rehashed a password at the configured bcrypt cost', { user_id: userId, replaced: replaced });
                }
            } catch (rehashError) {
                logger.customConsoleWarn('WARN: auth: could not rehash at the configured cost — the sign-in itself succeeded', rehashError);
            }

            await auditService.recordAuditEvent({ user_id: userId }, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: userId,
                actor_email: user.email,
                action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
                target_type: AUDIT_TARGET_TYPES.SESSION,
                target_id: issued.session_id,
                ip: context.ip,
                now: now
            });
            logger.customConsoleLog('INFO: auth: signed in', { email: user.email, user_id: userId });

            // Built field by field — a spread of the user row is how a hash reaches the wire.
            // `device_token` gives this browser its own sign-in budget next time (see
            // helpers/loginDevice.helper); bound to the email THIS request submitted.
            const result: LoginResult = {
                token: issued.token,
                expires_in_seconds: issued.expires_in_seconds,
                expires_at: issued.expires_at,
                user_id: userId,
                email: user.email,
                device_token: loginDeviceService.issueLoginDeviceToken({ email: email, now: now })
            };
            return resolve(promiseHelper.promiseReturnResult(true, result, {}, AUTH_MESSAGES.LOGIN_OK));
        } catch (error) {
            logger.customConsoleError('ERROR: auth session login', error);
            const failure = serviceResultHelper.exceptionFailure(error);
            failure.msg = AUTH_MESSAGES.LOGIN_FAILED;
            return resolve(failure);
        }
    });
};

/**
 * Verifies a session JWT (spec I4): signature, `alg` pinned to HS256, `aud` pinned, `exp` present
 * and in the future, `sub` and `sid` both 24-hex. Checks the TOKEN only — the session row, the user
 * and the epoch are `loadPrincipal`'s job, on the same request.
 *
 * Every refusal is the same SESSION_INVALID (401); the debug log says which, the caller never does.
 * Accepts `(identity, { token })` or a bare token string as the first argument.
 *
 * @param identity - Unused (or the token itself, in the single-argument form).
 * @param params - `{ token }` — the raw JWT, `Bearer ` stripped.
 * @returns Resolves `VerifiedSessionToken` (`{ user_id, session_id, expires_at }`), or 401 SESSION_INVALID.
 */
const verifySessionToken = (identity: unknown, params?: unknown): Promise<ServiceResult> => {
    return new Promise((resolve) => {
        const refuse = (why: string): void => {
            logger.customConsoleDebug('DEBUG: auth: session token refused', { reason: why });
            resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SESSION_INVALID, AUTH_MESSAGES.SESSION_INVALID));
        };
        try {
            let token: unknown = undefined;
            if (params !== undefined && params !== null && typeof params === 'object') {
                token = Reflect.get(params, 'token');
            } else if (typeof identity === 'string') {
                token = identity;
            }
            if (typeof token !== 'string' || token.length === 0) {
                return refuse('no token');
            }

            const decoded = jwt.verify(token, sessionSigningKey(), {
                algorithms: [TOKEN_ALGORITHM],
                audience: JWT_AUDIENCE
            });
            if (!decoded || typeof decoded === 'string') {
                return refuse('payload is not an object');
            }
            const subject: unknown = decoded.sub;
            const sessionId: unknown = Reflect.get(decoded, 'sid');
            if (!identityHelper.isObjectIdString(subject) || !identityHelper.isObjectIdString(sessionId)) {
                // Every single-operator-build token lands here: it has no `sid` (and no `aud`).
                return refuse('sub or sid missing or malformed');
            }
            if (typeof decoded.exp !== 'number') {
                return refuse('no exp');
            }
            const verified: VerifiedSessionToken = {
                user_id: subject,
                session_id: sessionId,
                expires_at: new Date(decoded.exp * 1000)
            };
            return resolve(promiseHelper.promiseReturnResult(true, verified, {}, AUTH_MESSAGES.SESSION_OK));
        } catch (error) {
            // Expired and tampered tokens are routine; debug-level, so a probe cannot fill the disk.
            return refuse(error instanceof Error ? error.message : 'verify threw');
        }
    });
};

/**
 * `POST /api/account/logout` (@self). Revokes the CURRENT session only (reason LOGOUT, no epoch
 * bump). Idempotent: an already-revoked session still answers 200.
 *
 * @param identity - `{ user_id }` from the guard.
 * @param params - `{ session_id, request_ip, user_agent }` — `session_id` is `req.auth.session_id`.
 * @returns Resolves `{ revoked: boolean }`.
 */
const logout = (identity: IdentityObject, params: SessionParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const userId = identity && identity.user_id;
            const sessionId = params && typeof params === 'object' ? params.session_id : undefined;
            if (!identityHelper.isObjectIdString(userId) || !identityHelper.isObjectIdString(sessionId)) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SESSION_INVALID, AUTH_MESSAGES.SESSION_INVALID));
            }
            const context = requestContextHelper.requestContextOf(params);
            const now = new Date();
            const revoked = await authSessionRepository.revokeSession({
                session_id: sessionId,
                user_id: userId,
                reason: SESSION_REVOKE_REASONS.LOGOUT,
                now: now
            });
            if (revoked) {
                await auditService.recordAuditEvent(identity, {
                    actor_type: AUDIT_ACTOR_TYPES.USER,
                    actor_user_id: userId,
                    action: AUDIT_ACTIONS.LOGOUT,
                    target_type: AUDIT_TARGET_TYPES.SESSION,
                    target_id: sessionId,
                    ip: context.ip,
                    now: now
                });
            }
            return resolve(promiseHelper.promiseReturnResult(true, { revoked: Boolean(revoked) }, {}, AUTH_MESSAGES.LOGGED_OUT));
        } catch (error) {
            logger.customConsoleError('ERROR: auth session logout', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * Ends every OTHER session of a user after their epoch was bumped, and hands the caller a fresh
 * session carrying the new epoch (spec A4) — shared by change-password and revoke-others.
 *
 * Order: mark the other rows revoked (the count reported) → mint the fresh session → mark the
 * caller's old row revoked too (it is already dead by epoch; this is the audit trail). A crash after
 * the bump leaves the caller signed out, never a stale session alive.
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user.
 * @param params0.epoch - The user's NEW `session_epoch` (from the bumping write's returned row).
 * @param params0.current_session_id - The caller's session (`req.auth.session_id`), or anything else when unknown.
 * @param params0.reason - PASSWORD_CHANGED or SELF_REVOKED.
 * @param params0.ip - Client address or `null`.
 * @param params0.user_agent - User-Agent or `null`.
 * @param params0.now - The instant.
 * @returns The fresh token and how many OTHER sessions were revoked.
 */
const rotateAfterEpochBump = async ({ user_id, epoch, current_session_id, reason, ip, user_agent, now }: {
    user_id: string;
    epoch: number;
    current_session_id: unknown;
    reason: string;
    ip: string | null;
    user_agent: string | null;
    now: Date;
}): Promise<FreshSessionWithCount> => {
    const currentId = identityHelper.isObjectIdString(current_session_id) ? current_session_id : null;
    const revoked = await authSessionRepository.revokeAllForUser({
        user_id: user_id,
        reason: reason,
        now: now,
        except_session_id: currentId === null ? undefined : currentId
    });
    const fresh = await issueSessionToken({ user_id: user_id, epoch: epoch, ip: ip, user_agent: user_agent, now: now });
    if (currentId !== null) {
        await authSessionRepository.revokeSession({ session_id: currentId, user_id: user_id, reason: reason, now: now });
    }
    return {
        token: fresh.token,
        expires_at: fresh.expires_at,
        expires_in_seconds: fresh.expires_in_seconds,
        revoked: revoked
    };
};

/**
 * `POST /api/account/sessions/revoke-others` (@self, spec A16). Bumps the caller's epoch (every
 * session dies), marks the other rows revoked (reason SELF_REVOKED), and returns a FRESH token the
 * frontend must store — the one it holds is dead from this moment.
 *
 * @param identity - `{ user_id }` from the guard.
 * @param params - `{ session_id, request_ip, user_agent }`.
 * @returns Resolves `FreshSessionWithCount` (`{ token, expires_at, expires_in_seconds, revoked }`).
 */
const revokeOtherSessions = (identity: IdentityObject, params: SessionParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const userId = identity && identity.user_id;
            if (!identityHelper.isObjectIdString(userId)) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SESSION_INVALID, AUTH_MESSAGES.SESSION_INVALID));
            }
            const context = requestContextHelper.requestContextOf(params);
            const now = new Date();
            const bumped = await userRepository.bumpSessionEpoch({ user_id: userId });
            if (!bumped || bumped.status !== USER_STATUSES.ACTIVE) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SESSION_INVALID, AUTH_MESSAGES.SESSION_INVALID));
            }
            const rotated = await rotateAfterEpochBump({
                user_id: userId,
                epoch: _epochOf(bumped.session_epoch),
                current_session_id: params && typeof params === 'object' ? params.session_id : undefined,
                reason: SESSION_REVOKE_REASONS.SELF_REVOKED,
                ip: context.ip,
                user_agent: context.user_agent,
                now: now
            });
            await auditService.recordAuditEvent(identity, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: userId,
                actor_email: bumped.email,
                action: AUDIT_ACTIONS.SESSIONS_SELF_REVOKED,
                target_type: AUDIT_TARGET_TYPES.USER,
                target_id: userId,
                ip: context.ip,
                details: { count: rotated.revoked },
                now: now
            });
            return resolve(promiseHelper.promiseReturnResult(true, rotated, {}, AUTH_MESSAGES.SESSIONS_SELF_REVOKED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth session revokeOtherSessions', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

export = {
    login,
    verifySessionToken,
    logout,
    revokeOtherSessions,
    issueSessionToken,
    rotateAfterEpochBump,
    sessionSigningKey
};
