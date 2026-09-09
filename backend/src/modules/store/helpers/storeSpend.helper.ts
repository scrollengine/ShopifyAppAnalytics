'use strict';

/**
 * ============================================================================
 *  ONE STORE'S PAYOUT ROWS  →  EVERY MONEY ANSWER THIS RECORD PUBLISHES
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, no clock. It imports the Partner transaction
 *  vocabulary and nothing else, so the whole money fold can be exercised against literal rows.
 *
 *  ── ONE ARRAY, ONE PASS, AND THAT IS THE POINT ─────────────────────────────────────────────
 *
 *  Five different answers come out of these rows — the lifetime rollup, the per-type breakdown, the
 *  settled-charge evidence the subscription state machine reads, the cadence per charge, and the row
 *  the canonical MRR predicate is evaluated against. The roster gets them from TWO app-scoped
 *  aggregations because it needs them per store across an entire install base. Here there is one
 *  store, so they come from ONE array in ONE pass, which is the strongest possible version of the
 *  rule: the lifetime total and the MRR figure beside it cannot be computed from different rows.
 *
 *  ──  THE `as_of` CLAMP IS APPLIED HERE, NOT IN THE QUERY, AND ON PURPOSE ─────────────────
 *
 *  `storeRoster.repository` bounds its aggregations with `created_at: { $lte: as_of }` and its
 *  header explains why: unbounded, a payout that settles tomorrow is evidence today, and the error
 *  runs ONE WAY ONLY because the event pull and the churn clamp ARE bounded — so future revenue is
 *  admitted while future churn is excluded, and a store is published CONVERTED as of a date it had
 *  not paid.
 *
 *  That bound is not weakened here; it is MOVED, and it is moved because this endpoint is an AUDIT
 *  surface for one store. The timeline has to be able to SHOW a future-dated payout — that is a
 *  clock-skew or corrupted-row diagnostic an operator can act on — while no state, no total and no
 *  MRR figure may be decided from it. A `$lte` in the query would silently delete the evidence
 *  instead of excluding it. So the query fetches everything, this fold clamps, and
 *  `future_transactions` is what proves the clamp ran.
 *
 *  ⚠️ `created_at` is Shopify's SETTLEMENT instant. `createdAt` is when WE inserted the row. Reading
 *  the wrong one does not error; it clamps by sync time, so a lifetime backfill falls inside every
 *  window at once.
 * ============================================================================
 */

import partnerVocab = require('../../../constants/partnerVocab.constants');
import storeDetailConstants = require('../constants/storeDetail.constants');

import type {
    StoreDetailTransactionRow,
    StoreSpendFold,
    StoreSpendInput,
    StoreSpendTypeTotal
} from '../types/storeDetailData.types';

const { PARTNER_TRANSACTION_TYPES } = partnerVocab;
const { TRANSACTION_TYPE_LABELS } = storeDetailConstants;

/** A `Date` only when it genuinely is one and genuinely valid. */
const _date = (value: unknown): Date | null => {
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
};

/** Trimmed string from anything, treating null/undefined as `''`. Never `'null'`. */
const _text = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value).trim();
};

/**
 * A finite number, or `0`.
 *
 * ⚠️ `0` and not `null`, and ONLY here: these values are summed, and a null in a sum is a
 * `NaN` that silently poisons every total downstream of it. An unreadable amount contributing
 * nothing is the conservative reading — it never invents money — and the row is still counted, so
 * `transaction_count` and the totals disagree in the safe direction rather than hiding the row.
 */
const _amount = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

/**
 * Folds one store's settled payouts into every money answer this record publishes.
 *
 * @param input - See {@link StoreSpendInput}.
 * @param input.rows - Every payout row for the store, any order.
 * @param input.as_of - The judgement instant. Rows after it are EXCLUDED and COUNTED.
 * @returns The rollup, the per-type split, and the subscription evidence.
 */
const foldStoreSpend = (input: StoreSpendInput): StoreSpendFold => {
    const asOf = input && input.as_of instanceof Date && !Number.isNaN(input.as_of.getTime()) ? input.as_of : null;
    if (!asOf) {
        // Validated ONCE, here, so no comparison below can be made against an Invalid Date — which
        // compares false in every direction and would quietly admit every future payout while
        // reporting that none existed. There is no honest default for the judgement instant.
        throw new TypeError('foldStoreSpend requires a valid `as_of` Date.');
    }

    const rows: readonly StoreDetailTransactionRow[] = Array.isArray(input.rows) ? input.rows : [];

    const fold: StoreSpendFold = {
        total_gross: 0,
        total_net: 0,
        transaction_count: 0,
        first_payment_at: null,
        last_payment_at: null,
        currencies: [],
        by_type: [],
        settled_charge_ids: new Set<string>(),
        settled_domains: new Set<string>(),
        interval_by_charge: new Map<string, string>(),
        latest_subscription_payout: null,
        has_subscription_payout: false,
        future_transactions: 0,
        undated_transactions: 0,
        shopless_transactions: 0
    };

    const currencies = new Set<string>();
    const byType = new Map<string, StoreSpendTypeTotal>();
    /** The instant the currently-held `latest_subscription_payout` settled, so the newest wins. */
    let latestSubscriptionAt = Number.NEGATIVE_INFINITY;
    /** The same, per charge, so `interval_by_charge` holds the CADENCE OF THE NEWEST payout. */
    const intervalAt = new Map<string, number>();

    for (const row of rows) {
        const at = _date(row && row.created_at);
        if (!at) {
            fold.undated_transactions += 1;
            continue;
        }
        if (at.getTime() > asOf.getTime()) {
            fold.future_transactions += 1;
            continue;
        }

        const ms = at.getTime();
        const type = _text(row.type);
        const gross = _amount(row.gross_amount && row.gross_amount.amount);
        const net = _amount(row.net_amount && row.net_amount.amount);
        const currency = _text(row.gross_amount && row.gross_amount.currency);
        const domain = _text(row.shop_domain);

        // ──  A PAYOUT THAT NAMES NO SHOP IS EVIDENCE, NEVER MONEY ─────────
        //
        // The caller may hand this fold rows recovered by CHARGE rather than by domain — a payout
        // for a shop Shopify redacted, which carries no `shop_domain` at all. Those rows decide one
        // thing and one thing only: whether money provably moved against a charge, which is the
        // branch the state machine takes when Shopify supplied no `billingOn`. They must not reach a
        // total, a count, a currency or the MRR row, because a payout that names no shop cannot be
        // attributed to one — the roster's own spend aggregation excludes them explicitly, and
        // admitting them here would make this store's lifetime total disagree with the same store's
        // total on the list behind the panel.
        if (domain === '') {
            if (type === PARTNER_TRANSACTION_TYPES.APP_SUBSCRIPTION) {
                const orphanChargeId = _text(row.charge_id);
                if (orphanChargeId !== '') {
                    fold.settled_charge_ids.add(orphanChargeId);
                    const orphanInterval = _text(row.billing_interval);
                    if (orphanInterval !== '' && ms >= (intervalAt.get(orphanChargeId) ?? Number.NEGATIVE_INFINITY)) {
                        fold.interval_by_charge.set(orphanChargeId, orphanInterval);
                        intervalAt.set(orphanChargeId, ms);
                    }
                }
            }
            fold.shopless_transactions += 1;
            continue;
        }

        fold.transaction_count += 1;
        fold.total_gross += gross;
        fold.total_net += net;
        if (currency !== '') {
            currencies.add(currency);
        }
        if (!fold.first_payment_at || ms < fold.first_payment_at.getTime()) {
            fold.first_payment_at = at;
        }
        if (!fold.last_payment_at || ms > fold.last_payment_at.getTime()) {
            fold.last_payment_at = at;
        }

        const bucket = byType.get(type);
        if (bucket) {
            bucket.count += 1;
            bucket.gross += gross;
            bucket.net += net;
        } else {
            byType.set(type, {
                type,
                // The raw stored value when the vocabulary has no label for it. An unrecognised
                // payout type is STORED rather than dropped (see `partnerVocab.constants`), so it
                // has to be renderable rather than blank.
                label: TRANSACTION_TYPE_LABELS[type] || type,
                count: 1,
                gross,
                net
            });
        }

        // ── The subscription evidence ───────────────────────────────────────
        //  `APP_SUBSCRIPTION` ONLY. Usage and one-time charges are real money and are NOT
        // evidence that a SUBSCRIPTION converted; counting them reports a store that bought a
        // single add-on as a paying subscriber.
        if (type !== PARTNER_TRANSACTION_TYPES.APP_SUBSCRIPTION) {
            continue;
        }
        fold.has_subscription_payout = true;

        const chargeId = _text(row.charge_id);
        if (chargeId !== '') {
            fold.settled_charge_ids.add(chargeId);
            const interval = _text(row.billing_interval);
            // Only a per-CHARGE cadence is recorded. A domain-scoped fallback would attach one
            // subscription's cadence to another on any store with two, and an invented cadence is
            // exactly what a null `billing_interval` must never become.
            if (interval !== '' && ms >= (intervalAt.get(chargeId) ?? Number.NEGATIVE_INFINITY)) {
                fold.interval_by_charge.set(chargeId, interval);
                intervalAt.set(chargeId, ms);
            }
        }
        fold.settled_domains.add(domain);

        if (ms > latestSubscriptionAt) {
            latestSubscriptionAt = ms;
            fold.latest_subscription_payout = {
                //  `shop_id` HOLDS THE DOMAIN, deliberately. `liveSetAsOf` keys its answer by
                // whatever it finds in this field and never interprets the value, so the domain
                // gives a domain-keyed live set — and sidesteps the hazard that the stored
                // `shop_id` is `''` on every row that carried no Partner GID.
                shop_id: domain,
                shop_domain: domain,
                gross,
                currency,
                //  The RAW stored value, `null` included. A null interval booked as monthly is
                // how an annual subscriber gets reported at twelve times their true rate, and the
                // predicate downstream is interval-aware precisely so it can be handed the null.
                billing_interval: row.billing_interval === undefined ? null : row.billing_interval,
                created_at: at
            };
        }
    }

    fold.currencies = [...currencies].sort((a, b) => a.localeCompare(b));
    // Biggest gross first, then by type name so the order is deterministic when two types tie —
    // which they do routinely at zero on a store with a refund that exactly offsets a payment.
    fold.by_type = [...byType.values()].sort((a, b) => (b.gross - a.gross) || a.type.localeCompare(b.type));

    return fold;
};

export = {
    foldStoreSpend
};
