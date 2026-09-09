'use strict';

/**
 * ============================================================================
 *  CRON — parsing and next-fire arithmetic
 * ============================================================================
 *
 *  PURE. No models, no config, no I/O, and — the one that matters here — NO
 *  CLOCK READ. `msUntilNextRun` takes `now` as an argument rather than calling
 *  `Date.now()`, which is what makes the awkward cases testable at all: the
 *  tick that fires at exactly the scheduled millisecond, the weekly job whose
 *  day is today but whose time has passed, the run that lands on a leap day.
 *  A helper that reads the clock can only be tested by waiting.
 *
 *  ── The supported subset, and why it is this small ──────────────────────────
 *  Two forms:
 *      "m h * * *"    daily at a fixed UTC time      e.g. "0 3 * * *"
 *      "m h * * dow"  weekly at a fixed UTC time     e.g. "0 8 * * 1"  (Monday)
 *
 *  Step expressions, ranges (`1-5`), lists (`1,3,5`) and day-of-month values are
 *  REJECTED, not approximated. This module schedules with `setTimeout` rather
 *  than running a real cron engine, and a scheduler that quietly reinterprets
 *  an expression it does not understand fires at a time nobody asked for —
 *  which surfaces months later as "the data looks a day stale sometimes".
 *  Refusing is the honest answer, and `syncCronScheduler` turns the refusal
 *  into a boot failure so it is found at deploy time.
 *
 *  Everything is UTC. A local-time schedule would silently shift twice a year
 *  in any zone that observes daylight saving, which for a daily data pull means
 *  one day with two runs and one with none.
 * ============================================================================
 */

import type { ParsedDailyCron } from '../types/cron.types';

/** Field count in a standard five-field cron expression. */
const CRON_FIELD_COUNT = 5;

const MINUTE_MIN = 0;
const MINUTE_MAX = 59;
const HOUR_MIN = 0;
const HOUR_MAX = 23;
const DOW_MIN = 0;
const DOW_MAX = 6;

/** Days scanned before the weekly search gives up. Seven candidates cover every day of the week. */
const WEEKLY_SEARCH_LIMIT = 8;

/**
 * Parses one field as an integer within an inclusive range.
 *
 * Stricter than `parseInt`, deliberately: `parseInt('3x', 10)` is `3`, and `parseInt('1-5', 10)` is
 * `1`. Both would turn a range expression into a plausible fixed time — the exact silent
 * reinterpretation this module refuses. The full-match test is what rejects them.
 *
 * @param raw - The raw field text.
 * @param min - Lowest accepted value, inclusive.
 * @param max - Highest accepted value, inclusive.
 * @returns The parsed value, or null when the field is not a bare in-range integer.
 */
const _parseField = (raw: string, min: number, max: number): number | null => {
    if (!/^\d{1,2}$/.test(raw)) {
        return null;
    }
    const value = parseInt(raw, 10);
    if (!Number.isInteger(value) || value < min || value > max) {
        return null;
    }
    return value;
};

/**
 * Parses a cron expression from the supported subset.
 *
 * Returns null — never a partial or guessed result — for anything outside it. The caller decides
 * what a refusal means; `syncCronScheduler` treats it as fatal at boot.
 *
 * @param expression - A five-field cron expression, e.g. '0 3 * * *' or '0 8 * * 1'.
 * @returns The parsed schedule, or null if the expression is not supported.
 */
const parseDailyCron = (expression: string): ParsedDailyCron | null => {
    if (!expression || typeof expression !== 'string') {
        return null;
    }

    const parts = expression.trim().split(/\s+/);
    if (parts.length !== CRON_FIELD_COUNT) {
        return null;
    }

    const [minuteField, hourField, domField, monthField, dowField] = parts;

    // Day-of-month and month must be wildcards. A schedule pinned to the 1st of the month is a
    // legitimate thing to want, and this module simply cannot express it — so it says so.
    if (domField !== '*' || monthField !== '*') {
        return null;
    }

    const minute = _parseField(minuteField, MINUTE_MIN, MINUTE_MAX);
    if (minute === null) {
        return null;
    }

    const hour = _parseField(hourField, HOUR_MIN, HOUR_MAX);
    if (hour === null) {
        return null;
    }

    let dow: number | null = null;
    if (dowField !== '*') {
        const parsedDow = _parseField(dowField, DOW_MIN, DOW_MAX);
        if (parsedDow === null) {
            return null;
        }
        dow = parsedDow;
    }

    return {
        hour: hour,
        minute: minute,
        dow: dow,
        expression: expression.trim()
    };
};

/**
 * Milliseconds from `now` until the next occurrence of a parsed schedule.
 *
 *  STRICTLY POSITIVE, always. The boundary case is the one that matters: when a tick fires
 * exactly on time and immediately reschedules, `now` IS the scheduled instant. Treating that as
 * "zero milliseconds away" schedules a second run in the same millisecond, and the two keep
 * re-triggering each other — a daily job becomes a hot loop. Hence `<=` rather than `<` when
 * deciding to advance to the next occurrence.
 *
 * The result is bounded by seven days, comfortably under the ~24.8-day ceiling on a `setTimeout`
 * delay, so no caller has to chunk the wait.
 *
 * @param parsed - A schedule from `parseDailyCron`.
 * @param now - The instant to measure from. Passed in, never read from the clock, so this function is deterministic.
 * @returns Milliseconds until the next fire. Always > 0.
 */
const msUntilNextRun = (parsed: ParsedDailyCron, now: Date): number => {
    const nowMs = now.getTime();

    // Today's occurrence, in UTC. Constructed from the calendar date rather than by mutating `now`,
    // so a caller's Date is never modified.
    const next = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        parsed.hour,
        parsed.minute,
        0,
        0
    ));

    if (parsed.dow === null) {
        if (next.getTime() <= nowMs) {
            next.setUTCDate(next.getUTCDate() + 1);
        }
        return next.getTime() - nowMs;
    }

    // Weekly: walk forward day by day to the next matching day-of-week that is still in the future.
    // Day-by-day rather than arithmetic on the day index because `setUTCDate` handles month and
    // year rollover — including leap days — and an off-by-one in that arithmetic would be a bug
    // that only appears at the end of certain months.
    let scanned = 0;
    while (scanned < WEEKLY_SEARCH_LIMIT && (next.getUTCDay() !== parsed.dow || next.getTime() <= nowMs)) {
        next.setUTCDate(next.getUTCDate() + 1);
        scanned += 1;
    }

    return next.getTime() - nowMs;
};

export = {
    parseDailyCron,
    msUntilNextRun
};
