'use strict';

/**
 * Email-link token shape checks and hashing.
 *
 * PURE: hashing is a computation, not I/O. Token GENERATION (`crypto.randomBytes`) is deliberately
 * not here — it lives in `services/authToken.service`, so this file stays deterministic and testable.
 *
 * Tokens are stored only as sha256 hex. A 256-bit random token needs no salt or slow hash: there is
 * no dictionary to attack, and the hash only has to stop a database reader from using a live link.
 */

import crypto = require('crypto');
import authConstants = require('../constants/auth.constants');

const { TOKEN_REGEX } = authConstants;

/** sha256 hex is exactly 64 lowercase hex characters. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Hashes a link token for storage and lookup.
 *
 * @param token - The raw token. Callers check `isWellFormedToken` first.
 * @returns sha256 of the token, lowercase hex.
 */
const hashToken = (token: string): string => {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
};

/**
 * Whether a request value has the exact shape of a link token (spec I1): a string of 43 base64url
 * characters. Checked BEFORE any query, so a malformed value never reaches the database.
 *
 * @param token - Raw request value.
 * @returns True only for a well-formed token string.
 */
const isWellFormedToken = (token: unknown): token is string => {
    return typeof token === 'string' && TOKEN_REGEX.test(token);
};

/**
 * Whether a value has the shape of a stored token hash (64 lowercase hex characters). The
 * repositories check this before any `token_hash` query, so nothing but a hash reaches that filter.
 *
 * @param value - Anything.
 * @returns True only for a sha256 hex string.
 */
const isTokenHash = (value: unknown): value is string => {
    return typeof value === 'string' && SHA256_HEX.test(value);
};

/**
 * Compares a stored token hash with the one computed from the request, in constant time.
 *
 * The repositories run this AFTER the query matched (spec I8 belt and braces): `strictQuery` strips
 * an undeclared filter path to `{}`, so a query alone could hand back an unrelated row.
 *
 * @param stored - The `token_hash` read from the document.
 * @param expected - The hash of the presented token.
 * @returns True only when both are well-formed sha256 hex and equal.
 */
const tokenHashesEqual = (stored: unknown, expected: unknown): boolean => {
    if (!isTokenHash(stored) || !isTokenHash(expected)) {
        return false;
    }
    return crypto.timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(expected, 'hex'));
};

/**
 * The repositories' post-query step for every token lookup (spec A3): keep the document only if its
 * `token_hash` equals the presented hash, then DELETE the hash from it, so a service never holds
 * one. Mutates the (lean) document it is given.
 *
 * @param doc - A document read with `+token_hash`, or `null`.
 * @param expected - The hash of the presented token.
 * @returns The same document without `token_hash`, or `null` when absent or not a match.
 */
const verifyAndStripTokenHash = <T extends { token_hash?: string }>(doc: T | null, expected: string): T | null => {
    if (!doc || !tokenHashesEqual(doc.token_hash, expected)) {
        return null;
    }
    delete doc.token_hash;
    return doc;
};

/**
 * The specific refusal for a link whose LIVE lookup failed (spec A14), from the row the any-state
 * lookup found by the same hash. Only the holder of the 256-bit token can ask, so naming the state
 * leaks nothing.
 *
 * Spent and withdrawn are checked BEFORE expiry: an accepted invite whose expiry has since passed
 * should say "already used" (sign in), not "expired" (ask for a new one) — the second sends the
 * person to request something they no longer need.
 *
 * @param params0 - The parameters object.
 * @param params0.row - The row found by hash in any state, or `null` when nothing matched.
 * @param params0.now - The instant the live lookup used.
 * @param params0.revoked_code - What a withdrawn row answers: `INVITE_REVOKED` for invites, `TOKEN_INVALID` for email-link tokens.
 * @returns `TOKEN_USED`, the revoked code, `TOKEN_EXPIRED` or `TOKEN_INVALID`.
 */
const deadLinkCode = ({ row, now, revoked_code }: {
    row: { used_at?: Date | null; accepted_at?: Date | null; revoked_at?: Date | null; expires_at?: Date | null } | null;
    now: Date;
    revoked_code: 'INVITE_REVOKED' | 'TOKEN_INVALID';
}): 'TOKEN_USED' | 'INVITE_REVOKED' | 'TOKEN_EXPIRED' | 'TOKEN_INVALID' => {
    if (!row) {
        return 'TOKEN_INVALID';
    }
    if (row.used_at || row.accepted_at) {
        return 'TOKEN_USED';
    }
    if (row.revoked_at) {
        return revoked_code;
    }
    const expiresAt = row.expires_at instanceof Date ? row.expires_at.getTime() : NaN;
    if (!(expiresAt > now.getTime())) {
        return 'TOKEN_EXPIRED';
    }
    // Live by every field and still not found live: a race with a spend. Say nothing specific.
    return 'TOKEN_INVALID';
};

/**
 * A key derived from a configured secret for ONE purpose: HMAC-SHA256(secret, label).
 *
 * Every signing purpose gets its own label, so a value signed for one purpose can never verify as
 * another, and nothing this build signs verifies under the raw secret (see
 * `SESSION_SIGNING_KEY_LABEL` for why that matters on a rollback).
 *
 * @param secret - The configured secret (`JWT_SECRET`).
 * @param label - The purpose label.
 * @returns The 32-byte key.
 */
const deriveSigningKey = (secret: string, label: string): Buffer => {
    return crypto.createHmac('sha256', secret).update(label, 'utf8').digest();
};

export = {
    hashToken,
    deriveSigningKey,
    isWellFormedToken,
    isTokenHash,
    tokenHashesEqual,
    verifyAndStripTokenHash,
    deadLinkCode
};
