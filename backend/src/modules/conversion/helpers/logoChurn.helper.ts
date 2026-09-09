'use strict';

/**
 * ============================================================================
 *  TWO LIVE SETS  →  ONE MONTH OF SUBSCRIBER MOVEMENT
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, and NO CLOCK. Both boundaries arrive as
 *  already-evaluated sets, so the same pair folds identically on a re-run and inside a test.
 *
 *  ── ⚠️ IT DOES NOT DECIDE WHO IS PAYING, AND IT MUST NEVER LEARN HOW ────────────────────────
 *
 *  There is exactly ONE definition of "shop S is paying as of D" in this codebase — `liveSetAsOf` in
 *  `modules/revenue/helpers/ledgerMrr.helper` — and the caller evaluates it at each boundary and
 *  hands the two answers in. This file takes the SET DIFFERENCE and nothing else.
 *
 *  That division of labour is the entire point. The system this was extracted from reconstructed
 *  membership independently on two pages and they disagreed with each other; `modules/revenue`
 *  publishes its predicate for exactly that reason. A test here for "is this shop paying" — a state
 *  check, an amount threshold, a "billed in this window" filter — would be the second definition,
 *  and the customer count on the Logo Churn page would stop matching the subscriber count behind the
 *  MRR figure on the Revenue page with nothing on screen to say which was right.
 *
 *  ── ⚠️ AND IT NEVER READS AN AMOUNT ─────────────────────────────────────────────────────────
 *
 *  The set's VALUES are typed `unknown` on purpose. Logo churn is churn measured in CUSTOMERS:
 *  losing ten $9 merchants and losing one $500 merchant are the same revenue event and completely
 *  different business events, which is why the two live on separate pages. A helper that could see
 *  `monthly_amount` is a helper that will eventually total it.
 *
 *  ── THE ARTEFACT THIS SHAPE EXISTS TO AVOID ─────────────────────────────────────────────────
 *
 *  Membership at an INSTANT, from sets the caller built with a lookback wider than the billing
 *  cycle. NOT "did this shop have a settled charge inside calendar month M" — 12 × 30 = 360, so a
 *  30-day biller skips one calendar month a year, and month-of-charge membership reports every one of
 *  them as churned that month and new the next. That is ~1/12 of the paying base churning every
 *  month out of arithmetic, and it renders as a perfectly plausible chart.
 * ============================================================================
 */

import funnelMathHelper = require('./funnelMath.helper');

import type { MembershipMovement, MembershipSet } from '../types/logoChurn.types';

const { rate } = funnelMathHelper;

/**
 * The movement between two membership boundaries.
 *
 * `gained` and `churned` are mutually exclusive by construction, and the identity
 * `active_at_end === active_at_start + gained - churned` holds for any pair of sets — which is what
 * makes a published month reconcilable rather than merely plausible.
 *
 * @param params0 - The parameters object.
 * @param params0.start_set - Who was paying at the opening boundary.
 * @param params0.end_set - Who was paying at the closing boundary.
 * @returns The four counts, the rate, and the keys that left.
 */
const foldMembershipMovement = ({
    start_set,
    end_set
}: {
    start_set: MembershipSet;
    end_set: MembershipSet;
}): MembershipMovement => {
    const start: MembershipSet = start_set instanceof Map ? start_set : new Map();
    const end: MembershipSet = end_set instanceof Map ? end_set : new Map();

    const churnedKeys: string[] = [];
    for (const key of start.keys()) {
        if (!end.has(key)) {
            churnedKeys.push(key);
        }
    }

    let gained = 0;
    for (const key of end.keys()) {
        if (!start.has(key)) {
            gained += 1;
        }
    }

    return {
        active_at_start: start.size,
        active_at_end: end.size,
        gained,
        churned: churnedKeys.length,
        // Through `rate`, so an empty opening boundary answers `null` rather than `0`. A `0` here
        // renders as "0.0%" beside the words "Churn rate" — a claim of perfect retention, made about
        // a month in which nobody was paying at all.
        churn_rate: rate(churnedKeys.length, start.size),
        churned_keys: churnedKeys
    };
};

export = {
    foldMembershipMovement
};
