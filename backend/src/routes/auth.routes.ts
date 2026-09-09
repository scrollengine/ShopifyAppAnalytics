'use strict';

/**
 * ============================================================================
 *  AUTH ROUTES — mounted PUBLIC at /api/auth
 * ============================================================================
 *
 *   This is the one router in the application that is deliberately mounted
 *  OUTSIDE the guarded sub-router (see src/routes/index.ts). Anything added to
 *  this file is reachable by an anonymous caller.
 *
 *  Login is the only route that belongs here. A "who am I" / "refresh" / "log
 *  out" route is NOT an exception waiting to be made — those take a token, so
 *  they belong behind the guard like everything else.
 * ============================================================================
 */

import { Router } from 'express';
import authController = require('../controllers/auth.controller');

const { _authAdminLogin } = authController;

const router = Router();

// PUBLIC. There is no token to check yet — this is where one is issued.
router.post('/login', _authAdminLogin);

export = router;
