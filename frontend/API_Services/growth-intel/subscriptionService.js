import AxiosClientProvider from '../apiClient';

/**
 * =============================================================================
 *  Subscriptions — store-by-store, for stores that are CURRENTLY PAYING.
 * =============================================================================
 *
 *  Backs the Subscriptions page, and — through `getDetail` — the store detail
 *  slide-over that opens from SEVEN tables: Stores, Subscriptions, the install
 *  cohort on Funnel, Revenue, Revenue Churn, Logo Churn and Trial
 *  Funnel.
 *
 *  ──  READ THE POPULATION BEFORE READING THE NUMBERS ────────────────────────
 *  The LIST is "on a paid plan right now". Two groups are absent from it
 *  entirely, and neither appears as a row with a different status:
 *
 *    · stores that never subscribed;
 *    · stores that paid, then uninstalled — the churned.
 *
 *  So a count taken from here is not "our customers to date", and a trend built
 *  from it cannot show churn: the churned leave the population rather than
 *  changing state within it. The Stores page (`storeService`) is the list whose
 *  population is every store ever, and it is the one that can answer that.
 *
 *  ── WHAT EXISTS TODAY ───────────────────────────────────────────────────────
 *      getDetail  →  GET /api/stores/detail   ✅
 *      list       →  GET /api/subscriptions   ✅
 *
 *  Both are live. `list` answered with the not-implemented envelope until the
 *  per-shop projection over the payout ledger was built; the page decoded that
 *  as NOT_IMPLEMENTED and printed "Not built yet — GET /api/subscriptions does
 *  not exist in this backend". That sentence is now false, and the stub is gone.
 *
 *  ──  `getDetail` CALLS `/api/stores/detail`, NOT `/api/subscriptions/detail` ─────────────
 *  It named the second path while it was a stub, and that path was never built,
 *  deliberately. The drawer's COMMONEST subject is a store that never subscribed
 *  — the install cohort is mostly such stores — and a Subscriptions list's
 *  population is "currently paying", so serving a store record from a
 *  `/subscriptions/` path would name the answer after a population it does not
 *  have. The method keeps its name because seven call sites use it and the
 *  drawer is the subscription-shaped view of a store; only the URL moved.
 *
 *  ──  THE DETAIL ENDPOINT IS THE ONE READ HERE THAT REFUSES ───────────────
 *  Everything else in this suite answers an empty question with a 200 and a
 *  reason. This one does not, and the difference is about RENDERING rather than
 *  about HTTP: `StoreDetailDrawer` draws either the full panel or one critical
 *  banner, with no per-field empty state — so a store the Partner API has no
 *  record of comes back `status: false` carrying the sentence that banner
 *  prints. A 200 there would paint a finished-looking panel of fabricated em
 *  dashes. The refusal arrives as an HTTP 500 (this backend maps every
 *  `status: false` onto one), which is why `_hasEnvelope` below forwards the
 *  body instead of collapsing it to `{}`.
 *
 *  ── EXACTLY ONE IDENTITY KEY GOES ON THE WIRE ───────────────────────────────
 *  `storePresentation.storeDetailRequestParams` picks `tenant_id` for a 24-hex
 *  string and `shop_domain` for anything else, so the two can never disagree.
 *  ⚠️ This build has NO tenant records at all — no tenant, user_tenant or users
 *  graph — so a `tenant_id` is REFUSED with a sentence naming the parameter that
 *  works, rather than silently ignored. A caller that maps a Partner GID onto
 *  `tenant_id` gets that refusal; map the domain instead.
 *
 *  ──  THE ACQUISITION BLOCK CAN BE ABSENT WITHOUT ANYTHING BEING WRONG ─────
 *  `data.acquisition` comes from the OPTIONAL BigQuery/GA4 listing tier and is
 *  `null` — never `{}` — when there is no record, which is what selects the
 *  drawer's "Not attributed" branch. With no credentials the endpoint still
 *  serves the whole record: `attribution_state: 'NOT_CONNECTED'` plus a warning
 *  naming the missing variables.
 *
 *  ──  `null` IS AN UNKNOWN, NOT A ZERO ────────────────────────────────────
 *  `summary.lifetime_value`, `summary.average_spend`, `summary.mrr`,
 *  `subscription.plan_price` and `subscription.plan_interval` are `null` when
 *  there was nothing to evaluate — `average_spend` because a ratio over an empty
 *  denominator is not zero, `mrr` because "we never fetched a payout" and "they
 *  stopped paying" are different facts. `subscription.store_active` is `null`
 *  (never `false`) when no relationship event has been synced. Render these
 *  through `storePresentation.fmtMoney` and test `store_active === false`; a
 *  `$0.00` or an "Uninstalled" badge manufactured from a null is a specific,
 *  checkable claim the server never made.
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
 *  LOAD-BEARING FOR THIS SERVICE IN PARTICULAR. The detail endpoint's "no record of this store"
 * refusal is served as an HTTP 500 with `{ status: false, msg }`, and `msg` is the ONLY text the
 * drawer's critical banner has to show. Collapsing a 500 to `{}` would replace the server's sentence
 * with "Could not load this store." — the generic message that sends a reader looking for a bug that
 * is not there.
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
 * GETs one read and hands the envelope back, untouched.
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
            console.log(`GrowthIntel subscription.${label} error`, err);
            cb({});
        });
};

class GrowthIntelSubscriptionApiService {
    constructor() {
        this.apiClient = new AxiosClientProvider().getClient();
    }

    /**
     * Paginated store-by-store list of the merchants who are on a paid plan RIGHT NOW.
     *
     * ⚠️ THE POPULATION IS "CURRENTLY PAYING", so a store that never subscribed and a store that
     * paid and then churned are both ABSENT rather than present with a different status — see the
     * file header. A total taken from here is not "customers to date", and no trend built from it
     * can show churn.
     *
     * ── `state` MUST NOT APPEAR ON A ROW ────────────────────────────────────────
     * `StoreTable._renderStatus` reads `row.state || row.status` and `state` WINS. The rows come off
     * the same fold that serves `GET /api/stores`, whose vocabulary is the five LIFECYCLE states, so
     * the resolver strips `state`/`state_label` and republishes them as `status`/`status_label` in
     * the four-value SUBSCRIPTION vocabulary. Do not re-add `state` here as a convenience: the badge
     * would read "Converted" beneath a tab reading "Paying".
     *
     * ── `null` IS AN UNKNOWN, NOT A ZERO ────────────────────────────────────────
     * `monthly_spend`, `total_spend` and `plan_price` are `null` when there was nothing to evaluate —
     * `null` means "never evaluated", `0` means "settled once, outside the live window", and they are
     * different facts about the merchant. `store_active` is `null` (never `false`) when no
     * relationship event has been synced. `has_attribution: false` means unattributed, NOT "direct".
     * Render these through the honest formatters; a `$0.00` manufactured from a null is a specific,
     * checkable claim the server never made.
     *
     * ── EMPTY IS A 200 ──────────────────────────────────────────────────────────
     * `data_state` is decided by the WATERMARK, never the row count: `NEVER_SYNCED` (with
     * `unknown_reason` as the banner body) means nothing has ever been fetched, while a synced app
     * whose ledger is genuinely empty stays `READY` with `items: []` and says so in `warnings[]`.
     * `status_counts` is PRE-filter and `status_counts_filtered` applies the other facet groups, so
     * every tab keeps a number — including its zero.
     *
     * @param {Object} params - { partner_app_id (required), page, limit, q, sort, dir, and the four
     * comma-joined facet groups `states`, `install_states`, `billing`, `store_statuses` }. ⚠️ The
     * direction parameter is `dir`, not `sort_dir`. `refresh` is accepted and ignored — the list is
     * folded on every request, so there is no cache to invalidate.
     * @param {Function} cb - Receives `{ status, msg, data: { items, pagination, status_counts,
     * status_counts_filtered, facet_groups, population, sort, filters, meta, warnings, diagnostics,
     * data_state, unknown_reason? } }`, or `{}` / `resourceNotAllowed` on failure.
     * @returns {void}
     */
    list(params, cb) {
        _get(this.apiClient, 'subscriptions', params, 'list', cb);
    }

    /**
     * Everything known about ONE store: identity, install lifecycle, subscriptions, settled payouts,
     * acquisition, and a merged newest-first timeline.
     *
     * ⚠️ THE TIMELINE'S ORDER IS THE SCREEN ORDER. `StoreDetailContent` groups consecutive entries
     * by calendar day WITHOUT sorting them, so re-ordering this array client-side renders one day
     * heading per entry.
     *
     * ⚠️ `subscription.status` is the SUBSCRIPTION lifecycle vocabulary, in which `INSTALLED` means
     * "this store never subscribed". Whether the app is on the store right now is
     * `subscription.install_state`, a different question from a different source, and the two
     * disagree by design.
     *
     * @param {Object} params - { partner_app_id, shop_domain } or { partner_app_id, tenant_id }.
     * Exactly one identity key — build it with `storePresentation.storeDetailRequestParams`.
     * @param {Function} cb - Receives `{ status, msg, data: { subscription, acquisition, summary,
     * timeline, subscriptions, payouts, app_review, provenance, unavailable, meta, warnings,
     * diagnostics, data_state, attribution_state } }`, or `{ status: false, msg }` carrying the
     * sentence the drawer's critical banner prints.
     * @returns {void}
     */
    getDetail(params, cb) {
        _get(this.apiClient, 'stores/detail', params, 'getDetail', cb);
    }
}

export default GrowthIntelSubscriptionApiService;
