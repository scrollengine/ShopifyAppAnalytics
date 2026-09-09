'use strict';

/**
 * ============================================================================
 *  CONVERSION — module barrel
 * ============================================================================
 *
 *  The lifecycle fold: trials, cohorts, retention and churn. Structural rules
 *  for every barrel — deep-path imports inside the folder, every key
 *  enumerated, `export =` never `export default` — are stated once in
 *  IMPLEMENTATION.md §3.13 and asserted by test/exportSurface.test.js.
 *
 *  ── Why the second section is published at all ─────────────────────────────
 *
 *  Everything below `getRevenueChurn` was private until `modules/store` needed
 *  it. The store roster classifies the same subscriptions into the same five
 *  states from the same events: it either reaches this vocabulary and this
 *  fold, or it grows a second one — and then a merchant is CONVERTED on one
 *  page and ON_TRIAL on another, which is the failure this module was extracted
 *  to end.
 *
 *  The published set is PURE ONLY — a resolver, two classifiers and frozen
 *  vocabularies. No service, no repository and no clock crosses this line, so
 *  nothing here can be reached THROUGH in order to do I/O. The store module
 *  fetches its own rows from its own repository and hands them to this fold as
 *  data.
 *
 *  Still private: `repositories/installCohort` (no module reaches another's
 *  data access); `helpers/subscriptionState` (reached through the cohort
 *  resolver, which validates `as_of` once so the state machine cannot throw
 *  mid-fold); `constants/funnelEvent` (the catalog ships ON the response, so no
 *  consumer holds a compile-time copy that could disagree with the picker);
 *  `helpers/funnelMath` and `helpers/trialCohort` (pure, imported by deep path
 *  from tests).
 * ============================================================================
 */

import installCohortService = require('./services/installCohort.service');
import customFunnelService = require('./services/customFunnel.service');
import stageFunnelService = require('./services/stageFunnel.service');
import trialOutcomeService = require('./services/trialOutcome.service');
import trialTrendService = require('./services/trialTrend.service');
import cohortRetentionService = require('./services/cohortRetention.service');
import timeToPaidService = require('./services/timeToPaid.service');
import planMixService = require('./services/planMix.service');
import logoChurnService = require('./services/logoChurn.service');
import revenueChurnService = require('./services/revenueChurn.service');
import chargeCohortResolver = require('./resolvers/chargeCohort.resolver');
import acquisitionChannelHelper = require('./helpers/acquisitionChannel.helper');
import churnDateHelper = require('./helpers/churnDate.helper');
import lifecycleConstants = require('./constants/lifecycle.constants');
import logoChurnConstants = require('./constants/logoChurn.constants');

export = {
    /**
     * The stores that installed in a window, how they arrived, and where they got to.
     *
     * Resolves `status: true` with an empty `items` array rather than refusing when the listing
     * tier is unconfigured or nothing has synced. The install spine comes from the Partner API and
     * is complete without BigQuery; a refusal renders on the page as "No installs recorded for this
     * window — run a Partner sync", which is wrong twice over. The three empty states are separated
     * by `data_state`, `attribution_state` and `warnings[]`.
     */
    getInstallCohort: installCohortService.getInstallCohort,

    /**
     * The step funnel the operator built, plus the trial cohort beneath it, from ONE payload.
     *
     * THE FIRST MIXED-TIER READ IN THE BUILD, and it must not borrow the listing tier's refusal.
     * `bigQueryAnalytics` resolves `status: false` when BigQuery is unconfigured — right for
     * `/api/funnel`, which is entirely GA4, and wrong here, where it would blank Partner steps that
     * are present and correct. This resolves `status: true` with per-tier states in `tiers`, a
     * `count: null` (never `0`) on any step whose tier cannot answer, and the operator-facing
     * reasons in `warnings[]`, which the chart already renders in a Banner.
     */
    getCustomFunnel: customFunnelService.getCustomFunnel,

    /**
     * The FIXED seven-stage end-to-end funnel: listing view → paid.
     *
     *  IT MEASURES NOTHING OF ITS OWN. It is `getCustomFunnel` with the operator's choice replaced
     * by a fixed list of catalog keys, reshaped for a different chart — so "Installed" here and
     * "Installed" in the operator's own funnel, on the same page, are one number from one query. A
     * second stage table with its own labels and its own `$in` lists would be a second vocabulary,
     * and the two charts would disagree with nothing on screen to say which was right.
     *
     * ⚠️ It crosses the GA4/Partner measurement seam TWICE — visitors→shops at the install row, and
     * shops→subscriptions at the trial row — and BOTH headline badges cross a boundary while the
     * chart marks neither. `crosses_measurement_seam`, `rate_definitions` and `warnings[]` are how
     * that reaches the reader; do not drop them to tidy the payload.
     */
    getFunnel: stageFunnelService.getFunnel,

    /**
     * Per-shop trial outcome classification for a window: the cohort, how it resolved, and the rate.
     *
     * ⚠️ CONVERSION IS A DATE COMPARISON, decided upstream by `classifyAsOf` against Shopify's own
     * `charge.billingOn`. A merchant who signed up yesterday on a running trial is NOT converted;
     * counting the subscription EVENT instead marks every trialling shop as converted the moment
     * they sign up, which inflates the rate towards 100% and hides trial abandonment entirely.
     *
     * Resolves `status: true` with a null cohort and a populated `data_state` when nothing has
     * synced — never a refusal, which the page renders as a banner telling the operator to go and
     * check their environment file over data that is simply not there yet.
     */
    getTrialOutcomes: trialOutcomeService.getTrialOutcomes,

    /**
     * The monthly trial-cohort trend: one cohort per calendar month, classified as of today.
     *
     * ⚠️ A MONTH WITH NO MEASURABLE RATE PUBLISHES `null`, NEVER `0`. The page plots it on a
     * `<Line connectNulls={false}>` precisely so an unmeasured month BREAKS THE LINE rather than
     * drawing a 0% conversion point, and its month table tones a rate below 20 as critical — so a
     * manufactured zero is printed in red as a verdict on a number that does not exist.
     */
    getTrialTrend: trialTrendService.getTrialTrend,

    /**
     * Weekly install cohorts against fixed day checkpoints — the retention heatmap.
     *
     *  A COHORT TOO YOUNG TO HAVE REACHED A CHECKPOINT PUBLISHES `null` FOR IT, NEVER `0`. The
     * heatmap grades a cell green→yellow→red by its rate, so a manufactured zero is painted solid red
     * and captioned "0%" — a checkable claim that everyone who installed last week had churned by
     * month three. The publication is an ABSENT checkpoint object rather than an object of nulls,
     * because that is what puts "Cohort not aged enough" in the cell's tooltip.
     *
     * ⚠️ "Still installed" is `modules/store`'s relationship-event fold, reached by deep path so
     * this grid cannot disagree with the Stores page about the same merchant. Every way of getting
     * that fold subtly wrong makes retention read HIGH, which is the flattering direction.
     */
    getCohortRetention: cohortRetentionService.getCohortRetention,

    /**
     * The days-from-install-to-first-paid histogram, and the percentiles beneath it.
     *
     *  A STORE THAT HAS NOT CONVERTED IS NOT "DAY 0" AND NOT IN THE LAST BUCKET. It is EXCLUDED,
     * and the exclusion is counted and named — bucketing it at zero would make the first bar the
     * tallest on the chart and fill it with merchants who never paid, and bucketing it in the tail
     * would drag the median the strip prints as a measurement.
     *
     * ⚠️ One of the three exclusions is OURS rather than the merchant's: a store that reached paid
     * billing on settled-payout evidence with no `charge.billingOn` cannot be dated, so
     * `total_paid_shops` is a FLOOR. It is published on its own line for exactly that reason.
     */
    getTimeToPaid: timeToPaidService.getTimeToPaid,

    /**
     * The plan-mix snapshot — subscriber share, MRR share, and 30-day churn per plan.
     *
     * ⚠️ Membership comes through `modules/revenue`'s `liveSetAsOf` and nothing else, so the
     * subscriber count under this donut cannot disagree with the one behind the MRR figure on the
     * Revenue page or the customer count on the Logo Churn page. The per-plan fold is shared with
     * `getLogoChurn` through `helpers/planMix.helper`, so the two cards cannot file one merchant
     * under two plans.
     *
     *  The historical column is measured in the plans merchants held THEN. Applying today's plan to
     * a 30-days-ago membership set moves an upgrader out of the base they actually left, and both
     * plans then publish a wrong churn rate in opposite directions.
     */
    getPlanMix: planMixService.getPlanMix,

    /**
     * Churn measured in CUSTOMERS, not money: the paying base, what has left it, and the shape.
     *
     * ⚠️ Membership comes through `modules/revenue`'s `liveSetAsOf` and nothing else, so this page
     * cannot disagree with the Revenue page about who is paying. The as-of window is load-bearing:
     * calendar-month membership would falsely churn ~1/12 of the base every month, because a 30-day
     * biller skips one calendar month a year.
     */
    getLogoChurn: logoChurnService.getLogoChurn,

    /**
     * Churn measured in MONEY: MRR movement per month, and the merchants behind each figure.
     *
     * ⚠️ The other half of the split above. Logo Churn counts the merchants and publishes no amount;
     * this prices them and publishes little else. Both are folded from the SAME `liveSetAsOf`
     * membership and date an exit through the SAME `helpers/churnDate.helper`, so the two pages
     * cannot disagree about who left or when — only about what the loss was worth.
     *
     *  NET CHURN IS NOT CLAMPED AT ZERO. When a month's existing customers expand by more than it
     * lost, the rate is NEGATIVE, and that is the single best signal a subscription business has.
     * Flooring it hides exactly the months worth celebrating.
     *
     *  The tiles and the waterfall describe the LAST COMPLETE MONTH, never the month in progress —
     * `summary.last_complete_month` names it, and the page picks the same row.
     */
    getRevenueChurn: revenueChurnService.getRevenueChurn,

    // ── The lifecycle fold, for the modules that render the same stores ─────────────────────
    //
    // See the second section of the file header for why these are published at all.

    /**
     * Raw subscription-charge event rows → one subscription per charge → one winner per store.
     *
     * ⚠️ THE CALLER OWNS THE FETCH, and two properties of it are load-bearing. The pull must be
     * bounded ABOVE at the same `as_of` this is given (a future event would classify a past row),
     * and it must carry NO LOWER BOUND (a store may have subscribed at any point before the window
     * being reported on; cutting the scan reports a paying customer as never having subscribed).
     * `CHARGE_COHORT_EVENT_TYPES` below is the `$in` list that pull needs.
     */
    resolveChargeCohortForDomains: chargeCohortResolver.resolveChargeCohortForDomains,

    /**
     * One listing-attribution row → one of the eight channels. Surface beats referrer, and an
     * unexplained source resolves to `UNKNOWN`, NEVER to `DIRECT`.
     *
     * Pass `null` for a store with no attribution record at all: it answers `UNKNOWN`, which is
     * what makes "we have no evidence" impossible to spell as "they arrived directly".
     */
    classifyAcquisitionChannel: acquisitionChannelHelper.classifyAcquisitionChannel,
    /** The on-screen label for a channel, so every table builds its badge from one table. */
    acquisitionChannelLabel: acquisitionChannelHelper.acquisitionChannelLabel,

    /**
     * When a shop's paying relationship ended, and which evidence says so. PURE.
     *
     *  PUBLISHED SO THERE CANNOT BE A SECOND ONE. Three pages name the same merchants leaving:
     * Logo Churn COUNTS them, Revenue Churn PRICES them, and the Revenue page's movement panel
     * lists them with a "Stopped on" date. A second derivation would put two different churn dates
     * on one merchant on two pages — and neither page would look wrong on its own, which is how
     * that class of bug survives review. The helper's own header makes the same argument; this key
     * is what makes obeying it possible from outside the module.
     *
     * The alternative a caller falls back to without this — publishing `churn_date: null` — is not
     * neutral either: it renders an em dash on every row of a column whose whole purpose is the date.
     */
    resolveChurnDate: churnDateHelper.resolveChurnDate,
    /**
     * Which evidence dated a churn: `partner_event` (a real cancel/uninstall/deactivate event) or
     * `ledger_window` (no such event reached us, so the instant the last settled charge aged out).
     *
     * ⚠️ Publish it BESIDE the date, never instead of it. The two bases are not equally strong: one
     * is Shopify telling us, the other is an inference from silence, and a reader who cannot tell
     * them apart will read a window expiry as a cancellation the merchant made.
     */
    CHURN_DATE_BASES: logoChurnConstants.CHURN_DATE_BASES,

    /** The five lifecycle states. A store row's `state` is one of these or nothing. */
    STORE_LIFECYCLE_STATES: lifecycleConstants.STORE_LIFECYCLE_STATES,
    /** Their labels, word for word with the frontend's own map. Publish this ON the response. */
    STORE_LIFECYCLE_LABELS: lifecycleConstants.STORE_LIFECYCLE_LABELS,
    /** The five in journey order — the order a `by_state` tally must enumerate, zeros included. */
    STORE_LIFECYCLE_STATE_ORDER: lifecycleConstants.STORE_LIFECYCLE_STATE_ORDER,
    /** Which EVIDENCE produced a subscription's state. ⚠️ Warn on `inferred`; it is the one guess. */
    STATE_BASIS: lifecycleConstants.STATE_BASIS,
    /** The `state_basis` of a store with no subscription at all. Never a `STATE_BASIS` member. */
    JOIN_MISS_STATE_BASIS: lifecycleConstants.JOIN_MISS_STATE_BASIS,
    /** Where a rendered `trial_end` came from. There is no "assumed default" member, on purpose. */
    TRIAL_DAYS_SOURCES: lifecycleConstants.TRIAL_DAYS_SOURCES,
    /** The `$in` list the cohort's event pull needs: every subscription START and END type. */
    CHARGE_COHORT_EVENT_TYPES: lifecycleConstants.CHARGE_COHORT_EVENT_TYPES
};
