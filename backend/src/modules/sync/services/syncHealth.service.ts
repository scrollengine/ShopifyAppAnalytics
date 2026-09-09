'use strict';

/**
 * ============================================================================
 *  IS DATA FLOWING? — the sync health snapshot
 * ============================================================================
 *
 *  Serves `GET /api/sync/health`. It answers the four questions an operator
 *  actually asks when a number on the dashboard looks stale, in the order they
 *  ask them:
 *
 *    1. IS THERE ANYTHING IN THE DATABASE?   `collections[]`, with exact rows.
 *    2. WHEN DID EACH JOB LAST WORK?         `last_success_per_type`.
 *    3. IS ANYTHING GOING TO RUN AGAIN?      `schedules[]` and `sync_disabled`.
 *    4. HOW FAR DOES THE DATA REACH?         `apps[].coverage`.
 *
 *  ──  AN EMPTY COLLECTION IS THE HARDEST THING ON THIS SCREEN TO REPORT ────
 *
 *  Zero rows has at least four meanings and they demand four different actions:
 *  nothing has ever synced; a sync ran and genuinely found nothing; the optional
 *  listing tier was never configured; or a setup step was never taken. The data
 *  cannot tell them apart — every one of them is the same absence of rows.
 *
 *  The WATERMARK is what separates them, so `resolveCollectionState` (pure) is
 *  handed the row count, the tier and the watermark and returns a state AND the
 *  sentence that goes with it. Publishing `0` alone is how a dashboard reports a
 *  quiet week as an outage, or — far worse — an outage as a quiet week.
 *
 *  ──  WHY `last_run_per_type` EXISTS BESIDE `last_success_per_type` ────────
 *
 *  On the success block alone, "this job has never run" and "this job runs every
 *  night and fails every night" are the same `null`. They could not be more
 *  different: the first is a setup step, the second is an incident. So the
 *  newest run of ANY status is published beside the newest success, and a FAILED
 *  last run raises a warning naming its `failure_reason`.
 *
 *  ──  `scheduled` IS OBSERVED, NEVER INFERRED ──────────────────────────────
 *
 *  The next-fire times come from `syncCronScheduler.describeSchedules`, which
 *  reads the live timer registry. Deriving them here from `SYNC_DISABLED` and
 *  `BIGQUERY.ENABLED` would be a SECOND copy of the arming rules, and the day
 *  the two disagreed this screen would promise a nightly sync that is not going
 *  to happen — which is precisely the failure it exists to detect.
 *
 *  ⚠️ It is a PROCESS-LOCAL answer: timers live in the process that armed them.
 *  This build arms everything in `src/apps/app.ts`, the same process that serves
 *  this endpoint, so here it is the whole truth.
 *
 *  ──  EVERY NUMBER HERE IS A BARE NUMBER ───────────────────────────────────
 *
 *  Row counts, durations, gap days and the two link percentages are plain
 *  numbers, not `confidence.helper` envelopes. The enveloped form belongs to
 *  `GET /api/meta/coverage`, whose renderer is ours and knows to unwrap it.
 *  Anything else does `Number(envelope)` → `NaN` → an em dash, MANUFACTURING the
 *  missing figure the rule exists to prevent. `null` still means NOT MEASURED
 *  and never `0`, which is a real and sometimes reassuring value.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import syncConstants = require('../constants/sync.constants');
import healthConstants = require('../constants/syncHealth.constants');
import collectionStateHelper = require('../helpers/collectionState.helper');
import syncJobRowHelper = require('../helpers/syncJobRow.helper');
import syncHealthRepository = require('../repositories/syncHealth.repository');
import syncCronSchedulerService = require('./syncCronScheduler.service');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type { SyncJobDoc } from '../../shared/types/entity.types';
import type { NoDomainParamsInput } from '../types/syncJob.types';
import type {
    CollectionHealth,
    JobTypeBucket,
    LastRunSummary,
    LastSuccessSummary,
    PartnerAppHealth,
    PartnerAppHealthRow,
    SyncHealthResponse,
    SyncRunnerConfig
} from '../types/syncHealth.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { STORABLE_JOB_TYPES, SYNC_JOB_STATUS, SYNC_JOB_FAILURE_REASONS } = syncConstants;
const { HEALTH_COLLECTIONS } = healthConstants;
const { resolveCollectionState } = collectionStateHelper;
//  The SAME serializer the list and the by-id endpoints use. The last-run block picks fields OUT
// of its output rather than reading the document again, so there is one definition of what a job
// row's fields are called and no way for this screen to disagree with the history table.
const { serializeSyncJob } = syncJobRowHelper;
const { describeSchedules } = syncCronSchedulerService;

/*
 * ⚠️ The TypeScript return type below is the UNPARAMETERISED `ServiceResult`, while the JSDoc
 * `@returns` names the payload it carries on success — the convention every service here follows,
 * because a failure envelope carries `data: {}`, which is not assignable to a payload interface.
 */

/** Every job type the ledger can hold, as an array, so the per-type blocks cover all of them. */
const _JOB_TYPES: readonly string[] = Object.values<string>(STORABLE_JOB_TYPES);

/** Every lifecycle status, for the zero-filled tally. */
const _JOB_STATUSES: readonly string[] = Object.values<string>(SYNC_JOB_STATUS);

/**
 * An ISO string, or null.
 *
 * ⚠️ A formatting utility, not a domain decision — but the same three lines are a private local in
 * `modules/store/services/subscriptionList.service`, and its honest home is `shared/helpers` where
 * both could import it. That file is outside this wave's ownership; the duplication is recorded here
 * rather than left for someone to find.
 *
 * The `NaN` guard is load-bearing: an `Invalid Date` stringifies to `null` through `JSON.stringify`
 * anyway, but `.toISOString()` on one THROWS — inside a health endpoint, which is the one place a
 * throw destroys exactly the signal the caller came for.
 *
 * @param [value] - Any stored date.
 * @returns The ISO form, or null when there is no usable date.
 */
const _iso = (value?: Date | null): string | null => {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        return null;
    }
    return value.toISOString();
};

/**
 * The NEWEST of a set of watermarks, as ISO, or null when none has ever been set.
 *
 * ⚠️ NEWEST ACROSS EVERY APP, which is the right answer to "has this ever run at all" and an
 * optimistic one for a deployment with two apps where only one has synced. The per-app watermarks in
 * `apps[]` are where that distinction stays visible, which is why they are published beside this
 * rather than replaced by it.
 *
 * @param values - One app's value each.
 * @returns The newest, ISO-8601, or null.
 */
const _newestWatermark = (values: ReadonlyArray<Date | null | undefined>): string | null => {
    let newest: Date | null = null;
    for (const value of values) {
        if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
            continue;
        }
        if (newest === null || value.getTime() > newest.getTime()) {
            newest = value;
        }
    }
    return _iso(newest);
};

/**
 *  THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * Rendered one per warning and KEYED BY THE STRING ITSELF, so two identical strings collide and one
 * is silently DROPPED — a duplicate message does not double up, it disappears and takes its
 * condition with it. Keeping them together is what makes that checkable by eye.
 */
const _WARNINGS = Object.freeze({
    syncDisabled: 'SYNC_DISABLED=true, so the runner claims nothing and NO schedule is armed. Stored data '
        + 'is still served and every figure on this dashboard keeps rendering — it simply stops moving, '
        + 'which is the hardest kind of outage to notice. Unset the variable and restart the API.',

    noPartnerApp: 'No partner app is registered, so there is nothing for any sync to run against. Set '
        + 'SHOPIFY_PARTNER_APP_ID and restart, or POST /api/partner-apps — no restart needed for that one.',

    noOperatorAccount: 'No operator account exists, so nobody can sign in to this deployment. Set '
        + 'ADMIN_EMAIL and ADMIN_PASSWORD and restart; the account is created at boot.',

    neverRunAnything: 'No background job has ever been recorded here. Nothing has been triggered, by an '
        + 'operator or by the schedule, so every collection below is empty for that reason rather than '
        + 'because of anything about your business.',

    neverPartnerSynced: 'No Partner API sync has ever completed for any registered app. Until one does, '
        + 'every figure on this dashboard reports that it has no data — which is correct, and is not the '
        + 'same as reporting a zero.',

    listingTierNotConnected: 'The listing-analytics tier (BigQuery) is not configured. That is an ordinary '
        + 'state: everything from installs onward works without it, and only the traffic-source, listing-view '
        + 'and install-attribution views are affected. They report that they have no data source rather than '
        + 'showing zeros.',

    lastRunFailed: (job_type: string, reason: string, message: string): string => `The most recent ${job_type} `
        + `run FAILED (${reason || 'no reason recorded'}): ${message || 'the handler reported no message'}. `
        + 'Whatever that job feeds has stopped moving from that point on — the figures still render, using '
        + 'the last data that was successfully written.',

    /**
     *  THE *RUNNING* SWEEP. Only emitted for a row that was actually CLAIMED — see the gate at the
     * call site, and `pendingSweepLastRun` below for the other half.
     *
     * `failStaleJobs` writes `STUCK_TIMEOUT` for BOTH sweeps, so branching on the failure reason
     * alone published this sentence — "the process died mid-run", "NOT safe to re-run blindly" —
     * over a job that never started and wrote nothing. That is the most expensive kind of wrong an
     * outage screen can be: it tells the operator not to do the one thing that fixes it.
     */
    stuckTimeoutLastRun: (job_type: string): string => `The most recent ${job_type} run was failed by the `
        + 'stuck-job sweep rather than by its own handler, which means the process holding it died mid-run. '
        + 'Part of its output may already have been written, so it is the one failure that is NOT safe to '
        + 're-run blindly — check what it wrote before triggering it again.',

    /**
     *  THE *PENDING* SWEEP — the same `STUCK_TIMEOUT` reason, the opposite advice.
     *
     * A row swept out of PENDING was never claimed: `started_at` is null and `attempts` is 0, so no
     * handler ever opened it and nothing was written. Re-running is not merely safe, it is the
     * correct action — the output the job was supposed to produce does not exist yet.
     *
     * ⚠️ The sweep cannot tell "nothing is alive to claim it" from "the runner is alive and was
     * busy the whole time" (`MAX_CONCURRENT_JOBS` defaults to 1, so one long run starves the queue
     * past `SYNC_STUCK_PENDING_MS`). Both possibilities are named, because the fix differs and the
     * evidence on the row does not separate them.
     */
    pendingSweepLastRun: (job_type: string): string => `The most recent ${job_type} run was failed by the `
        + 'stuck-job sweep WITHOUT EVER STARTING — it sat queued past the pending timeout and no runner '
        + 'ever claimed it (nothing started it, and its attempt count is still zero). Nothing ran and '
        + 'nothing was written, so re-running it is safe and is the right thing to do. Check first that the '
        + 'runner is alive and that SYNC_DISABLED is unset — and note that a single long-running job can '
        + 'starve the queue on its own, because MAX_CONCURRENT_JOBS defaults to 1.',

    schedulesNotArmed: (labels: string): string => `No timer is armed in this process for: ${labels}. Syncing `
        + 'is not disabled and the tier is configured, so these should be scheduled — the API was probably '
        + 'started before this schedule existed, or the arming threw at boot. Restart the API and check the '
        + 'boot log.',

    apiVsWorkerProcess: 'Schedule state is read from live timers, which exist only in the process that armed '
        + 'them. This build arms every schedule in the API process, so what is reported here is the whole '
        + 'truth; a deployment that ran the runner separately would need this recorded in the datastore.'
});

/**
 * Turns the `$group` output of the health aggregation into a lookup by job type.
 *
 * @param buckets - `{ _id: job_type, doc }` entries. A type that has never run is absent.
 * @returns Job type -> its winning document.
 */
const _bucketsByJobType = (buckets: ReadonlyArray<JobTypeBucket<SyncJobDoc>>): Map<string, SyncJobDoc> => {
    const byType = new Map<string, SyncJobDoc>();
    for (const bucket of buckets) {
        if (bucket && bucket._id !== null && bucket._id !== undefined && bucket.doc) {
            byType.set(String(bucket._id), bucket.doc);
        }
    }
    return byType;
};

/**
 * Reports the health of the whole sync machinery.
 *
 *  A 200 WITH EVERYTHING EMPTY IS THE CORRECT ANSWER on a fresh install, and every empty thing on
 * it carries the reason it is empty. This endpoint never refuses: a health check that fails when
 * things are unhealthy reports nothing at the exact moment it matters most.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The operator asking.
 * @param params1 - No domain parameters; the argument is still required for signature consistency.
 * @returns Resolves with the snapshot. Never rejects.
 */
const getSyncHealth = ({ user_id }: IdentityObject, {}: NoDomainParamsInput): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available, please log in and try again.'));
            }

            // THE ONE JUDGEMENT INSTANT. Everything below is stamped with it.
            const asOf = new Date();
            const warnings: string[] = [];

            // Three independent reads of independent collections. Concurrent because a health screen
            // is reloaded by someone who is already worried, and three sequential round trips is
            // three latencies they wait through.
            const [rowCounts, appRows, jobHealth] = await Promise.all([
                syncHealthRepository.countAllCollections(),
                syncHealthRepository.findPartnerAppHealthRows(),
                syncHealthRepository.aggregateSyncJobHealth()
            ]);

            const listingTierConnected = Boolean(config.BIGQUERY.ENABLED);

            // ── A. The watermarks that decide what an empty collection means ─
            //
            // WRITTEN OUT rather than indexed by the registry's field name, so the COMPILER checks
            // every one: indexing a row with a `string` types as `any`, and a renamed watermark would
            // keep compiling while silently resolving to `undefined` — which reads as NEVER_SYNCED
            // over a collection that syncs nightly.
            const watermarks: Record<string, string | null> = {
                last_synced_at: _newestWatermark(appRows.map((row: PartnerAppHealthRow) => row.last_synced_at)),
                last_bq_synced_at: _newestWatermark(appRows.map((row: PartnerAppHealthRow) => row.last_bq_synced_at)),
                last_install_attrib_synced_at: _newestWatermark(appRows.map((row: PartnerAppHealthRow) => row.last_install_attrib_synced_at))
            };

            // ── B. The nine collections ─────────────────────────────────────
            const collections: CollectionHealth[] = HEALTH_COLLECTIONS.map((entry) => {
                //  `|| 0` covers a registry entry the repository does not count. It cannot happen
                // — `test/syncJobs.test.js` asserts the two agree, in both directions — but the
                // failure mode if it ever did is a collection silently reporting `undefined` rows.
                const rows = rowCounts[entry.key] || 0;
                const watermarkAt = entry.watermark === '' ? null : (watermarks[entry.watermark] || null);
                const verdict = resolveCollectionState({
                    rows: rows,
                    tier: entry.tier,
                    label: entry.label,
                    watermark_field: entry.watermark,
                    watermark_at: watermarkAt,
                    listing_tier_connected: listingTierConnected
                });

                return {
                    key: entry.key,
                    collection: entry.collection,
                    label: entry.label,
                    holds: entry.holds,
                    tier: entry.tier,
                    rows: rows,
                    state: verdict.state,
                    reason: verdict.reason,
                    watermark_field: entry.watermark,
                    watermark_at: watermarkAt
                };
            });

            // ── C. Per job type: the last success, and the last run at all ──
            const lastSuccessByType = _bucketsByJobType(jobHealth.last_success);
            const lastRunByType = _bucketsByJobType(jobHealth.last_run);

            const lastSuccessPerType: Record<string, LastSuccessSummary | null> = {};
            const lastRunPerType: Record<string, LastRunSummary | null> = {};

            for (const jobType of _JOB_TYPES) {
                //  EVERY job type gets a key, `null` where nothing has run. The dashboard's sync
                // registry keys its cards on these literals, and an ABSENT key makes a card fall
                // back to "Never completed successfully" — a confident negative built from a gap in
                // our own reading, which is exactly the claim this project refuses to make.
                lastSuccessPerType[jobType] = null;
                lastRunPerType[jobType] = null;

                const successRow = serializeSyncJob(lastSuccessByType.get(jobType) || null);
                if (successRow) {
                    lastSuccessPerType[jobType] = {
                        job_id: successRow.job_id,
                        completed_at: _iso(successRow.completed_at),
                        duration_ms: successRow.duration_ms,
                        triggered_by: successRow.triggered_by
                    };
                }

                const runRow = serializeSyncJob(lastRunByType.get(jobType) || null);
                if (runRow) {
                    lastRunPerType[jobType] = {
                        job_id: runRow.job_id,
                        status: runRow.status,
                        triggered_by: runRow.triggered_by,
                        started_at: _iso(runRow.started_at),
                        completed_at: _iso(runRow.completed_at),
                        duration_ms: runRow.duration_ms,
                        failure_reason: runRow.failure_reason,
                        error_message: runRow.error_message,
                        attempts: runRow.attempts
                    };

                    if (runRow.status === SYNC_JOB_STATUS.FAILED) {
                        warnings.push(_WARNINGS.lastRunFailed(jobType, runRow.failure_reason, runRow.error_message));
                        //  STUCK_TIMEOUT IS TWO DIFFERENT FAULTS WITH OPPOSITE REMEDIES, AND THE
                        // REASON CODE ALONE CANNOT TELL THEM APART. `failStaleJobs` stamps it for
                        // BOTH sweeps — the RUNNING one (a claimed job whose process died) and the
                        // PENDING one (a queued job nothing ever claimed) — so a gate on the reason
                        // alone published "it died mid-run, NOT safe to re-run blindly" over a job
                        // that never started. That sentence talks an operator OUT OF the one action
                        // that fixes the outage, on the screen they opened to diagnose it.
                        //
                        // The evidence that separates them is already on the row and is written by
                        // the claim itself: `claimPendingJob` is the only thing that sets
                        // `started_at` and the only thing that increments `attempts`, both in the
                        // same conditional write. Never claimed => both still at their initial
                        // values. Testing BOTH rather than either is deliberate: it is the
                        // conjunction that says "no handler ever opened this row".
                        if (runRow.failure_reason === SYNC_JOB_FAILURE_REASONS.STUCK_TIMEOUT) {
                            if (runRow.started_at === null && runRow.attempts === 0) {
                                warnings.push(_WARNINGS.pendingSweepLastRun(jobType));
                            } else {
                                warnings.push(_WARNINGS.stuckTimeoutLastRun(jobType));
                            }
                        }
                    }
                }
            }

            // ── D. The status tally, with its zeros ────────────────────────
            const jobStatusCounts: Record<string, number> = {};
            for (const statusName of _JOB_STATUSES) {
                jobStatusCounts[statusName] = 0;
            }
            for (const bucket of jobHealth.by_status) {
                //  A status outside the vocabulary is KEPT rather than dropped, so the tally still
                // sums to the `sync_jobs` row count above and a reader can check the arithmetic.
                const value = bucket._id === null || bucket._id === undefined ? '(none)' : String(bucket._id);
                jobStatusCounts[value] = (jobStatusCounts[value] || 0) + (bucket.rows || 0);
            }

            // ── E. Every app's watermarks and coverage gates ────────────────
            const apps: PartnerAppHealth[] = appRows.map((row: PartnerAppHealthRow) => ({
                partner_app_id: String(row._id),
                app_handle: row.app_handle,
                display_name: row.display_name,
                is_active: Boolean(row.is_active),
                last_synced_at: _iso(row.last_synced_at),
                last_bq_synced_at: _iso(row.last_bq_synced_at),
                last_install_attrib_synced_at: _iso(row.last_install_attrib_synced_at),
                coverage: {
                    earliest_event_at: _iso(row.earliest_event_at),
                    earliest_transaction_at: _iso(row.earliest_transaction_at),
                    lifetime_sync_completed_at: _iso(row.lifetime_sync_completed_at),
                    shop_name_coverage_since: _iso(row.shop_name_coverage_since),
                    //  `?? null`, never `|| null`. A measured `0` is a REAL and reassuring value on
                    // both of the numeric gates — `event_history_gap_days: 0` asserts the history has
                    // no day-wide holes at all — and `||` would rewrite that measurement as "never
                    // measured", which is the exact inversion this codebase exists to refuse.
                    event_history_gap_days: row.event_history_gap_days ?? null,
                    charge_link_absent_pct: row.charge_link_absent_pct ?? null,
                    charge_link_unresolved_pct: row.charge_link_unresolved_pct ?? null
                }
            }));

            // ── F. What is actually armed ──────────────────────────────────
            const schedules = describeSchedules();

            const unarmed: string[] = [];
            for (const schedule of schedules) {
                if (schedule.scheduled) {
                    continue;
                }
                //  Only a schedule that OUGHT to be armed is worth a warning. `SYNC_DISABLED` and
                // an unconfigured listing tier are deliberate states, already reported by their own
                // sentences — repeating them here would teach an operator to ignore this one.
                if (config.SYNC.DISABLED) {
                    continue;
                }
                //  The two listing schedules are identified POSITIVELY, by name, rather than as
                // "not the partner one". The scheduler's timer labels are the job-type literals by
                // construction; if that ever stops being true this test stops matching and the
                // schedule gets WARNED ABOUT — noisier, never quieter, which is the safe direction
                // for a check whose whole job is to notice that something is not armed.
                const isListingSchedule = schedule.label === STORABLE_JOB_TYPES.BIGQUERY_SYNC
                    || schedule.label === STORABLE_JOB_TYPES.INSTALL_ATTRIBUTION_SYNC;
                if (isListingSchedule && !listingTierConnected) {
                    continue;
                }
                unarmed.push(schedule.label);
            }
            if (unarmed.length > 0) {
                warnings.push(_WARNINGS.schedulesNotArmed(unarmed.join(', ')));
                warnings.push(_WARNINGS.apiVsWorkerProcess);
            }

            // ── G. Everything that is missing, said out loud ────────────────
            if (config.SYNC.DISABLED) {
                warnings.push(_WARNINGS.syncDisabled);
            }
            if (!listingTierConnected) {
                warnings.push(_WARNINGS.listingTierNotConnected);
            }
            if (rowCounts.partner_apps === 0) {
                warnings.push(_WARNINGS.noPartnerApp);
            }
            if (rowCounts.admin_users === 0) {
                warnings.push(_WARNINGS.noOperatorAccount);
            }
            if (rowCounts.sync_jobs === 0) {
                warnings.push(_WARNINGS.neverRunAnything);
            }
            //  The WATERMARK decides this, never the event row count. An app with no events and a
            // set watermark has synced and found nothing, which is a completely different sentence.
            if (appRows.length > 0 && watermarks.last_synced_at === null) {
                warnings.push(_WARNINGS.neverPartnerSynced);
            }

            const runner: SyncRunnerConfig = {
                poll_interval_ms: config.SYNC.POLL_INTERVAL_MS,
                max_concurrent_jobs: config.SYNC.MAX_CONCURRENT_JOBS,
                max_attempts: config.SYNC.MAX_ATTEMPTS,
                stuck_running_ms: config.SYNC.STUCK_RUNNING_MS,
                stuck_pending_ms: config.SYNC.STUCK_PENDING_MS
            };

            const payload: SyncHealthResponse = {
                as_of: asOf.toISOString(),
                sync_disabled: Boolean(config.SYNC.DISABLED),
                listing_tier_connected: listingTierConnected,
                runner: runner,
                collections: collections,
                last_success_per_type: lastSuccessPerType,
                last_run_per_type: lastRunPerType,
                job_status_counts: jobStatusCounts,
                schedules: schedules,
                apps: apps,
                // DE-DUPLICATED: warnings are rendered keyed by the string itself, so a duplicate is
                // a key collision that DROPS one of them rather than showing it twice.
                warnings: [...new Set(warnings)]
            };

            return resolve(promiseReturnResult(true, payload, {}, 'Sync health fetched.'));
        } catch (error) {
            // A health endpoint that throws reports nothing at the exact moment it matters most.
            customConsoleError('ERROR: Sync syncHealthService getSyncHealth', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read the sync health snapshot. Please try again.'));
        }
    });
};

export = {
    getSyncHealth
};
