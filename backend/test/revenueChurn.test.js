'use strict';

/**
 * ============================================================================
 *  REVENUE CHURN — the three ways a money chart lies quietly
 * ============================================================================
 *
 *  Exercises `getRevenueChurn` end to end with the ledger read and the event pull stubbed out. The
 *  as-of predicate itself — `liveSetAsOf` in `modules/revenue` — is NOT stubbed and must not be: the
 *  whole point of this endpoint is that its membership and its amounts come through the canonical
 *  definition of "who is paying us and how much", so a test that replaced it would prove nothing
 *  about the thing most likely to go wrong.
 *
 *  ── 1.  NET CHURN IS NOT CLAMPED AT ZERO ──────────────────────────────────────────────────
 *
 *  When a month's EXISTING customers expand by more than the month lost, net revenue churn is
 *  NEGATIVE — and negative net churn is the single best signal a subscription business has: the base
 *  grows on its own, before a single new customer is counted. `Math.max(0, …)` hides exactly the
 *  months worth celebrating while leaving the bad ones untouched, so the series can only ever look
 *  like bad news, and nothing on screen says a number was moved.
 *
 *  ── 2. ⚠️ AN UNMEASURED MONTH IS `null`, NOT `0` ────────────────────────────────────────────
 *
 *  `null * 100 === 0` in JavaScript, which is why the page has a `_ratePct` helper at all. A `0`
 *  churn rate for a month the stored history cannot reach is a claim of perfect retention over a
 *  period nobody measured, plotted as a point on the axis floor. Every FIGURE nulls, not just the
 *  rates — a `0` for `churned_mrr` reports a month in which the business lost nothing.
 *
 *  ── 3.  THE WATERFALL DESCRIBES THE LAST **COMPLETE** MONTH ───────────────────────────────
 *
 *  The page picks its waterfall row as the last trend row with `is_partial_month === false` and
 *  captions it with `summary.last_complete_month`. Its own comment records what happened before: it
 *  took the FINAL trend row — the month IN PROGRESS — so a panel headed "Last month" drew an
 *  unfinished month that could not reconcile with a single figure beside it. The test below runs the
 *  page's own selection and asserts every figure matches the summary.
 *
 *  ── AND THE ARTEFACT THE AS-OF WINDOW EXISTS TO PREVENT ─────────────────────────────────────
 *
 *  12 × 30 = 360, so a 30-day biller skips one calendar month a year. Membership defined as "billed
 *  inside calendar month M" reports it as churned there and new the month after — falsely churning
 *  ~1/12 of the base every month AND inflating new MRR by the same amount, out of arithmetic rather
 *  than out of anything a merchant did.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mongoose = require('mongoose');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const MODULE_ROOT = path.join(BACKEND_ROOT, 'src', 'modules', 'conversion');

mongoose.set('bufferTimeoutMS', 400);

const config = require(path.join(BACKEND_ROOT, 'src', 'config', 'index.ts'));
const installCohortRepository = require(path.join(MODULE_ROOT, 'repositories', 'installCohort.repository.ts'));
const customFunnelRepository = require(path.join(MODULE_ROOT, 'repositories', 'customFunnel.repository.ts'));
// The module BARREL, not the repository behind it: the service destructures from the barrel at load,
// and the barrel captured its own reference to the repository function when IT loaded. Stubbing the
// repository afterwards would leave the barrel — and therefore the service — on the real one.
const revenueModule = require(path.join(BACKEND_ROOT, 'src', 'modules', 'revenue', 'index.ts'));
const monthBucketHelper = require(path.join(MODULE_ROOT, 'helpers', 'monthBucket.helper.ts'));
const revenueChurnHelper = require(path.join(MODULE_ROOT, 'helpers', 'revenueChurn.helper.ts'));

const { buildMonthBuckets } = monthBucketHelper;
const { churnRates } = revenueChurnHelper;
const WINDOW_DAYS = config.REVENUE.ACTIVE_SUB_WINDOW_DAYS;

const _DAY_MS = 24 * 60 * 60 * 1000;
const _at = (iso) => new Date(iso);
const _daysAgo = (days) => new Date(Date.now() - days * _DAY_MS);
/** `date - n days`, for placing a charge relative to a real bucket boundary. */
const _before = (date, days) => new Date(date.getTime() - days * _DAY_MS);

/** One settled `APP_SUBSCRIPTION` payout, as `fetchSubscriptionChargeHistory` flattens it. */
const _charge = (shopId, domain, createdAt, gross = 29, interval = null) => ({
    shop_id: shopId,
    shop_domain: domain,
    gross,
    currency: 'USD',
    billing_interval: interval,
    created_at: createdAt
});

/** NEWEST FIRST — `liveSetAsOf` accepts the first row it sees per shop and relies on that order. */
const _newestFirst = (rows) => [...rows].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

const APP = {
    _id: 'app-1',
    display_name: 'Demo App',
    last_synced_at: _at('2026-09-01T00:00:00.000Z'),
    earliest_event_at: _daysAgo(800),
    earliest_transaction_at: _daysAgo(800),
    lifetime_sync_completed_at: _at('2026-09-01T00:00:00.000Z'),
    event_history_gap_days: 0
};

/**
 * ⚠️ Stubs installed BEFORE the service is required. Every service here destructures its
 * dependencies at MODULE LOAD, so a re-assignment afterwards has no effect at all.
 */
const STATE = {
    app: APP,
    history: [],
    events: [],
    settled: { charge_ids: [], shop_domains: [] }
};

const _reset = () => {
    STATE.app = APP;
    STATE.history = [];
    STATE.events = [];
    STATE.settled = { charge_ids: [], shop_domains: [] };
};

installCohortRepository.findPartnerAppById = async () => STATE.app;
customFunnelRepository.findChargeCohortEvents = async () => STATE.events;
customFunnelRepository.aggregateSettledSubscriptionEvidence = async () => STATE.settled;
revenueModule.fetchSubscriptionChargeHistory = async () => STATE.history;

const { getRevenueChurn } = require(path.join(MODULE_ROOT, 'services', 'revenueChurn.service.ts'));

/**
 * Calls the endpoint and asserts it did not refuse.
 *
 * @param {Object} [params] - Query parameters.
 * @returns {Promise<Object>} The payload.
 */
const _read = async (params = {}) => {
    const result = await getRevenueChurn({ user_id: 'operator-1' }, { partner_app_id: 'app-1', ...params });
    assert.equal(result.status, true, `the service refused: ${result.msg}`);
    return result.data;
};

/** Floating-point equality with a tolerance, for the ratios. */
const _close = (actual, expected, what) => {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9,
        `${what}: expected ~${expected}, got ${actual}`);
};

/**
 * A four-month fixture whose LAST COMPLETE month has one merchant upgrading hard and one leaving.
 *
 * Built against the very buckets the endpoint will walk, so the shape is a FACT OF THE FIXTURE rather
 * than an accident of the date the suite happens to run on. `expander` is live at both of that
 * month's boundaries at four times the price; `leaver` is live at the opening one and has aged out by
 * the closing one — 20 days before the month starts plus a whole calendar month is at least 48 days,
 * comfortably past the 38-day window whatever the month's length.
 *
 * @returns {Object} The history rows and the buckets they were placed against.
 */
const _movementFixture = () => {
    const buckets = buildMonthBuckets({ as_of: new Date(), months: 4 });
    const opening = buckets[2].start;
    const closing = buckets[3].start;
    const rows = [
        _charge('gid://partners/Shop/E', 'expander.myshopify.com', _before(opening, 5), 100),
        _charge('gid://partners/Shop/E', 'expander.myshopify.com', _before(closing, 5), 400),
        _charge('gid://partners/Shop/L', 'leaver.myshopify.com', _before(opening, 20), 50)
    ];
    return { buckets, history: _newestFirst(rows) };
};

/**
 * A ~30-day biller whose charges SKIP one calendar month entirely.
 *
 * Lifted deliberately from `logoChurn.test.js`'s `_cyclerFixture` so the money page and the customer
 * page are proven immune to the SAME artefact by the SAME shape — the two are folded from one
 * membership predicate, and a fixture that differed would leave open which of them the window
 * actually protects.
 *
 * @param {Number} months - How many buckets to fill.
 * @returns {Object} The history rows, the buckets, and the month key that carries no charge.
 */
const _cyclerFixture = (months) => {
    const asOf = new Date();
    const buckets = buildMonthBuckets({ as_of: asOf, months });
    const skippedIndex = Math.floor(buckets.length / 2);

    const rows = [];
    buckets.forEach((bucket, index) => {
        if (index === skippedIndex) {
            return;
        }
        // Late in the month before the gap, early in the month after it. One phase change, placed AT
        // the gap, so no other pair of charges is more than ~31 days apart.
        const at = index < skippedIndex
            ? new Date(bucket.month_end.getTime() - _DAY_MS)
            : new Date(bucket.start.getTime());
        if (at.getTime() > asOf.getTime()) {
            return;
        }
        rows.push(_charge('gid://partners/Shop/1', 'cycler.myshopify.com', at));
    });

    return { history: _newestFirst(rows), buckets, skippedMonth: buckets[skippedIndex].month };
};


/* ==========================================================================
 *  1.  Net churn is not clamped at zero
 * ========================================================================== */

test(' net churn goes NEGATIVE when expansion outruns the losses, and is not floored', async () => {
    _reset();
    const fixture = _movementFixture();
    STATE.history = fixture.history;
    STATE.app = { ...APP, earliest_transaction_at: _before(fixture.buckets[0].start, 60) };

    const data = await _read({ months: 4 });
    const summary = data.summary;

    // The month: opens with two merchants at 150, closes with one at 400.
    assert.equal(summary.last_complete_month, fixture.buckets[2].month);
    assert.equal(summary.last_month_start_mrr, 150);
    assert.equal(summary.last_month_end_mrr, 400);
    assert.equal(summary.last_month_new_mrr, 0);
    assert.equal(summary.last_month_expansion_mrr, 300);
    assert.equal(summary.last_month_contraction_mrr, 0);
    assert.equal(summary.last_month_churned_mrr, 50);

    _close(summary.last_month_gross_churn_rate, 50 / 150, 'gross churn is everything the base lost');
    assert.ok(summary.last_month_net_churn_rate < 0,
        'THE DEFECT. `Math.max(0, …)` on this line hides the best months a subscription business has — a base '
        + 'that grew on its own before a single new customer was counted — while leaving every bad month '
        + 'untouched, so the chart can only ever look like bad news.');
    _close(summary.last_month_net_churn_rate, (50 - 300) / 150, 'net churn subtracts expansion, signed');

    // ⚠️ New MRR is in NEITHER rate. Folding acquisition into a churn number would make a strong sales
    // month look like a strong retention month.
    _close(
        churnRates({ start_mrr: 100, churned_mrr: 10, contraction_mrr: 0, expansion_mrr: 40 }).net_churn_rate,
        -0.3,
        'the pure helper answers the same way with no service around it'
    );
});

test('the categories reconcile exactly: end = start + new + expansion − contraction − churned', async () => {
    _reset();
    const fixture = _movementFixture();
    STATE.history = fixture.history;
    STATE.app = { ...APP, earliest_transaction_at: _before(fixture.buckets[0].start, 60) };

    const data = await _read({ months: 4 });
    for (const month of data.monthly_trend.filter((row) => row.measurable)) {
        _close(
            month.end_mrr,
            month.start_mrr + month.new_mrr + month.expansion_mrr - month.contraction_mrr - month.churned_mrr,
            `month ${month.month} does not reconcile`
        );
    }

    // Consecutive months SHARE a boundary, so the series ties end to end. Evaluating each month's two
    // boundaries independently would leave a one-millisecond seam that nothing reconciles.
    const measured = data.monthly_trend.filter((row) => row.measurable);
    for (let i = 1; i < measured.length; i += 1) {
        _close(measured[i].start_mrr, measured[i - 1].end_mrr,
            `month ${measured[i].month} does not open where ${measured[i - 1].month} closed`);
    }
});

test('a rate with an empty denominator is null, never 0 — the line breaks instead of claiming retention', async () => {
    _reset();
    const fixture = _movementFixture();
    STATE.history = fixture.history;
    STATE.app = { ...APP, earliest_transaction_at: _before(fixture.buckets[0].start, 60) };

    const data = await _read({ months: 4 });
    // The first month opens before any charge exists, so its opening MRR is a measured zero.
    const first = data.monthly_trend[0];
    assert.equal(first.measurable, true);
    assert.equal(first.start_mrr, 0, 'a MEASURED zero: nobody was paying yet.');
    assert.equal(first.gross_churn_rate, null,
        '0/0 is not 0%. A `0` here renders as "0.0%" beside the words "Churn rate" — a claim of perfect '
        + 'retention over a month in which nobody was paying at all.');
    assert.equal(first.net_churn_rate, null);
});


/* ==========================================================================
 *  2. ⚠️ An unmeasured month is null, not 0
 * ========================================================================== */

test('⚠️ a month the payout history cannot reach nulls EVERY figure, not just the rates', async () => {
    _reset();
    const fixture = _movementFixture();
    STATE.history = fixture.history;
    // The floor sits at the second bucket's start, so the first three months' boundaries all fall
    // inside the run-up to it and only the month in progress can be measured.
    STATE.app = { ...APP, earliest_transaction_at: fixture.buckets[1].start };

    const data = await _read({ months: 4 });
    assert.ok(Array.isArray(data.monthly_trend),
        'SOME month is measurable, so the trend stays an ARRAY with blanks inside it — `null` is reserved '
        + 'for "no month in this range could be measured at all".');

    const unmeasured = data.monthly_trend.find((row) => row.month === fixture.buckets[2].month);
    assert.equal(unmeasured.measurable, false);
    assert.ok(unmeasured.unknown_reason, 'and it says why, on the row.');
    for (const field of [
        'start_mrr', 'end_mrr', 'new_mrr', 'expansion_mrr', 'contraction_mrr',
        'churned_mrr', 'gross_churn_rate', 'net_churn_rate', 'churned_shops'
    ]) {
        assert.equal(unmeasured[field], null,
            `${field} is ${unmeasured[field]} rather than null. A 0 here reports a month in which the `
            + 'business lost nothing and gained nothing — a statement about the operator\'s business rather '
            + 'than about this deployment\'s records, and indistinguishable from the real thing on a chart.');
        assert.notEqual(unmeasured[field], 0, `${field} must not be a manufactured zero.`);
    }

    // ⚠️ And the tiles for that month are withheld too, rather than quoting a month nobody measured.
    assert.equal(data.summary.last_month_churned_mrr, null);
    assert.equal(data.summary.last_month_gross_churn_rate, null);
    assert.equal(data.summary.last_complete_month, fixture.buckets[2].month,
        'the month is still NAMED — the reader is told which month is blank, not left to guess.');
    assert.equal(typeof data.summary.current_mrr, 'number',
        'while `current_mrr` stays measured: `GET /api/revenue/now` publishes it from this exact predicate at '
        + 'this exact instant with no floor test, so gating it here would blank one page beside a number on '
        + 'another for one measurement.');
    assert.ok(data.diagnostics.unmeasured_months >= 3);
});

test('when NO month can be measured the trend is null, not an array of blanks', async () => {
    _reset();
    const fixture = _movementFixture();
    STATE.history = fixture.history;
    STATE.app = { ...APP, earliest_transaction_at: new Date() };

    const data = await _read({ months: 4 });
    assert.equal(data.monthly_trend, null,
        'The page has a gate for exactly this: publish the tiles and say plainly that the trend is '
        + 'unavailable, rather than mounting a titled, axed chart over four blank months — which reads as '
        + '"we measured these months and nothing moved".');
    assert.ok(data.trend_unknown_reason);
    assert.ok(data.summary, 'the tiles survive: `summary` and `monthly_trend` fail SEPARATELY.');
});


/* ==========================================================================
 *  3.  The waterfall describes the last COMPLETE month
 * ========================================================================== */

test(' the last trend row is the month IN PROGRESS, and the tiles do not describe it', async () => {
    _reset();
    const fixture = _movementFixture();
    STATE.history = fixture.history;
    STATE.app = { ...APP, earliest_transaction_at: _before(fixture.buckets[0].start, 60) };

    const data = await _read({ months: 4 });
    const trend = data.monthly_trend;
    const last = trend[trend.length - 1];

    assert.equal(last.is_partial_month, true, 'the newest bucket is the calendar month we are inside.');
    assert.notEqual(data.summary.last_complete_month, last.month,
        'THE DEFECT the page records: taking the final trend row put an UNFINISHED month in a panel headed '
        + '"Last month", where it could not reconcile with a single figure beside it.');
    assert.equal(trend[trend.length - 2].is_partial_month, false);
    assert.equal(data.summary.last_complete_month, trend[trend.length - 2].month);
});

test(' the page\'s own waterfall selection lands on the month the tiles describe, figure for figure', async () => {
    _reset();
    const fixture = _movementFixture();
    STATE.history = fixture.history;
    STATE.app = { ...APP, earliest_transaction_at: _before(fixture.buckets[0].start, 60) };

    const data = await _read({ months: 4 });

    // `pages/growth-intel/revenue-churn/index.js`, verbatim.
    const complete = data.monthly_trend.filter((row) => !row.is_partial_month);
    const waterfall = complete[complete.length - 1];

    assert.equal(waterfall.month, data.summary.last_complete_month,
        'The waterfall panel and the stat cards above it have to describe ONE month, or the reader is asked '
        + 'to reconcile a chart with figures it was never drawn from.');
    for (const [rowField, tileField] of [
        ['start_mrr', 'last_month_start_mrr'],
        ['end_mrr', 'last_month_end_mrr'],
        ['new_mrr', 'last_month_new_mrr'],
        ['expansion_mrr', 'last_month_expansion_mrr'],
        ['contraction_mrr', 'last_month_contraction_mrr'],
        ['churned_mrr', 'last_month_churned_mrr'],
        ['gross_churn_rate', 'last_month_gross_churn_rate'],
        ['net_churn_rate', 'last_month_net_churn_rate']
    ]) {
        assert.equal(waterfall[rowField], data.summary[tileField],
            `the waterfall's ${rowField} and the tile's ${tileField} disagree.`);
    }
});

test('a range holding only the month in progress withholds the tiles rather than quoting a partial month', async () => {
    _reset();
    const fixture = _movementFixture();
    STATE.history = fixture.history;
    STATE.app = { ...APP, earliest_transaction_at: _before(fixture.buckets[0].start, 60) };

    // The 30-day preset resolves to `months: 1`, so this is a state a reader can reach in one click.
    const data = await _read({ months: 1 });
    assert.equal(data.monthly_trend.length, 1);
    assert.equal(data.monthly_trend[0].is_partial_month, true);
    assert.equal(data.summary.last_complete_month, null);
    assert.equal(data.summary.last_month_churned_mrr, null,
        'Quoting the month in progress under a label that says "last month" is a specific claim about a '
        + 'period that has not finished. The tiles go blank and a note says to widen the range.');
    assert.deepEqual(data.top_churned_30d, [],
        'and the churn table is empty rather than listing a partial month\'s losses under the same label.');
});


/* ==========================================================================
 *  4. The merchants behind the figure
 * ========================================================================== */

test('the churn table is the LAST COMPLETE month, biggest loss first, with a resolvable identity', async () => {
    _reset();
    const fixture = _movementFixture();
    STATE.history = fixture.history;
    STATE.app = { ...APP, earliest_transaction_at: _before(fixture.buckets[0].start, 60) };

    const data = await _read({ months: 4 });
    assert.equal(data.top_churned_30d.length, 1);

    const row = data.top_churned_30d[0];
    assert.equal(row.shop_domain, 'leaver.myshopify.com');
    assert.equal(row.lost_mrr, 50, 'the run-rate it was at when it was last seen paying.');
    assert.equal(data.shop_identity, 'shop_domain',
        'The frontend hook\'s comment calls `shop_id` a tenant id on some pages. Here it is Shopify\'s '
        + 'PARTNER shop id, which `storeDetailRequestParams` cannot resolve — it is not 24-hex, so it is sent '
        + 'as a domain and `normaliseShopDomain` truncates a `gid://…` to the literal string "gid:".');
    assert.equal(row.shop_id, 'gid://partners/Shop/L', 'published for the row key and the fallback label.');
    assert.equal(typeof row.paid_days, 'number', 'the page prints a duration from it with no guard.');
    assert.ok(row.paid_from, 'the FIRST settled payout — the ledger\'s own "when did they start paying us".');
    assert.equal(row.churn_date_basis, 'ledger_window',
        'No cancellation event reached us, so the instant is when the last payout aged out — always LATER '
        + 'than the real cancellation, which is why the basis rides on the row.');
    assert.ok(new Date(row.churned_at).getTime() <= Date.now(),
        'Membership cannot end after the instant that judged it. A ledger-derived date is clamped there.');
    assert.ok(data.warnings.some((line) => line.includes('no cancellation event on record')));
});

test('a dated cancellation beats the derived boundary, and the plan is read rather than guessed', async () => {
    _reset();
    const fixture = _movementFixture();
    STATE.history = fixture.history;
    STATE.app = { ...APP, earliest_transaction_at: _before(fixture.buckets[0].start, 60) };
    // ⚠️ Captured ONCE and placed inside the month, so the assertion compares one instant with itself
    // rather than two a few milliseconds apart — a test that fails on timing rather than on behaviour.
    const cancelledAt = _before(fixture.buckets[3].start, 3);
    STATE.events = [
        {
            event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
            shop_domain: 'leaver.myshopify.com',
            charge_id: '77',
            occurred_at: _before(fixture.buckets[0].start, 30),
            raw_event: {
                charge: {
                    id: 'gid://shopify/AppSubscription/77',
                    name: 'Growth',
                    billingOn: _before(fixture.buckets[0].start, 23).toISOString(),
                    test: false,
                    amount: { amount: '50.00', currencyCode: 'USD' }
                }
            }
        },
        {
            event_type: 'SUBSCRIPTION_CHARGE_CANCELLED',
            shop_domain: 'leaver.myshopify.com',
            charge_id: '77',
            occurred_at: cancelledAt,
            raw_event: { charge: { id: 'gid://shopify/AppSubscription/77', test: false } }
        }
    ];

    const data = await _read({ months: 4 });
    const row = data.top_churned_30d[0];
    assert.equal(row.churn_date_basis, 'partner_event', 'a real, dated cancellation is the better answer.');
    assert.equal(new Date(row.churned_at).getTime(), cancelledAt.getTime());
    assert.equal(row.plan_name, 'Growth', 'read off the subscription\'s own charge, never guessed.');
});

test('a merchant we cannot join to a subscription is left blank, never filed under a real plan', async () => {
    _reset();
    const fixture = _movementFixture();
    STATE.history = fixture.history;
    STATE.app = { ...APP, earliest_transaction_at: _before(fixture.buckets[0].start, 60) };

    const data = await _read({ months: 4 });
    assert.equal(data.top_churned_30d[0].plan_name, '',
        'The page renders a falsy plan as an em dash, which claims nothing. Filing an unjoinable merchant '
        + 'under a real plan would move revenue between plans.');
    assert.equal(data.diagnostics.top_churned_without_plan, 1);
});


/* ==========================================================================
 *  5. The artefact the as-of window exists to prevent
 * ========================================================================== */

test('a 30-day biller that skips a calendar month loses NO revenue in it', async () => {
    _reset();
    const fixture = _cyclerFixture(12);
    STATE.history = fixture.history;
    STATE.app = { ...APP, earliest_transaction_at: fixture.history[fixture.history.length - 1].created_at };

    // The fixture really does contain the artefact — otherwise this test proves nothing.
    const chargedMonths = new Set(fixture.history.map((row) => {
        const at = row.created_at;
        return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
    }));
    assert.equal(chargedMonths.has(fixture.skippedMonth), false,
        'The fixture must contain a calendar month with no settled charge in it, or there is no artefact to '
        + 'be immune to.');

    const data = await _read({ months: 12 });
    const skipped = data.monthly_trend.find((month) => month.month === fixture.skippedMonth);
    assert.equal(skipped.measurable, true);
    assert.equal(skipped.churned_mrr, 0,
        'THE ARTEFACT. Membership defined as "billed inside this calendar month" reports this merchant as '
        + 'churned here and NEW the month after — falsely churning ~1/12 of the base every month AND '
        + 'inflating new MRR by the same amount, out of arithmetic alone.');
    assert.equal(skipped.new_mrr, 0, 'and it does not arrive as a new customer either.');
    assert.equal(skipped.start_mrr, 29);
    assert.equal(skipped.end_mrr, 29);
    assert.equal(skipped.gross_churn_rate, 0, 'a MEASURED zero: one merchant was paying and none left.');

    for (const month of data.monthly_trend.filter((row) => row.measurable)) {
        assert.equal(month.churned_mrr, 0, `month ${month.month} reported a loss nobody made.`);
    }
    assert.equal(data.summary.active_sub_window_days, WINDOW_DAYS,
        'published so a reader can see WHICH window their figures were measured with — the value is '
        + 'load-bearing in both directions and this is the only place it is visible.');
});

test('an ANNUAL charge is a monthly run-rate, divided by 12', async () => {
    _reset();
    const buckets = buildMonthBuckets({ as_of: new Date(), months: 4 });
    STATE.history = _newestFirst([
        _charge('gid://partners/Shop/A', 'annual.myshopify.com', _daysAgo(30), 1200, 'ANNUAL')
    ]);
    STATE.app = { ...APP, earliest_transaction_at: _before(buckets[0].start, 60) };

    const data = await _read({ months: 4 });
    assert.equal(data.summary.current_mrr, 100,
        'A year of revenue booked whole overstates a MONTHLY run-rate twelvefold. And the annual biller must '
        + 'not vanish between yearly charges either — the live window is derived from its own cadence.');
    assert.equal(data.summary.active_subs, 1);
    assert.equal(data.diagnostics.billing_interval_unknown_shops, 0);
});

test('a live shop whose cadence was never captured is COUNTED, because it is what makes MRR read high', async () => {
    _reset();
    const buckets = buildMonthBuckets({ as_of: new Date(), months: 4 });
    STATE.history = _newestFirst([
        _charge('gid://partners/Shop/U', 'unknown-cadence.myshopify.com', _daysAgo(10), 1200, null)
    ]);
    STATE.app = { ...APP, earliest_transaction_at: _before(buckets[0].start, 60) };

    const data = await _read({ months: 4 });
    assert.equal(data.diagnostics.billing_interval_unknown_shops, 1);
    assert.ok(data.warnings.some((line) => line.includes('billing_interval')),
        'A null interval is treated as monthly — right for a real monthly plan and twelvefold wrong for an '
        + 'annual subscriber on a row synced before the field was captured. Counting those rows turns a '
        + 'footnote nobody can act on into a number a reader can check against their own plan mix.');
});


/* ==========================================================================
 *  6. The states, the clamp, and the refusals
 * ========================================================================== */

test('no watermark nulls the summary — the row count cannot tell you it has never been looked at', async () => {
    _reset();
    STATE.app = { ...APP, last_synced_at: null };

    const data = await _read({ months: 4 });
    assert.equal(data.data_state, 'NEVER_SYNCED');
    assert.equal(data.summary, null,
        'The page\'s `isNeverSynced` is `(d) => !d.summary` and its six tiles read `summary.current_mrr` '
        + 'directly, so a zeroed summary renders "Current MRR 0.00" — a checkable, false claim.');
    assert.equal(data.monthly_trend, null);
    assert.ok(data.unknown_reason, 'the banner body, or `dataState.js` prints the SUCCESS message under it.');
});

test('a synced app with an empty subscription ledger is a DIFFERENT answer, and stays READY', async () => {
    _reset();
    STATE.history = [];

    const data = await _read({ months: 4 });
    assert.equal(data.data_state, 'READY',
        'The watermark is set; only the rows are missing, and a row count is not a sync state. Publishing '
        + 'NEVER_SYNCED here would aim the operator at "run a sync" when a sync has already run and found no '
        + 'subscription payouts.');
    assert.equal(data.summary, null, 'but there is still no paying base to measure movement in.');
    assert.ok(data.unknown_reason.includes('subscription'));
});

test('an out-of-range months is CLAMPED and said out loud, never refused', async () => {
    _reset();
    const fixture = _movementFixture();
    STATE.history = fixture.history;
    STATE.app = { ...APP, earliest_transaction_at: _before(fixture.buckets[0].start, 60) };

    const data = await _read({ months: 500 });
    assert.equal(data.months, 36, 'the endpoint\'s ceiling, mirroring the page\'s own `dateRangeToMonths`.');
    assert.ok(data.warnings.some((line) => line.includes('500')),
        'A chart silently showing 36 months when 200 were asked for is a chart whose x-axis nobody checked.');
    assert.equal(new Set(data.notes).size, data.notes.length,
        'and the notes are UNIQUE: the page renders them as a list, and a repeated sentence is noise.');
    assert.equal(new Set(data.warnings).size, data.warnings.length);
});

test('every caveat reaches `notes`, which is the page\'s ONLY prose channel', async () => {
    _reset();
    const fixture = _movementFixture();
    STATE.history = fixture.history;
    STATE.app = { ...APP, earliest_transaction_at: _before(fixture.buckets[0].start, 60) };

    const data = await _read({ months: 500 });
    for (const warning of data.warnings) {
        assert.ok(data.notes.includes(warning),
            'The Revenue Churn page renders `data.notes` and has NO warnings banner at all, so a caveat that '
            + 'reaches only `warnings[]` reaches no operator.');
    }
    assert.ok(data.notes.some((line) => line.includes('NOT floored at zero')),
        'and the methodology states the sign convention, because the tile\'s own caption ("0 means expansion '
        + '≥ churn") is left over from an implementation that clamped it.');
});

test('the refusals are the named ones, and every other empty is a 200', async () => {
    _reset();
    const noUser = await getRevenueChurn({}, { partner_app_id: 'app-1' });
    assert.equal(noUser.status, false);

    const noApp = await getRevenueChurn({ user_id: 'operator-1' }, {});
    assert.equal(noApp.status, false);
    assert.ok(noApp.msg.includes('partner_app_id'), 'the message has to say what to do next.');

    STATE.app = null;
    const missing = await getRevenueChurn({ user_id: 'operator-1' }, { partner_app_id: 'nope' });
    assert.equal(missing.status, false);
    _reset();
});
