// `export =` module — a named import here is TS2497, so it is imported whole and destructured.
import { Schema, model } from 'mongoose';

/**
 * ONE ROW PER INSTALL EVENT — the only per-store record the listing-analytics side has.
 *
 * WHY IT EXISTS
 * -------------
 * The three daily rollups beside it are aggregate: their finest grain is a whole-app day bucket and
 * the visitor identity is destroyed in the SQL (`COUNT(DISTINCT user_pseudo_id)`). They can say
 * "3 installs came from chatgpt.com on the 14th" and can never say which stores those were.
 *
 * Shopify's App Store sends `shopify_app_install` SERVER-SIDE through the GA4 Measurement Protocol,
 * carrying `shop_id`, `shop_name` and `shop_url` as event parameters. `shop_url` is a store
 * identity, so an install event can be joined to a merchant — which makes this a BACKFILLABLE gap
 * rather than a lost one: the history is already in BigQuery, back to the export's start.
 *
 * THE JOIN
 * --------
 *     gi_listing_install_attributions.shop_domain  →  gi_partner_app_events.shop_domain
 * Both sides are normalised on write by `shared/helpers/shopDomain.helper`, so they match directly.
 * `shop_url_raw` keeps whatever the export actually sent, because the normalisation is lossy and a
 * failed join has to be diagnosable from the stored row rather than by re-querying BigQuery.
 *
 * ATTRIBUTION HONESTY
 * -------------------
 * Every attribution field carries WHICH scope produced it, in `attribution_source`. The export
 * exposes several attribution scopes that mean genuinely different things — a visitor's first-ever
 * acquisition is not the session that produced this install — and a dashboard that silently mixes
 * them is worse than one that shows nothing. An install with no attribution at all is stored as the
 * explicit value `(unattributed)`, never as `''` and never folded into `(direct)`: "we know it was
 * direct" and "we have no evidence either way" must not look alike.
 */

const _modelName = 'gi_listing_install_attribution';
const _collectionName = 'gi_listing_install_attributions';

const listingInstallAttributionSchema = new Schema(
    {
        // No field-level `index: true`: it would be a strict PREFIX of three of the four compound
        // indexes below, every one of which already leads with this field. The fourth leads with
        // shop_domain — that is the reverse join hop, not a duplicate of anything.
        partner_app_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_partner_app',
            required: true
        },

        // ── Store identity, from the install event's own parameters ─────────
        /** Normalised for joining: lowercased, trimmed, scheme and path stripped. */
        shop_domain: { type: String, required: true },
        /** Exactly what the export sent, before normalisation. Kept so a failed join is diagnosable. */
        shop_url_raw: { type: String, default: '' },
        /**
         * Shopify's numeric shop id. A number has no casing, whitespace or rename risk, so it is the
         * better join key the day anything bridges to it — stored now because it costs nothing.
         */
        shop_id: { type: String, default: '' },
        shop_name: { type: String, default: '' },

        // ── When ────────────────────────────────────────────────────────────
        installed_at: { type: Date, required: true },
        /** UTC day bucket, so a date-range grouping needs no `$dateTrunc` on every read. */
        install_date: { type: Date, required: true },

        // ── Attribution ─────────────────────────────────────────────────────
        /**
         * The export's per-visitor id, and the stitch key. The install event is sent SERVER-SIDE, so
         * its own attribution is often weaker than the browsing session that preceded it; this is
         * what lets the query look back at that visitor's earlier listing pageviews.
         */
        user_pseudo_id: { type: String, default: '' },

        source: { type: String, default: '' },
        medium: { type: String, default: '' },
        campaign: { type: String, default: '' },
        /**
         * WHICH scope the three fields above came from: `event_collected` (the visit that
         * converted), `user_first_acquisition` (how the visitor was first ever acquired), or `none`.
         * Never let two scopes look alike in storage.
         */
        attribution_source: { type: String, default: '' },

        // ── App Store surface, from the last surface-bearing touch ──────────
        /**
         * ⚠️ Shopify's documented value list is INCOMPLETE — production also carries `homepage_ad`,
         * among others. Classify paid by the `_ad` SUFFIX (`constants/surface.constants`), never by
         * equality against a known list, or a placement Shopify adds tomorrow is silently counted
         * as organic.
         */
        surface_type: { type: String, default: '' },
        /**
         * Shopify's own handle for the placement: a section handle, a category path, a collection
         * title.
         *
         * ⚠️ LOAD-BEARING, not descriptive. `isPaidPlacement` (`constants/surface.constants`)
         * reads `surface_type: home` together with `surface_detail: homepage-ads` to tell an ad
         * click from organic browsing — production carried 49 installs wearing that pair against 3
         * under the `homepage_ad` surface name. Stop storing this and those 49 re-read as organic,
         * with nothing failing anywhere to say so.
         *
         * ⚠️ THIS FIELD IS NOT A SEARCH FIELD, however it may read. On a SEARCH surface
         * (`search` / `search_ad` / `guided_search`) it carries the merchant's typed query instead
         * — which this build does not capture, and which is written `''` there. That is the whole
         * reason a reader must gate on `isSearchSurface` before interpreting the value: the two
         * meanings share one column, and Shopify's vocabulary read as merchant demand is a
         * fabricated report rather than a thin one.
         */
        surface_detail: { type: String, default: '' },
        /**
         * 1-based, and NULL when unknown rather than 0 — a 0 would average into position statistics
         * as an impossibly good rank. `inter` is which results PAGE, `intra` the position on it.
         */
        surface_inter_position: { type: Number, default: null },
        surface_intra_position: { type: Number, default: null },
        /**
         * Which mechanism carried the surface: `ad_click_event` (ad journeys only) or `listing_url`
         * (parsed off the listing URL, the only organic-capable source).
         *
         * Kept because "this app has no organic traffic" and "the organic half is not being read"
         * are otherwise indistinguishable — and in the system this was ported from, they were, for
         * months.
         */
        surface_via: { type: String, default: '' },
        /**
         * Which App Store UI variant served the listing, e.g. `simplified`. Undocumented by Shopify
         * and observed in real listing URLs. Shopify A/B-tests the store, so this is the only record
         * of which experience a merchant actually converted from — free to capture now, impossible
         * to recover if the parameter is ever dropped.
         */
        surface_version: { type: String, default: '' },
        /** Ad clicks by this visitor before installing. > 0 means paid touched an otherwise organic journey. */
        ad_clicks_before_install: { type: Number, default: 0 },

        country: { type: String, default: '' },
        locale: { type: String, default: '' },

        /** Which sync job wrote this row, for provenance on a disputed number. */
        sync_job_id: { type: String, default: '' }
    },
    {
        timestamps: true
    }
);

/*
 * One row per (app, store, install instant). A REINSTALL is legitimately a new row — the same store
 * can install more than once — while a re-synced event upserts onto itself, which is what makes a
 * LIFETIME re-run idempotent rather than duplicating every historical install.
 *
 * NAMED deliberately: an unnamed unique that collides on its default name is rejected by Mongo and
 * left silently unbuilt while the schema still claims it.
 */
listingInstallAttributionSchema.index(
    { partner_app_id: 1, shop_domain: 1, installed_at: 1 },
    { unique: true, name: 'uniq_app_shop_install' }
);

// The join hop: given a store, how did it arrive. Serves the reverse lookup without a scan.
listingInstallAttributionSchema.index(
    { shop_domain: 1, installed_at: -1 },
    { name: 'idx_shop_installed' }
);

// The two dashboard reads: installs by source over a window, and installs by surface over a window.
// Compound-from-query, partner_app_id leading.
listingInstallAttributionSchema.index(
    { partner_app_id: 1, install_date: -1, source: 1, medium: 1 },
    { name: 'idx_app_date_source' }
);
listingInstallAttributionSchema.index(
    { partner_app_id: 1, surface_type: 1, install_date: -1 },
    { name: 'idx_app_surface_date' }
);

const ListingInstallAttribution = model(_modelName, listingInstallAttributionSchema, _collectionName);

export = { ListingInstallAttribution };
