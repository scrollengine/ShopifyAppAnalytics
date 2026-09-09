'use strict';

/**
 * ============================================================================
 *  THROWN ERRORS — what a client is allowed to learn from one
 * ============================================================================
 *
 *  Before this suite the application had NO four-argument error handler at all,
 *  and this was true of a running deployment:
 *
 *      curl -X POST http://host/healthz -H 'content-type: application/json' -d '{'
 *
 *      <!DOCTYPE html> … <pre>SyntaxError: Expected property name or '}' …
 *          at JSON.parse (&lt;anonymous&gt;)
 *          at /Users/…/node_modules/body-parser/lib/types/json.js:92:19 …
 *
 *  No credential, no rate limit, any path. `express.json()` is mounted above the
 *  router so the body fails to parse before authentication runs; `finalhandler`
 *  renders the stack because `NODE_ENV !== 'production'`, and config defaults
 *  `NODE_ENV` to 'development'. Three ordinary decisions, none wrong on its own.
 *
 *  ── Why the assertions are negative, and about SHAPE ────────────────────────
 *  A test that matched the exact leaked string would pass the day the leak
 *  changed format. These instead assert what must never appear in a body — a
 *  stack frame, an absolute path, a `node_modules` segment, a credential — so a
 *  new leak in a new shape still fails them.
 *
 *  ── Why over a socket ───────────────────────────────────────────────────────
 *  Arity is the entire mechanism: Express hands errors only to a middleware
 *  DECLARED with four parameters. Calling the handler directly proves it
 *  redacts, which was never in doubt; only a real request proves Express
 *  actually routes an error to it.
 * ============================================================================
 */

// Set BEFORE anything is required: `src/config` snapshots process.env at first require, and the
// handler reaches the logger which reaches config. Without this every assertion below prints a
// stack trace to the test output — the very thing being suppressed on the wire.
process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const { before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const express = require('express');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const APP_ENTRY = path.join(BACKEND_ROOT, 'src', 'apps', 'app.ts');

const {
    terminalErrorHandler,
    CLIENT_MESSAGE
} = require(path.join(BACKEND_ROOT, 'src', 'middlewares', 'terminalErrorHandler'));

const {
    errorResponseWithErrorObject
} = require(path.join(BACKEND_ROOT, 'src', 'utils', 'apiResponse'));

/** A fake Partner API token, shaped like the real one, so a leak of it is unmistakable in a diff. */
const SENTINEL_TOKEN = 'prtapi_THIS_MUST_NEVER_APPEAR_ON_THE_WIRE';

/**
 * Everything that must never appear in a response body, with the reason it must not.
 *
 * Checked against the WHOLE body rather than a parsed field, because a leak that arrives in an
 * unexpected key is still a leak.
 */
const FORBIDDEN_IN_BODY = [
    { label: 'a stack frame', pattern: /\bat [\w$.<>[\]]+ \(|\bat \/|\n\s+at\s/ },
    { label: 'a node_modules path', pattern: /node_modules/ },
    { label: 'an absolute filesystem path', pattern: /(?:^|["'\s(])\/(?:Users|home|var|opt|srv|app)\// },
    { label: 'the Partner API token', pattern: new RegExp(SENTINEL_TOKEN) },
    { label: 'an Authorization header', pattern: /x-shopify-access-token|authorization/i }
];

/**
 * Builds an app composed the way `src/apps/app.ts` composes it — body parser above the router,
 * terminal handler mounted LAST — plus two routes that throw on demand.
 *
 * ⚠️ A REPRODUCTION. The real app is built inside `bootstrap().then(…)` and cannot be imported
 * without a database. The source assertions in section 3 are what keep this honest.
 *
 * @returns {Promise<{ baseUrl: String, close: Function }>} The base URL and a closer.
 */
const _startServer = async () => {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));

    // A plain synchronous throw: the ordinary way a handler fails.
    app.get('/throws', () => {
        throw new Error(`connect ECONNREFUSED mongodb://root:hunter2@10.0.0.4:27017 — ${SENTINEL_TOKEN}`);
    });

    // An axios-shaped error, which is the one that carries a credential. axios defines its own
    // `toJSON`, which `JSON.stringify` calls BEFORE any replacer, and it emits `config.headers`.
    app.get('/throws-axios', (_req, _res, next) => {
        const error = new Error('Request failed with status code 401');
        error.name = 'AxiosError';
        error.config = { url: 'https://partners.shopify.com/api', headers: { 'X-Shopify-Access-Token': SENTINEL_TOKEN } };
        error.toJSON = function toJSON() {
            return { message: this.message, config: this.config, stack: this.stack };
        };
        next(error);
    });

    // The `errorResponseWithErrorObject` path — 30 controllers reach this one, not the handler.
    app.get('/controller-catch', (_req, res) => {
        const error = new Error('E11000 duplicate key error collection: gi_partner_app index: app_id_1');
        error.name = 'MongoServerError';
        error.code = 11000;
        error.keyValue = { app_id: '1234567' };
        error.errmsg = `token=${SENTINEL_TOKEN}`;
        return errorResponseWithErrorObject(res, 'The sync could not be started.', error);
    });

    app.use(terminalErrorHandler);

    const server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((resolve) => server.close(resolve))
    };
};

/**
 * The probes. Each names the LAYER that fails, because each reaches the handler differently: the
 * body parser fails before any route, a route throws synchronously, and a route calls `next(err)`.
 */
const PROBES = [
    {
        label: 'a malformed body, refused before authentication',
        route_path: '/healthz',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
        expected_status: 400
    },
    {
        label: 'a body over the size limit',
        route_path: '/healthz',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: `[${'"x",'.repeat(300000)}"x"]`,
        expected_status: 413
    },
    {
        label: 'a handler that throws',
        route_path: '/throws',
        method: 'GET',
        expected_status: 500
    },
    {
        label: 'an axios error passed to next()',
        route_path: '/throws-axios',
        method: 'GET',
        expected_status: 500
    },
    {
        label: 'a controller catch, via errorResponseWithErrorObject',
        route_path: '/controller-catch',
        method: 'GET',
        expected_status: 500
    }
];

/** Every probe's response, fetched once for the whole file. CommonJS has no top-level await. */
let RESPONSES = [];

before(async () => {
    const server = await _startServer();
    try {
        RESPONSES = [];
        for (const probe of PROBES) {
            const response = await fetch(`${server.baseUrl}${probe.route_path}`, {
                method: probe.method,
                headers: probe.headers,
                body: probe.body
            });
            RESPONSES.push({
                label: probe.label,
                path: probe.route_path,
                expected_status: probe.expected_status,
                status: response.status,
                content_type: response.headers.get('content-type') || '',
                text: await response.text()
            });
        }
    } finally {
        await server.close();
    }
});


/* ==========================================================================
 *  0. The suite's own preconditions
 * ========================================================================== */

test('every probe actually reached the server and failed the way it was meant to', () => {
    assert.equal(RESPONSES.length, PROBES.length, 'A probe did not run — everything below would be vacuous.');
    const wrong = RESPONSES
        .filter((response) => response.status !== response.expected_status)
        .map((response) => `${response.path} (${response.label}) answered ${response.status}, expected ${response.expected_status}`);
    assert.deepEqual(wrong, [], 'A probe did not produce the failure it exists to produce:');
});


/* ==========================================================================
 *  1. What must never come back
 * ========================================================================== */

test(' no error response carries a stack, a path, or a credential', () => {
    const leaks = [];
    for (const response of RESPONSES) {
        for (const forbidden of FORBIDDEN_IN_BODY) {
            if (forbidden.pattern.test(response.text)) {
                leaks.push(`${response.path} (${response.label}) leaked ${forbidden.label}: ${response.text.slice(0, 240)}`);
            }
        }
    }
    assert.deepEqual(leaks, [], 'An error response told a client something it must not know:');
});

test('no error response carries the thrown message', () => {
    // Thrown messages are written for an operator. The ones in this file name a Mongo URI with
    // credentials in it, a duplicate-key index, and a Partner app id — all ordinary, all things a
    // real message routinely contains.
    const leaks = [];
    for (const response of RESPONSES) {
        for (const fragment of ['ECONNREFUSED', 'hunter2', '27017', 'E11000', 'duplicate key', '1234567', 'gi_partner_app']) {
            if (response.text.includes(fragment)) {
                leaks.push(`${response.path} (${response.label}) echoed "${fragment}"`);
            }
        }
    }
    assert.deepEqual(leaks, [], 'The thrown message reached the client:');
});

test('every error response is JSON, in the one envelope', () => {
    // `finalhandler` answers in HTML. A body that is not JSON is the signal that nothing handled
    // the error — which is the whole defect, in the form it would come back in.
    const wrong = [];
    for (const response of RESPONSES) {
        if (!response.content_type.includes('application/json')) {
            wrong.push(`${response.path} (${response.label}) answered ${response.content_type || 'no content-type'}`);
            continue;
        }
        let body = null;
        try {
            body = JSON.parse(response.text);
        } catch (error) {
            wrong.push(`${response.path} (${response.label}) sent unparseable JSON`);
            continue;
        }
        const keys = Object.keys(body).sort();
        assert.deepEqual(keys, ['data', 'error', 'msg', 'status'], `${response.path} is not the standard envelope`);
        assert.equal(body.status, false, `${response.path} reported status:true on a failure`);
        assert.equal(typeof body.msg, 'string', `${response.path} sent no message`);
    }
    assert.deepEqual(wrong, [], 'An error escaped the envelope:');
});


/* ==========================================================================
 *  2. What it says instead
 * ========================================================================== */

test('the client is told the CLASS of failure, and the status code agrees with it', () => {
    // A 4xx tells the caller to ask differently; a 5xx tells them not to bother. Getting this
    // backwards makes a malformed request look like an outage.
    const handlerResponses = RESPONSES.filter((response) => response.path !== '/controller-catch');
    for (const response of handlerResponses) {
        const body = JSON.parse(response.text);
        const expected = response.status >= 500 ? CLIENT_MESSAGE.SERVER : CLIENT_MESSAGE.REQUEST;
        assert.equal(body.msg, expected, `${response.path} (${response.status}) said "${body.msg}"`);
    }
});

test('errorResponseWithErrorObject publishes the error NAME and CODE, and nothing else', () => {
    // The name and a code are what a support conversation actually needs — "MongoServerError,
    // 11000" is diagnosable and carries nothing. Everything else on that object is internals.
    const response = RESPONSES.find((entry) => entry.path === '/controller-catch');
    const body = JSON.parse(response.text);
    assert.deepEqual(Object.keys(body.error).sort(), ['name'], 'error should carry only the keys it can prove are safe');
    assert.equal(body.error.name, 'MongoServerError');
    assert.equal(body.msg, 'The sync could not be started.', 'The operator-written message is the one the client sees.');
});

test('a non-integer or out-of-range status on a thrown error does not crash the handler', () => {
    //  `res.status()` throws a RangeError outside 100–599, and a RangeError thrown INSIDE the
    // error handler means Express answers nothing at all — the request hangs until the client
    // times out. Asserted directly because no route produces it; a library one day will.
    const sent = [];
    const fakeRes = {
        headersSent: false,
        status(code) {
            if (!Number.isInteger(code) || code < 100 || code > 599) {
                throw new RangeError(`Invalid status code: ${code}`);
            }
            sent.push(code);
            return this;
        },
        json(body) {
            sent.push(body);
            return this;
        },
        destroy() {
            sent.push('destroyed');
        }
    };
    for (const bad of [0, -1, 99, 600, 1000, NaN, 'teapot', null, undefined, 200.5]) {
        sent.length = 0;
        terminalErrorHandler({ status: bad, message: 'x' }, {}, fakeRes, () => {});
        assert.equal(sent[0], 500, `status ${String(bad)} should fall back to 500, got ${String(sent[0])}`);
    }
});

test('an error arriving after the headers are flushed destroys the socket rather than appending', () => {
    // A streamed or already-sent response cannot be given an envelope. Appending JSON to a
    // half-sent body corrupts whatever the client already parsed.
    const calls = [];
    const fakeRes = {
        headersSent: true,
        status() {
            calls.push('status'); return this;
        },
        json() {
            calls.push('json'); return this;
        },
        destroy() {
            calls.push('destroy');
        }
    };
    terminalErrorHandler(new Error('too late'), {}, fakeRes, () => {});
    assert.deepEqual(calls, ['destroy'], 'The handler wrote to a response that was already on the wire.');
});


/* ==========================================================================
 *  3. The mount — in the real entry point, not the reproduction
 * ========================================================================== */

/** `src/apps/app.ts` with comments removed, so a mention inside a comment cannot satisfy a test. */
const _entrySource = () => fs.readFileSync(APP_ENTRY, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

test(' src/apps/app.ts mounts terminalErrorHandler, and mounts it LAST', () => {
    const mounts = [...(_entrySource().matchAll(/app\.use\(\s*(?:[A-Za-z_$][\w$.]*\s*,\s*)?([A-Za-z_$][\w$.]*)/g))]
        .map((match) => match[1]);

    assert.ok(
        mounts.includes('terminalErrorHandler'),
        'src/apps/app.ts no longer mounts terminalErrorHandler. Express then falls through to '
        + 'finalhandler, which renders the stack trace as HTML on any unparseable body — with no '
        + 'credential, on any path. Every assertion above was made against a reproduction of this '
        + 'composition, so without this line the suite proves nothing about the application.'
    );
    assert.equal(
        mounts[mounts.length - 1],
        'terminalErrorHandler',
        `terminalErrorHandler is no longer LAST (order: ${mounts.join(' → ')}). Express walks the `
        + 'stack in registration order, so anything mounted below it has no error handler at all.'
    );
    assert.ok(
        mounts.indexOf('routes') < mounts.indexOf('terminalErrorHandler'),
        'The router is mounted after the error handler, so no route error will ever reach it.'
    );
});

test(' the handler keeps its four parameters', () => {
    // The single fact the whole mechanism rests on. Express decides a middleware is an ERROR
    // handler by `fn.length === 4` and nothing else. Drop the unused `_next` — which every linter
    // and every reviewer will suggest — and this becomes an ordinary middleware that Express never
    // hands an error to. Nothing else in the build fails: not tsc, not eslint, not one test above,
    // because the reproduction would stop routing errors to it in exactly the same way.
    assert.equal(
        terminalErrorHandler.length,
        4,
        'terminalErrorHandler no longer declares four parameters. Express will treat it as ordinary '
        + 'middleware, stop handing it errors, and serve the stack-trace page again.'
    );
});

test('the redaction does not depend on NODE_ENV', () => {
    // `finalhandler`'s stack page is gated on NODE_ENV, and config defaults it to 'development'.
    // If this handler were gated the same way, a deployment that forgets one line of .env would be
    // back to the original hole — so the source must not read it at all.
    const source = fs.readFileSync(
        path.join(BACKEND_ROOT, 'src', 'middlewares', 'terminalErrorHandler.ts'),
        'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    assert.ok(
        !/NODE_ENV/.test(source),
        'terminalErrorHandler reads NODE_ENV. A deployment that does not set it must still be safe; '
        + 'gate the LOG on it if you must, never the response.'
    );
});
