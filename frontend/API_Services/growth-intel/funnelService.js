import AxiosClientProvider from '../apiClient';
import GrowthIntelSyncApiService from './syncService';

/**
 * =============================================================================
 *  Acquisition — where installs came from, and what they did next.
 * =============================================================================
 *
 *  Two Performance pages call this service: Traffic Sources (`getTrafficSource`,
 *  `getGeo`) and the Funnel page (`getFunnel`, alongside
 *  conversionService). The Sync page calls the two triggers.
 *
 *  ── WHAT EXISTS TODAY ───────────────────────────────────────────────────────
 *      getFunnel              →  GET  /api/funnel                     ✅
 *      getTrafficSource       →  GET  /api/funnel/traffic-source      ✅
 *      getGeo                 →  GET  /api/funnel/geo                 ✅
 *      triggerSync            →  POST /api/sync/bigquery              ✅ (delegated)
 *      triggerAttributionSync →  POST /api/sync/install-attribution   ✅ (delegated)
 *      getInstallCohort       →  GET  /api/funnel/install-cohort       ✅
 *
 *  This service was a wall of not-implemented stubs until the BigQuery tier
 *  landed, because the reads behind it need a SECOND upstream: the GA4 export of
 *  the App Store listing, in BigQuery, with its own credentials and its own cost
 *  model. That source now exists — but it is OPTIONAL, and an install that never
 *  configured it is a normal install rather than a broken one.
 *
 *  ── THREE WAYS TO HAVE NOTHING TO SHOW, AND THEY DO NOT LOOK ALIKE ───────
 *  The read endpoints distinguish them, and a caller MUST NOT flatten them back
 *  together:
 *
 *    1. NOT CONNECTED   No BigQuery credentials. The API answers `status: false`
 *                       with a message NAMING THE MISSING ENVIRONMENT VARIABLE,
 *                       over HTTP 500. There is no payload, because there is no
 *                       data source — an empty chart here would be a claim about
 *                       the merchant's listing that nobody has evidence for.
 *    2. NEVER SYNCED    Connected, but no BIGQUERY_SYNC has completed.
 *                       `status: true`, `data_state: 'NEVER_SYNCED'`, and the
 *                       figures are NULL — never zero — with `unknown_reason`.
 *    3. GENUINELY EMPTY Synced, and this window really had no traffic.
 *                       `data_state: 'READY'`, `items: []`, real zeros.
 *
 *  Case 1's message is the only thing standing between an operator and hours
 *  spent debugging a listing that is fine, so every method below hands the
 *  server's envelope through UNCHANGED — including on a 500, which is the status
 *  the refusal arrives with. Collapsing that to `{}` would delete the sentence
 *  that says which variable to set.
 *
 *  ──  DO NOT SUBSTITUTE INSTALL COUNTS FOR TRAFFIC ─────────────────────────
 *  The tempting shortcut, when BigQuery is not configured, is to back
 *  `getTrafficSource` with the install events the Partner API DOES return,
 *  labelled 'direct' or 'unknown'. Don't. A traffic breakdown that reports 100%
 *  direct is not a partial answer; it is a specific, confident, wrong claim about
 *  acquisition — and it is indistinguishable from a real result. An empty page
 *  that says why is worth more.
 * =============================================================================
 */

/**
 * Shared sync client. The two triggers below DELEGATE to it rather than posting for themselves, so
 * the Sync page's buttons and these methods can never drift into calling different endpoints or
 * treating the same failure differently. Same device as `partnerAppService.triggerSync`.
 */
const SYNC_API = new GrowthIntelSyncApiService();

/**
 * Returned when the API refuses the call. See conversionService for the full note; in short, the
 * axios interceptor has already started the redirect to /login by the time a caller sees it.
 */
const resourceNotAllowed = { resource_access: 'NOT_ALLOWED' };

/**
 * True when an axios error carries the API's own response envelope rather than a transport failure.
 *
 * The discriminator that keeps the "not connected" message alive. That refusal is served as an
 * HTTP 500 (the backend maps every `status: false` service result onto one), so a client that only
 * forwarded 2xx/400 bodies would turn "set GCP_PROJECT_ID" into `{}` — and `{}` renders as an empty
 * chart, which is the exact lie this whole module is built to refuse.
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
 * GETs one listing-analytics read and hands the envelope back.
 *
 * Written once because all three reads owe a caller identical treatment — including the envelope
 * pass-through above, which is the part that is easy to get wrong in the third copy.
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
            console.log(`GrowthIntel funnel.${label} error`, err);
            cb({});
        });
};

class GrowthIntelFunnelApiService {
    constructor() {
        this.apiClient = new AxiosClientProvider().getClient();
    }

    /**
     * Daily funnel data plus summary KPIs for a partner app.
     *
     * Counts VISITORS. Everything on the Partner API side counts SHOPS, so any ratio that crosses
     * that seam compares two different populations.
     *
     * ⚠️ On `data_state: 'NEVER_SYNCED'` the response is a SUCCESS whose `summary` and `trend` are
     * `null` — not zeros, and not an empty array. Rendering a funnel from those nulls as 0 would
     * assert that nobody has ever viewed the listing. Read `unknown_reason` and say that instead.
     *
     * @param {Object} params - { partner_app_id, period_days? | since, until }. `period_days` also
     * accepts `'all'` for the lifetime window.
     * @param {Function} cb - Receives `{ status, msg, data: { summary, trend, data_state,
     * last_bq_synced_at, … } }`.
     * @returns {void}
     */
    getFunnel(params, cb) {
        _get(this.apiClient, 'funnel', params, 'getFunnel', cb);
    }

    /**
     * Traffic source / medium breakdown.
     *
     * FIRST-EVER acquisition scope — where a visitor originally came from, not the visit that
     * converted.
     *
     * @param {Object} params - { partner_app_id, period_days? | since, until, limit? }.
     * @param {Function} cb - Receives `{ status, msg, data: { items, data_state, … } }`.
     * @returns {void}
     */
    getTrafficSource(params, cb) {
        _get(this.apiClient, 'funnel/traffic-source', params, 'getTrafficSource', cb);
    }

    /**
     * Per-country breakdown of listing traffic.
     *
     * ⚠️ TRAFFIC by country, which is not the Revenue → By country tab — that one reads
     * `countryService`, and counts stores and money rather than visitors. The two will legitimately
     * disagree, and neither is wrong.
     *
     * @param {Object} params - { partner_app_id, period_days? | since, until, limit? }.
     * @param {Function} cb - Receives `{ status, msg, data: { items, data_state, … } }`.
     * @returns {void}
     */
    getGeo(params, cb) {
        _get(this.apiClient, 'funnel/geo', params, 'getGeo', cb);
    }

    /**
     * Every store that installed inside the window, with how it arrived and where it got to.
     *
     * Counts DISTINCT STORES, not install events — a store that installed, uninstalled and
     * reinstalled inside the window is one row, with `install_count: 2`.
     *
     * ⚠️ The acquisition columns come from the OPTIONAL BigQuery tier, and the endpoint does not
     * refuse without it: every row answers `has_attribution: false` and `attribution_state` says
     * which of the three reasons applies. Do not read that as "these stores arrived directly" —
     * `summary.attribution_coverage` is the fraction that could be attributed at all, and is `null`
     * rather than `0` when there were no installs to attribute.
     *
     * @param {Object} params - { partner_app_id, period_days?, since?, until?, state?, channel?,
     * sort_key?, sort_dir?, page?, limit? }.
     * @param {Function} cb - Receives the response envelope.
     * @returns {void}
     */
    getInstallCohort(params, cb) {
        _get(this.apiClient, 'funnel/install-cohort', params, 'getInstallCohort', cb);
    }

    /**
     * Triggers a per-install attribution sync (GA4 → per-store install rows), or prices it.
     *
     * ⚠️ The response shape depends on `dry_run`: `{ job }` normally, an ESTIMATE
     * (`gib_scanned`, `exceeds_cap`) on a dry run, which runs inline and creates no job. Delegated,
     * so this and the Sync page's buttons cannot drift apart.
     *
     * @param {Object} body - { partner_app_id, mode?, lookback_days?, dry_run? }. `dry_run` prices
     * the BigQuery scan without running or writing it.
     * @param {Function} cb - Receives the response envelope.
     * @returns {void}
     */
    triggerAttributionSync(body, cb) {
        SYNC_API.triggerInstallAttributionSync(body, cb);
    }

    /**
     * Triggers the BigQuery listing-rollup sync for a partner app.
     *
     *  QUEUED, not synced — poll `syncService.getJob(job_id)` to a terminal status. And a 200 is
     * not evidence that BigQuery is configured: the job checks that when it runs, and fails naming
     * the missing variable if it is not.
     *
     * @param {Object} body - { partner_app_id, mode?, lookback_days? }.
     * @param {Function} cb - Receives `{ status, msg, data: { job } }`.
     * @returns {void}
     */
    triggerSync(body, cb) {
        SYNC_API.triggerBigQuerySync(body, cb);
    }
}

export default GrowthIntelFunnelApiService;
