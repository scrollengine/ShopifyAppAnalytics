'use strict';

/**
 * ============================================================================
 *  WHAT DOES AN EMPTY COLLECTION MEAN? — one function, every collection
 * ============================================================================
 *
 *  PURE. No models, no repository, no config, no clock. Every input — the row
 *  count, the watermark, whether the optional tier is connected — arrives as an
 *  argument, so every branch below can be exercised against literals. That is
 *  the whole reason this is not three `if`s inside the health service: the
 *  interesting cases are the empty ones, and an empty collection is trivially
 *  cheap to construct here and awkward to construct through a database.
 *
 *  ──  THE ORDER OF THE BRANCHES IS THE ARGUMENT ────────────────────────────
 *
 *    1. NOT CONNECTED first. An unconfigured listing tier explains its four
 *       empty collections completely, and every state below would be a wrong
 *       reading of the same zero — NEVER_SYNCED in particular describes a
 *       deliberate choice as a fault.
 *
 *    2. ROWS PRESENT next. A collection holding data has demonstrably been
 *       filled; nothing about the watermark can make that untrue. This is not
 *       "deciding state by row count" — the rule that forbids that is about
 *       inferring an ABSENCE of syncing from an ABSENCE of rows, which is the
 *       branch below.
 *
 *    3. Only then the WATERMARK, which is the only thing that separates "a sync
 *       ran and found nothing" from "no sync has ever run". Those two produce
 *       identical, indistinguishable emptiness in the data, and publishing them
 *       alike is how a dashboard reports a healthy quiet month as an outage —
 *       or, far worse, an outage as a quiet month.
 *
 *  ── The reason is built here, beside the verdict ────────────────────────────
 *  A state is a token a screen colours; the REASON is what an operator acts on.
 *  Building them apart is how the two drift until a card is tinted "fine" over
 *  a sentence saying it is not.
 * ============================================================================
 */

import constants = require('../constants/syncHealth.constants');

import type { CollectionStateInput, CollectionStateVerdict } from '../types/syncHealth.types';

const { HEALTH_COLLECTION_TIERS, HEALTH_COLLECTION_STATES } = constants;

/**
 * Resolves what a collection's row count means, and says so in a sentence.
 *
 * @param input - Everything the verdict depends on, all passed in.
 * @param input.rows - Exact row count. `0` is the interesting case.
 * @param input.tier - One of `HEALTH_COLLECTION_TIERS`.
 * @param input.label - The collection's on-screen name, used in the sentence.
 * @param input.watermark_field - The partner-app field that governs it, or `''` when none does.
 * @param input.watermark_at - ISO instant of that watermark, or null when it has never been set.
 * @param input.listing_tier_connected - Whether BigQuery is configured at all.
 * @returns The state and the sentence that goes with it.
 */
const resolveCollectionState = ({
    rows,
    tier,
    label,
    watermark_field,
    watermark_at,
    listing_tier_connected
}: CollectionStateInput): CollectionStateVerdict => {
    // 1. ── The optional tier, switched off ──────────────────────────────────
    //  FIRST, and unconditionally — even when rows are present, which happens on a deployment
    // that had BigQuery configured and no longer does. Those rows are real and still served; what
    // the operator needs to know is that nothing will refresh them, and that is what this state says.
    if (tier === HEALTH_COLLECTION_TIERS.LISTING && !listing_tier_connected) {
        let reason = `The listing-analytics tier is not configured, so nothing has ever written to ${label}. `
            + 'That is an ordinary state — BigQuery is optional, and everything from installs onward works '
            + 'without it. Set GCP_PROJECT_ID and BQ_DATASET (plus credentials) to enable it.';
        if (rows > 0) {
            reason = `${label} holds ${rows} row(s) from when the listing-analytics tier WAS configured, but it `
                + 'is not configured now — so those rows are being served and nothing is refreshing them. '
                + 'Restore GCP_PROJECT_ID and BQ_DATASET (plus credentials), or read them as history.';
        }
        return { state: HEALTH_COLLECTION_STATES.NOT_CONNECTED, reason: reason };
    }

    // 2. ── Rows are present ─────────────────────────────────────────────────
    if (rows > 0) {
        return {
            state: HEALTH_COLLECTION_STATES.READY,
            reason: `${label} holds ${rows} row(s).`
        };
    }

    // 3. ── Empty, and the meaning depends on what governs it ────────────────
    if (tier === HEALTH_COLLECTION_TIERS.CONFIG) {
        return {
            state: HEALTH_COLLECTION_STATES.NOT_CONFIGURED,
            reason: `${label} is empty. Nothing syncs into it — it is filled at boot or by an operator — so this `
                + 'is a setup step that has not been taken rather than a sync that has not run.'
        };
    }

    if (tier === HEALTH_COLLECTION_TIERS.SYSTEM) {
        //  The one collection whose emptiness IS its own measurement: it is written by this
        // process on enqueue, so there is nothing that could have been recorded and be missing.
        return {
            state: HEALTH_COLLECTION_STATES.EMPTY,
            reason: `${label} is empty. This collection is written by this application itself, so an empty one `
                + 'means nothing has been asked of it yet — not that a read failed.'
        };
    }

    if (!watermark_at) {
        return {
            state: HEALTH_COLLECTION_STATES.NEVER_SYNCED,
            reason: `${label} is empty AND its watermark (${watermark_field}) has never been set, so no sync has `
                + 'ever completed for it. The emptiness says nothing at all about your business — we have not '
                + 'looked yet.'
        };
    }

    return {
        state: HEALTH_COLLECTION_STATES.EMPTY,
        reason: `${label} is empty, but its watermark (${watermark_field}) was last advanced at ${watermark_at} — `
            + 'so a sync HAS completed and genuinely found nothing to write. This is a measured zero, not a gap.'
    };
};

export = {
    resolveCollectionState
};
