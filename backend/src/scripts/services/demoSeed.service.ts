'use strict';

/**
 * ============================================================================
 *  DEMO DATASET — seed and teardown
 * ============================================================================
 *
 *  Turns the generated dataset into rows, sets the watermarks that make those
 *  rows visible, and removes exactly what it wrote when asked.
 *
 *  ── 1. THE SAFETY REFUSAL ────────────────────────────────────────────────
 *
 *  This script writes FICTION. Run against a deployment holding a real Partner
 *  sync it would put invented stores, invented trials and invented revenue
 *  beside real ones, in the same collections, joined on the same keys — and
 *  nothing downstream distinguishes them, because nothing downstream was ever
 *  asked to. So the seeder counts what is already there FIRST and refuses if it
 *  finds anything it did not write:
 *
 *      • an app row that is not the demo app, or
 *      • a fact row scoped to any other app id.
 *
 *  The second check is the one that matters. Deleting an app row by hand leaves
 *  its events and payouts behind, and those are still somebody's history; an
 *  app-count-only gate would wave that database straight through.
 *
 *  `--force` overrides, because there are legitimate reasons (a scratch database
 *  with leftovers) — but it is a flag a human types, never a default.
 *
 *  ── ⚠️ 2. THE WATERMARKS ARE NOT OPTIONAL ──────────────────────────────────
 *
 *  Every read service decides NEVER_SYNCED from `last_synced_at` and never from
 *  a row count. Seed ten thousand rows and leave that null and all eleven pages
 *  correctly answer "no sync has completed", show a banner and render nothing —
 *  which is the honesty machinery working, on a dataset that defeats the point
 *  of seeding it.
 *
 *  The six COVERAGE GATES are not made up either. They are recomputed from the
 *  rows just written, by `partnerCoverage.repository` and `coverage.helper` —
 *  the same two files a real sync uses. A hand-written `earliest_event_at` would
 *  be a claim about the data rather than a measurement of it, which is precisely
 *  the class of number this project exists to refuse.
 *
 *  ── 3. IDEMPOTENCE ──────────────────────────────────────────────────────────
 *
 *  Two things make a second run a no-op rather than a second dataset. The ANCHOR
 *  is stored on the app row and reused, so the generator reproduces the same
 *  rows; and the write is delete-then-insert SCOPED TO THE DEMO APP, so the
 *  previous run's rows go before the new ones land. `--reanchor` re-dates the
 *  whole dataset to today, for a demo seeded months ago.
 * ============================================================================
 */

import logger = require('../../core/logger');
import coverageHelper = require('../../modules/partner/helpers/coverage.helper');
import partnerCoverageRepository = require('../../modules/partner/repositories/partnerCoverage.repository');
import demoConstants = require('../constants/demoSeed.constants');
import demoDatasetHelper = require('../helpers/demoDataset.helper');
import demoSeedRepository = require('../repositories/demoSeed.repository');

import type { PartnerAppDoc } from '../../modules/shared/types/entity.types';
import type { DemoRowCounts, DemoSeedOutcome, DemoTeardownOutcome } from '../types/demoSeed.types';

const { customConsoleLog } = logger;
const { computeCoverage } = coverageHelper;
const { collectCoverageInputs } = partnerCoverageRepository;
const { generateDemoDataset } = demoDatasetHelper;
const { DEMO_APP, DEMO_MARKER, DEMO_SEED_VERSION } = demoConstants;

/** Reads the demo marker off an app row. Absent means the row is not ours. */
const _markerOf = (app: PartnerAppDoc | null): string => {
    if (!app || !app.metadata || typeof app.metadata !== 'object') {
        return '';
    }
    const demo = (app.metadata as Record<string, unknown>).demo;
    if (!demo || typeof demo !== 'object') {
        return '';
    }
    const marker = (demo as Record<string, unknown>).marker;
    return typeof marker === 'string' ? marker : '';
};

/** Reads the stored anchor off an app row, or null when there is none to reuse. */
const _anchorOf = (app: PartnerAppDoc | null): Date | null => {
    if (!app || !app.metadata || typeof app.metadata !== 'object') {
        return null;
    }
    const demo = (app.metadata as Record<string, unknown>).demo;
    if (!demo || typeof demo !== 'object') {
        return null;
    }
    const raw = (demo as Record<string, unknown>).anchor_at;
    if (typeof raw !== 'string') {
        return null;
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** Total across a per-collection count map. */
const _total = (counts: DemoRowCounts): number => {
    return Object.values(counts).reduce((sum, value) => sum + value, 0);
};

/** The collections that hold something, formatted for an operator-facing sentence. */
const _describeCounts = (counts: DemoRowCounts): string => {
    const parts: string[] = [];
    for (const [label, value] of Object.entries(counts)) {
        if (value > 0) {
            parts.push(`${value} ${label}`);
        }
    }
    return parts.join(', ');
};

/**
 * Writes the demo dataset.
 *
 * @param params0 - Options.
 * @param params0.force - Write even though the database holds rows this seeder did not write.
 * @param params0.reanchor - Re-date the dataset to `now` instead of reusing the stored anchor.
 * @param params0.now - The instant "today" means. Injected so the seeder is testable.
 * @returns What happened, including a refusal.
 */
const seedDemoDataset = async ({ force, reanchor, now }: { force: boolean; reanchor: boolean; now: Date }): Promise<DemoSeedOutcome> => {
    const existing = await demoSeedRepository.findAppByGid({ partner_api_app_id: DEMO_APP.partner_api_app_id });

    // ── The refusal, before anything is written ──────────────────────────────
    // ⚠️ An app row on OUR gid that carries no marker is somebody else's row that
    // happens to collide. It is never overwritten: `partner_api_app_id` is unique,
    // so overwriting it would silently repoint their whole history at a demo app.
    if (existing && _markerOf(existing) !== DEMO_MARKER) {
        return {
            status: 'REFUSED',
            message: `An app is already registered on ${DEMO_APP.partner_api_app_id} and it is NOT the demo app — it carries no demo marker. `
                + 'Refusing to overwrite it. That row and everything joined to it belongs to whoever registered it; '
                + 'change SHOPIFY_PARTNER_APP_ID or point this deployment at a different database.',
            anchor_at: null,
            partner_app_id: String(existing._id),
            written: {},
            removed: {},
            watermarks: {},
            summary: {}
        };
    }

    const demoAppId = existing ? String(existing._id) : null;
    const foreignApps = await demoSeedRepository.summariseForeignApps({ demo_app_id: demoAppId });
    const foreignRows = await demoSeedRepository.countForeignRows({ demo_app_id: demoAppId });
    const foreignRowTotal = _total(foreignRows);

    if (!force && (foreignApps.total > 0 || foreignRowTotal > 0)) {
        const found: string[] = [];
        if (foreignApps.total > 0) {
            found.push(`${foreignApps.total} partner app row${foreignApps.total === 1 ? '' : 's'} that ${foreignApps.total === 1 ? 'is' : 'are'} not the demo app`);
        }
        if (foreignRowTotal > 0) {
            const noun = foreignRowTotal === 1 ? 'fact row' : 'fact rows';
            found.push(`${foreignRowTotal} ${noun} belonging to another app (${_describeCounts(foreignRows)})`);
        }

        // ⚠️ THE LIKELY FALSE ALARM, NAMED. The backend registers an app row at boot
        // from SHOPIFY_PARTNER_APP_ID, so somebody who set that variable and started
        // the server has a foreign app row and nothing else. Telling them "you already
        // have data" without saying which kind sends them looking for history that is
        // not there.
        let hint = 'Point MONGO_URI at an empty database, or re-run with --force if you are certain this database is disposable.';
        if (foreignRowTotal === 0 && foreignApps.total > 0 && foreignApps.total === foreignApps.never_synced) {
            hint = `${foreignApps.total === 1 ? 'That app row has' : 'Those app rows have'} never synced and carr${foreignApps.total === 1 ? 'ies' : 'y'} no data — `
                + 'the backend registers one at boot from SHOPIFY_PARTNER_APP_ID. Leave that variable blank when running on demo data, '
                + 'or re-run with --force to seed alongside it.';
        }

        return {
            status: 'REFUSED',
            message: `This database already holds data the demo seeder did not write: ${found.join('; ')}. `
                + 'Refusing to add synthetic stores, trials and revenue beside real ones — nothing downstream can tell them apart. '
                + hint,
            anchor_at: null,
            partner_app_id: demoAppId,
            written: {},
            removed: {},
            watermarks: {},
            summary: {}
        };
    }

    // ── Anchor ───────────────────────────────────────────────────────────────
    // Reusing the stored anchor is what makes a second run regenerate the SAME
    // rows. Taking `now` every time would produce a different dataset on every
    // run, and "idempotent" would quietly mean "replaced".
    const storedAnchor = _anchorOf(existing);
    const anchor = (!reanchor && storedAnchor) ? storedAnchor : now;

    const dataset = generateDemoDataset({ anchor_at: anchor });

    await demoSeedRepository.ensureIndexes();

    const app = await demoSeedRepository.upsertDemoApp({
        partner_api_app_id: dataset.app.partner_api_app_id,
        fields: {
            app_handle: dataset.app.app_handle,
            display_name: dataset.app.display_name,
            listing_url: dataset.app.listing_url,
            partner_api_app_id: dataset.app.partner_api_app_id,
            categories: dataset.app.categories,
            target_keywords: dataset.app.target_keywords,
            is_active: true,
            metadata: dataset.app.metadata
        }
    });
    const appId = String(app._id);

    // Delete-then-insert, SCOPED TO THIS APP. A previous run's rows go first, so a
    // shape change between seed versions cannot leave orphans behind.
    const removed = await demoSeedRepository.deleteRowsForApp({ demo_app_id: appId });

    const written: DemoRowCounts = {
        events: await demoSeedRepository.insertEvents({ demo_app_id: appId, rows: dataset.events as unknown as Record<string, unknown>[] }),
        transactions: await demoSeedRepository.insertTransactions({ demo_app_id: appId, rows: dataset.transactions as unknown as Record<string, unknown>[] }),
        funnel_days: await demoSeedRepository.insertFunnelDays({ demo_app_id: appId, rows: dataset.funnel_days as unknown as Record<string, unknown>[] }),
        source_days: await demoSeedRepository.insertSourceDays({ demo_app_id: appId, rows: dataset.source_days as unknown as Record<string, unknown>[] }),
        geo_days: await demoSeedRepository.insertGeoDays({ demo_app_id: appId, rows: dataset.geo_days as unknown as Record<string, unknown>[] }),
        attributions: await demoSeedRepository.insertAttributions({ demo_app_id: appId, rows: dataset.attributions as unknown as Record<string, unknown>[] }),
        sync_jobs: await demoSeedRepository.insertSyncJobs({ demo_app_id: appId, rows: dataset.sync_jobs as unknown as Record<string, unknown>[] })
    };

    // ── Watermarks and coverage gates ────────────────────────────────────────
    //  MEASURED, NOT ASSERTED. `collectCoverageInputs` reads the rows that were
    // just written and `computeCoverage` folds them exactly as a real sync does, so
    // `earliest_event_at`, the shop-name boundary, the widest event gap and the two
    // charge-link percentages are facts about this dataset rather than constants
    // typed into a seeder.
    const coverageInputs = await collectCoverageInputs({ partner_app_id: appId });
    const coverage = computeCoverage(coverageInputs);

    const watermarks: Record<string, unknown> = {
        // Partner side. `lifetime_sync_completed_at` is what lets every all-time
        // figure publish a TOTAL rather than a floor — the demo history is complete
        // by construction, so the claim is true here.
        last_synced_at: now,
        lifetime_sync_completed_at: now,
        // Listing side. Two watermarks, because the rollups and the per-install
        // attribution pull are separate failure domains and the pages read them
        // separately.
        last_bq_synced_at: now,
        last_install_attrib_synced_at: now,
        earliest_event_at: coverage.earliest_event_at,
        earliest_transaction_at: coverage.earliest_transaction_at,
        shop_name_coverage_since: coverage.shop_name_coverage_since,
        event_history_gap_days: coverage.event_history_gap_days,
        charge_link_absent_pct: coverage.charge_link_absent_pct,
        charge_link_unresolved_pct: coverage.charge_link_unresolved_pct
    };
    await demoSeedRepository.writeWatermarks({ demo_app_id: appId, set: watermarks });

    customConsoleLog('INFO: [DemoSeed] dataset written', {
        partner_app_id: appId,
        anchor_at: dataset.anchor_at.toISOString(),
        rows: written
    });

    return {
        status: 'SEEDED',
        message: `Demo dataset written for "${dataset.app.display_name}".`,
        anchor_at: dataset.anchor_at,
        partner_app_id: appId,
        written,
        removed,
        watermarks,
        summary: {
            seed_version: DEMO_SEED_VERSION,
            stores: dataset.stores.length,
            quiet_month: dataset.quiet_window.month,
            forced: force === true,
            reanchored: reanchor === true || !storedAnchor
        }
    };
};

/**
 * Removes the demo dataset and nothing else.
 *
 * ⚠️ REFUSES ON AN UNMARKED APP ROW. If the row on the demo GID carries no demo
 * marker it belongs to somebody else, and a teardown that deleted it would take
 * a real app's whole history with it. The marker is the only thing that makes
 * "exactly what it wrote" checkable.
 *
 * @returns What was removed, or why nothing was.
 */
const teardownDemoDataset = async (): Promise<DemoTeardownOutcome> => {
    const existing = await demoSeedRepository.findAppByGid({ partner_api_app_id: DEMO_APP.partner_api_app_id });

    if (!existing) {
        return {
            status: 'NOTHING_TO_DO',
            message: 'No demo app is registered in this database. Nothing was removed.',
            partner_app_id: null,
            removed: {},
            app_rows_removed: 0
        };
    }

    if (_markerOf(existing) !== DEMO_MARKER) {
        return {
            status: 'REFUSED',
            message: `The app registered on ${DEMO_APP.partner_api_app_id} carries no demo marker, so it was not written by this seeder. `
                + 'Refusing to delete it or anything joined to it.',
            partner_app_id: String(existing._id),
            removed: {},
            app_rows_removed: 0
        };
    }

    const appId = String(existing._id);
    const removed = await demoSeedRepository.deleteRowsForApp({ demo_app_id: appId });
    const appRowsRemoved = await demoSeedRepository.deleteApp({ demo_app_id: appId });

    customConsoleLog('INFO: [DemoSeed] dataset removed', { partner_app_id: appId, rows: removed });

    return {
        status: 'REMOVED',
        message: `Removed the demo dataset: ${_total(removed)} rows and ${appRowsRemoved} app row.`,
        partner_app_id: appId,
        removed,
        app_rows_removed: appRowsRemoved
    };
};

export = {
    seedDemoDataset,
    teardownDemoDataset
};
