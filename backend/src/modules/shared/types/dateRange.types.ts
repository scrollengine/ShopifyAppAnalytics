/**
 * Input and result shapes for `shared/helpers/dateRange.helper`.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 * Every Growth-Intel service that supports time filtering resolves its window through the one
 * helper, so this is also the description of the `{ since, until, … }` tuple those services then
 * pass into a Mongo range query or a BigQuery `WHERE`.
 */

/** Which branch of the resolver produced a window. */
export type DateRangeKind = 'lifetime' | 'preset' | 'custom';

/**
 * The raw window as it arrives from the API layer.
 *
 * Everything is optional because the resolver is called with whatever the request happened to carry
 * — including nothing at all, which yields the 30-day default.
 */
export interface ResolveDateRangeInput {
    /** `'all'` / `0` for lifetime, otherwise a positive number of days back from now. */
    period_days?: string | number;
    /** ISO date `YYYY-MM-DD`. Only honoured when `until` parses too. */
    since?: string;
    /** ISO date `YYYY-MM-DD`. Only honoured when `since` parses too. */
    until?: string;
    /** Fallback window when `period_days` is absent or unparseable. */
    defaultPeriodDays?: number;
}

/** The resolved window. Boundaries are INCLUSIVE on both ends. */
export interface ResolvedDateRange {
    /** UTC start-of-day, or null for lifetime — the query must then omit its lower bound. */
    since: Date | null;
    /** UTC end-of-day. Always set; defaults to now. */
    until: Date;
    /** True when no lower bound applies. */
    isLifetime: boolean;
    /** Numeric days when preset, null when custom or lifetime. */
    periodDays: number | null;
    /** Human-readable label, e.g. "All time", "Last 30 days", "Jan 1 – Feb 14, 2026". */
    periodLabel: string;
    kind: DateRangeKind;
}
