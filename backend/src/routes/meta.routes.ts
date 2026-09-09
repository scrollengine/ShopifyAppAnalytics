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
 * ============================================================================
 */

import { Router } from 'express';
import metaController = require('../controllers/meta.controller');

const { _metaCoverage } = metaController;

const router = Router();

router.get('/coverage', _metaCoverage);

export = router;
