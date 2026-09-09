/**
 * ============================================================================
 *  THE PARTNER APPS PAGE — wire shapes for the KPI and the event reads
 * ============================================================================
 *
 *  Declarations only — every import is `import type`, so this file is erased at
 *  compile time.
 *
 *  ──  EVERY FIGURE HERE IS A BARE NUMBER, OR `null` ────────────────────────
 *
 *  Not a relaxation of the honesty rule — an application of it.
 *  `components/growth-intel/AppKpiCards.js` formats through `_fmtNumber` and
 *  `_fmtMoney`, which are `Number(n)` and `typeof n !== 'number'`. A confidence
 *  envelope is an OBJECT: `Number({…})` is `NaN`, and the card renders it as an
 *  em dash. Handing that component envelopes would blank all eight tiles — the
 *  honesty mechanism MANUFACTURING the very absence it exists to prevent.
 *
 *  So the contract is discharged through fields that survive rendering instead:
 *  `null` for unknown and NEVER `0`, `measurable` + `unknown_reason` per trend
 *  point, `data_state`, `coverage`, `warnings[]` and `diagnostics`.
 *  `modules/revenue/services/revenueOverview.service` states the same rule for
 *  the same reason; envelopes belong on a coverage endpoint whose renderer is
 *  ours, and this one's renderer is not.
 *
 *  ──  `null` AND `0` ARE DIFFERENT ANSWERS, EVERYWHERE BELOW ──────────────
 *
 *  `0` means MEASURED AND EMPTY — a window inside the synced record in which
 *  nothing happened. `null` means NOT MEASURABLE — the window reaches below
 *  what has been fetched, or nothing has been fetched at all. The KPI tile for
 *  the first says "0 installs", which is a claim about the business; the tile
 *  for the second says "—", which is a claim about this deployment. They are
 *  never interchangeable and no branch may collapse them.
 * ============================================================================
 */

/** ⚠️ A wire contract with `frontend/components/growth-intel/dataState.js`. See the constants. */
export type PartnerAppDataState = 'READY' | 'NEVER_SYNCED';

/** Which calendar unit one trend point covers. Published; never inferred from the label format. */
export type PartnerAppTrendGrain = 'day' | 'month';

/**
 * The four relationship counts, as bare numbers or as four nulls together.
 *
 * ⚠️ `deactivations` IS NOT SUMMED INTO `uninstalls`. Shopify's `RelationshipDeactivated` is a shop
 * frozen or closed, not a merchant removing the app, and the KPI tile is labelled "Uninstalls".
 *
 * ⚠️ THE FOUR MOVE TOGETHER. They are folded from one array in one pass, so either every one of
 * them is a measurement or none is — a payload with three numbers and one null would be describing
 * two different windows.
 */
export interface PartnerAppRelationshipCounts {
    installs: number | null;
    uninstalls: number | null;
    reinstalls: number | null;
    /** Shopify froze or closed the shop. A separate fact from an uninstall, published separately. */
    deactivations: number | null;
}

/**
 * One point on the install trend.
 *
 *  A BUCKET WITH NO MEASURABLE VALUE PUBLISHES `null`, NEVER `0`. `InstallTrendChart` plots with
 * Recharts' default `connectNulls={false}`, so a null BREAKS the line — which is the honest
 * rendering of "we have no records here". A `0` draws the line along the floor and states that
 * nobody installed the app that month, which is a claim about the business made out of an absence
 * of data.
 */
export interface PartnerAppTrendPoint {
    /**
     * `YYYY-MM-DD` at day grain, `YYYY-MM` at month grain.
     *
     * Named `date` because `InstallTrendChart` hard-codes `dataKey="date"` on its XAxis, and
     * `pages/apps/index.js` drops any row without one rather than plotting it at an
     * unknown position.
     */
    date: string;
    installs: number | null;
    uninstalls: number | null;
    reinstalls: number | null;
    deactivations: number | null;
    /** False when this bucket opens below the coverage floor — its four counts are then null. */
    measurable: boolean;
    /**
     * True when the bucket is only PARTLY inside the requested window.
     *
     * ⚠️ ONLY THE TWO END BUCKETS CAN BE PARTIAL, and only at month grain — a 30-day window that
     * starts on the 12th plots a January bar built from nineteen days. That bar is genuinely lower
     * than its neighbours and nothing about the chart says why, so the flag is published and a
     * warning names the buckets. The alternative — widening the aggregate to whole calendar months
     * — would make the chart cover a different period from the KPI tiles above it, and two figures
     * on one screen describing two windows is the worse failure.
     */
    is_partial: boolean;
    /** Why this point is unknown. Present ONLY when `measurable` is false. */
    unknown_reason?: string;
}

/** The window a read was served for, echoed so a chart's axis and its label cannot disagree. */
export interface PartnerAppWindow {
    /** UTC start-of-day, or null for an all-time window. */
    since: Date | null;
    /** UTC end-of-day. */
    until: Date;
    /** Human label, e.g. "Last 30 days". `AppKpiCards` prints it verbatim as the section heading. */
    period_label: string;
    /** Numeric days when the window came from a preset; null for custom and lifetime windows. */
    period_days: number | null;
    is_lifetime: boolean;
}

/**
 * What the app row's gates say about how much weight these figures bear.
 *
 * Published rather than kept internal, for the reason the whole project exists: a dashboard that
 * shows the numbers while keeping their coverage private is the failure it refuses.
 */
export interface PartnerAppReadCoverage {
    /** Stamped ONLY by a fully successful sync. `null` here is what makes `data_state` NEVER_SYNCED. */
    last_synced_at: Date | null;
    /** Null until a LIFETIME pull has completed once. Until then every all-time figure is a floor. */
    lifetime_sync_completed_at: Date | null;
    /** Oldest event held. The floor of what the relationship record can answer. */
    earliest_event_at: Date | null;
    /** Oldest payout held. Tracked separately: payouts settle later than the charges that earned them. */
    earliest_transaction_at: Date | null;
    /**
     * The instant below which nothing was fetched, or `null` when no floor has been measured.
     *
     *  READ IT WITH `all_time_measurable`, NEVER ALONE. `null` has two opposite readings and only
     * that flag separates them: with `all_time_measurable: true` the record is COMPLETE and there is
     * no floor to be below; with `all_time_measurable: false` no floor has ever been measured, which
     * means NOTHING is measurable rather than everything. The three `*_measurable` booleans below
     * are the decided answers — prefer them to re-deriving one from this date.
     */
    event_floor: Date | null;
    /** The same floor for money, with the same two readings. The two syncs succeed independently. */
    transaction_floor: Date | null;
    /** True when the selected window sits entirely at or above `event_floor`. */
    counts_measurable: boolean;
    /** True when the selected window sits entirely at or above `transaction_floor`. */
    revenue_measurable: boolean;
    /** True only once a LIFETIME sync has completed — the gate on every `all_time` figure. */
    all_time_measurable: boolean;
}

// ── The KPI read ────────────────────────────────────────────────────────────

/** Money settled inside the selected window. CASH — every transaction type, never a run-rate. */
export interface PartnerAppKpiRevenue {
    /** What merchants were charged, refunds included as negatives. `null` when not measurable. */
    gross_total: number | null;
    /** What actually reached the bank, after Shopify's cut. */
    net_total: number | null;
    transaction_count: number | null;
    /**
     * The single currency every figure above is denominated in, or `null`.
     *
     * ⚠️ `null` WHEN THE PAYOUTS SPAN MORE THAN ONE. There is no FX table anywhere in this build, on
     * purpose — a wrong rate produces a plausible wrong number — so a multi-currency total is a sum
     * of unlike units and must not be captioned with any one of their symbols. The warning names
     * every code seen. `AppKpiCards` appends this to its tile label and prints nothing when it is
     * absent, which is the correct rendering.
     */
    currency: string | null;
}

/**
 * All-time figures.
 *
 *  EVERY FIELD IS `null` UNTIL A LIFETIME SYNC HAS COMPLETED. `models/partner/partnerApp.model`
 * states the rule on `lifetime_sync_completed_at` itself: until it is set these collections hold
 * "whatever an INCREMENTAL window happened to pull", so a figure that depends on complete history
 * "checks this first and reports 'history not backfilled' rather than publishing a partial sum with
 * a total's label on it". A card headed "All-time" over a 90-day incremental pull is that label.
 */
export interface PartnerAppKpiAllTime extends PartnerAppRelationshipCounts {
    /**
     * Stores whose MOST RECENT relationship event is an install or a reinstall.
     *
     * ⚠️ AN ESTIMATE, AND THE TILE SAYS SO. Shopify does not publish a live installed-store count
     * anywhere in the Partner API; this is a fold over the relationship event stream, so it is only
     * as complete as that stream. It is derived through `modules/store`'s canonical
     * `resolveInstallStates` — the one definition of "is the app on this store right now" — rather
     * than by comparing install and uninstall counts, which gets a reinstalled shop right by
     * accident and a shop with a lost uninstall wrong for ever.
     */
    estimated_active: number | null;
    /** All-time settled cash, gross. */
    gross_revenue: number | null;
    /** All-time settled cash, net of Shopify's cut. */
    net_revenue: number | null;
    transaction_count: number | null;
}

/** Counts of what the reads actually saw, so nothing is excluded silently. */
export interface PartnerAppKpiDiagnostics {
    /** Relationship events inside the window, across all four types. */
    window_relationship_events: number;
    /** Relationship events all time — the population `estimated_active` was folded from. */
    all_time_relationship_events: number;
    /** Window events whose `shop_domain` was blank. Counted in the tiles; unjoinable to a store. */
    window_shopless_events: number;
    /** All-time events the install fold could not use, by reason. */
    all_time_shopless_events: number;
    /** Trend buckets whose counts are null because they open below the coverage floor. */
    unmeasured_trend_buckets: number;
    /** Trend buckets dropped by the point ceiling. The OLDEST are dropped; the response says so. */
    withheld_trend_buckets: number;
    /** Distinct currencies seen on the window's payouts. One is normal; more is a caveat. */
    window_currencies: string[];
}

/** `getPartnerAppKpi` payload. */
export interface PartnerAppKpiData {
    app_id: string;
    /** Echoed at the top level too: `AppKpiCards` reads `kpi.period_label` / `kpi.period_days`. */
    period_label: string;
    period_days: number | null;
    is_lifetime: boolean;
    window: PartnerAppWindow;
    data_state: PartnerAppDataState;
    /** Why there is nothing to show. Set ONLY on the `NEVER_SYNCED` branch — it is the banner body. */
    unknown_reason?: string;
    counts: PartnerAppRelationshipCounts;
    all_time: PartnerAppKpiAllTime;
    revenue: PartnerAppKpiRevenue;
    /**
     * The install series.
     *
     * ⚠️ `null` — not `[]` — on NEVER_SYNCED. An empty array is a measured "nothing happened", which
     * `pages/apps/index.js` renders as a chart-shaped gap with the sentence "this is a
     * gap in the response, not a stretch with no installs". A null takes the banner branch instead.
     *
     * ⚠️ Published under `trend`, not `daily_trend`: the grain is not always days. That page reads
     * `daily_trend` then `trend` then `install_trend`, so `trend` is served and read.
     */
    trend: PartnerAppTrendPoint[] | null;
    trend_grain: PartnerAppTrendGrain;
    coverage: PartnerAppReadCoverage;
    /** ⚠️ UNIQUE STRINGS. React keys them by content, so a duplicate is DROPPED, not drawn twice. */
    warnings: string[];
    diagnostics: PartnerAppKpiDiagnostics;
}

/** `getPartnerAppKpi` input. Everything optional — it arrives from a URL and a query bag. */
export interface GetPartnerAppKpiInput {
    partner_app_id?: string;
    /** `'all'` / `0` for lifetime, otherwise days back from now. Defaults to 30. */
    period_days?: string | number;
    /** ISO `YYYY-MM-DD`. Only honoured when `until` parses too. */
    since?: string;
    /** ISO `YYYY-MM-DD`. Only honoured when `since` parses too. */
    until?: string;
}

// ── The event read ──────────────────────────────────────────────────────────

/**
 * One Partner event, as it goes onto the wire.
 *
 * ⚠️ `raw_event` IS NOT PUBLISHED. It is a Mixed blob per row on the largest collection in the
 * build, and a page of 200 of them is megabytes of payload for a list nobody reads a payload from.
 * The single-store detail path is where a raw node is inspected.
 */
export interface SerializedPartnerEvent {
    /** The local sha256 dedupe key. Stable across re-syncs; not a Shopify id. */
    partner_event_id: string;
    event_type: string;
    occurred_at: Date;
    /** Canonical (bare, lowercased, no scheme) — normalised on write. `''` when Shopify sent none. */
    shop_domain: string;
    /**
     * The merchant-facing store name, or `null`.
     *
     * ⚠️ `null` MEANS NOT MEASURED, NEVER "THIS STORE HAS NO NAME". Shopify's `Shop.name` is
     * non-null upstream, so a shop without one does not exist. A null here means this row was
     * written before the sync that fills the column — the boundary is
     * `coverage.shop_name_coverage_since` on the app row, and a LIFETIME re-sync closes it.
     */
    shop_name: string | null;
    /** The Partner GID for the shop. `''` on rows that carried none. */
    shop_id: string;
    /**
     * The charge this event is about, already normalised to the bare numeric id, or `null`.
     *
     * `null` is a MEASURED fact here, not an unknown: the four relationship events never carry a
     * charge block. The strict extractor refuses to store an id it could not parse, so a stored
     * value is always joinable to `gi_partner_app_transactions.charge_id` directly.
     */
    charge_id: string | null;
}

/** Where in the result set a page sits. */
export interface PartnerAppEventPage {
    /** 1-based. */
    page: number;
    limit: number;
    /** Matching rows across every page, not the length of `items`. */
    total: number;
    total_pages: number;
    has_more: boolean;
}

/** What the event read filtered on, echoed so an ignored filter is visible rather than mysterious. */
export interface PartnerAppEventFilters {
    /**
     * The event type filter that was APPLIED, or null when none was.
     *
     * ⚠️ FAIL-OPEN. An unrecognised `type` is dropped with a warning and the list WIDENS; it never
     * matches nothing. A table that renders zero rows because of a typo in a query string is
     * indistinguishable from an app with no events.
     */
    type: string | null;
    /** True when the caller sent a `type` this endpoint could not honour. The warning names it. */
    type_ignored: boolean;
}

/** Counts of what the event read saw. */
export interface PartnerAppEventDiagnostics {
    /** Rows returned on this page. */
    rows_returned: number;
    /** Relationship events inside the window that fed the trend, across all four types. */
    trend_relationship_events: number;
    /** Trend buckets published as null because they open below the coverage floor. */
    unmeasured_trend_buckets: number;
    /** Trend buckets dropped by the point ceiling. The OLDEST are dropped; the response says so. */
    withheld_trend_buckets: number;
}

/** `getPartnerAppEvents` payload. */
export interface PartnerAppEventsData {
    app_id: string;
    window: PartnerAppWindow;
    data_state: PartnerAppDataState;
    /** Why there is nothing to show. Set ONLY on the `NEVER_SYNCED` branch. */
    unknown_reason?: string;
    /**
     * The page of events.
     *
     * ⚠️ `null` — not `[]` — on NEVER_SYNCED, so the decoder takes the banner branch. An empty array
     * is a MEASURED "no events matched", which is an ordinary 200 and renders as an empty table.
     */
    items: SerializedPartnerEvent[] | null;
    pagination: PartnerAppEventPage;
    filters: PartnerAppEventFilters;
    /**
     * The install series over the SAME window as the list.
     *
     * ⚠️ NOT AFFECTED BY `type` OR BY PAGING. It is folded from a dedicated relationship-event
     * aggregate over the whole window, because a trend built from one filtered page would be a
     * chart of an arbitrary 50 rows wearing an axis that claims to cover the period.
     */
    trend: PartnerAppTrendPoint[] | null;
    trend_grain: PartnerAppTrendGrain;
    coverage: PartnerAppReadCoverage;
    /** ⚠️ UNIQUE STRINGS — see the KPI payload. */
    warnings: string[];
    diagnostics: PartnerAppEventDiagnostics;
}

/** `getPartnerAppEvents` input. Everything optional — it arrives from a URL and a query bag. */
export interface GetPartnerAppEventsInput {
    partner_app_id?: string;
    period_days?: string | number;
    since?: string;
    until?: string;
    page?: string | number;
    limit?: string | number;
    /** One of `PARTNER_EVENT_TYPES`. Anything else widens the result and warns. */
    type?: string;
}
