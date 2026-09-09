'use strict';

/**
 * ============================================================================
 *  TRIAL OUTCOMES & TRIAL TREND — the vocabulary the two pages agree on
 * ============================================================================
 *
 *  Dependency-light by design: it imports the lifecycle vocabulary and nothing else, so a pure
 *  helper, a resolver and a service can all read it without dragging a layer sideways.
 *
 *  ── THERE IS NO SECOND SET OF STATE NAMES IN HERE, AND THAT IS THE POINT ─────────────────────
 *
 *  `SUBSCRIPTION_STATES` already exists in `lifecycle.constants.ts` and is what
 *  `resolvers/chargeCohort.resolver` writes onto every subscription. This file adds LABELS and an
 *  ORDER for those four values and NOTHING ELSE — it does not name a fifth outcome, and it does not
 *  spell `CHURNED_DURING_TRIAL` a second way.
 *
 *   `CHURNED_DURING_TRIAL` AND `CHURNED_AFTER_TRIAL` MUST NEVER BE ROLLED TOGETHER. Abandoning on
 *  day three of a trial and cancelling two months after converting are entirely different problems:
 *  one is a demand problem where nothing was earned and nothing was lost, the other is real revenue
 *  gone. `frontend/pages/trial-funnel/index.js` prints them side by side under the
 *  heading "Where shops are lost" with a sentence each saying exactly that, and it tones them
 *  differently (`caution` vs `critical`). A single "cancelled" bucket would make that card a lie.
 *
 *  ── THE LABELS ARE A FRONTEND CONTRACT ──────────────────────────────────────────────────────
 *
 *  They mirror `STATE_LABEL_FALLBACK` (`trial-funnel/index.js`) WORD FOR WORD. The page prefers
 *  `row.label` off the payload and falls back to its own map, so two spellings of one state produce
 *  two different names for the same shop on one screen — the breakdown card saying one thing and
 *  the cohort table's badge another.
 * ============================================================================
 */

// `export =` module — a named import here is TS2497, so it is imported whole and destructured.
import lifecycleConstants = require('./lifecycle.constants');

const { SUBSCRIPTION_STATES } = lifecycleConstants;

/**
 * What each SUBSCRIPTION state is called on screen.
 *
 * Published as the response's `states` map AND onto every breakdown row and cohort row as `label`,
 * so the summary cards, the tab strip and the table badge all read from one table.
 */
const SUBSCRIPTION_STATE_LABELS = Object.freeze({
    ON_TRIAL: 'On trial',
    PAYING: 'Paying',
    CHURNED_DURING_TRIAL: 'Churned during trial',
    CHURNED_AFTER_TRIAL: 'Churned after trial'
} as const);

/**
 * The four states in JOURNEY order — on trial, then paying, then the two ways out.
 *
 * Derived from the vocabulary rather than restated, so a new subscription state widens this list
 * automatically instead of leaving a hand-written copy one member short.
 *
 * Use it to enumerate `breakdown` — EVERY STATE PRESENT, ZEROS INCLUDED. The page's `find()` answers
 * `{ count: 0 }` for a state missing from the array, which is correct for a state with no shops and
 * indistinguishable from one the service forgot; enumerating removes the ambiguity at the source.
 */
const SUBSCRIPTION_STATE_ORDER = Object.freeze(Object.values(SUBSCRIPTION_STATES));

/**
 * Which states are counted as REACHED PAID BILLING.
 *
 *  `CHURNED_AFTER_TRIAL` IS IN THIS LIST. A merchant who converted and later left DID convert;
 * counting only the ones still with us would move every trial-to-paid rate down by the churn rate,
 * and the number would then fall over time for a cohort that cannot change. The page's own summary
 * does `_sumOrNull(paying.count, churned_after_trial.count)` and says so in a comment.
 *
 * ⚠️ NOT re-derived here — `helpers/trialCohort.helper` already folds `trial_converted` as
 * `currently_paying + churned_after_trial`, and this list exists so the same reading can be
 * NAMED on the payload rather than reconstructed by a reader.
 */
const CONVERTED_SUBSCRIPTION_STATES: readonly string[] = Object.freeze([
    SUBSCRIPTION_STATES.PAYING,
    SUBSCRIPTION_STATES.CHURNED_AFTER_TRIAL
]);

/**
 * Which states are a TRIAL-SIDE loss — a merchant who left before ever paying.
 *
 * One member today. It is a list rather than a constant because the page reads
 * `cancellation_rollup.count` off the payload precisely so "a future addition to it lands
 * automatically" (its own comment), and a rollup built from a list can grow where one built from a
 * single field cannot.
 */
const TRIAL_SIDE_LOSS_STATES: readonly string[] = Object.freeze([
    SUBSCRIPTION_STATES.CHURNED_DURING_TRIAL
]);

/**
 * The basis a published trial-to-paid rate was computed on.
 *
 * `DECIDED` is the ONLY basis this endpoint ever publishes a number on: subscriptions still inside
 * their trial are excluded from BOTH sides, because they have not had the chance to convert yet and
 * counting them as failures understates the rate — by exactly the proportion of the cohort that is
 * recent, which is largest on the windows an operator looks at most.
 *
 * `UNAVAILABLE` accompanies a `null` rate. It is not a second kind of number; it is the reason there
 * is not one.
 */
const TRIAL_RATE_BASES = Object.freeze({
    DECIDED: 'decided',
    UNAVAILABLE: 'unavailable'
} as const);

/**
 * How many cohort rows the shop table carries at most.
 *
 * The page does not paginate — it renders `cohortRows` whole and captions the tab with
 * `cohortShops.length` — so a truncation is invisible on screen unless the payload says so. Hence
 * `shops_truncated` beside this, and a warning when it fires.
 */
const TRIAL_COHORT_SHOP_LIMIT = 500;

// ── The monthly trend ───────────────────────────────────────────────────────

/** Months returned when the caller names none. Matches `dateRangeToMonths`' 365-day preset. */
const DEFAULT_TREND_MONTHS = 12;
/** The page's own ceiling (`dateRangeToMonths` clamps to 36), mirrored so the two cannot disagree. */
const MAX_TREND_MONTHS = 36;

/**
 * How recent a cohort has to be for the page to badge it "Aging".
 *
 * ⚠️ THE PAGE HARD-CODES THIS TEST: `is_aging: r.cohort_aged_days < 90`. `null < 90` is TRUE in
 * JavaScript, so a month whose `cohort_aged_days` we failed to publish would be badged as still
 * aging — a claim about the cohort made out of a missing field. `cohort_aged_days` is therefore
 * ALWAYS a number on every month row, measurable or not: it is arithmetic on two dates we always
 * hold, and it says nothing about whether the month's counts exist.
 */
const COHORT_AGING_DAYS = 90;

export = {
    SUBSCRIPTION_STATE_LABELS,
    SUBSCRIPTION_STATE_ORDER,
    CONVERTED_SUBSCRIPTION_STATES,
    TRIAL_SIDE_LOSS_STATES,
    TRIAL_RATE_BASES,
    TRIAL_COHORT_SHOP_LIMIT,
    DEFAULT_TREND_MONTHS,
    MAX_TREND_MONTHS,
    COHORT_AGING_DAYS
};
