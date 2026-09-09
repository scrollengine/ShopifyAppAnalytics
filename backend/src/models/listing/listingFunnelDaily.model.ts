// `export =` module — a named import here is TS2497, so it is imported whole and destructured.
import { Schema, model } from 'mongoose';

/**
 * One day of listing-page counts, rolled up from the GA4 export.
 *
 * Grain: (partner_app_id, date). Carries NO shop identity — the SQL behind it destroys the visitor
 * id with `COUNTIF`, so this table can say "412 views on the 14th" and can never say whose.
 *
 * ⚠️ These count VISITORS. Everything from `gi_partner_app_events` onward counts SHOPS. Any ratio
 * that crosses that seam divides two different populations, which is why the funnel view marks the
 * seam rather than quietly presenting the number as a conversion rate.
 *
 * A plain collection rather than a time-series one, and the reason is the unique index below: a
 * re-synced day must overwrite its row, and a time-series collection cannot carry a unique index to
 * make that true.
 */

const _modelName = 'gi_listing_funnel_daily';
const _collectionName = 'gi_listing_funnel_dailies';

const listingFunnelDailySchema = new Schema(
    {
        // No field-level `index: true` here: `partner_app_id_1` would be a strict PREFIX of both
        // compound indexes below, each of which already leads with this field — so it would cost
        // writes and serve nothing. `date` keeps its own single-field index because it leads no
        // compound here, and nothing else can serve a date-only range read.
        partner_app_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_partner_app',
            required: true
        },
        date: {
            type: Date,
            required: true,
            index: true
        },

        // ── Counts, straight from the export ────────────────────────────────
        views: { type: Number, default: 0 },
        engaged_views: { type: Number, default: 0 },
        install_clicks: { type: Number, default: 0 },
        consent_started: { type: Number, default: 0 },
        consent_completed: { type: Number, default: 0 },
        installs: { type: Number, default: 0 },
        ad_clicks: { type: Number, default: 0 },
        first_opens: { type: Number, default: 0 },
        sessions: { type: Number, default: 0 },
        first_visits: { type: Number, default: 0 },

        // ── Rates ───────────────────────────────────────────────────────────
        // Stored as fractions (0..1), never percentages.
        //
        // `default: null`, AND THE PREVIOUS COMMENT HERE WAS THE BUG, WRITTEN DOWN. It read:
        // "Divide-by-zero resolves to 0 at write time, which is honest here: the numerator is
        // genuinely 0 as well." It is not honest, and the numerator is not genuinely 0 —
        // `ad_attributed_share` is ad_clicks ÷ INSTALLS, so a day with 40 ad clicks and no recorded
        // installs stored `0` and published "0.00% of installs were ad-attributed" over a day whose
        // denominator we never had. A rate with no denominator is UNKNOWN, and `null` is how this
        // codebase spells unknown (see `modules/conversion/helpers/funnelMath.helper`).
        //
        // ⚠️ `default: 0` is not merely a fallback: mongoose applies it on an upsert INSERT, so a
        // write that omitted the field would resurrect the zero this fix removed. Both the write
        // path and the default therefore had to change together.
        //
        // ⚠️ A MEASURED ZERO STILL STORES `0` — views with no installs really is a 0% rate — and
        // the read path must keep telling the two apart.
        //
        // ⚠️ WRITE-ONLY AS OF THIS CHANGE — DO NOT ASSUME THE STORED COLUMN IS AUTHORITATIVE.
        // Nothing reads these two back. `bigQueryAnalytics.service` re-derives both from the row's
        // OWN `installs`/`views`/`ad_clicks` through the same `rate()` the summary above them uses,
        // and it does so on purpose: every day synced before this fix still carries a literal `0`
        // written by the old `safeDiv`, and an INCREMENTAL re-sync never reaches back over those
        // days to repair them. Deriving on read fixes the history AND makes it impossible for the
        // trend line to disagree with the headline above it. They stay stored as provenance — what
        // the sync computed at write time — so a disputed figure can be compared against it.
        overall_conversion_rate: { type: Number, default: null },
        ad_attributed_share: { type: Number, default: null },

        // ── Provenance ──────────────────────────────────────────────────────
        // Which BigQuery job produced this row, and what it cost to scan. Kept so a disputed number
        // can be traced back to the exact job in the GCP console rather than re-derived by guess.
        source_bq_query_id: { type: String, default: '' },
        bytes_scanned: { type: Number, default: 0 }
    },
    {
        timestamps: true
    }
);

/*
 * The idempotency gate. NAMED deliberately: an unnamed unique resolves to the default name
 * `partner_app_id_1_date_1`, and two unnamed specs that collide on a default name make Mongo build
 * the first and REJECT the second — leaving it silently unbuilt while the schema still claims it.
 * Unbuilt here means a re-synced day APPENDS a second row instead of overwriting, and every funnel
 * read then sums both. The number doubles; nothing errors.
 */
listingFunnelDailySchema.index({ partner_app_id: 1, date: 1 }, { unique: true, name: 'uniq_app_date' });

// The read shape: one app's most recent days first.
listingFunnelDailySchema.index({ partner_app_id: 1, date: -1 }, { name: 'idx_app_date_desc' });

const ListingFunnelDaily = model(_modelName, listingFunnelDailySchema, _collectionName);

export = { ListingFunnelDaily };
