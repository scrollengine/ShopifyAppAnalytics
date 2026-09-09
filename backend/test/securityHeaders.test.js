'use strict';

/**
 * ============================================================================
 *  SECURITY RESPONSE HEADERS — asserted on real responses off a real socket
 * ============================================================================
 *
 *  Before this suite the entire middleware stack was `app.disable('x-powered-by')`
 *  and a body parser. No `nosniff`, no HSTS, no frame refusal, no CSP — on a
 *  deployment whose dashboard keeps its bearer token in `localStorage`
 *  (`frontend/utils/auth.js`), which is the right trade for an API that must
 *  stay CSRF-immune and is precisely the trade that makes a second line worth
 *  having.
 *
 *  ── Why every assertion here goes over HTTP ─────────────────────────────────
 *  Calling helmet's middleware with a fake `res` proves helmet works, which was
 *  never in doubt. What is in doubt is whether it is MOUNTED, mounted FIRST, and
 *  still mounted after somebody reorders `src/apps/app.ts` — so every header
 *  below is read off a response that came back over a socket, from an app
 *  composed the way the entry point composes it, and from three different
 *  outcomes:
 *
 *    - a 401 from the guard, which is what an unauthenticated prober sees;
 *    - a 200/503 from `/healthz`, the other publicly reachable endpoint;
 *    - a 404 from Express's own final handler, which no route file produces —
 *      the case a per-route or per-router mounting of these headers would miss
 *      entirely, and the reason the middleware belongs at the top of the app.
 *
 *  ── The CSP assertions are about a policy, not a string ─────────────────────
 *  This process serves JSON and nothing else, so its CSP is `default-src 'none'`.
 *  That is only safe while it stays true: the dashboard's HTML, React, Polaris
 *  and Next's inline bootstrap all come from the SEPARATE Next server on its own
 *  origin, and nothing this backend sends governs that document. The assertions
 *  below therefore check the SHAPE of the policy — that it denies by default and
 *  has not been widened toward serving a page — rather than matching a literal,
 *  which would fail on a reordering and pass on a real regression.
 * ============================================================================
 */

// Set BEFORE anything is required: `src/config` snapshots process.env at first
// require, and requiring the routes reaches it.
process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const { before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const express = require('express');
const mongoose = require('mongoose');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const APP_ENTRY = path.join(BACKEND_ROOT, 'src', 'apps', 'app.ts');

const { securityHeaders } = require(path.join(BACKEND_ROOT, 'src', 'middlewares', 'securityHeaders'));
const routes = require(path.join(BACKEND_ROOT, 'src', 'routes'));

/** Keeps the two database-touching public endpoints from waiting out mongoose's 10s default. */
mongoose.set('bufferTimeoutMS', 400);

/**
 * A guarded path, an unguarded one, and one that matches no route at all.
 *
 * `/api/revenue/now` answers 401 without a database because the guard refuses before any handler
 * runs; `/healthz` answers on its own; `/no-such-path` is handled by Express itself.
 */
const PROBES = [
    { label: 'a 401 from the guard', method: 'GET', route_path: '/api/revenue/now' },
    { label: 'the public readiness probe', method: 'GET', route_path: '/healthz' },
    { label: 'a 404 from Express itself', method: 'GET', route_path: '/no-such-path-exists' }
];

/**
 * Starts the app on an ephemeral port, composed the way `src/apps/app.ts` composes it.
 *
 * ⚠️ The real app is built inside `bootstrap().then(…)` and cannot be imported without a database,
 * so this reproduces its layers. The source assertions at the bottom of this file are what keep the
 * reproduction honest.
 *
 * @returns {Promise<{ baseUrl: String, close: Function }>} The base URL and a closer.
 */
const _startServer = async () => {
    const app = express();
    app.disable('x-powered-by');
    app.use(securityHeaders);
    app.use(express.json({ limit: '1mb' }));
    app.use(routes);

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
 * Requests every probe once and returns the responses, headers lower-cased.
 *
 * @returns {Promise<Array<{ label: String, path: String, status: Number, headers: Object }>>} One entry per probe.
 */
const _collectResponses = async () => {
    const server = await _startServer();
    const collected = [];
    try {
        for (const probe of PROBES) {
            const response = await fetch(`${server.baseUrl}${probe.route_path}`, { method: probe.method });
            const headers = {};
            response.headers.forEach((value, key) => {
                headers[key.toLowerCase()] = value;
            });
            collected.push({
                label: probe.label,
                path: probe.route_path,
                status: response.status,
                headers: headers
            });
        }
    } finally {
        await server.close();
    }
    return collected;
};

/**
 * Every probe's response, fetched ONCE for the whole file by the `before` hook below.
 *
 * A hook rather than a top-level `await`: these tests are plain CommonJS so they run under
 * `node --test` with no compile step, and CommonJS has no top-level await. Fetching per test would
 * stand a fresh server up thirteen times to assert thirteen headers off the same three responses.
 */
let RESPONSES = [];

before(async () => {
    RESPONSES = await _collectResponses();
});

/**
 * The probe that Express's own final handler answers.
 *
 *  IT IS NOT LIKE THE OTHERS, and the difference is worth knowing rather than working around.
 * `finalhandler` — the thing Express falls back to when nothing handled a request — writes its
 * own headers over ours on the way out (node_modules/finalhandler/index.js, the two `setHeader`
 * calls at the top of its error path):
 *
 *      res.setHeader('Content-Security-Policy', "default-src 'none'")
 *      res.setHeader('X-Content-Type-Options', 'nosniff')
 *
 * So a 404 keeps `nosniff`, keeps every OTHER header this middleware set — `X-Frame-Options`, HSTS,
 * `Referrer-Policy`, CORP — and comes back with a one-directive CSP instead of the four-directive
 * one. Discovered by this suite rather than assumed: the first version of the CSP test asserted the
 * full policy on all three probes and this is the response that failed.
 *
 * It is not a hole, and the test below proves rather than asserts that: the replacement policy is
 * still deny-everything, and framing is refused by `X-Frame-Options: DENY`, which finalhandler does
 * not touch. It is a fact about the platform, and it belongs written down.
 */
const FINALHANDLER_PROBE_PATH = '/no-such-path-exists';

/**
 * Asserts a header on every probe at once, so a header that only reaches the routed responses —
 * the shape a per-router mount produces — cannot pass.
 *
 * @param {String} headerName - Lower-cased header name.
 * @param {Function} check - Receives the value; returns a string explaining a failure, or null.
 * @param {Array<Object>} [responses] - Which responses to check. Defaults to all of them.
 * @returns {void}
 */
const _assertOnEveryResponse = (headerName, check, responses) => {
    const failures = [];
    for (const response of (responses || RESPONSES)) {
        const value = response.headers[headerName];
        if (typeof value !== 'string') {
            failures.push(`${response.path} (${response.label}, ${response.status}) sent no ${headerName} at all`);
            continue;
        }
        const problem = check(value);
        if (problem) {
            failures.push(`${response.path} (${response.label}): ${headerName}: ${value} — ${problem}`);
        }
    }
    assert.deepEqual(failures, [], `${headerName} is wrong or missing:`);
};

/**
 * The probes whose headers this application actually composes — everything except the one
 * `finalhandler` rewrites. See `FINALHANDLER_PROBE_PATH`.
 *
 * @returns {Array<Object>} The routed responses.
 */
const _routedResponses = () => RESPONSES.filter((response) => response.path !== FINALHANDLER_PROBE_PATH);


/* ==========================================================================
 *  0. The suite's own preconditions
 * ========================================================================== */

test('the probes really did reach three different outcomes — this suite is not vacuous', () => {
    assert.equal(RESPONSES.length, PROBES.length, 'a probe did not answer at all');

    const guarded = RESPONSES.find((r) => r.path === '/api/revenue/now');
    assert.equal(guarded.status, 401, 'the guarded probe must be a 401 — otherwise the guard is not in the chain and this file is testing a different app');

    const missing = RESPONSES.find((r) => r.path === '/no-such-path-exists');
    assert.equal(missing.status, 404, 'the unrouted probe must reach Express\'s own final handler — that is the case a per-route header mount would miss');

    const health = RESPONSES.find((r) => r.path === '/healthz');
    assert.ok(
        health.status === 200 || health.status === 503,
        `/healthz answered ${health.status}; it is meant to answer 200 or 503-while-warming`
    );
});


/* ==========================================================================
 *  1. The headers, on every response
 * ========================================================================== */

test('X-Content-Type-Options: nosniff — a JSON body can never be re-read as script', () => {
    _assertOnEveryResponse('x-content-type-options', (value) => {
        if (value.toLowerCase() !== 'nosniff') {
            return 'must be exactly nosniff';
        }
        return null;
    });
});

test('X-Frame-Options: DENY — nothing here is ever framed', () => {
    _assertOnEveryResponse('x-frame-options', (value) => {
        if (value.toUpperCase() !== 'DENY') {
            return 'must be DENY; SAMEORIGIN is helmet\'s default and is weaker than this API needs';
        }
        return null;
    });
});

test('Referrer-Policy: no-referrer — no URL of this API travels to a third party', () => {
    _assertOnEveryResponse('referrer-policy', (value) => {
        if (value.toLowerCase() !== 'no-referrer') {
            return 'must be no-referrer — the same argument the guard makes for refusing a ?token= query parameter';
        }
        return null;
    });
});

test('Strict-Transport-Security is sent, and does NOT claim authority over subdomains or the preload list', () => {
    _assertOnEveryResponse('strict-transport-security', (value) => {
        const maxAge = /max-age=(\d+)/i.exec(value);
        if (!maxAge) {
            return 'carries no max-age';
        }
        if (parseInt(maxAge[1], 10) < 86400) {
            return 'max-age is under a day, which is short enough to be pointless';
        }
        //  Both of these are deliberate omissions, not oversights. `includeSubDomains` on a
        // deployment at an apex domain takes down every unrelated subdomain still on HTTP, for a
        // year, in every visitor's browser; `preload` takes months to reverse and reaches people
        // who never visited this install. A self-hosted project cannot know which deployment it is
        // in, so it does not make that choice on the operator's behalf.
        if (/includesubdomains/i.test(value)) {
            return 'includeSubDomains was added — read the comment on strictTransportSecurity in src/middlewares/securityHeaders.ts first';
        }
        if (/preload/i.test(value)) {
            return 'preload was added — that is effectively irreversible and cannot be a default';
        }
        return null;
    });
});

test('X-XSS-Protection: 0 — the legacy auditor is disabled, not enabled', () => {
    // The header's own filter introduced vulnerabilities and every major browser removed it.
    // `0` is the current guidance; a `1; mode=block` here would be a regression dressed as hardening.
    _assertOnEveryResponse('x-xss-protection', (value) => {
        if (value.trim() !== '0') {
            return 'must be 0 — enabling the legacy auditor is a known-harmful setting';
        }
        return null;
    });
});

test('the stack is not named: no X-Powered-By on any response', () => {
    const named = RESPONSES.filter((r) => typeof r.headers['x-powered-by'] === 'string');
    assert.deepEqual(named.map((r) => r.path), [], 'X-Powered-By came back — helmet and app.disable() both remove it, so something is re-adding it');
});

test('Cross-Origin-Resource-Policy and X-Permitted-Cross-Domain-Policies are set', () => {
    _assertOnEveryResponse('cross-origin-resource-policy', (value) => {
        if (value.toLowerCase() !== 'same-origin') {
            return 'must be same-origin';
        }
        return null;
    });
    _assertOnEveryResponse('x-permitted-cross-domain-policies', (value) => {
        if (value.toLowerCase() !== 'none') {
            return 'must be none';
        }
        return null;
    });
});


/* ==========================================================================
 *  2. The CSP — an API-only policy, and it has to stay one
 * ========================================================================== */

test('the CSP denies by default and refuses to be framed', () => {
    _assertOnEveryResponse('content-security-policy', (value) => {
        const policy = value.toLowerCase();
        if (!/default-src\s+'none'/.test(policy)) {
            return "must carry default-src 'none' — this process serves JSON, which loads nothing";
        }
        if (!/frame-ancestors\s+'none'/.test(policy)) {
            return "must carry frame-ancestors 'none'";
        }
        if (!/base-uri\s+'none'/.test(policy)) {
            return "must carry base-uri 'none'";
        }
        if (!/form-action\s+'none'/.test(policy)) {
            return "must carry form-action 'none'";
        }
        return null;
    }, _routedResponses());
});

test('a 404 answered by Express itself is still deny-everything and still unframeable', () => {
    // `finalhandler` replaces our CSP with its own on this one response — see the note on
    // FINALHANDLER_PROBE_PATH. What matters is that the replacement is not weaker in any way that
    // counts, so both halves are checked rather than the absence being waved through.
    const notFound = RESPONSES.find((response) => response.path === FINALHANDLER_PROBE_PATH);

    assert.match(
        String(notFound.headers['content-security-policy']).toLowerCase(),
        /default-src\s+'none'/,
        "Express's own 404 lost its deny-by-default CSP."
    );
    assert.equal(
        String(notFound.headers['x-frame-options']).toUpperCase(),
        'DENY',
        'The 404 lost X-Frame-Options. finalhandler overwrites the CSP — including frame-ancestors — '
        + 'so this header is the only thing refusing to let that response be framed.'
    );
    assert.equal(
        String(notFound.headers['x-content-type-options']).toLowerCase(),
        'nosniff',
        'The 404 lost nosniff. It returns an HTML error body, so this is the one probe where sniffing '
        + 'a response into another content type is not purely theoretical.'
    );
});

test(' the CSP has not been widened toward serving a document', () => {
    //  THE ASSERTION THAT PROTECTS THE REASONING, not the string. `default-src 'none'` is only
    // defensible while this process serves no HTML — the dashboard's document, React, Polaris and
    // Next's inline scripts are all served by the SEPARATE Next server on its own origin, and
    // nothing sent from here governs them.
    //
    // The natural way for that to stop being true is somebody adding `'self'` or `'unsafe-inline'`
    // here because a page they made this backend serve came out blank. If that happens, the fix is
    // to reconsider whether this backend should be serving that page at all — and either way this
    // test should be the thing that starts the conversation.
    _assertOnEveryResponse('content-security-policy', (value) => {
        const policy = value.toLowerCase();
        if (policy.includes("'unsafe-inline'") || policy.includes("'unsafe-eval'")) {
            return 'an unsafe- source was added; an API that serves only JSON needs neither';
        }
        if (policy.includes("'self'")) {
            return "'self' was added, which only a document needs — read the header of src/middlewares/securityHeaders.ts";
        }
        if (policy.includes('upgrade-insecure-requests')) {
            return 'upgrade-insecure-requests was added; running the stack on plain HTTP over a LAN is a supported deployment';
        }
        return null;
    }, _routedResponses());
});


/* ==========================================================================
 *  3. The mount — first layer, in the real entry point
 * ========================================================================== */

test(' src/apps/app.ts mounts securityHeaders, and mounts it FIRST', () => {
    // Read from SOURCE for the same reason routeGuard.test.js does: the app is composed inside
    // `bootstrap().then(…)` and importing it needs a database. Every header assertion above is
    // made against a REPRODUCTION of that composition, so this is what ties them to the real one.
    const source = fs.readFileSync(APP_ENTRY, 'utf8');
    const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

    const mounts = [...withoutComments.matchAll(/app\.use\(\s*([A-Za-z_$][\w$.]*)/g)].map((match) => match[1]);

    assert.ok(
        mounts.includes('securityHeaders'),
        'src/apps/app.ts no longer mounts securityHeaders. Every response in this file was read off a '
        + 'reproduction of that composition, so without this line the suite above proves nothing about '
        + 'what the application actually sends.'
    );
    assert.equal(
        mounts[0],
        'securityHeaders',
        'securityHeaders is no longer the FIRST thing mounted. Anything registered ahead of it can '
        + 'answer a request before the headers are attached — which is exactly the 404 and 401 cases '
        + 'this file exists to cover.'
    );
});

test('helmet is a declared dependency, not an accident of the lockfile', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, 'package.json'), 'utf8'));
    assert.ok(
        manifest.dependencies && manifest.dependencies.helmet,
        'helmet is not in package.json dependencies — a fresh `npm ci` would then boot an application '
        + 'whose first middleware does not exist.'
    );
});
