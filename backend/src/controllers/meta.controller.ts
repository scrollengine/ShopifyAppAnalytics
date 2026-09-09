'use strict';

/**
 * ============================================================================
 *  META CONTROLLER — how much of this can you actually believe?
 * ============================================================================
 *
 *  Every other endpoint answers "what are my numbers". This one answers "how
 *  far back do they reach, and what is missing from them" — the coverage
 *  measurements a sync records about its own completeness:
 *
 *    earliest_event_at             the floor of the event history
 *    earliest_transaction_at       the floor of the payout ledger, and so the
 *                                  floor of every money figure in the system
 *    lifetime_sync_completed_at    null ⇒ every "all time" total is a FLOOR,
 *                                  not a total
 *    event_history_gap_days        the widest hole in the event history
 *    charge_link_absent_pct        rows that carry no charge id at all
 *    charge_link_unresolved_pct    charge ids that resolve to nothing
 *
 *  Each arrives in a confidence envelope, and "never measured" is reported as
 *  `value: null` with the reason attached — never as `0`, which would read as
 *  "measured, and the answer is none".
 *
 *  ── Why this calls the revenue service ──────────────────────────────────────
 *  The enveloped coverage block is built inside `getRevenueNow`, because
 *  coverage is what qualifies the revenue figures and the two must be computed
 *  from the same read of the app row — a coverage block fetched separately
 *  could describe a different sync than the numbers it is meant to qualify.
 *  So this endpoint shares that service and TRIMS the response to the coverage
 *  half at the response boundary, which is the house pattern for a shared
 *  service feeding endpoints with different payload needs.
 *
 *   Do the trimming HERE, never in the service — `/api/revenue/now` needs the
 *  fields this handler drops.
 *
 *  The cost of the shared call is one extra aggregation pass the coverage
 *  fields do not need. That is the deliberate trade: one snapshot, internally
 *  consistent, over two cheaper reads that can disagree.
 * ============================================================================
 */

import type { Request, Response } from 'express';
import apiResponse = require('../utils/apiResponse');
import logger = require('../core/logger');
import revenueModule = require('../modules/revenue');

const { customConsoleError } = logger;
const { getRevenueNow } = revenueModule;

/**
 * Returns the coverage measurements for one app — the honesty envelope behind every other figure.
 *
 * @param req - Express request. Query: `partner_app_id` (required).
 * @param res - Express response.
 * @returns 200 with `{ partner_app_id, app_handle, display_name, as_of,
 * reporting_currency, active_sub_window_days, coverage }`, or 400 when `partner_app_id` is missing.
 */
const _metaCoverage = async (req: Request, res: Response) => {
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

        const snapshot = serviceResponse.data;

        // Pick, rather than delete — the fields kept here are the ones that describe the DATA, and
        // an explicit list cannot silently start leaking a new revenue field added upstream.
        //
        // `active_sub_window_days` is coverage, not a revenue detail: it is the assumption that
        // decides whether a shop counts as still paying, and reading active_subs without knowing it
        // is reading a number whose definition is hidden.
        const coverageResponse = {
            partner_app_id: snapshot.partner_app_id,
            app_handle: snapshot.app_handle,
            display_name: snapshot.display_name,
            as_of: snapshot.as_of,
            reporting_currency: snapshot.reporting_currency,
            active_sub_window_days: snapshot.active_sub_window_days,
            coverage: snapshot.coverage
        };

        return apiResponse.successResponseWithData(res, 'Coverage measurements fetched.', coverageResponse);
    } catch (error) {
        customConsoleError('ERROR: Meta metaController _metaCoverage', error);
        return apiResponse.errorResponse(res, 'Could not read the coverage measurements. Please try again.');
    }
};

export = {
    _metaCoverage
};
