'use strict';

/**
 * ============================================================================
 *  THE PARTNER APPS PAGE — the read side
 * ============================================================================
 *
 *  Everything `getPartnerAppKpi`, `getPartnerAppEvents` and the soft delete
 *  need out of the database, and nothing else. The judgement — what an empty
 *  result means, which figures may be published, where a month starts — lives
 *  in the services and the pure helpers, because those are what a test reaches.
 *
 *   EVERY `$match` CASTS `partner_app_id` THROUGH `toObjectId`. An aggregate
 *  does NOT auto-cast the way `find` does, so an uncast string id matches ZERO
 *  documents and raises no error: the pipeline returns `[]`, the KPI publishes
 *  four zeros, and the page reports a business with no installs. A wrong answer
 *  wearing the right clothes is the one failure this project exists to refuse.
 *
 *  ──  THE MONEY TOTALS ARE NOT COMPUTED HERE ──────────────────────────────
 *
 *  `getWindowCash` and `getLifetimeCash` at the bottom are `modules/revenue`'s
 *  own readers, re-exported. They are NOT reimplemented, and the two decisions
 *  inside them are exactly why:
 *
 *    1. They sum EVERY transaction type, not just `APP_SUBSCRIPTION` — because
 *       this is CASH. One-time charges, usage charges, credits and adjustments
 *       all belong in it, and the negative ones belong in it most of all: a
 *       "gross revenue" tile that omits refunds reports more money than changed
 *       hands.
 *    2. They bucket on `created_at`, Shopify's SETTLEMENT timestamp, never on
 *       `createdAt`, which `timestamps` writes when WE inserted the row.
 *       Bucketing on the wrong one does not error; it files an entire lifetime
 *       backfill into the month the backfill ran.
 *
 *  A second `$group` here would restate both judgements, and the KPI tile and
 *  the Revenue page would then be two answers to one question. This is a
 *  repository reaching a repository — the data-access layer talking to the
 *  data-access layer, one hop, no cycle: `modules/revenue` has no import edge
 *  back to `modules/partner`, so nothing here can close a loop. The alternative
 *  forms were both worse: the revenue BARREL does not export these readers at
 *  all, and a service reaching another module's repository would put data
 *  access one layer above where the lint guard can see it.
 * ============================================================================
 */

import models = require('../../shared/repositories/models.repository');
//  DEEP PATH INTO ANOTHER MODULE'S DATA LAYER, ON PURPOSE — see the header. NOT the barrel:
// `import revenue = require('../../revenue')` would eagerly load three services that each reach the
// model registry, and barrel imports between modules are how this codebase invented the cycle that
// left `liveSetAsOf` undefined at load and failed fifteen tests.
import revenueRepository = require('../../revenue/repositories/revenue.repository');
import constants = require('../constants/partnerAppRead.constants');

import type { RelationshipBucketCount } from '../types/installTrend.types';
import type {
    PartnerAppEventPageQuery,
    PartnerAppRetainedRowCounts,
    PartnerAppWindowQuery,
    PartnerEventListRow,
    PartnerRelationshipEventResult,
    PartnerRelationshipEventRow,
    RelationshipBucketGrain
} from '../types/partnerAppReadData.types';

const { PartnerAppEventModel, PartnerAppTransactionModel, toObjectId } = models;
const { RELATIONSHIP_EVENT_TYPES } = constants;

/** The `$dateToString` format per grain. One table, so the key a row is grouped by is declared once. */
const _BUCKET_FORMATS: Readonly<Record<RelationshipBucketGrain, string>> = Object.freeze({
    day: '%Y-%m-%d',
    month: '%Y-%m'
});

/**
 * Builds the `occurred_at` / `created_at` range clause for a window.
 *
 * `since: null` yields an upper bound only — the lifetime window — rather than an unbounded query.
 * The upper bound always exists, because a read whose top is open would include events dated in the
 * future by clock skew and count them as though they had happened.
 *
 * @param since - Inclusive lower bound, or null.
 * @param until - Inclusive upper bound.
 * @returns A Mongo range clause.
 */
const _rangeClause = (since: Date | null, until: Date): Record<string, Date> => {
    const clause: Record<string, Date> = { $lte: until };
    if (since) {
        clause.$gte = since;
    }
    return clause;
};

/**
 * A numeric accumulator off a raw aggregate row.
 *
 * Tests the TYPE rather than truthiness: `|| 0` maps a genuine `0` onto the fallback, which is the
 * falsy-default round-trip that turns "nothing happened here" into "nobody measured this".
 *
 * @param value - The raw accumulator value.
 * @returns The value, or 0 when it is absent or not finite.
 */
const _num = (value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    return 0;
};

/**
 * Relationship events inside a window, tallied by `(calendar bucket, event_type)`.
 *
 * ONE READ SERVES BOTH THE CHART AND THE TILES. The service sums these tallies for the window
 * counts rather than issuing a second aggregate, so a KPI tile and the series beneath it cannot
 * describe two different periods — see `helpers/installTrend.helper`.
 *
 * ⚠️ THE BUCKET KEY IS BUILT INSIDE THE PIPELINE with `$dateToString` on UTC, so the value a row is
 * grouped by and the label it is filed under are one expression. Computing the label in JavaScript
 * afterwards is how a boundary comes to be UTC on one side and local on the other, which files every
 * event near midnight into the neighbouring bucket without changing a total.
 *
 * ⚠️ `shopless` IS COUNTED, NOT FILTERED. An install event with no shop block is still an install —
 * dropping it would shrink a published count — but it joins to no store, so the fold that produces
 * `estimated_active` cannot use it. Both facts have to survive, so the row is counted here and the
 * exclusion is reported.
 *
 * Served by `idx_app_type_occurred` = `{ partner_app_id, event_type, occurred_at }`.
 *
 * @param params0 - The window plus the grain.
 * @param params0.partner_app_id - Mongo `_id` of the `gi_partner_app`.
 * @param params0.since - Inclusive lower bound, or null for the lifetime window.
 * @param params0.until - Inclusive upper bound.
 * @param params0.grain - `day` or `month`.
 * @returns One row per `(bucket, event_type)` that had events. A bucket with none produces NO ROW — which is correct, because only the caller knows whether that absence is a measured zero or a stretch nobody fetched.
 */
const aggregateRelationshipBuckets = async ({ partner_app_id, since, until, grain }: PartnerAppWindowQuery & {
    grain: RelationshipBucketGrain;
}): Promise<RelationshipBucketCount[]> => {
    const rows = await PartnerAppEventModel.aggregate([
        {
            $match: {
                partner_app_id: toObjectId(partner_app_id),
                event_type: { $in: RELATIONSHIP_EVENT_TYPES },
                occurred_at: _rangeClause(since, until)
            }
        },
        {
            $group: {
                _id: {
                    bucket: { $dateToString: { format: _BUCKET_FORMATS[grain], date: '$occurred_at', timezone: 'UTC' } },
                    event_type: '$event_type'
                },
                count: { $sum: 1 },
                // `$ifNull` first: a row written before `shop_domain` had a schema default has NO
                // such field, and a bare `$eq: ['$shop_domain', '']` does not match a missing one —
                // so the oldest rows, which are exactly the ones most likely to lack a shop block,
                // would be counted as perfectly joinable.
                shopless: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$shop_domain', ''] }, ''] }, 1, 0] } }
            }
        }
    ]);

    return rows.map((row) => ({
        bucket: String((row._id && row._id.bucket) || ''),
        event_type: String((row._id && row._id.event_type) || ''),
        count: _num(row.count),
        shopless: _num(row.shopless)
    }));
};

/**
 * Relationship events tallied by `event_type` alone, over a window or over all time.
 *
 * The all-time counts behind the KPI's "All-time" card. Grouped by TYPE ONLY rather than by
 * `(bucket, type)` because nothing plots them — a `$dateToString` per document on the whole event
 * history would be paid for and thrown away.
 *
 * ⚠️ IT RETURNS THE SAME ROW SHAPE AS `aggregateRelationshipBuckets`, with an empty `bucket`, so the
 * caller sums it through the SAME reducer (`helpers/installTrend.sumRelationshipCounts`). The
 * windowed tile and the all-time tile sit in adjacent cards and are read against each other; making
 * them literally the same function is what stops "Installs" and "Total installs" from counting
 * different things.
 *
 * ⚠️ `shopless` IS COUNTED, NOT FILTERED — see `aggregateRelationshipBuckets` for why. It is what
 * makes this total comparable with the windowed one, which also counts them.
 *
 * Served by `idx_app_type_occurred` = `{ partner_app_id, event_type, occurred_at }`.
 *
 * @param params0 - See {@link PartnerAppWindowQuery}.
 * @param params0.partner_app_id - Mongo `_id` of the `gi_partner_app`.
 * @param params0.since - Inclusive lower bound, or null for all time.
 * @param params0.until - Inclusive upper bound.
 * @returns One row per type that had events. A type with none produces NO ROW; the reducer's zeroed accumulator is what fills it in.
 */
const aggregateRelationshipTypeCounts = async ({ partner_app_id, since, until }: PartnerAppWindowQuery): Promise<RelationshipBucketCount[]> => {
    const rows = await PartnerAppEventModel.aggregate([
        {
            $match: {
                partner_app_id: toObjectId(partner_app_id),
                event_type: { $in: RELATIONSHIP_EVENT_TYPES },
                occurred_at: _rangeClause(since, until)
            }
        },
        {
            $group: {
                _id: '$event_type',
                count: { $sum: 1 },
                shopless: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$shop_domain', ''] }, ''] }, 1, 0] } }
            }
        }
    ]);

    return rows.map((row) => ({
        bucket: '',
        event_type: String((row && row._id) || ''),
        count: _num(row.count),
        shopless: _num(row.shopless)
    }));
};

/**
 * EVERY relationship event for the app, all time — the install-state spine.
 *
 * All four types. `partnerVocab.constants` states why two are not enough: a fold that considers only
 * INSTALL/UNINSTALL "leaves every reactivated shop permanently uninstalled and every frozen shop
 * permanently installed — both wrong, both silent."
 *
 * ⚠️ CALLED ONLY WHEN A LIFETIME SYNC HAS COMPLETED. Without one the all-time figures are withheld
 * anyway, so this read — the most expensive one on the endpoint — is skipped entirely rather than
 * paid for and then discarded.
 *
 * NOT SORTED, deliberately: the fold downstream keeps per-shop extremes by explicit timestamp
 * comparison, so ordering buys nothing while a `.sort()` would either force a blocking in-memory
 * sort of the whole install base or push the planner off `idx_app_type_occurred`.
 *
 * Two queries rather than one `$facet`: a facet packs every event into ONE result document and meets
 * the 16MB BSON ceiling as the install base grows.
 *
 * @param params0 - The scope.
 * @param params0.partner_app_id - Mongo `_id` of the `gi_partner_app`.
 * @returns The joinable rows, plus the count it excluded.
 */
const findAllRelationshipEvents = async ({ partner_app_id }: { partner_app_id: string }): Promise<PartnerRelationshipEventResult> => {
    const _appId = toObjectId(partner_app_id);
    const match = { partner_app_id: _appId, event_type: { $in: RELATIONSHIP_EVENT_TYPES } };

    const [rows, shopless] = await Promise.all([
        // `$nin: ['', null]`, NOT `$ne: ''`. Query-language `null` matches a MISSING field as well as
        // a stored one, so a document written before the schema default existed would pass a bare
        // `$ne` and become a row whose `shop_domain` is `null` — which then reaches a string compare
        // downstream and turns a TypeError into a refusal of the whole endpoint.
        PartnerAppEventModel.find({ ...match, shop_domain: { $nin: ['', null] } })
            .select('shop_domain event_type occurred_at shop_name shop_id')
            .lean<PartnerRelationshipEventRow[]>(),
        // `$in: ['', null]` and not `$eq: ''`, for the same reason in reverse: counting only the
        // empty strings would UNDER-report the exclusion, and an exclusion nobody counted is one
        // nobody can be warned about.
        PartnerAppEventModel.countDocuments({ ...match, shop_domain: { $in: ['', null] } })
    ]);

    return { rows, shopless_relationship_events: shopless };
};

/**
 * One page of raw events, newest first, and the count of everything that matched.
 *
 * ⚠️ `raw_event` IS NOT PROJECTED. It is a Mixed blob per row on the largest collection in the
 * build; a page of 200 would be megabytes of payload for a list nobody reads a payload from. The
 * single-store detail path is where a raw node is inspected.
 *
 * The count is issued alongside the page rather than after it, so total and rows describe the same
 * filter and the pagination block cannot claim a page that does not exist.
 *
 * ⚠️ `countDocuments`, not `estimatedDocumentCount`: the latter ignores the filter entirely and
 * would report the whole collection's size as this app's event total.
 *
 * Served by `idx_app_occurred` = `{ partner_app_id, occurred_at }`, or by `idx_app_type_occurred`
 * when a type filter is applied.
 *
 * @param params0 - See {@link PartnerAppEventPageQuery}.
 * @param params0.partner_app_id - Mongo `_id` of the `gi_partner_app`.
 * @param params0.since - Inclusive lower bound, or null for the lifetime window.
 * @param params0.until - Inclusive upper bound.
 * @param params0.event_type - An exact type, or null for every type.
 * @param params0.skip - Rows to skip.
 * @param params0.limit - Rows to return.
 * @returns `{ rows, total }`.
 */
const findPartnerEventPage = async ({ partner_app_id, since, until, event_type, skip, limit }: PartnerAppEventPageQuery): Promise<{
    rows: PartnerEventListRow[];
    total: number;
}> => {
    const filter: Record<string, any> = {
        partner_app_id: toObjectId(partner_app_id),
        occurred_at: _rangeClause(since, until)
    };
    if (event_type) {
        filter.event_type = event_type;
    }

    const [rows, total] = await Promise.all([
        PartnerAppEventModel.find(filter)
            .select('partner_event_id event_type occurred_at shop_domain shop_name shop_id charge_id')
            .sort({ occurred_at: -1 })
            .skip(skip)
            .limit(limit)
            .lean<PartnerEventListRow[]>(),
        PartnerAppEventModel.countDocuments(filter)
    ]);

    return { rows, total };
};

/**
 * Every distinct currency on the app's settled payouts inside a window.
 *
 * ⚠️ THIS IS A COVERAGE FACT, NOT A MONEY FOLD — which is why it lives here rather than being asked
 * of `modules/revenue`. It answers "what units is that sum in", and the honest answer when there is
 * more than one is that the total cannot be captioned at all: there is no FX table anywhere in this
 * codebase, on purpose, because a wrong rate produces a plausible wrong number.
 *
 * `$group` rather than `distinct`: `distinct` returns its whole answer inside one document and is
 * therefore capped at 16MB. The cardinality here is tiny, but the reason to prefer an aggregation is
 * the same everywhere in this build and a special case would be a special case to remember.
 *
 * @param params0 - See {@link PartnerAppWindowQuery}.
 * @param params0.partner_app_id - Mongo `_id` of the `gi_partner_app`.
 * @param params0.since - Inclusive lower bound, or null for the lifetime window.
 * @param params0.until - Inclusive upper bound.
 * @returns The codes, sorted, with blanks dropped. Empty when nothing settled.
 */
const aggregateWindowCurrencies = async ({ partner_app_id, since, until }: PartnerAppWindowQuery): Promise<string[]> => {
    const rows = await PartnerAppTransactionModel.aggregate([
        {
            $match: {
                partner_app_id: toObjectId(partner_app_id),
                created_at: _rangeClause(since, until)
            }
        },
        { $group: { _id: '$gross_amount.currency' } },
        { $sort: { _id: 1 } }
    ]);

    const codes: string[] = [];
    for (const row of rows) {
        const code = String((row && row._id) || '').trim();
        // A payout whose money subdocument carried no currency is not a currency; it is a row we
        // cannot caption. Dropping it here keeps it out of the "spans N currencies" warning, where
        // it would read as a real second denomination.
        if (code !== '') {
            codes.push(code);
        }
    }
    return codes;
};

/**
 * How many rows still reference an app, per collection.
 *
 *  READ BY THE SOFT DELETE, AND THAT IS ITS WHOLE PURPOSE. An operator who sends DELETE and gets a
 * 200 has every reason to assume rows went away; these two counts are what the response uses to say
 * that none did. A claim of preservation with no number behind it is a claim nobody can check.
 *
 * Both are index-served on the leading `partner_app_id` field of the collections' compounds.
 *
 * @param params0 - The scope.
 * @param params0.partner_app_id - Mongo `_id` of the `gi_partner_app`.
 * @returns Event and transaction row counts.
 */
const countAppScopedRows = async ({ partner_app_id }: { partner_app_id: string }): Promise<PartnerAppRetainedRowCounts> => {
    const _appId = toObjectId(partner_app_id);
    const [event_rows, transaction_rows] = await Promise.all([
        PartnerAppEventModel.countDocuments({ partner_app_id: _appId }),
        PartnerAppTransactionModel.countDocuments({ partner_app_id: _appId })
    ]);
    return { event_rows, transaction_rows };
};

export = {
    aggregateRelationshipBuckets,
    aggregateRelationshipTypeCounts,
    findAllRelationshipEvents,
    findPartnerEventPage,
    aggregateWindowCurrencies,
    countAppScopedRows,

    // ── The money, from `modules/revenue` ───────────────────────────────────
    //
    //  RE-EXPORTED, NEVER REIMPLEMENTED. See the file header for the two judgements inside these
    // that a local `$group` would restate — every transaction type, and `created_at` rather than
    // `createdAt` — and for why a KPI tile disagreeing with the Revenue page is the failure that
    // matters here.

    /** Settled cash inside a window, every transaction type. `null` when nothing settled at all. */
    getWindowCash: revenueRepository.aggregateWindowCash,
    /** All-time settled cash for the app. `null` when the ledger holds nothing — never a zeroed row. */
    getLifetimeCash: revenueRepository.getLifetimeCashTotals
};
