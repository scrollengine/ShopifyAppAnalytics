/**
 * The confidence envelope — the shape every published figure travels in.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 * This project's core promise is that a number never lies about how well it is known. Analytics
 * code fails silently: it does not throw, it returns a plausible wrong answer, and that answer ends
 * up in a board deck. The envelope is the structural defence — a figure cannot be published without
 * also publishing where it came from and how much weight it will bear.
 *
 * Build one ONLY through `shared/helpers/confidence.helper`. Hand-constructing this object anywhere
 * else re-opens exactly the hole the type exists to close: an object literal can claim
 * `confidence: 'measured'` over a value nobody measured, and nothing would catch it.
 */

/**
 * How well a figure is known. Ordered here from strongest to weakest.
 *
 * - `measured`  — counted directly out of stored records. The records may still be incomplete, which
 *                 is what `source` is for, but no arithmetic stands between the records and the number.
 * - `derived`   — computed from other figures (a ratio, a difference, a rollup). Correct only insofar
 *                 as its inputs are, so it carries the basis it was computed from.
 * - `estimated` — approximated, interpolated, or extrapolated. A real number with a real method
 *                 behind it, but not a count of anything. Always carries its caveat.
 * - `unknown`   — there is no answer. NOT a small answer, not a zero, not "probably nothing".
 */
export type Confidence = 'measured' | 'derived' | 'estimated' | 'unknown';

/**
 * One published figure plus everything a reader needs to weigh it.
 *
 *  `value: null` means UNKNOWN and must NEVER be rendered as `0`.
 *
 * Zero is a statement about the world — "you had no customers that month". `null` is a statement
 * about our data — "that month is before our records begin, so we cannot say". Collapsing the second
 * into the first is the single most damaging bug this codebase can ship, because the result is
 * indistinguishable from a real business outcome: a chart that draws to the floor, a churn figure
 * that looks catastrophic, a total that quietly under-reports. Render `null` as an em dash with its
 * `reason`, and break the line on a chart rather than plotting a point at zero.
 *
 * The converse also holds: a genuine measured `0` is NOT unknown, and must render as `0`. Only the
 * `null` carries the "no answer" meaning, which is why the helpers refuse to wrap a missing value in
 * anything other than `confidence: 'unknown'`.
 */
export interface Envelope<T> {
    /** The figure, or `null` when it cannot be computed. `null` ⇒ `confidence` is always `'unknown'`. */
    value: T | null;
    /** How well the value is known. See {@link Confidence}. */
    confidence: Confidence;
    /**
     * Where the figure came from, in the reader's language rather than a file path — e.g.
     * `'partner api events'`, `'settled payouts'`, `'listing analytics'`. Two figures from different
     * sources should never be compared without the reader seeing that they are.
     */
    source: string;
    /**
     * Why there is no value. Present on `unknown` envelopes, absent everywhere else.
     *
     * This is the text a reader sees in place of the number, so it has to say what is missing rather
     * than that something is: "no partner data before 2024-03" beats "not available".
     */
    reason?: string;
    /**
     * The qualifier a non-measured figure carries. Its meaning is fixed by `confidence`, which is
     * why one field serves both cases and there is no separate `basis`:
     *
     * - `derived`   ⇒ the BASIS: what the figure was computed from ("net settled payouts / active
     *                 subscribers"). Not a warning — a description of the arithmetic.
     * - `estimated` ⇒ the CAVEAT: why the number is approximate and which way it is likely to be
     *                 wrong ("assumes an unchanged plan price across the window").
     *
     * A second free-text field would only give the same idea two spellings to drift between.
     */
    caveat?: string;
}
