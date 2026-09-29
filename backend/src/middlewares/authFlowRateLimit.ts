'use strict';

/**
 * ============================================================================
 *  authFlowRateLimit — the three limiters on the anonymous auth flows (spec A5)
 * ============================================================================
 *
 *  Built from `loginRateLimit.ts#createRateLimiter`, so every anti-lockout
 *  property stated there holds here too: a window not a lockout, refusals not
 *  charged, nothing persisted, a deployment-wide budget of 5 × max with a 30 s
 *  trickle, and FAIL OPEN.
 *
 *    tokenFlowRateLimit       POST /setup/inspect, /setup/complete,
 *                             /invites/inspect, /invites/accept,
 *                             /password/reset
 *        Keyed on sha256(body.token) when the token is well formed, else on the
 *        constant '(malformed)'. Charges ONLY a 400 the controller marked with
 *        `res.locals.rate_limit_charge = true` (TOKEN_INVALID / TOKEN_EXPIRED /
 *        INVITE_REVOKED): the status alone cannot tell a dead link from a
 *        password-policy 400, and a user retrying passwords against a VALID link
 *        must never spend its budget.
 *        Only the holder of a token can spend that token's budget, so neither a
 *        shared proxy address nor a forged X-Forwarded-For moves this key.
 *
 *    passwordForgotRateLimit  POST /password/forgot
 *    setupRequestRateLimit    POST /setup
 *        Keyed on the address (`req.ip`, as `trust proxy` defines it). Charge
 *        every answered response EXCEPT a 400 — a shape-rejected request is
 *        refunded, so a broken client cannot spend the budget. The 202 is
 *        charged: these endpoints send email, and the answer is identical
 *        whether or not anything is sent, so success is not a signal of
 *        legitimacy.
 *
 *  Each instance has its OWN tally, isolated from the others and from login:
 *  spending the forgot budget never refuses an invite acceptance. All three take
 *  `AUTH_PUBLIC_FLOW_RATE_LIMIT_MAX` (default 10) and
 *  `AUTH_PUBLIC_FLOW_RATE_LIMIT_WINDOW_MINUTES` (default 15).
 *
 *  Mounted ROUTE-level in `routes/auth.routes.ts` — after `express.json`, so the
 *  token-flow key can read the body. `app.ts`'s mounts do not change.
 * ============================================================================
 */

import type { Request, Response, RequestHandler } from 'express';
import config = require('../config');
import authModule = require('../modules/auth');
import loginRateLimitModule = require('./loginRateLimit');

/**
 * The key every request without a well-formed token shares. No legitimate page sends a malformed
 * token (the link always carries 43 characters), so this bucket only ever holds junk.
 */
const MALFORMED_TOKEN_KEY = '(malformed)';

/**
 * The `res.locals` field the auth controller sets on a dead-link 400. A CONTRACT with
 * `controllers/auth.controller.ts`, which imports this constant rather than re-spelling it.
 */
const RATE_LIMIT_CHARGE_LOCAL = 'rate_limit_charge';

/** The one status the token flow may charge, and the one status the address flows refund. */
const BAD_REQUEST = 400;

/** What a refused caller is told. None of these names an account, an address or a token. */
const TOKEN_FLOW_REFUSAL_MESSAGE = 'Too many attempts with this link. Wait a few minutes, then try again or ask for a new link.';
const PASSWORD_FORGOT_REFUSAL_MESSAGE = 'Too many password-reset requests from this address. Try again shortly.';
const SETUP_REQUEST_REFUSAL_MESSAGE = 'Too many setup requests from this address. Try again shortly.';

/** Budgets for a limiter built here. Resolved by the caller; the default instances are the only readers of config. */
interface FlowLimiterOptions {
    /** Chargeable outcomes allowed per key per window. Zero or less disables the limiter. */
    max: number;
    /** Window length in milliseconds. */
    window_ms: number;
    /** How often a spent budget admits one request anyway (tests only). */
    trickle_ms?: number;
}

/**
 * The token-flow key: sha256 of `body.token` when it has the exact link-token shape, else the
 * malformed-bucket constant. Never the raw token — a key sits in memory next to log calls.
 *
 * Reads only the parsed BODY: never a header, never the address. That is what makes the key
 * immune to X-Forwarded-For and to every caller sharing one proxy address.
 *
 * @param req - The request (after `express.json`).
 * @returns The key.
 */
const tokenFlowKey = (req: Request): string => {
    const body: unknown = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return MALFORMED_TOKEN_KEY;
    }
    const token: unknown = Reflect.get(body, 'token');
    if (!authModule.isWellFormedToken(token)) {
        return MALFORMED_TOKEN_KEY;
    }
    return authModule.hashToken(token);
};

/**
 * Whether a token-flow response keeps its charge: a 400 the controller marked as a dead link.
 *
 * @param statusCode - The response status.
 * @param res - The response (its `locals` carry the controller's marker).
 * @returns True only for a marked 400.
 */
const _isChargedTokenFailure = (statusCode: number, res: Response): boolean => {
    return statusCode === BAD_REQUEST && Boolean(res.locals) && res.locals[RATE_LIMIT_CHARGE_LOCAL] === true;
};

/**
 * Whether an address-flow response keeps its charge: anything answered except a shape rejection.
 *
 * @param statusCode - The response status.
 * @returns False only for 400.
 */
const _isChargedAddressRequest = (statusCode: number): boolean => {
    return statusCode !== BAD_REQUEST;
};

/**
 * Builds a token-flow limiter over its own tally.
 *
 * @param options - Budgets.
 * @returns Express middleware named `tokenFlowRateLimit`.
 */
const createTokenFlowRateLimiter = ({ max, window_ms, trickle_ms }: FlowLimiterOptions): RequestHandler => {
    return loginRateLimitModule.createRateLimiter({
        name: 'tokenFlowRateLimit',
        max: max,
        window_ms: window_ms,
        trickle_ms: trickle_ms,
        keyFn: tokenFlowKey,
        isChargeable: _isChargedTokenFailure,
        refusal_message: TOKEN_FLOW_REFUSAL_MESSAGE,
        // The key is a token hash. No hash is ever logged (spec I11).
        key_is_loggable: false
    });
};

/**
 * Builds a forgot-password limiter over its own tally.
 *
 * @param options - Budgets.
 * @returns Express middleware named `passwordForgotRateLimit`.
 */
const createPasswordForgotRateLimiter = ({ max, window_ms, trickle_ms }: FlowLimiterOptions): RequestHandler => {
    return loginRateLimitModule.createRateLimiter({
        name: 'passwordForgotRateLimit',
        max: max,
        window_ms: window_ms,
        trickle_ms: trickle_ms,
        keyFn: loginRateLimitModule.resolveRequestAddress,
        isChargeable: _isChargedAddressRequest,
        refusal_message: PASSWORD_FORGOT_REFUSAL_MESSAGE,
        key_is_loggable: true
    });
};

/**
 * Builds a setup-request limiter over its own tally.
 *
 * @param options - Budgets.
 * @returns Express middleware named `setupRequestRateLimit`.
 */
const createSetupRequestRateLimiter = ({ max, window_ms, trickle_ms }: FlowLimiterOptions): RequestHandler => {
    return loginRateLimitModule.createRateLimiter({
        name: 'setupRequestRateLimit',
        max: max,
        window_ms: window_ms,
        trickle_ms: trickle_ms,
        keyFn: loginRateLimitModule.resolveRequestAddress,
        isChargeable: _isChargedAddressRequest,
        refusal_message: SETUP_REQUEST_REFUSAL_MESSAGE,
        key_is_loggable: true
    });
};

/** The budgets every default instance is built from. */
const PUBLIC_FLOW_BUDGET: FlowLimiterOptions = {
    max: config.AUTH.PUBLIC_FLOW_RATE_LIMIT_MAX,
    window_ms: loginRateLimitModule.windowMsFromMinutes(config.AUTH.PUBLIC_FLOW_RATE_LIMIT_WINDOW_MINUTES)
};

/** The instances `routes/auth.routes.ts` mounts. Three tallies, isolated from each other and from login. */
const tokenFlowRateLimit = createTokenFlowRateLimiter(PUBLIC_FLOW_BUDGET);
const passwordForgotRateLimit = createPasswordForgotRateLimiter(PUBLIC_FLOW_BUDGET);
const setupRequestRateLimit = createSetupRequestRateLimiter(PUBLIC_FLOW_BUDGET);

export = {
    /** Dead-link attempts per token (setup inspect/complete, invite inspect/accept, password reset). */
    tokenFlowRateLimit,
    /** POST /api/auth/password/forgot, per address. */
    passwordForgotRateLimit,
    /** POST /api/auth/setup, per address. */
    setupRequestRateLimit,
    /** Builds a token-flow limiter with explicit budgets (tests). */
    createTokenFlowRateLimiter,
    /** Builds a forgot-password limiter with explicit budgets (tests). */
    createPasswordForgotRateLimiter,
    /** Builds a setup-request limiter with explicit budgets (tests). */
    createSetupRequestRateLimiter,
    /** The token-flow key function (sha256 of a well-formed body.token, else MALFORMED_TOKEN_KEY). */
    tokenFlowKey,
    /** The shared key for requests without a well-formed token. */
    MALFORMED_TOKEN_KEY,
    /** The `res.locals` field a controller sets to charge a dead-link 400. */
    RATE_LIMIT_CHARGE_LOCAL
};
