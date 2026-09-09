'use strict';

/**
 * ============================================================================
 *  PLAN MIX — WHO IS ON WHAT, WHAT IT IS WORTH, AND WHO LEFT EACH PLAN
 * ============================================================================
 *
 *  Serves `GET /api/conversion/plan-mix` — the two donuts and the per-plan churn table at the bottom
 *  of the Conversion analysis tab.
 *
 *  ──  MEMBERSHIP COMES THROUGH `liveSetAsOf`, AND THERE IS NO SECOND PREDICATE HERE ───────
 *
 *  "Shop S is paying as of D" is defined ONCE, in `modules/revenue/helpers/ledgerMrr.helper`. Every
 *  count and every amount below is a fold over two evaluations of it. This file never asks whether a
 *  subscription is `PAYING`, never tests an amount, and never filters on "was billed in this month".
 *
 *  That matters more here than on either churn page, because this is the card that carries MONEY:
 *  `total_mrr_amount` sits under a donut on the Conversion page while `summary.current_mrr` sits at
 *  the top of the Revenue page, and both claim to describe the same subscribers. A second predicate
 *  would make them disagree with nothing on either screen to say which was right — which is the exact
 *  divergence `modules/revenue/index.ts` publishes its ledger to prevent.
 *
 *  ⚠️ REACHED BY DEEP PATH, NOT THROUGH `require('../../revenue')`. That barrel loads every revenue
 *  service, each of which reaches the model registry, and the import graph closes a cycle:
 *  `revenue/index → revenue.repository → conversion/constants → …`. The failure is silent at
 *  typecheck AND at lint — `liveSetAsOf` simply destructures as `undefined` at load and every call
 *  throws. `modules/revenue/repositories/revenue.repository.ts:20-45` records that exact incident and
 *  the fifteen tests it broke. `helpers/ledgerMrr.helper` is PURE and `repositories/revenue.repository`
 *  imports only the model chokepoint and a constants file, so neither can close a loop.
 *
 *  ──  AND THE PLAN FOLD IS SHARED WITH LOGO CHURN, FOR THE SAME REASON ────────────────────
 *
 *  `helpers/planMix.helper` decides which plan a merchant was on at an instant, and `logo-churn` uses
 *  it too. Its header carries the whole argument: applying TODAY's plan to a 30-days-ago membership
 *  set restates the opening base in current-plan terms, so a merchant who upgraded twenty days ago is
 *  subtracted from the plan they actually left and added to one they never churned from. Both plans
 *  then publish a wrong churn rate, in opposite directions, and both look plausible.
 *
 *  ── MONEY, WHERE LOGO CHURN DELIBERATELY CARRIES NONE ──────────────────────────────────────
 *
 *  Logo churn publishes no amount anywhere on purpose. Plan mix is the view where the gap between
 *  subscriber share and MRR share IS the subject — a plan with many subscribers and little MRR is a
 *  different business from the reverse, and `PlanMixDonut` draws both distributions side by side so
 *  the comparison needs no clicking. The amounts come from `PayingShop.monthly_amount`, the ledger's
 *  own normalised figure (an ANNUAL charge divided by twelve), never from a price parsed out of a
 *  charge payload.
 *
 *  ── The discriminator is the WATERMARK, never the row count ────────────────────────────────
 *
 *  A synced app with an empty `APP_SUBSCRIPTION` ledger stays READY and explains itself through
 *  `warnings[]`. Only a null `last_synced_at` is NEVER_SYNCED — `subscriptionList.constants` forbids
 *  the substitution by name ("a row count in disguise"), and `logoChurn.service` handles the identical
 *  pair of branches the same way.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
//  DEEP PATHS INTO `modules/revenue`, never its barrel — see the file header for the cycle and the
// fifteen tests it broke. One is a PURE helper (the predicate) and one is a repository (the read);
// neither has an edge back into this module.
import ledgerMrrHelper = require('../../revenue/helpers/ledgerMrr.helper');
import revenueRepository = require('../../revenue/repositories/revenue.repository');
import planMixConstants = require('../constants/planMix.constants');
import funnelMathHelper = require('../helpers/funnelMath.helper');
import ledgerBoundaryHelper = require('../helpers/ledgerBoundary.helper');
import planMixHelper = require('../helpers/planMix.helper');
import subscriptionCohortResolver = require('../resolvers/subscriptionCohort.resolver');
import installCohortRepository = require('../repositories/installCohort.repository');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { LiveSet } from '../../revenue/types/ledgerMrr.types';
import type {
    PlanMixDiagnostics,
    PlanMixParams,
    PlanMixResponse,
    PlanMixRow
} from '../types/planMix.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
//  THE ONE DEFINITION OF "PAYING" IN THIS CODEBASE. See the file header.
const { liveSetAsOf } = ledgerMrrHelper;
const { fetchSubscriptionChargeHistory } = revenueRepository;
// THE ONE DIVISION. `null` for an empty denominator, never `0` — a `0` beside "Churn rate" is a
// claim of perfect retention over a plan nobody was on.
const { rate } = funnelMathHelper;
const { isSupportedLedgerBoundary } = ledgerBoundaryHelper;
const { resolvePlanAtInstant, planNameFor } = planMixHelper;
const { resolveSubscriptionCohortAsOf } = subscriptionCohortResolver;
// The module's ONE app read — see `installCohort.repository`.
const { findPartnerAppById } = installCohortRepository;
const {
    PLAN_MIX_UNKNOWN_PLAN_LABEL,
    PLAN_MIX_ROW_LIMIT,
    PLAN_MIX_CHURN_WINDOW_DAYS,
    PLAN_MIX_DATA_STATES
} = planMixConstants;

/** Milliseconds in a day. Local, because the one offset this file needs is a boundary. */
const _DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ⚠️ THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * The page renders one entry per warning KEYED BY THE STRING ITSELF, so a duplicate is not drawn
 * twice — it is DROPPED, silently, along with its condition.
 */
const _WARNINGS = Object.freeze({
    neverSynced: 'No Partner sync has completed for this app yet, so no settled payouts have been fetched '
        + 'and there is no paying base to break down by plan. Every figure is withheld rather than shown as '
        + 'zero — we have not looked, which is not the same as having no subscribers.',

    noSubscriptionPayouts: 'No settled subscription payouts have ever been synced for this app, so there is '
        + 'no paying base to break down by plan. One-time and usage charges are deliberately excluded — a '
        + 'store that bought a single add-on is not a subscriber, and counting it here would put a merchant '
        + 'in a donut of recurring revenue on the strength of a single purchase.',

    churnBoundaryUnsupported: (days: number, floor: string, windowDays: number): string => `The ${days}-day `
        + `churn columns cannot be measured. Deciding who was paying ${days} days ago needs the ${windowDays} `
        + `days of payout history before that date, and the stored history begins at ${floor}. "Churned ${days}d" `
        + 'and "Churn rate" are left blank rather than filled with zeros, which would report that nobody left '
        + 'any plan over a period we cannot see. The subscriber and MRR donuts above are unaffected — they are '
        + 'measured at this instant, which needs no history before it.',

    plansUnknown: (shops: number, label: string): string => `${shops} paying subscriber(s) could not be matched `
        + `to a subscription, so they are grouped under "${label}" rather than guessed into a plan. That happens `
        + 'when the charge events for a shop were never synced, or when its payouts carry no domain to join on — '
        + 'never because the merchant had no plan. Run the Partner API full re-sync (lifetime) from the Sync '
        + 'page to backfill the charge payloads their plan names live on.',

    plansUnknownAt30: (shops: number, days: number, label: string): string => `${shops} subscriber(s) who were `
        + `paying ${days} days ago have no subscription on record from that date, so the churn columns file them `
        + `under "${label}" rather than under the plan they are on now. That column is deliberately measured in `
        + 'the plans merchants held THEN — a merchant who has since switched belongs to their old plan\'s '
        + 'opening base, not their new one\'s.',

    /**
     *  NO CURRENCY CONVERSION EXISTS ANYWHERE IN THIS BUILD, and the MRR donut sums across whatever
     * currencies are present. That is a real defect in the figure, not a rounding caveat, and it has
     * to be said out loud rather than left for a reader to notice that two plans are labelled with
     * different currency codes.
     */
    mixedCurrencies: (count: number, currencies: string): string => `Your subscribers pay in ${count} different `
        + `currencies (${currencies}) and nothing in this build converts between them. The MRR donut and the `
        + 'per-plan MRR column ADD those amounts together as if they were one currency, so both are wrong by '
        + 'whatever the exchange rates are. The subscriber donut and every count on this card are unaffected — '
        + 'they count merchants, not money.',

    plansTruncated: (shown: number, total: number): string => `This app has ${total} distinct plans and the `
        + `table below shows the ${shown} largest by current subscribers. The totals above are measured over ALL `
        + 'subscribers, so they will not equal the sum of the rows you can see.',

    lifetimeFloor: 'No lifetime Partner sync has ever completed for this app, so the stored payouts are '
        + 'whatever the incremental sync windows happened to pull. The paying base below is a floor rather '
        + 'than a total, and the churn columns most of all — a merchant whose payouts were never fetched '
        + 'cannot appear in either boundary.',

    coverageFloorUnknown: 'No payout coverage floor has ever been measured for this app, so nothing here can '
        + 'say how far back the stored payout history actually reaches. The churn columns are published on the '
        + 'assumption that it reaches far enough; there is no way to tell from the stored data whether it does.'
});

/** The sentence published beside the numbers, so a reader never has to infer what "paying" means. */
const _MEMBERSHIP_BASIS = (windowDays: number): string => 'A shop counts as an active subscriber when Shopify '
    + `settled a subscription payout for it within the ${windowDays} days before the instant being measured. `
    + 'Membership is evaluated AT AN INSTANT, never "was billed in this calendar month" — a 30-day biller skips '
    + 'one calendar month a year, and month-of-charge membership would report every one of them as churned. '
    + 'This is the same predicate the Revenue page\'s MRR and the Logo Churn page\'s customer counts are built '
    + 'from, so the three cannot disagree about who is paying.';

/** An ISO string, or null. */
const _iso = (value?: Date | null): string | null => {
    if (!value) {
        return null;
    }
    return value.toISOString();
};

/** A `Date` only when it genuinely is one and genuinely valid. */
const _validDate = (value: unknown): Date | null => {
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
};

/**
 * Which coverage gates make the stored payout history incomplete.
 *
 * ⚠️ THE MONEY GATES, NEVER THE EVENT ONES. `models/partner/partnerApp.model.ts:122` keeps
 * `earliest_transaction_at` and `earliest_event_at` apart precisely so "a revenue figure cannot borrow
 * the events' coverage" — payouts settle later than the charge events that earned them, and a
 * lifetime sync of one can succeed while the other fails. Membership here is built from payouts.
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

/** One plan mid-fold. Currencies are tallied rather than overwritten — see the fold. */
interface _PlanBucket {
    active_now: number;
    mrr_amount: number;
    then: number;
    churned: number;
    currencies: Map<string, number>;
}

/**
 * The plan-mix snapshot and its 30-day churn.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query, already cast (not coerced) by the controller.
 * @param params1.partner_app_id - The app to report on. Required.
 * @returns The mix, or an honest refusal carrying `{}`.
 */
const getPlanMix = (
    { user_id }: IdentityObject,
    { partner_app_id }: PlanMixParams
): Promise<ServiceResult<PlanMixResponse | EmptyPayload>> => {
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
            // below. A second `new Date()` further down would let the donut and the churn columns
            // describe two different instants.
            const asOf = new Date();
            const appId = String(app._id);
            const windowDays = config.REVENUE.ACTIVE_SUB_WINDOW_DAYS;
            const windowMs = windowDays * _DAY_MS;
            const warnings: string[] = [];

            const _envelope = {
                app_id: appId,
                app_name: app.display_name,
                as_of: asOf.toISOString(),
                active_sub_window_days: windowDays,
                churn_window_days: PLAN_MIX_CHURN_WINDOW_DAYS,
                membership_basis: _MEMBERSHIP_BASIS(windowDays),
                //  PUBLISHED so a client need not hard-code the literal the way `PlanMixDonut`
                // currently does. `constants/planMix.constants` carries the argument; this key is
                // what makes fixing the frontend a one-line change rather than a negotiation.
                unknown_plan_label: PLAN_MIX_UNKNOWN_PLAN_LABEL,
                currency: ''
            };

            const _emptyDiagnostics = (): PlanMixDiagnostics => ({
                subscription_charge_rows: 0,
                shops_with_subscription_payouts: 0,
                plans_omitted: 0,
                plans_unknown_at_30d: 0,
                earliest_transaction_at: _iso(app.earliest_transaction_at)
            });

            /**
             * The payload both "nothing to break down" branches publish, so the two cannot drift.
             *
             *  `data_state` IS A PARAMETER, NOT A CONSTANT. The two branches answer different
             * questions and only ONE of them is `NEVER_SYNCED`; hard-coding it would make a synced app
             * with an empty subscription ledger report "no Partner sync has completed" — a data_state
             * decided by a ROW COUNT, which `subscriptionList.constants` forbids by name.
             *
             * @param reason - The sentence the banner prints and `warnings[]` carries.
             * @param dataState - READY or NEVER_SYNCED, decided by the WATERMARK.
             * @returns The payload.
             */
            const _coldPayload = (reason: string, dataState: PlanMixResponse['data_state']): PlanMixResponse => ({
                ..._envelope,
                // ⚠️ `null`, NOT `[]` and NOT zeros. `PlanMixDonut.js:42` reads
                // `typeof data.total_active_now === 'number'` and would render "No active paid
                // subscribers found yet" — a checkable claim about the business — over a payload that
                // measured nothing.
                plans: null,
                total_active_now: null,
                total_mrr_amount: null,
                payload_health: null,
                diagnostics: _emptyDiagnostics(),
                warnings: [...new Set([reason, ...warnings])],
                data_state: dataState,
                // The banner's body. Without it `dataState.js` falls back to `resp.msg` and prints the
                // SUCCESS message under the heading "Nothing synced yet".
                unknown_reason: reason
            });

            // ── THE WATERMARK, NEVER THE ROW COUNT ───────────────────────────
            if (!app.last_synced_at) {
                return resolve(promiseReturnResult(
                    true,
                    _coldPayload(_WARNINGS.neverSynced, PLAN_MIX_DATA_STATES.NEVER_SYNCED),
                    {},
                    'Plan mix resolved.'
                ));
            }

            // ── ONE ledger read, plus the cohort that supplies the LABELS ────
            const [history, cohortResult] = await Promise.all([
                fetchSubscriptionChargeHistory({ partner_app_id: appId }),
                resolveSubscriptionCohortAsOf({ partner_app_id: appId, as_of: asOf })
            ]);

            if (history.length === 0) {
                // A Partner sync HAS completed and the subscription ledger is empty.
                //
                //  IT STAYS `READY`. The watermark is set; only the rows are missing, and a row count
                // is not a sync state. Publishing NEVER_SYNCED here would tell a JSON reader that
                // nothing has ever been fetched for an app that has been, and would aim the operator at
                // "run a sync" when a sync has already run and found no subscription payouts.
                return resolve(promiseReturnResult(
                    true,
                    _coldPayload(_WARNINGS.noSubscriptionPayouts, PLAN_MIX_DATA_STATES.READY),
                    {},
                    'Plan mix resolved.'
                ));
            }

            // ⚠️ `history` IS NOT SORTED HERE. `fetchSubscriptionChargeHistory` returns NEWEST FIRST
            // and `liveSetAsOf` depends on that order to accept the first row it sees per shop.
            // Re-ordering it — even into a copy that is then passed on — would silently change every
            // membership answer below.
            const shopIds = new Set<string>();
            for (const row of history) {
                shopIds.add(row.shop_id);
            }

            const floor = _validDate(app.earliest_transaction_at);
            const at30 = new Date(asOf.getTime() - PLAN_MIX_CHURN_WINDOW_DAYS * _DAY_MS);

            // ⚠️ THE AS-OF-NOW BOUNDARY IS DELIBERATELY NOT GATED. `GET /api/revenue/now` publishes
            // `active_subs` from this exact predicate at this exact instant with no floor test, so
            // gating it would put a blank donut on one page beside a number on another for the same
            // measurement. The floor is reported through `warnings[]`, where it explains both at once.
            const setNow: LiveSet = liveSetAsOf(history, asOf, windowDays);
            // The HISTORICAL boundary IS gated: a truncated lookback under-counts the opening base,
            // and an under-counted base makes the same departures read as a far higher churn rate.
            const set30: LiveSet | null = isSupportedLedgerBoundary(at30, floor, windowMs)
                ? liveSetAsOf(history, at30, windowDays)
                : null;

            if (!set30 && floor) {
                warnings.push(_WARNINGS.churnBoundaryUnsupported(PLAN_MIX_CHURN_WINDOW_DAYS, floor.toISOString(), windowDays));
            }

            // ── The two plan maps, one per boundary ─────────────────────────
            //  TODAY'S winner for today's donut; the HISTORICAL winner for the churn columns. See
            // `helpers/planMix.helper` for what applying one to the other does to a churn rate.
            const planNow = cohortResult.by_domain;
            const planThen = resolvePlanAtInstant({ subscriptions: cohortResult.subscriptions, at: at30 });

            /** plan → its counts, its money and its currencies. One bucket per plan, created on first use. */
            const buckets = new Map<string, _PlanBucket>();
            const _bucketFor = (plan: string): _PlanBucket => {
                const existing = buckets.get(plan);
                if (existing) {
                    return existing;
                }
                const created: _PlanBucket = {
                    active_now: 0,
                    mrr_amount: 0,
                    then: 0,
                    churned: 0,
                    currencies: new Map<string, number>()
                };
                buckets.set(plan, created);
                return created;
            };

            // ── ONE pass over the current set: counts, money and currencies ──
            let unknownPlanSubscribers = 0;
            let totalMrr = 0;
            const currencyTally = new Map<string, number>();
            for (const shop of setNow.values()) {
                const plan = planNameFor(shop.shop_domain, planNow, PLAN_MIX_UNKNOWN_PLAN_LABEL);
                if (plan === PLAN_MIX_UNKNOWN_PLAN_LABEL) {
                    unknownPlanSubscribers += 1;
                }
                const bucket = _bucketFor(plan);
                bucket.active_now += 1;
                //  `monthly_amount`, the LEDGER's normalised figure — an ANNUAL charge divided by
                // twelve. Never `charged_amount`, which would book a year of revenue as a month of
                // run-rate and overstate an annual subscriber twelvefold.
                bucket.mrr_amount += shop.monthly_amount;
                totalMrr += shop.monthly_amount;
                const currency = shop.currency || '';
                if (currency !== '') {
                    bucket.currencies.set(currency, (bucket.currencies.get(currency) || 0) + 1);
                    currencyTally.set(currency, (currencyTally.get(currency) || 0) + 1);
                }
            }

            // ── ONE pass over the 30-days-ago set: the churn denominator ─────
            let plansUnknownAt30 = 0;
            if (set30) {
                for (const [key, shop] of set30) {
                    const plan = planNameFor(shop.shop_domain, planThen, PLAN_MIX_UNKNOWN_PLAN_LABEL);
                    if (plan === PLAN_MIX_UNKNOWN_PLAN_LABEL) {
                        plansUnknownAt30 += 1;
                    }
                    const bucket = _bucketFor(plan);
                    bucket.then += 1;
                    if (!setNow.has(key)) {
                        bucket.churned += 1;
                    }
                }
            }

            /**
             * The currency a plan's amounts are IN — the one the most of its members were billed in.
             *
             * ⚠️ NOT a conversion and not a claim that they agree. When a plan spans currencies its
             * `mrr_amount` is a sum of incommensurable numbers, and the `mixedCurrencies` warning says
             * so app-wide. Publishing the majority currency is better than publishing a blank (which
             * renders as a bare number with no unit) or the first one seen (which is whichever order
             * the set happened to iterate in).
             *
             * @param tally - Currency → how many members were billed in it.
             * @returns The most common currency, or `''` when none was recorded.
             */
            const _dominantCurrency = (tally: Map<string, number>): string => {
                let best = '';
                let bestCount = 0;
                for (const [currency, count] of tally) {
                    // `>` and not `>=`, plus a lexical tie-break, so two currencies with equal counts
                    // resolve the same way on every request — a label that reshuffles between
                    // refreshes reads on screen as the data changing.
                    if (count > bestCount || (count === bestCount && currency.localeCompare(best) < 0)) {
                        best = currency;
                        bestCount = count;
                    }
                }
                return best;
            };

            const allRows: PlanMixRow[] = [];
            for (const [planName, bucket] of buckets) {
                allRows.push({
                    plan_name: planName,
                    active_now: bucket.active_now,
                    // ⚠️ `null` — never `0` — for every churn figure when the boundary is unsupported.
                    // A `0` renders as "0 churned, 0.0%": a claim of perfect retention over a period
                    // the stored history cannot see.
                    active_30d_ago: set30 ? bucket.then : null,
                    churned_in_30d: set30 ? bucket.churned : null,
                    //  Through the canonical `rate()`, so a plan nobody was on 30 days ago answers
                    // `null` rather than `0` — and so this and the app-wide churn rate on the Logo
                    // Churn page cannot drift apart.
                    churn_30d_pct: set30 ? rate(bucket.churned, bucket.then) : null,
                    mrr_amount: bucket.mrr_amount,
                    //  The same guarded division: an empty plan answers `null`, which the page
                    // renders as an em dash rather than as "0.00" beside "Avg price".
                    avg_amount: rate(bucket.mrr_amount, bucket.active_now),
                    currency: _dominantCurrency(bucket.currencies)
                });
            }

            // Biggest current base first, then by MRR, then by name — so two plans that tie order the
            // same way on every request. SORTED IN PLACE is safe: `allRows` was built fresh above and
            // nothing else holds a reference to it.
            allRows.sort((a, b) => (b.active_now - a.active_now)
                || (b.mrr_amount - a.mrr_amount)
                || a.plan_name.localeCompare(b.plan_name));

            const plans = allRows.slice(0, PLAN_MIX_ROW_LIMIT);
            const plansOmitted = allRows.length - plans.length;
            if (plansOmitted > 0) {
                warnings.push(_WARNINGS.plansTruncated(plans.length, allRows.length));
            }

            // ── Everything approximated or excluded, said out loud ───────────
            if (unknownPlanSubscribers > 0) {
                warnings.push(_WARNINGS.plansUnknown(unknownPlanSubscribers, PLAN_MIX_UNKNOWN_PLAN_LABEL));
            }
            if (plansUnknownAt30 > 0) {
                warnings.push(_WARNINGS.plansUnknownAt30(plansUnknownAt30, PLAN_MIX_CHURN_WINDOW_DAYS, PLAN_MIX_UNKNOWN_PLAN_LABEL));
            }
            if (currencyTally.size > 1) {
                warnings.push(_WARNINGS.mixedCurrencies(currencyTally.size, [...currencyTally.keys()].sort().join(', ')));
            }
            warnings.push(..._coverageWarnings(app));

            const payload: PlanMixResponse = {
                ..._envelope,
                //  The dominant currency ACROSS the whole paying base. `PlanMixDonut.js:64` reads
                // `plans[0].currency` for the MRR subtitle rather than this key; both are published so
                // a JSON reader is not left inferring one from a single row.
                currency: _dominantCurrency(currencyTally),
                plans,
                //  MEASURED OVER THE WHOLE SET, not over the published rows. When the table is
                // truncated the totals will not equal the sum of the visible rows, and the
                // `plansTruncated` warning says so — a total silently narrowed to what fits on screen
                // is worse than one that visibly does not add up.
                total_active_now: setNow.size,
                total_mrr_amount: totalMrr,
                payload_health: {
                    // ⚠️ SUBSCRIBERS, not plans, despite the frontend's field name — `PlanMixDonut.js:78`
                    // prints it as "N subscribers grouped under …". See the type's own note.
                    plans_without_charge_payload: unknownPlanSubscribers,
                    distinct_currencies: currencyTally.size
                },
                diagnostics: {
                    subscription_charge_rows: history.length,
                    shops_with_subscription_payouts: shopIds.size,
                    plans_omitted: plansOmitted,
                    plans_unknown_at_30d: plansUnknownAt30,
                    earliest_transaction_at: _iso(app.earliest_transaction_at)
                },
                // ⚠️ De-duplicated because the page keys each warning by the string itself, so a
                // repeat is not drawn twice — it is DROPPED, along with its condition.
                warnings: [...new Set(warnings)],
                data_state: PLAN_MIX_DATA_STATES.READY
            };

            // ⚠️ A 200 with an empty plan list, always. "Nobody is paying right now" is an ordinary
            // answer once a sync has run, separated from "we have not looked" by `data_state` and from
            // "we cannot see that far back" by `warnings[]` — never by a refusal.
            return resolve(promiseReturnResult(true, payload, {}, 'Plan mix resolved.'));
        } catch (error) {
            customConsoleError('ERROR: Conversion planMixService getPlanMix', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read the plan mix. Please try again.'));
        }
    });
};

export = {
    getPlanMix
};
