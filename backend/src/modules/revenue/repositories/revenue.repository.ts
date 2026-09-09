'use strict';

/**
 * Model access for the revenue module — the only file here that reads a collection.
 *
 * WHY THE SERVICE DOES NOT DO THIS ITSELF. `repositories/` is the single layer allowed to touch
 * the model registry, and the ESLint layer guard enforces it rather than trusting anyone to
 * remember: `no-restricted-syntax` refuses a model-registry import from any file outside a
 * `repositories/` folder, in both the `require()` and `import … = require()` forms. So the boundary
 * is not a style preference — a query written in the service is a build failure.
 *
 * The other half of the value is that every raw aggregate row is normalised HERE, into the declared
 * shapes in `../types/revenueNow.types`. `Model.aggregate()` returns `any[]`, and an `any` that
 * escapes into a service takes every downstream field access with it — a renamed accumulator then
 * becomes a column of `undefined` on the dashboard rather than a compile error. Flattening at the
 * boundary is what keeps the service's types meaningful.
 */

import models = require('../../shared/repositories/models.repository');
import growthIntelConstants = require('../../shared/constants/growthIntel.constants');
//  DEEP PATH TO A PURE CONSTANTS FILE, NOT THROUGH `modules/conversion`'s BARREL — and the
// exception to "other modules by their barrel" is deliberate, because the barrel form was tried and
// broke the build.
//
// The need is real and unchanged: this repository wants the `$in` list of every subscription START
// and END event type, and restating those strings here would be a second vocabulary that silently
// stops fetching a type the day one is added to the first.
//
// But `import conversion = require('../../conversion')` creates a CYCLE:
//     revenue/index → services/revenueNow.service → repositories/revenue.repository
//       → conversion/index → services/logoChurn.service → revenue/index  (still initialising)
// so `logoChurn.service` destructured `liveSetAsOf`, `liveWindowDaysFor` and `diffMonths` as
// `undefined` at load, every call threw, `getLogoChurn` resolved `status:false`, and 15 tests failed.
// Node reports it only as `Warning: Accessing non-existent property … inside circular dependency`,
// which is easy to scroll past — the visible symptom is a service that returns "could not read".
//
// `constants/lifecycle.constants` imports only `src/constants/partnerVocab.constants`, so it has no
// edge back to this module and cannot close a loop. `modules/conversion/index.ts`'s own header names
// this exact hazard: a barrel import "eagerly loads the whole module … and is the easiest way to
// invent a cycle between two files that have no edge between them at all."
//
// The vocabulary is ultimately `PARTNER_EVENT_TYPES` from `src/constants/`, which is where a
// genuinely cross-module list belongs; promoting these three lists there would remove the
// cross-module import altogether and is the better long-term fix.
import lifecycleConstants = require('../../conversion/constants/lifecycle.constants');
import ledgerMrrHelper = require('../helpers/ledgerMrr.helper');
import type {
    FetchCurrentPayingShopsInput,
    FetchMonthlyLiveSetsInput,
    FetchSubscriptionChargeHistoryInput,
    LiveSet,
    PayingShop,
    SubscriptionChargeRow
} from '../types/ledgerMrr.types';
import type {
    FindPartnerAppInput,
    GetLifetimeCashInput,
    GetTopShopsInput,
    LifetimeCashTotals,
    PartnerAppRecord,
    RevenueTopShopRow
} from '../types/revenueNow.types';
import type { PartnerAppEventDoc } from '../../shared/types/entity.types';
import type {
    MonthlyCashRow,
    RevenueAsOfQuery,
    RevenueWindowQuery,
    SettledSubscriptionEvidence,
    WindowCashTotals
} from '../types/revenueOverview.types';

const { PartnerAppModel, PartnerAppEventModel, PartnerAppTransactionModel, toObjectId } = models;
const { PARTNER_TRANSACTION_TYPES } = growthIntelConstants;
const { CHARGE_COHORT_EVENT_TYPES } = lifecycleConstants;
const { liveSetAsOf } = ledgerMrrHelper;

/** `YYYY-MM`, UTC — the key each monthly live set is filed under. */
const _monthKey = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * Reads a numeric accumulator off a raw aggregate row.
 *
 * Tests the TYPE rather than truthiness on purpose: `|| fallback` maps a genuine `0` onto the
 * fallback, which is the falsy-default round-trip that turns a real "nothing was charged" into a
 * default someone later changes to something else entirely.
 *
 * @param value - The raw accumulator value.
 * @param [fallback] - Used when the field is absent or not a finite number.
 * @returns The value, or the fallback.
 */
const _num = (value: unknown, fallback: number = 0): number => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    return fallback;
};

/**
 * Reads a date accumulator off a raw aggregate row, as `null` when absent.
 *
 * `null` rather than `undefined` because these travel to the wire, where an absent key and an
 * explicit null are read differently by most clients.
 *
 * @param value - The raw accumulator value.
 * @returns The date, or null.
 */
const _date = (value: unknown): Date | null => {
    if (value instanceof Date) {
        return value;
    }
    return null;
};

/**
 * Loads the app being reported on, including its coverage gates.
 *
 * @param params0 - The parameters object.
 * @param params0.partner_app_id - Mongo `_id` of the `gi_partner_app`.
 * @returns The app record, or null when no such app exists.
 */
const findPartnerAppById = async ({ partner_app_id }: FindPartnerAppInput): Promise<PartnerAppRecord | null> => {
    // `findById` auto-casts a string id, unlike the aggregates below — no explicit cast needed.
    return PartnerAppModel.findById(partner_app_id).lean();
};

/**
 * All-time settled cash for one app, plus how much of the ledger is subscription revenue.
 *
 * The subscription count rides along as a fourth accumulator rather than a second query: it costs
 * one `$cond` on a scan that is already happening, and it is what lets the caller distinguish "this
 * app has no recurring revenue" from "no subscription charge has ever been synced" — which look
 * identical in a total and mean opposite things.
 *
 *  Returns `null`, NOT a zeroed row, when the ledger holds nothing for this app. `$group` emits no
 * document when nothing matched, and that absence is the one authoritative signal that there is no
 * data. Manufacturing `{ total_gross: 0, … }` here would erase it, and the caller could then only
 * publish `0` — a claim that the business earned nothing, rather than a statement that we have not
 * synced anything.
 *
 * @param params0 - The parameters object.
 * @param params0.partner_app_id - Mongo `_id` of the `gi_partner_app`.
 * @returns The totals, or null when the app has no settled payouts at all.
 */
const getLifetimeCashTotals = async ({ partner_app_id }: GetLifetimeCashInput): Promise<LifetimeCashTotals | null> => {
    const rows = await PartnerAppTransactionModel.aggregate([
        //  Cast REQUIRED. An aggregate `$match` does not auto-cast the way `find` does, so an
        // uncast string id matches zero documents and returns `[]` with no error — which this
        // function would report as an empty ledger and the caller would publish as a page of
        // perfectly honest-looking "no data yet" envelopes. A wrong answer wearing the right clothes.
        { $match: { partner_app_id: toObjectId(partner_app_id) } },
        {
            $group: {
                _id: null,
                total_gross: { $sum: '$gross_amount.amount' },
                total_net: { $sum: '$net_amount.amount' },
                total_fee: { $sum: '$shopify_fee.amount' },
                tx_count: { $sum: 1 },
                subscription_tx_count: {
                    $sum: {
                        $cond: [{ $eq: ['$type', PARTNER_TRANSACTION_TYPES.APP_SUBSCRIPTION] }, 1, 0]
                    }
                }
            }
        }
    ]);

    const row = rows[0];
    if (!row) {
        return null;
    }
    return {
        total_gross: _num(row.total_gross),
        total_net: _num(row.total_net),
        total_fee: _num(row.total_fee),
        tx_count: _num(row.tx_count),
        subscription_tx_count: _num(row.subscription_tx_count)
    };
};

/**
 * The highest-earning shops for one app, ranked by lifetime NET cash.
 *
 * Net rather than gross because net is what actually reached the bank; gross is what the merchant
 * was charged, before Shopify's cut comes out of it.
 *
 * ⚠️ LIFETIME and unwindowed by construction. Callers publish that basis on the payload, because a
 * ranking sitting beside as-of figures is exactly the row a reader assumes shares their window.
 *
 * @param params0 - The parameters object.
 * @param params0.partner_app_id - Mongo `_id` of the `gi_partner_app`.
 * @param params0.limit - How many shops to return.
 * @returns The ranked shops, highest lifetime net first. Empty when none qualify.
 */
const getTopShopsByLifetimeNet = async ({ partner_app_id, limit }: GetTopShopsInput): Promise<RevenueTopShopRow[]> => {
    const rows = await PartnerAppTransactionModel.aggregate([
        {
            $match: {
                partner_app_id: toObjectId(partner_app_id),
                // `$ne: ''` and not `$exists`: the schema defaults `shop_id` to `''`, so a payout
                // whose shop is unknown is stored as empty rather than absent and every row has the
                // key. Grouping that bucket would rank one giant phantom shop above every real one.
                shop_id: { $ne: '' }
            }
        },
        {
            $group: {
                _id: { shop_id: '$shop_id', shop_domain: '$shop_domain' },
                lifetime_net: { $sum: '$net_amount.amount' },
                lifetime_gross: { $sum: '$gross_amount.amount' },
                first_tx_at: { $min: '$created_at' },
                last_tx_at: { $max: '$created_at' },
                tx_count: { $sum: 1 }
            }
        },
        { $sort: { lifetime_net: -1 } },
        { $limit: limit }
    ]);

    return rows.map((row) => {
        return {
            shop_id: String(row._id.shop_id || ''),
            shop_domain: String(row._id.shop_domain || ''),
            lifetime_net: _num(row.lifetime_net),
            lifetime_gross: _num(row.lifetime_gross),
            first_tx_at: _date(row.first_tx_at),
            last_tx_at: _date(row.last_tx_at),
            tx_count: _num(row.tx_count)
        };
    });
};

/**
 * Every settled subscription charge for an app, newest first. One read; callers
 * evaluate the as-of predicate over it in memory for as many dates as they need,
 * rather than issuing one aggregation per bucket.
 *
 * @returns shop_id, shop_domain, gross, currency, billing_interval, created_at.
 */
const fetchSubscriptionChargeHistory = async ({ partner_app_id }: FetchSubscriptionChargeHistoryInput): Promise<SubscriptionChargeRow[]> => {
    const rows = await PartnerAppTransactionModel.find({
        partner_app_id: toObjectId(partner_app_id),
        type: PARTNER_TRANSACTION_TYPES.APP_SUBSCRIPTION,
        shop_id: { $ne: '' }
    })
        .select('shop_id shop_domain gross_amount billing_interval created_at')
        .sort({ created_at: -1 })
        .lean();

    return rows.map((r) => ({
        shop_id: r.shop_id,
        shop_domain: r.shop_domain || '',
        gross: Number(r.gross_amount && r.gross_amount.amount) || 0,
        currency: (r.gross_amount && r.gross_amount.currency) || '',
        billing_interval: r.billing_interval || null,
        created_at: r.created_at
    }));
};

/**
 * Shops currently paying, each valued at its most recent subscription charge.
 */
const fetchCurrentPayingShops = async ({ partner_app_id, windowDays, now = new Date() }: FetchCurrentPayingShopsInput): Promise<PayingShop[]> => {
    const history = await fetchSubscriptionChargeHistory({ partner_app_id });
    return [...liveSetAsOf(history, now, windowDays).values()];
};

/**
 * The as-of live set evaluated at the END of each requested month, keyed by
 * month label — the input to month-over-month MRR movement.
 *
 * The current month's boundary is clamped to `now`: its end has not happened yet.
 */
const fetchMonthlyLiveSets = async ({ partner_app_id, monthStarts, windowDays, now = new Date() }: FetchMonthlyLiveSetsInput): Promise<Map<string, LiveSet>> => {
    const history = await fetchSubscriptionChargeHistory({ partner_app_id });
    const out = new Map<string, LiveSet>();

    for (const monthStart of monthStarts) {
        const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
        let boundary = monthEnd;
        if (monthEnd.getTime() > now.getTime()) {
            boundary = now;
        }
        out.set(_monthKey(monthStart), liveSetAsOf(history, boundary, windowDays));
    }
    return out;
};

/**
 * Settled cash per CALENDAR MONTH, for the trend chart's two bar series.
 *
 * ⚠️ EVERY TRANSACTION TYPE, not just `APP_SUBSCRIPTION`. This is CASH — what Shopify actually
 * settled — so one-time charges, usage charges, credits and adjustments all belong in it, and the
 * negative ones belong in it most of all: a "gross cash" bar that omits refunds reports more money
 * than changed hands. The MRR line on the same chart is a RUN-RATE from subscriptions only, and the
 * two are deliberately different populations; the page labels them as such.
 *
 * ⚠️ `created_at` — Shopify's SETTLEMENT timestamp — never `createdAt`, which `timestamps` writes
 * when WE inserted the row. Bucketing on that one does not error; it files every row of a lifetime
 * backfill into the month the backfill ran, which draws one enormous bar and eleven empty ones.
 *
 * The month key is built INSIDE the pipeline with `$dateToString` on UTC, so the value a row is
 * grouped by and the label it is filed under are one expression. Computing the label in JavaScript
 * afterwards is how a boundary comes to be UTC on one side and local on the other.
 *
 * Served by `idx_app_created` / `idx_app_type_created` = `{ partner_app_id, …, created_at }`.
 *
 * @param params0 - See {@link RevenueWindowQuery}.
 * @param params0.partner_app_id - Mongo `_id` of the `gi_partner_app`.
 * @param params0.since - Inclusive lower bound, or null for no lower bound.
 * @param params0.until - Inclusive upper bound.
 * @returns One row per month that had at least one payout, oldest first.
 */
const aggregateMonthlyCash = async ({ partner_app_id, since, until }: RevenueWindowQuery): Promise<MonthlyCashRow[]> => {
    //  A month with NO payouts produces NO ROW, and that is the correct shape. The caller joins
    // these onto the months it walked and decides per month whether an absent row is a measured zero
    // (inside the ledger's coverage) or an unknown (before it). Emitting a zero row here would
    // collapse that distinction inside the repository, where the coverage floor is not known.
    const createdAt: Record<string, Date> = { $lte: until };
    if (since) {
        createdAt.$gte = since;
    }

    const rows = await PartnerAppTransactionModel.aggregate([
        { $match: { partner_app_id: toObjectId(partner_app_id), created_at: createdAt } },
        {
            $group: {
                _id: { $dateToString: { format: '%Y-%m', date: '$created_at', timezone: 'UTC' } },
                gross: { $sum: '$gross_amount.amount' },
                net: { $sum: '$net_amount.amount' },
                shopify_fee: { $sum: '$shopify_fee.amount' },
                tx_count: { $sum: 1 }
            }
        },
        { $sort: { _id: 1 } }
    ]);

    return rows.map((row) => ({
        month: String(row._id || ''),
        gross: _num(row.gross),
        net: _num(row.net),
        shopify_fee: _num(row.shopify_fee),
        tx_count: _num(row.tx_count)
    }));
};

/**
 * Settled cash inside the selected window, as one total.
 *
 *  Returns `null`, NOT a zeroed row, when nothing settled in the window. `$group` emits no document
 * when nothing matched, and that absence is the one authoritative signal. A manufactured
 * `{ net: 0, … }` and a genuinely empty window are the same four numbers; only the `null` carries the
 * difference, and it is what lets the caller publish "no cash settled in this period" rather than a
 * card asserting the business earned nothing.
 *
 * Same type coverage and same timestamp field as the monthly read above, for the same reasons — the
 * window card and the bars beneath it must be the same measurement at two granularities, or a reader
 * summing the bars gets a different answer from the card.
 *
 * @param params0 - See {@link RevenueWindowQuery}.
 * @param params0.partner_app_id - Mongo `_id` of the `gi_partner_app`.
 * @param params0.since - Inclusive lower bound, or null for the lifetime window.
 * @param params0.until - Inclusive upper bound.
 * @returns The totals, or null when nothing settled in the window.
 */
const aggregateWindowCash = async ({ partner_app_id, since, until }: RevenueWindowQuery): Promise<WindowCashTotals | null> => {
    const createdAt: Record<string, Date> = { $lte: until };
    if (since) {
        createdAt.$gte = since;
    }

    const rows = await PartnerAppTransactionModel.aggregate([
        { $match: { partner_app_id: toObjectId(partner_app_id), created_at: createdAt } },
        {
            $group: {
                _id: null,
                gross: { $sum: '$gross_amount.amount' },
                net: { $sum: '$net_amount.amount' },
                shopify_fee: { $sum: '$shopify_fee.amount' },
                tx_count: { $sum: 1 }
            }
        }
    ]);

    const row = rows[0];
    if (!row) {
        return null;
    }
    return {
        gross: _num(row.gross),
        net: _num(row.net),
        shopify_fee: _num(row.shopify_fee),
        tx_count: _num(row.tx_count)
    };
};

/**
 * Every subscription START and END event for the app, up to the judgement instant.
 *
 * The input to `conversion.resolveChargeCohortForDomains`, which turns these into one subscription
 * per charge and one winner per store — the source of every PLAN NAME, subscription STATE and dated
 * CANCELLATION on this endpoint. The money never comes from here; it comes from the payout ledger.
 *
 *  NO LOWER TIME BOUND, AND THERE MUST NEVER BE ONE. A store that matters to the window being
 * reported on may have subscribed at ANY point before it — a trial begun in January converts in
 * March, and a shop that churns this month subscribed years ago. Bounding the scan at the window's
 * start loses the START event, so the subscription is never bucketed at all and a paying customer is
 * published as never having subscribed. The under-report is silent and always downwards.
 *
 * ⚠️ `raw_event` STAYS PROJECTED. `charge.name`, `charge.amount`, `charge.billingOn` and `charge.test`
 * live ONLY inside that Mixed blob; the promoted columns carry the ids, not the payload. Dropping it
 * to make the read cheaper empties every plan name on the page.
 *
 * ⚠️ The `$in` includes UNINSTALL and DEACTIVATED, because `CHARGE_COHORT_EVENT_TYPES` does: they
 * carry no charge block and are a subscription's ONLY end signal when no cancellation event ever
 * landed. Without them such a store never churns and reads as paying for ever.
 *
 * Served by `idx_app_type_occurred` = `{ partner_app_id, event_type, occurred_at }`.
 *
 * @param params0 - See {@link RevenueAsOfQuery}.
 * @param params0.partner_app_id - Mongo `_id` of the `gi_partner_app`.
 * @param params0.as_of - Upper bound on `occurred_at`.
 * @returns The rows, in no guaranteed order — the cohort resolver sorts a copy.
 */
const findRevenueChargeEvents = async ({ partner_app_id, as_of }: RevenueAsOfQuery): Promise<PartnerAppEventDoc[]> => {
    return PartnerAppEventModel.find({
        partner_app_id: toObjectId(partner_app_id),
        event_type: { $in: CHARGE_COHORT_EVENT_TYPES },
        //  `$lte` ONLY. See the header.
        occurred_at: { $lte: as_of }
    })
        .select('event_type shop_domain charge_id occurred_at raw_event')
        .lean();
};

/**
 * Which subscriptions have settled money, as two `$addToSet` lists.
 *
 * The cohort's state machine takes a second branch when Shopify sent no `charge.billingOn`, and this
 * is the EVIDENCE that branch runs on: money either moved or it did not. Without it a subscription
 * with no billing date and a cancellation is classified `CHURNED_DURING_TRIAL` — claiming the
 * merchant never paid — or, with no cancellation, `ON_TRIAL` for ever.
 *
 *  BOUNDED AT THE SAME `as_of` AS THE EVENT PULL. Unbounded, a payout that settles in June is
 * evidence inside a January window: `everSettled` reads true and the shop is published as having
 * converted on a date it had not paid. The error runs ONE WAY ONLY, because the event pull and the
 * churn clamp ARE bounded — future churn excluded while future revenue is admitted.
 *
 * ⚠️ `created_at`, Shopify's settlement timestamp, for the same reason as the cash reads above.
 *
 * @param params0 - See {@link RevenueAsOfQuery}.
 * @param params0.partner_app_id - Mongo `_id` of the `gi_partner_app`.
 * @param params0.as_of - Upper bound on the settlement timestamp.
 * @returns `{ charge_ids, shop_domains }`, both empty when nothing has settled.
 */
const aggregateSettledSubscriptionEvidence = async ({ partner_app_id, as_of }: RevenueAsOfQuery): Promise<SettledSubscriptionEvidence> => {
    const rows = await PartnerAppTransactionModel.aggregate([
        {
            $match: {
                partner_app_id: toObjectId(partner_app_id),
                type: PARTNER_TRANSACTION_TYPES.APP_SUBSCRIPTION,
                created_at: { $lte: as_of }
            }
        },
        {
            $group: {
                _id: null,
                charge_ids: { $addToSet: '$charge_id' },
                shop_domains: { $addToSet: '$shop_domain' }
            }
        },
        { $project: { _id: 0, charge_ids: 1, shop_domains: 1 } }
    ]);

    //  An absent document is "no settled subscription payouts at all", which is a real measurement
    // and correctly produces two empty lists. The cohort resolver drops `''` entries from both
    // itself, so the blanks `$addToSet` collects are harmless here.
    const row = rows[0];
    if (!row) {
        return { charge_ids: [], shop_domains: [] };
    }
    return {
        charge_ids: row.charge_ids || [],
        shop_domains: row.shop_domains || []
    };
};

export = {
    findPartnerAppById,
    fetchSubscriptionChargeHistory,
    fetchCurrentPayingShops,
    fetchMonthlyLiveSets,
    getLifetimeCashTotals,
    getTopShopsByLifetimeNet,
    aggregateMonthlyCash,
    aggregateWindowCash,
    findRevenueChargeEvents,
    aggregateSettledSubscriptionEvidence
};
