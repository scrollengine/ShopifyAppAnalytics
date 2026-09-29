'use strict';

/**
 * Audit-log shaping: which emails may be recorded, when an anonymous row expires, the pagination
 * cursor, and the API view of a row.
 *
 * PURE: no I/O, no config; `now` is passed in.
 */

import authConstants = require('../constants/auth.constants');
import auditConstants = require('../constants/audit.constants');
import identityHelper = require('./identity.helper');

import type { AuditEventDoc } from '../../shared/types/entity.types';
import type {
    AuditCursor,
    AuditCursorDecode,
    AuditEventView,
    SanitisedAuditEmail
} from '../types/auth.types';

const { AUDIT_ACTOR_TYPES, OBJECT_ID_REGEX } = authConstants;
const { AUDIT_ANONYMOUS_RETENTION_DAYS, AUDIT_LIST_DEFAULT_LIMIT, AUDIT_LIST_MAX_LIMIT } = auditConstants;

const DAY_MS = 24 * 60 * 60 * 1000;

/** An ISO-8601 instant with an explicit zone. Date-only or zone-less strings are refused (they parse as LOCAL time). */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The smallest ObjectId: a bare-instant cursor then means strictly "before that instant". */
const MIN_OBJECT_ID = '000000000000000000000000';

/** Longest cursor accepted: 24 (ISO) + 6 (offset) + 1 + 24, with headroom. */
const CURSOR_MAX_LENGTH = 80;

/**
 * Decides which email an audit row may record. Anonymous input is recorded only when it passes
 * `validateEmail` (spec A15); otherwise `null`, flagged so the row can say something was refused.
 *
 * @param value - The address as supplied.
 * @returns `{ email, invalid }` — nothing supplied is `{ email: null, invalid: false }`.
 */
const sanitiseAuditEmail = (value: unknown): SanitisedAuditEmail => {
    if (value === undefined || value === null || value === '') {
        return { email: null, invalid: false };
    }
    const checked = identityHelper.validateEmail(value);
    if (!checked.ok) {
        return { email: null, invalid: true };
    }
    return { email: checked.value, invalid: false };
};

/**
 * The `expires_at` for a new audit row: `now + 180 days` for ANONYMOUS rows, `undefined` (the field
 * is omitted, and the row never expires) for every other actor type.
 *
 * @param params0 - The parameters object.
 * @param params0.actor_type - The row's actor type.
 * @param params0.now - The instant the row is written.
 * @returns The expiry, or `undefined`.
 */
const auditExpiresAt = ({ actor_type, now }: { actor_type: string; now: Date }): Date | undefined => {
    if (actor_type !== AUDIT_ACTOR_TYPES.ANONYMOUS) {
        return undefined;
    }
    return new Date(now.getTime() + AUDIT_ANONYMOUS_RETENTION_DAYS * DAY_MS);
};

/**
 * Encodes the pagination cursor `'<iso>|<objectId>'` for the last row of a page.
 *
 * @param cursor - The last row's `createdAt` and `_id`.
 * @returns The cursor string.
 */
const encodeAuditCursor = ({ created_at, id }: AuditCursor): string => {
    return `${created_at.toISOString()}|${id}`;
};

/**
 * Decodes `?before=`. Accepts the `'<iso>|<objectId>'` cursor this API issues, or a bare ISO
 * instant (meaning strictly before it). Absent ⇒ no cursor (first page).
 *
 * @param value - The raw query value.
 * @returns `{ ok: true, cursor }` (`cursor` null when absent), or `{ ok: false }` for anything malformed.
 */
const decodeAuditCursor = (value: unknown): AuditCursorDecode => {
    if (value === undefined || value === null || value === '') {
        return { ok: true, cursor: null };
    }
    if (typeof value !== 'string' || value.length > CURSOR_MAX_LENGTH) {
        return { ok: false, cursor: null };
    }
    const parts = value.split('|');
    if (parts.length > 2) {
        return { ok: false, cursor: null };
    }
    const [instant, id = MIN_OBJECT_ID] = parts;
    if (!ISO_INSTANT.test(instant) || !OBJECT_ID_REGEX.test(id)) {
        return { ok: false, cursor: null };
    }
    const createdAt = new Date(instant);
    if (Number.isNaN(createdAt.getTime())) {
        return { ok: false, cursor: null };
    }
    return { ok: true, cursor: { created_at: createdAt, id: id } };
};

/**
 * Clamps `?limit=` into 1..200 (default 50).
 *
 * @param value - The raw query value: absent, a digit string, or a number.
 * @returns The clamped limit, or `null` when the value is present but not a whole number (⇒ 400).
 */
const clampAuditLimit = (value: unknown): number | null => {
    if (value === undefined || value === null || value === '') {
        return AUDIT_LIST_DEFAULT_LIMIT;
    }
    let parsed: number;
    if (typeof value === 'number') {
        parsed = value;
    } else if (typeof value === 'string' && /^\d{1,6}$/.test(value)) {
        parsed = Number(value);
    } else {
        return null;
    }
    if (!Number.isInteger(parsed)) {
        return null;
    }
    return Math.min(Math.max(parsed, 1), AUDIT_LIST_MAX_LIMIT);
};

/**
 * Stringifies an id field that may be null.
 *
 * @param value - An ObjectId, a string or null.
 * @returns The string form, or `null`.
 */
const _idOrNull = (value: unknown): string | null => {
    return value === null || value === undefined ? null : String(value);
};

/**
 * The API view of an audit row. Assembled field by field — never a spread of the document.
 *
 * @param doc - A `gi_audit_events` row.
 * @returns The view.
 */
const toAuditEventView = (doc: AuditEventDoc): AuditEventView => {
    return {
        event_id: String(doc._id),
        created_at: doc.createdAt || null,
        actor_type: doc.actor_type,
        actor_user_id: _idOrNull(doc.actor_user_id),
        actor_email: doc.actor_email || null,
        action: doc.action,
        target_type: doc.target_type || null,
        target_id: doc.target_id || null,
        target_email: doc.target_email || null,
        ip: doc.ip || null,
        details: doc.details && typeof doc.details === 'object' ? doc.details : {}
    };
};

export = {
    sanitiseAuditEmail,
    auditExpiresAt,
    encodeAuditCursor,
    decodeAuditCursor,
    clampAuditLimit,
    toAuditEventView
};
