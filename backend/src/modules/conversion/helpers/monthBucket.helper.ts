'use strict';

/**
 * ============================================================================
 *  CALENDAR ARITHMETIC — one definition, for both trend endpoints
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, and — the one that matters — NO CLOCK. `as_of` is a
 *  parameter, so the same request produces the same buckets on a re-run, inside a test, and for a
 *  historical read.
 *
 *  ── WHY THIS IS A FILE AND NOT SIX LINES IN EACH SERVICE ────────────────────────────────────
 *
 *  Two endpoints publish a monthly series — the trial-cohort trend and the logo-churn movement —
 *  and both are plotted on the same kind of Recharts axis on two pages an operator reads side by
 *  side. Two independent month walkers is two chances to disagree about where a month starts, and
 *  the disagreement is invisible: both charts render perfectly, with the same labels, describing
 *  windows that are off by a day.
 *
 *  ── UTC, AND NOT THE SERVER'S ZONE ──────────────────────────────────────────────────────────
 *
 *  `Date.UTC` throughout, matching `shared/helpers/dateRange.helper`, which resolves every window in
 *  this codebase to UTC day boundaries. A month built in the process's local zone would shift the
 *  cohort boundary by the offset — so a subscription that started at 23:30 UTC on the 31st would
 *  fall into the following month for an operator hosting west of Greenwich and not for one hosting
 *  east of it. The stored data is UTC; the buckets are UTC.
 *
 *  ── THE BOUNDARIES ARE INCLUSIVE AND DISJOINT ───────────────────────────────────────────────
 *
 *  `end` is the last millisecond of the month, not the first instant of the next one. `foldTrialCohort`
 *  and every other window test in this module are `>= since && <= until`, so an upper bound of the
 *  next month's midnight puts a subscription that began at exactly that instant into TWO cohorts —
 *  and the months then sum to more than the population they partition.
 * ============================================================================
 */

import type { MonthBucket, MonthBucketInput } from '../types/monthBucket.types';

/** Milliseconds in a day. One literal, so no caller spells the conversion a second way. */
const _DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM`, UTC. One formatter, so a bucket's key and its label cannot be spelled two ways. */
const _monthKey = (at: Date): string => {
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
};

/**
 * The last `months` calendar months ending with the month `as_of` falls in, oldest first.
 *
 * THROWS on an invalid `as_of`, rather than defaulting to `new Date()`. A pure helper may not read
 * the clock, and a substituted "now" would make a historical read answer for today's months without
 * saying so. Callers validate the judgement instant ONCE, at the service's entry, exactly as
 * `resolveChargeCohortForDomains` requires — so this can never fire mid-request.
 *
 * A `months` below 1 yields an empty list rather than throwing: the count arrives from a query bag,
 * where a typo is a typo and not something worth refusing a whole page of data over. The caller
 * clamps it before calling and warns about what it clamped.
 *
 * @param params0 - The judgement instant and how many months to walk back.
 * @param params0.as_of - The instant the newest bucket is clamped to.
 * @param params0.months - How many months, already clamped by the caller.
 * @returns The buckets, OLDEST FIRST — the order a chart's x-axis reads in.
 */
const buildMonthBuckets = ({ as_of, months }: MonthBucketInput): MonthBucket[] => {
    if (!(as_of instanceof Date) || Number.isNaN(as_of.getTime())) {
        throw new TypeError('buildMonthBuckets requires a valid `as_of` Date — there is no default judgement instant.');
    }

    const count = Number.isFinite(months) ? Math.floor(months) : 0;
    if (count < 1) {
        return [];
    }

    const asOfMs = as_of.getTime();
    const year = as_of.getUTCFullYear();
    const month = as_of.getUTCMonth();

    const buckets: MonthBucket[] = [];
    for (let back = count - 1; back >= 0; back -= 1) {
        // `Date.UTC` normalises an out-of-range month index on its own, so December of the previous
        // year is `month - 1` with no wrap-around arithmetic to get wrong.
        const start = new Date(Date.UTC(year, month - back, 1));
        const nextStart = new Date(Date.UTC(year, month - back + 1, 1));
        // The month's own last millisecond. `nextStart - 1` rather than "the 28th/30th/31st at
        // 23:59:59.999", so February, a leap year and a DST-free UTC month all fall out of the same
        // expression instead of a table someone has to maintain.
        const monthEnd = new Date(nextStart.getTime() - 1);

        const isPartial = monthEnd.getTime() > asOfMs;
        buckets.push({
            month: _monthKey(start),
            start,
            // CLAMPED to the judgement instant. An unclamped bound on the current month evaluates
            // membership at a date in the future, which reports a state nobody has reached yet.
            end: isPartial ? as_of : monthEnd,
            month_end: monthEnd,
            is_partial: isPartial
        });
    }

    return buckets;
};

/**
 * Whole days from `from` to `to`, floored, never negative.
 *
 * ⚠️ IT ALWAYS RETURNS A NUMBER, and both callers depend on that for a reason that has nothing to do
 * with arithmetic:
 *
 *   - the trend's `cohort_aged_days` feeds the page's `is_aging: r.cohort_aged_days < 90`, and
 *     `null < 90` is TRUE in JavaScript — so a missing value badges a month "still aging", a claim
 *     about the cohort assembled out of an absent field;
 *   - logo churn's `paid_days` is printed as `` `${r.paid_days} days` `` with no guard at all, so a
 *     null renders the literal text "null days".
 *
 * An unusable date therefore yields `0` rather than `null`. That is safe HERE and nowhere else in
 * this codebase: both inputs are dates the caller has already constructed or validated, so the
 * fallback is unreachable rather than a quiet substitution for a measurement.
 *
 * CLAMPED AT ZERO. A negative span means the two instants crossed — a clock-skew or corrupted-row
 * condition — and "-4 days" printed in a duration column reads as a rendering fault rather than as
 * the data problem it is. The caller counts and reports the crossing; this returns the honest floor.
 *
 * @param from - The earlier instant.
 * @param to - The later instant.
 * @returns Whole days between them, `0` when they cross or either is unusable.
 */
const wholeDaysBetween = (from: Date, to: Date): number => {
    if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
        return 0;
    }
    if (!(to instanceof Date) || Number.isNaN(to.getTime())) {
        return 0;
    }
    const span = to.getTime() - from.getTime();
    if (span <= 0) {
        return 0;
    }
    return Math.floor(span / _DAY_MS);
};

export = {
    buildMonthBuckets,
    wholeDaysBetween
};
