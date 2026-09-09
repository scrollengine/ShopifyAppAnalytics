'use strict';

/**
 * ============================================================================
 *  THE PAID/ORGANIC SPLIT — the one comparison nothing pinned
 * ============================================================================
 *
 *  `surface_detail` is DUAL PURPOSE, and which purpose depends entirely on the surface it arrived
 *  with:
 *
 *    BROWSE surfaces (`home`, `category`, `collection`, `app_group`, …)
 *      → Shopify's OWN taxonomy or section handle. `homepage-ads` on a `home` row is Shopify saying
 *        "this was the ad slot", and it is the only evidence that says so.
 *
 *    SEARCH surfaces (`search`, `search_ad`, `guided_search`)
 *      → the merchant's TYPED QUERY. Not Shopify's vocabulary at all — the merchant's.
 *
 *  `isPaidPlacement` is where those two meanings are told apart, and one comparison inside it —
 *  `surface_detail === 'homepage-ads'` on a browse surface — is the entire reason the count that
 *  `PAID_SECTION_HANDLES` records as 49 `home`/homepage-ads installs reads as ad clicks rather than
 *  as organic browsing. Shopify labels that one placement two ways depending on which mechanism
 *  observed it, the listing-URL label wins under last-touch, and so the paid side of the split lives
 *  almost entirely in the DETAIL rather than in the surface name.
 *
 *  ── WHY THIS FILE EXISTS, WHEN THE SUITE ALREADY HAD 27 OTHERS ──────────────────────────────
 *  Nothing pinned it. Before this file, no test in `test/` referenced `isPaidPlacement` or the
 *  string `homepage-ads` at all, and the three ways that gap stays invisible reinforce each other:
 *
 *    1. The demo seed classifies paid by `surface.surface_type.endsWith('_ad')`
 *       (`src/scripts/helpers/demoDataset.helper.ts`) and seeds no `home`/`homepage-ads` row, so
 *       every seeded install answers correctly on the surface NAME and the detail branch is never
 *       reached.
 *    2. `AttributionSignal.surface_detail` is OPTIONAL (`conversion/types/lifecycle.types.ts`), so a
 *       caller that stops populating the detail type-checks clean.
 *    3. Dropping the detail does not throw, does not change a row count, and does not change a
 *       total. It moves installs from one column of "Came from" into another, which is a wrong
 *       answer that looks exactly like a right one.
 *
 *  ── THE CHANGE THIS FILE IS ALSO HERE TO PROTECT ────────────────────────────────────────────
 *  The open-source build suppresses the merchant's typed query — the search-surface meaning of
 *  `surface_detail`. That is a suppression of a VALUE ON SEARCH SURFACES, never a removal of the
 *  FIELD, and section 3 asserts the property that makes the distinction safe: on every search
 *  surface, `isPaidPlacement` has already decided by the time it would look at the detail, so
 *  blanking that detail changes ZERO classifications. If a future edit deletes the field instead of
 *  blanking the value, section 1 fails loudly.
 *
 *  Everything under test is dependency-free — `surface.constants` imports nothing at all, and the
 *  classifier in section 4 reaches only constants — so this file needs no env, no config and no
 *  database.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src');

const surfaceConstants = require(path.join(SRC, 'modules', 'shared', 'constants', 'surface.constants.ts'));
const acquisitionChannel = require(path.join(SRC, 'modules', 'conversion', 'helpers', 'acquisitionChannel.helper.ts'));
const lifecycleConstants = require(path.join(SRC, 'modules', 'conversion', 'constants', 'lifecycle.constants.ts'));

const { isPaidPlacement, isPaidSurface, SEARCH_SURFACES, PAID_SECTION_HANDLES } = surfaceConstants;
const { classifyAcquisitionChannel } = acquisitionChannel;
const { ACQUISITION_CHANNELS } = lifecycleConstants;

/** The handle Shopify puts on the homepage ad slot. Spelled out here so the test fails on a rename. */
const HOMEPAGE_ADS = 'homepage-ads';


/* ==========================================================================
 *  1. On a BROWSE surface the detail IS the classification
 * ========================================================================== */

test('isPaidPlacement("home", "homepage-ads") is true — the recorded 49-install case', () => {
    // The whole paid side of the homepage split rests on this single comparison. `home` carries no
    // `_ad` suffix, so if the detail stops arriving there is nothing else on the row that says paid.
    assert.equal(isPaidPlacement('home', HOMEPAGE_ADS), true);

    // And it must be paid for a reason the row can be read back against, not by accident: the
    // surface name itself is NOT paid, so the answer can only have come from the detail.
    assert.equal(isPaidSurface('home'), false, 'the surface name answered — the detail is no longer load-bearing');
});

test('isPaidPlacement("home", "recently-viewed") is false — genuinely organic home browsing', () => {
    // The other `home` handle in the data. If this ever turned true the split would have stopped
    // reading the handle and started treating the whole homepage as an ad placement.
    assert.equal(isPaidPlacement('home', 'recently-viewed'), false);
});

test('the paid section handles are a real, non-empty list containing homepage-ads', () => {
    // Emptying the list, or renaming the handle on one side only, silently reclassifies every
    // homepage ad install as organic while every assertion about row counts still passes.
    assert.ok(Array.isArray(PAID_SECTION_HANDLES));
    assert.ok(PAID_SECTION_HANDLES.length > 0, 'PAID_SECTION_HANDLES is empty — the homepage split has no evidence left');
    assert.ok(PAID_SECTION_HANDLES.indexOf(HOMEPAGE_ADS) !== -1, `PAID_SECTION_HANDLES no longer contains ${HOMEPAGE_ADS}`);
});

test('the handle is matched after trimming and lowercasing, as the stored values arrive', () => {
    // Two mechanisms write this field and neither guarantees casing, so the comparison is made on a
    // cleaned value. A raw `===` here would drop whichever spelling it was not written against.
    assert.equal(isPaidPlacement('home', ' Homepage-Ads '), true);
    assert.equal(isPaidPlacement('HOME', HOMEPAGE_ADS), true);
});


/* ==========================================================================
 *  2. On a SEARCH surface the detail is the merchant's own words
 * ========================================================================== */

test('a merchant TYPING "homepage ads" is organic, not an ad click', () => {
    // The guard that makes the dual-purpose field safe. Without it, the search-surface meaning of
    // `surface_detail` would be read with the browse-surface vocabulary, and an organic search
    // install would be counted as paid — in the one report whose entire purpose is separating them.
    assert.equal(isPaidPlacement('search', 'homepage ads'), false);
    assert.equal(isPaidPlacement('search', HOMEPAGE_ADS), false, 'a merchant may type the handle verbatim');
    assert.equal(isPaidPlacement('guided_search', HOMEPAGE_ADS), false);
});


/* ==========================================================================
 *  3. The suffix rule stands on its own, with no detail at all
 * ========================================================================== */

test('isPaidPlacement("search_ad", "") is true — the surface name still decides', () => {
    // This is exactly the state the open-source build creates: a paid search surface whose typed
    // query has been suppressed. The `_ad` suffix is tested BEFORE the detail is ever consulted, so
    // a blank detail costs the classification nothing.
    assert.equal(isPaidPlacement('search_ad', ''), true);
});

test('isPaidPlacement("homepage_ad", "") is true — including the undocumented ad variant', () => {
    // `homepage_ad` appears in production and in no Shopify documentation. Classifying by suffix is
    // what keeps a variant nobody has seen yet on the correct side of the split.
    assert.equal(isPaidPlacement('homepage_ad', ''), true);
});

test('blanking a SEARCH detail changes no classification at all', () => {
    // The property the search-term suppression depends on, asserted rather than assumed: for every
    // search surface, the answer with the merchant's query present equals the answer with it gone.
    // Suppressing the VALUE is therefore invisible to the paid/organic split. Deleting the FIELD is
    // not — that is section 1, and it is a different edit.
    const typedQueries = ['fixture query text', 'homepage ads', HOMEPAGE_ADS, ''];

    for (const surface of SEARCH_SURFACES) {
        const blanked = isPaidPlacement(surface, '');
        for (const query of typedQueries) {
            assert.equal(
                isPaidPlacement(surface, query),
                blanked,
                `${surface}: suppressing the query "${query}" changed the paid/organic answer`
            );
        }
        // And the answer it settles on is the one the surface name gives, on both sides.
        assert.equal(blanked, isPaidSurface(surface), `${surface}: the suffix rule stopped deciding`);
    }
});


/* ==========================================================================
 *  4. What the reader actually sees — the "Came from" column
 * ========================================================================== */

test('the homepage ad install reaches the channel column as an AD, not as browsing', () => {
    // `classifyAcquisitionChannel` is the last step before the column is rendered, and it delegates
    // the paid question to `isPaidPlacement` rather than holding a second opinion. Pinning it here
    // means a regression is caught whether it lands in the predicate or in the delegation.
    const homepageAd = { surface_type: 'home', surface_detail: HOMEPAGE_ADS };
    assert.equal(classifyAcquisitionChannel(homepageAd), ACQUISITION_CHANNELS.APP_STORE_AD);

    const homeBrowse = { surface_type: 'home', surface_detail: 'recently-viewed' };
    assert.equal(classifyAcquisitionChannel(homeBrowse), ACQUISITION_CHANNELS.APP_STORE_BROWSE);

    const typedQuery = { surface_type: 'search', surface_detail: 'homepage ads' };
    assert.equal(classifyAcquisitionChannel(typedQuery), ACQUISITION_CHANNELS.APP_STORE_SEARCH);
});

test('a suppressed search detail still lands on the right channel, present or absent', () => {
    // Both spellings of "no detail" a suppressed row can carry — the empty string the sync writes,
    // and the missing field the optional type permits.
    const blankedPaid = { surface_type: 'search_ad', surface_detail: '' };
    const absentPaid = { surface_type: 'search_ad' };
    assert.equal(classifyAcquisitionChannel(blankedPaid), ACQUISITION_CHANNELS.APP_STORE_AD);
    assert.equal(classifyAcquisitionChannel(absentPaid), ACQUISITION_CHANNELS.APP_STORE_AD);

    const blankedOrganic = { surface_type: 'search', surface_detail: '' };
    const absentOrganic = { surface_type: 'guided_search', surface_detail: null };
    assert.equal(classifyAcquisitionChannel(blankedOrganic), ACQUISITION_CHANNELS.APP_STORE_SEARCH);
    assert.equal(classifyAcquisitionChannel(absentOrganic), ACQUISITION_CHANNELS.APP_STORE_SEARCH);
});
