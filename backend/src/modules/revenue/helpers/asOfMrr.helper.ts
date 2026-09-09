'use strict';

/**
 * ============================================================================
 *  MRR AT ANY PAST DATE
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, and — the one that matters most here — NO CLOCK.
 *  `as_of` is a parameter on every function below, so the same ledger produces the same answer on a
 *  re-run, inside a test, and for a window that closed eight months ago.
 *
 *  ──  THERE IS NO SECOND PREDICATE IN THIS FILE ─────────────────────────────────────────────
 *
 *  "Shop S is paying as of D" is defined ONCE, in `./ledgerMrr.helper`, and this file REACHES it
 *  rather than restating it. Nothing here tests an amount, a recency or a billing interval; every
 *  membership question below is `liveSetAsOf(history, at, windowDays)` and every valuation is the
 *  `monthly_amount` that predicate already computed. That is not stylistic tidiness — the module
 *  barrel records what happened the last time this logic was reachable only by copying it: *two
 *  pages reconstructed MRR independently and disagreed with each other*, and nothing on either
 *  screen said which was right.
 *
 *  So the whole of "MRR at a past date" is: evaluate the SAME predicate at that date. The headline
 *  figure, the monthly series and the movement panel are consistent by construction rather than by
 *  agreement, because they are three readings of one function.
 *
 *  ──  A PAST MONTH MUST ACTUALLY BE A PAST MONTH ───────────────────────────────────────────
 *
 *  The tempting shortcut is to take today's subscriber list and value it at old prices. It is wrong
 *  INVISIBLY, and in the one direction nobody checks: when a merchant uninstalls, their plan
 *  reference is reset, so they are absent from today's list entirely and contribute NOTHING to any
 *  historical month. Every past month then under-reports by exactly the customers who left — which
 *  is to say it erases the churn the chart was drawn to show, while looking like a smooth,
 *  plausible, slightly-growing line.
 *
 *  `liveSetAsOf` cannot make that mistake, because it walks the SETTLED PAYOUT LEDGER: a shop that
 *  paid in March is in March's set whatever it did in April, and a shop whose install predates the
 *  synced range is in every set its payouts support. There is no event history to reconstruct and
 *  nothing to silently drop.
 *
 *  ──  THE ANNUAL BLIND SPOT ────────────────────────────────────────────────────────────────
 *
 *  An annual subscriber is billed once a year. Under a fixed 38-day window they vanish from MRR for
 *  ~11 months of every 12 — the line saws, and the eleven troughs look like churn. `liveWindowDaysFor`
 *  derives the window from the shop's OWN billing interval, so an annual charge keeps its shop live
 *  for a year plus grace; `normalizeToMonthly` then divides that charge by 12, because a year of
 *  revenue booked whole overstates a MONTHLY run-rate twelvefold. Both live in `ledgerMrr.helper` and
 *  both are reached, never re-derived.
 *
 *  ── WHY `isSupportedBoundary` IS HERE AND NOT INLINE ────────────────────────────────────────
 *
 *  The predicate answers "paying at D" by looking back one live window from D. A boundary whose
 *  lookback is not fully covered by stored history sees a TRUNCATED ledger and under-counts — always
 *  downwards, and the resulting "nobody was paying" is indistinguishable from a real one. Every
 *  historical boundary this module publishes is gated on it, and the gate is one function so the
 *  headline, the trend and the movement panel cannot disagree about which dates are answerable.
 * ============================================================================
 */

//  NO model import, and none may be added: `helpers/` is PURE by contract and the ESLint layer
// guard enforces it. Everything here folds data the caller already loaded, which is what lets the
// whole of "MRR at a past date" be unit-tested without a database.
import ledgerMrrHelper = require('./ledgerMrr.helper');

import type { LiveSet, PayingShop } from '../types/ledgerMrr.types';
import type {
    AsOfMrr,
    MrrAsOfInput,
    PlanByDomainAsOfInput,
    PlanRevenueRow,
    PlanRollup,
    RollupByPlanInput,
    TrendMonth,
    TrendMonthInput
} from '../types/asOfMrr.types';
import type { CohortSubscription } from '../../conversion/types/lifecycle.types';

// THE canonical predicate, reached rather than restated. See the header.
const { liveSetAsOf } = ledgerMrrHelper;

/** `YYYY-MM`, UTC. One formatter, so a month's key and its label cannot be spelled two ways. */
const _monthKey = (at: Date): string => {
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** A `Date` only when it genuinely is one and genuinely valid. Used on every comparison boundary. */
const _validDate = (value: unknown): Date | null => {
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
};

/**
 * MRR, subscriber count and ARPU at ONE instant, plus the live set they were reduced from.
 *
 * ONE PASS over the live set, and every figure is derived from that pass. The set itself is
 * published so the movement fold, the plan partition and the drill-down lists all reduce the SAME
 * membership rather than each recomputing it — which is how a card's count and its list come to
 * disagree.
 *
 * THROWS on an invalid `as_of`. There is no honest default for a judgement instant: substituting
 * `new Date()` would make a pure helper read the clock and would make a historical window silently
 * answer as of today. Callers validate once, at the service's entry.
 *
 * @param params0 - See {@link MrrAsOfInput}.
 * @param params0.history - Every settled subscription charge, NEWEST FIRST.
 * @param params0.as_of - The instant to reconstruct.
 * @param params0.window_days - The live window for monthly cadences.
 * @returns The figures and the live set behind them.
 */
const mrrAsOf = ({ history, as_of, window_days }: MrrAsOfInput): AsOfMrr => {
    const at = _validDate(as_of);
    if (!at) {
        throw new TypeError('mrrAsOf requires a valid `as_of` Date — there is no default judgement instant.');
    }

    const liveSet: LiveSet = liveSetAsOf(Array.isArray(history) ? history : [], at, window_days);

    let mrr = 0;
    let unknownInterval = 0;
    const currencies = new Set<string>();
    for (const shop of liveSet.values()) {
        mrr += shop.monthly_amount;
        if (!shop.billing_interval) {
            unknownInterval += 1;
        }
        if (shop.currency) {
            currencies.add(shop.currency);
        }
    }

    const activeSubs = liveSet.size;
    //  `null`, NEVER `0` and never `NaN`. `mrr / 0` is `NaN`, which is typed `number`, passes every
    // guard upstream and renders as the literal word "NaN" on a dashboard; a `0` would claim the
    // average paying customer pays nothing. An empty paying set has no average.
    let arpu: number | null = null;
    if (activeSubs > 0) {
        arpu = mrr / activeSubs;
    }

    return {
        as_of: at,
        live_set: liveSet,
        mrr,
        active_subs: activeSubs,
        arpu,
        currencies: [...currencies].sort(),
        billing_interval_unknown_shops: unknownInterval
    };
};

/**
 * Whether the stored payout history reaches far enough back to decide membership AT `at`.
 *
 *  THE GATE THAT KEEPS AN UNDER-COUNT FROM BEING PUBLISHED AS A MEASUREMENT. `liveSetAsOf` answers
 * "paying at D" by looking back one live window from D, so a boundary is only decidable when that
 * whole lookback is covered by stored payouts. A boundary inside the run-up to the floor sees a
 * truncated ledger and reports fewer paying shops than there were — always downwards, and on a chart
 * it renders as a business that has just started rather than as a gap in the records.
 *
 * ⚠️ `floor === null` RETURNS TRUE. A null coverage gate means the floor was never MEASURED, not
 * that there is no history; treating it as a floor would blank every month on a deployment whose
 * gate has simply never been written. The caller warns about that case instead.
 *
 * @param at - The boundary to test.
 * @param floor - `earliest_transaction_at`, or null when never measured.
 * @param window_ms - The live window, in milliseconds.
 * @returns True when membership at that instant can be decided from stored history.
 */
const isSupportedBoundary = (at: Date, floor: Date | null, window_ms: number): boolean => {
    const boundary = _validDate(at);
    if (!boundary) {
        return false;
    }
    const measured = _validDate(floor);
    if (!measured) {
        return true;
    }
    return boundary.getTime() - window_ms >= measured.getTime();
};

/**
 * The last `months` calendar months ending with the month `as_of` falls in, OLDEST FIRST.
 *
 * ⚠️ UTC, never the server's zone, matching `shared/helpers/dateRange.helper` — which resolves every
 * window in this codebase to UTC day boundaries. A month built in the process's local zone shifts
 * each boundary by the offset, so a payout settled at 23:30 UTC on the 31st falls into the following
 * month for an operator hosting west of Greenwich and not for one hosting east of it. The stored
 * data is UTC; the buckets are UTC.
 *
 * ⚠️ DELIBERATELY MIRRORS `modules/conversion/helpers/monthBucket.helper`, WHICH THIS MODULE MAY NOT
 * REACH. That helper is not on the conversion barrel, and no module in this codebase deep-imports
 * another module's internals — every cross-module edge goes through a barrel (see
 * `modules/store/resolvers/storeRoster.resolver`, which reaches both `conversion` and `revenue` that
 * way). The two walkers are held to the same three rules — UTC, inclusive-and-disjoint bounds, and
 * the newest bucket clamped to `as_of` — and `test/asOfMrr.test.js` pins them. If that helper is
 * ever published, delete this one and import it: two calendar walkers is two chances to disagree
 * about where a month starts, and the disagreement is invisible — both charts render perfectly, with
 * the same labels, describing windows that are off by a day.
 *
 * THROWS on an invalid `as_of`, for the same reason `mrrAsOf` does. A `months` below 1 yields an
 * empty list rather than throwing: that count arrives from a query bag, where a typo is a typo and
 * not something worth refusing a page of data over.
 *
 * @param params0 - See {@link TrendMonthInput}.
 * @param params0.as_of - The instant the newest bucket is clamped to.
 * @param params0.months - How many months, already clamped by the caller.
 * @returns The months, OLDEST FIRST — the order a chart's x-axis reads in.
 */
const buildTrendMonths = ({ as_of, months }: TrendMonthInput): TrendMonth[] => {
    const at = _validDate(as_of);
    if (!at) {
        throw new TypeError('buildTrendMonths requires a valid `as_of` Date — there is no default judgement instant.');
    }

    const count = Number.isFinite(months) ? Math.floor(months) : 0;
    if (count < 1) {
        return [];
    }

    const asOfMs = at.getTime();
    const year = at.getUTCFullYear();
    const month = at.getUTCMonth();

    const out: TrendMonth[] = [];
    for (let back = count - 1; back >= 0; back -= 1) {
        // `Date.UTC` normalises an out-of-range month index on its own, so December of the previous
        // year is `month - 1` with no wrap-around arithmetic to get wrong.
        const start = new Date(Date.UTC(year, month - back, 1));
        const nextStart = new Date(Date.UTC(year, month - back + 1, 1));
        // The month's own last millisecond. `nextStart - 1` rather than "the 28th/30th/31st at
        // 23:59:59.999", so February, a leap year and a DST-free UTC month all fall out of one
        // expression instead of a table someone has to maintain.
        const monthEnd = new Date(nextStart.getTime() - 1);
        const isPartial = monthEnd.getTime() > asOfMs;

        out.push({
            month: _monthKey(start),
            start,
            // CLAMPED to the judgement instant. An unclamped bound on the current month evaluates
            // membership at a date in the future, which reports a state nobody has reached yet.
            end: isPartial ? at : monthEnd,
            month_end: monthEnd,
            is_partial: isPartial
        });
    }

    return out;
};

/**
 * The plan each store held AT one instant, folded from the app's whole subscription list.
 *
 *  A HISTORICAL COLUMN MUST BE IN HISTORICAL TERMS, AND THE COHORT'S `by_domain` IS NOT. That map
 * holds the winner by LATEST `trial_start` — the plan the merchant is on TODAY. Reusing it for a past
 * instant restates the whole historical plan mix in current-plan terms: a merchant who moved from
 * Starter to Pro last week is counted under Pro in every earlier month, so Starter's base loses a
 * customer it really had and Pro's gains one it did not. The MRR total is unaffected either way,
 * which is precisely what makes the error invisible — only the row a shop lands in moves.
 *
 * The winner here is the latest subscription that had STARTED by `as_of`, preferring one that had not
 * already ENDED by then: a subscription still running at that instant describes the merchant, and one
 * that had already closed does not, however recently it started. A domain with no subscription at or
 * before the instant is simply absent, and the caller labels it as unknown rather than borrowing
 * today's plan.
 *
 * @param params0 - See {@link PlanByDomainAsOfInput}.
 * @param params0.subscriptions - The cohort's FLAT list, not its `by_domain` map.
 * @param params0.as_of - The instant to describe.
 * @returns `shop_domain` → the plan name held then. Blank names are omitted.
 */
const planByDomainAsOf = ({ subscriptions, as_of }: PlanByDomainAsOfInput): Map<string, string> => {
    const at = _validDate(as_of);
    if (!at) {
        throw new TypeError('planByDomainAsOf requires a valid `as_of` Date — there is no default judgement instant.');
    }
    const atMs = at.getTime();

    /** A subscription still running at the instant describes the merchant; a closed one does not. */
    const _liveThen = (candidate: CohortSubscription): boolean => {
        const churn = _validDate(candidate.churn_date);
        return !churn || churn.getTime() > atMs;
    };

    const winners = new Map<string, CohortSubscription>();
    for (const subscription of subscriptions || []) {
        if (subscription.shop_domain === '' || subscription.trial_start.getTime() > atMs) {
            continue;
        }
        const incumbent = winners.get(subscription.shop_domain);
        if (!incumbent) {
            winners.set(subscription.shop_domain, subscription);
            continue;
        }
        const challengerLive = _liveThen(subscription);
        const incumbentLive = _liveThen(incumbent);
        if (challengerLive !== incumbentLive) {
            if (challengerLive) {
                winners.set(subscription.shop_domain, subscription);
            }
            continue;
        }
        if (subscription.trial_start.getTime() > incumbent.trial_start.getTime()) {
            winners.set(subscription.shop_domain, subscription);
        }
    }

    const out = new Map<string, string>();
    for (const [domain, subscription] of winners) {
        // `''` is omitted rather than published as a plan called "". The caller's unknown label is
        // the one place a nameless plan gets a word, so there is exactly one spelling of it.
        if (subscription.plan_name !== '') {
            out.set(domain, subscription.plan_name);
        }
    }
    return out;
};

/**
 * Partitions a live set by plan: MRR share, subscriber share and per-plan ARPU.
 *
 * ONE PASS, and every count is derived from it — the rows sum to the set's own MRR and subscriber
 * count exactly, because they are that set re-bucketed rather than a second measurement of it.
 *
 * A live shop the charge events cannot name a plan for lands under `unknown_label` and is COUNTED, so
 * the caller can say how much of the table is unattributed. It is never folded into the largest plan
 * and never borrowed from today's plan: this table partitions the paying base, and a mis-filed
 * customer moves money between two rows a reader is comparing.
 *
 * @param params0 - See {@link RollupByPlanInput}.
 * @param params0.live_set - The set to partition.
 * @param params0.plan_by_domain - `shop_domain` → plan name AT the same instant.
 * @param params0.unknown_label - The label for a live shop with no named plan.
 * @returns The rows, biggest MRR first, plus the unattributed count.
 */
const rollupByPlan = ({ live_set, plan_by_domain, unknown_label }: RollupByPlanInput): PlanRollup => {
    const totals = new Map<string, { subs: number; mrr: number }>();
    let unknownPlanShops = 0;

    for (const shop of live_set.values()) {
        let planName = '';
        if (shop.shop_domain) {
            planName = plan_by_domain.get(shop.shop_domain) || '';
        }
        if (planName === '') {
            planName = unknown_label;
            unknownPlanShops += 1;
        }
        const bucket = totals.get(planName);
        if (bucket) {
            bucket.subs += 1;
            bucket.mrr += shop.monthly_amount;
            continue;
        }
        totals.set(planName, { subs: 1, mrr: shop.monthly_amount });
    }

    const rows: PlanRevenueRow[] = [];
    for (const [planName, bucket] of totals) {
        rows.push({
            plan_name: planName,
            active_subs: bucket.subs,
            mrr_amount: bucket.mrr,
            // A row exists only because at least one shop is on it, so the denominator is never
            // zero here — the guard is kept anyway so the invariant is stated rather than assumed.
            arpu: bucket.subs > 0 ? bucket.mrr / bucket.subs : null
        });
    }

    // Biggest contribution first, then by name so two plans that tie order the same way on every
    // request — on screen, a reshuffle between refreshes reads as the data changing.
    rows.sort((a, b) => (b.mrr_amount - a.mrr_amount) || a.plan_name.localeCompare(b.plan_name));

    return { rows, unknown_plan_shops: unknownPlanShops };
};

/**
 * The shops in a live set, keyed by their `shop_domain` instead of by the producer's own id.
 *
 * The ledger keys its answer by the Partner shop GID, while every plan, subscription and store fact
 * in this build joins on the canonical `shop_domain`. This is the one adaptor between them, written
 * once so two call sites cannot key the same join two ways.
 *
 * ⚠️ A shop whose payout rows carry NO domain is omitted — it cannot join anything — and the caller
 * counts the omission rather than pooling those shops under a blank key, which would merge unrelated
 * merchants into one fabricated store.
 *
 * @param liveSet - The set to re-key.
 * @returns Domain → shop, for every member that has a domain.
 */
const byDomain = (liveSet: LiveSet): Map<string, PayingShop> => {
    const out = new Map<string, PayingShop>();
    for (const shop of liveSet.values()) {
        if (shop.shop_domain) {
            out.set(shop.shop_domain, shop);
        }
    }
    return out;
};

export = {
    mrrAsOf,
    isSupportedBoundary,
    buildTrendMonths,
    planByDomainAsOf,
    rollupByPlan,
    byDomain
};
