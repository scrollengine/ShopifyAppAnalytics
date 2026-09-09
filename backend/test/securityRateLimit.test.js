'use strict';

/**
 * ============================================================================
 *  LOGIN RATE LIMITING — and, more importantly, RECOVERY FROM IT
 * ============================================================================
 *
 *  `AUTH_LOGIN_RATE_LIMIT_MAX` and `AUTH_LOGIN_RATE_LIMIT_WINDOW_MINUTES` were
 *  documented in `src/config/index.ts` as "failed logins allowed per window, per
 *  source address, before refusal" and read by nothing at all: a repo-wide grep
 *  found two hits and both were the definitions. Documented enforcement that
 *  does not exist is worse than an absence, because an operator reads it and
 *  stops looking. `src/middlewares/loginRateLimit.ts` is the enforcement; this
 *  file is the proof that it enforces, and — the half that matters more — that
 *  it lets go.
 *
 *  ── ⚠️ WHY HALF OF THIS FILE IS ABOUT GETTING BACK IN ───────────────────────
 *  This deployment has ONE account, no sign-up, no second user and no
 *  password-reset flow. A lockout is not an inconvenience here, it is the end of
 *  that install. So a rate limiter is a genuinely dangerous thing to add, and the
 *  tests below assert the properties that keep it from being one:
 *
 *    - the refusal EXPIRES on its own, and a correct password works again after
 *      it does (`the operator recovers`);
 *    - a caller hammering a blocked address CANNOT push that expiry outward, so
 *      the wait is bounded by the configured window and nothing else;
 *    - a successful sign-in CLEARS the tally rather than merely not adding to it;
 *    - only a REJECTED CREDENTIAL is charged — not a malformed request, not a
 *      server error;
 *    - `AUTH_LOGIN_RATE_LIMIT_MAX=0` switches the whole thing off;
 *    - and a request whose address cannot be resolved is ADMITTED, because a
 *      throttle that fails closed on the only way into the system is a worse bug
 *      than the one it was added to fix.
 *
 *  Every timing test runs on a sub-second window rather than the configured
 *  fifteen minutes. That is what `createLoginRateLimiter` takes its limits as
 *  arguments for; the instance the application mounts is asserted separately, at
 *  the bottom, against the real config keys and the real route.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const express = require('express');
const mongoose = require('mongoose');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const APP_ENTRY = path.join(BACKEND_ROOT, 'src', 'apps', 'app.ts');

const {
    createLoginRateLimiter,
    loginRateLimit,
    LOGIN_RATE_LIMIT_PATH,
    RATE_LIMITED_MESSAGE
} = require(path.join(BACKEND_ROOT, 'src', 'middlewares', 'loginRateLimit'));

const config = require(path.join(BACKEND_ROOT, 'src', 'config'));

mongoose.set('bufferTimeoutMS', 400);

/** The password the stand-in handler accepts. Nothing here touches bcrypt or the database. */
const CORRECT_PASSWORD = 'the-operator-remembers-this-one';

/** A path that is NOT the login route, used to prove the limiter is scoped to the one endpoint. */
const UNTHROTTLED_PATH = '/api/revenue/now';

/** HTTP 429. */
const TOO_MANY = 429;

/** HTTP 401 — a credential was submitted and rejected. The one chargeable outcome. */
const UNAUTHORIZED = 401;

/**
 * Stands in for `POST /api/auth/login`.
 *
 * ⚠️ It reproduces the real controller's STATUS CODES exactly, because those are the entire
 * interface between the controller and the limiter: 400 for an incomplete request
 * (`validationErrorResponse`), 401 for a rejected credential (`unauthorizedResponse`), 200 with a
 * token on success (`successResponseWithData`). It does NOT reproduce bcrypt — `delay_ms` stands
 * in for the ~250ms a real comparison costs, which is what makes the concurrency test below mean
 * something.
 *
 * @param {Number} delayMs - How long the handler takes before answering.
 * @returns {Function} An Express handler.
 */
const _standInLoginHandler = (delayMs) => {
    return async (req, res) => {
        if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        const body = req.body || {};
        if (!body.email || !body.password) {
            return res.status(400).json({ status: false, msg: 'Email and password are both required.', data: {}, error: {} });
        }
        if (body.password === CORRECT_PASSWORD) {
            return res.status(200).json({ status: true, msg: 'Signed in.', data: { token: 'stand-in-token' }, error: {} });
        }
        return res.status(401).json({ status: false, msg: 'Email or password is incorrect.', data: {}, error: {} });
    };
};

/**
 * Starts a server composed the way `src/apps/app.ts` composes the login path.
 *
 * The limiter is mounted on `LOGIN_RATE_LIMIT_PATH` — the constant the entry point mounts it on —
 * and BEFORE the body parser, both for the same reasons as the real thing.
 *
 * @param {Object} params0 - The parameters object.
 * @param {Number} params0.max_failures - Rejected credentials allowed per window.
 * @param {Number} params0.window_ms - Window length in milliseconds.
 * @param {*} [params0.trust_proxy] - Passed to `app.set('trust proxy', …)` when given.
 * @param {Number} [params0.delay_ms] - How long the stand-in handler takes. Defaults to 0.
 * @returns {Promise<Object>} `{ baseUrl, close, login, get }`.
 */
const _startServer = async ({ max_failures, window_ms, trust_proxy, delay_ms, trickle_ms }) => {
    const app = express();
    if (trust_proxy !== undefined) {
        app.set('trust proxy', trust_proxy);
    }
    app.use(LOGIN_RATE_LIMIT_PATH, createLoginRateLimiter({ max_failures: max_failures, window_ms: window_ms, trickle_ms: trickle_ms }));
    app.use(express.json({ limit: '1mb' }));
    app.post(LOGIN_RATE_LIMIT_PATH, _standInLoginHandler(delay_ms || 0));
    app.get(UNTHROTTLED_PATH, (_req, res) => res.status(401).json({ status: false, msg: 'Not authenticated.', data: {}, error: {} }));

    const server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    /**
     * Posts a login attempt.
     *
     * @param {Object} params0 - The parameters object.
     * @param {String} [params0.password] - Password to submit. Omit for a malformed request.
     * @param {String} [params0.forwarded_for] - Value for the X-Forwarded-For header.
     * @returns {Promise<Object>} `{ status, body, retry_after }`.
     */
    const login = async ({ password, forwarded_for } = {}) => {
        const headers = { 'content-type': 'application/json' };
        if (forwarded_for) {
            headers['x-forwarded-for'] = forwarded_for;
        }
        const payload = password === undefined ? {} : { email: 'operator@example.com', password: password };
        const response = await fetch(`${baseUrl}${LOGIN_RATE_LIMIT_PATH}`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload)
        });
        let body = {};
        try {
            body = await response.json();
        } catch (error) {
            body = {};
        }
        return { status: response.status, body: body, retry_after: response.headers.get('retry-after') };
    };

    return {
        baseUrl: baseUrl,
        login: login,
        get: async (routePath) => {
            const response = await fetch(`${baseUrl}${routePath}`);
            return { status: response.status };
        },
        close: () => new Promise((resolve) => server.close(resolve))
    };
};

/**
 * @param {Number} ms - Milliseconds to wait.
 * @returns {Promise<void>} Resolves after the wait.
 */
const _wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


/* ==========================================================================
 *  1. It enforces
 * ========================================================================== */

test('the budget is spent by rejected credentials, and the next attempt is refused with 429', async () => {
    const server = await _startServer({ max_failures: 3, window_ms: 60000 });
    try {
        const first = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
            first.push((await server.login({ password: 'wrong' })).status);
        }
        assert.deepEqual(first, [401, 401, 401], 'the configured budget was not honoured — attempts inside it must reach the handler');

        const refused = await server.login({ password: 'wrong' });
        assert.equal(refused.status, TOO_MANY, 'the attempt after the budget was not refused; the limiter is not enforcing');
        assert.equal(refused.body.status, false, 'the refusal must carry the same { status, msg, data, error } envelope as every other response');
        assert.equal(refused.body.msg, RATE_LIMITED_MESSAGE);
        assert.ok(refused.retry_after, 'a 429 without Retry-After tells the operator to guess how long to wait');
        assert.ok(Number(refused.retry_after) > 0 && Number(refused.retry_after) <= 60, `Retry-After was ${refused.retry_after}, which is outside the window it was configured with`);
    } finally {
        await server.close();
    }
});

test('the refusal reveals nothing about which account was being guessed', async () => {
    // The login path is enumeration-resistant by construction — one message for both failure modes,
    // and a dummy bcrypt compare so the timings match. A 429 must not undo that by naming what was
    // tried. It cannot, structurally: the tally counts rejected credentials from an ADDRESS and
    // never looks at the body. This asserts that stays true.
    const server = await _startServer({ max_failures: 1, window_ms: 60000 });
    try {
        await server.login({ password: 'wrong' });
        const refused = await server.login({ password: 'wrong' });

        const serialised = JSON.stringify(refused.body).toLowerCase();
        assert.equal(serialised.includes('operator@example.com'), false, 'the refusal echoed the submitted email back');
        assert.equal(serialised.includes('account'), false, 'the refusal mentions accounts — that is a word this message can only get wrong');
        assert.deepEqual(refused.body.data, {}, 'the refusal carried a payload; it has nothing to say');
    } finally {
        await server.close();
    }
});

test('a burst of simultaneous attempts cannot outrun the budget', async () => {
    //  THE TEST THAT JUSTIFIES COUNTING ON THE WAY IN. The handler here takes 60ms, standing in
    // for bcrypt's ~250ms. A limiter that counted failures as responses went OUT would have nothing
    // recorded while these are all in flight, and every one of them would reach the handler —
    // costing this process twelve bcrypt comparisons and giving the caller twelve free guesses.
    const server = await _startServer({ max_failures: 3, window_ms: 60000, delay_ms: 60 });
    try {
        const results = await Promise.all(
            Array.from({ length: 12 }, () => server.login({ password: 'wrong' }))
        );
        const reached = results.filter((result) => result.status === 401).length;
        const refused = results.filter((result) => result.status === TOO_MANY).length;

        assert.equal(reached, 3, `${reached} concurrent attempts reached the handler; the budget was 3`);
        assert.equal(refused, 9, `${refused} were refused; the other ${results.length - refused} got through`);
    } finally {
        await server.close();
    }
});

test('the limiter is scoped to the login path and throttles nothing else', async () => {
    const server = await _startServer({ max_failures: 1, window_ms: 60000 });
    try {
        await server.login({ password: 'wrong' });
        assert.equal((await server.login({ password: 'wrong' })).status, TOO_MANY, 'precondition: the login path must be blocked at this point');

        const others = [];
        for (let attempt = 0; attempt < 10; attempt += 1) {
            others.push((await server.get(UNTHROTTLED_PATH)).status);
        }
        assert.deepEqual(
            others,
            new Array(10).fill(401),
            'a route other than the login endpoint was throttled. The limiter is mounted on one path on purpose: '
            + 'the guarded API is protected by verifyAdmin, and throttling it would only give an anonymous caller '
            + 'a way to degrade the dashboard for the operator.'
        );
    } finally {
        await server.close();
    }
});


/* ==========================================================================
 *  2. It lets go — the half that matters on a one-account install
 * ========================================================================== */

test(' THE OPERATOR RECOVERS: the window expires and the correct password works again', async () => {
    //  THE MOST IMPORTANT TEST IN THIS FILE. One account, no reset flow, no second user. If this
    // assertion ever fails, a forgotten password becomes a permanently unusable install.
    const server = await _startServer({ max_failures: 2, window_ms: 400 });
    try {
        assert.equal((await server.login({ password: 'wrong' })).status, 401);
        assert.equal((await server.login({ password: 'nope' })).status, 401);

        const lockedOut = await server.login({ password: CORRECT_PASSWORD });
        assert.equal(lockedOut.status, TOO_MANY, 'precondition: the operator must actually be blocked, or the recovery below proves nothing');

        await _wait(550);

        const recovered = await server.login({ password: CORRECT_PASSWORD });
        assert.equal(
            recovered.status,
            200,
            'THE OPERATOR IS LOCKED OUT AFTER THE WINDOW EXPIRED. On a deployment with one account and no '
            + 'password-reset flow this is the end of the install. Do not weaken this test — fix the limiter.'
        );
        assert.equal(recovered.body.data.token, 'stand-in-token');
    } finally {
        await server.close();
    }
});

test('hammering a blocked address does NOT push the recovery further away', async () => {
    //  The property that turns "wait for the window" into a promise rather than a hope. A refused
    // attempt never reaches the handler, so it produces no 401 and is charged nothing — which means
    // the window still expires at the moment it was opened plus its length, no matter how hard
    // somebody leans on the endpoint in between. A limiter that reset its clock on every refusal
    // would let one attacker keep the operator out forever, and would look correct in every other
    // test in this file.
    const server = await _startServer({ max_failures: 2, window_ms: 500 });
    try {
        await server.login({ password: 'wrong' });
        await server.login({ password: 'wrong' });

        // Twenty refusals spread across the window, exactly as a script would.
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const refused = await server.login({ password: 'wrong' });
            assert.equal(refused.status, TOO_MANY);
            await _wait(20);
        }

        await _wait(250);

        const recovered = await server.login({ password: CORRECT_PASSWORD });
        assert.equal(
            recovered.status,
            200,
            'The window did not expire on schedule while the endpoint was under attack. That makes the block '
            + 'indefinite for as long as somebody keeps trying — an attacker-controlled lockout of the only account.'
        );
    } finally {
        await server.close();
    }
});

test('a successful sign-in CLEARS the tally rather than merely not adding to it', async () => {
    const server = await _startServer({ max_failures: 3, window_ms: 60000 });
    try {
        assert.equal((await server.login({ password: 'wrong' })).status, 401);
        assert.equal((await server.login({ password: 'wrong' })).status, 401);
        assert.equal((await server.login({ password: CORRECT_PASSWORD })).status, 200);

        // A full fresh budget, not the one remaining attempt that was left before the success.
        const afterSuccess = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
            afterSuccess.push((await server.login({ password: 'wrong' })).status);
        }
        assert.deepEqual(
            afterSuccess,
            [401, 401, 401],
            'the tally survived a successful sign-in. A near-miss followed by a correct password must leave nothing behind, '
            + 'or an operator who mistypes twice in the morning starts the afternoon two-thirds of the way to a block.'
        );
        assert.equal((await server.login({ password: 'wrong' })).status, TOO_MANY, 'the limiter stopped counting entirely after a success');
    } finally {
        await server.close();
    }
});

test('successful sign-ins are never charged, however many there are', async () => {
    const server = await _startServer({ max_failures: 1, window_ms: 60000 });
    try {
        const results = [];
        for (let attempt = 0; attempt < 8; attempt += 1) {
            results.push((await server.login({ password: CORRECT_PASSWORD })).status);
        }
        assert.deepEqual(results, new Array(8).fill(200), 'ordinary use walked toward the limit; only REJECTED credentials may be charged');
    } finally {
        await server.close();
    }
});

test('a malformed request is refunded — a broken client cannot spend the operator\'s budget', async () => {
    const server = await _startServer({ max_failures: 2, window_ms: 60000 });
    try {
        const malformed = [];
        for (let attempt = 0; attempt < 8; attempt += 1) {
            malformed.push((await server.login({})).status);
        }
        assert.deepEqual(malformed, new Array(8).fill(400), 'the malformed requests did not all reach the handler');

        // The budget must be untouched: two rejected credentials, and only then a refusal.
        assert.equal((await server.login({ password: 'wrong' })).status, 401);
        assert.equal((await server.login({ password: 'wrong' })).status, 401);
        assert.equal((await server.login({ password: 'wrong' })).status, TOO_MANY);
    } finally {
        await server.close();
    }
});

test('AUTH_LOGIN_RATE_LIMIT_MAX=0 turns the limiter off entirely', async () => {
    // The documented escape hatch, and the reason `_int` in src/config/index.ts preserves a
    // configured zero. Read the other way — "zero failures allowed" — this same value would refuse
    // the operator's first mistyped password and never let them back in.
    const server = await _startServer({ max_failures: 0, window_ms: 60000 });
    try {
        const results = [];
        for (let attempt = 0; attempt < 25; attempt += 1) {
            results.push((await server.login({ password: 'wrong' })).status);
        }
        assert.deepEqual(results, new Array(25).fill(401), 'a max of 0 refused an attempt; it must disable the limiter, not brick the login');
    } finally {
        await server.close();
    }
});

test('the limiter FAILS OPEN when there is no address to charge', async () => {
    // verifyAdmin is the authentication boundary; this is availability protection. A throttle that
    // refuses when it cannot do its job would be a denial of the only way into the deployment.
    const limiter = createLoginRateLimiter({ max_failures: 1, window_ms: 60000 });

    let admitted = false;
    let answered = false;
    const res = {
        setHeader: () => {
            answered = true;
        },
        status: () => {
            answered = true; return res;
        },
        json: () => {
            answered = true; return res;
        },
        once: () => res
    };

    // No `ip`, and a socket with no remote address — what a request whose connection has already
    // gone away looks like.
    limiter({ ip: undefined, socket: {} }, res, () => {
        admitted = true;
    });

    assert.equal(admitted, true, 'a request with no resolvable address was not admitted');
    assert.equal(answered, false, 'the limiter answered the request instead of passing it on');
});


/* ==========================================================================
 *  3. Per source address — as true as `trust proxy` is
 * ========================================================================== */

test('two source addresses hold two separate budgets', async () => {
    // `trust proxy` is set here so the two forwarded addresses are distinguishable at all. In a
    // deployment it is `config.APP.TRUST_PROXY`, and with it unset every caller behind the
    // dashboard's server-side proxy collapses into ONE address and shares one budget — the limit
    // becomes per-deployment rather than per-address. That is documented on `_trustProxy` in
    // src/config/index.ts and is the reason this test configures it explicitly rather than assuming.
    const server = await _startServer({ max_failures: 2, window_ms: 60000, trust_proxy: true });
    try {
        assert.equal((await server.login({ password: 'wrong', forwarded_for: '203.0.113.10' })).status, 401);
        assert.equal((await server.login({ password: 'wrong', forwarded_for: '203.0.113.10' })).status, 401);
        assert.equal((await server.login({ password: 'wrong', forwarded_for: '203.0.113.10' })).status, TOO_MANY);

        const otherAddress = await server.login({ password: CORRECT_PASSWORD, forwarded_for: '198.51.100.7' });
        assert.equal(
            otherAddress.status,
            200,
            'a second address inherited the first one\'s block. Keying on the address rather than the account is '
            + 'what stops an attacker from locking the operator out of their own credential — another network must '
            + 'always be a fresh budget.'
        );
    } finally {
        await server.close();
    }
});


/* ==========================================================================
 *  4. The wiring — the config keys, the mount, and the real route
 * ========================================================================== */

test('the mounted limiter is built from the two documented config keys', () => {
    assert.equal(typeof loginRateLimit, 'function', 'the application-facing limiter is not a middleware');
    assert.equal(typeof config.AUTH.LOGIN_RATE_LIMIT_MAX, 'number', 'AUTH_LOGIN_RATE_LIMIT_MAX vanished from config');
    assert.equal(typeof config.AUTH.LOGIN_RATE_LIMIT_WINDOW_MINUTES, 'number', 'AUTH_LOGIN_RATE_LIMIT_WINDOW_MINUTES vanished from config');
    assert.ok(config.AUTH.LOGIN_RATE_LIMIT_MAX > 0, 'the shipped default must have the limiter ON');
    assert.ok(config.AUTH.LOGIN_RATE_LIMIT_WINDOW_MINUTES > 0, 'a window of zero or less would be a block that never expires');
});

test(' the mount path in app.ts addresses the REAL login route', async () => {
    //  THE ASSERTION THAT KEEPS TWO FILES IN AGREEMENT. The limiter is mounted at
    // LOGIN_RATE_LIMIT_PATH in src/apps/app.ts, while the route it protects is composed in
    // src/routes/index.ts out of a '/api/auth' mount and a '/login' inside it. Nothing in the
    // language ties those together: move the route and the throttle silently stops applying, with
    // no error anywhere. So the path is exercised against the real router here — if it stops
    // reaching a handler, this fails instead.
    const routes = require(path.join(BACKEND_ROOT, 'src', 'routes'));

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use(routes);

    const server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
        // An empty body, so the real controller answers 400 without reaching bcrypt or the database.
        const response = await fetch(`${baseUrl}${LOGIN_RATE_LIMIT_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
        });
        assert.notEqual(
            response.status,
            404,
            `Nothing answers POST ${LOGIN_RATE_LIMIT_PATH} any more. The login route moved and the rate limit is now `
            + 'mounted on a dead path — it is refusing nothing at all. Update LOGIN_RATE_LIMIT_PATH in '
            + 'src/middlewares/loginRateLimit.ts to wherever the route went.'
        );
        assert.equal(response.status, 400, `POST ${LOGIN_RATE_LIMIT_PATH} with an empty body answered ${response.status}; the real controller answers 400`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test(' src/apps/app.ts mounts the limiter, on that path, before the body parser', () => {
    const source = fs.readFileSync(APP_ENTRY, 'utf8');
    const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

    assert.ok(
        /app\.use\(\s*LOGIN_RATE_LIMIT_PATH\s*,\s*loginRateLimit\s*\)/.test(withoutComments),
        'src/apps/app.ts no longer mounts loginRateLimit on LOGIN_RATE_LIMIT_PATH. Every behavioural assertion in '
        + 'this file is made against a reproduction of that mount, so without this line they prove nothing about the '
        + 'running application.'
    );

    const mounts = [...withoutComments.matchAll(/app\.use\(\s*([A-Za-z_$][\w$.]*)/g)].map((match) => match[1]);
    const limiterAt = mounts.indexOf('LOGIN_RATE_LIMIT_PATH');
    const parserAt = mounts.indexOf('express.json');

    assert.ok(limiterAt >= 0 && parserAt >= 0, 'the limiter and the body parser must both be mounted on the app');
    assert.ok(
        limiterAt < parserAt,
        'the body parser now runs before the rate limit. A refused attempt would then have up to a megabyte of JSON '
        + 'parsed on its behalf before anything decided to refuse it, which hands an anonymous caller the one piece '
        + 'of work this endpoint does before authenticating.'
    );

    assert.ok(
        /app\.set\(\s*'trust proxy'\s*,\s*config\.APP\.TRUST_PROXY\s*\)/.test(withoutComments),
        "src/apps/app.ts no longer sets 'trust proxy' from config. `req.ip` — the thing the limiter keys on — then "
        + 'means whatever Express defaults to, and the per-address behaviour asserted in this file stops being '
        + 'configurable at all.'
    );
});

test('the refusal carries a Retry-After the caller can act on', async () => {
    // A 429 with no Retry-After tells a caller to come back "later" and leaves them to guess how
    // much later. It is also the only place the bounded wait is stated in the response itself,
    // which on a deployment whose operator may BE the refused caller is the difference between
    // "wait a quarter of an hour" and "I am locked out of my own dashboard".
    const server = await _startServer({ max_failures: 1, window_ms: 60000 });
    try {
        assert.equal((await server.login({ password: 'wrong' })).status, 401);

        const refused = await server.login({ password: 'wrong' });
        assert.equal(refused.status, TOO_MANY);

        const retryAfter = parseInt(refused.retry_after, 10);
        assert.ok(Number.isFinite(retryAfter), `Retry-After was '${refused.retry_after}' — a 429 must say when to come back`);
        assert.ok(retryAfter >= 1, 'Retry-After must be at least 1; a 0 tells a client to retry immediately, which is the opposite instruction');
        assert.ok(retryAfter <= 60, `Retry-After was ${retryAfter}s on a 60s window — it must describe THIS window, not a fixed guess`);
    } finally {
        await server.close();
    }
});

test('nothing is persisted: a brand new limiter starts with an empty tally', async () => {
    //  ONE OF THE SIX ANTI-LOCKOUT PROPERTIES, and the one an operator actually reaches for. The
    // whole of the state is an in-process Map, so `docker compose restart backend` clears every
    // block instantly — a lever that is always available to whoever owns the box. A Redis-backed
    // store would survive the restart, which sounds like an improvement and would quietly remove
    // the only escape hatch that does not involve waiting.
    const first = await _startServer({ max_failures: 1, window_ms: 60000 });
    try {
        assert.equal((await first.login({ password: 'wrong' })).status, 401);
        assert.equal((await first.login({ password: CORRECT_PASSWORD })).status, TOO_MANY, 'precondition: the first limiter should be blocking');
    } finally {
        await first.close();
    }

    const restarted = await _startServer({ max_failures: 1, window_ms: 60000 });
    try {
        assert.equal(
            (await restarted.login({ password: CORRECT_PASSWORD })).status,
            200,
            'a block survived into a brand new limiter. Restarting the process no longer clears it, which takes away '
            + 'the escape hatch a self-hoster reaches for first and leaves waiting out the window as the only way back in.'
        );
    } finally {
        await restarted.close();
    }
});

test('TRUST_PROXY defaults to false — the direction that cannot be switched off by a header', () => {
    //  THE MOST CONSEQUENTIAL DEFAULT IN THIS CHANGE. `req.ip` is what the limiter charges, and
    // trusting a forwarded address that no proxy of ours wrote means any caller can claim a
    // different one on every request, land in a fresh bucket every time, and never reach the limit —
    // an enforcement that is present, believed, and doing nothing.
    //
    // Not trusting enough fails the other way: every caller shares the proxy's address and the limit
    // becomes per-deployment. That is worse protection against a targeted lockout and BETTER
    // protection against brute force, and — the deciding property — it is LOUD. config/validate.ts
    // warns about it at boot. The over-trusting failure warns about nothing, because from inside
    // the process it looks exactly like working correctly.
    assert.equal(
        config.APP.TRUST_PROXY,
        false,
        'TRUST_PROXY no longer defaults to false. An install that has not thought about its proxy chain would now '
        + 'trust an X-Forwarded-For written by whoever sent the request, and AUTH_LOGIN_RATE_LIMIT_MAX would be '
        + 'unreachable. Read _trustProxy in src/config/index.ts before changing this.'
    );
});


/* ==========================================================================
 *  6. The two budgets, and why the address alone was not enough
 * ==========================================================================
 *
 *  Everything above assumes `req.ip` distinguishes callers. Behind the topology
 *  docker-compose ships, it does not — verified against `proxy-addr` directly:
 *
 *    TRUST_PROXY unset (the default)  -> every caller collapses to the dashboard
 *                                        container's address: ONE shared budget.
 *    TRUST_PROXY=uniquelocal          -> `req.ip` becomes the caller's own
 *                                        X-Forwarded-For: a FRESH budget per
 *                                        request, so the tally never trips.
 *
 *  Next's rewrite proxy is what makes the second reachable: it sets
 *  x-forwarded-for with `??=` and passes http-proxy no `xfwd`, so a
 *  client-supplied header travels to this process untouched.
 *
 *  The deployment-wide budget answers the second. The trickle answers what the
 *  first would otherwise become — a permanent lockout of the only account.
 * ========================================================================== */

test('a forged X-Forwarded-For mints a fresh per-address budget — the hole the global budget exists to close', async () => {
    // The bypass itself, reproduced rather than described. Every request carries a different
    // address, so the per-address tally opens a new window each time and never reaches its own
    // limit. Without the deployment-wide budget this loop never stops being answered 401.
    // `trust_proxy: true` rather than the literal 'uniquelocal' the docs used to recommend: the
    // test peer is 127.0.0.1, and `uniquelocal` covers the private ranges but NOT loopback, so it
    // would leave every forged header ignored and this test passing for the wrong reason. In the
    // real topology the peer IS a private-range container address, so `uniquelocal` trusts it and
    // the header below is exactly what arrives.
    const server = await _startServer({ max_failures: 2, window_ms: 60000, trust_proxy: true });

    try {
        const seen = [];
        for (let attempt = 0; attempt < 12; attempt += 1) {
            const result = await server.login({ password: 'wrong', forwarded_for: `203.0.113.${attempt}` });
            seen.push(result.status);
        }

        assert.ok(
            seen.includes(TOO_MANY),
            `Twelve guesses from twelve forged addresses were all answered ${JSON.stringify([...new Set(seen)])}. `
            + 'The per-address budget cannot see them as one caller, so the deployment-wide budget is '
            + 'the only thing that can — and it did not fire.'
        );
        assert.equal(seen[0], UNAUTHORIZED, 'The first guess should be answered normally; the budget is not meant to refuse from cold.');

        // WHICH budget refused, pinned. max_failures is 2 and every address is used exactly once,
        // so the per-address tally can never reach its own limit — if the first refusal landed at
        // or before the third attempt, something other than the deployment-wide budget stopped it
        // and this test would be passing for the wrong reason.
        const firstRefusal = seen.indexOf(TOO_MANY) + 1;
        assert.equal(
            firstRefusal,
            11,
            `The first refusal landed at attempt ${firstRefusal}. With max_failures 2 and a x5 `
            + 'deployment-wide multiplier it must land at 11: ten guesses admitted, the eleventh refused.'
        );
    } finally {
        await server.close();
    }
});

test('the deployment-wide budget is a MULTIPLE of the per-address one, so honest use never reaches it', async () => {
    // The global ceiling must sit far enough above the per-address one that a single operator
    // fumbling their password meets the ordinary limit and never the deployment-wide one — which
    // is the limit whose refusal message says nothing about addresses.
    const server = await _startServer({ max_failures: 3, window_ms: 60000, trust_proxy: true });

    try {
        // Three failures from ONE address: the per-address budget is what stops this.
        for (let attempt = 0; attempt < 3; attempt += 1) {
            assert.equal((await server.login({ password: 'wrong', forwarded_for: '198.51.100.7' })).status, UNAUTHORIZED);
        }
        assert.equal(
            (await server.login({ password: 'wrong', forwarded_for: '198.51.100.7' })).status,
            TOO_MANY,
            'the per-address budget stopped enforcing once a global one existed'
        );

        // A DIFFERENT address is still fine — the global budget (3 x 5 = 15) is nowhere near spent.
        assert.equal(
            (await server.login({ password: 'wrong', forwarded_for: '198.51.100.8' })).status,
            UNAUTHORIZED,
            'a second address was refused while the deployment-wide budget still had room; the global '
            + 'ceiling is set too close to the per-address one'
        );
    } finally {
        await server.close();
    }
});

test('THE OPERATOR IS NEVER PERMANENTLY LOCKED OUT: a spent budget still trickles', async () => {
    // The failure this whole file most fears, in the form the shipped topology actually produces.
    // With TRUST_PROXY unset every caller shares one budget, so an attacker spends it and the
    // operator — same bucket — is refused. A window that can be re-spent the instant it rolls is a
    // permanent lockout of the only account on the deployment.
    //
    // The trickle is what makes it a RATE instead: one attempt every interval gets through, and a
    // correct password on one of them ends the block outright.
    const server = await _startServer({ max_failures: 2, window_ms: 60000, trickle_ms: 250 });

    try {
        assert.equal((await server.login({ password: 'wrong' })).status, UNAUTHORIZED);
        assert.equal((await server.login({ password: 'wrong' })).status, UNAUTHORIZED);

        // Budget spent. Immediately after, the operator is refused — the trickle is deliberately
        // NOT available at the instant the budget runs out.
        assert.equal(
            (await server.login({ password: CORRECT_PASSWORD })).status,
            TOO_MANY,
            'the trickle was available immediately, so a burst could spend the budget and walk straight through'
        );

        // Wait out one interval. The correct password now gets through, and the window is over.
        await _wait(300);
        const recovered = await server.login({ password: CORRECT_PASSWORD });
        assert.equal(
            recovered.status,
            200,
            'The operator holding the correct password could not sign in even after the trickle interval. '
            + 'With one account and no reset, that is the end of the install.'
        );

        // And the success cleared the tally, so normal use resumes rather than resuming mid-block.
        assert.equal((await server.login({ password: 'wrong' })).status, UNAUTHORIZED);
    } finally {
        await server.close();
    }
});

test('the trickle is a rate, not an opening: a second attempt inside the interval is still refused', async () => {
    // If the trickle re-armed on anything other than being USED, an attacker could poll it and get
    // a free attempt per request rather than one per interval.
    const server = await _startServer({ max_failures: 1, window_ms: 60000, trickle_ms: 250 });

    try {
        assert.equal((await server.login({ password: 'wrong' })).status, UNAUTHORIZED);
        assert.equal((await server.login({ password: 'wrong' })).status, TOO_MANY);

        await _wait(300);
        assert.equal((await server.login({ password: 'wrong' })).status, UNAUTHORIZED, 'the trickle did not open after its interval');
        assert.equal(
            (await server.login({ password: 'wrong' })).status,
            TOO_MANY,
            'a second attempt inside the same interval was admitted — the trickle is refilling per request, not per interval'
        );
    } finally {
        await server.close();
    }
});

test('a correct password clears the DEPLOYMENT-wide tally too, not just the address', async () => {
    // Otherwise the operator signs in, and the next request re-locks the only account against a
    // global block their own success should have ended.
    const server = await _startServer({ max_failures: 1, window_ms: 60000, trickle_ms: 200, trust_proxy: true });

    try {
        // Spend the global budget (1 x 5 = 5) across five distinct forged addresses.
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await server.login({ password: 'wrong', forwarded_for: `203.0.113.${100 + attempt}` });
        }
        assert.equal(
            (await server.login({ password: 'wrong', forwarded_for: '203.0.113.200' })).status,
            TOO_MANY,
            'precondition: the deployment-wide budget must actually be spent'
        );

        await _wait(250);
        const recovered = await server.login({ password: CORRECT_PASSWORD, forwarded_for: '203.0.113.201' });
        assert.equal(recovered.status, 200, 'the operator could not get through the global block via the trickle');

        // The global tally is gone, so a fresh address is answered normally rather than refused.
        assert.equal(
            (await server.login({ password: 'wrong', forwarded_for: '203.0.113.202' })).status,
            UNAUTHORIZED,
            'the deployment-wide block survived a successful sign-in'
        );
    } finally {
        await server.close();
    }
});
