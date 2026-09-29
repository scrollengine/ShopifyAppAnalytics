'use strict';

import { Schema, model } from 'mongoose';
// `export =` module — a named import here is TS2497, so it is imported whole and destructured.
import authVocab = require('../../constants/authVocab.constants');

const { AUDIT_ACTOR_TYPES, AUDIT_TARGET_TYPES } = authVocab;

/**
 * The security activity log: who did what to whom, and when.
 *
 * APPEND-ONLY. Nothing updates or deletes a row. `details` is small and NEVER carries a token, a
 * hash, a password or a full link — only ids, emails, role keys with a label snapshot, and counts.
 *
 * RETENTION, as a decision rather than an oversight:
 *  - Rows with an actor (USER / SYSTEM / CLI) have NO `expires_at` and never expire — the same
 *    no-TTL doctrine as `gi_sync_jobs`: silently expiring an audit ledger is worse than an unbounded
 *    one, and growth here is a handful of rows per person per day.
 *  - ANONYMOUS rows (setup requests, forgot-password) carry `expires_at = now + 180 days` and are
 *    removed by `ttl_audit_anonymous`. Anyone on the internet can generate them, so without a
 *    horizon they are the one unbounded-growth path in this collection.
 */

const _modelName = 'gi_audit_event';
const _collectionName = 'gi_audit_events';

const auditEventSchema = new Schema(
    {
        actor_type: {
            type: String,
            enum: Object.values(AUDIT_ACTOR_TYPES),
            required: true
        },
        actor_user_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_user',
            default: null
        },
        /** Recorded only when it passes `validateEmail`; otherwise `null` and `details.invalid_email: true`. */
        actor_email: {
            type: String,
            default: null
        },
        /**
         * One of `AUDIT_ACTIONS`, stored as a free String with no `enum` gate: the audit write is
         * best-effort, and an enum would turn an unknown action into a lost record on exactly the
         * path that exists to keep records.
         */
        action: {
            type: String,
            required: true
        },
        /** `null` when the action has no specific target. */
        target_type: {
            type: String,
            enum: Object.values(AUDIT_TARGET_TYPES),
            default: null
        },
        target_id: {
            type: String,
            default: null
        },
        target_email: {
            type: String,
            default: null
        },
        /** From `utils/clientAddress#clientIp`. */
        ip: {
            type: String,
            default: null
        },
        /** Small, action-specific facts. NEVER a token, hash, password or link. */
        details: {
            type: Schema.Types.Mixed,
            default: {}
        },
        /**
         * Set ONLY on ANONYMOUS rows. NO `default`: a row without the field is never touched by the
         * TTL index, which is how every non-anonymous row is kept forever.
         */
        expires_at: {
            type: Date
        }
    },
    {
        timestamps: true
    }
);

// The activity list: newest first, with `_id` as the tie-break so the `'<iso>|<objectId>'` cursor
// pages through rows that share a millisecond without skipping or repeating any.
auditEventSchema.index({ createdAt: -1, _id: -1 }, { name: 'idx_audit_created' });

// Expiry for ANONYMOUS rows only — rows without `expires_at` are ignored by a TTL index.
auditEventSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'ttl_audit_anonymous' });

const AuditEvent = model(_modelName, auditEventSchema, _collectionName);

export = { AuditEvent };
