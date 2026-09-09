'use strict';

/**
 * ============================================================================
 *  THE FIXED 7-STAGE FUNNEL — a SELECTION from the catalog, never a second one
 * ============================================================================
 *
 *  `GET /api/conversion/funnel` draws seven fixed stages; `GET /api/conversion/custom-funnel` draws
 *  whatever the operator picked. THEY ARE THE SAME VOCABULARY. This file holds an ordered list of
 *  KEYS out of `constants/funnelEvent.constants`'s catalog and nothing else — no labels, no sources,
 *  no units, no event-type lists.
 *
 *  ──  WHY THERE IS NO SECOND STAGE DEFINITION HERE ─────────────────────────────────────────
 *
 *  A hand-written stage table would carry its own `label`, its own `source` and its own
 *  `event_types`, and it would then be a SECOND definition of "Installed" sitting one tab away from
 *  the first on the same page. The two would agree until the day one of them was corrected. This
 *  build has already paid for that class of mistake twice (`IMPLEMENTATION.md` §3.10 on MRR;
 *  `modules/revenue/index.ts` on the paying set), so the stage funnel is expressed as a SELECTION
 *  and measured by the same service that measures the operator's own — see
 *  `services/stageFunnel.service.ts`, which calls `getCustomFunnel` with exactly these keys rather
 *  than re-measuring anything.
 *
 *  ── THE ORDER IS THE FUNNEL, AND POSITION 4 IS A FRONTEND CONTRACT ──────────────────────────
 *
 *  `frontend/components/growth-intel/conversion/ConversionFunnelChart.js:57` hard-codes
 *  `const isSeamRow = idx === 4; // "Installed" — where GA4 hands off to Partner` and renders the
 *  seam caption — "↑ Visitor-level (GA4) — ↓ Shop-level (Partner)" plus the drift figure — beneath
 *  THAT ROW and no other. So the fifth key below MUST be the first Partner-sourced stage. Reordering
 *  this list moves the caption onto a boundary it does not describe, and the caption is the only
 *  thing on screen that tells a reader the two halves count different populations.
 *
 *  ── WHY `ga4_installs` SITS DIRECTLY ABOVE `installed` ──────────────────────────────────────
 *
 *  They are the SAME EVENT measured by two systems, and the gap between them is the whole content of
 *  `seam_diagnostics.drift_pct`. Placing them adjacent makes the seam row's own step conversion
 *  (`installed / ga4_installs`) BE the drift comparison, so the number in the caption and the bar
 *  above it cannot disagree. `ga4_installs` is also the only catalog key whose key differs from its
 *  stored field (`installs`) — see the catalog — precisely so it cannot be confused with the Partner
 *  step it is being compared against.
 *
 *  ⚠️ `consent_started` is deliberately absent: seven stages is the chart's fixed height, and the
 *  consent PAIR would cost the seam row its position. An operator who wants it adds it in
 *  `custom-funnel`, which is what that endpoint is for.
 * ============================================================================
 */

import funnelEventConstants = require('./funnelEvent.constants');

const { FUNNEL_EVENT_SOURCES } = funnelEventConstants;

/**
 * THE SEVEN STAGES, in order. Every entry is a key of `FUNNEL_EVENT_CATALOG`.
 *
 * ⚠️ `types/stageFunnel.types.ts` proves at COMPILE TIME that each of these names a real catalog
 * entry, so a typo here is a build failure rather than a stage that silently comes back `null` with
 * an "unknown key" warning the operator can do nothing about — this funnel is not operator-chosen,
 * so a dropped key would be OUR mistake reported as THEIR bad input.
 */
const STAGE_FUNNEL_EVENT_KEYS: readonly string[] = Object.freeze([
    /** Listing views. The entry stage, and the denominator of every cumulative rate. */
    'views',
    /** "Add app" clicked on the listing. */
    'install_clicks',
    /** The OAuth scopes were approved. The last thing that happens before Shopify installs the app. */
    'consent_completed',
    /** GA4's own record of the install — the left half of the seam comparison. */
    'ga4_installs',
    /**  POSITION 4. The Partner API's record of the install. The seam row — see the file header. */
    'installed',
    /** A subscription opened. ⚠️ Counts SUBSCRIPTIONS, not stores: a store with two contributes 2. */
    'trial_started',
    /** It reached paid billing. Measured on the DECIDED basis — see the catalog entry. */
    'trial_converted'
]);

/**
 * The index of the seam row. Published on the payload so the contract is inspectable rather than
 * implied, and asserted against `STAGE_FUNNEL_EVENT_KEYS` in the tests.
 *
 * ⚠️ It is `4` because the CHART says `idx === 4`, not the other way round. Changing it here changes
 * nothing on screen; it would only make the payload disagree with the renderer.
 */
const STAGE_FUNNEL_SEAM_INDEX = 4;

/** The two stages `seam_diagnostics` compares. Named, so the drift cannot be taken off other bars. */
const STAGE_FUNNEL_SEAM_KEYS = Object.freeze({
    /** GA4's install count — the DENOMINATOR of the drift. */
    LISTING: 'ga4_installs',
    /** The Partner API's install count — the NUMERATOR. */
    PARTNER: 'installed'
} as const);

/** The stages the two headline rates are taken between. Named for the same reason. */
const STAGE_FUNNEL_HEADLINE_KEYS = Object.freeze({
    /** The entry stage: the denominator of `overall_install_rate`. */
    ENTRY: 'views',
    /** Partner installs: the numerator of `overall_install_rate`, the denominator of the other. */
    INSTALL: 'installed',
    /** Subscriptions that reached paid billing: the numerator of `overall_paid_conversion_rate`. */
    PAID: 'trial_converted'
} as const);

/**
 * The two chart sources — `ConversionFunnelChart.js`'s whole colour and label vocabulary.
 *
 *  EXACTLY TWO MEMBERS, and they are read as literals on screen:
 *   - `:60` `STAGE_COLORS[s.source]` — a third value yields `background: undefined`, i.e. an
 *     invisible bar with a number floating beside it;
 *   - `:71` `s.source === 'ga4' ? 'GA4' : 'Partner API'` — anything that is not `'ga4'` is captioned
 *     "Partner API", so a `subscription` or `transaction` source would be captioned correctly by
 *     accident and coloured wrongly on purpose.
 *
 * The catalog has FOUR sources. `subscription` and `transaction` are Partner-tier readings, so they
 * fold onto `partner` here — the same collapse `FUNNEL_SOURCE_TIERS` already makes for the tier
 * gate. The catalog's own finer `source` and `population` ride along on the stage untouched, so
 * nothing is lost: the collapse is for the renderer, not for the data.
 */
const STAGE_CHART_SOURCES = Object.freeze({
    GA4: 'ga4',
    PARTNER: 'partner'
} as const);

/**
 * Catalog source → chart source. Total over `FUNNEL_EVENT_SOURCES`, proved in the types.
 *
 * ⚠️ A missing entry would resolve to `undefined`, which the chart renders as an uncoloured bar
 * captioned "Partner API" — a GA4 stage silently presented as a Partner one, which is the exact
 * misattribution the seam caption exists to prevent.
 */
const STAGE_CHART_SOURCE_BY_CATALOG_SOURCE = Object.freeze({
    [FUNNEL_EVENT_SOURCES.GA4]: STAGE_CHART_SOURCES.GA4,
    [FUNNEL_EVENT_SOURCES.PARTNER]: STAGE_CHART_SOURCES.PARTNER,
    [FUNNEL_EVENT_SOURCES.SUBSCRIPTION]: STAGE_CHART_SOURCES.PARTNER,
    [FUNNEL_EVENT_SOURCES.TRANSACTION]: STAGE_CHART_SOURCES.PARTNER
} as const);

/**
 * How each headline rate was computed, in the words the payload publishes.
 *
 *  BOTH OF THEM CROSS A POPULATION BOUNDARY, and the chart draws them as two plain Badges —
 * "Install rate: 3.4%" and "Paid conversion: 22.1%" — with no marker of any kind
 * (`ConversionFunnelChart.js:46-47`). The seam caption sits eight rows below them and describes the
 * BARS. So these sentences, and the warnings built from them, are the only channel through which a
 * reader learns that the install rate divides STORES by VISITORS and the paid rate divides
 * SUBSCRIPTIONS by STORES.
 */
const STAGE_FUNNEL_RATE_DEFINITIONS = Object.freeze({
    install_rate: 'Partner API installs ÷ listing page views. The numerator counts distinct STORES and '
        + 'the denominator counts GA4 VISITORS, so this is a directional ratio between two different '
        + 'populations rather than a per-visitor conversion rate.',
    paid_conversion_rate: 'Subscriptions that reached paid billing ÷ Partner API installs. The numerator '
        + 'counts SUBSCRIPTIONS and the denominator counts STORES, so a store with two subscriptions '
        + 'contributes twice on one side and once on the other and the ratio can legitimately exceed 100%.'
} as const);

/**
 * How `seam_diagnostics.drift_pct` is signed and what it is measured against.
 *
 * Signed `(partner - ga4) / ga4`: POSITIVE means the Partner API knows about more installs than GA4
 * recorded, which is the ordinary direction (a tagging gap, or a merchant who installed from a
 * surface the listing analytics never saw). Negative means GA4 saw installs the Partner sync has not
 * caught up with. An absolute value would throw away which of those two it is, and they call for
 * opposite actions.
 */
const STAGE_FUNNEL_DRIFT_BASIS = '(Partner API installs − GA4 installs) ÷ GA4 installs, signed.';

export = {
    STAGE_FUNNEL_EVENT_KEYS,
    STAGE_FUNNEL_SEAM_INDEX,
    STAGE_FUNNEL_SEAM_KEYS,
    STAGE_FUNNEL_HEADLINE_KEYS,
    STAGE_CHART_SOURCES,
    STAGE_CHART_SOURCE_BY_CATALOG_SOURCE,
    STAGE_FUNNEL_RATE_DEFINITIONS,
    STAGE_FUNNEL_DRIFT_BASIS
};
