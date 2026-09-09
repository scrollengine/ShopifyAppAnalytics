'use strict';

/**
 * ============================================================================
 *  WEEKLY CALENDAR ARITHMETIC — the sibling of `monthBucket.helper`
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, and — the one that matters — NO CLOCK. `as_of` is a
 *  parameter, so the same request produces the same cohorts on a re-run, inside a test, and for a
 *  historical read.
 *
 *  ── WHY A SECOND FILE AND NOT A SECOND FUNCTION IN `monthBucket.helper` ─────────────────────
 *
 *  That file's name is its contract — two endpoints publish a MONTHLY series and read their buckets
 *  from it — and a `buildWeekBuckets` sitting inside `monthBucket.helper.ts` is a file whose name
 *  stops describing it, which is how the next reader comes to look for week arithmetic somewhere
 *  else and writes a third copy. The two files share their RULES rather than their bodies, and the
 *  rules are restated below so the two cannot drift by accident.
 *
 *  ── THE THREE RULES, IDENTICAL TO THE MONTHLY ONE ───────────────────────────────────────────
 *
 *  1. UTC THROUGHOUT, matching `shared/helpers/dateRange.helper`, which resolves every window in
 *     this codebase to UTC day boundaries. A week built in the process's local zone would shift the
 *     cohort boundary by the host's offset — so a store that installed at 23:30 UTC on a Sunday would
 *     fall into different cohorts on two deployments of the same code, over the same data.
 *
 *  2. THE BOUNDARIES ARE INCLUSIVE AND DISJOINT. `week_end` is the LAST MILLISECOND of the week, not
 *     the first instant of the next one. Every window test in this module is `>= start && <= end`, so
 *     an upper bound of the next week's midnight would put a store that installed at exactly that
 *     instant into TWO cohorts — and the rows would then sum to more than the population they
 *     partition, which is the one property a cohort grid has to have.
 *
 *  3. THE NEWEST BUCKET'S `end` IS CLAMPED TO `as_of`. An unclamped bound on the current week
 *     evaluates membership at a date in the future, which reports a state nobody has reached yet.
 *     `week_end` keeps the unclamped instant beside it so `is_partial` is a fact rather than a guess.
 * ============================================================================
 */

import cohortRetentionConstants = require('../constants/cohortRetention.constants');

import type { WeekBucket, WeekBucketInput } from '../types/weekBucket.types';

const { COHORT_WEEK_START_DAY } = cohortRetentionConstants;

/** Milliseconds in a day and in a week. One literal each, so no caller spells the conversion twice. */
const _DAY_MS = 24 * 60 * 60 * 1000;
const _WEEK_MS = 7 * _DAY_MS;

/** `YYYY-MM-DD`, UTC. ONE formatter, so a bucket's key and its label cannot be spelled two ways. */
const _dayKey = (at: Date): string => {
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;
};

/**
 * The first instant of the week `at` falls in, in UTC.
 *
 * ⚠️ `(day - start + 7) % 7`, never `day - start`. `getUTCDay()` is 0 for Sunday, so with a Monday
 * week start the raw subtraction is `-1` for a Sunday — which would move the boundary FORWARD a day
 * and put every Sunday install into the week that had not started yet. The `+ 7` before the modulo is
 * what makes the answer the number of days SINCE the week opened, for every day of the week.
 *
 * @param at - Any instant.
 * @returns UTC midnight on the week's start day, at or before `at`.
 */
const startOfWeekUtc = (at: Date): Date => {
    const midnight = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const offsetDays = (midnight.getUTCDay() - COHORT_WEEK_START_DAY + 7) % 7;
    return new Date(midnight.getTime() - offsetDays * _DAY_MS);
};

/**
 * The last `weeks` weeks ending with the week `as_of` falls in, OLDEST FIRST.
 *
 * THROWS on an invalid `as_of` rather than defaulting to `new Date()`. A pure helper may not read the
 * clock, and a substituted "now" would make a historical read answer for this week's cohorts without
 * saying so. Callers validate the judgement instant ONCE, at the service's entry.
 *
 * A `weeks` below 1 yields an empty list rather than throwing: the count arrives from a query bag,
 * where a typo is a typo and not something worth refusing a whole page of data over. The caller
 * clamps it before calling and warns about what it clamped.
 *
 * @param params0 - The judgement instant and how many weeks to walk back.
 * @param params0.as_of - The instant the newest bucket is clamped to.
 * @param params0.weeks - How many weeks, already clamped by the caller.
 * @returns The buckets, OLDEST FIRST — the order the heatmap's rows read in.
 */
const buildWeekBuckets = ({ as_of, weeks }: WeekBucketInput): WeekBucket[] => {
    if (!(as_of instanceof Date) || Number.isNaN(as_of.getTime())) {
        throw new TypeError('buildWeekBuckets requires a valid `as_of` Date — there is no default judgement instant.');
    }

    const count = Number.isFinite(weeks) ? Math.floor(weeks) : 0;
    if (count < 1) {
        return [];
    }

    const asOfMs = as_of.getTime();
    const newestStart = startOfWeekUtc(as_of);

    const buckets: WeekBucket[] = [];
    for (let back = count - 1; back >= 0; back -= 1) {
        // Fixed-width arithmetic is correct HERE and would not be for months: a UTC week is always
        // exactly seven days, with no leap-year or short-month case to get wrong and no DST to trip
        // over. `monthBucket.helper` uses `Date.UTC(y, m - back, 1)` for precisely the opposite
        // reason.
        const start = new Date(newestStart.getTime() - back * _WEEK_MS);
        // The week's own last millisecond. `next - 1` rather than "Sunday at 23:59:59.999", so the
        // expression states the rule instead of restating the calendar.
        const weekEnd = new Date(start.getTime() + _WEEK_MS - 1);
        const isPartial = weekEnd.getTime() > asOfMs;

        buckets.push({
            week: _dayKey(start),
            start,
            end: isPartial ? as_of : weekEnd,
            week_end: weekEnd,
            is_partial: isPartial
        });
    }

    return buckets;
};

export = {
    startOfWeekUtc,
    buildWeekBuckets
};
