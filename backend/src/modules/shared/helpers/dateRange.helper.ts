/**
 * Resolves a request's date window into a `{ since, until, isLifetime, periodLabel }`
 * tuple shared by every Growth-Intel service that supports time filtering.
 *
 * Caller passes the raw input from the API layer:
 *   - `since` + `until` — ISO date strings (`YYYY-MM-DD`). Take precedence
 *     when both are present and parseable.
 *   - `period_days` — `'all'` / `0` for lifetime, otherwise a positive number
 *     of days back from now.
 *
 * Default when nothing is provided: last 30 days.
 *
 * Boundaries are inclusive on both ends — `since` is set to the start of the
 * day and `until` to the end of the day to make BigQuery / Mongo range queries
 * intuitive.
 */

import type { ResolveDateRangeInput, ResolvedDateRange } from '../types/dateRange.types';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const _parseIsoDate = (s: string | undefined): Date | null => {
    if (!s || typeof s !== 'string' || !ISO_DATE_RE.test(s)) {
        return null;
    }
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (Number.isNaN(dt.getTime())) {
        return null;
    }
    return dt;
};

const _startOfDayUtc = (d: Date): Date => {
    const c = new Date(d);
    c.setUTCHours(0, 0, 0, 0);
    return c;
};

const _endOfDayUtc = (d: Date): Date => {
    const c = new Date(d);
    c.setUTCHours(23, 59, 59, 999);
    return c;
};

const _fmtPretty = (d: Date | null): string => {
    if (!d) {
        return '';
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

/**
 * Resolves the window.
 *
 * @returns `{ since, until, isLifetime, periodDays, periodLabel, kind }`
 *   - `since`: Date (UTC start-of-day) or null for lifetime.
 *   - `until`: Date (UTC end-of-day) — always set (defaults to now).
 *   - `isLifetime`: true when no lower bound applies.
 *   - `periodDays`: numeric days when preset, null when custom/lifetime.
 *   - `periodLabel`: human-readable label (e.g. "All time", "Last 30 days", "Jan 1 – Feb 14, 2026").
 *   - `kind`: 'lifetime' | 'preset' | 'custom'.
 */
const resolveDateRange = ({ period_days, since, until, defaultPeriodDays = 30 }: ResolveDateRangeInput = {}): ResolvedDateRange => {
    const _sinceDate = _parseIsoDate(since);
    const _untilDate = _parseIsoDate(until);

    // Custom window: both since AND until parseable.
    if (_sinceDate && _untilDate) {
        // Tolerate swapped inputs.
        const lo = _sinceDate <= _untilDate ? _sinceDate : _untilDate;
        const hi = _sinceDate <= _untilDate ? _untilDate : _sinceDate;
        return {
            since: _startOfDayUtc(lo),
            until: _endOfDayUtc(hi),
            isLifetime: false,
            periodDays: null,
            periodLabel: `${_fmtPretty(lo)} – ${_fmtPretty(hi)}`,
            kind: 'custom'
        };
    }

    // Lifetime: explicit 'all' / 0.
    const _isLifetime = period_days === 'all' || period_days === 0 || period_days === '0';
    if (_isLifetime) {
        return {
            since: null,
            until: _endOfDayUtc(new Date()),
            isLifetime: true,
            periodDays: null,
            periodLabel: 'All time',
            kind: 'lifetime'
        };
    }

    // Preset: positive integer.
    // `String(period_days)` rather than the bare value only because `period_days` is optional here:
    // `parseInt(undefined)` and `parseInt('undefined')` both yield NaN, so the fallback below is
    // reached identically either way.
    const _raw = typeof period_days === 'number' ? period_days : parseInt(String(period_days), 10);
    const _days = Number.isFinite(_raw) && _raw > 0 ? _raw : defaultPeriodDays;
    const _now = new Date();
    const _from = new Date(_now.getTime() - _days * 24 * 60 * 60 * 1000);

    let label: string;
    if (_days === 365) {
        label = 'Last 1 year';
    } else if (_days === 90) {
        label = 'Last 90 days';
    } else if (_days === 30) {
        label = 'Last 30 days';
    } else if (_days === 7) {
        label = 'Last 7 days';
    } else {
        label = `Last ${_days} days`;
    }

    return {
        since: _startOfDayUtc(_from),
        until: _endOfDayUtc(_now),
        isLifetime: false,
        periodDays: _days,
        periodLabel: label,
        kind: 'preset'
    };
};

export = {
    resolveDateRange
};
