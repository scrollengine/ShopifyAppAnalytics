'use strict';

/**
 * ============================================================================
 *  WHEN TWO SOURCES BOTH ANSWER, WHICH ONE IS PUBLISHED?
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, no clock — every input is passed in, so the
 *  precedence rules can be exercised against literals with no database.
 *
 *  ── THE CONTEST SURFACE IS EXACTLY ONE FIELD ───────────────────────────────────────────────
 *
 *  Every other operator-pushed fact names something the Partner API structurally cannot express —
 *  the merchant's country, their Shopify plan tier, when their store was created, when they last
 *  opened the app. `Shop` has four fields: `id`, `name`, `myshopifyDomain`, `avatarUrl`. So the only
 *  value two sources can both legitimately hold is the STORE NAME, and that is what this file
 *  resolves. It exists as a file, rather than as three lines inside the row builder, so that the
 *  detail path and the roster path cannot invent two different answers for the same store.
 *
 *  ── FRESHNESS WITHIN EQUAL AUTHORITY, NOT A STATIC RANKING ─────────────────────────────────
 *
 *  A static "operator beats partner" (or the reverse) would be wrong roughly half the time: both
 *  sources are reading the same Shopify record, the partner sync runs nightly, and an operator push
 *  is ad-hoc. So between those two the LATER OBSERVATION wins, ties go to the partner sync (it is
 *  the source that runs unattended, so it is the one that will still be right next week), and the
 *  winner is PUBLISHED as `customer_name_source` rather than left to be inferred from the value.
 *
 *  The listing name is deliberately NOT in that contest. It is the analytics `shop_name` event
 *  param, not Shopify's `Shop.name` — a different field from a different system, present only for
 *  stores GA4 saw install — so it is a fallback beneath both, not a peer of either.
 *
 *  ──  THE DOMAIN IS THE FLOOR, AND IT IS NEVER BLANK ──────────────────────────────────────
 *
 *  `StoreTable._renderStore` renders `customer_name || shop_name || shop_domain`, so a blank name
 *  degrades on screen already — but only to the domain, which is exactly what this returns. Doing it
 *  here instead means the SEARCH and the SORT see the same string the reader does. A server that
 *  sorts by an empty name while the page displays a domain produces an alphabetical list that is
 *  visibly not alphabetical.
 * ============================================================================
 */

import storeConstants = require('../constants/storeRoster.constants');

import type { ResolvedStoreName, StoreNameCandidates } from '../types/storeField.types';

const { STORE_NAME_SOURCES } = storeConstants;

/** Trimmed string from anything, treating null/undefined as absent. */
const _text = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value).trim();
};

/** Epoch milliseconds from a Date, or `-Infinity` — which loses every comparison, as an absence should. */
const _ms = (value: unknown): number => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.getTime();
    }
    return Number.NEGATIVE_INFINITY;
};

/**
 * The store name to display, and which source produced it.
 *
 * ⚠️ The operator branch is fully implemented and currently unreachable: `gi_store_enrichments` does
 * not exist yet, so `operator_name` is always empty. It is written now, with its freshness rule,
 * because the alternative is that the ingest wave adds a precedence decision to a file that already
 * ships — and precedence decided in a hurry beside an ingest endpoint is how one store ends up
 * reading two ways on two pages.
 *
 * @param candidates - Every name this store has, with when each was observed.
 * @returns The name to render, never blank, and the source that won.
 */
const resolveStoreName = (candidates: StoreNameCandidates): ResolvedStoreName => {
    const domain = _text(candidates && candidates.shop_domain);
    const operatorName = _text(candidates && candidates.operator_name);
    const partnerName = _text(candidates && candidates.partner_name);
    const listingName = _text(candidates && candidates.listing_name);

    // ── The one contest: operator vs partner, decided by freshness ──────────
    if (operatorName !== '' && partnerName !== '') {
        // `>` and not `>=`: a tie goes to the partner sync. Both `observed_at` values are usually
        // absent on an operator push (the pushing app may not say when it looked), and
        // `-Infinity > -Infinity` is false — so an undated push loses to a dated sync and two undated
        // sources resolve to the partner, deterministically.
        if (_ms(candidates.operator_observed_at) > _ms(candidates.partner_observed_at)) {
            return { customer_name: operatorName, customer_name_source: STORE_NAME_SOURCES.OPERATOR };
        }
        return { customer_name: partnerName, customer_name_source: STORE_NAME_SOURCES.PARTNER };
    }
    if (operatorName !== '') {
        return { customer_name: operatorName, customer_name_source: STORE_NAME_SOURCES.OPERATOR };
    }
    if (partnerName !== '') {
        return { customer_name: partnerName, customer_name_source: STORE_NAME_SOURCES.PARTNER };
    }
    if (listingName !== '') {
        return { customer_name: listingName, customer_name_source: STORE_NAME_SOURCES.LISTING };
    }
    //  The floor. `domain` is required by the caller's own contract (a store with no domain is
    // never a row), so this is never blank — and `domain` is a real, checkable identifier, not a
    // placeholder, which is why it is a SOURCE rather than a failure.
    return { customer_name: domain, customer_name_source: STORE_NAME_SOURCES.DOMAIN };
};

export = {
    resolveStoreName
};
