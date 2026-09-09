'use strict';

/**
 * ============================================================================
 *  CAN THE STORED PAYOUT HISTORY DECIDE MEMBERSHIP AT THIS INSTANT?
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, no clock — the floor and the window arrive as
 *  parameters, so the same boundary answers identically on a re-run and inside a test.
 *
 *  ──  WHY THIS IS A FILE AND NOT A PRIVATE FUNCTION IN THREE SERVICES ──────────────────────
 *
 *  It WAS a private `_isSupportedBoundary` in `services/logoChurn.service`, and then a byte-identical
 *  second copy appeared in `services/revenueChurn.service` the day churn was also measured in money.
 *  `services/planMix.service` would have been the THIRD. Three copies of one predicate is three
 *  places for the comparison to be relaxed from `>=` to `>`, or for the `floor === null` branch to be
 *  "tidied" into a `false` — and each of those edits blanks or fabricates a different page, silently,
 *  with nothing on any screen to say the three no longer agree.
 *
 *  ── WHAT IT ACTUALLY DECIDES ────────────────────────────────────────────────────────────────
 *
 *  `liveSetAsOf` answers "shop S is paying at D" by looking back ONE LIVE WINDOW from D. A boundary
 *  is therefore only decidable when that whole lookback is covered by stored history. A boundary
 *  sitting inside the run-up to the coverage floor sees a TRUNCATED history and under-counts the
 *  paying base — silently, and always downwards. On a customer chart that draws a business that has
 *  just started; on a money chart it is worse, because an under-counted opening base makes the same
 *  cancellations read as a far higher churn RATE.
 *
 *  ── ⚠️ `floor === null` RETURNS TRUE, AND THAT IS NOT A LOOPHOLE ────────────────────────────
 *
 *  A null coverage gate means the floor was never MEASURED, not that there is no history. Treating
 *  it as a floor would blank every month on a deployment whose gate has simply never been written —
 *  a deployment whose data may be perfect. The CALLER warns about that case instead, which is the
 *  only place that distinction can be put into words an operator can act on.
 * ============================================================================
 */

/**
 * Whether the stored payout history reaches far enough back to decide membership AT `at`.
 *
 * @param at - The boundary to test.
 * @param floor - `earliest_transaction_at`, or null when it was never measured.
 * @param window_ms - The live window, in milliseconds.
 * @returns True when membership at that instant can be decided from stored history.
 */
const isSupportedLedgerBoundary = (at: Date, floor: Date | null, window_ms: number): boolean => {
    if (!floor) {
        return true;
    }
    return at.getTime() - window_ms >= floor.getTime();
};

export = {
    isSupportedLedgerBoundary
};
