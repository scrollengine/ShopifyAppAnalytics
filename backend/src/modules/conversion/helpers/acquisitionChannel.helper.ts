'use strict';

/**
 * ============================================================================
 *  WHERE DID THIS STORE COME FROM? — one classifier, eight answers
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, no clock, no I/O. It takes one attribution row and
 *  returns one channel, so every rule below can be exercised against a captured row with no
 *  database and no GCP project.
 *
 *  ──  SURFACE WINS OVER REFERRER ──────────────────────────────────────────────────────────────
 *  The App Store surface is FIRST-HAND: Shopify is telling us where inside its own store the
 *  merchant was standing. The referrer is second-hand and often stale — the analytics export's
 *  source/medium can describe how that visitor was FIRST EVER acquired, months before this install.
 *  So the three surface tests run first, and only a row with no surface at all falls through to the
 *  referrer.
 *
 *  ──  TWO TRAPS, BOTH OF WHICH HAVE ALREADY COST REAL DATA ────────────────────────────────────
 *
 *  1. USE `isPaidPlacement(surface, detail)`, NEVER `isPaidSurface(surface)` ALONE.
 *     Shopify labels the SAME placement two ways depending on which mechanism observed it:
 *       listing URL    surface_type=home         surface_detail=homepage-ads
 *       ad-click event surface_type=homepage_ad  surface_detail=homepage-ads
 *     The pageview happens AFTER the ad click, so last-touch almost always keeps the URL's label.
 *     Production held 49 of the first form against 3 of the second — judged by surface NAME alone,
 *     49 real ad clicks read as organic browsing. `surface.constants.ts` owns that judgement; this
 *     file must not grow a second opinion about it.
 *
 *  2. AN UNKNOWN SOURCE RESOLVES TO `UNKNOWN`, NEVER TO `DIRECT`.
 *     `''`, `(unattributed)` and `(not set)` all mean "we have no evidence". Direct is already ~90%
 *     of installs, so a row we cannot explain that renders as Direct is INVISIBLE — it disappears
 *     into the biggest bucket and inflates it with a fabricated fact. Only the export's own literal
 *     `(direct)` may produce `DIRECT`, because only that value is a positive claim.
 * ============================================================================
 */

import surfaceConstants = require('../../shared/constants/surface.constants');
import lifecycleConstants = require('../constants/lifecycle.constants');

import type { AcquisitionChannel, AttributionSignal } from '../types/lifecycle.types';

const { isPaidPlacement, isSearchSurface } = surfaceConstants;
const {
    ACQUISITION_CHANNELS,
    ACQUISITION_CHANNEL_LABELS,
    UNRESOLVED_ATTRIBUTION_SOURCES,
    DIRECT_ATTRIBUTION_SOURCE,
    ORGANIC_SEARCH_MEDIUMS,
    REFERRAL_MEDIUMS,
    PAID_MEDIUMS
} = lifecycleConstants;

/**
 * Trim-and-lowercase, treating null/undefined as absent.
 *
 * The same shape as `surface.constants._clean`, deliberately: a comparison made on one casing rule
 * here and another there is how the surface tests and the source tests end up disagreeing about the
 * same row.
 *
 * @param value - Any stored attribution field.
 * @returns The comparable form, or `''`.
 */
const _clean = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value).trim().toLowerCase();
};

/**
 * The coarse acquisition channel for one install.
 *
 * Order of the rules is the whole design; see the file header for why surface precedes referrer and
 * why an unexplained source may not become `DIRECT`.
 *
 *   !attribution                                   -> UNKNOWN
 *   isPaidPlacement(surface, detail)               -> APP_STORE_AD
 *   isSearchSurface(surface)                       -> APP_STORE_SEARCH
 *   surface !== ''                                 -> APP_STORE_BROWSE
 *   source in {'', '(unattributed)', '(not set)'}  -> UNKNOWN     never DIRECT
 *   source === '(direct)'                          -> DIRECT
 *   medium organic | referral | cpc/ppc/paid       -> their channels
 *   otherwise (a source we have a NAME for)        -> REFERRAL
 *
 * The final fallback is `REFERRAL` and not `UNKNOWN` on purpose: reaching it means the row carried a
 * named source — chatgpt.com, a partner site, a newsletter — which IS a referral even when its
 * medium is blank or spelled in a vocabulary this build does not enumerate. `UNKNOWN` is reserved
 * for rows that name nothing at all.
 *
 * @param [attribution] - One attribution row, or nothing when the join missed.
 * @returns One of the eight channels. Never undefined.
 */
const classifyAcquisitionChannel = (attribution?: AttributionSignal | null): AcquisitionChannel => {
    // A missing row is a missing MEASUREMENT, not a direct arrival. Three different causes reach
    // here — BigQuery unconfigured, the attribution sync never run, and a genuine export gap — and
    // they are separated by `attribution_state` at page level, never guessed at per row.
    if (!attribution) {
        return ACQUISITION_CHANNELS.UNKNOWN;
    }

    const surface = _clean(attribution.surface_type);
    const detail = _clean(attribution.surface_detail);

    // ── Surface: first-hand, so it wins ─────────────────────────────────────
    // `isPaidPlacement`, not `isPaidSurface` — trap 1 in the header.
    if (isPaidPlacement(surface, detail)) {
        return ACQUISITION_CHANNELS.APP_STORE_AD;
    }
    if (isSearchSurface(surface)) {
        return ACQUISITION_CHANNELS.APP_STORE_SEARCH;
    }
    // Any other named surface is somewhere inside the App Store: a category, a collection, a story,
    // the homepage. "Browsing" is the honest summary of all of them, and lumping them together here
    // is safe because the raw `surface_type` rides along on the row for anyone who needs the detail.
    if (surface !== '') {
        return ACQUISITION_CHANNELS.APP_STORE_BROWSE;
    }

    // ── Referrer: second-hand, and only consulted with no surface at all ────
    const source = _clean(attribution.source);
    // Trap 2 in the header. This test comes BEFORE the `(direct)` test so a sentinel can never fall
    // through into it.
    if (UNRESOLVED_ATTRIBUTION_SOURCES.indexOf(source) !== -1) {
        return ACQUISITION_CHANNELS.UNKNOWN;
    }
    if (source === DIRECT_ATTRIBUTION_SOURCE) {
        return ACQUISITION_CHANNELS.DIRECT;
    }

    const medium = _clean(attribution.medium);
    if (ORGANIC_SEARCH_MEDIUMS.indexOf(medium) !== -1) {
        return ACQUISITION_CHANNELS.ORGANIC_SEARCH;
    }
    if (REFERRAL_MEDIUMS.indexOf(medium) !== -1) {
        return ACQUISITION_CHANNELS.REFERRAL;
    }
    if (PAID_MEDIUMS.indexOf(medium) !== -1) {
        return ACQUISITION_CHANNELS.PAID;
    }

    return ACQUISITION_CHANNELS.REFERRAL;
};

/**
 * The on-screen label for a channel.
 *
 * Exists so the response's per-row `channel_label` and its `channels` map are built from one table.
 * The page falls back to its own copy of these labels when a row omits `channel_label`
 * (`StoreTable.js:108-110`), so a divergence here shows up as the same store reading two different
 * ways in the badge and in the filter — which is exactly the drift the shared column registry was
 * introduced to end.
 *
 * @param channel - A channel key, from `classifyAcquisitionChannel` or from a stored row.
 * @returns The label, falling back to the `UNKNOWN` label for an unrecognised key.
 */
const acquisitionChannelLabel = (channel: unknown): string => {
    const key = String(channel || '') as AcquisitionChannel;
    return ACQUISITION_CHANNEL_LABELS[key] || ACQUISITION_CHANNEL_LABELS.UNKNOWN;
};

export = {
    classifyAcquisitionChannel,
    acquisitionChannelLabel
};
