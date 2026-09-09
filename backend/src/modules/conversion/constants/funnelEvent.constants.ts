'use strict';

/**
 * ============================================================================
 *  THE FUNNEL EVENT CATALOG — 28 steps, four sources, and the measurement seam
 * ============================================================================
 *
 *  The vocabulary `GET /api/conversion/custom-funnel` publishes as `catalog`, which IS the step
 *  picker: `PartnerFunnelChart.js:105-111` derives its source groups from whatever sources appear
 *  here, `:246` lists a group's checkboxes by filtering on `source`, and `:186` resolves the
 *  selection by looking each selected key up in this list.
 *
 *  Dependency-light by design: it imports the Partner vocabulary and nothing else, so a repository
 *  (which needs the event-type lists for its `$in`), a pure helper and a service can all read it
 *  without dragging a layer sideways.
 *
 *  ── `steps[].key` MUST BE A SUBSET OF `catalog[].key` ─────────────────────
 *
 *  `orderedSelection` (`PartnerFunnelChart.js:185-188`) filters the selection against the catalog,
 *  but `moveEvent` (`:173-183`) indexes into `selectedKeys`. A step returned that is NOT in the
 *  catalog therefore occupies a slot in the funnel and VANISHES from the reorder list — so the ↑/↓
 *  buttons move the wrong step, silently, for every step after it. That is why the service resolves
 *  a request against `FUNNEL_EVENT_BY_KEY` and warns about what it dropped, rather than passing an
 *  unrecognised key through.
 *
 *  ── `unit` IS THE MEASUREMENT SEAM, NOT DECORATION ──────────────────────────
 *
 *  `ga4` steps are GA4 hits counted per VISITOR. Everything else counts SHOPS or SUBSCRIPTIONS. A
 *  ratio across that boundary divides two different populations, and the chart marks it with a `*`
 *  and an explanatory Banner (`:417-428`, `:463`) rather than presenting it as a conversion rate.
 *
 *  ⚠️ The chart recognises the literal `'events'` and NOTHING ELSE (`:419`, `:423`); any other value
 *  narrates as "shops". So `unit` has exactly two members and a third would silently mis-narrate.
 *
 *  ── `population` EXISTS BECAUSE `unit` CANNOT SAY THIS ───────────────────
 *
 *  A subscription step is labelled `unit: 'shops'` for chart compatibility but COUNTS
 *  SUBSCRIPTIONS: the charge cohort is keyed `chg:<charge_id>`, so a store with two subscriptions
 *  contributes 2. The default funnel crosses that population change at `installed → trial_started`
 *  with a plain grey chip and no marker at all. `unit` cannot carry the fact without changing how
 *  the chart narrates the seam, so `population` carries it and the service warns on a boundary that
 *  changes population without changing unit.
 *
 *  ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 *
 *  `upgraded` / `downgraded`, AND THE REASON GIVEN HERE USED TO BE FALSE. This comment claimed
 *  they "need a store's active-plan history — `StoreDetail.active_plan` and an `ApplicationCharge`
 *  table", i.e. that plan movement cannot be derived from the Partner API at all. It can, and this
 *  build already does it: `modules/revenue/helpers/movementSince.helper.ts`'s `movementSinceState`
 *  resolves UPGRADED / DOWNGRADED / RESUBSCRIBED / STOPPED_PAYING / PLAN_CHANGED / SAME_PLAN by
 *  comparing a store's settled monthly amount at two instants, and `/api/revenue/overview` publishes
 *  it per store on the MRR-movement drill-down. The false claim mattered: a reader who believed it
 *  would go and build a second, worse copy of a fold that is already shipped and tested.
 *
 *  That helper is also SHARPER than the spec this catalog was ported from — ⚠️ THE AMOUNT IS
 *  COMPARED BEFORE THE PLAN NAME, so a marketing rename at an unchanged price is `PLAN_CHANGED` and
 *  never revenue movement, and a price rise under an unchanged name IS an upgrade. Order those the
 *  other way round and every rename in the app's history reports as churn-and-expansion.
 *
 *  ⚠️ THE REAL REASON THEY ARE NOT STEPS HERE is narrower and is about COUNTING, not deriving. A
 *  funnel step is a windowed count of movement EVENTS, and that needs the two charges of a single
 *  plan change PAIRED — which this data does not hand over: Shopify emits the change as a cancel of
 *  the old charge and an accept of the new one IN THE SAME SECOND (see
 *  `resolvers/chargeCohort.resolver.ts`, whose `supersession` diagnostics measure exactly this), and
 *  a cancel-then-resubscribe by a merchant is byte-identical to it. `movementSinceState` sidesteps
 *  the pairing entirely by comparing two BALANCES rather than matching two events — which is why it
 *  works and why a step cannot simply borrow it.
 *
 *  And once a pair is in hand the comparison still has to refuse three cases rather than report a
 *  number: the movement is UNKNOWN — `null`, never `0` and never a direction — when either side's
 *  price is null, when the two sides are in different currencies (nothing in this build converts
 *  currencies and `FIDELITY.md` §5 forbids adding an FX table), or when the two billing intervals
 *  differ or are unknown. That last one is not a corner case: `normalizeToMonthly` divides by 12 only
 *  on an explicit `'ANNUAL'`, so an unguarded monthly→annual switch reports a **12× upgrade** on a
 *  merchant who moved to the same plan on a different cadence.
 *
 *  A picker entry a user can select that can NEVER produce a number is worse than a shorter picker:
 *  it renders as a zero-height bar labelled "Upgrades", which is a claim that nobody upgraded.
 *
 *  ⚠️ `on_trial`. It is the same number as `trial_pending` under a second label — two bars, one
 *  measurement, and a funnel that appears to hold flat across a step that is arithmetically
 *  guaranteed to.
 *
 *  ⚠️ `sessions` and `first_visits` exist on `gi_listing_funnel_dailies` (`:48-49`) and are
 *  deliberately not exposed. Adding one changes what the picker offers; add a `FIDELITY.md` row with
 *  it.
 * ============================================================================
 */

// `export =` module — a named import here is TS2497, so it is imported whole and destructured.
import partnerVocab = require('../../../constants/partnerVocab.constants');

const { PARTNER_EVENT_TYPES, PARTNER_TRANSACTION_TYPES } = partnerVocab;

// ── The four sources, and what each one can be measured from ────────────────

/**
 * Where a step's number comes from. THE KEYS ARE A FRONTEND CONTRACT: `SOURCE_META`
 * (`PartnerFunnelChart.js:58-63`) maps exactly these four strings to a group heading and its
 * "counted per …" note, and `SOURCE_ORDER` (`:66`) orders the groups by them. A source spelled
 * differently still renders — under its raw name, with no note — which reads as a bug in the data
 * rather than in the vocabulary.
 */
const FUNNEL_EVENT_SOURCES = Object.freeze({
    /** Daily listing rollups from the GA4 export. Counts VISITORS; needs the LISTING tier. */
    GA4: 'ga4',
    /** Partner API relationship and charge events. Counts SHOPS; needs the PARTNER tier. */
    PARTNER: 'partner',
    /** The folded charge cohort. Counts SUBSCRIPTIONS; needs the PARTNER tier. */
    SUBSCRIPTION: 'subscription',
    /** Settled payouts. Counts SHOPS that were actually billed; needs the PARTNER tier. */
    TRANSACTION: 'transaction'
} as const);

/**
 * The measurement unit, and the whole reason the chart has a seam banner.
 *
 * ⚠️ EXACTLY TWO MEMBERS. `PartnerFunnelChart.js:419` and `:423` test `=== 'events'` and narrate
 * everything else as "shops", so a third unit would be described to the operator as something it
 * is not.
 */
const FUNNEL_EVENT_UNITS = Object.freeze({
    /** GA4 hits. One visitor can contribute several; no shop identity survives the rollup. */
    EVENTS: 'events',
    /** Distinct entities. See `population` for WHICH entity — they are not all shops. */
    SHOPS: 'shops'
} as const);

/**
 * WHAT is actually being counted, at a resolution `unit` cannot express.
 *
 * Not merely finer detail. `installed` and `trial_started` share `unit: 'shops'`, so the chart
 * draws their boundary as an ordinary step conversion — but one counts stores and the other counts
 * subscriptions, and a store with two subscriptions is 1 on the left and 2 on the right. The
 * service warns on any boundary where this changes and `unit` does not.
 */
const FUNNEL_EVENT_POPULATIONS = Object.freeze({
    /** Anonymous GA4 visitors. No shop identity exists in the rollup at all. */
    VISITORS: 'visitors',
    /** Distinct `shop_domain`. */
    SHOPS: 'shops',
    /** Distinct subscriptions — a charge bucket, not a store. */
    SUBSCRIPTIONS: 'subscriptions'
} as const);

/**
 * How a step's `conversion_pct` was computed — published per step so the chart can narrate it.
 *
 * `PartnerFunnelChart.js:406` tests `=== 'decided'` EXACTLY, and that branch rewrites the
 * tooltip to say the denominator excludes subscriptions still inside their trial. Misspell it and
 * the chart presents a decided-basis rate as a plain step ratio that happens not to add up.
 */
const FUNNEL_RATE_BASES = Object.freeze({
    /** `count / previous.count`. The ordinary funnel reading. */
    PREVIOUS_STEP: 'previous_step',
    /** `converted / decided` — subscriptions still inside their trial are excluded from BOTH sides. */
    DECIDED: 'decided',
    /** A tier behind this step or its predecessor is not READY, so there is no rate to publish. */
    UNAVAILABLE: 'unavailable'
} as const);

/**
 * The subscription metrics a `source: 'subscription'` step reads off the folded charge cohort.
 *
 * Named rather than spelled inline on each entry so the catalog and the cohort summary cannot
 * disagree about which number a step means — `types/customFunnel.types.ts` proves at COMPILE TIME
 * that every member here is a key of the summary the resolver produces.
 */
const SUBSCRIPTION_FUNNEL_METRICS = Object.freeze({
    /** Subscriptions whose trial STARTED inside the window. The cohort itself. */
    TRIAL_STARTED: 'trial_started',
    /** Of that cohort, still inside their trial as of the judgement instant — the UNDECIDED. */
    STILL_ON_TRIAL: 'still_on_trial',
    /** Of that cohort, reached paid billing at any point: currently paying PLUS churned after paying. */
    TRIAL_CONVERTED: 'trial_converted',
    /** Left on or before the day billing would have begun. Never paid us. */
    CHURNED_DURING_TRIAL: 'churned_during_trial',
    /** Paid, then left. */
    CHURNED_AFTER_TRIAL: 'churned_after_trial',
    /** Reached paid billing and no end event has landed. */
    CURRENTLY_PAYING: 'currently_paying'
} as const);

// ── The tiers a step can depend on ──────────────────────────────────────────

/**
 * The two data tiers this endpoint reads across. THIS IS THE FIRST MIXED-TIER READ IN THE BUILD.
 *
 * `/api/funnel` is entirely GA4, so refusing outright when BigQuery is unconfigured is right there.
 * Here it is wrong: it would blank Partner steps that are present and correct, on a deployment that
 * has never intended to connect BigQuery at all.
 */
const FUNNEL_TIERS = Object.freeze({
    /** `gi_listing_funnel_dailies`, written by BIGQUERY_SYNC. Gated on `last_bq_synced_at`. */
    LISTING: 'listing',
    /** `gi_partner_app_events` / `gi_partner_app_transactions`. Gated on `last_synced_at`. */
    PARTNER: 'partner'
} as const);

/**
 * A tier's state. THE DISCRIMINATOR IS THE WATERMARK, NEVER THE ROW COUNT — an empty window is
 * a perfectly ordinary answer once a sync has run, and the two must never render alike.
 */
const FUNNEL_TIER_STATES = Object.freeze({
    READY: 'READY',
    /** Not configured at all. Nothing has ever been able to write a row. */
    NOT_CONNECTED: 'NOT_CONNECTED',
    /** Configured, but its watermark is null — the job has never completed. */
    NEVER_SYNCED: 'NEVER_SYNCED'
} as const);

/** Which tier each source is served by. Total over `FUNNEL_EVENT_SOURCES` — proved in the types. */
const FUNNEL_SOURCE_TIERS = Object.freeze({
    ga4: FUNNEL_TIERS.LISTING,
    partner: FUNNEL_TIERS.PARTNER,
    subscription: FUNNEL_TIERS.PARTNER,
    transaction: FUNNEL_TIERS.PARTNER
} as const);

// ── The catalog's shape ─────────────────────────────────────────────────────

/*
 * The unions, LOCALLY, derived from the frozen objects above.
 *
 * ⚠️ Restated here rather than imported from `types/customFunnel.types.ts`, and that is deliberate:
 * that file derives its unions from `typeof import(this file)`, so importing back from it would
 * make every alias circular and TypeScript would report the whole vocabulary as referencing itself.
 * The types file re-derives `FunnelCatalogEntry` from `FUNNEL_EVENT_CATALOG[number]`, so the two
 * cannot drift — there is one declaration and one derivation, not two declarations.
 */
type _Source = typeof FUNNEL_EVENT_SOURCES[keyof typeof FUNNEL_EVENT_SOURCES];
type _Unit = typeof FUNNEL_EVENT_UNITS[keyof typeof FUNNEL_EVENT_UNITS];
type _Population = typeof FUNNEL_EVENT_POPULATIONS[keyof typeof FUNNEL_EVENT_POPULATIONS];
type _RateBasis = typeof FUNNEL_RATE_BASES[keyof typeof FUNNEL_RATE_BASES];
type _Metric = typeof SUBSCRIPTION_FUNNEL_METRICS[keyof typeof SUBSCRIPTION_FUNNEL_METRICS];

/**
 * One catalog entry.
 *
 * ⚠️ ANNOTATED RATHER THAN LEFT TO `as const` INFERENCE. A bare `as const` array gives a four-way
 * union whose members carry different optional keys, so `entry.field` does not type-check on the
 * union at all — and the only way through it is an `as` cast in a service, which this codebase
 * confines to `models.repository`. Declaring the shape once here is what keeps every consumer
 * cast-free, and it costs nothing: the `source`, `unit`, `population`, `metric` and `rate_over`
 * fields all keep their literal unions.
 */
interface _CatalogEntry {
    readonly key: string;
    readonly label: string;
    readonly source: _Source;
    readonly unit: _Unit;
    readonly population: _Population;
    /** `ga4` only: the field summed on `gi_listing_funnel_dailies`. */
    readonly field?: string;
    /** `partner` only. The step's count is the UNION of these types' shop sets. */
    readonly event_types?: readonly string[];
    /** `subscription` only. */
    readonly metric?: _Metric;
    /** `transaction` only. */
    readonly transaction_type?: string;
    readonly positive_only?: boolean;
    readonly first_ever?: boolean;
    /** `decided` on `trial_converted` alone. */
    readonly rate_over?: _RateBasis;
}

// ── The catalog ─────────────────────────────────────────────────────────────

/**
 * THE 28 STEPS, in picker order within each source group.
 *
 * Counted rather than asserted: 8 ga4 + 11 partner + 6 subscription + 3 transaction. The
 * subscription group is 6 and not the 9 the source system carried — `upgraded` and `downgraded` are
 * unbuildable here and `on_trial` duplicates `trial_pending`; see the file header.
 *
 * ⚠️ `ga4_installs` is the ONE entry whose key differs from its stored field (`installs`). The key
 * cannot be `installs` because the Partner step `installed` already occupies the funnel position a
 * reader would confuse it with, and they are different measurements: one counts GA4 hits on the
 * listing, the other counts stores Shopify told us about. Every other `field` here is verified
 * against `models/listing/listingFunnelDaily.model.ts:40-47`.
 */
const FUNNEL_EVENT_CATALOG: readonly _CatalogEntry[] = Object.freeze([
    // ── Listing analytics (GA4) — 8. Counted per VISITOR. ────────────────────
    {
        key: 'views',
        label: 'App Listing Page View',
        source: FUNNEL_EVENT_SOURCES.GA4,
        unit: FUNNEL_EVENT_UNITS.EVENTS,
        population: FUNNEL_EVENT_POPULATIONS.VISITORS,
        field: 'views'
    },
    {
        key: 'engaged_views',
        label: 'Engaged View',
        source: FUNNEL_EVENT_SOURCES.GA4,
        unit: FUNNEL_EVENT_UNITS.EVENTS,
        population: FUNNEL_EVENT_POPULATIONS.VISITORS,
        field: 'engaged_views'
    },
    {
        key: 'ad_clicks',
        label: 'Ad Click',
        source: FUNNEL_EVENT_SOURCES.GA4,
        unit: FUNNEL_EVENT_UNITS.EVENTS,
        population: FUNNEL_EVENT_POPULATIONS.VISITORS,
        field: 'ad_clicks'
    },
    {
        key: 'install_clicks',
        label: 'Add App Button Clicked',
        source: FUNNEL_EVENT_SOURCES.GA4,
        unit: FUNNEL_EVENT_UNITS.EVENTS,
        population: FUNNEL_EVENT_POPULATIONS.VISITORS,
        field: 'install_clicks'
    },
    {
        key: 'consent_started',
        label: 'Consent Started',
        source: FUNNEL_EVENT_SOURCES.GA4,
        unit: FUNNEL_EVENT_UNITS.EVENTS,
        population: FUNNEL_EVENT_POPULATIONS.VISITORS,
        field: 'consent_started'
    },
    {
        key: 'consent_completed',
        label: 'Consent Completed',
        source: FUNNEL_EVENT_SOURCES.GA4,
        unit: FUNNEL_EVENT_UNITS.EVENTS,
        population: FUNNEL_EVENT_POPULATIONS.VISITORS,
        field: 'consent_completed'
    },
    {
        // ⚠️ KEY ≠ FIELD. The only one in the catalog. See the block comment above.
        key: 'ga4_installs',
        label: 'Installed (GA4)',
        source: FUNNEL_EVENT_SOURCES.GA4,
        unit: FUNNEL_EVENT_UNITS.EVENTS,
        population: FUNNEL_EVENT_POPULATIONS.VISITORS,
        field: 'installs'
    },
    {
        key: 'first_opens',
        label: 'First Open',
        source: FUNNEL_EVENT_SOURCES.GA4,
        unit: FUNNEL_EVENT_UNITS.EVENTS,
        population: FUNNEL_EVENT_POPULATIONS.VISITORS,
        field: 'first_opens'
    },

    // ── Partner API events — 11. Counted per SHOP. ───────────────────────────
    //
    // `event_types` IS AN ARRAY BECAUSE A STEP MAY SPAN TYPES, and the count is the UNION OF
    // SHOP SETS — never the sum of per-type counts. Summing double-counts every shop that fired
    // both types, and the error is invisible: it produces a larger, entirely plausible number.
    {
        /**
         * ⚠️ `INSTALL` ONLY, and it will legitimately differ from `summary.installs` in the
         * install-cohort table on the SAME PAGE — that spine is `INSTALL ∪ REINSTALL`, because a
         * retention view must not lose the stores that left and came back. Here they are two
         * separate, separately selectable steps, so folding `REINSTALL` in would double it with the
         * entry below. The two numbers answer different questions; nothing is wrong when they
         * disagree, and adding `REINSTALL` here to make them match would break the step beneath it.
         */
        key: 'installed',
        label: 'Installed',
        source: FUNNEL_EVENT_SOURCES.PARTNER,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SHOPS,
        event_types: Object.freeze([PARTNER_EVENT_TYPES.INSTALL])
    },
    {
        key: 'reinstalled',
        label: 'Reinstalled',
        source: FUNNEL_EVENT_SOURCES.PARTNER,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SHOPS,
        event_types: Object.freeze([PARTNER_EVENT_TYPES.REINSTALL])
    },
    {
        key: 'charge_accepted',
        label: 'Subscription Charge Accepted',
        source: FUNNEL_EVENT_SOURCES.PARTNER,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SHOPS,
        event_types: Object.freeze([PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED])
    },
    {
        key: 'charge_activated',
        label: 'Subscription Charge Activated',
        source: FUNNEL_EVENT_SOURCES.PARTNER,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SHOPS,
        event_types: Object.freeze([PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACTIVATED])
    },
    {
        key: 'one_time_charge',
        label: 'One-time Charge Accepted',
        source: FUNNEL_EVENT_SOURCES.PARTNER,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SHOPS,
        event_types: Object.freeze([PARTNER_EVENT_TYPES.ONE_TIME_CHARGE_ACCEPTED])
    },
    {
        key: 'usage_charge',
        label: 'Usage Charge Applied',
        source: FUNNEL_EVENT_SOURCES.PARTNER,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SHOPS,
        event_types: Object.freeze([PARTNER_EVENT_TYPES.USAGE_CHARGE_APPLIED])
    },
    {
        key: 'unsubscribed',
        label: 'Unsubscribed',
        source: FUNNEL_EVENT_SOURCES.PARTNER,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SHOPS,
        event_types: Object.freeze([PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_CANCELLED])
    },
    {
        key: 'charge_declined',
        label: 'Charge Declined',
        source: FUNNEL_EVENT_SOURCES.PARTNER,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SHOPS,
        event_types: Object.freeze([PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_DECLINED])
    },
    {
        key: 'charge_expired',
        label: 'Charge Expired',
        source: FUNNEL_EVENT_SOURCES.PARTNER,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SHOPS,
        event_types: Object.freeze([PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_EXPIRED])
    },
    {
        key: 'uninstalled',
        label: 'Uninstalled',
        source: FUNNEL_EVENT_SOURCES.PARTNER,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SHOPS,
        event_types: Object.freeze([PARTNER_EVENT_TYPES.UNINSTALL])
    },
    {
        key: 'deactivated',
        label: 'Store Deactivated',
        source: FUNNEL_EVENT_SOURCES.PARTNER,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SHOPS,
        event_types: Object.freeze([PARTNER_EVENT_TYPES.DEACTIVATED])
    },

    // ── Subscription lifecycle — 6. Counted per SUBSCRIPTION. ────────────────
    //
    // ⚠️ `unit: 'shops'` and `population: 'subscriptions'` together, deliberately: the chart only
    // understands two units, and telling it these are shops is the lesser inaccuracy — a store with
    // two subscriptions really does contribute 2 here, which `population` is what says.
    {
        key: 'trial_started',
        label: 'Trial Started',
        source: FUNNEL_EVENT_SOURCES.SUBSCRIPTION,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SUBSCRIPTIONS,
        metric: SUBSCRIPTION_FUNNEL_METRICS.TRIAL_STARTED
    },
    {
        key: 'trial_pending',
        label: 'Still In Trial',
        source: FUNNEL_EVENT_SOURCES.SUBSCRIPTION,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SUBSCRIPTIONS,
        metric: SUBSCRIPTION_FUNNEL_METRICS.STILL_ON_TRIAL
    },
    {
        /**
         * THE ONLY ENTRY WITH `rate_over: 'decided'`. Its denominator EXCLUDES subscriptions
         * still inside their trial, from both sides of the rate — they have not had the chance to
         * convert, and counting them as failures understates it. `PartnerFunnelChart.js:406` keys
         * its whole tooltip rewrite off the resulting `rate_basis === 'decided'`.
         */
        key: 'trial_converted',
        label: 'Trial Converted',
        source: FUNNEL_EVENT_SOURCES.SUBSCRIPTION,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SUBSCRIPTIONS,
        metric: SUBSCRIPTION_FUNNEL_METRICS.TRIAL_CONVERTED,
        rate_over: FUNNEL_RATE_BASES.DECIDED
    },
    {
        key: 'churned_during_trial',
        label: 'Left During Trial',
        source: FUNNEL_EVENT_SOURCES.SUBSCRIPTION,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SUBSCRIPTIONS,
        metric: SUBSCRIPTION_FUNNEL_METRICS.CHURNED_DURING_TRIAL
    },
    {
        key: 'churned_after_trial',
        label: 'Churned After Paying',
        source: FUNNEL_EVENT_SOURCES.SUBSCRIPTION,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SUBSCRIPTIONS,
        metric: SUBSCRIPTION_FUNNEL_METRICS.CHURNED_AFTER_TRIAL
    },
    {
        key: 'currently_paying',
        label: 'Currently Paying',
        source: FUNNEL_EVENT_SOURCES.SUBSCRIPTION,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SUBSCRIPTIONS,
        metric: SUBSCRIPTION_FUNNEL_METRICS.CURRENTLY_PAYING
    },

    // ── Payouts — 3. Counted per SHOP, and only where money actually moved. ──
    {
        /**
         * `positive_only` is not a tidiness filter. A shop's net for a type is summed FIRST and the
         * shop counted only when that total is above zero, so refunds, credits and zero lines can
         * never read as "this shop paid us".
         */
        key: 'usage_billed',
        label: 'Usage Charge Billed',
        source: FUNNEL_EVENT_SOURCES.TRANSACTION,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SHOPS,
        transaction_type: PARTNER_TRANSACTION_TYPES.APP_USAGE,
        positive_only: true
    },
    {
        key: 'one_time_billed',
        label: 'One-time Charge Billed',
        source: FUNNEL_EVENT_SOURCES.TRANSACTION,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SHOPS,
        transaction_type: PARTNER_TRANSACTION_TYPES.APP_ONE_TIME,
        positive_only: true
    },
    {
        /**
         * "FIRST EVER", not "transacted during the window". The `$min(created_at)` is taken over
         * the app's WHOLE history and only then tested against the window — a store whose first
         * payout predates the window must not be counted as a first-timer inside it.
         */
        key: 'first_transaction',
        label: 'First Payout Received',
        source: FUNNEL_EVENT_SOURCES.TRANSACTION,
        unit: FUNNEL_EVENT_UNITS.SHOPS,
        population: FUNNEL_EVENT_POPULATIONS.SHOPS,
        first_ever: true
    }
]);

/**
 * The catalog indexed by key — one lookup, built once.
 *
 * ⚠️ DERIVED FROM THE CATALOG, never a second hand-written literal: a hand-maintained index is a
 * copy of the vocabulary that can silently lose an entry, and a step missing from the index would be
 * reported as an unknown key for a step that is right there in the picker.
 *
 * NULL PROTOTYPE, AND THAT IS WHAT THE LOOP BELOW IS FOR. Built with `Object.fromEntries` —
 * which is how this shipped — the index inherits `Object.prototype`, so `index['toString']`,
 * `index['constructor']`, `index['valueOf']`, `index['hasOwnProperty']` and `index['__proto__']` are
 * all TRUTHY. Every `if (!index[key])` guard in the build therefore read them as REAL CATALOG
 * ENTRIES, and `?events=installed,toString,valueOf` returned three steps: two of them with `key`,
 * `label`, `source` and `unit` all `undefined`, a fabricated `count: 0`, `available: true`,
 * `unknown_reason: null` and NO warning anywhere — plus a headline `conversion_rate` of `0`, which
 * renders as "0.00%" in 32-pixel type under the words "Conversion rate". That is the exact
 * fabricated-zero claim `helpers/funnelMath.helper.ts` exists to prevent, arriving through the
 * SELECTION path instead of the division. It also echoed `events: ["installed", null, null]`, which
 * the page writes straight into `localStorage['gi.funnel.stepEvents']`, permanently replacing the
 * operator's saved funnel; and it broke `steps[].key ⊆ catalog[].key`, so the picker's ↑/↓ moved
 * the wrong step.
 *
 * A prototype-free object has no inherited key to find, so a miss is `undefined` for EVERY string a
 * caller can send. `Object.hasOwn` at the two lookup sites is the other half of the same fix; both
 * are kept because either one alone is undone by an innocent-looking edit to the other.
 */
const _byKey: Record<string, _CatalogEntry | undefined> = Object.create(null);
for (const entry of FUNNEL_EVENT_CATALOG) {
    _byKey[entry.key] = entry;
}

const FUNNEL_EVENT_BY_KEY: Readonly<Record<string, _CatalogEntry | undefined>> = Object.freeze(_byKey);

/**
 * The noun a `population` is written with in an operator-facing sentence.
 *
 * ⚠️ Typed over the population union rather than as a loose `Record<string, string>`, so adding a
 * population without giving it a noun is a COMPILE ERROR rather than a warning that reads
 * "\"Installed\" counts shops while \"Trial Started\" counts undefined".
 */
const FUNNEL_POPULATION_LABELS: Readonly<Record<_Population, string>> = Object.freeze({
    [FUNNEL_EVENT_POPULATIONS.VISITORS]: 'listing visitors',
    [FUNNEL_EVENT_POPULATIONS.SHOPS]: 'stores',
    [FUNNEL_EVENT_POPULATIONS.SUBSCRIPTIONS]: 'subscriptions'
});

/** Every catalog key, in publication order. Used to spell the "valid values" half of a warning. */
const FUNNEL_EVENT_KEYS: readonly string[] = Object.freeze(FUNNEL_EVENT_CATALOG.map((entry) => entry.key));

// ── Defaults and limits ─────────────────────────────────────────────────────

/**
 * The funnel a caller gets when it names no events: views → clicks → installs → trial → paid.
 *
 * ⚠️ Starts with a GA4 step, so it is only the right default when the LISTING tier is READY. See
 * the partner-only fallback below.
 */
const DEFAULT_FUNNEL_EVENT_KEYS: readonly string[] = Object.freeze([
    'views',
    'install_clicks',
    'installed',
    'trial_started',
    'trial_converted'
]);

/**
 * THE TIER-AWARE DEFAULT. Used when the caller names no events AND the listing tier is not READY.
 *
 * Without it the default funnel opens on `views`, which is `null` on a Partner-only deployment —
 * and a null first step nulls EVERY cumulative rate and the headline `conversion_rate` behind it.
 * Technically honest, practically an empty chart, on an install that is working perfectly.
 *
 * ⚠️ This applies ONLY to the default. A caller that EXPLICITLY asked for a GA4 step gets it as
 * `null` with a reason: silently dropping a step the user chose changes the funnel they built and
 * moves the denominator of `cumulative_conversion_pct` without saying so.
 */
const DEFAULT_FUNNEL_EVENT_KEYS_PARTNER_ONLY: readonly string[] = Object.freeze([
    'installed',
    'trial_started',
    'trial_converted'
]);

/**
 * The step ceiling. Published as `max_events` and read by the picker at `PartnerFunnelChart.js:100`
 * as `(data && data.max_events) || 10` — so a `0` here would silently become 10 on the client while
 * the server enforced 0, and the two would disagree about a cap the user can see.
 */
const MAX_FUNNEL_EVENTS = 10;

/**
 * The floor. `PartnerFunnelChart.js:165` refuses to shrink below two steps and `:283` drops the
 * caption, and `:293` renders the empty state at zero — so a one-step answer is a state the chart
 * has no reading for. The service still RETURNS it (a caller asked for it) and warns.
 */
const MIN_FUNNEL_EVENTS = 2;

export = {
    FUNNEL_EVENT_SOURCES,
    FUNNEL_EVENT_UNITS,
    FUNNEL_EVENT_POPULATIONS,
    FUNNEL_RATE_BASES,
    SUBSCRIPTION_FUNNEL_METRICS,
    FUNNEL_TIERS,
    FUNNEL_TIER_STATES,
    FUNNEL_SOURCE_TIERS,
    FUNNEL_EVENT_CATALOG,
    FUNNEL_EVENT_BY_KEY,
    FUNNEL_EVENT_KEYS,
    FUNNEL_POPULATION_LABELS,
    DEFAULT_FUNNEL_EVENT_KEYS,
    DEFAULT_FUNNEL_EVENT_KEYS_PARTNER_ONLY,
    MAX_FUNNEL_EVENTS,
    MIN_FUNNEL_EVENTS
};
