/**
 * The request and response shapes for `GET /api/conversion/revenue-churn`, plus the pure fold's
 * inputs.
 *
 * Declarations only — `typeof import(…)` is erased at compile time, so importing this file costs
 * nothing at run time and does NOT pull the constants module in.
 *
 *  EVERYTHING HERE NAMES AN AMOUNT, and that is the split. `logoChurn.types` deliberately names
 * none: losing ten $9 merchants and losing one $500 merchant are the same revenue event and
 * completely different business events, so the customer count and the money live on separate pages.
 * Both are folded from the SAME `liveSetAsOf` membership, so the two can never disagree about WHO
 * left — only about what the loss was worth.
 *
 *  EVERY FIGURE IS A BARE NUMBER OR `null`, never a `confidence.helper` envelope. The page formats
 * with `_fmtMoney` / `_fmtPct` / `_ratePct`, all of which do `Number(n)`, and an envelope object
 * renders as an em dash — reporting "we could not measure this" about a figure that was measured.
 * The honesty contract is discharged through `measurable`, `unknown_reason`, `data_state`,
 * `diagnostics` and `notes[]` instead.
 */

import type { CohortDataState } from './lifecycle.types';
import type { ChurnDateBasis } from './logoChurn.types';

// ── The pure fold ───────────────────────────────────────────────────────────

/**
 * The four figures `churnRates` reads off one month's movement.
 *
 * Declared STRUCTURALLY rather than importing `modules/revenue`'s `MrrMovement`, for the reason
 * `MembershipSet` is declared that way on the logo side: the helper must be exercisable against
 * literal numbers, and it must not be able to reach for a field it has no business reading —
 * `new_mrr` above all, which belongs in NEITHER rate.
 */
export interface MrrMovementFigures {
    /** MRR at the month's opening boundary. The denominator of both rates. */
    start_mrr: number;
    /** MRR lost to shops that stopped paying entirely. */
    churned_mrr: number;
    /** MRR lost to shops that stayed and paid less. */
    contraction_mrr: number;
    /** MRR gained from shops that stayed and paid more. Subtracted by NET only. */
    expansion_mrr: number;
}

/** The two rates, as FRACTIONS of the opening MRR. Either may be null; net may be NEGATIVE. */
export interface RevenueChurnRates {
    /** `(churned + contraction) / start`.  `null` — never `0` — when the month opened empty. */
    gross_churn_rate: number | null;
    /**
     * `(churned + contraction − expansion) / start`.
     *
     *  NOT CLAMPED AT ZERO. A month whose existing customers expanded by more than it lost
     * publishes a NEGATIVE rate, which is the single best signal a subscription business has.
     */
    net_churn_rate: number | null;
}

// ── Request ─────────────────────────────────────────────────────────────────

/** The query bag, already CAST (never coerced) by the controller. */
export interface RevenueChurnParams {
    partner_app_id: string;
    /** How many calendar months of trend. Out-of-range values are CLAMPED and reported. */
    months?: number | string;
}

// ── Response ────────────────────────────────────────────────────────────────

/**
 * The six headline tiles, plus the month they describe and the basis they were measured on.
 *
 *  `last_month_*` IS THE LAST **COMPLETE** MONTH, NEVER THE MONTH IN PROGRESS, and the page
 * depends on it: its waterfall panel picks the last trend row with `is_partial_month === false` and
 * captions it with `summary.last_complete_month`, so the two have to name the same month or the
 * panel reconciles with nothing beside it. Its own comment records what happened when it took the
 * final trend row instead — a panel headed "Last month" drawing an unfinished one.
 */
export interface RevenueChurnSummary {
    /**
     * MRR as of the judgement instant, from `liveSetAsOf` at `now`.
     *
     * ⚠️ DELIBERATELY UNGATED by the payout coverage floor, because `GET /api/revenue/now` publishes
     * its `mrr` from this exact predicate at this exact instant with no floor test. Gating it here
     * would put a blank tile on one page beside a number on another for one measurement.
     */
    current_mrr: number;
    /** Shops behind `current_mrr`. Published so the tile is reconcilable rather than merely plausible. */
    active_subs: number;
    /**
     * `YYYY-MM` of the last COMPLETE month in range, or `null` when the range holds only the month in
     * progress (`months=1` on the 30-day preset is exactly that case).
     */
    last_complete_month: string | null;
    /** That month's opening MRR. `null` when it has no complete month, or one the history cannot support. */
    last_month_start_mrr: number | null;
    last_month_end_mrr: number | null;
    /** MRR from shops that were not paying at the month's start. */
    last_month_new_mrr: number | null;
    /** MRR gained from shops that stayed and paid more. */
    last_month_expansion_mrr: number | null;
    /** MRR lost to shops that stayed and paid less. */
    last_month_contraction_mrr: number | null;
    /** MRR lost to shops that stopped paying entirely. */
    last_month_churned_mrr: number | null;
    /** `(churned + contraction) / start`.  `null`, never `0`, for a month that opened empty. */
    last_month_gross_churn_rate: number | null;
    /**  MAY BE NEGATIVE. Not clamped — see `RevenueChurnRates`. */
    last_month_net_churn_rate: number | null;
    /**
     * The as-of lookback membership was evaluated with, in days.
     *
     * Published because it is a MEASUREMENT DECISION rather than a tunable, and every figure above
     * moves with it. Too narrow manufactures churn; too wide keeps cancellations that never synced
     * paying for ever.
     */
    active_sub_window_days: number;
    /** What these figures mean, in one sentence, so the tiles cannot be read as something else. */
    basis: string;
}

/**
 * One month of MRR movement.
 *
 *  MEMBERSHIP IS EVALUATED AT AN INSTANT, NEVER "BILLED INSIDE THIS CALENDAR MONTH". 12 × 30 = 360,
 * so a shop on a 30-day cycle skips one calendar month a year; calendar-month membership would
 * report every one of them as CHURNED that month and NEW the next — falsely churning ~1/12 of the
 * paying base every month AND inflating new MRR by the same amount, from arithmetic alone.
 *
 * Consecutive months SHARE a boundary — month N's closing set IS month N+1's opening set — so
 * `end = start + new + expansion − contraction − churned` holds along the whole series.
 *
 * ⚠️ AN UNMEASURABLE MONTH NULLS EVERY FIGURE, NOT ONLY THE RATES, and `-null` is `-0` in
 * JavaScript — a NUMBER, which passes a `typeof` guard. A consumer that negates these for a
 * downward-plotted bar must test for null BEFORE the unary minus.
 */
export interface RevenueChurnMonth {
    /** `YYYY-MM`, UTC. */
    month: string;
    start_mrr: number | null;
    end_mrr: number | null;
    new_mrr: number | null;
    expansion_mrr: number | null;
    contraction_mrr: number | null;
    churned_mrr: number | null;
    /** `(churned + contraction) / start`.  `null`, never `0`, when the month opened empty. */
    gross_churn_rate: number | null;
    /**  MAY BE NEGATIVE, and is not clamped. */
    net_churn_rate: number | null;
    /** How many shops stopped paying. A COUNT beside the money, so the two pages can be tied together. */
    churned_shops: number | null;
    /**
     * True while the month is still running, so its movement is partial by construction.
     *
     * ⚠️ `is_partial_month`, NOT `is_partial` — `components/growth-intel/revenue/ChurnView.js` reads
     * this name to pick the waterfall's month, and a mis-spelling makes EVERY row read as complete,
     * which puts the month in progress back in the panel.
     */
    is_partial_month: boolean;
    /** False when the stored payout history cannot support the month's boundaries. Figures are null. */
    measurable: boolean;
    unknown_reason: string | null;
}

/**
 * One merchant whose MRR the last complete month lost.
 *
 *  `shop_id` IS SHOPIFY'S PARTNER SHOP ID AND THE STORE DRAWER CANNOT RESOLVE IT — see
 * `SHOP_IDENTITY_FIELD` in `../constants/revenueChurn.constants`. The drawer opens on `shop_domain`,
 * and a row without one is correctly left unclickable rather than offered as a click that errors.
 */
export interface RevenueChurnedShopRow {
    /** Partner shop id off the payout ledger. Display and React-key only; see the note above. */
    shop_id: string;
    /** Canonical `*.myshopify.com`, or `''` when the ledger row carried no domain. */
    shop_domain: string;
    /** From the subscription's `charge.name`, or `''` — which the page renders as an em dash. Never guessed. */
    plan_name: string;
    /**
     * The monthly run-rate the shop was at when it was last seen paying.
     *
     * ⚠️ Normalised: an ANNUAL charge is divided by 12 by `normalizeToMonthly`, because a year of
     * revenue booked whole overstates a monthly run-rate twelvefold.
     */
    lost_mrr: number;
    /** The currency that charge settled in. There is no FX table in this build. */
    currency: string;
    /**
     * The shop's FIRST settled subscription payout — when it started paying us.
     *
     * ⚠️ Not the subscription's activation. This row is built from the payout ledger, and dating one
     * column off the ledger and its neighbour off the event stream is how two dates that must
     * bracket each other come to cross.
     */
    paid_from: string;
    /** When membership ended. ⚠️ Read `churn_date_basis` before quoting it. */
    churned_at: string;
    churn_date_basis: ChurnDateBasis;
    /**
     * Whole days from `paid_from` to `churned_at`.
     *
     * ⚠️ ALWAYS A NUMBER — a rendering contract, not a preference: the page prints
     * `` `${n} days` `` through `_fmtDays`, and although that guards a null with an em dash, a
     * duration is always derivable here because both endpoints of the subtraction are on this row.
     */
    paid_days: number;
    /** The cadence its last payout was billed at, or `null` when no payout carried one. */
    billing_interval: string | null;
}

/** What was excluded or approximated, counted, so the payload can be reconciled. */
export interface RevenueChurnDiagnostics {
    /** Settled `APP_SUBSCRIPTION` payout rows the live-set predicate was evaluated over. */
    subscription_charge_rows: number;
    /** Distinct shops with any settled subscription payout, ever. The universe of this endpoint. */
    shops_with_subscription_payouts: number;
    /** Months whose boundaries the stored payout history could not support. */
    unmeasured_months: number;
    /** Churned merchants beyond `TOP_CHURNED_LIMIT`, dropped from the table but counted here. */
    top_churned_omitted: number;
    /** Churned merchants whose domain matched no subscription, so their plan could not be named. */
    top_churned_without_plan: number;
    /** Churned merchants whose churn date is a derived ledger boundary rather than a dated event. */
    top_churned_dated_from_ledger: number;
    /** Churned merchants carrying no shop domain — listable, but the drawer cannot open them. */
    top_churned_without_domain: number;
    /**
     * Currently-paying shops whose latest payout carried no `billing_interval`.
     *
     * ⚠️ THE ANNUAL CAVEAT, MADE COUNTABLE. `normalizeToMonthly` divides by 12 only when the interval
     * reads exactly `ANNUAL`; a null is treated as monthly, which is right for a real monthly plan
     * and twelvefold wrong for an annual subscriber on a row synced before the field was captured.
     * Every figure on this page reads HIGH by that amount.
     */
    billing_interval_unknown_shops: number;
    /** Distinct currencies among the currently-paying shops. `> 1` means the totals sum unlike units. */
    currencies: string[];
    /** The money-side coverage floor, or `null` when it has never been measured. */
    earliest_transaction_at: string | null;
}

/** The `data` of a successful `GET /api/conversion/revenue-churn`. */
export interface RevenueChurnResponse {
    app_id: string;
    app_name: string;
    months: number;
    since: string | null;
    until: string;
    as_of: string;
    reporting_currency: string;

    /**
     * `null` when there is no paying base to measure against — EITHER of two conditions.
     *
     * 1. No Partner sync has completed (`data_state: 'NEVER_SYNCED'`); or
     * 2. a sync HAS completed and the `APP_SUBSCRIPTION` ledger is empty (`data_state: 'READY'` —
     *    the watermark decides that field, never the row count).
     *
     * The page's `isNeverSynced` is `(d) => !d.summary` and its six tiles read
     * `data.summary.current_mrr` and friends directly, so a `null` here routes the whole payload to
     * the banner instead of rendering "$0.00 current MRR" — a claim about the business nobody made.
     */
    summary: RevenueChurnSummary | null;

    /**
     *  SEPARATELY NULLABLE FROM `summary`, exactly as on Logo Churn.
     *
     * They are two different measurements: one instant plus one complete month, versus every month
     * boundary in the requested range. A deployment three weeks old asked for twelve months can
     * answer the first and not the second. `null` is reserved for "no month in this range could be
     * measured at all"; an array with SOME unmeasurable months stays an array, and the blanks inside
     * it break the line, which is the honest rendering at that granularity.
     */
    monthly_trend: RevenueChurnMonth[] | null;
    /** Why the trend is absent. Read only when `monthly_trend` is null. */
    trend_unknown_reason: string | null;

    /**
     * The merchants behind `summary.last_month_churned_mrr`, biggest loss first.
     *
     *  THE LAST COMPLETE MONTH'S CHURN, NOT A ROLLING 30 DAYS, despite the name the page reads.
     * The field is spelled `top_churned_30d` because that is what
     * `components/growth-intel/revenue/ChurnView.js` already destructures, and its own heading says
     * "Top revenue lost in {last_complete_month}" — so the rows and the tiles above them describe one
     * month. Renaming the field would blank the table for no gain.
     */
    top_churned_30d: RevenueChurnedShopRow[];
    /** True when the list was longer than the row cap — the page's table cannot tell on its own. */
    top_churned_truncated: boolean;
    /** WHICH row field the store drawer can resolve. Always `shop_domain` — see the row type. */
    shop_identity: string;

    /**
     * The methodology, and every caveat, in the order a reader should meet them.
     *
     * ⚠️ THE PAGE'S ONLY PROSE CHANNEL. `revenue-churn/index.js` renders `data.notes` in a
     * "Methodology notes" banner and has NO warnings banner at all, so an exclusion that reaches only
     * `warnings[]` is an exclusion the operator cannot see. `notes` is therefore the methodology
     * sentences FOLLOWED BY every warning; `warnings` carries the caveats alone for API consumers and
     * for the day the page grows a banner of its own.
     *
     * Rendered one `<li>` each, KEYED BY INDEX here — but deduplicated anyway, because a repeated
     * sentence is noise whether or not React drops it.
     */
    notes: string[];
    /** The caveats alone. Every entry unique. */
    warnings: string[];
    diagnostics: RevenueChurnDiagnostics;

    /**
     *  THE WATERMARK (`gi_partner_apps.last_synced_at`), NEVER THE ROW COUNT.
     *
     * `NEVER_SYNCED` means nothing has ever been fetched for this app. An app that HAS synced and
     * whose subscription ledger is simply empty stays `READY` with a null `summary` and a sentence in
     * `unknown_reason` — see `subscriptionList.constants`, which forbids the substitution by name.
     */
    data_state: CohortDataState;
    /**
     * The banner's body on every path that withholds `summary`. Without it `dataState.js` falls back
     * to `resp.msg` and prints the SUCCESS message under the heading "Nothing synced yet".
     */
    unknown_reason?: string;
}
