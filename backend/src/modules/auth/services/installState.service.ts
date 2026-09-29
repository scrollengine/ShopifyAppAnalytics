'use strict';

/**
 * ============================================================================
 *  INSTALL STATE — the setup lock, the boot steps, and who may claim setup
 * ============================================================================
 *
 *  Boot order (spec §11 / A8), each step logged:
 *
 *      ensureInstallState()   FATAL  — creates the install document; OPEN only
 *                                      when gi_users is empty, else LOCKED with
 *                                      no owner (spec A7)
 *      markLegacyOperators()         — stamps legacy_at on gi_admin_users
 *      ensureAuthIndexes()    FATAL  — the unique gates exist before any insert
 *      reconcileSetup()              — rolls a crashed setup forward
 *      logSetupState()               — says who may claim setup; WARNs when open
 *                                      to anyone
 *
 *  ⚠️ The two FATAL steps break the house "services never reject" rule ON
 *  PURPOSE: they resolve an envelope on success and THROW on failure, so a boot
 *  sequence that only awaits them still stops (app.ts's single `.catch`, like
 *  `assertHandlersRegistered`). Everything else here resolves and never rejects.
 *
 *  Module state: `indexes_ready` — whether `ensureAuthIndexes` has succeeded IN
 *  THIS PROCESS. User and invite inserts refuse with 503 until it has (spec A7):
 *  a unique gate that does not exist yet admits both racers.
 *
 *  The setup allow-rule (pin > legacy > open, spec A7) is computed here, per
 *  call, and is the ONE spelling used by POST /setup, setup completion, the
 *  setup screen and the recovery CLI.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import mailModule = require('../../mail');
import authConstants = require('../constants/auth.constants');
import auditConstants = require('../constants/audit.constants');
import datastoreErrorHelper = require('../helpers/datastoreError.helper');
import serviceResultHelper = require('../helpers/serviceResult.helper');
import systemStateRepository = require('../repositories/systemState.repository');
import userRepository = require('../repositories/user.repository');
import authTokenRepository = require('../repositories/authToken.repository');
import legacyOperatorRepository = require('../repositories/legacyOperator.repository');
import authIndexRepository = require('../repositories/authIndex.repository');
import auditService = require('./audit.service');

import type { ServiceResult } from '../../../types/service.types';
import type { SystemStateDoc } from '../../shared/types/entity.types';
import type { SetupEligibility, SetupStatus } from '../types/auth.types';

const {
    AUTH_MESSAGES,
    AUTH_ERROR_CODES,
    AUDIT_ACTOR_TYPES,
    AUDIT_TARGET_TYPES,
    ROLE_KEYS,
    CREATED_VIA,
    SETUP_ELIGIBILITY_RULES,
    AUTH_SERVICE_ACTORS,
    INSTALL_STATE_ID
} = authConstants;
const { AUDIT_ACTIONS } = auditConstants;

const SYSTEM_IDENTITY = Object.freeze({ user_id: AUTH_SERVICE_ACTORS.SYSTEM });

/** The CLI command an operator runs when the owner pointer cannot be satisfied. Named in logs. */
const TRANSFER_OWNER_COMMAND = 'npm run auth:admin:dist -- transfer-owner --email <address>';
const REPAIR_OWNER_COMMAND = 'npm run auth:admin:dist -- repair-owner --email <address> --name <name>';

let _indexesReady = false;

/**
 * Whether `ensureAuthIndexes` has succeeded in this process.
 *
 * @returns True once the unique gates are known to exist.
 */
const areAuthIndexesReady = (): boolean => {
    return _indexesReady;
};

/**
 * Test-only: forgets `indexes_ready`. Deep-path import only (not in the barrel).
 *
 * @returns Nothing.
 */
const resetInstallStateServiceState = (): void => {
    _indexesReady = false;
};

/**
 * Creates the install document if it is missing, OPEN only when gi_users is empty (spec A7). Retries
 * once on the E11000 a concurrent boot's upsert produces. THROWS on any other failure.
 *
 * @returns `{ inserted, locked }` — whether this call created it, and whether it was created locked.
 */
const _ensureInstallDocument = async (): Promise<{ inserted: boolean; locked: boolean }> => {
    const existing = await systemStateRepository.findInstallState();
    if (existing) {
        return { inserted: false, locked: existing.setup_completed_at !== null && existing.setup_completed_at !== undefined };
    }
    const userCount = await userRepository.countUsers();
    const lockedAt = userCount > 0 ? new Date() : null;
    let result: { inserted: boolean };
    try {
        result = await systemStateRepository.ensureInstallDocument({ locked_at: lockedAt });
    } catch (error) {
        if (!datastoreErrorHelper.isDuplicateKeyError(error)) {
            throw error;
        }
        // A concurrent boot inserted it between our miss and our upsert. The retry matches theirs.
        result = await systemStateRepository.ensureInstallDocument({ locked_at: lockedAt });
    }
    if (result.inserted && lockedAt) {
        logger.customConsoleError('ERROR: auth: the install document was missing while users exist — created it LOCKED with NO owner. ' +
            `Nobody holds owner permissions until you run: ${TRANSFER_OWNER_COMMAND}`, { users: userCount });
    }
    return { inserted: result.inserted, locked: lockedAt !== null };
};

/**
 * Reads the install document, creating it first when missing (the ONE "what does absent mean" rule
 * for request paths: create it once; still absent ⇒ the caller answers 503).
 *
 * @returns The install document, or `null` when it still cannot be read back.
 * @throws On a datastore error.
 */
const readInstallStateEnsured = async (): Promise<SystemStateDoc | null> => {
    const found = await systemStateRepository.findInstallState();
    if (found) {
        return found;
    }
    await _ensureInstallDocument();
    return systemStateRepository.findInstallState();
};

/**
 * Whether the install is locked (setup complete).
 *
 * @param install - The install document.
 * @returns True when `setup_completed_at` is set.
 */
const isSetupLocked = (install: SystemStateDoc | null): boolean => {
    return Boolean(install && install.setup_completed_at);
};

/**
 * BOOT STEP 1 (FATAL). Ensures the install document exists (spec §7.1, A7).
 *
 * @returns Resolves `{ inserted, locked }` on success.
 * @throws On failure — boot must stop.
 */
const ensureInstallState = async (): Promise<ServiceResult> => {
    try {
        const outcome = await _ensureInstallDocument();
        logger.customConsoleLog('INFO: auth: install state ready', { id: INSTALL_STATE_ID, created: outcome.inserted, locked: outcome.locked });
        return promiseHelper.promiseReturnResult(true, outcome, {}, AUTH_MESSAGES.INSTALL_STATE_READY);
    } catch (error) {
        logger.customConsoleError('ERROR: auth ensureInstallState — could not create or read the install document; refusing to start', error);
        throw error;
    }
};

/**
 * BOOT STEP 3 (FATAL). Builds the auth collections' indexes and records `indexes_ready` (spec A8).
 *
 * @returns Resolves `{ collections }` on success.
 * @throws On failure — boot must stop.
 */
const ensureAuthIndexes = async (): Promise<ServiceResult> => {
    try {
        const collections = await authIndexRepository.createAuthIndexes();
        _indexesReady = true;
        logger.customConsoleLog('INFO: auth: indexes ensured', { collections: collections });
        return promiseHelper.promiseReturnResult(true, { collections: collections }, {}, AUTH_MESSAGES.AUTH_INDEXES_READY);
    } catch (error) {
        logger.customConsoleError('ERROR: auth ensureAuthIndexes — the unique gates could not be built; refusing to start', error);
        throw error;
    }
};

/**
 * BOOT STEP 2. Stamps `legacy_at` on every single-operator account not yet marked (spec §7.1).
 * Non-fatal; idempotent.
 *
 * @returns Resolves `{ marked }`, or `status: false` on a datastore error (logged).
 */
const markLegacyOperators = (): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const now = new Date();
            const marked = await legacyOperatorRepository.markAllLegacy({ now: now });
            if (marked > 0) {
                logger.customConsoleLog('INFO: auth: marked single-operator accounts as legacy — they are never read by sign-in', { marked: marked });
                await auditService.recordAuditEvent(SYSTEM_IDENTITY, {
                    actor_type: AUDIT_ACTOR_TYPES.SYSTEM,
                    action: AUDIT_ACTIONS.LEGACY_OPERATORS_MARKED,
                    details: { count: marked },
                    now: now
                });
            } else {
                logger.customConsoleDebug('DEBUG: auth: no unmarked legacy operator accounts');
            }
            return resolve(promiseHelper.promiseReturnResult(true, { marked: marked }, {}, AUTH_MESSAGES.LEGACY_OPERATORS_MARKED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth markLegacyOperators (non-fatal)', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * The setup allow-rule (spec §0.2 / A7), computed per call: a pinned `SETUP_OWNER_EMAIL`; else the
 * emails of ALL `gi_admin_users` rows (whatever `legacy_at` says) when any exist; else OPEN.
 *
 * @returns `{ rule, permitted_emails }`.
 * @throws On a datastore error — callers fail CLOSED (send nothing / refuse / report restricted).
 */
const resolveSetupRule = async (): Promise<{ rule: SetupEligibility['rule']; permitted_emails: string[] }> => {
    const pinned = config.AUTH.SETUP_OWNER_EMAIL;
    if (typeof pinned === 'string' && pinned.trim()) {
        return { rule: SETUP_ELIGIBILITY_RULES.PIN, permitted_emails: [pinned.trim().toLowerCase()] };
    }
    const legacy = await legacyOperatorRepository.listLegacyEmails();
    if (legacy.length > 0) {
        return { rule: SETUP_ELIGIBILITY_RULES.LEGACY, permitted_emails: legacy };
    }
    return { rule: SETUP_ELIGIBILITY_RULES.OPEN, permitted_emails: [] };
};

/**
 * Whether one (already normalised) address may claim setup.
 *
 * @param params0 - The parameters object.
 * @param params0.email - The address, validated and lowercased.
 * @returns `{ rule, allowed, permitted_emails }` (`permitted_emails` is shell-only detail — never send it to a browser).
 * @throws On a datastore error.
 */
const evaluateSetupEligibility = async ({ email }: { email: string }): Promise<SetupEligibility> => {
    const resolved = await resolveSetupRule();
    const allowed = resolved.rule === SETUP_ELIGIBILITY_RULES.OPEN || resolved.permitted_emails.includes(email);
    return { rule: resolved.rule, allowed: allowed, permitted_emails: resolved.permitted_emails };
};

/**
 * `GET /api/auth/setup` (public, spec §7.1 + A7). While setup is incomplete: whether mail is
 * configured and how its last check went, whether setup is restricted (pin or legacy rows — TRUE
 * when that cannot be read), and this site's own configured address. Once complete: ONLY
 * `{ setup_complete: true }`. Never echoes an email.
 *
 * @returns Resolves `SetupStatus`; 503 DATASTORE_ERROR when the install document cannot be read or created.
 */
const getSetupStatus = (): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const install = await readInstallStateEnsured();
            if (!install) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.DATASTORE_ERROR, AUTH_MESSAGES.DATASTORE_ERROR));
            }
            if (isSetupLocked(install)) {
                const complete: SetupStatus = { setup_complete: true };
                return resolve(promiseHelper.promiseReturnResult(true, complete, {}, AUTH_MESSAGES.SETUP_STATUS));
            }
            let restricted = true;
            try {
                const resolved = await resolveSetupRule();
                restricted = resolved.rule !== SETUP_ELIGIBILITY_RULES.OPEN;
            } catch (ruleError) {
                logger.customConsoleError('ERROR: auth getSetupStatus — could not read the setup rule; reporting restricted', ruleError);
            }
            // The connect-and-login check only, never a send's outcome: a send happens only for a
            // permitted address, so a status sends could move would name that address (see
            // mail.service `_publicCheck`).
            const mail = mailModule.getMailStatus();
            const open: SetupStatus = {
                setup_complete: false,
                mail_configured: mail.configured,
                mail_last_check: mailModule.getPublicMailCheck(),
                setup_restricted: restricted,
                public_url: config.APP.PUBLIC_URL
            };
            return resolve(promiseHelper.promiseReturnResult(true, open, {}, AUTH_MESSAGES.SETUP_STATUS));
        } catch (error) {
            logger.customConsoleError('ERROR: auth getSetupStatus', error);
            return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.DATASTORE_ERROR, AUTH_MESSAGES.DATASTORE_ERROR));
        }
    });
};

/**
 * BOOT STEP 4. Rolls a crashed setup forward (spec §7.1): when the install is locked with an owner
 * pointer but no user has that id, the owner is inserted from the claim the completing request
 * wrote on its SETUP_VERIFY token. Idempotent (E11000 on `_id` = already done). The claim, which
 * holds a password hash, is unset once the owner row exists. Non-fatal.
 *
 * @returns Resolves `{ outcome }`: NOTHING_TO_DO | OWNER_PRESENT | OWNER_INSERTED | CLAIM_MISSING | EMAIL_TAKEN.
 */
const reconcileSetup = (): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        const done = (outcome: string): void => {
            resolve(promiseHelper.promiseReturnResult(true, { outcome: outcome }, {}, AUTH_MESSAGES.SETUP_RECONCILED));
        };
        try {
            const install = await systemStateRepository.findInstallState();
            if (!install || !isSetupLocked(install) || !install.owner_user_id) {
                return done('NOTHING_TO_DO');
            }
            const ownerId = String(install.owner_user_id);
            const tokenId = install.setup_token_id ? String(install.setup_token_id) : null;

            if (await userRepository.existsById(ownerId)) {
                if (tokenId) {
                    // Idempotent cleanup: a crash after the insert but before the unset leaves a hash here.
                    await authTokenRepository.unsetClaim({ token_id: tokenId });
                }
                return done('OWNER_PRESENT');
            }

            const token = tokenId ? await authTokenRepository.findByIdWithClaim(tokenId) : null;
            const claim = token && token.claim ? token.claim : null;
            if (!token || !claim || typeof claim.name !== 'string' || typeof claim.password_hash !== 'string' || !claim.password_hash) {
                logger.customConsoleError('ERROR: auth reconcileSetup — setup is locked but the owner account is missing and cannot be rebuilt ' +
                    `(the setup claim is gone). Recreate it with: ${REPAIR_OWNER_COMMAND}`, { owner_user_id: ownerId });
                return done('CLAIM_MISSING');
            }

            const now = new Date();
            try {
                await userRepository.insertUser({
                    _id: ownerId,
                    email: token.email,
                    name: claim.name,
                    password_hash: claim.password_hash,
                    role_key: ROLE_KEYS.ADMIN,
                    custom_role_id: null,
                    email_verified_at: token.used_at instanceof Date ? token.used_at : now,
                    password_changed_at: token.used_at instanceof Date ? token.used_at : now,
                    invited_by_user_id: null,
                    created_via: CREATED_VIA.SETUP
                });
            } catch (insertError) {
                const field = datastoreErrorHelper.duplicateKeyField(insertError);
                if (field === '_id') {
                    await authTokenRepository.unsetClaim({ token_id: String(token._id) });
                    return done('OWNER_PRESENT');
                }
                if (field === 'email') {
                    logger.customConsoleError('ERROR: auth reconcileSetup — the owner\'s email is already held by another account, so the owner cannot be ' +
                        `recreated. Move ownership to that account with: ${TRANSFER_OWNER_COMMAND}`, { owner_user_id: ownerId, email: token.email });
                    return done('EMAIL_TAKEN');
                }
                throw insertError;
            }
            await authTokenRepository.unsetClaim({ token_id: String(token._id) });
            logger.customConsoleLog('INFO: auth: rolled setup forward — the owner account was written at boot', { owner_user_id: ownerId, email: token.email });
            await auditService.recordAuditEvent(SYSTEM_IDENTITY, {
                actor_type: AUDIT_ACTOR_TYPES.SYSTEM,
                action: AUDIT_ACTIONS.SETUP_RECONCILED,
                target_type: AUDIT_TARGET_TYPES.USER,
                target_id: ownerId,
                target_email: token.email,
                now: now
            });
            return done('OWNER_INSERTED');
        } catch (error) {
            logger.customConsoleError('ERROR: auth reconcileSetup (non-fatal; runs again at the next boot)', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * BOOT STEP 5. Says, once, who may claim setup — and WARNs loudly when setup is open to whoever
 * reaches the dashboard first. Never prints `SETUP_OWNER_EMAIL`. Non-fatal.
 *
 * @returns Resolves `{ setup_complete, rule }` (`rule` null once complete or when unreadable).
 */
const logSetupState = (): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const install = await systemStateRepository.findInstallState();
            if (isSetupLocked(install)) {
                const ownerId = install && install.owner_user_id ? String(install.owner_user_id) : null;
                if (!ownerId) {
                    logger.customConsoleError(`ERROR: auth: setup is locked but no owner is set. Run: ${TRANSFER_OWNER_COMMAND}`);
                } else if (!(await userRepository.existsById(ownerId))) {
                    logger.customConsoleError(`ERROR: auth: setup is locked but the owner account is missing. Run: ${REPAIR_OWNER_COMMAND}`, { owner_user_id: ownerId });
                } else {
                    logger.customConsoleLog('INFO: auth: setup is complete', { owner_user_id: ownerId });
                }
                return resolve(promiseHelper.promiseReturnResult(true, { setup_complete: true, rule: null }, {}, AUTH_MESSAGES.SETUP_STATE_LOGGED));
            }

            let rule: SetupEligibility['rule'] | null = null;
            try {
                const resolved = await resolveSetupRule();
                rule = resolved.rule;
                if (resolved.rule === SETUP_ELIGIBILITY_RULES.PIN) {
                    logger.customConsoleLog('INFO: auth: setup is incomplete — only the address in SETUP_OWNER_EMAIL may claim it');
                } else if (resolved.rule === SETUP_ELIGIBILITY_RULES.LEGACY) {
                    logger.customConsoleLog('INFO: auth: setup is incomplete — only the single-operator account email(s) may claim it (set SETUP_OWNER_EMAIL to choose another)', {
                        permitted: resolved.permitted_emails
                    });
                } else {
                    logger.customConsoleWarn('WARN: auth: SETUP IS OPEN — whoever reaches the dashboard first can create the owner account. ' +
                        'Set SETUP_OWNER_EMAIL=<your address> and restart, or publish the dashboard on loopback only ' +
                        '("127.0.0.1:3000:3000" in docker-compose.yml) and reach it over an SSH tunnel until setup completes.');
                }
            } catch (ruleError) {
                logger.customConsoleError('ERROR: auth logSetupState — could not read the setup rule (setup requests fail closed until it can be read)', ruleError);
            }
            return resolve(promiseHelper.promiseReturnResult(true, { setup_complete: false, rule: rule }, {}, AUTH_MESSAGES.SETUP_STATE_LOGGED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth logSetupState (non-fatal)', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

export = {
    areAuthIndexesReady,
    resetInstallStateServiceState,
    readInstallStateEnsured,
    isSetupLocked,
    ensureInstallState,
    ensureAuthIndexes,
    markLegacyOperators,
    resolveSetupRule,
    evaluateSetupEligibility,
    getSetupStatus,
    reconcileSetup,
    logSetupState
};
