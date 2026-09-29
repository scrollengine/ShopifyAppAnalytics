'use strict';

/**
 * ============================================================================
 *  INVITE ROUTES — mounted GUARDED at /api/invites
 * ============================================================================
 *
 *  Creating, re-sending, revoking and listing invitations. Each route declares
 *  its ONE policy as its first route-level middleware; the service then applies
 *  the management rule to the invitation's role.
 *
 *  ⚠️ NOT to be confused with `/api/auth/invites/inspect` and
 *  `/api/auth/invites/accept`, which are PUBLIC (the invitee has no session yet)
 *  and live in auth.routes.ts. Everything here needs a session.
 * ============================================================================
 */

import { Router } from 'express';
import inviteController = require('../controllers/invite.controller');
import requirePermissionMiddleware = require('../middlewares/requirePermission');
import authModule = require('../modules/auth');

const { _listInvites, _createInvite, _resendInvite, _revokeInvite } = inviteController;
const { requirePermission } = requirePermissionMiddleware;
const { PERMISSIONS } = authModule;

const router = Router();

router.get('/', requirePermission(PERMISSIONS.USERS_READ), _listInvites);

router.post('/', requirePermission(PERMISSIONS.USERS_MANAGE), _createInvite);

// A fresh link and expiry; the old link dies. Throttled per invite (≥ 60 s apart, ≤ 5 per 24 h).
router.post('/:invite_id/resend', requirePermission(PERMISSIONS.USERS_MANAGE), _resendInvite);

router.post('/:invite_id/revoke', requirePermission(PERMISSIONS.USERS_MANAGE), _revokeInvite);

export = router;
