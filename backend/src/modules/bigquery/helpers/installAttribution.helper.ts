'use strict';

/**
 * ============================================================================
 *  READING ONE INSTALL — where it came from, and how sure we are
 * ============================================================================
 *
 *  PURE. No models, no config, no clock reads, no I/O. Both functions take one raw BigQuery row and
 *  return the values that get stored, so the classification rules can be exercised against a real
 *  captured row without a GCP project or a database.
 *
 *  Both of these decide what a number MEANS, not merely what it is. `resolveAttribution` picks
 *  between two GA4 scopes that answer different questions and records WHICH one won;
 *  `resolveSurface` reads a single touch and refuses to mix fields across visits. Get either wrong
 *  and the dashboard still renders — with a wrong answer, which is the only failure mode that
 *  matters here.
 * ============================================================================
 */

import constants = require('../constants/bigQuery.constants');
import rowHelper = require('./bigQueryRow.helper');
import surfaceConstants = require('../../shared/constants/surface.constants');

import type { BigQueryRow, ResolvedAttribution, ResolvedSurface } from '../types/bigQuery.types';

const { ATTRIBUTION_SCOPES, ATTRIBUTION_SENTINELS } = constants;
const { str, decodeUrlValue, toPosition } = rowHelper;
const { isSearchSurface } = surfaceConstants;

/**
 * Picks the attribution to publish on the row, and records WHICH scope it came from.
 *
 * Event-scoped wins when present, because it describes the visit that produced this install rather
 * than how the visitor was first ever acquired.
 *
 * ⚠️ `(not set)` is written for a missing HALF of a scope, never `(direct)`. In GA4 a genuinely
 * direct visit carries the literal strings `(direct)` / `(none)`; an EMPTY field means the value was
 * not populated at all. Defaulting an empty to `(direct)` invents a fact — and direct is already the
 * largest bucket, so the error would hide inside it.
 *
 * @param row - One row of the install-attribution query.
 * @returns Source, medium, campaign, and the scope that produced them.
 */
const resolveAttribution = (row: BigQueryRow): ResolvedAttribution => {
    const collectedSource = str(row.collected_source).trim();
    const collectedMedium = str(row.collected_medium).trim();
    if (collectedSource !== '' || collectedMedium !== '') {
        return {
            source: collectedSource || ATTRIBUTION_SENTINELS.NOT_SET,
            medium: collectedMedium || ATTRIBUTION_SENTINELS.NOT_SET,
            campaign: str(row.collected_campaign).trim(),
            attribution_source: ATTRIBUTION_SCOPES.EVENT_COLLECTED
        };
    }

    const firstSource = str(row.first_source).trim();
    const firstMedium = str(row.first_medium).trim();
    if (firstSource !== '' || firstMedium !== '') {
        return {
            source: firstSource || ATTRIBUTION_SENTINELS.NOT_SET,
            medium: firstMedium || ATTRIBUTION_SENTINELS.NOT_SET,
            campaign: str(row.first_campaign).trim(),
            // NOT the visit that converted — this is how the visitor was FIRST EVER acquired.
            // A merchant who found us organically months ago and installed from a paid ad reads
            // as organic here. Kept distinct so a consumer cannot average the two scopes.
            attribution_source: ATTRIBUTION_SCOPES.USER_FIRST_ACQUISITION
        };
    }

    // The install is a SERVER-SIDE hit, so it can legitimately arrive with no attribution at all
    // when the session was never stitched to it. That is a KNOWN-UNKNOWN and is stored as one:
    // folding it into '(direct)' would silently inflate the biggest bucket with rows we have no
    // evidence for.
    return {
        source: ATTRIBUTION_SENTINELS.UNATTRIBUTED,
        medium: ATTRIBUTION_SENTINELS.UNATTRIBUTED,
        campaign: '',
        attribution_source: ATTRIBUTION_SCOPES.NONE
    };
};

/**
 * The App Store surface for an install, from whichever mechanism produced the last touch.
 *
 * Every field comes from the SAME touch — the SQL aggregates one struct rather than one column at a
 * time, so the detail can never be paired with a different visit's rank.
 *
 * ⚠️ Only SEARCH surfaces have their detail suppressed. On `home`/`category`/`collection` the detail
 * is Shopify's own taxonomy handle rather than anything a merchant typed, and it is load-bearing:
 * the paid/organic split is read off it — `homepage-ads` there is what marks an install as an ad
 * placement instead of organic browsing. Blanking it would silently re-file real ad clicks.
 *
 * @param row - One row of the install-attribution query.
 * @returns The surface fields, all empty/null when the install carried no touch.
 */
const resolveSurface = (row: BigQueryRow): ResolvedSurface => {
    const last = row.last_surface;
    if (!last) {
        return {
            surface_type: '',
            surface_detail: '',
            surface_inter_position: null,
            surface_intra_position: null,
            locale: '',
            surface_version: '',
            surface_via: ''
        };
    }

    const surface_type = decodeUrlValue(last.surface_type).toLowerCase();
    let surface_detail = decodeUrlValue(last.surface_detail);
    if (isSearchSurface(surface_type)) {
        // On a search surface the detail IS the query the merchant typed, and this build does not
        // capture it — it is dropped here, at the boundary, before anything downstream can store or
        // serve it. The fork stays narrow deliberately: every non-search surface keeps its detail,
        // because there the value is Shopify's own taxonomy and classification depends on it.
        surface_detail = '';
    }

    return {
        surface_type,
        surface_detail,
        surface_inter_position: toPosition(last.inter_position),
        surface_intra_position: toPosition(last.intra_position),
        locale: decodeUrlValue(last.locale),
        surface_version: decodeUrlValue(last.version).toLowerCase(),
        surface_via: str(last.via).trim()
    };
};

export = {
    resolveAttribution,
    resolveSurface
};
