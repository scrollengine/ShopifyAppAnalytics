/**
 * Shapes for `helpers/ledgerMrr.helper` — the settled-payout view of "who is paying us".
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 * These describe the in-memory structures the MRR ledger passes around: the flattened charge rows,
 * the as-of live set, and the month-over-month movement built from two of them. They are NOT
 * document shapes — for what the collections persist, see `shared/types/entity.types`.
 */

import type { ObjectIdLike } from '../../shared/types/entity.types';

/**
 * One settled subscription charge, as `fetchSubscriptionChargeHistory` flattens it out of
 * `gi_partner_app_transaction`. Returned NEWEST FIRST — the as-of predicate relies on that order to
 * accept the first row it sees per shop.
 */
export interface SubscriptionChargeRow {
    shop_id: string;
    shop_domain: string;
    /** `gross_amount.amount` — what the MERCHANT paid, so it is the merchant-facing price. */
    gross: number;
    currency: string;
    /** ANNUAL | EVERY_30_DAYS | null. Null on rows synced before the field was requested. */
    billing_interval: string | null;
    created_at: Date;
}

/** A shop's paying position at one instant, valued at its most recent settled charge. */
export interface PayingShop {
    shop_id: string;
    shop_domain: string;
    /** The charge normalised to a monthly run-rate — an ANNUAL charge divided by 12. */
    monthly_amount: number;
    /** The charge exactly as billed, un-normalised. */
    charged_amount: number;
    currency: string;
    billing_interval: string | null;
    last_charged_at: Date;
}

/**
 * The set of shops paying as-of an instant, keyed by `shop_id`.
 *
 * Never holds a null: `liveSetAsOf` tombstones a disqualified shop with one DURING construction so
 * an older charge cannot fall through and make it look live again, then deletes every tombstone
 * before returning.
 */
export type LiveSet = Map<string, PayingShop>;

/**
 * The subset of a paying shop that `diffMonths` actually reads.
 *
 * Declared separately from `PayingShop` because more than one producer can feed the diff — the
 * payout ledger here, and any future subscription state machine — and only these fields are common
 * to all of them. A `LiveSet` satisfies it, so the ledger callers are unaffected; typing the
 * parameter as `PayingShop` instead would reject a second producer that is correct at run time, and
 * typing it as `any` would hide the next one that forgets a field.
 */
export interface MovementShop {
    monthly_amount: number;
    shop_domain?: string;
    plan_name?: string;
    paid_from?: Date | null;
    churn_date?: Date | null;
}

/** A set of shops paying as-of an instant, from either producer, keyed by the producer's own id. */
export type MovementSet = Map<string, MovementShop>;

/**
 * One shop that stopped paying between two as-of live sets.
 *
 * Everything past `lost_mrr` is carried through from the shop's last paying month rather than
 * re-derived: the shop is ABSENT from the month it churned in, so that is the only place the
 * information still exists.
 */
export interface ChurnedShop {
    shop_id: string;
    shop_domain: string;
    lost_mrr: number;
    /** Empty when neither the charge nor the store record named a plan. */
    plan_name: string;
    /** When it started paying, and when it cancelled. Null when the producer does not track them. */
    paid_from: Date | null;
    churn_date: Date | null;
}

/**
 * MRR movement between two as-of live sets. The categories are mutually exclusive and reconcile
 * exactly: end = start + new + expansion - contraction - churned.
 */
export interface MrrMovement {
    start_mrr: number;
    end_mrr: number;
    new_mrr: number;
    expansion_mrr: number;
    contraction_mrr: number;
    churned_mrr: number;
    churned_shops: ChurnedShop[];
}

/** Input to `fetchSubscriptionChargeHistory`. */
export interface FetchSubscriptionChargeHistoryInput {
    /** Mongo _id of the gi_partner_app. */
    partner_app_id: ObjectIdLike;
}

/** Input to `fetchCurrentPayingShops`. */
export interface FetchCurrentPayingShopsInput {
    partner_app_id: ObjectIdLike;
    /** Live window for monthly cadences. Annual charges use `ANNUAL_LIVE_WINDOW_DAYS` instead. */
    windowDays: number;
    now?: Date;
}

/** Input to `fetchMonthlyLiveSets`. */
export interface FetchMonthlyLiveSetsInput {
    partner_app_id: ObjectIdLike;
    /** First instant of each month, ascending. */
    monthStarts: Date[];
    windowDays: number;
    now?: Date;
}
