'use strict';

/**
 * ============================================================================
 *  STORE READS
 * ============================================================================
 *
 *  Serves the Stores page's roster and the store detail slide-over that opens from seven different
 *  tables.
 *
 *  Thin, like every controller here: read the request bag, validate its SHAPE, call the service,
 *  return what it said. Every judgement about the DATA — whether an unknown facet value is an error
 *  or a warning, what an empty answer means, whether a missing store is a refusal or a 200 — belongs
 *  to the service, which is also what a test and any future job runner reach. A second opinion formed
 *  here would be a second place for that answer to drift.
 *
 *  ── ⚠️ NO NORMALISATION HERE, AND `shop_domain` IS THE ONE THAT TEMPTS ─────────────────────
 *
 *  Every parameter is passed through RAW, exactly as `conversion.controller.ts` does with `q.events`.
 *  `shop_domain` in particular arrives from `storePresentation.storeDetailRequestParams`, which
 *  normalises on the client — and a SECOND normaliser here would give the join key two
 *  implementations in this codebase, which is precisely what `shared/helpers/shopDomain.helper`
 *  exists to prevent. The service normalises the needle once, through that helper.
 *
 *  ── WHY THE ROSTER'S EMPTY ANSWER IS A 200 AND THE DETAIL'S "NOT FOUND" IS NOT ─────────────
 *
 *  Both rules live in the services and are only summarised here, because the difference is a
 *  judgement about rendering rather than about HTTP. A LIST has an honest empty rendering — zero rows
 *  under a banner — so `GET /api/stores` answers 200 with `items: []`, `data_state` and `warnings[]`
 *  whatever happened. A RECORD does not: `StoreDetailDrawer` draws either the full panel or one
 *  critical banner, so a store the Partner API has no record of is a refusal carrying the sentence
 *  that banner prints. A 200 there would paint a finished-looking panel of fabricated em dashes.
 * ============================================================================
 */

import type { Request, Response } from 'express';
import apiResponse = require('../utils/apiResponse');
import logger = require('../core/logger');
import storeModule = require('../modules/store');

const { customConsoleError } = logger;
const { getStoreRoster, getStoreDetail } = storeModule;

/**
 * Reads the request bag ONCE per handler.
 *
 * A cast, never a coercion. Express types a query value as
 * `string | string[] | ParsedQs | ParsedQs[]`, and a helper that narrowed those to
 * `string | undefined` would silently DISCARD an array-valued parameter at run time — which matters
 * here because every facet group is legitimately array-valued when a client sends
 * `?install_states=a&install_states=b` rather than the page's comma-joined form.
 *
 * @param req - The request.
 * @returns The query bag.
 */
const _query = (req: Request): Record<string, any> => (req.query || {}) as Record<string, any>;

/**
 * Every store this app has ever been installed on, with its current install state.
 *
 * ⚠️ `refresh` IS ACCEPTED AND DELIBERATELY NOT FORWARDED. The page's Refresh button sends it and
 * there is no cache to invalidate: the roster is folded from the collections on every request, so
 * every response is already as fresh as the last sync. It is named here rather than left unmentioned
 * so that nobody wires a cache to it later and quietly makes this page stale — the service's own
 * params document it for the same reason.
 *
 * ⚠️ `countries` IS forwarded, because the SERVICE has to warn about it. The Revenue → By country tab links
 * here with an ISO-2 code and the only per-store country this build holds is a GA4 common NAME, so
 * the filter cannot be honoured — dropping it silently in the controller would leave the operator
 * looking at an unfiltered table with no explanation.
 *
 * @param req
 * @param res
 * @returns
 */
const _getStores = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getStoreRoster(identityObj, {
            partner_app_id: String(partnerAppId),
            page: q.page,
            limit: q.limit,
            q: q.q,
            sort: q.sort,
            // ⚠️ `dir`, NOT `sort_dir` — `pages/stores/index.js:203` sends this spelling,
            // which differs from the install cohort's. Reading the other name here would silently
            // ignore the sort-direction toggle rather than erroring.
            dir: q.dir,
            install_states: q.install_states,
            states: q.states,
            billing: q.billing,
            store_records: q.store_records,
            store_statuses: q.store_statuses,
            shopify_plans: q.shopify_plans,
            countries: q.countries
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Store storeController _getStores', error);
        return apiResponse.errorResponse(res, 'Could not read the store list. Please try again.');
    }
};

/**
 * Everything known about ONE store.
 *
 * ⚠️ `tenant_id` IS FORWARDED RATHER THAN IGNORED. The client sends exactly ONE identity key — a
 * tenant id for a 24-hex string, a domain for anything else — so a request carrying a tenant id
 * carries no domain, and dropping it here would reach the service as "no store named at all". The
 * service refuses it with a sentence saying this build has no tenant records and naming the
 * parameter that works, which is the only answer that tells the caller what to do next.
 *
 *  A missing store is `errorResponseWithErrorObject`, i.e. a 500 carrying the service's sentence,
 * for the reason the file header gives — and NOT `notFoundResponse`. `StoreDetailDrawer` branches on
 * the envelope's `status` and prints `msg`; it never reads the HTTP code, and a 404 would additionally
 * be wrong about the RESOURCE: `/api/stores/detail` exists and answered. Should a client ever need to
 * distinguish "no such store" from "the query failed", that belongs in a discriminator ON the
 * envelope rather than in a status code two layers of client code do not look at.
 *
 * @param req
 * @param res
 * @returns
 */
const _getStoreDetail = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getStoreDetail(identityObj, {
            partner_app_id: String(partnerAppId),
            shop_domain: q.shop_domain,
            tenant_id: q.tenant_id
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Store storeController _getStoreDetail', error);
        return apiResponse.errorResponse(res, 'Could not read this store. Please try again.');
    }
};

export = {
    _getStores,
    _getStoreDetail
};
