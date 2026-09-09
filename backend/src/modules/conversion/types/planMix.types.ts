/**
 * ============================================================================
 *  PLAN MIX — the frozen response contract
 * ============================================================================
 *
 *  Declarations only — `typeof import(…)` is erased at compile time, so importing this file costs
 *  nothing at run time and does NOT pull the constants module in.
 *
 *  ── EVERY NAME UNDER `PlanMixResponse` IS READ BY A REACT COMPONENT ─────────────────────────
 *
 *  `frontend/components/growth-intel/conversion/PlanMixDonut.js`, and through it
 *  `components/growth-intel/AttributionPieChart.js`. The readers:
 *
 *      plans[]                 :41, :100, :126     — the table rows AND both donuts' `items`
 *      plans[].plan_name       :35, :128, :127     — ⚠️ the donut `labelKey`, the React key, and the
 *                                                    literal `=== '(plan unknown)'` badge test
 *      plans[].active_now      :35, :133           — ⚠️ a donut METRIC key. A typo renders an EMPTY donut.
 *      plans[].mrr_amount      :35, :139           — the second donut's metric key
 *      plans[].avg_amount      :136
 *      plans[].churned_in_30d  :142
 *      plans[].churn_30d_pct   :145-146            — toned critical above 0.1
 *      plans[].currency        :136, :139, :64     — `plans[0].currency` captions the MRR total
 *      total_active_now        :42, :51            — ⚠️ `typeof === 'number'`, and `=== 0` selects the
 *                                                    WHOLE empty state
 *      total_mrr_amount        :43, :67
 *      payload_health.plans_without_charge_payload :44, :76-78 — the "run a lifetime re-sync" banner
 *
 *  ──  EVERY FIGURE IS A BARE NUMBER, NEVER A CONFIDENCE ENVELOPE ───────────────────────────
 *
 *  `_fmtNum` is `typeof n === 'number' ? … : '—'` and `_fmtMoney` is `Number(amount)`, so an envelope
 *  renders as an em dash in the table and as `NaN` in the donut's arithmetic. `IMPLEMENTATION.md`
 *  §3.11's envelopes belong on the coverage endpoint whose renderer is ours; here the honesty
 *  contract is discharged through `null`-for-unknown, `payload_health`, `data_state` and `warnings[]`
 *  — every one of which survives rendering.
 * ============================================================================
 */

type PlanMixConstants = typeof import('../constants/planMix.constants');

/** `READY` | `NEVER_SYNCED`. Decided by the WATERMARK, never a row count. */
export type PlanMixDataState =
    PlanMixConstants['PLAN_MIX_DATA_STATES'][keyof PlanMixConstants['PLAN_MIX_DATA_STATES']];

/** One plan: who is on it now, what that is worth, and who left it. */
export interface PlanMixRow {
    /**
     * ⚠️ THE DONUT'S `labelKey`, the table's React key, AND a literal the page compares against —
     * `=== '(plan unknown)'` badges the row "Re-sync to enrich". See `constants/planMix.constants`
     * for why that spelling differs from logo churn's for the same concept.
     */
    plan_name: string;
    /** Shops paying on this plan AS OF NOW, through `liveSetAsOf`. A BARE NUMBER. */
    active_now: number;
    /**
     * Shops that were paying on it 30 days ago — the churn DENOMINATOR, in the plans merchants held
     * THEN. ⚠️ `null` when the stored payout history cannot reach that boundary; never `0`, which
     * would read as a plan nobody was on.
     */
    active_30d_ago: number | null;
    /** Of those, absent from the current set. `null` for the same reason as above. */
    churned_in_30d: number | null;
    /** `churned ÷ active_30d_ago`, through the module's one `rate()`. `null` for an empty base. */
    churn_30d_pct: number | null;
    /**
     * The plan's share of MRR: the sum of its members' `monthly_amount` from the ledger.
     *
     * ⚠️ THE LEDGER'S NORMALISED FIGURE, never a price parsed out of a charge payload — an ANNUAL
     * subscriber is booked at a twelfth here, which is what makes this total reconcile with the
     * Revenue page's MRR instead of merely resembling it.
     */
    mrr_amount: number;
    /** `mrr_amount ÷ active_now`. `null` for an empty plan rather than a fabricated `0.00`. */
    avg_amount: number | null;
    /**
     * The currency the two money figures are IN.
     *
     * ⚠️ NO CONVERSION HAPPENS ANYWHERE IN THIS BUILD. On a mixed-currency plan this is the currency
     * of the largest group of its members and the sum above adds figures that are not commensurable —
     * which is why the service warns rather than quietly totalling them. `''` when no member's payout
     * named one.
     */
    currency: string;
}

/** What the query bag may carry. This endpoint is a snapshot: it takes no window at all. */
export interface PlanMixParams {
    partner_app_id: string;
}

/** The banner block. Named for what the page prints, not for what it counts — see the field. */
export interface PlanMixPayloadHealth {
    /**
     * ⚠️ SUBSCRIBERS, NOT PLANS, despite the name. `PlanMixDonut.js:78` prints it as
     * "N subscribers grouped under \"(plan unknown)\"" and the name is the frontend's, not ours —
     * publishing a plan COUNT under it would make the banner say "2 subscribers" about two hundred.
     */
    plans_without_charge_payload: number;
    /** Currencies seen across the paying base. Above 1 means the money totals are not commensurable. */
    distinct_currencies: number;
}

/** Counters an operator or a JSON reader can reconcile the payload against. */
export interface PlanMixDiagnostics {
    subscription_charge_rows: number;
    shops_with_subscription_payouts: number;
    /** Rows the plan table was truncated by. Zero unless an app has more than the row limit. */
    plans_omitted: number;
    /** Shops paying 30 days ago with no subscription on record from THEN. Filed under the unknown. */
    plans_unknown_at_30d: number;
    earliest_transaction_at: string | null;
}

/** The whole payload. */
export interface PlanMixResponse {
    app_id: string;
    app_name: string;
    as_of: string;
    /** The lookback that decides membership, published so a reader sees which window measured them. */
    active_sub_window_days: number;
    /** The churn lookback the table is captioned with. */
    churn_window_days: number;
    /** The sentence that defines membership, in the words the Logo Churn page already uses. */
    membership_basis: string;
    /** The bucket label a JSON reader should expect for an un-nameable plan. */
    unknown_plan_label: string;

    /**
     * ⚠️ `null` — never `[]` — when no Partner sync has completed. An empty ARRAY is a measured
     * empty; `null` means we have not looked.
     */
    plans: PlanMixRow[] | null;
    /**
     * ⚠️ A BARE NUMBER on a measured read; `null` when nothing has synced. `PlanMixDonut.js:42` tests
     * `typeof === 'number'` and treats `0` as its empty state, so the null never reaches it — the
     * decoder routes a `NEVER_SYNCED` payload to a banner before the component mounts.
     */
    total_active_now: number | null;
    total_mrr_amount: number | null;
    /** The currency the total above is in. `plans[0].currency` is what the page actually reads. */
    currency: string;
    payload_health: PlanMixPayloadHealth | null;

    diagnostics: PlanMixDiagnostics;
    /** One <p> each on the page, keyed by the string — every entry must be UNIQUE. */
    warnings: string[];
    data_state: PlanMixDataState;
    /** The banner body. Without it the page prints the SUCCESS message under "Nothing synced yet". */
    unknown_reason?: string;
}
