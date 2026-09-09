'use strict';

/**
 * ============================================================================
 *  DAYS-TO-FIRST-PAID  →  THE HISTOGRAM AND THE STRIP BENEATH IT
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, no clock. It is handed an array of whole days —
 *  one entry per store that ACTUALLY converted — and folds it. Every decision about which stores
 *  belong in that array is the service's, because that is where the exclusions can be counted and
 *  put into words.
 *
 *  ── ONE ARRAY, ONE PASS, ZEROS INCLUDED ─────────────────────────────────────────────────────
 *
 *  Every bucket in the vocabulary comes back, including the empty ones. `TimeToPaidHistogram.js:45`
 *  maps `data.buckets` verbatim, so a bucket omitted because its count was zero does not render as an
 *  empty bar — it VANISHES, and the histogram silently changes shape between two reads of the same
 *  app. A visible zero-height bar is the honest rendering of "nobody converted in this band".
 *
 *  ── ⚠️ `stats` IS `null` FOR AN EMPTY SET, NEVER A SET OF ZEROS ─────────────────────────────
 *
 *  `_fmtDays` (`:7-10`) prints an em dash for anything that is not a finite number and `${n}d` for
 *  anything that is — so a zeroed stats block renders "Median 0.0d · Mean 0.0d · P25 0.0d", which is
 *  a specific claim that every merchant converted the day they installed, made about a set with no
 *  members. The component already guards `stats ? … : null` (`:73`), so the null is drawn correctly.
 *
 *  ── THE PERCENTILE METHOD IS NAMED, NOT ASSUMED ─────────────────────────────────────────────
 *
 *  Linear interpolation between the two neighbouring order statistics — the R-7 / "inclusive"
 *  definition, which is what a spreadsheet's PERCENTILE and numpy's default both compute. Chosen
 *  because an operator WILL check one of these against a spreadsheet, and the nearest-rank
 *  alternative disagrees with that check on every even-sized sample: the median of a two-store app
 *  that converted on days 1 and 3 is 2 here and 1 under nearest-rank, and neither is wrong — but only
 *  one of them matches the number the reader already has.
 * ============================================================================
 */

import timeToPaidConstants = require('../constants/timeToPaid.constants');

import type { TimeToPaidBucketRow, TimeToPaidFold, TimeToPaidStats } from '../types/timeToPaid.types';

const { TIME_TO_PAID_BUCKETS } = timeToPaidConstants;

/**
 * The bucket a whole-day figure belongs to, or `null` when the vocabulary has no home for it.
 *
 * ⚠️ The `null` return is unreachable while the buckets stay contiguous from 0 with an open-ended
 * tail, and it exists anyway: the alternative to returning it is a silent `|| lastBucket`, which
 * would file a value the vocabulary cannot describe under a band it does not belong to. The caller
 * counts the misses instead, so a broken vocabulary shows up as a number rather than as a wrong bar.
 *
 * @param days - Whole days from install to first paid billing.
 * @returns The bucket key, or null when no bucket covers that value.
 */
const bucketKeyForDays = (days: number): string | null => {
    if (!Number.isFinite(days)) {
        return null;
    }
    for (const bucket of TIME_TO_PAID_BUCKETS) {
        if (days < bucket.min_days) {
            continue;
        }
        if (bucket.max_days === null || days <= bucket.max_days) {
            return bucket.key;
        }
    }
    return null;
};

/**
 * One percentile of an ALREADY-SORTED, non-empty array, by linear interpolation.
 *
 * @param sorted - Ascending, at least one entry.
 * @param p - The quantile in [0, 1].
 * @returns The interpolated value.
 */
const _percentile = (sorted: readonly number[], p: number): number => {
    if (sorted.length === 1) {
        return sorted[0];
    }
    const position = (sorted.length - 1) * p;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) {
        return sorted[lower];
    }
    return sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
};

/**
 * Folds the converted stores' day figures into the histogram and the stats strip.
 *
 * ⚠️ SORTS A COPY. The caller built the array while walking the install spine and may still be
 * tallying against it; an in-place sort would reorder data something else counted on. The same rule
 * every list read in this module follows.
 *
 * @param days - One whole-day figure per store that reached paid billing.
 * @returns Every bucket with its count, the stats or null, and the unbucketable count.
 */
const foldTimeToPaid = (days: readonly number[]): TimeToPaidFold => {
    const values: readonly number[] = Array.isArray(days) ? days : [];

    const counts = new Map<string, number>();
    for (const bucket of TIME_TO_PAID_BUCKETS) {
        // Pre-filled with zeros so the fold below can only ever INCREMENT — which is what makes
        // "every bucket comes back" a property of this line rather than of the loop after it.
        counts.set(bucket.key, 0);
    }

    let unbucketed = 0;
    const usable: number[] = [];
    for (const value of values) {
        const key = bucketKeyForDays(value);
        if (key === null) {
            unbucketed += 1;
            continue;
        }
        counts.set(key, (counts.get(key) || 0) + 1);
        usable.push(value);
    }

    const buckets: TimeToPaidBucketRow[] = TIME_TO_PAID_BUCKETS.map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        min_days: bucket.min_days,
        max_days: bucket.max_days,
        count: counts.get(bucket.key) || 0
    }));

    if (usable.length === 0) {
        //  `null`, never a zeroed block — see the file header.
        return { buckets, stats: null, unbucketed };
    }

    const sorted = [...usable].sort((a, b) => a - b);
    const total = sorted.reduce((sum, value) => sum + value, 0);

    const stats: TimeToPaidStats = {
        count: sorted.length,
        mean_days: total / sorted.length,
        median_days: _percentile(sorted, 0.5),
        p25_days: _percentile(sorted, 0.25),
        p75_days: _percentile(sorted, 0.75),
        min_days: sorted[0],
        max_days: sorted[sorted.length - 1]
    };

    return { buckets, stats, unbucketed };
};

export = {
    bucketKeyForDays,
    foldTimeToPaid
};
