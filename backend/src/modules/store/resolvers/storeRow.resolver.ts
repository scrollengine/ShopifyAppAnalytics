'use strict';

/**
 * ============================================================================
 *  ONE STORE ROW — four left joins, and not one of them may remove a store
 * ============================================================================
 *
 *  DOES NO I/O AND READS NO CLOCK: every input is passed in, so a row can be built from literals in a
 *  test with no database running. It lives in `resolvers/` rather than inside the service because
 *  this is where the honesty rules for a rendered row actually are, and those need to be reachable
 *  without one.
 *
 *  ── ⚠️ IT IS NOT DEPENDENCY-FREE, AND THE OTHER FOUR IN THIS MODULE ARE ────────────────────
 *
 *  Requiring this file pulls in 134 source files — the model registry, five repositories and the
 *  config among them — because `require('../../conversion')` is a BARREL, and a barrel loads its
 *  whole module including the services behind it. Its four siblings (`installState.resolver`,
 *  `storeField.resolver`, `storeFacet.helper`, `storeSort.helper`) load two or three files each and
 *  reach none of those. Measured, not assumed; if that ever matters, measure it again rather than
 *  trusting this line.
 *
 *  It is still the right import. The runtime values below — the channel classifier and the lifecycle
 *  vocabulary — belong to `modules/conversion`, and reaching them by deep path is the one thing the
 *  barrel convention exists to forbid: a second module holding a private path into this one is how a
 *  file that was safe to move stops being safe to move. The cost is import weight in a process that
 *  loads every module anyway, and the benefit is that the five lifecycle states have exactly one
 *  definition. What the weight does NOT cost is testability — nothing loaded here connects to
 *  anything at import, which is the property the claim above is actually about.
 *
 *  ── THE FOUR KINDS OF NOTHING, KEPT APART ──────────────────────────────────────────────────
 *
 *  A store record has four, and conflating any two of them is a lie:
 *
 *    NEVER_SYNCED   no partner sync has completed. Decided by the WATERMARK, at page level, by the
 *                   service — never here, and never by a row count.
 *    NOT_EXPOSED    the Partner API structurally cannot supply it. `Shop` has four fields: `id`,
 *                   `name`, `myshopifyDomain`, `avatarUrl`. `country`, `country_name` and
 *                   `shopify_plan_name` are in this class TODAY AND FOREVER on the partner tier,
 *                   which is why they are `''` here rather than omitted: an absent key reads as a
 *                   field somebody forgot, an empty one is a field with nothing behind it.
 *    NOT_PUSHED     reachable through an Admin API session the operator holds and we do not; they
 *                   have not sent it. Indistinguishable from NOT_EXPOSED until the ingest wave
 *                   lands, which is why `operator: null` is published now — the slot says which
 *                   fields will one day be able to be pushed.
 *    genuinely empty  asked, and there is none. `plan_name: ''` on a store that never subscribed is
 *                   this, and it needs no explanation because the answer is "there isn't one".
 *
 *  ──  FIVE RULES THAT ARE EACH A DEFECT SOMEBODY SHIPPED ─────────────────────────────────
 *
 *  1. `has_attribution: false` IS NOT `DIRECT`. Direct is already ~90% of installs, so a store we
 *     cannot explain rendering as Direct disappears into the biggest bucket and inflates it with a
 *     fabricated fact. `classifyAcquisitionChannel(null)` answers `UNKNOWN`, labelled "Not
 *     attributed", which is a statement about our evidence rather than about the merchant.
 *  2. `store_active` IS EXPLICITLY PRESENT, and `null` — never `false` — when the install state is
 *     UNKNOWN. `StoreTable._renderStatus` tests `=== false` and draws an "Uninstalled" badge, so an
 *     absent field or a defaulted `false` accuses a store we know nothing about.
 *  3. `plan_price`, NOT `price`. The table reads `plan_price` (`StoreTable._renderPlan`); the system
 *     this was ported from emitted `price`, so that sub-line never rendered at all. And `null`,
 *     never `0` — a `0` price is a real, renderable claim that this plan is free.
 *  4. `trial_end` HAS NO ASSUMED DEFAULT. The source added seven days to the trial start whenever
 *     Shopify supplied no `billingOn`. It is a RENDERED COLUMN: an assumed date sits in the table
 *     beside real ones, in the same format, with nothing marking it, and a reader plans around it.
 *     Absent evidence ⇒ `null` ⇒ an em dash, and `trial_days_source` says which.
 *  5. `install_country` IS NOT `country`. One is GA4's `geo.country` for the install event — the
 *     VISITOR's inferred geolocation on a server-side Measurement Protocol hit — and the other is
 *     where the merchant registered their business. They disagree routinely and legitimately, and
 *     publishing the first under the second's name republishes a traffic figure as a merchant fact.
 *  6. `billing_stale` IS ON THE ROW, not only on the detail record. The drawer opens OVER the row
 *     and both are on screen at once; the expression lived in `storeDetailRecord.resolver` alone, so
 *     `StoreTable._renderStatus`'s "Billing stale" badge was unreachable and the panel above a
 *     silent row announced it. One expression, computed here, projected there.
 * ============================================================================
 */

import conversion = require('../../conversion');
import surfaceConstants = require('../../shared/constants/surface.constants');
import storeConstants = require('../constants/storeRoster.constants');
import storeFieldResolver = require('./storeField.resolver');

import type { StoreRosterRow } from '../types/storeRoster.types';
import type { StoreRowInput } from '../types/storeRow.types';

const {
    classifyAcquisitionChannel,
    acquisitionChannelLabel,
    STORE_LIFECYCLE_STATES,
    STORE_LIFECYCLE_LABELS,
    JOIN_MISS_STATE_BASIS,
    TRIAL_DAYS_SOURCES
} = conversion;
const { isSearchSurface } = surfaceConstants;
const { STORE_INSTALL_STATES, STORE_INSTALL_STATE_LABELS } = storeConstants;
const { resolveStoreName } = storeFieldResolver;

/** A string from anything, treating null/undefined as `''`. Never `'null'` or `'undefined'`. */
const _text = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value);
};

/** A `Date` only when it genuinely is one and genuinely valid. */
const _date = (value: unknown): Date | null => {
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
};

/** A finite number, or `null`. ⚠️ `null` for an empty string, so a missing amount never becomes `0`. */
const _finite = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

/**
 * The one currency a store's payouts are denominated in, or `''`.
 *
 *  `''` FOR A MIXED SET, DELIBERATELY. There is no FX table in this build, so a store billed in
 * two currencies has a `total_spend` that is a sum of unlike units. Naming one of them would caption
 * a wrong number with a confident symbol — the same class of defect as the frontend's hard-coded `$`
 * in front of a EUR plan price. The number is still published, because it is the only lifetime
 * figure there is; the missing symbol is what says not to read it as money in one currency.
 *
 * @param [currencies] - Every distinct currency seen on this store's payouts.
 * @returns The single currency, or `''` when there is none or more than one.
 */
const _singleCurrency = (currencies?: string[]): string => {
    if (!Array.isArray(currencies)) {
        return '';
    }
    const named = currencies.map((c) => _text(c).trim()).filter((c) => c !== '');
    return named.length === 1 ? named[0] : '';
};

/**
 * Builds one store row from the roster fold and its three left joins.
 *
 * @param input - The store, and whatever each join had to say about it.
 * @returns The row exactly as the table reads it.
 */
const resolveStoreRow = (input: StoreRowInput): StoreRosterRow => {
    const shopDomain = _text(input.shop_domain);
    const install = input.install;
    const subscription = input.subscription;
    const attribution = input.attribution || null;
    const spend = input.spend;

    // A missing attribution row is a missing MEASUREMENT, not a direct arrival — rule 1 in the
    // header. The classifier answers `UNKNOWN` for `null`, so there is no second spelling of it here.
    const channel = classifyAcquisitionChannel(attribution);

    // `lifecycle_state` is null only if a subscription state ever loses its mapping. It is NEVER
    // silently defaulted to INSTALLED — the service counts and warns about the fallback, because
    // filing a paying customer under "never subscribed" is a specific false claim about a merchant.
    const lifecycle = subscription ? subscription.lifecycle_state : null;
    const hasClassifiedSubscription = !!(subscription && lifecycle);

    const name = resolveStoreName({
        shop_domain: shopDomain,
        // ⚠️ Always absent today: `gi_store_enrichments` is a later wave. Passed explicitly rather
        // than omitted so the ingest fills an argument instead of changing this call.
        operator_name: '',
        operator_observed_at: null,
        partner_name: install ? install.partner_shop_name : '',
        // The instant Shopify last told us the store was called this — the NAMING event's own
        // timestamp, which is what makes the freshness rule in the field resolver real rather than
        // nominal. ⚠️ NOT `install_state_at`: that is the deciding event, a closing event routinely
        // carries no name, and the two therefore diverge on exactly the stores that have churned.
        partner_observed_at: install ? install.partner_name_at : null,
        listing_name: attribution ? attribution.shop_name : ''
    });

    const installedAt = install ? install.installed_at : null;
    const attributionAt = attribution ? _date(attribution.installed_at) : null;

    return {
        shop_domain: shopDomain,
        shop_id: install ? install.shop_id : '',

        customer_name: name.customer_name,
        customer_name_source: name.customer_name_source,
        shop_name: install ? install.partner_shop_name : '',

        //  NOT_EXPOSED, not missing. See the header — the Partner API has no merchant country on
        // any version, and `StoreTable` renders this field in a two-character slot as an ISO-2 code,
        // so the GA4 common name below cannot be published here without claiming to be a code.
        country: '',
        country_name: '',
        //  The value that DOES exist, under the name that says what it is. Bounded by attribution
        // coverage, which the response publishes.
        install_country: attribution ? _text(attribution.country) : '',

        install_state: install ? install.install_state : STORE_INSTALL_STATES.UNKNOWN,
        install_state_label: install ? install.install_state_label : STORE_INSTALL_STATE_LABELS.UNKNOWN,
        install_state_at: install ? install.install_state_at : null,
        install_state_event: install ? install.install_state_event : '',
        installed_at: installedAt,
        latest_install_at: install ? install.latest_install_at : null,
        //  `null` means "no uninstall event on record", NEVER "this store has not uninstalled".
        uninstalled_at: install ? install.uninstalled_at : null,
        deactivated_at: install ? install.deactivated_at : null,
        install_count: install ? install.install_count : 0,
        has_install_record: install ? install.has_install_record : false,
        //  Rule 2: `null`, not `false`, when we have no relationship event at all.
        store_active: install ? install.install_state === STORE_INSTALL_STATES.INSTALLED : null,

        state: lifecycle || STORE_LIFECYCLE_STATES.INSTALLED,
        state_label: STORE_LIFECYCLE_LABELS[lifecycle || STORE_LIFECYCLE_STATES.INSTALLED],
        state_basis: hasClassifiedSubscription && subscription ? subscription.state_basis : JOIN_MISS_STATE_BASIS,
        /**
         *  Rule 6: COMPUTED HERE, ONCE, and projected by `storeDetailRecord.resolver` rather than
         * re-derived there. The drawer opens OVER the table row and the two are on screen together,
         * so the row and the panel above it must not disagree about whether a plan is being billed.
         * The detail record carried this expression and the roster row did not, which meant
         * `StoreTable._renderStatus` could never draw the badge it already had markup for — the row
         * said nothing while the panel over it said "Billing stale".
         *
         * ⚠️ It takes MEASURED payout evidence: a store whose payouts have never been fetched reads
         * `false`, because "we have never fetched a payout" and "the payments stopped" are different
         * facts and only one of them is about the merchant. `false` therefore means "not measured as
         * stale", never "billing confirmed".
         */
        billing_stale: lifecycle === STORE_LIFECYCLE_STATES.CONVERTED
            && !!input.has_subscription_payout
            && input.monthly_spend === 0,

        plan_name: hasClassifiedSubscription && subscription ? subscription.plan_name : '',
        //  Rule 3: `plan_price`, and `null` rather than `0`.
        plan_price: hasClassifiedSubscription && subscription ? subscription.plan_price : null,
        //  Published even though nothing renders it yet: `storePresentation.fmtMoney` hard-codes a
        // `$`, so a EUR plan currently reads as "$29.00" — a right number under a wrong currency.
        // Emitting this costs nothing and is what lets the table be corrected with no second backend
        // change.
        plan_currency: hasClassifiedSubscription && subscription ? _text(subscription.currency) : '',
        plan_interval: input.plan_interval === undefined ? null : input.plan_interval,

        //  Rule 4: no assumed trial length, ever.
        trial_end: hasClassifiedSubscription && subscription ? subscription.trial_end : null,
        trial_days_source: hasClassifiedSubscription && subscription ? subscription.trial_days_source : TRIAL_DAYS_SOURCES.NONE,
        conversion_date: hasClassifiedSubscription && subscription ? subscription.conversion_date : null,
        churn_date: hasClassifiedSubscription && subscription ? subscription.churn_date : null,

        // `undefined` becomes `null`: "we did not evaluate this" and "we evaluated it and the store
        // is not paying" must not collapse into one value, and only the caller knows which it was.
        monthly_spend: input.monthly_spend === undefined ? null : input.monthly_spend,
        total_spend: spend ? _finite(spend.total_gross) : null,
        spend_currency: spend ? _singleCurrency(spend.currencies) : '',
        transaction_count: spend ? spend.transaction_count : 0,
        first_payment_at: spend ? _date(spend.first_payment_at) : null,
        last_payment_at: spend ? _date(spend.last_payment_at) : null,

        has_attribution: !!attribution,
        channel,
        channel_label: acquisitionChannelLabel(channel),
        source: attribution ? _text(attribution.source) : '',
        medium: attribution ? _text(attribution.medium) : '',
        campaign: attribution ? _text(attribution.campaign) : '',
        //  `''`, not `'none'`, when there is no record at all. `'none'` is a value the WRITER
        // stores to mean "a record exists and no acquisition scope produced it"; keeping the two
        // apart is what lets a reader tell an absent row from an uninformative one.
        attribution_source: attribution ? _text(attribution.attribution_source) : '',
        surface_type: attribution ? _text(attribution.surface_type) : '',
        /**
         * PUBLISHED ON BROWSE SURFACES, BLANK ON SEARCH ONES. This one field means two different
         * things depending on `surface_type`: on `search` / `search_ad` / `guided_search` it is the
         * merchant's own typed query, which this build does not serve; on `home`, `category`,
         * `collection`, `app_group` and the rest it is Shopify's placement handle — a section
         * handle, a category path — which is what the "Came from" column is actually made of.
         *
         * ⚠️ THE GUARD IS HERE, ON READ, AND NOT ONLY WHERE THE ROW IS WRITTEN. Blanking at capture
         * only affects rows synced from now on; an operator upgrading this build still has every
         * historical query sitting in Mongo, and would keep serving them until a LIFETIME re-sync.
         * This closes that window for stored rows the moment the build lands.
         *
         * ⚠️ It must NOT be pushed up into `classifyAcquisitionChannel` above, which reads the
         * REPOSITORY row rather than this one. That call recognises `home` + `homepage-ads` as an ad
         * placement, and blanking its input would re-read ~49 real ad-click installs as organic
         * browsing — silently, and in the one column this whole field exists to keep honest.
         */
        surface_detail: attribution && !isSearchSurface(attribution.surface_type) ? _text(attribution.surface_detail) : '',
        surface_inter_position: attribution && attribution.surface_inter_position != null ? attribution.surface_inter_position : null,
        surface_intra_position: attribution && attribution.surface_intra_position != null ? attribution.surface_intra_position : null,
        attribution_installed_at: attributionAt,
        // SIGNED, not absolute: positive means the analytics record is later than Shopify's install
        // instant. The sign is half the diagnostic — a consistent lag in one direction is export
        // latency, an inconsistent one is a mismatched row. `null` when either side is missing,
        // because a lag measured against nothing is not a small lag.
        attribution_lag_seconds: attributionAt && installedAt
            ? Math.round((attributionAt.getTime() - installedAt.getTime()) / 1000)
            : null,

        //  NOT_EXPOSED on the partner tier and NOT_PUSHED until the ingest wave: `''` and `null`
        // are the values these hold for a store nobody has pushed, so landing the ingest fills a
        // slot rather than adding a key.
        shopify_plan_name: '',
        operator: null
    };
};

export = {
    resolveStoreRow
};
