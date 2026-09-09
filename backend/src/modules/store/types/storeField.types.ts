/**
 * Shapes for `resolvers/storeField.resolver` — the one place two sources can disagree.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 */

import type { StoreNameSource } from './storeRoster.types';

/**
 * Every name this store has, and when each was observed.
 *
 * All optional except the domain, which is the floor and is never blank. The operator fields are
 * always empty on this deployment — `gi_store_enrichments` is a later wave — and they are declared
 * now so that landing it fills a parameter rather than changing a signature.
 */
export interface StoreNameCandidates {
    /** Canonical `shop_domain`. Required: it is the answer when nothing else has one. */
    shop_domain: string;
    /** `store_name` from an operator push. */
    operator_name?: string;
    /**
     * When the PUSHING APP observed it at the shop — not when we received it. Two clocks, kept
     * apart: a push received today can carry a value observed last month.
     */
    operator_observed_at?: Date | null;
    /** `Shop.name`, from the most recent partner event that carried the column. */
    partner_name?: string;
    /** That event's `occurred_at` — when Shopify said the store was called this. */
    partner_observed_at?: Date | null;
    /**
     * The analytics `shop_name` event param. A weaker source than either of the above: it is not
     * Shopify's `Shop.name`, and it exists only for stores the listing export saw install.
     */
    listing_name?: string;
}

/** The name to render and the source that won, published together so neither has to be inferred. */
export interface ResolvedStoreName {
    /** NEVER blank — falls back to the domain. */
    customer_name: string;
    customer_name_source: StoreNameSource;
}
