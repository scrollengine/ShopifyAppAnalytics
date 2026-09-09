'use strict';

/**
 * ============================================================================
 *  ONE STORE, EVERYTHING WE KNOW ABOUT IT
 * ============================================================================
 *
 *  Serves the store detail slide-over, which opens from SEVEN different tables — Stores,
 *  Subscriptions, the install cohort on Funnel, Revenue, Revenue Churn, Logo Churn and
 *  Trial Funnel. So it must never assume it was opened from any one of them: the subject is a shop
 *  domain and nothing else, and a store that never subscribed, never paid and was never attributed
 *  is a FIRST-CLASS answer here rather than a degenerate one.
 *
 *  ──  WHY THIS IS `/api/stores/detail` AND NOT `/api/subscriptions/detail` ────────────────
 *
 *  The frontend stub names the second path, and it is the wrong one. Three reasons, in order of how
 *  much they cost:
 *
 *    1. THE POPULATION. `storeService.js`'s own header calls it the single most expensive misreading
 *       in this suite: a Subscriptions list is "currently paying", so a store that never subscribed
 *       is absent and — the one that catches people — so is a store that paid for two years and then
 *       uninstalled. The drawer's commonest subject is a store with NO subscription. Serving that
 *       from a `/subscriptions/` path names the answer after a population it does not have, and the
 *       next reader builds a count on the URL.
 *    2. THE FOLD. Every field here comes from `resolveStoreRow` — the same fold the roster uses —
 *       over the same three collections. A separate `/api/subscriptions/detail` would eventually
 *       re-derive it, which is the two-pages-disagree-about-MRR failure `IMPLEMENTATION.md` §3.10
 *       records and the reason `modules/revenue` publishes its ledger at all.
 *    3. THE COST OF BEING WRONG IS ASYMMETRIC. The path is one line in a client service that is
 *       today a `notImplemented` stub — nothing calls it successfully, so nothing breaks by moving
 *       it. A misnamed endpoint, once other clients exist, is permanent.
 *
 *  ──  THE ONE PLACE THIS ENDPOINT REFUSES WHERE THE ROSTER WOULD ANSWER ───────────────────
 *
 *  House rule: empty results are 200s. A LIST has an honest empty rendering — zero rows plus a
 *  banner — so an empty roster is always a 200. A RECORD does not: `StoreDetailDrawer` has exactly
 *  two rendering paths, the full panel or a critical banner carrying one sentence, and there is no
 *  third. A 200 for a store we cannot describe would render a finished-looking panel with a
 *  fabricated "Installed only" badge, an em dash in every date, `$0.00` in the money and "Not
 *  attributed" in the acquisition card — every one of those a claim about a named business that no
 *  data made. So "we have no record of this store" is a refusal CARRYING THE REASON, and the reason
 *  is chosen by the WATERMARK, never by the row count:
 *
 *      no watermark  ⇒ "no sync has completed, so we have not looked"
 *      a watermark   ⇒ "we looked, and the Partner API has no record of this store"
 *
 *  Those two must never read alike, and a row count cannot tell them apart.
 *
 *  ⚠️ EVERY OTHER EMPTY IS STILL A 200. No subscription, no payouts, no attribution, BigQuery
 *  unconfigured — all of them are a complete record with a stated reason. Refusing on any of those
 *  would render "Not available" over a store the Partner API describes perfectly well.
 *
 *  ── ONE JUDGEMENT INSTANT, AND EVERY EXCLUSION COUNTED ─────────────────────────────────────
 *
 *  `as_of` is read from the clock exactly once, here, and threaded into every fold. Nothing below it
 *  touches `new Date()`. The reads are UNBOUNDED and the folds clamp, so a future-dated row
 *  appears on the timeline — where it is a diagnosable fact — and decides no state, no total and no
 *  MRR figure. `diagnostics.future_events` / `future_transactions` are what prove the clamp ran.
 *
 *  ── WARNINGS ARE PER-STORE SENTENCES, NOT THE ROSTER'S ─────────────────────────────────────
 *
 *  `storeRoster.service` has a parallel catalogue and they are deliberately NOT shared. Every
 *  sentence names its own subject — one says "this roster is a floor", the other "this store's
 *  history is a floor" — and a shared string would have to say "this page" and mean two different
 *  things on two screens. The one property both catalogues must keep is that their strings are
 *  UNIQUE within a response, because React keys them by content.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import shopDomainHelper = require('../../shared/helpers/shopDomain.helper');
import attributionMatchHelper = require('../../shared/helpers/attributionMatch.helper');
import bigQueryModule = require('../../bigquery');
import conversion = require('../../conversion');
import revenue = require('../../revenue');
import storeConstants = require('../constants/storeRoster.constants');
import storeDetailConstants = require('../constants/storeDetail.constants');
import storeSpendHelper = require('../helpers/storeSpend.helper');
import installStateResolver = require('../resolvers/installState.resolver');
import storeRowResolver = require('../resolvers/storeRow.resolver');
import storeDetailRecordResolver = require('../resolvers/storeDetailRecord.resolver');
import storeTimelineResolver = require('../resolvers/storeTimeline.resolver');
import storeRosterRepository = require('../repositories/storeRoster.repository');
import storeDetailRepository = require('../repositories/storeDetail.repository');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { CohortSubscription } from '../../conversion/types/lifecycle.types';
import type { StoreAttributionRow } from '../types/storeRosterData.types';
import type { StoreDetailEventRow, StoreDetailTransactionRow } from '../types/storeDetailData.types';
import type {
    StoreAttributionState,
    StoreDataState
} from '../types/storeRoster.types';
import type {
    StoreDetailDiagnostics,
    StoreDetailParams,
    StoreDetailResponse
} from '../types/storeDetail.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { normaliseShopDomain } = shopDomainHelper;
const { pickNearestByInstalledAt } = attributionMatchHelper;
const { resolveBigQueryAvailability } = bigQueryModule;
const { resolveChargeCohortForDomains, CHARGE_COHORT_EVENT_TYPES, STATE_BASIS } = conversion;
const { liveSetAsOf } = revenue;
const {
    STORE_RELATIONSHIP_EVENT_TYPES,
    STORE_DATA_STATES,
    STORE_ATTRIBUTION_STATES
} = storeConstants;
const { MAX_TIMELINE_ENTRIES } = storeDetailConstants;
const { foldStoreSpend } = storeSpendHelper;
const { resolveInstallStates } = installStateResolver;
const { resolveStoreRow } = storeRowResolver;
const { resolveStoreDetailRecord } = storeDetailRecordResolver;
const { resolveStoreTimeline } = storeTimelineResolver;
const { findPartnerAppById } = storeRosterRepository;
const {
    findStoreEvents,
    findEventsForCharges,
    findStoreTransactions,
    findTransactionsForCharges,
    findStoreAttributionRows
} = storeDetailRepository;

/**
 * THE REFUSAL CATALOGUE. Each one is what the drawer prints inside a critical banner titled "Not
 * available", so each has to be a complete sentence an operator can act on with no other context.
 *
 * ⚠️ `StoreDetailDrawer.js:154` renders `resp.msg` verbatim and falls back to "Could not load this
 * store." — a message that is vague here costs the reader the whole explanation.
 */
const _REFUSALS = Object.freeze({
    noUser: 'User ID not available.',
    noApp: 'partner_app_id is required. Read it from GET /api/partner-apps.',
    appNotFound: 'Partner app not found.',

    noStore: 'shop_domain is required. Pass the store\'s myshopify domain, e.g. '
        + '?shop_domain=example.myshopify.com.',

    /**
     *  A REFUSAL, not a silent fallback to `shop_domain`. The client sends exactly ONE identity key
     * (`storePresentation.storeDetailRequestParams`), so a request carrying a tenant id carries no
     * domain — "ignoring" it would mean describing whichever store an empty needle happened to match.
     */
    tenantId: 'This build has no tenant records, so a tenant_id cannot be resolved to a store. It '
        + 'analyses one Shopify app from the Partner API, where a store is identified by its myshopify '
        + 'domain — retry with ?shop_domain=example.myshopify.com.',

    unreadableStore: (raw: string): string => `"${raw}" could not be read as a myshopify domain, so there `
        + 'is no store to describe. Pass the bare domain, e.g. example.myshopify.com.',

    /**
     * The WATERMARK IS NULL branch. "We have not looked" — and saying so is the whole point: an
     * operator who reads "no record of this store" on a database nobody has synced goes looking for a
     * store that is fine.
     */
    neverSynced: 'No Partner sync has completed for this app yet, so nothing is known about any store on '
        + 'it. This is not evidence that the store below does not exist — run a Partner sync and try '
        + 'again.',

    /**
     * The WATERMARK IS SET branch. We looked. ⚠️ It says what the roster's population IS, because the
     * commonest cause is a domain that exists only in listing analytics — which is a gap in the
     * Partner sync, not a store.
     */
    notFound: (domain: string): string => `The Partner API has no record of ${domain} on this app. Every `
        + 'store here comes from a Partner install, charge or payout event; a domain that appears only in '
        + 'listing analytics has no Partner record and cannot be described. If this store really is '
        + 'yours, run a LIFETIME Partner sync — its install may predate the synced event history.',

    failed: 'Could not read this store. Please try again.'
});

/**
 * THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE WITHIN A RESPONSE.
 *
 * The drawer does not render `warnings[]` today — the panel's own cards carry their empty states —
 * but the array ships anyway, because the full-page detail route named in `storePresentation
 * .storeDetailUrl` is the next consumer and because a caller reading this endpoint directly needs
 * the same caveats the roster publishes. Written for an operator who cannot see this code: what is
 * missing, what that does to the figures beside it, and what would fix it.
 */
const _WARNINGS = Object.freeze({
    /** ⚠️ Carries the availability message verbatim, so the operator reads the missing variable names. */
    attributionNotConnected: (message: string): string => `${message} `
        + 'This store therefore shows as "Not attributed" and its install-traffic country is blank; that is '
        + 'a missing data source, not evidence that it arrived directly.',

    attributionNeverSynced: 'Listing analytics is configured, but the install-attribution sync has never '
        + 'completed for this app. A store showing as "Not attributed" reflects that missing sync rather '
        + 'than evidence of direct arrival.',

    lifetimeFloor: 'No lifetime Partner sync has ever completed for this app, so this store\'s history is a '
        + 'FLOOR rather than a complete record — events older than the synced window have never been '
        + 'fetched, and an install among them is invisible rather than absent.',

    eventHistoryGap: (days: number): string => `The Partner event history for this app contains a stretch of `
        + `${days} day(s) carrying no events at all. Anything that happened to this store inside that `
        + 'stretch is missing from the timeline below. The data cannot say whether it was a genuinely quiet '
        + 'period or a sync window that failed and was never re-pulled, which is why it is published here '
        + 'rather than resolved.',

    shopNameMissing: (since: string): string => `This store shows its myshopify domain because no synced `
        + `event for it carries a name yet: store names are filled from the Partner API only for events `
        + `synced since ${since}. That is a sync boundary, not a store without a name — run a LIFETIME `
        + 'Partner sync to fill it in.',

    /**
     *  The same hole the roster had. `shop_name_coverage_since` is null beside a real
     * `earliest_event_at` when NO event in the whole record carries a name, which is the widest
     * possible boundary — and the `instanceof Date` test alone said nothing at all about it, so this
     * store's bare domain went unexplained on precisely the deployment where every store's does.
     */
    shopNameNoCoverage: 'This store shows its myshopify domain because no synced Partner event carries a '
        + 'store name yet — not this one, and not any other. Store names were added to the event record after '
        + 'the collection was in use, so only a sync that has run since then fills them. That is a sync '
        + 'boundary rather than a store without a name: run a LIFETIME Partner sync.',

    noTransactions: 'No settled payouts have ever been fetched for this app, so every spend figure on this '
        + 'record is empty because there is nothing to sum — not because this store pays nothing. Run a '
        + 'Partner sync, and check that your Partner API token has payout access.',

    noInstallRecord: 'No install or uninstall event is on record for this store, so its install state is '
        + 'unknown. It is known here from a charge or a payout alone, which usually means its install '
        + 'predates the synced event history — it is not evidence that the app is absent.',

    futureEvents: (events: number): string => `${events} event(s) for this store are dated in the future. `
        + 'They are shown on the timeline because a future-dated row is worth seeing, but they were ignored '
        + 'when deciding install state and subscription state. That is clock skew between Shopify and this '
        + 'server, or a corrupted row.',

    futureTransactions: (rows: number): string => `${rows} settled payout(s) for this store are dated in the `
        + 'future. They appear on the timeline and are excluded from every spend figure above, for the same '
        + 'reason: a payout that has not settled yet cannot be evidence today.',

    undatedEvents: (events: number): string => `${events} event(s) for this store carry no readable date and `
        + 'could not be placed on the timeline or used to decide any state. This should be unreachable from '
        + 'a stored record — please report it.',

    mixedSpendCurrency: (currencies: string[]): string => `This store has settled payouts in more than one `
        + `currency (${currencies.join(', ')}). Its total spend is a sum of unlike units — this build holds `
        + 'no exchange rates — so no currency is published beside it and the figure should not be read as an '
        + 'amount in any one of them.',

    inferredState: 'This store is shown as "On trial" on the weakest evidence available: Shopify supplied no '
        + 'billing date for its subscription and no payout has settled against it yet. That is the reading '
        + 'which claims no revenue and no loss, not a measured trial.',

    unclassifiedSubscription: 'This store has a subscription whose state could not be mapped to one of the '
        + 'five store states, so the record above shows it as "Installed only". That is a defect in this '
        + 'build, not a fact about this merchant — please report it.',

    testSubscriptionsExcluded: (subscriptions: number): string => `${subscriptions} test subscription(s) for `
        + 'this store were excluded from its status and its plan. Partner install events carry no test flag '
        + 'at all, so the install side of this record still counts them — the two sides are asymmetric and '
        + 'no available data can reconcile them.',

    skippedKeylessSubscriptionEvents: (events: number): string => `${events} subscription event(s) carried `
        + 'neither a charge id nor a shop domain and were skipped rather than pooled. Pooling them would have '
        + 'invented one merged subscription out of many.',

    multipleAttributionRows: (rows: number): string => `Listing analytics holds ${rows} install records for `
        + 'this store. The one nearest in time to the Partner install instant is the one shown; the others '
        + 'are on the timeline. More than one usually means the store installed, uninstalled and came back.',

    timelineTruncated: (withheld: number, shown: number): string => `This store has more history than one `
        + `response carries: the ${shown} most recent entries are shown and ${withheld} older one(s) are not. `
        + 'The figures above are computed from the complete history, not from the entries below.'
});

/**
 * An ISO string, or null.
 *
 * @param [value] - Any stored or resolved date.
 * @returns The ISO form, or null when there is no date.
 */
const _iso = (value?: Date | null): string | null => {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        return null;
    }
    return value.toISOString();
};

/**
 * Splits one store's events into what may decide a state and what may not.
 *
 * ⚠️ THE CLAMP THE CHARGE COHORT CANNOT APPLY FOR ITSELF. `resolveChargeCohortForDomains`'s header
 * is explicit that the CALLER must bound its fetch at `as_of` — the resolver validates the instant
 * and classifies against it, but it does not filter its input, so a future-dated ACCEPTED event
 * handed to it would classify a subscription that has not started. The roster gets this from a
 * `$lte` in its query; this endpoint fetches unbounded so the timeline can show the row, and pays
 * for that with this pass.
 *
 * @param rows - Every event for the store.
 * @param asOf - The judgement instant.
 * @returns `{ considered, future, undated }` — the rows a state may be decided from, and
 *   the counts of the two kinds that may not.
 */
const _partitionEvents = (rows: readonly StoreDetailEventRow[], asOf: Date) => {
    const considered: StoreDetailEventRow[] = [];
    let future = 0;
    let undated = 0;

    for (const row of rows) {
        const at = row && row.occurred_at instanceof Date && !Number.isNaN(row.occurred_at.getTime())
            ? row.occurred_at
            : null;
        if (!at) {
            undated += 1;
            continue;
        }
        if (at.getTime() > asOf.getTime()) {
            future += 1;
            continue;
        }
        considered.push(row);
    }

    return { considered, future, undated };
};

/**
 * Everything known about one store, from every collection that holds any of it.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query, already cast (not coerced) by the controller.
 * @param params1.partner_app_id - The app to look in. Required.
 * @param [params1.shop_domain] - The store. Required in practice; normalised here.
 * @param [params1.tenant_id] - ⚠️ Accepted and REFUSED with a reason. See the catalogue.
 * @returns The record, or an honest
 *   refusal carrying `{}` and the sentence the drawer will print.
 */
const getStoreDetail = (
    { user_id }: IdentityObject,
    { partner_app_id, shop_domain, tenant_id }: StoreDetailParams
): Promise<ServiceResult<StoreDetailResponse | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, _REFUSALS.noUser));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, _REFUSALS.noApp));
            }

            const rawDomain = shop_domain === undefined || shop_domain === null ? '' : String(shop_domain).trim();
            if (rawDomain === '') {
                // The tenant branch is tested FIRST so a client that sent one gets the sentence about
                // tenant ids rather than "shop_domain is required", which reads as though it had sent
                // nothing at all.
                const rawTenant = tenant_id === undefined || tenant_id === null ? '' : String(tenant_id).trim();
                return resolve(promiseReturnResult(false, {}, {}, rawTenant === '' ? _REFUSALS.noStore : _REFUSALS.tenantId));
            }

            //  THE NEEDLE IS NORMALISED, THE STORED VALUE IS NOT. Both sides of this join are
            // canonicalised on write, so the stored `shop_domain` IS the key; a client may still send
            // a raw URL rather than a bare domain, and normalising a needle is idempotent and free.
            // Re-normalising the STORED value on read is the waste that guarantee exists to remove.
            const domain = normaliseShopDomain(rawDomain);
            if (domain === '') {
                return resolve(promiseReturnResult(false, {}, {}, _REFUSALS.unreadableStore(rawDomain)));
            }

            const app = await findPartnerAppById(String(partner_app_id));
            if (!app) {
                return resolve(promiseReturnResult(false, {}, {}, _REFUSALS.appNotFound));
            }

            // THE ONE JUDGEMENT INSTANT. Read once, threaded into every fold below.
            const asOf = new Date();
            const appId = String(app._id);
            const warnings: string[] = [];

            // ── The two tier states, each read from a WATERMARK ──────────────
            let dataState: StoreDataState = STORE_DATA_STATES.NEVER_SYNCED;
            if (app.last_synced_at) {
                dataState = STORE_DATA_STATES.READY;
            }

            const availability = resolveBigQueryAvailability();
            let attributionState: StoreAttributionState = STORE_ATTRIBUTION_STATES.READY;
            if (!availability.enabled) {
                //  NOT a refusal. The record comes from the Partner API and is complete without
                // listing analytics; only the acquisition card and the install-traffic country are
                // empty, and both say so.
                attributionState = STORE_ATTRIBUTION_STATES.NOT_CONNECTED;
                warnings.push(_WARNINGS.attributionNotConnected(availability.message));
            } else if (!app.last_install_attrib_synced_at) {
                attributionState = STORE_ATTRIBUTION_STATES.NEVER_SYNCED;
                warnings.push(_WARNINGS.attributionNeverSynced);
            }

            // ── The first three reads, issued together ───────────────────────
            // The attribution read is SKIPPED when the tier is not connected: nothing could ever have
            // written a row, and issuing the query would only make the log read as though it had.
            const [events, transactions, attributionRows] = await Promise.all([
                findStoreEvents({ partner_app_id: appId, shop_domain: domain }),
                findStoreTransactions({ partner_app_id: appId, shop_domain: domain }),
                availability.enabled
                    ? findStoreAttributionRows({ partner_app_id: appId, shop_domain: domain })
                    : Promise.resolve<StoreAttributionRow[]>([])
            ]);

            //  THE ONE REFUSAL WHERE A LIST WOULD ANSWER — see the file header. The population is
            // the PARTNER record: an event or a payout. A domain known only to listing analytics is
            // deliberately NOT a store, exactly as on the roster, because admitting it would let an
            // export artefact invent a merchant. The discriminator between the two sentences is the
            // WATERMARK, never the row count.
            if (events.length === 0 && transactions.length === 0) {
                const reason = dataState === STORE_DATA_STATES.NEVER_SYNCED
                    ? _REFUSALS.neverSynced
                    : _REFUSALS.notFound(domain);
                return resolve(promiseReturnResult(false, {}, {}, reason));
            }

            // ── A.  THE SECOND EVENT READ, KEYED ON THIS STORE'S CHARGES ───
            //
            // The read above is DOMAIN-keyed, and one class of row has no domain to key on: a
            // `SubscriptionChargeCanceled` for a shop Shopify redacted between its install and its
            // cancellation carries no `shop_domain` at all (`gi_partner_app_events`'s model note
            // records this). Without this pass that subscription never receives an end event, never
            // churns, and the drawer shows CONVERTED over a table row that says CHURNED — the exact
            // divergence this module reuses ONE fold to prevent.
            //
            // ⚠️ The roster needs no equivalent: its charge pull is APP-scoped, so every such row is
            // already inside its single query. The asymmetry is the SCOPE, not a difference of
            // opinion about the data.
            //
            // The charge ids come from both sides — the store's own events AND its payouts — because
            // a charge whose only surviving event lost its domain is reachable through the payout
            // that settled it.
            const chargeIds = new Set<string>();
            for (const row of events) {
                const chargeId = String(row.charge_id || '');
                if (chargeId !== '') {
                    chargeIds.add(chargeId);
                }
            }
            for (const row of transactions) {
                const chargeId = String(row.charge_id || '');
                if (chargeId !== '') {
                    chargeIds.add(chargeId);
                }
            }

            const seenEventIds = new Set<string>();
            for (const row of events) {
                seenEventIds.add(String(row.partner_event_id || ''));
            }
            const allEvents: StoreDetailEventRow[] = events.slice();
            const allTransactions: StoreDetailTransactionRow[] = transactions.slice();
            let recoveredChargeEvents = 0;
            let recoveredChargePayouts = 0;

            if (chargeIds.size > 0) {
                // Skipped entirely on an empty set: an empty `$in` matches nothing, so issuing it
                // would only make the log read as though a question had been asked.
                const chargeQuery = { partner_app_id: appId, charge_ids: [...chargeIds] };
                const [chargeEvents, chargePayouts] = await Promise.all([
                    findEventsForCharges(chargeQuery),
                    findTransactionsForCharges(chargeQuery)
                ]);

                //  THE PAYOUT HALF OF THE SAME FIX. A subscription Shopify gave no `billingOn` for
                // is decided by whether money PROVABLY moved against its charge — and the payout that
                // proves it can itself have lost its `shop_domain` to a redaction. The roster gets
                // this for free (its aggregation groups by charge with no domain filter); a
                // domain-keyed read does not, and the store would read CONVERTED on the list and
                // ON_TRIAL in the panel over it.
                //
                // ⚠️ ONLY THE BLANK-DOMAIN ROWS ARE TAKEN. A row naming THIS store is already in the
                // first read (so the two sets are disjoint and need no de-duplication), and a row
                // naming another store is not this store's at all. The fold then keeps these rows out
                // of every total: a payout that names no shop cannot be attributed to one, which is
                // the same refusal the roster's spend aggregation makes explicitly.
                //
                // ⚠️ THEY ARE ALSO KEPT OFF THE TIMELINE, deliberately, and this is the one place
                // that surface withholds a row. A future-dated payout IS this store's and is shown;
                // a domain-less one is only INFERRED to be, through its charge, and its amount is
                // excluded from every figure on the panel. Showing it would put a payment on the
                // timeline whose money appears in no total beside it.
                for (const row of chargePayouts) {
                    if (String(row.shop_domain || '') !== '') {
                        continue;
                    }
                    allTransactions.push(row);
                    recoveredChargePayouts += 1;
                }

                for (const row of chargeEvents) {
                    const rowDomain = String(row.shop_domain || '');
                    // ⚠️ A charge belongs to one shop in practice, but "in practice" is not a
                    // constraint the database enforces. Admitting a row that names a DIFFERENT store
                    // would put another merchant's cancellation on this store's timeline.
                    if (rowDomain !== '' && rowDomain !== domain) {
                        continue;
                    }
                    const eventId = String(row.partner_event_id || '');
                    // De-duplicated on the collection's own idempotency key: the two reads overlap by
                    // construction, since most of a store's charge events carry both its domain and
                    // its charge id.
                    if (eventId !== '' && seenEventIds.has(eventId)) {
                        continue;
                    }
                    if (eventId !== '') {
                        seenEventIds.add(eventId);
                    }
                    allEvents.push(row);
                    recoveredChargeEvents += 1;
                }
            }

            // ── B. What may decide a state, and what may not ─────────────────
            const partition = _partitionEvents(allEvents, asOf);

            // ── C. Install state, from the relationship events ───────────────
            // Filtered to the four relationship types before the fold sees them: it counts anything
            // else as an `unrecognised_events` exclusion, which would be true and pointless — this
            // read deliberately fetches every type so the timeline can show them.
            const relationshipTypes = new Set(STORE_RELATIONSHIP_EVENT_TYPES);
            const installStates = resolveInstallStates({
                events: partition.considered.filter((row) => relationshipTypes.has(String(row.event_type))),
                as_of: asOf
            });
            const install = installStates.by_domain.get(domain);

            // ── D. The money, folded from one array in one pass ──────────────
            const spend = foldStoreSpend({ rows: allTransactions, as_of: asOf });

            /**
             * THE canonical "who is paying us and how much" predicate, evaluated at this request's
             * own instant.
             *
             * Reached through `modules/revenue`'s barrel rather than re-derived, because the
             * alternative is on record: two pages reconstructed MRR independently and disagreed.
             * `liveSetAsOf` accepts the FIRST row it sees per key, so handing it exactly the newest
             * settled payout — the row it would itself have selected — gives the same answer as the
             * full history.
             */
            const payingByDomain = liveSetAsOf(
                spend.latest_subscription_payout ? [spend.latest_subscription_payout] : [],
                asOf,
                config.REVENUE.ACTIVE_SUB_WINDOW_DAYS
            );
            const paying = payingByDomain.get(domain);

            // ── E. The subscriptions ─────────────────────────────────────────
            //
            // ⚠️ NO RE-JOIN OF THE RELATIONSHIP END EVENTS, unlike the roster. That endpoint splits
            // its event pull in two — a relationship read and a subscription read whose `$in` excludes
            // the types the first already fetched — so its service has to hand the uninstalls back to
            // this fold or every store whose only end signal is an uninstall reads as CONVERTED for
            // ever. Here the reads are UNFILTERED by type, so `UNINSTALL` and `DEACTIVATED` are
            // already in the merged array and the filter below simply keeps them — along with the
            // domain-less cancellations step A recovered, which is the other half of the same rule.
            const cohortTypes = new Set(CHARGE_COHORT_EVENT_TYPES);
            const cohort = resolveChargeCohortForDomains({
                events: partition.considered.filter((row) => cohortTypes.has(String(row.event_type))),
                as_of: asOf,
                settled_charge_ids: spend.settled_charge_ids,
                settled_domains: spend.settled_domains
            });
            const subscription: CohortSubscription | undefined = cohort.by_domain.get(domain);

            // ── F. The attribution pick ──────────────────────────────────────
            // NEAREST IN TIME to the Partner install instant, not latest-overall. With no install
            // instant to match against there is nothing to be nearest to, so the oldest record is used
            // and the lag stays null — the record says it could not be audited rather than implying it
            // was.
            const attribution = install && install.installed_at
                ? pickNearestByInstalledAt(attributionRows, install.installed_at)
                : (attributionRows[0] || null);

            // ── G. THE ROW — the same fold the roster publishes ──────────────
            //
            //  `undefined` WHEN THIS STORE HAS NO PAYOUTS AT ALL, exactly as the roster passes it:
            // there, a store with no payouts simply has no entry in the spend map. `resolveStoreRow`
            // reads that absence as `total_spend: null` — "there is nothing to sum" — while a present
            // rollup summing to zero reads as `total_spend: 0`, which is a real, renderable claim that
            // this merchant has paid nothing. Handing it a zeroed rollup would publish that claim over
            // a store whose payouts have merely never been synced.
            const spendRow = spend.transaction_count > 0
                ? {
                    shop_domain: domain,
                    total_gross: spend.total_gross,
                    total_net: spend.total_net,
                    transaction_count: spend.transaction_count,
                    first_payment_at: spend.first_payment_at,
                    last_payment_at: spend.last_payment_at,
                    currencies: spend.currencies
                }
                : undefined;

            const row = resolveStoreRow({
                shop_domain: domain,
                install,
                subscription,
                attribution,
                spend: spendRow,
                plan_interval: subscription && subscription.charge_id
                    ? spend.interval_by_charge.get(subscription.charge_id) || null
                    : null,
                //  `null` when this store has never settled a subscription payout at all, and a
                // number — including `0` — once it has. "We did not evaluate this" and "we evaluated
                // it and they are not paying now" are different answers.
                monthly_spend: spend.has_subscription_payout ? (paying ? paying.monthly_amount : 0) : null,
                has_subscription_payout: spend.has_subscription_payout
            });

            // ── H. The record, and the timeline ──────────────────────────────
            const planNameByCharge = new Map<string, string>();
            for (const item of cohort.subscriptions) {
                if (item.charge_id && item.plan_name && !planNameByCharge.has(item.charge_id)) {
                    planNameByCharge.set(item.charge_id, item.plan_name);
                }
            }

            // The OLDEST event of any type, so `summary.first_seen` is not null for a store known only
            // from a charge. The read is sorted newest-first, so it is the last dated row.
            let firstEventAt: Date | null = null;
            for (const item of partition.considered) {
                const at = item.occurred_at;
                if (at instanceof Date && !Number.isNaN(at.getTime()) && (!firstEventAt || at.getTime() < firstEventAt.getTime())) {
                    firstEventAt = at;
                }
            }

            const record = resolveStoreDetailRecord({
                row,
                subscription,
                subscriptions: cohort.subscriptions,
                spend,
                attribution,
                listing_url: app.listing_url,
                first_event_at: firstEventAt,
                attribution_state: attributionState
            });

            // EVERY event and EVERY payout, future-dated ones included — see the timeline resolver's
            // header. The state folds above saw only `partition.considered`.
            const timeline = resolveStoreTimeline({
                events: allEvents,
                // ⚠️ `transactions`, NOT `allTransactions` — see the note above the recovery loop.
                transactions,
                attribution: attributionRows,
                plan_name_by_charge: planNameByCharge,
                limit: MAX_TIMELINE_ENTRIES
            });

            // ── I. Everything that was excluded, said out loud ───────────────
            if (!app.lifetime_sync_completed_at) {
                warnings.push(_WARNINGS.lifetimeFloor);
            }
            // ⚠️ `> 0` and an explicit finite check, never truthiness: `0` is a MEASURED "no day-wide
            // hole", the most reassuring value the field can take, and `null` is "never measured".
            const gapDays = app.event_history_gap_days;
            if (typeof gapDays === 'number' && Number.isFinite(gapDays) && gapDays > 0) {
                warnings.push(_WARNINGS.eventHistoryGap(gapDays));
            }
            // Fired only when THIS store has no name — narrower than the roster's page-level
            // version, because a record can check its subject. ⚠️ THREE STATES, not two: a null
            // `shop_name_coverage_since` beside a real `earliest_event_at` is the widest boundary
            // there is (nothing we hold carries a name) and used to produce no sentence at all.
            const nameSince = app.shop_name_coverage_since;
            if (row.shop_name === '') {
                if (nameSince instanceof Date) {
                    warnings.push(_WARNINGS.shopNameMissing(nameSince.toISOString()));
                } else if (app.earliest_event_at instanceof Date) {
                    warnings.push(_WARNINGS.shopNameNoCoverage);
                }
            }
            if (!app.earliest_transaction_at) {
                warnings.push(_WARNINGS.noTransactions);
            }
            if (!row.has_install_record) {
                warnings.push(_WARNINGS.noInstallRecord);
            }
            if (partition.future > 0) {
                warnings.push(_WARNINGS.futureEvents(partition.future));
            }
            if (spend.future_transactions > 0) {
                warnings.push(_WARNINGS.futureTransactions(spend.future_transactions));
            }
            if (partition.undated > 0) {
                warnings.push(_WARNINGS.undatedEvents(partition.undated));
            }
            if (spend.currencies.length > 1) {
                warnings.push(_WARNINGS.mixedSpendCurrency(spend.currencies));
            }
            if (row.state_basis === STATE_BASIS.INFERRED) {
                warnings.push(_WARNINGS.inferredState);
            }
            if (subscription && !subscription.lifecycle_state) {
                warnings.push(_WARNINGS.unclassifiedSubscription);
            }
            if (cohort.diagnostics.test_subscriptions_excluded > 0) {
                warnings.push(_WARNINGS.testSubscriptionsExcluded(cohort.diagnostics.test_subscriptions_excluded));
            }
            if (cohort.diagnostics.skipped_keyless > 0) {
                warnings.push(_WARNINGS.skippedKeylessSubscriptionEvents(cohort.diagnostics.skipped_keyless));
            }
            if (attributionRows.length > 1) {
                warnings.push(_WARNINGS.multipleAttributionRows(attributionRows.length));
            }
            if (timeline.truncated > 0) {
                warnings.push(_WARNINGS.timelineTruncated(timeline.truncated, timeline.entries.length));
            }

            const diagnostics: StoreDetailDiagnostics = {
                events_read: allEvents.length,
                charge_keyed_events_recovered: recoveredChargeEvents,
                events_considered: partition.considered.length,
                future_events: partition.future,
                undated_events: partition.undated,
                transactions_read: transactions.length,
                charge_keyed_payouts_recovered: recoveredChargePayouts,
                future_transactions: spend.future_transactions,
                undated_transactions: spend.undated_transactions,
                attribution_rows: attributionRows.length,
                subscriptions: cohort.subscriptions.length,
                test_subscriptions_excluded: cohort.diagnostics.test_subscriptions_excluded,
                skipped_keyless_subscription_events: cohort.diagnostics.skipped_keyless,
                timeline_entries: timeline.entries.length,
                timeline_truncated: timeline.truncated
            };

            const payload: StoreDetailResponse = {
                app_id: appId,
                app_name: app.display_name,
                as_of: asOf.toISOString(),

                subscription: record.subscription,
                acquisition: record.acquisition,
                summary: record.summary,
                timeline: timeline.entries,
                subscriptions: record.subscriptions,
                payouts: record.payouts,
                app_review: record.app_review,

                //  ALWAYS `null`: `gi_store_enrichments` does not exist yet. The key is published
                // NOW so the ingest wave fills a slot rather than adding one — no consumer's
                // destructure changes on the day it lands, and `customer_name_source` gains its
                // fourth value (`operator`) additively because it was published as a SOURCE from the
                // first release rather than being inferred from which field was non-empty.
                operator: null,
                provenance: record.provenance,
                unavailable: record.unavailable,

                meta: {
                    last_synced_at: _iso(app.last_synced_at),
                    //  ALWAYS null until the ingest wave: `gi_store_enrichments` and its watermark
                    // do not exist. A watermark rather than a row count, for the reason every other
                    // tier state here is one.
                    last_store_push_at: null,
                    earliest_event_at: _iso(app.earliest_event_at),
                    earliest_transaction_at: _iso(app.earliest_transaction_at),
                    lifetime_sync_completed_at: _iso(app.lifetime_sync_completed_at),
                    shop_name_coverage_since: _iso(app.shop_name_coverage_since)
                },

                //  READY by construction — a store cannot be described from a tier that has never
                // synced, and that case refused above. Published so a consumer need not know that.
                data_state: dataState,
                attribution_state: attributionState,
                // DE-DUPLICATED, and not because any message here is expected twice: a consumer that
                // keys these by content — as the Stores page does — silently DROPS one of a duplicate
                // pair, so a repeated message takes its own twin down with it.
                warnings: [...new Set(warnings)],
                diagnostics
            };

            return resolve(promiseReturnResult(true, payload, {}, 'Store detail resolved.'));
        } catch (error) {
            customConsoleError('ERROR: Store storeDetailService getStoreDetail', error);
            return resolve(promiseReturnResult(false, {}, error, _REFUSALS.failed));
        }
    });
};

export = {
    getStoreDetail
};
