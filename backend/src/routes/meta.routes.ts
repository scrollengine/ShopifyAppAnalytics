'use strict';

/**
 * ============================================================================
 *  META ROUTES — mounted GUARDED at /api/meta
 * ============================================================================
 *
 *  Coverage says how far the synced history reaches and what is missing from
 *  it. That is a description of the install's data, so it sits behind the guard
 *  with everything else — the unauthenticated readiness signal is /healthz, and
 *  it says considerably less on purpose.
 *
 *  `apps:read` (spec §4): coverage gates and watermarks are the baseline every
 *  role holds, so every role can tell whether the numbers it sees are complete.
 * ============================================================================
 */

import { Router } from 'express';
import metaController = require('../controllers/meta.controller');
import requirePermissionMiddleware = require('../middlewares/requirePermission');
import authModule = require('../modules/auth');

const { _metaCoverage } = metaController;
const { requirePermission } = requirePermissionMiddleware;
const { PERMISSIONS } = authModule;

const router = Router();

router.get('/coverage', requirePermission(PERMISSIONS.APPS_READ), _metaCoverage);

export = router;
