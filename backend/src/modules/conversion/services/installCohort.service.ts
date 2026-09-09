'use strict';

/**
 * ============================================================================
 *  WHO INSTALLED IN THIS WINDOW, HOW THEY ARRIVED, AND WHERE THEY GOT TO
 * ============================================================================
 *
 *  Serves `GET /api/funnel/install-cohort` — the store table under the conversion funnel.
 *
 *  ── ONE `cohort` ARRAY. ONE PASS. EVERYTHING DERIVED FROM IT. ────────────
 *
 *  There is no second `countDocuments` and no second aggregation anywhere in this file. The number
 *  in the caption, the numbers in the state boxes, the numbers in the filter labels and the rows in
 *  the table are all folds over the SAME array, so they cannot disagree. Two queries that answer the
 *  same question are two answers that will eventually differ, and the one on screen will be whichever
 *  the reader happened to look at.
 *
 *  The summary tallies are PRE-FILTER, which is not a violation of that rule but a consequence of it:
 *  they label the filter controls ("On trial (23)") and fill the summary strip, so a post-filter
 *  count would make every unselected option read `(0)` the moment one is chosen. Standard faceted
 *  counting — one source, two projections.
 *
 *  ── THIS ENDPOINT NEVER REFUSES BECAUSE BIGQUERY IS UNCONFIGURED ─────────
 *
 *  The install spine comes from the Partner API and is complete without listing analytics. A
 *  `status: false` here maps to `setCohort(null)` on the page, which prints "No installs recorded for
 *  this window. Install events come from the Partner API — run a Partner sync if you expect some."
 *  That is wrong twice over: the installs exist, and the missing thing is a BigQuery credential.
 *  Instead: `attribution_state: 'NOT_CONNECTED'`, every row `has_attribution: false`, and the
 *  operator-facing reason pushed into `warnings[]`, which the page already renders verbatim.
 *
 *  The only refusals are: no `user_id`, no `partner_app_id`, no such app, or a query that threw.
 *
 *  ── EVERY NUMBER IN `summary` IS A BARE NUMBER ───────────────────────────
 *
 *  Not a `confidence.helper` envelope, and this is the one place in the codebase where
 *  `IMPLEMENTATION.md` §3.11 must NOT be applied. `fmtNum` does `Number(n)`, so an envelope renders
 *  as an em dash; and `InstallCohortTable.js:133` gates the whole attribution-coverage banner on
 *  `typeof coverage === 'number'`, so an envelope SILENTLY DELETES the most important honesty
 *  statement on the page. Nothing errors, nothing logs, and the page looks finished. The honesty
 *  contract is discharged here through `has_attribution`, `attribution_coverage`, per-row
 *  `state_basis` / `trial_days_source` / `charge_link`, `data_state`, `attribution_state` and
 *  `warnings[]` — every one of which survives rendering.
 *
 *  ── VALIDATION IS FAIL-OPEN ──────────────────────────────────────────────
 *
 *  An unrecognised `state`, `channel` or `sort` is a NO-OP PLUS A WARNING, never "match nothing". A
 *  typo must WIDEN the result set: `?state=Converted` returning an empty table with no explanation is
 *  indistinguishable from a business with no conversions.
 *
 *  ── The discriminator is the WATERMARK, never the row count ─────────────────
 *
 *  No rows plus `last_synced_at` is a real, publishable "nobody installed in this window". No rows
 *  and no watermark is "we have not looked yet". Those must never render alike, and a row count
 *  cannot tell them apart.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import dateRangeHelper = require('../../shared/helpers/dateRange.helper');
import attributionMatchHelper = require('../../shared/helpers/attributionMatch.helper');
import listQueryHelper = require('../../shared/helpers/listQuery.helper');
import surfaceConstants = require('../../shared/constants/surface.constants');
import bigQueryModule = require('../../bigquery');
import lifecycleConstants = require('../constants/lifecycle.constants');
import acquisitionChannelHelper = require('../helpers/acquisitionChannel.helper');
import chargeCohortResolver = require('../resolvers/chargeCohort.resolver');
import installCohortRepository = require('../repositories/installCohort.repository');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { ResolvedDateRange } from '../../shared/types/dateRange.types';
import type {
    AcquisitionChannel,
    AttributionState,
    CohortDataState,
    CohortSubscription,
    InstallCohortSortKey,
    SortDirection,
    StoreLifecycleState
} from '../types/lifecycle.types';
import type {
    InstallCohortDiagnostics,
    InstallCohortParams,
    InstallCohortResponse,
    InstallCohortRow,
    InstallCohortSummary
} from '../types/installCohort.types';
import type { CohortAttributionRow, InstallSpineRow } from '../types/installCohortData.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { resolveDateRange } = dateRangeHelper;
// EXTRACTED, NOT REWRITTEN. Both were local to this file until the store roster needed the same
// two rules; they moved to `shared/helpers/` with their reasoning intact rather than being copied
// into a second module. Behaviour here is unchanged — `_pickNearestAttribution` and `_positiveInt`
// were lifted verbatim, and `_compareRows` below still owns the tie-break it always did.
const { pickNearestByInstalledAt } = attributionMatchHelper;
const { positiveInt, compareSortValues } = listQueryHelper;
const { isSearchSurface } = surfaceConstants;
const { resolveBigQueryAvailability } = bigQueryModule;
const { classifyAcquisitionChannel, acquisitionChannelLabel } = acquisitionChannelHelper;
const { resolveChargeCohortForDomains, describeChargeCohortExposure } = chargeCohortResolver;
const {
    findPartnerAppById,
    aggregateInstallSpine,
    findChargeCohortEvents,
    aggregateSettledSubscriptionCharges,
    findInstallAttributionRows
} = installCohortRepository;
const {
    JOIN_MISS_STATE_BASIS,
    STORE_LIFECYCLE_STATES,
    STORE_LIFECYCLE_LABELS,
    STORE_LIFECYCLE_STATE_ORDER,
    ACQUISITION_CHANNELS,
    ACQUISITION_CHANNEL_LABELS,
    ACQUISITION_CHANNEL_ORDER,
    STATE_BASIS,
    TRIAL_DAYS_SOURCES,
    CHARGE_LINK_STATES,
    INSTALL_COHORT_SORT_KEYS,
    DEFAULT_INSTALL_COHORT_SORT_KEY,
    DEFAULT_INSTALL_COHORT_SORT_DIR,
    DEFAULT_LIMIT,
    MAX_LIMIT,
    ATTRIBUTION_STATES,
    COHORT_DATA_STATES
} = lifecycleConstants;

/**
 * Widened copies of the two frozen key lists, so a `string` from the query bag can be tested against
 * them without an `as` cast (the house rule keeps casts inside `models.repository`). Assignment
 * widens; it does not re-type anything.
 */
const _STATE_KEYS: readonly string[] = STORE_LIFECYCLE_STATE_ORDER;
const _CHANNEL_KEYS: readonly string[] = ACQUISITION_CHANNEL_ORDER;

/**
 *  THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * `InstallCohortTable.js:171` renders one `<p>` per warning KEYED BY THE STRING ITSELF. Two
 * identical strings are a duplicate-key React warning and one of them is silently dropped — so a
 * second copy of a message does not double up, it disappears, and takes its condition with it.
 * Keeping them together is what makes that checkable by eye.
 *
 * Each is written to be read by an operator who cannot see this code: it says what is missing, what
 * that does to the numbers below it, and what would fix it.
 */
const _WARNINGS = Object.freeze({
    neverSynced: 'No Partner sync has completed for this app yet, so no install events have been fetched. '
        + 'An empty table below means we have not looked — not that nobody installed.',

    /**
     * ⚠️ Carries the availability message verbatim so the operator reads the missing variable names
     * rather than a generic "not configured".
     */
    attributionNotConnected: (message: string): string => `${message} `
        + 'Every store below therefore shows as "Not attributed"; that is a missing data source, not '
        + 'evidence of direct arrival.',

    /**
     * ⚠️ Says "any store showing as", NOT "every store below shows as". The attribution read is
     * skipped only when the tier is UNCONFIGURED; with a configured tier and a null watermark the
     * query still runs and can return rows — a sync that crashed writes rows before
     * `bigQuerySyncState.repository.ts` stamps its watermark. A banner asserting a universal that
     * the table beside it contradicts teaches an operator to stop reading banners.
     */
    attributionNeverSynced: 'Listing analytics is configured, but the install-attribution sync has never '
        + 'completed for this app, so attribution here is at best partial. Any store showing as "Not attributed" '
        + 'reflects that missing sync rather than evidence of direct arrival; run the install-attribution sync '
        + 'to fill it in.',

    inferredStates: (rows: number): string => `${rows} store(s) below are shown as "On trial" on the weakest `
        + 'evidence available: Shopify supplied no billing date for their subscription and no payout has '
        + 'settled against it yet. That is the reading which claims no revenue and no loss, not a measured trial.',

    testSubscriptionsExcluded: (subscriptions: number): string => `${subscriptions} test subscription(s) were `
        + 'excluded from the Status column. Partner install events carry no test flag at all, so those stores '
        + 'are still counted as installs above — the two sides of this table are asymmetric and no available '
        + 'data can reconcile them.',

    shoplessInstallEvents: (events: number): string => `${events} install event(s) in this window carried no shop `
        + 'domain and could not be attached to a store. They are excluded from every count on this page.',

    skippedKeylessSubscriptionEvents: (events: number): string => `${events} subscription event(s) carried neither `
        + 'a charge id nor a shop domain and were skipped rather than pooled. Pooling them would have invented '
        + 'one merged subscription out of many.',

    truncated: (shown: number, total: number): string => `Showing ${shown} of ${total} matching stores. Request a `
        + `later page, or raise \`limit\` (maximum ${MAX_LIMIT}), to see the rest.`,

    unrecognisedState: (value: string): string => `The state filter "${value}" is not one of the five store states, `
        + 'so it has been ignored and the list below is wider than you asked for. Valid values: '
        + `${_STATE_KEYS.join(', ')}.`,

    unrecognisedChannel: (value: string): string => `The channel filter "${value}" is not one of the eight `
        + 'acquisition channels, so it has been ignored and the list below is wider than you asked for. Valid '
        + `values: ${_CHANNEL_KEYS.join(', ')}.`,

    unrecognisedSort: (value: string): string => `The sort key "${value}" is not sortable here, so the default sort `
        + `(${DEFAULT_INSTALL_COHORT_SORT_KEY}, newest first) has been used instead. Valid values: `
        + `${INSTALL_COHORT_SORT_KEYS.join(', ')}.`,

    lifetimeFloor: 'No lifetime Partner sync has ever completed for this app, so every all-time figure here is a '
        + 'FLOOR rather than a total — there may be older installs that have never been fetched.',

    /**
     * ⚠️ Fires on the app-level measurement, which records the WIDEST gap in the whole event history
     * and NOT where it sits — so the window cannot be tested against it and the wording must stay
     * conditional. `null` is "never measured" and `0` is a real, reassuring "no day-wide hole";
     * neither warns.
     */
    eventHistoryGap: (days: number): string => `The Partner event history for this app contains a stretch of `
        + `${days} day(s) carrying no events at all. If that stretch falls inside this window, the install count, `
        + 'the state split and the attribution coverage below are FLOORS rather than totals. The data cannot say '
        + 'whether it was a genuinely quiet period or a sync window that failed and was never re-pulled, which is '
        + 'why it is published here rather than resolved.',

    beforeEarliestEvent: (earliest: string): string => `The window starts before the earliest Partner event on `
        + `record (${earliest}). Installs before that date were never fetched and cannot appear here, so the `
        + 'counts for the earlier part of this window are floors.',

    unclassifiedSubscriptions: (rows: number): string => `${rows} store(s) have a subscription whose state could `
        + 'not be mapped to one of the five store states, and are shown as "Installed only". That is a defect in '
        + 'this build, not a fact about those merchants — please report it.'
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

/** @param value - A candidate sort key. @returns Whether it is in the allowlist. */
const _isSortKey = (value: string): value is InstallCohortSortKey => INSTALL_COHORT_SORT_KEYS.includes(value);

/** @param value - A candidate state. @returns Whether it is one of the five. */
const _isLifecycleState = (value: string): value is StoreLifecycleState => _STATE_KEYS.includes(value);

/** @param value - A candidate channel. @returns Whether it is one of the eight. */
const _isChannel = (value: string): value is AcquisitionChannel => _CHANNEL_KEYS.includes(value);

/**
 * A zeroed tally over the five states.
 *
 * Written out rather than looped so the COMPILER proves it is total: add a sixth state to the
 * vocabulary and this stops compiling, which is the only place that failure can be caught early. A
 * key omitted at run time removes that box from the summary strip, which reads on screen as "we did
 * not measure it" rather than "it is zero".
 *
 * @returns Every lifecycle state at 0.
 */
const _zeroByState = (): Record<StoreLifecycleState, number> => ({
    [STORE_LIFECYCLE_STATES.INSTALLED]: 0,
    [STORE_LIFECYCLE_STATES.ON_TRIAL]: 0,
    [STORE_LIFECYCLE_STATES.CONVERTED]: 0,
    [STORE_LIFECYCLE_STATES.CHURNED_IN_TRIAL]: 0,
    [STORE_LIFECYCLE_STATES.CHURNED]: 0
});

/**
 * A zeroed tally over the eight channels. Same reasoning as {@link _zeroByState}.
 *
 * ⚠️ The page then OMITS any channel whose count is 0 from its Select. That is its decision to make
 * from a complete map, not ours to make by withholding a key.
 *
 * @returns Every acquisition channel at 0.
 */
const _zeroByChannel = (): Record<AcquisitionChannel, number> => ({
    [ACQUISITION_CHANNELS.APP_STORE_AD]: 0,
    [ACQUISITION_CHANNELS.APP_STORE_SEARCH]: 0,
    [ACQUISITION_CHANNELS.APP_STORE_BROWSE]: 0,
    [ACQUISITION_CHANNELS.REFERRAL]: 0,
    [ACQUISITION_CHANNELS.ORGANIC_SEARCH]: 0,
    [ACQUISITION_CHANNELS.PAID]: 0,
    [ACQUISITION_CHANNELS.DIRECT]: 0,
    [ACQUISITION_CHANNELS.UNKNOWN]: 0
});

/**
 * The value a row sorts on for a given key.
 *
 * Dates become epoch milliseconds so the comparator has one numeric path; `''` is folded to `null`
 * because a blank `source` means "no attribution record", which is an absence and must sort with the
 * other absences rather than at the top of the alphabet.
 *
 * @param row - The row.
 * @param key - One of the allowlisted sort keys.
 * @returns The comparable value, or null when the row has none.
 */
const _sortValue = (row: InstallCohortRow, key: InstallCohortSortKey): number | string | null => {
    if (key === 'installed_at') {
        const at = row.installed_at instanceof Date ? row.installed_at.getTime() : Date.parse(String(row.installed_at));
        return Number.isFinite(at) ? at : null;
    }
    if (key === 'shop_domain') {
        return row.shop_domain || null;
    }
    if (key === 'state') {
        return row.state || null;
    }
    if (key === 'channel') {
        return row.channel || null;
    }
    return row.source || null;
};

/**
 * The row comparator.
 *
 * NULLS SORT LAST REGARDLESS OF DIRECTION. A store with no install date is not "the earliest"
 * when you ask for oldest-first — it is a store we do not have a date for, and floating it to the top
 * of an ascending sort presents an absence as an extreme value.
 *
 * `localeCompare` for strings, matching the sibling store list. `<` on strings orders by code unit,
 * which puts `Z` before `a` and drops accented domains into a different neighbourhood than their
 * unaccented twins.
 *
 * The final tie-break is `shop_domain` ascending, so paging through a large cohort is stable rather
 * than reshuffling equal rows between requests — which reads on screen as the data changing.
 *
 * @param a - Left row.
 * @param b - Right row.
 * @param key - The sort key.
 * @param dir - `asc` or `desc`.
 * @returns Negative, zero or positive.
 */
const _compareRows = (a: InstallCohortRow, b: InstallCohortRow, key: InstallCohortSortKey, dir: SortDirection): number => {
    const av = _sortValue(a, key);
    const bv = _sortValue(b, key);

    // The nulls-last rule and the `localeCompare` both live in `shared/helpers/listQuery.helper`
    // now — the store roster sorts by the same rules over a different key set, and one definition
    // is what stops the two tables disagreeing about where an unmeasured value belongs. A `0` back
    // means "tied on the sort key", which is what the tie-break below is for.
    const cmp = compareSortValues(av, bv, dir);
    if (cmp !== 0) {
        return cmp;
    }
    return a.shop_domain.localeCompare(b.shop_domain);
};

/**
 * One cohort row: a spine entry, plus whatever the two LEFT joins had to say about it.
 *
 * NEITHER JOIN MAY REMOVE A ROW. A store with no subscription is `INSTALLED` — a state, not a gap
 * — and a store with no attribution record is `has_attribution: false`, which the table renders as
 * "Not attributed" and NOT as "Direct". Direct is already the largest bucket, so a store we cannot
 * explain rendering as Direct would vanish into it and inflate it with a fabricated fact.
 *
 * @param spineRow - The store, from the spine.
 * @param [subscription] - Its winning subscription, if any.
 * @param [attribution] - Its nearest attribution record, if any.
 * @param planInterval - The cadence from a settled payout, or null. Never invented.
 * @returns The row exactly as the table reads it.
 */
const _buildRow = (
    spineRow: InstallSpineRow,
    subscription: CohortSubscription | undefined,
    attribution: CohortAttributionRow | null,
    planInterval: string | null
): InstallCohortRow => {
    const channel = attribution ? classifyAcquisitionChannel(attribution) : ACQUISITION_CHANNELS.UNKNOWN;
    // `lifecycle_state` is null only if a subscription state ever loses its mapping. It is NEVER
    // defaulted to INSTALLED silently — the fallback below is counted and warned about, because
    // filing a paying customer under "Installed only" is a specific false claim about a merchant.
    const lifecycle = subscription ? subscription.lifecycle_state : null;

    return {
        shop_domain: spineRow.shop_domain,
        shop_name: attribution ? attribution.shop_name || '' : '',
        //  Deliberately always `''`. The only country this build holds is the analytics export's
        // `geo.country`, a common NAME ("United States"), and `StoreTable` renders this field in a
        // two-character slot as an ISO-2 code. An empty string drops the line; the name would imply
        // a code it is not.
        country: '',
        installed_at: spineRow.installed_at,
        install_count: spineRow.install_count,

        has_attribution: !!attribution,
        channel,
        channel_label: acquisitionChannelLabel(channel),
        source: attribution ? attribution.source || '' : '',
        medium: attribution ? attribution.medium || '' : '',
        campaign: attribution ? attribution.campaign || '' : '',
        //  `''`, not `'none'`, when there is no record at all. `'none'` is a value the WRITER
        // stores to mean "a record exists and no acquisition scope produced it"; keeping the two
        // apart is what lets a reader tell an absent row from an uninformative one.
        attribution_source: attribution ? attribution.attribution_source || '' : '',
        surface_type: attribution ? attribution.surface_type || '' : '',
        /**
         * PUBLISHED ON BROWSE SURFACES, BLANK ON SEARCH ONES. The field means two different things
         * depending on `surface_type`: on `search` / `search_ad` / `guided_search` it is the
         * merchant's own typed query, which this build does not serve; on `home`, `category`,
         * `collection` and the rest it is Shopify's placement handle, which is what the "Came from"
         * column is made of.
         *
         * ⚠️ GUARDED ON READ, not only where the row is written: blanking at capture reaches only
         * rows synced from now on, and an operator upgrading this build still holds every
         * historical query in Mongo until a LIFETIME re-sync. This closes that window for the rows
         * already stored.
         *
         * ⚠️ NOT applied to the `classifyAcquisitionChannel` call above, which reads the REPOSITORY
         * row: that is where `home` + `homepage-ads` is recognised as an ad placement, and blanking
         * its input would file ~49 real ad-click installs as organic browsing.
         */
        surface_detail: attribution && !isSearchSurface(attribution.surface_type) ? attribution.surface_detail || '' : '',
        surface_inter_position: attribution && attribution.surface_inter_position != null ? attribution.surface_inter_position : null,
        surface_intra_position: attribution && attribution.surface_intra_position != null ? attribution.surface_intra_position : null,
        attribution_installed_at: attribution ? attribution.installed_at : null,
        // SIGNED, not absolute: positive means the analytics record is later than Shopify's install
        // instant. The sign is half the diagnostic — a consistent lag in one direction is export
        // latency, an inconsistent one is a mismatched row.
        attribution_lag_seconds: attribution
            ? Math.round((attribution.installed_at.getTime() - spineRow.installed_at.getTime()) / 1000)
            : null,

        state: lifecycle || STORE_LIFECYCLE_STATES.INSTALLED,
        state_label: STORE_LIFECYCLE_LABELS[lifecycle || STORE_LIFECYCLE_STATES.INSTALLED],
        state_basis: subscription && lifecycle ? subscription.state_basis : JOIN_MISS_STATE_BASIS,
        charge_link: subscription && lifecycle ? subscription.charge_link : CHARGE_LINK_STATES.ABSENT,

        plan_name: subscription && lifecycle ? subscription.plan_name : '',
        plan_price: subscription && lifecycle ? subscription.plan_price : null,
        //  PUBLISHED EVEN THOUGH NOTHING RENDERS IT YET. `storePresentation.js` hard-codes a `$`
        // in front of `plan_price`, so a EUR or GBP plan currently reads as "$29.00" — a right
        // number under a wrong currency, which is the class of defect `IMPLEMENTATION.md` §3.10
        // exists to prevent. The resolver already captures this from `charge.amount.currencyCode`;
        // emitting it costs nothing and is what lets the table be corrected without a second
        // backend change. `''` — not null — when no charge payload named one, matching `plan_name`.
        plan_currency: subscription && lifecycle ? subscription.currency || '' : '',
        //  `null` when no settled payout named a cadence. `FIDELITY.md` §5 forbids booking a null
        // interval as monthly, and the table's price sub-line is gated on this being truthy — so an
        // unknown cadence correctly hides the price instead of captioning it with an invented one.
        plan_interval: planInterval,

        trial_end: subscription && lifecycle ? subscription.trial_end : null,
        trial_days_source: subscription && lifecycle ? subscription.trial_days_source : TRIAL_DAYS_SOURCES.NONE,
        conversion_date: subscription && lifecycle ? subscription.conversion_date : null,
        churn_date: subscription && lifecycle ? subscription.churn_date : null
    };
};

/**
 * Which coverage gates on the app row make this window's answer a floor rather than a total.
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
    // THE THIRD GATE, and the one this endpoint used to ignore. `event_history_gap_days` is a
    // real, populated coverage measure (`partner/helpers/coverage.helper.ts`, surfaced by both
    // `/api/revenue/now` and `/api/partner-apps`) and a window overlapping a known event gap
    // under-counts installs, `by_state` AND `attribution_coverage` — every number on this page —
    // with nothing on screen to say so.
    //
    // ⚠️ `> 0` and an explicit finite check, never truthiness: `0` is a MEASURED "no day-wide hole",
    // the most reassuring value the field can take, and `null` is "never measured". Warning on
    // either would fire the banner on healthy data, which is how a warning stops being read.
    //
    // ⚠️ The measurement records the WIDEST gap in the whole history and not WHERE it sits, so this
    // cannot be tested against the window — which is why the warning's own wording is conditional.
    const gapDays = app.event_history_gap_days;
    if (typeof gapDays === 'number' && Number.isFinite(gapDays) && gapDays > 0) {
        out.push(_WARNINGS.eventHistoryGap(gapDays));
    }
    return out;
};

/**
 * The stores that installed in a window, how they arrived, and where they got to.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query, already cast (not coerced) by the controller.
 * @param params1.partner_app_id - The app to report on. Required.
 * @param [params1.period_days] - number, 0 or 'all' (default 30).
 * @param [params1.since] - ISO date; honoured only together with `until`.
 * @param [params1.until] - ISO date; honoured only together with `since`.
 * @param [params1.state] - One of the five lifecycle states. Unrecognised ⇒ ignored + warned.
 * @param [params1.channel] - One of the eight channels. Unrecognised ⇒ ignored + warned.
 * @param [params1.limit] - Page size, clamped to MAX_LIMIT.
 * @param [params1.page] - 1-based page.
 * @param [params1.sort] - One of the allowlisted sort keys.
 * @param [params1.sort_dir] - `asc` or `desc`.
 * @returns The cohort, or an honest refusal carrying `{}`.
 */
const getInstallCohort = (
    { user_id }: IdentityObject,
    {
        partner_app_id,
        period_days,
        since,
        until,
        state,
        channel,
        limit,
        page,
        sort,
        sort_dir
    }: InstallCohortParams
): Promise<ServiceResult<InstallCohortResponse | EmptyPayload>> => {
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
            // as of today without saying so. Checking it before the fold is what keeps that throw
            // from ever escaping this envelope.
            const asOf = win.until;
            if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
                return resolve(promiseReturnResult(false, {}, {}, 'Could not resolve a valid window for this request. Check `since`, `until` and `period_days`.'));
            }

            const warnings: string[] = [];
            const unrecognisedFilters: string[] = [];

            // ── The two tier states, each read from a WATERMARK ──────────────
            let dataState: CohortDataState = COHORT_DATA_STATES.NEVER_SYNCED;
            if (app.last_synced_at) {
                dataState = COHORT_DATA_STATES.READY;
            }
            if (dataState === COHORT_DATA_STATES.NEVER_SYNCED) {
                warnings.push(_WARNINGS.neverSynced);
            }

            const availability = resolveBigQueryAvailability();
            let attributionState: AttributionState = ATTRIBUTION_STATES.READY;
            if (!availability.enabled) {
                //  NOT a refusal. See the file header.
                attributionState = ATTRIBUTION_STATES.NOT_CONNECTED;
                warnings.push(_WARNINGS.attributionNotConnected(availability.message));
            } else if (!app.last_install_attrib_synced_at) {
                attributionState = ATTRIBUTION_STATES.NEVER_SYNCED;
                warnings.push(_WARNINGS.attributionNeverSynced);
            }

            warnings.push(..._coverageWarnings(app, win));

            // ── A. The install spine — the population ────────────────────────
            const appId = String(app._id);
            const spine = await aggregateInstallSpine({ partner_app_id: appId, since: win.since, until: win.until });
            const spineDomains = spine.rows.map((row) => row.shop_domain);

            // ── B–D. The two LEFT joins, plus the settled-payout evidence ────
            // The attribution read is SKIPPED when the tier is not connected: nothing could ever have
            // written a row, and issuing the query would only make the log read as though it had.
            const [events, settledRows, attributionRows] = await Promise.all([
                findChargeCohortEvents({ partner_app_id: appId, until: asOf, domains: spineDomains }),
                // `as_of` IS NOT OPTIONAL HERE. Without it the settled-payout evidence — the
                // input behind `state_basis: 'settled_payout'` — leaks in from after the window and
                // reports a named merchant as CONVERTED before they ever paid. See the repository.
                aggregateSettledSubscriptionCharges({ partner_app_id: appId, domains: spineDomains, as_of: asOf }),
                availability.enabled
                    ? findInstallAttributionRows({ partner_app_id: appId, domains: spineDomains })
                    : Promise.resolve<CohortAttributionRow[]>([])
            ]);

            const settledChargeIds = new Set<string>();
            const settledDomains = new Set<string>();
            const intervalByCharge = new Map<string, string>();
            for (const row of settledRows) {
                if (row.charge_id) {
                    settledChargeIds.add(row.charge_id);
                    // Only a per-CHARGE interval is published. A domain-scoped fallback would attach
                    // one subscription's cadence to another on any store with two, and an invented
                    // cadence is exactly what FIDELITY.md §5 forbids.
                    if (row.billing_interval && !intervalByCharge.has(row.charge_id)) {
                        intervalByCharge.set(row.charge_id, row.billing_interval);
                    }
                }
                if (row.shop_domain) {
                    settledDomains.add(row.shop_domain);
                }
            }

            const attributionByDomain = new Map<string, CohortAttributionRow[]>();
            for (const row of attributionRows) {
                const list = attributionByDomain.get(row.shop_domain);
                if (list) {
                    list.push(row);
                } else {
                    attributionByDomain.set(row.shop_domain, [row]);
                }
            }

            const cohortResult = resolveChargeCohortForDomains({
                events,
                as_of: asOf,
                settled_charge_ids: settledChargeIds,
                settled_domains: settledDomains,
                domains: spineDomains
            });

            // ── E–F. ONE array, ONE pass, every tally taken as it is built ───
            const cohort: InstallCohortRow[] = [];
            const byState = _zeroByState();
            const byChannel = _zeroByChannel();
            let installEvents = 0;
            let withAttribution = 0;
            let inferredStateRows = 0;
            let unclassifiedSubscriptionRows = 0;

            for (const spineRow of spine.rows) {
                const subscription = cohortResult.by_domain.get(spineRow.shop_domain);
                if (subscription && !subscription.lifecycle_state) {
                    unclassifiedSubscriptionRows += 1;
                }
                const attribution = pickNearestByInstalledAt(attributionByDomain.get(spineRow.shop_domain), spineRow.installed_at);
                const planInterval = subscription && subscription.charge_id
                    ? intervalByCharge.get(subscription.charge_id) || null
                    : null;

                const row = _buildRow(spineRow, subscription, attribution, planInterval);
                cohort.push(row);

                installEvents += row.install_count;
                byState[row.state] += 1;
                byChannel[row.channel] += 1;
                if (row.has_attribution) {
                    withAttribution += 1;
                }
                if (row.state_basis === STATE_BASIS.INFERRED) {
                    inferredStateRows += 1;
                }
            }

            const installs = cohort.length;
            const summary: InstallCohortSummary = {
                installs,
                install_events: installEvents,
                by_state: byState,
                by_channel: byChannel,
                with_attribution: withAttribution,
                // `null`, NEVER `0`. A `0` is the claim "we have attribution for none of your
                // installs"; `null` is "there is nothing here to have attribution for". And the
                // banner is gated on `typeof === 'number'`, so the two render entirely differently.
                attribution_coverage: installs > 0 ? withAttribution / installs : null
            };

            // ── Fail-open filter validation ──────────────────────────────────
            const rawState = state === undefined || state === null ? '' : String(state).trim();
            let stateFilter = '';
            if (rawState !== '') {
                if (_isLifecycleState(rawState)) {
                    stateFilter = rawState;
                } else {
                    unrecognisedFilters.push(`state=${rawState}`);
                    warnings.push(_WARNINGS.unrecognisedState(rawState));
                }
            }

            const rawChannel = channel === undefined || channel === null ? '' : String(channel).trim();
            let channelFilter = '';
            if (rawChannel !== '') {
                if (_isChannel(rawChannel)) {
                    channelFilter = rawChannel;
                } else {
                    unrecognisedFilters.push(`channel=${rawChannel}`);
                    warnings.push(_WARNINGS.unrecognisedChannel(rawChannel));
                }
            }

            const rawSort = sort === undefined || sort === null ? '' : String(sort).trim();
            let sortKey: InstallCohortSortKey = DEFAULT_INSTALL_COHORT_SORT_KEY;
            if (rawSort !== '') {
                if (_isSortKey(rawSort)) {
                    sortKey = rawSort;
                } else {
                    unrecognisedFilters.push(`sort=${rawSort}`);
                    warnings.push(_WARNINGS.unrecognisedSort(rawSort));
                }
            }
            const sortDir: SortDirection = String(sort_dir || '').trim().toLowerCase() === 'asc'
                ? 'asc'
                : DEFAULT_INSTALL_COHORT_SORT_DIR;

            const filtered = cohort.filter((row) => {
                if (stateFilter && row.state !== stateFilter) {
                    return false;
                }
                if (channelFilter && row.channel !== channelFilter) {
                    return false;
                }
                return true;
            });

            // SORT A COPY. `filter` happens to return a new array today, so nothing is wrong right
            // now — but the tallies above were taken from `cohort`, and the day someone skips the
            // filter when no filter is set, an in-place sort reorders the very array those tallies
            // came from. It is free to make that impossible rather than true by coincidence.
            const sorted = [...filtered].sort((a, b) => _compareRows(a, b, sortKey, sortDir));

            const total = sorted.length;
            const pageLimit = positiveInt(limit, DEFAULT_LIMIT, MAX_LIMIT);
            const pages = total > 0 ? Math.ceil(total / pageLimit) : 0;
            const pageNumber = Math.min(positiveInt(page, 1, Number.MAX_SAFE_INTEGER), Math.max(pages, 1));
            const items = sorted.slice((pageNumber - 1) * pageLimit, pageNumber * pageLimit);

            if (total > items.length) {
                // The page hard-codes `limit: 500` and never paginates — its "Show all N" button
                // counts `items.length`, not `pagination.total` — so `warnings[]` is the ONLY channel
                // through which a reader can discover that the table is not the whole answer.
                warnings.push(_WARNINGS.truncated(items.length, total));
            }

            // ── Everything that was excluded, said out loud ──────────────────
            const cohortDiagnostics = cohortResult.diagnostics;
            if (inferredStateRows > 0) {
                warnings.push(_WARNINGS.inferredStates(inferredStateRows));
            }
            if (cohortDiagnostics.test_subscriptions_excluded > 0) {
                warnings.push(_WARNINGS.testSubscriptionsExcluded(cohortDiagnostics.test_subscriptions_excluded));
            }
            if (spine.shopless_install_events > 0) {
                warnings.push(_WARNINGS.shoplessInstallEvents(spine.shopless_install_events));
            }
            if (cohortDiagnostics.skipped_keyless > 0) {
                warnings.push(_WARNINGS.skippedKeylessSubscriptionEvents(cohortDiagnostics.skipped_keyless));
            }
            if (unclassifiedSubscriptionRows > 0) {
                warnings.push(_WARNINGS.unclassifiedSubscriptions(unclassifiedSubscriptionRows));
            }
            // THE CANCEL TRAP AND THE `billingOn` GAP, IN THE RESOLVER'S OWN WORDS.
            //
            // One wording, owned by the fold that measures it, so this table and the custom funnel
            // cannot describe the same exposure two ways. It returns `[]` when both counters are
            // zero, so it needs no guard of its own — and it is pushed at exactly ONE site, which is
            // what keeps `warnings[]` unique here: unlike the funnel payload this one does not
            // de-duplicate, and `test/installCohort.test.js:358` fails on a repeat.
            //
            // ⚠️ MEASUREMENT ONLY. No state, count or trial figure above has been adjusted for
            // either exposure — the sentences say so, and they must keep saying so.
            warnings.push(...describeChargeCohortExposure(cohortDiagnostics));

            const diagnostics: InstallCohortDiagnostics = {
                spine_domains: spine.rows.length,
                shopless_install_events: spine.shopless_install_events,
                skipped_keyless_subscription_events: cohortDiagnostics.skipped_keyless,
                test_excluded: cohortDiagnostics.test_subscriptions_excluded,
                inferred_state_rows: inferredStateRows,
                unclassified_subscription_rows: unclassifiedSubscriptionRows,
                //  Counts SUBSCRIPTIONS, not rows — including the ones a store superseded. A
                // row-level tally would file every store that never subscribed under `absent`, which
                // has nothing to do with how well a charge is linked to its payload.
                charge_link: {
                    resolved: cohortDiagnostics.charge_link.resolved,
                    unresolved: cohortDiagnostics.charge_link.unresolved,
                    absent: cohortDiagnostics.charge_link.absent
                },
                // MEASUREMENT ONLY. Not one figure above — not `summary.by_state`, not a row's
                // `state`, not a `trial_end` — has been adjusted for either of these. They are the
                // exposure a plan change creates in a charge-keyed cohort, published so the size of
                // it is knowable before anyone decides to act on it.
                //
                // ⚠️ Passed through by reference from the fold rather than re-tallied here. A second
                // count over the same subscriptions is a second answer to one question, and the one
                // on screen would be whichever ran last — the same rule `charge_link` above follows.
                supersession: cohortDiagnostics.supersession,
                billing_on_gap: cohortDiagnostics.billing_on_gap,
                unrecognised_filters: unrecognisedFilters
            };

            let periodDays: number | 'all' | null = win.periodDays;
            if (win.isLifetime) {
                periodDays = 'all';
            }

            const payload: InstallCohortResponse = {
                app_id: appId,
                app_name: app.display_name,
                period_label: win.periodLabel,
                period_days: periodDays,
                kind: win.kind,
                since: _iso(win.since),
                until: win.until.toISOString(),
                as_of: asOf.toISOString(),

                items,
                summary,
                states: STORE_LIFECYCLE_LABELS,
                // Straight from the vocabulary, whose KEY ORDER IS THE ON-SCREEN ORDER — the page
                // builds its channel Select by iterating `Object.keys` on this object. Never rebuild
                // it from a tally, whose key order is insertion order and therefore data-dependent.
                channels: ACQUISITION_CHANNEL_LABELS,
                warnings,

                filter_state: stateFilter,
                filter_channel: channelFilter,

                pagination: { page: pageNumber, limit: pageLimit, total, pages },
                sort: { key: sortKey, dir: sortDir },

                data_state: dataState,
                attribution_state: attributionState,
                diagnostics
            };

            // THE BANNER'S BODY, AND THE ONLY WAY IT SURVIVES THE FRONTEND'S GATE. `dataState.js`
            // intercepts `data_state === 'NEVER_SYNCED'`, NULLS `data` — warnings and all — and
            // renders the banner body as `data.unknown_reason || resp.msg`. Without this field that
            // resolves to the SUCCESS message, so the page prints "Install cohort resolved." under
            // the heading "Nothing synced yet", and the carefully written explanation above is
            // discarded with the payload. `unknown_reason` is the established convention on this
            // exact path (`bigQueryAnalytics.service.ts` sets it for the same reason).
            if (dataState === COHORT_DATA_STATES.NEVER_SYNCED) {
                payload.unknown_reason = _WARNINGS.neverSynced;
            }

            //  A 200 with zero rows, always. The three ways to have nothing to show are separated
            // by `data_state`, `attribution_state` and `warnings[]` — never by a refusal, and never
            // by a 404.
            return resolve(promiseReturnResult(true, payload, {}, 'Install cohort resolved.'));
        } catch (error) {
            customConsoleError('ERROR: Conversion installCohortService getInstallCohort', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read the install cohort. Please try again.'));
        }
    });
};

export = {
    getInstallCohort
};
