/**
 * ============================================================================
 *  COHORT RETENTION — the frozen response contract
 * ============================================================================
 *
 *  Declarations only — `typeof import(…)` is erased at compile time, so importing this file costs
 *  nothing at run time and does NOT pull the constants module in.
 *
 *  ── EVERY NAME UNDER `CohortRetentionResponse` IS READ BY A REACT COMPONENT ─────────────────
 *
 *  `frontend/components/growth-intel/conversion/CohortRetentionHeatmap.js`. The readers:
 *
 *      cohorts[]                 :33, :36, :72 — the rows, OLDEST FIRST
 *      cohorts[].cohort_week     :72, :77      — ⚠️ THE REACT KEY, and the row label (parsed as a date)
 *      cohorts[].installs        :80
 *      cohorts[].checkpoints     :82           — ⚠️ indexed as `checkpoints['day_' + N]`
 *      checkpoints[day_N].pct    :83           — `null`/absent ⇒ grey cell, em dash
 *      checkpoints[day_N].retained/.eligible :87 — the cell tooltip
 *      checkpoints_days          :34, :65, :81 — the column headers AND the cell lookups
 *
 *  ──  AN UNREACHED CHECKPOINT IS AN ABSENT OBJECT, NOT AN OBJECT OF NULLS ──────────────────
 *
 *  `:82-83` is `const cp = row.checkpoints['day_' + d]; const pct = cp ? cp.pct : null;` and `:87`
 *  titles the cell "Cohort not aged enough" only when `cp` is FALSY. So `{ pct: null, retained: null,
 *  eligible: null }` renders the same grey cell with the WRONG tooltip — "—/— retained" — while
 *  `null` renders the grey cell with the sentence that explains it. The distinction costs nothing and
 *  is the entire honesty mechanism of this endpoint, so the type says `| null` rather than making the
 *  members nullable.
 * ============================================================================
 */

type CohortRetentionConstants = typeof import('../constants/cohortRetention.constants');

/** `READY` | `NEVER_SYNCED`. Decided by the WATERMARK, never a row count. */
export type CohortRetentionDataState =
    CohortRetentionConstants['RETENTION_DATA_STATES'][keyof CohortRetentionConstants['RETENTION_DATA_STATES']];

/**
 * One cell: a cohort measured at one checkpoint.
 *
 * ⚠️ Reached only by stores whose own `installed_at + N days` has already passed. `eligible` is
 * therefore the DENOMINATOR and can be smaller than the cohort — see `partial`.
 */
export interface RetentionCheckpoint {
    /** Days after each store's OWN install. Echoed so a cell is self-describing. */
    days: number;
    /** Stores whose checkpoint instant has arrived. Never zero — a zero publishes `null` instead. */
    eligible: number;
    /** Of those, still installed at their own checkpoint instant. */
    retained: number;
    /** `retained ÷ eligible`, through the module's one `rate()`. Never `0` for an empty denominator. */
    pct: number | null;
    /**
     * True when some of the cohort has not reached this checkpoint yet, so the cell is measured over
     * a SUBSET. ⚠️ Not an error and not a null: a partial cell is a real measurement of the stores
     * that have lived long enough, and hiding it would blank a column for a whole week over one late
     * installer. The service warns when any cell is partial.
     */
    partial: boolean;
}

/** One row of the heatmap: a week's installs, measured at every checkpoint. */
export interface RetentionCohortRow {
    /** `YYYY-MM-DD` of the week's Monday, UTC. ⚠️ THE REACT KEY — unique by construction. */
    cohort_week: string;
    /** The week's last instant, so a reader can see the span the row covers. */
    cohort_week_end: string;
    /** True when the week is still running. Its checkpoints are all young by definition. */
    is_partial_week: boolean;
    /** Distinct stores whose FIRST install in the reported span fell in this week. A BARE NUMBER. */
    installs: number;
    /** Whole days from the week's start to the judgement instant. Always a number. */
    aged_days: number;
    /**
     *  `null` per checkpoint the cohort has not reached — never a zeroed object, and never `pct: 0`.
     * A `0` paints the cell solid red and captions it "0%": a checkable false claim that everyone
     * churned, made about merchants who installed last week.
     */
    checkpoints: Record<string, RetentionCheckpoint | null>;
    /** The checkpoint days this row could answer for. Derived from `checkpoints`, published for JSON. */
    measured_checkpoints: number[];
    /** The ones it could not. The machine-readable form of every `null` above. */
    unreached_checkpoints: number[];
}

/** What the query bag may carry. Passed through RAW by the controller — it validates SHAPE only. */
export interface CohortRetentionParams {
    partner_app_id: string;
    /** Weekly cohorts to return. Out of range is CLAMPED and reported, never refused. */
    weeks?: number | string;
}

/** Counters an operator or a JSON reader can reconcile the grid against. */
export interface CohortRetentionDiagnostics {
    /** Relationship events the fold was handed. */
    relationship_events_read: number;
    /** Install events the spine could not attach to a store. Excluded from every count above. */
    shopless_install_events: number;
    /** Relationship events the fold could not use, by its own reckoning. */
    shopless_relationship_events: number;
    /** Events dated after the judgement instant — clock skew, never allowed to decide a state. */
    future_relationship_events: number;
    /**
     * Cohort stores the fold produced NO install state for at some checkpoint.
     *
     * ⚠️ Should be zero by construction: every cohort store has an install event at or before its own
     * checkpoint. A non-zero value means the spine and the relationship pull disagree about a store,
     * which is a coverage fault worth seeing rather than a retention figure worth publishing.
     */
    stores_without_state: number;
    /** Cells published as `null` because no store in the cohort had reached the checkpoint. */
    unreached_cells: number;
    /** Cells measured over a subset of their cohort. */
    partial_cells: number;
    earliest_event_at: string | null;
}

/** The whole payload. */
export interface CohortRetentionResponse {
    app_id: string;
    app_name: string;
    as_of: string;
    /** The oldest cohort week's first instant, and the newest's last. */
    since: string | null;
    until: string;
    /** Weekly cohorts actually returned, after clamping. */
    weeks: number;

    /**
     * ⚠️ `null` — never `[]` — when no Partner sync has completed. An empty ARRAY is a measured empty;
     * `null` means we have not looked, and the decoder routes it to a banner.
     */
    cohorts: RetentionCohortRow[] | null;
    /** ⚠️ The column headers AND the `day_N` lookups. The two are built from ONE array in the service. */
    checkpoints_days: readonly number[];
    /** The sentence that defines what "retained" means here, published beside the numbers. */
    retention_basis: string;

    diagnostics: CohortRetentionDiagnostics;
    /** One <p> each on the page, keyed by the string — every entry must be UNIQUE. */
    warnings: string[];
    data_state: CohortRetentionDataState;
    /** The banner body. Without it the page prints the SUCCESS message under "Nothing synced yet". */
    unknown_reason?: string;
}
