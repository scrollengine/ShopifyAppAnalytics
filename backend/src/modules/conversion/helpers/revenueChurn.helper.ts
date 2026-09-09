'use strict';

/**
 * ============================================================================
 *  ONE MONTH OF MRR MOVEMENT  →  THE TWO CHURN RATES
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, no clock. It is handed a movement that
 *  `modules/revenue`'s `diffMonths` has already folded and does arithmetic on four of its numbers.
 *
 *  ── ⚠️ IT DOES NOT DECIDE WHO IS PAYING, OR HOW MUCH, AND MUST NEVER LEARN ──────────────────
 *
 *  Both of those are defined ONCE, in `modules/revenue/helpers/ledgerMrr.helper` — `liveSetAsOf` for
 *  membership and `diffMonths` for the movement between two evaluations of it — and the caller hands
 *  the answer in. This file is the last two divisions and nothing else. `logoChurn.helper` states the
 *  same division of labour for the customer-count side, and for the same recorded reason: the system
 *  this was extracted from reconstructed MRR independently on two pages and they disagreed with each
 *  other.
 *
 *  ──  NET CHURN IS NOT CLAMPED AT ZERO ─────────────────────────────────────────────────────
 *
 *  `Math.max(0, …)` is the line this file exists to keep out. When a month's EXISTING customers
 *  expand by more than the month lost, net revenue churn is NEGATIVE — and negative net churn is the
 *  single best signal a subscription business has: it means the base grows on its own, before a
 *  single new customer is counted. Flooring it at zero hides exactly the months worth celebrating
 *  while leaving the bad ones untouched, so the series can only ever look like bad news, and nothing
 *  on screen says a number was moved.
 *
 *  The page is built for the signed value: `_ratePct` multiplies whatever arrives by 100 and the
 *  axis is auto-scaled, so a negative point plots below the zero line without any further change.
 *
 *  ── WHY BOTH RATES SHARE A NUMERATOR ────────────────────────────────────────────────────────
 *
 *  GROSS is everything the starting base LOST: cancellations plus downgrades. NET subtracts what the
 *  same base GAINED by upgrading. So `net = gross − expansion / start`, and the difference between
 *  the two lines on the chart is expansion — which is the reading the page's own tile caption
 *  ("expansion ≥ churn") is reaching for.
 *
 *  ⚠️ NEW MRR IS IN NEITHER. Both rates measure the EXISTING base; folding new customers in would
 *  make a month with strong acquisition look like a month with strong retention, which is the one
 *  substitution a churn number must never make.
 * ============================================================================
 */

import funnelMathHelper = require('./funnelMath.helper');

import type { MrrMovementFigures, RevenueChurnRates } from '../types/revenueChurn.types';

// THE ONE DIVISION. `funnelMath.helper`'s header records what the `_safeDiv` it replaced did:
// returned `0` for an empty denominator, which rendered as "0.00%" in 32-pixel type under the words
// "Conversion rate". There is no `orZero` variant and there must not be one.
const { rate } = funnelMathHelper;

/**
 * The MRR the starting base LOST — cancellations plus downgrades.
 *
 * @param movement - One month's movement, from `diffMonths`.
 * @returns Churned plus contracted MRR. `0` is a real answer: nobody left and nobody downgraded.
 */
const _lostFromBase = (movement: MrrMovementFigures): number => {
    return movement.churned_mrr + movement.contraction_mrr;
};

/**
 * Gross and net revenue churn for one month, as FRACTIONS of the opening MRR.
 *
 *  NEITHER IS CLAMPED, and `net_churn_rate` is the one that matters — see the file header. A month
 * whose expansion outruns its losses publishes a negative rate, on purpose.
 *
 * ⚠️ Both are `null`, never `0`, when the month OPENED WITH NO MRR. A ratio with an empty denominator
 * is not a measurement of perfect retention, and the page plots these on a
 * `<Line connectNulls={false}>` precisely so an unmeasurable month breaks the line rather than
 * drawing a 0% point on the axis floor.
 *
 * @param movement - One month's movement, from `diffMonths`.
 * @returns The two fractions, either of which may be null.
 */
const churnRates = (movement: MrrMovementFigures): RevenueChurnRates => {
    const lost = _lostFromBase(movement);
    return {
        gross_churn_rate: rate(lost, movement.start_mrr),
        //  NO `Math.max(0, …)`. The subtraction is allowed to go negative and the negative is
        // published. This is the whole reason the file has a header.
        net_churn_rate: rate(lost - movement.expansion_mrr, movement.start_mrr)
    };
};

export = {
    churnRates
};
