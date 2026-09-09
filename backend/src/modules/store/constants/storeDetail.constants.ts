'use strict';

/**
 * ============================================================================
 *  ONE STORE'S RECORD — the timeline vocabulary, and the two kinds of nothing
 *  that a per-field map has to keep apart
 * ============================================================================
 *
 *  Everything the store DETAIL read agrees with the drawer about. Dependency-light by design: it
 *  imports the Partner event/transaction vocabulary and nothing else, so a pure resolver can read it
 *  without dragging a layer sideways.
 *
 *  ── THREE THINGS HERE ARE A FRONTEND CONTRACT, NOT A PREFERENCE ────────────────────────────
 *
 *    1. `TIMELINE_SOURCES` — the values are keys into `StoreDetailContent.js:70` `SOURCE_LABEL`.
 *       A source not in that map renders its raw snake_case string beside the entry: no error, just
 *       an ugly value on screen. Only three of the four keys it declares can be produced here, and
 *       the fourth is named below so nobody wonders where it went.
 *
 *    2. `TIMELINE_TONES` — `StoreDetailContent.js:62` maps exactly `positive` / `negative` /
 *       `neutral` onto the dot colour, falling back to `neutral`. A fourth tone is a grey dot.
 *
 *    3. `MAX_TIMELINE_ENTRIES` — the drawer's own header records that a single store can carry
 *       ~1,100 entries. The cap is applied NEWEST-FIRST and REPORTED, because a silently truncated
 *       audit surface is worse than a long one.
 *
 *  ──  `application_charge` IS DECLARED BY THE FRONTEND AND CANNOT BE PRODUCED HERE ────────
 *
 *  `SOURCE_LABEL` carries a fourth key, `application_charge` ("Billing record"), which the system
 *  this was ported from filled from its own `ApplicationCharge` table. THIS BUILD HAS NO SUCH TABLE
 *  and must not grow one: a local charge record would be a second, unowned source of truth for a
 *  number the Partner charge stream already answers. Every charge fact here therefore rides on a
 *  `partner_event` entry, which is where it actually came from. Emitting `application_charge` for a
 *  Partner event would relabel the provenance of a fact to match a component's expectations, which
 *  is the one thing a provenance field must never do.
 * ============================================================================
 */

// `export =` modules — a named import here is TS2497, so each is imported whole and destructured.
import partnerVocab = require('../../../constants/partnerVocab.constants');

const { PARTNER_EVENT_TYPES, PARTNER_TRANSACTION_TYPES } = partnerVocab;

// ── The timeline ────────────────────────────────────────────────────────────

/**
 * WHERE a timeline entry came from, published per entry.
 *
 * Shown beside every entry so a gap in ONE source is visible as a gap in that source rather than
 * reading as "nothing happened". A store whose Partner events are synced and whose payouts are not
 * has a timeline; without the per-entry source it would look like a store that never paid.
 */
const TIMELINE_SOURCES = Object.freeze({
    /** `gi_partner_app_events` — installs, uninstalls and every charge signal. */
    PARTNER_EVENT: 'partner_event',
    /** `gi_partner_app_transactions` — settled payouts, which are cash and not run-rate. */
    TRANSACTION: 'transaction',
    /** `gi_listing_install_attributions` — the listing-analytics record of how the store arrived. */
    LISTING_ATTRIBUTION: 'ga4_attribution'
} as const);

/** The three dot colours the drawer can render. Anything else is drawn grey. */
const TIMELINE_TONES = Object.freeze({
    POSITIVE: 'positive',
    NEGATIVE: 'negative',
    NEUTRAL: 'neutral'
} as const);

/**
 * What each Partner event is called on the timeline.
 *
 * ⚠️ `DEACTIVATED` says "Store deactivated by Shopify" and NOT "uninstalled". The merchant did not
 * remove the app — their shop was frozen or closed — and the roster's own three-state collapse
 * (which files it under `UNINSTALLED`) is only safe because the label and the event type both
 * survive on the row. Losing that distinction here would put the collapse's cost somewhere it was
 * never argued for.
 */
const TIMELINE_EVENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
    [PARTNER_EVENT_TYPES.INSTALL]: 'App installed',
    [PARTNER_EVENT_TYPES.REINSTALL]: 'App reinstalled',
    [PARTNER_EVENT_TYPES.UNINSTALL]: 'App uninstalled',
    [PARTNER_EVENT_TYPES.DEACTIVATED]: 'Store deactivated by Shopify',
    [PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED]: 'Subscription approved',
    [PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACTIVATED]: 'Subscription started billing',
    [PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_CANCELLED]: 'Subscription cancelled',
    [PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_DECLINED]: 'Subscription declined',
    [PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_EXPIRED]: 'Subscription expired',
    [PARTNER_EVENT_TYPES.ONE_TIME_CHARGE_ACCEPTED]: 'One-time charge approved',
    [PARTNER_EVENT_TYPES.USAGE_CHARGE_APPLIED]: 'Usage charge applied',
    /**
     *  A `__typename` this build does not model, STORED rather than dropped — see
     * `partnerVocab.constants`. It appears on the timeline as an explicitly unrecognised event
     * rather than being filtered out: an event we cannot classify is a known unknown, and hiding it
     * from the one surface that exists to show everything turns it into an unknown unknown.
     */
    [PARTNER_EVENT_TYPES.OTHER]: 'Unrecognised Partner event'
});

/** The dot colour per event type. Anything unlisted is neutral — an event is not bad by default. */
const TIMELINE_EVENT_TONES: Readonly<Record<string, string>> = Object.freeze({
    [PARTNER_EVENT_TYPES.INSTALL]: TIMELINE_TONES.POSITIVE,
    [PARTNER_EVENT_TYPES.REINSTALL]: TIMELINE_TONES.POSITIVE,
    [PARTNER_EVENT_TYPES.UNINSTALL]: TIMELINE_TONES.NEGATIVE,
    [PARTNER_EVENT_TYPES.DEACTIVATED]: TIMELINE_TONES.NEGATIVE,
    [PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED]: TIMELINE_TONES.POSITIVE,
    [PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACTIVATED]: TIMELINE_TONES.POSITIVE,
    [PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_CANCELLED]: TIMELINE_TONES.NEGATIVE,
    [PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_DECLINED]: TIMELINE_TONES.NEGATIVE,
    [PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_EXPIRED]: TIMELINE_TONES.NEGATIVE
});

/** What each payout type is called on the timeline. An unlisted type renders its own raw value. */
const TRANSACTION_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
    [PARTNER_TRANSACTION_TYPES.APP_SUBSCRIPTION]: 'Subscription payment',
    [PARTNER_TRANSACTION_TYPES.APP_USAGE]: 'Usage payment',
    [PARTNER_TRANSACTION_TYPES.APP_ONE_TIME]: 'One-time payment',
    [PARTNER_TRANSACTION_TYPES.APP_CREDIT]: 'Refund or credit',
    [PARTNER_TRANSACTION_TYPES.APP_ADJUSTMENT]: 'Shopify adjustment',
    [PARTNER_TRANSACTION_TYPES.LEGACY]: 'Legacy payment',
    [PARTNER_TRANSACTION_TYPES.OTHER]: 'Unrecognised payout'
});

/**
 * The newest N entries this endpoint will serve, and the cap is REPORTED when it bites.
 *
 * ⚠️ NOT a performance guess. `StoreDetailDrawer.js:16-22` records the measured worst case for one
 * store — roughly 1,100 entries — and the drawer renders every one of them into the DOM. The cap
 * bounds one response; the diagnostics and a warning say how many were withheld, so a truncated
 * audit surface can never be mistaken for a complete one.
 */
const MAX_TIMELINE_ENTRIES = 500;

// ── The two kinds of nothing a FIELD can carry ──────────────────────────────

/**
 * Why a field on this record is empty, published per field in `unavailable`.
 *
 *  THESE TWO ARE INDISTINGUISHABLE ON SCREEN AND MUST NOT BE MERGED. `NOT_EXPOSED` is permanent —
 * the Partner API's `Shop` object has exactly four fields (`id`, `name`, `myshopifyDomain`,
 * `avatarUrl`) and no version of it returns a merchant's country or their Shopify plan tier.
 * `NOT_PUSHED` is temporary: the operator's own app CAN read it through an Admin API session and
 * has not sent it. Publishing one reason for both would tell a self-hoster to go and fetch a value
 * that provably cannot be fetched — or, worse, tell them a fetchable value is impossible.
 *
 * A field that was ASKED FOR and came back empty is in NEITHER class: it publishes its real value
 * and appears nowhere in `unavailable`, because the answer is "there isn't one".
 */
const FIELD_UNAVAILABLE_REASONS = Object.freeze({
    /** The Partner API structurally cannot supply it, on any version. Permanent. */
    NOT_EXPOSED: 'NOT_EXPOSED',
    /** Reachable through an Admin API session the operator holds and we do not. Not yet sent. */
    NOT_PUSHED: 'NOT_PUSHED'
} as const);

/**
 * The NOT_EXPOSED sentence, stated ONCE per record rather than repeated per field.
 *
 * ⚠️ Twelve identical prompts beside twelve em dashes trains an operator to stop reading the panel.
 * The per-field entries in `unavailable` carry a short reason each; this is the paragraph the card
 * shows at the top, and it is worded for someone who has just noticed a blank and is deciding
 * whether it is a bug.
 */
const NOT_EXPOSED_MESSAGE = 'The Shopify Partner API exposes only a shop\'s id, name, myshopify domain and '
    + 'avatar. This value can only come from an Admin API session, which this tool does not hold — push it '
    + 'from your own app.';

/**
 * The NOT_PUSHED sentence. Names the endpoint that will accept the push once the ingest wave lands.
 *
 * ⚠️ It says the endpoint does not exist yet. A call to action naming a 404 is worse than no call to
 * action: the operator spends their afternoon proving the tool wrong rather than reading it.
 */
const NOT_PUSHED_MESSAGE = 'No operator profile has been pushed for this store. The push endpoint is not '
    + 'built yet, so this field is empty on every store on this deployment — it is not specific to this one.';

export = {
    TIMELINE_SOURCES,
    TIMELINE_TONES,
    TIMELINE_EVENT_LABELS,
    TIMELINE_EVENT_TONES,
    TRANSACTION_TYPE_LABELS,
    MAX_TIMELINE_ENTRIES,
    FIELD_UNAVAILABLE_REASONS,
    NOT_EXPOSED_MESSAGE,
    NOT_PUSHED_MESSAGE
};
