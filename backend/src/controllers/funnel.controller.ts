'use strict';

/**
 * ============================================================================
 *  FUNNEL / LISTING-ANALYTICS READS
 * ============================================================================
 *
 *  Serves the Traffic Sources page and the top of the Funnel page.
 *
 *  Thin, like every controller here: read the request bag, validate its shape,
 *  call the service, return what it said. Every judgement about the DATA —
 *  including whether an empty answer means "not configured", "never synced" or
 *  "genuinely no traffic" — belongs to the service, which is also what the job
 *  runner and the cron path reach. A second opinion formed here would be a
 *  second place for that answer to drift.
 *
 *  ──  Why an empty result is still a 200 ────────────────────────────────────
 *  These endpoints answer successfully with an empty payload and a populated
 *  `empty_reason` / `empty_message`. That is the point: the page needs to
 *  DISTINGUISH the three empty states and say which one it is, and a 404 or a
 *  500 collapses all three into "something went wrong" — which is how a
 *  perfectly healthy unconfigured deployment starts looking broken, and how a
 *  genuinely broken sync starts looking like a quiet month.
 * ============================================================================
 */

import type { Request, Response } from 'express';
import apiResponse = require('../utils/apiResponse');
import logger = require('../core/logger');
import bigQueryModule = require('../modules/bigquery');
import conversionModule = require('../modules/conversion');

const { customConsoleError } = logger;
const { getFunnelData, getTrafficSourceBreakdown, getGeoBreakdown } = bigQueryModule;
const { getInstallCohort } = conversionModule;

/**
 * Reads the request bag ONCE per handler.
 *
 * A cast, never a coercion. Express types a query value as
 * `string | string[] | ParsedQs | ParsedQs[]`, and a helper that narrowed those to
 * `string | undefined` would silently DISCARD an array-valued parameter at run time — a behaviour
 * change wearing a typing change's clothes. Validation stays in the service, where it already is.
 *
 * @param req - The request.
 * @returns The query bag.
 */
const _query = (req: Request): Record<string, any> => (req.query || {}) as Record<string, any>;

/**
 * Daily funnel counts and the derived rates for one app over a window.
 *
 * @param req
 * @param res
 * @returns
 */
const _funnelOverview = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getFunnelData(identityObj, {
            partner_app_id: String(partnerAppId),
            period_days: q.period_days,
            since: q.since,
            until: q.until
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Funnel funnelController _funnelOverview', error);
        return apiResponse.errorResponse(res, 'Could not read the funnel data. Please try again.');
    }
};

/**
 * Listing traffic broken down by (source, medium).
 *
 * @param req
 * @param res
 * @returns
 */
const _funnelTrafficSource = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getTrafficSourceBreakdown(identityObj, {
            partner_app_id: String(partnerAppId),
            period_days: q.period_days,
            since: q.since,
            until: q.until,
            limit: q.limit
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Funnel funnelController _funnelTrafficSource', error);
        return apiResponse.errorResponse(res, 'Could not read the traffic-source breakdown. Please try again.');
    }
};

/**
 * Listing traffic broken down by country.
 *
 * ⚠️ Traffic by country, NOT revenue by country — that one is served from the Partner API side and
 * counts shops and money rather than visitors. The two will legitimately disagree.
 *
 * @param req
 * @param res
 * @returns
 */
const _funnelGeo = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getGeoBreakdown(identityObj, {
            partner_app_id: String(partnerAppId),
            period_days: q.period_days,
            since: q.since,
            until: q.until,
            limit: q.limit
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Funnel funnelController _funnelGeo', error);
        return apiResponse.errorResponse(res, 'Could not read the geo breakdown. Please try again.');
    }
};

/**
 * The stores that installed in a window, how they arrived, and where they got to.
 *
 * ⚠️ SHAPE ONLY, like every handler here. `state`, `channel`, `sort`, `limit` and `page` are handed
 * through RAW — the service validates them, and it validates them FAIL-OPEN: an unrecognised value
 * is ignored plus warned about, never turned into "match nothing". Rejecting a typo here with a 400
 * would be the opposite behaviour, decided in the one layer that cannot see the vocabulary.
 *
 * This endpoint answers 200 even when the listing-analytics tier is unconfigured or nothing has
 * ever synced. The install spine comes from the Partner API and is complete without BigQuery; the
 * page maps any `status: false` to "No installs recorded for this window — run a Partner sync",
 * which would be wrong twice over. The service says which empty state it is instead.
 *
 * @param req
 * @param res
 * @returns
 */
const _funnelInstallCohort = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getInstallCohort(identityObj, {
            partner_app_id: String(partnerAppId),
            period_days: q.period_days,
            since: q.since,
            until: q.until,
            state: q.state,
            channel: q.channel,
            limit: q.limit,
            page: q.page,
            sort: q.sort,
            sort_dir: q.sort_dir
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Funnel funnelController _funnelInstallCohort', error);
        return apiResponse.errorResponse(res, 'Could not read the install cohort. Please try again.');
    }
};

export = {
    _funnelOverview,
    _funnelTrafficSource,
    _funnelGeo,
    _funnelInstallCohort
};
