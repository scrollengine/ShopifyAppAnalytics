'use strict';

/**
 * ============================================================================
 *  AUTH CONTROLLER — the one endpoint that is reachable without a token
 * ============================================================================
 *
 *  `POST /api/auth/login` is mounted OUTSIDE the guarded sub-router in
 *  src/routes/index.ts, which makes it the only `/api/*` path an anonymous
 *  caller can reach. Everything it does is therefore visible to the internet,
 *  and it is written accordingly:
 *
 *    - It never says WHICH half of the credentials was wrong. The service
 *      already collapses "no such account" and "wrong password" into one
 *      message and compares against a dummy hash when the account is absent,
 *      so the timing does not leak the answer either. This controller must not
 *      undo that by adding a friendlier error.
 *    - It logs no password, and echoes no email back on failure.
 *
 *  On success the response carries the bearer token the dashboard sends on
 *  every subsequent request as `Authorization: Bearer <token>`.
 * ============================================================================
 */

import type { Request, Response } from 'express';
import apiResponse = require('../utils/apiResponse');
import logger = require('../core/logger');
import authModule = require('../modules/auth');

const { customConsoleError } = logger;
const { login } = authModule;

/**
 * Signs the operator in and returns a bearer token.
 *
 * Validation lives here rather than in the service only to the extent of "is there a body at all";
 * the credential check itself is the service's, because it must stay constant-shaped.
 *
 * @param req - Express request. Body: `{ email, password }`.
 * @param res - Express response.
 * @returns 200 with `{ token, expires_at, user_id, email }` on success, or a
 * 200 envelope with `status:false` and a deliberately vague message on failure.
 */
const _authAdminLogin = async (req: Request, res: Response) => {
    try {
        //  Cast the request bag ONCE. Do not narrow it with a helper that coerces values to
        // `string | undefined` — that silently discards an array-valued field at run time, which is
        // a behaviour change wearing a typing change's clothes.
        const b = (req.body || {}) as Record<string, any>;

        const email = b.email;
        const password = b.password;

        if (!email || !password) {
            return apiResponse.validationErrorResponse(res, 'Email and password are both required.');
        }

        // No identity yet — that is the point of this endpoint. The service takes a partial
        // identity so its signature stays uniform with every other service in the codebase.
        const serviceResponse = await login({}, { email: String(email), password: String(password) });
        if (!serviceResponse.status) {
            return apiResponse.unauthorizedResponse(res, serviceResponse.msg);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Auth authController _authAdminLogin', error);
        return apiResponse.errorResponse(res, 'Could not sign you in. Please try again.');
    }
};

export = {
    _authAdminLogin
};
