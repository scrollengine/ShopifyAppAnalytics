'use strict';

/**
 * ============================================================================
 *  CONVERSION ROUTES — mounted GUARDED at /api/conversion
 * ============================================================================
 *
 *  The Funnel page's step chart and the trial block under it.
 *
 *  Handlers are mounted BARE here. The guard is applied ONCE, on the parent sub-router in
 *  `src/routes/index.ts`, and this file inherits it by being mounted there — see that file's header
 *  for why the guard lives in one place rather than being repeated per route file.
 *
 *  ⚠️ UNLIKE `funnel.routes.ts`, MOUNTING THIS ONE NEEDS A LINE IN `routes/index.ts`. `/api/funnel`
 *  was already on the guarded router, so adding `install-cohort` to it needed no change there;
 *  `/api/conversion` is a NEW area and does. `test/routeGuard.test.js` walks the live Express stack
 *  and fails on any route reachable without `verifyAdmin`, so the mount is asserted rather than
 *  assumed the moment it is added.
 *
 *  The path matches what `frontend/API_Services/growth-intel/conversionService.js` already
 *  documents, so wiring the client up is deleting its stub rather than redesigning it.
 * ============================================================================
 */

import { Router } from 'express';
import conversionController = require('../controllers/conversion.controller');

const {
    _conversionCustomFunnel,
    _conversionFunnel,
    _conversionCohortRetention,
    _conversionTimeToPaid,
    _conversionPlanMix,
    _conversionTrialOutcomes,
    _conversionTrialTrend,
    _conversionLogoChurn,
    _conversionRevenueChurn
} = conversionController;

const router = Router();

// The step funnel plus its trial block. Answers 200 with per-step `count: null` and a populated
// `tiers` / `warnings[]` when a tier is unconfigured or has never synced — deliberately NOT a
// refusal, which the page renders as "run a sync to populate GA4 and Partner events" over Partner
// data that is already there.
router.get('/custom-funnel', _conversionCustomFunnel);

// The FIXED seven-stage end-to-end funnel — listing view → paid. ⚠️ NOT `custom-funnel`, which is
// the operator's own step picker; this one takes no `events` at all. It is measured BY that endpoint's
// service with a fixed key list, so the two charts on this page cannot disagree about a stage. Both
// headline badges cross a population boundary the chart does not mark, so `rate_definitions` and
// `warnings[]` carry the marking — see `services/stageFunnel.service.ts`.
router.get('/funnel', _conversionFunnel);

// Weekly install cohorts against +1d/+7d/+30d/+60d/+90d retention checkpoints.  A cohort too young
// to have reached a checkpoint publishes `null` for it, NEVER `0` — the heatmap paints a zero solid
// red and captions it "0%", which is a claim that everyone who installed last week has churned.
router.get('/cohort-retention', _conversionCohortRetention);

// Days from install to first paid billing.  Stores that have NOT converted are excluded from the
// histogram — not bucketed at day 0, not bucketed in the tail — and the exclusions are counted and
// reported. One of the three is a coverage gap rather than a funnel fact, which makes the headline a
// floor; it is published on its own line for that reason.
router.get('/time-to-paid', _conversionTimeToPaid);

// The plan-mix snapshot and its 30-day churn. ⚠️ A point-in-time read: no window, by design.
// Membership comes through `modules/revenue`'s `liveSetAsOf`, so the subscriber count under this
// donut cannot disagree with the MRR figure on the Revenue page or the customer count on Logo Churn.
router.get('/plan-mix', _conversionPlanMix);

// Trial outcomes for a window: the cohort, how it resolved, and the trial-to-paid rate over DECIDED
// trials only. Answers 200 with a null cohort and a populated `data_state` when nothing has synced —
// deliberately NOT a refusal, which the page renders as a banner sending the operator to their .env.
router.get('/trial-outcomes', _conversionTrialOutcomes);

// The monthly trial-cohort trend. A month with no measurable rate publishes `null`, never `0`: the
// page's line is `connectNulls={false}` precisely so an unmeasured month breaks the line instead of
// drawing a 0% conversion point, and its table would print that zero in red as a verdict.
router.get('/trial-trend', _conversionTrialTrend);

// Churn in CUSTOMERS, not money. Membership comes through `modules/revenue`'s `liveSetAsOf`, so this
// page cannot disagree with the Revenue page about who is paying. `summary` and `monthly_trend` are
// separately nullable — the tiles can be publishable while the trend is not.
router.get('/logo-churn', _conversionLogoChurn);

// Churn in MONEY — the other half of the split above, folded from the same `liveSetAsOf` membership
// and the same `churnDate.helper`, so the two pages cannot disagree about who left or when.
//  Net churn is NOT clamped at zero: a month whose existing customers expanded by more than it lost
// publishes a negative rate, which is the single best signal a subscription business has. The tiles
// and the waterfall describe the LAST COMPLETE month, never the month in progress.
router.get('/revenue-churn', _conversionRevenueChurn);

export = router;
