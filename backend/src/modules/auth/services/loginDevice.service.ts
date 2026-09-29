'use strict';

/**
 * Issues and checks sign-in device tokens (see `helpers/loginDevice.helper` for what they are and
 * why the login limiter needs them). This file owns the two impure parts: the random device id and
 * the key derived from JWT_SECRET.
 *
 * A device token is NOT a credential. It grants no access and skips no password check; all it buys
 * is a sign-in budget of its own, separate from the one every anonymous caller shares.
 */

import crypto = require('crypto');
import config = require('../../../config');
import authConstants = require('../constants/auth.constants');
import tokenHelper = require('../helpers/token.helper');
import identityHelper = require('../helpers/identity.helper');
import loginDeviceHelper = require('../helpers/loginDevice.helper');

const { LOGIN_DEVICE_KEY_LABEL, LOGIN_DEVICE_TTL_MS } = authConstants;

/** 16 random bytes, base64url: 22 characters. */
const DEVICE_ID_BYTES = 16;

/**
 * The MAC key, or null when there is no secret to derive it from. Boot refuses to start without a
 * JWT_SECRET; this is the second lock, so an unconfigured process never hands out a forgeable token.
 *
 * @returns The key, or null.
 */
const _deviceKey = (): Buffer | null => {
    const secret = config.AUTH.JWT_SECRET;
    if (typeof secret !== 'string' || secret.length === 0) {
        return null;
    }
    return tokenHelper.deriveSigningKey(secret, LOGIN_DEVICE_KEY_LABEL);
};

/**
 * A fresh device token for a successful sign-in.
 *
 * @param params0 - The parameters object.
 * @param params0.email - The email the sign-in submitted (normalised here).
 * @param params0.now - The sign-in instant.
 * @returns The token, or null when none can be issued.
 */
const issueLoginDeviceToken = ({ email, now }: { email: unknown; now: Date }): string | null => {
    const key = _deviceKey();
    const normalised = identityHelper.normaliseEmail(email);
    if (!key || !normalised) {
        return null;
    }
    return loginDeviceHelper.signLoginDeviceToken({
        key: key,
        device_id: crypto.randomBytes(DEVICE_ID_BYTES).toString('base64url'),
        email: normalised,
        expires_ms: now.getTime() + LOGIN_DEVICE_TTL_MS
    });
};

/**
 * The device id a sign-in request proves, or null. Called by the login limiter BEFORE the password
 * check, so it does no I/O: one regex and one HMAC.
 *
 * @param token - `body.device_token` as sent.
 * @param email - `body.email` as sent (normalised here exactly as `session.service#login` does).
 * @returns The device id, or null.
 */
const verifyLoginDeviceToken = (token: unknown, email: unknown): string | null => {
    const key = _deviceKey();
    const normalised = identityHelper.normaliseEmail(email);
    if (!key || !normalised) {
        return null;
    }
    return loginDeviceHelper.verifyLoginDeviceToken({ key: key, token: token, email: normalised, now_ms: Date.now() });
};

export = {
    issueLoginDeviceToken,
    verifyLoginDeviceToken
};
