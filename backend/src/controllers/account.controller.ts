'use strict';

/**
 * ============================================================================
 *  ACCOUNT CONTROLLER — /api/account (@self)
 * ============================================================================
 *
 *  The signed-in user's own account: who am I and what may I do, my name, my
 *  password, sign out, sign out my other sessions. Every route carries
 *  `requireSelf()` — no permission key, because these only ever read or change
 *  the caller's own row, and `authenticate` has already proved the caller is
 *  signed in and active.
 *
 *  The acting user is `req.user_id` and the session is `req.auth.session_id`,
 *  both written by `authenticate` alone. Nothing in a body or a path can name
 *  another user here.
 *
 *  ⚠️ Change-password and revoke-others END the session the caller is using and
 *  hand back a fresh token (spec A4). The frontend must store it; the old one is
 *  refused from the next request. Those two responses are `no-store`.
 *
 *  Error codes map to HTTP through ONE table, `AUTH_ERROR_HTTP_STATUS`, via
 *  `apiResponse.serviceFailureResponse`. A wrong current password is 400, never
 *  401 — the dashboard signs out on any 401.
 * ============================================================================
 */

import type { Request, Response } from 'express';
import apiResponse = require('../utils/apiResponse');
import clientAddress = require('../utils/clientAddress');
import logger = require('../core/logger');
import authModule = require('../modules/auth');

import type { IdentityObject } from '../types/service.types';

const { customConsoleError } = logger;
const { AUTH_MESSAGES, AUTH_ERROR_CODES, AUTH_ERROR_HTTP_STATUS } = authModule;

/**
 * The caller's identity and session, as written by `authenticate`. `null` when either is missing —
 * the guard did not run, and the handler must refuse rather than guess.
 *
 * @param req - Express request.
 * @returns `{ identity, session_id }`, or `null`.
 */
const _selfOf = (req: Request): { identity: IdentityObject; session_id: string } | null => {
    if (typeof req.user_id !== 'string' || !req.user_id || !req.auth || typeof req.auth.session_id !== 'string') {
        return null;
    }
    return { identity: { user_id: req.user_id }, session_id: req.auth.session_id };
};

/**
 * The parsed JSON body as a plain object, or `null` when it is an array or a primitive.
 *
 * @param req - Express request.
 * @returns The body, or `null`.
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
 * The 401 for a request that reached a self-service handler without an auth context.
 *
 * @param res - Express response.
 * @returns The sent response.
 */
const _notAuthenticated = (res: Response): Response => {
    return apiResponse.unauthorizedResponse(res, AUTH_MESSAGES.SESSION_INVALID);
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
 * `GET /api/account` — the caller's profile, role, permissions and session.
 *
 * @param req - Express request.
 * @param res - Express response.
 * @returns 200 `{ user, role, permissions, session }`; 401; 503.
 */
const _getAccountProfile = async (req: Request, res: Response) => {
    try {
        const self = _selfOf(req);
        if (!self) {
            return _notAuthenticated(res);
        }
        const serviceResponse = await authModule.getAccount(self.identity, { session_id: self.session_id });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: accountController _getAccountProfile', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `PATCH /api/account` — change the caller's display name.
 *
 * @param req - Express request. Body: `{ name }`.
 * @param res - Express response.
 * @returns 200 `{ user }`; 400 VALIDATION; 401; 503.
 */
const _updateAccountName = async (req: Request, res: Response) => {
    try {
        const self = _selfOf(req);
        if (!self) {
            return _notAuthenticated(res);
        }
        const b = _bodyOf(req);
        if (!b) {
            return _bodyNotAnObject(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.updateAccountName(self.identity, {
            name: b.name,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: accountController _updateAccountName', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/account/password` — change the caller's password. Every OTHER session ends, and the
 * caller's own session is replaced: the response carries the fresh token.
 *
 * @param req - Express request. Body: `{ current_password, new_password }`.
 * @param res - Express response.
 * @returns 200 `{ token, expires_at, expires_in_seconds, revoked }`; 400 VALIDATION /
 *     CURRENT_PASSWORD_INCORRECT / PASSWORD_POLICY; 401; 503.
 */
const _changeAccountPassword = async (req: Request, res: Response) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const self = _selfOf(req);
        if (!self) {
            return _notAuthenticated(res);
        }
        const b = _bodyOf(req);
        if (!b) {
            return _bodyNotAnObject(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.changePassword(self.identity, {
            current_password: b.current_password,
            new_password: b.new_password,
            session_id: self.session_id,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: accountController _changeAccountPassword', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/account/logout` — ends the caller's CURRENT session only. Idempotent.
 *
 * @param req - Express request.
 * @param res - Express response.
 * @returns 200 `{ revoked }`; 401; 503.
 */
const _logoutAccountSession = async (req: Request, res: Response) => {
    try {
        const self = _selfOf(req);
        if (!self) {
            return _notAuthenticated(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.logout(self.identity, {
            session_id: self.session_id,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: accountController _logoutAccountSession', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/account/sessions/revoke-others` — signs the caller out everywhere else. The caller's
 * own session is replaced too: the response carries the fresh token.
 *
 * @param req - Express request.
 * @param res - Express response.
 * @returns 200 `{ token, expires_at, expires_in_seconds, revoked }`; 401; 503.
 */
const _revokeAccountOtherSessions = async (req: Request, res: Response) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const self = _selfOf(req);
        if (!self) {
            return _notAuthenticated(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.revokeOtherSessions(self.identity, {
            session_id: self.session_id,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: accountController _revokeAccountOtherSessions', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

export = {
    _getAccountProfile,
    _updateAccountName,
    _changeAccountPassword,
    _logoutAccountSession,
    _revokeAccountOtherSessions
};
