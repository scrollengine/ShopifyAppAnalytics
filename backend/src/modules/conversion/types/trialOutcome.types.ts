/**
 * The request and response shapes for `GET /api/conversion/trial-outcomes` and
 * `GET /api/conversion/trial-trend`, plus the value unions of
 * `../constants/trialOutcome.constants`.
 *
 * Declarations only — `typeof import(…)` is erased at compile time, so importing this file costs
 * nothing at run time and does NOT pull the constants module in.
 *
 * The unions live here rather than beside the values because `trialOutcome.constants` ends in an
 * export assignment, and a module with one cannot export anything else, types included (TS2309).
 * Each union is derived with `typeof` rather than restated, so a new member widens it automatically.
 */

import type { CohortDataState, StateBasis, SubscriptionState, TrialDaysSource, ChargeLinkState } from './lifecycle.types';

type TrialOutcomeConstants = typeof import('../constants/trialOutcome.constants');

/** `decided` | `unavailable`. There is no third basis, and specifically no "all subscriptions". */
export type TrialRateBasis =
    TrialOutcomeConstants['TRIAL_RATE_BASES'][keyof TrialOutcomeConstants['TRIAL_RATE_BASES']];

// ── Request ─────────────────────────────────────────────────────────────────

/** The query bag for `trial-outcomes`, already CAST (never coerced) by the controller. */
export interface TrialOutcomesParams {
    partner_app_id: string;
    /** number, `0` or `'all'`. Normalised by `shared/helpers/dateRange.helper`, never twice. */
    period_days?: number | string;
    /** ISO `YYYY-MM-DD`. Honoured only together with `until`. */
    since?: string;
    until?: string;
}

/** The query bag for `trial-trend`. */
export interface TrialTrendParams {
    partner_app_id: string;
    /** How many calendar months to walk back. Out-of-range values are CLAMPED and warned about. */
    months?: number | string;
}

// ── Response: trial outcomes ────────────────────────────────────────────────

/**
 * One state's share of the cohort.
 *
 * `count` is a BARE NUMBER and `pct` is a FRACTION in [0,1] or `null` — never a confidence envelope.
 * The page runs both through formatters that do `Number(n)`, so an envelope renders as an em dash
 * and the tile silently reports "we could not measure this" about a figure that was measured.
 */
export interface TrialOutcomeBreakdownRow {
    state: SubscriptionState;
    /** From `SUBSCRIPTION_STATE_LABELS`. The page prefers this over its own fallback map. */
    label: string;
    count: number;
    /**
     * `count / total_shops_in_cohort`.  `null` — never `0` — for an EMPTY cohort: `0/0` is a rate
     * nobody measured, and "0.0% of cohort" printed beside a state name is a claim about the
     * business rather than a statement about the data.
     */
    pct: number | null;
}

/**
 * The trial-side losses, rolled up by the service rather than by the page.
 *
 * The page reads `cancellation_rollup.count` in preference to deriving one "so a future addition to
 * it lands automatically" (its own comment). `states` names what went into the total, so a reader
 * can check the rollup rather than take its word.
 */
export interface TrialCancellationRollup {
    count: number;
    /** The states summed — `CHURNED_DURING_TRIAL` today. Never includes a post-conversion churn. */
    states: readonly string[];
    /** Why these and not the others, in the reader's language. */
    meaning: string;
}

/**
 * One subscription in the cohort table.
 *
 *  `shop_id` IS THE SUBSCRIPTION'S BUCKET KEY (`chg:<charge_id>` or `shop:<domain>`), NOT a
 * Shopify shop id. A Partner charge event carries no shop GID, so there is no shop id to publish;
 * the bucket key is the only stable identity a subscription has here. The page uses it for its React
 * key and for the "No store record · …" label it prints when a row has no domain, and for nothing
 * else. THE DRAWER RESOLVES `shop_domain` AND ONLY `shop_domain` — see `shop_identity` on the payload.
 */
export interface TrialCohortShopRow {
    /** The bucket key. See the note above; this is deliberately not a shop id. */
    shop_id: string;
    /** Canonical `*.myshopify.com`, or `''` when the subscription's events carried no domain. */
    shop_domain: string;
    state: SubscriptionState;
    label: string;
    /** `charge.name`. `''` when Shopify sent none — the page renders an em dash for it. */
    plan_name: string;
    /**
     * `charge.amount.amount`, or `null`.
     *
     * ⚠️ SPELLED `price` HERE AND `plan_price` ON THE INSTALL-COHORT ROW. Two pages, two column
     * names, one value: `trial-funnel/index.js` reads `_fmtMoney(r.price)` while
     * `InstallCohortTable` reads `plan_price`. Publishing both spellings on one row would be two
     * names for one number that a later edit can make disagree.
     */
    price: number | null;
    currency: string;
    /** The earliest subscription START event in the bucket — when the trial began. */
    activated_at: string;
    /**
     * Shopify's own `charge.billingOn` — the date the trial ends and billing begins.
     *
     *  `null` WHEN SHOPIFY SUPPLIED NONE, and never `activated_at + N days`. This is a RENDERED
     * COLUMN: an assumed date sits in the table beside real ones, in the same format, with nothing
     * to mark it, and a reader plans around it. `trial_days_source` says which it is.
     */
    trial_ends_at: string | null;
    /** The first end event at or after the trial start, clamped to the judgement instant. */
    churned_at: string | null;
    /** ⚠️ Warn on `inferred` — it is the one branch of the state machine that assumes. */
    state_basis: StateBasis;
    trial_days_source: TrialDaysSource;
    charge_link: ChargeLinkState;
    /** Whether a settled `APP_SUBSCRIPTION` payout was observed against this subscription. */
    settled_payout_observed: boolean;
}

/** What was excluded or guessed, counted, so the payload can be reconciled with the collections. */
export interface TrialOutcomesDiagnostics {
    /** Subscriptions the fold saw, app-wide — a superset of the window cohort. */
    subscriptions_app_wide: number;
    /** Of the window cohort, how many are on the weakest evidence (`state_basis: 'inferred'`). */
    inferred_state_subscriptions: number;
    /** Subscriptions in the cohort whose events carried no shop domain. Counted, never dropped. */
    shopless_subscriptions: number;
    /** Events with neither a charge id nor a shop domain. SKIPPED and counted, never pooled. */
    skipped_keyless_subscription_events: number;
    /** Distinct SUBSCRIPTIONS excluded for `charge.test === true`. Asymmetric — see the resolver. */
    test_subscriptions_excluded: number;
    /** How well the cohort's subscriptions are linked to a charge payload. */
    charge_link: Record<ChargeLinkState, number>;
    /** Cohort rows beyond `TRIAL_COHORT_SHOP_LIMIT`, dropped from `shops` but counted here. */
    shops_omitted: number;
}

/** The `data` of a successful `GET /api/conversion/trial-outcomes`. */
export interface TrialOutcomesResponse {
    app_id: string;
    app_name: string;
    period_label: string;
    period_days: number | 'all' | null;
    kind: string;
    since: string | null;
    until: string;
    /** The instant every subscription was classified at. Identical to `until`, published explicitly. */
    as_of: string;

    /**
     * The cohort: subscriptions whose TRIAL STARTED inside the window.
     *
     * `null` — and `breakdown` null with it — when no Partner sync has completed. The page's
     * `_outcomesNeverSynced` tests `!Array.isArray(d.breakdown)` and routes the whole payload to its
     * NEVER_SYNCED banner, which is the honest rendering for "we have not looked yet".
     */
    total_shops_in_cohort: number | null;
    /** `total - still_on_trial`. The denominator of the rate, and the reason it is honest. */
    decided_count: number | null;
    still_on_trial: number | null;
    /** `PAYING + CHURNED_AFTER_TRIAL`. A merchant who converted and later left DID convert. */
    converted_count: number | null;
    /**
     * WHICH states `converted_count` is the sum of, named on the wire.
     *
     * The symmetric twin of `cancellation_rollup.states`, and it exists for the same reason: the
     * definition of "converted" has changed twice in this module, so a reader must be able to check
     * the claim against the payload rather than against a comment. `CHURNED_AFTER_TRIAL` is in this
     * list — a merchant who converted and later left DID convert.
     */
    converted_states: readonly string[];
    /**
     * `converted_count / decided_count`, a FRACTION in [0,1].
     *
     *  `null` — never `0` — when nothing has decided yet. The page renders it with `_fmtPct`, which
     * prints "0.0%" for a zero under the words "Trial → Paid rate": a claim that every merchant who
     * finished a trial declined, made about a cohort where nobody has finished one.
     */
    trial_to_paid_rate: number | null;
    rate_basis: TrialRateBasis;

    breakdown: TrialOutcomeBreakdownRow[] | null;
    cancellation_rollup: TrialCancellationRollup | null;

    shops: TrialCohortShopRow[];
    /** True when the cohort was longer than the row cap. The page's caption cannot tell on its own. */
    shops_truncated: boolean;
    /** WHICH row field the store drawer can resolve. Always `shop_domain` — see the row type. */
    shop_identity: string;

    /** The four state labels, so the badge, the tabs and the cards read from one table. */
    states: Readonly<Record<string, string>>;
    /** Methodology, rendered in a Banner. Every string unique — React keys them by content. */
    notes: string[];
    /** Rendered one <p> each, KEYED BY THE STRING. Every entry must be unique. */
    warnings: string[];
    diagnostics: TrialOutcomesDiagnostics;

    data_state: CohortDataState;
    /** Set ONLY with `data_state: 'NEVER_SYNCED'` — it is the banner's body on that path. */
    unknown_reason?: string;
}

// ── Response: trial trend ───────────────────────────────────────────────────

/**
 * One month's cohort, classified AS OF TODAY rather than as of the month's end.
 *
 * "How each month's trial-starters resolved" is what the chart says, and the Aging badge beside it
 * is what makes that honest: a recent cohort still holds shops that may yet convert or churn.
 *
 *  EVERY COUNT IS `null`, NEVER `0`, FOR A MONTH THAT COULD NOT BE MEASURED. The page plots the
 * rate on `<Line connectNulls={false}>` precisely so an unmeasured month BREAKS THE LINE instead of
 * drawing a 0% conversion point, and its month table tones a rate below 20 as critical — so a
 * manufactured zero is printed in red as a verdict on a number that does not exist.
 */
export interface TrialTrendMonth {
    /** `YYYY-MM`, UTC. */
    month: string;
    /** The cohort size: subscriptions whose trial started in this month. */
    trial_starts: number | null;
    /** Reached paid billing — `PAYING + CHURNED_AFTER_TRIAL`. A SUPERSET of `churned_after_paid`. */
    converted: number | null;
    /** Still inside their trial today. Undecided, and excluded from both sides of the rate. */
    in_trial: number | null;
    /**
     * Left before the trial ended. The trend's name for `CHURNED_DURING_TRIAL`.
     *
     * ⚠️ Named `cancelled` because the page maps `churned_during_trial: _numOrNull(r.cancelled)`.
     * The vocabulary is the same one; only this field's wire name differs, and the page renames it
     * back on arrival so the legend, tooltip and table all say "Churned during trial".
     */
    cancelled: number | null;
    /**
     * Converted, then left. ⚠️ A SUBSET of `converted`, not a sibling — the chart stacks
     * `converted + in_trial + cancelled` to the month's total and would overflow it as a fourth
     * segment, which is why the page renders this as a table column instead.
     */
    churned_after_paid: number | null;
    /** `trial_starts - in_trial`. The rate's denominator, published so the rate can be checked. */
    decided: number | null;
    /** `converted / decided`, a FRACTION in [0,1].  `null` when nothing in the month has decided. */
    trial_to_paid_rate: number | null;
    rate_basis: TrialRateBasis;
    /**
     * Whole days between the month's end and the judgement instant.
     *
     * ⚠️ ALWAYS A NUMBER, even on an unmeasured month. The page computes `is_aging: r.cohort_aged_days
     * < 90`, and `null < 90` is TRUE — so a missing value badges the month "Aging", a claim about the
     * cohort assembled out of an absent field.
     */
    cohort_aged_days: number;
    /** True while the month is still running, so its counts are partial by construction. */
    is_partial: boolean;
    /** False when the stored event history does not reach this month. Every count is then `null`. */
    measurable: boolean;
    /** Why not, in the reader's language. `null` when the month was measured. */
    unknown_reason: string | null;
}

/** The `data` of a successful `GET /api/conversion/trial-trend`. */
export interface TrialTrendResponse {
    app_id: string;
    app_name: string;
    /** How many months were actually returned, after clamping. */
    months: number;
    /** First instant of the oldest bucket, and the judgement instant. */
    since: string | null;
    until: string;
    as_of: string;

    /**
     * Oldest month first — the order a chart's x-axis reads in.
     *
     * `null` when no Partner sync has completed. The page's `_trendNeverSynced` tests
     * `!Array.isArray(d.monthly_trend)` and draws its banner instead of an empty chart, because an
     * empty chart under a title reads as "we measured these months and nothing happened".
     */
    monthly_trend: TrialTrendMonth[] | null;
    /** The methodology sentence the page renders in a Banner beneath the chart. */
    note: string;
    /** Rendered one <p> each, KEYED BY THE STRING. Every entry must be unique. */
    warnings: string[];
    diagnostics: {
        subscriptions_app_wide: number;
        /** Months whose counts could not be measured at all. */
        unmeasured_months: number;
        inferred_state_subscriptions: number;
        skipped_keyless_subscription_events: number;
        test_subscriptions_excluded: number;
    };

    data_state: CohortDataState;
    unknown_reason?: string;
}
