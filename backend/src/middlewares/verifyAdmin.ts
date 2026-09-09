'use strict';

/**
 * ============================================================================
 *  verifyAdmin — the guard on every /api/* route
 * ============================================================================
 *
 *  Reads `Authorization: Bearer <token>`, verifies it, and puts the operator id
 *  on the request. Anything else gets a 401 and never reaches a handler.
 *
 *  ──  THE MOUNT IS THE SECURITY BOUNDARY ───────────────────────────────────
 *  A common and dangerous shape applies the guard in exactly ONE line, at the
 *  router mount:
 *
 *      router.use('/<section>', someAuthGuard, sectionRouter);
 *
 *  Every route file underneath mounts its handlers BARE. Each of those files
 *  reads as completely correct on its own, and lifting one into a new project
 *  without the mount ships an analytics API with no authentication at all —
 *  with nothing in the file to suggest anything is missing.
 *
 *  So in this build the guard is asserted by a test that walks the live Express
 *  stack and fails on any `/api/*` route reachable without it. `POST
 *  /api/auth/login` and `GET /healthz` are the only exemptions, and they are
 *  named in that test. Add a route, and either it is behind this middleware or
 *  the test tells you.
 *
 *  ── ⚠️ 401 IS DELIBERATE, DO NOT "FIX" IT BACK TO 200 ───────────────────────
 *  That same system answers EVERY authentication failure with HTTP 200 and a
 *  `{ status: false }` body, because a great many call sites had come to depend on
 *  the 200 and could no longer be changed. The cost is permanent: a 401 from
 *  that API means the token authenticated FINE and a permission check rejected
 *  it — the exact opposite of what any reader, log aggregator, or monitoring
 *  tool assumes.
 *
 *  This codebase is new and has no such constraint, so an authentication
 *  failure is a real 401 with a JSON body. If a client of this API ever starts
 *  treating a 401 as a transport error, fix the client.
 * ============================================================================
 */

import type { Request, Response, NextFunction } from 'express';
import apiResponse = require('../utils/apiResponse');
import logger = require('../core/logger');
import authModule = require('../modules/auth');

const { customConsoleError, customConsoleDebug } = logger;
const { verifyToken, AUTH_MESSAGES } = authModule;

/** Matched case-insensitively: RFC 7235 makes the scheme token case-insensitive, and clients differ. */
const BEARER_SCHEME = 'bearer';

/**
 * Extracts the token from an `Authorization` header.
 *
 *  THE HEADER IS THE ONLY ACCEPTED CARRIER. There is deliberately no `?token=` query fallback and
 * no cookie fallback, however convenient either would be for a quick `curl` or an `<img>` tag:
 *
 *   - a token in a query string is written to every access log, in plaintext, forever — the web
 *     server's, the load balancer's, the CDN's, and any log aggregator downstream of them;
 *   - it travels in the `Referer` header to any third-party asset the page loads, handing the
 *     credential to someone else's server;
 *   - it lands in browser history and in anything that copies a URL.
 *
 * A cookie would additionally make this API CSRF-exposed, which the header form is not — a browser
 * attaches cookies to cross-site requests automatically and never attaches an Authorization header.
 *
 * @param headerValue - The raw `Authorization` header, if present.
 * @returns The token, or '' when the header is absent or not a well-formed Bearer header.
 */
const _extractBearerToken = (headerValue: string | undefined): string => {
    if (typeof headerValue !== 'string') {
        return '';
    }
    const trimmed = headerValue.trim();
    const separatorIndex = trimmed.indexOf(' ');
    if (separatorIndex < 1) {
        return '';
    }
    const scheme = trimmed.slice(0, separatorIndex).toLowerCase();
    if (scheme !== BEARER_SCHEME) {
        return '';
    }
    return trimmed.slice(separatorIndex + 1).trim();
};

/**
 * Express middleware. Admits a request only when it carries a valid session token.
 *
 * On success sets `req.user_id` (declared in `src/types/express.d.ts`) and calls `next()`. On any
 * failure — no header, wrong scheme, empty token, bad signature, expired, or an unexpected throw —
 * responds 401 and does NOT call `next()`.
 *
 * ⚠️ FAILS CLOSED, including on an exception. The `catch` answers 401 rather than delegating to an
 * error handler, because a guard whose failure path depends on some other middleware being correctly
 * registered is a guard with a way to be bypassed by a configuration mistake.
 *
 * @param req - Express request. Read for its `Authorization` header; written with `user_id`.
 * @param res - Express response.
 * @param next - Called ONLY when the token verified.
 * @returns Resolves once the request has been either admitted or refused.
 */
const verifyAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const token = _extractBearerToken(req.headers.authorization);
        if (!token) {
            customConsoleDebug('DEBUG: auth: request without a Bearer token', { path: req.originalUrl });
            apiResponse.unauthorizedResponse(res, AUTH_MESSAGES.AUTH_HEADER_MISSING);
            return;
        }

        const verified = await verifyToken(token);
        if (!verified.status || !verified.data || !verified.data.user_id) {
            apiResponse.unauthorizedResponse(res, verified.msg || AUTH_MESSAGES.SESSION_INVALID);
            return;
        }

        // The ONLY writer of this field, anywhere. A handler that finds it set therefore knows a
        // token verified — not merely that something assigned to it. Dot syntax, not
        // `req['user_id'] = …`, so TypeScript actually checks the assignment against the
        // augmentation rather than waving a bracket write through.
        req.user_id = verified.data.user_id;
        return next();
    } catch (error) {
        // Reached only if something threw outside the service's own try/catch. Refuse the request:
        // an unexplained failure inside an authentication guard is never a reason to let it through.
        customConsoleError('ERROR: middleware verifyAdmin', error);
        apiResponse.unauthorizedResponse(res, AUTH_MESSAGES.SESSION_INVALID);
        return;
    }
};

export = {
    verifyAdmin
};
