'use strict';

/**
 * ============================================================================
 *  FUNNEL ARITHMETIC — the division that must be able to say "I don't know"
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, no clock.
 *
 *  ── THE ONE FUNCTION THIS FILE EXISTS FOR ────────────────────────────────
 *
 *  The implementation this was ported from divided through `_safeDiv`:
 *
 *      if (!b || b === 0) return 0;      //  a division that answers 0 for "no denominator"
 *
 *  So `cumulative_conversion_pct` and the headline `conversion_rate` came back `0` whenever the
 *  first step was zero or unknown — and `_fmtHeadline(0)` renders **"0.00%"**, in 32-pixel type, at
 *  the top of the page. That is not a rendering artefact; it is a CLAIM ABOUT THE BUSINESS ("nobody
 *  who saw your listing installed") made by an arithmetic convenience. `_fmtHeadline(null)` renders
 *  an em dash, which claims nothing.
 *
 *  Every rate in this endpoint therefore goes through `rate()`, and `rate()` returns `null` for an
 *  empty, missing or non-finite denominator, and `null` for a missing numerator. There is no
 *  `orZero` variant and there must not be one: a second spelling of "divide" is how the first one
 *  comes back.
 *
 *  ── The other three are here because they are decisions, not utilities ──────
 *
 *  `resolveRequestedEvents` decides what the user actually asked for and NAMES everything it
 *  refused; `countShopsForTypes` fixes the union-not-sum rule in one place; `describeSelection`
 *  turns that into operator-facing sentences. All four are exercised against values with no
 *  database, which is what a pure helper is for.
 * ============================================================================
 */

import funnelEventConstants = require('../constants/funnelEvent.constants');

import type { ResolvedFunnelSelection } from '../types/customFunnel.types';

const { FUNNEL_EVENT_BY_KEY, MAX_FUNNEL_EVENTS } = funnelEventConstants;

/**
 * A ratio, or `null` when there is no honest ratio to give.
 *
 * NEVER RETURNS `0` FOR AN EMPTY DENOMINATOR. See the file header — that single substitution is
 * what put "0.00%" under the words "Conversion rate" on a dashboard whose funnel had never been
 * measured. `0` is a real answer and must stay reachable: `rate(0, 100)` is `0`, because nobody out
 * of a hundred converting is a measurement.
 *
 * ⚠️ A `null` NUMERATOR is also `null`, not `0`. An unknown count divided by a known one is not
 * "none of them"; the step's own tier could not answer.
 *
 * @param [numerator] - The count reaching this step, or null when unknown.
 * @param [denominator] - The count it is measured against, or null when unknown.
 * @returns The ratio in [0, ∞), or null when either side is unusable or the denominator is zero.
 */
const rate = (numerator?: number | null, denominator?: number | null): number | null => {
    if (numerator === null || numerator === undefined || !Number.isFinite(Number(numerator))) {
        return null;
    }
    if (denominator === null || denominator === undefined || !Number.isFinite(Number(denominator))) {
        return null;
    }
    const _denominator = Number(denominator);
    if (_denominator === 0) {
        return null;
    }
    const value = Number(numerator) / _denominator;
    return Number.isFinite(value) ? value : null;
};

/**
 * The drop-off implied by a conversion rate.
 *
 * `null` — NEVER A NEGATIVE NUMBER — when the conversion exceeds 1. That happens legitimately:
 * across the GA4/Partner seam a partial listing window can report fewer install clicks than there
 * were installs, and on the decided basis the denominator excludes the undecided. `1 - 1.42` is
 * `-0.42`, and "-42.0% drop-off" renders perfectly and means nothing. The caller warns when this
 * fires, naming the step, so the reader learns WHY the field is empty.
 *
 * @param [conversionPct] - A step's conversion rate, or null.
 * @returns `1 - conversionPct`, or null when there is none or it exceeds 1.
 */
const dropRate = (conversionPct?: number | null): number | null => {
    if (conversionPct === null || conversionPct === undefined || !Number.isFinite(Number(conversionPct))) {
        return null;
    }
    const value = Number(conversionPct);
    if (value > 1) {
        return null;
    }
    return 1 - value;
};

/**
 * The number of DISTINCT SHOPS across one step's event types.
 *
 * THE UNION OF THE SETS, NEVER THE SUM OF THEIR COUNTS. A step spanning
 * `[SUBSCRIPTION_CHARGE_ACCEPTED, SUBSCRIPTION_CHARGE_ACTIVATED]` and summing per-type counts
 * double-counts every shop that fired both — which is most of them, since the second follows the
 * first. The result is roughly twice the truth, is a whole number, and looks entirely reasonable
 * beside its neighbours.
 *
 * A type absent from the map contributes nothing, which is correct: the repository only returns
 * types that had rows, so an absent type is a measured zero and not an unknown. Whether the whole
 * TIER is unknown is decided one layer up, before this is ever called.
 *
 * @param shopsByType - `event_type` (or payout type) -> that type's distinct shop list.
 * @param [types] - The types this step spans.
 * @returns The size of the union.
 */
const countShopsForTypes = (
    shopsByType: Readonly<Record<string, readonly string[]>>,
    types?: readonly string[]
): number => {
    if (!types || types.length === 0) {
        return 0;
    }
    const union = new Set<string>();
    for (const type of types) {
        const shops = shopsByType[type];
        if (!shops) {
            continue;
        }
        for (const shop of shops) {
            union.add(shop);
        }
    }
    return union.size;
};

/**
 * Splits a raw `events` parameter into an ordered list of candidate keys.
 *
 * Accepts what the wire actually sends: the page joins its selection with commas
 * (`funnel/index.js`), and a repeated query parameter arrives as an array. Nested arrays are
 * flattened because Express will produce one for `?events=a,b&events=c`.
 *
 * @param raw - The `events` query value: a string, an array, or nothing.
 * @returns Trimmed, non-empty candidates, in the order given.
 */
const _splitEventParam = (raw: unknown): string[] => {
    const out: string[] = [];
    const _push = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const item of value) {
                _push(item);
            }
            return;
        }
        if (value === null || value === undefined) {
            return;
        }
        for (const part of String(value).split(',')) {
            const key = part.trim();
            if (key !== '') {
                out.push(key);
            }
        }
    };
    _push(raw);
    return out;
};

/**
 * Whether a key names a REAL catalog entry.
 *
 * `Object.hasOwn`, NEVER a bare `known[key]` truthiness test — which is how this shipped. The
 * index used to inherit `Object.prototype`, so `toString`, `constructor`, `valueOf`,
 * `hasOwnProperty` and `__proto__` all read back TRUTHY and passed straight through as known steps.
 * `?events=installed,toString,valueOf` then drew three bars: two of them shapeless, with `count: 0`,
 * `available: true` and no warning at all, and a headline `conversion_rate` of `0` rendering as
 * "0.00%" under the words "Conversion rate" — this file's own defect, reached through the selection
 * path rather than the division.
 *
 * ⚠️ The index is null-prototype now (see `constants/funnelEvent.constants.ts`), so this is the
 * second of two independent guards. Both are kept deliberately: a future edit that rebuilds the
 * index with `Object.fromEntries` restores the inheritance in one line and nothing else would catch
 * it. The `Boolean(...)` half additionally rejects an own key whose value is missing, which is what
 * makes the service's `entry && entry.key` guard agree with this one.
 *
 * @param key - A candidate step key from the caller.
 * @returns True only when the catalog carries an entry of its own under that key.
 */
const _isCatalogKey = (key: string): boolean => {
    return Object.hasOwn(FUNNEL_EVENT_BY_KEY, key) && Boolean(FUNNEL_EVENT_BY_KEY[key]);
};

/**
 * Resolves what the caller asked for into the steps that will actually be drawn.
 *
 * EVERY REJECTION IS NAMED. The ported implementation dropped unknown keys and `break`ed at the
 * cap with no signal at all — and the page then persists `steps.map(s => s.key)` straight back into
 * `localStorage['gi.funnel.stepEvents']`. So one typo in a saved selection PERMANENTLY REPLACED the
 * user's funnel with the server's silently-rewritten version, and there was nothing on screen to
 * undo it from. Returning the rejections is what lets the service say so.
 *
 * ⚠️ DUPLICATES ARE COLLAPSED, and that is not tidiness either: the chart keys its bars, labels and
 * chips by `step.key` (`PartnerFunnelChart.js:341`, `:380`, `:433`). Two steps with one key are two
 * React children with one key — the second is dropped by React with a console warning nobody sees
 * in production, so the funnel silently loses a step it drew a bar for.
 *
 * ⚠️ ORDER IS PRESERVED EXACTLY. The order IS the funnel: it decides every step's denominator, and
 * the page saves it. Sorting here, even into catalog order, rewrites the user's own analysis.
 *
 * @param params0 - The parameters object.
 * @param params0.requested - The raw `events` value: comma-joined string, array, or nothing.
 * @param params0.fallback_keys - Applied when nothing usable was named.
 * @param [params0.max] - The step cap. Defaults to `MAX_FUNNEL_EVENTS`.
 * @returns The keys to draw, and everything that was refused.
 */
const resolveRequestedEvents = ({
    requested,
    fallback_keys,
    max = MAX_FUNNEL_EVENTS
}: {
    requested: unknown;
    fallback_keys: readonly string[];
    max?: number;
}): ResolvedFunnelSelection => {
    const candidates = _splitEventParam(requested);

    const unknown: string[] = [];
    const duplicates: string[] = [];
    const accepted: string[] = [];
    const seen = new Set<string>();

    for (const key of candidates) {
        if (!_isCatalogKey(key)) {
            // Collected rather than dropped. A key the catalog does not carry cannot be drawn — see
            // the constants file for what a non-catalog step does to the reorder buttons — but the
            // caller must be told which one, or the correction is unfindable.
            if (!unknown.includes(key)) {
                unknown.push(key);
            }
            continue;
        }
        if (seen.has(key)) {
            if (!duplicates.includes(key)) {
                duplicates.push(key);
            }
            continue;
        }
        seen.add(key);
        accepted.push(key);
    }

    // ⚠️ The fallback applies when nothing USABLE was named, not merely when nothing was sent. A
    // request naming only unknown keys must still produce a funnel — plus the warning that says
    // which keys went missing — rather than an empty chart that reads as "no data".
    const usedFallback = accepted.length === 0;
    const resolved = usedFallback ? fallback_keys.filter((key) => _isCatalogKey(key)) : accepted;

    const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_FUNNEL_EVENTS;
    const keys = resolved.slice(0, cap);
    const droppedOverCap = resolved.slice(cap);

    return {
        keys,
        unknown,
        duplicates,
        dropped_over_cap: droppedOverCap,
        used_fallback: usedFallback
    };
};

export = {
    rate,
    dropRate,
    countShopsForTypes,
    resolveRequestedEvents
};
