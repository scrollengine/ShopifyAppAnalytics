/**
 * ============================================================================
 *  THE CUSTOM FUNNEL — the frozen response contract, and the shapes behind it
 * ============================================================================
 *
 *  Declarations only — `typeof import(…)` is erased at compile time, so importing this file costs
 *  nothing at run time and does NOT pull the constants module in.
 *
 *  ── EVERY NAME UNDER `CustomFunnelResponse` IS READ BY A REACT COMPONENT ──
 *
 *  `frontend/components/growth-intel/PartnerFunnelChart.js` is byte-identical to the dashboard this
 *  was extracted from. Renaming a field here does not break a build anywhere; it BLANKS PART OF THE
 *  CHART. The specific readers, so a future edit can be checked against them:
 *
 *      steps[].key                 :99   — the selection the page persists to localStorage
 *      steps[].label               :390  — the axis label, and :285 the headline caption
 *      steps[].count               :360  — the bar height (via funnelScale.js:47) and its value label
 *      steps[].unit                :419  — ⚠️ `=== 'events'` EXACTLY; anything else narrates "shops"
 *      steps[].unit_change         :417  — gates the ` *` marker and the amber chip
 *      steps[].conversion_pct      :453  — the chip itself
 *      steps[].rate_basis          :406  — ⚠️ `=== 'decided'` EXACTLY; rewrites the whole tooltip
 *      steps[].rate_denominator    :411  — the decided-basis tooltip's denominator
 *      steps[].undecided           :412  — "N more are still inside their trial"
 *      catalog[].{key,label,source} :94-98, :105-111, :246 — the ENTIRE picker
 *      max_events                  :100  — ⚠️ `(data && data.max_events) || 10`, so 0 becomes 10
 *      conversion_rate             :282  — the headline
 *      period_label                :285  — the caption's suffix
 *      crosses_unit_seam           :463  — the seam Banner
 *      trial_cohort.*              :479-497
 *      window_kpi.converted_in_window :501
 *      diagnostics.charge_link.*   :134-146 — the trial-sourcing sentence
 *      warnings[]                  :526  — one <p> each, KEYED BY THE STRING, so each must be UNIQUE
 *
 *  ── TWO KEYS THIS PAYLOAD MUST NEVER CARRY ───────────────────────────────
 *
 *  `frontend/components/growth-intel/dataState.js` decodes `data.data_state === 'NEVER_SYNCED'` OR
 *  `data.items === null` as NEVER_SYNCED, which NULLS the whole payload and renders a banner in
 *  place of the chart. On a mixed-tier read that is wrong whenever ANY tier is READY: it would
 *  discard Partner steps that are present and correct because the listing tier is unconfigured.
 *  So there is no `items` key here at all, and `data_state` is set ONLY when no tier is READY —
 *  the one case where the banner is the honest rendering because nothing at all can be measured.
 * ============================================================================
 */

import type { ChargeCohortDiagnostics, ChargeLinkState, CohortSubscription } from './lifecycle.types';

type FunnelEventConstants = typeof import('../constants/funnelEvent.constants');

// ── Vocabulary unions ───────────────────────────────────────────────────────

/** `ga4` | `partner` | `subscription` | `transaction`. Groups the picker. */
export type FunnelEventSource =
    FunnelEventConstants['FUNNEL_EVENT_SOURCES'][keyof FunnelEventConstants['FUNNEL_EVENT_SOURCES']];

/** `events` | `shops`. ⚠️ The chart understands `'events'` and narrates everything else as shops. */
export type FunnelEventUnit =
    FunnelEventConstants['FUNNEL_EVENT_UNITS'][keyof FunnelEventConstants['FUNNEL_EVENT_UNITS']];

/** WHAT is counted: `visitors` | `shops` | `subscriptions`. The fact `unit` cannot express. */
export type FunnelEventPopulation =
    FunnelEventConstants['FUNNEL_EVENT_POPULATIONS'][keyof FunnelEventConstants['FUNNEL_EVENT_POPULATIONS']];

/** `previous_step` | `decided` | `unavailable`. */
export type FunnelRateBasis =
    FunnelEventConstants['FUNNEL_RATE_BASES'][keyof FunnelEventConstants['FUNNEL_RATE_BASES']];

/** `listing` | `partner`. */
export type FunnelTier = FunnelEventConstants['FUNNEL_TIERS'][keyof FunnelEventConstants['FUNNEL_TIERS']];

/** `READY` | `NOT_CONNECTED` | `NEVER_SYNCED`. Decided by a WATERMARK, never a row count. */
export type FunnelTierState =
    FunnelEventConstants['FUNNEL_TIER_STATES'][keyof FunnelEventConstants['FUNNEL_TIER_STATES']];

/** One subscription metric a `source: 'subscription'` step reads off the cohort summary. */
export type SubscriptionFunnelMetric =
    FunnelEventConstants['SUBSCRIPTION_FUNNEL_METRICS'][keyof FunnelEventConstants['SUBSCRIPTION_FUNNEL_METRICS']];

/**
 * One catalog entry, DERIVED from the frozen list rather than restated.
 *
 * ⚠️ A hand-written twin of that shape is a second declaration of the vocabulary, and the two drift
 * in the direction that compiles: add `surface` to the constants and this interface still accepts
 * every entry, so the field silently never reaches the wire. Deriving it means the catalog IS the
 * type. The entry's own docstrings live beside the values in `constants/funnelEvent.constants.ts`.
 *
 * The optional source-specific fields ARE published. They make the API self-describing about which
 * stored field or event type produced a number — the same provenance every step already carries.
 */
export type FunnelCatalogEntry = FunnelEventConstants['FUNNEL_EVENT_CATALOG'][number];

// ── Compile-time proofs ─────────────────────────────────────────────────────

/** Fails to instantiate unless `T` is exactly `true`. */
type Assert<T extends true> = T;

/**
 * PROOF THAT EVERY SUBSCRIPTION METRIC IS A KEY OF THE COHORT SUMMARY.
 *
 * A catalog entry naming a metric the summary does not compute reads `undefined`, which the service
 * would publish as a `count` of `null` — indistinguishable on screen from "this tier is not
 * connected". The step would look like a data-availability problem for the life of the deployment.
 *
 * Exported so `noUnusedLocals` cannot delete the guard as dead weight.
 */
export type AssertEverySubscriptionMetricIsCounted = Assert<
    [SubscriptionFunnelMetric] extends [keyof TrialCohortCounts] ? true : false
>;

/**
 * PROOF THAT EVERY SOURCE MAPS TO A TIER.
 *
 * An unmapped source would resolve to `undefined`, and a tier lookup on `undefined` would report
 * the step as READY by accident — publishing a `0` for a source nothing has ever synced, which is
 * exactly the claim this endpoint exists not to make.
 */
export type AssertEverySourceHasATier = Assert<
    [FunnelEventSource] extends [keyof FunnelEventConstants['FUNNEL_SOURCE_TIERS']] ? true : false
>;

// ── Request ─────────────────────────────────────────────────────────────────

/**
 * The query bag, already CAST (never coerced) by the controller.
 *
 * ⚠️ `events` arrives as a comma-joined string from the page (`funnel/index.js` does
 * `stepEvents.join(',')`) and as a `string[]` from a repeated query parameter. Both are accepted;
 * ORDER IS SIGNIFICANT in both, because the page persists `steps.map(s => s.key)` back to
 * `localStorage['gi.funnel.stepEvents']` — so a server that reorders rewrites the user's own funnel.
 */
export interface CustomFunnelParams {
    partner_app_id: string;
    /** number, `0` or `'all'`. Normalised by `shared/helpers/dateRange.helper`, never twice. */
    period_days?: number | string;
    /** ISO `YYYY-MM-DD`. Honoured only together with `until`. */
    since?: string;
    until?: string;
    /** Comma-joined, or repeated. Unknown keys are dropped WITH A WARNING, never silently. */
    events?: string | string[];
}

// ── Response ────────────────────────────────────────────────────────────────

/** One tier's state and the operator-facing reason it is not READY. */
export interface FunnelTierStatus {
    state: FunnelTierState;
    /** `null` when READY. Otherwise the sentence that names the missing credential or sync. */
    reason: string | null;
}

/** The per-tier block. Replaces a blanket refusal — see the file header. */
export interface CustomFunnelTiers {
    listing: FunnelTierStatus;
    partner: FunnelTierStatus;
}

/**
 * One funnel step, exactly as the chart reads it.
 *
 * `count: null` IS NOT `0`. `0` is the claim "we measured this and it was zero"; `null` is "the
 * tier behind this step has nothing to answer with". `funnelScale.js:47` leaves the axis unaffected
 * by a null and `_fmtNum(null)` renders an em dash, so a null step draws as a zero-height bar with
 * a `—` label — visibly absent rather than a claimed zero.
 */
export interface CustomFunnelStep {
    key: string;
    label: string;
    source: FunnelEventSource;
    unit: FunnelEventUnit;
    /** ⚠️ Not read by the chart. Published because `unit` cannot say a step counts subscriptions. */
    population: FunnelEventPopulation;
    /** `null` when the step's tier is not READY, or when the tier is READY and has no row. */
    count: number | null;
    /** From the PREVIOUS step. `null` on step 0 and whenever either side is unknown. */
    conversion_pct: number | null;
    /**
     * `1 - conversion_pct`, or `null`.
     *
     * `null` — never a negative number — when `conversion_pct` exceeds 1. Across a unit seam, or
     * on the decided basis, a step can legitimately exceed its predecessor (shops can outnumber the
     * GA4 clicks in a partial window), and "-42.0% drop-off" is nonsense that renders perfectly.
     */
    drop_pct: number | null;
    /** Against the FIRST step. `null` when either end is unknown or the first step is zero. */
    cumulative_conversion_pct: number | null;
    /** True when this step's `unit` differs from the previous step's. Drives the ` *` marker. */
    unit_change: boolean;
    /** True when `population` changes and `unit` does NOT — a seam the chart cannot mark. */
    population_change: boolean;
    /** ⚠️ `null` on step 0. `'decided'` is tested EXACTLY by the chart. */
    rate_basis: FunnelRateBasis | null;
    /** The denominator actually used. `null` on step 0 and on the `unavailable` basis. */
    rate_denominator: number | null;
    /** Decided basis only: subscriptions excluded from BOTH sides because their trial is running. */
    undecided: number | null;
    /** False when the tier behind this step is not READY, or the tier has no row for this window. */
    available: boolean;
    /** ⚠️ Present ONLY when `available` is false. The sentence that says why the count is null. */
    unknown_reason: string | null;
}

/** The raw counts behind the trial block. Every member is a BARE NUMBER. */
export interface TrialCohortCounts {
    /** Subscriptions whose trial STARTED inside the window. The cohort. */
    trial_started: number;
    /** Of the cohort, still inside their trial as of the judgement instant. The UNDECIDED. */
    still_on_trial: number;
    /** Of the cohort, reached paid billing at any point: `currently_paying + churned_after_trial`. */
    trial_converted: number;
    churned_during_trial: number;
    churned_after_trial: number;
    currently_paying: number;
    /** `trial_started - still_on_trial`. The denominator of the decided-basis rate. */
    decided: number;
}

/**
 * The trial block under the chart, read from THIS payload — there is no second call.
 *
 * `null`, never `{}` and never a zeroed object, when no subscription step is selected. The
 * component guards on truthiness (`:116-124`), so `{}` renders the whole block with four em dashes
 * — four measurements presented as unavailable when the truth is that nobody asked for them.
 */
export interface TrialCohortBlock extends TrialCohortCounts {
    /** The same numbers again, nested, because the source contract carries both spellings. */
    counts: TrialCohortCounts;
    /** `trial_converted / decided`. `null` — never `0` — when nothing has decided yet. */
    conversion_rate: number | null;
}

/**
 * The one figure that is deliberately NOT a funnel step.
 *
 * "Every trial that ended in this window, whichever cohort it started in" — a different population
 * from the step above it, which is why the chart captions it separately (`:510-513`).
 */
export interface CustomFunnelWindowKpi {
    /**
     * Subscriptions whose `charge.billingOn` falls inside the window.
     *
     * ⚠️ A FLOOR. Only a subscription Shopify supplied a `billingOn` for can be dated, so
     * conversions on the settled-payout basis are invisible here. `diagnostics.charge_link`
     * publishes how many that is.
     */
    converted_in_window: number;
}

/** What was excluded, counted, so the payload can be reconciled with the collections behind it. */
export interface CustomFunnelDiagnostics {
    /**
     * The three counts behind the chart's trial-sourcing sentence (`:134-146`).
     *
     * `null` when no subscription step was selected — the cohort was never folded, so there is
     * nothing to report and a zeroed object would claim there were no subscriptions.
     */
    charge_link: Record<ChargeLinkState, number> | null;
    /**
     * The oldest payout this deployment has STORED, or `null` when it has never been measured.
     *
     * The floor under every payout step, and specifically under `first_transaction` — which reads
     * "first ever" off stored history and therefore inflates, not deflates, when that history is
     * short. Published so a reader can check the claim rather than take the warning's word for it.
     * ⚠️ Distinct from `earliest_event_at` on purpose; see `models/partner/partnerApp.model.ts:122`.
     */
    earliest_transaction_at: string | null;
    /** Partner events in the window whose `shop_domain` was blank. Excluded from every count. */
    shopless_partner_events: number;
    /** Subscription events carrying neither a charge id nor a shop domain. Skipped, never pooled. */
    skipped_keyless_subscription_events: number;
    /** Subscriptions excluded for `raw_event.charge.test === true`. Asymmetric — see the service. */
    test_subscriptions_excluded: number;
    /** Subscriptions booked ON_TRIAL on the `inferred` basis — the one branch that guesses. */
    inferred_state_subscriptions: number;
    /**
     * THE CANCEL TRAP, QUANTIFIED — and quantified ONLY. Nothing in this payload has been
     * adjusted by any of it.
     *
     * Shopify emits a plan change as a cancellation of the old charge plus an acceptance of the new
     * one IN THE SAME SECOND, and the cohort keys per CHARGE — so one merchant upgrading once
     * produces two `trial_started`, an end that is not a departure, and (inside a trial) one
     * `churned_during_trial` against the merchant who did the best available thing. These counters
     * say how much of that is present, so the decision about what to do can be made against a
     * number. Every one is a FLOOR: detection needs both charges to carry an id.
     *
     * ⚠️ THE TYPE IS THE RESOLVER'S OWN, indexed rather than restated. A second hand-written copy of
     * this shape is how a counter is added upstream and silently never reaches the payload — which
     * is the exact fate `subscriptions_superseded` had before this block existed.
     */
    supersession: ChargeCohortDiagnostics['supersession'] | null;
    /**
     * The `announcing event → charge.billingOn` gap, bucketed. ⚠️ A REPORTING TALLY: nothing is
     * reclassified on it and `band_max_days` is not a trial-length threshold.
     *
     * It exists because `billingOn` is published as the trial end on this build's HIGHEST-confidence
     * basis, and the live data does not support that certainty — the gap is bimodal and no stored
     * field separates a real trial from a first billing one cycle out. `negative` counts the rows
     * where the date precedes the event announcing it, which cannot be a trial end under any reading.
     */
    billing_on_gap: ChargeCohortDiagnostics['billing_on_gap'] | null;
    /** Event keys the caller asked for that are not in the catalog. */
    unknown_event_keys: string[];
    /** Duplicate keys collapsed. Two bars with one key is a duplicate React key, not two steps. */
    duplicate_event_keys: string[];
    /** Keys dropped for exceeding `max_events`. */
    dropped_over_cap_event_keys: string[];
}

/**
 * The whole payload.
 *
 * ⚠️ There is deliberately no `items` key and no unconditional `data_state` — see the file header.
 */
export interface CustomFunnelResponse {
    app_id: string;
    app_name: string;
    period_label: string;
    period_days: number | 'all' | null;
    kind: string;
    since: string | null;
    until: string;
    /**
     * The upper bound the GA4 steps were actually read at: `min(until, last_bq_synced_at)`.
     *
     * ⚠️ A GUARD, NOT A REPAIR, and the warning beside it says so. The rollup stores one row per UTC
     * midnight and no sync writes a day later than itself, so this bound removes essentially nothing.
     * The skew it was meant to fix is the export lag — the most recent day or two of the window hold
     * no listing rows while Partner events for them do — and that survives, in the flattering
     * direction. Published so a reader can see the two halves' spans rather than infer them.
     *
     * ⚠️ May be EARLIER than `since` when the listing tier is far behind. That is not an inverted
     * range: no rollup query is issued at all in that case and every listing step comes back `null`.
     * `null` when the listing tier is not READY.
     */
    ga4_until: string | null;
    /** The resolved selection, in the order it will be drawn. Echoed so a client can diff it. */
    events: string[];

    steps: CustomFunnelStep[];
    /** Last step over first step. `null`, never `0`, when either end is unknown or zero. */
    conversion_rate: number | null;
    /** True when any step's `unit` differs from its predecessor's. Gates the seam Banner. */
    crosses_unit_seam: boolean;

    trial_cohort: TrialCohortBlock | null;
    window_kpi: CustomFunnelWindowKpi | null;
    diagnostics: CustomFunnelDiagnostics;
    /** Rendered verbatim, one <p> each, KEYED BY THE STRING. Every entry must be unique. */
    warnings: string[];

    /** The whole picker. Every `steps[].key` must appear here — see the constants file header. */
    catalog: readonly FunnelCatalogEntry[];
    max_events: number;

    tiers: CustomFunnelTiers;
    /**
     * ⚠️ SET ONLY WHEN NO TIER IS READY. `dataState.js` treats `'NEVER_SYNCED'` here as "null the
     * whole payload and render a banner", which is right when nothing can be measured and wrong the
     * moment one tier can.
     */
    data_state?: FunnelTierState;
    /** The banner body for the case above. Without it the page prints the SUCCESS message. */
    unknown_reason?: string;
}

// ── Internal shapes ─────────────────────────────────────────────────────────

/** What `resolveRequestedEvents` answers. Every rejection is NAMED, never silently dropped. */
export interface ResolvedFunnelSelection {
    /** The keys to build steps from, in the order requested. */
    keys: string[];
    /** Requested keys not in the catalog. Warned about — see trap 9 in the spec. */
    unknown: string[];
    /** Requested keys that repeated. A duplicate key is a duplicate React key, not a second bar. */
    duplicates: string[];
    /** Keys past `max_events`. */
    dropped_over_cap: string[];
    /** True when the caller named nothing usable and the fallback was applied. */
    used_fallback: boolean;
}

/** The trial cohort plus the window KPI, folded from the same subscription list in one pass. */
export interface TrialCohortFold {
    counts: TrialCohortCounts;
    conversion_rate: number | null;
    converted_in_window: number;
    /** Subscriptions whose state came from the `inferred` branch — the only guess in the machine. */
    inferred_state_subscriptions: number;
    /**
     * Where each COHORT subscription's trial length came from.
     *
     * THE COHORT, NOT THE APP. The resolver's own triple counts every subscription the app has
     * ever had, because the event pull that feeds it has no lower bound by design. The chart captions
     * these three "for R of T subscriptions" and prints the sentence beneath the WINDOW cohort, so
     * the app-wide triple put a lifetime T under a window-scoped block on any long-lived app.
     */
    charge_link: Record<ChargeLinkState, number>;
}

/** The window a cohort fold is judged against. `since: null` is lifetime — no lower bound at all. */
export interface TrialCohortWindow {
    since: Date | null;
    until: Date;
}

/** Every subscription the resolver produced, plus the window and instant to fold them against. */
export interface TrialCohortInput extends TrialCohortWindow {
    subscriptions: readonly CohortSubscription[];
}
