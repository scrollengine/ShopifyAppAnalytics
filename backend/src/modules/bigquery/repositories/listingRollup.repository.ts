'use strict';

/**
 * ============================================================================
 *  THE THREE DAILY ROLLUPS — write side and read side
 * ============================================================================
 *
 *  The sync service maps and counts; this file decides what a write actually SETS and how a read is
 *  shaped. Both halves live together because they share one thing that must not drift: the GRAIN of
 *  each collection. A write keyed on (app, date) and a read grouping by (app, date, country) would
 *  disagree about what one row means, silently.
 *
 *  ── Why every write is an upsert on a natural key ───────────────────────────
 *  Re-running a window produces no duplicates, which is what makes the INCREMENTAL overlap free and
 *  makes "just re-sync it" a real repair rather than a duplication event. The filter IS the grain:
 *
 *    funnel  (partner_app_id, date)
 *    source  (partner_app_id, date, traffic_source, traffic_medium)
 *    geo     (partner_app_id, date, country)
 *
 *  ── Why matched rows are counted as written ──────────────────────────────
 *  A re-sync that finds the same numbers modifies nothing: `modifiedCount` is 0 and `matchedCount`
 *  is the batch size. The sync service FAILS a section that fetched rows and wrote none — so
 *  counting only modified rows would report every correct, boring re-run as a broken write path.
 *  `upserted + matched` is the accounted-for count; anything in neither is a genuinely lost row and
 *  is counted as an error.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import models = require('../../shared/repositories/models.repository');
import constants = require('../constants/bigQuery.constants');

import type { AnyBulkWriteOperation, Model } from 'mongoose';
import type { ListingFunnelDailyDoc } from '../../shared/types/entity.types';
import type { FunnelDayRow, GeoDayRow, ListingWriteTally, SourceDayRow } from '../types/bigQuery.types';
import type {
    FunnelTotalsRow,
    GeoBreakdownItem,
    RollupReadInput,
    TrafficSourceBreakdownItem
} from '../types/bigQueryAnalytics.types';

const { customConsoleError } = logger;
const { ListingFunnelDailyModel, ListingSourceDailyModel, ListingGeoDailyModel, toObjectId } = models;
const { BULK_WRITE_CHUNK_SIZE } = constants;

/**
 * The subset of a failed bulkWrite this file reads.
 *
 * `catch` binds `unknown` and every field is optional, so each access stays guarded. The driver
 * reports partial success two ways depending on version (`upsertedCount` / `nUpserted`), and both
 * are read — an unread count is a row that WAS written and never accounted for.
 */
interface BulkWriteErrorLike {
    message?: string;
    result?: {
        upsertedCount?: number;
        matchedCount?: number;
        nUpserted?: number;
        nMatched?: number;
    };
}

const _isBulkWriteError = (error: unknown): error is BulkWriteErrorLike => !!error && typeof error === 'object';

/**
 * Executes bulk operations in chunks and returns an aggregate tally.
 *
 * `ordered: false` so one bad row does not halt the batch — these upserts exist to be idempotent,
 * and a re-sync is EXPECTED to collide with rows it already wrote.
 *
 * `Model<any>` rather than a generic: this helper deliberately runs against all four listing
 * collections, and mongoose types `bulkWrite`'s argument through a conditional on the model's own
 * document type, which an unresolved type parameter cannot satisfy.
 *
 * @param model - The model to write through.
 * @param ops - Bulk operations, already built by the caller.
 * @param label - Which rollup, for the error log.
 * @returns Upserted, matched, and unaccounted-for counts.
 */
const _runBulkWrite = async (model: Model<any>, ops: AnyBulkWriteOperation[], label: string): Promise<ListingWriteTally> => {
    let upserted = 0;
    let matched = 0;
    let errors = 0;

    for (let i = 0; i < ops.length; i += BULK_WRITE_CHUNK_SIZE) {
        const chunk = ops.slice(i, i + BULK_WRITE_CHUNK_SIZE);
        try {
            const r = await model.bulkWrite(chunk, { ordered: false });
            upserted += r.upsertedCount || 0;
            matched += r.matchedCount || 0;
        } catch (writeError) {
            let r: BulkWriteErrorLike['result'];
            let _writeErrorMessage: string | undefined;
            if (_isBulkWriteError(writeError)) {
                r = writeError.result;
                _writeErrorMessage = writeError.message;
            }

            let chunkUpserted = 0;
            if (r) {
                chunkUpserted = (r.upsertedCount != null ? r.upsertedCount : (r.nUpserted || 0)) || 0;
            }
            let chunkMatched = 0;
            if (r) {
                chunkMatched = (r.matchedCount != null ? r.matchedCount : (r.nMatched || 0)) || 0;
            }

            upserted += chunkUpserted;
            matched += chunkMatched;
            errors += Math.max(chunk.length - (chunkUpserted + chunkMatched), 0);
            customConsoleError('Listing rollup bulkWrite chunk failed', {
                rollup: label,
                model: model.modelName,
                chunk_start: i,
                chunk_size: chunk.length,
                message: _writeErrorMessage
            });
        }
    }

    return { upserted, matched, errors };
};

// ── Write side ──────────────────────────────────────────────────────────────

/**
 * Upserts days of the funnel rollup. Grain: (partner_app_id, date).
 *
 * The whole payload is rewritten on every sync — none of it participates in the row's identity, and
 * a re-sync must be able to REPAIR a row rather than leave the first (possibly worse) reading in
 * place forever.
 *
 * @param partner_app_id - The app these rows belong to.
 * @param rows - Already-parsed days.
 * @returns What the write accounted for.
 */
const upsertFunnelDays = async (partner_app_id: string, rows: FunnelDayRow[]): Promise<ListingWriteTally> => {
    const _appId = toObjectId(partner_app_id);
    const ops: AnyBulkWriteOperation[] = rows.map((row) => ({
        updateOne: {
            filter: { partner_app_id: _appId, date: row.date },
            update: {
                $set: {
                    views: row.views,
                    engaged_views: row.engaged_views,
                    install_clicks: row.install_clicks,
                    consent_started: row.consent_started,
                    consent_completed: row.consent_completed,
                    installs: row.installs,
                    ad_clicks: row.ad_clicks,
                    first_opens: row.first_opens,
                    sessions: row.sessions,
                    first_visits: row.first_visits,
                    overall_conversion_rate: row.overall_conversion_rate,
                    ad_attributed_share: row.ad_attributed_share,
                    bytes_scanned: row.bytes_scanned,
                    source_bq_query_id: row.source_bq_query_id
                }
            },
            upsert: true
        }
    }));
    return _runBulkWrite(ListingFunnelDailyModel, ops, 'funnel');
};

/**
 * Upserts (day, source, medium) buckets. Both attribution columns are part of the GRAIN, so they
 * are in the filter and never in the payload.
 *
 * ⚠️ Provenance (`bytes_scanned` / `source_bq_query_id`) is deliberately NOT written here. The funnel
 * schema declares both fields; this one does not, and it is not `strict: false` — so mongoose would
 * STRIP them from the update silently, shipping provenance that looks written and is not. Add the
 * two schema fields first, in the same change as the write. Until then the provenance lives on the
 * section result, which is real.
 *
 * @param partner_app_id - The app these rows belong to.
 * @param rows - Already-parsed buckets.
 * @returns What the write accounted for.
 */
const upsertSourceDays = async (partner_app_id: string, rows: SourceDayRow[]): Promise<ListingWriteTally> => {
    const _appId = toObjectId(partner_app_id);
    const ops: AnyBulkWriteOperation[] = rows.map((row) => ({
        updateOne: {
            filter: {
                partner_app_id: _appId,
                date: row.date,
                traffic_source: row.traffic_source,
                traffic_medium: row.traffic_medium
            },
            update: {
                $set: {
                    users: row.users,
                    views: row.views,
                    install_clicks: row.install_clicks,
                    installs: row.installs
                }
            },
            upsert: true
        }
    }));
    return _runBulkWrite(ListingSourceDailyModel, ops, 'source');
};

/**
 * Upserts (day, country) buckets. Same provenance caveat as the source rollup above.
 *
 * @param partner_app_id - The app these rows belong to.
 * @param rows - Already-parsed buckets.
 * @returns What the write accounted for.
 */
const upsertGeoDays = async (partner_app_id: string, rows: GeoDayRow[]): Promise<ListingWriteTally> => {
    const _appId = toObjectId(partner_app_id);
    const ops: AnyBulkWriteOperation[] = rows.map((row) => ({
        updateOne: {
            filter: { partner_app_id: _appId, date: row.date, country: row.country },
            update: {
                $set: {
                    views: row.views,
                    installs: row.installs,
                    conversion_rate: row.conversion_rate
                }
            },
            upsert: true
        }
    }));
    return _runBulkWrite(ListingGeoDailyModel, ops, 'geo');
};

// ── Read side ───────────────────────────────────────────────────────────────
//
// Every `$match` casts `partner_app_id` through `toObjectId`. Unlike `find`, an AGGREGATE does
// NOT auto-cast — an uncast string id matches ZERO documents, raises no error, and the page renders
// as though the listing had no traffic. That is a plausible empty answer, which is the one failure
// mode this project exists to refuse.

/**
 * The funnel trend, one row per day, oldest first.
 *
 * @param params0 - See {@link RollupReadInput}.
 * @returns Lean documents.
 */
const findFunnelTrend = async ({ partner_app_id, date_match }: RollupReadInput): Promise<ListingFunnelDailyDoc[]> => {
    const match = { partner_app_id: toObjectId(partner_app_id), ...date_match };
    return ListingFunnelDailyModel.find(match).sort({ date: 1 }).lean();
};

/**
 * Window totals for the funnel.
 *
 * @param params0 - See {@link RollupReadInput}.
 * @returns The summed counts, or null when the window holds no rows.
 */
const aggregateFunnelTotals = async ({ partner_app_id, date_match }: RollupReadInput): Promise<FunnelTotalsRow | null> => {
    const match = { partner_app_id: toObjectId(partner_app_id), ...date_match };
    const rows = await ListingFunnelDailyModel.aggregate([
        { $match: match },
        {
            $group: {
                _id: null,
                views: { $sum: '$views' },
                engaged_views: { $sum: '$engaged_views' },
                install_clicks: { $sum: '$install_clicks' },
                consent_started: { $sum: '$consent_started' },
                consent_completed: { $sum: '$consent_completed' },
                installs: { $sum: '$installs' },
                ad_clicks: { $sum: '$ad_clicks' },
                first_opens: { $sum: '$first_opens' },
                sessions: { $sum: '$sessions' },
                first_visits: { $sum: '$first_visits' }
            }
        }
    ]);
    return rows[0] || null;
};

/**
 * (source, medium) pairs over the window, heaviest first.
 *
 * @param params0 - See {@link RollupReadInput}; `limit` is already clamped by the caller.
 * @returns One row per pair.
 */
const aggregateSourceBreakdown = async ({ partner_app_id, date_match, limit }: RollupReadInput): Promise<TrafficSourceBreakdownItem[]> => {
    const match = { partner_app_id: toObjectId(partner_app_id), ...date_match };
    return ListingSourceDailyModel.aggregate([
        { $match: match },
        {
            $group: {
                _id: { source: '$traffic_source', medium: '$traffic_medium' },
                users: { $sum: '$users' },
                views: { $sum: '$views' },
                install_clicks: { $sum: '$install_clicks' },
                installs: { $sum: '$installs' }
            }
        },
        {
            $project: {
                _id: 0,
                traffic_source: '$_id.source',
                traffic_medium: '$_id.medium',
                users: 1,
                views: 1,
                install_clicks: 1,
                installs: 1,
                // THE ELSE BRANCH IS `null`, NEVER `0`. This is `safeDiv` written in Mongo's
                // aggregation language, and it shipped the same defect: the SQL behind
                // `gi_listing_source_dailies` deliberately keeps install-only buckets (a merchant
                // whose first-ever acquisition was this source, converting on a visit GA4 filed
                // elsewhere), so `views: 0, installs: 7` is a REAL row — and it published
                // "Installs 7 · Install rate 0.00%", a self-contradiction inside one table row.
                //
                // ⚠️ A MEASURED ZERO STILL REACHES THE READER: `views: 500, installs: 0` takes the
                // THEN branch, divides, and publishes `0`. Only an absent denominator is null.
                //
                // ⚠️ `$gt: ['$views', 0]` is also the null guard. Mongo orders null BELOW every
                // number, so a missing or null `views` is not `> 0` and takes the else branch —
                // which is what we want, and is why this is not written as `$ne: 0`.
                install_rate: {
                    $cond: [{ $gt: ['$views', 0] }, { $divide: ['$installs', '$views'] }, null]
                }
            }
        },
        { $sort: { installs: -1, views: -1 } },
        { $limit: limit || 50 }
    ]);
};

/**
 * Countries over the window, heaviest first.
 *
 * @param params0 - See {@link RollupReadInput}; `limit` is already clamped by the caller.
 * @returns One row per country.
 */
const aggregateGeoBreakdown = async ({ partner_app_id, date_match, limit }: RollupReadInput): Promise<GeoBreakdownItem[]> => {
    const match = { partner_app_id: toObjectId(partner_app_id), ...date_match };
    return ListingGeoDailyModel.aggregate([
        { $match: match },
        {
            $group: {
                _id: '$country',
                views: { $sum: '$views' },
                installs: { $sum: '$installs' }
            }
        },
        {
            $project: {
                _id: 0,
                country: '$_id',
                views: 1,
                installs: 1,
                // `null`, never `0` — the same rule and the same reasons as `install_rate`
                // above. A country row with installs and no views publishes an em dash; a country
                // with views and no installs publishes a measured `0`.
                conversion_rate: {
                    $cond: [{ $gt: ['$views', 0] }, { $divide: ['$installs', '$views'] }, null]
                }
            }
        },
        { $sort: { installs: -1, views: -1 } },
        { $limit: limit || 50 }
    ]);
};

export = {
    upsertFunnelDays,
    upsertSourceDays,
    upsertGeoDays,
    findFunnelTrend,
    aggregateFunnelTotals,
    aggregateSourceBreakdown,
    aggregateGeoBreakdown
};
