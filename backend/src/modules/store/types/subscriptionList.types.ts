/**
 * ============================================================================
 *  THE SUBSCRIPTIONS LIST'S RESPONSE CONTRACT — every name a component reads
 * ============================================================================
 *
 *  Declarations only — `typeof import(…)` is erased at compile time, so importing this file costs
 *  nothing at run time and does NOT pull the constants module in.
 *
 *  The vocabulary unions live here rather than beside the values because
 *  `constants/subscriptionList.constants` ends in an export assignment — which is what keeps its
 *  runtime surface a plain CommonJS object — and a module with an export assignment cannot export
 *  anything else, types included (TS2309). Each union is derived with `typeof` rather than restated,
 *  so a new member widens it automatically instead of leaving a hand-written copy one member short.
 *
 *  ──  THE ROW CARRIES `status` AND DELIBERATELY DOES NOT CARRY `state` ────────────────────
 *
 *  `StoreTable._renderStatus` reads `row.state || row.status` and `row.state_label ||
 *  row.status_label`. The fallback exists BECAUSE two endpoints feed that table in two vocabularies:
 *  the roster and the install cohort emit the five LIFECYCLE states, and this list emits the four
 *  SUBSCRIPTION states — which are the ids its own tabs, its own facet group and its own CSV export
 *  all speak.
 *
 *  Publishing `state` here as well would win that `||` and badge a row "Converted" underneath a tab
 *  that says "Paying": two vocabularies on one screen, one column apart. So `state` and `state_label`
 *  are the two — and the only two — fields of `StoreRosterRow` this row omits. Everything else is
 *  the SAME row object, which is what lets `StoreTable`, `useStoreDetailDrawer` and the CSV export
 *  work here with no change.
 *
 *  ── EVERY FIGURE ON A ROW IS A BARE VALUE, NEVER A `confidence.helper` ENVELOPE ────────────
 *
 *  `fmtMoney(envelope)` is `Number({…})` → `NaN` → an em dash; `pagination.total.toLocaleString()`
 *  throws outright and takes the page's whole footer with it. Wrapping these to satisfy the honesty
 *  rule MANUFACTURES the missing figure the rule exists to prevent. The contract is discharged
 *  instead through fields that survive rendering: `population`, `has_attribution`, `status_basis`,
 *  `trial_days_source`, `has_install_record`, `install_state: 'UNKNOWN'`, `data_state`,
 *  `attribution_state`, `meta`, `diagnostics` and `warnings[]`.
 * ============================================================================
 */

/**
 * ⚠️ TYPE-ONLY, so this creates no runtime dependency on `modules/conversion` and no import cycle.
 * `SubscriptionState` is that module's own union, derived from its constants — which is what makes
 * the two assertions below a real check on the mirrored vocabulary rather than a restatement of it.
 */
import type { StateBasis, SubscriptionState } from '../../conversion/types/lifecycle.types';
import type {
    StoreAttributionState,
    StoreFacetOption,
    StoreRosterRow,
    StoreSortDirection,
    StoreStateBasis
} from './storeRoster.types';

type SubscriptionConstants = typeof import('../constants/subscriptionList.constants');

// ── Vocabulary unions ───────────────────────────────────────────────────────

/** `PAYING` | `ON_TRIAL` | `CHURNED_DURING_TRIAL` | `CHURNED_AFTER_TRIAL`. */
export type SubscriptionStatus =
    SubscriptionConstants['SUBSCRIPTION_STATUSES'][keyof SubscriptionConstants['SUBSCRIPTION_STATUSES']];

/** The four facet groups this list publishes. ⚠️ A SUBSET of the roster's six. */
export type SubscriptionFacetGroupKey = keyof SubscriptionConstants['SUBSCRIPTION_FACET_GROUPS'];

/** A member of the sort allowlist. Widened to a literal union because the constant is a `string[]`. */
export type SubscriptionListSortKey =
    'activation_date' | 'conversion_date' | 'churn_date' | 'monthly_spend'
    | 'total_spend' | 'customer_name' | 'plan_name';

/** The population this list reports on. A KEY so a consumer can branch, not merely read. */
export type SubscriptionPopulationKey = SubscriptionConstants['POPULATION_KEY'];

/** The partner tier's own state. `READY` | `NEVER_SYNCED`, decided by the watermark. */
export type SubscriptionDataState =
    SubscriptionConstants['SUBSCRIPTION_DATA_STATES'][keyof SubscriptionConstants['SUBSCRIPTION_DATA_STATES']];

/** The validated facet selection for this list. Every group key present, `[]` when unconstrained. */
export type SubscriptionFacetSelection = Record<SubscriptionFacetGroupKey, string[]>;

// ── Compile-time proofs that the mirrored vocabulary is exactly the real one ─

/** Fails to instantiate unless `T` is exactly `true`. The mechanism behind both assertions below. */
type Assert<T extends true> = T;

/**
 *  COMPILE-TIME PROOF THAT EVERY REAL SUBSCRIPTION STATE HAS A STATUS HERE.
 *
 * `constants/subscriptionList.constants` MIRRORS `modules/conversion`'s `SUBSCRIPTION_STATES`,
 * because that module's barrel publishes the lifecycle vocabulary and not this one, and reaching in
 * by deep path is the layering violation this project checks for. A mirror is a copy, and a copy
 * rots — so this asserts the copy is complete. Add a fifth state in `modules/conversion` and the
 * build fails HERE, naming the file that has to learn it, instead of that state arriving on a row
 * with no label, no tab and no facet option.
 *
 * Exported so `noUnusedLocals` cannot delete the guard as dead weight.
 */
export type AssertEverySubscriptionStateHasAStatus = Assert<
    [SubscriptionState] extends [SubscriptionStatus] ? true : false
>;

/**
 *  COMPILE-TIME PROOF THAT THIS FILE INVENTS NO STATUS OF ITS OWN.
 *
 * The other direction, and it is not redundant: a status published here that `modules/conversion`
 * cannot produce would be a tab that can never have a row in it, and a facet option that always
 * counts zero. In particular it is what forbids adding `INSTALLED` to "fill in" a store with no
 * subscription record — the lifecycle join-miss means "this store never subscribed", which on a list
 * of merchants who are paying us right now is a specific false claim about a named business.
 */
export type AssertNoInventedSubscriptionStatus = Assert<
    [SubscriptionStatus] extends [SubscriptionState] ? true : false
>;

/**
 *  COMPILE-TIME PROOF THAT THE TAB ORDER IS TOTAL.
 *
 * `SUBSCRIPTION_STATUS_ORDER` is what the status counts and the `states` facet group enumerate,
 * zeros included. A status present in the vocabulary and missing from the order would be counted
 * nowhere: its tab would carry no number, which reads as "we did not measure it", and
 * `sum(tabs) === ALL` would silently stop holding.
 */
export type AssertEveryStatusIsOrdered = Assert<
    [SubscriptionStatus] extends [SubscriptionConstants['SUBSCRIPTION_STATUS_ORDER'][number]] ? true : false
>;

// ── The row ─────────────────────────────────────────────────────────────────

/**
 * One merchant who is paying you right now, and what they are paying for.
 *
 *  `Omit<StoreRosterRow, 'state' | 'state_label'>` — THE ONLY TWO FIELDS THAT DIFFER, and the
 * omission is the point. Every other field is the same field, produced by the same
 * `resolvers/storeRow.resolver` from the same fold, so the two lists cannot describe one merchant
 * two ways: the same `monthly_spend`, the same `plan_interval`, the same `install_state`, the same
 * acquisition block, the same nulls in the same places. Re-declaring them here would create a second
 * list of fields that can quietly fall behind — a column the Stores table gained and this one did
 * not. See this file's header for why `state` in particular must be absent rather than translated.
 */
export interface SubscriptionListRow extends Omit<StoreRosterRow, 'state' | 'state_label'> {
    /**
     * The SUBSCRIPTION lifecycle, in the vocabulary this page's tabs, facet group and CSV export all
     * speak.
     *
     * ⚠️ NOT ALWAYS `PAYING`, even though every row here is paying by the ledger. A merchant who
     * cancelled three days into a cycle they already paid for is `CHURNED_AFTER_TRIAL` and is still
     * on this list until that cycle runs out — which is the honest reading, and the reason the page
     * has four tabs rather than one.
     */
    status: SubscriptionStatus;
    /** What the badge says. Always populated, so a client never has to hold its own label map. */
    status_label: string;
    /**
     * WHICH EVIDENCE produced `status`.
     *
     * ⚠️ Never `join_miss`, unlike the roster's `state_basis`: a row with no subscription record at
     * all is classified from the settled-payout ledger, so its basis is `settled_payout` — the same
     * value `subscriptionState.helper` uses for the same evidence.
     */
    status_basis: StateBasis;
    /**
     *  TRUE WHEN THE LEDGER PUT THIS ROW HERE AND THE EVENT RECORD CANNOT EXPLAIN IT.
     *
     * Shopify settled a payout for this store inside its billing window, and no
     * `SUBSCRIPTION_CHARGE_ACCEPTED` / `ACTIVATED` event has been synced for it — normally an
     * incremental sync whose window began after the merchant subscribed. `plan_name`, `plan_price`,
     * `activation_date`, `conversion_date`, `trial_end` and `churn_date` are all empty on such a row
     * and that is an absence of evidence, NOT a free plan and NOT a missing trial.
     *
     * Published per row rather than left to be inferred from a blank `plan_name`, which would also
     * be blank for a subscription whose charge payload simply named no plan.
     */
    ledger_only: boolean;
    /**
     * When this subscription STARTED — the earliest `SUBSCRIPTION_CHARGE_ACCEPTED` / `ACTIVATED`
     * event for the winning charge.
     *
     * ⚠️ `null` on a `ledger_only` row, and NOT back-filled from `first_payment_at`. The first
     * settled PAYOUT is a different instant from the activation — it is later by however long
     * Shopify took to settle — and the page's default sort is this column, so an invented value here
     * would silently reorder the whole list around a date nobody measured.
     */
    activation_date: Date | null;
    /**
     * True when the trial ended before the planned billing date arrived, so `conversion_date` names
     * a date that never happened.
     *
     * `StoreTable`'s `conversion_date` cell renders a struck-through date for this rather than
     * hiding it, so the intent stays visible. Requires a `conversion_date` to exist: there is nothing
     * to strike through otherwise.
     */
    conversion_date_voided: boolean;
    /**
     * The `state_basis` this store carries on the Stores roster — `join_miss` when it has no
     * subscription at all.
     *
     * Kept beside `status_basis` rather than replacing it so the two pages' provenance can be
     * compared directly. They differ ONLY on a `ledger_only` row, which is exactly the row worth
     * being able to spot.
     */
    roster_state_basis: StoreStateBasis;
}

// ── Facets, counts and paging ───────────────────────────────────────────────

/**
 * One facet group, exactly as `SubscriptionFacetFilter` consumes it.
 *
 * The option list comes from the server so that "every option the server offers has a matching
 * predicate on the server" — a checkbox the backend cannot evaluate looks like it worked.
 */
export interface SubscriptionFacetGroup {
    key: SubscriptionFacetGroupKey;
    label: string;
    /** ⚠️ `count` is over the rows that pass every OTHER group — never this group's own selection. */
    options: StoreFacetOption[];
}

/**
 * Status tallies, keyed by status, PLUS the `ALL` key the tab row and the search placeholder read.
 *
 * ⚠️ Every status key is present with a zero rather than omitted. A key missing because its count is
 * zero removes that tab's number entirely, which reads as "we did not measure it".
 */
export type SubscriptionStatusCounts = Record<string, number>;

export interface SubscriptionListPagination {
    page: number;
    limit: number;
    total: number;
    /** ⚠️ `pages`, NOT `total_pages` — the page reads this name. `0` on an empty result. */
    pages: number;
}

/** The filters as they were ACTUALLY applied, after fail-open validation dropped the unusable ones. */
export interface SubscriptionListAppliedFilters {
    q: string;
    states: string[];
    install_states: string[];
    billing: string[];
    store_statuses: string[];
}

/**
 *  WHO IS IN THIS LIST, PUBLISHED ON EVERY RESPONSE.
 *
 * The failure this exists to prevent is not a wrong number — it is a right number read against the
 * wrong population. "1,204 subscriptions" is a true statement about merchants paying today and a
 * false one about customers to date, and nothing else on the wire distinguishes them.
 */
export interface SubscriptionListPopulation {
    /** `CURRENTLY_PAYING`. A key so a consumer can branch, not merely display. */
    key: SubscriptionPopulationKey;
    label: string;
    /** The full sentence, naming the predicate, the two absent groups, and the endpoint that has them. */
    statement: string;
    /**
     * The live window in days for a NON-ANNUAL cadence — how recently Shopify must have billed a
     * shop for it to count as paying. Annual charges get their own, wider window.
     *
     * Published because it is a MEASUREMENT DECISION, not a tunable: widen it and merchants join this
     * list; narrow it and they leave it, having done nothing.
     */
    live_window_days: number;
    /**
     * Who the fold saw and this list does not show.  These reconcile EXACTLY:
     *
     *     stores_known === status_counts.ALL
     *                    + never_settled_a_subscription
     *                    + settled_but_not_paying_now
     *
     * so a reader can CHECK the population rather than trust it.
     *
     * ⚠️ Against `status_counts.ALL` and NOT against `pagination.total`, which is post-filter and
     * post-search. The identity is about the POPULATION; a reader with a status tab selected would
     * otherwise find it broken and go looking for a bug that is not there.
     */
    excluded: SubscriptionPopulationExclusions;
}

/** The two ways a store the fold knows about fails to be a paying customer today. */
export interface SubscriptionPopulationExclusions {
    /** Every store the Partner API has any record of — the Stores page's own population. */
    stores_known: number;
    /**
     * Stores with no settled subscription payout EVER. They never subscribed, or they subscribed and
     * nothing has settled yet. ⚠️ Their `monthly_spend` on the roster is `null`, not `0`.
     */
    never_settled_a_subscription: number;
    /**
     * Stores that settled a subscription payout once and have since aged out of their billing
     * window. This is the CHURN this list cannot show, counted so its absence is at least visible.
     */
    settled_but_not_paying_now: number;
}

/** Freshness and coverage figures. Bare values; `null` means "not measured". */
export interface SubscriptionListMeta {
    last_synced_at: string | null;
    /** The floor of what the event record answers. A subscription before it is invisible, not absent. */
    earliest_event_at: string | null;
    /**
     * The floor for MONEY, and on THIS endpoint it is the load-bearing one: the population is the
     * payout ledger, so a null here means every row on this page came from nothing.
     *
     * ⚠️ NOT a watermark — `partnerCoverage.repository` computes it as `$min(created_at)` over the
     * rows — so it can never be the discriminator for `data_state`. See the constants file.
     */
    earliest_transaction_at: string | null;
    /** Until this is set, this list is a FLOOR rather than a total. */
    lifetime_sync_completed_at: string | null;
    /** Oldest event carrying a `shop_name`. Above it names exist; below it rows show a domain. */
    shop_name_coverage_since: string | null;
    /** Distinct stores the Partner API has any record of — the fold's own size, before membership. */
    domains_seen: number;
}

/** Everything the read excluded or could not resolve. Every number here is also a warning. */
export interface SubscriptionListDiagnostics {
    /**
     * Rows listed on the ledger's word alone, with no synced subscription event. Their plan and
     * activation columns are blank and their status is `PAYING` on the basis `settled_payout`.
     */
    ledger_only_rows: number;
    /**
     * Rows whose STATUS came from the state machine's one guessing branch — no billing date and no
     * settled payout against that charge.
     *
     * ⚠️ Their MEMBERSHIP is still measured: money moved, which is what put them on this list. It is
     * only the status beside the money that is inferred, which is exactly why it is counted
     * separately rather than folded into `ledger_only_rows`.
     */
    inferred_status_rows: number;
    /**
     *  Domains the paying set names that the roster produced NO ROW for. Structurally impossible
     * today — every settled `APP_SUBSCRIPTION` payout also lands in the all-type spend rollup, which
     * is one of the three sources of the population — and counted anyway, because a fold that
     * silently drops a paying customer is the one defect this endpoint must never have.
     */
    paying_domains_without_a_row: number;
    /** Stores on this list with no install/uninstall event. ⚠️ Not evidence the app is absent. */
    stores_without_install_record: number;
    /** Stores whose payouts arrived in more than one currency, so `total_spend` sums unlike units. */
    stores_with_mixed_spend_currency: number;
    /** Rows whose subscription state could not be mapped. A defect in this build, reported as one. */
    unclassified_subscription_rows: number;
    /** Subscription events skipped for carrying neither a charge id nor a shop domain. */
    skipped_keyless_subscription_events: number;
    /** Distinct test SUBSCRIPTIONS excluded. ⚠️ Asymmetric — relationship events carry no test flag. */
    test_subscriptions_excluded: number;
    /** Facet values and sort keys that were ignored, echoed so a typo is visible rather than empty. */
    unrecognised_filters: string[];
}

/** The response. Every empty state is a 200 carrying a reason, never a refusal and never a 404. */
export interface SubscriptionListResponse {
    app_id: string;
    app_name: string;
    /** The ONE judgement instant this whole response was folded against. */
    as_of: string;

    /**  READ THIS BEFORE READING THE NUMBERS. See {@link SubscriptionListPopulation}. */
    population: SubscriptionListPopulation;

    /** ⚠️ An ARRAY, always — `dataState.js` decodes `items === null` as NEVER_SYNCED. */
    items: SubscriptionListRow[];
    pagination: SubscriptionListPagination;
    sort: { key: SubscriptionListSortKey; dir: StoreSortDirection };

    /**
     * Status tallies over the WHOLE list, ignoring every filter. These label the tabs, so a
     * post-filter count would make every unselected tab read `(0)` the moment one is chosen.
     */
    status_counts: SubscriptionStatusCounts;
    /** The same tallies with every OTHER facet applied, so a tab number predicts what clicking shows. */
    status_counts_filtered: SubscriptionStatusCounts;
    facet_groups: SubscriptionFacetGroup[];
    filters: SubscriptionListAppliedFilters;

    meta: SubscriptionListMeta;
    /** The four status labels, so the page and the server never spell a status two ways. */
    statuses: Record<string, string>;
    /** The three install-state labels, shared verbatim with the Stores roster. */
    install_states: Record<string, string>;

    data_state: SubscriptionDataState;
    /**
     * Why acquisition may be empty: `READY` | `NOT_CONNECTED` | `NEVER_SYNCED`.
     *
     *  NEVER A REFUSAL. This list comes from the Partner API's payout ledger and is complete
     * without a single attribution row; only the "Came from" column is empty, and it says so with
     * "Not attributed" rather than with "Direct".
     */
    attribution_state: StoreAttributionState;
    warnings: string[];
    diagnostics: SubscriptionListDiagnostics;
    /**
     * The banner body on `NEVER_SYNCED`, and the only way the explanation survives the frontend's
     * gate: `dataState.js` intercepts that state, NULLS `data` — warnings and all — and renders
     * `data.unknown_reason || resp.msg`. Without this field that resolves to the SUCCESS message.
     */
    unknown_reason?: string;
}

/**
 * The query bag, exactly as `frontend/API_Services/growth-intel/subscriptionService.js` sends it.
 *
 * Everything is optional and everything is `unknown`-tolerant: the controller validates SHAPE, never
 * data, so any of these can arrive as a string, an array or junk. Validation here is FAIL-OPEN — an
 * unrecognised value widens the result and adds a warning, and never empties the table.
 */
export interface SubscriptionListParams {
    partner_app_id?: string;
    page?: number | string;
    limit?: number | string;
    /** Free text over name, domain and plan. An empty result here IS an answer, so it is not fail-open. */
    q?: string;
    sort?: string;
    /** The page sends `dir`, not `sort_dir` — the same spelling the Stores page uses. */
    dir?: string;
    /** Comma-joined SUBSCRIPTION statuses. The tab row is a shortcut into this group. */
    states?: string;
    install_states?: string;
    billing?: string;
    store_statuses?: string;
    /**
     * ⚠️ ACCEPTED AND DELIBERATELY IGNORED. The page's Refresh button sends it; there is no cache to
     * invalidate, because the list is folded from the collections on every request. Named here so
     * nobody wires a cache to it later and quietly makes this page stale.
     */
    refresh?: boolean | string;
}

/** What `resolvers/subscriptionRow.resolver` is handed for one paying store. */
export interface SubscriptionRowInput {
    /** The roster row, already built by `resolvers/storeRow.resolver`. The SAME row the Stores page shows. */
    row: StoreRosterRow;
    /**
     * The store's winning subscription, or nothing at all.
     *
     * ABSENT IS A REAL CASE and it is the one this row type exists to handle honestly: a merchant
     * whose payouts we hold and whose subscription events we do not.
     */
    subscription?: SubscriptionEvidence;
}

/**
 * The subset of `CohortSubscription` this projection reads.
 *
 * Structural rather than the imported type so the resolver stays exercisable from literals in a test
 * — and so it is obvious at a glance that the projection reads four fields and invents none.
 */
export interface SubscriptionEvidence {
    /** The SUBSCRIPTION state as of the judgement instant. */
    state: SubscriptionState;
    /** Which evidence produced it. ⚠️ Warn on `inferred`; it is the one branch that guesses. */
    state_basis: StateBasis;
    /** `null` only if a subscription state ever loses its mapping — never defaulted to `INSTALLED`. */
    lifecycle_state: string | null;
    /** The earliest START event in the bucket. This list publishes it as `activation_date`. */
    trial_start: Date;
}
