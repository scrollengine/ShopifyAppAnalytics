'use strict';

/**
 * ============================================================================
 *  SYNC — module barrel
 * ============================================================================
 *
 *  The public surface of this module: the job runner, the crons, and the
 *  enqueue/read surface controllers serve.
 *
 *  Barrel rules — deep-path imports inside the folder, every key enumerated,
 *  `export =` never `export default` — are stated once in IMPLEMENTATION.md §3.13
 *  and asserted by test/exportSurface.test.js.
 *
 *  ── What is deliberately NOT here ───────────────────────────────────────────
 *  `markJobRunning`, `markJobSuccess`, `markJobFailed` and the repository. They
 *  are the runner's internals: the CLAIM in particular must have exactly one
 *  caller, because a second one is how a job gets executed twice. Publishing
 *  them would make that mistake reachable from a controller.
 * ============================================================================
 */

import syncConstants = require('./constants/sync.constants');
import jobRunnerService = require('./services/jobRunner.service');
import syncCronSchedulerService = require('./services/syncCronScheduler.service');
import syncHealthService = require('./services/syncHealth.service');
import syncJobListService = require('./services/syncJobList.service');
import syncJobService = require('./services/syncJob.service');

export = {
    /**
     * The job types that actually have a handler. Narrower than what the schema will STORE — a
     * controller should offer exactly these, so the UI cannot enqueue a job nothing can run.
     */
    RUNNABLE_JOB_TYPES: syncConstants.SYNC_JOB_TYPES,
    /** Lifecycle states a job row moves through. */
    SYNC_JOB_STATUS: syncConstants.SYNC_JOB_STATUS,
    /** MANUAL or CRON. */
    SYNC_JOB_TRIGGERED_BY: syncConstants.SYNC_JOB_TRIGGERED_BY,

    /** Creates a PENDING job row. There is no queue — the row IS the job, and the runner will find it. */
    createSyncJob: syncJobService.createSyncJob,
    /** Reads one job row back by id — how a caller watches the sync it just triggered. */
    getSyncJobStatus: syncJobService.getSyncJobStatus,
    /** One page of the job history, with the whole ledger's tallies beside it. Empty is a 200. */
    listSyncJobs: syncJobListService.listSyncJobs,
    /**
     * Cancels a job that has not been claimed yet.
     *
     *  `status: true` does NOT mean it was cancelled — the cancel races the claim and can lose,
     * which is an ordinary outcome rather than an error. Gate on `data.cancelled`.
     */
    cancelSyncJob: syncJobService.cancelSyncJob,
    /**
     * The health snapshot: rows per collection, last run per job type, what is armed, and the
     * coverage gates. Never refuses — a health read that fails when things are unhealthy reports
     * nothing at the moment it matters most.
     */
    getSyncHealth: syncHealthService.getSyncHealth,
    /** Fails rows stuck in RUNNING or PENDING past their configured thresholds. */
    markStuckJobsAsFailed: syncJobService.markStuckJobsAsFailed,

    /** Registers the handler for a job type. Call before `assertHandlersRegistered`. */
    registerJobHandler: jobRunnerService.registerJobHandler,
    /**  Boot guard: THROWS if any runnable job type has no handler. Call it before starting. */
    assertHandlersRegistered: jobRunnerService.assertHandlersRegistered,
    /** Starts the poll loop. Honours `SYNC_DISABLED`. */
    startJobRunner: jobRunnerService.startJobRunner,
    /** Stops the poll loop and drains in-flight handlers, bounded. */
    stopJobRunner: jobRunnerService.stopJobRunner,

    /**  Starts the daily schedule. THROWS at boot on an unsupported `SYNC_DAILY_CRON`. */
    startPartnerSyncCron: syncCronSchedulerService.startPartnerSyncCron,
    /**
     *  Starts the two listing-analytics schedules. THROWS at boot on an unsupported expression.
     *
     * Arms NOTHING when BigQuery is not configured — that is the ordinary state of a deployment
     * that never set the tier up, and a nightly cron firing into a credentials error would be log
     * noise that teaches an operator to ignore the log.
     */
    startBigQuerySyncCrons: syncCronSchedulerService.startBigQuerySyncCrons,
    /** Clears every scheduled timer. */
    stopAllCrons: syncCronSchedulerService.stopAllCrons,
    /** Runs the fan-out by hand — the same path the schedule uses. */
    enqueuePartnerSyncForAllActiveApps: syncCronSchedulerService.enqueuePartnerSyncForAllActiveApps,
    /** The same, for the three daily listing-analytics rollups. */
    enqueueBigQuerySyncForAllActiveApps: syncCronSchedulerService.enqueueBigQuerySyncForAllActiveApps,
    /** The same, for the per-install attribution pull. */
    enqueueInstallAttributionSyncForAllActiveApps: syncCronSchedulerService.enqueueInstallAttributionSyncForAllActiveApps
};
