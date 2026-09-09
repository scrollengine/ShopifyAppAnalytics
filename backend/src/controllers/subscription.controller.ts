'use strict';

/**
 * ============================================================================
 *  SUBSCRIPTION READS
 * ============================================================================
 *
 *  Serves the Subscriptions page's list of merchants who are on a paid plan RIGHT NOW.
 *
 *  Thin, like every controller here: read the request bag, validate its SHAPE, call the service,
 *  return what it said. Every judgement about the DATA — who counts as paying, whether an unknown
 *  facet value is an error or a warning, what an empty answer means — belongs to the service, which
 *  is also what a test and any future job runner reach. A second opinion formed here would be a
 *  second place for that answer to drift.
 *
 *  ──  THERE IS NO `/api/subscriptions/detail` HERE, AND THAT IS DELIBERATE ────────────────
 *
 *  `frontend/API_Services/growth-intel/subscriptionService.js` has a `getDetail`, and it points at
 *  `GET /api/stores/detail` — the full argument is in `modules/store/services/storeDetail.service`'s
 *  header. In one line: the drawer's commonest subject is a store that NEVER SUBSCRIBED (the install
 *  cohort is mostly such stores), and this list's population is "currently paying", so serving a
 *  store record from a `/subscriptions/` path would name the answer after a population it does not
 *  have. Adding one here would be the mistake that service's header exists to prevent.
 *
 *  ── ⚠️ NO NORMALISATION HERE ───────────────────────────────────────────────────────────────
 *
 *  Every parameter is passed through RAW, exactly as `store.controller.ts` and
 *  `conversion.controller.ts` do. The facet groups are legitimately array-valued when a client sends
 *  `?states=a&states=b` rather than the page's comma-joined form, and coercing them to a string here
 *  would silently discard one.
 *
 *  ── WHY AN EMPTY ANSWER IS A 200 ────────────────────────────────────────────────────────────
 *
 *  The rule lives in the service and is only summarised here. A LIST has an honest empty rendering —
 *  zero rows under a banner — so this answers 200 with `items: []`, `population`, `data_state` and
 *  `warnings[]` whatever happened. Refusing instead would render on the page as though the operator
 *  had no paying customers, which is a claim about their business that no data made, and it is the
 *  single most alarming thing this dashboard could say by accident.
 * ============================================================================
 */

import type { Request, Response } from 'express';
import apiResponse = require('../utils/apiResponse');
import logger = require('../core/logger');
import storeModule = require('../modules/store');

const { customConsoleError } = logger;
const { getSubscriptionList } = storeModule;

/**
 * Reads the request bag ONCE per handler.
 *
 * A cast, never a coercion. Express types a query value as
 * `string | string[] | ParsedQs | ParsedQs[]`, and a helper that narrowed those to
 * `string | undefined` would silently DISCARD an array-valued parameter at run time — which matters
 * here because every facet group is legitimately array-valued when a client sends
 * `?states=a&states=b` rather than the page's comma-joined form.
 *
 * @param req - The request.
 * @returns The query bag.
 */
const _query = (req: Request): Record<string, any> => (req.query || {}) as Record<string, any>;

/**
 * Every merchant currently on a paid plan, with their plan, status and spend.
 *
 * ⚠️ `refresh` IS ACCEPTED AND DELIBERATELY NOT FORWARDED. The page's Refresh button sends it and
 * there is no cache to invalidate: the list is folded from the collections on every request, so
 * every response is already as fresh as the last sync. It is named here rather than left unmentioned
 * so that nobody wires a cache to it later and quietly makes this page stale — the service's own
 * params document it for the same reason.
 *
 * @param req
 * @param res
 * @returns
 */
const _getSubscriptions = async (req: Request, res: Response) => {
    try {
        const q = _query(req);
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = q.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required. Read it from GET /api/partner-apps.');
        }

        const serviceResponse = await getSubscriptionList(identityObj, {
            partner_app_id: String(partnerAppId),
            page: q.page,
            limit: q.limit,
            q: q.q,
            sort: q.sort,
            // ⚠️ `dir`, NOT `sort_dir` — the Subscriptions page sends this spelling, the same one the
            // Stores page uses and a different one from the install cohort's. Reading the other name
            // here would silently ignore the sort-direction toggle rather than erroring.
            dir: q.dir,
            // ⚠️ `states` CARRIES THE SUBSCRIPTION VOCABULARY on this endpoint — `PAYING`,
            // `ON_TRIAL`, `CHURNED_DURING_TRIAL`, `CHURNED_AFTER_TRIAL` — because the page's status
            // tabs are a shortcut into this group and send their own ids. The Stores page sends the
            // five LIFECYCLE states under the same parameter name. One name, two vocabularies, two
            // endpoints; the service validates against its own.
            states: q.states,
            install_states: q.install_states,
            billing: q.billing,
            store_statuses: q.store_statuses
        });

        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: Subscription subscriptionController _getSubscriptions', error);
        return apiResponse.errorResponse(res, 'Could not read the subscription list. Please try again.');
    }
};

export = {
    _getSubscriptions
};
