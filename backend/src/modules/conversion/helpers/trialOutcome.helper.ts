'use strict';

/**
 * ============================================================================
 *  ONE ALREADY-FOLDED COHORT  →  THE BREAKDOWN, THE ROLLUP AND THE SHOP ROWS
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, and NO CLOCK — everything here is a projection of
 *  values the caller already holds.
 *
 *  ──  IT DOES NOT CLASSIFY ANYTHING, AND THAT IS THE WHOLE DESIGN ──────────────────────────
 *
 *  Every subscription arrives ALREADY CLASSIFIED by `resolvers/chargeCohort.resolver` (through
 *  `helpers/subscriptionState.helper`), and every count arrives ALREADY FOLDED by
 *  `helpers/trialCohort.helper`. This file turns those into the shapes two pages render and adds
 *  NOTHING to them. A second reading of "did this shop convert" here would be a second opinion about
 *  the same merchant, and the one on screen would be whichever fold ran last — which is exactly how
 *  the system this was extracted from ended up with two pages disagreeing about MRR.
 *
 *  ── CONVERSION IS A DATE COMPARISON, AND IT HAPPENS UPSTREAM ────────────────────────────────
 *
 *  `classifyAsOf` decides it: a subscription with a known `charge.billingOn` is PAYING only once
 *  that date has passed, and ON_TRIAL until then. So a merchant who signed up yesterday is NOT
 *  converted, however loudly their `SUBSCRIPTION_CHARGE_ACCEPTED` event says they subscribed.
 *  Counting the EVENT instead marks every trialling shop as converted the moment they sign up: it
 *  inflates the rate towards 100% and hides trial abandonment completely, and it looks entirely
 *  plausible. Nothing in this file may re-derive that, and nothing here may add a state.
 *
 *  ── EVERY STATE IS ENUMERATED, ZEROS INCLUDED ───────────────────────────────────────────────
 *
 *  `frontend/pages/trial-funnel/index.js` looks a state up with `find()` and answers
 *  `{ count: 0 }` for a row it cannot see. That is correct for a state with no shops in it and a lie
 *  about a state the service forgot to publish, and the two are indistinguishable on screen.
 *  Enumerating over `SUBSCRIPTION_STATE_ORDER` removes the ambiguity at the source.
 * ============================================================================
 */

import lifecycleConstants = require('../constants/lifecycle.constants');
import trialOutcomeConstants = require('../constants/trialOutcome.constants');
import funnelMathHelper = require('./funnelMath.helper');

import type { CohortSubscription, SubscriptionState } from '../types/lifecycle.types';
import type { TrialCohortCounts } from '../types/customFunnel.types';
import type {
    TrialCancellationRollup,
    TrialCohortShopRow,
    TrialOutcomeBreakdownRow
} from '../types/trialOutcome.types';

const { SUBSCRIPTION_STATES } = lifecycleConstants;
const {
    SUBSCRIPTION_STATE_LABELS,
    SUBSCRIPTION_STATE_ORDER,
    TRIAL_SIDE_LOSS_STATES
} = trialOutcomeConstants;
const { rate } = funnelMathHelper;

/**
 * Subscription state → the counter in `TrialCohortCounts` that holds its size.
 *
 * ⚠️ TYPED AS A TOTAL `Record`, WHICH IS THE POINT. A new member of `SUBSCRIPTION_STATES` fails to
 * compile here rather than silently producing a breakdown row of `undefined` — which `Number()`
 * turns into `NaN`, and which the page's `_numOrNull` then renders as an em dash beside three real
 * numbers that no longer sum to the total.
 *
 * It lives in this helper rather than in `constants/` because the proof IS the annotation, and a
 * constants module ending in an export assignment cannot carry the type that provides it
 * (TS2309). An untyped copy there would be a map with no totality guarantee, which is the same map
 * with the only useful property removed.
 */
const _STATE_TO_COUNT: Record<SubscriptionState, keyof TrialCohortCounts> = {
    [SUBSCRIPTION_STATES.ON_TRIAL]: 'still_on_trial',
    [SUBSCRIPTION_STATES.PAYING]: 'currently_paying',
    [SUBSCRIPTION_STATES.CHURNED_DURING_TRIAL]: 'churned_during_trial',
    [SUBSCRIPTION_STATES.CHURNED_AFTER_TRIAL]: 'churned_after_trial'
};

/**
 * A WIDENED COPY of the map above, so a plain `string` can be looked up in it without an `as` cast.
 *
 * Assignment widens; it does not re-type anything, so `_STATE_TO_COUNT` keeps the totality proof and
 * this keeps the house rule that a cast outside `models.repository` is a finding. The same trick,
 * for the same reason, as `_STATE_KEYS` in `services/installCohort.service`.
 */
const _COUNT_KEY_BY_STATE: Readonly<Record<string, keyof TrialCohortCounts>> = _STATE_TO_COUNT;

/** The four labels, widened for a lookup by a `SubscriptionState` that has no index signature. */
const _LABELS: Readonly<Record<string, string>> = SUBSCRIPTION_STATE_LABELS;

/** An ISO string, or null. One formatter, so a date and its absence are spelled one way each. */
const _iso = (value: Date | null | undefined): string | null => {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        return null;
    }
    return value.toISOString();
};

/**
 * The per-state breakdown the summary cards and the state badges read.
 *
 * EVERY STATE PRESENT, in journey order, zeros included — see the file header.
 *
 * `pct` goes through `rate`, so an EMPTY cohort answers `null` rather than `0`: `0/0` is not "0% of
 * the cohort is paying", it is a cohort with nobody in it, and the page prints the two entirely
 * differently ("0.0% of cohort" versus an em dash).
 *
 * @param counts - The fold `helpers/trialCohort.helper` already produced.
 * @returns One row per subscription state, in journey order.
 */
const buildStateBreakdown = (counts: TrialCohortCounts): TrialOutcomeBreakdownRow[] => {
    const total = counts.trial_started;
    return SUBSCRIPTION_STATE_ORDER.map((state) => {
        const count = counts[_STATE_TO_COUNT[state]];
        return {
            state,
            label: _LABELS[state] || state,
            count,
            // ⚠️ Through `rate`, never `count / total`: a zero denominator here is an empty cohort,
            // and `0/0` is `NaN` while `n/0` is `Infinity`. Both render as something.
            pct: rate(count, total)
        };
    });
};

/**
 * The trial-side losses, rolled up so the page does not have to.
 *
 *  `CHURNED_AFTER_TRIAL` IS NOT IN THIS TOTAL AND MUST NEVER BE ADDED TO IT. A merchant who
 * abandoned on day three of a trial never paid us a cent — nothing was earned and nothing was lost,
 * and it is a demand problem. A merchant who converted and cancelled two months later is real
 * revenue gone. Summing them turns a trial-quality problem into a retention problem, or the reverse,
 * and the card that prints them side by side says exactly that in its own copy.
 *
 * @param counts - The fold's counts.
 * @returns The total, what went into it, and what it means.
 */
const buildCancellationRollup = (counts: TrialCohortCounts): TrialCancellationRollup => {
    return {
        // Summed over the NAMED states rather than read from one field, so adding a second
        // trial-side loss state to the vocabulary lands here automatically — which is the reason the
        // page prefers this rollup over deriving its own.
        count: TRIAL_SIDE_LOSS_STATES.reduce((total, state) => {
            const key = _COUNT_KEY_BY_STATE[state];
            return key ? total + counts[key] : total;
        }, 0),
        states: TRIAL_SIDE_LOSS_STATES,
        meaning: 'Left before the trial ended, so they never paid. Nothing was earned and nothing was lost — '
            + 'this is a demand problem, not churn. It is deliberately never added to the shops that paid and '
            + 'then cancelled.'
    };
};

/**
 * One classified subscription → the row the cohort table renders.
 *
 * ⚠️ `trial_ends_at` IS `null` WHEN SHOPIFY SUPPLIED NO `billingOn`, and it is never
 * `activated_at + N days`. This is a rendered column: an assumed date sits in the table beside real
 * ones, in the same format, with nothing to mark it, and a reader plans around it. The row carries
 * `trial_days_source` so the absence is attributable rather than mysterious.
 *
 * ⚠️ `shop_id` IS THE BUCKET KEY. A Partner charge event carries no shop GID, so there is no shop id
 * to publish; the page uses this only for its React key and for the "No store record · …" label it
 * prints when a row has no domain. The drawer resolves `shop_domain`.
 *
 * @param subscription - A subscription the resolver already classified.
 * @returns The row, with every date as an ISO string or null.
 */
const toTrialCohortShop = (subscription: CohortSubscription): TrialCohortShopRow => {
    return {
        shop_id: subscription.bucket_key,
        shop_domain: subscription.shop_domain,
        state: subscription.state,
        label: _LABELS[subscription.state] || subscription.state,
        plan_name: subscription.plan_name,
        // `price`, not `plan_price`: this page's column is `_fmtMoney(r.price)`. See the type.
        price: subscription.plan_price,
        currency: subscription.currency,
        // `trial_start` is required on a `CohortSubscription` — it is the earliest START event in
        // the bucket, and a bucket exists only because one was seen — so this is never null.
        activated_at: subscription.trial_start.toISOString(),
        trial_ends_at: _iso(subscription.trial_end),
        churned_at: _iso(subscription.churn_date),
        state_basis: subscription.state_basis,
        trial_days_source: subscription.trial_days_source,
        charge_link: subscription.charge_link,
        settled_payout_observed: subscription.settled_payout_observed
    };
};

/**
 * Newest trial start first, then by domain.
 *
 * The table is captioned "the N most recent trial starts", so the truncation and the sort have to
 * agree — a different order would drop a different N and the caption would describe neither.
 *
 * `localeCompare` for the tie-break, never `<`: `<` on strings orders by UTF-16 code unit, which
 * puts `Z` before `a` and files an accented domain in a different neighbourhood from its unaccented
 * twin. The tie-break is what keeps two subscriptions that started in the same millisecond from
 * swapping places between requests, which on screen reads as the data changing.
 *
 * @param a - Left row.
 * @param b - Right row.
 * @returns Negative, zero or positive.
 */
const compareTrialCohortShops = (a: TrialCohortShopRow, b: TrialCohortShopRow): number => {
    if (a.activated_at !== b.activated_at) {
        // ISO-8601 strings of the same length sort lexicographically in chronological order, so the
        // descending compare needs no re-parse. Reversed operands, hence newest first.
        return b.activated_at.localeCompare(a.activated_at);
    }
    return a.shop_domain.localeCompare(b.shop_domain);
};

export = {
    buildStateBreakdown,
    buildCancellationRollup,
    toTrialCohortShop,
    compareTrialCohortShops
};
