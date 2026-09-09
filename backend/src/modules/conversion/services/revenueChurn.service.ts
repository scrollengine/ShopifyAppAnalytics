'use strict';

/**
 * ============================================================================
 *  REVENUE CHURN — MRR LOST, AND THE MERCHANTS BEHIND IT
 * ============================================================================
 *
 *  Serves `GET /api/conversion/revenue-churn` — the six tiles, the MRR waterfall, the monthly
 *  movement chart and the "Top revenue lost" table.
 *
 *  ── WHY THIS IS NOT THE LOGO CHURN PAGE ─────────────────────────────────────────────────────
 *
 *  Losing ten $9 merchants and losing one $500 merchant are the SAME revenue event and COMPLETELY
 *  different business events. Logo Churn counts the merchants and publishes no amount at all; this
 *  page prices them and publishes almost nothing else. They are folded from the SAME membership, so
 *  the two can never disagree about WHO left — only about what the loss was worth.
 *
 *  ──  EVERY FIGURE COMES THROUGH `modules/revenue`, AND NOTHING IS RECONSTRUCTED HERE ──────
 *
 *  `liveSetAsOf` decides who is paying and at what monthly amount; `diffMonths` turns two of its
 *  evaluations into a month of movement whose categories reconcile exactly
 *  (`end = start + new + expansion − contraction − churned`). Both are reached through that module's
 *  barrel, which publishes them precisely so a sibling cannot grow its own — see its header on the
 *  two pages that reconstructed MRR independently and disagreed with each other. This file never
 *  replays an event timeline, never tests a subscription state, and never totals an amount the
 *  ledger did not settle.
 *
 *  The subscription cohort IS read, but only for a LABEL — the plan name — and for a dated
 *  cancellation. It never decides who churned or what it cost.
 *
 *  ──  NET CHURN IS NOT CLAMPED AT ZERO ─────────────────────────────────────────────────────
 *
 *  When a month's existing customers expand by more than the month lost, net revenue churn is
 *  NEGATIVE, and that is the single best signal a subscription business has. `helpers/revenueChurn`
 *  computes both rates and its header carries the argument; nothing in this file floors either one.
 *
 *  ──  A PAST MONTH MUST ACTUALLY BE A PAST MONTH ───────────────────────────────────────────
 *
 *  Every month is measured by evaluating the as-of predicate AT ITS OWN BOUNDARIES, against the full
 *  ledger. The tempting shortcut — take today's subscriber list and value it at old prices — is
 *  wrong invisibly: when a merchant uninstalls, their plan reference is reset, so they contribute
 *  NOTHING to any historical month. Every past month then under-reports while erasing exactly the
 *  churn the page exists to measure.
 *
 *  ──  CALENDAR-MONTH MEMBERSHIP MANUFACTURES CHURN ─────────────────────────────────────────
 *
 *  12 × 30 = 360, so a shop on a 30-day cycle SKIPS ONE CALENDAR MONTH A YEAR. "Was billed inside
 *  calendar month M" therefore reports every such shop as CHURNED in the skipped month and NEW the
 *  month after — falsely churning ~1/12 of the paying base every month AND inflating new MRR by the
 *  same amount, out of arithmetic rather than out of anything a merchant did.
 *
 *  Membership here is evaluated AT AN INSTANT with a lookback WIDER THAN THE CYCLE
 *  (`config.REVENUE.ACTIVE_SUB_WINDOW_DAYS`, 38 by default — one 30-day cycle plus payout grace),
 *  which cannot produce the artefact. That value is load-bearing in both directions and its own
 *  config comment records both: too narrow produced a measured 47.6% churn reading for a month in
 *  which nobody cancelled; removed entirely produced $45M of MRR against $10K of settled payouts, on
 *  a suspiciously flat line. It is published as `summary.active_sub_window_days`.
 *
 *  ── ONE LEDGER READ, MANY EVALUATIONS, SHARED BOUNDARIES ────────────────────────────────────
 *
 *  `fetchSubscriptionChargeHistory` runs ONCE and the predicate is evaluated over that one array at
 *  every boundary the response needs. Consecutive months SHARE a boundary — month N's closing set IS
 *  month N+1's opening set — which is what makes `end_mrr` of one month equal `start_mrr` of the
 *  next, and the whole series reconcile end to end. The boundary list is built exactly as
 *  `logoChurn.service` builds it, so the money months and the customer months are the same months.
 *
 *  ──  THE WATERFALL DESCRIBES THE LAST **COMPLETE** MONTH ──────────────────────────────────
 *
 *  `summary.last_month_*` and `top_churned_30d` are the last month in range with
 *  `is_partial_month === false`. The page picks its waterfall row the same way, and captions it with
 *  `summary.last_complete_month`, so the panel and the tiles above it describe one month. Its own
 *  comment records what happened before: it took the FINAL trend row — the month IN PROGRESS — so a
 *  panel headed "Last month" drew an unfinished month that could not reconcile with a single figure
 *  beside it.
 *
 *  ── `summary` AND `monthly_trend` FAIL SEPARATELY, ON PURPOSE ───────────────────────────────
 *
 *  They are two different measurements — one instant plus one complete month, versus every month
 *  boundary in the range — and a young deployment asked for twelve months can answer the first and
 *  not the second.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import listQueryHelper = require('../../shared/helpers/listQuery.helper');
import revenue = require('../../revenue');
import lifecycleConstants = require('../constants/lifecycle.constants');
// ⚠️ FOR `CHURN_DATE_BASES` ALONE. The basis vocabulary is ONE wire value published by BOTH churn
// endpoints, and it lives beside the first one that shipped it rather than being restated here — a
// second copy is how one string acquires two spellings and the same row reads two ways on two pages.
import logoChurnConstants = require('../constants/logoChurn.constants');
import revenueChurnConstants = require('../constants/revenueChurn.constants');
import churnDateHelper = require('../helpers/churnDate.helper');
import ledgerBoundaryHelper = require('../helpers/ledgerBoundary.helper');
import monthBucketHelper = require('../helpers/monthBucket.helper');
import revenueChurnHelper = require('../helpers/revenueChurn.helper');
import subscriptionCohortResolver = require('../resolvers/subscriptionCohort.resolver');
import installCohortRepository = require('../repositories/installCohort.repository');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { LiveSet, MrrMovement, PayingShop } from '../../revenue/types/ledgerMrr.types';
import type { CohortSubscription } from '../types/lifecycle.types';
import type { MonthBucket } from '../types/monthBucket.types';
import type {
    RevenueChurnDiagnostics,
    RevenueChurnMonth,
    RevenueChurnParams,
    RevenueChurnResponse,
    RevenueChurnSummary,
    RevenueChurnedShopRow
} from '../types/revenueChurn.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { positiveInt } = listQueryHelper;
//  THROUGH THE BARREL, and these four imports are the most important lines in the file.
// `modules/revenue` publishes its ledger reader, its as-of predicate, its cadence-aware window and
// its movement fold so that a sibling needing MRR can reach THIS one instead of growing a second —
// see that barrel's own note about two pages reconstructing MRR independently and disagreeing.
const { fetchSubscriptionChargeHistory, liveSetAsOf, liveWindowDaysFor, diffMonths } = revenue;
const { COHORT_DATA_STATES } = lifecycleConstants;
const { CHURN_DATE_BASES } = logoChurnConstants;
const {
    DEFAULT_REVENUE_CHURN_MONTHS,
    MAX_REVENUE_CHURN_MONTHS,
    TOP_CHURNED_LIMIT,
    SHOP_IDENTITY_FIELD
} = revenueChurnConstants;
// The ONE derivation of "when did this shop stop paying", shared with `logoChurn.service` so the two
// churn pages cannot date the same merchant's exit differently.
const { resolveChurnDate } = churnDateHelper;
//  EXTRACTED, NOT COPIED. This file and `services/logoChurn.service` held byte-identical
// private copies of this predicate, and `services/planMix.service` would have been the third.
// One definition, because the three pages must agree about which boundaries the stored payout
// history can answer for — see that helper's header. Behaviour here is unchanged.
const { isSupportedLedgerBoundary } = ledgerBoundaryHelper;
const { buildMonthBuckets, wholeDaysBetween } = monthBucketHelper;
// The two divisions, in one pure place, with no `Math.max(0, …)` anywhere near them.
const { churnRates } = revenueChurnHelper;
const { resolveSubscriptionCohortAsOf } = subscriptionCohortResolver;
// The module's ONE app read — see `installCohort.repository`.
const { findPartnerAppById } = installCohortRepository;

/** Milliseconds in a day. Local, because the offsets this file needs are its own. */
const _DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The methodology this page is measured by. ALWAYS published, in reading order.
 *
 * ⚠️ `notes` IS THIS PAGE'S ONLY PROSE CHANNEL. `revenue-churn/index.js` renders `data.notes` in a
 * "Methodology notes" banner and has no warnings banner at all, so anything an operator must know —
 * a clamp, a coverage floor, a truncation — has to arrive here or it arrives nowhere.
 */
const _NOTES = Object.freeze({
    ledgerBasis: (windowDays: number): string => 'Every figure here is folded from the SETTLED PAYOUT '
        + 'ledger — the same predicate the Revenue page uses — and never from replaying event timelines. '
        + `A shop counts as paying when Shopify settled a subscription charge for it within ${windowDays} `
        + 'days of the instant being measured, so membership is decided AT AN INSTANT rather than by '
        + '"was billed in this calendar month". A 30-day biller skips one calendar month a year, and '
        + 'month-of-charge membership would report every one of them as churned and then new again.',

    rates: 'Gross churn is (churned + contraction) ÷ opening MRR: everything the starting base lost. '
        + 'Net churn subtracts what the same base gained by upgrading, so the gap between the two lines '
        + 'IS expansion. Neither includes new customers — folding acquisition into a churn rate would '
        + 'make a strong sales month look like a strong retention month.',

    negativeNetChurn: 'Net churn is NOT floored at zero. A month whose existing customers expanded by '
        + 'more than it lost publishes a NEGATIVE net churn rate, and that is the best number on this '
        + 'page: it means the base grows on its own before a single new customer is counted. (The '
        + '"0 means expansion ≥ churn" caption on the tile is left over from an implementation that '
        + 'clamped it; the value below it is signed.)',

    completeMonth: (month: string): string => `The tiles and the waterfall describe ${month}, the last `
        + 'COMPLETE month in this range. The newest month in the chart is still running, so its movement '
        + 'is partial by construction — shops that churn later this month are not in it yet.',

    reconciles: 'Within each month, end = start + new + expansion − contraction − churned, exactly. '
        + 'Consecutive months share a boundary, so one month\'s ending MRR is the next one\'s opening MRR '
        + 'and the series reconciles end to end.',

    runRateNotCash: 'This is a RUN-RATE, not cash. It is what the live subscriber base bills per month; '
        + 'the Revenue page\'s lifetime figures are what Shopify actually settled, all time. The two are '
        + 'not expected to track — cash is lumpy (annual prepayments, refunds, payout timing) where a '
        + 'run-rate is smooth.',

    annualNormalised: 'Annual charges are divided by 12, because a year of revenue booked whole would '
        + 'overstate a monthly run-rate twelvefold.'
});

/**
 * ⚠️ THE CAVEAT CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * These are appended to `notes` after the methodology, and also published on their own in
 * `warnings[]`. Each is written for an operator who cannot see this code: what is missing, what that
 * does to the numbers beside it, and what would fix it.
 */
const _WARNINGS = Object.freeze({
    neverSynced: 'No Partner sync has completed for this app yet, so no settled payouts have been fetched '
        + 'and there is no MRR to measure movement in. Every figure is withheld rather than shown as zero — '
        + 'we have not looked, which is not the same as having earned nothing.',

    noSubscriptionPayouts: 'No settled subscription payouts have ever been synced for this app, so there is '
        + 'no recurring revenue to measure churn against. One-time and usage charges are deliberately '
        + 'excluded — a store that bought a single add-on has no MRR to lose.',

    monthsClamped: (requested: string, applied: number): string => `The requested range of ${requested} months `
        + `is outside what this endpoint serves, so ${applied} months were returned instead. Ask for between 1 `
        + `and ${MAX_REVENUE_CHURN_MONTHS}.`,

    noCompleteMonth: 'This range holds only the month in progress, so there is no COMPLETE month to put in '
        + 'the tiles. They are left blank rather than filled with a partial month under a heading that says '
        + '"last month". Widen the date range to see a finished one.',

    trendUnsupported: (floor: string, windowDays: number): string => 'None of the requested months can be '
        + `measured. Deciding who was paying on a given date needs the ${windowDays} days of payout history `
        + `before it, and the stored payout history for this app only begins at ${floor} — so every month `
        + 'boundary in this range falls inside the run-up to it. Run a lifetime Partner sync, then read this '
        + 'range again.',

    unmeasuredMonths: (count: number, floor: string, windowDays: number): string => `${count} of the months `
        + `in this range cannot be measured. Deciding who was paying on a date needs the ${windowDays} days of `
        + `payout history before it, and the stored history begins at ${floor} — so those boundaries fall inside `
        + 'the run-up to it. Their bars and their churn rates are published as unknown rather than as zero, and '
        + 'the line breaks over them: a zero there would report that you lost nothing in a month nobody measured.',

    lastMonthUnsupported: (month: string, floor: string, windowDays: number): string => `The tiles for ${month} `
        + `cannot be measured: deciding who was paying at that month's boundaries needs the ${windowDays} days of `
        + `payout history before them, and the stored history begins at ${floor}. They are left blank rather than `
        + 'filled with a zero, which would report a month in which you lost nothing over a period we cannot see.',

    coverageFloorUnknown: 'No payout coverage floor has ever been measured for this app, so nothing here can '
        + 'say how far back the stored payout history actually reaches. The earliest months may under-report '
        + 'the paying base — and therefore over-report churn — and there is no way to tell which from the '
        + 'stored data.',

    lifetimeFloor: 'No lifetime Partner sync has ever completed for this app, so the stored payouts are '
        + 'whatever the incremental sync windows happened to pull. Every month is a floor rather than a total, '
        + 'and the earliest ones most of all.',

    billingIntervalUnknown: (count: number, total: number): string => `${count} of ${total} currently-paying `
        + 'shops carry no billing_interval on their latest payout. Any ANNUAL subscriber among them is booked '
        + 'at 12x its true monthly run-rate, so every MRR figure on this page reads HIGH by that amount. A '
        + 'lifetime Partner re-sync fills the field in.',

    multipleCurrencies: (codes: string[]): string => `Live charges span ${codes.length} currencies `
        + `(${codes.join(', ')}) and nothing in this build converts between them, so every total here is a sum `
        + 'of unlike units. There is no exchange-rate table, deliberately: a wrong rate produces a plausible '
        + 'wrong number.',

    shoplessChurnedShops: (count: number): string => `${count} churned shop(s) carry no shop domain on their `
        + 'payout rows, so their lost MRR is counted in the totals but they cannot be opened in the store panel '
        + '— there is no store identity to look one up with.',

    plansUnknown: (count: number): string => `${count} churned shop(s) could not be matched to a subscription, `
        + 'so their plan is left blank rather than guessed. That happens when the charge events for a shop were '
        + 'never synced, or when its payouts carry no domain to join on — never because the merchant had no plan.',

    ledgerDatedChurns: (count: number): string => `${count} churned shop(s) have no cancellation event on `
        + 'record, so their churn date is the moment their last settled payout aged out of the active window '
        + 'rather than the day they cancelled. That instant is always LATER than the real one, so their "paid '
        + 'duration" is an over-estimate — check churn_date_basis on the row before quoting a date.',

    topChurnedTruncated: (shown: number, total: number): string => `${total} shop(s) lost MRR in the month `
        + `below and the table shows the ${shown} largest. The rest are counted in the "Churned MRR" tile above `
        + 'it, so the table does not sum to that figure.'
});

/** The reason attached to a single month whose boundaries the payout history cannot support. */
const _MONTH_UNKNOWN_REASON = (floor: string, windowDays: number): string => 'Deciding who was paying at this '
    + `month's boundaries needs the ${windowDays} days of payout history before them, and the stored history `
    + `begins at ${floor}. Every figure for this month is unknown rather than zero.`;

/** An ISO string, or null. */
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

/**
 * Which coverage gates make the stored payout history incomplete.
 *
 * ⚠️ THE MONEY GATES, NEVER THE EVENT ONES. `models/partner/partnerApp.model.ts` keeps
 * `earliest_transaction_at` and `earliest_event_at` apart precisely so a revenue figure cannot borrow
 * the events' coverage — payouts settle later than the charge events that earned them, and a lifetime
 * sync of one can succeed while the other fails. Every figure on this page is built from payouts.
 *
 * @param app - The app row.
 * @returns Zero or more warning strings.
 */
const _coverageWarnings = (app: PartnerAppDoc): string[] => {
    const out: string[] = [];
    if (!app.lifetime_sync_completed_at) {
        out.push(_WARNINGS.lifetimeFloor);
    }
    if (!_validDate(app.earliest_transaction_at)) {
        out.push(_WARNINGS.coverageFloorUnknown);
    }
    return out;
};

/**
 * Total monthly run-rate over a live set.
 *
 * ⚠️ `monthly_amount`, NEVER `charged_amount`. The first is what `normalizeToMonthly` produced — an
 * ANNUAL charge divided by 12 — and the second is the charge exactly as billed. Summing the second
 * books a year of revenue as one month's run-rate.
 *
 * @param set - Shops paying at one instant.
 * @returns Their combined monthly run-rate.
 */
const _mrrOf = (set: LiveSet): number => {
    let total = 0;
    for (const shop of set.values()) {
        total += shop.monthly_amount;
    }
    return total;
};

/**
 * MRR movement per month, and the merchants behind the last complete month's losses.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query, already cast (not coerced) by the controller.
 * @param params1.partner_app_id - The app to report on. Required.
 * @param [params1.months] - Calendar months of trend. Clamped, never refused.
 * @returns The movement, or an honest refusal carrying `{}`.
 */
const getRevenueChurn = (
    { user_id }: IdentityObject,
    { partner_app_id, months }: RevenueChurnParams
): Promise<ServiceResult<RevenueChurnResponse | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'partner_app_id is required. Read it from GET /api/partner-apps.'));
            }

            const app = await findPartnerAppById(String(partner_app_id));
            if (!app) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }

            // The service reads the clock ONCE, here, and passes the instant into every pure thing
            // below. A second `new Date()` further down would let two halves of one response describe
            // two different instants — and on this page that means the tiles and the chart.
            const asOf = new Date();
            const appId = String(app._id);
            const windowDays = config.REVENUE.ACTIVE_SUB_WINDOW_DAYS;
            const windowMs = windowDays * _DAY_MS;

            const appliedMonths = positiveInt(months, DEFAULT_REVENUE_CHURN_MONTHS, MAX_REVENUE_CHURN_MONTHS);
            const warnings: string[] = [];
            // FAIL-OPEN, PLUS A WARNING. An out-of-range `months` is clamped rather than refused, and
            // the clamp is reported — a chart silently showing 36 months when 200 were asked for is a
            // chart whose x-axis nobody checked.
            const requestedMonths = months === undefined || months === null ? '' : String(months).trim();
            if (requestedMonths !== '' && String(appliedMonths) !== requestedMonths) {
                warnings.push(_WARNINGS.monthsClamped(requestedMonths, appliedMonths));
            }

            const buckets: MonthBucket[] = buildMonthBuckets({ as_of: asOf, months: appliedMonths });
            const oldest = buckets.length > 0 ? buckets[0].start : null;

            const _envelope = {
                app_id: appId,
                app_name: app.display_name,
                months: buckets.length,
                since: oldest ? oldest.toISOString() : null,
                until: asOf.toISOString(),
                as_of: asOf.toISOString(),
                // A LABEL for the payout currency, not a conversion instruction — nothing in this
                // build converts, because a wrong rate produces a plausible wrong number.
                reporting_currency: config.REVENUE.REPORTING_CURRENCY,
                shop_identity: SHOP_IDENTITY_FIELD
            };

            const _emptyDiagnostics = (): RevenueChurnDiagnostics => ({
                subscription_charge_rows: 0,
                shops_with_subscription_payouts: 0,
                unmeasured_months: buckets.length,
                top_churned_omitted: 0,
                top_churned_without_plan: 0,
                top_churned_dated_from_ledger: 0,
                top_churned_without_domain: 0,
                billing_interval_unknown_shops: 0,
                currencies: [],
                earliest_transaction_at: _iso(app.earliest_transaction_at)
            });

            /**
             * The payload both "nothing to measure" branches publish, so the two cannot drift.
             *
             *  `data_state` IS A PARAMETER, NOT A CONSTANT. The two branches below answer different
             * questions and only ONE of them is `NEVER_SYNCED`; hard-coding it would publish "no
             * Partner sync has completed" about an app whose `last_synced_at` is set — a data_state
             * decided by a ROW COUNT, which `subscriptionList.constants` forbids by name.
             *
             * @param reason - The sentence the banner prints, and the first note.
             * @param dataState - READY or NEVER_SYNCED, decided by the WATERMARK.
             * @returns The payload.
             */
            const _coldPayload = (
                reason: string,
                dataState: RevenueChurnResponse['data_state']
            ): RevenueChurnResponse => ({
                ..._envelope,
                // ⚠️ `null`, NOT a zeroed block. The page's `isNeverSynced` is `(d) => !d.summary` and
                // its six tiles read `data.summary.current_mrr` directly, so a zeroed summary would
                // render "Current MRR 0.00" — a checkable, false claim about the business.
                summary: null,
                monthly_trend: null,
                trend_unknown_reason: reason,
                top_churned_30d: [],
                top_churned_truncated: false,
                // The clamp notice, if one was raised, rides along rather than being dropped: this
                // branch is reached AFTER the range was resolved, and a warning discarded because a
                // different condition fired first is a warning nobody can act on.
                notes: [...new Set([reason, ...warnings])],
                warnings: [...new Set([reason, ...warnings])],
                diagnostics: _emptyDiagnostics(),
                data_state: dataState,
                // The banner's body. Without it `dataState.js` falls back to `resp.msg` and prints the
                // SUCCESS message under the heading "Nothing synced yet".
                unknown_reason: reason
            });

            // ── THE WATERMARK, NEVER THE ROW COUNT ───────────────────────────
            // This is the ONE condition that produces NEVER_SYNCED. Nothing below may reach for it.
            if (!app.last_synced_at) {
                return resolve(promiseReturnResult(
                    true,
                    _coldPayload(_WARNINGS.neverSynced, COHORT_DATA_STATES.NEVER_SYNCED),
                    {},
                    'Revenue churn resolved.'
                ));
            }

            // ── ONE ledger read, plus the cohort that supplies the LABELS ────
            const [history, cohortResult] = await Promise.all([
                fetchSubscriptionChargeHistory({ partner_app_id: appId }),
                resolveSubscriptionCohortAsOf({ partner_app_id: appId, as_of: asOf })
            ]);

            if (history.length === 0) {
                //  A Partner sync HAS completed and the subscription ledger is empty. That stays
                // `READY`: the watermark is set, only the rows are missing, and a row count is not a
                // sync state. Publishing NEVER_SYNCED would aim the operator at "run a sync" when a
                // sync has already run and found no subscription payouts.
                return resolve(promiseReturnResult(
                    true,
                    _coldPayload(_WARNINGS.noSubscriptionPayouts, COHORT_DATA_STATES.READY),
                    {},
                    'Revenue churn resolved.'
                ));
            }

            // ── ONE pass over the ledger for the per-shop dates ──────────────
            // ⚠️ NOT SORTED. `fetchSubscriptionChargeHistory` returns NEWEST FIRST and `liveSetAsOf`
            // depends on that order to accept the first row it sees per shop. Re-ordering this array
            // — even into a copy that is then passed on — would silently change every membership
            // answer below.
            const firstChargeAt = new Map<string, Date>();
            const shopIds = new Set<string>();
            for (const row of history) {
                shopIds.add(row.shop_id);
                const at = _validDate(row.created_at);
                if (!at) {
                    continue;
                }
                const incumbent = firstChargeAt.get(row.shop_id);
                if (!incumbent || at.getTime() < incumbent.getTime()) {
                    firstChargeAt.set(row.shop_id, at);
                }
            }

            // ── The subscription cohort, for LABELS ONLY ─────────────────────
            // Plan name and a dated cancellation. It never decides membership and never touches an
            // amount — the ledger owns both. Keyed by domain, the only join the two sides share.
            const subscriptionByDomain: Map<string, CohortSubscription> = cohortResult.by_domain;

            const floor = _validDate(app.earliest_transaction_at);

            /**
             * The paying set at one instant, or `null` when the stored history cannot support it.
             *
             * ⚠️ THE AS-OF-NOW BOUNDARY IS DELIBERATELY NOT GATED — see the call site. Every
             * HISTORICAL boundary is, because a truncated lookback under-counts the opening base and
             * therefore over-states every churn RATE measured against it.
             */
            const _setAt = (at: Date): LiveSet | null => {
                if (!isSupportedLedgerBoundary(at, floor, windowMs)) {
                    return null;
                }
                return liveSetAsOf(history, at, windowDays);
            };

            // ⚠️ UNGATED, on purpose. `GET /api/revenue/now` publishes `mrr` from this exact predicate
            // at this exact instant with no floor test, so gating it here would put a blank tile on
            // one page beside a number on another for one measurement. The floor is reported through
            // the notes instead, where it explains both pages at once.
            const setNow = liveSetAsOf(history, asOf, windowDays);
            const currentMrr = _mrrOf(setNow);

            // The two standing caveats on any MRR figure, measured rather than asserted.
            const intervalUnknownShops = [...setNow.values()].filter((shop) => !shop.billing_interval).length;
            const currencyCodes = [...new Set([...setNow.values()]
                .map((shop) => shop.currency)
                .filter((code) => Boolean(code)))].sort();

            // ── The monthly series, over SHARED boundaries ───────────────────
            // ONE evaluation per boundary, and consecutive months share one: month N's closing set IS
            // month N+1's opening set, so `end_mrr` of one month IS `start_mrr` of the next and the
            // series reconciles end to end. Evaluating each month's two boundaries independently would
            // leave a one-millisecond seam between them that nothing reconciles.
            //
            // Built EXACTLY as `logoChurn.service` builds it, so the money months and the customer
            // months on the two pages are the same months.
            const boundaries: Date[] = buckets.map((bucket) => bucket.start);
            if (buckets.length > 0) {
                boundaries.push(buckets[buckets.length - 1].end);
            }
            const setsAtBoundary: Array<LiveSet | null> = boundaries.map((at) => _setAt(at));

            let unmeasuredMonths = 0;
            /** Parallel to `buckets`: the movement, or null where the history could not support it. */
            const movements: Array<MrrMovement | null> = [];
            const monthlyTrend: RevenueChurnMonth[] = buckets.map((bucket, index) => {
                const startSet = setsAtBoundary[index];
                const endSet = setsAtBoundary[index + 1];
                if (!startSet || !endSet) {
                    unmeasuredMonths += 1;
                    movements.push(null);
                    return {
                        month: bucket.month,
                        //  EVERY FIGURE null, not just the rates. A `0` here would report a month
                        // in which the business lost nothing and gained nothing, which is a claim
                        // about the operator's business rather than about this deployment's records.
                        start_mrr: null,
                        end_mrr: null,
                        new_mrr: null,
                        expansion_mrr: null,
                        contraction_mrr: null,
                        churned_mrr: null,
                        gross_churn_rate: null,
                        net_churn_rate: null,
                        churned_shops: null,
                        is_partial_month: bucket.is_partial,
                        measurable: false,
                        unknown_reason: floor
                            ? _MONTH_UNKNOWN_REASON(floor.toISOString(), windowDays)
                            : _WARNINGS.coverageFloorUnknown
                    };
                }
                //  `diffMonths`, NOT a fold written here. It is the canonical movement between two
                // evaluations of the canonical membership predicate, and its categories reconcile
                // exactly. A second implementation is the second definition of "how much did we lose".
                const movement = diffMonths(startSet, endSet);
                movements.push(movement);
                const rates = churnRates(movement);
                return {
                    month: bucket.month,
                    start_mrr: movement.start_mrr,
                    end_mrr: movement.end_mrr,
                    new_mrr: movement.new_mrr,
                    expansion_mrr: movement.expansion_mrr,
                    contraction_mrr: movement.contraction_mrr,
                    churned_mrr: movement.churned_mrr,
                    //  Straight off the pure helper, unclamped in both directions: `null` for a
                    // month that opened with no MRR, and NEGATIVE when expansion outran the losses.
                    gross_churn_rate: rates.gross_churn_rate,
                    net_churn_rate: rates.net_churn_rate,
                    churned_shops: movement.churned_shops.length,
                    is_partial_month: bucket.is_partial,
                    measurable: true,
                    unknown_reason: null
                };
            });

            // ⚠️ `null` — never the all-unmeasured array — when NO month could be measured, matching
            // Logo Churn so the two pages fail the same way. An array with SOME measured months stays
            // an array; the blanks inside it break the line, which is the honest rendering.
            const anyMeasurableMonth = monthlyTrend.some((month) => month.measurable);
            let trendUnknownReason: string | null = null;
            if (buckets.length > 0 && !anyMeasurableMonth) {
                trendUnknownReason = floor
                    ? _WARNINGS.trendUnsupported(floor.toISOString(), windowDays)
                    : _WARNINGS.coverageFloorUnknown;
                warnings.push(trendUnknownReason);
            } else if (unmeasuredMonths > 0 && floor) {
                warnings.push(_WARNINGS.unmeasuredMonths(unmeasuredMonths, floor.toISOString(), windowDays));
            }

            // ──  THE LAST **COMPLETE** MONTH ───────────────────────────────
            //
            // The tiles, the waterfall and the churned-merchant table all describe THIS month, and the
            // page picks its waterfall row the same way — the last trend row with
            // `is_partial_month === false`. Taking the final row instead draws the month IN PROGRESS
            // under a heading that says "last month", which is what the page's own comment records
            // having shipped: a panel that could not reconcile with a single figure beside it.
            let lastCompleteIndex = -1;
            for (let index = buckets.length - 1; index >= 0; index -= 1) {
                if (!buckets[index].is_partial) {
                    lastCompleteIndex = index;
                    break;
                }
            }
            const lastCompleteMonth = lastCompleteIndex >= 0 ? buckets[lastCompleteIndex].month : null;
            const lastMovement = lastCompleteIndex >= 0 ? movements[lastCompleteIndex] : null;

            if (lastCompleteIndex < 0) {
                // A one-month window can hold nothing but the month in progress. The tiles stay blank
                // rather than quoting a partial month under a "last month" label; the page still draws
                // the waterfall for it and captions it as unfinished, which is its own decision.
                warnings.push(_WARNINGS.noCompleteMonth);
            } else if (!lastMovement && floor) {
                warnings.push(_WARNINGS.lastMonthUnsupported(
                    buckets[lastCompleteIndex].month,
                    floor.toISOString(),
                    windowDays
                ));
            }

            const lastRates = lastMovement
                ? churnRates(lastMovement)
                : { gross_churn_rate: null, net_churn_rate: null };

            const summary: RevenueChurnSummary = {
                current_mrr: currentMrr,
                active_subs: setNow.size,
                last_complete_month: lastCompleteMonth,
                last_month_start_mrr: lastMovement ? lastMovement.start_mrr : null,
                last_month_end_mrr: lastMovement ? lastMovement.end_mrr : null,
                last_month_new_mrr: lastMovement ? lastMovement.new_mrr : null,
                last_month_expansion_mrr: lastMovement ? lastMovement.expansion_mrr : null,
                last_month_contraction_mrr: lastMovement ? lastMovement.contraction_mrr : null,
                last_month_churned_mrr: lastMovement ? lastMovement.churned_mrr : null,
                last_month_gross_churn_rate: lastRates.gross_churn_rate,
                //  SIGNED. Not floored, not absolute — a negative reading is the answer, not an error.
                last_month_net_churn_rate: lastRates.net_churn_rate,
                active_sub_window_days: windowDays,
                basis: `MRR is the monthly run-rate of every shop Shopify settled a subscription charge for `
                    + `within the ${windowDays} days before the instant being measured, with ANNUAL charges `
                    + 'divided by 12. Membership is evaluated AT AN INSTANT, never "was billed in this calendar '
                    + 'month". The month figures are the LAST COMPLETE month, not the month in progress.'
            };

            // ── The merchants behind the last complete month's losses ────────
            let churnedWithoutPlan = 0;
            let churnedFromLedger = 0;
            let churnedWithoutDomain = 0;
            const churnedRows: RevenueChurnedShopRow[] = [];

            // The set the churned shops were LAST SEEN PAYING IN — the month's opening boundary. They
            // are absent from its closing set by definition, so this is the only place their amount,
            // their cadence and their last payout still exist.
            //
            //  NARROWED, NOT CAST. This used to read `setsAtBoundary[lastCompleteIndex] as LiveSet`
            // inside the block, justified by `lastMovement` being set — which does imply it today.
            // But that implication lives in ANOTHER function, and `as` makes the compiler stop
            // checking the one place that would catch the day it stops being true. Hoisting the read
            // into the guard costs nothing, reads the same, and cannot go stale. `models.repository`
            // declares any `as` outside itself a finding for exactly this reason. `lastCompleteIndex`
            // of -1 indexes to undefined, so the guard still covers the "no complete month" case the
            // old condition tested explicitly.
            const openingSet = setsAtBoundary[lastCompleteIndex];

            if (openingSet && lastMovement) {
                for (const churned of lastMovement.churned_shops) {
                    const shop: PayingShop | undefined = openingSet.get(churned.shop_id);
                    if (!shop) {
                        continue;
                    }
                    const domain = shop.shop_domain || '';
                    if (domain === '') {
                        churnedWithoutDomain += 1;
                    }
                    const subscription = domain !== '' ? subscriptionByDomain.get(domain) : undefined;

                    // `paid_from` is the shop's FIRST settled subscription payout — the ledger's own
                    // answer to "when did they start paying us". Dating this column off the event
                    // stream while `churned_at` came off the ledger is how two dates that must bracket
                    // each other come to cross.
                    const activatedAt = firstChargeAt.get(churned.shop_id) || shop.last_charged_at;

                    // THE ONE DERIVATION, shared with Logo Churn — see `helpers/churnDate.helper`.
                    // The same merchant leaving must not carry two different dates on two pages.
                    const churn = resolveChurnDate({
                        activated_at: activatedAt,
                        last_charged_at: shop.last_charged_at,
                        live_window_days: liveWindowDaysFor(shop.billing_interval, windowDays),
                        event_churn_date: subscription ? subscription.churn_date : null,
                        as_of: asOf
                    });
                    if (churn.basis === CHURN_DATE_BASES.LEDGER_WINDOW) {
                        churnedFromLedger += 1;
                    }

                    //  `''` WHEN WE CANNOT NAME THE PLAN, never a guess and never a real plan's
                    // name. The page renders a falsy plan as an em dash, which claims nothing; filing
                    // an unjoinable merchant under a real plan would move revenue between plans.
                    const planName = subscription ? subscription.plan_name : '';
                    if (planName === '') {
                        churnedWithoutPlan += 1;
                    }

                    churnedRows.push({
                        shop_id: churned.shop_id,
                        shop_domain: domain,
                        plan_name: planName,
                        //  THE NORMALISED monthly amount, straight off `diffMonths` — an ANNUAL
                        // charge already divided by 12. `charged_amount` would book a year of revenue
                        // as one month's loss.
                        lost_mrr: churned.lost_mrr,
                        currency: shop.currency,
                        paid_from: activatedAt.toISOString(),
                        churned_at: churn.churned_at.toISOString(),
                        churn_date_basis: churn.basis,
                        // ALWAYS a number: the page prints a duration from it, and both endpoints of
                        // the subtraction are on this row.
                        paid_days: wholeDaysBetween(activatedAt, churn.churned_at),
                        billing_interval: shop.billing_interval
                    });
                }
            }

            // SORT A COPY. `churnedRows` is built fresh above, so nothing is wrong today — it is free
            // to make an in-place sort of an array something else counted impossible rather than true
            // by coincidence. BIGGEST LOSS FIRST, which is what "Top revenue lost" means, then by
            // domain so ties are stable between requests — a reshuffle on refresh reads as the data
            // changing.
            const sortedChurned = [...churnedRows].sort((a, b) => {
                if (b.lost_mrr !== a.lost_mrr) {
                    return b.lost_mrr - a.lost_mrr;
                }
                return a.shop_domain.localeCompare(b.shop_domain);
            });
            const topChurned = sortedChurned.slice(0, TOP_CHURNED_LIMIT);
            const churnedOmitted = sortedChurned.length - topChurned.length;

            // ── Everything approximated or excluded, said out loud ───────────
            if (intervalUnknownShops > 0) {
                warnings.push(_WARNINGS.billingIntervalUnknown(intervalUnknownShops, setNow.size));
            }
            if (currencyCodes.length > 1) {
                warnings.push(_WARNINGS.multipleCurrencies(currencyCodes));
            }
            if (churnedWithoutDomain > 0) {
                warnings.push(_WARNINGS.shoplessChurnedShops(churnedWithoutDomain));
            }
            if (churnedWithoutPlan > 0) {
                warnings.push(_WARNINGS.plansUnknown(churnedWithoutPlan));
            }
            if (churnedFromLedger > 0) {
                warnings.push(_WARNINGS.ledgerDatedChurns(churnedFromLedger));
            }
            if (churnedOmitted > 0) {
                warnings.push(_WARNINGS.topChurnedTruncated(topChurned.length, sortedChurned.length));
            }
            warnings.push(..._coverageWarnings(app));

            // ── The methodology, then the caveats, in reading order ──────────
            //
            // ⚠️ `notes` IS THE PAGE'S ONLY PROSE CHANNEL — it renders `data.notes` and has no
            // warnings banner at all — so every caveat is appended here as well as published on its
            // own in `warnings`. A caveat that reaches only `warnings[]` reaches no operator.
            const methodology: string[] = [
                _NOTES.ledgerBasis(windowDays),
                _NOTES.rates,
                _NOTES.negativeNetChurn,
                _NOTES.reconciles,
                _NOTES.runRateNotCash,
                _NOTES.annualNormalised
            ];
            if (lastCompleteMonth) {
                methodology.push(_NOTES.completeMonth(lastCompleteMonth));
            }

            const diagnostics: RevenueChurnDiagnostics = {
                subscription_charge_rows: history.length,
                shops_with_subscription_payouts: shopIds.size,
                unmeasured_months: unmeasuredMonths,
                top_churned_omitted: churnedOmitted,
                top_churned_without_plan: churnedWithoutPlan,
                top_churned_dated_from_ledger: churnedFromLedger,
                top_churned_without_domain: churnedWithoutDomain,
                billing_interval_unknown_shops: intervalUnknownShops,
                currencies: currencyCodes,
                earliest_transaction_at: _iso(app.earliest_transaction_at)
            };

            const uniqueWarnings = [...new Set(warnings)];
            const payload: RevenueChurnResponse = {
                ..._envelope,
                summary,
                monthly_trend: trendUnknownReason === null ? monthlyTrend : null,
                trend_unknown_reason: trendUnknownReason,
                top_churned_30d: topChurned,
                top_churned_truncated: churnedOmitted > 0,
                // DE-DUPLICATED on both arrays. A repeated sentence is noise, and on a list keyed by
                // content it is worse than noise — one copy silently takes the other's condition down.
                notes: [...new Set([...methodology, ...uniqueWarnings])],
                warnings: uniqueWarnings,
                diagnostics,
                data_state: COHORT_DATA_STATES.READY
            };

            // ⚠️ A 200 with an empty churn table, always. "Nobody left last month" is the best possible
            // answer and an ordinary one; it is separated from "we have not looked" by `data_state` and
            // from "we cannot see that far back" by `measurable` / `notes[]` — never by a refusal.
            return resolve(promiseReturnResult(true, payload, {}, 'Revenue churn resolved.'));
        } catch (error) {
            customConsoleError('ERROR: Conversion revenueChurnService getRevenueChurn', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read revenue churn. Please try again.'));
        }
    });
};

export = {
    getRevenueChurn
};
