'use strict';

/**
 * ============================================================================
 *  SYNC-JOB REPOSITORY — the job lifecycle's only door to the database
 * ============================================================================
 *
 *  Nothing outside `modules/sync/repositories/` imports
 *  `shared/repositories/models.repository`, and the ESLint layer guard is scoped
 *  so that only a `repositories/` folder even CAN — a service that reaches a
 *  model is an error at lint time, not a code-review opinion.
 *
 *  Every mongoose call the job LIFECYCLE makes is in this file. Its one sibling
 *  is `syncHealth.repository`, which reads the OTHER EIGHT collections for
 *  `GET /api/sync/health` and touches no job-lifecycle query at all — the split
 *  is by question asked, not by convenience, and neither file duplicates a query
 *  from the other.
 *
 *  ── Why every function takes `now` and its thresholds as ARGUMENTS ──────────
 *  This file reads no config and no clock. A repository that calls `Date.now()`
 *  cannot be tested without controlling the system clock, and one that reads
 *  `config.SYNC.MAX_ATTEMPTS` hides a policy decision inside a query. The
 *  policy lives in the service; the query lives here; the boundary is the
 *  argument list.
 *
 *  ──  THE CLAIM ────────────────────────────────────────────────────────────
 *  `claimPendingJob` is the single most safety-critical query in the
 *  application, and it exists exactly once — here. It is what makes a
 *  poll-based runner safe without a message broker: the filter names the state
 *  the row must be IN, so two runners issuing it concurrently produce one
 *  match and one miss. Read its own comment before changing anything about it.
 * ============================================================================
 */

import models = require('../../shared/repositories/models.repository');
import constants = require('../constants/sync.constants');

import type { SyncJobDoc } from '../../shared/types/entity.types';
import type {
    ConditionalWriteResult,
    NewSyncJobFields,
    RetryJobFields,
    TerminalJobFields
} from '../types/syncJob.types';
import type {
    SyncJobListCounts,
    SyncJobListFacets,
    SyncJobPageQuery
} from '../types/syncJobList.types';

const { SyncJobModel, PartnerAppModel } = models;
const { SYNC_JOB_STATUS, SYNC_JOB_FAILURE_REASONS } = constants;

/**
 * Inserts a new job row.
 *
 * There is no queue to publish to afterwards: this row IS the job, so the insert is the whole
 * enqueue. That is the property that makes the rest of this module simple — there is no second
 * copy of the work that can disagree with the first.
 *
 * @param fields - The document to insert. `partner_app_id` must be ABSENT, not null, when the job is app-less.
 * @returns The inserted document.
 */
const insertSyncJob = async (fields: NewSyncJobFields): Promise<SyncJobDoc> => {
    return SyncJobModel.create(fields);
};

/**
 * Reads one job row.
 *
 * @param job_id - A 24-character hex id. Callers validate the FORM first, so an unparseable id never reaches mongoose here.
 * @returns The document, or null if there is no such row.
 */
const findSyncJobById = async (job_id: string): Promise<SyncJobDoc | null> => {
    return SyncJobModel.findById(job_id).lean<SyncJobDoc | null>();
};

/**
 * Lists the ids of the oldest claimable jobs, oldest first.
 *
 * Ids only, not documents: everything about the row is re-read by the claim, and a document fetched
 * here would be stale by the time the claim ran. Reading the minimum makes it obvious that nothing
 * downstream may trust this snapshot — it is a list of CANDIDATES, and a candidate is not a claim.
 *
 * Oldest first so a backlog drains in order rather than starving its oldest entries. Served by
 * `idx_status_created` — the sort key is the index's trailing field, which can be walked in either
 * direction, so the descending index serves this ascending sort with no in-memory sort.
 *
 * @param limit - Maximum candidates to return. The runner passes its remaining concurrency.
 * @param max_attempts - Attempt ceiling; a row already at or above it is not a candidate.
 * @returns Candidate job ids, oldest first. Possibly empty.
 */
const findClaimableJobIds = async (limit: number, max_attempts: number): Promise<string[]> => {
    const rows = await SyncJobModel.find({
        status: SYNC_JOB_STATUS.PENDING,
        attempts: { $lt: max_attempts }
    })
        .sort({ createdAt: 1 })
        .limit(limit)
        .select({ _id: 1 })
        .lean<Array<{ _id: unknown }>>();

    return rows.map((row) => String(row._id));
};

/**
 *  THE CLAIM. Atomically transitions one PENDING row to RUNNING.
 *
 * This is what replaces the message broker. The durable truth was always the job COLLECTION — the
 * broker only ever carried a pointer to it — so ownership can be settled the same way it always
 * really was: by a conditional write against the row's own state.
 *
 * WHY IT IS SAFE UNDER CONCURRENCY: an update to a single document is atomic in MongoDB, and the
 * filter names `status: 'PENDING'` as a precondition. Two runners issuing this against the same id
 * are serialised by the server; the first flips the row and reports `modifiedCount: 1`, the second
 * finds nothing matching `PENDING` and reports `matchedCount: 0`. There is no window between the
 * check and the write in which both can succeed, because there is no separate check.
 *
 * WHY `$inc` IS LOAD-BEARING BEYOND COUNTING ATTEMPTS: it guarantees the write actually MODIFIES the
 * document on every match. Without it, a hypothetical re-claim that set only values the row already
 * held would report `matchedCount: 1, modifiedCount: 0`, and a caller gating on `modifiedCount === 1`
 * would decline a job it does in fact own. With it, matched and modified cannot diverge.
 *
 * WHY ONLY `PENDING` IS CLAIMABLE — and specifically why a FAILED row is not, unlike the module this
 * was ported from: there, a swept row stayed claimable because its broker message could still be
 * delivered later, and refusing it would have dropped real work. Here there is no message and
 * nothing to arrive late, so the same rule would mean the runner re-executes every failed job on
 * every poll, forever. A dead row is dead; the retry path is explicit (`markJobFailed` returns a
 * retryable failure to PENDING) and bounded by `max_attempts`.
 *
 * @param job_id - The candidate row's id.
 * @param params - Claim parameters.
 * @param params.now - Stamped as `started_at`; the marker that the row is owned.
 * @param params.max_attempts - Re-asserted here, not just in the candidate query: the candidate list is a stale snapshot, so the ceiling has to hold at the moment of the write.
 * @returns `modifiedCount: 1` means the claim was won by THIS call. Anything else means it was not.
 */
const claimPendingJob = async (job_id: string, { now, max_attempts }: { now: Date; max_attempts: number }): Promise<ConditionalWriteResult> => {
    const result = await SyncJobModel.updateOne(
        {
            _id: job_id,
            status: SYNC_JOB_STATUS.PENDING,
            attempts: { $lt: max_attempts }
        },
        {
            $set: {
                status: SYNC_JOB_STATUS.RUNNING,
                started_at: now,
                completed_at: null,
                duration_ms: null,
                // Cleared on claim so a retried job does not display the PREVIOUS attempt's error
                // while it is running. The failed attempt's detail was visible on the PENDING row
                // right up to this moment, which is where an operator reads it.
                error_message: '',
                error_stack: '',
                failure_reason: ''
            },
            $inc: { attempts: 1 }
        }
    );

    return {
        matchedCount: result.matchedCount || 0,
        modifiedCount: result.modifiedCount || 0
    };
};

/**
 * Applies a terminal transition (SUCCESS or FAILED) to a running job.
 *
 * Unconditional by design. The caller has already proven ownership by winning the claim, and a
 * conditional write here could REFUSE to record an outcome — a job that ran, and whose result was
 * then dropped because its row had moved on, is strictly worse than one recorded twice.
 *
 * @param job_id - The row to close.
 * @param fields - The terminal state to write.
 * @returns The updated document.
 */
const closeSyncJob = async (job_id: string, fields: TerminalJobFields): Promise<SyncJobDoc | null> => {
    // ⚠️ Mongoose 9: `returnDocument: 'after'`, never `new: true`. The old spelling still works but
    // emits a deprecation warning on EVERY call, with no dedupe and no way to silence it.
    return SyncJobModel.findByIdAndUpdate(
        job_id,
        { $set: fields },
        { returnDocument: 'after' }
    ).lean<SyncJobDoc | null>();
};

/**
 * Returns a failed-but-retryable job to the claimable pool.
 *
 * `attempts` is deliberately NOT decremented — it counts attempts made, which is what bounds the
 * retry. Resetting it would make the ceiling unreachable and turn a deterministic failure into an
 * infinite loop that also looks, on the sync screen, like a job that keeps starting for no reason.
 *
 * @param job_id - The row to re-queue.
 * @param fields - The PENDING state to write, carrying the last attempt's error.
 * @returns The updated document.
 */
const requeueSyncJob = async (job_id: string, fields: RetryJobFields): Promise<SyncJobDoc | null> => {
    return SyncJobModel.findByIdAndUpdate(
        job_id,
        { $set: fields },
        { returnDocument: 'after' }
    ).lean<SyncJobDoc | null>();
};

/**
 * Cancels a job, but ONLY while it is still PENDING.
 *
 * Conditional, unlike `closeSyncJob`, and for the opposite reason: cancelling a RUNNING job would
 * write a terminal status under a handler that is still executing, so the handler's own result
 * would later overwrite the cancellation and the operator would watch a job they cancelled report
 * success. Refusing is the honest outcome — there is no way to actually stop a handler mid-flight.
 *
 * @param job_id - The row to cancel.
 * @param params - Cancellation parameters.
 * @param params.now - Stamped as `completed_at`.
 * @returns The cancelled document, or null when the row was not PENDING.
 */
const cancelPendingSyncJob = async (job_id: string, { now }: { now: Date }): Promise<SyncJobDoc | null> => {
    return SyncJobModel.findOneAndUpdate(
        { _id: job_id, status: SYNC_JOB_STATUS.PENDING },
        {
            $set: {
                status: SYNC_JOB_STATUS.CANCELLED,
                completed_at: now
            }
        },
        { returnDocument: 'after' }
    ).lean<SyncJobDoc | null>();
};

/**
 * Fails every row that has been in `from_status` since before `cutoff`.
 *
 * One function for both sweeps (RUNNING-too-long and PENDING-too-long) because they differ only in
 * which timestamp they measure — but they diagnose completely different faults, which is why the
 * caller reports their counts separately rather than as one total.
 *
 * @param params - Sweep parameters.
 * @param params.from_status - The status to sweep out of.
 * @param params.timestamp_field - Which date to compare: `started_at` for RUNNING, `createdAt` for PENDING.
 * @param params.cutoff - Rows whose timestamp is strictly older than this are swept.
 * @param params.error_message - Human-readable explanation stored on each swept row. The two sweeps describe different faults, so each supplies its own.
 * @param params.now - Stamped as `completed_at`.
 * @returns How many rows were swept.
 */
const failStaleJobs = async ({ from_status, timestamp_field, cutoff, error_message, now }: {
    from_status: string;
    timestamp_field: string;
    cutoff: Date;
    error_message: string;
    now: Date;
}): Promise<number> => {
    const result = await SyncJobModel.updateMany(
        {
            status: from_status,
            [timestamp_field]: { $lt: cutoff }
        },
        {
            $set: {
                status: SYNC_JOB_STATUS.FAILED,
                completed_at: now,
                failure_reason: SYNC_JOB_FAILURE_REASONS.STUCK_TIMEOUT,
                error_message: error_message
            }
        }
    );

    return result.modifiedCount || 0;
};

/**
 * Reads every COUNT the job-history list publishes, in ONE pass over the collection.
 *
 *  ONE AGGREGATION, FOUR PROJECTIONS, ONE INSTANT. The four numbers this returns are read from the
 * same scan at the same moment, so they cannot disagree with each other. Four separate
 * `countDocuments` calls would be four instants, and a job enqueued between the second and the third
 * makes the tallies stop summing to the ledger size — on screen that is a facet row whose numbers do
 * not add up, which reads as a bug in the arithmetic rather than as a race.
 *
 * ⚠️ THE THREE TALLIES ARE PRE-FILTER AND THE TOTAL IS NOT, and that asymmetry is deliberate rather
 * than an oversight. The tallies label the whole ledger — a post-filter tally would report `0` for
 * every job type the caller did not select, which looks like the history was deleted. `matched`
 * answers the different question of how many rows the current filter selects, and the two are
 * published side by side so a reader can see both.
 *
 * ⚠️ NO `$match` PRECEDES THE `$facet`, so this scans the collection and uses no index. That is not
 * an oversight either: a pre-filter tally has to visit every row BY DEFINITION, so there is no index
 * that could serve it and nothing is being left on the table. The collection grows by a handful of
 * rows per app per day.
 *
 * @param filter - The already-validated mongo filter for the `matched` branch. `{}` is a legal no-op.
 * @returns The filtered total and the three pre-filter tallies. `total` is `0`, never absent, when nothing matched.
 */
const aggregateSyncJobCounts = async (filter: Record<string, unknown>): Promise<SyncJobListCounts> => {
    const rows = await SyncJobModel.aggregate<SyncJobListFacets>([
        {
            $facet: {
                matched: [{ $match: filter }, { $count: 'rows' }],
                by_job_type: [{ $group: { _id: '$job_type', rows: { $sum: 1 } } }],
                by_status: [{ $group: { _id: '$status', rows: { $sum: 1 } } }],
                by_triggered_by: [{ $group: { _id: '$triggered_by', rows: { $sum: 1 } } }]
            }
        }
    ]);

    // ⚠️ `$facet` always yields exactly one document — but an EMPTY COLLECTION yields none at all,
    // and `$count` inside it yields `[]` rather than `0`. Both are normalised here rather than at
    // the call site, because a reader who assumes `facets.matched[0].rows` gets a TypeError on the
    // one input (a fresh install) that is guaranteed to happen at least once.
    const facets = rows[0];
    if (!facets) {
        return { total: 0, by_job_type: [], by_status: [], by_triggered_by: [] };
    }

    const matched = facets.matched || [];
    return {
        total: matched.length > 0 ? (matched[0].rows || 0) : 0,
        by_job_type: facets.by_job_type || [],
        by_status: facets.by_status || [],
        by_triggered_by: facets.by_triggered_by || []
    };
};

/**
 * Reads one page of job rows.
 *
 * Deliberately a plain `find`, not an aggregation: `{ status, createdAt }`, `{ job_type, status,
 * createdAt }` and `{ partner_app_id, createdAt }` all carry `createdAt` as their trailing key, and a
 * trailing key can be walked in either direction — so this sort is an index walk that stops at the
 * page limit rather than a blocking in-memory sort of the whole ledger.
 *
 *  EVERY ARGUMENT IS ALREADY VALIDATED. `sort_field` comes from an allowlist, `limit` has already
 * been clamped and `skip` was computed from an already-clamped page. Nothing here re-decides any of
 * that: a repository that clamped its own page size would be a second place the page size is
 * decided, and the day the two disagree the footer starts reporting a range the table does not show.
 *
 * @param query - The validated filter, sort, skip and limit.
 * @returns The page, possibly empty. Empty is an answer, not an error.
 */
const findSyncJobPage = async ({ filter, sort_field, sort_dir, skip, limit }: SyncJobPageQuery): Promise<SyncJobDoc[]> => {
    return SyncJobModel.find(filter)
        .sort({ [sort_field]: sort_dir })
        .skip(skip)
        .limit(limit)
        .lean<SyncJobDoc[]>();
};

/**
 * Lists the ids of every active partner app, for the cron fan-out.
 *
 * There is normally exactly one — you run this for your own app — but the fan-out is written for N
 * because a partner organisation can publish several, and a loop over one is not more expensive
 * than a special case for one.
 *
 * @returns Active partner app ids. Empty when nothing has been configured yet.
 */
const findActivePartnerAppIds = async (): Promise<string[]> => {
    const rows = await PartnerAppModel.find({ is_active: true })
        .select({ _id: 1 })
        .lean<Array<{ _id: unknown }>>();

    return rows.map((row) => String(row._id));
};

export = {
    insertSyncJob,
    findSyncJobById,
    aggregateSyncJobCounts,
    findSyncJobPage,
    findClaimableJobIds,
    claimPendingJob,
    closeSyncJob,
    requeueSyncJob,
    cancelPendingSyncJob,
    failStaleJobs,
    findActivePartnerAppIds
};
