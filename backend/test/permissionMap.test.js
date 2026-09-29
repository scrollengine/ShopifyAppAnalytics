'use strict';

/**
 * ============================================================================
 *  THE PERMISSION MAP — which key every guarded route demands (spec §4, §15)
 * ============================================================================
 *
 *  test/routeGuard.test.js proves every /api route is behind `authenticate`
 *  ("who is this"). This file proves the second half: every guarded route
 *  declares exactly ONE policy ("may they do THIS"), in the one place a reader
 *  looks for it, and that policy is the one the spec's table names.
 *
 *  ── Why a pinned table and not "every route has SOME policy" ───────────────
 *  The failure this exists to catch is not a missing policy — `authenticate`
 *  alone would still refuse strangers — it is the WRONG key: a store roster
 *  behind `analytics:read`, which is the key the spec promises carries "no
 *  store names". Every route would still be "guarded", every test that only
 *  counts policies would pass, and a Viewer-minus-merchants role would read
 *  every store name. So the table below is written out route by route, and
 *  changing a route's key is a diff in this file that a reviewer sees.
 *
 *  ── Structural AND behavioural, as in routeGuard ───────────────────────────
 *  T1–T7 read the route map (the policy's tag, recorded per method by the
 *  harness). T8 starts the real router, mints real session tokens, stubs ONLY
 *  the principal loader, and proves the tag is not decoration: no permission ⇒
 *  403, every key but K ⇒ 403, K ⇒ neither 401 nor 403. T9 checks the
 *  catalogue and the built-in roles themselves.
 * ============================================================================
 */

// ── Environment, set BEFORE anything is required (spec A20) ─────────────────
// `src/config` snapshots process.env at first require; the token minted below
// must be signed with the key the guard derives from this secret.
process.env.LOG_LEVEL = 'silent';
process.env.JWT_SECRET = 'x'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

// Handlers reached in T8 run against a database this file never connects. Fail fast.
mongoose.set('bufferTimeoutMS', 400);

const { buildRouteMap, describeRoute, toConcretePath } = require('./_harness/routeMap');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(BACKEND_ROOT, 'src');

// The middleware and the barrel are required BEFORE the route map is built. That is safe: neither
// registers a route, and they are the same module instances the route files will require, so the
// policy tags read below are the tags the routes were built with.
const requirePermissionMiddleware = require(path.join(SRC_ROOT, 'middlewares', 'requirePermission.ts'));
const authModule = require(path.join(SRC_ROOT, 'modules', 'auth'));
const authConstants = require(path.join(SRC_ROOT, 'modules', 'auth', 'constants', 'auth.constants.ts'));
const permissionsConstants = require(path.join(SRC_ROOT, 'modules', 'auth', 'constants', 'permissions.constants.ts'));
const rolesConstants = require(path.join(SRC_ROOT, 'modules', 'auth', 'constants', 'roles.constants.ts'));
const sessionService = require(path.join(SRC_ROOT, 'modules', 'auth', 'services', 'session.service.ts'));

const { readPolicyTag, SELF_POLICY_TAG } = requirePermissionMiddleware;
const { PERMISSIONS, PERMISSION_CATALOGUE, ALL_PERMISSION_KEYS, OWNER_ONLY_PERMISSIONS } = permissionsConstants;
const { BUILT_IN_ROLES, ASSIGNABLE_BUILT_IN_ROLE_KEYS } = rolesConstants;
const { JWT_AUDIENCE } = authConstants;

const ROUTE_MAP = buildRouteMap({
    expressModule: express,
    load: () => require(path.join(SRC_ROOT, 'routes')),
    readTag: readPolicyTag
});

/** The guard's function name (routeGuard.test.js asserts the same constant). */
const GUARD_NAME = 'authenticate';

/** The route-level policy middleware names. The harness records names; the tag is what counts. */
const POLICY_NAMES = ['requirePermission', 'requireSelf'];

/**
 *  THE TABLE (spec §4 + A16). One line per guarded route. Changing a key here is a
 * security decision about who can read what — argue it in review, not in a commit message.
 */
const EXPECTED_POLICY = Object.freeze({
    // apps:read — the app list every page hangs off
    'GET /api/partner-apps': PERMISSIONS.APPS_READ,
    'GET /api/partner-apps/:partner_app_id': PERMISSIONS.APPS_READ,
    'GET /api/meta/coverage': PERMISSIONS.APPS_READ,
    // analytics:read — counts and rates, no money, no store names
    'GET /api/funnel': PERMISSIONS.ANALYTICS_READ,
    'GET /api/funnel/traffic-source': PERMISSIONS.ANALYTICS_READ,
    'GET /api/funnel/geo': PERMISSIONS.ANALYTICS_READ,
    'GET /api/conversion/custom-funnel': PERMISSIONS.ANALYTICS_READ,
    'GET /api/conversion/funnel': PERMISSIONS.ANALYTICS_READ,
    'GET /api/conversion/cohort-retention': PERMISSIONS.ANALYTICS_READ,
    'GET /api/conversion/time-to-paid': PERMISSIONS.ANALYTICS_READ,
    'GET /api/conversion/trial-trend': PERMISSIONS.ANALYTICS_READ,
    // financials:read — money aggregates, no store names
    'GET /api/partner-apps/:partner_app_id/kpi': PERMISSIONS.FINANCIALS_READ,
    'GET /api/conversion/plan-mix': PERMISSIONS.FINANCIALS_READ,
    'GET /api/stores/countries': PERMISSIONS.FINANCIALS_READ,
    // merchants:read — anything that names a store
    'GET /api/partner-apps/:partner_app_id/events': PERMISSIONS.MERCHANTS_READ,
    'GET /api/revenue/now': PERMISSIONS.MERCHANTS_READ,
    'GET /api/revenue/overview': PERMISSIONS.MERCHANTS_READ,
    'POST /api/revenue/shop-plans': PERMISSIONS.MERCHANTS_READ,
    'GET /api/funnel/install-cohort': PERMISSIONS.MERCHANTS_READ,
    'GET /api/conversion/trial-outcomes': PERMISSIONS.MERCHANTS_READ,
    'GET /api/conversion/logo-churn': PERMISSIONS.MERCHANTS_READ,
    'GET /api/conversion/revenue-churn': PERMISSIONS.MERCHANTS_READ,
    'GET /api/stores': PERMISSIONS.MERCHANTS_READ,
    'GET /api/stores/detail': PERMISSIONS.MERCHANTS_READ,
    'GET /api/subscriptions': PERMISSIONS.MERCHANTS_READ,
    // apps:manage
    'POST /api/partner-apps': PERMISSIONS.APPS_MANAGE,
    'PATCH /api/partner-apps/:partner_app_id': PERMISSIONS.APPS_MANAGE,
    'DELETE /api/partner-apps/:partner_app_id': PERMISSIONS.APPS_MANAGE,
    // sync:read
    'GET /api/sync/jobs': PERMISSIONS.SYNC_READ,
    'GET /api/sync/jobs/:job_id': PERMISSIONS.SYNC_READ,
    'GET /api/sync/health': PERMISSIONS.SYNC_READ,
    // sync:run
    'POST /api/sync/partner': PERMISSIONS.SYNC_RUN,
    'POST /api/sync/dummy': PERMISSIONS.SYNC_RUN,
    'POST /api/sync/jobs/:job_id/cancel': PERMISSIONS.SYNC_RUN,
    // sync:run_billed — BigQuery bills the operator's GCP project
    'POST /api/sync/bigquery': PERMISSIONS.SYNC_RUN_BILLED,
    'POST /api/sync/install-attribution': PERMISSIONS.SYNC_RUN_BILLED,
    // users:read
    'GET /api/users': PERMISSIONS.USERS_READ,
    'GET /api/invites': PERMISSIONS.USERS_READ,
    'GET /api/roles': PERMISSIONS.USERS_READ,
    // users:manage
    'POST /api/invites': PERMISSIONS.USERS_MANAGE,
    'POST /api/invites/:invite_id/resend': PERMISSIONS.USERS_MANAGE,
    'POST /api/invites/:invite_id/revoke': PERMISSIONS.USERS_MANAGE,
    'PATCH /api/users/:user_id/role': PERMISSIONS.USERS_MANAGE,
    'POST /api/users/:user_id/disable': PERMISSIONS.USERS_MANAGE,
    'POST /api/users/:user_id/enable': PERMISSIONS.USERS_MANAGE,
    'POST /api/users/:user_id/sessions/revoke': PERMISSIONS.USERS_MANAGE,
    'POST /api/users/:user_id/password-reset': PERMISSIONS.USERS_MANAGE,
    // roles:manage — owner only; never grantable
    'POST /api/roles': PERMISSIONS.ROLES_MANAGE,
    'PATCH /api/roles/:role_id': PERMISSIONS.ROLES_MANAGE,
    'DELETE /api/roles/:role_id': PERMISSIONS.ROLES_MANAGE,
    // audit:read
    'GET /api/audit-events': PERMISSIONS.AUDIT_READ,
    // @self — any signed-in, active user, on their own account
    'GET /api/account': SELF_POLICY_TAG,
    'PATCH /api/account': SELF_POLICY_TAG,
    'POST /api/account/password': SELF_POLICY_TAG,
    'POST /api/account/logout': SELF_POLICY_TAG,
    'POST /api/account/sessions/revoke-others': SELF_POLICY_TAG
});

/** The @self routes (spec §4 @self row + A16 revoke-others). */
const SELF_SERVICE = Object.freeze([
    'GET /api/account',
    'PATCH /api/account',
    'POST /api/account/password',
    'POST /api/account/logout',
    'POST /api/account/sessions/revoke-others'
]);

/**
 * The one mutating route allowed a `:read` key: a read whose filter is too large for a query string,
 * sent as a POST body. Anything else that writes and demands only a read key lets a read-only role
 * change state.
 */
const READ_OVER_POST = Object.freeze(['POST /api/revenue/shop-plans']);

const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** `METHOD /path` for a route record. */
const _signature = (route) => `${route.method} ${route.path}`;

/** True when `authenticate` is anywhere in the route's chain. */
const _isGuarded = (route) => route.guards.includes(GUARD_NAME) || route.route_middleware.includes(GUARD_NAME);

const GUARDED_ROUTES = ROUTE_MAP.routes.filter(_isGuarded);
const PUBLIC_ROUTES = ROUTE_MAP.routes.filter((route) => !_isGuarded(route));

/** The route's policy tags (route-level only), non-null. */
const _policyTags = (route) => route.route_tags.filter((tag) => tag !== null);


/* ==========================================================================
 *  0. Preconditions — this suite is not vacuous
 * ========================================================================== */

test('the route map is populated, fully analysable, and the harness reads policy tags', () => {
    assert.ok(GUARDED_ROUTES.length >= 50, `Only ${GUARDED_ROUTES.length} guarded routes were found.`);
    assert.deepEqual(ROUTE_MAP.unanalysable, [], 'A route the harness cannot read (RegExp path or .all()) has no checkable policy.');
    const tagged = GUARDED_ROUTES.filter((route) => _policyTags(route).length > 0);
    assert.ok(tagged.length > 0, 'No route carries a readable policy tag — readTag is not wired, and every assertion below is vacuous.');

    // The tag reader itself: a policy reads back its key, a stranger reads back null.
    assert.equal(readPolicyTag(requirePermissionMiddleware.requirePermission(PERMISSIONS.SYNC_RUN)), PERMISSIONS.SYNC_RUN);
    assert.equal(readPolicyTag(requirePermissionMiddleware.requireSelf()), SELF_POLICY_TAG);
    assert.equal(readPolicyTag(function requirePermission() {}), null, 'A same-NAMED function must not read as a policy — the tag is private.');
    assert.equal(readPolicyTag(undefined), null);
});

test('an unknown permission key throws when the route file loads, never at request time', () => {
    assert.throws(() => requirePermissionMiddleware.requirePermission('merchants:reed'), /not a permission catalogue key/);
    assert.throws(() => requirePermissionMiddleware.requirePermission(''), /not a permission catalogue key/);
    assert.throws(() => requirePermissionMiddleware.requirePermission(SELF_POLICY_TAG), /not a permission catalogue key/);
});


/* ==========================================================================
 *  T1–T7. Structural
 * ========================================================================== */

test('T1 every guarded route declares EXACTLY one policy, at route level', () => {
    const offenders = GUARDED_ROUTES
        .filter((route) => _policyTags(route).length !== 1)
        .map((route) => `${describeRoute(route)}  (policies: ${_policyTags(route).length})`);
    assert.deepEqual(offenders, [], 'Each guarded route needs one requirePermission(...) or requireSelf() beside its handler:');
});

test('T2 the policy is the FIRST route-level middleware — nothing runs before it', () => {
    const offenders = GUARDED_ROUTES
        .filter((route) => route.route_tags[0] === null || route.route_tags[0] === undefined || !POLICY_NAMES.includes(route.route_middleware[0]))
        .map(describeRoute);
    assert.deepEqual(offenders, [], 'A middleware ahead of the policy sees requests the policy would refuse:');
});

test('T3 the inherited guard chain is exactly [authenticate] — no router-level policy anywhere', () => {
    const offenders = GUARDED_ROUTES
        .filter((route) => route.guards.length !== 1 || route.guards[0] !== GUARD_NAME)
        .map(describeRoute);
    assert.deepEqual(offenders, [], 'Guarded routes must inherit authenticate and nothing else:');

    // `router.use(requirePermission(...))` is forbidden (spec §8): it covers every route registered
    // after it in the file, including one added later that needed a DIFFERENT key.
    const routerLevelPolicies = ROUTE_MAP.routes
        .filter((route) => route.guard_tags.some((tag) => tag !== null))
        .map(describeRoute);
    assert.deepEqual(routerLevelPolicies, [], 'A permission policy is mounted with .use() — declare it per route instead:');

    // And the public routes carry no policy at all: a policy on a route with no auth context can
    // only ever answer 401, which would be a public route that is in fact dead.
    const publicWithPolicy = PUBLIC_ROUTES.filter((route) => _policyTags(route).length > 0).map(describeRoute);
    assert.deepEqual(publicWithPolicy, [], 'A public route carries a permission policy:');
});

test('T4 every guarded route demands exactly the key the spec table names — both directions', () => {
    const actual = {};
    for (const route of GUARDED_ROUTES) {
        actual[_signature(route)] = _policyTags(route)[0] || null;
    }
    const mismatched = [];
    for (const [signature, expected] of Object.entries(EXPECTED_POLICY)) {
        if (!(signature in actual)) {
            mismatched.push(`${signature}: in the table but not served`);
        } else if (actual[signature] !== expected) {
            mismatched.push(`${signature}: demands ${actual[signature]}, the table says ${expected}`);
        }
    }
    for (const signature of Object.keys(actual)) {
        if (!(signature in EXPECTED_POLICY)) {
            mismatched.push(`${signature}: served with ${actual[signature]}, but not in the table — add it with the key the spec gives it`);
        }
    }
    assert.deepEqual(mismatched, [], 'The route → permission map drifted from spec §4:');
});

test('T5 every tag is a catalogue key or @self, and every catalogue key guards at least one route', () => {
    const allowed = new Set([...ALL_PERMISSION_KEYS, SELF_POLICY_TAG]);
    const strangers = GUARDED_ROUTES
        .filter((route) => !allowed.has(_policyTags(route)[0]))
        .map(describeRoute);
    assert.deepEqual(strangers, []);

    const used = new Set(GUARDED_ROUTES.map((route) => _policyTags(route)[0]));
    const unused = ALL_PERMISSION_KEYS.filter((key) => !used.has(key));
    assert.deepEqual(unused, [], 'A catalogue key guards nothing — the role editor would offer a permission that does nothing.');
});

test('T6 the @self routes are exactly the self-service list', () => {
    const selfRoutes = GUARDED_ROUTES
        .filter((route) => _policyTags(route)[0] === SELF_POLICY_TAG)
        .map(_signature)
        .sort();
    assert.deepEqual(selfRoutes, SELF_SERVICE.slice().sort(), '@self admits ANY signed-in user. Only the caller\'s own account belongs behind it.');
    for (const signature of selfRoutes) {
        assert.ok(signature.includes(' /api/account'), `${signature} is @self outside /api/account.`);
    }
});

test('T7 a mutating verb never demands only a :read key (one documented read-over-POST excepted)', () => {
    const offenders = GUARDED_ROUTES
        .filter((route) => MUTATING_METHODS.includes(route.method))
        .filter((route) => /:read$/.test(String(_policyTags(route)[0])))
        .map(_signature)
        .filter((signature) => !READ_OVER_POST.includes(signature));
    assert.deepEqual(offenders, [], 'A read-only role could change state through these routes:');

    // The exception is real, not stale.
    for (const signature of READ_OVER_POST) {
        assert.equal(EXPECTED_POLICY[signature], PERMISSIONS.MERCHANTS_READ);
    }
});


/* ==========================================================================
 *  T8. Behavioural — the tag is enforced, with real tokens and a stubbed loader
 * ========================================================================== */

const USER_ID = 'a'.repeat(24);
const SESSION_ID = 'b'.repeat(24);

/**
 * A session token exactly as login signs one (spec I4): HS256, sub, sid, aud, exp.
 *
 * @param {Object} [overrides] - Claims to replace; `null` deletes one.
 * @param {Object} [options] - jwt.sign options to replace.
 * @returns {String} A signed JWT.
 */
const _mintToken = (overrides, options) => {
    const claims = Object.assign({ sub: USER_ID, sid: SESSION_ID }, overrides || {});
    for (const key of Object.keys(claims)) {
        if (claims[key] === null) {
            delete claims[key];
        }
    }
    const signOptions = Object.assign({ algorithm: 'HS256', audience: JWT_AUDIENCE, expiresIn: 3600 }, options || {});
    for (const key of Object.keys(signOptions)) {
        if (signOptions[key] === null) {
            delete signOptions[key];
        }
    }
    return jwt.sign(claims, sessionService.sessionSigningKey(), signOptions);
};

/** A principal as `resolvePrincipal` builds one. */
const _principal = (permissions) => ({
    user_id: USER_ID,
    email: 'member@example.com',
    name: 'Member',
    is_owner: false,
    role_key: 'custom',
    role_label: 'Test role',
    custom_role_id: null,
    permissions: Object.freeze(permissions.slice().sort())
});

const REAL_LOAD_PRINCIPAL = authModule.loadPrincipal;
let loaderCalls = 0;

/**
 * Replaces the barrel's `loadPrincipal` (the guard calls it through the barrel OBJECT, spec A9).
 *
 * @param {String[]} permissions - What the stub principal holds.
 * @returns {void}
 */
const _stubLoader = (permissions) => {
    authModule.loadPrincipal = async (identity, params) => {
        loaderCalls += 1;
        return {
            status: true,
            data: { principal: _principal(permissions), session: { session_id: params.session_id, expires_at: new Date(Date.now() + 3600000) } },
            error: {},
            msg: 'ok'
        };
    };
};

const _restoreLoader = () => {
    authModule.loadPrincipal = REAL_LOAD_PRINCIPAL;
};

/** Starts the real router on an ephemeral port (as routeGuard does). */
const _startServer = async () => {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    app.use(ROUTE_MAP.root);
    const server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((resolve) => {
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
            server.close(resolve);
        })
    };
};

/**
 * Requests a route with a bearer token.
 *
 * @returns {Promise<{ status: Number, body: Object }>}
 */
const _request = async (baseUrl, route, token) => {
    const headers = { 'content-type': 'application/json' };
    if (token) {
        headers.authorization = `Bearer ${token}`;
    }
    const response = await fetch(`${baseUrl}${toConcretePath(route.path)}`, {
        method: route.method,
        headers: headers,
        body: route.method === 'GET' || route.method === 'HEAD' ? undefined : '{}'
    });
    let body = {};
    try {
        body = await response.json();
    } catch (error) {
        body = {};
    }
    return { status: response.status, body: body };
};

const CATALOGUE_ROUTES = GUARDED_ROUTES.filter((route) => ALL_PERMISSION_KEYS.includes(_policyTags(route)[0]));
const SELF_ROUTES = GUARDED_ROUTES.filter((route) => _policyTags(route)[0] === SELF_POLICY_TAG);

test('T8a a principal with NO permissions is refused 403 with an empty data object on every catalogue-keyed route', async () => {
    assert.ok(CATALOGUE_ROUTES.length >= 45);
    _stubLoader([]);
    const server = await _startServer();
    const failures = [];
    try {
        const results = await Promise.all(CATALOGUE_ROUTES.map(async (route) => ({ route, result: await _request(server.baseUrl, route, _mintToken()) })));
        for (const { route, result } of results) {
            const key = _policyTags(route)[0];
            if (result.status !== 403) {
                failures.push(`${_signature(route)} answered ${result.status}, expected 403`);
                continue;
            }
            if (Object.keys(result.body.data || {}).length > 0) {
                failures.push(`${_signature(route)} answered 403 carrying handler data`);
            }
            if (!result.body.error || result.body.error.code !== 'FORBIDDEN' || result.body.error.permission !== key) {
                failures.push(`${_signature(route)} 403 body is ${JSON.stringify(result.body.error)}, expected { code: FORBIDDEN, permission: ${key} }`);
            }
        }
    } finally {
        _restoreLoader();
        await server.close();
    }
    assert.deepEqual(failures, []);
});

test('T8b every key EXCEPT K is still refused on a route that demands K', async () => {
    const server = await _startServer();
    const failures = [];
    try {
        for (const route of CATALOGUE_ROUTES) {
            const key = _policyTags(route)[0];
            _stubLoader(ALL_PERMISSION_KEYS.filter((other) => other !== key));
            const result = await _request(server.baseUrl, route, _mintToken());
            if (result.status !== 403 || (result.body.error || {}).permission !== key) {
                failures.push(`${_signature(route)} answered ${result.status} to a principal holding everything but ${key}`);
            }
        }
    } finally {
        _restoreLoader();
        await server.close();
    }
    assert.deepEqual(failures, [], 'Holding other keys admitted a route whose key was missing:');
});

test('T8c holding ONLY K admits the route past both the guard and the policy (neither 401 nor 403)', async () => {
    const server = await _startServer();
    const failures = [];
    try {
        // Sequential, one stub per route. The handler behind the policy then runs against no
        // database and answers whatever it answers (400/404/500/503) — anything but 401 or 403
        // proves the request got past authentication AND authorisation.
        for (const route of CATALOGUE_ROUTES) {
            const key = _policyTags(route)[0];
            _stubLoader([key]);
            const result = await _request(server.baseUrl, route, _mintToken());
            if (result.status === 401 || result.status === 403) {
                failures.push(`${_signature(route)} answered ${result.status} to a principal holding ${key}`);
            }
        }
    } finally {
        _restoreLoader();
        await server.close();
    }
    assert.deepEqual(failures, [], 'The declared key did not admit its own route:');
});

test('T8d @self routes admit a signed-in principal with an EMPTY permission set', async () => {
    assert.equal(SELF_ROUTES.length, SELF_SERVICE.length);
    _stubLoader([]);
    const server = await _startServer();
    const failures = [];
    try {
        for (const route of SELF_ROUTES) {
            const result = await _request(server.baseUrl, route, _mintToken());
            if (result.status === 401 || result.status === 403) {
                failures.push(`${_signature(route)} answered ${result.status} to a signed-in user with no permissions`);
            }
        }
    } finally {
        _restoreLoader();
        await server.close();
    }
    assert.deepEqual(failures, [], 'A user must always be able to reach their own account:');
});

test('T8e a legacy-shaped token (no sid, no aud) and other malformed tokens are 401 and never reach the loader', async () => {
    _stubLoader(ALL_PERMISSION_KEYS);
    loaderCalls = 0;
    const server = await _startServer();
    const route = CATALOGUE_ROUTES.find((candidate) => candidate.method === 'GET');

    // Signed with the RAW secret, exactly as the single-operator build signed its tokens.
    const legacy = jwt.sign({ sub: USER_ID, email: 'operator@example.com' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: 3600 });
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.`
        + `${Buffer.from(JSON.stringify({ sub: USER_ID, sid: SESSION_ID, aud: JWT_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.`;
    const cases = {
        'legacy (sub only, no sid, no aud)': legacy,
        'no sid': _mintToken({ sid: null }),
        'no aud': _mintToken({}, { audience: null }),
        'wrong aud': _mintToken({}, { audience: 'some-other-app' }),
        'sub not 24-hex': _mintToken({ sub: 'operator-1' }),
        'sid not 24-hex': _mintToken({ sid: 'not-an-object-id' }),
        'expired': _mintToken({}, { expiresIn: -10 }),
        'legacy shape under the current key': _mintToken({ sid: null, email: 'operator@example.com' }, { audience: null }),
        'wrong secret': jwt.sign({ sub: USER_ID, sid: SESSION_ID }, 'y'.repeat(32), { algorithm: 'HS256', audience: JWT_AUDIENCE, expiresIn: 3600 }),
        'current shape signed with the RAW secret': jwt.sign({ sub: USER_ID, sid: SESSION_ID }, process.env.JWT_SECRET, { algorithm: 'HS256', audience: JWT_AUDIENCE, expiresIn: 3600 }),
        'HS512': _mintToken({}, { algorithm: 'HS512' }),
        'alg none': unsigned
    };

    const failures = [];
    try {
        for (const [label, token] of Object.entries(cases)) {
            const result = await _request(server.baseUrl, route, token);
            if (result.status !== 401) {
                failures.push(`${label}: answered ${result.status}, expected 401`);
            }
            if (!/not authenticated/i.test(String(result.body.msg))) {
                failures.push(`${label}: the 401 message does not start with "Not authenticated."`);
            }
        }
        // And the control: the same route with a well-formed token IS admitted by the same stub.
        const control = await _request(server.baseUrl, route, _mintToken());
        assert.notEqual(control.status, 401, 'The control token was refused — the cases above prove nothing.');
    } finally {
        _restoreLoader();
        await server.close();
    }
    assert.deepEqual(failures, []);
    assert.equal(loaderCalls, 1, 'A malformed token reached the principal loader — only the control request may.');
});


/* ==========================================================================
 *  T9. The catalogue and the built-in roles
 * ========================================================================== */

test('T9a the catalogue is well-formed: unique keys, PERMISSIONS == catalogue, requires resolve, no cycles', () => {
    const keys = PERMISSION_CATALOGUE.map((entry) => entry.key);
    assert.equal(new Set(keys).size, keys.length, 'Duplicate catalogue key.');
    assert.deepEqual(Object.values(PERMISSIONS).slice().sort(), keys.slice().sort(), 'PERMISSIONS and the catalogue disagree.');
    assert.deepEqual([...ALL_PERMISSION_KEYS], keys);

    const byKey = new Map(PERMISSION_CATALOGUE.map((entry) => [entry.key, entry]));
    for (const entry of PERMISSION_CATALOGUE) {
        assert.ok(entry.label && entry.group && entry.description, `${entry.key} lacks a label, group or description.`);
        for (const required of entry.requires) {
            assert.ok(byKey.has(required), `${entry.key} requires ${required}, which is not in the catalogue.`);
        }
        // Walk the closure; a cycle would loop back to the start.
        const seen = new Set();
        const stack = entry.requires.slice();
        while (stack.length > 0) {
            const next = stack.pop();
            assert.notEqual(next, entry.key, `${entry.key} requires itself through a cycle.`);
            if (!seen.has(next)) {
                seen.add(next);
                stack.push(...byKey.get(next).requires);
            }
        }
        if (entry.key !== PERMISSIONS.APPS_READ) {
            assert.ok(seen.has(PERMISSIONS.APPS_READ), `${entry.key} does not transitively require apps:read (the baseline).`);
        }
    }
    assert.deepEqual([...OWNER_ONLY_PERMISSIONS], [PERMISSIONS.ROLES_MANAGE]);
});

test('T9b built-in roles nest strictly: viewer ⊂ analyst ⊂ admin ⊂ owner, owner holds everything', () => {
    const setOf = (roleKey) => new Set(BUILT_IN_ROLES[roleKey].permissions);
    const strictSubset = (a, b) => a.size < b.size && [...a].every((key) => b.has(key));

    assert.ok(strictSubset(setOf('viewer'), setOf('analyst')), 'viewer ⊄ analyst');
    assert.ok(strictSubset(setOf('analyst'), setOf('admin')), 'analyst ⊄ admin');
    assert.ok(strictSubset(setOf('admin'), setOf('owner')), 'admin ⊄ owner');
    assert.deepEqual([...setOf('owner')].sort(), ALL_PERMISSION_KEYS.slice().sort(), 'The owner must hold every catalogue key.');
    assert.equal(BUILT_IN_ROLES.owner.assignable, false, 'Ownership is only ever created by setup or the CLI.');
    assert.deepEqual([...ASSIGNABLE_BUILT_IN_ROLE_KEYS].sort(), ['admin', 'analyst', 'viewer']);
});

test('T9c every built-in role satisfies its own dependencies, holds the baseline, and no assignable role holds an owner-only key', () => {
    const byKey = new Map(PERMISSION_CATALOGUE.map((entry) => [entry.key, entry]));
    for (const [roleKey, role] of Object.entries(BUILT_IN_ROLES)) {
        const held = new Set(role.permissions);
        assert.ok(held.has(PERMISSIONS.APPS_READ), `${roleKey} lacks apps:read.`);
        for (const key of held) {
            assert.ok(byKey.has(key), `${roleKey} holds ${key}, which is not in the catalogue.`);
            for (const required of byKey.get(key).requires) {
                assert.ok(held.has(required), `${roleKey} holds ${key} without ${required}.`);
            }
        }
        if (role.assignable) {
            for (const ownerOnly of OWNER_ONLY_PERMISSIONS) {
                assert.equal(held.has(ownerOnly), false, `${roleKey} is assignable and holds the owner-only ${ownerOnly}.`);
            }
        }
    }
});
