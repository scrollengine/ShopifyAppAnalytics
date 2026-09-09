'use strict';

/**
 * ============================================================================
 *  PER-INSTALL ATTRIBUTION — the write side
 * ============================================================================
 *
 *  One row per install event. The only per-store record the listing side has, and the bridge from
 *  listing analytics to the Partner event spine through the normalised `shop_domain`.
 *
 *  ── THE IDENTITY / PAYLOAD SPLIT ────────────────────────────────────────────
 *  `$setOnInsert` holds the three fields that ARE the row's identity — (app, shop_domain,
 *  installed_at) — which for a matched row cannot legitimately differ, because the filter matched on
 *  exactly them. Everything else is `$set`, REWRITTEN on every sync, so a re-run REPAIRS a row
 *  rather than leaving the first (possibly worse) reading in place forever. That matters more here
 *  than anywhere else in the module: the surface stitch improved once already, and every historical
 *  row was recoverable only because the payload is rewritten.
 *
 *  ⚠️ `installed_at` is part of the key and comes from `TIMESTAMP_MICROS(event_timestamp)` — a
 *  microsecond instant. Two installs by the same shop at genuinely different times are two rows,
 *  which is correct: a merchant who uninstalls and reinstalls did install twice.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import models = require('../../shared/repositories/models.repository');
import constants = require('../constants/bigQuery.constants');

import type { AnyBulkWriteOperation } from 'mongoose';
import type { InstallAttributionRow, ListingWriteTally } from '../types/bigQuery.types';

const { customConsoleError } = logger;
const { ListingInstallAttributionModel, toObjectId } = models;
const { BULK_WRITE_CHUNK_SIZE } = constants;

/** See the identical shape in `listingRollup.repository` — the driver reports partial success two ways. */
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
 * Upserts install-attribution rows in chunks.
 *
 * `upserted + matched` is the accounted-for count, and `errors` is every row that was neither. A
 * re-sync that finds identical values modifies nothing, so a counter built on `modifiedCount` would
 * report a correct re-run as having written nothing — see the same note in
 * `listingRollup.repository`.
 *
 * @param partner_app_id - The app these installs belong to.
 * @param rows - Fully resolved install rows.
 * @returns What the write accounted for.
 */
const bulkUpsertInstallAttributions = async (partner_app_id: string, rows: InstallAttributionRow[]): Promise<ListingWriteTally> => {
    const _appId = toObjectId(partner_app_id);
    const ops: AnyBulkWriteOperation[] = rows.map((row) => ({
        updateOne: {
            filter: {
                partner_app_id: _appId,
                shop_domain: row.shop_domain,
                installed_at: row.installed_at
            },
            update: {
                $setOnInsert: {
                    partner_app_id: _appId,
                    shop_domain: row.shop_domain,
                    installed_at: row.installed_at
                },
                // Everything else is REWRITTEN, so a re-run repairs a row rather than leaving the
                // first (possibly worse) reading in place forever.
                $set: {
                    shop_url_raw: row.shop_url_raw,
                    shop_id: row.shop_id,
                    shop_name: row.shop_name,
                    install_date: row.install_date,
                    user_pseudo_id: row.user_pseudo_id,
                    source: row.source,
                    medium: row.medium,
                    campaign: row.campaign,
                    attribution_source: row.attribution_source,
                    surface_type: row.surface_type,
                    surface_detail: row.surface_detail,
                    surface_inter_position: row.surface_inter_position,
                    surface_intra_position: row.surface_intra_position,
                    surface_via: row.surface_via,
                    surface_version: row.surface_version,
                    ad_clicks_before_install: row.ad_clicks_before_install,
                    country: row.country,
                    locale: row.locale,
                    sync_job_id: row.sync_job_id
                }
            },
            upsert: true
        }
    }));

    let upserted = 0;
    let matched = 0;
    let errors = 0;

    for (let i = 0; i < ops.length; i += BULK_WRITE_CHUNK_SIZE) {
        const chunk = ops.slice(i, i + BULK_WRITE_CHUNK_SIZE);
        try {
            const r = await ListingInstallAttributionModel.bulkWrite(chunk, { ordered: false });
            upserted += r.upsertedCount || 0;
            matched += r.matchedCount || 0;
        } catch (writeError) {
            // ordered:false means the good rows in the chunk still landed; count what did.
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
            customConsoleError('Install-attribution bulkWrite chunk failed', {
                chunk_start: i,
                chunk_size: chunk.length,
                message: _writeErrorMessage
            });
        }
    }

    return { upserted, matched, errors };
};

export = {
    bulkUpsertInstallAttributions
};
