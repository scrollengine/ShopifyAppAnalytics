'use strict';

/**
 * ============================================================================
 *  JOB RUNNER — polling replaces the message broker
 * ============================================================================
 *
 *   THIS IS SAFE PRECISELY BECAUSE THE DURABLE TRUTH WAS ALWAYS THE JOB
 *  COLLECTION, NEVER THE MESSAGE.
 *
 *  The module this was extracted from ran on Azure Service Bus. It wrote a row
 *  to `gi_sync_job` AND pushed a message naming that row; the message was the
 *  delivery mechanism, but the ROW was what recorded the job's existence, its
 *  state, its attempts and its outcome. Every hard case in that design came
 *  from the two copies disagreeing — a push that failed after the insert
 *  (handled by immediately failing the row), a message redelivered after the
 *  sweeper had already given up on it (handled by making a swept row claimable
 *  again), a worker that died between settling the message and marking the row
 *  RUNNING (handled by a second sweeper for orphaned PENDING rows). All of that
 *  machinery existed to keep a copy in sync with an original.
 *
 *  Deleting the copy deletes the machinery. Nothing is lost, because the broker
 *  never held any state the collection did not already hold — a message was a
 *  pointer, and a pointer to a row you can simply query for is not information.
 *  And the property that made the broker safe under concurrency, exactly-once
 *  ownership, is recovered directly from MongoDB: a single-document update is
 *  atomic, so a conditional update that names the required state settles who
 *  owns a job with no coordination at all.
 *
 *  What a self-hoster gets in exchange is the whole point of the trade: one
 *  process, one database, and no infrastructure to stand up before the first
 *  number appears.
 *
 *  ── The loop ────────────────────────────────────────────────────────────────
 *      every POLL_INTERVAL_MS:
 *        1. sweep stuck rows (throttled to STUCK_SWEEP_INTERVAL_MS)
 *        2. ask for up to (MAX_CONCURRENT_JOBS - in-flight) candidate ids
 *        3. for each: CLAIM it, and run it only if the claim was WON
 *        4. reschedule
 *
 *  `setTimeout` re-armed after each tick, never `setInterval`: an interval fires
 *  on a fixed wall clock regardless of whether the previous tick finished, so a
 *  slow database turns one poll into a pile-up of overlapping polls.
 *
 *  ── Where the claim lives ───────────────────────────────────────────────────
 *  The atomic write is `repositories/syncJob.repository.claimPendingJob`; the
 *  `modifiedCount === 1` gate that interprets it is `syncJob.service`'s
 *  `markJobRunning`. It is NOT re-implemented here, and that is deliberate: a
 *  second spelling of the most safety-critical query in the application is how
 *  the two drift and double-execution becomes possible. This file's job is to
 *  RESPECT the claim — `_runClaimedJob` below proceeds only on
 *  `claim.data.claimed`, and treats a lost claim as an ordinary outcome.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import constants = require('../constants/sync.constants');
import syncJobRepository = require('../repositories/syncJob.repository');
import syncJobService = require('./syncJob.service');
import dummyHandler = require('./dummyHandler.service');
// The listing-analytics module, reached through its BARREL because this is a cross-module consumer.
// Its two sync entry points are the bodies of the two BigQuery job types registered below.
import bigQueryModule = require('../../bigquery');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type {
    RegisterHandlerPayload,
    RunJobPayload,
    RunnerStartPayload,
    RunnerStopPayload,
    SyncJobHandler
} from '../types/jobRunner.types';

const { customConsoleLog, customConsoleError, customConsoleWarn, customConsoleDebug } = logger;
const { promiseReturnResult } = promiseHelper;
const {
    SYNC_JOB_TYPES,
    SYNC_JOB_FAILURE_REASONS,
    SYNC_WORKER_USER_ID,
    STUCK_SWEEP_INTERVAL_MS,
    SHUTDOWN_DRAIN_TIMEOUT_MS,
    SHUTDOWN_DRAIN_POLL_MS
} = constants;
const { markJobRunning, markJobSuccess, markJobFailed, markStuckJobsAsFailed } = syncJobService;

/*
 * ⚠️ The TypeScript return type on the service functions below is the UNPARAMETERISED
 * `ServiceResult`, while each JSDoc `@returns` names the payload interface it carries on success.
 * Same convention as `modules/auth`: a failure envelope carries `data: {}`, which is not assignable
 * to a payload interface, so parameterising would force a cast at every failure branch — and this
 * codebase reserves `as` for `shared/repositories/models.repository` and `as const`. Success
 * payloads are built as TYPED LOCALS, so a missing or misnamed field is still a compile error.
 */


/**
 * The dispatch table: job type -> the service that executes it.
 *
 * Keyed by `string` rather than by the job-type union on purpose. The key is read off a PERSISTED
 * row, which may have been written by a different build of this application, so an unknown value
 * has to stay expressible — that is exactly the `if (!handler)` branch in `_runClaimedJob`.
 *
 * DUMMY is registered here because it belongs to this module and has no dependencies. Everything
 * else registers itself: `registerJobHandler` is the seam that lets the partner-sync module supply
 * its handler without this file importing it, which would otherwise make the runner unloadable
 * until every handler module exists.
 */
/**
 * Adapts the BIGQUERY_SYNC payload to the rollup sync's typed input.
 *
 * The runner hands a handler `{ ...job.payload, sync_job_id }`, which is a bag of unknowns. Naming
 * the three fields the service actually reads is what stops a typo'd payload key from arriving as
 * `undefined` inside the service and being read as "not supplied" — for `mode`, that is the
 * difference between the incremental run the operator asked for and a full lifetime rescan.
 *
 * @param identity - The worker identity.
 * @param params - The job payload plus the job id.
 * @returns The service result the runner branches on.
 */
const _bigQuerySyncJobHandler = (identity: IdentityObject, params: Record<string, any>): Promise<ServiceResult> => {
    return bigQueryModule.runDailySync(identity, {
        partner_app_id: params.partner_app_id,
        mode: params.mode,
        lookback_days: params.lookback_days
    });
};

/**
 * Adapts the INSTALL_ATTRIBUTION_SYNC payload to the attribution sync's typed input.
 *
 * `sync_job_id` is threaded through deliberately: it is stamped onto every attribution row, so a
 * disputed store attribution can be traced back to the exact run that wrote it.
 *
 * @param identity - The worker identity.
 * @param params - The job payload plus the job id.
 * @returns The service result the runner branches on.
 */
const _installAttributionSyncJobHandler = (identity: IdentityObject, params: Record<string, any>): Promise<ServiceResult> => {
    return bigQueryModule.syncInstallAttribution(identity, {
        partner_app_id: params.partner_app_id,
        mode: params.mode,
        lookback_days: params.lookback_days,
        include_collected_source: params.include_collected_source,
        dry_run: params.dry_run,
        sync_job_id: params.sync_job_id
    });
};

/*
 * The dispatch map.
 *
 * DUMMY and the two BigQuery jobs are registered HERE, at module scope, because their bodies live in
 * modules this one can import without a cycle. PARTNER_SYNC is registered from the app entry point
 * instead — see `registerJobHandler`.
 *
 * Either way `assertHandlersRegistered` is the gate that matters: it THROWS at boot if any runnable
 * job type has no handler, which is what stops a type being added to the vocabulary and then failing
 * as UNKNOWN_JOB_TYPE on every cron tick — a failure that looks like a broken sync rather than a
 * missing registration.
 */
const JOB_HANDLERS: Record<string, SyncJobHandler> = {
    [SYNC_JOB_TYPES.DUMMY]: dummyHandler.runDummyJob,
    [SYNC_JOB_TYPES.BIGQUERY_SYNC]: _bigQuerySyncJobHandler,
    [SYNC_JOB_TYPES.INSTALL_ATTRIBUTION_SYNC]: _installAttributionSyncJobHandler
};

/** Timer for the next poll. Module-level so `stopJobRunner` can actually reach and clear it. */
let _pollTimer: NodeJS.Timeout | null = null;

/** True between `startJobRunner` and `stopJobRunner`. Guards against a double start. */
let _started = false;

/** Set by `stopJobRunner`. Every loop checks it, so a shutdown never dispatches new work. */
let _stopping = false;

/** Handlers currently executing. The concurrency budget and the shutdown drain both read it. */
let _inFlight = 0;

/** Epoch ms of the last stuck sweep, so the sweep can be throttled without a second timer. */
let _lastSweepAtMs = 0;

/**
 * The identity background work acts as.
 *
 * A fresh object per call rather than a shared constant: it is passed into handlers written by
 * other modules, and a shared mutable object is an invitation for one of them to write to it.
 *
 * @returns The worker identity.
 */
const _workerIdentity = (): IdentityObject => ({
    user_id: SYNC_WORKER_USER_ID
});

/**
 * Registers the handler for a job type.
 *
 * Called at boot, before `startJobRunner`. The alternative — importing every handler module at the
 * top of this file — makes the runner impossible to load until all of them exist, which in a
 * codebase released in slices means the runner cannot be tested until the last slice lands.
 *
 * Replacing an existing registration is allowed but WARNS. It is legitimate in a test that swaps a
 * handler for a stub; in production it means two modules both claim a job type, and the winner is
 * whichever imported last — a fact worth a log line.
 *
 * @param job_type - One of the runnable `SYNC_JOB_TYPES`.
 * @param handler - `(identity, params) => Promise<ServiceResult>` — the ordinary service signature.
 * @returns Failure when the type is not runnable or the handler is not a function.
 */
const registerJobHandler = (job_type: string, handler: SyncJobHandler): ServiceResult => {
    if (!job_type || !Object.values<string>(SYNC_JOB_TYPES).includes(job_type)) {
        return promiseReturnResult(false, {}, {}, `Cannot register a handler for unknown job_type "${job_type}".`);
    }
    if (typeof handler !== 'function') {
        return promiseReturnResult(false, {}, {}, `Handler for "${job_type}" must be a function.`);
    }

    const replaced = Boolean(JOB_HANDLERS[job_type]);
    if (replaced) {
        customConsoleWarn('WARN: [Sync] Replacing an already-registered job handler', { job_type });
    }
    JOB_HANDLERS[job_type] = handler;

    const registration: RegisterHandlerPayload = {
        job_type: job_type,
        replaced: replaced,
        registered_types: Object.keys(JOB_HANDLERS).sort()
    };
    return promiseReturnResult(true, registration, {}, 'Job handler registered.');
};

/**
 *  Boot guard: THROWS unless every runnable job type has a handler.
 *
 * Call this from the worker entry point, after registration and before `startJobRunner`, and let it
 * propagate to the fatal catch. A missing registration is otherwise invisible until the first cron
 * tick of that type, which then fails as UNKNOWN_JOB_TYPE — nightly, silently, with a cause that
 * reads like a data problem rather than a wiring one. Turning it into a refusal to boot moves the
 * discovery from 3am to `npm start`.
 *
 * @returns The registered job types, sorted, so the caller can log the dispatch table.
 */
const assertHandlersRegistered = (): string[] => {
    const missing = Object.values<string>(SYNC_JOB_TYPES).filter((jobType) => !JOB_HANDLERS[jobType]);
    if (missing.length > 0) {
        throw new Error(`Sync runner has no handler registered for: ${missing.join(', ')}. Register one with registerJobHandler() before starting the runner.`);
    }
    return Object.keys(JOB_HANDLERS).sort();
};

/**
 * Claims one candidate job and, if the claim is won, runs it to a terminal state.
 *
 * ⚠️ Never rejects. It is dispatched without `await` so the poll loop keeps its cadence, and an
 * unhandled rejection from a detached promise takes the process down.
 *
 * @param job_id - A candidate id from the poll. A candidate is not a claim.
 * @returns What happened, for the log. Not a service envelope: nothing outside this file calls it.
 */
const _runClaimedJob = async (job_id: string): Promise<RunJobPayload> => {
    const identity = _workerIdentity();
    const outcome: RunJobPayload = {
        job_id: job_id,
        claimed: false,
        job_type: null,
        succeeded: null
    };

    try {
        const claim = await markJobRunning(identity, { job_id });

        //  THE GATE. `claim.status` only says the claim ATTEMPT completed; `claim.data.claimed`
        // says this process owns the job. Another runner racing us for the same candidate is an
        // ordinary outcome of polling, not an error — so it is logged at debug and dropped.
        if (!claim.status) {
            customConsoleError('ERROR: [Sync] Claim attempt failed', { job_id, msg: claim.msg });
            return outcome;
        }
        if (!claim.data.claimed || !claim.data.job) {
            customConsoleDebug('DEBUG: [Sync] Claim lost; another runner has this job', {
                job_id,
                current_status: claim.data.current_status
            });
            return outcome;
        }

        const job = claim.data.job;
        outcome.claimed = true;
        outcome.job_type = job.job_type;

        const handler = JOB_HANDLERS[job.job_type];
        if (!handler) {
            // Reachable only for a row written by another build, or a registration that was
            // forgotten despite `assertHandlersRegistered`. Failing it here — after the claim — is
            // the honest outcome: leaving it PENDING would have the stuck sweeper eventually close
            // it as STUCK_TIMEOUT, which describes the wrong fault entirely.
            customConsoleError('ERROR: [Sync] No handler for claimed job', { job_id, job_type: job.job_type });
            await markJobFailed(identity, {
                job_id,
                error_message: `No handler is registered for job_type "${job.job_type}".`,
                error_stack: '',
                failure_reason: SYNC_JOB_FAILURE_REASONS.UNKNOWN_JOB_TYPE
            });
            outcome.succeeded = false;
            return outcome;
        }

        customConsoleLog('INFO: [Sync] Dispatching job', { job_id, job_type: job.job_type, attempt: job.attempts });

        let handlerResult: ServiceResult;
        try {
            // `sync_job_id` is threaded in so a handler can stamp provenance on the rows it writes.
            // Without it, a disputed figure cannot be traced back to the run that produced it. Every
            // handler destructures only the keys it names, so the extra one is inert for the rest.
            handlerResult = await handler(identity, { ...(job.payload || {}), sync_job_id: job.job_id });
        } catch (handlerError) {
            // A thrown value is `unknown`, so its `.message` must be PROVEN before it is read. The
            // `in` + `typeof` pair keeps the reach of the original: any object carrying a non-empty
            // string message, not only an `Error` instance.
            let handlerErrorMessage = 'The handler threw an unexpected error.';
            if (handlerError && typeof handlerError === 'object' && 'message' in handlerError
                && typeof handlerError.message === 'string' && handlerError.message) {
                handlerErrorMessage = handlerError.message;
            }
            customConsoleError('ERROR: [Sync] Handler threw', { job_id, job_type: job.job_type, error: handlerError });
            handlerResult = promiseReturnResult(false, {}, handlerError, handlerErrorMessage);
        }

        if (handlerResult && handlerResult.status) {
            await markJobSuccess(identity, { job_id, result_summary: handlerResult.data || {} });
            customConsoleLog('INFO: [Sync] Job SUCCESS', { job_id, job_type: job.job_type });
            outcome.succeeded = true;
            return outcome;
        }

        let errorStack = '';
        if (handlerResult && handlerResult.error && handlerResult.error.stack) {
            errorStack = String(handlerResult.error.stack);
        }
        await markJobFailed(identity, {
            job_id,
            error_message: (handlerResult && handlerResult.msg) || 'The handler returned a failure with no message.',
            error_stack: errorStack,
            failure_reason: SYNC_JOB_FAILURE_REASONS.HANDLER_ERROR
        });
        outcome.succeeded = false;
        return outcome;
    } catch (error) {
        // The runner's own machinery failed — the claim read threw, or a close write did. The row is
        // left as it is and the stuck sweeper is the backstop; there is nothing safe to write here,
        // because we no longer know what state the row is in.
        customConsoleError('ERROR: [Sync] _runClaimedJob threw', { job_id, error });
        return outcome;
    }
};

/**
 * Sweeps stuck rows, but at most once per `STUCK_SWEEP_INTERVAL_MS`.
 *
 * Throttled inside the poll tick rather than given a timer of its own — one loop is one thing to
 * reason about at shutdown, and the sweep is a cheap pair of `updateMany` calls.
 *
 * @param now_ms - The current epoch time, read once by the caller so the whole tick shares one clock reading.
 * @returns Resolves when the sweep has run, or immediately when it was throttled.
 */
const _sweepIfDue = async (now_ms: number): Promise<void> => {
    if (now_ms - _lastSweepAtMs < STUCK_SWEEP_INTERVAL_MS) {
        return;
    }
    _lastSweepAtMs = now_ms;

    const sweep = await markStuckJobsAsFailed(_workerIdentity(), {});
    if (!sweep.status) {
        customConsoleError('ERROR: [Sync] Stuck-job sweep failed', { msg: sweep.msg });
    }
};

/**
 * One poll: sweep if due, claim up to the remaining concurrency, dispatch, reschedule.
 *
 * Dispatched jobs are deliberately NOT awaited. Awaiting them would stall the poll for the length of
 * the longest job, so `MAX_CONCURRENT_JOBS` could never be reached and a slow job would block the
 * stuck sweep. `_inFlight` is what bounds concurrency instead, and it is decremented in a `finally`
 * so a handler that fails in an unexpected way cannot leak the budget and wedge the runner at zero
 * capacity forever.
 *
 * @returns Resolves once this tick's candidates have been dispatched.
 */
const _tick = async (): Promise<void> => {
    try {
        if (_stopping) {
            return;
        }

        const nowMs = Date.now();
        await _sweepIfDue(nowMs);

        if (_stopping) {
            return;
        }

        const capacity = config.SYNC.MAX_CONCURRENT_JOBS - _inFlight;
        if (capacity <= 0) {
            return;
        }

        const candidateIds = await syncJobRepository.findClaimableJobIds(capacity, config.SYNC.MAX_ATTEMPTS);
        if (candidateIds.length === 0) {
            return;
        }

        customConsoleDebug('DEBUG: [Sync] Poll found claimable jobs', { count: candidateIds.length, capacity });

        for (const jobId of candidateIds) {
            if (_stopping) {
                break;
            }
            _inFlight += 1;
            _runClaimedJob(jobId)
                .catch((error) => {
                    // Unreachable: `_runClaimedJob` catches everything. Kept because this promise is
                    // detached, and a detached rejection is a process-level crash rather than a
                    // failed job.
                    customConsoleError('ERROR: [Sync] Detached job promise rejected', { job_id: jobId, error });
                })
                .finally(() => {
                    _inFlight -= 1;
                });
        }
    } catch (error) {
        customConsoleError('ERROR: [Sync] Poll tick threw', error);
    } finally {
        _scheduleNextTick();
    }
};

/**
 * Arms the next poll, unless the runner is shutting down.
 *
 * `unref()` so a running poll timer never by itself keeps the Node process alive — a worker whose
 * server has closed should exit, not hang waiting for a timer that only ever schedules another
 * timer.
 *
 */
const _scheduleNextTick = (): void => {
    if (_stopping || !_started) {
        return;
    }
    _pollTimer = setTimeout(_tick, config.SYNC.POLL_INTERVAL_MS);
    if (_pollTimer && typeof _pollTimer.unref === 'function') {
        _pollTimer.unref();
    }
};

/**
 * Starts the poll loop.
 *
 * Honours `config.SYNC.DISABLED` by starting NOTHING and saying so. That is the documented kill
 * switch: the API stays up and serves whatever is already stored, and nothing is refreshed. Reported
 * as `started: false` rather than as a failure — an operator who set the flag got what they asked
 * for.
 *
 * @returns Failure only when the runner is already started.
 */
const startJobRunner = (): ServiceResult => {
    if (_started) {
        return promiseReturnResult(false, {}, {}, 'The sync job runner is already started.');
    }

    const registeredTypes = Object.keys(JOB_HANDLERS).sort();

    if (config.SYNC.DISABLED) {
        customConsoleWarn('WARN: [Sync] SYNC_DISABLED=true — the job runner will not claim any work. Stored data will be served, and nothing will be refreshed.');
        const disabled: RunnerStartPayload = {
            started: false,
            poll_interval_ms: config.SYNC.POLL_INTERVAL_MS,
            max_concurrent_jobs: config.SYNC.MAX_CONCURRENT_JOBS,
            max_attempts: config.SYNC.MAX_ATTEMPTS,
            registered_types: registeredTypes
        };
        return promiseReturnResult(true, disabled, {}, 'Sync job runner is disabled by configuration.');
    }

    if (config.SYNC.MAX_CONCURRENT_JOBS < 1) {
        // A configured zero survives `config`'s integer parse on purpose, so this is a real setting
        // rather than a parse artefact — but it means "claim nothing", which SYNC_DISABLED already
        // says clearly. Warn rather than fail: the operator gets exactly the behaviour they
        // configured, and a name for it.
        customConsoleWarn('WARN: [Sync] SYNC_MAX_CONCURRENT_JOBS is below 1 — the runner will poll but never claim a job. Use SYNC_DISABLED=true if that is what you meant.', {
            max_concurrent_jobs: config.SYNC.MAX_CONCURRENT_JOBS
        });
    }

    _started = true;
    _stopping = false;
    // Zero rather than "now", so the first tick sweeps immediately. A process that just started is
    // the most likely moment for a previous process to have left rows stranded in RUNNING.
    _lastSweepAtMs = 0;
    _scheduleNextTick();

    customConsoleLog('INFO: [Sync] Job runner started', {
        poll_interval_ms: config.SYNC.POLL_INTERVAL_MS,
        max_concurrent_jobs: config.SYNC.MAX_CONCURRENT_JOBS,
        max_attempts: config.SYNC.MAX_ATTEMPTS,
        registered_types: registeredTypes
    });

    const started: RunnerStartPayload = {
        started: true,
        poll_interval_ms: config.SYNC.POLL_INTERVAL_MS,
        max_concurrent_jobs: config.SYNC.MAX_CONCURRENT_JOBS,
        max_attempts: config.SYNC.MAX_ATTEMPTS,
        registered_types: registeredTypes
    };
    return promiseReturnResult(true, started, {}, 'Sync job runner started.');
};

/**
 * Stops the poll loop and waits, up to `SHUTDOWN_DRAIN_TIMEOUT_MS`, for in-flight handlers.
 *
 * The wait is bounded deliberately. A process manager sends SIGKILL on its own schedule, so waiting
 * longer does not save the job — it only makes shutdown look hung. A handler that outlives the
 * window is abandoned mid-run and its row is left RUNNING; the stuck sweeper is what closes that
 * loop on the next process, which is exactly the fault `STUCK_RUNNING_MS` describes.
 *
 * `drained: false` in the result is therefore a real signal worth logging at the call site: work was
 * interrupted, and some of it may have been half applied.
 *
 * @returns Resolves once the drain finished or timed out.
 */
const stopJobRunner = (): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        _stopping = true;
        _started = false;

        if (_pollTimer) {
            clearTimeout(_pollTimer);
            _pollTimer = null;
        }

        const drainStartedMs = Date.now();
        while (_inFlight > 0 && (Date.now() - drainStartedMs) < SHUTDOWN_DRAIN_TIMEOUT_MS) {
            await new Promise((sleepResolve) => setTimeout(sleepResolve, SHUTDOWN_DRAIN_POLL_MS));
        }

        const waitedMs = Date.now() - drainStartedMs;
        const drained = _inFlight === 0;

        if (!drained) {
            customConsoleWarn('WARN: [Sync] Job runner stopped with work still in flight; those rows stay RUNNING until the stuck sweeper closes them.', {
                in_flight: _inFlight,
                drain_waited_ms: waitedMs
            });
        } else {
            customConsoleLog('INFO: [Sync] Job runner stopped cleanly', { drain_waited_ms: waitedMs });
        }

        const stopped: RunnerStopPayload = {
            drained: drained,
            in_flight_at_exit: _inFlight,
            drain_waited_ms: waitedMs
        };
        return resolve(promiseReturnResult(true, stopped, {}, 'Sync job runner stopped.'));
    });
};

export = {
    registerJobHandler,
    assertHandlersRegistered,
    startJobRunner,
    stopJobRunner
};
