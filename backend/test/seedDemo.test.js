'use strict';

/**
 * ============================================================================
 *  THE DEMO DATASET — is it internally consistent, and does it refuse?
 * ============================================================================
 *
 *  Two jobs, and they are different in kind.
 *
 *  ── 1. THE DATASET IS CHECKED WITH THE PRODUCTION PREDICATES ───────────────
 *
 *  NOTHING IS STUBBED IN THE CONSISTENCY BLOCKS. Every membership question
 *  goes through `ledgerMrr.liveSetAsOf`, every movement through
 *  `movementSince.foldMrrMovement`, and every lifecycle through
 *  `chargeCohort.resolveChargeCohortForDomains` — the same three folds the
 *  dashboard runs. That is the whole point: a seeder verified against its own
 *  idea of what it wrote proves nothing, because a demo dataset only has to
 *  satisfy ONE audience, and that audience is the eleven pages that read it.
 *
 *  Every page cross-checks, so an incoherent dataset does not render "slightly
 *  wrong" — it renders as a dashboard reporting a contradiction, which is
 *  exactly what this project's honesty machinery is built to do. The demo would
 *  then look broken while behaving correctly, and the person evaluating the
 *  project would blame the product.
 *
 *  ── 2. THE SEEDER REFUSES A DATABASE IT DID NOT WRITE ──────────────────────
 *
 *  The seeder writes FICTION into the same collections, joined on the same keys,
 *  as a real Partner sync. There is no downstream reader that can tell the two
 *  apart, because none was ever asked to. So the refusal is not a nicety; it is
 *  the only thing standing between "I tried the demo" and "invented revenue is
 *  now permanently mixed into my real history". Those blocks stub the repository
 *  and assert that a refusal writes NOTHING — not that it returns the right
 *  string.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mongoose = require('mongoose');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(BACKEND_ROOT, 'src');

/** Never reached — every repository call below is stubbed — but a short buffer keeps a mistake from hanging. */
mongoose.set('bufferTimeoutMS', 400);

const demoConstants = require(path.join(SRC, 'scripts', 'constants', 'demoSeed.constants.ts'));
const demoDatasetHelper = require(path.join(SRC, 'scripts', 'helpers', 'demoDataset.helper.ts'));

// The production folds, by deep path. All three are PURE, so reaching them
// directly costs no database — and reaching them through a module barrel would
// pull in the services behind it, which do touch the model registry.
const ledgerMrrHelper = require(path.join(SRC, 'modules', 'revenue', 'helpers', 'ledgerMrr.helper.ts'));
const movementSinceHelper = require(path.join(SRC, 'modules', 'revenue', 'helpers', 'movementSince.helper.ts'));
const chargeCohortResolver = require(path.join(SRC, 'modules', 'conversion', 'resolvers', 'chargeCohort.resolver.ts'));
const lifecycleConstants = require(path.join(SRC, 'modules', 'conversion', 'constants', 'lifecycle.constants.ts'));
const config = require(path.join(SRC, 'config', 'index.ts'));

// ⚠️ REQUIRED AND PATCHED BEFORE THE SERVICE. The service destructures
// `collectCoverageInputs` at module load, so a stub installed afterwards would
// be ignored and the real one would issue a query against a database that is
// not there.
const partnerCoverageRepository = require(path.join(SRC, 'modules', 'partner', 'repositories', 'partnerCoverage.repository.ts'));
partnerCoverageRepository.collectCoverageInputs = async () => ({
    earliest_event_at: new Date('2025-01-01T00:00:00.000Z'),
    earliest_transaction_at: new Date('2024-12-01T00:00:00.000Z'),
    earliest_named_event_at: new Date('2025-01-01T00:00:00.000Z'),
    event_day_buckets: [],
    charge_linked_event_rows: 0,
    charge_linked_event_rows_without_charge_id: 0,
    charge_bearing_transaction_rows: 0,
    charge_bearing_transaction_rows_without_charge_id: 0,
    event_charge_ids: [],
    transaction_charge_row_counts: []
});

const demoSeedRepository = require(path.join(SRC, 'scripts', 'repositories', 'demoSeed.repository.ts'));
const demoSeedService = require(path.join(SRC, 'scripts', 'services', 'demoSeed.service.ts'));

const { generateDemoDataset, _splitByWeight } = demoDatasetHelper;
const { liveSetAsOf } = ledgerMrrHelper;
const { foldMrrMovement } = movementSinceHelper;
const { resolveChargeCohortForDomains } = chargeCohortResolver;
const { SUBSCRIPTION_STATES, CHARGE_COHORT_EVENT_TYPES } = lifecycleConstants;
const { DEMO_MARKER, DEMO_APP, DEMO_DOMAIN_SUFFIX, DEMO_PLANS } = demoConstants;

/** The window under test is the SHIPPED one, read from config — never a number retyped here. */
const WINDOW_DAYS = config.REVENUE.ACTIVE_SUB_WINDOW_DAYS;

const _DAY_MS = 86400000;

/**
 * ⚠️ ONE DATASET, GENERATED ONCE, AT A FIXED ANCHOR.
 *
 * Fixed rather than `new Date()` so a failure is reproducible: the generator is
 * deterministic given an anchor, so a fixed anchor makes every assertion below
 * reproduce byte for byte on any machine on any day. The anchor is deliberately
 * a mid-month date, so the quiet-month arithmetic is exercised away from a
 * month boundary.
 */
const ANCHOR = new Date('2026-06-17T00:00:00.000Z');
const DATASET = generateDemoDataset({ anchor_at: ANCHOR });

/** The domain a demo slug resolves to. */
const _domain = (slug) => `demo-${slug}${DEMO_DOMAIN_SUFFIX}`;

/** `YYYY-MM` in UTC — the key every monthly fold in the application uses. */
const _monthKey = (at) => `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * The settled subscription ledger, in the exact shape
 * `revenue.repository.fetchSubscriptionChargeHistory` returns it — NEWEST FIRST,
 * `APP_SUBSCRIPTION` only, `shop_id` non-empty.
 *
 * The order is load-bearing: `liveSetAsOf` accepts the FIRST row it sees per
 * shop and relies on that being the most recent one.
 */
const HISTORY = DATASET.transactions
    .filter((row) => row.type === 'APP_SUBSCRIPTION' && row.shop_id !== '')
    .map((row) => ({
        shop_id: row.shop_id,
        shop_domain: row.shop_domain,
        gross: row.gross_amount.amount,
        currency: row.gross_amount.currency,
        billing_interval: row.billing_interval,
        created_at: row.created_at
    }))
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

/** The live set at an instant, keyed by DOMAIN rather than shop id, for readable assertions. */
const _payingByDomain = (asOf) => {
    const out = new Map();
    for (const shop of liveSetAsOf(HISTORY, asOf, WINDOW_DAYS).values()) {
        out.set(shop.shop_domain, shop);
    }
    return out;
};

/** The last instant of the calendar month `back` months before the anchor. */
const _monthEnd = (back) => {
    const nextStart = Date.UTC(ANCHOR.getUTCFullYear(), ANCHOR.getUTCMonth() - back + 1, 1);
    return new Date(Math.min(nextStart - 1, ANCHOR.getTime()));
};


/* ==========================================================================
 *  1. THE RECONCILIATION IDENTITY, ON THE GENERATED DATA
 *
 *  `foldMrrMovement` THROWS rather than publishing a movement card whose six
 *  figures do not add up to the two balances above them. Running it over every
 *  consecutive month of the demo history is therefore a real test of the data:
 *  if any month's opening, new, expansion, contraction and churn fail to reach
 *  its closing balance, this file fails instead of the dashboard.
 * ========================================================================== */

test('every consecutive month of the demo history reconciles — opening + new + expansion - contraction - churned = closing', () => {
    let checked = 0;
    let previous = liveSetAsOf(HISTORY, _monthEnd(15), WINDOW_DAYS);

    for (let back = 14; back >= 0; back -= 1) {
        const boundary = _monthEnd(back);
        const current = liveSetAsOf(HISTORY, boundary, WINDOW_DAYS);

        // Throws on drift. Not wrapped: the throw IS the failure we want reported.
        const fold = foldMrrMovement({ open_set: previous, close_set: current });

        const expected = fold.totals.start_mrr
            + fold.totals.new_mrr
            + fold.totals.expansion_mrr
            - fold.totals.contraction_mrr
            - fold.totals.churned_mrr;
        assert.ok(
            Math.abs(fold.totals.end_mrr - expected) < 1e-6,
            `${_monthKey(boundary)} does not balance: expected ${expected}, closing ${fold.totals.end_mrr}`
        );

        previous = current;
        checked += 1;
    }

    assert.equal(checked, 15, 'fifteen month boundaries were compared');
});

test('the demo MRR line moves — a flat line is the tell that the window is too wide', () => {
    const readings = [];
    for (let back = 12; back >= 0; back -= 1) {
        let mrr = 0;
        for (const shop of liveSetAsOf(HISTORY, _monthEnd(back), WINDOW_DAYS).values()) {
            mrr += shop.monthly_amount;
        }
        readings.push(mrr);
    }
    const distinct = new Set(readings.map((value) => Math.round(value * 100)));
    assert.ok(distinct.size >= 10, `MRR took ${distinct.size} distinct values across 13 months`);
    assert.ok(readings[readings.length - 1] > readings[0], 'the demo business grows across the window');
});

test('the demo never manufactures a month in which the whole base churns', () => {
    for (let back = 12; back >= 1; back -= 1) {
        const open = liveSetAsOf(HISTORY, _monthEnd(back), WINDOW_DAYS);
        const close = liveSetAsOf(HISTORY, _monthEnd(back - 1), WINDOW_DAYS);
        const fold = foldMrrMovement({ open_set: open, close_set: close });
        if (fold.totals.start_mrr === 0) {
            continue;
        }
        // 12 x 30 = 360, so a calendar-month membership rule skips one month a year
        // and reports ~1/12 of the base as churned. A demo that reproduced that
        // artefact would be teaching the reader the bug.
        assert.ok(
            fold.totals.gross_churn_rate < 0.25,
            `${_monthKey(_monthEnd(back - 1))} reported ${fold.totals.gross_churn_rate} gross churn`
        );
    }
});


/* ==========================================================================
 *  2. A CHURNED SHOP LEAVES THE PAYING SET
 *
 *  Not "a flag says it churned" — no such flag exists. The store's payouts stop
 *  and the as-of predicate ages it out, which is the only route by which the
 *  dashboard will ever agree with the Stores page about the same store.
 * ========================================================================== */

test('a store that cancelled is paying BEFORE its cancellation and absent after it', () => {
    const domain = _domain('quarry');

    const before = _payingByDomain(new Date(ANCHOR.getTime() - 150 * _DAY_MS));
    assert.ok(before.has(domain), 'the churned store was paying 150 days before the anchor');

    const now = _payingByDomain(ANCHOR);
    assert.equal(now.has(domain), false, 'the churned store is not in the paying set at the anchor');
});

test('a store Shopify FROZE leaves the paying set too — a deactivation emits no cancel event', () => {
    const domain = _domain('stonebridge');

    const before = _payingByDomain(new Date(ANCHOR.getTime() - 120 * _DAY_MS));
    assert.ok(before.has(domain), 'the frozen store was paying before it was deactivated');

    const now = _payingByDomain(ANCHOR);
    assert.equal(now.has(domain), false, 'a deactivated store stops paying, with no cancellation to read');
});

test('the control still pays — the two above left because their payouts stopped, not because everything did', () => {
    const paying = _payingByDomain(ANCHOR);
    assert.ok(paying.has(_domain('northwind')), 'the long-tenured store is still paying');
    assert.ok(paying.size > 20, `the paying base is ${paying.size} stores`);
});

test('a churned store appears in the movement fold as CHURNED, carrying the value it was last seen at', () => {
    const open = liveSetAsOf(HISTORY, new Date(ANCHOR.getTime() - 150 * _DAY_MS), WINDOW_DAYS);
    const close = liveSetAsOf(HISTORY, ANCHOR, WINDOW_DAYS);
    const fold = foldMrrMovement({ open_set: open, close_set: close });

    const churnedDomains = fold.buckets.churned.map((row) => row.shop_domain);
    assert.ok(churnedDomains.includes(_domain('quarry')), 'the cancelled store is in the churned bucket');
    assert.ok(churnedDomains.includes(_domain('stonebridge')), 'the frozen store is in the churned bucket');
    assert.ok(fold.totals.churned_mrr > 0, 'churned MRR is a real figure, not zero');
});


/* ==========================================================================
 *  3. THE ANNUAL SUBSCRIBER IS BOOKED AT /12
 *
 *  A year of revenue booked whole as one month of run-rate overstates MRR
 *  twelvefold and then reads as eleven months of churn. The annual price is 490
 *  precisely so that 490/12 = 40.8333… is a number no other route produces.
 * ========================================================================== */

test('the annual subscriber contributes exactly one twelfth of its annual price', () => {
    const paying = _payingByDomain(ANCHOR);
    const annual = paying.get(_domain('lumen'));

    assert.ok(annual, 'the annual subscriber is in the paying set');
    assert.equal(annual.billing_interval, 'ANNUAL');
    assert.equal(annual.charged_amount, DEMO_PLANS.GROWTH_ANNUAL.price, 'Shopify settled the full annual amount');
    assert.equal(annual.monthly_amount, DEMO_PLANS.GROWTH_ANNUAL.price / 12, 'MRR books it at /12');
    assert.notEqual(annual.monthly_amount, annual.charged_amount, 'the /12 actually ran');
});

test('the annual subscriber survives a gap wider than the monthly window — that is what the /12 depends on', () => {
    const paying = _payingByDomain(ANCHOR);
    const annual = paying.get(_domain('lumen'));

    const ageDays = (ANCHOR.getTime() - annual.last_charged_at.getTime()) / _DAY_MS;
    // ⚠️ If this is ever inside the monthly window the test above passes for the
    // wrong reason: the shop would be live because it was charged recently, not
    // because the predicate is interval-aware.
    assert.ok(
        ageDays > WINDOW_DAYS,
        `the annual subscriber's last charge is ${Math.round(ageDays)} days old, inside the ${WINDOW_DAYS}-day monthly window`
    );
});

test('exactly one settled payout exists for the annual subscriber — a year is billed once, not twelve times', () => {
    const rows = DATASET.transactions.filter(
        (row) => row.shop_domain === _domain('lumen') && row.type === 'APP_SUBSCRIPTION'
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].billing_interval, 'ANNUAL');
    assert.equal(rows[0].gross_amount.amount, DEMO_PLANS.GROWTH_ANNUAL.price);
});


/* ==========================================================================
 *  4. THE HONEST EDGE CASES ARE ACTUALLY IN THERE
 *
 *  Each of these is a case the product's own documentation names as the reason a
 *  design decision exists. A demo without them shows a dashboard doing nothing
 *  interesting, and every refusal, banner and null it can produce goes unseen.
 * ========================================================================== */

test('a shop whose install predates the synced window is billed, and has no events at all', () => {
    const domain = _domain('saltmarsh');

    const events = DATASET.events.filter((row) => row.shop_domain === domain);
    assert.equal(events.length, 0, 'the pre-window store contributes no events');

    const payouts = DATASET.transactions.filter((row) => row.shop_domain === domain);
    assert.ok(payouts.length > 10, 'the pre-window store is all over the payout ledger');

    assert.ok(_payingByDomain(ANCHOR).has(domain), 'and the ledger predicate still finds it paying');
});

test('the payout ledger reaches further back than the event history — which is why the two gates are separate fields', () => {
    let earliestEvent = Infinity;
    for (const row of DATASET.events) {
        earliestEvent = Math.min(earliestEvent, row.occurred_at.getTime());
    }
    let earliestTransaction = Infinity;
    for (const row of DATASET.transactions) {
        earliestTransaction = Math.min(earliestTransaction, row.created_at.getTime());
    }
    assert.ok(
        earliestTransaction < earliestEvent,
        'earliest_transaction_at and earliest_event_at would be the same date, and the demo would not show why they differ'
    );
});

test('a shop whose payouts are late is still paying — outside a billing cycle, inside the grace', () => {
    const domain = _domain('harborline');
    const paying = _payingByDomain(ANCHOR);
    const shop = paying.get(domain);

    assert.ok(shop, 'the late-payout store is still counted as paying');

    const ageDays = (ANCHOR.getTime() - shop.last_charged_at.getTime()) / _DAY_MS;
    assert.ok(ageDays > 30, `its most recent settled charge is ${Math.round(ageDays)} days old — older than a 30-day cycle`);
    assert.ok(ageDays <= WINDOW_DAYS, `and inside the ${WINDOW_DAYS}-day grace, so it is not a cancellation`);
});

test('a converted store has NO GA4 attribution row, so one acquisition channel is honestly unknown', () => {
    const domain = _domain('fernway');
    assert.ok(_payingByDomain(ANCHOR).has(domain), 'the unattributed store is paying');
    assert.equal(
        DATASET.attributions.filter((row) => row.shop_domain === domain).length,
        0,
        'and GA4 never attributed it'
    );
    // Not every store: an all-unattributed demo would show one empty column instead
    // of a channel mix with a real remainder in it.
    assert.ok(DATASET.attributions.length > 100, 'most stores DO carry an attribution row');
});

test('one calendar month has no trial starts at all, so its conversion rate has no denominator', () => {
    const quietMonth = DATASET.quiet_window.month;

    const accepted = DATASET.events.filter(
        (row) => row.event_type === 'SUBSCRIPTION_CHARGE_ACCEPTED' && _monthKey(row.occurred_at) === quietMonth
    );
    assert.equal(accepted.length, 0, `${quietMonth} must contain no trial starts`);

    // And the months either side must NOT be empty, or "no measurable rate" would
    // just be the shape of the whole dataset rather than one deliberate month.
    const byMonth = new Map();
    for (const row of DATASET.events) {
        if (row.event_type !== 'SUBSCRIPTION_CHARGE_ACCEPTED') {
            continue;
        }
        const key = _monthKey(row.occurred_at);
        byMonth.set(key, (byMonth.get(key) || 0) + 1);
    }
    const populated = [...byMonth.values()].filter((count) => count > 0);
    assert.ok(populated.length >= 15, `${populated.length} other months carry trial starts`);
});

test('the trial outcomes are all four: abandoned, converted, churned after converting, and still running', () => {
    const events = DATASET.events
        .filter((row) => CHARGE_COHORT_EVENT_TYPES.includes(row.event_type))
        .map((row) => ({
            event_type: row.event_type,
            shop_domain: row.shop_domain,
            charge_id: row.charge_id,
            occurred_at: row.occurred_at,
            raw_event: row.raw_event
        }));

    const settledChargeIds = [...new Set(
        DATASET.transactions.filter((row) => row.type === 'APP_SUBSCRIPTION').map((row) => row.charge_id)
    )].filter(Boolean);

    const cohort = resolveChargeCohortForDomains({
        events,
        as_of: ANCHOR,
        settled_charge_ids: settledChargeIds,
        settled_domains: []
    });

    const stateOf = (slug) => {
        const subscription = cohort.by_domain.get(_domain(slug));
        return subscription ? subscription.state : null;
    };

    assert.equal(stateOf('tidepool'), SUBSCRIPTION_STATES.CHURNED_DURING_TRIAL, 'the abandoned trial');
    assert.equal(stateOf('northwind'), SUBSCRIPTION_STATES.PAYING, 'the converted trial');
    assert.equal(stateOf('quarry'), SUBSCRIPTION_STATES.CHURNED_AFTER_TRIAL, 'churned after converting');
    assert.equal(stateOf('glasshouse'), SUBSCRIPTION_STATES.ON_TRIAL, 'a trial still running at the anchor');

    // Every one of the four has a real population behind it, not a single store.
    const tally = {};
    for (const subscription of cohort.subscriptions) {
        tally[subscription.state] = (tally[subscription.state] || 0) + 1;
    }
    for (const state of Object.values(SUBSCRIPTION_STATES)) {
        assert.ok(tally[state] > 1, `${state} has ${tally[state] || 0} subscriptions`);
    }
});

test('a test subscription is excluded from the cohort and COUNTED, never silently dropped', () => {
    const events = DATASET.events
        .filter((row) => CHARGE_COHORT_EVENT_TYPES.includes(row.event_type))
        .map((row) => ({
            event_type: row.event_type,
            shop_domain: row.shop_domain,
            charge_id: row.charge_id,
            occurred_at: row.occurred_at,
            raw_event: row.raw_event
        }));

    const cohort = resolveChargeCohortForDomains({ events, as_of: ANCHOR });

    assert.ok(cohort.diagnostics.test_excluded > 0, 'test charge events were excluded');
    assert.equal(cohort.diagnostics.test_subscriptions_excluded, 1, 'and exactly one whole subscription was');
    assert.equal(cohort.by_domain.has(_domain('forgeandlast')), false, 'the test store has no live subscription');
    assert.equal(
        DATASET.transactions.filter((row) => row.shop_domain === _domain('forgeandlast')).length,
        0,
        'and Shopify never settled money against it, so the ledger cannot disagree'
    );
});

test('a plan change is TWO subscriptions on one domain — which is what Shopify actually emits', () => {
    const events = DATASET.events
        .filter((row) => CHARGE_COHORT_EVENT_TYPES.includes(row.event_type))
        .map((row) => ({
            event_type: row.event_type,
            shop_domain: row.shop_domain,
            charge_id: row.charge_id,
            occurred_at: row.occurred_at,
            raw_event: row.raw_event
        }));
    const cohort = resolveChargeCohortForDomains({ events, as_of: ANCHOR });

    assert.ok(cohort.diagnostics.subscriptions_superseded > 0, 'some domains carry more than one subscription');

    const upgraded = cohort.subscriptions.filter((row) => row.shop_domain === _domain('brightpath'));
    assert.equal(upgraded.length, 2, 'the upgrading store has two subscriptions');
    assert.equal(new Set(upgraded.map((row) => row.charge_id)).size, 2, 'on two different charges');

    const paying = _payingByDomain(ANCHOR).get(_domain('brightpath'));
    assert.equal(paying.monthly_amount, DEMO_PLANS.PRO.price, 'and the ledger values it at the NEW plan');
});

test('an expansion and a contraction both appear in the movement fold — neither is a churn', () => {
    const open = liveSetAsOf(HISTORY, new Date(ANCHOR.getTime() - 320 * _DAY_MS), WINDOW_DAYS);
    const close = liveSetAsOf(HISTORY, ANCHOR, WINDOW_DAYS);
    const fold = foldMrrMovement({ open_set: open, close_set: close });

    assert.ok(fold.totals.expansion_mrr > 0, 'at least one store pays more than it did');
    assert.ok(fold.totals.contraction_mrr > 0, 'at least one store pays less than it did');

    const contracted = fold.buckets.contraction.map((row) => row.shop_domain);
    assert.ok(contracted.includes(_domain('cedarworks')), 'the downgraded store contracted rather than churned');
});


/* ==========================================================================
 *  5. STRUCTURAL CONSISTENCY — the things a database would enforce
 *
 *  These are the invariants the unique indexes and the funnel chart depend on.
 *  Checking them here means a broken generator fails in milliseconds instead of
 *  half way through an `insertMany` against a half-written database.
 * ========================================================================== */

test('every event id and every transaction id is unique — the unique indexes would reject a collision mid-insert', () => {
    const eventIds = new Set(DATASET.events.map((row) => row.partner_event_id));
    assert.equal(eventIds.size, DATASET.events.length, 'partner_event_id collides');

    const transactionIds = new Set(DATASET.transactions.map((row) => row.shopify_transaction_id));
    assert.equal(transactionIds.size, DATASET.transactions.length, 'shopify_transaction_id collides');

    const funnelKeys = new Set(DATASET.funnel_days.map((row) => row.date.toISOString()));
    assert.equal(funnelKeys.size, DATASET.funnel_days.length, 'the funnel rollup has two rows for one day');

    const geoKeys = new Set(DATASET.geo_days.map((row) => `${row.date.toISOString()}|${row.country}`));
    assert.equal(geoKeys.size, DATASET.geo_days.length, 'the geo rollup has two rows for one (day, country)');

    const sourceKeys = new Set(DATASET.source_days.map((row) => `${row.date.toISOString()}|${row.traffic_source}|${row.traffic_medium}`));
    assert.equal(sourceKeys.size, DATASET.source_days.length, 'the source rollup has two rows for one bucket');
});

test('the listing funnel is monotone — no step is wider than the step above it', () => {
    for (const day of DATASET.funnel_days) {
        const steps = [day.views, day.engaged_views, day.install_clicks, day.consent_started, day.consent_completed, day.installs];
        for (let i = 1; i < steps.length; i += 1) {
            assert.ok(
                steps[i] <= steps[i - 1],
                `${day.date.toISOString().slice(0, 10)} widens at step ${i}: ${steps.join(' -> ')}`
            );
        }
    }
});

test('the country and source breakdowns add up to the day they break down', () => {
    const funnelByDay = new Map(DATASET.funnel_days.map((row) => [row.date.getTime(), row]));

    const geoTotals = new Map();
    for (const row of DATASET.geo_days) {
        const bucket = geoTotals.get(row.date.getTime()) || { views: 0, installs: 0 };
        bucket.views += row.views;
        bucket.installs += row.installs;
        geoTotals.set(row.date.getTime(), bucket);
    }
    for (const [day, bucket] of geoTotals) {
        const funnel = funnelByDay.get(day);
        assert.equal(bucket.views, funnel.views, 'geo views must sum to the day');
        assert.equal(bucket.installs, funnel.installs, 'geo installs must sum to the day');
    }

    const sourceTotals = new Map();
    for (const row of DATASET.source_days) {
        const bucket = sourceTotals.get(row.date.getTime()) || { views: 0, installs: 0, install_clicks: 0 };
        bucket.views += row.views;
        bucket.installs += row.installs;
        bucket.install_clicks += row.install_clicks;
        sourceTotals.set(row.date.getTime(), bucket);
    }
    for (const [day, bucket] of sourceTotals) {
        const funnel = funnelByDay.get(day);
        assert.equal(bucket.views, funnel.views, 'source views must sum to the day');
        assert.equal(bucket.installs, funnel.installs, 'source installs must sum to the day');
        assert.equal(bucket.install_clicks, funnel.install_clicks, 'source install clicks must sum to the day');
    }
});

test('the listing installs column IS the attribution rows for that day — the two sides cannot disagree', () => {
    const attributedByDay = new Map();
    for (const row of DATASET.attributions) {
        const key = row.install_date.getTime();
        attributedByDay.set(key, (attributedByDay.get(key) || 0) + 1);
    }
    let matched = 0;
    for (const day of DATASET.funnel_days) {
        assert.equal(
            day.installs,
            attributedByDay.get(day.date.getTime()) || 0,
            `${day.date.toISOString().slice(0, 10)}: funnel installs and attribution rows disagree`
        );
        matched += day.installs;
    }
    assert.ok(matched > 100, `${matched} attributed installs are inside the listing window`);
});

test('a weighted split always adds up to the total it divides', () => {
    const weights = [48, 15, 12, 10, 8, 7];
    for (let total = 0; total < 200; total += 1) {
        const parts = _splitByWeight(total, weights);
        assert.equal(parts.reduce((sum, value) => sum + value, 0), total, `split of ${total} does not add up`);
        assert.ok(parts.every((value) => value >= 0), 'a split produced a negative part');
    }
    assert.deepEqual(_splitByWeight(10, [0, 0, 0]), [0, 0, 0], 'zero weights divide into nothing');
});

test('every sync-job row is TERMINAL — a PENDING row would be claimed by the runner and executed for real', () => {
    assert.ok(DATASET.sync_jobs.length > 0, 'the Sync page has a run history to render');
    for (const job of DATASET.sync_jobs) {
        assert.ok(
            job.status === 'SUCCESS' || job.status === 'FAILED',
            `a demo sync job is ${job.status}; gi_sync_jobs is the QUEUE, not a log of one`
        );
        assert.ok(job.completed_at instanceof Date, 'a terminal job has a completion time');
    }
    assert.ok(DATASET.sync_jobs.some((job) => job.status === 'FAILED'), 'and one failure, so the page shows what one looks like');
});


/* ==========================================================================
 *  6. IT IS IMPOSSIBLE TO MISTAKE FOR REAL DATA
 * ========================================================================== */

test('every shop domain is in the reserved .example TLD and prefixed demo-', () => {
    const domains = new Set();
    for (const row of DATASET.events) {
        domains.add(row.shop_domain);
    }
    for (const row of DATASET.transactions) {
        domains.add(row.shop_domain);
    }
    for (const row of DATASET.attributions) {
        domains.add(row.shop_domain);
    }

    assert.ok(domains.size > 100, `${domains.size} distinct shops`);
    for (const domain of domains) {
        assert.ok(domain.endsWith(DEMO_DOMAIN_SUFFIX), `${domain} is not in the reserved TLD`);
        assert.ok(domain.startsWith('demo-'), `${domain} is not prefixed`);
        // RFC 2606 reserves .example precisely so it can never be delegated, which is
        // what makes a collision with a real *.myshopify.com store impossible rather
        // than merely unlikely.
        assert.equal(domain.includes('.myshopify.com'), false, `${domain} looks like a real store`);
    }
});

test('the app row and every raw payload carry the machine-readable marker', () => {
    assert.equal(DATASET.app.metadata.demo.marker, DEMO_MARKER);
    assert.equal(DATASET.app.partner_api_app_id, DEMO_APP.partner_api_app_id);
    assert.ok(DATASET.app.display_name.includes('DEMO DATA'), 'the app name says so on every page header');

    for (const row of DATASET.events) {
        assert.equal(row.raw_event.demo_dataset, DEMO_MARKER, 'an event payload is unmarked');
    }
    for (const row of DATASET.transactions) {
        assert.equal(row.raw_transaction.demo_dataset, DEMO_MARKER, 'a payout payload is unmarked');
    }
});


/* ==========================================================================
 *  7. IDEMPOTENCE — the same anchor regenerates the same dataset
 *
 *  This is what makes a second `npm run seed:demo` a no-op rather than a second
 *  dataset. Every row's identity is derived from its content, so identical
 *  content is identical rows.
 * ========================================================================== */

test('generating twice at one anchor produces identical rows', () => {
    const again = generateDemoDataset({ anchor_at: ANCHOR });

    assert.deepEqual(
        again.events.map((row) => row.partner_event_id),
        DATASET.events.map((row) => row.partner_event_id)
    );
    assert.deepEqual(
        again.transactions.map((row) => row.shopify_transaction_id),
        DATASET.transactions.map((row) => row.shopify_transaction_id)
    );
    assert.equal(again.stores.length, DATASET.stores.length);
    assert.equal(again.funnel_days.length, DATASET.funnel_days.length);
    assert.equal(again.quiet_window.month, DATASET.quiet_window.month);
});

test('a different anchor produces a different dataset — which is what --reanchor is for', () => {
    const shifted = generateDemoDataset({ anchor_at: new Date(ANCHOR.getTime() + 45 * _DAY_MS) });
    assert.notDeepEqual(
        shifted.events.map((row) => row.partner_event_id).slice(0, 20),
        DATASET.events.map((row) => row.partner_event_id).slice(0, 20)
    );
    assert.notEqual(shifted.quiet_window.month, DATASET.quiet_window.month);
});

test('the generator refuses an invalid anchor rather than inventing one', () => {
    assert.throws(() => generateDemoDataset({ anchor_at: null }), TypeError);
    assert.throws(() => generateDemoDataset({ anchor_at: new Date('nonsense') }), TypeError);
});


/* ==========================================================================
 *  8. THE SAFETY REFUSAL
 *
 *  The seeder writes fiction into the same collections a real sync writes facts
 *  into, joined on the same keys. Nothing downstream can tell them apart. These
 *  assert that a refusal writes NOTHING — the message is secondary.
 * ========================================================================== */

/** Every repository method the service can reach, replaced with a recording stub. */
const _installRepositoryStub = ({ existingApp, foreignApps, foreignRows }) => {
    const calls = { inserts: 0, deletes: 0, watermarks: 0, upserts: 0, appDeletes: 0 };

    demoSeedRepository.findAppByGid = async () => existingApp;
    demoSeedRepository.summariseForeignApps = async () => (typeof foreignApps === 'number' ? { total: foreignApps, never_synced: 0 } : foreignApps);
    demoSeedRepository.countForeignRows = async () => foreignRows;
    demoSeedRepository.countDemoRows = async () => ({});
    demoSeedRepository.ensureIndexes = async () => undefined;
    demoSeedRepository.upsertDemoApp = async ({ fields }) => {
        calls.upserts += 1;
        return { _id: 'demo-app-id', ...fields };
    };
    demoSeedRepository.deleteRowsForApp = async () => {
        calls.deletes += 1;
        return { events: 0 };
    };
    demoSeedRepository.deleteApp = async () => {
        calls.appDeletes += 1;
        return 1;
    };
    for (const name of ['insertEvents', 'insertTransactions', 'insertFunnelDays', 'insertSourceDays', 'insertGeoDays', 'insertAttributions', 'insertSyncJobs']) {
        demoSeedRepository[name] = async ({ rows }) => {
            calls.inserts += 1;
            return rows.length;
        };
    }
    demoSeedRepository.writeWatermarks = async () => {
        calls.watermarks += 1;
    };

    return calls;
};

/** An app row that IS the demo app. */
const _markedApp = (anchorIso) => ({
    _id: 'demo-app-id',
    partner_api_app_id: DEMO_APP.partner_api_app_id,
    metadata: { demo: { marker: DEMO_MARKER, anchor_at: anchorIso } }
});

test('a database holding another app is REFUSED, and nothing is written', async () => {
    const calls = _installRepositoryStub({ existingApp: null, foreignApps: 1, foreignRows: {} });

    const outcome = await demoSeedService.seedDemoDataset({ force: false, reanchor: false, now: ANCHOR });

    assert.equal(outcome.status, 'REFUSED');
    assert.match(outcome.message, /already holds data the demo seeder did not write/);
    assert.match(outcome.message, /--force/, 'the refusal names the way out');
    assert.equal(calls.inserts, 0, 'nothing was inserted');
    assert.equal(calls.deletes, 0, 'nothing was deleted');
    assert.equal(calls.upserts, 0, 'no app row was written');
    assert.equal(calls.watermarks, 0, 'no watermark was moved');
});

test('a database with NO app row but orphaned fact rows is refused too — those are still a real history', async () => {
    // The case an app-count-only gate waves through: an app row deleted by hand
    // leaves its events and payouts behind.
    const calls = _installRepositoryStub({
        existingApp: null,
        foreignApps: 0,
        foreignRows: { events: 4210, transactions: 900, funnel_days: 0, source_days: 0, geo_days: 0, attributions: 0, sync_jobs: 0 }
    });

    const outcome = await demoSeedService.seedDemoDataset({ force: false, reanchor: false, now: ANCHOR });

    assert.equal(outcome.status, 'REFUSED');
    assert.match(outcome.message, /5110 fact rows/, 'the refusal counts what it found');
    assert.doesNotMatch(outcome.message, /\b1 fact rows\b/, 'and says "row" for one');
    assert.match(outcome.message, /4210 events/, 'and says which collections');
    assert.equal(calls.inserts, 0);
    assert.equal(calls.upserts, 0);
});

test('an UNMARKED app row on the demo GID is refused even with --force — it is not ours to overwrite', async () => {
    const calls = _installRepositoryStub({
        existingApp: { _id: 'someone-elses-app', partner_api_app_id: DEMO_APP.partner_api_app_id, metadata: {} },
        foreignApps: 0,
        foreignRows: {}
    });

    const outcome = await demoSeedService.seedDemoDataset({ force: true, reanchor: false, now: ANCHOR });

    assert.equal(outcome.status, 'REFUSED');
    assert.match(outcome.message, /carries no demo marker/);
    assert.equal(calls.inserts, 0);
    assert.equal(calls.upserts, 0);
});

test('a sync-job row does NOT trip the gate — it is bookkeeping, and its app scope is optional', async () => {
    // ⚠️ `gi_sync_jobs.partner_app_id` is optional, so a job with no app scope matches
    // `$ne: <demo app>`. Counting it as foreign data would make the seeder refuse on
    // any deployment that has ever been started.
    const calls = _installRepositoryStub({
        existingApp: null,
        foreignApps: { total: 0, never_synced: 0 },
        foreignRows: { events: 0, transactions: 0, funnel_days: 0, source_days: 0, geo_days: 0, attributions: 0 }
    });

    const outcome = await demoSeedService.seedDemoDataset({ force: false, reanchor: false, now: ANCHOR });

    assert.equal(outcome.status, 'SEEDED', 'an empty database with only job rows still seeds');
    assert.equal(calls.inserts, 7);
});

test('an app row registered at boot but never synced is refused with THAT reason, not a generic one', async () => {
    // ⚠️ The likeliest false alarm. The backend registers an app row at boot from
    // SHOPIFY_PARTNER_APP_ID, so somebody with an otherwise empty database hits the
    // gate on their first try. A refusal that says "you already have data" to
    // somebody who does not sends them hunting for history that is not there.
    const calls = _installRepositoryStub({
        existingApp: null,
        foreignApps: { total: 1, never_synced: 1 },
        foreignRows: {}
    });

    const outcome = await demoSeedService.seedDemoDataset({ force: false, reanchor: false, now: ANCHOR });

    assert.equal(outcome.status, 'REFUSED');
    assert.match(outcome.message, /never synced/, 'the refusal says the app row carries no data');
    assert.match(outcome.message, /SHOPIFY_PARTNER_APP_ID/, 'and names the variable that created it');
    assert.equal(calls.inserts, 0);
});

test('a foreign app row that HAS synced gets the generic refusal — that database really does hold history', async () => {
    _installRepositoryStub({
        existingApp: null,
        foreignApps: { total: 1, never_synced: 0 },
        foreignRows: {}
    });

    const outcome = await demoSeedService.seedDemoDataset({ force: false, reanchor: false, now: ANCHOR });

    assert.equal(outcome.status, 'REFUSED');
    assert.doesNotMatch(outcome.message, /never synced/, 'a synced app must not be explained away');
    assert.match(outcome.message, /--force/);
});

test('--force writes anyway, and sets every watermark the pages gate on', async () => {
    const calls = _installRepositoryStub({
        existingApp: null,
        foreignApps: 2,
        foreignRows: { events: 10 }
    });

    const outcome = await demoSeedService.seedDemoDataset({ force: true, reanchor: false, now: ANCHOR });

    assert.equal(outcome.status, 'SEEDED');
    assert.equal(calls.inserts, 7, 'all seven collections were written');
    assert.equal(calls.deletes, 1, 'the previous demo rows were replaced, not appended to');
    assert.equal(calls.watermarks, 1);

    // ⚠️ Without these the pages correctly answer NEVER_SYNCED and render banners
    // over a fully seeded database.
    assert.ok(outcome.watermarks.last_synced_at instanceof Date, 'partner watermark');
    assert.ok(outcome.watermarks.lifetime_sync_completed_at instanceof Date, 'lifetime gate');
    assert.ok(outcome.watermarks.last_bq_synced_at instanceof Date, 'listing rollup watermark');
    assert.ok(outcome.watermarks.last_install_attrib_synced_at instanceof Date, 'attribution watermark');
    for (const gate of ['earliest_event_at', 'earliest_transaction_at', 'shop_name_coverage_since', 'event_history_gap_days', 'charge_link_absent_pct', 'charge_link_unresolved_pct']) {
        assert.ok(gate in outcome.watermarks, `the ${gate} coverage gate was written`);
    }
    assert.equal(outcome.summary.forced, true);
});

test('a re-run reuses the stored anchor, so it regenerates its own rows rather than a second dataset', async () => {
    const storedAnchor = new Date('2026-01-09T00:00:00.000Z');
    _installRepositoryStub({
        existingApp: _markedApp(storedAnchor.toISOString()),
        foreignApps: 0,
        foreignRows: {}
    });

    const outcome = await demoSeedService.seedDemoDataset({ force: false, reanchor: false, now: ANCHOR });

    assert.equal(outcome.status, 'SEEDED');
    assert.equal(outcome.anchor_at.toISOString(), storedAnchor.toISOString(), 'the stored anchor won, not today');
    assert.equal(outcome.summary.reanchored, false);
});

test('--reanchor re-dates the dataset to now', async () => {
    _installRepositoryStub({
        existingApp: _markedApp('2026-01-09T00:00:00.000Z'),
        foreignApps: 0,
        foreignRows: {}
    });

    const outcome = await demoSeedService.seedDemoDataset({ force: false, reanchor: true, now: ANCHOR });

    assert.equal(outcome.status, 'SEEDED');
    assert.equal(outcome.anchor_at.toISOString(), ANCHOR.toISOString());
    assert.equal(outcome.summary.reanchored, true);
});


/* ==========================================================================
 *  9. THE TEARDOWN REMOVES EXACTLY WHAT IT WROTE
 * ========================================================================== */

test('the teardown removes the demo app rows and the app row itself', async () => {
    const calls = _installRepositoryStub({
        existingApp: _markedApp(ANCHOR.toISOString()),
        foreignApps: 0,
        foreignRows: {}
    });

    const outcome = await demoSeedService.teardownDemoDataset();

    assert.equal(outcome.status, 'REMOVED');
    assert.equal(calls.deletes, 1, 'the scoped delete ran once');
    assert.equal(calls.appDeletes, 1, 'and the app row went with it');
});

test('the teardown REFUSES an unmarked app row — deleting it would take a real history with it', async () => {
    const calls = _installRepositoryStub({
        existingApp: { _id: 'someone-elses-app', partner_api_app_id: DEMO_APP.partner_api_app_id, metadata: { demo: { marker: 'something-else' } } },
        foreignApps: 0,
        foreignRows: {}
    });

    const outcome = await demoSeedService.teardownDemoDataset();

    assert.equal(outcome.status, 'REFUSED');
    assert.match(outcome.message, /carries no demo marker/);
    assert.equal(calls.deletes, 0, 'nothing was deleted');
    assert.equal(calls.appDeletes, 0, 'and no app row was removed');
});

test('the teardown on a database with no demo app is a no-op, not an error', async () => {
    const calls = _installRepositoryStub({ existingApp: null, foreignApps: 0, foreignRows: {} });

    const outcome = await demoSeedService.teardownDemoDataset();

    assert.equal(outcome.status, 'NOTHING_TO_DO');
    assert.equal(calls.deletes, 0);
    assert.equal(calls.appDeletes, 0);
});

test('the teardown never issues an unscoped delete — every call carries the demo app id', async () => {
    const seen = [];
    _installRepositoryStub({ existingApp: _markedApp(ANCHOR.toISOString()), foreignApps: 0, foreignRows: {} });
    demoSeedRepository.deleteRowsForApp = async (params) => {
        seen.push(params);
        return {};
    };
    demoSeedRepository.deleteApp = async (params) => {
        seen.push(params);
        return 1;
    };

    await demoSeedService.teardownDemoDataset();

    assert.equal(seen.length, 2);
    for (const params of seen) {
        assert.equal(params.demo_app_id, 'demo-app-id', 'a delete ran without an app scope');
    }
});
