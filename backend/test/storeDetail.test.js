'use strict';

/**
 * ============================================================================
 *  ONE STORE'S RECORD — the drawer's contract, and the one place it refuses
 * ============================================================================
 *
 *  Exercises `getStoreDetail` end to end with both repositories stubbed out, so the whole assembly —
 *  event partition → install fold → money fold → charge cohort → row → record → timeline → warnings —
 *  runs against fixtures with no database and no BigQuery.
 *
 *  ── 1. IT MUST ANSWER FOR A STORE WITH NO SUBSCRIPTION ─────────────────────
 *
 *  The drawer opens from SEVEN tables and its commonest subject is a store that installed and never
 *  subscribed — which is the majority of any install base. That is a FIRST-CLASS answer here, not a
 *  degenerate one, and it is the single most important test in this file.
 *
 *  ── 2.  `acquisition: null` SELECTS THE "Not attributed" BRANCH ──────────
 *
 *  `StoreDetailContent.js:205-222` branches on the null. `{}` or a synthesised `channel: 'DIRECT'`
 *  takes the ATTRIBUTED branch and presents a store we know nothing about as a confident direct
 *  arrival, inside what is already the largest bucket.
 *
 *  ── 3.  `store_active` MUST BE PRESENT ───────────────────────────────────
 *
 *  `StoreStatusBadges` renders an "Uninstalled" badge on `!sub.store_active`, so an absent field
 *  accuses every store. It is `null` — never `false` — when the install state is UNKNOWN, and that
 *  null is a value we measured rather than one we invented; the drawer's own test is the thing that
 *  needs fixing, not the payload.
 *
 *  ── 4. THE ONE REFUSAL, DISCRIMINATED BY THE WATERMARK ─────────────────────
 *
 *  A LIST has an honest empty rendering, so an empty roster is a 200. A RECORD does not: the drawer
 *  draws either the full panel or one critical banner. So "no record of this store" is a refusal
 *  carrying the reason — and the reason is "we have not looked" or "we looked and there is nothing",
 *  chosen by `last_synced_at` and never by the row count.
 *
 *  ── 5. EVERY OTHER EMPTY IS STILL A 200 ────────────────────────────────────
 *
 *  No subscription, no payouts, no attribution, a store known only from a payout: all complete
 *  records with stated reasons. Refusing on any of those renders "Not available" over a store the
 *  Partner API describes perfectly well.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';
// The acquisition card is only reachable with the listing tier configured. `test/storeUnconfigured
// .test.js` is the same endpoint WITHOUT these, because `src/config` snapshots `process.env` at
// first require and one process cannot test both tiers.
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

const rosterRepository = require(path.join(MODULE_ROOT, 'repositories', 'storeRoster.repository.ts'));
const detailRepository = require(path.join(MODULE_ROOT, 'repositories', 'storeDetail.repository.ts'));

/** ⚠️ Relative to NOW — the service reads the clock and the MRR window rolls. See storeRoster.test.js. */
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

const CONVERTED = 'converted-shop.myshopify.com';
const BARE = 'bare-shop.myshopify.com';
const STALE = 'stale-shop.myshopify.com';
const VOIDED = 'voided-shop.myshopify.com';
const SKEW = 'skew-shop.myshopify.com';
const GHOST = 'ghost-shop.myshopify.com';
const REDACTED = 'redacted-shop.myshopify.com';
const INFERRED_PAID = 'inferred-paid.myshopify.com';
const BROWSE = 'browse-shop.myshopify.com';
const NOBODY = 'nobody.myshopify.com';

const _charge = (id, name, amount, billingOn) => ({
    charge: {
        id: `gid://shopify/AppSubscription/${id}`,
        name,
        test: false,
        amount: { amount: String(amount), currencyCode: 'USD' },
        ...(billingOn ? { billingOn: billingOn.toISOString() } : {})
    }
});

/**
 *  ONE UNFILTERED READ. Unlike the roster — which splits its event pull in two and re-joins the
 * relationship end events — this endpoint fetches EVERY type for one store, including the ones no
 * metric consumes (`ONE_TIME_CHARGE_ACCEPTED`, `USAGE_CHARGE_APPLIED`, `OTHER`). The timeline is an
 * audit surface, and filtering an unrecognised event out of the one screen built to display
 * everything turns a known unknown back into an unknown one.
 */
const EVENTS = {
    [CONVERTED]: [
        { partner_event_id: 'ev-1', shop_domain: CONVERTED, event_type: 'INSTALL', occurred_at: _daysAgo(120), charge_id: '', shop_id: 'gid://partners/Shop/3', shop_name: 'Converted Store', raw_event: {} },
        { partner_event_id: 'ev-2', shop_domain: CONVERTED, event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED', occurred_at: _daysAgo(100), charge_id: '111', shop_id: 'gid://partners/Shop/3', shop_name: 'Converted Store', raw_event: _charge('111', 'Pro', '29.00', _daysAgo(93)) },
        { partner_event_id: 'ev-3', shop_domain: CONVERTED, event_type: 'SUBSCRIPTION_CHARGE_ACTIVATED', occurred_at: _daysAgo(93), charge_id: '111', shop_id: 'gid://partners/Shop/3', shop_name: 'Converted Store', raw_event: _charge('111', 'Pro', '29.00', _daysAgo(93)) },
        // Neither a relationship event nor a subscription event: it decides nothing and must still
        // appear on the timeline.
        { partner_event_id: 'ev-4', shop_domain: CONVERTED, event_type: 'USAGE_CHARGE_APPLIED', occurred_at: _daysAgo(40), charge_id: '', shop_id: 'gid://partners/Shop/3', shop_name: 'Converted Store', raw_event: {} }
    ],
    [BARE]: [
        { partner_event_id: 'ev-5', shop_domain: BARE, event_type: 'INSTALL', occurred_at: _daysAgo(30), charge_id: '', shop_id: 'gid://partners/Shop/1', shop_name: 'Bare Store', raw_event: {} }
    ],
    [STALE]: [
        { partner_event_id: 'ev-6', shop_domain: STALE, event_type: 'INSTALL', occurred_at: _daysAgo(300), charge_id: '', shop_id: 'gid://partners/Shop/7', shop_name: 'Stale Store', raw_event: {} },
        { partner_event_id: 'ev-7', shop_domain: STALE, event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED', occurred_at: _daysAgo(280), charge_id: '777', shop_id: 'gid://partners/Shop/7', shop_name: 'Stale Store', raw_event: _charge('777', 'Pro', '29.00', _daysAgo(273)) }
    ],
    [VOIDED]: [
        { partner_event_id: 'ev-8', shop_domain: VOIDED, event_type: 'INSTALL', occurred_at: _daysAgo(40), charge_id: '', shop_id: 'gid://partners/Shop/8', shop_name: 'Voided Store', raw_event: {} },
        { partner_event_id: 'ev-9', shop_domain: VOIDED, event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED', occurred_at: _daysAgo(30), charge_id: '888', shop_id: 'gid://partners/Shop/8', shop_name: 'Voided Store', raw_event: _charge('888', 'Pro', '29.00', _daysAgo(23)) },
        // The end lands BEFORE the day billing would have started: this merchant never paid us.
        { partner_event_id: 'ev-10', shop_domain: VOIDED, event_type: 'UNINSTALL', occurred_at: _daysAgo(25), charge_id: '', shop_id: 'gid://partners/Shop/8', shop_name: '', raw_event: {} }
    ],
    [SKEW]: [
        { partner_event_id: 'ev-11', shop_domain: SKEW, event_type: 'INSTALL', occurred_at: _daysAgo(40), charge_id: '', shop_id: 'gid://partners/Shop/9', shop_name: 'Skewed Store', raw_event: {} },
        //  DATED IN THE FUTURE. It must be SHOWN on the timeline and decide NOTHING.
        { partner_event_id: 'ev-12', shop_domain: SKEW, event_type: 'UNINSTALL', occurred_at: _daysAhead(10), charge_id: '', shop_id: 'gid://partners/Shop/9', shop_name: '', raw_event: {} }
    ],
    [REDACTED]: [
        { partner_event_id: 'ev-r1', shop_domain: REDACTED, event_type: 'INSTALL', occurred_at: _daysAgo(60), charge_id: '', shop_id: 'gid://partners/Shop/10', shop_name: 'Redacted Store', raw_event: {} },
        { partner_event_id: 'ev-r2', shop_domain: REDACTED, event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED', occurred_at: _daysAgo(60), charge_id: '999', shop_id: 'gid://partners/Shop/10', shop_name: 'Redacted Store', raw_event: _charge('999', 'Pro', '29.00', _daysAgo(53)) }
    ],
    [INFERRED_PAID]: [
        { partner_event_id: 'ev-i1', shop_domain: INFERRED_PAID, event_type: 'INSTALL', occurred_at: _daysAgo(50), charge_id: '', shop_id: 'gid://partners/Shop/11', shop_name: 'Inferred Store', raw_event: {} },
        // ⚠️ NO `billingOn`. Its state therefore rests entirely on whether money PROVABLY moved
        // against charge 555 — the one branch a lost payout can silently flip.
        { partner_event_id: 'ev-i2', shop_domain: INFERRED_PAID, event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED', occurred_at: _daysAgo(45), charge_id: '555', shop_id: 'gid://partners/Shop/11', shop_name: 'Inferred Store', raw_event: _charge('555', 'Pro', '29.00', null) }
    ],
    //  Nothing unusual about this store except WHERE it came from: it exists so the browse
    // half of `surface_detail` has a subject. One install, no charge, so it adds nothing to
    // `CHARGE_EVENTS` and changes no other fixture`s arithmetic.
    [BROWSE]: [
        { partner_event_id: 'ev-b1', shop_domain: BROWSE, event_type: 'INSTALL', occurred_at: _daysAgo(70), charge_id: '', shop_id: 'gid://partners/Shop/12', shop_name: 'Browse Store', raw_event: {} }
    ],
    // Known to the money ledger and to nothing else.
    [GHOST]: []
};

/**
 *  WHAT THE CHARGE-KEYED READ SEES AND THE DOMAIN-KEYED ONE CANNOT.
 *
 * `ev-r3` is a cancellation for charge 999 carrying NO `shop_domain` — Shopify redacted the shop
 * between the install and the cancellation. A per-store read keyed on the domain misses it entirely,
 * so that subscription never receives an end event, never churns, and the drawer would show CONVERTED
 * over a table row that says CHURNED. `ev-x1` names a DIFFERENT store on the same charge id, which
 * the database does not forbid and the service must refuse to admit.
 *
 * Everything else here is the OVERLAP: most of a store's charge events carry both its domain and its
 * charge id, so both reads return them and the merge has to de-duplicate.
 */
const CHARGE_EVENTS = [
    ...Object.values(EVENTS).flat().filter((row) => row.charge_id !== ''),
    { partner_event_id: 'ev-r3', shop_domain: '', event_type: 'SUBSCRIPTION_CHARGE_CANCELLED', occurred_at: _daysAgo(10), charge_id: '999', shop_id: 'gid://partners/Shop/10', shop_name: '', raw_event: {} },
    { partner_event_id: 'ev-x1', shop_domain: 'other-shop.myshopify.com', event_type: 'SUBSCRIPTION_CHARGE_CANCELLED', occurred_at: _daysAgo(9), charge_id: '999', shop_id: 'gid://partners/Shop/99', shop_name: '', raw_event: {} }
];

const TRANSACTIONS = {
    [CONVERTED]: [
        { type: 'APP_SUBSCRIPTION', shop_domain: CONVERTED, charge_id: '111', billing_interval: 'EVERY_30_DAYS', gross_amount: { amount: 29, currency: 'USD' }, net_amount: { amount: 24.65, currency: 'USD' }, created_at: _daysAgo(35) },
        { type: 'APP_SUBSCRIPTION', shop_domain: CONVERTED, charge_id: '111', billing_interval: 'EVERY_30_DAYS', gross_amount: { amount: 29, currency: 'USD' }, net_amount: { amount: 24.65, currency: 'USD' }, created_at: _daysAgo(5) },
        // ⚠️ NEGATIVE MONEY. It is included in the lifetime total — "total spend" net of refunds is
        // what the merchant actually paid — and its timeline tone comes from the SIGN, not the type.
        { type: 'APP_CREDIT', shop_domain: CONVERTED, charge_id: '', billing_interval: null, gross_amount: { amount: -29, currency: 'USD' }, net_amount: { amount: -24.65, currency: 'USD' }, created_at: _daysAgo(2) }
    ],
    [STALE]: [
        { type: 'APP_SUBSCRIPTION', shop_domain: STALE, charge_id: '777', billing_interval: 'EVERY_30_DAYS', gross_amount: { amount: 29, currency: 'USD' }, net_amount: { amount: 24.65, currency: 'USD' }, created_at: _daysAgo(200) }
    ],
    [GHOST]: [
        { type: 'APP_ONE_TIME', shop_domain: GHOST, charge_id: '', billing_interval: null, gross_amount: { amount: 12, currency: 'USD' }, net_amount: { amount: 10, currency: 'USD' }, created_at: _daysAgo(300) }
    ]
};

/**
 *  THE PAYOUT A DOMAIN-KEYED READ CANNOT SEE.
 *
 * Shopify redacted this shop, so its settled payout carries no `shop_domain` — while the roster's
 * own aggregation groups by CHARGE with no domain filter and therefore still marks 555 as settled.
 * Without the charge-keyed payout read this store reads CONVERTED on the list and ON_TRIAL in the
 * panel over it. `ev-x2` names a different store on the same charge and must be refused.
 */
const CHARGE_TRANSACTIONS = [
    ...Object.values(TRANSACTIONS).flat().filter((row) => row.charge_id !== ''),
    { type: 'APP_SUBSCRIPTION', shop_domain: '', charge_id: '555', billing_interval: 'EVERY_30_DAYS', gross_amount: { amount: 29, currency: 'USD' }, net_amount: { amount: 24.65, currency: 'USD' }, created_at: _daysAgo(3) },
    { type: 'APP_SUBSCRIPTION', shop_domain: 'other-shop.myshopify.com', charge_id: '555', billing_interval: 'ANNUAL', gross_amount: { amount: 999, currency: 'USD' }, net_amount: { amount: 900, currency: 'USD' }, created_at: _daysAgo(2) }
];

/**
 *  ONE FIELD, TWO MEANINGS — AND BOTH OF THEM FIXTURED.
 *
 * `surface_detail` is dual purpose, and the published row treats its two halves in OPPOSITE
 * directions. Fixturing only one of them leaves the read guard in `storeRow.resolver` unexercised in
 * either direction, which is how it could be deleted outright with this suite still green.
 *
 *   SEARCH (`search` / `search_ad` / `guided_search`) — the merchant`s OWN TYPED App Store query.
 *     This build does not capture it, does not serve it and does not render it. CONVERTED therefore
 *     carries a NON-EMPTY value here on purpose: the `''` the endpoint publishes has to be the
 *     guard`s doing rather than the fixture`s, or the assertion below proves nothing at all.
 *     ⚠️ Synthetic text, never a real query — the point of the change these two pin is that a typed
 *     query is not ours to store, serve, or check into a repository.
 *
 *   BROWSE (`home`, `category`, `collection`, `app_group`, …) — Shopify`s own PLACEMENT HANDLE, and
 *     load-bearing. BROWSE below is the `home` + `homepage-ads` pair that `isPaidPlacement` reads to
 *     call an install an ad click rather than organic browsing; `surface.constants.ts` records 49
 *     installs of that shape against 3 labelled `homepage_ad`. This half must survive the guard and
 *     reach the drawer intact, and the channel it produces is asserted with it.
 */
const ATTRIBUTION = {
    [CONVERTED]: [
        {
            shop_domain: CONVERTED,
            shop_name: 'Converted Store',
            installed_at: _daysAgo(120),
            source: 'shopify_app_store',
            medium: 'referral',
            campaign: 'spring',
            attribution_source: 'event_collected',
            surface_type: 'search',
            //  NON-EMPTY ON PURPOSE. See the block above: this stands in for the stored query an
            // operator upgrading this build still has sitting in Mongo, and the read guard is what
            // must stop it reaching the response.
            surface_detail: 'fixture query text',
            surface_inter_position: 1,
            surface_intra_position: 3,
            country: 'United States'
        }
    ],
    [BROWSE]: [
        {
            shop_domain: BROWSE,
            shop_name: 'Browse Store',
            installed_at: _daysAgo(70),
            source: 'shopify_app_store',
            medium: 'referral',
            campaign: '',
            attribution_source: 'event_collected',
            surface_type: 'home',
            //  A PLACEMENT HANDLE, not free text — and the one handle that decides paid vs organic.
            surface_detail: 'homepage-ads',
            surface_inter_position: 2,
            surface_intra_position: 1,
            country: 'United States'
        }
    ]
};

/**
 * ⚠️ The stubs are installed BEFORE the service is required. Every service here destructures its
 * repository at MODULE LOAD, so re-assigning an export afterwards has no effect at all.
 */
const STATE = {
    app: APP,
    events: EVENTS,
    chargeEvents: CHARGE_EVENTS,
    transactions: TRANSACTIONS,
    chargeTransactions: CHARGE_TRANSACTIONS,
    attribution: ATTRIBUTION,
    /** The last query each read was handed, so the normalised needle can be asserted. */
    lastEventQuery: null,
    /** The charge ids the second read was asked for, so the skip can be asserted. */
    lastChargeQuery: null
};

const _reset = () => {
    STATE.app = APP;
    STATE.events = EVENTS;
    STATE.chargeEvents = CHARGE_EVENTS;
    STATE.transactions = TRANSACTIONS;
    STATE.chargeTransactions = CHARGE_TRANSACTIONS;
    STATE.attribution = ATTRIBUTION;
    STATE.lastEventQuery = null;
    STATE.lastChargeQuery = null;
};

rosterRepository.findPartnerAppById = async () => STATE.app;

/**
 * ⚠️ THE STUBS KEY ON `shop_domain`, WHICH IS WHAT PROVES THE NEEDLE WAS NORMALISED. A stub that
 * ignored the query and returned one fixture would pass with the normalisation deleted — and a raw
 * `https://Converted-Shop.myshopify.com/admin` matches nothing against a canonicalised column, with
 * no error and no empty-result explanation.
 *
 * The read is declared newest-first, so the fixtures are sorted here rather than in the service —
 * which must not depend on the order anyway.
 */
detailRepository.findStoreEvents = async (query) => {
    STATE.lastEventQuery = query;
    const rows = STATE.events[query.shop_domain] || [];
    return [...rows].sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());
};
/**
 * The charge-keyed read, filtered exactly as the `$in` would filter it — including the rows the
 * domain-keyed stub also returns, because that overlap is real and the merge has to survive it.
 */
detailRepository.findEventsForCharges = async (query) => {
    STATE.lastChargeQuery = query;
    assert.ok(query.charge_ids.length > 0,
        'An empty $in matches nothing; the service must skip the read rather than issue one that '
        + 'cannot answer.');
    const rows = STATE.chargeEvents.filter((row) => query.charge_ids.includes(row.charge_id));
    return [...rows].sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());
};
detailRepository.findStoreTransactions = async (query) => {
    const rows = STATE.transactions[query.shop_domain] || [];
    return [...rows].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
};
detailRepository.findTransactionsForCharges = async (query) => {
    const rows = STATE.chargeTransactions.filter((row) => query.charge_ids.includes(row.charge_id));
    return [...rows].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
};
detailRepository.findStoreAttributionRows = async (query) => STATE.attribution[query.shop_domain] || [];

const { getStoreDetail } = require(path.join(MODULE_ROOT, 'services', 'storeDetail.service.ts'));

/**
 * Calls the service and asserts it did not refuse.
 *
 * @param {String} domain - The store to read.
 * @param {Object} [extra] - Extra query parameters.
 * @returns {Promise<Object>} The payload.
 */
const _read = async (domain, extra = {}) => {
    const result = await getStoreDetail(
        { user_id: 'operator-1' },
        { partner_app_id: 'app-1', shop_domain: domain, ...extra }
    );
    assert.equal(result.status, true, `the service refused: ${result.msg}`);
    return result.data;
};

/** Timeline entries from one source, in the order the response carries them. */
const _fromSource = (data, source) => data.timeline.filter((entry) => entry.source === source);


/* ==========================================================================
 *  1. A store with NO subscription is a first-class answer
 * ========================================================================== */

test('a store that installed and never subscribed gets a COMPLETE record, not a refusal', async () => {
    _reset();
    const data = await _read(BARE);
    const sub = data.subscription;

    assert.equal(sub.shop_domain, BARE);
    assert.equal(sub.customer_name, 'Bare Store');
    assert.equal(sub.customer_name_source, 'partner');
    assert.equal(sub.install_state, 'INSTALLED');
    assert.equal(sub.store_active, true);

    assert.equal(sub.status, 'INSTALLED',
        'The lifecycle vocabulary`s INSTALLED means "never subscribed" — a state, not a gap.');
    assert.equal(sub.status_label, 'Installed only');
    assert.equal(sub.state, sub.status, 'One variable, two spellings: the drawer reads one, the table the other.');
    assert.equal(sub.state_basis, 'join_miss');

    assert.equal(sub.plan_name, '');
    assert.equal(sub.plan_price, null, 'A 0 price is a renderable claim that this plan is free.');
    assert.equal(sub.plan_interval, null);
    assert.equal(sub.trial_end, null);
    assert.equal(sub.trial_days_source, 'none');
    assert.equal(sub.activation_date, null, 'There is no subscription to have started.');
    assert.equal(sub.conversion_date, null);
    assert.equal(sub.conversion_date_voided, false);
    assert.equal(sub.churn_date, null);

    assert.deepEqual(data.subscriptions, []);
    assert.equal(data.acquisition, null);
    assert.equal(data.summary.lifetime_value, null);
    assert.equal(data.summary.mrr, null);
    assert.equal(data.payouts.total_gross, null);
    assert.equal(data.timeline.length, 1, 'Its install is still a timeline.');
    assert.equal(data.timeline[0].label, 'App installed');
});

test('a store known only from a payout answers UNKNOWN with store_active null — never false', async () => {
    _reset();
    const data = await _read(GHOST);

    assert.equal(data.subscription.install_state, 'UNKNOWN');
    assert.equal(data.subscription.has_install_record, false);
    assert.equal(data.subscription.installed_at, null);
    assert.equal(data.subscription.store_active, null,
        'StoreStatusBadges reads `!sub.store_active`, so this null currently draws an "Uninstalled" '
        + 'badge — a frontend defect. Publishing a `true` we did not measure would fix a component '
        + 'by lying in the contract.');
    assert.ok('store_active' in data.subscription,
        'An ABSENT field renders exactly the same accusation, which is why it is always present.');

    assert.equal(data.summary.first_seen.getTime(), _daysAgo(300).getTime(),
        'first_seen falls back to the oldest payout when there is no event at all.');
    assert.ok(data.warnings.some((w) => w.includes('No install or uninstall event')));
});


/* ==========================================================================
 *  2. The bare-number contract, and the ratio with an empty denominator
 * ========================================================================== */

test('every figure on the record is a BARE NUMBER', async () => {
    _reset();
    const data = await _read(CONVERTED);

    assert.equal(typeof data.summary.lifetime_value, 'number',
        'fmtMoney(envelope) is Number({…}) -> NaN -> an em dash, on five tiles at once.');
    assert.equal(typeof data.summary.average_spend, 'number');
    assert.equal(typeof data.summary.mrr, 'number');
    assert.equal(typeof data.summary.tx_count, 'number');
    assert.equal(typeof data.payouts.total_gross, 'number');
    assert.equal(typeof data.payouts.transaction_count, 'number');
    assert.equal(typeof data.subscription.plan_price, 'number');
    for (const bucket of data.payouts.by_type) {
        assert.equal(typeof bucket.gross, 'number');
        assert.equal(typeof bucket.count, 'number');
    }
});

test('average_spend is null — never 0 — when there are no payments', async () => {
    _reset();
    const bare = await _read(BARE);
    const converted = await _read(CONVERTED);

    assert.equal(bare.summary.tx_count, 0);
    assert.equal(bare.summary.average_spend, null,
        'A ratio with an empty denominator is not zero, and $0.00 on that tile is a fabricated '
        + 'business fact sitting beside four real ones.');
    assert.equal(converted.summary.average_spend, converted.summary.lifetime_value / 3);
});

test('the lifetime total is net of refunds, and the per-type split shows why', async () => {
    _reset();
    const data = await _read(CONVERTED);

    assert.equal(data.payouts.transaction_count, 3);
    assert.equal(data.payouts.total_gross, 29, '29 + 29 - 29: a credit is negative money.');
    assert.equal(data.payouts.currency, 'USD');
    assert.deepEqual(data.payouts.currencies, ['USD']);

    const byType = Object.fromEntries(data.payouts.by_type.map((b) => [b.type, b]));
    assert.equal(byType.APP_SUBSCRIPTION.count, 2);
    assert.equal(byType.APP_SUBSCRIPTION.gross, 58);
    assert.equal(byType.APP_CREDIT.count, 1);
    assert.equal(byType.APP_CREDIT.gross, -29);
    assert.equal(byType.APP_CREDIT.label, 'Refund or credit');
});


/* ==========================================================================
 *  3. Acquisition — the null that selects the honest branch
 * ========================================================================== */

test('acquisition is exactly null on a miss, and never an empty object', async () => {
    _reset();
    const bare = await _read(BARE);

    assert.equal(bare.acquisition, null,
        'StoreDetailContent branches on the null. `{}` takes the ATTRIBUTED branch and renders a '
        + 'store we know nothing about as a confident arrival.');
    assert.equal(bare.provenance.acquisition, 'READY',
        'On a miss this carries the TIER STATE, so "the sync ran and this store genuinely has none" '
        + 'stays separable from "the tier is not connected".');
});

test('an attributed store carries its channel, its surface and the install-traffic country', async () => {
    _reset();
    const data = await _read(CONVERTED);

    assert.notEqual(data.acquisition, null);
    assert.equal(typeof data.acquisition.channel, 'string');
    assert.equal(typeof data.acquisition.channel_label, 'string');
    assert.notEqual(data.acquisition.channel, 'DIRECT');
    assert.equal(data.acquisition.surface_inter_position, 1);
    assert.equal(data.acquisition.campaign, 'spring');
    assert.equal(data.acquisition.surface_type, 'search',
        'The surface itself is still published: WHERE the merchant was standing is ours to state, '
        + 'and it is what selects the reading of the field below.');
    assert.equal(data.acquisition.surface_detail, '',
        'On a search surface `surface_detail` is the merchant`s own typed App Store query, and this '
        + 'build neither captures nor serves it. ⚠️ THE FIXTURE CARRIES A NON-EMPTY VALUE ON PURPOSE '
        + '(`fixture query text`), so the empty string here is the read guard in storeRow.resolver '
        + 'doing its job rather than an already-blank row: against a blank fixture the guard could '
        + 'be deleted and this assertion would still pass, while every historical query an operator '
        + 'already has stored went back out over the API until their next LIFETIME re-sync.');
    assert.equal(data.acquisition.country, 'United States',
        'GA4 geo.country for the install event — the VISITOR`s inferred geolocation.');
    assert.equal(data.subscription.country, '',
        'The MERCHANT`s registered country, which the Partner API has on no version. The two must '
        + 'never be merged: one is a traffic figure and the other a merchant fact.');
    assert.equal(data.provenance.acquisition, 'listing_analytics');
});

test('a browse-surface install still serves its placement handle, and that handle is what marks it PAID', async () => {
    _reset();
    const data = await _read(BROWSE);

    assert.equal(data.acquisition.surface_type, 'home');
    assert.equal(data.acquisition.surface_detail, 'homepage-ads',
        'The read guard blanks a SEARCH detail and nothing else. On a browse surface this field is '
        + 'Shopify`s own placement handle rather than anything a merchant typed, and it is what the '
        + '"Came from" card is made of — a guard widened to every surface empties that card while '
        + 'the suite stays green.');
    assert.equal(data.acquisition.channel, 'APP_STORE_AD',
        'The classifier runs on the REPOSITORY row, upstream of the guard, and reads surface_detail '
        + '`homepage-ads` on surface_type `home` as an ad click. surface.constants.ts records 49 '
        + 'installs of that shape against 3 labelled `homepage_ad`, so blanking the classifier`s '
        + 'input would re-read every one of them as organic browsing — silently, in the one column '
        + 'that exists to tell paid from organic apart.');
    assert.equal(data.acquisition.channel_label, 'Shopify App Store ad');
});


/* ==========================================================================
 *  4. Subscription state, staleness and the voided conversion
 * ========================================================================== */

test('a paying store is CONVERTED, is not billing-stale, and names its cadence per charge', async () => {
    _reset();
    const data = await _read(CONVERTED);

    assert.equal(data.subscription.status, 'CONVERTED');
    assert.equal(data.subscription.state_basis, 'billing_on');
    assert.equal(data.subscription.plan_name, 'Pro');
    assert.equal(data.subscription.plan_price, 29);
    assert.equal(data.subscription.plan_interval, 'EVERY_30_DAYS', 'From a SETTLED payout, never inferred.');
    assert.ok(data.subscription.trial_end instanceof Date);
    assert.equal(data.subscription.trial_days_source, 'partner_billing_on');
    assert.ok(data.subscription.activation_date instanceof Date,
        'The SUBSCRIPTION`s start — the merchant`s approval — not the install date.');
    assert.equal(data.subscription.billing_stale, false, 'A payout settled inside the live window.');
    assert.equal(data.summary.mrr, 29);

    assert.equal(data.subscriptions.length, 1);
    assert.equal(data.subscriptions[0].is_current, true);
    assert.equal(data.subscriptions[0].charge_id, '111');
    assert.equal(data.subscriptions[0].settled_payout_observed, true);
});

test('billing_stale is a MEASUREMENT: a paid plan whose payouts have aged out', async () => {
    _reset();
    const stale = await _read(STALE);
    const bare = await _read(BARE);

    assert.equal(stale.subscription.status, 'CONVERTED');
    assert.equal(stale.summary.mrr, 0, 'Measured and not paying now — not `null`, which is "nothing to evaluate".');
    assert.equal(stale.subscription.billing_stale, true);

    assert.equal(bare.subscription.billing_stale, false,
        '"We have never fetched a payout" and "the payments stopped" are different facts, and only '
        + 'one of them is about the merchant.');
});

test('a trial that ended before its billing date marks the conversion VOIDED, not deleted', async () => {
    _reset();
    const data = await _read(VOIDED);

    assert.equal(data.subscription.status, 'CHURNED_IN_TRIAL');
    assert.ok(data.subscription.conversion_date instanceof Date,
        'The planned date is kept: the card strikes it through, and the intent is half the story.');
    assert.equal(data.subscription.conversion_date_voided, true);
    assert.ok(data.subscription.churn_date instanceof Date);
    assert.ok(data.subscription.uninstalled_at instanceof Date);
    assert.equal(data.subscription.install_state, 'UNINSTALLED');
    assert.equal(data.subscription.store_active, false);
});


/* ==========================================================================
 *  5. The timeline
 * ========================================================================== */

test('the timeline merges all three sources, newest first, with a source on every entry', async () => {
    _reset();
    const data = await _read(CONVERTED);

    assert.equal(data.timeline.length, 8, '4 events + 3 payouts + 1 listing-analytics record.');
    for (let i = 1; i < data.timeline.length; i += 1) {
        assert.ok(data.timeline[i - 1].at.getTime() >= data.timeline[i].at.getTime(),
            'The drawer groups by calendar day WITHOUT sorting first, so this order IS the screen order.');
    }
    for (const entry of data.timeline) {
        assert.ok(['partner_event', 'transaction', 'ga4_attribution'].includes(entry.source),
            'A source outside the drawer`s SOURCE_LABEL map renders its raw snake_case key on screen.');
        assert.ok(['positive', 'negative', 'neutral'].includes(entry.tone));
        assert.equal(typeof entry.label, 'string');
        assert.ok(entry.label.length > 0);
        assert.equal(typeof entry.detail, 'string');
    }

    assert.equal(_fromSource(data, 'transaction').length, 3);
    assert.equal(_fromSource(data, 'ga4_attribution').length, 1);
    assert.equal(_fromSource(data, 'partner_event').length, 4,
        'The USAGE_CHARGE_APPLIED event decides nothing and must still be visible.');
});

test('a refund is toned by the SIGN of the money, not by the payout type', async () => {
    _reset();
    const data = await _read(CONVERTED);
    const payouts = _fromSource(data, 'transaction');

    const credit = payouts.find((entry) => entry.label === 'Refund or credit');
    assert.equal(credit.tone, 'negative');
    assert.ok(credit.detail.includes('USD -29.00'),
        'The detail line carries the REAL currency, which the page`s own fmtMoney cannot — it '
        + 'hard-codes a `$` and would render a EUR payout as $29.00.');

    const payment = payouts.find((entry) => entry.label === 'Subscription payment');
    assert.equal(payment.tone, 'positive');
    assert.ok(payment.detail.includes('Pro'), 'The plan name comes from the cohort fold`s own output.');
    assert.ok(payment.detail.includes('charge 111'));
});

test('a future-dated event is SHOWN on the timeline and decides nothing', async () => {
    _reset();
    const data = await _read(SKEW);

    assert.equal(data.subscription.install_state, 'INSTALLED',
        'A future uninstall must not decide today`s state.');
    assert.equal(data.diagnostics.future_events, 1);
    assert.equal(data.diagnostics.events_read, 2);
    assert.equal(data.diagnostics.events_considered, 1);
    assert.equal(data.timeline.length, 2,
        'It is still on the timeline: hiding a diagnosable row from the audit surface makes it '
        + 'invisible instead of explicable.');
    assert.ok(data.warnings.some((w) => w.includes('dated in the future')));
});


/* ==========================================================================
 *  5b.  The charge-keyed read: the end event a domain-keyed one cannot see
 * ========================================================================== */

test('a cancellation whose shop was REDACTED still churns the subscription', async () => {
    _reset();
    const data = await _read(REDACTED);

    assert.equal(data.subscription.status, 'CHURNED',
        'Its only end event carries NO shop_domain, so the domain-keyed read misses it entirely. '
        + 'Without the charge-keyed pass this store reads CONVERTED for ever — over a table row that '
        + 'says CHURNED, which is the divergence this module reuses one fold to prevent.');
    assert.ok(data.subscription.churn_date instanceof Date);
    assert.equal(data.diagnostics.charge_keyed_events_recovered, 1);
    assert.ok(data.timeline.some((entry) => entry.label === 'Subscription cancelled'),
        'The recovered event belongs on the timeline too — it is this store`s history.');
});

test('the charge-keyed read is de-duplicated and refuses another store`s rows', async () => {
    _reset();
    const converted = await _read(CONVERTED);

    assert.equal(converted.diagnostics.charge_keyed_events_recovered, 0,
        'Both reads return this store`s charge events, and the merge de-duplicates on the '
        + 'collection`s own idempotency key rather than double-counting them.');
    assert.equal(converted.diagnostics.events_read, 4);
    assert.deepEqual(STATE.lastChargeQuery.charge_ids, ['111'],
        'The ids come from the store`s own events AND its payouts.');

    const redacted = await _read(REDACTED);
    assert.equal(
        redacted.timeline.filter((entry) => entry.label === 'Subscription cancelled').length,
        1,
        'A charge belongs to one shop in practice, but the database does not enforce it — the row '
        + 'naming other-shop.myshopify.com on the same charge must not reach this store`s timeline.'
    );
});

test('a settled payout whose shop was REDACTED still proves the subscription converted', async () => {
    _reset();
    const data = await _read(INFERRED_PAID);

    assert.equal(data.subscription.status, 'CONVERTED');
    assert.equal(data.subscription.state_basis, 'settled_payout',
        'Shopify supplied no billingOn, so this store`s state rests entirely on whether money moved '
        + 'against its charge — and the payout that proves it carries no shop_domain. Without the '
        + 'charge-keyed payout read it reads ON_TRIAL here and CONVERTED on the list behind it.');
    assert.equal(data.diagnostics.charge_keyed_payouts_recovered, 1);

    //  EVIDENCE, NOT MONEY. A payout that names no shop cannot be attributed to one, and the
    // roster's own spend aggregation excludes it — so admitting it into a total here would make the
    // panel's lifetime figure disagree with the same store's figure on the list.
    assert.equal(data.payouts.transaction_count, 0);
    assert.equal(data.payouts.total_gross, null);
    assert.equal(data.summary.lifetime_value, null);
    assert.equal(data.summary.mrr, null, 'Nothing was evaluated — this is not a measured zero.');
    assert.equal(data.subscription.billing_stale, false);
    assert.equal(
        data.timeline.filter((entry) => entry.source === 'transaction').length,
        0,
        'It is kept off the timeline too — the one row this audit surface withholds. Showing a '
        + 'payment whose money appears in no total beside it is worse than not showing it.'
    );
    assert.equal(data.subscription.plan_interval, 'EVERY_30_DAYS',
        'The cadence IS taken from it: a cadence belongs to the charge, not to the shop.');
});

test('a store with no charges at all skips the second read entirely', async () => {
    _reset();
    const data = await _read(BARE);

    assert.equal(STATE.lastChargeQuery, null,
        'An empty $in matches nothing, so issuing it would only make the log read as though a '
        + 'question had been asked.');
    assert.equal(data.diagnostics.charge_keyed_events_recovered, 0);
});


/* ==========================================================================
 *  6. The needle, the refusals, and the watermark that chooses between them
 * ========================================================================== */

test('the needle is normalised, so a raw shop URL resolves to the same store', async () => {
    _reset();
    const data = await _read('https://Converted-Shop.myshopify.com/admin');

    assert.equal(STATE.lastEventQuery.shop_domain, CONVERTED,
        'The stored column is canonicalised on write, so a raw needle would match nothing — with no '
        + 'error and no way to tell that from a store that does not exist.');
    assert.equal(data.subscription.shop_domain, CONVERTED);
});

test('an unknown store REFUSES with the reason, and the reason comes from the WATERMARK', async () => {
    _reset();

    const looked = await getStoreDetail({ user_id: 'operator-1' }, { partner_app_id: 'app-1', shop_domain: NOBODY });
    assert.equal(looked.status, false);
    assert.deepEqual(looked.data, {});
    assert.ok(looked.msg.includes(NOBODY));
    assert.ok(looked.msg.includes('LIFETIME'), 'It must say what would fix it.');

    STATE.app = { ...APP, last_synced_at: null };
    const neverLooked = await getStoreDetail({ user_id: 'operator-1' }, { partner_app_id: 'app-1', shop_domain: NOBODY });
    assert.equal(neverLooked.status, false);
    assert.ok(neverLooked.msg.includes('No Partner sync has completed'),
        '"We have not looked" and "we looked and there is nothing" must never read alike — and a row '
        + 'count cannot tell them apart.');
    assert.notEqual(neverLooked.msg, looked.msg);
});

test('a tenant_id is refused with a sentence naming the parameter that works', async () => {
    _reset();
    const result = await getStoreDetail(
        { user_id: 'operator-1' },
        { partner_app_id: 'app-1', tenant_id: '65f0a1b2c3d4e5f60718293a' }
    );

    assert.equal(result.status, false);
    assert.ok(result.msg.includes('shop_domain'),
        'The client sends ONE identity key, so a request carrying a tenant id carries no domain — '
        + 'ignoring it would mean describing whichever store an empty needle happened to match.');
    assert.ok(result.msg.includes('tenant'));
});

test('the remaining refusals each carry an actionable sentence', async () => {
    _reset();

    const noUser = await getStoreDetail({}, { partner_app_id: 'app-1', shop_domain: BARE });
    assert.equal(noUser.status, false);

    const noApp = await getStoreDetail({ user_id: 'operator-1' }, { shop_domain: BARE });
    assert.equal(noApp.status, false);
    assert.ok(noApp.msg.includes('/api/partner-apps'));

    const noStore = await getStoreDetail({ user_id: 'operator-1' }, { partner_app_id: 'app-1' });
    assert.equal(noStore.status, false);
    assert.ok(noStore.msg.includes('shop_domain is required'));

    const unreadable = await getStoreDetail({ user_id: 'operator-1' }, { partner_app_id: 'app-1', shop_domain: '   ///   ' });
    assert.equal(unreadable.status, false);
    assert.ok(unreadable.msg.includes('myshopify domain'));

    STATE.app = null;
    const missingApp = await getStoreDetail({ user_id: 'operator-1' }, { partner_app_id: 'app-1', shop_domain: BARE });
    assert.equal(missingApp.status, false);
    assert.equal(missingApp.msg, 'Partner app not found.');
});


/* ==========================================================================
 *  7. The envelope: provenance, the two kinds of nothing, and the review block
 * ========================================================================== */

test('provenance names a source for every field whose source can vary', async () => {
    _reset();
    const data = await _read(CONVERTED);

    assert.equal(data.provenance.customer_name, 'partner');
    assert.equal(data.provenance.state, 'billing_on');
    assert.equal(data.provenance.trial_end, 'partner_billing_on');
    assert.equal(data.provenance.install_state, 'partner_events');
    assert.equal(data.provenance.monthly_spend, 'settled_payouts');

    const bare = await _read(BARE);
    assert.equal(bare.provenance.state, 'join_miss');
    assert.equal(bare.provenance.monthly_spend, 'none',
        'A null monthly spend is "nothing to evaluate"; crediting it to the payout ledger would '
        + 'attribute an absence to a source.');
});

test('`unavailable` keeps NOT_EXPOSED apart from NOT_PUSHED', async () => {
    _reset();
    const data = await _read(CONVERTED);

    assert.equal(data.unavailable.country.reason, 'NOT_EXPOSED');
    assert.ok(data.unavailable.country.message.includes('Admin API'),
        'The permanent limit: the Partner API`s Shop object has four fields and none is a country.');
    assert.equal(data.unavailable.shopify_plan_name.reason, 'NOT_EXPOSED');
    assert.equal(data.unavailable.operator.reason, 'NOT_PUSHED',
        'Temporary and actionable — the two must not be merged, or a self-hoster is told to go and '
        + 'fetch a value that provably cannot be fetched.');
    assert.equal(data.operator, null);
});

test('the app review block says it cannot answer rather than publishing a zero', async () => {
    _reset();
    const data = await _read(CONVERTED);

    assert.equal(data.app_review.available, false);
    assert.equal(data.app_review.rating, null, 'A 0 renders as a zero-star rating.');
    assert.ok(data.app_review.note.includes('no review or rating data'));
    assert.equal(data.app_review.listing_url, 'https://apps.shopify.com/demo',
        'The "Open listing" link must still resolve.');
});

test('the envelope carries the tier states, the meta and unique warnings', async () => {
    _reset();
    const data = await _read(CONVERTED);

    assert.equal(data.data_state, 'READY',
        'READY by construction: a store cannot be described from a tier that has never synced, and '
        + 'that case refuses.');
    assert.equal(data.attribution_state, 'READY');
    assert.equal(data.app_id, 'app-1');
    assert.equal(data.app_name, 'Demo App');
    assert.equal(typeof data.as_of, 'string');
    assert.equal(typeof data.meta.last_synced_at, 'string');
    assert.equal(data.meta.last_store_push_at, null);
    assert.equal(new Set(data.warnings).size, data.warnings.length);
});


/* ==========================================================================
 *  8. The two pure folds, reached by deep path
 *
 *  The module barrel does NOT publish these, and that is what makes a deep import from a test the
 *  intended way in: they are pure, so they can be exercised against literals with no database — and
 *  the entry cap in particular is unreachable through the service, whose limit is a constant.
 * ========================================================================== */

const { resolveStoreTimeline } = require(path.join(MODULE_ROOT, 'resolvers', 'storeTimeline.resolver.ts'));
const { foldStoreSpend } = require(path.join(MODULE_ROOT, 'helpers', 'storeSpend.helper.ts'));

test('the timeline cap keeps the NEWEST entries and REPORTS what it withheld', () => {
    const events = [1, 2, 3, 4, 5].map((n) => ({
        event_type: 'INSTALL',
        occurred_at: _daysAgo(n * 10),
        charge_id: ''
    }));

    const capped = resolveStoreTimeline({
        events,
        transactions: [],
        attribution: [],
        plan_name_by_charge: new Map(),
        limit: 2
    });

    assert.equal(capped.entries.length, 2);
    assert.equal(capped.truncated, 3,
        'A truncated audit surface that does not say so is indistinguishable from a complete one, '
        + 'and the reader concludes the store`s history begins wherever the cap fell.');
    assert.equal(capped.entries[0].at.getTime(), _daysAgo(10).getTime(), 'Newest first.');
    assert.equal(capped.entries[1].at.getTime(), _daysAgo(20).getTime());

    const uncapped = resolveStoreTimeline({
        events,
        transactions: [],
        attribution: [],
        plan_name_by_charge: new Map(),
        limit: 0
    });
    assert.equal(uncapped.entries.length, 5, 'A cap at or below zero means "no cap".');
    assert.equal(uncapped.truncated, 0);
});

test('entries sharing an instant are ordered deterministically, not by arrival', () => {
    const at = _daysAgo(7);
    const input = {
        events: [{ event_type: 'SUBSCRIPTION_CHARGE_ACTIVATED', occurred_at: at, charge_id: '111' }],
        transactions: [{ type: 'APP_SUBSCRIPTION', shop_domain: 'x', charge_id: '111', billing_interval: 'EVERY_30_DAYS', gross_amount: { amount: 29, currency: 'EUR' }, net_amount: { amount: 25, currency: 'EUR' }, created_at: at }],
        attribution: [],
        plan_name_by_charge: new Map([['111', 'Pro']]),
        limit: 50
    };

    const first = resolveStoreTimeline(input);
    const reversed = resolveStoreTimeline({
        ...input,
        transactions: [...input.transactions].reverse(),
        events: [...input.events].reverse()
    });

    assert.deepEqual(
        first.entries.map((e) => `${e.source}:${e.label}`),
        reversed.entries.map((e) => `${e.source}:${e.label}`),
        'Shopify`s occurredAt has no sub-second component, so a payout and the event that earned it '
        + 'routinely share an instant. Without a tie-break the panel reshuffles between requests.'
    );
    assert.ok(first.entries.some((e) => e.detail.includes('EUR 29.00')),
        'The currency is carried on the detail line because the page`s fmtMoney hard-codes a `$`.');
});

test('the money fold clamps at the judgement instant and counts what it clamped', () => {
    const asOf = new Date(NOW);
    const fold = foldStoreSpend({
        rows: [
            { type: 'APP_SUBSCRIPTION', shop_domain: 'x', charge_id: '1', billing_interval: 'EVERY_30_DAYS', gross_amount: { amount: 29, currency: 'USD' }, net_amount: { amount: 25, currency: 'USD' }, created_at: _daysAgo(3) },
            //  A payout that has not settled yet is not evidence today. Unbounded, it would make a
            // store CONVERTED as of a date it had not paid — and the error runs one way only,
            // because the churn side IS clamped.
            { type: 'APP_SUBSCRIPTION', shop_domain: 'x', charge_id: '1', billing_interval: 'ANNUAL', gross_amount: { amount: 290, currency: 'USD' }, net_amount: { amount: 250, currency: 'USD' }, created_at: _daysAhead(4) },
            { type: 'APP_SUBSCRIPTION', shop_domain: 'x', charge_id: '1', billing_interval: null, gross_amount: { amount: 29, currency: 'USD' }, net_amount: { amount: 25, currency: 'USD' }, created_at: null }
        ],
        as_of: asOf
    });

    assert.equal(fold.transaction_count, 1, 'Only the settled, dated, in-window row counts.');
    assert.equal(fold.total_gross, 29);
    assert.equal(fold.future_transactions, 1);
    assert.equal(fold.undated_transactions, 1);
    assert.equal(fold.interval_by_charge.get('1'), 'EVERY_30_DAYS',
        'The future row`s ANNUAL cadence must not reach the fold — booking a monthly subscriber as '
        + 'annual is the same error as the reverse, in the other direction.');
    assert.equal(fold.latest_subscription_payout.created_at.getTime(), _daysAgo(3).getTime());
});

test('the money fold refuses to run without a judgement instant', () => {
    assert.throws(
        () => foldStoreSpend({ rows: [], as_of: null }),
        /valid `as_of` Date/,
        'An Invalid Date compares false in every direction, so it would admit every future payout '
        + 'while reporting that none existed.'
    );
});


/* ==========================================================================
 *  A null name watermark is the WIDEST boundary, not the absence of one
 * ========================================================================== */

test('a nameless store explains itself even when the name watermark is null', async () => {
    _reset();
    //  GHOST has no Partner event at all, so `shop_name` is '' — and `shop_name_coverage_since` is
    // null on the fixture app, which with a real `earliest_event_at` means NO synced event anywhere
    // carries a name. The old `instanceof Date` test skipped exactly that state, so the widest
    // possible boundary produced no sentence while every narrower one did.
    const data = await _read(GHOST);
    assert.equal(data.subscription.shop_name, '');
    assert.equal(data.meta.shop_name_coverage_since, null);
    assert.ok(
        data.warnings.some((w) => w.includes('no synced Partner event carries a store name')),
        'A bare domain with no explanation reads as data loss rather than as sync state.'
    );

    // A boundary INSIDE the history reports itself with its date instead, and the two never both fire.
    STATE.app = { ...APP, shop_name_coverage_since: _daysAgo(100) };
    const bounded = await _read(GHOST);
    assert.ok(bounded.warnings.some((w) => w.includes('synced since')));
    assert.ok(!bounded.warnings.some((w) => w.includes('no synced Partner event carries a store name')));

    // And a store that HAS a name says nothing at all, whatever the watermark.
    _reset();
    const named = await _read(CONVERTED);
    assert.equal(named.subscription.shop_name, 'Converted Store');
    assert.ok(!named.warnings.some((w) => w.includes('store name')));
});
