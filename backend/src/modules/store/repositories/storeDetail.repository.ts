'use strict';

/**
 * ============================================================================
 *  ONE STORE'S RECORD — three store-scoped reads, and why they may afford what
 *  the roster's cannot
 * ============================================================================
 *
 *  The second of this module's two files that touch the model layer, and it does so through the same
 *  single chokepoint at `modules/shared/repositories/models.repository`. Four reads, all scoped to
 *  ONE app and to one store or its charges:
 *
 *    1. every Partner EVENT for the store   — the timeline, the install fold and the charge cohort
 *    2. every settled PAYOUT for the store  — the money fold and the payout entries on the timeline
 *    3. every ATTRIBUTION row for the store — how it arrived
 *    4. every event for the store's CHARGES —  the domain-less end events read 1 cannot see
 *    5. every payout for the store's CHARGES —  the domain-less settled evidence read 2 cannot see
 *
 *  The app row itself is NOT re-read here. `storeRoster.repository.findPartnerAppById` already
 *  answers that, and the service calls it: one function, one definition, two callers. A second copy
 *  would be a second projection of the watermarks that decide whether either endpoint may answer at
 *  all.
 *
 *  ──  `raw_event` IS PROJECTED HERE, AND THAT IS NOT A RELAXATION OF THE ROSTER'S RULE ────
 *
 *  `storeRoster.repository` refuses the blob for its relationship read, and its header explains the
 *  cost: `raw_event` is Mixed and holds the whole Partner node, so pulling it for every relationship
 *  event in the install base multiplies the bytes on the wire by an order of magnitude. The
 *  population is what makes that expensive — hundreds of thousands of events — and it is exactly
 *  what is different here. ONE STORE has tens of events, and `charge.billingOn`, `charge.name`,
 *  `charge.amount` and `charge.test` live NOWHERE ELSE: without the blob every trial end on this
 *  panel is null, every plan name blank, and every test charge indistinguishable from a real one.
 *
 *  ──  NO EVENT-TYPE `$in`, AND NO `$lte` ON EITHER READ. BOTH ARE DELIBERATE. ─────────────
 *
 *  NO TYPE FILTER, because this is a RECORD and not a metric. The roster fetches four relationship
 *  types and the subscription types; the timeline has to show `ONE_TIME_CHARGE_ACCEPTED`,
 *  `USAGE_CHARGE_APPLIED` and the `OTHER` catch-all too — a `__typename` this build does not model
 *  is STORED rather than dropped (see `partnerVocab.constants`) precisely so it can be seen, and
 *  filtering it out of the one screen built to display everything turns a known unknown back into an
 *  unknown one.
 *
 *  NO UPPER TIME BOUND, because the fold applies it and REPORTS it. The roster bounds its
 *  aggregations in the query, and its header states why that matters: unbounded, a payout that
 *  settles tomorrow is evidence today, and the error runs one way only. That bound is not weakened
 *  here — it is MOVED into `helpers/storeSpend.helper` and `resolvers/installState.resolver`, which
 *  clamp AND count. A `$lte` here would delete a future-dated row from the timeline as well as from
 *  the totals, and a future-dated row is a clock-skew diagnostic an operator can act on. ⚠️ COPYING
 *  EITHER FUNCTION BELOW INTO AN APP-SCOPED READ WITHOUT RESTORING THE BOUND WOULD REINTRODUCE THE
 *  DEFECT THE ROSTER'S HEADER DESCRIBES.
 *
 *  ── What is NOT here ────────────────────────────────────────────────────────
 *  No judgement. Which name wins, whether the store counts as installed, what an empty result means
 *  — all of that belongs to the resolvers and the service, because those are what a test reaches,
 *  and it must be possible to reach them without a database.
 * ============================================================================
 */

import models = require('../../shared/repositories/models.repository');

import type {
    StoreDetailChargeQuery,
    StoreDetailEventRow,
    StoreDetailQuery,
    StoreDetailTransactionRow
} from '../types/storeDetailData.types';
import type { StoreAttributionRow } from '../types/storeRosterData.types';

const {
    PartnerAppEventModel,
    PartnerAppTransactionModel,
    ListingInstallAttributionModel
} = models;

/**
 * EVERY Partner event for one store, newest first.
 *
 * ⚠️ `shop_domain` IS MATCHED DIRECTLY. Both sides of this join are canonicalised on write, so the
 * stored value IS the key; the caller normalises its NEEDLE once (a client may send a raw URL) and
 * nothing re-normalises the stored value — that is the waste the guarantee exists to remove, and the
 * real risk is the inverse, where someone later "tidies" the normalisation off the write side and
 * the read side no longer catches it.
 *
 * `find`, not `aggregate`, so mongoose auto-casts the app id. The aggregate hazard — an uncast
 * string matching zero documents with no error — does not arise on this path, and the sort is served
 * from the index rather than done in memory.
 *
 * Served by `idx_app_shop_occurred` = `{ partner_app_id, shop_domain, occurred_at: -1 }`, which the
 * event model declares for exactly this read: *"find({ partner_app_id, shop_domain }).sort({
 * occurred_at: -1 }) — one store's timeline, sorted in-index."*
 *
 * @param params0 - See {@link StoreDetailQuery}.
 * @param params0.partner_app_id - The app.
 * @param params0.shop_domain - The store, ALREADY canonical.
 * @returns Every event, newest first.
 */
const findStoreEvents = async ({ partner_app_id, shop_domain }: StoreDetailQuery): Promise<StoreDetailEventRow[]> => {
    return PartnerAppEventModel.find({ partner_app_id, shop_domain })
        .select('partner_event_id shop_domain event_type occurred_at charge_id shop_id shop_name raw_event')
        .sort({ occurred_at: -1 })
        .lean<StoreDetailEventRow[]>();
};

/**
 *  THE SECOND EVENT READ, AND IT IS NOT AN OPTIMISATION — IT IS A CORRECTNESS FIX.
 *
 * Every event belonging to a known set of CHARGES, whatever domain the row carries. It exists because
 * the read above is domain-keyed and one class of row has no domain to key on:
 * `gi_partner_app_events`'s own model note records that a `SubscriptionChargeCanceled` for a shop
 * Shopify redacted between the install and the cancellation carries no `shop_domain` at all. Without
 * this pass that subscription never receives an end event, so it never churns — the drawer would show
 * CONVERTED over a table row that says CHURNED, which is the exact divergence this module reuses one
 * fold to prevent.
 *
 * ⚠️ THE ROSTER NEEDS NO EQUIVALENT. Its charge pull is APP-scoped, so every such row is already
 * inside its single query and a second pass would have nothing left to find. The asymmetry is the
 * scope, not a difference of opinion about the data.
 *
 * ⚠️ THE CALLER MUST FILTER WHAT COMES BACK to rows whose `shop_domain` is empty or this store's. A
 * charge id belongs to one shop in practice, but "in practice" is not a constraint the database
 * enforces, and admitting another store's row here would put its cancellation on this store's
 * timeline.
 *
 * Served by `idx_app_charge_occurred` = `{ partner_app_id, charge_id, occurred_at: -1 }`, which the
 * event model declares for exactly this read: *"find({ partner_app_id, charge_id: { $in: [...] } })
 * — every event belonging to a known set of charges."*
 *
 * @param params0 - See {@link StoreDetailChargeQuery}.
 * @param params0.partner_app_id - The app.
 * @param params0.charge_ids - Bare numeric charge ids. MUST be non-empty; an
 *   empty `$in` matches nothing and the caller is expected to skip the read entirely rather than
 *   issue one that cannot answer.
 * @returns Every event for those charges, newest first.
 */
const findEventsForCharges = async (
    { partner_app_id, charge_ids }: StoreDetailChargeQuery
): Promise<StoreDetailEventRow[]> => {
    return PartnerAppEventModel.find({ partner_app_id, charge_id: { $in: charge_ids } })
        .select('partner_event_id shop_domain event_type occurred_at charge_id shop_id shop_name raw_event')
        .sort({ occurred_at: -1 })
        .lean<StoreDetailEventRow[]>();
};

/**
 * EVERY settled payout for one store, newest first.
 *
 * All types, including `APP_CREDIT` and `APP_ADJUSTMENT`, which are negative money: "total spend"
 * net of refunds is the honest reading of what a store has paid, and a lifetime figure that excluded
 * credits would be larger than the money that actually changed hands.
 *
 * ⚠️ Sorted on `created_at` — Shopify's SETTLEMENT instant — never `createdAt`, which `timestamps`
 * writes when WE inserted the row. Sorting on the wrong one does not error: it orders by sync time,
 * so a lifetime backfill makes the whole ledger look like it happened on one day.
 *
 * Served by `idx_app_shop_type` = `{ partner_app_id, shop_domain, type }`. The sort is a small
 * in-memory one over a single store's rows rather than an index walk, which is the right trade at
 * this cardinality — the alternative is a fourth index declared for one screen.
 *
 * @param params0 - See {@link StoreDetailQuery}.
 * @param params0.partner_app_id - The app.
 * @param params0.shop_domain - The store, ALREADY canonical.
 * @returns Every payout, newest first.
 */
const findStoreTransactions = async (
    { partner_app_id, shop_domain }: StoreDetailQuery
): Promise<StoreDetailTransactionRow[]> => {
    return PartnerAppTransactionModel.find({ partner_app_id, shop_domain })
        .select('type shop_domain charge_id billing_interval gross_amount net_amount created_at')
        .sort({ created_at: -1 })
        .lean<StoreDetailTransactionRow[]>();
};

/**
 *  THE OTHER HALF OF THE SAME FIX — the settled evidence a domain-keyed payout read cannot see.
 *
 * `findEventsForCharges` recovers a cancellation whose shop was redacted. This recovers the PAYOUT
 * with the same problem, and it matters for exactly one branch of the subscription state machine: a
 * subscription Shopify gave no `billingOn` for is decided by whether money PROVABLY moved against
 * its charge. The roster gets this for free — `aggregateSettledSubscriptionCharges` groups by charge
 * with NO domain filter, so a payout carrying no `shop_domain` still marks that charge as settled —
 * and a per-store read keyed on the domain would not. The store would then read CONVERTED on the
 * roster and ON_TRIAL in the drawer over it.
 *
 * ⚠️ WHAT COMES BACK IS EVIDENCE, NOT MONEY. The caller must take ONLY the rows whose `shop_domain`
 * is empty (rows naming this store are already in the domain-keyed read, and rows naming another are
 * not this store's), and must let them contribute ONLY to the settled-charge set and the per-charge
 * cadence — never to a total, a count, a currency or the MRR row. That is not a nicety: the roster's
 * own spend aggregation excludes blank-domain payouts explicitly, because a payout that names no
 * shop cannot be attributed to one, and admitting it here would make this store's lifetime total
 * disagree with the same store's total on the list behind the panel.
 *
 * Served by `idx_app_charge` = `{ partner_app_id, charge_id }`.
 *
 * @param params0 - See {@link StoreDetailChargeQuery}.
 * @param params0.partner_app_id - The app.
 * @param params0.charge_ids - Bare numeric charge ids. MUST be non-empty.
 * @returns Every payout for those charges, newest first.
 */
const findTransactionsForCharges = async (
    { partner_app_id, charge_ids }: StoreDetailChargeQuery
): Promise<StoreDetailTransactionRow[]> => {
    return PartnerAppTransactionModel.find({ partner_app_id, charge_id: { $in: charge_ids } })
        .select('type shop_domain charge_id billing_interval gross_amount net_amount created_at')
        .sort({ created_at: -1 })
        .lean<StoreDetailTransactionRow[]>();
};

/**
 * Every listing-analytics install record for one store, oldest first.
 *
 * A store that installed twice has two rows, and choosing between them is a judgement —
 * nearest-in-time to the Partner install instant, which `shared/helpers/attributionMatch.helper`
 * owns — so all of them are returned and the pick happens above the repository. The TIMELINE shows
 * every one of them, which is the other reason not to pre-pick here: an install the analytics export
 * saw twice is a fact about the export.
 *
 * Served by `uniq_app_shop_install` = `{ partner_app_id, shop_domain, installed_at }`.
 *
 * @param params0 - See {@link StoreDetailQuery}.
 * @param params0.partner_app_id - The app.
 * @param params0.shop_domain - The store, ALREADY canonical.
 * @returns Every record, oldest first.
 */
const findStoreAttributionRows = async (
    { partner_app_id, shop_domain }: StoreDetailQuery
): Promise<StoreAttributionRow[]> => {
    return ListingInstallAttributionModel.find({ partner_app_id, shop_domain })
        .select('shop_domain shop_name installed_at source medium campaign attribution_source '
            + 'surface_type surface_detail surface_inter_position surface_intra_position country')
        .sort({ installed_at: 1 })
        .lean<StoreAttributionRow[]>();
};

export = {
    findStoreEvents,
    findEventsForCharges,
    findStoreTransactions,
    findTransactionsForCharges,
    findStoreAttributionRows
};
