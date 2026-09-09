'use strict';

/**
 * ============================================================================
 *  REVENUE, OVER A WINDOW — the post-login landing page
 * ============================================================================
 *
 *  Serves `GET /api/revenue/overview`: the KPI cards, the MRR movement card and its four drill-down
 *  lists, the MRR-and-cash trend, the per-plan breakdown, the lifetime shop ranking, and the
 *  reconciliation block.
 *
 *  ── WHY THIS IS A SECOND ENDPOINT AND NOT AN EXTENSION OF `/api/revenue/now` ────────────────
 *
 *  `/now` is a point-in-time SNAPSHOT whose every figure is a `{ value, confidence, source, reason }`
 *  envelope, and it has two consumers already: an operator reading JSON, and `/api/meta/coverage`,
 *  which is a TRIM OF ITS COVERAGE BLOCK (`controllers/meta.controller.ts` calls `getRevenueNow`
 *  directly). Reshaping it would break both, and the envelope contract there is right for both.
 *
 *  This endpoint answers a different question — "what happened over this window" — for a different
 *  consumer with a different rendering contract. So `/now` is untouched and this is new. The
 *  frontend's `conversionService.getRevenueOverview` moves one path string; nothing else changes.
 *
 *  ──  EVERY FIGURE HERE IS A BARE NUMBER, AND THE TWO STYLES ARE NEVER MIXED ────────────────
 *
 *  Not a relaxation of the honesty rule — an application of it. `pages/revenue/index.js`
 *  formats every number through `moneyFormat.js`, which is `Number(n)` and `typeof n !== 'number'`.
 *  An envelope is an object: `Number({…})` is `NaN`, and `fmtMoney` renders it as an em dash. Handing
 *  that page envelopes turns the entire screen — four KPI cards, six movement blocks, two donuts,
 *  three tables — into dashes, which is the honesty mechanism MANUFACTURING the missing figure it
 *  exists to prevent.
 *
 *  `modules/store/types/storeRoster.types` reached the same conclusion for the same reason and states
 *  the rule: *"Envelopes belong on a coverage endpoint whose renderer is ours."* Here the contract is
 *  discharged through fields that survive rendering instead — `null` for unknown and NEVER `0`,
 *  `measurable` + `unknown_reason` per month, `before_coverage`, `coverage`, `data_state`, `notes[]`,
 *  `warnings[]` and `diagnostics`. The page is built for exactly that: it branches on
 *  `asOf.mrr === null` to print "unknown, not zero" instead of a green zero.
 *
 *  ──  THE WINDOW, NOT A MONTH COUNT ────────────────────────────────────────────────────────
 *
 *  Collapsing the picked range to "N months" throws away WHERE it sits on the timeline, and an April
 *  window then returns today's MRR over an August chart. The range resolver gives `since`/`until`,
 *  and `as_of = min(until, now)` is the ONE instant every point-in-time figure is measured at. The
 *  `months` parameter the frontend still sends is accepted and ignored, and the params type says so.
 *
 *  ── ONE LEDGER READ, MANY EVALUATIONS, ONE PREDICATE ────────────────────────────────────────
 *
 *  `fetchSubscriptionChargeHistory` runs ONCE and `mrrAsOf` — which is `liveSetAsOf` and nothing else
 *  — is evaluated over that one array at every boundary the response needs: the window's open, its
 *  close, now, and each month end. The headline, the movement card and the trend line are therefore
 *  consistent BY CONSTRUCTION rather than by agreement. This file contains no second definition of
 *  who is paying: it never tests an amount, a recency or a billing interval.
 *
 *  ── CASH AND RUN-RATE ARE KEPT STRICTLY APART ───────────────────────────────────────────────
 *
 *  RUN-RATE (`mrr`, `active_subs`, `arpu`, the trend LINE) is a point-in-time rate over subscription
 *  payouts. CASH (`lifetime_*`, `window_cash`, the trend BARS) is money Shopify actually settled,
 *  every transaction type, all time or in the window. They are not two spellings of one number and
 *  are not expected to track — cash is lumpy where a run-rate is smooth — so they sit in separate
 *  blocks with separate labels and are never summed together.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import dateRangeHelper = require('../../shared/helpers/dateRange.helper');
//  FOUR DEEP PATHS INTO `modules/conversion`, NOT ITS BARREL — a deliberate exception to "reach
// another module through its barrel", and the same one `repositories/revenue.repository` documents at
// length after the barrel form broke fifteen tests.
//
// `import conversion = require('../../conversion')` closes this loop:
//     revenue/index → services/revenueOverview.service → conversion/index
//       → services/logoChurn.service → revenue/index  (still initialising)
// so `logoChurn.service` destructures `liveSetAsOf`, `liveWindowDaysFor` and `diffMonths` as
// `undefined` at load, every call throws, and an UNRELATED endpoint starts answering "could not read
// logo churn". Node reports it only as `Warning: Accessing non-existent property … inside circular
// dependency`, which is trivial to scroll past.
//
// THE REUSE THE BARREL EXISTS TO ENFORCE IS FULLY PRESERVED. This file still reaches the canonical
// charge-cohort fold, the canonical churn-date derivation and the canonical lifecycle vocabulary
// rather than growing second copies of any of them — only the EAGER MODULE LOAD is avoided. All four
// targets are pure and none has an edge back to `modules/revenue`: the two constants files import
// `src/constants/partnerVocab.constants` or nothing at all, `churnDate.helper` imports one constants
// file, and `chargeCohort.resolver` reaches only `shared/helpers/shopDomain`, its own constants and
// its own state helper.
//
// The better long-term fix is to promote the event-type lists into `src/constants/`, the documented
// home for a cross-module vocabulary; that touches `modules/conversion` and belongs to whoever owns it.
import chargeCohortResolver = require('../../conversion/resolvers/chargeCohort.resolver');
import churnDateHelper = require('../../conversion/helpers/churnDate.helper');
import lifecycleConstants = require('../../conversion/constants/lifecycle.constants');
import logoChurnConstants = require('../../conversion/constants/logoChurn.constants');
import revenueOverviewConstants = require('../constants/revenueOverview.constants');
import ledgerMrrHelper = require('../helpers/ledgerMrr.helper');
import asOfMrrHelper = require('../helpers/asOfMrr.helper');
import movementSinceHelper = require('../helpers/movementSince.helper');
import revenueRepository = require('../repositories/revenue.repository');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { CohortSubscription } from '../../conversion/types/lifecycle.types';
import type { LiveSet, PayingShop, SubscriptionChargeRow } from '../types/ledgerMrr.types';
import type { AsOfMrr, PlanRevenueRow, TrendMonth } from '../types/asOfMrr.types';
import type { MovementMember, MrrMovementFold } from '../types/movementSince.types';
import type { LifetimeCashTotals, PartnerAppRecord } from '../types/revenueNow.types';
import type {
    GetRevenueOverviewParams,
    MonthlyCashRow,
    RevenueAsOfBlock,
    RevenueMovementShopRow,
    RevenueMovementShops,
    RevenueMovementTotals,
    RevenueOverviewCoverage,
    RevenueOverviewData,
    RevenueOverviewDiagnostics,
    RevenueOverviewTopShopRow,
    RevenueSummary,
    RevenueTrendMonth,
    RevenueWindow
} from '../types/revenueOverview.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { resolveDateRange } = dateRangeHelper;
// THE canonical folds and vocabularies, reached rather than re-derived. `chargeCohort` is the one
// definition of "what is this subscription"; `resolveChurnDate` is the one definition of "when did
// this shop stop paying", shared with the two churn pages that list the same merchants leaving.
const { resolveChargeCohortForDomains } = chargeCohortResolver;
const { resolveChurnDate } = churnDateHelper;
const { STORE_LIFECYCLE_STATES } = lifecycleConstants;
const { CHURN_DATE_BASES } = logoChurnConstants;
const { liveWindowDaysFor } = ledgerMrrHelper;
const { mrrAsOf, isSupportedBoundary, buildTrendMonths, planByDomainAsOf, rollupByPlan, byDomain } = asOfMrrHelper;
const { foldMrrMovement, movementSinceState } = movementSinceHelper;
const {
    UNKNOWN_PLAN_LABEL,
    MIN_TREND_MONTHS,
    MAX_TREND_MONTHS,
    TOP_SHOPS_LIMIT
} = revenueOverviewConstants;
const {
    findPartnerAppById,
    fetchSubscriptionChargeHistory,
    getLifetimeCashTotals,
    getTopShopsByLifetimeNet,
    aggregateMonthlyCash,
    aggregateWindowCash,
    findRevenueChargeEvents,
    aggregateSettledSubscriptionEvidence
} = revenueRepository;

/** Milliseconds in a day. One literal, so the window conversion is not spelled a second way. */
const _DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The page's own default preset is "1 year", so an omitted range resolves to the same window the
 * picker would have sent. The shared resolver's 30-day default is right for a funnel and wrong for a
 * revenue trend, where twelve bars is the shape a reader expects.
 */
const _DEFAULT_PERIOD_DAYS = 365;

/**
 * ⚠️ `READY` | `NEVER_SYNCED`, decided by the WATERMARK and never by a row count.
 *
 * A third spelling of two strings that `modules/conversion` and `modules/store` each already declare
 * for themselves, and deliberately so: neither publishes its own on its barrel, and a module reaching
 * into another's constants folder is the deep import no module in this codebase makes. The values are
 * a wire contract with the frontend's `dataState.js`, so they are pinned here rather than derived.
 */
const REVENUE_DATA_STATES = Object.freeze({
    READY: 'READY',
    NEVER_SYNCED: 'NEVER_SYNCED'
} as const);

/** States the ranking's basis on the payload, because it does NOT share the selected window. */
const TOP_SHOPS_BASIS = 'lifetime net cash, all time — NOT windowed';

/**
 * ⚠️ THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * The page renders one entry per warning KEYED BY THE STRING ITSELF, so a duplicate is not drawn
 * twice — it is DROPPED, silently, along with its condition.
 */
const _WARNINGS = Object.freeze({
    neverSynced: 'No Partner sync has completed for this app yet, so no settled payouts have been fetched '
        + 'and there is no revenue to measure. Every figure is withheld rather than shown as zero — we have '
        + 'not looked, which is not the same as having earned nothing.',

    noSubscriptionPayouts: 'No settled subscription payouts have ever been synced for this app, so there is '
        + 'no recurring revenue to measure. MRR, active subscribers and ARPU are withheld rather than shown '
        + 'as zero. Cash figures below are unaffected: one-time and usage charges are real revenue, they are '
        + 'simply not a run-rate.',

    beforeCoverage: (floor: string): string => `The selected period ends before the first settled payout on `
        + `record (${floor}), so there is nothing to measure at its close. The run-rate figures are unknown, `
        + 'not zero — a zero there would report that nobody was paying you, which is a claim about your '
        + 'business rather than about this deployment\'s records.',

    asOfUnsupported: (floor: string, windowDays: number): string => 'The run-rate figures for this period '
        + `cannot be measured. Deciding who was paying on a given date needs the ${windowDays} days of payout `
        + `history before it, and the stored history begins at ${floor} — so this period's close falls inside `
        + 'the run-up to it and any answer would under-count the paying base.',

    movementUnsupported: (floor: string, windowDays: number): string => 'MRR movement is not published for '
        + `this period: measuring it needs the paying base at the period's START, and deciding that needs the `
        + `${windowDays} days of payout history before it, which begins at ${floor}. A movement card built on `
        + 'a truncated opening base reports new business that is really just history we cannot see.',

    windowNotBegun: (openLabel: string): string => `The selected period starts on ${openLabel}, which has `
        + 'not arrived yet, so its opening balance has been clamped to today. Nothing can have moved in a '
        + 'period that has not begun — an unclamped opening boundary reports every paying store as new '
        + 'business against a start of zero, which is the most flattering possible way to be wrong.',

    movementLifetime: 'MRR movement is not published for an "All time" window: there is no opening balance '
        + 'before the first record, so every paying store would be counted as new business and the churn rate '
        + 'would have no denominator. Pick a bounded period to see how MRR moved.',

    unmeasuredMonths: (count: number, floor: string, windowDays: number): string => `${count} of the months `
        + `on the chart cannot have their MRR measured. Deciding who was paying on a date needs the `
        + `${windowDays} days of payout history before it, and the stored history begins at ${floor}. Their `
        + 'points are published as unknown rather than zero and the line breaks over them.',

    coverageFloorUnknown: 'No payout coverage floor has ever been measured for this app, so nothing here can '
        + 'say how far back the stored payout history actually reaches. The earliest months below may '
        + 'under-report, and there is no way to tell which from the stored data.',

    lifetimeFloor: 'No lifetime Partner sync has ever completed for this app, so the stored payouts are '
        + 'whatever the incremental sync windows happened to pull. Every all-time figure here is a FLOOR '
        + 'rather than a total, and the earliest months most of all.',

    unknownIntervalShops: (count: number, total: number): string => `${count} of ${total} paying stores carry `
        + 'no billing_interval on their settled charge. Any ANNUAL subscriber among them is booked at TWELVE '
        + 'TIMES its true monthly run-rate, so MRR, ARPU and the per-plan table all read HIGH. A lifetime '
        + 'Partner re-sync backfills the field.',

    mixedCurrencies: (codes: string[]): string => `Paying stores span ${codes.length} currencies `
        + `(${codes.join(', ')}) and nothing in this build converts between them, so every money figure here `
        + 'is a sum of unlike units. There is no exchange rate anywhere in this codebase on purpose: a wrong '
        + 'rate produces a plausible wrong number.',

    unknownPlanShops: (count: number): string => `${count} paying store(s) have no subscription charge event `
        + 'naming their plan, so they are grouped under "' + UNKNOWN_PLAN_LABEL + '" rather than filed under a '
        + 'guess. That happens when the charge events for a store were never synced, or when its payouts carry '
        + 'no domain to join on — never because the merchant had no plan.',

    shopsWithoutDomain: (count: number): string => `${count} paying store(s) have no shop domain on their `
        + 'payout rows. They are counted in every total but cannot be joined to a plan, and cannot be opened '
        + 'in the store panel — there is no store identity to look one up with.',

    ledgerDatedChurns: (count: number): string => `${count} store(s) in the churn list have no cancellation `
        + 'event on record, so their "Stopped on" date is the moment their last settled payout aged out of the '
        + 'active window rather than the day they cancelled. That instant is always LATER than the real one — '
        + 'check `churn_basis` on the row before quoting a date.',

    trendTruncated: (shown: number, wanted: number): string => `The chart shows the most recent ${shown} `
        + `months; the selected period spans ${wanted}. Earlier history exists and is included in the `
        + 'all-time cash figures, it is simply not plotted.',

    installStateNotPublished: 'Whether these stores still have the app installed is not published by this '
        + 'endpoint. Install state is decided by the relationship-event fold that the Stores page owns, and a '
        + 'second answer derived here would drift from it without either page looking wrong. The movement '
        + 'panel hides that column rather than guessing; open a store on the Stores page to see it.'
});

/** The reason attached to a single month whose boundaries the payout history cannot support. */
const _MONTH_UNKNOWN_REASON = (floor: string, windowDays: number): string => 'Deciding who was paying at '
    + `this month's end needs the ${windowDays} days of payout history before it, and the stored history `
    + `begins at ${floor}. The MRR point is unknown rather than zero.`;

/** An ISO string, or null. Used on every date that reaches the wire. */
const _iso = (value?: Date | null): string | null => {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        return null;
    }
    return value.toISOString();
};

/** A `Date` only when it genuinely is one and genuinely valid. Used on every comparison boundary. */
const _validDate = (value: unknown): Date | null => {
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
};

/** A number only when it genuinely is finite. `null` — not `0` — for anything else. */
const _numOrNull = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    return null;
};

/** The measurement instant as a date, for the "as of …" sublines. UTC, matching every boundary. */
const _prettyDate = (at: Date): string => {
    return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

/**
 * Whole calendar months spanned by two instants, inclusive of both ends.
 *
 * UTC, and by CALENDAR month rather than by elapsed days: the chart's buckets are calendar months, so
 * a 45-day window that straddles three of them needs three bars, not two.
 */
const _monthsSpanned = (from: Date, to: Date): number => {
    const years = to.getUTCFullYear() - from.getUTCFullYear();
    const months = to.getUTCMonth() - from.getUTCMonth();
    return years * 12 + months + 1;
};

/**
 * The plan a store held at one instant, or `''`.
 *
 * `''` rather than a label, so the ONE place a nameless plan gets a word is the caller's
 * `UNKNOWN_PLAN_LABEL` — two spellings of "we do not know" is two rows in a table that partitions the
 * paying base.
 */
const _planFor = (planByDomain: Map<string, string>, shopDomain: string): string => {
    if (!shopDomain) {
        return '';
    }
    return planByDomain.get(shopDomain) || '';
};

/**
 * The windowed revenue view: run-rate at the window's close, how it got there, and the cash beside it.
 *
 * Resolves `status: false` only when the CALL failed: no operator, no app id, an app that does not
 * exist, or a read that threw. A successful call over an empty database resolves `status: true` with
 * every figure `null` and a stated reason — "we have no data" is an answer, not an error.
 *
 *  IT ALSO RESOLVES `status: false` WHEN THE MOVEMENT FOLD DOES NOT RECONCILE. `foldMrrMovement`
 * throws rather than returning six figures that do not add up to the two balances printed above them,
 * and that throw lands here. A wrong movement card is worse than an absent one, because a reader who
 * checks the arithmetic cannot tell which of the six numbers to distrust.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator. Background callers pass a stable sentinel.
 * @param params1 - The query, already cast (not coerced) by the controller.
 * @param params1.partner_app_id - The app to report on. Required.
 * @param [params1.period_days] - `'all'`/`0` for lifetime, else days back from now.
 * @param [params1.since] - ISO `YYYY-MM-DD`, honoured only with `until`.
 * @param [params1.until] - ISO `YYYY-MM-DD`, honoured only with `since`.
 * @returns The view, or an honest refusal.
 */
const getRevenueOverview = (
    { user_id }: IdentityObject,
    { partner_app_id, period_days, since, until }: GetRevenueOverviewParams
): Promise<ServiceResult<RevenueOverviewData | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'partner_app_id is required. Read it from GET /api/partner-apps.'));
            }

            const app: PartnerAppRecord | null = await findPartnerAppById({ partner_app_id });
            if (!app) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }

            // The service reads the clock ONCE, here, and passes the instant into every pure thing
            // below. A second `new Date()` further down would let two halves of one response describe
            // two different instants.
            const now = new Date();
            const appId = String(app._id);
            const windowDays = config.REVENUE.ACTIVE_SUB_WINDOW_DAYS;
            const windowMs = windowDays * _DAY_MS;
            const warnings: string[] = [];

            // ── The window, and the ONE instant the run-rate is measured at ──
            const range = resolveDateRange({ period_days, since, until, defaultPeriodDays: _DEFAULT_PERIOD_DAYS });
            //  `min(until, now)`. A window whose upper bound has not arrived yet must not evaluate
            // membership in the future — that reports a state nobody has reached. A preset window's
            // `until` is the END of today, so this is `now`; a closed custom window's is its own end.
            const isHistorical = range.until.getTime() < now.getTime();
            const asOf = isHistorical ? range.until : now;
            //  THE SAME CLAMP ON THE OTHER BOUND, and it was missing. `as_of` refused to evaluate
            // membership in the future while `openAt` was passed through raw — so a window of
            // `since=2030-01-01&until=2030-12-31` kept its 2030 opening boundary, `_measurableAt`
            // passed it (the floor test only checks the LOWER bound), and `mrrAsOf` at 2030 returned an
            // empty set because every stored charge had aged out. The movement card then reported the
            // operator's ENTIRE current MRR as `new_mrr` against `start_mrr: 0`, over a period that has
            // not begun. Clamped to `as_of` the two boundaries coincide, every bucket is empty, and the
            // card says what is true: nothing has moved yet.
            let openAt: Date | null = range.since;
            if (openAt && openAt.getTime() > asOf.getTime()) {
                warnings.push(_WARNINGS.windowNotBegun(_prettyDate(openAt)));
                openAt = asOf;
            }

            const floor = _validDate(app.earliest_transaction_at);
            const floorIso = _iso(floor);

            // ── The trend range ─────────────────────────────────────────────
            // Derived from the WINDOW, never from a `months` parameter — see the file header. A
            // lifetime window walks back to the first payout we hold; an unmeasured floor walks the
            // maximum, because there is nothing to bound it with.
            let wantedMonths = MAX_TREND_MONTHS;
            if (openAt) {
                wantedMonths = _monthsSpanned(openAt, asOf);
            } else if (floor) {
                wantedMonths = _monthsSpanned(floor, asOf);
            }
            const appliedMonths = Math.min(MAX_TREND_MONTHS, Math.max(MIN_TREND_MONTHS, wantedMonths));
            const trendMonths: TrendMonth[] = buildTrendMonths({ as_of: asOf, months: appliedMonths });
            const trendTruncated = wantedMonths > appliedMonths;
            if (trendTruncated) {
                warnings.push(_WARNINGS.trendTruncated(appliedMonths, wantedMonths));
            }
            const trendStart = trendMonths.length > 0 ? trendMonths[0].start : asOf;

            const windowMeta: RevenueWindow = {
                period_label: range.periodLabel,
                kind: range.kind,
                since: _iso(range.since),
                until: range.until.toISOString(),
                as_of: asOf.toISOString(),
                as_of_label: _prettyDate(asOf),
                is_historical: isHistorical,
                trend_months: trendMonths.length,
                trend_truncated: trendTruncated,
                active_sub_window_days: windowDays
            };

            const coverage: RevenueOverviewCoverage = {
                last_synced_at: _iso(app.last_synced_at),
                earliest_event_at: _iso(app.earliest_event_at),
                earliest_transaction_at: floorIso,
                lifetime_sync_completed_at: _iso(app.lifetime_sync_completed_at),
                shop_name_coverage_since: _iso(app.shop_name_coverage_since),
                event_history_gap_days: _numOrNull(app.event_history_gap_days),
                charge_link_absent_pct: _numOrNull(app.charge_link_absent_pct),
                charge_link_unresolved_pct: _numOrNull(app.charge_link_unresolved_pct)
            };

            /** Methodology. Facts about HOW every figure was measured — never about what went wrong. */
            const notes: string[] = [
                `A store counts as paying when Shopify settled a subscription charge for it within the `
                + `${windowDays} days before the instant being measured (one 30-day cycle plus payout grace); `
                + 'an ANNUAL charge gets a year-wide window instead and is divided by 12. Membership is '
                + 'evaluated AT AN INSTANT, never "was billed in this calendar month" — a 30-day biller skips '
                + 'one calendar month a year, and month-of-charge membership would report every one of them '
                + 'as churned.',
                'The MRR line is a RUN-RATE from subscription charges; the bars are CASH Shopify actually '
                + 'settled, across every transaction type including refunds and adjustments. They are '
                + 'different populations and are not expected to track — cash is lumpy where a run-rate is '
                + 'smooth — so they are never summed together.',
                'Every past figure is measured from the settled payout ledger AT THAT DATE, not from today\'s '
                + 'subscriber list valued at old prices. A merchant who has since uninstalled still counts in '
                + 'the months they were paying, which is the only way the churn on this chart is real.',
                'This build has ONE MRR engine — the settled payout ledger — so "Today, published figure" and '
                + '"Today, charge records" on the reconciliation card are the SAME measurement, agreeing by '
                + 'construction rather than by coincidence. The card carries both rows for a deployment that '
                + 'also runs a subscription-state engine.',
                'Every count on the MRR movement card is the length of the list behind it, so a card that '
                + 'says 23 stores opens 23 stores.',
                _WARNINGS.installStateNotPublished
            ];

            const _emptyDiagnostics = (): RevenueOverviewDiagnostics => ({
                subscription_charge_rows: 0,
                shops_with_subscription_payouts: 0,
                cohort_subscriptions: 0,
                cohort_domains: 0,
                unknown_plan_shops: 0,
                shops_without_domain: 0,
                billing_interval_unknown_shops: 0,
                currencies: [],
                unmeasured_months: 0,
                churned_shops_dated_from_ledger: 0,
                earliest_transaction_at: floorIso
            });

            // ── THE WATERMARK, NEVER THE ROW COUNT ───────────────────────────
            // This is the ONE condition that produces NEVER_SYNCED. Nothing below may reach for it: an
            // empty ledger on a synced app is a perfectly ordinary answer, and a row count cannot tell
            // "nobody has ever paid" from "we have not looked".
            if (!app.last_synced_at) {
                //  `summary: null` here and NOWHERE ELSE. The page's own gate is
                // `windowAware = !!(w && summary.as_of)`, and a zeroed summary would render "MRR 0.00"
                // in 32-point type over an app nothing has ever synced.
                const coldPayload: RevenueOverviewData = {
                    partner_app_id: appId,
                    app_handle: app.app_handle,
                    display_name: app.display_name,
                    reporting_currency: config.REVENUE.REPORTING_CURRENCY,
                    window: windowMeta,
                    summary: null,
                    monthly_trend: [],
                    plans: [],
                    top_shops: [],
                    top_shops_basis: TOP_SHOPS_BASIS,
                    movement_shops: null,
                    movement_shops_since: null,
                    coverage,
                    notes,
                    warnings: [...new Set([_WARNINGS.neverSynced, ...warnings])],
                    diagnostics: _emptyDiagnostics(),
                    data_state: REVENUE_DATA_STATES.NEVER_SYNCED,
                    unknown_reason: _WARNINGS.neverSynced
                };
                return resolve(promiseReturnResult(true, coldPayload, {}, 'Revenue overview resolved.'));
            }

            // ── The reads, issued together ──────────────────────────────────
            //
            // ⚠️ THE COHORT IS RESOLVED AT `now`, NOT AT THE WINDOW'S CLOSE, and both of its reads are
            // bounded at the same `now` — which is the invariant `subscriptionCohort.resolver`'s header
            // states. The panel's "Plan today" column and the ranking's badges are questions about
            // TODAY, and a cohort bounded at a closed window's end cannot answer them. Every HISTORICAL
            // plan question is then answered by filtering that cohort's own dates through
            // `planByDomainAsOf`, never by re-resolving it at a second instant.
            const [
                history,
                lifetime,
                topShopRows,
                monthlyCash,
                windowCash,
                chargeEvents,
                settled
            ] = await Promise.all([
                fetchSubscriptionChargeHistory({ partner_app_id: appId }),
                getLifetimeCashTotals({ partner_app_id: appId }),
                getTopShopsByLifetimeNet({ partner_app_id: appId, limit: TOP_SHOPS_LIMIT }),
                aggregateMonthlyCash({ partner_app_id: appId, since: trendStart, until: asOf }),
                //  SKIPPED on a lifetime window rather than issued and ignored. There, the window IS
                // all time, so `window_cash` would duplicate `lifetime_net` under a second label —
                // and the page is built to fall back to the lifetime card when it is null.
                range.isLifetime
                    ? Promise.resolve(null)
                    : aggregateWindowCash({ partner_app_id: appId, since: range.since, until: range.until }),
                findRevenueChargeEvents({ partner_app_id: appId, as_of: now }),
                aggregateSettledSubscriptionEvidence({ partner_app_id: appId, as_of: now })
            ]);

            const cohort = resolveChargeCohortForDomains({
                events: chargeEvents,
                as_of: now,
                settled_charge_ids: settled.charge_ids,
                settled_domains: settled.shop_domains
            });

            // ── ONE pass over the ledger for the per-shop facts ─────────────
            // ⚠️ NOT SORTED. `fetchSubscriptionChargeHistory` returns NEWEST FIRST and `liveSetAsOf`
            // depends on that order to accept the first row it sees per shop. Re-ordering this array —
            // even into a copy that is then passed on — silently changes every membership answer below.
            const firstChargeAt = new Map<string, Date>();
            const chargeShopIds = new Set<string>();
            const chargeDomains = new Set<string>();
            for (const row of history as SubscriptionChargeRow[]) {
                chargeShopIds.add(row.shop_id);
                if (row.shop_domain) {
                    chargeDomains.add(row.shop_domain);
                }
                const at = _validDate(row.created_at);
                if (!at) {
                    continue;
                }
                const incumbent = firstChargeAt.get(row.shop_id);
                if (!incumbent || at.getTime() < incumbent.getTime()) {
                    firstChargeAt.set(row.shop_id, at);
                }
            }

            /**
             * How many distinct stores this app's revenue records resolve to.
             *
             * ⚠️ A FLOOR, and only its ZERO-NESS is load-bearing: the page draws a critical banner when
             * it is `0` ("no stores resolved, so every figure below is unreliable"), which is the right
             * reading — with no store identities nothing below can be joined to a merchant. The
             * ranking's contribution is capped at `TOP_SHOPS_LIMIT`, so this must never be quoted as a
             * customer count; `diagnostics.shops_with_subscription_payouts` is the exact figure.
             */
            const resolvedStores = new Set<string>([
                ...chargeDomains,
                ...cohort.by_domain.keys(),
                ...topShopRows.map((row) => row.shop_domain).filter((domain) => domain !== '')
            ]);

            // ── The as-of predicate, evaluated at every boundary ────────────
            //
            // ⚠️ THE AS-OF-NOW BOUNDARY IS DELIBERATELY NOT FLOOR-GATED. `GET /api/revenue/now`
            // publishes `mrr` from this exact predicate at this exact instant with no floor test, so
            // gating it here would put a blank card on one page beside a number on another for the
            // same measurement. Every HISTORICAL boundary IS gated, because a truncated lookback
            // under-counts and the resulting "nobody was paying" is indistinguishable from a real one.
            const nowFigures: AsOfMrr = mrrAsOf({ history, as_of: now, window_days: windowDays });
            const _measurableAt = (at: Date): boolean => {
                if (at.getTime() === now.getTime()) {
                    return true;
                }
                return isSupportedBoundary(at, floor, windowMs);
            };

            const beforeCoverage = !!floor && asOf.getTime() < floor.getTime();
            const asOfMeasurable = _measurableAt(asOf);
            let asOfFigures: AsOfMrr | null = null;
            let asOfUnknownReason: string | null = null;
            if (asOfMeasurable) {
                asOfFigures = mrrAsOf({ history, as_of: asOf, window_days: windowDays });
            } else if (beforeCoverage && floorIso) {
                asOfUnknownReason = _WARNINGS.beforeCoverage(floorIso);
                warnings.push(asOfUnknownReason);
            } else if (floorIso) {
                asOfUnknownReason = _WARNINGS.asOfUnsupported(floorIso, windowDays);
                warnings.push(asOfUnknownReason);
            }

            // A synced app whose subscription ledger is empty cannot answer a question about recurring
            // revenue at all.  IT STAYS `READY`: the watermark is set and only the rows are missing,
            // and a row count is not a sync state. The CASH block below is unaffected — one-time and
            // usage charges are real revenue, they are simply not a run-rate.
            const hasSubscriptionLedger = history.length > 0;
            if (!hasSubscriptionLedger) {
                warnings.push(_WARNINGS.noSubscriptionPayouts);
                if (!asOfUnknownReason) {
                    asOfUnknownReason = _WARNINGS.noSubscriptionPayouts;
                }
            }

            /**
             * A run-rate figure, WITHHELD when no subscription charge has ever settled for this app.
             *
             *  THE ONE PLACE A MEASURED ZERO AND AN UNANSWERABLE QUESTION ARE TOLD APART, and getting
             * it wrong is silent in the worst direction. With an empty subscription ledger `mrrAsOf`
             * quite correctly returns `mrr: 0` and `active_subs: 0` — it summed an empty set — and
             * publishing that renders "0.00" in 32-point type under the word MRR. That is a claim about
             * the BUSINESS ("nobody is paying you") made out of a fact about our RECORDS ("we have never
             * synced a subscription charge"), and the two are indistinguishable on screen.
             *
             * ⚠️ THE OTHER DIRECTION MATTERS JUST AS MUCH. Once subscription charges DO exist and none
             * of them is live right now, `0` is a real, measured answer about the business and must
             * survive — so this gates on whether the ledger can answer at all, never on whether the
             * answer happens to be zero. `GET /api/revenue/now` draws exactly the same line.
             *
             * `history.length` is a row count and is used deliberately: it decides what the RUN-RATE
             * BLOCK can answer, never `data_state`, which stays keyed to the sync watermark.
             *
             * @param value - The computed figure.
             * @returns The figure, or null when there is no recurring revenue to measure.
             */
            const _runRate = (value: number | null): number | null => {
                if (!hasSubscriptionLedger) {
                    return null;
                }
                return value;
            };

            // ── The plan vintages ───────────────────────────────────────────
            //  THREE SEPARATE FOLDS OF ONE COHORT, never one map reused at three instants. The
            // cohort's own `by_domain` is the winner by LATEST trial start — the plan a merchant is on
            // TODAY — and applying it to a past instant restates the whole historical plan mix in
            // current-plan terms, moving customers between the very rows a reader is comparing.
            const planAtClose = planByDomainAsOf({ subscriptions: cohort.subscriptions, as_of: asOf });
            const planNow = planByDomainAsOf({ subscriptions: cohort.subscriptions, as_of: now });
            let planAtOpen = new Map<string, string>();
            if (openAt) {
                planAtOpen = planByDomainAsOf({ subscriptions: cohort.subscriptions, as_of: openAt });
            }

            // ── Movement ────────────────────────────────────────────────────
            //
            // `null` for THREE different reasons, each said out loud: a lifetime window has no opening
            // balance, an opening boundary inside the run-up to the coverage floor cannot be measured
            // without under-counting, and a close that cannot be measured has nothing to move TO.
            let movementFold: MrrMovementFold | null = null;
            if (!openAt) {
                warnings.push(_WARNINGS.movementLifetime);
            } else if (!asOfMeasurable) {
                // Deliberately silent: the reason is already in `warnings[]` from the as-of branch
                // above, and a second string saying the same thing would be DROPPED as a duplicate —
                // taking whichever of the two conditions fired second with it.
                movementFold = null;
            } else if (!_measurableAt(openAt)) {
                if (floorIso) {
                    warnings.push(_WARNINGS.movementUnsupported(floorIso, windowDays));
                }
            } else if (!hasSubscriptionLedger) {
                //  WITHHELD, not published as six zeros. With an empty subscription ledger both live
                // sets are empty and the fold reconciles perfectly at `Start 0.00 … End 0.00` — a
                // complete, balanced, entirely false account of a period in which nothing was measured.
                // The page renders no movement card at all when this is null, which is the honest
                // shape; `warnings[]` carries the reason.
                movementFold = null;
            } else if (asOfFigures) {
                const openFigures = mrrAsOf({ history, as_of: openAt, window_days: windowDays });
                //  THROWS when the identity fails, and the throw is deliberate — see the helper.
                movementFold = foldMrrMovement({
                    open_set: openFigures.live_set,
                    close_set: asOfFigures.live_set
                });
            }

            // ── The movement drill-down lists ───────────────────────────────
            const nowSet: LiveSet = nowFigures.live_set;
            let churnedFromLedger = 0;

            /**
             * One movement row, with BOTH vintages on it.
             *
             * `plan_name` is the plan at the row's OWN vintage — the period close for three buckets, the
             * period OPEN for churned, because a churned store is absent from the close and that is the
             * only place its plan still exists. `*_now` is today, and the panel names both instants in
             * its footer so the two are never read as one.
             *
             * ⚠️ The "now" lookup is by the LIVE SET'S OWN KEY, not by domain. Both sets come from one
             * `liveSetAsOf` over one history array, so the keys are identical by construction; joining
             * on the domain instead would silently drop every store whose payouts carry none.
             */
            const _movementRow = (member: MovementMember, isChurned: boolean): RevenueMovementShopRow => {
                const planVintage = isChurned ? planAtOpen : planAtClose;
                const nowShop: PayingShop | undefined = nowSet.get(member.shop_key);
                const isPayingNow = Boolean(nowShop);
                const planNowName = _planFor(planNow, member.shop_domain);
                //  `member.open` IS the "was it paying at the open" fact, and it is the only one
                // that may decide this. `previous_mrr > 0` looks equivalent and is not: a
                // fully-discounted plan opens the window at `0` while genuinely being a plan, and
                // testing the amount would blank its name on every expansion row it appears in.
                const planAtOpenName = _planFor(planAtOpen, member.shop_domain);

                let churnDate: string | null = null;
                let churnBasis: string | null = null;
                if (isChurned && member.open) {
                    const activatedAt = firstChargeAt.get(member.shop_key) || member.open.last_charged_at;
                    const subscription: CohortSubscription | undefined = member.shop_domain
                        ? cohort.by_domain.get(member.shop_domain)
                        : undefined;
                    // THE ONE DERIVATION, reached through the conversion barrel. Logo churn counts these
                    // merchants leaving and revenue churn prices them; a second copy here would put two
                    // different churn dates on one merchant on two pages an operator reads side by side.
                    const resolved = resolveChurnDate({
                        activated_at: activatedAt,
                        last_charged_at: member.open.last_charged_at,
                        // Cadence-aware, so the derived date matches the predicate that decided the
                        // store had left rather than a flat 38 days for an annual biller.
                        live_window_days: liveWindowDaysFor(member.open.billing_interval, windowDays),
                        event_churn_date: subscription ? subscription.churn_date : null,
                        as_of: asOf
                    });
                    churnDate = resolved.churned_at.toISOString();
                    churnBasis = resolved.basis;
                    if (resolved.basis !== CHURN_DATE_BASES.PARTNER_EVENT) {
                        churnedFromLedger += 1;
                    }
                }

                return {
                    shop_id: member.shop_key,
                    shop_domain: member.shop_domain,
                    plan_name: _planFor(planVintage, member.shop_domain),
                    //  `null`, NOT `''`. The panel's plan columns print the value straight, and an
                    // empty string renders as a plan whose name is nothing rather than as an
                    // unknown. `new` rows are null because the store held no plan at the open at
                    // all — a different absence from "the charge events name none", and the bucket
                    // is what tells the two apart.
                    plan_name_at_open: Boolean(member.open) && planAtOpenName !== '' ? planAtOpenName : null,
                    previous_mrr: member.previous_mrr,
                    mrr: member.mrr,
                    delta: member.delta,
                    churn_date: churnDate,
                    churn_basis: churnBasis,
                    since_state: movementSinceState({
                        was_paying_at_close: Boolean(member.close),
                        amount_at_close: member.mrr,
                        plan_at_close: _planFor(planAtClose, member.shop_domain),
                        is_paying_now: isPayingNow,
                        amount_now: nowShop ? nowShop.monthly_amount : 0,
                        plan_now: planNowName
                    }),
                    is_paying_now: isPayingNow,
                    //  `null`, not `0`, for a store that is not paying. `0` is a real amount — a
                    // fully-discounted plan — and the panel prints it as "0.00" beside a "Paying" badge.
                    mrr_now: nowShop ? nowShop.monthly_amount : null,
                    plan_name_now: isPayingNow && planNowName !== '' ? planNowName : null
                };
            };

            let movementShops: RevenueMovementShops | null = null;
            let movementTotals: RevenueMovementTotals | null = null;
            if (movementFold) {
                movementShops = {
                    new: movementFold.buckets.new.map((member) => _movementRow(member, false)),
                    expansion: movementFold.buckets.expansion.map((member) => _movementRow(member, false)),
                    contraction: movementFold.buckets.contraction.map((member) => _movementRow(member, false)),
                    churned: movementFold.buckets.churned.map((member) => _movementRow(member, true))
                };
                movementTotals = {
                    start_mrr: movementFold.totals.start_mrr,
                    end_mrr: movementFold.totals.end_mrr,
                    new_mrr: movementFold.totals.new_mrr,
                    expansion_mrr: movementFold.totals.expansion_mrr,
                    contraction_mrr: movementFold.totals.contraction_mrr,
                    churned_mrr: movementFold.totals.churned_mrr,
                    //  STRAIGHT OFF THE FOLD, which read them off the very lists published above.
                    // Re-deriving them here — even as `movementShops.new.length`, which is the same
                    // number today — would create a second place for the card and its drill-down to
                    // disagree the day one of them is filtered.
                    new_count: movementFold.totals.new_count,
                    expanded_count: movementFold.totals.expanded_count,
                    contracted_count: movementFold.totals.contracted_count,
                    churned_count: movementFold.totals.churned_count,
                    gross_churn_rate: movementFold.totals.gross_churn_rate,
                    net_churn_rate: movementFold.totals.net_churn_rate,
                    //  DERIVED IN THE FOLD, not re-inverted here. `1 - rate` is one line, which is
                    // exactly why a second copy would be written the day someone needs it and would
                    // then quietly disagree the day either churn rate's definition moves again — as
                    // `gross_churn_rate`'s just did.
                    gross_revenue_retention_rate: movementFold.totals.gross_revenue_retention_rate,
                    net_revenue_retention_rate: movementFold.totals.net_revenue_retention_rate,
                    reconciles: true,
                    reconciliation_drift: movementFold.reconciliation.drift
                };
                if (churnedFromLedger > 0) {
                    warnings.push(_WARNINGS.ledgerDatedChurns(churnedFromLedger));
                }
            }

            // ── The per-plan partition of the as-of paying set ──────────────
            let plans: PlanRevenueRow[] = [];
            let unknownPlanShops = 0;
            if (asOfFigures) {
                const rollup = rollupByPlan({
                    live_set: asOfFigures.live_set,
                    plan_by_domain: planAtClose,
                    unknown_label: UNKNOWN_PLAN_LABEL
                });
                plans = rollup.rows;
                unknownPlanShops = rollup.unknown_plan_shops;
                if (unknownPlanShops > 0) {
                    warnings.push(_WARNINGS.unknownPlanShops(unknownPlanShops));
                }
            }

            // ── The trend ───────────────────────────────────────────────────
            const cashByMonth = new Map<string, MonthlyCashRow>();
            for (const row of monthlyCash) {
                cashByMonth.set(row.month, row);
            }

            let unmeasuredMonths = 0;
            const monthlyTrend: RevenueTrendMonth[] = trendMonths.map((month) => {
                //  THE LEDGER GATE COMES FIRST, AND IT IS THE SAME GATE `_runRate` APPLIES.
                //
                // `mrrAsOf` over an empty history quite correctly answers `mrr: 0, active_subs: 0` — it
                // summed an empty set — and publishing that as `measurable: true` draws a flat $0.00 MRR
                // line across the whole chart underneath an em-dash MRR card, because `_runRate`
                // withheld the headline and nothing withheld the series. That line is a claim about the
                // operator's BUSINESS ("nobody paid you in any of these months") built out of a fact
                // about our RECORDS ("no subscription charge has ever been synced") — the same "a flat
                // MRR line is the tell" failure this module documents, in the opposite direction — and
                // it contradicts `_WARNINGS.noSubscriptionPayouts`, which promises on this very payload
                // that the run-rate figures are withheld rather than shown as zero.
                //
                // ⚠️ THE GATE IS `hasSubscriptionLedger`, NEVER "the answer happens to be 0". Once
                // subscription charges DO exist, a month with nobody live is a real measured `0` and
                // must survive — exactly as `_runRate`'s own JSDoc argues. `conversion`'s two churn
                // services answer the identical condition by nulling their whole trend; this one keeps
                // the array (the CASH bars beside the line are real and unaffected: one-time and usage
                // charges are revenue, they are simply not a run-rate) and nulls the run-rate points.
                const measurable = hasSubscriptionLedger && _measurableAt(month.end);
                let mrr: number | null = null;
                let activeSubs: number | null = null;
                let unknownReason: string | null = null;
                if (measurable) {
                    const figures = mrrAsOf({ history, as_of: month.end, window_days: windowDays });
                    mrr = figures.mrr;
                    activeSubs = figures.active_subs;
                } else {
                    unmeasuredMonths += 1;
                    if (!hasSubscriptionLedger) {
                        // The ledger's own sentence, not the coverage floor's: the floor is not why this
                        // month is unanswerable, and naming it would send a reader after a re-sync that
                        // cannot help.
                        unknownReason = _WARNINGS.noSubscriptionPayouts;
                    } else if (floorIso) {
                        unknownReason = _MONTH_UNKNOWN_REASON(floorIso, windowDays);
                    } else {
                        unknownReason = _WARNINGS.coverageFloorUnknown;
                    }
                }

                //  AN ABSENT CASH ROW IS A MEASURED ZERO INSIDE COVERAGE AND AN UNKNOWN BEFORE IT.
                // A month with no payouts really did settle nothing, and `0` is the honest answer; a
                // month that ENDS before the first payout we hold is a month we never looked at, and a
                // `0` bar there draws a business that had not started. A null floor takes the measured
                // reading, matching `isSupportedBoundary`'s own rule — the unmeasured floor is warned
                // about once rather than blanking every bar on the chart.
                const cashRow = cashByMonth.get(month.month);
                const beforeCash = !!floor && month.month_end.getTime() < floor.getTime();
                let grossCash: number | null = null;
                let netCash: number | null = null;
                if (cashRow) {
                    grossCash = cashRow.gross;
                    netCash = cashRow.net;
                } else if (!beforeCash) {
                    grossCash = 0;
                    netCash = 0;
                }

                // Overlap, not containment: a month that straddles the window's edge is partly in it,
                // and shading it out would hide revenue the reader selected.
                let inWindow = month.start.getTime() <= range.until.getTime();
                if (inWindow && range.since) {
                    inWindow = month.month_end.getTime() >= range.since.getTime();
                }

                return {
                    month: month.month,
                    gross_cash: grossCash,
                    net_cash: netCash,
                    mrr,
                    active_subs: activeSubs,
                    in_window: inWindow,
                    is_partial_month: month.is_partial,
                    measurable,
                    unknown_reason: unknownReason
                };
            });
            // ⚠️ THE FLOOR'S WARNING ONLY WHEN THE FLOOR IS THE CAUSE. With an empty subscription
            // ledger every month is unmeasurable and `noSubscriptionPayouts` — already pushed above —
            // is the whole explanation; adding "the stored history begins at <floor>" on top of it
            // would blame the coverage window for an absence a re-sync of that window cannot fix.
            // `diagnostics.unmeasured_months` still counts every month published as unknown, because it
            // describes the payload rather than the cause.
            if (unmeasuredMonths > 0 && floorIso && hasSubscriptionLedger) {
                warnings.push(_WARNINGS.unmeasuredMonths(unmeasuredMonths, floorIso, windowDays));
            }

            // ── The lifetime ranking, with today's badges ───────────────────
            //
            // ⚠️ TWO BASES ON ONE ROW, and both are stated rather than blended: the money is LIFETIME
            // and unwindowed, the badges are judged at NOW. `top_shops_basis` says the first and the
            // page captions the second above the table.
            const nowByDomain = byDomain(nowSet);
            const topShops: RevenueOverviewTopShopRow[] = topShopRows.map((row) => {
                const subscription: CohortSubscription | undefined = row.shop_domain
                    ? cohort.by_domain.get(row.shop_domain)
                    : undefined;
                const isActiveNow = row.shop_domain ? nowByDomain.has(row.shop_domain) : false;
                // Our subscription records say this store is on a live paid plan and the payout ledger
                // has not billed it inside the active window. Either a cancellation never synced or the
                // subscription is genuinely still running, and the two need opposite actions — so it is
                // surfaced rather than reconciled silently.
                //
                // Compared through the LIFECYCLE vocabulary, which the conversion barrel publishes,
                // rather than by spelling `'PAYING'` here: `PAYING` maps to `CONVERTED` and the map is
                // proved total at compile time, so this cannot drift from the state it is testing.
                let billingStale = false;
                if (subscription && subscription.lifecycle_state === STORE_LIFECYCLE_STATES.CONVERTED) {
                    billingStale = !isActiveNow;
                }

                //  ONE RULE FOR "THE PLAN THIS STORE IS ON TODAY", shared with the movement rows'
                // `plan_name_now`. This column used to come off `cohort.by_domain`, whose winner is the
                // latest `trial_start` with NO liveness preference, while `planByDomainAsOf(now)`
                // prefers a subscription that has not already ended — so a merchant holding a live
                // 'Starter' plus a newer 'Pro' that has already been cancelled read as 'Starter' in the
                // movement panel and 'Pro' in this table, in ONE response. Rare, but there is no reading
                // of the payload that makes both right, and the liveness-preferring rule is the better
                // of the two.
                const planNowName = _planFor(planNow, row.shop_domain);

                return {
                    shop_id: row.shop_id,
                    shop_domain: row.shop_domain,
                    lifetime_net: row.lifetime_net,
                    lifetime_gross: row.lifetime_gross,
                    first_tx_at: _iso(row.first_tx_at),
                    last_tx_at: _iso(row.last_tx_at),
                    tx_count: row.tx_count,
                    // The plan its charge events name at THIS instant, or null. NEVER a guess and never
                    // borrowed from a neighbouring store.
                    current_plan: planNowName !== '' ? planNowName : null,
                    is_active_now: isActiveNow,
                    subscription_state: subscription ? subscription.state : null,
                    billing_stale: billingStale
                };
            });

            // ── Caveats that apply to every money figure above ──────────────
            const liveFigures = asOfFigures || nowFigures;
            if (liveFigures.billing_interval_unknown_shops > 0) {
                warnings.push(_WARNINGS.unknownIntervalShops(
                    liveFigures.billing_interval_unknown_shops,
                    liveFigures.active_subs
                ));
            }
            if (liveFigures.currencies.length > 1) {
                warnings.push(_WARNINGS.mixedCurrencies(liveFigures.currencies));
            }
            let shopsWithoutDomain = 0;
            for (const shop of liveFigures.live_set.values()) {
                if (!shop.shop_domain) {
                    shopsWithoutDomain += 1;
                }
            }
            if (shopsWithoutDomain > 0) {
                warnings.push(_WARNINGS.shopsWithoutDomain(shopsWithoutDomain));
            }
            if (!app.lifetime_sync_completed_at) {
                warnings.push(_WARNINGS.lifetimeFloor);
            }
            if (!floor) {
                warnings.push(_WARNINGS.coverageFloorUnknown);
            }

            // ── The summary ─────────────────────────────────────────────────
            const cash: LifetimeCashTotals | null = lifetime;
            const asOfBlock: RevenueAsOfBlock = {
                at: asOf.toISOString(),
                mrr: asOfFigures ? _runRate(asOfFigures.mrr) : null,
                active_subs: asOfFigures ? _runRate(asOfFigures.active_subs) : null,
                arpu: asOfFigures ? _runRate(asOfFigures.arpu) : null,
                //  NOT FLOOR-GATED, and equal to `summary.current_mrr` by construction. See the note.
                mrr_now_baseline: _runRate(nowFigures.mrr),
                before_coverage: beforeCoverage,
                coverage_start: floorIso,
                scope_tenant_count: resolvedStores.size,
                unknown_reason: asOfUnknownReason
            };

            const summary: RevenueSummary = {
                current_mrr: _runRate(nowFigures.mrr),
                current_active_subs: _runRate(nowFigures.active_subs),
                arpu: _runRate(nowFigures.arpu),
                //  `null`, NOT `0`, when the ledger holds nothing. `$group` emitting no document is
                // the authoritative "we have not synced anything"; a `0` there claims the business
                // earned nothing, which is a statement about the world rather than about our records.
                lifetime_gross: cash ? cash.total_gross : null,
                lifetime_net: cash ? cash.total_net : null,
                lifetime_shopify_fee: cash ? cash.total_fee : null,
                lifetime_tx_count: cash ? cash.tx_count : null,
                window_cash: windowCash,
                window_movement: movementTotals,
                //  `null`. There is no second MRR engine in this build to cross-check against, and
                // publishing `current_mrr` again under a third label would present one measurement as
                // three independent agreeing ones — which is the most convincing possible way to be
                // wrong. `notes[]` explains the two rows the card still prints.
                ledger_cross_check: null,
                as_of: asOfBlock
            };

            const diagnostics: RevenueOverviewDiagnostics = {
                subscription_charge_rows: history.length,
                shops_with_subscription_payouts: chargeShopIds.size,
                cohort_subscriptions: cohort.subscriptions.length,
                cohort_domains: cohort.by_domain.size,
                unknown_plan_shops: unknownPlanShops,
                shops_without_domain: shopsWithoutDomain,
                billing_interval_unknown_shops: liveFigures.billing_interval_unknown_shops,
                currencies: liveFigures.currencies,
                unmeasured_months: unmeasuredMonths,
                churned_shops_dated_from_ledger: churnedFromLedger,
                earliest_transaction_at: floorIso
            };

            const payload: RevenueOverviewData = {
                partner_app_id: appId,
                app_handle: app.app_handle,
                display_name: app.display_name,
                reporting_currency: config.REVENUE.REPORTING_CURRENCY,
                window: windowMeta,
                summary,
                monthly_trend: monthlyTrend,
                plans,
                top_shops: topShops,
                top_shops_basis: TOP_SHOPS_BASIS,
                movement_shops: movementShops,
                movement_shops_since: movementShops
                    ? {
                        close_at: asOf.toISOString(),
                        now_at: now.toISOString(),
                        close_is_now: !isHistorical,
                        //  `null`, NEVER `false`. `false` prints a banner claiming no install or
                        // uninstall event has EVER synced for this app, which is a specific false claim
                        // about a deployment that has synced. See the field's own JSDoc for why install
                        // state is not derived here at all.
                        install_state_available: null,
                        install_blank_domain_events: null
                    }
                    : null,
                coverage,
                notes,
                //  UNIQUE. The page keys each warning by the string itself, so a duplicate is
                // DROPPED rather than drawn twice — along with its condition.
                warnings: [...new Set(warnings)],
                diagnostics,
                //  READY. The watermark is set; only rows may be missing, and a row count is not a
                // sync state. Publishing NEVER_SYNCED for an empty ledger would aim the operator at
                // "run a sync" when a sync has already run and found nothing.
                data_state: REVENUE_DATA_STATES.READY,
                unknown_reason: null
            };

            return resolve(promiseReturnResult(true, payload, {}, 'Revenue overview resolved.'));
        } catch (error) {
            customConsoleError('ERROR: revenue revenueOverview getRevenueOverview', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not compute the revenue overview. Please try again.'));
        }
    });
};

export = {
    getRevenueOverview,
    /** `READY` | `NEVER_SYNCED`. Published so a test can assert the wire value rather than a literal. */
    REVENUE_DATA_STATES
};
