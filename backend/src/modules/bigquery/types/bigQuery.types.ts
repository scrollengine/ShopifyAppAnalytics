/**
 * Input and result shapes for the BigQuery client, the two sync services, and the repositories
 * beneath them.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time and does
 * NOT pull `@google-cloud/bigquery` into a caller that only wanted a shape.
 *
 * ⚠️ `RunQueryData` is deliberately ALL-OPTIONAL. `runQuery` resolves five materially different
 * `data` payloads — an empty `{}` on every early rejection, a dry-run estimate, a "job never
 * completed" stub, a truncated result, and a complete result — and the branch that produced one is
 * carried by `status` + `msg`, not by the shape. Modelling it as a union would force every caller's
 * `resp.data.rows` read to become a discriminated narrow, so the honest description is "these keys
 * may be present"; callers must keep checking, exactly as they do today.
 */

// ── Availability ────────────────────────────────────────────────────────────

/**
 * Whether this deployment can reach BigQuery at all, and what to say when it cannot.
 *
 * `message` is the whole point of this type. A view with no data source must never render an
 * empty result set — "we are not connected to Google Analytics" and "this listing got no traffic"
 * are different facts, and only the second is ours to state. So the message NAMES THE MISSING
 * ENVIRONMENT VARIABLE, and every service resolves it verbatim rather than resolving `[]`.
 */
export interface BigQueryAvailability {
    /** Mirrors `config.BIGQUERY.ENABLED`. False ⇒ `missing_env` is non-empty. */
    enabled: boolean;
    /** The variables that are unset, in setup order. Empty when `enabled`. */
    missing_env: string[];
    /** Operator-facing sentence naming what is missing. Empty string when `enabled`. */
    message: string;
}

// ── bigQueryClient ──────────────────────────────────────────────────────────

/**
 * One row as the BigQuery SDK hands it back.
 *
 * Genuinely untyped: the columns are whatever the SQL selected, and the SDK wraps DATE / TIMESTAMP
 * columns as `{ value: string }` rather than a `Date` (see `bqDateToDate` / `bqToDate`).
 */
export type BigQueryRow = Record<string, any>;

/** Named query parameters. Values are whatever the SQL's `@name` placeholders expect. */
export type BigQueryQueryParams = Record<string, any>;

/**
 * Optional per-parameter type hints, e.g. `{ start_yyyymmdd: 'STRING' }`.
 *
 * Only needed when BigQuery cannot infer the type from the JavaScript value.
 */
export type BigQueryParamTypeHints = Record<string, string>;

/** The second parameter of `bigQueryClient.runQuery`. */
export interface RunQueryInput {
    /** The SELECT / WITH statement to execute. Anything else is rejected by the read-only guard. */
    sql?: string;
    /** Named query parameters (key: value). NEVER string-concat user input into the SQL instead. */
    params?: BigQueryQueryParams;
    /** Optional named-param type hints (key: 'STRING'|'DATE'|'INT64'...). */
    types?: BigQueryParamTypeHints;
    /** Validate and price the query without executing it. BILLED AT ZERO, returns no rows. */
    dry_run?: boolean;
}

/**
 * The `data` payload of `runQuery`. Every key is optional — see the file header.
 */
export interface RunQueryData {
    /** Present on a completed query, a truncated one, and (empty) on a job that never completed. */
    rows?: BigQueryRow[];
    /** Bytes BigQuery reported as processed. 0 when the job produced no statistics. */
    bytes_scanned?: number;
    job_id?: string;
    /** True only on the row-cap branch, which resolves `status: false` — the result is INCOMPLETE. */
    truncated?: boolean;
    /** Dry-run branch only. */
    dry_run?: boolean;
    /** Dry-run branch only: `bytes_scanned` rendered in GiB, rounded to 2 decimals. */
    gib_scanned?: number;
    /** Dry-run branch only: the configured per-query billing ceiling. */
    max_bytes_billed?: number;
    /** Dry-run branch only: true when the job would be REJECTED before it runs, not merely costly. */
    exceeds_cap?: boolean;
}

// ── Sync windows ────────────────────────────────────────────────────────────

/**
 * What `resolveSyncWindow` needs off the partner app: only the watermark, which decides LIFETIME vs
 * INCREMENTAL. Declared structurally so a `.lean()` document satisfies it without restating the doc.
 */
export interface SyncWatermarkSource {
    /** Watermark for the three daily rollups. */
    last_bq_synced_at?: Date | null;
    /** Watermark for the per-install attribution pull — a separate failure domain. */
    last_install_attrib_synced_at?: Date | null;
}

/**
 * Everything `resolveSyncWindow` needs, passed IN rather than read from config.
 *
 * The helper stays pure — no config, no clock beyond the `now` it is handed — which is what makes
 * the awkward cases testable: the first run with no watermark, the malformed floor date, the
 * incremental window whose overlap reaches back before the floor.
 */
export interface ResolveSyncWindowInput {
    /** The watermark that decides this run's mode. Null/undefined ⇒ LIFETIME under AUTO. */
    watermark?: Date | null;
    /** AUTO | LIFETIME | INCREMENTAL. Anything else is treated as AUTO. */
    mode?: string;
    /** `YYYY-MM-DD`. Where a LIFETIME run starts. */
    lifetime_floor_date: string;
    /** Window when there is no watermark and the mode resolved to INCREMENTAL. */
    default_lookback_days: number;
    /** Caller-supplied override for the above. Ignored unless a positive finite number. */
    lookback_days?: number;
    /** Days re-pulled before the watermark, so an event that landed late is not skipped. */
    overlap_days: number;
    /** The clock, passed in. A helper that reads the clock can only be tested by waiting. */
    now: Date;
}

/** The resolved sync window, in both the `_TABLE_SUFFIX` form and an ISO form for logs. */
export interface BigQuerySyncWindow {
    resolved_mode: string;
    start_yyyymmdd: string;
    end_yyyymmdd: string;
    start_iso: string;
    end_iso: string;
}

// ── bigQuerySyncService ─────────────────────────────────────────────────────

/**
 * The second parameter of each per-section sync helper (`_syncFunnel` / `_syncSource` / `_syncGeo`).
 */
export interface SectionSyncInput {
    /** Mongo `_id` of the app row, as a string. The repositories cast it. */
    partner_app_id: string;
    /** The backtick-quoted `project.dataset.table_pattern` reference. */
    tableRef: string;
    window: BigQuerySyncWindow;
}

/** The second parameter of `bigQuerySyncService.runDailySync`. */
export interface RunDailySyncInput {
    /** Mongo _id of the partner app row. */
    partner_app_id?: string;
    /** AUTO / LIFETIME / INCREMENTAL (default AUTO). */
    mode?: string;
    /** Used only when there is no watermark yet. */
    lookback_days?: number;
}

/**
 * The four counters every per-section sync helper reports, handed to `finishSection`.
 *
 * All four are REQUIRED: a section that reports only `upserted` cannot distinguish "the window was
 * empty" from "every write threw" from "every row had an unparsable date", and those three demand
 * different fixes.
 */
export interface SectionSyncCounters {
    /** Rows BigQuery returned for this section. 0 means the query, not the write path, found nothing. */
    rows_fetched: number;
    /**
     * Rows the write ACCOUNTED FOR — inserted OR matched.
     *
     * NOT `modifiedCount`. A re-sync that writes identical values modifies nothing, so a counter
     * built on modified rows reads 0 on every idempotent re-run — and `finishSection` FAILS a
     * section that fetched rows and wrote none. Counting matches is what keeps a correct, boring
     * re-sync from reporting itself as a broken write path.
     */
    upserted: number;
    /** Rows the write neither inserted nor matched. The only place a lost row can show up. */
    write_errors: number;
    /** Rows dropped before the write because the date column could not be parsed. */
    skipped_no_date: number;
}

/**
 * The `data` payload each per-section sync helper resolves with.
 *
 * Extends `RunQueryData` because the query-side provenance (`bytes_scanned`, `job_id`, `truncated`)
 * is carried through from the BigQuery client onto every section result, success or failure.
 */
export interface SectionSyncData extends RunQueryData, Partial<SectionSyncCounters> {
    /**
     * True when `runQuery` itself failed, so the zeroed counters mean "never attempted" rather than
     * "attempted and wrote nothing". Without it those two are indistinguishable in the run summary.
     */
    query_failed?: boolean;
}

/** The `data` payload of `runDailySync`. */
export interface RunDailySyncData {
    partner_app_id: string;
    mode: string;
    start: string;
    end: string;
    funnel: SectionSyncData | null;
    source: SectionSyncData | null;
    geo: SectionSyncData | null;
    funnel_ok: boolean;
    source_ok: boolean;
    geo_ok: boolean;
    /**
     * One-line digest of the window plus all three sections' counters.
     *
     * Duplicated into the failure MESSAGE as well, because a failed job row stores only its error
     * text — a result summary is stored on SUCCESS ONLY, so anything left in `data` is lost on
     * exactly the runs that need explaining.
     */
    diagnostic?: string;
}

// ── Rollup write rows ───────────────────────────────────────────────────────
//
// What the sync service hands the repository: already parsed, already typed, no BigQuery shapes
// left in them. The service maps and counts; the repository decides what a write SETS.

/**
 * One day of the funnel rollup. Grain: (partner_app_id, date).
 *
 * THE TWO RATES ARE `number | null` AND THE NULL IS WRITTEN TO MONGO. They come from
 * `funnelMath.helper`'s `rate()`, which answers `null` for an absent denominator. This used to be a
 * zero-defaulting divide, and because these columns are STORED the substitution outlived the
 * request: a day with no views kept `overall_conversion_rate: 0` for ever, and an INCREMENTAL
 * re-sync never reaches back to repair it. A MEASURED zero — views with no installs — is still `0`.
 */
export interface FunnelDayRow {
    date: Date;
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
    /** installs ÷ views. `null` when the day had no views. */
    overall_conversion_rate: number | null;
    /** ad_clicks ÷ installs. `null` when the day had no installs. */
    ad_attributed_share: number | null;
    /** Provenance of the scan that produced the row. */
    bytes_scanned: number;
    source_bq_query_id: string;
}

/** One (day, source, medium) bucket. Grain includes both attribution columns. */
export interface SourceDayRow {
    date: Date;
    traffic_source: string;
    traffic_medium: string;
    users: number;
    views: number;
    install_clicks: number;
    installs: number;
}

/** One (day, country) bucket. */
export interface GeoDayRow {
    date: Date;
    country: string;
    views: number;
    installs: number;
    /** installs ÷ views. `null` when the country bucket had no views — see {@link FunnelDayRow}. */
    conversion_rate: number | null;
}

/**
 * What a chunked bulk write reports back.
 *
 * `upserted + matched` is the accounted-for count; `errors` is every row that was neither. A row
 * that vanishes from all three would be a silently lost write, which is the failure this project
 * exists to refuse — so the three are required to sum to the batch size.
 */
export interface ListingWriteTally {
    upserted: number;
    matched: number;
    errors: number;
}

// ── installAttributionSyncService ───────────────────────────────────────────

/** The second parameter of `installAttributionSyncService.syncInstallAttribution`. */
export interface SyncInstallAttributionInput {
    /** Mongo _id of the partner app row. */
    partner_app_id?: string;
    /** AUTO | LIFETIME | INCREMENTAL. */
    mode?: string;
    /** Window when there is no watermark yet. */
    lookback_days?: number;
    /** Set false if the export predates collected_traffic_source. */
    include_collected_source?: boolean;
    /** Validate and price the query without executing or writing. Billed at zero. */
    dry_run?: boolean;
    /** Recorded on every row for provenance. */
    sync_job_id?: string;
}

/**
 * Which GA4 scope produced a row's source/medium.
 *
 * Never let two scopes look alike: `event_collected` describes the visit that converted, whereas
 * `user_first_acquisition` describes how the visitor was FIRST EVER acquired.
 */
export interface ResolvedAttribution {
    source: string;
    medium: string;
    campaign: string;
    attribution_source: string;
}

/**
 * The App Store surface resolved from the last surface-bearing touch before an install.
 *
 * Every field is read off ONE touch — the query aggregates a struct rather than a column at a time,
 * so the detail cannot be paired with a different visit's rank.
 */
export interface ResolvedSurface {
    surface_type: string;
    /** Shopify's taxonomy/section handle on browse surfaces; blank on search surfaces. */
    surface_detail: string;
    /** 1-based results PAGE. Null when absent — 0 would average in as an impossibly good rank. */
    surface_inter_position: number | null;
    /** 1-based position WITHIN that page. */
    surface_intra_position: number | null;
    locale: string;
    /**
     * Which App Store UI variant served the listing, e.g. `simplified`.
     *
     * Undocumented by Shopify and observed live in listing URLs. Shopify A/B-tests the store, so this
     * is the only record of which experience a merchant actually converted from.
     */
    surface_version: string;
    /** `ad_click_event` | `listing_url` — which mechanism carried it. */
    surface_via: string;
}

/** One install row, fully resolved, as the repository receives it. */
export interface InstallAttributionRow {
    shop_domain: string;
    shop_url_raw: string;
    shop_id: string;
    shop_name: string;
    installed_at: Date;
    install_date: Date;
    user_pseudo_id: string;
    source: string;
    medium: string;
    campaign: string;
    attribution_source: string;
    surface_type: string;
    surface_detail: string;
    surface_inter_position: number | null;
    surface_intra_position: number | null;
    surface_via: string;
    surface_version: string;
    ad_clicks_before_install: number;
    country: string;
    locale: string;
    sync_job_id: string;
}

/**
 * The `data` payload of `syncInstallAttribution`.
 *
 * A dry run resolves the window fields spread over `RunQueryData` instead, so the counting fields
 * are optional here.
 */
export interface SyncInstallAttributionData extends RunQueryData {
    partner_app_id: string;
    mode: string;
    start: string;
    end: string;
    rows_fetched?: number;
    /** Inserted OR matched — see `SectionSyncCounters.upserted` for why matches are counted. */
    upserted?: number;
    skipped_no_shop_url?: number;
    write_errors?: number;
    attribution_breakdown?: Record<string, number>;
    with_app_store_surface?: number;
    /** Any surface whose name ends in `_ad`, not `search_ad` alone — see shared/surface.constants. */
    paid_surface_installs?: number;
    organic_surface_installs?: number;
    /**
     * Which mechanism produced each surface: `ad_click_event` vs `listing_url`.
     *
     * The diagnostic that matters on a re-sync — `listing_url` at zero means the organic half is
     * still not being read, which is indistinguishable from "this app gets no organic traffic"
     * in every other number on the page.
     */
    surface_via_breakdown?: Record<string, number>;
    /** Set only when the window returned zero install events — the likeliest cause is named in it. */
    warning?: string;
}
