'use strict';

/**
 * ============================================================================
 *  ONE STORE'S ROW  →  THE CARDS THE DRAWER RENDERS
 * ============================================================================
 *
 *  DOES NO I/O AND READS NO CLOCK: every input is data, so the whole projection can be exercised
 *  against a literal row.
 *
 *  ──  IT PROJECTS THE ROSTER ROW. IT DOES NOT RE-DERIVE IT. ───────────────────────────────
 *
 *  The drawer opens OVER a table row and stays open while the reader steps down the list, so the
 *  panel and the row beneath it are on screen together. Every judgement on this record — which name
 *  won, which lifecycle state, what the plan costs, which acquisition channel, whether the app is
 *  still installed — is taken from the `StoreRosterRow` that `resolvers/storeRow.resolver` already
 *  built, and this file only renames it. A second derivation here is precisely how a store reads
 *  "Converted" in the table and "On trial" in the panel over it, which is the divergence
 *  `modules/conversion`'s barrel was widened to end.
 *
 *  What is added is the handful of facts a LIST has no column for and a record does: the
 *  subscription's own start date, whether a planned conversion was voided, the lifetime payout
 *  split, the per-subscription history, and the two provenance maps.
 *
 *  ── FOUR RENDERING TRAPS THIS FILE IS SHAPED BY ────────────────────────────────────────────
 *
 *  1.  `acquisition` IS `null` ON A MISS — not `{}`, and never a synthesised `DIRECT`.
 *     `StoreDetailContent.js:205-222` selects the "Not attributed" branch on the null and the
 *     attributed branch on anything else, so an empty object presents a store we know nothing about
 *     as a confident direct arrival inside what is already the largest bucket.
 *  2.  `average_spend` IS `null` WHEN THERE ARE NO PAYMENTS. A ratio with an empty denominator is
 *     not zero, and `fmtMoney(0)` renders `$0.00` — a specific, checkable, fabricated amount on a
 *     tile beside four real ones.
 *  3.  `billing_stale` REQUIRES PAYOUT EVIDENCE TO EXIST. "We have never fetched a payout" and
 *     "the payments stopped" are different facts and only one of them is about the merchant; the
 *     first must not raise a warning banner on the panel.
 *  4. `plan_interval` IS PER CHARGE. A store with two subscriptions must not have one's cadence
 *     attached to the other, and a charge-less subscription gets `null` rather than borrowing.
 * ============================================================================
 */

import conversion = require('../../conversion');
import storeDetailConstants = require('../constants/storeDetail.constants');

import type { StoreLifecycleState } from '../../conversion/types/lifecycle.types';
import type {
    StoreDetailAcquisition,
    StoreDetailPayouts,
    StoreDetailRecord,
    StoreDetailSubscriptionRecord,
    StoreFieldUnavailable
} from '../types/storeDetail.types';
import type { StoreDetailRecordInput } from '../types/storeDetailData.types';

// ⚠️ `STORE_LIFECYCLE_STATES` is deliberately NOT destructured here any more: the only comparison
// against it was `billing_stale`, which is now projected off the row rather than re-derived (see
// that field below). Pulling it back in is a signal that a second derivation is being written.
const {
    STORE_LIFECYCLE_LABELS,
    JOIN_MISS_STATE_BASIS
} = conversion;
const { FIELD_UNAVAILABLE_REASONS, NOT_EXPOSED_MESSAGE, NOT_PUSHED_MESSAGE } = storeDetailConstants;

/** Widened copy of the frozen label map, so a possibly-null state can index it without a cast. */
const _LIFECYCLE_LABEL_MAP: Readonly<Record<string, string>> = STORE_LIFECYCLE_LABELS;

/**
 *  THE SENTENCE THAT KEEPS AN ABSENT RATING FROM BECOMING A ZERO-STAR ONE.
 *
 * The Partner API exposes no review or rating data for a listing on any version, and this build has
 * no other source. `available: false` plus this note is the honest answer; a `0`, or a `rating: null`
 * with no explanation, both render as something a reader would act on.
 */
const _APP_REVIEW_NOTE = 'The Partner API publishes no review or rating data, so this tool cannot show '
    + 'your listing\'s rating. Open the listing to read it on the App Store.';

/** A `Date` only when it genuinely is one and genuinely valid. */
const _date = (value: unknown): Date | null => {
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
};

/** Epoch milliseconds, or `+Infinity` — which loses every "earliest" comparison, as an absence should. */
const _msOrMax = (value: Date | null | undefined): number => {
    const at = _date(value);
    return at ? at.getTime() : Number.POSITIVE_INFINITY;
};

/** One `unavailable` entry. Written out so a reason can never travel without its sentence. */
const _unavailable = (reason: StoreFieldUnavailable['reason'], message: string): StoreFieldUnavailable => {
    return { reason, message };
};

/**
 * The earliest instant ANY collection has a record of this store.
 *
 * Four candidates, and the oldest wins: the first install, the first Partner event of any type, the
 * first settled payout, and the listing-analytics install. ⚠️ It is a FLOOR bounded by what has been
 * synced — `meta.earliest_event_at` is what says how far back the record reaches at all.
 *
 * @param input - The record inputs.
 * @returns The oldest instant, or null when this store has no dated fact at all.
 */
const _firstSeen = (input: StoreDetailRecordInput): Date | null => {
    const candidates: Array<Date | null | undefined> = [
        input.row.installed_at,
        input.first_event_at,
        input.spend.first_payment_at,
        input.attribution ? input.attribution.installed_at : null
    ];
    let winner: Date | null = null;
    for (const candidate of candidates) {
        const at = _date(candidate);
        if (at && (!winner || at.getTime() < winner.getTime())) {
            winner = at;
        }
    }
    return winner;
};

/**
 * The acquisition card, or `null` when this store has no listing-analytics record.
 *
 * ⚠️ EVERY FIELD IS READ OFF THE ROW, so the "Came from" card in the panel and the "Came from"
 * column in the table behind it are the same fold, down to the channel label.
 *
 * @param input - The record inputs.
 * @returns The card, or null — see trap 1 in the header.
 */
const _acquisition = (input: StoreDetailRecordInput): StoreDetailAcquisition | null => {
    if (!input.row.has_attribution) {
        return null;
    }
    const row = input.row;
    return {
        channel: row.channel,
        channel_label: row.channel_label,
        source: row.source,
        medium: row.medium,
        campaign: row.campaign,
        attribution_source: row.attribution_source,
        surface_type: row.surface_type,
        surface_detail: row.surface_detail,
        surface_inter_position: row.surface_inter_position,
        surface_intra_position: row.surface_intra_position,
        installed_at: row.attribution_installed_at,
        lag_seconds: row.attribution_lag_seconds,
        //  The INSTALL-TRAFFIC country, published here and NEVER as `subscription.country`. One
        // is the visitor's inferred geolocation on a server-side analytics hit; the other is where
        // the merchant registered their business. They disagree routinely and legitimately.
        country: row.install_country
    };
};

/**
 * The lifetime payout rollup.
 *
 * ⚠️ `total_gross` and `total_net` are `null` — not `0` — when the store has no payout rows at all.
 * `0` is a real, renderable claim that this store has paid nothing; `null` is "there is nothing to
 * sum", and only one of those is true for a store whose payouts have never been synced.
 *
 * @param input - The record inputs.
 * @returns The rollup, with its currency withheld when the units are unlike.
 */
const _payouts = (input: StoreDetailRecordInput): StoreDetailPayouts => {
    const spend = input.spend;
    const measured = spend.transaction_count > 0;
    return {
        total_gross: measured ? spend.total_gross : null,
        total_net: measured ? spend.total_net : null,
        transaction_count: spend.transaction_count,
        //  `''` FOR A MIXED SET. There is no FX table in this build, so a store billed in two
        // currencies has a total that is a sum of unlike units — naming one of them would caption a
        // wrong number with a confident symbol. The full set is published beside it so a reader can
        // see WHICH units were mixed rather than only that they were.
        currency: spend.currencies.length === 1 ? spend.currencies[0] : '',
        currencies: spend.currencies,
        first_payment_at: spend.first_payment_at,
        last_payment_at: spend.last_payment_at,
        by_type: spend.by_type
    };
};

/**
 * Every subscription this store has had, current first.
 *
 * A store with two subscriptions has two entries and ONE current one. The superseded ones are
 * published rather than dropped because "they downgraded" and "they cancelled and re-subscribed"
 * are different stories that the winning subscription alone cannot tell apart.
 *
 * @param input - The record inputs.
 * @returns The subscriptions, current first then newest start.
 */
const _subscriptions = (input: StoreDetailRecordInput): StoreDetailSubscriptionRecord[] => {
    const all = Array.isArray(input.subscriptions) ? input.subscriptions : [];
    const currentKey = input.subscription ? input.subscription.bucket_key : '';

    const records = all.map((subscription) => {
        const chargeId = subscription.charge_id || '';
        const lifecycle: StoreLifecycleState | null = subscription.lifecycle_state;
        return {
            bucket_key: subscription.bucket_key,
            charge_id: chargeId,
            plan_name: subscription.plan_name,
            plan_price: subscription.plan_price,
            currency: subscription.currency,
            //  PER CHARGE. A charge-less subscription gets `null` rather than borrowing another
            // subscription's cadence — see trap 4 in the header.
            plan_interval: chargeId === '' ? null : (input.spend.interval_by_charge.get(chargeId) || null),
            trial_start: subscription.trial_start,
            trial_end: subscription.trial_end,
            trial_days_source: subscription.trial_days_source,
            conversion_date: subscription.conversion_date,
            churn_date: subscription.churn_date,
            state: lifecycle,
            //  `''` rather than a label, when a subscription state has lost its mapping. Naming
            // it "Installed only" here would file a paying customer under "never subscribed" — the
            // one false claim the lifecycle vocabulary exists to make impossible.
            state_label: lifecycle ? (_LIFECYCLE_LABEL_MAP[lifecycle] || '') : '',
            state_basis: subscription.state_basis,
            settled_payout_observed: subscription.settled_payout_observed,
            settled_payout_scope: subscription.settled_payout_scope,
            is_current: currentKey !== '' && subscription.bucket_key === currentKey
        };
    });

    // Current first, then newest trial start. Stable on a tie through the bucket key, so paging back
    // to a store does not reshuffle its history.
    records.sort((a, b) => {
        if (a.is_current !== b.is_current) {
            return a.is_current ? -1 : 1;
        }
        const byStart = _msOrMax(b.trial_start) - _msOrMax(a.trial_start);
        if (byStart !== 0 && Number.isFinite(byStart)) {
            return byStart;
        }
        return a.bucket_key.localeCompare(b.bucket_key);
    });
    return records;
};

/**
 * Projects one store's roster row and its joins onto the blocks the drawer renders.
 *
 * @param input - The row, its subscription history, its money and its
 *   acquisition record. See {@link StoreDetailRecordInput} — every field is DATA.
 * @returns The eight blocks, ready for the service's envelope.
 */
const resolveStoreDetailRecord = (input: StoreDetailRecordInput): StoreDetailRecord => {
    const row = input.row;
    const spend = input.spend;
    const subscription = input.subscription || null;

    /**
     * Whether the row ACCEPTED a subscription, derived from the row rather than re-tested.
     *
     *  `state_basis` is `join_miss` exactly when `resolveStoreRow` refused the subscription —
     * either there was none, or its state had lost its mapping and the row fell back to the
     * join-miss values while the service warned. Re-testing `subscription && lifecycle_state` here
     * would be a second copy of that rule, and the day the two disagree the panel publishes a plan
     * for a store whose row shows none.
     */
    const hasSubscription = row.state_basis !== JOIN_MISS_STATE_BASIS;

    const conversionDate = _date(row.conversion_date);
    const churnDate = _date(row.churn_date);

    return {
        subscription: {
            customer_name: row.customer_name,
            customer_name_source: row.customer_name_source,
            shop_name: row.shop_name,
            shop_domain: row.shop_domain,
            //  Rendered as "Platform ID". The PARTNER GID, never merged with GA4's numeric shop
            // id or the Admin API's — three namespaces for one shop, and a merged field is
            // sometimes a join key and sometimes garbage.
            platform_id: row.shop_id,

            //  ONE VARIABLE, TWO SPELLINGS. `StoreDetailContent` reads `status`;
            // `StoreTable._renderStatus` reads `state`. Assigning both from `row.state` is what
            // makes them incapable of disagreeing.
            status: row.state,
            status_label: row.state_label,
            state: row.state,
            state_label: row.state_label,
            state_basis: row.state_basis,

            //  Trap 3, and PROJECTED rather than re-derived. The expression lives in
            // `storeRow.resolver` (rule 6) so that the roster row and the panel that opens over it
            // cannot disagree; it takes MEASURED payout evidence, so a store whose payouts have
            // never been fetched reads `false` and explains itself through
            // `payouts.transaction_count` and `meta.earliest_transaction_at` rather than through a
            // warning banner about its billing.
            billing_stale: row.billing_stale,
            //  `null` — never `false` — when the install state is UNKNOWN. See the field's note
            // in `storeDetail.types.ts`: the drawer currently misrenders the null, and publishing a
            // `true` we did not measure would fix a component by lying in the contract.
            store_active: row.store_active,

            install_state: row.install_state,
            install_state_label: row.install_state_label,
            install_state_at: row.install_state_at,
            install_state_event: row.install_state_event,
            installed_at: row.installed_at,
            latest_install_at: row.latest_install_at,
            uninstalled_at: row.uninstalled_at,
            deactivated_at: row.deactivated_at,
            install_count: row.install_count,
            has_install_record: row.has_install_record,

            plan_name: row.plan_name,
            plan_price: row.plan_price,
            plan_currency: row.plan_currency,
            plan_interval: row.plan_interval,
            trial_end: row.trial_end,
            trial_days_source: row.trial_days_source,

            //  The SUBSCRIPTION's own start — the merchant's approval — and not the install
            // date. It sits in the "Lifecycle dates" card beside two subscription facts, so an
            // install date here would put a relationship fact in a subscription's row.
            activation_date: hasSubscription && subscription ? subscription.trial_start : null,
            conversion_date: row.conversion_date,
            //  The planned billing date never arrived. Published as a FLAG beside the real date
            // rather than nulling it, because the card strikes the date through and the intent is
            // half the story: this merchant chose a plan and left before paying for it.
            conversion_date_voided: !!(conversionDate && churnDate && churnDate.getTime() <= conversionDate.getTime()),
            churn_date: row.churn_date,

            //  NOT_EXPOSED on the partner tier, and `''` rather than omitted: an absent key
            // reads as a field somebody forgot, an empty one as a field with nothing behind it.
            // `unavailable` below carries the reason for each.
            country: row.country,
            country_name: row.country_name,
            website: '',
            shopify_plan_name: row.shopify_plan_name
        },

        acquisition: _acquisition(input),

        summary: {
            lifetime_value: spend.transaction_count > 0 ? spend.total_gross : null,
            //  Trap 2: `null`, never `0`, on an empty denominator.
            average_spend: spend.transaction_count > 0 ? spend.total_gross / spend.transaction_count : null,
            //  `0` means measured-and-not-paying; `null` means there was nothing to evaluate.
            // Both come from the row, which got them from the canonical MRR predicate.
            mrr: row.monthly_spend,
            tx_count: spend.transaction_count,
            first_payment_at: spend.first_payment_at,
            last_payment_at: spend.last_payment_at,
            first_seen: _firstSeen(input)
        },

        subscriptions: _subscriptions(input),
        payouts: _payouts(input),

        app_review: {
            //  ALWAYS false, and it is a measurement rather than a stub — see `_APP_REVIEW_NOTE`.
            available: false,
            rating: null,
            note: _APP_REVIEW_NOTE,
            listing_url: input.listing_url
        },

        provenance: {
            customer_name: row.customer_name_source,
            state: row.state_basis,
            trial_end: row.trial_days_source,
            install_state: row.has_install_record || row.install_state_event !== '' ? 'partner_events' : 'none',
            //  `settled_payouts` only when a payout was actually evaluated. A `null`
            // `monthly_spend` is "nothing to evaluate", and saying it came from the payout ledger
            // would credit an absence to a source.
            monthly_spend: row.monthly_spend === null ? 'none' : 'settled_payouts',
            //  On a miss this carries the TIER STATE, not a channel. `NOT_CONNECTED` and a
            // genuinely unattributed store render identically at row level (both "Not attributed",
            // which is correct) and must be separable here.
            acquisition: row.has_attribution ? 'listing_analytics' : input.attribution_state
        },

        unavailable: {
            country: _unavailable(FIELD_UNAVAILABLE_REASONS.NOT_EXPOSED, NOT_EXPOSED_MESSAGE),
            country_name: _unavailable(FIELD_UNAVAILABLE_REASONS.NOT_EXPOSED, NOT_EXPOSED_MESSAGE),
            website: _unavailable(FIELD_UNAVAILABLE_REASONS.NOT_EXPOSED, NOT_EXPOSED_MESSAGE),
            shopify_plan_name: _unavailable(FIELD_UNAVAILABLE_REASONS.NOT_EXPOSED, NOT_EXPOSED_MESSAGE),
            //  The one NOT_PUSHED entry, and the only one that is true TODAY: the profile itself
            // has not been pushed, because the collection and the endpoint that would accept it do
            // not exist yet. When they land, THIS entry disappears for a pushed store and the four
            // above are replaced per field by whichever keys that store's push actually carried.
            operator: _unavailable(FIELD_UNAVAILABLE_REASONS.NOT_PUSHED, NOT_PUSHED_MESSAGE)
        }
    };
};

export = {
    resolveStoreDetailRecord
};
