'use strict';

/**
 * Data access for the `gi_partner_apps` row — the app this deployment reports on.
 *
 * Everything that touches the model lives here; the services above deal in plain values. That
 * boundary is what lets the sync service be read as "what a run does" rather than as a pile of
 * mongoose calls, and it is enforced by the lint layer guard.
 */

import models = require('../../shared/repositories/models.repository');

import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { CoverageRecord } from '../types/coverage.types';
import type { PartnerAppPatchSet } from '../types/partnerAppAdmin.types';
import type { PartnerAppCreateFields } from '../types/partnerApp.types';

const { PartnerAppModel } = models;

/**
 * Loads one app by its Mongo `_id`.
 *
 * @param partner_app_id - The `_id` of the `gi_partner_app` row.
 * @returns The lean document, or null when no such row exists.
 */
const findPartnerAppById = async (partner_app_id: string): Promise<PartnerAppDoc | null> => {
    return PartnerAppModel.findById(partner_app_id).lean();
};

/**
 * Loads one app by its canonical Partner GID.
 *
 * ⚠️ Pass the CANONICAL `gid://partners/App/<id>` form, never the raw value an operator typed. The
 * column holds whatever the create path stored, and the create path stores the canonical form — a
 * lookup by a bare numeric id would miss the row and the caller would register a duplicate app,
 * which forks every downstream rollup in two.
 *
 * @param partner_api_app_id - Canonical `gid://partners/App/<id>`.
 * @returns The lean document, or null.
 */
const findPartnerAppByGid = async (partner_api_app_id: string): Promise<PartnerAppDoc | null> => {
    return PartnerAppModel.findOne({ partner_api_app_id }).lean();
};

/**
 * Lists apps, newest first.
 *
 * @param params0 - The filter.
 * @param [params0.is_active] - Omitted returns every app, active or not.
 * @returns Lean documents.
 */
const listPartnerApps = async ({ is_active }: { is_active?: boolean }): Promise<PartnerAppDoc[]> => {
    const _filter: Record<string, any> = {};
    if (typeof is_active === 'boolean') {
        _filter.is_active = is_active;
    }
    return PartnerAppModel.find(_filter).sort({ createdAt: -1 }).lean();
};

/**
 * Inserts a new app row.
 *
 * There is a NAMED unique index on `partner_api_app_id`, so a concurrent second insert of the same
 * app rejects at the database rather than forking the data. The caller checks first for a readable
 * message; the index is what makes the check safe.
 *
 * @param fields - Handle, display name, listing URL and the canonical GID.
 * @returns The created document.
 */
const createPartnerApp = async (fields: PartnerAppCreateFields): Promise<PartnerAppDoc> => {
    const doc = await PartnerAppModel.create(fields);
    return doc.toObject();
};

/**
 * Stamps the watermarks and the coverage gates after a FULLY successful sync.
 *
 *  Call this only when both halves of the run succeeded. `last_synced_at` is what makes the next
 * INCREMENTAL run start where this one stopped, so advancing it after a partial pull permanently
 * skips the window that failed — nothing ever revisits it, and the hole is invisible from then on.
 *
 * `lifetime_sync_completed_at` is written only when the run that just finished was a LIFETIME one.
 * It is the gate that says "all-time figures are totals, not floors", and an INCREMENTAL run has
 * not earned it however many times it succeeds.
 *
 * @param params0 - What to stamp.
 * @param params0.partner_app_id - The app row to update.
 * @param params0.synced_at - End of the window this run covered.
 * @param params0.lifetime_completed - True only when a LIFETIME run just succeeded.
 * @param params0.coverage - The six gates, freshly measured.
 */
const recordSuccessfulSync = async ({ partner_app_id, synced_at, lifetime_completed, coverage }: {
    partner_app_id: string;
    synced_at: Date;
    lifetime_completed: boolean;
    coverage: CoverageRecord;
}): Promise<void> => {
    const _set: Record<string, any> = {
        last_synced_at: synced_at,
        earliest_event_at: coverage.earliest_event_at,
        earliest_transaction_at: coverage.earliest_transaction_at,
        // The store-name backfill boundary. Stamped like every other gate — unconditionally, so a
        // LIFETIME re-sync that closes the boundary can also ERASE it. A gate that only ever moves
        // one way would keep announcing a caveat the operator has already fixed, and a banner that
        // outlives its cause is how people learn to ignore banners.
        shop_name_coverage_since: coverage.shop_name_coverage_since,
        event_history_gap_days: coverage.event_history_gap_days,
        charge_link_absent_pct: coverage.charge_link_absent_pct,
        charge_link_unresolved_pct: coverage.charge_link_unresolved_pct
    };
    if (lifetime_completed) {
        _set.lifetime_sync_completed_at = synced_at;
    }
    await PartnerAppModel.updateOne({ _id: partner_app_id }, { $set: _set });
};

/**
 * Writes an already-validated patch onto one app row and returns the row as it now stands.
 *
 *  `$set` WITH A CLOSED FIELD SET, NEVER THE REQUEST BODY. The document handed in comes from
 * `helpers/partnerAppPatch.helper`, which can only produce the six editable keys — so there is no
 * path from an HTTP body to `partner_api_app_id`, to a sync watermark, or to any of the six coverage
 * gates. That is what makes this function safe to call with caller-supplied data at all: the
 * validation is not a courtesy check before a spread, it is the only thing that constructs the
 * document.
 *
 * `runValidators: true` because a `$set` update BYPASSES schema validation by default in mongoose —
 * `required`, `enum` and every custom validator are simply not run — so a value the helper somehow
 * let through would be stored unchallenged. The helper is the first gate and the schema is the
 * second; a single gate is a gate somebody eventually edits.
 *
 * `new: true` so the caller serialises the row that now exists rather than the one that did. A
 * response that echoes the pre-update document reports a save that appears not to have happened.
 *
 * @param params0 - The write.
 * @param params0.partner_app_id - The `_id` of the row to update.
 * @param params0.set - The validated `$set` document. Only editable keys.
 * @returns The row after the write, or null when no such row exists.
 */
const updatePartnerAppFields = async ({ partner_app_id, set }: {
    partner_app_id: string;
    set: PartnerAppPatchSet;
}): Promise<PartnerAppDoc | null> => {
    return PartnerAppModel.findByIdAndUpdate(
        partner_app_id,
        { $set: set },
        { new: true, runValidators: true }
    ).lean();
};

export = {
    findPartnerAppById,
    findPartnerAppByGid,
    listPartnerApps,
    createPartnerApp,
    updatePartnerAppFields,
    recordSuccessfulSync
};
