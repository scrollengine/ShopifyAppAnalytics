'use strict';

/**
 * ============================================================================
 *  APP STORE SURFACE VOCABULARY — pure, dependency-free
 * ============================================================================
 *
 *  `surface_type` / `surface_detail` describe WHERE inside the Shopify App Store a merchant found
 *  the listing. Shopify delivers them two ways, and only their union sees organic traffic:
 *
 *    1. `shopify_app_ad_click` event params  — ad journeys only.
 *    2. The listing URL's query string       — EVERY App Store referral, organic included.
 *
 *  THE DOCUMENTED VALUE LIST IS INCOMPLETE. Shopify's documentation enumerates
 *  `home | search | search_ad | category | collection | story | partners | app_details | app_group`,
 *  but production data carries `homepage_ad`, which appears nowhere in it. Shopify evidently emits a
 *  per-surface ad variant, so `category_ad` and friends should be assumed to exist. Testing
 *  `=== 'search_ad'` for "was this paid" therefore MISCLASSIFIES every other ad surface as organic
 *  browsing — it did exactly that to 47 installs before this file existed. Classify by the `_ad`
 *  SUFFIX, which is Shopify's own naming convention, so a variant nobody has seen yet still lands on
 *  the right side.
 *
 *  This module is deliberately dependency-free so its predicates can be unit-tested without the data
 *  layer — it imports nothing at all, config included.
 *
 *  It lives in `shared/` rather than beside the BigQuery sync that writes these values because every
 *  READER needs the same classification. A filter that spells "paid" its own way is how a report and
 *  the sync that fed it end up disagreeing about the same row.
 * ============================================================================
 */

/** Which mechanism produced a stored surface. Kept on the row so coverage is diagnosable. */
const SURFACE_VIA = Object.freeze({
    /** From `shopify_app_ad_click` event params — a paid journey. */
    AD_CLICK_EVENT: 'ad_click_event',
    /** Parsed off the listing URL's query string — the only organic-capable source. */
    LISTING_URL: 'listing_url'
} as const);

/** Shopify's naming convention for a paid variant of any surface (`search_ad`, `homepage_ad`, …). */
const PAID_SURFACE_SUFFIX = '_ad';

/** The organic App Store search results page. Its detail is free text, not a taxonomy handle. */
const SURFACE_SEARCH = 'search';
/** The paid slot on that same results page. Its detail is free text likewise. */
const SURFACE_SEARCH_AD = 'search_ad';
/**
 * The App Store's assisted / guided search flow. Undocumented, like `homepage_ad`.
 *
 * Confirmed a free-text surface from production data: 3 installs, 3 DISTINCT details, not one of them
 * a taxonomy handle — and every one carried a rank.
 */
const SURFACE_GUIDED_SEARCH = 'guided_search';

/**
 * Every surface whose `surface_detail` is FREE TEXT rather than a taxonomy handle.
 *
 * Membership is decided HERE and nowhere else, because this list is not a label — it is the
 * boundary several unrelated pieces of code gate on, and they agree only for as long as they read
 * the same names off it:
 *   - `isSearchSurface` below is the membership test, and the only way to ask the question;
 *   - `resolveSurface` in `bigquery/helpers/installAttribution.helper.ts` blanks `surface_detail`
 *     at WRITE time on a member surface, so the free-text value is never stored in the first place;
 *   - the published-row guards in `store/resolvers/storeRow.resolver.ts` and
 *     `conversion/services/installCohort.service.ts` blank the same field at READ time, so details
 *     written before that write rule existed stop being served without waiting for a re-sync;
 *   - `isPaidPlacement` below refuses to read a member surface's detail as a section handle, which
 *     is what stops a free-text detail reading "homepage ads" from being counted as an ad click;
 *   - `classifyAcquisitionChannel` routes a member surface to APP_STORE_SEARCH instead of the
 *     APP_STORE_BROWSE bucket that every other named surface falls into.
 * One name added here therefore changes what is captured, what is served, and how the install is
 * classified, in a single edit. A name added at one of those call sites and not the others is
 * exactly the drift this list exists to make impossible.
 *
 * ⚠️ The frontend keeps its own copy of these three names, in
 * `frontend/components/growth-intel/store/storePresentation.js`, for its rendering decisions.
 * Nothing enforces that the two agree across the wire, so a change here has to be made there too.
 */
const SEARCH_SURFACES: readonly string[] = Object.freeze([
    SURFACE_SEARCH,
    SURFACE_SEARCH_AD,
    SURFACE_GUIDED_SEARCH
]);

const _clean = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value).trim().toLowerCase();
};

/**
 * True for any PAID App Store surface.
 *
 * Suffix, never equality — see the header. A bare `'_ad'` is rejected: it would be a surface with no
 * name, which is a parse artefact rather than a paid placement.
 *
 * @param surface - A `surface_type` value, in any casing.
 * @returns True when the surface NAME says paid.
 */
const isPaidSurface = (surface: unknown): boolean => {
    const s = _clean(surface);
    return s.length > PAID_SURFACE_SUFFIX.length && s.endsWith(PAID_SURFACE_SUFFIX);
};

/**
 * True only where `surface_detail` is FREE TEXT rather than a taxonomy handle.
 *
 * Do not widen this to "any surface with a detail" — production data is unambiguous about why:
 *   category       199 installs / 6 distinct details    ("orders-and-shipping-…")  → taxonomy
 *   home            59 installs / 2 distinct            ("recently-viewed")        → section handle
 *   app_group        1 install  / 1 distinct            ("checkout-shopify-…")     → handle
 *   app_comparison   3 installs / 3 distinct            (bare UUIDs)               → comparison-set id
 *   partners        14 installs / detail always EMPTY                              → nothing to read
 * Cardinality alone is NOT the test — `app_comparison` has one distinct value per install and is
 * still not free text. A free-text surface has a long tail AND values drawn from no fixed vocabulary.
 *
 * @param surface - A `surface_type` value.
 * @returns True when this surface's detail is free text.
 */
const isSearchSurface = (surface: unknown): boolean => {
    return SEARCH_SURFACES.indexOf(_clean(surface)) !== -1;
};

/**
 * Section handles that ARE ad placements, on a surface whose name does not say so.
 *
 * Shopify labels the SAME placement two different ways depending on which mechanism observed it:
 *   listing URL      surface_type=home         surface_detail=homepage-ads
 *   ad-click event   surface_type=homepage_ad  surface_detail=homepage-ads
 * The pageview happens AFTER the ad click, so last-touch almost always keeps the URL's label — which
 * is why production held 49 `home`/homepage-ads installs against just 3 `homepage_ad`. Judged by
 * surface name alone, 49 real ad clicks read as organic browsing.
 *
 * `recently-viewed`, the only other `home` handle in the data, is genuinely organic — so the handle,
 * not the surface, is what separates them.
 */
const PAID_SECTION_HANDLES: readonly string[] = Object.freeze(['homepage-ads']);

/**
 * Surfaces where `surface_inter_position` counts RESULT PAGES.
 *
 * The field means two different things depending on the surface: on `search`/`category`/`collection`
 * it is the page of results, but on `home`/`story`/`app_details` it is the SECTION of that page,
 * numbered from the top. Rendering every value as "Page N" therefore states a falsehood on half of
 * them — a homepage install found in the 4th section reads as "page 4 of the homepage", which does
 * not exist. `surface_intra_position` is unambiguous: always the position within whatever the above
 * identifies.
 */
const PAGE_INDEXED_SURFACES: readonly string[] = Object.freeze([
    SURFACE_SEARCH,
    SURFACE_SEARCH_AD,
    SURFACE_GUIDED_SEARCH,
    'category',
    'collection'
]);

/**
 * True where `surface_inter_position` is a results PAGE; false where it is a SECTION index.
 *
 * @param surface - A `surface_type` value.
 * @returns True when "Page N" is a truthful rendering of the position.
 */
const isPageIndexedSurface = (surface: unknown): boolean => {
    return PAGE_INDEXED_SURFACES.indexOf(_clean(surface)) !== -1;
};

/**
 * True when this install came from a PAID placement, reading the surface AND its detail.
 *
 * ⚠️ Prefer this over `isPaidSurface` anywhere a real paid/organic split is being reported.
 * `isPaidSurface` answers the narrower question "is this surface NAME a paid one", which is all a
 * caller holding only a surface string can ask — and it under-reports by exactly the homepage case.
 *
 * @param surface - The `surface_type`.
 * @param detail - The `surface_detail` that came with it.
 * @returns True when the placement was paid.
 */
const isPaidPlacement = (surface: unknown, detail: unknown): boolean => {
    if (isPaidSurface(surface)) {
        return true;
    }
    // A section handle classifies a BROWSE surface only. On a search surface `surface_detail` is
    // free text rather than a handle, so a detail reading as the literal words "homepage ads" would
    // otherwise be recorded as an ad click — an organic install silently counted as paid, in the one
    // report whose entire purpose is telling those two apart.
    if (isSearchSurface(surface)) {
        return false;
    }
    return PAID_SECTION_HANDLES.indexOf(_clean(detail)) !== -1;
};

export = {
    SURFACE_VIA,
    PAID_SURFACE_SUFFIX,
    SURFACE_SEARCH,
    SURFACE_SEARCH_AD,
    SURFACE_GUIDED_SEARCH,
    SEARCH_SURFACES,
    PAID_SECTION_HANDLES,
    PAGE_INDEXED_SURFACES,
    isPageIndexedSurface,
    isPaidSurface,
    isPaidPlacement,
    isSearchSurface
};
