'use strict';

/**
 * ============================================================================
 *  THE SUBSCRIPTIONS LIST — who is paying, and the seven ways to get it wrong
 * ============================================================================
 *
 *  Exercises `getSubscriptionList` end to end with the repository stubbed out, so the whole assembly
 *  — relationship fold → charge cohort → canonical MRR predicate → membership → row → facets →
 *  counts → sort → paging → warnings — runs against fixtures with no database and no BigQuery.
 *
 *  ── 1.  THE POPULATION, WHICH IS THE REASON THIS FILE EXISTS ────────────
 *
 *  This list is "on a paid plan RIGHT NOW". A store that never subscribed is ABSENT and a store that
 *  paid for months and then stopped is ABSENT — neither appears with a different status. Getting
 *  that wrong does not produce an error or an obviously silly number: it produces a plausible,
 *  confident list that a reader will take for "our customers", and a churn trend built on it is flat
 *  by construction. So the membership tests below name the shop and assert its absence.
 *
 *  ── 2. MEMBERSHIP COMES THROUGH `liveSetAsOf` AND NOTHING ELSE ────────────
 *
 *  Not `state === 'CONVERTED'` and not `monthly_spend > 0`. The tests pin the two places those
 *  disagree with the ledger: a merchant mid-cancellation who has already paid for the cycle they are
 *  in is PRESENT and reads `CHURNED_AFTER_TRIAL`, and a merchant the ledger knows and the event
 *  record does not is PRESENT with a blank plan.
 *
 *  ── 3. THE ROW MUST NOT CARRY `state` ─────────────────────────────────────
 *
 *  `StoreTable._renderStatus` reads `row.state || row.status`, and `state` WINS. Publishing the
 *  roster's lifecycle `state` alongside `status` would badge a merchant "Converted" underneath a tab
 *  that says "Paying" — same state, two vocabularies, one column apart.
 *
 *  ── 4. THE BARE-NUMBER CONTRACT ───────────────────────────────────────────
 *
 *  Every figure is a BARE NUMBER. `fmtMoney` does `Number(n)`, so an enveloped `monthly_spend`
 *  renders as an em dash, and `pagination.total.toLocaleString()` THROWS outright and takes the
 *  page's footer with it. This is one of the places `IMPLEMENTATION.md` §3.11 must NOT be applied.
 *
 *  ── 5. FACET COUNTS ARE PRE-FILTER, AND EVERY ZERO IS PRESENT ─────────────
 *
 *  A group's options are tallied over the rows that pass every OTHER group. And a status key omitted
 *  because its count is zero removes that tab's number entirely, which reads as "we did not measure
 *  it" and breaks `sum(tabs) === ALL` on screen with no explanation.
 *
 *  ── 6. VALIDATION FAILS OPEN ──────────────────────────────────────────────
 *
 *  A typo in a facet value or a sort key must WIDEN the result set and say so. `?states=PAID`
 *  returning an empty table is indistinguishable from "you have no paying customers" — the single
 *  most alarming thing this dashboard could say by accident.
 *
 *  ── 7. NULLS SORT LAST IN BOTH DIRECTIONS ─────────────────────────────────
 *
 *  A merchant whose activation date we do not hold is not "the newest" when you ask for newest
 *  first, and not "the oldest" when you ask for oldest first. Floating an ABSENCE to the top of a
 *  list presents it as an extreme value.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';
//  The attribution join is SKIPPED entirely when the listing tier is unconfigured — which is
// correct, and would leave the acquisition half of this file untested. These three are what
// `resolveBigQueryAvailability` reads; nothing here ever reaches BigQuery.
// ⚠️ `src/config` snapshots `process.env` at first require, so they must be set before any require.
process.env.GCP_PROJECT_ID = 'test-project';
process.env.BQ_DATASET = 'test_dataset';
process.env.GCP_SERVICE_ACCOUNT_JSON = '{}';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mongoose = require('mongoose');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const MODULE_ROOT = path.join(BACKEND_ROOT, 'src', 'modules', 'store');

/** Never reached — nothing here issues a query — but a short buffer keeps a mistake from hanging. */
mongoose.set('bufferTimeoutMS', 400);

const repository = require(path.join(MODULE_ROOT, 'repositories', 'storeRoster.repository.ts'));

/**
 * ⚠️ FIXTURES ARE RELATIVE TO NOW, not to a fixed calendar date.
 *
 * The service reads the clock itself — deliberately, so one response cannot classify a merchant as
 * of two different moments — and `liveSetAsOf` decides membership from a ROLLING window
 * (`ACTIVE_SUB_WINDOW_DAYS`, 38 by default). Absolute dates would make "is this merchant paying"
 * answer differently depending on when the suite is run, and it would start failing on a Tuesday
 * months from now for no reason anyone could find.
 */
const NOW = Date.now();
const _daysAgo = (days) => new Date(NOW - (days * 86400000));
const _daysAhead = (days) => new Date(NOW + (days * 86400000));

const APP = {
    _id: 'app-1',
    display_name: 'Demo App',
    listing_url: 'https://apps.shopify.com/demo',
    last_synced_at: _daysAgo(1),
    last_install_attrib_synced_at: _daysAgo(1),
    earliest_event_at: _daysAgo(400),
    earliest_transaction_at: _daysAgo(390),
    lifetime_sync_completed_at: _daysAgo(2),
    shop_name_coverage_since: null,
    event_history_gap_days: 0
};

// ── The population, one shop per outcome ────────────────────────────────────
//
//  THE FIRST THREE ARE THE ONES THAT MUST BE ABSENT. They are the whole point of the file: a store
// that never subscribed, a store that paid and stopped, and a store the money ledger knows for a
// non-subscription reason are all real, and none of them is a paying customer today.
const NEVER = 'never-subscribed.myshopify.com';
const CHURNED = 'stopped-paying.myshopify.com';
const GHOST = 'ledger-only-credit.myshopify.com';
const TRIALLING = 'trialling.myshopify.com';

// ...and these four are in the list, one per status the tab row can show.
const PAYING = 'paying-shop.myshopify.com';
const CANCELLING = 'cancelling-shop.myshopify.com';
const UPGRADING = 'upgrading-shop.myshopify.com';
const WINDING_DOWN = 'winding-down.myshopify.com';
const LEDGER_ONLY = 'ledger-only-payer.myshopify.com';

/**
 *   never       install only, no subscription, no money        -> ABSENT (never settled)
 *   churned     paid, uninstalled, last payout 170 days ago    -> ABSENT (settled, not paying now)
 *   ghost       payouts of another type only                   -> ABSENT (never settled a subscription)
 *   trialling   a subscription, no billingOn, no payout        -> ABSENT (never settled)
 *   paying      billingOn in the past, payout 5 days ago       -> PRESENT, PAYING
 *   cancelling  as above plus an UNINSTALL 3 days ago          -> PRESENT, CHURNED_AFTER_TRIAL
 *   upgrading   a newer charge with no billingOn, payout on the older one -> PRESENT, ON_TRIAL
 *   winding     a newer charge whose billingOn is in the FUTURE, then an uninstall
 *                                                              -> PRESENT, CHURNED_DURING_TRIAL
 *   ledger      a settled payout and NO subscription event      -> PRESENT, PAYING, ledger_only
 */
const RELATIONSHIP_ROWS = [
    { shop_domain: NEVER, event_type: 'INSTALL', occurred_at: _daysAgo(30), shop_name: 'Never Store', shop_id: 'gid://partners/Shop/1' },
    { shop_domain: CHURNED, event_type: 'INSTALL', occurred_at: _daysAgo(300), shop_name: 'Stopped Store', shop_id: 'gid://partners/Shop/2' },
    { shop_domain: CHURNED, event_type: 'UNINSTALL', occurred_at: _daysAgo(160), shop_name: '', shop_id: 'gid://partners/Shop/2' },
    { shop_domain: TRIALLING, event_type: 'INSTALL', occurred_at: _daysAgo(8), shop_name: 'Trialling Store', shop_id: 'gid://partners/Shop/3' },
    { shop_domain: PAYING, event_type: 'INSTALL', occurred_at: _daysAgo(120), shop_name: 'Paying Store', shop_id: 'gid://partners/Shop/4' },
    { shop_domain: CANCELLING, event_type: 'INSTALL', occurred_at: _daysAgo(140), shop_name: 'Cancelling Store', shop_id: 'gid://partners/Shop/5' },
    //  THE ROW THAT MAKES THE MEMBERSHIP TEST MEAN SOMETHING. This shop has left, and it is still
    // on the list because it has already paid for the cycle it is in.
    { shop_domain: CANCELLING, event_type: 'UNINSTALL', occurred_at: _daysAgo(3), shop_name: '', shop_id: 'gid://partners/Shop/5' },
    { shop_domain: UPGRADING, event_type: 'INSTALL', occurred_at: _daysAgo(250), shop_name: 'Upgrading Store', shop_id: 'gid://partners/Shop/6' },
    { shop_domain: WINDING_DOWN, event_type: 'INSTALL', occurred_at: _daysAgo(260), shop_name: 'Winding Down Store', shop_id: 'gid://partners/Shop/7' },
    { shop_domain: WINDING_DOWN, event_type: 'UNINSTALL', occurred_at: _daysAgo(2), shop_name: '', shop_id: 'gid://partners/Shop/7' }
];

/**
 * ⚠️ SUBSCRIPTION TYPES ONLY, exactly as the repository's `$in` produces them: the relationship end
 * events above are fetched by the OTHER read and re-joined by the fold. A fixture that also carried
 * the UNINSTALLs here would hide a regression in that re-join — and on this endpoint that regression
 * would show up as a merchant reading `PAYING` for ever after they cancelled.
 */
const _accepted = (shop, chargeId, at, billingOn, name, amount) => ({
    event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
    shop_domain: shop,
    charge_id: chargeId,
    occurred_at: at,
    raw_event: {
        charge: {
            id: `gid://shopify/AppSubscription/${chargeId}`,
            name,
            billingOn: billingOn ? billingOn.toISOString() : undefined,
            test: false,
            amount: { amount, currencyCode: 'USD' }
        }
    }
});

const CHARGE_EVENTS = [
    _accepted(CHURNED, '200', _daysAgo(290), _daysAgo(283), 'Pro', '29.00'),
    _accepted(TRIALLING, '300', _daysAgo(7), null, 'Starter', '9.00'),
    _accepted(PAYING, '400', _daysAgo(115), _daysAgo(108), 'Pro', '29.00'),
    _accepted(CANCELLING, '500', _daysAgo(135), _daysAgo(128), 'Pro', '29.00'),
    // Two subscriptions: the LATEST trial start wins, and it carries no billingOn.
    _accepted(UPGRADING, '600', _daysAgo(240), _daysAgo(233), 'Pro', '29.00'),
    _accepted(UPGRADING, '601', _daysAgo(4), null, 'Scale', '99.00'),
    // Two subscriptions: the latest one's billingOn has NOT ARRIVED, and the shop then uninstalled.
    _accepted(WINDING_DOWN, '700', _daysAgo(250), _daysAgo(243), 'Pro', '29.00'),
    _accepted(WINDING_DOWN, '701', _daysAgo(10), _daysAhead(5), 'Scale', '99.00')
];

/**
 * The settled `APP_SUBSCRIPTION` payouts. THIS IS THE POPULATION: a shop is on the list when its
 * newest row here is positive and inside its billing window.
 */
const SETTLED = [
    // Far outside the window: measured, and NOT paying now. The churn this list cannot show.
    { charge_id: '200', shop_domain: CHURNED, settled_count: 6, billing_interval: 'EVERY_30_DAYS', latest_gross: 29, latest_currency: 'USD', latest_settled_at: _daysAgo(170) },
    { charge_id: '400', shop_domain: PAYING, settled_count: 4, billing_interval: 'EVERY_30_DAYS', latest_gross: 29, latest_currency: 'USD', latest_settled_at: _daysAgo(5) },
    { charge_id: '500', shop_domain: CANCELLING, settled_count: 5, billing_interval: 'EVERY_30_DAYS', latest_gross: 29, latest_currency: 'USD', latest_settled_at: _daysAgo(6) },
    // The payout is against the OLD charge; the winning subscription is the new one.
    { charge_id: '600', shop_domain: UPGRADING, settled_count: 8, billing_interval: 'ANNUAL', latest_gross: 348, latest_currency: 'USD', latest_settled_at: _daysAgo(20) },
    { charge_id: '700', shop_domain: WINDING_DOWN, settled_count: 8, billing_interval: 'EVERY_30_DAYS', latest_gross: 49, latest_currency: 'USD', latest_settled_at: _daysAgo(7) },
    //  NO CHARGE EVENT ANYWHERE FOR THIS SHOP. Shopify billed them; our event window began after
    // they subscribed. They are a paying customer and we cannot name their plan.
    { charge_id: '800', shop_domain: LEDGER_ONLY, settled_count: 3, billing_interval: 'EVERY_30_DAYS', latest_gross: 19, latest_currency: 'USD', latest_settled_at: _daysAgo(9) }
];

const _spend = (shop, gross, count, currencies, firstAgo, lastAgo) => ({
    shop_domain: shop,
    total_gross: gross,
    total_net: gross - 5,
    transaction_count: count,
    first_payment_at: _daysAgo(firstAgo),
    last_payment_at: _daysAgo(lastAgo),
    currencies
});

const SPEND = [
    _spend(CHURNED, 174, 6, ['USD'], 283, 170),
    _spend(PAYING, 116, 4, ['USD'], 108, 5),
    _spend(CANCELLING, 145, 5, ['USD'], 128, 6),
    // ⚠️ TWO CURRENCIES. There is no FX table in this build, so the total is a sum of unlike units
    // and the row must publish NO currency rather than picking one.
    _spend(UPGRADING, 696, 8, ['USD', 'EUR'], 233, 20),
    _spend(WINDING_DOWN, 392, 8, ['USD'], 243, 7),
    _spend(LEDGER_ONLY, 57, 3, ['USD'], 70, 9),
    // Known to the money ledger for a NON-SUBSCRIPTION reason (a one-off charge, a credit). No
    // subscription payout ever settled, so this shop is not a subscriber.
    _spend(GHOST, 12, 1, ['USD'], 300, 300)
];

const ATTRIBUTION = [
    {
        shop_domain: PAYING,
        shop_name: 'Paying Store',
        installed_at: _daysAgo(120),
        source: 'shopify_app_store',
        medium: 'referral',
        campaign: '',
        attribution_source: 'event_collected',
        surface_type: 'search',
        surface_detail: '',
        surface_inter_position: 1,
        surface_intra_position: 3,
        country: 'United States'
    }
];

/**
 * ⚠️ The stubs are installed BEFORE the service is required, and read mutable state afterwards.
 * Every service in this codebase destructures its repository at MODULE LOAD, so re-assigning a
 * repository export after the service has been required has no effect at all — a test that did that
 * would pass while asserting nothing.
 */
const STATE = {
    app: APP,
    relationship: { rows: RELATIONSHIP_ROWS, shopless_relationship_events: 0 },
    chargeEvents: CHARGE_EVENTS,
    settled: SETTLED,
    spend: SPEND,
    attribution: ATTRIBUTION,
    appThrows: false
};

const _reset = () => {
    STATE.app = APP;
    STATE.relationship = { rows: RELATIONSHIP_ROWS, shopless_relationship_events: 0 };
    STATE.chargeEvents = CHARGE_EVENTS;
    STATE.settled = SETTLED;
    STATE.spend = SPEND;
    STATE.attribution = ATTRIBUTION;
    STATE.appThrows = false;
};

repository.findPartnerAppById = async () => {
    if (STATE.appThrows) {
        throw new Error('the database went away');
    }
    return STATE.app;
};
repository.findRelationshipEvents = async () => STATE.relationship;
repository.findChargeCohortEvents = async () => STATE.chargeEvents;
repository.aggregateSettledSubscriptionCharges = async () => STATE.settled;
repository.aggregateStoreSpend = async () => STATE.spend;
repository.findInstallAttributionRows = async () => STATE.attribution;

const { getSubscriptionList } = require(path.join(MODULE_ROOT, 'services', 'subscriptionList.service.ts'));

const BASE = { partner_app_id: 'app-1', limit: 500 };

/**
 * Calls the service and asserts it did not refuse.
 *
 * @param {Object} [params] - Extra query parameters merged over the base query.
 * @returns {Promise<Object>} The payload.
 */
const _read = async (params = {}) => {
    const result = await getSubscriptionList({ user_id: 'operator-1' }, { ...BASE, ...params });
    assert.equal(result.status, true, `the service refused: ${result.msg}`);
    return result.data;
};

/** Rows by domain, for assertions that name a merchant. */
const _byDomain = (data) => Object.fromEntries(data.items.map((row) => [row.shop_domain, row]));

/** One facet group out of the response, by key. */
const _group = (data, key) => data.facet_groups.find((group) => group.key === key);

/** One option's count out of a facet group, or undefined when the option is missing entirely. */
const _optionCount = (group, value) => {
    const option = (group.options || []).find((o) => o.value === value);
    return option ? option.count : undefined;
};


/* ==========================================================================
 *  1.  THE POPULATION — the reason this endpoint is not "the Stores page"
 * ========================================================================== */

test(' a shop that PAID AND THEN STOPPED is ABSENT — not present with a churned status', async () => {
    _reset();
    const data = await _read();
    const domains = data.items.map((row) => row.shop_domain);

    assert.equal(domains.includes(CHURNED), false,
        'This shop settled six payouts and its last was 170 days ago. It is a former customer, and '
        + 'the whole definition of this list is "paying RIGHT NOW" — a churned shop appearing here '
        + 'with a CHURNED badge would make a count taken from this page read as "customers to date", '
        + 'and a trend built from it would be flat by construction.');

    // ...and it is COUNTED, so the absence is visible rather than merely true.
    assert.equal(data.population.excluded.settled_but_not_paying_now, 1);
});

test(' a shop that NEVER SUBSCRIBED is ABSENT, and so is one that only ever trialled', async () => {
    _reset();
    const domains = (await _read()).items.map((row) => row.shop_domain);

    assert.equal(domains.includes(NEVER), false, 'Installed, never subscribed. Not a customer.');
    assert.equal(domains.includes(TRIALLING), false,
        'A live subscription with no settled payout is not revenue. The trial funnel is where this '
        + 'merchant belongs; on a list of people paying you, they are a claim nobody measured.');
    assert.equal(domains.includes(GHOST), false,
        'Money moved for this shop, but no APP_SUBSCRIPTION payout ever settled — a one-off charge or '
        + 'a credit is not a subscription.');
});

test(' a shop MID-CANCELLATION is PRESENT, because it has already paid for the cycle it is in', async () => {
    _reset();
    const rows = _byDomain(await _read());

    assert.ok(rows[CANCELLING], 'The ledger says Shopify billed them six days ago. They are paying us.');
    assert.equal(rows[CANCELLING].status, 'CHURNED_AFTER_TRIAL',
        'Membership is the LEDGER; the status column is the EVENT RECORD, and the two disagree here '
        + 'legitimately. Collapsing them into "everyone on this list is PAYING" would hide the single '
        + 'most actionable row on the page.');
    assert.equal(rows[CANCELLING].install_state, 'UNINSTALLED');
    assert.equal(rows[CANCELLING].store_active, false);
});

test('the population block STATES the definition and its arithmetic reconciles exactly', async () => {
    _reset();
    const data = await _read();

    assert.equal(data.population.key, 'CURRENTLY_PAYING',
        'A KEY, not only a sentence: a future endpoint listing "everyone we have ever billed" must be '
        + 'distinguishable by a consumer that branches rather than reads.');
    assert.ok(data.population.statement.includes('/api/stores'),
        'The sentence must name the endpoint that answers the OTHER question, or a reader who needs '
        + 'churn has nowhere to go.');
    assert.equal(typeof data.population.live_window_days, 'number',
        'The knob that decides membership is published beside the membership. Widen it and merchants '
        + 'join this list having done nothing.');

    const excluded = data.population.excluded;
    assert.equal(
        excluded.stores_known,
        data.status_counts.ALL + excluded.never_settled_a_subscription + excluded.settled_but_not_paying_now,
        'Every store the fold saw is in exactly one of the three buckets, so a reader who suspects '
        + 'the population can CHECK it rather than trust it. ⚠️ Against status_counts.ALL, which is '
        + 'PRE-filter — `pagination.total` is post-filter and post-search, and a reader with a tab '
        + 'selected would find the identity broken and go looking for a bug that is not there.'
    );

    // ...and it still holds with a filter applied, which is the half a `pagination.total` version
    // would silently get wrong.
    const filtered = await _read({ states: 'PAYING' });
    assert.equal(
        filtered.population.excluded.stores_known,
        filtered.status_counts.ALL
            + filtered.population.excluded.never_settled_a_subscription
            + filtered.population.excluded.settled_but_not_paying_now
    );
    assert.ok(filtered.pagination.total < filtered.status_counts.ALL, 'The filter really did narrow.');
    assert.equal(excluded.stores_known, 9);
    assert.equal(excluded.never_settled_a_subscription, 3, 'never, trialling, ghost.');
    assert.equal(excluded.settled_but_not_paying_now, 1, 'churned.');
});

test('membership is the ledger, so every listed row carries a POSITIVE measured monthly figure', async () => {
    _reset();
    const data = await _read();

    for (const row of data.items) {
        assert.equal(typeof row.monthly_spend, 'number',
            `${row.shop_domain}: a null here would mean "we never evaluated this store", which cannot `
            + 'be true of a store the paying predicate admitted.');
        assert.ok(row.monthly_spend > 0,
            `${row.shop_domain}: liveSetAsOf only admits a shop whose newest settled charge is `
            + 'positive, so a 0 on this list would mean membership had been decided somewhere else.');
    }

    // ANNUAL is normalised to a monthly run-rate. Booking a year of revenue whole would overstate the
    // run-rate twelvefold — the defect `ledgerMrr.helper` divides by 12 to prevent.
    assert.equal(_byDomain(data)[UPGRADING].monthly_spend, 29,
        'A $348 ANNUAL charge is $29/month, not $348/month.');
});


/* ==========================================================================
 *  2.  THE ROW SHAPE — the `state || status` precedence trap
 * ========================================================================== */

test(' no row carries `state` or `state_label` — the badge would speak the wrong vocabulary', async () => {
    _reset();
    const data = await _read();

    for (const row of data.items) {
        assert.equal('state' in row, false,
            'StoreTable._renderStatus reads `row.state || row.status` and `state` WINS. The roster`s '
            + 'lifecycle name would badge this merchant "Converted" underneath a tab that says '
            + '"Paying" — one state, two vocabularies, one column apart.');
        assert.equal('state_label' in row, false,
            'Same precedence, same failure: `row.state_label || row.status_label`.');
        assert.equal(typeof row.status, 'string');
        assert.equal(typeof row.status_label, 'string');
        assert.ok(row.status_label.length > 0, 'Always populated, so no client needs its own map.');
    }
});

test('the row is otherwise the SAME row the Stores page renders', async () => {
    _reset();
    const row = _byDomain(await _read())[PAYING];

    // The identity the shared drawer resolves the store with. `useStoreDetailDrawer` falls back to
    // `shop_domain` when there is no tenant id, and this build has no tenant records at all.
    assert.equal(row.shop_domain, PAYING);
    assert.equal(row.customer_name, 'Paying Store');
    // Every column the shared registry can render, populated by the same resolver as the roster.
    for (const field of [
        'plan_name', 'plan_price', 'plan_interval', 'monthly_spend', 'total_spend',
        'install_state', 'install_state_label', 'has_install_record', 'store_active',
        'has_attribution', 'channel', 'channel_label', 'trial_end', 'trial_days_source',
        'conversion_date', 'churn_date', 'billing_stale', 'spend_currency', 'transaction_count'
    ]) {
        assert.ok(field in row, `${field} is missing — the shared StoreTable column would render an em dash.`);
    }
    assert.equal(row.plan_name, 'Pro');
    assert.equal(row.plan_price, 29, 'plan_price, NOT price — the table reads this name.');
    assert.equal(row.plan_interval, 'EVERY_30_DAYS', 'From a SETTLED payout, never inferred.');
    assert.equal(row.channel, 'APP_STORE_SEARCH');
    assert.equal(row.has_attribution, true);
});

test('activation_date is the subscription START, and conversion_date is Shopify`s billingOn', async () => {
    _reset();
    const rows = _byDomain(await _read());

    assert.ok(rows[PAYING].activation_date instanceof Date);
    assert.ok(rows[PAYING].conversion_date instanceof Date);
    assert.ok(rows[PAYING].activation_date.getTime() < rows[PAYING].conversion_date.getTime(),
        'The trial starts before billing begins. Two different instants, two different columns.');
    assert.equal(rows[PAYING].conversion_date_voided, false);
    assert.equal(rows[PAYING].trial_days_source, 'partner_billing_on');
});

test(' trial_end is NEVER an assumed seven days', async () => {
    _reset();
    const rows = _byDomain(await _read());

    assert.equal(rows[UPGRADING].trial_end, null,
        'Shopify supplied no billingOn for the winning charge. An assumed date sits in a rendered '
        + 'column beside real ones, in the same format, with nothing marking it — and a reader plans '
        + 'around it.');
    assert.equal(rows[UPGRADING].trial_days_source, 'none');
    assert.equal(rows[UPGRADING].status, 'ON_TRIAL');
});

test('a trial cut short marks its conversion date VOIDED rather than hiding it', async () => {
    _reset();
    const row = _byDomain(await _read())[WINDING_DOWN];

    assert.equal(row.status, 'CHURNED_DURING_TRIAL',
        'Its newest subscription`s billingOn has not arrived and the shop uninstalled first.');
    assert.ok(row.conversion_date instanceof Date, 'The date Shopify said billing WOULD begin.');
    assert.equal(row.conversion_date_voided, true,
        'The table strikes it through rather than dropping it, so the intent stays visible.');
    // ...and it is still on the list, because the cycle it already paid for has not run out.
    assert.equal(typeof row.monthly_spend, 'number');
});


/* ==========================================================================
 *  3.  THE MERCHANT THE LEDGER KNOWS AND THE EVENT RECORD DOES NOT
 * ========================================================================== */

test(' a paying shop with NO subscription event is listed, marked, and never called "Installed only"', async () => {
    _reset();
    const data = await _read();
    const row = _byDomain(data)[LEDGER_ONLY];

    assert.ok(row, 'Shopify billed them nine days ago. Dropping them would understate both the count '
        + 'and the revenue on this page.');
    assert.equal(row.ledger_only, true);
    assert.equal(row.status, 'PAYING',
        'The same classification subscriptionState.helper`s second branch makes from the same '
        + 'evidence: money moved, and nothing ended it.');
    assert.equal(row.status_basis, 'settled_payout',
        'Named so a reader can see the footing without reading this file.');
    assert.equal(row.roster_state_basis, 'join_miss',
        'The Stores page has no subscription for this shop at all. Publishing both is what makes the '
        + 'two pages` provenance comparable.');

    //  ITS PLAN COLUMNS ARE EMPTY, AND THAT IS THE HONEST ANSWER. We hold no charge record, so we
    // do not know the plan — that is not a free plan, and it is not a missing trial.
    assert.equal(row.plan_name, '');
    assert.equal(row.plan_price, null, 'A 0 here is a renderable claim that this plan is free.');
    assert.equal(row.trial_end, null);
    assert.equal(row.activation_date, null,
        'NOT back-filled from first_payment_at: a settled payout is later than the activation by '
        + 'however long Shopify took to settle, and this column is the page`s DEFAULT SORT.');

    assert.equal(data.diagnostics.ledger_only_rows, 1);
    assert.ok(data.warnings.some((w) => w.includes('no subscription event has been synced')),
        'The weaker footing must never be silent.');
});

test('the install state of a ledger-only shop is UNKNOWN with store_active null — never false', async () => {
    _reset();
    const data = await _read();
    const row = _byDomain(data)[LEDGER_ONLY];

    assert.equal(row.install_state, 'UNKNOWN');
    assert.equal(row.has_install_record, false);
    assert.equal(row.store_active, null,
        'StoreTable._renderStatus tests `store_active === false` and draws an "Uninstalled" badge. A '
        + 'defaulted false accuses a paying merchant of having removed the app.');
    assert.equal(data.diagnostics.stores_without_install_record, 1);
    assert.ok(data.warnings.some((w) => w.includes('no install or uninstall event')));
});


/* ==========================================================================
 *  4. The bare-number contract
 * ========================================================================== */

test('every figure on the response is a BARE NUMBER, never a confidence envelope', async () => {
    _reset();
    const data = await _read();

    assert.equal(typeof data.pagination.total, 'number',
        'An envelope here THROWS: the page calls total.toLocaleString() on it.');
    assert.equal(typeof data.pagination.page, 'number');
    assert.equal(typeof data.pagination.limit, 'number');
    assert.equal(typeof data.pagination.pages, 'number');
    assert.equal(typeof data.status_counts.ALL, 'number',
        'The tab labels and the search placeholder both call toLocaleString() on this.');
    assert.equal(typeof data.meta.domains_seen, 'number');
    assert.equal(typeof data.population.excluded.stores_known, 'number');

    for (const group of data.facet_groups) {
        for (const option of group.options) {
            assert.equal(typeof option.count, 'number',
                `facet_groups.${group.key} option "${option.value}" must carry a bare count.`);
        }
    }

    const rows = _byDomain(data);
    assert.equal(typeof rows[PAYING].monthly_spend, 'number',
        'fmtMoney(envelope) is Number({…}) -> NaN -> an em dash, silently.');
    assert.equal(typeof rows[PAYING].total_spend, 'number');
    assert.equal(typeof rows[PAYING].plan_price, 'number');
    assert.equal(typeof rows[PAYING].transaction_count, 'number');
});

test('a shop billed in two currencies publishes NO currency beside its total', async () => {
    _reset();
    const data = await _read();

    assert.equal(_byDomain(data)[UPGRADING].spend_currency, '',
        'There is no FX table in this build, so the total is a sum of unlike units.');
    assert.equal(_byDomain(data)[PAYING].spend_currency, 'USD');
    assert.equal(data.diagnostics.stores_with_mixed_spend_currency, 1,
        'Counted over the merchants ACTUALLY LISTED, not over every store the fold saw.');
    assert.ok(data.warnings.some((w) => w.includes('more than one') && w.includes('currency')));
});


/* ==========================================================================
 *  5. Status counts and facets: PRE-FILTER, zeros present, fail-open
 * ========================================================================== */

test('status_counts carries ALL plus every status, zeros included, and they sum to ALL', async () => {
    _reset();
    const data = await _read();

    assert.equal(data.status_counts.ALL, 5);
    assert.equal(data.status_counts.PAYING, 2, 'paying + ledger-only.');
    assert.equal(data.status_counts.ON_TRIAL, 1);
    assert.equal(data.status_counts.CHURNED_DURING_TRIAL, 1);
    assert.equal(data.status_counts.CHURNED_AFTER_TRIAL, 1);

    const summed = ['PAYING', 'ON_TRIAL', 'CHURNED_DURING_TRIAL', 'CHURNED_AFTER_TRIAL']
        .reduce((acc, key) => acc + data.status_counts[key], 0);
    assert.equal(summed, data.status_counts.ALL,
        'Every row is in exactly one tab. A row with no status — the shape a "blank status for a '
        + 'ledger-only merchant" design would produce — leaves the tabs short of ALL with nothing on '
        + 'screen to explain the gap.');

    // The tab row hard-codes these four ids and reads `status_counts_filtered[id]` for each. A key
    // missing because its count is zero withdraws that tab`s number entirely.
    STATE.settled = [];
    const empty = await _read();
    for (const key of ['ALL', 'PAYING', 'ON_TRIAL', 'CHURNED_DURING_TRIAL', 'CHURNED_AFTER_TRIAL']) {
        assert.equal(empty.status_counts[key], 0, `${key} must be present at 0, not omitted.`);
    }
});

test('facet counts are PRE-FILTER for their own group, and the tab counts are not', async () => {
    _reset();
    const unfiltered = await _read();
    const filtered = await _read({ states: 'PAYING' });

    assert.deepEqual(
        _group(filtered, 'states').options.map((o) => [o.value, o.count]),
        _group(unfiltered, 'states').options.map((o) => [o.value, o.count]),
        'A group is tallied over the rows that pass every OTHER group. Applying its own selection '
        + 'would make every unselected option read (0) the moment one is chosen.'
    );

    assert.equal(filtered.status_counts.ALL, 5, 'status_counts is the UNFILTERED tally — it labels the tabs.');
    assert.equal(filtered.status_counts_filtered.ALL, 5,
        'The tab row IS the `states` group, so that group is the one excluded from its own counts. '
        + 'Applying it would make every tab except the selected one read (0) the moment a tab is '
        + 'clicked, which reads as "there is nothing else".');
    assert.equal(filtered.items.length, 2);
});

test('status_counts_filtered narrows when a DIFFERENT group is selected', async () => {
    _reset();
    const data = await _read({ install_states: 'UNINSTALLED' });

    assert.equal(data.status_counts.ALL, 5, 'The unfiltered tally labels the tabs and must not move.');
    assert.equal(data.status_counts_filtered.ALL, 2,
        'With an install-state filter applied, a tab number has to predict what clicking it shows.');
    assert.equal(data.status_counts_filtered.CHURNED_AFTER_TRIAL, 1);
    assert.equal(data.status_counts_filtered.PAYING, 0,
        'Zeros stay PRESENT: a key missing because its count is zero withdraws that tab`s number.');
    assert.equal(data.items.length, 2, 'cancelling + winding-down are the two that left.');
});

test('every facet group publishes its empty buckets rather than omitting them', async () => {
    _reset();
    const data = await _read();

    assert.deepEqual(data.facet_groups.map((g) => g.key), ['states', 'install_states', 'billing', 'store_statuses'],
        'FOUR groups. The page initialises exactly these and its "Clear all filters" resets exactly '
        + 'these, so a fifth would render a checkbox the Clear-all button cannot clear.');

    const states = _group(data, 'states');
    for (const key of ['PAYING', 'ON_TRIAL', 'CHURNED_DURING_TRIAL', 'CHURNED_AFTER_TRIAL']) {
        assert.notEqual(_optionCount(states, key), undefined,
            `The status ${key} must be offered even at zero — a group that omits its empty buckets `
            + 'makes a SAMPLE look like a distribution.');
    }

    const installStates = _group(data, 'install_states');
    assert.equal(_optionCount(installStates, 'INSTALLED'), 2);
    assert.equal(_optionCount(installStates, 'UNINSTALLED'), 2);
    assert.equal(_optionCount(installStates, 'UNKNOWN'), 1);

    const billing = _group(data, 'billing');
    assert.notEqual(_optionCount(billing, 'UNKNOWN'), undefined,
        '"Cadence not settled yet" holds the denominator. Two merchants on an annual plan with every '
        + 'other cadence unsettled renders as "100% annual" without it.');

    const storeStatuses = _group(data, 'store_statuses');
    assert.equal(_optionCount(storeStatuses, 'NOT_PUSHED'), 5,
        'Every merchant is in the "Not pushed" bucket until the enrichment wave lands, which is a '
        + 'true statement about this deployment rather than an empty group.');
});

test(' an unrecognised facet value WIDENS the result and warns — it never empties the table', async () => {
    _reset();
    const clean = await _read();

    for (const [group, value] of [
        ['states', 'PAID'],
        ['install_states', 'INSTALED'],
        ['billing', 'MONTHLY']
    ]) {
        const bad = await _read({ [group]: value });
        assert.equal(bad.items.length, clean.items.length,
            `${group}=${value} must WIDEN, not empty. An empty table here is indistinguishable from `
            + '"you have no paying customers", which is the most alarming thing this dashboard could '
            + 'say by accident.');
        assert.ok(bad.diagnostics.unrecognised_filters.includes(`${group}=${value}`),
            'The dropped value is echoed so a typo is visible rather than merely ineffective.');
        assert.ok(bad.warnings.some((w) => w.includes(value)));
        assert.deepEqual(bad.filters[group], [],
            'Dropping every value in a group leaves it UNCONSTRAINED, not "matches nothing".');
    }

    // ...and the real values still narrow.
    const onTrial = await _read({ states: 'ON_TRIAL' });
    assert.deepEqual(onTrial.filters.states, ['ON_TRIAL']);
    assert.deepEqual(onTrial.items.map((r) => r.shop_domain), [UPGRADING]);
});

test('a value the LIST produced is honoured even when the vocabulary has not learned it', async () => {
    _reset();
    //  The escape hatch. A cadence Shopify sends that this build has never seen is OFFERED as a
    // facet option (the options are tallied from the rows), so rejecting it on selection would be a
    // checkbox that ticks and empties the table — worse than the bug the closed check fixes.
    STATE.settled = SETTLED.map((row) => (
        row.shop_domain === PAYING ? { ...row, billing_interval: 'EVERY_90_DAYS' } : row
    ));

    const offered = _group(await _read(), 'billing');
    assert.ok((offered.options || []).some((o) => o.value === 'EVERY_90_DAYS'),
        'The group offers it, so the group must be able to filter on it.');

    const data = await _read({ billing: 'EVERY_90_DAYS' });
    assert.deepEqual(data.filters.billing, ['EVERY_90_DAYS']);
    assert.deepEqual(data.diagnostics.unrecognised_filters, []);
    assert.deepEqual(data.items.map((r) => r.shop_domain), [PAYING]);
});

test('an unrecognised sort key falls back to the default and warns', async () => {
    _reset();
    const data = await _read({ sort: 'lifetime_value' });

    assert.equal(data.sort.key, 'activation_date');
    assert.equal(data.sort.dir, 'desc');
    assert.ok(data.diagnostics.unrecognised_filters.includes('sort=lifetime_value'));
    assert.ok(data.warnings.some((w) => w.includes('lifetime_value')));
});

test('`refresh` is accepted and changes nothing — there is no cache to invalidate', async () => {
    _reset();
    const plain = await _read();
    const refreshed = await _read({ refresh: true });

    assert.deepEqual(refreshed.status_counts, plain.status_counts);
    assert.equal(refreshed.items.length, plain.items.length);
});


/* ==========================================================================
 *  6. Sorting, and where an absence belongs
 * ========================================================================== */

test(' nulls sort LAST in BOTH directions', async () => {
    _reset();

    // The ledger-only merchant has no activation date and no plan name: we hold no charge record for
    // them at all. Neither absence is an extreme value.
    for (const key of ['activation_date', 'plan_name']) {
        for (const dir of ['asc', 'desc']) {
            const data = await _read({ sort: key, dir });
            const domains = data.items.map((row) => row.shop_domain);
            assert.equal(domains[domains.length - 1], LEDGER_ONLY,
                `sort=${key} dir=${dir}: a merchant whose activation we do not hold is not "the `
                + 'newest" when you ask for newest first, and not "the oldest" when you ask for '
                + 'oldest first. Floating an ABSENCE to the top presents it as an extreme value.');
        }
    }
});

test('sorting reads `dir`, not `sort_dir` — the spelling this page sends', async () => {
    _reset();
    const ascending = await _read({ sort: 'customer_name', dir: 'asc' });
    const descending = await _read({ sort: 'customer_name', dir: 'desc' });

    assert.equal(ascending.sort.dir, 'asc');
    assert.equal(descending.sort.dir, 'desc');
    assert.deepEqual(
        descending.items.map((r) => r.shop_domain).reverse(),
        ascending.items.map((r) => r.shop_domain),
        'The two directions must be exact reverses of each other for a total, tie-broken order.'
    );
});

test('the sort is a COPY — the tallies are taken from the unsorted array', async () => {
    _reset();
    const byName = await _read({ sort: 'customer_name', dir: 'asc' });
    const bySpend = await _read({ sort: 'monthly_spend', dir: 'desc' });

    assert.deepEqual(byName.status_counts, bySpend.status_counts,
        'Every count comes from the same array the list does, so they cannot drift — and sorting in '
        + 'place would reorder the very array those tallies were taken from.');
    assert.equal(byName.pagination.total, bySpend.pagination.total);
    assert.deepEqual(byName.population.excluded, bySpend.population.excluded);
});


/* ==========================================================================
 *  7. Pagination and search, exactly as the component reads them
 * ========================================================================== */

test('pagination is {page, limit, total, pages} — `pages`, never `total_pages`', async () => {
    _reset();
    const data = await _read({ limit: 2, page: 2 });

    assert.deepEqual(Object.keys(data.pagination).sort(), ['limit', 'page', 'pages', 'total']);
    assert.equal(data.pagination.total, 5);
    assert.equal(data.pagination.pages, 3, 'The page reads `pages`; `total_pages` blanks the footer.');
    assert.equal(data.pagination.page, 2);
    assert.equal(data.pagination.limit, 2);
    assert.equal(data.items.length, 2);
});

test('an empty result is a 200 with total 0 and pages 0', async () => {
    _reset();
    const data = await _read({ q: 'no-such-merchant-anywhere' });

    assert.deepEqual(data.items, [],
        'An ARRAY, always: dataState.js decodes `items === null` as NEVER_SYNCED and nulls the whole '
        + 'payload, taking the population statement with it.');
    assert.equal(data.pagination.total, 0);
    assert.equal(data.pagination.pages, 0,
        'Math.ceil(0/limit) with no floor. The page clamps for display; the API states the measurement.');
    assert.equal(data.pagination.page, 1);
});

test('a page beyond the end clamps rather than answering out of range', async () => {
    _reset();
    const data = await _read({ limit: 2, page: 99 });

    assert.equal(data.pagination.page, 3);
    assert.equal(data.items.length, 1);
});

test('an oversized limit is clamped AND said out loud', async () => {
    _reset();
    const data = await _read({ limit: 5000 });

    assert.equal(data.pagination.limit, 500);
    assert.ok(data.warnings.some((w) => w.includes('5000')),
        'The caller asked for a page size this endpoint will not serve; the pagination block carries '
        + 'the real total, and the warning says the list is one page of a smaller size.');
});

test('the search box matches name, domain and plan', async () => {
    _reset();

    assert.deepEqual((await _read({ q: 'Cancelling' })).items.map((r) => r.shop_domain), [CANCELLING]);
    assert.deepEqual((await _read({ q: 'scale' })).items.map((r) => r.shop_domain).sort(), [UPGRADING, WINDING_DOWN].sort());
    assert.deepEqual((await _read({ q: 'ledger-only-payer' })).items.map((r) => r.shop_domain), [LEDGER_ONLY]);
    assert.equal((await _read({ q: 'LEDGER-ONLY-PAYER' })).items.length, 1, 'Case-insensitive.');
    assert.equal((await _read({ q: '(' })).items.length, 0,
        'A bracket must be a substring, never a regular expression — a `(` compiled from user input '
        + 'would throw and turn a typo into a refusal of the whole endpoint.');
});


/* ==========================================================================
 *  8. Empty states, tier states and refusals
 * ========================================================================== */

test('NEVER_SYNCED is a 200 carrying unknown_reason — the only way the sentence survives', async () => {
    _reset();
    STATE.app = { ...APP, last_synced_at: null };
    STATE.relationship = { rows: [], shopless_relationship_events: 0 };
    STATE.chargeEvents = [];
    STATE.settled = [];
    STATE.spend = [];

    const data = await _read();

    assert.equal(data.data_state, 'NEVER_SYNCED');
    assert.equal(typeof data.unknown_reason, 'string');
    assert.ok(data.unknown_reason.length > 0,
        'frontend/dataState.js intercepts NEVER_SYNCED, NULLS `data` — warnings and all — and renders '
        + '`data.unknown_reason || resp.msg`. Without this field that resolves to the SUCCESS message.');
    assert.deepEqual(data.items, []);
});

test('READY with nobody paying is a DIFFERENT answer, and carries no unknown_reason', async () => {
    _reset();
    STATE.settled = [];

    const data = await _read();

    assert.equal(data.data_state, 'READY',
        'The discriminator is the WATERMARK, never the row count: "nobody is paying you right now" is '
        + 'a real, publishable answer once a sync has run.');
    assert.equal(data.unknown_reason, undefined);
    assert.deepEqual(data.items, []);
    assert.equal(data.population.excluded.stores_known, 9,
        'All nine stores are still there — the ledger-only merchant among them, because the all-type '
        + 'spend rollup still names it. It is the PAYING SET that is empty, and the population block '
        + 'is what says which of the two an empty table means.');
    assert.equal(data.population.excluded.never_settled_a_subscription, 9,
        'With no subscription payout anywhere, every store falls in the "nothing ever settled" '
        + 'bucket rather than the "settled and stopped" one. `null` and `0` are different answers '
        + 'and they are the two halves of "why is this merchant not on the list".');
    assert.equal(data.population.excluded.settled_but_not_paying_now, 0);
});

test(' an empty payout ledger is EXPLAINED, because it empties this page for a non-business reason', async () => {
    _reset();
    // No payout has ever been fetched. The list is empty, and an empty Subscriptions page reads as
    // "you have no paying customers" — a claim about the operator`s business that no data made.
    STATE.app = { ...APP, earliest_transaction_at: null };
    STATE.settled = [];
    STATE.spend = [];

    const data = await _read();

    assert.equal(data.data_state, 'READY',
        '`earliest_transaction_at` is $min(created_at) OVER THE ROWS — a row count in disguise — so it '
        + 'cannot be the NEVER_SYNCED discriminator without turning "this app has genuinely never been '
        + 'paid" into "nothing has synced".');
    assert.deepEqual(data.items, []);
    assert.ok(
        data.warnings.some((w) => w.includes('No settled payouts have ever been fetched')),
        'The empty ledger has to be said out loud, precisely because it cannot change the data_state.'
    );
    assert.ok(
        data.warnings.some((w) => w.includes('cannot tell')),
        'And it has to name the two things it cannot tell apart, rather than picking one.'
    );
});

test('BigQuery being unconfigured is NOT a refusal — the list comes from the Partner API', async () => {
    _reset();
    // The tier state is resolved from config, which this process has set, so the NOT_CONNECTED branch
    // is exercised in `storeUnconfigured.test.js` instead. Here we assert the READY contract holds
    // and that a row with no attribution record says "no evidence" rather than "Direct".
    const rows = _byDomain(await _read());

    assert.equal(rows[PAYING].has_attribution, true);
    assert.equal(rows[LEDGER_ONLY].has_attribution, false);
    assert.equal(rows[LEDGER_ONLY].channel, 'UNKNOWN',
        'DIRECT is already the largest bucket, so a merchant we cannot explain would vanish into it.');
    assert.equal(rows[LEDGER_ONLY].channel_label, 'Not attributed');
});

test('warnings are UNIQUE — React keys them by content, so a duplicate DROPS one', async () => {
    _reset();
    const data = await _read({ states: 'NOPE', install_states: 'ALSO_NOPE' });

    assert.equal(new Set(data.warnings).size, data.warnings.length,
        'A second copy of a message does not double up — it DISAPPEARS, and takes its condition with '
        + 'it.');
    for (const warning of data.warnings) {
        assert.equal(typeof warning, 'string');
        assert.ok(warning.length > 0);
    }
});

test('the response publishes the vocabularies the page renders from', async () => {
    _reset();
    const data = await _read();

    assert.deepEqual(Object.keys(data.statuses).sort(),
        ['CHURNED_AFTER_TRIAL', 'CHURNED_DURING_TRIAL', 'ON_TRIAL', 'PAYING'],
        'The tab row hard-codes these four ids. A fifth appears in the counts, in no tab, and breaks '
        + 'sum(tabs) === ALL on screen with no explanation.');
    assert.equal(data.statuses.PAYING, 'Paying');
    assert.equal(data.statuses.CHURNED_AFTER_TRIAL, 'Churned after trial');
    assert.deepEqual(Object.keys(data.install_states), ['INSTALLED', 'UNINSTALLED', 'UNKNOWN'],
        'Shared verbatim with the Stores roster — the same badge must not read two ways.');
    assert.equal(data.app_name, 'Demo App');
    assert.equal(typeof data.as_of, 'string');
});

test('the refusals are the four named ones, and each carries an actionable sentence', async () => {
    _reset();

    const noUser = await getSubscriptionList({}, BASE);
    assert.equal(noUser.status, false);
    assert.deepEqual(noUser.data, {});

    const noApp = await getSubscriptionList({ user_id: 'operator-1' }, {});
    assert.equal(noApp.status, false);
    assert.ok(noApp.msg.includes('partner_app_id'));
    assert.ok(noApp.msg.includes('/api/partner-apps'), 'The message must say where to get the value.');

    STATE.app = null;
    const missing = await getSubscriptionList({ user_id: 'operator-1' }, BASE);
    assert.equal(missing.status, false);
    assert.equal(missing.msg, 'Partner app not found.');

    _reset();
    STATE.appThrows = true;
    const broke = await getSubscriptionList({ user_id: 'operator-1' }, BASE);
    assert.equal(broke.status, false);
    assert.deepEqual(broke.data, {}, 'A failed call carries {} — never a partial payload.');
});


/* ==========================================================================
 *  9.  THE TWO PAGES MUST NOT DISAGREE
 * ========================================================================== */

test(' every merchant on this list is the SAME merchant on GET /api/stores, field for field', async () => {
    _reset();
    const { getStoreRoster } = require(path.join(MODULE_ROOT, 'services', 'storeRoster.service.ts'));

    const subscriptions = _byDomain(await _read());
    const roster = await getStoreRoster({ user_id: 'operator-1' }, { partner_app_id: 'app-1', limit: 500 });
    assert.equal(roster.status, true);
    const rosterRows = Object.fromEntries(roster.data.items.map((row) => [row.shop_domain, row]));

    for (const domain of Object.keys(subscriptions)) {
        const here = subscriptions[domain];
        const there = rosterRows[domain];
        assert.ok(there, `${domain} is on the Subscriptions list and missing from the roster entirely.`);

        // The fields both tables render. A difference in any of them is one merchant described two
        // ways on two pages — the exact divergence this wave was written to prevent, and the reason
        // the fold is shared rather than copied.
        for (const field of [
            'customer_name', 'plan_name', 'plan_price', 'plan_interval', 'monthly_spend',
            'total_spend', 'spend_currency', 'install_state', 'install_state_label', 'store_active',
            'has_attribution', 'channel', 'trial_end', 'conversion_date', 'churn_date',
            'billing_stale', 'transaction_count'
        ]) {
            assert.deepEqual(here[field], there[field],
                `${domain}.${field} differs: ${JSON.stringify(here[field])} here, `
                + `${JSON.stringify(there[field])} on the Stores page.`);
        }
    }

    // ...and the roster's population is strictly larger, which is the whole reason both exist.
    assert.ok(roster.data.pagination.total > Object.keys(subscriptions).length,
        'The Stores page lists every store ever. If the two ever have the same population, one of '
        + 'them has stopped meaning what it says.');
});

test(' the status here and the state there are the SAME state under two names', async () => {
    _reset();
    const { getStoreRoster } = require(path.join(MODULE_ROOT, 'services', 'storeRoster.service.ts'));

    // The mapping `storePresentation.js` documents, asserted rather than assumed. It is what makes
    // one badge tone correct for both vocabularies.
    const EQUIVALENT = {
        PAYING: 'CONVERTED',
        ON_TRIAL: 'ON_TRIAL',
        CHURNED_DURING_TRIAL: 'CHURNED_IN_TRIAL',
        CHURNED_AFTER_TRIAL: 'CHURNED'
    };

    const subscriptions = _byDomain(await _read());
    const roster = await getStoreRoster({ user_id: 'operator-1' }, { partner_app_id: 'app-1', limit: 500 });
    const rosterRows = Object.fromEntries(roster.data.items.map((row) => [row.shop_domain, row]));

    for (const domain of Object.keys(subscriptions)) {
        if (subscriptions[domain].ledger_only) {
            //  THE ONE ROW THAT LEGITIMATELY DIFFERS, and it differs in the honest direction: the
            // Stores page has no subscription for this merchant and files them under the left-join
            // miss, while this page classifies them from the payout ledger that put them on the list.
            assert.equal(rosterRows[domain].state, 'INSTALLED');
            assert.equal(subscriptions[domain].status, 'PAYING');
            continue;
        }
        assert.equal(EQUIVALENT[subscriptions[domain].status], rosterRows[domain].state,
            `${domain}: "${subscriptions[domain].status}" here and "${rosterRows[domain].state}" on `
            + 'the Stores page are supposed to be one state under two vocabularies.');
    }
});
