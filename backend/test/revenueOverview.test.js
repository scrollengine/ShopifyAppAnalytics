'use strict';

/**
 * ============================================================================
 *  GET /api/revenue/overview — the post-login landing page, end to end
 * ============================================================================
 *
 *  Exercises `getRevenueOverview` (and its sibling `getShopPlans`) with the reads stubbed out and
 *  every fold running for real.
 *
 *   THE AS-OF PREDICATE IS NOT STUBBED AND MUST NEVER BE. Membership comes through
 *  `ledgerMrr.liveSetAsOf` — the canonical definition of who is paying us — and so does every figure
 *  built on it. A test that replaced it would prove that a fake agrees with itself. The charge-cohort
 *  fold and the churn-date derivation are likewise the real ones, reached from `modules/conversion`.
 *
 *  ⚠️ STUBS ARE INSTALLED BEFORE THE SERVICES ARE REQUIRED. Every service here destructures its
 *  repository at MODULE LOAD, so a re-assignment afterwards has no effect at all and the suite would
 *  silently exercise the real queries against a database it never connected to.
 *
 *  ── THE FIVE THINGS THIS FILE EXISTS TO PIN ─────────────────────────────────────────────────
 *
 *    1. The movement panel RECONCILES: opening + new + expansion − contraction − churned === closing.
 *    2. `movement_shops[bucket].length` EQUALS the count printed on that bucket's card. "If a card
 *       says 23 stores, clicking it shows 23 stores."
 *    3. A past month is ACTUALLY A PAST MONTH: a merchant who has since uninstalled still counts in
 *       the months they were paying. Valuing today's subscriber list at old prices erases exactly the
 *       churn the chart was drawn to show.
 *    4. An annual subscriber does not vanish for eleven months of every twelve, and is booked at /12.
 *    5. `ACTIVE_SUB_WINDOW_DAYS` in BOTH directions: it neither manufactures churn across a skipped
 *       calendar month nor keeps a cancelled shop in the paying set for ever.
 *
 *  Plus the contract the page depends on: every figure a BARE NUMBER (an envelope renders as an em
 *  dash through `Number(n)` and would blank the whole screen), `null` for unknown and never `0`, and
 *  `GET /api/revenue/now` still fully enveloped for its own two consumers.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mongoose = require('mongoose');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const REVENUE_ROOT = path.join(BACKEND_ROOT, 'src', 'modules', 'revenue');

mongoose.set('bufferTimeoutMS', 400);

const config = require(path.join(BACKEND_ROOT, 'src', 'config', 'index.ts'));
const revenueRepository = require(path.join(REVENUE_ROOT, 'repositories', 'revenue.repository.ts'));
// THE canonical predicate, by deep path — the same one every figure in this suite is measured with.
// Used only to rebuild the one repository read that closes over its own sibling; nothing here
// re-implements membership.
const { liveSetAsOf } = require(path.join(REVENUE_ROOT, 'helpers', 'ledgerMrr.helper.ts'));

const WINDOW_DAYS = config.REVENUE.ACTIVE_SUB_WINDOW_DAYS;
const _DAY_MS = 24 * 60 * 60 * 1000;

const _daysAgo = (days) => new Date(Date.now() - days * _DAY_MS);
/** `YYYY-MM-DD`, UTC — the form the date-range resolver accepts. */
const _isoDay = (at) => at.toISOString().slice(0, 10);

/** One settled `APP_SUBSCRIPTION` payout, as `fetchSubscriptionChargeHistory` flattens it. */
const _charge = (shopId, daysBack, gross, interval = 'EVERY_30_DAYS') => ({
    shop_id: shopId,
    shop_domain: `${shopId}.myshopify.com`,
    gross,
    currency: 'USD',
    billing_interval: interval,
    created_at: _daysAgo(daysBack)
});

/** NEWEST FIRST — `liveSetAsOf` accepts the first row it sees per shop and relies on that order. */
const _newestFirst = (rows) => [...rows].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

/** One SUBSCRIPTION_CHARGE_ACTIVATED event, carrying the `charge` block the cohort reads plans from. */
const _chargeEvent = (shopId, daysBack, planName, price, chargeId) => ({
    event_type: 'SUBSCRIPTION_CHARGE_ACTIVATED',
    shop_domain: `${shopId}.myshopify.com`,
    charge_id: String(chargeId),
    occurred_at: _daysAgo(daysBack),
    raw_event: {
        charge: {
            id: `gid://partners/AppSubscription/${chargeId}`,
            name: planName,
            amount: { amount: price, currencyCode: 'USD' },
            billingOn: _daysAgo(daysBack).toISOString(),
            test: false
        }
    }
});

const APP = {
    _id: 'app-1',
    app_handle: 'demo-app',
    display_name: 'Demo App',
    last_synced_at: _daysAgo(0),
    earliest_event_at: _daysAgo(900),
    // The payout coverage floor. Old enough that every boundary in these fixtures is measurable, so
    // a failing assertion below is about the arithmetic rather than about the gate.
    earliest_transaction_at: _daysAgo(900),
    lifetime_sync_completed_at: _daysAgo(0),
    event_history_gap_days: 0,
    charge_link_absent_pct: 0,
    charge_link_unresolved_pct: 0
};

/**
 * ⚠️ Assigned BEFORE the services are required — see the file header. Each service captured these
 * references at load, so the STATE object is the only thing a test may vary afterwards.
 */
const STATE = {
    app: APP,
    history: [],
    lifetime: { total_gross: 0, total_net: 0, total_fee: 0, tx_count: 0, subscription_tx_count: 0 },
    topShops: [],
    monthlyCash: [],
    windowCash: null,
    chargeEvents: [],
    settled: { charge_ids: [], shop_domains: [] },
    /** The last query each read was handed, so its bounds can be asserted. */
    chargeEventsQuery: null,
    monthlyCashQuery: null
};

const _reset = () => {
    STATE.app = APP;
    STATE.history = [];
    STATE.lifetime = { total_gross: 0, total_net: 0, total_fee: 0, tx_count: 0, subscription_tx_count: 0 };
    STATE.topShops = [];
    STATE.monthlyCash = [];
    STATE.windowCash = null;
    STATE.chargeEvents = [];
    STATE.settled = { charge_ids: [], shop_domains: [] };
    STATE.chargeEventsQuery = null;
    STATE.monthlyCashQuery = null;
};

revenueRepository.findPartnerAppById = async () => STATE.app;
revenueRepository.fetchSubscriptionChargeHistory = async () => STATE.history;
// ⚠️ STUBBED SEPARATELY, and it has to be. `fetchCurrentPayingShops` calls the repository's OWN
// `fetchSubscriptionChargeHistory` through a module-local reference, so replacing the exported one
// does not reach it — it would issue a real query against a database this suite never connects to,
// buffer for 400ms and then fail `GET /api/revenue/now` with an error nobody would read as a stub gap.
// The predicate it applies is the real one; only the read is replaced.
revenueRepository.fetchCurrentPayingShops = async ({ windowDays, now = new Date() }) => {
    return [...liveSetAsOf(STATE.history, now, windowDays).values()];
};
revenueRepository.getLifetimeCashTotals = async () => STATE.lifetime;
revenueRepository.getTopShopsByLifetimeNet = async () => STATE.topShops;
revenueRepository.aggregateMonthlyCash = async (query) => {
    STATE.monthlyCashQuery = query || null;
    return STATE.monthlyCash;
};
revenueRepository.aggregateWindowCash = async () => STATE.windowCash;
revenueRepository.findRevenueChargeEvents = async (query) => {
    STATE.chargeEventsQuery = query || null;
    return STATE.chargeEvents;
};
revenueRepository.aggregateSettledSubscriptionEvidence = async () => STATE.settled;

const revenueOverviewService = require(path.join(REVENUE_ROOT, 'services', 'revenueOverview.service.ts'));
const shopPlansService = require(path.join(REVENUE_ROOT, 'services', 'shopPlans.service.ts'));
const revenueNowService = require(path.join(REVENUE_ROOT, 'services', 'revenueNow.service.ts'));

const { getRevenueOverview } = revenueOverviewService;
const { getShopPlans } = shopPlansService;
const { getRevenueNow } = revenueNowService;

const IDENTITY = { user_id: 'operator-1' };

/** Calls the endpoint and asserts it answered, returning the payload. */
const _overview = async (params) => {
    const response = await getRevenueOverview(IDENTITY, { partner_app_id: 'app-1', ...params });
    assert.equal(response.status, true, response.msg);
    return response.data;
};

/**
 * A window that has already CLOSED, so `as_of` is the window's own end rather than now.
 *
 * ⚠️ `until` five days back rather than today: a window ending today makes `as_of` and `now` the same
 * instant, which is the one case that cannot distinguish "measured at the window's close" from
 * "measured at today" — and that substitution is the bug this endpoint exists to fix.
 */
const CLOSED_WINDOW = { since: _isoDay(_daysAgo(120)), until: _isoDay(_daysAgo(5)) };

/**
 * The four-movement fixture, and the arithmetic it must produce.
 *
 *   held    50 → 50    unchanged: in both balances, in NO bucket
 *   grew    29 → 99    expansion +70
 *   shrank  99 → 29    contraction 70
 *   left   199 → —     churned 199
 *   arrived  — → 9     new 9
 *
 *   opening 377 + 9 + 70 − 70 − 199 = 187 = closing
 */
const _movementHistory = () => _newestFirst([
    _charge('held', 130, 50), _charge('held', 100, 50), _charge('held', 70, 50), _charge('held', 40, 50), _charge('held', 10, 50),
    _charge('grew', 130, 29), _charge('grew', 10, 99),
    _charge('shrank', 130, 99), _charge('shrank', 10, 29),
    _charge('left', 130, 199),
    _charge('arrived', 20, 9)
]);

/** Every figure that must be a plain number for the page to render it at all. */
const _isBareNumberOrNull = (value) => value === null || typeof value === 'number';


/* ==========================================================================
 *  1.  THE MOVEMENT PANEL RECONCILES
 * ========================================================================== */

test(' opening + new + expansion − contraction − churned === closing, on the published payload', async () => {
    _reset();
    STATE.history = _movementHistory();
    STATE.lifetime = { total_gross: 5000, total_net: 4000, total_fee: 1000, tx_count: 11, subscription_tx_count: 11 };

    const data = await _overview(CLOSED_WINDOW);
    const movement = data.summary.window_movement;
    assert.ok(movement, 'a bounded window inside the coverage floor must publish a movement');

    assert.equal(movement.start_mrr, 377);
    assert.equal(movement.end_mrr, 187);
    assert.equal(movement.new_mrr, 9);
    assert.equal(movement.expansion_mrr, 70);
    // MAGNITUDES, published positive: the card applies the column's own direction, so a sign flip
    // here could never turn a churn column green.
    assert.equal(movement.contraction_mrr, 70);
    assert.equal(movement.churned_mrr, 199);

    const reconciled = movement.start_mrr + movement.new_mrr + movement.expansion_mrr
        - movement.contraction_mrr - movement.churned_mrr;
    assert.equal(
        reconciled,
        movement.end_mrr,
        'the six figures the card prints in equation order must add up to the two balances beside them'
    );
    assert.equal(movement.reconciles, true);
    assert.equal(movement.reconciliation_drift, 0);
});

test('gross churn is (churned + contraction)/opening — 269/377, NOT the 199/377 this once published', async () => {
    _reset();
    STATE.history = _movementHistory();

    const data = await _overview(CLOSED_WINDOW);
    const movement = data.summary.window_movement;

    // THE EXPECTATION IS CHANGED, NOT WEAKENED. This asserted `199 / 377` — cancellations only —
    // while `GET /api/revenue/churn` published `(199 + 70) / 377` for the same month under the same
    // name, so one operator reading both pages saw 52.8% and 71.4% for one business. `199 / 377`
    // is now the value this endpoint must NEVER return, and the line below says so.
    assert.equal(movement.gross_churn_rate, (199 + 70) / 377, 'cancellations PLUS downgrades — the one definition');
    assert.notEqual(movement.gross_churn_rate, 199 / 377, 'the cancellations-only reading is the defect being pinned shut');

    // (churn + contraction − expansion) / opening. New business is excluded on purpose: net churn
    // describes what happened to the customers you already had, and folding new sales in lets a good
    // month paper over a retention problem.
    assert.equal(movement.net_churn_rate, (199 + 70 - 70) / 377);
});

test('retention is PUBLISHED as `1 − rate`, so an operator never derives it from the wrong page', async () => {
    _reset();
    STATE.history = _movementHistory();

    const data = await _overview(CLOSED_WINDOW);
    const movement = data.summary.window_movement;

    assert.equal(movement.gross_revenue_retention_rate, 1 - (199 + 70) / 377);
    assert.equal(movement.net_revenue_retention_rate, 1 - (199 + 70 - 70) / 377);
    // BARE NUMBERS. `moneyFormat.js` is `Number(n)`, so an envelope here renders as an em dash and
    // the whole footer line disappears rather than being visibly wrong.
    assert.ok(_isBareNumberOrNull(movement.gross_revenue_retention_rate));
    assert.ok(_isBareNumberOrNull(movement.net_revenue_retention_rate));
});

test('a lifetime window publishes NO retention either — `null`, never the 100% that `1 − null` gives', async () => {
    _reset();
    STATE.history = _movementHistory();

    // An "All time" window has no opening balance at all, so there is no movement block to carry a
    // rate. The guard that matters is one level down and is pinned in `revenueMovement.test.js`:
    // `1 - null` is `1` in JavaScript, so a naive derivation prints "100.0% net revenue retention"
    // for a period in which nobody was paying.
    const data = await _overview({ period_days: 'all' });
    assert.equal(data.summary.window_movement, null);
});


/* ==========================================================================
 *  2.  THE CARD'S COUNT IS ITS LIST'S LENGTH
 * ========================================================================== */

test(' if a card says N stores, clicking it shows N stores — every count IS its bucket length', async () => {
    _reset();
    STATE.history = _movementHistory();

    const data = await _overview(CLOSED_WINDOW);
    const movement = data.summary.window_movement;
    const shops = data.movement_shops;
    assert.ok(shops, 'a published movement must publish the stores behind it');

    assert.equal(movement.new_count, shops.new.length);
    assert.equal(movement.expanded_count, shops.expansion.length);
    assert.equal(movement.contracted_count, shops.contraction.length);
    assert.equal(movement.churned_count, shops.churned.length);

    assert.equal(shops.new.length, 1);
    assert.equal(shops.expansion.length, 1);
    assert.equal(shops.contraction.length, 1);
    assert.equal(shops.churned.length, 1);
    // …and the STORE THAT DID NOT MOVE is in none of them, while still being in both balances.
    const everyDomain = [...shops.new, ...shops.expansion, ...shops.contraction, ...shops.churned]
        .map((row) => row.shop_domain);
    assert.equal(everyDomain.includes('held.myshopify.com'), false, 'a retained customer is not a movement');
});

test('each bucket\'s rows carry the endpoints its own columns render, and its money sums to its card figure', async () => {
    _reset();
    STATE.history = _movementHistory();

    const data = await _overview(CLOSED_WINDOW);
    const { new: added, expansion, contraction, churned } = data.movement_shops;

    assert.equal(added[0].shop_domain, 'arrived.myshopify.com');
    assert.equal(added[0].previous_mrr, 0, 'a new store opens the window at zero — a measured zero, not an absence');
    assert.equal(added[0].mrr, 9);

    assert.equal(expansion[0].previous_mrr, 29);
    assert.equal(expansion[0].mrr, 99);
    assert.equal(expansion[0].delta, 70, 'the per-row delta is SIGNED — here the sign is the fact being shown');

    assert.equal(contraction[0].delta, -70);

    // `previous_mrr`, not `mrr`: a churned row closes the window at zero, so what was LOST is what it
    // was paying when the window opened. The panel prints exactly this field for "MRR lost".
    assert.equal(churned[0].shop_domain, 'left.myshopify.com');
    assert.equal(churned[0].previous_mrr, 199);
    assert.equal(churned[0].mrr, 0);

    const summed = (rows, field) => rows.reduce((total, row) => total + row[field], 0);
    const movement = data.summary.window_movement;
    assert.equal(summed(added, 'mrr'), movement.new_mrr);
    assert.equal(summed(expansion, 'delta'), movement.expansion_mrr);
    assert.equal(summed(churned, 'previous_mrr'), movement.churned_mrr);
});

test('a movement row names the plan it moved FROM as well as the one it is on — "was on X, now on Y"', async () => {
    _reset();
    STATE.history = _movementHistory();
    // `grew` migrates Starter -> Growth INSIDE the window, which is the case the field exists for:
    // `plan_name` on an expansion row is the CLOSE vintage, so without `plan_name_at_open` the panel
    // can price the $70 move and cannot say what it moved from.
    STATE.chargeEvents = [
        _chargeEvent('grew', 130, 'Starter', 29, 1),
        _chargeEvent('grew', 10, 'Growth', 99, 2),
        _chargeEvent('shrank', 130, 'Pro', 99, 3),
        _chargeEvent('left', 130, 'Enterprise', 199, 4),
        // `arrived` only starts paying inside the window — there is no plan at the open to name.
        _chargeEvent('arrived', 20, 'Starter', 9, 5)
    ];
    STATE.settled = { charge_ids: ['1', '2', '3', '4', '5'], shop_domains: [] };

    const data = await _overview(CLOSED_WINDOW);
    const shops = data.movement_shops;

    const grew = shops.expansion[0];
    assert.equal(grew.shop_domain, 'grew.myshopify.com');
    assert.equal(grew.plan_name_at_open, 'Starter', 'the plan it moved FROM');
    assert.equal(grew.plan_name, 'Growth', 'and the plan it moved TO — the row\'s own close vintage');

    // A contraction row carries both vintages too, even when they are the same name: a merchant who
    // paid less on an identically-named plan dropped seats rather than downgrading a tier, and that
    // is only readable when the column is there to be compared.
    assert.equal(shops.contraction[0].plan_name_at_open, 'Pro');
    assert.equal(shops.contraction[0].plan_name, 'Pro');

    // A churned row is measured at the OPEN, so its two plan fields necessarily agree. Published
    // anyway, so a consumer never has to know which bucket uses which vintage.
    assert.equal(shops.churned[0].plan_name_at_open, 'Enterprise');
    assert.equal(shops.churned[0].plan_name, 'Enterprise');

    // ⚠️ `null`, NOT `''`. The panel prints the plan columns straight, and an empty string renders as
    // a plan whose name is nothing rather than as "this store held no plan at the open".
    assert.equal(shops.new[0].plan_name_at_open, null);
    assert.equal(shops.new[0].previous_mrr, 0, 'and that is exactly the bucket whose stores were not paying then');
});

test('an unnamed plan at the open is `null` on the row — never the empty string a column would print', async () => {
    _reset();
    STATE.history = _movementHistory();
    // No charge events at all: every store is paying, and nothing names what it is paying FOR.
    const data = await _overview(CLOSED_WINDOW);

    for (const bucket of ['new', 'expansion', 'contraction', 'churned']) {
        for (const row of data.movement_shops[bucket]) {
            assert.equal(row.plan_name_at_open, null, `${bucket}: an unknown plan is null, not ''`);
        }
    }
});

test('a churned row is DATED, and says which evidence dated it', async () => {
    _reset();
    STATE.history = _movementHistory();

    const data = await _overview(CLOSED_WINDOW);
    const row = data.movement_shops.churned[0];

    assert.ok(row.churn_date, 'the "Stopped on" column must have something to print');
    // ⚠️ `ledger_window` is ALWAYS LATER than a real cancellation — it is the instant the last settled
    // payout aged out of the live window. Published beside the date so a reader can tell an inference
    // from silence apart from Shopify telling us a cancellation happened.
    assert.equal(row.churn_basis, 'ledger_window');
    assert.ok(
        new Date(row.churn_date).getTime() <= new Date(data.window.as_of).getTime(),
        'membership cannot end after the instant that judged it'
    );
    // The other three buckets have no churn to date.
    assert.equal(data.movement_shops.new[0].churn_date, null);
    assert.equal(data.movement_shops.new[0].churn_basis, null);
});

test(' install state is DECLINED rather than guessed — `null`, which is not `false`', async () => {
    _reset();
    STATE.history = _movementHistory();

    const data = await _overview(CLOSED_WINDOW);
    const since = data.movement_shops_since;
    assert.ok(since);

    // `false` prints a banner claiming no install or uninstall event has EVER synced for this app —
    // a specific, checkable, false claim about a deployment that syncs fine. `true` would be worse.
    // `null` hides the column and says nothing, which is the only honest answer from this endpoint.
    assert.equal(since.install_state_available, null);
    assert.equal(since.close_is_now, false, 'this window closed five days ago');
    assert.notEqual(since.close_at, since.now_at, 'the two instants the panel names must actually differ');
});


/* ==========================================================================
 *  3.  A PAST MONTH MUST ACTUALLY BE A PAST MONTH
 * ========================================================================== */

test(' a merchant who has since uninstalled STILL COUNTS in the past window they were paying in', async () => {
    _reset();
    // `gone` paid through the window and then stopped — the shape of an uninstall, where the plan
    // reference is reset and the store vanishes from every "current subscribers" list.
    STATE.history = _newestFirst([
        _charge('gone', 200, 99), _charge('gone', 170, 99),
        _charge('stayed', 200, 29), _charge('stayed', 170, 29), _charge('stayed', 5, 29)
    ]);

    const data = await _overview({ since: _isoDay(_daysAgo(210)), until: _isoDay(_daysAgo(150)) });

    assert.equal(data.window.is_historical, true);
    assert.equal(
        data.summary.as_of.mrr,
        128,
        'the window closed while both merchants were paying: 99 + 29, a figure no replay of today\'s list can reach'
    );
    assert.equal(data.summary.as_of.active_subs, 2);

    // …and TODAY is a different, smaller number, which is the churn the chart exists to show.
    assert.equal(data.summary.current_mrr, 29);
    assert.equal(data.summary.current_active_subs, 1);
    assert.ok(
        data.summary.as_of.mrr > data.summary.current_mrr,
        'valuing today\'s subscriber list at old prices would under-report every past month by exactly the customers who left'
    );
    // The two are published side by side precisely so the gap is visible rather than discovered.
    assert.equal(data.summary.as_of.mrr_now_baseline, data.summary.current_mrr);
});

test('a closed window is measured at the window\'s own end, not at today', async () => {
    _reset();
    STATE.history = _newestFirst([_charge('one', 200, 49), _charge('one', 170, 49)]);

    const data = await _overview({ since: _isoDay(_daysAgo(210)), until: _isoDay(_daysAgo(150)) });
    const asOf = new Date(data.window.as_of).getTime();

    assert.ok(asOf < Date.now(), '`as_of` must be the window\'s close, or every historical read answers for today');
    assert.equal(data.window.as_of, data.summary.as_of.at, 'one instant, published in both places');
    assert.equal(data.summary.as_of.mrr, 49);
    assert.equal(data.summary.current_mrr, 0, 'and today is a MEASURED zero — the ledger answered, and nobody is paying');
});


/* ==========================================================================
 *  4.  THE ANNUAL BLIND SPOT
 * ========================================================================== */

test(' an annual subscriber holds the MRR line for a year, and is booked at gross/12', async () => {
    _reset();
    // One yearly charge, 200 days ago. Under a flat 38-day window this shop is live for exactly one
    // month of the twelve and the line saws — eleven troughs that look like churn and recovery.
    STATE.history = _newestFirst([_charge('yearly', 200, 1200, 'ANNUAL')]);
    STATE.lifetime = { total_gross: 1200, total_net: 1080, total_fee: 120, tx_count: 1, subscription_tx_count: 1 };

    const data = await _overview({ period_days: 365 });

    assert.equal(data.summary.current_mrr, 100, 'a year of revenue booked whole would overstate a MONTHLY run-rate twelvefold');
    assert.equal(data.summary.current_active_subs, 1);

    const chargedAt = _daysAgo(200).getTime();
    const monthsAfterCharge = data.monthly_trend.filter((month) => {
        // Every month whose end falls after the charge — i.e. every month the subscriber was live in.
        const end = new Date(`${month.month}-01T00:00:00.000Z`);
        end.setUTCMonth(end.getUTCMonth() + 1);
        return end.getTime() > chargedAt;
    });

    assert.ok(monthsAfterCharge.length >= 6, 'the fixture must actually span the months it is testing');
    for (const month of monthsAfterCharge) {
        assert.equal(
            month.mrr,
            100,
            `${month.month} must still carry the annual subscriber — a fixed 38-day window drops them for eleven months of every twelve`
        );
        assert.equal(month.active_subs, 1);
    }
});


/* ==========================================================================
 *  5.  THE 38-DAY WINDOW, IN BOTH DIRECTIONS
 * ========================================================================== */

test(' a 30-day biller SKIPS a calendar month, and that must not be reported as churn', async () => {
    _reset();
    // 12 x 30 = 360, so every shop on a 30-day cycle skips one calendar month a year. Charges 31 days
    // apart across the whole window; membership-by-calendar-month would report the skipped month as
    // CHURNED and the next as NEW, falsely churning a slice of the base out of arithmetic alone.
    STATE.history = _newestFirst([
        _charge('cyclic', 128, 39), _charge('cyclic', 97, 39), _charge('cyclic', 66, 39),
        _charge('cyclic', 35, 39), _charge('cyclic', 4, 39)
    ]);

    const data = await _overview({ period_days: 120 });
    const movement = data.summary.window_movement;

    assert.equal(movement.churned_count, 0, 'nobody cancelled, so nothing may be reported as churned');
    assert.equal(movement.churned_mrr, 0);
    assert.equal(movement.new_count, 0, 'and nothing may be reported as new the month after, either');
    assert.equal(movement.start_mrr, 39);
    assert.equal(movement.end_mrr, 39);
    assert.equal(movement.gross_churn_rate, 0, 'a MEASURED zero churn rate — the base existed and nobody left');

    // The line is flat across every month because the subscriber never left, not because a window was
    // widened until nobody could.
    const measured = data.monthly_trend.filter((month) => month.measurable && month.mrr !== null);
    assert.ok(measured.length >= 4);
    for (const month of measured.slice(1)) {
        assert.ok(month.mrr === 39 || month.mrr === 0, `${month.month} must not manufacture a partial month`);
    }
});

test(' a shop that stopped paying DOES leave the paying set — a flat MRR line is the tell', async () => {
    _reset();
    // `cancelled` was billed just before the window opened — so it IS in the opening paying set — and
    // never again. Removing or widening the live window is what produced $45M of MRR against $10K of
    // real settled payouts, on a suspiciously flat line.
    assert.ok(125 - 120 < WINDOW_DAYS, 'the fixture must put the last charge inside the OPENING lookback');
    STATE.history = _newestFirst([_charge('cancelled', 125, 499), _charge('paying', 3, 29)]);

    const data = await _overview({ period_days: 120 });

    assert.equal(data.summary.current_mrr, 29, 'a cancellation that never synced must not keep a shop paying for ever');
    assert.equal(data.summary.current_active_subs, 1);

    const churned = data.movement_shops.churned.map((row) => row.shop_domain);
    assert.deepEqual(churned, ['cancelled.myshopify.com'], 'and it must appear in the churn list for the window it left in');
    assert.equal(data.summary.window_movement.churned_mrr, 499);
});


/* ==========================================================================
 *  6. The rendering contract the page depends on
 * ========================================================================== */

test(' every published figure is a BARE NUMBER — an envelope renders as an em dash and blanks the page', async () => {
    _reset();
    STATE.history = _movementHistory();
    STATE.lifetime = { total_gross: 5000, total_net: 4000, total_fee: 1000, tx_count: 11, subscription_tx_count: 11 };
    STATE.topShops = [{
        shop_id: 'gid://partners/Shop/1',
        shop_domain: 'held.myshopify.com',
        lifetime_net: 400,
        lifetime_gross: 500,
        first_tx_at: _daysAgo(130),
        last_tx_at: _daysAgo(10),
        tx_count: 5
    }];

    const data = await _overview(CLOSED_WINDOW);

    for (const field of ['current_mrr', 'current_active_subs', 'arpu', 'lifetime_net', 'lifetime_tx_count']) {
        assert.ok(_isBareNumberOrNull(data.summary[field]), `summary.${field} must be a number or null, never an envelope`);
    }
    for (const field of ['mrr', 'active_subs', 'arpu', 'mrr_now_baseline']) {
        assert.ok(_isBareNumberOrNull(data.summary.as_of[field]), `as_of.${field} must be a number or null`);
    }
    for (const month of data.monthly_trend) {
        assert.ok(_isBareNumberOrNull(month.mrr));
        assert.ok(_isBareNumberOrNull(month.gross_cash));
        assert.ok(_isBareNumberOrNull(month.net_cash));
    }
    for (const row of data.top_shops) {
        assert.equal(typeof row.lifetime_net, 'number');
        assert.equal(typeof row.is_active_now, 'boolean');
    }

    // Proved structurally as well as field by field: nothing anywhere in the payload carries the
    // envelope's shape.
    const stack = [data];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') {
            continue;
        }
        assert.equal(
            Object.hasOwn(node, 'confidence') && Object.hasOwn(node, 'source'),
            false,
            'a confidence envelope reached the windowed payload; the page formats with Number(n) and would render it as —'
        );
        for (const value of Object.values(node)) {
            stack.push(value);
        }
    }
});

test(' `GET /api/revenue/now` is UNCHANGED — still fully enveloped, for its own two consumers', async () => {
    _reset();
    STATE.history = _newestFirst([_charge('one', 5, 29)]);
    STATE.lifetime = { total_gross: 100, total_net: 90, total_fee: 10, tx_count: 1, subscription_tx_count: 1 };

    const response = await getRevenueNow(IDENTITY, { partner_app_id: 'app-1' });
    assert.equal(response.status, true);

    // `/api/meta/coverage` is a trim of this payload's coverage block, and an operator reads the rest
    // as JSON. Both want the envelope; only the PAGE wants bare numbers, which is why there are two
    // endpoints rather than one with a mode flag.
    assert.equal(typeof response.data.mrr, 'object');
    assert.equal(response.data.mrr.value, 29);
    assert.ok(response.data.mrr.confidence);
    assert.ok(response.data.mrr.source);
    assert.equal(typeof response.data.coverage.last_synced_at.confidence, 'string');
});

test('an empty subscription ledger is UNKNOWN, never a zero — and the app is still READY', async () => {
    _reset();
    // A sync HAS completed; the app simply has no subscription payouts. A `0` here would report "you
    // have no subscribers" when the truth is "we have never synced a subscription charge".
    STATE.lifetime = { total_gross: 500, total_net: 450, total_fee: 50, tx_count: 3, subscription_tx_count: 0 };

    const data = await _overview({ period_days: 90 });

    assert.equal(data.summary.current_mrr, null);
    assert.equal(data.summary.current_active_subs, null);
    assert.equal(data.summary.as_of.mrr, null);
    assert.ok(data.summary.as_of.unknown_reason, 'a null figure must always carry the reason it is null');
    //  READY, decided by the WATERMARK. A row count is not a sync state, and telling an operator to
    // "run a sync" when a sync has already run aims them at a setup step over a real gap.
    assert.equal(data.data_state, 'READY');
    // The CASH block is unaffected: one-time and usage charges are real revenue, just not a run-rate.
    assert.equal(data.summary.lifetime_net, 450);
    //  And no six-zero movement card over a period in which nothing was measured.
    assert.equal(data.summary.window_movement, null);
    assert.equal(data.movement_shops, null);
});

test(' an empty ledger nulls EVERY MONTH of the trend — no flat $0 line under an em-dash MRR card', async () => {
    _reset();
    // The exact fixture that shipped the bug: a completed sync, real one-time cash, and not one
    // subscription payout ever synced. `mrrAsOf` answers `0` over an empty set — quite correctly, it
    // summed nothing — and publishing that as `measurable: true` drew a flat $0.00 MRR line across the
    // whole chart beneath the em-dash MRR card `_runRate` had just withheld. Same failure as a flat
    // line that never moves, in the opposite direction: a claim about the operator's BUSINESS built
    // out of a fact about our RECORDS.
    STATE.lifetime = { total_gross: 500, total_net: 450, total_fee: 50, tx_count: 3, subscription_tx_count: 0 };

    const data = await _overview({ period_days: 180 });

    assert.ok(data.monthly_trend.length > 0, 'the CASH bars still draw — one-time charges are real revenue');
    for (const month of data.monthly_trend) {
        assert.equal(month.mrr, null, `${month.month} published a measured MRR over an empty ledger`);
        assert.equal(month.active_subs, null, `${month.month} published a measured subscriber count`);
        assert.equal(month.measurable, false, `${month.month} claimed to be measurable`);
        assert.ok(month.unknown_reason, `${month.month} is unknown and must say why`);
    }
    //  THE LEDGER'S OWN SENTENCE, not the coverage floor's. The floor is not why these months are
    // unanswerable, and naming it would send the operator after a re-sync that cannot help.
    assert.ok(
        data.monthly_trend[0].unknown_reason.includes('No settled subscription payouts'),
        'the month must name the ledger as the cause, not the payout coverage window'
    );
    assert.equal(
        data.warnings.some((w) => w.includes('of the months on the chart cannot have their MRR measured')),
        false,
        'the coverage-floor warning must not fire when the floor is not the cause'
    );
    // And the payload still says so at the top level, on the same response.
    assert.ok(data.warnings.some((w) => w.includes('No settled subscription payouts')));
});

test('once the ledger HAS charges, a month with nobody live is a real measured 0 and survives', async () => {
    _reset();
    // ⚠️ THE OTHER DIRECTION, and it matters just as much. The gate above is about whether the ledger
    // can answer AT ALL — never about whether the answer happens to be zero. This shop paid and
    // stopped over a year ago, so every recent month end really did have nobody live, and withholding
    // that `0` would hide the exact churn the chart is drawn to show.
    STATE.history = _newestFirst([_charge('gone', 430, 50), _charge('gone', 400, 50)]);

    const data = await _overview({ period_days: 180 });
    const latest = data.monthly_trend[data.monthly_trend.length - 1];

    assert.equal(latest.measurable, true);
    assert.equal(latest.mrr, 0, 'a measured zero must survive the ledger gate');
    assert.equal(latest.active_subs, 0);
    assert.equal(latest.unknown_reason, null);
});

test(' a window that has not begun yet does not report the whole business as new', async () => {
    _reset();
    STATE.history = _movementHistory();

    // `as_of` was already clamped to `now`; the OPENING boundary was not. Unclamped, `mrrAsOf` at a
    // 2030 opening returns an empty set — every stored charge has aged out — so the movement card
    // reported the operator's entire current MRR as `new_mrr` against `start_mrr: 0`, over a period
    // that has not started.
    const data = await _overview({
        since: _isoDay(new Date(Date.now() + 30 * _DAY_MS)),
        until: _isoDay(new Date(Date.now() + 60 * _DAY_MS))
    });
    const movement = data.summary.window_movement;
    assert.ok(movement, 'the window is still answerable — it is simply empty');

    assert.equal(movement.new_mrr, 0, 'nothing can be new in a period that has not begun');
    assert.equal(movement.churned_mrr, 0);
    assert.equal(movement.expansion_mrr, 0);
    assert.equal(movement.contraction_mrr, 0);
    assert.equal(movement.start_mrr, movement.end_mrr, 'both boundaries are the same instant');
    assert.ok(movement.start_mrr > 0, 'and that instant is today, where the paying base is real');
    assert.ok(
        data.warnings.some((w) => w.includes('has not arrived yet')),
        'the clamp is disclosed rather than applied silently'
    );
});

test('an app nothing has ever synced publishes a NULL summary and names the state from the watermark', async () => {
    _reset();
    STATE.app = { ...APP, last_synced_at: null };

    const data = await _overview({ period_days: 90 });

    // The page's own gate is `windowAware = !!(window && summary.as_of)`; a ZEROED summary would
    // render "MRR 0.00" in 32-point type over an app nothing has ever been fetched for.
    assert.equal(data.summary, null);
    assert.equal(data.data_state, 'NEVER_SYNCED');
    assert.ok(data.unknown_reason, 'the banner needs a body, or the page falls back to the success message');
    assert.deepEqual(data.monthly_trend, [], 'an axed, titled chart over blank months reads as "we measured, nothing happened"');
});

test('a lifetime window publishes NO movement and NO window cash, each for its own stated reason', async () => {
    _reset();
    STATE.history = _movementHistory();
    STATE.lifetime = { total_gross: 5000, total_net: 4000, total_fee: 1000, tx_count: 11, subscription_tx_count: 11 };

    const data = await _overview({ period_days: 'all' });

    // Not "you have not picked a range": an all-time window has no opening balance, so every paying
    // store would be counted as new business and the churn rate would have no denominator.
    assert.equal(data.summary.window_movement, null);
    assert.equal(data.movement_shops, null);
    assert.ok(data.warnings.some((warning) => warning.includes('All time')), 'the reason must be published, not left blank');
    // `window_cash` is null because `lifetime_net` already says it — a second identical card would
    // read as two independent measurements agreeing.
    assert.equal(data.summary.window_cash, null);
    assert.equal(data.summary.lifetime_net, 4000);
});

test('the per-plan table partitions the as-of paying set, and names plans from the charge events', async () => {
    _reset();
    STATE.history = _newestFirst([_charge('a', 4, 29), _charge('b', 4, 99), _charge('c', 4, 29)]);
    STATE.chargeEvents = [
        _chargeEvent('a', 60, 'Starter', 29, 111),
        _chargeEvent('b', 60, 'Pro', 99, 222)
    ];
    STATE.settled = { charge_ids: ['111', '222'], shop_domains: ['a.myshopify.com', 'b.myshopify.com'] };

    const data = await _overview({ period_days: 90 });

    const summedMrr = data.plans.reduce((total, row) => total + row.mrr_amount, 0);
    const summedSubs = data.plans.reduce((total, row) => total + row.active_subs, 0);
    assert.equal(summedMrr, data.summary.as_of.mrr, 'the plan rows partition MRR; they must not lose or invent any of it');
    assert.equal(summedSubs, data.summary.as_of.active_subs);

    const names = data.plans.map((row) => row.plan_name);
    assert.ok(names.includes('Starter'));
    assert.ok(names.includes('Pro'));
    // `c` has no charge event naming a plan. It is LABELLED and counted rather than folded into the
    // largest plan, which would move a customer between two rows a reader is comparing.
    assert.ok(names.includes('Unknown plan'));
    assert.equal(data.diagnostics.unknown_plan_shops, 1);
});

test('the charge-event pull is bounded ABOVE only — a store that subscribed before the window is still folded', async () => {
    _reset();
    STATE.history = _newestFirst([_charge('a', 4, 29)]);

    await _overview({ since: _isoDay(_daysAgo(30)), until: _isoDay(_daysAgo(1)) });

    assert.ok(STATE.chargeEventsQuery, 'the cohort read must have been issued');
    assert.ok(STATE.chargeEventsQuery.as_of instanceof Date, 'and bounded at the judgement instant');
    assert.equal(
        Object.hasOwn(STATE.chargeEventsQuery, 'since'),
        false,
        'a lower bound would lose the START event of a subscription that began before the window, and report a paying customer as never having subscribed'
    );
});

test('every warning string is UNIQUE — the page keys them by content, so a duplicate DROPS its condition', async () => {
    _reset();
    STATE.app = { ...APP, lifetime_sync_completed_at: null, earliest_transaction_at: null };
    STATE.history = _movementHistory();

    const data = await _overview(CLOSED_WINDOW);
    assert.equal(new Set(data.warnings).size, data.warnings.length);
    assert.ok(data.warnings.length > 0, 'an app with no lifetime sync and no measured floor has things to say');
});

test('a window ending before the payout history begins is UNKNOWN, and says so — never zero', async () => {
    _reset();
    // The floor is recent; the window closed long before it.
    STATE.app = { ...APP, earliest_transaction_at: _daysAgo(30) };
    STATE.history = _newestFirst([_charge('a', 4, 29)]);

    const data = await _overview({ since: _isoDay(_daysAgo(400)), until: _isoDay(_daysAgo(370)) });

    assert.equal(data.summary.as_of.mrr, null, 'a zero here would report that nobody was paying, which is a claim about the business');
    assert.equal(data.summary.as_of.before_coverage, true);
    assert.ok(data.summary.as_of.coverage_start, 'the banner names the date our records begin');
    assert.ok(data.summary.as_of.unknown_reason);
    assert.equal(data.summary.window_movement, null, 'and nothing may be moved between two boundaries neither of which can be measured');
});


/* ==========================================================================
 *  7. POST /api/revenue/shop-plans
 * ========================================================================== */

test(' every requested domain gets an entry — a miss is an ANSWER, never an omission', async () => {
    _reset();
    STATE.history = _newestFirst([_charge('a', 4, 29)]);
    STATE.chargeEvents = [_chargeEvent('a', 60, 'Starter', 29, 111)];
    STATE.settled = { charge_ids: ['111'], shop_domains: ['a.myshopify.com'] };

    const response = await getShopPlans(IDENTITY, {
        partner_app_id: 'app-1',
        shop_domains: ['a.myshopify.com', 'never-heard-of.myshopify.com']
    });
    assert.equal(response.status, true);
    const { plans } = response.data;

    assert.equal(Object.keys(plans).length, 2, 'an omitted key cannot be told apart from a domain nobody asked about');

    const resolved = plans['a.myshopify.com'];
    assert.equal(resolved.plan_title, 'Starter');
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.is_paying_now, true);
    assert.equal(resolved.unknown_reason, null);

    const missed = plans['never-heard-of.myshopify.com'];
    assert.equal(missed.resolved, false);
    assert.equal(missed.plan_title, null, 'no plan is guessed for a store we hold no charge event for');
    assert.ok(missed.unknown_reason, 'and the miss carries its own reason');
});

test(' a domain named `__proto__` gets a REAL entry — a plain object would swallow it silently', async () => {
    _reset();
    STATE.history = _newestFirst([_charge('a', 4, 29)]);
    STATE.chargeEvents = [_chargeEvent('a', 60, 'Starter', 29, 111)];
    STATE.settled = { charge_ids: ['111'], shop_domains: ['a.myshopify.com'] };

    const response = await getShopPlans(IDENTITY, {
        partner_app_id: 'app-1',
        shop_domains: ['a.myshopify.com', '__proto__', 'constructor']
    });
    assert.equal(response.status, true);
    const { plans } = response.data;

    // On a `{}` map, `plans['__proto__'] = row` invokes the inherited SETTER: `Object.keys` stays
    // empty, `JSON.stringify` emits `{}`, and the domain is counted in `unresolved_count` while being
    // absent from `plans` — the one failure this endpoint's header forbids.
    assert.equal(Object.keys(plans).length, 3, 'every requested string is an own key, including the three inherited names');
    assert.ok(plans.__proto__ && plans.__proto__.resolved === false);
    assert.ok(plans.constructor && plans.constructor.resolved === false);
    assert.equal(
        JSON.parse(JSON.stringify(plans)).__proto__ === undefined,
        false,
        'and it survives serialisation, which is how the caller actually receives it'
    );
});

test(' `store_active` is `true` on every row and says nothing — install state is not measured here', async () => {
    _reset();
    STATE.history = _newestFirst([_charge('a', 4, 29)]);
    STATE.chargeEvents = [_chargeEvent('a', 60, 'Starter', 29, 111)];

    const response = await getShopPlans(IDENTITY, { partner_app_id: 'app-1', shop_domains: ['a.myshopify.com'] });
    const row = response.data.plans['a.myshopify.com'];

    // The consumer badges a store "Uninstalled" for ANY falsy value — including an absent key — so
    // `true` is the only value that makes no claim. `store_active_measured` carries the truth.
    assert.equal(row.store_active, true);
    assert.equal(row.store_active_measured, false);
    assert.ok(
        response.data.warnings.some((warning) => warning.includes('store_active')),
        'and the response says out loud that it did not measure it'
    );
    // The cohort drops `charge.test === true` BEFORE folding, so a resolved subscription is non-test
    // by construction — a measurement rather than a default.
    assert.equal(row.is_test, false);
});

test('the domain batch is CLAMPED and reported, never refused, and blank entries are dropped with a count', async () => {
    _reset();
    const tooMany = Array.from({ length: 205 }, (unused, index) => `shop-${index}.myshopify.com`);

    const response = await getShopPlans(IDENTITY, { partner_app_id: 'app-1', shop_domains: [...tooMany, '', '  '] });
    assert.equal(response.status, true);

    assert.equal(Object.keys(response.data.plans).length, 200);
    assert.ok(
        response.data.warnings.some((warning) => warning.includes('205')),
        'a caller must be told which domains are simply absent, or it reads their absence as "no plan"'
    );
});

test('shop-plans refuses only when the CALL cannot happen, and answers 200 with an empty map otherwise', async () => {
    _reset();
    const noOperator = await getShopPlans({ user_id: '' }, { partner_app_id: 'app-1', shop_domains: ['a.myshopify.com'] });
    assert.equal(noOperator.status, false);

    const noApp = await getShopPlans(IDENTITY, { shop_domains: ['a.myshopify.com'] });
    assert.equal(noApp.status, false);
    assert.match(noApp.msg, /partner_app_id/);

    // An empty list is a caller sending nothing, not a sync problem: READY, with a stated reason.
    const nothingAsked = await getShopPlans(IDENTITY, { partner_app_id: 'app-1', shop_domains: [] });
    assert.equal(nothingAsked.status, true);
    assert.deepEqual(nothingAsked.data.plans, {});
    assert.equal(nothingAsked.data.data_state, 'READY');
});

test('the overview refuses only the three call-level failures, each with an actionable sentence', async () => {
    _reset();
    const noOperator = await getRevenueOverview({ user_id: '' }, { partner_app_id: 'app-1' });
    assert.equal(noOperator.status, false);
    assert.match(noOperator.msg, /User ID/);

    const noApp = await getRevenueOverview(IDENTITY, {});
    assert.equal(noApp.status, false);
    assert.match(noApp.msg, /partner-apps/, 'the refusal must say where to get the missing id');

    STATE.app = null;
    const missing = await getRevenueOverview(IDENTITY, { partner_app_id: 'nope' });
    assert.equal(missing.status, false);
    assert.match(missing.msg, /not found/);
});
