'use strict';

/**
 * ============================================================================
 *  COHORT RETENTION — WEEKLY INSTALL COHORTS × FIXED DAY CHECKPOINTS
 * ============================================================================
 *
 *  Serves `GET /api/conversion/cohort-retention` — the heatmap on the Conversion analysis tab.
 *
 *  ──  A COHORT TOO YOUNG FOR A CHECKPOINT HAS NO ANSWER FOR IT ────────────────────────────
 *
 *  This is the whole endpoint, and it is the one thing about it that is easy to get wrong in a way
 *  nobody notices. A cohort that installed last week has not lived ninety days, so its `+90d` cell is
 *  UNKNOWN. Published as `0` it would be painted solid red at full opacity by
 *  `CohortRetentionHeatmap.js:12-17` and captioned "0%" — a specific, checkable claim that every
 *  merchant who installed last week had already churned by month three.
 *
 *  The publication is an ABSENT CHECKPOINT OBJECT, not an object of nulls: `:82-83` reads
 *  `const cp = row.checkpoints['day_' + d]` and takes `pct` only when `cp` exists, and `:87` titles
 *  the cell "Cohort not aged enough" only when `cp` is falsy. A `{ pct: null }` renders the same grey
 *  cell with the WRONG tooltip — "—/— retained" — so the honest shape and the informative one are the
 *  same shape, and the type says `RetentionCheckpoint | null` to keep them so.
 *
 *  ── ⚠️ ELIGIBILITY IS PER STORE, WHICH IS WHY A CELL CAN BE PARTIAL ────────────────────────
 *
 *  Checkpoints are measured from each STORE's own install, never from the cohort week's start.
 *  Anchoring them to the week would credit a store that installed on the week's last day with six
 *  days it never lived through — biasing retention UPWARD, on exactly the newest cohorts a reader
 *  trusts least. The cost is that a week-long cohort can be PARTIALLY eligible at a checkpoint: some
 *  of its stores have reached day 30 and some have not. `eligible` is published beside `retained` so
 *  the denominator is visible, `partial` flags the cell, and `warnings[]` says how many.
 *
 *  ──  "STILL INSTALLED" IS `modules/store`'s FOLD, NOT A LOCAL ONE ────────────────────────
 *
 *  There is one definition of install state in this build and `resolvers/retentionCheckpoint.resolver`
 *  reaches it. Its header carries the three rules a second copy would get subtly wrong — latest event
 *  wins rather than a count comparison, `DEACTIVATED` ends an installation, and a timestamp tie breaks
 *  toward "not installed". Every one of those errors runs in the SAME direction: retention reads HIGH,
 *  which is the flattering direction and therefore the one nobody questions.
 *
 *  ──  AND THE COVERAGE FAILURE HERE RUNS UPWARD TOO ───────────────────────────────────────
 *
 *  Almost every coverage gap in this codebase makes a number too SMALL, which reads as a quiet
 *  period. Not this one. Retention is `1 − churn`, and the evidence of churn is an UNINSTALL event: a
 *  window the Partner sync never fetched cannot lower a retention figure, only raise it. So an app
 *  with an incomplete event history publishes a retention grid that is too GOOD, uniformly, with
 *  every cell looking entirely plausible. The gates are read and said out loud rather than corrected,
 *  because nothing in the stored data can correct them.
 *
 *  ── The discriminator is the WATERMARK, never the row count ────────────────────────────────
 *
 *  No installs plus `last_synced_at` is a real, publishable "nobody installed in these twelve weeks".
 *  No installs and no watermark is "we have not looked yet".
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import listQueryHelper = require('../../shared/helpers/listQuery.helper');
import cohortRetentionConstants = require('../constants/cohortRetention.constants');
import funnelMathHelper = require('../helpers/funnelMath.helper');
import monthBucketHelper = require('../helpers/monthBucket.helper');
import weekBucketHelper = require('../helpers/weekBucket.helper');
import retentionCheckpointResolver = require('../resolvers/retentionCheckpoint.resolver');
import cohortRetentionRepository = require('../repositories/cohortRetention.repository');
import installCohortRepository = require('../repositories/installCohort.repository');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { RelationshipEventRow } from '../types/cohortRetentionData.types';
import type { InstallSpineRow } from '../types/installCohortData.types';
import type { WeekBucket } from '../types/weekBucket.types';
import type {
    CohortRetentionDiagnostics,
    CohortRetentionParams,
    CohortRetentionResponse,
    RetentionCheckpoint,
    RetentionCohortRow
} from '../types/cohortRetention.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { positiveInt } = listQueryHelper;
// THE ONE DIVISION. `null` for an empty denominator, never `0` — which on this page is painted red
// and captioned as a verdict. See that helper's header.
const { rate } = funnelMathHelper;
const { wholeDaysBetween } = monthBucketHelper;
const { buildWeekBuckets } = weekBucketHelper;
const { resolveRetentionCheckpoints } = retentionCheckpointResolver;
const { findRelationshipEvents } = cohortRetentionRepository;
// REUSED, NOT RE-DECLARED. `aggregateInstallSpine` already answers "one row per store that installed
// or reinstalled in a window, plus what the blank-domain filter excluded" — which IS this endpoint's
// population, and is the same spine the install table on the same page is built from. A second spine
// query here would be a second definition of who is in a cohort. `findPartnerAppById` is likewise the
// module's ONE app read.
const { findPartnerAppById, aggregateInstallSpine } = installCohortRepository;
const {
    RETENTION_CHECKPOINT_DAYS,
    retentionCheckpointKey,
    DEFAULT_RETENTION_WEEKS,
    MAX_RETENTION_WEEKS,
    RETENTION_DATA_STATES
} = cohortRetentionConstants;

/** Milliseconds in a week. Used only to place an install into its bucket in O(1). */
const _WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ⚠️ THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * The page renders one entry per warning KEYED BY THE STRING ITSELF, so a duplicate is not drawn
 * twice — it is DROPPED, silently, along with its condition. Each is written for an operator who
 * cannot see this code: what is missing, what it does to the grid, and what would fix it.
 */
const _WARNINGS = Object.freeze({
    neverSynced: 'No Partner sync has completed for this app yet, so no install or uninstall events have '
        + 'been fetched and there are no cohorts to measure. The grid is withheld rather than drawn '
        + 'empty — we have not looked, which is not the same as nobody having installed.',

    weeksClamped: (requested: string, applied: number): string => `The requested range of ${requested} weeks `
        + `is outside what this endpoint serves, so ${applied} weeks were returned instead. Ask for between 1 `
        + `and ${MAX_RETENTION_WEEKS}.`,

    unreachedCells: (cells: number, weeks: number): string => `${cells} of the cells below are blank because `
        + 'the cohort has not aged far enough to answer for that checkpoint yet. They are published as '
        + '"no answer" rather than as 0%: a zero in a retention grid is painted red and reads as "everyone '
        + `churned", which would be a claim about merchants who installed inside the last ${weeks} weeks and `
        + 'have not had the chance. They fill in on their own as time passes; nothing needs to be run.',

    partialCells: (cells: number): string => `${cells} of the cells below are measured over only PART of `
        + 'their cohort. Checkpoints are counted from each store\'s own install date, so a store that '
        + 'installed on the last day of a cohort week reaches +30d six days after one that installed on the '
        + 'first. The "retained / eligible" figure in each cell\'s tooltip is the honest denominator — the '
        + 'percentage is over the stores that have actually lived that long, not over the whole week.',

    /**
     *  THE ONE COVERAGE FAILURE ON THIS ENDPOINT THAT RUNS UPWARD, and it needed saying in its own
     * sentence rather than being folded into a generic floor warning. Every other gap in this build
     * makes a number too small; a missing uninstall event cannot lower a retention rate, only raise
     * it — so an incomplete history draws a grid that is uniformly too good.
     */
    retentionReadsHigh: (reason: string): string => 'Retention is measured as the ABSENCE of an uninstall, '
        + `so a gap in the stored event history can only make these figures look BETTER than they were. `
        + `${reason} Any cohort overlapping that gap is an over-estimate rather than a floor, which is the `
        + 'opposite of how every other coverage caveat in this dashboard behaves. Run a lifetime Partner '
        + 'sync, then read this grid again.',

    shoplessInstallEvents: (events: number): string => `${events} install event(s) in this range carried no `
        + 'shop domain and could not be attached to a store. They are excluded from every cohort below, so '
        + 'the install counts are floors rather than totals.',

    shoplessRelationshipEvents: (events: number): string => `${events} install/uninstall event(s) in this `
        + 'range carried no shop domain and could not be attached to a store. An uninstall we cannot attach '
        + 'is an uninstall that does not lower anybody\'s retention, so the percentages below read slightly '
        + 'HIGH — by at most that many stores.',

    storesWithoutState: (stores: number): string => `${stores} store-checkpoint measurement(s) were dropped `
        + 'because the install spine and the relationship event history disagree about a store: the spine '
        + 'says it installed and no matching event was found to judge its state from. Those stores are '
        + 'excluded from BOTH sides of their cell rather than counted as churned. This should not happen — '
        + 'if it persists, the stored event history is inconsistent and a lifetime Partner re-sync is the '
        + 'first thing to try.',

    partialWeek: (week: string): string => `The most recent cohort (week of ${week}) is still open, so it is `
        + 'still gaining installs. Its size will grow until the week ends; its retention figures are '
        + 'measured only over the stores already in it.'
});

/** The sentence published beside the numbers, so a reader never has to infer what "retained" means. */
const _RETENTION_BASIS = 'A store counts as RETAINED at checkpoint +Nd when the most recent install or '
    + 'uninstall event Shopify sent us, at or before that store\'s own install date plus N days, was an '
    + 'install or a reinstall. A store Shopify froze or closed (RelationshipDeactivated) counts as NOT '
    + 'retained — the app is no longer live on it, whatever the merchant did. Checkpoints are measured from '
    + 'each store\'s OWN install instant, not from the start of its cohort week, and a store that has not '
    + 'yet reached a checkpoint is excluded from BOTH sides of that cell rather than counted as churned.';

/** An ISO string, or null. */
const _iso = (value?: Date | null): string | null => {
    if (!value) {
        return null;
    }
    return value.toISOString();
};

/** A `Date` only when it genuinely is one and genuinely valid. */
const _validDate = (value: unknown): Date | null => {
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
};

/**
 * Which coverage gates make this grid an OVER-estimate rather than a floor.
 *
 * ⚠️ THE EVENT GATES, NEVER THE MONEY ONES. `models/partner/partnerApp.model.ts:122` keeps
 * `earliest_event_at` and `earliest_transaction_at` apart precisely so neither can borrow the other's
 * coverage. Retention is built entirely from relationship EVENTS, so only the event gates apply — a
 * complete payout history says nothing whatever about whether an uninstall was fetched.
 *
 * @param app - The app row, carrying the coverage gates the sync writes.
 * @param since - The oldest cohort week's start.
 * @returns Zero or one warning string — the reasons are FOLDED into one sentence.
 */
const _coverageWarnings = (app: PartnerAppDoc, since: Date | null): string[] => {
    const reasons: string[] = [];

    const floor = _validDate(app.earliest_event_at);
    if (!floor) {
        reasons.push('No event coverage floor has ever been measured for this app, so nothing here can say '
            + 'how far back the stored event history reaches.');
    } else if (since && since.getTime() < floor.getTime()) {
        reasons.push(`The stored event history begins at ${floor.toISOString()}, which is after the oldest `
            + 'cohort below opens.');
    }

    // ⚠️ `> 0` and an explicit finite check, never truthiness: `0` is a MEASURED "no day-wide hole",
    // the most reassuring value the field can take, and `null` is "never measured". Warning on either
    // would fire the banner on healthy data, which is how a warning stops being read.
    const gapDays = app.event_history_gap_days;
    if (typeof gapDays === 'number' && Number.isFinite(gapDays) && gapDays > 0) {
        reasons.push(`The event history contains a stretch of ${gapDays} day(s) carrying no events at all, `
            + 'and the measurement records the widest gap rather than where it sits — so it cannot be tested '
            + 'against this range.');
    }

    if (!app.lifetime_sync_completed_at) {
        reasons.push('No lifetime Partner sync has ever completed for this app, so the stored events are '
            + 'whatever the incremental sync windows happened to pull.');
    }

    if (reasons.length === 0) {
        return [];
    }
    //  ONE sentence, not three. All three reasons produce the SAME distortion in the SAME direction,
    // and three separate banners saying "this reads high" would be read as three separate problems.
    return [_WARNINGS.retentionReadsHigh(reasons.join(' '))];
};

/**
 * Install cohorts against retention checkpoints.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query, already cast (not coerced) by the controller.
 * @param params1.partner_app_id - The app to report on. Required.
 * @param [params1.weeks] - Weekly cohorts. Clamped and reported, never refused.
 * @returns The grid, or an honest refusal carrying `{}`.
 */
const getCohortRetention = (
    { user_id }: IdentityObject,
    { partner_app_id, weeks }: CohortRetentionParams
): Promise<ServiceResult<CohortRetentionResponse | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'partner_app_id is required. Read it from GET /api/partner-apps.'));
            }

            const app = await findPartnerAppById(String(partner_app_id));
            if (!app) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }

            // The service reads the clock ONCE, here, and passes the instant into every pure thing
            // below. A second `new Date()` further down would let two halves of one grid describe two
            // different instants — and on a grid whose whole subject is elapsed time, that shows up as
            // a cell that is eligible in one column and not in the next.
            const asOf = new Date();
            const appId = String(app._id);

            const appliedWeeks = positiveInt(weeks, DEFAULT_RETENTION_WEEKS, MAX_RETENTION_WEEKS);
            const warnings: string[] = [];
            // FAIL-OPEN, PLUS A WARNING. An out-of-range `weeks` is clamped rather than refused, and
            // the clamp is reported — a grid silently showing 52 rows when 500 were asked for is a
            // grid whose row count nobody checked.
            const requestedWeeks = weeks === undefined || weeks === null ? '' : String(weeks).trim();
            if (requestedWeeks !== '' && String(appliedWeeks) !== requestedWeeks) {
                warnings.push(_WARNINGS.weeksClamped(requestedWeeks, appliedWeeks));
            }

            const buckets: WeekBucket[] = buildWeekBuckets({ as_of: asOf, weeks: appliedWeeks });
            const oldest = buckets.length > 0 ? buckets[0].start : null;

            const _envelope = {
                app_id: appId,
                app_name: app.display_name,
                as_of: asOf.toISOString(),
                since: _iso(oldest),
                until: asOf.toISOString(),
                weeks: buckets.length,
                checkpoints_days: RETENTION_CHECKPOINT_DAYS,
                retention_basis: _RETENTION_BASIS
            };

            const _emptyDiagnostics = (): CohortRetentionDiagnostics => ({
                relationship_events_read: 0,
                shopless_install_events: 0,
                shopless_relationship_events: 0,
                future_relationship_events: 0,
                stores_without_state: 0,
                unreached_cells: 0,
                partial_cells: 0,
                earliest_event_at: _iso(app.earliest_event_at)
            });

            // ── THE WATERMARK, NEVER THE ROW COUNT ───────────────────────────
            // This is the ONE condition that produces NEVER_SYNCED. Nothing below may reach for it:
            // an app that has synced and has no installs in these twelve weeks is a real answer.
            if (!app.last_synced_at) {
                return resolve(promiseReturnResult(
                    true,
                    {
                        ..._envelope,
                        // ⚠️ `null`, NOT `[]`. An empty ARRAY is a measured empty and the component
                        // draws "No install cohorts in this window yet"; `null` routes the whole
                        // payload to the never-synced banner through `data_state` below.
                        cohorts: null,
                        diagnostics: _emptyDiagnostics(),
                        warnings: [...new Set([_WARNINGS.neverSynced, ...warnings])],
                        data_state: RETENTION_DATA_STATES.NEVER_SYNCED,
                        // The banner's body. Without it `dataState.js` falls back to `resp.msg` and
                        // prints the SUCCESS message under the heading "Nothing synced yet".
                        unknown_reason: _WARNINGS.neverSynced
                    },
                    {},
                    'Cohort retention resolved.'
                ));
            }

            // A zero-week request cannot happen (`positiveInt` floors at 1), so `oldest` is set on
            // every path below. Narrowed explicitly rather than asserted, because the alternative to
            // a check here is a cast, and this module keeps casts inside `models.repository`.
            if (!oldest) {
                return resolve(promiseReturnResult(false, {}, {}, 'Could not resolve a cohort range for this request. Check `weeks`.'));
            }

            // ── TWO reads, issued together ───────────────────────────────────
            // They touch the same collection with different projections and neither depends on the
            // other, so the second scan costs latency rather than wall-clock. The spine is the
            // POPULATION; the events are the evidence about it.
            const [spine, events] = await Promise.all([
                aggregateInstallSpine({ partner_app_id: appId, since: oldest, until: asOf }),
                findRelationshipEvents({ partner_app_id: appId, since: oldest, until: asOf })
            ]);

            // ── ONE pass over the events, grouped by store ───────────────────
            // Grouped ONCE for the whole request, not once per cohort: the checkpoint fold is handed
            // a store's own slice, which is what keeps the total work at `checkpoints × events`
            // instead of `stores × checkpoints × events`. See the resolver's header.
            const eventsByDomain = new Map<string, RelationshipEventRow[]>();
            let shoplessRelationshipEvents = 0;
            let futureRelationshipEvents = 0;
            for (const row of events) {
                const domain = String(row.shop_domain || '');
                if (domain === '') {
                    //  Counted, not discarded. An uninstall we cannot attach to a store is an
                    // uninstall that lowers nobody's retention, which is a real upward bias and the
                    // only channel it reaches the operator through.
                    shoplessRelationshipEvents += 1;
                    continue;
                }
                const at = _validDate(row.occurred_at);
                if (!at) {
                    continue;
                }
                if (at.getTime() > asOf.getTime()) {
                    // Structurally unreachable — the query is bounded at this same instant — and
                    // counted anyway, because the alternative to counting an impossible row is
                    // discovering later that it was not impossible.
                    futureRelationshipEvents += 1;
                    continue;
                }
                const list = eventsByDomain.get(domain);
                if (list) {
                    list.push(row);
                } else {
                    eventsByDomain.set(domain, [row]);
                }
            }

            // ── ONE pass over the spine, bucketed by install week ────────────
            // `Math.floor((installed_at − oldest) / one week)` rather than a scan: the buckets are
            // fixed-width and contiguous by construction, so the index is arithmetic. Clamped at both
            // ends so a boundary rounding error cannot drop a store out of the grid entirely.
            const storesByWeek: InstallSpineRow[][] = buckets.map(() => []);
            for (const row of spine.rows) {
                const at = _validDate(row.installed_at);
                if (!at) {
                    continue;
                }
                const index = Math.floor((at.getTime() - oldest.getTime()) / _WEEK_MS);
                if (index < 0 || index >= buckets.length) {
                    continue;
                }
                storesByWeek[index].push(row);
            }

            // ── The grid ─────────────────────────────────────────────────────
            let unreachedCells = 0;
            let partialCells = 0;
            let storesWithoutState = 0;

            const cohorts: RetentionCohortRow[] = buckets.map((bucket, index) => {
                const stores = storesByWeek[index];
                const fold = resolveRetentionCheckpoints({
                    stores,
                    events_by_domain: eventsByDomain,
                    checkpoint_days: RETENTION_CHECKPOINT_DAYS,
                    as_of: asOf
                });
                storesWithoutState += fold.stores_without_state;

                const checkpoints: Record<string, RetentionCheckpoint | null> = {};
                const measured: number[] = [];
                const unreached: number[] = [];

                for (const days of RETENTION_CHECKPOINT_DAYS) {
                    const counts = fold.by_checkpoint.get(days);
                    const eligible = counts ? counts.eligible : 0;
                    if (eligible === 0) {
                        //  THE ABSENT OBJECT, not an object of nulls — see the file header. This is
                        // what puts "Cohort not aged enough" in the cell's tooltip instead of
                        // "—/— retained", and what keeps a red 0% off a cohort that installed last
                        // week.
                        checkpoints[retentionCheckpointKey(days)] = null;
                        unreached.push(days);
                        unreachedCells += 1;
                        continue;
                    }
                    const partial = eligible < stores.length;
                    if (partial) {
                        partialCells += 1;
                    }
                    checkpoints[retentionCheckpointKey(days)] = {
                        days,
                        eligible,
                        retained: counts ? counts.retained : 0,
                        //  Through `rate()`, which cannot answer `0` for an empty denominator —
                        // and `eligible` is proved non-zero two lines up, so this is a real ratio.
                        pct: rate(counts ? counts.retained : 0, eligible),
                        partial
                    };
                    measured.push(days);
                }

                return {
                    cohort_week: bucket.week,
                    cohort_week_end: bucket.week_end.toISOString(),
                    is_partial_week: bucket.is_partial,
                    installs: stores.length,
                    // ALWAYS a number, measured from the week's start to the judgement instant, so a
                    // reader can see at a glance why the right-hand columns of a young row are blank.
                    aged_days: wholeDaysBetween(bucket.start, asOf),
                    checkpoints,
                    measured_checkpoints: measured,
                    unreached_checkpoints: unreached
                };
            });

            // ── Everything approximated or excluded, said out loud ───────────
            if (unreachedCells > 0) {
                warnings.push(_WARNINGS.unreachedCells(unreachedCells, buckets.length));
            }
            if (partialCells > 0) {
                warnings.push(_WARNINGS.partialCells(partialCells));
            }
            if (spine.shopless_install_events > 0) {
                warnings.push(_WARNINGS.shoplessInstallEvents(spine.shopless_install_events));
            }
            if (shoplessRelationshipEvents > 0) {
                warnings.push(_WARNINGS.shoplessRelationshipEvents(shoplessRelationshipEvents));
            }
            if (storesWithoutState > 0) {
                warnings.push(_WARNINGS.storesWithoutState(storesWithoutState));
            }
            const newest = buckets.length > 0 ? buckets[buckets.length - 1] : null;
            if (newest && newest.is_partial) {
                warnings.push(_WARNINGS.partialWeek(newest.week));
            }
            warnings.push(..._coverageWarnings(app, oldest));

            const payload: CohortRetentionResponse = {
                ..._envelope,
                cohorts,
                diagnostics: {
                    relationship_events_read: events.length,
                    shopless_install_events: spine.shopless_install_events,
                    shopless_relationship_events: shoplessRelationshipEvents,
                    future_relationship_events: futureRelationshipEvents,
                    stores_without_state: storesWithoutState,
                    unreached_cells: unreachedCells,
                    partial_cells: partialCells,
                    earliest_event_at: _iso(app.earliest_event_at)
                },
                // ⚠️ De-duplicated because the page keys each warning by the string itself, so a
                // repeat is not drawn twice — it is DROPPED, along with its condition.
                warnings: [...new Set(warnings)],
                data_state: RETENTION_DATA_STATES.READY
            };

            // ⚠️ A 200 with an empty grid, always. "Nobody installed in the last twelve weeks" is an
            // ordinary answer, separated from "we have not looked" by `data_state` and from "we cannot
            // see that far back" by `warnings[]` — never by a refusal, which the page would render as
            // advice to run a sync that has already run.
            return resolve(promiseReturnResult(true, payload, {}, 'Cohort retention resolved.'));
        } catch (error) {
            customConsoleError('ERROR: Conversion cohortRetentionService getCohortRetention', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read cohort retention. Please try again.'));
        }
    });
};

export = {
    getCohortRetention
};
