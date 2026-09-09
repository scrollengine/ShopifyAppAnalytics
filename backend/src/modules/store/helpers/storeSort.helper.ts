'use strict';

/**
 * ============================================================================
 *  HOW A STORE LIST IS ORDERED
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, no clock. It imports one shared helper, which is
 *  itself pure — so the whole ordering can be exercised against literal rows.
 *
 *  ── ONE COMPARATOR, THREE TABLES ───────────────────────────────────────────────────────────
 *
 *  The comparison itself lives in `shared/helpers/listQuery.helper` and is shared with the install
 *  cohort. Only the VALUE EXTRACTION is here, because the tables sort on different keys — and
 *  extraction is the half that must know what a store row is. Keeping the rules together in the
 *  shared file is what stops the tables disagreeing about where an unmeasured value belongs, which
 *  is the read-layer version of the drift `storePresentation.js` exists to prevent on screen.
 *
 *  The Stores roster and the Subscriptions list have TWO allowlists and ONE set of rules: they
 *  overlap on `customer_name`, `monthly_spend` and `total_spend`, and each has keys the other has no
 *  column for (`installed_at` / `install_state_at` there, `activation_date` / `conversion_date` /
 *  `churn_date` / `plan_name` here). Both extractors go through the same three coercions below, so
 *  a blank plan name and a null install date sort to the same end of the list on both pages.
 *
 *  ── NULLS SORT LAST REGARDLESS OF DIRECTION ────────────────────────────────────────────────
 *
 *  A store with no install date is not "the earliest" when you ask for oldest-first, and a store
 *  that has never paid is not "the cheapest" when you ask for lowest spend first. Both are stores we
 *  have no figure for, and floating an ABSENCE to the top of a list presents it as an extreme value —
 *  which is exactly how an operator ends up reading the never-synced stores as their smallest
 *  customers.
 *
 *  ── `''` IS FOLDED TO `null` BEFORE COMPARING ──────────────────────────────────────────────
 *
 *  A blank string is an absence too, and left as a string it sorts to the very top of an ascending
 *  alphabetical list. `customer_name` can never be blank — the field resolver falls back to the
 *  domain — but `shop_domain` is read defensively here anyway, because the one row that ever arrives
 *  with a null domain takes `localeCompare` down with it and the service's catch turns that into a
 *  refusal of the WHOLE endpoint.
 * ============================================================================
 */

import listQueryHelper = require('../../shared/helpers/listQuery.helper');

import type { StoreRosterRow, StoreRosterSortKey, StoreSortDirection } from '../types/storeRoster.types';
import type { SubscriptionListRow, SubscriptionListSortKey } from '../types/subscriptionList.types';

const { compareSortValues } = listQueryHelper;

/** Epoch milliseconds from a Date, or `null` — never `0`, which sorts as 1970 rather than as absent. */
const _time = (value: Date | null | undefined): number | null => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.getTime();
    }
    return null;
};

/** A non-empty string, or `null`. `''` is an absence and must sort with the other absences. */
const _string = (value: unknown): string | null => {
    if (value === null || value === undefined) {
        return null;
    }
    const text = String(value);
    return text === '' ? null : text;
};

/** A finite number, or `null`. ⚠️ `Number(null)` is `0`, so the null test comes FIRST. */
const _number = (value: unknown): number | null => {
    if (value === null || value === undefined) {
        return null;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

/**
 * The value a row sorts on for a given key.
 *
 * Dates become epoch milliseconds so the comparator has one numeric path.
 *
 * @param row - The row.
 * @param key - One of the allowlisted sort keys.
 * @returns The comparable value, or null when the row has none.
 */
const storeSortValue = (row: StoreRosterRow, key: StoreRosterSortKey): number | string | null => {
    if (key === 'installed_at') {
        return _time(row.installed_at);
    }
    if (key === 'install_state_at') {
        return _time(row.install_state_at);
    }
    if (key === 'latest_install_at') {
        return _time(row.latest_install_at);
    }
    if (key === 'customer_name') {
        return _string(row.customer_name);
    }
    if (key === 'shop_domain') {
        return _string(row.shop_domain);
    }
    if (key === 'monthly_spend') {
        return _number(row.monthly_spend);
    }
    return _number(row.total_spend);
};

/**
 * The row comparator.
 *
 * The final tie-break is `shop_domain` ascending in BOTH directions, so paging through a large
 * roster is stable rather than reshuffling equal rows between requests — on screen that reads as the
 * data changing under the reader.
 *
 * @param a - Left row.
 * @param b - Right row.
 * @param key - The sort key.
 * @param dir - `asc` or `desc`.
 * @returns Negative, zero or positive.
 */
const compareStoreRows = (a: StoreRosterRow, b: StoreRosterRow, key: StoreRosterSortKey, dir: StoreSortDirection): number => {
    const cmp = compareSortValues(storeSortValue(a, key), storeSortValue(b, key), dir);
    if (cmp !== 0) {
        return cmp;
    }
    return String(a.shop_domain || '').localeCompare(String(b.shop_domain || ''));
};

/**
 * The value a SUBSCRIPTION row sorts on for a given key.
 *
 * Dates become epoch milliseconds so the comparator has one numeric path.
 *
 * ⚠️ `plan_name` and `activation_date` go through `_string` / `_time` like everything else, which is
 * what puts a ledger-only row — no synced subscription event, so no plan name and no activation date
 * — at the END of the list in BOTH directions rather than at the top of an ascending one. Such a row
 * is a merchant we cannot describe, not the earliest or the alphabetically-first one.
 *
 * @param row - The row.
 * @param key - One of the allowlisted sort keys.
 * @returns The comparable value, or null when the row has none.
 */
const subscriptionSortValue = (row: SubscriptionListRow, key: SubscriptionListSortKey): number | string | null => {
    if (key === 'activation_date') {
        return _time(row.activation_date);
    }
    if (key === 'conversion_date') {
        return _time(row.conversion_date);
    }
    if (key === 'churn_date') {
        return _time(row.churn_date);
    }
    if (key === 'customer_name') {
        return _string(row.customer_name);
    }
    if (key === 'plan_name') {
        return _string(row.plan_name);
    }
    if (key === 'monthly_spend') {
        return _number(row.monthly_spend);
    }
    return _number(row.total_spend);
};

/**
 * The subscription row comparator.
 *
 * The final tie-break is `shop_domain` ascending in BOTH directions, exactly as the roster's is, so
 * paging through a large list is stable rather than reshuffling equal rows between requests — on
 * screen that reads as the data changing under the reader.
 *
 * @param a - Left row.
 * @param b - Right row.
 * @param key - The sort key.
 * @param dir - `asc` or `desc`.
 * @returns Negative, zero or positive.
 */
const compareSubscriptionRows = (
    a: SubscriptionListRow,
    b: SubscriptionListRow,
    key: SubscriptionListSortKey,
    dir: StoreSortDirection
): number => {
    const cmp = compareSortValues(subscriptionSortValue(a, key), subscriptionSortValue(b, key), dir);
    if (cmp !== 0) {
        return cmp;
    }
    return String(a.shop_domain || '').localeCompare(String(b.shop_domain || ''));
};

export = {
    storeSortValue,
    compareStoreRows,
    subscriptionSortValue,
    compareSubscriptionRows
};
