'use strict';

/**
 * ============================================================================
 *  SYNC CRON SCHEDULER — the daily Partner sync, on a self-rescheduling timer
 * ============================================================================
 *
 *  No cron library and no external scheduler. A tick computes how long it is
 *  until the next scheduled UTC instant, sleeps that long with `setTimeout`,
 *  fires, and re-arms — so the schedule is one dependency-free arithmetic
 *  function (`helpers/cron.helper`) plus a timer.
 *
 *  The tick does NOT do the work. It CREATES a job row per active app and
 *  returns; the runner claims and executes it. That separation is what makes a
 *  scheduled run indistinguishable from one an operator triggered by hand —
 *  same row, same claim, same audit trail, same failure handling — instead of a
 *  second execution path that only ever runs at 3am and is therefore the one
 *  nobody has ever watched.
 *
 *  ──  Cron strings are validated AT BOOT, and an invalid one is FATAL ───────
 *  `startPartnerSyncCron` THROWS on an expression outside the supported subset,
 *  and the worker entry point is expected to let that reach its fatal catch.
 *
 *  This is the one place in the module that deliberately throws rather than
 *  resolving a failure envelope, and the reason is the failure mode it prevents.
 *  A scheduler that logs "unsupported expression" and returns leaves a process
 *  that starts cleanly, reports healthy, serves every endpoint — and never syncs
 *  again. Nothing breaks. The dashboard just quietly stops moving, and the
 *  numbers on it stay plausible while going stale, which is precisely the class
 *  of silent wrongness this project exists to refuse. A typo in
 *  `SYNC_DAILY_CRON` should cost you a failed deploy, not a month of data.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import constants = require('../constants/sync.constants');
import cronHelper = require('../helpers/cron.helper');
import syncJobRepository = require('../repositories/syncJob.repository');
import syncJobService = require('./syncJob.service');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type {
    ArmedSchedule,
    BigQueryCronStartPayload,
    CronScheduleStatus,
    CronStartPayload,
    CronTickFn,
    CronTickPayload,
    ParsedDailyCron
} from '../types/cron.types';

const { customConsoleLog, customConsoleError, customConsoleWarn } = logger;
const { promiseReturnResult } = promiseHelper;
const { SYNC_JOB_TYPES, SYNC_JOB_TRIGGERED_BY, SYNC_WORKER_USER_ID } = constants;
const { parseDailyCron, msUntilNextRun } = cronHelper;
const { createSyncJob } = syncJobService;

/*
 * ⚠️ The TypeScript return type on the service functions below is the UNPARAMETERISED
 * `ServiceResult`, while each JSDoc `@returns` names the payload interface it carries on success.
 * Same convention as `modules/auth`: a failure envelope carries `data: {}`, which is not assignable
 * to a payload interface, so parameterising would force a cast at every failure branch — and this
 * codebase reserves `as` for `shared/repositories/models.repository` and `as const`. Success
 * payloads are built as TYPED LOCALS, so a missing or misnamed field is still a compile error.
 */


/** Label used in log lines and in the timer registry. One schedule ships in this release. */
const PARTNER_SYNC_LABEL = 'PARTNER_SYNC';

/** Timer labels for the two listing-analytics schedules. */
const BIGQUERY_SYNC_LABEL = 'BIGQUERY_SYNC';
const INSTALL_ATTRIBUTION_SYNC_LABEL = 'INSTALL_ATTRIBUTION_SYNC';

/**
 * Live schedules by label, so `stopAllCrons` can clear them and `describeSchedules` can report them.
 *
 *  IT HOLDS THE ARMED FACTS, NOT A RECOMPUTATION OF THEM. `GET /api/sync/health` reports when each
 * schedule next fires, and the tempting way to answer that is to re-parse `config` and re-run the
 * cron arithmetic — which would be a SECOND spelling of the arming decision, and would answer
 * confidently for a schedule that is not armed at all. A timer in this registry is the only proof a
 * schedule exists in this process, and the expression and instant beside it are the ones the timer
 * was actually built from.
 */
const _activeTimers: Record<string, ArmedSchedule | null> = {};

/**
 * Every schedule this module knows how to arm, and the config key each reads its expression from.
 *
 * Enumerated so `describeSchedules` can report a schedule that is NOT armed. A registry-only listing
 * would report three schedules on a healthy install and NOTHING at all on the one that stopped
 * syncing — the exact deployment whose operator is reading the health screen.
 *
 * ⚠️ The expression is read through a FUNCTION rather than captured at module load: `config` is a
 * frozen snapshot taken at first require, and reading it eagerly here would bind this list before
 * `bootstrap()` had run dotenv in any entry point that requires this file early.
 */
const _SCHEDULE_REGISTRY: ReadonlyArray<{ label: string; expression: () => string }> = Object.freeze([
    { label: PARTNER_SYNC_LABEL, expression: () => config.SYNC.DAILY_CRON },
    { label: BIGQUERY_SYNC_LABEL, expression: () => config.BIGQUERY.BIGQUERY_SYNC_CRON },
    { label: INSTALL_ATTRIBUTION_SYNC_LABEL, expression: () => config.BIGQUERY.INSTALL_ATTRIBUTION_SYNC_CRON }
]);

/**
 * The identity scheduled work acts as.
 *
 * @returns The worker identity.
 */
const _workerIdentity = (): IdentityObject => ({
    user_id: SYNC_WORKER_USER_ID
});

/**
 * Creates one PARTNER_SYNC job per active partner app.
 *
 * Exported so an operator can trigger the whole fan-out by hand — the same code path the timer
 * uses, which is the only way to be sure the scheduled path actually works.
 *
 * ⚠️ `failed` is reported, not swallowed. A fan-out that creates three jobs out of four is not a
 * success, and a caller that only reads `queued` would never know one app stopped updating. An
 * empty app list is likewise reported honestly as `total_apps: 0` with a warning, because
 * "everything succeeded" over zero apps is exactly how a misconfigured install looks healthy.
 *
 * @returns Resolves with per-app counts. Never rejects.
 */
/**
 * Creates one PENDING job of `job_type` per active partner app.
 *
 * The tick does NOT do the work — it enqueues, and the runner claims and executes. That separation
 * is what makes a scheduled run indistinguishable from one an operator triggered by hand: same row,
 * same claim, same audit trail, same failure handling, instead of a second execution path that only
 * ever runs at 3am and is therefore the one nobody has ever watched.
 *
 * Shared by all three schedules. One implementation on purpose — three copies of this loop would
 * drift, and the way that drift shows up is one job type quietly not being enqueued at all.
 *
 * @param job_type - The job type to enqueue.
 * @param label - Human label for the log lines and messages.
 * @returns A promise resolving to a promiseReturnResult carrying the tick counts.
 */
const _enqueueForAllActiveApps = (job_type: string, label: string): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const appIds = await syncJobRepository.findActivePartnerAppIds();
            if (appIds.length === 0) {
                customConsoleWarn(`WARN: [Sync:Cron] No active partner app is configured, so the scheduled ${label} created nothing.`);
                const nothingToDo: CronTickPayload = {
                    job_type: job_type,
                    queued: 0,
                    failed: 0,
                    total_apps: 0
                };
                return resolve(promiseReturnResult(true, nothingToDo, {}, `No active partner apps to ${label}.`));
            }

            const identity = _workerIdentity();
            let queued = 0;
            let failed = 0;

            for (const appId of appIds) {
                const created = await createSyncJob(identity, {
                    job_type: job_type,
                    payload: { partner_app_id: appId },
                    triggered_by: SYNC_JOB_TRIGGERED_BY.CRON
                });
                if (created.status) {
                    queued += 1;
                } else {
                    failed += 1;
                    customConsoleError(`ERROR: [Sync:Cron] Failed to create the scheduled ${label} for an app`, {
                        partner_app_id: appId,
                        job_type: job_type,
                        msg: created.msg
                    });
                }
            }

            const tick: CronTickPayload = {
                job_type: job_type,
                queued: queued,
                failed: failed,
                total_apps: appIds.length
            };
            return resolve(promiseReturnResult(true, tick, {}, `${label} cron tick complete.`));
        } catch (error) {
            customConsoleError(`ERROR: [Sync:Cron] The ${label} tick threw`, error);
            return resolve(promiseReturnResult(false, {}, error, `The ${label} cron tick failed.`));
        }
    });
};

/**
 * Enqueues a Partner API sync for every active app. The scheduled path, runnable by hand.
 *
 * @returns A promise resolving to a promiseReturnResult carrying the tick counts.
 */
const enqueuePartnerSyncForAllActiveApps = (): Promise<ServiceResult> => {
    return _enqueueForAllActiveApps(SYNC_JOB_TYPES.PARTNER_SYNC, 'partner sync');
};

/**
 * Enqueues the three daily listing-analytics rollups for every active app.
 *
 * @returns A promise resolving to a promiseReturnResult carrying the tick counts.
 */
const enqueueBigQuerySyncForAllActiveApps = (): Promise<ServiceResult> => {
    return _enqueueForAllActiveApps(SYNC_JOB_TYPES.BIGQUERY_SYNC, 'BigQuery rollup sync');
};

/**
 * Enqueues the per-install attribution pull for every active app.
 *
 * ⚠️ Without this schedule NOTHING would ever write the attribution rows outside a manual trigger,
 * and every store would read "not attributed" indefinitely. That failure is completely silent: the
 * page renders, it is simply always empty.
 *
 * @returns A promise resolving to a promiseReturnResult carrying the tick counts.
 */
const enqueueInstallAttributionSyncForAllActiveApps = (): Promise<ServiceResult> => {
    return _enqueueForAllActiveApps(SYNC_JOB_TYPES.INSTALL_ATTRIBUTION_SYNC, 'install attribution sync');
};

/**
 * Arms a self-rescheduling timer for one parsed schedule.
 *
 * The re-arm is in a `finally`, so a tick that throws still schedules the next one. Without that, a
 * single bad night permanently stops the schedule — the process keeps running and nothing ever fires
 * again, which looks identical to everything being fine.
 *
 * @param label - Short name used in log lines and as the timer key.
 * @param parsed - A validated schedule.
 * @param tickFn - The body to run at each occurrence.
 * @returns When the first tick will fire, so the caller can report it.
 */
const _armSchedule = (label: string, parsed: ParsedDailyCron, tickFn: CronTickFn): Date => {
    const delayMs = msUntilNextRun(parsed, new Date());
    const firesAt = new Date(Date.now() + delayMs);

    customConsoleLog(`INFO: [Sync:Cron] Next ${label} tick scheduled`, {
        cron: parsed.expression,
        fires_in_ms: delayMs,
        fires_at: firesAt.toISOString()
    });

    const timer = setTimeout(async () => {
        try {
            const result = await tickFn();
            customConsoleLog(`INFO: [Sync:Cron] ${label} tick fired`, result && result.data);
        } catch (error) {
            customConsoleError(`ERROR: [Sync:Cron] ${label} tick threw`, error);
        } finally {
            _armSchedule(label, parsed, tickFn);
        }
    }, delayMs);

    // `unref()` so a pending schedule never by itself keeps the process alive. A worker with nothing
    // else to do should exit rather than sit until 3am holding the event loop open.
    if (timer && typeof timer.unref === 'function') {
        timer.unref();
    }

    //  The instant is STORED, not recomputed on demand. The re-arm in the `finally` above runs
    // this function again, so the registry moves forward with the schedule and a health read never
    // reports a fire time that has already passed.
    _activeTimers[label] = {
        timer: timer,
        expression: parsed.expression,
        next_fire_at: firesAt
    };

    return firesAt;
};

/**
 * What each schedule is doing RIGHT NOW, in this process.
 *
 *  READS THE REGISTRY, NEVER THE CONFIG, for the two facts that matter. `scheduled` is "a timer
 * exists" and `next_fire_at` is "the instant that timer was built for" — both observed, neither
 * inferred. The alternative (deciding from `SYNC_DISABLED` and `BIGQUERY.ENABLED` whether a schedule
 * *ought* to be armed) is a second copy of the arming rules, and the day the two disagree the health
 * screen reports a nightly sync that is not going to happen. Configuration is consulted for ONE
 * thing: the expression of a schedule that is not armed, which the registry cannot know.
 *
 * ⚠️ THIS IS A PROCESS-LOCAL ANSWER. Timers live in the process that armed them, so a deployment
 * running the API and a separate worker would see this endpoint report only its own. This build arms
 * everything in `src/apps/app.ts`, so here they are the same process — a split deployment would need
 * this fact recorded in the datastore instead.
 *
 * Returns a plain array rather than a `promiseReturnResult` envelope: it performs no I/O and has no
 * failure mode, matching `assertHandlersRegistered`, which returns a bare list for the same reason.
 *
 * @returns One entry per known schedule, armed or not.
 */
const describeSchedules = (): CronScheduleStatus[] => {
    return _SCHEDULE_REGISTRY.map((entry) => {
        const armed = _activeTimers[entry.label];
        if (!armed) {
            return {
                label: entry.label,
                expression: entry.expression(),
                scheduled: false,
                next_fire_at: null
            };
        }
        return {
            label: entry.label,
            // The expression the TIMER was built from, which can differ from the configured one if
            // the environment changed after boot — and if it has, that is the fact worth reporting.
            expression: armed.expression,
            scheduled: true,
            next_fire_at: armed.next_fire_at.toISOString()
        };
    });
};

/**
 * Starts the daily PARTNER_SYNC schedule from `config.SYNC.DAILY_CRON`.
 *
 *  THROWS on an unsupported cron expression. Call this from the worker entry point and let it
 * propagate to the fatal catch — see this file's header for why a silent no-op is the worse
 * outcome. The message names the setting and shows the two accepted forms, so the fix is visible in
 * the crash itself rather than in the documentation.
 *
 * Honours `config.SYNC.DISABLED` by scheduling nothing and reporting `started: false`.
 *
 * @returns Resolves with when the first tick will fire.
 */
const startPartnerSyncCron = (): ServiceResult => {
    const expression = config.SYNC.DAILY_CRON;

    // Validated BEFORE the disabled check on purpose: a bad expression is a bad expression whether
    // or not syncing happens to be switched off today, and finding it only after someone clears
    // SYNC_DISABLED is finding it at the worst possible moment.
    const parsed = parseDailyCron(expression);
    if (!parsed) {
        throw new Error(
            `SYNC_DAILY_CRON is not a supported cron expression: "${expression}". ` +
            'Only two forms are understood, both in UTC: "m h * * *" for a daily run (e.g. "0 3 * * *"), ' +
            'and "m h * * dow" for a weekly one, where dow is 0-6 with 0 = Sunday (e.g. "0 8 * * 1"). ' +
            'Steps, ranges, lists and day-of-month values are not supported — refusing to start rather than firing at a time you did not choose.'
        );
    }

    if (config.SYNC.DISABLED) {
        customConsoleWarn('WARN: [Sync:Cron] SYNC_DISABLED=true — no sync is scheduled. Stored data will be served, and nothing will be refreshed.');
        const disabled: CronStartPayload = {
            started: false,
            label: PARTNER_SYNC_LABEL,
            expression: parsed.expression,
            next_fire_at: null
        };
        return promiseReturnResult(true, disabled, {}, 'Sync cron is disabled by configuration.');
    }

    if (_activeTimers[PARTNER_SYNC_LABEL]) {
        return promiseReturnResult(false, {}, {}, 'The partner-sync cron is already scheduled.');
    }

    const firesAt = _armSchedule(PARTNER_SYNC_LABEL, parsed, enqueuePartnerSyncForAllActiveApps);

    const scheduled: CronStartPayload = {
        started: true,
        label: PARTNER_SYNC_LABEL,
        expression: parsed.expression,
        next_fire_at: firesAt.toISOString()
    };
    return promiseReturnResult(true, scheduled, {}, 'Partner-sync cron scheduled.');
};

/**
 * Arms one schedule, or explains why it could not be armed.
 *
 * Shared by the two BigQuery schedules so a malformed expression is reported the same way for both.
 *
 * @param label - The timer label.
 * @param expression - The cron expression, UTC.
 * @param tickFn - What to run.
 * @param schedules - Accumulator the armed schedule is pushed onto.
 * @returns An error sentence, or '' when the schedule was armed.
 */
const _armBigQuerySchedule = (label: string, expression: string, tickFn: CronTickFn, schedules: CronStartPayload[]): string => {
    const parsed = parseDailyCron(expression);
    if (!parsed) {
        return `${label} is not a supported cron expression: "${expression}".`;
    }
    if (_activeTimers[label]) {
        return '';
    }

    const firesAt = _armSchedule(label, parsed, tickFn);
    schedules.push({
        started: true,
        label: label,
        expression: parsed.expression,
        next_fire_at: firesAt.toISOString()
    });
    return '';
};

/**
 * Starts the two listing-analytics schedules: the daily rollups, and the install-attribution pull.
 *
 * NOTHING IS SCHEDULED WHEN THE TIER IS NOT CONFIGURED. A timer firing every night into a
 * credentials error is not a diagnostic — it is a nightly ERROR in the log for a feature the
 * operator deliberately did not set up, and a log that cries wolf nightly is a log nobody reads when
 * something real breaks. Leaving BigQuery unconfigured is a supported, ordinary state, so it is
 * reported once at boot as information and then left alone.
 *
 * Both schedules are armed together but tick independently, and the attribution pull runs later in
 * the day so the heaviest query in the build never queues behind the rollups.
 *
 * THROWS on a malformed expression, matching `startPartnerSyncCron`: a scheduler that logged
 * "unsupported expression" and returned would leave a process that starts cleanly, reports healthy,
 * serves every endpoint — and never syncs again. Nothing breaks; the dashboard just quietly stops
 * moving while its numbers stay plausible.
 *
 * @returns A promiseReturnResult carrying every armed schedule and its next fire time, or
 * the reason nothing was armed.
 */
const startBigQuerySyncCrons = (): ServiceResult => {
    const schedules: CronStartPayload[] = [];

    if (!config.BIGQUERY.ENABLED) {
        customConsoleLog('INFO: [Sync:Cron] BigQuery is not configured, so no listing-analytics sync is scheduled. Traffic Sources and the top of the funnel will report that they have no data, with the reason attached.');
        const skipped: BigQueryCronStartPayload = {
            started: false,
            schedules: [],
            skipped_reason: 'BigQuery is not configured (GCP_PROJECT_ID / BQ_DATASET are unset).'
        };
        return promiseReturnResult(true, skipped, {}, 'BigQuery sync is not scheduled: the tier is not configured.');
    }

    if (config.SYNC.DISABLED) {
        customConsoleWarn('WARN: [Sync:Cron] SYNC_DISABLED=true — no BigQuery sync is scheduled. Stored data will be served, and nothing will be refreshed.');
        const disabled: BigQueryCronStartPayload = {
            started: false,
            schedules: [],
            skipped_reason: 'SYNC_DISABLED=true.'
        };
        return promiseReturnResult(true, disabled, {}, 'BigQuery cron is disabled by configuration.');
    }

    const problems = [
        _armBigQuerySchedule(BIGQUERY_SYNC_LABEL, config.BIGQUERY.BIGQUERY_SYNC_CRON, enqueueBigQuerySyncForAllActiveApps, schedules),
        _armBigQuerySchedule(
            INSTALL_ATTRIBUTION_SYNC_LABEL,
            config.BIGQUERY.INSTALL_ATTRIBUTION_SYNC_CRON,
            enqueueInstallAttributionSyncForAllActiveApps,
            schedules
        )
    ].filter(Boolean);

    if (problems.length > 0) {
        throw new Error(
            `${problems.join(' ')} Only two forms are understood, both in UTC: "m h * * *" for a daily run `
            + '(e.g. "0 2 * * *"), and "m h * * dow" for a weekly one, where dow is 0-6 with 0 = Sunday. '
            + 'Steps, ranges, lists and day-of-month values are not supported — refusing to start rather than '
            + 'firing at a time you did not choose.'
        );
    }

    const started: BigQueryCronStartPayload = {
        started: schedules.length > 0,
        schedules: schedules,
        skipped_reason: ''
    };
    return promiseReturnResult(true, started, {}, 'BigQuery sync schedules armed.');
};

/**
 * Clears every scheduled timer. Used on graceful shutdown, and between tests.
 *
 * @returns The labels that were actually holding a timer.
 */
const stopAllCrons = (): ServiceResult => {
    const cleared: string[] = [];

    Object.keys(_activeTimers).forEach((label) => {
        const armed = _activeTimers[label];
        if (armed) {
            clearTimeout(armed.timer);
            cleared.push(label);
        }
        _activeTimers[label] = null;
    });

    if (cleared.length > 0) {
        customConsoleLog('INFO: [Sync:Cron] Schedules cleared', { cleared });
    }

    return promiseReturnResult(true, { cleared: cleared }, {}, 'Sync cron schedules cleared.');
};

export = {
    startPartnerSyncCron,
    startBigQuerySyncCrons,
    describeSchedules,
    stopAllCrons,
    enqueuePartnerSyncForAllActiveApps,
    enqueueBigQuerySyncForAllActiveApps,
    enqueueInstallAttributionSyncForAllActiveApps
};
