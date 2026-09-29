'use strict';

/**
 * ============================================================================
 *  ROLE ROUTES — mounted GUARDED at /api/roles
 * ============================================================================
 *
 *  Listing needs users:read (the team page shows roles next to people). Writing
 *  needs roles:manage, which is owner-only and cannot be granted to any role.
 *  Each route declares its ONE policy as its first route-level middleware.
 * ============================================================================
 */

import { Router } from 'express';
import roleController = require('../controllers/role.controller');
import requirePermissionMiddleware = require('../middlewares/requirePermission');
import authModule = require('../modules/auth');

const { _listRoles, _createRole, _updateRole, _deleteRole } = roleController;
const { requirePermission } = requirePermissionMiddleware;
const { PERMISSIONS } = authModule;

const router = Router();

router.get('/', requirePermission(PERMISSIONS.USERS_READ), _listRoles);

router.post('/', requirePermission(PERMISSIONS.ROLES_MANAGE), _createRole);

router.patch('/:role_id', requirePermission(PERMISSIONS.ROLES_MANAGE), _updateRole);

// Refused with 409 while any user or live invitation references the role.
router.delete('/:role_id', requirePermission(PERMISSIONS.ROLES_MANAGE), _deleteRole);

export = router;
