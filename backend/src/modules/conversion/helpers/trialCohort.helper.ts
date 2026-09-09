'use strict';

/**
 * ============================================================================
 *  SUBSCRIPTIONS → THE TRIAL BLOCK UNDER THE CHART
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, and NO CLOCK — the window and the judgement instant
 *  arrive as parameters, so the same subscriptions fold identically on a re-run, in a test, and for
 *  a historical window.
 *
 *  It consumes what `resolvers/chargeCohort.resolver.ts` already produces. It does not re-derive a
 *  single state: every subscription arrives ALREADY CLASSIFIED, with its evidence recorded in
 *  `state_basis`. A second classification here would be a second opinion about the same merchant,
 *  and the one on screen would be whichever fold ran last.
 *
 *  ── TWO DIFFERENT POPULATIONS, AND THE CHART SAYS SO ─────────────────────
 *
 *  `counts` describes the COHORT: subscriptions whose trial STARTED inside the window, wherever
 *  they got to since. `converted_in_window` describes something else entirely — every subscription
 *  that REACHED PAID BILLING inside the window, whichever cohort it started in. They answer
 *  different questions, they will disagree, and `PartnerFunnelChart.js:510-513` prints a paragraph
 *  explaining exactly that. Folding them into one number would make the paragraph a lie.
 *
 *  ── A BILLING DATE IS NOT A PAYMENT ──────────────────────────────────────
 *
 *  `conversion_date` is Shopify's `charge.billingOn`: the date billing was SCHEDULED to begin. A
 *  merchant who cancels on the 10th against a billing date of the 13th carries a conversion date
 *  inside the window and never paid a cent. `converted_in_window` therefore requires the SUBSCRIPTION
 *  STATE to agree — PAYING or CHURNED_AFTER_TRIAL — and not merely the date to fall in range.
 *
 *  ── `trial_converted` IS "REACHED PAID BILLING", NOT "IS PAYING NOW" ─────
 *
 *  It is `currently_paying + churned_after_trial`. A merchant who converted and later left DID
 *  convert; counting only the ones still with us would move every trial-to-paid rate down by the
 *  churn rate, and the number would fall over time for a cohort that cannot change.
 *
 *  ── `decided` EXCLUDES THE UNDECIDED FROM BOTH SIDES ─────────────────────
 *
 *  `decided = trial_started - still_on_trial`. A subscription whose trial is still running has not
 *  had the chance to convert, so counting it as a failure understates the rate — by exactly the
 *  proportion of the cohort that is recent, which is largest on the windows an operator looks at
 *  most. The chart's tooltip (`:411-414`) states the exclusion and quotes the count, so the reader
 *  can see what was left out rather than being handed a flattering number.
 *
 *  ── THE CANCEL TRAP: ONE MERCHANT UPGRADING IS TWO TRIAL STARTS HERE ───
 *
 *  Every count below is per SUBSCRIPTION, because the fold upstream keys a bucket per CHARGE. And
 *  Shopify emits a plan change as a CANCEL of the old charge plus an ACCEPT of the new one IN THE
 *  SAME SECOND (`modules/partner/services/partnerSync.service.ts` had to put `charge_id` in the
 *  event hash for exactly this reason). So one merchant upgrading once contributes:
 *
 *      trial_started            +2   — both charges opened inside the window
 *      churned_during_trial     +1   — if the change landed before the old charge's `billingOn`
 *      trial_converted          +2   — if it landed after, both charges reached paid billing
 *
 *  The merchant who did the single best thing available to them is booked as having walked out mid
 *  trial, and the cohort they belong to is one larger than the number of merchants in it.
 *
 *  NOTHING IN THIS FILE COMPENSATES FOR THAT, AND NOTHING SHOULD YET. A merchant who genuinely
 *  cancels and re-subscribes a minute later is byte-identical in this data to one who upgraded, so
 *  every "fix" available here is a guess that would move published trial counts, trial-to-paid and
 *  churn on an inference. `resolvers/chargeCohort.resolver.ts` MEASURES the exposure instead —
 *  `diagnostics.supersession` counts the affected subscriptions, stores and phantom in-trial churns,
 *  and `describeChargeCohortExposure` writes the operator-facing sentence. Read that number before
 *  deciding to change any count in this file.
 * ============================================================================
 */

import lifecycleConstants = require('../constants/lifecycle.constants');
import funnelMathHelper = require('./funnelMath.helper');

import type { ChargeLinkState, CohortSubscription } from '../types/lifecycle.types';
import type { TrialCohortFold, TrialCohortInput } from '../types/customFunnel.types';

const { SUBSCRIPTION_STATES, STATE_BASIS, CHARGE_LINK_STATES } = lifecycleConstants;
const { rate } = funnelMathHelper;

/**
 * Whether an instant falls inside the window.
 *
 * `since: null` is LIFETIME and means no lower bound at all — not a bound at the beginning of time,
 * which would behave the same here but reads as a bound that happens to be very old.
 *
 * ⚠️ EXPORTED, and it did not used to be. `services/trialOutcome.service` has to list the very
 * subscriptions this fold COUNTED — the cohort table under the summary cards — and a second
 * `trial_start >= since && <= until` test written there would be a second definition of the window
 * boundary. The two would agree until one of them was edited, and then the caption ("N shops in this
 * cohort") and the tally above it would describe different populations with nothing on screen to say
 * which was right. Same function, same bounds, one copy.
 *
 * @param [at] - The instant to test.
 * @param since - Lower bound, inclusive, or null for none.
 * @param until - Upper bound, inclusive.
 * @returns True when the instant is usable and inside the window.
 */
const isInWindow = (at: Date | null | undefined, since: Date | null, until: Date): boolean => {
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
        return false;
    }
    const ms = at.getTime();
    if (since && ms < since.getTime()) {
        return false;
    }
    return ms <= until.getTime();
};

/**
 * Folds classified subscriptions into the trial block and the window KPI, in one pass.
 *
 * ONE pass over ONE array, so the six counts, the rate and the KPI cannot disagree with each other
 * — the same rule the install-cohort service is built on, for the same reason.
 *
 * @param params0 - See {@link TrialCohortInput}.
 * @param params0.subscriptions - Every subscription the resolver produced.
 * @param params0.since - Window start, or null for lifetime.
 * @param params0.until - Window end, and the judgement instant the states were resolved at.
 * @returns The counts, the decided-basis rate, the window KPI and the guess count.
 */
const foldTrialCohort = ({ subscriptions, since, until }: TrialCohortInput): TrialCohortFold => {
    let trialStarted = 0;
    let stillOnTrial = 0;
    let currentlyPaying = 0;
    let churnedDuringTrial = 0;
    let churnedAfterTrial = 0;
    let inferredStates = 0;
    let convertedInWindow = 0;

    /**
     * COUNTED OVER THE COHORT, NOT OVER EVERY SUBSCRIPTION THE APP HAS EVER HAD.
     *
     * The resolver publishes its own copy of these three, and it counts the whole app: the event pull
     * behind it has no lower bound by design, because `converted_in_window` must see a subscription
     * that started long before the window. The chart prints them as "Trial length read from the
     * merchant's own charge for R of T subscriptions" and places that sentence beneath the WINDOW
     * cohort block, so on a long-lived app T was a lifetime count captioning a windowed one. Folding
     * them here — inside the same `trial_start`-in-window gate as every other count — is what makes
     * the sentence and the block it captions describe the same population.
     */
    const chargeLink: Record<ChargeLinkState, number> = {
        [CHARGE_LINK_STATES.RESOLVED]: 0,
        [CHARGE_LINK_STATES.UNRESOLVED]: 0,
        [CHARGE_LINK_STATES.ABSENT]: 0
    };

    const rows: readonly CohortSubscription[] = Array.isArray(subscriptions) ? subscriptions : [];

    for (const subscription of rows) {
        // `conversion_date` IS `charge.billingOn` — the date billing was SCHEDULED to begin, not
        // a record that it did. ⚠️ And it arrives on `SUBSCRIPTION_CHARGE_ACTIVATED`, not on
        // `ACCEPTED`: measured on a live operator database of 38,719 events, ACCEPTED carried it 0
        // times out of 13 and ACTIVATED 1,632 times out of 1,632. Comments elsewhere naming ACCEPTED
        // as its source describe a path the data does not take.
        //
        // A merchant who cancels on the 10th against a billing date of the
        // 13th has a conversion date inside the window and NEVER PAID. Dating this figure on the
        // date alone counted every one of them as a conversion: it inflated "Conversions this
        // period" by exactly the trial-failure rate, in the flattering direction, from a field that
        // looks like the right one. The STATE is the record of what actually happened, so both
        // must agree.
        const reachedPaid = subscription.state === SUBSCRIPTION_STATES.PAYING
            || subscription.state === SUBSCRIPTION_STATES.CHURNED_AFTER_TRIAL;

        // ⚠️ Counted over EVERY subscription, not just the cohort — a trial that started before this
        // window and converted inside it is precisely what this figure is for. It is a FLOOR: only a
        // subscription Shopify supplied a `billingOn` for can be dated at all, so a conversion
        // resolved from a settled payout is invisible here, and `diagnostics.charge_link` publishes
        // how many that is.
        if (reachedPaid && isInWindow(subscription.conversion_date, since, until)) {
            convertedInWindow += 1;
        }

        if (!isInWindow(subscription.trial_start, since, until)) {
            continue;
        }

        // ONE PER SUBSCRIPTION, AND A PLAN CHANGE IS TWO SUBSCRIPTIONS. See the header: Shopify
        // emits an upgrade as a cancel plus an accept in the same second, and this line counts both.
        // Do NOT add a de-duplication here — by shop, by `superseded_by_charge_id`, or by anything
        // else. The cohort is defined as subscriptions (`FUNNEL_EVENT_POPULATIONS.SUBSCRIPTIONS`),
        // the whole chart is captioned on that, and collapsing to shops here would silently give
        // `trial_started` a different population from `trial_converted` beside it while both still
        // read "shops" on the axis. The exposure is MEASURED upstream in
        // `diagnostics.supersession` and must be read before anyone changes this number.
        trialStarted += 1;
        if (subscription.state_basis === STATE_BASIS.INFERRED) {
            inferredStates += 1;
        }
        // ⚠️ A guarded increment rather than `chargeLink[state] += 1` outright: the union is closed
        // and the record is total over it, so a value that somehow fell outside would be left
        // visibly unaccounted rather than creating a fourth bucket the chart would then divide by.
        if (Object.hasOwn(chargeLink, subscription.charge_link)) {
            chargeLink[subscription.charge_link] += 1;
        }

        // The four states are exhaustive over `SUBSCRIPTION_STATES`, and a subscription that
        // somehow carried none of them would be counted in `trial_started` and nowhere else — so
        // `decided` would silently exceed its parts. There is no `else` branch inventing a bucket
        // for it: the compile-time totality proof in `types/lifecycle.types.ts` is what keeps the
        // union closed, and a value cast past it is better left visibly unaccounted than quietly
        // filed under a state it was never classified as.
        if (subscription.state === SUBSCRIPTION_STATES.ON_TRIAL) {
            stillOnTrial += 1;
        } else if (subscription.state === SUBSCRIPTION_STATES.PAYING) {
            currentlyPaying += 1;
        } else if (subscription.state === SUBSCRIPTION_STATES.CHURNED_DURING_TRIAL) {
            churnedDuringTrial += 1;
        } else if (subscription.state === SUBSCRIPTION_STATES.CHURNED_AFTER_TRIAL) {
            churnedAfterTrial += 1;
        }
    }

    // Reached paid billing at any point — the same `reachedPaid` reading as above, summed over the
    // cohort's two paid states rather than re-tested, so the step count and the window KPI cannot
    // come to different conclusions about what "converted" means.
    const trialConverted = currentlyPaying + churnedAfterTrial;
    const decided = trialStarted - stillOnTrial;

    return {
        counts: {
            trial_started: trialStarted,
            still_on_trial: stillOnTrial,
            trial_converted: trialConverted,
            churned_during_trial: churnedDuringTrial,
            churned_after_trial: churnedAfterTrial,
            currently_paying: currentlyPaying,
            decided
        },
        // Through `rate`, so an undecided-only cohort answers `null` rather than `0`. A `0` here
        // renders as "0.00%" beside the words "Trial-to-paid rate" — a claim that every merchant who
        // finished a trial declined, made about a cohort where nobody has finished one yet.
        conversion_rate: rate(trialConverted, decided),
        converted_in_window: convertedInWindow,
        inferred_state_subscriptions: inferredStates,
        charge_link: chargeLink
    };
};

export = {
    foldTrialCohort,
    isInWindow
};
