'use strict';

/**
 * ============================================================================
 *  loginRateLimit — the enforcement behind AUTH_LOGIN_RATE_LIMIT_MAX
 * ============================================================================
 *
 *  `POST /api/auth/login` is one of exactly two endpoints an anonymous caller
 *  can reach, it is the only credential on the whole deployment, and there is no
 *  second factor and no sign-up flow. Left unthrottled it is a password oracle
 *  that answers as fast as bcrypt can be run.
 *
 *  `config.AUTH.LOGIN_RATE_LIMIT_MAX` and `…_WINDOW_MINUTES` have described that
 *  throttle since the first commit and were read by nothing. This file is the
 *  enforcement they name; it honours both keys and invents no third one.
 *
 *  ── ⚠️ THE THING THIS DESIGN IS MOST AFRAID OF IS NOT BRUTE FORCE ───────────
 *  It is bricking the operator. One account, no password reset, no second user,
 *  no support desk: a lockout here is not an inconvenience, it is the end of
 *  that install. Six properties keep that from being possible, and each is a
 *  constraint on any future edit rather than an incidental result of one:
 *
 *   1. IT IS A WINDOW, NOT A LOCKOUT. The tally is discarded once
 *      `AUTH_LOGIN_RATE_LIMIT_WINDOW_MINUTES` has passed since the first charge
 *      in it. Waiting always works. There is no escalation and no second tier.
 *   2. REFUSALS ARE NOT CHARGED. A blocked request never reaches the handler, so
 *      it produces no 401 and adds nothing. The window therefore expires at a
 *      time fixed when it opened, and hammering the endpoint cannot extend it.
 *   3. NOTHING IS PERSISTED. No counter in Mongo, no `locked_until` on the
 *      account, nothing on disk. State lives in one in-process Map, so
 *      restarting the backend clears every block instantly — the escape hatch
 *      that is always available to whoever owns the box.
 *   4. IT IS KEYED ON THE ADDRESS, NEVER ON THE ACCOUNT. The account itself is
 *      never disabled, so another network is a fresh budget and no attacker can
 *      lock the operator out of their own credential by attacking it.
 *   5. SUCCESS CLEARS, AND IS NEVER CHARGED. A correct password wipes the
 *      address's tally, so normal use never accumulates toward the limit.
 *   6. IT FAILS OPEN. Any throw inside this middleware admits the request and
 *      logs. `verifyAdmin` is the authentication boundary; this is availability
 *      protection, and a bug in a throttle must never become a denial of the
 *      only way in.
 *
 *  `AUTH_LOGIN_RATE_LIMIT_MAX=0` disables the limiter outright, which is the
 *  seventh lever and the documented one.
 *
 *  ── Why the count is optimistic ─────────────────────────────────────────────
 *  The charge is applied when the request ENTERS and refunded if it turns out
 *  not to have been a rejected credential. Counting on the way out instead reads
 *  more naturally and is wrong: nothing has been counted while a request is in
 *  flight, so N concurrent attempts all pass the check together and a caller
 *  gets a whole burst free. bcrypt at cost 12 makes each of those attempts
 *  expensive for us and cheap for them, which is the wrong way round.
 *
 *  ── Why not express-rate-limit ──────────────────────────────────────────────
 *  Its gate is on ATTEMPTS; the config here promises a budget of FAILURES, and
 *  `skipSuccessfulRequests` does not bridge the gap — it refunds after the fact,
 *  while a caller already at the limit is refused before the handler runs, so a
 *  correct password would still be turned away. Properties 2, 5 and 6 above are
 *  likewise not options it exposes. This is roughly ninety lines with no store
 *  abstraction, and it stays a dependency-free file in a repository about to be
 *  published.
 * ============================================================================
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import config = require('../config');
import logger = require('../core/logger');

const { customConsoleWarn, customConsoleError, customConsoleDebug } = logger;

/**
 * Where `src/apps/app.ts` mounts this, and the ONLY place that path is written.
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

/** HTTP 429. The response class that says "later", as distinct from 401's "no". */
const TOO_MANY_REQUESTS = 429;

/** The status the login controller answers a rejected credential with — the only chargeable outcome. */
const UNAUTHORIZED = 401;

/**
 * The one thing a refused caller is told.
 *
 * Says nothing about accounts, and cannot: the tally counts rejected credentials from an ADDRESS,
 * whatever email they carried, so the same refusal arrives whether or not the operator's account
 * was the one being guessed. It does not undo the login path's enumeration resistance.
 */
const RATE_LIMITED_MESSAGE = 'Too many failed sign-in attempts from this address. Try again shortly.';

/** Fallback window when `AUTH_LOGIN_RATE_LIMIT_WINDOW_MINUTES` is zero or negative — see the config note. */
const DEFAULT_WINDOW_MINUTES = 15;

/**
 * Ceiling on tracked addresses, and what happens at it.
 *
 * Above this the limiter stops tracking NEW addresses and admits them, rather than growing a Map
 * without bound — an unauthenticated endpoint must not let a caller decide how much memory this
 * process uses. Expired entries are swept before the ceiling is consulted, so reaching it means
 * that many distinct addresses are inside one live window, which on a single-operator dashboard is
 * already an attack rather than traffic.
 */
const MAX_TRACKED_ADDRESSES = 10000;

/** Sweep expired entries once the Map is at least this big. Below it the walk costs more than it saves. */
const SWEEP_THRESHOLD = 64;

/**
 * The per-address budget multiplied out into a budget for the WHOLE deployment.
 *
 * The per-address tally assumes the address distinguishes callers. Behind the bundled
 * docker-compose topology it does not, and the failure is not theoretical — it was measured against
 * `proxy-addr` directly:
 *
 *   - TRUST_PROXY unset (the shipped default): every caller resolves to the dashboard container's
 *     address, so the whole internet shares one budget.
 *   - TRUST_PROXY=uniquelocal (what the docs used to recommend): `req.ip` becomes whatever the
 *     caller put in `X-Forwarded-For`, so an attacker mints a fresh budget per request and the
 *     per-address tally never trips at all.
 *
 * The second is the one this counter exists for. It is keyed on nothing, so minting addresses does
 * not evade it. The multiplier keeps it clear of honest use: a single operator mistyping a password
 * meets the per-address limit long before fifty failures accumulate deployment-wide.
 */
const GLOBAL_BUDGET_MULTIPLIER = 5;

/**
 * How often a refused window lets ONE attempt through anyway.
 *
 * The counter above closes the bypass and immediately opens the other failure this file most fears:
 * with one shared budget, an attacker who spends it locks the operator out, and because a fresh
 * window can be re-spent the moment it opens, that lockout is effectively permanent. There is one
 * account, no reset, and no second user.
 *
 * So a refusal is a rate, never a wall. Once a budget is spent, one attempt every thirty seconds is
 * still admitted, and a correct password on any of them clears the tally outright. The operator
 * waits at most half a minute; an attacker is left with two guesses a minute against bcrypt, which
 * is not a brute force.
 *
 * The first trickle is scheduled from the moment the window OPENS rather than being available
 * immediately, so a burst cannot spend the budget and walk straight through the first refusal.
 */
const TRICKLE_INTERVAL_MS = 30 * 1000;

/** What is remembered about one source address, for at most one window. */
interface FailureWindow {
    /** Rejected credentials charged so far, including any still in flight. */
    failures: number;
    /** When the window opened, in ms since the epoch. It expires at this plus the window length. */
    opened_at: number;
    /** Whether this window's first refusal has already been logged at WARN. Keeps a loop from flooding. */
    refusal_logged: boolean;
    /**
     * Earliest moment this window may let one attempt through despite being spent.
     *
     * Seeded to `opened_at + TRICKLE_INTERVAL_MS` when the window opens, so the trickle is never
     * available at the instant a budget is exhausted — otherwise a burst would spend the budget and
     * the very next request would walk through the first refusal.
     */
    next_trickle_at: number;
}

/** How a limiter is built. Both values are resolved by the caller, so the default instance is the only reader of config. */
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
const _resolveAddress = (req: Request): string => {
    if (typeof req.ip === 'string' && req.ip) {
        return req.ip;
    }
    // A socket that has already gone away has no remote address. Nothing to key on, so nothing is
    // counted — see the fail-open note in the file header.
    if (req.socket && typeof req.socket.remoteAddress === 'string' && req.socket.remoteAddress) {
        return req.socket.remoteAddress;
    }
    return '';
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
    for (const [address, window] of windows) {
        if ((now - window.opened_at) >= windowMs) {
            windows.delete(address);
        }
    }
};

/**
 * Builds a login rate limiter over its own private tally.
 *
 * A factory rather than a single module-level middleware so that the limits are arguments: the
 * tests drive a real limiter through a sub-second window and watch it recover, which is the
 * behaviour that matters most here and is not observable on a fifteen-minute one. The instance the
 * application uses is built from config immediately below.
 *
 * @param params0 - The parameters object.
 * @param params0.max_failures - Rejected credentials allowed per window. Zero or less returns a pass-through.
 * @param params0.window_ms - Window length in milliseconds.
 * @returns Express middleware.
 */
const createLoginRateLimiter = ({ max_failures, window_ms, trickle_ms }: LoginRateLimitOptions): RequestHandler => {
    /*
     * IN-PROCESS AND DELIBERATELY NOT SHARED. A Redis-backed store would survive restarts, which
     * sounds like an improvement and would remove property 3 in the file header: the operator's
     * guaranteed way out of a block they caused themselves. It would also add a dependency, and a
     * datastore whose outage would take the login with it.
     *
     * The consequence is that N backend processes hold N tallies, so the effective budget is
     * N × max_failures. This build runs one process (one job runner, one cron); a future
     * multi-process deployment must revisit this rather than inherit it silently.
     */
    const windows = new Map<string, FailureWindow>();

    /**
     * The deployment-wide tally, keyed on nothing.
     *
     * Minting addresses evades `windows`; it cannot evade this. Held as a single mutable slot
     * rather than an entry in the Map so that no address can ever collide with it, and so the
     * sweep — which walks `windows` — cannot drop it by accident.
     */
    let globalWindow: FailureWindow | null = null;

    /** The deployment-wide ceiling. See GLOBAL_BUDGET_MULTIPLIER for why it is a multiple. */
    const global_max_failures = max_failures * GLOBAL_BUDGET_MULTIPLIER;

    /** Trickle interval for this limiter. Non-positive is read as "unset", never as "no wait". */
    const trickle_interval_ms = (typeof trickle_ms === 'number' && trickle_ms > 0) ? trickle_ms : TRICKLE_INTERVAL_MS;

    /**
     * Opens or rolls a window, so the per-address and global tallies cannot drift apart.
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

    /*
     * Has the tracking-ceiling warning already been written for the current period of saturation?
     *
     * Same rule as `window.refusal_logged`, for the same reason: an attacker past the ceiling must
     * not be able to choose how fast this deployment's log grows. Without this flag EVERY request
     * from a new address writes a WARN once the Map is full, and on a host using Docker's default
     * json-file driver — which has no rotation limit unless the operator sets one — that is a disk
     * filled by an attacker rather than a rate limit.
     *
     * Reset by the sweep, so a deployment that saturates, drains and saturates again says so again.
     */
    let ceilingLogged = false;

    if (max_failures <= 0) {
        // Disabled, by configuration. Returned as a named pass-through rather than as a branch
        // inside the handler so that it is visible in a stack trace and in the route map.
        const loginRateLimitDisabled = (_req: Request, _res: Response, next: NextFunction): void => {
            return next();
        };
        return loginRateLimitDisabled;
    }

    const loginRateLimit = (req: Request, res: Response, next: NextFunction): void => {
        try {
            const address = _resolveAddress(req);
            if (!address) {
                return next();
            }

            const now = Date.now();
            if (windows.size >= SWEEP_THRESHOLD) {
                _sweepExpired(windows, now, window_ms);
                if (windows.size < MAX_TRACKED_ADDRESSES) {
                    // Drained. The next saturation is a new event and is allowed to say so once.
                    ceilingLogged = false;
                }
            }

            let window = windows.get(address);
            if (window && (now - window.opened_at) >= window_ms) {
                // Expired. Dropped rather than reset in place, so a stale object can never be the
                // one a still-in-flight request refunds against.
                windows.delete(address);
                window = undefined;
            }

            if (!window) {
                if (windows.size >= MAX_TRACKED_ADDRESSES) {
                    /*
                     * ⚠️ ADMITTED WITHOUT BEING COUNTED, and that is the deliberate direction.
                     *
                     * Past the ceiling a new address gets no window, so the throttle is off for it
                     * until the sweep drains the Map. The alternative — refusing once the Map is
                     * full — turns a memory bound into a way for an attacker to lock every new
                     * address out of the login, including the operator's, which is the one failure
                     * this file exists to make impossible (property 3 in the header). Fail-open is
                     * the same choice the catch block below makes.
                     *
                     * The exposure is bounded: reaching 10000 distinct addresses inside one window
                     * requires TRUST_PROXY to be set to trust real client addresses (with the
                     * shipped default `false` every caller collapses to a single key and the
                     * ceiling is unreachable), an attacker who already controls that many addresses
                     * has max_failures × 10000 guesses without needing this path at all, and bcrypt
                     * at the configured cost remains the real per-attempt throttle.
                     *
                     * Logged ONCE per period of saturation — see `ceilingLogged`.
                     */
                    if (!ceilingLogged) {
                        ceilingLogged = true;
                        customConsoleWarn('WARN: loginRateLimit: tracking ceiling reached — new addresses are NOT being counted until it drains', {
                            tracked_addresses: windows.size,
                            ceiling: MAX_TRACKED_ADDRESSES
                        });
                    }
                    return next();
                }
                window = _liveWindow(null, now);
                windows.set(address, window);
            }

            // The deployment-wide tally, rolled on the same clock as the per-address one.
            globalWindow = _liveWindow(globalWindow, now);

            // Either budget can refuse. The per-address one is the ordinary throttle; the global one
            // is what still bites when `req.ip` is attacker-chosen and every request looks like a
            // new address.
            const addressSpent = window.failures >= max_failures;
            const globalSpent = globalWindow.failures >= global_max_failures;

            if (addressSpent || globalSpent) {
                // A refusal is a RATE, not a wall. Whichever budgets are spent must each have
                // reached their trickle time before one attempt is let through, and letting it
                // through re-arms them — so the operator is never locked out for longer than the
                // interval, and an attacker gets two guesses a minute rather than a free run.
                const spent: FailureWindow[] = [];
                if (addressSpent) {
                    spent.push(window);
                }
                if (globalSpent) {
                    spent.push(globalWindow);
                }
                const trickleReady = spent.every((entry) => now >= entry.next_trickle_at);

                if (trickleReady) {
                    for (const entry of spent) {
                        entry.next_trickle_at = now + trickle_interval_ms;
                    }
                    customConsoleWarn('WARN: loginRateLimit: admitting one attempt from a spent budget — the operator must always be able to sign in', {
                        address: address,
                        address_spent: addressSpent,
                        global_spent: globalSpent,
                        next_trickle_in_seconds: Math.ceil(trickle_interval_ms / 1000)
                    });
                } else {
                    const blocking = globalSpent && !addressSpent ? globalWindow : window;
                    const retryAfterSeconds = Math.max(1, Math.ceil(((blocking.opened_at + window_ms) - now) / 1000));

                    if (!blocking.refusal_logged) {
                        // Once per window. An attacker looping on a blocked address must not be able to
                        // choose how fast this deployment's log grows.
                        blocking.refusal_logged = true;
                        customConsoleWarn('WARN: loginRateLimit: refusing sign-in attempts — too many rejected credentials', {
                            address: address,
                            failures: blocking.failures,
                            max_failures: globalSpent && !addressSpent ? global_max_failures : max_failures,
                            scope: globalSpent && !addressSpent ? 'deployment' : 'address',
                            retry_after_seconds: retryAfterSeconds
                        });
                    } else {
                        customConsoleDebug('DEBUG: loginRateLimit: attempt refused', { address: address });
                    }

                    res.setHeader('Retry-After', String(retryAfterSeconds));
                    /*
                     * The envelope is written out here rather than taken from `utils/apiResponse`,
                     * which has no 429 helper. Field for field the same shape every other response
                     * uses — a client parses one shape whatever happened — and the reason it is
                     * inline is that adding the helper touches a file outside this change.
                     */
                    res.status(TOO_MANY_REQUESTS).json({
                        status: false,
                        msg: RATE_LIMITED_MESSAGE,
                        data: {},
                        error: {}
                    });
                    return;
                }
            }

            // ── The optimistic charge ───────────────────────────────────────
            // Applied BEFORE the handler runs, so concurrent attempts cannot slip through
            // together. Settled below once the outcome is known.
            window.failures += 1;
            globalWindow.failures += 1;
            const charged = window;
            const chargedGlobal = globalWindow;

            res.once('close', () => {
                try {
                    // Only settle against the window that was actually charged. If it has expired,
                    // been cleared by a successful sign-in, or been swept, the charge is already
                    // gone and refunding would take a bite out of somebody else's budget.
                    const addressLive = windows.get(address) === charged;
                    const globalLive = globalWindow === chargedGlobal;
                    if (!addressLive && !globalLive) {
                        return;
                    }

                    // No response was ever sent — the caller hung up. Not a rejected credential, and
                    // an operator on a bad connection must not be charged for their network.
                    const answered = res.writableEnded;

                    if (answered && res.statusCode >= 200 && res.statusCode < 300) {
                        // Property 5: a correct password wipes the tally rather than merely not
                        // adding to it, so a near-miss followed by a success leaves nothing behind.
                        //
                        // It clears the DEPLOYMENT tally too, and that is the point rather than a
                        // side effect: whoever just proved they hold the password is the operator,
                        // and leaving a global block standing behind them would re-lock the only
                        // account on the next request.
                        if (addressLive) {
                            windows.delete(address);
                        }
                        if (globalLive) {
                            globalWindow = null;
                        }
                        return;
                    }

                    if (answered && res.statusCode === UNAUTHORIZED) {
                        // The one chargeable outcome: a credential was submitted and rejected.
                        return;
                    }

                    // Everything else — a 400 for a missing field, a 500, an abandoned request —
                    // is refunded. None of them is a guess at the password, and charging for a
                    // malformed request would let a broken client spend the operator's budget.
                    if (addressLive) {
                        charged.failures -= 1;
                        if (charged.failures <= 0) {
                            windows.delete(address);
                        }
                    }
                    if (globalLive) {
                        chargedGlobal.failures -= 1;
                        if (chargedGlobal.failures <= 0) {
                            globalWindow = null;
                        }
                    }
                } catch (settleError) {
                    // Nothing to answer with — the response is already over. Losing a charge is
                    // the safe direction to fail in.
                    customConsoleError('ERROR: middleware loginRateLimit settle', settleError);
                }
            });

            return next();
        } catch (error) {
            // FAILS OPEN, on purpose. See property 6 in the file header: this middleware protects
            // availability, and a fault inside it must not become the reason nobody can sign in.
            customConsoleError('ERROR: middleware loginRateLimit — admitting the request', error);
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

    return loginRateLimit;
};

/**
 * The instance the application mounts, built from the two documented config keys.
 *
 * A non-positive window is read as "unset" rather than as "never expires": a window that never
 * rolls is the permanent lockout this whole file exists not to have.
 */
const loginRateLimit = createLoginRateLimiter({
    max_failures: config.AUTH.LOGIN_RATE_LIMIT_MAX,
    window_ms: (config.AUTH.LOGIN_RATE_LIMIT_WINDOW_MINUTES > 0
        ? config.AUTH.LOGIN_RATE_LIMIT_WINDOW_MINUTES
        : DEFAULT_WINDOW_MINUTES) * 60 * 1000
});

export = {
    /** The limiter the application mounts. Built from `config.AUTH.LOGIN_RATE_LIMIT_*`. */
    loginRateLimit,
    /** Builds a limiter with explicit limits. Used by the test suite to watch a window expire. */
    createLoginRateLimiter,
    /** The path `src/apps/app.ts` mounts the limiter on. Must address the real login route. */
    LOGIN_RATE_LIMIT_PATH,
    /** The single sentence a refused caller is told. Carries no account information. */
    RATE_LIMITED_MESSAGE
};
