'use strict';

/**
 * ============================================================================
 *  THE SQL THIS MODULE IS ALLOWED TO SEND — built here, and refused here
 * ============================================================================
 *
 *  PURE. No models, no config, no clock reads, no I/O. Every value the queries depend on is passed
 *  in, which is what makes the read-only guard testable without a GCP project.
 *
 *  Two jobs, deliberately in one file:
 *
 *    1. BUILDING the four queries this module runs. They are hard-coded functions of a table
 *       reference, never assembled from caller input.
 *    2. REFUSING anything that is not a read. `isReadOnlySql` is the first of three defences —
 *       the second is that a SELECT has no destination table, and the THIRD, the one that actually
 *       holds, is IAM: grant the service account `roles/bigquery.dataViewer` +
 *       `roles/bigquery.jobUser` and nothing else.
 *
 *  Do not weaken the guard. If something ever needs to WRITE to BigQuery, build a separate client in
 *  a different folder rather than opening a hole in this one.
 * ============================================================================
 */

import constants = require('../constants/bigQuery.constants');
import surfaceConstants = require('../../shared/constants/surface.constants');

const {
    FORBIDDEN_STATEMENTS,
    SAFE_IDENTIFIER_RE,
    INSTALL_EVENT,
    AD_CLICK_EVENT,
    PAGE_VIEW_EVENT
} = constants;
const { SURFACE_VIA } = surfaceConstants;

// ── The read-only guard ─────────────────────────────────────────────────────

/**
 * Strict read-only guard.
 *
 * Strips SQL comments (both the line form and the block form), then verifies the first statement
 * keyword is SELECT or WITH. Everything else is refused, multi-statement scripts included: one
 * trailing semicolon is tolerated, a semicolon anywhere else is not.
 *
 * ⚠️ The forbidden-keyword scan runs over the WHOLE cleaned statement, string literals included.
 * That is blunt on purpose — see `FORBIDDEN_STATEMENTS` — and it is why merchant-authored text must
 * travel as a query parameter rather than being inlined.
 *
 * @param sql - The candidate statement.
 * @returns True only for a single SELECT / WITH statement carrying no forbidden keyword.
 */
const isReadOnlySql = (sql: unknown): boolean => {
    if (!sql || typeof sql !== 'string') {
        return false;
    }
    // Strip block comments
    let cleaned = sql.replace(/\/\*[\s\S]*?\*\//g, '');
    // Strip line comments
    cleaned = cleaned.replace(/--[^\n]*/g, '');
    // Trim and grab first non-whitespace token
    cleaned = cleaned.trim();
    if (!cleaned) {
        return false;
    }

    // Reject multi-statement scripts (we permit a single trailing semicolon).
    const withoutTrailingSemicolon = cleaned.replace(/;+\s*$/, '');
    if (/;/.test(withoutTrailingSemicolon)) {
        return false;
    }

    const firstToken = (cleaned.match(/^[A-Za-z_][A-Za-z_0-9]*/) || [''])[0].toUpperCase();
    if (firstToken !== 'SELECT' && firstToken !== 'WITH') {
        return false;
    }

    // Even when starting with SELECT/WITH, scan for forbidden statement keywords as standalone
    // tokens (defensive — guards against injected statements).
    const upper = cleaned.toUpperCase();
    for (const kw of FORBIDDEN_STATEMENTS) {
        const re = new RegExp(`(^|[^A-Z_])${kw}(?![A-Z_0-9])`, 'i');
        if (re.test(upper)) {
            return false;
        }
    }
    return true;
};

// ── Identifier safety ───────────────────────────────────────────────────────

/**
 * Validates one interpolated BigQuery identifier, or throws.
 *
 * BigQuery accepts no parameter in a table position, so project / dataset / table pattern must be
 * interpolated as text. This allowlist is the only thing between configuration and that
 * interpolation. It THROWS rather than returning a fallback: a table reference built from a value
 * that failed validation would query something nobody asked for, and quietly.
 *
 * @param s - The candidate identifier.
 * @param [label] - What it is, for the error message.
 * @returns The identifier, unchanged, when it is safe.
 */
const safeIdentifier = (s: unknown, label?: string): string => {
    if (!s || typeof s !== 'string' || !SAFE_IDENTIFIER_RE.test(s)) {
        throw new Error(`Invalid BigQuery ${label || 'identifier'}: ${s}`);
    }
    return s;
};

/**
 * Builds the backtick-quoted `project.dataset.table_pattern` reference the queries scan.
 *
 * Every component is validated first, so this either returns a safe reference or throws — there is
 * no third outcome, and no caller has to remember to check.
 *
 * @param params0 - The three configured identifiers.
 * @param params0.project_id - GCP project holding the dataset.
 * @param params0.dataset - The dataset holding the daily export tables.
 * @param params0.table_pattern - Wildcard table name, e.g. `events_*`.
 * @returns The quoted reference, ready to interpolate.
 */
const buildTableRef = ({ project_id, dataset, table_pattern }: {
    project_id: string;
    dataset: string;
    table_pattern: string;
}): string => {
    const project = safeIdentifier(project_id, 'project_id');
    const ds = safeIdentifier(dataset, 'dataset');
    const pattern = safeIdentifier(table_pattern, 'table_pattern');
    return '`' + project + '.' + ds + '.' + pattern + '`';
};

// ── The daily rollups ───────────────────────────────────────────────────────
//
// All three are bounded by `_TABLE_SUFFIX BETWEEN @start AND @end`, which is what turns a wildcard
// over every daily table in the dataset into a scan of just the window. That predicate is the
// module's primary COST control — BigQuery bills per byte scanned, and removing or widening it does
// not make a query slower, it makes it more expensive. Do not "simplify" it away.

/**
 * One row per day: the listing funnel, counted by EVENT NAME.
 *
 * ⚠️ These count VISITORS, not shops. Every figure from the Partner API side counts SHOPS, so any
 * ratio crossing that seam compares two different populations and has to say so.
 *
 * @param tableRef - The quoted table reference.
 * @returns The SQL.
 */
const funnelQuery = (tableRef: string): string => `
    SELECT
        PARSE_DATE('%Y%m%d', event_date) AS date,
        COUNTIF(event_name = 'page_view') AS views,
        COUNTIF(event_name = 'view_item') AS engaged_views,
        COUNTIF(event_name = 'Add App button') AS install_clicks,
        COUNTIF(event_name = 'form_start') AS consent_started,
        COUNTIF(event_name = 'form_submit') AS consent_completed,
        COUNTIF(event_name = '${INSTALL_EVENT}') AS installs,
        COUNTIF(event_name = '${AD_CLICK_EVENT}') AS ad_clicks,
        COUNTIF(event_name = 'Open app button') AS first_opens,
        COUNTIF(event_name = 'session_start') AS sessions,
        COUNTIF(event_name = 'first_visit') AS first_visits
    FROM ${tableRef}
    WHERE _TABLE_SUFFIX BETWEEN @start_yyyymmdd AND @end_yyyymmdd
    GROUP BY date
    ORDER BY date
`;

/**
 * One row per (day, traffic source, traffic medium).
 *
 * ⚠️ `traffic_source.*` is the user's FIRST-EVER acquisition, not the visit that converted. This
 * rollup therefore means first-touch, permanently, and must not be read as "where this install came
 * from" — that question is answered only by the per-install attribution table.
 *
 * @param tableRef - The quoted table reference.
 * @returns The SQL.
 */
const sourceQuery = (tableRef: string): string => `
    SELECT
        PARSE_DATE('%Y%m%d', event_date) AS date,
        IFNULL(traffic_source.source, '') AS traffic_source,
        IFNULL(traffic_source.medium, '') AS traffic_medium,
        COUNT(DISTINCT user_pseudo_id) AS users,
        COUNTIF(event_name = 'page_view') AS views,
        COUNTIF(event_name = 'Add App button') AS install_clicks,
        COUNTIF(event_name = '${INSTALL_EVENT}') AS installs
    FROM ${tableRef}
    WHERE _TABLE_SUFFIX BETWEEN @start_yyyymmdd AND @end_yyyymmdd
    GROUP BY date, traffic_source, traffic_medium
    -- WHY \`OR installs >= 1\`: \`${INSTALL_EVENT}\` is a SERVER-SIDE Measurement Protocol event,
    -- so a (date, source, medium) bucket can legitimately carry installs and ZERO page_views. The
    -- original \`HAVING views >= 1\` deleted those buckets from the rollup with no error and no log,
    -- which is why the funnel install count could exceed the sum of this rollup. The guard is kept
    -- (a bucket with NEITHER metric is pure noise and would write one all-zero row per
    -- source/medium per day) but an install-only bucket now survives.
    HAVING views >= 1 OR installs >= 1
    ORDER BY date, installs DESC
`;

/**
 * One row per (day, country).
 *
 * @param tableRef - The quoted table reference.
 * @returns The SQL.
 */
const geoQuery = (tableRef: string): string => `
    SELECT
        PARSE_DATE('%Y%m%d', event_date) AS date,
        IFNULL(geo.country, '') AS country,
        COUNTIF(event_name = 'page_view') AS views,
        COUNTIF(event_name = '${INSTALL_EVENT}') AS installs
    FROM ${tableRef}
    WHERE _TABLE_SUFFIX BETWEEN @start_yyyymmdd AND @end_yyyymmdd
    GROUP BY date, country
    -- WHY \`OR installs >= 1\`: identical reasoning to the source query above. A server-side
    -- \`${INSTALL_EVENT}\` carries \`geo.country\` but no page_view, so an install-only country
    -- was silently dropped from the geo rollup — the Country-distribution card then reads "no
    -- installs in this period" while the funnel counts them.
    HAVING views >= 1 OR installs >= 1
    ORDER BY date, installs DESC
`;

// ── Per-install attribution ─────────────────────────────────────────────────

/**
 * One row per install event, with the store identity read out of `event_params` and the App Store
 * surface stitched on from that same visitor's earlier touches.
 *
 * ⚠️ COST. This is the only query in the module that reads the whole `event_params` repeated column,
 * which is a materially heavier scan than the three rollups above — which is exactly why it is a
 * separate job with its own watermark and its own billing ceiling rather than a fourth section of
 * the daily sync.
 *
 * The stitch is on `user_pseudo_id`, bounded to touches at or before the install. It exists because
 * the install is a SERVER-SIDE hit: its own attribution may be weaker than the browsing session that
 * preceded it, and the surface parameters live on those earlier touches.
 *
 * `include_collected_source` is a flag rather than a constant because `collected_traffic_source` was
 * added to the GA4 export later than `traffic_source`. If the export predates it, BigQuery rejects
 * the whole query BY NAME, and the operator can turn the column off without losing the rest of the
 * row.
 *
 * @param tableRef - The quoted table reference.
 * @param [params1] - Options.
 * @param [params1.include_collected_source=true] - Select the event-scoped attribution columns.
 * @returns The SQL.
 */
const installAttributionQuery = (tableRef: string, { include_collected_source = true }: { include_collected_source?: boolean } = {}): string => {
    let collectedSelect = `
        CAST(NULL AS STRING) AS collected_source,
        CAST(NULL AS STRING) AS collected_medium,
        CAST(NULL AS STRING) AS collected_campaign,`;
    if (include_collected_source) {
        collectedSelect = `
        collected_traffic_source.manual_source        AS collected_source,
        collected_traffic_source.manual_medium        AS collected_medium,
        collected_traffic_source.manual_campaign_name AS collected_campaign,`;
    }

    return `
    WITH raw AS (
        SELECT
            user_pseudo_id,
            event_timestamp,
            event_name,
            PARSE_DATE('%Y%m%d', event_date) AS event_day,
            traffic_source.source AS first_source,
            traffic_source.medium AS first_medium,
            traffic_source.name   AS first_campaign,${collectedSelect}
            geo.country AS country,
            (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'shop_url')  AS shop_url,
            (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'shop_name') AS shop_name,
            (SELECT COALESCE(value.string_value, CAST(value.int_value AS STRING))
               FROM UNNEST(event_params) WHERE key = 'shop_id') AS shop_id,
            (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'surface_type')   AS surface_type,
            (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'surface_detail') AS surface_detail,
            (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_location')  AS page_location
        FROM ${tableRef}
        WHERE _TABLE_SUFFIX BETWEEN @start_yyyymmdd AND @end_yyyymmdd
          AND event_name IN ('${INSTALL_EVENT}', '${AD_CLICK_EVENT}', '${PAGE_VIEW_EVENT}')
    ),
    installs AS (
        SELECT * FROM raw
        WHERE event_name = '${INSTALL_EVENT}'
          AND shop_url IS NOT NULL
    ),
    -- Two mechanisms carry the App Store surface, and only their UNION sees organic traffic.
    -- The struct is built HERE, in one column, so the last-touch pick below takes every field
    -- from the SAME touch. Aggregating each field with its own IGNORE NULLS would happily pair a
    -- detail from one visit with a position from another and never say a word about it.
    surface_touches AS (
        SELECT
            user_pseudo_id,
            event_timestamp,
            STRUCT(
                surface_type   AS surface_type,
                surface_detail AS surface_detail,
                CAST(NULL AS STRING) AS inter_position,
                CAST(NULL AS STRING) AS intra_position,
                CAST(NULL AS STRING) AS locale,
                CAST(NULL AS STRING) AS version,
                '${SURFACE_VIA.AD_CLICK_EVENT}' AS via
            ) AS s
        FROM raw
        WHERE event_name = '${AD_CLICK_EVENT}'
        UNION ALL
        SELECT
            user_pseudo_id,
            event_timestamp,
            STRUCT(
                REGEXP_EXTRACT(page_location, r'[?&]surface_type=([^&#]*)')           AS surface_type,
                REGEXP_EXTRACT(page_location, r'[?&]surface_detail=([^&#]*)')         AS surface_detail,
                REGEXP_EXTRACT(page_location, r'[?&]surface_inter_position=([^&#]*)') AS inter_position,
                REGEXP_EXTRACT(page_location, r'[?&]surface_intra_position=([^&#]*)') AS intra_position,
                REGEXP_EXTRACT(page_location, r'[?&]locale=([^&#]*)')                 AS locale,
                -- Undocumented, and observed live as surface_version=simplified. Shopify A/B-tests
                -- the App Store UI, so this names which variant the merchant was served. Free to
                -- capture now; impossible to recover later if the parameter is ever dropped.
                REGEXP_EXTRACT(page_location, r'[?&]surface_version=([^&#]*)')         AS version,
                '${SURFACE_VIA.LISTING_URL}' AS via
            ) AS s
        FROM raw
        WHERE event_name = '${PAGE_VIEW_EVENT}'
          AND REGEXP_CONTAINS(page_location, r'[?&]surface_type=')
    )
    SELECT
        i.shop_url,
        i.shop_id,
        i.shop_name,
        i.event_day AS install_date,
        TIMESTAMP_MICROS(i.event_timestamp) AS installed_at,
        i.user_pseudo_id,
        i.first_source,
        i.first_medium,
        i.first_campaign,
        i.collected_source,
        i.collected_medium,
        i.collected_campaign,
        i.country,
        -- The IF keeps a surfaceless ad click out of the SURFACE pick while leaving it visible to
        -- the counter below; IGNORE NULLS then drops both it and the LEFT JOIN's unmatched rows.
        ARRAY_AGG(
            IF(t.s.surface_type IS NULL, NULL, t.s)
            IGNORE NULLS ORDER BY t.event_timestamp DESC LIMIT 1
        )[SAFE_OFFSET(0)] AS last_surface,
        -- Counted off the same single join rather than a second one: joining ad clicks separately
        -- would multiply this install's rows by the surface touches and inflate every aggregate.
        COUNTIF(t.s.via = '${SURFACE_VIA.AD_CLICK_EVENT}') AS ad_clicks_before_install
    FROM installs i
    LEFT JOIN surface_touches t
           ON t.user_pseudo_id = i.user_pseudo_id
          AND t.event_timestamp <= i.event_timestamp
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13
    ORDER BY installed_at
`;
};

export = {
    isReadOnlySql,
    safeIdentifier,
    buildTableRef,
    funnelQuery,
    sourceQuery,
    geoQuery,
    installAttributionQuery
};
