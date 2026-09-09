/**
 * Shapes for `helpers/monthBucket.helper` — the calendar months both trend endpoints walk.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 */

/**
 * One calendar month, in UTC, with the two instants a fold compares against.
 *
 * ⚠️ `start` and `end` are INCLUSIVE and DISJOINT between consecutive buckets: `end` is one
 * millisecond before the next month's `start`. Using the next month's first instant as this month's
 * upper bound would place a subscription that began at exactly midnight on the 1st into two
 * consecutive cohorts, and the two months would then sum to more than the population.
 */
export interface MonthBucket {
    /** `YYYY-MM`, UTC. The x-axis label, and the key a caller files a month's answer under. */
    month: string;
    /** First instant of the calendar month, UTC. */
    start: Date;
    /**
     * Last instant this bucket covers — the calendar month's own final millisecond, or `as_of` when
     * the month has not finished yet.
     *
     * CLAMPED, because an unclamped upper bound on the current month would evaluate membership at a
     * date in the future: every predicate downstream compares against it, and a boundary later than
     * the judgement instant reports a state nobody has reached.
     */
    end: Date;
    /** The calendar month's own final millisecond, UNCLAMPED. Kept so `end` can be seen as clamped. */
    month_end: Date;
    /** True when `end` was clamped — i.e. this month is still running and its counts are partial. */
    is_partial: boolean;
}

/** Input to `buildMonthBuckets`. */
export interface MonthBucketInput {
    /** The judgement instant. The newest bucket is the calendar month this falls in. */
    as_of: Date;
    /** How many months to return, oldest first. Clamped by the caller before it gets here. */
    months: number;
}
