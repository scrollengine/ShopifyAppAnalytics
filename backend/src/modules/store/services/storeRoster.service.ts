'use strict';

/**
 * ============================================================================
 *  EVERY STORE THIS APP HAS EVER BEEN INSTALLED ON, AND WHAT IT IS NOW
 * ============================================================================
 *
 *  Serves the Stores page. The population is "every store, ever" — replayed from the Partner API's
 *  relationship events — which makes this the only list in the suite that can answer a question
 *  about stores that LEFT. The Subscriptions list cannot: its population is "currently paying", so a
 *  store that never subscribed is absent from it and so is a store that paid for two years and then
 *  uninstalled. Reading that list as "our customers" erases churn by construction.
 *
 *  ──  THERE IS NO STORE COLLECTION. EVERY FIELD IS FOLDED ON READ. ───────────────────────
 *
 *  A materialised roster would store a derivable value, so its only possible relationship with truth
 *  is agreement or drift — and the drift is invisible and directional: store sync at 02:00, partner
 *  sync at 02:30, a shop uninstalls at 02:15, and `install_state: 'INSTALLED'` stands for
 *  twenty-four hours on a page whose entire purpose is "who has my app right now". The repository
 *  header carries the full argument and the cost of the alternative, which is real and is stated
 *  rather than hidden.
 *
 *  ── ONE `rows` ARRAY. ONE PASS. EVERY NUMBER DERIVED FROM IT. ────────────────────────────
 *
 *  There is no second `countDocuments` and no second aggregation anywhere in this file. The tab
 *  counts, the facet counts, the pagination total and the rows in the table are all folds over the
 *  SAME array, so they cannot disagree. Two queries that answer the same question are two answers
 *  that will eventually differ, and the one on screen will be whichever the reader happened to look
 *  at.
 *
 *  ──  THE FOLD ITSELF LIVES IN `resolvers/storeRoster.resolver`, AND SHARES ITS ANSWER ────
 *
 *  The five reads, the install-state fold, the charge cohort, the canonical MRR predicate, the
 *  attribution join and the row build were a private block in this file while there was one caller.
 *  `GET /api/subscriptions` is the second, and it renders the SAME rows through the SAME table into
 *  the SAME drawer — so copying the block to serve it would have produced a second definition of
 *  "is this shop paying", which is precisely the divergence `modules/revenue/index.ts` records from
 *  the system this was extracted from. This file now owns the PRESENTATION of the roster —
 *  validation, facets, counts, sort, paging, warnings, wire shape — and nothing else.
 *
 *  `install_state_counts` is PRE-FILTER and `install_state_counts_filtered` applies every OTHER
 *  facet — that is not a violation of the rule but a consequence of it. The first labels the tab row
 *  (a post-filter count would make every unselected tab read `(0)` the moment one is chosen), the
 *  second predicts what clicking a tab will actually show. Standard faceted counting: one source,
 *  two projections.
 *
 *  ── ONE JUDGEMENT INSTANT, RESOLVED ONCE, THREADED EVERYWHERE ────────────────────────────
 *
 *  `as_of` is read from the clock exactly once, HERE, and passed into every read and every fold.
 *  Nothing below it touches `new Date()`. That is what makes a single response internally
 *  consistent: without it the payout rollup, the state machine and the install fold each answer as
 *  of a slightly different millisecond, and a store can be simultaneously CHURNED and paying.
 *
 *  ── EVERY NUMBER ON THE WIRE IS A BARE NUMBER ────────────────────────────
 *
 *  Not a `confidence.helper` envelope, and this is one of the places `IMPLEMENTATION.md` §3.11 must
 *  NOT be applied. `fmtMoney(envelope)` is `Number({…})` → `NaN`, and `pagination.total
 *  .toLocaleString()` throws outright. Wrapping these MANUFACTURES the missing figure the rule
 *  exists to prevent. The honesty contract is discharged through fields that survive rendering:
 *  `has_attribution`, `has_install_record`, `install_state: 'UNKNOWN'`, `customer_name_source`,
 *  `state_basis`, `trial_days_source`, `spend_currency`, `data_state`, `attribution_state`, `meta`,
 *  `diagnostics` and `warnings[]`.
 *
 *  ── THE DISCRIMINATOR IS THE WATERMARK, NEVER THE ROW COUNT ─────────────────
 *
 *  No stores plus `last_synced_at` is a real, publishable "nobody has ever installed this app". No
 *  stores and no watermark is "we have not looked yet". Those must never render alike, and a row
 *  count cannot tell them apart.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import listQueryHelper = require('../../shared/helpers/listQuery.helper');
import conversion = require('../../conversion');
import storeConstants = require('../constants/storeRoster.constants');
import storeFacetHelper = require('../helpers/storeFacet.helper');
import storeSortHelper = require('../helpers/storeSort.helper');
import storeRosterResolver = require('../resolvers/storeRoster.resolver');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { StoreFacetSelection } from '../types/storeFacet.types';
import type {
    StoreAttributionState,
    StoreDataState,
    StoreFacetGroup,
    StoreFacetGroupKey,
    StoreFacetOption,
    StoreInstallStateCounts,
    StoreRosterDiagnostics,
    StoreRosterParams,
    StoreRosterResponse,
    StoreRosterRow,
    StoreRosterSortKey,
    StoreSortDirection
} from '../types/storeRoster.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { positiveInt } = listQueryHelper;
// Through the barrel. `modules/conversion` publishes exactly the vocabulary this one renders from,
// and says in its own header why: a sibling that cannot reach the canonical definition grows a
// second one, and then one merchant is CONVERTED on one page and ON_TRIAL on another.
const { STORE_LIFECYCLE_LABELS, STORE_LIFECYCLE_STATE_ORDER } = conversion;
const { resolveStoreRosterFold } = storeRosterResolver;
const {
    STORE_INSTALL_STATE_LABELS,
    STORE_INSTALL_STATE_ORDER,
    ALL_COUNT_KEY,
    STORE_ROSTER_SORT_KEYS,
    DEFAULT_STORE_SORT_KEY,
    DEFAULT_STORE_SORT_DIR,
    DEFAULT_LIMIT,
    MAX_LIMIT,
    STORE_FACET_GROUPS,
    STORE_RECORD_FACETS,
    STORE_RECORD_FACET_LABELS,
    NOT_PUSHED_FACET,
    NOT_PUSHED_FACET_LABEL,
    BILLING_INTERVAL_UNKNOWN,
    BILLING_INTERVAL_LABELS,
    STORE_DATA_STATES,
    STORE_ATTRIBUTION_STATES
} = storeConstants;
const { storeFacetValue, matchesAllFacets, matchesSearch } = storeFacetHelper;
const { compareStoreRows } = storeSortHelper;

/**
 * The declared facet groups, as an array, so every loop over them covers all of them.
 *
 * ⚠️ The one `as` in this file, and it is a WIDENING of `Object.keys`, which is typed `string[]`
 * whatever it is given. The alternative — a hand-written list of the six keys — is worse in the way
 * this module cares about: it can drift from `STORE_FACET_GROUPS`, and a group that gains a
 * checkbox without gaining a predicate is exactly the failure the facet helper's header describes.
 * Derived from the vocabulary, the two cannot disagree.
 */
const _FACET_KEYS = Object.keys(STORE_FACET_GROUPS) as StoreFacetGroupKey[];

/**
 * Widened copies of the frozen vocabularies, so a `string` from the query bag can be tested against
 * them and a `string` value can index a label map — both without an `as` cast, which this codebase
 * reserves for the model chokepoint. Assignment widens; it does not re-type anything.
 */
const _STATE_KEYS: readonly string[] = STORE_LIFECYCLE_STATE_ORDER;
const _INSTALL_STATE_KEYS: readonly string[] = STORE_INSTALL_STATE_ORDER;
const _INSTALL_STATE_LABEL_MAP: Readonly<Record<string, string>> = STORE_INSTALL_STATE_LABELS;
const _LIFECYCLE_LABEL_MAP: Readonly<Record<string, string>> = STORE_LIFECYCLE_LABELS;
const _STORE_RECORD_LABEL_MAP: Readonly<Record<string, string>> = STORE_RECORD_FACET_LABELS;

/** @param value - A candidate sort key. @returns Whether it is in the allowlist. */
const _isSortKey = (value: string): value is StoreRosterSortKey => STORE_ROSTER_SORT_KEYS.includes(value);

/**
 *  THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * `stores/index.js:334` renders one `<p>` per warning KEYED BY THE STRING ITSELF. Two identical
 * strings are a duplicate-key React warning and one of them is silently dropped — so a second copy
 * of a message does not double up, it DISAPPEARS, and takes its condition with it. Keeping them
 * together is what makes that checkable by eye; the emit path also de-duplicates, so a message that
 * can legitimately be produced twice cannot take its own twin down.
 *
 * Each is written for an operator who cannot see this code: it says what is missing, what that does
 * to the numbers beside it, and what would fix it.
 */
const _WARNINGS = Object.freeze({
    neverSynced: 'No Partner sync has completed for this app yet, so no install events have been fetched. '
        + 'An empty list below means we have not looked — not that nobody has installed your app.',

    /** ⚠️ Carries the availability message verbatim, so the operator reads the missing variable names. */
    attributionNotConnected: (message: string): string => `${message} `
        + 'Every store below therefore shows as "Not attributed", and the install-traffic country is blank for '
        + 'all of them; that is a missing data source, not evidence of direct arrival.',

    attributionNeverSynced: 'Listing analytics is configured, but the install-attribution sync has never '
        + 'completed for this app, so acquisition here is at best partial. Any store showing as "Not attributed" '
        + 'reflects that missing sync rather than evidence of direct arrival.',

    lifetimeFloor: 'No lifetime Partner sync has ever completed for this app, so this roster is a FLOOR rather '
        + 'than a total — there may be older stores that have never been fetched, and stores whose install '
        + 'predates the synced window show an unknown install state.',

    /**
     * ⚠️ Fires on the app-level measurement, which records the WIDEST gap in the whole event history
     * and NOT where it sits. `null` is "never measured" and `0` is a real, reassuring "no day-wide
     * hole"; neither warns.
     */
    eventHistoryGap: (days: number): string => `The Partner event history for this app contains a stretch of `
        + `${days} day(s) carrying no events at all. Any install or uninstall inside that stretch is missing from `
        + 'this roster, so both the store count and the install-state split below are floors. The data cannot say '
        + 'whether it was a genuinely quiet period or a sync window that failed and was never re-pulled, which is '
        + 'why it is published here rather than resolved.',

    shopNameCoverage: (since: string): string => `Store names are filled from the Partner API only for events `
        + `synced since ${since}. Older stores show their myshopify domain instead, which is not a missing name — `
        + 'run a LIFETIME Partner sync to fill in the rest.',

    /**
     *  THE WIDEST BOUNDARY OF ALL, AND IT USED TO PRODUCE NO WARNING WHATSOEVER.
     *
     * `shop_name_coverage_since` is null with a non-null `earliest_event_at` when NO event we hold
     * carries a name — no sync has run since the `name` selection landed. That is the state
     * `partnerApp.model.ts` documents as needing this sentence most, and the boundary test skipped
     * it: every store rendered a bare domain, page-wide, with nothing on screen to say why. It is
     * the same silence `partnerCoverage.repository.ts`'s `$exists: true` comment was written to
     * prevent, reintroduced one layer up.
     */
    shopNameCoverageNone: 'No synced Partner event carries a store name yet, so EVERY store below shows its '
        + 'myshopify domain. That is sync state rather than missing data — store names were added to the event '
        + 'record after this collection was in use, and only a sync that has run since then fills them. Run a '
        + 'LIFETIME Partner sync.',

    noTransactions: 'No settled payouts have ever been fetched for this app, so every spend figure below is empty '
        + 'because there is nothing to sum — not because these stores pay nothing. Run a Partner sync, and check '
        + 'that your Partner API token has payout access.',

    shoplessRelationshipEvents: (events: number): string => `${events} install/uninstall event(s) carried no shop `
        + 'domain and could not be attached to a store. They are excluded from every count on this page rather than '
        + 'pooled into one synthetic store.',

    futureRelationshipEvents: (events: number): string => `${events} install/uninstall event(s) are dated in the `
        + 'future and were ignored when deciding install state. That is clock skew between Shopify and this server, '
        + 'or a corrupted row — the stores are still listed, using their most recent event that has actually happened.',

    storesWithoutInstallRecord: (stores: number): string => `${stores} store(s) below have no install or uninstall `
        + 'event on record and show an unknown install state. They are known only from a charge or a payout, which '
        + 'usually means their install predates the synced event history — it is not evidence that the app is absent.',

    attributionRowsWithoutPartnerRecord: (rows: number): string => `${rows} listing-analytics install record(s) `
        + 'name a store the Partner API has no record of, so they produced no row here. The Partner event history is '
        + 'the roster; a store that appears only in listing analytics is a gap in the Partner sync, not a store.',

    mixedSpendCurrency: (stores: number): string => `${stores} store(s) have settled payouts in more than one `
        + 'currency. Their total spend is a sum of unlike units — this build holds no exchange rates — so those rows '
        + 'publish no currency and the figure should not be read as an amount in any one of them.',

    inferredStates: (rows: number): string => `${rows} store(s) below are shown as "On trial" on the weakest `
        + 'evidence available: Shopify supplied no billing date for their subscription and no payout has settled '
        + 'against it yet. That is the reading which claims no revenue and no loss, not a measured trial.',

    testSubscriptionsExcluded: (subscriptions: number): string => `${subscriptions} test subscription(s) were `
        + 'excluded from the Status column. Partner install events carry no test flag at all, so those stores are '
        + 'still listed and still counted as installs — the two sides of this table are asymmetric and no available '
        + 'data can reconcile them.',

    skippedKeylessSubscriptionEvents: (events: number): string => `${events} subscription event(s) carried neither `
        + 'a charge id nor a shop domain and were skipped rather than pooled. Pooling them would have invented one '
        + 'merged subscription out of many.',

    unclassifiedSubscriptions: (rows: number): string => `${rows} store(s) have a subscription whose state could `
        + 'not be mapped to one of the five store states, and are shown as "Installed only". That is a defect in this '
        + 'build, not a fact about those merchants — please report it.',

    unrecognisedFacet: (group: string, value: string): string => `The ${group} filter "${value}" is not a value this `
        + 'endpoint can evaluate, so it has been ignored and the list below is wider than you asked for.',

    unrecognisedSort: (value: string): string => `The sort key "${value}" is not sortable here, so the default sort `
        + `(${DEFAULT_STORE_SORT_KEY}, newest first) has been used instead. Valid values: `
        + `${STORE_ROSTER_SORT_KEYS.join(', ')}.`,

    limitClamped: (requested: string, applied: number): string => `A page size of ${requested} was requested; this `
        + `endpoint serves at most ${applied} stores per page, so the list below is one page of that size. `
        + 'The `pagination` block carries the real total.',

    /**
     *  The countries link exists and cannot be honoured. Explained rather than silently dropped:
     * the Revenue → By country tab pushes an ISO-2 CODE, and the only per-store country this build holds is
     * GA4's common NAME for the install traffic. A facet that matched nothing would look like a
     * merchant with no stores in that country.
     */
    countriesUnsupported: 'A country filter was requested and has been ignored. The only per-store country this '
        + 'build holds is the country the INSTALL TRAFFIC came from, recorded by listing analytics as a name '
        + '("United States") rather than a two-letter code — so it cannot be matched against the code the Countries '
        + 'page links with. Every store is listed below, unfiltered.'
});

/**
 * An ISO string, or null.
 *
 * @param [value] - Any stored or resolved date.
 * @returns The ISO form, or null when there is no date.
 */
const _iso = (value?: Date | null): string | null => {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        return null;
    }
    return value.toISOString();
};

/**
 * A comma-joined query parameter split into distinct, non-empty values.
 *
 * De-duplicated because a repeated value would tally its warning twice and, worse, would be
 * indistinguishable from two different unrecognised values in the diagnostics echo.
 *
 * @param raw - The parameter as it arrived: a string, or anything at all.
 * @returns The values, in the order given, without repeats.
 */
const _splitCsv = (raw: unknown): string[] => {
    if (raw === null || raw === undefined) {
        return [];
    }
    const out: string[] = [];
    for (const part of String(raw).split(',')) {
        const value = part.trim();
        if (value !== '' && out.indexOf(value) === -1) {
            out.push(value);
        }
    }
    return out;
};

/**
 * The groups whose vocabulary is CLOSED — the endpoint knows every value they can take.
 *
 *  FOUR, NOT TWO. `install_states` and `states` were checked from the first release and `billing`
 * and `store_records` were not, even though both are closed: `storeFacetValue` returns exactly
 * `plan_interval || 'UNKNOWN'` for the first and exactly one of the two `STORE_RECORD_FACETS`
 * members for the second. Treated as open, `?billing=MONTHLY` or
 * `?store_records=has_operator_profile` was ACCEPTED, matched no row, and returned an EMPTY table
 * with no warning — the exact "a typo must widen, not empty" rule `storeFacet.helper`'s header
 * states, and indistinguishable on screen from a business with no stores.
 *
 * ⚠️ `store_statuses` and `shopify_plans` genuinely hold operator-pushed free text and MUST stay
 * open: rejecting a value the operator legitimately pushed would be a filter that refuses its own
 * data.
 */
const _CLOSED_FACET_VOCABULARY: Partial<Record<StoreFacetGroupKey, readonly string[]>> = Object.freeze({
    install_states: _INSTALL_STATE_KEYS,
    states: _STATE_KEYS,
    billing: Object.keys(BILLING_INTERVAL_LABELS),
    store_records: [STORE_RECORD_FACETS.HAS_OPERATOR_PROFILE, STORE_RECORD_FACETS.NO_OPERATOR_PROFILE]
});

/**
 * Every value the ROSTER actually produced for one group.
 *
 *  THE ESCAPE HATCH THAT KEEPS THE CLOSED CHECK FROM CONTRADICTING THE CHECKBOXES. The options a
 * group offers are `_alwaysOffered` plus whatever `storeFacetValue` returned over `rows`, so a
 * cadence Shopify sends that this build has never seen would be OFFERED as an option and then
 * REJECTED on selection — a checkbox that ticks and empties the table, which is worse than the bug
 * being fixed. Consulted only when the declared vocabulary has already said no, so it costs a pass
 * over the roster on a rejected value and nothing at all otherwise.
 *
 * @param rows - The whole roster.
 * @param groupKey - The group.
 * @returns Every bucket at least one row is in.
 */
const _observedFacetValues = (rows: readonly StoreRosterRow[], groupKey: StoreFacetGroupKey): Set<string> => {
    const seen = new Set<string>();
    for (const row of rows) {
        seen.add(storeFacetValue(row, groupKey));
    }
    return seen;
};

/**
 * The values of one facet group that this endpoint can actually evaluate.
 *
 * ⚠️ FAIL-OPEN. Anything unrecognised is DROPPED and reported, never matched — a typo must widen the
 * result set, not empty it. A value survives when the group's vocabulary is open, when the declared
 * vocabulary contains it, or when the roster in front of us actually produced it.
 *
 * @param groupKey - The group.
 * @param raw - The parameter exactly as it arrived.
 * @param rows - The whole roster, for the observed-value fallback above.
 * @param rejected - Mutated: every dropped value is appended as `group=value`.
 * @param warnings - Mutated: one operator-facing sentence per dropped value.
 * @returns The values worth applying.
 */
const _validateFacetValues = (
    groupKey: StoreFacetGroupKey,
    raw: unknown,
    rows: readonly StoreRosterRow[],
    rejected: string[],
    warnings: string[]
): string[] => {
    const values = _splitCsv(raw);
    if (values.length === 0) {
        return [];
    }
    const vocabulary = _CLOSED_FACET_VOCABULARY[groupKey];
    let observed: Set<string> | null = null;
    const out: string[] = [];
    for (const value of values) {
        let ok = true;
        if (vocabulary && vocabulary.indexOf(value) === -1) {
            if (observed === null) {
                observed = _observedFacetValues(rows, groupKey);
            }
            ok = observed.has(value);
        }
        if (ok) {
            out.push(value);
        } else {
            rejected.push(`${groupKey}=${value}`);
            warnings.push(_WARNINGS.unrecognisedFacet(STORE_FACET_GROUPS[groupKey], value));
        }
    }
    return out;
};

/**
 * A tally of one facet group's values over the rows that pass every OTHER group.
 *
 *  THE OPTIONS AND THE PREDICATE COME FROM THE SAME FUNCTION. `storeFacetValue` decides a row's
 * bucket here and in `matchesFacetGroup`, so a checkbox that the backend cannot evaluate is
 * unrepresentable rather than merely unlikely.
 *
 * @param rows - The whole roster.
 * @param groupKey - The group being tallied.
 * @param selection - Every group's validated values.
 * @param needle - The lowercased search query, applied to the tally like any other filter.
 * @returns Value → count, in first-seen order.
 */
const _tallyFacet = (
    rows: readonly StoreRosterRow[],
    groupKey: StoreFacetGroupKey,
    selection: StoreFacetSelection,
    needle: string
): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const row of rows) {
        if (!matchesSearch(row, needle) || !matchesAllFacets(row, selection, storeFacetValue, groupKey)) {
            continue;
        }
        const value = storeFacetValue(row, groupKey);
        counts.set(value, (counts.get(value) || 0) + 1);
    }
    return counts;
};

/**
 * The on-screen label for one facet value.
 *
 * @param groupKey - The group.
 * @param value - The value.
 * @returns The label, falling back to the raw value — never blank.
 */
const _facetLabel = (groupKey: StoreFacetGroupKey, value: string): string => {
    if (groupKey === 'install_states') {
        return _INSTALL_STATE_LABEL_MAP[value] || value;
    }
    if (groupKey === 'states') {
        return _LIFECYCLE_LABEL_MAP[value] || value;
    }
    if (groupKey === 'billing') {
        return BILLING_INTERVAL_LABELS[value] || value;
    }
    if (groupKey === 'store_records') {
        return _STORE_RECORD_LABEL_MAP[value] || value;
    }
    return value === NOT_PUSHED_FACET ? NOT_PUSHED_FACET_LABEL : value;
};

/**
 * The values a group must offer even when no row is in them.
 *
 *  A GROUP THAT OMITS ITS EMPTY BUCKETS MAKES A SAMPLE LOOK LIKE A DISTRIBUTION. Three stores on
 * Shopify Plus with 9,997 stores unpushed renders as "100% Plus" unless the "Not pushed" bucket is
 * there holding the denominator. The two closed vocabularies publish every member for the same
 * reason: a state missing because its count is zero reads as "we did not measure it".
 *
 * @param groupKey - The group.
 * @returns Values to include at zero if nothing else produced them.
 */
const _alwaysOffered = (groupKey: StoreFacetGroupKey): readonly string[] => {
    if (groupKey === 'install_states') {
        return _INSTALL_STATE_KEYS;
    }
    if (groupKey === 'states') {
        return _STATE_KEYS;
    }
    if (groupKey === 'billing') {
        return [BILLING_INTERVAL_UNKNOWN];
    }
    if (groupKey === 'store_records') {
        return [STORE_RECORD_FACETS.HAS_OPERATOR_PROFILE, STORE_RECORD_FACETS.NO_OPERATOR_PROFILE];
    }
    return [NOT_PUSHED_FACET];
};

/**
 * One facet group, built from the roster it will filter.
 *
 * Ordering: the always-offered values first, in vocabulary order, then whatever the data produced,
 * commonest first. Vocabulary order is a contract for the two closed groups (the install-state tabs
 * iterate it), and count order is the only useful ordering for an open one — an operator scanning
 * their Shopify plan mix wants the big buckets at the top, not alphabetical.
 *
 * @param groupKey - The group.
 * @param rows - The whole roster.
 * @param selection - Every group's validated values.
 * @param needle - The lowercased search query.
 * @returns The group, its label and its options with counts.
 */
const _buildFacetGroup = (
    groupKey: StoreFacetGroupKey,
    rows: readonly StoreRosterRow[],
    selection: StoreFacetSelection,
    needle: string
): StoreFacetGroup => {
    const counts = _tallyFacet(rows, groupKey, selection, needle);
    const options: StoreFacetOption[] = [];
    const seen = new Set<string>();

    for (const value of _alwaysOffered(groupKey)) {
        seen.add(value);
        options.push({ value, label: _facetLabel(groupKey, value), count: counts.get(value) || 0 });
    }

    const rest = [...counts.entries()]
        .filter(([value]) => !seen.has(value))
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
    for (const [value, count] of rest) {
        options.push({ value, label: _facetLabel(groupKey, value), count });
    }

    return { key: groupKey, label: STORE_FACET_GROUPS[groupKey], options };
};

/**
 * Install-state tallies over a set of rows, with every state present and the `ALL` key the tab row
 * reads.
 *
 * ⚠️ Zeros are PRESENT, never omitted. A key missing because its count is zero removes that tab's
 * number entirely, which reads on screen as "we did not measure it" rather than as "it is zero".
 *
 * @param rows - The rows to tally.
 * @returns Every state at its count, plus `ALL`.
 */
const _installStateCounts = (rows: readonly StoreRosterRow[]): StoreInstallStateCounts => {
    const counts: StoreInstallStateCounts = { [ALL_COUNT_KEY]: rows.length };
    for (const state of _INSTALL_STATE_KEYS) {
        counts[state] = 0;
    }
    for (const row of rows) {
        counts[row.install_state] = (counts[row.install_state] || 0) + 1;
    }
    return counts;
};

/**
 * Which coverage gates on the app row make this roster a floor rather than a total.
 *
 * These read the measurements a sync records ABOUT ITS OWN COMPLETENESS. They never change a number
 * — they say what the number cannot include.
 *
 * @param app - The app row.
 * @param storeCount - How many stores the roster produced, so a warning about an empty
 *   money ledger is not fired at an app that has no stores either.
 * @returns Zero or more warning strings.
 */
const _coverageWarnings = (app: PartnerAppDoc, storeCount: number): string[] => {
    const out: string[] = [];
    if (!app.lifetime_sync_completed_at) {
        // The roster has no window at all — it is always an all-time question — so this gate applies
        // unconditionally here, unlike on a windowed endpoint where it fires only for lifetime.
        out.push(_WARNINGS.lifetimeFloor);
    }

    // ⚠️ `> 0` and an explicit finite check, never truthiness: `0` is a MEASURED "no day-wide hole",
    // the most reassuring value the field can take, and `null` is "never measured". Warning on
    // either would fire the banner on healthy data, which is how a warning stops being read.
    const gapDays = app.event_history_gap_days;
    if (typeof gapDays === 'number' && Number.isFinite(gapDays) && gapDays > 0) {
        out.push(_WARNINGS.eventHistoryGap(gapDays));
    }

    // The store-name backfill boundary, and it has THREE states rather than two. Equal to the
    // earliest event ⇒ there is no boundary left to report and the sentence would be noise; NEWER ⇒
    // the rows below it show a domain; NULL beside a real `earliest_event_at` ⇒ the boundary is the
    // whole history and NO row carries a name at all. That last one produced nothing at all until
    // this branch existed — see `shopNameCoverageNone`.
    const nameSince = app.shop_name_coverage_since;
    const earliest = app.earliest_event_at;
    if (nameSince instanceof Date) {
        if (!(earliest instanceof Date) || nameSince.getTime() > earliest.getTime()) {
            out.push(_WARNINGS.shopNameCoverage(nameSince.toISOString()));
        }
    } else if (earliest instanceof Date) {
        out.push(_WARNINGS.shopNameCoverageNone);
    }

    // A roster with stores but no money floor at all: every spend column is blank because the ledger
    // is empty, which is a sync problem and not a business fact.
    if (storeCount > 0 && !app.earliest_transaction_at) {
        out.push(_WARNINGS.noTransactions);
    }
    return out;
};

/**
 * Every store this app has ever been installed on, with its current install state.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query, already cast (not coerced) by the controller.
 * @param params1.partner_app_id - The app to report on. Required.
 * @param [params1.page] - 1-based page.
 * @param [params1.limit] - Page size, clamped to MAX_LIMIT.
 * @param [params1.q] - Free text over name, domain and plan.
 * @param [params1.sort] - One of the allowlisted sort keys. Unrecognised ⇒ ignored + warned.
 * @param [params1.dir] - `asc` or `desc`.
 * @param [params1.install_states] - Comma-joined facet values. Unrecognised ⇒ ignored + warned.
 * @param [params1.states] - Comma-joined lifecycle states.
 * @param [params1.billing] - Comma-joined billing cadences.
 * @param [params1.store_records] - Whether an operator profile has been pushed.
 * @param [params1.store_statuses] - The operator's Admin-API reachability verdict.
 * @param [params1.shopify_plans] - The merchant's Shopify plan tier.
 * @param [params1.refresh] - Accepted and ignored: there is no cache to invalidate.
 * @param [params1.countries] - Accepted, ignored and warned about. See the warning catalogue.
 * @returns The roster, or an honest refusal carrying `{}`.
 */
const getStoreRoster = (
    { user_id }: IdentityObject,
    {
        partner_app_id,
        page,
        limit,
        q,
        sort,
        dir,
        install_states,
        states,
        billing,
        store_records,
        store_statuses,
        shopify_plans,
        countries
    }: StoreRosterParams
): Promise<ServiceResult<StoreRosterResponse | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'partner_app_id is required. Read it from GET /api/partner-apps.'));
            }

            // THE ONE JUDGEMENT INSTANT. Read once, HERE, and threaded into every read and every
            // fold beneath it. Without it the payout rollup, the state machine and the install fold
            // each answer as of a different millisecond, and a store can be simultaneously CHURNED
            // and paying.
            const asOf = new Date();

            // ── THE POPULATION, FOLDED ONCE, SHARED WITH `GET /api/subscriptions` ───
            //
            //  Everything this call does used to be written out below: five reads, the
            // install-state fold, the charge cohort, the canonical MRR predicate, the attribution
            // join and the row build. It moved into a resolver the day a second page needed the same
            // rows. Nothing about it changed in the move — this service still owns every judgement
            // about how the result is PRESENTED, and none about how it is derived.
            const fold = await resolveStoreRosterFold({ partner_app_id: String(partner_app_id), as_of: asOf });
            if (!fold) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }

            const app: PartnerAppDoc = fold.app;
            const appId = String(app._id);
            const rows = fold.rows;
            const foldDiagnostics = fold.diagnostics;
            const warnings: string[] = [];
            const rejectedFilters: string[] = [];

            // ── The two tier states, each read from a WATERMARK by the fold ──
            //
            // ⚠️ The STATE is the resolver's (it reads the watermarks); the SENTENCE is this
            // service's, because the same absence has to be worded differently on a roster and on a
            // list of paying merchants.
            const dataState: StoreDataState = fold.data_state;
            if (dataState === STORE_DATA_STATES.NEVER_SYNCED) {
                warnings.push(_WARNINGS.neverSynced);
            }

            const attributionState: StoreAttributionState = fold.attribution_state;
            if (attributionState === STORE_ATTRIBUTION_STATES.NOT_CONNECTED) {
                //  NOT a refusal. The roster comes from the Partner API and is complete without
                // listing analytics; only the acquisition columns and `install_country` are empty.
                warnings.push(_WARNINGS.attributionNotConnected(fold.attribution_message));
            } else if (attributionState === STORE_ATTRIBUTION_STATES.NEVER_SYNCED) {
                warnings.push(_WARNINGS.attributionNeverSynced);
            }

            // ── G. Fail-open validation of everything the caller asked for ───
            const needle = String(q === undefined || q === null ? '' : q).trim().toLowerCase();

            // WRITTEN OUT, not looped, so the COMPILER proves the map is total over the facet
            // vocabulary: add a group to `STORE_FACET_GROUPS` without a line here and this stops
            // compiling. Built as a loop it would type-check with a group missing, and that group
            // would then render a checkbox the server silently ignores.
            const selection: StoreFacetSelection = {
                install_states: _validateFacetValues('install_states', install_states, rows, rejectedFilters, warnings),
                states: _validateFacetValues('states', states, rows, rejectedFilters, warnings),
                billing: _validateFacetValues('billing', billing, rows, rejectedFilters, warnings),
                store_records: _validateFacetValues('store_records', store_records, rows, rejectedFilters, warnings),
                store_statuses: _validateFacetValues('store_statuses', store_statuses, rows, rejectedFilters, warnings),
                shopify_plans: _validateFacetValues('shopify_plans', shopify_plans, rows, rejectedFilters, warnings)
            };

            if (_splitCsv(countries).length > 0) {
                rejectedFilters.push(`countries=${String(countries)}`);
                warnings.push(_WARNINGS.countriesUnsupported);
            }

            const rawSort = sort === undefined || sort === null ? '' : String(sort).trim();
            let sortKey: StoreRosterSortKey = DEFAULT_STORE_SORT_KEY;
            if (rawSort !== '') {
                if (_isSortKey(rawSort)) {
                    sortKey = rawSort;
                } else {
                    rejectedFilters.push(`sort=${rawSort}`);
                    warnings.push(_WARNINGS.unrecognisedSort(rawSort));
                }
            }
            const sortDir: StoreSortDirection = String(dir || '').trim().toLowerCase() === 'asc'
                ? 'asc'
                : DEFAULT_STORE_SORT_DIR;

            // ── H. Filter, count, sort, page — all from `rows` ───────────────
            const filtered = rows.filter((row) => matchesSearch(row, needle) && matchesAllFacets(row, selection, storeFacetValue));

            const installStateCounts = _installStateCounts(rows);
            // Every OTHER facet applied, plus the search, so a tab's number predicts what clicking it
            // will show. The tab row itself is a shortcut into the `install_states` group, which is
            // exactly why that group is the one excluded.
            const installStateCountsFiltered = _installStateCounts(
                rows.filter((row) => matchesSearch(row, needle) && matchesAllFacets(row, selection, storeFacetValue, 'install_states'))
            );
            const facetGroups = _FACET_KEYS.map((key) => _buildFacetGroup(key, rows, selection, needle));

            // SORT A COPY. `filter` happens to return a new array today, so nothing is wrong right
            // now — but every tally above was taken from `rows`, and the day someone skips the filter
            // when nothing is selected, an in-place sort reorders the very array those tallies came
            // from. It is free to make that impossible rather than true by coincidence.
            const sorted = [...filtered].sort((a, b) => compareStoreRows(a, b, sortKey, sortDir));

            const total = sorted.length;
            const pageLimit = positiveInt(limit, DEFAULT_LIMIT, MAX_LIMIT);
            const requestedLimit = positiveInt(limit, DEFAULT_LIMIT, Number.MAX_SAFE_INTEGER);
            if (requestedLimit > pageLimit) {
                warnings.push(_WARNINGS.limitClamped(String(requestedLimit), pageLimit));
            }
            const pages = total > 0 ? Math.ceil(total / pageLimit) : 0;
            const pageNumber = Math.min(positiveInt(page, 1, Number.MAX_SAFE_INTEGER), Math.max(pages, 1));
            const items = sorted.slice((pageNumber - 1) * pageLimit, pageNumber * pageLimit);

            // ── I. Everything that was excluded, said out loud ───────────────
            //
            // ⚠️ The fold COUNTS; this service SPEAKS. A count that reaches `diagnostics` and never
            // reaches `warnings[]` is an exclusion the operator cannot see, which is the same as not
            // having counted it.
            warnings.push(..._coverageWarnings(app, rows.length));
            if (foldDiagnostics.shopless_relationship_events > 0) {
                warnings.push(_WARNINGS.shoplessRelationshipEvents(foldDiagnostics.shopless_relationship_events));
            }
            if (foldDiagnostics.future_relationship_events > 0) {
                warnings.push(_WARNINGS.futureRelationshipEvents(foldDiagnostics.future_relationship_events));
            }
            if (foldDiagnostics.stores_without_install_record > 0) {
                warnings.push(_WARNINGS.storesWithoutInstallRecord(foldDiagnostics.stores_without_install_record));
            }
            if (foldDiagnostics.attribution_rows_without_partner_record > 0) {
                warnings.push(_WARNINGS.attributionRowsWithoutPartnerRecord(foldDiagnostics.attribution_rows_without_partner_record));
            }
            if (foldDiagnostics.stores_with_mixed_spend_currency > 0) {
                warnings.push(_WARNINGS.mixedSpendCurrency(foldDiagnostics.stores_with_mixed_spend_currency));
            }
            if (foldDiagnostics.inferred_state_rows > 0) {
                warnings.push(_WARNINGS.inferredStates(foldDiagnostics.inferred_state_rows));
            }
            if (foldDiagnostics.test_subscriptions_excluded > 0) {
                warnings.push(_WARNINGS.testSubscriptionsExcluded(foldDiagnostics.test_subscriptions_excluded));
            }
            if (foldDiagnostics.skipped_keyless_subscription_events > 0) {
                warnings.push(_WARNINGS.skippedKeylessSubscriptionEvents(foldDiagnostics.skipped_keyless_subscription_events));
            }
            if (foldDiagnostics.unclassified_subscription_rows > 0) {
                warnings.push(_WARNINGS.unclassifiedSubscriptions(foldDiagnostics.unclassified_subscription_rows));
            }

            // WRITTEN OUT rather than spread from `foldDiagnostics`, for the same reason the barrels
            // enumerate their keys: this is the wire shape, and a spread would silently publish
            // whatever the fold happens to count next. `future_relationship_events` is deliberately
            // NOT among them — it has always been a warning here and not a diagnostics field, and
            // adding it now would change a shipped response.
            const diagnostics: StoreRosterDiagnostics = {
                shopless_relationship_events: foldDiagnostics.shopless_relationship_events,
                stores_without_install_record: foldDiagnostics.stores_without_install_record,
                attribution_rows_without_partner_record: foldDiagnostics.attribution_rows_without_partner_record,
                stores_with_mixed_spend_currency: foldDiagnostics.stores_with_mixed_spend_currency,
                inferred_state_rows: foldDiagnostics.inferred_state_rows,
                unclassified_subscription_rows: foldDiagnostics.unclassified_subscription_rows,
                skipped_keyless_subscription_events: foldDiagnostics.skipped_keyless_subscription_events,
                test_subscriptions_excluded: foldDiagnostics.test_subscriptions_excluded,
                unrecognised_filters: rejectedFilters
            };

            const payload: StoreRosterResponse = {
                app_id: appId,
                app_name: app.display_name,
                as_of: asOf.toISOString(),

                items,
                pagination: { page: pageNumber, limit: pageLimit, total, pages },
                sort: { key: sortKey, dir: sortDir },

                install_state_counts: installStateCounts,
                install_state_counts_filtered: installStateCountsFiltered,
                facet_groups: facetGroups,
                filters: {
                    q: needle,
                    install_states: selection.install_states,
                    states: selection.states,
                    billing: selection.billing,
                    store_records: selection.store_records,
                    store_statuses: selection.store_statuses,
                    shopify_plans: selection.shopify_plans
                },

                meta: {
                    last_synced_at: _iso(app.last_synced_at),
                    //  ALWAYS null until the ingest wave: `gi_store_enrichments` and its watermark
                    // do not exist. A watermark rather than a row count, for the reason every other
                    // tier state here is one — an empty enrichment set cannot otherwise be told from
                    // one that was pushed and came back empty.
                    last_store_push_at: null,
                    domains_seen: rows.length,
                    //  `0`, and honest: no store can carry an operator profile before the
                    // collection that holds one exists. Read it beside `last_store_push_at: null`,
                    // which is what says "never pushed" rather than "pushed nothing".
                    enriched_stores: 0,
                    earliest_event_at: _iso(app.earliest_event_at),
                    earliest_transaction_at: _iso(app.earliest_transaction_at),
                    lifetime_sync_completed_at: _iso(app.lifetime_sync_completed_at),
                    shop_name_coverage_since: _iso(app.shop_name_coverage_since)
                },
                states: STORE_LIFECYCLE_LABELS,
                install_states: STORE_INSTALL_STATE_LABELS,

                data_state: dataState,
                attribution_state: attributionState,
                // DE-DUPLICATED, and not because any message here is expected twice: the page keys
                // its `<p>` elements by the string itself, so a duplicate is a React key collision
                // that DROPS one of them — a message silently taking its own twin down with it.
                warnings: [...new Set(warnings)],
                diagnostics
            };

            // THE BANNER'S BODY, AND THE ONLY WAY IT SURVIVES THE FRONTEND'S GATE. `dataState.js`
            // intercepts `data_state === 'NEVER_SYNCED'`, NULLS `data` — warnings and all — and
            // renders the banner body as `data.unknown_reason || resp.msg`. Without this field that
            // resolves to the SUCCESS message, so the page prints "Store roster resolved." under the
            // heading "Nothing synced yet", and the explanation above is discarded with the payload.
            if (dataState === STORE_DATA_STATES.NEVER_SYNCED) {
                payload.unknown_reason = _WARNINGS.neverSynced;
            }

            //  A 200 with zero rows, always. "Nothing synced yet" and "nobody has installed your
            // app" are separated by `data_state` and `warnings[]` — never by a refusal, and never by
            // a 404.
            return resolve(promiseReturnResult(true, payload, {}, 'Store roster resolved.'));
        } catch (error) {
            customConsoleError('ERROR: Store storeRosterService getStoreRoster', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read the store roster. Please try again.'));
        }
    });
};

export = {
    getStoreRoster
};
