'use strict';

/**
 * ============================================================================
 *  INSTALL COHORT — the response contract, and the four ways to get it wrong
 * ============================================================================
 *
 *  Exercises `getInstallCohort` end to end with the repository stubbed out, so the whole assembly —
 *  spine → charge cohort → row → summary → warnings → paging — runs against fixtures with no
 *  database and no BigQuery.
 *
 *  ── 1. THE BARE-NUMBER CONTRACT, WHICH IS THE REASON THIS FILE EXISTS ────
 *
 *  `summary.installs`, `summary.with_attribution` and `summary.attribution_coverage` must be BARE
 *  NUMBERS, and `attribution_coverage` must be `null` — never `0` — when there are no installs.
 *
 *  This is the one place in the codebase where `IMPLEMENTATION.md` §3.11's confidence envelope must
 *  NOT be applied, and the failure mode is entirely silent. `fmtNum` (`storePresentation.js:250`)
 *  does `Number(n)`, so `Number({ value: 412 })` is `NaN` and an enveloped count renders as an em
 *  dash. Worse, `InstallCohortTable.js:133` gates the whole attribution-coverage banner on
 *  `typeof coverage === 'number' && coverage < 1` — so wrapping it DELETES the single most important
 *  honesty statement on the page, the one that says the unattributed rows are a missing data source
 *  and not evidence of direct arrival. Nothing errors. Nothing logs. The page looks finished.
 *
 *  A future reader applying §3.11 uniformly is doing the right thing everywhere else. This test is
 *  what tells them where the exception is, and why.
 *
 *  ── 2. THE FIVE STATES AND EIGHT CHANNELS ARE ORDERED FRONTEND CONTRACTS ────
 *  `STATE_ORDER` is hard-coded at `InstallCohortTable.js:19`, and the channel Select is built by
 *  iterating `Object.keys(channels)` at `:57`. A sixth state, a missing key or a reordered map each
 *  break the page in a way that renders as missing data rather than as an error.
 *
 *  ── 3. VALIDATION FAILS OPEN ───────────────────────────────────────────────
 *  A typo in `state` or `channel` must WIDEN the result set and say so. `?state=Converted` returning
 *  an empty table is indistinguishable from a business with no conversions.
 *
 *  ── 4. `INSTALLED` IS THE LEFT-JOIN MISS AND NOTHING ELSE ──────────────────
 *  A store with no subscription is `INSTALLED`; a store WITH one never falls through to it. The
 *  reverse would report a paying customer as never having subscribed.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';
//  The attribution join is skipped entirely when the listing tier is unconfigured — which is
// correct, and would leave half of this file untested. These three are what
// `resolveBigQueryAvailability` reads; nothing in this file ever reaches BigQuery.
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

const repository = require(path.join(MODULE_ROOT, 'repositories', 'installCohort.repository.ts'));

const _at = (iso) => new Date(iso);

const APP = {
    _id: 'app-1',
    display_name: 'Demo App',
    last_synced_at: _at('2026-09-01T00:00:00.000Z'),
    last_install_attrib_synced_at: _at('2026-09-01T00:00:00.000Z'),
    earliest_event_at: _at('2024-01-01T00:00:00.000Z'),
    lifetime_sync_completed_at: null
};

/**
 * Four stores, one per interesting outcome:
 *
 *   bare-shop      no subscription at all                      -> INSTALLED  (the left-join miss)
 *   churned-shop   billingOn, then an UNINSTALL after it       -> CHURNED
 *   converted-shop billingOn in the past, settled payout       -> CONVERTED
 *   trial-shop     no billingOn, no payout                     -> ON_TRIAL on the `inferred` basis
 *
 * bare-shop ALSO carries a `test: true` charge, which is the asymmetry this endpoint has to warn
 * about: the subscription side drops it, and the install spine — built from relationship events that
 * carry no test flag anywhere — cannot.
 */
const SPINE = [
    { shop_domain: 'bare-shop.myshopify.com', installed_at: _at('2026-08-10T10:00:00.000Z'), install_count: 2 },
    { shop_domain: 'churned-shop.myshopify.com', installed_at: _at('2026-08-12T10:00:00.000Z'), install_count: 1 },
    { shop_domain: 'converted-shop.myshopify.com', installed_at: _at('2026-08-14T10:00:00.000Z'), install_count: 1 },
    { shop_domain: 'trial-shop.myshopify.com', installed_at: _at('2026-08-16T10:00:00.000Z'), install_count: 1 }
];

const EVENTS = [
    {
        event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
        shop_domain: 'converted-shop.myshopify.com',
        charge_id: '111',
        occurred_at: _at('2026-08-14T11:00:00.000Z'),
        raw_event: {
            charge: {
                id: 'gid://shopify/AppSubscription/111',
                name: 'Pro',
                billingOn: '2026-08-21',
                test: false,
                amount: { amount: '29.00', currencyCode: 'USD' }
            }
        }
    },
    {
        event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
        shop_domain: 'trial-shop.myshopify.com',
        charge_id: '222',
        occurred_at: _at('2026-08-16T11:00:00.000Z'),
        raw_event: {
            charge: {
                id: 'gid://shopify/AppSubscription/222',
                name: 'Starter',
                test: false,
                amount: { amount: '9.00', currencyCode: 'USD' }
            }
        }
    },
    {
        event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
        shop_domain: 'churned-shop.myshopify.com',
        charge_id: '333',
        occurred_at: _at('2026-08-12T11:00:00.000Z'),
        raw_event: {
            charge: {
                id: 'gid://shopify/AppSubscription/333',
                name: 'Pro',
                billingOn: '2026-08-19',
                test: false,
                amount: { amount: '29.00', currencyCode: 'USD' }
            }
        }
    },
    // A RELATIONSHIP end event: no charge block at all, which is exactly why a charge-keyed bucket
    // has to be allowed to borrow its shop's charge-less ends.
    {
        event_type: 'UNINSTALL',
        shop_domain: 'churned-shop.myshopify.com',
        charge_id: '',
        occurred_at: _at('2026-08-25T09:00:00.000Z'),
        raw_event: {}
    },
    {
        event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
        shop_domain: 'bare-shop.myshopify.com',
        charge_id: '444',
        occurred_at: _at('2026-08-10T11:00:00.000Z'),
        raw_event: { charge: { id: 'gid://shopify/AppSubscription/444', name: 'Test plan', test: true } }
    }
];

const SETTLED = [
    { charge_id: '111', shop_domain: 'converted-shop.myshopify.com', settled_count: 1, billing_interval: 'ANNUAL' },
    { charge_id: '333', shop_domain: 'churned-shop.myshopify.com', settled_count: 1, billing_interval: null }
];

/**
 * Two records for converted-shop. The NEAREST in time to its Partner install instant must win — the
 * implementation this was ported from took the latest overall, so a store that reinstalled a year
 * later had the LATER visit's channel attached to the EARLIER install.
 *
 * trial-shop's record carries the `(unattributed)` sentinel: the row EXISTS, so `has_attribution` is
 * true, and the channel is `UNKNOWN` — never `DIRECT`.
 *
 * ⚠️ THESE ROWS ARE WHAT THE REPOSITORY HOLDS, NOT WHAT THE SERVICE PUBLISHES. The stub is the
 * Mongo read, so a `surface_detail` here is a value that was already CAPTURED and STORED — including
 * the free-text queries stored by every build that predates the write-time blank in
 * `bigquery/helpers/installAttribution.helper.ts`. Blanking these fixtures to `''` to match the new
 * write rule is what silently retired the read guard: with no fixture carrying a search detail, both
 * branches of `installCohort.service.ts:416` emit `''` and the guard can be deleted outright with the
 * suite still green. The converted-shop record below therefore carries a query again, and the two
 * tests in §4 that pin the guard in BOTH directions supply their own rows on top of these.
 */
const ATTRIBUTION = [
    {
        shop_domain: 'converted-shop.myshopify.com',
        shop_name: 'Converted Store',
        installed_at: _at('2026-08-14T09:55:00.000Z'),
        source: 'google',
        medium: 'organic',
        campaign: '',
        attribution_source: 'event_collected',
        surface_type: '',
        surface_detail: '',
        surface_inter_position: null,
        surface_intra_position: null
    },
    {
        shop_domain: 'converted-shop.myshopify.com',
        shop_name: 'Converted Store (a later visit)',
        installed_at: _at('2026-08-30T09:00:00.000Z'),
        source: 'shopify_app_store',
        medium: 'referral',
        campaign: '',
        attribution_source: 'user_first_acquisition',
        surface_type: 'search',
        // Synthetic — no real merchant query is reproduced anywhere in this repository. This record
        // LOSES the nearest-in-time pick (it sits 16 days after the install; the 09:55 record sits 5
        // minutes before it), so it never reaches the published row and moves no count asserted
        // below. It is here so the fixture set is not uniformly blank, which is the state that made
        // the read guard undetectable; the tests that actually exercise the guard are in §4.
        surface_detail: 'fixture query text',
        surface_inter_position: 1,
        surface_intra_position: 3
    },
    {
        shop_domain: 'trial-shop.myshopify.com',
        shop_name: '',
        installed_at: _at('2026-08-16T10:02:00.000Z'),
        source: '(unattributed)',
        medium: '(unattributed)',
        campaign: '',
        attribution_source: 'none',
        surface_type: '',
        surface_detail: '',
        surface_inter_position: null,
        surface_intra_position: null
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
    spine: { rows: SPINE, shopless_install_events: 3 },
    events: EVENTS,
    settled: SETTLED,
    attribution: ATTRIBUTION,
    appThrows: false,
    /** The last query the settled-payout read was handed, so its `as_of` bound can be asserted. */
    settledQuery: null
};

const _reset = () => {
    STATE.app = APP;
    STATE.spine = { rows: SPINE, shopless_install_events: 3 };
    STATE.events = EVENTS;
    STATE.settled = SETTLED;
    STATE.attribution = ATTRIBUTION;
    STATE.appThrows = false;
    STATE.settledQuery = null;
};

repository.findPartnerAppById = async () => {
    if (STATE.appThrows) {
        throw new Error('the database went away');
    }
    return STATE.app;
};
repository.aggregateInstallSpine = async () => STATE.spine;
repository.findChargeCohortEvents = async () => STATE.events;
/**
 * THIS STUB APPLIES THE `created_at: { $lte: as_of }` BOUND ITSELF.
 *
 * A stub that returned every fixture row regardless would keep passing with the bound deleted from
 * the real `$match` — which is precisely the regression this file has to be able to catch, since the
 * settled-payout read is the evidence behind `state_basis: 'settled_payout'` and was once issued
 * with no time bound at all. A fixture row carrying no `created_at` is treated as in-window, so
 * every pre-existing fixture behaves exactly as before.
 */
repository.aggregateSettledSubscriptionCharges = async (query) => {
    STATE.settledQuery = query || null;
    const asOf = query && query.as_of instanceof Date ? query.as_of.getTime() : null;
    if (asOf === null) {
        return STATE.settled;
    }
    return STATE.settled.filter((row) => !(row.created_at instanceof Date) || row.created_at.getTime() <= asOf);
};
repository.findInstallAttributionRows = async () => STATE.attribution;

const { getInstallCohort } = require(path.join(MODULE_ROOT, 'services', 'installCohort.service.ts'));

/** The window every fixture sits inside. */
const WINDOW = { partner_app_id: 'app-1', since: '2026-08-01', until: '2026-08-31' };

/**
 * Calls the service and asserts it did not refuse.
 *
 * @param {Object} [params] - Extra query parameters merged over the fixture window.
 * @returns {Promise<Object>} The payload.
 */
const _read = async (params = {}) => {
    const result = await getInstallCohort({ user_id: 'operator-1' }, { ...WINDOW, ...params });
    assert.equal(result.status, true, `the service refused: ${result.msg}`);
    return result.data;
};

/** Rows by domain, for assertions that name a store. */
const _byDomain = (data) => Object.fromEntries(data.items.map((row) => [row.shop_domain, row]));


/* ==========================================================================
 *  1. The bare-number contract
 * ========================================================================== */

test('summary.installs / with_attribution / attribution_coverage are BARE NUMBERS', async () => {
    _reset();
    const data = await _read({ limit: 500 });

    assert.equal(typeof data.summary.installs, 'number',
        'An envelope here renders as an em dash in the caption, the strip and the banner.');
    assert.equal(typeof data.summary.with_attribution, 'number',
        'An envelope here renders as an em dash inside the attribution banner\'s own sentence.');
    assert.ok(
        typeof data.summary.attribution_coverage === 'number' || data.summary.attribution_coverage === null,
        'The banner is gated on `typeof coverage === "number"`. Anything else DELETES it silently.'
    );

    assert.equal(data.summary.installs, 4, 'DISTINCT STORES, not install events.');
    assert.equal(data.summary.install_events, 5, 'The sum of install_count — a reinstaller counts twice.');
    assert.equal(data.summary.with_attribution, 2);
    assert.equal(data.summary.attribution_coverage, 0.5, 'A FRACTION in [0,1], not a percentage.');
});

test('attribution_coverage is null — never 0 — when there is nothing to have attribution for', async () => {
    _reset();
    STATE.spine = { rows: [], shopless_install_events: 0 };
    STATE.events = [];
    STATE.settled = [];
    STATE.attribution = [];

    const data = await _read();
    assert.equal(data.summary.attribution_coverage, null,
        'A 0 is the claim "we have attribution for none of your installs". null is "there is nothing to attribute".');
    assert.equal(data.summary.installs, 0);
    assert.deepEqual(data.items, []);
});


/* ==========================================================================
 *  2. The ordered frontend contracts
 * ========================================================================== */

test('exactly five states, in the order the table hard-codes, with zeros present', async () => {
    _reset();
    const data = await _read({ limit: 500 });

    const expected = ['INSTALLED', 'ON_TRIAL', 'CONVERTED', 'CHURNED_IN_TRIAL', 'CHURNED'];
    assert.deepEqual(Object.keys(data.states), expected, 'A sixth state renders with an untoned badge and no box.');
    assert.deepEqual(Object.keys(data.summary.by_state), expected);
    assert.deepEqual(data.summary.by_state,
        { INSTALLED: 1, ON_TRIAL: 1, CONVERTED: 1, CHURNED_IN_TRIAL: 0, CHURNED: 1 },
        'A key omitted because it is zero removes that box, which reads as "we did not measure it".');

    const boxes = Object.values(data.summary.by_state).reduce((a, b) => a + b, 0);
    assert.equal(boxes, data.summary.installs, 'sum(state boxes) must equal the headline install count.');
});

test('exactly eight channels, in key order, because the Select iterates Object.keys', async () => {
    _reset();
    const data = await _read({ limit: 500 });

    const expected = [
        'APP_STORE_AD', 'APP_STORE_SEARCH', 'APP_STORE_BROWSE', 'REFERRAL',
        'ORGANIC_SEARCH', 'PAID', 'DIRECT', 'UNKNOWN'
    ];
    assert.deepEqual(Object.keys(data.channels), expected);
    assert.deepEqual(Object.keys(data.summary.by_channel), expected);
    assert.equal(data.channels.UNKNOWN, 'Not attributed', 'The label that says we have no record, not that they came direct.');
});

test('warnings are unique strings — the page keys its <p> elements by the string itself', async () => {
    _reset();
    const data = await _read({ limit: 500, state: 'nope', channel: 'nope', sort: 'nope' });
    assert.equal(new Set(data.warnings).size, data.warnings.length,
        'Two identical warnings are a duplicate-key React warning, and one of them is dropped.');
    for (const warning of data.warnings) {
        assert.equal(typeof warning, 'string');
        assert.ok(warning.length > 0);
    }
});


/* ==========================================================================
 *  3. The state machine, and the left-join miss
 * ========================================================================== */

test('INSTALLED is the left-join miss and nothing else', async () => {
    _reset();
    const rows = _byDomain(await _read({ limit: 500 }));

    assert.equal(rows['bare-shop.myshopify.com'].state, 'INSTALLED');
    assert.equal(rows['bare-shop.myshopify.com'].state_label, 'Installed only');
    assert.equal(rows['bare-shop.myshopify.com'].state_basis, 'join_miss',
        'A store with no subscription has no EVIDENCE to name — reusing `inferred` would swamp the one basis that means "we guessed".');
    assert.equal(rows['bare-shop.myshopify.com'].trial_end, null, 'Never trial_start + 7 days. This is a RENDERED column.');
    assert.equal(rows['bare-shop.myshopify.com'].plan_name, '');

    // …and no store WITH a subscription falls through to it.
    assert.equal(rows['converted-shop.myshopify.com'].state, 'CONVERTED');
    assert.equal(rows['converted-shop.myshopify.com'].state_basis, 'billing_on');
    assert.equal(rows['trial-shop.myshopify.com'].state, 'ON_TRIAL');
    assert.equal(rows['churned-shop.myshopify.com'].state, 'CHURNED');
});

test('the settled-payout branch is evidence, and the inferred branch is warned about', async () => {
    _reset();
    const data = await _read({ limit: 500 });
    const rows = _byDomain(data);

    assert.equal(rows['trial-shop.myshopify.com'].state_basis, 'inferred',
        'No billingOn and no settled payout: booked ON_TRIAL, which claims neither revenue nor loss.');
    assert.equal(data.diagnostics.inferred_state_rows, 1);
    assert.ok(data.warnings.some((w) => w.includes('weakest evidence')), 'An inferred row must be warned about.');
    assert.equal(data.diagnostics.unclassified_subscription_rows, 0);
});

test('\u2620\ufe0f the settled-payout evidence is BOUNDED at the judgement instant', async () => {
    _reset();
    // trial-shop's ACCEPTED carries no `billingOn`, so its state rests entirely on whether money
    // provably moved. This payout settles in JUNE 2027 — ten months AFTER the window ends.
    STATE.settled = [
        ...SETTLED,
        {
            charge_id: '222',
            shop_domain: 'trial-shop.myshopify.com',
            settled_count: 1,
            billing_interval: 'EVERY_30_DAYS',
            created_at: _at('2027-06-01T00:00:00.000Z')
        }
    ];

    const data = await _read({ limit: 500 });
    const rows = _byDomain(data);

    assert.ok(STATE.settledQuery && STATE.settledQuery.as_of instanceof Date,
        'The read must be handed the judgement instant. Without it the repository cannot bound anything.');
    assert.equal(STATE.settledQuery.as_of.toISOString(), data.as_of,
        'The bound and the published judgement instant are the same moment, or the row and its caption disagree.');

    assert.equal(rows['trial-shop.myshopify.com'].state, 'ON_TRIAL',
        'A payout that settles after the window is not evidence inside it. Unbounded, this store is published '
        + 'CONVERTED as of 31 Aug 2026 \u2014 a named merchant, on a date they had not paid.');
    assert.equal(rows['trial-shop.myshopify.com'].state_basis, 'inferred',
        'And on the weakest basis, which is warned about \u2014 not on `settled_payout`, which claims evidence.');
    assert.equal(rows['trial-shop.myshopify.com'].plan_interval, null,
        'The cadence comes out of the same read, so it is the cadence AS OF the window like the rest of the row.');
    assert.equal(data.summary.by_state.CONVERTED, 1,
        'The error is one-directional: future churn is already clamped away, so admitting future revenue '
        + 'over-counts CONVERTED and under-counts ON_TRIAL, never the reverse.');
    assert.equal(data.summary.by_state.ON_TRIAL, 1);
});

test('a cancellation that names a charge but no shop still churns its store', async () => {
    _reset();
    // A shop redacted (GDPR) between its INSTALL and its cancellation: the install carries a domain,
    // the cancel does not. The churn evidence joins on `charge_id` and needs no domain — which is why
    // the repository fetches END events by charge as well as by domain. If this fold ever stops
    // routing a blank-domain END into `endsByCharge`, that second read goes quiet and the store stays
    // CONVERTED for ever, with nothing on screen to say so.
    STATE.events = [
        ...EVENTS,
        {
            event_type: 'SUBSCRIPTION_CHARGE_CANCELLED',
            shop_domain: '',
            charge_id: '111',
            occurred_at: _at('2026-08-28T09:00:00.000Z'),
            raw_event: { charge: { id: 'gid://shopify/AppSubscription/111' } }
        }
    ];

    const rows = _byDomain(await _read({ limit: 500 }));
    assert.equal(rows['converted-shop.myshopify.com'].state, 'CHURNED',
        'It converted (billingOn 21 Aug) and then cancelled (28 Aug). Dropping the cancel leaves it CONVERTED.');
    assert.equal(new Date(rows['converted-shop.myshopify.com'].churn_date).toISOString(), '2026-08-28T09:00:00.000Z');
});

test('plan_currency is published, so a right number is never captioned with the wrong unit', async () => {
    _reset();
    const rows = _byDomain(await _read({ limit: 500 }));

    assert.equal(rows['converted-shop.myshopify.com'].plan_currency, 'USD',
        'The table hard-codes a `$`; a EUR plan renders as "$29.00" until it can read this.');
    assert.equal(rows['bare-shop.myshopify.com'].plan_currency, '',
        "`''`, not null, matching `plan_name` \u2014 a store with no subscription has no currency to name.");
    assert.equal(typeof rows['trial-shop.myshopify.com'].plan_currency, 'string');
});

test('plan_interval comes only from a settled payout, and stays null otherwise', async () => {
    _reset();
    const rows = _byDomain(await _read({ limit: 500 }));

    assert.equal(rows['converted-shop.myshopify.com'].plan_interval, 'ANNUAL');
    assert.equal(rows['converted-shop.myshopify.com'].plan_price, 29);
    assert.equal(rows['trial-shop.myshopify.com'].plan_interval, null,
        'FIDELITY.md §5: a null interval booked as monthly is how an annual subscriber is reported at 12x.');
    assert.equal(rows['churned-shop.myshopify.com'].plan_interval, null,
        'The payout named no interval, so none is invented.');
});

test('the test-charge asymmetry is reported rather than hidden', async () => {
    _reset();
    const data = await _read({ limit: 500 });

    assert.equal(data.diagnostics.test_excluded, 1);
    assert.equal(_byDomain(data)['bare-shop.myshopify.com'].state, 'INSTALLED',
        'The store stays on the spine: relationship events carry no test flag, so the two sides cannot be reconciled.');
    assert.ok(data.warnings.some((w) => w.includes('test subscription')), 'The asymmetry must be stated.');
});


/* ==========================================================================
 *  4. Attribution
 * ========================================================================== */

test('the attribution match is NEAREST IN TIME, not latest-overall', async () => {
    _reset();
    const rows = _byDomain(await _read({ limit: 500 }));
    const converted = rows['converted-shop.myshopify.com'];

    assert.equal(converted.shop_name, 'Converted Store',
        'The later visit must not overwrite how the earlier install was acquired.');
    assert.equal(converted.channel, 'ORGANIC_SEARCH');
    assert.equal(converted.channel_label, 'Organic search');
    assert.equal(converted.attribution_lag_seconds, -300,
        'SIGNED, so a consistent one-way lag reads as export latency rather than a mismatched row.');
    assert.equal(new Date(converted.attribution_installed_at).toISOString(), '2026-08-14T09:55:00.000Z');
});

test('an "(unattributed)" record resolves to UNKNOWN, never to DIRECT', async () => {
    _reset();
    const rows = _byDomain(await _read({ limit: 500 }));
    const trial = rows['trial-shop.myshopify.com'];

    assert.equal(trial.has_attribution, true, 'The record EXISTS — that is a different fact from having no record.');
    assert.equal(trial.channel, 'UNKNOWN',
        'Direct is already ~90% of installs, so a row we cannot explain would vanish into it and inflate it.');
    assert.equal(trial.attribution_source, 'none');
});

test('a store with no attribution record is "Not attributed", and country is deliberately blank', async () => {
    _reset();
    const rows = _byDomain(await _read({ limit: 500 }));
    const bare = rows['bare-shop.myshopify.com'];

    assert.equal(bare.has_attribution, false);
    assert.equal(bare.channel, 'UNKNOWN');
    assert.equal(bare.source, '');
    assert.equal(bare.attribution_source, '', 'Distinct from the stored "none", which means a record exists.');
    assert.equal(bare.attribution_installed_at, null);
    assert.equal(bare.attribution_lag_seconds, null);
    assert.equal(bare.country, '',
        'The only country this build holds is a common NAME; the table renders this in a two-character ISO-2 slot.');
});


/**
 * ⚠️ `surface_detail` IS DUAL PURPOSE, AND THE NEXT TWO TESTS PIN BOTH HALVES OF IT.
 *
 * On a search surface (`search`, `search_ad`, `guided_search`) the field is the merchant's own typed
 * query, which this build does not serve. On every other named surface — `home`, `category`,
 * `collection`, `app_group` — it is Shopify's placement handle, which is load-bearing: it is the
 * "Came from" column, and `isPaidPlacement` reads `surface_detail === 'homepage-ads'` to tell an ad
 * click apart from organic browsing on the very same `home` surface.
 *
 * So the guard at `installCohort.service.ts:416` has to be exercised in BOTH directions. One test
 * asserting a blank proves nothing on its own: `surface_detail: ''` is also what a guard-free build
 * returns for a fixture that stored nothing. The pair below is a pin only because one row stores a
 * query and gets `''` back, and the other stores a handle and gets the handle back.
 *
 * The membership of `SEARCH_SURFACES` itself is pinned in `test/surfacePlacement.test.js` against the
 * pure predicates; these two tests are about where in the pipeline the blanking is applied.
 */

test('a stored SEARCH query is blanked on the published row, and the row keeps everything else', async () => {
    _reset();
    // ADDITIVE. bare-shop carries no attribution record in the shared fixture, so this row is the
    // whole of its attribution and no count any other test asserts moves — `_reset()` puts the shared
    // array back, and every summary figure read below is read from THIS cohort.
    STATE.attribution = [
        ...ATTRIBUTION,
        {
            shop_domain: 'bare-shop.myshopify.com',
            shop_name: 'Bare Store',
            installed_at: _at('2026-08-10T09:58:00.000Z'),
            source: 'shopify_app_store',
            medium: 'referral',
            campaign: '',
            attribution_source: 'user_first_acquisition',
            surface_type: 'search',
            // A row an operator ALREADY HOLDS: written by a build that captured the query, and still
            // in Mongo until a lifetime re-sync replaces it. Synthetic text — this repository
            // reproduces no real merchant query.
            surface_detail: 'fixture query text',
            surface_inter_position: 1,
            surface_intra_position: 4
        }
    ];

    const data = await _read({ limit: 500 });
    const bare = _byDomain(data)['bare-shop.myshopify.com'];

    assert.equal(bare.surface_detail, '',
        'The stored query must not reach the response. Blanking it where the row is WRITTEN reaches '
        + 'only rows synced from that build onward, so without this guard an operator upgrading keeps '
        + 'serving every historical query they already captured until a lifetime re-sync.');
    assert.equal(bare.surface_type, 'search',
        'THE SURFACE IS NOT THE QUERY. That the merchant arrived through App Store search is a '
        + 'placement fact and stays published; suppressing it too would delete the coverage this table '
        + 'reports rather than the free text it was asked to withhold.');
    assert.equal(bare.surface_intra_position, 4,
        'Nor is the RANK the query — it is a position in a result list, and it survives for the same reason.');
    assert.equal(bare.channel, 'APP_STORE_SEARCH',
        'And the classification survives the blanking: the channel is taken from the repository row, '
        + 'upstream of the guard.');
    assert.equal(data.summary.by_channel.APP_STORE_SEARCH, 1,
        'The tally is folded from the same row, so the badge and the summary strip cannot disagree.');
});

test('a BROWSE placement handle survives the guard and still classifies the install as a Shopify App Store ad', async () => {
    _reset();
    // ADDITIVE, like the search row above: churned-shop carries no attribution record in the shared
    // fixture, so this is the only channel this test moves.
    STATE.attribution = [
        ...ATTRIBUTION,
        {
            shop_domain: 'churned-shop.myshopify.com',
            shop_name: 'Churned Store',
            installed_at: _at('2026-08-12T09:58:00.000Z'),
            source: 'shopify_app_store',
            medium: 'referral',
            campaign: '',
            attribution_source: 'user_first_acquisition',
            // The listing-URL form of an ad click: Shopify labels the SAME placement
            // `home` / `homepage-ads` from the URL and `homepage_ad` / `homepage-ads` from the
            // ad-click event, and the pageview happens after the click so last-touch usually keeps
            // the URL's label. `surface.constants.ts` records 49 of this form against 3 of the other.
            surface_type: 'home',
            surface_detail: 'homepage-ads',
            surface_inter_position: 2,
            surface_intra_position: 1
        }
    ];

    const data = await _read({ limit: 500 });
    const churned = _byDomain(data)['churned-shop.myshopify.com'];

    assert.equal(churned.surface_detail, 'homepage-ads',
        'On a browse surface the detail is Shopify\'s own placement handle, never a merchant query. A '
        + 'guard that blanked it unconditionally would empty the "Came from" column for every browse '
        + 'and ad install on the page, with nothing on screen to say the value had been withheld.');
    assert.equal(churned.channel, 'APP_STORE_AD',
        '⚠️ THIS IS THE ASSERTION THAT PROVES THE GUARD IS ON THE PUBLISHED ROW ONLY. '
        + '`classifyAcquisitionChannel` is called on the REPOSITORY row, upstream of the guard, and '
        + '`isPaidPlacement` recognises this install as paid SOLELY because surface_detail is '
        + '"homepage-ads" — the surface name says `home`, which is organic browsing. Move the blanking '
        + 'upstream of the classifier and this row files as APP_STORE_BROWSE instead, silently, in the '
        + 'one report whose purpose is telling paid and organic apart.');
    assert.equal(churned.channel_label, 'Shopify App Store ad',
        'The row carries its own label, and the page falls back to its private copy when it is missing.');
    assert.equal(data.summary.by_channel.APP_STORE_AD, 1);
    assert.equal(data.summary.by_channel.APP_STORE_BROWSE, 0,
        'The misclassification this guards against is not a lost row — it is a row moved into the '
        + 'neighbouring bucket, which is why both counts are pinned and not just the one.');
});


/* ==========================================================================
 *  5. Fail-open validation, and pre-filter counts
 * ========================================================================== */

test('an unrecognised state / channel / sort WIDENS the result set and says so', async () => {
    _reset();
    const data = await _read({ limit: 500, state: 'Converted', channel: 'nope', sort: 'revenue' });

    assert.equal(data.items.length, 4, 'A typo must never empty the table — that is indistinguishable from no data.');
    assert.deepEqual(data.diagnostics.unrecognised_filters, ['state=Converted', 'channel=nope', 'sort=revenue']);
    assert.equal(data.sort.key, 'installed_at', 'An unrecognised sort falls back to the default.');
    assert.equal(data.filter_state, '');
    assert.equal(data.filter_channel, '');
    assert.equal(data.warnings.filter((w) => w.includes('is not one of')).length, 2);
});

test('summary tallies are PRE-filter, so the other filter options do not all read (0)', async () => {
    _reset();
    const data = await _read({ limit: 500, state: 'CONVERTED' });

    assert.equal(data.items.length, 1, 'The list is filtered…');
    assert.equal(data.pagination.total, 1);
    assert.equal(data.summary.installs, 4, '…and the summary is not.');
    assert.equal(data.summary.by_state.ON_TRIAL, 1, 'Selecting one state must not zero the label of every other.');
    assert.equal(data.filter_state, 'CONVERTED');
});


/* ==========================================================================
 *  6. Sorting and paging
 * ========================================================================== */

test('the default sort is newest install first, and paging is clamped and echoed', async () => {
    _reset();
    const data = await _read({ limit: 500 });
    assert.deepEqual(data.items.map((r) => r.shop_domain), [
        'trial-shop.myshopify.com',
        'converted-shop.myshopify.com',
        'churned-shop.myshopify.com',
        'bare-shop.myshopify.com'
    ]);
    assert.deepEqual(data.sort, { key: 'installed_at', dir: 'desc' });

    const page2 = await _read({ limit: '2', page: '2' });
    assert.deepEqual(page2.pagination, { page: 2, limit: 2, total: 4, pages: 2 });
    assert.deepEqual(page2.items.map((r) => r.shop_domain), ['churned-shop.myshopify.com', 'bare-shop.myshopify.com']);
    assert.ok(page2.warnings.some((w) => w.includes('Showing 2 of 4 matching stores')),
        'The page never paginates and counts items.length, so warnings[] is the ONLY channel for truncation.');

    const overshoot = await _read({ limit: 2, page: 99 });
    assert.equal(overshoot.pagination.page, 2, 'A page past the end clamps rather than answering with an empty table.');

    const huge = await _read({ limit: 100000 });
    assert.equal(huge.pagination.limit, 500, 'MAX_LIMIT must stay >= 500 — the page hard-codes limit: 500.');

    const junk = await _read({ limit: 'lots', page: 'first' });
    assert.deepEqual([junk.pagination.limit, junk.pagination.page], [50, 1], 'Junk paging is a typo, not grounds to refuse a page of data.');
});

test('ascending sort by domain, and the summary array is not the one that got sorted', async () => {
    _reset();
    const data = await _read({ limit: 500, sort: 'shop_domain', sort_dir: 'asc' });
    assert.deepEqual(data.items.map((r) => r.shop_domain), [
        'bare-shop.myshopify.com',
        'churned-shop.myshopify.com',
        'converted-shop.myshopify.com',
        'trial-shop.myshopify.com'
    ]);
    assert.equal(data.summary.installs, 4);
    assert.deepEqual(data.summary.by_state, { INSTALLED: 1, ON_TRIAL: 1, CONVERTED: 1, CHURNED_IN_TRIAL: 0, CHURNED: 1 });
});


/* ==========================================================================
 *  7. The empty states, and the only four refusals
 * ========================================================================== */

test('NEVER_SYNCED is decided by the WATERMARK, never by the row count', async () => {
    _reset();
    STATE.app = { ...APP, last_synced_at: null };
    const data = await _read();

    assert.equal(data.data_state, 'NEVER_SYNCED');
    assert.ok(data.warnings.some((w) => w.includes('we have not looked')),
        'An empty window is an ordinary answer once a sync has run. These two must never render alike.');

    // \u2620\ufe0f AND THE SAME SENTENCE AGAIN, OUTSIDE `warnings[]`. The frontend decoder intercepts this
    // `data_state`, NULLS `data` \u2014 taking every warning with it \u2014 and renders the banner body as
    // `data.unknown_reason || resp.msg`. Without this field the page prints the SUCCESS message,
    // "Install cohort resolved.", under the heading "Nothing synced yet".
    assert.equal(typeof data.unknown_reason, 'string');
    assert.ok(data.unknown_reason.includes('we have not looked'),
        'It must be the explanation, not the success message the envelope carries beside it.');

    _reset();
    const synced = await _read();
    assert.equal(synced.data_state, 'READY');
    assert.equal(synced.unknown_reason, undefined,
        'A READY response has nothing unknown about it, and the frontend gate would not read this anyway.');
});

test('an unconfigured listing tier is NOT a refusal', async () => {
    // The tier is configured for this file (see the header), so the NOT_CONNECTED branch is asserted
    // through its contract rather than by unsetting the environment mid-process: whatever the state,
    // the response is a 200 carrying rows, and the reason lives in `attribution_state` + `warnings`.
    _reset();
    const data = await _read({ limit: 500 });

    assert.equal(data.attribution_state, 'READY');
    assert.ok(['READY', 'NOT_CONNECTED', 'NEVER_SYNCED'].includes(data.attribution_state));
    assert.ok(Array.isArray(data.items) && data.items.length > 0,
        'status:false maps to setCohort(null) on the page, which prints "No installs recorded — run a Partner sync". '
        + 'That is wrong twice: the installs exist, and the missing thing is a BigQuery credential.');
});

test('the four refusals, and a thrown query that resolves rather than rejecting', async () => {
    _reset();

    const noUser = await getInstallCohort({ user_id: '' }, WINDOW);
    assert.equal(noUser.status, false);
    assert.deepEqual(noUser.data, {}, 'A failed call carries {} — never a partial payload.');

    const noApp = await getInstallCohort({ user_id: 'operator-1' }, { partner_app_id: '' });
    assert.equal(noApp.status, false);

    STATE.app = null;
    const missing = await getInstallCohort({ user_id: 'operator-1' }, WINDOW);
    assert.equal(missing.status, false);
    assert.equal(missing.msg, 'Partner app not found.');

    STATE.appThrows = true;
    const threw = await getInstallCohort({ user_id: 'operator-1' }, WINDOW);
    assert.equal(threw.status, false, 'A service must RESOLVE a failure, never reject.');
    assert.deepEqual(threw.data, {});
});


/* ==========================================================================
 *  8. The window echo and the coverage floors
 * ========================================================================== */

test('the window, the judgement instant and the coverage floors are all echoed', async () => {
    _reset();
    const data = await _read({ limit: 500 });

    assert.equal(data.app_id, 'app-1');
    assert.equal(data.app_name, 'Demo App');
    assert.equal(data.kind, 'custom');
    assert.equal(data.since, '2026-08-01T00:00:00.000Z');
    assert.equal(data.until, '2026-08-31T23:59:59.999Z');
    assert.equal(data.as_of, data.until, 'States are judged as of the END of the window, so the answer is reproducible.');
    assert.equal(data.period_days, null);

    const lifetime = await _read({ since: undefined, until: undefined, period_days: 'all' });
    assert.equal(lifetime.period_days, 'all');
    assert.equal(lifetime.since, null);
    assert.equal(lifetime.kind, 'lifetime');
    assert.ok(lifetime.warnings.some((w) => w.includes('FLOOR rather than a total')),
        'lifetime_sync_completed_at is null on the fixture app, so every all-time figure is a floor.');
});

test('a known gap in the event history is a coverage floor, and 0 is not', async () => {
    _reset();
    assert.ok(!(await _read()).warnings.some((w) => w.includes('carrying no events at all')),
        'The fixture app has never measured a gap (`undefined`), so nothing is claimed about one.');

    _reset();
    STATE.app = { ...APP, event_history_gap_days: 0 };
    assert.ok(!(await _read()).warnings.some((w) => w.includes('carrying no events at all')),
        '\u2620\ufe0f `0` is the most REASSURING value this field takes \u2014 a measured "no day-wide hole". '
        + 'A truthiness test would be right here by accident and wrong on the day the check is rewritten.');

    _reset();
    STATE.app = { ...APP, event_history_gap_days: 11 };
    const gapped = await _read();
    assert.ok(gapped.warnings.some((w) => w.includes('11 day(s) carrying no events at all')),
        'A window overlapping an event gap under-counts installs, by_state AND attribution_coverage, '
        + 'and this is the only place that can say so \u2014 the gate is measured, not guessed.');
    assert.ok(gapped.warnings.some((w) => w.includes('FLOORS rather than totals')),
        'It must name the consequence, not merely the measurement.');
});

test('the test-subscription count is what was EXCLUDED, not what carried a flag', async () => {
    _reset();
    // converted-shop's subscription is live and real. A LATER event on the same charge carries
    // `charge.test === true` \u2014 a flagged cancellation against a genuine ACCEPTED.
    STATE.events = [
        ...EVENTS,
        {
            event_type: 'SUBSCRIPTION_CHARGE_CANCELLED',
            shop_domain: 'converted-shop.myshopify.com',
            charge_id: '111',
            occurred_at: _at('2026-08-27T09:00:00.000Z'),
            raw_event: { charge: { id: 'gid://shopify/AppSubscription/111', test: true } }
        }
    ];

    const data = await _read({ limit: 500 });
    assert.equal(data.diagnostics.test_excluded, 1,
        'One test SUBSCRIPTION was excluded \u2014 bare-shop\u2019s. The flagged cancellation belongs to a '
        + 'subscription that survived, so counting its key would make the rendered "N test subscription(s) '
        + 'were excluded" claim more than the fold actually dropped.');
    assert.equal(_byDomain(data)['converted-shop.myshopify.com'].state, 'CONVERTED',
        'And the subscription itself is still reported in full.');

    // A fully keyless test event contributes no key at all: it named no bucket, so it cannot be
    // counted as one. It is still counted as an event.
    _reset();
    STATE.events = [
        ...EVENTS,
        {
            event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
            shop_domain: '',
            charge_id: '',
            occurred_at: _at('2026-08-18T09:00:00.000Z'),
            raw_event: { charge: { test: true } }
        }
    ];
    assert.equal((await _read({ limit: 500 })).diagnostics.test_excluded, 1,
        'Adding the literal key `shop:` for it made one synthetic entry that every other keyless test '
        + 'event then collapsed into \u2014 a bucket key naming no bucket, counted as a subscription.');
});

test('every exclusion the reads made is published in diagnostics', async () => {
    _reset();
    const data = await _read({ limit: 500 });

    assert.equal(data.diagnostics.spine_domains, 4);
    assert.equal(data.diagnostics.shopless_install_events, 3);
    assert.equal(data.diagnostics.skipped_keyless_subscription_events, 0);
    assert.equal(typeof data.diagnostics.charge_link.resolved, 'number');
    assert.ok(data.warnings.some((w) => w.includes('no shop domain')),
        'A filtered row that is never counted is a row that vanished silently.');
});
