/**
 * Shapes for the cron helper and the sync cron scheduler.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 */

import type { ServiceResult } from '../../../types/service.types';

/**
 * A cron expression from the supported subset, parsed.
 *
 * Only two patterns are expressible: daily fixed-time (`dow` null) and weekly fixed-time. Steps,
 * ranges, lists and day-of-month specificity are REJECTED rather than approximated — a scheduler
 * that silently reinterprets a step expression such as "every 15 minutes" as "once a day at
 * 00:00" is worse than one that refuses to start.
 */
export interface ParsedDailyCron {
    /** UTC hour, 0-23. */
    hour: number;
    /** UTC minute, 0-59. */
    minute: number;
    /** Day of week 0-6 (0 = Sunday), or null for "every day". */
    dow: number | null;
    /** The expression this was parsed from, kept for log lines and error messages. */
    expression: string;
}

/**
 * A scheduled tick body. Fires on schedule and resolves an envelope whose `data` is logged verbatim.
 *
 * Resolves rather than throws, like every service here — a throw inside a timer callback has no
 * caller to catch it.
 */
export type CronTickFn = () => Promise<ServiceResult>;

/** What one PARTNER_SYNC tick reports after fanning the job out over every active app. */
export interface CronTickPayload {
    job_type: string;
    /** Jobs successfully created. */
    queued: number;
    /** Apps whose job could not be created. Non-zero means part of the fan-out silently did nothing. */
    failed: number;
    total_apps: number;
}

/** What `startPartnerSyncCron` reports. */
/**
 * What starting the BigQuery schedules reports.
 *
 * A LIST rather than one payload, because this tier arms two independent schedules — the rollups and
 * the far heavier install-attribution pull — and an operator reading the boot log needs to see both
 * next-fire times, not one of them.
 *
 * `started: false` with an empty `schedules` and a populated `skipped_reason` is the ordinary,
 * healthy state of a deployment that never configured BigQuery. It is not a failure.
 */
export interface BigQueryCronStartPayload {
    started: boolean;
    schedules: CronStartPayload[];
    /** Why nothing was scheduled, or '' when something was. */
    skipped_reason: string;
}

/**
 * One live schedule, as the scheduler's own registry holds it.
 *
 *  `next_fire_at` IS THE INSTANT THE TIMER WAS BUILT FOR, stored when the schedule was armed and
 * refreshed by the re-arm at the end of every tick. It is not a recomputation from the expression:
 * recomputing would answer confidently for a schedule that is not armed at all, and would be a
 * second copy of the arming rules that can disagree with the timer actually holding the process.
 */
export interface ArmedSchedule {
    timer: NodeJS.Timeout;
    /** The expression this timer was PARSED FROM — not necessarily what config says now. */
    expression: string;
    next_fire_at: Date;
}

/**
 * What `describeSchedules` reports for one schedule, armed or not.
 *
 * ⚠️ PROCESS-LOCAL. `scheduled` means "a timer for this exists in THIS process". In this build every
 * schedule is armed by the API process itself, so that is the whole truth; a deployment that split
 * the runner into its own process would have to record this in the datastore instead of reading it
 * out of module state.
 */
export interface CronScheduleStatus {
    label: string;
    /** The expression in force: the armed one, or the configured one when nothing is armed. */
    expression: string;
    /** True only when a timer is actually holding this schedule. */
    scheduled: boolean;
    /** ISO-8601 instant of the next tick, or null when nothing is armed. */
    next_fire_at: string | null;
}

export interface CronStartPayload {
    /** False when `config.SYNC.DISABLED` is set. */
    started: boolean;
    label: string;
    expression: string;
    /** ISO-8601 instant of the first scheduled tick, or null when nothing was scheduled. */
    next_fire_at: string | null;
}
