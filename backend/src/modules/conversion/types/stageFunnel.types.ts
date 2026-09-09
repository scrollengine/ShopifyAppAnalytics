/**
 * ============================================================================
 *  THE FIXED 7-STAGE FUNNEL — the response contract, and the compile-time proofs
 * ============================================================================
 *
 *  Declarations only — `typeof import(…)` is erased at compile time, so importing this file costs
 *  nothing at run time and does NOT pull the constants modules in.
 *
 *  ── EVERY NAME UNDER `StageFunnelResponse` IS READ BY A REACT COMPONENT ─────────────────────
 *
 *  `frontend/components/growth-intel/conversion/ConversionFunnelChart.js`. Renaming a field here
 *  does not break a build anywhere; it BLANKS PART OF THE CHART. The readers:
 *
 *      stages[]                       :24, :53  — the bars, in order
 *      stages[].key                   :58       — the React key
 *      stages[].label                 :64
 *      stages[].source                :60, :71  — ⚠️ `STAGE_COLORS[s.source]` and
 *                                                 `=== 'ga4' ? 'GA4' : 'Partner API'`. TWO literals.
 *      stages[].count                 :25, :56, :83
 *      stages[].conversion_pct        :96
 *      stages[].cumulative_conversion_pct :96
 *      stages[].drop_pct              :95       — tones the caption critical above 0.5
 *      period_label                   :44
 *      overall_install_rate           :47
 *      overall_paid_conversion_rate   :48
 *      seam_diagnostics.drift_pct     :36, :103, :110 — and the >25% Banner
 *      seam_diagnostics.ga4_installs  :104
 *
 *  ── THE COMPILE-TIME PROOFS AT THE BOTTOM ──────────────────────────────────────────────────
 *
 *  This funnel is FIXED, so a mistyped stage key is OUR error, not the operator's — and left to the
 *  runtime it would surface as `custom-funnel`'s "not in this build's event catalog" warning, which
 *  tells the reader to re-pick steps from a picker this endpoint does not have. The assertions below
 *  turn that into a build failure instead.
 * ============================================================================
 */

import type {
    CustomFunnelDiagnostics,
    CustomFunnelTiers,
    FunnelEventPopulation,
    FunnelEventSource,
    FunnelEventUnit,
    FunnelRateBasis,
    FunnelTierState
} from './customFunnel.types';

type StageFunnelConstants = typeof import('../constants/stageFunnel.constants');
type FunnelEventConstants = typeof import('../constants/funnelEvent.constants');

/** `ga4` | `partner`.  EXACTLY TWO — see the constants file; both are read as literals on screen. */
export type StageChartSource =
    StageFunnelConstants['STAGE_CHART_SOURCES'][keyof StageFunnelConstants['STAGE_CHART_SOURCES']];

/** One bar. A superset of `CustomFunnelStep` — nothing the catalog knows is dropped on the way out. */
export interface StageFunnelStage {
    key: string;
    label: string;
    /**  THE CHART'S source, collapsed to two members. See `STAGE_CHART_SOURCE_BY_CATALOG_SOURCE`. */
    source: StageChartSource;
    /** The CATALOG's source, all four members, carried so nothing is lost in the collapse above. */
    catalog_source: FunnelEventSource;
    /** `listing` | `partner` — which tier had to be READY for this stage to have a number. */
    tier: string;
    unit: FunnelEventUnit;
    /** WHAT is counted. ⚠️ `visitors` above the seam, `shops` and `subscriptions` below it. */
    population: FunnelEventPopulation;
    /**  `null` is "the tier behind this stage cannot answer", NEVER "nobody did this". */
    count: number | null;
    conversion_pct: number | null;
    drop_pct: number | null;
    cumulative_conversion_pct: number | null;
    unit_change: boolean;
    population_change: boolean;
    /**
     * True when this stage's population differs from its predecessor's — the boundary at which a
     * ratio stops being a per-entity conversion. Published per stage because the chart marks exactly
     * ONE seam (`idx === 4`) and this funnel crosses two.
     */
    crosses_measurement_seam: boolean;
    rate_basis: FunnelRateBasis | null;
    rate_denominator: number | null;
    undecided: number | null;
    available: boolean;
    unknown_reason: string | null;
}

/**
 * The two install counts and the gap between them.
 *
 * ⚠️ `drift_pct` is `null` — never `0` — when either side is unknown or GA4 recorded no installs.
 * `ConversionFunnelChart.js:36` reads it through a `typeof === 'number'` guard and prints "n/a"
 * otherwise, and `:37` only banners a drift it can actually measure. A `0` there would assert the two
 * systems AGREE, which is the most reassuring thing this payload can say and the one it must not
 * invent.
 */
export interface StageFunnelSeamDiagnostics {
    /** GA4's install count — the drift's denominator. `null` when the listing tier cannot answer. */
    ga4_installs: number | null;
    /** The Partner API's install count — the numerator. */
    partner_installs: number | null;
    /** Signed `(partner − ga4) ÷ ga4`. See `STAGE_FUNNEL_DRIFT_BASIS` for why it keeps its sign. */
    drift_pct: number | null;
    /** The sentence that defines the figure above, published beside it. */
    drift_basis: string;
    /** False when either count is unknown or GA4's is zero. */
    measurable: boolean;
    /** Present only when `measurable` is false. */
    unknown_reason: string | null;
}

/** What the query bag may carry. Passed through RAW by the controller — it validates SHAPE only. */
export interface StageFunnelParams {
    partner_app_id: string;
    period_days?: number | string;
    since?: string;
    until?: string;
}

/** The whole payload. */
export interface StageFunnelResponse {
    app_id: string;
    app_name: string;
    period_label: string;
    period_days: number | 'all' | null;
    kind: string;
    since: string | null;
    until: string;
    /** The bound the listing stages were actually read at. A guard, not a repair — see the catalog. */
    ga4_until: string | null;

    stages: StageFunnelStage[];
    /** The keys this funnel is defined as, echoed so the definition is inspectable from the wire. */
    stage_keys: readonly string[];
    /**  The index the CHART hard-codes as its seam row. Published so the contract is checkable. */
    seam_stage_index: number;
    seam_diagnostics: StageFunnelSeamDiagnostics;

    /**
     * Partner installs ÷ listing views.  CROSSES THE MEASUREMENT SEAM — stores over visitors.
     * `null`, never `0`, when either end is unknown or the denominator is zero.
     */
    overall_install_rate: number | null;
    /**
     * Subscriptions that reached paid billing ÷ Partner installs.  CROSSES A POPULATION BOUNDARY —
     * subscriptions over stores, so it can legitimately exceed 100%.
     */
    overall_paid_conversion_rate: number | null;
    /** The two sentences that define the rates above. The chart badges them with no marker at all. */
    rate_definitions: StageFunnelConstants['STAGE_FUNNEL_RATE_DEFINITIONS'];

    diagnostics: CustomFunnelDiagnostics;
    /** One <p> each on the page, keyed by the string — every entry must be UNIQUE. */
    warnings: string[];
    tiers: CustomFunnelTiers;
    /** ⚠️ SET ONLY WHEN NO TIER IS READY — see `custom-funnel`'s contract, which this inherits. */
    data_state?: FunnelTierState;
    unknown_reason?: string;
}

// ── Compile-time proofs ─────────────────────────────────────────────────────

/** Fails the build unless `T` is exactly `true`. */
type _Assert<T extends true> = T;

/** The catalog's key union, derived from the catalog itself. */
type _CatalogKey = FunnelEventConstants['FUNNEL_EVENT_CATALOG'][number]['key'];

/**
 *  Every key the fixed funnel names must be a REAL catalog key.
 *
 * `STAGE_FUNNEL_EVENT_KEYS` is `readonly string[]`, so this cannot be proved element-wise from the
 * array's own type. It is proved instead against the three named key objects, which carry literal
 * types — and those are the keys every derived figure on this payload is taken off, so a typo in the
 * array alone would show as an empty seam or an empty headline rather than a wrong number.
 */
export type _AssertSeamKeysAreCatalogKeys = _Assert<
    StageFunnelConstants['STAGE_FUNNEL_SEAM_KEYS'][keyof StageFunnelConstants['STAGE_FUNNEL_SEAM_KEYS']] extends _CatalogKey
        ? true
        : false
>;

/** The same proof for the three stages the headline rates are taken between. */
export type _AssertHeadlineKeysAreCatalogKeys = _Assert<
    StageFunnelConstants['STAGE_FUNNEL_HEADLINE_KEYS'][keyof StageFunnelConstants['STAGE_FUNNEL_HEADLINE_KEYS']] extends _CatalogKey
        ? true
        : false
>;

/**
 *  The chart-source map must be TOTAL over the catalog's four sources.
 *
 * A missing entry resolves to `undefined`, which `ConversionFunnelChart.js` renders as an uncoloured
 * bar captioned "Partner API" — a GA4 stage silently presented as a Partner one, which is exactly the
 * misattribution the seam caption exists to prevent.
 */
export type _AssertEverySourceHasAChartSource = _Assert<
    FunnelEventSource extends keyof StageFunnelConstants['STAGE_CHART_SOURCE_BY_CATALOG_SOURCE'] ? true : false
>;
