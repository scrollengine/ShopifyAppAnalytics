/**
 * Input and result shapes for `helpers/installTrend.helper` — the install-series fold.
 *
 * Declarations only — every import is `import type`, so this file is erased at compile time. These
 * are IN-MEMORY structures: nothing here reaches the wire except through
 * {@link PartnerAppTrendPoint}, which the services copy across unchanged.
 */

import type { PartnerAppTrendGrain, PartnerAppTrendPoint } from './partnerAppRead.types';

/**
 * One calendar bucket the series plots a point for.
 *
 * ⚠️ `start` IS THE EFFECTIVE START — already clamped to the requested window's lower bound by the
 * bucket builder, because that is the instant measurability is decided at. A month bucket whose
 * calendar start precedes the window is measurable if the WINDOW's opening is above the coverage
 * floor, not if the 1st of that month was.
 */
export interface InstallTrendBucket {
    /** `YYYY-MM-DD` at day grain, `YYYY-MM` at month grain. Matches the aggregate's own key. */
    key: string;
    /** First instant this bucket counts, clamped to the window's opening. */
    start: Date;
    /** Last instant this bucket counts, clamped to the window's close. */
    end: Date;
    /** True when the bucket is only partly inside the window — see the wire type's note. */
    is_partial: boolean;
}

/**
 * One `(bucket, event_type)` tally as the aggregate returns it.
 *
 * The bucket key is built INSIDE the pipeline with `$dateToString` on UTC, so the value a row is
 * grouped by and the label it is filed under are one expression. Computing the label in JavaScript
 * afterwards is how a boundary comes to be UTC on one side and local on the other.
 */
export interface RelationshipBucketCount {
    bucket: string;
    event_type: string;
    count: number;
    /** Of those, how many carried a blank `shop_domain` and so join to no store. */
    shopless: number;
}

/** Every input is DATA — this fold does no I/O and reads no clock. */
export interface InstallTrendInput {
    /** The buckets to plot, OLDEST FIRST — the order a chart's x-axis reads in. */
    buckets: readonly InstallTrendBucket[];
    /** The tallies, in any order. Rows matching no bucket are counted, never silently dropped. */
    counts: readonly RelationshipBucketCount[];
    /**
     * True when the stored record is known to be COMPLETE — a LIFETIME sync has completed, so the
     * pull reached back past 2009 and a bucket with no rows genuinely had no events.
     *
     *  THIS IS THE ONLY THING THAT LICENSES A ZERO. It is a separate parameter from
     * `coverage_floor` because `null` there has to be able to mean "no floor has ever been
     * measured", which is the OPPOSITE of complete: an app that has only run INCREMENTAL syncs and
     * holds no events at all knows nothing about any window. Collapsing the two onto one nullable
     * date published zeros over exactly those deployments — the chart drew a flat line at the floor
     * for an app nobody had ever backfilled.
     */
    coverage_complete: boolean;
    /**
     * The oldest row actually held, below which nothing was fetched — or `null` when no floor has
     * been measured at all.
     *
     * ⚠️ READ IT WITH `coverage_complete`, NEVER ALONE. `null` here with `coverage_complete: false`
     * means NOTHING is measurable, not that everything is.
     */
    coverage_floor: Date | null;
    /** The sentence an unmeasurable bucket carries. The caller words it; the fold only attaches it. */
    unknown_reason: string;
}

/** The four relationship totals over every tally handed in. Always numbers — the caller decides null. */
export interface InstallTrendTotals {
    installs: number;
    uninstalls: number;
    reinstalls: number;
    deactivations: number;
}

/** What `sumRelationshipCounts` answers: the four totals plus what they were summed from. */
export interface RelationshipTally {
    totals: InstallTrendTotals;
    /** Every relationship event the tallies represent. */
    counted_events: number;
    /** Of those, how many carried a blank `shop_domain` and so join to no store. */
    shopless_events: number;
}

/** What the fold answers. */
export interface InstallTrendResult {
    /** One point per bucket, in the order they were handed in. */
    points: PartnerAppTrendPoint[];
    /**
     * Sums over EVERY tally, including those whose bucket is unmeasurable or unplotted.
     *
     * ⚠️ NOT the sum of the plotted points. The window total is a fact about the rows in the window;
     * the chart is a fact about the buckets that fit on it. Deriving one from the other would make a
     * truncated chart silently shrink the KPI tile above it.
     */
    totals: InstallTrendTotals;
    /** Every relationship event the tallies represent — the denominator for the exclusions below. */
    counted_events: number;
    /** Of those, how many carried a blank `shop_domain`. Counted in the tiles; unjoinable to a store. */
    shopless_events: number;
    /** Buckets whose counts are null because they open below the coverage floor. */
    unmeasured_buckets: number;
    /**
     * Tallies whose bucket key matched no bucket handed in.
     *
     *  REPORTED, NEVER ZERO-CHECKED AWAY. It is reachable only when the caller truncated the
     * bucket list, and it is the number that says how many events fell off the front of the chart.
     * A non-zero value with no truncation is a boundary bug between the pipeline's `$dateToString`
     * and the bucket builder, and this is the only place it would ever be visible.
     */
    orphan_counts: number;
}

/**
 * What `resolvers/partnerAppRead.resolveTrendPlan` decided the series should be plotted over.
 *
 * Declared here rather than beside the resolver because a module ending in `export =` cannot also
 * export a type — TypeScript refuses the combination outright (TS2309).
 */
export interface TrendPlan {
    grain: PartnerAppTrendGrain;
    /** Oldest first, already truncated to the point ceiling. */
    buckets: InstallTrendBucket[];
    /** Buckets dropped by the ceiling. The OLDEST are dropped; the caller warns when non-zero. */
    withheld_buckets: number;
    /**
     * Where the series actually starts, which is NOT always the window's opening.
     *
     * An "All time" window has no opening to walk back from, so the series starts at the oldest
     * event actually held — the honest left edge, since below it there is nothing to plot whatever
     * the window says.
     */
    trend_since: Date;
}
