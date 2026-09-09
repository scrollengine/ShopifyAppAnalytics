'use strict';

/**
 * ============================================================================
 *  READING A BIGQUERY ROW — the coercions, in one place
 * ============================================================================
 *
 *  PURE. No models, no config, no clock reads, no I/O.
 *
 *  A BigQuery result row is genuinely untyped: its columns are whatever the SQL selected, and the
 *  SDK does not hand back the JavaScript types you would expect. DATE and TIMESTAMP columns arrive
 *  as `{ value: string }` wrappers, integers can arrive as strings, and a column the query aliased
 *  away is simply absent. Every one of those turns into a wrong number rather than an error if it is
 *  read naively, which is why the conversions live here and are the only ones used.
 *
 *  ⚠️ The `v: any` parameters are deliberate, not laziness. These functions read RAW result columns,
 *  and `unknown` would force a `String(v)` or a cast at each call site — changing what a non-string
 *  value produces, which is a behaviour change disguised as a typing change.
 *
 *  ── THERE IS NO DIVISION IN THIS FILE, AND THERE MUST NOT BE ONE AGAIN ──
 *
 *  This file used to export `safeDiv`:
 *
 *      if (!denom || denom === 0) return 0;   //  a division that answers 0 for "no denominator"
 *
 *  It was the SAME `_safeDiv` whose removal from the conversion tier is written up at length in
 *  `modules/conversion/helpers/funnelMath.helper.ts` — read that header; it is the specification
 *  this file now obeys. Kept alive here, it published `install_rate: 0` on a traffic-source row
 *  whose `views` were 0 and whose `installs` were 7 ("Installs 7 · Conversion rate 0.00%", a
 *  self-contradiction inside one row), and "Consent completion 0.00% · 0/0" — a claim that every
 *  merchant abandoned a screen nobody reached.
 *
 *  Both services in this module now divide through `funnelMath.helper`'s `rate()`, imported by deep
 *  path, which answers `null` for an absent denominator and still answers `0` for a MEASURED zero.
 *  One spelling of "divide" across the whole codebase: a second one is how the first comes back.
 * ============================================================================
 */

/**
 * A GA4 `DATE` column as a JavaScript Date, or null when it cannot be read.
 *
 * The SDK returns `{ value: 'YYYY-MM-DD' }`. Parsed at UTC midnight explicitly: `new Date('2026-03-01')`
 * is already UTC, but `new Date('2026-03-01T00:00:00')` is LOCAL, and the two differ by a whole day
 * for anyone west of Greenwich — which would file a day of installs against the wrong date.
 *
 * @param v - A raw DATE column.
 * @returns The date at UTC midnight, or null when the column is missing or unreadable.
 */
const bqDateToDate = (v: any): Date | null => {
    if (!v) {
        return null;
    }
    if (v instanceof Date) {
        return v;
    }
    if (typeof v === 'object' && v.value) {
        return new Date(`${v.value}T00:00:00Z`);
    }
    if (typeof v === 'string') {
        return new Date(`${v}T00:00:00Z`);
    }
    return null;
};

/**
 * A GA4 `DATE` **or** `TIMESTAMP` column as a Date, or null.
 *
 * Distinct from `bqDateToDate` because a TIMESTAMP arrives as a full ISO instant and must NOT have
 * `T00:00:00Z` appended — the length check is what tells the two apart. An unparseable value returns
 * null rather than an `Invalid Date`, which would otherwise be written to Mongo and then read back
 * as `null` by a consumer with no idea why.
 *
 * @param v - A raw DATE or TIMESTAMP column.
 * @returns The instant, or null when it cannot be parsed.
 */
const bqToDate = (v: any): Date | null => {
    if (!v) {
        return null;
    }
    if (v instanceof Date) {
        return v;
    }
    if (typeof v === 'object' && v.value) {
        let _iso = v.value;
        if (v.value.length === 10) {
            _iso = `${v.value}T00:00:00Z`;
        }
        const d = new Date(_iso);
        if (Number.isNaN(d.getTime())) {
            return null;
        }
        return d;
    }
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
        return null;
    }
    return d;
};

/**
 * A column as a string, with null and undefined collapsing to `''` rather than to `'null'`.
 *
 * @param v - Any raw column.
 * @returns The value as a string, or an empty string when absent.
 */
const str = (v: unknown): string => {
    if (v === null || v === undefined) {
        return '';
    }
    return String(v);
};

/**
 * A COUNT column as a finite number, with anything unreadable collapsing to 0.
 *
 * BigQuery hands INT64 back as a string often enough that `Number(row.x) || 0` is the only safe read
 * — and the `|| 0` is correct here rather than a falsy-default bug, because these are COUNTS whose
 * absent value genuinely is zero occurrences.
 *
 * COUNTS ONLY. Never read a RATE through this. `Number(null)` is `0`, so `num(rate)` turns "we
 * could not measure this" into "we measured zero" — silently, at the last coercion before the wire,
 * which is precisely the substitution the deleted `safeDiv` made one layer earlier. A rate is
 * computed by `funnelMath.helper`'s `rate()` from the row's own numerator and denominator, or it is
 * `null`; it is never coerced.
 *
 * @param v - A raw numeric COUNT column.
 * @returns The value, or 0.
 */
const num = (v: unknown): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
        return 0;
    }
    return n;
};

/**
 * Percent-decodes a value lifted out of the listing URL's query string.
 *
 * Decoded HERE and never in SQL. BigQuery has no URL-decode function, and the read-only guard
 * scans forbidden statement keywords across the whole statement INCLUDING string literals — so
 * merchant-supplied free text carrying an everyday word like "drop" would, inlined, make the query
 * unrunnable. Merchant text must never reach the SQL.
 *
 * `+` is unmapped by `decodeURIComponent` but means a space in a query string, so it is translated
 * first. A malformed sequence (a lone `%`) THROWS, which on a listing URL is a merchant typing a
 * literal percent — the raw value is returned rather than losing the whole row over it.
 *
 * @param v - A raw query-string value.
 * @returns The decoded, trimmed value.
 */
const decodeUrlValue = (v: unknown): string => {
    const raw = str(v).trim();
    if (raw === '') {
        return '';
    }
    try {
        return decodeURIComponent(raw.replace(/\+/g, ' ')).trim();
    } catch (decodeError) {
        return raw.replace(/\+/g, ' ').trim();
    }
};

/**
 * A 1-based App Store position, or null.
 *
 * ⚠️ Null rather than 0 for absent. Zero is a legitimate-looking rank and would average into the
 * position statistics as an impossibly good one — a missing rank must not improve the numbers.
 * Anything non-positive is treated as absent.
 *
 * @param v - A raw position value, possibly URL-encoded.
 * @returns The rounded position, or null.
 */
const toPosition = (v: unknown): number | null => {
    const n = Number(decodeUrlValue(v));
    if (!Number.isFinite(n) || n <= 0) {
        return null;
    }
    return Math.round(n);
};

/**
 * `value && value.message`, expressed so a `catch (error): unknown` can be read without a cast.
 *
 * The falsy branch returns the value ITSELF rather than undefined so this stays indistinguishable
 * from the JavaScript it replaces: `null && null.message` evaluates to `null`, and that is what
 * reached the log payload before this was typed.
 *
 * @param value - A caught error, or anything else that was thrown.
 * @returns Its `message`, the falsy value itself, or undefined.
 */
const readMessage = (value: unknown): unknown => {
    if (!value) {
        return value;
    }
    if ((typeof value === 'object' || typeof value === 'function') && 'message' in value) {
        return value.message;
    }
    return undefined;
};

/**
 * `value && value.errors` — the BigQuery SDK's own per-error array, read the same guarded way.
 *
 * @param value - A caught error.
 * @returns Its `errors`, the falsy value itself, or undefined.
 */
const readErrors = (value: unknown): unknown => {
    if (!value) {
        return value;
    }
    if ((typeof value === 'object' || typeof value === 'function') && 'errors' in value) {
        return value.errors;
    }
    return undefined;
};

export = {
    bqDateToDate,
    bqToDate,
    str,
    num,
    decodeUrlValue,
    toPosition,
    readMessage,
    readErrors
};
