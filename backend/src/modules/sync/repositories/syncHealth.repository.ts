'use strict';

/**
 * ============================================================================
 *  SYNC-HEALTH REPOSITORY — the only cross-collection read in the application
 * ============================================================================
 *
 *  `GET /api/sync/health` asks one question no other endpoint asks: what is in
 *  ALL NINE collections? Every other read is scoped to one app and one subject,
 *  so this is the only file that legitimately touches the whole registry.
 *
 *  Its sibling `syncJob.repository` owns the job LIFECYCLE — the claim, the
 *  terminal writes, the sweep. Nothing is duplicated across the two: this file
 *  issues no lifecycle query, and that file issues no cross-collection read.
 *
 *  ──  `countDocuments`, NEVER `estimatedDocumentCount` ─────────────────────
 *  The estimate is O(1) because it reads collection METADATA, which can be stale
 *  after an unclean shutdown. This endpoint exists to draw exactly one
 *  distinction — zero rows or some rows — so a stale `0` over a populated
 *  collection would report a working sync as one that has never run, which is
 *  the single worst answer this screen can give. An exact count over collections
 *  that grow by a handful of rows a day is cheap; being wrong is not.
 *
 *  ── Why the counts are issued CONCURRENTLY ──────────────────────────────────
 *  Nine sequential round trips is nine latencies on a page an operator reloads
 *  when they are already worried. `Promise.all` makes it one. They are
 *  independent reads of independent collections, so there is no ordering to
 *  preserve — and no transaction to want, because a health snapshot is a
 *  description of a moving system rather than a consistent cut of it.
 *
 *  ── This file reads no config and no clock ──────────────────────────────────
 *  Same rule as its sibling: the policy (what an empty collection MEANS, whether
 *  the optional tier is connected) lives in the service and the pure helper. Here
 *  there are only queries.
 * ============================================================================
 */

import models = require('../../shared/repositories/models.repository');
import constants = require('../constants/sync.constants');

import type { SyncJobDoc } from '../../shared/types/entity.types';
import type {
    CollectionRowCounts,
    PartnerAppHealthRow,
    SyncJobHealthFacets
} from '../types/syncHealth.types';

const {
    PartnerAppModel,
    PartnerAppEventModel,
    PartnerAppTransactionModel,
    ListingFunnelDailyModel,
    ListingSourceDailyModel,
    ListingGeoDailyModel,
    ListingInstallAttributionModel,
    SyncJobModel,
    AdminUserModel
} = models;
const { SYNC_JOB_STATUS } = constants;

/**
 * Exact row counts for all nine collections, in one round of concurrent reads.
 *
 *  THE KEYS ARE THE `HEALTH_COLLECTIONS` REGISTRY KEYS, and `test/syncJobs.test.js` asserts that
 * this function, the registry and `src/models/index.ts` all name the same nine things. A collection
 * counted here but missing from the registry would never reach the screen; one in the registry but
 * missing here would render as `0 rows`, which is a MEASUREMENT — it would send an operator hunting
 * for a sync that is failing to fill a collection nothing is even reading.
 *
 * @returns Exact counts, keyed by registry key.
 */
const countAllCollections = async (): Promise<CollectionRowCounts> => {
    const [
        partnerApps,
        partnerAppEvents,
        partnerAppTransactions,
        listingFunnelDaily,
        listingSourceDaily,
        listingGeoDaily,
        listingInstallAttribution,
        syncJobs,
        adminUsers
    ] = await Promise.all([
        PartnerAppModel.countDocuments({}),
        PartnerAppEventModel.countDocuments({}),
        PartnerAppTransactionModel.countDocuments({}),
        ListingFunnelDailyModel.countDocuments({}),
        ListingSourceDailyModel.countDocuments({}),
        ListingGeoDailyModel.countDocuments({}),
        ListingInstallAttributionModel.countDocuments({}),
        SyncJobModel.countDocuments({}),
        AdminUserModel.countDocuments({})
    ]);

    return {
        partner_apps: partnerApps,
        partner_app_events: partnerAppEvents,
        partner_app_transactions: partnerAppTransactions,
        listing_funnel_daily: listingFunnelDaily,
        listing_source_daily: listingSourceDaily,
        listing_geo_daily: listingGeoDaily,
        listing_install_attribution: listingInstallAttribution,
        sync_jobs: syncJobs,
        admin_users: adminUsers
    };
};

/**
 * Every registered app's watermarks and coverage gates.
 *
 * EVERY app, not just the active ones: a deactivated app's history is still being served by every
 * read endpoint, so a health screen that hid it would omit the coverage gates qualifying figures
 * that are on screen right now. `is_active` is projected so the caller can say which is which.
 *
 * Fields are PROJECTED rather than taking the whole document: the app row carries a `metadata` blob
 * of unbounded shape, and a health endpoint has no business publishing it.
 *
 * @returns One row per registered app, newest first. Empty on a fresh install.
 */
const findPartnerAppHealthRows = async (): Promise<PartnerAppHealthRow[]> => {
    return PartnerAppModel.find({})
        .sort({ createdAt: -1 })
        .select({
            app_handle: 1,
            display_name: 1,
            is_active: 1,
            last_synced_at: 1,
            last_bq_synced_at: 1,
            last_install_attrib_synced_at: 1,
            earliest_event_at: 1,
            earliest_transaction_at: 1,
            lifetime_sync_completed_at: 1,
            shop_name_coverage_since: 1,
            event_history_gap_days: 1,
            charge_link_absent_pct: 1,
            charge_link_unresolved_pct: 1
        })
        .lean<PartnerAppHealthRow[]>();
};

/**
 * The newest SUCCESS and the newest run of every job type, plus the status tally — in ONE pass.
 *
 *  ONE AGGREGATION, THREE PROJECTIONS, ONE INSTANT. Three separate reads would be three instants,
 * and a job finishing between the second and the third can appear in one block and not the other —
 * a screen showing a last run OLDER than the last success, which reads as corrupted data rather than
 * as a race.
 *
 * ⚠️ `last_success` SORTS ON `completed_at` AND `last_run` ON `createdAt`, deliberately: "when did
 * this last WORK" is a question about completion, and "what is the newest row" is a question about
 * enqueue order — the newest row may be a PENDING job that has no completion time at all. Sorting
 * both the same way would make one of the two answer a question nobody asked.
 *
 * `$first` after a `$sort` is what makes each group's winner the newest; there is no `$top` here
 * because it needs a newer server than a self-hoster can be assumed to run.
 *
 * @returns The three projections. Every branch is an array, and a job type that has never run is simply ABSENT from it — the service fills the nulls.
 */
const aggregateSyncJobHealth = async (): Promise<SyncJobHealthFacets<SyncJobDoc>> => {
    const rows = await SyncJobModel.aggregate<SyncJobHealthFacets<SyncJobDoc>>([
        {
            $facet: {
                last_success: [
                    { $match: { status: SYNC_JOB_STATUS.SUCCESS } },
                    { $sort: { completed_at: -1 } },
                    { $group: { _id: '$job_type', doc: { $first: '$$ROOT' } } }
                ],
                last_run: [
                    { $sort: { createdAt: -1 } },
                    { $group: { _id: '$job_type', doc: { $first: '$$ROOT' } } }
                ],
                by_status: [
                    { $group: { _id: '$status', rows: { $sum: 1 } } }
                ]
            }
        }
    ]);

    // ⚠️ `$facet` yields exactly one document — except over an EMPTY COLLECTION, where it yields
    // none. Normalised here rather than at the call site, because a reader who assumes `rows[0]`
    // gets a TypeError on the one input (a fresh install) that is guaranteed to happen.
    const facets = rows[0];
    if (!facets) {
        return { last_success: [], last_run: [], by_status: [] };
    }

    return {
        last_success: facets.last_success || [],
        last_run: facets.last_run || [],
        by_status: facets.by_status || []
    };
};

export = {
    countAllCollections,
    findPartnerAppHealthRows,
    aggregateSyncJobHealth
};
