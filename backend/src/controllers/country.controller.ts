'use strict';

/**
 * ============================================================================
 *  REVENUE COUNTRY — where the paying customers are
 * ============================================================================
 *
 *  Serves the Revenue → By country tab's KPI tiles, its two donuts and its country table.
 *
 *  Thin, like every controller here: read the request bag, validate its SHAPE, call the service,
 *  return what it said. Every judgement about the DATA — which filter values are evaluable, whether
 *  an unknown one is an error or a warning, what an empty breakdown means, and above all what
 *  "country" is in this build — belongs to the service, which is also what a test and any future job
 *  runner reach. A second opinion formed here would be a second place for that answer to drift.
 *
 *  ── ⚠️ NO PARAMETER IS NORMALISED HERE ──────────────────────────────────────
 *
 *  `sort`, `dir` and the five facet groups are passed through RAW, exactly as `store.controller.ts`
 *  passes its own. The service validates them FAIL-OPEN — an unrecognised value is dropped, reported
 *  in `warnings[]` and echoed in `diagnostics.unrecognised_filters`, never matched against — because
 *  a typo must WIDEN the breakdown rather than empty it. A table that renders zero rows because of a
 *  bad query string is indistinguishable from a business with no stores.
 *
 *  `countries` and `q` are forwarded even though the service refuses both: it answers with the
 *  SENTENCE explaining why, and a controller that stripped them silently would leave the caller
 *  believing a filter had been applied.
 *
 *  ── WHY AN UNCONFIGURED BIGQUERY IS STILL A 200 ─────────────────────────────
 *
 *  Country here comes from listing analytics, so an unconfigured or never-synced attribution tier
 *  means every store lands in the explicit `Unknown` row. That is a complete, honest answer with a
 *  populated `attribution_state` and a warning that names the missing environment variables — not a
 *  refusal, which the page would render as though the operator had no stores at all.
 * ============================================================================
 */

import type { Request, Response } from 'express';
import apiResponse = require('../utils/apiResponse');
import logger = require('../core/logger');
import storeModule = require('../modules/store');

const { customConsoleError } = logger;
const { getCountryRollup } = storeModule;

/**
 * Reads the request bag ONCE.
 *
 * A cast, never a coercion. Express types a query value as
 * `string | string[] | ParsedQs | ParsedQs[]`, and a helper that narrowed those to
 * `string | undefined` would silently DISCARD an array-valued parameter at run time.
 *
 * @param req - The request.
 * @returns The query bag.
 */
const _query = (req: Request): Record<string, any> => (req.query || {}) as Record<string, any>;

/**
 * Stores, installs, paying customers and revenue per country, for one partner app.
 *
 * ⚠️ WHOLE-POPULATION AND UNPAGINATED, deliberately. The breakdown is a rollup over every store the
 * Partner API knows, so paging it would either page the wrong thing or force the caller to fetch
 * every store in order to draw eight rows. A country list is ~200 rows at most.
 *
 * @param req
 * @param res
 * @returns
 */
const _getCountries = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getCountryRollup(identityObj, {
            partner_app_id: String(partnerAppId),
            sort: q.sort,
            dir: q.dir,
            install_states: q.install_states,
            states: q.states,
            billing: q.billing,
            store_records: q.store_records,
            store_statuses: q.store_statuses,
            // Forwarded so the service can REFUSE them out loud. See the file header.
            countries: q.countries,
            q: q.q
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Store countryController _getCountries', error);
        return apiResponse.errorResponse(res, 'Could not read the country breakdown. Please try again.');
    }
};

export = {
    _getCountries
};
