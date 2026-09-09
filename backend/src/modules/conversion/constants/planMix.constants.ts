'use strict';

/**
 * ============================================================================
 *  PLAN MIX — who is on what, what it is worth, and who left each plan
 * ============================================================================
 *
 *  The vocabulary behind `GET /api/conversion/plan-mix`. Numbers and labels only.
 *
 *  ──  THIS ENDPOINT DOES NOT DEFINE "PAYING", AND IT MUST NEVER LEARN HOW ──────────────────
 *
 *  There is exactly one definition in this codebase — `liveSetAsOf` in
 *  `modules/revenue/helpers/ledgerMrr.helper` — and both the donut's membership and its 30-day churn
 *  are set operations over two evaluations of it. `constants/logoChurn.constants` makes the same
 *  declaration for the same reason, and the reason is worth repeating here because THIS page is the
 *  one carrying money: a second predicate would put a subscriber count under a donut that disagrees
 *  with the subscriber count behind the MRR figure on the Revenue page, and with the customer count
 *  on the Logo Churn page, with nothing on any of the three screens to say which was right.
 *
 *  ──  THE UNKNOWN-PLAN LABEL IS SPELLED DIFFERENTLY FROM LOGO CHURN'S, ON PURPOSE ──────────
 *
 *  `logoChurn.constants.UNKNOWN_PLAN_LABEL` is `'Plan not recorded'`. This one is `'(plan unknown)'`,
 *  and the difference is NOT an oversight — it is a FRONTEND CONTRACT that predates this endpoint:
 *
 *    - `PlanMixDonut.js:128` tests `p.plan_name === '(plan unknown)'` as a LITERAL to decide whether
 *      to badge the row "Re-sync to enrich";
 *    - `:78` prints the banner `N subscribers grouped under "(plan unknown)"`, also as a literal.
 *
 *  Publishing `'Plan not recorded'` here would leave the badge unrendered and the banner quoting a
 *  bucket name that appears nowhere in the table beneath it. Publishing `'(plan unknown)'` from logo
 *  churn instead would change a shipped endpoint's wire format.
 *
 *  ⚠️ SO THERE ARE TWO SPELLINGS OF ONE CONCEPT IN THIS MODULE, AND THIS COMMENT IS THE ONLY THING
 *  KEEPING THAT DELIBERATE. The fix is a frontend one — teach `PlanMixDonut` to read the label off
 *  the payload (this file already publishes it) instead of hard-coding it — after which the two
 *  become one constant. Until then, do not "tidy" either of them into the other.
 *
 *  ── WHAT THE PAYLOAD CARRIES THAT LOGO CHURN DELIBERATELY DOES NOT ──────────────────────────
 *
 *  Money. Logo churn counts logos and publishes no amount anywhere, because losing ten $9 merchants
 *  and losing one $500 merchant are the same revenue event and completely different business events.
 *  Plan mix is the view where that distinction IS the subject — `PlanMixDonut` draws subscriber share
 *  and MRR share as two donuts precisely so the gap between them can be read — so `mrr_amount` and
 *  `avg_amount` belong here. They come from `PayingShop.monthly_amount`, which is the ledger's own
 *  normalised figure, never a plan price parsed out of a charge payload.
 * ============================================================================
 */

/**
 * The bucket for a subscriber whose plan cannot be named.
 *
 *  A LABEL, NOT A PLAN NAME, and its exact spelling is read by the renderer — see the file header.
 * The payout ledger carries no plan name at all; it lives on the subscription's own `charge.name`, so
 * a shop whose charge events never reached us has no plan we can honestly print. Bucketing those
 * under a real plan would move merchants between donut slices; bucketing them under `''` renders as
 * an empty legend entry that reads as a rendering fault. This says what is true.
 */
const PLAN_MIX_UNKNOWN_PLAN_LABEL = '(plan unknown)';

/**
 * How many plan rows the table carries at most.
 *
 * `PlanMixDonut` renders `data.plans` WHOLE (`:126`) and the donuts bucket their own long tail into
 * "Other" at `topN: 8` — so this ceiling protects the TABLE, which has no pagination and no "show
 * all" control. A truncation is reported in `warnings[]`, which is the only channel a reader has.
 */
const PLAN_MIX_ROW_LIMIT = 100;

/**
 * The churn lookback, in days.
 *
 * ⚠️ `PlanMixDonut.js:122` captions the table "Per-plan churn (last 30 days)" in hard-coded English,
 * so this number is a rendering contract as much as a measurement choice — exactly as
 * `logoChurn.constants.RECENT_CHURN_WINDOW_DAYS` is on its own page. It is DECLARED HERE rather than
 * imported from there because the two captions are independent strings on two components: making one
 * follow the other would mean a change to the Logo Churn page silently relabelling this one.
 *
 * They are the same value today, and `test/conversionAnalysis.test.js` asserts that they agree — a
 * drift is a real finding (the two pages would then measure "who left" over different windows and
 * disagree about the same merchants), so it is checked rather than made impossible.
 */
const PLAN_MIX_CHURN_WINDOW_DAYS = 30;

/** Same two `data_state` values as every other read in this module, decided by the WATERMARK. */
const PLAN_MIX_DATA_STATES = Object.freeze({
    READY: 'READY',
    NEVER_SYNCED: 'NEVER_SYNCED'
} as const);

export = {
    PLAN_MIX_UNKNOWN_PLAN_LABEL,
    PLAN_MIX_ROW_LIMIT,
    PLAN_MIX_CHURN_WINDOW_DAYS,
    PLAN_MIX_DATA_STATES
};
