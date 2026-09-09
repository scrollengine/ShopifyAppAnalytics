'use strict';

/**
 * ============================================================================
 *  WRITING TO THE APP ROW — what may be edited, and what may never be
 * ============================================================================
 *
 *  Dependency-free by design: it imports nothing at all, so the pure patch
 *  helper and the service can both read it without dragging a layer sideways.
 *
 *  ──  WHY THERE IS A REFUSAL LIST AND NOT JUST AN ALLOW LIST ───────────────
 *
 *  An allow list alone would make every other field a silent no-op, and the two
 *  classes of "other field" are not the same kind of mistake:
 *
 *    `display_nmae`            — a typo. Nothing happens; a warning is enough.
 *    `partner_api_app_id`      — a REPOINT. The row is the scoping root for
 *                                `gi_partner_app_events`, `gi_partner_app_transactions`
 *                                and every listing rollup, all of which are keyed by
 *                                `partner_app_id` — the row's `_id`, which does NOT
 *                                change. So editing the Partner API id leaves several
 *                                million rows attached to this row while the row now
 *                                claims to be a DIFFERENT Shopify app. Every install
 *                                count, every MRR figure and every cohort on the
 *                                dashboard would silently re-label itself as belonging
 *                                to an app that never earned them, and the next sync
 *                                would then append the new app's history to the old
 *                                app's facts in one undifferentiated pile.
 *
 *  There is no repair for that: nothing on an event row records which app id it was
 *  pulled under. So the second class is REFUSED — loudly, with the whole call failing
 *  rather than partially applying — and the first is warned about.
 *
 *  ── THE COVERAGE GATES ARE MEASUREMENTS, NOT SETTINGS ──────────────────────
 *
 *  `last_synced_at`, `lifetime_sync_completed_at`, `earliest_event_at` and the four
 *  other gates are written by ONE thing: the end of a fully successful sync. They are
 *  what every figure in this build reads to decide whether it may be published at all.
 *  An endpoint that let an operator type one in would let them turn the honesty layer
 *  off by hand — `lifetime_sync_completed_at` alone flips every all-time figure from
 *  "this is a floor" to "this is a total" — so they are refused with the rest.
 * ============================================================================
 */

/**
 * The fields `PATCH /api/partner-apps/:id` may write.
 *
 * All six are DISPLAY or OPERATIONAL. None of them participates in the identity of a single stored
 * fact, so writing one cannot change what any existing figure means.
 *
 * ⚠️ `is_active` IS HERE ON PURPOSE — it is the documented REVERSAL of the soft delete. `DELETE`
 * sets it false; `PATCH { "is_active": true }` sets it back. Without it the delete would be
 * one-way, which is exactly the property a soft delete exists not to have.
 */
const PARTNER_APP_EDITABLE_FIELDS: readonly string[] = Object.freeze([
    'display_name',
    'app_handle',
    'listing_url',
    'categories',
    'target_keywords',
    'is_active'
]);

/**
 * Fields a write is REFUSED for, each with the sentence the operator reads.
 *
 * ⚠️ THE MESSAGE IS THE POINT. "Field not allowed" sends someone to the source; these say what
 * would break and where the value actually comes from, so the refusal is the end of the question
 * rather than the start of one.
 */
const PARTNER_APP_REFUSED_FIELDS: Readonly<Record<string, string>> = Object.freeze({
    partner_api_app_id: 'partner_api_app_id identifies WHICH Shopify app every stored event and payout '
        + 'belongs to. Changing it would leave this row\'s millions of existing facts in place while the row '
        + 'claimed to be a different app, so every install count, MRR figure and cohort on the dashboard would '
        + 're-label itself as another app\'s history. It comes from SHOPIFY_PARTNER_APP_ID in the backend\'s '
        + '.env and can only be changed there, followed by a restart and a LIFETIME sync.',
    app_id: 'app_id is this row\'s own identifier and is assigned by the database. Send it in the URL, not in '
        + 'the body.',
    _id: 'app_id is this row\'s own identifier and is assigned by the database. Send it in the URL, not in '
        + 'the body.',
    id: 'app_id is this row\'s own identifier and is assigned by the database. Send it in the URL, not in '
        + 'the body.',
    last_synced_at: 'last_synced_at is a WATERMARK written only by a fully successful sync. Setting it by '
        + 'hand would make the next incremental run start after a window nothing ever pulled, and the hole '
        + 'would be permanent and invisible. Run a sync instead.',
    last_bq_synced_at: 'last_bq_synced_at is a watermark written only by a fully successful listing-analytics '
        + 'sync. Run the sync instead.',
    last_install_attrib_synced_at: 'last_install_attrib_synced_at is a watermark written only by a fully '
        + 'successful install-attribution sync. Run the sync instead.',
    lifetime_sync_completed_at: 'lifetime_sync_completed_at is the gate that decides whether every all-time '
        + 'figure on this dashboard is published as a TOTAL or withheld as a FLOOR. Setting it by hand turns '
        + 'the honesty layer off over data nobody has fetched. Run a LIFETIME sync instead.',
    earliest_event_at: 'earliest_event_at is MEASURED at the end of each successful sync — it is the oldest '
        + 'event actually held. It is not a setting, and a figure that read a typed-in value would publish '
        + 'months it has no rows for.',
    earliest_transaction_at: 'earliest_transaction_at is MEASURED at the end of each successful sync. See '
        + 'earliest_event_at.',
    shop_name_coverage_since: 'shop_name_coverage_since is MEASURED at the end of each successful sync. It '
        + 'is the boundary above which real store names exist; typing one in would silence the banner that '
        + 'tells you to re-sync.',
    event_history_gap_days: 'event_history_gap_days is MEASURED at the end of each successful sync.',
    charge_link_absent_pct: 'charge_link_absent_pct is MEASURED at the end of each successful sync.',
    charge_link_unresolved_pct: 'charge_link_unresolved_pct is MEASURED at the end of each successful sync.',
    createdAt: 'createdAt and updatedAt are maintained by the database.',
    updatedAt: 'createdAt and updatedAt are maintained by the database.'
});

/** Longest a display string may be. Guards the row, not the reader — nothing renders 200 characters. */
const MAX_TEXT_FIELD_LENGTH = 200;

/** Longest a `categories` / `target_keywords` list may be. */
const MAX_LIST_FIELD_ENTRIES = 50;

/**
 * What a soft delete IS, stated on the payload rather than only in a header.
 *
 * ⚠️ Published so the answer travels with the response. An operator who calls DELETE and gets a 200
 * has every reason to assume rows went away; this is what tells them none did, and what the endpoint
 * would have to stop saying before anything could start deleting.
 */
const SOFT_DELETE_SEMANTICS = 'Deactivated, not deleted. Every stored event, payout and listing rollup is '
    + 'keyed by this app row\'s id and all of it is retained unchanged. Deactivating stops the sync cron from '
    + 'fanning out to this app and makes every sync trigger refuse it; it does not remove a single row. '
    + 'PATCH /api/partner-apps/:app_id with { "is_active": true } reverses it.';

/**
 * Why there is no hard delete, published on the same payload.
 *
 *  THE ENDPOINT REFUSES SOMETHING IT CANNOT HONESTLY DO. A cascading delete over
 * `gi_partner_app_events` and `gi_partner_app_transactions` would destroy the entire factual basis
 * of every figure this deployment has ever published, irreversibly, from a single unauthenticated-
 * looking HTTP verb — and a NON-cascading delete is worse: it would orphan those rows behind a
 * `partner_app_id` that no longer resolves, so every read would return an empty result set that is
 * indistinguishable from a business with no customers. That is precisely the failure this project
 * exists to refuse, so neither is offered.
 */
const HARD_DELETE_REFUSAL = 'There is no hard delete. Removing the app row would either destroy every event '
    + 'and payout this deployment has ever synced, or orphan them behind an id that resolves to nothing — and '
    + 'an orphaned history reads exactly like a business with no customers. To retire an app, deactivate it. '
    + 'To remove its data permanently, drop the collections yourself, deliberately, with a backup.';

export = {
    PARTNER_APP_EDITABLE_FIELDS,
    PARTNER_APP_REFUSED_FIELDS,
    MAX_TEXT_FIELD_LENGTH,
    MAX_LIST_FIELD_ENTRIES,
    SOFT_DELETE_SEMANTICS,
    HARD_DELETE_REFUSAL
};
