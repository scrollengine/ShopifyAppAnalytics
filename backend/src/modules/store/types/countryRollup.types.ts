/**
 * ============================================================================
 *  THE REVENUE COUNTRY CONTRACT — every name a component reads
 * ============================================================================
 *
 *  Declarations only — `typeof import(…)` is erased at compile time, so importing this file costs
 *  nothing at run time and does NOT pull the constants module in.
 *
 *  ── EVERY FIGURE IS A BARE NUMBER OR `null`, NEVER AN ENVELOPE ─────────────────────────────
 *
 *  `components/growth-intel/revenue/CountryView.js` renders through `_isNum` / `_num` / `_money`, all of which
 *  do `Number(n)` and print an em dash for anything that is not finite — so a `confidence.helper`
 *  envelope renders as "we could not measure this" about a figure that WAS measured, and
 *  `CountryTable` would print `$0.00` for it. The honesty contract is discharged through the explicit
 *  `UNKNOWN` remainder row, `coverage`, `meta`, `diagnostics` and `warnings[]` instead.
 *
 *  ── ⚠️ AND `null` IS NOT `0` ────────────────────────────────────────────────────────────────
 *
 *  `conversion_rate` is `null` — never `0` — for a country with no stores in it. `_isNum(null)` is
 *  false and prints an em dash; a `0` would read as a market that installs and never converts.
 * ============================================================================
 */

type CountryConstants = typeof import('../constants/countryRollup.constants');

/** A member of the sort allowlist. Widened to a literal union because the constant is a `string[]`. */
export type CountrySortKey =
    'paying' | 'mrr' | 'stores' | 'installed' | 'conversion_rate' | 'trialing'
    | 'ever_paid' | 'total_spend' | 'country_name' | 'net_revenue';

/** Sort direction. Nulls sort LAST in both, because a missing value is not an extreme one. */
export type CountrySortDirection = 'asc' | 'desc';

/** The five facet groups this endpoint evaluates — a SUBSET of the roster's six. */
export type CountryFacetGroupKey = CountryConstants['COUNTRY_FACET_GROUP_KEYS'][number];

// ── The row ─────────────────────────────────────────────────────────────────

/**
 * One country's slice of the whole population.
 *
 *  EXACTLY ONE ROW PER STORE, ACROSS ALL ROWS. Every store in the filtered population lands in
 * exactly one bucket — its resolved country, or the explicit `UNKNOWN` remainder — so
 * `sum(items[field]) === totals[field]` for every countable field, by construction. That identity is
 * the whole reason the remainder exists: without it the per-country column silently stops summing to
 * the headline figure and this page and the Revenue page disagree with no visible cause.
 */
export interface CountryRollupRow {
    /**
     * ISO-3166-1 alpha-2, or the literal `UNKNOWN` for the remainder.
     *
     * ⚠️ THE ROW ID, THE REACT KEY AND THE LINK TARGET. `CountryTable` uses it for `id`/`key` and
     * pushes it to `/growth-intel/stores?countries=<code>`; it also special-cases the exact string
     * `UNKNOWN` to suppress the code chip beside the name.
     */
    country: string;
    /**
     * The display name, from the normaliser's own index — never the raw stored value.
     *
     * That is what makes `US` and `United States` one row with one label instead of two rows that
     * are each half right.
     */
    country_name: string;
    /** Every store in the population attributed here, whatever its install state. */
    stores: number;
    /** Stores whose most recent relationship event is an install or reinstall. */
    installed: number;
    /**
     * Stores paying RIGHT NOW, from `modules/revenue`'s `liveSetAsOf` by way of the roster fold.
     *
     *  NOT re-derived. It is the same map `/api/subscriptions` takes its entire population from, so
     * "paying" cannot mean one thing here and another there.
     */
    paying: number;
    /** Stores whose subscription is `ON_TRIAL` as of the judgement instant. */
    trialing: number;
    /** Stores that have settled at least one payout, ever — including ones that have since churned. */
    ever_paid: number;
    /**
     * `paying / stores`, a FRACTION.
     *
     * ⚠️ `null` — never `0` — for a country with no stores. Paying over STORES rather than over
     * INSTALLS on purpose: a store that uninstalled while paying is still revenue that country
     * produced, and measuring against installs would erase it.
     */
    conversion_rate: number | null;
    /**
     * Combined monthly run-rate of the paying stores here, ANNUAL charges divided by 12.
     *
     * ⚠️ A RUN-RATE, not cash. `total_spend` and `net_revenue` beside it are all-time settled money;
     * the two are not expected to track and are never added together.
     */
    mrr: number;
    /** Lifetime settled GROSS — what merchants here paid, before Shopify's fee. */
    total_spend: number;
    /**
     * Lifetime settled NET — what actually reached the bank, after Shopify's fee.
     *
     * ⚠️ Published beside gross and NAMED, because the source system's country table summed GROSS
     * while the Revenue page's lifetime card showed NET — so one word named two different numbers on
     * adjacent screens, which reads as one of them being broken.
     */
    net_revenue: number;
}

// ── Totals, coverage, facets ────────────────────────────────────────────────

/**
 * The whole filtered population, summed.
 *
 *  EVERY COUNTABLE FIELD HERE EQUALS THE SUM OF THE SAME FIELD OVER `items`, remainder included.
 * A test asserts it. The moment that stops holding, a store has been dropped or double-counted.
 */
export interface CountryRollupTotals {
    stores: number;
    installed: number;
    paying: number;
    trialing: number;
    ever_paid: number;
    mrr: number;
    total_spend: number;
    net_revenue: number;
    /**
     * How many ROWS the table has — the remainder included when it exists.
     *
     * ⚠️ ROWS, NOT COUNTRIES, and the page is why: its footer reads
     * "Showing {visibleItems.length} of {totals.countries} countries", so a count that excluded the
     * remainder would render "Showing 13 of 12" the moment any store lacked a geo. The true count of
     * real countries is `countries_attributed`, published beside it.
     */
    countries: number;
    /** Rows that resolved to a real ISO country — `countries` minus the remainder row, if any. */
    countries_attributed: number;
}

/**
 * How much of the population could be placed on a map at all.
 *
 * ⚠️ The page renders a banner from this whenever `unattributed_paying > 0`. Its wording says those
 * stores "have no install or uninstall event in the Partner replay", which is the SOURCE SYSTEM's
 * reason and is wrong for this build — here the cause is a missing install-ATTRIBUTION (GA4) record.
 * `warnings[]` carries the accurate sentence.
 */
export interface CountryRollupCoverage {
    /** Stores with a resolved country. */
    attributed_stores: number;
    /** Stores in the remainder — no geo, or a geo string the normaliser could not place. */
    unattributed_stores: number;
    attributed_paying: number;
    unattributed_paying: number;
    attributed_mrr: number;
    unattributed_mrr: number;
    /**
     * `attributed_mrr / (attributed + unattributed)`, a FRACTION.
     *
     * ⚠️ `null` when there is no MRR at all. The page's `_uncoveredMrrShare` refuses to write its
     * sentence without a number here, precisely because `1 - (undefined || 0)` published
     * "that is 100% of MRR" whenever the ratio was merely missing — the most alarming possible reading
     * of "we were not told", inside the one banner whose job is to explain a discrepancy.
     */
    mrr_coverage: number | null;
    /**
     * Distinct raw geo strings the normaliser could not place, verbatim and capped.
     *
     *  NAMED RATHER THAN COUNTED. These stores are in the remainder, so the breakdown still
     * reconciles — but an unplaceable value is a MAPPING gap, not a coverage gap, and the two need
     * different fixes. Publishing the exact strings is what lets an operator report one.
     */
    unresolved_geo_values: string[];
    /** Stores carrying one of those values. They are inside `unattributed_stores`, not beside it. */
    unresolved_geo_stores: number;
}

/** One option inside a facet group. `count` is over the population BEFORE that group's own filter. */
export interface CountryFacetOption {
    value: string;
    label: string;
    count: number;
}

/** One facet group, exactly as `SubscriptionFacetFilter` consumes it. */
export interface CountryFacetGroup {
    key: CountryFacetGroupKey;
    label: string;
    options: CountryFacetOption[];
}

/** The filters as they were ACTUALLY applied, after fail-open validation dropped the unusable ones. */
export interface CountryAppliedFilters {
    install_states: string[];
    states: string[];
    billing: string[];
    store_records: string[];
    store_statuses: string[];
}

/** Freshness and coverage figures for the page footer. Bare values; `null` means "not measured". */
export interface CountryRollupMeta {
    /** The page prints this verbatim: "last Partner sync {meta.last_synced_at}". */
    last_synced_at: string | null;
    earliest_event_at: string | null;
    earliest_transaction_at: string | null;
    lifetime_sync_completed_at: string | null;
    /** When the install-attribution (GA4) sync last completed. The bound on every country here. */
    last_install_attrib_synced_at: string | null;
}

/** Everything the fold excluded or could not resolve. Every number here is also a warning. */
export interface CountryRollupDiagnostics {
    /** Distinct stores the Partner API has any record of, before any filter. */
    domains_seen: number;
    /** Stores left after the facet filters — the population every figure above is over. */
    domains_filtered: number;
    /** Stores with an install-attribution record carrying a non-empty geo. */
    stores_with_geo: number;
    /** Stores whose geo string could not be resolved to a country. Inside the remainder. */
    stores_with_unresolved_geo: number;
    /** Stores whose payouts arrived in more than one currency, so their spend sums unlike units. */
    stores_with_mixed_spend_currency: number;
    /**
     * Canonical regions the runtime's ICU data supplied.
     *
     * ⚠️ `0` means this Node was built WITHOUT region data, so every name falls to the remainder. That
     * is a runtime fact rather than a business one and the endpoint says so out loud, instead of
     * publishing a page that reports a merchant with no geography.
     */
    country_index_size: number;
    /** Facet values and sort keys that were ignored, echoed so a typo is visible rather than empty. */
    unrecognised_filters: string[];
}

// ── Request ─────────────────────────────────────────────────────────────────

/**
 * The query bag, exactly as `frontend/API_Services/growth-intel/countryService.js` sends it.
 *
 * Everything is optional and everything is `unknown`-tolerant: the controller validates SHAPE, never
 * data. Validation here is FAIL-OPEN — an unrecognised value widens the result and adds a warning,
 * and never empties the table.
 */
export interface CountryRollupParams {
    partner_app_id?: string;
    sort?: string;
    /** The page sends `dir`, not `sort_dir`. */
    dir?: string;
    /** Comma-joined facet values. An omitted group constrains nothing. */
    install_states?: string;
    states?: string;
    billing?: string;
    store_records?: string;
    store_statuses?: string;
    /**
     * ⚠️ ACCEPTED, REFUSED AND WARNED ABOUT. Filtering countries on the countries page would remove
     * the very rows being compared against each other, so it is dropped with a sentence rather than
     * silently honoured. The page never sends it; an API caller might.
     */
    countries?: string;
    /**
     * ⚠️ ACCEPTED AND DELIBERATELY IGNORED. The page filters the TABLE locally so its KPIs and donuts
     * keep describing the whole population — a server-side `q` would silently reshape them too, and
     * typing "united" would redraw the revenue mix as 100% of three countries while the header still
     * claimed the full total. Documented here so nobody wires it up later.
     */
    q?: string;
}

// ── Response ────────────────────────────────────────────────────────────────

/** The `data` of a successful `GET /api/stores/countries`. */
export interface CountryRollupResponse {
    app_id: string;
    app_name: string;
    /** The ONE judgement instant this whole response was folded against. */
    as_of: string;

    /** One row per country, plus the explicit remainder. Sorted; never paginated. */
    items: CountryRollupRow[];
    totals: CountryRollupTotals;
    coverage: CountryRollupCoverage;
    sort: { key: CountrySortKey; dir: CountrySortDirection };
    facet_groups: CountryFacetGroup[];
    filters: CountryAppliedFilters;
    meta: CountryRollupMeta;

    /** Where "country" comes from, on the payload rather than only in the page's footer. */
    country_basis: string;

    /**
     * The PARTNER tier's state, decided by the WATERMARK and never by the row count.
     *
     *  No stores plus `last_synced_at` is a real, publishable "nobody has ever installed this app".
     * No stores and no watermark is "we have not looked yet". They must not render alike.
     */
    data_state: string;
    /** Why acquisition may be empty: `READY` | `NOT_CONNECTED` | `NEVER_SYNCED`. Never a refusal. */
    attribution_state: string;
    /**
     * Rendered one `<p>` each, KEYED BY THE STRING. Every entry must be unique — the page's banner is
     * currently always empty and is waiting for exactly these.
     */
    warnings: string[];
    diagnostics: CountryRollupDiagnostics;
    /**
     * The banner body on `NEVER_SYNCED`, and the only way the explanation survives the frontend's
     * gate: `dataState.js` intercepts that state, NULLS `data` — warnings and all — and renders
     * `data.unknown_reason || resp.msg`. Without this field that resolves to the SUCCESS message.
     */
    unknown_reason?: string;
}
