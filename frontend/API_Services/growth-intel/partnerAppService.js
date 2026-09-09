import AxiosClientProvider from '../apiClient';
import GrowthIntelSyncApiService from './syncService';

/**
 * =============================================================================
 *  Partner apps — the app the whole dashboard is scoped to.
 * =============================================================================
 *
 *  Every figure in this system is scoped by one partner app. `growthIntelContext`
 *  calls `list()` once and holds the selection for the entire session.
 *
 *  ── ENDPOINTS THAT EXIST TODAY ──────────────────────────────────────────────
 *      GET    /api/partner-apps               list  (query: is_active=true|false)
 *      POST   /api/partner-apps               register the app named by the
 *                                             backend's SHOPIFY_PARTNER_APP_ID; idempotent
 *      GET    /api/partner-apps/:id           getById
 *      PATCH  /api/partner-apps/:id           update       (display metadata only)
 *      DELETE /api/partner-apps/:id           softDelete   (DEACTIVATES; deletes nothing)
 *      GET    /api/partner-apps/:id/kpi       getKpi
 *      GET    /api/partner-apps/:id/events    getEvents
 *      POST   /api/sync/partner               triggerSync (delegated to syncService)
 *
 *  Every method in this file reaches a real route. None of them answers the
 *  not-implemented envelope any more.
 *
 *  ──  THERE IS STILL NO CREATE-BY-ID, AND THAT IS NOT A GAP ─────────────────
 *  The source dashboard's `create` posted an `app_id` and the API registered THAT
 *  app. This backend cannot: the Partner API has no way to look an app up by name
 *  or handle, so the id has to come from configuration or from nowhere. `create`
 *  is therefore an alias for `registerFromConfig`, and it CHECKS the app it got
 *  back against any `app_id` the caller submitted — because a form that posts one
 *  id, receives another, and reports "created" is the failure this project exists
 *  to prevent.
 *
 *  `update` is the same rule from the other side: `PATCH` REFUSES
 *  `partner_api_app_id`, every sync watermark and every coverage gate, and it
 *  refuses the WHOLE call rather than dropping the field — a patch that silently
 *  ignored half of what it was sent would report success over an unchanged row.
 *
 *  ──  `DELETE` DEACTIVATES. IT REMOVES NOTHING. ─────────────────────────────
 *  `softDelete` sets `is_active: false` and leaves every event and payout row in
 *  place; the response says so, counts the retained rows, and names the exact
 *  PATCH that reverses it. The verb is narrower than its name, so it has to say
 *  so on every response rather than only in a header nobody reading JSON opens.
 * =============================================================================
 */

/**
 * Shared sync client. `triggerSync` here and `syncService.triggerSync` must behave identically —
 * delegating rather than re-implementing the POST is what guarantees they cannot drift.
 */
const SYNC_API = new GrowthIntelSyncApiService();

/**
 * Returned when the API refuses the call. By the time a caller sees this the axios
 * interceptor has already cleared the token and started the redirect to /login —
 * this value exists so a page that renders before the navigation completes shows
 * its empty state rather than throwing. It has no `status` key, so every ported
 * `if (!resp.status)` guard treats it as a failed call, which is correct.
 */
const resourceNotAllowed = { resource_access: 'NOT_ALLOWED' };

/**
 * True when an axios error carries the API's own response envelope rather than a transport failure.
 *
 * The discriminator that keeps the server's refusal sentence alive. Every `status: false` service
 * result is mapped onto an HTTP 500 by this backend, and this area answers 400 for a refused patch
 * and 404 for an unknown id with envelopes of their own — so a client that only forwarded 2xx bodies
 * would turn "partner_api_app_id is the app's identity and cannot be edited" into `{}`, which
 * renders as a blank "save failed" with nothing the operator can act on.
 *
 * @param {Object} err - The axios error.
 * @returns {Boolean} True when `err.response.data` is a `{ status, msg, … }` envelope.
 */
const _hasEnvelope = (err) => {
    if (!err || !err.response || !err.response.data) {
        return false;
    }
    const body = err.response.data;
    if (typeof body !== 'object') {
        return false;
    }
    return Object.prototype.hasOwnProperty.call(body, 'status');
};

/**
 * GETs one partner-app read and hands the envelope back, untouched.
 *
 * @param {Object} apiClient - The axios instance.
 * @param {String} path - Endpoint path, relative to `/api/`.
 * @param {Object} params - Query parameters.
 * @param {String} label - Method name, for the console line.
 * @param {Function} cb - Receives the response envelope.
 * @returns {void}
 */
const _get = (apiClient, path, params, label, cb) => {
    apiClient
        .get(path, { params: params || {} })
        .then((response) => { cb(response && response.data ? response.data : {}); })
        .catch((err) => {
            if (err.response && err.response.status === 401) { cb(resourceNotAllowed); return; }
            if (_hasEnvelope(err)) { cb(err.response.data); return; }
            console.log(`GrowthIntel partnerApp.${label} error`, err);
            cb({});
        });
};

/**
 * Issues one WRITE (post / patch / delete) and hands the envelope back, untouched.
 *
 * Written once for all three verbs because they owe a caller exactly the same treatment: the
 * server's own sentence on a refusal, `resourceNotAllowed` on a dead session, `{}` only when nothing
 * answered at all. Three copies of that is how one of them ends up flattening a 400 to `{}` — and on
 * this area the 400 body IS the answer, because it names the field that was refused.
 *
 * ⚠️ `axios.delete` takes a CONFIG object, not a body, which is why the verb is dispatched here
 * rather than by handing `apiClient[method]` the same arguments for all three. Deleting nothing is
 * exactly what this endpoint does, so it has no body to send.
 *
 * @param {Object} apiClient - The axios instance.
 * @param {String} method - 'post' | 'patch' | 'delete'.
 * @param {String} path - Endpoint path, relative to `/api/`.
 * @param {Object} body - Sent as JSON. Ignored for delete.
 * @param {String} label - Method name, for the console line.
 * @param {Function} cb - Receives the response envelope.
 * @returns {void}
 */
const _send = (apiClient, method, path, body, label, cb) => {
    let request = null;
    if (method === 'delete') {
        request = apiClient.delete(path);
    } else {
        request = apiClient[method](path, body || {});
    }
    request
        .then((response) => { cb(response && response.data ? response.data : {}); })
        .catch((err) => {
            if (err.response && err.response.status === 401) { cb(resourceNotAllowed); return; }
            if (_hasEnvelope(err)) { cb(err.response.data); return; }
            console.log(`GrowthIntel partnerApp.${label} error`, err);
            cb({});
        });
};

/**
 * URL-safe path segment for an app id.
 *
 * ⚠️ A malformed id reaches the server as a path segment either way; encoding is about not breaking
 * the URL, not about validation. The API answers a bad id with its own envelope, which `_get` and
 * `_send` forward.
 *
 * @param {String} partner_app_id - The app id.
 * @returns {String} The encoded segment.
 */
const _appPath = (partner_app_id) => `partner-apps/${encodeURIComponent(partner_app_id)}`;

class GrowthIntelPartnerAppApiService {
    constructor() {
        this.apiClient = new AxiosClientProvider().getClient();
    }

    /**
     * Lists the registered partner apps.
     *
     * @param {Object} params - Optional query. Only `is_active` ('true' | 'false') is read by the
     * API; anything else is ignored, which is why the caller may keep passing the
     * pagination/sort parameters the original dashboard sent.
     * @param {Function} cb - Receives the response envelope `{ status, msg, data: { items, total } }`,
     * or `{}` / `resourceNotAllowed` on failure.
     * @returns {void}
     */
    list(params, cb) {
        _get(this.apiClient, 'partner-apps', params, 'list', cb);
    }

    /**
     * Registers (or re-reads) the partner app the backend is configured for.
     *
     * Idempotent: calling it for an already-registered app returns the existing record with
     * `created: false` rather than erroring.
     *
     * @param {Object} body - Optional display overrides: `{ app_handle, display_name, listing_url }`.
     * @param {Function} cb - Receives `{ status, msg, data: { app, created } }`, or `{}` on failure.
     * @returns {void}
     */
    registerFromConfig(body, cb) {
        // A 400 here is a configuration problem the operator can fix, and the API's own message
        // names the env var to set — `_send` hands that body through rather than flattening it.
        _send(this.apiClient, 'post', 'partner-apps', body, 'registerFromConfig', cb);
    }

    /**
     * Registers the configured partner app. Source-compatible alias for `registerFromConfig`.
     *
     * ⚠️ `body.app_id` CANNOT be honoured — see the file header. It is not silently ignored either:
     * if one is supplied and the registered app turns out to be a different id, this converts the
     * response into a FAILURE naming both ids, so the operator learns the backend is configured for
     * another app rather than seeing "created" over the wrong data.
     *
     * @param {Object} body - { app_id?, app_handle?, display_name?, listing_url? }. Only the display
     * fields reach the API.
     * @param {Function} cb - Receives `{ status, msg, data: { app, created } }`, or a failure envelope.
     * @returns {void}
     */
    create(body, cb) {
        const _body = body || {};
        const requestedAppId = _body.app_id;

        this.registerFromConfig(_body, (resp) => {
            const registered = resp && resp.data && resp.data.app;
            if (!requestedAppId || !resp || !resp.status || !registered) {
                cb(resp);
                return;
            }
            if (String(registered.app_id) !== String(requestedAppId)) {
                cb({
                    status: false,
                    msg: `This backend is configured for partner app ${registered.app_id}, not ${requestedAppId}. Change SHOPIFY_PARTNER_APP_ID in the backend's .env and restart — the app id cannot be set from the dashboard.`,
                    data: {},
                    error: { code: 'PARTNER_APP_ID_MISMATCH', configured: registered.app_id, requested: requestedAppId }
                });
                return;
            }
            cb(resp);
        });
    }

    /**
     * Reads one partner app by id, with its sync watermarks and coverage gates.
     *
     * ⚠️ A 404, NOT A 200 WITH `app: null`, WHEN THE ID NAMES NOTHING. A record has no honest empty
     * rendering: answering "here is nothing" over an id that does not exist is how a mistyped id
     * becomes a screen that looks like a healthy app with no data. The 404 body is the API's own
     * envelope and reaches the callback intact.
     *
     * The row carries `categories` and `target_keywords` as well as the display fields, because
     * `PATCH` writes them — a field that is writable has to be readable, or the edit form loads a
     * blank and saves it back over stored values nobody touched.
     *
     * @param {String} partner_app_id - The app to read.
     * @param {Function} cb - Receives `{ status, msg, data: { app } }`, or `{}` /
     * `resourceNotAllowed` on failure.
     * @returns {void}
     */
    getById(partner_app_id, cb) {
        _get(this.apiClient, _appPath(partner_app_id), {}, 'getById', cb);
    }

    /**
     * Updates a partner app's editable metadata.
     *
     *  SIX FIELDS ARE WRITABLE AND NOTHING ELSE IS: `display_name`, `app_handle`, `listing_url`,
     * `categories`, `target_keywords`, `is_active`. Everything else — `partner_api_app_id`, the
     * app's own id under any spelling, all three sync watermarks and all six coverage gates — is
     * REFUSED, and refusing one field fails the WHOLE call with a 400 BEFORE the row is looked up.
     * That is deliberate on both counts: a patch that silently dropped half of what it was sent
     * would report success over an unchanged row, and refusing before the lookup means a refused
     * field cannot be used to probe which app ids exist.
     *
     * The 400 body names the field and says what would break — `partner_api_app_id` identifies which
     * Shopify app every stored event belongs to, so changing it would re-label millions of facts as
     * another app's history. Render `msg`; it is the whole instruction.
     *
     * ⚠️ SEND ONLY WHAT CHANGED, or at least only what the form owns. Resubmitting identical values
     * issues no write and answers `changed: false`, so a no-op save is cheap — but sending
     * `categories: []` because an input was never populated is a real write that wipes them.
     *
     * @param {String} partner_app_id - The app to update.
     * @param {Object} body - Any subset of the six editable fields. `is_active` must be a real
     * boolean; the string `'false'` is truthy and would invert the request, so it is refused.
     * @param {Function} cb - Receives `{ status, msg, data: { app, updated_fields, changed,
     * warnings } }`, or `{}` / `resourceNotAllowed` on failure.
     * @returns {void}
     */
    update(partner_app_id, body, cb) {
        _send(this.apiClient, 'patch', _appPath(partner_app_id), body, 'update', cb);
    }

    /**
     * Deactivates a partner app.  REMOVES NOTHING.
     *
     * The verb is narrower than its name, so the response says so on every call: `is_active` goes
     * false, every event and payout row stays exactly where it is, and the payload carries the
     * retained row COUNTS plus the exact `PATCH { "is_active": true }` that reverses it. A soft
     * delete with an undocumented undo is a hard delete with extra steps.
     *
     * Idempotent — deactivating an already-inactive app answers 200 with `changed: false` rather
     * than failing because the first call worked.
     *
     * ⚠️ Deactivating the app this backend is CONFIGURED for warns that restarting will not bring it
     * back: boot registration is idempotent on the row, not on the flag.
     *
     * @param {String} partner_app_id - The app to deactivate.
     * @param {Function} cb - Receives `{ status, msg, data: { app, changed, retained, semantics,
     * hard_delete_refusal, reversal, warnings } }`, or `{}` / `resourceNotAllowed` on failure.
     * @returns {void}
     */
    softDelete(partner_app_id, cb) {
        _send(this.apiClient, 'delete', _appPath(partner_app_id), null, 'softDelete', cb);
    }

    /**
     * Enqueues a Partner API sync for one app.
     *
     * ⚠️ Note the argument order: the app id is FIRST here, matching the source dashboard, while
     * `syncService.triggerSync` takes it inside the body. Both reach POST /api/sync/partner — this
     * one delegates, so the two can never drift apart.
     *
     *  A success here means the job is QUEUED, not that anything synced. Poll
     * `syncService.getJob(job_id)` until the status is terminal before reporting a sync happened.
     *
     * @param {String} partner_app_id - The app to sync.
     * @param {Object} body - { mode?, lookback_days? }. mode is AUTO | LIFETIME | INCREMENTAL.
     * @param {Function} cb - Receives `{ status, msg, data: { job } }`, or a failure envelope.
     * @returns {void}
     */
    triggerSync(partner_app_id, body, cb) {
        const _body = body || {};
        SYNC_API.triggerSync({
            partner_app_id: partner_app_id,
            mode: _body.mode,
            lookback_days: _body.lookback_days
        }, cb);
    }

    /**
     * Headline KPIs for one app: the window tiles, the all-time tiles and the install series.
     *
     * ──  AN UNSYNCED APP IS A 200, AND `data_state` IS WHAT SAYS SO ───────────
     * `data_state: 'NEVER_SYNCED'` comes back with EVERY figure null, `trend: null` and an
     * `unknown_reason` carrying the banner sentence — not a 404 and not an error. Decode it through
     * `readDataState`, which keys on exactly that field: a page that reads the payload directly gets
     * a full grid of em-dash tiles, which reads as "we measured nothing" over an app nothing has
     * ever run against.
     *
     * The discriminator is the WATERMARK (`coverage.last_synced_at`), never a row count — "we have
     * not looked" and "nothing happened" are different facts that a count renders identically.
     *
     * ──  EVERY FIGURE IS A BARE NUMBER, `null` FOR UNKNOWN ────────────────────
     * `AppKpiCards` formats with `Number(n)` and `typeof n !== 'number'`, so a confidence envelope
     * would render as an em dash or `[object Object]`. Nothing in this payload is enveloped.
     * `null` is never `0`: a measured empty window publishes `0`, an unmeasurable one publishes
     * `null` beside the gate that says which — `counts_measurable`, `revenue_measurable` and
     * `all_time_measurable` are three separate gates because they fail separately.
     *
     * `all_time.estimated_active` comes through the canonical install-state fold, not
     * installs-minus-uninstalls, and is `null` until a LIFETIME sync has completed — before that
     * every all-time figure is a floor rather than a total.
     *
     * `revenue.currency` is `null` when the window's payouts span more than one currency: nothing in
     * this build converts, so a single label over mixed money would be a false one.
     *
     * ── ⚠️ THE SERIES IS `trend`, NOT `daily_trend` ─────────────────────────────
     * The grain is not always days (`trend_grain` says which), so the key does not claim it is.
     * `null` there is NEVER_SYNCED; an empty array is a measured empty. Rows carry `null` counts for
     * an unmeasured bucket, which breaks the line rather than plotting a zero.
     *
     * @param {String} partner_app_id - The app to read.
     * @param {Object} params - `{ period_days }` — days back, or `'all'`/`0` for lifetime; or
     * `{ since, until }` as ISO `YYYY-MM-DD`, honoured only when both parse.
     * @param {Function} cb - Receives `{ status, msg, data: { period_label, period_days,
     * is_lifetime, window, data_state, unknown_reason?, counts, all_time, revenue, trend,
     * trend_grain, coverage, warnings, diagnostics } }`, or `{}` / `resourceNotAllowed` on failure.
     * @returns {void}
     */
    getKpi(partner_app_id, params, cb) {
        _get(this.apiClient, `${_appPath(partner_app_id)}/kpi`, params, 'getKpi', cb);
    }

    /**
     * One page of an app's raw Partner events, plus the install trend over the same window.
     *
     * ⚠️ THE FILTER IS `type`, NOT `event_type`. The row's own field is `event_type`; the query
     * parameter is `type`, and an unrecognised value is DROPPED with a warning rather than matched —
     * a table emptied by a typo is indistinguishable from a window in which nothing happened.
     *
     * ⚠️ `pagination` TRAVELS INSIDE `data`, not in the envelope's own slot, because the trend and
     * the coverage block belong to the same answer and would be orphaned from their page counters if
     * the two were split.
     *
     * ⚠️ THE TREND IS NOT THE PAGE. It is folded from a dedicated aggregate over the whole window and
     * is unaffected by `type` or by paging — a chart built from one filtered page of 50 rows would
     * wear an axis claiming to cover the period.
     *
     * `items: null` is NEVER_SYNCED (decode it, do not render it); `items: []` is a measured empty
     * and is an ordinary 200 that renders as an empty table. `raw_event` is deliberately not
     * published — it is a Mixed blob per row on the largest collection in the build.
     *
     * @param {String} partner_app_id - The app to read.
     * @param {Object} params - { page?, limit?, type?, period_days?, since?, until? }.
     * @param {Function} cb - Receives `{ status, msg, data: { items, pagination, filters, window,
     * data_state, unknown_reason?, trend, trend_grain, coverage, warnings, diagnostics } }`, or `{}`
     * / `resourceNotAllowed` on failure.
     * @returns {void}
     */
    getEvents(partner_app_id, params, cb) {
        _get(this.apiClient, `${_appPath(partner_app_id)}/events`, params, 'getEvents', cb);
    }
}

export default GrowthIntelPartnerAppApiService;
