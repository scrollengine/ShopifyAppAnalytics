'use strict';

/**
 * ============================================================================
 *  loginRateLimit — the enforcement behind AUTH_LOGIN_RATE_LIMIT_MAX, and the
 *  limiter factory every anonymous auth flow is built from
 * ============================================================================
 *
 *  `POST /api/auth/login` is the one anonymous endpoint that takes a password.
 *  Left unthrottled it is a password oracle that answers as fast as bcrypt can
 *  be run. `config.AUTH.LOGIN_RATE_LIMIT_MAX` and `…_WINDOW_MINUTES` describe
 *  that throttle; this file is the enforcement they name.
 *
 *  `createRateLimiter` below is the one implementation. `loginRateLimit` (keyed
 *  on the address, charging rejected credentials only) is built from it here;
 *  the token-flow, forgot-password and setup-request limiters are built from it
 *  in `authFlowRateLimit.ts`. One implementation, so the anti-lockout properties
 *  below cannot hold for one limiter and quietly not for another.
 *
 *  ── ⚠️ THE THING THIS DESIGN IS MOST AFRAID OF IS NOT BRUTE FORCE ───────────
 *  It is locking legitimate people out — above all the owner, who is the only
 *  one who can let anyone else back in. Six properties keep that from being
 *  possible, and each is a constraint on any future edit rather than an
 *  incidental result of one:
 *
 *   1. IT IS A WINDOW, NOT A LOCKOUT. The tally is discarded once the window has
 *      passed since the first charge in it. Waiting always works. There is no
 *      escalation and no second tier.
 *   2. REFUSALS ARE NOT CHARGED. A blocked request never reaches the handler, so
 *      it adds nothing. The window therefore expires at a time fixed when it
 *      opened, and hammering the endpoint cannot extend it.
 *   3. NOTHING IS PERSISTED. No counter in Mongo, no `locked_until` on an
 *      account, nothing on disk. State lives in one in-process Map, so
 *      restarting the backend clears every block instantly — the escape hatch
 *      that is always available to whoever owns the box.
 *   4. IT IS NEVER KEYED ON THE ACCOUNT. Login is keyed on the address, so an
 *      account is never disabled by guessing at it and another network is a
 *      fresh budget; no attacker can lock someone out of their own credential by
 *      attacking it. (The device budget below is keyed on a device the account
 *      holder signed in from, which only they hold.)
 *   5. SUCCESS IS NEVER CHARGED, AND WIPES NOTHING. A 2xx is refunded like any
 *      other uncharged outcome. It used to clear the address's tally and the
 *      deployment-wide one too; with more than one account that let ANY member
 *      reset the count between guesses at the owner's password (reproduced: 10
 *      guesses, 0 refusals, at max 3), and lift a deployment-wide block raised
 *      by a distributed attack. A near-miss now ages out with its window.
 *   6. IT FAILS OPEN. Any throw inside the limiter admits the request and logs.
 *      `authenticate` is the authentication boundary; this is availability
 *      protection, and a bug in a throttle must never become a denial of the
 *      way in.
 *
 *  A max of 0 disables a limiter outright (`AUTH_LOGIN_RATE_LIMIT_MAX=0` for
 *  this one), which is the seventh lever and the documented one.
 *
 *  ── Why the count is optimistic ─────────────────────────────────────────────
 *  The charge is applied when the request ENTERS and refunded if the outcome
 *  turns out not to be chargeable. Counting on the way out instead reads more
 *  naturally and is wrong: nothing has been counted while a request is in
 *  flight, so N concurrent attempts all pass the check together and a caller
 *  gets a whole burst free. bcrypt at cost 12 makes each of those attempts
 *  expensive for us and cheap for them, which is the wrong way round.
 *
 *  ── Why hanging up is not a refund ──────────────────────────────────────────
 *  A caller that sends its whole request and then closes the socket has
 *  already started the work: the handler runs to the end (bcrypt, an audit row)
 *  whether or not anyone is left to read the answer. Refunding on the hang-up
 *  handed an anonymous caller unmetered cost-12 bcrypt on the one event loop
 *  (reproduced: 20 aborted attempts, 20 compares, the next attempt still 401).
 *  So a request whose body fully arrived is settled by the answer the handler
 *  produces, hang-up or not. Only a request that never finished arriving (the
 *  handler cannot have run) is refunded on the hang-up.
 *
 *  ── A known device has a budget of its own (login) ──────────────────────────
 *  The trickle below keeps a spent budget from being a wall, but it admits
 *  whoever asks first, and a caller who polls the endpoint asks first every
 *  time. A successful sign-in therefore hands the browser a device token
 *  (`modules/auth` loginDevice), MACed for the email it signed in with. A later
 *  attempt for that email carrying that token is metered on the device's OWN
 *  budget and never waits on the shared one, so the owner and every member keep
 *  signing in from their usual browser however hard someone else floods. Once a
 *  device spends its own budget it is an ordinary caller again until its window
 *  rolls. A browser with no device token (first sign-in, cleared storage)
 *  still depends on the shared budget and its trickle.
 *
 *  ── Why not express-rate-limit ──────────────────────────────────────────────
 *  Its gate is on ATTEMPTS; the config here promises a budget of FAILURES, and
 *  `skipSuccessfulRequests` does not bridge the gap — it refunds after the fact,
 *  while a caller already at the limit is refused before the handler runs, so a
 *  correct password would still be turned away. Properties 2 and 6 above, the
 *  hang-up rule and the device budget are likewise not options it exposes.
 * ============================================================================
 */

import express = require('express');
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import config = require('../config');
import logger = require('../core/logger');
import apiResponse = require('../utils/apiResponse');
import authModule = require('../modules/auth');

const { customConsoleWarn, customConsoleError, customConsoleDebug } = logger;

/**
 * Where `src/apps/app.ts` mounts the login limiter, and the ONLY place that path is written.
 *
 * ⚠️ It has to agree with `src/routes/index.ts`, which mounts the auth router at `/api/auth` and
 * the login handler at `/login` inside it. Those are two different files, so the agreement is
 * asserted in `test/securityRateLimit.test.js` — a request to this exact path must reach the real
 * login route. Move the route and that test fails rather than the throttle silently ceasing to
 * apply, which is the failure this constant exists to make loud.
 *
 * Express matches a `use` path as a case-insensitive prefix, exactly as the router below it
 * matches, so the mount cannot be sidestepped by casing or a trailing slash without the route
 * itself being missed the same way.
 */
const LOGIN_RATE_LIMIT_PATH = '/api/auth/login';

/** The status the login controller answers a rejected credential with — login's only chargeable outcome. */
const UNAUTHORIZED = 401;

/**
 * The one thing a refused sign-in caller is told.
 *
 * Says nothing about accounts, and cannot: the tally counts rejected credentials from an ADDRESS,
 * whatever email they carried, so the same refusal arrives whether or not any particular account
 * was the one being guessed. It does not undo the login path's enumeration resistance.
 */
const RATE_LIMITED_MESSAGE = 'Too many failed sign-in attempts from this address. Try again shortly.';

/** Fallback window when a configured window is zero or negative — see `windowMsFromMinutes`. */
const DEFAULT_WINDOW_MINUTES = 15;

/**
 * Ceiling on tracked keys, and what happens at it.
 *
 * Above this a limiter stops tracking NEW keys rather than growing a Map without bound — an
 * unauthenticated endpoint must not let a caller decide how much memory this process uses. A request
 * whose key cannot be tracked is charged to the DEPLOYMENT-WIDE budget alone (spec A5): it is still
 * metered, just not per key. Expired entries are swept before the ceiling is consulted, so reaching
 * it means that many distinct keys are inside one live window, which is already an attack rather
 * than traffic.
 */
const MAX_TRACKED_KEYS = 10000;

/** Sweep expired entries once the Map is at least this big. Below it the walk costs more than it saves. */
const SWEEP_THRESHOLD = 64;

/**
 * The per-key budget multiplied out into a budget for the WHOLE deployment.
 *
 * The per-key tally assumes the key distinguishes callers. For the address-keyed limiters behind the
 * bundled docker-compose topology it does not, and the failure is not theoretical — it was measured
 * against `proxy-addr` directly:
 *
 *   - TRUST_PROXY unset (the shipped default): every caller resolves to the dashboard container's
 *     address, so the whole internet shares one budget.
 *   - TRUST_PROXY=uniquelocal (what the docs used to recommend): `req.ip` becomes whatever the
 *     caller put in `X-Forwarded-For`, so an attacker mints a fresh budget per request and the
 *     per-address tally never trips at all.
 *
 * The second is the one this counter exists for. It is keyed on nothing, so minting keys does not
 * evade it. The multiplier keeps it clear of honest use: one person mistyping a password meets the
 * per-address limit long before fifty failures accumulate deployment-wide.
 */
const GLOBAL_BUDGET_MULTIPLIER = 5;

/**
 * How often a refused window lets ONE request through anyway.
 *
 * The deployment-wide budget closes the bypass and immediately opens the other failure this file
 * most fears: with one shared budget, an attacker who spends it locks everyone out, and because a
 * fresh window can be re-spent the moment it opens, that lockout is effectively permanent.
 *
 * So a refusal is a rate, never a wall. Once a budget is spent, one request every thirty seconds is
 * still admitted, and an attacker is left with two guesses a minute against bcrypt, which is not a
 * brute force.
 *
 * ⚠️ What the trickle does NOT promise: it admits whoever asks first, so a caller polling the
 * endpoint takes every admission and a person trying now and then gets none (reproduced: 0 of 40
 * correct owner attempts in 12 intervals). Nothing anonymous can tell the owner's request from the
 * attacker's without running bcrypt, which is the thing being rationed. What keeps a returning user
 * in during a flood is the device budget (file header), not this.
 *
 * The first trickle is scheduled from the moment the window OPENS rather than being available
 * immediately, so a burst cannot spend the budget and walk straight through the first refusal.
 */
const TRICKLE_INTERVAL_MS = 30 * 1000;

/** The login body is an email, a password and a device token. Parsed ahead of the limiter at this size, never the 1 MB the API allows. */
const LOGIN_BODY_LIMIT = '8kb';

/** What is remembered about one key, for at most one window. */
interface FailureWindow {
    /** Chargeable outcomes counted so far, including any still in flight. */
    failures: number;
    /** When the window opened, in ms since the epoch. It expires at this plus the window length. */
    opened_at: number;
    /** Whether this window's first refusal has already been logged at WARN. Keeps a loop from flooding. */
    refusal_logged: boolean;
    /**
     * Earliest moment this window may let one request through despite being spent.
     *
     * Seeded to `opened_at + TRICKLE_INTERVAL_MS` when the window opens, so the trickle is never
     * available at the instant a budget is exhausted — otherwise a burst would spend the budget and
     * the very next request would walk through the first refusal.
     */
    next_trickle_at: number;
}

/** One tally a request was charged against, and how to tell whether that tally still holds the charge. */
interface Charge {
    window: FailureWindow;
    /** Whether the window is still the one its tally holds (not expired, swept or replaced). */
    isLive: () => boolean;
    /** Forgets the window once a refund empties it. */
    drop: () => void;
}

/** How any limiter is built. Every value is resolved by the caller, so this factory reads no config. */
interface RateLimiterOptions {
    /** The middleware's function name (visible in the route map and stack traces) and its log prefix. */
    name: string;
    /** Chargeable outcomes allowed per key per window. Zero or less returns a pass-through. */
    max: number;
    /** Window length in milliseconds. */
    window_ms: number;
    /** How often a spent budget admits one request anyway. Defaults to `TRICKLE_INTERVAL_MS`. */
    trickle_ms?: number;
    /**
     * The key a request is charged against. An empty string means "nothing to key on": the request is
     * admitted uncounted (property 6 — a request with no resolvable key is one whose connection has
     * usually already gone).
     */
    keyFn: (req: Request) => string;
    /**
     * Whether an ANSWERED response keeps its charge; everything else is refunded. `res` is passed so
     * a limiter can read a marker the handler left in `res.locals` when the status alone cannot say
     * (the token-flow limiter). A caller that hung up after its whole request arrived is judged by
     * the answer the handler still produces (see "Why hanging up is not a refund").
     */
    isChargeable: (statusCode: number, res: Response) => boolean;
    /**
     * A key for a request that carries proof it comes from a device the account holder signed in
     * from (login only). Non-empty: the request is metered on that key's OWN budget of `max` and never
     * checked against or charged to the shared ones — until that budget is spent, after which it is
     * treated like any other request. Empty: no such proof.
     */
    trustedKeyFn?: (req: Request) => string;
    /** The one sentence a refused caller is told. Must say nothing about accounts. */
    refusal_message: string;
    /**
     * Whether the key may be written to a log line. True for an address; FALSE for a key derived from
     * a secret (the token-flow limiter keys on a token hash, and no hash is ever logged — spec I11).
     */
    key_is_loggable: boolean;
}

/** How the login limiter is built. Both values are resolved by the caller, so the default instance is the only reader of config. */
interface LoginRateLimitOptions {
    /** Rejected credentials allowed in a window. Zero or less disables the limiter entirely. */
    max_failures: number;
    /** Window length in milliseconds. */
    window_ms: number;
    /**
     * How often a spent budget admits one attempt anyway. Defaults to `TRICKLE_INTERVAL_MS`.
     *
     * An argument for the same reason `window_ms` is one: the behaviour that matters here is what
     * happens AFTER the interval elapses, and a suite cannot wait thirty seconds to see it.
     */
    trickle_ms?: number;
}

/**
 * Resolves the address a request is charged against.
 *
 * `req.ip` is Express's answer, and what it means is decided entirely by `trust proxy` — set from
 * `config.APP.TRUST_PROXY` in `src/apps/app.ts`, and explained at length on `_trustProxy` in
 * `src/config/index.ts`. This function does not second-guess it: reading `X-Forwarded-For` here
 * directly would be exactly the over-trusting behaviour that setting exists to keep deliberate.
 *
 * @param req - The incoming request.
 * @returns The address to key on, or '' when there is none to key on at all.
 */
const resolveRequestAddress = (req: Request): string => {
    if (typeof req.ip === 'string' && req.ip) {
        return req.ip;
    }
    // A socket that has already gone away has no remote address. Nothing to key on, so nothing is
    // counted — see property 6 in the file header.
    if (req.socket && typeof req.socket.remoteAddress === 'string' && req.socket.remoteAddress) {
        return req.socket.remoteAddress;
    }
    return '';
};

/**
 * The login limiter's device key: the id a valid `body.device_token` proves for `body.email`, or ''.
 *
 * Reads the body, so the login path is parsed (at `LOGIN_BODY_LIMIT`) ahead of the limiter in
 * `src/apps/app.ts`. The check is a regex and one HMAC, never I/O. Called through the auth barrel
 * object at request time, like every other caller of it.
 *
 * @param req - The incoming request.
 * @returns `device:<id>`, or ''.
 */
const resolveLoginDeviceKey = (req: Request): string => {
    const body: unknown = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return '';
    }
    const deviceId = authModule.verifyLoginDeviceToken(Reflect.get(body, 'device_token'), Reflect.get(body, 'email'));
    return deviceId ? `device:${deviceId}` : '';
};

/**
 * A configured window in minutes, as milliseconds.
 *
 * A non-positive window is read as "unset" rather than as "never expires": a window that never rolls
 * is the permanent lockout this whole file exists not to have.
 *
 * @param minutes - The configured minutes.
 * @returns Milliseconds.
 */
const windowMsFromMinutes = (minutes: number): number => {
    const resolved = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_WINDOW_MINUTES;
    return resolved * 60 * 1000;
};

/**
 * Drops every window that has already expired.
 *
 * Called only when the Map has grown past `SWEEP_THRESHOLD`, so a quiet install never pays for it
 * and a busy one pays O(size) occasionally rather than keeping a timer alive. A timer would also
 * hold the event loop open and fight `registerGracefulShutdown`.
 *
 * @param windows - The live tally.
 * @param now - Current time in ms.
 * @param windowMs - Window length in ms.
 */
const _sweepExpired = (windows: Map<string, FailureWindow>, now: number, windowMs: number): void => {
    for (const [key, window] of windows) {
        if ((now - window.opened_at) >= windowMs) {
            windows.delete(key);
        }
    }
};

/**
 * Builds a rate limiter over its own private tally — THE implementation every limiter shares.
 *
 * A factory rather than a module-level middleware so that the limits are arguments: the tests drive
 * a real limiter through a sub-second window and watch it recover, which is the behaviour that
 * matters most and is not observable on a fifteen-minute one.
 *
 * @param options - See `RateLimiterOptions`.
 * @returns Express middleware named `options.name`.
 */
const createRateLimiter = (options: RateLimiterOptions): RequestHandler => {
    const { name, max, window_ms, trickle_ms, keyFn, isChargeable, trustedKeyFn, refusal_message, key_is_loggable } = options;

    if (max <= 0) {
        // Disabled, by configuration. Returned as a named pass-through rather than as a branch
        // inside the handler so that it is visible in a stack trace and in the route map.
        const disabled = (_req: Request, _res: Response, next: NextFunction): void => {
            return next();
        };
        Object.defineProperty(disabled, 'name', { value: `${name}Disabled` });
        return disabled;
    }

    /*
     * IN-PROCESS AND DELIBERATELY NOT SHARED. A Redis-backed store would survive restarts, which
     * sounds like an improvement and would remove property 3 in the file header: the guaranteed way
     * out of a block. It would also add a dependency, and a datastore whose outage would take the
     * sign-in with it.
     *
     * The consequence is that N backend processes hold N tallies, so the effective budget is
     * N × max. This build runs one process (one job runner, one cron); a future multi-process
     * deployment must revisit this rather than inherit it silently.
     */
    const windows = new Map<string, FailureWindow>();

    /** Per-device tallies (login's `trustedKeyFn`). Separate from `windows` so a device key never shares an address's budget. */
    const trustedWindows = new Map<string, FailureWindow>();

    /**
     * The deployment-wide tally, keyed on nothing.
     *
     * Minting keys evades `windows`; it cannot evade this. Held as a single mutable slot rather than
     * an entry in the Map so that no key can ever collide with it, and so the sweep — which walks
     * `windows` — cannot drop it by accident.
     */
    let globalWindow: FailureWindow | null = null;

    /** The deployment-wide ceiling. See GLOBAL_BUDGET_MULTIPLIER for why it is a multiple. */
    const global_max = max * GLOBAL_BUDGET_MULTIPLIER;

    /** Trickle interval for this limiter. Non-positive is read as "unset", never as "no wait". */
    const trickle_interval_ms = (typeof trickle_ms === 'number' && trickle_ms > 0) ? trickle_ms : TRICKLE_INTERVAL_MS;

    /**
     * Opens or rolls a window, so the per-key and global tallies cannot drift apart.
     *
     * @param window - The existing window, if any.
     * @param now - Current time in ms.
     * @returns A live window: the one passed in, or a fresh one.
     */
    const _liveWindow = (window: FailureWindow | null | undefined, now: number): FailureWindow => {
        if (window && (now - window.opened_at) < window_ms) {
            return window;
        }
        return { failures: 0, opened_at: now, refusal_logged: false, next_trickle_at: now + trickle_interval_ms };
    };

    /**
     * What a log line may say about the key.
     *
     * @param key - The key.
     * @returns The key itself when loggable, else a fixed placeholder.
     */
    const _loggedKey = (key: string): string => {
        return key_is_loggable ? key : '[not logged]';
    };

    /**
     * A Map-held window as a `Charge`: live while the Map still holds this exact object.
     *
     * @param map - The tally.
     * @param key - The key.
     * @param window - The window charged.
     * @returns The charge.
     */
    const _mapCharge = (map: Map<string, FailureWindow>, key: string, window: FailureWindow): Charge => {
        return {
            window: window,
            isLive: () => map.get(key) === window,
            drop: () => {
                if (map.get(key) === window) {
                    map.delete(key);
                }
            }
        };
    };

    /**
     * Applies the optimistic charge and arranges its settlement.
     *
     * Charged BEFORE the handler runs, so concurrent requests cannot slip through together, and
     * settled once the outcome is known:
     *   - answered: kept when `isChargeable`, refunded otherwise;
     *   - hung up before the request had fully arrived: refunded (the handler cannot have run);
     *   - hung up AFTER it had fully arrived: judged by the answer the handler still produces, caught
     *     by wrapping `res.end` once, because a destroyed socket emits no 'finish'.
     *
     * @param req - The request.
     * @param res - The response.
     * @param charges - Every tally this request is charged against.
     */
    const _chargeAndSettle = (req: Request, res: Response, charges: Charge[]): void => {
        for (const charge of charges) {
            charge.window.failures += 1;
        }

        let settled = false;
        const settle = (answered: boolean): void => {
            if (settled) {
                return;
            }
            settled = true;
            try {
                // Only settle against the windows that still hold the charge. One that has expired
                // or been swept already lost it, and refunding would take a bite out of somebody
                // else's budget.
                const live = charges.filter((charge) => charge.isLive());
                if (live.length === 0) {
                    return;
                }
                if (answered && isChargeable(res.statusCode, res)) {
                    return;
                }
                // Everything else is refunded. For login that is a success, a 400 for a missing
                // field, a 500 — none of them is a guess at a password, and charging a malformed
                // request would let a broken client spend a real user's budget.
                for (const charge of live) {
                    charge.window.failures -= 1;
                    if (charge.window.failures <= 0) {
                        charge.drop();
                    }
                }
            } catch (settleError) {
                // Nothing to answer with — the response is already over. Losing a charge is the safe
                // direction to fail in.
                customConsoleError(`ERROR: middleware ${name} settle`, settleError);
            }
        };

        res.once('close', () => {
            if (res.writableEnded) {
                settle(true);
                return;
            }
            if (req.complete !== true) {
                settle(false);
                return;
            }
            // The caller hung up after sending everything. The handler is still running and will do
            // its work anyway, so its answer decides the charge, not the hang-up.
            const originalEnd = res.end;
            const settleOnEnd = function (this: Response, ...args: unknown[]): Response {
                res.end = originalEnd;
                settle(true);
                return Reflect.apply(originalEnd, this, args);
            };
            res.end = settleOnEnd as Response['end'];
        });
    };

    /**
     * The device budget (login): admits and meters a request on its own tally when its device still
     * has budget left. Nothing is refused here — a spent device falls back to the shared path.
     *
     * @param req - The request.
     * @param res - The response.
     * @param deviceKey - From `trustedKeyFn`.
     * @param now - Current time in ms.
     * @returns True when the request was admitted on the device budget.
     */
    const _admitOnDeviceBudget = (req: Request, res: Response, deviceKey: string, now: number): boolean => {
        if (trustedWindows.size >= SWEEP_THRESHOLD) {
            _sweepExpired(trustedWindows, now, window_ms);
        }
        let device: FailureWindow | null = trustedWindows.get(deviceKey) || null;
        if (device && (now - device.opened_at) >= window_ms) {
            trustedWindows.delete(deviceKey);
            device = null;
        }
        if (!device) {
            if (trustedWindows.size >= MAX_TRACKED_KEYS) {
                // Every device token needs a correct password to mint, so this many live at once is
                // not a team. Untracked devices take the shared path rather than growing the Map.
                return false;
            }
            device = _liveWindow(null, now);
            trustedWindows.set(deviceKey, device);
        }
        if (device.failures >= max) {
            return false;
        }
        _chargeAndSettle(req, res, [_mapCharge(trustedWindows, deviceKey, device)]);
        return true;
    };

    /*
     * Has the tracking-ceiling warning already been written for the current period of saturation?
     *
     * Same rule as `window.refusal_logged`, for the same reason: an attacker past the ceiling must
     * not be able to choose how fast this deployment's log grows. Without this flag EVERY request
     * from a new key writes a WARN once the Map is full, and on a host using Docker's default
     * json-file driver — which has no rotation limit unless the operator sets one — that is a disk
     * filled by an attacker rather than a rate limit.
     *
     * Reset by the sweep, so a deployment that saturates, drains and saturates again says so again.
     */
    let ceilingLogged = false;

    const limiter = (req: Request, res: Response, next: NextFunction): void => {
        try {
            const now = Date.now();

            const deviceKey = trustedKeyFn ? trustedKeyFn(req) : '';
            if (deviceKey && _admitOnDeviceBudget(req, res, deviceKey, now)) {
                return next();
            }

            const key = keyFn(req);
            if (!key) {
                return next();
            }

            if (windows.size >= SWEEP_THRESHOLD) {
                _sweepExpired(windows, now, window_ms);
                if (windows.size < MAX_TRACKED_KEYS) {
                    // Drained. The next saturation is a new event and is allowed to say so once.
                    ceilingLogged = false;
                }
            }

            let window: FailureWindow | null = windows.get(key) || null;
            if (window && (now - window.opened_at) >= window_ms) {
                // Expired. Dropped rather than reset in place, so a stale object can never be the
                // one a still-in-flight request refunds against.
                windows.delete(key);
                window = null;
            }

            if (!window) {
                if (windows.size >= MAX_TRACKED_KEYS) {
                    /*
                     * ⚠️ NOT TRACKED PER KEY, BUT STILL METERED. Past the ceiling a new key gets no
                     * window of its own and is charged to the deployment-wide budget alone (spec
                     * A5). Refusing outright once the Map is full would turn a memory bound into a
                     * way to lock every new caller out; admitting unmetered would turn it into a
                     * way to switch the throttle off. The global budget — with its trickle — is the
                     * middle: bounded, and never a wall.
                     *
                     * Logged ONCE per period of saturation — see `ceilingLogged`.
                     */
                    if (!ceilingLogged) {
                        ceilingLogged = true;
                        customConsoleWarn(`WARN: ${name}: tracking ceiling reached — new keys are charged to the deployment-wide budget only until it drains`, {
                            tracked_keys: windows.size,
                            ceiling: MAX_TRACKED_KEYS
                        });
                    }
                } else {
                    window = _liveWindow(null, now);
                    windows.set(key, window);
                }
            }

            // The deployment-wide tally, rolled on the same clock as the per-key one.
            const liveGlobal = _liveWindow(globalWindow, now);
            globalWindow = liveGlobal;

            // Either budget can refuse. The per-key one is the ordinary throttle; the global one is
            // what still bites when the key is attacker-chosen and every request looks new.
            const keySpent = window !== null && window.failures >= max;
            const globalSpent = liveGlobal.failures >= global_max;

            if (keySpent || globalSpent) {
                // A refusal is a RATE, not a wall. Whichever budgets are spent must each have
                // reached their trickle time before one request is let through, and letting it
                // through re-arms them — so the shared budget never becomes a wall, and an attacker
                // gets two tries a minute rather than a free run.
                const spent: FailureWindow[] = [];
                if (keySpent && window) {
                    spent.push(window);
                }
                if (globalSpent) {
                    spent.push(liveGlobal);
                }
                const trickleReady = spent.every((entry) => now >= entry.next_trickle_at);

                if (trickleReady) {
                    for (const entry of spent) {
                        entry.next_trickle_at = now + trickle_interval_ms;
                    }
                    customConsoleWarn(`WARN: ${name}: admitting one request from a spent budget — the trickle keeps a refusal a rate, not a wall`, {
                        key: _loggedKey(key),
                        key_spent: keySpent,
                        global_spent: globalSpent,
                        next_trickle_in_seconds: Math.ceil(trickle_interval_ms / 1000)
                    });
                } else {
                    const blocking: FailureWindow = keySpent && window ? window : liveGlobal;
                    const blockingIsGlobal = blocking === liveGlobal;
                    const retryAfterSeconds = Math.max(1, Math.ceil(((blocking.opened_at + window_ms) - now) / 1000));

                    if (!blocking.refusal_logged) {
                        // Once per window. An attacker looping on a blocked key must not be able to
                        // choose how fast this deployment's log grows.
                        blocking.refusal_logged = true;
                        customConsoleWarn(`WARN: ${name}: refusing requests — budget spent`, {
                            key: _loggedKey(key),
                            failures: blocking.failures,
                            max: blockingIsGlobal ? global_max : max,
                            scope: blockingIsGlobal ? 'deployment' : 'key',
                            retry_after_seconds: retryAfterSeconds
                        });
                    } else {
                        customConsoleDebug(`DEBUG: ${name}: request refused`, { key: _loggedKey(key) });
                    }

                    res.setHeader('Retry-After', String(retryAfterSeconds));
                    apiResponse.tooManyRequestsResponse(res, refusal_message);
                    return;
                }
            }

            const charges: Charge[] = [];
            if (window) {
                charges.push(_mapCharge(windows, key, window));
            }
            charges.push({
                window: liveGlobal,
                isLive: () => globalWindow === liveGlobal,
                drop: () => {
                    if (globalWindow === liveGlobal) {
                        globalWindow = null;
                    }
                }
            });
            _chargeAndSettle(req, res, charges);

            return next();
        } catch (error) {
            // FAILS OPEN, on purpose. See property 6 in the file header: this middleware protects
            // availability, and a fault inside it must not become the reason nobody can get in.
            customConsoleError(`ERROR: middleware ${name} — admitting the request`, error);
            // ⚠️ Unless a refusal was already going out when it threw. Calling `next()` then would
            // send the request on to a handler that answers a response this middleware has already
            // begun, and "Cannot set headers after they are sent" is a 500 for a request that was
            // correctly refused. Failing open means admitting requests, not answering twice.
            if (res.headersSent) {
                return;
            }
            return next();
        }
    };

    Object.defineProperty(limiter, 'name', { value: name });
    return limiter;
};

/**
 * Builds a login rate limiter: keyed on the address, charging rejected credentials (401) only, with
 * a device budget for requests carrying a valid sign-in device token.
 *
 * @param params0 - The parameters object.
 * @param params0.max_failures - Rejected credentials allowed per window. Zero or less returns a pass-through.
 * @param params0.window_ms - Window length in milliseconds.
 * @param params0.trickle_ms - How often a spent budget admits one attempt anyway (tests only).
 * @returns Express middleware named `loginRateLimit`.
 */
const createLoginRateLimiter = ({ max_failures, window_ms, trickle_ms }: LoginRateLimitOptions): RequestHandler => {
    return createRateLimiter({
        name: 'loginRateLimit',
        max: max_failures,
        window_ms: window_ms,
        trickle_ms: trickle_ms,
        keyFn: resolveRequestAddress,
        // The one chargeable outcome: a credential was submitted and rejected.
        isChargeable: (statusCode: number): boolean => statusCode === UNAUTHORIZED,
        trustedKeyFn: resolveLoginDeviceKey,
        refusal_message: RATE_LIMITED_MESSAGE,
        key_is_loggable: true
    });
};

/**
 * The login path's own body parser, mounted AHEAD of the limiter (the device budget needs the email
 * and token). Capped at `LOGIN_BODY_LIMIT`, so a refused attempt gets at most that much JSON parsed on
 * its behalf. The general parser after it finds the request stream already consumed (body-parser 2
 * checks `on-finished`) and leaves `req.body` alone.
 */
const loginBodyParser = express.json({ limit: LOGIN_BODY_LIMIT });

/** The instance the application mounts, built from the two documented config keys. */
const loginRateLimit = createLoginRateLimiter({
    max_failures: config.AUTH.LOGIN_RATE_LIMIT_MAX,
    window_ms: windowMsFromMinutes(config.AUTH.LOGIN_RATE_LIMIT_WINDOW_MINUTES)
});

export = {
    /** The limiter the application mounts. Built from `config.AUTH.LOGIN_RATE_LIMIT_*`. */
    loginRateLimit,
    /** The login path's small body parser, mounted just before `loginRateLimit`. */
    loginBodyParser,
    /** Builds a login limiter with explicit limits. Used by the test suite to watch a window expire. */
    createLoginRateLimiter,
    /** THE limiter implementation: key function, chargeable outcomes and budgets as arguments. */
    createRateLimiter,
    /** `req.ip` (as `trust proxy` defines it), else the socket address, else ''. */
    resolveRequestAddress,
    /** Configured minutes → ms, with a non-positive value read as the 15-minute default. */
    windowMsFromMinutes,
    /** The path `src/apps/app.ts` mounts the login limiter on. Must address the real login route. */
    LOGIN_RATE_LIMIT_PATH,
    /** The largest login body the login path parses. */
    LOGIN_BODY_LIMIT,
    /** The single sentence a refused sign-in caller is told. Carries no account information. */
    RATE_LIMITED_MESSAGE
};
