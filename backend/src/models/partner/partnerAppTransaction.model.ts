import { Schema, model } from 'mongoose';
// `export =` module — a named import here is TS2497, so it is imported whole and destructured.
import partnerVocab = require('../../constants/partnerVocab.constants');

const { PARTNER_TRANSACTION_TYPES } = partnerVocab;

/**
 * One settled payout, exactly as the Partner API reported it.
 *
 *  THIS COLLECTION IS CASH, NOT RUN-RATE. Everything here is money that actually moved: lumpy,
 * late, and including annual prepayments and refunds. MRR is a contracted run-rate derived from the
 * charge EVENTS, not from these rows. The two are kept strictly apart in every figure the
 * application publishes, because averaging a year's prepayment into a month — or reading a late
 * payout as a cancellation — makes both numbers wrong in ways that look plausible.
 */

const _modelName = 'gi_partner_app_transaction';
const _collectionName = 'gi_partner_app_transactions';

/** A money amount and its currency. `_id: false` — it is a value, not an entity. */
const moneySchema = new Schema(
    {
        amount: { type: Number, default: 0 },
        currency: { type: String, default: '' }
    },
    { _id: false }
);

const partnerAppTransactionSchema = new Schema(
    {
        /**
         * No field-level `index: true`: `partner_app_id_1` would be a STRICT PREFIX of all four
         * compound indexes below, every one of which leads with this field. `type` and `created_at`
         * keep theirs — neither leads a compound here, so no compound can serve a query filtering
         * on either alone.
         */
        partner_app_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_partner_app',
            required: true
        },
        /** The idempotency key for the payout ledger. Its unique index is declared below. */
        shopify_transaction_id: {
            type: String,
            required: true
        },
        type: {
            type: String,
            enum: Object.values(PARTNER_TRANSACTION_TYPES),
            required: true,
            index: true
        },
        /**
         * NORMALISED ON WRITE — bare, lowercased, no scheme, no `www.`, no trailing slash. What is
         * stored IS the join key; readers match it directly and MUST NOT normalise again. The raw
         * value survives inside `raw_transaction.shop.myshopifyDomain`.
         *
         * This is the join key for every shop-keyed money figure in the application — lifetime
         * spend, the per-store payment timeline, the revenue-by-country rollup — which is why
         * storing it raw and normalising at read time mattered here more than anywhere else: a
         * domain that failed to match did not render a smaller number, it dropped that store's
         * revenue out of the total entirely.
         */
        shop_domain: {
            type: String,
            default: ''
        },
        shop_id: {
            type: String,
            default: ''
        },
        /** What reached the developer, after Shopify's cut. */
        net_amount: {
            type: moneySchema,
            default: () => ({ amount: 0, currency: '' })
        },
        /** What the merchant was charged. Kept alongside net so the two are never conflated. */
        gross_amount: {
            type: moneySchema,
            default: () => ({ amount: 0, currency: '' })
        },
        shopify_fee: {
            type: moneySchema,
            default: () => ({ amount: 0, currency: '' })
        },
        /**
         * Shopify's own settlement timestamp — an EXTERNAL field name, mirrored as Shopify spells
         * it.
         *
         *  `created_at` (this field, when Shopify settled the money) and `createdAt` (added by
         * `timestamps`, when we inserted the row) are different facts one character apart. Every
         * window, sort and rollup over money must use THIS one. Sorting or filtering on `createdAt`
         * by accident does not error: it silently orders by sync time, so a lifetime backfill makes
         * the entire ledger look like it happened on one day.
         */
        created_at: {
            type: Date,
            required: true,
            index: true
        },
        /**
         * ANNUAL | EVERY_30_DAYS, from `AppSubscriptionSale.billingInterval`.
         *
         * This is the ONLY place Shopify exposes the billing frequency — the subscription object on
         * the charge events carries no interval — so it is what lets MRR divide an annual payment
         * by twelve instead of booking a year's revenue as a single month. Without it an annual
         * customer looks like a 12x spike followed by eleven months of churn.
         *
         * Null on rows synced before this field was requested, and on every type other than
         * APP_SUBSCRIPTION.
         */
        billing_interval: {
            type: String,
            default: null
        },
        /**
         * The charge this payout settles — the bridge from money back to the subscription that
         * earned it.
         *
         * NORMALISED ON WRITE to the BARE NUMERIC id by the strict charge-id extractor, the same
         * treatment `gi_partner_app_events.charge_id` gets, so the two join directly. Stored as a
         * GID it could join nothing: the other side holds the bare numeric form, and a mismatch
         * here matches zero rows without ever erroring.
         *
         * `''` — never null — when the type carries no charge id (only APP_SUBSCRIPTION does) or
         * when the value is unparseable, since the strict extractor refuses to pass an unrecognised
         * string through where it would silently match nothing.
         */
        charge_id: {
            type: String,
            default: ''
        },
        raw_transaction: {
            type: Schema.Types.Mixed,
            default: {}
        }
    },
    {
        timestamps: true
    }
);

// Idempotency gate for the payout ledger. NAMED deliberately: declared field-level it would be
// unnamed and resolve to the default `shopify_transaction_id_1`, and an unnamed unique that ever
// collides on its default name is rejected by Mongo and left SILENTLY UNBUILT while the schema
// still claims it. Unbuilt here means a re-sync re-inserts settled payouts, and every revenue
// figure in the application is summed straight off these rows.
partnerAppTransactionSchema.index(
    { shopify_transaction_id: 1 },
    { unique: true, name: 'uniq_shopify_transaction_id' }
);

// The payout ledger for one app, newest first.
partnerAppTransactionSchema.index({ partner_app_id: 1, created_at: -1 }, { name: 'idx_app_created' });

// The same ledger split by type — subscription revenue over time, refunds over time.
partnerAppTransactionSchema.index(
    { partner_app_id: 1, type: 1, created_at: -1 },
    { name: 'idx_app_type_created' }
);

// Serves the shop-keyed reads, which neither created_at index above could satisfy:
//   1. distinct('shop_domain', { partner_app_id, type, shop_domain: { $ne: '' } })
//      — `type` is the third key, so the predicate is checked in-index and the distinct never
//      fetches a document.
//   2. aggregate $match { partner_app_id, shop_domain } → $group by shop_domain
//      — the lifetime-spend rollup, streaming an ordered scan instead of sorting the whole ledger
//      in memory.
partnerAppTransactionSchema.index(
    { partner_app_id: 1, shop_domain: 1, type: 1 },
    { name: 'idx_app_shop_type' }
);

// THE MONEY SIDE OF THE CHARGE BRIDGE — `find({ partner_app_id, charge_id })`, i.e. "what was
// actually settled against this subscription".
//
// It is what makes the reconciliation panel cheap: contracted run-rate comes from the charge
// events, settled cash comes from these rows, and the gap between them is the diagnostic the
// Revenue page publishes rather than hides. Without this index that join is a full ledger scan per
// subscription, which is exactly why the source model shipped without one and left a note asking
// the first reader on `{ partner_app_id, charge_id }` to add it. This build has that reader from
// day one, so it is declared here.
//
// No `created_at` third key, unlike the event-side twin: the events reader needs one charge's
// lifecycle IN ORDER (earliest ACCEPTED = trial start, earliest ACTIVATED = billing start), while
// this reader sums a charge's payouts and does not care about their order.
partnerAppTransactionSchema.index({ partner_app_id: 1, charge_id: 1 }, { name: 'idx_app_charge' });

const PartnerAppTransaction = model(_modelName, partnerAppTransactionSchema, _collectionName);

export = { PartnerAppTransaction };
