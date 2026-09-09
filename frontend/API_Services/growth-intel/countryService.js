import AxiosClientProvider from '../apiClient';

/**
 * =============================================================================
 *  Revenue by country — stores, installs, paying customers and MRR per country.
 * =============================================================================
 *
 *  Backs the Revenue → By country tab.
 *
 *  Its own endpoint rather than a column on the stores list, and that is a real
 *  constraint rather than tidiness: the breakdown is a WHOLE-POPULATION rollup,
 *  so paging it alongside a paginated store list would either page the wrong
 *  thing or force the list to fetch every store in order to draw eight rows.
 *
 *  ── WHAT ACTUALLY EXISTS TODAY ──────────────────────────────────────────────
 *      list  →  GET /api/stores/countries   ✅ implemented
 *
 *  ── ⚠️ COUNTRY HERE IS WHERE THE INSTALL CAME FROM ──────────────────────────
 *  It is the geo recorded against each install by LISTING ANALYTICS, not the
 *  merchant's registered trading country: the Partner API's Shop object carries
 *  no country on any version, so there is no second source to prefer. The
 *  payload says so itself in `country_basis`, and the page must not relabel it
 *  as "where the merchant is".
 *
 *  ──  THE REMAINDER IS PUBLISHED, NEVER DROPPED ────────────────────────────
 *  A store whose country cannot be resolved lands in an explicit `UNKNOWN` row,
 *  so `sum(items) === totals` holds by construction and this page's MRR can be
 *  reconciled against the Revenue page's. `coverage.unattributed_*` is how much
 *  of the population that is.
 *
 *  ⚠️ AND THE CAUSE IS A MISSING INSTALL-ATTRIBUTION RECORD, not a missing
 *  Partner event: those stores are on the roster precisely BECAUSE the Partner
 *  API knows them. `warnings[]` carries the accurate sentence — render it.
 *
 *  ── NORMALISATION HAPPENS SERVER-SIDE, ONCE ─────────────────────────────────
 *  Upstream geo mixes ISO codes with display names and the names do not
 *  round-trip. The service resolves a code BEFORE grouping, keeps the two
 *  Congos and the two Koreas apart, and refuses to guess an ambiguous name
 *  (which then lands in `UNKNOWN` with a warning naming the raw value). Nothing
 *  on this page may regroup or re-spell a country: one country in two buckets
 *  makes both rows wrong.
 *
 *  `countries` is deliberately NOT an accepted filter: filtering countries here
 *  would remove the very rows being compared against each other.
 * =============================================================================
 */

/**
 * Returned when the API refuses the call. By the time a caller sees this the axios interceptor has
 * already cleared the token and started the redirect to /login — this exists so a page that renders
 * before the navigation completes shows its empty state rather than throwing. It carries no
 * `status`, so every `if (!resp.status)` guard treats it as a failed call, which is correct, and
 * `readDataState` tests for it FIRST so an expired session is never misfiled as a broken config.
 */
const resourceNotAllowed = { resource_access: 'NOT_ALLOWED' };

class GrowthIntelCountryApiService {
    constructor() {
        this.apiClient = new AxiosClientProvider().getClient();
    }

    /**
     * Shared GET. Mirrors `conversionService._get` exactly — same envelope, same 401 sentinel, same
     * `{}` on failure — so `readDataState` decodes every service in this folder identically.
     *
     * @param {String} path - Path relative to the axios base (`/api/`), e.g. 'stores/countries'.
     * @param {Object} params - Query parameters.
     * @param {Function} cb - Receives the response envelope, `{}`, or `resourceNotAllowed`.
     * @param {String} ctx - Method name, for the console line on failure.
     * @returns {void}
     */
    _get(path, params, cb, ctx) {
        this.apiClient
            .get(path, { params: params || {} })
            .then((response) => { cb(response && response.data ? response.data : {}); })
            .catch((err) => {
                if (err.response && err.response.status === 401) { cb(resourceNotAllowed); return; }
                console.log(`GrowthIntel country.${ctx} error`, err);
                cb({});
            });
    }

    /**
     * Per-country rollup for one partner app, over the WHOLE population.
     *
     * ── ⚠️ EMPTY RESULTS ARE 200s, AND SO IS AN UNCONFIGURED LISTING TIER ───────
     * A missing or never-synced listing-analytics tier answers 200 with an all-`UNKNOWN` breakdown
     * plus `attribution_state` and a populated `warnings[]` — deliberately NOT a refusal, which the
     * page would render as though the operator had no stores at all. `data_state` /
     * `unknown_reason` carry the never-synced case, which `readDataState` decodes.
     *
     * ── EVERY COUNTABLE FIELD IS A REAL NUMBER; `conversion_rate` IS NOT ────────
     * `stores`, `installed`, `paying`, `trialing`, `ever_paid`, `mrr`, `total_spend` and
     * `net_revenue` are always numbers. `conversion_rate` is `number | null` — null when there is no
     * denominator — and `coverage.mrr_coverage` likewise. Neither may be coerced with `|| 0`: a
     * fabricated `0%` conversion rate is a claim about a market nobody measured.
     *
     * ── MRR HERE IS THE SAME MRR ────────────────────────────────────────────────
     * The rollup accumulates the paying set's `monthly_amount` from the canonical as-of predicate —
     * the one the Revenue page's headline comes through — so the two cannot disagree about who is
     * paying. It will still read LOWER, because the unattributed remainder is broken out separately;
     * `coverage` is what reconciles them, and the page's own banner explains the gap.
     *
     * @param {Object} params - { partner_app_id (required), q, sort, dir, install_states, states,
     * billing, store_records, store_statuses }. Facet params are comma-joined strings. Unknown facet
     * values are ignored with a warning rather than refused.
     * @param {Function} cb - Receives `{ status, msg, data: { items, totals, coverage, facet_groups,
     * country_basis, attribution_state, meta, warnings, diagnostics, data_state, unknown_reason } }`,
     * or `{}` / `resourceNotAllowed` on failure.
     * @returns {void}
     */
    list(params, cb) {
        this._get('stores/countries', params, cb, 'list');
    }
}

export default GrowthIntelCountryApiService;
