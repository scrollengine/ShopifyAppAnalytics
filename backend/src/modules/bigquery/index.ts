'use strict';

/**
 * ============================================================================
 *  BIGQUERY — module barrel
 * ============================================================================
 *
 *  The two job handlers the sync runner registers, the three reads the
 *  controllers serve, and the availability probe anything enqueueing work
 *  should check first.
 *
 *  Barrel rules — deep-path imports inside the folder, every key enumerated,
 *  `export =` never `export default` — are stated once in IMPLEMENTATION.md §3.13
 *  and asserted by test/exportSurface.test.js.
 *  Deep-path matters more than usual here: the barrel pulls in
 *  `@google-cloud/bigquery`, which a read that never leaves Mongo has no
 *  business loading.
 *
 *  Not exported, deliberately:
 *    - the repositories THEMSELVES. ONE read is published below by name, with
 *      its reasoning on it: a single named aggregation costs less than a second
 *      definition of the same figure in another module. It is a named read, not
 *      a door into this module's data layer;
 *    - `clients/bigQuery.client` — an arbitrary caller running arbitrary SQL is
 *      a billed scan this module cannot bound. The two sync services are the
 *      only things that should be querying;
 *    - the helpers — pure, imported by deep path from tests. Publishing them
 *      invites a second caller to re-implement a decision this module owns.
 * ============================================================================
 */

import bigQueryAnalyticsService = require('./services/bigQueryAnalytics.service');
import bigQuerySyncService = require('./services/bigQuerySync.service');
import installAttributionSyncService = require('./services/installAttributionSync.service');
import bigQueryAvailabilityResolver = require('./resolvers/bigQueryAvailability.resolver');
import listingRollupRepository = require('./repositories/listingRollup.repository');

export = {
    /**
     * Whether the tier is configured, and the operator-facing reason when it is not.
     *
     * Check this BEFORE enqueuing either job or scheduling either cron. A job that fails on a
     * missing credential every night is not a diagnostic; it is noise that teaches an operator to
     * stop reading the log.
     */
    resolveBigQueryAvailability: bigQueryAvailabilityResolver.resolveBigQueryAvailability,

    /** The BIGQUERY_SYNC job handler: pulls the three daily listing rollups. */
    runDailySync: bigQuerySyncService.runDailySync,
    /** The INSTALL_ATTRIBUTION_SYNC job handler: one row per install, with its store and surface. */
    syncInstallAttribution: installAttributionSyncService.syncInstallAttribution,

    /** Daily funnel rollup plus summary KPIs. Counts VISITORS, not shops. */
    getFunnelData: bigQueryAnalyticsService.getFunnelData,
    /** Source/medium breakdown. FIRST-EVER acquisition scope — not the visit that converted. */
    getTrafficSourceBreakdown: bigQueryAnalyticsService.getTrafficSourceBreakdown,
    /** Per-country traffic breakdown. Traffic by country, never revenue by country. */
    getGeoBreakdown: bigQueryAnalyticsService.getGeoBreakdown,

    /**
     * Window totals for the listing funnel rollup — the SUMMED counts behind every `source: 'ga4'`
     * step of `GET /api/conversion/custom-funnel`.
     *
     * PUBLISHED SO THE CONVERSION FUNNEL CANNOT GROW A SECOND DEFINITION OF THE SAME FIGURE.
     * Two reconstructions of one number is the exact failure `IMPLEMENTATION.md` §3.10 records for
     * MRR, where two pages built it independently and disagreed with each other on screen. The
     * alternative here was a `$group` over `gi_listing_funnel_dailies` in `modules/conversion`,
     * summing the same ten fields — and the day one of them is renamed, one copy is fixed.
     *
     * ⚠️ IT RETURNS `null`, NOT A ZEROED ROW, when the window contains no rollup row: `$group`
     * emits no document. PRESERVE THAT NULL. It is the discriminator between "the rollup has
     * nothing for these days" and "these days had no traffic", and the two must not render alike —
     * one is an em dash, the other is a bar at zero.
     *
     * ⚠️ It reads the ROLLUP, not BigQuery. Nothing on a request path may start a billed scan.
     */
    aggregateListingFunnelTotals: listingRollupRepository.aggregateFunnelTotals
};
