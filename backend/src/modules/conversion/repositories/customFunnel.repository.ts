'use strict';

/**
 * ============================================================================
 *  THE CUSTOM FUNNEL — every read it needs, and nothing else
 * ============================================================================
 *
 *  Four reads, all of them push-down replacements for folds the ported implementation did in
 *  JavaScript after fetching whole documents:
 *
 *    1. partner shop sets     — distinct shops per event type, and what the blank filter excluded
 *    2. transaction shop sets — distinct shops whose NET for a payout type was above zero
 *    3. first-ever payouts    — shops whose all-time first payout landed inside the window
 *    4. the charge cohort     — every subscription signal, with NO lower bound, plus its evidence
 *
 *  The GA4 totals are NOT here. `modules/bigquery` already owns that aggregation
 *  (`listingRollup.repository.aggregateFunnelTotals`) and publishes it from its barrel; a second
 *  definition of the same figure is the exact failure `IMPLEMENTATION.md` §3.10 records for MRR,
 *  where two pages reconstructed it independently and disagreed with each other.
 *
 *  The APP ROW is not here either. `installCohort.repository.findPartnerAppById` is this module's
 *  one app read, and it reads exactly the watermarks and coverage gates this endpoint needs. Two
 *  copies of `findById(…).lean()` in one module is two places for a projection to drift.
 *
 *  ── FOUR THINGS IN HERE ARE LOAD-BEARING ─────────────────────────────────
 *
 *  1. EVERY `$match` CASTS THROUGH `toObjectId`. `aggregate` does not auto-cast — unlike `find` —
 *     so an uncast string id matches ZERO documents and raises NO error. Every bar would render at
 *     zero height with a real number formatted beside it, on a page that looks entirely healthy.
 *
 *  2. THE SHOP SETS ARE SETS, NOT COUNTS. A step may span several event types and its number is the
 *     UNION of their shop sets. A repository that returned per-type counts would make the union
 *     impossible and the sum inevitable — and the sum double-counts every shop that fired both
 *     types, producing a larger, entirely plausible figure.
 *
 *  3. THE CHARGE-COHORT PULL CARRIES NO `$gte`. A subscription that converts inside the window may
 *     have started at any point before it. Bounding that scan at the window's start loses the START
 *     event, so the subscription is never bucketed and `window_kpi.converted_in_window` under-counts
 *     — silently, and always downwards.
 *
 *  4. `raw_event` STAYS PROJECTED. `billingOn`, `name`, `amount` and `test` live NOWHERE ELSE. Drop
 *     it to make the scan cheaper and every trial end becomes null, every test charge becomes
 *     indistinguishable from a real one, and `window_kpi` drops to zero.
 *
 *  ── `shop_domain`, NEVER `shop_id` ───────────────────────────────────────
 *
 *  The ported implementation counted distinct `shop_id`. That column holds the Partner GID and is
 *  `''` on older event rows here — `resolvers/chargeCohort.resolver.ts` documents what keying on it
 *  did to the subscription fold. In THIS file it would do something quieter: the `installed` step
 *  would count a different population from `summary.installs` in the install-cohort table directly
 *  below it on the same page, and the two would disagree with nothing on screen to say which was
 *  right. `shop_domain` is normalised on write and is the join key every other shop-keyed figure in
 *  this application already uses.
 *
 *  ── What is NOT here ────────────────────────────────────────────────────────
 *  No judgement. What a null means, whether a tier may be read at all, which steps to compute — all
 *  of that is the service's, because the service is what a test reaches, and a second opinion formed
 *  here would be a second place for the answer to drift.
 * ============================================================================
 */

import models = require('../../shared/repositories/models.repository');
import lifecycleConstants = require('../constants/lifecycle.constants');
import partnerVocab = require('../../../constants/partnerVocab.constants');

import type { PartnerAppEventDoc } from '../../shared/types/entity.types';
import type {
    FunnelChargeCohortQuery,
    FunnelEventWindowQuery,
    FunnelFirstTransactionQuery,
    FunnelSettledChargeQuery,
    FunnelSettledChargeResult,
    FunnelTransactionWindowQuery,
    PartnerShopSetResult,
    PartnerShopSetRow,
    TransactionShopSetRow
} from '../types/customFunnelData.types';

const { PartnerAppEventModel, PartnerAppTransactionModel, toObjectId } = models;
const { CHARGE_COHORT_EVENT_TYPES } = lifecycleConstants;
const { PARTNER_TRANSACTION_TYPES } = partnerVocab;

/**
 * The predicate that excludes rows which cannot be attributed to a store.
 *
 * `$nin: ['', null]`, NOT `$ne: ''`. Query-language `null` matches a MISSING field as well as a
 * stored one, and `$ne: ''` matches both — so a document written before the schema default existed
 * passed the filter and grouped under `_id: null`, producing a "shop" whose domain was `null` that
 * every downstream `Set` then counted as one real store. The install spine hit exactly this and its
 * repository carries the same note.
 */
const NAMED_SHOP_ONLY = Object.freeze({ $nin: ['', null] });

/** Its complement, for counting what was excluded. `$in: ['', null]` matches missing as well. */
const UNNAMED_SHOP_ONLY = Object.freeze({ $in: ['', null] });

/**
 * A date-range predicate for one field, or nothing at all.
 *
 * Returns `{}` rather than a bound at the beginning of time when the window is lifetime, so the
 * planner picks the same index either way instead of range-scanning from 1970.
 *
 * @param field - The date field to bound: `occurred_at` or `created_at`.
 * @param since - Lower bound, or null for none.
 * @param until - Upper bound, or null for none.
 * @returns A fragment to spread into a `$match`.
 */
const _rangeClause = (field: string, since: Date | null, until: Date | null): Record<string, any> => {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (since) {
        range.$gte = since;
    }
    if (until) {
        range.$lte = until;
    }
    if (Object.keys(range).length === 0) {
        return {};
    }
    return { [field]: range };
};

/**
 * DISTINCT SHOPS PER EVENT TYPE, for the types the selected steps actually need.
 *
 * Replaces a full document fetch: the ported implementation loaded every event in the window —
 * including the Mixed `raw_event` blob on each — bucketed them into a `Map<shop, events[]>` in
 * JavaScript, then walked that building a `Set` per type. Two `$group` stages compute the same
 * answer without the payload ever leaving the server.
 *
 * ⚠️ `event_types` MUST be only what the selection needs. Passing the whole vocabulary scans nine
 * types to answer for two, and the cost is paid on every keystroke in the step picker.
 *
 * ⚠️ THE SETS COME BACK, NOT COUNTS. See rule 2 in the file header.
 *
 * Served by `idx_app_type_occurred` = `{ partner_app_id, event_type, occurred_at }`; Mongo explodes
 * the `$in` into one bounded scan per value, and eleven points is far under any planner ceiling.
 *
 * ⚠️ The second `$group` materialises one array per type. At roughly forty thousand stores that is
 * about a megabyte per type — comfortable, and bounded by the app's install base rather than by the
 * window. Above a few hundred thousand stores the escape is to count single-type steps with `$sum`
 * and fetch sets only for the multi-type ones; do not reach for it before measuring.
 *
 * @param params0 - See {@link FunnelEventWindowQuery}.
 * @returns One row per type that had events, plus the blank-domain count.
 */
const aggregatePartnerShopSets = async ({
    partner_app_id,
    event_types,
    since,
    until
}: FunnelEventWindowQuery): Promise<PartnerShopSetResult> => {
    if (!event_types || event_types.length === 0) {
        // Nothing selected needs this read. An empty `$in` matches nothing anyway; returning early
        // keeps a zero-cost case from looking like a query that found no data.
        return { rows: [], shopless_events: 0 };
    }

    const match = {
        partner_app_id: toObjectId(partner_app_id),
        event_type: { $in: event_types },
        ..._rangeClause('occurred_at', since, until)
    };

    const [rows, shopless] = await Promise.all([
        PartnerAppEventModel.aggregate<PartnerShopSetRow>([
            { $match: { ...match, shop_domain: NAMED_SHOP_ONLY } },
            // Distinct (type, shop) pairs first, so the `$addToSet` below accumulates at most one
            // entry per pair rather than de-duplicating an entire event stream in memory.
            { $group: { _id: { event_type: '$event_type', shop_domain: '$shop_domain' } } },
            { $group: { _id: '$_id.event_type', shops: { $addToSet: '$_id.shop_domain' } } },
            { $project: { _id: 0, event_type: '$_id', shops: 1 } }
        ]),
        //  Counted, not discarded. A shop we cannot name is not a shop that did not act, and
        // this is the ONLY channel through which that exclusion reaches the operator.
        PartnerAppEventModel.countDocuments({ ...match, shop_domain: UNNAMED_SHOP_ONLY })
    ]);

    return { rows, shopless_events: shopless };
};

/**
 * DISTINCT SHOPS PER PAYOUT TYPE, counting only shops whose NET for that type was above zero.
 *
 * THE SIGN IS TESTED ON THE PER-SHOP TOTAL, NOT PER ROW. A shop whose payment was later fully
 * refunded nets to zero and is correctly not counted as having paid; testing each row would count
 * it on the strength of the payment and then ignore the credit. That ordering — `$group` then
 * `$match` — is the whole reason this is one pipeline rather than a filter on the rows.
 *
 * ⚠️ `created_at` is Shopify's SETTLEMENT timestamp, never `createdAt`, which `timestamps` writes
 * when we inserted the row. One character apart; bounding on the wrong one does not error, it
 * clamps by sync time, and a lifetime backfill then falls inside every window at once.
 *
 * Served by `idx_app_type_created` = `{ partner_app_id, type, created_at }`.
 *
 * @param params0 - See {@link FunnelTransactionWindowQuery}.
 * @returns One row per payout type that had positive-net shops.
 */
const aggregateTransactionShopSets = async ({
    partner_app_id,
    types,
    since,
    until
}: FunnelTransactionWindowQuery): Promise<TransactionShopSetRow[]> => {
    if (!types || types.length === 0) {
        return [];
    }

    return PartnerAppTransactionModel.aggregate<TransactionShopSetRow>([
        {
            $match: {
                partner_app_id: toObjectId(partner_app_id),
                type: { $in: types },
                shop_domain: NAMED_SHOP_ONLY,
                ..._rangeClause('created_at', since, until)
            }
        },
        {
            $group: {
                _id: { type: '$type', shop_domain: '$shop_domain' },
                net_total: { $sum: '$net_amount.amount' }
            }
        },
        //  AFTER the per-shop sum. See the docstring.
        { $match: { net_total: { $gt: 0 } } },
        { $group: { _id: '$_id.type', shops: { $addToSet: '$_id.shop_domain' } } },
        { $project: { _id: 0, type: '$_id', shops: 1 } }
    ]);
};

/**
 * How many shops received their FIRST-EVER payout inside the window.
 *
 * THE `$min` IS TAKEN OVER ALL HISTORY AND ONLY THEN TESTED AGAINST THE WINDOW. That ordering is
 * what makes the answer "first ever, and it happened here" rather than "transacted in this window".
 * Moving the window into the first `$match` — which looks like an optimisation, and is one — turns
 * a first-payout step into a had-any-payout step, and every long-standing customer is counted as a
 * new one every month.
 *
 * The ported implementation grouped all-time, shipped every row to Node and filtered there. This is
 * the same computation with the filter pushed down; nothing but the count crosses the wire.
 *
 * @param params0 - See {@link FunnelFirstTransactionQuery}.
 * @returns Distinct shops whose first payout landed inside the window.
 */
const countFirstTransactionShops = async ({
    partner_app_id,
    since,
    until
}: FunnelFirstTransactionQuery): Promise<number> => {
    const windowMatch = _rangeClause('first_at', since, until);

    const rows = await PartnerAppTransactionModel.aggregate<{ shops: number }>([
        {
            $match: {
                partner_app_id: toObjectId(partner_app_id),
                shop_domain: NAMED_SHOP_ONLY
            }
        },
        { $group: { _id: '$shop_domain', first_at: { $min: '$created_at' } } },
        ...(Object.keys(windowMatch).length > 0 ? [{ $match: windowMatch }] : []),
        { $count: 'shops' }
    ]);

    //  `$count` emits NO DOCUMENT when nothing matched, so `rows[0]` is undefined rather than a
    // zero. That is a measured zero here — the pipeline ran and found no first payouts — which is
    // different from the GA4 totals, where an absent `$group` document means the rollup has no row
    // for this window at all and the honest answer is `null`.
    return rows.length > 0 ? Number(rows[0].shops) || 0 : 0;
};

/**
 * Every subscription START and END event for the app, up to the judgement instant.
 *
 * NO LOWER TIME BOUND — see rule 3 in the file header. It is an ABSENCE, which is exactly the
 * kind of thing a well-meaning optimisation adds back.
 *
 * ⚠️ APP-WIDE, not scoped to a store list. The install-cohort read scopes to its spine because the
 * spine IS its population; here the population is "every subscription this app has", because
 * `window_kpi` must see a conversion whose store installed long before the window.
 *
 * Served by `idx_app_type_occurred` = `{ partner_app_id, event_type, occurred_at }`.
 *
 * @param params0 - See {@link FunnelChargeCohortQuery}.
 * @returns The rows, unsorted — the resolver sorts a copy itself.
 */
const findChargeCohortEvents = async ({
    partner_app_id,
    until
}: FunnelChargeCohortQuery): Promise<PartnerAppEventDoc[]> => {
    return PartnerAppEventModel.find({
        partner_app_id: toObjectId(partner_app_id),
        event_type: { $in: CHARGE_COHORT_EVENT_TYPES },
        //  `$lte` ONLY. There is no `$gte` and there must never be one.
        occurred_at: { $lte: until }
    })
        // `raw_event` is not optional here — see rule 4 in the file header.
        .select('event_type shop_domain charge_id occurred_at raw_event')
        .lean();
};

/**
 * Charges and shops with at least one settled `APP_SUBSCRIPTION` payout at or before `as_of`.
 *
 * This is the evidence behind the second branch of the state machine: where Shopify supplied no
 * `charge.billingOn`, money either provably moved for that charge or it provably did not, and that
 * is a measurement rather than a guess.
 *
 * BOUNDED AT THE JUDGEMENT INSTANT. Unbounded, a payout that settles in June is evidence inside a
 * January window: the subscription takes the `conversion_date === null` branch, `everSettled` reads
 * true, and it is classified PAYING as of a date it had not yet paid. The error only ever runs one
 * way, because the event pull and the churn clamp ARE bounded — future churn excluded while future
 * revenue is admitted, over-counting conversions in every historical window.
 *
 * Restricted to `APP_SUBSCRIPTION`: usage and one-time charges are real money and are not evidence
 * that a SUBSCRIPTION converted.
 *
 * @param params0 - See {@link FunnelSettledChargeQuery}.
 * @returns Distinct settled charge ids and shop domains.
 */
const aggregateSettledSubscriptionEvidence = async ({
    partner_app_id,
    as_of
}: FunnelSettledChargeQuery): Promise<FunnelSettledChargeResult> => {
    const rows = await PartnerAppTransactionModel.aggregate<FunnelSettledChargeResult>([
        {
            $match: {
                partner_app_id: toObjectId(partner_app_id),
                type: PARTNER_TRANSACTION_TYPES.APP_SUBSCRIPTION,
                // ⚠️ `created_at`, Shopify's settlement timestamp. See the header on the sibling read.
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

    //  An absent document is "no settled subscription payouts at all", which is a real
    // measurement and correctly produces two empty lists. The resolver drops `''` entries from both
    // itself, so the blanks `$addToSet` collects are harmless here.
    if (rows.length === 0) {
        return { charge_ids: [], shop_domains: [] };
    }
    return {
        charge_ids: rows[0].charge_ids || [],
        shop_domains: rows[0].shop_domains || []
    };
};

export = {
    aggregatePartnerShopSets,
    aggregateTransactionShopSets,
    countFirstTransactionShops,
    findChargeCohortEvents,
    aggregateSettledSubscriptionEvidence
};
