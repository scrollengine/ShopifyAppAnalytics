'use strict';

/**
 * ============================================================================
 *  AUTH CONTROLLER — the public flows (mounted OUTSIDE the guard)
 * ============================================================================
 *
 *  Sign-in, first-run setup, invitation acceptance and password reset. Every
 *  handler here is reachable by an anonymous caller, and is written
 *  accordingly:
 *
 *    - Body shape is checked BEFORE any database access, by the controller (a
 *      JSON object) and then by the service (field types and token shape). A
 *      `{}` body answers 400 with no query at all — test/routeGuard.test.js
 *      probes every public POST that way with no database connected.
 *    - Fields are forwarded by name, never by spreading the body.
 *    - Sign-in never says WHICH half of the credentials was wrong, and the
 *      setup-request and forgot-password acknowledgements are identical whether
 *      or not anything will be sent. This controller adds nothing to either.
 *    - A token endpoint NEVER answers 401 (the dashboard signs out on a 401).
 *      Dead links are 400 TOKEN_INVALID / TOKEN_EXPIRED / TOKEN_USED /
 *      INVITE_REVOKED, and those that cost a guess mark the response for the
 *      token-flow limiter (`res.locals.rate_limit_charge`).
 *    - Every response carries `Cache-Control: no-store`: a sign-in token, a
 *      setup state or a link's email address must not sit in any cache.
 *
 *  Error codes map to HTTP through ONE table, `AUTH_ERROR_HTTP_STATUS`, via
 *  `apiResponse.serviceFailureResponse`. Services are called through the barrel
 *  OBJECT at request time so tests can stub them.
 * ============================================================================
 */

import type { Request, Response } from 'express';
import apiResponse = require('../utils/apiResponse');
import clientAddress = require('../utils/clientAddress');
import logger = require('../core/logger');
import authModule = require('../modules/auth');
import authFlowRateLimit = require('../middlewares/authFlowRateLimit');

import type { ServiceResult } from '../types/service.types';

const { customConsoleError } = logger;
const { AUTH_MESSAGES, AUTH_ERROR_CODES, AUTH_ERROR_HTTP_STATUS } = authModule;
const { RATE_LIMIT_CHARGE_LOCAL } = authFlowRateLimit;

/**
 * The dead-link outcomes that cost the caller a guess (spec A5). TOKEN_USED is not among them: only
 * a real link's holder can reach it, so it spends nothing an attacker could use.
 */
const CHARGED_TOKEN_FAILURES: ReadonlySet<string> = new Set([
    AUTH_ERROR_CODES.TOKEN_INVALID,
    AUTH_ERROR_CODES.TOKEN_EXPIRED,
    AUTH_ERROR_CODES.INVITE_REVOKED
]);

/**
 * Marks the response uncacheable. Called first in every handler, so an error path carries it too.
 *
 * @param res - Express response.
 */
const _noStore = (res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
};

/**
 * The parsed JSON body as a plain object, or `null` when it is an array or a primitive.
 *
 * A request with no JSON body at all reads as `{}`, so the service answers its own "missing field"
 * refusal instead of this one.
 *
 * @param req - Express request.
 * @returns The body, or `null` when it cannot be a request object.
 */
const _bodyOf = (req: Request): Record<string, unknown> | null => {
    const body: unknown = req.body;
    if (body === undefined || body === null) {
        return {};
    }
    if (typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }
    return body as Record<string, unknown>;
};

/**
 * The client context a flow records: `clientIp(req)` (the one source, spec A11) and the User-Agent.
 *
 * @param req - Express request.
 * @returns `{ request_ip, user_agent }`.
 */
const _requestContext = (req: Request): { request_ip: string | null; user_agent: string | null } => {
    const userAgent = req.headers['user-agent'];
    return {
        request_ip: clientAddress.clientIp(req),
        user_agent: typeof userAgent === 'string' ? userAgent : null
    };
};

/**
 * The 400 for a body that is not a JSON object.
 *
 * @param res - Express response.
 * @returns The sent response.
 */
const _bodyNotAnObject = (res: Response): Response => {
    return apiResponse.validationErrorResponse(res, AUTH_MESSAGES.VALIDATION, { code: AUTH_ERROR_CODES.VALIDATION });
};

/**
 * Answers a failed public-flow service result through the one code table, marking a dead-link 400
 * for the token-flow limiter first when the route is a token route.
 *
 * @param res - Express response.
 * @param serviceResponse - The failed envelope.
 * @param isTokenRoute - Whether this route is behind `tokenFlowRateLimit`.
 * @returns The sent response.
 */
const _failure = (res: Response, serviceResponse: ServiceResult, isTokenRoute: boolean): Response => {
    const code = serviceResponse.error && typeof serviceResponse.error === 'object' ? serviceResponse.error.code : undefined;
    if (isTokenRoute && typeof code === 'string' && CHARGED_TOKEN_FAILURES.has(code)) {
        res.locals[RATE_LIMIT_CHARGE_LOCAL] = true;
    }
    return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
};

/**
 * `POST /api/auth/login` — exchanges an email and password for a session token.
 *
 * ⚠️ The status codes ARE the interface to `loginRateLimit`, which charges 401 only: 400 for an
 * incomplete request, 401 for a rejected credential (one message for every cause), 500/503 for a
 * server fault — never 401 for a fault, or a database outage would spend everyone's budget.
 *
 * @param req - Express request. Body: `{ email, password }`.
 * @param res - Express response.
 * @returns 200 `{ token, expires_in_seconds, expires_at, user_id, email }`; 400; 401; 500; 503.
 */
const _createAuthSession = async (req: Request, res: Response) => {
    try {
        _noStore(res);
        const b = _bodyOf(req);
        if (!b) {
            return apiResponse.validationErrorResponse(res, AUTH_MESSAGES.CREDENTIALS_REQUIRED, { code: AUTH_ERROR_CODES.CREDENTIALS_REQUIRED });
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.login({}, {
            email: b.email,
            password: b.password,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return _failure(res, serviceResponse, false);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: authController _createAuthSession', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.LOGIN_FAILED);
    }
};

/**
 * `GET /api/auth/setup` — whether setup is complete, and while it is not: mail state, whether it is
 * restricted, and this site's configured address. Never echoes an email.
 *
 * @param _req - Express request.
 * @param res - Express response.
 * @returns 200 `SetupStatus`; 503 when the install state cannot be read.
 */
const _getAuthSetupStatus = async (_req: Request, res: Response) => {
    try {
        _noStore(res);
        const serviceResponse = await authModule.getSetupStatus();
        if (!serviceResponse.status) {
            return _failure(res, serviceResponse, false);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: authController _getAuthSetupStatus', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/auth/setup` — step 1 of setup: request a verification link.
 *
 * ALWAYS the same 202 for a well-formed request, whether or not the address may claim setup; the
 * email-dependent work runs after this response (spec A6).
 *
 * @param req - Express request. Body: `{ email, name }`.
 * @param res - Express response.
 * @returns 202 `{ accepted: true }`; 400; 409 SETUP_ALREADY_COMPLETE; 429 SETUP_CAPACITY; 503.
 */
const _requestAuthSetup = async (req: Request, res: Response) => {
    try {
        _noStore(res);
        const b = _bodyOf(req);
        if (!b) {
            return _bodyNotAnObject(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.requestSetup({}, {
            email: b.email,
            name: b.name,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return _failure(res, serviceResponse, false);
        }
        return apiResponse.acceptedResponse(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: authController _requestAuthSetup', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/auth/setup/inspect` — what a setup link is for. Consumes nothing.
 *
 * @param req - Express request. Body: `{ token }`.
 * @param res - Express response.
 * @returns 200 `{ email, name, expires_at }`; 400 TOKEN_*; 409 SETUP_ALREADY_COMPLETE; 503. Never 401.
 */
const _inspectAuthSetupToken = async (req: Request, res: Response) => {
    try {
        _noStore(res);
        const b = _bodyOf(req);
        if (!b) {
            return _bodyNotAnObject(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.inspectSetupToken({}, {
            token: b.token,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return _failure(res, serviceResponse, true);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: authController _inspectAuthSetupToken', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/auth/setup/complete` — step 2 of setup: choose the password, create the owner, lock
 * setup for good. Never signs anyone in.
 *
 * @param req - Express request. Body: `{ token, name, password }`.
 * @param res - Express response.
 * @returns 201 `{ setup_complete: true }`; 400 TOKEN_* / VALIDATION / PASSWORD_POLICY; 409; 503. Never 401.
 */
const _completeAuthSetup = async (req: Request, res: Response) => {
    try {
        _noStore(res);
        const b = _bodyOf(req);
        if (!b) {
            return _bodyNotAnObject(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.completeSetup({}, {
            token: b.token,
            name: b.name,
            password: b.password,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return _failure(res, serviceResponse, true);
        }
        return apiResponse.createdResponse(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: authController _completeAuthSetup', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/auth/invites/inspect` — what an invitation link is for. Consumes nothing.
 *
 * @param req - Express request. Body: `{ token }`.
 * @param res - Express response.
 * @returns 200 `{ email, role_label, invited_by_name, expires_at }`; 400 TOKEN_* / INVITE_REVOKED; 503. Never 401.
 */
const _inspectAuthInvite = async (req: Request, res: Response) => {
    try {
        _noStore(res);
        const b = _bodyOf(req);
        if (!b) {
            return _bodyNotAnObject(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.inspectInvite({}, {
            token: b.token,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return _failure(res, serviceResponse, true);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: authController _inspectAuthInvite', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/auth/invites/accept` — creates the invited account. Never signs anyone in.
 *
 * @param req - Express request. Body: `{ token, name, password }`.
 * @param res - Express response.
 * @returns 201 `{ accepted: true }`; 400 TOKEN_* / INVITE_REVOKED / VALIDATION / PASSWORD_POLICY;
 *     409 ALREADY_A_MEMBER; 503. Never 401.
 */
const _acceptAuthInvite = async (req: Request, res: Response) => {
    try {
        _noStore(res);
        const b = _bodyOf(req);
        if (!b) {
            return _bodyNotAnObject(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.acceptInvite({}, {
            token: b.token,
            name: b.name,
            password: b.password,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return _failure(res, serviceResponse, true);
        }
        return apiResponse.createdResponse(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: authController _acceptAuthInvite', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/auth/password/forgot` — request a reset link.
 *
 * ALWAYS the same 202 for a well-formed address, whether or not an active account uses it; the
 * lookup, throttles and send run after this response (spec A6).
 *
 * @param req - Express request. Body: `{ email }`.
 * @param res - Express response.
 * @returns 202 `{ accepted: true }`; 400 VALIDATION.
 */
const _requestAuthPasswordReset = async (req: Request, res: Response) => {
    try {
        _noStore(res);
        const b = _bodyOf(req);
        if (!b) {
            return _bodyNotAnObject(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.requestPasswordReset({}, {
            email: b.email,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return _failure(res, serviceResponse, false);
        }
        return apiResponse.acceptedResponse(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: authController _requestAuthPasswordReset', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/auth/password/reset` — set a new password from a reset link. Ends every session.
 * Never signs anyone in.
 *
 * @param req - Express request. Body: `{ token, password }`.
 * @param res - Express response.
 * @returns 200 `{ password_reset: true }`; 400 TOKEN_* / PASSWORD_POLICY; 503. Never 401.
 */
const _resetAuthPassword = async (req: Request, res: Response) => {
    try {
        _noStore(res);
        const b = _bodyOf(req);
        if (!b) {
            return _bodyNotAnObject(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.resetPassword({}, {
            token: b.token,
            password: b.password,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return _failure(res, serviceResponse, true);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: authController _resetAuthPassword', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

export = {
    _createAuthSession,
    _getAuthSetupStatus,
    _requestAuthSetup,
    _inspectAuthSetupToken,
    _completeAuthSetup,
    _inspectAuthInvite,
    _acceptAuthInvite,
    _requestAuthPasswordReset,
    _resetAuthPassword
};
