'use strict';

/**
 * ============================================================================
 *  THE STEP FUNNEL THE OPERATOR BUILT, ACROSS TWO TIERS THAT FAIL SEPARATELY
 * ============================================================================
 *
 *  Serves `GET /api/conversion/custom-funnel` — the bar chart on the Funnel page and the
 *  trial block beneath it, both from THIS payload. There is no second call.
 *
 *  ── THIS IS THE FIRST MIXED-TIER READ IN THE BUILD ───────────────────────
 *
 *  `bigQueryAnalytics.service.ts` resolves `status: false` when BigQuery is unconfigured. That is
 *  RIGHT for `/api/funnel`, which is entirely GA4 — there is genuinely no answer. It is WRONG here,
 *  and copying it would be the easiest mistake in this file: a self-hoster who has connected the
 *  Partner API and never intends to connect BigQuery would get a blank chart and a message about
 *  `GCP_PROJECT_ID`, while `installed`, `trial_started` and `trial_converted` sat in the database,
 *  correct and unread.
 *
 *  So: `status: true`, ALWAYS, except for the four things that are not about data at all — no
 *  `user_id`, no `partner_app_id`, no such app, or a query that threw. Which tiers can answer is
 *  published in `tiers`, per step in `available` / `unknown_reason`, and in `warnings[]`, which the
 *  chart already renders verbatim in a Banner. That last part is the whole trick: honouring
 *  `IMPLEMENTATION.md` §4.5 here costs ZERO frontend changes.
 *
 *  ── A STEP THAT CANNOT BE MEASURED IS `null`, NEVER `0` ──────────────────
 *
 *  `0` is a measurement — "nobody did this". `null` is "the tier behind this step has nothing to
 *  answer with". The chart renders them differently on purpose (`funnelScale.js:47` leaves the axis
 *  alone, `_fmtNum(null)` prints an em dash), so a null step is a visibly absent bar rather than a
 *  claimed zero. And any rate touching a null is `null` with `rate_basis: 'unavailable'` — never a
 *  percentage computed against a number nobody has.
 *
 *  ── THE DISCRIMINATOR IS THE WATERMARK, NEVER THE ROW COUNT ──────────────
 *
 *  No rows plus `last_synced_at` is a real, publishable "nobody installed in this window". No rows
 *  and no watermark is "we have not looked yet". Those must never render alike, and a row count
 *  cannot tell them apart.
 *
 *  ── TWO KEYS THIS PAYLOAD MUST NOT CARRY CARELESSLY ──────────────────────
 *
 *  `frontend/components/growth-intel/dataState.js` treats `data.data_state === 'NEVER_SYNCED'` or
 *  `data.items === null` as "null the whole payload and draw a banner instead". There is no `items`
 *  key here at all, and `data_state` is set ONLY when NO tier is READY — the one case where nothing
 *  can be measured and the banner is the honest rendering. Setting it whenever the listing tier is
 *  cold would throw away a perfectly good Partner funnel.
 *
 *  ── ORDER IS THE USER'S, AND IT IS PERSISTED ────────────────────────────────
 *
 *  Steps come back in the order requested. The page writes `steps.map(s => s.key)` straight into
 *  `localStorage['gi.funnel.stepEvents']`, so re-ordering server-side does not merely display
 *  something else — it REWRITES the funnel the operator saved, permanently, with nothing on screen
 *  to undo it from. Same reason every dropped key is named in `warnings[]` rather than swallowed.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import dateRangeHelper = require('../../shared/helpers/dateRange.helper');
import bigQueryModule = require('../../bigquery');
import funnelEventConstants = require('../constants/funnelEvent.constants');
import funnelMathHelper = require('../helpers/funnelMath.helper');
import trialCohortHelper = require('../helpers/trialCohort.helper');
import chargeCohortResolver = require('../resolvers/chargeCohort.resolver');
import customFunnelRepository = require('../repositories/customFunnel.repository');
import installCohortRepository = require('../repositories/installCohort.repository');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { ResolvedDateRange } from '../../shared/types/dateRange.types';
import type { ChargeCohortResult } from '../types/lifecycle.types';
import type {
    CustomFunnelDiagnostics,
    CustomFunnelParams,
    CustomFunnelResponse,
    CustomFunnelStep,
    FunnelCatalogEntry,
    FunnelTier,
    FunnelTierState,
    TrialCohortBlock,
    TrialCohortFold
} from '../types/customFunnel.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { resolveDateRange } = dateRangeHelper;
const { resolveBigQueryAvailability, aggregateListingFunnelTotals } = bigQueryModule;
const { rate, dropRate, countShopsForTypes, resolveRequestedEvents } = funnelMathHelper;
const { foldTrialCohort } = trialCohortHelper;
const { resolveChargeCohortForDomains, describeChargeCohortExposure } = chargeCohortResolver;
const {
    aggregatePartnerShopSets,
    aggregateTransactionShopSets,
    countFirstTransactionShops,
    findChargeCohortEvents,
    aggregateSettledSubscriptionEvidence
} = customFunnelRepository;
// ⚠️ The module's ONE app read, deliberately not duplicated here. It already projects exactly the
// watermarks and coverage gates this endpoint needs; a second `findById(…).lean()` in the same
// module is a second projection to keep in step with this one.
const { findPartnerAppById } = installCohortRepository;
const {
    FUNNEL_EVENT_SOURCES,
    FUNNEL_RATE_BASES,
    FUNNEL_TIERS,
    FUNNEL_TIER_STATES,
    FUNNEL_SOURCE_TIERS,
    FUNNEL_EVENT_CATALOG,
    FUNNEL_EVENT_BY_KEY,
    FUNNEL_EVENT_KEYS,
    FUNNEL_POPULATION_LABELS,
    DEFAULT_FUNNEL_EVENT_KEYS,
    DEFAULT_FUNNEL_EVENT_KEYS_PARTNER_ONLY,
    MAX_FUNNEL_EVENTS,
    MIN_FUNNEL_EVENTS
} = funnelEventConstants;

/**
 *  THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * `PartnerFunnelChart.js:526` renders one `<p>` per warning KEYED BY THE STRING ITSELF. Two
 * identical strings are a duplicate React key and one of them is silently dropped — so a second
 * copy of a message does not double up, it DISAPPEARS, and takes its condition with it. Keeping
 * them together is what makes that checkable by eye.
 *
 * Each is written for an operator who cannot see this code: what is missing, what it does to the
 * numbers above it, and what would fix it.
 */
const _WARNINGS = Object.freeze({
    partnerNeverSynced: 'No Partner sync has completed for this app yet, so no install, subscription or '
        + 'payout events have been fetched. Every Partner-sourced step below is shown as unknown rather '
        + 'than zero — we have not looked, which is not the same as nobody having installed.',

    /** ⚠️ Carries the availability message verbatim, so the operator reads the variable names. */
    listingNotConnected: (message: string): string => `${message} Listing-analytics steps (app store `
        + 'views, add-app clicks, consent) are therefore shown as unknown rather than zero, and any '
        + 'conversion rate that touches one is left blank. The Partner API steps below are unaffected.',

    listingNeverSynced: 'Listing analytics is configured, but no BigQuery sync has completed for this app '
        + 'yet. Listing-analytics steps are shown as unknown rather than zero; run the BigQuery sync to '
        + 'fill them in. The Partner API steps below are unaffected.',

    /**
     * THE CLAMP IS A GUARD, NOT A REPAIR, AND THIS STRING USED TO CLAIM OTHERWISE.
     *
     * The overstatement is real: `until` is end-of-today, Partner events for today exist, and the
     * GA4 daily rollup does not — so "Last 30 days" compares ~28 GA4 days against 30 event days and
     * every GA4→Partner rate reads high. But `min(until, last_bq_synced_at)` does not remove it. The
     * rollup stores one row per UTC MIDNIGHT (`modules/bigquery/helpers/bigQueryRow.helper.ts`) and
     * no sync can write a row dated after the sync that wrote it, so the bound excludes essentially
     * nothing in any realistic case. The earlier wording — "without this clamp every listing-to-
     * install rate would read high" — therefore told the operator the arithmetic had been corrected
     * when only the upper bound had been guarded, which is worse than saying nothing: it retires a
     * question the reader would otherwise still be asking. The residual is stated instead, with its
     * direction.
     */
    ga4Clamped: (watermarkIso: string, untilIso: string): string => 'Listing-analytics steps are counted '
        + `only up to ${watermarkIso}, the last completed BigQuery sync, while Partner API steps run to `
        + `${untilIso}. That bound is a guard rather than a repair — the rollup holds one row per UTC `
        + 'day and no sync writes a day later than itself, so it removes almost nothing. The gap that '
        + 'remains is the export lag: the most recent day or two of this window usually hold no listing '
        + 'rows at all while Partner events for those days are present. The two halves cover different '
        + 'spans, so every listing-to-install rate below reads HIGH by roughly that fraction. Running '
        + 'the BigQuery sync shortens the gap; nothing in the stored data can close it.',

    /**
     * The watermark is BEHIND the window, so no rollup day can exist inside it at all.
     *
     * Left to the ordinary clamp this built an INVERTED date range (`$gte: 2026-08-01,
     * $lte: 2026-06-01`), matched nothing, and reported `ga4NoRollupRows` — which says the rollup
     * "holds no day at all inside this window" when the days may well exist and were clamped away.
     * Right outcome, wrong reason, and the wrong reason is the one an operator would act on.
     */
    ga4WatermarkBeforeWindow: (watermarkIso: string, sinceIso: string): string => 'Listing analytics has '
        + `only synced up to ${watermarkIso}, which is before this window opens (${sinceIso}). No day `
        + 'inside this window has been synced yet, so listing-analytics steps are shown as unknown '
        + 'rather than zero and the rollup was not queried at all. Run the BigQuery sync, then read '
        + 'this window again.',

    ga4NoRollupRows: 'The listing rollup holds no day at all inside this window, so listing-analytics '
        + 'steps are shown as unknown rather than zero. That is a gap in the rollup, not a measurement '
        + 'of nobody visiting — a synced window with genuinely no traffic stores rows of zeros.',

    partnerOnlyDefault: 'Listing analytics is not available, so this funnel opens on Partner API steps '
        + 'instead of the usual listing-views-first default. Add a listing step from the picker to see '
        + 'it as unknown; nothing has been hidden.',

    unknownEventKeys: (keys: readonly string[]): string => `The funnel step(s) ${keys.join(', ')} are not `
        + 'in this build’s event catalog and have been dropped. Your saved step order is rewritten by '
        + 'the page from whatever comes back, so re-pick the steps you want from the picker rather than '
        + 'expecting them to reappear. Valid keys: '
        + `${FUNNEL_EVENT_KEYS.join(', ')}.`,

    duplicateEventKeys: (keys: readonly string[]): string => `The funnel step(s) ${keys.join(', ')} were `
        + 'requested more than once and have been collapsed to one each. A funnel cannot contain the same '
        + 'step twice: the chart keys its bars by step name, so the repeat would be dropped during '
        + 'rendering rather than drawn.',

    droppedOverCap: (keys: readonly string[], max: number): string => `This funnel asked for more than `
        + `${max} steps; ${keys.join(', ')} were dropped from the end. Remove a step before adding `
        + 'another, or the choice of which to drop is made for you.',

    tooFewSteps: (count: number): string => `A funnel needs at least ${MIN_FUNNEL_EVENTS} steps to mean `
        + `anything and this one has ${count}. There is no conversion to compute between fewer, and the `
        + 'chart cannot draw a comparison from a single bar.',

    /**
     * The seam the chart CANNOT mark. `unit` has two members and the chart narrates one of them,
     * so a boundary from stores to subscriptions — `installed → trial_started`, which is in the
     * DEFAULT funnel — draws as an ordinary step conversion with a plain grey chip. A store with two
     * subscriptions is 1 on the left and 2 on the right, and the rate can legitimately exceed 100%.
     *
     * FIRED EVEN WHEN THE UNIT CHANGES TOO, which it did not used to be. The suppression looked
     * tidy — one seam, one marker — but the `*` the chart draws for a unit change is captioned
     * "Partner API steps are distinct shops" (`PartnerFunnelChart.js:417-427`, `:463-470`), and on
     * `install_clicks → trial_started` the right-hand step counts SUBSCRIPTIONS. The one marker the
     * reader got therefore named the wrong population, and the sentence that would have corrected it
     * was the one being suppressed. Each boundary names both populations for the same reason.
     */
    populationSeam: (boundaries: readonly string[]): string => `${boundaries.join('; ')}. Those steps `
        + 'count different things, so the percentage between them is directional rather than a '
        + 'per-entity conversion: one thing on the left can produce several on the right, or none. A '
        + 'store with two subscriptions contributes twice on one side and once on the other, and a rate '
        + 'above 100% across such a boundary is arithmetic rather than an error.',

    dropRateSuppressed: (labels: readonly string[]): string => `The step(s) ${labels.join(', ')} converted `
        + 'at more than 100%, so their drop-off is published as unknown rather than as a negative '
        + 'percentage. That is expected where a step crosses the listing/Partner measurement seam, or '
        + 'where its denominator excludes subscriptions still inside their trial.',

    testSubscriptionsExcluded: (subscriptions: number): string => `${subscriptions} test subscription(s) `
        + 'were excluded from the subscription steps and the trial figures. Partner install and uninstall '
        + 'events carry no test flag at all, so those stores are still counted in the Partner steps above '
        + '— the two halves of this funnel are asymmetric and no available data can reconcile them.',

    shoplessPartnerEvents: (events: number): string => `${events} Partner event(s) in this window carried `
        + 'no shop domain and could not be attributed to a store. They are excluded from every Partner '
        + 'step below, so those counts are floors rather than totals.',

    skippedKeylessSubscriptionEvents: (events: number): string => `${events} subscription event(s) carried `
        + 'neither a charge id nor a shop domain and were skipped rather than pooled. Pooling them would '
        + 'have invented one merged subscription out of many.',

    inferredStates: (subscriptions: number): string => `${subscriptions} subscription(s) are counted as `
        + 'still in trial on the weakest evidence available: Shopify supplied no billing date for them and '
        + 'no payout has settled against them yet. That is the reading which claims no revenue and no '
        + 'loss, not a measured trial.',

    windowKpiFloor: (unresolved: number): string => `${unresolved} subscription(s) carry no billing date `
        + 'from Shopify, so they cannot be dated to a window. "Conversions this period" counts only the '
        + 'ones that can, and is therefore a floor rather than a total.',

    lifetimeFloor: 'No lifetime Partner sync has ever completed for this app, so every all-time figure here '
        + 'is a FLOOR rather than a total — there may be older events that have never been fetched.',

    /**
     * The MONEY-SIDE floor, tracked separately from the events' one on purpose.
     *
     * `models/partner/partnerApp.model.ts:122` says it outright: collapsing `earliest_transaction_at`
     * into `earliest_event_at` "would let a revenue figure borrow the events' coverage". Payouts
     * settle later than the charge events that earned them and a lifetime sync of one can succeed
     * while the other fails, so the event floor says nothing whatever about the payout floor.
     */
    transactionsBeforeFloor: (earliest: string | null): string => earliest === null
        ? 'No payout coverage floor has ever been measured for this app, so nothing here can say how far '
            + 'back the stored payout history actually reaches. Every payout step below is a floor rather '
            + 'than a total.'
        : `The stored payout history for this app begins at ${earliest} and this window opens before it. `
            + 'Payouts earlier than that date were never fetched and cannot appear here, so the payout '
            + 'steps for the earlier part of this window are floors rather than totals.',

    /**
     * THE ONE COVERAGE FAILURE ON THIS ENDPOINT THAT RUNS UPWARD.
     *
     * Every other floor here makes a number too SMALL, which reads as a quiet period. This one makes
     * it too LARGE. `countFirstTransactionShops` takes `$min(created_at)` over STORED history and
     * only then tests the window — correct pipeline ordering, and what makes the answer "first ever"
     * rather than "transacted here". But "first ever" is a claim about the world, and it holds only
     * while the stored history reaches back far enough. On a deployment that has only run INCREMENTAL
     * Partner syncs, every long-standing payer's earliest STORED payout sits at the start of what was
     * pulled — so the bar can approach the entire paying base while presenting as a measured
     * new-customer count. Nothing warned; `_coverageWarnings` reads the event gates and never this one.
     */
    firstTransactionFloor: (reason: string): string => '"First Payout Received" counts the stores whose '
        + 'EARLIEST STORED payout falls inside this window, and that only means "first ever" if the '
        + `stored payout history reaches back far enough. ${reason} A store that first paid before the `
        + 'stored history begins has its earliest STORED payout counted instead, so long-standing '
        + 'customers are reported as new ones. This error runs UPWARD: in the limit the bar approaches '
        + 'the entire paying base while presenting as a measured new-customer count. Run a lifetime '
        + 'Partner sync, then read it again.',

    /**
     * ⚠️ Fires on the app-level measurement, which records the WIDEST gap in the whole event history
     * and NOT where it sits — so the window cannot be tested against it and the wording must stay
     * conditional. `null` is "never measured" and `0` is a real, reassuring "no day-wide hole";
     * neither warns.
     */
    eventHistoryGap: (days: number): string => 'The Partner event history for this app contains a stretch '
        + `of ${days} day(s) carrying no events at all. If that stretch falls inside this window, every `
        + 'Partner-sourced step below is a floor rather than a total. The data cannot say whether it was a '
        + 'genuinely quiet period or a sync window that failed and was never re-pulled, which is why it is '
        + 'published here rather than resolved.',

    beforeEarliestEvent: (earliest: string): string => 'The window starts before the earliest Partner event '
        + `on record (${earliest}). Events before that date were never fetched and cannot appear here, so `
        + 'the Partner steps for the earlier part of this window are floors.'
});

/** Reasons published on a STEP, as `unknown_reason`. Short — the long form is in `warnings[]`. */
const _STEP_REASONS = Object.freeze({
    listingNotConnected: (message: string): string => `Listing analytics is not connected, so this step `
        + `cannot be measured. ${message}`,
    listingNeverSynced: 'Listing analytics is connected but has never completed a sync, so this step has '
        + 'never been measured.',
    listingNoRows: 'Listing analytics has synced, but holds no day inside this window, so this step has no '
        + 'measurement for it.',
    /** ⚠️ Distinct from `listingNoRows`: the days may well exist, they are simply not synced yet. */
    listingBehindWindow: 'Listing analytics has not synced up to the start of this window, so no day '
        + 'inside it can have been rolled up yet and this step has no measurement for it.',
    partnerNeverSynced: 'No Partner sync has completed for this app, so this step has never been measured.',
    /** A build defect, said out loud rather than published as a zero. */
    unmappedField: (field: string): string => `This build asked the listing rollup for a field it does not `
        + `carry ("${field}"). That is a defect in this build, not a fact about your listing — please `
        + 'report it.',
    /**
     * The subscription twin of `unmappedField`, and the reason it exists.
     *
     * This branch used to answer `partnerNeverSynced` — a sentence about the operator's sync state
     * for what could only ever be a CATALOG DEFECT in this build. Unreachable today (every
     * subscription entry carries a metric, and a cold Partner tier short-circuits before this), and
     * still worth spelling correctly: the one thing an unreachable branch must not do is send the
     * reader to check something that was never wrong.
     */
    unmappedMetric: (key: string): string => `This build's catalog entry for "${key}" names no cohort `
        + 'metric, so there is nothing for it to count. That is a defect in this build, not a fact '
        + 'about your subscriptions — please report it.'
});

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
 * The `date` predicate for the listing rollup read.
 *
 * ⚠️ The upper bound is the CLAMPED one, not the window's — see `_resolveGa4Until`.
 *
 * @param since - Window start, or null for lifetime.
 * @param until - The clamped upper bound.
 * @returns The `date_match` fragment the rollup read takes.
 */
const _ga4DateMatch = (since: Date | null, until: Date): { date: { $gte?: Date; $lte?: Date } } => {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (since) {
        range.$gte = since;
    }
    range.$lte = until;
    return { date: range };
};

/**
 * Which coverage gates on the app row make this window's Partner figures a floor rather than a total.
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
 * The MONEY-side coverage gates — the ones `_coverageWarnings` above deliberately does not read.
 *
 * THIS FUNCTION EXISTS BECAUSE `first_transaction` HAD NO GATE AT ALL, AND IT IS THE ONE FIGURE
 * ON THIS ENDPOINT WHOSE COVERAGE FAILURE RUNS UPWARD.
 *
 * `_coverageWarnings` reads `earliest_event_at`, `event_history_gap_days` and (for a lifetime window
 * only) `lifetime_sync_completed_at`. None of those says anything about payouts:
 * `partnerApp.model.ts:122` records that collapsing `earliest_transaction_at` into the events' floor
 * "would let a revenue figure borrow the events' coverage", and it is right — payouts settle later
 * than the charge events that earned them, and a lifetime sync of one can succeed while the other
 * fails. So an app with a complete event history and three weeks of stored payouts passed every gate
 * here while reporting its whole paying base as first-timers, with `warnings` empty.
 *
 * ⚠️ The `lifetimeFloor` warning is additionally gated on `win.isLifetime`, so a PRESET window — the
 * default, and the one an operator actually looks at — received no floor caveat of any kind. These
 * gates are not window-gated for that reason.
 *
 * @param app - The app row, carrying the coverage gates the sync writes.
 * @param win - The resolved window.
 * @param wants - Which transaction-sourced steps the selection actually asked for.
 * @param wants.first_transaction - A `first_ever` step is in the funnel.
 * @param wants.windowed_transaction - A windowed payout step (`usage_billed`, `one_time_billed`) is.
 * @returns Zero or more warning strings.
 */
const _transactionCoverageWarnings = (
    app: PartnerAppDoc,
    win: ResolvedDateRange,
    wants: { first_transaction: boolean; windowed_transaction: boolean }
): string[] => {
    const out: string[] = [];
    if (!wants.first_transaction && !wants.windowed_transaction) {
        return out;
    }

    const floor = app.earliest_transaction_at instanceof Date && !Number.isNaN(app.earliest_transaction_at.getTime())
        ? app.earliest_transaction_at
        : null;
    // ⚠️ `null` is NOT YET MEASURED, never "there is no floor". It is the weakest state of the three
    // and must warn on both paths below rather than falling through as if the history were complete.
    const floorIso = floor ? floor.toISOString() : null;

    if (wants.windowed_transaction) {
        // The ordinary, downward floor: rows before the money floor were never fetched, so a window
        // opening before it is measuring a shorter span than it claims.
        const opensBeforeFloor = floor === null || win.since === null || win.since.getTime() < floor.getTime();
        if (opensBeforeFloor) {
            out.push(_WARNINGS.transactionsBeforeFloor(floorIso));
        }
    }

    if (wants.first_transaction) {
        //  Three independent ways the "first ever" claim fails, ALL of them checked: a missing
        // floor (never measured), a floor that sits inside the window (stored history starts inside
        // the very range being measured), and no completed lifetime sync (the stored history is
        // whatever an incremental window happened to pull, whatever the floor says).
        const reasons: string[] = [];
        if (floor === null) {
            reasons.push('No payout coverage floor has ever been measured for this app.');
        } else if (win.since === null || floor.getTime() >= win.since.getTime()) {
            reasons.push(`The stored payout history begins at ${floor.toISOString()}, which is inside this window.`);
        }
        if (!app.lifetime_sync_completed_at) {
            reasons.push('No lifetime Partner sync has ever completed for this app, so the stored payouts are '
                + 'whatever the incremental windows happened to pull.');
        }
        if (reasons.length > 0) {
            out.push(_WARNINGS.firstTransactionFloor(reasons.join(' ')));
        }
    }

    return out;
};

/** One step's measurement, before any rate has been computed against it. */
interface _MeasuredStep {
    entry: FunnelCatalogEntry;
    /** `null` is "no tier could answer", never "zero happened". */
    count: number | null;
    available: boolean;
    unknown_reason: string | null;
}

/**
 * The stores/subscriptions/visitors behind one catalog entry, and why there is no number when there
 * is not one.
 *
 * CALLED EXACTLY ONCE PER STEP. The ported implementation called its equivalent twice per step —
 * once for the bar and once for the rate — which is not merely wasteful: it is two places for the
 * null handling to differ, and the rate's copy is the one nobody looks at.
 *
 * @param entry - The catalog entry to measure.
 * @param inputs - Everything already fetched, plus the reason each tier cannot answer.
 * @returns The count, or null with the sentence that says why.
 */
const _measureStep = (
    entry: FunnelCatalogEntry,
    inputs: {
        tierReasonFor: (tier: FunnelTier) => string | null;
        ga4TotalsByField: Map<string, number> | null;
        ga4Unavailable: string | null;
        partnerShopsByType: Record<string, readonly string[]>;
        transactionShopsByType: Record<string, readonly string[]>;
        firstTransactionShops: number;
        trialCohort: TrialCohortFold | null;
    }
): _MeasuredStep => {
    const tier = FUNNEL_SOURCE_TIERS[entry.source];
    const tierReason = inputs.tierReasonFor(tier);
    if (tierReason) {
        return { entry, count: null, available: false, unknown_reason: tierReason };
    }

    if (entry.source === FUNNEL_EVENT_SOURCES.GA4) {
        //  A READY tier with no rollup row is still an UNKNOWN, not a zero. `$group` emits no
        // document for an empty window, and that absence is the discriminator between "the rollup
        // has no day here" and "these days had no traffic" — a synced day with no traffic stores a
        // row of zeros, which reaches us as a real 0.
        if (!inputs.ga4TotalsByField) {
            return {
                entry,
                count: null,
                available: false,
                unknown_reason: inputs.ga4Unavailable || _STEP_REASONS.listingNoRows
            };
        }
        const field = entry.field || '';
        const value = inputs.ga4TotalsByField.get(field);
        if (value === undefined) {
            // Unreachable while the catalog matches the model, and published as an unknown rather
            // than a 0 precisely because a 0 here would be a fabricated fact about the listing.
            return { entry, count: null, available: false, unknown_reason: _STEP_REASONS.unmappedField(field) };
        }
        return { entry, count: value, available: true, unknown_reason: null };
    }

    if (entry.source === FUNNEL_EVENT_SOURCES.PARTNER) {
        //  UNION of the shop sets, never the sum of per-type counts. See `countShopsForTypes`.
        return {
            entry,
            count: countShopsForTypes(inputs.partnerShopsByType, entry.event_types),
            available: true,
            unknown_reason: null
        };
    }

    if (entry.source === FUNNEL_EVENT_SOURCES.SUBSCRIPTION) {
        //  The two reasons are DIFFERENT and were once the same sentence. A missing metric is a
        // defect in this build's catalog; a missing cohort is a Partner tier that has never synced.
        // Telling the operator to run a sync over a catalog bug sends them to fix something that was
        // never broken, which is how an unreachable branch still costs somebody an afternoon.
        if (!entry.metric) {
            return { entry, count: null, available: false, unknown_reason: _STEP_REASONS.unmappedMetric(entry.key) };
        }
        if (!inputs.trialCohort) {
            return { entry, count: null, available: false, unknown_reason: _STEP_REASONS.partnerNeverSynced };
        }
        return {
            entry,
            count: inputs.trialCohort.counts[entry.metric],
            available: true,
            unknown_reason: null
        };
    }

    // transaction
    if (entry.first_ever) {
        return { entry, count: inputs.firstTransactionShops, available: true, unknown_reason: null };
    }
    return {
        entry,
        count: countShopsForTypes(
            inputs.transactionShopsByType,
            entry.transaction_type ? [entry.transaction_type] : []
        ),
        available: true,
        unknown_reason: null
    };
};

/**
 * The funnel the operator built, measured across whichever tiers can answer.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query, already cast (not coerced) by the controller.
 * @param params1.partner_app_id - The app to report on. Required.
 * @param [params1.period_days] - number, 0 or 'all' (default 30).
 * @param [params1.since] - ISO date; honoured only together with `until`.
 * @param [params1.until] - ISO date; honoured only together with `since`.
 * @param [params1.events] - Comma-joined or repeated. ORDER IS SIGNIFICANT.
 * @returns The funnel, or an honest refusal carrying `{}`.
 */
const getCustomFunnel = (
    { user_id }: IdentityObject,
    { partner_app_id, period_days, since, until, events }: CustomFunnelParams
): Promise<ServiceResult<CustomFunnelResponse | EmptyPayload>> => {
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

            // VALIDATED ONCE, HERE. `classifyAsOf` and `resolveChargeCohortForDomains` both THROW
            // on an unusable judgement instant rather than substituting `new Date()` — a pure helper
            // may not read the clock, and a substituted "now" would make a historical window answer
            // as of today without saying so.
            const asOf = win.until;
            if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
                return resolve(promiseReturnResult(false, {}, {}, 'Could not resolve a valid window for this request. Check `since`, `until` and `period_days`.'));
            }

            const appId = String(app._id);
            const warnings: string[] = [];

            // ── The two tiers, each read from a WATERMARK ─────────────────────
            const availability = resolveBigQueryAvailability();
            let listingState: FunnelTierState = FUNNEL_TIER_STATES.READY;
            let listingReason: string | null = null;
            if (!availability.enabled) {
                listingState = FUNNEL_TIER_STATES.NOT_CONNECTED;
                listingReason = _STEP_REASONS.listingNotConnected(availability.message);
            } else if (!app.last_bq_synced_at) {
                listingState = FUNNEL_TIER_STATES.NEVER_SYNCED;
                listingReason = _STEP_REASONS.listingNeverSynced;
            }

            let partnerState: FunnelTierState = FUNNEL_TIER_STATES.READY;
            let partnerReason: string | null = null;
            if (!app.last_synced_at) {
                partnerState = FUNNEL_TIER_STATES.NEVER_SYNCED;
                partnerReason = _STEP_REASONS.partnerNeverSynced;
            }

            const tierReasonFor = (tier: FunnelTier): string | null => {
                return tier === FUNNEL_TIERS.LISTING ? listingReason : partnerReason;
            };

            // ── What was actually asked for ───────────────────────────────────
            // THE TIER-AWARE DEFAULT. Falling back to Partner-only steps matters because the
            // usual default opens on `views` — which is null when the listing tier is cold, and a
            // null FIRST step nulls every cumulative rate and the headline behind it. Technically
            // honest, practically an empty chart, on a deployment that is working perfectly.
            //
            // ⚠️ It applies to the DEFAULT ONLY. A caller that explicitly asked for a GA4 step gets
            // it back as null with a reason: silently dropping a step the operator chose changes the
            // funnel they built and moves the denominator of every cumulative rate without saying so.
            const listingReady = listingState === FUNNEL_TIER_STATES.READY;
            const fallbackKeys = listingReady ? DEFAULT_FUNNEL_EVENT_KEYS : DEFAULT_FUNNEL_EVENT_KEYS_PARTNER_ONLY;
            const selection = resolveRequestedEvents({
                requested: events,
                fallback_keys: fallbackKeys,
                max: MAX_FUNNEL_EVENTS
            });

            const entries: FunnelCatalogEntry[] = [];
            // Keys that survived selection and STILL have no usable catalog entry. Empty in
            // practice now that the index is null-prototype and `resolveRequestedEvents` tests
            // `Object.hasOwn` — and kept precisely because it once was not. `FUNNEL_EVENT_BY_KEY`
            // inherited `Object.prototype`, so `?events=installed,toString,valueOf` pushed
            // `Object.prototype.toString` in here AS A CATALOG ENTRY. It fell through every
            // `entry.source` test in `_measureStep` to the unlabelled `// transaction` default,
            // which minted `count: 0, available: true` for a step with no `key`, no `label` and no
            // `unit` — and a headline `conversion_rate` of `0` reading "0.00%" under the words
            // "Conversion rate". Three guards now stand between that input and this array, and this
            // is the last of them, because the failure was silent at every layer.
            const shapelessKeys: string[] = [];
            for (const key of selection.keys) {
                const entry = Object.hasOwn(FUNNEL_EVENT_BY_KEY, key) ? FUNNEL_EVENT_BY_KEY[key] : undefined;
                // ⚠️ `entry.key` as well as `entry`: an entry object that carries no key cannot be
                // drawn (`steps[].key ⊆ catalog[].key` is what the picker's ↑/↓ buttons index on)
                // and cannot be labelled, so it is a rejected key and not a step.
                if (entry && entry.key) {
                    entries.push(entry);
                } else {
                    shapelessKeys.push(key);
                }
            }
            //  Folded into ONE list so the operator reads one sentence naming every key that did
            // not become a step, rather than two competing ones — and so `diagnostics` and
            // `warnings[]` cannot disagree about what was refused.
            const unknownKeys = [...new Set([...selection.unknown, ...shapelessKeys])];

            // ── Only the reads the selection actually needs ───────────────────
            const partnerReady = partnerState === FUNNEL_TIER_STATES.READY;
            const eventTypes = new Set<string>();
            const transactionTypes = new Set<string>();
            let wantsGa4 = false;
            let wantsSubscription = false;
            let wantsFirstTransaction = false;
            for (const entry of entries) {
                if (entry.source === FUNNEL_EVENT_SOURCES.GA4) {
                    wantsGa4 = true;
                } else if (entry.source === FUNNEL_EVENT_SOURCES.PARTNER) {
                    for (const type of entry.event_types || []) {
                        eventTypes.add(type);
                    }
                } else if (entry.source === FUNNEL_EVENT_SOURCES.SUBSCRIPTION) {
                    wantsSubscription = true;
                } else if (entry.first_ever) {
                    wantsFirstTransaction = true;
                } else if (entry.transaction_type) {
                    transactionTypes.add(entry.transaction_type);
                }
            }

            // THE GA4 CLAMP. `until` is end-of-today; Partner events for today exist and the GA4
            // daily rollup does not. Left alone, "Last 30 days" compares ~28 GA4 days against 30
            // event days and every listing-to-install rate reads high — systematically, invisibly,
            // and in the flattering direction.
            let ga4Until: Date | null = null;
            // The watermark sitting BEFORE the window start. The clamp then built an INVERTED
            // range (`$gte: 2026-08-01, $lte: 2026-06-01`), Mongo matched nothing, and the honest
            // `count: null` came back attached to the WRONG sentence — `ga4NoRollupRows` says the
            // rollup "holds no day at all inside this window" when the days may exist and were
            // clamped away. Detected here so the query is never issued and the reason is the real one.
            let ga4BehindWindow = false;
            if (listingReady) {
                ga4Until = win.until;
                const watermark = app.last_bq_synced_at;
                // ⚠️ `since` lifted to a local so the narrowing below survives; `win.since` is a
                // property read and TypeScript re-widens it at every use.
                const since = win.since;
                if (watermark instanceof Date && watermark.getTime() < win.until.getTime()) {
                    ga4Until = watermark;
                    ga4BehindWindow = since !== null && watermark.getTime() < since.getTime();
                    if (wantsGa4) {
                        warnings.push(ga4BehindWindow && since
                            ? _WARNINGS.ga4WatermarkBeforeWindow(watermark.toISOString(), since.toISOString())
                            : _WARNINGS.ga4Clamped(watermark.toISOString(), win.until.toISOString()));
                    }
                }
            }

            const [ga4Totals, partnerShopSets, transactionShopSets, firstTransactionShops, cohortEvents, settled] =
                await Promise.all([
                    wantsGa4 && ga4Until && !ga4BehindWindow
                        ? aggregateListingFunnelTotals({ partner_app_id: appId, date_match: _ga4DateMatch(win.since, ga4Until) })
                        : Promise.resolve(null),
                    partnerReady && eventTypes.size > 0
                        ? aggregatePartnerShopSets({
                            partner_app_id: appId,
                            event_types: [...eventTypes],
                            since: win.since,
                            until: win.until
                        })
                        : Promise.resolve({ rows: [], shopless_events: 0 }),
                    partnerReady && transactionTypes.size > 0
                        ? aggregateTransactionShopSets({
                            partner_app_id: appId,
                            types: [...transactionTypes],
                            since: win.since,
                            until: win.until
                        })
                        : Promise.resolve([]),
                    partnerReady && wantsFirstTransaction
                        ? countFirstTransactionShops({ partner_app_id: appId, since: win.since, until: win.until })
                        : Promise.resolve(0),
                    partnerReady && wantsSubscription
                        ? findChargeCohortEvents({ partner_app_id: appId, until: asOf })
                        : Promise.resolve([]),
                    partnerReady && wantsSubscription
                        // `as_of` is not optional. Unbounded, a payout that settles after the
                        // window is admitted as evidence inside it, and a subscription with no
                        // `billingOn` is reported as paying before it paid.
                        ? aggregateSettledSubscriptionEvidence({ partner_app_id: appId, as_of: asOf })
                        : Promise.resolve({ charge_ids: [], shop_domains: [] })
                ]);

            const partnerShopsByType: Record<string, readonly string[]> = {};
            for (const row of partnerShopSets.rows) {
                partnerShopsByType[row.event_type] = row.shops;
            }
            const transactionShopsByType: Record<string, readonly string[]> = {};
            for (const row of transactionShopSets) {
                transactionShopsByType[row.type] = row.shops;
            }

            // ⚠️ A `Map` over `Object.entries`, not an index into the row: the totals row is a
            // declared shape with no index signature, and reaching a field by a string key would need
            // a cast — which this codebase confines to `models.repository`. The Map also makes a
            // field the rollup does not carry come back `undefined` rather than `0`.
            let ga4TotalsByField: Map<string, number> | null = null;
            if (ga4Totals) {
                ga4TotalsByField = new Map(Object.entries(ga4Totals).map(([key, value]) => [key, Number(value) || 0]));
            }
            let ga4Unavailable: string | null = null;
            if (listingReady && wantsGa4 && ga4BehindWindow) {
                //  The warning for this case was already pushed above, where the bound was
                // resolved — pushing `ga4NoRollupRows` here as well would put two contradictory
                // explanations of one blank step in the same Banner.
                ga4Unavailable = _STEP_REASONS.listingBehindWindow;
            } else if (listingReady && wantsGa4 && !ga4Totals) {
                ga4Unavailable = _STEP_REASONS.listingNoRows;
                warnings.push(_WARNINGS.ga4NoRollupRows);
            }

            // ── The charge cohort, folded once ────────────────────────────────
            let cohortResult: ChargeCohortResult | null = null;
            let trialFold: TrialCohortFold | null = null;
            if (partnerReady && wantsSubscription) {
                cohortResult = resolveChargeCohortForDomains({
                    events: cohortEvents,
                    as_of: asOf,
                    settled_charge_ids: settled.charge_ids,
                    settled_domains: settled.shop_domains
                });
                trialFold = foldTrialCohort({
                    subscriptions: cohortResult.subscriptions,
                    since: win.since,
                    until: asOf
                });
            }

            // ── Measure every step ONCE ───────────────────────────────────────
            const measured = entries.map((entry) => _measureStep(entry, {
                tierReasonFor,
                ga4TotalsByField,
                ga4Unavailable,
                partnerShopsByType,
                transactionShopsByType,
                firstTransactionShops,
                trialCohort: trialFold
            }));

            // ── Derive the rates from those counts, in one pass ───────────────
            const firstCount = measured.length > 0 ? measured[0].count : null;
            const populationBoundaries: string[] = [];
            const suppressedDropLabels: string[] = [];

            const steps: CustomFunnelStep[] = measured.map((current, index) => {
                const previous = index > 0 ? measured[index - 1] : null;
                const unitChange = previous ? previous.entry.unit !== current.entry.unit : false;
                // NOT SUPPRESSED WHEN THE UNIT ALSO CHANGES, which it used to be. The suppression
                // read as tidiness — one seam, one marker — but the marker the chart draws for a unit
                // change is a `*` captioned "Partner API steps are distinct shops"
                // (`PartnerFunnelChart.js:417-427`, `:463-470`). On `install_clicks → trial_started`
                // the right-hand step counts SUBSCRIPTIONS, so the only marking the reader got named
                // the wrong population, and the sentence that would have corrected it was exactly the
                // one being withheld. Any funnel jumping a listing step straight to a subscription
                // step lost trap 5's marking entirely.
                const populationChange = previous
                    ? previous.entry.population !== current.entry.population
                    : false;
                if (populationChange && previous) {
                    // Both populations NAMED. "A → B" alone leaves the reader to guess which of the
                    // two changed and into what, on the one boundary where the chart's own caption is
                    // actively misleading.
                    populationBoundaries.push(
                        `"${previous.entry.label}" counts ${FUNNEL_POPULATION_LABELS[previous.entry.population]}`
                        + ` while "${current.entry.label}" counts ${FUNNEL_POPULATION_LABELS[current.entry.population]}`
                    );
                }

                let conversionPct: number | null = null;
                let rateBasis: CustomFunnelStep['rate_basis'] = null;
                let rateDenominator: number | null = null;
                let undecided: number | null = null;

                if (previous) {
                    // The decided basis excludes subscriptions still inside their trial from BOTH
                    // sides. `PartnerFunnelChart.js:406` tests `rate_basis === 'decided'` exactly and
                    // rewrites its tooltip to say so; without it the chart presents this as a plain
                    // step ratio that happens not to add up.
                    // ⚠️ The FOLD itself, not a boolean, so the denominator and the undecided count
                    // below are both read from a value the compiler has proved is there. A boolean
                    // flag would leave `trialFold` un-narrowed and put an `as` in a service.
                    const decidedFold = current.entry.rate_over === FUNNEL_RATE_BASES.DECIDED ? trialFold : null;
                    const denominator = decidedFold ? decidedFold.counts.decided : previous.count;
                    if (current.count === null || denominator === null) {
                        //  Any rate touching an unknown is UNAVAILABLE, not zero and not a
                        // percentage against a number nobody has.
                        rateBasis = FUNNEL_RATE_BASES.UNAVAILABLE;
                    } else {
                        conversionPct = rate(current.count, denominator);
                        rateDenominator = denominator;
                        if (decidedFold) {
                            rateBasis = FUNNEL_RATE_BASES.DECIDED;
                            undecided = decidedFold.counts.still_on_trial;
                        } else {
                            rateBasis = FUNNEL_RATE_BASES.PREVIOUS_STEP;
                        }
                    }
                }

                const dropPct = dropRate(conversionPct);
                if (conversionPct !== null && dropPct === null) {
                    suppressedDropLabels.push(`"${current.entry.label}"`);
                }

                return {
                    key: current.entry.key,
                    label: current.entry.label,
                    source: current.entry.source,
                    unit: current.entry.unit,
                    population: current.entry.population,
                    count: current.count,
                    conversion_pct: conversionPct,
                    drop_pct: dropPct,
                    // Against the FIRST step. Step 0 measures against itself, which is 1 for any
                    // positive count and null for an unknown or empty one — the same rule, applied
                    // uniformly, rather than a special case that could disagree with it.
                    cumulative_conversion_pct: current.count === null || firstCount === null
                        ? null
                        : rate(current.count, firstCount),
                    unit_change: unitChange,
                    population_change: populationChange,
                    rate_basis: rateBasis,
                    rate_denominator: rateDenominator,
                    undecided,
                    available: current.available,
                    unknown_reason: current.unknown_reason
                };
            });

            // ── Everything that was refused or excluded, said out loud ────────
            if (partnerState === FUNNEL_TIER_STATES.NEVER_SYNCED) {
                warnings.push(_WARNINGS.partnerNeverSynced);
            }
            if (wantsGa4 && listingState === FUNNEL_TIER_STATES.NOT_CONNECTED) {
                warnings.push(_WARNINGS.listingNotConnected(availability.message));
            }
            if (wantsGa4 && listingState === FUNNEL_TIER_STATES.NEVER_SYNCED) {
                warnings.push(_WARNINGS.listingNeverSynced);
            }
            // Only when the fallback ACTUALLY changed the funnel — a caller that named its own steps
            // is not owed an explanation of a default it never received.
            if (selection.used_fallback && !listingReady) {
                warnings.push(_WARNINGS.partnerOnlyDefault);
            }
            if (unknownKeys.length > 0) {
                warnings.push(_WARNINGS.unknownEventKeys(unknownKeys));
            }
            if (selection.duplicates.length > 0) {
                warnings.push(_WARNINGS.duplicateEventKeys(selection.duplicates));
            }
            if (selection.dropped_over_cap.length > 0) {
                warnings.push(_WARNINGS.droppedOverCap(selection.dropped_over_cap, MAX_FUNNEL_EVENTS));
            }
            if (steps.length < MIN_FUNNEL_EVENTS) {
                warnings.push(_WARNINGS.tooFewSteps(steps.length));
            }
            if (populationBoundaries.length > 0) {
                warnings.push(_WARNINGS.populationSeam(populationBoundaries));
            }
            if (suppressedDropLabels.length > 0) {
                warnings.push(_WARNINGS.dropRateSuppressed(suppressedDropLabels));
            }
            if (partnerShopSets.shopless_events > 0) {
                warnings.push(_WARNINGS.shoplessPartnerEvents(partnerShopSets.shopless_events));
            }
            if (cohortResult) {
                const d = cohortResult.diagnostics;
                if (d.test_subscriptions_excluded > 0) {
                    warnings.push(_WARNINGS.testSubscriptionsExcluded(d.test_subscriptions_excluded));
                }
                if (d.skipped_keyless > 0) {
                    warnings.push(_WARNINGS.skippedKeylessSubscriptionEvents(d.skipped_keyless));
                }
                // ⚠️ THE APP-WIDE TRIPLE HERE, DELIBERATELY — not the cohort-scoped one published in
                // `diagnostics.charge_link`. The two describe different populations because the
                // figures they caption do: `converted_in_window` scans EVERY subscription the app has
                // (a trial that started before the window may convert inside it), so the count of
                // subscriptions that cannot be dated at all must be app-wide too. Scoping this to the
                // window cohort to "match" the diagnostics would under-report the floor on exactly the
                // subscriptions the KPI exists to catch.
                const undated = d.charge_link.unresolved + d.charge_link.absent;
                if (undated > 0) {
                    warnings.push(_WARNINGS.windowKpiFloor(undated));
                }
                // THE CANCEL TRAP AND THE `billingOn` GAP, IN THE RESOLVER'S OWN WORDS.
                //
                // Not spelled out here, and not in `_WARNINGS`: `describeChargeCohortExposure` is
                // the single wording, so this page and the install-cohort table cannot describe one
                // fold's exposure two ways. It returns `[]` when both counters are zero, so there is
                // no guard to keep in step with it — and the counters it reads are MEASUREMENTS
                // ONLY. Nothing in this payload has been adjusted for either; that is the point.
                warnings.push(...describeChargeCohortExposure(d));
            }
            if (trialFold && trialFold.inferred_state_subscriptions > 0) {
                warnings.push(_WARNINGS.inferredStates(trialFold.inferred_state_subscriptions));
            }
            if (partnerReady) {
                warnings.push(..._coverageWarnings(app, win));
                //  Separate call, separate gates, on purpose — see the function's header. The
                // event floor says nothing about the payout floor, and `first_transaction` is the one
                // step here whose coverage failure inflates rather than deflates.
                warnings.push(..._transactionCoverageWarnings(app, win, {
                    first_transaction: wantsFirstTransaction,
                    windowed_transaction: transactionTypes.size > 0
                }));
            }

            // ── The trial block, from THIS payload ────────────────────────────
            //  `null`, never `{}` and never zeros, when no subscription step is selected. The
            // component guards on truthiness, so `{}` would render four em dashes — four figures
            // presented as unmeasurable when the truth is that nobody asked for them.
            let trialCohort: TrialCohortBlock | null = null;
            if (trialFold) {
                trialCohort = {
                    counts: trialFold.counts,
                    trial_started: trialFold.counts.trial_started,
                    still_on_trial: trialFold.counts.still_on_trial,
                    trial_converted: trialFold.counts.trial_converted,
                    churned_during_trial: trialFold.counts.churned_during_trial,
                    churned_after_trial: trialFold.counts.churned_after_trial,
                    currently_paying: trialFold.counts.currently_paying,
                    decided: trialFold.counts.decided,
                    conversion_rate: trialFold.conversion_rate
                };
            }

            const diagnostics: CustomFunnelDiagnostics = {
                //  `null` — not a zeroed triple — when no subscription step was selected: the
                // cohort was never folded, and `{resolved: 0, unresolved: 0, absent: 0}` would tell
                // the chart there are no subscriptions at all. `charge_link === null` is the marker
                // for "not folded", which is what makes the three counters below readable as zeros.
                //  SCOPED TO THE WINDOW COHORT, from the fold — not to the app-wide cohort
                // pull. `findChargeCohortEvents` is deliberately unbounded below (a subscription
                // that converts inside the window may have started at any point before it), so the
                // resolver's own triple counts EVERY subscription the app has ever had. The chart
                // captions this block "Trial length read from the merchant's own charge for R of T
                // subscriptions" and prints it beneath the WINDOW cohort, so on a long-lived app T
                // was a lifetime figure sitting under a window-scoped heading.
                charge_link: trialFold ? trialFold.charge_link : null,
                /**
                 * The money-side coverage floor, published beside the warning that reads it.
                 *
                 * NEVER `earliest_event_at`. `partnerApp.model.ts:122` keeps the two apart so a
                 * revenue figure cannot borrow the events' coverage; publishing one under the other's
                 * name here would undo that in the payload instead of in the schema.
                 */
                earliest_transaction_at: _iso(app.earliest_transaction_at),
                shopless_partner_events: partnerShopSets.shopless_events,
                skipped_keyless_subscription_events: cohortResult ? cohortResult.diagnostics.skipped_keyless : 0,
                test_subscriptions_excluded: cohortResult ? cohortResult.diagnostics.test_subscriptions_excluded : 0,
                inferred_state_subscriptions: trialFold ? trialFold.inferred_state_subscriptions : 0,
                // `null` — NOT A ZEROED OBJECT — when no subscription step was selected, exactly
                // as `charge_link` above. The cohort was never folded, so a zeroed block would
                // report "we looked for superseded subscriptions and found none" on a request that
                // never looked. That is the same fabricated-measurement error one layer down, and it
                // is the one this whole block exists to make visible.
                //
                // ⚠️ APP-WIDE, NOT WINDOW-SCOPED, and deliberately unlike `charge_link` above. The
                // cohort event pull has no lower bound by design, so these count every subscription
                // the app has ever had. That is the RIGHT scope here: the exposure is a property of
                // the fold's key, not of the window, and a window-scoped count would understate it
                // by whatever share of the plan changes happened earlier. The warning sentence is
                // written to match — it says "here", never "in this window".
                supersession: cohortResult ? cohortResult.diagnostics.supersession : null,
                billing_on_gap: cohortResult ? cohortResult.diagnostics.billing_on_gap : null,
                unknown_event_keys: unknownKeys,
                duplicate_event_keys: selection.duplicates,
                dropped_over_cap_event_keys: selection.dropped_over_cap
            };

            let periodDays: number | 'all' | null = win.periodDays;
            if (win.isLifetime) {
                periodDays = 'all';
            }

            const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;

            const payload: CustomFunnelResponse = {
                app_id: appId,
                app_name: app.display_name,
                period_label: win.periodLabel,
                period_days: periodDays,
                kind: win.kind,
                since: _iso(win.since),
                until: win.until.toISOString(),
                ga4_until: _iso(ga4Until),
                events: steps.map((step) => step.key),

                steps,
                // Last over first — the same number as the last step's cumulative rate, taken from it
                // rather than recomputed, so the headline and the chip can never disagree.
                //
                // `null` BELOW TWO STEPS, because step 0 measures against ITSELF. `rate(c, c)` is
                // `1`, so a one-step funnel published `conversion_rate: 1` and `_fmtHeadline` rendered
                // "100.00%" in 32-pixel type under the words "Conversion rate" — on a payload whose
                // own `tooFewSteps` warning says "there is no conversion to compute between fewer".
                // The chart drops its `A → B` caption below two steps (`PartnerFunnelChart.js:283`)
                // but renders the headline unconditionally (`:282`), so the reader was handed a bare,
                // perfect, meaningless percentage. Reachable from `?events=installed`, and from a
                // saved selection where one typo leaves a single valid key.
                conversion_rate: lastStep && steps.length >= MIN_FUNNEL_EVENTS
                    ? lastStep.cumulative_conversion_pct
                    : null,
                crosses_unit_seam: steps.some((step) => step.unit_change),

                trial_cohort: trialCohort,
                window_kpi: trialFold ? { converted_in_window: trialFold.converted_in_window } : null,
                diagnostics,
                // ⚠️ De-duplicated because the chart keys each `<p>` by the string itself, so a
                // repeat is not drawn twice — it is DROPPED, silently, along with its condition.
                // Nothing above pushes the same string twice today; this makes that a property of
                // the payload rather than of the code that happens to build it.
                warnings: [...new Set(warnings)],

                catalog: FUNNEL_EVENT_CATALOG,
                max_events: MAX_FUNNEL_EVENTS,

                tiers: {
                    listing: { state: listingState, reason: listingReason },
                    partner: { state: partnerState, reason: partnerReason }
                }
            };

            // SET ONLY WHEN NO TIER CAN ANSWER. `dataState.js` reads this key as "null the whole
            // payload and render a banner in its place" — right when nothing at all is measurable,
            // and destructive the moment one tier is READY, because it would throw away a correct
            // Partner funnel over a missing BigQuery credential.
            //
            // ⚠️ The literal `NEVER_SYNCED` even when the listing tier is NOT_CONNECTED: that is the
            // only value the decoder recognises here, and `unknown_reason` carries the real cause.
            // Without `unknown_reason` the banner body falls back to `resp.msg`, so the page would
            // print the SUCCESS message under the heading "Nothing synced yet".
            if (!listingReady && !partnerReady) {
                payload.data_state = FUNNEL_TIER_STATES.NEVER_SYNCED;
                payload.unknown_reason = [listingReason, partnerReason].filter(Boolean).join(' ');
            }

            //  A 200 with unknown steps, always. The ways to have nothing to show are separated by
            // `tiers`, by each step's own `available` / `unknown_reason`, and by `warnings[]` — never
            // by a refusal, which the page renders as "run a sync to populate GA4 and Partner events"
            // over a deployment whose Partner events are already there.
            return resolve(promiseReturnResult(true, payload, {}, 'Custom funnel resolved.'));
        } catch (error) {
            customConsoleError('ERROR: Conversion customFunnelService getCustomFunnel', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read the custom funnel. Please try again.'));
        }
    });
};

export = {
    getCustomFunnel
};
