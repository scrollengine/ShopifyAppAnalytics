'use strict';

/**
 * ============================================================================
 *  WHAT PLAN IS EACH OF THESE STORES ON?
 * ============================================================================
 *
 *  Serves `POST /api/revenue/shop-plans` — a batch lookup the Revenue page fires as a SECOND call
 *  after its main payload lands, so the top-shops table can show a live plan without the main read
 *  waiting on it.
 *
 *  ── WHERE THE ANSWER COMES FROM, AND WHY IT IS NOT WHERE IT USED TO ─────────────────────────
 *
 *  The dashboard this page came from read `store_details` — a vendor-owned collection of merchant
 *  stores kept fresh from the Shopify Admin API. A self-hosted install has no such collection and no
 *  Admin credential for anybody else's store; the ONLY source here is the Partner API. So the plan
 *  is served from `raw_event.charge.name` on the subscription charge events, folded through the
 *  CANONICAL charge cohort — the same fold that names plans on the funnel, the churn pages and the
 *  store roster, reached rather than re-implemented.
 *
 *  ──  EVERY REQUESTED DOMAIN GETS AN ENTRY, INCLUDING THE MISSES ───────────────────────────
 *
 *  A domain with no subscription on record comes back with `resolved: false` and a reason rather
 *  than being dropped. To a caller doing a map lookup, an omitted key and a key it never sent look
 *  identical, so a silent miss cannot be told from a domain the endpoint declined to answer about —
 *  and the caller has no way to know whether to re-sync, to retry, or to stop asking.
 *
 *  ──  THE ONE FIELD THIS ENDPOINT CANNOT MEASURE ───────────────────────────────────────────
 *
 *  `store_active` came from `store_details` and means "the app is still on this store". Nothing here
 *  measures that: install state is the four-relationship-event fold that `modules/store` owns and
 *  deliberately does not publish. The consumer renders a critical "Uninstalled" badge whenever the
 *  field is FALSY — including when it is absent — so the only value that makes NO claim is `true`,
 *  and `store_active_measured: false` carries the truth beside it. See the type's own note.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import shopDomainHelper = require('../../shared/helpers/shopDomain.helper');
//  DEEP PATH, NOT `modules/conversion`'s BARREL — the same deliberate exception, for the same
// reason, that `repositories/revenue.repository` and `services/revenueOverview.service` document:
// a barrel import from inside `modules/revenue` closes a cycle back through `logoChurn.service` and
// leaves ITS ledger imports `undefined` at load. The resolver is pure and has no edge back here, and
// the reuse the barrel exists to enforce is fully preserved — this is still the one charge-cohort
// fold, not a second one.
import chargeCohortResolver = require('../../conversion/resolvers/chargeCohort.resolver');
import revenueOverviewConstants = require('../constants/revenueOverview.constants');
import asOfMrrHelper = require('../helpers/asOfMrr.helper');
import revenueRepository = require('../repositories/revenue.repository');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { CohortSubscription } from '../../conversion/types/lifecycle.types';
import type { PayingShop } from '../types/ledgerMrr.types';
import type { PartnerAppRecord } from '../types/revenueNow.types';
import type { GetShopPlansParams, ShopPlanRow, ShopPlansData } from '../types/shopPlans.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { normaliseShopDomain } = shopDomainHelper;
const { resolveChargeCohortForDomains } = chargeCohortResolver;
const { MAX_SHOP_PLAN_DOMAINS } = revenueOverviewConstants;
const { mrrAsOf, byDomain } = asOfMrrHelper;
const {
    findPartnerAppById,
    fetchSubscriptionChargeHistory,
    findRevenueChargeEvents,
    aggregateSettledSubscriptionEvidence
} = revenueRepository;

/** `READY` | `NEVER_SYNCED`, decided by the WATERMARK. Never by a row count. */
const SHOP_PLAN_DATA_STATES = Object.freeze({
    READY: 'READY',
    NEVER_SYNCED: 'NEVER_SYNCED'
} as const);

/**
 * ⚠️ EVERY STRING UNIQUE — a consumer keying warnings by content drops a duplicate and its condition.
 */
const _WARNINGS = Object.freeze({
    neverSynced: 'No Partner sync has completed for this app yet, so no subscription charge events have '
        + 'been fetched and no store can be matched to a plan. Every domain is answered with a stated '
        + 'reason rather than left out.',

    noDomains: 'No shop domains were sent, so there was nothing to look up. Send `shop_domains` as an '
        + 'array, or as a comma-joined string.',

    clamped: (sent: number, applied: number): string => `${sent} shop domains were sent and the first `
        + `${applied} were resolved. Ask for at most ${MAX_SHOP_PLAN_DOMAINS} per call — the rest are not `
        + 'in this response at all, so a caller must not read their absence as "no plan".',

    dropped: (count: number): string => `${count} entry(ies) in the list were blank or unusable as a shop `
        + 'domain and were skipped. They have no entry in `plans`, so their absence is not an answer.',

    installStateNotMeasured: 'Whether the app is still installed on these stores is NOT measured here. '
        + '`store_active` is published as `true` on every row because the consumer renders an '
        + '"Uninstalled" badge for any falsy value, and this endpoint has no evidence either way — '
        + 'install state is decided from install and uninstall events on the Stores page. '
        + '`store_active_measured` is `false` on every row to say so.'
});

/** The per-domain reason for a miss. One sentence, two conditions, so a caller can act on it. */
const _UNRESOLVED_REASON = 'No subscription charge event on record names a plan for this store. Either its '
    + 'charge events have never been synced, or it has genuinely never subscribed — the two are not '
    + 'distinguishable from what is stored, so no plan is guessed.';

/**
 * Splits the `shop_domains` parameter into the caller's own strings, in the order given.
 *
 * Accepts an ARRAY or a COMMA-JOINED STRING because both forms reach an Express handler depending on
 * how the client serialises, and a caller whose list arrived in the other shape would otherwise get a
 * silent empty answer rather than an error.
 *
 * ⚠️ The RAW strings are kept, not the normalised ones. They become the response's keys, so a caller
 * can always find its own entry — see `ShopPlansData.plans`.
 *
 * @param raw - The `shop_domains` value: an array, a string, or nothing.
 * @returns Non-empty trimmed entries, in the order given, duplicates preserved.
 */
const _splitDomains = (raw: unknown): string[] => {
    const out: string[] = [];
    const _push = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const item of value) {
                _push(item);
            }
            return;
        }
        if (value === null || value === undefined) {
            return;
        }
        for (const part of String(value).split(',')) {
            const domain = part.trim();
            if (domain !== '') {
                out.push(domain);
            }
        }
    };
    _push(raw);
    return out;
};

/**
 * The current plan for a batch of myshopify domains.
 *
 * Resolves `status: false` only when the CALL failed: no operator, no app id, an app that does not
 * exist, or a read that threw. An empty list, an app with no charge events, and a batch where nothing
 * matched are all `status: true` — an empty answer is an answer.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The parameters object, cast (not coerced) by the controller.
 * @param params1.partner_app_id - The app whose charge events are searched. Required.
 * @param [params1.shop_domains] - The domains to look up. Clamped, never refused.
 * @returns The map, or an honest refusal.
 */
const getShopPlans = (
    { user_id }: IdentityObject,
    { partner_app_id, shop_domains }: GetShopPlansParams
): Promise<ServiceResult<ShopPlansData | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'partner_app_id is required. Read it from GET /api/partner-apps.'));
            }

            const app: PartnerAppRecord | null = await findPartnerAppById({ partner_app_id });
            if (!app) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }

            // ONE clock read, threaded into both the cohort and the paying set, so a store cannot be
            // classified as of two different instants inside one response.
            const now = new Date();
            const appId = String(app._id);
            const warnings: string[] = [];

            // ── FAIL-OPEN VALIDATION ────────────────────────────────────────
            // An oversized or partly-junk list is CLAMPED and reported, never refused. The caller's
            // list is data; refusing the whole page over one blank entry answers nothing.
            const requested = _splitDomains(shop_domains);
            const applied = requested.slice(0, MAX_SHOP_PLAN_DOMAINS);
            if (requested.length > applied.length) {
                warnings.push(_WARNINGS.clamped(requested.length, applied.length));
            }
            if (applied.length === 0) {
                warnings.push(_WARNINGS.noDomains);
            }

            const _envelope = (
                plans: Record<string, ShopPlanRow>,
                resolved: number,
                unresolved: number,
                dataState: string,
                reason: string | null
            ): ShopPlansData => ({
                partner_app_id: appId,
                as_of: now.toISOString(),
                plans,
                resolved_count: resolved,
                unresolved_count: unresolved,
                warnings: [...new Set(reason ? [reason, ...warnings] : warnings)],
                data_state: dataState,
                unknown_reason: reason
            });

            /**
             * A row that answers a domain with a REASON rather than with an absence.
             *
             *  USED BY THE COLD PATH, AND THAT IS THE POINT. Returning `plans: {}` when nothing has
             * synced makes a never-synced app indistinguishable from one where every store genuinely
             * has no plan: the consumer's `shopPlanMap[domain] || null` falls back silently in both
             * cases and nobody learns a sync is missing. The rule this file opens with — every
             * requested domain gets an entry — has no exception for the cold path; the cold path is
             * where it matters most.
             *
             * @param domain - The canonical domain, or `''` when the needle was unusable.
             * @param reason - Why there is no plan, in the reader's language.
             * @returns A fully-formed row carrying no plan and no claim.
             */
            const _unansweredRow = (domain: string, reason: string): ShopPlanRow => ({
                shop_domain: domain,
                plan_title: null,
                plan_price: null,
                currency: '',
                subscription_state: null,
                //  `false` is honest here and only here: with no sync there is no ledger to have
                // read, so this is "we hold no settled payout for you", not "you are not paying".
                // `unknown_reason` on the same row is what keeps the two apart.
                is_paying_now: false,
                is_test: false,
                //  Still `true` — see the type's note. The consumer badges any falsy value
                // "Uninstalled", and a cold start is the last moment to start claiming uninstalls.
                store_active: true,
                store_active_measured: false,
                resolved: false,
                unknown_reason: reason
            });

            // ── THE WATERMARK, NEVER THE ROW COUNT ───────────────────────────
            if (!app.last_synced_at) {
                //  NULL-PROTOTYPE, like `plans` below and for the same reason — see that note.
                const cold: Record<string, ShopPlanRow> = Object.create(null);
                for (const raw of applied) {
                    if (!Object.hasOwn(cold, raw)) {
                        cold[raw] = _unansweredRow(normaliseShopDomain(raw), _WARNINGS.neverSynced);
                    }
                }
                return resolve(promiseReturnResult(
                    true,
                    _envelope(cold, 0, Object.keys(cold).length, SHOP_PLAN_DATA_STATES.NEVER_SYNCED, _WARNINGS.neverSynced),
                    {},
                    'Shop plans resolved.'
                ));
            }
            if (applied.length === 0) {
                //  READY, not NEVER_SYNCED. The app has synced; the CALLER sent nothing. Reporting a
                // sync state from the shape of a request would aim an operator at their environment
                // file over their own empty array.
                return resolve(promiseReturnResult(true, _envelope({}, 0, 0, SHOP_PLAN_DATA_STATES.READY, null), {}, 'Shop plans resolved.'));
            }

            // ── The reads ────────────────────────────────────────────────────
            // Bounded at the SAME instant, which is the invariant `subscriptionCohort.resolver`'s
            // header states: unbounded settled-payout evidence would let a future payout prove a past
            // conversion. The event pull carries NO lower bound — a store may have subscribed at any
            // point before today, and cutting the scan reports a paying customer as never having
            // subscribed.
            const [chargeEvents, settled, history] = await Promise.all([
                findRevenueChargeEvents({ partner_app_id: appId, as_of: now }),
                aggregateSettledSubscriptionEvidence({ partner_app_id: appId, as_of: now }),
                fetchSubscriptionChargeHistory({ partner_app_id: appId })
            ]);

            const cohort = resolveChargeCohortForDomains({
                events: chargeEvents,
                as_of: now,
                settled_charge_ids: settled.charge_ids,
                settled_domains: settled.shop_domains
            });

            //  THE CANONICAL PAYING PREDICATE, not a second one. `is_paying_now` on these rows and
            // `is_active_now` on the Revenue page's own ranking are the SAME measurement, so a store
            // cannot read as paying in one and not in the other.
            const payingNow: Map<string, PayingShop> = byDomain(
                mrrAsOf({ history, as_of: now, window_days: config.REVENUE.ACTIVE_SUB_WINDOW_DAYS }).live_set
            );

            // ── One entry per requested domain ───────────────────────────────
            //
            //  `Object.create(null)`, NOT `{}`, AND THAT IS THE INVARIANT THIS FILE OPENS WITH.
            // The caller's raw string is used as the key, and on a plain object three of those strings
            // are not keys at all: `plans['__proto__'] = row` invokes the inherited setter instead of
            // creating an own property (`Object.keys` stays empty, `JSON.stringify` emits `{}`), and
            // `constructor` / `prototype` collide with inherited members. The domain would then be
            // counted in `unresolved_count` and be ABSENT from `plans` — exactly the "an omitted key
            // cannot be told apart from a domain nobody asked about" failure the header forbids. A
            // prototype-less map has no inherited names to collide with, so every requested string is
            // an ordinary own key.
            const plans: Record<string, ShopPlanRow> = Object.create(null);
            let resolvedCount = 0;
            let unresolvedCount = 0;
            let dropped = 0;

            for (const raw of applied) {
                // The NEEDLE is normalised; the stored `shop_domain` is already canonical on write and
                // must not be re-normalised. Normalising a caller-supplied value is free and
                // idempotent, and is what stops a hand-typed domain from silently matching nothing.
                const domain = normaliseShopDomain(raw);
                if (domain === '') {
                    // ⚠️ NO ENTRY, and counted. A key whose value says "this is not a domain" invites a
                    // caller to render it as a store; leaving it out with a warning says the same thing
                    // without putting a row on a screen.
                    dropped += 1;
                    continue;
                }
                if (Object.hasOwn(plans, raw)) {
                    // A duplicate in the caller's own list. Answered once; the second lookup finds the
                    // same entry, which is what a map lookup expects.
                    continue;
                }

                const subscription: CohortSubscription | undefined = cohort.by_domain.get(domain);
                const paying = payingNow.get(domain);

                if (!subscription) {
                    unresolvedCount += 1;
                    plans[raw] = {
                        shop_domain: domain,
                        plan_title: null,
                        plan_price: null,
                        currency: '',
                        subscription_state: null,
                        // Still measured, and still worth publishing: the ledger can say a store is
                        // paying even when no charge EVENT for it was ever synced.
                        is_paying_now: Boolean(paying),
                        is_test: false,
                        store_active: true,
                        store_active_measured: false,
                        resolved: false,
                        unknown_reason: _UNRESOLVED_REASON
                    };
                    continue;
                }

                resolvedCount += 1;
                plans[raw] = {
                    shop_domain: domain,
                    // `''` on the cohort row means the charge payload named no plan. Published as
                    // `null` rather than an empty string, so a renderer's truthiness test and this
                    // field's meaning agree.
                    plan_title: subscription.plan_name !== '' ? subscription.plan_name : null,
                    plan_price: subscription.plan_price,
                    currency: subscription.currency,
                    subscription_state: subscription.state,
                    is_paying_now: Boolean(paying),
                    //  A MEASUREMENT, not a default: the cohort drops `charge.test === true` before
                    // folding, so a resolved subscription is non-test by construction.
                    is_test: false,
                    //  NOT A MEASUREMENT — see the type's own note. `true` is the only value that
                    // makes no claim, because the consumer badges any falsy value as "Uninstalled".
                    store_active: true,
                    store_active_measured: false,
                    resolved: true,
                    unknown_reason: null
                };
            }

            if (dropped > 0) {
                warnings.push(_WARNINGS.dropped(dropped));
            }
            warnings.push(_WARNINGS.installStateNotMeasured);

            const data: ShopPlansData = {
                partner_app_id: appId,
                as_of: now.toISOString(),
                plans,
                resolved_count: resolvedCount,
                unresolved_count: unresolvedCount,
                warnings: [...new Set(warnings)],
                data_state: SHOP_PLAN_DATA_STATES.READY,
                unknown_reason: null
            };

            return resolve(promiseReturnResult(true, data, {}, 'Shop plans resolved.'));
        } catch (error) {
            customConsoleError('ERROR: revenue shopPlans getShopPlans', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not resolve shop plans. Please try again.'));
        }
    });
};

export = {
    getShopPlans,
    SHOP_PLAN_DATA_STATES
};
