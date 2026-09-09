/**
 * ============================================================================
 *  THE WINDOWED REVENUE VIEW'S RESPONSE CONTRACT — every name a component reads
 * ============================================================================
 *
 *  Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 *  ──  EVERY FIGURE HERE IS A BARE NUMBER, NEVER A `confidence.helper` ENVELOPE ─────────────
 *
 *  This is the OPPOSITE of `types/revenueNow.types`, which wraps every figure, and the difference is
 *  deliberate and load-bearing rather than an inconsistency. `GET /api/revenue/now` is read by
 *  `/api/meta/coverage` and by an operator reading JSON; `GET /api/revenue/overview` is read by
 *  `pages/revenue/index.js`, whose formatters are:
 *
 *      fmtMoney(n)        -> Number(n)  ->  NaN for an object  ->  '—'
 *      fmtNum(n)          -> typeof n !== 'number'             ->  '—'
 *      fmtMoneyOrDash(n)  -> null/undefined                    ->  '—'
 *
 *  Handing that page an envelope renders EVERY figure on it as an em dash — the whole KPI row, the
 *  movement card, both donuts and five table columns — which is not "the honesty mechanism working",
 *  it is the honesty mechanism MANUFACTURING the missing figure it exists to prevent. The page also
 *  branches on `asOf.mrr === null` to choose between "unknown, not zero" and a real answer, so the
 *  null itself is what carries the distinction here.
 *
 *  `modules/store/types/storeRoster.types` reached the identical conclusion for the identical reason
 *  and states the rule this file follows: *"Envelopes belong on a coverage endpoint whose renderer is
 *  ours."* The honesty contract is discharged instead through fields that survive rendering —
 *  `null` for unknown (never `0`), `measurable` and `unknown_reason` per month, `before_coverage`,
 *  `coverage`, `data_state`, `notes[]`, `warnings[]` and `diagnostics`.
 *
 *   THE TWO STYLES ARE NEVER MIXED IN ONE PAYLOAD. A reader who finds one envelope on this
 *  response has to check every other field by hand, which is worse than either convention alone.
 * ============================================================================
 */

import type { ObjectIdLike } from '../../shared/types/entity.types';
import type { PlanRevenueRow } from './asOfMrr.types';
import type { MovementSinceState } from './movementSince.types';

// ── Repository shapes ───────────────────────────────────────────────────────

/** Input to the two windowed cash reads and the two cohort reads. */
export interface RevenueWindowQuery {
    partner_app_id: ObjectIdLike;
    /** Lower bound, INCLUSIVE. `null` means no lower bound — the lifetime window. */
    since: Date | null;
    /** Upper bound, INCLUSIVE. Always set. */
    until: Date;
}

/** Input to the cohort reads, which are bounded ABOVE only. */
export interface RevenueAsOfQuery {
    partner_app_id: ObjectIdLike;
    /**
     * The judgement instant. Bounds the reads ABOVE.
     *
     * ⚠️ THERE IS NO LOWER BOUND ON THE EVENT PULL AND THERE MUST NEVER BE ONE. A store that matters
     * to this window may have subscribed at any point before it; cutting the scan at the window's
     * start loses the START event, so the subscription is never bucketed and a paying customer is
     * reported as never having subscribed.
     */
    as_of: Date;
}

/** One calendar month of settled cash, as the monthly aggregate flattens it. */
export interface MonthlyCashRow {
    /** `YYYY-MM`, UTC. Joined against `TrendMonth.month`. */
    month: string;
    /** What merchants were charged that month, ALL transaction types, refunds included as negatives. */
    gross: number;
    /** What actually reached the bank that month. This is the revenue figure to quote. */
    net: number;
    shopify_fee: number;
    tx_count: number;
}

/**
 * Settled cash inside the selected window.
 *
 *  `null` from the repository — NOT a zeroed row — when nothing settled in the window. `$group`
 * emits no document when nothing matched, and that absence is the only authoritative signal. A
 * manufactured `{ net: 0, … }` and a genuinely zero month are the same four numbers, and only the
 * `null` carries the difference.
 */
export interface WindowCashTotals {
    gross: number;
    net: number;
    shopify_fee: number;
    tx_count: number;
}

/**
 * Which subscriptions have settled money, as the charge cohort's second branch needs it.
 *
 * Two sets rather than one: a per-CHARGE match is exact, and the per-DOMAIN fallback is coarser and
 * is applied only to a subscription that carries no charge id at all.
 */
export interface SettledSubscriptionEvidence {
    charge_ids: string[];
    shop_domains: string[];
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

/**
 * The window the figures below describe, and the ONE instant the run-rate ones were measured at.
 *
 *  THE WINDOW, NOT A MONTH COUNT. Collapsing the picked range to "N months" throws away WHERE it
 * sits on the timeline, which is how an April window came to return today's MRR over an August chart.
 * Both `since`/`until` and the derived `as_of` travel on the payload so the page can never be in
 * doubt about which question it asked.
 */
export interface RevenueWindow {
    /** `All time`, `Last 90 days`, `Apr 1 – Apr 30, 2026`. The heading above the KPI cards. */
    period_label: string;
    /** Which branch of the range resolver produced this window. */
    kind: 'lifetime' | 'preset' | 'custom';
    /** ISO. `null` on a lifetime window, where there is no lower bound. */
    since: string | null;
    /** ISO. The window's own upper bound, which may sit in the past. */
    until: string;
    /**
     * ISO. `min(until, now)` — the instant every point-in-time figure was evaluated at.
     *
     * A run-rate is a SNAPSHOT, not a sum over the window, so "MRR for April" is meaningless without
     * saying when inside April it was taken. For a closed window that is the window's end; for one
     * still open it is now.
     */
    as_of: string;
    /** The measurement instant as a date, for the subline under the period heading. */
    as_of_label: string;
    /** True when the window has already closed, so the figures were measured then and not now. */
    is_historical: boolean;
    /** How many months the trend chart carries. Always at least the window's own months. */
    trend_months: number;
    /** True when older history exists but is not plotted, so the chart can say so. */
    trend_truncated: boolean;
    /**
     * How recently Shopify must have billed a shop for it to count as paying, in days.
     *
     * Published because it is a MEASUREMENT DECISION rather than a tunable: `active_subs` means
     * nothing without it, and changing it changes what the dashboard says happened.
     */
    active_sub_window_days: number;
}

/**
 * The run-rate figures at the window's measurement instant, and how far the records reach.
 *
 * ⚠️ EVERY FIGURE IS `null` WHEN UNKNOWN, NEVER `0`. `0` is a claim about the business; `null` is a
 * statement about the records, and the page renders the two completely differently — a measured zero
 * prints `0.00`, an unknown prints `—` with a hint saying which it is.
 */
export interface RevenueAsOfBlock {
    /** ISO. The same instant as `window.as_of`, repeated where the figures are. */
    at: string;
    mrr: number | null;
    active_subs: number | null;
    /** `mrr / active_subs`. `null` when nothing is live — there is nothing to average over. */
    arpu: number | null;
    /**
     * The same predicate evaluated at NOW rather than at `at`.
     *
     * The reconciliation card's anchor: on a historical window it is what lets a reader see how far
     * the business has moved since; on a window ending today it is the same measurement as `mrr`, and
     * the page suppresses the duplicate row rather than printing one number under two labels.
     */
    mrr_now_baseline: number | null;
    /** True when the window ends before the first settled payout we hold — so nothing is measurable. */
    before_coverage: boolean;
    /** ISO of `earliest_transaction_at`, or `null` when no sync has ever measured the floor. */
    coverage_start: string | null;
    /**
     * How many distinct stores this app's Partner records resolve to.
     *
     * ⚠️ `0` DRIVES A CRITICAL BANNER on the page ("No stores resolved for this app, so every figure
     * below is unreliable"), which is the correct reading: with no store identities, nothing below
     * can be joined to a merchant. It is a count of RESOLVED STORES, not of paying ones — an app with
     * installs and no subscriptions has a non-zero count and an honest zero MRR.
     */
    scope_tenant_count: number;
    /** Why the figures above are null, when they are. `null` when they are real. */
    unknown_reason: string | null;
}

/** Settled cash bounded to the selected window. `null` on a lifetime window — `lifetime_*` says it. */
export interface RevenueWindowCash {
    gross: number;
    net: number;
    shopify_fee: number;
    tx_count: number;
}

/**
 * The movement figures the card prints, as they travel on the wire.
 *
 * ⚠️ EVERY COUNT EQUALS ITS BUCKET'S LENGTH IN `movement_shops`. "If a card says 23 stores, clicking
 * it shows 23 stores" — they are one number, read off one list.
 */
export interface RevenueMovementTotals {
    start_mrr: number;
    end_mrr: number;
    new_mrr: number;
    /** A MAGNITUDE, published positive. The card applies the column's own direction. */
    expansion_mrr: number;
    contraction_mrr: number;
    churned_mrr: number;
    new_count: number;
    expanded_count: number;
    contracted_count: number;
    churned_count: number;
    /**
     * `(churned_mrr + contraction_mrr) / start_mrr`, as a FRACTION, or `null` for an empty base.
     *
     * CANCELLATIONS **PLUS DOWNGRADES**, the one definition — the same arithmetic
     * `GET /api/revenue/churn` publishes under this name. It once meant cancellations only HERE and
     * cancellations-plus-downgrades THERE, so one month read 4% on Revenue and 7% on Revenue Churn.
     */
    gross_churn_rate: number | null;
    /**  A FRACTION, NOT CLAMPED — negative when expansion outruns losses, which is the good case. */
    net_churn_rate: number | null;
    /**
     * `1 − gross_churn_rate`. The share of the window's OPENING MRR still paying at its close,
     * expansion ignored. `null` — never `1` — when there was no opening base to retain.
     */
    gross_revenue_retention_rate: number | null;
    /**
     * `1 − net_churn_rate`. The same share with expansion counted, so it MAY EXCEED `1`, and it is
     * not clamped: above `1` is a base that grew on its own. `null`, never `1`, for an empty base.
     */
    net_revenue_retention_rate: number | null;
    /** The identity, published so the arithmetic is checkable from the payload rather than trusted. */
    reconciles: boolean;
    /** `closing - (opening + new + expansion - contraction - churned)`. Floating-point residue only. */
    reconciliation_drift: number;
}

/** Two engines' answer to "what is MRR today", when there are two. */
export interface RevenueLedgerCrossCheck {
    mrr: number;
    /** What produced it, in the reader's language, so the two rows are never read as one measurement. */
    basis: string;
}

/** The KPI cards, the cash card, the movement card and the reconciliation card. */
export interface RevenueSummary {
    /**
     * MRR at NOW.
     *
     * ⚠️ Identical to `as_of.mrr_now_baseline` in this build, ON PURPOSE and not by coincidence:
     * there is exactly ONE MRR engine here — the settled payout ledger — so "the published figure"
     * and "charge records" are the same measurement. The reconciliation card is built for a
     * deployment that also runs a subscription-state engine; here the two rows agree by construction,
     * and `notes[]` says so rather than leaving a reader to wonder why two labels print one number.
     */
    current_mrr: number | null;
    current_active_subs: number | null;
    arpu: number | null;
    lifetime_gross: number | null;
    /** What actually reached the bank, all time. `null` when no payout has ever been synced. */
    lifetime_net: number | null;
    lifetime_shopify_fee: number | null;
    lifetime_tx_count: number | null;
    /** Cash inside the window. `null` on a lifetime window, where `lifetime_net` already says it. */
    window_cash: RevenueWindowCash | null;
    /**
     * How MRR moved across the window.
     *
     * `null` for two DIFFERENT reasons, both honest: a lifetime window has no meaningful opening
     * balance, and a window whose opening boundary predates the payout history cannot be measured
     * without under-counting. Neither is "you have not picked a range", so the page suppresses its
     * generic empty state for both and `warnings[]` says which.
     */
    window_movement: RevenueMovementTotals | null;
    /** `null` in this build: there is no second engine to cross-check against. See `current_mrr`. */
    ledger_cross_check: RevenueLedgerCrossCheck | null;
    as_of: RevenueAsOfBlock;
}

/**
 * One month on the combined MRR-and-cash chart.
 *
 * ⚠️ `mrr: null` BREAKS THE LINE — the chart draws it with `connectNulls={false}` precisely so an
 * unmeasurable month is a GAP rather than a point at zero. Bridging it would draw a line through
 * revenue nobody measured.
 */
export interface RevenueTrendMonth {
    /** `YYYY-MM`, UTC. */
    month: string;
    /** Cash charged that month, all transaction types. `null` before the ledger's coverage begins. */
    gross_cash: number | null;
    /** Cash settled that month. `null` before coverage. A measured `0` is a real month with no cash. */
    net_cash: number | null;
    /** MRR at the END of the month, or at `as_of` for the running one. `null` when not measurable. */
    mrr: number | null;
    /** Paying shops at the same instant. Published so a flat MRR line can be read against its base. */
    active_subs: number | null;
    /** True when this month overlaps the selected window. The chart shades the ones that do not. */
    in_window: boolean;
    /** True when the month is still running, so its cash bar covers only part of it. */
    is_partial_month: boolean;
    /** False when the payout history cannot decide this month's boundary. Its `mrr` is then null. */
    measurable: boolean;
    /** Why this month is unmeasurable, in the reader's language. `null` when it is measurable. */
    unknown_reason: string | null;
}

/**
 * One shop in the lifetime-cash ranking, with the badges the table draws.
 *
 * ⚠️ LIFETIME AND UNWINDOWED, while the badges are judged at NOW. Two different bases on one row, so
 * `top_shops_basis` states the first and the page captions the second above the table.
 */
export interface RevenueOverviewTopShopRow {
    /** Shopify's PARTNER shop id, which the store-detail endpoint cannot resolve. Join on the domain. */
    shop_id: string;
    shop_domain: string;
    lifetime_net: number;
    lifetime_gross: number;
    /** ISO, or null. */
    first_tx_at: string | null;
    last_tx_at: string | null;
    tx_count: number;
    /** The plan its charge events name, or `null` when they name none. Never a guess. */
    current_plan: string | null;
    /** In the paying set right now, by the canonical as-of predicate. */
    is_active_now: boolean;
    /** `PAYING` | `ON_TRIAL` | `CHURNED_DURING_TRIAL` | `CHURNED_AFTER_TRIAL`, or null when unknown. */
    subscription_state: string | null;
    /**
     * Our subscription records say this store is PAYING and the payout ledger has not billed it
     * recently.
     *
     * Worth surfacing rather than reconciling silently: it is either a cancellation that never synced
     * or a subscription genuinely still running, and the two need opposite actions.
     */
    billing_stale: boolean;
}

/**
 * One store behind one movement figure.
 *
 * The money fields carry TWO VINTAGES on purpose: `previous_mrr`/`mrr` are the window's own
 * endpoints, and `mrr_now`/`plan_name_now`/`since_state` are today. The panel names both instants in
 * its footer, because a store can have changed plan since the window closed.
 */
export interface RevenueMovementShopRow {
    /** The paying set's own key — Shopify's Partner shop id. NOT a store-detail identity. */
    shop_id: string;
    shop_domain: string;
    /** The plan held at the row's own vintage: the period CLOSE, or the period OPEN when churned. */
    plan_name: string;
    /**
     * The plan held at the window's OPEN, or `null`.
     *
     * The other half of "was on X, now on Y": `plan_name` is the row's own vintage, which for
     * EXPANSION and CONTRACTION is the period close — so without this field the panel can price the
     * move (`previous_mrr` → `mrr`) but cannot name the plan it moved FROM, and an operator looking
     * at a $70 expansion has no idea whether the merchant upgraded a tier or just added seats.
     *
     * ⚠️ `null` covers two absences, and the BUCKET says which: on `new` the store was not paying at
     * the open at all, so there is no plan to name; on the other three it means the charge events
     * name none. It is never `''` — an empty string in a plan column renders as a plan called
     * nothing. On CHURNED rows this necessarily equals `plan_name`, which is already the open
     * vintage; it is published there anyway so a consumer never has to know the vintage rule.
     */
    plan_name_at_open: string | null;
    /** What it paid at the window's open. `0` for a store that started paying inside the window. */
    previous_mrr: number;
    /** What it paid at the window's close. `0` for a store that stopped inside the window. */
    mrr: number;
    /** `mrr - previous_mrr`. Signed: here the sign IS the fact being shown. */
    delta: number;
    /** ISO. Churned rows only; `null` on the other three buckets. */
    churn_date: string | null;
    /**
     * Which evidence dated it: `partner_event` or `ledger_window`.
     *
     *  PUBLISHED BESIDE THE DATE, NEVER INSTEAD OF IT, because the two bases are not equally
     * strong. `partner_event` is Shopify telling us a cancellation, uninstall or deactivation
     * happened. `ledger_window` is an INFERENCE FROM SILENCE — the instant the last settled charge
     * aged out of the live window — and it is always LATER than any real cancellation. A reader who
     * cannot tell them apart reads a window expiry as a decision the merchant made.
     */
    churn_basis: string | null;
    /** What has happened to this store between the period close and now. Money only, never installs. */
    since_state: MovementSinceState;
    is_paying_now: boolean;
    /** Its monthly amount today, or `null` when it is not paying. */
    mrr_now: number | null;
    /** Its plan today, or `null` when it is not paying or its charge events name none. */
    plan_name_now: string | null;
}

/** The four member lists, keyed exactly as the movement card names its blocks. */
export interface RevenueMovementShops {
    new: RevenueMovementShopRow[];
    expansion: RevenueMovementShopRow[];
    contraction: RevenueMovementShopRow[];
    churned: RevenueMovementShopRow[];
}

/** The set-level caveats behind the drill-down's "today" columns. */
export interface RevenueMovementShopsSince {
    /** ISO. The period close the `plan_name`/`mrr` columns describe. */
    close_at: string;
    /** ISO. The instant the `*_now` columns describe. */
    now_at: string;
    /**
     * True when the two instants above are the same.
     *
     * The panel drops its "Plan today" column when this is true for the three buckets read out of the
     * closing set, because every row would then say "Same plan" — a column of one repeated value. The
     * CHURNED bucket is exempt: its rows are measured at the period OPEN, so their comparison spans
     * the whole window whenever it ends.
     */
    close_is_now: boolean;
    /**
     *  ALWAYS `null` FROM THIS ENDPOINT, AND `null` IS NOT `false`.
     *
     * The panel reads this three ways: `true` shows an "Installed today" column, `false` prints a
     * banner saying no install or uninstall event has EVER synced for this app, and anything else
     * hides the column silently. Only the third is honest here.
     *
     * Whether the app is still on a store is decided by the relationship-event fold in
     * `modules/store/resolvers/installState.resolver` — the four events, latest wins, `DEACTIVATED`
     * closing an installation and winning an exact tie. That resolver is PRIVATE by explicit design
     * (its module's barrel says why), and re-deriving it here would be a second answer to "is the app
     * installed" that drifts from the Stores page without either page looking wrong. Publishing
     * `false` instead would print a sync-gap banner about a deployment that has synced, which is a
     * specific false claim; publishing `true` with no data behind it would be worse.
     */
    install_state_available: boolean | null;
    /** Not measured here, for the same reason. `null`, never `0` — `0` is a measured all-clear. */
    install_blank_domain_events: number | null;
}

/**
 * How far the records reach, as BARE values.
 *
 * ⚠️ The same seven gates `GET /api/revenue/now` publishes as envelopes, published here as ISO
 * strings and numbers with `null` for NOT YET MEASURED. Two renderings of one fact, and the two
 * endpoints do not share a style — see this file's header for why mixing them would be worse than
 * either.
 */
export interface RevenueOverviewCoverage {
    last_synced_at: string | null;
    earliest_event_at: string | null;
    earliest_transaction_at: string | null;
    lifetime_sync_completed_at: string | null;
    shop_name_coverage_since: string | null;
    /** `0` is a REAL value here ("no gap wider than a day"); `null` means nothing has ever checked. */
    event_history_gap_days: number | null;
    charge_link_absent_pct: number | null;
    charge_link_unresolved_pct: number | null;
}

/** Counters an operator can reconcile the payload against. Every exclusion is REPORTED. */
export interface RevenueOverviewDiagnostics {
    /** Settled subscription payout rows read. The denominator behind every run-rate figure. */
    subscription_charge_rows: number;
    /** Distinct shops those rows name. */
    shops_with_subscription_payouts: number;
    /** Subscriptions the charge cohort folded, for the plan and state labels. */
    cohort_subscriptions: number;
    cohort_domains: number;
    /** Live shops whose plan the charge events could not name. They are labelled, never guessed. */
    unknown_plan_shops: number;
    /**
     * Live shops whose payout rows carry NO shop domain.
     *
     * They are counted in every total and cannot be opened in the store panel — there is no store
     * identity to look one up with — and they cannot be joined to a plan either.
     */
    shops_without_domain: number;
    /** Live shops whose settled charge names no `billing_interval`. ⚠️ An annual one reads 12x high. */
    billing_interval_unknown_shops: number;
    /** Distinct currency codes across the live set. More than one ⇒ `mrr` sums unlike units. */
    currencies: string[];
    /** Months in the trend the payout history cannot decide a boundary for. */
    unmeasured_months: number;
    /** Churned rows dated from the ledger window rather than from a cancellation event. */
    churned_shops_dated_from_ledger: number;
    /** ISO of the payout coverage floor, or null when never measured. */
    earliest_transaction_at: string | null;
}

/** The `data` payload of a successful `getRevenueOverview` call. */
export interface RevenueOverviewData {
    partner_app_id: string;
    app_handle: string;
    display_name: string;
    /**
     * A LABEL for the currency the Partner API settles in, from configuration. Nothing here converts
     * currencies, so this does not promise every row shares it — `diagnostics.currencies` reports
     * what the ledger actually holds.
     */
    reporting_currency: string;
    window: RevenueWindow;
    /**
     * ⚠️ `null` ONLY when no Partner sync has ever completed, and never a zeroed block.
     *
     * The page's own gate is `windowAware = !!(window && summary.as_of)`, so a zeroed summary would
     * render "MRR 0.00" in 32-point type over an app nothing has ever looked at. A synced app whose
     * subscription ledger is empty still gets a FULL summary — its cash figures are real — with the
     * run-rate fields `null` and a warning saying which.
     */
    summary: RevenueSummary | null;
    /** Oldest month first — the order a chart's x-axis reads in. */
    monthly_trend: RevenueTrendMonth[];
    /** The as-of paying set partitioned by the plan each store held AT that instant. */
    plans: PlanRevenueRow[];
    top_shops: RevenueOverviewTopShopRow[];
    /** States the ranking's basis so a reader cannot assume it shares the window. */
    top_shops_basis: string;
    /** `null` in exactly the cases `summary.window_movement` is null. */
    movement_shops: RevenueMovementShops | null;
    movement_shops_since: RevenueMovementShopsSince | null;
    coverage: RevenueOverviewCoverage;
    /** Methodology, rendered as a bulleted banner. Facts about HOW, not about what went wrong. */
    notes: string[];
    /** ⚠️ Every string UNIQUE: the page keys them by the string itself, so a duplicate is DROPPED. */
    warnings: string[];
    diagnostics: RevenueOverviewDiagnostics;
    /** `READY` | `NEVER_SYNCED`, decided by the WATERMARK and never by a row count. */
    data_state: string;
    /** The banner body when nothing has synced. `null` on a normal response. */
    unknown_reason: string | null;
}

/** Input to `getRevenueOverview`. The controller casts the query bag; it validates nothing else. */
export interface GetRevenueOverviewParams {
    partner_app_id?: string;
    /** `'all'` / `0` for lifetime, otherwise days back from now. */
    period_days?: string | number;
    /** ISO `YYYY-MM-DD`. Only honoured when `until` parses too. */
    since?: string;
    until?: string;
    /**
     * ⚠️ ACCEPTED AND DELIBERATELY IGNORED. The frontend's service has always passed a `months`
     * alongside the window, from the days when this endpoint was a snapshot with no range at all. The
     * trend length is derived from the WINDOW instead — collapsing a range to a month count is what
     * threw away where it sat on the timeline. Documented in the params so nobody wires it up later
     * and quietly gives two controls over one axis.
     */
    months?: string | number;
}
