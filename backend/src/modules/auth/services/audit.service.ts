'use strict';

/**
 * ============================================================================
 *  AUDIT — the security activity log
 * ============================================================================
 *
 *  `recordAuditEvent` is BEST-EFFORT: it never throws, never rejects, and its
 *  failure never fails the action it describes (an unwritable audit row is not
 *  a reason to refuse a password reset that already happened). It logs instead.
 *
 *  What it refuses to store, whatever a caller passes:
 *    - an action, actor type or target type outside the frozen vocabularies;
 *    - an email that does not pass `validateEmail` (recorded as null with
 *      `details.invalid_email: true` — anonymous input is attacker-chosen text);
 *    - any `details` key that names a token, password, hash, secret or link,
 *      and any value that is not a short primitive (or a one-level snapshot
 *      such as `{ key, label }`).
 *
 *  ANONYMOUS rows expire after 180 days (`expires_at`, TTL); every other row is
 *  kept (spec A15).
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import authConstants = require('../constants/auth.constants');
import auditConstants = require('../constants/audit.constants');
import permissionsConstants = require('../constants/permissions.constants');
import auditHelper = require('../helpers/audit.helper');
import identityHelper = require('../helpers/identity.helper');
import serviceResultHelper = require('../helpers/serviceResult.helper');
import auditEventRepository = require('../repositories/auditEvent.repository');
import principalService = require('./principal.service');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type { AuditEventList, AuditListParams, AuditRecordParams } from '../types/auth.types';

const { AUTH_MESSAGES, AUTH_ERROR_CODES, AUDIT_ACTOR_TYPES, AUDIT_TARGET_TYPES } = authConstants;
const { AUDIT_ACTIONS } = auditConstants;
const { PERMISSIONS } = permissionsConstants;

const KNOWN_ACTIONS: readonly string[] = Object.freeze(Object.values(AUDIT_ACTIONS));
const KNOWN_ACTOR_TYPES: readonly string[] = Object.freeze(Object.values(AUDIT_ACTOR_TYPES));
const KNOWN_TARGET_TYPES: readonly string[] = Object.freeze(Object.values(AUDIT_TARGET_TYPES));

/** A `details` key that could carry a credential. Dropped, whatever its value. */
const FORBIDDEN_DETAIL_KEY = /token|password|passwd|hash|secret|link|claim/i;

const MAX_DETAIL_KEYS = 20;
const MAX_DETAIL_STRING = 300;
const MAX_DETAIL_ARRAY = 64;
const MAX_TARGET_ID_LENGTH = 64;

/**
 * Whether a detail value is a small primitive worth storing.
 *
 * @param value - The candidate.
 * @returns The value (strings capped), or `undefined` to drop it.
 */
const _cleanPrimitive = (value: unknown): string | number | boolean | null | undefined => {
    if (value === null) {
        return null;
    }
    if (typeof value === 'string') {
        return value.slice(0, MAX_DETAIL_STRING);
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    return undefined;
};

/**
 * Reduces `details` to what may be stored: at most 20 keys; per key a primitive, an array of
 * primitives, or a ONE-level object of primitives (the `{ key, label }` role snapshots). Credential-
 * named keys are dropped at both levels.
 *
 * @param details - What the caller passed.
 * @returns The cleaned object.
 */
const _cleanDetails = (details: unknown): Record<string, unknown> => {
    const cleaned: Record<string, unknown> = {};
    if (details === null || typeof details !== 'object' || Array.isArray(details)) {
        return cleaned;
    }
    const keys = Object.keys(details).slice(0, MAX_DETAIL_KEYS);
    for (const key of keys) {
        if (FORBIDDEN_DETAIL_KEY.test(key)) {
            continue;
        }
        const value: unknown = Reflect.get(details, key);
        const primitive = _cleanPrimitive(value);
        if (primitive !== undefined) {
            cleaned[key] = primitive;
            continue;
        }
        if (Array.isArray(value)) {
            const items = value.slice(0, MAX_DETAIL_ARRAY).map(_cleanPrimitive).filter((item) => item !== undefined);
            cleaned[key] = items;
            continue;
        }
        if (value !== null && typeof value === 'object') {
            const nested: Record<string, unknown> = {};
            for (const nestedKey of Object.keys(value).slice(0, MAX_DETAIL_KEYS)) {
                if (FORBIDDEN_DETAIL_KEY.test(nestedKey)) {
                    continue;
                }
                const nestedValue = _cleanPrimitive(Reflect.get(value, nestedKey));
                if (nestedValue !== undefined) {
                    nested[nestedKey] = nestedValue;
                }
            }
            cleaned[key] = nested;
        }
    }
    return cleaned;
};

/**
 * A target id as stored: an ObjectId's hex, `'install'`, or `null`.
 *
 * @param value - The candidate.
 * @returns The string id, or `null`.
 */
const _targetId = (value: unknown): string | null => {
    if (value === null || value === undefined) {
        return null;
    }
    if (identityHelper.isObjectIdLike(value)) {
        return String(value);
    }
    if (typeof value === 'string' && value.length > 0 && value.length <= MAX_TARGET_ID_LENGTH) {
        return value;
    }
    return null;
};

/**
 * Appends one row to the security log. BEST-EFFORT: always resolves, never rejects; a refused or
 * failed write is logged and reported as `status: false`, which callers ignore.
 *
 * @param _identity - The identity object (the actor is named in `params`, which also covers anonymous, system and CLI actors).
 * @param params - The row: `actor_type`, `actor_user_id?`, `actor_email?`, `action`, `target_type?`,
 *     `target_id?`, `target_email?`, `ip?`, `details?`, `now?`.
 * @returns Resolves `{ recorded: boolean }`.
 */
const recordAuditEvent = (_identity: Partial<IdentityObject> | null | undefined, params: AuditRecordParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const input = params && typeof params === 'object' ? params : null;
            if (!input || !KNOWN_ACTIONS.includes(input.action) || !KNOWN_ACTOR_TYPES.includes(input.actor_type)) {
                logger.customConsoleError('ERROR: auth audit recordAuditEvent — refused a row with an unknown action or actor type', {
                    action: input && typeof input.action === 'string' ? input.action.slice(0, 64) : null,
                    actor_type: input && typeof input.actor_type === 'string' ? input.actor_type.slice(0, 32) : null
                });
                return resolve(promiseHelper.promiseReturnResult(false, { recorded: false }, { code: AUTH_ERROR_CODES.VALIDATION }, 'Audit row refused.'));
            }
            const targetType = input.target_type === null || input.target_type === undefined ? null : input.target_type;
            if (targetType !== null && !KNOWN_TARGET_TYPES.includes(targetType)) {
                logger.customConsoleError('ERROR: auth audit recordAuditEvent — refused a row with an unknown target type', { action: input.action });
                return resolve(promiseHelper.promiseReturnResult(false, { recorded: false }, { code: AUTH_ERROR_CODES.VALIDATION }, 'Audit row refused.'));
            }

            const now = input.now instanceof Date ? input.now : new Date();
            const details = _cleanDetails(input.details);
            const actorEmail = auditHelper.sanitiseAuditEmail(input.actor_email);
            const targetEmail = auditHelper.sanitiseAuditEmail(input.target_email);
            if (actorEmail.invalid || targetEmail.invalid) {
                details.invalid_email = true;
            }
            const actorUserId = identityHelper.isObjectIdLike(input.actor_user_id) ? String(input.actor_user_id) : null;
            const ip = typeof input.ip === 'string' && input.ip.length > 0 && input.ip.length <= 45 ? input.ip : null;

            await auditEventRepository.insertAuditEvent({
                actor_type: input.actor_type,
                actor_user_id: actorUserId,
                actor_email: actorEmail.email,
                action: input.action,
                target_type: targetType,
                target_id: _targetId(input.target_id),
                target_email: targetEmail.email,
                ip: ip,
                details: details,
                expires_at: auditHelper.auditExpiresAt({ actor_type: input.actor_type, now: now })
            });
            return resolve(promiseHelper.promiseReturnResult(true, { recorded: true }, {}, 'Audit row recorded.'));
        } catch (error) {
            logger.customConsoleError('ERROR: auth audit recordAuditEvent — the row was not written (the action itself stands)', {
                action: params && typeof params.action === 'string' ? params.action : null,
                error_name: error instanceof Error ? error.name : typeof error
            });
            return resolve(promiseHelper.promiseReturnResult(false, { recorded: false }, { code: AUTH_ERROR_CODES.DATASTORE_ERROR }, 'Audit row not written.'));
        }
    });
};

/**
 * One page of the security log, newest first (`GET /api/audit-events`, audit:read).
 *
 * `limit` is clamped into 1..200 (default 50); `before` is the `next_before` cursor of the previous
 * page (`'<iso>|<objectId>'`) or a bare ISO instant with a zone. One extra row is read so
 * `next_before` is set only when another page exists.
 *
 * @param identity - The acting user (re-loaded; must hold `audit:read`).
 * @param params - `{ limit?, before? }` from the query string.
 * @returns Resolves `AuditEventList` (`{ items, next_before }`); 400 VALIDATION for a malformed limit or cursor.
 */
const listAuditEvents = (identity: IdentityObject, params: AuditListParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const input = params && typeof params === 'object' ? params : {};
            const limit = auditHelper.clampAuditLimit(Reflect.get(input, 'limit'));
            if (limit === null) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.VALIDATION, 'limit must be a whole number between 1 and 200.', { field: 'limit' }));
            }
            const cursor = auditHelper.decodeAuditCursor(Reflect.get(input, 'before'));
            if (!cursor.ok) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.VALIDATION, 'before must be the next_before value of a previous page.', { field: 'before' }));
            }

            const actor = await principalService.loadActor(identity);
            if (!actor.ok) {
                return resolve(actor.failure);
            }
            const forbidden = principalService.requirePermission(actor.principal, PERMISSIONS.AUDIT_READ);
            if (forbidden) {
                return resolve(forbidden);
            }

            const rows = await auditEventRepository.listAuditEvents({ limit: limit + 1, before: cursor.cursor });
            const page = rows.slice(0, limit);
            let nextBefore: string | null = null;
            if (rows.length > limit && page.length > 0) {
                const last = page[page.length - 1];
                if (last.createdAt instanceof Date) {
                    nextBefore = auditHelper.encodeAuditCursor({ created_at: last.createdAt, id: String(last._id) });
                }
            }
            const list: AuditEventList = {
                items: page.map(auditHelper.toAuditEventView),
                next_before: nextBefore
            };
            return resolve(promiseHelper.promiseReturnResult(true, list, {}, AUTH_MESSAGES.AUDIT_LISTED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth audit listAuditEvents', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

export = {
    recordAuditEvent,
    listAuditEvents
};
