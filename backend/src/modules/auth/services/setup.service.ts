'use strict';

/**
 * ============================================================================
 *  FIRST-RUN SETUP — request a verification link, inspect it, complete setup
 * ============================================================================
 *
 *  Step 1 (`requestSetup`, POST /api/auth/setup) answers the SAME 202 whether
 *  or not the address may claim setup (spec I7). Per A6 the response path does
 *  ONLY email-independent work — shape checks, the lock check, the global
 *  live-token count — and then ONE deferred job (`setImmediate`) does
 *  everything that depends on the address: the pin > legacy > open rule,
 *  throttles, the token insert, the audit row and the send. So neither the
 *  answer nor its timing says whether the address is permitted.
 *
 *  Step 2 (`completeSetup`, POST /api/auth/setup/complete) — ordered so a crash
 *  anywhere leaves a recoverable state (no transactions, spec I10):
 *
 *      1. shape (400) · indexes ready (503) · install read (503) · lock (409)
 *      2. live token (400 specific, A14) · address still permitted (400)
 *      3. password policy (400, nothing consumed)
 *      4. CLAIM: spend the token and record { name, password_hash } on it
 *      5. LOCK: CAS the install document to point at a pre-generated owner id
 *      6. insert the owner row with that id
 *      7. unset the claim, revoke every other live setup token, audit → 201
 *
 *  A crash between 5 and 6 is rolled forward at boot from the claim
 *  (`installState.service#reconcileSetup`). Setup never signs anyone in.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import config = require('../../../config');
import mailModule = require('../../mail');
import authConstants = require('../constants/auth.constants');
import auditConstants = require('../constants/audit.constants');
import identityHelper = require('../helpers/identity.helper');
import passwordHelper = require('../helpers/password.helper');
import tokenHelper = require('../helpers/token.helper');
import datastoreErrorHelper = require('../helpers/datastoreError.helper');
import requestContextHelper = require('../helpers/requestContext.helper');
import serviceResultHelper = require('../helpers/serviceResult.helper');
import userRepository = require('../repositories/user.repository');
import authTokenRepository = require('../repositories/authToken.repository');
import systemStateRepository = require('../repositories/systemState.repository');
import installStateService = require('./installState.service');
import authTokenService = require('./authToken.service');
import authMailService = require('./authMail.service');
import passwordHashService = require('./passwordHash.service');
import auditService = require('./audit.service');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type { SetupCompleteParams, SetupRequestParams, TokenParams } from '../types/auth.types';

const {
    AUTH_MESSAGES,
    AUTH_ERROR_CODES,
    TOKEN_PURPOSES,
    ROLE_KEYS,
    CREATED_VIA,
    AUDIT_ACTOR_TYPES,
    AUDIT_TARGET_TYPES,
    APP_LINK_PATHS,
    AUTH_SERVICE_ACTORS,
    INSTALL_STATE_ID,
    PASSWORD_POLICY_CODES,
    PASSWORD_POLICY_MESSAGES,
    SETUP_MAX_LIVE_TOKENS,
    SETUP_MAX_LIVE_PER_EMAIL,
    SETUP_REQUEST_MIN_INTERVAL_MS,
    SETUP_REQUEST_MAX_PER_HOUR
} = authConstants;
const { AUDIT_ACTIONS } = auditConstants;

const HOUR_MS = 60 * 60 * 1000;
const ANONYMOUS_IDENTITY = Object.freeze({ user_id: AUTH_SERVICE_ACTORS.ANONYMOUS });

/** Why a permitted setup request sent nothing. Logged and audited, never answered. */
const SETUP_REQUEST_OUTCOMES = Object.freeze({
    /** A link was created and handed to the mail module; the audit row's `email_status` says what the server did. */
    LINK_ISSUED: 'LINK_ISSUED',
    NOT_PERMITTED: 'NOT_PERMITTED',
    RULE_UNREADABLE: 'RULE_UNREADABLE',
    ALREADY_COMPLETE: 'ALREADY_COMPLETE',
    CAPACITY: 'CAPACITY',
    THROTTLED: 'THROTTLED',
    NO_LINK: 'NO_LINK',
    FAILED: 'FAILED'
} as const);

/**
 * The configured setup-link lifetime, clamped (the number the acknowledgement quotes).
 *
 * @returns Minutes.
 */
const _setupTtlMinutes = (): number => {
    return authTokenService.clampLinkMinutes({ minutes: config.AUTH.SETUP_TOKEN_TTL_MINUTES });
};

/**
 * The ONE acknowledgement for POST /setup, identical for every caller (the lifetime is config).
 *
 * @returns The message.
 */
const _acceptedMessage = (): string => {
    const minutes = _setupTtlMinutes();
    return `${AUTH_MESSAGES.SETUP_REQUEST_ACCEPTED} The link expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
};

/**
 * Records SETUP_REQUESTED for the deferred job (ANONYMOUS; 180-day retention).
 *
 * @param params0 - The parameters object.
 * @param params0.email - The address as validated.
 * @param params0.allowed - Whether the rule permits it (`null` when the rule could not be read).
 * @param params0.outcome - One of `SETUP_REQUEST_OUTCOMES`.
 * @param params0.ip - The requesting address.
 * @param params0.now - When.
 * @returns Resolves when recorded (or not — best-effort).
 */
const _auditSetupRequest = async ({ email, allowed, outcome, email_status, ip, now }: {
    email: string;
    allowed: boolean;
    outcome: string;
    email_status?: string;
    ip: string | null;
    now: Date;
}): Promise<void> => {
    const details: Record<string, unknown> = { allowed: allowed, outcome: outcome };
    if (email_status !== undefined) {
        details.email_status = email_status;
    }
    await auditService.recordAuditEvent(ANONYMOUS_IDENTITY, {
        actor_type: AUDIT_ACTOR_TYPES.ANONYMOUS,
        actor_email: email,
        action: AUDIT_ACTIONS.SETUP_REQUESTED,
        target_type: AUDIT_TARGET_TYPES.INSTALL,
        target_id: INSTALL_STATE_ID,
        ip: ip,
        details: details,
        now: now
    });
};

/**
 *  THE DEFERRED HALF OF POST /setup (spec A6/A7). Everything that depends on the address happens
 * here, after the response has been sent. Never throws.
 *
 * Throttles (count-based; pre-setup, low stakes): at most 3 live links per address, at least 60 s
 * since the last one, at most 3 per rolling hour; the global cap of 10 live links is re-checked. A
 * new request does NOT revoke earlier links.
 *
 * @param params0 - The parameters object.
 * @param params0.email - The validated, lowercased address.
 * @param params0.name - The validated name (stored on the token for the verify page; NEVER mailed).
 * @param params0.ip - The requesting address.
 * @returns Resolves the outcome (for tests); never rejects.
 */
const processSetupRequest = async ({ email, name, ip }: { email: string; name: string; ip: string | null }): Promise<string> => {
    const now = new Date();
    try {
        // FIRST, and for every address alike: refreshes what GET /setup shows about mail (so the
        // page's re-read can say mail is broken) without that value depending on whether this
        // address is the permitted one. Coalesced in the mail module; not awaited.
        mailModule.recheckTransport().catch(() => {
            // recheckTransport never rejects.
        });

        let eligibility;
        try {
            eligibility = await installStateService.evaluateSetupEligibility({ email: email });
        } catch (ruleError) {
            // Fail CLOSED: an unreadable allow-list sends nothing.
            logger.customConsoleError('ERROR: auth setup — could not read the setup allow-list; nothing sent', ruleError);
            await _auditSetupRequest({ email: email, allowed: false, outcome: SETUP_REQUEST_OUTCOMES.RULE_UNREADABLE, ip: ip, now: now });
            return SETUP_REQUEST_OUTCOMES.RULE_UNREADABLE;
        }
        if (!eligibility.allowed) {
            logger.customConsoleWarn('WARN: auth: setup request for a non-permitted email — nothing sent', { email: email, rule: eligibility.rule });
            await _auditSetupRequest({ email: email, allowed: false, outcome: SETUP_REQUEST_OUTCOMES.NOT_PERMITTED, ip: ip, now: now });
            return SETUP_REQUEST_OUTCOMES.NOT_PERMITTED;
        }

        const install = await systemStateRepository.findInstallState();
        if (!install) {
            logger.customConsoleError('ERROR: auth setup — the install document is missing; nothing sent', { email: email });
            return SETUP_REQUEST_OUTCOMES.FAILED;
        }
        if (installStateService.isSetupLocked(install)) {
            logger.customConsoleLog('INFO: auth: setup request arrived after setup completed — nothing sent', { email: email });
            await _auditSetupRequest({ email: email, allowed: true, outcome: SETUP_REQUEST_OUTCOMES.ALREADY_COMPLETE, ip: ip, now: now });
            return SETUP_REQUEST_OUTCOMES.ALREADY_COMPLETE;
        }

        const purpose = TOKEN_PURPOSES.SETUP_VERIFY;
        const liveTotal = await authTokenRepository.countLive({ purpose: purpose, now: now });
        if (liveTotal >= SETUP_MAX_LIVE_TOKENS) {
            logger.customConsoleWarn('WARN: auth: setup link capacity reached — nothing sent', { email: email, live: liveTotal });
            await _auditSetupRequest({ email: email, allowed: true, outcome: SETUP_REQUEST_OUTCOMES.CAPACITY, ip: ip, now: now });
            return SETUP_REQUEST_OUTCOMES.CAPACITY;
        }
        const liveForEmail = await authTokenRepository.countLiveForEmail({ purpose: purpose, email: email, now: now });
        const latest = await authTokenRepository.findLatestForEmail({ purpose: purpose, email: email });
        const sentLastHour = await authTokenRepository.countForEmailSince({ purpose: purpose, email: email, since: new Date(now.getTime() - HOUR_MS) });
        const latestAt = latest && latest.createdAt instanceof Date ? latest.createdAt.getTime() : 0;
        const tooSoon = latestAt > now.getTime() - SETUP_REQUEST_MIN_INTERVAL_MS;
        if (liveForEmail >= SETUP_MAX_LIVE_PER_EMAIL || tooSoon || sentLastHour >= SETUP_REQUEST_MAX_PER_HOUR) {
            logger.customConsoleLog('INFO: auth: setup request throttled for this address — nothing sent', {
                email: email,
                live_for_email: liveForEmail,
                too_soon: tooSoon,
                sent_last_hour: sentLastHour
            });
            await _auditSetupRequest({ email: email, allowed: true, outcome: SETUP_REQUEST_OUTCOMES.THROTTLED, ip: ip, now: now });
            return SETUP_REQUEST_OUTCOMES.THROTTLED;
        }

        const expiry = authTokenService.linkExpiry({ now: now, minutes: config.AUTH.SETUP_TOKEN_TTL_MINUTES, setting: 'AUTH_SETUP_TOKEN_TTL_MINUTES' });
        const issued = await authTokenService.insertLinkToken({
            purpose: purpose,
            email: email,
            user_id: null,
            name: name,
            expires_at: expiry.expires_at,
            request_ip: ip
        });
        const link = authTokenService.buildAppLink(APP_LINK_PATHS.SETUP_VERIFY, issued.token);
        if (!link) {
            await _auditSetupRequest({ email: email, allowed: true, outcome: SETUP_REQUEST_OUTCOMES.NO_LINK, ip: ip, now: now });
            return SETUP_REQUEST_OUTCOMES.NO_LINK;
        }
        // The requester-supplied name is deliberately NOT in this email (spec A7).
        const outcome = await authMailService.sendAuthEmail({
            identity: ANONYMOUS_IDENTITY,
            to: issued.row.email,
            template: mailModule.EMAIL_TEMPLATES.SETUP_VERIFY,
            vars: { now: now, expires_at: expiry.expires_at, link: link, ip: ip },
            trigger: mailModule.MAIL_TRIGGERS.ANONYMOUS
        });
        // Audited AFTER the send, with what the mail server actually said: an operator chasing
        // "I never got the email" must not find SENT for a message the server refused.
        await _auditSetupRequest({ email: email, allowed: true, outcome: SETUP_REQUEST_OUTCOMES.LINK_ISSUED, email_status: outcome.status, ip: ip, now: now });
        logger.customConsoleLog('INFO: auth: setup verification link send attempt finished (email_status says whether the mail server accepted it)', { email: email, email_status: outcome.status });
        return SETUP_REQUEST_OUTCOMES.LINK_ISSUED;
    } catch (error) {
        logger.customConsoleError('ERROR: auth setup processSetupRequest — nothing sent', error);
        return SETUP_REQUEST_OUTCOMES.FAILED;
    }
};

/**
 * `POST /api/auth/setup` (public) `{ email, name }`.
 *
 * @param _identity - Empty (public).
 * @param params - `{ email, name, request_ip, user_agent }`.
 * @returns Resolves 202-class `{ accepted: true }` with the ONE acknowledgement; 400 VALIDATION;
 *     409 SETUP_ALREADY_COMPLETE; 429 SETUP_CAPACITY; 503 DATASTORE_ERROR.
 */
const requestSetup = (_identity: Partial<IdentityObject> | null | undefined, params: SetupRequestParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const hasParams = params !== null && typeof params === 'object';
            const emailCheck = identityHelper.validateEmail(hasParams ? params.email : undefined);
            if (!emailCheck.ok) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.VALIDATION, emailCheck.reason, { field: 'email' }));
            }
            const nameCheck = identityHelper.validateName(hasParams ? params.name : undefined);
            if (!nameCheck.ok) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.VALIDATION, nameCheck.reason, { field: 'name' }));
            }
            const context = requestContextHelper.requestContextOf(params);

            // ── Email-INDEPENDENT work only, identical for every address (spec A6) ──
            const install = await installStateService.readInstallStateEnsured();
            if (!install) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.DATASTORE_ERROR, AUTH_MESSAGES.DATASTORE_ERROR));
            }
            if (installStateService.isSetupLocked(install)) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SETUP_ALREADY_COMPLETE, AUTH_MESSAGES.SETUP_ALREADY_COMPLETE));
            }
            const liveTotal = await authTokenRepository.countLive({ purpose: TOKEN_PURPOSES.SETUP_VERIFY, now: new Date() });
            if (liveTotal >= SETUP_MAX_LIVE_TOKENS) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SETUP_CAPACITY, AUTH_MESSAGES.SETUP_CAPACITY));
            }

            resolve(promiseHelper.promiseReturnResult(true, { accepted: true }, {}, _acceptedMessage()));

            const email = emailCheck.value;
            const name = nameCheck.value;
            setImmediate(() => {
                processSetupRequest({ email: email, name: name, ip: context.ip }).catch(() => {
                    // processSetupRequest never rejects; this keeps a future change from crashing the process.
                });
            });
        } catch (error) {
            logger.customConsoleError('ERROR: auth setup requestSetup', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * The shared front half of inspect and complete: token shape, install state, the live token, and
 * the address still being permitted (the pin may have changed since the link was sent).
 *
 * @param token - Raw request value.
 * @returns `{ ok: true, row, token_hash }` or `{ ok: false, failure }`.
 */
const _loadLiveSetupToken = async (token: unknown): Promise<
    { ok: true; row: { _id: unknown; email: string; name: string | null; expires_at: Date }; token_hash: string } | { ok: false; failure: ServiceResult }
> => {
    if (!tokenHelper.isWellFormedToken(token)) {
        return { ok: false, failure: serviceResultHelper.authFailure(AUTH_ERROR_CODES.TOKEN_INVALID, AUTH_MESSAGES.TOKEN_INVALID) };
    }
    const install = await installStateService.readInstallStateEnsured();
    if (!install) {
        return { ok: false, failure: serviceResultHelper.authFailure(AUTH_ERROR_CODES.DATASTORE_ERROR, AUTH_MESSAGES.DATASTORE_ERROR) };
    }
    if (installStateService.isSetupLocked(install)) {
        return { ok: false, failure: serviceResultHelper.authFailure(AUTH_ERROR_CODES.SETUP_ALREADY_COMPLETE, AUTH_MESSAGES.SETUP_ALREADY_COMPLETE) };
    }
    const now = new Date();
    const tokenHash = tokenHelper.hashToken(token);
    const row = await authTokenRepository.findLiveByTokenHash({ purpose: TOKEN_PURPOSES.SETUP_VERIFY, token_hash: tokenHash, now: now });
    if (!row) {
        return { ok: false, failure: await authTokenService.deadTokenFailure({ purpose: TOKEN_PURPOSES.SETUP_VERIFY, token_hash: tokenHash, now: now }) };
    }
    const eligibility = await installStateService.evaluateSetupEligibility({ email: row.email });
    if (!eligibility.allowed) {
        logger.customConsoleWarn('WARN: auth: a setup link was used for an address that is no longer permitted', { email: row.email, rule: eligibility.rule });
        return { ok: false, failure: serviceResultHelper.authFailure(AUTH_ERROR_CODES.TOKEN_INVALID, AUTH_MESSAGES.TOKEN_INVALID) };
    }
    return { ok: true, row: row, token_hash: tokenHash };
};

/**
 * `POST /api/auth/setup/inspect` (public) `{ token }`. Consumes nothing.
 *
 * @param _identity - Empty (public).
 * @param params - `{ token }`.
 * @returns Resolves `{ email, name, expires_at }`; 400 TOKEN_INVALID / TOKEN_EXPIRED / TOKEN_USED;
 *     409 SETUP_ALREADY_COMPLETE; 503 DATASTORE_ERROR. Never 401.
 */
const inspectSetupToken = (_identity: Partial<IdentityObject> | null | undefined, params: TokenParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const loaded = await _loadLiveSetupToken(params !== null && typeof params === 'object' ? params.token : undefined);
            if (!loaded.ok) {
                return resolve(loaded.failure);
            }
            const view = { email: loaded.row.email, name: loaded.row.name || '', expires_at: loaded.row.expires_at };
            return resolve(promiseHelper.promiseReturnResult(true, view, {}, AUTH_MESSAGES.TOKEN_OK));
        } catch (error) {
            logger.customConsoleError('ERROR: auth setup inspectSetupToken', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `POST /api/auth/setup/complete` (public) `{ token, name, password }`. See the file header for the
 * order and why. Never signs anyone in.
 *
 * @param _identity - Empty (public).
 * @param params - `{ token, name, password, request_ip, user_agent }`.
 * @returns Resolves `{ setup_complete: true }` (201); 400 TOKEN_* / VALIDATION / PASSWORD_POLICY;
 *     409 SETUP_ALREADY_COMPLETE; 503 INDEXES_NOT_READY / DATASTORE_ERROR. Never 401.
 */
const completeSetup = (_identity: Partial<IdentityObject> | null | undefined, params: SetupCompleteParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const hasParams = params !== null && typeof params === 'object';
            const token = hasParams ? params.token : undefined;
            const password = hasParams ? params.password : undefined;
            // ── 1. Shape, before anything touches the database ─────────────────
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

            // ── 2. Install, lock, live token, address still permitted ──────────
            const loaded = await _loadLiveSetupToken(token);
            if (!loaded.ok) {
                return resolve(loaded.failure);
            }
            const tokenRow = loaded.row;
            const tokenId = String(tokenRow._id);

            // ── 3. Policy — nothing consumed on refusal ─────────────────────────
            const policy = passwordHelper.evaluatePasswordPolicy({
                password: password,
                email: tokenRow.email,
                name: name,
                truncates: passwordHashService.passwordTruncates
            });
            if (!policy.ok) {
                return resolve(serviceResultHelper.passwordPolicyFailure(policy));
            }
            const passwordHash = await passwordHashService.hashPassword(password);

            // ── 4. CLAIM ────────────────────────────────────────────────────────
            const claimed = await authTokenRepository.claimSetupToken({ token_id: tokenId, name: name, password_hash: passwordHash, now: new Date() });
            if (!claimed) {
                return resolve(await authTokenService.deadTokenFailure({
                    purpose: TOKEN_PURPOSES.SETUP_VERIFY,
                    token_hash: loaded.token_hash,
                    now: new Date()
                }));
            }

            // ── 5. LOCK ─────────────────────────────────────────────────────────
            const ownerId = userRepository.newUserId();
            const now = new Date();
            const locked = await systemStateRepository.lockSetup({ owner_user_id: ownerId, setup_token_id: tokenId, now: now });
            if (!locked) {
                // Lost the race (or the document vanished). This claim will never be rolled forward.
                await authTokenRepository.unsetClaim({ token_id: tokenId });
                const reread = await systemStateRepository.findInstallState();
                if (reread && installStateService.isSetupLocked(reread)) {
                    return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SETUP_ALREADY_COMPLETE, AUTH_MESSAGES.SETUP_ALREADY_COMPLETE));
                }
                logger.customConsoleError('ERROR: auth completeSetup — the install document is missing at the lock step', { token_id: tokenId });
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.DATASTORE_ERROR, AUTH_MESSAGES.DATASTORE_ERROR));
            }

            // ── 6. OWNER ROW ────────────────────────────────────────────────────
            let ownerWritten = false;
            try {
                await userRepository.insertUser({
                    _id: ownerId,
                    email: tokenRow.email,
                    name: name,
                    password_hash: passwordHash,
                    role_key: ROLE_KEYS.ADMIN,
                    custom_role_id: null,
                    email_verified_at: now,
                    password_changed_at: now,
                    invited_by_user_id: null,
                    created_via: CREATED_VIA.SETUP
                });
                ownerWritten = true;
            } catch (insertError) {
                const field = datastoreErrorHelper.duplicateKeyField(insertError);
                if (field === '_id') {
                    ownerWritten = true;
                } else if (field === 'email') {
                    logger.customConsoleError('ERROR: auth completeSetup — setup is locked but the owner email is already held by another account. ' +
                        'Move ownership to that account with: npm run auth:admin:dist -- transfer-owner --email <address>', { owner_user_id: ownerId });
                    return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.INTERNAL_ERROR, AUTH_MESSAGES.INTERNAL_ERROR));
                } else {
                    // The lock is taken; the claim on the token lets the roll-forward write the owner.
                    // Try it once now rather than leaving the owner unable to sign in until a restart.
                    logger.customConsoleWarn('WARN: auth completeSetup — owner insert failed after the lock; rolling forward from the claim', insertError);
                    const rolled = await installStateService.reconcileSetup();
                    const rolledOutcome = rolled.status && rolled.data ? rolled.data.outcome : null;
                    ownerWritten = rolledOutcome === 'OWNER_INSERTED' || rolledOutcome === 'OWNER_PRESENT';
                }
            }
            if (!ownerWritten) {
                logger.customConsoleError('ERROR: auth completeSetup — setup is locked but the owner row is not written yet; the next boot rolls it forward ' +
                    '(or run: npm run auth:admin:dist -- repair-owner --email <address> --name <name>)', { owner_user_id: ownerId });
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.DATASTORE_ERROR, AUTH_MESSAGES.DATASTORE_ERROR));
            }

            // ── 7. Clean up, audit ──────────────────────────────────────────────
            try {
                await authTokenRepository.unsetClaim({ token_id: tokenId });
                await authTokenRepository.revokeLiveTokens({ purpose: TOKEN_PURPOSES.SETUP_VERIFY, now: now });
            } catch (cleanupError) {
                // Harmless leftovers: the lock refuses every other setup link, and boot unsets the claim.
                logger.customConsoleWarn('WARN: auth completeSetup — post-setup cleanup failed (boot reconciliation finishes it)', cleanupError);
            }
            await auditService.recordAuditEvent({ user_id: ownerId }, {
                actor_type: AUDIT_ACTOR_TYPES.USER,
                actor_user_id: ownerId,
                actor_email: tokenRow.email,
                action: AUDIT_ACTIONS.SETUP_COMPLETED,
                target_type: AUDIT_TARGET_TYPES.INSTALL,
                target_id: INSTALL_STATE_ID,
                ip: context.ip,
                now: now
            });
            logger.customConsoleLog('INFO: auth: SETUP COMPLETE — the owner account exists and setup is locked for good', {
                owner_user_id: ownerId,
                email: tokenRow.email
            });
            return resolve(promiseHelper.promiseReturnResult(true, { setup_complete: true }, {}, AUTH_MESSAGES.SETUP_COMPLETED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth setup completeSetup', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

export = {
    requestSetup,
    processSetupRequest,
    inspectSetupToken,
    completeSetup
};
