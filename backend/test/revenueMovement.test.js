'use strict';

/**
 * ============================================================================
 *  MRR AT A PAST DATE, AND HOW IT MOVED — the four money bugs, pinned
 * ============================================================================
 *
 *  Exercises `modules/revenue/helpers/asOfMrr` and `modules/revenue/helpers/movementSince` directly,
 *  by DEEP PATH. Both are pure — no models, no config, no clock — so this file touches no database
 *  and stubs nothing at all: every input is a hand-built array of charge rows and every assertion is
 *  about arithmetic that ran for real.
 *
 *   THE AS-OF PREDICATE IS NOT STUBBED AND MUST NEVER BE. Every membership question below goes
 *  through `ledgerMrr.liveSetAsOf`, the canonical definition of who is paying us. A test that
 *  replaced it would prove nothing about the thing most likely to go wrong — it would prove that a
 *  fake agrees with itself.
 *
 *  Each block below is a bug that actually shipped and was measured:
 *
 *    1. THE MOVEMENT PANEL THAT DOES NOT BALANCE. Six plausible figures printed in equation order
 *       under two balances they do not add up to. A reader who checks the arithmetic cannot tell
 *       which of the six to distrust, so the card poisons all of them.
 *
 *    2. A PAST MONTH THAT IS NOT A PAST MONTH. Taking today's subscriber list and valuing it at old
 *       prices. Wrong invisibly and in one direction: an uninstalled merchant's plan reference is
 *       reset, so they contribute NOTHING to any historical month — every past month under-reports
 *       by exactly the customers who left, which erases the churn the chart was drawn to show.
 *
 *    3. THE ANNUAL BLIND SPOT. A yearly subscriber vanishing from MRR for ~11 months of every 12
 *       under a fixed window, and a year of revenue booked whole as one month of run-rate.
 *
 *    4. `ACTIVE_SUB_WINDOW_DAYS` IN BOTH DIRECTIONS. Too narrow produced a measured 47.6% churn
 *       reading for a month in which nobody cancelled (12 x 30 = 360, so every shop skips one
 *       calendar month a year); too wide produced $45M of MRR against $10K of settled payouts, on a
 *       suspiciously flat line.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const REVENUE_ROOT = path.join(BACKEND_ROOT, 'src', 'modules', 'revenue');

// Deep paths, deliberately: these two helpers are PURE, and reaching them through the module barrel
// would load the services behind it — which reach the model registry and connect to mongoose at
// import. A pure helper's own test must not need a database.
const asOfMrrHelper = require(path.join(REVENUE_ROOT, 'helpers', 'asOfMrr.helper.ts'));
const movementSinceHelper = require(path.join(REVENUE_ROOT, 'helpers', 'movementSince.helper.ts'));
const revenueConstants = require(path.join(REVENUE_ROOT, 'constants', 'revenueOverview.constants.ts'));
const config = require(path.join(BACKEND_ROOT, 'src', 'config', 'index.ts'));

// THE OTHER GROSS-CHURN IMPLEMENTATION, so the two can be compared rather than described. Deep
// path into `modules/conversion` for the same reason as above — the helper is PURE, and its barrel
// would drag the services (and the model registry) in behind it.
const revenueChurnHelper = require(path.join(
    BACKEND_ROOT, 'src', 'modules', 'conversion', 'helpers', 'revenueChurn.helper.ts'
));

const { mrrAsOf, isSupportedBoundary, buildTrendMonths, rollupByPlan } = asOfMrrHelper;
const { foldMrrMovement, movementSinceState } = movementSinceHelper;
const { churnRates } = revenueChurnHelper;
const { MOVEMENT_SINCE_STATES, UNKNOWN_PLAN_LABEL } = revenueConstants;

/** The window under test is the SHIPPED one, read from config — not a number retyped here. */
const WINDOW_DAYS = config.REVENUE.ACTIVE_SUB_WINDOW_DAYS;

const _DAY_MS = 24 * 60 * 60 * 1000;
const _at = (iso) => new Date(iso);

/** One settled `APP_SUBSCRIPTION` payout, as `fetchSubscriptionChargeHistory` flattens it. */
const _charge = (shopId, domain, createdAt, gross = 29, interval = 'EVERY_30_DAYS') => ({
    shop_id: shopId,
    shop_domain: domain,
    gross,
    currency: 'USD',
    billing_interval: interval,
    created_at: createdAt
});

/** NEWEST FIRST — `liveSetAsOf` accepts the first row it sees per shop and relies on that order. */
const _newestFirst = (rows) => [...rows].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

/** A paying set built by hand, for the movement fold. Keyed the way `liveSetAsOf` keys its own. */
const _set = (entries) => {
    const map = new Map();
    for (const [shopId, amount, domain, interval] of entries) {
        map.set(shopId, {
            shop_id: shopId,
            shop_domain: domain || `${shopId}.myshopify.com`,
            monthly_amount: amount,
            charged_amount: amount,
            currency: 'USD',
            billing_interval: interval || 'EVERY_30_DAYS',
            last_charged_at: _at('2026-06-01T00:00:00.000Z')
        });
    }
    return map;
};


/* ==========================================================================
 *  1.  THE RECONCILIATION IDENTITY
 * ========================================================================== */

test(' opening + new + expansion − contraction − churned === closing, EXACTLY', () => {
    // One store of every kind, plus one that did not move at all — the last is what makes the
    // identity non-trivial: it belongs to both balances and to no bucket.
    const open = _set([
        ['held', 50], // unchanged: in both balances, in no bucket
        ['grew', 29], // expansion 29 -> 99
        ['shrank', 99], // contraction 99 -> 29
        ['left', 199] // churned
    ]);
    const close = _set([
        ['held', 50],
        ['grew', 99],
        ['shrank', 29],
        ['arrived', 9] // new
    ]);

    const fold = foldMrrMovement({ open_set: open, close_set: close });
    const t = fold.totals;

    assert.equal(t.start_mrr, 50 + 29 + 99 + 199);
    assert.equal(t.end_mrr, 50 + 99 + 29 + 9);
    assert.equal(t.new_mrr, 9);
    assert.equal(t.expansion_mrr, 70);
    // MAGNITUDES, published positive — the card carries the direction, so a sign flip on this side
    // can never turn a churn column green.
    assert.equal(t.contraction_mrr, 70);
    assert.equal(t.churned_mrr, 199);

    const expected = t.start_mrr + t.new_mrr + t.expansion_mrr - t.contraction_mrr - t.churned_mrr;
    assert.equal(expected, t.end_mrr, 'the six figures on the card must add up to the two balances beside them');
    assert.equal(fold.reconciliation.expected_closing, fold.reconciliation.closing);
    assert.equal(fold.reconciliation.drift, 0);
});

test(' the reconciliation guard is LIVE — a fold that cannot balance THROWS rather than publishing', () => {
    /**
     * A `Map` whose membership test disagrees with its own iteration — the shape any future bug that
     * breaks the identity would have: a store counted in one balance and in no bucket.
     *
     * Without this, "the identity holds" is only ever a statement about the fixtures. With it, the
     * refusal itself is proved: a movement card that does not balance is six mutually contradictory
     * claims, and an exception that becomes an honest failure envelope is better than any of them.
     */
    class ClaimsToHoldEverything extends Map {
        has() {
            return true;
        }
    }
    const open = _set([['stranded', 29]]);
    const close = new ClaimsToHoldEverything();

    assert.throws(
        () => foldMrrMovement({ open_set: open, close_set: close }),
        /does not reconcile/,
        'the identity must be asserted, not merely computed'
    );
});

test('a window in which nothing moved reconciles at zero, and publishes NO churn rate for an empty base', () => {
    const fold = foldMrrMovement({ open_set: new Map(), close_set: new Map() });
    assert.equal(fold.totals.start_mrr, 0);
    assert.equal(fold.totals.end_mrr, 0);
    //  `null`, NEVER `0`. Every "All time" window opens with no paying base, and "0.0% gross churn"
    // over a period in which nobody was paying is a claim of perfect retention.
    assert.equal(fold.totals.gross_churn_rate, null);
    assert.equal(fold.totals.net_churn_rate, null);
    // ⚠️ AND THE RETENTION RATES ARE `null`, NEVER `1`. `1 - null` is `1` in JavaScript, so the naive
    // derivation publishes "100.0% net revenue retention" for a window in which nobody was paying —
    // the same lie as "0.0% gross churn", wearing the face an operator is even happier to believe.
    assert.equal(fold.totals.gross_revenue_retention_rate, null);
    assert.equal(fold.totals.net_revenue_retention_rate, null);
});

test('gross churn INCLUDES contraction — one definition, not one per page (was churned/start here)', () => {
    // 100 of the opening 200 cancels and the other 100 halves. Cancellations alone are 50%; what the
    // opening base actually LOST is 150 of 200.
    const open = _set([['left', 100], ['shrank', 100]]);
    const close = _set([['shrank', 50]]);

    const fold = foldMrrMovement({ open_set: open, close_set: close });
    assert.equal(fold.totals.churned_mrr, 100);
    assert.equal(fold.totals.contraction_mrr, 50);

    // THE NUMBER THIS TEST EXISTS FOR. It used to be `100 / 200 = 0.5` — cancellations only —
    // while `/api/revenue/churn` published `(100 + 50) / 200 = 0.75` for the SAME month under the
    // SAME label, so an operator read 50% on Revenue and 75% on Revenue Churn and had no way to tell
    // which was the business. The expectation is CHANGED, not relaxed: 0.75 is the documented
    // formula, stated three times in `modules/conversion/types/revenueChurn.types`.
    assert.equal(fold.totals.gross_churn_rate, 0.75, 'gross churn is cancellations PLUS downgrades');
    assert.notEqual(fold.totals.gross_churn_rate, 0.5, 'the cancellations-only reading is the bug, not a variant');

    // …and the pair is now internally consistent, which it was not: net already included contraction,
    // so gross measured one base's losses while net measured another's.
    assert.equal(fold.totals.net_churn_rate, 0.75, 'no expansion here, so net equals gross exactly');
});

test('the movement card and the Revenue Churn page compute ONE gross churn, proved against the other helper', () => {
    const open = _set([['left', 199], ['shrank', 99], ['grew', 29], ['held', 50]]);
    const close = _set([['shrank', 29], ['grew', 99], ['held', 50], ['arrived', 9]]);

    const fold = foldMrrMovement({ open_set: open, close_set: close });
    // The OTHER implementation, by deep path — the canonical one `GET /api/revenue/churn` publishes.
    // Comparing the two answers is the only assertion that actually forbids the definitions drifting
    // apart again; pinning a literal in each file would let both be edited to two new wrong numbers.
    const theOtherPage = churnRates({
        start_mrr: fold.totals.start_mrr,
        churned_mrr: fold.totals.churned_mrr,
        contraction_mrr: fold.totals.contraction_mrr,
        expansion_mrr: fold.totals.expansion_mrr
    });

    assert.equal(fold.totals.gross_churn_rate, theOtherPage.gross_churn_rate);
    assert.equal(fold.totals.net_churn_rate, theOtherPage.net_churn_rate);
    // New business is in NEITHER — `arrived` is worth 9 and moves neither rate. Folding acquisition
    // into a churn number lets a good sales month paper over a retention problem.
    assert.equal(fold.totals.gross_churn_rate, (199 + 70) / 377);
});

test('GRR and NRR are published as `1 − rate`, and NRR is NOT capped at 1', () => {
    // `a` triples; `b` leaves. Losses 100 of 200, gains 200 — net churn −0.5, so NRR is 1.5.
    const open = _set([['a', 100], ['b', 100]]);
    const close = _set([['a', 300]]);

    const fold = foldMrrMovement({ open_set: open, close_set: close });
    assert.equal(fold.totals.gross_revenue_retention_rate, 0.5, 'half the opening base still pays, expansion ignored');
    //  ABOVE 1, ON PURPOSE. A base that grew on its own before a single new customer was counted is
    // the month worth reporting; capping NRR at 1 would render it as a flat, unremarkable 100%.
    assert.equal(fold.totals.net_revenue_retention_rate, 1.5);
    assert.equal(fold.totals.gross_revenue_retention_rate, 1 - fold.totals.gross_churn_rate);
    assert.equal(fold.totals.net_revenue_retention_rate, 1 - fold.totals.net_churn_rate);
});

test('a base that lost everything retains 0.0 — a MEASURED zero, which is not the same as null', () => {
    const fold = foldMrrMovement({ open_set: _set([['gone', 80]]), close_set: new Map() });
    assert.equal(fold.totals.gross_churn_rate, 1);
    // `0`, not `null`: the base existed and every dollar of it left. The empty-base case one test up
    // is the one that must be null, and the two must never be collapsed into one answer.
    assert.equal(fold.totals.gross_revenue_retention_rate, 0);
    assert.equal(fold.totals.net_revenue_retention_rate, 0);
});

test(' net churn is NOT clamped at zero — expansion outrunning losses reads NEGATIVE', () => {
    const open = _set([['a', 100], ['b', 100]]);
    // `a` triples; `b` leaves. Losses 100, gains 200 — net churn is −100/200.
    const close = _set([['a', 300]]);

    const fold = foldMrrMovement({ open_set: open, close_set: close });
    assert.equal(fold.totals.churned_mrr, 100);
    assert.equal(fold.totals.expansion_mrr, 200);
    assert.equal(fold.totals.gross_churn_rate, 0.5);
    assert.equal(
        fold.totals.net_churn_rate,
        -0.5,
        'negative net churn is the single best signal a subscription business has; rounding it up to zero hides the best months'
    );
});

test(' every count IS its bucket\'s length — the card and its drill-down are one number', () => {
    const open = _set([['x', 10], ['y', 20], ['z', 30]]);
    const close = _set([['x', 99], ['y', 5], ['w', 40]]);

    const fold = foldMrrMovement({ open_set: open, close_set: close });
    assert.equal(fold.totals.new_count, fold.buckets.new.length);
    assert.equal(fold.totals.expanded_count, fold.buckets.expansion.length);
    assert.equal(fold.totals.contracted_count, fold.buckets.contraction.length);
    assert.equal(fold.totals.churned_count, fold.buckets.churned.length);
    assert.equal(fold.totals.new_count, 1);
    assert.equal(fold.totals.expanded_count, 1);
    assert.equal(fold.totals.contracted_count, 1);
    assert.equal(fold.totals.churned_count, 1);
});

test('a store paying the SAME amount at both ends is in no bucket at all', () => {
    const open = _set([['steady', 49]]);
    const close = _set([['steady', 49]]);
    const fold = foldMrrMovement({ open_set: open, close_set: close });

    assert.equal(fold.buckets.new.length, 0);
    assert.equal(fold.buckets.expansion.length, 0);
    assert.equal(fold.buckets.contraction.length, 0);
    assert.equal(fold.buckets.churned.length, 0);
    // …and it is still in both balances, which is exactly what makes the identity meaningful.
    assert.equal(fold.totals.start_mrr, 49);
    assert.equal(fold.totals.end_mrr, 49);
});


/* ==========================================================================
 *  2.  A PAST MONTH MUST ACTUALLY BE A PAST MONTH
 * ========================================================================== */

test(' a merchant who has since uninstalled STILL CONTRIBUTES to the months they were paying', () => {
    const now = _at('2026-09-01T00:00:00.000Z');
    // `gone` paid through the spring and then stopped — the shape of an uninstall, where the plan
    // reference is reset and the store disappears from every "current subscribers" list.
    const history = _newestFirst([
        _charge('gone', 'gone.myshopify.com', _at('2026-03-05T00:00:00.000Z'), 99),
        _charge('gone', 'gone.myshopify.com', _at('2026-04-04T00:00:00.000Z'), 99),
        _charge('stayed', 'stayed.myshopify.com', _at('2026-03-05T00:00:00.000Z'), 29),
        _charge('stayed', 'stayed.myshopify.com', _at('2026-04-04T00:00:00.000Z'), 29),
        _charge('stayed', 'stayed.myshopify.com', _at('2026-08-20T00:00:00.000Z'), 29)
    ]);

    const april = mrrAsOf({ history, as_of: _at('2026-04-30T23:59:59.999Z'), window_days: WINDOW_DAYS });
    const today = mrrAsOf({ history, as_of: now, window_days: WINDOW_DAYS });

    assert.ok(april.live_set.has('gone'), 'the uninstalled merchant was paying in April and must be in April');
    assert.equal(april.mrr, 128, 'April is 99 + 29 — the figure a "today, valued at old prices" reconstruction cannot reach');
    assert.equal(april.active_subs, 2);

    assert.equal(today.live_set.has('gone'), false, 'and is correctly absent from today');
    assert.equal(today.mrr, 29);

    // The whole point, stated as an inequality: the past is LARGER than the present here, which is
    // precisely the churn a replay of today's subscriber list would have erased.
    assert.ok(
        april.mrr > today.mrr,
        'a past month reconstructed from today\'s subscriber list would under-report by exactly the customers who left'
    );
});

test('a shop whose FIRST charge predates the synced range is still counted — nothing is dropped for want of an install event', () => {
    // No install event exists anywhere in this fixture, and none is needed: the ledger is the source.
    // The replay this replaced skipped such a shop entirely (`if (latestInstallIdx === -1) continue;`).
    const history = _newestFirst([_charge('ancient', 'ancient.myshopify.com', _at('2026-08-25T00:00:00.000Z'), 499)]);
    const figures = mrrAsOf({ history, as_of: _at('2026-09-01T00:00:00.000Z'), window_days: WINDOW_DAYS });

    assert.equal(figures.active_subs, 1);
    assert.equal(figures.mrr, 499);
});


/* ==========================================================================
 *  3.  THE ANNUAL BLIND SPOT
 * ========================================================================== */

test(' an annual subscriber does NOT vanish for eleven months of every twelve', () => {
    const charged = _at('2026-01-15T00:00:00.000Z');
    const history = _newestFirst([_charge('yearly', 'yearly.myshopify.com', charged, 1200, 'ANNUAL')]);

    // Every month end from the charge to eleven months later. Under a flat 38-day window this shop
    // is live for exactly one of them and the MRR line saws for the other eleven.
    const monthEnds = buildTrendMonths({ as_of: _at('2026-12-31T23:59:59.999Z'), months: 12 })
        .map((month) => month.end)
        .filter((end) => end.getTime() >= charged.getTime());

    assert.ok(monthEnds.length >= 11, 'the fixture must actually span the year it is testing');
    for (const end of monthEnds) {
        const figures = mrrAsOf({ history, as_of: end, window_days: WINDOW_DAYS });
        assert.equal(
            figures.active_subs,
            1,
            `an annual subscriber must still be live at ${end.toISOString()} — a fixed 38-day window drops them`
        );
        //  AND IT IS BOOKED AT /12. A year of revenue counted whole overstates a MONTHLY run-rate
        // twelvefold: 1200 where the truth is 100.
        assert.equal(figures.mrr, 100, 'gross_amount is what the merchant paid; an ANNUAL charge is a year of it');
    }
});

test('the /12 is driven by the INTERVAL, not by the amount — the same charge billed monthly is booked whole', () => {
    const charged = _at('2026-08-20T00:00:00.000Z');
    const asOf = _at('2026-09-01T00:00:00.000Z');
    const monthly = mrrAsOf({
        history: [_charge('big', 'big.myshopify.com', charged, 1200, 'EVERY_30_DAYS')],
        as_of: asOf,
        window_days: WINDOW_DAYS
    });
    assert.equal(monthly.mrr, 1200);
});

test('a live shop whose charge names NO interval is counted, and the count is published as the caveat', () => {
    // ⚠️ A null interval is treated as monthly — right for a genuine monthly plan and twelvefold wrong
    // for an annual subscriber on a row synced before the field was captured. The COUNT is what turns
    // that from a footnote nobody can act on into a number a reader can check.
    const history = _newestFirst([_charge('unlabelled', 'unlabelled.myshopify.com', _at('2026-08-25T00:00:00.000Z'), 1200, null)]);
    const figures = mrrAsOf({ history, as_of: _at('2026-09-01T00:00:00.000Z'), window_days: WINDOW_DAYS });

    assert.equal(figures.mrr, 1200);
    assert.equal(figures.billing_interval_unknown_shops, 1);
});


/* ==========================================================================
 *  4.  THE 38-DAY WINDOW, IN BOTH DIRECTIONS
 * ========================================================================== */

test(' a 30-day biller SKIPS A CALENDAR MONTH and must NOT be reported as churned for it', () => {
    // 12 x 30 = 360, so every shop on a 30-day cycle skips one calendar month a year. Charges 31 days
    // apart, arranged so that MARCH 2026 contains none at all.
    const history = _newestFirst([
        _charge('cyclic', 'cyclic.myshopify.com', _at('2026-01-30T00:00:00.000Z')),
        _charge('cyclic', 'cyclic.myshopify.com', _at('2026-02-28T00:00:00.000Z')),
        _charge('cyclic', 'cyclic.myshopify.com', _at('2026-04-01T00:00:00.000Z')),
        _charge('cyclic', 'cyclic.myshopify.com', _at('2026-05-02T00:00:00.000Z'))
    ]);

    // The month with no charge in it. Membership-by-calendar-month would report CHURNED here and NEW
    // the month after — falsely churning ~1/12 of the paying base every month, out of arithmetic.
    const marchStart = _at('2026-03-01T00:00:00.000Z');
    const marchEnd = _at('2026-03-31T23:59:59.999Z');
    const openSet = mrrAsOf({ history, as_of: marchStart, window_days: WINDOW_DAYS }).live_set;
    const closeSet = mrrAsOf({ history, as_of: marchEnd, window_days: WINDOW_DAYS }).live_set;

    assert.equal(openSet.size, 1, 'the shop is paying at the start of the skipped month');
    assert.equal(closeSet.size, 1, 'and at the end of it — no charge landed in between, and none was due');

    const fold = foldMrrMovement({ open_set: openSet, close_set: closeSet });
    assert.equal(fold.totals.churned_count, 0, 'nobody cancelled in this month, so nothing may be reported as churned');
    assert.equal(fold.totals.churned_mrr, 0);
    assert.equal(fold.totals.new_count, 0, 'and nothing may be reported as new the month after, either');
});

test(' a shop that genuinely stopped paying DOES leave the set — the window is not a licence to keep it forever', () => {
    // Last charge is comfortably outside the live window. Removing the window (or widening it) is what
    // produced $45M of MRR against $10K of settled payouts, on a suspiciously flat line.
    const lastCharge = _at('2026-05-01T00:00:00.000Z');
    const asOf = new Date(lastCharge.getTime() + (WINDOW_DAYS + 30) * _DAY_MS);
    const history = _newestFirst([_charge('cancelled', 'cancelled.myshopify.com', lastCharge)]);

    const figures = mrrAsOf({ history, as_of: asOf, window_days: WINDOW_DAYS });
    assert.equal(figures.active_subs, 0, 'a cancellation that never synced must not keep a shop paying for ever');
    assert.equal(figures.mrr, 0, 'and this is a MEASURED zero — the ledger answered, and the answer is nobody');
    // A measured zero MRR still has no average to report.
    assert.equal(figures.arpu, null);
});

test('the boundary is exactly the window — one day inside is live, one day outside is not', () => {
    const charged = _at('2026-05-01T00:00:00.000Z');
    const history = _newestFirst([_charge('edge', 'edge.myshopify.com', charged)]);

    const justInside = new Date(charged.getTime() + (WINDOW_DAYS - 1) * _DAY_MS);
    const justOutside = new Date(charged.getTime() + (WINDOW_DAYS + 1) * _DAY_MS);

    assert.equal(mrrAsOf({ history, as_of: justInside, window_days: WINDOW_DAYS }).active_subs, 1);
    assert.equal(mrrAsOf({ history, as_of: justOutside, window_days: WINDOW_DAYS }).active_subs, 0);
});

test('a refund or zero-value charge ENDS membership — an older positive charge must not fall through', () => {
    // The tombstone branch. Without it the shop's previous, still-in-window charge would be accepted
    // and a refunded merchant would keep contributing their full value.
    const history = _newestFirst([
        _charge('refunded', 'refunded.myshopify.com', _at('2026-08-01T00:00:00.000Z'), 29),
        _charge('refunded', 'refunded.myshopify.com', _at('2026-08-20T00:00:00.000Z'), -29)
    ]);
    const figures = mrrAsOf({ history, as_of: _at('2026-08-25T00:00:00.000Z'), window_days: WINDOW_DAYS });
    assert.equal(figures.active_subs, 0);
});


/* ==========================================================================
 *  5. The coverage gate, the plan partition, and the since-vocabulary
 * ========================================================================== */

test('a boundary whose lookback the stored history cannot cover is UNSUPPORTED — an under-count is never published as a measurement', () => {
    const floor = _at('2026-06-01T00:00:00.000Z');
    const windowMs = WINDOW_DAYS * _DAY_MS;

    // Inside the run-up to the floor: the predicate would see a truncated ledger and under-count.
    assert.equal(isSupportedBoundary(_at('2026-06-10T00:00:00.000Z'), floor, windowMs), false);
    // Far enough past it that the whole lookback is covered.
    assert.equal(isSupportedBoundary(_at('2026-08-01T00:00:00.000Z'), floor, windowMs), true);
    // ⚠️ A NULL FLOOR IS NOT A FLOOR. Never measured is not "no history", and treating it as one would
    // blank every month on a deployment whose gate has simply never been written.
    assert.equal(isSupportedBoundary(_at('2020-01-01T00:00:00.000Z'), null, windowMs), true);
});

test('the per-plan partition SUMS to the set it partitions, and an unnamed plan is labelled rather than guessed', () => {
    const history = _newestFirst([
        _charge('a', 'a.myshopify.com', _at('2026-08-20T00:00:00.000Z'), 29),
        _charge('b', 'b.myshopify.com', _at('2026-08-21T00:00:00.000Z'), 99),
        _charge('c', 'c.myshopify.com', _at('2026-08-22T00:00:00.000Z'), 29)
    ]);
    const figures = mrrAsOf({ history, as_of: _at('2026-09-01T00:00:00.000Z'), window_days: WINDOW_DAYS });

    const rollup = rollupByPlan({
        live_set: figures.live_set,
        plan_by_domain: new Map([['a.myshopify.com', 'Starter'], ['b.myshopify.com', 'Pro']]),
        unknown_label: UNKNOWN_PLAN_LABEL
    });

    const summed = rollup.rows.reduce((total, row) => total + row.mrr_amount, 0);
    const counted = rollup.rows.reduce((total, row) => total + row.active_subs, 0);
    assert.equal(summed, figures.mrr, 'the plan table partitions MRR; it must not lose or invent any of it');
    assert.equal(counted, figures.active_subs);

    // `c` has no named plan. It is LABELLED and COUNTED — never folded into the largest plan, which
    // would move a customer between two rows a reader is comparing.
    const unknown = rollup.rows.find((row) => row.plan_name === UNKNOWN_PLAN_LABEL);
    assert.ok(unknown, 'a live shop with no named plan gets its own row rather than someone else\'s');
    assert.equal(unknown.active_subs, 1);
    assert.equal(rollup.unknown_plan_shops, 1);
});

test('the movement-since vocabulary compares MONEY first and never claims a plan change from a missing name', () => {
    const base = { was_paying_at_close: true, amount_at_close: 29, plan_at_close: 'Starter' };

    assert.equal(
        movementSinceState({ ...base, is_paying_now: true, amount_now: 99, plan_now: 'Starter' }),
        MOVEMENT_SINCE_STATES.UPGRADED
    );
    assert.equal(
        movementSinceState({ ...base, is_paying_now: true, amount_now: 9, plan_now: 'Starter' }),
        MOVEMENT_SINCE_STATES.DOWNGRADED
    );
    assert.equal(
        movementSinceState({ ...base, is_paying_now: true, amount_now: 29, plan_now: 'Growth' }),
        MOVEMENT_SINCE_STATES.PLAN_CHANGED
    );
    assert.equal(
        movementSinceState({ ...base, is_paying_now: false, amount_now: 0, plan_now: '' }),
        MOVEMENT_SINCE_STATES.STOPPED_PAYING
    );
    // The churned bucket's happiest row: absent at the close, paying again today.
    assert.equal(
        movementSinceState({
            was_paying_at_close: false, amount_at_close: 0, plan_at_close: '',
            is_paying_now: true, amount_now: 29, plan_now: 'Starter'
        }),
        MOVEMENT_SINCE_STATES.RESUBSCRIBED
    );
    // ⚠️ `''` IS "NO CHARGE EVENT NAMES A PLAN", NOT "A DIFFERENT PLAN". The badge for PLAN_CHANGED
    // reads "still paying the same amount, but on a differently named plan" — a specific claim built
    // entirely out of an absence.
    assert.equal(
        movementSinceState({ ...base, plan_at_close: '', is_paying_now: true, amount_now: 29, plan_now: 'Starter' }),
        MOVEMENT_SINCE_STATES.SAME_PLAN
    );
});

test('the trend months are UTC calendar months, oldest first, with the running one clamped to as_of', () => {
    const asOf = _at('2026-09-14T11:30:00.000Z');
    const months = buildTrendMonths({ as_of: asOf, months: 3 });

    assert.deepEqual(months.map((month) => month.month), ['2026-07', '2026-08', '2026-09']);
    assert.equal(months[0].start.toISOString(), '2026-07-01T00:00:00.000Z');
    // INCLUSIVE and DISJOINT: one millisecond before the next month begins, so a payout settled at
    // exactly midnight cannot land in two months and make them sum to more than the ledger holds.
    assert.equal(months[0].end.toISOString(), '2026-07-31T23:59:59.999Z');
    assert.equal(months[1].is_partial, false);
    assert.equal(months[2].is_partial, true, 'the current month has not finished');
    assert.equal(months[2].end.getTime(), asOf.getTime(), 'and its boundary is clamped — the future cannot be measured');
});
