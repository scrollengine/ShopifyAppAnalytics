'use strict';

/**
 * ============================================================================
 *  REVENUE ROUTES — mounted GUARDED at /api/revenue
 * ============================================================================
 *
 *  The guard is applied once on the parent sub-router in src/routes/index.ts.
 *  Each route declares its ONE permission as its first route-level middleware:
 *  all three are `merchants:read` (the spec §4 table), the key for anything the
 *  Revenue page reads that can name a store. The store-free money aggregates
 *  (`financials:read`) are served elsewhere: the KPI tiles, the plan mix and the
 *  country rollup.
 * ============================================================================
 */

import { Router } from 'express';
import revenueController = require('../controllers/revenue.controller');
import requirePermissionMiddleware = require('../middlewares/requirePermission');
import authModule = require('../modules/auth');

const { _revenueNowSummary, _revenueWindowedOverview, _revenueShopPlans } = revenueController;
const { requirePermission } = requirePermissionMiddleware;
const { PERMISSIONS } = authModule;

const router = Router();

// `/now` rather than `/` because this is a point-in-time snapshot, not a collection. The name keeps
// the distinction visible in a log, and it is what let the windowed view below land beside it rather
// than on top of it.
//
// ⚠️ ITS CONTRACT IS FROZEN. `/api/meta/coverage` is a trim of this payload's coverage block — the
// meta controller calls `getRevenueNow` directly — and every figure it publishes is a confidence
// envelope. Reshaping it to match the windowed view would break both consumers.
router.get('/now', requirePermission(PERMISSIONS.MERCHANTS_READ), _revenueNowSummary);

// The Revenue page's own read: the same ledger, over a WINDOW, with bare numbers instead of
// envelopes because the page formats with `Number(n)`. A separate path rather than a mode flag on
// `/now` — one path, one payload shape, so a caller never has to inspect a figure to know what it is.
router.get('/overview', requirePermission(PERMISSIONS.MERCHANTS_READ), _revenueWindowedOverview);

// POST because the caller sends up to two hundred domains in one batch and a query string that long
// is at the mercy of every proxy in between. It reads nothing and writes nothing — the verb is about
// the size of the payload, not about a mutation. That is why it carries a `:read` key: the one
// mutating-verb route test/permissionMap.test.js allows to.
router.post('/shop-plans', requirePermission(PERMISSIONS.MERCHANTS_READ), _revenueShopPlans);

export = router;
