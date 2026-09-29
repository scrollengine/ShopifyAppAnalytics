'use strict';

import { Schema, model } from 'mongoose';

/**
 * One signed-in session. `_id` IS the session id (`sid` in the JWT).
 *
 * The guard re-reads this row on every request: a revoked, expired or stale-epoch session is
 * refused even though its JWT still verifies. That is what makes sign-out, "sign this user out",
 * disabling a user and a password reset take effect immediately instead of at token expiry.
 *
 * ⚠️ `strictQuery: true` strips undeclared filter paths (the filter then matches the first
 * document). Every field a repository filters or `$set`s on is declared here.
 */

const _modelName = 'gi_auth_session';
const _collectionName = 'gi_auth_sessions';

const authSessionSchema = new Schema(
    {
        user_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_user',
            required: true
        },
        /**
         * `gi_users.session_epoch` as read by the SAME user read the sign-in's bcrypt compare used.
         * The guard refuses the session (`SESSION_STALE`) once the user's epoch has moved on.
         */
        epoch: {
            type: Number,
            required: true,
            default: 0
        },
        /** Matches the JWT `exp`. The guard also checks it; the TTL below is cleanup only. */
        expires_at: {
            type: Date,
            required: true
        },
        revoked_at: {
            type: Date,
            default: null
        },
        /** One of `SESSION_REVOKE_REASONS`. Free String so a later build's reason is still recordable. */
        revoked_reason: {
            type: String,
            default: null
        },
        /** From `utils/clientAddress#clientIp` — `null` when the address is not a valid IP. */
        ip: {
            type: String,
            default: null
        },
        /** Truncated to 200 characters by the repository before the write. */
        user_agent: {
            type: String,
            default: null
        }
    },
    {
        timestamps: true
    }
);

// "Every session of this user" — sign-out-everywhere and the per-user revocations.
authSessionSchema.index({ user_id: 1 }, { name: 'idx_session_user' });

// Cleanup at expiry. The guard never relies on it: it compares `expires_at` itself.
authSessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'ttl_session_expires' });

const AuthSession = model(_modelName, authSessionSchema, _collectionName);

export = { AuthSession };
