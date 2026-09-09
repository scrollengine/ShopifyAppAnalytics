'use strict';

/**
 * ============================================================================
 *  SYNC ROUTES — mounted GUARDED at /api/sync
 * ============================================================================
 *
 *  Triggering a sync spends the install's Partner API rate budget and writes to
 *  the datastore, so it must never be reachable without the guard. The guard is
 *  applied once on the parent sub-router in src/routes/index.ts.
 * ============================================================================
 */

import { Router } from 'express';
import syncController = require('../controllers/sync.controller');

const {
    _syncTriggerPartnerSync,
    _syncTriggerBigQuerySync,
    _syncTriggerInstallAttributionSync,
    _syncTriggerDummySync,
    _syncJobStatus,
    _syncListJobs,
    _syncCancelJob,
    _syncHealth
} = syncController;

const router = Router();

// Enqueues the job and returns immediately. A 200 here means QUEUED, not SYNCED — poll the status
// route below with the returned job_id before believing a sync happened.
router.post('/partner', _syncTriggerPartnerSync);

// The GA / listing-analytics rollups. Same contract as /partner: a 200 means QUEUED.
router.post('/bigquery', _syncTriggerBigQuerySync);

// Per-install attribution. `dry_run: true` in the body PRICES the scan inline and returns an
// estimate instead of a job — the one endpoint here whose response shape depends on the request,
// and it is deliberate: an estimate that arrived as a queued job could never be read by the caller
// who asked what the scan would cost.
router.post('/install-attribution', _syncTriggerInstallAttributionSync);

//  THE SMOKE PATH, and the reason it has a route at all: it is the ONLY job that runs with no
// credential and no data source, so it is what separates "the runner is broken" from "the Partner
// API returned nothing" — two diagnoses with completely different fixes that otherwise look
// identical. The handler has shipped since day one; without this line nothing could reach it over
// HTTP, and the dashboard's "Infrastructure test" card could only report "not implemented".
//
// This completes the set: every job type with a handler now has a trigger route.
router.post('/dummy', _syncTriggerDummySync);

//  BEFORE `/jobs/:job_id`. Express matches in registration order and `:job_id` is a single
// segment, so it cannot swallow `/jobs` — but it WOULD swallow a future `/jobs/summary`, and the
// habit of registering the literal path first is what stops that from being discovered in
// production. Nothing below shadows anything above it.
router.get('/jobs', _syncListJobs);

router.get('/jobs/:job_id', _syncJobStatus);

//  POST, not DELETE. Cancelling does not remove the row — `gi_sync_jobs` is the audit ledger of
// every run this deployment has ever made, and a cancelled job is one of the things somebody later
// goes looking for. This is a state transition on a row that stays, so it is named as one.
//
// ⚠️ A 200 here means CANCELLED. The race against the runner's claim is reported as 400 with the
// reason, never as a success — see `_syncCancelJob`.
router.post('/jobs/:job_id/cancel', _syncCancelJob);

// Rows per collection, last run per job type, what is armed, and the coverage gates. Guarded, and
// deliberately far more talkative than the unauthenticated /healthz.
router.get('/health', _syncHealth);

export = router;
