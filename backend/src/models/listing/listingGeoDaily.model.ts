// `export =` module — a named import here is TS2497, so it is imported whole and destructured.
import { Schema, model } from 'mongoose';

/**
 * One day of listing traffic, split by country.
 *
 * Grain: (partner_app_id, date, country). Upserted by the rollup sync — the same compound key
 * re-overwrites.
 *
 * ⚠️ This is TRAFFIC by country, which is NOT revenue by country. The two answer different
 * questions off different spines (visitors here, shops and money there) and will disagree; treating
 * one as a check on the other reads a real difference as an error.
 */

const _modelName = 'gi_listing_geo_daily';
const _collectionName = 'gi_listing_geo_dailies';

const listingGeoDailySchema = new Schema(
    {
        // No field-level `index: true`: it would be a strict PREFIX of the compound unique below.
        // `date` keeps its own — it leads no compound here.
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

        // Part of the unique key, so it is defaulted rather than allowed to be absent. The export's
        // own value is kept verbatim — normalising country names is a reader's job, and doing it on
        // write would make the stored value untraceable to what the export actually said.
        country: { type: String, default: '' },

        // Counts default to 0 — an absent count genuinely is zero occurrences.
        views: { type: Number, default: 0 },
        installs: { type: Number, default: 0 },

        // THE RATE DEFAULTS TO `null`, NOT `0`. installs ÷ views with no views is not "0% of
        // this country converted"; it is a rate we could not measure, and a country row with
        // installs and no views is a real shape in this export. `0` rendered as "0.00%" beside a
        // views count of 0 in the geo table, which is a claim about that country's merchants.
        // A MEASURED zero — views with no installs — still stores `0`. See the longer note on
        // `gi_listing_funnel_dailies`, and `modules/conversion/helpers/funnelMath.helper`.
        //
        // ⚠️ WRITE-ONLY, same as the funnel row's rates: `aggregateGeoBreakdown` recomputes this
        // from the SUMMED `installs`/`views` of the buckets it groups, which it has to — a mean of
        // per-day rates is not the rate of the totals. Do not read this column back expecting the
        // published figure.
        conversion_rate: { type: Number, default: null }
    },
    {
        timestamps: true
    }
);

/*
 * The idempotency gate. NAMED deliberately — an unnamed unique that collides on its default name is
 * rejected and left SILENTLY UNBUILT while the schema still claims it, and a re-synced day would
 * then append a duplicate (app, date, country) row that every country read sums twice.
 */
listingGeoDailySchema.index(
    { partner_app_id: 1, date: 1, country: 1 },
    { unique: true, name: 'uniq_app_date_country' }
);

const ListingGeoDaily = model(_modelName, listingGeoDailySchema, _collectionName);

export = { ListingGeoDaily };
