'use strict';

/**
 * ============================================================================
 *  FUNNEL ROUTES — mounted GUARDED at /api/funnel
 * ============================================================================
 *
 *  The listing-analytics reads: the Traffic Sources page and the top of the
 *  Funnel.
 *
 *  AUTHENTICATION is applied ONCE, on the parent sub-router in
 *  src/routes/index.ts, and this file inherits it by being mounted there — see
 *  that file's header for why the guard lives in one place. AUTHORISATION is per
 *  route (spec §4): the listing counts are `analytics:read`; the install cohort
 *  names stores, so it is `merchants:read`.
 *
 *  These are the endpoints the dashboard's `funnelService` was written against
 *  and has been stubbing out as not-implemented: GET /api/funnel,
 *  /api/funnel/traffic-source and /api/funnel/geo. The paths match what that
 *  service already documents, so wiring it up is deleting the stubs rather than
 *  redesigning the client.
 * ============================================================================
 */

import { Router } from 'express';
import funnelController = require('../controllers/funnel.controller');
import requirePermissionMiddleware = require('../middlewares/requirePermission');
import authModule = require('../modules/auth');

const { _funnelOverview, _funnelTrafficSource, _funnelGeo, _funnelInstallCohort } = funnelController;
const { requirePermission } = requirePermissionMiddleware;
const { PERMISSIONS } = authModule;

const router = Router();

// Window totals + the daily trend. Answers 200 with `summary: null` and a populated `empty_reason`
// when nothing has synced — deliberately NOT a zeroed summary, which would assert that nobody
// visited the listing.
router.get('/', requirePermission(PERMISSIONS.ANALYTICS_READ), _funnelOverview);

router.get('/traffic-source', requirePermission(PERMISSIONS.ANALYTICS_READ), _funnelTrafficSource);

router.get('/geo', requirePermission(PERMISSIONS.ANALYTICS_READ), _funnelGeo);

// The store table under the funnel. Answers 200 with `items: []` and a populated `data_state` /
// `attribution_state` when nothing has synced or BigQuery is unconfigured — deliberately NOT a
// refusal, which the page renders as "No installs recorded for this window. Run a Partner sync."
router.get('/install-cohort', requirePermission(PERMISSIONS.MERCHANTS_READ), _funnelInstallCohort);

export = router;
