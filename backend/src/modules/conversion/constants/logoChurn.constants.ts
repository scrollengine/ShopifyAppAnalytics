'use strict';

/**
 * ============================================================================
 *  LOGO CHURN — churn measured in CUSTOMERS, not money
 * ============================================================================
 *
 *  Losing ten $9 merchants and losing one $500 merchant are the same revenue event and completely
 *  different business events. That is why this is its own page and its own vocabulary: nothing here
 *  names an amount, and the response deliberately publishes no `lost_mrr` — see the service header.
 *
 *  ──  THE ONE THING THIS FILE DOES NOT CONTAIN ─────────────────────────────────────────────
 *
 *  A DEFINITION OF "PAYING". There is exactly one in this codebase — `liveSetAsOf` in
 *  `modules/revenue/helpers/ledgerMrr.helper` — and every membership figure on this endpoint is
 *  evaluated through it. A second predicate here (a `PAYING` state test, a "billed this month"
 *  filter, a `churn_rate` derived from subscription events) would put a customer count on this page
 *  that disagrees with the customer count behind the MRR figure on the Revenue page, which is the
 *  exact divergence `modules/revenue/index.ts` publishes its ledger to prevent.
 *
 *  ──  AND THE ARTEFACT THAT MAKES THE AS-OF WINDOW LOAD-BEARING ────────────────────────────
 *
 *  12 × 30 = 360, so a shop on a 30-day billing cycle SKIPS ONE CALENDAR MONTH A YEAR. Membership
 *  defined by "did this shop have a settled charge inside calendar month M" therefore reports every
 *  such shop as CHURNED in the skipped month and NEW the month after — falsely churning ~1/12 of the
 *  paying base every month, from arithmetic rather than from anything a merchant did.
 *
 *  The fix is not in this file and must not be copied into it: membership is evaluated AT AN INSTANT
 *  with a lookback WIDER THAN THE BILLING CYCLE (`config.REVENUE.ACTIVE_SUB_WINDOW_DAYS`, 38 by
 *  default — one 30-day cycle plus payout grace), and that config field's own comment records both
 *  directions of getting it wrong: too narrow produced a measured 47.6% churn reading for a month in
 *  which nobody cancelled; removed entirely produced $45M of MRR against $10K of settled payouts.
 * ============================================================================
 */

/** Months of trend returned when the caller names none. Matches `dateRangeToMonths`' 365 preset. */
const DEFAULT_CHURN_MONTHS = 12;
/** The page's own ceiling (`dateRangeToMonths` clamps to 36), mirrored so the two cannot disagree. */
const MAX_CHURN_MONTHS = 36;

/**
 * The two headline lookbacks, in days.
 *
 * The page's tiles and its churned-shop table are captioned "last 30 days" / "last 90 days" in
 * hard-coded English (`Churned (last 30 days)`, `Recently churned (last 30 days — N shops)`), so
 * these two numbers are a rendering contract as much as a measurement choice. Changing one without
 * the caption produces a figure whose label is wrong and whose value looks fine.
 */
const RECENT_CHURN_WINDOW_DAYS = 30;
const WIDE_CHURN_WINDOW_DAYS = 90;

/**
 * How many churned-shop rows the table carries at most.
 *
 * The page renders `data.recent_churned` whole and captions it with `recent_churned.length`, so a
 * truncation would silently rewrite the caption. `recent_churned_truncated` and a warning are the
 * only channels through which a reader can discover it.
 */
const RECENT_CHURN_LIMIT = 200;

/**
 * The plan bucket for a churned shop whose plan we cannot name.
 *
 * ⚠️ A LABEL, NOT A PLAN NAME. The payout ledger carries no plan name at all — it is on the
 * subscription's own `charge.name` — so a shop whose charge events never reached us, or whose
 * payouts carry no shop domain to join on, has no plan we can honestly print. Bucketing those under
 * a real plan's name would move merchants between plans on the churn-by-plan table; bucketing them
 * under a blank renders as an empty cell that reads as a rendering fault. This says what is true.
 */
const UNKNOWN_PLAN_LABEL = 'Plan not recorded';

/**
 * How the churned-at date on a row was arrived at. Published per row so a reader can tell a dated
 * event from a derived boundary.
 *
 * ⚠️ `LEDGER_WINDOW` IS NOT A CANCELLATION DATE AND MUST NOT BE READ AS ONE. The settled-payout
 * ledger cannot date a cancellation: it only knows that a shop's most recent charge aged out of the
 * live window. The instant published on that basis is exactly that — `last_charged_at + the live
 * window for its cadence` — which is the moment membership ended, not the moment the merchant
 * clicked cancel. It is always the LATER of the two, so a row on this basis overstates how long the
 * shop paid rather than understating it.
 */
const CHURN_DATE_BASES = Object.freeze({
    /** A real `SUBSCRIPTION_CHARGE_CANCELLED` / `UNINSTALL` / `DEACTIVATED` event, with its date. */
    PARTNER_EVENT: 'partner_event',
    /** No such event reached us; the instant the shop's last settled charge aged out of the window. */
    LEDGER_WINDOW: 'ledger_window'
} as const);

/**
 * WHICH identifier on a churn row the store drawer can actually resolve.
 *
 * Published on the payload as `shop_identity` because the frontend hook records that `shop_id`
 * "means DIFFERENT things per endpoint" and its comment for this page is wrong for this build: it
 * says `shop_id` is a `tenant_id`, and there is no tenant graph here at all. `shop_id` on these rows
 * is Shopify's Partner shop id, which `storeDetailRequestParams` cannot resolve — it is not 24-hex,
 * so it would be sent as a `shop_domain` and `normaliseShopDomain` truncates a `gid://…` at the
 * first slash, yielding the literal string `gid:`. The drawer must be opened on `shop_domain`.
 */
const SHOP_IDENTITY_FIELD = 'shop_domain' as const;

export = {
    DEFAULT_CHURN_MONTHS,
    MAX_CHURN_MONTHS,
    RECENT_CHURN_WINDOW_DAYS,
    WIDE_CHURN_WINDOW_DAYS,
    RECENT_CHURN_LIMIT,
    UNKNOWN_PLAN_LABEL,
    CHURN_DATE_BASES,
    SHOP_IDENTITY_FIELD
};
