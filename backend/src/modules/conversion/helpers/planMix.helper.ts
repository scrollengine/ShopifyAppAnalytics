'use strict';

/**
 * ============================================================================
 *  WHICH PLAN WAS THIS MERCHANT ON, AT THIS INSTANT?
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, and NO CLOCK — the instant arrives as a parameter,
 *  so one merchant is filed under one plan on a re-run, inside a test, and on either endpoint that
 *  asks.
 *
 *  ──  WHY THIS IS A FILE AND NOT A BLOCK INSIDE `logoChurn.service` ────────────────────────
 *
 *  It WAS a block inside that service, and it stayed correct only while there was one caller.
 *  `GET /api/conversion/plan-mix` is the second, and it partitions THE SAME MERCHANTS BY THE SAME
 *  PLANS over the same two membership boundaries — Logo Churn prints the counts, Plan Mix prints the
 *  counts AND what they are worth. A second copy of this fold would put one merchant under Starter on
 *  one page and Pro on the other, on two cards an operator reads on the same screen, with nothing on
 *  either to say which was right.
 *
 *  ──  A HISTORICAL COLUMN MUST BE IN HISTORICAL TERMS ─────────────────────────────────────
 *
 *  This is the whole reason the function takes an instant at all. `ChargeCohortResult.by_domain` is
 *  the per-domain WINNER — the subscription with the LATEST `trial_start`, i.e. the plan the merchant
 *  is on TODAY (`resolvers/chargeCohort.resolver`). Applying that map to a 30-days-ago membership set
 *  restates the whole opening plan mix in current-plan terms: a merchant who moved from Starter to
 *  Pro twenty days ago is counted under Pro in "Active 30d ago", so Starter's opening base — and
 *  therefore its churn-rate DENOMINATOR — loses a customer it actually had, and Pro's gains one it
 *  never did. Both plans then publish a wrong churn rate, in opposite directions, and both look
 *  entirely plausible.
 *
 *  The winner here is the latest subscription that had STARTED by the instant, PREFERRING one that
 *  had not already ended by then. A domain with no subscription at or before that instant falls to
 *  the caller's unknown label and is COUNTED — never borrowed from today's plan, which is the
 *  substitution being removed.
 *
 *  ⚠️ Set MEMBERSHIP is unaffected either way — that is `liveSetAsOf`'s answer and this file never
 *  touches it. Only the bucket a shop lands in moves.
 * ============================================================================
 */

import type { CohortSubscription } from '../types/lifecycle.types';

/**
 * A `Date` only when it genuinely is one and genuinely valid.
 *
 * An Invalid Date compares FALSE in every direction, so an unvalidated one would silently read as
 * "still running" below and win a contest it should have lost.
 *
 * @param value - Anything.
 * @returns The date, or null.
 */
const _validDate = (value: unknown): Date | null => {
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
};

/**
 * The subscription that described each domain AT `at`, folded in ONE pass over the app-wide cohort.
 *
 * Subscriptions that had not started by `at` are skipped entirely — a plan a merchant moved to
 * afterwards says nothing about the plan they were on then. Among the rest, one still RUNNING at
 * `at` beats one that had already ended, however recently the ended one started; ties fall to the
 * later `trial_start`.
 *
 * @param params0 - The parameters object.
 * @param params0.subscriptions - Every subscription the resolver produced.
 * @param params0.at - The instant to describe. Never a clock read inside this function.
 * @returns Domain → the subscription that described it then.
 */
const resolvePlanAtInstant = ({
    subscriptions,
    at
}: {
    subscriptions: readonly CohortSubscription[];
    at: Date;
}): Map<string, CohortSubscription> => {
    const byDomain = new Map<string, CohortSubscription>();
    const rows: readonly CohortSubscription[] = Array.isArray(subscriptions) ? subscriptions : [];
    const atMs = at.getTime();

    /** Whether a candidate's paying relationship was still open at the instant. */
    const _liveAt = (candidate: CohortSubscription): boolean => {
        const churn = _validDate(candidate.churn_date);
        return !churn || churn.getTime() > atMs;
    };

    for (const subscription of rows) {
        if (subscription.shop_domain === '' || subscription.trial_start.getTime() > atMs) {
            continue;
        }
        const incumbent = byDomain.get(subscription.shop_domain);
        if (!incumbent) {
            byDomain.set(subscription.shop_domain, subscription);
            continue;
        }
        const challengerLive = _liveAt(subscription);
        const incumbentLive = _liveAt(incumbent);
        if (challengerLive !== incumbentLive) {
            if (challengerLive) {
                byDomain.set(subscription.shop_domain, subscription);
            }
            continue;
        }
        if (subscription.trial_start.getTime() > incumbent.trial_start.getTime()) {
            byDomain.set(subscription.shop_domain, subscription);
        }
    }

    return byDomain;
};

/**
 * The plan label for one domain, read off the map that describes the boundary it sits on.
 *
 * ⚠️ THE UNKNOWN LABEL IS THE CALLER'S, and that is not indecision. The two endpoints that call this
 * publish DIFFERENT literals for the same concept — `'Plan not recorded'` on logo churn,
 * `'(plan unknown)'` on plan mix — because `PlanMixDonut.js` tests its one as a string literal to
 * decide whether to badge a row "Re-sync to enrich". Baking either spelling in here would silently
 * break the other page; `constants/planMix.constants` carries the whole argument and the route out.
 *
 * A blank `plan_name` is treated as ABSENT rather than published as an empty string: the ledger
 * carries no plan name at all, so a subscription whose charge payload never named one is a merchant
 * we cannot file, not a merchant on a plan called "".
 *
 * @param shop_domain - The domain, or `''` when the payout rows carry none.
 * @param source - The map describing the instant being read.
 * @param unknown_label - What to publish when no subscription named a plan.
 * @returns The plan name, or the caller's unknown label — never a guess.
 */
const planNameFor = (
    shop_domain: string,
    source: Map<string, CohortSubscription>,
    unknown_label: string
): string => {
    const subscription = shop_domain ? source.get(shop_domain) : undefined;
    return subscription && subscription.plan_name !== '' ? subscription.plan_name : unknown_label;
};

export = {
    resolvePlanAtInstant,
    planNameFor
};
