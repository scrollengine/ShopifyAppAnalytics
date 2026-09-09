'use strict';

/**
 * ============================================================================
 *  CONVERSION READS
 * ============================================================================
 *
 *  Serves the Funnel page's step chart and the trial block beneath it.
 *
 *  Thin, like every controller here: read the request bag, validate its SHAPE, call the service,
 *  return what it said. Every judgement about the DATA — which steps a caller may have, whether an
 *  unknown step key is an error or a warning, what an empty answer means — belongs to the service,
 *  which is also what a test and any future job runner reach. A second opinion formed here would be
 *  a second place for that answer to drift.
 *
 *  ── ⚠️ NO `period_days` NORMALISATION HERE ──────────────────────────────────
 *
 *  `q.period_days` is passed through RAW, exactly as `funnel.controller.ts` does.
 *  `modules/shared/helpers/dateRange.helper` already understands `'all'`, `0` and `'0'` with a
 *  `parseInt` fallback, and a second normaliser in this layer would give the parameter two spellings
 *  to drift between — with the controller's copy being the one no test covers.
 *
 *  ── WHY AN UNCONFIGURED BIGQUERY IS STILL A 200 ──────────────────────────
 *
 *  This is the first MIXED-TIER read in the build: the listing steps come from BigQuery rollups and
 *  everything else from the Partner API. A refusal maps, on the page, to PartnerFunnelChart's own
 *  empty state — "No funnel data for this window yet — run a sync to populate GA4 and Partner
 *  events" — which would be wrong on a deployment whose Partner events are already synced and
 *  correct. The service answers 200 with per-tier states, per-step `available` / `unknown_reason`,
 *  and `warnings[]`, which the chart already renders verbatim.
 * ============================================================================
 */

import type { Request, Response } from 'express';
import apiResponse = require('../utils/apiResponse');
import logger = require('../core/logger');
import conversionModule = require('../modules/conversion');

const { customConsoleError } = logger;
const {
    getCustomFunnel,
    getFunnel,
    getTrialOutcomes,
    getTrialTrend,
    getCohortRetention,
    getTimeToPaid,
    getPlanMix,
    getLogoChurn,
    getRevenueChurn
} = conversionModule;

/**
 * Reads the request bag ONCE per handler.
 *
 * A cast, never a coercion. Express types a query value as
 * `string | string[] | ParsedQs | ParsedQs[]`, and a helper that narrowed those to
 * `string | undefined` would silently DISCARD an array-valued parameter at run time — which matters
 * here more than anywhere else in the codebase, because `events` is legitimately array-valued when
 * a client sends `?events=a&events=b` rather than the page's comma-joined form.
 *
 * @param req - The request.
 * @returns The query bag.
 */
const _query = (req: Request): Record<string, any> => (req.query || {}) as Record<string, any>;

/**
 * The step funnel the operator built, plus the trial cohort beneath it.
 *
 * ⚠️ `events` is handed through RAW — comma-joined string or repeated parameter, whichever arrived —
 * and ITS ORDER IS THE FUNNEL. The service resolves it against the catalog, warns about anything it
 * had to drop, and returns the steps IN THE ORDER REQUESTED, because the page persists
 * `steps.map(s => s.key)` back into `localStorage` and a reordered answer overwrites the operator's
 * own saved funnel.
 *
 * @param req
 * @param res
 * @returns
 */
const _conversionCustomFunnel = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getCustomFunnel(identityObj, {
            partner_app_id: String(partnerAppId),
            period_days: q.period_days,
            since: q.since,
            until: q.until,
            events: q.events
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Conversion conversionController _conversionCustomFunnel', error);
        return apiResponse.errorResponse(res, 'Could not read the custom funnel. Please try again.');
    }
};

/**
 * The FIXED seven-stage end-to-end funnel.
 *
 * ⚠️ NOT the same endpoint as `custom-funnel`, and the difference is the ONE thing this handler has
 * to get right: there are no `events` here. The stage list is fixed server-side, so a client that
 * sent `?events=…` would be silently ignored — which is correct, and is why nothing is read from the
 * bag beyond the window. Accepting an `events` parameter here would advertise a picker this chart
 * does not have.
 *
 * ⚠️ `period_days` IS PASSED THROUGH RAW, exactly as every other handler in this file does it.
 * `modules/shared/helpers/dateRange.helper` already understands `'all'`, `0` and `'0'` with a
 * `parseInt` fallback, and a second normaliser in this layer would give the parameter two spellings
 * to drift between — with the controller's copy being the one no test covers.
 *
 * @param req
 * @param res
 * @returns
 */
const _conversionFunnel = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getFunnel(identityObj, {
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
        customConsoleError('ERROR: Conversion conversionController _conversionFunnel', error);
        return apiResponse.errorResponse(res, 'Could not read the conversion funnel. Please try again.');
    }
};

/**
 * Weekly install cohorts against retention checkpoints.
 *
 * ⚠️ `weeks` IS PASSED THROUGH RAW. The service clamps it to the range this endpoint serves and
 * WARNS about what it clamped — an out-of-range value is a typo, not something worth refusing a
 * whole grid over, and the clamp has to be visible on the payload rather than performed silently in
 * two places.
 *
 * ⚠️ THIS ENDPOINT TAKES NO WINDOW. The page calls it with `{ weeks: 12 }` alone and the cohorts are
 * always the most recent N weeks — a date range would mean two different notions of "recent" on one
 * tab, and the heatmap has no control that would let a reader tell them apart.
 *
 * @param req
 * @param res
 * @returns
 */
const _conversionCohortRetention = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getCohortRetention(identityObj, {
            partner_app_id: String(partnerAppId),
            weeks: q.weeks
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Conversion conversionController _conversionCohortRetention', error);
        return apiResponse.errorResponse(res, 'Could not read cohort retention. Please try again.');
    }
};

/**
 * The days-to-first-paid histogram for the stores that installed in a window.
 *
 * ⚠️ `period_days` IS PASSED THROUGH RAW, for the reason above.
 *
 * @param req
 * @param res
 * @returns
 */
const _conversionTimeToPaid = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getTimeToPaid(identityObj, {
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
        customConsoleError('ERROR: Conversion conversionController _conversionTimeToPaid', error);
        return apiResponse.errorResponse(res, 'Could not read time to paid. Please try again.');
    }
};

/**
 * The plan-mix snapshot and its 30-day churn.
 *
 * ⚠️ A SNAPSHOT, SO IT TAKES NO WINDOW AT ALL — the page calls it with `{ partner_app_id }` alone.
 * Nothing else is read from the bag: accepting a date range here would suggest the donuts can be
 * pointed at a past month, and they cannot. "Who is paying right now" is a point-in-time question,
 * and the 30-day churn beneath it is measured from that same instant.
 *
 * @param req
 * @param res
 * @returns
 */
const _conversionPlanMix = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getPlanMix(identityObj, {
            partner_app_id: String(partnerAppId)
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Conversion conversionController _conversionPlanMix', error);
        return apiResponse.errorResponse(res, 'Could not read the plan mix. Please try again.');
    }
};

/**
 * Per-shop trial outcome classification for a window.
 *
 * ⚠️ `period_days` IS PASSED THROUGH RAW, exactly as the handler above does it.
 * `modules/shared/helpers/dateRange.helper` already understands `'all'`, `0` and `'0'` with a
 * `parseInt` fallback; a second normaliser in this layer would give the parameter two spellings to
 * drift between, with this one being the copy no test covers.
 *
 * The page calls this TWICE — once with `period_days: 'all'` for the lifetime headline cards, and
 * once with the selected range for the cohort table beneath them — so both windows have to be
 * expressible through the same handler, and neither may be rewritten here.
 *
 * @param req
 * @param res
 * @returns
 */
const _conversionTrialOutcomes = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getTrialOutcomes(identityObj, {
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
        customConsoleError('ERROR: Conversion conversionController _conversionTrialOutcomes', error);
        return apiResponse.errorResponse(res, 'Could not read trial outcomes. Please try again.');
    }
};

/**
 * The monthly trial-cohort trend.
 *
 * ⚠️ `months` IS PASSED THROUGH RAW. The service clamps it to the range this endpoint serves and
 * WARNS about what it clamped — an out-of-range value is a typo, not something worth refusing a
 * whole chart over, and the clamp has to be visible on the payload rather than performed silently
 * in two places.
 *
 * @param req
 * @param res
 * @returns
 */
const _conversionTrialTrend = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getTrialTrend(identityObj, {
            partner_app_id: String(partnerAppId),
            months: q.months
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Conversion conversionController _conversionTrialTrend', error);
        return apiResponse.errorResponse(res, 'Could not read the trial trend. Please try again.');
    }
};

/**
 * Churn measured in customers: the paying base, what has left it, and the recent churns behind it.
 *
 * ⚠️ `months` IS PASSED THROUGH RAW, for the reason above.
 *
 * @param req
 * @param res
 * @returns
 */
const _conversionLogoChurn = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getLogoChurn(identityObj, {
            partner_app_id: String(partnerAppId),
            months: q.months
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Conversion conversionController _conversionLogoChurn', error);
        return apiResponse.errorResponse(res, 'Could not read logo churn. Please try again.');
    }
};

/**
 * Churn measured in money: MRR movement per month, and the merchants behind each figure.
 *
 * ⚠️ `months` IS PASSED THROUGH RAW, for the reason above — the service clamps it and reports the
 * clamp on the payload, and a second normaliser here would give the parameter two spellings to drift
 * between, with this one being the copy no test covers.
 *
 * @param req
 * @param res
 * @returns
 */
const _conversionRevenueChurn = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getRevenueChurn(identityObj, {
            partner_app_id: String(partnerAppId),
            months: q.months
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Conversion conversionController _conversionRevenueChurn', error);
        return apiResponse.errorResponse(res, 'Could not read revenue churn. Please try again.');
    }
};

export = {
    _conversionCustomFunnel,
    _conversionFunnel,
    _conversionCohortRetention,
    _conversionTimeToPaid,
    _conversionPlanMix,
    _conversionTrialOutcomes,
    _conversionTrialTrend,
    _conversionLogoChurn,
    _conversionRevenueChurn
};
