/**
 * THE only place a confidence envelope is built.
 *
 * Every figure this project publishes is wrapped here, by one of four constructors that each state
 * how well the number is known. The point is not decoration: it is that a service CANNOT hand a
 * number to the API layer without saying where it came from, and cannot hand up a missing number at
 * all except as `unknown` with a reason.
 *
 * PURE — no models, no config, no clock reads, no I/O. A figure's provenance is decided by the
 * caller that computed it, so nothing here needs to look anything up. Keeping it pure is also what
 * makes it trivially unit-testable, which matters for the one primitive the whole promise rests on.
 *
 *  Do not construct an `Envelope` literal anywhere else. An object literal can claim
 * `confidence: 'measured'` over a value nobody measured, or pair a `null` value with a confidence
 * that says the number is known — and both compile. These four functions are what make that
 * impossible, and they are only load-bearing while they are the sole entry point.
 *
 * Usage:
 *
 *     measured(activeSubscribers, 'partner api events')
 *     derived(mrr / subscribers, 'partner api events', 'closing mrr / active subscribers')
 *     estimated(projectedChurn, 'settled payouts', 'assumes payouts settle within 30 days')
 *     unknown('no partner data before 2024-03', 'partner api events')
 */

import type { Envelope } from '../types/confidence.types';

/** `source` for an envelope whose caller named none. Never invent a plausible-looking source. */
const UNKNOWN_SOURCE = 'none';
const MISSING_REASON = 'reason not stated';
const MISSING_BASIS = 'basis not stated';
const MISSING_CAVEAT = 'caveat not stated';

/**
 * True when a value carries no information and therefore cannot be published as a figure.
 *
 * `null` and `undefined` are the obvious cases. `NaN` and `±Infinity` are the dangerous ones: they
 * are what a division by an empty denominator produces, they are typed `number` so nothing upstream
 * objects, and they render as "NaN" or "Infinity" in a dashboard — a visibly broken number rather
 * than an honest "we cannot say". Catching them here turns each into an `unknown` with a reason.
 *
 * Deliberately NOT falsy-based: a measured `0`, an empty string and `false` are real answers, and
 * `!value` would erase exactly the zero this module exists to distinguish from unknown.
 *
 * @param value - Any candidate figure.
 * @returns True when the value must not be published as known.
 */
const _isMissing = (value: unknown): boolean => {
    if (value === null || value === undefined) {
        return true;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
        return true;
    }
    return false;
};

/**
 * Freezes a finished envelope.
 *
 * An envelope is a published claim, so it is immutable once made. Freezing stops the one mutation
 * that would defeat the whole primitive — a caller taking an `unknown` envelope and assigning a
 * `value` onto it (or upgrading a `derived` to `measured`) without going back through a constructor.
 * The write is refused either way — the value is unchanged — but whether it also THROWS depends on
 * the CALLER, not on this module. Every `.ts` here compiles with `strict`, which emits a
 * `"use strict"` prologue, so a mutation from anywhere in the codebase raises a TypeError. A
 * sloppy-mode plain-JS caller (a hand-written test script, say) silently no-ops instead, so a test
 * asserting the throw has to run in strict mode itself. Verified empirically, not assumed.
 *
 * @param envelope - The envelope to seal.
 * @returns The same object, frozen.
 */
const _seal = <T>(envelope: Envelope<T>): Envelope<T> => {
    return Object.freeze(envelope);
};

/**
 * A figure with no answer.
 *
 *  This is the constructor that keeps `0` honest. Whenever a figure cannot be computed — the
 * window predates our records, the source was never connected, the denominator has no members —
 * return this, never a zero. A zero claims something about the business; this claims something
 * about the data, and the two are read completely differently by whoever sees the dashboard.
 *
 * Generic so it can stand in for a figure of any type: `Envelope<never>` is assignable to
 * `Envelope<number>`, so `unknown('…')` can be returned from anywhere a number was expected.
 *
 * @param reason - What is missing, in the reader's language. Shown in place of the number.
 * @param [source] - Which source came up empty, when there is one worth naming.
 * @returns An envelope with `value: null` and `confidence: 'unknown'`.
 */
const unknown = <T = never>(reason: string, source: string = UNKNOWN_SOURCE): Envelope<T> => {
    let _reason = reason;
    if (!_reason) {
        _reason = MISSING_REASON;
    }
    let _source = source;
    if (!_source) {
        _source = UNKNOWN_SOURCE;
    }
    return _seal<T>({
        value: null,
        confidence: 'unknown',
        source: _source,
        reason: _reason
    });
};

/**
 * A figure counted directly out of stored records, with no arithmetic in between.
 *
 * The records themselves may be incomplete — that is what `source` tells the reader — but nothing
 * was inferred to produce the number.
 *
 * A missing value is DOWNGRADED to `unknown` rather than published as a measured `null`. That
 * combination would be a lie of exactly the shape this module exists to prevent: it renders as an
 * em dash while asserting the figure was measured.
 *
 * @param value - The counted figure. A genuine `0` is a real answer and stays `measured`.
 * @param source - Where it was counted, e.g. 'partner api events'.
 * @returns A `measured` envelope, or an `unknown` one when the value is missing.
 */
const measured = <T>(value: T, source: string): Envelope<T> => {
    let _source = source;
    if (!_source) {
        _source = UNKNOWN_SOURCE;
    }
    if (_isMissing(value)) {
        return unknown<T>(`no measured value from ${_source}`, _source);
    }
    return _seal<T>({
        value,
        confidence: 'measured',
        source: _source
    });
};

/**
 * A figure computed from other figures — a ratio, a difference, a rollup.
 *
 * Correct only insofar as its inputs are, so the arithmetic travels with it: `basis` is stored in
 * the envelope's `caveat` slot, whose meaning is fixed by `confidence: 'derived'` (see
 * `types/confidence.types`). One qualifier field rather than two is deliberate — a separate `basis`
 * would give the same idea a second spelling to drift between.
 *
 * @param value - The computed figure.
 * @param source - Where its INPUTS came from, e.g. 'settled payouts'.
 * @param basis - The arithmetic, e.g. 'closing mrr / active subscribers'.
 * @returns A `derived` envelope, or an `unknown` one when the value is missing.
 */
const derived = <T>(value: T, source: string, basis: string): Envelope<T> => {
    let _source = source;
    if (!_source) {
        _source = UNKNOWN_SOURCE;
    }
    let _basis = basis;
    if (!_basis) {
        _basis = MISSING_BASIS;
    }
    if (_isMissing(value)) {
        return unknown<T>(`could not derive ${_basis}`, _source);
    }
    return _seal<T>({
        value,
        confidence: 'derived',
        source: _source,
        caveat: _basis
    });
};

/**
 * A figure that was approximated, interpolated or extrapolated.
 *
 * A real number produced by a real method, but not a count of anything — so it always carries the
 * assumption that makes it approximate. Write the caveat so a reader knows which WAY it is likely
 * to be wrong ('excludes refunds, so reads high'), not merely that it is.
 *
 * @param value - The estimated figure.
 * @param source - What the estimate was built from.
 * @param caveat - The assumption, and its likely direction of error.
 * @returns An `estimated` envelope, or an `unknown` one when the value is missing.
 */
const estimated = <T>(value: T, source: string, caveat: string): Envelope<T> => {
    let _source = source;
    if (!_source) {
        _source = UNKNOWN_SOURCE;
    }
    let _caveat = caveat;
    if (!_caveat) {
        _caveat = MISSING_CAVEAT;
    }
    if (_isMissing(value)) {
        return unknown<T>(`no estimate available from ${_source}`, _source);
    }
    return _seal<T>({
        value,
        confidence: 'estimated',
        source: _source,
        caveat: _caveat
    });
};

export = {
    measured,
    derived,
    estimated,
    unknown
};
