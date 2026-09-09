'use strict';

/**
 * ============================================================================
 *  CUSTOM FUNNEL — the closed catalog, the null that must not be a zero, and
 *  the order that belongs to the operator
 * ============================================================================
 *
 *  Exercises `getCustomFunnel` end to end with both repositories and the BigQuery barrel stubbed
 *  out, so the whole assembly — selection → tiers → measurement → rates → trial block → warnings —
 *  runs against fixtures with no database and no BigQuery.
 *
 *  ── 1. A RATE WITH NO DENOMINATOR IS `null`, AND `0` IS A CLAIM ──────────
 *
 *  The implementation this was ported from divided through `_safeDiv`, which answered `0` for an
 *  empty denominator. `_fmtHeadline(0)` renders **"0.00%"** in 32-pixel type under the words
 *  "Conversion rate" — a checkable claim about the operator's business, manufactured by an
 *  arithmetic convenience on a funnel that had never been measured. `_fmtHeadline(null)` renders an
 *  em dash and claims nothing. Every rate in this endpoint goes through `rate()` for that reason,
 *  and this file is what stops an `orZero` variant from being added back.
 *
 *  ── 2. `steps[].key` MUST BE A SUBSET OF `catalog[].key` ─────────────────
 *
 *  `orderedSelection` (`PartnerFunnelChart.js:185`) resolves the selection against the catalog while
 *  `moveEvent` (`:173`) indexes into the raw selection. A step outside the catalog therefore
 *  occupies a slot in the funnel and vanishes from the reorder list, so the ↑/↓ buttons move the
 *  WRONG step — silently, for every step after it.
 *
 *  ── 3. THE ORDER IS THE OPERATOR'S, AND THE PAGE SAVES IT ────────────────
 *
 *  `funnel/index.js` persists `steps.map(s => s.key)` into `localStorage`. A server that reorders
 *  does not merely display something else; it OVERWRITES the funnel the operator built, with nothing
 *  on screen to undo it from. Same reason every dropped key is named in `warnings[]`.
 *
 *  ── 4. THE UNION, NEVER THE SUM ─────────────────────────────────────────
 *
 *  A step spanning several event types counts the union of their shop sets. Summing per-type counts
 *  double-counts every shop that fired both, and produces a larger, entirely plausible number.
 *
 *  ── 5. AN UNCONFIGURED TIER IS NOT A REFUSAL, AND NOT A `data_state` ─────
 *
 *  `dataState.js` treats `data.data_state === 'NEVER_SYNCED'` as "null the whole payload and draw a
 *  banner". Setting it whenever the listing tier is cold would throw away a correct Partner funnel
 *  over a missing BigQuery credential — which is the same regression, one layer further out, as
 *  refusing outright.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';
//  What `resolveBigQueryAvailability` reads. It is stubbed below, so these only keep the real
// config from complaining on import; nothing in this file ever reaches BigQuery.
process.env.GCP_PROJECT_ID = 'test-project';
process.env.BQ_DATASET = 'test_dataset';
process.env.GCP_SERVICE_ACCOUNT_JSON = '{}';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mongoose = require('mongoose');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const MODULE_ROOT = path.join(BACKEND_ROOT, 'src', 'modules', 'conversion');

/** Never reached — nothing here issues a query — but a short buffer keeps a mistake from hanging. */
mongoose.set('bufferTimeoutMS', 400);

const funnelConstants = require(path.join(MODULE_ROOT, 'constants', 'funnelEvent.constants.ts'));
const funnelMath = require(path.join(MODULE_ROOT, 'helpers', 'funnelMath.helper.ts'));
const funnelRepository = require(path.join(MODULE_ROOT, 'repositories', 'customFunnel.repository.ts'));
const cohortRepository = require(path.join(MODULE_ROOT, 'repositories', 'installCohort.repository.ts'));
const bigQueryModule = require(path.join(BACKEND_ROOT, 'src', 'modules', 'bigquery', 'index.ts'));

const { FUNNEL_EVENT_CATALOG, MAX_FUNNEL_EVENTS } = funnelConstants;
const { rate, dropRate, countShopsForTypes, resolveRequestedEvents } = funnelMath;

const _at = (iso) => new Date(iso);

const APP = {
    _id: 'app-1',
    display_name: 'Demo App',
    last_synced_at: _at('2026-09-01T00:00:00.000Z'),
    last_bq_synced_at: _at('2026-09-01T00:00:00.000Z'),
    earliest_event_at: _at('2024-01-01T00:00:00.000Z'),
    lifetime_sync_completed_at: null,
    event_history_gap_days: 0
};

/** One window's listing rollup totals. `installs` is the field behind the `ga4_installs` KEY. */
const GA4_TOTALS = {
    views: 4120,
    engaged_views: 900,
    install_clicks: 340,
    consent_started: 0,
    consent_completed: 0,
    installs: 60,
    ad_clicks: 20,
    first_opens: 55,
    sessions: 0,
    first_visits: 0
};

/** Six distinct shops fired INSTALL; two of them also fired REINSTALL. */
const PARTNER_SHOP_SETS = {
    rows: [
        {
            event_type: 'INSTALL',
            shops: ['a.myshopify.com', 'b.myshopify.com', 'c.myshopify.com', 'd.myshopify.com', 'e.myshopify.com', 'f.myshopify.com']
        },
        { event_type: 'REINSTALL', shops: ['a.myshopify.com', 'b.myshopify.com'] }
    ],
    shopless_events: 0
};

/**
 * Five subscriptions, chosen so every count in the trial block is a DIFFERENT number — a fixture
 * where two figures coincide cannot tell a swapped pair from a correct one.
 *
 *   111 conv    billingOn in the past, no end            -> PAYING                (converted)
 *   222 trial   billingOn after the judgement instant    -> ON_TRIAL              (undecided)
 *   333 churn   cancelled BEFORE its billing date        -> CHURNED_DURING_TRIAL
 *   444 late    cancelled AFTER its billing date         -> CHURNED_AFTER_TRIAL   (converted)
 *   555 old     STARTED BEFORE THE WINDOW, billed inside it
 *
 * 555 is the one that proves the missing lower bound. Its trial started in July, so it is NOT in
 * this window's cohort — but it converted in August, so `window_kpi.converted_in_window` must see
 * it. A `$gte` on the event pull would drop its START event, the subscription would never be
 * bucketed, and the KPI would silently under-count.
 */
const COHORT_EVENTS = [
    {
        event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
        shop_domain: 'conv.myshopify.com',
        charge_id: '111',
        occurred_at: _at('2026-08-05T10:00:00.000Z'),
        raw_event: { charge: { id: 'gid://shopify/AppSubscription/111', name: 'Pro', billingOn: '2026-08-12', test: false, amount: { amount: '29.00', currencyCode: 'USD' } } }
    },
    {
        event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
        shop_domain: 'trial.myshopify.com',
        charge_id: '222',
        occurred_at: _at('2026-08-20T10:00:00.000Z'),
        raw_event: { charge: { id: 'gid://shopify/AppSubscription/222', name: 'Pro', billingOn: '2026-09-15', test: false, amount: { amount: '29.00', currencyCode: 'USD' } } }
    },
    {
        event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
        shop_domain: 'churn.myshopify.com',
        charge_id: '333',
        occurred_at: _at('2026-08-06T10:00:00.000Z'),
        raw_event: { charge: { id: 'gid://shopify/AppSubscription/333', name: 'Pro', billingOn: '2026-08-13', test: false, amount: { amount: '29.00', currencyCode: 'USD' } } }
    },
    {
        event_type: 'SUBSCRIPTION_CHARGE_CANCELLED',
        shop_domain: 'churn.myshopify.com',
        charge_id: '333',
        occurred_at: _at('2026-08-10T10:00:00.000Z'),
        raw_event: {}
    },
    {
        event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
        shop_domain: 'late.myshopify.com',
        charge_id: '444',
        occurred_at: _at('2026-08-07T10:00:00.000Z'),
        raw_event: { charge: { id: 'gid://shopify/AppSubscription/444', name: 'Pro', billingOn: '2026-08-14', test: false, amount: { amount: '29.00', currencyCode: 'USD' } } }
    },
    {
        event_type: 'SUBSCRIPTION_CHARGE_CANCELLED',
        shop_domain: 'late.myshopify.com',
        charge_id: '444',
        occurred_at: _at('2026-08-25T10:00:00.000Z'),
        raw_event: {}
    },
    {
        event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
        shop_domain: 'old.myshopify.com',
        charge_id: '555',
        occurred_at: _at('2026-07-01T10:00:00.000Z'),
        raw_event: { charge: { id: 'gid://shopify/AppSubscription/555', name: 'Pro', billingOn: '2026-08-03', test: false, amount: { amount: '29.00', currencyCode: 'USD' } } }
    }
];

const AVAILABLE = Object.freeze({ enabled: true, missing_env: [], message: 'BigQuery is configured.' });
const UNAVAILABLE = Object.freeze({
    enabled: false,
    missing_env: ['GCP_PROJECT_ID', 'BQ_DATASET'],
    message: 'GCP_PROJECT_ID and BQ_DATASET are not set.'
});

/**
 * ⚠️ The stubs are installed BEFORE the service is required, and read mutable state afterwards.
 * Every service in this codebase destructures its dependencies at MODULE LOAD, so re-assigning an
 * export after the service has been required has no effect at all — a test that did that would pass
 * while asserting nothing.
 */
const STATE = {
    app: APP,
    availability: AVAILABLE,
    ga4Totals: GA4_TOTALS,
    partnerShopSets: PARTNER_SHOP_SETS,
    transactionShopSets: [],
    firstTransactionShops: 0,
    cohortEvents: COHORT_EVENTS,
    settled: { charge_ids: [], shop_domains: [] },
    appThrows: false,
    /** The last query each read was handed, so its bounds can be asserted. */
    ga4Query: null,
    cohortQuery: null,
    partnerQuery: null
};

const _reset = () => {
    STATE.app = APP;
    STATE.availability = AVAILABLE;
    STATE.ga4Totals = GA4_TOTALS;
    STATE.partnerShopSets = PARTNER_SHOP_SETS;
    STATE.transactionShopSets = [];
    STATE.firstTransactionShops = 0;
    STATE.cohortEvents = COHORT_EVENTS;
    STATE.settled = { charge_ids: [], shop_domains: [] };
    STATE.appThrows = false;
    STATE.ga4Query = null;
    STATE.cohortQuery = null;
    STATE.partnerQuery = null;
};

cohortRepository.findPartnerAppById = async () => {
    if (STATE.appThrows) {
        throw new Error('the database went away');
    }
    return STATE.app;
};

bigQueryModule.resolveBigQueryAvailability = () => STATE.availability;
bigQueryModule.aggregateListingFunnelTotals = async (query) => {
    STATE.ga4Query = query || null;
    return STATE.ga4Totals;
};

funnelRepository.aggregatePartnerShopSets = async (query) => {
    STATE.partnerQuery = query || null;
    return STATE.partnerShopSets;
};
funnelRepository.aggregateTransactionShopSets = async () => STATE.transactionShopSets;
funnelRepository.countFirstTransactionShops = async () => STATE.firstTransactionShops;
funnelRepository.findChargeCohortEvents = async (query) => {
    STATE.cohortQuery = query || null;
    return STATE.cohortEvents;
};
funnelRepository.aggregateSettledSubscriptionEvidence = async () => STATE.settled;

const { getCustomFunnel } = require(path.join(MODULE_ROOT, 'services', 'customFunnel.service.ts'));

/** The window every fixture sits inside. */
const WINDOW = { partner_app_id: 'app-1', since: '2026-08-01', until: '2026-08-31' };

/**
 * Calls the service and asserts it did not refuse.
 *
 * @param {Object} [params] - Extra query parameters merged over the fixture window.
 * @returns {Promise<Object>} The payload.
 */
const _read = async (params = {}) => {
    const result = await getCustomFunnel({ user_id: 'operator-1' }, { ...WINDOW, ...params });
    assert.equal(result.status, true, `the service refused: ${result.msg}`);
    return result.data;
};

/** Steps by key, for assertions that name a step. */
const _byKey = (data) => Object.fromEntries(data.steps.map((step) => [step.key, step]));


/* ==========================================================================
 *  1. The catalog is closed and ordered
 * ========================================================================== */

test('the catalog is exactly 28 entries — 8 ga4, 11 partner, 6 subscription, 3 transaction', () => {
    const bySource = {};
    for (const entry of FUNNEL_EVENT_CATALOG) {
        bySource[entry.source] = (bySource[entry.source] || 0) + 1;
    }

    assert.equal(FUNNEL_EVENT_CATALOG.length, 28,
        'The catalog IS the picker. Counting it here is what makes an entry added or lost a visible failure.');
    assert.deepEqual(bySource, { ga4: 8, partner: 11, subscription: 6, transaction: 3 });
});

test('`upgraded`, `downgraded` and `on_trial` are NOT in the catalog', () => {
    const keys = FUNNEL_EVENT_CATALOG.map((entry) => entry.key);

    assert.ok(!keys.includes('upgraded'),
        'Plan movements need a store plan history this build does not have. A selectable step that can '
        + 'never produce a number renders as a zero-height bar labelled "Upgrades" — a claim that nobody upgraded.');
    assert.ok(!keys.includes('downgraded'));
    assert.ok(!keys.includes('on_trial'),
        '`on_trial` is the same measurement as `trial_pending`. Two bars for one number is a funnel that '
        + 'appears to hold flat across a step where it arithmetically must.');
    assert.ok(keys.includes('trial_pending'), 'The surviving half of that pair must still be selectable.');
});

test('the catalog has unique keys, and every entry carries what the picker reads', () => {
    const keys = FUNNEL_EVENT_CATALOG.map((entry) => entry.key);
    assert.equal(new Set(keys).size, keys.length, 'A duplicate key is a duplicate React key in the picker.');

    for (const entry of FUNNEL_EVENT_CATALOG) {
        assert.equal(typeof entry.key, 'string');
        assert.ok(entry.key.length > 0);
        assert.ok(entry.label.length > 0, `${entry.key} has no label — the axis and the checkbox would both be blank.`);
        assert.ok(['ga4', 'partner', 'subscription', 'transaction'].includes(entry.source),
            `${entry.key} has source "${entry.source}", which SOURCE_META does not know — it would render under its raw name with no note.`);
        assert.ok(['events', 'shops'].includes(entry.unit),
            `${entry.key} has unit "${entry.unit}". The chart tests \`=== 'events'\` and narrates everything else as shops.`);
        assert.ok(['visitors', 'shops', 'subscriptions'].includes(entry.population));
    }
});

test('only ga4 steps are counted in `events`; everything else counts entities', () => {
    for (const entry of FUNNEL_EVENT_CATALOG) {
        if (entry.source === 'ga4') {
            assert.equal(entry.unit, 'events', `${entry.key} counts GA4 hits per visitor.`);
            assert.equal(entry.population, 'visitors');
        } else {
            assert.equal(entry.unit, 'shops', `${entry.key} must read as shops so the seam banner narrates correctly.`);
        }
    }

    const subscriptionSteps = FUNNEL_EVENT_CATALOG.filter((entry) => entry.source === 'subscription');
    for (const entry of subscriptionSteps) {
        assert.equal(entry.population, 'subscriptions',
            'A subscription step is labelled `unit: shops` for the chart and counts SUBSCRIPTIONS. '
            + '`population` is the only field that says so.');
    }
});

test('`ga4_installs` is the one key that differs from its stored field', () => {
    const entry = FUNNEL_EVENT_CATALOG.find((row) => row.key === 'ga4_installs');
    assert.equal(entry.field, 'installs',
        'The KEY cannot be `installs` — the Partner step `installed` already occupies the funnel slot a '
        + 'reader would confuse it with, and they are different measurements.');

    for (const ga4 of FUNNEL_EVENT_CATALOG.filter((row) => row.source === 'ga4')) {
        assert.ok(Object.prototype.hasOwnProperty.call(GA4_TOTALS, ga4.field),
            `${ga4.key} sums "${ga4.field}", which is not a field on the listing rollup.`);
    }
});

test('every step returned is in the catalog, or the reorder buttons move the wrong step', async () => {
    _reset();
    const data = await _read();

    const catalogKeys = new Set(data.catalog.map((entry) => entry.key));
    for (const step of data.steps) {
        assert.ok(catalogKeys.has(step.key),
            `"${step.key}" occupies a funnel slot but is absent from the picker's list, so moveEvent indexes past it.`);
    }
    assert.equal(data.max_events, MAX_FUNNEL_EVENTS);
    assert.ok(data.max_events > 0,
        'The chart reads `(data && data.max_events) || 10`, so a 0 becomes 10 on the client while the server enforces 0.');
});


/* ==========================================================================
 *  2. `rate()` answers null, never 0, for an empty denominator
 * ========================================================================== */

test('rate() returns null — never 0 — for an empty, missing or non-finite denominator', () => {
    assert.equal(rate(5, 0), null,
        'A `0` here renders as "0.00%" under "Conversion rate" — a claim about the business made by an arithmetic convenience.');
    assert.equal(rate(5, null), null);
    assert.equal(rate(5, undefined), null);
    assert.equal(rate(5, Number.NaN), null);
    assert.equal(rate(5, Number.POSITIVE_INFINITY), null);

    assert.equal(rate(null, 100), null, 'An unknown numerator is not "none of them".');
    assert.equal(rate(undefined, 100), null);

    assert.equal(rate(0, 100), 0, 'A measured zero must stay reachable — nobody out of a hundred IS a measurement.');
    assert.equal(rate(25, 100), 0.25);
    assert.equal(rate(0, 0), null);
});

test('dropRate() is null — never negative — when a step converts above 100%', () => {
    assert.equal(dropRate(0.25), 0.75);
    assert.equal(dropRate(1), 0);
    assert.equal(dropRate(1.42), null,
        '"-42.0% drop-off" renders perfectly and means nothing. It happens legitimately across the '
        + 'measurement seam and on the decided basis.');
    assert.equal(dropRate(null), null);
    assert.equal(dropRate(undefined), null);
});

test('a zero first step gives a null headline, not "0.00%"', async () => {
    _reset();
    STATE.ga4Totals = { ...GA4_TOTALS, views: 0 };

    const data = await _read();
    assert.equal(data.steps[0].count, 0, 'The rollup measured zero views, and that is a real answer.');
    assert.equal(data.conversion_rate, null,
        'There is no rate out of nothing. `0` would assert that everyone who saw the listing failed to convert.');
    assert.equal(data.steps[0].cumulative_conversion_pct, null);
});


/* ==========================================================================
 *  3. A null step nulls its rates rather than zeroing them
 * ========================================================================== */

test('an unconfigured listing tier gives count:null — not 0 — and nulls every rate that touches it', async () => {
    _reset();
    STATE.availability = UNAVAILABLE;

    const data = await _read({ events: 'views,install_clicks,installed,trial_started' });
    const steps = _byKey(data);

    assert.equal(data.tiers.listing.state, 'NOT_CONNECTED');
    assert.ok(data.tiers.listing.reason.includes('GCP_PROJECT_ID'),
        'The reason must name the missing variable — it is the single most valuable sentence the API emits.');
    assert.equal(data.tiers.partner.state, 'READY');

    assert.equal(steps.views.count, null, 'A `0` here is the claim "nobody viewed your listing".');
    assert.equal(steps.views.available, false);
    assert.ok(steps.views.unknown_reason);
    assert.equal(steps.install_clicks.count, null);

    assert.equal(steps.install_clicks.conversion_pct, null);
    assert.equal(steps.install_clicks.rate_basis, 'unavailable');
    assert.equal(steps.install_clicks.rate_denominator, null);
    assert.equal(steps.install_clicks.drop_pct, null);
    assert.equal(steps.installed.conversion_pct, null,
        'Its predecessor is unknown, so there is no denominator — not a denominator of zero.');
    assert.equal(steps.installed.rate_basis, 'unavailable');

    assert.equal(steps.installed.count, 6, 'The PARTNER steps are present and correct and must not be blanked.');
    assert.equal(steps.installed.available, true);
    assert.equal(data.conversion_rate, null);
    assert.equal(data.ga4_until, null);

    assert.ok(data.warnings.some((line) => line.includes('GCP_PROJECT_ID')),
        'The chart renders warnings in a Banner — that is the zero-frontend-change path to saying why the bars are empty.');
});

test('an unconfigured listing tier is NOT a refusal and NOT a payload-nulling data_state', async () => {
    _reset();
    STATE.availability = UNAVAILABLE;

    const result = await getCustomFunnel({ user_id: 'operator-1' }, WINDOW);
    assert.equal(result.status, true,
        'A status:false maps to PartnerFunnelChart\'s own empty state — "run a sync to populate GA4 and '
        + 'Partner events" — over Partner data that is already synced and correct.');
    assert.equal(result.data.data_state, undefined,
        'dataState.js reads `data_state: NEVER_SYNCED` as "null the whole payload", which would discard a working Partner funnel.');
    assert.ok(result.data.steps.length >= 2);
});

test('data_state is set ONLY when no tier can answer, and carries its own reason', async () => {
    _reset();
    STATE.availability = UNAVAILABLE;
    STATE.app = { ...APP, last_synced_at: null };

    const data = await _read();
    assert.equal(data.data_state, 'NEVER_SYNCED',
        'Nothing at all is measurable here, so the banner IS the honest rendering.');
    assert.ok(data.unknown_reason && data.unknown_reason.length > 0,
        'Without this the page prints the SUCCESS message under the heading "Nothing synced yet" — '
        + 'dataState.js falls back to `resp.msg`.');
    for (const step of data.steps) {
        assert.equal(step.count, null);
        assert.equal(step.available, false);
    }
});

test('a never-synced PARTNER tier alone does not null the payload', async () => {
    _reset();
    STATE.app = { ...APP, last_synced_at: null };

    const data = await _read();
    assert.equal(data.tiers.partner.state, 'NEVER_SYNCED');
    assert.equal(data.tiers.listing.state, 'READY');
    assert.equal(data.data_state, undefined, 'The listing tier can still answer, so the chart must still draw.');
    assert.equal(_byKey(data).views.count, 4120);
    assert.equal(_byKey(data).installed.count, null);
    assert.ok(data.warnings.some((line) => line.includes('No Partner sync has completed')));
});


/* ==========================================================================
 *  4. Steps come back in the order requested
 * ========================================================================== */

test('steps are returned in the ORDER REQUESTED, never in catalog order', async () => {
    _reset();
    const requested = ['trial_converted', 'views', 'installed', 'install_clicks'];

    const data = await _read({ events: requested.join(',') });
    assert.deepEqual(data.steps.map((step) => step.key), requested,
        'The page persists steps.map(s => s.key) to localStorage, so reordering here overwrites the operator\'s saved funnel.');
    assert.deepEqual(data.events, requested, '`events` echoes what will be drawn, in the same order.');
});

test('a repeated `events` parameter is accepted as an array, in order', async () => {
    _reset();
    const data = await _read({ events: ['views', 'installed'] });
    assert.deepEqual(data.steps.map((step) => step.key), ['views', 'installed']);
});

test('the order decides the denominators, so reversing it changes the rates', async () => {
    _reset();
    const forward = await _read({ events: 'views,installed' });
    const reversed = await _read({ events: 'installed,views' });

    assert.equal(forward.steps[1].rate_denominator, 4120);
    assert.equal(reversed.steps[1].rate_denominator, 6);
    assert.notEqual(forward.conversion_rate, reversed.conversion_rate);
});


/* ==========================================================================
 *  5. The union, never the sum
 * ========================================================================== */

test('a multi-type step counts the UNION of its shop sets, never the sum', () => {
    const byType = {
        INSTALL: ['a.myshopify.com', 'b.myshopify.com', 'c.myshopify.com'],
        REINSTALL: ['b.myshopify.com', 'c.myshopify.com', 'd.myshopify.com']
    };

    assert.equal(countShopsForTypes(byType, ['INSTALL', 'REINSTALL']), 4,
        'Summing gives 6 — it double-counts b and c, which fired both. The wrong number is larger and entirely plausible.');
    assert.equal(countShopsForTypes(byType, ['INSTALL']), 3);
    assert.equal(countShopsForTypes(byType, ['REINSTALL']), 3);
});

test('an absent type contributes nothing, and no types at all is zero', () => {
    const byType = { INSTALL: ['a.myshopify.com'] };
    assert.equal(countShopsForTypes(byType, ['INSTALL', 'UNINSTALL']), 1,
        'The repository only returns types that had rows, so an absent type is a measured zero.');
    assert.equal(countShopsForTypes(byType, []), 0);
    assert.equal(countShopsForTypes(byType, undefined), 0);
});

test('the partner read asks only for the event types the selection needs', async () => {
    _reset();
    await _read({ events: 'installed,reinstalled' });

    assert.deepEqual([...STATE.partnerQuery.event_types].sort(), ['INSTALL', 'REINSTALL'],
        'Scanning the whole vocabulary to answer for two steps is paid on every keystroke in the picker.');
});


/* ==========================================================================
 *  6. Unknown keys warn rather than silently vanishing
 * ========================================================================== */

test('an unknown event key is dropped WITH A WARNING that names it', async () => {
    _reset();
    const data = await _read({ events: 'views,not_a_real_step,installed' });

    assert.deepEqual(data.steps.map((step) => step.key), ['views', 'installed'],
        'The catalog is closed — an unrecognised step cannot be drawn.');
    assert.deepEqual(data.diagnostics.unknown_event_keys, ['not_a_real_step']);
    assert.ok(data.warnings.some((line) => line.includes('not_a_real_step')),
        'Dropping it silently permanently rewrites the operator\'s saved funnel, with nothing on screen to undo it from.');
});

test('a request naming ONLY unknown keys still produces a funnel, plus the warning', async () => {
    _reset();
    const data = await _read({ events: 'nope,also_nope' });

    assert.ok(data.steps.length >= 2,
        'An empty chart reads as "no data". The fallback applies when nothing USABLE was named, not merely when nothing was sent.');
    assert.deepEqual(data.diagnostics.unknown_event_keys, ['nope', 'also_nope']);
    assert.ok(data.warnings.some((line) => line.includes('nope')));
});

test('duplicate keys are collapsed and named, because two bars cannot share one React key', async () => {
    _reset();
    const data = await _read({ events: 'views,installed,views' });

    assert.deepEqual(data.steps.map((step) => step.key), ['views', 'installed']);
    assert.deepEqual(data.diagnostics.duplicate_event_keys, ['views']);
    assert.ok(data.warnings.some((line) => line.includes('more than once')));
});

test('a selection over the cap is truncated from the END, and says which keys went', () => {
    const requested = FUNNEL_EVENT_CATALOG.slice(0, MAX_FUNNEL_EVENTS + 2).map((entry) => entry.key);
    const resolved = resolveRequestedEvents({ requested: requested.join(','), fallback_keys: [], max: MAX_FUNNEL_EVENTS });

    assert.equal(resolved.keys.length, MAX_FUNNEL_EVENTS);
    assert.deepEqual(resolved.keys, requested.slice(0, MAX_FUNNEL_EVENTS));
    assert.deepEqual(resolved.dropped_over_cap, requested.slice(MAX_FUNNEL_EVENTS));
});


/* ==========================================================================
 *  7. The tier-aware default
 * ========================================================================== */

test('the default funnel opens on listing views when the listing tier is READY', async () => {
    _reset();
    const data = await _read();

    assert.deepEqual(data.steps.map((step) => step.key),
        ['views', 'install_clicks', 'installed', 'trial_started', 'trial_converted']);
    assert.equal(data.steps[0].count, 4120);
});

test('the default falls back to Partner-only steps when the listing tier cannot answer', async () => {
    _reset();
    STATE.availability = UNAVAILABLE;

    const data = await _read();
    assert.deepEqual(data.steps.map((step) => step.key), ['installed', 'trial_started', 'trial_converted']);
    assert.notEqual(data.steps[0].count, null,
        'Opening on `views` would make the FIRST step null, which nulls every cumulative rate and the '
        + 'headline behind it — an empty chart on a deployment that is working perfectly.');
    assert.notEqual(data.conversion_rate, null);
    assert.ok(data.warnings.some((line) => line.includes('opens on Partner API steps')));
});

test('an EXPLICITLY requested listing step is kept as null, never silently dropped', async () => {
    _reset();
    STATE.availability = UNAVAILABLE;

    const data = await _read({ events: 'views,installed,trial_started' });
    assert.deepEqual(data.steps.map((step) => step.key), ['views', 'installed', 'trial_started'],
        'Dropping a step the operator chose changes the funnel they built and moves every denominator without saying so.');
    assert.equal(data.steps[0].count, null);
});


/* ==========================================================================
 *  8. The trial block, from this same payload
 * ========================================================================== */

test('trial_cohort and window_kpi are NULL — not {} and not zeros — with no subscription step', async () => {
    _reset();
    const data = await _read({ events: 'views,installed' });

    assert.equal(data.trial_cohort, null,
        'The component guards on truthiness, so `{}` renders four em dashes — four figures presented as '
        + 'unmeasurable when the truth is that nobody asked for them.');
    assert.equal(data.window_kpi, null);
    assert.equal(data.diagnostics.charge_link, null,
        'A zeroed triple would tell the chart there are no subscriptions at all.');
    assert.equal(STATE.cohortQuery, null, 'The cohort read is skipped entirely when nothing needs it.');
});

test('the trial block is folded from the charge cohort, and every count is distinct', async () => {
    _reset();
    const data = await _read({ events: 'installed,trial_started,trial_converted' });

    assert.deepEqual(data.trial_cohort.counts, {
        trial_started: 4,
        still_on_trial: 1,
        trial_converted: 2,
        churned_during_trial: 1,
        churned_after_trial: 1,
        currently_paying: 1,
        decided: 3
    });
    assert.equal(data.trial_cohort.trial_started, 4, 'The flat spelling is what the component reads.');
    assert.equal(data.trial_cohort.still_on_trial, 1);
    assert.equal(data.trial_cohort.trial_converted, 2,
        'Reached paid billing AT ANY POINT — a merchant who converted then left did convert.');
    assert.equal(data.trial_cohort.decided, 3);
    assert.ok(Math.abs(data.trial_cohort.conversion_rate - (2 / 3)) < 1e-9);
});

test('window_kpi counts conversions from ANY cohort, including one that started before the window', async () => {
    _reset();
    const data = await _read({ events: 'trial_started,trial_converted' });

    assert.equal(data.window_kpi.converted_in_window, 3,
        'The July subscription billed in August. A `$gte` on the event pull would drop its START event, '
        + 'so it would never be bucketed and this figure would silently under-count.');
    assert.equal(data.trial_cohort.trial_started, 4, 'It is NOT in this window\'s cohort — different question.');
});

test('the charge-event pull has an upper bound and NO lower bound', async () => {
    _reset();
    await _read({ events: 'trial_started,trial_converted' });

    assert.ok(STATE.cohortQuery, 'The read must have been issued.');
    assert.ok(STATE.cohortQuery.until instanceof Date);
    assert.equal(STATE.cohortQuery.since, undefined,
        'A subscription that converts inside the window may have started at any point before it.');
});

test('trial_converted is rated over DECIDED, excluding the undecided from both sides', async () => {
    _reset();
    const data = await _read({ events: 'trial_started,trial_converted' });
    const converted = _byKey(data).trial_converted;

    assert.equal(converted.rate_basis, 'decided',
        'The chart tests this string EXACTLY and rewrites its whole tooltip on it.');
    assert.equal(converted.rate_denominator, 3, 'Not 4 — the one still inside its trial is excluded.');
    assert.equal(converted.undecided, 1);
    assert.ok(Math.abs(converted.conversion_pct - (2 / 3)) < 1e-9,
        'Counting the undecided as failures would give 2/4 and understate the rate.');
});


/* ==========================================================================
 *  9. The seams, and the numbers they would otherwise fabricate
 * ========================================================================== */

test('the unit seam is marked on the step and gates the banner', async () => {
    _reset();
    const data = await _read();
    const steps = _byKey(data);

    assert.equal(steps.install_clicks.unit_change, false, 'GA4 to GA4 is not a seam.');
    assert.equal(steps.installed.unit_change, true, 'visitor events -> shops.');
    assert.equal(data.crosses_unit_seam, true);
});

test('a population change with no unit change is warned about, because the chart cannot mark it', async () => {
    _reset();
    const data = await _read();
    const steps = _byKey(data);

    assert.equal(steps.trial_started.unit_change, false, 'Both read as `shops` to the chart.');
    assert.equal(steps.trial_started.population_change, true,
        'One counts stores, the other counts subscriptions. A store with two subscriptions is 1 then 2.');
    assert.ok(data.warnings.some((line) => line.includes('count different things')));
});

test('a step converting above 100% publishes drop_pct as null, and says which step', async () => {
    _reset();
    // Six installs against three listing clicks — ordinary in a partial GA4 window, and exactly what
    // the clamp below exists to reduce rather than eliminate.
    STATE.ga4Totals = { ...GA4_TOTALS, install_clicks: 3 };

    const data = await _read({ events: 'install_clicks,installed' });
    const installed = _byKey(data).installed;

    assert.equal(installed.conversion_pct, 2, 'Six shops out of three clicks really is 200%.');
    assert.equal(installed.drop_pct, null, '`1 - 2` is `-1`, and "-100.0% drop-off" renders perfectly and means nothing.');
    assert.ok(data.warnings.some((line) => line.includes('more than 100%')));
});

test('the GA4 window is clamped to the last completed sync, and the clamp is echoed and warned', async () => {
    _reset();
    STATE.app = { ...APP, last_bq_synced_at: _at('2026-08-28T00:00:00.000Z') };

    const data = await _read();
    assert.equal(data.ga4_until, '2026-08-28T00:00:00.000Z');
    assert.equal(data.until, '2026-08-31T23:59:59.999Z',
        'The Partner half still runs to the end of the window — the two halves cover different spans, and that is the point.');
    assert.equal(STATE.ga4Query.date_match.date.$lte.toISOString(), '2026-08-28T00:00:00.000Z',
        'Unclamped, ~28 GA4 days would be compared against 31 event days and every listing-to-install rate would read high.');
    assert.ok(data.warnings.some((line) => line.includes('last completed BigQuery sync')));
});

test('a READY listing tier with no rollup row is UNKNOWN, not zero', async () => {
    _reset();
    STATE.ga4Totals = null;

    const data = await _read();
    const views = _byKey(data).views;

    assert.equal(views.count, null,
        '`$group` emits no document for an empty window. A synced day with genuinely no traffic stores a row of zeros, '
        + 'which arrives as a real 0 — the two must not render alike.');
    assert.equal(views.available, false);
    assert.ok(data.warnings.some((line) => line.includes('no day at all inside this window')));
});


/* ==========================================================================
 *  10. The envelope, the warnings, and the refusals
 * ========================================================================== */

test('the window, the tiers and the catalog are all echoed', async () => {
    _reset();
    const data = await _read();

    assert.equal(data.app_id, 'app-1');
    assert.equal(data.app_name, 'Demo App');
    assert.equal(data.period_label, 'Aug 1, 2026 – Aug 31, 2026');
    assert.equal(data.kind, 'custom');
    assert.equal(data.since, '2026-08-01T00:00:00.000Z');
    assert.equal(data.period_days, null);
    assert.deepEqual(Object.keys(data.tiers).sort(), ['listing', 'partner']);
    assert.equal(data.catalog.length, 28);
    assert.equal(data.items, undefined,
        'dataState.js reads `items === null` as "null the whole payload". There is deliberately no such key here.');
});

test('every warning string is unique, or React drops one of them silently', async () => {
    _reset();
    STATE.availability = UNAVAILABLE;
    STATE.app = { ...APP, event_history_gap_days: 3, lifetime_sync_completed_at: null };
    STATE.partnerShopSets = { ...PARTNER_SHOP_SETS, shopless_events: 4 };

    const data = await _read({ events: 'views,views,installed,trial_started,bogus' });
    assert.ok(data.warnings.length >= 4, 'This fixture trips several conditions at once.');
    assert.equal(new Set(data.warnings).size, data.warnings.length,
        'The chart keys each <p> by the string itself, so a repeat is not drawn twice — it DISAPPEARS, and takes its condition with it.');
    for (const line of data.warnings) {
        assert.equal(typeof line, 'string');
        assert.ok(line.length > 0);
    }
});

test('exclusions the reads made are counted and published rather than absorbed', async () => {
    _reset();
    STATE.partnerShopSets = { ...PARTNER_SHOP_SETS, shopless_events: 7 };

    const data = await _read({ events: 'installed,trial_started' });
    assert.equal(data.diagnostics.shopless_partner_events, 7);
    assert.ok(data.warnings.some((line) => line.includes('no shop domain')),
        'A shop we cannot name is not a shop that did not act.');
    assert.deepEqual(Object.keys(data.diagnostics.charge_link).sort(), ['absent', 'resolved', 'unresolved'],
        'These three are the counts behind the chart\'s own trial-sourcing sentence.');
});

test('the four refusals, and a thrown query that resolves rather than rejecting', async () => {
    _reset();

    const noUser = await getCustomFunnel({ user_id: '' }, WINDOW);
    assert.equal(noUser.status, false);
    assert.deepEqual(noUser.data, {}, 'A failed call carries {} — never a partial payload.');

    const noApp = await getCustomFunnel({ user_id: 'operator-1' }, { partner_app_id: '' });
    assert.equal(noApp.status, false);

    STATE.app = null;
    const missing = await getCustomFunnel({ user_id: 'operator-1' }, WINDOW);
    assert.equal(missing.status, false);
    assert.equal(missing.msg, 'Partner app not found.');

    _reset();
    STATE.appThrows = true;
    const threw = await getCustomFunnel({ user_id: 'operator-1' }, WINDOW);
    assert.equal(threw.status, false, 'Services RESOLVE a failure — they never reject.');
    assert.deepEqual(threw.data, {});
});


/* ==========================================================================
 *  11. The four ways a shipped build still fabricated a number
 *
 *  Every test below pins a defect that was PRESENT in the reviewed build and is
 *  reproducible from a URL. They are grouped because they share one shape: the
 *  payload made a checkable claim about the operator's business that no
 *  measurement supported, and nothing in `warnings[]` said so.
 * ========================================================================== */

test('a prototype-chain key is an UNKNOWN key, not a fabricated zero step', async () => {
    _reset();

    // `FUNNEL_EVENT_BY_KEY` was built with `Object.fromEntries`, so it inherited `Object.prototype`
    // and every `if (!index[key])` guard read `toString` / `valueOf` / `constructor` / `__proto__`
    // as REAL catalog entries.
    assert.notEqual(Object.getPrototypeOf(funnelConstants.FUNNEL_EVENT_BY_KEY), Object.prototype,
        'A prototype-bearing index answers a truthy value for five keys no catalog contains.');
    for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
        assert.equal(funnelConstants.FUNNEL_EVENT_BY_KEY[key], undefined,
            `\`${key}\` is not a funnel step, and a lookup that says otherwise mints a bar for it.`);
    }

    const data = await _read({ events: 'installed,toString,valueOf' });

    assert.equal(data.steps.length, 1,
        'Two shapeless entries fell through every `entry.source` test to the unlabelled `// transaction` '
        + 'default, which minted `count: 0, available: true` for a step with no key, label or unit.');
    assert.deepEqual(data.steps.map((step) => step.key), ['installed']);
    assert.deepEqual(data.events, ['installed'],
        'The page persists this array to localStorage. `["installed", null, null]` destroyed the saved funnel.');
    assert.equal(data.conversion_rate, null,
        'The fabricated final step made the headline `0`, which renders as "0.00%" under "Conversion rate".');
    assert.equal(data.crosses_unit_seam, false, 'A step with `unit: undefined` is not a measurement seam.');

    const named = data.warnings.find((line) => line.includes('not in this build'));
    assert.ok(named, 'Trap 9 again: a silent rewrite the operator cannot see is a rewrite they cannot undo.');
    assert.ok(named.includes('toString') && named.includes('valueOf'), 'Both refused keys must be named.');
    assert.deepEqual(data.diagnostics.unknown_event_keys, ['toString', 'valueOf'],
        'The diagnostics and the warning must not disagree about what was refused.');
});

test('the selection helper rejects prototype keys before the service ever sees them', () => {
    const resolved = resolveRequestedEvents({
        requested: 'installed,toString,__proto__,hasOwnProperty',
        fallback_keys: ['installed']
    });

    assert.deepEqual(resolved.keys, ['installed']);
    assert.deepEqual(resolved.unknown, ['toString', '__proto__', 'hasOwnProperty']);
    assert.equal(resolved.used_fallback, false, 'One real key is a real selection; the fallback must not fire.');
});

test('a one-step funnel publishes conversion_rate NULL, not the 1 that renders "100.00%"', async () => {
    _reset();

    for (const events of ['installed', 'views', 'installed,instaled']) {
        const data = await _read({ events });
        assert.equal(data.steps.length, 1);
        assert.equal(data.steps[0].cumulative_conversion_pct, 1,
            'Step 0 measures against ITSELF, and `rate(c, c)` is 1 — that part is the uniform rule.');
        assert.equal(data.conversion_rate, null,
            'The chart drops its "A → B" caption below two steps but renders the headline unconditionally, '
            + 'so `1` reached the operator as a bare, perfect, meaningless "100.00%" — under a payload whose '
            + 'own warning says there is no conversion to compute between fewer than two steps.');
        assert.ok(data.warnings.some((line) => line.includes('at least 2 steps')));
    }
});

test('`first_transaction` warns whenever the stored payout history cannot support "first ever"', async () => {
    // The one coverage failure on this endpoint that runs UPWARD. `$min(created_at)` is taken over
    // STORED history, so on an incrementally-synced deployment every long-standing payer's earliest
    // STORED payout sits at the start of what was pulled and is counted as a first payout.
    _reset();
    STATE.firstTransactionShops = 42;
    STATE.app = { ...APP, earliest_transaction_at: _at('2026-08-20T00:00:00.000Z'), lifetime_sync_completed_at: null };

    const data = await _read({ events: 'installed,first_transaction' });
    assert.equal(_byKey(data).first_transaction.count, 42);

    // ⚠️ Matched on the sentence, not on the step label: 42 first payouts against 6 installs also
    // fires `dropRateSuppressed`, which names the same step and would satisfy a looser find().
    const warning = data.warnings.find((line) => line.includes('EARLIEST STORED payout'));
    assert.ok(warning, 'This shipped with `warnings` matching /FLOOR|lifetime|earliest/ completely EMPTY.');
    assert.ok(warning.includes('2026-08-20T00:00:00.000Z'), 'The floor itself must be quoted, not merely alluded to.');
    assert.ok(warning.includes('No lifetime Partner sync'), 'Both failing gates hold here and both must be named.');
    assert.ok(warning.includes('UPWARD'),
        'Every other floor on this endpoint makes a number too small. Saying so is the whole point.');
    assert.equal(data.diagnostics.earliest_transaction_at, '2026-08-20T00:00:00.000Z',
        'Published so the claim can be checked rather than taken on the warning\'s word.');
});

test('a never-measured payout floor warns too, and a complete history is silent', async () => {
    _reset();
    STATE.app = { ...APP, earliest_transaction_at: null, lifetime_sync_completed_at: null };
    const unmeasured = await _read({ events: 'installed,first_transaction' });
    assert.ok(unmeasured.warnings.some((line) => line.includes('No payout coverage floor has ever been measured')),
        '`null` is NOT YET MEASURED — the weakest of the three states, and it must not read as "no floor".');
    assert.equal(unmeasured.diagnostics.earliest_transaction_at, null);

    _reset();
    STATE.app = {
        ...APP,
        earliest_transaction_at: _at('2024-01-01T00:00:00.000Z'),
        lifetime_sync_completed_at: _at('2026-09-01T00:00:00.000Z')
    };
    const covered = await _read({ events: 'installed,first_transaction' });
    assert.ok(!covered.warnings.some((line) => line.includes('EARLIEST STORED payout')),
        'A completed lifetime sync with a floor below the window IS the evidence the claim needs. '
        + 'A warning that fires on healthy data is how a warning stops being read.');

    _reset();
    const noTransactionStep = await _read();
    assert.ok(!noTransactionStep.warnings.some((line) => line.includes('payout')),
        'No payout step selected, no payout caveat — the operator is not owed a gate they never crossed.');
});

test('a windowed payout step is floored by the money gate, which is NOT the event gate', async () => {
    _reset();
    STATE.transactionShopSets = [{ type: 'APP_USAGE', shops: ['a.myshopify.com', 'b.myshopify.com'] }];
    // ⚠️ `earliest_event_at` is 2024 on the fixture, so the EVENT side is fully covered here. The two
    // floors are tracked apart precisely so a payout figure cannot borrow the events' coverage —
    // `models/partner/partnerApp.model.ts:122` says so outright.
    STATE.app = { ...APP, earliest_transaction_at: _at('2026-08-15T00:00:00.000Z') };

    const data = await _read({ events: 'installed,usage_billed' });
    assert.equal(_byKey(data).usage_billed.count, 2);
    assert.ok(data.warnings.some((line) => line.includes('stored payout history for this app begins at 2026-08-15')));
    assert.ok(!data.warnings.some((line) => line.includes('earliest Partner event')),
        'The event floor is below this window and must stay quiet — the two gates are independent.');
});

test('a population change is marked even when the unit changes with it, and names both populations', async () => {
    _reset();
    // The `*` the chart draws for a unit change is captioned "Partner API steps are distinct shops",
    // and this right-hand step counts SUBSCRIPTIONS. Suppressing the population warning here left the
    // reader with one marker that named the wrong population and nothing to correct it.
    const data = await _read({ events: 'install_clicks,trial_started' });
    const steps = _byKey(data);

    assert.equal(steps.trial_started.unit_change, true, 'events -> shops.');
    assert.equal(steps.trial_started.population_change, true,
        'visitors -> subscriptions. This published `false` because the unit had changed too.');

    const seam = data.warnings.find((line) => line.includes('count different things'));
    assert.ok(seam, 'Any funnel jumping a listing step straight to a subscription step lost this entirely.');
    assert.ok(seam.includes('listing visitors') && seam.includes('subscriptions'),
        'A bare "A → B" leaves the reader to guess which side changed and into what.');
});

test('diagnostics.charge_link describes the WINDOW cohort, not every subscription on record', async () => {
    _reset();
    // Two subscriptions that started well before the window. The cohort pull is app-wide and
    // unbounded below by design — `window_kpi` must see a conversion whose trial started earlier —
    // so the resolver's own triple counts them. The chart prints "for R of T subscriptions" directly
    // beneath the WINDOW cohort block, where a lifetime T is a different population from the one
    // above it.
    STATE.cohortEvents = [
        ...COHORT_EVENTS,
        {
            event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
            shop_domain: 'ancient1.myshopify.com',
            charge_id: '901',
            occurred_at: _at('2025-01-05T10:00:00.000Z'),
            raw_event: { charge: { id: 'gid://shopify/AppSubscription/901', name: 'Pro', billingOn: '2025-01-12', test: false, amount: { amount: '29.00', currencyCode: 'USD' } } }
        },
        {
            event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
            shop_domain: 'ancient2.myshopify.com',
            charge_id: '902',
            occurred_at: _at('2025-02-05T10:00:00.000Z'),
            raw_event: { charge: { id: 'gid://shopify/AppSubscription/902', name: 'Pro', billingOn: '2025-02-12', test: false, amount: { amount: '29.00', currencyCode: 'USD' } } }
        }
    ];

    const data = await _read({ events: 'installed,trial_started' });
    const link = data.diagnostics.charge_link;
    const total = link.resolved + link.unresolved + link.absent;

    assert.equal(data.trial_cohort.trial_started, 4, 'Four trials started inside this window; two started in 2025.');
    assert.equal(total, 4,
        'The trial-sourcing sentence captions the block above it. An all-time total there reads as the '
        + 'cohort\'s own size and is wrong by the app\'s whole history.');
    assert.deepEqual(Object.keys(link).sort(), ['absent', 'resolved', 'unresolved']);
});

test('a listing watermark BEHIND the window issues no query and gives the real reason', async () => {
    _reset();
    STATE.app = { ...APP, last_bq_synced_at: _at('2026-06-01T00:00:00.000Z') };
    STATE.ga4Query = 'NOT-ISSUED';

    const data = await _read({ events: 'views,installed' });
    const views = _byKey(data).views;

    assert.equal(STATE.ga4Query, 'NOT-ISSUED',
        'The clamp built `{ $gte: 2026-08-01, $lte: 2026-06-01 }` — an inverted range that matched nothing.');
    assert.equal(views.count, null, 'The outcome was always honest; only the explanation was wrong.');
    assert.ok(views.unknown_reason.includes('has not synced up to the start of this window'));
    assert.ok(data.warnings.some((line) => line.includes('before this window opens')));
    assert.ok(!data.warnings.some((line) => line.includes('holds no day at all')),
        '"The rollup holds no day at all inside this window" says the days do not exist. They may well '
        + 'exist and simply not be synced yet, and those are different things to go and fix.');
    assert.equal(data.ga4_until, '2026-06-01T00:00:00.000Z',
        'Echoed even though it precedes `since` — that IS the fact, and no query was built from it.');
});

test('the GA4 clamp warning states the residual instead of claiming a repair', async () => {
    _reset();
    STATE.app = { ...APP, last_bq_synced_at: _at('2026-08-28T00:00:00.000Z') };

    const data = await _read();
    const clamp = data.warnings.find((line) => line.includes('last completed BigQuery sync'));

    assert.ok(clamp);
    assert.ok(!clamp.includes('without this clamp'),
        'The rollup dates rows at UTC midnight and no sync writes a day later than itself, so this bound '
        + 'removes essentially nothing. Claiming it corrected the arithmetic retires a question the reader '
        + 'should still be asking.');
    assert.ok(clamp.includes('guard rather than a repair') && clamp.includes('HIGH'),
        'The residual and its DIRECTION are the two things a reader needs and cannot derive.');
});
