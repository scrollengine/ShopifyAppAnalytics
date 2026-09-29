'use strict';

/**
 * ============================================================================
 *  AUTH ROUTES — mounted PUBLIC at /api/auth
 * ============================================================================
 *
 *  ⚠️ The one router deliberately mounted OUTSIDE the guarded sub-router (see
 *  src/routes/index.ts). Everything in this file is reachable by an anonymous
 *  caller, and every entry here is also an entry in the ALLOWLIST of
 *  test/routeGuard.test.js — adding a route here without adding it there fails
 *  the build, which is the point.
 *
 *  What belongs here: the flows that happen BEFORE the caller has a session —
 *  sign in, first-run setup, accepting an invitation, and resetting a forgotten
 *  password. What does not: anything that takes a session ("who am I", sign
 *  out, change password). Those live under /api/account, behind the guard.
 *
 *  ── Rate limits (spec A5) ───────────────────────────────────────────────────
 *  Declared per route, here, so each route's throttle is visible beside it:
 *    - POST /login           `loginRateLimit`, mounted app-level on
 *                            LOGIN_RATE_LIMIT_PATH in src/apps/app.ts (behind
 *                            its own 8 KB parser, before the general one).
 *                            Not repeated here.
 *    - GET  /setup           none — it reads one document and says nothing
 *                            about any account.
 *    - POST /setup           `setupRequestRateLimit`   (per address)
 *    - POST /password/forgot `passwordForgotRateLimit` (per address)
 *    - the five TOKEN routes `tokenFlowRateLimit`      (per token)
 *  Each is its own tally: spending one never refuses another.
 *
 *  Every public POST answers a `{}` body with 400 and no database access.
 * ============================================================================
 */

import { Router } from 'express';
import authController = require('../controllers/auth.controller');
import authFlowRateLimitMiddleware = require('../middlewares/authFlowRateLimit');

const {
    _createAuthSession,
    _getAuthSetupStatus,
    _requestAuthSetup,
    _inspectAuthSetupToken,
    _completeAuthSetup,
    _inspectAuthInvite,
    _acceptAuthInvite,
    _requestAuthPasswordReset,
    _resetAuthPassword
} = authController;
const { tokenFlowRateLimit, passwordForgotRateLimit, setupRequestRateLimit } = authFlowRateLimitMiddleware;

const router = Router();

// ── Sign in ─────────────────────────────────────────────────────────────────
// There is no session to check yet — this is where one is issued.
router.post('/login', _createAuthSession);

// ── First-run setup (open only until it completes; then 409 for good) ────────
router.get('/setup', _getAuthSetupStatus);
router.post('/setup', setupRequestRateLimit, _requestAuthSetup);
router.post('/setup/inspect', tokenFlowRateLimit, _inspectAuthSetupToken);
router.post('/setup/complete', tokenFlowRateLimit, _completeAuthSetup);

// ── Accepting an invitation (creating one is guarded: /api/invites) ──────────
router.post('/invites/inspect', tokenFlowRateLimit, _inspectAuthInvite);
router.post('/invites/accept', tokenFlowRateLimit, _acceptAuthInvite);

// ── Forgotten password ──────────────────────────────────────────────────────
router.post('/password/forgot', passwordForgotRateLimit, _requestAuthPasswordReset);
router.post('/password/reset', tokenFlowRateLimit, _resetAuthPassword);

export = router;
