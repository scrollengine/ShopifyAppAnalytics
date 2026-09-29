'use strict';

/**
 * ============================================================================
 *  PASSWORDS — forgot, reset, change, and the admin-sent reset
 * ============================================================================
 *
 *  Forgot-password answers the SAME 202 whether or not an account exists
 *  (spec I7). Per A6 the response path does only shape validation; ONE deferred
 *  job does the lookup, the throttle (a CAS on the user row — A16), the token,
 *  the audit row and the send.
 *
 *  Every password write goes through `user.repository#updatePassword`, which
 *  bumps `session_epoch` in the SAME update (spec A4): every session minted
 *  before it is refused from the next request on. Session rows are ALSO marked
 *  revoked, for the audit trail.
 *
 *  A reset link is refused when the password changed after it was issued
 *  (`password_changed_at < token.createdAt`, re-asserted by the write's CAS), so
 *  an old link cannot undo a newer change.
 *
 *  Nothing here signs anyone in, except change-password, which hands the caller
 *  a FRESH session carrying the new epoch (their old token is dead).
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
import requestContextHelper = require('../helpers/requestContext.helper');
import serviceResultHelper = require('../helpers/serviceResult.helper');
import userRepository = require('../repositories/user.repository');
import authTokenRepository = require('../repositories/authToken.repository');
import authSessionRepository = require('../repositories/authSession.repository');
import authTokenService = require('./authToken.service');
import authMailService = require('./authMail.service');
import passwordHashService = require('./passwordHash.service');
import principalService = require('./principal.service');
import sessionService = require('./session.service');
import auditService = require('./audit.service');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type {
    ChangePasswordParams,
    ForgotPasswordParams,
    PasswordResetSentResult,
    ResetPasswordParams,
    SendSlotThrottle,
    UserIdParams
} from '../types/auth.types';

const {
    AUTH_MESSAGES,
    AUTH_ERROR_CODES,
    USER_STATUSES,
    TOKEN_PURPOSES,
    SESSION_REVOKE_REASONS,
    AUDIT_ACTOR_TYPES,
    AUDIT_TARGET_TYPES,
    AUTH_SERVICE_ACTORS,
    PASSWORD_POLICY_CODES,
    PASSWORD_POLICY_MESSAGES,
    PASSWORD_RESET_MIN_INTERVAL_MS,
    PASSWORD_RESET_MAX_PER_WINDOW,
    PASSWORD_RESET_WINDOW_MS,
    RESET_SEND_LOG_KEEP
} = authConstants;
const { AUDIT_ACTIONS } = auditConstants;
const { PERMISSIONS } = permissionsConstants;

const ANONYMOUS_IDENTITY = Object.freeze({ user_id: AUTH_SERVICE_ACTORS.ANONYMOUS });

/**
 * What a forgot-password request came to. Logged and audited, never answered. LINK_ISSUED means a
 * link was created and handed to the mail module; what the mail server said is the audit row's
 * separate `email_status` — "sent" is not something this step can know.
 */
const RESET_REQUEST_OUTCOMES = Object.freeze({
    LINK_ISSUED: 'LINK_ISSUED',
    NO_ACTIVE_ACCOUNT: 'NO_ACTIVE_ACCOUNT',
    THROTTLED: 'THROTTLED',
    NO_LINK: 'NO_LINK',
    FAILED: 'FAILED'
} as const);

/**
 * The reset-send throttle (spec §7.4 + A16): ≥ 60 s between sends, ≤ 3 per rolling hour.
 *
 * @param now - The instant.
 * @returns The throttle for `claimResetSendSlot`.
 */
const _resetThrottle = (now: Date): SendSlotThrottle => {
    return {
        now: now,
        min_interval_ms: PASSWORD_RESET_MIN_INTERVAL_MS,
        max_per_window: PASSWORD_RESET_MAX_PER_WINDOW,
        window_ms: PASSWORD_RESET_WINDOW_MS,
        keep: RESET_SEND_LOG_KEEP
    };
};

/**
 * The 400 for a password that is absent or not a string (checked before any database work).
 *
 * @returns The envelope.
 */
const _missingPassword = (): ServiceResult => {
    return serviceResultHelper.passwordPolicyFailure({ code: PASSWORD_POLICY_CODES.NOT_A_STRING, reason: PASSWORD_POLICY_MESSAGES.NOT_A_STRING });
};

/**
 *  THE DEFERRED HALF OF FORGOT-PASSWORD (spec A6). Never throws.
 *
 * @param params0 - The parameters object.
 * @param params0.email - The validated, lowercased address as typed.
 * @param params0.ip - The requesting address.
 * @returns Resolves the outcome (for tests); never rejects.
 */
const processPasswordResetRequest = async ({ email, ip }: { email: string; ip: string | null }): Promise<string> => {
    const now = new Date();
    const audit = async (outcome: string, userId: string | null, emailStatus?: string): Promise<void> => {
        const details: Record<string, unknown> = { outcome: outcome };
        if (emailStatus !== undefined) {
            details.email_status = emailStatus;
        }
        await auditService.recordAuditEvent(ANONYMOUS_IDENTITY, {
            actor_type: AUDIT_ACTOR_TYPES.ANONYMOUS,
            actor_email: email,
            action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
            target_type: userId ? AUDIT_TARGET_TYPES.USER : null,
            target_id: userId,
            ip: ip,
            details: details,
            now: now
        });
    };
    try {
        const user = await userRepository.findByEmail(email);
        if (!user || user.status !== USER_STATUSES.ACTIVE) {
            logger.customConsoleLog('INFO: auth: password reset requested for an address with no active account — nothing sent', {
                email: email,
                account_exists: Boolean(user)
            });
            await audit(RESET_REQUEST_OUTCOMES.NO_ACTIVE_ACCOUNT, user ? String(user._id) : null);
            return RESET_REQUEST_OUTCOMES.NO_ACTIVE_ACCOUNT;
        }
        const userId = String(user._id);
        if (!authTokenService.canBuildLinks()) {
            logger.customConsoleError('ERROR: auth: password reset requested but APP_PUBLIC_URL is unusable — nothing sent', { user_id: userId });
            await audit(RESET_REQUEST_OUTCOMES.NO_LINK, userId);
            return RESET_REQUEST_OUTCOMES.NO_LINK;
        }
        const slot = await userRepository.claimResetSendSlot({ user_id: userId, throttle: _resetThrottle(now) });
        if (!slot) {
            logger.customConsoleLog('INFO: auth: password reset throttled for this account — nothing sent', { user_id: userId });
            await audit(RESET_REQUEST_OUTCOMES.THROTTLED, userId);
            return RESET_REQUEST_OUTCOMES.THROTTLED;
        }
        const issued = await authTokenService.issueResetLink({
            user_id: userId,
            email: slot.email,
            minutes: config.AUTH.PASSWORD_RESET_TTL_MINUTES,
            setting: 'AUTH_PASSWORD_RESET_TTL_MINUTES',
            request_ip: ip,
            now: now
        });
        if (!issued) {
            await audit(RESET_REQUEST_OUTCOMES.NO_LINK, userId);
            return RESET_REQUEST_OUTCOMES.NO_LINK;
        }
        const outcome = await authMailService.sendAuthEmail({
            identity: ANONYMOUS_IDENTITY,
            to: slot.email,
            template: mailModule.EMAIL_TEMPLATES.PASSWORD_RESET,
            vars: { now: now, expires_at: issued.expires_at, link: issued.link, ip: ip },
            trigger: mailModule.MAIL_TRIGGERS.ANONYMOUS
        });
        // Earlier links are retired only if this one went out; otherwise they keep working.
        await authTokenService.settleResetLinkDelivery({
            user_id: userId,
            token_id: issued.token_id,
            delivered: outcome.accepted || outcome.unconfirmed,
            now: now
        });
        // Audited AFTER the send, with what the mail server actually said.
        await audit(RESET_REQUEST_OUTCOMES.LINK_ISSUED, userId, outcome.status);
        logger.customConsoleLog('INFO: auth: password-reset link send attempt finished (email_status says whether the mail server accepted it)', { user_id: userId, email_status: outcome.status });
        return RESET_REQUEST_OUTCOMES.LINK_ISSUED;
    } catch (error) {
        logger.customConsoleError('ERROR: auth password processPasswordResetRequest — nothing sent', error);
        return RESET_REQUEST_OUTCOMES.FAILED;
    }
};

/**
 * `POST /api/auth/password/forgot` (public) `{ email }`. ALWAYS the same 202-class answer for a
 * well-formed address; the work happens after the response (spec A6).
 *
 * @param _identity - Empty (public).
 * @param params - `{ email, request_ip, user_agent }`.
 * @returns Resolves `{ accepted: true }` with the ONE acknowledgement; 400 VALIDATION for a malformed address.
 */
const requestPasswordReset = (_identity: Partial<IdentityObject> | null | undefined, params: ForgotPasswordParams): Promise<ServiceResult> => {
    return new Promise((resolve) => {
        try {
            const emailCheck = identityHelper.validateEmail(params !== null && typeof params === 'object' ? params.email : undefined);
            if (!emailCheck.ok) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.VALIDATION, emailCheck.reason, { field: 'email' }));
            }
            const context = requestContextHelper.requestContextOf(params);
            resolve(promiseHelper.promiseReturnResult(true, { accepted: true }, {}, AUTH_MESSAGES.PASSWORD_RESET_REQUESTED));

            const email = emailCheck.value;
            setImmediate(() => {
                processPasswordResetRequest({ email: email, ip: context.ip }).catch(() => {
                    // Never rejects; this keeps a future change from crashing the process.
                });
            });
        } catch (error) {
            logger.customConsoleError('ERROR: auth password requestPasswordReset', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `POST /api/auth/password/reset` (public) `{ token, password }`. Never signs anyone in.
 *
 * Order: shape → live token (400 specific) → account still matches the link (active, same email,
 * password unchanged since the link was issued) → policy (nothing consumed) → hash → SPEND the
 * token (CAS) → write the password (CAS on `password_changed_at`, epoch bump) → mark sessions and
 * other reset links revoked → notice + audit.
 *
 * @param _identity - Empty (public).
 * @param params - `{ token, password, request_ip, user_agent }`.
 * @returns Resolves `{ password_reset: true }`; 400 TOKEN_* / PASSWORD_POLICY. Never 401.
 */
const resetPassword = (_identity: Partial<IdentityObject> | null | undefined, params: ResetPasswordParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const hasParams = params !== null && typeof params === 'object';
            const token = hasParams ? params.token : undefined;
            const password = hasParams ? params.password : undefined;
            if (!tokenHelper.isWellFormedToken(token)) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.TOKEN_INVALID, AUTH_MESSAGES.TOKEN_INVALID));
            }
            if (typeof password !== 'string' || password.length === 0) {
                return resolve(_missingPassword());
            }
            const context = requestContextHelper.requestContextOf(params);
            const purpose = TOKEN_PURPOSES.PASSWORD_RESET;
            const tokenHash = tokenHelper.hashToken(token);

            const row = await authTokenRepository.findLiveByTokenHash({ purpose: purpose, token_hash: tokenHash, now: new Date() });
            if (!row) {
                return resolve(await authTokenService.deadTokenFailure({ purpose: purpose, token_hash: tokenHash, now: new Date() }));
            }
            const user = row.user_id ? await userRepository.findById(row.user_id) : null;
            const issuedAt = row.createdAt instanceof Date ? row.createdAt.getTime() : NaN;
            const changedAt = user && user.password_changed_at instanceof Date ? user.password_changed_at.getTime() : -Infinity;
            if (!user || user.status !== USER_STATUSES.ACTIVE || user.email !== row.email || !(changedAt < issuedAt)) {
                logger.customConsoleWarn('WARN: auth: a reset link no longer matches its account (disabled, re-addressed, or the password changed since)', {
                    user_id: row.user_id ? String(row.user_id) : null
                });
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.TOKEN_INVALID, AUTH_MESSAGES.TOKEN_INVALID));
            }
            const policy = passwordHelper.evaluatePasswordPolicy({
                password: password,
                email: user.email,
                name: user.name,
                truncates: passwordHashService.passwordTruncates
            });
            if (!policy.ok) {
                return resolve(serviceResultHelper.passwordPolicyFailure(policy));
            }
            const passwordHash = await passwordHashService.hashPassword(password);

            const now = new Date();
            const spent = await authTokenRepository.spendToken({ token_id: String(row._id), purpose: purpose, now: now });
            if (!spent) {
                return resolve(await authTokenService.deadTokenFailure({ purpose: purpose, token_hash: tokenHash, now: now }));
            }
            const userId = String(user._id);
            const updated = await userRepository.updatePassword({
                user_id: userId,
                password_hash: passwordHash,
                now: now,
                changed_before: row.createdAt instanceof Date ? row.createdAt : now
            });
            if (!updated) {
                logger.customConsoleWarn('WARN: auth: reset link spent but the password was not written (account disabled or password changed in between)', {
                    user_id: userId
                });
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.TOKEN_INVALID, AUTH_MESSAGES.TOKEN_INVALID));
            }

            // Every session is already dead by epoch; marking rows is the audit trail — best-effort.
            let sessionsRevoked = 0;
            try {
                sessionsRevoked = await authSessionRepository.revokeAllForUser({ user_id: userId, reason: SESSION_REVOKE_REASONS.PASSWORD_RESET, now: now });
                await authTokenRepository.revokeLiveTokens({ purpose: purpose, now: now, user_id: userId });
            } catch (cleanupError) {
                logger.customConsoleWarn('WARN: auth: password reset written; marking old sessions / links revoked failed (they are dead by epoch / CAS anyway)', cleanupError);
            }
            authMailService.queuePasswordChangedNotice({ user_id: userId, to: updated.email, now: now, ip: context.ip });
            await auditService.recordAuditEvent({ user_id: userId }, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: userId,
                actor_email: updated.email,
                action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
                target_type: AUDIT_TARGET_TYPES.USER,
                target_id: userId,
                ip: context.ip,
                details: { sessions_revoked: sessionsRevoked },
                now: now
            });
            logger.customConsoleLog('INFO: auth: password reset completed', { user_id: userId });
            return resolve(promiseHelper.promiseReturnResult(true, { password_reset: true }, {}, AUTH_MESSAGES.PASSWORD_RESET_DONE));
        } catch (error) {
            logger.customConsoleError('ERROR: auth password resetPassword', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `POST /api/account/password` (@self) `{ current_password, new_password }`.
 *
 * A wrong current password is 400 CURRENT_PASSWORD_INCORRECT — NEVER 401 (the frontend signs out on
 * any 401). The write is a CAS on the hash just compared, so a reset that landed in between is not
 * overwritten. Every OTHER session ends; the caller gets a fresh token (spec A4).
 *
 * @param identity - `{ user_id }` from the guard.
 * @param params - `{ current_password, new_password, session_id, request_ip, user_agent }`.
 * @returns Resolves `FreshSessionWithCount` (`{ token, expires_at, expires_in_seconds, revoked }`);
 *     400 VALIDATION / CURRENT_PASSWORD_INCORRECT / PASSWORD_POLICY; 401 SESSION_INVALID.
 */
const changePassword = (identity: IdentityObject, params: ChangePasswordParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const userId = identity && identity.user_id;
            if (!identityHelper.isObjectIdString(userId)) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SESSION_INVALID, AUTH_MESSAGES.SESSION_INVALID));
            }
            const hasParams = params !== null && typeof params === 'object';
            const currentPassword = hasParams ? params.current_password : undefined;
            const newPassword = hasParams ? params.new_password : undefined;
            if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.VALIDATION, 'Enter your current password.', { field: 'current_password' }));
            }
            if (typeof newPassword !== 'string' || newPassword.length === 0) {
                return resolve(_missingPassword());
            }
            const context = requestContextHelper.requestContextOf(params);

            const user = await userRepository.findByIdWithHash(userId);
            if (!user || user.status !== USER_STATUSES.ACTIVE || typeof user.password_hash !== 'string') {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SESSION_INVALID, AUTH_MESSAGES.SESSION_INVALID));
            }
            const currentHash = user.password_hash;
            const matches = await passwordHashService.verifyPassword(currentPassword, currentHash);
            if (!matches) {
                logger.customConsoleWarn('WARN: auth: change-password with a wrong current password', { user_id: userId });
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.CURRENT_PASSWORD_INCORRECT, AUTH_MESSAGES.CURRENT_PASSWORD_INCORRECT));
            }
            const policy = passwordHelper.evaluatePasswordPolicy({
                password: newPassword,
                email: user.email,
                name: user.name,
                truncates: passwordHashService.passwordTruncates
            });
            if (!policy.ok) {
                return resolve(serviceResultHelper.passwordPolicyFailure(policy));
            }
            const newHash = await passwordHashService.hashPassword(newPassword);
            const now = new Date();
            const updated = await userRepository.updatePassword({
                user_id: userId,
                password_hash: newHash,
                now: now,
                expected_password_hash: currentHash
            });
            if (!updated) {
                // The hash moved under us (a reset landed): the "current" password is no longer current.
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.CURRENT_PASSWORD_INCORRECT, AUTH_MESSAGES.CURRENT_PASSWORD_INCORRECT));
            }

            let rotated;
            try {
                rotated = await sessionService.rotateAfterEpochBump({
                    user_id: userId,
                    epoch: updated.session_epoch,
                    current_session_id: hasParams ? params.session_id : undefined,
                    reason: SESSION_REVOKE_REASONS.PASSWORD_CHANGED,
                    ip: context.ip,
                    user_agent: context.user_agent,
                    now: now
                });
            } catch (rotateError) {
                logger.customConsoleError('ERROR: auth changePassword — password changed, but no fresh session could be issued', rotateError);
                const failure = serviceResultHelper.exceptionFailure(rotateError);
                failure.msg = 'Your password was changed, but a new session could not be started. Sign in again with the new password.';
                return resolve(failure);
            }
            try {
                await authTokenRepository.revokeLiveTokens({ purpose: TOKEN_PURPOSES.PASSWORD_RESET, now: now, user_id: userId });
            } catch (revokeError) {
                // Harmless: an older reset link is refused anyway (password_changed_at is newer than it).
                logger.customConsoleWarn('WARN: auth changePassword — could not revoke outstanding reset links', revokeError);
            }
            authMailService.queuePasswordChangedNotice({ user_id: userId, to: updated.email, now: now, ip: context.ip });
            await auditService.recordAuditEvent(identity, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: userId,
                actor_email: updated.email,
                action: AUDIT_ACTIONS.PASSWORD_CHANGED,
                target_type: AUDIT_TARGET_TYPES.USER,
                target_id: userId,
                ip: context.ip,
                details: { sessions_revoked: rotated.revoked },
                now: now
            });
            return resolve(promiseHelper.promiseReturnResult(true, rotated, {}, AUTH_MESSAGES.PASSWORD_CHANGED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth password changePassword', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `POST /api/users/:user_id/password-reset` (users:manage + the management rule). Sends the same
 * reset link forgot-password would, synchronously (admin-facing, not an oracle), within the
 * ADMIN_SEND_DEADLINE_MS. An admin never sets or sees a password.
 *
 * @param identity - `{ user_id }` of the actor (re-loaded from the database).
 * @param params - `{ user_id, request_ip }` — the target.
 * @returns Resolves `PasswordResetSentResult` (`{ email_sent, email_status }`); 403 FORBIDDEN
 *     (`reason`/`permission`); 404; 409 USER_STATUS_CONFLICT (disabled target); 429 RATE_LIMITED.
 */
const adminSendPasswordReset = (identity: IdentityObject, params: UserIdParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const targetId = params !== null && typeof params === 'object' ? params.user_id : undefined;
            if (!identityHelper.isObjectIdString(targetId)) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, AUTH_MESSAGES.NOT_FOUND));
            }
            const context = requestContextHelper.requestContextOf(params);
            const actor = await principalService.loadActor(identity);
            if (!actor.ok) {
                return resolve(actor.failure);
            }
            const forbidden = principalService.requirePermission(actor.principal, PERMISSIONS.USERS_MANAGE);
            if (forbidden) {
                return resolve(forbidden);
            }
            const managed = await principalService.loadManagedTarget({ actor: actor.principal, install: actor.install, user_id: targetId });
            if (!managed.ok) {
                return resolve(managed.failure);
            }
            const target = managed.target;
            if (target.status !== USER_STATUSES.ACTIVE) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.USER_STATUS_CONFLICT, AUTH_MESSAGES.USER_NOT_ACTIVE, {
                    status: target.status
                }));
            }
            if (!authTokenService.canBuildLinks()) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.PUBLIC_URL_MISSING, AUTH_MESSAGES.PUBLIC_URL_MISSING));
            }
            const now = new Date();
            const slot = await userRepository.claimResetSendSlot({ user_id: targetId, throttle: _resetThrottle(now) });
            if (!slot) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.RATE_LIMITED, AUTH_MESSAGES.RATE_LIMITED));
            }
            const issued = await authTokenService.issueResetLink({
                user_id: targetId,
                email: slot.email,
                minutes: config.AUTH.PASSWORD_RESET_TTL_MINUTES,
                setting: 'AUTH_PASSWORD_RESET_TTL_MINUTES',
                request_ip: context.ip,
                now: now
            });
            if (!issued) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.PUBLIC_URL_MISSING, AUTH_MESSAGES.PUBLIC_URL_MISSING));
            }
            const outcome = await authMailService.sendAuthEmail({
                identity: { user_id: actor.principal.user_id },
                to: slot.email,
                template: mailModule.EMAIL_TEMPLATES.PASSWORD_RESET,
                vars: { now: now, expires_at: issued.expires_at, link: issued.link, ip: context.ip },
                trigger: mailModule.MAIL_TRIGGERS.ADMIN,
                deadline_ms: mailModule.ADMIN_SEND_DEADLINE_MS
            });
            await authTokenService.settleResetLinkDelivery({
                user_id: targetId,
                token_id: issued.token_id,
                delivered: outcome.accepted || outcome.unconfirmed,
                now: now
            });
            await auditService.recordAuditEvent(identity, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: actor.principal.user_id,
                actor_email: actor.principal.email,
                action: AUDIT_ACTIONS.PASSWORD_RESET_SENT_BY_ADMIN,
                target_type: AUDIT_TARGET_TYPES.USER,
                target_id: targetId,
                target_email: slot.email,
                ip: context.ip,
                details: { email_status: outcome.status },
                now: now
            });
            const result: PasswordResetSentResult = { email_sent: outcome.accepted, email_status: outcome.status };
            const msg = serviceResultHelper.emailOutcomeMessage({
                accepted: outcome.accepted,
                unconfirmed: outcome.unconfirmed,
                success_msg: AUTH_MESSAGES.PASSWORD_RESET_SENT,
                prefix: AUTH_MESSAGES.PASSWORD_RESET_LINK_CREATED,
                mail_msg: outcome.msg,
                retry_hint: AUTH_MESSAGES.EMAIL_RETRY_HINT
            });
            return resolve(promiseHelper.promiseReturnResult(true, result, {}, msg));
        } catch (error) {
            logger.customConsoleError('ERROR: auth password adminSendPasswordReset', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

export = {
    requestPasswordReset,
    processPasswordResetRequest,
    resetPassword,
    changePassword,
    adminSendPasswordReset
};
