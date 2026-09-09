'use strict';

/**
 * ============================================================================
 *  WHAT BECAME OF THE TRIALS THAT STARTED IN THIS WINDOW
 * ============================================================================
 *
 *  Serves `GET /api/conversion/trial-outcomes` — the summary cards, the "Where shops are lost" card
 *  and the cohort table on the Trial Funnel page.
 *
 *  ── ⚠️ CONVERSION IS A DATE COMPARISON, NOT AN EVENT ────────────────────────────────────────
 *
 *  A merchant converted if they were STILL AROUND WHEN THE TRIAL RAN OUT. That is decided upstream,
 *  in `helpers/subscriptionState.helper`, by comparing Shopify's own `charge.billingOn` against the
 *  judgement instant: a subscription whose billing date has not arrived is ON_TRIAL, whatever its
 *  `SUBSCRIPTION_CHARGE_ACCEPTED` event says.
 *
 *  Counting the EVENT instead — "they subscribed, so they converted" — marks every trialling shop as
 *  converted the moment they sign up. It pushes the trial-to-paid rate towards 100%, it hides trial
 *  abandonment completely, and it produces a number that looks entirely plausible. Nothing in this
 *  file re-derives a state; every subscription arrives classified and this service only projects and
 *  tallies.
 *
 *  ── ⚠️ WHERE PEOPLE QUIT IS THE WHOLE POINT ─────────────────────────────────────────────────
 *
 *  `CHURNED_DURING_TRIAL` and `CHURNED_AFTER_TRIAL` are counted separately and are never summed.
 *  Abandoning on day three of a seven-day trial is a demand problem in which nothing was earned and
 *  nothing was lost; cancelling two months after converting is real revenue gone. The page prints
 *  them side by side with a sentence each saying exactly that, so a single "cancelled" bucket would
 *  make that card a lie in one direction or the other.
 *
 *  ── ⚠️ THE RATE EXCLUDES THE UNDECIDED FROM BOTH SIDES ──────────────────────────────────────
 *
 *  `trial_to_paid_rate = converted / decided`, and `decided = trial_started - still_on_trial`. A
 *  subscription still inside its trial has not had the CHANCE to convert, so counting it as a
 *  failure understates the rate — by exactly the proportion of the cohort that is recent, which is
 *  largest on the windows an operator actually looks at. `rate_basis` publishes which basis was used
 *  and the page's own hint says "shops still on trial are excluded".
 *
 *  ── ⚠️ THERE IS DELIBERATELY NO LEDGER CROSS-CHECK HERE ─────────────────────────────────────
 *
 *  The page renders a caveat for a `stale.demoted_count` — subscriptions the charge record calls
 *  paying that the settled-payout ledger has not seen recently. This service does NOT compute one,
 *  and that is a decision rather than an omission: demoting a subscription here would make
 *  `trial_converted` on this page disagree with `trial_converted` in the trial block on the
 *  Funnel page, which folds the identical cohort through the identical
 *  `helpers/trialCohort.helper`. Two subtly different answers to "did this shop convert" on two
 *  pages is the exact divergence this module was extracted to end. The ledger's own predicate has a
 *  page — Logo Churn — and it is measured there, once.
 *
 *  ── EMPTY IS A 200. THE DISCRIMINATOR IS THE WATERMARK, NEVER THE ROW COUNT ─────────────────
 *
 *  No subscriptions plus `last_synced_at` is a real, publishable "nobody started a trial in this
 *  window". No subscriptions and no watermark is "we have not looked yet", and the two must never
 *  render alike. The only refusals are: no `user_id`, no `partner_app_id`, no such app, or a query
 *  that threw.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import dateRangeHelper = require('../../shared/helpers/dateRange.helper');
import lifecycleConstants = require('../constants/lifecycle.constants');
import trialOutcomeConstants = require('../constants/trialOutcome.constants');
import trialCohortHelper = require('../helpers/trialCohort.helper');
import trialOutcomeHelper = require('../helpers/trialOutcome.helper');
import subscriptionCohortResolver = require('../resolvers/subscriptionCohort.resolver');
import installCohortRepository = require('../repositories/installCohort.repository');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { ResolvedDateRange } from '../../shared/types/dateRange.types';
import type { CohortSubscription } from '../types/lifecycle.types';
import type {
    TrialCohortShopRow,
    TrialOutcomesParams,
    TrialOutcomesResponse
} from '../types/trialOutcome.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { resolveDateRange } = dateRangeHelper;
const { COHORT_DATA_STATES } = lifecycleConstants;
const {
    SUBSCRIPTION_STATE_LABELS,
    CONVERTED_SUBSCRIPTION_STATES,
    TRIAL_RATE_BASES,
    TRIAL_COHORT_SHOP_LIMIT
} = trialOutcomeConstants;
// THE SAME FOLD THE CONVERSION FUNNEL'S TRIAL BLOCK USES. Not a copy of it, and not a variant —
// see the header on the ledger cross-check for why that matters more here than anywhere else.
const { foldTrialCohort, isInWindow } = trialCohortHelper;
const {
    buildStateBreakdown,
    buildCancellationRollup,
    toTrialCohortShop,
    compareTrialCohortShops
} = trialOutcomeHelper;
const { resolveSubscriptionCohortAsOf } = subscriptionCohortResolver;
// ⚠️ The module's ONE app read, deliberately not duplicated. It already projects exactly the
// watermarks and coverage gates this endpoint needs; a second `findById(…).lean()` in the same
// module is a second projection to keep in step with this one.
const { findPartnerAppById } = installCohortRepository;

/**
 * ⚠️ THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * The page renders one `<p>`-equivalent per warning KEYED BY THE STRING ITSELF. Two identical
 * strings are a duplicate React key and one of them is silently dropped — so a second copy of a
 * message does not double up, it DISAPPEARS, and takes its condition with it. Keeping them together
 * is what makes that checkable by eye.
 *
 * Each is written for an operator who cannot see this code: what is missing, what it does to the
 * numbers above it, and what would fix it.
 */
const _WARNINGS = Object.freeze({
    neverSynced: 'No Partner sync has completed for this app yet, so no subscription events have been '
        + 'fetched. Every figure on this page is left unmeasured rather than shown as zero — we have not '
        + 'looked, which is not the same as nobody having started a trial.',

    rateUnavailable: (stillOnTrial: number): string => `Every subscription in this cohort is still inside `
        + `its trial (${stillOnTrial} of them), so no trial-to-paid rate is published for it. A rate needs `
        + 'at least one finished trial to divide by; showing 0% would report that everyone declined, about '
        + 'a cohort where nobody has finished yet.',

    inferredStates: (subscriptions: number): string => `${subscriptions} subscription(s) in this cohort are `
        + 'counted as still in trial on the weakest evidence available: Shopify supplied no billing date for '
        + 'them and no payout has settled against them yet. That is the reading which claims no revenue and '
        + 'no loss, not a measured trial — so they sit in the undecided column and are excluded from the '
        + 'rate rather than counted as failures.',

    testSubscriptionsExcluded: (subscriptions: number): string => `${subscriptions} test subscription(s) were `
        + 'excluded from every count on this page. Partner install and uninstall events carry no test flag at '
        + 'all, so the same stores are still counted on any install-based view — the two are asymmetric and no '
        + 'available data can reconcile them.',

    skippedKeylessSubscriptionEvents: (events: number): string => `${events} subscription event(s) carried `
        + 'neither a charge id nor a shop domain and were skipped rather than pooled. Pooling them would have '
        + 'invented one merged subscription out of many, which reads as a single real merchant.',

    shoplessSubscriptions: (subscriptions: number): string => `${subscriptions} subscription(s) in this cohort `
        + 'carry no shop domain, so they are counted in the totals but cannot be opened in the store panel — '
        + 'there is no store identity on their events to look one up with. They are listed with their charge '
        + 'key instead of a domain.',

    shopsTruncated: (shown: number, total: number): string => `This cohort holds ${total} subscription(s) and `
        + `the table below lists the ${shown} most recent. The page does not paginate, so narrowing the date `
        + 'range is the only way to see the rest — the tab counts describe the rows shown, not the cohort.',

    lifetimeFloor: 'No lifetime Partner sync has ever completed for this app, so every all-time figure here is a '
        + 'FLOOR rather than a total — there may be older subscriptions that have never been fetched.',

    beforeEarliestEvent: (earliest: string): string => 'The window starts before the earliest Partner event on '
        + `record (${earliest}). Events before that date were never fetched and cannot appear here, so the trial `
        + 'starts counted for the earlier part of this window are a floor rather than a total.',

    /**
     * ⚠️ Fires on the app-level measurement, which records the WIDEST gap in the whole event history
     * and NOT where it sits — so the window cannot be tested against it and the wording must stay
     * conditional. `null` is "never measured" and `0` is a real, reassuring "no day-wide hole";
     * neither warns.
     */
    eventHistoryGap: (days: number): string => 'The Partner event history for this app contains a stretch of '
        + `${days} day(s) carrying no events at all. If that stretch falls inside this window, the cohort below `
        + 'is a floor rather than a total. The data cannot say whether it was a genuinely quiet period or a sync '
        + 'window that failed and was never re-pulled, which is why it is published here rather than resolved.'
});

/**
 * The methodology sentences the page renders in its "Methodology notes" banner.
 *
 * PUBLISHED RATHER THAN TYPED INTO THE PAGE, and the page says why: "The definition of 'converted'
 * has changed twice in this module, and a note typed into the page cannot follow it." These are the
 * definitions this service actually applied, so they move when it does.
 *
 * ⚠️ Every string unique — the page keys them by content, exactly as it does the warnings.
 */
const _NOTES: readonly string[] = Object.freeze([
    'A subscription counts as CONVERTED when it was still active on the date Shopify\'s own billing date fell '
        + '— not when the subscription event arrived. A merchant who signed up yesterday on a seven-day trial has '
        + 'not converted; they are counted as still on trial until that date passes.',
    'Converted includes merchants who paid and later cancelled. They did convert, and counting only the ones '
        + 'still with us would move this rate down by the churn rate — so the number would fall over time for a '
        + 'cohort that cannot change.',
    'The trial-to-paid rate is measured over DECIDED trials only: subscriptions still inside their trial are '
        + 'excluded from both the numerator and the denominator, because they have not had the chance to convert '
        + 'yet and counting them as failures would understate the rate.',
    'Left during trial and Churned after paying are counted separately and are never added together. The first '
        + 'merchant never paid us anything; the second did. Collapsing them turns a trial-quality problem into a '
        + 'retention problem, or the reverse.',
    'Trial end dates come from Shopify\'s own billing date on the charge. Where Shopify supplied none the column '
        + 'is left empty rather than estimated — an assumed date sitting beside real ones, in the same format, is '
        + 'something a reader plans around.'
]);

/**
 * An ISO string, or null.
 *
 * @param [value] - Any stored or resolved date.
 * @returns The ISO form, or null when there is no date.
 */
const _iso = (value?: Date | null): string | null => {
    if (!value) {
        return null;
    }
    return value.toISOString();
};

/**
 * Which coverage gates on the app row make this window's figures a floor rather than a total.
 *
 * These read the measurements a sync records ABOUT ITS OWN COMPLETENESS. They never change a number
 * — they say what the number cannot include.
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
    // ⚠️ `> 0` and an explicit finite check, never truthiness: `0` is a MEASURED "no day-wide hole",
    // the most reassuring value the field can take, and `null` is "never measured". Warning on either
    // would fire the banner on healthy data, which is how a warning stops being read.
    const gapDays = app.event_history_gap_days;
    if (typeof gapDays === 'number' && Number.isFinite(gapDays) && gapDays > 0) {
        out.push(_WARNINGS.eventHistoryGap(gapDays));
    }
    return out;
};

/**
 * The trial outcomes for one window: the cohort, how it resolved, and the shops behind it.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query, already cast (not coerced) by the controller.
 * @param params1.partner_app_id - The app to report on. Required.
 * @param [params1.period_days] - number, 0 or 'all' (default 30).
 * @param [params1.since] - ISO date; honoured only together with `until`.
 * @param [params1.until] - ISO date; honoured only together with `since`.
 * @returns The outcomes, or an honest refusal carrying `{}`.
 */
const getTrialOutcomes = (
    { user_id }: IdentityObject,
    { partner_app_id, period_days, since, until }: TrialOutcomesParams
): Promise<ServiceResult<TrialOutcomesResponse | EmptyPayload>> => {
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
            // today without saying so. Checking it before the fold keeps that throw out of the
            // envelope.
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

            /** Everything both branches publish, so the two payloads cannot drift apart. */
            const _envelope = {
                app_id: appId,
                app_name: app.display_name,
                period_label: win.periodLabel,
                period_days: periodDays,
                kind: win.kind,
                since: _iso(win.since),
                until: win.until.toISOString(),
                as_of: asOf.toISOString(),
                shop_identity: 'shop_domain',
                states: SUBSCRIPTION_STATE_LABELS,
                notes: [..._NOTES]
            };

            // ── THE WATERMARK, NEVER THE ROW COUNT ───────────────────────────
            // No subscriptions plus a watermark is a real "nobody started a trial here"; no
            // subscriptions and no watermark is "we have not looked". The cohort read is skipped
            // entirely on the second path: nothing could have been written, and issuing the query
            // would only make the log read as though it had.
            if (!app.last_synced_at) {
                const coldPayload: TrialOutcomesResponse = {
                    ..._envelope,
                    total_shops_in_cohort: null,
                    decided_count: null,
                    still_on_trial: null,
                    converted_count: null,
                    converted_states: CONVERTED_SUBSCRIPTION_STATES,
                    trial_to_paid_rate: null,
                    rate_basis: TRIAL_RATE_BASES.UNAVAILABLE,
                    // ⚠️ `null`, NOT `[]`. The page's `_outcomesNeverSynced` tests
                    // `!Array.isArray(d.breakdown)` and routes the payload to its banner; an empty
                    // array is a MEASURED empty and would render four hard zeros beside a blank rate.
                    breakdown: null,
                    cancellation_rollup: null,
                    shops: [],
                    shops_truncated: false,
                    warnings: [_WARNINGS.neverSynced],
                    diagnostics: {
                        subscriptions_app_wide: 0,
                        inferred_state_subscriptions: 0,
                        shopless_subscriptions: 0,
                        skipped_keyless_subscription_events: 0,
                        test_subscriptions_excluded: 0,
                        charge_link: { resolved: 0, unresolved: 0, absent: 0 },
                        shops_omitted: 0
                    },
                    data_state: COHORT_DATA_STATES.NEVER_SYNCED,
                    // THE BANNER'S BODY. `dataState.js` nulls `data` — warnings and all — and renders
                    // `data.unknown_reason || resp.msg`. Without this field that resolves to the
                    // SUCCESS message, so the page prints "Trial outcomes resolved." under the heading
                    // "Nothing synced yet".
                    unknown_reason: _WARNINGS.neverSynced
                };
                return resolve(promiseReturnResult(true, coldPayload, {}, 'Trial outcomes resolved.'));
            }

            // ── The app-wide cohort, classified once, at `as_of` ─────────────
            const cohortResult = await resolveSubscriptionCohortAsOf({ partner_app_id: appId, as_of: asOf });

            // ONE FOLD, and it is the same one the Funnel page's trial block uses. Every count
            // below is read off this single result — there is no second tally anywhere in this file,
            // so the cards, the breakdown and the rate cannot disagree with each other.
            const fold = foldTrialCohort({
                subscriptions: cohortResult.subscriptions,
                since: win.since,
                until: asOf
            });

            // ── The rows behind those counts ─────────────────────────────────
            // ⚠️ `isInWindow` is the FOLD'S OWN window test, exported for this call. A local
            // `trial_start >= since` here would be a second boundary definition, and the caption
            // ("N shops in this cohort") and the tally above it would eventually describe different
            // populations.
            const cohortSubscriptions: CohortSubscription[] = cohortResult.subscriptions.filter(
                (subscription) => isInWindow(subscription.trial_start, win.since, asOf)
            );

            let shoplessSubscriptions = 0;
            const rows: TrialCohortShopRow[] = [];
            for (const subscription of cohortSubscriptions) {
                if (subscription.shop_domain === '') {
                    shoplessSubscriptions += 1;
                }
                rows.push(toTrialCohortShop(subscription));
            }

            // SORT A COPY. `filter` and the loop above happen to produce new arrays today, so nothing
            // is wrong right now — but the counts came from `cohortResult.subscriptions`, and it is
            // free to make an in-place sort of a tallied array impossible rather than true by
            // coincidence.
            const sorted = [...rows].sort(compareTrialCohortShops);
            const shops = sorted.slice(0, TRIAL_COHORT_SHOP_LIMIT);
            const shopsOmitted = sorted.length - shops.length;

            // ── Every figure, derived from the one fold ──────────────────────
            const counts = fold.counts;
            const breakdown = buildStateBreakdown(counts);
            const cancellationRollup = buildCancellationRollup(counts);
            // `fold.conversion_rate` is already `rate(trial_converted, decided)` — `null` for an
            // undecided-only cohort. Read, never recomputed: a second division here is a second
            // chance to spell the denominator differently.
            const trialToPaidRate = fold.conversion_rate;

            // ── Everything that was excluded or guessed, said out loud ───────
            const diagnostics = cohortResult.diagnostics;
            if (trialToPaidRate === null && counts.trial_started > 0) {
                warnings.push(_WARNINGS.rateUnavailable(counts.still_on_trial));
            }
            if (fold.inferred_state_subscriptions > 0) {
                warnings.push(_WARNINGS.inferredStates(fold.inferred_state_subscriptions));
            }
            if (diagnostics.test_subscriptions_excluded > 0) {
                warnings.push(_WARNINGS.testSubscriptionsExcluded(diagnostics.test_subscriptions_excluded));
            }
            if (diagnostics.skipped_keyless > 0) {
                warnings.push(_WARNINGS.skippedKeylessSubscriptionEvents(diagnostics.skipped_keyless));
            }
            if (shoplessSubscriptions > 0) {
                warnings.push(_WARNINGS.shoplessSubscriptions(shoplessSubscriptions));
            }
            if (shopsOmitted > 0) {
                warnings.push(_WARNINGS.shopsTruncated(shops.length, sorted.length));
            }
            warnings.push(..._coverageWarnings(app, win));

            const payload: TrialOutcomesResponse = {
                ..._envelope,
                total_shops_in_cohort: counts.trial_started,
                decided_count: counts.decided,
                still_on_trial: counts.still_on_trial,
                converted_count: counts.trial_converted,
                // NAMED ON THE WIRE, beside the number it is the sum of. The definition of
                // "converted" has changed twice in this module, and `CHURNED_AFTER_TRIAL` being
                // inside it is the half a reader is most likely to doubt — so the payload states it
                // rather than a comment nobody reading the response can see.
                converted_states: CONVERTED_SUBSCRIPTION_STATES,
                trial_to_paid_rate: trialToPaidRate,
                // `decided` even when the rate came back null: the BASIS is what was applied, and it
                // is what the page's hint ("of N decided trials") describes. `unavailable` is reserved
                // for the cold path, where no basis was applied at all.
                rate_basis: TRIAL_RATE_BASES.DECIDED,
                breakdown,
                cancellation_rollup: cancellationRollup,
                shops,
                shops_truncated: shopsOmitted > 0,
                warnings: [...new Set(warnings)],
                diagnostics: {
                    subscriptions_app_wide: diagnostics.subscriptions,
                    // ⚠️ THE WINDOW-SCOPED counts, from the fold — not the resolver's app-wide ones.
                    // The cohort pull is deliberately unbounded below (a trial that finishes inside
                    // the window may have started long before it), so the resolver's own triple counts
                    // EVERY subscription the app has ever had. Publishing that under a window-scoped
                    // heading is how a lifetime figure ends up captioning a windowed block.
                    inferred_state_subscriptions: fold.inferred_state_subscriptions,
                    shopless_subscriptions: shoplessSubscriptions,
                    skipped_keyless_subscription_events: diagnostics.skipped_keyless,
                    test_subscriptions_excluded: diagnostics.test_subscriptions_excluded,
                    charge_link: fold.charge_link,
                    shops_omitted: shopsOmitted
                },
                data_state: COHORT_DATA_STATES.READY
            };

            // ⚠️ A 200 with an empty cohort, always. "Nobody started a trial in this window" is an
            // ordinary answer once a sync has run, and it is separated from "we have not looked" by
            // `data_state` — never by a refusal, which the page renders as its NOT_CONNECTED banner
            // telling the operator to go and check their environment file.
            return resolve(promiseReturnResult(true, payload, {}, 'Trial outcomes resolved.'));
        } catch (error) {
            customConsoleError('ERROR: Conversion trialOutcomeService getTrialOutcomes', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read trial outcomes. Please try again.'));
        }
    });
};

export = {
    getTrialOutcomes
};
