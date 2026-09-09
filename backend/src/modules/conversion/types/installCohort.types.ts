/**
 * ============================================================================
 *  THE `GET /api/funnel/install-cohort` RESPONSE — a FROZEN frontend contract
 * ============================================================================
 *
 *  Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 *  Derived from what `frontend/components/growth-intel/InstallCohortTable.js` and the shared
 *  `store/StoreTable.js` ACTUALLY READ, field by field, not from what an upstream service happened
 *  to emit. Every name here is load-bearing: a renamed key does not error, it blanks a column.
 *
 *  ────  EVERY NUMBER IN `summary` IS A BARE NUMBER ───────────────────────────────────────────
 *
 *  Not a `confidence.helper` envelope. Not `{ value, confidence }`. A bare `number`.
 *
 *  This is the one place in this codebase where `IMPLEMENTATION.md` §3.11 must NOT be applied, and
 *  the reason is that applying it deletes the honesty statement it exists to protect:
 *
 *    - `fmtNum` (`store/storePresentation.js:250`) does `Number(n)`. `Number({value: 412})` is
 *      `NaN`, so an enveloped `summary.installs` renders as an em dash — in the headline caption,
 *      in the state strip, and inside the attribution banner's own sentence.
 *    - `InstallCohortTable.js:133` gates the ENTIRE attribution-coverage banner on
 *      `typeof coverage === 'number' && coverage < 1`. An envelope makes that `false`, so the
 *      banner — the single most important honesty statement on the page, the one that says the
 *      unattributed rows are a missing data source and not evidence of direct arrival — SILENTLY
 *      DISAPPEARS. Nothing errors. Nothing logs. The page looks finished.
 *
 *  The honesty contract is discharged here through OTHER channels, all of which survive rendering:
 *  `has_attribution` and `attribution_coverage` per page, `state_basis` / `trial_days_source` /
 *  `charge_link` per row, `attribution_state`, `data_state`, and `warnings[]`. A contract test must
 *  assert `typeof summary.installs === 'number'`, `typeof summary.with_attribution === 'number'`
 *  and `typeof summary.attribution_coverage === 'number' || === null` — that test is what catches a
 *  well-meaning future "fix".
 * ============================================================================
 */

import type {
    AcquisitionChannel,
    AttributionState,
    ChargeCohortDiagnostics,
    ChargeLinkState,
    CohortDataState,
    SortDirection,
    StateBasis,
    StoreLifecycleState,
    TrialDaysSource
} from './lifecycle.types';

// ── Request ─────────────────────────────────────────────────────────────────

/**
 * What the service takes, after the controller's single cast and before the service's own clamping.
 *
 * Everything except `partner_app_id` is `unknown`-ish on purpose: the controller validates SHAPE
 * only and hands values through raw, so the service — which is also what a job runner or a test
 * reaches — owns every judgement about them, including the fail-open filter validation.
 */
export interface InstallCohortParams {
    /** Required. A missing value is a 400 from the controller, not an empty cohort. */
    partner_app_id: string;
    /** `'all'` / `0` for lifetime, else days back. Passed through raw to `dateRange.helper`. */
    period_days?: string | number;
    since?: string;
    until?: string;
    /**
     * Fail-open. An unrecognised value is a NO-OP PLUS A WARNING, never "match nothing" — a typo
     * must WIDEN the result set. `?state=Converted` returning an empty table with no explanation is
     * indistinguishable from a business with no conversions.
     */
    state?: string;
    /** Same fail-open rule. */
    channel?: string;
    /** Clamped to `MAX_LIMIT` (500), which the page hard-codes; truncation goes into `warnings[]`. */
    limit?: string | number;
    page?: string | number;
    sort?: string;
    sort_dir?: string;
}

// ── One row ─────────────────────────────────────────────────────────────────

/**
 * One store, shaped for `StoreTable`'s cohort column set:
 * `['store', 'came_from', 'status', 'installed_at', 'plan', 'trial_end']`.
 *
 * ⚠️ `customer_name` is deliberately ABSENT. `_renderStore` prefers it over `shop_name`, and in the
 * system this was ported from it came from a store record that has no equivalent here — emitting it
 * would mean inventing one.
 */
export interface InstallCohortRow {
    /** The row identity, the join key and the link key. Always present, always canonical. */
    shop_domain: string;
    /**
     * From the listing-analytics install row's `shop_name` param — so it exists for ATTRIBUTED
     * stores only, and is `''` for the rest. `_renderStore` falls back to the domain, so the cell is
     * never blank. Obtainable universally from the Partner API with a two-word GraphQL change.
     */
    shop_name: string;
    /**
     * ⚠️ Emitted as `''` on purpose. `StoreTable:85-88` renders this in a two-character slot as an
     * ISO-2 code; the only value this build holds is the analytics export's `geo.country`, which is
     * a common NAME ("United States"). `''` drops the line, which is honest and costs nothing;
     * rendering the name puts a long string in a two-character cell and implies a code.
     */
    country: string;
    /** Earliest INSTALL/REINSTALL inside the window. The spine — nothing else adds or removes a row. */
    installed_at: Date | string;
    /** How many install events this store contributed. Sums to `summary.install_events`. */
    install_count: number;

    // ── Came from ───────────────────────────────────────────────────────────
    /**
     * `false` renders "Not attributed", NOT "Direct". Three causes land here — BigQuery
     * unconfigured, the attribution sync never run, and a genuine absence of a listing-analytics
     * row — and they are separated at page level by `attribution_state`, never at row level.
     */
    has_attribution: boolean;
    /** Always populated, `'UNKNOWN'` on a miss, so the badge never falls through to a bare key. */
    channel: AcquisitionChannel;
    channel_label: string;
    /** The raw analytics `source`, rendered under the badge. `''` when unattributed. */
    source: string;
    medium: string;
    campaign: string;
    /** `event_collected` | `user_first_acquisition` | `none`. Two scopes must never look alike. */
    attribution_source: string;
    surface_type: string;
    /**
     * Shopify's own handle for the placement — a homepage section handle, a category path, a
     * collection title — which is what the "Came from" column is made of.
     *
     * ⚠️ `''` on a SEARCH surface, where the same field holds the merchant's typed query: the
     * service blanks it there, on read, so rows stored before this build are covered too.
     */
    surface_detail: string;
    surface_inter_position: number | null;
    surface_intra_position: number | null;
    /**
     * The analytics install instant the attribution was taken from, and its distance from
     * `installed_at`. Published so a nearest-in-time match is AUDITABLE rather than asserted: the two
     * clocks are different (a server-side analytics hit vs Shopify's `occurredAt`) and can sit hours
     * apart, so an exact match is impossible and the tolerance has to be visible.
     */
    attribution_installed_at: Date | string | null;
    attribution_lag_seconds: number | null;

    // ── Status ──────────────────────────────────────────────────────────────
    /** One of the five. Never a sixth — see `lifecycle.constants.ts`. */
    state: StoreLifecycleState;
    state_label: string;
    /**
     * ⚠️ Warn in `warnings[]` when this is `inferred`, and count how many rows carry it.
     *
     * A FOURTH VALUE, `'join_miss'`, is possible here and is deliberately NOT a member of
     * `STATE_BASIS`. The three members name which EVIDENCE produced a SUBSCRIPTION's state, and a
     * store that never subscribed has no such evidence to name. Reusing `inferred` for it would be
     * wrong in both directions: it would bury the one basis that means "we guessed" under every
     * installed-only store, and it would make the `inferred` warning fire on every deployment —
     * which is how a warning stops being read. It stays out of the constants vocabulary because
     * `ChargeCohortDiagnostics.state_basis` is a three-key tally the cohort resolver indexes with a
     * `StateBasis`, so widening that union would break counters for a value the resolver can never
     * produce.
     */
    state_basis: StateBasis | 'join_miss';
    charge_link: ChargeLinkState;

    // ── Plan ────────────────────────────────────────────────────────────────
    /** `charge.name`. `''` when the store never subscribed — the cell renders an em dash. */
    plan_name: string;
    /**
     * `plan_price`, NOT `price`. `StoreTable:207` reads `plan_price`, and the system this was
     * ported from emitted `price` — so this sub-line never rendered there at all. Emitting the right
     * name fixes a latent bug for free.
     */
    plan_price: number | null;
    /**
     * The currency `plan_price` is denominated in, from `charge.amount.currencyCode`. `''` when the
     * charge payload named none, or when the store never subscribed.
     *
     * ⚠️ PUBLISHED AHEAD OF ITS READER, deliberately. `storePresentation.js` hard-codes a `$` in
     * front of `plan_price` today, so a EUR or GBP plan renders as "$29.00" — a right number under a
     * wrong currency, exactly what `IMPLEMENTATION.md` §3.10 exists to prevent. Nothing converts and
     * nothing here ever will; the currency is a LABEL, as it is everywhere else in this codebase.
     */
    plan_currency: string;
    /**
     * Needs a settled `APP_SUBSCRIPTION` payout, which is the only place Shopify exposes an interval.
     * `null` with none — and `FIDELITY.md` §5 forbids booking a null interval as monthly here. The
     * sub-line correctly does not render, because it is gated on this being truthy.
     */
    plan_interval: string | null;

    // ── Trial ───────────────────────────────────────────────────────────────
    /**
     * `charge.billingOn`, the trial-end date Shopify itself supplied.
     * `null` where absent — never `trial_start + 7 days`. This is a RENDERED COLUMN.
     */
    trial_end: Date | string | null;
    trial_days_source: TrialDaysSource;
    /** Same instant as `trial_end` where known; the date billing began. */
    conversion_date: Date | string | null;
    churn_date: Date | string | null;
}

// ── Summary ─────────────────────────────────────────────────────────────────

/**
 * The strip above the table. EVERY FIELD IS A BARE NUMBER — see the file header.
 *
 * The tallies are PRE-FILTER, which is correct rather than a violation of the one-array rule: they
 * label the filter controls (`"On trial (23)"`) and fill the summary boxes, and a post-filter count
 * makes every other option read `(0)` the moment one is selected. Standard faceted-count semantics,
 * and still derived from the single `cohort` array.
 */
export interface InstallCohortSummary {
    /** DISTINCT STORES — `cohort.length`, not the number of install events. */
    installs: number;
    /** Σ `install_count`. A store that installed, uninstalled and reinstalled contributes more than 1. */
    install_events: number;
    /** Every one of the five keys present, zeros included. A dropped key removes a box on screen. */
    by_state: Record<StoreLifecycleState, number>;
    /**
     * Every one of the eight keys present, zeros included.
     * ⚠️ The page then OMITS any channel whose count is `0` from the Select (`:59`) — that is its
     * choice to make from a complete map, not ours to make by withholding keys.
     */
    by_channel: Record<AcquisitionChannel, number>;
    with_attribution: number;
    /**
     * A FRACTION in [0, 1], or `null`.
     *
     * `null` when `installs === 0`, never `0`. A `0` here is the claim "we have attribution for
     * none of your installs"; `null` is "there is nothing to have attribution for". And `typeof`
     * must stay `'number'` in the non-null case or the banner vanishes — see the file header.
     */
    attribution_coverage: number | null;
}

// ── Response ────────────────────────────────────────────────────────────────

/** Page window, echoed so a reader can tell which slice produced these numbers. */
export interface InstallCohortPagination {
    page: number;
    limit: number;
    /** Rows AFTER filtering, before slicing. `> items.length` must push a line into `warnings[]`. */
    total: number;
    pages: number;
}

/** Everything an operator needs to audit a figure, none of it required by the page to render. */
export interface InstallCohortDiagnostics {
    /** Distinct domains on the install spine, before any join. */
    spine_domains: number;
    /** Install events whose `shop_domain` was blank and so could not join anything. */
    shopless_install_events: number;
    /** Subscription events skipped for having neither a charge id nor a shop domain. */
    skipped_keyless_subscription_events: number;
    /**
     * Distinct test SUBSCRIPTIONS excluded (`ChargeCohortDiagnostics.test_subscriptions_excluded`,
     * not the raw event count).
     * ⚠️ Asymmetric and unfixable: the install spine still contains test stores, because Partner
     * relationship events carry no test flag at all. Warn whenever this is above zero.
     */
    test_excluded: number;
    /** Rows whose state rests on the `inferred` branch — the only branch that assumes. */
    inferred_state_rows: number;
    /**
     * Rows carrying a subscription whose state could not be mapped to one of the five, and which are
     * therefore shown as `INSTALLED`.
     *
     * Unreachable today — `types/lifecycle.types.ts` proves the mapping total at compile time —
     * and counted anyway, because the failure it guards against is filing a PAYING CUSTOMER under
     * "Installed only". A count above zero is a defect in this build, and the matching `warnings[]`
     * line says so rather than letting the row pass as an ordinary install.
     */
    unclassified_subscription_rows: number;
    charge_link: { resolved: number; unresolved: number; absent: number };
    /**
     * THE CANCEL TRAP, QUANTIFIED — and quantified ONLY. Nothing in this payload has been
     * adjusted by any of it.
     *
     * Shopify emits a plan change as a cancellation of the old charge plus an acceptance of the new
     * one IN THE SAME SECOND, and the cohort keys per CHARGE — so one merchant upgrading once
     * produces two `trial_started`, an end that is not a departure, and (inside a trial) one
     * `churned_during_trial` against the merchant who did the best available thing. These counters
     * say how much of that is present, so the decision about what to do can be made against a
     * number. Every one is a FLOOR: detection needs both charges to carry an id.
     *
     * ⚠️ THE TYPE IS THE RESOLVER'S OWN, indexed rather than restated. A second hand-written copy of
     * this shape is how a counter is added upstream and silently never reaches the payload — which
     * is the exact fate `subscriptions_superseded` had before this block existed.
     *
     * ⚠️ NEVER `null` here, unlike the custom funnel's copy: this endpoint always folds the charge
     * cohort, so there is no "was not looked for" state to distinguish and a `0` is a measurement.
     */
    supersession: ChargeCohortDiagnostics['supersession'];
    /**
     * The `announcing event → charge.billingOn` gap, bucketed. ⚠️ A REPORTING TALLY: nothing is
     * reclassified on it and `band_max_days` is not a trial-length threshold.
     *
     * It exists because `billingOn` is published as the trial end on this build's HIGHEST-confidence
     * basis, and the live data does not support that certainty — the gap is bimodal and no stored
     * field separates a real trial from a first billing one cycle out. `negative` counts the rows
     * where the date precedes the event announcing it, which cannot be a trial end under any reading.
     */
    billing_on_gap: ChargeCohortDiagnostics['billing_on_gap'];
    /** Filter values the caller sent that matched no known key. Fail-open: ignored, not enforced. */
    unrecognised_filters: string[];
}

/**
 * The whole payload. The page reads seven of these keys; the rest are additive and safe.
 *
 * `status: true` ALWAYS, except for a missing `user_id`, a missing `partner_app_id`, an app that
 * does not exist, or a query that threw. In particular an unconfigured BigQuery is NOT a refusal:
 * `status: false` maps to `setCohort(null)` on the page, which prints "No installs recorded for this
 * window. Install events come from the Partner API — run a Partner sync if you expect some." That is
 * wrong twice — the installs exist, and the missing thing is a BigQuery credential.
 */
export interface InstallCohortResponse {
    app_id: string;
    app_name: string;
    /** From `resolveDateRange().periodLabel`, e.g. "Last 30 days". */
    period_label: string;
    period_days: number | 'all' | null;
    kind: 'preset' | 'lifetime' | 'custom';
    since: string | null;
    until: string;
    /** The instant every state was judged against. Echoed so a state can be reproduced exactly. */
    as_of: string;

    /** Non-array ⇒ the page renders "No installs recorded for this window". Always an array. */
    items: InstallCohortRow[];
    summary: InstallCohortSummary;
    /**
     * State key → label. A missing key removes that state's summary box AND its filter option.
     * Emit all five, always.
     */
    states: Record<StoreLifecycleState, string>;
    /**
     * Channel key → label. ITERATION ORDER IS OBJECT KEY ORDER (`:57`) — build it from
     * `ACQUISITION_CHANNEL_ORDER`, never from `Object.keys` of a tally that a filter may have
     * reordered.
     */
    channels: Record<AcquisitionChannel, string>;
    /**
     * Rendered verbatim, one `<p>` each, KEYED BY THE STRING (`:171`).
     * Every string must be UNIQUE — two identical warnings are a duplicate-key React warning and
     * one of them is dropped.
     */
    warnings: string[];

    /** Echoed filters. The page overwrites both with its own state before rendering. */
    filter_state?: string;
    filter_channel?: string;

    pagination: InstallCohortPagination;
    sort: { key: string; dir: SortDirection };

    /** Whether the install spine itself has ever been synced. The discriminator is the WATERMARK. */
    data_state: CohortDataState;
    /**
     * Why there is nothing to show, set ONLY on the `NEVER_SYNCED` branch.
     *
     * NOT DECORATION. The frontend's decoder intercepts `data_state === 'NEVER_SYNCED'`, nulls
     * `data` — `warnings[]` with it — and renders the banner body as `data.unknown_reason ||
     * resp.msg`. Omit this and the page prints the SUCCESS message, "Install cohort resolved.", under
     * the heading "Nothing synced yet". The same convention carries the same load in
     * `bigQueryAnalytics.service.ts`.
     */
    unknown_reason?: string;
    /** Why attribution may be missing, page-wide. Never a reason to refuse the whole response. */
    attribution_state: AttributionState;
    diagnostics: InstallCohortDiagnostics;
}
