/**
 * Shapes for `helpers/countryName.helper` — the geo-string normaliser every country rollup groups
 * through.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 */

/**
 * One resolved country.
 *
 * ⚠️ `name` IS THE INDEX'S OWN LABEL, never the caller's input. That is the whole point of resolving:
 * `US` and `United States` arrive as two strings and must leave as one row with one label, or the
 * country is split across two rows and both are wrong.
 */
export interface NormalisedCountry {
    /** Canonical ISO-3166-1 alpha-2, upper case. The grouping key and the row id. */
    code: string;
    /** The CLDR English name for that code. Always non-empty. */
    name: string;
}
