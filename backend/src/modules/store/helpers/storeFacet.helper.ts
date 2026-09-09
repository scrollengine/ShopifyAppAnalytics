'use strict';

/**
 * ============================================================================
 *  WHICH STORES DOES THIS REQUEST WANT? — one value function, every predicate
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, no clock. It imports the store vocabulary and
 *  nothing else, so every filter below can be exercised against literal rows.
 *
 *  ──  ONE FUNCTION DECIDES A ROW'S VALUE IN A GROUP, AND EVERYTHING ELSE USES IT ─────────
 *
 *  `storeFacetValue` / `subscriptionFacetValue` are the only places that know a row's bucket. The
 *  PREDICATE tests their output, and the SERVICE builds the checkbox options by tallying their
 *  output — so an option can never exist that the predicate cannot evaluate.
 *  `SubscriptionFacetFilter` states that contract from the other side of the wire: *"every option the server offers has a matching predicate on the server, so a
 *  checkbox can never exist that the backend cannot evaluate."* A checkbox that ticks and changes
 *  nothing is worse than a missing filter, because it looks like it worked.
 *
 *  ── TWO LISTS, ONE BUCKET FUNCTION, AND EXACTLY ONE GROUP THAT DIFFERS ────────────────────
 *
 *  `GET /api/stores` and `GET /api/subscriptions` filter the same rows on the same five groups, and
 *  disagree about one: `states`. The roster buckets on the LIFECYCLE vocabulary (`CONVERTED`,
 *  `CHURNED_IN_TRIAL`, …) because that is what its rows carry and its Status filter sends; the
 *  Subscriptions list buckets on the SUBSCRIPTION vocabulary (`PAYING`, `CHURNED_AFTER_TRIAL`, …)
 *  because that is what `SUBSCRIPTION_TABS` sends. They are the same journey under two names —
 *  `storePresentation.js` maps them for rendering and gives both the same badge tone.
 *
 *  So `_sharedFacetValue` owns the five groups that are one question, and the two public bucket
 *  functions differ only in how they answer the sixth. Duplicating the five instead is how a cadence
 *  or an install state comes to mean one thing on one page and something else on the other.
 *
 *  ──  VALIDATION IS FAIL-OPEN, AND AN EMPTY GROUP CONSTRAINS NOTHING ─────────────────────
 *
 *  A group with no selections imposes no predicate — OR within a group, AND across groups. And an
 *  unrecognised VALUE inside a group is dropped with a warning rather than matched against: a typo
 *  must WIDEN the result set, never empty it. A table that renders zero rows because of a bad query
 *  string is indistinguishable from a business with no stores, and the reader has no way to tell
 *  which they are looking at.
 *
 *  ⚠️ Dropping every value in a group must leave the group EMPTY, i.e. unconstrained — not
 *  "matches nothing". The service is what warns; this file just never narrows on a value it does not
 *  recognise, because it is fed the already-validated selection.
 *
 *  ── SEARCH IS NOT FAIL-OPEN, AND THAT IS NOT AN INCONSISTENCY ─────────────────────────────
 *
 *  `q` is free text. "No store matches 'zzz'" is a real, measured, useful answer, and widening it
 *  would make the search box do nothing. The difference from a facet is that the reader TYPED this
 *  one and can see what they typed.
 * ============================================================================
 */

import storeConstants = require('../constants/storeRoster.constants');

import type { StoreFacetGroupKey, StoreRosterRow } from '../types/storeRoster.types';
import type { SubscriptionFacetGroupKey, SubscriptionListRow } from '../types/subscriptionList.types';
import type {
    FacetSelectionOf,
    FacetValueOf,
    StoreFacetableRow,
    StoreSearchableRow
} from '../types/storeFacet.types';

const { BILLING_INTERVAL_UNKNOWN, NOT_PUSHED_FACET, STORE_RECORD_FACETS } = storeConstants;

/**
 * The bucket this row falls into for every group EXCEPT `states`.
 *
 *  SHARED BY BOTH LISTS, and `states` is excluded precisely because it is the ONE group the two
 * answer differently: the Stores roster buckets on the LIFECYCLE state and the Subscriptions list on
 * the SUBSCRIPTION state, which are the same journey under two vocabularies (see
 * `storePresentation.js`, which maps them for rendering). Everything else — is the app on the store,
 * what cadence is it billed on, has an operator profile been pushed — is one question with one
 * answer, and asking it twice is how two pages come to disagree about a merchant.
 *
 * ⚠️ NEVER RETURNS `''`. Every row is in exactly one bucket of every group, including the buckets
 * that mean "nothing here yet" — `UNKNOWN` for a cadence no payout has named, `NOT_PUSHED` for a
 * fact only an operator can supply. Omitting those rows instead is what makes a SAMPLE look like a
 * complete distribution: three stores on Shopify Plus with 9,997 omitted renders as "100% Plus".
 *
 * @param row - Any list row.
 * @param groupKey - A declared facet group other than `states`.
 * @returns The row's value in that group. Always non-empty.
 */
const _sharedFacetValue = (row: StoreFacetableRow, groupKey: StoreFacetGroupKey): string => {
    if (groupKey === 'install_states') {
        return row.install_state;
    }
    if (groupKey === 'billing') {
        //  `UNKNOWN`, never a defaulted "monthly". A null interval booked as monthly is how an
        // annual subscriber gets reported at twelve times their true rate, and the facet label says
        // "Cadence not settled yet" out loud so nobody fills it in later.
        return row.plan_interval || BILLING_INTERVAL_UNKNOWN;
    }
    if (groupKey === 'store_records') {
        return row.operator ? STORE_RECORD_FACETS.HAS_OPERATOR_PROFILE : STORE_RECORD_FACETS.NO_OPERATOR_PROFILE;
    }
    if (groupKey === 'store_statuses') {
        //  The operator's own Admin-API reachability verdict. Until the ingest wave lands there is
        // no operator block at all, so every store is in the NOT_PUSHED bucket — which is a true
        // statement about this deployment rather than an empty group.
        return NOT_PUSHED_FACET;
    }
    // `shopify_plans`. ⚠️ NOT `plan_name` — that is YOUR app's charge name. This is the merchant's
    // Shopify commerce tier, which no Partner API version exposes and only an operator push can fill.
    return row.shopify_plan_name || NOT_PUSHED_FACET;
};

/**
 * The bucket a STORE ROSTER row falls into for one facet group.
 *
 * @param row - The row.
 * @param groupKey - One of the declared facet groups.
 * @returns The row's value in that group. Always non-empty.
 */
const storeFacetValue = (row: StoreRosterRow, groupKey: StoreFacetGroupKey): string => {
    if (groupKey === 'states') {
        return row.state;
    }
    return _sharedFacetValue(row, groupKey);
};

/**
 * The bucket a SUBSCRIPTION LIST row falls into for one facet group.
 *
 *  `states` READS `status`, THE SUBSCRIPTION VOCABULARY, and that is the whole reason this function
 * exists beside `storeFacetValue` rather than being it. `SUBSCRIPTION_TABS` on the Subscriptions page
 * sends `PAYING` / `ON_TRIAL` / `CHURNED_DURING_TRIAL` / `CHURNED_AFTER_TRIAL` into the `states`
 * group; the roster's five LIFECYCLE values (`CONVERTED`, `CHURNED_IN_TRIAL`, …) are the same states
 * under different names. Bucketing on the wrong one would make every tab click land on a value the
 * closed-vocabulary check rejects — a checkbox that ticks, warns, and widens the table.
 *
 * ⚠️ Its key parameter is the SUBSCRIPTIONS vocabulary — four groups, a subset of the roster's six —
 * which is what makes `matchesAllFacets` infer the narrower selection type and refuse a
 * `store_records` or `shopify_plans` selection this list has no checkbox for.
 *
 * @param row - The row.
 * @param groupKey - One of the groups the Subscriptions list publishes.
 * @returns The row's value in that group. Always non-empty.
 */
const subscriptionFacetValue = (row: SubscriptionListRow, groupKey: SubscriptionFacetGroupKey): string => {
    if (groupKey === 'states') {
        return row.status;
    }
    return _sharedFacetValue(row, groupKey);
};

/**
 * Whether a row satisfies one group's selection.
 *
 * @param row - The row.
 * @param groupKey - The group.
 * @param [selected] - Already-validated values. Empty ⇒ unconstrained.
 * @param valueOf - The list's own bucket function. See {@link FacetValueOf}.
 * @returns True when the row passes.
 */
const matchesFacetGroup = <TRow, TKey extends string>(
    row: TRow,
    groupKey: TKey,
    selected: readonly string[] | undefined,
    valueOf: FacetValueOf<TRow, TKey>
): boolean => {
    if (!selected || selected.length === 0) {
        return true;
    }
    return selected.indexOf(valueOf(row, groupKey)) !== -1;
};

/**
 * Whether a row satisfies every group EXCEPT one.
 *
 * The exception is what makes a facet count predict what clicking it shows: a group's own options
 * are tallied over the rows that pass every OTHER group, so picking a second value in the same group
 * widens rather than narrows. Standard faceted counting — one source array, several projections.
 *
 * ⚠️ `valueOf` IS A PARAMETER RATHER THAN A DEFAULT, so a caller cannot silently get the roster's
 * bucketing for a list that buckets differently. The Subscriptions list is exactly that caller, and
 * a default here would have filtered its `states` group against a vocabulary its checkboxes never
 * use.
 *
 * @param row - The row.
 * @param selection - Every group's validated values.
 * @param valueOf - The list's own bucket function.
 * @param [exceptKey] - The group to skip, or null to apply all of them.
 * @returns True when the row passes every applied group.
 */
const matchesAllFacets = <TRow, TKey extends string>(
    row: TRow,
    selection: FacetSelectionOf<TKey>,
    valueOf: FacetValueOf<TRow, TKey>,
    exceptKey?: TKey | null
): boolean => {
    // ⚠️ A WIDENING of `Object.keys`, which is typed `string[]` whatever it is given — not an escape
    // from a lost type. Iterating the selection rather than a hand-written group list is what makes
    // this loop cover a group added later: a list here that fell one behind the vocabulary would
    // leave that group's checkboxes ticking and filtering nothing.
    const keys = Object.keys(selection) as TKey[];
    for (const key of keys) {
        if (exceptKey && key === exceptKey) {
            continue;
        }
        if (!matchesFacetGroup(row, key, selection[key], valueOf)) {
            return false;
        }
    }
    return true;
};

/**
 * Whether a row matches the free-text query, over name, domain and plan.
 *
 * Case-insensitive substring, matching the page's own placeholder ("Search N stores by name, domain
 * or plan" / "Search N subscriptions by store, domain or plan"). Deliberately NOT a regular
 * expression built from user input: a `(` in the box would throw, and the catch above would turn a
 * typo into a refusal of the whole endpoint.
 *
 * @param row - The row.
 * @param needle - The already-trimmed, already-lowercased query. `''` matches everything.
 * @returns True when the row matches.
 */
const matchesSearch = (row: StoreSearchableRow, needle: string): boolean => {
    if (needle === '') {
        return true;
    }
    // The four fields are written out rather than looped over a name list, and there is deliberately
    // no `SEARCH_FIELDS` constant to loop over: indexing a row with a `string` types as `any`, so a
    // renamed field would keep compiling and silently stop being searchable. Written out, the
    // compiler checks every one — and the list is the page's own placeholder ("by name, domain or
    // plan"), so the two are readable side by side.
    return String(row.customer_name || '').toLowerCase().includes(needle)
        || String(row.shop_name || '').toLowerCase().includes(needle)
        || String(row.shop_domain || '').toLowerCase().includes(needle)
        || String(row.plan_name || '').toLowerCase().includes(needle);
};

export = {
    storeFacetValue,
    subscriptionFacetValue,
    matchesFacetGroup,
    matchesAllFacets,
    matchesSearch
};
