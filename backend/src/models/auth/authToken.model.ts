'use strict';

import { Schema, model } from 'mongoose';
// `export =` module — a named import here is TS2497, so it is imported whole and destructured.
import authVocab = require('../../constants/authVocab.constants');

const { TOKEN_PURPOSES } = authVocab;

/**
 * A single-use email-link token: first-run setup verification, or a password reset.
 *
 *  OPAQUE AND HASHED. The link carries 32 random bytes (base64url, 43 chars); only their sha256 is
 * stored. These are never JWTs — a JWT cannot be spent once, and a leaked signing key would mint
 * them.
 *
 *  SINGLE USE BY CAS. Spending a token is `findOneAndUpdate({ _id, used_at: null,
 * revoked_at: null, expires_at: { $gt: now } }, { $set: { used_at: now } })`. Every live lookup
 * names `expires_at > now` itself: the TTL index below is CLEANUP, and TTL deletion runs once a
 * minute at best, so an expired row can still be sitting here.
 *
 * ⚠️ `strictQuery: true` strips undeclared filter paths (the filter then matches the first
 * document). Every field a repository filters or `$set`s on is declared here.
 */

const _modelName = 'gi_auth_token';
const _collectionName = 'gi_auth_tokens';

/**
 * The setup claim: the owner's name and password hash, written in the SAME CAS that spends the
 * setup token, before the install lock is taken.
 *
 * Why it exists: completing setup is several writes with no transaction (spend token → lock
 * install → insert owner). If the process dies after the lock and before the insert, the install is
 * locked with no owner. The claim is what lets the boot roll-forward (`reconcileSetup`) insert the
 * owner the user actually chose, instead of stranding the install. It is `$unset` as soon as the
 * owner row exists.
 */
const claimSchema = new Schema(
    {
        name: { type: String },
        password_hash: { type: String }
    },
    { _id: false }
);

const authTokenSchema = new Schema(
    {
        purpose: {
            type: String,
            enum: Object.values(TOKEN_PURPOSES),
            required: true
        },
        /**
         * sha256 hex of the link token.
         *
         * ⚠️ `select: false`. Only the repository's token lookups ask for `+token_hash`; they
         * compare it in code and delete it from the object before returning.
         */
        token_hash: {
            type: String,
            required: true,
            select: false
        },
        /**
         * The address the link was mailed to, lowercased. For PASSWORD_RESET the redeeming service
         * also requires `user.email === token.email`, so a reset link cannot outlive an email change.
         */
        email: {
            type: String,
            required: true,
            trim: true,
            lowercase: true
        },
        /** The user a PASSWORD_RESET is for. `null` for SETUP_VERIFY (no user exists yet). */
        user_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_user',
            default: null
        },
        /**
         * SETUP_VERIFY only: the name supplied with the request, offered back on the verify page.
         * It is never put into the verification email.
         */
        name: {
            type: String,
            default: null
        },
        /** Every live lookup names `expires_at > now`; the TTL below is cleanup only. */
        expires_at: {
            type: Date,
            required: true
        },
        used_at: {
            type: Date,
            default: null
        },
        revoked_at: {
            type: Date,
            default: null
        },
        /** From `utils/clientAddress#clientIp` — `null` when the address is not a valid IP. */
        request_ip: {
            type: String,
            default: null
        },
        /**
         * See `claimSchema`. Declared EXACTLY this way on purpose — a single-nested subdocument with
         * `select: false` on the PATH and `default: undefined`. Measured on Mongoose 9.9.4: the key
         * is absent until the claim writes it, absent from every ordinary read (including the
         * document `findOneAndUpdate` returns), and `.select('+claim')` returns BOTH fields.
         * The tempting alternative — a plain nested object with `select: false` on the inner
         * `password_hash` — leaks `claim.name` into ordinary reads and makes `.select('+claim')`
         * return the name WITHOUT the hash, so the roll-forward would read a claim with no password.
         */
        claim: {
            type: claimSchema,
            select: false,
            default: undefined
        }
    },
    {
        timestamps: true
    }
);

// The redemption lookup. Unique, so two tokens can never share a hash.
authTokenSchema.index({ token_hash: 1 }, { unique: true, name: 'uniq_auth_token_hash' });

// The per-address throttles and the live-token counts: `{ purpose, email, createdAt }` serves
// "how many for this address since T", and its `purpose` prefix serves the global live count.
authTokenSchema.index({ purpose: 1, email: 1, createdAt: 1 }, { name: 'idx_auth_token_purpose_email' });

// CLEANUP ONLY — never the expiry check. Rows are kept a week past `expires_at` so a used or expired
// token can still be explained (and a crashed setup rolled forward) before it disappears.
authTokenSchema.index({ expires_at: 1 }, { expireAfterSeconds: 7 * 24 * 3600, name: 'ttl_auth_token_expires' });

const AuthToken = model(_modelName, authTokenSchema, _collectionName);

export = { AuthToken };
