'use strict';

/**
 * ============================================================================
 *  terminalErrorHandler — the last thing mounted, and the only thing that
 *  decides what a thrown error tells the internet
 * ============================================================================
 *
 *  Express recognises an error handler by its ARITY: a middleware declared with
 *  four parameters, and nothing else, gets handed the error. Declare three and
 *  it is a normal middleware that never runs. That single fact is why this lives
 *  in its own file with its own test rather than as four lines inside the entry
 *  point.
 *
 *  ── What it is for ─────────────────────────────────────────────────────────
 *  With NO four-argument handler mounted, Express falls through to
 *  `finalhandler`, which renders an HTML page carrying the STACK TRACE whenever
 *  `NODE_ENV !== 'production'` — and `src/config/index.ts` defaults `NODE_ENV`
 *  to `'development'`, because a self-hoster who never sets it should get the
 *  louder logs rather than the quieter ones.
 *
 *  That combination was reachable with NO CREDENTIAL AT ALL. `express.json()` is
 *  mounted ABOVE the router, so a body that does not parse fails before any
 *  authentication runs, on ANY path — including `/healthz`:
 *
 *      curl -X POST http://host/healthz -H 'content-type: application/json' -d '{'
 *
 *  came back with the operator's absolute install paths and the file and line of
 *  every frame. The login rate limiter is scoped to `/api/auth/login`, so
 *  nothing throttled it either.
 *
 *  ── Why it does not read NODE_ENV ──────────────────────────────────────────
 *  Deliberately. A deployment that forgets the variable must still be safe, so
 *  the redaction is unconditional and the variable only decides how loud the
 *  LOG is. Gating this on `NODE_ENV === 'production'` would restore the exact
 *  hole, one missing line of `.env` away.
 *
 *  ── Why the client is told the class and nothing else ──────────────────────
 *  The same argument `apiResponse._safeErrorShape` makes, for the same reasons,
 *  at the other end of the same request. Serialising the caught object here is
 *  worse, not better, because THIS handler sees errors from every layer at once:
 *
 *    - an **axios** error defines its own `toJSON`, which `JSON.stringify` calls
 *      before any replacer, and it emits `config.headers` — including
 *      `X-Shopify-Access-Token`, which reads the operator's entire Partner
 *      organisation.
 *    - a **Mongoose** ValidationError/CastError emits `path`, `kind` and
 *      `stringValue`, handing a caller a collection's internal field names.
 *    - every Error emits `stack`, and a stack carries absolute paths.
 *
 *  The operator loses nothing: all of it goes to the log, in full, where it is
 *  theirs to read.
 * ============================================================================
 */

import type express = require('express');

type LoggerModule = typeof import('../core/logger');

/**
 * What a client is told, by class of failure. Never the message — a thrown
 * message is written for an operator and routinely names a collection, a host
 * or a query.
 */
const CLIENT_MESSAGE = {
    /** 4xx: the caller can fix this by asking differently. */
    REQUEST: 'The request could not be read.',
    /** 5xx: the caller can do nothing; the operator reads the log. */
    SERVER: 'The request could not be completed.'
};

/**
 * Reads the HTTP status a thrown error asked for, defaulting to 500.
 *
 * `express.json()` sets `status`/`statusCode` to 400 on a body it cannot parse, and `http-errors`
 * (used by Express itself) sets both. Anything else — a bare `throw new Error()` — is ours, and
 * ours is a 500.
 *
 * Bounded to a real HTTP code: `res.status()` throws a RangeError outside 100–599, which inside an
 * error handler means the process answers nothing at all.
 *
 * @param error - The caught error, in whatever form.
 * @returns A status code between 400 and 599.
 */
const _statusOf = (error: any): number => {
    const claimed = Number(error && (error.status || error.statusCode));
    if (!Number.isInteger(claimed) || claimed < 400 || claimed > 599) {
        return 500;
    }
    return claimed;
};

/**
 * Whether the error is the body parser failing to read the REQUEST (a malformed or oversized body,
 * an aborted upload). `body-parser`/`raw-body` tag every such error with a string `type`
 * ('entity.parse.failed', 'entity.too.large', 'request.aborted', …) and a 4xx status.
 *
 * ⚠️ Their message and stack QUOTE THE BODY: V8's JSON.parse error carries about ten characters
 * around the fault, which on a sign-in or reset body is a piece of a password or token (seen live:
 * `"password":SMOKEPROBE"... is not valid JSON` at ERROR). And `err.body` holds the whole of it.
 *
 * @param error - The caught error.
 * @returns True for a body-reading failure.
 */
const _isBodyReadError = (error: any): boolean => {
    return Boolean(error) && typeof error.type === 'string' && _statusOf(error) < 500;
};

/**
 * The terminal error handler.
 *
 * MOUNT IT LAST, AFTER THE ROUTER. Express walks the stack in registration order; a handler
 * mounted above a route never sees that route's errors.
 *
 * FOUR PARAMETERS, ALWAYS. `_next` is unused and cannot be removed — dropping it makes this an
 * ordinary middleware, Express stops handing it errors, and the stack-trace page comes back with
 * no test failing and no type error.
 *
 * @param err - Whatever was thrown or passed to `next()`.
 * @param _req - Unused.
 * @param res - Express response.
 * @param _next - Unused; present to set the arity Express reads.
 */
const terminalErrorHandler: express.ErrorRequestHandler = (err, _req, res, _next) => {
    const status = _statusOf(err);

    // Required lazily for the reason src/apps/app.ts explains: the logger reaches config, and
    // config snapshots process.env at first require. A module-scope import here would be reached
    // through the entry point's import graph before bootstrap() has loaded .env.
    const logger: LoggerModule = require('../core/logger');
    if (_isBodyReadError(err)) {
        // The class of failure only: the message, the stack and `err.body` all carry the body.
        // A client's malformed request is not a server fault, so WARN, not ERROR.
        logger.customConsoleWarn('WARN: request body could not be read', { status: status, type: err.type });
    } else {
        logger.customConsoleError('ERROR: unhandled request error', {
            status: status,
            msg: err && err.message,
            stack: err && err.stack
        });
    }

    // Headers already flushed: the response is mid-flight and there is no envelope left to send.
    // Destroying the socket is what Express's own default does, and it is the only honest ending —
    // appending JSON to a half-sent body would corrupt whatever the client had already parsed.
    if (res.headersSent) {
        res.destroy();
        return;
    }

    res.status(status).json({
        status: false,
        msg: status >= 500 ? CLIENT_MESSAGE.SERVER : CLIENT_MESSAGE.REQUEST,
        data: {},
        error: {}
    });
};

export = {
    /** The four-argument handler. Mount it LAST, after the router. */
    terminalErrorHandler,
    /** The two strings a client can ever be told. Exported for the test, not for call sites. */
    CLIENT_MESSAGE
};
