/**
 * The request and response shapes for `GET /api/conversion/logo-churn`, plus the value unions of
 * `../constants/logoChurn.constants`.
 *
 * Declarations only — `typeof import(…)` is erased at compile time, so importing this file costs
 * nothing at run time and does NOT pull the constants module in.
 *
 *  NOTHING IN HERE NAMES AN AMOUNT. Logo churn counts CUSTOMERS: losing ten $9 merchants and
 * losing one $500 merchant are the same revenue event and completely different business events,
 * which is why this is its own page. A `lost_mrr` field would put money on a customer-count screen
 * and invite exactly the reading the split exists to prevent — and the money answer already has a
 * home in `modules/revenue`, computed from the same `liveSetAsOf` predicate this endpoint's
 * membership comes through.
 */

import type { CohortDataState } from './lifecycle.types';

type LogoChurnConstants = typeof import('../constants/logoChurn.constants');

/** `partner_event` | `ledger_window` — how a row's churn date was arrived at. */
export type ChurnDateBasis =
    LogoChurnConstants['CHURN_DATE_BASES'][keyof LogoChurnConstants['CHURN_DATE_BASES']];

// ── Request ─────────────────────────────────────────────────────────────────

/** The query bag, already CAST (never coerced) by the controller. */
export interface LogoChurnParams {
    partner_app_id: string;
    /** How many calendar months of trend. Out-of-range values are CLAMPED and warned about. */
    months?: number | string;
}

// ── Response ────────────────────────────────────────────────────────────────

/**
 * The four headline tiles, plus the basis they were measured on.
 *
 * EVERY FIGURE IS A BARE NUMBER OR `null`. The page formats them with `_fmtNum` / `_fmtPct`, both of
 * which do `Number(n)` — a confidence envelope renders as an em dash, reporting "we could not
 * measure this" about a figure that was measured. And `churn_rate_30d` gates a `critical` tone with
 * `> 0.05`, which `null` fails safely and an envelope object would pass.
 */
export interface LogoChurnSummary {
    /** Shops paying as of the judgement instant, through `liveSetAsOf`. `null` when unsupported. */
    current_active: number | null;
    active_30d_ago: number | null;
    active_90d_ago: number | null;
    /** In the live set 30 days ago and not in it now. Customers, not money. */
    churned_in_30d: number | null;
    churned_in_90d: number | null;
    /** In the live set now and not 30 days ago. Published so the 30-day movement reconciles. */
    gained_in_30d: number | null;
    /**
     * `churned_in_30d / active_30d_ago`, a FRACTION in [0,1].
     *
     *  `null` — never `0` — when nobody was paying 30 days ago. A ratio with an empty denominator
     * is not a measurement of perfect retention.
     */
    churn_rate_30d: number | null;
    churn_rate_90d: number | null;
    /**
     * The as-of lookback membership was evaluated with, in days.
     *
     * Published because it is a MEASUREMENT DECISION rather than a tunable, and every figure above
     * moves with it. Too narrow manufactures churn (a 30-day window over a 30-day cycle produced a
     * measured 47.6% churn reading for a month in which nobody cancelled); too wide keeps
     * cancellations that never synced "active" for ever.
     */
    active_sub_window_days: number;
    /** What "active" means here, in one sentence, so the tiles cannot be read as something else. */
    basis: string;
}

/**
 * One month of subscriber movement.
 *
 *  MEMBERSHIP IS EVALUATED AT AN INSTANT, NEVER "BILLED INSIDE THIS CALENDAR MONTH". 12 × 30 = 360,
 * so a shop on a 30-day cycle skips one calendar month a year; calendar-month membership reports
 * every one of them as churned that month and new the next, falsely churning ~1/12 of the paying
 * base every month from arithmetic alone.
 */
export interface LogoChurnMonth {
    /** `YYYY-MM`, UTC. */
    month: string;
    /** Shops paying at the month's first instant. The denominator of `churn_rate`. */
    active_at_start: number | null;
    /** Shops paying at the month's last instant, clamped to the judgement instant. */
    active_at_end: number | null;
    /** In the end set and not the start set. */
    gained_in_month: number | null;
    /** In the start set and not the end set. */
    churned_in_month: number | null;
    /** `churned_in_month / active_at_start`.  `null` when nobody was paying at the start. */
    churn_rate: number | null;
    /** True while the month is still running, so its movement is partial by construction. */
    is_partial: boolean;
    /** False when the stored payout history cannot support the month's boundaries. Counts are null. */
    measurable: boolean;
    unknown_reason: string | null;
}

/**
 * Churn for one plan over the recent window.
 *
 * The plan comes from the subscription's own `charge.name`, joined to the ledger by shop domain. A
 * shop we cannot join lands in the `UNKNOWN_PLAN_LABEL` bucket rather than under a real plan's name
 * — moving merchants between plans is a specific false claim about a specific plan's retention.
 */
export interface LogoChurnPlanRow {
    plan_name: string;
    active_now: number;
    active_30d_ago: number;
    churned_in_30d: number;
    /** `churned_in_30d / active_30d_ago`.  `null` when the plan had nobody 30 days ago. */
    churn_30d_pct: number | null;
}

/**
 * One shop that stopped paying inside the recent window.
 *
 *  `shop_id` IS SHOPIFY'S PARTNER SHOP ID, WHICH THE STORE DRAWER CANNOT RESOLVE. The frontend
 * hook's own comment says this field is a `tenant_id` on this page — that is carried over from the
 * multi-tenant system these pages were extracted from, and it is wrong here: this build has no
 * tenant graph at all. Sent as an identity key it fails the 24-hex test, is treated as a domain, and
 * `normaliseShopDomain` truncates a `gid://…` at the first slash to the literal string `gid:`. THE
 * DRAWER OPENS ON `shop_domain` — see `shop_identity` on the payload.
 */
export interface LogoChurnedShopRow {
    /** Partner shop id off the payout ledger. Display and React-key only; see the note above. */
    shop_id: string;
    /** Canonical `*.myshopify.com`, or `''` when the ledger row carried no domain. */
    shop_domain: string;
    /** From the subscription's `charge.name`, or `UNKNOWN_PLAN_LABEL`. Never a guessed plan. */
    plan_name: string;
    /**
     * The shop's FIRST settled subscription payout — when it started paying us.
     *
     * ⚠️ Not the subscription's activation. This row is built from the payout ledger, and dating one
     * column off the ledger and its neighbour off the event stream is how two dates that must
     * bracket each other come to cross. `trial_started_at` carries the event-side date separately.
     */
    activated_at: string;
    /** The subscription's own trial start, when the domain joins the event side. `null` otherwise. */
    trial_started_at: string | null;
    /** When membership ended. Read `churn_date_basis` before quoting it — see that field. */
    churned_at: string;
    churn_date_basis: ChurnDateBasis;
    /**
     * Whole days from `activated_at` to `churned_at`.
     *
     * ⚠️ ALWAYS A NUMBER, and that is a rendering contract rather than a preference: the page prints
     * `` `${r.paid_days} days` `` with no guard at all, so a `null` renders the literal text
     * "null days". Both endpoints of the subtraction are dates this row already carries, so the
     * value always exists; it is clamped at zero rather than allowed to go negative.
     */
    paid_days: number;
    /** The cadence its last payout was billed at, or `null` when no payout carried one. */
    billing_interval: string | null;
}

/** What was excluded or approximated, counted, so the payload can be reconciled. */
export interface LogoChurnDiagnostics {
    /** Settled `APP_SUBSCRIPTION` payout rows the live-set predicate was evaluated over. */
    subscription_charge_rows: number;
    /** Distinct shops with any settled subscription payout, ever. The universe of this endpoint. */
    shops_with_subscription_payouts: number;
    /** Churned shops whose domain matched no subscription, so their plan could not be named. */
    churned_shops_without_plan: number;
    /** Churned shops whose churn date is a derived ledger boundary rather than a dated event. */
    churned_shops_dated_from_ledger: number;
    /** Churned shops carrying no shop domain — listable, but the drawer cannot open them. */
    churned_shops_without_domain: number;
    /** Months whose boundaries the stored payout history could not support. */
    unmeasured_months: number;
    /** Rows beyond `RECENT_CHURN_LIMIT`, dropped from `recent_churned` but counted here. */
    churned_shops_omitted: number;
    /** The money-side coverage floor, or `null` when it has never been measured. */
    earliest_transaction_at: string | null;
}

/** The `data` of a successful `GET /api/conversion/logo-churn`. */
export interface LogoChurnResponse {
    app_id: string;
    app_name: string;
    months: number;
    since: string | null;
    until: string;
    as_of: string;

    /**
     * `null` when there is no paying base to measure against — EITHER of two conditions.
     *
     * 1. No Partner sync has completed (`data_state: 'NEVER_SYNCED'`); or
     * 2. a sync HAS completed and the `APP_SUBSCRIPTION` ledger is empty (`data_state: 'READY'` —
     *    the watermark decides that field, never the row count).
     *
     * `unknown_reason` is what tells the two apart, and it is set on both.
     *
     * The page's `isNeverSynced` is `(d) => !d.summary` and its four tiles read
     * `data.summary.current_active` and friends directly, so a `null` here routes the whole payload
     * to the NEVER_SYNCED banner instead of rendering `|| 0` under each tile.
     */
    summary: LogoChurnSummary | null;

    /**
     *  SEPARATELY NULLABLE FROM `summary`, ON PURPOSE.
     *
     * They are two different measurements: the tiles are the live set at four instants, the trend is
     * the live set at every month boundary in the requested range. The stored payout history can
     * support the first and not the second — a deployment three weeks old asked for twelve months of
     * trend is exactly that case. The page has a `_trendDataState` gate for it and publishes the
     * tiles while saying plainly that the trend is unavailable, rather than mounting a titled, axed
     * chart over an empty array — which reads as "we measured these months and nothing moved".
     *
     * An EMPTY ARRAY is left as a measured empty and stays READY. `null` is reserved for "no month in
     * this range could be measured at all".
     */
    monthly_trend: LogoChurnMonth[] | null;
    /** Why the trend is absent. Read only when `monthly_trend` is null. */
    trend_unknown_reason: string | null;

    by_plan: LogoChurnPlanRow[];
    recent_churned: LogoChurnedShopRow[];
    /** True when the churn list was longer than the row cap — the page's caption cannot tell. */
    recent_churned_truncated: boolean;
    /** WHICH row field the store drawer can resolve. Always `shop_domain` — see the row type. */
    shop_identity: string;

    /** Rendered one <p> each, KEYED BY THE STRING. Every entry must be unique. */
    warnings: string[];
    diagnostics: LogoChurnDiagnostics;

    /**
     *  THE WATERMARK (`gi_partner_apps.last_synced_at`), NEVER THE ROW COUNT.
     *
     * `NEVER_SYNCED` means nothing has ever been fetched for this app. An app that HAS synced and
     * whose subscription ledger is simply empty stays `READY` with a null `summary` and a sentence
     * in `unknown_reason` / `warnings[]` — see `subscriptionList.constants`, which forbids the
     * substitution by name, and `subscriptionList.service`, which answers the same situation the
     * same way.
     */
    data_state: CohortDataState;
    /**
     * The banner's body on every path that withholds `summary` — both the never-synced one and the
     * synced-but-empty-ledger one. Without it `dataState.js` falls back to `resp.msg` and prints the
     * SUCCESS message under the heading "Nothing synced yet".
     */
    unknown_reason?: string;
}

// ── The pure membership fold ────────────────────────────────────────────────

/**
 * The minimum a membership fold reads off one member of a live set.
 *
 * Declared STRUCTURALLY and deliberately EMPTY of required fields, so `modules/revenue`'s own
 * `LiveSet` satisfies it without this module depending on that shape — and so the fold cannot reach
 * for an amount even by accident. Logo churn counts customers; the value side of the map is never
 * read here.
 */
export type MembershipSet = ReadonlyMap<string, unknown>;

/**
 * What `foldMembershipMovement` answers for one pair of boundaries.
 *
 * Counts only. The keys of the shops that left come back so a caller can enrich them into rows, but
 * nothing here totals an amount — see this file's header for why.
 */
export interface MembershipMovement {
    active_at_start: number;
    active_at_end: number;
    /** Present at the end and absent at the start. */
    gained: number;
    /** Present at the start and absent at the end. */
    churned: number;
    /**
     * `churned / active_at_start`.
     *
     * ⚠️ `null` — never `0` — when nobody was paying at the start. A ratio with an empty denominator
     * is not a measurement of perfect retention, and the chart plots it on a
     * `<Line connectNulls={false}>` precisely so an unmeasured month breaks the line.
     */
    churn_rate: number | null;
    /** The keys that left, in the start set's own iteration order. */
    churned_keys: string[];
}
