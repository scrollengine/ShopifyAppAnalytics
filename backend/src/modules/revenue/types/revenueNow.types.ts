/**
 * Input and output shapes for `services/revenueNow.service`.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 *  EVERY published figure below is an `Envelope`, never a bare number. That is not a stylistic
 * choice: a bare `number` field has no way to say "we could not compute this", so the only value it
 * could carry in that case is `0` — and a `0` in a revenue payload is a claim that the business
 * earned nothing, not a statement that the data is missing. The envelope is what makes the second
 * expressible, and typing these fields as `number` would quietly remove the option again.
 */

import type { Envelope } from '../../shared/types/confidence.types';
import type { ObjectIdLike } from '../../shared/types/entity.types';

/** Input to `getRevenueNow`. */
export interface GetRevenueNowInput {
    /** Mongo `_id` of the `gi_partner_app` to report on. The scoping root for every read. */
    partner_app_id: ObjectIdLike;
}

/** Input to `revenue.repository.findPartnerAppById`. */
export interface FindPartnerAppInput {
    partner_app_id: ObjectIdLike;
}

/** Input to `revenue.repository.getLifetimeCashTotals`. */
export interface GetLifetimeCashInput {
    partner_app_id: ObjectIdLike;
}

/** Input to `revenue.repository.getTopShopsByLifetimeNet`. */
export interface GetTopShopsInput {
    partner_app_id: ObjectIdLike;
    /** How many shops to return, highest lifetime net first. */
    limit: number;
}

/**
 * The subset of `gi_partner_app` the revenue view reads: identity plus the coverage gates.
 *
 * Every gate is `| null` because that is what the schema stores until a sync has measured it, and
 * that `null` means NOT YET MEASURED rather than zero. Narrowing any of them to a bare `Date` or
 * `Number` would delete the distinction the whole payload is built on.
 */
export interface PartnerAppRecord {
    _id: ObjectIdLike;
    app_handle: string;
    display_name: string;
    last_synced_at?: Date | null;
    earliest_event_at?: Date | null;
    /** Oldest event carrying a store name. Not a money gate — see `RevenueCoverage` for why it is read here. */
    shop_name_coverage_since?: Date | null;
    earliest_transaction_at?: Date | null;
    lifetime_sync_completed_at?: Date | null;
    event_history_gap_days?: number | null;
    charge_link_absent_pct?: number | null;
    charge_link_unresolved_pct?: number | null;
}

/**
 * All-time settled cash for one app, already flattened out of the raw aggregate row.
 *
 *  The repository returns `null` instead of a zeroed instance of this when the ledger is empty.
 * A zeroed row and a genuinely zero business are the same five numbers; only the `null` carries the
 * difference, and it is the input to every `unknown` on the payload.
 */
export interface LifetimeCashTotals {
    total_gross: number;
    total_net: number;
    total_fee: number;
    tx_count: number;
    /**
     * How many of `tx_count` are subscription charges. Separates "no recurring revenue exists" from
     * "no subscription charge has ever been synced" — identical in a total, opposite in meaning.
     */
    subscription_tx_count: number;
}

/**
 * One shop in the top-revenue ranking.
 *
 * ⚠️ LIFETIME cash, not a run-rate and not windowed — see `top_shops_basis` on the payload. Ranked
 * by NET (what actually reached the bank) rather than gross, because gross is what the merchant paid
 * and Shopify's cut comes out of it.
 */
export interface RevenueTopShopRow {
    shop_id: string;
    shop_domain: string;
    /** Sum of `net_amount.amount` across every settled payout for this shop. */
    lifetime_net: number;
    /** Sum of `gross_amount.amount` — what the merchants were charged, before Shopify's cut. */
    lifetime_gross: number;
    first_tx_at: Date | null;
    last_tx_at: Date | null;
    tx_count: number;
}

/**
 * What the underlying records can and cannot answer, so a caller can weigh every figure above.
 *
 * Each gate is itself an envelope because each is `null` until a sync has measured it, and that
 * `null` means NOT YET MEASURED. Publishing an unmeasured gate as `0` would be the exact inversion
 * of its meaning: `event_history_gap_days: 0` asserts the history has no gaps at all, which is the
 * most reassuring value the field can take.
 */
export interface RevenueCoverage {
    /** End of the last successful partner-API window. Nothing after it has been pulled. */
    last_synced_at: Envelope<Date>;
    /** Oldest event held. A question about a window opening before it has no answer here. */
    earliest_event_at: Envelope<Date>;
    /**
     * Oldest event that carries a merchant-facing STORE NAME — the boundary above which store-keyed
     * rows show a real name and below which they show a `.myshopify.com` domain.
     *
     * Not a money gate; it is here because this block is the app's whole coverage record and
     * `/api/meta/coverage` is a trim of it. `unknown` means no row carries a name yet. A date OLDER
     * than nothing — i.e. equal to `earliest_event_at` — means the backfill is complete and there is
     * nothing to warn about; a date newer than it means a LIFETIME partner sync would fill the rest.
     */
    shop_name_coverage_since: Envelope<Date>;
    /** Oldest settled payout held. The floor for every money figure on this payload. */
    earliest_transaction_at: Envelope<Date>;
    /**
     * When a LIFETIME sync last completed. While this is unknown, `lifetime_*` on this payload are
     * FLOORS rather than totals — whatever an incremental window happened to pull.
     */
    lifetime_sync_completed_at: Envelope<Date>;
    /** Widest gap in days between consecutive events inside the covered window. `0` is a real value. */
    event_history_gap_days: Envelope<number>;
    /** Percent (0–100) of charge-bearing rows carrying no `charge_id` — the link was never captured. */
    charge_link_absent_pct: Envelope<number>;
    /** Percent (0–100) whose `charge_id` matches nothing — the link is dangling, not missing. */
    charge_link_unresolved_pct: Envelope<number>;
}

/** The `data` payload of a successful `getRevenueNow` call. */
export interface RevenueNowData {
    partner_app_id: string;
    app_handle: string;
    display_name: string;
    /**
     * A LABEL for the currency the Partner API settles in, from configuration. Nothing in this
     * codebase converts currencies, so this does not promise that every row below shares it — see
     * `currencies`, which reports what the ledger actually holds.
     */
    reporting_currency: string;
    /** The instant the as-of predicate was evaluated at. Every figure here is true as of this moment. */
    as_of: Date;
    /**
     * How recently Shopify must have billed a shop for it to count as paying, in days. Published
     * because it is a MEASUREMENT DECISION rather than a tunable: `active_subs` means nothing
     * without it, and changing it changes what the dashboard says happened.
     */
    active_sub_window_days: number;

    // ── Run-rate, as of now ─────────────────────────────────────────────────

    /** Monthly recurring revenue: the sum of every live shop's charge, annual amounts divided by 12. */
    mrr: Envelope<number>;
    /** How many distinct shops are live under the as-of predicate. */
    active_subs: Envelope<number>;
    /** Average revenue per paying shop. `unknown` when there is no one to average over. */
    arpu: Envelope<number>;
    /**
     * Live shops whose settled charge carries NO `billing_interval`.
     *
     *  The measurable form of the annual caveat. `normalizeToMonthly` divides by 12 only when the
     * interval reads `ANNUAL`, so an annual subscriber on an unlabelled row is booked at twelve
     * times its true run-rate. This count is what tells a reader whether that is a theoretical
     * concern or the reason their MRR looks wrong, and it is why `mrr` downgrades to `estimated`
     * whenever it is above zero.
     */
    billing_interval_unknown_shops: Envelope<number>;
    /**
     * The distinct currency codes across live shops. More than one means `mrr` is a sum of unlike
     * units, which nothing here converts — so `mrr` carries that as a caveat rather than pretending.
     */
    currencies: Envelope<string[]>;

    // ── Cash, all time ──────────────────────────────────────────────────────

    /** Everything merchants were charged, all time. Lumpy: annual prepayments, refunds, timing. */
    lifetime_gross: Envelope<number>;
    /** What actually reached the bank, all time. This is the revenue figure to quote. */
    lifetime_net: Envelope<number>;
    lifetime_shopify_fee: Envelope<number>;
    /** Settled payout rows held for this app. The denominator behind every figure in this block. */
    transaction_count: Envelope<number>;

    // ── Ranking ─────────────────────────────────────────────────────────────

    top_shops: Envelope<RevenueTopShopRow[]>;
    /** States the ranking's basis on the payload so a reader cannot assume it shares a window. */
    top_shops_basis: string;

    coverage: RevenueCoverage;
}
