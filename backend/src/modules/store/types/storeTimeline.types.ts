/**
 * Shapes for `resolvers/storeTimeline.resolver` — the three-collection merge.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 * ──  THE EVENT ROW HERE IS NARROWER THAN THE REPOSITORY'S, DELIBERATELY ──────────────────
 *
 * `StoreDetailEventRow` carries `raw_event`. This one does NOT, and the omission is the contract:
 * the Partner charge payload has exactly one reader in this codebase — `modules/conversion`'s
 * subscription state machine — and a second file that opened the blob would be a second
 * interpretation of `billingOn`, `charge.name` and `charge.test`. The timeline gets its plan names
 * from the cohort fold's OUTPUT instead, so the same charge is named the same way here and on the
 * row. A `StoreDetailEventRow` satisfies this type structurally, so the service passes its rows
 * straight through and the extra field is simply unreachable from the resolver.
 */

import type { StoreTimelineEntry } from './storeDetail.types';
import type { StoreDetailTransactionRow } from './storeDetailData.types';
import type { StoreAttributionRow } from './storeRosterData.types';

/** The subset of a Partner event the timeline may read. */
export interface StoreTimelineEventRow {
    event_type: string;
    occurred_at: Date;
    /** Bare numeric charge id, already normalised on write. `''` means "not about a charge". */
    charge_id: string;
}

/** Every input is DATA — this resolver does no I/O and reads no clock. */
export interface StoreTimelineInput {
    /**
     * Every Partner event for the store, in any order. INCLUDING future-dated ones: they are shown
     * here and excluded from every state, which is the point of an audit surface.
     */
    events: readonly StoreTimelineEventRow[];
    /** Every settled payout for the store, in any order. Future-dated ones included, as above. */
    transactions: readonly StoreDetailTransactionRow[];
    /** Every listing-analytics install record for the store. Usually one; two means it reinstalled. */
    attribution: readonly StoreAttributionRow[];
    /**
     * Charge id → plan name, from the cohort fold's own output.
     *
     * ⚠️ Supplied rather than derived, so the plan a charge is named by on the timeline is the same
     * string the row and the plan card carry. Deriving it here would need `raw_event`.
     */
    plan_name_by_charge: ReadonlyMap<string, string>;
    /** The newest N entries to keep. Anything at or below zero is treated as "no cap". */
    limit: number;
}

/** What the merge answers. */
export interface StoreTimelineResult {
    /** NEWEST FIRST — the drawer groups by day WITHOUT sorting, so this order is the screen order. */
    entries: StoreTimelineEntry[];
    /** How many entries the cap withheld. `0` means the timeline is complete. */
    truncated: number;
}
