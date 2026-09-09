/**
 * The model registry — the single import point for every mongoose model in the application.
 *
 *  ONLY `repositories/` may import this. Services, helpers and controllers go through a
 * repository; a helper that reaches a model has stopped being pure, and a service that reaches one
 * has moved data access into the layer that is supposed to be testable without a database.
 *
 * WHY A REGISTRY AT ALL, rather than each repository importing the model file it needs: requiring
 * this file registers EVERY schema with mongoose in one go. A `ref` is resolved lazily by model
 * NAME at populate time, so a model whose file was never required does not exist yet, and the
 * populate fails with `MissingSchemaError: Schema hasn't been registered for model "…"` — at run
 * time, on whichever endpoint happened to be the first to populate that path. Registering the whole
 * set together makes that ordering question disappear.
 *
 * ⚠️ ENUMERATE EVERY KEY. Never spread a model module into this object: a spread makes the export
 * surface unreadable statically, so nothing can check that a model still exports what its consumers
 * destructure — and a dropped model surfaces as `undefined` at the destructure, not as an error.
 */

// Each model module ends in an export assignment, so it is imported whole (a named import would be
// TS2497) and its member picked out below.
import partnerAppModel = require('./partner/partnerApp.model');
import partnerAppEventModel = require('./partner/partnerAppEvent.model');
import partnerAppTransactionModel = require('./partner/partnerAppTransaction.model');
import listingFunnelDailyModel = require('./listing/listingFunnelDaily.model');
import listingSourceDailyModel = require('./listing/listingSourceDaily.model');
import listingGeoDailyModel = require('./listing/listingGeoDaily.model');
import listingInstallAttributionModel = require('./listing/listingInstallAttribution.model');
import syncJobModel = require('./sync/syncJob.model');
import adminUserModel = require('./auth/adminUser.model');

export = {
    /** The Shopify app this deployment reports on, plus its sync watermarks and coverage gates. */
    PartnerApp: partnerAppModel.PartnerApp,
    /** Relationship and billing events from the Partner API — the spine every fold runs over. */
    PartnerAppEvent: partnerAppEventModel.PartnerAppEvent,
    /** Settled payouts from the Partner API. Cash, never run-rate. */
    PartnerAppTransaction: partnerAppTransactionModel.PartnerAppTransaction,
    /**
     * Listing-analytics daily rollup: one row per (app, day). Counts VISITORS, not shops — the
     * population seam every ratio crossing into the Partner API side has to declare.
     */
    ListingFunnelDaily: listingFunnelDailyModel.ListingFunnelDaily,
    /** The same day, split by traffic source/medium. FIRST-EVER acquisition scope, not last click. */
    ListingSourceDaily: listingSourceDailyModel.ListingSourceDaily,
    /** The same day, split by country. `country` is a full name from the export, not an ISO code. */
    ListingGeoDaily: listingGeoDailyModel.ListingGeoDaily,
    /**
     * One row per install event — the only per-store record the listing side has, and the bridge
     * from listing analytics to the Partner event spine via the normalised `shop_domain`.
     */
    ListingInstallAttribution: listingInstallAttributionModel.ListingInstallAttribution,
    /** Background runs. This collection is the queue, not a log of one. */
    SyncJob: syncJobModel.SyncJob,
    /** Operators who may log in to this deployment. */
    AdminUser: adminUserModel.AdminUser
};
