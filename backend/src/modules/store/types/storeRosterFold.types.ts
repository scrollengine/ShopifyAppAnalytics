/**
 * ============================================================================
 *  WHAT THE ROSTER FOLD ANSWERS — the one population two pages are drawn from
 * ============================================================================
 *
 *  Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 *  These are IN-MEMORY structures, not document shapes and not wire shapes. Nothing here reaches a
 *  response unless a service copies it onto a payload, which is where the field names a component
 *  reads are decided.
 *
 *  ──  WHY THE FOLD IS A SHAPE AT ALL, RATHER THAN A PRIVATE BLOCK IN ONE SERVICE ──────────
 *
 *  `GET /api/stores` and `GET /api/subscriptions` render the SAME store rows, through the same
 *  `StoreTable`, into the same detail drawer. They differ in exactly two things: which stores are in
 *  the population, and which vocabulary the status column speaks. Everything before that — five
 *  reads, the install-state fold, the charge cohort, the canonical MRR predicate, the attribution
 *  join, the row build and every exclusion counter — is one computation, and the moment it exists
 *  twice the two pages can disagree about a merchant while both look correct.
 *
 *  That is not hypothetical: `modules/revenue/index.ts` records what happened the last time the
 *  paying-set logic was reachable only by copying it — two pages reconstructed MRR independently and
 *  disagreed with each other. `paying_by_domain` below is the SAME `liveSetAsOf` answer both
 *  services use, handed over rather than re-derived, so "who is paying us" has one definition on
 *  both pages by construction.
 * ============================================================================
 */

import type { CohortSubscription } from '../../conversion/types/lifecycle.types';
import type { PayingShop } from '../../revenue/types/ledgerMrr.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { StoreSpendRow } from './storeRosterData.types';
import type {
    StoreAttributionState,
    StoreDataState,
    StoreRosterRow
} from './storeRoster.types';

/** What `resolvers/storeRoster.resolver` is asked for. The clock is the CALLER's, always. */
export interface StoreRosterFoldQuery {
    /** The app to fold. A missing app is `null`, not a throw — the service words the refusal. */
    partner_app_id: string;
    /**
     * THE ONE JUDGEMENT INSTANT.
     *
     * ⚠️ Read from the clock ONCE, by the service, and threaded into every read and every fold below
     * it. Without that a single response classifies one store as of two different milliseconds — the
     * payout rollup, the state machine and the install fold each answering at their own — and a
     * store can be simultaneously CHURNED and paying.
     */
    as_of: Date;
}

/**
 * Everything the fold excluded or could not resolve, as counts.
 *
 * ⚠️ EVERY NUMBER HERE IS ALSO A WARNING. The counters exist so a service can say what its list does
 * not contain; a count that reaches `diagnostics` and never reaches `warnings[]` is an exclusion the
 * operator cannot see, which is the same as not counting it.
 */
export interface StoreRosterFoldDiagnostics {
    /** Relationship events dropped for a blank `shop_domain`. They can join nothing. */
    shopless_relationship_events: number;
    /** Relationship events dated AFTER the judgement instant. Clock skew, or a corrupted row. */
    future_relationship_events: number;
    /** Stores with no install/reinstall event — known from money or a charge alone. */
    stores_without_install_record: number;
    /** Attribution rows naming a domain the Partner API has no record of, so they became no row. */
    attribution_rows_without_partner_record: number;
    /** Stores whose payouts arrived in more than one currency, so `total_spend` sums unlike units. */
    stores_with_mixed_spend_currency: number;
    /** Rows shown as "On trial" on the weakest evidence available. ⚠️ Warn; never silent. */
    inferred_state_rows: number;
    /** Rows whose subscription state could not be mapped. A defect in this build, reported as one. */
    unclassified_subscription_rows: number;
    /** Subscription events skipped for carrying neither a charge id nor a shop domain. */
    skipped_keyless_subscription_events: number;
    /** Distinct test SUBSCRIPTIONS excluded. ⚠️ Asymmetric — relationship events carry no test flag. */
    test_subscriptions_excluded: number;
}

/**
 * The whole population, folded once, before any caller has filtered, counted, sorted or paged it.
 *
 *  `rows` IS THE ONLY ARRAY. Every count a service publishes must be a fold over this same array —
 * there is no second `countDocuments` and no second aggregation anywhere downstream. Two queries
 * that answer the same question are two answers that will eventually differ, and the one on screen
 * will be whichever the reader happened to look at.
 */
export interface StoreRosterFold {
    /** The app row — its watermarks and its coverage gates. Never null; a missing app is `null` here. */
    app: PartnerAppDoc;
    /** Echoed back so a caller cannot accidentally publish an `as_of` it did not fold against. */
    as_of: Date;
    /** Every store the PARTNER API has any record of, in ascending `shop_domain` order. */
    rows: StoreRosterRow[];
    /**
     * THE canonical "who is paying us and how much" answer, keyed by `shop_domain`, evaluated at
     * `as_of`.
     *
     *  `modules/revenue`'s `liveSetAsOf`, reached through that module's barrel and NOT re-derived.
     * `GET /api/subscriptions` takes its entire population from this map, and every `monthly_spend`
     * on a row above came from it too, so the Subscriptions list, the Stores list and the Revenue
     * page cannot disagree about who is paying.
     *
     * ⚠️ `shop_id` on each `PayingShop` HOLDS THE DOMAIN, deliberately — see the resolver, which
     * explains why the ledger's own key field is fed a domain here.
     */
    paying_by_domain: Map<string, PayingShop>;
    /**
     * The store's WINNING subscription — latest trial start — keyed by `shop_domain`. A store with no
     * subscription we can find is simply absent from this map.
     *
     * Published because the roster row keeps only what the Stores table renders, and the
     * Subscriptions list needs two more facts off the same object: the SUBSCRIPTION-vocabulary state
     * its tabs speak, and `trial_start`, which it publishes as `activation_date`. Handing the map
     * over costs nothing and is the alternative to adding two fields to a shipped response that no
     * component on the Stores page would read.
     */
    subscriptions_by_domain: Map<string, CohortSubscription>;
    /**
     * The settled-payout rollup per store, keyed by `shop_domain`. Absent for a store with no payouts.
     *
     *  PUBLISHED FOR THE **NET** FIGURE, WHICH THE ROW DOES NOT CARRY. `StoreRosterRow.total_spend`
     * is GROSS — what merchants paid — and the country rollup has to publish net beside it, because
     * `CountryTable` names both columns out loud after the two disagreed on adjacent screens: this
     * table summed gross while the Revenue page's lifetime card showed net, so one word named two
     * different numbers and one of them looked broken.
     *
     * Handed over rather than re-aggregated, and rather than adding a `net_spend` field to the roster
     * row: the row is a SHIPPED response shape that no component on the Stores page would read that
     * field from, and a second aggregation of the same collection is a second answer to one question.
     */
    spend_by_domain: Map<string, StoreSpendRow>;
    /**
     * Domains whose settled payouts arrived in more than one currency, so their `total_spend` is a
     * sum of unlike units — this build holds no exchange rates.
     *
     *  A SET RATHER THAN A COUNT, because two callers need two different tallies of one condition:
     * the roster warns about all of them and the Subscriptions list warns only about the merchants
     * it actually lists. A count would have forced the second caller to re-derive the condition from
     * `spend_currency === ''`, which is NOT the same test — that value is also `''` for a store whose
     * payouts named no currency at all — and a second, subtly different definition is exactly what
     * this wave exists to avoid. `diagnostics.stores_with_mixed_spend_currency` is this set's size.
     */
    mixed_spend_currency_domains: Set<string>;
    /** The PARTNER tier's state, decided by the WATERMARK and never by the row count. */
    data_state: StoreDataState;
    /** Why acquisition may be empty: `READY` | `NOT_CONNECTED` | `NEVER_SYNCED`. Never a refusal. */
    attribution_state: StoreAttributionState;
    /**
     * The BigQuery availability sentence, VERBATIM, or `''` when the tier is connected.
     *
     * Carried rather than re-derived so the operator-facing warning names the actual missing
     * environment variables instead of a paraphrase that drifts from them.
     */
    attribution_message: string;
    diagnostics: StoreRosterFoldDiagnostics;
}
