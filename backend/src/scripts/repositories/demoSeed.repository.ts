'use strict';

/**
 * ============================================================================
 *  DEMO DATASET — the only file in `src/scripts` that touches a model
 * ============================================================================
 *
 *  The layer guard in `eslint.config.js` exempts `repositories/` because
 *  repositories are the single boundary allowed to reach mongoose. That applies
 *  to a script exactly as it applies to a module: the generator stays pure, the
 *  service stays testable, and every query the seeder issues is in this one file
 *  where it can be read at a glance.
 *
 *  ── ⚠️ EVERY WRITE HERE IS SCOPED TO ONE `partner_app_id` ──────────────────
 *
 *  There is no unscoped `deleteMany` in this file and there must never be one.
 *  The teardown's whole promise is that it removes exactly what the seeder
 *  wrote and nothing else, and the only thing making that true is that every
 *  delete carries the demo app's id. A `deleteMany({})` here — even "just for
 *  the demo collections" — would take a self-hoster's real history with it.
 * ============================================================================
 */

import models = require('../../modules/shared/repositories/models.repository');

import type { Model } from 'mongoose';
import type { PartnerAppDoc } from '../../modules/shared/types/entity.types';
import type { DemoRowCounts } from '../types/demoSeed.types';

const {
    PartnerAppModel,
    PartnerAppEventModel,
    PartnerAppTransactionModel,
    ListingFunnelDailyModel,
    ListingSourceDailyModel,
    ListingGeoDailyModel,
    ListingInstallAttributionModel,
    SyncJobModel,
    toObjectId
} = models;

/** How many documents go into one `insertMany`. Matches the sync's own bulk chunk size. */
const INSERT_CHUNK_SIZE = 1000;

/**
 * The ANALYTICS collections — the ones that hold somebody's history.
 *
 * Enumerated rather than derived, for the same reason the model registry is
 * enumerated: a collection that silently drops off this list is one the teardown
 * stops cleaning, and the only symptom is orphaned rows nobody can attribute.
 */
const _FACT_COLLECTIONS: ReadonlyArray<{ label: string; model: Model<any> }> = Object.freeze([
    { label: 'events', model: PartnerAppEventModel as Model<any> },
    { label: 'transactions', model: PartnerAppTransactionModel as Model<any> },
    { label: 'funnel_days', model: ListingFunnelDailyModel as Model<any> },
    { label: 'source_days', model: ListingSourceDailyModel as Model<any> },
    { label: 'geo_days', model: ListingGeoDailyModel as Model<any> },
    { label: 'attributions', model: ListingInstallAttributionModel as Model<any> }
]);

/**
 * Everything the seeder writes and the teardown removes — the facts, plus the
 * run history.
 *
 * ⚠️ `gi_sync_jobs` IS WRITTEN AND REMOVED, BUT IT IS NOT PART OF THE SAFETY
 * GATE, and the difference is deliberate. A sync job is operational bookkeeping,
 * not analytics history: it says the deployment has been started, never that it
 * holds somebody's revenue. And `partner_app_id` is OPTIONAL on that schema, so
 * a job with no app scope matches `{ partner_app_id: { $ne: <demo app> } }` —
 * which would make the gate refuse on any deployment that has ever booted, on
 * the strength of a row nobody could mistake for data.
 */
const _SCOPED_COLLECTIONS: ReadonlyArray<{ label: string; model: Model<any> }> = Object.freeze([
    ..._FACT_COLLECTIONS,
    { label: 'sync_jobs', model: SyncJobModel as Model<any> }
]);

/**
 * Finds the demo app row by its Partner GID.
 *
 * Looked up by `partner_api_app_id` because that is the field carrying the
 * unique index — the same lookup `registerPartnerAppFromConfig` does. Whether
 * the row found is actually the SEEDER'S is a question about its marker, and
 * that is the service's decision, not this file's.
 *
 * @param params0 - Lookup.
 * @param params0.partner_api_app_id - `gid://partners/App/<digits>`.
 * @returns The row, or null.
 */
const findAppByGid = async ({ partner_api_app_id }: { partner_api_app_id: string }): Promise<PartnerAppDoc | null> => {
    return PartnerAppModel.findOne({ partner_api_app_id }).lean();
};

/**
 * Counts app rows that are NOT the demo app, and how many of those have never synced.
 *
 * This is half the safety gate. A second app row means somebody has registered
 * their own Shopify app against this database, and a seeder that carries on is
 * writing fiction into a deployment that holds facts.
 *
 * ⚠️ `never_synced` exists to make the most likely FALSE ALARM legible. The
 * backend registers an app row at boot from `SHOPIFY_PARTNER_APP_ID`, so a
 * self-hoster who set that variable and then started the server has a foreign
 * app row and an otherwise empty database. Without this count the refusal says
 * "you already have data" to somebody who does not, and the only honest reply is
 * to say WHICH kind of foreign row was found.
 *
 * @param params0 - Scope.
 * @param params0.demo_app_id - The demo app's `_id`, or null when it does not exist yet.
 * @returns `{ total, never_synced }`.
 */
const summariseForeignApps = async ({ demo_app_id }: { demo_app_id: string | null }): Promise<{ total: number; never_synced: number }> => {
    const filter: Record<string, unknown> = demo_app_id ? { _id: { $ne: toObjectId(demo_app_id) } } : {};
    const total = await PartnerAppModel.countDocuments(filter);
    const neverSynced = await PartnerAppModel.countDocuments({ ...filter, last_synced_at: null });
    return { total, never_synced: neverSynced };
};

/**
 * Counts fact rows belonging to any app other than the demo one.
 *
 * The other half of the gate, and the one that catches the case the app count
 * misses: an app row deleted by hand leaves its events, its payouts and its
 * listing rollups behind, and those are still somebody's real history.
 *
 * @param params0 - Scope.
 * @param params0.demo_app_id - The demo app's `_id`, or null.
 * @returns Foreign row count per collection.
 */
const countForeignRows = async ({ demo_app_id }: { demo_app_id: string | null }): Promise<DemoRowCounts> => {
    const filter = demo_app_id ? { partner_app_id: { $ne: toObjectId(demo_app_id) } } : {};
    const counts: DemoRowCounts = {};
    // ⚠️ FACT COLLECTIONS ONLY. See the note on `_SCOPED_COLLECTIONS`.
    for (const entry of _FACT_COLLECTIONS) {
        counts[entry.label] = await entry.model.countDocuments(filter);
    }
    return counts;
};

/**
 * Counts rows belonging to the demo app.
 *
 * @param params0 - Scope.
 * @param params0.demo_app_id - The demo app's `_id`.
 * @returns Row count per collection.
 */
const countDemoRows = async ({ demo_app_id }: { demo_app_id: string }): Promise<DemoRowCounts> => {
    const filter = { partner_app_id: toObjectId(demo_app_id) };
    const counts: DemoRowCounts = {};
    for (const entry of _SCOPED_COLLECTIONS) {
        counts[entry.label] = await entry.model.countDocuments(filter);
    }
    return counts;
};

/**
 * Creates or updates the demo app row, keyed on its Partner GID.
 *
 * `upsert` rather than create-if-missing so a re-run repairs a row somebody has
 * edited by hand, and so the marker in `metadata` is rewritten every time —
 * a demo app whose marker was cleared would become invisible to its own teardown.
 *
 * @param params0 - The row.
 * @param params0.partner_api_app_id - The GID the row is keyed on.
 * @param params0.fields - Everything except `_id`.
 * @returns The stored row.
 */
const upsertDemoApp = async ({ partner_api_app_id, fields }: {
    partner_api_app_id: string;
    fields: Record<string, unknown>;
}): Promise<PartnerAppDoc> => {
    const stored = await PartnerAppModel.findOneAndUpdate(
        { partner_api_app_id },
        { $set: fields },
        { new: true, upsert: true, runValidators: true }
    ).lean();
    // `new: true` with `upsert: true` always returns a document; the cast states
    // that rather than pushing a null check onto every caller.
    return stored as PartnerAppDoc;
};

/**
 * Deletes every fact row scoped to one app.
 *
 * ⚠️ SCOPED BY `partner_app_id`, ALWAYS. See the file header.
 *
 * @param params0 - Scope.
 * @param params0.demo_app_id - The app whose rows go.
 * @returns How many rows each collection lost.
 */
const deleteRowsForApp = async ({ demo_app_id }: { demo_app_id: string }): Promise<DemoRowCounts> => {
    const filter = { partner_app_id: toObjectId(demo_app_id) };
    const removed: DemoRowCounts = {};
    for (const entry of _SCOPED_COLLECTIONS) {
        const result = await entry.model.deleteMany(filter);
        removed[entry.label] = result.deletedCount || 0;
    }
    return removed;
};

/**
 * Deletes the app row itself.
 *
 * @param params0 - Scope.
 * @param params0.demo_app_id - The app row to remove.
 * @returns 1 when it was there, 0 when it was not.
 */
const deleteApp = async ({ demo_app_id }: { demo_app_id: string }): Promise<number> => {
    const result = await PartnerAppModel.deleteOne({ _id: toObjectId(demo_app_id) });
    return result.deletedCount || 0;
};

/** Inserts documents in chunks, stamping the app id onto each. */
const _insertScoped = async (model: Model<any>, demo_app_id: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<number> => {
    const appId = toObjectId(demo_app_id);
    let inserted = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE).map((row) => ({ ...row, partner_app_id: appId }));
        const written = await model.insertMany(chunk, { ordered: false });
        inserted += written.length;
    }
    return inserted;
};

/** Inserts partner events for the demo app. */
const insertEvents = async ({ demo_app_id, rows }: { demo_app_id: string; rows: ReadonlyArray<Record<string, unknown>> }): Promise<number> => {
    return _insertScoped(PartnerAppEventModel as Model<any>, demo_app_id, rows);
};

/** Inserts settled payouts for the demo app. */
const insertTransactions = async ({ demo_app_id, rows }: { demo_app_id: string; rows: ReadonlyArray<Record<string, unknown>> }): Promise<number> => {
    return _insertScoped(PartnerAppTransactionModel as Model<any>, demo_app_id, rows);
};

/** Inserts the daily listing funnel rollup. */
const insertFunnelDays = async ({ demo_app_id, rows }: { demo_app_id: string; rows: ReadonlyArray<Record<string, unknown>> }): Promise<number> => {
    return _insertScoped(ListingFunnelDailyModel as Model<any>, demo_app_id, rows);
};

/** Inserts the daily (source, medium) rollup. */
const insertSourceDays = async ({ demo_app_id, rows }: { demo_app_id: string; rows: ReadonlyArray<Record<string, unknown>> }): Promise<number> => {
    return _insertScoped(ListingSourceDailyModel as Model<any>, demo_app_id, rows);
};

/** Inserts the daily country rollup. */
const insertGeoDays = async ({ demo_app_id, rows }: { demo_app_id: string; rows: ReadonlyArray<Record<string, unknown>> }): Promise<number> => {
    return _insertScoped(ListingGeoDailyModel as Model<any>, demo_app_id, rows);
};

/** Inserts per-install attribution rows. */
const insertAttributions = async ({ demo_app_id, rows }: { demo_app_id: string; rows: ReadonlyArray<Record<string, unknown>> }): Promise<number> => {
    return _insertScoped(ListingInstallAttributionModel as Model<any>, demo_app_id, rows);
};

/** Inserts the completed sync-run history. */
const insertSyncJobs = async ({ demo_app_id, rows }: { demo_app_id: string; rows: ReadonlyArray<Record<string, unknown>> }): Promise<number> => {
    return _insertScoped(SyncJobModel as Model<any>, demo_app_id, rows);
};

/**
 * Writes the watermarks and coverage gates onto the app row.
 *
 * ⚠️ Without these every page correctly answers NEVER_SYNCED and renders a
 * banner instead of the data — `last_synced_at` is what separates "nobody has
 * installed this app" from "we have not looked yet", and no row count can tell
 * them apart. A seeded dataset with null watermarks is a dataset nothing will
 * display.
 *
 * @param params0 - The write.
 * @param params0.demo_app_id - The app row.
 * @param params0.set - Watermarks and gates, already computed.
 * @returns Resolves when written.
 */
const writeWatermarks = async ({ demo_app_id, set }: { demo_app_id: string; set: Record<string, unknown> }): Promise<void> => {
    await PartnerAppModel.updateOne({ _id: toObjectId(demo_app_id) }, { $set: set });
};

/**
 * Ensures the collections the seeder writes have their declared indexes built.
 *
 * `autoIndex` builds them lazily on first use, which for a seeder means the
 * unique gates may not exist yet when the first `insertMany` lands. Building
 * them up front is what makes a duplicate id fail loudly here rather than
 * silently doubling a count later.
 *
 * @returns Resolves once every index is built.
 */
const ensureIndexes = async (): Promise<void> => {
    await PartnerAppModel.createIndexes();
    for (const entry of _SCOPED_COLLECTIONS) {
        await entry.model.createIndexes();
    }
};

export = {
    INSERT_CHUNK_SIZE,
    findAppByGid,
    summariseForeignApps,
    countForeignRows,
    countDemoRows,
    upsertDemoApp,
    deleteRowsForApp,
    deleteApp,
    insertEvents,
    insertTransactions,
    insertFunnelDays,
    insertSourceDays,
    insertGeoDays,
    insertAttributions,
    insertSyncJobs,
    writeWatermarks,
    ensureIndexes
};
