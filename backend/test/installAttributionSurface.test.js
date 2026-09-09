'use strict';

/**
 * ============================================================================
 *  THE WRITE-TIME BOUNDARY — where the merchant's typed query stops
 * ============================================================================
 *
 *  `resolveSurface` is the ONE place a search-surface detail is dropped before anything downstream
 *  can store it. Everything after it — the repository `$set`, the Mongo projections, the two
 *  published-row read guards — is a second line of defence for rows that were already written. This
 *  file pins the first line.
 *
 *  ── WHY IT NEEDS ITS OWN FILE ───────────────────────────────────────────────────────────────
 *  The read guards MASK this one. `storeRow.resolver.ts` and `installCohort.service.ts` both blank a
 *  search-surface detail on the way out, so an API-level test answers `''` whether or not the value
 *  was ever suppressed at capture. Deleting the write-time branch therefore broke NOTHING in a
 *  593-test suite: the query would be extracted, normalised into a grouping key, and written to
 *  Mongo on every sync, and the only thing standing between it and a client would be a ternary two
 *  layers away. Mutation-tested: removing the branch left 592 passing and 1 pre-existing failure.
 *
 *  The function is pure by design — no models, no config, no clock, no I/O — precisely so this can
 *  be exercised against a captured row without a GCP project or a database. Nothing was stopping it
 *  from being tested except that nobody had.
 *
 *  ── WHAT IS BEING PINNED, EXACTLY ───────────────────────────────────────────────────────────
 *  A SUPPRESSED VALUE ON SEARCH SURFACES, NOT A REMOVED FIELD. Those are different changes with
 *  different blast radii, and the difference is the whole reason the branch is narrow:
 *
 *    search | search_ad | guided_search   the detail is the merchant's typed query   → dropped here
 *    home | category | collection | …     the detail is Shopify's own taxonomy or a
 *                                         section handle, and `homepage-ads` there is
 *                                         the only evidence an install was an ad click  → KEPT
 *
 *  Section 2 fails if the branch is deleted. Section 3 fails if it is widened to every surface —
 *  which would compile, throw nothing, change no row count, and quietly re-file the installs that
 *  `PAID_SECTION_HANDLES` records as 49 `home`/homepage-ads ad clicks as organic browsing.
 *
 *  ⚠️ No real merchant query appears in this file. The fixtures are obviously synthetic on purpose —
 *  a test that quotes a production search term ships exactly the data the suppression exists to
 *  withhold, and does it in a file nobody thinks to review for it.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'src');

const installAttribution = require(path.join(SRC, 'modules', 'bigquery', 'helpers', 'installAttribution.helper.ts'));
const surfaceConstants = require(path.join(SRC, 'modules', 'shared', 'constants', 'surface.constants.ts'));

const { resolveSurface } = installAttribution;
const { isPaidPlacement, SEARCH_SURFACES } = surfaceConstants;

/** The handle Shopify puts on the homepage ad slot. Spelled out so the test fails on a rename. */
const HOMEPAGE_ADS = 'homepage-ads';

/**
 * One `last_surface` touch, shaped as the SQL emits it.
 *
 * The field names differ from the resolved ones on purpose — the struct carries `inter_position` /
 * `intra_position` / `version` / `via`, and `resolveSurface` is what renames them. Building the
 * fixture from the struct's own vocabulary is what makes a rename on either side show up here.
 */
const _touch = (over) => ({
    last_surface: Object.assign({
        surface_type: '',
        surface_detail: '',
        inter_position: null,
        intra_position: null,
        locale: '',
        version: '',
        via: ''
    }, over)
});


/* ==========================================================================
 *  1. A row with no touch at all
 * ========================================================================== */

test('an install that carried no App Store touch resolves to empty, not to a fabricated surface', () => {
    // Most installs are server-side hits with no session stitched to them. That is a known-unknown
    // and must stay one — inventing a surface here would put those rows in a column of "Came from".
    const resolved = resolveSurface({});

    assert.equal(resolved.surface_type, '');
    assert.equal(resolved.surface_detail, '');
    assert.equal(resolved.surface_inter_position, null);
    assert.equal(resolved.surface_intra_position, null);
});


/* ==========================================================================
 *  2. SEARCH surfaces — the typed query never leaves this function
 * ========================================================================== */

test('a search surface resolves its detail to empty — the typed query is not captured', () => {
    // URL-encoded exactly as the listing-URL mechanism delivers it, so this fixture would decode
    // into a readable phrase if the branch were gone. That is the point: an assertion against an
    // ALREADY-EMPTY fixture proves nothing, because it passes with or without the suppression.
    const resolved = resolveSurface(_touch({
        surface_type: 'search',
        surface_detail: 'fixture+query+text'
    }));

    assert.equal(resolved.surface_detail, '',
        'the search-surface detail is the merchant\'s typed App Store query and this build does not '
        + 'capture it — the fixture carries a decodable value ON PURPOSE, so an empty result here is '
        + 'the write-time branch doing its job and not the fixture being empty to begin with');
});

test('every search surface is suppressed, not just the one named `search`', () => {
    // Membership lives in SEARCH_SURFACES and this loop reads it rather than restating it, so a
    // surface added to that list without being considered here fails instead of slipping through.
    // `search_ad` is the trap: it is a PAID surface, and paid-ness must not buy it an exemption.
    for (const surface of SEARCH_SURFACES) {
        const resolved = resolveSurface(_touch({
            surface_type: surface,
            surface_detail: 'fixture+query+text'
        }));
        assert.equal(resolved.surface_detail, '', `${surface} still published a detail`);
    }
});

test('percent-encoded and mixed-case search details are suppressed too', () => {
    // The branch keys on the LOWERCASED surface type, and the detail is dropped before decoding is
    // observable. Neither casing on the surface nor encoding on the value is a way through.
    const resolved = resolveSurface(_touch({
        surface_type: 'SEARCH',
        surface_detail: 'fixture%20query%20text'
    }));

    assert.equal(resolved.surface_type, 'search', 'the surface type is still normalised to lowercase');
    assert.equal(resolved.surface_detail, '');
});

test('suppressing the detail does not touch the rest of the touch', () => {
    // The rank, the locale and the capture mechanism are separate features that were never part of
    // this removal. A branch that reached any of them would be over-broad, and the "Served at"
    // column and the coverage diagnostic would go quiet with nothing to say why.
    const resolved = resolveSurface(_touch({
        surface_type: 'search',
        surface_detail: 'fixture+query+text',
        inter_position: '2',
        intra_position: '7',
        locale: 'en',
        version: 'V2',
        via: 'listing_url'
    }));

    assert.equal(resolved.surface_detail, '');
    assert.equal(resolved.surface_inter_position, 2, 'the results page survives — it is the "Served at" column');
    assert.equal(resolved.surface_intra_position, 7, 'the rank within the page survives');
    assert.equal(resolved.locale, 'en');
    assert.equal(resolved.surface_version, 'v2');
    assert.equal(resolved.surface_via, 'listing_url', 'the capture mechanism survives — coverage is diagnosed from it');
});


/* ==========================================================================
 *  3. BROWSE surfaces — the handle survives, and it is load-bearing
 * ========================================================================== */

test('a browse surface KEEPS its detail — it is Shopify\'s handle, not anything a merchant typed', () => {
    const resolved = resolveSurface(_touch({
        surface_type: 'home',
        surface_detail: HOMEPAGE_ADS
    }));

    assert.equal(resolved.surface_detail, HOMEPAGE_ADS,
        'the suppression was widened past search surfaces — this is the value the paid/organic split '
        + 'is read off, and blanking it re-files real ad clicks as organic browsing');
});

test('the surviving browse handle is what still marks the install PAID', () => {
    // The assertion above pins the VALUE; this one pins what the value is FOR. `home` carries no
    // `_ad` suffix, so if the detail ever stops arriving there is nothing else on the row that says
    // paid — and the failure is a wrong answer that looks exactly like a right one.
    const paid = resolveSurface(_touch({ surface_type: 'home', surface_detail: HOMEPAGE_ADS }));
    const organic = resolveSurface(_touch({ surface_type: 'home', surface_detail: 'recently-viewed' }));

    assert.equal(isPaidPlacement(paid.surface_type, paid.surface_detail), true);
    assert.equal(isPaidPlacement(organic.surface_type, organic.surface_detail), false,
        'the other `home` handle in the data is genuinely organic — the handle separates them, not the surface');
});

test('a browse detail is still URL-decoded on its way through', () => {
    // Category details arrive as encoded taxonomy paths. Suppressing the search meaning must not
    // cost the browse meaning its decode, or "Found via" starts rendering raw query-string text.
    const resolved = resolveSurface(_touch({
        surface_type: 'category',
        surface_detail: 'orders-and-shipping%2Fdelivery'
    }));

    assert.equal(resolved.surface_detail, 'orders-and-shipping/delivery');
});

test('a merchant who types the words "homepage ads" is not counted as an ad click', () => {
    // The one case where the two meanings collide. The detail is suppressed on the search surface,
    // and `isPaidPlacement` refuses to read a detail there at all — either guard alone is enough,
    // and both are asserted because losing one silently would leave the other carrying it unnoticed.
    const resolved = resolveSurface(_touch({
        surface_type: 'search',
        surface_detail: 'homepage+ads'
    }));

    assert.equal(resolved.surface_detail, '');
    assert.equal(isPaidPlacement('search', 'homepage ads'), false,
        'an organic search install would be counted as paid — in the one report whose entire purpose '
        + 'is telling those two apart');
});
