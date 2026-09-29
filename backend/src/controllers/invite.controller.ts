'use strict';

/**
 * ============================================================================
 *  INVITE CONTROLLER — /api/invites (users:read to list, users:manage to act)
 * ============================================================================
 *
 *  Invite a teammate by email, re-send, revoke, and list what is outstanding.
 *  There is no public sign-up: an invitation is the only way anyone other than
 *  the owner gets an account. Accepting one is public and lives in
 *  `auth.controller.ts`.
 *
 *  Each service re-loads the ACTOR from the database by `req.user_id` and applies
 *  the management rule to the invitation's ROLE — nobody invites at or above
 *  their own permissions. The controller passes ids and body fields by name.
 *
 *  ⚠️ `email_sent: false` is still a success (201/200): the invitation EXISTS and
 *  can be re-sent once mail works. "Sent" means accepted by the mail server,
 *  never delivered. `link_host_is_loopback: true` means APP_PUBLIC_URL points at
 *  this machine, so the link will not open anywhere else.
 *
 *  Error codes map to HTTP through ONE table, `AUTH_ERROR_HTTP_STATUS`, via
 *  `apiResponse.serviceFailureResponse` (409 ALREADY_A_MEMBER carries `user_id`
 *  and `status` for the caller, who holds users:read).
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
 * `GET /api/invites` — every invitation, newest first, with its computed state.
 *
 * @param req - Express request.
 * @param res - Express response.
 * @returns 200 `{ items: InviteView[], mail }`; 401; 403; 503.
 */
const _listInvites = async (req: Request, res: Response) => {
    try {
        const actor = _actorOf(req);
        if (!actor) {
            return _notAuthenticated(res);
        }
        const serviceResponse = await authModule.listInvites(actor, {});
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: inviteController _listInvites', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/invites` — create an invitation and email it.
 *
 * @param req - Express request. Body: `{ email, role_key, custom_role_id? }`.
 * @param res - Express response.
 * @returns 201 `{ invite, email_sent, email_status, link_host_is_loopback }`; 400; 401; 403; 404;
 *     409 ALREADY_A_MEMBER / INVITE_PENDING; 429; 503.
 */
const _createInvite = async (req: Request, res: Response) => {
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
        const serviceResponse = await authModule.createInvite(actor, {
            email: b.email,
            role_key: b.role_key,
            custom_role_id: b.custom_role_id,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.createdResponse(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: inviteController _createInvite', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/invites/:invite_id/resend` — a fresh link and a fresh expiry, emailed again. The old
 * link stops working.
 *
 * @param req - Express request. Params: `invite_id`.
 * @param res - Express response.
 * @returns 200 `{ invite, email_sent, email_status, link_host_is_loopback }`; 401; 403; 404;
 *     409 INVITE_NOT_PENDING / ROLE_NOT_FOUND / ALREADY_A_MEMBER; 429; 503.
 */
const _resendInvite = async (req: Request, res: Response) => {
    try {
        const actor = _actorOf(req);
        if (!actor) {
            return _notAuthenticated(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.resendInvite(actor, {
            invite_id: req.params.invite_id,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: inviteController _resendInvite', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

/**
 * `POST /api/invites/:invite_id/revoke` — the link stops working.
 *
 * @param req - Express request. Params: `invite_id`.
 * @param res - Express response.
 * @returns 200 `{ invite }`; 401; 403; 404; 409 INVITE_NOT_PENDING; 503.
 */
const _revokeInvite = async (req: Request, res: Response) => {
    try {
        const actor = _actorOf(req);
        if (!actor) {
            return _notAuthenticated(res);
        }
        const context = _requestContext(req);
        const serviceResponse = await authModule.revokeInvite(actor, {
            invite_id: req.params.invite_id,
            request_ip: context.request_ip,
            user_agent: context.user_agent
        });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: inviteController _revokeInvite', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

export = {
    _listInvites,
    _createInvite,
    _resendInvite,
    _revokeInvite
};
