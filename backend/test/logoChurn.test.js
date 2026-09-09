'use strict';

/**
 * ============================================================================
 *  LOGO CHURN — the artefact that manufactures churn out of arithmetic
 * ============================================================================
 *
 *  Exercises `getLogoChurn` end to end with the ledger read and the event pull stubbed out. The
 *  as-of predicate itself — `liveSetAsOf` in `modules/revenue` — is NOT stubbed and must not be:
 *  the whole point of this endpoint is that its membership comes through the canonical definition of
 *  "who is paying us", so a test that replaced it would prove nothing about the thing most likely to
 *  go wrong.
 *
 *  ── 1. CALENDAR-MONTH MEMBERSHIP MANUFACTURES CHURN ─────────────────────────────────────────
 *
 *  12 × 30 = 360, so a shop on a 30-day billing cycle SKIPS ONE CALENDAR MONTH. Membership defined
 *  as "had a settled charge inside calendar month M" reports that shop as CHURNED in the skipped
 *  month and NEW the month after — falsely churning a slice of the paying base every month, out of
 *  arithmetic rather than out of anything a merchant did, and drawing a chart that looks entirely
 *  plausible. The first fixture below builds exactly that shape: one calendar month with no charge
 *  in it, bracketed by charges 31 days apart. Every month must still report zero churn.
 *
 *  The as-of window is what prevents it, and its value is load-bearing in both directions: the
 *  config comment records that too narrow produced a measured 47.6% churn reading for a month in
 *  which nobody cancelled, and removed entirely produced $45M of MRR against $10K of settled
 *  payouts.
 *
 *  ── 2. `summary` AND `monthly_trend` FAIL SEPARATELY ────────────────────────────────────────
 *
 *  They are two different measurements — four instants versus every month boundary in the range —
 *  and the page has a `_trendDataState` gate built for the case where one is publishable and the
 *  other is not. A response that could only fail as a whole would make that gate unreachable and the
 *  page would mount a titled, axed chart over an empty array, which reads as "we measured these
 *  months and nothing moved".
 *
 *  ── 3. A RATE WITH AN EMPTY DENOMINATOR IS `null`, NEVER `0` ────────────────────────────────
 *
 *  `null * 100 === 0` in JavaScript, which is why the page has a `_ratePct` helper at all. A `0`
 *  churn rate for a month in which nobody was paying is a claim of perfect retention.
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
// The module barrel, not the repository behind it: the service destructures from the BARREL at load,
// and the barrel captured its own reference to the repository function when IT loaded. Stubbing the
// repository afterwards would leave the barrel — and therefore the service — on the real one.
const revenueModule = require(path.join(BACKEND_ROOT, 'src', 'modules', 'revenue', 'index.ts'));
const monthBucketHelper = require(path.join(MODULE_ROOT, 'helpers', 'monthBucket.helper.ts'));

const { buildMonthBuckets } = monthBucketHelper;
const WINDOW_DAYS = config.REVENUE.ACTIVE_SUB_WINDOW_DAYS;

const _DAY_MS = 24 * 60 * 60 * 1000;
const _at = (iso) => new Date(iso);
const _daysAgo = (days) => new Date(Date.now() - days * _DAY_MS);

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
    settled: { charge_ids: [], shop_domains: [] },
    /** The last query the ledger read was handed, so its shape can be asserted. */
    historyQuery: null
};

const _reset = () => {
    STATE.app = APP;
    STATE.history = [];
    STATE.events = [];
    STATE.settled = { charge_ids: [], shop_domains: [] };
    STATE.historyQuery = null;
};

installCohortRepository.findPartnerAppById = async () => STATE.app;
customFunnelRepository.findChargeCohortEvents = async () => STATE.events;
customFunnelRepository.aggregateSettledSubscriptionEvidence = async () => STATE.settled;
revenueModule.fetchSubscriptionChargeHistory = async (query) => {
    STATE.historyQuery = query || null;
    return STATE.history;
};

const { getLogoChurn } = require(path.join(MODULE_ROOT, 'services', 'logoChurn.service.ts'));

/**
 * Calls the endpoint and asserts it did not refuse.
 *
 * @param {Object} [params] - Query parameters.
 * @returns {Promise<Object>} The payload.
 */
const _read = async (params = {}) => {
    const result = await getLogoChurn({ user_id: 'operator-1' }, { partner_app_id: 'app-1', ...params });
    assert.equal(result.status, true, `the service refused: ${result.msg}`);
    return result.data;
};

/**
 * A ~30-day biller whose charges SKIP one calendar month entirely.
 *
 * Built against the very buckets the endpoint will walk, so the skipped month is a FACT OF THE
 * FIXTURE rather than an accident of the date the suite happens to run on — a fixture that relied on
 * the natural drift of a 30-day cycle would only exhibit the artefact for some run dates, and would
 * pass vacuously on the others.
 *
 * The phase is late-in-the-month before the gap and early-in-the-month after it, so EVERY
 * consecutive pair of charges is 28–33 days apart — a real merchant's cadence, comfortably inside
 * the as-of window and comfortably invisible to anything that counts charges per calendar month.
 * The bridging pair spans `len(skipped month) + 2` days, which is the whole shape of the bug:
 * roughly one cycle, and one calendar month with nothing in it.
 *
 * @param {Number} months - How many buckets to fill.
 * @returns {Object} The history rows, the buckets, and the month key that carries no charge.
 */
const _cyclerFixture = (months) => {
    const asOf = new Date();
    const buckets = buildMonthBuckets({ as_of: asOf, months });
    // Far enough in that its boundaries are supported by the stored history, and not the last month,
    // which is partial.
    const skippedIndex = Math.floor(buckets.length / 2);

    const rows = [];
    buckets.forEach((bucket, index) => {
        if (index === skippedIndex) {
            return;
        }
        // Late in the month before the gap, early in the month after it. One phase change, placed
        // AT the gap, so no other pair of charges is more than ~31 days apart.
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
 *  1. The calendar-month artefact does not occur
 * ========================================================================== */

test('a 30-day billing cycle that skips a calendar month reports NO churn in it', async () => {
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
        'The fixture must contain a calendar month with no settled charge in it, or there is no artefact '
        + 'to be immune to.');
    // …and it must be a genuine BILLING CYCLE that skips it, not a merchant who stopped paying for
    // two months. Every consecutive pair, the bridging one included, is roughly one cycle apart.
    const ascending = [...fixture.history].reverse();
    for (let i = 1; i < ascending.length; i += 1) {
        const gapDays = (ascending[i].created_at.getTime() - ascending[i - 1].created_at.getTime()) / _DAY_MS;
        assert.ok(gapDays >= 27 && gapDays <= 34,
            `charges ${i - 1}→${i} are ${gapDays} days apart — that is not a 30-day cycle.`);
    }

    const data = await _read({ months: 12 });
    const skipped = data.monthly_trend.find((month) => month.month === fixture.skippedMonth);
    assert.ok(skipped, 'the skipped month must still be a bucket in the series.');
    assert.equal(skipped.measurable, true);
    assert.equal(skipped.active_at_start, 1,
        'The shop was paying throughout. Calendar-month membership would report 0 here.');
    assert.equal(skipped.active_at_end, 1);
    assert.equal(skipped.churned_in_month, 0,
        'THE ARTEFACT. Membership defined as "billed inside this calendar month" reports this shop as '
        + 'churned here and new the month after — falsely churning a slice of the base every month out of '
        + 'arithmetic. An as-of window wider than the billing cycle cannot produce it.');
    assert.equal(skipped.churn_rate, 0, 'a MEASURED zero: one shop was paying and none of them left.');

    // And the same holds across the whole series, not just at the gap.
    const measured = data.monthly_trend.filter((month) => month.measurable);
    assert.ok(measured.length >= 8, 'most of the range must be measurable, or the assertion below is empty.');
    for (const month of measured) {
        assert.equal(month.churned_in_month, 0, `month ${month.month} reported a churn nobody made.`);
        assert.equal(month.active_at_end, month.active_at_start + month.gained_in_month - month.churned_in_month,
            'the movement must reconcile: consecutive months SHARE a boundary.');
    }
    assert.equal(data.summary.churned_in_30d, 0);
    assert.equal(data.summary.current_active, 1);
});

test('the boundaries the payout history cannot support are null, never 0', async () => {
    _reset();
    const fixture = _cyclerFixture(12);
    STATE.history = fixture.history;
    STATE.app = { ...APP, earliest_transaction_at: fixture.history[fixture.history.length - 1].created_at };

    const data = await _read({ months: 12 });
    const oldest = data.monthly_trend[0];
    assert.equal(oldest.measurable, false,
        `Deciding who was paying at that boundary needs the ${WINDOW_DAYS} days of payout history before `
        + 'it, and the stored history begins inside that run-up.');
    assert.equal(oldest.active_at_start, null,
        'A 0 there says nobody was paying you, which is a claim about the business rather than about this '
        + 'deployment\'s records.');
    assert.equal(oldest.churned_in_month, null);
    assert.equal(oldest.gained_in_month, null);
    assert.equal(oldest.churn_rate, null);
    assert.ok(oldest.unknown_reason && oldest.unknown_reason.length > 0);
    assert.ok(data.diagnostics.unmeasured_months > 0);
});

test('the as-of window is published, so a reader can see what their figures were measured with', async () => {
    _reset();
    const fixture = _cyclerFixture(12);
    STATE.history = fixture.history;
    STATE.app = { ...APP, earliest_transaction_at: fixture.history[fixture.history.length - 1].created_at };

    const data = await _read({ months: 12 });
    assert.equal(data.summary.active_sub_window_days, WINDOW_DAYS,
        'The value is a MEASUREMENT DECISION, not a tunable — every figure on the page moves with it.');
    assert.ok(data.summary.basis.includes('INSTANT'),
        'and the basis says membership is evaluated at an instant, not per calendar month.');
});


/* ==========================================================================
 *  2. Churn that really happened, and the rows behind it
 * ========================================================================== */

/**
 * Two shops on the ledger.
 *
 *   steady  billed up to 5 days ago    -> inside the window, still paying
 *   left    last billed 45 days ago    -> outside the window now, inside it 30 days ago -> CHURNED
 */
const _churnFixture = () => _newestFirst([
    ...[5, 35, 65, 95, 125, 155, 185].map((d) => _charge('gid://partners/Shop/1', 'steady.myshopify.com', _daysAgo(d))),
    ...[45, 75, 105, 135, 165, 195].map((d) => _charge('gid://partners/Shop/2', 'left.myshopify.com', _daysAgo(d), 49))
]);

test('a shop whose payouts aged out of the window is reported as churned, with a usable identity', async () => {
    _reset();
    STATE.history = _churnFixture();
    STATE.app = { ...APP, earliest_transaction_at: _daysAgo(195) };

    const data = await _read({ months: 6 });
    assert.equal(data.summary.current_active, 1);
    assert.equal(data.summary.active_30d_ago, 2);
    assert.equal(data.summary.churned_in_30d, 1);
    assert.equal(data.summary.churn_rate_30d, 0.5, 'a FRACTION in [0,1] — the page multiplies it itself.');
    assert.equal(data.summary.churned_in_90d, 1);

    assert.equal(data.recent_churned.length, 1);
    const row = data.recent_churned[0];
    assert.equal(row.shop_domain, 'left.myshopify.com');
    assert.equal(data.shop_identity, 'shop_domain',
        'The frontend hook\'s comment calls `shop_id` a tenant id on this page. There is no tenant graph in '
        + 'this build, and a `gid://…` sent as an identity key truncates to the literal string "gid:".');
    assert.equal(row.shop_id, 'gid://partners/Shop/2',
        'Published for the row key and the fallback label, and named honestly.');
    assert.equal(typeof row.paid_days, 'number',
        'ALWAYS a number: the page prints `${r.paid_days} days` with no guard, so a null renders "null days".');
    assert.ok(row.paid_days > 0);
    assert.equal(row.churn_date_basis, 'ledger_window',
        'No cancellation event reached us, so the churn instant is when the last payout aged out — always '
        + 'LATER than the real one, which is why the basis is on the row.');
    assert.ok(data.warnings.some((line) => line.includes('no cancellation event on record')));
});

test('a dated cancellation event beats the derived ledger boundary, and names the plan', async () => {
    _reset();
    STATE.history = _churnFixture();
    STATE.app = { ...APP, earliest_transaction_at: _daysAgo(195) };
    // ⚠️ Captured ONCE. `_daysAgo` reads the clock, so calling it again in the assertion below would
    // compare two instants a few milliseconds apart — a test that fails on timing rather than on
    // behaviour, which is the worst kind to leave in a suite.
    const cancelledAt = _daysAgo(20);
    STATE.events = [
        {
            event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
            shop_domain: 'left.myshopify.com',
            charge_id: '77',
            occurred_at: _daysAgo(200),
            raw_event: {
                charge: {
                    id: 'gid://shopify/AppSubscription/77',
                    name: 'Growth',
                    billingOn: _daysAgo(193).toISOString(),
                    test: false,
                    amount: { amount: '49.00', currencyCode: 'USD' }
                }
            }
        },
        {
            event_type: 'SUBSCRIPTION_CHARGE_CANCELLED',
            shop_domain: 'left.myshopify.com',
            charge_id: '77',
            occurred_at: cancelledAt,
            raw_event: { charge: { id: 'gid://shopify/AppSubscription/77', test: false } }
        }
    ];

    const data = await _read({ months: 6 });
    const row = data.recent_churned[0];
    assert.equal(row.churn_date_basis, 'partner_event', 'a real, dated cancellation is the better answer.');
    assert.equal(row.plan_name, 'Growth', 'read off the subscription\'s own charge, never guessed.');
    assert.ok(row.trial_started_at, 'and the event-side date is published under its own name.');
    assert.equal(new Date(row.churned_at).getTime(), cancelledAt.getTime());

    const plan = data.by_plan.find((entry) => entry.plan_name === 'Growth');
    assert.ok(plan, 'the churn-by-plan table must file it under the plan it was on.');
    assert.equal(plan.churned_in_30d, 1);
    assert.equal(plan.active_30d_ago, 1);
    assert.equal(plan.churn_30d_pct, 1);
});

test('a shop we cannot match to a subscription is bucketed honestly, never under a real plan', async () => {
    _reset();
    STATE.history = _churnFixture();
    STATE.app = { ...APP, earliest_transaction_at: _daysAgo(195) };

    const data = await _read({ months: 6 });
    assert.equal(data.recent_churned[0].plan_name, 'Plan not recorded',
        'Bucketing it under a real plan would move a merchant between plans on the churn-by-plan table — a '
        + 'specific false claim about a specific plan\'s retention.');
    assert.equal(data.diagnostics.churned_shops_without_plan, 1);
    assert.ok(data.warnings.some((line) => line.includes('Plan not recorded')));
});


/* ==========================================================================
 *  3. `summary` and `monthly_trend` fail separately
 * ========================================================================== */

test('the tiles can be published while the trend says plainly that it is unavailable', async () => {
    _reset();
    STATE.history = _churnFixture();
    // Three weeks of stored payout history, twelve months of trend asked for: no month boundary in the
    // range has its lookback covered, and every month would be a fabricated zero.
    STATE.app = { ...APP, earliest_transaction_at: _daysAgo(20) };

    const data = await _read({ months: 12 });
    assert.notEqual(data.summary, null,
        'The page nulls its whole payload on `!d.summary`, so the four tiles must survive this.');
    assert.equal(typeof data.summary.current_active, 'number',
        'The as-of-now figure is deliberately NOT floor-gated: /api/revenue/now publishes the same '
        + 'measurement from the same predicate, and a blank tile beside a number on another page for one '
        + 'measurement is its own kind of wrong.');
    assert.equal(data.summary.churned_in_30d, null,
        'The 30-day boundary is not supported by the stored history, so its tile is blank rather than zero.');
    assert.equal(data.summary.churn_rate_30d, null);

    assert.equal(data.monthly_trend, null,
        'The page has a `_trendDataState` gate for exactly this. An array of twelve unmeasured months '
        + 'would still mount a titled, axed chart.');
    assert.ok(data.trend_unknown_reason && data.trend_unknown_reason.length > 0);
    assert.deepEqual(data.by_plan, [],
        'Churn by plan is measured against who was paying 30 days ago; a table of zeros would read as a '
        + 'set of plans nobody left.');
    assert.ok(data.warnings.some((line) => line.includes('Churn by plan is not published')));
});

test('a churn rate with an empty denominator is null, never 0', async () => {
    _reset();
    // One shop, its only charge four days ago: nobody was paying at any earlier boundary.
    STATE.history = [_charge('gid://partners/Shop/9', 'brand-new.myshopify.com', _daysAgo(4))];
    STATE.app = { ...APP, earliest_transaction_at: _daysAgo(400) };

    const data = await _read({ months: 3 });
    assert.equal(data.summary.current_active, 1);
    assert.equal(data.summary.active_30d_ago, 0, 'a measured zero — the history reaches back far enough.');
    assert.equal(data.summary.churned_in_30d, 0);
    assert.equal(data.summary.churn_rate_30d, null,
        '0/0 is not perfect retention. `null * 100` is 0 in JavaScript, which is why the page has a '
        + '`_ratePct` helper and a `connectNulls={false}` line.');
    assert.equal(data.summary.gained_in_30d, 1);

    const emptyMonths = data.monthly_trend.filter((month) => month.measurable && month.active_at_start === 0);
    assert.ok(emptyMonths.length > 0, 'the fixture must contain a month with nobody paying at its start.');
    for (const month of emptyMonths) {
        assert.equal(month.churn_rate, null);
    }
});


/* ==========================================================================
 *  4. The two kinds of nothing, and the contract
 * ========================================================================== */

test('no watermark nulls the summary — the row count cannot tell you it has never been looked at', async () => {
    _reset();
    STATE.app = { ...APP, last_synced_at: null };

    const result = await getLogoChurn({ user_id: 'operator-1' }, { partner_app_id: 'app-1', months: 12 });
    assert.equal(result.status, true, 'Empty is a 200. A refusal renders as a banner about the .env file.');
    assert.equal(result.data.summary, null);
    assert.equal(result.data.monthly_trend, null);
    assert.equal(result.data.data_state, 'NEVER_SYNCED');
    assert.ok(result.data.unknown_reason.includes('No Partner sync'));
    assert.equal(STATE.historyQuery, null, 'and the ledger is not read at all — nothing could have written it.');
});

test('a synced app with no subscription payouts is a DIFFERENT answer, and says so', async () => {
    _reset();
    STATE.history = [];

    const data = await _read({ months: 12 });
    assert.equal(data.summary, null,
        '"Currently active 0" for an app with no payout ledger is a checkable, false claim about the business.');
    assert.ok(data.unknown_reason.includes('No settled subscription payouts'));
    assert.ok(data.unknown_reason.includes('add-on'),
        'and it says why usage and one-time charges are excluded: buying one add-on is not subscribing.');
    assert.notEqual(data.unknown_reason, undefined);
});

test('the endpoint publishes only customer counts — no amount rides along on a churn row', async () => {
    _reset();
    STATE.history = _churnFixture();
    STATE.app = { ...APP, earliest_transaction_at: _daysAgo(195) };

    const data = await _read({ months: 6 });
    const row = data.recent_churned[0];
    assert.equal(Object.hasOwn(row, 'lost_mrr'), false,
        'Losing ten $9 merchants and losing one $500 merchant are the same revenue event and completely '
        + 'different business events. Money has a page; this one counts logos.');
    assert.equal(Object.hasOwn(data.summary, 'churned_mrr'), false);
    for (const key of ['current_active', 'churned_in_30d', 'churned_in_90d']) {
        assert.ok(typeof data.summary[key] === 'number' || data.summary[key] === null,
            `${key} must be a bare number or null — the page formatters do Number(n).`);
    }
});

test('warnings are UNIQUE, and an out-of-range months is clamped rather than refused', async () => {
    _reset();
    STATE.history = _churnFixture();
    STATE.app = { ...APP, earliest_transaction_at: _daysAgo(195) };

    const data = await _read({ months: 999 });
    assert.equal(data.months, 36);
    assert.equal(new Set(data.warnings).size, data.warnings.length,
        'React keys each warning by its content, so a duplicate is DROPPED along with its condition.');
    assert.ok(data.warnings.some((line) => line.includes('outside what this endpoint serves')));

    const junk = await _read({ months: 'banana' });
    assert.equal(junk.months, 12, 'a typo widens to the default; it never empties the chart.');
});

test('the refusals are the four named ones', async () => {
    _reset();
    const noUser = await getLogoChurn({}, { partner_app_id: 'app-1' });
    assert.equal(noUser.status, false);
    assert.ok(noUser.msg.includes('User ID'));

    const noApp = await getLogoChurn({ user_id: 'operator-1' }, { partner_app_id: '' });
    assert.equal(noApp.status, false);
    assert.ok(noApp.msg.includes('partner_app_id'));

    STATE.app = null;
    const missing = await getLogoChurn({ user_id: 'operator-1' }, { partner_app_id: 'app-1' });
    assert.equal(missing.status, false);
    assert.ok(missing.msg.includes('not found'));
    _reset();
});

/* ==========================================================================
 *  5. The tombstoned shop — a churn instant that outran the judgement instant
 * ========================================================================== */

/**
 *  A CHURN DATE IN THE FUTURE, ON A TABLE CAPTIONED "last 30 days".
 *
 * The ledger-derived churn instant is `last_charged_at + liveWindowDaysFor(...)`, and `shop` comes
 * from `set30` — the live set at `asOf - 30d` — so `last_charged_at` is its newest payout AT OR
 * BEFORE that boundary. That is a DIFFERENT row from the one that decided the shop had left at
 * `asOf`. Whenever the shop left through `liveSetAsOf`'s tombstone branch (`row.gross <= 0`,
 * `ledgerMrr.helper`) rather than by aging out, the sum lands after `asOf`.
 *
 * Reachable from any `APP_SUBSCRIPTION` payout whose newest row is non-positive: a 100%-discounted
 * subscription charge, a negative adjustment filed under the subscription type, or an amount that
 * failed to parse (`revenue.repository` does `Number(...) || 0`, so an unreadable amount tombstones).
 *
 * Verified before the clamp: `churned_at` four days in the FUTURE with `paid_days: 38` over payouts
 * spanning 34. Plain aging-out cannot produce it — there `last_charged_at + window < asOf` by
 * construction, which is why every other fixture in this file misses it.
 */
test('a shop tombstoned by a non-positive charge cannot churn in the future, or be paid for longer than it paid', async () => {
    _reset();
    // +29 at 34 days ago, then a -29 adjustment 5 days ago. The refund is NEWER than `at30`, so the
    // live set at `at30` values the shop off the +29 (34 days back, inside the 38-day window) while
    // the set at `asOf` sees the -29 first and tombstones it. 34 + 38 > 30, so the naive sum is
    // AFTER now.
    STATE.history = _newestFirst([
        _charge('gid://partners/Shop/9', 'refunded.myshopify.com', _daysAgo(34), 29),
        _charge('gid://partners/Shop/9', 'refunded.myshopify.com', _daysAgo(5), -29)
    ]);
    STATE.app = { ...APP, earliest_transaction_at: _daysAgo(400) };

    const data = await _read({ months: 3 });
    assert.equal(data.summary.current_active, 0, 'the non-positive row ends membership at `asOf`.');
    assert.equal(data.recent_churned.length, 1, 'and the shop is on the recently-churned table.');

    const row = data.recent_churned[0];
    assert.equal(row.churn_date_basis, 'ledger_window',
        'no cancellation event reached us, so this is the derived instant — the one that could overrun.');
    assert.ok(new Date(row.churned_at).getTime() <= new Date(data.as_of).getTime(),
        `churned_at (${row.churned_at}) must not be after as_of (${data.as_of}). Membership cannot `
        + 'end after the instant that judged it, and a future date under "Recently churned (last 30 '
        + 'days)" is a specific false claim about a specific merchant.');

    const paidSpanDays = Math.floor(
        (new Date(row.churned_at).getTime() - new Date(row.activated_at).getTime()) / _DAY_MS
    );
    assert.equal(row.paid_days, paidSpanDays,
        'paid_days is derived from the two dates on the row, so clamping one must move the other.');
    assert.ok(row.paid_days <= 34,
        'the payouts span 34 days; 38 would be the un-clamped window charged against a shorter life.');
});

/**
 *  THE HISTORICAL COLUMN, RESTATED IN CURRENT-PLAN TERMS.
 *
 * `subscriptionByDomain` is the cohort's per-domain WINNER — the subscription with the LATEST
 * `trial_start`, i.e. the plan the merchant is on TODAY. Applying it to `set30` as well counted a
 * merchant who moved plans inside the window under their NEW plan in `active_30d_ago`, so the old
 * plan's opening base lost a customer it actually had and the new plan's gained one it did not —
 * and `churn_30d_pct`'s denominator moved with it.
 *
 * The shop below never stops paying, so `active_now`, `churned_in_30d` and both totals are identical
 * either way. Only the bucket the 30-days-ago column files it under changes, which is exactly the
 * defect: nothing about the totals could have caught it.
 */
test('a merchant who switched plans is counted under the plan they held THEN, not the one they hold now', async () => {
    _reset();
    // Paying continuously: newest payout 3 days ago (live now), and one 31 days ago (live at the
    // 30-day boundary, 1 day inside the window).
    STATE.history = _newestFirst(
        [3, 31, 59, 87, 115, 143, 171, 199].map((d) => _charge('gid://partners/Shop/7', 'switcher.myshopify.com', _daysAgo(d)))
    );
    STATE.app = { ...APP, earliest_transaction_at: _daysAgo(210) };
    // Starter ran from 200 days ago until 20 days ago; Pro started when Starter ended. At the
    // 30-days-ago boundary the merchant was on STARTER; today they are on PRO.
    STATE.events = [
        {
            event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
            shop_domain: 'switcher.myshopify.com',
            charge_id: '100',
            occurred_at: _daysAgo(200),
            raw_event: {
                charge: {
                    id: 'gid://shopify/AppSubscription/100',
                    name: 'Starter',
                    billingOn: _daysAgo(193).toISOString(),
                    test: false,
                    amount: { amount: '19.00', currencyCode: 'USD' }
                }
            }
        },
        {
            event_type: 'SUBSCRIPTION_CHARGE_CANCELLED',
            shop_domain: 'switcher.myshopify.com',
            charge_id: '100',
            occurred_at: _daysAgo(20),
            raw_event: { charge: { id: 'gid://shopify/AppSubscription/100', test: false } }
        },
        {
            event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
            shop_domain: 'switcher.myshopify.com',
            charge_id: '200',
            occurred_at: _daysAgo(20),
            raw_event: {
                charge: {
                    id: 'gid://shopify/AppSubscription/200',
                    name: 'Pro',
                    billingOn: _daysAgo(13).toISOString(),
                    test: false,
                    amount: { amount: '49.00', currencyCode: 'USD' }
                }
            }
        }
    ];

    const data = await _read({ months: 6 });
    assert.equal(data.summary.current_active, 1);
    assert.equal(data.summary.active_30d_ago, 1);
    assert.equal(data.summary.churned_in_30d, 0, 'nobody left — this is a plan move, not churn.');

    const pro = data.by_plan.find((row) => row.plan_name === 'Pro');
    const starter = data.by_plan.find((row) => row.plan_name === 'Starter');
    assert.ok(pro, 'the merchant is on Pro today.');
    assert.equal(pro.active_now, 1);
    assert.equal(pro.active_30d_ago, 0,
        'Pro did not have this merchant 30 days ago. Counting them here inflates Pro\'s opening base and '
        + 'deflates the plan they actually left.');

    assert.ok(starter, 'Starter DID have them 30 days ago, so it must appear with its real opening base.');
    assert.equal(starter.active_30d_ago, 1);
    assert.equal(starter.active_now, 0);
    assert.equal(starter.churned_in_30d, 0, 'a plan move is not a churn — the merchant is still paying.');

    // The totals reconcile against `summary` from either attribution, which is why only the split
    // could catch this.
    const totalThen = data.by_plan.reduce((sum, row) => sum + row.active_30d_ago, 0);
    const totalNow = data.by_plan.reduce((sum, row) => sum + row.active_now, 0);
    assert.equal(totalThen, data.summary.active_30d_ago);
    assert.equal(totalNow, data.summary.current_active);
});
