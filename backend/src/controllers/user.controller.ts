'use strict';

/**
 * ============================================================================
 *  USER CONTROLLER — /api/users (users:read to list, users:manage to act)
 * ============================================================================
 *
 *  The team list and the actions an admin takes on a teammate: change role,
 *  disable, enable, sign out everywhere, send a password-reset email.
 *
 *  The route policy (`requirePermission`) is only the first check. Each service
 *  re-loads the ACTOR from the database by `req.user_id` and applies THE
 *  management rule — never on yourself, never on the owner, only on people whose
 *  permissions are strictly below yours — so this controller passes the actor's
 *  id and the target's id and nothing else about either. It never hands a
 *  principal to a service.
 *
 *  Error codes map to HTTP through ONE table, `AUTH_ERROR_HTTP_STATUS`, via
 *  `apiResponse.serviceFailureResponse`: a management refusal is 403 with
 *  `reason`, an unknown or malformed id is 404, a status conflict is 409, the
 *  admin reset throttle is 429, and a datastore failure while re-loading the
 *  actor is 503 — never 401, never 403.
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
 * The acting user's identity, as written by `authenticate`. `null` when the guard did not run.
 *
 * @param req - Express request.
 * @returns `{ user_id }`, or `null`.
 */
const _actorOf = (req: Request): IdentityObject | null => {
    if (typeof req.user_id !== 'string' || !req.user_id) {
        return null;
    }
    return { user_id: req.user_id };
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
 * The 401 for a request that reached an admin handler without an authenticated actor.
 *
 * @param res - Express response.
 * @returns The sent response.
 */
const _notAuthenticated = (res: Response): Response => {
    return apiResponse.unauthorizedResponse(res, AUTH_MESSAGES.SESSION_INVALID);
};

/**
 * `GET /api/users` — every teammate, with whether the caller may manage each one and why not.
 *
 * @param req - Express request.
 * @param res - Express response.
 * @returns 200 `{ items: UserView[], mail }`; 401; 403; 503.
 */
const _listUsers = async (req: Request, res: Response) => {
    try {
        const actor = _actorOf(req);
        if (!actor) {
            return _notAuthenticated(res);
        }
        const serviceResponse = await authModule.listUsers(actor, {});
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: userController _listUsers', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `PATCH /api/users/:user_id/role` — assign a built-in or custom role. Allowed on disabled users.
 *
 * @param req - Express request. Params: `user_id`. Body: `{ role_key, custom_role_id? }`.
 * @param res - Express response.
 * @returns 200 `{ user, invites_revoked }`; 400; 401; 403; 404; 409 TARGET_CHANGED; 503.
 */
const _changeUserRole = async (req: Request, res: Response) => {
    try {
        const actor = _actorOf(req);
        if (!actor) {
            return _notAuthenticated(res);
        }
        const b = _bodyOf(req);
        if (!b) {
            return apiResponse.validationErrorResponse(res, AUTH_MESSAGES.VALIDATION, { code: AUTH_ERROR_CODES.VALIDATION });
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.changeUserRole(actor, {
            user_id: req.params.user_id,
            role_key: b.role_key,
            custom_role_id: b.custom_role_id,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: userController _changeUserRole', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/users/:user_id/disable` — the user can no longer sign in; their sessions end and the
 * invitations they sent are revoked.
 *
 * @param req - Express request. Params: `user_id`.
 * @param res - Express response.
 * @returns 200 `{ user, sessions_revoked, invites_revoked }`; 401; 403; 404; 409; 503.
 */
const _disableUser = async (req: Request, res: Response) => {
    try {
        const actor = _actorOf(req);
        if (!actor) {
            return _notAuthenticated(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.disableUser(actor, {
            user_id: req.params.user_id,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: userController _disableUser', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/users/:user_id/enable` — the user can sign in again with their existing password.
 *
 * @param req - Express request. Params: `user_id`.
 * @param res - Express response.
 * @returns 200 `{ user }`; 401; 403; 404; 409; 503.
 */
const _enableUser = async (req: Request, res: Response) => {
    try {
        const actor = _actorOf(req);
        if (!actor) {
            return _notAuthenticated(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.enableUser(actor, {
            user_id: req.params.user_id,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: userController _enableUser', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/users/:user_id/sessions/revoke` — signs the user out everywhere.
 *
 * @param req - Express request. Params: `user_id`.
 * @param res - Express response.
 * @returns 200 `{ revoked }`; 401; 403; 404; 409; 503.
 */
const _revokeUserSessions = async (req: Request, res: Response) => {
    try {
        const actor = _actorOf(req);
        if (!actor) {
            return _notAuthenticated(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.revokeUserSessions(actor, {
            user_id: req.params.user_id,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: userController _revokeUserSessions', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/users/:user_id/password-reset` — emails the user a reset link. The admin never sets or
 * sees a password. "Sent" means accepted by the mail server, never delivered.
 *
 * @param req - Express request. Params: `user_id`.
 * @param res - Express response.
 * @returns 200 `{ email_sent, email_status }`; 401; 403; 404; 409 USER_STATUS_CONFLICT; 429; 503.
 */
const _sendUserPasswordReset = async (req: Request, res: Response) => {
    try {
        const actor = _actorOf(req);
        if (!actor) {
            return _notAuthenticated(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.adminSendPasswordReset(actor, {
            user_id: req.params.user_id,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: userController _sendUserPasswordReset', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

export = {
    _listUsers,
    _changeUserRole,
    _disableUser,
    _enableUser,
    _revokeUserSessions,
    _sendUserPasswordReset
};
