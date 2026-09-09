import GrowthIntelFunnelApiService from '../../API_Services/growth-intel/funnelService';
import GrowthIntelPartnerAppApiService from '../../API_Services/growth-intel/partnerAppService';

const FUNNEL_API = new GrowthIntelFunnelApiService();
const PARTNER_API = new GrowthIntelPartnerAppApiService();

/**
 * Every growth-intel background job, in one place, with its manual triggers.
 *
 * WHY A REGISTRY
 * --------------
 * These buttons used to be scattered one-per-analytics-page (Traffic Sources had "Sync now" +
 * "Full re-sync", Funnel had three), so there was no single place to
 * answer "what syncs exist, when did each last run, and how do I force one". Worse, the same job
 * was reachable under different labels from different pages. The Sync page is now that console, and
 * a new job type is ONE entry here rather than a new block of JSX on whichever page happens to read
 * its output.
 *
 * ACTION KINDS
 * ------------
 * ⚠️ THERE IS NO GENERIC `POST /sync/trigger` ON THIS BACKEND. Every runnable job type has its own
 * route, and the two kinds below differ only in WHERE the dispatch happens — not in what is reached.
 *
 *   'job'      — hands {job_type, payload} to syncService.triggerSync, which DISPATCHES on the type
 *                to that type's own route. A type with no route is refused by name rather than
 *                substituted with a different sync.
 *   'endpoint' — calls a service method directly, for a shape triggerSync does not take (a LIFETIME
 *                mode flag, the attribution options). Verified: every dedicated route answers the
 *                same {status, data:{job:{job_id}}} envelope enqueueSyncJob returns, so
 *                ManualSyncButton polls them to a terminal status identically — which also upgrades
 *                the two lifetime re-syncs from the old fire-and-forget "queued, refresh in a few
 *                minutes" to a real completion toast.
 *   'inline'   — NOT a job. Runs synchronously and hands back a result there is no job row to poll
 *                for (only the attribution dry run, which exists to price a scan before spending it).
 *
 * `job_type` doubles as the key into GET /sync/health's `last_success_per_type`, which publishes
 * EVERY storable type as a key — so a card whose literal does not match one silently reports no runs
 * for a job that runs nightly. Renaming one breaks no build anywhere; that is the whole risk.
 *
 * ⚠️ Ad-spend CSV ingest is deliberately absent. This build has no job type for it at all:
 * `SYNC_JOB_TYPES` (backend/src/constants/syncJob.constants.ts) holds exactly DUMMY, PARTNER_SYNC,
 * BIGQUERY_SYNC and INSTALL_ATTRIBUTION_SYNC, and `JOB_HANDLERS` in
 * backend/src/modules/sync/services/jobRunner.service.ts registers a handler for each. A card for a
 * type outside that enum would be refused by name at the trigger route. Add one when both the enum
 * entry and the handler land, not before.
 */

export const SYNC_SCOPES = Object.freeze({
    // Needs the partner app selected in the side nav.
    APP: 'APP',
    // Scoped to some other entity, so it cannot be triggered from here — the button lives on that
    // entity's own page. Listed anyway: this page is the inventory, and a job missing from the
    // inventory reads as a job that does not exist.
    ENTITY: 'ENTITY',
    // Takes no target.
    GLOBAL: 'GLOBAL'
});

export const SYNC_CATEGORIES = [
    {
        job_type: 'PARTNER_SYNC',
        title: 'Partner API — events & transactions',
        description: 'Installs, uninstalls, subscription charges and payout transactions from the Shopify Partner API. This is the spine every other number hangs off: the install cohort, the trial ladder and MRR are all derived from it.',
        cron: 'Daily 03:00 UTC',
        scope: SYNC_SCOPES.APP,
        actions: [
            {
                key: 'partner_auto',
                kind: 'job',
                label: 'Sync now',
                jobType: 'PARTNER_SYNC',
                payload: ({ appId }) => ({ partner_app_id: appId, mode: 'AUTO' }),
                helpText: 'Incremental — everything since the last watermark.'
            },
            {
                key: 'partner_lifetime',
                kind: 'endpoint',
                label: 'Full re-sync (lifetime)',
                variant: 'secondary',
                makeTrigger: ({ appId }) => (cb) => PARTNER_API.triggerSync(appId, { mode: 'LIFETIME' }, cb),
                helpText: 'Re-pulls every event and transaction from 2009 to today. Use after a schema change or a suspected gap.'
            }
        ]
    },
    {
        job_type: 'BIGQUERY_SYNC',
        title: 'GA4 listing rollups (BigQuery)',
        description: 'Daily listing views, install clicks and installs, rolled up by traffic source/medium and by country. Feeds Traffic Sources and the top of the Funnel page.',
        cron: 'Daily 02:00 UTC',
        scope: SYNC_SCOPES.APP,
        actions: [
            {
                key: 'bq_auto',
                kind: 'endpoint',
                label: 'Sync now',
                makeTrigger: ({ appId }) => (cb) => FUNNEL_API.triggerSync({ partner_app_id: appId, mode: 'AUTO' }, cb),
                helpText: 'Incremental — the days since the last successful rollup.'
            },
            {
                key: 'bq_lifetime',
                kind: 'endpoint',
                label: 'Full re-sync (lifetime)',
                variant: 'secondary',
                makeTrigger: ({ appId }) => (cb) => FUNNEL_API.triggerSync({ partner_app_id: appId, mode: 'LIFETIME' }, cb),
                helpText: 'Re-pulls every GA4 event from the lifetime floor date. The GA4 export is forward-only and never backfilled, so this recovers rollups — not events GA4 never exported.'
            }
        ]
    },
    {
        job_type: 'INSTALL_ATTRIBUTION_SYNC',
        title: 'Install attribution (BigQuery)',
        description: 'One row per install answering "which store, and where did it come from" — the Source and Channel columns of the install cohort. Separate from the rollups above because it reads the whole event_params column: its own watermark, its own cost, its own failure domain. Until it has run once, every store reads "Not attributed". Also captures the App Store surface each install came from \u2014 including the position we were served at.',
        cron: 'Daily 06:00 UTC',
        scope: SYNC_SCOPES.APP,
        actions: [
            {
                key: 'attrib_auto',
                kind: 'endpoint',
                label: 'Sync attribution',
                makeTrigger: ({ appId }) => (cb) => FUNNEL_API.triggerAttributionSync({ partner_app_id: appId, mode: 'AUTO' }, cb),
                helpText: 'AUTO resolves to LIFETIME on the very first run (no watermark yet) and INCREMENTAL every day after.'
            },
            {
                key: 'attrib_lifetime',
                kind: 'endpoint',
                label: 'Full re-sync (lifetime)',
                variant: 'secondary',
                makeTrigger: ({ appId }) => (cb) => FUNNEL_API.triggerAttributionSync({ partner_app_id: appId, mode: 'LIFETIME' }, cb),
                //  Not the same as "Sync attribution". Once the watermark exists AUTO resolves to
                // INCREMENTAL, which only re-reads recent days — so a capture change (organic search
                // surfaces, served positions) would silently apply to new installs only and leave
                // every historical row exactly as it was. This is the button that rewrites history.
                helpText: 'Re-reads every install from the lifetime floor date and rewrites its attribution — the only way a capture change reaches historical installs. The most expensive query in the module: price it with Estimate scan first.'
            },
            {
                key: 'attrib_dry_run',
                kind: 'inline',
                label: 'Estimate scan',
                variant: 'tertiary',
                helpText: 'Prices the BigQuery scan at zero cost. Nothing runs, nothing is written.',
                // Inline rather than a job: a queued fire-and-forget job could never hand the
                // estimate back. That first LIFETIME run is the most expensive query in the module,
                // so pricing it before spending it is the point.
                run: ({ appId, showToast }) => {
                    FUNNEL_API.triggerAttributionSync({ partner_app_id: appId, mode: 'AUTO', dry_run: true }, (resp) => {
                        if (!resp || !resp.status || !resp.data) {
                            showToast && showToast((resp && resp.msg) || 'Failed to price the attribution scan.', true);
                            return;
                        }
                        if (resp.data.exceeds_cap) {
                            showToast && showToast(`Estimate ${resp.data.gib_scanned} GiB — above the billing cap, so the real run would be rejected before it bills. Narrow the window.`, true);
                            return;
                        }
                        showToast && showToast(`Estimate: ${resp.data.gib_scanned} GiB would be scanned (${resp.data.mode}). Nothing billed, nothing written.`, false);
                    });
                }
            }
        ]
    },
    {
        job_type: 'KEYWORD_RANKING',
        title: 'Keyword rankings',
        description: 'App Store search position for every keyword you have marked as tracked. Snapshots are point-in-time, so a missed day is a permanent gap in the trend.',
        cron: 'Daily 05:00 UTC',
        scope: SYNC_SCOPES.APP,
        actions: [
            {
                key: 'ranking_now',
                kind: 'job',
                label: 'Capture snapshot',
                jobType: 'KEYWORD_RANKING',
                payload: ({ appId }) => ({ partner_app_id: appId }),
                helpText: 'Not in this build — KEYWORD_RANKING has no handler, so this is refused by name.'
            }
        ]
    },
    {
        job_type: 'COMPETITOR_SNAPSHOT',
        title: 'Competitor snapshots',
        description: 'Listing details and reviews for each tracked competitor.',
        cron: 'Daily 04:00 UTC',
        scope: SYNC_SCOPES.ENTITY,
        // Scoped to a competitor, not a partner app, so a manual run needs to know WHICH competitor
        // — that button belongs on the competitor's own page.
        entity_hint: 'Not in this build. Competitor tracking ships no handler here, so nothing can enqueue this — the card is listed to keep the sync inventory complete.',
        actions: []
    },
    {
        job_type: 'LLM_INSIGHT',
        title: 'Weekly LLM briefing',
        description: 'The generated weekly summary and recommendations.',
        cron: 'Mondays 08:00 UTC',
        scope: SYNC_SCOPES.ENTITY,
        // Deliberately no button: this build ships no handler for it, and no page to render a
        // result on. The card is listed so the sync inventory stays complete.
        entity_hint: 'Not in this build. The generated briefing ships no handler here, so nothing can enqueue this — the card is listed to keep the sync inventory complete.',
        actions: []
    },
    {
        job_type: 'DUMMY',
        title: 'Infrastructure test',
        description: 'Queues a job that sleeps for a few seconds and completes. Proves enqueue → claim → run → status polling end to end without touching any data source, credential or upstream. There is no queue broker in this build: the trigger writes a PENDING row and the in-process runner claims it on its next poll tick, so this exercises exactly the path every real sync takes.',
        cron: 'Not scheduled — manual only',
        scope: SYNC_SCOPES.GLOBAL,
        actions: [
            {
                key: 'dummy',
                kind: 'job',
                label: 'Run dummy sync',
                jobType: 'DUMMY',
                variant: 'secondary',
                payload: () => ({}),
                helpText: 'Use this first when a real sync is not starting — it isolates the queue from the data source.'
            }
        ]
    }
];

export default SYNC_CATEGORIES;
