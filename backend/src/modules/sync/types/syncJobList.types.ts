/**
 * Shapes for `GET /api/sync/jobs` — the job-history table.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 * ⚠️ Every `job_type` / `status` / `triggered_by` below is typed `string` rather than the literal
 * union from `constants/sync.constants`, for the reason `syncJob.types` states: these arrive off a
 * query string or come back off a persisted row, and the run-time guard is what narrows them. A
 * declared union would describe a well-behaved caller instead of the untrusted input the validation
 * actually has to receive, and would make that validation read as dead code.
 */

import type { SerializedSyncJob } from './syncJob.types';

/** The query bag `listSyncJobs` accepts. Every field arrives as untrusted text, or not at all. */
export interface SyncJobListParams {
    /** 1-based page. Junk falls back to 1; a page past the end is CLAMPED, never left empty. */
    page?: unknown;
    /** Rows per page. Clamped to `SYNC_JOB_MAX_LIMIT`, with a warning when it was. */
    limit?: unknown;
    /** Comma-separated job types. Unrecognised values are dropped and warned about — never matched. */
    job_type?: unknown;
    /** Comma-separated statuses. Same fail-open treatment. */
    status?: unknown;
    /** Comma-separated triggers (`MANUAL` / `CRON`). Same fail-open treatment. */
    triggered_by?: unknown;
    /** Sort key. Only `createdAt` is servable; see the constants file for why. */
    sort?: unknown;
    /** `asc` or `desc`. Anything else is the default (`desc`). */
    dir?: unknown;
}

/**
 * A tally over one filter group, with a key for every declared value INCLUDING the zeros.
 *
 *  THE ZEROS ARE THE POINT. A group that omits its empty buckets renders as a distribution over
 * whatever happened to occur, so a ledger holding nothing but PARTNER_SYNC rows reads as "100% of
 * jobs are partner syncs" rather than "three of the four job types have never run here" — and
 * "never run" is the single most useful thing this screen can tell an operator.
 *
 * ⚠️ It may also carry a key OUTSIDE the declared vocabulary, when the collection holds a row from a
 * build with a different one. That row is counted rather than hidden, so the tally still reconciles
 * with `ledger_rows`.
 */
export type SyncJobCounts = Record<string, number>;

/** Which values of each group survived validation. Empty ⇒ that group constrains nothing. */
export interface SyncJobListFilters {
    job_type: string[];
    status: string[];
    triggered_by: string[];
}

/** Standard page metadata. `total` is POST-filter; `ledger_rows` on the response is pre-filter. */
export interface SyncJobListPagination {
    page: number;
    limit: number;
    /** Rows matching the applied filters, across every page. */
    total: number;
    /** `0` when nothing matched — not `1`. There is no page to turn to. */
    pages: number;
}

/** The response body of `GET /api/sync/jobs`. */
export interface SyncJobListResponse {
    /** When this answer was measured, ISO-8601. */
    as_of: string;
    /** One page of job rows, newest first by default. Empty is a 200. */
    items: SerializedSyncJob[];
    pagination: SyncJobListPagination;
    sort: { key: string; dir: string };
    filters: SyncJobListFilters;
    /**
     * PRE-FILTER tallies over the whole ledger, with zeros.
     *
     * Pre-filter deliberately: a post-filter count would make every unselected job type read `0` the
     * moment one is chosen, which is a filter that appears to have deleted the rest of the history.
     * What the CURRENT filter selects is `pagination.total`, published beside it.
     */
    job_type_counts: SyncJobCounts;
    status_counts: SyncJobCounts;
    triggered_by_counts: SyncJobCounts;
    /** Rows in the ledger before any filter — what the three tallies above each sum to. */
    ledger_rows: number;
    /** `EMPTY` or `READY`. See `SYNC_JOB_LEDGER_STATES` for why a row count decides it here. */
    ledger_state: string;
    /** `SYNC_DISABLED`. Published because it is why a ledger stops growing while nothing looks broken. */
    sync_disabled: boolean;
    /** Operator-facing sentences. UNIQUE — the dashboard keys them by content, so a duplicate DROPS one. */
    warnings: string[];
}

// ── Repository shapes ───────────────────────────────────────────────────────

/** One `$group` bucket: the value, and how many rows are in it. */
export interface SyncJobCountBucket {
    /** The grouped value. `null` when rows exist that carry no value for that field at all. */
    _id: string | null;
    rows: number;
}

/**
 * The raw `$facet` result behind the list.
 *
 *  ONE AGGREGATION, ONE INSTANT, FOUR PROJECTIONS. The filtered total and the three pre-filter
 * tallies are read in a single pass over the collection, so `ledger_rows`, the three tallies and
 * `pagination.total` cannot disagree with each other the way four separate `countDocuments` calls
 * eventually would.
 *
 * Every branch is an ARRAY because that is what `$facet` produces: `$count` yields `[]` — not a zero
 * — over an empty match, which is exactly the shape a reader forgets. The repository normalises it.
 */
export interface SyncJobListFacets {
    /** `[{ rows: n }]`, or `[]` when NOTHING matched the filter. */
    matched: Array<{ rows: number }>;
    by_job_type: SyncJobCountBucket[];
    by_status: SyncJobCountBucket[];
    by_triggered_by: SyncJobCountBucket[];
}

/** The already-normalised facets the service consumes. */
export interface SyncJobListCounts {
    /** Rows matching the filter. `0` rather than absent when nothing matched. */
    total: number;
    by_job_type: SyncJobCountBucket[];
    by_status: SyncJobCountBucket[];
    by_triggered_by: SyncJobCountBucket[];
}

/**
 * What the page read needs, all of it already VALIDATED by the service.
 *
 * The repository reads no config and makes no policy decision: `sort_field` has already been checked
 * against the allowlist, `limit` has already been clamped, and `skip` has already been computed from
 * a clamped page. A repository that clamped its own limit would be a second place the page size is
 * decided, and the two would drift.
 */
export interface SyncJobPageQuery {
    /** A mongo filter document. `{}` means unfiltered. */
    filter: Record<string, unknown>;
    /** An allowlisted field name. Never raw caller input. */
    sort_field: string;
    /** `1` or `-1`. */
    sort_dir: 1 | -1;
    skip: number;
    limit: number;
}
