/**
 * Shapes for `helpers/movementSince.helper` — how MRR got from one balance to the other.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 * IN-MEMORY structures, not wire shapes. The helper hands back the members of each bucket paired
 * with the ledger rows they came from; turning those into the rows a panel renders — with plan
 * names, churn dates and the since-vocabulary — is the service's job, because those need reads the
 * helper is not allowed to make.
 */

import type { PayingShop } from './ledgerMrr.types';

/**
 * One store that moved, with BOTH of its endpoints attached.
 *
 * The two `PayingShop` refs are carried rather than flattened because the service needs facts off
 * them that no summary would keep — `last_charged_at` and `billing_interval` at the OPENING boundary
 * are what date a churn, and neither survives a reduction to two amounts.
 */
export interface MovementMember {
    /**
     * The live set's own key for this shop — Shopify's Partner shop GID.
     *
     * ⚠️ BOTH SETS MUST BE KEYED THE SAME WAY, which they are because both come from `liveSetAsOf`
     * over one history array. Diffing two differently-keyed sets reports every store as both churned
     * and new, which reconciles perfectly and is entirely wrong.
     */
    shop_key: string;
    /** The canonical domain. `''` when the payout rows carried none — the caller counts those. */
    shop_domain: string;
    /** What the shop was paying at the period OPEN. `0` for a store that was not yet paying. */
    previous_mrr: number;
    /** What it was paying at the period CLOSE. `0` for a store that had stopped. */
    mrr: number;
    /** `mrr - previous_mrr`. Negative for contraction and for churn. */
    delta: number;
    /** The shop as it stood at the OPEN, or null when it was not paying then. */
    open: PayingShop | null;
    /** The shop as it stood at the CLOSE, or null when it was not paying then. */
    close: PayingShop | null;
}

/** The four buckets, each holding the stores behind its own figure. */
export interface MovementBuckets {
    /** Paying at the close, absent at the open. */
    new: MovementMember[];
    /** Paying at both ends, for MORE at the close. */
    expansion: MovementMember[];
    /** Paying at both ends, for LESS at the close. */
    contraction: MovementMember[];
    /** Paying at the open, absent at the close. */
    churned: MovementMember[];
}

/**
 * The movement figures the card prints.
 *
 * ⚠️ EVERY COUNT IS `bucket.length`. The card prints "23 stores" and the click opens that bucket, so
 * the count and the list are the SAME number by construction. Computing a count any other way — a
 * second reduction, a filtered tally, anything — gives it a way to drift from the list it labels.
 */
export interface MovementTotals {
    /** MRR at the period OPEN. The balance the four forces act on. */
    start_mrr: number;
    /** MRR at the period CLOSE. Equals the reconciliation below, exactly. */
    end_mrr: number;
    new_mrr: number;
    expansion_mrr: number;
    /** A MAGNITUDE, published positive. The card applies the column's own direction. */
    contraction_mrr: number;
    /** A MAGNITUDE, published positive, for the same reason. */
    churned_mrr: number;
    new_count: number;
    expanded_count: number;
    contracted_count: number;
    churned_count: number;
    /**
     * `(churned_mrr + contraction_mrr) / start_mrr`, as a FRACTION.
     *
     * CANCELLATIONS **PLUS DOWNGRADES** — everything the opening base lost. This field once
     * carried `churned_mrr / start_mrr` here while `modules/conversion` published the documented
     * `(churned + contraction) / start` under the SAME NAME on the Revenue → Churn tab, so one month
     * read 4% on Revenue and 7% on Revenue Churn. There is ONE definition of gross churn; a
     * cancellations-only figure would need its own name (`cancellation_rate`).
     *
     * ⚠️ `null` — never `0` — when the window opened with no paying base. Every "All time" window
     * does, and `0.0%` printed under the words "Gross churn" is a claim of perfect retention over a
     * period in which nobody was paying at all.
     */
    gross_churn_rate: number | null;
    /**
     * `(churned_mrr + contraction_mrr - expansion_mrr) / start_mrr`, as a FRACTION.
     *
     *  NOT CLAMPED AT ZERO, AND IT MUST NEVER BE. When expansion outruns losses this goes NEGATIVE,
     * and negative net churn is the single best signal a subscription business has. Rounding it up to
     * zero hides exactly the months worth celebrating, and does it silently.
     *
     * New business is deliberately EXCLUDED: net churn measures what happened to the customers you
     * already had. Including new business would let a good sales month paper over a retention
     * problem.
     */
    net_churn_rate: number | null;
    /**
     * `1 − gross_churn_rate` — the share of the opening MRR still paying at the close, IGNORING
     * expansion. Bounded by `[0, 1]`: the opening base cannot lose more than all of itself.
     *
     * ⚠️ `null`, NEVER `1`, when there is no gross churn rate to invert. "100.0% gross revenue
     * retention" over a window in which nobody was paying is the same lie as "0.0% gross churn",
     * wearing the opposite face.
     */
    gross_revenue_retention_rate: number | null;
    /**
     * `1 − net_churn_rate` — the same share WITH expansion counted, so it may exceed `1`.
     *
     *  NOT CLAMPED, above or below. NRR above `1` means the base grew on its own before a single
     * new customer was counted, which is exactly the month worth reporting; capping it at `1` hides
     * it. `null`, never `1`, when the window opened with no paying base.
     */
    net_revenue_retention_rate: number | null;
}

/**
 * The identity the panel is only honest if it satisfies.
 *
 *  `opening + new + expansion - contraction - churned === closing`, EXACTLY. This block is
 * published so the arithmetic is checkable from the payload rather than taken on trust, and the
 * helper THROWS rather than returning a fold that fails it.
 */
export interface MovementReconciliation {
    opening: number;
    closing: number;
    /** `opening + new + expansion - contraction - churned`. Must equal `closing`. */
    expected_closing: number;
    /** `closing - expected_closing`. Floating-point residue only; never a business quantity. */
    drift: number;
}

/** What `foldMrrMovement` answers. */
export interface MrrMovementFold {
    totals: MovementTotals;
    /** The stores behind each figure, each list already ordered by |delta| descending. */
    buckets: MovementBuckets;
    reconciliation: MovementReconciliation;
}

/** Input to `foldMrrMovement`. */
export interface FoldMrrMovementInput {
    /** The paying set at the period OPEN. `undefined` is treated as empty. */
    open_set?: Map<string, PayingShop>;
    /** The paying set at the period CLOSE. `undefined` is treated as empty. */
    close_set?: Map<string, PayingShop>;
}

/** One of the six `MOVEMENT_SINCE_STATES` values. */
export type MovementSinceState =
    typeof import('../constants/revenueOverview.constants')['MOVEMENT_SINCE_STATES'][
        keyof typeof import('../constants/revenueOverview.constants')['MOVEMENT_SINCE_STATES']
    ];

/** Input to `movementSinceState`. */
export interface MovementSinceInput {
    /** Whether the store was in the paying set at the period CLOSE. */
    was_paying_at_close: boolean;
    /** Its monthly amount at the close. Meaningless — and ignored — when it was not paying then. */
    amount_at_close: number;
    /** Its plan name at the close, or `''` when the charge events do not name one. */
    plan_at_close: string;
    /** Whether it is in the paying set NOW. */
    is_paying_now: boolean;
    /** Its monthly amount now. Ignored when it is not paying. */
    amount_now: number;
    /** Its plan name now, or `''`. */
    plan_now: string;
}
