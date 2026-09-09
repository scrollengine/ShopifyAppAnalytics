// `export =` module — a named import here is TS2497, so it is imported whole and destructured.
import { Schema, model } from 'mongoose';

/**
 * One day of listing traffic, split by where the visitor came from.
 *
 * Grain: (partner_app_id, date, traffic_source, traffic_medium). Upserted by the rollup sync — the
 * same compound key re-overwrites, which is what makes a LIFETIME re-run idempotent.
 *
 * ⚠️ `traffic_source` / `traffic_medium` come from the export's `traffic_source.*`, which is the
 * visitor's FIRST-EVER acquisition — not the visit that converted. A merchant first seen organically
 * months ago who installs today from a paid ad is booked here as organic, permanently. That is the
 * export's semantics, not a bug to fix downstream, and it is why the per-install attribution table
 * exists alongside this one.
 */

const _modelName = 'gi_listing_source_daily';
const _collectionName = 'gi_listing_source_dailies';

const listingSourceDailySchema = new Schema(
    {
        // No field-level `index: true`: it would be a strict PREFIX of the compound unique below,
        // which already leads with this field. `date` keeps its own — it leads no compound here.
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

        // Defaulted to '' rather than left absent: the empty string is part of the compound unique
        // key, and a MISSING key field would let two rows for the same unattributed bucket coexist.
        traffic_source: { type: String, default: '' },
        traffic_medium: { type: String, default: '' },

        users: { type: Number, default: 0 },
        views: { type: Number, default: 0 },
        install_clicks: { type: Number, default: 0 },
        installs: { type: Number, default: 0 }
    },
    {
        timestamps: true
    }
);

/*
 * The idempotency gate behind "the same compound key re-overwrites". NAMED deliberately — see the
 * note on gi_listing_funnel_dailies: an unnamed unique that collides on its default name is
 * rejected by Mongo and left SILENTLY UNBUILT while the schema still claims it. Unbuilt here means a
 * re-synced day appends a duplicate (app, date, source, medium) row rather than upserting onto
 * itself, and that source's traffic is then double-counted.
 */
listingSourceDailySchema.index(
    { partner_app_id: 1, date: 1, traffic_source: 1, traffic_medium: 1 },
    { unique: true, name: 'uniq_app_date_source_medium' }
);

const ListingSourceDaily = model(_modelName, listingSourceDailySchema, _collectionName);

export = { ListingSourceDaily };
