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
 *    1. PUBLIC   — everything mounted directly on `router`.
 *                  TWO entries, matching the count section 1 states below. If
 *                  you are adding a third, stop: you are adding an
 *                  unauthenticated endpoint, and that is a security decision
 *                  that needs to be argued for, not a routing decision.
 *
 *    2. GUARDED  — everything mounted on `guardedApiRouter`, which has
 *                  `verifyAdmin` installed as its FIRST layer. Express runs a
 *                  router's own middleware before dispatching to anything
 *                  mounted on it, so a sub-router added here is behind the
 *                  guard the moment it is added — no second step, nothing to
 *                  remember, nothing to review for.
 *
 *  ── Fail-closed ordering ────────────────────────────────────────────────────
 *  `/api/auth` is registered BEFORE `/api`, so `POST /api/auth/login` matches
 *  the public router first. Anything under `/api/auth` that the auth router
 *  does NOT handle — a wrong method, an invented path — falls through to the
 *  guarded mount and is answered with 401 rather than 404. That is the correct
 *  direction to be wrong in: an unknown path under a public prefix ends up
 *  demanding a token, not skipping one.
 *
 *  ── This is asserted, not just documented ───────────────────────────────────
 *  A test walks the live Express stack and fails on any route reachable without
 *  `verifyAdmin` beyond the allowlist below. Adding a public route here without
 *  updating that allowlist breaks the build, which is the point: the discussion
 *  happens in review rather than in an incident.
 * ============================================================================
 */

import { Router } from 'express';

import verifyAdminMiddleware = require('../middlewares/verifyAdmin');
import healthController = require('../controllers/health.controller');

import authRoutes = require('./auth.routes');
import partnerAppRoutes = require('./partnerApp.routes');
import syncRoutes = require('./sync.routes');
import revenueRoutes = require('./revenue.routes');
import funnelRoutes = require('./funnel.routes');
import conversionRoutes = require('./conversion.routes');
import storeRoutes = require('./store.routes');
import countryRoutes = require('./country.routes');
import subscriptionRoutes = require('./subscription.routes');
import metaRoutes = require('./meta.routes');

const { verifyAdmin } = verifyAdminMiddleware;
const { _healthLiveness } = healthController;

const router = Router();


/* ==========================================================================
 *  1. PUBLIC SURFACE — no token required
 *
 *  Reachable by anyone who can reach the port. Two entries, and both are
 *  justified: a readiness probe cannot present a credential, and a login
 *  endpoint is where the credential comes from.
 *
 *   Do not add a third without a reason you would defend in an incident
 *  review. If a route needs a token, it belongs in section 2.
 * ========================================================================== */

// Readiness. Returns 503 until a sync has completed, 200 after. Deliberately
// says nothing that identifies the business — see health.controller.ts.
router.get('/healthz', _healthLiveness);

// Login. The only unauthenticated path under /api, and it must stay the only
// one. Registered before the guarded /api mount so it matches first.
router.use('/api/auth', authRoutes);


/* ==========================================================================
 *  2. GUARDED SURFACE — verifyAdmin, applied once, for everything below
 *
 *  `guardedApiRouter` carries the guard as its first layer. Every router
 *  mounted on it inherits that, which is why the domain route files mount
 *  their handlers bare: the guard is here, in one place, where it can be
 *  read and tested — not scattered across five files where its absence
 *  looks identical to its presence.
 *
 *  To add a protected area: import its router above and add ONE `.use()`
 *  line to this block. There is no second step.
 * ========================================================================== */

const guardedApiRouter = Router();

//  FIRST LAYER, before any mount below. Moving this line downwards silently
// unguards every router registered above it.
guardedApiRouter.use(verifyAdmin);

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
// this one picks it up. Both are mounted here, so both are behind `verifyAdmin`.
guardedApiRouter.use('/stores', countryRoutes);
guardedApiRouter.use('/subscriptions', subscriptionRoutes);
guardedApiRouter.use('/meta', metaRoutes);

router.use('/api', guardedApiRouter);


export = router;
