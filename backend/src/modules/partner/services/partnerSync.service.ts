'use strict';

/**
 * ============================================================================
 *  PARTNER SYNC — pulls the entire factual basis of this application
 * ============================================================================
 *
 *  Two GraphQL connections, walked page by page and upserted into Mongo:
 *
 *    app.events   — installs, uninstalls, reactivations, freezes, and every
 *                   subscription charge event. The SPINE. Install state,
 *                   cohorts, trials and churn are all folds over these rows.
 *    transactions — settled payouts. CASH, never run-rate.
 *
 *  Idempotent by construction: re-running the same window produces zero new
 *  rows, because each collection has a unique key and every write is an upsert
 *  against it. That is what makes the overlap on incremental runs free, and
 *  what makes "just re-sync it" a real repair rather than a duplication event.
 *
 *  ── Why the charge block is requested ───────────────────────────────────────
 *  Each subscription-charge event asks for `charge { id name test billingOn
 *  amount { … } }`. `billingOn` IS THE TRIAL-END DATE, and it is the
 *  highest-fidelity input anything downstream has: with it, a trial's length is
 *  a fact Shopify told us, and without it the only alternative is inferring one
 *  from the gap between ACCEPTED and ACTIVATED, which silently invents a number
 *  for every charge that never activated. `name` gives the plan, `test` marks
 *  the charges that must be excluded from revenue, and `amount` is the
 *  contracted price the MRR fold runs on.
 *
 *  ── Why the shop block asks for all four fields ─────────────────────────────
 *  `shop { id myshopifyDomain name avatarUrl }` is the WHOLE of the Partner
 *  API's `Shop` object — it has exactly those four fields, on every supported
 *  version, and no country, timezone, plan tier or creation date to ask for.
 *
 *  `name` is the merchant-facing store name, and this is the only universal
 *  source of one. The listing tier's `shop_name` covers only the installs GA4
 *  attributed (~66% typically, 0% with BigQuery unconfigured); this covers every
 *  shop that ever fired an event. It is promoted to a column — see
 *  `models/partner/partnerAppEvent.model`. `avatarUrl` is NOT promoted: it is
 *  read off `raw_event` on the single-store detail path, where one document
 *  fetch is free.
 *
 *   PROVED HASH-SAFE BEFORE IT WAS ADDED, and the proof is the only reason
 *  this was a two-word change. `_hashEventId` reads exactly six inputs —
 *  partner_api_app_id | event_typename | occurred_at | shop_id | shop_domain |
 *  charge_id. `name` and `avatarUrl` are not among them, so no
 *  `partner_event_id` can change, no row can duplicate, and no install, trial or
 *  conversion count built by counting these rows can move. Widening a selection
 *  set that DOES feed the hash — any `charge { id … }` block — is a different
 *  change entirely: it re-keys every row it touches and needs a full re-sync
 *  rather than an incremental one. Prove which kind you have before you edit.
 *
 *  ── The uninstall reason: requested, stored, and promised to nobody ─────────
 *  `... on RelationshipUninstalled { reason description }` is the merchant's OWN
 *  stated reason for leaving — the only place Shopify exposes one.
 *
 *  It was safe to add for a specific, checked reason: both fields are nullable
 *  Strings on `RelationshipUninstalled` in EVERY Partner API version this client
 *  can reach (2025-10 through 2026-07; Shopify serves roughly the last four, and
 *  the client refuses an older pin with its own message). That matters because
 *  GraphQL validation is all-or-nothing per DOCUMENT: a field the server does
 *  not know rejects the whole query, which would stop installs, uninstalls and
 *  every charge event — the entire spine — not just the fragment. A selection
 *  that is not valid on every reachable version does not belong in here.
 *
 *  ⚠️ NOTHING MAY PROMISE IT TO A READER YET. It is unverified against a live
 *  org: no response has been observed carrying a non-null value. It is stored in
 *  `raw_event` and nowhere else — no column, no mapping, no facet, no UI —
 *  because a column or a filter built on it would advertise an uninstall-reason
 *  feature that renders empty for every store. Look at `raw_event` on the
 *  single-store detail path; publish it once a real payload has one.
 * ============================================================================
 */

import crypto = require('crypto');
import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import partnerVocab = require('../../../constants/partnerVocab.constants');
import constants = require('../constants/partnerSync.constants');
// The module's two JOIN BRIDGES, applied here on the WRITE side. Resolving them at read time is how
// one bridge ends up with three spellings and the same store joins in one report and not another.
import shopDomainHelper = require('../../shared/helpers/shopDomain.helper');
import chargeIdHelper = require('../../shared/helpers/chargeId.helper');
import partnerGidHelper = require('../../shared/helpers/partnerGid.helper');
import coverageHelper = require('../helpers/coverage.helper');
import partnerApiClient = require('../clients/partnerApi.client');
import partnerAppRepository = require('../repositories/partnerApp.repository');
import partnerFactRepository = require('../repositories/partnerFact.repository');
import partnerCoverageRepository = require('../repositories/partnerCoverage.repository');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type { MoneyAmount } from '../../shared/types/entity.types';
import type { CoverageRecord } from '../types/coverage.types';
import type { EmptyPayload } from '../types/partnerResult.types';
import type {
    HashEventIdInput,
    PartnerApiMoney,
    PartnerEventUpsertRow,
    PartnerSyncPullInput,
    PartnerSyncStats,
    PartnerSyncSummary,
    PartnerTransactionSyncStats,
    PartnerTransactionUpsertRow,
    ResolveSinceInput,
    ResolvedSince,
    RunFullSyncInput
} from '../types/partnerSync.types';

const { customConsoleLog, customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { PARTNER_EVENT_TYPES, PARTNER_TRANSACTION_TYPES, PARTNER_SYNC_MODES, PARTNER_LIFETIME_SINCE_ISO } = partnerVocab;
const {
    PARTNER_API_EVENT_TYPENAME_MAP,
    PARTNER_API_TRANSACTION_TYPENAME_MAP,
    PARTNER_API_PAGE_SIZE,
    PARTNER_API_MAX_PAGES,
    PARTNER_INCREMENTAL_OVERLAP_DAYS
} = constants;
const { normaliseShopDomain } = shopDomainHelper;
const { extractChargeNumericId } = chargeIdHelper;
const { normalizePartnerAppGid, PARTNER_APP_GID_HELP_MESSAGE } = partnerGidHelper;
const { computeCoverage } = coverageHelper;
const { fetchAllPages } = partnerApiClient;

// Widened to `string[]` so the membership test below stays legal: `Object.values` of a frozen
// literal map yields the literal UNION, which rejects the arbitrary string a job payload carries.
const _partnerSyncModeValues: string[] = Object.values(PARTNER_SYNC_MODES);

// ── GraphQL documents ───────────────────────────────────────────────────────
//
// Hard-coded, never assembled at run time. The client refuses any document
// containing a mutation, and a constructed string is how that guarantee gets
// quietly weakened.

const APP_EVENTS_QUERY = `
    query GetAppEvents($appId: ID!, $occurredAtMin: DateTime!, $first: Int!, $after: String) {
        app(id: $appId) {
            events(
                types: [
                    RELATIONSHIP_INSTALLED,
                    RELATIONSHIP_UNINSTALLED,
                    RELATIONSHIP_REACTIVATED,
                    RELATIONSHIP_DEACTIVATED,
                    SUBSCRIPTION_CHARGE_ACCEPTED,
                    SUBSCRIPTION_CHARGE_ACTIVATED,
                    SUBSCRIPTION_CHARGE_CANCELED,
                    SUBSCRIPTION_CHARGE_DECLINED,
                    SUBSCRIPTION_CHARGE_EXPIRED,
                    ONE_TIME_CHARGE_ACCEPTED,
                    USAGE_CHARGE_APPLIED
                ],
                occurredAtMin: $occurredAtMin,
                first: $first,
                after: $after
            ) {
                edges {
                    cursor
                    node {
                        __typename
                        occurredAt
                        shop { id myshopifyDomain name avatarUrl }
                        # The merchant's own stated reason for leaving. UNVERIFIED against a live
                        # org — see the header. It lands in raw_event and nothing may promise it.
                        ... on RelationshipUninstalled {
                            reason
                            description
                        }
                        ... on SubscriptionChargeAccepted {
                            charge {
                                id
                                name
                                test
                                billingOn
                                amount { amount currencyCode }
                            }
                        }
                        ... on SubscriptionChargeActivated {
                            charge {
                                id
                                name
                                test
                                billingOn
                                amount { amount currencyCode }
                            }
                        }
                        ... on SubscriptionChargeCanceled {
                            charge {
                                id
                                name
                                test
                                billingOn
                                amount { amount currencyCode }
                            }
                        }
                        ... on SubscriptionChargeDeclined {
                            charge {
                                id
                                name
                                test
                                billingOn
                                amount { amount currencyCode }
                            }
                        }
                        ... on SubscriptionChargeExpired {
                            charge {
                                id
                                name
                                test
                                billingOn
                                amount { amount currencyCode }
                            }
                        }
                        ... on OneTimeChargeAccepted {
                            charge {
                                id
                                name
                                test
                                amount { amount currencyCode }
                            }
                        }
                    }
                }
                pageInfo { hasNextPage }
            }
        }
    }
`;

const TRANSACTIONS_QUERY = `
    query GetTransactions($appId: ID!, $createdAtMin: DateTime!, $first: Int!, $after: String) {
        transactions(
            appId: $appId,
            createdAtMin: $createdAtMin,
            types: [APP_SUBSCRIPTION_SALE, APP_USAGE_SALE, APP_ONE_TIME_SALE, APP_SALE_CREDIT, APP_SALE_ADJUSTMENT],
            first: $first,
            after: $after
        ) {
            edges {
                cursor
                node {
                    __typename
                    id
                    createdAt
                    ... on AppSubscriptionSale {
                        billingInterval
                        chargeId
                        netAmount { amount currencyCode }
                        grossAmount { amount currencyCode }
                        shopifyFee { amount currencyCode }
                        shop { id myshopifyDomain name avatarUrl }
                    }
                    ... on AppUsageSale {
                        netAmount { amount currencyCode }
                        grossAmount { amount currencyCode }
                        shopifyFee { amount currencyCode }
                        shop { id myshopifyDomain name avatarUrl }
                    }
                    ... on AppOneTimeSale {
                        netAmount { amount currencyCode }
                        grossAmount { amount currencyCode }
                        shopifyFee { amount currencyCode }
                        shop { id myshopifyDomain name avatarUrl }
                    }
                    ... on AppSaleCredit {
                        netAmount { amount currencyCode }
                        grossAmount { amount currencyCode }
                        shopifyFee { amount currencyCode }
                        shop { id myshopifyDomain name avatarUrl }
                    }
                    ... on AppSaleAdjustment {
                        netAmount { amount currencyCode }
                        grossAmount { amount currencyCode }
                        shopifyFee { amount currencyCode }
                        shop { id myshopifyDomain name avatarUrl }
                    }
                }
            }
            pageInfo { hasNextPage }
        }
    }
`;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * The LOCAL identity of one partner event.
 *
 * Not a Shopify id — the Partner API's event connection exposes none, so the row's identity has to
 * be derived from the event's own content.
 *
 *  `charge_id` is the EVENT DISCRIMINATOR, and without it this hash was lossy. The other five
 * inputs describe the shop and the instant, so two GENUINE events of the same type for one shop in
 * the same second hashed identically and the second upserted straight over the first — one row
 * where there were two. That is not hypothetical: a plan change fires SUBSCRIPTION_CHARGE_ACCEPTED
 * for the new charge in the same second Shopify cancels the old one, and `occurredAt` has no
 * sub-second component to separate them. Every install, trial and conversion count in this
 * application is built by counting these rows, so a collapse understated all of them silently.
 *
 * @param params0 - The six identity inputs.
 * @returns Hex sha256. Stable for the same event across every re-sync.
 */
const _hashEventId = ({ partner_api_app_id, event_typename, occurred_at, shop_id, shop_domain, charge_id }: HashEventIdInput): string => {
    const payload = [
        partner_api_app_id || '',
        event_typename || '',
        occurred_at || '',
        shop_id || '',
        shop_domain || '',
        // Empty for every event that carries no charge block — INSTALL, UNINSTALL, REINSTALL and
        // DEACTIVATED all legitimately have none — so those keep the exact five-value behaviour and
        // only the charge events gain the discriminator they needed.
        charge_id || ''
    ].join('|');
    return crypto.createHash('sha256').update(payload).digest('hex');
};

/**
 * Maps a Partner API event `__typename` onto our vocabulary.
 *
 * An unmapped typename becomes OTHER rather than throwing: Shopify adds event types without
 * warning, and a sync that dies on an unknown one stops delivering the events it DOES understand.
 *
 * @param typename - The GraphQL `__typename`.
 * @returns One of `PARTNER_EVENT_TYPES`.
 */
const _mapEventTypename = (typename: string): string => PARTNER_API_EVENT_TYPENAME_MAP[typename] || PARTNER_EVENT_TYPES.OTHER;

/**
 * Maps a Partner API transaction `__typename` onto our vocabulary.
 *
 * @param typename - The GraphQL `__typename`.
 * @returns One of `PARTNER_TRANSACTION_TYPES`.
 */
const _mapTransactionTypename = (typename: string): string => PARTNER_API_TRANSACTION_TYPENAME_MAP[typename] || PARTNER_TRANSACTION_TYPES.OTHER;

/**
 * Converts the Partner API's money shape into the one we store.
 *
 * ⚠️ The rename is the point: the API says `currencyCode`, the stored subdoc says `currency`. This
 * function is the only place the two names meet, so a `.currencyCode` anywhere else is reading a
 * field that is always undefined.
 *
 * A missing block becomes `{ amount: 0, currency: '' }` rather than null, because the schema
 * defaults it that way and a money subdoc that is sometimes absent forces every reader to guard.
 *
 * @param m - The API's `{ amount, currencyCode }`, or nothing.
 * @returns The stored shape.
 */
const _extractMoney = (m: PartnerApiMoney | null | undefined): MoneyAmount => {
    if (!m || typeof m !== 'object') {
        return { amount: 0, currency: '' };
    }
    return {
        amount: Number(m.amount) || 0,
        currency: m.currencyCode || ''
    };
};

/**
 * The merchant-facing store name off a Partner event node.
 *
 * `''` for anything that is not a usable string — never null, never undefined — so the column holds
 * ONE type on every row this build writes and no reader has to guard before trimming or comparing.
 *
 *  `''` MEANS "THIS ROW CARRIES NO NAME", WHICH IS A FACT ABOUT THE SYNC THAT WROTE IT, NOT ABOUT
 * THE STORE. Shopify's `Shop.name` is non-null, so a shop with a genuinely empty name does not
 * exist; an empty value here is a row written before the `name` selection landed, or one whose
 * `shop` block was absent. The boundary between the two is measured onto the app row as
 * `shop_name_coverage_since` — a read layer reports THAT, and never renders the blank as an answer.
 *
 * @param node - A Partner API event node, or nothing.
 * @returns The trimmed name, or '' when the node carried none.
 */
const _readShopName = (node: any): string => {
    const _name = node && node.shop && node.shop.name;
    if (typeof _name !== 'string') {
        return '';
    }
    return _name.trim();
};

/**
 * ISO timestamp for N days before now.
 *
 * @param days - How far back.
 * @returns ISO 8601 string, which is what the Partner API's DateTime arguments take.
 */
const _isoNDaysAgo = (days: number): string => {
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return d.toISOString();
};

/**
 * An EMPTY-but-COMPLETE stats block, flagged as an incomplete run.
 *
 * Used on the catch path, where we genuinely do not know what was fetched. `partial: true` is the
 * load-bearing field: a caller reads it to decide whether the window may be considered covered, and
 * a zeroed block WITHOUT it would read as "ran fine, found nothing".
 *
 * @returns Zeroes, marked partial.
 */
const _emptyStats = (): PartnerSyncStats => {
    return { fetched: 0, upserted: 0, existed: 0, skipped: 0, partial: true, truncated: false };
};

/**
 * The same, for the transaction half, which additionally reports `relevant`.
 *
 * @returns Zeroes, marked partial.
 */
const _emptyTransactionStats = (): PartnerTransactionSyncStats => {
    return { fetched: 0, relevant: 0, upserted: 0, existed: 0, skipped: 0, partial: true, truncated: false };
};

/**
 * Resolves the window this run will pull, and the mode that produced it.
 *
 *   - LIFETIME → `PARTNER_LIFETIME_SINCE_ISO` (2009, before Shopify's app ecosystem existed)
 *   - INCREMENTAL with a watermark → `last_synced_at` − overlap days
 *   - INCREMENTAL without one → `lookback_days` back from now
 *   - AUTO → LIFETIME while the app has never completed a lifetime pull, INCREMENTAL after
 *
 * ⚠️ The AUTO test reads `lifetime_sync_completed_at`, NOT `last_synced_at`.
 *
 * They differ in exactly the case that matters. `last_synced_at` advances after ANY successful run,
 * so an app whose first run was an explicit INCREMENTAL would answer "not my first sync" forever
 * and AUTO would never backfill it — the app would sit permanently on a partial history while every
 * all-time figure quietly under-reported. Gating on the lifetime marker means AUTO keeps choosing
 * LIFETIME until one has actually completed, and then stops. That is what the coverage gate on the
 * app row was created for, and it is why a "total" is allowed to call itself one.
 *
 * @param params0 - The inputs.
 * @param params0.partnerApp - The app row, for its watermarks.
 * @param [params0.mode] - AUTO / LIFETIME / INCREMENTAL.
 * @param [params0.lookback_days] - Only consulted for an INCREMENTAL run with no watermark.
 * @returns `{ since_iso, resolved_mode }`. `resolved_mode` is never AUTO.
 */
const _resolveSince = ({ partnerApp, mode, lookback_days }: ResolveSinceInput): ResolvedSince => {
    const _mode = mode || PARTNER_SYNC_MODES.AUTO;
    let _resolved: string = _mode;
    if (_resolved === PARTNER_SYNC_MODES.AUTO) {
        _resolved = PARTNER_SYNC_MODES.LIFETIME;
        if (partnerApp.lifetime_sync_completed_at) {
            _resolved = PARTNER_SYNC_MODES.INCREMENTAL;
        }
    }

    if (_resolved === PARTNER_SYNC_MODES.LIFETIME) {
        return { since_iso: PARTNER_LIFETIME_SINCE_ISO, resolved_mode: _resolved };
    }

    // INCREMENTAL. The overlap re-pulls a few days we already hold: the upserts are idempotent, so
    // it costs a little API budget, while NOT overlapping loses late-reported events invisibly.
    if (partnerApp.last_synced_at) {
        const overlapMs = PARTNER_INCREMENTAL_OVERLAP_DAYS * 24 * 60 * 60 * 1000;
        const since = new Date(new Date(partnerApp.last_synced_at).getTime() - overlapMs);
        return { since_iso: since.toISOString(), resolved_mode: _resolved };
    }

    // The leading `typeof` conjunct is what lets `lookback_days > 0` type-check against an optional
    // parameter. It cannot change the outcome: `Number.isFinite` does not coerce, so it already
    // returns true only for an actual number.
    let _lookback = config.PARTNER.DEFAULT_LOOKBACK_DAYS;
    if (typeof lookback_days === 'number' && Number.isFinite(lookback_days) && lookback_days > 0) {
        _lookback = lookback_days;
    }
    return { since_iso: _isoNDaysAgo(_lookback), resolved_mode: _resolved };
};

// ── Sync halves ─────────────────────────────────────────────────────────────

/**
 * Pulls and upserts the event connection.
 *
 * Persists whatever WAS fetched even on a partial or failed pull. The upserts are idempotent and
 * the watermark only advances on a fully successful run, so the next run re-pulls the same window
 * and dedupes — discarding a partial page set would lose work for no benefit at all.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator, or a worker sentinel.
 * @param params1 - The pull.
 * @param params1.partnerApp - The app row being synced.
 * @param params1.partner_app_gid - Canonical `gid://partners/App/<id>`.
 * @param params1.since_iso - Lower bound of the window.
 * @returns Always a complete stats block, on success and failure alike.
 */
const _syncEvents = ({ user_id }: IdentityObject, { partnerApp, partner_app_gid, since_iso }: PartnerSyncPullInput): Promise<ServiceResult<PartnerSyncStats>> => {
    return new Promise(async (resolve) => {
        try {
            const pageResp = await fetchAllPages(
                { user_id },
                {
                    query: APP_EVENTS_QUERY,
                    variables: { appId: partner_app_gid, occurredAtMin: since_iso },
                    connectionPath: 'app.events',
                    pageSize: PARTNER_API_PAGE_SIZE,
                    maxPages: PARTNER_API_MAX_PAGES
                }
            );
            const rawNodes: any[] = pageResp.data && Array.isArray(pageResp.data.nodes) ? pageResp.data.nodes : [];

            let skipped = 0;
            const rows: PartnerEventUpsertRow[] = [];
            for (const node of rawNodes) {
                const event_typename = node && node.__typename;
                const occurred_at = node && node.occurredAt;
                const shop_id = node && node.shop && node.shop.id;
                // NORMALISED ON THE WAY IN, once, instead of by each consumer that later joins on
                // it. The raw value survives in `raw_event.shop.myshopifyDomain`, so canonicalising
                // the column loses nothing and makes the stored value the join key itself.
                const shop_domain = normaliseShopDomain(node && node.shop && node.shop.myshopifyDomain);
                // PROMOTED out of `raw_event.shop.name`, and DELIBERATELY NOT part of the identity
                // hash below — see the header's proof. It is written as $set payload, so a re-sync
                // repairs a row that was stored before this selection existed.
                const shop_name = _readShopName(node);
                // PROMOTED out of `raw_event.charge.id` — a Mixed blob, and therefore unindexable —
                // and stripped to the bare numeric id so it joins the transaction side with no
                // transformation on either side. The extractor is STRICT: it yields null (hence '')
                // rather than passing an unrecognised string through, so a GID can never reach the
                // column and match nothing silently.
                const charge_id = extractChargeNumericId(node && node.charge && node.charge.id) || '';

                if (!event_typename || !occurred_at) {
                    skipped += 1;
                    continue;
                }

                rows.push({
                    partner_event_id: _hashEventId({
                        partner_api_app_id: partnerApp.partner_api_app_id,
                        event_typename,
                        occurred_at,
                        shop_id,
                        // The NORMALISED domain, deliberately: the hash must be computed over the
                        // value that is STORED, or the same event pulled twice could hash two ways.
                        shop_domain,
                        charge_id
                    }),
                    shop_domain,
                    shop_id: shop_id || '',
                    shop_name,
                    charge_id,
                    occurred_at: new Date(occurred_at),
                    event_type: _mapEventTypename(event_typename),
                    raw_event: node
                });
            }

            const tally = await partnerFactRepository.bulkUpsertPartnerEvents({ partner_app_id: partnerApp._id, rows });

            const _eventStats: PartnerSyncStats = {
                fetched: rawNodes.length,
                upserted: tally.upserted,
                existed: tally.matched,
                skipped: skipped + tally.errors,
                partial: !!(pageResp.data && pageResp.data.partial),
                truncated: !!(pageResp.data && pageResp.data.truncated)
            };

            if (!pageResp.status) {
                return resolve(promiseReturnResult(false, _eventStats, pageResp.error, pageResp.msg || 'Failed to fetch events.'));
            }
            return resolve(promiseReturnResult(true, _eventStats, {}, 'Events synced.'));
        } catch (error) {
            customConsoleError('ERROR: [Partner:Sync] _syncEvents threw', error);
            return resolve(promiseReturnResult(false, _emptyStats(), error, 'Events sync failed.'));
        }
    });
};

/**
 * Pulls and upserts the transaction connection.
 *
 * Filtering is server-side via the `appId` argument, so every node returned is ours — `relevant`
 * exists to make that explicit rather than to record a filter this code performs.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator, or a worker sentinel.
 * @param params1 - The pull.
 * @param params1.partnerApp - The app row being synced.
 * @param params1.partner_app_gid - Canonical `gid://partners/App/<id>`.
 * @param params1.since_iso - Lower bound of the window.
 * @returns Always a complete stats block.
 */
const _syncTransactions = ({ user_id }: IdentityObject, { partnerApp, partner_app_gid, since_iso }: PartnerSyncPullInput): Promise<ServiceResult<PartnerTransactionSyncStats>> => {
    return new Promise(async (resolve) => {
        try {
            const pageResp = await fetchAllPages(
                { user_id },
                {
                    query: TRANSACTIONS_QUERY,
                    variables: { appId: partner_app_gid, createdAtMin: since_iso },
                    connectionPath: 'transactions',
                    pageSize: PARTNER_API_PAGE_SIZE,
                    maxPages: PARTNER_API_MAX_PAGES
                }
            );
            const rawNodes: any[] = pageResp.data && Array.isArray(pageResp.data.nodes) ? pageResp.data.nodes : [];

            let skipped = 0;
            const rows: PartnerTransactionUpsertRow[] = [];
            for (const node of rawNodes) {
                const shopify_transaction_id = node && node.id;
                if (!shopify_transaction_id) {
                    skipped += 1;
                    continue;
                }
                if (!node.createdAt) {
                    skipped += 1;
                    continue;
                }

                rows.push({
                    shopify_transaction_id,
                    created_at: new Date(node.createdAt),
                    type: _mapTransactionTypename(node.__typename),
                    // Both join keys normalised here, on the way in, by the same helpers the event
                    // writer uses — so the two collections hold ONE spelling of one domain and one
                    // form of one charge id. Only AppSubscriptionSale carries `chargeId`; the other
                    // four types store ''.
                    shop_domain: normaliseShopDomain(node.shop && node.shop.myshopifyDomain),
                    shop_id: (node.shop && node.shop.id) || '',
                    // ⚠️ Null, not ''. This is the ONLY place Shopify exposes billing frequency, and
                    // an MRR fold reads a null interval as MONTHLY — so an annual subscriber whose
                    // row lost this field is booked at twelve times its true rate. Null says "this
                    // type has no interval"; the schema default is null for the same reason.
                    billing_interval: node.billingInterval || null,
                    charge_id: extractChargeNumericId(node.chargeId) || '',
                    net_amount: _extractMoney(node.netAmount || node.amount),
                    gross_amount: _extractMoney(node.grossAmount),
                    shopify_fee: _extractMoney(node.shopifyFee),
                    raw_transaction: node
                });
            }

            const tally = await partnerFactRepository.bulkUpsertPartnerTransactions({ partner_app_id: partnerApp._id, rows });

            const _txnStats: PartnerTransactionSyncStats = {
                fetched: rawNodes.length,
                relevant: rawNodes.length,
                upserted: tally.upserted,
                existed: tally.matched,
                skipped: skipped + tally.errors,
                partial: !!(pageResp.data && pageResp.data.partial),
                truncated: !!(pageResp.data && pageResp.data.truncated)
            };

            if (!pageResp.status) {
                return resolve(promiseReturnResult(false, _txnStats, pageResp.error, pageResp.msg || 'Failed to fetch transactions.'));
            }
            return resolve(promiseReturnResult(true, _txnStats, {}, 'Transactions synced.'));
        } catch (error) {
            customConsoleError('ERROR: [Partner:Sync] _syncTransactions threw', error);
            return resolve(promiseReturnResult(false, _emptyTransactionStats(), error, 'Transactions sync failed.'));
        }
    });
};

// ── Public ──────────────────────────────────────────────────────────────────

/**
 * Runs one partner sync: both connections, then the coverage measurement.
 *
 * This is a job handler — the runner calls it with the worker identity and the job's stored
 * payload, so every field of that payload is UNVALIDATED caller input and is checked here.
 *
 * ── What "success" costs ──
 * The watermark advances ONLY when both halves succeeded AND coverage was measured. That is
 * deliberate on both counts:
 *   - a partial pull that advanced the watermark would permanently skip the window it failed on,
 *     and nothing would ever revisit it;
 *   - a run whose coverage could not be measured would leave the gates describing an older, smaller
 *     record while `last_synced_at` claimed the data was fresh, and the honesty layer reads those
 *     gates to decide what it may publish.
 * Re-running costs API budget and nothing else, because every write is an idempotent upsert.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator, or the worker sentinel.
 * @param params1 - The job payload.
 * @param [params1.partner_app_id] - Which app to sync. Declared optional because a stored payload cannot promise it; refused here when it is absent.
 * @param [params1.mode] - AUTO / LIFETIME / INCREMENTAL. Unrecognised values fall back to AUTO.
 * @param [params1.lookback_days] - Only used for an INCREMENTAL run on an app with no watermark.
 * @returns The run summary, or `{}` when the run never started.
 */
const runFullSync = ({ user_id }: IdentityObject, { partner_app_id, mode, lookback_days }: RunFullSyncInput): Promise<ServiceResult<PartnerSyncSummary | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'partner_app_id is required.'));
            }

            const partnerApp = await partnerAppRepository.findPartnerAppById(partner_app_id);
            if (!partnerApp) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }
            if (!partnerApp.is_active) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app is inactive.'));
            }
            if (!partnerApp.partner_api_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app is missing partner_api_app_id.'));
            }

            // Canonicalise on the READ side as well as the write side: a row created before the
            // create-path validation existed can hold a bare numeric id, which the Partner API
            // rejects with INVALID_GID. Normalising here repairs those rows with no migration, and a
            // value we cannot interpret fails the job immediately instead of burning two round trips.
            const _partnerAppGid = normalizePartnerAppGid(partnerApp.partner_api_app_id);
            if (!_partnerAppGid) {
                customConsoleError('ERROR: [Partner:Sync] Unrecognisable partner_api_app_id', {
                    partner_app_id: String(partnerApp._id),
                    partner_api_app_id: partnerApp.partner_api_app_id
                });
                return resolve(promiseReturnResult(false, {}, {}, PARTNER_APP_GID_HELP_MESSAGE));
            }

            // Annotated `string`, not left to inference: the constant's type is the literal 'AUTO',
            // and a payload-supplied mode could not be assigned to it.
            let _requestedMode: string = PARTNER_SYNC_MODES.AUTO;
            if (mode && _partnerSyncModeValues.includes(mode)) {
                _requestedMode = mode;
            }
            const { since_iso, resolved_mode } = _resolveSince({ partnerApp, mode: _requestedMode, lookback_days });

            customConsoleLog('INFO: [Partner:Sync] Starting sync', {
                partner_app_id: String(partnerApp._id),
                partner_app_gid: _partnerAppGid,
                requested_mode: _requestedMode,
                resolved_mode,
                since: since_iso,
                last_synced_at: partnerApp.last_synced_at,
                lifetime_sync_completed_at: partnerApp.lifetime_sync_completed_at
            });

            // Concurrent on purpose — they are independent connections, and the client's token
            // bucket paces BOTH of them process-wide, which is exactly why a per-page sleep inside
            // each paginator would not have been enough.
            const [eventsResp, txnsResp] = await Promise.all([
                _syncEvents({ user_id }, { partnerApp, partner_app_gid: _partnerAppGid, since_iso }),
                _syncTransactions({ user_id }, { partnerApp, partner_app_gid: _partnerAppGid, since_iso })
            ]);

            const _summary: PartnerSyncSummary = {
                partner_app_id: String(partnerApp._id),
                mode: resolved_mode,
                since: since_iso,
                events: eventsResp.data,
                transactions: txnsResp.data,
                events_ok: !!eventsResp.status,
                transactions_ok: !!txnsResp.status,
                coverage: null
            };

            // Partial failure: report what succeeded, but do NOT stamp anything. `_resolveSince`
            // reads these watermarks to choose the next window, so writing them after a failed pull
            // would permanently skip the backfill this run did not do.
            if (!_summary.events_ok || !_summary.transactions_ok) {
                const _failMsg = [
                    !_summary.events_ok && eventsResp.msg,
                    !_summary.transactions_ok && txnsResp.msg
                ].filter(Boolean).join(' | ');
                return resolve(promiseReturnResult(false, _summary, {}, _failMsg || 'Partner sync partially failed.'));
            }

            // Coverage is measured from the COLLECTIONS, not from this run's counters. A run that
            // fetched nothing because there was nothing new still has to re-measure: the gates
            // describe the whole record, and the previous run's numbers are only correct until a
            // single row changes.
            let _coverage: CoverageRecord;
            try {
                const _coverageInputs = await partnerCoverageRepository.collectCoverageInputs({ partner_app_id: partnerApp._id });
                _coverage = computeCoverage(_coverageInputs);
            } catch (coverageError) {
                customConsoleError('ERROR: [Partner:Sync] Coverage measurement failed — watermark NOT advanced', {
                    partner_app_id: String(partnerApp._id),
                    error: coverageError
                });
                return resolve(promiseReturnResult(false, _summary, coverageError, 'Partner data was synced, but its coverage could not be measured, so the sync watermark was not advanced. The rows are written; re-run the sync.'));
            }
            _summary.coverage = _coverage;

            await partnerAppRepository.recordSuccessfulSync({
                partner_app_id: String(partnerApp._id),
                synced_at: new Date(),
                lifetime_completed: resolved_mode === PARTNER_SYNC_MODES.LIFETIME,
                coverage: _coverage
            });

            customConsoleLog('INFO: [Partner:Sync] Sync complete', {
                partner_app_id: String(partnerApp._id),
                mode: resolved_mode,
                events: _summary.events,
                transactions: _summary.transactions,
                coverage: _coverage
            });

            return resolve(promiseReturnResult(true, _summary, {}, 'Partner sync completed.'));
        } catch (error) {
            customConsoleError('ERROR: [Partner:Sync] runFullSync threw', error);
            return resolve(promiseReturnResult(false, {}, error, 'Partner sync failed.'));
        }
    });
};

export = {
    runFullSync
};
