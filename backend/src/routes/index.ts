'use strict';

/**
 * ============================================================================
 *    THE SECURITY SEAM
 * ============================================================================
 *
 *  This file decides what the internet can reach. It is the ONLY place in the
 *  application where authentication is applied, and it is structured so that
 *  the default for a newly added router is GUARDED.
 *
 *  ── The failure this shape exists to prevent ────────────────────────────────
 *  The obvious alternative is to mount every router on one `router` and add the
 *  guard per route file. That has shipped as a real, total authentication
 *  bypass: the analytics route files each mounted their handlers BARE, the
 *  guard lived one level up at the router mount, and a later route file added
 *  in the same style — correct-looking, reviewed, merged — was mounted on the
 *  wrong parent. Nothing errored. Nothing logged. The entire analytics API was
 *  served to anonymous callers, and it looked exactly like a working install.
 *
 *  The lesson is not "remember the guard". It is that a guard you have to
 *  remember is a guard you will eventually forget. So:
 *
 *  ── How to read this file ───────────────────────────────────────────────────
 *  There are exactly TWO surfaces below, and they are separated by a hard line:
 *
 *    1. PUBLIC   — everything mounted directly on `router`: `GET /healthz` and
 *                  the `/api/auth` router. The complete public surface is the
 *                  ALLOWLIST in test/routeGuard.test.js (spec §8):
 *
 *                      GET  /healthz
 *                      POST /api/auth/login
 *                      GET  /api/auth/setup
 *                      POST /api/auth/setup
 *                      POST /api/auth/setup/inspect
 *                      POST /api/auth/setup/complete
 *                      POST /api/auth/invites/inspect
 *                      POST /api/auth/invites/accept
 *                      POST /api/auth/password/forgot
 *                      POST /api/auth/password/reset
 *
 *                  Each exists because its caller has no session YET: a
 *                  readiness probe, signing in, first-run setup, accepting an
 *                  invitation, recovering a forgotten password. Adding to this
 *                  list is publishing an unauthenticated endpoint — a security
 *                  decision that needs to be argued for, not a routing one.
 *
 *    2. GUARDED  — everything mounted on `guardedApiRouter`, which has
 *                  `authenticate` installed as its FIRST layer. Express runs a
 *                  router's own middleware before dispatching to anything
 *                  mounted on it, so a sub-router added here is behind the
 *                  guard the moment it is added — no second step, nothing to
 *                  remember, nothing to review for.
 *
 *  ── Authentication here; authorisation per route ───────────────────────────
 *  `authenticate` answers "who is this" once, here. "May they do THIS" is the
 *  `requirePermission(...)` / `requireSelf()` each guarded route declares as its
 *  FIRST route-level middleware, beside its handler (spec §4). There is
 *  deliberately no router-level permission: one line far from the handler
 *  covering everything below it is the shape this file exists to avoid.
 *  test/permissionMap.test.js pins the key on every route.
 *
 *  ── Fail-closed ordering ────────────────────────────────────────────────────
 *  `/api/auth` is registered BEFORE `/api`, so the public flows match the
 *  public router first. Anything under `/api/auth` that the auth router does
 *  NOT handle — a wrong method, an invented path — falls through to the
 *  guarded mount and is answered with 401 rather than 404. That is the correct
 *  direction to be wrong in: an unknown path under a public prefix ends up
 *  demanding a token, not skipping one.
 *
 *  ── This is asserted, not just documented ───────────────────────────────────
 *  A test walks the live Express stack and fails on any route reachable without
 *  `authenticate` beyond the allowlist above. Adding a public route here without
 *  updating that allowlist breaks the build, which is the point: the discussion
 *  happens in review rather than in an incident.
 * ============================================================================
 */

import { Router } from 'express';

import authenticateMiddleware = require('../middlewares/authenticate');
import healthController = require('../controllers/health.controller');

import authRoutes = require('./auth.routes');
import accountRoutes = require('./account.routes');
import userRoutes = require('./user.routes');
import inviteRoutes = require('./invite.routes');
import roleRoutes = require('./role.routes');
import auditRoutes = require('./audit.routes');
import partnerAppRoutes = require('./partnerApp.routes');
import syncRoutes = require('./sync.routes');
import revenueRoutes = require('./revenue.routes');
import funnelRoutes = require('./funnel.routes');
import conversionRoutes = require('./conversion.routes');
import storeRoutes = require('./store.routes');
import countryRoutes = require('./country.routes');
import subscriptionRoutes = require('./subscription.routes');
import metaRoutes = require('./meta.routes');

const { authenticate } = authenticateMiddleware;
const { _healthLiveness } = healthController;

const router = Router();


/* ==========================================================================
 *  1. PUBLIC SURFACE — no token required
 *
 *  Reachable by anyone who can reach the port. The full list of public
 *  endpoints is in this file's header and in test/routeGuard.test.js.
 *
 *   Do not add to it without a reason you would defend in an incident review.
 *  If a route needs a session, it belongs in section 2.
 * ========================================================================== */

// Readiness. Returns 503 until a sync has completed, 200 after. Deliberately
// says nothing that identifies the business — see health.controller.ts.
router.get('/healthz', _healthLiveness);

// Sign-in, first-run setup, invitation acceptance, password reset — the flows a
// caller runs BEFORE they hold a session. Registered before the guarded /api
// mount so it matches first; anything it does not handle falls through to the
// guard. Read auth.routes.ts before adding to it.
router.use('/api/auth', authRoutes);


/* ==========================================================================
 *  2. GUARDED SURFACE — authenticate, applied once, for everything below
 *
 *  `guardedApiRouter` carries the guard as its first layer. Every router
 *  mounted on it inherits that; each route inside declares its own permission
 *  policy beside its handler.
 *
 *  To add a protected area: import its router above and add ONE `.use()`
 *  line to this block. There is no second step for authentication — but every
 *  route in the new file must declare `requirePermission(...)` or
 *  `requireSelf()` as its first route-level middleware.
 * ========================================================================== */

const guardedApiRouter = Router();

//  FIRST LAYER, before any mount below. Moving this line downwards silently
// unguards every router registered above it.
guardedApiRouter.use(authenticate);

guardedApiRouter.use('/account', accountRoutes);
guardedApiRouter.use('/users', userRoutes);
guardedApiRouter.use('/invites', inviteRoutes);
guardedApiRouter.use('/roles', roleRoutes);
guardedApiRouter.use('/audit-events', auditRoutes);
guardedApiRouter.use('/partner-apps', partnerAppRoutes);
guardedApiRouter.use('/sync', syncRoutes);
guardedApiRouter.use('/revenue', revenueRoutes);
guardedApiRouter.use('/funnel', funnelRoutes);
guardedApiRouter.use('/conversion', conversionRoutes);
guardedApiRouter.use('/stores', storeRoutes);
// ⚠️ A SECOND ROUTER ON THE SAME MOUNT, on purpose. `GET /api/stores/countries` is a rollup OF the
// roster and the frontend already documents that path, but it is its own area — its own controller,
// service and vocabulary — so it gets its own file rather than a third line in `store.routes.ts`.
// Express falls through a router that handles nothing, so `storeRoutes` declines `/countries` and
// this one picks it up. Both are mounted here, so both are behind `authenticate`.
guardedApiRouter.use('/stores', countryRoutes);
guardedApiRouter.use('/subscriptions', subscriptionRoutes);
guardedApiRouter.use('/meta', metaRoutes);

router.use('/api', guardedApiRouter);


export = router;
