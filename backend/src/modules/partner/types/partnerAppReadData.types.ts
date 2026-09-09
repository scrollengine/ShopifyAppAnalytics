/**
 * Query and row shapes for `repositories/partnerAppRead.repository`.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 * These are DATA-LAYER shapes, kept apart from the wire shapes in `partnerAppRead.types` on purpose.
 * `Model.aggregate()` returns `any[]`, and an `any` that escapes into a service takes every
 * downstream field access with it — a renamed accumulator then becomes a column of `undefined` on
 * the dashboard rather than a compile error. Flattening every raw row into one of these at the
 * repository boundary is what keeps the services' types meaningful.
 */

/** A window every read below is scoped by. `since: null` means no lower bound. */
export interface PartnerAppWindowQuery {
    partner_app_id: string;
    /** Inclusive lower bound, or null for the lifetime window. */
    since: Date | null;
    /** Inclusive upper bound. Always set. */
    until: Date;
}

/** Which calendar unit the relationship tallies are grouped by. */
export type RelationshipBucketGrain = 'day' | 'month';

/** One page of the raw event list. */
export interface PartnerAppEventPageQuery extends PartnerAppWindowQuery {
    /** An exact `event_type`, or null for every type. Already validated by the service. */
    event_type: string | null;
    /** Rows to skip. Derived from a validated 1-based page number. */
    skip: number;
    /** Rows to return. Already clamped by the service. */
    limit: number;
}

/**
 * One relationship event, projected to the five scalars the install fold reads.
 *
 * ⚠️ NO `raw_event`. `shop_name` is a promoted column precisely so this read never has to
 * deserialise a Mixed blob per event, on the largest collection in the build.
 *
 * Structurally identical to `modules/store`'s `StoreRelationshipEventRow`, and deliberately so —
 * these rows are handed straight to that module's `resolveInstallStates`, which is the one
 * definition of "is the app on this store right now". Restating the shape is what lets this module
 * declare its own read without importing another module's data-layer types.
 */
export interface PartnerRelationshipEventRow {
    /** Already canonical — normalised on write. The join key for every per-store figure. */
    shop_domain: string;
    event_type: string;
    occurred_at: Date;
    /**
     * ⚠️ OPTIONAL AND OFTEN ABSENT. The column postdates the collection and a mongoose default is
     * not retroactive, so a `.lean()` read of an older row returns NO key at all. `undefined` and
     * `''` must be treated alike, and NEITHER means "this store has no name".
     */
    shop_name?: string;
    /** The Partner GID for the shop. `''` on rows that carried none. */
    shop_id: string;
}

/**
 * Every relationship event for the app, plus what the query could not use.
 *
 * `shopless_relationship_events` exists because the blank-domain filter is LOAD-BEARING and its
 * exclusions are otherwise invisible. Drop the filter and every shopless event pools into one
 * synthetic store; keep it silently and the rows vanish with no trace. Filtering AND returning the
 * count is the only option that is neither wrong nor silent.
 */
export interface PartnerRelationshipEventResult {
    rows: PartnerRelationshipEventRow[];
    /** Relationship events whose `shop_domain` was blank or absent, and so join to no store. */
    shopless_relationship_events: number;
}

/** One raw event row as the paginated list projects it. */
export interface PartnerEventListRow {
    partner_event_id: string;
    event_type: string;
    occurred_at: Date;
    shop_domain: string;
    shop_name?: string;
    shop_id: string;
    charge_id: string;
}

/** How many rows of each kind still reference an app. Read by the soft delete, and only by it. */
export interface PartnerAppRetainedRowCounts {
    event_rows: number;
    transaction_rows: number;
}
