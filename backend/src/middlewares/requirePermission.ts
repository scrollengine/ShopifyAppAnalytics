'use strict';

/**
 * ============================================================================
 *  requirePermission / requireSelf — the per-route policy (spec §4, §8)
 * ============================================================================
 *
 *  `authenticate` answers "who is this"; this file answers "may they do THIS".
 *  Every guarded route declares exactly ONE policy, as its FIRST route-level
 *  middleware:
 *
 *      router.get('/now', requirePermission(PERMISSIONS.MERCHANTS_READ), _handler);
 *      router.get('/', requireSelf(), _getAccountProfile);
 *
 *  ⚠️ NEVER `router.use(requirePermission(...))`. A router-level policy covers
 *  whatever is registered after it in that file, including a route added later
 *  that needed a DIFFERENT key — the same "one line far away guards everything"
 *  shape that once shipped an unauthenticated analytics API. Per route, the
 *  policy sits next to the handler it protects, and test/permissionMap.test.js
 *  pins the key for every route.
 *
 *  ── How the tests see the policy ────────────────────────────────────────────
 *  The returned middleware is NAMED `requirePermission` (or `requireSelf`) so the
 *  route map finds it, and is tagged in a module-private WeakMap with its key (or
 *  `'@self'`); `readPolicyTag(fn)` reads the tag back. A WeakMap rather than a
 *  property on the function, so nothing outside this file can re-tag a policy.
 *
 *  ── Fail closed ─────────────────────────────────────────────────────────────
 *  An unknown key THROWS AT CONSTRUCTION — i.e. when the route file loads — so a
 *  typo is a boot failure, never a route that silently refuses (or admits)
 *  everyone. At request time a missing `req.auth` is 401 (the guard did not run;
 *  never admit), and a key not held is 403 with `error: { code: 'FORBIDDEN',
 *  permission }` — 403, never 401, because the dashboard signs out on a 401.
 * ============================================================================
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import apiResponse = require('../utils/apiResponse');
import logger = require('../core/logger');
import authModule = require('../modules/auth');

const { customConsoleError, customConsoleDebug } = logger;

/** The tag a self-service route carries instead of a catalogue key. */
const SELF_POLICY_TAG = '@self';

/** Middleware function → its policy tag. Private: only this file can tag, anyone can read. */
const POLICY_TAGS = new WeakMap<Function, string>();

/**
 * The permission set on the request's auth context, or `null` when there is no usable context.
 *
 * @param req - The request.
 * @returns The caller's permissions, or `null` when `req.auth` is absent or malformed.
 */
const _permissionsOf = (req: Request): readonly string[] | null => {
    const auth = req.auth;
    if (!auth || typeof auth !== 'object' || !Array.isArray(auth.permissions)) {
        return null;
    }
    return auth.permissions;
};

/**
 * Builds the policy middleware for one catalogue key.
 *
 * @param key - A catalogue key (`authModule.PERMISSIONS.*`).
 * @returns Express middleware named `requirePermission`, tagged with `key`.
 * @throws When `key` is not in the permission catalogue — at route-file load, on purpose.
 */
const _buildRequirePermission = (key: string): RequestHandler => {
    if (!authModule.isPermissionKey(key)) {
        throw new Error(`requirePermission: '${String(key)}' is not a permission catalogue key. Use authModule.PERMISSIONS.*`);
    }

    const requirePermission = (req: Request, res: Response, next: NextFunction): void => {
        try {
            const permissions = _permissionsOf(req);
            if (permissions === null) {
                // The guard did not run ahead of this policy (a mount mistake). Never admit.
                customConsoleError('ERROR: middleware requirePermission — no auth context on a guarded route; refusing', { path: req.originalUrl, permission: key });
                apiResponse.unauthorizedResponse(res, authModule.AUTH_MESSAGES.SESSION_INVALID);
                return;
            }
            if (!permissions.includes(key)) {
                customConsoleDebug('DEBUG: auth: permission refused', { path: req.originalUrl, permission: key, user_id: req.user_id });
                apiResponse.forbiddenResponse(res, authModule.AUTH_MESSAGES.FORBIDDEN, key);
                return;
            }
            return next();
        } catch (error) {
            customConsoleError('ERROR: middleware requirePermission — refusing', error);
            if (res.headersSent) {
                return;
            }
            apiResponse.forbiddenResponse(res, authModule.AUTH_MESSAGES.FORBIDDEN, key);
            return;
        }
    };

    POLICY_TAGS.set(requirePermission, key);
    return requirePermission;
};

/**
 * Builds the self-service policy: any authenticated, active user, acting on their own account.
 *
 * Holds no key because none is needed — `/api/account` only ever reads or changes the caller's own
 * row, and `authenticate` has already proved the caller is signed in and active.
 *
 * @returns Express middleware named `requireSelf`, tagged `'@self'`.
 */
const _buildRequireSelf = (): RequestHandler => {
    const requireSelf = (req: Request, res: Response, next: NextFunction): void => {
        try {
            if (_permissionsOf(req) === null || typeof req.user_id !== 'string' || !req.user_id) {
                customConsoleError('ERROR: middleware requireSelf — no auth context on a guarded route; refusing', { path: req.originalUrl });
                apiResponse.unauthorizedResponse(res, authModule.AUTH_MESSAGES.SESSION_INVALID);
                return;
            }
            return next();
        } catch (error) {
            customConsoleError('ERROR: middleware requireSelf — refusing', error);
            if (res.headersSent) {
                return;
            }
            apiResponse.unauthorizedResponse(res, authModule.AUTH_MESSAGES.SESSION_INVALID);
            return;
        }
    };

    POLICY_TAGS.set(requireSelf, SELF_POLICY_TAG);
    return requireSelf;
};

/**
 * Reads the policy a middleware was built with.
 *
 * @param fn - Any function (typically a route layer's handle).
 * @returns The catalogue key, `'@self'`, or `null` when `fn` is not a policy built here.
 */
const readPolicyTag = (fn: unknown): string | null => {
    if (typeof fn !== 'function') {
        return null;
    }
    const tag = POLICY_TAGS.get(fn);
    return typeof tag === 'string' ? tag : null;
};

export = {
    /** `requirePermission(PERMISSIONS.X)` — 401 without an auth context, 403 without the key. */
    requirePermission: _buildRequirePermission,
    /** `requireSelf()` — any authenticated user, for `/api/account`. */
    requireSelf: _buildRequireSelf,
    /** The key (or `'@self'`) a policy middleware was built with; `null` for anything else. */
    readPolicyTag,
    /** The tag `requireSelf()` carries. */
    SELF_POLICY_TAG
};
