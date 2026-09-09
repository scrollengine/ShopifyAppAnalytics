/**
 * The inputs and the output of the coverage measurement.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 * ── What coverage IS ─────────────────────────────────────────────────────────
 * Every figure this application publishes is a fold over `gi_partner_app_events` and
 * `gi_partner_app_transactions`. Those folds are only as true as the rows underneath them, and a
 * missing row does not announce itself — a month that was never synced and a month in which nothing
 * happened produce the identical empty result set.
 *
 * These six numbers are what lets a downstream service tell those two apart, and they are the ONE
 * fact the whole design rests on that cannot be assumed: how far back the partner history actually
 * reaches, and whether `charge_id` genuinely bridges events to transactions.
 */

/** One charge id seen on the money side, with how many settled rows carry it. */
export interface TransactionChargeRowCount {
    /** The bare numeric charge id, already normalised on write. Never a GID, never ''. */
    charge_id: string;
    /** How many transaction rows settle against it. Annual and monthly charges both recur. */
    rows: number;
}

/**
 * Everything the coverage computation needs, gathered by the repository so the helper can stay pure.
 *
 * ⚠️ Counts here are ROW counts over the whole collection for one app — not over a window. Coverage
 * describes the RECORD, not a report, so narrowing it to a window would answer a different question
 * (and a window that happens to be well covered would hide a hole outside it).
 */
export interface CoverageInputs {
    /** Oldest `occurred_at` in the event collection for this app, or null when it holds none. */
    earliest_event_at: Date | null;
    /** Oldest `created_at` in the transaction collection for this app, or null when it holds none. */
    earliest_transaction_at: Date | null;
    /**
     * Oldest `occurred_at` among events that CARRY a `shop_name`, or null when none does.
     *
     * ⚠️ "Carry" must be tested positively — `$exists: true` plus a non-empty value. A bare
     * `{ shop_name: { $ne: '' } }` also matches every row written BEFORE the column existed, since
     * a missing field is not equal to `''`. That inverts the measurement: the apps with no names at
     * all would report the fullest coverage, and the boundary banner would go quiet on exactly the
     * deployments that need it. See the repository.
     */
    earliest_named_event_at: Date | null;
    /**
     * Every distinct UTC day that carries at least one event, ASCENDING.
     *
     * Days rather than raw timestamps deliberately: the widest-gap measure is expressed in whole
     * days, and an app with 100,000 events has at most a few thousand distinct days — small enough
     * to walk in memory, which is what keeps the gap computation in a pure helper instead of a
     * `$setWindowFields` pipeline nobody can unit-test.
     */
    event_day_buckets: Date[];
    /** Rows whose event type's `charge { … }` block the sync's query actually requests. */
    charge_linked_event_rows: number;
    /** Of those, how many stored `charge_id: ''` — the link is missing, not merely unmatched. */
    charge_linked_event_rows_without_charge_id: number;
    /** Transaction rows of a type that carries a `chargeId` on the wire (APP_SUBSCRIPTION only). */
    charge_bearing_transaction_rows: number;
    /** Of those, how many stored `charge_id: ''`. */
    charge_bearing_transaction_rows_without_charge_id: number;
    /** Every distinct non-empty `charge_id` on the EVENT side — the subscriptions we know about. */
    event_charge_ids: string[];
    /** Every distinct non-empty `charge_id` on the MONEY side, with its row count. */
    transaction_charge_row_counts: TransactionChargeRowCount[];
}

/**
 * The six coverage gates, in the exact shape `gi_partner_apps` stores them.
 *
 *  Every field is nullable and `null` means NOT MEASURABLE — never zero. A `0` here is a real
 * measurement ("no gap wider than a day", "no missing charge links"), and collapsing the two would
 * defeat the entire point of measuring: a service reading `charge_link_absent_pct: 0` publishes its
 * per-subscription figures as complete, which is exactly the wrong thing to do when the truth is
 * that nobody has ever checked.
 */
export interface CoverageRecord {
    earliest_event_at: Date | null;
    earliest_transaction_at: Date | null;
    /**
     * THE STORE-NAME BACKFILL BOUNDARY — the oldest event that carries a `shop_name`, stored on the
     * app row as `shop_name_coverage_since`.
     *
     * `shop_name` is `$set` payload, so a sync fills only the window it pulled: an INCREMENTAL run
     * leaves names on recent installs and bare domains on older ones. This is what lets a read
     * service publish "names are filled for installs synced since <date>; run a LIFETIME sync for
     * the rest" instead of letting a reader discover a half-named table and conclude data was lost.
     *
     * Equal to `earliest_event_at` ⇒ every event we hold is named ⇒ say nothing. `null` alongside a
     * non-null `earliest_event_at` ⇒ no sync has run since the `name` selection landed.
     */
    shop_name_coverage_since: Date | null;
    /**
     * The longest run of consecutive EVENT-FREE days inside the covered window, or null when fewer
     * than two days carry events (there is then no pair to measure between).
     *
     * `0` means every day that has an event is adjacent to another one — no hole at all.
     */
    event_history_gap_days: number | null;
    /** 0–100, not 0–1. Null when no row could carry a charge link, so there is nothing to be absent. */
    charge_link_absent_pct: number | null;
    /** 0–100, not 0–1. Null when no settled row carries a charge id, so nothing can dangle. */
    charge_link_unresolved_pct: number | null;
}
