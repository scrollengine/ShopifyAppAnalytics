'use strict';

/**
 * ============================================================================
 *  authenticate — the guard on every /api/* route outside /api/auth
 * ============================================================================
 *
 *  Reads `Authorization: Bearer <token>`, verifies the session token, re-loads
 *  the caller's principal from the database, and puts it on the request. Every
 *  failure answers before a handler runs.
 *
 *  ── Order, and why ─────────────────────────────────────────────────────────
 *    1. The header. Missing or malformed ⇒ 401 BEFORE any database access, so an
 *       anonymous prober costs nothing and never reaches the datastore.
 *    2. `verifySessionToken`: signature, alg pinned to HS256, `aud` pinned, `exp`,
 *       and `sub` + `sid` both 24-hex. A single-operator-build token has no `sid`
 *       and no `aud` and fails here ⇒ 401.
 *    3. `loadPrincipal`: session row (exists, belongs to `sub`, not revoked, not
 *       expired) → user (exists, active, same session epoch) → install → role.
 *       Every refusal is 401 — EXCEPT a datastore failure, which is 503: fail
 *       closed, but do not sign the user out over a database blip (the dashboard
 *       signs out on any 401).
 *    4. `req.user_id` and a FROZEN `req.auth` (principal + session id).
 *
 *  Permissions are never read from the token. Revocation, disable, role change
 *  and ownership moves therefore take effect on the NEXT request, not at expiry.
 *
 *  ── The barrel is called through its OBJECT, at request time ───────────────
 *  `authModule.verifySessionToken(...)`, never a destructured copy taken at load.
 *  The permission-map tests stub `authModule.loadPrincipal` by assignment; a
 *  destructured reference would keep calling the real one and the test would
 *  exercise the database instead of the policy.
 *
 *  ── THE MOUNT IS THE SECURITY BOUNDARY ─────────────────────────────────────
 *  This middleware is the FIRST layer of `guardedApiRouter` in
 *  src/routes/index.ts, and test/routeGuard.test.js walks the live Express stack
 *  and fails on any `/api/*` route reachable without it beyond the public
 *  allowlist. Permission checks (`requirePermission`) sit AFTER it, per route.
 *
 *  ── ⚠️ 401 IS DELIBERATE, DO NOT "FIX" IT BACK TO 200 ───────────────────────
 *  A system that answers every authentication failure with HTTP 200 and
 *  `{ status: false }` ends up unable to use 401 for what it means. Here an
 *  authentication failure is a real 401 with a JSON body, and a permission
 *  refusal is a real 403. If a client ever treats a 401 as a transport error,
 *  fix the client.
 * ============================================================================
 */

import type { Request, Response, NextFunction } from 'express';
import apiResponse = require('../utils/apiResponse');
import logger = require('../core/logger');
import authModule = require('../modules/auth');

import type { AuthContext, LoadedPrincipal, VerifiedSessionToken } from '../modules/auth/types/auth.types';

const { customConsoleError, customConsoleDebug } = logger;

/** Matched case-insensitively: RFC 7235 makes the scheme token case-insensitive, and clients differ. */
const BEARER_SCHEME = 'bearer';

/** `error.code` of the 503 — the same code the services use for "could not consult the datastore". */
const DATASTORE_ERROR_CODE = 'DATASTORE_ERROR';

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
 * Builds the frozen per-request auth context, field by field.
 *
 * Enumerated rather than spread: a spread of whatever the loader returned is how an unexpected field
 * (a hash, a stored document) ends up riding along on every request.
 *
 * @param loaded - `loadPrincipal`'s success payload.
 * @param sessionId - The verified session id.
 * @returns The frozen context.
 */
const _buildAuthContext = (loaded: LoadedPrincipal, sessionId: string): Readonly<AuthContext> => {
    const principal = loaded.principal;
    const context: AuthContext = {
        user_id: principal.user_id,
        email: principal.email,
        name: principal.name,
        is_owner: principal.is_owner,
        role_key: principal.role_key,
        role_label: principal.role_label,
        custom_role_id: principal.custom_role_id,
        // Already frozen by resolvePrincipal; frozen again here so the guarantee does not depend on
        // a stub or a future loader remembering to.
        permissions: Object.freeze(Array.isArray(principal.permissions) ? principal.permissions.slice() : []),
        session_id: sessionId
    };
    return Object.freeze(context);
};

/**
 * Express middleware. Admits a request only when it carries a valid session token whose principal
 * loads from the database on this request.
 *
 * On success sets `req.user_id` and `req.auth` (declared in `src/types/express.d.ts`) and calls
 * `next()`. Otherwise answers 401 (every authentication failure) or 503 (the datastore could not be
 * consulted) and does NOT call `next()`.
 *
 * ⚠️ FAILS CLOSED, including on an exception. The `catch` answers 401 rather than delegating to an
 * error handler, because a guard whose failure path depends on some other middleware being correctly
 * registered is a guard with a way to be bypassed by a configuration mistake.
 *
 * @param req - Express request. Read for its `Authorization` header; written with `user_id` and `auth`.
 * @param res - Express response.
 * @param next - Called ONLY when the session verified and the principal loaded.
 * @returns Resolves once the request has been either admitted or refused.
 */
const authenticate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const token = _extractBearerToken(req.headers.authorization);
        if (!token) {
            customConsoleDebug('DEBUG: auth: request without a Bearer token', { path: req.originalUrl });
            apiResponse.unauthorizedResponse(res, authModule.AUTH_MESSAGES.AUTH_HEADER_MISSING);
            return;
        }

        const verified = await authModule.verifySessionToken({}, { token: token });
        const claims: VerifiedSessionToken | null = verified && verified.status ? verified.data : null;
        if (!claims || !authModule.isObjectIdString(claims.user_id) || !authModule.isObjectIdString(claims.session_id)) {
            apiResponse.unauthorizedResponse(res, authModule.AUTH_MESSAGES.SESSION_INVALID);
            return;
        }

        const loadedResult = await authModule.loadPrincipal({}, { user_id: claims.user_id, session_id: claims.session_id });
        if (!loadedResult || !loadedResult.status) {
            const code = loadedResult && loadedResult.error && typeof loadedResult.error === 'object' ? loadedResult.error.code : undefined;
            if (code === DATASTORE_ERROR_CODE) {
                apiResponse.serviceUnavailableResponse(res, authModule.AUTH_MESSAGES.SESSION_CHECK_UNAVAILABLE, { code: DATASTORE_ERROR_CODE });
                return;
            }
            customConsoleDebug('DEBUG: auth: session refused', { path: req.originalUrl, reason: typeof code === 'string' ? code : null });
            // The guard's own message, not the loader's: every 401 from here must keep starting with
            // "Not authenticated." and must not say which check failed.
            apiResponse.unauthorizedResponse(res, authModule.AUTH_MESSAGES.SESSION_INVALID);
            return;
        }

        const loaded: LoadedPrincipal = loadedResult.data;
        if (!loaded || !loaded.principal || loaded.principal.user_id !== claims.user_id) {
            // The loader answered for someone other than the token's subject. Never admit on that.
            customConsoleError('ERROR: middleware authenticate — the loaded principal does not match the token subject; refusing', {
                token_user_id: claims.user_id
            });
            apiResponse.unauthorizedResponse(res, authModule.AUTH_MESSAGES.SESSION_INVALID);
            return;
        }

        // The ONLY writer of these two fields, anywhere. Dot syntax, not `req['user_id'] = …`, so
        // TypeScript checks the assignment against the augmentation.
        req.user_id = claims.user_id;
        req.auth = _buildAuthContext(loaded, claims.session_id);
        return next();
    } catch (error) {
        // Reached only if something threw outside the services' own try/catch. Refuse the request:
        // an unexplained failure inside an authentication guard is never a reason to let it through.
        customConsoleError('ERROR: middleware authenticate', error);
        if (res.headersSent) {
            return;
        }
        apiResponse.unauthorizedResponse(res, authModule.AUTH_MESSAGES.SESSION_INVALID);
        return;
    }
};

export = {
    authenticate
};
