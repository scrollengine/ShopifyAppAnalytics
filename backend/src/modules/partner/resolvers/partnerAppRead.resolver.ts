'use strict';

/**
 * ============================================================================
 *  WHAT MAY BE PUBLISHED, AND WHAT THE CHART IS ALLOWED TO PLOT
 * ============================================================================
 *
 *  Takes the app row's ALREADY-FETCHED coverage gates plus a resolved window
 *  and answers two questions the KPI read and the event read must answer
 *  identically:
 *
 *    1. Which blocks of the payload are measurable at all?
 *    2. What buckets should the install series be plotted over?
 *
 *  PURE. No repositories, no config, no clock — every input is data. That is
 *  what lets the whole gate be exercised against six field values with no
 *  database, and it is why this is a resolver rather than six lines copied into
 *  each service. Two services deciding independently whether a `0` may be
 *  published is two chances for one of them to say yes.
 *
 *  ──  THE ONE RULE THIS FILE EXISTS FOR ───────────────────────────────────
 *
 *  A figure may be published as `0` only when the record it was folded from is
 *  known to be COMPLETE over the window asked about. There are exactly two ways
 *  to know that:
 *
 *    a. A LIFETIME sync has completed. The pull reached back past 2009, so the
 *       record starts before the app existed and there is no floor at all.
 *    b. No lifetime sync has completed, but the window opens at or above the
 *       oldest row actually held — `earliest_event_at` / `earliest_transaction_at`.
 *
 *  Everything else is `null`. In particular an "All time" window on an app that
 *  has only ever run INCREMENTAL syncs is NOT measurable, however many rows the
 *  collections hold: what is missing is precisely the part nobody fetched, and
 *  its size is unknowable from the stored data.
 *
 *  ── ⚠️ NO FLOOR AT ALL IS `false`, NOT `true` ──────────────────────────────
 *
 *  A completed sync that measured NO earliest event means the collection is
 *  empty. Without a lifetime sync there is no way to tell "this app has never
 *  been installed" from "the incremental window we pulled happened to be quiet"
 *  — the window the sync covered is not stored anywhere. So the gate closes.
 *  In practice this branch is rare: `AUTO` mode resolves to LIFETIME precisely
 *  while `lifetime_sync_completed_at` is null, so a fresh app's very first sync
 *  sets it. Reaching here means an operator forced INCREMENTAL on an app that
 *  has never been backfilled, which is exactly when a zero would be a lie.
 * ============================================================================
 */

import constants = require('../constants/partnerAppRead.constants');
import installTrendHelper = require('../helpers/installTrend.helper');

import type { TrendPlan } from '../types/installTrend.types';
import type { PartnerAppReadCoverage, PartnerAppTrendGrain } from '../types/partnerAppRead.types';

const { TREND_DAY_GRAIN_MAX_DAYS, LIFETIME_TREND_FALLBACK_DAYS, MAX_TREND_POINTS, TREND_GRAINS } = constants;
const { buildDayBuckets, buildMonthTrendBuckets } = installTrendHelper;

/** Milliseconds in a day. One literal, so no branch spells the conversion a second way. */
const _DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A usable Date, or null.
 *
 * Guards every gate below against an `Invalid Date`, which compares false in every direction and
 * would silently fold a perfectly well covered window to "not measurable" with no reason given.
 *
 * @param value - Anything off a lean document.
 * @returns The instant, or null when it could not be read.
 */
const _date = (value: unknown): Date | null => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value;
    }
    return null;
};

/**
 * Decides whether a window's figures may be published as numbers.
 *
 * See the file header for the whole argument. In one line: complete record ⇒ yes; otherwise the
 * window must open at or above the oldest row held.
 *
 * @param since - The window's opening, or null for an all-time window.
 * @param floor - The oldest row held of this kind, or null when none is.
 * @param lifetimeDone - True once a LIFETIME sync has completed.
 * @returns True when a `0` in this window would be a measurement rather than a guess.
 */
const _windowMeasurable = (since: Date | null, floor: Date | null, lifetimeDone: boolean): boolean => {
    if (lifetimeDone) {
        return true;
    }
    if (!floor) {
        return false;
    }
    if (!since) {
        return false;
    }
    return since.getTime() >= floor.getTime();
};

/**
 * Turns the app row's coverage gates into the published `coverage` block plus the three booleans
 * every figure on these endpoints is gated by.
 *
 * @param params0 - The gates as stored, plus the window's opening.
 * @param params0.last_synced_at - Stamped only by a fully successful sync.
 * @param params0.lifetime_sync_completed_at - Stamped only by a completed LIFETIME sync.
 * @param params0.earliest_event_at - Oldest event held, or null.
 * @param params0.earliest_transaction_at - Oldest payout held, or null.
 * @param params0.since - The window's opening, or null for an all-time window.
 * @returns The wire block, with the three gates already decided.
 */
const resolveReadCoverage = ({ last_synced_at, lifetime_sync_completed_at, earliest_event_at, earliest_transaction_at, since }: {
    last_synced_at?: unknown;
    lifetime_sync_completed_at?: unknown;
    earliest_event_at?: unknown;
    earliest_transaction_at?: unknown;
    since: Date | null;
}): PartnerAppReadCoverage => {
    const lastSyncedAt = _date(last_synced_at);
    const lifetimeAt = _date(lifetime_sync_completed_at);
    const earliestEventAt = _date(earliest_event_at);
    const earliestTransactionAt = _date(earliest_transaction_at);
    const lifetimeDone = !!lifetimeAt;

    //  `null` HERE MEANS COMPLETE, NOT UNKNOWN. It is the value `foldInstallTrend` reads to decide
    // whether a bucket with no rows is a measured zero, so it is set to null ONLY on the lifetime
    // branch — never because a gate happened to be missing.
    const eventFloor = lifetimeDone ? null : earliestEventAt;
    const transactionFloor = lifetimeDone ? null : earliestTransactionAt;

    return {
        last_synced_at: lastSyncedAt,
        lifetime_sync_completed_at: lifetimeAt,
        earliest_event_at: earliestEventAt,
        earliest_transaction_at: earliestTransactionAt,
        event_floor: eventFloor,
        transaction_floor: transactionFloor,
        counts_measurable: _windowMeasurable(since, eventFloor, lifetimeDone),
        revenue_measurable: _windowMeasurable(since, transactionFloor, lifetimeDone),
        // The gate on every `all_time` figure, and the only one that ignores the window entirely.
        // `models/partner/partnerApp.model` states the rule on the field itself: until it is set,
        // "every LIFETIME figure — total installs ever, all-time revenue, any cohort that reaches
        // back before the first sync — is a FLOOR, not a total", and a figure that depends on
        // complete history must report that rather than publishing a partial sum under a total's
        // label. A card headed "All-time" over a 90-day incremental pull IS that label.
        all_time_measurable: lifetimeDone
    };
};

/**
 * Chooses the series' grain and builds its buckets.
 *
 * ── THE GRAIN IS DECIDED BY THE WINDOW, NEVER BY THE CALLER ──
 * `InstallTrendChart` renders one point per array entry with `dot={false}` and no downsampling, so
 * a multi-year window at day grain is thousands of points crushed into 280 pixels — a solid block of
 * ink that reads as noise rather than as data. Above `TREND_DAY_GRAIN_MAX_DAYS` the series switches
 * to calendar months, and the payload says which grain it used so nobody has to infer it from the
 * label format.
 *
 * ── AN "ALL TIME" WINDOW STILL NEEDS A LEFT EDGE ──
 * There is no lower bound to walk back from, so the series starts at the oldest event actually held.
 * That is the honest left edge: below it there is nothing to plot, whatever the window says. When
 * even that is unmeasured the fallback span is used — see `LIFETIME_TREND_FALLBACK_DAYS`, which is
 * reachable only when the collection is empty and therefore cannot affect a count.
 *
 * ── THE CEILING KEEPS THE NEWEST BUCKETS, AND SAYS SO ──
 * A silently truncated chart is a chart that lies about where its history starts. The caller turns
 * `withheld_buckets` into a warning, exactly as the revenue trend does.
 *
 * @param params0 - The window and the event floor.
 * @param params0.since - The window's opening, or null for an all-time window.
 * @param params0.until - The window's close.
 * @param params0.earliest_event_at - Oldest event held, used as the all-time left edge.
 * @returns Grain, buckets, what was withheld, and where the series starts.
 */
const resolveTrendPlan = ({ since, until, earliest_event_at }: {
    since: Date | null;
    until: Date;
    earliest_event_at: Date | null;
}): TrendPlan => {
    if (!(until instanceof Date) || Number.isNaN(until.getTime())) {
        throw new TypeError('resolveTrendPlan requires a valid `until` Date — there is no default window close.');
    }

    let trendSince = since;
    if (!trendSince) {
        trendSince = earliest_event_at || new Date(until.getTime() - (LIFETIME_TREND_FALLBACK_DAYS * _DAY_MS));
    }
    // An `earliest_event_at` later than the window's close — clock skew, or a window that closes in
    // the past — would otherwise produce a backwards range and an empty chart with no explanation.
    if (trendSince.getTime() > until.getTime()) {
        trendSince = until;
    }

    const spanDays = (until.getTime() - trendSince.getTime()) / _DAY_MS;
    const grain: PartnerAppTrendGrain = spanDays <= TREND_DAY_GRAIN_MAX_DAYS ? TREND_GRAINS.DAY : TREND_GRAINS.MONTH;

    const all = grain === TREND_GRAINS.DAY
        ? buildDayBuckets({ since: trendSince, until })
        : buildMonthTrendBuckets({ since: trendSince, until });

    if (all.length <= MAX_TREND_POINTS) {
        return { grain, buckets: all, withheld_buckets: 0, trend_since: trendSince };
    }
    return {
        grain,
        // `slice(-N)` keeps the NEWEST. The oldest history is the part a reader is least likely to be
        // asking about and the part the coverage gates are least able to vouch for.
        buckets: all.slice(-MAX_TREND_POINTS),
        withheld_buckets: all.length - MAX_TREND_POINTS,
        trend_since: trendSince
    };
};

export = {
    resolveReadCoverage,
    resolveTrendPlan
};
