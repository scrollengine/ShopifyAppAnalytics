'use strict';

/**
 * ============================================================================
 *  THE CANCEL TRAP, AND THE `billingOn` GAP — MEASURED, NEVER ACTED ON
 * ============================================================================
 *
 *  Two facts about this data that no figure in the build compensates for, pinned here so that both
 *  the MEASUREMENT and the DELIBERATE ABSENCE OF A CORRECTION are checkable.
 *
 *  ── 1. A PLAN CHANGE IS A CANCELLATION PLUS A NEW TRIAL ───────────────────
 *
 *  Shopify emits an upgrade as a `SUBSCRIPTION_CHARGE_CANCELLED` for the old charge and a
 *  `SUBSCRIPTION_CHARGE_ACCEPTED` for the new one IN THE SAME SECOND —
 *  `modules/partner/services/partnerSync.service.ts` had to put `charge_id` into the event hash for
 *  exactly that reason, or the two collapsed into one stored row. The charge cohort keys per CHARGE,
 *  so one merchant upgrading once produces TWO subscriptions: two trial starts, one end event that
 *  is not a departure and — when the change lands before the old charge's `billingOn` — a
 *  `CHURNED_DURING_TRIAL` booked against the merchant who did the best available thing.
 *
 *  THIS FILE PINS THAT NOTHING IS SUPPRESSED. A merchant who genuinely cancels and re-subscribes
 *  a minute later is byte-identical in this data to one who upgraded, so every available "fix" is a
 *  guess that would move published trial, conversion and churn counts on an inference. The counts
 *  below are asserted at their UNADJUSTED values on purpose: a future Tier 2 that changes them has
 *  to change these assertions deliberately, in a commit that says so, rather than sliding a
 *  correction in under a refactor.
 *
 *  ── 2. `billingOn` IS PUBLISHED AS THE TRIAL END AND IS NOT A TRIAL LENGTH ─
 *
 *  Measured on a live operator database of 38,719 events: `SUBSCRIPTION_CHARGE_ACCEPTED` fired 13
 *  times and carried `billingOn` ZERO times; `SUBSCRIPTION_CHARGE_ACTIVATED` fired 1,632 times and
 *  carried it every time. The gap from that ACTIVATED to the date it announces is BIMODAL — ~854 at
 *  6–7 days, ~547 at 29–30 — and 23 are NEGATIVE. The stored charge has five keys and no
 *  `trialDays`, and the Partner API's `AppSubscription` exposes no more, so a 30-day trial and a
 *  no-trial subscription whose first billing falls one cycle out cannot be told apart.
 *
 *  SO NO THRESHOLD RECLASSIFIES ANYONE. `BILLING_ON_GAP_MAX_PLAUSIBLE_TRIAL_DAYS` buckets a
 *  DIAGNOSTIC and nothing else, and the tests below pin that a 30-day gap is left inside the band
 *  rather than being split out as "not a trial" — because the data does not support that call.
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
const SRC = path.join(BACKEND_ROOT, 'src');
const MODULE_ROOT = path.join(SRC, 'modules', 'conversion');

/** Never reached — nothing here issues a query — but a short buffer keeps a mistake from hanging. */
mongoose.set('bufferTimeoutMS', 400);

// The fold and its vocabulary, by DEEP PATH. Both are pure, so reaching them directly costs no
// database — and reaching them through the module barrel would pull the services in behind them.
const chargeCohortResolver = require(path.join(MODULE_ROOT, 'resolvers', 'chargeCohort.resolver.ts'));
const trialCohortHelper = require(path.join(MODULE_ROOT, 'helpers', 'trialCohort.helper.ts'));
const lifecycleConstants = require(path.join(MODULE_ROOT, 'constants', 'lifecycle.constants.ts'));
const partnerVocab = require(path.join(SRC, 'constants', 'partnerVocab.constants.ts'));

const {
    resolveChargeCohortForDomains,
    describeChargeCohortExposure,
    SUPERSESSION_WINDOW_MS,
    BILLING_ON_GAP_MAX_PLAUSIBLE_TRIAL_DAYS
} = chargeCohortResolver;
const { foldTrialCohort } = trialCohortHelper;
const { SUBSCRIPTION_STATES } = lifecycleConstants;
const { PARTNER_EVENT_TYPES } = partnerVocab;

const ACCEPTED = PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED;
const ACTIVATED = PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACTIVATED;
const CANCELLED = PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_CANCELLED;
const UNINSTALL = PARTNER_EVENT_TYPES.UNINSTALL;

const _DAY_MS = 86400000;
const _at = (iso) => new Date(iso);
const _plus = (at, ms) => new Date(at.getTime() + ms);

/**
 * The judgement instant every fixture is read at.
 *
 * FIXED, never `new Date()`: a state machine that takes `as_of` as a parameter is only worth having
 * if the tests exercise it at a stated instant, and a failure that reproduces only on the day it
 * happened is not a failure anybody can fix.
 */
const AS_OF = _at('2026-09-01T00:00:00.000Z');

/**
 * One charge-start event.
 *
 * @param {Object} params0 - The event's shape.
 * @param {String} params0.type - Partner event type.
 * @param {String} params0.shop - `shop_domain`, already canonical, as the store column holds it.
 * @param {String} params0.charge - Bare numeric charge id.
 * @param {Date} params0.at - `occurred_at`.
 * @param {Date|null} [params0.billingOn] - `charge.billingOn`, or nothing.
 * @param {String} [params0.plan] - `charge.name`.
 * @returns {Object} A row shaped like a `.lean()` `PartnerAppEventDoc`.
 */
const _start = ({ type, shop, charge, at, billingOn = null, plan = 'Pro' }) => ({
    event_type: type,
    shop_domain: shop,
    charge_id: charge,
    occurred_at: at,
    raw_event: {
        charge: {
            id: `gid://shopify/AppSubscription/${charge}`,
            name: plan,
            test: false,
            billingOn: billingOn ? billingOn.toISOString().slice(0, 10) : null,
            amount: { amount: '29.00', currencyCode: 'USD' }
        }
    }
});

/** One charge-keyed END event. */
const _end = ({ type, shop, charge, at }) => ({
    event_type: type,
    shop_domain: shop,
    charge_id: charge,
    occurred_at: at,
    raw_event: { charge: { id: `gid://shopify/AppSubscription/${charge}`, name: 'Pro', test: false, billingOn: null } }
});

/** One RELATIONSHIP end — no charge block at all, which is why it is keyed by shop. */
const _relationshipEnd = ({ shop, at }) => ({
    event_type: UNINSTALL,
    shop_domain: shop,
    charge_id: '',
    occurred_at: at,
    raw_event: {}
});

const _fold = (events) => resolveChargeCohortForDomains({ events, as_of: AS_OF });
const _byCharge = (result) => Object.fromEntries(result.subscriptions.map((s) => [s.charge_id, s]));

// ═══════════════════════════════════════════════════════════════════════════
//  1. THE DETECTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The canonical trap: one merchant, one upgrade, mid-trial.
 *
 * `100` is accepted on 1 August with a billing date of 8 August. On 4 August — inside its trial —
 * the merchant upgrades: Shopify cancels `100` and accepts `200` in the SAME SECOND.
 */
const PLAN_CHANGE_EVENTS = [
    _start({ type: ACCEPTED, shop: 'up.myshopify.com', charge: '100', at: _at('2026-08-01T09:00:00.000Z'), billingOn: _at('2026-08-08T00:00:00.000Z'), plan: 'Starter' }),
    _end({ type: CANCELLED, shop: 'up.myshopify.com', charge: '100', at: _at('2026-08-04T12:00:00.000Z') }),
    _start({ type: ACCEPTED, shop: 'up.myshopify.com', charge: '200', at: _at('2026-08-04T12:00:00.000Z'), billingOn: _at('2026-08-11T00:00:00.000Z'), plan: 'Pro' })
];

test('a same-second cancel-and-accept is DETECTED as a supersession, and named on the row', () => {
    const result = _fold(PLAN_CHANGE_EVENTS);
    const rows = _byCharge(result);

    assert.equal(rows['100'].superseded_by_charge_id, '200', 'the predecessor names its successor');
    assert.equal(rows['100'].end_event_type, CANCELLED, 'and says WHAT ended it — a cancel, not an uninstall');
    assert.equal(rows['200'].superseded_by_charge_id, null, 'the successor is nobody’s predecessor');
    assert.equal(rows['200'].end_event_type, null, 'and has not ended');

    const s = result.diagnostics.supersession;
    assert.equal(s.detected, 1, 'one predecessor');
    assert.equal(s.same_second, 1, 'and it carries Shopify’s own same-second signature');
    assert.equal(s.distinct_successors, 1, 'one extra trial start is what this actually costs');
    assert.equal(s.shops, 1, 'one merchant');
    assert.equal(s.churned_during_trial, 1, 'and the phantom churn is counted as such');
    assert.equal(s.churned_after_trial, 0);
});

test('NOTHING IS SUPPRESSED — the unadjusted counts are asserted on purpose', () => {
    const result = _fold(PLAN_CHANGE_EVENTS);

    // The fold still produces TWO subscriptions for ONE merchant, and the older one is still
    // classified as having left during its trial. That is the exposure, published rather than
    // repaired.
    assert.equal(result.subscriptions.length, 2, 'one merchant, two subscriptions');
    assert.equal(_byCharge(result)['100'].state, SUBSCRIPTION_STATES.CHURNED_DURING_TRIAL);

    const fold = foldTrialCohort({
        subscriptions: result.subscriptions,
        since: _at('2026-08-01T00:00:00.000Z'),
        until: AS_OF
    });

    // TIER 1 IS MEASURE-ONLY. Every number below describes ONE merchant upgrading ONCE, mid-trial.
    // If a later change makes any of them "correct", it must edit this test and say why — the hazard
    // is a silent correction that moves a published figure on an inference nobody wrote down.
    assert.equal(fold.counts.trial_started, 2, 'two trial starts for one merchant — unadjusted');
    assert.equal(fold.counts.churned_during_trial, 1, 'one phantom in-trial churn — unadjusted');
    assert.equal(fold.counts.currently_paying, 1, 'and the replacement is paying');
    assert.equal(fold.counts.trial_converted, 1);
    assert.equal(fold.counts.still_on_trial, 0, 'nothing is undecided, so `decided` is the whole cohort');
    assert.equal(fold.counts.decided, 2);

    // AND THIS IS WHAT IT COSTS ON SCREEN. One merchant, who upgraded, reads as a 50% trial-to-paid
    // rate: half of them "abandoned". The figure is arithmetically correct over the population it
    // names — subscriptions — and tells the operator something false about merchants. That gap is the
    // entire reason `diagnostics.supersession` exists, and why it must be READ before it is acted on.
    assert.equal(fold.conversion_rate, 0.5);
});

test('a genuine resubscribe LONG after the end is not a supersession, and the two counters differ', () => {
    const events = [
        _start({ type: ACCEPTED, shop: 'back.myshopify.com', charge: '300', at: _at('2026-01-05T00:00:00.000Z'), billingOn: _at('2026-01-12T00:00:00.000Z') }),
        _end({ type: CANCELLED, shop: 'back.myshopify.com', charge: '300', at: _at('2026-02-01T00:00:00.000Z') }),
        _start({ type: ACCEPTED, shop: 'back.myshopify.com', charge: '400', at: _at('2026-06-01T00:00:00.000Z'), billingOn: _at('2026-06-08T00:00:00.000Z') })
    ];
    const result = _fold(events);

    assert.equal(result.diagnostics.supersession.detected, 0, 'four months apart is not a plan change');
    assert.equal(_byCharge(result)['300'].superseded_by_charge_id, null);
    // ⚠️ And this is the counter it must not be confused with: `subscriptions_superseded` is the
    // per-domain fold's OWN loss — the older subscription this store has beyond its winning one —
    // which happens on every multi-subscription store whether or not a plan change is involved.
    assert.equal(result.diagnostics.subscriptions_superseded, 1, 'the domain fold still discarded one');
});

test('the detection window is the SHIPPED one, and one millisecond past it is not detected', () => {
    const end = _at('2026-08-04T12:00:00.000Z');
    const build = (offsetMs) => [
        _start({ type: ACCEPTED, shop: 'edge.myshopify.com', charge: '500', at: _at('2026-08-01T00:00:00.000Z'), billingOn: _at('2026-08-08T00:00:00.000Z') }),
        _end({ type: CANCELLED, shop: 'edge.myshopify.com', charge: '500', at: end }),
        _start({ type: ACCEPTED, shop: 'edge.myshopify.com', charge: '600', at: _plus(end, offsetMs), billingOn: _at('2026-08-20T00:00:00.000Z') })
    ];

    // Read off the export rather than retyped: a test carrying its own `60000` keeps passing after
    // somebody widens the real window, which is the one change these constants exist to make visible.
    const inside = _fold(build(SUPERSESSION_WINDOW_MS));
    assert.equal(inside.diagnostics.supersession.detected, 1, 'exactly at the edge is inside');
    assert.equal(inside.diagnostics.supersession.same_second, 0, 'but it is not the same-second signature');

    const outside = _fold(build(SUPERSESSION_WINDOW_MS + 1));
    assert.equal(outside.diagnostics.supersession.detected, 0, 'one millisecond past it is not');
});

test('two predecessors naming one successor inflate trial starts by ONE, not by two', () => {
    const at = _at('2026-08-10T08:00:00.000Z');
    const events = [
        _start({ type: ACCEPTED, shop: 'two.myshopify.com', charge: '710', at: _at('2026-08-01T00:00:00.000Z'), billingOn: _at('2026-08-08T00:00:00.000Z') }),
        _start({ type: ACCEPTED, shop: 'two.myshopify.com', charge: '720', at: _at('2026-08-02T00:00:00.000Z'), billingOn: _at('2026-08-09T00:00:00.000Z') }),
        _end({ type: CANCELLED, shop: 'two.myshopify.com', charge: '710', at }),
        _end({ type: CANCELLED, shop: 'two.myshopify.com', charge: '720', at }),
        _start({ type: ACCEPTED, shop: 'two.myshopify.com', charge: '730', at, billingOn: _at('2026-08-17T00:00:00.000Z') })
    ];
    const s = _fold(events).diagnostics.supersession;

    assert.equal(s.detected, 2, 'two subscriptions ended into it');
    // THE FIGURE AN OPERATOR IS TOLD IS `distinct_successors`, and this is why it is not
    // `detected`: quoting the predecessor count would claim two extra trial starts where the fold
    // produced one.
    assert.equal(s.distinct_successors, 1, 'but only ONE extra trial start exists');
});

test('the detection is a FLOOR — a bucket with no charge id is never paired', () => {
    // Both events carry a domain and no charge, so both bucket as `shop:…` and neither can be told
    // from a store that genuinely subscribed twice. Undetectable is reported as undetected.
    const events = [
        { event_type: ACCEPTED, shop_domain: 'bare.myshopify.com', charge_id: '', occurred_at: _at('2026-08-01T00:00:00.000Z'), raw_event: {} },
        _relationshipEnd({ shop: 'bare.myshopify.com', at: _at('2026-08-04T12:00:00.000Z') })
    ];
    const result = _fold(events);

    assert.equal(result.subscriptions.length, 1, 'the shop-keyed bucket exists');
    assert.equal(result.subscriptions[0].charge_id, '', 'and carries no charge id');
    assert.equal(result.subscriptions[0].end_event_type, UNINSTALL, 'its end is still typed');
    assert.equal(result.diagnostics.supersession.detected, 0, 'and it is never paired');
});

test('an end AFTER the judgement instant is not an end, and claims no supersession', () => {
    const events = [
        _start({ type: ACCEPTED, shop: 'later.myshopify.com', charge: '800', at: _at('2026-08-01T00:00:00.000Z'), billingOn: _at('2026-08-08T00:00:00.000Z') }),
        _end({ type: CANCELLED, shop: 'later.myshopify.com', charge: '800', at: _at('2026-09-10T00:00:00.000Z') }),
        _start({ type: ACCEPTED, shop: 'later.myshopify.com', charge: '900', at: _at('2026-09-10T00:00:00.000Z'), billingOn: _at('2026-09-17T00:00:00.000Z') })
    ];
    const row = _byCharge(_fold(events))['800'];

    assert.equal(row.churn_date, null, '`classifyAsOf` clamped it away');
    // ⚠️ `end_event_type` is gated on the CLAMPED date. Publishing "ended by cancellation" beside a
    // null churn date would assert a departure this window has explicitly decided has not happened.
    assert.equal(row.end_event_type, null, 'so the type goes with it');
    assert.equal(row.superseded_by_charge_id, null, 'and no supersession is inferred across `as_of`');
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. THE `billingOn` GAP
// ═══════════════════════════════════════════════════════════════════════════

test('`billingOn` provenance is the ACTIVATED event, and the gap is measured FROM it', () => {
    const acceptedAt = _at('2026-08-01T00:00:00.000Z');
    const activatedAt = _at('2026-08-07T00:00:00.000Z');
    const events = [
        // The live shape: ACCEPTED carries no `billingOn` at all.
        _start({ type: ACCEPTED, shop: 'gap.myshopify.com', charge: '1000', at: acceptedAt, billingOn: null }),
        _start({ type: ACTIVATED, shop: 'gap.myshopify.com', charge: '1000', at: activatedAt, billingOn: _at('2026-08-14T00:00:00.000Z') })
    ];
    const row = _byCharge(_fold(events))['1000'];

    assert.equal(row.trial_start.getTime(), acceptedAt.getTime(), 'the trial still starts at the ACCEPTED');
    assert.equal(row.conversion_source_event_type, ACTIVATED, 'but the date came from the ACTIVATED');
    // SEVEN, NOT THIRTEEN. Measuring from `trial_start` would add the accept→activate lag to every
    // gap in the build and make the whole distribution read longer than it is.
    assert.equal(row.billing_on_gap_days, 7, 'and the gap is announcing-event → billingOn');
});

test('a NEGATIVE gap is counted on its own line and reclassifies nobody', () => {
    const activatedAt = _at('2026-08-20T00:00:00.000Z');
    const events = [
        _start({ type: ACTIVATED, shop: 'neg.myshopify.com', charge: '1100', at: activatedAt, billingOn: _at('2026-08-15T00:00:00.000Z') })
    ];
    const result = _fold(events);
    const row = _byCharge(result)['1100'];

    assert.equal(row.billing_on_gap_days, -5, 'a billing date five days before the event announcing it');
    assert.equal(result.diagnostics.billing_on_gap.measured, 1);
    assert.equal(result.diagnostics.billing_on_gap.negative, 1);
    assert.equal(result.diagnostics.billing_on_gap.above_band, 0, 'the two buckets are DISJOINT');

    // AND NOTHING MOVED. The row classifies exactly as `classifyAsOf` would have without the
    // diagnostic: a billing date in the past and no end event is PAYING. A diagnostic that quietly
    // demoted this row would be the invented threshold this whole design refuses.
    assert.equal(row.state, SUBSCRIPTION_STATES.PAYING);
    assert.equal(row.trial_end.getTime(), _at('2026-08-15T00:00:00.000Z').getTime(), 'and `trial_end` is untouched');
});

test('the ambiguous 29–30 day mode stays INSIDE the band, and its row does not move', () => {
    // The upper mode of the live bimodality: ~547 charges land here, and each one is EQUALLY
    // consistent with a 30-day trial and with a no-trial subscription whose first billing is one
    // monthly cycle out. No stored field separates them — so the band must not pretend to, and a
    // future threshold "over 20 days ⇒ not a trial" would silently reclassify every one of them.
    for (const days of [29, 30]) {
        // Late enough that `billingOn` lands AFTER `as_of`, which is the case the exposure is about:
        // a no-trial subscription billing a cycle out is published as `ON_TRIAL` for that whole cycle.
        const activatedAt = _at('2026-08-25T00:00:00.000Z');
        const billingOn = _plus(activatedAt, days * _DAY_MS);
        const result = _fold([
            _start({ type: ACTIVATED, shop: 'mode.myshopify.com', charge: '1200', at: activatedAt, billingOn })
        ]);
        const gap = result.diagnostics.billing_on_gap;
        const row = _byCharge(result)['1200'];

        assert.equal(gap.measured, 1, `${days}d is measured`);
        assert.equal(gap.negative, 0);
        assert.equal(gap.above_band, 0, `${days} days is not evidence of anything, and is not bucketed as such`);
        assert.equal(gap.band_max_days, BILLING_ON_GAP_MAX_PLAUSIBLE_TRIAL_DAYS, 'the band publishes its own bound');

        // AND THE ROW IS EXACTLY WHAT IT WOULD BE WITH NO DIAGNOSTIC AT ALL. `billingOn` is in the
        // future at `AS_OF`, so the subscription is ON_TRIAL on the `billing_on` basis and its
        // rendered trial end is Shopify's own date — untouched, unrounded, unqualified.
        assert.equal(row.state, SUBSCRIPTION_STATES.ON_TRIAL);
        assert.equal(row.trial_end.getTime(), billingOn.getTime(), 'the rendered date is Shopify’s, unchanged');
        assert.equal(row.trial_days_source, 'partner_billing_on', 'and its source is still the only one there is');
        assert.equal(row.billing_on_gap_days, days, 'the gap is published beside it rather than acted on');
    }
});

test('a gap past the band is counted, and the band bound is the shipped one', () => {
    const activatedAt = _at('2026-01-01T00:00:00.000Z');
    const events = [
        _start({
            type: ACTIVATED,
            shop: 'anchor.myshopify.com',
            charge: '1300',
            at: activatedAt,
            billingOn: _plus(activatedAt, (BILLING_ON_GAP_MAX_PLAUSIBLE_TRIAL_DAYS + 1) * _DAY_MS)
        })
    ];
    const gap = _fold(events).diagnostics.billing_on_gap;

    assert.equal(gap.above_band, 1, 'too long to be a trial — a billing anchor');
    assert.equal(gap.negative, 0);
});

test('a subscription Shopify sent no `billingOn` for is not counted in the gap denominator', () => {
    const events = [
        _start({ type: ACCEPTED, shop: 'none.myshopify.com', charge: '1400', at: _at('2026-08-01T00:00:00.000Z'), billingOn: null })
    ];
    const result = _fold(events);

    assert.equal(result.diagnostics.billing_on_gap.measured, 0, 'no date, nothing to measure');
    assert.equal(_byCharge(result)['1400'].billing_on_gap_days, null, 'and the row says so with a null, not a 0');
    assert.equal(_byCharge(result)['1400'].conversion_source_event_type, '');
});

// ═══════════════════════════════════════════════════════════════════════════
//  3. THE SENTENCES
// ═══════════════════════════════════════════════════════════════════════════

test('a clean fold produces NO exposure sentence — a warning that always fires is not read', () => {
    const events = [
        _start({ type: ACCEPTED, shop: 'clean.myshopify.com', charge: '1500', at: _at('2026-08-01T00:00:00.000Z'), billingOn: _at('2026-08-08T00:00:00.000Z') })
    ];
    assert.deepEqual(describeChargeCohortExposure(_fold(events).diagnostics), []);
});

test('the supersession sentence quotes the counts and states that nothing was adjusted', () => {
    const diagnostics = _fold(PLAN_CHANGE_EVENTS).diagnostics;
    const lines = describeChargeCohortExposure(diagnostics);

    assert.equal(lines.length, 1, 'the gap counters are clean here, so only one line fires');
    const line = lines[0];
    assert.match(line, /same second/i, 'it names Shopify’s own signature');
    assert.match(line, new RegExp(`\\b${diagnostics.supersession.detected}\\b`), 'and quotes the detected count');
    assert.match(line, new RegExp(`\\b${diagnostics.supersession.distinct_successors}\\b`), 'and the inflation');
    assert.match(line, new RegExp(`\\b${Math.round(diagnostics.supersession.window_ms / 1000)}s\\b`), 'and the SHIPPED window width');
    // Two clauses must survive every future edit of this wording.
    //
    // The DIRECTION, because a count without one is not actionable: an operator told "3 detected"
    // cannot tell whether their trial-to-paid rate is flattered or punished by it, and `FIDELITY.md`
    // §1 requires an estimate's caveat to carry its direction of error.
    assert.match(line, /\bHIGH\b/, 'it names which way the figures are wrong');
    assert.match(line, /\bLOW\b/, 'in both directions where both apply');
    // And that nothing was corrected: a caveat reading as though the figure had been fixed retires
    // the question the operator should still be asking.
    assert.match(line, /has been adjusted/i, 'and says outright that no figure was corrected');
});

test('the gap sentence names the direction of the error and the missing field', () => {
    const activatedAt = _at('2026-01-01T00:00:00.000Z');
    const events = [
        _start({ type: ACTIVATED, shop: 'a.myshopify.com', charge: '1600', at: activatedAt, billingOn: _plus(activatedAt, 200 * _DAY_MS) }),
        _start({ type: ACTIVATED, shop: 'b.myshopify.com', charge: '1700', at: activatedAt, billingOn: _plus(activatedAt, -3 * _DAY_MS) })
    ];
    const lines = describeChargeCohortExposure(_fold(events).diagnostics);

    assert.equal(lines.length, 1);
    assert.match(lines[0], /trialDays/, 'it names the field the Partner API does not give us');
    assert.match(lines[0], /BEFORE/, 'and calls out the negative gaps specifically');
    assert.match(lines[0], /\bLONG\b/, 'and states the direction — trial lengths read long, not merely "differ"');
    assert.equal(new Set(lines).size, lines.length, 'warnings are keyed by content — every line is unique');
});
