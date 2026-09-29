'use strict';

/**
 * ============================================================================
 *  RECOVERY — what the operator can do from a shell (spec §13, A17)
 * ============================================================================
 *
 *  Called only by `src/scripts/authAdmin.ts`. Shell access to the server is the
 *  trust boundary here: these functions bypass SMTP (they RETURN a link for the
 *  CLI to print), bypass the per-address throttles and the global setup-link
 *  capacity (the CLI is how an operator recovers when an attacker has filled
 *  it), and may name the permitted setup addresses when refusing. They never
 *  accept or print a password, and they never reopen setup.
 *
 *  Every action is audited with actor_type CLI.
 *
 *  Each function resolves an envelope and never rejects; `error.code` says why
 *  it refused, `msg` says it in words the CLI prints.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import config = require('../../../config');
import mailModule = require('../../mail');
import authConstants = require('../constants/auth.constants');
import auditConstants = require('../constants/audit.constants');
import identityHelper = require('../helpers/identity.helper');
import datastoreErrorHelper = require('../helpers/datastoreError.helper');
import serviceResultHelper = require('../helpers/serviceResult.helper');
import userRepository = require('../repositories/user.repository');
import inviteRepository = require('../repositories/invite.repository');
import authTokenRepository = require('../repositories/authToken.repository');
import authSessionRepository = require('../repositories/authSession.repository');
import systemStateRepository = require('../repositories/systemState.repository');
import legacyOperatorRepository = require('../repositories/legacyOperator.repository');
import installStateService = require('./installState.service');
import authTokenService = require('./authToken.service');
import passwordHashService = require('./passwordHash.service');
import inviteService = require('./invite.service');
import auditService = require('./audit.service');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type {
    CliEmailParams,
    CliIssuedLink,
    CliRevokeSessionsParams,
    CliSetupLinkParams,
    RecoveryStatus
} from '../types/auth.types';

const {
    AUTH_MESSAGES,
    AUTH_ERROR_CODES,
    USER_STATUSES,
    ROLE_KEYS,
    CREATED_VIA,
    TOKEN_PURPOSES,
    SESSION_REVOKE_REASONS,
    AUDIT_ACTOR_TYPES,
    AUDIT_TARGET_TYPES,
    APP_LINK_PATHS,
    AUTH_SERVICE_ACTORS,
    INSTALL_STATE_ID,
    CLI_RESET_LINK_TTL_MINUTES
} = authConstants;
const { AUDIT_ACTIONS, INVITE_REVOKE_REASONS } = auditConstants;

const CLI_IDENTITY = Object.freeze({ user_id: AUTH_SERVICE_ACTORS.CLI });

/**
 * Records a CLI action (actor_type CLI; never expires).
 *
 * @param params0 - The parameters object.
 * @param params0.action - One of `AUDIT_ACTIONS`.
 * @param params0.target_type - One of `AUDIT_TARGET_TYPES`.
 * @param params0.target_id - The user or install the action touched.
 * @param params0.target_email - The address involved.
 * @param params0.details - Small facts.
 * @returns Resolves when recorded (or not — best-effort).
 */
const _auditCli = async ({ action, target_type, target_id, target_email, details }: {
    action: string;
    target_type: string;
    target_id: string | null;
    target_email: string | null;
    details?: Record<string, unknown>;
}): Promise<void> => {
    const knownAction = Object.values(AUDIT_ACTIONS).find((value) => value === action);
    const knownTarget = Object.values(AUDIT_TARGET_TYPES).find((value) => value === target_type);
    if (!knownAction) {
        return;
    }
    await auditService.recordAuditEvent(CLI_IDENTITY, {
        actor_type: AUDIT_ACTOR_TYPES.CLI,
        action: knownAction,
        target_type: knownTarget || null,
        target_id: target_id,
        target_email: target_email,
        details: details || {}
    });
};

/**
 * A validated address from a CLI argument, or the refusal.
 *
 * @param value - The `--email` argument.
 * @returns `{ ok: true, email }` or `{ ok: false, failure }`.
 */
const _cliEmail = (value: unknown): { ok: true; email: string } | { ok: false; failure: ServiceResult } => {
    const checked = identityHelper.validateEmail(value);
    if (!checked.ok) {
        return { ok: false, failure: serviceResultHelper.authFailure(AUTH_ERROR_CODES.VALIDATION, `--email: ${checked.reason}`, { field: 'email' }) };
    }
    return { ok: true, email: checked.value };
};

/**
 * `auth:admin status` — setup mode, legacy emails, the owner, user counts, mail status.
 *
 * Read-only: it does NOT create a missing install document (that would change what it reports).
 *
 * @param _identity - The CLI identity.
 * @returns Resolves `RecoveryStatus`.
 */
const recoveryStatus = (_identity?: Partial<IdentityObject> | null): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const install = await systemStateRepository.findInstallState();
            const ownerId = install && install.owner_user_id ? String(install.owner_user_id) : null;
            const owner = ownerId ? await userRepository.findById(ownerId) : null;
            let rule: RecoveryStatus['setup_rule'] = null;
            try {
                rule = (await installStateService.resolveSetupRule()).rule;
            } catch (ruleError) {
                logger.customConsoleError('ERROR: auth recoveryStatus — could not read the setup rule', ruleError);
            }
            const legacyEmails = await legacyOperatorRepository.listLegacyEmails();
            const users = await userRepository.countUsersByStatus();
            const mail = mailModule.getMailStatus();
            const status: RecoveryStatus = {
                install: {
                    present: Boolean(install),
                    setup_complete: installStateService.isSetupLocked(install),
                    setup_completed_at: install && install.setup_completed_at ? install.setup_completed_at : null,
                    owner_user_id: ownerId,
                    owner_missing: Boolean(ownerId && !owner),
                    owner_email: owner ? owner.email : null
                },
                setup_rule: rule,
                legacy_emails: legacyEmails,
                users: users,
                mail: {
                    configured: mail.configured,
                    last_check: mail.last_check,
                    last_ok_at: mail.last_ok_at,
                    consecutive_failures: mail.consecutive_failures
                }
            };
            return resolve(promiseHelper.promiseReturnResult(true, status, {}, AUTH_MESSAGES.RECOVERY_STATUS));
        } catch (error) {
            logger.customConsoleError('ERROR: auth recoveryStatus', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `auth:admin setup-link --email <e> --name <n>` — a setup-verify link, printed instead of mailed.
 * Only while setup is incomplete; the SAME pin > legacy > open rule as POST /setup (spec A17). On
 * refusal, `error` names the rule and the permitted addresses (shell access is trusted).
 *
 * @param _identity - The CLI identity.
 * @param params - `{ email, name }`.
 * @returns Resolves `CliIssuedLink`; VALIDATION; SETUP_ALREADY_COMPLETE; SETUP_NOT_PERMITTED
 *     (`rule`, `permitted_emails`); PUBLIC_URL_MISSING.
 */
const issueSetupLinkForCli = (_identity: Partial<IdentityObject> | null | undefined, params: CliSetupLinkParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const hasParams = params !== null && typeof params === 'object';
            const email = _cliEmail(hasParams ? params.email : undefined);
            if (!email.ok) {
                return resolve(email.failure);
            }
            const nameCheck = identityHelper.validateName(hasParams ? params.name : undefined);
            if (!nameCheck.ok) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.VALIDATION, `--name: ${nameCheck.reason}`, { field: 'name' }));
            }
            if (!authTokenService.canBuildLinks()) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.PUBLIC_URL_MISSING, AUTH_MESSAGES.PUBLIC_URL_MISSING));
            }
            const install = await installStateService.readInstallStateEnsured();
            if (!install) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.DATASTORE_ERROR, AUTH_MESSAGES.DATASTORE_ERROR));
            }
            if (installStateService.isSetupLocked(install)) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SETUP_ALREADY_COMPLETE, AUTH_MESSAGES.SETUP_ALREADY_COMPLETE));
            }
            const eligibility = await installStateService.evaluateSetupEligibility({ email: email.email });
            if (!eligibility.allowed) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SETUP_NOT_PERMITTED, AUTH_MESSAGES.SETUP_NOT_PERMITTED, {
                    rule: eligibility.rule,
                    permitted_emails: eligibility.permitted_emails
                }));
            }
            const now = new Date();
            const expiry = authTokenService.linkExpiry({ now: now, minutes: config.AUTH.SETUP_TOKEN_TTL_MINUTES, setting: 'AUTH_SETUP_TOKEN_TTL_MINUTES' });
            const issued = await authTokenService.insertLinkToken({
                purpose: TOKEN_PURPOSES.SETUP_VERIFY,
                email: email.email,
                user_id: null,
                name: nameCheck.value,
                expires_at: expiry.expires_at,
                request_ip: null
            });
            const link = authTokenService.buildAppLink(APP_LINK_PATHS.SETUP_VERIFY, issued.token);
            if (!link) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.PUBLIC_URL_MISSING, AUTH_MESSAGES.PUBLIC_URL_MISSING));
            }
            await _auditCli({
                action: AUDIT_ACTIONS.CLI_SETUP_LINK_ISSUED,
                target_type: AUDIT_TARGET_TYPES.INSTALL,
                target_id: INSTALL_STATE_ID,
                target_email: email.email,
                details: { rule: eligibility.rule }
            });
            const result: CliIssuedLink = { email: email.email, link: link, expires_at: expiry.expires_at };
            return resolve(promiseHelper.promiseReturnResult(true, result, {}, AUTH_MESSAGES.SETUP_LINK_ISSUED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth issueSetupLinkForCli', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * Issues a 15-minute reset link for an ACTIVE user (shared by `reset-link` and `repair-owner`) and
 * retires the user's earlier reset links: the CLI delivers by printing, so the new link has reached
 * its holder the moment it is returned.
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user.
 * @param params0.email - Their address, from the row.
 * @param params0.now - Issue instant.
 * @returns `{ link, expires_at }`, or `null` when no link can be built.
 */
const _cliResetLink = async ({ user_id, email, now }: { user_id: string; email: string; now: Date }): Promise<{ link: string; expires_at: Date } | null> => {
    const issued = await authTokenService.issueResetLink({
        user_id: user_id,
        email: email,
        minutes: CLI_RESET_LINK_TTL_MINUTES,
        setting: 'CLI_RESET_LINK_TTL_MINUTES',
        request_ip: null,
        now: now
    });
    if (!issued) {
        return null;
    }
    await authTokenService.retireEarlierResetLinks({ user_id: user_id, token_id: issued.token_id, now: now });
    return { link: issued.link, expires_at: issued.expires_at };
};

/**
 * `auth:admin reset-link --email <e>` — a 15-minute password-reset link for an active user, printed
 * (bypasses SMTP and the send throttle).
 *
 * @param _identity - The CLI identity.
 * @param params - `{ email }`.
 * @returns Resolves `CliIssuedLink`; VALIDATION; NOT_FOUND; USER_STATUS_CONFLICT (disabled); PUBLIC_URL_MISSING.
 */
const issueResetLinkForCli = (_identity: Partial<IdentityObject> | null | undefined, params: CliEmailParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const email = _cliEmail(params !== null && typeof params === 'object' ? params.email : undefined);
            if (!email.ok) {
                return resolve(email.failure);
            }
            if (!authTokenService.canBuildLinks()) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.PUBLIC_URL_MISSING, AUTH_MESSAGES.PUBLIC_URL_MISSING));
            }
            const user = await userRepository.findByEmail(email.email);
            if (!user) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, `No account uses ${email.email}.`));
            }
            if (user.status !== USER_STATUSES.ACTIVE) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.USER_STATUS_CONFLICT,
                    'That account is disabled. Enable it first: npm run auth:admin:dist -- enable --email <address>', { status: user.status }));
            }
            const userId = String(user._id);
            const issued = await _cliResetLink({ user_id: userId, email: user.email, now: new Date() });
            if (!issued) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.PUBLIC_URL_MISSING, AUTH_MESSAGES.PUBLIC_URL_MISSING));
            }
            await _auditCli({ action: AUDIT_ACTIONS.CLI_RESET_LINK_ISSUED, target_type: AUDIT_TARGET_TYPES.USER, target_id: userId, target_email: user.email });
            const result: CliIssuedLink = { email: user.email, link: issued.link, expires_at: issued.expires_at };
            return resolve(promiseHelper.promiseReturnResult(true, result, {}, AUTH_MESSAGES.RESET_LINK_ISSUED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth issueResetLinkForCli', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `auth:admin revoke-sessions --email <e> | --all` — bumps the epoch (one user, or every user) so
 * every session ends from the next request, and marks the rows revoked (reason CLI_REVOKED).
 *
 * @param _identity - The CLI identity.
 * @param params - `{ email }` or `{ all: true }` — exactly one.
 * @returns Resolves `{ revoked, users_affected }`; VALIDATION; NOT_FOUND.
 */
const revokeSessionsForCli = (_identity: Partial<IdentityObject> | null | undefined, params: CliRevokeSessionsParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const hasParams = params !== null && typeof params === 'object';
            const all = hasParams && params.all === true;
            const rawEmail = hasParams ? params.email : undefined;
            if (all === (rawEmail !== undefined && rawEmail !== null)) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.VALIDATION, 'Pass exactly one of --email <address> or --all.'));
            }
            const now = new Date();
            if (all) {
                const usersAffected = await userRepository.bumpAllSessionEpochs();
                const revoked = await authSessionRepository.revokeAll({ reason: SESSION_REVOKE_REASONS.CLI_REVOKED, now: now });
                await _auditCli({
                    action: AUDIT_ACTIONS.CLI_SESSIONS_REVOKED,
                    target_type: AUDIT_TARGET_TYPES.INSTALL,
                    target_id: INSTALL_STATE_ID,
                    target_email: null,
                    details: { count: revoked, all: true }
                });
                const everyone = { revoked: revoked, users_affected: usersAffected };
                return resolve(promiseHelper.promiseReturnResult(true, everyone, {}, AUTH_MESSAGES.CLI_SESSIONS_REVOKED));
            }
            const email = _cliEmail(rawEmail);
            if (!email.ok) {
                return resolve(email.failure);
            }
            const user = await userRepository.findByEmail(email.email);
            if (!user) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, `No account uses ${email.email}.`));
            }
            const userId = String(user._id);
            const bumped = await userRepository.bumpSessionEpoch({ user_id: userId });
            if (!bumped) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, `No account uses ${email.email}.`));
            }
            const revoked = await authSessionRepository.revokeAllForUser({ user_id: userId, reason: SESSION_REVOKE_REASONS.CLI_REVOKED, now: now });
            await _auditCli({
                action: AUDIT_ACTIONS.CLI_SESSIONS_REVOKED,
                target_type: AUDIT_TARGET_TYPES.USER,
                target_id: userId,
                target_email: user.email,
                details: { count: revoked }
            });
            return resolve(promiseHelper.promiseReturnResult(true, { revoked: revoked, users_affected: 1 }, {}, AUTH_MESSAGES.CLI_SESSIONS_REVOKED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth revokeSessionsForCli', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `auth:admin enable --email <e>` — re-enables a disabled user (epoch bumped too).
 *
 * @param _identity - The CLI identity.
 * @param params - `{ email }`.
 * @returns Resolves `{ user_id, email }`; VALIDATION; NOT_FOUND; USER_STATUS_CONFLICT (already active).
 */
const enableUserForCli = (_identity: Partial<IdentityObject> | null | undefined, params: CliEmailParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const email = _cliEmail(params !== null && typeof params === 'object' ? params.email : undefined);
            if (!email.ok) {
                return resolve(email.failure);
            }
            const user = await userRepository.findByEmail(email.email);
            if (!user) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, `No account uses ${email.email}.`));
            }
            const userId = String(user._id);
            const enabled = await userRepository.enableUser({ user_id: userId });
            if (!enabled) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.USER_STATUS_CONFLICT, AUTH_MESSAGES.USER_ALREADY_ACTIVE, {
                    status: user.status
                }));
            }
            await _auditCli({ action: AUDIT_ACTIONS.CLI_USER_ENABLED, target_type: AUDIT_TARGET_TYPES.USER, target_id: userId, target_email: enabled.email });
            return resolve(promiseHelper.promiseReturnResult(true, { user_id: userId, email: enabled.email }, {}, AUTH_MESSAGES.CLI_USER_ENABLED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth enableUserForCli', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `auth:admin transfer-owner --email <e>` — moves the owner pointer to an ACTIVE user by CAS on its
 * current value (a null or dangling pointer is accepted, spec A17). The previous owner keeps their
 * stored role (`admin` from setup). Their outstanding invites move to the new owner, and the moved
 * invites are re-checked (spec A13).
 *
 * @param _identity - The CLI identity.
 * @param params - `{ email }`.
 * @returns Resolves `{ from_user_id, to_user_id, email, invites_reparented, invites_revoked }`;
 *     VALIDATION; NOT_FOUND; USER_STATUS_CONFLICT (disabled); SETUP_INCOMPLETE; TARGET_CHANGED (pointer moved concurrently).
 */
const transferOwnershipForCli = (_identity: Partial<IdentityObject> | null | undefined, params: CliEmailParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const email = _cliEmail(params !== null && typeof params === 'object' ? params.email : undefined);
            if (!email.ok) {
                return resolve(email.failure);
            }
            const install = await systemStateRepository.findInstallState();
            if (!install || !installStateService.isSetupLocked(install)) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SETUP_INCOMPLETE,
                    `${AUTH_MESSAGES.SETUP_INCOMPLETE} Finish setup (or use setup-link) instead of transferring ownership.`));
            }
            const user = await userRepository.findByEmail(email.email);
            if (!user) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.NOT_FOUND, `No account uses ${email.email}.`));
            }
            if (user.status !== USER_STATUSES.ACTIVE) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.USER_STATUS_CONFLICT,
                    'That account is disabled. Enable it first: npm run auth:admin:dist -- enable --email <address>', { status: user.status }));
            }
            const toId = String(user._id);
            const fromId = install.owner_user_id ? String(install.owner_user_id) : null;
            if (fromId === toId) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.VALIDATION, AUTH_MESSAGES.ALREADY_OWNER));
            }
            const moved = await systemStateRepository.moveOwnerPointer({ from_owner_user_id: fromId, to_owner_user_id: toId });
            if (!moved) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.TARGET_CHANGED, 'The owner changed while this ran. Run status and try again.'));
            }
            const fromUser = fromId ? await userRepository.findById(fromId) : null;
            let reparented = 0;
            let revoked = 0;
            const now = new Date();
            if (fromId) {
                reparented = await inviteRepository.reparentOutstanding({ from_user_id: fromId, to_user_id: toId });
                const nowOwned = await inviteRepository.listOutstanding({ invited_by_user_id: toId });
                revoked = await inviteService.reevaluateOutstandingInvites({
                    invites: nowOwned,
                    actor: { actor_type: AUDIT_ACTOR_TYPES.CLI, actor_user_id: null, actor_email: null },
                    ip: null,
                    now: now
                });
            }
            await _auditCli({
                action: AUDIT_ACTIONS.OWNERSHIP_TRANSFERRED,
                target_type: AUDIT_TARGET_TYPES.INSTALL,
                target_id: INSTALL_STATE_ID,
                target_email: user.email,
                details: { from: fromUser ? fromUser.email : fromId, to: user.email, invites_reparented: reparented }
            });
            logger.customConsoleLog('INFO: auth: ownership transferred by the recovery CLI', { from_user_id: fromId, to_user_id: toId });
            const result = { from_user_id: fromId, to_user_id: toId, email: user.email, invites_reparented: reparented, invites_revoked: revoked };
            return resolve(promiseHelper.promiseReturnResult(true, result, {}, AUTH_MESSAGES.OWNERSHIP_TRANSFERRED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth transferOwnershipForCli', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `auth:admin repair-owner --email <e> --name <n>` (spec A17) — recreates a MISSING owner account.
 * Only when setup is locked AND no user has `_id = owner_user_id` (or the pointer is null) AND the
 * address is free. Inserts the owner with an unguessable throwaway password (nobody ever sees it),
 * unsets any leftover setup claim, and returns a 15-minute reset link to choose a real one. Setup is
 * never reopened.
 *
 * Order (no transactions): with a null pointer, the pointer is set by CAS FIRST, so a crash leaves a
 * dangling pointer that a re-run repairs; then the row is inserted with that id.
 *
 * ⚠️ A REUSED id inherits nothing. The departed owner's session rows and outstanding invitations are
 * keyed on the dangling pointer, and the new row starts at `session_epoch` 0 like theirs did, so
 * without the step below their unexpired token authenticated as the NEW owner with all 12
 * permissions (reproduced against a real mongod). Every session for that id is revoked and every
 * invitation it sent is withdrawn BEFORE the insert: no session can be created for an id with no
 * user row, so nothing slips in between, and a crashed run repeats the step harmlessly.
 *
 *
 * @param _identity - The CLI identity.
 * @param params - `{ email, name }`.
 * @returns Resolves `{ user_id, email, link, expires_at }`; VALIDATION; SETUP_INCOMPLETE;
 *     OWNER_PRESENT; ALREADY_A_MEMBER (address taken — use transfer-owner); TARGET_CHANGED; PUBLIC_URL_MISSING.
 */
const repairOwnerForCli = (_identity: Partial<IdentityObject> | null | undefined, params: CliSetupLinkParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const hasParams = params !== null && typeof params === 'object';
            const email = _cliEmail(hasParams ? params.email : undefined);
            if (!email.ok) {
                return resolve(email.failure);
            }
            const nameCheck = identityHelper.validateName(hasParams ? params.name : undefined);
            if (!nameCheck.ok) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.VALIDATION, `--name: ${nameCheck.reason}`, { field: 'name' }));
            }
            if (!authTokenService.canBuildLinks()) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.PUBLIC_URL_MISSING, AUTH_MESSAGES.PUBLIC_URL_MISSING));
            }
            // The CLI process never ran boot: make sure the unique gates exist before inserting.
            if (!installStateService.areAuthIndexesReady()) {
                await installStateService.ensureAuthIndexes();
            }

            const install = await systemStateRepository.findInstallState();
            if (!install || !installStateService.isSetupLocked(install)) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SETUP_INCOMPLETE,
                    `${AUTH_MESSAGES.SETUP_INCOMPLETE} repair-owner never reopens or completes setup; use setup-link.`));
            }
            const pointer = install.owner_user_id ? String(install.owner_user_id) : null;
            if (pointer && await userRepository.existsById(pointer)) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.OWNER_PRESENT, AUTH_MESSAGES.OWNER_PRESENT));
            }
            const taken = await userRepository.findByEmail(email.email);
            if (taken) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.ALREADY_A_MEMBER,
                    `${email.email} already has an account. Make it the owner instead: npm run auth:admin:dist -- transfer-owner --email ${email.email}`));
            }

            let sessionsRevoked = 0;
            let invitesRevoked = 0;
            if (pointer) {
                const cleanupAt = new Date();
                sessionsRevoked = await authSessionRepository.revokeAllForUser({ user_id: pointer, reason: SESSION_REVOKE_REASONS.CLI_REVOKED, now: cleanupAt });
                const inherited = await inviteRepository.listOutstanding({ invited_by_user_id: pointer });
                invitesRevoked = await inviteService.revokeInvites({
                    invites: inherited,
                    reason: INVITE_REVOKE_REASONS.INVITER_DISABLED,
                    actor: { actor_type: AUDIT_ACTOR_TYPES.CLI, actor_user_id: null, actor_email: null },
                    ip: null,
                    now: cleanupAt
                });
            }

            let ownerId = pointer;
            if (!ownerId) {
                const newId = userRepository.newUserId();
                const moved = await systemStateRepository.moveOwnerPointer({ from_owner_user_id: null, to_owner_user_id: newId });
                if (!moved) {
                    return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.TARGET_CHANGED, 'The owner changed while this ran. Run status and try again.'));
                }
                ownerId = newId;
            }

            // A throwaway password nobody knows: the reset link below is the only way in.
            const throwaway = authTokenService.issueToken().token;
            const passwordHash = await passwordHashService.hashPassword(throwaway);
            const now = new Date();
            try {
                await userRepository.insertUser({
                    _id: ownerId,
                    email: email.email,
                    name: nameCheck.value,
                    password_hash: passwordHash,
                    role_key: ROLE_KEYS.ADMIN,
                    custom_role_id: null,
                    email_verified_at: now,
                    password_changed_at: now,
                    invited_by_user_id: null,
                    created_via: CREATED_VIA.SETUP
                });
            } catch (insertError) {
                const field = datastoreErrorHelper.duplicateKeyField(insertError);
                if (field === 'email') {
                    return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.ALREADY_A_MEMBER,
                        `${email.email} already has an account. Make it the owner instead: npm run auth:admin:dist -- transfer-owner --email ${email.email}`));
                }
                if (field === '_id') {
                    return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.OWNER_PRESENT, AUTH_MESSAGES.OWNER_PRESENT));
                }
                throw insertError;
            }
            if (install.setup_token_id) {
                await authTokenRepository.unsetClaim({ token_id: String(install.setup_token_id) });
            }

            // The reset CAS requires password_changed_at to be OLDER than the link. Make sure the link's
            // createdAt cannot land in the same millisecond as the row's password_changed_at.
            if (Date.now() <= now.getTime()) {
                await new Promise((wait) => setTimeout(wait, 2));
            }
            const issued = await _cliResetLink({ user_id: ownerId, email: email.email, now: new Date() });
            if (!issued) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.PUBLIC_URL_MISSING, AUTH_MESSAGES.PUBLIC_URL_MISSING));
            }
            await _auditCli({
                action: AUDIT_ACTIONS.OWNER_REPAIRED,
                target_type: AUDIT_TARGET_TYPES.USER,
                target_id: ownerId,
                target_email: email.email,
                details: { sessions_revoked: sessionsRevoked, invites_revoked: invitesRevoked }
            });
            logger.customConsoleLog('INFO: auth: owner account recreated by the recovery CLI', {
                owner_user_id: ownerId,
                email: email.email,
                previous_sessions_revoked: sessionsRevoked,
                previous_invites_revoked: invitesRevoked
            });
            const result = { user_id: ownerId, email: email.email, link: issued.link, expires_at: issued.expires_at };
            return resolve(promiseHelper.promiseReturnResult(true, result, {}, AUTH_MESSAGES.OWNER_REPAIRED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth repairOwnerForCli', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

export = {
    recoveryStatus,
    issueSetupLinkForCli,
    issueResetLinkForCli,
    revokeSessionsForCli,
    enableUserForCli,
    transferOwnershipForCli,
    repairOwnerForCli
};
