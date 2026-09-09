/**
 * ============================================================================
 *  WHAT THE STORE-DETAIL LAYER PASSES BETWEEN ITS OWN FILES
 * ============================================================================
 *
 *  Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 *  Deliberately SEPARATE from `storeDetail.types.ts`, for the same reason `storeRosterData.types.ts`
 *  is separate from `storeRoster.types.ts`: that file is the response contract, and every name in it
 *  is read by a React component, so a rename there blanks a card. Nothing in THIS file reaches the
 *  wire. Keeping the two apart is what stops a query's convenience field drifting into the payload,
 *  and stops a payload rename being blocked by a query.
 *
 *  ── WHY THE READS ARE STORE-SCOPED AND THE ROSTER'S ARE NOT ────────────────────────────────
 *
 *  `storeRoster.repository` reads the whole app: the population IS every store. This one reads ONE
 *  store, so the projections can afford what that one cannot — `raw_event` above all, which is the
 *  single biggest cost decision in the roster and is free here. A store has tens of events; the
 *  install base has hundreds of thousands.
 * ============================================================================
 */

import type { SubscriptionChargeRow } from '../../revenue/types/ledgerMrr.types';

// ── The repository's row shapes ─────────────────────────────────────────────

/**
 * One Partner event for one store, projected to everything the detail fold reads.
 *
 * ⚠️ `raw_event` IS PROJECTED HERE, unlike the roster's relationship read — and the difference is
 * the population, not a change of mind. `billingOn`, `charge.name`, `charge.amount` and
 * `charge.test` live NOWHERE else, so the subscription state machine cannot run without it; the
 * roster refuses it because pulling a Mixed blob for every relationship event in the install base
 * multiplies the bytes on the wire by an order of magnitude, and one store's events do not.
 *
 *  Structurally compatible with `ChargeCohortEventRow`, deliberately: these rows are handed
 * straight to `modules/conversion`'s cohort fold, which is what stops this module classifying the
 * same subscription differently from the two endpoints that already ship.
 */
export interface StoreDetailEventRow {
    /**
     * The collection's own idempotency key — a local sha256 of (app, typename, occurredAt, shop_id,
     * shop_domain, charge_id), carrying a unique index.
     *
     * ⚠️ PROJECTED PURELY SO THE TWO EVENT READS CAN BE MERGED WITHOUT DOUBLE-COUNTING. The
     * domain-keyed read and the charge-keyed one overlap by construction — most of a store's charge
     * events carry both its domain and its charge id — and de-duplicating on a composite of the
     * fields would be re-deriving this value from a strict subset of its own inputs.
     */
    partner_event_id: string;
    /**
     * Already canonical — normalised on write.
     *
     * ⚠️ CAN BE `''` ON A ROW FROM THE CHARGE-KEYED READ, and that row is exactly why that read
     * exists: a `SubscriptionChargeCanceled` for a shop Shopify redacted between the install and the
     * cancellation carries no domain at all, so the domain-keyed read cannot see it.
     */
    shop_domain: string;
    event_type: string;
    occurred_at: Date;
    /** Bare numeric, already normalised on write. `''` means "not about a charge". */
    charge_id: string;
    /** The Partner GID for the shop. `''` on rows that carried none. */
    shop_id: string;
    /**
     * ⚠️ OPTIONAL AND OFTEN ABSENT — the column postdates the collection and a mongoose default is
     * not retroactive, so a `.lean()` read of an older row returns NO key at all. `undefined` and
     * `''` must be treated alike, and NEITHER means "this store has no name".
     */
    shop_name?: string;
    /** The whole Partner node. Read ONLY by the cohort fold; the timeline never touches it. */
    raw_event?: Record<string, any> | null;
}

/**
 * One settled payout for one store, projected to what the money fold and the timeline read.
 *
 * ⚠️ `created_at` is Shopify's SETTLEMENT instant, never `createdAt`, which `timestamps` writes when
 * WE inserted the row. They are different facts one character apart, and reading the wrong one does
 * not error: it orders by sync time, so a lifetime backfill makes the whole ledger look like one day.
 */
export interface StoreDetailTransactionRow {
    type: string;
    shop_domain: string;
    /** `''` when the payout type carries no charge id. Only `APP_SUBSCRIPTION` does. */
    charge_id: string;
    /** ANNUAL | EVERY_30_DAYS | null. The ONLY place Shopify exposes a subscription's cadence. */
    billing_interval?: string | null;
    gross_amount?: { amount?: number | null; currency?: string | null } | null;
    net_amount?: { amount?: number | null; currency?: string | null } | null;
    created_at: Date;
}

/**
 * The charge-keyed read's input: this store's charges, from its own events and its own payouts.
 *
 *  THE SECOND PASS THAT KEEPS THE PANEL AND THE TABLE FROM DISAGREEING. The roster's charge pull is
 * APP-scoped, so a subscription's end event is inside it whatever the row's domain says. A per-store
 * read cannot be: `gi_partner_app_events`'s own model note records that a `SubscriptionChargeCanceled`
 * for a shop redacted between its install and its cancellation carries NO shop domain — so a
 * domain-keyed read misses it, that subscription never churns, and the drawer shows CONVERTED over a
 * table row that says CHURNED. This read is what recovers it.
 */
export interface StoreDetailChargeQuery {
    partner_app_id: string;
    /** Bare numeric charge ids, already normalised on write. Empty ⇒ the caller must skip the read. */
    charge_ids: readonly string[];
}

/** Every read here is app-scoped AND store-scoped. The detail has one subject, always. */
export interface StoreDetailQuery {
    partner_app_id: string;
    /**
     * ⚠️ ALREADY CANONICAL. The caller normalises the NEEDLE once, through
     * `shared/helpers/shopDomain.helper`, because a client may send a raw URL rather than a bare
     * domain. The STORED value is never re-normalised: that would establish the second
     * implementation the helper exists to prevent.
     */
    shop_domain: string;
}

// ── The money fold ──────────────────────────────────────────────────────────

/** One payout type's contribution to a store's lifetime spend. Counts and sums, never a rate. */
export interface StoreSpendTypeTotal {
    /** A `PARTNER_TRANSACTION_TYPES` member, or whatever unrecognised value was stored. */
    type: string;
    label: string;
    count: number;
    /** Sum of `gross_amount.amount` for this type. NEGATIVE for credits and some adjustments. */
    gross: number;
    net: number;
}

/**
 * What `helpers/storeSpend.helper` folds one store's payout rows into.
 *
 * ONE ARRAY, ONE PASS, FIVE ANSWERS — and they are five readings of the same rows, which is why
 * they are computed together rather than by five scans that could disagree.
 */
export interface StoreSpendFold {
    /** Sum of `gross_amount.amount` across EVERY type, refunds included as negatives. */
    total_gross: number;
    /** Sum of `net_amount.amount` — after Shopify's cut. Published beside gross, never merged. */
    total_net: number;
    /** Settled payout rows considered, i.e. those at or before the judgement instant. */
    transaction_count: number;
    first_payment_at: Date | null;
    last_payment_at: Date | null;
    /** Every distinct currency seen. More than one ⇒ the total is a sum of unlike units. */
    currencies: string[];
    /** Per-type totals, biggest gross first. Empty when the store has never settled a payout. */
    by_type: StoreSpendTypeTotal[];

    // ── The subscription evidence, read off the same rows ────────────────────
    /** Charge ids with at least one settled `APP_SUBSCRIPTION` payout. Feeds the state machine. */
    settled_charge_ids: Set<string>;
    /** `{shop_domain}` when ANY settled `APP_SUBSCRIPTION` payout exists — the coarser fallback. */
    settled_domains: Set<string>;
    /** Cadence per charge, from that charge's most recent settled payout. ⚠️ Never per domain. */
    interval_by_charge: Map<string, string>;
    /**
     * The newest settled `APP_SUBSCRIPTION` payout, as the MRR ledger's own row shape, or `null`.
     *
     * ⚠️ `shop_id` HOLDS THE DOMAIN, deliberately and exactly as the roster does it: `liveSetAsOf`
     * keys its answer by whatever it finds in that field and never interprets the value, so feeding
     * it the domain produces a domain-keyed live set — and sidesteps the hazard that `shop_id` is
     * `''` on payout rows that carried no Partner GID.
     */
    latest_subscription_payout: SubscriptionChargeRow | null;
    /** Whether ANY settled `APP_SUBSCRIPTION` payout exists. `null` monthly spend hangs on this. */
    has_subscription_payout: boolean;

    // ── What the fold could not use ─────────────────────────────────────────
    /** Rows dated AFTER the judgement instant. Excluded from every figure above, and REPORTED. */
    future_transactions: number;
    /** Rows with no readable `created_at`. Unreachable from a stored document; counted anyway. */
    undated_transactions: number;
    /**
     * Rows carrying NO `shop_domain` — recovered by charge id, and counted rather than absorbed.
     *
     *  They contribute to `settled_charge_ids` and `interval_by_charge` and to NOTHING ELSE. A
     * payout that names no shop cannot be attributed to one, so it is evidence that money moved
     * against a CHARGE and never money this store paid. Letting one into a total would make the
     * panel's lifetime figure disagree with the same store's figure on the list behind it.
     */
    shopless_transactions: number;
}

/** Every input is DATA — the spend helper does no I/O and reads no clock. */
export interface StoreSpendInput {
    /**
     * Every payout row, in any order.
     *
     * ⚠️ MAY INCLUDE ROWS THIS STORE DOES NOT OWN THE MONEY FOR: the caller merges in payouts
     * recovered by CHARGE id whose `shop_domain` is blank. The fold keeps them apart — see
     * `shopless_transactions`.
     */
    rows: readonly StoreDetailTransactionRow[];
    /** The judgement instant. Applied as a CLAMP here rather than in the query — see the helper. */
    as_of: Date;
}

// ── The record fold ─────────────────────────────────────────────────────────

/**
 * What `resolvers/storeDetailRecord.resolver` is handed for one store.
 *
 *  IT IS HANDED THE ALREADY-BUILT `StoreRosterRow`, NOT THE RAW JOINS, and that is the single most
 * important line in this file. The drawer opens OVER a table row, so the panel and the row under it
 * must be the same fold — `resolveStoreRow` decides the name, the state, the money and the channel
 * exactly once, and this resolver only projects that decision onto the names these components read.
 * Re-deriving any of it here is how a store reads "Converted" in the table and "On trial" in the
 * panel over it.
 */
export interface StoreDetailRecordInput {
    /** The row the roster would publish for this store. The one source of every judgement. */
    row: import('./storeRoster.types').StoreRosterRow;
    /** The store's winning subscription — latest trial start — or nothing at all. */
    subscription?: import('../../conversion/types/lifecycle.types').CohortSubscription | null;
    /** EVERY subscription this store has had, superseded ones included, in any order. */
    subscriptions?: readonly import('../../conversion/types/lifecycle.types').CohortSubscription[];
    /** The money fold, which also carries the per-charge cadence map. */
    spend: StoreSpendFold;
    /** The listing-analytics record nearest the install instant, or nothing. */
    attribution?: import('./storeRosterData.types').StoreAttributionRow | null;
    /**
     * The app's own App Store listing URL, so the review card's "Open listing" link resolves.
     * Passed as DATA: this resolver reads no document.
     */
    listing_url: string;
    /**
     * The oldest Partner event for this store, whatever its type.
     *
     * ⚠️ NOT the same as the row's `installed_at`, which is the oldest INSTALL. A store known only
     * from a charge event has no install date and still has a first event, and `summary.first_seen`
     * would otherwise be null for exactly the stores whose history is most puzzling.
     */
    first_event_at?: Date | null;
    /**
     * The tier state that explains a missing acquisition record: `READY` means the sync ran and this
     * store genuinely has none. Published through `provenance.acquisition`, never as a channel.
     */
    attribution_state: string;
}
