'use strict';

/**
 * ============================================================================
 *  THE MONTHLY TRIAL-COHORT TREND
 * ============================================================================
 *
 *  Serves `GET /api/conversion/trial-trend` — the stacked bar chart, the conversion-rate line and
 *  the month table on the Trial Funnel page.
 *
 *  ── ⚠️ A MONTH WITH NO MEASURABLE RATE PUBLISHES `null`, NEVER `0` ──────────────────────────
 *
 *  This is the whole reason the endpoint is shaped the way it is. The page plots the rate on a
 *  Recharts `<Line connectNulls={false}>` PRECISELY so an unmeasured month breaks the line instead
 *  of drawing a point at the floor, and its month table tones a rate below 20 as `critical`. A `0`
 *  here is therefore not a harmless default: it draws a 0% conversion point on the operator's funnel
 *  and prints it in red, as a verdict on a number that does not exist.
 *
 *  Two different months have no rate, and both must be `null`:
 *    - a month whose cohort is entirely UNDECIDED (or empty) — nobody has finished a trial yet, so
 *      there is nothing to divide by. `rate()` answers null for an empty denominator, and this
 *      service never substitutes;
 *    - a month the stored event history does not reach at all. Its COUNTS are null too, because a
 *      `trial_starts: 0` for a month nothing was ever fetched for is a claim about the business.
 *
 *  ── ONE COHORT, CLASSIFIED ONCE, FOLDED TWELVE TIMES ────────────────────────────────────────
 *
 *  `resolveSubscriptionCohortAsOf` runs ONCE and `foldTrialCohort` runs once per month over the same
 *  array. Nothing is re-classified per month, so twelve months cannot come to twelve different
 *  conclusions about one merchant — and the months use the identical fold the Funnel page's
 *  trial block and `GET /api/conversion/trial-outcomes` use, so all three agree on "converted".
 *
 *  ── THE COHORT IS DATED BY TRIAL START, AND CLASSIFIED AS OF TODAY ──────────────────────────
 *
 *  "How each month's trial-starters resolved" is what the chart says. A merchant who started a trial
 *  in March and cancelled in June belongs to March's cohort and shows as churned there — not in
 *  June. That is what makes a cohort chart a cohort chart, and it is why recent months are still
 *  AGING: they hold shops that may yet convert or churn. `cohort_aged_days` is published so the page
 *  can badge them, and the note says so.
 *
 *  ── THE STACK IS A PARTITION; `churned_after_paid` IS NOT PART OF IT ────────────────────────
 *
 *  `converted + in_trial + cancelled === trial_starts`, always, because the four subscription states
 *  partition the cohort and `converted` is `currently_paying + churned_after_trial`. So
 *  `churned_after_paid` is a SUBSET of `converted`, not a sibling: adding it as a fourth stacked
 *  segment would overflow the month's own total. The page renders it as a table column for exactly
 *  that reason.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import listQueryHelper = require('../../shared/helpers/listQuery.helper');
import lifecycleConstants = require('../constants/lifecycle.constants');
import trialOutcomeConstants = require('../constants/trialOutcome.constants');
import monthBucketHelper = require('../helpers/monthBucket.helper');
import trialCohortHelper = require('../helpers/trialCohort.helper');
import subscriptionCohortResolver = require('../resolvers/subscriptionCohort.resolver');
import installCohortRepository = require('../repositories/installCohort.repository');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { MonthBucket } from '../types/monthBucket.types';
import type {
    TrialTrendMonth,
    TrialTrendParams,
    TrialTrendResponse
} from '../types/trialOutcome.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
// The same clamp every paginated read in this codebase uses: a junk value is the caller's default,
// never a refusal. `?months=banana` returns twelve months, not a 400.
const { positiveInt } = listQueryHelper;
const { COHORT_DATA_STATES } = lifecycleConstants;
const { TRIAL_RATE_BASES, DEFAULT_TREND_MONTHS, MAX_TREND_MONTHS, COHORT_AGING_DAYS } = trialOutcomeConstants;
const { buildMonthBuckets, wholeDaysBetween } = monthBucketHelper;
const { foldTrialCohort } = trialCohortHelper;
const { resolveSubscriptionCohortAsOf } = subscriptionCohortResolver;
// The module's ONE app read — see `installCohort.repository`. A second `findById(…).lean()` in the
// same module is a second projection to keep in step with this one.
const { findPartnerAppById } = installCohortRepository;

/**
 * The methodology sentence the page renders in a Banner beneath the chart.
 *
 * ONE STRING, because `trend.note` is rendered as a single paragraph. It has to carry the three
 * things a reader needs in order not to misread the chart: what a month's cohort IS, why the
 * right-hand months are incomplete, and what a broken line means.
 */
const _NOTE = 'Each month is the cohort of subscriptions whose TRIAL STARTED in that month, shown as they '
    + 'stand today rather than as they stood at the month\'s end — so a merchant who started in March and '
    + `cancelled in June is counted in March. Cohorts younger than ${COHORT_AGING_DAYS} days are still aging: `
    + 'shops shown as on trial may yet convert or churn, so their conversion rate is a floor. The rate is '
    + 'measured over DECIDED trials only (shops still inside their trial are excluded from both sides), and a '
    + 'month in which nothing has decided publishes no rate at all — the line breaks rather than dropping to '
    + 'zero, because 0% would be a claim about your funnel rather than about the data.';

/**
 * ⚠️ THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * The page keys each warning by the string itself, so a duplicate is not drawn twice — it is
 * DROPPED, silently, along with its condition.
 */
const _WARNINGS = Object.freeze({
    neverSynced: 'No Partner sync has completed for this app yet, so no subscription events have been '
        + 'fetched and there is no month-by-month trend to draw. The chart is withheld rather than drawn '
        + 'empty — an empty chart under a title reads as "we measured these months and nothing happened".',

    monthsClamped: (requested: string, applied: number): string => `The requested range of ${requested} months `
        + `is outside what this endpoint serves, so ${applied} months were returned instead. Ask for between 1 `
        + `and ${MAX_TREND_MONTHS}.`,

    unmeasuredMonths: (count: number, earliest: string): string => `${count} of the months below fall entirely `
        + `before the earliest Partner event on record (${earliest}). No event in them was ever fetched, so `
        + 'their counts are published as unknown rather than as zero and the conversion line breaks over them. '
        + 'A zero there would say nobody started a trial, which is a claim about your business rather than '
        + 'about this deployment\'s records.',

    coverageFloorUnknown: 'No event coverage floor has ever been measured for this app, so nothing here can say '
        + 'how far back the stored event history actually reaches. The earliest months below may be floors '
        + 'rather than totals, and there is no way to tell which from the stored data.',

    partialMonth: (month: string): string => `The most recent month (${month}) is still running, so its cohort `
        + 'is partial by construction — trials started later this month are not in it yet. Its bar will grow '
        + 'and its conversion rate will move.',

    inferredStates: (subscriptions: number): string => `${subscriptions} subscription(s) across these months are `
        + 'counted as still in trial on the weakest evidence available: Shopify supplied no billing date for '
        + 'them and no payout has settled against them yet. They sit in the on-trial band and are excluded from '
        + 'every conversion rate rather than counted as failures.',

    testSubscriptionsExcluded: (subscriptions: number): string => `${subscriptions} test subscription(s) were `
        + 'excluded from every month below. Partner install and uninstall events carry no test flag at all, so '
        + 'the same stores are still counted on any install-based view.',

    skippedKeylessSubscriptionEvents: (events: number): string => `${events} subscription event(s) carried `
        + 'neither a charge id nor a shop domain and were skipped rather than pooled. Pooling them would have '
        + 'invented one merged subscription out of many.',

    lifetimeFloor: 'No lifetime Partner sync has ever completed for this app, so the earliest months below are '
        + 'FLOORS rather than totals — there may be older subscriptions that have never been fetched.'
});

/** The reason attached to a single month whose events were never fetched. Short; the long form warns. */
const _MONTH_UNKNOWN_REASON = (earliest: string): string => `This month ends before the earliest Partner event `
    + `on record (${earliest}), so no subscription in it was ever fetched. Its counts are unknown rather than `
    + 'zero.';

/**
 * Which coverage gates make the earliest months a floor rather than a total.
 *
 * These read the measurements a sync records ABOUT ITS OWN COMPLETENESS. They never change a number
 * — they say what the number cannot include.
 *
 * @param app - The app row.
 * @returns Zero or more warning strings.
 */
const _coverageWarnings = (app: PartnerAppDoc): string[] => {
    const out: string[] = [];
    if (!app.lifetime_sync_completed_at) {
        // ⚠️ NOT gated on a lifetime window, unlike the windowed endpoints. This one always reaches
        // back twelve months by default, so a deployment that has only ever run incremental syncs is
        // publishing months built from whatever those windows happened to pull — on the chart an
        // operator looks at most, with nothing else on screen to say so.
        out.push(_WARNINGS.lifetimeFloor);
    }
    // `null` is NOT YET MEASURED, never "there is no floor" — the weakest of the three states, and
    // the one a reader is most likely to mistake for completeness.
    if (!(app.earliest_event_at instanceof Date)) {
        out.push(_WARNINGS.coverageFloorUnknown);
    }
    return out;
};

/**
 * The monthly trial-cohort trend for one app.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query, already cast (not coerced) by the controller.
 * @param params1.partner_app_id - The app to report on. Required.
 * @param [params1.months] - Calendar months to walk back. Clamped, never refused.
 * @returns The trend, or an honest refusal carrying `{}`.
 */
const getTrialTrend = (
    { user_id }: IdentityObject,
    { partner_app_id, months }: TrialTrendParams
): Promise<ServiceResult<TrialTrendResponse | EmptyPayload>> => {
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

            // The service reads the clock ONCE, here, and passes the instant into every pure thing
            // below. A helper may not read it, and a second `new Date()` further down would let two
            // parts of one response describe two different instants.
            const asOf = new Date();
            const appliedMonths = positiveInt(months, DEFAULT_TREND_MONTHS, MAX_TREND_MONTHS);

            const warnings: string[] = [];
            // FAIL-OPEN, PLUS A WARNING. An out-of-range `months` is clamped rather than refused, and
            // the clamp is reported — a chart silently showing 36 months when 200 were asked for is a
            // chart whose x-axis nobody checked.
            const requestedMonths = months === undefined || months === null ? '' : String(months).trim();
            if (requestedMonths !== '' && String(appliedMonths) !== requestedMonths) {
                warnings.push(_WARNINGS.monthsClamped(requestedMonths, appliedMonths));
            }

            const buckets: MonthBucket[] = buildMonthBuckets({ as_of: asOf, months: appliedMonths });
            const oldest = buckets.length > 0 ? buckets[0].start : null;

            const _envelope = {
                app_id: String(app._id),
                app_name: app.display_name,
                months: buckets.length,
                since: oldest ? oldest.toISOString() : null,
                until: asOf.toISOString(),
                as_of: asOf.toISOString(),
                note: _NOTE
            };

            // ── THE WATERMARK, NEVER THE ROW COUNT ───────────────────────────
            if (!app.last_synced_at) {
                const coldPayload: TrialTrendResponse = {
                    ..._envelope,
                    // ⚠️ `null`, NOT `[]`. The page's `_trendNeverSynced` tests
                    // `!Array.isArray(d.monthly_trend)` and draws its banner; an empty array is a
                    // MEASURED empty and would mount a titled, axed chart over nothing.
                    monthly_trend: null,
                    // The clamp notice, if one was raised, rides along rather than being dropped:
                    // this branch is reached AFTER the range was resolved, and a warning discarded
                    // because a different condition fired first is a warning nobody can act on.
                    warnings: [...new Set([_WARNINGS.neverSynced, ...warnings])],
                    diagnostics: {
                        subscriptions_app_wide: 0,
                        unmeasured_months: buckets.length,
                        inferred_state_subscriptions: 0,
                        skipped_keyless_subscription_events: 0,
                        test_subscriptions_excluded: 0
                    },
                    data_state: COHORT_DATA_STATES.NEVER_SYNCED,
                    // The banner's body. Without it `dataState.js` falls back to `resp.msg` and prints
                    // the SUCCESS message under the heading "Nothing synced yet".
                    unknown_reason: _WARNINGS.neverSynced
                };
                return resolve(promiseReturnResult(true, coldPayload, {}, 'Trial trend resolved.'));
            }

            // ── ONE cohort, classified ONCE, at `as_of` ──────────────────────
            const cohortResult = await resolveSubscriptionCohortAsOf({
                partner_app_id: String(app._id),
                as_of: asOf
            });

            const floor = app.earliest_event_at instanceof Date && !Number.isNaN(app.earliest_event_at.getTime())
                ? app.earliest_event_at
                : null;

            let unmeasuredMonths = 0;
            let inferredAcrossMonths = 0;
            const monthlyTrend: TrialTrendMonth[] = buckets.map((bucket) => {
                // ALWAYS a number, measurable or not: the page computes `is_aging` from it and
                // `null < 90` is TRUE, so a missing value badges the month "Aging" out of an absence.
                // Measured against the CALENDAR month's end, so a month still running reads 0 rather
                // than being aged from a clamped boundary that is simply "now".
                const cohortAgedDays = wholeDaysBetween(bucket.month_end, asOf);

                // A month whose whole covered span precedes the earliest stored event has no answer.
                // ⚠️ `floor === null` does NOT make a month unmeasurable: a null gate means the
                // coverage was never MEASURED, not that there is no data, and treating it as a floor
                // would blank every month on a deployment whose gate has simply never been written.
                // `_coverageWarnings` reports that case instead.
                if (floor && bucket.end.getTime() < floor.getTime()) {
                    unmeasuredMonths += 1;
                    return {
                        month: bucket.month,
                        trial_starts: null,
                        converted: null,
                        in_trial: null,
                        cancelled: null,
                        churned_after_paid: null,
                        decided: null,
                        trial_to_paid_rate: null,
                        rate_basis: TRIAL_RATE_BASES.UNAVAILABLE,
                        cohort_aged_days: cohortAgedDays,
                        is_partial: bucket.is_partial,
                        measurable: false,
                        unknown_reason: _MONTH_UNKNOWN_REASON(floor.toISOString())
                    };
                }

                // THE SAME FOLD, over the SAME already-classified array, with this month's bounds.
                // Nothing is re-classified — `foldTrialCohort` reads `subscription.state` and never
                // derives one — so twelve months cannot reach twelve conclusions about one merchant.
                const fold = foldTrialCohort({
                    subscriptions: cohortResult.subscriptions,
                    since: bucket.start,
                    until: bucket.end
                });
                inferredAcrossMonths += fold.inferred_state_subscriptions;

                const counts = fold.counts;
                return {
                    month: bucket.month,
                    trial_starts: counts.trial_started,
                    // `currently_paying + churned_after_trial`, read off the fold rather than summed
                    // here: a local sum is a second definition of "converted" one edit away from
                    // disagreeing with the summary card on the same page.
                    converted: counts.trial_converted,
                    in_trial: counts.still_on_trial,
                    cancelled: counts.churned_during_trial,
                    // A SUBSET of `converted`. Never stacked with it — see the file header.
                    churned_after_paid: counts.churned_after_trial,
                    decided: counts.decided,
                    // ⚠️ `null` when nothing in this month has decided. `rate()` refuses an empty
                    // denominator, and this service never substitutes a zero for its refusal.
                    trial_to_paid_rate: fold.conversion_rate,
                    rate_basis: fold.conversion_rate === null
                        ? TRIAL_RATE_BASES.UNAVAILABLE
                        : TRIAL_RATE_BASES.DECIDED,
                    cohort_aged_days: cohortAgedDays,
                    is_partial: bucket.is_partial,
                    measurable: true,
                    unknown_reason: null
                };
            });

            // ── Everything that was excluded or guessed, said out loud ───────
            const diagnostics = cohortResult.diagnostics;
            if (unmeasuredMonths > 0 && floor) {
                warnings.push(_WARNINGS.unmeasuredMonths(unmeasuredMonths, floor.toISOString()));
            }
            const newest = buckets.length > 0 ? buckets[buckets.length - 1] : null;
            if (newest && newest.is_partial) {
                warnings.push(_WARNINGS.partialMonth(newest.month));
            }
            if (inferredAcrossMonths > 0) {
                warnings.push(_WARNINGS.inferredStates(inferredAcrossMonths));
            }
            if (diagnostics.test_subscriptions_excluded > 0) {
                warnings.push(_WARNINGS.testSubscriptionsExcluded(diagnostics.test_subscriptions_excluded));
            }
            if (diagnostics.skipped_keyless > 0) {
                warnings.push(_WARNINGS.skippedKeylessSubscriptionEvents(diagnostics.skipped_keyless));
            }
            warnings.push(..._coverageWarnings(app));

            const payload: TrialTrendResponse = {
                ..._envelope,
                monthly_trend: monthlyTrend,
                warnings: [...new Set(warnings)],
                diagnostics: {
                    subscriptions_app_wide: diagnostics.subscriptions,
                    unmeasured_months: unmeasuredMonths,
                    // Summed across the months rather than taken app-wide, so the figure describes
                    // the population the chart actually draws. A subscription that started before the
                    // oldest bucket is in neither.
                    inferred_state_subscriptions: inferredAcrossMonths,
                    skipped_keyless_subscription_events: diagnostics.skipped_keyless,
                    test_subscriptions_excluded: diagnostics.test_subscriptions_excluded
                },
                data_state: COHORT_DATA_STATES.READY
            };

            return resolve(promiseReturnResult(true, payload, {}, 'Trial trend resolved.'));
        } catch (error) {
            customConsoleError('ERROR: Conversion trialTrendService getTrialTrend', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read the trial trend. Please try again.'));
        }
    });
};

export = {
    getTrialTrend
};
