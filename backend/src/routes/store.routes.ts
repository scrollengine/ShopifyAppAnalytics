'use strict';

/**
 * ============================================================================
 *  STORE ROUTES — mounted GUARDED at /api/stores
 * ============================================================================
 *
 *  The Stores page's roster, and the store detail slide-over that opens from SEVEN different tables —
 *  Stores, Subscriptions, the install cohort on Funnel, Revenue, Revenue Churn, Logo
 *  Churn and Trial Funnel.
 *
 *  AUTHENTICATION is applied ONCE, on the parent sub-router in `src/routes/index.ts`, and this file
 *  inherits it by being mounted there — see that file's header for why the guard lives in one place
 *  rather than being repeated per route file. AUTHORISATION is per route: each line below declares
 *  its ONE permission as its first route-level middleware (spec §4).
 *  Both routes name stores, so both are `merchants:read`.
 *
 *  ⚠️ MOUNTING THIS ONE NEEDS A LINE IN `routes/index.ts`. `/api/stores` is a NEW area, exactly as
 *  `/api/conversion` was. `test/routeGuard.test.js` walks the live Express stack and fails on any
 *  route reachable without `authenticate`, so the mount is asserted rather than assumed the moment it
 *  is added.
 *
 *  ──  THE DETAIL PATH IS `/api/stores/detail`, NOT `/api/subscriptions/detail` ────────────
 *
 *  `frontend/API_Services/growth-intel/subscriptionService.js`'s `getDetail` stub names the second
 *  path, and it is the wrong one — the full argument is in `services/storeDetail.service`'s header.
 *  In one line: the drawer's commonest subject is a store that NEVER SUBSCRIBED, and a Subscriptions
 *  list's population is "currently paying", so serving a store record from a `/subscriptions/` path
 *  names the answer after a population it does not have. The stub is a `notImplemented` envelope
 *  today — nothing calls it successfully — so repointing it costs one line and breaks nothing, while
 *  a misnamed endpoint with real clients is permanent.
 *
 *  ── ORDERING ────────────────────────────────────────────────────────────────
 *
 *  `/` and `/detail` are both literal paths, so their registration order does not matter today.
 *  ⚠️ IT WOULD THE MOMENT A `/:shop_domain` ROUTE IS ADDED: Express matches in registration order, so
 *  a parameter route registered before `/detail` would swallow it and answer with a store named
 *  "detail". Register any such route LAST.
 * ============================================================================
 */

import { Router } from 'express';
import storeController = require('../controllers/store.controller');
import requirePermissionMiddleware = require('../middlewares/requirePermission');
import authModule = require('../modules/auth');

const { _getStores, _getStoreDetail } = storeController;
const { requirePermission } = requirePermissionMiddleware;
const { PERMISSIONS } = authModule;

const router = Router();

// The paginated, filtered, faceted roster. Answers 200 with `items: []` and a populated
// `data_state` / `attribution_state` / `warnings[]` when nothing has synced or BigQuery is
// unconfigured — deliberately NOT a refusal, which the page renders as though the operator had no
// stores at all.
router.get('/', requirePermission(PERMISSIONS.MERCHANTS_READ), _getStores);

// One store's full record: identity, install lifecycle, subscriptions, settled payouts, acquisition
// and a merged timeline. ⚠️ The ONE read in this area that refuses rather than answering empty — a
// store the Partner API has no record of cannot be described, and the drawer has no rendering for a
// record that is present but says nothing. The refusal carries the reason, chosen by the watermark.
router.get('/detail', requirePermission(PERMISSIONS.MERCHANTS_READ), _getStoreDetail);

export = router;
