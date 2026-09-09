'use strict';

/**
 * ============================================================================
 *  LISTING ANALYTICS — the read side
 * ============================================================================
 *
 *  Serves the Traffic Sources view and the UPPER STEPS of the conversion funnel out of the three
 *  daily rollups. Nothing here touches BigQuery: the rollups are already in Mongo, and a dashboard
 *  request must never be able to start a billed scan.
 *
 *  ── FOUR WAYS TO HAVE NOTHING TO SHOW, AND THEY DO NOT LOOK ALIKE ────────
 *
 *    1. NOT CONNECTED   No credentials. Resolves `status: false` with a message naming the missing
 *                       environment variable. No payload at all.
 *    2. NEVER SYNCED    Connected, but no sync has ever completed. Resolves `status: true` with
 *                       `summary`/`items` as NULL and `data_state: 'NEVER_SYNCED'`.
 *    3. NO ROW IN THE   Synced, but this window's `$group` matched nothing, so it emitted no
 *       WINDOW          document. `data_state: 'READY'`, `summary: null`, `trend: []`, and
 *                       `unknown_reason` = `EMPTY_WINDOW_REASON`. See `docs/FIDELITY.md` §4.
 *    4. GENUINELY EMPTY Synced, rows exist, and they really are zeros. `data_state: 'READY'` with a
 *                       real summary object — measured zeros in the counts, and `null` for any rate
 *                       whose denominator was one of them.
 *
 *  Case 2 collapsing into case 4 is the bug this whole project exists to refuse: an empty array and
 *  a zeroed funnel are CLAIMS ABOUT THE MERCHANT'S LISTING, and we have not earned either until a
 *  sync has actually run. The two are one null watermark apart, which is exactly why the watermark
 *  is read here and turned into an explicit state rather than left implicit in the row count.
 *
 *  ⚠️ Reading zero ROWS is not the discriminator for case 2 and must not be used as one: a window
 *  with no rows is a perfectly ordinary answer once a sync has happened. That is what case 3 IS —
 *  and it earns its own reason sentence rather than borrowing the never-synced one.
 *
 *  ── AND CASE 3 COLLAPSED INTO CASE 4 FOR REAL, IN THIS FILE ────────────
 *
 *  `const t = totals || { views: 0, … }` sat where the case-3 branch now is. The repository
 *  honoured the doc and returned null; this service rebuilt the zeroed row the doc forbids, derived
 *  five rates from it, and published a funnel for a window it had read no row of.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import constants = require('../constants/bigQuery.constants');
import rowHelper = require('../helpers/bigQueryRow.helper');
import availabilityResolver = require('../resolvers/bigQueryAvailability.resolver');
import syncStateRepository = require('../repositories/bigQuerySyncState.repository');
import listingRollupRepository = require('../repositories/listingRollup.repository');
import dateRangeHelper = require('../../shared/helpers/dateRange.helper');
// DEEP PATH TO A PURE LEAF, NEVER `require('../../conversion')`. `modules/conversion` imports
// THIS module's barrel (`customFunnel.service.ts`), so reaching back through conversion's barrel
// would close a cycle that type-checks and lints perfectly and shows up only as an undefined
// import at load. `funnelMath.helper` imports one constants file and nothing else.
//
// And it is imported rather than re-implemented for the reason its own header gives: a second
// spelling of "divide" is how the first one comes back. The `safeDiv` this replaces was exactly
// that second spelling, living one module away from the fix.
import funnelMathHelper = require('../../conversion/helpers/funnelMath.helper');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { ResolveDateRangeInput } from '../../shared/types/dateRange.types';
import type {
    AnalyticsDateMatch,
    AnalyticsWindow,
    AnalyticsWindowEcho,
    GetFunnelDataInput,
    GetFunnelDataResponse,
    GetGeoBreakdownInput,
    GetGeoBreakdownResponse,
    GetTrafficSourceBreakdownInput,
    GetTrafficSourceBreakdownResponse,
    ListingDataState
} from '../types/bigQueryAnalytics.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { NEVER_SYNCED_REASON, EMPTY_WINDOW_REASON } = constants;
const { num } = rowHelper;
const { rate } = funnelMathHelper;
const { resolveBigQueryAvailability } = availabilityResolver;
const { findSyncTargetApp } = syncStateRepository;
const {
    findFunnelTrend,
    aggregateFunnelTotals,
    aggregateSourceBreakdown,
    aggregateGeoBreakdown
} = listingRollupRepository;
const { resolveDateRange } = dateRangeHelper;

const _isoDate = (d?: Date | string | number | null): Date | null => {
    if (!d) {
        return null;
    }
    return new Date(d);
};

const _resolveWindow = ({ period_days, since, until }: ResolveDateRangeInput): AnalyticsWindow => {
    const r = resolveDateRange({ period_days, since, until, defaultPeriodDays: 30 });
    return {
        since: r.since,
        until: r.until,
        is_lifetime: r.isLifetime,
        label: r.periodLabel,
        period_days: r.periodDays,
        kind: r.kind
    };
};

/**
 * The `date` predicate for a window. Empty (`{}`) for lifetime — no bound at all, rather than a
 * bound at the beginning of time, so the query can use the index the same way either way.
 *
 * @param win - The resolved window.
 * @returns The match fragment to spread into a query.
 */
const _dateMatchClause = (win: AnalyticsWindow): AnalyticsDateMatch => {
    if (win.is_lifetime) {
        return {};
    }
    const range: { $gte?: Date; $lte?: Date } = {};
    if (win.since) {
        range.$gte = win.since;
    }
    if (win.until) {
        range.$lte = win.until;
    }
    if (Object.keys(range).length === 0) {
        return {};
    }
    return { date: range };
};

/**
 * The fields every response echoes, including the state of the data behind it.
 *
 * `data_state` is decided by the WATERMARK, never by the row count. A window with no rows is an
 * ordinary answer once a sync has run; a null watermark means no sync ever has, and those two must
 * never render the same way.
 *
 * ⚠️ `unknown_reason` is set HERE only for NEVER_SYNCED. `getFunnelData` sets its own on the
 * empty-window branch, because that reason is about the WINDOW rather than about the app, and this
 * helper has not read a row when it runs.
 *
 * @param app - The app row, for its `_id` and watermark.
 * @param win - The resolved window.
 * @returns The echo block, with `unknown_reason` set only when never synced.
 */
const _windowEcho = (app: PartnerAppDoc, win: AnalyticsWindow): AnalyticsWindowEcho => {
    let data_state: ListingDataState = 'NEVER_SYNCED';
    if (app.last_bq_synced_at) {
        data_state = 'READY';
    }

    let period_days: 'all' | number | null = win.period_days;
    if (win.is_lifetime) {
        period_days = 'all';
    }

    const echo: AnalyticsWindowEcho = {
        app_id: String(app._id),
        is_lifetime: win.is_lifetime,
        period_days,
        period_label: win.label,
        since: win.since,
        until: win.until,
        kind: win.kind,
        last_bq_synced_at: app.last_bq_synced_at,
        data_state
    };
    if (data_state === 'NEVER_SYNCED') {
        echo.unknown_reason = NEVER_SYNCED_REASON;
    }
    return echo;
};

/**
 * Loads the app and refuses early when the tier cannot answer at all.
 *
 * Returns either a failure envelope to resolve verbatim, or the app row. Written once because all
 * three endpoints owe the reader exactly the same refusal, and three copies of a refusal is how one
 * of them ends up returning `[]`.
 *
 * @param [partner_app_id] - The app to read.
 * @returns `{ failure }` to resolve, or `{ app }` to continue with.
 */
const _loadReadableApp = async (partner_app_id?: string): Promise<{ failure?: ServiceResult<any>; app?: PartnerAppDoc }> => {
    if (!partner_app_id) {
        return { failure: promiseReturnResult(false, {}, {}, 'partner_app_id is required.') };
    }

    const availability = resolveBigQueryAvailability();
    if (!availability.enabled) {
        //  Not an empty result set. See the file header: with no data source connected, an empty
        // chart is a claim about the merchant's listing that we have no basis for.
        return { failure: promiseReturnResult(false, {}, {}, availability.message) };
    }

    const app = await findSyncTargetApp(partner_app_id);
    if (!app) {
        return { failure: promiseReturnResult(false, {}, {}, 'Partner app not found.') };
    }
    return { app };
};

/**
 * Daily funnel rollup plus summary KPIs for an app.
 *
 * ⚠️ These count VISITORS. Everything from the Partner API side counts SHOPS, so any ratio that
 * crosses that seam compares two different populations — the view marks the seam rather than
 * quietly presenting the ratio as fact.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query.
 * @param params1.partner_app_id - The app to report on.
 * @param [params1.period_days] - number, 0, or 'all' (default 30).
 * @param [params1.since] - ISO date; honoured only together with `until`.
 * @param [params1.until] - ISO date; honoured only together with `since`.
 * @returns The funnel, or an honest refusal carrying `{}`.
 */
const getFunnelData = ({ user_id }: IdentityObject, { partner_app_id, period_days, since, until }: GetFunnelDataInput): Promise<ServiceResult<GetFunnelDataResponse | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            const loaded = await _loadReadableApp(partner_app_id);
            if (loaded.failure || !loaded.app) {
                return resolve(loaded.failure || promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }
            const app = loaded.app;

            const win = _resolveWindow({ period_days, since, until });
            const echo = _windowEcho(app, win);

            if (echo.data_state === 'NEVER_SYNCED') {
                // NULL, not a zeroed summary and not an empty trend. A funnel drawn with zeros
                // says this listing was seen by nobody; this says we have not looked yet.
                return resolve(promiseReturnResult(true, {
                    ...echo,
                    summary: null,
                    trend: null
                }, {}, NEVER_SYNCED_REASON));
            }

            const date_match = _dateMatchClause(win);
            const [trend, totals] = await Promise.all([
                findFunnelTrend({ partner_app_id: String(app._id), date_match }),
                aggregateFunnelTotals({ partner_app_id: String(app._id), date_match })
            ]);

            // THE NULL IS THE ANSWER. `aggregateFunnelTotals` returns null because `$group`
            // emits no document for an empty match, and `docs/FIDELITY.md` (§4, `/api/funnel`)
            // requires that null be PRESERVED: it is the discriminator between "the rollup has
            // nothing for these dates" and "the rollup says zero".
            //
            // What stood here was `const t = totals || { views: 0, … }` — ten zeroed counts, from
            // which five rates were then derived — and the endpoint published a complete, confident
            // funnel for a window it had never read a row of. `summary: null` survived only on the
            // NEVER_SYNCED branch above, which answers a DIFFERENT question (has a sync ever run),
            // so the one case the doc names was the one case that lost its null.
            //
            // ⚠️ `unknown_reason` is set on a READY echo here, and that is deliberate: the reader
            // needs a sentence, and this is the field every consumer already prints. It says
            // something different from `NEVER_SYNCED_REASON` on purpose — see the constant.
            if (!totals) {
                return resolve(promiseReturnResult(true, {
                    ...echo,
                    unknown_reason: EMPTY_WINDOW_REASON,
                    summary: null,
                    // `[]`, not null: the trend read matched the same rows the totals did, so an
                    // empty array here is the SAME measured fact, and a null would claim a second
                    // unknown the query never encountered.
                    trend: []
                }, {}, EMPTY_WINDOW_REASON));
            }

            const summary = {
                ...totals,
                overall_conversion_rate: rate(totals.installs, totals.views),
                ad_attributed_share: rate(totals.ad_clicks, totals.installs),
                consent_completion_rate: rate(totals.consent_completed, totals.consent_started),
                click_through_rate: rate(totals.install_clicks, totals.views),
                first_open_rate: rate(totals.first_opens, totals.installs)
            };

            return resolve(promiseReturnResult(true, {
                ...echo,
                summary,
                // THE TREND'S RATES ARE DERIVED HERE, NOT READ OFF THE ROW.
                //
                // The stored `overall_conversion_rate` / `ad_attributed_share` columns were written
                // by the old `safeDiv`, so every historical day with no views carries a literal `0`
                // — and `num()` would republish it as a measured zero for ever, because an
                // INCREMENTAL re-sync never reaches back over those days to repair them. Deriving
                // from the row's own numerator and denominator through the SAME `rate()` the summary
                // uses fixes the history on read AND makes it impossible for the line to disagree
                // with the headline above it.
                //
                // ⚠️ `num()` on the COUNTS is right and must stay: an absent count is genuinely zero
                // occurrences. `num()` on a RATE is the bug — see the helper's own note.
                trend: trend.map((r) => ({
                    date: _isoDate(r.date),
                    views: num(r.views),
                    engaged_views: num(r.engaged_views),
                    install_clicks: num(r.install_clicks),
                    consent_started: num(r.consent_started),
                    consent_completed: num(r.consent_completed),
                    installs: num(r.installs),
                    ad_clicks: num(r.ad_clicks),
                    first_opens: num(r.first_opens),
                    overall_conversion_rate: rate(num(r.installs), num(r.views)),
                    ad_attributed_share: rate(num(r.ad_clicks), num(r.installs))
                }))
            }, {}, 'Funnel data fetched.'));
        } catch (error) {
            customConsoleError('Error in bigQueryAnalyticsService.getFunnelData', { error, user_id });
            return resolve(promiseReturnResult(false, {}, error, 'Failed to fetch funnel data.'));
        }
    });
};

/**
 * Traffic source / medium breakdown over a window.
 *
 * ⚠️ `traffic_source.*` is the visitor's FIRST-EVER acquisition, not the visit that converted. This
 * endpoint therefore answers "who did these visitors originally come from", NOT "where did this
 * install come from" — that question is answered only by the per-install attribution table.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query.
 * @param params1.partner_app_id - The app to report on.
 * @param [params1.period_days] - number, 0, or 'all' (default 30).
 * @param [params1.since] - ISO date; honoured only together with `until`.
 * @param [params1.until] - ISO date; honoured only together with `since`.
 * @param [params1.limit=50] - Row ceiling, clamped to 1..200.
 * @returns The breakdown, or a refusal carrying `{}`.
 */
const getTrafficSourceBreakdown = ({ user_id }: IdentityObject, { partner_app_id, period_days, since, until, limit }: GetTrafficSourceBreakdownInput): Promise<ServiceResult<GetTrafficSourceBreakdownResponse | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            const loaded = await _loadReadableApp(partner_app_id);
            if (loaded.failure || !loaded.app) {
                return resolve(loaded.failure || promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }
            const app = loaded.app;

            const win = _resolveWindow({ period_days, since, until });
            const echo = _windowEcho(app, win);

            if (echo.data_state === 'NEVER_SYNCED') {
                // NULL, not `[]`. An empty table reads as "no traffic came from anywhere".
                return resolve(promiseReturnResult(true, { ...echo, items: null }, {}, NEVER_SYNCED_REASON));
            }

            // `String(limit)` rather than the bare value only because `limit` is optional here:
            // `parseInt(undefined)` and `parseInt('undefined')` both yield NaN, so the `|| 50`
            // fallback is reached identically either way.
            const _limit = Math.min(Math.max(parseInt(String(limit), 10) || 50, 1), 200);
            const items = await aggregateSourceBreakdown({
                partner_app_id: String(app._id),
                date_match: _dateMatchClause(win),
                limit: _limit
            });

            return resolve(promiseReturnResult(true, { ...echo, items }, {}, 'Traffic source breakdown fetched.'));
        } catch (error) {
            customConsoleError('Error in bigQueryAnalyticsService.getTrafficSourceBreakdown', { error, user_id });
            return resolve(promiseReturnResult(false, {}, error, 'Failed to fetch traffic source breakdown.'));
        }
    });
};

/**
 * Per-country breakdown over a window.
 *
 * ⚠️ Traffic by country, NOT revenue by country. `country` is a full name as the export writes it,
 * not an ISO code, so joining it to anything requires normalising both sides.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query.
 * @param params1.partner_app_id - The app to report on.
 * @param [params1.period_days] - number, 0, or 'all' (default 30).
 * @param [params1.since] - ISO date; honoured only together with `until`.
 * @param [params1.until] - ISO date; honoured only together with `since`.
 * @param [params1.limit=50] - Row ceiling, clamped to 1..250.
 * @returns The breakdown, or a refusal carrying `{}`.
 */
const getGeoBreakdown = ({ user_id }: IdentityObject, { partner_app_id, period_days, since, until, limit }: GetGeoBreakdownInput): Promise<ServiceResult<GetGeoBreakdownResponse | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            const loaded = await _loadReadableApp(partner_app_id);
            if (loaded.failure || !loaded.app) {
                return resolve(loaded.failure || promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }
            const app = loaded.app;

            const win = _resolveWindow({ period_days, since, until });
            const echo = _windowEcho(app, win);

            if (echo.data_state === 'NEVER_SYNCED') {
                // NULL, not `[]`. An empty map reads as "no country visited this listing".
                return resolve(promiseReturnResult(true, { ...echo, items: null }, {}, NEVER_SYNCED_REASON));
            }

            // See the note on the traffic-source limit above — `String(limit)` is NaN-identical.
            const _limit = Math.min(Math.max(parseInt(String(limit), 10) || 50, 1), 250);
            const items = await aggregateGeoBreakdown({
                partner_app_id: String(app._id),
                date_match: _dateMatchClause(win),
                limit: _limit
            });

            return resolve(promiseReturnResult(true, { ...echo, items }, {}, 'Geo breakdown fetched.'));
        } catch (error) {
            customConsoleError('Error in bigQueryAnalyticsService.getGeoBreakdown', { error, user_id });
            return resolve(promiseReturnResult(false, {}, error, 'Failed to fetch geo breakdown.'));
        }
    });
};

export = {
    getFunnelData,
    getTrafficSourceBreakdown,
    getGeoBreakdown
};
