'use strict';

/**
 * ============================================================================
 *  AUDIT CONTROLLER — /api/audit-events (audit:read)
 * ============================================================================
 *
 *  The security activity log, newest first, one page at a time. Paging is a
 *  cursor (`next_before`), not an offset, so rows written while someone reads
 *  cannot shift a page.
 *
 *  `limit` and `before` are forwarded RAW from the query string: the service
 *  owns their rules (limit clamped to 1..200, cursor `'<iso>|<objectId>'` or a
 *  bare ISO time) and answers 400 VALIDATION itself, so the two cannot drift.
 *
 *  Error codes map to HTTP through ONE table, `AUTH_ERROR_HTTP_STATUS`, via
 *  `apiResponse.serviceFailureResponse`.
 * ============================================================================
 */

import type { Request, Response } from 'express';
import apiResponse = require('../utils/apiResponse');
import logger = require('../core/logger');
import authModule = require('../modules/auth');

const { customConsoleError } = logger;
const { AUTH_MESSAGES, AUTH_ERROR_HTTP_STATUS } = authModule;

/**
 * `GET /api/audit-events?limit=50&before=<cursor>` — one page of the security log.
 *
 * @param req - Express request. Query: `limit?`, `before?`.
 * @param res - Express response.
 * @returns 200 `{ items, next_before }`; 400 VALIDATION; 401; 403; 503.
 */
const _listAuditEvents = async (req: Request, res: Response) => {
    try {
        if (typeof req.user_id !== 'string' || !req.user_id) {
            return apiResponse.unauthorizedResponse(res, AUTH_MESSAGES.SESSION_INVALID);
        }
        const q = (req.query || {}) as Record<string, unknown>;
        const serviceResponse = await authModule.listAuditEvents({ user_id: req.user_id }, {
            limit: q.limit,
            before: q.before
        });
        if (!serviceResponse.status) {
            return apiResponse.serviceFailureResponse(res, serviceResponse, AUTH_ERROR_HTTP_STATUS);
        }
        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: auditController _listAuditEvents', error);
        return apiResponse.errorResponse(res, AUTH_MESSAGES.INTERNAL_ERROR);
    }
};

export = {
    _listAuditEvents
};
