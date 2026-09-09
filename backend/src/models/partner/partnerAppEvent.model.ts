import { Schema, model } from 'mongoose';
// `export =` module — a named import here is TS2497, so it is imported whole and destructured.
import partnerVocab = require('../../constants/partnerVocab.constants');

const { PARTNER_EVENT_TYPES } = partnerVocab;

/**
 * One relationship or billing event, exactly as the Partner API reported it.
 *
 * This is the spine of the whole application: install state, cohorts, trial outcomes and churn are
 * all folds over this collection, not stored states. Storing the events and deriving the state is
 * what lets a store that installed, paid and left keep its full history instead of vanishing when
 * its current-state row is overwritten.
 *
 * A REGULAR collection, deliberately NOT a time-series one. Time-series would compress better, but
 * it cannot carry a unique index — and the unique index on `partner_event_id` is the only thing
 * standing between a re-sync and a doubled install count. Service-layer dedupe (find-before-insert)
 * would be far too slow at sync time, and compression is immaterial at this scale (low thousands of
 * events per app per year). Idempotency won.
 */

const _modelName = 'gi_partner_app_event';
const _collectionName = 'gi_partner_app_events';

const partnerAppEventSchema = new Schema(
    {
        /**
         * No field-level `index: true`: `partner_app_id_1` would be a STRICT PREFIX of all four
         * compound indexes below, every one of which leads with this field. `event_type` and
         * `occurred_at` keep theirs — they appear only as second or third keys, so no compound here
         * can serve a query that filters on either alone. `shop_domain` and `charge_id` get none
         * for the opposite reason: neither is ever filtered on without an app.
         */
        partner_app_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_partner_app',
            required: true
        },
        /**
         * The idempotency key: sha256(app | typename | occurred_at | shop_id | shop_domain |
         * charge_id), computed on write.
         *
         * ⚠️ `charge_id` is in that hash for a reason that cost real data. Without it, two genuine
         * events of the same type for one shop in the same second hashed IDENTICALLY and collapsed
         * into a single row — and a plan switch is exactly that: two charge events, one second.
         * The second one vanished silently and every count built on these events under-reported by
         * it. Do not remove an input from this hash without understanding which pair of real events
         * it separates.
         *
         * `unique` is declared as a NAMED schema-level index below, not here — see that note.
         */
        partner_event_id: {
            type: String,
            required: true
        },
        event_type: {
            type: String,
            enum: Object.values(PARTNER_EVENT_TYPES),
            required: true,
            index: true
        },
        /**
         * NORMALISED ON WRITE, so what is stored here IS the join key: bare, lowercased, no scheme,
         * no `www.`, no trailing slash.
         *
         *  Readers match it directly and MUST NOT normalise a second time. The raw value Shopify
         * sent survives untouched inside `raw_event.shop.myshopifyDomain`, so canonicalising the
         * column loses nothing.
         *
         * Normalising at READ time instead is how one bridge ends up with three implementations —
         * a `.trim().toLowerCase()` in one service, a bare `.trim()` in another — and then the same
         * store joins in one report and not in another. A store that fails to join does not render
         * a smaller number; it drops out of the total entirely.
         */
        shop_domain: {
            type: String,
            default: ''
        },
        shop_id: {
            type: String,
            default: ''
        },
        /**
         * The merchant-facing store name, as the PARTNER API reports it, promoted out of
         * `raw_event.shop.name`.
         *
         * WHY IT IS HERE AT ALL. The store roster is DERIVED — folded out of this collection on
         * every Stores-page request — so a name read from the Mixed `raw_event` costs a document
         * fetch and a BSON deserialise of the whole node for every event in the install base, and
         * it can never be projected or indexed. As a top-level String it is a projectable scalar,
         * and a covering index can be declared beside `idx_app_shop_occurred` the day the roster
         * read lands, with no re-sync.
         *
         * ⚠️ THIS IS THE ONE PLACE THE DESIGN STORES SOMETHING A FOLD COULD RECOMPUTE, and it is
         * admitted only because it is an OBSERVATION — a value Shopify handed us with the event,
         * which cannot drift from anything, because nothing else derives it. Nothing else may
         * follow it in on the strength of this precedent: a stored install state, uninstall date or
         * spend total is a DERIVED value, its only possible relationship with the truth is
         * agreement or drift, and the drift is silent and directional. Re-derive that argument in
         * full before adding a second field here, or do not add one.
         *
         *  WRITTEN AS `$set` PAYLOAD, NEVER `$setOnInsert`. A field added after a collection is
         * in use and written on insert only is unbackfillable by ANY re-sync — that is exactly the
         * defect that left `billing_interval` null on every legacy transaction row and booked
         * annual subscribers at 12x, permanently. See `partnerFact.repository`.
         *
         * `''` — or ABSENT ENTIRELY on a row written before this column existed, since a schema
         * default is not retroactive and a `.lean()` read does not invent one. Neither means "this
         * store has no name": Shopify's `Shop.name` is non-null, so an unnamed shop does not exist.
         * Both mean THIS ROW PREDATES THE SYNC THAT WOULD HAVE FILLED IT, which is a fact about
         * coverage and is reported as one — see `shop_name_coverage_since` on `gi_partner_apps`.
         */
        shop_name: {
            type: String,
            default: ''
        },
        /**
         * The Shopify charge this event is about, PROMOTED out of `raw_event.charge.id`.
         *
         * `raw_event` is Mixed, so a charge id living inside it can never be indexed, and every
         * reader had to re-extract a GID in JavaScript after loading the row — which is why
         * grouping events by subscription meant scanning every charge event the app ever produced.
         *
         * Stored as the BARE NUMERIC id (GID prefix stripped by the strict charge-id extractor)
         * because `gi_partner_app_transactions.charge_id` holds that same bare numeric form — so
         * the two sides of the money↔subscription bridge join directly, with no transformation on
         * either side. A GID stored here would join NOTHING, silently.
         *
         * `''` — never null — when the event carries no charge block, or when the id is
         * unparseable. No block is the NORMAL case for the four relationship events (INSTALL,
         * UNINSTALL, REINSTALL, DEACTIVATED), which have no charge. So an empty value means "this
         * event is not about a charge", NOT "the charge is missing"; the share that is genuinely
         * missing is tracked on `gi_partner_apps.charge_link_absent_pct`. The strict extractor
         * returns null rather than passing an unrecognised string through, so a value reaching this
         * field is either a real numeric id or the empty string.
         *
         * ⚠️ It also feeds the `partner_event_id` dedupe hash — see that field.
         */
        charge_id: {
            type: String,
            default: ''
        },
        /** When Shopify says it happened. Every window in the application is cut on this field. */
        occurred_at: {
            type: Date,
            required: true,
            index: true
        },
        /**
         * The untouched Partner API node. Kept in full so a mapping decision made above — the
         * `event_type` fold, the normalised domain, the extracted charge id — can be re-derived
         * later without re-syncing, and so an `OTHER` event still carries what it actually was.
         */
        raw_event: {
            type: Schema.Types.Mixed,
            default: {}
        }
    },
    {
        timestamps: true
    }
);

// The idempotency gate this collection was shaped around — a regular collection was chosen over a
// time-series one PURELY so this could exist. NAMED deliberately: declared field-level it would be
// unnamed and resolve to the default `partner_event_id_1`, and an unnamed unique that ever collides
// on its default name is rejected by Mongo and left SILENTLY UNBUILT while the schema still claims
// it. Unbuilt here means every re-sync duplicates every event, which double-counts installs, trials
// and conversions across the entire application.
partnerAppEventSchema.index({ partner_event_id: 1 }, { unique: true, name: 'uniq_partner_event_id' });

// The per-app timeline: every event for one app, newest first.
partnerAppEventSchema.index({ partner_app_id: 1, occurred_at: -1 }, { name: 'idx_app_occurred' });

// The per-app, per-type timeline — installs over time, uninstalls over time, and every other
// single-type series the funnel and churn pages are built from.
partnerAppEventSchema.index(
    { partner_app_id: 1, event_type: 1, occurred_at: -1 },
    { name: 'idx_app_type_occurred' }
);

// Serves the two shop-keyed reads, both of which would otherwise scan this — the largest
// collection in the application — end to end:
//   1. distinct('shop_domain', { partner_app_id, shop_domain: { $ne: '' } })
//      — the store roster behind every page. With `shop_domain` as the second key this becomes a
//      DISTINCT_SCAN rather than a full scan plus a fetch of every document to read one field.
//   2. find({ partner_app_id, shop_domain }).sort({ occurred_at: -1 })
//      — one store's timeline, sorted in-index.
partnerAppEventSchema.index(
    { partner_app_id: 1, shop_domain: 1, occurred_at: -1 },
    { name: 'idx_app_shop_occurred' }
);

// THE CHARGE BRIDGE, expressible only because `charge_id` was promoted out of the Mixed
// `raw_event` above. It serves the subscription-keyed reads:
//   1. find({ partner_app_id, charge_id: { $in: [...] } }).sort({ occurred_at: 1 })
//      — every event belonging to a known set of charges, i.e. the per-subscription grouping,
//      pushed into an index instead of done in JavaScript after loading every charge event.
//   2. find({ partner_app_id, charge_id: { $ne: '' } })
//      — only the events that concern a charge at all, without enumerating the charge event types
//      and without touching the relationship rows.
// `occurred_at` is the third key because both readers want one charge's events in time order: the
// earliest ACCEPTED is the trial start and the earliest ACTIVATED is the billing start, so an
// ordered scan answers it with no in-memory sort. Declared -1 to match the others; the direction
// does not restrict the reader, since a trailing key can be walked either way.
partnerAppEventSchema.index(
    { partner_app_id: 1, charge_id: 1, occurred_at: -1 },
    { name: 'idx_app_charge_occurred' }
);

const PartnerAppEvent = model(_modelName, partnerAppEventSchema, _collectionName);

export = { PartnerAppEvent };
