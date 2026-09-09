'use strict';

/**
 * ============================================================================
 *  THE FIXED 7-STAGE FUNNEL — ONE STAGE DEFINITION, MEASURED ONCE
 * ============================================================================
 *
 *  Serves `GET /api/conversion/funnel` — `ConversionFunnelChart` at the top of the Conversion
 *  analysis tab.
 *
 *  ──  THIS ENDPOINT MEASURES NOTHING. IT SELECTS, AND RESHAPES. ───────────────────────────
 *
 *  It is the same funnel as `GET /api/conversion/custom-funnel` with the operator's choice replaced
 *  by a fixed list of catalog keys, so it CALLS that service rather than re-deriving anything. Every
 *  count, every rate, every tier gate, every `null`-not-zero decision and every warning below comes
 *  back from there.
 *
 *  The alternative was a second stage table with its own labels, its own `$in` lists and its own
 *  arithmetic, sitting one tab away from the first on the same page. That is a SECOND VOCABULARY, and
 *  this codebase has already paid for that class of mistake twice — `IMPLEMENTATION.md` §3.10 records
 *  two pages reconstructing MRR independently and disagreeing with each other, and
 *  `modules/revenue/index.ts` publishes its paying-set predicate specifically so a sibling cannot
 *  grow a second one. The failure mode here would be worse than either, because the two funnels sit
 *  on ONE SCREEN: "Installed" in the fixed chart and "Installed" in the operator's chart would be two
 *  numbers, both plausible, with nothing on the page to say which was right.
 *
 *  So the whole file is: pick keys, call, reshape, and add the three sentences the reshape makes
 *  necessary. If a stage's number looks wrong, the bug is in `customFunnel.service` and fixing it
 *  there fixes both charts — which is the property this design is for.
 *
 *  ──  THE MEASUREMENT SEAM, AND THE TWO BADGES THAT DO NOT MARK IT ────────────────────────
 *
 *  Listing stages count VISITORS. Partner stages count SHOPS. Subscription stages count
 *  SUBSCRIPTIONS. The chart marks exactly ONE boundary — it hard-codes `idx === 4` and prints
 *  "↑ Visitor-level (GA4) — ↓ Shop-level (Partner)" beneath that row — and this funnel crosses TWO:
 *  visitors→shops at `ga4_installs → installed`, and shops→subscriptions at
 *  `installed → trial_started`.
 *
 *  Worse, the two HEADLINE figures both cross a boundary and neither carries a marker of any kind:
 *  `ConversionFunnelChart.js:46-47` draws them as two plain Badges, "Install rate" and "Paid
 *  conversion", above the chart and eight rows above the seam caption. `overall_install_rate` divides
 *  STORES by VISITORS; `overall_paid_conversion_rate` divides SUBSCRIPTIONS by STORES and can
 *  legitimately exceed 100%.
 *
 *  So each stage carries `crosses_measurement_seam`, the payload carries `rate_definitions`, and
 *  `warnings[]` — which the page renders through `DataStateSection` — carries the sentences. Marking
 *  it is not optional: an unmarked ratio between two populations is presented as a conversion rate,
 *  and a reader will plan against it.
 *
 *  ── WHAT THIS FILE DOES NOT INHERIT ────────────────────────────────────────────────────────
 *
 *  `custom-funnel`'s `catalog` and `max_events` are the PICKER's contract and this chart has no
 *  picker; publishing them here would invite a client to believe these stages can be reordered. The
 *  fixed list is published as `stage_keys` instead, so the definition is still inspectable from the
 *  wire.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import funnelEventConstants = require('../constants/funnelEvent.constants');
import stageFunnelConstants = require('../constants/stageFunnel.constants');
import funnelMathHelper = require('../helpers/funnelMath.helper');
// A SIBLING SERVICE BY DEEP PATH, never through this module's own barrel — a barrel import from
// inside the module it belongs to closes a cycle on itself and would leave every key of this file's
// own module `undefined` at load. Services are permitted to compose; what they may not do is
// re-derive.
import customFunnelService = require('./customFunnel.service');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { CustomFunnelStep, FunnelEventSource } from '../types/customFunnel.types';
import type {
    StageChartSource,
    StageFunnelParams,
    StageFunnelResponse,
    StageFunnelSeamDiagnostics,
    StageFunnelStage
} from '../types/stageFunnel.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { FUNNEL_SOURCE_TIERS } = funnelEventConstants;
// THE ONE DIVISION IN THIS MODULE. Every rate below — including the drift — goes through it, so an
// empty denominator answers `null` rather than `0`. See that helper's header for the "0.00%" under
// the words "Conversion rate" that it exists to prevent.
const { rate } = funnelMathHelper;
const {
    STAGE_FUNNEL_EVENT_KEYS,
    STAGE_FUNNEL_SEAM_INDEX,
    STAGE_FUNNEL_SEAM_KEYS,
    STAGE_FUNNEL_HEADLINE_KEYS,
    STAGE_CHART_SOURCE_BY_CATALOG_SOURCE,
    STAGE_FUNNEL_RATE_DEFINITIONS,
    STAGE_FUNNEL_DRIFT_BASIS
} = stageFunnelConstants;
const { getCustomFunnel } = customFunnelService;

/**
 * ⚠️ THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * The page renders one entry per warning KEYED BY THE STRING ITSELF, so a duplicate is not drawn
 * twice — it is DROPPED, silently, along with its condition. These three are the ONLY warnings this
 * file adds; everything else in `warnings[]` came back from `custom-funnel` and is already unique
 * there, and the final array is de-duplicated anyway.
 */
const _WARNINGS = Object.freeze({
    installRateCrossesSeam: `Install rate: ${STAGE_FUNNEL_RATE_DEFINITIONS.install_rate} It is shown as a `
        + 'plain badge above the chart with no marker, so read it as "how many stores arrived for this '
        + 'many listing visits" rather than as a share of visitors who installed — one visitor can view '
        + 'the listing several times, and a store can install from a surface the listing analytics '
        + 'never saw.',

    paidConversionCrossesPopulation: `Paid conversion: ${STAGE_FUNNEL_RATE_DEFINITIONS.paid_conversion_rate} `
        + 'It is shown as a plain badge above the chart with no marker, and it also counts every '
        + 'subscription that reached paid billing — including ones that have since churned, which did '
        + 'convert — so it is not the share of currently-paying stores.',

    driftUnmeasurable: (reason: string): string => 'The GA4-versus-Partner install drift beneath the '
        + `middle of the chart cannot be measured for this window. ${reason} The two halves of this `
        + 'funnel are still counted correctly on their own; what is missing is the comparison between '
        + 'them, which is the one figure that would say whether they agree.'
});

/** Reasons published on `seam_diagnostics.unknown_reason`. Short — the long form is in `warnings[]`. */
const _DRIFT_REASONS = Object.freeze({
    listingUnknown: 'Listing analytics has no install count for this window, so there is nothing to compare '
        + 'the Partner API against.',
    partnerUnknown: 'The Partner API has no install count for this window, so there is nothing to compare '
        + 'listing analytics against.',
    /**
     * ⚠️ A MEASURED ZERO IS STILL NOT A DENOMINATOR. `rate()` already answers `null` here; the
     * sentence exists so the reader is not left to assume the tier failed when it in fact answered.
     */
    zeroListingInstalls: 'Listing analytics recorded no installs at all in this window, so the drift has no '
        + 'denominator. That is a measured zero rather than a missing measurement.'
});

/**
 * The chart's two-member source for a catalog step.
 *
 *  NEVER `|| 'partner'`. The map is proved total over `FUNNEL_EVENT_SOURCES` in the types, and a
 * silent fallback would file a GA4 stage as a Partner one — which is precisely the misattribution the
 * seam caption exists to prevent, arriving through a defensive default. A source the map does not
 * carry is a build defect and is left visible.
 *
 * @param source - The catalog's four-member source.
 * @returns `ga4` or `partner`.
 */
const _chartSource = (source: FunnelEventSource): StageChartSource => {
    return STAGE_CHART_SOURCE_BY_CATALOG_SOURCE[source];
};

/**
 * One custom-funnel step, reshaped into one chart stage. Nothing is recomputed.
 *
 * @param step - The measured step, exactly as `custom-funnel` produced it.
 * @returns The stage the chart reads.
 */
const _toStage = (step: CustomFunnelStep): StageFunnelStage => ({
    key: step.key,
    label: step.label,
    source: _chartSource(step.source),
    catalog_source: step.source,
    tier: FUNNEL_SOURCE_TIERS[step.source],
    unit: step.unit,
    population: step.population,
    count: step.count,
    conversion_pct: step.conversion_pct,
    drop_pct: step.drop_pct,
    cumulative_conversion_pct: step.cumulative_conversion_pct,
    unit_change: step.unit_change,
    population_change: step.population_change,
    //  The POPULATION change, not the unit change. `installed → trial_started` keeps `unit: 'shops'`
    // and moves from stores to subscriptions, which is the boundary the chart draws as an ordinary
    // step conversion with a plain grey chip. See `funnelEvent.constants`' own note on why
    // `population` exists at all.
    crosses_measurement_seam: step.population_change,
    rate_basis: step.rate_basis,
    rate_denominator: step.rate_denominator,
    undecided: step.undecided,
    available: step.available,
    unknown_reason: step.unknown_reason
});

/**
 * The two install counts and the gap between them.
 *
 *  `drift_pct` is `null` — never `0` — whenever either side is unknown or GA4's count is zero. A
 * `0` asserts that the two systems AGREE, which is the most reassuring thing this payload can say and
 * the one it must not invent; `ConversionFunnelChart.js:36` reads the figure through a
 * `typeof === 'number'` guard and prints "n/a" for a null, and `:37` only raises its >25% Banner on a
 * drift it can actually measure.
 *
 * @param byKey - The stages, indexed.
 * @returns Both counts, the signed drift, and why there is none.
 */
const _seamDiagnostics = (byKey: Map<string, StageFunnelStage>): StageFunnelSeamDiagnostics => {
    const listing = byKey.get(STAGE_FUNNEL_SEAM_KEYS.LISTING);
    const partner = byKey.get(STAGE_FUNNEL_SEAM_KEYS.PARTNER);
    const ga4Installs = listing ? listing.count : null;
    const partnerInstalls = partner ? partner.count : null;

    let unknownReason: string | null = null;
    if (ga4Installs === null) {
        unknownReason = _DRIFT_REASONS.listingUnknown;
    } else if (partnerInstalls === null) {
        unknownReason = _DRIFT_REASONS.partnerUnknown;
    } else if (ga4Installs === 0) {
        unknownReason = _DRIFT_REASONS.zeroListingInstalls;
    }

    // ONE division, through the module's `rate()`, so the null rules here cannot drift from the
    // ones every other figure on this payload obeys. The numerator is signed on purpose — see
    // `STAGE_FUNNEL_DRIFT_BASIS`.
    const driftPct = ga4Installs === null || partnerInstalls === null
        ? null
        : rate(partnerInstalls - ga4Installs, ga4Installs);

    return {
        ga4_installs: ga4Installs,
        partner_installs: partnerInstalls,
        drift_pct: driftPct,
        drift_basis: STAGE_FUNNEL_DRIFT_BASIS,
        measurable: driftPct !== null,
        unknown_reason: driftPct === null ? unknownReason : null
    };
};

/**
 * The fixed end-to-end funnel, measured through the operator-chosen funnel's own service.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query, already cast (not coerced) by the controller.
 * @param params1.partner_app_id - The app to report on. Required.
 * @param [params1.period_days] - number, 0 or 'all' (default 30).
 * @param [params1.since] - ISO date; honoured only together with `until`.
 * @param [params1.until] - ISO date; honoured only together with `since`.
 * @returns The funnel, or an honest refusal carrying `{}`.
 */
const getFunnel = (
    { user_id }: IdentityObject,
    { partner_app_id, period_days, since, until }: StageFunnelParams
): Promise<ServiceResult<StageFunnelResponse | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'partner_app_id is required. Read it from GET /api/partner-apps.'));
            }

            // ⚠️ `period_days`, `since` and `until` are handed through RAW, exactly as they arrived.
            // `shared/helpers/dateRange.helper` normalises them ONCE, inside the call below; a second
            // normalisation here would give the window two spellings to drift between, with this
            // one being the copy no test covers.
            //
            // The keys are passed as an ARRAY rather than comma-joined: `resolveRequestedEvents`
            // accepts both, and an array cannot be mangled by a stray separator inside a key.
            const serviceResponse = await getCustomFunnel({ user_id }, {
                partner_app_id: String(partner_app_id),
                period_days,
                since,
                until,
                events: [...STAGE_FUNNEL_EVENT_KEYS]
            });

            if (!serviceResponse.status) {
                //  PROPAGATED VERBATIM. `custom-funnel` refuses for exactly four reasons, none of
                // them about data: no `user_id`, no `partner_app_id`, no such app, or a query that
                // threw. Re-wording any of them here would give one condition two sentences, and the
                // operator would read whichever endpoint they happened to call.
                return resolve(promiseReturnResult(false, {}, serviceResponse.error, serviceResponse.msg));
            }

            const funnel = serviceResponse.data;
            const measured: readonly CustomFunnelStep[] = Array.isArray(funnel.steps) ? funnel.steps : [];

            // ONE array, ONE pass, and every figure below is derived from it — the headline rates,
            // the seam diagnostics and the warnings all read this list rather than re-reading the
            // response, so the badges above the chart and the bars inside it cannot disagree.
            const stages: StageFunnelStage[] = measured.map(_toStage);
            const byKey = new Map<string, StageFunnelStage>();
            for (const stage of stages) {
                byKey.set(stage.key, stage);
            }

            const entry = byKey.get(STAGE_FUNNEL_HEADLINE_KEYS.ENTRY);
            const install = byKey.get(STAGE_FUNNEL_HEADLINE_KEYS.INSTALL);
            const paid = byKey.get(STAGE_FUNNEL_HEADLINE_KEYS.PAID);

            //  THROUGH `rate()`, so an unknown or empty denominator answers `null` and the badge
            // renders an em dash. `_fmtPct(0)` renders "0.0%" beside the words "Install rate" — a
            // claim that nobody who saw the listing installed, manufactured out of an absence.
            const overallInstallRate = rate(install ? install.count : null, entry ? entry.count : null);
            const overallPaidRate = rate(paid ? paid.count : null, install ? install.count : null);

            const seam = _seamDiagnostics(byKey);

            //  Custom-funnel's own warnings FIRST, so the ones about missing data are read before
            // the ones about how to read a figure that is present.
            const warnings: string[] = Array.isArray(funnel.warnings) ? [...funnel.warnings] : [];
            //  MARKED ONLY WHEN THE FIGURE EXISTS. A caveat about how to read an em dash teaches an
            // operator that the warnings block is noise, and the next one they skip is the one that
            // mattered.
            if (overallInstallRate !== null) {
                warnings.push(_WARNINGS.installRateCrossesSeam);
            }
            if (overallPaidRate !== null) {
                warnings.push(_WARNINGS.paidConversionCrossesPopulation);
            }
            if (!seam.measurable && seam.unknown_reason) {
                warnings.push(_WARNINGS.driftUnmeasurable(seam.unknown_reason));
            }

            const payload: StageFunnelResponse = {
                app_id: funnel.app_id,
                app_name: funnel.app_name,
                period_label: funnel.period_label,
                period_days: funnel.period_days,
                kind: funnel.kind,
                since: funnel.since,
                until: funnel.until,
                ga4_until: funnel.ga4_until,

                stages,
                stage_keys: STAGE_FUNNEL_EVENT_KEYS,
                seam_stage_index: STAGE_FUNNEL_SEAM_INDEX,
                seam_diagnostics: seam,

                overall_install_rate: overallInstallRate,
                overall_paid_conversion_rate: overallPaidRate,
                rate_definitions: STAGE_FUNNEL_RATE_DEFINITIONS,

                diagnostics: funnel.diagnostics,
                // ⚠️ De-duplicated because the page keys each warning by the string itself, so a
                // repeat is not drawn twice — it is DROPPED, along with its condition.
                warnings: [...new Set(warnings)],
                tiers: funnel.tiers
            };

            //  CARRIED THROUGH, NEVER RE-DECIDED. `custom-funnel` sets `data_state` only when NO
            // tier is READY, which is the one case where nulling the whole payload and drawing a
            // banner is the honest rendering. Recomputing that condition here would be a second
            // opinion about the same two watermarks, and the two endpoints would eventually disagree
            // about whether this app has ever synced.
            if (funnel.data_state) {
                payload.data_state = funnel.data_state;
                payload.unknown_reason = funnel.unknown_reason;
            }

            //  A 200 with unknown stages, always. See `custom-funnel`'s header: a refusal renders
            // on this page as "run a partner sync to populate" over a deployment whose Partner events
            // are already there and correct.
            return resolve(promiseReturnResult(true, payload, {}, 'Conversion funnel resolved.'));
        } catch (error) {
            customConsoleError('ERROR: Conversion stageFunnelService getFunnel', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read the conversion funnel. Please try again.'));
        }
    });
};

export = {
    getFunnel
};
