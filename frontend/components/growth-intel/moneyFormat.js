/**
 * The one set of number/money/date formatters for the Growth Intelligence components.
 *
 * WHY IT EXISTS
 * -------------
 * `pages/revenue/index.js` keeps `_fmtMoney` / `_fmtNum` / `_fmtDate` as module-PRIVATE
 * consts, and every component that grew out of that page re-declared its own copy — three files now
 * carry a `_fmtMoney` that agrees by coincidence rather than by construction. A new component cannot
 * reach the page's copies at all, so it either duplicates them again or invents a fourth rounding
 * rule. This module is that shared surface.
 *
 *  THE `OrDash` CONTRACT: `null` means "we do not know", `0` means "we know, and it is zero".
 * They must never render the same. A `0` printed where the answer is unknown reads as a measured
 * result (a churn rate of 0.0% says "we have never lost a customer"), and a `—` printed where the
 * answer is genuinely zero hides a real fact. The plain `fmtMoney`/`fmtNum` pair collapses both onto
 * `—` for anything non-numeric, which is right for a display value but wrong for a computed metric —
 * that is what the `OrDash` variants are for, and why they are separate functions rather than a flag.
 */

/**
 * Money, two decimal places, locale-grouped. `—` for null/undefined/NaN.
 *
 * @param {Number} n
 * @returns {String}
 */
export const fmtMoney = (n) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/**
 * A count, locale-grouped. Strict about the type — anything that is not already a number is `—`,
 * matching the `_fmtNum` the revenue page and FunnelStats have always used.
 *
 * @param {Number} n
 * @returns {String}
 */
export const fmtNum = (n) => {
    if (typeof n !== 'number' || Number.isNaN(n)) return '—';
    return n.toLocaleString();
};

/**
 * Money with an explicit direction: `+` for positive, `−` (U+2212, the real minus — it aligns with
 * digits, unlike a hyphen) for negative. Zero carries no sign, because zero has no direction.
 *
 * @param {Number} n
 * @returns {String}
 */
export const fmtSigned = (n) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const value = Number(n);
    const body = fmtMoney(Math.abs(value));
    if (value > 0) return `+${body}`;
    if (value < 0) return `−${body}`;
    return body;
};

/**
 * Money for a COMPUTED figure: `—` only when the value is genuinely absent, never for a real `0`.
 *
 * @param {Number|null} n
 * @returns {String}
 */
export const fmtMoneyOrDash = (n) => {
    if (n === null || n === undefined) return '—';
    if (Number.isNaN(Number(n))) return '—';
    return fmtMoney(n);
};

/**
 * A count for a COMPUTED figure: `—` only when absent, `0` when it is really zero. Unlike `fmtNum`
 * this coerces, so a numeric string off a JSON payload still renders as a number.
 *
 * @param {Number|null} n
 * @returns {String}
 */
export const fmtNumOrDash = (n) => {
    if (n === null || n === undefined) return '—';
    const value = Number(n);
    if (Number.isNaN(value)) return '—';
    return value.toLocaleString();
};

/**
 * A rate expressed as a FRACTION (0.15 → `15.0%`), one decimal place.
 *
 *  `null` is `—`, not `0.0%`. A null rate means the ratio had no denominator — e.g. a churn rate
 * for a window that opened with no paying base, which every "All time" window does. `0.0%` there is
 * a claim we never measured.
 *
 * @param {Number|null} rate - a fraction, NOT an already-multiplied percentage.
 * @returns {String}
 */
export const fmtPercentOrDash = (rate) => {
    if (rate === null || rate === undefined) return '—';
    const value = Number(rate);
    if (Number.isNaN(value)) return '—';
    return `${(value * 100).toFixed(1)}%`;
};

/**
 * A date in the viewer's locale. Falls back to the raw value rather than throwing on junk input.
 *
 * @param {String|Date} d
 * @returns {String}
 */
export const fmtDate = (d) => {
    if (!d) return '—';
    try {
        return new Date(d).toLocaleDateString();
    } catch (e) {
        return String(d);
    }
};
