'use strict';

/**
 * Every read and write on `gi_auth_tokens` — the single-use email-link tokens (SETUP_VERIFY,
 * PASSWORD_RESET).
 *
 * ── Token hashes never leave this file ──────────────────────────────────────────────────────────
 * `token_hash` is `select: false`. The two lookups ask for `+token_hash`, compare it in code
 * (`token.helper#verifyAndStripTokenHash`, spec I8/A3) and DELETE it before returning; `insertToken`
 * strips the one it just wrote. A service never holds a hash.
 *
 * ── Expiry is checked in every live filter ──────────────────────────────────────────────────────
 * `expires_at > now` is part of every "live" query and every spend. The TTL index
 * (`ttl_auth_token_expires`) is cleanup a week later, not the expiry check.
 *
 * ── The setup claim ─────────────────────────────────────────────────────────────────────────────
 * `claim` is `select: false`; it is written by the spend CAS (`claimSetupToken`), read ONLY by
 * `findByIdWithClaim` (the boot roll-forward and the CLI repair) and `$unset` once the owner row
 * exists.
 *
 * Reads no clock: `now` is an argument everywhere.
 */

import models = require('../../shared/repositories/models.repository');
import authVocab = require('../../../constants/authVocab.constants');
import identityHelper = require('../helpers/identity.helper');
import tokenHelper = require('../helpers/token.helper');

import type { AuthTokenDoc, ObjectIdLike } from '../../shared/types/entity.types';
import type { NewAuthTokenFields } from '../types/auth.types';

const { AuthTokenModel } = models;
const { TOKEN_PURPOSES } = authVocab;

const PURPOSE_VALUES: readonly string[] = Object.freeze(Object.values(TOKEN_PURPOSES));

/**
 * Whether a value is one of `TOKEN_PURPOSES`. Every query names its purpose, so a token of one
 * purpose is never accepted for another; an unknown purpose matches nothing.
 *
 * @param purpose - Anything.
 * @returns True for a known purpose string.
 */
const _isPurpose = (purpose: unknown): purpose is string => {
    return typeof purpose === 'string' && PURPOSE_VALUES.includes(purpose);
};

/**
 * Belt and braces (spec I8): the row that came back is the row that was asked for.
 *
 * @param doc - The document the query returned.
 * @param token_id - The id that was asked for.
 * @returns The document, or `null` when absent or a different row.
 */
const _sameToken = (doc: AuthTokenDoc | null, token_id: ObjectIdLike): AuthTokenDoc | null => {
    if (!doc || String(doc._id) !== String(token_id)) {
        return null;
    }
    return doc;
};

/**
 * Inserts a token row. The raw token never reaches this file — only its sha256.
 *
 * @param fields - The new token.
 * @returns The inserted row, WITHOUT `token_hash`.
 */
const insertToken = async (fields: NewAuthTokenFields): Promise<AuthTokenDoc> => {
    const created = await AuthTokenModel.create({
        purpose: fields.purpose,
        token_hash: fields.token_hash,
        email: identityHelper.normaliseEmail(fields.email),
        user_id: fields.user_id,
        name: fields.name,
        expires_at: fields.expires_at,
        used_at: null,
        revoked_at: null,
        request_ip: fields.request_ip
    });
    const plain: AuthTokenDoc = created.toObject();
    delete plain.token_hash;
    delete plain.claim;
    return plain;
};

/**
 * Finds the LIVE token of a purpose that a presented link token hashes to (spec A3).
 *
 * @param params0 - The parameters object.
 * @param params0.purpose - One of `TOKEN_PURPOSES`.
 * @param params0.token_hash - sha256 hex of the presented token.
 * @param params0.now - Only tokens with `expires_at > now` match.
 * @returns The row WITHOUT `token_hash`, or `null` when no live token of that purpose matches.
 */
const findLiveByTokenHash = async ({ purpose, token_hash, now }: { purpose: string; token_hash: string; now: Date }): Promise<AuthTokenDoc | null> => {
    if (!_isPurpose(purpose) || !tokenHelper.isTokenHash(token_hash)) {
        return null;
    }
    const doc = await AuthTokenModel.findOne({
        purpose: purpose,
        token_hash: token_hash,
        used_at: null,
        revoked_at: null,
        expires_at: { $gt: now }
    })
        .select('+token_hash')
        .lean<AuthTokenDoc | null>();
    const verified = tokenHelper.verifyAndStripTokenHash(doc, token_hash);
    return verified && verified.purpose === purpose ? verified : null;
};

/**
 * Finds the token of a purpose a presented link hashes to IN ANY STATE — only after the live lookup
 * failed, to say which specific error applies (expired / used — spec A14).
 *
 * @param params0 - The parameters object.
 * @param params0.purpose - One of `TOKEN_PURPOSES`.
 * @param params0.token_hash - sha256 hex of the presented token.
 * @returns The row WITHOUT `token_hash`, or `null`.
 */
const findAnyByTokenHash = async ({ purpose, token_hash }: { purpose: string; token_hash: string }): Promise<AuthTokenDoc | null> => {
    if (!_isPurpose(purpose) || !tokenHelper.isTokenHash(token_hash)) {
        return null;
    }
    const doc = await AuthTokenModel.findOne({ purpose: purpose, token_hash: token_hash })
        .select('+token_hash')
        .lean<AuthTokenDoc | null>();
    const verified = tokenHelper.verifyAndStripTokenHash(doc, token_hash);
    return verified && verified.purpose === purpose ? verified : null;
};

/**
 * Reads a token row WITH its setup `claim` (spec A3: `findById(id).select('+claim').lean()`). Two
 * callers: the boot roll-forward (`reconcileSetup`) and the CLI `repair-owner`. The claim holds a
 * password hash — the result must never reach a response or a log line.
 *
 * @param id - The token's `_id` (the install document's `setup_token_id`).
 * @returns The row including `claim` when one was written, or `null`.
 */
const findByIdWithClaim = async (id: ObjectIdLike): Promise<AuthTokenDoc | null> => {
    if (!identityHelper.isObjectIdLike(id)) {
        return null;
    }
    const doc = await AuthTokenModel.findById(id).select('+claim').lean<AuthTokenDoc | null>();
    return _sameToken(doc, id);
};

/**
 *  THE SETUP CLAIM (spec §7.1 step 4). Spends a SETUP_VERIFY token AND records the owner's name and
 * password hash on it, in one CAS. Written BEFORE the install lock is taken, so a crash between the
 * lock and the owner insert can be rolled forward from this row.
 *
 * @param params0 - The parameters object.
 * @param params0.token_id - The live token the lookup found.
 * @param params0.name - The owner's validated display name.
 * @param params0.password_hash - bcrypt hash of the NFC-normalised password. Never plaintext.
 * @param params0.now - Recorded as `used_at`; also the liveness instant.
 * @returns The spent row (claim NOT included — it is `select: false`), or `null` when the token was
 *     no longer live (used, revoked or expired in between).
 */
const claimSetupToken = async ({ token_id, name, password_hash, now }: {
    token_id: ObjectIdLike;
    name: string;
    password_hash: string;
    now: Date;
}): Promise<AuthTokenDoc | null> => {
    if (!identityHelper.isObjectIdLike(token_id) || typeof name !== 'string' || typeof password_hash !== 'string' || !password_hash) {
        return null;
    }
    const doc = await AuthTokenModel.findOneAndUpdate(
        {
            _id: token_id,
            purpose: TOKEN_PURPOSES.SETUP_VERIFY,
            used_at: null,
            revoked_at: null,
            expires_at: { $gt: now }
        },
        { $set: { used_at: now, claim: { name: name, password_hash: password_hash } } },
        { returnDocument: 'after' }
    ).lean<AuthTokenDoc | null>();
    return _sameToken(doc, token_id);
};

/**
 * Spends a token (CAS on `used_at: null`, not revoked, not expired). The single-use gate for
 * PASSWORD_RESET; two concurrent redemptions produce one winner.
 *
 * @param params0 - The parameters object.
 * @param params0.token_id - The live token the lookup found.
 * @param params0.purpose - Re-asserted in the filter.
 * @param params0.now - Recorded as `used_at`; also the liveness instant.
 * @returns The spent row, or `null` when it was no longer live.
 */
const spendToken = async ({ token_id, purpose, now }: { token_id: ObjectIdLike; purpose: string; now: Date }): Promise<AuthTokenDoc | null> => {
    if (!identityHelper.isObjectIdLike(token_id) || !_isPurpose(purpose)) {
        return null;
    }
    const doc = await AuthTokenModel.findOneAndUpdate(
        {
            _id: token_id,
            purpose: purpose,
            used_at: null,
            revoked_at: null,
            expires_at: { $gt: now }
        },
        { $set: { used_at: now } },
        { returnDocument: 'after' }
    ).lean<AuthTokenDoc | null>();
    return _sameToken(doc, token_id);
};

/**
 * Removes the setup claim once the owner row exists (it holds a password hash that no longer has a
 * reason to be here). Idempotent.
 *
 * @param params0 - The parameters object.
 * @param params0.token_id - The token that carried the claim.
 * @returns True when a claim was removed by this call.
 */
const unsetClaim = async ({ token_id }: { token_id: ObjectIdLike }): Promise<boolean> => {
    if (!identityHelper.isObjectIdLike(token_id)) {
        return false;
    }
    const result = await AuthTokenModel.updateOne(
        { _id: token_id, claim: { $exists: true } },
        { $unset: { claim: 1 } }
    );
    return (result.modifiedCount || 0) === 1;
};

/**
 * Revokes the LIVE tokens of a purpose, optionally narrowed to one address, one user or one token,
 * or excluding one token.
 *
 * ⚠️ With neither `email` nor `user_id` nor `token_id` this revokes EVERY live token of the purpose
 * — what setup completion wants for SETUP_VERIFY. A narrowing field that is present but malformed
 * revokes nothing, never everything, and so does asking for one token while excluding another.
 *
 * @param params0 - The parameters object.
 * @param params0.purpose - One of `TOKEN_PURPOSES`.
 * @param params0.now - Recorded as `revoked_at`; also the liveness instant.
 * @param params0.email - Only tokens mailed to this address (normalised here).
 * @param params0.user_id - Only tokens for this user.
 * @param params0.token_id - Only this token.
 * @param params0.except_token_id - A token to leave alone.
 * @returns How many tokens were revoked.
 */
const revokeLiveTokens = async ({ purpose, now, email, user_id, token_id, except_token_id }: {
    purpose: string;
    now: Date;
    email?: string;
    user_id?: ObjectIdLike;
    token_id?: ObjectIdLike;
    except_token_id?: ObjectIdLike;
}): Promise<number> => {
    if (!_isPurpose(purpose)) {
        return 0;
    }
    if (token_id !== undefined && except_token_id !== undefined) {
        return 0;
    }
    const filter: Record<string, unknown> = {
        purpose: purpose,
        used_at: null,
        revoked_at: null,
        expires_at: { $gt: now }
    };
    if (email !== undefined) {
        const normalised = identityHelper.normaliseEmail(email);
        if (!normalised) {
            return 0;
        }
        filter.email = normalised;
    }
    if (user_id !== undefined) {
        if (!identityHelper.isObjectIdLike(user_id)) {
            return 0;
        }
        filter.user_id = user_id;
    }
    if (token_id !== undefined) {
        if (!identityHelper.isObjectIdLike(token_id)) {
            return 0;
        }
        filter._id = token_id;
    }
    if (except_token_id !== undefined) {
        if (!identityHelper.isObjectIdLike(except_token_id)) {
            return 0;
        }
        filter._id = { $ne: except_token_id };
    }
    const result = await AuthTokenModel.updateMany(filter, { $set: { revoked_at: now } });
    return result.modifiedCount || 0;
};

/**
 * Counts LIVE tokens of a purpose across all addresses — the global SETUP_VERIFY capacity
 * (≥ `SETUP_MAX_LIVE_TOKENS` ⇒ 429 SETUP_CAPACITY; this count is email-independent, so it may run
 * on the response path — spec A6).
 *
 * @param params0 - The parameters object.
 * @param params0.purpose - One of `TOKEN_PURPOSES`.
 * @param params0.now - Live means `expires_at > now`.
 * @returns The count.
 */
const countLive = async ({ purpose, now }: { purpose: string; now: Date }): Promise<number> => {
    if (!_isPurpose(purpose)) {
        return 0;
    }
    return AuthTokenModel.countDocuments({
        purpose: purpose,
        used_at: null,
        revoked_at: null,
        expires_at: { $gt: now }
    }).exec();
};

/**
 * Counts LIVE tokens of a purpose for one address (≤ `SETUP_MAX_LIVE_PER_EMAIL`).
 *
 * @param params0 - The parameters object.
 * @param params0.purpose - One of `TOKEN_PURPOSES`.
 * @param params0.email - The address; normalised here.
 * @param params0.now - Live means `expires_at > now`.
 * @returns The count (0 for an unusable address).
 */
const countLiveForEmail = async ({ purpose, email, now }: { purpose: string; email: string; now: Date }): Promise<number> => {
    const normalised = identityHelper.normaliseEmail(email);
    if (!_isPurpose(purpose) || !normalised) {
        return 0;
    }
    return AuthTokenModel.countDocuments({
        purpose: purpose,
        email: normalised,
        used_at: null,
        revoked_at: null,
        expires_at: { $gt: now }
    }).exec();
};

/**
 * Counts tokens of a purpose issued to one address since an instant, in ANY state — the per-address
 * hourly request cap. Served by `idx_auth_token_purpose_email`.
 *
 * @param params0 - The parameters object.
 * @param params0.purpose - One of `TOKEN_PURPOSES`.
 * @param params0.email - The address; normalised here.
 * @param params0.since - Window start (inclusive).
 * @returns The count (0 for an unusable address).
 */
const countForEmailSince = async ({ purpose, email, since }: { purpose: string; email: string; since: Date }): Promise<number> => {
    const normalised = identityHelper.normaliseEmail(email);
    if (!_isPurpose(purpose) || !normalised) {
        return 0;
    }
    return AuthTokenModel.countDocuments({
        purpose: purpose,
        email: normalised,
        createdAt: { $gte: since }
    }).exec();
};

/**
 * The newest token of a purpose issued to one address, in any state — the per-address minimum
 * interval between requests. Served by `idx_auth_token_purpose_email`.
 *
 * @param params0 - The parameters object.
 * @param params0.purpose - One of `TOKEN_PURPOSES`.
 * @param params0.email - The address; normalised here.
 * @returns The row (no hash), or `null`.
 */
const findLatestForEmail = async ({ purpose, email }: { purpose: string; email: string }): Promise<AuthTokenDoc | null> => {
    const normalised = identityHelper.normaliseEmail(email);
    if (!_isPurpose(purpose) || !normalised) {
        return null;
    }
    const doc = await AuthTokenModel.findOne({ purpose: purpose, email: normalised })
        .sort({ createdAt: -1, _id: -1 })
        .lean<AuthTokenDoc | null>();
    return doc && doc.email === normalised && doc.purpose === purpose ? doc : null;
};

export = {
    insertToken,
    findLiveByTokenHash,
    findAnyByTokenHash,
    findByIdWithClaim,
    claimSetupToken,
    spendToken,
    unsetClaim,
    revokeLiveTokens,
    countLive,
    countLiveForEmail,
    countForEmailSince,
    findLatestForEmail
};
