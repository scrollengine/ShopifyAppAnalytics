'use strict';

/**
 * ============================================================================
 *  PARTNER APP ROUTES — mounted GUARDED at /api/partner-apps
 * ============================================================================
 *
 *  AUTHENTICATION is applied once, on the parent sub-router in
 *  src/routes/index.ts — do not add a per-route `authenticate` here; two places
 *  to check is one place to forget. AUTHORISATION is per route: each line below
 *  declares its ONE permission as its first route-level middleware (spec §4).
 *  Reading the app is `apps:read`; registering, editing or deactivating it is
 *  `apps:manage`; the KPI tiles are money (`financials:read`) and the event
 *  list names stores (`merchants:read`).
 *
 *  ── ⚠️ ORDERING: THE TWO-SEGMENT ROUTES COME FIRST ─────────────────────────
 *
 *  Express matches in REGISTRATION ORDER. `/:partner_app_id` is a single
 *  segment, so it cannot swallow `/:partner_app_id/kpi` today — but registering
 *  the specific paths first is the habit that stops a future `/summary` or
 *  `/export` from being answered by the record handler with an app named
 *  "summary". Nothing below shadows anything above it, and that is checked by
 *  reading top to bottom rather than by remembering a rule.
 *
 *  ── THE PATHS ARE THE ONES THE FRONTEND ALREADY DOCUMENTS ──────────────────
 *
 *  `frontend/API_Services/growth-intel/partnerAppService.js` carries four
 *  `notImplemented` stubs naming exactly these routes — `GET /:id`,
 *  `PATCH /:id`, `DELETE /:id`, `GET /:id/kpi`, `GET /:id/events`. They are
 *  served here at those spellings rather than at tidier ones, so landing them
 *  is a one-line change in each stub and nothing on the page moves.
 * ============================================================================
 */

import { Router } from 'express';
import partnerAppController = require('../controllers/partnerApp.controller');
import requirePermissionMiddleware = require('../middlewares/requirePermission');
import authModule = require('../modules/auth');

const {
    _partnerAppList,
    _partnerAppUpsert,
    _partnerAppGet,
    _partnerAppUpdate,
    _partnerAppDeactivate,
    _partnerAppKpi,
    _partnerAppEvents
} = partnerAppController;
const { requirePermission } = requirePermissionMiddleware;
const { PERMISSIONS } = authModule;

const router = Router();

router.get('/', requirePermission(PERMISSIONS.APPS_READ), _partnerAppList);

// Idempotent: registers the app named by SHOPIFY_PARTNER_APP_ID, or returns the existing row.
// POST rather than PUT because the caller supplies no id — the environment does.
router.post('/', requirePermission(PERMISSIONS.APPS_MANAGE), _partnerAppUpsert);

//  REGISTERED BEFORE `/:partner_app_id` — see the header. Both carry a second path segment, so
// neither can be reached by the single-segment record route however Express orders them.

// The KPI tiles and the install chart. An app that has never been synced answers 200 with
// `data_state: 'NEVER_SYNCED'`, every figure null and a reason — never zeros, and never a 404.
router.get('/:partner_app_id/kpi', requirePermission(PERMISSIONS.FINANCIALS_READ), _partnerAppKpi);

// One page of raw Partner events, plus the install trend over the same window. The trend is folded
// from a dedicated relationship-event read, so it is unaffected by `?type=` and by paging — a chart
// that reshapes itself as the reader pages is the most convincing possible way to be wrong.
router.get('/:partner_app_id/events', requirePermission(PERMISSIONS.MERCHANTS_READ), _partnerAppEvents);

// One app's record. ⚠️ 404 rather than a 200 with a null app: the caller asked for a specific row,
// and "here is nothing" over a mistyped id renders as a healthy app with no data.
router.get('/:partner_app_id', requirePermission(PERMISSIONS.APPS_READ), _partnerAppGet);

//  DISPLAY METADATA ONLY. `partner_api_app_id`, every sync watermark and every coverage gate are
// REFUSED, and a body containing one fails the whole call with a 400 rather than being partly
// applied. Changing which Shopify app a row names would relabel every stored fact as another app's
// history; typing in a coverage gate would switch the honesty layer off by hand.
router.patch('/:partner_app_id', requirePermission(PERMISSIONS.APPS_MANAGE), _partnerAppUpdate);

//  DEACTIVATES. REMOVES NOTHING. `DELETE` is the verb the frontend stub documents, so it is the
// verb served — but the response states that nothing was deleted, how many event and payout rows
// still reference the app, and that PATCH { "is_active": true } reverses it. There is deliberately
// no hard delete: cascading would destroy the factual basis of every published figure, and not
// cascading would orphan those rows behind an id that resolves to nothing — which reads exactly
// like a business with no customers.
router.delete('/:partner_app_id', requirePermission(PERMISSIONS.APPS_MANAGE), _partnerAppDeactivate);

export = router;
