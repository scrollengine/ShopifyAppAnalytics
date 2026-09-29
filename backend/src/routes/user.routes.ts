'use strict';

/**
 * ============================================================================
 *  USER ROUTES — mounted GUARDED at /api/users
 * ============================================================================
 *
 *  The team list (users:read) and the actions on a teammate (users:manage).
 *  Each route declares its ONE policy as its first route-level middleware. The
 *  route policy is the coarse gate; the service then applies the management rule
 *  to the specific target (never yourself, never the owner, strictly below you).
 *
 *  ⚠️ Every action is a POST/PATCH on `/:user_id/<verb>` — two segments — so the
 *  literal `GET /` cannot be shadowed. Register any future single-segment
 *  `/:user_id` route LAST.
 * ============================================================================
 */

import { Router } from 'express';
import userController = require('../controllers/user.controller');
import requirePermissionMiddleware = require('../middlewares/requirePermission');
import authModule = require('../modules/auth');

const {
    _listUsers,
    _changeUserRole,
    _disableUser,
    _enableUser,
    _revokeUserSessions,
    _sendUserPasswordReset
} = userController;
const { requirePermission } = requirePermissionMiddleware;
const { PERMISSIONS } = authModule;

const router = Router();

router.get('/', requirePermission(PERMISSIONS.USERS_READ), _listUsers);

// No session revocation: permissions are re-read on every request, so the new role applies to the
// user's next request without signing them out.
router.patch('/:user_id/role', requirePermission(PERMISSIONS.USERS_MANAGE), _changeUserRole);

router.post('/:user_id/disable', requirePermission(PERMISSIONS.USERS_MANAGE), _disableUser);

router.post('/:user_id/enable', requirePermission(PERMISSIONS.USERS_MANAGE), _enableUser);

router.post('/:user_id/sessions/revoke', requirePermission(PERMISSIONS.USERS_MANAGE), _revokeUserSessions);

// Emails a reset link. The admin never sets, sees or receives a password.
router.post('/:user_id/password-reset', requirePermission(PERMISSIONS.USERS_MANAGE), _sendUserPasswordReset);

export = router;
