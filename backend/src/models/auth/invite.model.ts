'use strict';

import { Schema, model } from 'mongoose';
// `export =` module — a named import here is TS2497, so it is imported whole and destructured.
import authVocab = require('../../constants/authVocab.constants');

const { STORED_ROLE_KEYS } = authVocab;

/**
 * An emailed invitation to join this deployment with a given role.
 *
 * The link carries an opaque 256-bit token; only its sha256 is stored (`token_hash`). Acceptance is
 * a compare-and-set whose filter names the token hash and `accepted_at: null, revoked_at: null,
 * expires_at > now`, so a link is spent exactly once.
 *
 * State is NEVER stored as a field: pending / expired / accepted / revoked is computed from the
 * timestamps by `invite.helper#inviteState`, the one derivation of it.
 *
 * ⚠️ `strictQuery: true` strips undeclared filter paths (the filter then matches the first
 * document). Every field a repository filters or `$set`s on is declared here.
 */

const _modelName = 'gi_invite';
const _collectionName = 'gi_invites';

const inviteSchema = new Schema(
    {
        /** Invitee address, lowercased and trimmed. Mail always goes to this stored value. */
        email: {
            type: String,
            required: true,
            trim: true,
            lowercase: true
        },
        /**
         * A copy of `email` that exists ONLY while the invite is outstanding: set on create,
         * `$unset` on accept and on revoke. The partial unique index below makes "one outstanding
         * invite per address" a database guarantee rather than a check-then-insert race; its E11000
         * (keyPattern `{ pending_email: 1 }`) is the INVITE_PENDING signal. An expired invite that
         * was never revoked still holds it — resend that one instead of creating a second.
         *
         * ⚠️ NO `default`. `{ $exists: true }` matches an explicit `null`, so a `default: null` here
         * would put every settled invite into the unique index under one `null` key and the second
         * accept would fail with E11000.
         */
        pending_email: {
            type: String,
            trim: true,
            lowercase: true
        },
        /** One of `STORED_ROLE_KEYS`. Never `'owner'`. */
        role_key: {
            type: String,
            enum: STORED_ROLE_KEYS,
            required: true
        },
        /** The `gi_roles._id` when `role_key === 'custom'`; `null` for every built-in role. */
        custom_role_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_role',
            default: null
        },
        /**
         * Who currently answers for this invite. Set on create and REPLACED by a resend (the resender
         * has just passed the management rule) and by an ownership transfer. Acceptance re-checks the
         * management rule against THIS user.
         */
        invited_by_user_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_user',
            required: true
        },
        /**
         * Who created the invite. Never changes after insert, unlike `invited_by_user_id`, so the
         * per-actor creation cap (≤20 per 24 h) counts what an actor CREATED rather than what they
         * happen to answer for after a resend or a transfer.
         */
        created_by_user_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_user',
            required: true
        },
        /**
         * sha256 hex of the link token. Rotated by every resend, so an older link stops working.
         *
         * ⚠️ `select: false`. Only the repository's token lookups ask for `+token_hash`; they
         * compare it in code (belt and braces over the query) and delete it from the object before
         * returning, so a service never holds a hash.
         */
        token_hash: {
            type: String,
            required: true,
            select: false
        },
        /** The link stops working at this instant. Every live-invite query names `expires_at > now`. */
        expires_at: {
            type: Date,
            required: true
        },
        accepted_at: {
            type: Date,
            default: null
        },
        /** The `gi_users._id` the acceptance created. */
        accepted_user_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_user',
            default: null
        },
        revoked_at: {
            type: Date,
            default: null
        },
        /** `null` for a revocation the system made (supersession, inviter disabled, role deleted). */
        revoked_by_user_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_user',
            default: null
        },
        /**
         * One of `INVITE_REVOKE_REASONS`, stored as a free String with no `enum` gate: a reason a
         * later build adds must still be recordable here without a failed write on the revoke path.
         */
        revoked_reason: {
            type: String,
            default: null
        },
        /** Last time the invite email was handed to the mail server (or attempted). */
        last_sent_at: {
            type: Date,
            default: null
        },
        send_count: {
            type: Number,
            default: 0
        },
        /**
         * Send times, NEWEST FIRST, capped in length by the writer's `$push … $sort: -1, $slice`.
         * The resend throttle is a compare-and-set on `send_log.<n>` in the same update that
         * records the send (`invite.repository#claimResend`).
         */
        send_log: {
            type: [Date],
            default: []
        }
    },
    {
        timestamps: true
    }
);

// The acceptance lookup. Unique, so two invites can never share a link.
inviteSchema.index({ token_hash: 1 }, { unique: true, name: 'uniq_invite_token_hash' });

// "Invites for this address" — the sibling revocation on accept and the admin list filter.
inviteSchema.index({ email: 1 }, { name: 'idx_invite_email' });

// One outstanding invite per address. PARTIAL on `$exists: true`, so settled invites (which have
// `pending_email` unset) never collide. See the field comment for why there is no default.
inviteSchema.index(
    { pending_email: 1 },
    {
        unique: true,
        name: 'uniq_invite_pending_email',
        partialFilterExpression: { pending_email: { $exists: true } }
    }
);

const Invite = model(_modelName, inviteSchema, _collectionName);

export = { Invite };
