'use strict';

/**
 * ============================================================================
 *  SYNC — module vocabulary and fixed timings
 * ============================================================================
 *
 *  Two kinds of value live here, and the distinction is the point:
 *
 *    1. VOCABULARY, re-exported from `src/constants/syncJob.constants` — the
 *       dependency-free file the mongoose schema builds its `enum` gates from.
 *       Nothing is re-spelled: a second literal `'PENDING'` anywhere in the
 *       codebase is a second definition, and two definitions eventually
 *       disagree. The one place this file NARROWS rather than re-exports is
 *       `SYNC_JOB_TYPES` — see its own comment.
 *
 *    2. FIXED TIMINGS that are deliberately NOT configurable. Everything an
 *       operator should be able to tune already lives in `config.SYNC`
 *       (poll interval, concurrency, attempt budget, stuck thresholds, cron).
 *       The values here are internal mechanics — a shutdown drain window, a
 *       maintenance cadence — where a knob would be a way to break the runner
 *       rather than a way to fit it to a deployment.
 * ============================================================================
 */

// `export =` module — a named import is TS2497, so it is imported whole.
import syncJobVocab = require('../../../constants/syncJob.constants');

/**
 * The job kinds this module can actually EXECUTE.
 *
 *  Deliberately NARROWER than `syncJobVocab.SYNC_JOB_TYPES`, which is the set the schema's `enum`
 * will STORE. The two answer different questions and must not be conflated:
 *
 *   - the schema enum asks "is this a value this database has ever known?" — it must stay wide, so
 *     a row written by another build version still loads and still reads correctly;
 *   - this set asks "will something run if I enqueue it?" — and it must stay narrow, because a job
 *     type with no handler is worse than a missing one. It enqueues happily, gets claimed, and dies
 *     as `UNKNOWN_JOB_TYPE` on every cron tick: a job that always fails, with a cause nobody
 *     recognises. The module this was extracted from shipped exactly that bug, with an enum entry
 *     that existed nowhere else.
 *
 * So `createSyncJob` validates against THIS object, and the enqueue is refused up front, by name.
 * Every member here IS runnable: `PARTNER_SYNC` registers its handler from `apps/app.ts` (which
 * would otherwise pull the partner module into this one), and `DUMMY`, `BIGQUERY_SYNC` and
 * `INSTALL_ATTRIBUTION_SYNC` are registered statically in `jobRunner.service.ts`.
 * `assertHandlersRegistered()` refuses to boot if any member of this object has no handler, so this
 * list and the handler table cannot drift apart silently.
 *
 * The types that are storable but NOT here — `KEYWORD_RANKING`, `COMPETITOR_SNAPSHOT`,
 * `LLM_INSIGHT`, `AD_CSV_INGEST` — genuinely ship no handler, and `createSyncJob` refuses them by
 * name with this list attached. That is a statement of fact rather than an oversight.
 *
 * ADDING ONE: add the entry here and register its handler in the SAME change
 * (`jobRunner.registerJobHandler`). `assertHandlersRegistered()` turns a forgotten registration into
 * a loud boot failure instead of a 3am job that fails silently.
 *
 * The values are read from the vocabulary module rather than typed out, so a rename there is a
 * compile error here rather than a set that quietly no longer overlaps.
 */
const SYNC_JOB_TYPES = Object.freeze({
    /** A no-op that sleeps and succeeds. The smoke path: proves the runner works with no credentials. */
    DUMMY: syncJobVocab.SYNC_JOB_TYPES.DUMMY,
    /** Pull events and transactions from the Shopify Partner API. The spine every figure hangs off. */
    PARTNER_SYNC: syncJobVocab.SYNC_JOB_TYPES.PARTNER_SYNC,
    /**
     * The three daily listing-analytics rollups, from the GA4 BigQuery export.
     *
     * The STRING is a cross-repository contract, not a local name. The dashboard's sync
     * registry (`components/growth-intel/syncCategories.js`) keys its cards on this exact literal.
     * A rename here breaks no build anywhere — it silently orphans the card, which then reports no
     * runs for a job that is running perfectly well.
     */
    BIGQUERY_SYNC: syncJobVocab.SYNC_JOB_TYPES.BIGQUERY_SYNC,
    /**
     * Per-install attribution: which store installed, and where it came from.
     *
     * A SEPARATE type from BIGQUERY_SYNC on purpose. It reads the whole event-parameter column,
     * which is a far heavier scan than the three rollups, so it carries its own watermark, its own
     * cost and its own failure domain — a costly failure here must not rewind the rollups into
     * re-running their backfill.
     *
     * Same cross-repository string contract as above.
     */
    INSTALL_ATTRIBUTION_SYNC: syncJobVocab.SYNC_JOB_TYPES.INSTALL_ATTRIBUTION_SYNC
} as const);

/**
 * Every job kind the SCHEMA WILL STORE — the audit vocabulary, as opposed to the runnable one above.
 *
 *  THE TWO ARE DIFFERENT QUESTIONS AND MUST NOT BE CONFLATED, which is why both names exist here.
 * `SYNC_JOB_TYPES` answers "will something run if I enqueue this?" and is narrow on purpose, so the
 * enqueue path can refuse an unrunnable type by name. This one answers "is this a value this database
 * has ever known?" and must stay WIDE, because `gi_sync_jobs` is an audit ledger with no retention:
 * a row written by an older or a newer build has to remain readable and FILTERABLE. A history screen
 * that dropped those rows would report that a job never ran when the evidence that it did is sitting
 * in the collection.
 *
 * Re-exported by REFERENCE from the vocabulary module — the same frozen object the schema's `enum`
 * was built from — so a value this module offers as a filter cannot be one the collection rejects.
 *
 * (The two sets happen to hold identical values in this release, because every storable type now has
 * a handler. They are still separate names: the day they diverge, the reader who has to work out
 * which one a call site meant will not have the comment that explains it.)
 */
const STORABLE_JOB_TYPES = syncJobVocab.SYNC_JOB_TYPES;

/**
 * Lifecycle state of a job row. Re-exported by REFERENCE, not by value — this is literally the same
 * frozen object the schema's `enum` was built from, so a status this module writes cannot fail
 * validation at insert time.
 */
const SYNC_JOB_STATUS = syncJobVocab.SYNC_JOB_STATUS;

/** Who asked for the job. Same object as the schema's enum, for the same reason. */
const SYNC_JOB_TRIGGERED_BY = syncJobVocab.SYNC_JOB_TRIGGERED_BY;

/** Why a job ended up FAILED. */
const SYNC_JOB_FAILURE_REASONS = syncJobVocab.SYNC_JOB_FAILURE_REASONS;

/**
 * Failure reasons after which the job is returned to PENDING for another attempt, up to
 * `config.SYNC.MAX_ATTEMPTS`.
 *
 *  The two reasons that are ABSENT are the whole content of this list:
 *
 *   - `UNKNOWN_JOB_TYPE` will never succeed. Retrying it burns the attempt budget to arrive at the
 *     same answer three times, and buries the one useful signal — that a handler is not registered
 *     — under duplicate failures.
 *   - `STUCK_TIMEOUT` is the SWEEPER's verdict, not a handler's. It means a run was killed
 *     mid-flight and may have written PART of its output. Blindly re-running a partially applied
 *     job is how a double-counted figure is created, and this codebase exists to refuse plausible
 *     wrong numbers. A human decides whether that one is safe to re-run.
 *
 * `readonly string[]` rather than a literal tuple: it is tested against a reason read off a
 * persisted row (`RETRYABLE_FAILURE_REASONS.includes(job.failure_reason)`), and a tuple of literals
 * would reject that call outright.
 */
const RETRYABLE_FAILURE_REASONS: readonly string[] = Object.freeze([
    SYNC_JOB_FAILURE_REASONS.HANDLER_ERROR
]);

/**
 * The `user_id` background work acts as.
 *
 * A stable sentinel rather than a null, so `triggered_by_user_id` on a cron-run job names an actor
 * a reader can interpret. `IdentityObject.user_id` is required precisely so this decision has to be
 * made once, here, instead of every background caller inventing its own empty string.
 */
const SYNC_WORKER_USER_ID = 'SYNC_WORKER';

/** Default sleep for the DUMMY smoke job when the payload names none. */
const DEFAULT_DUMMY_SLEEP_MS = 5000;

/**
 * How often the runner sweeps stuck rows, throttled inside the poll tick rather than given a timer
 * of its own — one loop is one thing to reason about at shutdown.
 *
 * Not configurable, and it does not need to be: the thresholds this cadence ENFORCES
 * (`SYNC_STUCK_RUNNING_MS` / `SYNC_STUCK_PENDING_MS`) are the operator's to set. This only decides
 * how promptly a breach is noticed, and the cost of noticing 15 minutes late is 15 minutes.
 */
const STUCK_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How long `stopJobRunner` waits for an in-flight handler before returning anyway.
 *
 * Bounded on purpose. A process manager will send SIGKILL on its own schedule, so waiting longer
 * than its grace window does not save the job — it only delays the exit and makes shutdown look
 * hung. A handler that outlives this is abandoned mid-run, its row is left RUNNING, and the stuck
 * sweeper is what closes the loop.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10000;

/** Poll granularity of the shutdown drain. */
const SHUTDOWN_DRAIN_POLL_MS = 100;

/**
 * Stored `error_stack` is truncated to this many characters.
 *
 * The stack is the one field on a job row with no natural bound, and the failure path is the worst
 * possible place to hit a document size limit — the record of the failure is exactly what is lost.
 */
const ERROR_STACK_MAX_CHARS = 4096;

export = {
    SYNC_JOB_TYPES,
    STORABLE_JOB_TYPES,
    SYNC_JOB_STATUS,
    SYNC_JOB_TRIGGERED_BY,
    SYNC_JOB_FAILURE_REASONS,
    RETRYABLE_FAILURE_REASONS,
    SYNC_WORKER_USER_ID,
    DEFAULT_DUMMY_SLEEP_MS,
    STUCK_SWEEP_INTERVAL_MS,
    SHUTDOWN_DRAIN_TIMEOUT_MS,
    SHUTDOWN_DRAIN_POLL_MS,
    ERROR_STACK_MAX_CHARS
};
