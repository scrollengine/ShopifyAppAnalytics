'use strict';

/**
 * ============================================================================
 *  SYNC HEALTH — the nine collections, and what an empty one means
 * ============================================================================
 *
 *  ──  NINE. NOT TWELVE, NOT WHATEVER THE SOURCE DASHBOARD HAD ──────────────
 *
 *  This registry lists EXACTLY the collections `src/models/index.ts` registers,
 *  and `test/syncJobs.test.js` asserts that correspondence in both directions.
 *  That assertion is the point of the file.
 *
 *  A health screen reporting a collection this build does not have is worse than
 *  one that omits it: `keyword_snapshots: 0 rows` is not a missing feature, it
 *  is a MEASUREMENT — it says the collection exists and is empty, which sends an
 *  operator looking for the sync that is failing to fill it. There is no such
 *  sync. The row is fiction with a number attached, and a number is exactly what
 *  makes fiction credible.
 *
 *  ADDING A COLLECTION: add its model to `src/models/index.ts`, publish it in
 *  `shared/repositories/models.repository`, read it in `syncHealth.repository`,
 *  and add its row HERE with the watermark that governs it. The test fails until
 *  all four agree.
 *
 *  ──  THE WATERMARK, NOT THE ROW COUNT, DECIDES WHAT EMPTY MEANS ───────────
 *
 *  Zero rows in `gi_partner_app_events` has two completely different readings —
 *  "this app has genuinely never had an install" and "no sync has ever run" —
 *  and the rows alone cannot tell them apart. The `watermark` field named on
 *  each entry is what separates them: null watermark and no rows is
 *  NEVER_SYNCED, a set watermark and no rows is EMPTY (we looked, there was
 *  nothing). Publishing both as `0 rows` is how a dashboard reports a healthy
 *  business as a dead one, or an outage as a quiet week.
 * ============================================================================
 */

/**
 * Which upstream a collection belongs to. It decides what an empty one is allowed to mean.
 *
 * `LISTING` exists as its own tier because BigQuery is OPTIONAL: an install that never configured it
 * is an ordinary install, and reporting its four empty collections as NEVER_SYNCED would describe a
 * deliberate choice as a fault.
 */
const HEALTH_COLLECTION_TIERS = Object.freeze({
    /** Written by an operator or by boot, never by a sync. Empty means "not set up". */
    CONFIG: 'CONFIG',
    /** Filled by PARTNER_SYNC, from the Shopify Partner API. The mandatory tier. */
    PARTNER: 'PARTNER',
    /** Filled by BIGQUERY_SYNC / INSTALL_ATTRIBUTION_SYNC. OPTIONAL — absent is not broken. */
    LISTING: 'LISTING',
    /** This application's own machinery. Empty means it has never been asked to do anything. */
    SYSTEM: 'SYSTEM'
});

/**
 * What a collection's row count means, once the watermark has been consulted.
 *
 * ⚠️ Five states rather than a boolean, because the four ways of being empty need four different
 * actions from the operator, and collapsing them into "empty" tells them to do nothing.
 */
const HEALTH_COLLECTION_STATES = Object.freeze({
    /** Rows are present. Whatever fills this has run and written something. */
    READY: 'READY',
    /** No rows, and the watermark is null: nothing has ever filled this. */
    NEVER_SYNCED: 'NEVER_SYNCED',
    /** No rows, but the watermark is SET. A sync ran and genuinely found nothing. */
    EMPTY: 'EMPTY',
    /** The listing tier is not configured, so nothing could have written here. Not a fault. */
    NOT_CONNECTED: 'NOT_CONNECTED',
    /** A CONFIG collection with no rows: an operator has not set this up yet. */
    NOT_CONFIGURED: 'NOT_CONFIGURED'
});

/**
 * The nine collections this build has, each with the watermark that governs its emptiness.
 *
 * `watermark` names a field on the partner-app row, or `''` when no watermark governs the collection
 * — which is itself a statement, and the state resolver branches on it rather than guessing.
 *
 * `collection` is the PHYSICAL collection name, stated so an operator reading this screen can open
 * the right thing in a database client without having to map model names onto it.
 */
const HEALTH_COLLECTIONS = Object.freeze([
    {
        key: 'partner_apps',
        collection: 'gi_partner_apps',
        label: 'Partner apps',
        tier: HEALTH_COLLECTION_TIERS.CONFIG,
        watermark: '',
        /** What this collection holds, in the reader's terms rather than the schema's. */
        holds: 'the Shopify app this deployment reports on, plus its sync watermarks and coverage gates'
    },
    {
        key: 'partner_app_events',
        collection: 'gi_partner_app_events',
        label: 'Partner events',
        tier: HEALTH_COLLECTION_TIERS.PARTNER,
        watermark: 'last_synced_at',
        holds: 'installs, uninstalls and subscription events — the spine every other figure is folded from'
    },
    {
        key: 'partner_app_transactions',
        collection: 'gi_partner_app_transactions',
        label: 'Partner payouts',
        tier: HEALTH_COLLECTION_TIERS.PARTNER,
        //  The SAME watermark as the events, because one PARTNER_SYNC writes both halves and
        // advances one marker. `earliest_transaction_at` is NOT the watermark: it is
        // `$min(created_at)` over the rows, so it is a row count in disguise and would report "never
        // synced" for an app that has genuinely never been paid.
        watermark: 'last_synced_at',
        holds: 'settled payouts — cash that actually moved, never a run rate'
    },
    {
        key: 'listing_funnel_daily',
        collection: 'gi_listing_funnel_dailies',
        label: 'Listing daily rollup',
        tier: HEALTH_COLLECTION_TIERS.LISTING,
        watermark: 'last_bq_synced_at',
        holds: 'listing views, install clicks and installs per day, from the GA4 BigQuery export'
    },
    {
        key: 'listing_source_daily',
        collection: 'gi_listing_source_dailies',
        label: 'Listing rollup by source',
        tier: HEALTH_COLLECTION_TIERS.LISTING,
        watermark: 'last_bq_synced_at',
        holds: 'the same days split by traffic source and medium'
    },
    {
        key: 'listing_geo_daily',
        collection: 'gi_listing_geo_dailies',
        label: 'Listing rollup by country',
        tier: HEALTH_COLLECTION_TIERS.LISTING,
        watermark: 'last_bq_synced_at',
        holds: 'the same days split by country'
    },
    {
        key: 'listing_install_attribution',
        collection: 'gi_listing_install_attributions',
        label: 'Install attribution',
        tier: HEALTH_COLLECTION_TIERS.LISTING,
        //  Its OWN watermark, deliberately not `last_bq_synced_at`. Attribution reads the whole
        // event-parameter column, so it is a far heavier scan with its own failure domain: the
        // rollups can be perfectly up to date while this has never run once, and sharing a watermark
        // would report it as fresh.
        watermark: 'last_install_attrib_synced_at',
        holds: 'one row per install answering which store, and where it came from'
    },
    {
        key: 'sync_jobs',
        collection: 'gi_sync_jobs',
        label: 'Background jobs',
        tier: HEALTH_COLLECTION_TIERS.SYSTEM,
        watermark: '',
        holds: 'every background run this deployment has made. This collection IS the queue, not a log of one'
    },
    {
        key: 'admin_users',
        collection: 'gi_admin_users',
        label: 'Operator accounts',
        tier: HEALTH_COLLECTION_TIERS.CONFIG,
        watermark: '',
        holds: 'the accounts that may sign in to this deployment'
    }
]);

export = {
    HEALTH_COLLECTION_TIERS,
    HEALTH_COLLECTION_STATES,
    HEALTH_COLLECTIONS
};
