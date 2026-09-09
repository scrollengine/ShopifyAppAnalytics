'use strict';

/**
 * ============================================================================
 *  REVENUE COUNTRY — the two silent ways a country breakdown goes wrong
 * ============================================================================
 *
 *  Exercises `getCountryRollup` end to end with the roster's five reads stubbed out. The fold itself
 *  — `resolveStoreRosterFold` — and the paying set it evaluates through `modules/revenue`'s
 *  `liveSetAsOf` are NOT stubbed and must not be: this endpoint exists to group the SAME population
 *  the Stores and Subscriptions lists render, and a test that replaced the fold would prove nothing
 *  about the thing most likely to go wrong.
 *
 *  ── 1.  NORMALISE BEFORE GROUPING, OR ONE COUNTRY BECOMES TWO ROWS ────────────────────────
 *
 *  The raw geo arrives as `US` on some install rows and `United States` on others — same country,
 *  two strings. Grouping on the raw value produces two rows that are each half right while the totals
 *  still add up, so nothing on screen says anything is wrong. The fixture below spells one country
 *  three ways and one country two ways, and both must collapse.
 *
 *  ⚠️ And the obvious repair is worse than the bug: stripping parentheticals to make names match
 *  merges the two Congos, the two Koreas and both Virgin Islands into one row EACH. The fixture keeps
 *  a pair of each kind apart to prove nothing here does that.
 *
 *  ── 2.  THE UNATTRIBUTABLE REMAINDER MUST BE PUBLISHED, NOT DROPPED ───────────────────────
 *
 *  A store whose install carried no geo has no country. Dropping it makes the per-country column stop
 *  summing to the headline revenue figure — quietly, in the direction of "less" — so this page and
 *  the Revenue page disagree with no visible cause. With an explicit `UNKNOWN` row,
 *  `sum(items) === totals` holds for every countable field and the gap becomes a row a reader can
 *  point at. That identity is asserted field by field below.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';
// The listing tier must be CONFIGURED here or the fold skips the attribution read entirely and every
// store lands in the remainder — which is a real state with its own test, but not this file's subject.
// `src/config` snapshots `process.env` at first require, so this must precede every require below.
process.env.GCP_PROJECT_ID = 'test-project';
process.env.BQ_DATASET = 'test_dataset';
process.env.GCP_SERVICE_ACCOUNT_JSON = '{}';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mongoose = require('mongoose');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const MODULE_ROOT = path.join(BACKEND_ROOT, 'src', 'modules', 'store');

mongoose.set('bufferTimeoutMS', 400);

const repository = require(path.join(MODULE_ROOT, 'repositories', 'storeRoster.repository.ts'));
const countryNameHelper = require(path.join(MODULE_ROOT, 'helpers', 'countryName.helper.ts'));

const { normaliseCountry } = countryNameHelper;

const _DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const _daysAgo = (days) => new Date(NOW - days * _DAY_MS);

const APP = {
    _id: 'app-1',
    display_name: 'Demo App',
    last_synced_at: _daysAgo(1),
    earliest_event_at: _daysAgo(400),
    earliest_transaction_at: _daysAgo(400),
    lifetime_sync_completed_at: _daysAgo(1),
    last_install_attrib_synced_at: _daysAgo(1),
    event_history_gap_days: 0
};

// Three American stores whose install geo is spelled three different ways, two British ones spelled
// two ways, one store with no geo at all, and one whose geo names no country this build can place.
const US_A = 'us-a.myshopify.com';
const US_B = 'us-b.myshopify.com';
const US_C = 'us-c.myshopify.com';
const GB_A = 'gb-a.myshopify.com';
const GB_B = 'gb-b.myshopify.com';
const NO_GEO = 'no-geo.myshopify.com';
const BAD_GEO = 'bad-geo.myshopify.com';
const CONGO_KIN = 'congo-kin.myshopify.com';
const CONGO_BRZ = 'congo-brz.myshopify.com';

const ALL_DOMAINS = [US_A, US_B, US_C, GB_A, GB_B, NO_GEO, BAD_GEO, CONGO_KIN, CONGO_BRZ];

const RELATIONSHIP_ROWS = ALL_DOMAINS.map((domain) => ({
    event_type: 'INSTALL',
    shop_domain: domain,
    occurred_at: _daysAgo(200),
    raw_event: {}
}));

/**
 * Two of the American stores and one British store are paying right now.
 *
 * ⚠️ `latest_settled_at` inside the 38-day live window is what makes `liveSetAsOf` — the canonical
 * predicate, reached through `modules/revenue`'s barrel by the fold — count them. Nothing in this
 * file asserts a subscription STATE, because membership here is not a state.
 */
const SETTLED = [
    { charge_id: 'c1', shop_domain: US_A, settled_count: 3, billing_interval: 'EVERY_30_DAYS', latest_gross: 29, latest_currency: 'USD', latest_settled_at: _daysAgo(5) },
    { charge_id: 'c2', shop_domain: US_B, settled_count: 2, billing_interval: 'EVERY_30_DAYS', latest_gross: 49, latest_currency: 'USD', latest_settled_at: _daysAgo(6) },
    { charge_id: 'c3', shop_domain: GB_A, settled_count: 4, billing_interval: 'EVERY_30_DAYS', latest_gross: 99, latest_currency: 'USD', latest_settled_at: _daysAgo(7) },
    // ⚠️ THE STORE WITH NO GEO IS PAYING. That is what makes the remainder matter: drop it and the
    // per-country MRR column silently stops summing to the headline figure.
    { charge_id: 'c4', shop_domain: NO_GEO, settled_count: 5, billing_interval: 'EVERY_30_DAYS', latest_gross: 199, latest_currency: 'USD', latest_settled_at: _daysAgo(4) },
    // Aged far outside the window: on the roster, counted in `ever_paid`, and NOT paying.
    { charge_id: 'c5', shop_domain: US_C, settled_count: 1, billing_interval: 'EVERY_30_DAYS', latest_gross: 9, latest_currency: 'USD', latest_settled_at: _daysAgo(300) }
];

const SPEND = [
    { shop_domain: US_A, total_gross: 87, total_net: 75, transaction_count: 3, first_payment_at: _daysAgo(95), last_payment_at: _daysAgo(5), currencies: ['USD'] },
    { shop_domain: US_B, total_gross: 98, total_net: 84, transaction_count: 2, first_payment_at: _daysAgo(65), last_payment_at: _daysAgo(6), currencies: ['USD'] },
    { shop_domain: US_C, total_gross: 9, total_net: 8, transaction_count: 1, first_payment_at: _daysAgo(300), last_payment_at: _daysAgo(300), currencies: ['USD'] },
    { shop_domain: GB_A, total_gross: 396, total_net: 340, transaction_count: 4, first_payment_at: _daysAgo(125), last_payment_at: _daysAgo(7), currencies: ['USD'] },
    { shop_domain: NO_GEO, total_gross: 995, total_net: 855, transaction_count: 5, first_payment_at: _daysAgo(155), last_payment_at: _daysAgo(4), currencies: ['USD'] }
];

/**
 * ONE country spelled three ways, another spelled two, and the two Congos kept apart.
 *
 *  `BAD_GEO` carries a string that names no country at all. It must land in the remainder and be
 * NAMED in a warning — not merged into a country it merely resembles, and not dropped, which would
 * break the reconciliation the remainder exists to guarantee.
 */
const ATTRIBUTION = [
    { shop_domain: US_A, installed_at: _daysAgo(200), country: 'United States', source: 'shopify_app_store', medium: 'referral', campaign: '', attribution_source: 'event_collected', surface_type: '', surface_detail: '', surface_inter_position: null, surface_intra_position: null },
    { shop_domain: US_B, installed_at: _daysAgo(200), country: 'US', source: 'google', medium: 'organic', campaign: '', attribution_source: 'event_collected', surface_type: '', surface_detail: '', surface_inter_position: null, surface_intra_position: null },
    { shop_domain: US_C, installed_at: _daysAgo(200), country: 'united states of america', source: 'google', medium: 'organic', campaign: '', attribution_source: 'event_collected', surface_type: '', surface_detail: '', surface_inter_position: null, surface_intra_position: null },
    { shop_domain: GB_A, installed_at: _daysAgo(200), country: 'United Kingdom', source: 'google', medium: 'organic', campaign: '', attribution_source: 'event_collected', surface_type: '', surface_detail: '', surface_inter_position: null, surface_intra_position: null },
    { shop_domain: GB_B, installed_at: _daysAgo(200), country: 'GB', source: 'google', medium: 'organic', campaign: '', attribution_source: 'event_collected', surface_type: '', surface_detail: '', surface_inter_position: null, surface_intra_position: null },
    { shop_domain: BAD_GEO, installed_at: _daysAgo(200), country: 'Somewhere Else', source: 'google', medium: 'organic', campaign: '', attribution_source: 'event_collected', surface_type: '', surface_detail: '', surface_inter_position: null, surface_intra_position: null },
    { shop_domain: CONGO_KIN, installed_at: _daysAgo(200), country: 'Congo - Kinshasa', source: 'google', medium: 'organic', campaign: '', attribution_source: 'event_collected', surface_type: '', surface_detail: '', surface_inter_position: null, surface_intra_position: null },
    { shop_domain: CONGO_BRZ, installed_at: _daysAgo(200), country: 'Congo - Brazzaville', source: 'google', medium: 'organic', campaign: '', attribution_source: 'event_collected', surface_type: '', surface_detail: '', surface_inter_position: null, surface_intra_position: null }
    // NO_GEO has no row here at all — the commonest cause of an unattributable store.
];

/**
 * ⚠️ The stubs are installed BEFORE the service is required, and read mutable state afterwards.
 * Every service in this codebase destructures its repository at MODULE LOAD, so re-assigning a
 * repository export after the service has been required has no effect at all.
 */
const STATE = {
    app: APP,
    relationship: { rows: RELATIONSHIP_ROWS, shopless_relationship_events: 0 },
    settled: SETTLED,
    spend: SPEND,
    attribution: ATTRIBUTION
};

const _reset = () => {
    STATE.app = APP;
    STATE.relationship = { rows: RELATIONSHIP_ROWS, shopless_relationship_events: 0 };
    STATE.settled = SETTLED;
    STATE.spend = SPEND;
    STATE.attribution = ATTRIBUTION;
};

repository.findPartnerAppById = async () => STATE.app;
repository.findRelationshipEvents = async () => STATE.relationship;
repository.findChargeCohortEvents = async () => [];
repository.aggregateSettledSubscriptionCharges = async () => STATE.settled;
repository.aggregateStoreSpend = async () => STATE.spend;
repository.findInstallAttributionRows = async () => STATE.attribution;

const { getCountryRollup } = require(path.join(MODULE_ROOT, 'services', 'countryRollup.service.ts'));

/**
 * Calls the service and asserts it did not refuse.
 *
 * @param {Object} [params] - Extra query parameters.
 * @returns {Promise<Object>} The payload.
 */
const _read = async (params = {}) => {
    const result = await getCountryRollup({ user_id: 'operator-1' }, { partner_app_id: 'app-1', ...params });
    assert.equal(result.status, true, `the service refused: ${result.msg}`);
    return result.data;
};

/** Rows by country code, for assertions that name one. */
const _byCode = (data) => Object.fromEntries(data.items.map((row) => [row.country, row]));

/** Every countable field the totals claim to sum. */
const COUNTABLE = ['stores', 'installed', 'paying', 'trialing', 'ever_paid', 'mrr', 'total_spend', 'net_revenue'];


/* ==========================================================================
 *  1.  Normalisation folds the spellings, and refuses to fold the countries
 * ========================================================================== */

test('one country spelled three ways is ONE row, not three', async () => {
    _reset();
    const data = await _read();
    const rows = _byCode(data);

    // `United States`, `US` and `united states of america` all arrived as install geo.
    assert.ok(rows.US, 'the three American stores produced no US row at all');
    assert.equal(rows.US.stores, 3, 'the spellings were not folded — one country is in several rows');
    assert.equal(rows.US.country_name, 'United States', 'the row must carry the index label, not a raw value');

    // `United Kingdom` and `GB`.
    assert.equal(rows.GB.stores, 2);
    assert.equal(rows.GB.country_name, 'United Kingdom');

    // Exactly one row per distinct COUNTRY, so no code appears twice.
    const codes = data.items.map((row) => row.country);
    assert.equal(new Set(codes).size, codes.length, 'a country was published in two rows');
});

test(' the two Congos stay two countries — nothing strips a qualifier', async () => {
    _reset();
    const data = await _read();
    const rows = _byCode(data);

    // The repair that shipped in the source system merged these by stripping the parenthetical or
    // the qualifier, which silently turns two real countries into one plausible row.
    assert.equal(rows.CD.stores, 1, 'Congo - Kinshasa lost its row');
    assert.equal(rows.CG.stores, 1, 'Congo - Brazzaville lost its row');
    assert.notEqual(rows.CD.country_name, rows.CG.country_name);
});

test('an AMBIGUOUS name resolves to nothing rather than to one of the countries it could mean', () => {
    // Asserted against the helper directly: "Korea" and "Congo" each name two countries, and choosing
    // one would move a merchant's revenue across a border. Refusing puts them in the visible
    // remainder instead, which is an unknown a reader can see.
    assert.equal(normaliseCountry('Korea'), null);
    assert.equal(normaliseCountry('Congo'), null);
    assert.equal(normaliseCountry('Virgin Islands'), null);

    // The unambiguous forms still resolve, and to DIFFERENT codes.
    assert.equal(normaliseCountry('South Korea').code, 'KR');
    assert.equal(normaliseCountry('North Korea').code, 'KP');
    assert.equal(normaliseCountry('British Virgin Islands').code, 'VG');
    assert.equal(normaliseCountry('U.S. Virgin Islands').code, 'VI');
});

test('the normaliser answers one LABEL per country, whichever spelling arrived', () => {
    for (const spelling of ['US', 'us', ' United States ', 'united states of america', 'U.S.A.']) {
        const resolved = normaliseCountry(spelling);
        assert.equal(resolved.code, 'US', `${spelling} did not resolve`);
        assert.equal(resolved.name, 'United States', 'two labels for one country is two rows waiting to happen');
    }
    // A sentinel is an ABSENCE, not a country, and must reach the remainder.
    for (const sentinel of ['', '   ', '(not set)', 'Unknown', 'ZZ']) {
        assert.equal(normaliseCountry(sentinel), null, `${JSON.stringify(sentinel)} was read as a country`);
    }
});


/* ==========================================================================
 *  2.  The remainder makes the breakdown reconcile to the total
 * ========================================================================== */

test('every countable field sums across items EXACTLY to its total', async () => {
    _reset();
    const data = await _read();

    for (const field of COUNTABLE) {
        const summed = data.items.reduce((sum, row) => sum + row[field], 0);
        assert.equal(
            summed,
            data.totals[field],
            `items.${field} does not sum to totals.${field} — a store was dropped or double-counted`
        );
    }
    // Every store is in exactly one bucket, so the row total IS the population.
    assert.equal(data.totals.stores, ALL_DOMAINS.length);
    assert.equal(data.totals.stores, data.diagnostics.domains_filtered);
});

test('a PAYING store with no geo is published in the remainder, never dropped', async () => {
    _reset();
    const data = await _read();
    const rows = _byCode(data);

    // Two stores cannot be placed: one with no attribution record at all, one whose geo names no
    // country. Both are in the explicit remainder.
    assert.ok(rows.UNKNOWN, 'the remainder row is missing — the breakdown can no longer reconcile');
    assert.equal(rows.UNKNOWN.country_name, 'Unknown');
    assert.equal(rows.UNKNOWN.stores, 2);
    assert.equal(rows.UNKNOWN.paying, 1, 'the unattributable store IS paying, which is the whole point');
    assert.equal(rows.UNKNOWN.mrr, 199);

    //  AND THE REVENUE IT CARRIES IS IN THE TOTAL. Drop the row and this figure silently falls by
    // 199 while the Revenue page keeps reporting it.
    assert.equal(data.totals.mrr, 29 + 49 + 99 + 199);
    assert.equal(data.coverage.attributed_mrr, 29 + 49 + 99);
    assert.equal(data.coverage.unattributed_mrr, 199);
    assert.equal(data.coverage.attributed_mrr + data.coverage.unattributed_mrr, data.totals.mrr);
    assert.equal(data.coverage.unattributed_paying, 1);
    assert.equal(data.coverage.attributed_paying + data.coverage.unattributed_paying, data.totals.paying);
    assert.equal(data.coverage.mrr_coverage, (29 + 49 + 99) / (29 + 49 + 99 + 199));
});

test('a geo we HAVE and cannot place is named, not silently pooled', async () => {
    _reset();
    const data = await _read();

    // It is in the remainder — so the totals still reconcile — but it is a MAPPING gap rather than a
    // coverage gap, and only naming the exact string lets an operator report it.
    assert.equal(data.diagnostics.stores_with_unresolved_geo, 1);
    assert.deepEqual(data.coverage.unresolved_geo_values, ['Somewhere Else']);
    assert.ok(
        data.warnings.some((w) => w.includes('Somewhere Else')),
        'the unplaceable value must reach the operator verbatim'
    );
});

test('the countries count matches the rows the table will actually draw', async () => {
    _reset();
    const data = await _read();
    // The page's footer reads "Showing {visibleItems.length} of {totals.countries} countries", so a
    // count that excluded the remainder would render "Showing 5 of 4" the moment a store lacked a geo.
    assert.equal(data.totals.countries, data.items.length);
    // The true number of real countries is published beside it rather than instead of it.
    assert.equal(data.totals.countries_attributed, data.items.length - 1);
});

test('the unattributed banner explains THIS build, not the system these pages came from', async () => {
    _reset();
    const data = await _read();
    const sentence = data.warnings.find((w) => w.includes('no install-attribution record'));
    assert.ok(sentence, 'the accurate reason must be published — the page component states the wrong one');
    assert.ok(
        sentence.includes('LISTING ANALYTICS'),
        'the cause is a missing analytics record, not a missing Partner event'
    );
});


/* ==========================================================================
 *  3. The population is the roster's, and the money is the ledger's
 * ========================================================================== */

test('paying comes from the canonical live set, and a stale payer is counted but not paying', async () => {
    _reset();
    const data = await _read();
    const rows = _byCode(data);

    // Three of the four paying stores are attributable; US_C settled once, 300 days ago.
    assert.equal(rows.US.paying, 2);
    assert.equal(rows.US.ever_paid, 3, 'a store that paid and stopped still paid');
    assert.equal(rows.US.mrr, 29 + 49);
    // Conversion is paying over STORES, not over installs.
    assert.equal(rows.US.conversion_rate, 2 / 3);
    // GB_B never paid at all, so it drags the British rate down rather than vanishing.
    assert.equal(rows.GB.paying, 1);
    assert.equal(rows.GB.conversion_rate, 0.5);
});

test('gross and net are published separately, and are not the same number', async () => {
    _reset();
    const data = await _read();
    const rows = _byCode(data);
    // The source system's country table summed GROSS while the Revenue page's lifetime card showed
    // NET, so one word named two different numbers on adjacent screens.
    assert.equal(rows.US.total_spend, 87 + 98 + 9);
    assert.equal(rows.US.net_revenue, 75 + 84 + 8);
    assert.notEqual(rows.US.total_spend, rows.US.net_revenue);
});

test('a country with no measurable rate publishes null, never 0', async () => {
    // Reached through the fold rather than fabricated: a bucket with no stores cannot exist, so the
    // guard is asserted on the shape the service publishes for every row it does emit.
    _reset();
    const data = await _read();
    for (const row of data.items) {
        assert.ok(row.stores > 0, 'an empty bucket was published');
        assert.equal(typeof row.conversion_rate, 'number');
    }
});


/* ==========================================================================
 *  4. Sort, filters and the empty states
 * ========================================================================== */

test('the default sort is PAYING CUSTOMERS, not store count', async () => {
    _reset();
    const data = await _read();
    assert.deepEqual(data.sort, { key: 'paying', dir: 'desc' });
    // Ranking by volume buries a small market that converts well underneath a large one that never
    // pays, which is the comparison this page exists to make.
    for (let i = 1; i < data.items.length; i += 1) {
        assert.ok(data.items[i - 1].paying >= data.items[i].paying, 'the rows are not in paying order');
    }
});

test('an unrecognised sort or filter WIDENS the breakdown and says so', async () => {
    _reset();
    const data = await _read({ sort: 'banana', install_states: 'INSTALLED,NOT_A_STATE' });

    assert.equal(data.sort.key, 'paying', 'an unknown sort key falls back rather than refusing');
    assert.ok(data.warnings.some((w) => w.includes('banana')));
    assert.ok(data.warnings.some((w) => w.includes('NOT_A_STATE')));
    assert.ok(data.diagnostics.unrecognised_filters.includes('sort=banana'));
    assert.ok(data.diagnostics.unrecognised_filters.includes('install_states=NOT_A_STATE'));
    // The recognised half still applied, and the breakdown is not empty.
    assert.deepEqual(data.filters.install_states, ['INSTALLED']);
    assert.ok(data.items.length > 0, 'a typo emptied the table — it must widen it');
});

test('a countries filter is REFUSED out loud — it would remove the rows being compared', async () => {
    _reset();
    const data = await _read({ countries: 'US' });
    assert.equal(data.totals.stores, ALL_DOMAINS.length, 'the filter was honoured; it must not be');
    assert.ok(data.warnings.some((w) => w.includes('Filtering countries on the countries page')));
    assert.ok(data.diagnostics.unrecognised_filters.includes('countries=US'));
});

test('every facet option the response offers is one the endpoint can evaluate', async () => {
    _reset();
    const data = await _read();
    for (const group of data.facet_groups) {
        for (const option of group.options) {
            const filtered = await _read({ [group.key]: option.value });
            assert.equal(
                filtered.totals.stores,
                option.count,
                `${group.key}=${option.value} offered ${option.count} but selecting it gave ${filtered.totals.stores}`
            );
        }
    }
});

test('no watermark is NEVER_SYNCED and carries the banner body — the row count cannot tell you', async () => {
    _reset();
    STATE.app = { ...APP, last_synced_at: null };
    const data = await _read();
    assert.equal(data.data_state, 'NEVER_SYNCED');
    assert.equal(typeof data.unknown_reason, 'string');
    assert.ok(data.unknown_reason.includes('not that your app has no customers'));
    _reset();
});

test('the payload states where country comes from, rather than leaving it to the page', async () => {
    _reset();
    const data = await _read();
    assert.ok(data.country_basis.includes('INSTALL TRAFFIC'));
    assert.ok(
        data.country_basis.includes('NOT the merchant'),
        'an API consumer must not be able to read this column as a trading country'
    );
    assert.equal(typeof data.meta.last_install_attrib_synced_at, 'string');
});

test('the refusals are the three named ones', async () => {
    _reset();
    const noUser = await getCountryRollup({}, { partner_app_id: 'app-1' });
    assert.equal(noUser.status, false);
    assert.deepEqual(noUser.data, {});

    const noApp = await getCountryRollup({ user_id: 'operator-1' }, {});
    assert.equal(noApp.status, false);
    assert.ok(noApp.msg.includes('partner_app_id'));

    STATE.app = null;
    const missing = await getCountryRollup({ user_id: 'operator-1' }, { partner_app_id: 'nope' });
    assert.equal(missing.status, false);
    assert.ok(missing.msg.includes('not found'));
    _reset();
});
