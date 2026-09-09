'use strict';

/**
 * ============================================================================
 *  THE INSTALL SERIES — one fold, two grains, two endpoints
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, and — the one that matters —
 *  NO CLOCK. Every boundary is a parameter, so the same request produces the
 *  same buckets on a re-run, inside a test, and for a historical read.
 *
 *  ── WHY THIS IS A FILE AND NOT SIX LINES IN EACH SERVICE ───────────────────
 *
 *  Two endpoints publish this series — `GET /api/partner-apps/:id/kpi` (the
 *  chart on the Partner Apps page) and `GET /api/partner-apps/:id/events` (the
 *  same chart beside the raw event table). Two independent bucket walkers is
 *  two chances to disagree about where a month starts, and the disagreement is
 *  invisible: both charts render perfectly, with the same labels, describing
 *  windows that are off by a day. `modules/conversion/helpers/monthBucket.helper`
 *  exists for exactly this reason and its month walker is REUSED below rather
 *  than restated.
 *
 *  ──  A BUCKET WITH NO MEASURABLE VALUE PUBLISHES `null`, NEVER `0` ───────
 *
 *  This is the whole point of the file. `InstallTrendChart` plots with Recharts'
 *  default `connectNulls={false}`, so a null BREAKS the line — the honest
 *  rendering of "we hold no records for this stretch". A `0` draws the line
 *  along the floor and asserts that nobody installed the app that month, which
 *  is a claim about the merchant's business manufactured out of an absence of
 *  data. The two are one keystroke apart in the source and worlds apart on the
 *  screen.
 *
 *  A bucket is measurable when the record is COMPLETE, or when it opens AT OR
 *  ABOVE the coverage floor. A bucket that straddles the floor is NOT: half a
 *  month of records plotted as a whole month is a dip that looks like churn and
 *  is really the edge of the sync window.
 *
 *   COMPLETENESS AND THE FLOOR ARE TWO PARAMETERS, NOT ONE NULLABLE DATE.
 *  "No floor" is ambiguous on its own: it means EVERYTHING is measurable after
 *  a lifetime sync, and NOTHING is measurable on an app that has only run
 *  incremental syncs and holds no events yet. Reading one nullable date for
 *  both published a flat line at zero for precisely the second case — an app
 *  nobody had backfilled, drawn as an app nobody had installed.
 *
 *  ── UTC, AND NOT THE SERVER'S ZONE ─────────────────────────────────────────
 *
 *  `Date.UTC` throughout, matching `shared/helpers/dateRange.helper` and the
 *  `$dateToString: { timezone: 'UTC' }` in the aggregate that produces the
 *  tallies. The bucket key a row is grouped by and the key it is looked up
 *  under have to be built the same way; a boundary that is UTC on one side and
 *  local on the other silently files every event near midnight into the
 *  neighbouring bucket.
 * ============================================================================
 */

//  DEEP PATH TO A PURE LEAF, NOT THROUGH `modules/conversion`'s BARREL. The barrel form eagerly
// loads every service in that module — each of which reaches the model registry — and is how a cycle
// gets invented between two files that have no edge between them at all; `repositories/revenue
// .repository` documents the fifteen tests that failure cost when it happened. `monthBucket.helper`
// imports only its own type declarations, so it has no edge back to anything and cannot close a loop.
//
// The REUSE the barrel exists to enforce is fully preserved: this is the one month walker in the
// codebase, and a second one here would be a second answer to "where does a month start".
import monthBucketHelper = require('../../conversion/helpers/monthBucket.helper');
import constants = require('../constants/partnerAppRead.constants');

import type {
    InstallTrendBucket,
    InstallTrendInput,
    InstallTrendResult,
    InstallTrendTotals,
    RelationshipBucketCount,
    RelationshipTally
} from '../types/installTrend.types';
import type { PartnerAppTrendPoint } from '../types/partnerAppRead.types';

const { buildMonthBuckets } = monthBucketHelper;
const { RELATIONSHIP_COUNT_KEYS } = constants;

/** Milliseconds in a day. One literal, so no branch spells the conversion a second way. */
const _DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD`, UTC. Must match the aggregate's `$dateToString: { format: '%Y-%m-%d' }` exactly. */
const _dayKey = (at: Date): string => {
    const _year = at.getUTCFullYear();
    const _month = String(at.getUTCMonth() + 1).padStart(2, '0');
    const _day = String(at.getUTCDate()).padStart(2, '0');
    return `${_year}-${_month}-${_day}`;
};

/**
 * Rejects a boundary that is not a usable Date.
 *
 * THROWS rather than substituting `new Date()`. A pure helper may not read the clock, and a
 * substituted "now" would make a historical read answer for today without saying so. Callers
 * validate the window ONCE, at the service's entry, so this can never fire mid-request.
 *
 * @param value - The candidate boundary.
 * @param name - Which parameter it is, for the message.
 * @returns The same Date, once proven usable.
 */
const _requireDate = (value: unknown, name: string): Date => {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new TypeError(`installTrend: \`${name}\` must be a valid Date — there is no default boundary.`);
    }
    return value;
};

/**
 * One bucket per UTC DAY across `[since, until]`, oldest first.
 *
 * Both ends are CLAMPED to the window, and a bucket the window only partly covers is flagged. In
 * practice neither end is ever partial here — `shared/helpers/dateRange.helper` resolves every
 * window to a UTC start-of-day and end-of-day — but the flag is computed rather than assumed,
 * because a custom range that stops mid-day would otherwise plot a short day at full height.
 *
 * @param params0 - The window.
 * @param params0.since - Inclusive lower bound.
 * @param params0.until - Inclusive upper bound.
 * @returns The buckets, OLDEST FIRST. Empty when `until` precedes `since`.
 */
const buildDayBuckets = ({ since, until }: { since: Date; until: Date }): InstallTrendBucket[] => {
    const _since = _requireDate(since, 'since');
    const _until = _requireDate(until, 'until');
    if (_until.getTime() < _since.getTime()) {
        return [];
    }

    const buckets: InstallTrendBucket[] = [];
    let cursor = Date.UTC(_since.getUTCFullYear(), _since.getUTCMonth(), _since.getUTCDate());

    while (cursor <= _until.getTime()) {
        const dayStart = new Date(cursor);
        // The day's own last millisecond. `nextStart - 1` rather than "23:59:59.999", so the two
        // spellings of the same instant cannot drift apart.
        const dayEnd = new Date(cursor + _DAY_MS - 1);

        const startsBefore = dayStart.getTime() < _since.getTime();
        const endsAfter = dayEnd.getTime() > _until.getTime();
        buckets.push({
            key: _dayKey(dayStart),
            start: startsBefore ? _since : dayStart,
            end: endsAfter ? _until : dayEnd,
            is_partial: startsBefore || endsAfter
        });

        cursor += _DAY_MS;
    }

    return buckets;
};

/**
 * One bucket per CALENDAR MONTH across `[since, until]`, oldest first.
 *
 * The walk itself is `modules/conversion`'s `buildMonthBuckets` — the one month walker in this
 * codebase — called with `as_of: until` and the exact month count the window spans. This function
 * only re-clamps the OLDEST bucket to `since` and restates partiality in this module's vocabulary.
 *
 * ⚠️ THE FIRST AND LAST BUCKETS ARE ROUTINELY PARTIAL, and that is reported rather than smoothed
 * away. A 30-day window opening on the 12th plots a January bar built from nineteen days; widening
 * the aggregate to whole calendar months would make the chart describe a different period from the
 * KPI tiles printed above it, which is the worse of the two failures.
 *
 * @param params0 - The window.
 * @param params0.since - Inclusive lower bound.
 * @param params0.until - Inclusive upper bound.
 * @returns The buckets, OLDEST FIRST. Empty when `until` precedes `since`.
 */
const buildMonthTrendBuckets = ({ since, until }: { since: Date; until: Date }): InstallTrendBucket[] => {
    const _since = _requireDate(since, 'since');
    const _until = _requireDate(until, 'until');
    if (_until.getTime() < _since.getTime()) {
        return [];
    }

    const sinceIndex = (_since.getUTCFullYear() * 12) + _since.getUTCMonth();
    const untilIndex = (_until.getUTCFullYear() * 12) + _until.getUTCMonth();
    const months = (untilIndex - sinceIndex) + 1;

    return buildMonthBuckets({ as_of: _until, months }).map((bucket) => {
        const startsBefore = bucket.start.getTime() < _since.getTime();
        return {
            key: bucket.month,
            start: startsBefore ? _since : bucket.start,
            // `buildMonthBuckets` already clamps `end` to `as_of`, which IS `until` here.
            end: bucket.end,
            //  `is_partial` on that bucket means "the month has not finished yet"; this one also
            // covers "the window opened after the 1st". Both distort the bar the same way, so both
            // set the same flag rather than two the chart would have to reconcile.
            is_partial: startsBefore || bucket.is_partial
        };
    });
};

/** A fresh totals accumulator. One literal, so no branch can invent a partial one. */
const _emptyTotals = (): InstallTrendTotals => ({
    installs: 0,
    uninstalls: 0,
    reinstalls: 0,
    deactivations: 0
});

/**
 * Sums `(bucket, event_type)` tallies into the four relationship totals.
 *
 * ONE DEFINITION OF "how many installs is that", used by `foldInstallTrend` below for its window
 * totals AND by the KPI service for its all-time counts. Those two figures sit in adjacent cards on
 * the same screen and are read against each other, so a second reducer — even a five-line one — is a
 * second chance for "Installs" and "Total installs" to count different things.
 *
 * ⚠️ AN UNRECOGNISED `event_type` IS SKIPPED, NOT BUCKETED. Filing one under a neighbouring key
 * would inflate a published count, and the four relationship types are the only ones any caller's
 * `$in` can produce.
 *
 * @param counts - The tallies, in any order.
 * @returns The four totals, plus the events and exclusions behind them.
 */
const sumRelationshipCounts = (counts: readonly RelationshipBucketCount[]): RelationshipTally => {
    const totals = _emptyTotals();
    let countedEvents = 0;
    let shoplessEvents = 0;

    const rows = Array.isArray(counts) ? counts : [];
    for (const row of rows) {
        const countKey = RELATIONSHIP_COUNT_KEYS[row && row.event_type];
        if (!countKey) {
            continue;
        }
        const amount = Number.isFinite(row.count) ? row.count : 0;
        const shopless = Number.isFinite(row.shopless) ? row.shopless : 0;
        countedEvents += amount;
        shoplessEvents += shopless;
        totals[countKey as keyof InstallTrendTotals] += amount;
    }

    return { totals, counted_events: countedEvents, shopless_events: shoplessEvents };
};

/**
 * Folds `(bucket, event_type)` tallies into the published series.
 *
 * ONE PASS over the tallies, and the window totals are derived FROM THAT SAME PASS rather than
 * from a second query — so a tile and the chart beneath it can never disagree about the period they
 * describe. The totals include tallies whose bucket is unmeasurable or was truncated off the chart:
 * the window total is a fact about the rows in the window, the chart is a fact about the buckets
 * that fit on it, and deriving one from the other would make a truncated chart silently shrink the
 * number above it.
 *
 *  A BUCKET BELOW THE COVERAGE FLOOR PUBLISHES FOUR NULLS AND A REASON — never four zeros. See
 * the file header.
 *
 * @param input - Buckets, tallies, the coverage floor and the unknown sentence.
 * @param input.buckets - The buckets to plot, oldest first.
 * @param input.counts - The tallies, in any order.
 * @param input.coverage_floor - Below this nothing was fetched; `null` means complete.
 * @param input.unknown_reason - The sentence an unmeasurable bucket carries.
 * @returns The points, the window totals, and every exclusion, counted.
 */
const foldInstallTrend = (input: InstallTrendInput): InstallTrendResult => {
    const buckets = Array.isArray(input.buckets) ? input.buckets : [];
    const counts = Array.isArray(input.counts) ? input.counts : [];
    const complete = input.coverage_complete === true;
    const floor = input.coverage_floor instanceof Date && !Number.isNaN(input.coverage_floor.getTime())
        ? input.coverage_floor
        : null;

    // Per-bucket accumulators, keyed exactly as the aggregate keyed them.
    const byBucket = new Map<string, InstallTrendTotals>();
    for (const bucket of buckets) {
        byBucket.set(bucket.key, _emptyTotals());
    }

    //  THE WINDOW TOTALS COME FROM THE SHARED REDUCER, not from the per-bucket loop below, so the
    // tile above the chart and the "Total installs" tile beside it are literally the same function.
    // They are taken whether or not a bucket is plotted — see the header.
    const tally = sumRelationshipCounts(counts);

    let orphanCounts = 0;
    for (const row of counts) {
        const countKey = RELATIONSHIP_COUNT_KEYS[row && row.event_type];
        if (!countKey) {
            // Unreachable through the repository's `$in`, skipped rather than guessed at: filing an
            // unrecognised type under one of the four would inflate a published count.
            continue;
        }
        const amount = Number.isFinite(row.count) ? row.count : 0;

        const bucketTotals = byBucket.get(row.bucket);
        if (!bucketTotals) {
            orphanCounts += amount;
            continue;
        }
        bucketTotals[countKey as keyof InstallTrendTotals] += amount;
    }

    const points: PartnerAppTrendPoint[] = [];
    let unmeasuredBuckets = 0;

    for (const bucket of buckets) {
        //  `start` is the EFFECTIVE start — already clamped to the window's opening — so a month
        // bucket is judged by where the window opens rather than by the 1st of that month.
        //
        //  A MISSING FLOOR IS NOT A LICENCE TO PUBLISH ZEROS. Only `coverage_complete` is. See the
        // file header for the deployment this ordering exists to protect.
        const measurable = complete || (!!floor && bucket.start.getTime() >= floor.getTime());
        if (!measurable) {
            unmeasuredBuckets += 1;
            points.push({
                date: bucket.key,
                installs: null,
                uninstalls: null,
                reinstalls: null,
                deactivations: null,
                measurable: false,
                is_partial: bucket.is_partial,
                unknown_reason: input.unknown_reason
            });
            continue;
        }

        const bucketTotals = byBucket.get(bucket.key) || _emptyTotals();
        points.push({
            date: bucket.key,
            installs: bucketTotals.installs,
            uninstalls: bucketTotals.uninstalls,
            reinstalls: bucketTotals.reinstalls,
            deactivations: bucketTotals.deactivations,
            measurable: true,
            is_partial: bucket.is_partial
        });
    }

    return {
        points,
        totals: tally.totals,
        counted_events: tally.counted_events,
        shopless_events: tally.shopless_events,
        unmeasured_buckets: unmeasuredBuckets,
        orphan_counts: orphanCounts
    };
};

export = {
    buildDayBuckets,
    buildMonthTrendBuckets,
    sumRelationshipCounts,
    foldInstallTrend
};
