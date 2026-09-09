'use strict';

/**
 * ============================================================================
 *  REVENUE COUNTRY — the vocabulary of a whole-population rollup
 * ============================================================================
 *
 *  ── ⚠️ BE HONEST ABOUT WHERE "COUNTRY" COMES FROM ───────────────────────────────────────────
 *
 *  The Partner API's `Shop` object has exactly FOUR fields — `id`, `name`, `myshopifyDomain`,
 *  `avatarUrl` — and carries NO COUNTRY AT ALL, on any API version. A merchant's registered trading
 *  country is reachable only through an Admin API session for their own shop, which this tool does
 *  not hold and must never hold. `StoreRosterRow.country` is therefore `''` on every row of every
 *  deployment, and that is a measurement rather than a stub.
 *
 *  The ONE per-store country this build records is `install_country`: GA4's `geo.country` for the
 *  install event — where the INSTALL TRAFFIC came from, inferred from a visitor's IP. It is NOT the
 *  merchant's trading country, it is bounded by attribution coverage, and a merchant who trades from
 *  somewhere other than where they installed is counted where they installed. Every label, every
 *  warning and the page's own closing sentence say exactly that, because copy describing a source the
 *  reader cannot inspect is worse than no copy — it sends them looking for a table that is not in the
 *  schema.
 *
 *  ──  AND THE REMAINDER IS PUBLISHED, NEVER DROPPED ────────────────────────────────────────
 *
 *  A store whose install carried no geo — no attribution record, an unconfigured listing tier, a
 *  sync that never ran — goes into an EXPLICIT `UNKNOWN` row. Dropping those rows is the defect this
 *  vocabulary exists to prevent: the per-country column silently stops summing to the headline
 *  revenue figure, the Revenue page and this page disagree, and there is no visible cause. With the
 *  remainder present, `sum(items) === totals` holds by construction and the gap is a row a reader can
 *  point at.
 * ============================================================================
 */

import storeConstants = require('./storeRoster.constants');

const { STORE_FACET_GROUPS } = storeConstants;

/**
 * The remainder bucket's code.
 *
 * ⚠️ THIS EXACT STRING IS A RENDERING CONTRACT. `components/growth-intel/store/CountryTable.js`
 * tests `row.country !== 'UNKNOWN'` before printing the ISO code chip beside the name — so any other
 * sentinel makes the remainder row render the literal word twice, once as its name and once as its
 * code.
 */
const UNKNOWN_COUNTRY_CODE = 'UNKNOWN';

/**
 * What the remainder row is called on screen.
 *
 * "Unknown", not "Other" and not "Rest of world": those two both assert that the stores in the bucket
 * are somewhere ELSE, which is a claim about geography. This one says only that we do not know, which
 * is the fact.
 */
const UNKNOWN_COUNTRY_LABEL = 'Unknown';

/**
 * The sort allowlist. Anything else is a NO-OP PLUS A WARNING, never "match nothing".
 *
 * ⚠️ THE FIRST NINE ARE THE PAGE'S OWN `SORT_OPTIONS`, in its order and with its spellings
 * (`components/growth-intel/revenue/CountryView.js`). A key removed here becomes a Select option that silently
 * does nothing; the fail-open validation turns that into a warning rather than an empty table.
 * `net_revenue` is accepted beyond them because the column exists — a server that accepts more than
 * the page offers is harmless, while the reverse is a checkbox that lies.
 */
const COUNTRY_SORT_KEYS: readonly string[] = Object.freeze([
    'paying',
    'mrr',
    'stores',
    'installed',
    'conversion_rate',
    'trialing',
    'ever_paid',
    'total_spend',
    'country_name',
    'net_revenue'
]);

/**
 * ⚠️ PAYING CUSTOMERS, NOT STORE COUNT, and `as const` is load-bearing — without it the literal
 * widens to `string` inside the `export =` below and a consumer assigning it to the sort-key union
 * stops compiling.
 *
 * Ranking by store volume buries a small market that converts well underneath a large one that never
 * pays, which is the exact comparison this page exists to make. The page defaults its own Select to
 * `paying` for the same reason; the two are deliberately the same value.
 */
const DEFAULT_COUNTRY_SORT_KEY = 'paying' as const;
/** Biggest first — the reading order the page's copy assumes. */
const DEFAULT_COUNTRY_SORT_DIR = 'desc' as const;

/**
 * The facet groups this endpoint evaluates, and the labels their chips carry.
 *
 * ⚠️ FIVE OF THE ROSTER'S SIX, and the five are not a taste: `EMPTY_FACETS` in
 * `components/growth-intel/revenue/CountryView.js` declares exactly these keys and `fetchData` sends exactly
 * these params. Publishing `shopify_plans` as a sixth would draw a checkbox whose selection the page
 * drops on "Clear all" — a filter that ticks, applies, and then cannot be removed the way every other
 * one can.
 *
 *  THE LABELS ARE READ FROM `STORE_FACET_GROUPS`, never restated. One group label spelled two ways
 * on two pages reads as two different filters.
 *
 * `countries` is DELIBERATELY ABSENT and is refused with a warning if sent — filtering countries on
 * the countries page would remove the very rows being compared against each other. The page's own
 * comment says the same thing from the other side of the wire.
 */
const COUNTRY_FACET_GROUP_KEYS = Object.freeze([
    'install_states',
    'states',
    'billing',
    'store_records',
    'store_statuses'
] as const);

/** The labels, derived so this endpoint and the roster cannot name one filter two things. */
const COUNTRY_FACET_GROUPS: Readonly<Record<string, string>> = Object.freeze({
    install_states: STORE_FACET_GROUPS.install_states,
    states: STORE_FACET_GROUPS.states,
    billing: STORE_FACET_GROUPS.billing,
    store_records: STORE_FACET_GROUPS.store_records,
    store_statuses: STORE_FACET_GROUPS.store_statuses
});

/**
 * The provenance sentence published on every response.
 *
 * ⚠️ ON THE PAYLOAD rather than only in the page's footer, because the payload is what an API
 * consumer, an export and a future second renderer will see — and the one thing none of them may
 * assume is that this column means "where the merchant trades".
 */
const COUNTRY_SOURCE_BASIS = 'The country the INSTALL TRAFFIC came from, recorded by listing analytics '
    + '(GA4 geo.country) against each install. It is NOT the merchant\'s registered trading country: the '
    + 'Partner API Shop object has no country field on any version, so this build stores none. A merchant '
    + 'who trades from somewhere other than where they installed is counted where they installed, and '
    + 'coverage is bounded by install attribution — every store without an attribution record is in the '
    + 'Unknown row rather than dropped.';

export = {
    UNKNOWN_COUNTRY_CODE,
    UNKNOWN_COUNTRY_LABEL,
    COUNTRY_SORT_KEYS,
    DEFAULT_COUNTRY_SORT_KEY,
    DEFAULT_COUNTRY_SORT_DIR,
    COUNTRY_FACET_GROUP_KEYS,
    COUNTRY_FACET_GROUPS,
    COUNTRY_SOURCE_BASIS
};
