'use strict';

/**
 * Every read and write on `gi_audit_events` — the append-only security log.
 *
 * APPEND-ONLY: nothing here updates or deletes a row. The only removal is the TTL on ANONYMOUS rows
 * (`expires_at`, set by `audit.helper#auditExpiresAt`); every other row is kept.
 *
 * The write THROWS like every repository write. `audit.service#recordAuditEvent` is the one caller
 * and it is best-effort (catches and logs), so a failed audit write never fails the action it
 * describes — but that decision lives in the service, not here.
 */

import models = require('../../shared/repositories/models.repository');

import type { AuditEventDoc } from '../../shared/types/entity.types';
import type { AuditCursor, NewAuditEventFields } from '../types/auth.types';

const { AuditEventModel } = models;

/**
 * Appends one audit row. `expires_at` is written ONLY when given (ANONYMOUS rows): a row without
 * the field is never touched by the TTL index.
 *
 * ⚠️ `details` must already be small and clean — never a token, hash, password or link. This file
 * cannot tell; `audit.service` builds it from the per-action keys in `audit.constants`.
 *
 * @param fields - The row.
 * @returns Resolves once written.
 */
const insertAuditEvent = async (fields: NewAuditEventFields): Promise<void> => {
    const doc: Record<string, unknown> = {
        actor_type: fields.actor_type,
        actor_user_id: fields.actor_user_id,
        actor_email: fields.actor_email,
        action: fields.action,
        target_type: fields.target_type,
        target_id: fields.target_id,
        target_email: fields.target_email,
        ip: fields.ip,
        details: fields.details && typeof fields.details === 'object' ? fields.details : {}
    };
    if (fields.expires_at instanceof Date) {
        doc.expires_at = fields.expires_at;
    }
    await AuditEventModel.create(doc);
};

/**
 * Reads one page of the log, newest first, keyed by `{ createdAt: -1, _id: -1 }`
 * (`idx_audit_created`).
 *
 * The cursor is the last row of the previous page (spec A15): rows strictly before its instant, or
 * AT its instant with a smaller `_id` — so rows sharing a millisecond are neither skipped nor
 * repeated across a page boundary.
 *
 * ⚠️ `limit` is used as given. The service asks for one MORE row than it shows, so it can tell
 * whether a further page exists without a count; it also clamps the public `?limit=` first
 * (`audit.helper#clampAuditLimit`).
 *
 * @param params0 - The parameters object.
 * @param params0.limit - Rows to read (a positive integer).
 * @param params0.before - The decoded cursor, or `null` for the first page.
 * @returns The rows, newest first.
 */
const listAuditEvents = async ({ limit, before }: { limit: number; before: AuditCursor | null }): Promise<AuditEventDoc[]> => {
    const size = Number.isInteger(limit) && limit > 0 ? limit : 1;
    const filter: Record<string, unknown> = {};
    if (before) {
        filter.$or = [
            { createdAt: { $lt: before.created_at } },
            { createdAt: before.created_at, _id: { $lt: before.id } }
        ];
    }
    return AuditEventModel.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(size)
        .lean<AuditEventDoc[]>();
};

export = {
    insertAuditEvent,
    listAuditEvents
};
