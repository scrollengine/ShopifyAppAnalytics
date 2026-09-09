'use strict';

/**
 * ============================================================================
 *  TRIAL OUTCOMES & TRIAL TREND — the four ways to fabricate a conversion
 * ============================================================================
 *
 *  Exercises `getTrialOutcomes` and `getTrialTrend` end to end with the repositories stubbed out, so
 *  the whole assembly — event pull → charge cohort → state machine → window fold → breakdown, rate,
 *  rows and warnings — runs against fixtures with no database.
 *
 *  ── 1. CONVERSION IS A DATE COMPARISON, NOT AN EVENT ────────────────────────────────────────
 *
 *  A merchant converted if they were STILL AROUND WHEN THE TRIAL RAN OUT. `signed-up` below has a
 *  `SUBSCRIPTION_CHARGE_ACCEPTED` event inside the window and a billing date AFTER the judgement
 *  instant: they subscribed, and they have not converted. Counting the EVENT instead marks every
 *  trialling shop as converted the moment they sign up — it pushes the rate towards 100%, it hides
 *  trial abandonment completely, and the number it produces looks entirely plausible.
 *
 *  ── 2. THE UNDECIDED ARE EXCLUDED FROM BOTH SIDES OF THE RATE ───────────────────────────────
 *
 *  Three of the six shops in the fixture are still inside their trial. The rate is 2/3, not 2/6. A
 *  subscription that has not had the CHANCE to convert is not a failure, and counting it as one
 *  understates the rate by exactly the proportion of the cohort that is recent — which is largest on
 *  the windows an operator actually looks at.
 *
 *  ── 3. TRIAL ABANDONMENT IS NOT POST-CONVERSION CHURN ───────────────────────────────────────
 *
 *  `abandoned` left on day four of its trial and never paid a cent; `lapsed` paid and cancelled two
 *  weeks later. They are counted under different states, they are never summed, and only the first
 *  is in `cancellation_rollup`. Collapsing them turns a trial-quality problem into a retention
 *  problem, or the reverse.
 *
 *  ── 4. AN UNMEASURED MONTH IS `null`, NEVER `0` ────────────────────────────────────────────
 *
 *  The page plots the rate on a Recharts `<Line connectNulls={false}>` precisely so an unmeasured
 *  month BREAKS THE LINE instead of drawing a 0% conversion point, and its month table tones a rate
 *  below 20 as `critical`. A manufactured zero is therefore printed in red as a verdict on a number
 *  that does not exist. Two months here have no rate — one whose cohort is entirely undecided, and
 *  one the stored event history does not reach — and both must publish `null`.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mongoose = require('mongoose');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const MODULE_ROOT = path.join(BACKEND_ROOT, 'src', 'modules', 'conversion');

/** Never reached — nothing here issues a query — but a short buffer keeps a mistake from hanging. */
mongoose.set('bufferTimeoutMS', 400);

const installCohortRepository = require(path.join(MODULE_ROOT, 'repositories', 'installCohort.repository.ts'));
const customFunnelRepository = require(path.join(MODULE_ROOT, 'repositories', 'customFunnel.repository.ts'));

const _at = (iso) => new Date(iso);
const _DAY_MS = 24 * 60 * 60 * 1000;
const _daysAgo = (days) => new Date(Date.now() - days * _DAY_MS);
const _daysAhead = (days) => new Date(Date.now() + days * _DAY_MS);
/** `YYYY-MM`, UTC — the same key `helpers/monthBucket.helper` files a bucket under. */
const _monthKey = (at) => `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * A subscription START event.
 *
 * `billingOn` is Shopify's own first-billing date and IS the trial end. Whether it sits before or
 * after the judgement instant is the entire difference between PAYING and ON_TRIAL — which is what
 * makes conversion a date comparison rather than an event.
 */
const _accepted = (domain, chargeId, occurredAt, billingOn, plan = 'Pro', price = '29.00') => ({
    event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED',
    shop_domain: domain,
    charge_id: chargeId,
    occurred_at: occurredAt,
    raw_event: {
        charge: {
            id: `gid://shopify/AppSubscription/${chargeId}`,
            name: plan,
            billingOn: billingOn === null ? undefined : billingOn.toISOString(),
            test: false,
            amount: { amount: price, currencyCode: 'USD' }
        }
    }
});

/** A subscription END event. `UNINSTALL` carries no charge block at all — a RELATIONSHIP event. */
const _ended = (domain, chargeId, occurredAt, type = 'SUBSCRIPTION_CHARGE_CANCELLED') => ({
    event_type: type,
    shop_domain: domain,
    charge_id: type === 'UNINSTALL' ? '' : chargeId,
    occurred_at: occurredAt,
    raw_event: type === 'UNINSTALL' ? {} : { charge: { id: `gid://shopify/AppSubscription/${chargeId}`, test: false } }
});

const APP = {
    _id: 'app-1',
    display_name: 'Demo App',
    last_synced_at: _at('2026-09-01T00:00:00.000Z'),
    earliest_event_at: _at('2024-01-01T00:00:00.000Z'),
    earliest_transaction_at: _at('2024-01-01T00:00:00.000Z'),
    lifetime_sync_completed_at: _at('2026-09-01T00:00:00.000Z'),
    event_history_gap_days: 0
};

/** The window every trial-outcomes fixture sits inside. `until` is also the judgement instant. */
const WINDOW = { partner_app_id: 'app-1', since: '2026-08-01', until: '2026-08-31' };

/**
 * Six subscriptions inside the window, one per interesting outcome, plus one OUTSIDE it.
 *
 *   paying        billingOn in the past, no end event         -> PAYING
 *   signed-up     billingOn AFTER the judgement instant       -> ON_TRIAL   (the date comparison)
 *   on-trial-2/3  the same                                    -> ON_TRIAL
 *   abandoned     uninstalled BEFORE its billing date         -> CHURNED_DURING_TRIAL
 *   lapsed        cancelled AFTER its billing date            -> CHURNED_AFTER_TRIAL
 *   older         started in May, still paying                -> PAYING, but OUTSIDE the cohort
 *
 * `older` is what proves the event pull carries no lower bound while the COHORT is windowed: it must
 * be folded (so it can be counted app-wide) and must not appear in the window's counts.
 */
const EVENTS = [
    _accepted('paying.myshopify.com', '100', _at('2026-08-05T10:00:00.000Z'), _at('2026-08-12T00:00:00.000Z')),
    _accepted('signed-up.myshopify.com', '200', _at('2026-08-28T10:00:00.000Z'), _at('2026-09-04T00:00:00.000Z'), 'Starter', '9.00'),
    _accepted('on-trial-2.myshopify.com', '500', _at('2026-08-29T10:00:00.000Z'), _at('2026-09-05T00:00:00.000Z'), 'Starter', '9.00'),
    _accepted('on-trial-3.myshopify.com', '600', _at('2026-08-30T10:00:00.000Z'), _at('2026-09-06T00:00:00.000Z'), 'Starter', '9.00'),
    _accepted('abandoned.myshopify.com', '300', _at('2026-08-06T10:00:00.000Z'), _at('2026-08-13T00:00:00.000Z')),
    _ended('abandoned.myshopify.com', '300', _at('2026-08-10T09:00:00.000Z'), 'UNINSTALL'),
    _accepted('lapsed.myshopify.com', '400', _at('2026-08-02T10:00:00.000Z'), _at('2026-08-09T00:00:00.000Z')),
    _ended('lapsed.myshopify.com', '400', _at('2026-08-25T09:00:00.000Z')),
    _accepted('older.myshopify.com', '700', _at('2026-05-01T10:00:00.000Z'), _at('2026-05-08T00:00:00.000Z'))
];

/**
 * ⚠️ The stubs are installed BEFORE the services are required, and read mutable state afterwards.
 * Every service in this codebase destructures its repository at MODULE LOAD, so re-assigning a
 * repository export after the service has been required has no effect at all — a test that did that
 * would pass while asserting nothing. The cohort RESOLVER destructures too, which is why the
 * custom-funnel repository is stubbed here rather than the resolver.
 */
const STATE = {
    app: APP,
    events: EVENTS,
    settled: { charge_ids: [], shop_domains: [] },
    /** The last query the event pull was handed, so its bounds can be asserted. */
    eventQuery: null
};

const _reset = () => {
    STATE.app = APP;
    STATE.events = EVENTS;
    STATE.settled = { charge_ids: [], shop_domains: [] };
    STATE.eventQuery = null;
};

installCohortRepository.findPartnerAppById = async () => STATE.app;

/**
 * THIS STUB APPLIES THE `occurred_at: { $lte: until }` BOUND ITSELF.
 *
 * A stub that returned every fixture row regardless would keep passing with the bound deleted from
 * the real `$match` — and that bound is what stops an event dated after the window from classifying
 * a row inside it.
 */
customFunnelRepository.findChargeCohortEvents = async (query) => {
    STATE.eventQuery = query || null;
    const until = query && query.until instanceof Date ? query.until.getTime() : null;
    if (until === null) {
        return STATE.events;
    }
    return STATE.events.filter((row) => new Date(row.occurred_at).getTime() <= until);
};
customFunnelRepository.aggregateSettledSubscriptionEvidence = async () => STATE.settled;

const { getTrialOutcomes } = require(path.join(MODULE_ROOT, 'services', 'trialOutcome.service.ts'));
const { getTrialTrend } = require(path.join(MODULE_ROOT, 'services', 'trialTrend.service.ts'));

/**
 * Calls trial outcomes and asserts it did not refuse.
 *
 * @param {Object} [params] - Extra query parameters merged over the fixture window.
 * @returns {Promise<Object>} The payload.
 */
const _readOutcomes = async (params = {}) => {
    const result = await getTrialOutcomes({ user_id: 'operator-1' }, { ...WINDOW, ...params });
    assert.equal(result.status, true, `the service refused: ${result.msg}`);
    return result.data;
};

/**
 * Calls the trend and asserts it did not refuse.
 *
 * @param {Object} [params] - Query parameters.
 * @returns {Promise<Object>} The payload.
 */
const _readTrend = async (params = {}) => {
    const result = await getTrialTrend({ user_id: 'operator-1' }, { partner_app_id: 'app-1', ...params });
    assert.equal(result.status, true, `the service refused: ${result.msg}`);
    return result.data;
};

/** One breakdown row by state. */
const _row = (data, state) => data.breakdown.find((entry) => entry.state === state);
/** One cohort shop row by domain. */
const _shop = (data, domain) => data.shops.find((entry) => entry.shop_domain === domain);
/** One trend month by `YYYY-MM`. */
const _month = (data, key) => data.monthly_trend.find((entry) => entry.month === key);


/* ==========================================================================
 *  1. Conversion is a DATE COMPARISON, not an event
 * ========================================================================== */

test('a shop that signed up but is STILL IN TRIAL is not converted', async () => {
    _reset();
    const data = await _readOutcomes();

    const signedUp = _shop(data, 'signed-up.myshopify.com');
    assert.ok(signedUp, 'the shop subscribed inside the window, so it must be in the cohort at all.');
    assert.equal(signedUp.state, 'ON_TRIAL',
        'Its SUBSCRIPTION_CHARGE_ACCEPTED event is inside the window and its billing date is after the '
        + 'judgement instant. Reading the event as the conversion marks every trialling shop as converted '
        + 'the moment it signs up.');
    assert.equal(signedUp.trial_ends_at, _at('2026-09-04T00:00:00.000Z').toISOString(),
        'The trial end is Shopify\'s own billingOn, published so the date comparison is checkable.');
    assert.equal(signedUp.churned_at, null);

    assert.equal(data.total_shops_in_cohort, 6, 'Six subscriptions started their trial inside the window.');
    assert.equal(data.converted_count, 2,
        'Only `paying` and `lapsed` reached their billing date. Counting the subscription EVENT would make '
        + 'this 6 — a 100% trial-to-paid rate that looks entirely plausible.');
    assert.equal(data.still_on_trial, 3);
    assert.equal(_row(data, 'ON_TRIAL').count, 3);
    assert.equal(_row(data, 'PAYING').count, 1);
});

test('the cohort is windowed but the event pull is NOT — a shop that subscribed earlier is still folded', async () => {
    _reset();
    const data = await _readOutcomes();

    assert.equal(data.diagnostics.subscriptions_app_wide, 7,
        'Seven subscriptions exist app-wide; the window holds six. A pull bounded below would lose the '
        + 'seventh entirely, and a shop that subscribed before the window would read as never having '
        + 'subscribed at all.');
    assert.equal(_shop(data, 'older.myshopify.com'), undefined,
        'It is folded and counted app-wide, but its trial started in May — it is not in an August cohort.');

    assert.ok(STATE.eventQuery, 'the event pull was never issued.');
    assert.equal(Object.hasOwn(STATE.eventQuery, 'since'), false,
        'THE PULL MUST CARRY NO LOWER BOUND. A subscription that matters to this window may have started at '
        + 'any point before it.');
    assert.ok(STATE.eventQuery.until instanceof Date, 'and it must be bounded ABOVE at the judgement instant.');
});


/* ==========================================================================
 *  2. The undecided are excluded from BOTH sides of the rate
 * ========================================================================== */

test('subscriptions still in trial are excluded from both sides of the trial-to-paid rate', async () => {
    _reset();
    const data = await _readOutcomes();

    assert.equal(data.decided_count, 3, 'trial_started (6) − still_on_trial (3).');
    assert.equal(data.rate_basis, 'decided');
    assert.equal(data.trial_to_paid_rate, 2 / 3,
        'Two of the three DECIDED trials converted. Counting the undecided as failures would give 2/6 — '
        + 'an understatement by exactly the proportion of the cohort that is recent, which is largest on '
        + 'the windows an operator looks at most.');
    assert.notEqual(data.trial_to_paid_rate, 2 / 6,
        'This is the exact wrong answer the decided basis exists to prevent.');
});

test('a cohort in which nothing has decided publishes NO rate — never 0', async () => {
    _reset();
    // Only the three shops whose billing date is after the judgement instant.
    STATE.events = EVENTS.filter((row) => ['200', '500', '600'].includes(row.charge_id));

    const data = await _readOutcomes();
    assert.equal(data.total_shops_in_cohort, 3);
    assert.equal(data.still_on_trial, 3);
    assert.equal(data.decided_count, 0);
    assert.equal(data.trial_to_paid_rate, null,
        '0.0% beside the words "Trial → Paid rate" is a claim that every merchant who finished a trial '
        + 'declined, made about a cohort where nobody has finished one.');
    assert.ok(
        data.warnings.some((line) => line.includes('still inside its trial')),
        'and the reader is told WHY the figure is blank.'
    );
});


/* ==========================================================================
 *  3. Trial abandonment is counted separately from post-conversion churn
 * ========================================================================== */

test('leaving DURING a trial and leaving AFTER converting are different states, never summed', async () => {
    _reset();
    const data = await _readOutcomes();

    const abandoned = _shop(data, 'abandoned.myshopify.com');
    const lapsed = _shop(data, 'lapsed.myshopify.com');
    assert.equal(abandoned.state, 'CHURNED_DURING_TRIAL',
        'It uninstalled on the 10th against a billing date of the 13th — it never paid us a cent.');
    assert.equal(lapsed.state, 'CHURNED_AFTER_TRIAL',
        'It cancelled on the 25th against a billing date of the 9th — it paid, then left.');

    assert.equal(_row(data, 'CHURNED_DURING_TRIAL').count, 1);
    assert.equal(_row(data, 'CHURNED_AFTER_TRIAL').count, 1);
    assert.notEqual(_row(data, 'CHURNED_DURING_TRIAL').state, _row(data, 'CHURNED_AFTER_TRIAL').state,
        'One number for both would turn a trial-quality problem into a retention problem, or the reverse.');

    assert.equal(data.cancellation_rollup.count, 1,
        'The trial-side rollup holds ONLY the merchant who never paid.');
    assert.deepEqual([...data.cancellation_rollup.states], ['CHURNED_DURING_TRIAL'],
        'and it names what went into it, so the reader can check the rollup rather than trust it.');

    assert.equal(data.converted_count, 2,
        'A merchant who converted and later left DID convert. Counting only the ones still with us would '
        + 'move every trial-to-paid rate down by the churn rate — and the number would fall over time for '
        + 'a cohort that cannot change.');
    assert.deepEqual([...data.converted_states], ['PAYING', 'CHURNED_AFTER_TRIAL'],
        'and the payload NAMES what that total is the sum of, so the half a reader is most likely to '
        + 'doubt is checkable against the response rather than against a comment.');
});

test('the four states are enumerated with their zeros, and every count is a BARE NUMBER', async () => {
    _reset();
    STATE.events = EVENTS.filter((row) => row.charge_id === '100');

    const data = await _readOutcomes();
    assert.deepEqual(
        data.breakdown.map((row) => row.state),
        ['ON_TRIAL', 'PAYING', 'CHURNED_DURING_TRIAL', 'CHURNED_AFTER_TRIAL'],
        'Every state present, in journey order. The page answers `{count: 0}` for a row it cannot see, '
        + 'which is indistinguishable from a state the service forgot.'
    );
    for (const row of data.breakdown) {
        assert.equal(typeof row.count, 'number',
            'An envelope here renders as an em dash — the page formatters do Number(n).');
        assert.ok(typeof row.pct === 'number' || row.pct === null);
    }
    assert.equal(_row(data, 'CHURNED_AFTER_TRIAL').count, 0, 'a real zero, published rather than omitted.');
    assert.equal(typeof data.total_shops_in_cohort, 'number');
    assert.equal(typeof data.decided_count, 'number');
});

test('pct is null — never 0 — for an EMPTY cohort, and the endpoint still answers 200', async () => {
    _reset();
    STATE.events = [];

    const data = await _readOutcomes();
    assert.equal(data.total_shops_in_cohort, 0, 'a measured zero: a sync HAS completed.');
    assert.equal(data.data_state, 'READY');
    assert.equal(data.unknown_reason, undefined, 'READY must not carry the NEVER_SYNCED banner body.');
    for (const row of data.breakdown) {
        assert.equal(row.count, 0);
        assert.equal(row.pct, null, '0/0 is a rate nobody measured, not "0% of the cohort".');
    }
    assert.equal(data.trial_to_paid_rate, null);
    assert.deepEqual(data.shops, []);
});


/* ==========================================================================
 *  4. The response contract the page renders from
 * ========================================================================== */

test('a trial end Shopify never sent is null — never an assumed date', async () => {
    _reset();
    STATE.events = [_accepted('no-billing.myshopify.com', '900', _at('2026-08-04T10:00:00.000Z'), null)];

    const data = await _readOutcomes();
    const row = _shop(data, 'no-billing.myshopify.com');
    assert.equal(row.trial_ends_at, null,
        'An assumed date sits in the table beside real ones, in the same format, with nothing to mark it — '
        + 'and a reader plans around it.');
    assert.equal(row.trial_days_source, 'none');
    assert.equal(row.state, 'ON_TRIAL');
    assert.equal(row.state_basis, 'inferred', 'no billing date and no settled payout — the one guess.');
    assert.ok(
        data.warnings.some((line) => line.includes('weakest evidence available')),
        'and the guess is counted and said out loud.'
    );
});

test('the drawer identity is published, and it is the one the drawer can actually resolve', async () => {
    _reset();
    const data = await _readOutcomes();

    assert.equal(data.shop_identity, 'shop_domain',
        'The frontend hook records that `shop_id` means different things per endpoint. `shop_id` here is '
        + 'the subscription BUCKET KEY, which the detail endpoint cannot resolve.');
    const row = _shop(data, 'paying.myshopify.com');
    assert.equal(row.shop_id, 'chg:100', 'the bucket key, honestly shaped rather than dressed as a shop id.');
    assert.ok(row.shop_domain.endsWith('.myshopify.com'));
    assert.equal(typeof row.price, 'number',
        'This page\'s money column is `price`; the install-cohort table\'s is `plan_price`. One value, one '
        + 'spelling per consumer.');
});

test('warnings are UNIQUE — React keys them by content, so a duplicate DROPS one', async () => {
    _reset();
    const data = await _readOutcomes();
    assert.equal(new Set(data.warnings).size, data.warnings.length);
    for (const line of data.warnings) {
        assert.equal(typeof line, 'string');
        assert.ok(line.length > 0);
    }
    assert.ok(Array.isArray(data.notes) && data.notes.length > 0,
        'The methodology notes are published rather than typed into the page: the definition of "converted" '
        + 'has changed twice, and a note typed into a page cannot follow it.');
    assert.equal(new Set(data.notes).size, data.notes.length);
});

test('NEVER_SYNCED nulls the breakdown and carries the banner body — the row count cannot tell', async () => {
    _reset();
    STATE.app = { ...APP, last_synced_at: null };
    STATE.events = [];

    const result = await getTrialOutcomes({ user_id: 'operator-1' }, WINDOW);
    assert.equal(result.status, true, 'Empty is a 200. A refusal renders as a banner about the .env file.');
    const data = result.data;
    assert.equal(data.data_state, 'NEVER_SYNCED');
    assert.equal(data.breakdown, null,
        'The page tests `!Array.isArray(d.breakdown)`. An EMPTY ARRAY is a measured empty and would render '
        + 'four hard zeros beside a blank rate.');
    assert.equal(data.total_shops_in_cohort, null);
    assert.equal(data.trial_to_paid_rate, null);
    assert.ok(data.unknown_reason && data.unknown_reason.length > 0,
        'Without this the banner body falls back to `resp.msg` and prints "Trial outcomes resolved." under '
        + 'the heading "Nothing synced yet".');
});

test('the refusals are the four named ones, and each carries an actionable sentence', async () => {
    _reset();
    const noUser = await getTrialOutcomes({}, WINDOW);
    assert.equal(noUser.status, false);
    assert.ok(noUser.msg.includes('User ID'));

    const noApp = await getTrialOutcomes({ user_id: 'operator-1' }, { partner_app_id: '' });
    assert.equal(noApp.status, false);
    assert.ok(noApp.msg.includes('partner_app_id'));

    STATE.app = null;
    const missing = await getTrialOutcomes({ user_id: 'operator-1' }, WINDOW);
    assert.equal(missing.status, false);
    assert.ok(missing.msg.includes('not found'));
    _reset();
});


/* ==========================================================================
 *  5. The trend: an unmeasured month is null, never 0
 * ========================================================================== */

/**
 * Three subscriptions placed by RELATIVE date, because the trend's judgement instant is `new Date()`.
 *
 *   this month     billing date a week out          -> ON_TRIAL, so the month has NOTHING decided
 *   ~200 days ago  billing date 193 days ago        -> PAYING
 *   ~200 days ago  uninstalled before that date     -> CHURNED_DURING_TRIAL
 */
const _trendEvents = () => {
    const nowish = new Date(Date.now() - 5 * 60 * 1000);
    const old = _daysAgo(200);
    return {
        nowish,
        old,
        events: [
            _accepted('fresh.myshopify.com', '1100', nowish, _daysAhead(7), 'Starter', '9.00'),
            _accepted('converted.myshopify.com', '1200', old, _daysAgo(193)),
            _accepted('quit.myshopify.com', '1300', old, _daysAgo(193)),
            _ended('quit.myshopify.com', '1300', _daysAgo(195), 'UNINSTALL')
        ]
    };
};

test('a month with nothing decided publishes NO rate — the line breaks rather than plotting 0%', async () => {
    _reset();
    const fixture = _trendEvents();
    STATE.events = fixture.events;
    STATE.app = { ...APP, earliest_event_at: _daysAgo(400) };

    const data = await _readTrend({ months: 12 });
    const current = _month(data, _monthKey(fixture.nowish));
    assert.ok(current, 'the current month must be the newest bucket.');
    assert.equal(current.measurable, true);
    assert.equal(current.trial_starts, 1, 'a MEASURED count — one trial started.');
    assert.equal(current.in_trial, 1);
    assert.equal(current.decided, 0);
    assert.equal(current.trial_to_paid_rate, null,
        'A 0 here draws a 0% conversion point on the operator\'s funnel and the month table prints it in '
        + 'RED, because `null < 20` is true and the page tones a rate below 20 as critical.');
    assert.equal(current.rate_basis, 'unavailable');
    assert.equal(typeof current.cohort_aged_days, 'number',
        'ALWAYS a number: the page computes `is_aging: r.cohort_aged_days < 90`, and `null < 90` is TRUE.');
});

test('a month with decided trials publishes a real rate, and the stack partitions the cohort', async () => {
    _reset();
    const fixture = _trendEvents();
    STATE.events = fixture.events;
    STATE.app = { ...APP, earliest_event_at: _daysAgo(400) };

    const data = await _readTrend({ months: 12 });
    const older = _month(data, _monthKey(fixture.old));
    assert.ok(older, 'the 200-days-ago cohort must have a bucket.');
    assert.equal(older.trial_starts, 2);
    assert.equal(older.converted, 1);
    assert.equal(older.cancelled, 1, 'the trend\'s wire name for CHURNED_DURING_TRIAL.');
    assert.equal(older.in_trial, 0);
    assert.equal(older.decided, 2);
    assert.equal(older.trial_to_paid_rate, 0.5, 'a FRACTION — the page multiplies it by 100 itself.');

    for (const month of data.monthly_trend) {
        if (!month.measurable) {
            continue;
        }
        assert.equal(month.converted + month.in_trial + month.cancelled, month.trial_starts,
            'The chart STACKS these three to the month total, so they must partition the cohort. '
            + '`churned_after_paid` is a SUBSET of `converted` and is a table column for that reason.');
        assert.ok(month.churned_after_paid <= month.converted);
    }
});

test('a month the stored event history does not reach is null — every count, not just the rate', async () => {
    _reset();
    const fixture = _trendEvents();
    STATE.events = fixture.events;
    // The coverage floor sits 40 days back, so the older months were never fetched at all.
    STATE.app = { ...APP, earliest_event_at: _daysAgo(40) };

    const data = await _readTrend({ months: 12 });
    const oldest = data.monthly_trend[0];
    assert.equal(oldest.measurable, false);
    assert.equal(oldest.trial_starts, null,
        'A `trial_starts: 0` for a month nothing was ever fetched for is a claim about the business.');
    assert.equal(oldest.converted, null);
    assert.equal(oldest.in_trial, null);
    assert.equal(oldest.cancelled, null);
    assert.equal(oldest.churned_after_paid, null);
    assert.equal(oldest.decided, null);
    assert.equal(oldest.trial_to_paid_rate, null);
    assert.ok(oldest.unknown_reason && oldest.unknown_reason.length > 0, 'and it says why.');
    assert.equal(typeof oldest.cohort_aged_days, 'number',
        'Still a number on an unmeasured month — otherwise the page badges it "Aging" out of an absence.');

    assert.equal(data.monthly_trend[data.monthly_trend.length - 1].measurable, true,
        'the recent months are inside the covered history and must still be measured.');
    assert.ok(data.diagnostics.unmeasured_months > 0);
    assert.ok(data.warnings.some((line) => line.includes('fall entirely before the earliest Partner event')));
});

test('the trend clamps an out-of-range months and SAYS SO — a typo widens, never empties', async () => {
    _reset();
    const fixture = _trendEvents();
    STATE.events = fixture.events;
    STATE.app = { ...APP, earliest_event_at: _daysAgo(400) };

    const data = await _readTrend({ months: 999 });
    assert.equal(data.months, 36);
    assert.equal(data.monthly_trend.length, 36);
    assert.ok(data.warnings.some((line) => line.includes('outside what this endpoint serves')));

    const junk = await _readTrend({ months: 'banana' });
    assert.equal(junk.months, 12, 'a junk value is the default, not a 400 and not an empty chart.');
});

test('the trend never re-classifies: one cohort, folded once per month', async () => {
    _reset();
    const fixture = _trendEvents();
    STATE.events = fixture.events;
    STATE.app = { ...APP, earliest_event_at: _daysAgo(400) };

    const data = await _readTrend({ months: 12 });
    const measured = data.monthly_trend.filter((month) => month.measurable);
    const totalStarts = measured.reduce((sum, month) => sum + month.trial_starts, 0);
    assert.equal(totalStarts, 3,
        'Every subscription belongs to exactly one month — the one its TRIAL STARTED in. A shop counted '
        + 'twice would mean the buckets overlap at their boundary.');
    assert.equal(new Set(data.warnings).size, data.warnings.length, 'warnings stay unique.');
    assert.ok(data.note && data.note.length > 0, 'the methodology note is published, not typed into the page.');
});

test('the trend NEVER_SYNCED nulls monthly_trend rather than sending an empty array', async () => {
    _reset();
    STATE.app = { ...APP, last_synced_at: null };
    STATE.events = [];

    const result = await getTrialTrend({ user_id: 'operator-1' }, { partner_app_id: 'app-1', months: 12 });
    assert.equal(result.status, true);
    assert.equal(result.data.monthly_trend, null,
        'The page tests `!Array.isArray(d.monthly_trend)`. An empty array mounts a titled, axed chart over '
        + 'nothing, which reads as "we measured these months and nothing happened".');
    assert.equal(result.data.data_state, 'NEVER_SYNCED');
    assert.ok(result.data.unknown_reason && result.data.unknown_reason.length > 0);
    _reset();
});
