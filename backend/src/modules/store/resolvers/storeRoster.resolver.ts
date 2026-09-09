'use strict';

/**
 * ============================================================================
 *  THE ROSTER FOLD — five reads, one population, one paying set
 * ============================================================================
 *
 *  Everything `GET /api/stores` and `GET /api/subscriptions` have in common, up to but NOT including
 *  the point where they differ: which stores are in the population, and which vocabulary the status
 *  column speaks. Both of those are the caller's business. Everything before them is this file.
 *
 *  ──  WHY THIS IS A FILE AND NOT A BLOCK INSIDE `storeRoster.service` ────────────────────
 *
 *  It WAS a block inside that service, and it stayed correct only because there was one caller. The
 *  Subscriptions list is the second, and it renders the same rows, through the same `StoreTable`,
 *  into the same drawer. Copying the fold to serve it would create a second definition of "is this
 *  shop paying" — the single failure `modules/revenue/index.ts` records from the system this was
 *  extracted from: *"two pages reconstructed MRR independently and disagreed with each other."*
 *  There is now exactly one, and both services are handed its answer.
 *
 *  ── A RESOLVER THAT DOES I/O, DELIBERATELY ────────────────────────────────────────────────
 *
 *  Its four siblings in this module fold ALREADY-FETCHED rows and touch nothing. This one issues the
 *  five reads itself, which the layer rules permit (repositories are reachable from services AND
 *  resolvers) and which is the whole point: the reads and the fold over them are one decision. A
 *  caller that fetched its own rows and handed them here could bound them differently — the charge
 *  pull's `$lte: as_of` with no `$gte` is not a detail, it is what stops a paying customer being
 *  reported as never having subscribed — and the two pages would drift apart through the query
 *  rather than through the fold.
 *
 *  ⚠️ IT STILL READS NO CLOCK. `as_of` is a parameter, resolved once by the service, so a single
 *  response cannot classify one store as of two different milliseconds.
 *
 *  ── WHAT IT DOES NOT DECIDE ───────────────────────────────────────────────────────────────
 *
 *  No filtering, no facets, no counts, no sort, no paging, no warnings, no wire shape. It publishes
 *  the population, the paying set, the two tier states and every exclusion COUNT; turning a count
 *  into a sentence an operator reads is the service's job, because the sentence differs per page
 *  ("this roster is a floor" vs "this list of paying merchants is a floor") and because a service is
 *  what a test reaches.
 * ============================================================================
 */

import config = require('../../../config');
import attributionMatchHelper = require('../../shared/helpers/attributionMatch.helper');
import bigQueryModule = require('../../bigquery');
import conversion = require('../../conversion');
import revenue = require('../../revenue');
import storeConstants = require('../constants/storeRoster.constants');
import installStateResolver = require('./installState.resolver');
import storeRowResolver = require('./storeRow.resolver');
import storeRosterRepository = require('../repositories/storeRoster.repository');

import type { PayingShop, SubscriptionChargeRow } from '../../revenue/types/ledgerMrr.types';
import type { CohortSubscription } from '../../conversion/types/lifecycle.types';
import type {
    StoreAttributionState,
    StoreDataState,
    StoreRosterRow
} from '../types/storeRoster.types';
import type { StoreAttributionRow, StoreSpendRow } from '../types/storeRosterData.types';
import type {
    StoreRosterFold,
    StoreRosterFoldDiagnostics,
    StoreRosterFoldQuery
} from '../types/storeRosterFold.types';

const { pickNearestByInstalledAt } = attributionMatchHelper;
const { resolveBigQueryAvailability } = bigQueryModule;
// Through the barrels. Both modules publish exactly the pure folds this one reuses, and both say in
// their own headers why: a sibling that cannot reach the canonical definition grows a second one,
// and then one merchant is CONVERTED on one page and ON_TRIAL on another.
const { resolveChargeCohortForDomains, STATE_BASIS } = conversion;
const { liveSetAsOf } = revenue;
const {
    STORE_UNINSTALL_EVENT_TYPES,
    STORE_DATA_STATES,
    STORE_ATTRIBUTION_STATES
} = storeConstants;
const { resolveInstallStates } = installStateResolver;
const { resolveStoreRow } = storeRowResolver;
const {
    findPartnerAppById,
    findRelationshipEvents,
    findChargeCohortEvents,
    aggregateSettledSubscriptionCharges,
    aggregateStoreSpend,
    findInstallAttributionRows
} = storeRosterRepository;

/**
 * Every store this app has any Partner record of, with its install state, its subscription, its
 * money and its acquisition — plus the canonical paying set, evaluated at the same instant.
 *
 * @param params0 - See {@link StoreRosterFoldQuery}.
 * @param params0.partner_app_id - The app to fold.
 * @param params0.as_of - The ONE judgement instant, resolved by the caller.
 * @returns The fold, or `null` when no such app exists — the caller
 *   words that refusal, because a list and a record refuse for different reasons.
 */
const resolveStoreRosterFold = async ({ partner_app_id, as_of }: StoreRosterFoldQuery): Promise<StoreRosterFold | null> => {
    const app = await findPartnerAppById(String(partner_app_id));
    if (!app) {
        return null;
    }

    const appId = String(app._id);

    // ── The two tier states, each read from a WATERMARK ──────────────
    //
    //  NEVER FROM THE ROW COUNT. No stores plus `last_synced_at` is a real, publishable "nobody has
    // ever installed this app"; no stores and no watermark is "we have not looked yet". They must not
    // render alike, and a row count cannot tell them apart.
    let dataState: StoreDataState = STORE_DATA_STATES.NEVER_SYNCED;
    if (app.last_synced_at) {
        dataState = STORE_DATA_STATES.READY;
    }

    const availability = resolveBigQueryAvailability();
    let attributionState: StoreAttributionState = STORE_ATTRIBUTION_STATES.READY;
    let attributionMessage = '';
    if (!availability.enabled) {
        //  NOT a refusal. The roster comes from the Partner API and is complete without listing
        // analytics; only the acquisition columns and `install_country` are empty.
        attributionState = STORE_ATTRIBUTION_STATES.NOT_CONNECTED;
        attributionMessage = availability.message;
    } else if (!app.last_install_attrib_synced_at) {
        attributionState = STORE_ATTRIBUTION_STATES.NEVER_SYNCED;
    }

    // ── The five reads, issued together ──────────────────────────────
    // The attribution read is SKIPPED when the tier is not connected: nothing could ever have
    // written a row, and issuing the query would only make the log read as though it had.
    const [relationship, chargeEvents, settledRows, spendRows, attributionRows] = await Promise.all([
        findRelationshipEvents({ partner_app_id: appId }),
        findChargeCohortEvents({ partner_app_id: appId, as_of }),
        aggregateSettledSubscriptionCharges({ partner_app_id: appId, as_of }),
        aggregateStoreSpend({ partner_app_id: appId, as_of }),
        availability.enabled
            ? findInstallAttributionRows({ partner_app_id: appId })
            : Promise.resolve<StoreAttributionRow[]>([])
    ]);

    // ── A. Install state, from the relationship events ───────────────
    const installStates = resolveInstallStates({ events: relationship.rows, as_of });

    // ── B. The money, read three ways from one aggregation ───────────
    const settledChargeIds = new Set<string>();
    const settledDomains = new Set<string>();
    const intervalByCharge = new Map<string, string>();
    /**
     * The newest settled subscription payout per store, as the ledger's own row shape.
     *
     * ⚠️ `shop_id` HOLDS THE DOMAIN HERE, DELIBERATELY. `liveSetAsOf` keys its answer by whatever it
     * finds in that field and never interprets the value — the ledger's type says as much ("keyed by
     * the producer's own id"). Feeding it the domain gives a domain-keyed live set, which is what
     * this roster joins on, and it also sidesteps a hazard in the transaction data: `shop_id` is `''`
     * on rows that carried no Partner GID, and every such row would otherwise collapse into ONE key.
     */
    const latestSubscriptionByDomain = new Map<string, SubscriptionChargeRow>();
    for (const row of settledRows) {
        const domain = String(row.shop_domain || '');
        if (row.charge_id) {
            settledChargeIds.add(row.charge_id);
            // Only a per-CHARGE interval is published. A domain-scoped fallback would attach one
            // subscription's cadence to another on any store with two, and an invented cadence is
            // exactly what a null `billing_interval` must never become.
            if (row.billing_interval && !intervalByCharge.has(row.charge_id)) {
                intervalByCharge.set(row.charge_id, row.billing_interval);
            }
        }
        if (domain === '') {
            continue;
        }
        settledDomains.add(domain);

        const settledAt = row.latest_settled_at instanceof Date ? row.latest_settled_at : null;
        if (!settledAt) {
            continue;
        }
        const incumbent = latestSubscriptionByDomain.get(domain);
        if (!incumbent || settledAt.getTime() > incumbent.created_at.getTime()) {
            latestSubscriptionByDomain.set(domain, {
                shop_id: domain,
                shop_domain: domain,
                gross: Number(row.latest_gross) || 0,
                currency: String(row.latest_currency || ''),
                billing_interval: row.billing_interval,
                created_at: settledAt
            });
        }
    }

    /**
     * THE canonical "who is paying us and how much" predicate, evaluated at this request's own
     * instant.
     *
     * Reached through `modules/revenue`'s barrel rather than re-derived, because the alternative is
     * on record: two pages reconstructed MRR independently and disagreed with each other.
     * `liveSetAsOf` accepts the FIRST row it sees per key and tombstones the rest, so handing it
     * exactly one row per store — the newest settled payout, which is the row it would itself have
     * selected — produces the same answer as the full history for a fraction of the read.
     *
     *  THIS MAP IS ALSO THE SUBSCRIPTIONS PAGE'S ENTIRE POPULATION. It is published on the fold
     * rather than recomputed there so that "currently paying" cannot acquire a second meaning one
     * page over.
     */
    const payingByDomain: Map<string, PayingShop> = liveSetAsOf(
        [...latestSubscriptionByDomain.values()],
        as_of,
        config.REVENUE.ACTIVE_SUB_WINDOW_DAYS
    );

    const spendByDomain = new Map<string, StoreSpendRow>();
    for (const row of spendRows) {
        if (row.shop_domain) {
            spendByDomain.set(row.shop_domain, row);
        }
    }

    // ── C. The subscriptions ─────────────────────────────────────────
    //
    //  THE UNINSTALLS ARE RE-JOINED HERE, and leaving them out is a silent, one-directional error.
    // `UNINSTALL` and `DEACTIVATED` are RELATIONSHIP events carrying no charge block, and for a
    // subscription that never received a cancellation event they are its ONLY end signal — without
    // them that store never churns and reads as CONVERTED for ever. They are not in the charge
    // pull's `$in` because the relationship read has already fetched them (see
    // `_SUBSCRIPTION_ONLY_EVENT_TYPES` in the repository); fetching them twice would put every
    // uninstall in the install base on the wire twice per request.
    //
    // Only the END types are re-joined: an INSTALL is in neither of the resolver's lists, so passing
    // one would land in its `unrecognised_events` counter and make the fold report that it was
    // handed rows it could not use — which would be true, and pointless.
    const uninstallTypes = new Set(STORE_UNINSTALL_EVENT_TYPES);
    const relationshipEndEvents = relationship.rows.filter((row) => uninstallTypes.has(row.event_type));

    // NO `domains` restriction, unlike the install cohort's spine-scoped call: the roster's
    // population IS every store, so a subscription can never be "out of spine" here — it brings its
    // own store onto the roster instead.
    //
    // ⚠️ `relationshipEndEvents` IS NOT BOUNDED AT `as_of`, AND THE RESOLVER'S HEADER ASKS ITS
    // CALLERS TO BOUND THEIR FETCH. `findRelationshipEvents` carries no `$lte: as_of` (see
    // `storeRoster.repository.ts`) because the install fold needs the future-dated rows in order to
    // COUNT and warn about them. Feeding them here is safe for two reasons that are worth stating at
    // the call site rather than leaving to be rediscovered:
    //
    //   1. `classifyAsOf` clamps a churn instant later than `as_of` to `null` unconditionally
    //      (`subscriptionState.helper.ts`), so a future uninstall can never churn a subscription
    //      early;
    //   2. `_firstAtOrAfter` picks the EARLIEST qualifying end, so a future end can never outrank a
    //      past one for the same subscription.
    //
    // Both live in `modules/conversion`. If either changes, this feed must be bounded here.
    const cohort = resolveChargeCohortForDomains({
        events: [...chargeEvents, ...relationshipEndEvents],
        as_of,
        settled_charge_ids: settledChargeIds,
        settled_domains: settledDomains
    });

    // ── D. The attribution join ──────────────────────────────────────
    const attributionByDomain = new Map<string, StoreAttributionRow[]>();
    for (const row of attributionRows) {
        const list = attributionByDomain.get(row.shop_domain);
        if (list) {
            list.push(row);
        } else {
            attributionByDomain.set(row.shop_domain, [row]);
        }
    }

    // ── E. THE POPULATION ────────────────────────────────────────────
    // Every store the PARTNER API has any record of: a relationship event, a subscription, or a
    // settled payout. Sorted so the roster — and therefore every tie-break above it — is
    // deterministic for a given database.
    //
    //  A domain known ONLY to listing analytics is deliberately NOT a store here. The Partner
    // record is the roster; a GA4 row naming a shop the Partner API has never mentioned is a gap in
    // the Partner sync, and admitting it would let an export artefact invent a merchant. They are
    // counted and warned about instead.
    const domains = new Set<string>([
        ...installStates.by_domain.keys(),
        ...cohort.by_domain.keys(),
        ...spendByDomain.keys()
    ]);
    domains.delete('');
    const orderedDomains = [...domains].sort((a, b) => a.localeCompare(b));

    let attributionRowsWithoutPartnerRecord = 0;
    for (const domain of attributionByDomain.keys()) {
        if (!domains.has(domain)) {
            attributionRowsWithoutPartnerRecord += (attributionByDomain.get(domain) || []).length;
        }
    }

    // ── F. ONE array, ONE pass, every tally taken as it is built ─────
    const rows: StoreRosterRow[] = [];
    const mixedSpendCurrencyDomains = new Set<string>();
    let storesWithoutInstallRecord = 0;
    let inferredStateRows = 0;
    let unclassifiedSubscriptionRows = 0;

    for (const domain of orderedDomains) {
        const install = installStates.by_domain.get(domain);
        const subscription: CohortSubscription | undefined = cohort.by_domain.get(domain);
        if (subscription && !subscription.lifecycle_state) {
            unclassifiedSubscriptionRows += 1;
        }
        const spend = spendByDomain.get(domain);
        const paying = payingByDomain.get(domain);
        const hasSubscriptionPayout = latestSubscriptionByDomain.has(domain);

        const row = resolveStoreRow({
            shop_domain: domain,
            install,
            subscription,
            // NEAREST IN TIME to the Partner install instant, not latest-overall. With no install
            // instant to match against there is nothing to be nearest to, so the oldest record is
            // used and `attribution_lag_seconds` stays null — the row says it could not be audited
            // rather than implying it was.
            attribution: install && install.installed_at
                ? pickNearestByInstalledAt(attributionByDomain.get(domain), install.installed_at)
                : (attributionByDomain.get(domain) || [])[0] || null,
            spend,
            plan_interval: subscription && subscription.charge_id
                ? intervalByCharge.get(subscription.charge_id) || null
                : null,
            //  `null` when this store has never settled a subscription payout at all, and a number
            // — including `0` — once it has. "We did not evaluate this" and "we evaluated it and
            // they are not paying now" are different answers.
            monthly_spend: hasSubscriptionPayout ? (paying ? paying.monthly_amount : 0) : null,
            has_subscription_payout: hasSubscriptionPayout
        });
        rows.push(row);

        if (!row.has_install_record) {
            storesWithoutInstallRecord += 1;
        }
        //  THE CONDITION IS EVALUATED HERE AND NOWHERE ELSE. A caller that re-derived it from the
        // published `spend_currency === ''` would get a DIFFERENT set: that value is also `''` for a
        // store whose payouts named no currency at all, which is an absence rather than a mixture.
        if (spend && spend.currencies && spend.currencies.filter((c) => String(c || '').trim() !== '').length > 1) {
            mixedSpendCurrencyDomains.add(domain);
        }
        if (row.state_basis === STATE_BASIS.INFERRED) {
            inferredStateRows += 1;
        }
    }

    const diagnostics: StoreRosterFoldDiagnostics = {
        shopless_relationship_events: relationship.shopless_relationship_events,
        future_relationship_events: installStates.diagnostics.future_events,
        stores_without_install_record: storesWithoutInstallRecord,
        attribution_rows_without_partner_record: attributionRowsWithoutPartnerRecord,
        stores_with_mixed_spend_currency: mixedSpendCurrencyDomains.size,
        inferred_state_rows: inferredStateRows,
        unclassified_subscription_rows: unclassifiedSubscriptionRows,
        skipped_keyless_subscription_events: cohort.diagnostics.skipped_keyless,
        test_subscriptions_excluded: cohort.diagnostics.test_subscriptions_excluded
    };

    return {
        app,
        as_of,
        rows,
        paying_by_domain: payingByDomain,
        // Already built above for the row fold; published so the country rollup can total NET
        // revenue, which the roster row does not carry. See the field's note on the fold type.
        spend_by_domain: spendByDomain,
        subscriptions_by_domain: cohort.by_domain,
        mixed_spend_currency_domains: mixedSpendCurrencyDomains,
        data_state: dataState,
        attribution_state: attributionState,
        attribution_message: attributionMessage,
        diagnostics
    };
};

export = {
    resolveStoreRosterFold
};
