/**
 * What `resolvers/storeRow.resolver` is handed for one store.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 *  EVERY MEMBER EXCEPT `shop_domain` IS OPTIONAL, and that is the contract rather than laziness:
 * each one is a LEFT JOIN onto the roster, and NO JOIN MAY REMOVE A ROW. A store with no
 * subscription is `INSTALLED` — a state, not a gap. A store with no attribution record is
 * `has_attribution: false`, which renders as "Not attributed" and never as "Direct". A store with no
 * payouts has `total_spend: null`, not `0`. Typing any of these as required would make the row
 * builder's own signature disagree with the design.
 */

import type { CohortSubscription } from '../../conversion/types/lifecycle.types';
import type { StoreInstallFold } from './installState.types';
import type { StoreAttributionRow, StoreSpendRow } from './storeRosterData.types';

export interface StoreRowInput {
    /** Canonical, never blank. The row identity and every join key. */
    shop_domain: string;
    /**
     * The relationship-event fold, or nothing.
     *
     * ABSENT IS A REAL CASE: a store known only from a charge event or a settled payout, whose
     * install predates the synced window. It renders `install_state: 'UNKNOWN'` and
     * `has_install_record: false` — an absence of evidence, never "the app is not installed".
     */
    install?: StoreInstallFold;
    /** The store's winning subscription — latest trial start — or nothing at all. */
    subscription?: CohortSubscription;
    /** The attribution record nearest in time to the install instant, or nothing. */
    attribution?: StoreAttributionRow | null;
    /** The lifetime payout rollup, or nothing when this store has never settled one. */
    spend?: StoreSpendRow;
    /**
     * The cadence from a settled payout for THIS subscription's own charge, or `null`.
     *
     * ⚠️ Per charge, never per domain. A store with two subscriptions must not have one's cadence
     * attached to the other, and a charge-less subscription gets `null` rather than borrowing.
     */
    plan_interval?: string | null;
    /**
     * The monthly run-rate from the canonical MRR predicate, or `null` when this store has never
     * settled a subscription payout at all.
     *
     * `0` and `null` are DIFFERENT ANSWERS here: `0` is "they settled once and are outside their
     * billing window now", `null` is "there is nothing to evaluate".
     */
    monthly_spend?: number | null;
    /** Whether any settled `APP_SUBSCRIPTION` payout exists for this store, at any time. */
    has_subscription_payout?: boolean;
}
