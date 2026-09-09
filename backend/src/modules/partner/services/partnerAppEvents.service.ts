'use strict';

/**
 * ============================================================================
 *  THE RAW PARTNER EVENT LOG, AND THE INSTALL TREND BESIDE IT
 * ============================================================================
 *
 *  Serves `GET /api/partner-apps/:partner_app_id/events`.
 *
 *  Every figure this application publishes is a fold over
 *  `gi_partner_app_events`, and until now nothing read those rows back. That is
 *  a real gap rather than a missing convenience: when a number on a dashboard
 *  looks wrong, the only way to find out whether the FOLD is wrong or the ROWS
 *  are is to look at the rows. This endpoint is that surface, which is why it
 *  is an audit log and not a metric — it filters, it pages, and it invents
 *  nothing.
 *
 *  ── TWO ANSWERS, ONE WINDOW, AND ONLY ONE OF THEM IS FILTERED ──────────────
 *
 *  The response carries a PAGE of rows and an install TREND. They share the
 *  window and nothing else:
 *
 *    · the page is filtered by `?type=` and sliced by `?page=`/`?limit=`;
 *    · the trend is folded from a dedicated relationship-event aggregate over
 *      the WHOLE window, untouched by either.
 *
 *  ⚠️ THAT SEPARATION IS THE POINT. A trend derived from the current page would
 *  be a chart of an arbitrary fifty rows wearing an x-axis that claims to cover
 *  the period — and it would change shape as the reader paged, which is the
 *  most convincing possible way to be wrong. A trend derived from a `type`-
 *  filtered read would plot "installs" from a set that excludes installs.
 *
 *  ──  A MONTH WITH NO MEASURABLE VALUE PUBLISHES `null`, NEVER `0` ────────
 *
 *  `InstallTrendChart` plots with Recharts' default `connectNulls={false}`, so
 *  a null BREAKS the line — the honest rendering of "we hold no records here".
 *  A `0` runs the line along the floor and asserts nobody installed the app
 *  that month. The decision lives in `helpers/installTrend.helper` and the gate
 *  it reads lives in `resolvers/partnerAppRead.resolver`, shared with the KPI
 *  read so the same chart on two screens cannot disagree.
 *
 *  ── FILTERS FAIL OPEN; THE WINDOW DOES NOT ─────────────────────────────────
 *
 *  An unrecognised `?type=` is DROPPED with a warning and the list widens. A
 *  table rendering zero rows because of a typo in a query string is
 *  indistinguishable from an app with no events, and the caller has no way to
 *  tell which they are looking at.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import dateRangeHelper = require('../../shared/helpers/dateRange.helper');
import listQueryHelper = require('../../shared/helpers/listQuery.helper');
import constants = require('../constants/partnerAppRead.constants');
import installTrendHelper = require('../helpers/installTrend.helper');
import partnerAppReadResolver = require('../resolvers/partnerAppRead.resolver');
import partnerAppRepository = require('../repositories/partnerApp.repository');
import partnerAppReadRepository = require('../repositories/partnerAppRead.repository');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { PartnerEventListRow } from '../types/partnerAppReadData.types';
import type {
    GetPartnerAppEventsInput,
    PartnerAppEventsData,
    PartnerAppReadCoverage,
    PartnerAppTrendPoint,
    SerializedPartnerEvent
} from '../types/partnerAppRead.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { resolveDateRange } = dateRangeHelper;
const { positiveInt } = listQueryHelper;
const {
    PARTNER_APP_DATA_STATES,
    NEVER_SYNCED_REASON,
    DEFAULT_KPI_PERIOD_DAYS,
    FILTERABLE_EVENT_TYPES,
    DEFAULT_EVENT_PAGE_SIZE,
    MAX_EVENT_PAGE_SIZE,
    MAX_EVENT_PAGE,
    TREND_GRAINS
} = constants;
const { foldInstallTrend } = installTrendHelper;
const { resolveReadCoverage, resolveTrendPlan } = partnerAppReadResolver;
const { aggregateRelationshipBuckets, findPartnerEventPage } = partnerAppReadRepository;

/**
 * ⚠️ THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * The page keys its banner list by the string itself, so a duplicate is DROPPED rather than drawn
 * twice — and the condition that raised it disappears with it.
 */
const _WARNINGS = Object.freeze({
    unknownType: (requested: string): string => `"${requested}" is not a Partner event type this build `
        + `recognises, so the type filter was ignored and every type is listed. The filter widens rather than `
        + `emptying the table on purpose: zero rows caused by a typo looks exactly like an app with no `
        + `events. Valid types: ${FILTERABLE_EVENT_TYPES.join(', ')}.`,

    rawEventWithheld: 'The raw Partner API payload is not included on these rows. It is a document per event '
        + 'on the largest collection in this build, and a page of them is megabytes for a list nobody reads a '
        + 'payload from. Open a single store on the Stores page to inspect a raw node.',

    beforeEventCoverage: (floor: string): string => `Part of the selected period opens before the oldest `
        + `Partner event on record (${floor}). Rows below that line were never fetched, so the table is `
        + `showing everything that exists rather than everything that happened, and the chart breaks over the `
        + 'stretch instead of plotting it as zero.',

    noEventFloor: 'A sync has completed but no earliest Partner event has been measured, so this '
        + 'deployment holds no events at all — and without a lifetime sync there is no way to tell an app '
        + 'nobody has installed from an incremental window that happened to be quiet. The chart is published '
        + 'as unknown throughout rather than drawn flat at zero.',

    unmeasuredBuckets: (count: number, floor: string): string => `${count} bucket(s) on the chart open below `
        + `the oldest Partner event on record (${floor}) and are published as unknown rather than zero.`,

    trendTruncated: (shown: number, withheld: number): string => `The chart shows the most recent ${shown} `
        + `buckets; ${withheld} earlier ones are not plotted.`,

    partialBuckets: (count: number): string => `${count} bucket(s) on the chart are only partly inside the `
        + 'selected period, so their bars are genuinely shorter than their neighbours without anything having '
        + 'changed. They are flagged `is_partial` on each point.',

    shoplessEvents: (count: number): string => `${count} relationship event(s) in this period carry no shop `
        + 'domain. They are listed and counted — an install with no shop block is still an install — but they '
        + 'cannot be attributed to a store.',

    unnamedShops: (count: number, boundary: string): string => `${count} row(s) on this page carry no store `
        + `name. That is a sync boundary, not a store without a name: names are filled for events synced `
        + `since ${boundary}, and a LIFETIME Partner sync fills in the rest. Shopify's Shop.name is non-null, `
        + 'so a shop without one does not exist.',

    pageBeyondEnd: (page: number, totalPages: number): string => `Page ${page} is past the end of this result `
        + `set, which has ${totalPages} page(s). The rows are empty because the page does not exist, not `
        + 'because nothing matched the filter.',

    inactiveApp: 'This app is deactivated. The rows below are the history that was synced before it was '
        + 'deactivated; the sync cron skips it and every sync trigger refuses it, so nothing new will arrive '
        + 'until it is reactivated with PATCH /api/partner-apps/:app_id { "is_active": true }.'
});

/**
 * Collects warnings while guaranteeing the strings are unique. See the KPI service for why.
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

/** An ISO date for a warning sentence, so every boundary is quoted the same way. */
const _isoDay = (at: Date | null): string => {
    if (!at) {
        return 'an unknown date';
    }
    return at.toISOString().slice(0, 10);
};

/**
 * Shapes one stored event for the wire.
 *
 * ⚠️ `shop_name` AND `charge_id` BOTH BECOME `null` WHEN BLANK, AND THE TWO NULLS MEAN OPPOSITE
 * THINGS. A blank `shop_name` is NOT MEASURED — the row predates the sync that fills the column, and
 * Shopify's `Shop.name` is non-null upstream, so it never means "this store has no name". A blank
 * `charge_id` IS a measurement: the four relationship events carry no charge block at all. Both are
 * documented on the wire type, because a consumer that treats them alike would either invent a name
 * or invent a charge.
 *
 * @param row - The lean document.
 * @returns The wire shape.
 */
const _serializeEvent = (row: PartnerEventListRow): SerializedPartnerEvent => {
    const shopName = typeof row.shop_name === 'string' ? row.shop_name.trim() : '';
    const chargeId = typeof row.charge_id === 'string' ? row.charge_id.trim() : '';
    return {
        partner_event_id: row.partner_event_id,
        event_type: row.event_type,
        occurred_at: row.occurred_at,
        shop_domain: row.shop_domain || '',
        shop_name: shopName === '' ? null : shopName,
        shop_id: row.shop_id || '',
        charge_id: chargeId === '' ? null : chargeId
    };
};

/**
 * One page of an app's Partner events, plus the install trend over the same window.
 *
 *  NEVER_SYNCED IS DECIDED BY `last_synced_at`, NOT BY A ROW COUNT. An app whose merchants have
 * not installed it this month and an app nobody has ever synced return the identical empty page;
 * only the watermark separates them, and it is stamped only when BOTH halves of a sync succeeded.
 *
 * ⚠️ AN EMPTY PAGE IS A 200. A list has an honest empty rendering, so "no events matched" is a
 * successful read with `items: []`. `status: false` is reserved for a call that did not happen — no
 * operator, no app id, no such app, or a thrown query.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The read. See {@link GetPartnerAppEventsInput}.
 * @param params1.partner_app_id - The app to read.
 * @param [params1.period_days] - `'all'` / `0` for lifetime, else days back. Default 30.
 * @param [params1.since] - ISO `YYYY-MM-DD`. Only honoured when `until` parses too.
 * @param [params1.until] - ISO `YYYY-MM-DD`. Only honoured when `since` parses too.
 * @param [params1.page] - 1-based. A junk value is page 1, never a 400.
 * @param [params1.limit] - Rows per page, clamped to the ceiling.
 * @param [params1.type] - One event type. Anything unrecognised WIDENS the result.
 * @returns The events payload on success; `{}` with a message on failure.
 */
const getPartnerAppEvents = (
    { user_id }: IdentityObject,
    { partner_app_id, period_days, since, until, page, limit, type }: GetPartnerAppEventsInput
): Promise<ServiceResult<PartnerAppEventsData | EmptyPayload>> => {
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

            // The SAME default window as the KPI read, deliberately: both sit on one screen, and a
            // different default would put the table and the tiles above it on different periods.
            const range = resolveDateRange({ period_days, since, until, defaultPeriodDays: DEFAULT_KPI_PERIOD_DAYS });
            const window = {
                since: range.since,
                until: range.until,
                period_label: range.periodLabel,
                period_days: range.periodDays,
                is_lifetime: range.isLifetime
            };

            const requestedPage = positiveInt(page, 1, MAX_EVENT_PAGE);
            const requestedLimit = positiveInt(limit, DEFAULT_EVENT_PAGE_SIZE, MAX_EVENT_PAGE_SIZE);

            // ── The filter, fail-open ──────────────────────────────────────
            const warnings = _warningCollector();
            let eventType: string | null = null;
            let typeIgnored = false;
            const requestedType = typeof type === 'string' ? type.trim().toUpperCase() : '';
            if (requestedType !== '') {
                if (FILTERABLE_EVENT_TYPES.indexOf(requestedType) !== -1) {
                    eventType = requestedType;
                } else {
                    typeIgnored = true;
                    warnings.push(_WARNINGS.unknownType(requestedType));
                }
            }

            if (!app.is_active) {
                warnings.push(_WARNINGS.inactiveApp);
            }

            const coverage: PartnerAppReadCoverage = resolveReadCoverage({
                last_synced_at: app.last_synced_at,
                lifetime_sync_completed_at: app.lifetime_sync_completed_at,
                earliest_event_at: app.earliest_event_at,
                earliest_transaction_at: app.earliest_transaction_at,
                since: range.since
            });

            // ── The one refusal-shaped answer that is still a 200 ───────────
            //  BY THE WATERMARK, NEVER BY A ROW COUNT. `items` and `trend` are `null` rather than
            // `[]` so the frontend decoder takes its banner branch: an empty array is a MEASURED
            // "nothing matched", which renders as an empty table over a healthy install.
            if (!coverage.last_synced_at) {
                const neverSynced: PartnerAppEventsData = {
                    app_id: String(app._id),
                    window,
                    data_state: PARTNER_APP_DATA_STATES.NEVER_SYNCED,
                    unknown_reason: NEVER_SYNCED_REASON,
                    items: null,
                    pagination: { page: requestedPage, limit: requestedLimit, total: 0, total_pages: 0, has_more: false },
                    filters: { type: eventType, type_ignored: typeIgnored },
                    trend: null,
                    trend_grain: TREND_GRAINS.DAY,
                    coverage,
                    warnings: warnings.list,
                    diagnostics: {
                        rows_returned: 0,
                        trend_relationship_events: 0,
                        unmeasured_trend_buckets: 0,
                        withheld_trend_buckets: 0
                    }
                };
                return resolve(promiseReturnResult(true, neverSynced, {}, NEVER_SYNCED_REASON));
            }

            const plan = resolveTrendPlan({
                since: range.since,
                until: range.until,
                earliest_event_at: coverage.earliest_event_at
            });

            const appId = String(app._id);
            const [pageResult, trendBuckets] = await Promise.all([
                findPartnerEventPage({
                    partner_app_id: appId,
                    since: range.since,
                    until: range.until,
                    event_type: eventType,
                    skip: (requestedPage - 1) * requestedLimit,
                    limit: requestedLimit
                }),
                // ⚠️ NOT the paged read. See the file header: a trend folded from the current page
                // would change shape as the reader pages, and a `type`-filtered one would plot
                // "installs" from a set that excludes installs.
                aggregateRelationshipBuckets({
                    partner_app_id: appId,
                    since: range.since,
                    until: range.until,
                    grain: plan.grain
                })
            ]);

            const unknownReason = coverage.event_floor
                ? _WARNINGS.beforeEventCoverage(_isoDay(coverage.event_floor))
                : _WARNINGS.noEventFloor;
            const trend = foldInstallTrend({
                buckets: plan.buckets,
                counts: trendBuckets,
                //  See the KPI service: `event_floor: null` licenses a zero only alongside
                // `all_time_measurable`, so the two travel as two parameters.
                coverage_complete: coverage.all_time_measurable,
                coverage_floor: coverage.event_floor,
                unknown_reason: unknownReason
            });

            const items: SerializedPartnerEvent[] = [];
            let unnamedShops = 0;
            for (const row of pageResult.rows) {
                const serialized = _serializeEvent(row);
                if (serialized.shop_name === null && serialized.shop_domain !== '') {
                    unnamedShops += 1;
                }
                items.push(serialized);
            }

            const totalPages = pageResult.total === 0 ? 0 : Math.ceil(pageResult.total / requestedLimit);

            // ── What the reader is and is not looking at ───────────────────
            warnings.push(_WARNINGS.rawEventWithheld);
            if (!coverage.counts_measurable && coverage.event_floor) {
                warnings.push(_WARNINGS.beforeEventCoverage(_isoDay(coverage.event_floor)));
            }
            if (trend.unmeasured_buckets > 0) {
                warnings.push(coverage.event_floor
                    ? _WARNINGS.unmeasuredBuckets(trend.unmeasured_buckets, _isoDay(coverage.event_floor))
                    : _WARNINGS.noEventFloor);
            }
            if (plan.withheld_buckets > 0) {
                warnings.push(_WARNINGS.trendTruncated(plan.buckets.length, plan.withheld_buckets));
            }
            const partialPoints = trend.points.filter((point: PartnerAppTrendPoint) => point.is_partial).length;
            if (partialPoints > 0) {
                warnings.push(_WARNINGS.partialBuckets(partialPoints));
            }
            if (trend.shopless_events > 0) {
                warnings.push(_WARNINGS.shoplessEvents(trend.shopless_events));
            }
            if (unnamedShops > 0) {
                //  The BOUNDARY, not a bare count. `shop_name_coverage_since` is what turns a
                // half-named table from "data was lost" into "sync state with a one-command fix".
                const boundary = app.shop_name_coverage_since instanceof Date
                    ? _isoDay(app.shop_name_coverage_since)
                    : 'no date yet — no sync has run since the name column landed';
                warnings.push(_WARNINGS.unnamedShops(unnamedShops, boundary));
            }
            if (totalPages > 0 && requestedPage > totalPages) {
                warnings.push(_WARNINGS.pageBeyondEnd(requestedPage, totalPages));
            }

            const data: PartnerAppEventsData = {
                app_id: appId,
                window,
                data_state: PARTNER_APP_DATA_STATES.READY,
                items,
                pagination: {
                    page: requestedPage,
                    limit: requestedLimit,
                    total: pageResult.total,
                    total_pages: totalPages,
                    has_more: requestedPage * requestedLimit < pageResult.total
                },
                filters: { type: eventType, type_ignored: typeIgnored },
                trend: trend.points,
                trend_grain: plan.grain,
                coverage,
                warnings: warnings.list,
                diagnostics: {
                    rows_returned: items.length,
                    trend_relationship_events: trend.counted_events,
                    unmeasured_trend_buckets: trend.unmeasured_buckets,
                    withheld_trend_buckets: plan.withheld_buckets
                }
            };

            return resolve(promiseReturnResult(true, data, {}, 'Partner app events read.'));
        } catch (error) {
            customConsoleError('ERROR: [Partner:Events] getPartnerAppEvents threw', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read the partner app events.'));
        }
    });
};

export = {
    getPartnerAppEvents
};
