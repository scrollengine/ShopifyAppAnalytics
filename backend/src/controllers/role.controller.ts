'use strict';

/**
 * ============================================================================
 *  ROLE CONTROLLER — /api/roles (users:read to list, roles:manage to edit)
 * ============================================================================
 *
 *  The permission catalogue, the built-in roles (in code, read-only) and the
 *  custom roles the owner creates. `roles:manage` is owner-only and can never be
 *  granted, so in practice only the owner reaches the write routes.
 *
 *  Each service re-loads the ACTOR from the database by `req.user_id`. The body
 *  is forwarded by name — `permissions` as the raw array, which the service
 *  checks element by element (catalogue keys only, no owner-only key,
 *  `apps:read` present, every prerequisite held).
 *
 *  Error codes map to HTTP through ONE table, `AUTH_ERROR_HTTP_STATUS`, via
 *  `apiResponse.serviceFailureResponse` (400 VALIDATION carries `field` and the
 *  offending `keys`; 409 ROLE_NAME_TAKEN / ROLE_IN_USE).
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
 * The 400 for a body that is not a JSON object.
 *
 * @param res - Express response.
 * @returns The sent response.
 */
const _bodyNotAnObject = (res: Response): Response => {
    return apiResponse.validationErrorResponse(res, AUTH_MESSAGES.VALIDATION, { code: AUTH_ERROR_CODES.VALIDATION });
};

/**
 * `GET /api/roles` — the permission catalogue and every role, with which ones the CALLER may assign.
 *
 * @param req - Express request.
 * @param res - Express response.
 * @returns 200 `{ catalogue, roles }`; 401; 403; 503.
 */
const _listRoles = async (req: Request, res: Response) => {
    try {
        const actor = _actorOf(req);
        if (!actor) {
            return _notAuthenticated(res);
        }
        const serviceResponse = await authModule.listRoles(actor, {});
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: roleController _listRoles', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/roles` — create a custom role.
 *
 * @param req - Express request. Body: `{ name, description, permissions }`.
 * @param res - Express response.
 * @returns 201 `{ role }`; 400 VALIDATION; 401; 403; 409 ROLE_NAME_TAKEN; 503.
 */
const _createRole = async (req: Request, res: Response) => {
    try {
        const actor = _actorOf(req);
        if (!actor) {
            return _notAuthenticated(res);
        }
        const b = _bodyOf(req);
        if (!b) {
            return _bodyNotAnObject(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.createRole(actor, {
            name: b.name,
            description: b.description,
            permissions: b.permissions,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.createdResponse(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: roleController _createRole', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `PATCH /api/roles/:role_id` — edit a custom role. Outstanding invitations that the change puts out
 * of their inviter's reach are revoked.
 *
 * @param req - Express request. Params: `role_id`. Body: `{ name, description, permissions }`.
 * @param res - Express response.
 * @returns 200 `{ role, invites_revoked }`; 400; 401; 403; 404; 409 ROLE_NAME_TAKEN; 503.
 */
const _updateRole = async (req: Request, res: Response) => {
    try {
        const actor = _actorOf(req);
        if (!actor) {
            return _notAuthenticated(res);
        }
        const b = _bodyOf(req);
        if (!b) {
            return _bodyNotAnObject(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.updateRole(actor, {
            role_id: req.params.role_id,
            name: b.name,
            description: b.description,
            permissions: b.permissions,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: roleController _updateRole', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `DELETE /api/roles/:role_id` — delete a custom role that nobody holds and no live invitation names.
 *
 * @param req - Express request. Params: `role_id`.
 * @param res - Express response.
 * @returns 200 `{ deleted, role_id, invites_revoked }`; 401; 403; 404; 409 ROLE_IN_USE; 503.
 */
const _deleteRole = async (req: Request, res: Response) => {
    try {
        const actor = _actorOf(req);
        if (!actor) {
            return _notAuthenticated(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.deleteRole(actor, {
            role_id: req.params.role_id,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: roleController _deleteRole', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

export = {
    _listRoles,
    _createRole,
    _updateRole,
    _deleteRole
};
