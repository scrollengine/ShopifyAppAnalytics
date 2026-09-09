'use strict';

/**
 * ============================================================================
 *  REVENUE CONTROLLER
 * ============================================================================
 *
 *  One endpoint, one service call. Every figure it returns arrives already
 *  wrapped in a confidence envelope — `{ value, confidence, source, reason? }`
 *  — and this controller passes them through UNTOUCHED.
 *
 *   Do not unwrap, default, or flatten an envelope here. A `value: null`
 *  carrying `reason: "no settled payouts have been synced for this app yet"` is
 *  the correct answer to "what is my MRR"; rewriting it to `0` on the way out
 *  turns a statement about the DATA into a false statement about the BUSINESS.
 *  That is the one promise this project makes in its README, and the response
 *  boundary is where it would be easiest to break by accident.
 *
 *  ──  TWO RENDERING CONTRACTS, AND NEITHER HANDLER MAY BORROW THE OTHER'S ──
 *
 *  `/now` publishes ENVELOPES; `/overview` and `/shop-plans` publish BARE
 *  numbers with `null` for unknown. That is not an inconsistency to be tidied
 *  away — it is two consumers with two renderers. `/api/meta/coverage` is a trim
 *  of `/now`'s coverage block, and the Revenue page formats every figure with
 *  `Number(n)`, which turns an envelope into `NaN` and prints an em dash.
 *  Wrapping the windowed payload "for consistency" would blank the entire page;
 *  unwrapping `/now`'s would delete the reason a figure is missing. Each
 *  service decides its own, and its header carries the argument.
 *
 *  Every handler below is SHAPE VALIDATION ONLY: presence of the ids, one cast
 *  for the query bag or the body, and nothing else. A range, a domain list or a
 *  month count is validated FAIL-OPEN inside the service, which is where the
 *  warning explaining what it clamped can travel back with the data.
 * ============================================================================
 */

import type { Request, Response } from 'express';
import apiResponse = require('../utils/apiResponse');
import logger = require('../core/logger');
import revenueModule = require('../modules/revenue');

const { customConsoleError } = logger;
const { getRevenueNow, getRevenueOverview, getShopPlans } = revenueModule;

/**
 * Returns the point-in-time revenue snapshot for one app: MRR, active subscriptions, ARPU, lifetime
 * cash totals, the top shops by lifetime net, and the coverage block that says how much of that is
 * trustworthy.
 *
 * `as_of` is stamped by the service at computation time, not by the client — a caller cannot ask
 * for a snapshot "as of" some other moment, because nothing here reconstructs history.
 *
 * @param req - Express request. Query: `partner_app_id` (required).
 * @param res - Express response.
 * @returns 200 with the snapshot, or 400 when `partner_app_id` is missing.
 */
const _revenueNowSummary = async (req: Request, res: Response) => {
    try {
        const q = (req.query || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getRevenueNow(identityObj, { partner_app_id: String(partnerAppId) });
        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Revenue revenueController _revenueNowSummary', error);
        return apiResponse.errorResponse(res, 'Could not compute the revenue snapshot. Please try again.');
    }
};

/**
 * Returns the WINDOWED revenue view for one app: the run-rate at the window's close, the MRR movement
 * that got it there with the stores behind every figure, the MRR-and-cash trend, the per-plan
 * breakdown and the lifetime shop ranking.
 *
 *  EVERY FIGURE ON THIS RESPONSE IS A BARE NUMBER, `null` WHEN UNKNOWN. Do not wrap them in
 * confidence envelopes to match `/now`: the consumer coerces with `Number(n)`, so an envelope renders
 * as an em dash and the whole page goes blank. Do not coalesce a `null` to `0` either — that is the
 * same lie in the other direction. The honesty contract travels in `measurable`, `unknown_reason`,
 * `before_coverage`, `coverage`, `data_state`, `notes[]`, `warnings[]` and `diagnostics`.
 *
 * The window is `period_days` OR `since` + `until`; anything unparseable falls back to the default
 * inside the service rather than being refused here — a typo in a query string must not cost a reader
 * a whole page of data.
 *
 * @param req - Express request. Query: `partner_app_id` (required), `period_days` |
 * `since` + `until`. `months` is accepted and ignored — the trend length comes from the window.
 * @param res - Express response.
 * @returns 200 with the view, or 400 when `partner_app_id` is missing.
 */
const _revenueWindowedOverview = async (req: Request, res: Response) => {
    try {
        //  ONE cast for the whole query bag, and no per-field coercion. Express types every query
        // value as `string | string[] | ParsedQs`, and casting each field at its use site is how one
        // of them quietly becomes `any` and takes its downstream reads with it.
        const q = (req.query || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getRevenueOverview(identityObj, {
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
        customConsoleError('ERROR: Revenue revenueController _revenueWindowedOverview', error);
        return apiResponse.errorResponse(res, 'Could not compute the revenue overview. Please try again.');
    }
};

/**
 * Returns the current plan for a batch of myshopify domains.
 *
 * POST rather than GET because the caller sends up to two hundred domains at once, and a query string
 * that long is at the mercy of every proxy between the browser and this process. It reads nothing and
 * writes nothing — the verb is about the payload, not about a mutation.
 *
 * ⚠️ A domain with no answer comes back PRESENT with `resolved: false` and a reason, never omitted.
 * The controller must not filter those out to "tidy" the map: an omitted key is indistinguishable
 * from a domain nobody asked about, and the caller cannot tell the two apart.
 *
 * @param req - Express request. Body: `partner_app_id` (required), `shop_domains` — an
 * array of domains or one comma-joined string.
 * @param res - Express response.
 * @returns 200 with the plans, or 400 when `partner_app_id` is missing.
 */
const _revenueShopPlans = async (req: Request, res: Response) => {
    try {
        const body = (req.body || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = body.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getShopPlans(identityObj, {
            partner_app_id: String(partnerAppId),
            // Passed through UNTOUCHED. The service accepts an array or a comma-joined string and
            // drops unusable entries one by one; normalising or splitting here would put half of that
            // decision in a layer that has nowhere to report what it dropped.
            shop_domains: body.shop_domains
        });
        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Revenue revenueController _revenueShopPlans', error);
        return apiResponse.errorResponse(res, 'Could not look up shop plans. Please try again.');
    }
};

export = {
    _revenueNowSummary,
    _revenueWindowedOverview,
    _revenueShopPlans
};
