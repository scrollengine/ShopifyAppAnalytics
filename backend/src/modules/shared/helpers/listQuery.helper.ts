'use strict';

/**
 * ============================================================================
 *  LIST MECHANICS — the two rules every paginated, sorted table read shares
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, no clock. Two primitives, extracted rather than
 *  copied when the store roster became the second reader of both: how a query-bag number becomes a
 *  page bound, and how two already-extracted sort values compare.
 *
 *  Neither is interesting on its own. They are here because the ALTERNATIVE is interesting: two
 *  tables on the same dashboard, each with its own idea of where a missing value sorts, is precisely
 *  how `fmtDate` came to exist twice on the frontend with two different formats. The presentation
 *  layer already learned this lesson (`store/storePresentation.js` exists for it); the read layer
 *  gets the same treatment before it grows the second copy rather than after.
 *
 *  ── NULLS SORT LAST REGARDLESS OF DIRECTION ────────────────────────────────────────────────
 *
 *  A store with no install date is not "the earliest" when you ask for oldest-first — it is a store
 *  we do not have a date for, and floating it to the top of an ascending sort presents an ABSENCE as
 *  an extreme value. The same reasoning covers a null spend, a null trial end and a blank source:
 *  the honest place for "we did not measure this" is the end of the list, whichever end the reader
 *  asked to start from.
 *
 *  ── `localeCompare`, NEVER `<` ─────────────────────────────────────────────────────────────
 *
 *  `<` on strings orders by UTF-16 code unit, which puts `Z` before `a` and drops an accented domain
 *  into a different neighbourhood from its unaccented twin. Both tables list store domains, so both
 *  would show it.
 * ============================================================================
 */

/** Sort direction. Only these two; anything else is the caller's default, never an error. */
type SortDirection = 'asc' | 'desc';

/**
 * A whole number in `[1, max]` from anything at all, or the fallback.
 *
 * Deliberately tolerant: a controller hands query-bag values through raw (it validates SHAPE, never
 * data), so anything can arrive here. A junk `page` is a typo, not something worth refusing a whole
 * page of data over — `?page=banana` gives page 1, not a 400.
 *
 * @param value - The raw value, of any type.
 * @param fallback - Used when the value is missing or unusable.
 * @param max - Upper clamp, applied after flooring.
 * @returns A whole number in `[1, max]`.
 */
const positiveInt = (value: unknown, fallback: number, max: number): number => {
    const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return fallback;
    }
    return Math.min(Math.floor(parsed), max);
};

/**
 * Compares two ALREADY-EXTRACTED sort values. Returns `0` when they tie, so the caller applies its
 * own stable tie-break (both current callers use `shop_domain` ascending, which is what keeps paging
 * through a large list from reshuffling equal rows between requests — on screen that reads as the
 * data changing).
 *
 * `null` means "this row has no value for the sort key", and the caller is expected to fold `''` to
 * `null` before calling: a blank `source` means "no attribution record", which is an absence and
 * must sort with the other absences rather than at the top of the alphabet.
 *
 * ⚠️ The null branches are NOT multiplied by the direction. That is the whole point of the header's
 * first rule, and it is the line an "optimisation" removes first.
 *
 * @param av - The left row's value for the sort key.
 * @param bv - The right row's value.
 * @param dir - `asc` or `desc`. Anything else behaves as `desc`.
 * @returns Negative, zero or positive; zero means the caller must break the tie.
 */
const compareSortValues = (av: number | string | null, bv: number | string | null, dir: SortDirection): number => {
    if (av === null && bv === null) {
        return 0;
    }
    if (av === null) {
        return 1;
    }
    if (bv === null) {
        return -1;
    }

    const mul = dir === 'asc' ? 1 : -1;
    let cmp = 0;
    if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av < bv ? -1 : (av > bv ? 1 : 0);
    } else {
        cmp = String(av).localeCompare(String(bv));
    }
    return cmp * mul;
};

export = {
    positiveInt,
    compareSortValues
};
