import { Schema, model } from 'mongoose';

/**
 * The Shopify app this whole installation reports on.
 *
 * In a self-hosted deployment there is usually exactly one of these rows, and every other
 * collection is scoped to it by `partner_app_id`. It is a row rather than a config value because
 * a partner account can hold several apps, and because the sync watermarks and coverage gates
 * below are per-app facts that have to be written back as jobs run.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE COVERAGE GATES (the second half of this schema)
 *
 * Six fields exist purely so that a figure can refuse to be published. The core promise of this
 * project is that an unanswerable question returns `null` with a reason and never `0`, and these
 * are what a service reads to know which it is holding. Without them the only thing a service can
 * see is "the query returned no rows", which is identical whether the app had no installs that
 * month or whether that month was never synced.
 *
 * All six default to `null`, meaning NOT YET MEASURED — itself an unknown, and deliberately not
 * `0`. A measured `0` is a real answer; `null` is the absence of one.
 */

// Model name (what `ref` points at) and the physical collection, stated explicitly rather than
// left to mongoose's pluraliser, so anyone querying the database by hand knows what to open.
const _modelName = 'gi_partner_app';
const _collectionName = 'gi_partner_apps';

const partnerAppSchema = new Schema(
    {
        /**
         * The handle in the App Store listing URL, e.g. `apps.shopify.com/<app_handle>`.
         *
         * Keeps its own single-field index: no compound on this schema leads with it, so nothing
         * else can serve a lookup by handle alone.
         */
        app_handle: {
            type: String,
            required: true,
            index: true
        },
        display_name: {
            type: String,
            required: true
        },
        listing_url: {
            type: String,
            required: true
        },
        /** The app's id in the Partner API. The uniqueness gate below is declared on this field. */
        partner_api_app_id: {
            type: String,
            required: true
        },
        categories: {
            type: [String],
            default: []
        },
        target_keywords: {
            type: [String],
            default: []
        },
        /**
         * No field-level `index: true`: `is_active_1` would be a STRICT PREFIX of the
         * { is_active: 1, createdAt: -1 } compound below, which serves every equality read on this
         * field as well as a single-field index would. Two indexes maintained on every write for
         * one access pattern is pure cost.
         */
        is_active: {
            type: Boolean,
            default: true
        },
        /** Watermark: end of the last successful partner-API window. Drives INCREMENTAL mode. */
        last_synced_at: {
            type: Date,
            default: null
        },
        /** Watermark for the listing-analytics rollups. */
        last_bq_synced_at: {
            type: Date,
            default: null
        },
        /**
         * Watermark for per-install attribution, deliberately separate from `last_bq_synced_at`.
         *
         * Attribution reads the whole event-parameter column, so it is a far more expensive scan
         * than the daily rollups and gets its own failure domain: an expensive failure here must
         * not rewind the rollups into re-running their backfill, and this one must be repairable
         * on its own.
         */
        last_install_attrib_synced_at: {
            type: Date,
            default: null
        },

        // ── Coverage gates ───────────────────────────────────────────────────────────────────

        /**
         * COVERAGE GATE — the oldest `occurred_at` held in `gi_partner_app_events` for this app.
         *
         * The floor of what the relationship record can answer. A question about a window opening
         * before this date has NO answer here: those events either predate what was synced or were
         * never emitted. A service that counts the zero rows it finds in that window and publishes
         * `0 installs` is stating a fact about the world it has no evidence for — it must return
         * `null` with "no partner data before <this date>" instead.
         *
         * Written at the end of each successful partner sync.
         */
        earliest_event_at: {
            type: Date,
            default: null
        },
        /**
         * COVERAGE GATE — the oldest `created_at` held in `gi_partner_app_transactions`.
         *
         * The same floor for money. Tracked separately from `earliest_event_at` because the two
         * genuinely differ: payouts settle later than the charge events that earned them, and a
         * lifetime sync of one can succeed while the other fails. Collapsing them into one "data
         * starts here" date would let a revenue figure borrow the events' coverage and publish a
         * month it has no payouts for.
         */
        earliest_transaction_at: {
            type: Date,
            default: null
        },
        /**
         * COVERAGE GATE — the oldest `occurred_at` among events that actually CARRY a
         * `shop_name`, or `null` when no row does.
         *
         *  THE BACKFILL BOUNDARY, WHICH HAD TO BE REPORTED RATHER THAN HIDDEN. `shop_name` was
         * added to `gi_partner_app_events` after the collection was in use, and it is written as
         * `$set` payload — so a sync repairs only the rows inside ITS OWN window. An INCREMENTAL
         * run (default 90-day lookback plus a 7-day overlap) therefore leaves real store names on
         * recent installs and bare domains on older ones. Unexplained, that reads as data loss;
         * explained, it is sync state with a one-command fix. This date is what lets a read service
         * say which it is:
         *
         *   "Store names are filled from the Partner API for installs synced since <date>. Run a
         *    LIFETIME Partner sync to fill in the rest — the older rows show their domain, which is
         *    not a missing name."
         *
         * COMPARE IT WITH `earliest_event_at` TO KNOW WHETHER TO SAY ANYTHING AT ALL: equal means
         * every event we hold carries a name and there is no boundary to report. A boundary that is
         * announced after it has closed teaches a reader to ignore the banner.
         *
         * `null` has two readings, separated by `earliest_event_at`: null there too means we hold
         * no events at all; a date there with null here means no sync has run since the `name`
         * selection landed, so NO row carries a name yet. There is deliberately no "zero" —
         * this is a date, and its absence is the whole message.
         *
         * ⚠️ IT IS A FLOOR, NOT A GUARANTEE OF CONTINUITY. It says the oldest named row sits here,
         * not that every row above it is named: a truncated or partial pull can leave a hole higher
         * up, and nothing measures that for names. `event_history_gap_days` measures gaps in the
         * EVENTS, not in this column.
         *
         * Written at the end of each successful partner sync, like every gate here.
         */
        shop_name_coverage_since: {
            type: Date,
            default: null
        },
        /**
         * COVERAGE GATE — when a `LIFETIME` sync last completed successfully, or `null` if none
         * ever has.
         *
         * Until this is set, these collections hold whatever an INCREMENTAL window happened to
         * pull, so every LIFETIME figure — total installs ever, all-time revenue, any cohort that
         * reaches back before the first sync — is a FLOOR, not a total. A figure that depends on
         * complete history checks this first and reports "history not backfilled" rather than
         * publishing a partial sum with a total's label on it.
         *
         * This is why `AUTO` mode exists: it resolves to LIFETIME precisely while this is null.
         */
        lifetime_sync_completed_at: {
            type: Date,
            default: null
        },
        /**
         * COVERAGE GATE — the widest gap, in whole days, between two consecutive events for this
         * app INSIDE the covered window. Recomputed at the end of each successful partner sync.
         *
         * A wide gap has two possible causes and the data alone cannot tell them apart: a
         * genuinely quiet stretch, or a sync window that failed and was never re-pulled. So it is
         * published as a caveat on any figure whose window spans it rather than resolved, because
         * resolving it would mean guessing which one it was.
         *
         * `null` = never measured. `0` is a real, meaningful value: no gap wider than a day.
         */
        event_history_gap_days: {
            type: Number,
            default: null
        },
        /**
         * COVERAGE GATE — percentage (0–100, not 0–1) of charge-bearing rows that carry NO
         * `charge_id` at all, so the money↔subscription bridge is missing by construction.
         *
         * Deliberately a SEPARATE field from `charge_link_unresolved_pct` below, because the two
         * describe different failures with different fixes. Absent means the link was never
         * captured — a sync or schema problem, repaired by re-syncing. Unresolved means it WAS
         * captured and points at nothing — a join problem, repaired by widening the other side.
         * A single combined "link quality" number would average the two into a figure that
         * suggests neither fix and hides which one is happening.
         *
         * Any per-subscription figure (trial conversion, MRR movement, revenue by plan) is only as
         * complete as this number is small, so it is published alongside them rather than kept as
         * an internal diagnostic.
         */
        charge_link_absent_pct: {
            type: Number,
            default: null
        },
        /**
         * COVERAGE GATE — percentage (0–100) of rows that DO carry a `charge_id` whose charge
         * matches nothing on the other side of the bridge.
         *
         * A dangling link, as opposed to a missing one. See the note above for why the two are
         * counted separately.
         */
        charge_link_unresolved_pct: {
            type: Number,
            default: null
        },

        metadata: {
            type: Schema.Types.Mixed,
            default: {}
        }
    },
    {
        timestamps: true
    }
);

// The active-apps list, newest first — the read behind every app picker and every cron sweep.
partnerAppSchema.index({ is_active: 1, createdAt: -1 }, { name: 'idx_active_created' });

// NAMED deliberately. An unnamed unique index resolves to the default name `partner_api_app_id_1`;
// if any other declaration on this schema ever resolves to that same default with different
// options, Mongo builds the first and REJECTS the second with IndexOptionsConflict — leaving the
// uniqueness gate SILENTLY UNBUILT while the schema still claims it. This is the gate that stops a
// second row for the same Shopify app, which would fork every downstream rollup in two.
partnerAppSchema.index({ partner_api_app_id: 1 }, { unique: true, name: 'uniq_partner_api_app_id' });

const PartnerApp = model(_modelName, partnerAppSchema, _collectionName);

export = { PartnerApp };
