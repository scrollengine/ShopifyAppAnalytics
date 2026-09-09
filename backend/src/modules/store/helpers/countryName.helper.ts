'use strict';

/**
 * ============================================================================
 *  ONE COUNTRY, ONE BUCKET — normalising a geo string before anything groups on it
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, no clock. The index is built once at import from
 *  `Intl.DisplayNames`, which is a lookup table in the runtime rather than an I/O call, so this file
 *  is exercisable against literal strings with no database.
 *
 *  ──  NORMALISE BEFORE GROUPING, NEVER AFTER ───────────────────────────────────────────────
 *
 *  The raw values arrive in inconsistent forms — `US` on some rows and `United States` on others,
 *  `Czechia` and `Czech Republic`, `Türkiye` and `Turkey` — and grouping on the raw value puts ONE
 *  country in TWO rows, so both are wrong, the totals still add up, and nothing on screen says so.
 *  Every caller therefore resolves to a CODE first and groups on that.
 *
 *  ──  AND THE FIX THAT IS WORSE THAN THE BUG ───────────────────────────────────────────────
 *
 *  The obvious repairs both shipped in the system this was extracted from:
 *
 *    - `getCode('United States')` returns undefined for most display names, so half the rows fall
 *      through to a remainder that then looks like a data problem rather than a mapping one;
 *    - STRIPPING PARENTHETICALS to make names match merges the two Congos, the two Koreas and both
 *      Virgin Islands into one row EACH. Two real countries silently become one, and the merged row
 *      is perfectly plausible.
 *
 *  So nothing here strips a qualifier. `Congo - Kinshasa` and `Congo - Brazzaville` normalise to
 *  `congokinshasa` and `congobrazzaville`; `South Korea` and `North Korea` to `southkorea` and
 *  `northkorea`; `British Virgin Islands` and `U.S. Virgin Islands` to `britishvirginislands` and
 *  `usvirginislands`. Distinct keys, distinct codes, distinct rows.
 *
 *  ── WHERE THE TABLE COMES FROM ──────────────────────────────────────────────────────────────
 *
 *  `Intl.DisplayNames` — CLDR's English region names, which is the same list the GA4 export is built
 *  from, so most values match on the primary name alone. Only CANONICAL codes are indexed:
 *  `Intl.getCanonicalLocales` is what drops the deprecated aliases (`UK`→`GB`, `AN`→`CW`, `ZR`→`CD`,
 *  `SU`→`RU`, …) which would otherwise collide with the live code and force a real country's name out
 *  of the index.
 *
 *  Two SYSTEMATIC spelling differences are generated rather than enumerated, because enumerating
 *  them is how a list falls one entry behind: CLDR writes `&` where other sources write `and`
 *  (`Antigua & Barbuda`), and `St.` where they write `Saint` (`St. Lucia`). Everything genuinely
 *  different — ISO long forms, common short forms, the ISO-3166 spellings — is in the explicit alias
 *  table, which is the part a reader can audit.
 *
 *  ── ⚠️ AMBIGUITY IS REFUSED, NOT GUESSED ────────────────────────────────────────────────────
 *
 *  An ambiguous name is simply NOT IN THE TABLE. `Korea`, `Congo`, `Virgin Islands` and `China` each
 *  name two entries in this index, so none of them is an alias — picking one would move a merchant's
 *  revenue to the wrong side of a border, and the unambiguous forms are all present. The caller
 *  publishes an unresolvable value in its explicit remainder and names it in a warning, so a reader
 *  sees the exact string that could not be placed rather than a country row it merely resembles.
 *
 *   SOMEBODY WILL EVENTUALLY READ THAT REFUSAL AS A GAP AND "FIX" IT. It is not a gap.
 *  `normaliseCountry('Korea')` answering `null` is the designed behaviour, and it is the same rule
 *  that keeps `Congo - Kinshasa` and `Congo - Brazzaville`, `South Korea` and `North Korea`, and
 *  `British Virgin Islands` and `U.S. Virgin Islands` in SIX buckets rather than three. A visible
 *  unknown an operator can chase beats an invisible error they cannot: adding `korea: 'KR'` here
 *  moves every South-Korean-looking merchant's revenue into a row that then looks exactly as correct
 *  as the rows beside it. `test/countryRollup.test.js` pins all three behaviours — two spellings
 *  folding into one bucket, the two Congos staying apart, and `Korea` reaching neither Korea.
 *
 *  The collision guard below is the other half of that: the passes are ordered so the CLDR primary
 *  names are written FIRST, and a generated variant or an alias can never overwrite one. Without it a
 *  spelling variant of one country could claim the primary name of another, which is the same error
 *  arriving through a different door.
 * ============================================================================
 */

import type { NormalisedCountry } from '../types/countryName.types';

/**
 * A lookup key: diacritics folded, case dropped, punctuation and spaces removed.
 *
 * ⚠️ It removes punctuation but NEVER a word. `Côte d’Ivoire` (CLDR uses a right single quotation
 * mark, not an apostrophe) and `Cote d'Ivoire` both key to `cotedivoire`, while `Congo - Kinshasa`
 * and `Congo - Brazzaville` stay apart — which is exactly the line the parenthetical-stripping fix
 * crossed.
 *
 * @param value - Any raw geo string.
 * @returns The key. `''` when the value holds no letters or digits at all.
 */
const _key = (value: string): string => {
    return String(value)
        .normalize('NFD')
        // Combining marks: `̀`–`ͯ`. Written as an escape rather than pasted, so the range
        // survives a copy through an editor that normalises the file.
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
};

/**
 * The values that mean WE DO NOT KNOW and must never become a country row.
 *
 * `ZZ` is CLDR's own "Unknown Region" and is excluded from the index for the same reason: it is the
 * absence of an answer wearing a code, and a row labelled "Unknown Region" beside a row labelled
 * "Unknown" would split the remainder in two.
 */
const _NO_GEO_KEYS: ReadonlySet<string> = new Set(['', 'notset', 'none', 'other', 'unknown', 'na', 'null', 'undefined', 'zz', 'unknownregion']);

/** Canonical ISO-3166-1 alpha-2 code → CLDR English name. Built once, at import. */
const _NAME_BY_CODE = new Map<string, string>();
/** Normalised name (and every accepted variant) → canonical code. */
const _CODE_BY_NAME = new Map<string, string>();

/**
 * Whether a two-letter code is the CANONICAL region code rather than a deprecated alias.
 *
 * `Intl.getCanonicalLocales('und-UK')` answers `und-GB`, so the test is simply whether the region
 * survives canonicalisation unchanged. Without it the index carries both `UK` and `GB` for
 * "United Kingdom", both `AN` and `CW` for "Curaçao", and the collision guard below would delete the
 * name entirely — losing a country to protect against a duplicate of itself.
 *
 * @param code - An upper-case two-letter candidate.
 * @returns True when the code is its own canonical form.
 */
const _isCanonicalRegion = (code: string): boolean => {
    try {
        const canonical = Intl.getCanonicalLocales(`und-${code}`);
        const match = /-([A-Z]{2})$/.exec(canonical[0] || '');
        return Boolean(match) && match![1] === code;
    } catch (error) {
        // An invalid subtag throws RangeError. That is a "no", not a failure.
        return false;
    }
};

/**
 * Registers a key, refusing to overwrite and refusing to disambiguate.
 *
 * @param key - The normalised name.
 * @param code - The code it should resolve to.
 */
const _register = (key: string, code: string): void => {
    if (key === '' || _NO_GEO_KEYS.has(key)) {
        return;
    }
    const incumbent = _CODE_BY_NAME.get(key);
    if (incumbent === undefined) {
        _CODE_BY_NAME.set(key, code);
        return;
    }
    // ⚠️ FIRST WRITER WINS, and the passes are ordered so the first writer is always the CLDR primary
    // name. A later variant or alias that would claim a primary name for a different country is
    // dropped rather than applied — the alternative is a merchant's revenue moving to a country whose
    // name merely resembles theirs.
};

// ── Pass 1: the canonical CLDR names ────────────────────────────────────────
//
// Wrapped because a Node built entirely without ICU has no `Intl.DisplayNames` at all. The index is
// then empty, every name falls to the alias table and then to the remainder, and `COUNTRY_INDEX_SIZE`
// lets the caller SAY SO rather than publishing a page of "Unknown".
try {
    const display = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' });
    for (let first = 65; first <= 90; first += 1) {
        for (let second = 65; second <= 90; second += 1) {
            const code = String.fromCharCode(first) + String.fromCharCode(second);
            const name = display.of(code);
            // `fallback: 'code'` echoes the input for a region CLDR does not know, so an echo is the
            // "no such region" signal.
            if (!name || name === code) {
                continue;
            }
            if (!_isCanonicalRegion(code)) {
                continue;
            }
            const key = _key(name);
            if (_NO_GEO_KEYS.has(key)) {
                continue;
            }
            _NAME_BY_CODE.set(code, name);
            _CODE_BY_NAME.set(key, code);
        }
    }
} catch (error) {
    // Left empty deliberately. See the note above the try.
}

// ── Pass 2: the two SYSTEMATIC spelling differences ─────────────────────────
//
// Generated from the primary names rather than listed, because a list of "&"/"and" pairs is a list
// that falls one entry behind the day CLDR adds a territory.
for (const [code, name] of _NAME_BY_CODE) {
    const variants = new Set<string>();
    variants.add(name.replace(/ & /g, ' and '));
    variants.add(name.replace(/\bSt\./g, 'Saint'));
    variants.add(name.replace(/ & /g, ' and ').replace(/\bSt\./g, 'Saint'));
    for (const variant of variants) {
        _register(_key(variant), code);
    }
}

/**
 * Everything genuinely different from CLDR's own spelling: ISO-3166 long forms, the common short
 * forms people actually type, and the handful of names that changed.
 *
 *  EVERY ENTRY NAMES EXACTLY ONE COUNTRY. `korea`, `congo`, `virginislands` and `china` are
 * DELIBERATELY ABSENT — each names two, and resolving one of them would move a merchant across a
 * border. They fall to the remainder and are reported there, which is a visible unknown rather than
 * an invisible error.
 */
const _ALIASES: Readonly<Record<string, string>> = Object.freeze({
    'united states of america': 'US',
    usa: 'US',
    'u.s.a.': 'US',
    'u.s.': 'US',
    // ⚠️ `UK` is a DEPRECATED alias of `GB`, so it is not in the canonical index and the two-letter
    // code path above cannot resolve it. It is far and away the commonest hand-typed value, so it is
    // named here rather than left to the remainder.
    uk: 'GB',
    'great britain': 'GB',
    'united kingdom of great britain and northern ireland': 'GB',
    uae: 'AE',
    'russian federation': 'RU',
    'republic of korea': 'KR',
    'korea, republic of': 'KR',
    'korea, south': 'KR',
    "democratic people's republic of korea": 'KP',
    'korea, north': 'KP',
    'viet nam': 'VN',
    'czech republic': 'CZ',
    turkey: 'TR',
    'ivory coast': 'CI',
    burma: 'MM',
    macau: 'MO',
    macao: 'MO',
    'hong kong': 'HK',
    'taiwan, province of china': 'TW',
    "lao people's democratic republic": 'LA',
    'lao pdr': 'LA',
    'syrian arab republic': 'SY',
    'bolivia, plurinational state of': 'BO',
    'venezuela, bolivarian republic of': 'VE',
    'united republic of tanzania': 'TZ',
    'tanzania, united republic of': 'TZ',
    'republic of moldova': 'MD',
    'moldova, republic of': 'MD',
    palestine: 'PS',
    'state of palestine': 'PS',
    'brunei darussalam': 'BN',
    'cabo verde': 'CV',
    'east timor': 'TL',
    swaziland: 'SZ',
    macedonia: 'MK',
    'republic of north macedonia': 'MK',
    'the former yugoslav republic of macedonia': 'MK',
    'democratic republic of the congo': 'CD',
    'congo, democratic republic of the': 'CD',
    'dr congo': 'CD',
    'drc': 'CD',
    'republic of the congo': 'CG',
    'congo, republic of the': 'CG',
    'congo republic': 'CG',
    'united states virgin islands': 'VI',
    'virgin islands, u.s.': 'VI',
    'virgin islands (u.s.)': 'VI',
    'virgin islands, british': 'VG',
    'virgin islands (british)': 'VG',
    'holy see': 'VA',
    'vatican city': 'VA',
    'iran, islamic republic of': 'IR',
    'islamic republic of iran': 'IR',
    'micronesia, federated states of': 'FM',
    'federated states of micronesia': 'FM',
    "cote d'ivoire": 'CI',
    'the netherlands': 'NL',
    'the bahamas': 'BS',
    'the gambia': 'GM',
    'the philippines': 'PH',
    'reunion': 'RE',
    'curacao': 'CW',
    'saint helena, ascension and tristan da cunha': 'SH',
    'south georgia and the south sandwich islands': 'GS',
    'heard island and mcdonald islands': 'HM',
    'french southern territories': 'TF',
    'united states minor outlying islands': 'UM',
    'bosnia and herzegovina': 'BA',
    'trinidad and tobago': 'TT',
    'antigua and barbuda': 'AG',
    'sao tome and principe': 'ST',
    'papua new guinea': 'PG'
});

for (const [alias, code] of Object.entries(_ALIASES)) {
    // ⚠️ Registered only when the code is one the runtime's own index actually knows. An alias
    // pointing at a code CLDR has no name for would resolve to a row this build cannot label.
    if (_NAME_BY_CODE.has(code)) {
        _register(_key(alias), code);
    }
}

/**
 * How many canonical regions the runtime's ICU data supplied.
 *
 * Published so a service can WARN when it is zero or implausibly small — a Node built without ICU
 * region data would otherwise put every store in the remainder and the page would report a business
 * with no geography rather than a runtime with no table.
 */
const COUNTRY_INDEX_SIZE = _NAME_BY_CODE.size;

/**
 * Resolves one raw geo string to a canonical country, or to nothing.
 *
 * Accepts a two-letter code (`US`) or a display name in any of the spellings above, in any case,
 * with or without diacritics. The NAME it returns is CLDR's, never the caller's input — which is what
 * makes `US` and `United States` render as one row with one label.
 *
 * @param raw - The stored geo value: `install_country`, a code, or anything at all.
 * @returns The country, or `null` when the value names none — an empty
 *   string, an explicit "not set" sentinel, or a name this index cannot place. The caller must put a
 *   `null` in its explicit remainder, never drop it, or the breakdown stops reconciling with the total.
 */
const normaliseCountry = (raw: unknown): NormalisedCountry | null => {
    if (raw === null || raw === undefined) {
        return null;
    }
    const text = String(raw).trim();
    const key = _key(text);
    if (_NO_GEO_KEYS.has(key)) {
        return null;
    }

    // A two-letter input is tried as a CODE first. `US` is not a name in any spelling, and a store
    // whose geo was already stored as a code must land in the same bucket as one stored as a name.
    if (key.length === 2) {
        const code = key.toUpperCase();
        const name = _NAME_BY_CODE.get(code);
        if (name) {
            return { code, name };
        }
    }

    const code = _CODE_BY_NAME.get(key);
    if (!code) {
        return null;
    }
    return { code, name: _NAME_BY_CODE.get(code) || code };
};

/**
 * Whether a raw geo value is an ABSENCE rather than a country this index failed to place.
 *
 *  THE TWO ARE DIFFERENT FACTS AND A CALLER MUST BE ABLE TO TELL THEM APART. Both land in the same
 * remainder row — neither may be dropped — but only one is worth reporting: `''` and `(not set)` mean
 * the analytics export recorded no geography, which is ordinary and needs no action, while
 * `Freedonia` means this index has a gap and the operator should be shown the exact string so it can
 * be fixed. Counting the first as the second would fire a "we could not place these" warning on every
 * deployment, which is how a warning stops being read.
 *
 * @param raw - The stored geo value.
 * @returns True when the value asserts no country at all.
 */
const isNoGeoValue = (raw: unknown): boolean => {
    if (raw === null || raw === undefined) {
        return true;
    }
    return _NO_GEO_KEYS.has(_key(String(raw)));
};

export = {
    normaliseCountry,
    isNoGeoValue,
    COUNTRY_INDEX_SIZE
};
