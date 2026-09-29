'use strict';

/**
 * ============================================================================
 *  SUBSCRIPTION ROUTES — mounted GUARDED at /api/subscriptions
 * ============================================================================
 *
 *  The Subscriptions page's list: every merchant on a paid plan RIGHT NOW, with their plan, status
 *  and spend.
 *
 *  AUTHENTICATION is applied ONCE, on the parent sub-router in `src/routes/index.ts`, and this file
 *  inherits it by being mounted there — see that file's header for why the guard lives in one place
 *  rather than being repeated per route file. AUTHORISATION is per route: each line below declares
 *  its ONE permission as its first route-level middleware (spec §4).
 *  The list names stores, so it is `merchants:read`.
 *
 *  ⚠️ MOUNTING THIS ONE NEEDS A LINE IN `routes/index.ts`. `/api/subscriptions` is a NEW area,
 *  exactly as `/api/stores` and `/api/conversion` were. `test/routeGuard.test.js` walks the live
 *  Express stack and fails on any route reachable without `authenticate`, so the mount is asserted
 *  rather than assumed the moment it is added.
 *
 *  ──  THERE IS NO `/api/subscriptions/detail`, AND THERE MUST NOT BE ONE ──────────────────
 *
 *  `frontend/API_Services/growth-intel/subscriptionService.js`'s `getDetail` names
 *  `GET /api/stores/detail`, and that is the right path — its own header calls the alternative "the
 *  most expensive misreading in this suite". The drawer's COMMONEST subject is a store that never
 *  subscribed (the install cohort is mostly such stores), while this list's population is "currently
 *  paying", so serving a store record from a `/subscriptions/` path would name the answer after a
 *  population it does not have. The store record is served by `store.routes.ts` and reached from all
 *  seven tables that open the drawer, this one included.
 *
 *  ── ORDERING ────────────────────────────────────────────────────────────────
 *
 *  One literal route today. ⚠️ IT WOULD MATTER the moment a `/:shop_domain` route is added: Express
 *  matches in registration order, so a parameter route registered first would swallow every sibling.
 *  Register any such route LAST.
 * ============================================================================
 */

import { Router } from 'express';
import subscriptionController = require('../controllers/subscription.controller');
import requirePermissionMiddleware = require('../middlewares/requirePermission');
import authModule = require('../modules/auth');

const { _getSubscriptions } = subscriptionController;
const { requirePermission } = requirePermissionMiddleware;
const { PERMISSIONS } = authModule;

const router = Router();

// The paginated, filtered, faceted list of merchants who are paying right now. Answers 200 with
// `items: []` and a populated `population` / `data_state` / `warnings[]` when nothing has synced, no
// payout has ever been fetched, or BigQuery is unconfigured — deliberately NOT a refusal, which the
// page renders as though the operator had no paying customers at all.
router.get('/', requirePermission(PERMISSIONS.MERCHANTS_READ), _getSubscriptions);

export = router;
