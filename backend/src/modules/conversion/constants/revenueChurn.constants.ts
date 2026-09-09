'use strict';

/**
 * ============================================================================
 *  REVENUE CHURN — churn measured in MONEY, beside the page that counts logos
 * ============================================================================
 *
 *  The other half of the split `logoChurn.constants` describes. Losing ten $9 merchants and losing
 *  one $500 merchant are the SAME revenue event and completely different business events: Logo Churn
 *  answers the second question and publishes no amount at all, and this endpoint answers the first
 *  and publishes nothing but amounts.
 *
 *  ──  THE ONE THING THIS FILE DOES NOT CONTAIN ─────────────────────────────────────────────
 *
 *  A DEFINITION OF "PAYING", OR OF "HOW MUCH". Both live in `modules/revenue/helpers/ledgerMrr` —
 *  `liveSetAsOf` and `diffMonths` — and every figure this endpoint publishes is folded by them. A
 *  second predicate here would put an MRR movement on this page that disagrees with the MRR on the
 *  Revenue page and with the customer counts on Logo Churn, which is the exact divergence
 *  `modules/revenue/index.ts` publishes its ledger to prevent.
 *
 *  ──  AND THE ONE THAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────
 *
 *  A FLOOR ON NET CHURN. There is no `MIN_NET_CHURN = 0` here and there must never be one. When a
 *  month's existing customers expand by more than the month lost, net revenue churn is NEGATIVE —
 *  and negative net churn is the single best signal a subscription business has. Rounding it up to
 *  zero hides the best months while leaving the worst ones untouched, so the chart only ever looks
 *  like bad news. See `helpers/revenueChurn.helper`, which is where the two rates are computed.
 * ============================================================================
 */

/** Months of trend returned when the caller names none. Matches `dateRangeToMonths`' 365 preset. */
const DEFAULT_REVENUE_CHURN_MONTHS = 12;
/** The page's own ceiling (`dateRangeToMonths` clamps to 36), mirrored so the two cannot disagree. */
const MAX_REVENUE_CHURN_MONTHS = 36;

/**
 * How many churned merchants the "Top revenue lost" table carries at most.
 *
 * A TOP-N table rather than a complete list, and the page renders whatever it is given with no
 * pagination — so the cap has to be reported through `top_churned_truncated` and a note, which are
 * the only channels a reader can discover it through.
 */
const TOP_CHURNED_LIMIT = 50;

/**
 * WHICH identifier on a churn row the store drawer can actually resolve.
 *
 * ⚠️ THE SAME TRAP `logoChurn.constants` documents, and it bites harder here. `shop_id` on these
 * rows is Shopify's PARTNER shop id (`gid://partners/Shop/17`) — `liveSetAsOf` reads it straight off
 * `PartnerAppTransaction.shop_id` — and `storeDetailRequestParams` cannot resolve it: it is not
 * 24-hex, so it would be sent as a `shop_domain`, and `normaliseShopDomain` truncates a `gid://…` at
 * the first slash to the literal string `gid:`. The drawer must be opened on `shop_domain`, and
 * `components/growth-intel/revenue/ChurnView.js` already keys on it for exactly this reason.
 */
const SHOP_IDENTITY_FIELD = 'shop_domain' as const;

export = {
    DEFAULT_REVENUE_CHURN_MONTHS,
    MAX_REVENUE_CHURN_MONTHS,
    TOP_CHURNED_LIMIT,
    SHOP_IDENTITY_FIELD
};
