'use strict';

/**
 * ============================================================================
 *  LOGO CHURN — CUSTOMERS LOST, COUNTED IN CUSTOMERS
 * ============================================================================
 *
 *  Serves `GET /api/conversion/logo-churn` — the four tiles, the monthly movement chart, the
 *  churn-by-plan table and the recently-churned list.
 *
 *  ── WHY THIS IS NOT A REVENUE PAGE ──────────────────────────────────────────────────────────
 *
 *  Losing ten $9 merchants and losing one $500 merchant are the SAME revenue event and COMPLETELY
 *  different business events. One says your entry plan is not sticking; the other says you lost an
 *  anchor customer. A single MRR-churn number cannot tell them apart, which is why this page counts
 *  logos and the Revenue page counts money. Nothing in this response carries an amount — not even
 *  `lost_mrr` on a churned row, which would be a money figure on a customer-count screen and would
 *  invite exactly the reading the split exists to prevent.
 *
 *  ── ⚠️ MEMBERSHIP COMES THROUGH `liveSetAsOf`, AND THERE IS NO SECOND PREDICATE HERE ────────
 *
 *  "Shop S is paying as of D" is defined ONCE, in `modules/revenue/helpers/ledgerMrr.helper`, and
 *  reached through that module's barrel — which publishes it precisely so a sibling cannot grow its
 *  own. Every count on this page is a SET DIFFERENCE between two evaluations of that predicate. This
 *  file never asks whether a subscription is `PAYING`, never tests an amount, and never filters on
 *  "was billed in this window". If it did, the customer count here would drift from the subscriber
 *  count behind the MRR figure on the Revenue page, and nothing on either screen would say which was
 *  right.
 *
 *  The subscription cohort IS read — but only for LABELS: a plan name, a trial start, and a dated
 *  cancellation event where one exists. It never decides who is in the paying set.
 *
 *  ── ⚠️ CALENDAR-MONTH MEMBERSHIP MANUFACTURES CHURN ─────────────────────────────────────────
 *
 *  12 × 30 = 360, so a shop on a 30-day billing cycle SKIPS ONE CALENDAR MONTH A YEAR. Membership
 *  defined as "had a settled charge inside calendar month M" therefore reports every such shop as
 *  CHURNED in the skipped month and NEW the month after — falsely churning ~1/12 of the paying base
 *  every single month, out of arithmetic rather than out of anything a merchant did, and drawing a
 *  chart that looks entirely plausible.
 *
 *  Membership here is evaluated AT AN INSTANT with a lookback WIDER THAN THE CYCLE
 *  (`config.REVENUE.ACTIVE_SUB_WINDOW_DAYS`, 38 by default — one 30-day cycle plus payout grace),
 *  which cannot produce the artefact. That value is load-bearing in both directions and its own
 *  config comment records what happened at each extreme: too narrow produced a measured 47.6% churn
 *  reading for a month in which nobody cancelled; removed entirely produced $45M of MRR against $10K
 *  of settled payouts. It is published on the payload as `summary.active_sub_window_days` so a
 *  reader can see which window their figures were measured with.
 *
 *  ── ONE LEDGER READ, MANY EVALUATIONS ───────────────────────────────────────────────────────
 *
 *  `fetchSubscriptionChargeHistory` runs ONCE and the predicate is evaluated over that one array at
 *  every boundary the response needs — now, 30 days ago, 90 days ago, and each month boundary. The
 *  repository's own docstring asks for exactly that ("One read; callers evaluate the as-of predicate
 *  over it in memory for as many dates as they need"), and it is what makes the tiles and the trend
 *  arithmetically consistent rather than merely similar.
 *
 *  Consecutive months SHARE a boundary — month N's closing set IS month N+1's opening set — so
 *  `active_at_end === active_at_start + gained - churned` holds along the whole series and the chart
 *  reconciles end to end.
 *
 *  ── `summary` AND `monthly_trend` FAIL SEPARATELY, ON PURPOSE ───────────────────────────────
 *
 *  They are two different measurements: four instants versus every month boundary in the requested
 *  range. A deployment three weeks old asked for twelve months of trend can answer the first and not
 *  the second, and the page has a `_trendDataState` gate built for exactly that — it publishes the
 *  tiles and says plainly that the trend is unavailable, rather than mounting a titled, axed chart
 *  over an empty array, which reads as "we measured these months and nothing moved".
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import listQueryHelper = require('../../shared/helpers/listQuery.helper');
import revenue = require('../../revenue');
import lifecycleConstants = require('../constants/lifecycle.constants');
import logoChurnConstants = require('../constants/logoChurn.constants');
import churnDateHelper = require('../helpers/churnDate.helper');
import funnelMathHelper = require('../helpers/funnelMath.helper');
import ledgerBoundaryHelper = require('../helpers/ledgerBoundary.helper');
import logoChurnHelper = require('../helpers/logoChurn.helper');
import planMixHelper = require('../helpers/planMix.helper');
import monthBucketHelper = require('../helpers/monthBucket.helper');
import subscriptionCohortResolver = require('../resolvers/subscriptionCohort.resolver');
import installCohortRepository = require('../repositories/installCohort.repository');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { LiveSet, PayingShop } from '../../revenue/types/ledgerMrr.types';
import type { CohortSubscription } from '../types/lifecycle.types';
import type { MonthBucket } from '../types/monthBucket.types';
import type {
    LogoChurnDiagnostics,
    LogoChurnMonth,
    LogoChurnParams,
    LogoChurnPlanRow,
    LogoChurnResponse,
    LogoChurnSummary,
    LogoChurnedShopRow
} from '../types/logoChurn.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { positiveInt } = listQueryHelper;
// THROUGH THE BARREL, and this is the single most important import in the file. `modules/revenue`
// publishes its ledger reader and its as-of predicate so that a sibling needing a paying set can
// reach THIS one instead of growing a second — see that barrel's own note about two pages
// reconstructing MRR independently and disagreeing with each other.
const { fetchSubscriptionChargeHistory, liveSetAsOf, liveWindowDaysFor } = revenue;
const { COHORT_DATA_STATES } = lifecycleConstants;
const {
    DEFAULT_CHURN_MONTHS,
    MAX_CHURN_MONTHS,
    RECENT_CHURN_WINDOW_DAYS,
    WIDE_CHURN_WINDOW_DAYS,
    RECENT_CHURN_LIMIT,
    UNKNOWN_PLAN_LABEL,
    CHURN_DATE_BASES,
    SHOP_IDENTITY_FIELD
} = logoChurnConstants;
// THE ONE DIVISION. `logoChurn.helper` already routes the app-wide churn rate through it; the
// per-plan partition below is the same numerator/denominator pair and must not be spelled a second
// way — see that file's header on why there is no `orZero` variant and must not be one.
const { rate } = funnelMathHelper;
// THE ONE DERIVATION OF "when did this shop stop paying". Extracted the day `revenue-churn`
// became the second endpoint to list the same merchants leaving — it prices the exits this page
// counts, so a second copy of this would put two different churn dates on one merchant on two
// pages an operator reads side by side.
const { resolveChurnDate } = churnDateHelper;
//  EXTRACTED, NOT COPIED. `services/revenueChurn.service` already held a byte-identical private
// copy of this predicate and `services/planMix.service` would have been the third — three places for
// one comparison to be relaxed, each blanking or fabricating a different page. See that helper's
// header; behaviour here is unchanged.
const { isSupportedLedgerBoundary } = ledgerBoundaryHelper;
const { foldMembershipMovement } = logoChurnHelper;
//  ALSO EXTRACTED, AND FOR A SHARPER REASON. `plan-mix` partitions THE SAME merchants by THE SAME
// plans over THE SAME two boundaries, on a card an operator reads beside this page's table. The
// historical-plan rule below — latest subscription that had STARTED by the boundary, preferring one
// still running then — is subtle enough that a second copy would drift, and the drift would file one
// merchant under two plans on two cards with nothing on screen to say which was right.
const { resolvePlanAtInstant, planNameFor } = planMixHelper;
const { buildMonthBuckets, wholeDaysBetween } = monthBucketHelper;
const { resolveSubscriptionCohortAsOf } = subscriptionCohortResolver;
// The module's ONE app read — see `installCohort.repository`.
const { findPartnerAppById } = installCohortRepository;

/** Milliseconds in a day. Local because the two `_DAY_MS` this file needs are boundary offsets. */
const _DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ⚠️ THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * The page renders one entry per warning KEYED BY THE STRING ITSELF, so a duplicate is not drawn
 * twice — it is DROPPED, silently, along with its condition.
 */
const _WARNINGS = Object.freeze({
    neverSynced: 'No Partner sync has completed for this app yet, so no settled payouts have been fetched '
        + 'and there is no paying customer base to measure churn against. Every figure is withheld rather '
        + 'than shown as zero — we have not looked, which is not the same as having no customers.',

    noSubscriptionPayouts: 'No settled subscription payouts have ever been synced for this app, so there is '
        + 'no paying customer base to measure churn against. Logo churn counts merchants who were being '
        + 'billed and then were not; with no payout ledger there is nothing to count. One-time and usage '
        + 'charges are deliberately excluded — a store that bought a single add-on is not a subscriber.',

    monthsClamped: (requested: string, applied: number): string => `The requested range of ${requested} months `
        + `is outside what this endpoint serves, so ${applied} months were returned instead. Ask for between 1 `
        + `and ${MAX_CHURN_MONTHS}.`,

    trendUnsupported: (floor: string, windowDays: number): string => 'None of the requested months can be '
        + `measured. Deciding who was paying on a given date needs the ${windowDays} days of payout history `
        + `before it, and the stored payout history for this app only begins at ${floor} — so every month `
        + 'boundary in this range falls inside the run-up to it. The tiles above are unaffected. Run a '
        + 'lifetime Partner sync, then read this range again.',

    unmeasuredMonths: (count: number, floor: string, windowDays: number): string => `${count} of the months `
        + `below cannot be measured. Deciding who was paying on a date needs the ${windowDays} days of payout `
        + `history before it, and the stored history begins at ${floor} — so those boundaries fall inside the `
        + 'run-up to it. Their bars and their churn rate are published as unknown rather than as zero, and the '
        + 'line breaks over them: a zero there would report that nobody was paying you, which is a claim about '
        + 'your business rather than about this deployment\'s records.',

    recentWindowUnsupported: (days: number, floor: string, windowDays: number): string => `The ${days}-day `
        + `churn figures cannot be measured. Deciding who was paying ${days} days ago needs the ${windowDays} `
        + `days of payout history before that date, and the stored history begins at ${floor}. Those tiles are `
        + 'left blank rather than filled with a zero, which would report perfect retention over a period we '
        + 'cannot see.',

    planTableWithheld: 'Churn by plan is not published for this window: it is measured against who was paying '
        + '30 days ago, and that boundary falls before the stored payout history can support it. A table of '
        + 'zeros would read as a set of plans nobody left.',

    coverageFloorUnknown: 'No payout coverage floor has ever been measured for this app, so nothing here can '
        + 'say how far back the stored payout history actually reaches. The earliest months below may under-'
        + 'report the paying base, and there is no way to tell which from the stored data.',

    lifetimeFloor: 'No lifetime Partner sync has ever completed for this app, so the stored payouts are '
        + 'whatever the incremental sync windows happened to pull. Every month below is a floor rather than a '
        + 'total, and the earliest ones most of all.',

    shoplessChurnedShops: (count: number): string => `${count} churned shop(s) carry no shop domain on their `
        + 'payout rows, so they are counted in the totals but cannot be opened in the store panel — there is no '
        + 'store identity to look one up with.',

    plansUnknownAt30: (count: number, days: number): string => `${count} shop(s) that were paying `
        + `${days} days ago have no subscription on record from that date, so the "Active ${days}d ago" `
        + `column files them under "${UNKNOWN_PLAN_LABEL}" rather than under the plan they are on now. `
        + 'That column is deliberately measured in the plans merchants held THEN — a merchant who has '
        + 'since switched belongs to their old plan\'s opening base, not their new one\'s.',

    plansUnknown: (count: number): string => `${count} churned shop(s) could not be matched to a subscription, `
        + `so their plan is shown as "${UNKNOWN_PLAN_LABEL}" rather than guessed. That happens when the charge `
        + 'events for a shop were never synced, or when its payouts carry no domain to join on — never because '
        + 'the merchant had no plan.',

    ledgerDatedChurns: (count: number): string => `${count} churned shop(s) have no cancellation event on `
        + 'record, so their churn date is the moment their last settled payout aged out of the active window '
        + 'rather than the day they cancelled. That instant is always LATER than the real one, so their "paid '
        + 'duration" is an over-estimate — check `churn_date_basis` on the row before quoting a date.',

    churnListTruncated: (shown: number, total: number): string => `${total} shop(s) churned in the last `
        + `${RECENT_CHURN_WINDOW_DAYS} days and the list below shows the ${shown} most recent. The heading `
        + 'counts the rows shown, not the churns — the rest are in the tile above it.',

    partialMonth: (month: string): string => `The most recent month (${month}) is still running, so its `
        + 'movement is partial by construction: shops that churn later this month are not in it yet.'
});

/** The reason attached to a single month whose boundaries the payout history cannot support. */
const _MONTH_UNKNOWN_REASON = (floor: string, windowDays: number): string => 'Deciding who was paying at this '
    + `month's boundaries needs the ${windowDays} days of payout history before them, and the stored history `
    + `begins at ${floor}. The counts are unknown rather than zero.`;

/** An ISO string, or null. */
const _iso = (value?: Date | null): string | null => {
    if (!value) {
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
 * `earliest_transaction_at` and `earliest_event_at` apart precisely so "a revenue figure cannot
 * borrow the events' coverage" — payouts settle later than the charge events that earned them, and a
 * lifetime sync of one can succeed while the other fails. Every figure on this page is built from
 * payouts, so only the payout gates apply.
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
 * Churn measured in customers: the paying base now, what has left it, and the month-by-month shape.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query, already cast (not coerced) by the controller.
 * @param params1.partner_app_id - The app to report on. Required.
 * @param [params1.months] - Calendar months of trend. Clamped, never refused.
 * @returns The churn view, or an honest refusal carrying `{}`.
 */
const getLogoChurn = (
    { user_id }: IdentityObject,
    { partner_app_id, months }: LogoChurnParams
): Promise<ServiceResult<LogoChurnResponse | EmptyPayload>> => {
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
            // two different instants.
            const asOf = new Date();
            const appId = String(app._id);
            const windowDays = config.REVENUE.ACTIVE_SUB_WINDOW_DAYS;
            const windowMs = windowDays * _DAY_MS;

            const appliedMonths = positiveInt(months, DEFAULT_CHURN_MONTHS, MAX_CHURN_MONTHS);
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
                shop_identity: SHOP_IDENTITY_FIELD
            };

            /**
             * The payload both "nothing to measure" branches publish, so the two cannot drift.
             *
             *  `data_state` IS A PARAMETER, NOT A CONSTANT, AND THAT IS THE WHOLE POINT. The two
             * branches below are answering different questions and only ONE of them is
             * `NEVER_SYNCED`. Hard-coding it here made the second branch — a synced app whose
             * `APP_SUBSCRIPTION` ledger is empty — publish "no Partner sync has completed" about an
             * app whose `last_synced_at` is set, which is a data_state decided by a ROW COUNT.
             * `subscriptionList.constants` forbids that substitution by name ("a row count in
             * disguise") and `subscriptionList.service` handles the identical situation the right
             * way: it stays READY and explains the empty ledger through `warnings[]`.
             *
             * @param reason - The sentence the banner prints and `warnings[]` carries.
             * @param diagnostics - The counters for this branch.
             * @param dataState - READY or NEVER_SYNCED, decided by the WATERMARK.
             * @returns The payload.
             */
            const _coldPayload = (
                reason: string,
                diagnostics: LogoChurnDiagnostics,
                dataState: LogoChurnResponse['data_state']
            ): LogoChurnResponse => ({
                ..._envelope,
                // ⚠️ `null`, NOT a zeroed block. The page's `isNeverSynced` is `(d) => !d.summary` and
                // its four tiles read `data.summary.current_active` directly, so a zeroed summary
                // would render "Currently active 0" — a checkable, false claim about the business.
                // That gate is the page's own, and it fires on BOTH branches regardless of
                // `data_state` — so correcting the state below changes the JSON contract without
                // moving a pixel, which is exactly what it should do.
                summary: null,
                monthly_trend: null,
                trend_unknown_reason: reason,
                by_plan: [],
                recent_churned: [],
                recent_churned_truncated: false,
                // The clamp notice, if one was raised, rides along rather than being dropped: this
                // branch is reached AFTER the range was resolved, and a warning discarded because a
                // different condition fired first is a warning nobody can act on.
                warnings: [...new Set([reason, ...warnings])],
                diagnostics,
                data_state: dataState,
                // The banner's body. Without it `dataState.js` falls back to `resp.msg` and prints the
                // SUCCESS message under the heading "Nothing synced yet".
                unknown_reason: reason
            });

            const _emptyDiagnostics = (): LogoChurnDiagnostics => ({
                subscription_charge_rows: 0,
                shops_with_subscription_payouts: 0,
                churned_shops_without_plan: 0,
                churned_shops_dated_from_ledger: 0,
                churned_shops_without_domain: 0,
                unmeasured_months: buckets.length,
                churned_shops_omitted: 0,
                earliest_transaction_at: _iso(app.earliest_transaction_at)
            });

            // ── THE WATERMARK, NEVER THE ROW COUNT ───────────────────────────
            // This is the ONE condition that produces NEVER_SYNCED. Nothing below may reach for it.
            if (!app.last_synced_at) {
                return resolve(promiseReturnResult(
                    true,
                    _coldPayload(_WARNINGS.neverSynced, _emptyDiagnostics(), COHORT_DATA_STATES.NEVER_SYNCED),
                    {},
                    'Logo churn resolved.'
                ));
            }

            // ── ONE ledger read, plus the cohort that supplies the LABELS ────
            const [history, cohortResult] = await Promise.all([
                fetchSubscriptionChargeHistory({ partner_app_id: appId }),
                resolveSubscriptionCohortAsOf({ partner_app_id: appId, as_of: asOf })
            ]);

            if (history.length === 0) {
                // A Partner sync HAS completed and the subscription ledger is empty. That is not a
                // measured "nobody is paying you" — an app with no `APP_SUBSCRIPTION` payouts has no
                // paying base to have lost anyone FROM, and a churn rate over an empty base is not a
                // number — so every figure is still withheld.
                //
                //  BUT IT STAYS `READY`. The watermark is set; only the rows are missing, and a row
                // count is not a sync state. Publishing NEVER_SYNCED here would tell a JSON reader
                // that nothing has ever been fetched for an app that has been fetched, and would aim
                // the operator at "run a sync" when a sync has already run and found no subscription
                // payouts. The distinction is carried by `unknown_reason` / `warnings[]`, which say
                // in their own words which of the two this is.
                return resolve(promiseReturnResult(
                    true,
                    _coldPayload(_WARNINGS.noSubscriptionPayouts, _emptyDiagnostics(), COHORT_DATA_STATES.READY),
                    {},
                    'Logo churn resolved.'
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
            // Plan name, trial start and a dated cancellation. It never decides membership — see the
            // file header. Keyed by domain, which is the only join the two sides share.
            const subscriptionByDomain: Map<string, CohortSubscription> = cohortResult.by_domain;

            const floor = _validDate(app.earliest_transaction_at);

            /**
             * The paying set at one instant, or `null` when the stored history cannot support it.
             *
             * ⚠️ THE AS-OF-NOW BOUNDARY IS DELIBERATELY NOT GATED — see the call sites. Every
             * HISTORICAL boundary is, because a truncated lookback under-counts and the resulting
             * "nobody was paying" is indistinguishable from a real one.
             */
            const _setAt = (at: Date): LiveSet | null => {
                if (!isSupportedLedgerBoundary(at, floor, windowMs)) {
                    return null;
                }
                return liveSetAsOf(history, at, windowDays);
            };

            // ⚠️ UNGATED, on purpose. `GET /api/revenue/now` publishes `active_subs` from this exact
            // predicate at this exact instant with no floor test, so gating it here would put a blank
            // tile on one page beside a number on another for the same measurement. The floor is
            // reported through `warnings[]` instead, where it explains both pages at once.
            const setNow = liveSetAsOf(history, asOf, windowDays);
            const at30 = new Date(asOf.getTime() - RECENT_CHURN_WINDOW_DAYS * _DAY_MS);
            const at90 = new Date(asOf.getTime() - WIDE_CHURN_WINDOW_DAYS * _DAY_MS);
            const set30 = _setAt(at30);
            const set90 = _setAt(at90);

            if (!set30 && floor) {
                warnings.push(_WARNINGS.recentWindowUnsupported(RECENT_CHURN_WINDOW_DAYS, floor.toISOString(), windowDays));
            }
            if (!set90 && floor) {
                warnings.push(_WARNINGS.recentWindowUnsupported(WIDE_CHURN_WINDOW_DAYS, floor.toISOString(), windowDays));
            }

            const movement30 = set30 ? foldMembershipMovement({ start_set: set30, end_set: setNow }) : null;
            const movement90 = set90 ? foldMembershipMovement({ start_set: set90, end_set: setNow }) : null;

            const summary: LogoChurnSummary = {
                current_active: setNow.size,
                active_30d_ago: movement30 ? movement30.active_at_start : null,
                active_90d_ago: movement90 ? movement90.active_at_start : null,
                churned_in_30d: movement30 ? movement30.churned : null,
                churned_in_90d: movement90 ? movement90.churned : null,
                gained_in_30d: movement30 ? movement30.gained : null,
                // ⚠️ Straight off the fold, which routes it through `rate()` — `null` for an empty
                // opening base, never `0`. A `0` renders as "0.0%" beside the words "Churn rate": a
                // claim of perfect retention over a period in which nobody was paying at all.
                churn_rate_30d: movement30 ? movement30.churn_rate : null,
                churn_rate_90d: movement90 ? movement90.churn_rate : null,
                active_sub_window_days: windowDays,
                basis: `A shop counts as active when Shopify settled a subscription payout for it within the `
                    + `${windowDays} days before the instant being measured. Membership is evaluated AT AN `
                    + 'INSTANT, never "was billed in this calendar month" — a 30-day biller skips one calendar '
                    + 'month a year, and month-of-charge membership would report every one of them as churned.'
            };

            // ── The monthly series, over shared boundaries ───────────────────
            // ONE evaluation per boundary, and consecutive months SHARE one: month N's closing set IS
            // month N+1's opening set, so `active_at_end === active_at_start + gained - churned` holds
            // along the whole series. Evaluating each month's two boundaries independently would leave
            // a one-millisecond seam between them that nothing reconciles.
            const boundaries: Date[] = buckets.map((bucket) => bucket.start);
            if (buckets.length > 0) {
                boundaries.push(buckets[buckets.length - 1].end);
            }
            const setsAtBoundary: Array<LiveSet | null> = boundaries.map((at) => _setAt(at));

            let unmeasuredMonths = 0;
            const monthlyTrend: LogoChurnMonth[] = buckets.map((bucket, index) => {
                const startSet = setsAtBoundary[index];
                const endSet = setsAtBoundary[index + 1];
                if (!startSet || !endSet) {
                    unmeasuredMonths += 1;
                    return {
                        month: bucket.month,
                        active_at_start: null,
                        active_at_end: null,
                        gained_in_month: null,
                        churned_in_month: null,
                        churn_rate: null,
                        is_partial: bucket.is_partial,
                        measurable: false,
                        unknown_reason: floor
                            ? _MONTH_UNKNOWN_REASON(floor.toISOString(), windowDays)
                            : _WARNINGS.coverageFloorUnknown
                    };
                }
                const movement = foldMembershipMovement({ start_set: startSet, end_set: endSet });
                return {
                    month: bucket.month,
                    active_at_start: movement.active_at_start,
                    active_at_end: movement.active_at_end,
                    gained_in_month: movement.gained,
                    churned_in_month: movement.churned,
                    churn_rate: movement.churn_rate,
                    is_partial: bucket.is_partial,
                    measurable: true,
                    unknown_reason: null
                };
            });

            // ⚠️ `null` — never the all-unmeasured array — when NO month could be measured. The page's
            // `_trendDataState` is built for exactly this: it publishes the tiles and says the trend is
            // unavailable, instead of mounting a titled, axed chart over twelve blank months. An array
            // with SOME measured months stays an array; the blanks inside it break the line, which is
            // the honest rendering at that granularity.
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

            const newest = buckets.length > 0 ? buckets[buckets.length - 1] : null;
            if (newest && newest.is_partial && anyMeasurableMonth) {
                warnings.push(_WARNINGS.partialMonth(newest.month));
            }

            // ── The churned shops behind the 30-day tile ─────────────────────
            let churnedWithoutPlan = 0;
            let churnedFromLedger = 0;
            let churnedWithoutDomain = 0;
            const churnedRows: LogoChurnedShopRow[] = [];

            if (set30 && movement30) {
                for (const key of movement30.churned_keys) {
                    const shop: PayingShop | undefined = set30.get(key);
                    if (!shop) {
                        continue;
                    }
                    const domain = shop.shop_domain || '';
                    if (domain === '') {
                        churnedWithoutDomain += 1;
                    }
                    const subscription = domain !== '' ? subscriptionByDomain.get(domain) : undefined;

                    // `activated_at` is the shop's FIRST settled subscription payout — the ledger's
                    // own answer to "when did they start paying us". Dating this column off the event
                    // stream while `churned_at` came off the ledger is how two dates that must bracket
                    // each other come to cross; `trial_started_at` carries the event-side date under
                    // its own name instead.
                    const activatedAt = firstChargeAt.get(key) || shop.last_charged_at;

                    // THE CHURN DATE, AND WHICH EVIDENCE PRODUCED IT — derived by
                    // `helpers/churnDate.helper`, which is the ONE place either churn endpoint dates
                    // an exit. That file's header carries the whole argument: the two bases, the
                    // interval a dated cancellation has to fall inside before it is accepted, and the
                    // clamp that stopped a churn date being published four days in the future.
                    //
                    // ⚠️ A `partner_event` row inside a table captioned "last 30 days" can therefore
                    // carry a date OLDER than 30 days. The caption describes the MEMBERSHIP window,
                    // not the event: Shopify settles payouts in arrears, so a merchant who uninstalls
                    // on the 10th can have a final payout settle on the 25th, and ledger membership
                    // then runs on for a live window past that.
                    const churn = resolveChurnDate({
                        activated_at: activatedAt,
                        last_charged_at: shop.last_charged_at,
                        // Cadence-aware, so the derived date matches the predicate that decided the
                        // shop had left — an annual biller gets the annual window, not the monthly one.
                        live_window_days: liveWindowDaysFor(shop.billing_interval, windowDays),
                        event_churn_date: subscription ? subscription.churn_date : null,
                        as_of: asOf
                    });
                    const churnedAt: Date = churn.churned_at;
                    const churnBasis: LogoChurnedShopRow['churn_date_basis'] = churn.basis;
                    // ⚠️ Counted HERE rather than inside the helper, which is pure and holds no counters.
                    // The number becomes `ledgerDatedChurns`, the warning that tells a reader those
                    // rows' paid durations are over-estimates.
                    if (churnBasis === CHURN_DATE_BASES.LEDGER_WINDOW) {
                        churnedFromLedger += 1;
                    }

                    const planName = subscription && subscription.plan_name !== ''
                        ? subscription.plan_name
                        : UNKNOWN_PLAN_LABEL;
                    if (planName === UNKNOWN_PLAN_LABEL) {
                        churnedWithoutPlan += 1;
                    }

                    churnedRows.push({
                        shop_id: shop.shop_id,
                        shop_domain: domain,
                        plan_name: planName,
                        activated_at: activatedAt.toISOString(),
                        trial_started_at: subscription ? subscription.trial_start.toISOString() : null,
                        churned_at: churnedAt.toISOString(),
                        churn_date_basis: churnBasis,
                        // ALWAYS a number: the page prints `${r.paid_days} days` with no guard, so a
                        // null renders the literal text "null days".
                        paid_days: wholeDaysBetween(activatedAt, churnedAt),
                        billing_interval: shop.billing_interval
                    });
                }
            }

            // SORT A COPY. `churnedRows` is built fresh above, so nothing is wrong today — it is free
            // to make an in-place sort of an array something else counted impossible rather than true
            // by coincidence. Newest churn first, then by domain so ties are stable between requests.
            const sortedChurned = [...churnedRows].sort((a, b) => {
                if (a.churned_at !== b.churned_at) {
                    // ISO-8601 strings of equal length sort chronologically; reversed for newest first.
                    return b.churned_at.localeCompare(a.churned_at);
                }
                return a.shop_domain.localeCompare(b.shop_domain);
            });
            const recentChurned = sortedChurned.slice(0, RECENT_CHURN_LIMIT);
            const churnedOmitted = sortedChurned.length - recentChurned.length;

            // ── Churn by plan, over the same two boundaries ──────────────────
            // ⚠️ WITHHELD ENTIRELY when the 30-day boundary is unsupported. Every column here is
            // measured against who was paying then; a table of zeros would read as a set of plans
            // nobody left.
            const byPlan: LogoChurnPlanRow[] = [];
            let planUnknownAt30 = 0;
            if (set30) {
                /** plan → {now, then, churned}, accumulated in ONE pass over each set. */
                const planCounts = new Map<string, { now: number; then: number; churned: number }>();
                const _bucketFor = (plan: string): { now: number; then: number; churned: number } => {
                    const existing = planCounts.get(plan);
                    if (existing) {
                        return existing;
                    }
                    const created = { now: 0, then: 0, churned: 0 };
                    planCounts.set(plan, created);
                    return created;
                };

                /**
                 * The plan a domain was on AT `at30`, folded in ONE pass over the app-wide cohort.
                 *
                 *  THE HISTORICAL COLUMN MUST BE IN HISTORICAL TERMS. `subscriptionByDomain` is the
                 * cohort's per-domain WINNER — the subscription with the LATEST `trial_start`, i.e.
                 * the plan the merchant is on TODAY (`chargeCohort.resolver`). Applying it to `set30`
                 * as well restated the whole 30-days-ago plan mix in current-plan terms: a merchant
                 * who moved from Starter to Pro twenty days ago was counted under Pro in
                 * `active_30d_ago`, so Starter's opening base — and therefore its `churn_30d_pct`
                 * denominator — lost a customer it actually had, and Pro's gained one it did not.
                 *
                 * ⚠️ THE FOLD ITSELF NOW LIVES IN `helpers/planMix.helper`, unchanged, because
                 * `GET /api/conversion/plan-mix` partitions the same merchants by the same plans over
                 * the same two boundaries on a card an operator reads beside this table. Its header
                 * carries the rest of this argument; nothing about the numbers here moved.
                 *
                 * `active_now`, `churned_in_30d` and the totals are unaffected either way: they are
                 * set memberships, and only the bucket a shop lands in moves.
                 */
                const planAt30ByDomain = resolvePlanAtInstant({ subscriptions: cohortResult.subscriptions, at: at30 });

                for (const shop of setNow.values()) {
                    _bucketFor(planNameFor(shop.shop_domain, subscriptionByDomain, UNKNOWN_PLAN_LABEL)).now += 1;
                }
                for (const [key, shop] of set30) {
                    const planThen = planNameFor(shop.shop_domain, planAt30ByDomain, UNKNOWN_PLAN_LABEL);
                    if (planThen === UNKNOWN_PLAN_LABEL) {
                        planUnknownAt30 += 1;
                    }
                    const bucket = _bucketFor(planThen);
                    bucket.then += 1;
                    if (!setNow.has(key)) {
                        bucket.churned += 1;
                    }
                }

                for (const [planName, counts] of planCounts) {
                    byPlan.push({
                        plan_name: planName,
                        active_now: counts.now,
                        active_30d_ago: counts.then,
                        churned_in_30d: counts.churned,
                        // ⚠️ `null` — never `0` — when the plan had nobody 30 days ago. That is a plan
                        // nobody could have left, not a plan with perfect retention. Through the
                        // canonical `rate()` rather than a hand-spelled guard, so this and the
                        // app-wide figure in `logoChurn.helper` cannot drift apart.
                        churn_30d_pct: rate(counts.churned, counts.then)
                    });
                }
                // Biggest current base first, then by name so two plans that tie order the same way on
                // every request — on screen, a reshuffle between refreshes reads as the data changing.
                byPlan.sort((a, b) => (b.active_now - a.active_now) || a.plan_name.localeCompare(b.plan_name));
            } else {
                warnings.push(_WARNINGS.planTableWithheld);
            }

            // ── Everything approximated or excluded, said out loud ───────────
            if (churnedWithoutDomain > 0) {
                warnings.push(_WARNINGS.shoplessChurnedShops(churnedWithoutDomain));
            }
            if (churnedWithoutPlan > 0) {
                warnings.push(_WARNINGS.plansUnknown(churnedWithoutPlan));
            }
            if (planUnknownAt30 > 0) {
                warnings.push(_WARNINGS.plansUnknownAt30(planUnknownAt30, RECENT_CHURN_WINDOW_DAYS));
            }
            if (churnedFromLedger > 0) {
                warnings.push(_WARNINGS.ledgerDatedChurns(churnedFromLedger));
            }
            if (churnedOmitted > 0) {
                warnings.push(_WARNINGS.churnListTruncated(recentChurned.length, sortedChurned.length));
            }
            warnings.push(..._coverageWarnings(app));

            const diagnostics: LogoChurnDiagnostics = {
                subscription_charge_rows: history.length,
                shops_with_subscription_payouts: shopIds.size,
                churned_shops_without_plan: churnedWithoutPlan,
                churned_shops_dated_from_ledger: churnedFromLedger,
                churned_shops_without_domain: churnedWithoutDomain,
                unmeasured_months: unmeasuredMonths,
                churned_shops_omitted: churnedOmitted,
                earliest_transaction_at: _iso(app.earliest_transaction_at)
            };

            const payload: LogoChurnResponse = {
                ..._envelope,
                summary,
                monthly_trend: trendUnknownReason === null ? monthlyTrend : null,
                trend_unknown_reason: trendUnknownReason,
                by_plan: byPlan,
                recent_churned: recentChurned,
                recent_churned_truncated: churnedOmitted > 0,
                warnings: [...new Set(warnings)],
                diagnostics,
                data_state: COHORT_DATA_STATES.READY
            };

            // ⚠️ A 200 with an empty churn list, always. "Nobody left in the last 30 days" is the best
            // possible answer and an ordinary one; it is separated from "we have not looked" by
            // `data_state` and from "we cannot see that far back" by `measurable` / `warnings[]` —
            // never by a refusal.
            return resolve(promiseReturnResult(true, payload, {}, 'Logo churn resolved.'));
        } catch (error) {
            customConsoleError('ERROR: Conversion logoChurnService getLogoChurn', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read logo churn. Please try again.'));
        }
    });
};

export = {
    getLogoChurn
};
