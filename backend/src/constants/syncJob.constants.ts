/**
 * Background-job vocabulary — what kinds of job exist, what states they move through, who asked for
 * them, and why they failed.
 *
 *  DEPENDENCY-FREE, for the same reason as `partnerVocab.constants`: the sync-job model builds its
 * mongoose `enum` gates from these objects and the job runner branches on them, so this file sits
 * below both and must never import anything.
 *
 * Split from `partnerVocab.constants` rather than piled into it because they answer different
 * questions — one is the Shopify domain, the other is this application's own machinery — and a
 * consumer of one has no business loading the other's vocabulary.
 */

/**
 * A job kind the runner knows how to execute.
 *
 * Deliberately narrow: this is the set the current release actually ships handlers for. A job type
 * with no handler is worse than a missing one — it enqueues, gets claimed, and fails with
 * `UNKNOWN_JOB_TYPE` on every cron tick.
 */
const SYNC_JOB_TYPES = Object.freeze({
    /** A no-op that sleeps and succeeds. Exists so a fresh install can prove the runner works. */
    DUMMY: 'DUMMY',
    /** Pull events and transactions from the Shopify Partner API. */
    PARTNER_SYNC: 'PARTNER_SYNC',
    /** Pull the listing-analytics rollups (page views, engaged views, install clicks). */
    BIGQUERY_SYNC: 'BIGQUERY_SYNC',
    /**
     * Per-install attribution: which store installed, and where it came from.
     *
     * Separate from BIGQUERY_SYNC because it reads the whole event-parameter column — a far heavier
     * scan than the daily rollups — so it needs its own watermark, cost budget and failure domain.
     * A costly failure here must not rewind the rollups into re-running their backfill.
     */
    INSTALL_ATTRIBUTION_SYNC: 'INSTALL_ATTRIBUTION_SYNC'
} as const);

/** Lifecycle state of a sync-job row. */
const SYNC_JOB_STATUS = Object.freeze({
    /** Enqueued, not yet claimed by the runner. */
    PENDING: 'PENDING',
    /** Claimed. `started_at` is set; the claim is what makes a poll-based runner safe. */
    RUNNING: 'RUNNING',
    SUCCESS: 'SUCCESS',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED'
} as const);

/** Who asked for the job — an operator pressing a button, or the schedule. */
const SYNC_JOB_TRIGGERED_BY = Object.freeze({
    MANUAL: 'MANUAL',
    CRON: 'CRON'
} as const);

/**
 * Why a job ended up FAILED.
 *
 * Distinguishes a handler that threw from a job the sweeper gave up on, because the two mean
 * completely different things about the data: a handler throw usually left nothing written, while a
 * sweeper timeout means a run may have written PART of its output and stopped. Only the first is
 * safe to retry blindly.
 */
const SYNC_JOB_FAILURE_REASONS = Object.freeze({
    /** The sweeper found it RUNNING for longer than any legitimate run takes. */
    STUCK_TIMEOUT: 'STUCK_TIMEOUT',
    /** The handler threw. `error_message` / `error_stack` carry the detail. */
    HANDLER_ERROR: 'HANDLER_ERROR',
    /** A `job_type` with no registered handler — enqueued by an older or newer build. */
    UNKNOWN_JOB_TYPE: 'UNKNOWN_JOB_TYPE'
} as const);

export = {
    SYNC_JOB_TYPES,
    SYNC_JOB_STATUS,
    SYNC_JOB_TRIGGERED_BY,
    SYNC_JOB_FAILURE_REASONS
};
