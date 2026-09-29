'use strict';

/**
 * ============================================================================
 *    THE ROUTE GUARD TEST — the most important test in this repository
 * ============================================================================
 *
 *  Asserts that every `/api/*` endpoint is behind `authenticate`, and that the
 *  ONLY endpoints reachable without a token are the ones named in ALLOWLIST.
 *  (WHICH permission each guarded route demands is test/permissionMap.test.js.)
 *
 *  ── The incident this exists to prevent ─────────────────────────────────────
 *  A shape worth recognising: authentication for an entire analytics API resting
 *  on ONE line, at ONE mount point —
 *
 *      router.use('/<section>', someAuthGuard, sectionRouter);
 *
 *  Many route files sat underneath it, and every one of them mounted its
 *  handlers BARE — no guard, no import of a guard, nothing in the file to
 *  suggest a guard existed anywhere. Each file read as correct in isolation.
 *  Lifting those files into a new project, or mounting one on a different
 *  parent, publishes a complete revenue and customer dataset to anonymous
 *  callers. Nothing throws. Nothing logs. The API returns 200 with real data,
 *  and it looks exactly like a working install.
 *
 *  That failure is undetectable by reading the route files, so it is asserted
 *  here instead, two independent ways:
 *
 *    1. STRUCTURALLY — the router tree is walked and each route's middleware
 *       chain is inspected for `authenticate`. This catches a route that is
 *       mounted on the wrong parent, and it catches `authenticate` being moved
 *       BELOW a mount that used to sit under it (a reordering that reads as
 *       cosmetic and is an authentication bypass).
 *
 *    2. BEHAVIOURALLY — the app is started on a real socket and every endpoint
 *       is requested with no Authorization header. A structural pass with a
 *       behavioural failure would mean the guard is wired in but not refusing;
 *       the reverse would mean something else is refusing and the guard could
 *       be removed without the test noticing. Both must hold.
 *
 *  ── The allowlist is the security decision ──────────────────────────────────
 *  Adding an entry to ALLOWLIST publishes an endpoint to the internet. It is
 *  deliberately the only way to make this test pass for an unguarded route, so
 *  that the decision shows up as a diff in a security-critical file rather than
 *  as an absence somewhere nobody looks.
 *
 *  ── Non-vacuity ─────────────────────────────────────────────────────────────
 *  A guard test that would pass over an empty route list is worthless, so the
 *  suite asserts its own preconditions: the map is non-empty, it contains
 *  guarded routes, and every allowlisted route really does answer WITHOUT a
 *  token (proving the probe can tell the two outcomes apart). `buildRouteMap`
 *  additionally throws rather than returning an empty map.
 * ============================================================================
 */

// ── Environment, set BEFORE anything is required ────────────────────────────
// `src/config` snapshots `process.env` at first require, and requiring the
// routes reaches it. Silencing the logger here keeps the test output readable;
// the short buffer timeout stops the public endpoints that DO read (GET
// /healthz, GET /api/auth/setup) from waiting out mongoose's 10s default when
// they query a database this test never connects.
process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const express = require('express');
const mongoose = require('mongoose');

const { buildRouteMap, describeRoute, toConcretePath } = require('./_harness/routeMap');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const ROUTES_ENTRY = path.join(BACKEND_ROOT, 'src', 'routes');
const APP_ENTRY = path.join(BACKEND_ROOT, 'src', 'apps', 'app.ts');

/**
 *  THE ALLOWLIST. Every endpoint reachable without a credential, and nothing else (spec §8).
 *
 * `GET /healthz`      — a readiness probe cannot present a credential, and the endpoint is
 *                       deliberately uninformative: a state and a reason, no app name, no counts,
 *                       no revenue, not even a sync timestamp.
 * `POST /api/auth/login` — where a credential comes from. It cannot require one.
 * `GET|POST /api/auth/setup`, `/setup/inspect`, `/setup/complete` — first-run setup: there is no
 *                       account yet to present. Locked for good (409) once setup completes.
 * `POST /api/auth/invites/inspect|accept` — the invitee has no account until accept succeeds; the
 *                       credential is the 256-bit link token in the body.
 * `POST /api/auth/password/forgot|reset` — the caller has lost the credential by definition.
 *
 * Anything else on this list is a published analytics endpoint. There is no entry that is
 * "obviously fine": a `/whoami`, a `/refresh` and a `/logout` all take a token and therefore belong
 * behind the guard like everything else (logout lives at /api/account/logout, guarded).
 */
const ALLOWLIST = [
    'GET /healthz',
    'POST /api/auth/login',
    'GET /api/auth/setup',
    'POST /api/auth/setup',
    'POST /api/auth/setup/inspect',
    'POST /api/auth/setup/complete',
    'POST /api/auth/invites/inspect',
    'POST /api/auth/invites/accept',
    'POST /api/auth/password/forgot',
    'POST /api/auth/password/reset'
];

/** The middleware whose presence in a chain constitutes "guarded". Matched by function name. */
const GUARD_NAME = 'authenticate';

/** How long mongoose buffers a query before rejecting, while this test holds no connection. */
const TEST_BUFFER_TIMEOUT_MS = 400;

mongoose.set('bufferTimeoutMS', TEST_BUFFER_TIMEOUT_MS);

/**
 * The route map, built once for the whole file.
 *
 * ⚠️ `load` performs the require itself. Requiring `src/routes` before this point would leave the
 * module in `require.cache`, the instrumented require would register nothing, and the map would be
 * empty — a guard test that passes because it examined no routes. `buildRouteMap` throws on an
 * empty map for exactly that reason, but the ordering here is what keeps it from arising.
 */
const ROUTE_MAP = buildRouteMap({
    expressModule: express,
    load: () => require(ROUTES_ENTRY)
});

/**
 * `METHOD /path` for a route record — the form the allowlist is written in.
 *
 * @param {Object} route - A record from the route map.
 * @returns {String} e.g. `GET /api/revenue/now`.
 */
const _signature = (route) => `${route.method} ${route.path}`;

/**
 * True when `authenticate` appears anywhere a request to this route must pass through.
 *
 * Both chains count: guards inherited from a parent mount, and middleware attached to the route
 * itself. This project applies the guard once at the mount, but a per-route guard would be equally
 * effective and refusing to see it would push someone toward deleting the assertion.
 *
 * @param {Object} route - A record from the route map.
 * @returns {Boolean} True when the route is guarded.
 */
const _isGuarded = (route) => {
    return route.guards.includes(GUARD_NAME) || route.route_middleware.includes(GUARD_NAME);
};

/**
 * Starts the application on an ephemeral port, exactly as `src/apps/app.ts` composes it.
 *
 * ⚠️ The real app is built INSIDE `bootstrap().then(…)` and cannot be imported without a database,
 * so this reproduces its two composition lines rather than importing them. The "only one router is
 * mounted" test below is what keeps that reproduction honest: it reads `app.ts` and fails if the
 * entry point ever mounts anything this harness does not.
 *
 * @returns {Promise<{ baseUrl: String, close: Function }>} The server's base URL and a closer.
 */
const _startServer = async () => {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    app.use(ROUTE_MAP.root);

    const server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const { port } = server.address();

    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve) => server.close(resolve))
    };
};

/**
 * Requests a path with NO Authorization header.
 *
 * @param {String} baseUrl - Server base URL.
 * @param {String} method - HTTP method.
 * @param {String} routePath - Path, `:params` already substituted.
 * @returns {Promise<{ status: Number, body: Object }>} Status code and parsed body (`{}` if not JSON).
 */
const _requestAnonymously = async (baseUrl, method, routePath) => {
    const response = await fetch(`${baseUrl}${routePath}`, {
        method: method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' || method === 'HEAD' ? undefined : '{}'
    });
    let body = {};
    try {
        body = await response.json();
    } catch (error) {
        body = {};
    }
    return { status: response.status, body: body };
};


/* ==========================================================================
 *  0. The test's own preconditions
 * ========================================================================== */

test('the route map is populated — this suite is not vacuously passing', () => {
    assert.ok(
        ROUTE_MAP.routes.length >= 5,
        `Only ${ROUTE_MAP.routes.length} routes were discovered. Either the application shrank drastically `
        + 'or the instrumentation stopped recording, in which case every assertion below is meaningless.'
    );
    assert.deepEqual(
        ROUTE_MAP.unanalysable,
        [],
        'A layer was registered with a RegExp or array path, so its absolute path cannot be resolved and '
        + 'the allowlist cannot be applied to it. Register it with a string path.'
    );
    const guardedCount = ROUTE_MAP.routes.filter(_isGuarded).length;
    assert.ok(
        guardedCount > 0,
        'No route anywhere carries authenticate. The guard is either unmounted or renamed, and the '
        + 'structural assertion below would pass over an entirely unauthenticated API.'
    );
});


/* ==========================================================================
 *  1. STRUCTURAL — the guard is in the chain
 * ========================================================================== */

test(' every /api/* route is behind authenticate', () => {
    const unguarded = ROUTE_MAP.routes
        .filter((route) => route.path.startsWith('/api'))
        .filter((route) => !ALLOWLIST.includes(_signature(route)))
        .filter((route) => !_isGuarded(route));

    assert.deepEqual(
        unguarded.map(describeRoute),
        [],
        'UNAUTHENTICATED ANALYTICS ENDPOINT(S). Each route above is reachable by anyone who can reach '
        + 'the port. Mount it on the guarded sub-router in src/routes/index.ts. Do NOT add it to '
        + 'ALLOWLIST unless publishing it is the actual intent.'
    );
});

test(' the set of unguarded routes is EXACTLY the allowlist', () => {
    const actuallyOpen = ROUTE_MAP.routes.filter((route) => !_isGuarded(route)).map(_signature).sort();

    assert.deepEqual(
        actuallyOpen,
        ALLOWLIST.slice().sort(),
        'The public surface changed. Anything that appeared is now served to anonymous callers — '
        + 'including routes outside /api, which the previous test does not cover. Anything that '
        + 'disappeared means ALLOWLIST names a route that no longer exists, and a stale allowlist '
        + 'entry is how a future route silently inherits an exemption it was never reviewed for.'
    );
});

test('authenticate is the FIRST layer of the guarded sub-router, not a later one', () => {
    // Express runs layers in registration order, so a guard registered after a mount does not
    // protect it. Every guarded route must therefore see authenticate at the head of its chain: if
    // some other middleware precedes it, that middleware can respond first — and if authenticate
    // slid below a mount, the route stops being guarded at all and the tests above catch it.
    const misordered = ROUTE_MAP.routes
        .filter(_isGuarded)
        .filter((route) => route.guards[0] !== GUARD_NAME);

    assert.deepEqual(
        misordered.map(describeRoute),
        [],
        'A middleware runs BEFORE authenticate on the routes above. Anything ahead of the guard sees '
        + 'unauthenticated requests and can answer them.'
    );
});


/* ==========================================================================
 *  2. BEHAVIOURAL — the guard actually refuses
 * ========================================================================== */

test(' every guarded route answers 401 to a request with no token', async () => {
    const server = await _startServer();
    const failures = [];

    try {
        for (const route of ROUTE_MAP.routes) {
            if (ALLOWLIST.includes(_signature(route))) {
                continue;
            }
            const concrete = toConcretePath(route.path);
            const { status, body } = await _requestAnonymously(server.baseUrl, route.method, concrete);

            if (status !== 401) {
                failures.push(`${route.method} ${concrete} answered ${status}, expected 401`);
                continue;
            }
            if (body.status !== false) {
                failures.push(`${route.method} ${concrete} returned 401 without the { status: false } envelope`);
                continue;
            }
            // The handler must not have run at all. Every controller here answers with a payload;
            // the guard answers with an empty `data` and an authentication message. An empty data
            // object alone would be weak evidence, so the message is checked too — only
            // `unauthorizedResponse` called from authenticate produces this pair.
            const reachedHandler = Object.keys(body.data || {}).length > 0;
            if (reachedHandler) {
                failures.push(`${route.method} ${concrete} returned 401 but carried handler data — the handler ran`);
            }
            if (!/not authenticated/i.test(String(body.msg))) {
                failures.push(`${route.method} ${concrete} returned 401 with an unexpected message: ${body.msg}`);
            }
        }
    } finally {
        await server.close();
    }

    assert.deepEqual(failures, [], 'An anonymous request reached past the guard:');
});

test('the allowlisted routes really are reachable without a token', async () => {
    // The counterweight to the test above. If every path in the application answered 401 — because
    // the app failed to build, or a catch-all guard swallowed everything — the guard assertions
    // would pass while proving nothing. None of these may be 401.
    const server = await _startServer();
    const results = [];

    try {
        for (const signature of ALLOWLIST) {
            const [method, routePath] = signature.split(' ');
            const { status } = await _requestAnonymously(server.baseUrl, method, routePath);
            results.push({ signature, status });
        }
    } finally {
        await server.close();
    }

    for (const result of results) {
        assert.notEqual(
            result.status,
            401,
            `${result.signature} is in ALLOWLIST but answered 401. Either it is in fact guarded — in which `
            + 'case remove it from ALLOWLIST — or the whole app is refusing everything and the guard '
            + 'assertions in this file are vacuous.'
        );
    }
});

test('every public POST answers a {} body with 400, never touches the database, and is never cached', async () => {
    // Spec §8: a public endpoint validates SHAPE before it reads anything. An anonymous probe with an
    // empty body therefore costs no query — and a public token endpoint never answers 401, because
    // the dashboard signs out on a 401.
    //
    // "No database" is observed, not inferred from timing: with no connection, mongoose BUFFERS every
    // operation and announces it with a 'buffer' event on the connection. Any event during the probe
    // is a query issued before the shape check.
    const buffered = [];
    const _onBuffer = (event) => buffered.push(`${event.collectionName}.${event.method}`);
    mongoose.connection.on('buffer', _onBuffer);

    const server = await _startServer();
    const failures = [];
    try {
        for (const signature of ALLOWLIST) {
            const [method, routePath] = signature.split(' ');
            if (method !== 'POST') {
                continue;
            }
            buffered.length = 0;
            const response = await fetch(`${server.baseUrl}${routePath}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{}'
            });
            let body = {};
            try {
                body = await response.json();
            } catch (error) {
                body = {};
            }
            if (response.status !== 400) {
                failures.push(`${signature} answered ${response.status} to {}, expected 400`);
            }
            if (body.status !== false) {
                failures.push(`${signature} answered {} without the { status: false } envelope`);
            }
            if (buffered.length > 0) {
                failures.push(`${signature} queried the database before validating its body: ${buffered.join(', ')}`);
            }
            if (routePath !== '/api/auth/login' && !/no-store/.test(String(response.headers.get('cache-control')))) {
                failures.push(`${signature} did not send Cache-Control: no-store`);
            }
        }

        // Non-vacuity: the detector must SEE a query when one happens. GET /api/auth/setup reads the
        // install document, so it must buffer at least one operation — if it does not, the 'buffer'
        // event is not firing and the "no database" assertions above prove nothing.
        buffered.length = 0;
        await _requestAnonymously(server.baseUrl, 'GET', '/api/auth/setup');
        assert.ok(buffered.length > 0, 'GET /api/auth/setup buffered no query, so the no-database detector is blind.');
    } finally {
        mongoose.connection.off('buffer', _onBuffer);
        await server.close();
    }

    assert.deepEqual(failures, [], 'A public endpoint does work before it validates its input:');
});

test('an unknown path under the public /api/auth prefix fails CLOSED with 401', async () => {
    // /api/auth is mounted BEFORE the guarded /api router, so anything the auth router does not
    // handle falls through to the guard rather than to a 404. That is the correct direction to be
    // wrong in: an unrecognised path under a public prefix ends up demanding a token instead of
    // skipping one. A 404 here would mean the ordering was inverted.
    const server = await _startServer();

    try {
        const invented = await _requestAnonymously(server.baseUrl, 'GET', '/api/auth/whoami');
        assert.equal(invented.status, 401, 'An invented path under /api/auth did not fall through to the guard.');

        const wrongMethod = await _requestAnonymously(server.baseUrl, 'GET', '/api/auth/login');
        assert.equal(wrongMethod.status, 401, 'GET on the login route did not fall through to the guard.');
    } finally {
        await server.close();
    }
});


/* ==========================================================================
 *  3. THE MOUNT — src/routes is the only security seam
 * ========================================================================== */

test(' src/apps/app.ts mounts the routes module and nothing else', () => {
    // Everything above walks the router exported by src/routes. That is only the whole application
    // while the entry point mounts nothing else — a second `app.use('/internal', …)` there would be
    // invisible to every assertion in this file.
    //
    // Read from SOURCE because the app is composed inside `bootstrap().then(…)` and importing it
    // would require a database. A text check is weaker than an execution check, and it is the
    // strongest available without turning this suite into an integration test.
    const source = fs.readFileSync(APP_ENTRY, 'utf8');
    const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

    // Only the HEAD of each argument is captured — the identifier or member expression being
    // mounted — which is what identifies WHAT is mounted without depending on its arguments.
    const mounts = [...withoutComments.matchAll(/app\.use\(\s*([A-Za-z_$][\w$.]*)/g)].map((match) => match[1]);

    // ── Why the two security mounts are in this list ────────────────────────────────────────
    //
    // This assertion fired when they were added, which is exactly its job, and each was reviewed
    // against ONE question: can it ADMIT a request that `authenticate` would refuse? Neither can.
    //
    //   securityHeaders  — helmet. Sets response headers and always calls next(). It has no
    //                      res.send/res.status path at all, so it cannot answer a request, only
    //                      decorate the answer something else gives.
    //   LOGIN_RATE_LIMIT_PATH — the head captured here is the PATH argument of
    //                      `app.use(LOGIN_RATE_LIMIT_PATH, loginBodyParser, loginRateLimit)`. That
    //                      path is '/api/auth/login', which is already an entry in
    //                      ALLOWLIST above — this mount narrows an endpoint that is public by
    //                      design; it does not publish a new one. `loginBodyParser` is
    //                      `express.json` at 8 KB: it calls next() or fails the request into the
    //                      terminal error handler (4xx). `loginRateLimit` calls next() or refuses
    //                      with 429. Neither can write a success, so neither can widen the
    //                      authenticated surface. Because only the HEAD is captured, the test
    //                      below pins this mount's FULL argument list separately.
    //   terminalErrorHandler — a FOUR-ARGUMENT error handler, which Express reaches only when
    //                      something already threw, and only from BELOW the router. It never calls
    //                      next(), never writes a 2xx, and the only bodies it can produce are
    //                      `{ status: false }` with a 4xx or 5xx. A middleware that can exclusively
    //                      FAIL a request cannot admit one. Its own suite is test/errorEnvelope.test.js,
    //                      which asserts both the redaction and that it stays mounted LAST.
    //
    // ⚠️ That reasoning is the bar for editing this array. Adding a mount that can WRITE a
    // successful response, or one mounted on a path not in ALLOWLIST, puts an unexamined endpoint on
    // the internet — this suite examines only the router exported by src/routes. If you cannot argue
    // the "cannot admit" property for a new entry, it belongs under src/routes instead, behind the
    // guard, where the rest of this file already covers it.
    assert.deepEqual(
        mounts,
        ['securityHeaders', 'LOGIN_RATE_LIMIT_PATH', 'express.json', 'routes', 'terminalErrorHandler'],
        'src/apps/app.ts changed what it mounts. Every assertion in this file examines the router '
        + 'exported by src/routes; anything else mounted on the app is unexamined and may be '
        + 'unauthenticated. Move it under src/routes, or extend this suite to cover it — and read '
        + 'the "cannot admit" note above before editing this array.'
    );

    // The head capture above cannot see a middleware added as a LATER argument of a mount, so the
    // one multi-argument mount is pinned whole.
    const loginMounts = [...withoutComments.matchAll(/app\.use\(\s*LOGIN_RATE_LIMIT_PATH\s*,([^)]*)\)/g)]
        .map((match) => match[1].split(',').map((arg) => arg.trim()).filter(Boolean));
    assert.deepEqual(
        loginMounts,
        [['loginBodyParser', 'loginRateLimit']],
        'The login-path mount in src/apps/app.ts changed its middleware list. Each entry must satisfy '
        + 'the "cannot admit" note above; update this list only after making that argument.'
    );
});
