'use strict';

/**
 * ============================================================================
 *  PARTNER FACTS — the write side
 * ============================================================================
 *
 *  Upserts events and transactions in chunks. The service maps and normalises;
 *  this file decides what a write actually SETS, and that decision is the most
 *  load-bearing thing in the module.
 *
 *  ── THE IDENTITY / PAYLOAD SPLIT ────────────────────────────────────────────
 *  Every upsert below is deliberately in two halves:
 *
 *    $setOnInsert — the fields that PARTICIPATE IN THE ROW'S IDENTITY. For an
 *      existing row they cannot legitimately differ, because the filter matched
 *      on a key derived from them. Writing them again on every sync would be a
 *      no-op write on the largest collections in the database.
 *
 *    $set — everything else, REWRITTEN ON EVERY SYNC so that a re-sync can
 *      REPAIR a row.
 *
 *  Putting the whole document under $setOnInsert (which is where this started)
 *  means a MATCHED row is never written again for the rest of its life. Two
 *  fields were added to the transaction schema after the collection was already
 *  in use — `billing_interval` and `charge_id` — and every pre-existing row had
 *  neither. An MRR fold reads a null interval as MONTHLY, so an ANNUAL
 *  subscriber sitting on a legacy row is booked at twelve times its true rate,
 *  permanently, in every figure the ledger feeds. The advice everyone gives for
 *  that — "run a lifetime re-sync" — was impossible to carry out until this
 *  split existed.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import models = require('../../shared/repositories/models.repository');
import constants = require('../constants/partnerSync.constants');

import type { AnyBulkWriteOperation, Model } from 'mongoose';
import type { ObjectIdLike } from '../../shared/types/entity.types';
import type { BulkWriteTally, PartnerEventUpsertRow, PartnerTransactionUpsertRow } from '../types/partnerSync.types';

const { customConsoleError } = logger;
const { PartnerAppEventModel, PartnerAppTransactionModel, toObjectId } = models;
const { BULK_WRITE_CHUNK_SIZE } = constants;

/**
 * The subset of a failed bulkWrite this file reads.
 *
 * `catch` binds `unknown`, and every field is optional, so each access stays guarded. The driver
 * reports partial success two ways depending on version (`upsertedCount` / `nUpserted`), and both
 * are read — an unread count is a row that was written and never accounted for.
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
 * Executes bulkWrite operations in chunks and returns an aggregate tally.
 *
 * `ordered: false` so a duplicate-key error does not halt the batch — the whole point of these
 * upserts is idempotency, and a re-sync is EXPECTED to collide with rows it already wrote.
 *
 * Rows that neither upserted nor matched are counted as errors rather than ignored. A sync that
 * silently loses rows reports success over data it never wrote, which is the failure mode this
 * project exists to make impossible.
 *
 * `Model<any>` rather than a generic: this helper deliberately runs against both collections, and
 * mongoose types `bulkWrite`'s argument through a conditional on the model's own document type,
 * which an unresolved type parameter cannot satisfy.
 *
 * @param model - The mongoose model to write through.
 * @param ops - Bulk operations, already built by the caller.
 * @returns Upserted, matched and unaccounted-for counts.
 */
const _runBulkWrite = async (model: Model<any>, ops: AnyBulkWriteOperation[]): Promise<BulkWriteTally> => {
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
            customConsoleError('ERROR: [Partner:Facts] bulkWrite chunk failed', {
                model: model.modelName,
                chunk_start: i,
                chunk_size: chunk.length,
                message: _writeErrorMessage
            });
        }
    }

    return { upserted, matched, errors };
};

/**
 * Upserts partner events, keyed on the locally-computed `partner_event_id`.
 *
 * ── What is identity here, and why ──
 * `partner_event_id` is a sha256 over (app, typename, occurred_at, shop_id, shop_domain,
 * charge_id). Every one of those SIX values feeds the hash, so for a row the filter matched they
 * cannot legitimately differ — which is exactly why they sit under `$setOnInsert`.
 *
 * `shop_name` is PAYLOAD, and had to be: it was added after the collection was in use, it is not in
 * the hash, and a re-sync is the only thing that can ever fill it in on the rows already stored.
 *
 * ⚠️ The consequence of putting `charge_id` in the hash: an event first stored WITHOUT its charge
 * block cannot be repaired by re-syncing, because the same event re-pulled WITH a charge hashes
 * differently and inserts a second row. That is the price of the discriminator, and it is the right
 * trade — without it, a plan change (an ACCEPTED for the new charge in the same second the old one
 * is cancelled) collapsed two real events into one and silently understated every count built on
 * them. Anyone adding a new inline fragment to the events query that feeds the hash inherits the
 * same constraint: it needs a full re-sync, not an incremental one.
 *
 * @param params0 - The batch.
 * @param params0.partner_app_id - The owning app's `_id`.
 * @param params0.rows - Rows already mapped, normalised and hashed by the service.
 * @returns What the write actually did.
 */
const bulkUpsertPartnerEvents = async ({ partner_app_id, rows }: { partner_app_id: ObjectIdLike; rows: PartnerEventUpsertRow[] }): Promise<BulkWriteTally> => {
    const _appObjectId = toObjectId(partner_app_id);
    const ops: AnyBulkWriteOperation[] = rows.map((row) => ({
        updateOne: {
            filter: { partner_event_id: row.partner_event_id },
            update: {
                // IDENTITY — every one of these feeds the hash in the filter. Written once.
                $setOnInsert: {
                    partner_event_id: row.partner_event_id,
                    partner_app_id: _appObjectId,
                    shop_domain: row.shop_domain,
                    shop_id: row.shop_id,
                    occurred_at: row.occurred_at,
                    charge_id: row.charge_id
                },
                // PAYLOAD — rewritten every sync, so a re-sync can repair a row whose mapping or
                // raw payload was stored by an older build.
                //
                //  `shop_name` BELONGS HERE AND NOWHERE ELSE. It was added after this collection
                // was already in use, so every pre-existing row lacks it; under `$setOnInsert` it
                // would be written only on rows that do not yet exist, which is to say never on the
                // rows that need it, and NO re-sync of any mode could ever fill them. That is not a
                // hypothetical — it is precisely what left `billing_interval` null on every legacy
                // transaction row below, booking annual subscribers at twelve times their true rate
                // until the split this comment describes existed. It is safe here only because
                // `shop_name` is NOT an input to `partner_event_id` (see `_hashEventId`: six
                // inputs, and this is not one), so re-syncing an existing row updates it in place
                // rather than inserting a second copy under a new key.
                $set: {
                    event_type: row.event_type,
                    shop_name: row.shop_name,
                    raw_event: row.raw_event
                }
            },
            upsert: true
        }
    }));

    return _runBulkWrite(PartnerAppEventModel, ops);
};

/**
 * Upserts settled transactions, keyed on Shopify's own `shopify_transaction_id`.
 *
 * ── What is identity here, and why it differs from the events side ──
 * The filter is the transaction id ALONE, and a Shopify transaction id belongs to exactly one app
 * and settles at exactly one instant — so only those three fields are identity.
 *
 * `shop_domain` / `shop_id` are PAYLOAD here, unlike their twins on the event side where they feed
 * the dedupe hash and therefore cannot differ. That is deliberate: it makes a row written while the
 * `shop` block was absent repairable, and every shop-keyed money figure joins on `shop_domain`. A
 * domain that fails to join does not render a smaller number — it drops that store's revenue out of
 * the total entirely.
 *
 * @param params0 - The batch.
 * @param params0.partner_app_id - The owning app's `_id`.
 * @param params0.rows - Rows already mapped and normalised by the service.
 * @returns What the write actually did.
 */
const bulkUpsertPartnerTransactions = async ({ partner_app_id, rows }: { partner_app_id: ObjectIdLike; rows: PartnerTransactionUpsertRow[] }): Promise<BulkWriteTally> => {
    const _appObjectId = toObjectId(partner_app_id);
    const ops: AnyBulkWriteOperation[] = rows.map((row) => ({
        updateOne: {
            filter: { shopify_transaction_id: row.shopify_transaction_id },
            update: {
                // IDENTITY — the transaction id IS the dedupe key (and the collection's named unique
                // index). Neither the owning app nor the settlement instant can differ for a row
                // this filter matched.
                $setOnInsert: {
                    shopify_transaction_id: row.shopify_transaction_id,
                    partner_app_id: _appObjectId,
                    created_at: row.created_at
                },
                // PAYLOAD — rewritten every sync. `billing_interval` and `charge_id` in particular:
                // both were added after this collection was in use, and until they were moved out of
                // $setOnInsert no re-sync could ever backfill them.
                $set: {
                    type: row.type,
                    shop_domain: row.shop_domain,
                    shop_id: row.shop_id,
                    billing_interval: row.billing_interval,
                    charge_id: row.charge_id,
                    net_amount: row.net_amount,
                    gross_amount: row.gross_amount,
                    shopify_fee: row.shopify_fee,
                    raw_transaction: row.raw_transaction
                }
            },
            upsert: true
        }
    }));

    return _runBulkWrite(PartnerAppTransactionModel, ops);
};

export = {
    bulkUpsertPartnerEvents,
    bulkUpsertPartnerTransactions
};
