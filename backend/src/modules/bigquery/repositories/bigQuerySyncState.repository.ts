'use strict';

/**
 * ============================================================================
 *  SYNC STATE — the app row this module reads, and the two watermarks it stamps
 * ============================================================================
 *
 *  TWO WATERMARKS, TWO FAILURE DOMAINS, and they must never be merged.
 *
 *    `last_bq_synced_at`             — the three cheap daily rollups.
 *    `last_install_attrib_synced_at` — the per-install attribution pull, which reads the whole
 *                                      `event_params` column and is a far heavier scan.
 *
 *  Folding the second into the first would make one expensive failure force the three cheap rollups
 *  to re-run their LIFETIME backfill forever — and a LIFETIME backfill is the most expensive thing
 *  this module can do.
 *
 *  ⚠️ A watermark is stamped ONLY after a fully successful run. `resolveSyncWindow` reads it to pick
 *  LIFETIME vs INCREMENTAL, so stamping after a partial pull permanently skips the window that
 *  failed: nothing revisits it, and the hole is invisible from then on.
 *
 *  This module reads the app row through its OWN repository rather than the partner module's. That
 *  duplicates a one-line `findById`, deliberately: a module reaching into another module's data
 *  access is how the layer boundary stops being checkable, and the partner barrel does not publish
 *  its repositories precisely so this question has one answer.
 * ============================================================================
 */

import models = require('../../shared/repositories/models.repository');

import type { PartnerAppDoc } from '../../shared/types/entity.types';

const { PartnerAppModel } = models;

/**
 * Loads the app a sync is about to run for.
 *
 * @param partner_app_id - The `_id` of the app row.
 * @returns The lean document, or null when no such row exists.
 */
const findSyncTargetApp = async (partner_app_id: string): Promise<PartnerAppDoc | null> => {
    return PartnerAppModel.findById(partner_app_id).lean();
};

/**
 * Stamps the ROLLUP watermark after a fully successful `runDailySync`.
 *
 * @param partner_app_id - The app row to update.
 * @param synced_at - End of the window this run covered.
 */
const stampRollupWatermark = async (partner_app_id: string, synced_at: Date): Promise<void> => {
    await PartnerAppModel.updateOne({ _id: partner_app_id }, { $set: { last_bq_synced_at: synced_at } });
};

/**
 * Stamps the ATTRIBUTION watermark after a fully successful `syncInstallAttribution`.
 *
 * @param partner_app_id - The app row to update.
 * @param synced_at - End of the window this run covered.
 */
const stampInstallAttributionWatermark = async (partner_app_id: string, synced_at: Date): Promise<void> => {
    await PartnerAppModel.updateOne({ _id: partner_app_id }, { $set: { last_install_attrib_synced_at: synced_at } });
};

export = {
    findSyncTargetApp,
    stampRollupWatermark,
    stampInstallAttributionWatermark
};
