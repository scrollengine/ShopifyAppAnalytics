'use strict';

/**
 * Sign-in device tokens: proof that THIS browser has signed in to THIS account before.
 *
 * PURE: the key, the clock and the device id are arguments. The id's randomness and the key's
 * derivation from config live in `services/loginDevice.service`.
 *
 * Why they exist: with `TRUST_PROXY` unset every caller shares one login budget, and the limiter's
 * 30-second trickle admits whoever asks first, so an anonymous caller polling the endpoint can take
 * every admission and keep the whole team out (reproduced: 0 of 40 correct owner attempts got
 * through in 12 trickle intervals). A device token is the one signal an attacker cannot poll for:
 * the login limiter meters a request carrying a valid one on its own budget instead of the shared
 * one. (OWASP's "device cookie" defence against lockout DoS.)
 *
 * Format: `ld1.<device_id>.<expires_ms>.<mac>`, where
 * mac = base64url(HMAC-SHA256(key, "ld1.<device_id>.<expires_ms>.<normalised email>")).
 *
 * The email is bound into the MAC and NOT carried in the token, so a token proves nothing for any
 * other account (a member's own token cannot buy them a budget against the owner), and a token read
 * out of localStorage names nobody.
 */

import crypto = require('crypto');

const VERSION = 'ld1';

/** The exact shape: version, 22-char id (16 random bytes), expiry in epoch ms, 43-char MAC. */
const LOGIN_DEVICE_TOKEN_REGEX = /^ld1\.([A-Za-z0-9_-]{22})\.([0-9]{1,15})\.([A-Za-z0-9_-]{43})$/;

/** Longest value worth running the regex over. Anything longer is refused unread. */
const MAX_TOKEN_LENGTH = 100;

/**
 * The MAC over one token's fields.
 *
 * @param key - The derived key.
 * @param deviceId - The token's id.
 * @param expiresMs - Its expiry, as the decimal string the token carries.
 * @param email - The normalised email it is bound to.
 * @returns base64url MAC.
 */
const _mac = (key: Buffer, deviceId: string, expiresMs: string, email: string): string => {
    return crypto.createHmac('sha256', key).update(`${VERSION}.${deviceId}.${expiresMs}.${email}`, 'utf8').digest('base64url');
};

/**
 * Builds a device token.
 *
 * @param params0 - The parameters object.
 * @param params0.key - The derived key.
 * @param params0.device_id - 16 random bytes, base64url (22 characters).
 * @param params0.email - The NORMALISED email the sign-in used.
 * @param params0.expires_ms - Expiry, epoch milliseconds.
 * @returns The token.
 */
const signLoginDeviceToken = ({ key, device_id, email, expires_ms }: {
    key: Buffer;
    device_id: string;
    email: string;
    expires_ms: number;
}): string => {
    const expires = String(Math.floor(expires_ms));
    return `${VERSION}.${device_id}.${expires}.${_mac(key, device_id, expires, email)}`;
};

/**
 * Checks a presented device token against the email the same request submitted.
 *
 * @param params0 - The parameters object.
 * @param params0.key - The derived key.
 * @param params0.token - The request value (anything).
 * @param params0.email - The NORMALISED email the request submitted.
 * @param params0.now_ms - Now, epoch milliseconds.
 * @returns The device id when the token is well formed, unexpired and MACed for this email; else null.
 */
const verifyLoginDeviceToken = ({ key, token, email, now_ms }: {
    key: Buffer;
    token: unknown;
    email: string;
    now_ms: number;
}): string | null => {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !email) {
        return null;
    }
    const match = LOGIN_DEVICE_TOKEN_REGEX.exec(token);
    if (!match) {
        return null;
    }
    const [, deviceId, expires, presented] = match;
    if (!(Number(expires) > now_ms)) {
        return null;
    }
    const expected = Buffer.from(_mac(key, deviceId, expires, email), 'utf8');
    const given = Buffer.from(presented, 'utf8');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
        return null;
    }
    return deviceId;
};

export = {
    signLoginDeviceToken,
    verifyLoginDeviceToken,
    LOGIN_DEVICE_TOKEN_REGEX
};
