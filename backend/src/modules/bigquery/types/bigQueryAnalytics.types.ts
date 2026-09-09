/**
 * Input and result shapes for `bigquery/services/bigQueryAnalytics.service`.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 * These describe the READ side of the GA4 pipeline: the three daily rollups
 * (`gi_listing_funnel_dailies`, `gi_listing_source_dailies`, `gi_listing_geo_dailies`) as the
 * dashboard consumes them. None of them carries a shop identity — that lives only on
 * `ListingInstallAttributionDoc`, which this service never reads.
 *
 * ── The empty-payload rule ──────────────────────────────────────────────────
 * Four different things produce "nothing to show", and a reader must be able to tell them apart:
 *
 *   1. NOT CONNECTED  — no BigQuery credentials. The service resolves `status: false` and never
 *                       reaches these types at all; the message names the missing variable.
 *   2. NEVER SYNCED   — connected, but no sync has ever completed. `summary`/`items` are NULL, and
 *                       `data_state` says why. Null is a statement about our data; `[]` and `0` are
 *                       statements about the merchant's business, and we have not earned either.
 *   3. NO ROW IN WINDOW — synced, but the window's `$group` matched nothing and emitted no
 *                       document. `data_state` is `READY`, `summary` is NULL, `trend` is `[]`, and
 *                       `unknown_reason` carries `EMPTY_WINDOW_REASON`. See `docs/FIDELITY.md` §4:
 *                       "Returns `summary: null` — not a zeroed row … Preserve that null."
 *   4. GENUINELY EMPTY — synced, rows exist, and they really are zeros. `data_state` is `READY`,
 *                       `items` is `[]` or the counts are real zeros — and any RATE whose
 *                       denominator was one of those zeros is `null`, not `0`.
 *
 * Case 2 collapsing into case 4 is the exact bug this whole project exists to refuse, and the two
 * are one null watermark apart. Case 3 collapsing into case 4 is the SAME bug reached by a
 * different route, and it shipped: `bigQueryAnalytics.service` rebuilt the repository's null as a
 * zeroed row and derived five rates from it.
 */

import type { DateRangeKind } from '../../shared/types/dateRange.types';

/**
 * Whether the listing data behind a response has ever been pulled.
 *
 * Only two values, and both are reachable — a state nothing can write is a name a future reader
 * will assume means something. "Not connected" is deliberately absent: that path resolves
 * `status: false` and carries no payload to label.
 */
export type ListingDataState = 'NEVER_SYNCED' | 'READY';

/**
 * The window every endpoint here resolves, in the shape this service renames it to.
 *
 * ⚠️ Deliberately NOT `ResolvedDateRange`: the keys are renamed on the way out of
 * `resolveDateRange` (`isLifetime` → `is_lifetime`, `periodLabel` → `label`), because these values
 * are echoed straight back to the client alongside snake_case payload fields.
 */
export interface AnalyticsWindow {
    /** UTC start-of-day, or null for lifetime — the match clause then omits its lower bound. */
    since: Date | null;
    until: Date;
    is_lifetime: boolean;
    label: string;
    period_days: number | null;
    kind: DateRangeKind;
}

/** The `date` predicate built from a window. Empty (`{}`) for lifetime — no bound at all. */
export interface AnalyticsDateMatch {
    date?: {
        $gte?: Date;
        $lte?: Date;
    };
}

/** Fields common to all three endpoints' responses. Echoed so the client can label its own chart. */
export interface AnalyticsWindowEcho {
    app_id: string;
    is_lifetime: boolean;
    /** The literal string `'all'` for lifetime, else the numeric preset. */
    period_days: 'all' | number | null;
    period_label: string;
    since: Date | null;
    until: Date;
    kind: DateRangeKind;
    /** Watermark of the last BIGQUERY_SYNC — null until the first successful pull. */
    last_bq_synced_at?: Date | null;
    /** See {@link ListingDataState}. `NEVER_SYNCED` ⇒ the payload's figures are null, not zero. */
    data_state: ListingDataState;
    /**
     * Why there is no answer, in the reader's language.
     *
     * This is the text rendered in place of the numbers, so it says what is missing and what to do
     * about it rather than that something is missing.
     *
     * Set on `NEVER_SYNCED` (with `NEVER_SYNCED_REASON`), and — on `/api/funnel` only — on a
     * `READY` window whose rollup held no row (with `EMPTY_WINDOW_REASON`). ⚠️ THE TWO SENTENCES
     * ARE DIFFERENT AND MUST STAY DIFFERENT: one is fixed by running a sync, the other by moving
     * the date range, and an operator sent to re-run a job they already ran learns to stop reading
     * the banner. `data_state` remains the machine-readable discriminator; this field is the prose.
     */
    unknown_reason?: string;
}

// ── getFunnelData ───────────────────────────────────────────────────────────

/** The second parameter of `getFunnelData`. */
export interface GetFunnelDataInput {
    partner_app_id?: string;
    /** number, 0, or 'all' (default 30). */
    period_days?: number | string;
    /** ISO date `YYYY-MM-DD`. Only honoured together with `until`. */
    since?: string;
    /** ISO date `YYYY-MM-DD`. Only honoured together with `since`. */
    until?: string;
}

/**
 * Window totals plus the derived rates.
 *
 * The counts are summed by an aggregate, so they arrive untyped and are spread in wholesale — the
 * rates below them are the only fields this service computes itself.
 *
 * EVERY RATE IS `number | null`, AND THE NULL IS LOAD-BEARING. They are produced by
 * `funnelMath.helper`'s `rate()`, which answers `null` for an absent denominator: `installs / 0
 * views` is not "0% converted", and "Consent completion 0.00% · 0/0" is a claim that every merchant
 * abandoned a screen nobody reached. A MEASURED zero — a real denominator with a zero numerator —
 * is still `0` and must stay reachable.
 *
 * ⚠️ The counts stay plain `number`. An absent count genuinely is zero occurrences; an absent rate
 * is not zero anything.
 */
export interface FunnelSummary {
    views: number;
    engaged_views: number;
    install_clicks: number;
    consent_started: number;
    consent_completed: number;
    installs: number;
    ad_clicks: number;
    first_opens: number;
    sessions: number;
    first_visits: number;
    /** installs ÷ views. `null` when there were no views. */
    overall_conversion_rate: number | null;
    /** ad_clicks ÷ installs. `null` when there were no installs. */
    ad_attributed_share: number | null;
    /** consent_completed ÷ consent_started. `null` when nobody reached the consent screen. */
    consent_completion_rate: number | null;
    /** install_clicks ÷ views. `null` when there were no views. */
    click_through_rate: number | null;
    /** first_opens ÷ installs. `null` when there were no installs. */
    first_open_rate: number | null;
}

/**
 * One day of the funnel trend line.
 *
 * The two rates are `number | null` and the chart plots the null: `DailyFunnelChart` sets
 * `connectNulls={false}` so the series BREAKS over a day with no denominator instead of diving to
 * the floor. A line at 0% across a week with no listing views is a picture of a catastrophe that
 * did not happen.
 *
 * ⚠️ Both are DERIVED on read from this row's own counts, not read off the stored column — the
 * stored ones were written by a zero-defaulting divide and an incremental re-sync never revisits
 * those days. See the mapper in `bigQueryAnalytics.service`.
 */
export interface FunnelTrendPoint {
    date: Date | null;
    views: number;
    engaged_views: number;
    install_clicks: number;
    consent_started: number;
    consent_completed: number;
    installs: number;
    ad_clicks: number;
    first_opens: number;
    overall_conversion_rate: number | null;
    ad_attributed_share: number | null;
}

/**
 * The `data` payload of `getFunnelData`.
 *
 * `summary` and `trend` are both NULL — not `{}` and not `[]` — when `data_state` is
 * `NEVER_SYNCED`. A zeroed summary renders as a funnel with no views and no installs, which is a
 * claim about the listing rather than about our data.
 *
 * `summary` is ALSO null on a `READY` window whose rollup held no row, with `trend: []` and
 * `unknown_reason` set. `docs/FIDELITY.md` §4 states the rule: "Returns `summary: null` — not a
 * zeroed row — when the window contains no rollup row, because `$group` emits no document.
 * Preserve that null: it is the discriminator between 'the rollup has nothing for this window' and
 * 'the rollup says zero'." A `null` summary therefore does NOT imply never-synced; read
 * `data_state` for that.
 */
export interface GetFunnelDataResponse extends AnalyticsWindowEcho {
    summary: FunnelSummary | null;
    trend: FunnelTrendPoint[] | null;
}

// ── getTrafficSourceBreakdown ───────────────────────────────────────────────

/** The second parameter of `getTrafficSourceBreakdown`. */
export interface GetTrafficSourceBreakdownInput extends GetFunnelDataInput {
    /** Clamped to 1..200; defaults to 50. */
    limit?: number | string;
}

/**
 * One (source, medium) pair over the window.
 *
 * ⚠️ These come from GA4's `traffic_source.*`, which is the user's FIRST-EVER acquisition — not the
 * visit that converted. Do not read this table as "where this install came from".
 */
export interface TrafficSourceBreakdownItem {
    traffic_source: string;
    traffic_medium: string;
    users: number;
    views: number;
    install_clicks: number;
    installs: number;
    /**
     * installs ÷ views. `null` when the bucket has no views — which is a REAL row here, not a
     * degenerate one: the rollup deliberately keeps install-only buckets. `0` published
     * "Installs 7 · Install rate 0.00%" in one table row, and the table renders `null` as an em
     * dash. A measured zero (views with no installs) is still `0`.
     */
    install_rate: number | null;
}

/** The `data` payload of `getTrafficSourceBreakdown`. `items` is NULL when never synced. */
export interface GetTrafficSourceBreakdownResponse extends AnalyticsWindowEcho {
    items: TrafficSourceBreakdownItem[] | null;
}

// ── getGeoBreakdown ─────────────────────────────────────────────────────────

/** The second parameter of `getGeoBreakdown`. Clamped to 1..250; defaults to 50. */
export type GetGeoBreakdownInput = GetTrafficSourceBreakdownInput;

/** One country over the window. */
export interface GeoBreakdownItem {
    country: string;
    views: number;
    installs: number;
    /** installs ÷ views. `null` when the country has no views — same rule as `install_rate`. */
    conversion_rate: number | null;
}

/** The `data` payload of `getGeoBreakdown`. `items` is NULL when never synced. */
export interface GetGeoBreakdownResponse extends AnalyticsWindowEcho {
    items: GeoBreakdownItem[] | null;
}

// ── Repository read shapes ──────────────────────────────────────────────────

/** What the funnel totals aggregate returns. One row, or none when the window is empty. */
export interface FunnelTotalsRow {
    views: number;
    engaged_views: number;
    install_clicks: number;
    consent_started: number;
    consent_completed: number;
    installs: number;
    ad_clicks: number;
    first_opens: number;
    sessions: number;
    first_visits: number;
}

/** The second parameter of every rollup READ in the repository. */
export interface RollupReadInput {
    partner_app_id: string;
    date_match: AnalyticsDateMatch;
    /** Row ceiling, already clamped by the caller. Read side only. */
    limit?: number;
}
