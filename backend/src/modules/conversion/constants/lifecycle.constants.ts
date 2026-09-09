'use strict';

/**
 * ============================================================================
 *  STORE LIFECYCLE VOCABULARY — the five states, the four subscription states,
 *  the eight acquisition channels, and the read limits that bound them
 * ============================================================================
 *
 *  Everything the install-cohort read agrees on with the page that draws it. Dependency-light by
 *  design: it imports the Partner event vocabulary and nothing else, so it can be read by a
 *  repository (which needs the event-type lists for its `$in`), by a resolver and by a helper
 *  without dragging a layer sideways.
 *
 *  TWO ORDERS IN THIS FILE ARE A FRONTEND CONTRACT, NOT A PREFERENCE.
 *
 *    1. `STORE_LIFECYCLE_STATES` / `_LABELS` — EXACTLY five members, in this order.
 *       `frontend/components/growth-intel/InstallCohortTable.js:19` hard-codes
 *       `STATE_ORDER = ['INSTALLED','ON_TRIAL','CONVERTED','CHURNED_IN_TRIAL','CHURNED']` and
 *       iterates THAT, not our keys. A sixth state therefore appears in `summary.by_state` but in
 *       neither the summary strip (`:117`) nor the filter Select (`:48`), renders with an untoned
 *       badge, and breaks `sum(boxes) === summary.installs` on screen with no explanation.
 *
 *    2. `ACQUISITION_CHANNEL_LABELS` — EXACTLY eight, in this order, because the channel Select is
 *       built by iterating `Object.keys(channelLabels)` (`InstallCohortTable.js:57`). Key order here
 *       IS the on-screen order there.
 *
 *  The labels mirror `frontend/components/growth-intel/store/storePresentation.js`
 *  (`STORE_STATE_LABELS` :46, `ACQUISITION_CHANNEL_LABELS` :131) word for word. The same store is
 *  rendered from `data.states` in the strip and from the frontend's own map in the table cell; two
 *  spellings of one state on one screen reads as two different things.
 * ============================================================================
 */

// `export =` module — a named import here is TS2497, so it is imported whole and destructured.
import partnerVocab = require('../../../constants/partnerVocab.constants');

const { PARTNER_EVENT_TYPES } = partnerVocab;

// ── The five lifecycle states ───────────────────────────────────────────────

/**
 * The lifecycle of a store that installed inside the window, as the cohort table renders it.
 *
 * `CHURNED_IN_TRIAL` MUST NEVER FOLD INTO `CHURNED`. One merchant never paid us a cent and the
 * other did; collapsing them turns a trial-quality problem into a retention problem, or the reverse.
 *
 * `INSTALLED` IS THE LEFT-JOIN MISS AND NOTHING ELSE — "this store has no subscription we can
 * find", not "this store is currently installed". It is deliberately unreachable from every
 * subscription state (see `SUBSCRIPTION_STATE_TO_LIFECYCLE`), because a subscription state that fell
 * through to it would report a paying customer as never having subscribed.
 */
const STORE_LIFECYCLE_STATES = Object.freeze({
    /** No subscription resolved for this store at all. A state, not a gap. */
    INSTALLED: 'INSTALLED',
    /** Subscribed, and the trial has not ended as of the judgement instant. */
    ON_TRIAL: 'ON_TRIAL',
    /** Reached paid billing. */
    CONVERTED: 'CONVERTED',
    /** Left before the trial ended — never paid us. */
    CHURNED_IN_TRIAL: 'CHURNED_IN_TRIAL',
    /** Paid, then left. */
    CHURNED: 'CHURNED'
} as const);

/**
 * What each state is called on screen. Published as the response's `states` map, which the page uses
 * for BOTH the summary strip and the filter Select — a state missing a label here disappears from
 * both (`InstallCohortTable.js:49`, `:117`).
 */
const STORE_LIFECYCLE_LABELS = Object.freeze({
    INSTALLED: 'Installed only',
    ON_TRIAL: 'On trial',
    CONVERTED: 'Converted',
    CHURNED_IN_TRIAL: 'Left during trial',
    CHURNED: 'Churned'
} as const);

/**
 * The five states in journey order, derived from the vocabulary so the two cannot drift.
 *
 * Use this to tally `summary.by_state` — every key present, zeros included. A key omitted because
 * its count is zero removes that box from the strip, which reads as "we did not measure it".
 */
const STORE_LIFECYCLE_STATE_ORDER = Object.freeze(Object.values(STORE_LIFECYCLE_STATES));

// ── The subscription states beneath them ────────────────────────────────────

/**
 * What one SUBSCRIPTION resolved to as of the judgement instant.
 *
 * A separate, finer vocabulary from the lifecycle above: it is per-charge, and a store with two
 * subscriptions has two of these and one lifecycle state. There is no `INSTALLED` member — a store
 * with no subscription produces no value here at all, which is precisely why the left-join miss
 * cannot be confused with a classification.
 */
const SUBSCRIPTION_STATES = Object.freeze({
    /** Approved, trial still running as of the judgement instant. */
    ON_TRIAL: 'ON_TRIAL',
    /** Billing has begun and no end event has landed. */
    PAYING: 'PAYING',
    /** Ended on or before the conversion date — never billed. */
    CHURNED_DURING_TRIAL: 'CHURNED_DURING_TRIAL',
    /** Ended after billing began. */
    CHURNED_AFTER_TRIAL: 'CHURNED_AFTER_TRIAL'
} as const);

/**
 * Subscription state → lifecycle state. EVERY subscription state must have an entry.
 *
 * A MISSING MAPPING REPORTS A PAYING CUSTOMER AS NEVER HAVING SUBSCRIBED. If a lookup can return
 * `undefined` and a caller defaults that to `INSTALLED`, the store lands in the "Installed only" box
 * — a specific, checkable, false claim about a specific merchant. `types/lifecycle.types.ts` carries
 * a compile-time proof that this map is total over `SUBSCRIPTION_STATES` and that `INSTALLED` is not
 * among its values; both assertions fail the build rather than the dashboard.
 */
const SUBSCRIPTION_STATE_TO_LIFECYCLE = Object.freeze({
    ON_TRIAL: STORE_LIFECYCLE_STATES.ON_TRIAL,
    PAYING: STORE_LIFECYCLE_STATES.CONVERTED,
    CHURNED_DURING_TRIAL: STORE_LIFECYCLE_STATES.CHURNED_IN_TRIAL,
    CHURNED_AFTER_TRIAL: STORE_LIFECYCLE_STATES.CHURNED
} as const);

// ── How confident the state is ──────────────────────────────────────────────

/**
 * WHICH EVIDENCE produced a subscription's state. Published per row so a reader can tell a measured
 * answer from a guessed one, and so the service can warn on the guessed ones.
 *
 * Only `INFERRED` is an assumption, and it is the conservative one: it never claims revenue.
 */
const STATE_BASIS = Object.freeze({
    /**
     * Shopify's own `charge.billingOn`, in practice off the ACTIVATED event — the first-billing
     * date Shopify supplied.
     *
     * NOT "the trial-end date Shopify supplied", and this basis is NOT the high-fidelity input an
     * earlier draft of this comment claimed. Measured against a real 38,719-event install:
     * SUBSCRIPTION_CHARGE_ACCEPTED occurs 13 times and carries `billingOn` ZERO times;
     * SUBSCRIPTION_CHARGE_ACTIVATED occurs 1,632 times and carries it 1,632 times. So ACTIVATED is
     * the source, not the exception. And the gap from that event to `billingOn` is BIMODAL — one
     * cluster at 6-7 days, another at 29-30, plus 23 rows where it lands BEFORE activation — while
     * the stored charge has exactly five keys (`id`, `name`, `test`, `billingOn`, `amount`) and no
     * `trialDays`. Nothing we hold distinguishes a 30-day trial from a no-trial subscription whose
     * first bill is a cycle out.
     *
     * It is still the strongest basis available, and it is still preferred over inferring a length
     * from an event gap — but it is evidence of a FIRST BILLING DATE, not proof of a trial.
     * See `backend/docs/FIDELITY.md` §5, "`billingOn` is what we publish as trial length".
     */
    BILLING_ON: 'billing_on',
    /**
     * No `billingOn`, but settled `APP_SUBSCRIPTION` payouts exist (or provably do not). Measured
     * evidence, not an assumption: money either moved or it did not.
     */
    SETTLED_PAYOUT: 'settled_payout',
    /**
     * No `billingOn` and no settled payout, and no end event either. The subscription is booked
     * `ON_TRIAL` because that is the only reading that claims nothing. ⚠️ Rows on this basis MUST be
     * counted and pushed into `warnings[]`.
     */
    INFERRED: 'inferred'
} as const);

/**
 * The `state_basis` of a store that has NO SUBSCRIPTION AT ALL — the left-join miss.
 *
 * DELIBERATELY NOT A MEMBER OF `STATE_BASIS`, and it must never become one. Those three name which
 * EVIDENCE produced a SUBSCRIPTION's state, and a store with no subscription has no such evidence to
 * name. Reusing `inferred` for it would be actively misleading in both directions: it would swamp
 * the one basis that means "we guessed" with tens of thousands of rows that were measured, and it
 * would make the `inferred` warning fire on every deployment, which is how a warning stops being
 * read. Widening the vocabulary itself would break the cohort resolver's own counters, because
 * `ChargeCohortDiagnostics.state_basis` is a three-key tally indexed with a `StateBasis` and the
 * resolver can never produce this value.
 *
 * It lives HERE, beside the vocabulary it is deliberately outside of, because it is ONE WIRE VALUE
 * ON TWO ENDPOINTS: `GET /api/funnel/install-cohort` and the store roster both publish it on a row
 * that has no subscription, and a second copy of the literal in the second module is how one string
 * acquires two spellings and the same row reads two different ways on two pages.
 */
const JOIN_MISS_STATE_BASIS = 'join_miss' as const;

/**
 * Where a rendered `trial_end` came from.
 *
 * THERE IS DELIBERATELY NO `ASSUMED_DEFAULT` MEMBER, and no `DEFAULT_TRIAL_DAYS = 7`. The source
 * this was ported from added seven days to the trial start whenever Shopify supplied no `billingOn`.
 * `trial_end` is a RENDERED COLUMN: an assumed date sits in the table beside real ones, in the same
 * type, with no marker, and a reader plans around it. Absent evidence ⇒ `NONE` ⇒ `trial_end: null`
 * ⇒ an em dash. Adding a member here to "fill the column" reintroduces the exact defect.
 */
const TRIAL_DAYS_SOURCES = Object.freeze({
    /** `raw_event.charge.billingOn`. The only source of a trial end in this build. */
    PARTNER_BILLING_ON: 'partner_billing_on',
    /** Shopify supplied no `billingOn`. The trial end is UNKNOWN and renders as one. */
    NONE: 'none'
} as const);

/**
 * How well a subscription is linked to its charge payload — the three counts behind the sentence at
 * `frontend/components/growth-intel/PartnerFunnelChart.js:133-152`.
 *
 * ⚠️ Redefined against the source's meaning, deliberately. This build has no `ApplicationCharge`
 * table to resolve a charge id AGAINST, so "resolved" cannot mean "the id matched a row". It means
 * the charge payload we already hold carried a usable `billingOn` — which is the fact the trial
 * ladder actually consumes.
 */
const CHARGE_LINK_STATES = Object.freeze({
    /** A charge payload carrying a usable `billingOn`. */
    RESOLVED: 'resolved',
    /** A `charge_id` was present but the payload carried no `billingOn`. Dangling, not missing. */
    UNRESOLVED: 'unresolved',
    /** No `charge_id` at all. The subscription is bucketed by shop domain instead. */
    ABSENT: 'absent'
} as const);

// ── Acquisition channels ────────────────────────────────────────────────────

/**
 * The eight coarse channels an install can be filed under. ORDER IS THE ON-SCREEN ORDER — see the
 * file header.
 *
 * `UNKNOWN` IS NOT `DIRECT`. They are the two ends of the same axis: `DIRECT` asserts the
 * merchant arrived with no referrer, `UNKNOWN` asserts nothing at all. Direct is already ~90% of
 * installs, so a row we cannot explain that renders as Direct is invisible — it inflates the biggest
 * bucket with a fabricated fact. Pinned by `installCohort.test.js:105-138` in the source repo.
 */
const ACQUISITION_CHANNELS = Object.freeze({
    APP_STORE_AD: 'APP_STORE_AD',
    APP_STORE_SEARCH: 'APP_STORE_SEARCH',
    APP_STORE_BROWSE: 'APP_STORE_BROWSE',
    REFERRAL: 'REFERRAL',
    ORGANIC_SEARCH: 'ORGANIC_SEARCH',
    PAID: 'PAID',
    DIRECT: 'DIRECT',
    /** No attribution row, or a row that explicitly records "we do not know". Never "direct". */
    UNKNOWN: 'UNKNOWN'
} as const);

/**
 * Published as the response's `channels` map. KEY ORDER IS LOAD-BEARING — the page builds its
 * channel Select by iterating `Object.keys` on this object verbatim.
 *
 * Mirrors `storePresentation.js:131` word for word, including `UNKNOWN: 'Not attributed'`, which is
 * the label doing the honesty work: it says we have no record, not that the store came directly.
 */
const ACQUISITION_CHANNEL_LABELS = Object.freeze({
    APP_STORE_AD: 'Shopify App Store ad',
    APP_STORE_SEARCH: 'App Store search',
    APP_STORE_BROWSE: 'App Store browsing',
    REFERRAL: 'Referral',
    ORGANIC_SEARCH: 'Organic search',
    PAID: 'Paid campaign',
    DIRECT: 'Direct',
    UNKNOWN: 'Not attributed'
} as const);

/** The eight channels in publication order, derived so the vocabulary and the order cannot drift. */
const ACQUISITION_CHANNEL_ORDER = Object.freeze(Object.values(ACQUISITION_CHANNELS));

// ── The attribution sentinels the classifier reads ──────────────────────────

/**
 * Stored `source` values that mean WE DO NOT KNOW, and must resolve to `UNKNOWN`.
 *
 * MIRRORED, NOT IMPORTED, and that is a known cost. The write side owns these strings —
 * `modules/bigquery/constants/bigQuery.constants.ts:114-119` (`ATTRIBUTION_SENTINELS`) — but that
 * module's barrel does not publish them and reaching into another module's constants by deep path is
 * the layering violation this project checks for. Restated here with the source named so a reader
 * can diff the two by eye. THE RIGHT FIX is to promote `ATTRIBUTION_SENTINELS` into
 * `modules/shared/constants/` beside `surface.constants.ts`, which exists for exactly this reason —
 * "every READER needs the same classification" — and then delete this block.
 *
 * `''` is a member because a row written before the sentinels existed, or by any other path, stores
 * an empty string; an empty source is an absence of evidence, and reading it as Direct manufactures
 * one.
 */
const UNRESOLVED_ATTRIBUTION_SOURCES: readonly string[] = Object.freeze(['', '(unattributed)', '(not set)']);

/**
 * The analytics export's literal for a genuinely referrer-less visit. The ONLY value that may
 * produce `DIRECT`.
 */
const DIRECT_ATTRIBUTION_SOURCE = '(direct)';

/**
 * Mediums that name a channel outright.
 *
 * ⚠️ KNOWN-INCOMPLETE, and the direction of the error is stated so it is not mistaken for a
 * measurement: the wider analytics paid vocabulary (`cpm`, `cpv`, `cpa`, `display`, `banner`,
 * `retargeting`, `paidsearch`, …) is NOT in `PAID_MEDIUMS`, so an install carrying one of those on a
 * named source is filed as `REFERRAL`. That UNDER-reports `PAID` and OVER-reports `REFERRAL`; it
 * never invents a Direct or an App Store install. Widening is a one-line change to the array below,
 * and is the whole fix — do not reach for a substring test, which would file a merchant's own
 * referrer `paidmedia.example.com` as a paid campaign.
 */
const ORGANIC_SEARCH_MEDIUMS: readonly string[] = Object.freeze(['organic']);
const REFERRAL_MEDIUMS: readonly string[] = Object.freeze(['referral']);
const PAID_MEDIUMS: readonly string[] = Object.freeze(['cpc', 'ppc', 'paid']);

// ── Event types the charge cohort is folded from ────────────────────────────

/**
 * The events that OPEN a subscription. The earliest of these for a bucket is its `trial_start`.
 *
 * Declared here rather than in the resolver that folds them because the REPOSITORY needs them for
 * its `$in`, and a repository importing a resolver inverts the layer direction
 * (services → resolvers → helpers → constants; repositories are reached FROM services and
 * resolvers, never the reverse).
 */
const SUBSCRIPTION_START_EVENT_TYPES: readonly string[] = Object.freeze([
    PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED,
    PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACTIVATED
]);

/**
 * The events that CLOSE one.
 *
 * ⚠️ `UNINSTALL` and `DEACTIVATED` are relationship events and carry NO charge block, so they can
 * never be keyed to a charge — which is exactly why the cohort resolver keeps a per-shop end list
 * alongside a per-charge one. A subscription whose only end signal is an uninstall would otherwise
 * never churn, and would read as PAYING forever.
 */
const SUBSCRIPTION_END_EVENT_TYPES: readonly string[] = Object.freeze([
    PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_CANCELLED,
    PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_DECLINED,
    PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_EXPIRED,
    PARTNER_EVENT_TYPES.UNINSTALL,
    PARTNER_EVENT_TYPES.DEACTIVATED
]);

/**
 * The events that put a store on the INSTALL SPINE — the population this endpoint reports on.
 *
 * `REINSTALL` IS NOT OPTIONAL. It is Shopify's `RelationshipReactivated`, and a spine built from
 * `INSTALL` alone silently drops every store that left and came back — stores which are, by
 * definition, the ones a retention view most wants to see. The spine's `install_count` is what makes
 * that visible on the row: a store with two of these contributes 2.
 *
 * Declared beside the charge lists and for the same reason: the REPOSITORY needs it for its `$in`,
 * and a repository importing a resolver or a service would invert the layer direction.
 */
const INSTALL_SPINE_EVENT_TYPES: readonly string[] = Object.freeze([
    PARTNER_EVENT_TYPES.INSTALL,
    PARTNER_EVENT_TYPES.REINSTALL
]);

/** The `$in` list for the cohort's one event pull: every type either list names, deduped by hand. */
const CHARGE_COHORT_EVENT_TYPES: readonly string[] = Object.freeze([
    ...SUBSCRIPTION_START_EVENT_TYPES,
    ...SUBSCRIPTION_END_EVENT_TYPES
]);

// ── Request shape: sort, paging, chunking ───────────────────────────────────

/**
 * The sort allowlist. Anything else is a NO-OP PLUS A WARNING, never "match nothing".
 *
 * Same rule as the filters: an unrecognised value must WIDEN the result set, not empty it. A table
 * that renders zero rows because of a typo in a query string is indistinguishable from a business
 * with no installs.
 */
const INSTALL_COHORT_SORT_KEYS: readonly string[] = Object.freeze([
    'installed_at',
    'shop_domain',
    'state',
    'channel',
    'source'
]);

/**
 * Applied when the caller names no sort, or names one outside the allowlist.
 *
 * ⚠️ `as const` is load-bearing, not decoration. Without it the literal widens to `string` inside the
 * `export =` object below, and a consumer assigning it to an `InstallCohortSortKey` stops compiling —
 * for a value that is spelled correctly right here.
 */
const DEFAULT_INSTALL_COHORT_SORT_KEY = 'installed_at' as const;
/** Newest install first — the reading order the page's copy assumes. `as const` for the same reason. */
const DEFAULT_INSTALL_COHORT_SORT_DIR = 'desc' as const;

/** Page size when the caller asks for none. */
const DEFAULT_LIMIT = 50;

/**
 * MUST STAY >= 500. `frontend/pages/funnel/index.js:125` hard-codes `limit: 500`
 * and the table never paginates — its "Show all N" button counts `items.length`, not
 * `pagination.total`. Lowering this silently truncates the table with no control anywhere on screen
 * that would let a reader discover it; the ONLY channel for that fact is `warnings[]`.
 */
const MAX_LIMIT = 500;

/**
 * Keys per `$in` when fanning the install spine out across the joins.
 *
 * Named for the domains it was written for, and reused verbatim for the charge-id fan-out that
 * recovers end events carrying no shop domain: the number bounds the SIZE of a query document, and
 * that concern does not change with what the list holds.
 *
 * ⚠️ The accumulator MUST be hoisted OUTSIDE the chunk loop. Rebuilding it per chunk re-scopes the
 * per-domain winner to a chunk and discards rows silently. Keep the loop sequential too:
 * `Promise.all` over chunks trades a memory spike for a connection-pool one.
 */
const DOMAIN_CHUNK_SIZE = 500;

// ── Tier states the response publishes ──────────────────────────────────────

/**
 * Why a row may carry `has_attribution: false` — three causes that render identically at row level
 * (which is correct) and must be separable at page level (which is what this is for).
 *
 * NONE of them is a refusal. The install rows exist and are correct whatever this says; a
 * `status: false` here maps to `setCohort(null)` on the page and prints "No installs recorded for
 * this window. Run a Partner sync" — advice that is wrong twice over.
 */
const ATTRIBUTION_STATES = Object.freeze({
    /** The attribution sync has run; a row missing here genuinely has no listing-analytics record. */
    READY: 'READY',
    /** BigQuery is not configured at all. Nothing has ever been able to write attribution. */
    NOT_CONNECTED: 'NOT_CONNECTED',
    /** Configured, but `last_install_attrib_synced_at` is null — the job has never completed. */
    NEVER_SYNCED: 'NEVER_SYNCED'
} as const);

/**
 * The state of the PARTNER tier, which is the install spine itself.
 *
 * The discriminator is the WATERMARK (`gi_partner_apps.last_synced_at`), never the row count. No
 * rows plus a watermark is a real, publishable "nobody installed"; no rows and no watermark is "we
 * have not looked yet", and the two must not render alike.
 */
const COHORT_DATA_STATES = Object.freeze({
    READY: 'READY',
    NEVER_SYNCED: 'NEVER_SYNCED'
} as const);

export = {
    STORE_LIFECYCLE_STATES,
    STORE_LIFECYCLE_LABELS,
    STORE_LIFECYCLE_STATE_ORDER,
    SUBSCRIPTION_STATES,
    SUBSCRIPTION_STATE_TO_LIFECYCLE,
    STATE_BASIS,
    JOIN_MISS_STATE_BASIS,
    TRIAL_DAYS_SOURCES,
    CHARGE_LINK_STATES,
    ACQUISITION_CHANNELS,
    ACQUISITION_CHANNEL_LABELS,
    ACQUISITION_CHANNEL_ORDER,
    UNRESOLVED_ATTRIBUTION_SOURCES,
    DIRECT_ATTRIBUTION_SOURCE,
    ORGANIC_SEARCH_MEDIUMS,
    REFERRAL_MEDIUMS,
    PAID_MEDIUMS,
    SUBSCRIPTION_START_EVENT_TYPES,
    SUBSCRIPTION_END_EVENT_TYPES,
    CHARGE_COHORT_EVENT_TYPES,
    INSTALL_SPINE_EVENT_TYPES,
    INSTALL_COHORT_SORT_KEYS,
    DEFAULT_INSTALL_COHORT_SORT_KEY,
    DEFAULT_INSTALL_COHORT_SORT_DIR,
    DEFAULT_LIMIT,
    MAX_LIMIT,
    DOMAIN_CHUNK_SIZE,
    ATTRIBUTION_STATES,
    COHORT_DATA_STATES
};
