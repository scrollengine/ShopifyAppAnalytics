'use strict';

/**
 * ============================================================================
 *  THE STORE ROSTER — five reads, no roster collection, and the cost of that
 * ============================================================================
 *
 *  The ONLY file in this module that touches the model layer, and it does so through the single
 *  chokepoint at `modules/shared/repositories/models.repository`. Five reads, all app-scoped, all
 *  lifetime:
 *
 *    1. the app row                — its watermarks and its coverage gates
 *    2. the RELATIONSHIP EVENTS    — install / reinstall / uninstall / deactivate: the population
 *    3. the charge events          — every subscription signal, bounded above at the judgement instant
 *    4. the settled payouts        — twice: per charge (state + cadence) and per shop (spend)
 *    5. the attribution rows       — the listing-analytics record of how each store arrived
 *
 *  ──  THERE IS NO `gi_stores` COLLECTION, AND THIS IS WHERE THAT COSTS SOMETHING ──────────
 *
 *  Every field on a store row is DERIVED ON READ. A materialised roster would store a derivable
 *  value, so its only possible relationship with truth is agreement or drift — and the drift is
 *  invisible and directional: store sync at 02:00, partner sync at 02:30, a shop uninstalls at
 *  02:15, and `install_state: 'INSTALLED'` stands for twenty-four hours on a page whose entire
 *  purpose is "who has my app right now". `gi_partner_app_events` already states the rule
 *  (`partnerAppEvent.model.ts:10-13`): install state, cohorts, trial outcomes and churn are FOLDS,
 *  never stored states.
 *
 *  THE HONEST COST, STATED: the Stores page folds the whole install base on every request. Measured
 *  shape — roughly 40k lifetime installs at 6-8 relationship events each ≈ 280k index entries,
 *  folding in the low hundreds of milliseconds warm, which is fine for a single-operator dashboard.
 *  ABOVE ROUGHLY 250k RELATIONSHIP EVENTS IT STOPS BEING COMFORTABLE. The escape ladder, in order:
 *
 *    (a) promote `shop_name` to a column so the fold never reads the Mixed `raw_event` — DONE, and
 *        it is why `_readRelationshipEvents` projects five scalars and no blob;
 *    (b) add a covering index `{partner_app_id, event_type, shop_domain, occurred_at: -1}` so the
 *        relationship fold is served from the index alone. ⚠️ It covers the four keys and NOT
 *        `shop_name`, so a covering scan means dropping the name from this projection and resolving
 *        it from the attribution side only — the rung is real, but it is a trade, not a free win;
 *    (c) publish `install_state_counts: null` WITH A REASON and serve the paginated list alone.
 *
 *   NEVER MATERIALISE THE ROSTER TO MAKE A COUNT CHEAP. Serving a stale count instead of an honest
 *  refusal is precisely the trade this project exists not to make, and rung (c) exists so that
 *  refusing is always available.
 *
 *  ──  A JS FOLD, NOT AN AGGREGATION PIPELINE — the decision, and why ──────────────────────
 *
 *  The design document specified two contradictory implementations: a Mongo pipeline
 *  (`$match → $sort → $group → $lookup → $facet`) in one section and a JavaScript fold ("one array,
 *  one pass") in another. THE FOLD WINS, and the reasoning is written here rather than left in a
 *  document nobody reads next to the code:
 *
 *    - it is the shape `modules/conversion`'s install cohort already has, so one reviewer's
 *      understanding covers both, and the resolver they share is fed the same way;
 *    - FAIL-OPEN FACET VALIDATION IS TRIVIAL IN JAVASCRIPT AND AWKWARD IN A PIPELINE. An
 *      unrecognised facet value must WIDEN the result and add a warning; expressed as a `$match` it
 *      is far easier to write the version that matches nothing, and an empty table caused by a typo
 *      is indistinguishable from a business with no stores;
 *    - the counts and the list must come from the SAME array or they will eventually disagree, and
 *      the one on screen will be whichever the reader happened to look at. `$facet` can express that
 *      too — but it also packs every store into ONE result document, straight into the 16MB BSON
 *      limit at a few tens of thousands of stores, silently at first and then as a hard failure on
 *      the day the install base crosses it;
 *    - one sort comparator, shared with the install cohort through
 *      `shared/helpers/listQuery.helper`, rather than a `$sort` stage whose null handling is
 *      different from JavaScript's.
 *
 *  The two `$group`s below are not a retreat from that decision. They roll up the MONEY, which is a
 *  pure sum over a collection nothing else in the fold needs row-by-row, and they are the same shape
 *  `modules/revenue`'s own repository already uses. The ROSTER — row assembly, facets, counts, sort,
 *  paging — is folded in JavaScript.
 *
 *  ── FOUR MORE THINGS IN HERE ARE LOAD-BEARING ─────────────────────────────
 *
 *  1. EVERY `$match` IN AN AGGREGATE CASTS THROUGH `toObjectId`. `aggregate` does not auto-cast —
 *     unlike `find` — so an uncast string id matches ZERO documents and raises NO error. The page
 *     then renders as though the merchant had no stores, which is a plausible empty answer and
 *     therefore the one failure mode this project exists to refuse.
 *
 *  2. THE CHARGE-EVENT PULL CARRIES NO `$gte`, AND NEITHER DOES ANYTHING ELSE HERE. The roster is
 *     lifetime by definition: "every store that has ever touched this app". A lower bound anywhere
 *     would silently redefine the population.
 *
 *  3. `raw_event` STAYS PROJECTED ON THE CHARGE PULL, and only there. `billingOn`, `name`, `amount`
 *     and `test` live NOWHERE else. Drop it and every trial end becomes null, every plan name blank,
 *     and every test charge indistinguishable from a real one. The relationship pull does NOT
 *     project it — see the cost ladder above.
 *
 *  4. BLANK DOMAINS ARE FILTERED AND THEIR EXCLUSIONS ARE COUNTED. Drop the filter and every
 *     shopless event pools into one synthetic store counted as 1; keep it silently and the rows
 *     vanish with no trace. Both are wrong; only "filter and report" is not.
 *
 *  ── What is NOT here ────────────────────────────────────────────────────────
 *  No judgement. Which name wins, whether a store counts as installed, what an empty result means —
 *  all of that belongs to the resolvers and the service, because those are what a test reaches, and
 *  a second opinion formed here would be a second place for the answer to drift.
 * ============================================================================
 */

import models = require('../../shared/repositories/models.repository');
import storeConstants = require('../constants/storeRoster.constants');
import conversion = require('../../conversion');
import partnerVocab = require('../../../constants/partnerVocab.constants');

import type { PartnerAppDoc, PartnerAppEventDoc } from '../../shared/types/entity.types';
import type {
    StoreAttributionRow,
    StoreRelationshipEventResult,
    StoreRelationshipEventRow,
    StoreRosterAsOfQuery,
    StoreRosterQuery,
    StoreSettledChargeRow,
    StoreSpendRow
} from '../types/storeRosterData.types';

const {
    PartnerAppModel,
    PartnerAppEventModel,
    PartnerAppTransactionModel,
    ListingInstallAttributionModel,
    toObjectId
} = models;
const { STORE_RELATIONSHIP_EVENT_TYPES } = storeConstants;
// Through the BARREL, not by deep path: the store roster classifies the same subscriptions into the
// same five states as the install cohort, and the `$in` list that pull needs is part of that fold.
const { CHARGE_COHORT_EVENT_TYPES } = conversion;
const { PARTNER_TRANSACTION_TYPES } = partnerVocab;

/**
 * The charge cohort's event list MINUS everything the relationship read already fetches.
 *
 *  THE TWO EVENT READS ARE DISJOINT BY CONSTRUCTION, and this line is what makes them so.
 * `CHARGE_COHORT_EVENT_TYPES` contains `UNINSTALL` and `DEACTIVATED` — they are a subscription's
 * only end signal when no cancellation event ever lands, so the fold genuinely needs them — and
 * those are the same rows `findRelationshipEvents` is already pulling. Left in both `$in`s, every
 * uninstall in the install base crosses the wire twice on every request, on the largest collection
 * in the application, for a payload the second read does not even project differently.
 *
 * DERIVED, never restated: adding an event type to the cohort vocabulary widens this automatically,
 * and a hand-written copy would silently stop fetching it. The caller re-joins the relationship end
 * events into the fold — see `services/storeRoster.service`, which is where the two halves meet.
 */
const _SUBSCRIPTION_ONLY_EVENT_TYPES: readonly string[] = CHARGE_COHORT_EVENT_TYPES
    .filter((eventType) => STORE_RELATIONSHIP_EVENT_TYPES.indexOf(eventType) === -1);

/**
 * The app row: its identity, its sync watermarks and its coverage gates.
 *
 * Read for the WATERMARKS above all. `last_synced_at` is what separates "nobody has ever installed
 * this app" from "we have never looked", and a row count cannot tell those apart — an empty roster
 * is a perfectly ordinary answer once a sync has run.
 *
 * A CastError on an unparseable id propagates rather than being swallowed into `null`: the service's
 * try/catch turns it into an honest failure envelope, whereas a `null` would render as "app not
 * found" and send an operator hunting for a record that is fine.
 *
 * @param partner_app_id - The app to report on.
 * @returns The lean row, or null when no such app exists.
 */
const findPartnerAppById = async (partner_app_id: string): Promise<PartnerAppDoc | null> => {
    return PartnerAppModel.findById(partner_app_id).lean();
};

/**
 * EVERY relationship event for the app: the install-state spine.
 *
 * All four types — INSTALL, REINSTALL, UNINSTALL and DEACTIVATED. `partnerVocab.constants` states
 * why two are not enough: *"Any fold over install state that considers only INSTALL/UNINSTALL leaves
 * every reactivated shop permanently uninstalled and every frozen shop permanently installed — both
 * wrong, both silent."*
 *
 * ── NOT SORTED, DELIBERATELY ──
 * There is no `.sort()` here, and adding one would be a pessimisation dressed as tidiness. The fold
 * downstream keeps per-shop extremes by explicit timestamp comparison rather than by relying on
 * arrival order, so ordering buys nothing — while a `.sort({ shop_domain: 1, occurred_at: 1 })`
 * would either force a blocking in-memory sort of the whole install base or push the planner off
 * `idx_app_type_occurred`, which is what serves the `$in` below.
 *
 * ── The projection is five scalars and no `raw_event` ──
 * See rung (a) of the cost ladder in the file header. `shop_name` is a column precisely so this read
 * never has to deserialise a Mixed blob per event.
 *
 * Two queries rather than one `$facet`: a facet would pack every event into ONE result document and
 * meet the 16MB BSON ceiling as the install base grows. They are issued together, so the exclusion
 * tally costs latency rather than wall-clock.
 *
 * Served by `idx_app_type_occurred` = `{ partner_app_id, event_type, occurred_at }`.
 *
 * @param params0 - See {@link StoreRosterQuery}.
 * @returns The events, plus the count it could not use.
 */
const findRelationshipEvents = async ({ partner_app_id }: StoreRosterQuery): Promise<StoreRelationshipEventResult> => {
    const _appId = toObjectId(partner_app_id);
    const match = { partner_app_id: _appId, event_type: { $in: STORE_RELATIONSHIP_EVENT_TYPES } };

    const [rows, shopless] = await Promise.all([
        // `$nin: ['', null]`, NOT `$ne: ''`. Query-language `null` matches a MISSING field as well
        // as a stored one, and `$ne: ''` matches it too — so a document written before the schema
        // default existed would pass this filter and become a row whose `shop_domain` is `null`,
        // which then reaches a `localeCompare` on the sort's tie-break path and turns a TypeError
        // into a refusal of the WHOLE endpoint. This filter is what makes every row joinable.
        PartnerAppEventModel.find({ ...match, shop_domain: { $nin: ['', null] } })
            .select('shop_domain event_type occurred_at shop_name shop_id')
            .lean<StoreRelationshipEventRow[]>(),
        // `$in: ['', null]` and not `$eq: ''`, for the same reason in reverse: counting only the
        // empty strings would UNDER-report the exclusion, and an exclusion nobody counted is one
        // nobody can be warned about.
        PartnerAppEventModel.countDocuments({ ...match, shop_domain: { $in: ['', null] } })
    ]);

    return { rows, shopless_relationship_events: shopless };
};

/**
 * Every subscription START and END event for the app, up to the judgement instant.
 *
 * ⚠️ APP-SCOPED, NOT DOMAIN-SCOPED, and that is what makes this read simpler than the install
 * cohort's twin rather than sloppier. That one fans out over a WINDOW'S spine in chunks and then
 * needs a second charge-keyed pass to recover end events carrying no shop domain — a
 * `SubscriptionChargeCanceled` for a shop redacted between its install and its cancellation would
 * otherwise never be fetched, and the store would stay CONVERTED for ever. Here the population is
 * the whole app, so every such row is already inside this one query and the second pass has nothing
 * left to find.
 *
 * ⚠️ SUBSCRIPTION TYPES ONLY. The relationship end events the fold also needs are fetched by
 * `findRelationshipEvents` and re-joined by the service — see `_SUBSCRIPTION_ONLY_EVENT_TYPES`. This
 * read is therefore NOT the complete `$in` the cohort resolver expects, and a caller that passes its
 * result to that resolver alone will under-churn every store whose only end signal is an uninstall.
 *
 * NO LOWER TIME BOUND — see rule 2 in the file header. `raw_event` STAYS PROJECTED — rule 3.
 *
 * Served by `idx_app_type_occurred` = `{ partner_app_id, event_type, occurred_at }`.
 *
 * @param params0 - See {@link StoreRosterAsOfQuery}.
 * @returns The rows, in no guaranteed order. The resolver sorts.
 */
const findChargeCohortEvents = async ({ partner_app_id, as_of }: StoreRosterAsOfQuery): Promise<PartnerAppEventDoc[]> => {
    return PartnerAppEventModel.find({
        partner_app_id: toObjectId(partner_app_id),
        event_type: { $in: _SUBSCRIPTION_ONLY_EVENT_TYPES },
        //  `$lte` ONLY. There is no `$gte` and there must never be one.
        occurred_at: { $lte: as_of }
    })
        .select('event_type shop_domain charge_id occurred_at raw_event')
        .lean();
};

/**
 * Settled `APP_SUBSCRIPTION` payouts, grouped by the charge they settle.
 *
 * ONE READ, THREE ANSWERS, because they are three readings of the same fact — see
 * {@link StoreSettledChargeRow}. The `$sort` before the `$group` is what makes `$first` mean "the
 * most recent settled payout for this charge" rather than "whichever document the planner happened
 * to emit first", and `idx_app_type_created` supplies that order from the index, so the stage is
 * free rather than blocking.
 *
 * BOUNDED AT THE JUDGEMENT INSTANT. Unbounded, a payout that settles tomorrow is evidence today: a
 * subscription whose charge carried no `billingOn` on any event takes the second branch of the
 * state machine, `everSettled` reads true, and the store is published CONVERTED as of a date it had
 * not paid. The error runs one way only, because the event pull and the churn clamp ARE bounded —
 * so future churn is excluded while future revenue is admitted.
 *
 * ⚠️ `created_at` — Shopify's SETTLEMENT timestamp — never `createdAt`, which `timestamps` writes
 * when WE inserted the row. Bounding on that one does not error; it clamps by sync time, and a
 * lifetime backfill then falls inside every window at once.
 *
 * Served by `idx_app_type_created` = `{ partner_app_id, type, created_at }`.
 *
 * @param params0 - See {@link StoreRosterAsOfQuery}.
 * @returns One row per (charge, store) pair with a payout.
 */
const aggregateSettledSubscriptionCharges = async ({ partner_app_id, as_of }: StoreRosterAsOfQuery): Promise<StoreSettledChargeRow[]> => {
    return PartnerAppTransactionModel.aggregate<StoreSettledChargeRow>([
        {
            $match: {
                partner_app_id: toObjectId(partner_app_id),
                type: PARTNER_TRANSACTION_TYPES.APP_SUBSCRIPTION,
                created_at: { $lte: as_of }
            }
        },
        // Newest first, so every `$first` below means "the payout we last saw" rather than "the one
        // the index happened to reach first".
        { $sort: { created_at: -1 } },
        {
            $group: {
                _id: { charge_id: '$charge_id', shop_domain: '$shop_domain' },
                settled_count: { $sum: 1 },
                billing_interval: { $first: '$billing_interval' },
                latest_gross: { $first: '$gross_amount.amount' },
                latest_currency: { $first: '$gross_amount.currency' },
                latest_settled_at: { $first: '$created_at' }
            }
        },
        {
            $project: {
                _id: 0,
                charge_id: '$_id.charge_id',
                shop_domain: '$_id.shop_domain',
                settled_count: 1,
                // `$ifNull` and not a default in JavaScript: a legacy row stores no
                // `billing_interval` field at all, and an absent key comes back `undefined` while a
                // stored null comes back null. One shape for both, decided in the query.
                billing_interval: { $ifNull: ['$billing_interval', null] },
                // `0` and `''` rather than null: these two feed an arithmetic predicate, and the
                // predicate's own rule is that a non-positive amount does NOT keep a shop live — so
                // an unreadable amount must fall on the "not paying" side rather than throwing.
                latest_gross: { $ifNull: ['$latest_gross', 0] },
                latest_currency: { $ifNull: ['$latest_currency', ''] },
                latest_settled_at: { $ifNull: ['$latest_settled_at', null] }
            }
        }
    ]);
};

/**
 * Lifetime settled spend per store, across every transaction type.
 *
 * ⚠️ EVERY TYPE, INCLUDING `APP_CREDIT` AND `APP_ADJUSTMENT`, which are negative money. "Total
 * spend" net of refunds is the honest reading of what a store has paid; summing only the positive
 * types would publish a lifetime figure larger than the money that actually changed hands.
 *
 * `$addToSet` on the currency is the cheapest possible honesty check: it is one or two entries per
 * store in practice, and it is what lets the read layer publish `spend_currency: ''` — and refuse to
 * caption the number — for a store billed in two currencies. There is no FX table in this build, so
 * a mixed-currency total is a sum of unlike units and must say so rather than pick a symbol.
 *
 * Bounded at the judgement instant for the same reason as the read above, and on the same field.
 *
 * Served by `idx_app_shop_type` = `{ partner_app_id, shop_domain, type }`, which streams an ordered
 * scan into the `$group` instead of sorting the whole ledger in memory.
 *
 * @param params0 - See {@link StoreRosterAsOfQuery}.
 * @returns One row per store that has ever settled a payout.
 */
const aggregateStoreSpend = async ({ partner_app_id, as_of }: StoreRosterAsOfQuery): Promise<StoreSpendRow[]> => {
    return PartnerAppTransactionModel.aggregate<StoreSpendRow>([
        {
            $match: {
                partner_app_id: toObjectId(partner_app_id),
                created_at: { $lte: as_of },
                // Same `$nin` as the relationship pull: a payout that names no shop cannot become a
                // store row, and pooling every such payout under one key would invent a store with
                // an enormous lifetime spend. The service counts what this excluded.
                shop_domain: { $nin: ['', null] }
            }
        },
        {
            $group: {
                _id: '$shop_domain',
                total_gross: { $sum: '$gross_amount.amount' },
                total_net: { $sum: '$net_amount.amount' },
                transaction_count: { $sum: 1 },
                first_payment_at: { $min: '$created_at' },
                last_payment_at: { $max: '$created_at' },
                currencies: { $addToSet: '$gross_amount.currency' }
            }
        },
        {
            $project: {
                _id: 0,
                shop_domain: '$_id',
                total_gross: { $ifNull: ['$total_gross', 0] },
                total_net: { $ifNull: ['$total_net', 0] },
                transaction_count: 1,
                first_payment_at: { $ifNull: ['$first_payment_at', null] },
                last_payment_at: { $ifNull: ['$last_payment_at', null] },
                currencies: { $ifNull: ['$currencies', []] }
            }
        }
    ]);
};

/**
 * Every listing-analytics install record for the app.
 *
 * ALL of them, not a per-domain winner: a store that installed twice has two rows, and choosing
 * between them is a judgement — nearest-in-time to the Partner install instant, which
 * `shared/helpers/attributionMatch.helper` owns — that belongs above the repository. Returning a
 * pre-picked winner here would bury that decision in a query.
 *
 * ⚠️ NO re-normalise-and-merge pass, and none is needed: BOTH sides of this join are canonicalised
 * on write (`partnerSync.service.ts` for the event side, the attribution model for the listing
 * side), so the stored `shop_domain` IS the join key. Re-normalising a stored value on read is the
 * waste that guarantee exists to remove — and it would establish the second implementation
 * `shopDomain.helper` exists to prevent.
 *
 * Sorted so the nearest-in-time scan is deterministic on ties. Served by `uniq_app_shop_install` =
 * `{ partner_app_id, shop_domain, installed_at }`.
 *
 * @param params0 - See {@link StoreRosterQuery}.
 * @returns Every record, oldest first within each store.
 */
const findInstallAttributionRows = async ({ partner_app_id }: StoreRosterQuery): Promise<StoreAttributionRow[]> => {
    return ListingInstallAttributionModel.find({ partner_app_id: toObjectId(partner_app_id) })
        .select('shop_domain shop_name installed_at source medium campaign attribution_source '
            + 'surface_type surface_detail surface_inter_position surface_intra_position country')
        .sort({ shop_domain: 1, installed_at: 1 })
        .lean<StoreAttributionRow[]>();
};

export = {
    findPartnerAppById,
    findRelationshipEvents,
    findChargeCohortEvents,
    aggregateSettledSubscriptionCharges,
    aggregateStoreSpend,
    findInstallAttributionRows
};
