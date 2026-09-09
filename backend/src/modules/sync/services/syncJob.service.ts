'use strict';

/**
 * ============================================================================
 *  SYNC-JOB SERVICE — every lifecycle transition a job row can make
 * ============================================================================
 *
 *      create ──▶ PENDING ──claim──▶ RUNNING ──▶ SUCCESS
 *                    │                  │
 *                    │                  ├──▶ FAILED
 *                    │                  └──▶ PENDING   (retryable failure, bounded by MAX_ATTEMPTS)
 *                    └──▶ CANCELLED
 *                    └──▶ FAILED        (swept: nothing ever claimed it)
 *
 *  ──  There is no queue, and that is not a downgrade ───────────────────────
 *  The module this was ported from inserted a row AND pushed a message onto
 *  Azure Service Bus, then had to reconcile the two whenever they disagreed —
 *  a push that failed after the insert, a message delivered after the sweeper
 *  had already given up on its row. All of that machinery existed to keep a
 *  copy in sync with the original.
 *
 *  The DURABLE TRUTH WAS ALWAYS THE COLLECTION. The message only ever carried a
 *  pointer to it. So this build keeps the original and drops the copy: `create`
 *  inserts a row and stops, and the runner finds it by polling. One writer, one
 *  reader, one source of truth, and nothing for a self-hoster to install.
 *
 *  ── Ownership ───────────────────────────────────────────────────────────────
 *  `markJobRunning` is THE CLAIM — the only function that may hand a job to a
 *  handler. Its result carries `claimed`, and `status: true` alone does NOT mean
 *  the job is yours; see the type's own comment.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import constants = require('../constants/sync.constants');
import syncJobRowHelper = require('../helpers/syncJobRow.helper');
import syncJobRepository = require('../repositories/syncJob.repository');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type { SyncJobDoc } from '../../shared/types/entity.types';
import type {
    CancelJobPayload,
    ClaimJobPayload,
    CreateSyncJobInput,
    MarkJobFailedInput,
    MarkJobSuccessInput,
    NoDomainParamsInput,
    StuckJobSweepPayload,
    SyncJobIdInput,
    SyncJobPayload
} from '../types/syncJob.types';

/*
 * ⚠️ The TypeScript return type on every service below is the UNPARAMETERISED `ServiceResult`, while
 * each JSDoc `@returns` names the payload interface it carries on success. Deliberate, and the same
 * convention `modules/auth` uses: a failure envelope carries `data: {}`, which is not assignable to
 * a payload interface — so `Promise<ServiceResult<SyncJobPayload>>` would force a
 * `{} as SyncJobPayload` cast at every failure branch, and this codebase reserves `as` for
 * `shared/repositories/models.repository` and `as const`. The shape is still enforced where it
 * matters: each success payload is built as a TYPED LOCAL, so a missing or misnamed field is a
 * compile error at the place it would actually be wrong.
 */

const { customConsoleLog, customConsoleError, customConsoleWarn } = logger;
const { promiseReturnResult } = promiseHelper;
//  THE ONLY definition of what a job row looks like on the wire. `GET /api/sync/jobs` and
// `GET /api/sync/health` call the same function; a private copy here would be the second spelling,
// and two serializers drift silently rather than failing.
const { serializeSyncJob } = syncJobRowHelper;
const {
    SYNC_JOB_TYPES,
    SYNC_JOB_STATUS,
    SYNC_JOB_TRIGGERED_BY,
    SYNC_JOB_FAILURE_REASONS,
    RETRYABLE_FAILURE_REASONS,
    ERROR_STACK_MAX_CHARS
} = constants;

/**
 * What a 24-character hex Mongo id looks like.
 *
 * Deliberately stricter than attempting a cast and catching the failure. `job_id` and
 * `payload.partner_app_id` both reach this service as UNVALIDATED caller input — a controller
 * forwards a path parameter and the whole request-body `payload` object — so genuinely anything can
 * arrive on those keys, and a CastError deep inside mongoose becomes a generic "something went
 * wrong" instead of a message naming the field.
 */
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

/**
 * Tests whether a value is a well-formed Mongo id.
 *
 * @param value - Anything at all; this is a guard over untrusted input.
 * @returns True when the value stringifies to 24 hex characters.
 */
const _isObjectIdLike = (value: unknown): boolean => {
    if (!value) {
        return false;
    }
    return OBJECT_ID_PATTERN.test(String(value));
};

/**
 * Lifts the partner app id out of a job payload so it can be stored on the row's own indexed field.
 *
 * The value is COPIED, never moved: `createSyncJob` still writes `payload` verbatim, because every
 * handler destructures `partner_app_id` out of the payload and that contract must not change.
 *
 * Returns `undefined` — never a raw string, never null — for anything that is not a well-formed id,
 * and both halves of that matter:
 *
 *   - not a raw string, because `partner_app_id` is a real ObjectId path on the schema, so handing
 *     mongoose a malformed value makes the insert reject with a CastError. The enqueue would then
 *     fail with a generic message, where previously the HANDLER produced a precise error about the
 *     app not being found. Dropping the unusable denormalised copy keeps the precise error: the job
 *     is still created, the payload still carries exactly what the caller sent, and only the
 *     (unusable) index key is skipped.
 *   - not null, because `undefined` makes mongoose OMIT the field. An explicit null would store a
 *     second representation of "not app-scoped" and would silently defeat any future partial index,
 *     since `{ $exists: true }` MATCHES an explicit null.
 *
 * @param [payload] - The job payload as supplied by the caller.
 * @returns The id as a string, or undefined when there is not a usable one.
 */
const _resolvePartnerAppId = (payload?: Record<string, any>): string | undefined => {
    const raw = payload && payload.partner_app_id;
    if (!_isObjectIdLike(raw)) {
        return undefined;
    }
    return String(raw);
};

/**
 * Milliseconds a job spent RUNNING, or null when it never started.
 *
 * Null rather than 0: a job the sweeper failed while it was still PENDING has no duration, and a
 * `0` there would read as "ran instantly", which is a claim about the run rather than a statement
 * that there was none. Same rule as the honesty envelope, applied to an operational field.
 *
 * @param job - The job being closed.
 * @param completed_at - The instant it reached a terminal state.
 * @returns Duration in milliseconds, or null.
 */
const _resolveDurationMs = (job: SyncJobDoc, completed_at: Date): number | null => {
    if (!job.started_at) {
        return null;
    }
    return completed_at.getTime() - new Date(job.started_at).getTime();
};

/**
 * Creates a sync job. It is PENDING the moment it is written, and the runner will find it.
 *
 * Validates the job type against the RUNNABLE set rather than the schema's storable enum. That is
 * the difference between refusing an unrunnable request up front, by name, and accepting one that
 * enqueues cleanly, gets claimed, and dies as UNKNOWN_JOB_TYPE — repeatedly, on every cron tick,
 * with a cause nobody recognises.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator, or a worker sentinel for scheduled runs.
 * @param params1 - The parameters object.
 * @param params1.job_type - One of the runnable `SYNC_JOB_TYPES`.
 * @param [params1.payload] - Job-specific input, handed to the handler unchanged.
 * @param [params1.triggered_by] - One of `SYNC_JOB_TRIGGERED_BY`; anything else falls back to MANUAL.
 * @returns Resolves with the created job on success.
 */
const createSyncJob = ({ user_id }: IdentityObject, { job_type, payload, triggered_by }: CreateSyncJobInput): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available, please log in and try again.'));
            }
            if (!job_type) {
                return resolve(promiseReturnResult(false, {}, {}, 'job_type is required.'));
            }

            const runnableTypes = Object.values<string>(SYNC_JOB_TYPES);
            if (!runnableTypes.includes(job_type)) {
                return resolve(promiseReturnResult(false, {}, {}, `No handler ships for job_type "${job_type}". Runnable types: ${runnableTypes.join(', ')}.`));
            }

            let resolvedTriggeredBy: string = SYNC_JOB_TRIGGERED_BY.MANUAL;
            if (triggered_by && Object.values<string>(SYNC_JOB_TRIGGERED_BY).includes(triggered_by)) {
                resolvedTriggeredBy = triggered_by;
            }

            const jobDoc = await syncJobRepository.insertSyncJob({
                job_type: job_type,
                partner_app_id: _resolvePartnerAppId(payload),
                payload: payload || {},
                status: SYNC_JOB_STATUS.PENDING,
                triggered_by: resolvedTriggeredBy,
                triggered_by_user_id: user_id
            });

            const created: SyncJobPayload = { job: serializeSyncJob(jobDoc) };
            customConsoleLog('INFO: [Sync] Job created', {
                job_id: created.job && created.job.job_id,
                job_type: job_type,
                triggered_by: resolvedTriggeredBy
            });

            return resolve(promiseReturnResult(true, created, {}, 'Sync job created.'));
        } catch (error) {
            customConsoleError('ERROR: [Sync] createSyncJob threw', { user_id, job_type, error });
            return resolve(promiseReturnResult(false, {}, error, 'Failed to create the sync job.'));
        }
    });
};

/**
 *  THE CLAIM. Takes ownership of a PENDING job and hands it back to the caller to run.
 *
 * ⚠️ A LOST CLAIM IS NOT A FAILURE. Another runner winning the race, or the row moving out of
 * PENDING between the poll and this call, are both ordinary outcomes of a polling design — so they
 * resolve `status: true` with `claimed: false`. A caller that branches on `status` alone will run a
 * job it does not own, twice, concurrently with whoever does. Gate on `data.claimed`.
 *
 * The atomicity lives in `syncJobRepository.claimPendingJob`; this function is the POLICY around it:
 * it supplies the attempt ceiling, decides what `modifiedCount` means, and reports the row's actual
 * state when the claim was refused so the caller can log a reason rather than a mystery.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The claiming worker.
 * @param params1 - The parameters object.
 * @param params1.job_id - The candidate row's id.
 * @returns Resolves with `claimed` — true only when THIS call took ownership.
 */
const markJobRunning = ({ user_id }: IdentityObject, { job_id }: SyncJobIdInput): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!_isObjectIdLike(job_id)) {
                return resolve(promiseReturnResult(false, {}, {}, 'A valid job_id is required.'));
            }

            const claim = await syncJobRepository.claimPendingJob(String(job_id), {
                now: new Date(),
                max_attempts: config.SYNC.MAX_ATTEMPTS
            });

            //  The gate. Exactly one row transitioned, and this call is the one that transitioned
            // it. `matchedCount` cannot exceed this without the two diverging, because the claim's
            // `$inc` guarantees a modification on every match — so any other result means the row
            // was not claimable and somebody or something else has it.
            if (claim.modifiedCount !== 1) {
                const existing = await syncJobRepository.findSyncJobById(String(job_id));
                if (!existing) {
                    return resolve(promiseReturnResult(false, {}, {}, 'Sync job not found.'));
                }
                const declined: ClaimJobPayload = {
                    claimed: false,
                    job: null,
                    current_status: existing.status
                };
                return resolve(promiseReturnResult(true, declined, {}, `Claim declined; job is ${existing.status}.`));
            }

            const claimedJob = await syncJobRepository.findSyncJobById(String(job_id));
            const won: ClaimJobPayload = {
                claimed: true,
                job: serializeSyncJob(claimedJob),
                current_status: SYNC_JOB_STATUS.RUNNING
            };
            return resolve(promiseReturnResult(true, won, {}, 'Sync job claimed.'));
        } catch (error) {
            customConsoleError('ERROR: [Sync] markJobRunning threw', { job_id, error });
            return resolve(promiseReturnResult(false, {}, error, 'Failed to claim the sync job.'));
        }
    });
};

/**
 * Closes a claimed job as SUCCESS and stores what the handler reports it did.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The worker that ran the job.
 * @param params1 - The parameters object.
 * @param params1.job_id - The job being closed.
 * @param [params1.result_summary] - The handler's own summary, stored verbatim.
 * @returns Resolves with the closed job.
 */
const markJobSuccess = ({ user_id }: IdentityObject, { job_id, result_summary }: MarkJobSuccessInput): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!_isObjectIdLike(job_id)) {
                return resolve(promiseReturnResult(false, {}, {}, 'A valid job_id is required.'));
            }

            const job = await syncJobRepository.findSyncJobById(String(job_id));
            if (!job) {
                return resolve(promiseReturnResult(false, {}, {}, 'Sync job not found.'));
            }

            const completedAt = new Date();
            const updated = await syncJobRepository.closeSyncJob(String(job_id), {
                status: SYNC_JOB_STATUS.SUCCESS,
                completed_at: completedAt,
                duration_ms: _resolveDurationMs(job, completedAt),
                result_summary: result_summary || {}
            });

            const closed: SyncJobPayload = { job: serializeSyncJob(updated) };
            return resolve(promiseReturnResult(true, closed, {}, 'Sync job marked SUCCESS.'));
        } catch (error) {
            customConsoleError('ERROR: [Sync] markJobSuccess threw', { job_id, error });
            return resolve(promiseReturnResult(false, {}, error, 'Failed to mark the sync job SUCCESS.'));
        }
    });
};

/**
 * Records a failed attempt — and decides whether the job gets another one.
 *
 *  THE RETRY DECISION IS KEYED ON `failure_reason`, NOT ON THE ATTEMPT COUNT ALONE, and the
 * reasons that are excluded are the point (see `RETRYABLE_FAILURE_REASONS`): an UNKNOWN_JOB_TYPE
 * will never succeed no matter how often it runs, and a STUCK_TIMEOUT may have written PART of its
 * output, so re-running it is how a figure gets double-counted.
 *
 * A retryable failure with attempts left returns the row to PENDING, carrying its error text so the
 * sync screen can say WHY it is waiting to run again. `attempts` is never decremented — it is the
 * bound.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The worker that ran the job.
 * @param params1 - The parameters object.
 * @param params1.job_id - The job that failed.
 * @param [params1.error_message] - What went wrong, in an operator's language.
 * @param [params1.error_stack] - Truncated to `ERROR_STACK_MAX_CHARS` before storage.
 * @param [params1.failure_reason] - One of `SYNC_JOB_FAILURE_REASONS`; defaults to HANDLER_ERROR.
 * @returns Resolves with the job in its new state — FAILED, or PENDING if it will be retried.
 */
const markJobFailed = ({ user_id }: IdentityObject, { job_id, error_message, error_stack, failure_reason }: MarkJobFailedInput): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!_isObjectIdLike(job_id)) {
                return resolve(promiseReturnResult(false, {}, {}, 'A valid job_id is required.'));
            }

            const job = await syncJobRepository.findSyncJobById(String(job_id));
            if (!job) {
                return resolve(promiseReturnResult(false, {}, {}, 'Sync job not found.'));
            }

            const completedAt = new Date();
            const durationMs = _resolveDurationMs(job, completedAt);
            const resolvedReason = failure_reason || SYNC_JOB_FAILURE_REASONS.HANDLER_ERROR;
            const resolvedMessage = error_message || 'The handler reported a failure with no message.';
            const resolvedStack = (error_stack || '').slice(0, ERROR_STACK_MAX_CHARS);
            const attemptsMade = job.attempts ?? 0;

            let willRetry = false;
            if (RETRYABLE_FAILURE_REASONS.includes(resolvedReason) && attemptsMade < config.SYNC.MAX_ATTEMPTS) {
                willRetry = true;
            }

            if (willRetry) {
                const requeued = await syncJobRepository.requeueSyncJob(String(job_id), {
                    status: SYNC_JOB_STATUS.PENDING,
                    started_at: null,
                    completed_at: null,
                    duration_ms: durationMs,
                    error_message: resolvedMessage,
                    error_stack: resolvedStack,
                    failure_reason: resolvedReason
                });
                customConsoleWarn('WARN: [Sync] Job failed and will be retried', {
                    job_id: String(job_id),
                    job_type: job.job_type,
                    attempts_made: attemptsMade,
                    max_attempts: config.SYNC.MAX_ATTEMPTS,
                    error_message: resolvedMessage
                });
                const retrying: SyncJobPayload = { job: serializeSyncJob(requeued) };
                return resolve(promiseReturnResult(true, retrying, {}, `Sync job failed; queued for attempt ${attemptsMade + 1} of ${config.SYNC.MAX_ATTEMPTS}.`));
            }

            const updated = await syncJobRepository.closeSyncJob(String(job_id), {
                status: SYNC_JOB_STATUS.FAILED,
                completed_at: completedAt,
                duration_ms: durationMs,
                error_message: resolvedMessage,
                error_stack: resolvedStack,
                failure_reason: resolvedReason
            });

            customConsoleError('ERROR: [Sync] Job FAILED', {
                job_id: String(job_id),
                job_type: job.job_type,
                failure_reason: resolvedReason,
                attempts_made: attemptsMade,
                error_message: resolvedMessage
            });

            const failed: SyncJobPayload = { job: serializeSyncJob(updated) };
            return resolve(promiseReturnResult(true, failed, {}, 'Sync job marked FAILED.'));
        } catch (error) {
            customConsoleError('ERROR: [Sync] markJobFailed threw', { job_id, error });
            return resolve(promiseReturnResult(false, {}, error, 'Failed to mark the sync job FAILED.'));
        }
    });
};

/**
 * Cancels a job that has not been claimed yet.
 *
 *  ONLY A `PENDING` JOB IS CANCELLABLE, AND THAT IS THE HONEST ANSWER RATHER THAN A LIMITATION.
 *
 * Nothing in this build can interrupt a handler mid-flight — the runner `await`s a handler it has
 * already dispatched, and there is no cancellation token to hand it. So writing `CANCELLED` over a
 * RUNNING row would be a status the system cannot keep: the handler goes on doing exactly what it
 * was doing, finishes, and `closeSyncJob` (deliberately UNCONDITIONAL, because an outcome that was
 * recorded and then dropped is worse than one recorded twice) overwrites the cancellation with
 * SUCCESS. An operator would watch a job they cancelled report that it completed, and — far worse on
 * a sync that WRITES — would believe nothing had been written when in fact everything had.
 *
 *  THE CANCEL AND THE CLAIM ARE THE SAME RACE, SETTLED THE SAME WAY, IN ONE PLACE.
 * `syncJobRepository.cancelPendingSyncJob` is a single conditional `findOneAndUpdate` whose filter
 * names `status: PENDING`; the runner's `claimPendingJob` is a single conditional `updateOne` whose
 * filter names the same precondition. Two writers hitting one document are serialised by the server,
 * so exactly one of them matches: either the cancel got there first and the runner finds nothing to
 * claim, or the runner got there first and the cancel matches nothing. There is no window in which
 * both succeed, because neither reads before it writes.
 *
 * ⚠️ SO A LOST CANCEL IS NOT A FAILURE — it is the race resolving the other way, which is an ordinary
 * outcome. It resolves `status: true` with `cancelled: false` and the row's actual state, exactly as
 * `markJobRunning` reports a declined claim.  A CALLER THAT BRANCHES ON `status` ALONE WILL REPORT
 * A CANCELLATION THAT DID NOT HAPPEN. Gate on `data.cancelled`; the controller does.
 *
 * The re-read below is DIAGNOSIS, never a second attempt. It runs after the conditional write has
 * already lost, and it exists so the refusal can name what the row actually is instead of offering
 * the caller a sentence that could mean three different things. It is a LATER instant than the
 * write, so the status it reports may have moved on again (a job that was RUNNING when the cancel
 * lost can be SUCCESS by the time it is read) — that is still the truth about the row, and the one
 * fact that cannot change is that this call did not cancel anything.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The operator cancelling the job.
 * @param params1 - The parameters object.
 * @param params1.job_id - The job to cancel.
 * @returns Resolves with `cancelled` — true only when THIS
 * call moved the row to CANCELLED. `status: false` is reserved for a call that could not happen at
 * all: no identity, a malformed id, no such row, or a thrown query.
 */
const cancelSyncJob = ({ user_id }: IdentityObject, { job_id }: SyncJobIdInput): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available, please log in and try again.'));
            }
            if (!_isObjectIdLike(job_id)) {
                return resolve(promiseReturnResult(false, {}, {}, 'A valid job_id is required.'));
            }

            //  THE ONE WRITE. Conditional on `status: PENDING`, issued exactly once, and never
            // retried — a retry loop here is how a cancel eventually wins a race it already lost.
            const cancelled = await syncJobRepository.cancelPendingSyncJob(String(job_id), { now: new Date() });

            if (cancelled) {
                customConsoleLog('INFO: [Sync] Job cancelled', { job_id: String(job_id), user_id });
                const won: CancelJobPayload = {
                    cancelled: true,
                    job: serializeSyncJob(cancelled),
                    current_status: SYNC_JOB_STATUS.CANCELLED,
                    reason: ''
                };
                return resolve(promiseReturnResult(true, won, {}, 'Sync job cancelled.'));
            }

            // The write matched nothing. Read the row to say WHY, and report `cancelled: false`.
            const existing = await syncJobRepository.findSyncJobById(String(job_id));
            if (!existing) {
                return resolve(promiseReturnResult(false, {}, {}, 'Sync job not found.'));
            }

            let reason = `This job already finished as ${existing.status}, so there is nothing left to cancel.`;
            if (existing.status === SYNC_JOB_STATUS.RUNNING) {
                reason = 'The runner claimed this job before the cancellation reached it, so it is already RUNNING and was NOT cancelled. '
                    + 'A handler cannot be interrupted once it has started — marking the row CANCELLED would be overwritten by the '
                    + 'handler\'s own result moments later, and the work would have happened anyway. Wait for it to finish; if the process '
                    + 'holding it has died, the stuck-job sweep fails it once it has been RUNNING longer than SYNC_STUCK_RUNNING_MS.';
            }

            customConsoleWarn('WARN: [Sync] Cancellation declined', {
                job_id: String(job_id),
                user_id: user_id,
                current_status: existing.status
            });

            const lost: CancelJobPayload = {
                cancelled: false,
                job: serializeSyncJob(existing),
                current_status: existing.status,
                reason: reason
            };
            return resolve(promiseReturnResult(true, lost, {}, `Cancellation declined; the job is ${existing.status}.`));
        } catch (error) {
            customConsoleError('ERROR: [Sync] cancelSyncJob threw', { job_id, error });
            return resolve(promiseReturnResult(false, {}, error, 'Failed to cancel the sync job.'));
        }
    });
};

/**
 * Sweeps rows that have been stuck too long, in either of the two ways a job can be stuck.
 *
 * The two counts are reported separately because they diagnose different faults and an operator
 * should act differently on each:
 *
 *   - `swept_running` — a handler was claimed and then the process died. Work may be half done.
 *   - `swept_pending` — nothing CLAIMED the row at all, for an hour. That means no runner is alive,
 *     and it is the failure this sweep exists to surface: the dashboard does not break when syncing
 *     stops, it just quietly stops moving, which is the hardest kind of outage to notice.
 *
 * Both are recorded as STUCK_TIMEOUT, which is deliberately NOT retryable — see `markJobFailed`.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The worker running the sweep.
 * @param params1 - No domain parameters; the argument is still required for signature consistency.
 * @returns Resolves with how many rows were swept, by kind.
 */
const markStuckJobsAsFailed = ({ user_id }: IdentityObject, {}: NoDomainParamsInput): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }

            const now = new Date();
            const runningCutoff = new Date(now.getTime() - config.SYNC.STUCK_RUNNING_MS);
            const pendingCutoff = new Date(now.getTime() - config.SYNC.STUCK_PENDING_MS);
            const runningSeconds = Math.round(config.SYNC.STUCK_RUNNING_MS / 1000);
            const pendingSeconds = Math.round(config.SYNC.STUCK_PENDING_MS / 1000);

            const [sweptRunning, sweptPending] = await Promise.all([
                syncJobRepository.failStaleJobs({
                    from_status: SYNC_JOB_STATUS.RUNNING,
                    timestamp_field: 'started_at',
                    cutoff: runningCutoff,
                    error_message: `Job was RUNNING for more than ${runningSeconds}s; the process that claimed it is presumed dead. Part of its output may have been written.`,
                    now: now
                }),
                syncJobRepository.failStaleJobs({
                    from_status: SYNC_JOB_STATUS.PENDING,
                    timestamp_field: 'createdAt',
                    cutoff: pendingCutoff,
                    error_message: `Job sat PENDING for more than ${pendingSeconds}s and was never claimed — check that the sync runner is alive and that SYNC_DISABLED is not set.`,
                    now: now
                })
            ]);

            const total = sweptRunning + sweptPending;
            if (total > 0) {
                customConsoleWarn('WARN: [Sync] Stuck-job sweep failed rows', {
                    swept_running: sweptRunning,
                    swept_pending: sweptPending
                });
            }

            const sweep: StuckJobSweepPayload = {
                swept_count: total,
                swept_running: sweptRunning,
                swept_pending: sweptPending
            };
            return resolve(promiseReturnResult(true, sweep, {}, 'Stuck-job sweep completed.'));
        } catch (error) {
            customConsoleError('ERROR: [Sync] markStuckJobsAsFailed threw', error);
            return resolve(promiseReturnResult(false, {}, error, 'Stuck-job sweep failed.'));
        }
    });
};

/**
 * Reads one job row back, so a caller that triggered a sync can watch it finish.
 *
 * This is the ONLY read on the sync module's public surface. It exists because triggering a sync
 * returns immediately — `createSyncJob` writes a PENDING row and the runner picks it up on its next
 * poll — so without a way to read the row back, "did my sync work?" would be answerable only from
 * the server logs.
 *
 * It reports the row exactly as stored and interprets nothing. In particular a job that FAILED and
 * was requeued is PENDING again with `attempts` incremented and the PREVIOUS attempt's
 * `error_message` still attached — that pairing is deliberate (it is how a caller sees a retry in
 * progress rather than a silent stall), and flattening it here would hide the retry.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The operator or worker asking.
 * @param params1 - The parameters object.
 * @param params1.job_id - The job row's id, as returned by `createSyncJob`.
 * @returns Resolves with the serialized job, or a failure
 * result if the id is malformed or names no row. Never rejects.
 */
const getSyncJobStatus = ({ user_id }: IdentityObject, { job_id }: SyncJobIdInput): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available, please log in and try again.'));
            }
            if (!_isObjectIdLike(job_id)) {
                return resolve(promiseReturnResult(false, {}, {}, 'A valid job_id is required.'));
            }

            const job = await syncJobRepository.findSyncJobById(String(job_id));
            if (!job) {
                return resolve(promiseReturnResult(false, {}, {}, 'Sync job not found.'));
            }

            const found: SyncJobPayload = { job: serializeSyncJob(job) };
            return resolve(promiseReturnResult(true, found, {}, 'Sync job fetched.'));
        } catch (error) {
            customConsoleError('ERROR: [Sync] getSyncJobStatus threw', { job_id, error });
            return resolve(promiseReturnResult(false, {}, error, 'Failed to read the sync job.'));
        }
    });
};

export = {
    createSyncJob,
    getSyncJobStatus,
    markJobRunning,
    markJobSuccess,
    markJobFailed,
    cancelSyncJob,
    markStuckJobsAsFailed
};
