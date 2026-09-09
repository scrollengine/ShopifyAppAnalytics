/**
 * ============================================================================
 *  THE STORE ROSTER'S RESPONSE CONTRACT — every name a component reads
 * ============================================================================
 *
 *  Declarations only — `typeof import(…)` is erased at compile time, so importing this file costs
 *  nothing at run time and does NOT pull the constants module in.
 *
 *  The vocabulary unions live here rather than beside the values because
 *  `constants/storeRoster.constants` ends in an export assignment — which is what keeps its runtime
 *  surface a plain CommonJS object — and a module with an export assignment cannot export anything
 *  else, types included (TS2309). Each union is derived with `typeof` rather than restated, so a new
 *  member widens it automatically instead of leaving a hand-written copy one member short.
 *
 *  ── EVERY FIGURE ON A ROW IS A BARE VALUE, NEVER A `confidence.helper` ENVELOPE ────────────
 *
 *  `fmtMoney(envelope)` is `Number({…})` → `NaN` → an em dash; `pagination.total.toLocaleString()`
 *  throws outright. Wrapping these to satisfy the honesty rule MANUFACTURES the missing figure the
 *  rule exists to prevent. The contract is discharged instead through fields that survive rendering:
 *  `has_attribution`, `customer_name_source`, `state_basis`, `trial_days_source`, `has_install_record`,
 *  `install_state: 'UNKNOWN'`, `data_state`, `attribution_state`, `meta`, `diagnostics` and
 *  `warnings[]`. Envelopes belong on a coverage endpoint whose renderer is ours.
 * ============================================================================
 */

import type { AcquisitionChannel, StateBasis, StoreLifecycleState, TrialDaysSource } from '../../conversion/types/lifecycle.types';

type StoreConstants = typeof import('../constants/storeRoster.constants');
/**
 * The conversion module's lifecycle vocabulary, reached as a TYPE only.
 *
 * `typeof import(…)` is erased at compile time, so this creates no runtime dependency and no import
 * cycle — the runtime values come through that module's BARREL, which publishes exactly the pure
 * fold this one reuses. Deriving the union rather than restating `'join_miss'` is what keeps one
 * wire value from acquiring two spellings across the two endpoints that publish it.
 */
type ConversionLifecycleConstants = typeof import('../../conversion/constants/lifecycle.constants');

// ── Vocabulary unions ───────────────────────────────────────────────────────

/** `INSTALLED` | `UNINSTALLED` | `UNKNOWN`. Is the app on the store right now? */
export type StoreInstallState =
    StoreConstants['STORE_INSTALL_STATES'][keyof StoreConstants['STORE_INSTALL_STATES']];

/** Where the displayed `customer_name` came from. `domain` is a fallback, not a failure. */
export type StoreNameSource =
    StoreConstants['STORE_NAME_SOURCES'][keyof StoreConstants['STORE_NAME_SOURCES']];

/** The partner tier's own state — the roster itself. `READY` | `NEVER_SYNCED`. */
export type StoreDataState =
    StoreConstants['STORE_DATA_STATES'][keyof StoreConstants['STORE_DATA_STATES']];

/** Why attribution may be missing: `READY` | `NOT_CONNECTED` | `NEVER_SYNCED`. */
export type StoreAttributionState =
    StoreConstants['STORE_ATTRIBUTION_STATES'][keyof StoreConstants['STORE_ATTRIBUTION_STATES']];

/** A member of the sort allowlist. Widened to a literal union because the constant is a `string[]`. */
export type StoreRosterSortKey =
    'installed_at' | 'install_state_at' | 'latest_install_at' | 'customer_name'
    | 'shop_domain' | 'monthly_spend' | 'total_spend';

/** Sort direction. Nulls sort LAST in both, because a missing value is not an extreme one. */
export type StoreSortDirection = 'asc' | 'desc';

/** The facet groups this endpoint can evaluate. Every key here must have a predicate. */
export type StoreFacetGroupKey = keyof StoreConstants['STORE_FACET_GROUPS'];

/** The `state_basis` a ROW can carry: one of the three subscription bases, or the left-join miss. */
export type StoreStateBasis = StateBasis | ConversionLifecycleConstants['JOIN_MISS_STATE_BASIS'];

// ── The row ─────────────────────────────────────────────────────────────────

/**
 * One store, folded from the three collections that already hold it.
 *
 *  THERE IS NO `gi_stores` COLLECTION AND THERE MUST NOT BE ONE. Every field below is derived on
 * read, and that is the design rather than an implementation detail: a materialised roster stores a
 * derivable value, so its only possible relationship with truth is agreement or drift — and the
 * drift is invisible and directional. Store sync at 02:00, partner sync at 02:30, a shop uninstalls
 * at 02:15: `install_state: 'INSTALLED'` for twenty-four hours, on a page whose entire purpose is
 * "who has my app right now". The system this was extracted from carried an `uninstalled_at` that
 * three services READ to build INSTALLED/UNINSTALLED facets and that NOTHING ever WROTE; those
 * facets were silently wrong for the life of the product.
 *
 * ── HOW OPERATOR FIELDS ARRIVE LATER WITHOUT A BREAKING CHANGE ──────────────────────────────
 *
 * Four slots are already here and already published, holding the value they will hold on a store
 * nobody has pushed: `country: ''`, `country_name: ''`, `shopify_plan_name: ''` and
 * `operator: null`. When `gi_store_enrichments` lands, the ingest fills those slots and adds
 * `operator` as an object — a POPULATED key, never a NEW one — so no consumer's destructure changes
 * and no renderer has to learn a second shape. `customer_name_source` gains its fourth value
 * (`operator`) the same way, because it was published as a source from the first release rather than
 * being inferred from which field was non-empty.
 */
export interface StoreRosterRow {
    /**
     * The row identity, the join key and the link key. NEVER blank — a store that cannot be named
     * is excluded by the repository and counted, rather than pooled under a synthetic key.
     *
     * `pages/stores/index.js:319` overrides `rowKey` to this field.
     */
    shop_domain: string;
    /**
     * The Partner GID for the shop, e.g. `gid://partners/Shop/17`. `''` when no synced event carried
     * one.
     *
     * ⚠️ ONE OF THREE ID NAMESPACES, kept as three named fields rather than merged into a
     * `platform_id`: GA4's numeric `shop_id`, the Admin API's numeric id and this Partner GID are
     * different identifiers for the same shop, and merging them produces a field that is sometimes a
     * join key and sometimes garbage.
     */
    shop_id: string;

    /**
     * The name to render. NEVER BLANK — it falls back to `shop_domain`, which always exists.
     *
     * Resolved once, in `resolvers/storeField.resolver`, so no call site invents a second precedence.
     */
    customer_name: string;
    /** Which source won. Published so a reader never has to guess from the value. */
    customer_name_source: StoreNameSource;
    /**
     * The PARTNER API's `Shop.name` for this store, or `''`.
     *
     * `''` DOES NOT MEAN "THIS STORE HAS NO NAME" — `Shop.name` is non-null, so a shop without one
     * does not exist. It means no synced event for this store carries the column yet, which is what
     * `meta.shop_name_coverage_since` measures and what a LIFETIME re-sync fixes.
     */
    shop_name: string;

    /**
     * The MERCHANT'S REGISTERED COUNTRY as ISO-2, or `''`.
     *
     *  ALWAYS `''` ON THIS DEPLOYMENT, and that is a measurement, not a stub. The Partner API's
     * `Shop` object has exactly four fields — `id`, `name`, `myshopifyDomain`, `avatarUrl` — and no
     * query on any version returns a merchant's country. It is reachable only through an Admin API
     * session for the merchant's own shop, which this tool does not hold and must never hold.
     * `StoreTable._renderStore` renders this in a two-character slot as an ISO-2 code, so the one
     * country value this build DOES have (a GA4 common name) cannot be published here without
     * claiming to be a code it is not. `''` drops the line; see `install_country` for the value that
     * exists.
     */
    country: string;
    /** The readable name for `country`, rendered as its tooltip. `''` for the same reason. */
    country_name: string;
    /**
     * The country the INSTALL TRAFFIC came from — GA4's `geo.country` for the install event, as a
     * common NAME ("United States"). `''` when the store has no attribution record.
     *
     *  A DIFFERENT FACT FROM `country`, published under a different name and never merged with it.
     * This is the visitor's inferred geolocation on a server-side Measurement Protocol event; that
     * one is where the merchant registered their business. `bigQueryAnalytics.service.ts:325` already
     * draws this line for the rollup ("Traffic by country, NOT revenue by country") and a per-store
     * record has to draw it too, or it republishes a traffic figure under a merchant-identity label.
     *
     * Its coverage is bounded by attribution coverage, which `summary.attribution_coverage` publishes.
     */
    install_country: string;

    // ── Install state: the question this page exists to answer ──────────────
    install_state: StoreInstallState;
    /**
     * What the badge says. Normally the state's own label — but a DEACTIVATED store reads
     * "Deactivated" over an `UNINSTALLED` state, because the merchant did not uninstall.
     */
    install_state_label: string;
    /** When the deciding event happened. `null` only when there is no relationship event at all. */
    install_state_at: Date | null;
    /** The event type that decided the state, so the collapse above loses nothing. `''` when none. */
    install_state_event: string;
    /** FIRST install or reinstall. `null` for a store known only from a charge or a payout. */
    installed_at: Date | null;
    /** MOST RECENT install or reinstall. Equal to `installed_at` for a store that installed once. */
    latest_install_at: Date | null;
    /** Most recent UNINSTALL. `null` means "no uninstall event", NEVER "not uninstalled". */
    uninstalled_at: Date | null;
    /** Most recent DEACTIVATED — the shop froze or closed rather than uninstalling. */
    deactivated_at: Date | null;
    /** Installs plus reinstalls. A store that left and came back contributes more than one. */
    install_count: number;
    /** Whether ANY install/reinstall event exists. `false` ⇒ `installed_at` is null, not zero. */
    has_install_record: boolean;
    /**
     *  EXPLICITLY PRESENT ON EVERY ROW, and `null` — not `false` — when the install state is
     * UNKNOWN. `StoreTable._renderStatus` tests `row.store_active === false` and renders an
     * "Uninstalled" badge, so an absent field and a defaulted `false` both accuse a store we know
     * nothing about of having removed the app.
     */
    store_active: boolean | null;

    // ── Subscription lifecycle ──────────────────────────────────────────────
    /** One of the five lifecycle states. `INSTALLED` here means "never subscribed", not "installed". */
    state: StoreLifecycleState;
    state_label: string;
    /** Which evidence produced it, or `join_miss` for a store with no subscription at all. */
    state_basis: StoreStateBasis;
    /**
     * Our records show a paid plan, and the canonical MRR predicate says no payout is live now.
     *
     *  ON THE ROW AS WELL AS ON THE DETAIL RECORD, from ONE expression in
     * `resolvers/storeRow.resolver` that `storeDetailRecord.resolver` projects. The drawer opens
     * OVER the table row, so a "Billing stale" badge on the panel and nothing on the row underneath
     * it is the same disagreement `modules/conversion`'s barrel was widened to end —
     * `StoreTable._renderStatus` has always had the markup and never had the field.
     *
     * ⚠️ MEASURED, NOT ASSUMED: it requires payout evidence to exist, so a store with NO settled
     * payouts at all is `false` here. `false` means "not measured as stale", never "billing
     * confirmed" — read it beside `transaction_count` and `meta.earliest_transaction_at`.
     */
    billing_stale: boolean;
    /** `charge.name`. `''` when there is no subscription, which the table renders as an em dash. */
    plan_name: string;
    /** ⚠️ `plan_price`, NOT `price` — `StoreTable._renderPlan` reads this name. `null`, never `0`. */
    plan_price: number | null;
    /** `charge.amount.currencyCode`. `''` when no charge payload named one. */
    plan_currency: string;
    /**
     * The cadence, joined PER CHARGE and never per domain, so a charge-less subscription gets `null`
     * rather than borrowing another subscription's cadence.
     *
     * `null` STAYS `null`: the price sub-line is gated on it, so an unknown cadence correctly hides
     * the price instead of captioning it with an invented one.
     */
    plan_interval: string | null;
    /** Shopify's `charge.billingOn`.  NEVER an assumed 7 days — absent evidence renders as `—`. */
    trial_end: Date | null;
    trial_days_source: TrialDaysSource;
    conversion_date: Date | null;
    churn_date: Date | null;

    // ── Money ───────────────────────────────────────────────────────────────
    /**
     * The monthly run-rate as of the request's judgement instant, or `null` when the store has never
     * settled a subscription payout.
     *
     * Evaluated by `modules/revenue`'s `liveSetAsOf` — the canonical "who is paying us and how much"
     * predicate — so this figure and the Revenue page's cannot diverge. A store that used to pay and
     * has aged out of its billing window reads `0`, which is a measurement; a store that never paid
     * reads `null`, which is an absence.
     */
    monthly_spend: number | null;
    /**
     * Lifetime settled spend, gross, refunds included as negatives. `null` when this store has no
     * payout rows at all.
     *
     * ⚠️ Inherits the ledger's standing caveats verbatim: an unconverted-currency sum (see
     * `spend_currency`) and, for MRR specifically, the annual-interval normalisation.
     */
    total_spend: number | null;
    /**
     * The currency `total_spend` is denominated in, or `''` when this store's payouts arrived in more
     * than one and the sum is therefore of unlike units. There is no FX table in this build.
     */
    spend_currency: string;
    /** Settled payout rows for this store. `0` is measured once a sync has run. */
    transaction_count: number;
    first_payment_at: Date | null;
    last_payment_at: Date | null;

    // ── Acquisition ─────────────────────────────────────────────────────────
    /**  ALWAYS EXPLICIT. `false` means "no listing-analytics record", never "arrived directly". */
    has_attribution: boolean;
    /** Always populated: `UNKNOWN` at worst, which is labelled "Not attributed". */
    channel: AcquisitionChannel;
    channel_label: string;
    source: string;
    medium: string;
    campaign: string;
    /** `''` when there is no record; `'none'` when a record exists and named no scope. Two facts. */
    attribution_source: string;
    surface_type: string;
    surface_detail: string;
    surface_inter_position: number | null;
    surface_intra_position: number | null;
    /** The analytics install instant that was matched, so the match can be audited. */
    attribution_installed_at: Date | null;
    /**
     * SIGNED seconds: positive means the analytics record is later than Shopify's install instant.
     * The sign is half the diagnostic — a consistent lag one way is export latency, an inconsistent
     * one is a mismatched row. `null` when either side is missing.
     */
    attribution_lag_seconds: number | null;

    // ── Operator-pushed, and empty until the ingest wave lands ──────────────
    /**
     * The MERCHANT'S SHOPIFY PLAN TIER (`basic`, `shopify_plus`, …) — the strongest merchant-size
     * proxy a partner can hold, and provably unobtainable from the Partner API on any version.
     *
     * ⚠️ NOT `plan_name`, which is YOUR app's charge name. Two different plans, two different fields,
     * never one.
     */
    shopify_plan_name: string;
    /**
     * The operator-pushed profile for this store, or `null` when none has been pushed.
     *
     * ALWAYS `null` today: `gi_store_enrichments` does not exist yet. The key is published now so the
     * ingest wave fills a slot instead of adding one.
     */
    operator: null;
}

// ── Facets, counts and paging ───────────────────────────────────────────────

/** One option inside a facet group. `count` is over the roster BEFORE that group's own filter. */
export interface StoreFacetOption {
    value: string;
    label: string;
    count: number;
}

/**
 * One facet group, exactly as `SubscriptionFacetFilter` consumes it.
 *
 * The option list comes from the server so that "every option the server offers has a matching
 * predicate on the server" — a checkbox the backend cannot evaluate looks like it worked.
 */
export interface StoreFacetGroup {
    key: StoreFacetGroupKey;
    label: string;
    options: StoreFacetOption[];
}

/**
 * Install-state tallies, keyed by state, PLUS the `ALL` key the tab row and the search placeholder
 * both read.
 *
 * ⚠️ Every state key is present with a zero rather than omitted. A key missing because its count is
 * zero removes that tab's number entirely, which reads as "we did not measure it".
 */
export type StoreInstallStateCounts = Record<string, number>;

export interface StoreRosterPagination {
    page: number;
    limit: number;
    total: number;
    /** ⚠️ `pages`, NOT `total_pages` — `stores/index.js:162` reads this name. `0` on an empty result. */
    pages: number;
}

/** The filters as they were ACTUALLY applied, after fail-open validation dropped the unusable ones. */
export interface StoreRosterAppliedFilters {
    q: string;
    install_states: string[];
    states: string[];
    billing: string[];
    store_records: string[];
    store_statuses: string[];
    shopify_plans: string[];
}

/** Freshness and coverage figures for the page header. Bare values; `null` means "not measured". */
export interface StoreRosterMeta {
    last_synced_at: string | null;
    /**
     * When an operator enrichment push last landed. ALWAYS `null` today — the collection and its
     * watermark are the ingest wave.
     *
     *  A WATERMARK RATHER THAN A ROW COUNT, for the reason every other tier state here is: an empty
     * enrichment set is ambiguous between "never pushed" and "pushed and nothing came back", and only
     * a watermark separates them.
     */
    last_store_push_at: string | null;
    /** Distinct stores the Partner API has any record of. The roster's own size. */
    domains_seen: number;
    /** Stores carrying an operator profile. `0` today, and `0` is honest: none can exist yet. */
    enriched_stores: number;
    /** The floor of what the event record answers. An install before it is invisible, not absent. */
    earliest_event_at: string | null;
    /** The same floor for MONEY, tracked separately because payouts settle after the charge. */
    earliest_transaction_at: string | null;
    /** Until this is set, every all-time figure on this page is a FLOOR rather than a total. */
    lifetime_sync_completed_at: string | null;
    /** Oldest event carrying a `shop_name`. Above it, names exist; below it, rows show a domain. */
    shop_name_coverage_since: string | null;
}

/** Everything the reads excluded or could not resolve. Every number here is also a warning. */
export interface StoreRosterDiagnostics {
    /** Relationship events dropped for a blank `shop_domain`. They can join nothing. */
    shopless_relationship_events: number;
    /** Stores on the roster with no install/reinstall event — known from money or a charge alone. */
    stores_without_install_record: number;
    /** Attribution rows for domains the Partner API has no record of, so they became no row. */
    attribution_rows_without_partner_record: number;
    /** Stores whose payouts arrived in more than one currency, so `total_spend` sums unlike units. */
    stores_with_mixed_spend_currency: number;
    /** Rows shown as "On trial" on the weakest evidence. ⚠️ Warned about; never silent. */
    inferred_state_rows: number;
    /** Rows whose subscription state could not be mapped. A defect in this build, and reported so. */
    unclassified_subscription_rows: number;
    /** Subscription events skipped for carrying neither a charge id nor a shop domain. */
    skipped_keyless_subscription_events: number;
    /** Distinct test SUBSCRIPTIONS excluded. ⚠️ Asymmetric — relationship events carry no test flag. */
    test_subscriptions_excluded: number;
    /** Facet values and sort keys that were ignored, echoed so a typo is visible rather than empty. */
    unrecognised_filters: string[];
}

/** The response. Every empty state is a 200 carrying a reason, never a refusal and never a 404. */
export interface StoreRosterResponse {
    app_id: string;
    app_name: string;
    /** The ONE judgement instant this whole response was folded against. */
    as_of: string;

    items: StoreRosterRow[];
    pagination: StoreRosterPagination;
    sort: { key: StoreRosterSortKey; dir: StoreSortDirection };

    /**
     * Install-state tallies over the WHOLE roster, ignoring every filter. These label the tabs, so a
     * post-filter count would make every unselected tab read `(0)` the moment one is chosen.
     *
     * `null` is reserved for the escape ladder in `repositories/storeRoster.repository`: above the
     * point where folding the whole install base per request stops being comfortable, this endpoint
     * publishes `null` plus a reason and serves the paginated list alone.  It NEVER serves a
     * materialised count instead — a stale count is worse than an honest refusal.
     */
    install_state_counts: StoreInstallStateCounts | null;
    /** The same tallies with every OTHER facet applied, so a tab number predicts what clicking shows. */
    install_state_counts_filtered: StoreInstallStateCounts | null;
    facet_groups: StoreFacetGroup[];
    filters: StoreRosterAppliedFilters;

    meta: StoreRosterMeta;
    /** The five lifecycle labels, so the page and the server never spell a state two ways. */
    states: Record<string, string>;
    /** The three install-state labels, in the order the tab row expects. */
    install_states: Record<string, string>;

    data_state: StoreDataState;
    attribution_state: StoreAttributionState;
    warnings: string[];
    diagnostics: StoreRosterDiagnostics;
    /**
     * The banner body on `NEVER_SYNCED`, and the only way the explanation survives the frontend's
     * gate: `dataState.js` intercepts that state, NULLS `data` — warnings and all — and renders
     * `data.unknown_reason || resp.msg`. Without this field that resolves to the SUCCESS message.
     */
    unknown_reason?: string;
}

/**
 * The query bag, exactly as `frontend/API_Services/growth-intel/storeService.js` sends it.
 *
 * Everything is optional and everything is `unknown`-tolerant: the controller validates SHAPE, never
 * data, so any of these can arrive as a string, an array or junk. Validation here is FAIL-OPEN — an
 * unrecognised value widens the result and adds a warning, and never empties the table.
 */
export interface StoreRosterParams {
    partner_app_id?: string;
    page?: number | string;
    limit?: number | string;
    /** Free text over name, domain and plan. An empty result here IS an answer, so it is not fail-open. */
    q?: string;
    sort?: string;
    /** The page sends `dir`, not `sort_dir` — a different spelling from the install cohort's. */
    dir?: string;
    /** Comma-joined facet values. An omitted group constrains nothing. */
    install_states?: string;
    states?: string;
    billing?: string;
    store_records?: string;
    store_statuses?: string;
    shopify_plans?: string;
    /**
     * ⚠️ ACCEPTED AND DELIBERATELY IGNORED. The page's Refresh button sends it; there is no cache to
     * invalidate, because the roster is folded from the collections on every request. Documented in
     * the params so nobody wires a cache to it later and quietly makes this page stale.
     */
    refresh?: boolean | string;
    /**
     * ⚠️ ACCEPTED, IGNORED, AND WARNED ABOUT. `components/growth-intel/revenue/CountryView.js:230` links here
     * with an ISO-2 CODE, and the only per-store country this build holds is GA4's common NAME for
     * the install traffic. Matching them would need a code↔name mapping this build does not have, so
     * the filter is dropped with a warning that says exactly that rather than silently emptying the
     * table or, worse, silently matching nothing.
     */
    countries?: string;
}
