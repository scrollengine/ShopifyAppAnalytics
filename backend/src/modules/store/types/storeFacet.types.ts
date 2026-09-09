/**
 * Shapes for `helpers/storeFacet.helper` — the validated facet selection, and the two structural
 * row types the shared predicates read.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 */

import type { StoreFacetGroupKey } from './storeRoster.types';

/**
 * The facet values that survived validation, per group.
 *
 *  EVERY GROUP KEY IS PRESENT, holding `[]` when the caller named none. An absent key and an empty
 * array both mean "unconstrained" to the predicate, but only the complete map lets
 * `matchesAllFacets` iterate the groups rather than a hand-written list — and a hand-written list is
 * how a group gains a checkbox and never gains a predicate.
 *
 * The values here are already validated: anything the vocabulary did not recognise was DROPPED and
 * WARNED ABOUT by the service, never passed through to match nothing.
 */
export type StoreFacetSelection = Record<StoreFacetGroupKey, string[]>;

/**
 * A validated selection for ANY list this module serves, keyed by whichever groups that list
 * publishes.
 *
 * ⚠️ Deliberately keyed by a type parameter rather than by `StoreFacetGroupKey`. The Subscriptions
 * list publishes FOUR of the roster's six groups, and typing its selection as the roster's would let
 * it be handed a `store_records` selection it has no checkbox for — a filter nobody could have asked
 * for, silently applied.
 */
export type FacetSelectionOf<TKey extends string> = Readonly<Record<TKey, readonly string[]>>;

/**
 * How a row is bucketed for one facet group.
 *
 *  THE OPTIONS AND THE PREDICATE MUST COME FROM THE SAME FUNCTION. A service tallies its checkbox
 * options by calling this over its rows and filters by calling it again, so an option that the
 * backend cannot evaluate is unrepresentable rather than merely unlikely.
 * `SubscriptionFacetFilter` states the same contract from the other side of the wire: *"every option
 * the server offers has a matching predicate on the server."*
 */
export type FacetValueOf<TRow, TKey extends string> = (row: TRow, groupKey: TKey) => string;

/**
 * The fields the SHARED facet buckets read — everything except the `states` group, which each list
 * answers in its own vocabulary.
 *
 * Structural rather than `Pick<StoreRosterRow, …>` so both list rows satisfy it without one
 * inheriting the other: the Subscriptions row deliberately does NOT carry `state`, because
 * `StoreTable._renderStatus` reads `row.state` FIRST and a lifecycle name there would badge a row
 * "Converted" underneath a tab that says "Paying".
 */
export interface StoreFacetableRow {
    install_state: string;
    /** ⚠️ `null` means "no settled payout has named a cadence", NEVER "monthly". */
    plan_interval: string | null;
    /** The operator-pushed profile. Always `null` until the enrichment wave lands. */
    operator: null;
    /** The MERCHANT'S Shopify tier. ⚠️ NOT `plan_name`, which is YOUR app's charge name. */
    shopify_plan_name: string;
}

/**
 * The fields free-text search reads. Written out rather than derived so the compiler checks every
 * one: indexing a row with a `string` types as `any`, and a renamed field would keep compiling while
 * silently ceasing to be searchable.
 */
export interface StoreSearchableRow {
    customer_name: string;
    shop_name: string;
    shop_domain: string;
    plan_name: string;
}
