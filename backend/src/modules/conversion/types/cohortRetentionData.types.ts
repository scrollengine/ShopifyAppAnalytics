/**
 * Query and row shapes for `repositories/cohortRetention.repository`.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 * Kept apart from `cohortRetention.types.ts` for the same reason `installCohortData.types.ts` is kept
 * apart from `installCohort.types.ts`: one file describes what the DATABASE hands back and the other
 * describes what the WIRE carries, and a service that imports both can never confuse a stored shape
 * for a published one.
 */

/** The window a relationship-event pull is bounded by. */
export interface RelationshipEventQuery {
    /** Mongo `_id` of the `gi_partner_app`, as a string. */
    partner_app_id: string;
    /**
     * Lower bound, inclusive — the oldest cohort week's start.
     *
     * ⚠️ SAFE HERE, unlike on the charge-cohort pull, and the reason is worth stating: every store in
     * this population INSTALLED at or after this instant, so its uninstall (which must follow its
     * install) is inside the range too. A store whose earlier history sits before the bound is
     * described by its in-window install and nothing older can change that.
     */
    since: Date;
    /** Upper bound, inclusive — the judgement instant. An event after it has not happened yet. */
    until: Date;
}

/**
 * One relationship event, projected for `modules/store`'s install-state fold.
 *
 * ⚠️ `shop_name` and `shop_id` are projected even though this endpoint publishes neither: the fold
 * reads both to keep its own per-store identity fresh, and a missing field would make it answer with
 * blanks for callers that do want them. Projecting them costs one column each and keeps the fold's
 * contract whole rather than subtly narrowed for one caller.
 */
export interface RelationshipEventRow {
    event_type: string;
    shop_domain: string;
    shop_id: string;
    /**
     * ⚠️ OPTIONAL AND OFTEN ABSENT, matching `store/types/storeRosterData.types`. The column postdates
     * the collection and a mongoose default is not retroactive, so a `.lean()` read of an older row
     * returns NO key at all. Declaring it required here would not make it present — it would only
     * make the repository's return type a lie, and the fold that consumes these rows already treats
     * `undefined` and `''` alike.
     */
    shop_name?: string;
    occurred_at: Date;
}
