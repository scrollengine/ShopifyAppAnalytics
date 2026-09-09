'use strict';

/**
 * ============================================================================
 *  MRR FROM THE BILLING LEDGER
 * ============================================================================
 *
 *  Canonical source for "who is paying us and how much". Every MRR figure in
 *  the growth-intelligence module should come through here.
 *
 *  WHY THIS EXISTS
 *  ---------------
 *  MRR used to be reconstructed by replaying each shop's Partner API event
 *  timeline (INSTALL -> SUBSCRIPTION_CHARGE_ACTIVATED -> CANCELLED/UNINSTALL).
 *  That needs a COMPLETE lifetime event history per shop and silently drops any
 *  shop it cannot reconstruct — most visibly via
 *  `if (latestInstallIdx === -1) continue;`, which skips a shop whose install
 *  predates the synced range even though it is actively paying today. It was
 *  also duplicated across services, so two pages could disagree with each other.
 *
 *  `gi_partner_app_transaction` is the settled payout ledger — the same source
 *  the (always-correct) lifetime-revenue figure uses. A shop Shopify BILLED is a
 *  paying shop, no event history required.
 *
 *  THE AS-OF PREDICATE (defined ONCE, used by every caller)
 *  -------------------------------------------------------
 *  "Shop S is paying as-of D" iff its most recent settled subscription charge at
 *  or before D carries a positive amount AND landed within one billing cycle of
 *  D (plus grace). Evaluating the SAME predicate at each month end is what makes
 *  the headline number and the monthly series consistent by construction.
 *
 *  Two defects this replaced, both from defining membership by CALENDAR MONTH:
 *
 *   1. ANNUAL BLIND SPOT. An annual subscriber is billed once a year, so under a
 *      fixed 38-day window it vanished from MRR for ~11 months of every 12 — and
 *      `normalizeToMonthly`'s /12 never got the chance to run. The window is now
 *      derived from the shop's own billing interval.
 *
 *   2. MANUFACTURED CHURN. A 30-day cycle does not align to calendar months:
 *      12 x 30 = 360 days, so every shop skips exactly one calendar month a year.
 *      Calendar-month membership reported each of those as CHURNED that month and
 *      NEW the next — falsely churning ~1/12 of the paying base every month, and
 *      inflating new MRR by the same amount. An as-of window wider than the cycle
 *      cannot produce that artefact.
 *
 *  UNITS
 *  -----
 *  `gross_amount` is what the merchant paid, so it is the merchant-facing
 *  subscription price. ANNUAL charges are divided by 12: a year of revenue booked
 *  whole would overstate a MONTHLY run-rate twelvefold.
 * ============================================================================
 */

//  NO model import, and none may be added. `helpers/` is PURE by contract and the ESLint layer
// guard enforces it: everything here is a fold over data the caller already loaded, which is what
// lets the whole MRR predicate be unit-tested without a database. The three functions that DID read
// the ledger now live in `../repositories/revenue.repository`, and the module barrel still publishes
// them under their original names, so no consumer moved.
import type {
    ChurnedShop,
    LiveSet,
    MovementSet,
    MrrMovement,
    SubscriptionChargeRow,
    PayingShop
} from '../types/ledgerMrr.types';


// `toObjectId` is `new mongoose.Types.ObjectId(String(id))` — identical to the cast this file used
// to do inline, but routed through the one file allowed to touch the untyped model registry.

const BILLING_INTERVAL_ANNUAL = 'ANNUAL';
const MONTHS_PER_YEAR = 12;
const _DAY_MS = 24 * 60 * 60 * 1000;

// How long a single settled charge keeps a shop "live". Must exceed the billing
// cycle or a shop reads as churned between charges.
const ANNUAL_LIVE_WINDOW_DAYS = 400;

/**
 * Converts one settled charge into a monthly run-rate contribution.
 *
 * A null/unknown interval is treated as monthly — the Shopify default, and what
 * every row synced before `billing_interval` was captured looks like. Those rows
 * overstate an annual subscriber until a re-sync backfills the field.
 *
 * @returns The monthly-equivalent amount.
 */
const normalizeToMonthly = (grossAmount: number, billingInterval: string | null): number => {
    const gross = Number(grossAmount);
    if (!Number.isFinite(gross)) {
        return 0;
    }
    if (billingInterval === BILLING_INTERVAL_ANNUAL) {
        return gross / MONTHS_PER_YEAR;
    }
    return gross;
};

/**
 * How long a charge of this cadence keeps its shop live. Interval-aware so an
 * annual subscriber is not dropped between yearly charges.
 */
const liveWindowDaysFor = (billingInterval: string | null, monthlyWindowDays: number): number => {
    if (billingInterval === BILLING_INTERVAL_ANNUAL) {
        return ANNUAL_LIVE_WINDOW_DAYS;
    }
    return monthlyWindowDays;
};

/**
 * THE as-of predicate. Shops paying as-of `asOf`, each valued at its most recent
 * settled charge at or before that moment.
 *
 * `history` comes from fetchSubscriptionChargeHistory (newest first); `asOf` is the instant to
 * reconstruct; `monthlyWindowDays` is the live window for non-annual cadences.
 *
 * Declared as an OVERLOAD so callers see `LiveSet` (values are `PayingShop`) while the
 * implementation keeps `PayingShop | null` for its tombstones. The nulls below exist only inside
 * this function and are all deleted before it returns; publishing them in the return type would
 * force `diffMonths` — and every other reader — to null-check a value that can never be there, and
 * erasing them any other way would need a cast.
 *
 * @returns shop_id -> {monthly_amount, charged_amount, shop_domain, currency, billing_interval, last_charged_at}.
 */
function liveSetAsOf(history: SubscriptionChargeRow[], asOf: Date, monthlyWindowDays: number): LiveSet;
function liveSetAsOf(history: SubscriptionChargeRow[], asOf: Date, monthlyWindowDays: number): Map<string, PayingShop | null> {
    const live = new Map<string, PayingShop | null>();
    const cutoffMs = asOf.getTime();

    for (const row of history) {
        // History is newest-first, so the first row we accept per shop is its
        // most recent charge at or before `asOf`.
        if (!row.created_at || row.created_at.getTime() > cutoffMs) {
            continue;
        }
        if (live.has(row.shop_id)) {
            continue;
        }
        // Mark the shop as seen either way — a shop whose latest charge is a
        // refund or has aged out must NOT fall through to an older charge and
        // look live again.
        const ageMs = cutoffMs - row.created_at.getTime();
        const windowMs = liveWindowDaysFor(row.billing_interval, monthlyWindowDays) * _DAY_MS;
        if (row.gross <= 0 || ageMs > windowMs) {
            live.set(row.shop_id, null);
            continue;
        }
        live.set(row.shop_id, {
            shop_id: row.shop_id,
            shop_domain: row.shop_domain,
            monthly_amount: normalizeToMonthly(row.gross, row.billing_interval),
            charged_amount: row.gross,
            currency: row.currency,
            billing_interval: row.billing_interval,
            last_charged_at: row.created_at
        });
    }

    for (const [shopId, v] of live) {
        if (v === null) {
            live.delete(shopId);
        }
    }
    return live;
}

/**
 * MRR movement between two as-of live sets. Either side may be undefined.
 *
 * Categories are mutually exclusive and reconcile exactly:
 *   end = start + new + expansion - contraction - churned
 *
 * Takes `MovementSet` rather than `LiveSet` because both producers feed it — the payout ledger and
 * the subscription state machine — and only the `MovementShop` fields are common to the two. A
 * `LiveSet` still satisfies it, so the ledger callers are unaffected.
 *
 * @returns start_mrr, end_mrr, new_mrr, expansion_mrr, contraction_mrr, churned_mrr, churned_shops.
 */
const diffMonths = (prevSet: MovementSet | undefined, currSet: MovementSet | undefined): MrrMovement => {
    const prev: MovementSet = prevSet || new Map();
    const curr: MovementSet = currSet || new Map();

    let start_mrr = 0;
    let end_mrr = 0;
    let new_mrr = 0;
    let expansion_mrr = 0;
    let contraction_mrr = 0;
    let churned_mrr = 0;
    const churned_shops: ChurnedShop[] = [];

    for (const [, v] of prev) {
        start_mrr += v.monthly_amount;
    }
    for (const [, v] of curr) {
        end_mrr += v.monthly_amount;
    }

    for (const [shopId, v] of curr) {
        const before = prev.get(shopId);
        if (!before) {
            new_mrr += v.monthly_amount;
        } else if (v.monthly_amount > before.monthly_amount) {
            expansion_mrr += v.monthly_amount - before.monthly_amount;
        } else if (v.monthly_amount < before.monthly_amount) {
            contraction_mrr += before.monthly_amount - v.monthly_amount;
        }
    }

    for (const [shopId, v] of prev) {
        if (!curr.has(shopId)) {
            churned_mrr += v.monthly_amount;
            // Carried through from the last month the shop was seen paying. It is absent from the
            // month it churned in, so there is nowhere else left to read it from.
            churned_shops.push({
                shop_id: shopId,
                shop_domain: v.shop_domain || '',
                lost_mrr: v.monthly_amount,
                plan_name: v.plan_name || '',
                paid_from: v.paid_from || null,
                churn_date: v.churn_date || null
            });
        }
    }

    return { start_mrr, end_mrr, new_mrr, expansion_mrr, contraction_mrr, churned_mrr, churned_shops };
};

export = {
    normalizeToMonthly,
    liveWindowDaysFor,
    liveSetAsOf,
    diffMonths,
    BILLING_INTERVAL_ANNUAL,
    ANNUAL_LIVE_WINDOW_DAYS
};
