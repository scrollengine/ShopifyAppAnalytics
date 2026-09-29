'use strict';

/**
 * ============================================================================
 *  PUBLIC-FLOW RATE LIMITS — three budgets, isolated, keyed on the right thing (spec A5, A20)
 * ============================================================================
 *
 *  The public auth flows each have their own limiter:
 *
 *    tokenFlowRateLimit       — keyed on sha256(body.token). Charges only a
 *                               dead-link 400 the controller marked. Mounted on
 *                               the five token routes.
 *    passwordForgotRateLimit  — keyed on the address. Charges everything but a
 *                               shape-rejected 400.
 *    setupRequestRateLimit    — the same, on POST /setup.
 *
 *  ── Why the token flows are NOT keyed on the address ────────────────────────
 *  This backend always sits behind the dashboard's proxy, so with TRUST_PROXY
 *  unset every caller has the SAME address. An address-keyed limiter on invite
 *  acceptance would let ten colleagues accepting their invitations on the same
 *  morning lock each other out. Keyed on the token, only the holder of a link
 *  can spend that link's budget — which is the property the first test pins.
 *
 *  This file loads the REAL auth router, with the real limiter instances built
 *  from AUTH_PUBLIC_FLOW_RATE_LIMIT_MAX=2 (set below, before config is read),
 *  and stubs only the services behind the real controllers. Each test gets a
 *  FRESH router — the limiters are module singletons, so the router and the
 *  limiter module are re-required per test rather than sharing a tally.
 *  (src/middlewares/loginRateLimit.ts and its own suite,
 *  test/securityRateLimit.test.js, are deliberately left untouched.)
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';
process.env.AUTH_PUBLIC_FLOW_RATE_LIMIT_MAX = '2';
process.env.AUTH_PUBLIC_FLOW_RATE_LIMIT_WINDOW_MINUTES = '15';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const express = require('express');
const mongoose = require('mongoose');

mongoose.set('bufferTimeoutMS', 400);

const SRC = path.resolve(__dirname, '..', 'src');
const AUTH_ROUTES = path.join(SRC, 'routes', 'auth.routes.ts');
const FLOW_LIMIT = path.join(SRC, 'middlewares', 'authFlowRateLimit.ts');

const authModule = require(path.join(SRC, 'modules', 'auth'));
const { buildRouteMap } = require('./_harness/routeMap');

const TOO_MANY = 429;
const MAX = 2;

/** A fresh 43-char link token. */
const _token = () => crypto.randomBytes(32).toString('base64url');

const _ok = (data, msg) => ({ status: true, data: data, error: {}, msg: msg || 'ok' });
const _fail = (code, detail) => ({ status: false, data: {}, error: Object.assign({}, detail || {}, { code: code }), msg: `refused: ${code}` });

const STUBBED = [];

/**
 * Stubs the barrel services the real controllers call. `valid` holds the tokens that are live links.
 *
 * @param {Set<String>} valid - Live tokens.
 * @returns {void}
 */
const _stubServices = (valid) => {
    const replace = (key, fn) => {
        STUBBED.push({ key, original: authModule[key] });
        authModule[key] = fn;
    };
    const tokenOutcome = (params, success) => {
        const token = params && params.token;
        if (typeof token !== 'string' || !authModule.isWellFormedToken(token)) {
            return _fail('TOKEN_INVALID');
        }
        if (params.password === 'short') {
            return _fail('PASSWORD_POLICY', { policy_code: 'TOO_SHORT' });
        }
        if (token.startsWith('USED')) {
            return _fail('TOKEN_USED');
        }
        return valid.has(token) ? success : _fail('TOKEN_INVALID');
    };
    replace('inspectInvite', async (identity, params) => tokenOutcome(params, _ok({ email: 'new@example.com' })));
    replace('acceptInvite', async (identity, params) => tokenOutcome(params, _ok({ accepted: true })));
    replace('inspectSetupToken', async (identity, params) => tokenOutcome(params, _ok({ email: 'owner@example.com' })));
    replace('completeSetup', async (identity, params) => tokenOutcome(params, _ok({ setup_complete: true })));
    replace('resetPassword', async (identity, params) => tokenOutcome(params, _ok({ password_reset: true })));
    const addressOutcome = (params) => (params && typeof params.email === 'string' ? _ok({ accepted: true }) : _fail('VALIDATION', { field: 'email' }));
    replace('requestPasswordReset', async (identity, params) => addressOutcome(params));
    replace('requestSetup', async (identity, params) => addressOutcome(params));
    replace('getSetupStatus', async () => _ok({ setup_complete: false }));
};

test.afterEach(() => {
    while (STUBBED.length > 0) {
        const entry = STUBBED.pop();
        authModule[entry.key] = entry.original;
    }
});

/**
 * Re-requires the auth router and the limiter module, so this test's limiters start empty.
 *
 * @returns {Function} A fresh auth router.
 */
const _freshAuthRouter = () => {
    delete require.cache[require.resolve(AUTH_ROUTES)];
    delete require.cache[require.resolve(FLOW_LIMIT)];
    return require(AUTH_ROUTES);
};

/**
 * Starts the real auth router, mounted as src/routes/index.ts mounts it, behind the JSON parser.
 *
 * @param {Object} [options] - `{ trust_proxy, router }`.
 * @returns {Promise<Object>} `{ post, get, close }`.
 */
const _startServer = async (options) => {
    const settings = options || {};
    const app = express();
    if (settings.trust_proxy !== undefined) {
        app.set('trust proxy', settings.trust_proxy);
    }
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/auth', settings.router || _freshAuthRouter());
    const server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const post = async (routePath, body, headers) => {
        const response = await fetch(`${baseUrl}${routePath}`, {
            method: 'POST',
            headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
            body: JSON.stringify(body)
        });
        return { status: response.status, body: await response.json().catch(() => ({})), retry_after: response.headers.get('retry-after') };
    };
    const get = async (routePath) => {
        const response = await fetch(`${baseUrl}${routePath}`);
        return { status: response.status };
    };
    return {
        post,
        get,
        close: () => new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
        })
    };
};


/* ==========================================================================
 *  Wiring — which limiter is on which route
 * ========================================================================== */

test('each public route carries exactly the limiter spec A5 names; GET /setup and login carry none at route level', () => {
    delete require.cache[require.resolve(FLOW_LIMIT)];
    const map = buildRouteMap({ expressModule: express, load: _freshAuthRouter });
    const actual = {};
    for (const route of map.routes) {
        actual[`${route.method} ${route.path}`] = route.route_middleware;
    }
    assert.deepEqual(actual, {
        'POST /login': [],
        'GET /setup': [],
        'POST /setup': ['setupRequestRateLimit'],
        'POST /setup/inspect': ['tokenFlowRateLimit'],
        'POST /setup/complete': ['tokenFlowRateLimit'],
        'POST /invites/inspect': ['tokenFlowRateLimit'],
        'POST /invites/accept': ['tokenFlowRateLimit'],
        'POST /password/forgot': ['passwordForgotRateLimit'],
        'POST /password/reset': ['tokenFlowRateLimit']
    }, 'Login keeps its app-level loginRateLimit (mounted in app.ts before the body parser); every other public POST has its own budget.');
    assert.deepEqual(map.routes.filter((route) => route.guards.length > 0).map((route) => route.path), [], 'The auth router carries no router-level middleware.');
});

test('the three limiters are built from AUTH_PUBLIC_FLOW_RATE_LIMIT_* and are three separate functions', () => {
    const config = require(path.join(SRC, 'config'));
    assert.equal(config.AUTH.PUBLIC_FLOW_RATE_LIMIT_MAX, MAX);
    const flow = require(FLOW_LIMIT);
    const instances = [flow.tokenFlowRateLimit, flow.passwordForgotRateLimit, flow.setupRequestRateLimit];
    assert.equal(new Set(instances).size, 3);
    assert.deepEqual(instances.map((fn) => fn.name), ['tokenFlowRateLimit', 'passwordForgotRateLimit', 'setupRequestRateLimit']);
});


/* ==========================================================================
 *  Token flows — the key is the token, not the address
 * ========================================================================== */

test('on ONE address, ten people with ten links can each inspect and accept — even after a guesser spent their own budget', async () => {
    const legit = Array.from({ length: 10 }, _token);
    _stubServices(new Set(legit));
    const server = await _startServer();
    try {
        // A guesser on the same address burns through the budget of the link they are guessing at.
        const guessed = _token();
        for (let attempt = 0; attempt < MAX; attempt += 1) {
            const dead = await server.post('/api/auth/invites/accept', { token: guessed, name: 'X', password: 'plum tractor velvet' });
            assert.equal(dead.status, 400);
            assert.equal(dead.body.error.code, 'TOKEN_INVALID');
        }
        const refused = await server.post('/api/auth/invites/accept', { token: guessed, name: 'X', password: 'plum tractor velvet' });
        assert.equal(refused.status, TOO_MANY, 'The dead link\'s own budget must run out.');
        assert.ok(Number(refused.retry_after) > 0);
        assert.equal(refused.body.error.code, 'RATE_LIMITED');

        // Every colleague, same address, is unaffected.
        for (const token of legit) {
            const inspect = await server.post('/api/auth/invites/inspect', { token: token });
            const accept = await server.post('/api/auth/invites/accept', { token: token, name: 'Colleague', password: 'plum tractor velvet' });
            assert.equal(inspect.status, 200, 'A colleague\'s inspect was refused because of someone else\'s attempts.');
            assert.equal(accept.status, 201, 'A colleague\'s accept was refused because of someone else\'s attempts.');
        }
    } finally {
        await server.close();
    }
});

test('only a MARKED dead-link 400 is charged: a password-policy 400 and TOKEN_USED are refunded', async () => {
    const live = _token();
    _stubServices(new Set([live]));
    const server = await _startServer();
    try {
        for (let attempt = 0; attempt < MAX * 4; attempt += 1) {
            const weak = await server.post('/api/auth/invites/accept', { token: live, name: 'X', password: 'short' });
            assert.equal(weak.status, 400, `attempt ${attempt}: a policy refusal must never become a 429 — the link holder is just choosing a password.`);
            assert.equal(weak.body.error.code, 'PASSWORD_POLICY');
        }
        const used = `USED${_token().slice(4)}`;
        for (let attempt = 0; attempt < MAX * 3; attempt += 1) {
            assert.equal((await server.post('/api/auth/password/reset', { token: used, password: 'plum tractor velvet' })).status, 400);
        }
        const finallyAccepted = await server.post('/api/auth/invites/accept', { token: live, name: 'X', password: 'plum tractor velvet' });
        assert.equal(finallyAccepted.status, 201);
    } finally {
        await server.close();
    }
});

test('changing X-Forwarded-For never changes a token-flow key — even with trust proxy on', async () => {
    const flow = require(FLOW_LIMIT);
    const token = _token();
    const base = { body: { token: token }, ip: '10.0.0.1', headers: {} };
    const forged = { body: { token: token }, ip: '198.51.100.7', headers: { 'x-forwarded-for': '198.51.100.7' } };
    assert.equal(flow.tokenFlowKey(base), flow.tokenFlowKey(forged));
    assert.equal(flow.tokenFlowKey(base), authModule.hashToken(token), 'The key is the token\'s hash — never the raw token.');
    for (const malformed of [{ body: {} }, { body: { token: 'short' } }, { body: [] }, { body: null }, { body: { token: { $ne: 1 } } }]) {
        assert.equal(flow.tokenFlowKey(malformed), flow.MALFORMED_TOKEN_KEY);
    }

    _stubServices(new Set());
    const server = await _startServer({ trust_proxy: true });
    try {
        for (let attempt = 0; attempt < MAX; attempt += 1) {
            await server.post('/api/auth/setup/inspect', { token: token }, { 'x-forwarded-for': `203.0.113.${attempt + 1}` });
        }
        const rotated = await server.post('/api/auth/setup/inspect', { token: token }, { 'x-forwarded-for': '203.0.113.200' });
        assert.equal(rotated.status, TOO_MANY, 'A new X-Forwarded-For bought a fresh budget for the same link.');
    } finally {
        await server.close();
    }
});

test('a spent DEPLOYMENT-wide token budget still admits one request per trickle interval', async () => {
    const flow = require(FLOW_LIMIT);
    // A full second of trickle: the five spends and the refused request below must all land inside
    // it, and a slow CI runner should not be what decides that.
    const limiter = flow.createTokenFlowRateLimiter({ max: 1, window_ms: 60 * 1000, trickle_ms: 1000 });
    const controller = require(path.join(SRC, 'controllers', 'auth.controller.ts'));
    const router = express.Router();
    router.post('/invites/inspect', limiter, controller._inspectAuthInvite);
    _stubServices(new Set());
    const server = await _startServer({ router: router });
    try {
        // Global budget = 5 × max. Five distinct dead links spend it.
        for (let index = 0; index < 5; index += 1) {
            assert.equal((await server.post('/api/auth/invites/inspect', { token: _token() })).status, 400);
        }
        const blocked = await server.post('/api/auth/invites/inspect', { token: _token() });
        assert.equal(blocked.status, TOO_MANY, 'The deployment-wide budget is spent, so even a brand-new link is refused.');

        await new Promise((resolve) => setTimeout(resolve, 1100));
        const trickled = await server.post('/api/auth/invites/inspect', { token: _token() });
        assert.notEqual(trickled.status, TOO_MANY, 'After the trickle interval, one request must get through.');
        const next = await server.post('/api/auth/invites/inspect', { token: _token() });
        assert.equal(next.status, TOO_MANY, 'The trickle is one request per interval, not an opening.');
    } finally {
        await server.close();
    }
});


/* ==========================================================================
 *  Address flows — isolated from each other and from the token flows
 * ========================================================================== */

test('spending the forgot-password budget never 429s /invites/accept, POST /setup, or the token flows', async () => {
    const live = _token();
    _stubServices(new Set([live]));
    const server = await _startServer();
    try {
        for (let attempt = 0; attempt < MAX; attempt += 1) {
            assert.equal((await server.post('/api/auth/password/forgot', { email: `a${attempt}@example.com` })).status, 202);
        }
        const spent = await server.post('/api/auth/password/forgot', { email: 'another@example.com' });
        assert.equal(spent.status, TOO_MANY, 'The forgot budget is per address and counts every accepted request.');

        assert.equal((await server.post('/api/auth/invites/accept', { token: live, name: 'X', password: 'plum tractor velvet' })).status, 201);
        assert.equal((await server.post('/api/auth/setup', { email: 'owner@example.com', name: 'Owner' })).status, 202);
        assert.equal((await server.post('/api/auth/password/reset', { token: live, password: 'plum tractor velvet' })).status, 200);
        assert.equal((await server.get('/api/auth/setup')).status, 200, 'GET /setup has no limiter at all.');

        // And the reverse: spending setup's budget does not touch forgot's (already spent) or the token flows.
        await server.post('/api/auth/setup', { email: 'owner@example.com', name: 'Owner' });
        assert.equal((await server.post('/api/auth/setup', { email: 'owner@example.com', name: 'Owner' })).status, TOO_MANY);
        assert.equal((await server.post('/api/auth/invites/inspect', { token: live })).status, 200);
    } finally {
        await server.close();
    }
});

test('a shape-rejected forgot or setup request (400) is refunded — a broken client cannot spend the budget', async () => {
    _stubServices(new Set());
    const server = await _startServer();
    try {
        for (let attempt = 0; attempt < MAX * 4; attempt += 1) {
            assert.equal((await server.post('/api/auth/password/forgot', {})).status, 400);
            assert.equal((await server.post('/api/auth/setup', {})).status, 400);
        }
        assert.equal((await server.post('/api/auth/password/forgot', { email: 'real@example.com' })).status, 202);
        assert.equal((await server.post('/api/auth/setup', { email: 'owner@example.com', name: 'Owner' })).status, 202);
    } finally {
        await server.close();
    }
});
