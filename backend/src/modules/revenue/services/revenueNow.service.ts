'use strict';

/**
 * ============================================================================
 *  REVENUE, AS OF RIGHT NOW
 * ============================================================================
 *
 *  The snapshot answer to "what is this app earning today, and how much of that
 *  do we actually know". Deliberately thin: every figure it publishes is either
 *  read straight out of the settled-payout ledger through
 *  `repositories/revenue.repository`, or computed by `helpers/ledgerMrr.helper`,
 *  which is the canonical definition of who is paying us. Nothing is
 *  reconstructed here, so this service cannot disagree with any other view
 *  built on the same ledger.
 *
 *  ── TWO KINDS OF MONEY, KEPT APART ──────────────────────────────────────────
 *  RUN-RATE (`mrr`, `active_subs`, `arpu`) is a point-in-time rate: what the
 *  live subscriber base bills per month. CASH (`lifetime_*`) is money Shopify
 *  actually settled, all time. They are not two spellings of one number and
 *  they are not expected to track: cash is lumpy — annual prepayments, refunds,
 *  payout timing — where a run-rate is smooth. Merging them makes both wrong,
 *  so they sit in separate blocks with separate labels.
 *
 *  ── WHY EVERYTHING IS AN ENVELOPE ───────────────────────────────────────────
 *   On an empty database EVERY figure here is `unknown` with a reason, never
 *  `0`. An app whose ledger has never been synced has no revenue ANSWER; a `0`
 *  would claim the business earned nothing, which is a statement about the
 *  world rather than about our records, and it is indistinguishable from the
 *  real thing on a chart. Three gates keep those cases apart:
 *
 *    - no settled payouts at all        → every figure unknown;
 *    - payouts exist, none is a
 *      subscription charge              → the CASH block is measured, the
 *                                         run-rate block is unknown;
 *    - subscription charges exist,
 *      none is live right now           → `mrr` and `active_subs` are a
 *                                         MEASURED zero. That is a real answer
 *                                         about the business, and it must not
 *                                         be downgraded to unknown either.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
// Every module below publishes its surface with `export =`, so a NAMED import is rejected (TS2497)
// and `import … = require(…)` is the commonjs form that keeps the types — a plain
// `const { … } = require(…)` would silently degrade all of them to `any`.
import confidenceHelper = require('../../shared/helpers/confidence.helper');
import revenueRepository = require('../repositories/revenue.repository');
import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type { Envelope } from '../../shared/types/confidence.types';
import type {
    GetRevenueNowInput,
    RevenueCoverage,
    RevenueNowData,
    RevenueTopShopRow
} from '../types/revenueNow.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { measured, derived, estimated, unknown } = confidenceHelper;
const { findPartnerAppById, getLifetimeCashTotals, getTopShopsByLifetimeNet } = revenueRepository;
const { fetchCurrentPayingShops } = revenueRepository;

/** Named for the reader, not for the file it came from — this is what appears on the dashboard. */
const SOURCE_PAYOUTS = 'settled payouts';
/** The coverage gates are written by the sync, not by the ledger. Different provenance, said so. */
const SOURCE_SYNC = 'sync watermarks';

const TOP_SHOPS_LIMIT = 50;
/**
 * Stated on the payload because a ranking sitting next to as-of figures is exactly the sort of row
 * a reader assumes shares their window. It does not: it is all-time cash.
 */
const TOP_SHOPS_BASIS = 'lifetime net cash, all time — NOT windowed';

/**
 * Wraps one coverage gate.
 *
 *  All seven gates default to `null` in the schema, and that `null` means NOT YET MEASURED — so it
 * becomes an `unknown` with a reason rather than a zero. The inversion matters most on
 * `event_history_gap_days`, where `0` is the most REASSURING value the field can take ("no gap
 * wider than a day"): publishing an unmeasured gate as `0` would tell a reader their history is
 * perfect precisely when nothing has ever checked it.
 *
 * A genuine `0` passes through as `measured`, because `measured` refuses only missing values, never
 * falsy ones.
 *
 * @param value - The stored gate value, or null/undefined when no sync has written it.
 * @param reason - What is missing, in the reader's language. Shown in place of the value.
 * @returns A `measured` envelope, or an `unknown` one carrying the reason.
 */
const _coverageFigure = <T>(value: T | null | undefined, reason: string): Envelope<T> => {
    if (value === null || value === undefined) {
        return unknown<T>(reason, SOURCE_SYNC);
    }
    return measured<T>(value, SOURCE_SYNC);
};

/**
 * The current revenue snapshot for one Shopify app: run-rate, all-time cash, the top-earning shops,
 * and the coverage gates that say how much of it is trustworthy.
 *
 * Reads the settled-payout ledger three ways in parallel — an all-time rollup, a per-shop ranking,
 * and the as-of live set from `ledgerMrr.helper` — then wraps every figure in a confidence
 * envelope. Nothing is published as a bare number, and nothing that cannot be computed is published
 * as `0`.
 *
 * Resolves `status: false` only when the CALL failed: no operator, no app id, an app that does not
 * exist, or a query that threw. A successful call over an empty database resolves `status: true`
 * with every figure `unknown` — "we have no data" is an answer, not an error.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator. Background callers pass a stable sentinel.
 * @param params1 - The parameters object.
 * @param params1.partner_app_id - Mongo `_id` of the `gi_partner_app` to report on.
 * @returns A promise resolving to a `promiseReturnResult` whose `data` is a
 * `RevenueNowData` payload on success, and `{}` on failure.
 */
const getRevenueNow = (
    { user_id }: IdentityObject,
    { partner_app_id }: GetRevenueNowInput
): Promise<ServiceResult<RevenueNowData>> => {
    return new Promise(async (resolve) => {
        try {
            // The explicit `<any>` on every failure return is deliberate: on failure there is no
            // payload, and `promiseReturnResult(false, {}, …)` would otherwise infer
            // `ServiceResult<{}>`, which does not satisfy this function's declared payload type.
            // Saying `any` once per failure beats fabricating an empty `RevenueNowData` that a
            // caller ignoring `status` would read as a real, all-zero snapshot.
            if (!user_id) {
                return resolve(promiseReturnResult<any>(false, {}, {}, 'User ID not available.'));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult<any>(false, {}, {}, 'partner_app_id is required.'));
            }

            const app = await findPartnerAppById({ partner_app_id });
            if (!app) {
                return resolve(promiseReturnResult<any>(false, {}, {}, 'Partner app not found.'));
            }

            const now = new Date();
            const windowDays = config.REVENUE.ACTIVE_SUB_WINDOW_DAYS;

            // Three independent reads, so they go together.
            const [lifetime, topShopRows, payingShops] = await Promise.all([
                getLifetimeCashTotals({ partner_app_id: app._id }),
                getTopShopsByLifetimeNet({ partner_app_id: app._id, limit: TOP_SHOPS_LIMIT }),
                fetchCurrentPayingShops({ partner_app_id: app._id, windowDays, now })
            ]);

            const NO_LEDGER = 'no settled payouts have been synced for this app yet';

            // ── Cash, all time ──────────────────────────────────────────────
            // A null `lifetime` is the repository's authoritative "this ledger is empty" signal —
            // `$group` emits no document when nothing matched. Every figure starts as an unknown
            // and each block below upgrades only what it can actually support.
            let lifetime_gross = unknown<number>(NO_LEDGER, SOURCE_PAYOUTS);
            let lifetime_net = unknown<number>(NO_LEDGER, SOURCE_PAYOUTS);
            let lifetime_shopify_fee = unknown<number>(NO_LEDGER, SOURCE_PAYOUTS);
            let transaction_count = unknown<number>(NO_LEDGER, SOURCE_PAYOUTS);
            if (lifetime) {
                lifetime_gross = measured(lifetime.total_gross, SOURCE_PAYOUTS);
                lifetime_net = measured(lifetime.total_net, SOURCE_PAYOUTS);
                lifetime_shopify_fee = measured(lifetime.total_fee, SOURCE_PAYOUTS);
                transaction_count = measured(lifetime.tx_count, SOURCE_PAYOUTS);
            }

            // ── Run-rate, as of now ─────────────────────────────────────────
            let mrr = unknown<number>(NO_LEDGER, SOURCE_PAYOUTS);
            let active_subs = unknown<number>(NO_LEDGER, SOURCE_PAYOUTS);
            let arpu = unknown<number>(NO_LEDGER, SOURCE_PAYOUTS);
            let billing_interval_unknown_shops = unknown<number>(NO_LEDGER, SOURCE_PAYOUTS);
            let currencies = unknown<string[]>(NO_LEDGER, SOURCE_PAYOUTS);

            // A ledger with payouts but no subscription charge cannot answer a question about
            // recurring revenue at all — a `0` there would report "this app has no subscribers"
            // when the truth is "we have never synced a subscription charge". Distinct from the
            // branch below, where the charges exist and the answer genuinely is zero.
            if (lifetime && lifetime.subscription_tx_count === 0) {
                const noSubscriptions = `the ledger holds ${lifetime.tx_count} settled payouts, none of which is a `
                    + 'subscription charge, so there is no recurring revenue to measure';
                mrr = unknown<number>(noSubscriptions, SOURCE_PAYOUTS);
                active_subs = unknown<number>(noSubscriptions, SOURCE_PAYOUTS);
                arpu = unknown<number>(noSubscriptions, SOURCE_PAYOUTS);
                billing_interval_unknown_shops = unknown<number>(noSubscriptions, SOURCE_PAYOUTS);
                currencies = unknown<string[]>(noSubscriptions, SOURCE_PAYOUTS);
            }

            if (lifetime && lifetime.subscription_tx_count > 0) {
                const monthlyTotal = payingShops.reduce((sum, shop) => sum + shop.monthly_amount, 0);
                //  THE ANNUAL CAVEAT, MADE MEASURABLE. `normalizeToMonthly` divides by 12 only
                // when `billing_interval` reads exactly 'ANNUAL'; a null interval is treated as
                // monthly, which is right for a genuine monthly plan and twelvefold wrong for an
                // annual subscriber on a row synced before the field was captured. Counting those
                // rows turns "annual subscribers may be overstated" from a footnote nobody can act
                // on into a number a reader can check against their own plan mix.
                const unknownIntervalShops = payingShops.filter((shop) => !shop.billing_interval).length;
                const currencyCodes = [...new Set(payingShops.map((shop) => shop.currency).filter((code) => Boolean(code)))].sort();

                active_subs = measured(payingShops.length, SOURCE_PAYOUTS);
                billing_interval_unknown_shops = measured(unknownIntervalShops, SOURCE_PAYOUTS);
                currencies = measured(currencyCodes, SOURCE_PAYOUTS);

                // Each caveat states a DIRECTION. "Approximate" on its own tells a reader nothing
                // they can act on; "reads high, by up to eleven twelfths of each annual charge"
                // does.
                const mrrCaveats: string[] = [];
                if (unknownIntervalShops > 0) {
                    mrrCaveats.push(`${unknownIntervalShops} of ${payingShops.length} live shops carry no billing_interval; `
                        + 'any annual subscriber among them is booked at 12x its true monthly run-rate, so this reads HIGH');
                }
                if (currencyCodes.length > 1) {
                    mrrCaveats.push(`live charges span ${currencyCodes.length} currencies (${currencyCodes.join(', ')}) `
                        + 'and nothing here converts between them, so this is a sum of unlike units');
                }

                // MEASURED only while nothing known distorts it. The downgrade is not cosmetic: a
                // `measured` envelope has no `caveat` slot at all, so leaving it measured would mean
                // the caveat could not travel with the number and would have to live in a sibling
                // field that a renderer is free to ignore.
                mrr = measured(monthlyTotal, SOURCE_PAYOUTS);
                if (mrrCaveats.length > 0) {
                    mrr = estimated(monthlyTotal, SOURCE_PAYOUTS, mrrCaveats.join('; '));
                }

                // An empty live set is a real, measured zero for MRR — but ARPU then has no
                // denominator, and `monthlyTotal / 0` is `NaN` (or `Infinity`), which is typed
                // `number`, passes every guard upstream, and renders as the word "NaN" on a
                // dashboard. Stated as an unknown with its own reason rather than left to the
                // helper's generic downgrade, which would say only "could not derive".
                arpu = unknown<number>('no shop is currently paying, so there is nothing to average over', SOURCE_PAYOUTS);
                if (payingShops.length > 0) {
                    arpu = derived(monthlyTotal / payingShops.length, SOURCE_PAYOUTS, 'mrr / active_subs');
                }
            }

            // ── Top shops ───────────────────────────────────────────────────
            let top_shops = unknown<RevenueTopShopRow[]>(NO_LEDGER, SOURCE_PAYOUTS);
            if (lifetime && topShopRows.length === 0) {
                top_shops = unknown<RevenueTopShopRow[]>(
                    'the ledger holds payouts but none of them names a shop, so there is nothing to rank',
                    SOURCE_PAYOUTS
                );
            }
            if (topShopRows.length > 0) {
                top_shops = measured(topShopRows, SOURCE_PAYOUTS);
            }

            // ── Coverage ────────────────────────────────────────────────────
            // Published alongside the figures rather than kept as an internal diagnostic: every
            // number above is only as complete as these gates say the underlying records are, and a
            // reader cannot weigh a total without knowing whether the history behind it was ever
            // fully backfilled.
            const coverage: RevenueCoverage = {
                last_synced_at: _coverageFigure<Date>(
                    app.last_synced_at,
                    'no partner sync has completed yet, so nothing here has been refreshed'
                ),
                earliest_event_at: _coverageFigure<Date>(
                    app.earliest_event_at,
                    'no sync has recorded how far the event history reaches back'
                ),
                // Not a money gate, and published here for the same reason `event_history_gap_days`
                // is: this block IS the app's coverage record, and `/api/meta/coverage` is a trim of
                // it — so a gate omitted here is a gate no operator can see. It qualifies the STORE
                // NAME on every store-keyed row: above this date the names are real, below it the
                // rows carry their domain, and that is a sync boundary a LIFETIME re-sync closes,
                // not a column that lost its data. Compare it against `earliest_event_at` — equal
                // means there is nothing left to warn about.
                shop_name_coverage_since: _coverageFigure<Date>(
                    app.shop_name_coverage_since,
                    'no event we hold carries a store name — either nothing has synced yet, or no sync has run since store names were added to the partner query'
                ),
                earliest_transaction_at: _coverageFigure<Date>(
                    app.earliest_transaction_at,
                    'no sync has recorded how far the payout ledger reaches back, so the floor of every money figure here is unknown'
                ),
                lifetime_sync_completed_at: _coverageFigure<Date>(
                    app.lifetime_sync_completed_at,
                    'no lifetime sync has ever completed, so every all-time figure here is a FLOOR rather than a total'
                ),
                event_history_gap_days: _coverageFigure<number>(
                    app.event_history_gap_days,
                    'never measured — no sync has computed the widest gap in the event history'
                ),
                charge_link_absent_pct: _coverageFigure<number>(
                    app.charge_link_absent_pct,
                    'never measured — no sync has computed how many rows carry no charge id'
                ),
                charge_link_unresolved_pct: _coverageFigure<number>(
                    app.charge_link_unresolved_pct,
                    'never measured — no sync has computed how many charge ids resolve to nothing'
                )
            };

            const data: RevenueNowData = {
                partner_app_id: String(app._id),
                app_handle: app.app_handle,
                display_name: app.display_name,
                reporting_currency: config.REVENUE.REPORTING_CURRENCY,
                as_of: now,
                active_sub_window_days: windowDays,
                mrr,
                active_subs,
                arpu,
                billing_interval_unknown_shops,
                currencies,
                lifetime_gross,
                lifetime_net,
                lifetime_shopify_fee,
                transaction_count,
                top_shops,
                top_shops_basis: TOP_SHOPS_BASIS,
                coverage
            };

            return resolve(promiseReturnResult<RevenueNowData>(true, data, {}, 'Revenue snapshot computed.'));
        } catch (error) {
            customConsoleError('ERROR: revenue revenueNow getRevenueNow', error);
            return resolve(promiseReturnResult<any>(false, {}, error, 'Could not compute the revenue snapshot. Please try again.'));
        }
    });
};

export = {
    getRevenueNow
};
