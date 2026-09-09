'use strict';

/**
 * ============================================================================
 *   NEITHER STORE ENDPOINT MAY REFUSE BECAUSE BIGQUERY IS UNCONFIGURED
 * ============================================================================
 *
 *  The listing tier is OPTIONAL. The roster and the store record both come from the Partner API and
 *  are complete without a single attribution row — only the acquisition columns and the
 *  install-traffic country are empty, and both say so.
 *
 *  A refusal here is wrong TWICE. On the Stores page it renders as "no stores", which is a claim
 *  about the operator's install base that no data made. In the drawer it renders as a critical
 *  banner titled "Not available" over a store the Partner API describes perfectly well. Both look
 *  exactly like a working install of a tool that has decided your business does not exist.
 *
 *  ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
 *
 *  `src/config` snapshots `process.env` AT FIRST REQUIRE, so one process cannot exercise both tier
 *  states: `storeRoster.test.js` and `storeDetail.test.js` set the three BigQuery variables before
 *  requiring anything, and this file deletes them before requiring anything. Node's test runner gives
 *  each file its own process, which is the only reason both are testable at all.
 *
 *  ⚠️ THE DELETES MUST STAY ABOVE EVERY REQUIRE. A `require` of the config anywhere earlier — even
 *  transitively, through a repository — freezes the snapshot and this file silently tests the READY
 *  path while claiming to test the unconfigured one.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';
delete process.env.GCP_PROJECT_ID;
delete process.env.BQ_DATASET;
delete process.env.GCP_SERVICE_ACCOUNT_JSON;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mongoose = require('mongoose');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const MODULE_ROOT = path.join(BACKEND_ROOT, 'src', 'modules', 'store');

mongoose.set('bufferTimeoutMS', 400);

const config = require(path.join(BACKEND_ROOT, 'src', 'config'));
const rosterRepository = require(path.join(MODULE_ROOT, 'repositories', 'storeRoster.repository.ts'));
const detailRepository = require(path.join(MODULE_ROOT, 'repositories', 'storeDetail.repository.ts'));

const NOW = Date.now();
const _daysAgo = (days) => new Date(NOW - (days * 86400000));

const SHOP = 'lonely-shop.myshopify.com';

const APP = {
    _id: 'app-1',
    display_name: 'Demo App',
    listing_url: 'https://apps.shopify.com/demo',
    last_synced_at: _daysAgo(1),
    // Never set, and it must not matter: with the tier off, the attribution watermark is not the
    // reason the columns are empty and must not be reported as though it were.
    last_install_attrib_synced_at: null,
    earliest_event_at: _daysAgo(400),
    earliest_transaction_at: _daysAgo(390),
    lifetime_sync_completed_at: _daysAgo(2),
    shop_name_coverage_since: null,
    event_history_gap_days: 0
};

const EVENTS = [
    {
        partner_event_id: 'ev-1',
        shop_domain: SHOP,
        event_type: 'INSTALL',
        occurred_at: _daysAgo(30),
        charge_id: '',
        shop_id: 'gid://partners/Shop/42',
        shop_name: 'Lonely Store',
        raw_event: {}
    }
];

/**
 * ⚠️ THE ATTRIBUTION STUBS THROW.
 *
 * Both services SKIP the attribution read when the tier is not connected — nothing could ever have
 * written a row, and issuing the query would only make the log read as though it had. A stub that
 * returned `[]` would pass whether or not the skip survived; one that throws fails loudly the moment
 * it does not, and the service's own catch would turn that into a refusal, which is exactly the
 * outcome these tests forbid.
 */
rosterRepository.findPartnerAppById = async () => APP;
rosterRepository.findRelationshipEvents = async () => ({ rows: EVENTS, shopless_relationship_events: 0 });
rosterRepository.findChargeCohortEvents = async () => [];
rosterRepository.aggregateSettledSubscriptionCharges = async () => [];
rosterRepository.aggregateStoreSpend = async () => [];
rosterRepository.findInstallAttributionRows = async () => {
    throw new Error('the attribution read must not be issued while the listing tier is unconfigured');
};

detailRepository.findStoreEvents = async () => EVENTS;
/**
 * ⚠️ THROWS ON PURPOSE. This store's only event carries no charge id, so the charge-keyed read must
 * be skipped: an empty `$in` matches nothing, and issuing it would make the log read as though a
 * question had been asked. A stub returning `[]` would pass whether or not the skip survived.
 */
detailRepository.findEventsForCharges = async () => {
    throw new Error('the charge-keyed event read must not be issued for a store with no charges');
};
detailRepository.findTransactionsForCharges = async () => {
    throw new Error('the charge-keyed payout read must not be issued for a store with no charges');
};
detailRepository.findStoreTransactions = async () => [];
detailRepository.findStoreAttributionRows = async () => {
    throw new Error('the attribution read must not be issued while the listing tier is unconfigured');
};

const { getStoreRoster } = require(path.join(MODULE_ROOT, 'services', 'storeRoster.service.ts'));
const { getStoreDetail } = require(path.join(MODULE_ROOT, 'services', 'storeDetail.service.ts'));

const IDENTITY = { user_id: 'operator-1' };


test('the fixture really is an unconfigured deployment — otherwise this file proves nothing', () => {
    assert.equal(config.BIGQUERY.ENABLED, false,
        'A leaked GCP_PROJECT_ID / BQ_DATASET in the environment would put this process on the READY '
        + 'path and every assertion below would pass without exercising the branch it names.');
});

test('GET /api/stores answers 200 with its stores when BigQuery is unconfigured', async () => {
    const result = await getStoreRoster(IDENTITY, { partner_app_id: 'app-1' });

    assert.equal(result.status, true,
        'A refusal renders on the Stores page as though the operator had no stores at all — a claim '
        + 'about their business that no data made.');
    assert.equal(result.data.items.length, 1);
    assert.equal(result.data.data_state, 'READY', 'The PARTNER tier is ready; the listing tier is not.');
    assert.equal(result.data.attribution_state, 'NOT_CONNECTED',
        'NOT_CONNECTED and NEVER_SYNCED are different facts: one is a missing configuration, the '
        + 'other a job that has not run.');
});

test('the acquisition columns say "no evidence" — never DIRECT — and the reason is in warnings[]', async () => {
    const result = await getStoreRoster(IDENTITY, { partner_app_id: 'app-1' });
    const row = result.data.items[0];

    assert.equal(row.has_attribution, false);
    assert.equal(row.channel, 'UNKNOWN',
        'DIRECT asserts the merchant arrived with no referrer. UNKNOWN asserts nothing at all, which '
        + 'is the only true statement available with the data source switched off.');
    assert.equal(row.channel_label, 'Not attributed');
    assert.equal(row.install_country, '');
    assert.ok(
        result.data.warnings.some((w) => w.includes('Not attributed') && w.includes('missing data source')),
        'The operator must be able to tell a missing data source from an unattributed install.'
    );
});

test('GET /api/stores/detail answers 200 with acquisition null when BigQuery is unconfigured', async () => {
    const result = await getStoreDetail(IDENTITY, { partner_app_id: 'app-1', shop_domain: SHOP });

    assert.equal(result.status, true,
        'A refusal renders as a critical "Not available" banner over a store the Partner API '
        + 'describes perfectly well.');
    assert.equal(result.data.acquisition, null,
        'The null selects the drawer`s "Not attributed" branch. `{}` would take the attributed one.');
    assert.equal(result.data.attribution_state, 'NOT_CONNECTED');
    assert.equal(result.data.provenance.acquisition, 'NOT_CONNECTED',
        'On a miss the provenance carries the TIER STATE, so "the tier is off" stays separable from '
        + '"the sync ran and this store genuinely has none".');
    assert.equal(result.data.subscription.customer_name, 'Lonely Store');
    assert.equal(result.data.subscription.install_state, 'INSTALLED');
    assert.equal(result.data.timeline.length, 1);
    assert.ok(result.data.warnings.some((w) => w.includes('Not attributed')));
});
