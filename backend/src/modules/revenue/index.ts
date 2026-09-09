/**
 * The revenue module's public surface — the MRR ledger and every reduction of it.
 *
 * Barrel rules — deep-path imports inside the folder, every key enumerated,
 * `export =` never `export default` — are stated once in IMPLEMENTATION.md
 * §3.13 and asserted by test/exportSurface.test.js.
 */

import revenueNowService = require('./services/revenueNow.service');
import revenueOverviewService = require('./services/revenueOverview.service');
import shopPlansService = require('./services/shopPlans.service');
import ledgerMrrHelper = require('./helpers/ledgerMrr.helper');
import asOfMrrHelper = require('./helpers/asOfMrr.helper');
import movementSinceHelper = require('./helpers/movementSince.helper');
import revenueRepository = require('./repositories/revenue.repository');

export = {
    /** The current revenue snapshot: run-rate, all-time cash, top shops, and coverage. */
    getRevenueNow: revenueNowService.getRevenueNow,

    /**
     * The WINDOWED revenue view: run-rate at the window's close, how MRR got there, and the cash.
     *
     * ⚠️ A DIFFERENT RENDERING CONTRACT FROM `getRevenueNow`, DELIBERATELY. Every figure here is a
     * BARE number with `null` for unknown; every figure there is a confidence envelope. The consumer
     * of this one formats with `Number(n)`, so an envelope renders as an em dash and the honesty
     * mechanism would manufacture the very absence it exists to prevent. `/now` keeps its envelopes
     * because `/api/meta/coverage` is a trim of its coverage block. The two styles are never mixed
     * inside one payload — see `services/revenueOverview.service`'s header for the whole argument.
     *
     * Resolves `status: false` when the movement fold does not reconcile. That is not a lapse: six
     * plausible figures that do not add up to the two balances printed above them are worse than no
     * card, because a reader who checks the arithmetic cannot tell which one to distrust.
     */
    getRevenueOverview: revenueOverviewService.getRevenueOverview,

    /**
     * The current plan for a batch of myshopify domains, from `raw_event.charge.name`.
     *
     * ⚠️ A domain with no answer is PRESENT with `resolved: false` and a reason, never omitted: an
     * omitted key cannot be told apart from a domain nobody asked about.
     *
     * ⚠️ `store_active` is always `true` and says nothing about installs — the consumer badges a
     * store "Uninstalled" on a falsy value, so a null there would be a specific false claim. Install
     * state belongs to `modules/store`.
     */
    getShopPlans: shopPlansService.getShopPlans,

    // ── The MRR ledger ──────────────────────────────────────────────────────
    //
    // ⚠️ The published KEY SET is unchanged, but three of these now come from the repository rather
    // than the helper: the helper is pure by contract, so the functions that READ the ledger moved
    // to `repositories/`. Consumers were deliberately not asked to move with them.
    //
    // Published rather than kept private BECAUSE it is the canonical definition of "who is paying
    // us and how much". The comment at the top of `ledgerMrr.helper` records what happened the last
    // time this logic was reachable only by copying it: two pages reconstructed MRR independently
    // and disagreed with each other. A sibling module that needs a paying set must be able to reach
    // THIS one, or it will grow a second definition and the same divergence will come back.

    /** Converts one settled charge to a monthly run-rate contribution. ANNUAL amounts are /12. */
    normalizeToMonthly: ledgerMrrHelper.normalizeToMonthly,
    /** How long a charge of a given cadence keeps its shop live. Interval-aware. */
    liveWindowDaysFor: ledgerMrrHelper.liveWindowDaysFor,
    /** Every settled subscription charge for an app, newest first. One read, evaluated in memory. */
    fetchSubscriptionChargeHistory: revenueRepository.fetchSubscriptionChargeHistory,
    /** THE as-of predicate: the shops paying at a given instant, each at its most recent charge. */
    liveSetAsOf: ledgerMrrHelper.liveSetAsOf,
    /** The as-of predicate evaluated at now. */
    fetchCurrentPayingShops: revenueRepository.fetchCurrentPayingShops,
    /** The as-of predicate evaluated at the end of each requested month. */
    fetchMonthlyLiveSets: revenueRepository.fetchMonthlyLiveSets,
    /** MRR movement between two as-of live sets. Categories reconcile exactly. */
    diffMonths: ledgerMrrHelper.diffMonths,
    /** The `billing_interval` value that triggers the /12 normalisation. */
    BILLING_INTERVAL_ANNUAL: ledgerMrrHelper.BILLING_INTERVAL_ANNUAL,
    /** The live window an annual charge gets, so a yearly biller is not read as churned. */
    ANNUAL_LIVE_WINDOW_DAYS: ledgerMrrHelper.ANNUAL_LIVE_WINDOW_DAYS,

    // ── MRR AT A PAST DATE, AND HOW IT MOVED ────────────────────────────────
    //
    // Published for the same reason the ledger above is: these are REDUCTIONS of `liveSetAsOf`, and a
    // sibling that cannot reach them will write its own — at which point one page's "MRR in April"
    // and another's stop being the same measurement. Every one of them is PURE.

    /** MRR, subscribers and ARPU at ANY instant, plus the live set they were reduced from. */
    mrrAsOf: asOfMrrHelper.mrrAsOf,
    /** Whether the stored payout history reaches far enough back to decide membership at an instant. */
    isSupportedBoundary: asOfMrrHelper.isSupportedBoundary,
    /** The plan each store held AT an instant. ⚠️ NOT the cohort's `by_domain`, which is today's plan. */
    planByDomainAsOf: asOfMrrHelper.planByDomainAsOf,
    /** A live set partitioned by plan: MRR share, subscriber share, per-plan ARPU. */
    rollupByPlan: asOfMrrHelper.rollupByPlan,
    /**
     * MRR movement between two live sets, with the stores behind every figure.
     *
     *  THROWS rather than returning a fold whose figures do not reconcile to its two balances.
     */
    foldMrrMovement: movementSinceHelper.foldMrrMovement,
    /** What happened to one store between a period's close and now. Money only, never installs. */
    movementSinceState: movementSinceHelper.movementSinceState
};
