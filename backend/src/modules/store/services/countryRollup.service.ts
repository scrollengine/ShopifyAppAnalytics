'use strict';

/**
 * ============================================================================
 *  WHERE THE PAYING CUSTOMERS ARE — one population, grouped by country
 * ============================================================================
 *
 *  Serves `GET /api/stores/countries`. The four KPI tiles, the two donuts and the country table on
 *  the Revenue → By country tab.
 *
 *  ── ITS OWN ENDPOINT, AND THAT IS A CONSTRAINT RATHER THAN TIDINESS ─────────────────────────
 *
 *  This is a WHOLE-POPULATION rollup. Paging it alongside the paginated store list would either page
 *  the wrong thing or force that list to fetch every store in order to draw eight rows. So it shares
 *  the roster's FOLD and nothing else: `resolveStoreRosterFold` issues the five reads, replays the
 *  install states, resolves the charge cohort and evaluates the canonical paying set exactly once,
 *  and this service groups the answer. `/api/stores` and `/api/subscriptions` are the other two
 *  callers, which is precisely why the fold is a file — three pages, one definition of a customer.
 *
 *  ──  THE PAYING SET AND THE MRR ARE NOT RE-DERIVED HERE ───────────────────────────────────
 *
 *  `fold.paying_by_domain` IS `modules/revenue`'s `liveSetAsOf`, evaluated at this request's own
 *  instant, and it is the same map the Subscriptions list takes its whole population from. Nothing in
 *  this file asks whether a subscription is `PAYING`, tests an amount, or filters on "was billed in
 *  this window". If it did, the paying count on this page would drift from the one behind the MRR
 *  figure on the Revenue page, and nothing on either screen would say which was right.
 *
 *  ── ⚠️ WHAT "COUNTRY" MEANS HERE, AND WHAT IT DOES NOT ──────────────────────────────────────
 *
 *  The Partner API's `Shop` object has four fields and NO COUNTRY on any version, so
 *  `StoreRosterRow.country` is `''` on every row of every deployment. The one per-store country this
 *  build records is `install_country` — GA4's `geo.country` for the install event, i.e. where the
 *  INSTALL TRAFFIC came from. It is not the merchant's trading country and its coverage is bounded by
 *  install attribution. `country_basis` says so on the payload, `warnings[]` says so to the operator,
 *  and the page's footer says so to the reader. All three are the same sentence for a reason.
 *
 *  ──  NORMALISE BEFORE GROUPING, AND PUBLISH THE REMAINDER ─────────────────────────────────
 *
 *  Every geo string goes through `helpers/countryName.helper` before it becomes a bucket key, because
 *  the raw values arrive as `US` on some rows and `United States` on others — and grouping on the raw
 *  value puts one country in two rows, so both are wrong while the totals still add up.
 *
 *  A store the normaliser cannot place — no attribution record, an empty geo, a `(not set)` sentinel,
 *  or a name this build's index does not carry — goes into an EXPLICIT `UNKNOWN` row. It is never
 *  dropped. Dropping it is the defect this endpoint was specified around: the per-country column
 *  silently stops summing to the headline revenue figure, this page and the Revenue page disagree,
 *  and there is no visible cause. With the remainder present, `sum(items) === totals` holds by
 *  construction for every countable field, and the gap becomes a row a reader can point at.
 *
 *  ── ONE ARRAY, ONE PASS, EVERY NUMBER DERIVED FROM IT ───────────────────────────────────────
 *
 *  There is no second aggregation anywhere in this file. The rows, the totals, the coverage block and
 *  every facet count are folds over the SAME filtered array, so they cannot disagree.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import listQueryHelper = require('../../shared/helpers/listQuery.helper');
import conversion = require('../../conversion');
import countryConstants = require('../constants/countryRollup.constants');
import storeConstants = require('../constants/storeRoster.constants');
import countryNameHelper = require('../helpers/countryName.helper');
import storeFacetHelper = require('../helpers/storeFacet.helper');
import storeRosterResolver = require('../resolvers/storeRoster.resolver');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { FacetSelectionOf } from '../types/storeFacet.types';
import type { StoreRosterRow } from '../types/storeRoster.types';
import type {
    CountryAppliedFilters,
    CountryFacetGroup,
    CountryFacetGroupKey,
    CountryFacetOption,
    CountryRollupCoverage,
    CountryRollupDiagnostics,
    CountryRollupMeta,
    CountryRollupParams,
    CountryRollupResponse,
    CountryRollupRow,
    CountryRollupTotals,
    CountrySortDirection,
    CountrySortKey
} from '../types/countryRollup.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { compareSortValues } = listQueryHelper;
// Through the barrel. `modules/conversion` publishes exactly the vocabulary this one renders from,
// and says in its own header why: a sibling that cannot reach the canonical definition grows a
// second one, and then one merchant is CONVERTED on one page and ON_TRIAL on another.
const { STORE_LIFECYCLE_LABELS, STORE_LIFECYCLE_STATE_ORDER, STORE_LIFECYCLE_STATES } = conversion;
const { normaliseCountry, COUNTRY_INDEX_SIZE } = countryNameHelper;
//  THE BUCKET FUNCTION AND THE PREDICATE COME FROM ONE PLACE, as they do on the other two lists.
// `storeFacetValue` decides a row's bucket both when the options are tallied and when the filter is
// applied, so a checkbox the backend cannot evaluate is unrepresentable rather than merely unlikely.
const { storeFacetValue, matchesAllFacets } = storeFacetHelper;
const { resolveStoreRosterFold } = storeRosterResolver;
const {
    UNKNOWN_COUNTRY_CODE,
    UNKNOWN_COUNTRY_LABEL,
    COUNTRY_SORT_KEYS,
    DEFAULT_COUNTRY_SORT_KEY,
    DEFAULT_COUNTRY_SORT_DIR,
    COUNTRY_FACET_GROUP_KEYS,
    COUNTRY_FACET_GROUPS,
    COUNTRY_SOURCE_BASIS
} = countryConstants;
const {
    STORE_INSTALL_STATES,
    STORE_INSTALL_STATE_LABELS,
    STORE_INSTALL_STATE_ORDER,
    STORE_RECORD_FACETS,
    STORE_RECORD_FACET_LABELS,
    NOT_PUSHED_FACET,
    NOT_PUSHED_FACET_LABEL,
    BILLING_INTERVAL_UNKNOWN,
    BILLING_INTERVAL_LABELS,
    STORE_DATA_STATES,
    STORE_ATTRIBUTION_STATES
} = storeConstants;

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
const _FACET_KEYS: readonly CountryFacetGroupKey[] = COUNTRY_FACET_GROUP_KEYS;

/** How many unplaceable geo strings are named on the payload before the list is capped. */
const _UNRESOLVED_SAMPLE_LIMIT = 25;

/** @param value - A candidate sort key. @returns Whether it is in the allowlist. */
const _isSortKey = (value: string): value is CountrySortKey => COUNTRY_SORT_KEYS.includes(value);

/**
 *  THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * `countries/index.js` renders one `<p>` per warning KEYED BY THE STRING ITSELF. Two identical
 * strings are a duplicate-key collision and one of them is silently dropped — so a second copy of a
 * message does not double up, it DISAPPEARS, and takes its condition with it.
 *
 * ⚠️ That banner is currently ALWAYS EMPTY and is waiting for exactly these. Each is written for an
 * operator who cannot see this code: what is missing, what it does to the numbers beside it, and what
 * would fix it.
 */
const _WARNINGS = Object.freeze({
    neverSynced: 'No Partner sync has completed for this app yet, so no stores have been fetched and there '
        + 'is nothing to group by country. An empty breakdown means we have not looked — not that your app '
        + 'has no customers anywhere.',

    /** ⚠️ Carries the availability message verbatim, so the operator reads the missing variable names. */
    attributionNotConnected: (message: string): string => `${message} `
        + 'Country here comes from the geo recorded against each install by listing analytics, so with that '
        + 'source disconnected EVERY store falls into the "Unknown" row below. That is a missing data '
        + 'source, not a business with no geography — and the row is published rather than dropped so the '
        + 'breakdown still sums to the totals above it.',

    attributionNeverSynced: 'Listing analytics is configured, but the install-attribution sync has never '
        + 'completed for this app, so no install carries a geo yet and every store falls into the "Unknown" '
        + 'row. Run the install-attribution sync to populate it.',

    /**
     *  THE SENTENCE THE PAGE'S OWN BANNER GETS WRONG. Its copy says the unattributed stores "have no
     * install or uninstall event in the Partner replay" — that is the SOURCE system's reason, carried
     * over with the component. In this build those stores are on the roster precisely BECAUSE the
     * Partner API knows them; what they lack is a listing-analytics install record. Publishing the
     * accurate reason here is the only channel that corrects it.
     */
    unattributedPaying: (stores: number, paying: number): string => `${stores} store(s), including `
        + `${paying} that are paying right now, have no install-attribution record — so this build holds no `
        + 'country for them and they are grouped under "Unknown" rather than dropped. The cause is missing '
        + 'LISTING ANALYTICS coverage for their install, not a missing Partner event: they are on the roster '
        + 'because the Partner API knows them. A store that installed before the analytics export began, or '
        + 'while it was disconnected, can never be attributed retrospectively.',

    unresolvedGeo: (stores: number, values: string[]): string => `${stores} store(s) carry an install geo `
        + `this build cannot resolve to a country: ${values.join(', ')}. They are counted in the "Unknown" `
        + 'row, so every total above still reconciles — but this is a MAPPING gap rather than a coverage '
        + 'gap, and it is fixed by adding those names to the country index rather than by re-syncing. '
        + 'Ambiguous values are deliberately left unresolved: "Korea" and "Congo" each name two countries, '
        + 'and guessing one would move a merchant across a border.',

    unresolvedGeoTruncated: (shown: number, total: number): string => `${total} distinct unresolved geo `
        + `value(s) were seen and the ${shown} listed above are a sample. The rest are in the "Unknown" row `
        + 'with them.',

    /**
     * ⚠️ A RUNTIME fact, not a business one. A Node built without ICU region data has no country table
     * at all, so every name falls to the remainder — and without this sentence the page reports a
     * merchant with no geography when the truth is a missing locale bundle.
     */
    noCountryIndex: 'This Node runtime supplied no country name table (Intl region data is unavailable), so '
        + 'no install geo could be resolved to a country and every store is in the "Unknown" row. That is a '
        + 'property of the runtime rather than of your data — run this backend on a Node build with full ICU.',

    lifetimeFloor: 'No lifetime Partner sync has ever completed for this app, so this breakdown is a FLOOR '
        + 'rather than a total — there may be older stores that have never been fetched, and their revenue is '
        + 'missing from every country below.',

    noTransactions: 'No settled payouts have ever been fetched for this app, so every MRR and spend figure '
        + 'below is empty because there is nothing to sum — not because these countries pay nothing. Run a '
        + 'Partner sync, and check that your Partner API token has payout access.',

    mixedCurrency: (stores: number, codes: string[]): string => `${stores} store(s) have settled payouts in `
        + `more than one currency, and the population spans ${codes.length} (${codes.join(', ')}). This build `
        + 'holds no exchange rates — deliberately, because a wrong rate produces a plausible wrong number — so '
        + 'every spend and MRR total here is a sum of unlike units.',

    countriesUnsupported: 'A country filter was requested and has been ignored. Filtering countries on the '
        + 'countries page would remove the very rows being compared against each other, so the whole '
        + 'breakdown is returned. Use the store list if you want one country\'s stores.',

    searchIgnored: 'A search term was sent and has been ignored. This endpoint answers for the WHOLE '
        + 'population on purpose: narrowing it server-side would silently reshape the KPI tiles and the '
        + 'revenue mix as well as the table, so typing three letters would redraw the mix as 100% of three '
        + 'countries while the header still claimed the full total. The page filters its table locally.',

    unrecognisedFacet: (group: string, value: string): string => `The ${group} filter "${value}" is not a `
        + 'value this endpoint can evaluate, so it has been ignored and the breakdown below is wider than you '
        + 'asked for.',

    unrecognisedSort: (value: string): string => `The sort key "${value}" is not sortable here, so the `
        + `default sort (${DEFAULT_COUNTRY_SORT_KEY}, highest first) has been used instead. Valid values: `
        + `${COUNTRY_SORT_KEYS.join(', ')}.`
});

/** An ISO string, or null. */
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
 * The values a group must offer even when no row is in them.
 *
 *  A GROUP THAT OMITS ITS EMPTY BUCKETS MAKES A SAMPLE LOOK LIKE A DISTRIBUTION. Three stores on
 * Shopify Plus with 9,997 unpushed renders as "100% Plus" unless the "Not pushed" bucket is there
 * holding the denominator, and a lifecycle state missing because its count is zero reads as "we did
 * not measure it".
 *
 * @param groupKey - The group.
 * @returns Values to include at zero if nothing else produced them.
 */
const _alwaysOffered = (groupKey: CountryFacetGroupKey): readonly string[] => {
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
 * The on-screen label for one facet value.
 *
 * @param groupKey - The group.
 * @param value - The value.
 * @returns The label, falling back to the raw value — never blank.
 */
const _facetLabel = (groupKey: CountryFacetGroupKey, value: string): string => {
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
 * Every value a group can legitimately offer: its always-offered members plus whatever the population
 * actually produced.
 *
 *  THIS SET IS BOTH THE CHECKBOX LIST AND THE VALIDATION VOCABULARY, which is what makes the two
 * impossible to disagree. Validating against a hand-declared list instead lets a cadence Shopify
 * sends that this build has never seen be OFFERED as an option and then REJECTED on selection — a
 * checkbox that ticks, warns, and widens the table.
 *
 * @param rows - The whole population.
 * @param groupKey - The group.
 * @returns Every value this group may be filtered on.
 */
const _offeredValues = (rows: readonly StoreRosterRow[], groupKey: CountryFacetGroupKey): Set<string> => {
    const offered = new Set<string>(_alwaysOffered(groupKey));
    for (const row of rows) {
        offered.add(storeFacetValue(row, groupKey));
    }
    return offered;
};

/**
 * The values of one facet group this endpoint can actually evaluate.
 *
 * ⚠️ FAIL-OPEN. Anything unrecognised is DROPPED and reported, never matched — a typo must WIDEN the
 * result set, not empty it. A breakdown that renders zero rows because of a bad query string is
 * indistinguishable from a business with no stores, and the reader has no way to tell which.
 *
 * @param groupKey - The group.
 * @param raw - The parameter exactly as it arrived.
 * @param offered - Everything this group may be filtered on.
 * @param rejected - Mutated: every dropped value is appended as `group=value`.
 * @param warnings - Mutated: one operator-facing sentence per dropped value.
 * @returns The values worth applying.
 */
const _validateFacetValues = (
    groupKey: CountryFacetGroupKey,
    raw: unknown,
    offered: Set<string>,
    rejected: string[],
    warnings: string[]
): string[] => {
    const out: string[] = [];
    for (const value of _splitCsv(raw)) {
        if (offered.has(value)) {
            out.push(value);
            continue;
        }
        rejected.push(`${groupKey}=${value}`);
        warnings.push(_WARNINGS.unrecognisedFacet(COUNTRY_FACET_GROUPS[groupKey], value));
    }
    return out;
};

/** The mutable accumulator behind one country row. One per bucket, built in a single pass. */
interface _CountryBucket {
    country: string;
    country_name: string;
    stores: number;
    installed: number;
    paying: number;
    trialing: number;
    ever_paid: number;
    mrr: number;
    total_spend: number;
    net_revenue: number;
}

/**
 * The value a row sorts on for one key, or `null` when it has none.
 *
 * `null` rather than a substituted zero: `compareSortValues` sorts nulls LAST in BOTH directions,
 * because a country with no measurable conversion rate is not the WORST-converting country — it is
 * one we cannot rate, and floating it to either end of the list presents an absence as an extreme.
 *
 * @param row - The row.
 * @param key - The sort key.
 * @returns The comparable value.
 */
const _sortValue = (row: CountryRollupRow, key: CountrySortKey): number | string | null => {
    if (key === 'country_name') {
        return row.country_name || null;
    }
    if (key === 'conversion_rate') {
        return row.conversion_rate;
    }
    return row[key];
};

/**
 * Which coverage gates make this breakdown a floor rather than a total.
 *
 * These read the measurements a sync records ABOUT ITS OWN COMPLETENESS. They never change a number —
 * they say what the number cannot include.
 *
 * @param app - The app row.
 * @param storeCount - How many stores the population holds, so the empty-ledger warning is
 *   not fired at an app that has no stores either.
 * @returns Zero or more warning strings.
 */
const _coverageWarnings = (app: PartnerAppDoc, storeCount: number): string[] => {
    const out: string[] = [];
    if (!app.lifetime_sync_completed_at) {
        out.push(_WARNINGS.lifetimeFloor);
    }
    if (storeCount > 0 && !app.earliest_transaction_at) {
        out.push(_WARNINGS.noTransactions);
    }
    return out;
};

/**
 * Stores, installs, paying customers and revenue per country, for one partner app.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query, already cast (not coerced) by the controller.
 * @param params1.partner_app_id - The app to report on. Required.
 * @param [params1.sort] - One of the allowlisted sort keys. Unrecognised ⇒ ignored + warned.
 * @param [params1.dir] - `asc` or `desc`.
 * @param [params1.install_states] - Comma-joined facet values. Unrecognised ⇒ ignored + warned.
 * @param [params1.states] - Comma-joined lifecycle states.
 * @param [params1.billing] - Comma-joined billing cadences.
 * @param [params1.store_records] - Whether an operator profile has been pushed.
 * @param [params1.store_statuses] - The operator's Admin-API reachability verdict.
 * @param [params1.countries] - Accepted, refused and warned about. See the warning catalogue.
 * @param [params1.q] - Accepted and ignored: the page filters its table locally, on purpose.
 * @returns The breakdown, or an honest refusal carrying `{}`.
 */
const getCountryRollup = (
    { user_id }: IdentityObject,
    {
        partner_app_id,
        sort,
        dir,
        install_states,
        states,
        billing,
        store_records,
        store_statuses,
        countries,
        q
    }: CountryRollupParams
): Promise<ServiceResult<CountryRollupResponse | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'partner_app_id is required. Read it from GET /api/partner-apps.'));
            }

            // THE ONE JUDGEMENT INSTANT. Read once, HERE, and threaded into every read and every fold
            // beneath it. Without it the payout rollup, the state machine and the install fold each
            // answer as of a different millisecond, and a store can be simultaneously CHURNED and paying.
            const asOf = new Date();

            // ── THE POPULATION, FOLDED ONCE, SHARED WITH TWO OTHER ENDPOINTS ───
            const fold = await resolveStoreRosterFold({ partner_app_id: String(partner_app_id), as_of: asOf });
            if (!fold) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }

            const app: PartnerAppDoc = fold.app;
            const appId = String(app._id);
            const rows = fold.rows;
            const payingByDomain = fold.paying_by_domain;
            const spendByDomain = fold.spend_by_domain;
            const warnings: string[] = [];
            const rejectedFilters: string[] = [];

            // ── The two tier states, each read from a WATERMARK by the fold ──
            //
            // ⚠️ The STATE is the resolver's (it reads the watermarks); the SENTENCE is this service's,
            // because the same absence has to be worded differently on a roster and on a map.
            const dataState = fold.data_state;
            if (dataState === STORE_DATA_STATES.NEVER_SYNCED) {
                warnings.push(_WARNINGS.neverSynced);
            }

            const attributionState = fold.attribution_state;
            if (attributionState === STORE_ATTRIBUTION_STATES.NOT_CONNECTED) {
                //  NOT a refusal. The roster comes from the Partner API and is complete without
                // listing analytics; only the COUNTRY is missing, and the remainder row carries it.
                warnings.push(_WARNINGS.attributionNotConnected(fold.attribution_message));
            } else if (attributionState === STORE_ATTRIBUTION_STATES.NEVER_SYNCED) {
                warnings.push(_WARNINGS.attributionNeverSynced);
            }

            if (COUNTRY_INDEX_SIZE === 0) {
                warnings.push(_WARNINGS.noCountryIndex);
            }

            // ── Fail-open validation of everything the caller asked for ──────
            //
            // WRITTEN OUT, not looped, so the COMPILER proves the map is total over this endpoint's
            // facet vocabulary: add a group to `COUNTRY_FACET_GROUP_KEYS` without a line here and this
            // stops compiling. Built as a loop it would type-check with a group missing, and that group
            // would render a checkbox the server silently ignores.
            const offered = new Map<CountryFacetGroupKey, Set<string>>();
            for (const key of _FACET_KEYS) {
                offered.set(key, _offeredValues(rows, key));
            }
            const _validate = (key: CountryFacetGroupKey, raw: unknown): string[] => {
                return _validateFacetValues(key, raw, offered.get(key) || new Set<string>(), rejectedFilters, warnings);
            };
            const selection: FacetSelectionOf<CountryFacetGroupKey> = {
                install_states: _validate('install_states', install_states),
                states: _validate('states', states),
                billing: _validate('billing', billing),
                store_records: _validate('store_records', store_records),
                store_statuses: _validate('store_statuses', store_statuses)
            };

            if (_splitCsv(countries).length > 0) {
                rejectedFilters.push(`countries=${String(countries)}`);
                warnings.push(_WARNINGS.countriesUnsupported);
            }
            if (q !== undefined && q !== null && String(q).trim() !== '') {
                rejectedFilters.push(`q=${String(q)}`);
                warnings.push(_WARNINGS.searchIgnored);
            }

            const rawSort = sort === undefined || sort === null ? '' : String(sort).trim();
            let sortKey: CountrySortKey = DEFAULT_COUNTRY_SORT_KEY;
            if (rawSort !== '') {
                if (_isSortKey(rawSort)) {
                    sortKey = rawSort;
                } else {
                    rejectedFilters.push(`sort=${rawSort}`);
                    warnings.push(_WARNINGS.unrecognisedSort(rawSort));
                }
            }
            const sortDir: CountrySortDirection = String(dir || '').trim().toLowerCase() === 'asc'
                ? 'asc'
                : DEFAULT_COUNTRY_SORT_DIR;

            // ── ONE array, ONE pass, every tally taken as it is built ────────
            const filtered = rows.filter((row) => matchesAllFacets(row, selection, storeFacetValue));

            const buckets = new Map<string, _CountryBucket>();
            const _bucketFor = (code: string, name: string): _CountryBucket => {
                const existing = buckets.get(code);
                if (existing) {
                    return existing;
                }
                const created: _CountryBucket = {
                    country: code,
                    country_name: name,
                    stores: 0,
                    installed: 0,
                    paying: 0,
                    trialing: 0,
                    ever_paid: 0,
                    mrr: 0,
                    total_spend: 0,
                    net_revenue: 0
                };
                buckets.set(code, created);
                return created;
            };

            let storesWithGeo = 0;
            let storesWithUnresolvedGeo = 0;
            let mixedCurrencyStores = 0;
            const unresolvedGeoValues = new Set<string>();
            const currencyCodes = new Set<string>();

            for (const row of filtered) {
                const rawGeo = String(row.install_country || '').trim();
                //  NORMALISED BEFORE IT BECOMES A KEY. Grouping on the raw value puts `US` and
                // `United States` in two rows, and both are wrong while the totals still add up.
                const resolved = normaliseCountry(rawGeo);
                if (rawGeo !== '') {
                    storesWithGeo += 1;
                    if (!resolved) {
                        // A geo we HAVE and cannot place is a different fact from a geo we do not have.
                        // Both land in the remainder — nothing is dropped — but only this one is a
                        // mapping gap, and only naming the exact string lets an operator report it.
                        storesWithUnresolvedGeo += 1;
                        unresolvedGeoValues.add(rawGeo);
                    }
                }

                const bucket = resolved
                    ? _bucketFor(resolved.code, resolved.name)
                    : _bucketFor(UNKNOWN_COUNTRY_CODE, UNKNOWN_COUNTRY_LABEL);

                bucket.stores += 1;
                if (row.install_state === STORE_INSTALL_STATES.INSTALLED) {
                    bucket.installed += 1;
                }
                if (row.state === STORE_LIFECYCLE_STATES.ON_TRIAL) {
                    bucket.trialing += 1;
                }
                if (row.transaction_count > 0) {
                    bucket.ever_paid += 1;
                }

                //  THE CANONICAL PAYING SET, handed over by the fold. Never a state test, never an
                // amount threshold, never "was billed in this window" — see the file header.
                const paying = payingByDomain.get(row.shop_domain);
                if (paying) {
                    bucket.paying += 1;
                    //  `monthly_amount`, the run-rate — an ANNUAL charge already divided by 12 by
                    // `normalizeToMonthly`. `charged_amount` would book a year of revenue as one month.
                    bucket.mrr += paying.monthly_amount;
                }

                const spend = spendByDomain.get(row.shop_domain);
                if (spend) {
                    bucket.total_spend += spend.total_gross;
                    bucket.net_revenue += spend.total_net;
                    for (const code of spend.currencies || []) {
                        if (String(code || '').trim() !== '') {
                            currencyCodes.add(String(code).trim());
                        }
                    }
                }
                if (fold.mixed_spend_currency_domains.has(row.shop_domain)) {
                    mixedCurrencyStores += 1;
                }
            }

            // ── The rows, and the totals derived from the SAME buckets ───────
            //
            //  `totals` IS A FOLD OVER `items`, not a second pass over `filtered`. Two computations of
            // one number are two answers that will eventually differ, and the one on screen will be
            // whichever the reader happened to look at. Folding the rows guarantees
            // `sum(items) === totals` for every field, remainder included.
            const items: CountryRollupRow[] = [...buckets.values()].map((bucket) => ({
                country: bucket.country,
                country_name: bucket.country_name,
                stores: bucket.stores,
                installed: bucket.installed,
                paying: bucket.paying,
                trialing: bucket.trialing,
                ever_paid: bucket.ever_paid,
                //  `null`, never `0`, when the country holds no stores — which cannot happen for a
                // bucket that exists, but the division is written honestly so it stays correct if an
                // empty bucket is ever published deliberately.
                conversion_rate: bucket.stores > 0 ? bucket.paying / bucket.stores : null,
                mrr: bucket.mrr,
                total_spend: bucket.total_spend,
                net_revenue: bucket.net_revenue
            }));

            const totals: CountryRollupTotals = {
                stores: 0,
                installed: 0,
                paying: 0,
                trialing: 0,
                ever_paid: 0,
                mrr: 0,
                total_spend: 0,
                net_revenue: 0,
                countries: items.length,
                countries_attributed: 0
            };
            for (const item of items) {
                totals.stores += item.stores;
                totals.installed += item.installed;
                totals.paying += item.paying;
                totals.trialing += item.trialing;
                totals.ever_paid += item.ever_paid;
                totals.mrr += item.mrr;
                totals.total_spend += item.total_spend;
                totals.net_revenue += item.net_revenue;
                if (item.country !== UNKNOWN_COUNTRY_CODE) {
                    totals.countries_attributed += 1;
                }
            }

            // ── Coverage: the remainder, stated as a figure rather than implied ──
            const remainder = buckets.get(UNKNOWN_COUNTRY_CODE);
            const unattributedStores = remainder ? remainder.stores : 0;
            const unattributedPaying = remainder ? remainder.paying : 0;
            const unattributedMrr = remainder ? remainder.mrr : 0;
            const attributedMrr = totals.mrr - unattributedMrr;
            const coverage: CountryRollupCoverage = {
                attributed_stores: totals.stores - unattributedStores,
                unattributed_stores: unattributedStores,
                attributed_paying: totals.paying - unattributedPaying,
                unattributed_paying: unattributedPaying,
                attributed_mrr: attributedMrr,
                unattributed_mrr: unattributedMrr,
                //  `null` — never `0` and never `1` — when there is no MRR at all. The page's
                // `_uncoveredMrrShare` refuses to write its sentence without a number here, because
                // `1 - (undefined || 0)` published "that is 100% of MRR" whenever the ratio was merely
                // missing: the most alarming possible reading of "we were not told".
                mrr_coverage: totals.mrr > 0 ? attributedMrr / totals.mrr : null,
                unresolved_geo_values: [...unresolvedGeoValues].sort().slice(0, _UNRESOLVED_SAMPLE_LIMIT),
                unresolved_geo_stores: storesWithUnresolvedGeo
            };

            // SORT A COPY. `items` is built fresh above, so nothing is wrong today — it is free to make
            // an in-place sort of the array the totals were folded from impossible rather than true by
            // coincidence. Tie-broken on the country NAME so two countries that tie order the same way
            // on every request; on screen a reshuffle between refreshes reads as the data changing.
            const sorted = [...items].sort((a, b) => {
                const cmp = compareSortValues(_sortValue(a, sortKey), _sortValue(b, sortKey), sortDir);
                if (cmp !== 0) {
                    return cmp;
                }
                return a.country_name.localeCompare(b.country_name);
            });

            // ── The facet groups, each tallied over the rows that pass every OTHER group ──
            //
            // Standard faceted counting: one source array, several projections. Excluding a group from
            // its own tally is what makes a count PREDICT what clicking it shows — picking a second
            // value in one group widens rather than narrows.
            const facetGroups: CountryFacetGroup[] = _FACET_KEYS.map((groupKey) => {
                const counts = new Map<string, number>();
                for (const row of rows) {
                    if (!matchesAllFacets(row, selection, storeFacetValue, groupKey)) {
                        continue;
                    }
                    const value = storeFacetValue(row, groupKey);
                    counts.set(value, (counts.get(value) || 0) + 1);
                }
                const options: CountryFacetOption[] = [];
                const seen = new Set<string>();
                // Vocabulary order first (a contract for the closed groups), then whatever the data
                // produced, commonest first — the only useful ordering for an open one.
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
                return { key: groupKey, label: COUNTRY_FACET_GROUPS[groupKey], options };
            });

            // ── Everything approximated or excluded, said out loud ───────────
            //
            // ⚠️ The fold COUNTS; this service SPEAKS. A count that reaches `diagnostics` and never
            // reaches `warnings[]` is an exclusion the operator cannot see, which is the same as not
            // having counted it.
            if (unattributedStores > 0) {
                warnings.push(_WARNINGS.unattributedPaying(unattributedStores, unattributedPaying));
            }
            if (storesWithUnresolvedGeo > 0) {
                warnings.push(_WARNINGS.unresolvedGeo(storesWithUnresolvedGeo, coverage.unresolved_geo_values));
                if (unresolvedGeoValues.size > coverage.unresolved_geo_values.length) {
                    warnings.push(_WARNINGS.unresolvedGeoTruncated(
                        coverage.unresolved_geo_values.length,
                        unresolvedGeoValues.size
                    ));
                }
            }
            if (mixedCurrencyStores > 0) {
                warnings.push(_WARNINGS.mixedCurrency(mixedCurrencyStores, [...currencyCodes].sort()));
            }
            warnings.push(..._coverageWarnings(app, filtered.length));

            const meta: CountryRollupMeta = {
                last_synced_at: _iso(app.last_synced_at),
                earliest_event_at: _iso(app.earliest_event_at),
                earliest_transaction_at: _iso(app.earliest_transaction_at),
                lifetime_sync_completed_at: _iso(app.lifetime_sync_completed_at),
                last_install_attrib_synced_at: _iso(app.last_install_attrib_synced_at)
            };

            const diagnostics: CountryRollupDiagnostics = {
                domains_seen: rows.length,
                domains_filtered: filtered.length,
                stores_with_geo: storesWithGeo,
                stores_with_unresolved_geo: storesWithUnresolvedGeo,
                stores_with_mixed_spend_currency: mixedCurrencyStores,
                country_index_size: COUNTRY_INDEX_SIZE,
                unrecognised_filters: rejectedFilters
            };

            const filters: CountryAppliedFilters = {
                install_states: selection.install_states.slice(),
                states: selection.states.slice(),
                billing: selection.billing.slice(),
                store_records: selection.store_records.slice(),
                store_statuses: selection.store_statuses.slice()
            };

            const payload: CountryRollupResponse = {
                app_id: appId,
                app_name: app.display_name,
                as_of: asOf.toISOString(),

                items: sorted,
                totals,
                coverage,
                sort: { key: sortKey, dir: sortDir },
                facet_groups: facetGroups,
                filters,
                meta,
                country_basis: COUNTRY_SOURCE_BASIS,

                data_state: dataState,
                attribution_state: attributionState,
                // DE-DUPLICATED, and not because any message here is expected twice: the page keys its
                // `<p>` elements by the string itself, so a duplicate is a key collision that DROPS one
                // of them — a message silently taking its own twin down with it.
                warnings: [...new Set(warnings)],
                diagnostics
            };

            // THE BANNER'S BODY, AND THE ONLY WAY IT SURVIVES THE FRONTEND'S GATE. `dataState.js`
            // intercepts `data_state === 'NEVER_SYNCED'`, NULLS `data` — warnings and all — and renders
            // the banner body as `data.unknown_reason || resp.msg`. Without this field that resolves to
            // the SUCCESS message, so the page prints "Country breakdown resolved." under the heading
            // "Nothing synced yet", and the explanation above is discarded with the payload.
            if (dataState === STORE_DATA_STATES.NEVER_SYNCED) {
                payload.unknown_reason = _WARNINGS.neverSynced;
            }

            //  A 200 with zero rows, always. "Nothing synced yet" and "nobody has installed your app"
            // are separated by `data_state` and `warnings[]` — never by a refusal, and never by a 404.
            return resolve(promiseReturnResult(true, payload, {}, 'Country breakdown resolved.'));
        } catch (error) {
            customConsoleError('ERROR: Store countryRollupService getCountryRollup', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read the country breakdown. Please try again.'));
        }
    });
};

export = {
    getCountryRollup
};
