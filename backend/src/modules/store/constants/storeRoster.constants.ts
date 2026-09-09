'use strict';

/**
 * ============================================================================
 *  STORE ROSTER VOCABULARY — three install states, seven sort keys, six facet
 *  groups, and the sentinels that keep "not pushed" apart from "empty"
 * ============================================================================
 *
 *  Everything the Stores page agrees with the roster read about. Dependency-light by design: it
 *  imports the Partner event vocabulary and nothing else, so a repository (which needs the event-type
 *  lists for its `$in`), a resolver and a pure helper can all read it without dragging a layer
 *  sideways.
 *
 *  ── TWO THINGS IN THIS FILE ARE A FRONTEND CONTRACT, NOT A PREFERENCE ──────────────────────
 *
 *    1. `STORE_INSTALL_STATES` — EXACTLY three members, spelled exactly this way.
 *       `frontend/components/growth-intel/store/storePresentation.js:63` declares
 *       `INSTALL_STATE_LABELS = { INSTALLED, UNINSTALLED, UNKNOWN }` and `:69` the tone map, and
 *       `frontend/pages/stores/index.js:50` hard-codes the tab ids
 *       `['ALL','INSTALLED','UNINSTALLED','UNKNOWN']` and iterates THOSE. A fourth state appears in
 *       `install_state_counts` but in no tab, renders an untoned badge carrying its raw
 *       SCREAMING_SNAKE value, and breaks `sum(tabs) === total` on screen with no explanation.
 *
 *    2. `STORE_ROSTER_SORT_KEYS` — the page's Sort select is a fixed list at `index.js:38-46` and
 *       sends these seven values verbatim. A key removed here becomes a select option that silently
 *       does nothing; the fail-open validation turns it into a warning rather than an empty table.
 *
 *  ──  WHERE `DEACTIVATED` GOES, AND WHY IT IS NOT A FOURTH STATE ──────────────────────────
 *
 *  `partnerVocab.constants` states the rule this file has to satisfy: *"Any fold over install state
 *  that considers only INSTALL/UNINSTALL leaves every reactivated shop permanently uninstalled and
 *  every frozen shop permanently installed — both wrong, both silent."* So `RelationshipDeactivated`
 *  MUST end an installation. But the rendered vocabulary has three members and adding a fourth
 *  breaks the tab row above.
 *
 *  The resolution keeps both promises: a deactivated store's `install_state` is `UNINSTALLED` — the
 *  app is not live on that shop, which is the question the column asks — while its
 *  `install_state_label` is `Deactivated`, because the merchant did not uninstall and saying they
 *  did is a specific false claim about a named business. `StoreTable._renderInstallState` reads
 *  `row.install_state_label` FIRST and falls back to its own map, so the row tells the truth while
 *  the badge tone, the tab counts and the facet all keep working. `install_state_event` carries the
 *  event type that decided it, so nothing is lost to the collapse.
 * ============================================================================
 */

// `export =` module — a named import here is TS2497, so it is imported whole and destructured.
import partnerVocab = require('../../../constants/partnerVocab.constants');

const { PARTNER_EVENT_TYPES } = partnerVocab;

// ── Install state: is the app on this store right now? ──────────────────────

/**
 * Whether the app is on the store, replayed from the relationship events.
 *
 * ⚠️ A DIFFERENT VOCABULARY FROM THE FIVE LIFECYCLE STATES, and `INSTALLED` means a different thing
 * in each. There, it means "this store never subscribed"; here it means "the app is on the store
 * right now". A store can be one and not the other — converted and since uninstalled, or installed
 * for two years and never charged — which is why they are two columns and why one map for both
 * would make a single word mean two things. `storePresentation.js:58-61` says the same thing from
 * the other side of the wire.
 */
const STORE_INSTALL_STATES = Object.freeze({
    /** The most recent relationship event is an INSTALL or a REINSTALL. */
    INSTALLED: 'INSTALLED',
    /** The most recent one is an UNINSTALL or a DEACTIVATED. See the header for the collapse. */
    UNINSTALLED: 'UNINSTALLED',
    /**
     * NO relationship event has been synced for this store at all — it is known only from a charge
     * event or a settled payout.
     *
     *  NOT "the app is absent". It is an absence of EVIDENCE, and the commonest cause is an
     * incremental sync whose window began after the store installed. Rendered untoned and with a
     * tooltip saying exactly that.
     */
    UNKNOWN: 'UNKNOWN'
} as const);

/**
 * What each install state is called on screen. Published as the response's `install_states` map.
 *
 * Mirrors `storePresentation.js:63-67` word for word. The same store rendered from the server's map
 * in one place and the page's own map in another must not read two different ways.
 */
const STORE_INSTALL_STATE_LABELS = Object.freeze({
    INSTALLED: 'Installed',
    UNINSTALLED: 'Uninstalled',
    UNKNOWN: 'Install state unknown'
} as const);

/** The three in order, derived from the vocabulary so the two cannot drift. */
const STORE_INSTALL_STATE_ORDER = Object.freeze(Object.values(STORE_INSTALL_STATES));

/**
 * The per-ROW label override, keyed by the event that decided the state.
 *
 * Only `DEACTIVATED` has one, and it is the whole reason this map exists — see the header. Every
 * other event falls back to `STORE_INSTALL_STATE_LABELS`, which is what the page would have used
 * anyway.
 */
const STORE_INSTALL_STATE_EVENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
    [PARTNER_EVENT_TYPES.DEACTIVATED]: 'Deactivated'
});

/**
 * The key the counts map uses for "every store, no install-state filter".
 *
 * ⚠️ REQUIRED, not decorative. `stores/index.js:143` reads `countsFiltered.ALL` for the search
 * placeholder and `:277` for the "All" tab label; both silently withdraw their sentence when the key
 * is missing, so an absent `ALL` reads as a server that answered nothing.
 */
const ALL_COUNT_KEY = 'ALL';

// ── The events the roster is folded from ────────────────────────────────────

/**
 * The events that put a store ON the app. The `$min` of these is `installed_at`, the `$max` is
 * `latest_install_at`, and the count of them is `install_count`.
 *
 * `REINSTALL` IS NOT OPTIONAL — it is Shopify's `RelationshipReactivated`, and a roster built from
 * `INSTALL` alone reports every store that left and came back as permanently uninstalled.
 */
const STORE_INSTALL_EVENT_TYPES: readonly string[] = Object.freeze([
    PARTNER_EVENT_TYPES.INSTALL,
    PARTNER_EVENT_TYPES.REINSTALL
]);

/**
 * The events that take it OFF. `DEACTIVATED` is Shopify's `RelationshipDeactivated` — the shop was
 * frozen or closed rather than uninstalling — and it is here for the reason the header gives.
 */
const STORE_UNINSTALL_EVENT_TYPES: readonly string[] = Object.freeze([
    PARTNER_EVENT_TYPES.UNINSTALL,
    PARTNER_EVENT_TYPES.DEACTIVATED
]);

/**
 * The `$in` list for the roster's relationship-event pull: all four, deduped by hand.
 *
 * Declared here rather than in the resolver that folds them because the REPOSITORY needs it, and a
 * repository importing a resolver inverts the layer direction (services → resolvers → helpers →
 * constants; repositories are reached FROM services and resolvers, never the reverse).
 */
const STORE_RELATIONSHIP_EVENT_TYPES: readonly string[] = Object.freeze([
    ...STORE_INSTALL_EVENT_TYPES,
    ...STORE_UNINSTALL_EVENT_TYPES
]);

// ── Request shape: sort, paging, search ─────────────────────────────────────

/**
 * The sort allowlist. Anything else is a NO-OP PLUS A WARNING, never "match nothing".
 *
 * Same rule as the facets: an unrecognised value must WIDEN the result, not empty it. A table that
 * renders zero rows because of a typo in a query string is indistinguishable from a business with no
 * stores.
 */
const STORE_ROSTER_SORT_KEYS: readonly string[] = Object.freeze([
    'installed_at',
    'install_state_at',
    'latest_install_at',
    'customer_name',
    'shop_domain',
    'monthly_spend',
    'total_spend'
]);

/**
 * Applied when the caller names no sort, or names one outside the allowlist.
 *
 * ⚠️ `as const` is load-bearing, not decoration. Without it the literal widens to `string` inside the
 * `export =` object below, and a consumer assigning it to a `StoreRosterSortKey` stops compiling —
 * for a value that is spelled correctly right here.
 */
const DEFAULT_STORE_SORT_KEY = 'installed_at' as const;
/** Newest install first — the page's own default (`stores/index.js:157`). Same `as const` reason. */
const DEFAULT_STORE_SORT_DIR = 'desc' as const;

/** Page size when the caller asks for none. The page sends 25 (`stores/index.js:21`). */
const DEFAULT_LIMIT = 50;

/**
 * The largest page this endpoint will serve.
 *
 * Unlike the install cohort's 500 — which is a floor, because that table never paginates — this one
 * IS paginated by a real control, so the ceiling exists to bound one response rather than to satisfy
 * a client. A caller asking for more is clamped and TOLD, through `pagination` and a warning.
 */
const MAX_LIMIT = 500;

// ── Facet groups ────────────────────────────────────────────────────────────

/**
 * The facet groups this endpoint can evaluate, and the labels their chips carry.
 *
 *  EVERY GROUP PUBLISHED HERE MUST HAVE A PREDICATE. `SubscriptionFacetFilter` builds its
 * checkboxes from `facet_groups` in the response precisely so that "every option the server offers
 * has a matching predicate on the server" — a checkbox that ticks and changes nothing is worse than
 * a missing filter, because it looks like it worked.
 *
 * `countries` is DELIBERATELY ABSENT, and that is not an oversight. The only per-store country this
 * build holds is `gi_listing_install_attributions.country`, which is GA4's `geo.country` — a common
 * NAME ("United States") describing the INSTALL TRAFFIC — while the only producer of a `countries`
 * link is `components/growth-intel/revenue/CountryView.js:230`, which pushes
 * `/growth-intel/stores?countries=<CODE>`. A facet group whose values are names can never match a
 * code, so publishing one would render a filter that appears to work and never matches. The param is
 * accepted, ignored fail-open, and WARNED ABOUT with that reason.
 */
const STORE_FACET_GROUPS = Object.freeze({
    /** Is the app on the store right now. The tab row is a shortcut into this group. */
    install_states: 'Install state',
    /** The five subscription lifecycle states. Reuses the conversion module's vocabulary. */
    states: 'Status',
    /** Billing cadence, from a settled payout only — never inferred. */
    billing: 'Billing',
    /** Whether an operator profile has been pushed for this store. How you find what is left. */
    store_records: 'Store record',
    /** The operator's own Admin-API reachability verdict, as of when they observed it. */
    store_statuses: 'Store status',
    /** The merchant's SHOPIFY plan tier — operator-pushed, and nothing else can supply it. */
    shopify_plans: 'Shopify plan'
} as const);

/**
 * The two `store_records` values.
 *
 * They answer "what have I not pushed yet", which is the only question a self-hoster can act on
 * while a backfill script is running.
 */
const STORE_RECORD_FACETS = Object.freeze({
    HAS_OPERATOR_PROFILE: 'HAS_OPERATOR_PROFILE',
    NO_OPERATOR_PROFILE: 'NO_OPERATOR_PROFILE'
} as const);

const STORE_RECORD_FACET_LABELS = Object.freeze({
    HAS_OPERATOR_PROFILE: 'Operator profile pushed',
    NO_OPERATOR_PROFILE: 'No operator profile'
} as const);

/**
 *  THE EXPLICIT "NOT PUSHED" BUCKET, and it must appear in every operator-sourced facet group
 * even when — especially when — nothing has been pushed at all.
 *
 * Omitting unpushed stores from the `shopify_plans` group instead makes a SAMPLE look like a
 * complete plan mix: three stores on Shopify Plus with 9,997 stores omitted renders as "100% Plus".
 * The bucket keeps the denominator on screen.
 */
const NOT_PUSHED_FACET = 'NOT_PUSHED';
const NOT_PUSHED_FACET_LABEL = 'Not pushed';

/** Billing-cadence facet value for a subscription no settled payout has named a cadence for. */
const BILLING_INTERVAL_UNKNOWN = 'UNKNOWN';

/**
 * Readable labels for the cadences Shopify actually sends.
 *
 * ⚠️ `UNKNOWN` is "no settled payout has named one yet", NOT "monthly". `FIDELITY.md` §5 records
 * that booking a null interval as monthly is how an annual subscriber gets reported at twelve times
 * their true rate; the label says the unknown out loud so nobody fills it in later.
 */
const BILLING_INTERVAL_LABELS: Readonly<Record<string, string>> = Object.freeze({
    EVERY_30_DAYS: 'Monthly',
    ANNUAL: 'Annual',
    [BILLING_INTERVAL_UNKNOWN]: 'Cadence not settled yet'
});

// ── Tier states the response publishes ──────────────────────────────────────

/**
 * The state of the PARTNER tier, which is the roster itself.
 *
 * The discriminator is the WATERMARK (`gi_partner_apps.last_synced_at`), never the row count. No
 * rows plus a watermark is a real, publishable "nobody has ever installed this app"; no rows and no
 * watermark is "we have not looked yet", and the two must not render alike.
 *
 * Declared here rather than imported: `modules/bigquery` declares its own two-state `data_state`
 * inline for the same reason (`bigQueryAnalytics.types.ts:35`), so each module names the tier it is
 * actually reporting on and no module inherits another's idea of what has synced.
 */
const STORE_DATA_STATES = Object.freeze({
    READY: 'READY',
    NEVER_SYNCED: 'NEVER_SYNCED'
} as const);

/**
 * Why a row may carry `has_attribution: false` — three causes that render identically at row level
 * (which is correct) and must be separable at page level (which is what this is for).
 *
 * MIRRORED, NOT IMPORTED, and that is a known cost, restated here in the same form
 * `lifecycle.constants.UNRESOLVED_ATTRIBUTION_SOURCES` uses for the same situation: the values
 * belong to the LISTING tier, `modules/conversion` holds the only other copy
 * (`lifecycle.constants.ATTRIBUTION_STATES`), and neither module owns the fact. THE RIGHT FIX is to
 * promote them into `modules/shared/constants/` beside `surface.constants.ts` — which exists for
 * exactly this reason, "every READER needs the same classification" — and delete both copies. Until
 * then the source is named so a reader can diff the two by eye.
 *
 * NONE of them is a refusal: the roster is complete and correct without a single attribution row.
 */
const STORE_ATTRIBUTION_STATES = Object.freeze({
    /** The attribution sync has run; a row missing here genuinely has no listing-analytics record. */
    READY: 'READY',
    /** BigQuery is not configured at all. Nothing has ever been able to write attribution. */
    NOT_CONNECTED: 'NOT_CONNECTED',
    /** Configured, but `last_install_attrib_synced_at` is null — the job has never completed. */
    NEVER_SYNCED: 'NEVER_SYNCED'
} as const);

// ── Where a displayed store name came from ──────────────────────────────────

/**
 * The provenance of `customer_name`, published beside it on every row.
 *
 * The name is the ONE field where two sources can both legitimately answer (see
 * `resolvers/storeField.resolver`), so the winner is published rather than left to be guessed from
 * the value. `domain` is not a failure: it is the honest fallback, and it is never blank.
 */
const STORE_NAME_SOURCES = Object.freeze({
    /** An operator push. Cannot occur until the enrichment wave lands; the slot exists now. */
    OPERATOR: 'operator',
    /** `gi_partner_app_events.shop_name`, promoted out of `raw_event.shop.name`. */
    PARTNER: 'partner',
    /** `gi_listing_install_attributions.shop_name`, from the analytics `shop_name` param. */
    LISTING: 'listing',
    /** No name from anywhere. The row renders its domain, which is never blank. */
    DOMAIN: 'domain'
} as const);

export = {
    STORE_INSTALL_STATES,
    STORE_INSTALL_STATE_LABELS,
    STORE_INSTALL_STATE_ORDER,
    STORE_INSTALL_STATE_EVENT_LABELS,
    ALL_COUNT_KEY,
    STORE_INSTALL_EVENT_TYPES,
    STORE_UNINSTALL_EVENT_TYPES,
    STORE_RELATIONSHIP_EVENT_TYPES,
    STORE_ROSTER_SORT_KEYS,
    DEFAULT_STORE_SORT_KEY,
    DEFAULT_STORE_SORT_DIR,
    DEFAULT_LIMIT,
    MAX_LIMIT,
    STORE_FACET_GROUPS,
    STORE_RECORD_FACETS,
    STORE_RECORD_FACET_LABELS,
    NOT_PUSHED_FACET,
    NOT_PUSHED_FACET_LABEL,
    BILLING_INTERVAL_UNKNOWN,
    BILLING_INTERVAL_LABELS,
    STORE_DATA_STATES,
    STORE_ATTRIBUTION_STATES,
    STORE_NAME_SOURCES
};
