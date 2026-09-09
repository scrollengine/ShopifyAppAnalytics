'use strict';

/**
 * ============================================================================
 *  PARTNER APP CONTROLLER — which app this install reports on
 * ============================================================================
 *
 *  There is exactly one tenancy concept in this system: `partner_app_id`, the
 *  id of the PartnerApp row. Every analytics endpoint is scoped by it, and it
 *  is the id these two handlers hand out. The dashboard calls the list endpoint
 *  first and threads the id it gets into everything else.
 *
 *  Registration is deliberately NOT free-form. The app to report on comes from
 *  `SHOPIFY_PARTNER_APP_ID` in the environment, because the Partner API cannot
 *  look an app up by name or handle — there would be nothing to discover it
 *  from. The request body may only supply DISPLAY metadata (a nicer name, the
 *  listing URL); it cannot point the install at a different app. That is why
 *  the handler is `…UpsertFromConfig` in spirit and takes no id.
 *
 *  ── THE SAME RULE GOVERNS `PATCH` AND `DELETE` ─────────────────────────────
 *
 *   `PATCH` REFUSES `partner_api_app_id` AND THE WHOLE CALL WITH IT. Editing
 *  which Shopify app a row names would relabel several million stored events
 *  and payouts as another app's history — the rows are keyed by the row's own
 *  `_id`, which no request can change, so nothing moves and everything lies.
 *  The refusal is a 400 rather than a warning on a 200, because a caller that
 *  ignores warnings would read the 200 as "saved".
 *
 *   `DELETE` DEACTIVATES AND REMOVES NOTHING. A cascading delete would
 *  destroy the factual basis of every figure this deployment has published; a
 *  non-cascading one would orphan those rows behind an id that resolves to
 *  nothing, which reads exactly like a business with no customers. The service
 *  header carries the full argument; the payload carries it to the caller.
 *
 *  ── HANDLERS ARE THIN, AND THEY VALIDATE SHAPE ONLY ────────────────────────
 *
 *  Whether a figure may be published, what an empty window means, which fields
 *  a write may touch — none of that is decided here. It lives in the services
 *  and the pure helpers, which is where a test can reach it and where the cron
 *  path and the HTTP path reach the same answer.
 * ============================================================================
 */

import type { Request, Response } from 'express';
import apiResponse = require('../utils/apiResponse');
import logger = require('../core/logger');
import partnerModule = require('../modules/partner');

const { customConsoleError } = logger;
const {
    listPartnerApps,
    registerPartnerAppFromConfig,
    getPartnerAppById,
    updatePartnerApp,
    deactivatePartnerApp,
    getPartnerAppKpi,
    getPartnerAppEvents
} = partnerModule;

/**
 * Maps a FAILED service envelope onto the right HTTP status.
 *
 * ⚠️ IT BRANCHES ON THE ENVELOPE, NOT ON THE MESSAGE TEXT. Services attach a `code` to a refusal
 * the caller can fix, the caught error to a query that threw, and `{}` to "no such row" — so the
 * three are already distinguishable without matching on prose that a later edit would silently
 * break. Getting this wrong is not cosmetic: a 500 over a refused field tells an operator the
 * server is broken when their request was, and a 404 over a thrown query sends them looking for a
 * row that is fine.
 *
 * @param res - Express response.
 * @param serviceResponse - The failed envelope.
 * @returns 400, 404 or 500, carrying the service's own message unchanged.
 */
const _failureResponse = (res: Response, serviceResponse: { msg: string; error?: any }) => {
    const error = serviceResponse.error;
    // A refusal the caller can act on: a field this endpoint will not write, or a body with nothing
    // writable in it. The service's message names the field and says where the value comes from, so
    // it is surfaced UNCHANGED — rewriting it into something friendlier strips the instruction.
    if (error && typeof error === 'object' && typeof error.code === 'string') {
        return apiResponse.validationErrorResponse(res, serviceResponse.msg, error);
    }
    // A caught error. Attached deliberately — this is a single-operator, self-hosted backend.
    if (error && typeof error === 'object' && Object.keys(error).length > 0) {
        return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, error);
    }
    return apiResponse.notFoundResponse(res, serviceResponse.msg);
};

/**
 * Lists the registered partner apps, with each app's coverage measurements attached.
 *
 * A self-hosted install normally has exactly one. More than one means the environment's
 * `SHOPIFY_PARTNER_APP_ID` changed at some point without the old row being removed, and the service
 * logs a warning when that happens — the list is what lets an operator see it.
 *
 * @param req - Express request. Optional query: `is_active=true|false`.
 * @param res - Express response.
 * @returns 200 with `{ items, total }`.
 */
const _partnerAppList = async (req: Request, res: Response) => {
    try {
        const q = (req.query || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        // Tri-state on purpose: absent means "all apps", not "active apps". Only the two literal
        // strings map to a filter, so a typo widens the result rather than silently narrowing it.
        let isActive: boolean | undefined;
        if (q.is_active === 'true') {
            isActive = true;
        }
        if (q.is_active === 'false') {
            isActive = false;
        }

        const serviceResponse = await listPartnerApps(identityObj, { is_active: isActive });
        if (!serviceResponse.status) {
            return apiResponse.errorResponseWithErrorObject(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: PartnerApp partnerAppController _partnerAppList', error);
        return apiResponse.errorResponse(res, 'Could not list the partner apps. Please try again.');
    }
};

/**
 * Registers the configured partner app, or returns the already-registered row unchanged.
 *
 * Idempotent by design — the app entry point calls the same service at boot, so hitting this
 * endpoint on a healthy install is a no-op that returns the existing app with `created:false`.
 * The body is optional and carries display metadata only; it is ignored once a row exists.
 *
 * @param req - Express request. Optional body: `{ app_handle, display_name, listing_url }`.
 * @param res - Express response.
 * @returns 200 with `{ app, created }`, or a 400 envelope when
 * `SHOPIFY_PARTNER_APP_ID` is unset or malformed — the message names the variable and where to find
 * its value.
 */
const _partnerAppUpsert = async (req: Request, res: Response) => {
    try {
        const b = (req.body || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        let appHandle: string | undefined;
        if (typeof b.app_handle === 'string' && b.app_handle.trim()) {
            appHandle = b.app_handle.trim();
        }
        let displayName: string | undefined;
        if (typeof b.display_name === 'string' && b.display_name.trim()) {
            displayName = b.display_name.trim();
        }
        let listingUrl: string | undefined;
        if (typeof b.listing_url === 'string' && b.listing_url.trim()) {
            listingUrl = b.listing_url.trim();
        }

        const serviceResponse = await registerPartnerAppFromConfig(identityObj, {
            app_handle: appHandle,
            display_name: displayName,
            listing_url: listingUrl
        });

        // A failure here is a configuration problem the caller can fix (the app id is unset or not
        // a number), not a server fault — so it is a 400 and the service's message is the whole
        // instruction. Do not replace it with a generic string; it names the env var and the URL to
        // read the value from.
        if (!serviceResponse.status) {
            return apiResponse.validationErrorResponse(res, serviceResponse.msg, serviceResponse.error);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: PartnerApp partnerAppController _partnerAppUpsert', error);
        return apiResponse.errorResponse(res, 'Could not register the partner app. Please try again.');
    }
};

/**
 * Reads one partner app by id, with its sync watermarks and coverage gates.
 *
 * ⚠️ 404 rather than a 200 with `app: null`. A RECORD has no honest empty rendering — the caller
 * asked for a specific row, and answering "here is nothing" over an id that does not exist is how a
 * mistyped id becomes a screen that looks like a healthy app with no data.
 *
 * @param req - Express request. `:partner_app_id` in the path.
 * @param res - Express response.
 * @returns 200 with `{ app }`, 400 without an id, or 404.
 */
const _partnerAppGet = async (req: Request, res: Response) => {
    try {
        const p = (req.params || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = p.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required in the path: GET /api/partner-apps/:app_id.');
        }

        const serviceResponse = await getPartnerAppById(identityObj, { partner_app_id: String(partnerAppId) });
        if (!serviceResponse.status) {
            return _failureResponse(res, serviceResponse);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: PartnerApp partnerAppController _partnerAppGet', error);
        return apiResponse.errorResponse(res, 'Could not read the partner app. Please try again.');
    }
};

/**
 * Updates one app's DISPLAY metadata.
 *
 *  THE BODY IS HANDED THROUGH RAW. This handler does not pick fields out of it, and that is
 * deliberate: the only thing that decides what may be written is
 * `modules/partner/helpers/partnerAppPatch.helper`, so there is exactly one list of writable fields
 * in the codebase. A controller that pre-selected keys would be a second, silently diverging list —
 * and the field it forgot to forward would look to the caller exactly like a field the endpoint
 * refused.
 *
 * A refusal comes back as `status: false` with an error `code`, which `_failureResponse` turns into
 * a 400 carrying the service's own explanation.
 *
 * @param req - Express request. `:partner_app_id` in the path, the patch in the body.
 * @param res - Express response.
 * @returns 200 with `{ app, updated_fields, changed, warnings }`, 400 on a refusal, or 404.
 */
const _partnerAppUpdate = async (req: Request, res: Response) => {
    try {
        const p = (req.params || {}) as Record<string, any>;
        const b = (req.body || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = p.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required in the path: PATCH /api/partner-apps/:app_id.');
        }

        const serviceResponse = await updatePartnerApp(identityObj, {
            partner_app_id: String(partnerAppId),
            patch: b
        });
        if (!serviceResponse.status) {
            return _failureResponse(res, serviceResponse);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: PartnerApp partnerAppController _partnerAppUpdate', error);
        return apiResponse.errorResponse(res, 'Could not update the partner app. Please try again.');
    }
};

/**
 * Deactivates one app. REMOVES NOTHING.
 *
 *  `DELETE` IS THE VERB THE FRONTEND STUB ALREADY DOCUMENTS, so it is the verb served — but the
 * response says plainly that nothing was deleted, how many rows still reference the app, and how to
 * reverse it. A verb whose meaning is narrower than its name has to say so on every response, not
 * only in a header nobody reading the JSON will open.
 *
 * Idempotent: an already-inactive app answers 200 with `changed: false`.
 *
 * @param req - Express request. `:partner_app_id` in the path.
 * @param res - Express response.
 * @returns 200 with the deactivation payload, 400 without an id, or 404.
 */
const _partnerAppDeactivate = async (req: Request, res: Response) => {
    try {
        const p = (req.params || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = p.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required in the path: DELETE /api/partner-apps/:app_id.');
        }

        const serviceResponse = await deactivatePartnerApp(identityObj, { partner_app_id: String(partnerAppId) });
        if (!serviceResponse.status) {
            return _failureResponse(res, serviceResponse);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: PartnerApp partnerAppController _partnerAppDeactivate', error);
        return apiResponse.errorResponse(res, 'Could not deactivate the partner app. Please try again.');
    }
};

/**
 * The KPI tiles and install chart for one app.
 *
 * ⚠️ AN EMPTY ANSWER IS A 200. An app that has never been synced comes back with `data_state:
 * 'NEVER_SYNCED'`, every figure `null` and a reason — not a 404 and not an error. The page has a
 * rendering for that and no rendering at all for a failure envelope over a healthy install.
 *
 * The query bag is cast ONCE and its values are handed through raw. The window resolver and the
 * coverage gates do the interpreting, so the HTTP path and any other caller reach the same answer.
 *
 * @param req - Express request. `:partner_app_id` in the path; optional `period_days`, `since`, `until` in the query.
 * @param res - Express response.
 * @returns 200 with the KPI payload, 400 without an id, or 404.
 */
const _partnerAppKpi = async (req: Request, res: Response) => {
    try {
        const p = (req.params || {}) as Record<string, any>;
        const q = (req.query || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = p.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required in the path: GET /api/partner-apps/:app_id/kpi.');
        }

        const serviceResponse = await getPartnerAppKpi(identityObj, {
            partner_app_id: String(partnerAppId),
            period_days: q.period_days,
            since: q.since,
            until: q.until
        });
        if (!serviceResponse.status) {
            return _failureResponse(res, serviceResponse);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: PartnerApp partnerAppController _partnerAppKpi', error);
        return apiResponse.errorResponse(res, 'Could not read the partner app KPIs. Please try again.');
    }
};

/**
 * One page of an app's raw Partner events, plus the install trend over the same window.
 *
 * ⚠️ AN EMPTY PAGE IS A 200 with `items: []`. A list has an honest empty rendering; an app that has
 * never been synced is the separate `NEVER_SYNCED` branch, with `items: null` and a reason.
 *
 * ⚠️ `pagination` TRAVELS INSIDE `data`, not in the envelope's own `pagination` slot. The trend and
 * the coverage block belong to the same answer and would be orphaned from their page counters if
 * the two were split across the envelope — and the frontend service reads one object.
 *
 * @param req - Express request. `:partner_app_id` in the path; optional `page`, `limit`, `type`, `period_days`, `since`, `until` in the query.
 * @param res - Express response.
 * @returns 200 with the events payload, 400 without an id, or 404.
 */
const _partnerAppEvents = async (req: Request, res: Response) => {
    try {
        const p = (req.params || {}) as Record<string, any>;
        const q = (req.query || {}) as Record<string, any>;
        const identityObj = { user_id: req.user_id as string };

        const partnerAppId = p.partner_app_id;
        if (!partnerAppId) {
            return apiResponse.validationErrorResponse(res, 'partner_app_id is required in the path: GET /api/partner-apps/:app_id/events.');
        }

        const serviceResponse = await getPartnerAppEvents(identityObj, {
            partner_app_id: String(partnerAppId),
            period_days: q.period_days,
            since: q.since,
            until: q.until,
            page: q.page,
            limit: q.limit,
            type: q.type
        });
        if (!serviceResponse.status) {
            return _failureResponse(res, serviceResponse);
        }

        return apiResponse.successResponseWithData(res, serviceResponse.msg, serviceResponse.data);
    } catch (error) {
        customConsoleError('ERROR: PartnerApp partnerAppController _partnerAppEvents', error);
        return apiResponse.errorResponse(res, 'Could not read the partner app events. Please try again.');
    }
};

export = {
    _partnerAppList,
    _partnerAppUpsert,
    _partnerAppGet,
    _partnerAppUpdate,
    _partnerAppDeactivate,
    _partnerAppKpi,
    _partnerAppEvents
};
