'use strict';

/**
 * ============================================================================
 *  PARTNER — module barrel
 * ============================================================================
 *
 *  The public surface of this module. Controllers, routes, the job runner and
 *  other modules import from here.
 *
 *  Barrel rules — deep-path imports inside the folder, every key enumerated,
 *  `export =` never `export default` — are stated once in IMPLEMENTATION.md §3.13
 *  and asserted by test/exportSurface.test.js.
 *
 *  Not exported, deliberately: the repositories (nothing outside a module may
 *  reach another module's data access) and `helpers/coverage.helper` — the sync
 *  is the only thing that should be measuring coverage, and a caller computing
 *  its own would produce a second, disagreeing set of gates.
 * ============================================================================
 */

import partnerApiClient = require('./clients/partnerApi.client');
import partnerAppService = require('./services/partnerApp.service');
import partnerAppAdminService = require('./services/partnerAppAdmin.service');
import partnerAppEventsService = require('./services/partnerAppEvents.service');
import partnerAppKpiService = require('./services/partnerAppKpi.service');
import partnerSyncService = require('./services/partnerSync.service');

export = {
    /** One read-only GraphQL call against the Partner API. Mutations are refused before dispatch. */
    runQuery: partnerApiClient.runQuery,
    /** Auto-paginated read-only walk over a Partner API connection. */
    fetchAllPages: partnerApiClient.fetchAllPages,

    /** Idempotently creates the app row named by SHOPIFY_PARTNER_APP_ID. */
    registerPartnerAppFromConfig: partnerAppService.registerPartnerAppFromConfig,
    /** Registered apps, with their sync watermarks and coverage gates. */
    listPartnerApps: partnerAppService.listPartnerApps,
    /** One app by `_id`, with the same coverage gates. */
    getPartnerAppById: partnerAppService.getPartnerAppById,

    /**
     * Display metadata only.
     *
     *  REFUSES `partner_api_app_id` AND EVERY WATERMARK OR COVERAGE GATE, and refuses the WHOLE
     * call rather than skipping the field. Changing which Shopify app a row names would relabel
     * several million stored facts as another app's history, with no repair and no way to detect it
     * afterwards; typing in a gate would switch the honesty layer off by hand.
     */
    updatePartnerApp: partnerAppAdminService.updatePartnerApp,
    /**
     * The soft delete: sets `is_active: false` and REMOVES NOTHING.
     *
     *  There is no hard delete on this module and there must not be one. A cascading delete would
     * destroy the entire factual basis of every figure this deployment has published; a
     * non-cascading one would orphan those rows behind an id that resolves to nothing, which reads
     * exactly like a business with no customers. The payload states what was retained and how to
     * reverse it.
     */
    deactivatePartnerApp: partnerAppAdminService.deactivatePartnerApp,

    /**
     * The Partner Apps page's KPI tiles and install chart, over a window.
     *
     * Every figure is a BARE NUMBER or `null` — never a confidence envelope, because `AppKpiCards`
     * formats with `Number(n)` and would render every tile as an em dash. Money comes from
     * `modules/revenue`'s own readers and install state from `modules/store`'s canonical fold;
     * nothing in it computes either a second time.
     */
    getPartnerAppKpi: partnerAppKpiService.getPartnerAppKpi,
    /**
     * One page of raw Partner events, plus the install trend over the same window.
     *
     *  A trend bucket with no measurable value publishes `null`, never `0` — the chart breaks its
     * line rather than running it along the floor over a stretch nobody fetched.
     */
    getPartnerAppEvents: partnerAppEventsService.getPartnerAppEvents,

    /**
     * The PARTNER_SYNC job handler: pulls events + transactions, then measures coverage.
     *
     * Registrable directly with the job runner — its signature is the ordinary service signature,
     * and every field of its payload is optional because a stored payload is unvalidated input.
     */
    runFullSync: partnerSyncService.runFullSync
};
