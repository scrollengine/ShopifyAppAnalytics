/**
 * ============================================================================
 *  TIME TO PAID — the frozen response contract, and the fold behind it
 * ============================================================================
 *
 *  Declarations only — `typeof import(…)` is erased at compile time, so importing this file costs
 *  nothing at run time and does NOT pull the constants module in.
 *
 *  ── EVERY NAME UNDER `TimeToPaidResponse` IS READ BY A REACT COMPONENT ──────────────────────
 *
 *  `frontend/components/growth-intel/conversion/TimeToPaidHistogram.js`. Renaming a field here does
 *  not break a build anywhere; it BLANKS PART OF THE CARD. The readers, so a future edit can be
 *  checked against them:
 *
 *      total_paid_shops   :21, :26, :29, :39 — ⚠️ `typeof === 'number'`, and `=== 0` selects the
 *                                             WHOLE empty state. It is the histogram's denominator.
 *      buckets[].label    :45, :51          — ⚠️ THE REACT KEY. Two buckets with one label and one
 *                                             bar is DROPPED rather than drawn twice.
 *      buckets[].count    :19, :46, :47, :64
 *      period_label       :39
 *      stats.*            :73-100           — median / mean / p25 / p75 / min / max, `null` for none
 * ============================================================================
 */

type TimeToPaidConstants = typeof import('../constants/timeToPaid.constants');

/** `READY` | `NEVER_SYNCED`. Decided by the WATERMARK, never a row count. */
export type TimeToPaidDataState =
    TimeToPaidConstants['TIME_TO_PAID_DATA_STATES'][keyof TimeToPaidConstants['TIME_TO_PAID_DATA_STATES']];

/** One histogram bar. Present even at `count: 0` — see the helper's header. */
export interface TimeToPaidBucketRow {
    key: string;
    /** ⚠️ THE REACT KEY on the page. Unique across the vocabulary. */
    label: string;
    min_days: number;
    /** `null` on the open-ended tail. */
    max_days: number | null;
    /** A BARE NUMBER, always. A bucket nobody landed in is a measured zero inside a measured set. */
    count: number;
}

/**
 * The strip beneath the histogram.
 *
 * ⚠️ The WHOLE BLOCK is `null` when nothing converted — never a set of zeros, which renders as
 * "Median 0.0d" and claims every merchant paid the day they installed.
 */
export interface TimeToPaidStats {
    /** How many stores the five figures below were measured over. */
    count: number;
    mean_days: number;
    median_days: number;
    p25_days: number;
    p75_days: number;
    min_days: number;
    max_days: number;
}

/** What `foldTimeToPaid` answers. */
export interface TimeToPaidFold {
    buckets: TimeToPaidBucketRow[];
    stats: TimeToPaidStats | null;
    /** Day figures no bucket covered. Unreachable while the vocabulary is contiguous; counted anyway. */
    unbucketed: number;
}

/**
 * The stores on the install spine that produced no time-to-paid figure, split by WHY.
 *
 *  Every one of these is a store EXCLUDED FROM THE HISTOGRAM, not a store bucketed at zero. Two of
 * the three are ordinary funnel facts and one is a coverage gap; collapsing them into a single count
 * would hide the coverage gap inside the business one. See the constants file.
 */
export interface TimeToPaidExclusions {
    /** The three below, summed. Published so a reader need not add them up to check the total. */
    total: number;
    not_converted: number;
    converted_without_billing_date: number;
    converted_before_install: number;
}

/** What the query bag may carry. Passed through RAW by the controller — it validates SHAPE only. */
export interface TimeToPaidParams {
    partner_app_id: string;
    period_days?: number | string;
    since?: string;
    until?: string;
}

/** Counters an operator or a JSON reader can reconcile the payload against. */
export interface TimeToPaidDiagnostics {
    /** Stores on the install spine for this window — the population the histogram is drawn from. */
    installed_shops: number;
    /** Install events the spine could not attach to a store. Excluded from every count above. */
    shopless_install_events: number;
    /** Subscription events skipped for carrying neither a charge id nor a domain. Never pooled. */
    skipped_keyless_subscription_events: number;
    test_subscriptions_excluded: number;
    /** Day figures the bucket vocabulary could not place. Unreachable today; counted anyway. */
    unbucketed_days: number;
    earliest_event_at: string | null;
}

/** The whole payload. */
export interface TimeToPaidResponse {
    app_id: string;
    app_name: string;
    period_label: string;
    period_days: number | 'all' | null;
    kind: string;
    since: string | null;
    until: string;
    as_of: string;

    /**
     * ⚠️ `null` — never `[]` — when no Partner sync has completed. An empty ARRAY is a measured empty
     * and draws seven honest zero-height bars; `null` means we have not looked.
     */
    buckets: TimeToPaidBucketRow[] | null;
    stats: TimeToPaidStats | null;
    /**
     * How many stores the histogram partitions.
     *
     * ⚠️ A BARE NUMBER on a measured read, and `null` when nothing has synced. The page tests
     * `typeof === 'number'` and treats `0` as its empty state, so the null never reaches it — the
     * decoder routes a `NEVER_SYNCED` payload to a banner before the component mounts.
     *
     * ⚠️ It is a FLOOR whenever `excluded.converted_without_billing_date` is above zero: those stores
     * genuinely converted and simply cannot be dated.
     */
    total_paid_shops: number | null;
    /** Stores on the spine, converted or not. The histogram's population before exclusions. */
    total_installed_shops: number | null;
    excluded: TimeToPaidExclusions | null;

    diagnostics: TimeToPaidDiagnostics;
    /** One <p> each on the page, keyed by the string — every entry must be UNIQUE. */
    warnings: string[];
    data_state: TimeToPaidDataState;
    /** The banner body. Without it the page prints the SUCCESS message under "Nothing synced yet". */
    unknown_reason?: string;
}
