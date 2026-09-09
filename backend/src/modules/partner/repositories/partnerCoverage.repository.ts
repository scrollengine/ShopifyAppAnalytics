'use strict';

/**
 * ============================================================================
 *  COVERAGE — the gathering half
 * ============================================================================
 *
 *  Reads the extremes and counts that `helpers/coverage.helper` folds into the
 *  six coverage gates. Everything here is a query; every decision made from
 *  these numbers is in the helper, which is pure and unit-testable without a
 *  database.
 *
 *   Every `$match` casts `partner_app_id` through `toObjectId`. Aggregations
 *  do NOT auto-cast the way `find` does, so an uncast string id matches ZERO
 *  documents and raises no error — the pipeline just returns `[]`. On this
 *  file specifically that failure is malicious: an empty result set would be
 *  read as "no events at all", the coverage gates would all be stamped `null`,
 *  and the honesty layer would then refuse to publish figures that are in fact
 *  perfectly well covered.
 * ============================================================================
 */

import models = require('../../shared/repositories/models.repository');
import constants = require('../constants/partnerSync.constants');

import type { ObjectIdLike } from '../../shared/types/entity.types';
import type { CoverageInputs, TransactionChargeRowCount } from '../types/coverage.types';

const { PartnerAppEventModel, PartnerAppTransactionModel, toObjectId } = models;
const { CHARGE_LINKED_EVENT_TYPES, CHARGE_BEARING_TRANSACTION_TYPES } = constants;

/**
 * Reads a single date off the first row of a one-document projection.
 *
 * @param rows - The `.limit(1)` result.
 * @param field - Which date field to read.
 * @returns The date, or null when the collection holds nothing for this app.
 */
const _firstDate = (rows: any[], field: string): Date | null => {
    if (!Array.isArray(rows) || rows.length === 0) {
        return null;
    }
    const _value = rows[0] && rows[0][field];
    if (!_value) {
        return null;
    }
    const _date = new Date(_value);
    if (Number.isNaN(_date.getTime())) {
        return null;
    }
    return _date;
};

/**
 * Gathers everything the coverage computation needs, in one round of parallel queries.
 *
 * Scoped to the whole collection for this app rather than to a window: coverage describes the
 * RECORD, not a report. Narrowing it to a window would answer a different question, and a
 * well-covered window would then hide a hole immediately outside it.
 *
 * `$group` is used where `distinct` would read more naturally, on purpose. `distinct` returns its
 * whole answer inside one document and is therefore capped at 16MB — an app with a very long
 * history would start failing at exactly the moment its coverage mattered most. An aggregation
 * streams through a cursor and has no such ceiling.
 *
 * @param params0 - The scope.
 * @param params0.partner_app_id - The app's `_id`.
 * @returns Extremes (including the store-name boundary), day buckets, link counts and both charge-id sets.
 */
const collectCoverageInputs = async ({ partner_app_id }: { partner_app_id: ObjectIdLike }): Promise<CoverageInputs> => {
    const _appObjectId = toObjectId(partner_app_id);

    const [
        earliestEventRows,
        earliestTransactionRows,
        earliestNamedEventRows,
        eventDayRows,
        eventLinkRows,
        transactionLinkRows,
        eventChargeRows,
        transactionChargeRows
    ] = await Promise.all([
        // The two floors. Index-served (`idx_app_occurred` / `idx_app_created`), so each is a single
        // index seek rather than a scan.
        PartnerAppEventModel.find({ partner_app_id: _appObjectId })
            .sort({ occurred_at: 1 })
            .limit(1)
            .select('occurred_at')
            .lean(),
        PartnerAppTransactionModel.find({ partner_app_id: _appObjectId })
            .sort({ created_at: 1 })
            .limit(1)
            .select('created_at')
            .lean(),

        // THE STORE-NAME BACKFILL BOUNDARY — the oldest event that actually carries a `shop_name`.
        //
        //  `$exists: true` IS LOAD-BEARING, AND `{ shop_name: { $ne: '' } }` ALONE IS THE BUG IT
        // PREVENTS. `shop_name` was added after this collection was in use, so every row written
        // before it HAS NO SUCH FIELD — and in Mongo a missing field is not equal to `''`, so a
        // bare `$ne` matches all of them. The measurement would then invert: an app that has never
        // re-synced would report its very first event as the coverage boundary, the read layer
        // would conclude every name is present, and the one deployment that most needs the "run a
        // LIFETIME sync" sentence is the one that would never see it.
        //
        // Ordering is served by `idx_app_occurred`; `shop_name` is a residual filter on the fetch,
        // and the walk stops at the first match. The only expensive case is an app with NO named
        // rows at all — which is exactly the app that has not re-synced since the `name` selection
        // landed, and it pays one scan per sync until it does.
        PartnerAppEventModel.find({ partner_app_id: _appObjectId, shop_name: { $exists: true, $ne: '' } })
            .sort({ occurred_at: 1 })
            .limit(1)
            .select('occurred_at')
            .lean(),

        // Distinct UTC days carrying at least one event. Days rather than raw timestamps: the gap is
        // measured in whole days, and this collapses a six-figure event history into a few thousand
        // buckets that a pure helper can walk.
        PartnerAppEventModel.aggregate([
            { $match: { partner_app_id: _appObjectId } },
            { $group: { _id: { $dateTrunc: { date: '$occurred_at', unit: 'day' } } } },
            { $sort: { _id: 1 } }
        ]),

        // How many rows COULD carry a charge link, and how many of them carry none.
        //
        //  The `$in` is what makes this measure the DATA rather than the API's schema. Only event
        // types whose `charge { … }` fragment the sync actually requests are counted; an install has
        // no charge and a usage-charge event is not asked for one, so folding either in would report
        // a permanent, unfixable "missing links" figure that nobody could ever drive to zero.
        PartnerAppEventModel.aggregate([
            { $match: { partner_app_id: _appObjectId, event_type: { $in: CHARGE_LINKED_EVENT_TYPES } } },
            {
                $group: {
                    _id: null,
                    rows: { $sum: 1 },
                    absent: { $sum: { $cond: [{ $eq: ['$charge_id', ''] }, 1, 0] } }
                }
            }
        ]),
        PartnerAppTransactionModel.aggregate([
            { $match: { partner_app_id: _appObjectId, type: { $in: CHARGE_BEARING_TRANSACTION_TYPES } } },
            {
                $group: {
                    _id: null,
                    rows: { $sum: 1 },
                    absent: { $sum: { $cond: [{ $eq: ['$charge_id', ''] }, 1, 0] } }
                }
            }
        ]),

        // The two sides of the charge bridge. Events give the set of subscriptions we know about;
        // transactions give each settled charge with how many payouts hang off it, so the dangling
        // share can be weighted by rows rather than by distinct charge.
        PartnerAppEventModel.aggregate([
            { $match: { partner_app_id: _appObjectId, charge_id: { $ne: '' } } },
            { $group: { _id: '$charge_id' } }
        ]),
        PartnerAppTransactionModel.aggregate([
            {
                $match: {
                    partner_app_id: _appObjectId,
                    type: { $in: CHARGE_BEARING_TRANSACTION_TYPES },
                    charge_id: { $ne: '' }
                }
            },
            { $group: { _id: '$charge_id', rows: { $sum: 1 } } }
        ])
    ]);

    const _eventDayBuckets: Date[] = [];
    for (const row of eventDayRows) {
        if (row && row._id) {
            _eventDayBuckets.push(row._id);
        }
    }

    const _eventChargeIds: string[] = [];
    for (const row of eventChargeRows) {
        if (row && row._id) {
            _eventChargeIds.push(String(row._id));
        }
    }

    const _transactionChargeRowCounts: TransactionChargeRowCount[] = [];
    for (const row of transactionChargeRows) {
        if (row && row._id) {
            _transactionChargeRowCounts.push({ charge_id: String(row._id), rows: Number(row.rows) || 0 });
        }
    }

    const _eventLink = (eventLinkRows && eventLinkRows[0]) || { rows: 0, absent: 0 };
    const _transactionLink = (transactionLinkRows && transactionLinkRows[0]) || { rows: 0, absent: 0 };

    return {
        earliest_event_at: _firstDate(earliestEventRows, 'occurred_at'),
        earliest_transaction_at: _firstDate(earliestTransactionRows, 'created_at'),
        earliest_named_event_at: _firstDate(earliestNamedEventRows, 'occurred_at'),
        event_day_buckets: _eventDayBuckets,
        charge_linked_event_rows: Number(_eventLink.rows) || 0,
        charge_linked_event_rows_without_charge_id: Number(_eventLink.absent) || 0,
        charge_bearing_transaction_rows: Number(_transactionLink.rows) || 0,
        charge_bearing_transaction_rows_without_charge_id: Number(_transactionLink.absent) || 0,
        event_charge_ids: _eventChargeIds,
        transaction_charge_row_counts: _transactionChargeRowCounts
    };
};

export = {
    collectCoverageInputs
};
