'use strict';

/**
 * ============================================================================
 *  TIME TO PAID — HOW LONG A STORE TAKES TO START PAYING
 * ============================================================================
 *
 *  Serves `GET /api/conversion/time-to-paid` — the histogram and the percentile strip on the
 *  Conversion analysis tab.
 *
 *  ──  A STORE THAT HAS NOT CONVERTED IS NOT IN THIS HISTOGRAM AT ALL ──────────────────────
 *
 *  It has NO time-to-paid. Both of the tempting places to put it are fabrications, and both of them
 *  are one line of code away:
 *
 *    - bucketed at day 0 it joins "Same day", the bar an operator reads as their best outcome. On a
 *      young app that bar would be the tallest on the chart and made entirely of failures;
 *    - bucketed in the open-ended tail it claims the merchant converted eventually and slowly, which
 *      drags the median and the p75 that the strip beneath prints as measurements.
 *
 *  So the histogram partitions CONVERTED stores and nothing else, and every exclusion is counted and
 *  named. `TimeToPaidHistogram.js:21` captions the chart with `total_paid_shops` and `:47` divides
 *  every bar by it, so that figure IS the population — it must never quietly include a store the
 *  chart cannot place.
 *
 *  ──  AND ONE OF THE THREE EXCLUSIONS IS A COVERAGE GAP, NOT A FUNNEL FACT ────────────────
 *
 *  `converted_without_billing_date` is a store that DID reach paid billing — on settled-payout
 *  evidence — for which Shopify supplied no `charge.billingOn`, so there is no date to measure to.
 *  Those are real conversions missing from the chart, which makes `total_paid_shops` a FLOOR rather
 *  than a total. Folded into a single "excluded" count it would be invisible inside the ordinary
 *  "did not convert" number; it is published on its own and warned about separately.
 *
 *  ── CONVERSION IS A DATE COMPARISON, DECIDED UPSTREAM ──────────────────────────────────────
 *
 *  Nothing here re-decides whether a store converted. `resolvers/chargeCohort.resolver` has already
 *  classified every subscription as of the judgement instant, and this file reads that state — PAYING
 *  or CHURNED_AFTER_TRIAL, both of which reached paid billing. A store that paid and later cancelled
 *  still converted, and still took however many days it took; excluding it would move the median by
 *  the churn rate.
 *
 *  ⚠️ `conversion_date` is `charge.billingOn` — the date billing was SCHEDULED to begin. Requiring
 *  the STATE to agree is what stops a merchant who cancelled three days before their billing date
 *  from being counted as a conversion; `helpers/trialCohort.helper` makes the same pairing for the
 *  same reason and its header carries the arithmetic.
 *
 *  ── The discriminator is the WATERMARK, never the row count ────────────────────────────────
 *
 *  No conversions plus `last_synced_at` is a real, publishable "nobody converted in this window" and
 *  the component has its own sentence for it. No conversions and no watermark is "we have not looked".
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import dateRangeHelper = require('../../shared/helpers/dateRange.helper');
import lifecycleConstants = require('../constants/lifecycle.constants');
import timeToPaidConstants = require('../constants/timeToPaid.constants');
import monthBucketHelper = require('../helpers/monthBucket.helper');
import timeToPaidHelper = require('../helpers/timeToPaid.helper');
import chargeCohortResolver = require('../resolvers/chargeCohort.resolver');
import installCohortRepository = require('../repositories/installCohort.repository');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { ResolvedDateRange } from '../../shared/types/dateRange.types';
import type {
    TimeToPaidDiagnostics,
    TimeToPaidExclusions,
    TimeToPaidParams,
    TimeToPaidResponse
} from '../types/timeToPaid.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { resolveDateRange } = dateRangeHelper;
// ⚠️ ALWAYS A NUMBER, floored at zero — see that helper's header. The negative case is caught and
// COUNTED before it ever reaches here, because a clamped `0` would put a re-installer in "Same day".
const { wholeDaysBetween } = monthBucketHelper;
const { foldTimeToPaid } = timeToPaidHelper;
const { resolveChargeCohortForDomains } = chargeCohortResolver;
// REUSED, NOT RE-DECLARED. These are the same four reads the install cohort issues for the table on
// the same page — same spine, same domain-scoped event pull with NO lower bound, same `as_of`-bounded
// settled evidence. A second copy of any of them would be a second place for a `$gte` to appear.
const {
    findPartnerAppById,
    aggregateInstallSpine,
    findChargeCohortEvents,
    aggregateSettledSubscriptionCharges
} = installCohortRepository;
const { SUBSCRIPTION_STATES, STATE_BASIS } = lifecycleConstants;
const { TIME_TO_PAID_DATA_STATES } = timeToPaidConstants;

/**
 * ⚠️ THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * The page renders one entry per warning KEYED BY THE STRING ITSELF, so a duplicate is not drawn
 * twice — it is DROPPED, silently, along with its condition.
 */
const _WARNINGS = Object.freeze({
    neverSynced: 'No Partner sync has completed for this app yet, so no install or subscription events have '
        + 'been fetched. The histogram is withheld rather than drawn empty — we have not looked, which is '
        + 'not the same as nobody having converted.',

    notConverted: (shops: number, installed: number): string => `${shops} of the ${installed} stores that `
        + 'installed in this window have not reached paid billing, so they are EXCLUDED from the histogram '
        + 'rather than placed in a bucket. They are not "day 0" — putting them in the first bar would make '
        + 'it the tallest on the chart and fill it with merchants who never paid — and they are not the last '
        + 'bar either, which would claim they converted slowly. Some of them still might: a store that '
        + 'installed yesterday has not failed to convert, it simply has not converted yet.',

    /**
     *  THE ONE EXCLUSION THAT IS OURS RATHER THAN THE MERCHANT'S, and the reason it is counted
     * separately: it makes the headline a FLOOR, which is the opposite of what an exclusion usually
     * means on this page.
     */
    convertedWithoutDate: (shops: number): string => `${shops} store(s) DID reach paid billing but carry no `
        + 'billing date from Shopify, so there is no date to measure to and they are missing from the '
        + 'histogram. "Shops converted" above is therefore a FLOOR rather than a total, and the median and '
        + 'percentiles describe only the conversions that can be dated. Their conversion was established '
        + 'from settled payouts instead, which proves that money moved but not when billing was scheduled '
        + 'to start.',

    convertedBeforeInstall: (shops: number): string => `${shops} store(s) have a billing date EARLIER than `
        + 'the install this window recorded for them, so their time-to-paid would be negative and they are '
        + 'excluded rather than clamped to zero. That normally means the store installed, subscribed, '
        + 'uninstalled and installed again — the install date here is the one inside this window, and the '
        + 'subscription predates it. Clamping them to zero would file re-installers under "Same day".',

    inferredStates: (subscriptions: number): string => `${subscriptions} subscription(s) are counted as still `
        + 'in trial on the weakest evidence available: Shopify supplied no billing date for them and no '
        + 'payout has settled against them yet. If any of those did in fact convert, they are missing from '
        + 'the histogram — so this is a second reason the figures here are floors. The alternative reading '
        + 'would claim revenue we cannot see.',

    testSubscriptionsExcluded: (subscriptions: number): string => `${subscriptions} test subscription(s) were `
        + 'excluded from the conversion side of this chart. Partner install events carry no test flag at all, '
        + 'so those stores are still counted in "stores installed" — the two halves are asymmetric and no '
        + 'available data can reconcile them.',

    shoplessInstallEvents: (events: number): string => `${events} install event(s) in this window carried no `
        + 'shop domain and could not be attached to a store. They are excluded from every count on this '
        + 'chart.',

    skippedKeylessSubscriptionEvents: (events: number): string => `${events} subscription event(s) carried `
        + 'neither a charge id nor a shop domain and were skipped rather than pooled. Pooling them would have '
        + 'invented one merged subscription out of many.',

    unbucketedDays: (shops: number): string => `${shops} store(s) produced a time-to-paid figure that none of `
        + 'the histogram\'s buckets covers, so they are counted here and drawn nowhere. That is a defect in '
        + 'this build\'s bucket list rather than a fact about your funnel — please report it.',

    lifetimeFloor: 'No lifetime Partner sync has ever completed for this app, so every figure here is a FLOOR '
        + 'rather than a total — there may be older installs and older subscriptions that have never been '
        + 'fetched.',

    beforeEarliestEvent: (earliest: string): string => 'The window starts before the earliest Partner event on '
        + `record (${earliest}). Events before that date were never fetched and cannot appear here, so both `
        + 'the install count and the conversion count for the earlier part of this window are floors.',

    eventHistoryGap: (days: number): string => 'The Partner event history for this app contains a stretch of '
        + `${days} day(s) carrying no events at all. If that stretch falls inside this window, stores that `
        + 'installed or converted during it are missing from this chart. The data cannot say whether it was a '
        + 'genuinely quiet period or a sync window that failed and was never re-pulled, which is why it is '
        + 'published here rather than resolved.'
});

/** An ISO string, or null. */
const _iso = (value?: Date | null): string | null => {
    if (!value) {
        return null;
    }
    return value.toISOString();
};

/**
 * Which coverage gates make this window's figures a floor rather than a total.
 *
 * ⚠️ THE EVENT GATES, NEVER THE MONEY ONES. `models/partner/partnerApp.model.ts:122` keeps
 * `earliest_event_at` and `earliest_transaction_at` apart so neither can borrow the other's coverage.
 * Both halves of this chart — the install spine and the subscription cohort — are built from EVENTS.
 *
 * @param app - The app row.
 * @param win - The resolved window.
 * @returns Zero or more warning strings.
 */
const _coverageWarnings = (app: PartnerAppDoc, win: ResolvedDateRange): string[] => {
    const out: string[] = [];
    if (win.isLifetime && !app.lifetime_sync_completed_at) {
        out.push(_WARNINGS.lifetimeFloor);
    }
    if (win.since && app.earliest_event_at && win.since.getTime() < app.earliest_event_at.getTime()) {
        out.push(_WARNINGS.beforeEarliestEvent(app.earliest_event_at.toISOString()));
    }
    // ⚠️ `> 0` and an explicit finite check, never truthiness: `0` is a MEASURED "no day-wide hole"
    // and `null` is "never measured". Warning on either would fire the banner on healthy data.
    const gapDays = app.event_history_gap_days;
    if (typeof gapDays === 'number' && Number.isFinite(gapDays) && gapDays > 0) {
        out.push(_WARNINGS.eventHistoryGap(gapDays));
    }
    return out;
};

/**
 * How long the stores that installed in this window took to start paying.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query, already cast (not coerced) by the controller.
 * @param params1.partner_app_id - The app to report on. Required.
 * @param [params1.period_days] - number, 0 or 'all' (default 30).
 * @param [params1.since] - ISO date; honoured only together with `until`.
 * @param [params1.until] - ISO date; honoured only together with `since`.
 * @returns The histogram, or an honest refusal carrying `{}`.
 */
const getTimeToPaid = (
    { user_id }: IdentityObject,
    { partner_app_id, period_days, since, until }: TimeToPaidParams
): Promise<ServiceResult<TimeToPaidResponse | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'partner_app_id is required. Read it from GET /api/partner-apps.'));
            }

            const app = await findPartnerAppById(String(partner_app_id));
            if (!app) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }

            const win = resolveDateRange({ period_days, since, until, defaultPeriodDays: 30 });

            // VALIDATED ONCE, HERE. `classifyAsOf` and `resolveChargeCohortForDomains` both THROW on
            // an unusable judgement instant rather than substituting `new Date()` — a pure helper may
            // not read the clock, and a substituted "now" would make a historical window answer as of
            // today without saying so.
            const asOf = win.until;
            if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
                return resolve(promiseReturnResult(false, {}, {}, 'Could not resolve a valid window for this request. Check `since`, `until` and `period_days`.'));
            }

            const appId = String(app._id);
            const warnings: string[] = [];

            let periodDays: number | 'all' | null = win.periodDays;
            if (win.isLifetime) {
                periodDays = 'all';
            }

            const _envelope = {
                app_id: appId,
                app_name: app.display_name,
                period_label: win.periodLabel,
                period_days: periodDays,
                kind: win.kind,
                since: _iso(win.since),
                until: win.until.toISOString(),
                as_of: asOf.toISOString()
            };

            const _emptyDiagnostics = (): TimeToPaidDiagnostics => ({
                installed_shops: 0,
                shopless_install_events: 0,
                skipped_keyless_subscription_events: 0,
                test_subscriptions_excluded: 0,
                unbucketed_days: 0,
                earliest_event_at: _iso(app.earliest_event_at)
            });

            // ── THE WATERMARK, NEVER THE ROW COUNT ───────────────────────────
            // The ONE condition that produces NEVER_SYNCED. Nothing below may reach for it: a synced
            // app with no conversions in this window is a real answer, and the component has its own
            // sentence for it.
            if (!app.last_synced_at) {
                return resolve(promiseReturnResult(
                    true,
                    {
                        ..._envelope,
                        // ⚠️ `null`, NOT `[]` and NOT a zeroed set. An empty ARRAY is a measured empty
                        // and draws seven honest zero-height bars; `null` routes the whole payload to
                        // the never-synced banner through `data_state` below.
                        buckets: null,
                        stats: null,
                        total_paid_shops: null,
                        total_installed_shops: null,
                        excluded: null,
                        diagnostics: _emptyDiagnostics(),
                        warnings: [...new Set([_WARNINGS.neverSynced, ...warnings])],
                        data_state: TIME_TO_PAID_DATA_STATES.NEVER_SYNCED,
                        // The banner's body. Without it `dataState.js` falls back to `resp.msg` and
                        // prints the SUCCESS message under the heading "Nothing synced yet".
                        unknown_reason: _WARNINGS.neverSynced
                    },
                    {},
                    'Time to paid resolved.'
                ));
            }

            // ── The spine: the population this chart reports on ──────────────
            const spine = await aggregateInstallSpine({ partner_app_id: appId, since: win.since, until: win.until });
            const spineDomains = spine.rows.map((row) => row.shop_domain);

            // ── The subscription evidence for exactly those stores ───────────
            // ⚠️ Issued together; neither depends on the other. The event pull carries NO lower
            // bound — a store that installed inside the window may have subscribed at any point
            // before it — and the settled-payout read IS bounded at `as_of`, or a payout that settles
            // after the window would report a store as paying before it paid. Both invariants live in
            // `installCohort.repository`, at the queries, and are not restated in the `$match` here.
            const [events, settledRows] = await Promise.all([
                findChargeCohortEvents({ partner_app_id: appId, until: asOf, domains: spineDomains }),
                aggregateSettledSubscriptionCharges({ partner_app_id: appId, domains: spineDomains, as_of: asOf })
            ]);

            const settledChargeIds = new Set<string>();
            const settledDomains = new Set<string>();
            for (const row of settledRows) {
                if (row.charge_id) {
                    settledChargeIds.add(row.charge_id);
                }
                if (row.shop_domain) {
                    settledDomains.add(row.shop_domain);
                }
            }

            const cohortResult = resolveChargeCohortForDomains({
                events,
                as_of: asOf,
                settled_charge_ids: settledChargeIds,
                settled_domains: settledDomains,
                domains: spineDomains
            });

            // ── ONE array, ONE pass, every exclusion counted as it is made ───
            const days: number[] = [];
            let notConverted = 0;
            let convertedWithoutDate = 0;
            let convertedBeforeInstall = 0;

            for (const row of spine.rows) {
                const subscription = cohortResult.by_domain.get(row.shop_domain);
                // REACHED PAID BILLING, read off the state the resolver already decided — never
                // re-derived from the date alone. A merchant who cancelled three days before their
                // billing date carries a `conversion_date` inside the window and never paid a cent;
                // `helpers/trialCohort.helper` makes the same pairing and its header carries why.
                const reachedPaid = !!subscription && (
                    subscription.state === SUBSCRIPTION_STATES.PAYING
                    || subscription.state === SUBSCRIPTION_STATES.CHURNED_AFTER_TRIAL
                );
                if (!reachedPaid) {
                    notConverted += 1;
                    continue;
                }
                const convertedAt = subscription && subscription.conversion_date instanceof Date
                    && !Number.isNaN(subscription.conversion_date.getTime())
                    ? subscription.conversion_date
                    : null;
                if (!convertedAt) {
                    //  A COVERAGE GAP, NOT A FUNNEL FACT. The store converted on settled-payout
                    // evidence and Shopify never told us when billing was scheduled to begin, so
                    // there is no date to measure to. Counted on its own line — see the header.
                    convertedWithoutDate += 1;
                    continue;
                }
                if (convertedAt.getTime() < row.installed_at.getTime()) {
                    // ⚠️ EXCLUDED, NEVER CLAMPED. `wholeDaysBetween` floors at zero, so clamping here
                    // would silently file a re-installer under "Same day" — the bar an operator reads
                    // as their best outcome.
                    convertedBeforeInstall += 1;
                    continue;
                }
                days.push(wholeDaysBetween(row.installed_at, convertedAt));
            }

            const fold = foldTimeToPaid(days);
            const totalPaid = fold.stats ? fold.stats.count : 0;

            const excluded: TimeToPaidExclusions = {
                total: notConverted + convertedWithoutDate + convertedBeforeInstall,
                not_converted: notConverted,
                converted_without_billing_date: convertedWithoutDate,
                converted_before_install: convertedBeforeInstall
            };

            // ── Everything excluded or approximated, said out loud ───────────
            if (notConverted > 0) {
                warnings.push(_WARNINGS.notConverted(notConverted, spine.rows.length));
            }
            if (convertedWithoutDate > 0) {
                warnings.push(_WARNINGS.convertedWithoutDate(convertedWithoutDate));
            }
            if (convertedBeforeInstall > 0) {
                warnings.push(_WARNINGS.convertedBeforeInstall(convertedBeforeInstall));
            }
            const inferred = cohortResult.diagnostics.state_basis[STATE_BASIS.INFERRED];
            if (inferred > 0) {
                warnings.push(_WARNINGS.inferredStates(inferred));
            }
            if (cohortResult.diagnostics.test_subscriptions_excluded > 0) {
                warnings.push(_WARNINGS.testSubscriptionsExcluded(cohortResult.diagnostics.test_subscriptions_excluded));
            }
            if (spine.shopless_install_events > 0) {
                warnings.push(_WARNINGS.shoplessInstallEvents(spine.shopless_install_events));
            }
            if (cohortResult.diagnostics.skipped_keyless > 0) {
                warnings.push(_WARNINGS.skippedKeylessSubscriptionEvents(cohortResult.diagnostics.skipped_keyless));
            }
            if (fold.unbucketed > 0) {
                warnings.push(_WARNINGS.unbucketedDays(fold.unbucketed));
            }
            warnings.push(..._coverageWarnings(app, win));

            const payload: TimeToPaidResponse = {
                ..._envelope,
                buckets: fold.buckets,
                stats: fold.stats,
                //  A BARE NUMBER. The page does `typeof data.total_paid_shops === 'number'` and
                // treats `0` as its own empty state — "No shops converted to paid in this window yet"
                // — which is the correct rendering of a measured zero once a sync has run.
                total_paid_shops: totalPaid,
                total_installed_shops: spine.rows.length,
                excluded,
                diagnostics: {
                    installed_shops: spine.rows.length,
                    shopless_install_events: spine.shopless_install_events,
                    skipped_keyless_subscription_events: cohortResult.diagnostics.skipped_keyless,
                    test_subscriptions_excluded: cohortResult.diagnostics.test_subscriptions_excluded,
                    unbucketed_days: fold.unbucketed,
                    earliest_event_at: _iso(app.earliest_event_at)
                },
                // ⚠️ De-duplicated because the page keys each warning by the string itself, so a
                // repeat is not drawn twice — it is DROPPED, along with its condition.
                warnings: [...new Set(warnings)],
                data_state: TIME_TO_PAID_DATA_STATES.READY
            };

            // ⚠️ A 200 with an empty histogram, always. "Nobody converted in this window" is an
            // ordinary answer once a sync has run, separated from "we have not looked" by
            // `data_state` and from "we cannot see that far back" by `warnings[]`.
            return resolve(promiseReturnResult(true, payload, {}, 'Time to paid resolved.'));
        } catch (error) {
            customConsoleError('ERROR: Conversion timeToPaidService getTimeToPaid', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read time to paid. Please try again.'));
        }
    });
};

export = {
    getTimeToPaid
};
