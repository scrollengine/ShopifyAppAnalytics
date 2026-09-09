'use strict';

/**
 * ============================================================================
 *  PER-INSTALL ATTRIBUTION — which store installed, and where it came from
 * ============================================================================
 *
 *  WHAT THIS ADDS
 *  --------------
 *  The three daily rollups answer "3 installs came from chatgpt.com on the 14th". They can never
 *  answer "WHICH store", because their SQL aggregates the visitor away
 *  (`COUNT(DISTINCT user_pseudo_id)`) and never touches `event_params`.
 *
 *  Shopify sends `shopify_app_install` SERVER-SIDE through the GA4 Measurement Protocol with
 *  `api_key`, `shop_id`, `shop_name` and `shop_url` as event parameters. `shop_url` is a store
 *  identity. It sits in the BigQuery export the whole time — the rollup SQL simply discards it. So
 *  this is a BACKFILLABLE gap: a LIFETIME run recovers attribution for every historical install back
 *  to the lifetime floor date. Nothing had to be captured on our side.
 *
 *  WHY A SEPARATE JOB FROM runDailySync
 *  ------------------------------------
 *  This query must read the whole `event_params` repeated column, which the other three do not — it
 *  is a materially more expensive scan, and each BigQuery job carries its own independent
 *  `maximumBytesBilled` ceiling. Folding it into `runDailySync` would also make it gate that job's
 *  watermark, so one expensive failure would force the three cheap rollups to re-run their LIFETIME
 *  backfill forever. It therefore owns its own watermark (`last_install_attrib_synced_at`) and its
 *  own failure domain.
 *
 *  THE READ-ONLY GUARD SCANS INSIDE STRING LITERALS
 *  ------------------------------------------------
 *  `isReadOnlySql` runs its forbidden-keyword scan over the whole cleaned SQL, string literals
 *  included. A predicate like `WHERE shop_name = 'Drop Anchor Supply'` is BLOCKED, because `drop` is
 *  a forbidden statement keyword — and that is exactly the shape merchant-supplied free text takes.
 *  Any value that could contain English words MUST travel as a query parameter, never inlined. (The
 *  `UNNEST(event_params)` extraction itself passes.)
 *
 *  TWO SURFACE MECHANISMS — AND ONLY THEIR UNION SEES ORGANIC
 *  ----------------------------------------------------------
 *  This job originally stitched the App Store surface from `shopify_app_ad_click` alone. That event
 *  fires on an AD click, so every surface it can ever produce is a paid one — which is why a
 *  production dataset of 2,856 installs held 272 `search_ad` + 47 `homepage_ad` and not one organic
 *  row, while 2,537 installs carried no surface at all.
 *
 *  The organic half arrives a different way: Shopify appends `surface_type`, `surface_detail`,
 *  `surface_inter_position`, `surface_intra_position` and `locale` to the LISTING URL on every App
 *  Store referral, so a plain `page_view` carries the surface for a merchant who never touched an
 *  ad. Those installs are not "direct" — GA4 files them under `(direct)/(none)` because the App
 *  Store and the listing share the `apps.shopify.com` host, making the click a SAME-SITE navigation
 *  with no referrer. The surface params are the only thing that can open that bucket, and it is the
 *  bucket holding ~94% of installs.
 *
 *  Both mechanisms feed one `surface_touches` CTE and the last touch before the install wins.
 *  `surface_via` records which one produced the stored row, so "no organic traffic" and "the organic
 *  half is not being read" can never look alike again.
 *
 *  ATTRIBUTION SCOPES ARE NOT INTERCHANGEABLE
 *  ------------------------------------------
 *  GA4 exposes several, and they answer different questions:
 *    `traffic_source.*`           — how the USER was FIRST EVER acquired. Google: "do not change if
 *                                   the user interacts with subsequent campaigns". This is what the
 *                                   source rollup uses, so that table means first-touch, not
 *                                   converting-visit.
 *    `collected_traffic_source.*` — the source collected ON THIS EVENT. Closest to "where did this
 *                                   install come from", so it is preferred here.
 *  Both are stored, and `attribution_source` records which one produced the row's values, so a
 *  first-touch number can never be silently read as a converting-visit number.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import constants = require('../constants/bigQuery.constants');
import sqlHelper = require('../helpers/bigQuerySql.helper');
import rowHelper = require('../helpers/bigQueryRow.helper');
import syncWindowHelper = require('../helpers/syncWindow.helper');
import attributionHelper = require('../helpers/installAttribution.helper');
import availabilityResolver = require('../resolvers/bigQueryAvailability.resolver');
import bigQueryClient = require('../clients/bigQuery.client');
import syncStateRepository = require('../repositories/bigQuerySyncState.repository');
import installAttributionRepository = require('../repositories/installAttribution.repository');
// The join key, shared with every consumer so both sides of a join normalise identically.
import shopDomainHelper = require('../../shared/helpers/shopDomain.helper');
// Paid/organic classification, shared with every reader so the value written here is
// byte-identical to the one a filter looks for.
import surfaceConstants = require('../../shared/constants/surface.constants');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type {
    InstallAttributionRow,
    SyncInstallAttributionData,
    SyncInstallAttributionInput
} from '../types/bigQuery.types';

const { customConsoleLog, customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { BIGQUERY_INCREMENTAL_OVERLAP_DAYS } = constants;
const { buildTableRef, installAttributionQuery } = sqlHelper;
const { bqToDate, str, num, readMessage } = rowHelper;
const { isValidFloorDate, resolveSyncWindow } = syncWindowHelper;
const { resolveAttribution, resolveSurface } = attributionHelper;
const { resolveBigQueryAvailability } = availabilityResolver;
const { runQuery } = bigQueryClient;
const { findSyncTargetApp, stampInstallAttributionWatermark } = syncStateRepository;
const { bulkUpsertInstallAttributions } = installAttributionRepository;
const { normaliseShopDomain } = shopDomainHelper;
const { isPaidPlacement } = surfaceConstants;

/** What the run counts as it goes, beyond the row tallies the repository returns. */
interface AttributionRunStats {
    by_attribution_source: Record<string, number>;
    /**
     * Which MECHANISM produced each surface.
     *
     * The single most useful number on a re-sync: `listing_url` staying at zero means the organic
     * half is still not being read, which is indistinguishable from "this app gets no organic
     * traffic" in every other figure on the page.
     */
    by_surface_via: Record<string, number>;
    with_surface: number;
    paid_surface: number;
    organic_surface: number;
}

/**
 * Pulls per-install attribution from the GA4 export into `gi_listing_install_attributions`, one row
 * per install event.
 *
 * Refuses BY NAME when the tier is not configured, rather than resolving an empty success. A
 * "successful" run over nothing is what makes an unattributed dashboard look like a merchant
 * problem instead of a missing credential.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator, or the sync worker's sentinel.
 * @param params1 - The job payload; every field is optional because a stored payload is unvalidated input.
 * @param params1.partner_app_id - Mongo `_id` of the app row.
 * @param [params1.mode] - AUTO | LIFETIME | INCREMENTAL.
 * @param [params1.lookback_days] - Window when there is no watermark yet.
 * @param [params1.include_collected_source] - Set false if the export predates collected_traffic_source.
 * @param [params1.dry_run] - Validate and price the query without executing or writing. Billed at zero.
 * @param [params1.sync_job_id] - Recorded on every row for provenance.
 * @returns The run summary, or `{}` when the run never started.
 */
const syncInstallAttribution = ({ user_id }: IdentityObject, {
    partner_app_id,
    mode,
    lookback_days,
    include_collected_source = true,
    dry_run = false,
    sync_job_id = ''
}: SyncInstallAttributionInput): Promise<ServiceResult<SyncInstallAttributionData | EmptyPayload>> => {
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
                // See the identical guard in bigQuerySyncService: an unparseable floor produces a
                // window BigQuery matches no table against — zero rows, no error, no cost.
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
            // ⚠️ Resolved from this job's OWN watermark. Deliberately separate from the rollup one:
            // attribution can be backfilled LIFETIME without forcing the three cheap rollups to
            // re-scan, and a failure here never rewinds them. The install event is server-side and
            // can land late, so the overlap matters more here than on the browser-side rollups.
            const window = resolveSyncWindow({
                watermark: partnerApp.last_install_attrib_synced_at,
                mode,
                lifetime_floor_date: config.BIGQUERY.LIFETIME_FLOOR_DATE,
                default_lookback_days: config.BIGQUERY.DEFAULT_LOOKBACK_DAYS,
                lookback_days,
                overlap_days: BIGQUERY_INCREMENTAL_OVERLAP_DAYS,
                now: new Date()
            });

            customConsoleLog('Install-attribution sync starting', {
                partner_app_id: _appId,
                resolved_mode: window.resolved_mode,
                start: window.start_iso,
                end: window.end_iso
            });

            const resp = await runQuery({ user_id }, {
                sql: installAttributionQuery(tableRef, { include_collected_source }),
                params: { start_yyyymmdd: window.start_yyyymmdd, end_yyyymmdd: window.end_yyyymmdd },
                types: { start_yyyymmdd: 'STRING', end_yyyymmdd: 'STRING' },
                dry_run
            });
            if (!resp.status) {
                // A schema-shaped rejection is worth naming: the most likely cause by far is an
                // export that predates collected_traffic_source, which the caller can switch off.
                let msg = resp.msg || 'BigQuery install-attribution query failed.';
                if (include_collected_source && /collected_traffic_source/i.test(JSON.stringify(resp.error || ''))) {
                    msg = `${msg} — the export may not have collected_traffic_source; retry with include_collected_source: false.`;
                }
                return resolve(promiseReturnResult(false, {}, resp.error, msg));
            }

            // A dry run prices the scan and writes nothing — return the estimate before the
            // watermark can move, so costing a LIFETIME backfill never advances it.
            if (dry_run) {
                return resolve(promiseReturnResult(true, {
                    partner_app_id: _appId,
                    mode: window.resolved_mode,
                    start: window.start_iso,
                    end: window.end_iso,
                    ...resp.data
                }, {}, 'Dry run completed — no bytes billed, nothing written.'));
            }

            const rows = (resp.data && Array.isArray(resp.data.rows)) ? resp.data.rows : [];

            const parsed: InstallAttributionRow[] = [];
            let skippedNoDomain = 0;
            const stats: AttributionRunStats = {
                by_attribution_source: {},
                by_surface_via: {},
                with_surface: 0,
                paid_surface: 0,
                organic_surface: 0
            };

            for (const row of rows) {
                const shop_domain = normaliseShopDomain(row.shop_url);
                const installed_at = bqToDate(row.installed_at);
                if (!shop_domain || !installed_at) {
                    // No identity or no instant means the row cannot be keyed or joined. Counted,
                    // never silently dropped — a rising count here is the signal that Shopify
                    // changed the parameter.
                    skippedNoDomain += 1;
                    continue;
                }

                const attribution = resolveAttribution(row);
                stats.by_attribution_source[attribution.attribution_source] =
                    (stats.by_attribution_source[attribution.attribution_source] || 0) + 1;

                const surface = resolveSurface(row);
                if (surface.surface_type !== '') {
                    stats.with_surface += 1;
                    // Reads the DETAIL as well as the surface name: `home` + `homepage-ads` is the
                    // homepage ad placement seen through the listing URL, and outnumbers the
                    // `homepage_ad` spelling ~16:1. See shared/constants/surface.constants.
                    if (isPaidPlacement(surface.surface_type, surface.surface_detail)) {
                        stats.paid_surface += 1;
                    } else {
                        stats.organic_surface += 1;
                    }
                    stats.by_surface_via[surface.surface_via || 'unknown'] =
                        (stats.by_surface_via[surface.surface_via || 'unknown'] || 0) + 1;
                }

                parsed.push({
                    shop_domain,
                    shop_url_raw: str(row.shop_url),
                    shop_id: str(row.shop_id),
                    shop_name: str(row.shop_name),
                    installed_at,
                    install_date: bqToDate(row.install_date) || installed_at,
                    user_pseudo_id: str(row.user_pseudo_id),
                    source: attribution.source,
                    medium: attribution.medium,
                    campaign: attribution.campaign,
                    attribution_source: attribution.attribution_source,
                    surface_type: surface.surface_type,
                    surface_detail: surface.surface_detail,
                    surface_inter_position: surface.surface_inter_position,
                    surface_intra_position: surface.surface_intra_position,
                    surface_via: surface.surface_via,
                    surface_version: surface.surface_version,
                    ad_clicks_before_install: num(row.ad_clicks_before_install),
                    country: str(row.country),
                    locale: surface.locale,
                    sync_job_id: str(sync_job_id)
                });
            }

            const tally = await bulkUpsertInstallAttributions(_appId, parsed);

            const _summary: SyncInstallAttributionData = {
                partner_app_id: _appId,
                mode: window.resolved_mode,
                start: window.start_iso,
                end: window.end_iso,
                rows_fetched: rows.length,
                upserted: tally.upserted + tally.matched,
                skipped_no_shop_url: skippedNoDomain,
                write_errors: tally.errors,
                attribution_breakdown: stats.by_attribution_source,
                with_app_store_surface: stats.with_surface,
                paid_surface_installs: stats.paid_surface,
                organic_surface_installs: stats.organic_surface,
                surface_via_breakdown: stats.by_surface_via,
                bytes_scanned: (resp.data && resp.data.bytes_scanned) || 0
            };

            // A run that returned zero install rows is REPORTED, not celebrated. The overwhelmingly
            // likely cause is the Measurement Protocol API secret being unset on the listing, in
            // which case `shopify_app_install` never reached GA4 at all and no amount of re-running
            // will help — so say that here rather than leaving an empty page to explain itself.
            if (rows.length === 0) {
                _summary.warning = 'No shopify_app_install events found in the window. If this is unexpected, check that the Measurement Protocol API secret is set on the Partner Dashboard listing — without it Shopify never sends the server-side install event.';
            }

            // ⚠️ Own watermark, advanced only on a clean run — the same discipline the rollup sync
            // uses, and for the same reason: stamping after a partial pull permanently skips a
            // lifetime backfill.
            if (tally.errors === 0) {
                await stampInstallAttributionWatermark(_appId, new Date());
            }

            customConsoleLog('Install-attribution sync completed', _summary);
            return resolve(promiseReturnResult(true, _summary, {}, 'Install attribution synced.'));
        } catch (error) {
            customConsoleError('Error in installAttributionSyncService.syncInstallAttribution', { error, user_id });
            return resolve(promiseReturnResult(false, {}, error, 'Install attribution sync failed.'));
        }
    });
};

export = {
    syncInstallAttribution
};
