'use strict';

/**
 * ============================================================================
 *  THE SUBSCRIPTIONS LIST'S VOCABULARY — four statuses, seven sort keys, four
 *  facet groups, and the one sentence that says who is in the list
 * ============================================================================
 *
 *  Everything `GET /api/subscriptions` agrees with the Subscriptions page about. Dependency-light by
 *  design: it imports the roster vocabulary (whose install states, cadences and "not pushed"
 *  sentinel this list reuses verbatim) and nothing else, so a resolver, a pure helper and a service
 *  can all read it without dragging a layer sideways.
 *
 *  ──  THE POPULATION IS THE FIRST THING IN THIS FILE, BECAUSE IT IS THE FIRST THING A ────
 *     READER OF THE NUMBERS HAS TO KNOW
 *
 *  This list is "on a paid plan right now", decided by `modules/revenue`'s `liveSetAsOf` — the same
 *  predicate the Revenue page's MRR is built from. TWO GROUPS ARE ABSENT ENTIRELY, and neither
 *  appears as a row with a different status:
 *
 *    · stores that never subscribed;
 *    · stores that paid, then stopped — the churned.
 *
 *  So a count taken from here is NOT "our customers to date", and a trend built from it cannot show
 *  churn: the churned LEAVE the population rather than changing state within it.
 *  `frontend/API_Services/growth-intel/subscriptionService.js` says the same thing from the other
 *  side of the wire, and names `GET /api/stores` as the list whose population is every store ever.
 *  `POPULATION_STATEMENT` below is that sentence, published ON the response so the two lists can
 *  never be confused by a reader who only has the JSON.
 *
 *  ──  THREE THINGS HERE ARE A FRONTEND CONTRACT, NOT A PREFERENCE ────────────────────────
 *
 *    1. `SUBSCRIPTION_STATUSES` — EXACTLY four members, spelled exactly this way.
 *       `frontend/components/growth-intel/store/storePresentation.js` declares
 *       `SUBSCRIPTION_TABS = [ALL, PAYING, ON_TRIAL, CHURNED_DURING_TRIAL, CHURNED_AFTER_TRIAL]` and
 *       `pages/subscriptions/index.js` ITERATES THAT, reading `status_counts_filtered[id]`
 *       for each. A fifth status would appear in the counts, in no tab, with an untoned badge
 *       carrying its raw SCREAMING_SNAKE value, and would break `sum(tabs) === ALL` on screen with
 *       nothing to explain it. `types/subscriptionList.types.ts` carries a COMPILE-TIME proof that
 *       these four are exactly `modules/conversion`'s `SUBSCRIPTION_STATES`.
 *
 *    2. `SUBSCRIPTION_LIST_SORT_KEYS` — the page's Sort select is a fixed list of these seven values
 *       and sends them verbatim. A key removed here becomes a select option that silently does
 *       nothing; the fail-open validation turns it into a warning rather than an empty table.
 *
 *    3. `SUBSCRIPTION_FACET_GROUPS` — the page tracks exactly these four groups
 *       (`states`, `install_states`, `billing`, `store_statuses`) and its "Clear all filters" resets
 *       exactly these four. A fifth group would render a checkbox the page cannot clear.
 *
 *  ──  THE STATUS VOCABULARY IS MIRRORED, NOT IMPORTED, AND THAT IS A KNOWN COST ──────────
 *
 *  The values belong to `modules/conversion/constants/lifecycle.constants` (`SUBSCRIPTION_STATES`),
 *  and that module's BARREL does not publish them — it publishes the five LIFECYCLE states instead,
 *  because the install cohort is what needed them. Reaching into another module's constants by deep
 *  path is the layering violation this project checks for, so the labels are restated here with the
 *  source named, exactly as `storeRoster.constants.STORE_ATTRIBUTION_STATES` and
 *  `lifecycle.constants.UNRESOLVED_ATTRIBUTION_SOURCES` already do for the same situation.
 *
 *  ⚠️ THE MIRROR IS NOT BLIND. `types/subscriptionList.types.ts` derives the real union with
 *  `typeof import(…)` — erased at compile time, so no runtime dependency and no cycle — and asserts
 *  set equality in BOTH directions. A member added or renamed in `modules/conversion` fails the
 *  build here, naming this file. THE RIGHT FIX when someone is next in that module is to publish
 *  `SUBSCRIPTION_STATES` and `SUBSCRIPTION_STATE_LABELS` on its barrel and delete this block.
 * ============================================================================
 */

// `export =` modules — a named import here is TS2497, so they are imported whole and destructured.
import storeConstants = require('./storeRoster.constants');

const { STORE_FACET_GROUPS } = storeConstants;

// ── The four subscription statuses ──────────────────────────────────────────

/**
 * What one SUBSCRIPTION resolved to as of the judgement instant.
 *
 * ⚠️ A DIFFERENT VOCABULARY FROM THE FIVE LIFECYCLE STATES the Stores roster publishes, and the two
 * describe the same journey: `PAYING` is `CONVERTED`, `CHURNED_DURING_TRIAL` is `CHURNED_IN_TRIAL`,
 * `CHURNED_AFTER_TRIAL` is `CHURNED`. `storePresentation.js` gives every key of BOTH enums the same
 * badge tone for exactly that reason.
 *
 *  THERE IS NO `INSTALLED` MEMBER, and there must never be one. In the lifecycle vocabulary
 * `INSTALLED` is the left-join miss — "this store has no subscription we can find" — and a row on
 * THIS list is a store the payout ledger says is paying us right now. Publishing "Installed only"
 * beside a live monthly figure would contradict, one column apart, the predicate that put the row in
 * the list.
 */
const SUBSCRIPTION_STATUSES = Object.freeze({
    /** Approved, and Shopify's `billingOn` has not been reached as of the judgement instant. */
    ON_TRIAL: 'ON_TRIAL',
    /** Billing has begun and no end event has landed. */
    PAYING: 'PAYING',
    /** Ended on or before the conversion date — never billed. */
    CHURNED_DURING_TRIAL: 'CHURNED_DURING_TRIAL',
    /** Ended after billing began. */
    CHURNED_AFTER_TRIAL: 'CHURNED_AFTER_TRIAL'
} as const);

/**
 * What each status is called on screen. Published as the response's `statuses` map.
 *
 * Mirrors `storePresentation.js`'s `STORE_STATE_LABELS` word for word for these four keys. The same
 * subscription rendered from the server's map in the tab row and from the page's own map in the
 * badge must not read two different ways.
 */
const SUBSCRIPTION_STATUS_LABELS = Object.freeze({
    ON_TRIAL: 'On trial',
    PAYING: 'Paying',
    CHURNED_DURING_TRIAL: 'Churned during trial',
    CHURNED_AFTER_TRIAL: 'Churned after trial'
} as const);

/**
 * The four in TAB ORDER — which is NOT declaration order.
 *
 * ⚠️ `SUBSCRIPTION_TABS` renders `PAYING` first, and this array is what the facet group and the
 * status counts enumerate, zeros included. A status omitted because its count is zero removes that
 * tab's number entirely, which reads on screen as "we did not measure it" rather than as "it is
 * zero".
 *
 * `as const` is load-bearing: without it the members widen to `string` and the compile-time totality
 * proof in `types/subscriptionList.types.ts` cannot see them.
 */
const SUBSCRIPTION_STATUS_ORDER = Object.freeze([
    SUBSCRIPTION_STATUSES.PAYING,
    SUBSCRIPTION_STATUSES.ON_TRIAL,
    SUBSCRIPTION_STATUSES.CHURNED_DURING_TRIAL,
    SUBSCRIPTION_STATUSES.CHURNED_AFTER_TRIAL
] as const);

/**
 *  THE STATUS OF A ROW THE LEDGER PUT IN THE LIST AND THE EVENT RECORD CANNOT EXPLAIN.
 *
 * A member of the paying set with no synced subscription event — the commonest cause is an
 * incremental sync whose window began after the merchant subscribed — has settled a payout inside
 * its billing window and has no end signal. That is EXACTLY the evidence
 * `subscriptionState.helper`'s second branch classifies as `PAYING` on the basis `settled_payout`:
 * *"a settled `APP_SUBSCRIPTION` payout means money actually moved."*
 *
 * The alternatives are both worse and both are claims: a blank status leaves the tab counts short of
 * `ALL` with nothing to say why, and the lifecycle join-miss `INSTALLED` asserts the merchant never
 * subscribed while the row beside it shows what they pay. The rows are counted
 * (`diagnostics.ledger_only_rows`) and warned about, so the weaker footing is never silent.
 */
const LEDGER_ONLY_STATUS = SUBSCRIPTION_STATUSES.PAYING;

/**
 * The key the counts map uses for "every subscription, no status filter".
 *
 * ⚠️ REQUIRED, not decorative. `subscriptions/index.js` reads `countsFiltered.ALL` for the search
 * placeholder and for the "All" tab label; both silently WITHDRAW their sentence when the key is
 * missing, so an absent `ALL` reads as a server that answered nothing.
 *
 * Spelled the same as the roster's `ALL_COUNT_KEY` and declared separately rather than imported: it
 * is the same string because both pages have an "All" tab, not because one page inherits the other's
 * tab row.
 */
const ALL_COUNT_KEY = 'ALL';

// ── The population, said out loud ───────────────────────────────────────────

/**
 * The identifier for this list's population, published on every response.
 *
 * A key rather than only a sentence, so a consumer can BRANCH on it: a future endpoint that lists
 * "everyone we have ever billed" would carry a different key, and a chart that assumed the wrong one
 * would be a chart that erases churn by construction.
 */
const POPULATION_KEY = 'CURRENTLY_PAYING' as const;

/**
 *  THE SENTENCE THAT KEEPS THIS LIST FROM BEING READ AS "OUR CUSTOMERS".
 *
 * Published on the response beside every figure. It names the predicate, names the two groups that
 * are absent, and names the endpoint that DOES answer the other question — because the failure this
 * prevents is not a wrong number, it is a right number read against the wrong population.
 */
const POPULATION_STATEMENT = 'Every store on a paid plan RIGHT NOW: Shopify settled a subscription '
    + 'payout for it inside its current billing window, judged by the same predicate the Revenue '
    + 'page uses, so the two cannot disagree. A store that never subscribed is ABSENT, and so is a '
    + 'store that paid and then stopped — neither appears here with a different status, so a count '
    + 'taken from this list is not "our customers to date" and a trend built from it cannot show '
    + 'churn. GET /api/stores is the list whose population is every store ever.';

/** The short label for the population, for a heading or a chip. */
const POPULATION_LABEL = 'Currently on a paid plan';

// ── Request shape: sort, paging, search ─────────────────────────────────────

/**
 * The sort allowlist. Anything else is a NO-OP PLUS A WARNING, never "match nothing".
 *
 * Same rule as the facets: an unrecognised value must WIDEN the result, not empty it. A table that
 * renders zero rows because of a typo in a query string is indistinguishable from a business with no
 * paying customers — which is the single most alarming thing this dashboard could say by accident.
 *
 * ⚠️ These seven are the page's Sort select, verbatim. `activation_date`, `conversion_date` and
 * `churn_date` have no equivalent in the roster's own allowlist, which is why the two lists have two
 * allowlists and one comparator.
 */
const SUBSCRIPTION_LIST_SORT_KEYS: readonly string[] = Object.freeze([
    'activation_date',
    'conversion_date',
    'churn_date',
    'monthly_spend',
    'total_spend',
    'customer_name',
    'plan_name'
]);

/**
 * Applied when the caller names no sort, or names one outside the allowlist.
 *
 * ⚠️ `as const` is load-bearing, not decoration. Without it the literal widens to `string` inside the
 * `export =` object below, and a consumer assigning it to a `SubscriptionListSortKey` stops
 * compiling — for a value that is spelled correctly right here.
 */
const DEFAULT_SUBSCRIPTION_SORT_KEY = 'activation_date' as const;
/** Newest activation first — the page's own default. Same `as const` reason. */
const DEFAULT_SUBSCRIPTION_SORT_DIR = 'desc' as const;

/**
 * Page size when the caller asks for none. The page sends 25.
 *
 * ⚠️ Declared here rather than imported from `storeRoster.constants`, even though the two numbers
 * agree today. They are two endpoints' page bounds that happen to coincide, not one setting — and
 * sharing the constant would mean changing the Stores page size silently changed this one.
 */
const SUBSCRIPTION_DEFAULT_LIMIT = 50;

/** The largest page this endpoint will serve. A caller asking for more is clamped and TOLD. */
const SUBSCRIPTION_MAX_LIMIT = 500;

// ── Facet groups ────────────────────────────────────────────────────────────

/**
 * The facet groups this endpoint can evaluate, and the labels their chips carry.
 *
 *  EVERY GROUP PUBLISHED HERE MUST HAVE A PREDICATE. `SubscriptionFacetFilter` builds its
 * checkboxes from `facet_groups` in the response precisely so that "every option the server offers
 * has a matching predicate on the server" — a checkbox that ticks and changes nothing is worse than
 * a missing filter, because it looks like it worked.
 *
 * ⚠️ FOUR, NOT THE ROSTER'S SIX. `store_records` and `shopify_plans` are DELIBERATELY ABSENT: the
 * page initialises its filter state as `{ states, install_states, billing, store_statuses }` and its
 * "Clear all filters" resets exactly those four, so a fifth group would render a checkbox that the
 * Clear-all button silently cannot clear.
 *
 * The three shared labels are spelled exactly as `STORE_FACET_GROUPS` spells them — derived from it
 * rather than restated, so a chip cannot read "Install state" on one page and "Installed" on the
 * other.
 *
 * ⚠️ DECLARATION ORDER IS THE POPOVER ORDER. `Object.keys` on this frozen object is what the service
 * iterates, and it matches the order the page's own filter state declares its four groups in, so the
 * checkboxes appear where the reader expects them.
 */
const SUBSCRIPTION_FACET_GROUPS = Object.freeze({
    /** The four subscription statuses. The tab row is a shortcut into this group. */
    states: STORE_FACET_GROUPS.states,
    /** Is the app on the store right now. ⚠️ A store can be paying and uninstalled; that is real. */
    install_states: STORE_FACET_GROUPS.install_states,
    /** Billing cadence, from a settled payout only — never inferred. */
    billing: STORE_FACET_GROUPS.billing,
    /** The operator's own Admin-API reachability verdict, as of when they observed it. */
    store_statuses: STORE_FACET_GROUPS.store_statuses
} as const);

// ── Tier states the response publishes ──────────────────────────────────────

/**
 * The state of the PARTNER tier, which is where both the events and the payouts come from.
 *
 * The discriminator is the WATERMARK (`gi_partner_apps.last_synced_at`), never the row count.
 *
 *  AND NEVER `earliest_transaction_at`, which is TEMPTING AND WRONG on this endpoint above all
 * others. This list's entire population comes from the settled-payout ledger, so an empty ledger
 * renders as "you have no paying customers" — and it is exactly the wrong field to discriminate
 * with, because `partnerCoverage.repository` computes it as `$min(created_at)` OVER THE ROWS. It is
 * a row count in disguise: `null` means "no payout rows exist", which is the same value for "we have
 * never fetched any" and "we fetched and this app genuinely has none". The empty ledger is reported
 * through `warnings[]` instead, where it can say which of those it cannot tell apart.
 *
 * Declared here rather than imported for the reason `storeRoster.constants` gives for its own copy:
 * each module names the tier it is actually reporting on, and no module inherits another's idea of
 * what has synced.
 */
const SUBSCRIPTION_DATA_STATES = Object.freeze({
    READY: 'READY',
    NEVER_SYNCED: 'NEVER_SYNCED'
} as const);

export = {
    SUBSCRIPTION_STATUSES,
    SUBSCRIPTION_STATUS_LABELS,
    SUBSCRIPTION_STATUS_ORDER,
    LEDGER_ONLY_STATUS,
    ALL_COUNT_KEY,
    POPULATION_KEY,
    POPULATION_LABEL,
    POPULATION_STATEMENT,
    SUBSCRIPTION_LIST_SORT_KEYS,
    DEFAULT_SUBSCRIPTION_SORT_KEY,
    DEFAULT_SUBSCRIPTION_SORT_DIR,
    SUBSCRIPTION_DEFAULT_LIMIT,
    SUBSCRIPTION_MAX_LIMIT,
    SUBSCRIPTION_FACET_GROUPS,
    SUBSCRIPTION_DATA_STATES
};
