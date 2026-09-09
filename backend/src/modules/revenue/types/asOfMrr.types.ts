/**
 * Shapes for `helpers/asOfMrr.helper` — MRR reconstructed at an arbitrary past instant.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 * These describe IN-MEMORY structures, not wire shapes. What actually reaches the response is
 * decided in `types/revenueOverview.types`, which is where the field names a component reads are
 * fixed.
 */

import type { LiveSet } from './ledgerMrr.types';

/**
 * The run-rate figures at ONE instant, plus the live set they were reduced from.
 *
 *  `mrr` and `active_subs` here are always numbers, because this shape is only ever built for a
 * boundary the caller has already decided is SUPPORTED. The `null`-for-unknown decision belongs one
 * layer up: `isSupportedBoundary` is what says whether the stored history reaches far enough back to
 * answer at all, and a caller that skips it publishes an under-counted paying base as a measured
 * one — silently, and always downwards.
 */
export interface AsOfMrr {
    /** The instant every figure below was evaluated at. */
    as_of: Date;
    /**
     * The shops paying at `as_of`, keyed exactly as the producer keyed them.
     *
     * Published rather than discarded because the movement fold, the per-plan partition and the
     * drill-down lists are all reductions of THIS set. Recomputing it per consumer is how a card's
     * count and its list come to disagree.
     */
    live_set: LiveSet;
    /** Sum of every live shop's monthly-equivalent charge. An ANNUAL charge contributes gross / 12. */
    mrr: number;
    /** How many distinct shops are live. The denominator behind `arpu`. */
    active_subs: number;
    /** `mrr / active_subs`. ⚠️ `null` — never `0` — when nothing is live: there is nothing to average. */
    arpu: number | null;
    /** Distinct currency codes across the live set, sorted. More than one ⇒ `mrr` sums unlike units. */
    currencies: string[];
    /**
     * Live shops whose settled charge carries NO `billing_interval`.
     *
     *  The annual caveat, made measurable. `normalizeToMonthly` divides by 12 only when the
     * interval reads `ANNUAL`, so an annual subscriber on an unlabelled row is booked at TWELVE TIMES
     * its true run-rate. This count is what tells a reader whether that is theoretical or the reason
     * their MRR looks wrong.
     */
    billing_interval_unknown_shops: number;
}

/** Input to `mrrAsOf`. */
export interface MrrAsOfInput {
    /**
     * Every settled subscription charge for the app, NEWEST FIRST.
     *
     * ⚠️ The order is load-bearing: `liveSetAsOf` accepts the first row it sees per shop. Sorting
     * this array — even into a copy that is then passed on — changes every membership answer.
     */
    history: import('./ledgerMrr.types').SubscriptionChargeRow[];
    as_of: Date;
    /** The live window for monthly cadences. Annual charges get their own, wider one. */
    window_days: number;
}

/**
 * One calendar month on the trend chart.
 *
 * ⚠️ `start` and `end` are INCLUSIVE and DISJOINT between consecutive buckets: `end` is one
 * millisecond before the next month's `start`, or `as_of` when the month has not finished. Using the
 * next month's first instant as this month's upper bound puts a payout settled at exactly midnight
 * into two months, and the months then sum to more than the ledger holds.
 */
export interface TrendMonth {
    /** `YYYY-MM`, UTC. The x-axis label and the key a caller files a month's answer under. */
    month: string;
    /** First instant of the calendar month, UTC. */
    start: Date;
    /** Last instant this bucket covers — the month's final millisecond, or `as_of` when still running. */
    end: Date;
    /** The month's own final millisecond, UNCLAMPED. Kept so `end` can be seen to be clamped. */
    month_end: Date;
    /** True when `end` was clamped, i.e. the month is still running and its cash bar is partial. */
    is_partial: boolean;
}

/** Input to `buildTrendMonths`. */
export interface TrendMonthInput {
    /** The judgement instant. The newest bucket is the calendar month this falls in. */
    as_of: Date;
    /** How many months to walk back, inclusive of the newest. Below 1 yields an empty list. */
    months: number;
}

/**
 * One row of the per-plan partition of a live set.
 *
 * ⚠️ EVERY FIGURE IS A BARE NUMBER. `PlanRevenueBreakdown` formats each with `Number(n)`, so an
 * envelope renders as an em dash and its donut renders as nothing at all.
 */
export interface PlanRevenueRow {
    /** The plan's name, or `UNKNOWN_PLAN_LABEL`. Never a guess and never the largest plan. */
    plan_name: string;
    /** Live shops on this plan at the instant the partition was taken. */
    active_subs: number;
    /** This plan's share of MRR. Sums across rows to the as-of `mrr` exactly. */
    mrr_amount: number;
    /** `mrr_amount / active_subs`. `null` never occurs here — a row exists only when a shop is on it. */
    arpu: number | null;
}

/** Input to `rollupByPlan`. */
export interface RollupByPlanInput {
    /** The live set to partition. Walked ONCE; every count is derived from that walk. */
    live_set: LiveSet;
    /** `shop_domain` → the plan name that store held AT the same instant. See `planByDomainAsOf`. */
    plan_by_domain: Map<string, string>;
    /** The label for a live shop the charge events cannot name a plan for. */
    unknown_label: string;
}

/** What `rollupByPlan` answers. */
export interface PlanRollup {
    /** The rows, biggest MRR contribution first, then by plan name so ties are stable. */
    rows: PlanRevenueRow[];
    /** Live shops that fell to `unknown_label`. ⚠️ The caller MUST warn when this is above zero. */
    unknown_plan_shops: number;
}

/** Input to `planByDomainAsOf`. */
export interface PlanByDomainAsOfInput {
    /**
     * Every subscription the charge cohort produced — the flat list, NOT `by_domain`.
     *
     *  `by_domain` IS THE WRONG INPUT AND THE REASON THIS FUNCTION EXISTS. That map holds the
     * per-domain winner by LATEST `trial_start`, which is the plan the merchant is on TODAY. Applying
     * it to a past instant restates a historical plan mix in current-plan terms: a merchant who moved
     * from Starter to Pro last week is counted under Pro in every month before the move, so Starter's
     * base loses a customer it actually had and Pro's gains one it did not.
     */
    subscriptions: readonly import('../../conversion/types/lifecycle.types').CohortSubscription[];
    /** The instant to describe. A subscription that had not STARTED by then cannot describe it. */
    as_of: Date;
}
