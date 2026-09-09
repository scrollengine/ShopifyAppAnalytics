import AxiosClientProvider from '../apiClient';

/**
 * =============================================================================
 *  Stores — every shop the app has been installed on, with its current state.
 * =============================================================================
 *
 *  Backs the Stores page.
 *
 *  ──  WHY THIS IS NOT THE SUBSCRIPTIONS LIST ────────────────────────────────
 *  Carried across from the source dashboard verbatim, because it is the single
 *  most expensive misreading in this whole suite:
 *
 *  The Subscriptions list's population is "CURRENTLY PAYING". A store that never
 *  subscribed is absent from it, and — the one that catches people — so is a
 *  store that paid for two years and then uninstalled. Reading Subscriptions as
 *  "our customers" therefore erases churn by construction: the churned are not
 *  a row with a status, they are simply not there.
 *
 *  THIS list is the one whose population is "every store, ever", replayed from
 *  the install/uninstall relationship events, and it is the only one that can
 *  answer a question about stores that left.
 *
 *  ── WHAT EXISTS TODAY ───────────────────────────────────────────────────────
 *      list  →  GET /api/stores   ✅
 *
 *  The roster is DERIVED ON READ. There is no `gi_stores` collection: every row
 *  — identity, install state, dates, spend, plan, acquisition — is folded per
 *  request from `gi_partner_app_events`, `gi_partner_app_transactions` and
 *  `gi_listing_install_attributions`. That is deliberate and it is why `refresh`
 *  below is accepted and ignored: there is no cache to invalidate, so every
 *  response is already as fresh as the last Partner sync. It also means a
 *  materialised roster can never drift out of step with an uninstall that
 *  landed between two syncs.
 *
 *  ── AN EMPTY LIST IS A 200, AND `data_state` SAYS WHICH KIND OF EMPTY ───────
 *  This endpoint does NOT refuse when nothing has synced. A list has an honest
 *  empty rendering — zero rows under a banner — so it always answers 200 with
 *  `items: []`, `data_state`, `attribution_state` and `warnings[]`:
 *
 *    NEVER_SYNCED   No Partner sync has completed. `data_state: 'NEVER_SYNCED'`
 *                   and `unknown_reason` carries the sentence the banner prints.
 *                   ⚠️ `dataState.js` NULLS `data` in this state — warnings and
 *                   all — which is exactly why the reason rides on its own field.
 *    READY          A real answer. `items: []` here is a MEASURED empty: nobody
 *                   has installed this app, and that is worth drawing.
 *
 *  The discriminator is the WATERMARK (`meta.last_synced_at`), never the row
 *  count, because "we have not looked" and "nobody has installed it" are
 *  different facts that render identically if a count is asked to separate them.
 *
 *  ── THE ACQUISITION COLUMNS CAN BE ABSENT WITHOUT ANYTHING BEING WRONG ──────
 *  `channel`, `source`, `medium`, `surface_*` and `install_country` come from the
 *  OPTIONAL BigQuery/GA4 listing tier. With no credentials the endpoint still
 *  serves the full roster: `attribution_state: 'NOT_CONNECTED'`, a warning
 *  naming the missing variables, and `has_attribution: false` on every row.
 *
 *  ⚠️ DO NOT READ `has_attribution: false` AS "arrived directly". `channel` is
 *  `UNKNOWN`, labelled "Not attributed", precisely so a store we cannot explain
 *  does not disappear into what is already the largest bucket.
 *
 *  ──  `null` IS AN UNKNOWN, NOT A ZERO, AND THE ROWS RELY ON IT ────────────
 *  `monthly_spend`, `total_spend` and `plan_price` are `null` — never `0` — for a
 *  store that has never settled a subscription payout, and `plan_interval` is
 *  `null` until a settled payout names a cadence. `0` is a MEASUREMENT ("they
 *  settled once and are outside their billing window now"); `null` is an absence
 *  ("there was nothing to evaluate"). Rendering the second as the first is a
 *  specific, checkable claim that a merchant pays nothing, so every caller must
 *  format these through `storePresentation.fmtMoney`, whose null guard runs
 *  BEFORE `Number()` for exactly this reason. Same rule for `store_active`, which
 *  is `null` — not `false` — when no relationship event has been synced for the
 *  store: `=== false` is the only test that does not accuse it of uninstalling.
 * =============================================================================
 */

/**
 * Returned when the API refuses the call. See conversionService for the full note; in short, the
 * axios interceptor has already started the redirect to /login by the time a caller sees it.
 */
const resourceNotAllowed = { resource_access: 'NOT_ALLOWED' };

/**
 * True when an axios error carries the API's own response envelope rather than a transport failure.
 *
 * The discriminator that keeps the server's refusal sentence alive. Every `status: false` service
 * result is mapped onto an HTTP 500 by this backend, so a client that only forwarded 2xx/4xx bodies
 * would turn "Partner app not found." into `{}` — and `{}` renders as an empty table, which is the
 * exact lie `dataState.js` exists to refuse.
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
 * GETs one store read and hands the envelope back, untouched.
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
            console.log(`GrowthIntel store.${label} error`, err);
            cb({});
        });
};

class GrowthIntelStoreApiService {
    constructor() {
        this.apiClient = new AxiosClientProvider().getClient();
    }

    /**
     * Paginated, faceted roster of every store this app has ever been installed on.
     *
     * Counts DISTINCT STORES, folded on read — one row per shop domain, whatever its history. A
     * store that installed, uninstalled and reinstalled is one row with `install_count: 3`.
     *
     * ⚠️ TWO COUNT MAPS, AND THEY ARE NOT INTERCHANGEABLE. `install_state_counts` is the whole
     * roster with EVERY filter and the search ignored — it labels the tabs, so a post-filter count
     * would make every unselected tab read `(0)` the moment one is chosen.
     * `install_state_counts_filtered` applies the search and every OTHER facet group, so a tab's
     * number predicts what clicking it shows. Both carry an `ALL` key and every state at zero rather
     * than omitting it, because a missing key removes the number entirely and reads as "not
     * measured".
     *
     * ⚠️ `dir`, NOT `sort_dir` — a different spelling from the install cohort's, and the endpoint
     * reads this one. An unrecognised sort key or facet value WIDENS the result and returns a
     * warning; it never empties the table, because a table emptied by a typo is indistinguishable
     * from a business with no stores.
     *
     * ⚠️ `countries` is accepted, ignored and warned about. The Revenue → By country tab links here with an
     * ISO-2 code and the only per-store country this build holds is GA4's common NAME for the
     * install traffic, so the filter cannot be honoured — the warning says so rather than the table
     * silently matching nothing.
     *
     * @param {Object} params - { partner_app_id, page, limit, q, sort, dir, install_states, states,
     * billing, store_records, store_statuses, shopify_plans }. Facet params are comma-joined
     * strings; omitting a group entirely leaves it unconstrained. `refresh` is accepted and ignored
     * — the roster is folded per request, so there is no cache to bust.
     * @param {Function} cb - Receives `{ status, msg, data: { items, pagination, facet_groups,
     * install_state_counts, install_state_counts_filtered, meta, warnings, data_state,
     * attribution_state, diagnostics, … } }`.
     * @returns {void}
     */
    list(params, cb) {
        _get(this.apiClient, 'stores', params, 'list', cb);
    }
}

export default GrowthIntelStoreApiService;
