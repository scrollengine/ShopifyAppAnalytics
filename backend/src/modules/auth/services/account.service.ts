'use strict';

/**
 * ============================================================================
 *  ACCOUNT — what a signed-in person sees and may change about themselves
 * ============================================================================
 *
 *  `GET /api/account` is what the dashboard builds its session context from:
 *  who you are, your role, your permissions (resolved from the database on
 *  this request — the same derivation the guard used), and your session's
 *  expiry. `PATCH /api/account` changes the display name. There is no email
 *  change (spec A21: disable and re-invite instead).
 *
 *  Sign-out, change-password and revoke-others live in `session.service` /
 *  `password.service`.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import authConstants = require('../constants/auth.constants');
import auditConstants = require('../constants/audit.constants');
import identityHelper = require('../helpers/identity.helper');
import requestContextHelper = require('../helpers/requestContext.helper');
import serviceResultHelper = require('../helpers/serviceResult.helper');
import userRepository = require('../repositories/user.repository');
import principalService = require('./principal.service');
import auditService = require('./audit.service');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type { AccountView, LoadedPrincipal, SessionParams, UpdateAccountParams } from '../types/auth.types';

const { AUTH_MESSAGES, AUTH_ERROR_CODES, USER_STATUSES, AUDIT_ACTOR_TYPES, AUDIT_TARGET_TYPES } = authConstants;
const { AUDIT_ACTIONS } = auditConstants;

/**
 * `GET /api/account` (@self).
 *
 * @param identity - `{ user_id }` from the guard.
 * @param params - `{ session_id }` — `req.auth.session_id`.
 * @returns Resolves `AccountView` (`{ user, role, permissions, session }`); the `loadPrincipal`
 *     refusal codes otherwise (401 / 503).
 */
const getAccount = (identity: IdentityObject, params: SessionParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const userId = identity && identity.user_id;
            const sessionId = params !== null && typeof params === 'object' ? params.session_id : undefined;
            const loaded = await principalService.loadPrincipal(identity, { user_id: userId, session_id: sessionId });
            if (!loaded.status) {
                return resolve(loaded);
            }
            const data: LoadedPrincipal = loaded.data;
            const user = await userRepository.findById(data.principal.user_id);
            if (!user) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SESSION_INVALID, AUTH_MESSAGES.SESSION_INVALID));
            }
            const account: AccountView = {
                user: {
                    user_id: data.principal.user_id,
                    email: data.principal.email,
                    name: data.principal.name,
                    created_at: user.createdAt || null,
                    last_login_at: user.last_login_at || null
                },
                role: { key: data.principal.role_key, label: data.principal.role_label, is_owner: data.principal.is_owner },
                permissions: data.principal.permissions,
                session: { session_id: data.session.session_id, expires_at: data.session.expires_at }
            };
            return resolve(promiseHelper.promiseReturnResult(true, account, {}, AUTH_MESSAGES.ACCOUNT_OK));
        } catch (error) {
            logger.customConsoleError('ERROR: auth account getAccount', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

/**
 * `PATCH /api/account` (@self) `{ name }`.
 *
 * @param identity - `{ user_id }` from the guard.
 * @param params - `{ name, request_ip }`.
 * @returns Resolves `{ user: { user_id, email, name, created_at, last_login_at } }`; 400 VALIDATION; 401 SESSION_INVALID.
 */
const updateAccountName = (identity: IdentityObject, params: UpdateAccountParams): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const userId = identity && identity.user_id;
            if (!identityHelper.isObjectIdString(userId)) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SESSION_INVALID, AUTH_MESSAGES.SESSION_INVALID));
            }
            const nameCheck = identityHelper.validateName(params !== null && typeof params === 'object' ? params.name : undefined);
            if (!nameCheck.ok) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.VALIDATION, nameCheck.reason, { field: 'name' }));
            }
            const context = requestContextHelper.requestContextOf(params);
            const current = await userRepository.findById(userId);
            if (!current || current.status !== USER_STATUSES.ACTIVE) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SESSION_INVALID, AUTH_MESSAGES.SESSION_INVALID));
            }
            const updated = await userRepository.updateName({ user_id: userId, name: nameCheck.value });
            if (!updated) {
                return resolve(serviceResultHelper.authFailure(AUTH_ERROR_CODES.SESSION_INVALID, AUTH_MESSAGES.SESSION_INVALID));
            }
            if (current.name !== updated.name) {
                await auditService.recordAuditEvent(identity, {
                    actor_type: AUDIT_ACTOR_TYPES.USER,
                    actor_user_id: userId,
                    actor_email: updated.email,
                    action: AUDIT_ACTIONS.ACCOUNT_NAME_CHANGED,
                    target_type: AUDIT_TARGET_TYPES.USER,
                    target_id: userId,
                    ip: context.ip
                });
            }
            const result = {
                user: {
                    user_id: String(updated._id),
                    email: updated.email,
                    name: updated.name,
                    created_at: updated.createdAt || null,
                    last_login_at: updated.last_login_at || null
                }
            };
            return resolve(promiseHelper.promiseReturnResult(true, result, {}, AUTH_MESSAGES.ACCOUNT_NAME_UPDATED));
        } catch (error) {
            logger.customConsoleError('ERROR: auth account updateAccountName', error);
            return resolve(serviceResultHelper.exceptionFailure(error));
        }
    });
};

export = {
    getAccount,
    updateAccountName
};
