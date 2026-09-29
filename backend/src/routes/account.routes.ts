'use strict';

/**
 * ============================================================================
 *  ACCOUNT ROUTES — mounted GUARDED at /api/account
 * ============================================================================
 *
 *  The signed-in user's own account. Every route is `@self`: `requireSelf()` is
 *  the policy, as the FIRST route-level middleware (spec §4 / A16). Nothing here
 *  takes a user id — the handlers act on `req.user_id` alone.
 *
 *  `authenticate` is applied once, on the parent sub-router in
 *  src/routes/index.ts; test/routeGuard.test.js asserts it and
 *  test/permissionMap.test.js pins the policy on every route below.
 * ============================================================================
 */

import { Router } from 'express';
import accountController = require('../controllers/account.controller');
import requirePermissionMiddleware = require('../middlewares/requirePermission');

const {
    _getAccountProfile,
    _updateAccountName,
    _changeAccountPassword,
    _logoutAccountSession,
    _revokeAccountOtherSessions
} = accountController;
const { requireSelf } = requirePermissionMiddleware;

const router = Router();

// Who am I, what role do I hold, what may I do — the dashboard's session context reads this once.
router.get('/', requireSelf(), _getAccountProfile);

router.patch('/', requireSelf(), _updateAccountName);

// Answers a FRESH token: the session making the request ends with it (spec A4).
router.post('/password', requireSelf(), _changeAccountPassword);

// Current session only. No epoch bump — the user's other devices stay signed in.
router.post('/logout', requireSelf(), _logoutAccountSession);

// Every other session ends, and this one is replaced: answers a FRESH token (spec A4 / A16).
router.post('/sessions/revoke-others', requireSelf(), _revokeAccountOtherSessions);

export = router;
