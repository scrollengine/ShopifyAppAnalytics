'use strict';

/**
 * ============================================================================
 *  SYNC CONTROLLER — trigger a Partner API pull, then watch it
 * ============================================================================
 *
 *  Syncing is asynchronous and there is no queue broker: `createSyncJob` writes
 *  a PENDING row and the job runner (a poll loop in this same process) claims
 *  it on its next tick. So the trigger endpoint returns a job_id immediately
 *  and the status endpoint is how a caller finds out what happened.
 *
 *   A 200 from the trigger endpoint means the job was ENQUEUED, not that it
 *  ran. Anything reading these endpoints — the dashboard, a deploy script —
 *  must poll the status endpoint before claiming a sync succeeded. The
 *  alternative failure mode is the quiet one this project exists to avoid:
 *  numbers that stop moving while everything still looks healthy.
 *
 *  ──  ONE HANDLER HERE DOES NOT MEAN WHAT ITS 200 LOOKS LIKE ───────────────
 *  `_syncCancelJob` is the exception to "status: true means it happened". The
 *  cancel is a conditional write racing the runner's claim, so losing that race
 *  is an ordinary outcome rather than an error, and the service reports it as
 *  `status: true` with `cancelled: false`. THE CONTROLLER IS WHAT TURNS THAT
 *  BACK INTO A REFUSAL ON THE WIRE — it gates on `data.cancelled` and answers
 *  4xx, so no caller can read a lost cancel as a successful one.
 * ============================================================================
 */

import type { Request, Response } from 'express';
import apiResponse = require('../utils/apiResponse');
import logger = require('../core/logger');
import syncModule = require('../modules/sync');
// Reached directly, and ONLY for the dry-run estimate — see `_syncTriggerInstallAttributionSync`.
// Every other trigger on this route goes through the job system.
import bigQueryModule = require('../modules/bigquery');

const { customConsoleError } = logger;
const {
    createSyncJob,
    getSyncJobStatus,
    listSyncJobs,
    cancelSyncJob,
    getSyncHealth,
    RUNNABLE_JOB_TYPES,
    SYNC_JOB_TRIGGERED_BY
} = syncModule;
const { syncInstallAttribution } = bigQueryModule;

/**
 * Enqueues a Partner API sync for one app and returns the job row immediately.
 *
 * `mode` and `lookback_days` are passed through to the sync service untouched — it owns their
 * vocabulary and their defaults, and validating them twice would let the two copies drift. What
 * this handler does insist on is `partner_app_id`, because it is the field the job row is INDEXED
 * by: without it the job is created but unattributed, and the runner would sync nothing while
 * reporting success.
 *
 * @param req - Express request. Body: `{ partner_app_id, mode?, lookback_days? }`.
 * @param res - Express response.
 * @returns 200 with `{ job }` — the PENDING row, whose `job_id` is what the
 * status endpoint takes. Never the sync's result; the sync has not started yet.
 */
const _syncTriggerPartnerSync = async (req: Request, res: Response) => {
    try {
        const b = (req.body || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = b.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        // Only these three keys are forwarded. Spreading the body into the payload would let a
        // caller write arbitrary fields onto a stored job document.
        const payload: Record<string, any> = { partner_app_id: String(partnerAppId) };
        if (b.mode) {
            payload.mode = String(b.mode);
        }
        if (b.lookback_days !== undefined && b.lookback_days !== null && b.lookback_days !== '') {
            payload.lookback_days = Number(b.lookback_days);
        }

        const serviceResponse = await createSyncJob(identityObj, {
            job_type: RUNNABLE_JOB_TYPES.PARTNER_SYNC,
            payload: payload,
            triggered_by: SYNC_JOB_TRIGGERED_BY.MANUAL
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Sync syncController _syncTriggerPartnerSync', error);
        return apiResponse.errorResponse(res, 'Could not queue the sync. Please try again.');
    }
};

/**
 * Reads one sync job back by id.
 *
 * The row is reported as stored, uninterpreted. Two shapes are worth knowing when reading it:
 *
 *   - `status: 'PENDING'` with `attempts > 0` and an `error_message` set is a job that FAILED and
 *     is being RETRIED — not a fresh job with a stale error. The pairing is how a retry is visible.
 *   - `status: 'FAILED'` with `failure_reason: 'STUCK_TIMEOUT'` means nothing ever claimed the row,
 *     or the process that claimed it died. Check that the runner is alive and `SYNC_DISABLED` is
 *     unset; part of the job's output may have been written.
 *
 * @param req - Express request. Route param: `job_id`.
 * @param res - Express response.
 * @returns 200 with `{ job }`, or 404 when the id names no row.
 */
const _syncJobStatus = async (req: Request, res: Response) => {
    try {
        const p = (req.params || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        const jobId = p.job_id;
        if (!jobId) {
            return apiResponse.validationErrorResponse(res, 'job_id is required.');
        }

        const serviceResponse = await getSyncJobStatus(identityObj, { job_id: String(jobId) });
        if (!serviceResponse.status) {
            return apiResponse.notFoundResponse(res, serviceResponse.msg);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Sync syncController _syncJobStatus', error);
        return apiResponse.errorResponse(res, 'Could not read the sync job. Please try again.');
    }
};

/**
 * Queues a BigQuery listing-analytics sync (the three daily rollups).
 *
 * Thin, like every handler here: it validates the shape of the request and hands off. The question
 * of whether BigQuery is CONFIGURED is not asked here — that lives in the service, which is also
 * what the cron path and the job runner reach, so the answer cannot differ depending on how the sync
 * was triggered. A duplicate check here would be a second place for that answer to drift.
 *
 * The service's message is surfaced UNCHANGED. It names the environment variables to set, and
 * rewriting it into something friendlier here would strip exactly the detail an operator needs.
 *
 *  A 200 means QUEUED, not SYNCED. Poll GET /api/sync/jobs/:job_id for the outcome.
 *
 * @param req
 * @param res
 * @returns
 */
const _syncTriggerBigQuerySync = async (req: Request, res: Response) => {
    try {
        const b = (req.body || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = b.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const payload: Record<string, any> = { partner_app_id: String(partnerAppId) };
        if (b.mode) {
            payload.mode = String(b.mode);
        }
        if (b.lookback_days !== undefined && b.lookback_days !== null && b.lookback_days !== '') {
            payload.lookback_days = Number(b.lookback_days);
        }

        const serviceResponse = await createSyncJob(identityObj, {
            job_type: RUNNABLE_JOB_TYPES.BIGQUERY_SYNC,
            payload: payload,
            triggered_by: SYNC_JOB_TRIGGERED_BY.MANUAL
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Sync syncController _syncTriggerBigQuerySync', error);
        return apiResponse.errorResponse(res, 'Could not queue the BigQuery sync. Please try again.');
    }
};

/**
 * Queues a per-install attribution sync, or PRICES it when `dry_run` is set.
 *
 *  The dry run runs INLINE and does not create a job, which is the one deliberate asymmetry in
 * this file. A dry run exists to answer "what would this cost" BEFORE the money is spent, and a
 * queued fire-and-forget job could never hand the estimate back to the caller who asked. It is
 * billed at zero and writes nothing, so there is nothing to audit a job row for.
 *
 * That makes the response shape depend on `dry_run`: an estimate (`gib_scanned`, `exceeds_cap`)
 * rather than `{ job }`. Callers must branch on what they asked for.
 *
 * @param req
 * @param res
 * @returns
 */
const _syncTriggerInstallAttributionSync = async (req: Request, res: Response) => {
    try {
        const b = (req.body || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = b.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        // Compared against the string too: this arrives from a query string or a JSON body depending
        // on the caller, and `Boolean('false')` is true — which would silently spend a lifetime scan
        // for someone who explicitly asked only to price it.
        const isDryRun = b.dry_run === true || b.dry_run === 'true';

        const payload: Record<string, any> = { partner_app_id: String(partnerAppId) };
        if (b.mode) {
            payload.mode = String(b.mode);
        }
        if (b.lookback_days !== undefined && b.lookback_days !== null && b.lookback_days !== '') {
            payload.lookback_days = Number(b.lookback_days);
        }
        if (b.include_collected_source === false || b.include_collected_source === 'false') {
            payload.include_collected_source = false;
        }

        if (isDryRun) {
            const estimate = await syncInstallAttribution(identityObj, { ...payload, dry_run: true });
            if (!estimate.status) {
                return apiResponse.errorResponseWithErrorObject(res, estimate.msg, estimate.error);
            }
            return apiResponse.successResponseWithData(res, estimate.msg, estimate.data);
        }

        const serviceResponse = await createSyncJob(identityObj, {
            job_type: RUNNABLE_JOB_TYPES.INSTALL_ATTRIBUTION_SYNC,
            payload: payload,
            triggered_by: SYNC_JOB_TRIGGERED_BY.MANUAL
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Sync syncController _syncTriggerInstallAttributionSync', error);
        return apiResponse.errorResponse(res, 'Could not queue the install-attribution sync. Please try again.');
    }
};

/**
 * Queues the DUMMY smoke job — the one trigger that touches no data source at all.
 *
 *  IT EXISTS BECAUSE "MY SYNC PRODUCED NOTHING" HAS TWO CAUSES WITH DIFFERENT FIXES: the runner is
 * not working, or the Partner API returned nothing. Without a credential-free job an operator cannot
 * tell them apart, and answering the first question takes an afternoon instead of ten seconds. The
 * handler shipped from day one; until this route existed nothing could reach it over HTTP, so the
 * dashboard's "Infrastructure test" card had a button that could only report "not implemented".
 *
 * App-less on purpose: it takes no `partner_app_id`, which is what makes it runnable on an install
 * that has not registered an app yet — exactly the install most likely to need it.
 *
 * @param req - Express request. Body: `{ sleep_ms? }`.
 * @param res - Express response.
 * @returns 200 with `{ job }` — QUEUED, not finished. Poll the status route.
 */
const _syncTriggerDummySync = async (req: Request, res: Response) => {
    try {
        const b = (req.body || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        // Only this one key is forwarded. Spreading the body would let a caller write arbitrary
        // fields onto a stored job document, the same rule the three real triggers follow.
        const payload: Record<string, any> = {};
        if (b.sleep_ms !== undefined && b.sleep_ms !== null && b.sleep_ms !== '') {
            payload.sleep_ms = Number(b.sleep_ms);
        }

        const serviceResponse = await createSyncJob(identityObj, {
            job_type: RUNNABLE_JOB_TYPES.DUMMY,
            payload: payload,
            triggered_by: SYNC_JOB_TRIGGERED_BY.MANUAL
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Sync syncController _syncTriggerDummySync', error);
        return apiResponse.errorResponse(res, 'Could not queue the smoke-test job. Please try again.');
    }
};

/**
 * Lists sync jobs — the history table.
 *
 * Shape validation only: every value is forwarded raw, because the SERVICE owns the vocabulary, the
 * page bounds and the fail-open rules. Validating here as well would be a second copy of those
 * rules, and the two would eventually disagree about which filter values exist.
 *
 *  AN EMPTY LIST IS A 200. "Nothing has ever run here", "nothing matches this filter" and "syncing
 * is switched off" are all real answers, separated on the payload by `ledger_state`,
 * `pagination.total`, `sync_disabled` and `warnings[]` — never by a refusal, which the table would
 * render as an error over a perfectly healthy deployment.
 *
 * @param req - Express request. Query: `{ page?, limit?, job_type?, status?, triggered_by?, sort?, dir? }`.
 * @param res - Express response.
 * @returns 200 with `{ items, pagination, … }`.
 */
const _syncListJobs = async (req: Request, res: Response) => {
    try {
        const q = (req.query || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        const serviceResponse = await listSyncJobs(identityObj, {
            page: q.page,
            limit: q.limit,
            job_type: q.job_type,
            status: q.status,
            triggered_by: q.triggered_by,
            sort: q.sort,
            dir: q.dir
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Sync syncController _syncListJobs', error);
        return apiResponse.errorResponse(res, 'Could not read the sync job history. Please try again.');
    }
};

/**
 * Cancels a PENDING sync job.
 *
 *  ONLY A PENDING JOB CAN BE CANCELLED, and this endpoint refuses rather than pretending. Nothing
 * in this build can interrupt a handler mid-flight, so marking a RUNNING row CANCELLED would be a
 * status the system cannot keep — the handler finishes and its own result overwrites the
 * cancellation, leaving an operator who believes nothing ran looking at a job that reports SUCCESS.
 * On a sync that WRITES, that belief is the dangerous half.
 *
 *  THE THREE OUTCOMES MAP TO THREE DIFFERENT CODES, AND NONE OF THEM IS DECIDED BY READING THE
 * SERVICE'S MESSAGE TEXT. The service reports a lost race STRUCTURALLY (`data.cancelled`), so this
 * handler branches on a boolean rather than pattern-matching a sentence that someone will reword.
 *
 *   200 — `cancelled: true`. The row moved PENDING -> CANCELLED, and this call is what moved it.
 *   400 — `cancelled: false`. The row exists and is RUNNING or already terminal. `data.reason` says
 *         which and what to do about it.
 *   404 — no such job.
 *
 * ⚠️ 400 rather than 409, which is the code this outcome actually deserves: `utils/apiResponse`
 * publishes no 409 helper, and that file is a shared surface rather than this route's to widen. 400
 * is the closest thing it does publish that says "refused, we did not break, here is a sentence" —
 * and, unlike a 500, it is a status the dashboard's axios layer passes through with its body intact,
 * so the operator actually reads the explanation instead of a blank failure.
 *
 * @param req - Express request. Route param: `job_id`.
 * @param res - Express response.
 * @returns 200 with `{ cancelled: true, job, … }`, 400 when the job cannot be
 * cancelled, or 404 when the id names no row.
 */
const _syncCancelJob = async (req: Request, res: Response) => {
    try {
        const p = (req.params || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        const jobId = p.job_id;
        if (!jobId) {
            return apiResponse.validationErrorResponse(res, 'job_id is required.');
        }

        const serviceResponse = await cancelSyncJob(identityObj, { job_id: String(jobId) });
        if (!serviceResponse.status) {
            // The service reserves `status: false` for a call that could not happen at all — a
            // malformed id, or no such row. Both are "there is no such job" to a caller.
            return apiResponse.notFoundResponse(res, serviceResponse.msg);
        }

        //  THE GATE. `status: true` alone would report a cancellation that did not happen; the
        // runner claiming the job first is an ordinary outcome, not an error, and it arrives here as
        // a successful envelope carrying `cancelled: false`.
        const payload = serviceResponse.data as { cancelled?: boolean; reason?: string };
        if (!payload.cancelled) {
            return apiResponse.validationErrorResponse(res, payload.reason || serviceResponse.msg);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Sync syncController _syncCancelJob', error);
        return apiResponse.errorResponse(res, 'Could not cancel the sync job. Please try again.');
    }
};

/**
 * The sync health snapshot: what is in the database, what last ran, what is armed, and how far the
 * data reaches.
 *
 *  ALWAYS A 200 WHEN THE READ ITSELF WORKED, however bad the news is. Every empty collection and
 * every job type that has never run is reported WITH THE REASON it is empty — a health endpoint that
 * refuses when things are unhealthy reports nothing at the exact moment somebody needs it.
 *
 * ⚠️ Distinct from `GET /healthz`, which is unauthenticated and deliberately says nothing that
 * identifies the business. This one is behind the guard and says a great deal: collection names, row
 * counts, app handles and coverage gates.
 *
 * @param _req - Express request. Takes no parameters: it describes the whole deployment.
 * @param res - Express response.
 * @returns 200 with the snapshot.
 */
const _syncHealth = async (_req: Request, res: Response) => {
    try {
        const identityObj = { user_id: _req.user_id as string };

        const serviceResponse = await getSyncHealth(identityObj, {});
        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Sync syncController _syncHealth', error);
        return apiResponse.errorResponse(res, 'Could not read the sync health snapshot. Please try again.');
    }
};

export = {
    _syncTriggerPartnerSync,
    _syncTriggerBigQuerySync,
    _syncTriggerInstallAttributionSync,
    _syncTriggerDummySync,
    _syncJobStatus,
    _syncListJobs,
    _syncCancelJob,
    _syncHealth
};
