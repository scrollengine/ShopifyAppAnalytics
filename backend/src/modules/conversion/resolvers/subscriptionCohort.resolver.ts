'use strict';

/**
 * ============================================================================
 *  THE APP-WIDE SUBSCRIPTION COHORT, AS OF ONE INSTANT — FETCHED ONCE, HERE
 * ============================================================================
 *
 *  Three endpoints need the same thing: every subscription this app has ever had, classified as of
 *  one judgement instant. `trial-outcomes` folds it into a window cohort, `trial-trend` folds it once
 *  per month, and `logo-churn` reads plan names and churn dates off it.
 *
 *  ── WHY A RESOLVER AND NOT THREE COPIES IN THREE SERVICES ───────────────────────────────────
 *
 *  The fetch is not the interesting part; its two INVARIANTS are, and both are absences that a
 *  well-meaning edit adds back:
 *
 *    1. THE EVENT PULL HAS NO LOWER TIME BOUND. A subscription that matters to a window may have
 *       STARTED at any point before it — a trial begun in January converts in March, and a shop that
 *       churns this month subscribed years ago. Bounding the scan at the window's start loses the
 *       START event, so the subscription is never bucketed at all and the endpoint under-reports
 *       silently and always downwards.
 *
 *    2. THE SETTLED-PAYOUT EVIDENCE IS BOUNDED AT THE SAME `as_of` AS THE EVENTS. Unbounded, a
 *       payout that settles in June is evidence inside a January window: a subscription whose
 *       charge carried no `billingOn` on any event takes the `conversion_date === null` branch,
 *       `everSettled` reads true, and the shop is published as having converted on a date it had not
 *       paid. The error runs ONE WAY ONLY, because the event pull and the churn clamp ARE bounded —
 *       future churn excluded while future revenue is admitted.
 *
 *  Three services each spelling that out is three places for one of the two to be dropped, and the
 *  drop is invisible: no error, no short read, just a different number on one page.
 *
 *  ── WHAT IS NOT HERE ────────────────────────────────────────────────────────────────────────
 *
 *  No window, no fold, no judgement. It answers the whole app's cohort and each caller windows it
 *  its own way — which is exactly why `foldTrialCohort` can be applied twelve times to ONE cohort to
 *  build a monthly trend, with no risk of twelve classifications disagreeing.
 *
 *  It reads no clock: `as_of` is a parameter, validated ONCE at each service's entry, and passed
 *  through to `resolveChargeCohortForDomains`, which THROWS on an unusable one rather than
 *  substituting today.
 * ============================================================================
 */

import chargeCohortResolver = require('./chargeCohort.resolver');
import customFunnelRepository = require('../repositories/customFunnel.repository');

import type { ChargeCohortResult } from '../types/lifecycle.types';

const { resolveChargeCohortForDomains } = chargeCohortResolver;
// REUSED, NOT RE-DECLARED. These are the two reads the custom funnel already issues for its own
// trial block, with the two invariants above baked into their `$match`es and documented at the
// query. A second pair here would be a second place for a `$gte` to appear.
const { findChargeCohortEvents, aggregateSettledSubscriptionEvidence } = customFunnelRepository;

/**
 * Every subscription this app has, folded and classified as of one instant.
 *
 * ⚠️ APP-WIDE, never scoped to a store list. The install cohort scopes its own pull to the install
 * spine because the spine IS its population; here the population is every subscription, because a
 * trial that started before the window may finish inside it and a shop that churns this month
 * subscribed long ago.
 *
 * The two reads are issued together: they touch different collections and neither depends on the
 * other, so the second scan costs latency rather than wall-clock.
 *
 * @param params0 - The parameters object.
 * @param params0.partner_app_id - Mongo `_id` of the `gi_partner_app`, as a string.
 * @param params0.as_of - The judgement instant. Bounds BOTH reads and classifies every row.
 * @returns Subscriptions, the per-domain winners, and every exclusion counted.
 */
const resolveSubscriptionCohortAsOf = async ({
    partner_app_id,
    as_of
}: {
    partner_app_id: string;
    as_of: Date;
}): Promise<ChargeCohortResult> => {
    const [events, settled] = await Promise.all([
        findChargeCohortEvents({ partner_app_id, until: as_of }),
        aggregateSettledSubscriptionEvidence({ partner_app_id, as_of })
    ]);

    return resolveChargeCohortForDomains({
        events,
        as_of,
        settled_charge_ids: settled.charge_ids,
        settled_domains: settled.shop_domains
    });
};

export = {
    resolveSubscriptionCohortAsOf
};
