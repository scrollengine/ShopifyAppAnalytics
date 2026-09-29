'use strict';

/**
 * ============================================================================
 *  LINK TOKENS AND LINKS — where every emailed link is born
 * ============================================================================
 *
 *  Two chokepoints, each the ONLY place its thing is made:
 *
 *    - `issueToken()` — the ONLY caller of `crypto.randomBytes` for a link
 *      token (spec §10). 32 random bytes → 43 base64url characters; the caller
 *      stores only the sha256 (`token.helper#hashToken`). Setup, reset and
 *      invite tokens all come from here, as does the unguessable throwaway
 *      password `repair-owner` hashes.
 *    - `buildAppLink(path, token)` — the ONLY place a link string is formed
 *      (spec A10, invariant I2): `${config.APP.PUBLIC_URL}${path}#token=…`,
 *      never from anything in a request. The token rides in the FRAGMENT (I3),
 *      so it never reaches a server log or a Referer.
 *
 *  ⚠️ Nothing here logs a token or a link.
 *
 *  Internal to the auth services; not in the barrel. Plain functions, not
 *  envelope services, except `deadTokenFailure`, which builds the refusal a
 *  service resolves with.
 * ============================================================================
 */

import crypto = require('crypto');
import config = require('../../../config');
import validate = require('../../../config/validate');
import logger = require('../../../core/logger');
import authConstants = require('../constants/auth.constants');
import tokenHelper = require('../helpers/token.helper');
import serviceResultHelper = require('../helpers/serviceResult.helper');
import authTokenRepository = require('../repositories/authToken.repository');

import type { ServiceResult } from '../../../types/service.types';
import type { AuthTokenDoc, ObjectIdLike } from '../../shared/types/entity.types';
import type { TokenPurpose } from '../types/auth.types';

const { AUTH_MESSAGES, LINK_TOKEN_BYTES, APP_LINK_PATHS, LINK_TTL_MIN_MINUTES, LINK_TTL_MAX_MINUTES, TOKEN_PURPOSES } = authConstants;

const MINUTE_MS = 60 * 1000;
const ALLOWED_LINK_PATHS: readonly string[] = Object.freeze(Object.values(APP_LINK_PATHS));

/**
 * Mints a link token and its storage hash.
 *
 * @returns `{ token, token_hash }` — the token goes into ONE link and is then dropped; only the hash is stored.
 * @throws When the generated token does not have the documented shape (it always does; this is a tripwire).
 */
const issueToken = (): { token: string; token_hash: string } => {
    const token = crypto.randomBytes(LINK_TOKEN_BYTES).toString('base64url');
    if (!tokenHelper.isWellFormedToken(token)) {
        throw new Error('issueToken produced a token of the wrong shape');
    }
    return { token: token, token_hash: tokenHelper.hashToken(token) };
};

/**
 * Builds the link an email (or the recovery CLI) carries.
 *
 * Refuses — returns `null` and logs — when `APP_PUBLIC_URL` is unusable (boot validation refuses
 * that first, so this is a tripwire), when `path` is not one of `APP_LINK_PATHS`, or when `token`
 * is not a link token. A caller that gets `null` sends nothing.
 *
 * @param path - One of `APP_LINK_PATHS` (starts with `/`).
 * @param token - A token from `issueToken`.
 * @returns `${APP_PUBLIC_URL}${path}#token=${token}`, or `null`.
 */
const buildAppLink = (path: string, token: string): string | null => {
    const origin = config.APP.PUBLIC_URL;
    const originProblem = validate.checkPublicUrl(origin);
    if (originProblem) {
        logger.customConsoleError('ERROR: auth buildAppLink — APP_PUBLIC_URL is not usable; no link was built', { path: path });
        return null;
    }
    if (!ALLOWED_LINK_PATHS.includes(path)) {
        logger.customConsoleError('ERROR: auth buildAppLink — refusing a path that is not an app link page', { path: String(path).slice(0, 64) });
        return null;
    }
    if (!tokenHelper.isWellFormedToken(token)) {
        logger.customConsoleError('ERROR: auth buildAppLink — refusing a malformed token', { path: path });
        return null;
    }
    return `${origin}${path}#token=${token}`;
};

/**
 * Whether a link can be built at all (`APP_PUBLIC_URL` usable). Checked BEFORE a flow consumes a
 * throttle slot or revokes an earlier link, so an unbuildable link costs nothing.
 *
 * @returns True when `APP_PUBLIC_URL` passes the boot checker.
 */
const canBuildLinks = (): boolean => {
    return validate.checkPublicUrl(config.APP.PUBLIC_URL) === null;
};

/**
 * Whether links point at a loopback host (they will only open on the server's own machine). Shown
 * beside invite results so an admin is not surprised when nobody can open theirs.
 *
 * @returns True when `APP_PUBLIC_URL` is localhost / 127.0.0.0/8 / ::1.
 */
const isLinkHostLoopback = (): boolean => {
    const origin = config.APP.PUBLIC_URL;
    if (!origin) {
        return false;
    }
    return validate.isLoopbackPublicUrl(origin);
};

/**
 * A configured link lifetime clamped into `[min, max]` minutes. Pure; `linkExpiry` logs the clamp.
 *
 * @param params0 - The parameters object.
 * @param params0.minutes - The configured lifetime.
 * @param params0.min_minutes - Floor (default `LINK_TTL_MIN_MINUTES`).
 * @param params0.max_minutes - Ceiling (default `LINK_TTL_MAX_MINUTES`).
 * @returns The minutes to use.
 */
const clampLinkMinutes = ({ minutes, min_minutes, max_minutes }: { minutes: number; min_minutes?: number; max_minutes?: number }): number => {
    const floor = typeof min_minutes === 'number' ? min_minutes : LINK_TTL_MIN_MINUTES;
    const ceiling = typeof max_minutes === 'number' ? max_minutes : LINK_TTL_MAX_MINUTES;
    if (!Number.isFinite(minutes) || minutes < floor) {
        return floor;
    }
    if (minutes > ceiling) {
        return ceiling;
    }
    return minutes;
};

/**
 * A link's expiry: `now + minutes`, with `minutes` clamped into `[min, max]` (a 0 or negative
 * setting would mint links dead on arrival; an absurd one would overflow the Date). A clamp is
 * logged naming the setting, so the typo stays visible.
 *
 * @param params0 - The parameters object.
 * @param params0.now - The issue instant.
 * @param params0.minutes - The configured lifetime in minutes.
 * @param params0.setting - The environment variable's name, for the log.
 * @param params0.min_minutes - Floor (default `LINK_TTL_MIN_MINUTES`).
 * @param params0.max_minutes - Ceiling (default `LINK_TTL_MAX_MINUTES`).
 * @returns The expiry instant and the minutes actually used.
 */
const linkExpiry = ({ now, minutes, setting, min_minutes, max_minutes }: {
    now: Date;
    minutes: number;
    setting: string;
    min_minutes?: number;
    max_minutes?: number;
}): { expires_at: Date; minutes: number } => {
    const used = clampLinkMinutes({ minutes: minutes, min_minutes: min_minutes, max_minutes: max_minutes });
    if (used !== minutes) {
        logger.customConsoleWarn('WARN: auth: a link lifetime setting is out of range — clamped', {
            setting: setting,
            configured: minutes,
            using_minutes: used
        });
    }
    return { expires_at: new Date(now.getTime() + used * MINUTE_MS), minutes: used };
};

/**
 * Issues a SETUP_VERIFY or PASSWORD_RESET token and stores its hash (the raw token is returned to
 * go into exactly one link, and is never stored or logged).
 *
 * @param fields - The row: purpose, the address (FROM THE DATABASE ROW for resets), the user (null
 *     for setup), the requester-supplied name (setup only), the expiry and the requesting address.
 * @param fields.purpose - One of `TOKEN_PURPOSES`.
 * @param fields.email - The address the link is mailed to.
 * @param fields.user_id - The user a reset is for; `null` for setup.
 * @param fields.name - Setup only: the name the requester typed (never put in the email).
 * @param fields.expires_at - From `linkExpiry`.
 * @param fields.request_ip - From `requestContext.helper`.
 * @returns `{ token, row }` — the row has no hash.
 */
const insertLinkToken = async (fields: {
    purpose: TokenPurpose;
    email: string;
    user_id: ObjectIdLike | null;
    name: string | null;
    expires_at: Date;
    request_ip: string | null;
}): Promise<{ token: string; row: AuthTokenDoc }> => {
    const issued = issueToken();
    const row = await authTokenRepository.insertToken({
        purpose: fields.purpose,
        token_hash: issued.token_hash,
        email: fields.email,
        user_id: fields.user_id,
        name: fields.name,
        expires_at: fields.expires_at,
        request_ip: fields.request_ip
    });
    return { token: issued.token, row: row };
};

/**
 * Issues a PASSWORD_RESET link for a user: stores the new token (addressed to the email ON THE USER
 * ROW) and builds the link. Shared by forgot-password, the admin-triggered reset and the CLI
 * `reset-link` / `repair-owner`, so a reset link has one recipe.
 *
 * ⚠️ It does NOT revoke the user's earlier links. That waits until the new link has actually been
 * delivered (`settleResetLinkDelivery`, or `retireEarlierResetLinks` for the CLI, which delivers by
 * printing). Revoking first let anyone kill a user's working link with a forgot-password request
 * while the mail caps were spent: the old link died, the new one was never sent.
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user.
 * @param params0.email - Their address, from the database row.
 * @param params0.minutes - Lifetime (clamped by `linkExpiry`).
 * @param params0.setting - The setting's name, for a clamp warning.
 * @param params0.request_ip - The requesting address, or `null`.
 * @param params0.now - Issue instant.
 * @returns `{ link, expires_at, token_id }`, or `null` when no link can be built (nothing stored).
 */
const issueResetLink = async ({ user_id, email, minutes, setting, request_ip, now }: {
    user_id: string;
    email: string;
    minutes: number;
    setting: string;
    request_ip: string | null;
    now: Date;
}): Promise<{ link: string; expires_at: Date; token_id: string } | null> => {
    if (!canBuildLinks()) {
        logger.customConsoleError('ERROR: auth issueResetLink — APP_PUBLIC_URL is not usable; no reset link issued', { user_id: user_id });
        return null;
    }
    const expiry = linkExpiry({ now: now, minutes: minutes, setting: setting });
    const issued = await insertLinkToken({
        purpose: TOKEN_PURPOSES.PASSWORD_RESET,
        email: email,
        user_id: user_id,
        name: null,
        expires_at: expiry.expires_at,
        request_ip: request_ip
    });
    const link = buildAppLink(APP_LINK_PATHS.RESET_PASSWORD, issued.token);
    if (!link) {
        return null;
    }
    return { link: link, expires_at: expiry.expires_at, token_id: String(issued.row._id) };
};

/**
 * Revokes a user's live reset links other than `token_id` — once `token_id` has reached its owner.
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user.
 * @param params0.token_id - The link just delivered; left alone.
 * @param params0.now - The instant.
 * @returns How many earlier links were revoked.
 */
const retireEarlierResetLinks = async ({ user_id, token_id, now }: { user_id: string; token_id: string; now: Date }): Promise<number> => {
    return authTokenRepository.revokeLiveTokens({ purpose: TOKEN_PURPOSES.PASSWORD_RESET, now: now, user_id: user_id, except_token_id: token_id });
};

/**
 * Settles a mailed reset link once the send has an outcome.
 *
 *   - Handed to the mail server (SENT), or possibly so (UNCONFIRMED — it may still arrive): the new
 *     link replaces the earlier ones, which are revoked.
 *   - Never reached the server (CAP_REACHED, NOT_CONFIGURED) or refused (FAILED): the earlier links
 *     stay live, and the undelivered new one is revoked. That revocation is housekeeping —
 *     completing any reset revokes every other live reset link anyway.
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user.
 * @param params0.token_id - The new link's token.
 * @param params0.delivered - `outcome.accepted || outcome.unconfirmed` from the send.
 * @param params0.now - The instant.
 * @returns How many earlier links were revoked (0 when not delivered).
 */
const settleResetLinkDelivery = async ({ user_id, token_id, delivered, now }: {
    user_id: string;
    token_id: string;
    delivered: boolean;
    now: Date;
}): Promise<number> => {
    if (delivered) {
        return retireEarlierResetLinks({ user_id: user_id, token_id: token_id, now: now });
    }
    await authTokenRepository.revokeLiveTokens({ purpose: TOKEN_PURPOSES.PASSWORD_RESET, now: now, user_id: user_id, token_id: token_id });
    return 0;
};

/**
 * The refusal for an email-link token whose LIVE lookup (or spend) failed: one any-state lookup by
 * the same hash decides TOKEN_USED / TOKEN_EXPIRED / TOKEN_INVALID (spec A14). A revoked token says
 * TOKEN_INVALID ("request a new one") — the same thing a token that never existed says.
 *
 * @param params0 - The parameters object.
 * @param params0.purpose - The purpose the live lookup used.
 * @param params0.token_hash - sha256 hex of the presented token.
 * @param params0.now - The live lookup's instant.
 * @returns The failure envelope (400-class code).
 */
const deadTokenFailure = async ({ purpose, token_hash, now }: { purpose: TokenPurpose; token_hash: string; now: Date }): Promise<ServiceResult> => {
    const row = await authTokenRepository.findAnyByTokenHash({ purpose: purpose, token_hash: token_hash });
    const code = tokenHelper.deadLinkCode({ row: row, now: now, revoked_code: 'TOKEN_INVALID' });
    return serviceResultHelper.authFailure(code, AUTH_MESSAGES[code]);
};

export = {
    issueToken,
    buildAppLink,
    canBuildLinks,
    isLinkHostLoopback,
    clampLinkMinutes,
    linkExpiry,
    insertLinkToken,
    issueResetLink,
    retireEarlierResetLinks,
    settleResetLinkDelivery,
    deadTokenFailure
};
