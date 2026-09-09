'use strict';

/**
 * ============================================================================
 *  BIGQUERY_SYNC — the three daily listing rollups
 * ============================================================================
 *
 *  Pulls the funnel, the traffic-source split and the country split out of the GA4 export and
 *  upserts them as daily rows. Three independent queries, run concurrently, each with its own
 *  counters — because "the card is empty" has three completely different causes and they must not
 *  look alike:
 *
 *    rows_fetched = 0                 the QUERY found nothing (wrong window, or genuinely no traffic)
 *    rows_fetched > 0, upserted = 0   the WRITE path is broken
 *    skipped_no_date > 0              the rows came back unreadable
 *
 *  ⚠️ COST. Every run scans one daily table per day in the window, three times over. The window is
 *  the bill — see `helpers/syncWindow.helper`.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import constants = require('../constants/bigQuery.constants');
import sqlHelper = require('../helpers/bigQuerySql.helper');
import rowHelper = require('../helpers/bigQueryRow.helper');
import syncWindowHelper = require('../helpers/syncWindow.helper');
import availabilityResolver = require('../resolvers/bigQueryAvailability.resolver');
import bigQueryClient = require('../clients/bigQuery.client');
import syncStateRepository = require('../repositories/bigQuerySyncState.repository');
import listingRollupRepository = require('../repositories/listingRollup.repository');
// DEEP PATH TO A PURE LEAF — never `require('../../conversion')`; see the identical note in
// `bigQueryAnalytics.service.ts`. `rate()` is the one division in this codebase, and the rates it
// produces here are STORED, so a `0` written for an absent denominator would outlive the fix.
import funnelMathHelper = require('../../conversion/helpers/funnelMath.helper');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type {
    FunnelDayRow,
    GeoDayRow,
    ListingWriteTally,
    RunDailySyncData,
    RunDailySyncInput,
    RunQueryData,
    SectionSyncCounters,
    SectionSyncData,
    SectionSyncInput
} from '../types/bigQuery.types';

const { customConsoleLog, customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { BIGQUERY_INCREMENTAL_OVERLAP_DAYS } = constants;
const { buildTableRef, funnelQuery, sourceQuery, geoQuery } = sqlHelper;
const { bqDateToDate, num, readMessage } = rowHelper;
const { rate } = funnelMathHelper;
const { SYNC_MODES, isValidFloorDate, resolveSyncWindow } = syncWindowHelper;
const { resolveBigQueryAvailability } = availabilityResolver;
const { runQuery } = bigQueryClient;
const { findSyncTargetApp, stampRollupWatermark } = syncStateRepository;
const { upsertFunnelDays, upsertSourceDays, upsertGeoDays } = listingRollupRepository;

// ── Section outcome helpers ─────────────────────────────────────────────────

/**
 * The section envelope for a pull that never produced rows because the QUERY failed.
 *
 * The obvious implementation hands the caller the BigQuery client's own payload, which carries no
 * counters at all — and a query-side failure then looks identical to a write-side one in the run
 * summary. The client's `msg` and `error` pass through unchanged (it is the only thing that knows
 * why), but the payload is re-shaped so every section reports the same four counters. `truncated` is
 * carried because a row-cap hit is a distinct, actionable cause.
 *
 * @param resp - The failed `runQuery` result.
 * @returns A failed section with zeroed counters and `query_failed`.
 */
const _sectionQueryFailure = (resp: ServiceResult<RunQueryData>): ServiceResult<SectionSyncData> => {
    return promiseReturnResult(false, {
        rows_fetched: 0,
        upserted: 0,
        write_errors: 0,
        skipped_no_date: 0,
        query_failed: true,
        bytes_scanned: (resp.data && resp.data.bytes_scanned) || 0,
        job_id: (resp.data && resp.data.job_id) || '',
        truncated: !!(resp.data && resp.data.truncated)
    }, resp.error, resp.msg);
};

/**
 * Turns a section's counters into its result envelope, and FAILS the section when it fetched rows
 * and wrote none.
 *
 * WHY that is a failure: a section whose writes all failed would otherwise resolve `status: true`
 * with `upserted: 0` — reporting success, letting the caller stamp the watermark, and leaving the
 * collection empty. Fetched-rows-but-wrote-nothing is categorically a broken write path (or a query
 * whose every row had an unparsable date); a genuinely empty window is `rows_fetched === 0`, which
 * still succeeds.
 *
 * A PARTIAL failure deliberately stays a SUCCESS — one poison row must not block a whole rollup —
 * but `write_errors` and `skipped_no_date` ride on the result either way, so the count is visible
 * instead of living only in a log line.
 *
 * @param label - The section's name, for the message.
 * @param resp - The query result, for its provenance fields.
 * @param counters - What the section fetched, wrote, lost and skipped.
 * @returns The section envelope.
 */
const _finishSection = (label: string, resp: ServiceResult<RunQueryData>, counters: SectionSyncCounters): ServiceResult<SectionSyncData> => {
    const _data: SectionSyncData = {
        rows_fetched: counters.rows_fetched,
        upserted: counters.upserted,
        write_errors: counters.write_errors,
        skipped_no_date: counters.skipped_no_date,
        query_failed: false,
        bytes_scanned: (resp.data && resp.data.bytes_scanned) || 0,
        job_id: (resp.data && resp.data.job_id) || ''
    };

    if (counters.rows_fetched > 0 && counters.upserted === 0) {
        return promiseReturnResult(false, _data, {}, `${label} sync wrote NOTHING: ${counters.rows_fetched} rows fetched, ${counters.write_errors} write errors, ${counters.skipped_no_date} rows skipped for an unparsable date.`);
    }

    return promiseReturnResult(true, _data, {}, `${label} synced.`);
};

/**
 * One-line, machine-greppable digest of a section's outcome.
 *
 * A failed job row stores its error TEXT and nothing else — a result summary is persisted on SUCCESS
 * only — so on a failed run this string is the only place the counters survive. It is therefore
 * folded into the run's failure message as well as logged.
 *
 * @param label - The section's name.
 * @param [result] - The section envelope, if it produced one.
 * @returns The digest.
 */
const _sectionDigest = (label: string, result?: ServiceResult<SectionSyncData> | null): string => {
    const _data: SectionSyncData = (result && result.data) || {};
    const _ok = !!(result && result.status);
    return `${label}[ok=${_ok} rows=${num(_data.rows_fetched)} upserted=${num(_data.upserted)} write_errors=${num(_data.write_errors)} skipped_no_date=${num(_data.skipped_no_date)} query_failed=${!!_data.query_failed}]`;
};

// ── Per-section sync helpers ────────────────────────────────────────────────

const _syncFunnel = ({ user_id }: IdentityObject, { partner_app_id, tableRef, window }: SectionSyncInput): Promise<ServiceResult<SectionSyncData>> => {
    return new Promise(async (resolve) => {
        try {
            const resp = await runQuery({ user_id }, {
                sql: funnelQuery(tableRef),
                params: { start_yyyymmdd: window.start_yyyymmdd, end_yyyymmdd: window.end_yyyymmdd },
                types: { start_yyyymmdd: 'STRING', end_yyyymmdd: 'STRING' }
            });
            if (!resp.status) {
                return resolve(_sectionQueryFailure(resp));
            }
            const rows = (resp.data && Array.isArray(resp.data.rows)) ? resp.data.rows : [];

            let skipped_no_date = 0;
            const parsed: FunnelDayRow[] = [];
            for (const row of rows) {
                const date = bqDateToDate(row.date);
                if (!date) {
                    // Counted rather than dropped silently: an all-skipped section is
                    // indistinguishable from an all-failed one without this number.
                    skipped_no_date += 1;
                    continue;
                }
                const installs = num(row.installs);
                const views = num(row.views);
                const ad_clicks = num(row.ad_clicks);
                parsed.push({
                    date,
                    views,
                    engaged_views: num(row.engaged_views),
                    install_clicks: num(row.install_clicks),
                    consent_started: num(row.consent_started),
                    consent_completed: num(row.consent_completed),
                    installs,
                    ad_clicks,
                    first_opens: num(row.first_opens),
                    sessions: num(row.sessions),
                    first_visits: num(row.first_visits),
                    // `rate()`, NEVER a zero-defaulting divide. These two are WRITTEN, so the
                    // substitution outlives the request: a day with no views stored
                    // `overall_conversion_rate: 0`, and every later read of that row republished
                    // "0.00% converted" for a day nobody visited the listing. `null` is stored for
                    // an absent denominator; a measured zero (real views, no installs) still
                    // stores `0` and still plots.
                    overall_conversion_rate: rate(installs, views),
                    ad_attributed_share: rate(ad_clicks, installs),
                    bytes_scanned: (resp.data && resp.data.bytes_scanned) || 0,
                    source_bq_query_id: (resp.data && resp.data.job_id) || ''
                });
            }

            const tally: ListingWriteTally = await upsertFunnelDays(partner_app_id, parsed);
            return resolve(_finishSection('Funnel', resp, {
                rows_fetched: rows.length,
                upserted: tally.upserted + tally.matched,
                write_errors: tally.errors,
                skipped_no_date
            }));
        } catch (error) {
            customConsoleError('Error in bigQuerySyncService._syncFunnel', { error, user_id });
            return resolve(promiseReturnResult(false, {}, error, 'Funnel sync failed.'));
        }
    });
};

const _syncSource = ({ user_id }: IdentityObject, { partner_app_id, tableRef, window }: SectionSyncInput): Promise<ServiceResult<SectionSyncData>> => {
    return new Promise(async (resolve) => {
        try {
            const resp = await runQuery({ user_id }, {
                sql: sourceQuery(tableRef),
                params: { start_yyyymmdd: window.start_yyyymmdd, end_yyyymmdd: window.end_yyyymmdd },
                types: { start_yyyymmdd: 'STRING', end_yyyymmdd: 'STRING' }
            });
            if (!resp.status) {
                return resolve(_sectionQueryFailure(resp));
            }
            const rows = (resp.data && Array.isArray(resp.data.rows)) ? resp.data.rows : [];

            let skipped_no_date = 0;
            const parsed = [];
            for (const row of rows) {
                const date = bqDateToDate(row.date);
                if (!date) {
                    // Counted rather than dropped silently — see _syncFunnel.
                    skipped_no_date += 1;
                    continue;
                }
                parsed.push({
                    date,
                    traffic_source: row.traffic_source || '',
                    traffic_medium: row.traffic_medium || '',
                    users: num(row.users),
                    views: num(row.views),
                    install_clicks: num(row.install_clicks),
                    installs: num(row.installs)
                });
            }

            const tally: ListingWriteTally = await upsertSourceDays(partner_app_id, parsed);
            return resolve(_finishSection('Traffic source', resp, {
                rows_fetched: rows.length,
                upserted: tally.upserted + tally.matched,
                write_errors: tally.errors,
                skipped_no_date
            }));
        } catch (error) {
            customConsoleError('Error in bigQuerySyncService._syncSource', { error, user_id });
            return resolve(promiseReturnResult(false, {}, error, 'Traffic source sync failed.'));
        }
    });
};

const _syncGeo = ({ user_id }: IdentityObject, { partner_app_id, tableRef, window }: SectionSyncInput): Promise<ServiceResult<SectionSyncData>> => {
    return new Promise(async (resolve) => {
        try {
            const resp = await runQuery({ user_id }, {
                sql: geoQuery(tableRef),
                params: { start_yyyymmdd: window.start_yyyymmdd, end_yyyymmdd: window.end_yyyymmdd },
                types: { start_yyyymmdd: 'STRING', end_yyyymmdd: 'STRING' }
            });
            if (!resp.status) {
                return resolve(_sectionQueryFailure(resp));
            }
            const rows = (resp.data && Array.isArray(resp.data.rows)) ? resp.data.rows : [];

            let skipped_no_date = 0;
            const parsed: GeoDayRow[] = [];
            for (const row of rows) {
                const date = bqDateToDate(row.date);
                if (!date) {
                    // Counted rather than dropped silently — see _syncFunnel.
                    skipped_no_date += 1;
                    continue;
                }
                const views = num(row.views);
                const installs = num(row.installs);
                parsed.push({
                    date,
                    country: row.country || '',
                    views,
                    installs,
                    // `rate()` — see the note in `_syncFunnel`. A country bucket with installs and
                    // no views is a real shape in this export, and it must not store `0`.
                    conversion_rate: rate(installs, views)
                });
            }

            const tally: ListingWriteTally = await upsertGeoDays(partner_app_id, parsed);
            return resolve(_finishSection('Geo', resp, {
                rows_fetched: rows.length,
                upserted: tally.upserted + tally.matched,
                write_errors: tally.errors,
                skipped_no_date
            }));
        } catch (error) {
            customConsoleError('Error in bigQuerySyncService._syncGeo', { error, user_id });
            return resolve(promiseReturnResult(false, {}, error, 'Geo sync failed.'));
        }
    });
};

// ── Public ──────────────────────────────────────────────────────────────────

/**
 * The BIGQUERY_SYNC job handler. Pulls GA4 listing data and upserts three daily rollups.
 *
 * Refuses BY NAME when the tier is not configured — it never resolves an empty success, because a
 * sync that "succeeded" over nothing is what leaves a dashboard showing zeros with no explanation.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator, or the sync worker's sentinel.
 * @param params1 - The job payload; every field is optional because a stored payload is unvalidated input.
 * @param params1.partner_app_id - Mongo `_id` of the app row.
 * @param [params1.mode] - AUTO / LIFETIME / INCREMENTAL (default AUTO).
 * @param [params1.lookback_days] - Used only when there is no watermark yet.
 * @returns The run summary, or `{}` when the run never started.
 */
const runDailySync = ({ user_id }: IdentityObject, { partner_app_id, mode, lookback_days }: RunDailySyncInput): Promise<ServiceResult<RunDailySyncData | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'partner_app_id is required.'));
            }

            const availability = resolveBigQueryAvailability();
            if (!availability.enabled) {
                return resolve(promiseReturnResult(false, {}, {}, availability.message));
            }
            if (!isValidFloorDate(config.BIGQUERY.LIFETIME_FLOOR_DATE)) {
                // Refused rather than defaulted. An unparseable floor renders as a `NaNNaNNaN`
                // table suffix, which BigQuery matches no table against — a query that succeeds,
                // costs nothing, and returns zero rows. Silently substituting a default would hide
                // a misconfiguration behind data that looks merely disappointing.
                return resolve(promiseReturnResult(false, {}, {}, `BQ_LIFETIME_FLOOR_DATE is '${config.BIGQUERY.LIFETIME_FLOOR_DATE}', which is not a YYYY-MM-DD date. Fix it before syncing — an unparseable window returns zero rows rather than an error.`));
            }

            const partnerApp = await findSyncTargetApp(partner_app_id);
            if (!partnerApp) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }
            if (!partnerApp.is_active) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app is inactive.'));
            }

            let tableRef;
            try {
                tableRef = buildTableRef({
                    project_id: config.BIGQUERY.PROJECT_ID,
                    dataset: config.BIGQUERY.DATASET,
                    table_pattern: config.BIGQUERY.TABLE_PATTERN
                });
            } catch (idErr) {
                return resolve(promiseReturnResult(false, {}, idErr, `BigQuery identifier validation failed: ${String(readMessage(idErr))}`));
            }

            const _appId = String(partnerApp._id);
            const window = resolveSyncWindow({
                watermark: partnerApp.last_bq_synced_at,
                mode,
                lifetime_floor_date: config.BIGQUERY.LIFETIME_FLOOR_DATE,
                default_lookback_days: config.BIGQUERY.DEFAULT_LOOKBACK_DAYS,
                lookback_days,
                overlap_days: BIGQUERY_INCREMENTAL_OVERLAP_DAYS,
                now: new Date()
            });

            customConsoleLog('BigQuery rollup sync starting', {
                partner_app_id: _appId,
                mode_requested: mode || SYNC_MODES.AUTO,
                resolved_mode: window.resolved_mode,
                start: window.start_iso,
                end: window.end_iso
            });

            const [funnelResp, sourceResp, geoResp] = await Promise.all([
                _syncFunnel({ user_id }, { partner_app_id: _appId, tableRef, window }),
                _syncSource({ user_id }, { partner_app_id: _appId, tableRef, window }),
                _syncGeo({ user_id }, { partner_app_id: _appId, tableRef, window })
            ]);

            // One uniform, machine-queryable digest of all three sections. It answers the three
            // questions a "the card is empty" report actually poses — did the query return nothing
            // (rows=0), are the writes failing (rows>0 upserted=0), or is the read window wrong (the
            // window is printed alongside) — without opening the database.
            const _diagnostic = [
                `window=${window.start_yyyymmdd}..${window.end_yyyymmdd}(${window.resolved_mode})`,
                _sectionDigest('funnel', funnelResp),
                _sectionDigest('source', sourceResp),
                _sectionDigest('geo', geoResp)
            ].join(' | ');

            const _summary: RunDailySyncData = {
                partner_app_id: _appId,
                mode: window.resolved_mode,
                start: window.start_iso,
                end: window.end_iso,
                funnel: funnelResp && funnelResp.data ? funnelResp.data : null,
                source: sourceResp && sourceResp.data ? sourceResp.data : null,
                geo: geoResp && geoResp.data ? geoResp.data : null,
                funnel_ok: !!(funnelResp && funnelResp.status),
                source_ok: !!(sourceResp && sourceResp.status),
                geo_ok: !!(geoResp && geoResp.status),
                diagnostic: _diagnostic
            };

            customConsoleLog('BigQuery rollup sync outcome', {
                partner_app_id: _appId,
                diagnostic: _diagnostic
            });

            // ⚠️ The watermark advances only on a fully successful run. `resolveSyncWindow` reads it
            // to pick LIFETIME vs INCREMENTAL, so stamping it after a failed pull would permanently
            // skip the lifetime backfill.
            if (!_summary.funnel_ok || !_summary.source_ok || !_summary.geo_ok) {
                const failMsg = [
                    !_summary.funnel_ok && (funnelResp && funnelResp.msg),
                    !_summary.source_ok && (sourceResp && sourceResp.msg),
                    !_summary.geo_ok && (geoResp && geoResp.msg)
                ].filter(Boolean).join(' | ');
                // The digest is appended to the MESSAGE, not left in `data`, because a failed job
                // stores only its error text — anything left in the payload is lost on exactly the
                // runs that need explaining.
                return resolve(promiseReturnResult(false, _summary, {}, `${failMsg || 'BigQuery sync partially failed.'} || ${_diagnostic}`));
            }

            await stampRollupWatermark(_appId, new Date());

            return resolve(promiseReturnResult(true, _summary, {}, 'BigQuery sync completed.'));
        } catch (error) {
            customConsoleError('Error in bigQuerySyncService.runDailySync', { error, user_id });
            return resolve(promiseReturnResult(false, {}, error, 'BigQuery sync failed.'));
        }
    });
};

export = {
    runDailySync
};
