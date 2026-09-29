/**
 * Shapes for `GET /api/sync/health`.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 */

import type { CronScheduleStatus } from './cron.types';

// ── The pure collection-state helper ────────────────────────────────────────

/**
 * Everything `resolveCollectionState` needs, all passed in.
 *
 * ⚠️ There is no `config` and no clock in here on purpose: the helper is PURE, so the awkward cases —
 * an empty collection with a set watermark, an unconfigured tier holding stale rows — are constructed
 * from literals in a test rather than assembled through a database.
 */
export interface CollectionStateInput {
    /** Exact row count. `0` is the case the whole helper exists for. */
    rows: number;
    /** One of `HEALTH_COLLECTION_TIERS`. */
    tier: string;
    /** The collection's on-screen name, used in the sentence. */
    label: string;
    /** The partner-app field that governs this collection, or `''` when none does. */
    watermark_field: string;
    /** ISO instant of that watermark, or null when it has never been set. */
    watermark_at: string | null;
    /** Whether the OPTIONAL BigQuery tier is configured at all. */
    listing_tier_connected: boolean;
}

/** A state token and the sentence that goes with it. Built together so they cannot drift apart. */
export interface CollectionStateVerdict {
    /** One of `HEALTH_COLLECTION_STATES`. */
    state: string;
    /** What the state means for this collection, for an operator who cannot see this code. */
    reason: string;
}

// ── Repository shapes ───────────────────────────────────────────────────────

/**
 * Exact row counts for the sixteen collections, keyed by the registry's `key`.
 *
 *  EXACT, from `countDocuments`, never `estimatedDocumentCount`. The estimate reads collection
 * metadata, which can be stale after an unclean shutdown — and the single distinction this endpoint
 * exists to draw is "zero rows or some rows". An estimate that says `0` over a populated collection
 * would report a working sync as one that has never run.
 */
export type CollectionRowCounts = Record<string, number>;

/**
 * Account facts the health screen needs that no row count can show.
 *
 * ⚠️ One boolean on purpose. Read through the models chokepoint rather than `modules/auth`, so the
 * derivation of who the owner is stays the auth module's alone; this only asks whether the pointer's
 * target exists.
 */
export interface AuthHealthFacts {
    /** Setup is locked but `owner_user_id` is null or names no `gi_users` row. */
    owner_missing: boolean;
}

/** The watermark and coverage fields the health read needs off one partner-app row. */
export interface PartnerAppHealthRow {
    _id: unknown;
    app_handle: string;
    display_name: string;
    is_active: boolean;
    last_synced_at?: Date | null;
    last_bq_synced_at?: Date | null;
    last_install_attrib_synced_at?: Date | null;
    earliest_event_at?: Date | null;
    earliest_transaction_at?: Date | null;
    lifetime_sync_completed_at?: Date | null;
    shop_name_coverage_since?: Date | null;
    event_history_gap_days?: number | null;
    charge_link_absent_pct?: number | null;
    charge_link_unresolved_pct?: number | null;
}

/** One `$group` bucket from the health aggregation: a job type (or status) and its newest row. */
export interface JobTypeBucket<TDoc> {
    _id: string | null;
    doc: TDoc;
}

/**
 * The raw `$facet` behind the per-type block.
 *
 *  ONE AGGREGATION, THREE PROJECTIONS, ONE INSTANT — for the same reason the list endpoint uses
 * one: three separate reads are three instants, and a job that finishes between them can be absent
 * from `last_run` while present in `last_success`, which is a contradiction on screen.
 */
export interface SyncJobHealthFacets<TDoc> {
    /** Newest SUCCESS per job type. A type that has never succeeded is simply absent. */
    last_success: Array<JobTypeBucket<TDoc>>;
    /** Newest row per job type, whatever its status. */
    last_run: Array<JobTypeBucket<TDoc>>;
    /** Rows per lifecycle status, over the whole ledger. */
    by_status: Array<{ _id: string | null; rows: number }>;
}

// ── The response ────────────────────────────────────────────────────────────

/** One collection's line on the health screen. */
export interface CollectionHealth {
    /** Registry key — stable, and what a caller keys off. */
    key: string;
    /** The PHYSICAL collection, so an operator can open the right thing in a database client. */
    collection: string;
    label: string;
    /** What it holds, in the reader's terms. */
    holds: string;
    /** One of `HEALTH_COLLECTION_TIERS`. */
    tier: string;
    /** ⚠️ A BARE NUMBER. The dashboard formats it; an envelope renders as an em dash. */
    rows: number;
    /** One of `HEALTH_COLLECTION_STATES`. */
    state: string;
    /** What the state means here, and what to do about it. */
    reason: string;
    /** The partner-app field that governs this collection, or `''`. */
    watermark_field: string;
    /**
     * The NEWEST value of that watermark across every registered app, ISO-8601, or null.
     *
     * ⚠️ ACROSS EVERY APP. With two apps where one has synced and one has not, this is non-null and
     * the collection reads EMPTY rather than NEVER_SYNCED — correct for the app that synced, and
     * optimistic for the one that did not. The per-app watermarks in `apps[]` are where that
     * distinction is visible, which is why they are published beside this.
     */
    watermark_at: string | null;
}

/** The newest successful run of one job type. */
export interface LastSuccessSummary {
    job_id: string;
    completed_at: string | null;
    /** ⚠️ A BARE NUMBER, or null when the job never started. Never `0` for "did not run". */
    duration_ms: number | null;
    triggered_by: string;
}

/** The newest run of one job type, whatever became of it. */
export interface LastRunSummary {
    job_id: string;
    status: string;
    triggered_by: string;
    started_at: string | null;
    completed_at: string | null;
    duration_ms: number | null;
    /** `''` unless the run FAILED. One of `SYNC_JOB_FAILURE_REASONS`. */
    failure_reason: string;
    /** The handler's own message. `''` when there was none. */
    error_message: string;
    /** How many times this row has been CLAIMED. A bare number. */
    attempts: number;
}

/** One registered app's watermarks and coverage gates. */
export interface PartnerAppHealth {
    partner_app_id: string;
    app_handle: string;
    display_name: string;
    is_active: boolean;
    last_synced_at: string | null;
    last_bq_synced_at: string | null;
    last_install_attrib_synced_at: string | null;
    /**
     * The six gates a figure reads before it agrees to publish itself.
     *
     * ⚠️ BARE VALUES, not `confidence.helper` envelopes. The enveloped form belongs to
     * `GET /api/meta/coverage`, whose renderer is ours and knows to unwrap it; anything else doing
     * `Number(envelope)` gets `NaN` and paints an em dash over a figure that exists.
     *
     *  `null` means NOT YET MEASURED and is never the same as `0`. On two of these a measured `0`
     * is the REASSURING value — `event_history_gap_days: 0` asserts the history has no day-wide
     * holes at all, and `charge_link_absent_pct: 0` asserts every charge-bearing row is linked.
     */
    coverage: {
        earliest_event_at: string | null;
        earliest_transaction_at: string | null;
        lifetime_sync_completed_at: string | null;
        shop_name_coverage_since: string | null;
        event_history_gap_days: number | null;
        charge_link_absent_pct: number | null;
        charge_link_unresolved_pct: number | null;
    };
}

/** The runner's CONFIGURATION. Not its liveness — see the field comment on the response. */
export interface SyncRunnerConfig {
    poll_interval_ms: number;
    max_concurrent_jobs: number;
    max_attempts: number;
    stuck_running_ms: number;
    stuck_pending_ms: number;
}

/** The response body of `GET /api/sync/health`. */
export interface SyncHealthResponse {
    as_of: string;
    /** `SYNC_DISABLED`. True means nothing is claimed and no schedule is armed. */
    sync_disabled: boolean;
    /** Whether the OPTIONAL BigQuery tier is configured. False is an ordinary, healthy state. */
    listing_tier_connected: boolean;
    /**
     * The runner's tuning, as CONFIGURED.
     *
     * ⚠️ Configuration, not liveness — it says what the runner would do, not that it is doing it.
     * What is actually armed is `schedules[].scheduled`, which is read from live timers.
     */
    runner: SyncRunnerConfig;
    /** Exactly the sixteen collections this build registers. Never a seventeenth. */
    collections: CollectionHealth[];
    /**
     * Newest SUCCESS per job type, `null` for a type that has never succeeded.
     *
     *  A CROSS-REPOSITORY CONTRACT: the dashboard's `components/growth-intel/syncCategories.js`
     * keys its cards on these exact job-type literals. A key that is absent rather than `null` makes
     * a card claim "Never completed successfully" over a job that runs nightly — a confident negative
     * built from a gap in our own reading, which is the failure this project exists to refuse.
     */
    last_success_per_type: Record<string, LastSuccessSummary | null>;
    /**
     * Newest run per job type whatever its outcome, `null` for a type that has never run.
     *
     * ⚠️ Published BESIDE `last_success_per_type` rather than instead of it, because the pair is what
     * separates the two states an operator must act on differently: a type that has never run at all,
     * and one that runs every night and fails every night. On the success block alone those are the
     * same `null`.
     */
    last_run_per_type: Record<string, LastRunSummary | null>;
    /** Job rows per lifecycle status, over the whole ledger, WITH the zeros. */
    job_status_counts: Record<string, number>;
    /** One entry per known schedule, armed or not. `scheduled` is observed, never inferred. */
    schedules: CronScheduleStatus[];
    /** Every registered app, with its watermarks and coverage gates. `[]` when none is registered. */
    apps: PartnerAppHealth[];
    /** Operator-facing sentences. UNIQUE — the dashboard keys them by content. */
    warnings: string[];
}
