/**
 * Shapes for `helpers/weekBucket.helper` — the weekly sibling of `monthBucket.types`.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 */

/** One ISO week, in UTC, as the cohort grid reads it. */
export interface WeekBucket {
    /** `YYYY-MM-DD` of the week's Monday, UTC. The row key AND the label the page formats. */
    week: string;
    /** First instant of the week. */
    start: Date;
    /**
     * Last instant of the week, CLAMPED to the judgement instant. An unclamped bound on the current
     * week evaluates membership at a date in the future.
     */
    end: Date;
    /** The week's own last millisecond, unclamped. What `is_partial` is decided against. */
    week_end: Date;
    /** True when the week has not finished yet as of the judgement instant. */
    is_partial: boolean;
}

/** Input to `buildWeekBuckets`. */
export interface WeekBucketInput {
    /** The judgement instant. The newest bucket is the week this falls in. */
    as_of: Date;
    /** How many weeks to walk back, already clamped by the caller. */
    weeks: number;
}
