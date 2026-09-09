'use strict';

/**
 * ============================================================================
 *  THE STORE ROSTER — the response contract, and the six ways to get it wrong
 * ============================================================================
 *
 *  Exercises `getStoreRoster` end to end with the repository stubbed out, so the whole assembly —
 *  relationship fold → charge cohort → money → row → facets → counts → sort → paging → warnings —
 *  runs against fixtures with no database and no BigQuery.
 *
 *  ── 1. THE BARE-NUMBER CONTRACT, WHICH IS THE REASON THIS FILE EXISTS ────
 *
 *  Every figure on this response is a BARE NUMBER. This is one of the two places in the codebase
 *  where `IMPLEMENTATION.md` §3.11's confidence envelope must NOT be applied, and the failure mode is
 *  entirely silent: `fmtMoney` (`storePresentation.js:244`) does `Number(n)`, so `Number({value: 29})`
 *  is `NaN` and an enveloped `monthly_spend` renders as an em dash — while
 *  `pagination.total.toLocaleString()` (`stores/index.js:101`) THROWS outright and takes the whole
 *  page's footer with it. A future reader applying §3.11 uniformly is doing the right thing
 *  everywhere else; this file is what tells them where the exception is.
 *
 *  ── 2. FACET COUNTS ARE PRE-FILTER, AND EVERY ZERO IS PRESENT ─────────────
 *
 *  A group's options are tallied over the rows that pass every OTHER group. A post-filter count makes
 *  every unselected option read `(0)` the moment one is chosen, which reads as "there is nothing
 *  else" rather than "you have filtered it out". And a key omitted because its count is zero removes
 *  that tab's number entirely, which reads as "we did not measure it".
 *
 *  ── 3. VALIDATION FAILS OPEN ───────────────────────────────────────────────
 *  A typo in a facet value or a sort key must WIDEN the result set and say so. `?install_states=
 *  INSTALED` returning an empty table is indistinguishable from a business with no stores.
 *
 *  ── 4. NULLS SORT LAST IN BOTH DIRECTIONS ──────────────────────────────────
 *  A store that has never paid is not "the cheapest" when you ask for lowest spend first. Floating an
 *  ABSENCE to the top of a list presents it as an extreme value.
 *
 *  ── 5. NO ASSUMED TRIAL END ────────────────────────────────────────────────
 *  The source this was ported from added seven days to the trial start whenever Shopify supplied no
 *  `billingOn`. `trial_end` is a RENDERED COLUMN: an assumed date sits beside real ones, in the same
 *  format, with nothing marking it.
 *
 *  ── 6. EMPTY IS A 200, AND THE DISCRIMINATOR IS THE WATERMARK ─────────────
 *  No stores plus a watermark is a publishable "nobody has ever installed this app". No stores and no
 *  watermark is "we have not looked yet", and `unknown_reason` is the only way that sentence survives
 *  the frontend's `dataState.js`, which nulls `data` and renders `data.unknown_reason || resp.msg`.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';
//  The attribution join is SKIPPED entirely when the listing tier is unconfigured — which is
// correct, and would leave the acquisition half of this file untested. These three are what
// `resolveBigQueryAvailability` reads; nothing here ever reaches BigQuery.
// ⚠️ `test/storeUnconfigured.test.js` is the same two endpoints WITHOUT them, which is why that file
// exists separately: `src/config` snapshots `process.env` at first require, so one process cannot
// test both tiers.
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
 * The service reads the clock itself — deliberately, so one response cannot classify a store as of
 * two different moments — and `liveSetAsOf` decides whether a store is paying TODAY from a rolling
 * window (`ACTIVE_SUB_WINDOW_DAYS`, 38 by default). Absolute dates would make "is this store still
 * paying" answer differently depending on when the suite is run, and it would start failing on a
 * Tuesday months from now for no reason anyone could find.
 */
const NOW = Date.now();
const _daysAgo = (days) => new Date(NOW - (days * 86400000));

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

const BARE = 'bare-shop.myshopify.com';
const CHURNED = 'churned-shop.myshopify.com';
const CONVERTED = 'converted-shop.myshopify.com';
const TRIAL = 'trial-shop.myshopify.com';
const GHOST = 'ghost-shop.myshopify.com';
const DEACTIVATED = 'deactivated-shop.myshopify.com';

/**
 * Six stores, one per interesting outcome. Between them they cover every branch of the row builder:
 *
 *   bare         install only, no subscription, no money      -> INSTALLED / INSTALLED, spend null
 *   churned      billingOn then an UNINSTALL after it         -> UNINSTALLED / CHURNED, spend aged out
 *   converted    billingOn in the past, a recent payout       -> INSTALLED / CONVERTED, paying now
 *   trial        no billingOn, no payout                      -> INSTALLED / ON_TRIAL on `inferred`
 *   ghost        NO relationship event at all, payouts only   -> UNKNOWN, store_active null
 *   deactivated  install then a Shopify DEACTIVATED           -> UNINSTALLED labelled "Deactivated"
 */
const RELATIONSHIP_ROWS = [
    { shop_domain: BARE, event_type: 'INSTALL', occurred_at: _daysAgo(30), shop_name: 'Bare Store', shop_id: 'gid://partners/Shop/1' },
    { shop_domain: CHURNED, event_type: 'INSTALL', occurred_at: _daysAgo(200), shop_name: 'Churned Store', shop_id: 'gid://partners/Shop/2' },
    //  The relationship END event. It carries NO charge block, so it is a subscription's only end
    // signal when no cancellation ever lands — the service has to re-join it into the charge cohort
    // or this store reads as CONVERTED for ever.
    { shop_domain: CHURNED, event_type: 'UNINSTALL', occurred_at: _daysAgo(60), shop_name: '', shop_id: 'gid://partners/Shop/2' },
    { shop_domain: CONVERTED, event_type: 'INSTALL', occurred_at: _daysAgo(120), shop_name: 'Converted Store', shop_id: 'gid://partners/Shop/3' },
    { shop_domain: TRIAL, event_type: 'INSTALL', occurred_at: _daysAgo(10), shop_name: 'Trial Store', shop_id: 'gid://partners/Shop/4' },
    { shop_domain: DEACTIVATED, event_type: 'INSTALL', occurred_at: _daysAgo(90), shop_name: 'Frozen Store', shop_id: 'gid://partners/Shop/6' },
    { shop_domain: DEACTIVATED, event_type: 'DEACTIVATED', occurred_at: _daysAgo(20), shop_name: '', shop_id: 'gid://partners/Shop/6' }
];

/**
 * ⚠️ SUBSCRIPTION TYPES ONLY, exactly as the repository's `$in` produces them: the relationship end
 * events above are fetched by the OTHER read and re-joined by the service. A fixture that also
 * carried the UNINSTALL here would hide a regression in that re-join.
 */
const CHARGE_EVENTS = [
    {
        event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
        shop_domain: CONVERTED,
        charge_id: '111',
        occurred_at: _daysAgo(100),
        raw_event: {
            charge: {
                id: 'gid://shopify/AppSubscription/111',
                name: 'Pro',
                billingOn: _daysAgo(93).toISOString(),
                test: false,
                amount: { amount: '29.00', currencyCode: 'USD' }
            }
        }
    },
    {
        event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
        shop_domain: CHURNED,
        charge_id: '333',
        occurred_at: _daysAgo(180),
        raw_event: {
            charge: {
                id: 'gid://shopify/AppSubscription/333',
                name: 'Pro',
                billingOn: _daysAgo(173).toISOString(),
                test: false,
                amount: { amount: '29.00', currencyCode: 'USD' }
            }
        }
    },
    // NO `billingOn` and no settled payout: the ONLY guess the state machine makes, and the row it
    // produces must carry `trial_end: null` rather than an assumed date.
    {
        event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
        shop_domain: TRIAL,
        charge_id: '222',
        occurred_at: _daysAgo(9),
        raw_event: {
            charge: {
                id: 'gid://shopify/AppSubscription/222',
                name: 'Starter',
                test: false,
                amount: { amount: '9.00', currencyCode: 'USD' }
            }
        }
    }
];

const SETTLED = [
    {
        charge_id: '111',
        shop_domain: CONVERTED,
        settled_count: 4,
        billing_interval: 'EVERY_30_DAYS',
        latest_gross: 29,
        latest_currency: 'USD',
        // Inside the live window, so this store is paying TODAY.
        latest_settled_at: _daysAgo(5)
    },
    {
        charge_id: '333',
        shop_domain: CHURNED,
        settled_count: 2,
        billing_interval: 'EVERY_30_DAYS',
        latest_gross: 29,
        latest_currency: 'USD',
        // Far outside it: `monthly_spend` must be `0` (measured, not paying) and NOT `null`.
        latest_settled_at: _daysAgo(170)
    }
];

const SPEND = [
    {
        shop_domain: CONVERTED,
        total_gross: 116,
        total_net: 100,
        transaction_count: 4,
        first_payment_at: _daysAgo(95),
        last_payment_at: _daysAgo(5),
        currencies: ['USD']
    },
    {
        shop_domain: CHURNED,
        total_gross: 58,
        total_net: 50,
        transaction_count: 2,
        first_payment_at: _daysAgo(178),
        last_payment_at: _daysAgo(170),
        // ⚠️ TWO CURRENCIES. There is no FX table in this build, so the total is a sum of unlike
        // units and the row must publish NO currency rather than picking one.
        currencies: ['USD', 'EUR']
    },
    {
        // Known to the money ledger and to nothing else. It is still a store.
        shop_domain: GHOST,
        total_gross: 12,
        total_net: 10,
        transaction_count: 1,
        first_payment_at: _daysAgo(300),
        last_payment_at: _daysAgo(300),
        currencies: ['USD']
    }
];

/**
 * Two records for the converted store — the NEAREST in time to its Partner install instant must win,
 * because the implementation this was ported from took the latest overall and attached a later
 * visit's channel to an earlier install.
 *
 * ⚠️ `surface_detail` IS TWO DIFFERENT FIELDS WEARING ONE NAME, and these rows carry a real value
 * for each of them. On a SEARCH surface it is the merchant's own typed query, which this build no
 * longer serves; on a BROWSE surface it is Shopify's placement handle, which the "Came from" column
 * is made of and which decides paid against organic. A fixture that blanks both — which is what the
 * search-visibility change left behind — exercises the read guard in NEITHER direction: both guards
 * could be deleted outright and every test here would still pass, while the endpoint quietly went
 * back to serving stored queries. So the converted store's search record keeps a query and the
 * deactivated store carries a browse record with a placement handle.
 *
 * The last row names a domain the Partner API has never mentioned: it must produce NO ROW (a GA4
 * artefact cannot invent a merchant) and must be counted and warned about instead.
 */
const ATTRIBUTION = [
    {
        shop_domain: CONVERTED,
        shop_name: 'Converted Store',
        installed_at: _daysAgo(120),
        source: 'shopify_app_store',
        medium: 'referral',
        campaign: '',
        attribution_source: 'event_collected',
        surface_type: 'search',
        //  A STORED query, of the kind an operator upgrading to this build still has sitting in
        // Mongo from before capture was blanked — which is the whole reason the guard is on READ as
        // well as on write. Obviously synthetic, so nobody reads it as a term a real merchant typed.
        surface_detail: 'fixture query text',
        surface_inter_position: 1,
        surface_intra_position: 3,
        country: 'United States'
    },
    {
        shop_domain: CONVERTED,
        shop_name: 'Converted Store (a later visit)',
        installed_at: _daysAgo(4),
        source: 'google',
        medium: 'organic',
        campaign: '',
        attribution_source: 'user_first_acquisition',
        surface_type: '',
        surface_detail: '',
        surface_inter_position: null,
        surface_intra_position: null,
        country: 'Ireland'
    },
    {
        //  THE OTHER DIRECTION OF THE SAME GUARD, and the one that is expensive to get wrong. On a
        // browse surface this field is Shopify's own placement handle rather than anything a
        // merchant typed, and `homepage-ads` is the handle that separates a paid click from organic
        // browsing: `surface.constants.ts` records 49 `home`/homepage-ads installs against 3
        // `homepage_ad` in the production data it was written from, because the pageview lands after
        // the ad click and last-touch keeps the listing URL's label. A guard widened to blank every
        // detail — or moved upstream of `classifyAcquisitionChannel`, which reads the repository row
        // — re-reads that whole recorded population as organic, in the one column that exists to
        // tell those two apart, and nothing on the page would say so.
        shop_domain: DEACTIVATED,
        shop_name: 'Frozen Store',
        installed_at: _daysAgo(90),
        source: 'shopify_app_store',
        medium: 'referral',
        campaign: '',
        attribution_source: 'event_collected',
        surface_type: 'home',
        surface_detail: 'homepage-ads',
        // On `home` this counts SECTIONS down the page, not pages of results — see
        // `isPageIndexedSurface`. Nothing here renders it; it is present so the row is a whole one.
        surface_inter_position: 2,
        surface_intra_position: 1,
        country: 'United States'
    },
    {
        shop_domain: 'stranger.myshopify.com',
        shop_name: 'Stranger',
        installed_at: _daysAgo(50),
        source: 'google',
        medium: 'organic',
        campaign: '',
        attribution_source: 'event_collected',
        surface_type: '',
        surface_detail: '',
        surface_inter_position: null,
        surface_intra_position: null,
        country: 'Canada'
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
    relationship: { rows: RELATIONSHIP_ROWS, shopless_relationship_events: 2 },
    chargeEvents: CHARGE_EVENTS,
    settled: SETTLED,
    spend: SPEND,
    attribution: ATTRIBUTION,
    appThrows: false
};

const _reset = () => {
    STATE.app = APP;
    STATE.relationship = { rows: RELATIONSHIP_ROWS, shopless_relationship_events: 2 };
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

const { getStoreRoster } = require(path.join(MODULE_ROOT, 'services', 'storeRoster.service.ts'));

const BASE = { partner_app_id: 'app-1', limit: 500 };

/**
 * Calls the service and asserts it did not refuse.
 *
 * @param {Object} [params] - Extra query parameters merged over the base query.
 * @returns {Promise<Object>} The payload.
 */
const _read = async (params = {}) => {
    const result = await getStoreRoster({ user_id: 'operator-1' }, { ...BASE, ...params });
    assert.equal(result.status, true, `the service refused: ${result.msg}`);
    return result.data;
};

/** Rows by domain, for assertions that name a store. */
const _byDomain = (data) => Object.fromEntries(data.items.map((row) => [row.shop_domain, row]));

/** One facet group out of the response, by key. */
const _group = (data, key) => data.facet_groups.find((group) => group.key === key);

/** One option's count out of a facet group, or undefined when the option is missing entirely. */
const _optionCount = (group, value) => {
    const option = (group.options || []).find((o) => o.value === value);
    return option ? option.count : undefined;
};


/* ==========================================================================
 *  1. The bare-number contract
 * ========================================================================== */

test('every figure on the response is a BARE NUMBER, never a confidence envelope', async () => {
    _reset();
    const data = await _read();

    assert.equal(typeof data.pagination.total, 'number',
        'An envelope here THROWS: stores/index.js calls total.toLocaleString() on it.');
    assert.equal(typeof data.pagination.page, 'number');
    assert.equal(typeof data.pagination.limit, 'number');
    assert.equal(typeof data.pagination.pages, 'number');
    assert.equal(typeof data.install_state_counts.ALL, 'number',
        'The tab labels and the search placeholder both call toLocaleString() on this.');
    assert.equal(typeof data.meta.domains_seen, 'number');

    for (const group of data.facet_groups) {
        for (const option of group.options) {
            assert.equal(typeof option.count, 'number',
                `facet_groups.${group.key} option "${option.value}" must carry a bare count.`);
        }
    }

    const rows = _byDomain(data);
    assert.equal(typeof rows[CONVERTED].monthly_spend, 'number',
        'fmtMoney(envelope) is Number({…}) -> NaN -> an em dash, silently.');
    assert.equal(typeof rows[CONVERTED].total_spend, 'number');
    assert.equal(typeof rows[CONVERTED].install_count, 'number');
    assert.equal(typeof rows[CONVERTED].transaction_count, 'number');
});

test('monthly_spend separates "measured and not paying" (0) from "nothing to evaluate" (null)', async () => {
    _reset();
    const rows = _byDomain(await _read());

    assert.equal(rows[CONVERTED].monthly_spend, 29,
        'A settled payout inside the live window is the canonical MRR predicate answering yes.');
    assert.equal(rows[CHURNED].monthly_spend, 0,
        'It settled once and has aged out of its billing window. That is a MEASUREMENT, so 0.');
    assert.equal(rows[BARE].monthly_spend, null,
        'This store has never settled a subscription payout, so there is nothing to evaluate. '
        + 'A 0 here would be a measured claim that they are not paying.');
    assert.equal(rows[GHOST].monthly_spend, null,
        'Payouts exist but none is an APP_SUBSCRIPTION, so no subscription has ever settled.');
});

test('total_spend is null — never 0 — for a store with no payout rows', async () => {
    _reset();
    const rows = _byDomain(await _read());

    assert.equal(rows[BARE].total_spend, null, '0 is a renderable claim that this store paid nothing.');
    assert.equal(rows[BARE].transaction_count, 0, 'The COUNT is a measured 0 once a sync has run.');
    assert.equal(rows[GHOST].total_spend, 12);
});

test('a store billed in two currencies publishes NO currency beside its total', async () => {
    _reset();
    const data = await _read();
    const rows = _byDomain(data);

    assert.equal(rows[CHURNED].spend_currency, '',
        'There is no FX table in this build, so the total is a sum of unlike units.');
    assert.equal(rows[CONVERTED].spend_currency, 'USD');
    assert.equal(data.diagnostics.stores_with_mixed_spend_currency, 1);
    assert.ok(
        data.warnings.some((w) => w.includes('more than one') && w.includes('currency')),
        'The mixed-currency total must be explained, not silently uncaptioned.'
    );
});


/* ==========================================================================
 *  2. Install state — the question this page exists to answer
 * ========================================================================== */

test('install state is the LATEST relationship event, and DEACTIVATED ends an installation', async () => {
    _reset();
    const rows = _byDomain(await _read());

    assert.equal(rows[BARE].install_state, 'INSTALLED');
    assert.equal(rows[CHURNED].install_state, 'UNINSTALLED');

    assert.equal(rows[DEACTIVATED].install_state, 'UNINSTALLED',
        'A frozen shop does not have the app live on it.');
    assert.equal(rows[DEACTIVATED].install_state_label, 'Deactivated',
        'The merchant did NOT uninstall, and saying they did is a false claim about a named business.');
    assert.equal(rows[DEACTIVATED].install_state_event, 'DEACTIVATED',
        'The three-value collapse must lose nothing.');
});

test('a store with no relationship event is UNKNOWN with store_active null — never false', async () => {
    _reset();
    const data = await _read();
    const rows = _byDomain(data);

    assert.equal(rows[GHOST].install_state, 'UNKNOWN');
    assert.equal(rows[GHOST].has_install_record, false);
    assert.equal(rows[GHOST].installed_at, null);
    assert.equal(rows[GHOST].store_active, null,
        'StoreTable._renderStatus tests `store_active === false` and draws an "Uninstalled" badge. '
        + 'A defaulted false accuses a store we know nothing about.');
    assert.equal(rows[BARE].store_active, true);
    assert.equal(rows[CHURNED].store_active, false);

    assert.equal(data.diagnostics.stores_without_install_record, 1);
    assert.ok(data.warnings.some((w) => w.includes('no install or uninstall event')));
});

test('a domain known only to listing analytics produces NO row, and is counted', async () => {
    _reset();
    const data = await _read();

    assert.equal(data.items.some((row) => row.shop_domain === 'stranger.myshopify.com'), false,
        'The Partner record is the roster. A GA4 row naming an unknown shop is a sync gap, not a store.');
    assert.equal(data.diagnostics.attribution_rows_without_partner_record, 1);
    assert.ok(data.warnings.some((w) => w.includes('listing-analytics install record')));
});


/* ==========================================================================
 *  3. Subscription state, and the trial that must not be assumed
 * ========================================================================== */

test('the five lifecycle states are folded from the same evidence as the install cohort', async () => {
    _reset();
    const rows = _byDomain(await _read());

    assert.equal(rows[BARE].state, 'INSTALLED', 'The left-join miss: this store never subscribed.');
    assert.equal(rows[BARE].state_basis, 'join_miss');
    assert.equal(rows[CONVERTED].state, 'CONVERTED');
    assert.equal(rows[CONVERTED].state_basis, 'billing_on');
    assert.equal(rows[CHURNED].state, 'CHURNED',
        'Its ONLY end signal is an UNINSTALL, which carries no charge block — so the service must '
        + 're-join the relationship end events into the charge cohort.');
    assert.equal(rows[TRIAL].state, 'ON_TRIAL');
    assert.equal(rows[TRIAL].state_basis, 'inferred');
});

test('trial_end is NEVER an assumed seven days', async () => {
    _reset();
    const data = await _read();
    const rows = _byDomain(data);

    assert.equal(rows[TRIAL].trial_end, null,
        'Shopify supplied no billingOn. An assumed date sits in a rendered column beside real ones, '
        + 'in the same format, with nothing marking it — and a reader plans around it.');
    assert.equal(rows[TRIAL].trial_days_source, 'none');
    assert.ok(rows[CONVERTED].trial_end instanceof Date,
        'Where Shopify DID supply billingOn, that date is published.');
    assert.equal(rows[CONVERTED].trial_days_source, 'partner_billing_on');

    assert.equal(data.diagnostics.inferred_state_rows, 1);
    assert.ok(data.warnings.some((w) => w.includes('weakest')),
        'The one guess in the state machine must be warned about, never silent.');
});

test('plan_price is published under that name, and is null rather than 0 when absent', async () => {
    _reset();
    const rows = _byDomain(await _read());

    assert.equal(rows[CONVERTED].plan_price, 29,
        'StoreTable._renderPlan reads `plan_price`; the system this was ported from emitted `price`, '
        + 'so that sub-line never rendered at all.');
    assert.equal(rows[CONVERTED].plan_name, 'Pro');
    assert.equal(rows[CONVERTED].plan_interval, 'EVERY_30_DAYS', 'From a SETTLED payout, never inferred.');
    assert.equal(rows[BARE].plan_price, null, 'A 0 price is a real, renderable claim that this plan is free.');
    assert.equal(rows[TRIAL].plan_interval, null, 'No payout has named a cadence for this charge yet.');
});


/* ==========================================================================
 *  4. Acquisition — an absence of evidence is never DIRECT
 * ========================================================================== */

test('has_attribution is explicit, and a miss is UNKNOWN rather than DIRECT', async () => {
    _reset();
    const data = await _read();
    const rows = _byDomain(data);

    assert.equal(rows[CONVERTED].has_attribution, true);
    assert.equal(rows[BARE].has_attribution, false);
    assert.equal(rows[BARE].channel, 'UNKNOWN',
        'DIRECT is already the largest bucket, so a store we cannot explain would vanish into it.');
    assert.equal(rows[BARE].channel_label, 'Not attributed');
    assert.equal(rows[BARE].attribution_source, '',
        '`` is "no record at all"; `none` is "a record exists and named no scope". Two facts.');
    assert.equal(data.attribution_state, 'READY');
});

test('the attribution record NEAREST the install instant wins, not the latest overall', async () => {
    _reset();
    const rows = _byDomain(await _read());

    assert.equal(rows[CONVERTED].install_country, 'United States',
        'The later visit (4 days ago) must NOT displace the record matching the install 120 days ago.');
    assert.equal(rows[CONVERTED].country, '',
        'The merchant registered country is NOT the install-traffic country, and the Partner API has '
        + 'neither. Publishing the GA4 name in a slot rendered as an ISO-2 code would claim to be one.');
    assert.equal(typeof rows[CONVERTED].attribution_lag_seconds, 'number');
});

test('a SEARCH surface_detail is blanked on the published row, and the channel survives it', async () => {
    _reset();
    const rows = _byDomain(await _read());

    assert.equal(rows[CONVERTED].surface_type, 'search',
        'The SURFACE is still published. Where in the App Store the merchant was standing is not the '
        + 'withdrawn fact — what they typed is — and blanking both would take the acquisition '
        + 'evidence with the query.');
    assert.equal(rows[CONVERTED].surface_detail, '',
        'The stored row carries "fixture query text" and the response must not. On a search surface '
        + 'this field is the merchant`s own typed query, and the guard is on READ precisely because '
        + 'blanking at capture only covers rows synced from now on: an operator upgrading to this '
        + 'build keeps every historical query in Mongo until a LIFETIME re-sync runs, and would go on '
        + 'serving them for as long as that takes.');

    assert.equal(rows[CONVERTED].channel, 'APP_STORE_SEARCH',
        'Withdrawing the query must not cost the classification. `classifyAcquisitionChannel` is '
        + 'called on the REPOSITORY row, upstream of this guard, so the install is still filed under '
        + 'search — and a guard that moved up into that call would turn every search install into an '
        + 'unattributed one.');
    assert.equal(rows[CONVERTED].channel_label, 'App Store search');
});

test('a BROWSE surface_detail is PUBLISHED — it is a placement handle, not a typed query', async () => {
    _reset();
    const rows = _byDomain(await _read());

    assert.equal(rows[DEACTIVATED].surface_type, 'home');
    assert.equal(rows[DEACTIVATED].surface_detail, 'homepage-ads',
        'One field, two meanings, and only the search one is withdrawn. This is Shopify`s own '
        + 'placement handle — it is what the "Came from" column is made of, and dropping it renders '
        + 'the whole browse population as an unexplained "App Store".');
    assert.equal(rows[DEACTIVATED].channel, 'APP_STORE_AD',
        'The handle is what makes this a paid click: `isPaidPlacement` reads surface_detail === '
        + '"homepage-ads" on surface_type "home", the combination `surface.constants.ts` records as '
        + '49 installs against 3 spelled `homepage_ad`. Blanked, that whole recorded population '
        + 'reads as organic browsing.');
    assert.equal(rows[DEACTIVATED].channel_label, 'Shopify App Store ad',
        'The label is what a reader actually sees, and "App Store browsing" over an ad click is the '
        + 'claim this pin exists to stop.');
});


/* ==========================================================================
 *  5. Facets: PRE-FILTER counts, every zero present, and fail-open validation
 * ========================================================================== */

test('install_state_counts carries ALL plus every state, zeros included', async () => {
    _reset();
    const data = await _read();

    assert.equal(data.install_state_counts.ALL, 6);
    assert.equal(data.install_state_counts.INSTALLED, 3);
    assert.equal(data.install_state_counts.UNINSTALLED, 2);
    assert.equal(data.install_state_counts.UNKNOWN, 1);

    // The tab row hard-codes ['ALL','INSTALLED','UNINSTALLED','UNKNOWN'] and iterates THOSE, reading
    // `countsFiltered[id]`. A key missing because its count is zero withdraws that tab's number.
    STATE.relationship = { rows: [], shopless_relationship_events: 0 };
    STATE.chargeEvents = [];
    STATE.settled = [];
    STATE.spend = [];
    const empty = await _read();
    for (const key of ['ALL', 'INSTALLED', 'UNINSTALLED', 'UNKNOWN']) {
        assert.equal(empty.install_state_counts[key], 0, `${key} must be present at 0, not omitted.`);
    }
});

test('facet counts are PRE-FILTER for their own group, and the tab counts are not', async () => {
    _reset();
    const unfiltered = await _read();
    const filtered = await _read({ install_states: 'INSTALLED' });

    assert.deepEqual(
        _group(filtered, 'install_states').options.map((o) => [o.value, o.count]),
        _group(unfiltered, 'install_states').options.map((o) => [o.value, o.count]),
        'A group is tallied over the rows that pass every OTHER group. Applying its own selection '
        + 'would make every unselected option read (0) the moment one is chosen.'
    );

    assert.equal(filtered.install_state_counts.ALL, 6,
        'install_state_counts is the UNFILTERED tally — it labels the tabs.');
    assert.equal(filtered.install_state_counts_filtered.ALL, 6,
        'The tab row IS the install_states group, so that group is the one excluded from its own '
        + 'counts. Applying it would make every tab except the selected one read (0) the moment a '
        + 'tab is clicked, which reads as "there is nothing else".');
    assert.equal(filtered.items.length, 3);
});

test('install_state_counts_filtered narrows when a DIFFERENT group is selected', async () => {
    _reset();
    const data = await _read({ states: 'CONVERTED' });

    assert.equal(data.install_state_counts.ALL, 6,
        'The unfiltered tally labels the tabs and must not move.');
    assert.equal(data.install_state_counts_filtered.ALL, 1,
        'With a Status filter applied, a tab number has to predict what clicking that tab shows.');
    assert.equal(data.install_state_counts_filtered.INSTALLED, 1);
    assert.equal(data.install_state_counts_filtered.UNINSTALLED, 0,
        'Zeros stay PRESENT: a key missing because its count is zero withdraws that tab`s number.');
    assert.equal(data.items.length, 1);
});

test('every facet group publishes its empty buckets rather than omitting them', async () => {
    _reset();
    const data = await _read();

    const states = _group(data, 'states');
    for (const key of ['INSTALLED', 'ON_TRIAL', 'CONVERTED', 'CHURNED_IN_TRIAL', 'CHURNED']) {
        assert.notEqual(_optionCount(states, key), undefined,
            `The lifecycle state ${key} must be offered even at zero — a group that omits its empty `
            + 'buckets makes a SAMPLE look like a distribution.');
    }
    assert.equal(_optionCount(states, 'CHURNED_IN_TRIAL'), 0);

    const plans = _group(data, 'shopify_plans');
    assert.equal(_optionCount(plans, 'NOT_PUSHED'), 6,
        'Three stores on Shopify Plus with 9,997 omitted renders as "100% Plus" unless the '
        + '"Not pushed" bucket holds the denominator.');
});

test('an unrecognised facet value WIDENS the result and warns — it never empties the table', async () => {
    _reset();
    const clean = await _read();
    const typo = await _read({ install_states: 'INSTALED' });

    assert.equal(typo.items.length, clean.items.length,
        'A table that renders zero rows because of a typo is indistinguishable from a business with '
        + 'no stores, and the reader cannot tell which they are looking at.');
    assert.ok(typo.diagnostics.unrecognised_filters.includes('install_states=INSTALED'),
        'The dropped value is echoed so a typo is visible rather than merely ineffective.');
    assert.ok(typo.warnings.some((w) => w.includes('INSTALED')));
    assert.deepEqual(typo.filters.install_states, [],
        'Dropping every value in a group leaves it UNCONSTRAINED, not "matches nothing".');
});

test('an unrecognised sort key falls back to the default and warns', async () => {
    _reset();
    const data = await _read({ sort: 'lifetime_value' });

    assert.equal(data.sort.key, 'installed_at');
    assert.equal(data.sort.dir, 'desc');
    assert.ok(data.diagnostics.unrecognised_filters.includes('sort=lifetime_value'));
    assert.ok(data.warnings.some((w) => w.includes('lifetime_value')));
});

test('`countries` is accepted, ignored, and explained', async () => {
    _reset();
    const data = await _read({ countries: 'SL' });

    assert.equal(data.items.length, 6, 'Every store is listed; the filter cannot be honoured.');
    assert.ok(data.diagnostics.unrecognised_filters.includes('countries=SL'));
    assert.ok(
        data.warnings.some((w) => w.includes('country filter') && w.includes('two-letter code')),
        'The Countries page links here with an ISO-2 code and the only per-store country this build '
        + 'holds is a GA4 common NAME. Silently matching nothing would look like a merchant with no '
        + 'stores in that country.'
    );
});

test('`refresh` is accepted and changes nothing — there is no cache to invalidate', async () => {
    _reset();
    const plain = await _read();
    const refreshed = await _read({ refresh: true });

    assert.deepEqual(refreshed.install_state_counts, plain.install_state_counts);
    assert.equal(refreshed.items.length, plain.items.length);
});


/* ==========================================================================
 *  6. Sorting, and where an absence belongs
 * ========================================================================== */

test('nulls sort LAST in BOTH directions', async () => {
    _reset();
    const nulls = new Set([BARE, TRIAL, GHOST, DEACTIVATED]);

    for (const dir of ['asc', 'desc']) {
        const data = await _read({ sort: 'monthly_spend', dir });
        const domains = data.items.map((row) => row.shop_domain);
        const firstNullAt = domains.findIndex((domain) => nulls.has(domain));
        const lastValueAt = domains.reduce((acc, domain, i) => (nulls.has(domain) ? acc : i), -1);

        assert.ok(firstNullAt > lastValueAt,
            `dir=${dir}: a store that has never paid is not "the cheapest" when you ask for lowest `
            + 'spend first. Floating an ABSENCE to the top presents it as an extreme value.');
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
    const byInstall = await _read({ sort: 'installed_at', dir: 'desc' });

    assert.deepEqual(byName.install_state_counts, byInstall.install_state_counts,
        'Every count comes from the same array the list does, so they cannot drift — and sorting in '
        + 'place would reorder the very array those tallies were taken from.');
    assert.equal(byName.pagination.total, byInstall.pagination.total);
});


/* ==========================================================================
 *  7. Pagination, exactly as the component reads it
 * ========================================================================== */

test('pagination is {page, limit, total, pages} — `pages`, never `total_pages`', async () => {
    _reset();
    const data = await _read({ limit: 2, page: 2 });

    assert.deepEqual(Object.keys(data.pagination).sort(), ['limit', 'page', 'pages', 'total']);
    assert.equal(data.pagination.total, 6);
    assert.equal(data.pagination.pages, 3, 'stores/index.js:95 reads `pages`; `total_pages` blanks the footer.');
    assert.equal(data.pagination.page, 2);
    assert.equal(data.pagination.limit, 2);
    assert.equal(data.items.length, 2);
});

test('an empty result is a 200 with total 0 and pages 0', async () => {
    _reset();
    const data = await _read({ q: 'no-such-store-anywhere' });

    assert.deepEqual(data.items, []);
    assert.equal(data.pagination.total, 0);
    assert.equal(data.pagination.pages, 0,
        'Math.ceil(0/limit) with no floor. The page clamps for display; the API states the measurement.');
    assert.equal(data.pagination.page, 1);
});

test('a page beyond the end clamps rather than answering out of range', async () => {
    _reset();
    const data = await _read({ limit: 2, page: 99 });

    assert.equal(data.pagination.page, 3);
    assert.equal(data.items.length, 2);
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

    const byName = await _read({ q: 'Frozen' });
    assert.deepEqual(byName.items.map((r) => r.shop_domain), [DEACTIVATED]);

    const byPlan = await _read({ q: 'starter' });
    assert.deepEqual(byPlan.items.map((r) => r.shop_domain), [TRIAL]);

    const byDomain = await _read({ q: 'ghost-shop' });
    assert.deepEqual(byDomain.items.map((r) => r.shop_domain), [GHOST]);

    assert.equal((await _read({ q: 'GHOST-SHOP' })).items.length, 1, 'Case-insensitive.');
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

test('READY with zero stores is a DIFFERENT answer, and carries no unknown_reason', async () => {
    _reset();
    STATE.relationship = { rows: [], shopless_relationship_events: 0 };
    STATE.chargeEvents = [];
    STATE.settled = [];
    STATE.spend = [];

    const data = await _read();

    assert.equal(data.data_state, 'READY',
        'The discriminator is the WATERMARK, never the row count: "nobody has ever installed this '
        + 'app" is a real, publishable answer once a sync has run.');
    assert.equal(data.unknown_reason, undefined);
    assert.equal(data.meta.domains_seen, 0);
});

test('warnings are UNIQUE — React keys them by content, so a duplicate DROPS one', async () => {
    _reset();
    const data = await _read({ install_states: 'NOPE', states: 'ALSO_NOPE' });

    assert.equal(new Set(data.warnings).size, data.warnings.length,
        'stores/index.js renders one <p> per warning keyed by the string itself. A second copy of a '
        + 'message does not double up — it DISAPPEARS, and takes its condition with it.');
    for (const warning of data.warnings) {
        assert.equal(typeof warning, 'string');
        assert.ok(warning.length > 0);
    }
});

test('the response publishes the vocabularies the page renders from', async () => {
    _reset();
    const data = await _read();

    assert.deepEqual(Object.keys(data.install_states), ['INSTALLED', 'UNINSTALLED', 'UNKNOWN'],
        'The tab row hard-codes these three ids. A fourth appears in the counts, in no tab, and '
        + 'breaks sum(tabs) === total on screen with no explanation.');
    assert.equal(data.install_states.UNKNOWN, 'Install state unknown');
    assert.equal(data.states.INSTALLED, 'Installed only',
        'The lifecycle vocabulary`s INSTALLED means "never subscribed" — a different word from the '
        + 'install state`s.');
    assert.equal(data.app_name, 'Demo App');
    assert.equal(typeof data.as_of, 'string');
});

test('the refusals are the four named ones, and each carries an actionable sentence', async () => {
    _reset();

    const noUser = await getStoreRoster({}, BASE);
    assert.equal(noUser.status, false);
    assert.deepEqual(noUser.data, {});

    const noApp = await getStoreRoster({ user_id: 'operator-1' }, {});
    assert.equal(noApp.status, false);
    assert.ok(noApp.msg.includes('partner_app_id'));
    assert.ok(noApp.msg.includes('/api/partner-apps'), 'The message must say where to get the value.');

    STATE.app = null;
    const missing = await getStoreRoster({ user_id: 'operator-1' }, BASE);
    assert.equal(missing.status, false);
    assert.equal(missing.msg, 'Partner app not found.');

    _reset();
    STATE.appThrows = true;
    const broke = await getStoreRoster({ user_id: 'operator-1' }, BASE);
    assert.equal(broke.status, false);
    assert.deepEqual(broke.data, {}, 'A failed call carries {} — never a partial payload.');
});


/* ==========================================================================
 *  10. Fixes made after the first review — each of these once shipped wrong
 * ========================================================================== */

test('billing_stale is ON THE ROW, from the same expression the detail record projects', async () => {
    _reset();
    // The churned store WITHOUT its uninstall: a paid plan on record, a settled payout that has aged
    // out of the live window, and nothing saying it ever ended. That is exactly "our records show a
    // paid plan and Shopify has not billed it recently".
    STATE.relationship = {
        rows: RELATIONSHIP_ROWS.filter((row) => !(row.shop_domain === CHURNED && row.event_type === 'UNINSTALL')),
        shopless_relationship_events: 0
    };

    const rows = _byDomain(await _read());

    assert.equal(rows[CHURNED].state, 'CONVERTED');
    assert.equal(rows[CHURNED].monthly_spend, 0, 'Measured and not paying — not an absence.');
    assert.equal(rows[CHURNED].billing_stale, true,
        'StoreTable._renderStatus has always had the "Billing stale" markup and never had the field, '
        + 'so the row said nothing while the drawer that opens OVER it announced it.');

    assert.equal(rows[CONVERTED].billing_stale, false, 'A payout settled inside the live window.');
    assert.equal(rows[BARE].billing_stale, false,
        'No subscription at all. `false` here means "not measured as stale", never "billing confirmed".');
    assert.equal(rows[GHOST].billing_stale, false,
        'Payouts but no subscription state: it takes MEASURED payout evidence AND a paid plan.');
});

test('billing_stale takes payout evidence — an unfetched ledger is not a stale one', async () => {
    _reset();
    STATE.relationship = {
        rows: RELATIONSHIP_ROWS.filter((row) => !(row.shop_domain === CHURNED && row.event_type === 'UNINSTALL')),
        shopless_relationship_events: 0
    };
    // Same store, same subscription — but no settled payout has ever been fetched for it. "We have
    // never fetched a payout" and "the payments stopped" are different facts, and only one of them
    // is about the merchant.
    STATE.settled = SETTLED.filter((row) => row.shop_domain !== CHURNED);

    const rows = _byDomain(await _read());
    assert.equal(rows[CHURNED].monthly_spend, null, 'Nothing to evaluate — null, never 0.');
    assert.equal(rows[CHURNED].billing_stale, false,
        'A warning banner about this merchant`s billing, raised because OUR sync has not run, would '
        + 'be a claim about them made out of a fact about us.');
});

test('a closed facet vocabulary WIDENS on a bad value rather than emptying the table', async () => {
    _reset();
    const clean = await _read();

    // `billing` and `store_records` were treated as OPEN, so these were accepted, matched no row,
    // and returned an empty table with NO warning — the one outcome indistinguishable from a
    // business with no stores.
    for (const [group, value] of [['billing', 'MONTHLY'], ['store_records', 'has_operator_profile']]) {
        const bad = await _read({ [group]: value });
        assert.equal(bad.items.length, clean.items.length, `${group}=${value} must widen, not empty.`);
        assert.ok(bad.diagnostics.unrecognised_filters.includes(`${group}=${value}`));
        assert.ok(bad.warnings.some((w) => w.includes(value)));
        assert.deepEqual(bad.filters[group], []);
    }

    // ...and the real values still narrow.
    const monthly = await _read({ billing: 'EVERY_30_DAYS' });
    assert.deepEqual(monthly.filters.billing, ['EVERY_30_DAYS']);
    assert.ok(monthly.items.length > 0 && monthly.items.length < clean.items.length);
    assert.ok(monthly.items.every((row) => row.plan_interval === 'EVERY_30_DAYS'));
});

test('a value the ROSTER produced is honoured even when the vocabulary has not learned it', async () => {
    _reset();
    //  The escape hatch. A cadence Shopify sends that this build has never seen is OFFERED as a
    // facet option (the options are tallied from the rows), so rejecting it on selection would be a
    // checkbox that ticks and empties the table — worse than the bug the closed check fixes.
    STATE.settled = SETTLED.map((row) => (
        row.shop_domain === CONVERTED ? { ...row, billing_interval: 'EVERY_90_DAYS' } : row
    ));

    const offered = _group(await _read(), 'billing');
    assert.ok((offered.options || []).some((o) => o.value === 'EVERY_90_DAYS'),
        'The group offers it, so the group must be able to filter on it.');

    const data = await _read({ billing: 'EVERY_90_DAYS' });
    assert.deepEqual(data.filters.billing, ['EVERY_90_DAYS']);
    assert.deepEqual(data.diagnostics.unrecognised_filters, []);
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].shop_domain, CONVERTED);
});

test('a null shop-name watermark beside real events is the WIDEST boundary, and it warns', async () => {
    _reset();
    // `shop_name_coverage_since: null` with a non-null `earliest_event_at` means no synced event
    // carries a name at all — the state `partnerApp.model.ts` documents as needing this sentence
    // most. The old `instanceof Date` test skipped it, so every store rendered a bare domain with
    // nothing on the page to say why.
    const data = await _read();
    assert.equal(data.meta.shop_name_coverage_since, null);
    assert.ok(
        data.warnings.some((w) => w.includes('No synced Partner event carries a store name')),
        'Silence here is the same silence partnerCoverage.repository`s `$exists: true` comment was '
        + 'written to prevent, one layer up.'
    );

    // A boundary INSIDE the history reports itself with its date instead — the two must not both fire.
    STATE.app = { ...APP, shop_name_coverage_since: _daysAgo(100) };
    const bounded = await _read();
    assert.ok(bounded.warnings.some((w) => w.includes('Store names are filled from the Partner API only')));
    assert.ok(!bounded.warnings.some((w) => w.includes('No synced Partner event carries a store name')));

    // Equal to the earliest event ⇒ there is no boundary left to report and the sentence is noise.
    STATE.app = { ...APP, shop_name_coverage_since: APP.earliest_event_at };
    const closed = await _read();
    assert.ok(!closed.warnings.some((w) => w.includes('Store names are filled')));
    assert.ok(!closed.warnings.some((w) => w.includes('No synced Partner event carries a store name')));
});
