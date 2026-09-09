'use strict';

/**
 * ============================================================================
 *  STORE — module barrel
 * ============================================================================
 *
 *  Four reads over ONE fold. The roster, the subscriptions list and the country
 *  rollup are the same population assembled three ways, which is why they share
 *  a module: a second module could only re-implement the fold — a second
 *  definition of "is this shop paying" — or force this one to publish its
 *  repository and resolvers so a sibling could assemble them.
 *
 *  There is no `gi_stores` collection. Every row is folded on read from
 *  `gi_partner_app_events`, `gi_partner_app_transactions` and
 *  `gi_listing_install_attributions`. The argument, the measured cost and the
 *  escape ladder are in IMPLEMENTATION.md §3.12 and in the repository header —
 *  do not add a fourth copy here.
 *
 *  Structural rules, both asserted by test/exportSurface.test.js:
 *    - files inside this folder import each other by DEEP PATH, never through
 *      this barrel, which would eagerly load the repository and make a pure
 *      helper's test need a database;
 *    - every key is enumerated, never spread, so a dropped export is a visible
 *      diff rather than an `undefined` found at a destructure elsewhere.
 *
 *  Everything else — the repository, the five resolvers, the two pure helpers
 *  and the two constants files — stays private. The response publishes the
 *  vocabularies (`install_states`, `statuses`, facet options) precisely so no
 *  consumer needs a compile-time copy that could disagree with it.
 *
 *  All four reads take the clock ONCE and thread that instant through every read
 *  and fold, so no single response classifies one store as of two moments.
 * ============================================================================
 */

import storeRosterService = require('./services/storeRoster.service');
import storeDetailService = require('./services/storeDetail.service');
import subscriptionListService = require('./services/subscriptionList.service');
import countryRollupService = require('./services/countryRollup.service');

export = {
    /**
     * Every store this app has ever been installed on, with its current install state.
     *
     * Answers 200 with an empty `items` rather than refusing when nothing has synced — a refusal
     * renders as "you have no stores", which is a claim about the operator's business that no data
     * made. `data_state`, `attribution_state` and `warnings[]` separate the empties.
     */
    getStoreRoster: storeRosterService.getStoreRoster,

    /**
     * Everything known about ONE store, from every collection that holds any of it.
     *
     * The one read here that REFUSES where a list would answer: a record has no honest empty
     * rendering, so "no record of this store" is a refusal carrying its reason — chosen by the
     * watermark ("we have not looked" vs "we looked and there is nothing"), never by row count.
     * Every other empty (no subscription, no payouts, no attribution) is a complete 200.
     */
    getStoreDetail: storeDetailService.getStoreDetail,

    /**
     * Every merchant CURRENTLY ON A PAID PLAN, with their plan, status and spend.
     *
     * Read the population before the numbers; the response says so in its `population` block. Stores
     * that never subscribed and stores that stopped paying are ABSENT, not present with a different
     * status — so a count here is not "customers to date" and a trend from it cannot show churn.
     *
     * Membership is `modules/revenue`'s `liveSetAsOf`, reached through that barrel and never
     * re-derived, so no merchant can be paying here and not on the Revenue page by DEFINITION.
     */
    getSubscriptionList: subscriptionListService.getSubscriptionList,

    /**
     * Stores, installs, paying customers and revenue PER COUNTRY.
     *
     * "Country" is where the install TRAFFIC came from, and the payload says so in `country_basis`.
     * The Partner API's `Shop` has four fields and no country on any version, so this build stores
     * no merchant trading country at all; the only per-store country is GA4's `geo.country` for the
     * install event, bounded by attribution coverage.
     *
     * Every store lands in exactly one row — an unresolvable geo goes to an explicit `UNKNOWN`
     * remainder rather than being dropped — so `sum(items) === totals` holds by construction.
     */
    getCountryRollup: countryRollupService.getCountryRollup
};
