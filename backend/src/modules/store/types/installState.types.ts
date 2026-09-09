/**
 * Shapes for `resolvers/installState.resolver` — the relationship-event fold.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time. These
 * are IN-MEMORY structures, not document shapes and not wire shapes: nothing here reaches the
 * response unless `resolvers/storeRow.resolver` copies it onto a row, which is where the field names
 * a component reads are decided.
 */

import type { StoreInstallState } from './storeRoster.types';
import type { StoreRelationshipEventRow } from './storeRosterData.types';

/**
 * What one store's relationship events fold to.
 *
 *  EVERY FIELD HERE IS DERIVED ON READ, AND NONE OF THEM IS STORED ANYWHERE. That is the design.
 * A stored `install_state` can only agree with the events or drift from them, and the drift is
 * invisible: the system this was extracted from read an `uninstalled_at` in three services to build
 * INSTALLED/UNINSTALLED facets that nothing ever wrote.
 */
export interface StoreInstallFold {
    /** Already canonical — the stored value IS the join key. */
    shop_domain: string;
    /** The Partner GID from the most recent event that carried one. `''` when none did. */
    shop_id: string;
    /**
     * `Shop.name` from the most recent event that carried one, `''` otherwise.
     *
     * ⚠️ `''` IS NOT "THIS STORE HAS NO NAME" — `Shop.name` is non-null upstream. It means no synced
     * event for this store carries the column yet, which a LIFETIME re-sync fixes and which
     * `gi_partner_apps.shop_name_coverage_since` measures.
     */
    partner_shop_name: string;
    /**
     * When Shopify told us the store was called `partner_shop_name` — the `occurred_at` of the event
     * the name was actually read from. `null` when no event carried one.
     *
     * ⚠️ A DIFFERENT INSTANT FROM `install_state_at`, and the difference is the whole freshness rule.
     * The deciding event is the LATEST relationship event; the naming event is the latest one that
     * carried a NAME, and a closing event routinely carries none — so `install_state_at` is at or
     * after this, never before. Feeding the deciding instant to `resolvers/storeField.resolver`
     * instead would date the partner name later than it was observed and hand it every tie against
     * an operator push, which is the one contest that resolver exists to hold fairly. Inert today
     * (`gi_store_enrichments` is a later wave, so there is no operator name to lose to); measured now
     * so that landing the ingest fills a parameter rather than discovering a wrong one.
     */
    partner_name_at: Date | null;
    install_state: StoreInstallState;
    /** Normally the state's label; `Deactivated` when the deciding event was a deactivation. */
    install_state_label: string;
    install_state_at: Date | null;
    /** The event type that decided the state, so the three-value collapse loses nothing. */
    install_state_event: string;
    installed_at: Date | null;
    latest_install_at: Date | null;
    /** ⚠️ `null` means "no uninstall event on record", NEVER "this store has not uninstalled". */
    uninstalled_at: Date | null;
    deactivated_at: Date | null;
    install_count: number;
    has_install_record: boolean;
}

/** Every input is DATA — this resolver does no I/O and reads no clock. */
export interface StoreInstallStateInput {
    /** Relationship events for the app, in any order. The fold compares timestamps explicitly. */
    events: readonly StoreRelationshipEventRow[];
    /**
     * The judgement instant. Applied as a CLAMP, so an event that has not happened yet cannot decide
     * a store's state — which in practice catches clock skew rather than the future.
     */
    as_of: Date;
}

/** Counts the service turns into `diagnostics` and `warnings[]`. Every exclusion is REPORTED. */
export interface StoreInstallStateDiagnostics {
    events_read: number;
    events_considered: number;
    /** Rows whose `shop_domain` was blank. They cannot become a store. */
    shopless_events: number;
    /** Rows with no readable `occurred_at`. Unreachable from a stored document; counted anyway. */
    undated_events: number;
    /** Rows dated AFTER the judgement instant — clock skew, or a corrupted row. Never silent. */
    future_events: number;
    /** Rows whose event type was not one of the four relationship types. */
    unrecognised_events: number;
}

/** What the fold answers. */
export interface StoreInstallStateResult {
    /** One fold per store, keyed by the canonical `shop_domain`. */
    by_domain: Map<string, StoreInstallFold>;
    diagnostics: StoreInstallStateDiagnostics;
}
