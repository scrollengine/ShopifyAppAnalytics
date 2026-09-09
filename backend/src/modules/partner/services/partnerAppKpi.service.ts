'use strict';

/**
 * ============================================================================
 *  THE PARTNER APPS KPI — eight tiles and a chart
 * ============================================================================
 *
 *  Serves `GET /api/partner-apps/:partner_app_id/kpi`, which
 *  `pages/apps/index.js` already calls and already branches on.
 *  That page is the reference implementation of this project's honesty contract
 *  and this endpoint must not regress it: it decodes `not_implemented`, draws
 *  NOTHING in place of an unavailable figure, and says why —
 *
 *      "An empty KPI tile and an empty chart are indistinguishable from an app
 *       with no installs, and this dashboard does not publish a figure it has
 *       not measured."
 *
 *  Landing this endpoint means that sentence stops being shown. Everything
 *  below exists to make sure it stops being TRUE at the same moment.
 *
 *  ──  EVERY FIGURE IS A BARE NUMBER OR `null` — NEVER AN ENVELOPE ─────────
 *
 *  `components/growth-intel/AppKpiCards.js` formats through `_fmtNumber` and
 *  `_fmtMoney`, which are `Number(n)` and `typeof n !== 'number'`. A confidence
 *  envelope is an object, `Number({…})` is `NaN`, and the card renders an em
 *  dash — so handing that component envelopes would blank all eight tiles at
 *  once. That is the honesty mechanism MANUFACTURING the absence it exists to
 *  prevent. The contract is discharged through `null`, `data_state`,
 *  `coverage`, per-point `measurable` flags and `warnings[]` instead.
 *
 *  ── THE THREE GATES, AND WHY THEY ARE NOT ONE ──────────────────────────────
 *
 *    counts_measurable    the window sits at or above the EVENT floor
 *    revenue_measurable   the window sits at or above the PAYOUT floor
 *    all_time_measurable  a LIFETIME sync has completed
 *
 *  They are separate because the two syncs fail independently — payouts settle
 *  later than the charges that earn them, and a lifetime pull of one can
 *  succeed while the other does not. Collapsing them would let a revenue figure
 *  borrow the events' coverage and publish a month it holds no payouts for.
 *  `resolvers/partnerAppRead.resolver` owns the decision; this file only obeys
 *  it, so the KPI read and the event read cannot disagree about it.
 *
 *  ── NOTHING HERE COMPUTES MONEY ────────────────────────────────────────────
 *
 *  Both cash figures come from `modules/revenue`'s own readers, re-exported by
 *  this module's read repository. There is no `$sum` over payouts in this file
 *  and there must never be one: the two judgements inside those readers — every
 *  transaction type, and `created_at` rather than `createdAt` — are exactly the
 *  kind that get restated slightly differently and produce a KPI tile that
 *  disagrees with the Revenue page.
 *
 *  ── NOTHING HERE DECIDES WHO IS INSTALLED ──────────────────────────────────
 *
 *  `estimated_active` is `modules/store`'s `resolveInstallStates` — the one
 *  definition of "is the app on this store right now" — applied to this app's
 *  relationship events. Not "more installs than uninstalls", which gets a
 *  reinstalled shop right by accident and a shop with a lost uninstall wrong
 *  for ever.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import dateRangeHelper = require('../../shared/helpers/dateRange.helper');
//  TWO DEEP PATHS INTO `modules/store`, NOT ITS BARREL. `import store = require('../../store')`
// eagerly loads four services that each reach the model registry, which is how this codebase
// invented the cycle that left `liveSetAsOf` undefined at load and failed fifteen tests — see
// `modules/revenue/repositories/revenue.repository`'s header for the full account.
//
// THE REUSE THE BARREL EXISTS TO ENFORCE IS FULLY PRESERVED: this reaches the canonical install fold
// rather than growing a second one. Both targets are PURE and neither has an edge back here —
// `installState.resolver` imports only that module's constants and the Partner vocabulary, and
// `storeRoster.constants` imports only the Partner vocabulary.
import installStateResolver = require('../../store/resolvers/installState.resolver');
import storeConstants = require('../../store/constants/storeRoster.constants');
import constants = require('../constants/partnerAppRead.constants');
import installTrendHelper = require('../helpers/installTrend.helper');
import partnerAppReadResolver = require('../resolvers/partnerAppRead.resolver');
import partnerAppRepository = require('../repositories/partnerApp.repository');
import partnerAppReadRepository = require('../repositories/partnerAppRead.repository');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { RelationshipBucketCount } from '../types/installTrend.types';
import type {
    GetPartnerAppKpiInput,
    PartnerAppKpiAllTime,
    PartnerAppKpiData,
    PartnerAppKpiRevenue,
    PartnerAppReadCoverage,
    PartnerAppRelationshipCounts,
    PartnerAppTrendPoint
} from '../types/partnerAppRead.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { resolveDateRange } = dateRangeHelper;
const { resolveInstallStates } = installStateResolver;
const { STORE_INSTALL_STATES } = storeConstants;
const {
    PARTNER_APP_DATA_STATES,
    NEVER_SYNCED_REASON,
    DEFAULT_KPI_PERIOD_DAYS,
    TREND_GRAINS
} = constants;
const { foldInstallTrend, sumRelationshipCounts } = installTrendHelper;
const { resolveReadCoverage, resolveTrendPlan } = partnerAppReadResolver;
const {
    aggregateRelationshipBuckets,
    aggregateRelationshipTypeCounts,
    findAllRelationshipEvents,
    aggregateWindowCurrencies,
    getWindowCash,
    getLifetimeCash
} = partnerAppReadRepository;

/**
 * ⚠️ THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * The page renders one entry per warning KEYED BY THE STRING ITSELF, so a duplicate is not drawn
 * twice — it is DROPPED, silently, along with its condition. Keeping them together is what makes a
 * collision visible at review time rather than as a missing banner in production.
 */
const _WARNINGS = Object.freeze({
    noLifetimeSync: 'No lifetime Partner sync has ever completed for this app, so the stored history is '
        + 'whatever the incremental windows happened to pull. Every all-time figure is withheld rather than '
        + 'shown as a partial sum under a total\'s label — run a LIFETIME sync from the Sync page and they '
        + 'fill in.',

    beforeEventCoverage: (floor: string): string => `The selected period opens before the oldest Partner `
        + `event on record (${floor}), so the install counts for it cannot be measured. They are published as `
        + 'unknown rather than zero: a zero would state that nobody installed the app in that stretch, which '
        + 'is a claim about the business rather than about this deployment\'s records.',

    beforeRevenueCoverage: (floor: string): string => `The selected period opens before the oldest settled `
        + `payout on record (${floor}), so the revenue figures for it cannot be measured. They are withheld `
        + 'rather than shown as zero.',

    noEventFloor: 'A sync has completed but no earliest Partner event has been measured, so this deployment '
        + 'holds no events at all — and without a lifetime sync there is no way to tell an app nobody has '
        + 'installed from an incremental window that happened to be quiet. The install counts are withheld.',

    noRevenueFloor: 'A sync has completed but no earliest settled payout has been measured, so this '
        + 'deployment holds no payouts at all — and without a lifetime sync there is no way to tell an app '
        + 'that has earned nothing from an incremental window that happened to be quiet. The revenue figures '
        + 'are withheld.',

    trendStartsAtFloor: (floor: string): string => `The chart starts at ${floor}, the oldest Partner event on `
        + 'record, rather than at the beginning of time. Below that line nothing has been fetched, so there is '
        + 'nothing to plot — the chart is not claiming the app had no activity before it.',

    trendTruncated: (shown: number, withheld: number): string => `The chart shows the most recent ${shown} `
        + `buckets; ${withheld} earlier ones are not plotted. Their events are still counted in the totals `
        + 'above — the chart is bounded, the arithmetic is not.',

    unmeasuredBuckets: (count: number, floor: string): string => `${count} bucket(s) on the chart open below `
        + `the oldest Partner event on record (${floor}) and are published as unknown rather than zero. The `
        + 'line breaks over them instead of running along the floor, which is what a stretch with no records '
        + 'should look like.',

    partialBuckets: (count: number): string => `${count} bucket(s) on the chart are only partly inside the `
        + 'selected period, so their bars are genuinely shorter than their neighbours without anything having '
        + 'changed. They are flagged `is_partial` on each point. Widening the chart to whole calendar months '
        + 'would make it describe a different period from the tiles above it.',

    mixedCurrencies: (codes: string[]): string => `Settled payouts in this period span ${codes.length} `
        + `currencies (${codes.join(', ')}) and nothing in this build converts between them, so the revenue `
        + 'totals are a sum of unlike units and carry no currency label. There is no exchange rate anywhere in '
        + 'this codebase on purpose: a wrong rate produces a plausible wrong number.',

    shoplessWindowEvents: (count: number): string => `${count} relationship event(s) in the selected `
        + 'period carry no shop domain. They are counted in the install and uninstall tiles — an install '
        + 'with no shop block is still an install — but they cannot be attributed to a store.',

    shoplessAllTimeEvents: (count: number): string => `${count} relationship event(s) across the whole `
        + 'history carry no shop domain. They are counted in the all-time tiles but are NOT represented in '
        + 'the estimated-active figure, which is a fold over stores and has no store to fold them into.',

    estimatedActiveIsAFold: 'Estimated active is a fold over the relationship event stream, not a figure '
        + 'Shopify publishes — the Partner API exposes no live installed-store count on any version. It is as '
        + 'complete as that stream is, and a store whose install event was never synced does not appear in it.',

    futureEvents: (count: number): string => `${count} relationship event(s) are dated after this request's `
        + 'judgement instant — clock skew between Shopify and this host, or a corrupted row. They are excluded '
        + 'from the estimated-active fold rather than allowed to decide a store\'s state from an instant that '
        + 'has not arrived.',

    inactiveApp: 'This app is deactivated. The figures below are the history that was synced before it was '
        + 'deactivated; the sync cron skips it and every sync trigger refuses it, so nothing here will move '
        + 'until it is reactivated with PATCH /api/partner-apps/:app_id { "is_active": true }.'
});

/**
 * Collects warnings while guaranteeing the strings are unique.
 *
 * ⚠️ NOT DECORATION. The frontend keys its banner list by the string itself, so a duplicate is
 * dropped rather than drawn twice — and the condition that raised it disappears with it. A Set is
 * the cheapest way to make that impossible.
 *
 * @returns `{ push, list }`.
 */
const _warningCollector = () => {
    const seen = new Set<string>();
    const list: string[] = [];
    return {
        push: (message: string): void => {
            if (!message || seen.has(message)) {
                return;
            }
            seen.add(message);
            list.push(message);
        },
        list
    };
};

/** An ISO date for a warning sentence, so every floor is quoted the same way. */
const _isoDay = (at: Date | null): string => {
    if (!at) {
        return 'an unknown date';
    }
    return at.toISOString().slice(0, 10);
};

/** The four relationship counts, all null. One literal, so no branch can invent a partial one. */
const _nullCounts = (): PartnerAppRelationshipCounts => ({
    installs: null,
    uninstalls: null,
    reinstalls: null,
    deactivations: null
});

/** The all-time block, all null. Used whole whenever no LIFETIME sync has completed. */
const _nullAllTime = (): PartnerAppKpiAllTime => ({
    ...(_nullCounts()),
    estimated_active: null,
    gross_revenue: null,
    net_revenue: null,
    transaction_count: null
});

/** The revenue block, all null. Used whole whenever the window sits below the payout floor. */
const _nullRevenue = (): PartnerAppKpiRevenue => ({
    gross_total: null,
    net_total: null,
    transaction_count: null,
    currency: null
});

/**
 * Headline KPIs for one partner app, over a window.
 *
 * ONE WINDOW FOR EVERYTHING. The tiles and the chart are folded from the SAME relationship tally —
 * `helpers/installTrend.helper` derives the totals from the buckets in one pass — so a reader who
 * sums the bars and compares the answer with the tile above them gets the same number by
 * construction rather than by agreement.
 *
 *  NEVER_SYNCED IS DECIDED BY `last_synced_at`, NOT BY A ROW COUNT. An app whose merchants have
 * not installed it this month and an app nobody has ever synced produce the identical empty result
 * set; only the watermark separates them, and it is stamped only when BOTH halves of a sync
 * succeeded.
 *
 * ⚠️ AN EMPTY ANSWER IS A 200. `status: false` is reserved for a call that did not happen — no
 * operator, no app id, no such app, or a thrown query. "Nothing to report" is a successful read
 * whose figures are null with a stated reason, because the page has a rendering for that and no
 * rendering at all for a failure envelope over a healthy install.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The read. See {@link GetPartnerAppKpiInput}.
 * @param params1.partner_app_id - The app to report on.
 * @param [params1.period_days] - `'all'` / `0` for lifetime, else days back. Default 30.
 * @param [params1.since] - ISO `YYYY-MM-DD`. Only honoured when `until` parses too.
 * @param [params1.until] - ISO `YYYY-MM-DD`. Only honoured when `since` parses too.
 * @returns The KPI payload on success; `{}` with a message on failure.
 */
const getPartnerAppKpi = (
    { user_id }: IdentityObject,
    { partner_app_id, period_days, since, until }: GetPartnerAppKpiInput
): Promise<ServiceResult<PartnerAppKpiData | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'partner_app_id is required. Read it from GET /api/partner-apps.'));
            }

            const app: PartnerAppDoc | null = await partnerAppRepository.findPartnerAppById(String(partner_app_id));
            if (!app) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }

            const range = resolveDateRange({ period_days, since, until, defaultPeriodDays: DEFAULT_KPI_PERIOD_DAYS });
            const window = {
                since: range.since,
                until: range.until,
                period_label: range.periodLabel,
                period_days: range.periodDays,
                is_lifetime: range.isLifetime
            };

            const coverage: PartnerAppReadCoverage = resolveReadCoverage({
                last_synced_at: app.last_synced_at,
                lifetime_sync_completed_at: app.lifetime_sync_completed_at,
                earliest_event_at: app.earliest_event_at,
                earliest_transaction_at: app.earliest_transaction_at,
                since: range.since
            });

            const warnings = _warningCollector();
            if (!app.is_active) {
                warnings.push(_WARNINGS.inactiveApp);
            }

            // ── The one refusal-shaped answer that is still a 200 ───────────
            //  BY THE WATERMARK, NEVER BY A ROW COUNT. `trend` is `null` rather than `[]` so the
            // frontend decoder takes its banner branch: an empty array is a MEASURED "nothing
            // happened", which renders as a chart-shaped gap and reads as an app nobody installed.
            if (!coverage.last_synced_at) {
                const neverSynced: PartnerAppKpiData = {
                    app_id: String(app._id),
                    period_label: window.period_label,
                    period_days: window.period_days,
                    is_lifetime: window.is_lifetime,
                    window,
                    data_state: PARTNER_APP_DATA_STATES.NEVER_SYNCED,
                    unknown_reason: NEVER_SYNCED_REASON,
                    counts: _nullCounts(),
                    all_time: _nullAllTime(),
                    revenue: _nullRevenue(),
                    trend: null,
                    trend_grain: TREND_GRAINS.DAY,
                    coverage,
                    warnings: warnings.list,
                    diagnostics: {
                        window_relationship_events: 0,
                        all_time_relationship_events: 0,
                        window_shopless_events: 0,
                        all_time_shopless_events: 0,
                        unmeasured_trend_buckets: 0,
                        withheld_trend_buckets: 0,
                        window_currencies: []
                    }
                };
                return resolve(promiseReturnResult(true, neverSynced, {}, NEVER_SYNCED_REASON));
            }

            const plan = resolveTrendPlan({
                since: range.since,
                until: range.until,
                earliest_event_at: coverage.earliest_event_at
            });

            // ── Reads ──────────────────────────────────────────────────────
            // Each all-time read is issued ONLY when its figures can be published. On an app with no
            // lifetime sync that skips the two most expensive queries on this endpoint — a `$group`
            // over the whole event history and a full relationship pull — rather than paying for
            // them and then nulling the answer.
            const appId = String(app._id);
            const [windowBuckets, windowCurrencies, windowCash, allTimeTypeCounts, allTimeEvents, lifetimeCash] = await Promise.all([
                aggregateRelationshipBuckets({ partner_app_id: appId, since: range.since, until: range.until, grain: plan.grain }),
                aggregateWindowCurrencies({ partner_app_id: appId, since: range.since, until: range.until }),
                coverage.revenue_measurable
                    ? getWindowCash({ partner_app_id: appId, since: range.since, until: range.until })
                    : Promise.resolve(null),
                coverage.all_time_measurable
                    ? aggregateRelationshipTypeCounts({ partner_app_id: appId, since: null, until: range.until })
                    : Promise.resolve([] as RelationshipBucketCount[]),
                coverage.all_time_measurable
                    ? findAllRelationshipEvents({ partner_app_id: appId })
                    : Promise.resolve({ rows: [], shopless_relationship_events: 0 }),
                coverage.all_time_measurable
                    ? getLifetimeCash({ partner_app_id: appId })
                    : Promise.resolve(null)
            ]);

            // ── The window: one fold, tiles derived from it ─────────────────
            const unknownReason = coverage.event_floor
                ? _WARNINGS.beforeEventCoverage(_isoDay(coverage.event_floor))
                : _WARNINGS.noEventFloor;
            const trend = foldInstallTrend({
                buckets: plan.buckets,
                counts: windowBuckets,
                //  COMPLETENESS AND THE FLOOR, PASSED SEPARATELY. `event_floor: null` means
                // "complete" only alongside `all_time_measurable`; on an app that has only run
                // incremental syncs and holds no events it means the opposite, and reading the date
                // alone drew a flat line at zero for exactly that deployment.
                coverage_complete: coverage.all_time_measurable,
                coverage_floor: coverage.event_floor,
                unknown_reason: unknownReason
            });

            let counts: PartnerAppRelationshipCounts = _nullCounts();
            if (coverage.counts_measurable) {
                counts = {
                    installs: trend.totals.installs,
                    uninstalls: trend.totals.uninstalls,
                    reinstalls: trend.totals.reinstalls,
                    deactivations: trend.totals.deactivations
                };
            } else if (coverage.event_floor) {
                warnings.push(_WARNINGS.beforeEventCoverage(_isoDay(coverage.event_floor)));
            } else {
                warnings.push(_WARNINGS.noEventFloor);
            }

            // ── The window: money ──────────────────────────────────────────
            let revenue: PartnerAppKpiRevenue = _nullRevenue();
            if (coverage.revenue_measurable) {
                //  A `null` from the cash reader is a MEASURED EMPTY here, not an unknown: the
                // window is inside the payout floor, so "no `$group` document" means nothing settled
                // in it. That is a real zero and is published as one. The reader returns null rather
                // than a zeroed row precisely so this decision is made where the floor is known.
                revenue = {
                    gross_total: windowCash ? windowCash.gross : 0,
                    net_total: windowCash ? windowCash.net : 0,
                    transaction_count: windowCash ? windowCash.tx_count : 0,
                    // Captioned ONLY when there is exactly one denomination — see the warning.
                    currency: windowCurrencies.length === 1 ? windowCurrencies[0] : null
                };
                if (windowCurrencies.length > 1) {
                    warnings.push(_WARNINGS.mixedCurrencies(windowCurrencies));
                }
            } else if (coverage.transaction_floor) {
                warnings.push(_WARNINGS.beforeRevenueCoverage(_isoDay(coverage.transaction_floor)));
            } else {
                warnings.push(_WARNINGS.noRevenueFloor);
            }

            // ── All time ───────────────────────────────────────────────────
            let allTime: PartnerAppKpiAllTime = _nullAllTime();
            let allTimeCountedEvents = 0;
            if (coverage.all_time_measurable) {
                //  THE SAME REDUCER THE WINDOW TILES USE. "Installs" and "Total installs" sit in
                // adjacent cards on one screen and are read against each other, so they are counted
                // by literally the same function over the same row shape.
                const allTimeTally = sumRelationshipCounts(allTimeTypeCounts);
                allTimeCountedEvents = allTimeTally.counted_events;

                //  THE CANONICAL INSTALL FOLD, reached rather than re-derived. `as_of` is the
                // window's close clamped to now: an event that has not happened yet must not decide
                // a store's state, which in practice catches clock skew rather than the future.
                const now = new Date();
                const asOf = range.until.getTime() > now.getTime() ? now : range.until;
                const installFold = resolveInstallStates({ events: allTimeEvents.rows, as_of: asOf });

                let estimatedActive = 0;
                for (const fold of installFold.by_domain.values()) {
                    if (fold.install_state === STORE_INSTALL_STATES.INSTALLED) {
                        estimatedActive += 1;
                    }
                }

                allTime = {
                    installs: allTimeTally.totals.installs,
                    uninstalls: allTimeTally.totals.uninstalls,
                    reinstalls: allTimeTally.totals.reinstalls,
                    deactivations: allTimeTally.totals.deactivations,
                    estimated_active: estimatedActive,
                    //  Same reading as the window's cash: inside the lifetime floor, no document
                    // means nothing ever settled, which is a real zero.
                    gross_revenue: lifetimeCash ? lifetimeCash.total_gross : 0,
                    net_revenue: lifetimeCash ? lifetimeCash.total_net : 0,
                    transaction_count: lifetimeCash ? lifetimeCash.tx_count : 0
                };

                warnings.push(_WARNINGS.estimatedActiveIsAFold);
                if (installFold.diagnostics.future_events > 0) {
                    warnings.push(_WARNINGS.futureEvents(installFold.diagnostics.future_events));
                }
                if (allTimeTally.shopless_events > 0) {
                    warnings.push(_WARNINGS.shoplessAllTimeEvents(allTimeTally.shopless_events));
                }
            } else {
                warnings.push(_WARNINGS.noLifetimeSync);
            }

            // ── What the chart is and is not saying ────────────────────────
            if (trend.unmeasured_buckets > 0) {
                // The floor-less case has its own sentence: quoting "an unknown date" as the floor
                // reads as a rendering fault rather than as the measurement it is.
                warnings.push(coverage.event_floor
                    ? _WARNINGS.unmeasuredBuckets(trend.unmeasured_buckets, _isoDay(coverage.event_floor))
                    : _WARNINGS.noEventFloor);
            }
            if (plan.withheld_buckets > 0) {
                warnings.push(_WARNINGS.trendTruncated(plan.buckets.length, plan.withheld_buckets));
            }
            if (range.isLifetime && coverage.earliest_event_at) {
                warnings.push(_WARNINGS.trendStartsAtFloor(_isoDay(plan.trend_since)));
            }
            const partialPoints = trend.points.filter((point: PartnerAppTrendPoint) => point.is_partial).length;
            if (partialPoints > 0) {
                warnings.push(_WARNINGS.partialBuckets(partialPoints));
            }
            if (trend.shopless_events > 0) {
                warnings.push(_WARNINGS.shoplessWindowEvents(trend.shopless_events));
            }

            const data: PartnerAppKpiData = {
                app_id: appId,
                period_label: window.period_label,
                period_days: window.period_days,
                is_lifetime: window.is_lifetime,
                window,
                data_state: PARTNER_APP_DATA_STATES.READY,
                counts,
                all_time: allTime,
                revenue,
                trend: trend.points,
                trend_grain: plan.grain,
                coverage,
                warnings: warnings.list,
                diagnostics: {
                    window_relationship_events: trend.counted_events,
                    //  FROM THE TALLY, NOT FROM `rows.length`. The relationship PULL excludes
                    // blank-domain rows (they join to no store, so the install fold cannot use
                    // them); the tally counts every relationship event there is. This diagnostic
                    // answers "how many events exist", so it reads the one that knows.
                    all_time_relationship_events: allTimeCountedEvents,
                    window_shopless_events: trend.shopless_events,
                    all_time_shopless_events: allTimeEvents.shopless_relationship_events,
                    unmeasured_trend_buckets: trend.unmeasured_buckets,
                    withheld_trend_buckets: plan.withheld_buckets,
                    window_currencies: windowCurrencies
                }
            };

            return resolve(promiseReturnResult(true, data, {}, 'Partner app KPIs read.'));
        } catch (error) {
            customConsoleError('ERROR: [Partner:Kpi] getPartnerAppKpi threw', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read the partner app KPIs.'));
        }
    });
};

export = {
    getPartnerAppKpi
};
