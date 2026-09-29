'use strict';

/**
 * ============================================================================
 *  AUDIT ROUTES — mounted GUARDED at /api/audit-events
 * ============================================================================
 *
 *  The security activity log (sign-ins, invitations, role changes, resets).
 *  Read-only over HTTP: rows are written by the auth services, never by a
 *  request that names what to record.
 * ============================================================================
 */

import { Router } from 'express';
import auditController = require('../controllers/audit.controller');
import requirePermissionMiddleware = require('../middlewares/requirePermission');
import authModule = require('../modules/auth');

const { _listAuditEvents } = auditController;
const { requirePermission } = requirePermissionMiddleware;
const { PERMISSIONS } = authModule;

const router = Router();

router.get('/', requirePermission(PERMISSIONS.AUDIT_READ), _listAuditEvents);

export = router;
