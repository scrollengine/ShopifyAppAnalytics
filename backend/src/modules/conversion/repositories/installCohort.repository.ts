'use strict';

/**
 * ============================================================================
 *  THE INSTALL COHORT — every read it needs, and nothing else
 * ============================================================================
 *
 *  The ONLY file in this module that touches the model layer, and it does so through the single
 *  chokepoint at `modules/shared/repositories/models.repository`. Four reads, in the order the
 *  service performs them:
 *
 *    1. the app row            — for its watermarks and coverage gates
 *    2. the INSTALL SPINE      — the population, and the count of what the domain filter excluded
 *    3. the charge events      — every subscription signal for those stores, with NO lower bound
 *    4. the settled payouts    — the evidence behind the second branch of the state machine
 *    5. the attribution rows   — the listing-analytics record of how each store arrived
 *
 *  ── FIVE THINGS IN HERE ARE LOAD-BEARING ─────────────────────────────────
 *
 *  1. EVERY `$match` CASTS THROUGH `toObjectId`. `aggregate` does not auto-cast — unlike `find` —
 *     so an uncast string id matches ZERO documents and raises NO error. The page then renders as
 *     though the merchant had no installs, which is a plausible empty answer and therefore the one
 *     failure mode this project exists to refuse.
 *
 *  2. THE CHARGE-EVENT PULL CARRIES NO `$gte`. A store that installed inside the window may have
 *     subscribed at any point before it. Bounding that scan at the window's start makes a paying
 *     customer read as `INSTALLED` — a specific false claim about a specific merchant, and one that
 *     looks entirely plausible on screen.
 *
 *  3. `raw_event` STAYS PROJECTED. `billingOn`, `name`, `amount` and `test` live NOWHERE ELSE. Drop
 *     it to make the scan cheaper and every trial end becomes null, every plan name blank, and every
 *     test charge indistinguishable from a real one.
 *
 *  4. THE CHUNK ACCUMULATOR IS DECLARED OUTSIDE THE CHUNK LOOP. Rebuilding it per chunk re-scopes
 *     whatever the loop is accumulating to a single chunk and discards the rest silently — no error,
 *     no short read, just a smaller answer. The loop stays SEQUENTIAL as well: `Promise.all` over
 *     chunks trades a bounded memory spike for an unbounded connection-pool one.
 *
 *  5. `shop_domain: { $nin: ['', null] }` IS KEPT AND ITS EXCLUSIONS ARE COUNTED. Drop the filter and every
 *     shopless event pools into one synthetic store counted as 1; keep it silently and the rows
 *     vanish with no trace. Both are wrong; only "filter and report" is not.
 *
 *  ── What is NOT here ────────────────────────────────────────────────────────
 *  No judgement. Which attribution row wins, whether a state is trustworthy, what an empty result
 *  means — all of that is the service's, because the service is what a job runner and a test reach,
 *  and a second opinion formed here would be a second place for the answer to drift.
 * ============================================================================
 */

import models = require('../../shared/repositories/models.repository');
import lifecycleConstants = require('../constants/lifecycle.constants');
import partnerVocab = require('../../../constants/partnerVocab.constants');

import type { PartnerAppDoc, PartnerAppEventDoc } from '../../shared/types/entity.types';
import type {
    CohortAttributionRow,
    CohortDomainQuery,
    CohortEventQuery,
    InstallSpineQuery,
    InstallSpineResult,
    InstallSpineRow,
    SettledChargeQuery,
    SettledSubscriptionChargeRow
} from '../types/installCohortData.types';

const {
    PartnerAppModel,
    PartnerAppEventModel,
    PartnerAppTransactionModel,
    ListingInstallAttributionModel,
    toObjectId
} = models;
const {
    INSTALL_SPINE_EVENT_TYPES,
    CHARGE_COHORT_EVENT_TYPES,
    SUBSCRIPTION_END_EVENT_TYPES,
    DOMAIN_CHUNK_SIZE
} = lifecycleConstants;
const { PARTNER_TRANSACTION_TYPES } = partnerVocab;

/**
 * Splits a domain list into fixed-size chunks for an `$in`.
 *
 * An unbounded `$in` is a query document that grows with the install base; at forty thousand stores
 * it is megabytes of BSON on every request. Chunking bounds the query, and the caller's accumulator
 * — declared OUTSIDE its loop — is what keeps the answer whole.
 *
 * @param values - The domains to fan out over.
 * @param size - Maximum entries per chunk.
 * @returns The chunks, in the input's order.
 */
const _chunk = (values: readonly string[], size: number): string[][] => {
    const out: string[][] = [];
    for (let i = 0; i < values.length; i += size) {
        out.push(values.slice(i, i + size));
    }
    return out;
};

/**
 * The `occurred_at` predicate for a window, or nothing at all.
 *
 * Returns `{}` rather than a bound at the beginning of time when the window is lifetime, so the
 * planner picks the same index either way instead of range-scanning from 1970.
 *
 * @param since - Lower bound, or null for none.
 * @param until - Upper bound, or null for none.
 * @returns A fragment to spread into a `$match`.
 */
const _occurredAtClause = (since: Date | null, until: Date | null): Record<string, any> => {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (since) {
        range.$gte = since;
    }
    if (until) {
        range.$lte = until;
    }
    if (Object.keys(range).length === 0) {
        return {};
    }
    return { occurred_at: range };
};

/**
 * The app row: its identity, its three sync watermarks and its coverage gates.
 *
 * Read for the WATERMARKS above all. `last_synced_at` is what separates "nobody installed" from
 * "we have never looked", and a row count cannot tell those apart — an empty window is a perfectly
 * ordinary answer once a sync has run.
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
 * THE INSTALL SPINE: one row per store that installed or reinstalled inside the window.
 *
 * This is the population and the only thing that decides which merchants appear. Every later read is
 * a LEFT join onto it — a subscription or an attribution record may enrich a row, and neither may
 * ever create or remove one.
 *
 * ── Two queries, deliberately, rather than one `$facet` ──
 * A `$facet` would compute the group and the exclusion tally in a single pass, and would also pack
 * every store into ONE result document — straight into the 16MB BSON limit at a few tens of
 * thousands of stores, silently at first and then as a hard failure on the day the install base
 * crosses it. Two reads have no such ceiling. They are issued together so the extra scan costs
 * latency, not wall-clock.
 *
 * ── Sorted by domain, and why that is not cosmetic ──
 * `$group` output has no defined order. Sorting makes the chunk boundaries below deterministic and
 * gives every downstream tie-break a stable basis, so the same request returns the same page rather
 * than a reshuffle that reads as data changing.
 *
 * Served by `idx_app_type_occurred` = `{ partner_app_id, event_type, occurred_at }`.
 *
 * @param params0 - See {@link InstallSpineQuery}.
 * @returns The spine, plus the count of install events it could not use.
 */
const aggregateInstallSpine = async ({ partner_app_id, since, until }: InstallSpineQuery): Promise<InstallSpineResult> => {
    const match = {
        partner_app_id: toObjectId(partner_app_id),
        event_type: { $in: INSTALL_SPINE_EVENT_TYPES },
        ..._occurredAtClause(since, until)
    };

    const [rows, shopless] = await Promise.all([
        PartnerAppEventModel.aggregate<InstallSpineRow>([
            // `$nin: ['', null]`, NOT `$ne: ''`. Query-language `null` matches a MISSING field as
            // well as a stored one; `$ne: ''` matches it too — so a document written before the
            // schema default existed passed this filter, grouped under `_id: null`, and became a row
            // whose `shop_domain` was `null`. That row reached `_compareRows`, which calls
            // `localeCompare` on the tie-break path, and the service's catch turned the resulting
            // TypeError into a refusal of the WHOLE endpoint. It was also counted a second time by
            // the exclusion tally below — which posits exactly that document, so the two lines used
            // to disagree about the same threat.
            //
            // This is the filter that makes every row joinable, and its exclusions are counted
            // rather than discarded: a store that cannot be named is not a store that did not
            // install.
            { $match: { ...match, shop_domain: { $nin: ['', null] } } },
            {
                $group: {
                    _id: '$shop_domain',
                    installed_at: { $min: '$occurred_at' },
                    install_count: { $sum: 1 }
                }
            },
            { $project: { _id: 0, shop_domain: '$_id', installed_at: 1, install_count: 1 } },
            { $sort: { shop_domain: 1 } }
        ]),
        // `$in: ['', null]` and not `$eq: ''`: a document written before the schema default existed
        // carries no `shop_domain` field at all, and query-language `null` matches missing as well as
        // stored null. Counting only the empty strings would under-report the exclusion.
        PartnerAppEventModel.countDocuments({ ...match, shop_domain: { $in: ['', null] } })
    ]);

    return { rows, shopless_install_events: shopless };
};

/**
 * Every subscription START and END event for the spine's stores, up to the judgement instant.
 *
 * NO LOWER TIME BOUND. See rule 2 in the file header — this is the single most consequential line
 * in the file, and it is an ABSENCE, which is exactly the kind of thing a well-meaning optimisation
 * adds back.
 *
 * ⚠️ TWO PASSES, because the join key is not the same on both kinds of row.
 *
 *   1. DOMAIN-SCOPED, which bounds the read by the population being reported on rather than by the
 *      app's entire history. This is what fetches every subscription START, since a start with no
 *      domain can never join the spine anyway — the resolver counts it `out_of_spine` and the
 *      per-domain fold drops it.
 *
 *   2. CHARGE-SCOPED, for the END events pass 1 cannot see. This pass exists because the header
 *      comment above it used to claim "nothing that could have become a row is lost" — true for
 *      ROWS, and false for CHURN EVIDENCE, which joins on `charge_id` and needs no domain at all.
 *      A shop redacted (GDPR) between its INSTALL and its `SubscriptionChargeCanceled` carries a
 *      domain on the install and none on the cancel: the cancel was never fetched, its date never
 *      reached `endsByCharge`, and the store NEVER CHURNED — it stayed CONVERTED for ever. Same
 *      direction of error as an unbounded settled-payout read, and just as silent. The spine's own
 *      `shopless_install_events` counter exists because blank domains genuinely occur in this data.
 *
 * Pass 2 is restricted to `shop_domain: { $in: ['', null] }`, so the two passes are DISJOINT by
 * construction — every needle in pass 1 came from the spine and the spine has no blank domains — and
 * a duplicated end date can never be pushed into `endsByCharge` twice.
 *
 * It matches on the STORED `charge_id` column only, never on `raw_event.charge.id`: the column is
 * normalised on write to the same bare numeric form as the money side, and it is the indexed field.
 * A row whose column was never populated is unreachable by an indexed `$in` however it is spelled.
 *
 * Served by `idx_app_shop_occurred` = `{ partner_app_id, shop_domain, occurred_at }` for pass 1 and
 * `idx_app_charge_occurred` = `{ partner_app_id, charge_id, occurred_at }` for pass 2.
 *
 * @param params0 - See {@link CohortEventQuery}.
 * @returns Every chunk's rows, in one array. The resolver sorts.
 */
const findChargeCohortEvents = async ({ partner_app_id, until, domains }: CohortEventQuery): Promise<PartnerAppEventDoc[]> => {
    const _appId = toObjectId(partner_app_id);
    // OUTSIDE the loop. Declared inside, each iteration would answer for its own chunk and the
    // fold would silently receive only the last one.
    const events: PartnerAppEventDoc[] = [];

    for (const chunk of _chunk(domains, DOMAIN_CHUNK_SIZE)) {
        const rows = await PartnerAppEventModel.find({
            partner_app_id: _appId,
            event_type: { $in: CHARGE_COHORT_EVENT_TYPES },
            shop_domain: { $in: chunk },
            //  `$lte` ONLY. There is no `$gte` and there must never be one.
            occurred_at: { $lte: until }
        })
            // `raw_event` is not optional here — see rule 3 in the file header.
            .select('event_type shop_domain charge_id occurred_at raw_event')
            .lean();
        events.push(...rows);
    }

    // ── Pass 2: the churn evidence that carries a charge but no shop ─────────
    const chargeIds: string[] = [];
    const _seen = new Set<string>();
    for (const row of events) {
        const chargeId = String(row.charge_id || '');
        if (chargeId !== '' && !_seen.has(chargeId)) {
            _seen.add(chargeId);
            chargeIds.push(chargeId);
        }
    }

    for (const chunk of _chunk(chargeIds, DOMAIN_CHUNK_SIZE)) {
        const rows = await PartnerAppEventModel.find({
            partner_app_id: _appId,
            // END types only. A blank-domain START would build a bucket the fold cannot place, and
            // widening this to every charge event would trade a closed hole for an open question.
            event_type: { $in: SUBSCRIPTION_END_EVENT_TYPES },
            charge_id: { $in: chunk },
            // Disjoint from pass 1 by construction — see the docstring.
            shop_domain: { $in: ['', null] },
            //  Same `$lte`-only bound. A cancellation after the judgement instant has not
            // happened yet from this window's point of view.
            occurred_at: { $lte: until }
        })
            .select('event_type shop_domain charge_id occurred_at raw_event')
            .lean();
        events.push(...rows);
    }

    return events;
};

/**
 * Settled `APP_SUBSCRIPTION` payouts for the spine's stores, grouped by the charge they settle.
 *
 * Two things come out of one read, because they are two readings of the same fact:
 *   - the SIGN of `settled_count`, which decides the state of any subscription Shopify gave us no
 *     `billingOn` for — money either moved for that charge or it provably did not;
 *   - `billing_interval`, which is the ONLY place Shopify exposes a subscription's cadence. It is
 *     taken from the MOST RECENT payout (hence the `$sort` before the `$group`, without which
 *     `$first` picks whichever document the planner happened to emit first) and stays `null` when no
 *     payout carried one.
 *
 * Restricted to `APP_SUBSCRIPTION`: usage and one-time charges are real money and are not evidence
 * that a SUBSCRIPTION converted. Counting them would report a store that bought a single add-on as
 * a paying subscriber.
 *
 * AND RESTRICTED TO PAYOUTS SETTLED AT OR BEFORE `as_of`. See the `$match` — this is the third
 * of the three inputs to a store's state, and it was the only one that was not clamped. The bound
 * also makes `billing_interval` "the cadence as of this window" rather than the cadence today,
 * which is what the rest of the row already claims to be.
 *
 * Served by `idx_app_type_created` = `{ partner_app_id, type, created_at }` — the `as_of` bound is a
 * range on that index's third key, so it narrows the scan rather than costing one, and the `$sort`
 * below still comes out of the index for free.
 *
 * @param params0 - See {@link SettledChargeQuery}.
 * @returns One row per (charge, store) pair with a payout.
 */
const aggregateSettledSubscriptionCharges = async ({ partner_app_id, domains, as_of }: SettledChargeQuery): Promise<SettledSubscriptionChargeRow[]> => {
    const _appId = toObjectId(partner_app_id);
    // OUTSIDE the loop.
    const rows: SettledSubscriptionChargeRow[] = [];

    for (const chunk of _chunk(domains, DOMAIN_CHUNK_SIZE)) {
        const chunkRows = await PartnerAppTransactionModel.aggregate<SettledSubscriptionChargeRow>([
            {
                $match: {
                    partner_app_id: _appId,
                    type: PARTNER_TRANSACTION_TYPES.APP_SUBSCRIPTION,
                    shop_domain: { $in: chunk },
                    // BOUNDED AT THE JUDGEMENT INSTANT, and this line is the whole reason the
                    // query carries one. Unbounded, a payout that settled in June is evidence inside
                    // a January window: a subscription whose ACCEPTED event carried no
                    // `charge.billingOn` takes the `conversion_date === null` branch, `everSettled`
                    // reads true, and the store is published CONVERTED on `state_basis:
                    // 'settled_payout'` as of a date it had not paid. One-directional, because the
                    // event pull and the churn clamp ARE bounded — so future churn was excluded
                    // while future revenue was admitted, over-counting CONVERTED and under-counting
                    // ON_TRIAL for every historical window.
                    //
                    // ⚠️ `created_at` — Shopify's SETTLEMENT timestamp — never `createdAt`, which
                    // `timestamps` writes when WE inserted the row. Bounding on that one does not
                    // error; it clamps by sync time, and a lifetime backfill then falls inside every
                    // window at once.
                    created_at: { $lte: as_of }
                }
            },
            // Newest first, so `$first` below means "the cadence we last saw money billed at"
            // rather than "whichever row came out of the index first".
            { $sort: { created_at: -1 } },
            {
                $group: {
                    _id: { charge_id: '$charge_id', shop_domain: '$shop_domain' },
                    settled_count: { $sum: 1 },
                    billing_interval: { $first: '$billing_interval' }
                }
            },
            {
                $project: {
                    _id: 0,
                    charge_id: '$_id.charge_id',
                    shop_domain: '$_id.shop_domain',
                    settled_count: 1,
                    // `$ifNull` and not a default in JavaScript: a legacy row stores no
                    // `billing_interval` field at all, and an absent key would come back `undefined`
                    // while a stored null comes back null. One shape for both, decided in the query.
                    billing_interval: { $ifNull: ['$billing_interval', null] }
                }
            }
        ]);
        rows.push(...chunkRows);
    }

    return rows;
};

/**
 * Every listing-analytics install record for the spine's stores.
 *
 * ALL of them, not a per-domain winner: a store that installed twice has two rows, and choosing
 * between them is a judgement (nearest-in-time to the Partner install instant) that belongs to the
 * service. Returning a pre-picked winner here would bury that decision in a query.
 *
 * ⚠️ NO post-`$group` re-normalise-and-merge pass, and none is needed: BOTH sides of this join are
 * canonicalised on write (`partnerSync.service.ts` for the event side, the attribution model for the
 * listing side), so the stored `shop_domain` IS the join key. The system this was ported from stored
 * the partner side raw and had to reconcile the two in JavaScript afterwards; carrying that loop
 * across would be work in service of a guarantee this build already has.
 *
 * The `shop_domain: { $ne: '' }` guard is subsumed by the `$in`: every needle comes from the spine
 * and the spine has already excluded blanks — and counted them.
 *
 * Sorted so the service's nearest-in-time scan is deterministic on ties. Served by
 * `uniq_app_shop_install` = `{ partner_app_id, shop_domain, installed_at }`.
 *
 * @param params0 - See {@link CohortDomainQuery}.
 * @returns Every chunk's rows, in one array.
 */
const findInstallAttributionRows = async ({ partner_app_id, domains }: CohortDomainQuery): Promise<CohortAttributionRow[]> => {
    const _appId = toObjectId(partner_app_id);
    // OUTSIDE the loop. This is the accumulator the ported implementation rebuilt per chunk,
    // which re-scoped the per-domain winner to a chunk and dropped every row outside it.
    const rows: CohortAttributionRow[] = [];

    for (const chunk of _chunk(domains, DOMAIN_CHUNK_SIZE)) {
        const chunkRows = await ListingInstallAttributionModel.find({
            partner_app_id: _appId,
            shop_domain: { $in: chunk }
        })
            .select('shop_domain shop_name installed_at source medium campaign attribution_source '
                + 'surface_type surface_detail surface_inter_position surface_intra_position')
            .sort({ shop_domain: 1, installed_at: 1 })
            .lean();
        rows.push(...chunkRows);
    }

    return rows;
};

export = {
    findPartnerAppById,
    aggregateInstallSpine,
    findChargeCohortEvents,
    aggregateSettledSubscriptionCharges,
    findInstallAttributionRows
};
