'use strict';

import { Schema, model } from 'mongoose';
// `export =` module — a named import here is TS2497, so it is imported whole and destructured.
import authVocab = require('../../constants/authVocab.constants');

const { USER_STATUSES, STORED_ROLE_KEYS, CREATED_VIA } = authVocab;

/**
 * A person who can sign in to this deployment.
 *
 * Created only by first-run setup (the owner) or by accepting an emailed invite. There is no public
 * signup and no deletion — a leaver is `status: 'disabled'`, which keeps every audit row that names
 * them resolvable.
 *
 *  NO "OWNER" FLAG. Ownership is `gi_system_states.owner_user_id`. The owner's stored `role_key` is
 * `'admin'`, a fallback that only takes effect if ownership moves elsewhere.
 *
 *  PERMISSIONS ARE NOT STORED HERE. `role_key` (+ `custom_role_id`) is resolved into a permission
 * set by `modules/auth/helpers/principal.helper#resolvePrincipal` on every request — the only
 * derivation of "what may this person do".
 *
 *  NO PASSWORD-HASHING HOOK. Mongoose 9 pre-hooks take no `next` callback, and the callback-style
 * hook that appears to work persists the plaintext when it returns before its callback fires. The
 * auth service hashes explicitly and is the only writer of `password_hash`.
 *
 * ⚠️ `strictQuery: true` (core/db.ts) silently STRIPS a filter path this schema does not declare —
 * the filter becomes `{}` and matches the first document. Every field any repository filters or
 * `$set`s on is declared below; add the field here BEFORE writing the query.
 */

const _modelName = 'gi_user';
const _collectionName = 'gi_users';

const userSchema = new Schema(
    {
        /**
         * Sign-in identity, lowercased and trimmed on write. Mongo's default collation is
         * case-sensitive, so the unique index below is only as good as this normalisation.
         * Lookups normalise the same way first (`identity.helper#normaliseEmail`) rather than lean
         * on query casting, which an aggregate does not do.
         */
        email: {
            type: String,
            required: true,
            trim: true,
            lowercase: true
        },
        /** Display name, validated by `identity.helper#validateName` before any write. */
        name: {
            type: String,
            required: true,
            trim: true
        },
        /**
         * bcrypt hash of the NFC-normalised password. Written only by the auth service.
         *
         * ⚠️ `select: false`: absent from every ordinary read, so an endpoint that returns a user
         * it did not shape cannot leak it. The repository functions that need it say `WithHash` in
         * their name.
         */
        password_hash: {
            type: String,
            required: true,
            select: false
        },
        /** One of `STORED_ROLE_KEYS`. Never `'owner'` — see the header. */
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
        status: {
            type: String,
            enum: Object.values(USER_STATUSES),
            default: USER_STATUSES.ACTIVE
        },
        /** When control of the mailbox was proven (setup verification link, or invite acceptance). */
        email_verified_at: {
            type: Date,
            default: null
        },
        /**
         * Last password write. A PASSWORD_RESET token minted BEFORE this instant is refused, so a
         * reset link cannot undo a later password change.
         */
        password_changed_at: {
            type: Date,
            default: null
        },
        /** `null` until the first sign-in — a real distinction from "signed in long ago". */
        last_login_at: {
            type: Date,
            default: null
        },
        invited_by_user_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_user',
            default: null
        },
        created_via: {
            type: String,
            enum: Object.values(CREATED_VIA),
            required: true
        },
        disabled_at: {
            type: Date,
            default: null
        },
        disabled_by_user_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_user',
            default: null
        },
        /**
         * Session generation. Every session row copies this value at sign-in, and the guard refuses
         * a session whose `epoch` differs (`SESSION_STALE`).
         *
         * WHY A COUNTER AND NOT ONLY `revoked_at` ON SESSIONS: a sign-in that read the user just
         * before a password reset committed would insert its session AFTER the reset's
         * "revoke all sessions" ran, and survive it. Bumping this in the SAME update that changes
         * the hash or the status closes that race — the late session carries the old epoch.
         */
        session_epoch: {
            type: Number,
            default: 0
        },
        /**
         * Password-reset emails sent to this user, NEWEST FIRST, capped in length by the writer's
         * `$push … $sort: -1, $slice`. The throttle is a compare-and-set on this array
         * (`user.repository#claimResetSendSlot`): positional filters on `reset_send_log.0` and
         * `reset_send_log.<max-1>` decide the interval and window rules in the same update that
         * records the send, so two concurrent requests cannot both pass.
         */
        reset_send_log: {
            type: [Date],
            default: []
        }
    },
    {
        // `createdAt` is the creation time — never a hand-declared `created_at` alongside it.
        timestamps: true
    }
);

// The sign-in lookup, and the gate against two accounts for one address. Invite acceptance relies
// on the E11000 from this index (keyPattern `{ email: 1 }`) as its ALREADY_A_MEMBER signal, so it
// must exist before the first insert — boot builds it explicitly (`authIndex.repository`).
userSchema.index({ email: 1 }, { unique: true, name: 'uniq_user_email' });

const User = model(_modelName, userSchema, _collectionName);

export = { User };
