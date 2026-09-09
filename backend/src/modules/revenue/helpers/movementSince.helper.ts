'use strict';

/**
 * ============================================================================
 *  HOW MRR GOT FROM ONE BALANCE TO THE OTHER
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, no clock. Both boundaries arrive as already-evaluated
 *  paying sets, so the whole of MRR movement can be exercised against two hand-built Maps with no
 *  database — which is what lets the reconciliation identity below be pinned by a unit test rather
 *  than hoped for in production.
 *
 *  ──  THE RECONCILIATION IS THE WHOLE POINT, AND IT IS ASSERTED ────────────────────────────
 *
 *      opening + new + expansion - contraction - churned  ===  closing
 *
 *  A movement panel that does not satisfy that identity is not "approximately right" — it is LYING,
 *  and it lies in the most convincing possible way: six large, plausible, individually-checkable
 *  numbers that happen not to add up, on a card whose entire purpose is to explain the difference
 *  between two figures printed directly above it. A reader who tries the arithmetic and finds it
 *  fails cannot tell WHICH of the six is wrong, so the card poisons all of them.
 *
 *  So this file does not merely compute the identity — it REFUSES TO RETURN A FOLD THAT VIOLATES IT.
 *  `foldMrrMovement` throws, the service's try/catch turns that into an honest failure envelope, and
 *  the page renders its error state. A wrong panel is worse than an absent one.
 *
 *  The identity holds by CONSTRUCTION, not by luck: every shop lands in exactly one of four
 *  mutually-exclusive cases (in both sets and up, in both and down, in both and level, in one only),
 *  and each case contributes its own difference to exactly one bucket. The assertion exists to catch
 *  the day somebody adds a fifth case, filters a bucket, or caps a list.
 *
 *  ──  EVERY COUNT IS `bucket.length` ───────────────────────────────────────────────────────
 *
 *  "If a card says 23 stores, clicking it shows 23 stores." `RevenueMovementStats` prints
 *  `movement.new_count` and makes the block clickable when it is above zero; the click opens
 *  `movement_shops.new`. Those are one number here — the counts are read off the lists that are
 *  returned — so the card and its drill-down cannot drift. A count computed by a second reduction
 *  over the same sets would be correct today and would survive any later change to either one.
 *
 *  ── CONTRACTION AND CHURN ARE PUBLISHED AS MAGNITUDES ───────────────────────────────────────
 *
 *  Positive numbers, with the direction carried by the COLUMN rather than by the sign. The frontend's
 *  `_directional` helper normalises to the magnitude and applies its own direction for exactly this
 *  reason, so a sign flip on this side can never turn a churn column green. The per-shop `delta` is
 *  signed, because there the sign IS the fact being shown.
 *
 *  ──  NET CHURN IS NOT CLAMPED AT ZERO ─────────────────────────────────────────────────────
 *
 *  When expansion outruns contraction plus churn it goes NEGATIVE, and negative net churn is the
 *  single best signal a subscription business has. Clamping hides precisely the months worth
 *  celebrating, and hides them silently — the card renders "0.0%" and reads as stagnation.
 *
 *  ── GROSS CHURN IS CANCELLATIONS **PLUS DOWNGRADES**, AND THERE IS ONLY ONE DEFINITION ────
 *
 *  This file used to publish `gross_churn_rate` as `churned / start` — cancellations only — while
 *  `modules/conversion/helpers/revenueChurn.helper` published `(churned + contraction) / start` for
 *  the metric of the SAME NAME on the Revenue → Churn tab. One month, one business, two numbers: an
 *  operator read "Gross churn 4%" on Revenue and "Gross churn rate 7%" on Revenue Churn and had no
 *  way to tell which was the business and which was the bug.
 *
 *  It was an OVERSIGHT rather than a deliberate split, and the proof sat one line below the offence:
 *  `net_churn_rate` here ALREADY subtracted expansion from `churned + contraction`, so the pair was
 *  internally inconsistent — gross measured one base's losses and net measured another's.
 *  `modules/conversion/types/revenueChurn.types` states `(churned + contraction) / start` THREE
 *  times; that is the definition, and both rates now come off one named `lostFromBase` so they
 *  cannot part company again without somebody deleting the variable.
 *
 *  ⚠️ If a future card genuinely wants cancellations-only, it must be given its OWN NAME —
 *  `cancellation_rate` — and never share this one. Two definitions under one label is the defect.
 *
 *  ──  RETENTION IS PUBLISHED, NOT LEFT AS HOMEWORK ─────────────────────────────────────────
 *
 *  GRR and NRR are `1 − rate`, and an operator who computes them by hand gets them wrong: they
 *  reach for the churn number on whichever page they had open, and — before the fix above — the two
 *  pages disagreed. Derived here so both pages inherit one arithmetic, and `null` propagates: no
 *  opening base means no churn rate, which means no retention rate either. NEVER `1`.
 * ============================================================================
 */

import revenueOverviewConstants = require('../constants/revenueOverview.constants');

import type { PayingShop } from '../types/ledgerMrr.types';
import type {
    FoldMrrMovementInput,
    MovementBuckets,
    MovementMember,
    MovementSinceInput,
    MovementSinceState,
    MrrMovementFold
} from '../types/movementSince.types';

const { MOVEMENT_SINCE_STATES } = revenueOverviewConstants;

/**
 * How much floating-point residue counts as zero drift.
 *
 * RELATIVE, not absolute: these are sums of doubles over an arbitrary number of shops, so the last
 * bits of a $4,318,220.07 closing balance are simply not there. A fixed epsilon would either fail on
 * a large business or pass on a small one that genuinely does not reconcile. Anything above this is a
 * LOGIC error — a missed case, a filtered bucket, a capped list — never rounding.
 */
const _DRIFT_TOLERANCE = 1e-6;

/**
 * A ratio, or `null` when there is no honest ratio to give.
 *
 * ⚠️ NEVER RETURNS `0` FOR AN EMPTY DENOMINATOR, and there is deliberately no `orZero` variant. A
 * window that opened with no paying base — which every "All time" window does — has no churn rate;
 * `0.0%` printed under the words "Gross churn" is a claim of perfect retention over a period in which
 * nobody was paying at all. `rate(0, 100)` is still `0`, because nobody out of a hundred leaving IS a
 * measurement.
 *
 * The same rule, and the same refusal to grow a zero-returning twin, as
 * `modules/conversion/helpers/funnelMath.helper`'s `rate` — which this module may not reach, because
 * that helper is not on the conversion barrel.
 *
 * @param numerator - The movement being measured.
 * @param denominator - The opening balance it is measured against.
 * @returns The fraction, or null when the denominator is zero or unusable.
 */
const _rate = (numerator: number, denominator: number): number | null => {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
        return null;
    }
    const value = numerator / denominator;
    return Number.isFinite(value) ? value : null;
};

/**
 * The retention rate behind a churn rate: `1 − rate`.
 *
 * ⚠️ `null` IN, `null` OUT — never `1`. A window with no opening base has no churn rate, and it has
 * no retention rate either; `100.0%` printed under "Net revenue retention" for a period in which
 * nobody was paying is the same lie as `0.0%` under "Gross churn", wearing the opposite face.
 *
 *  NOT CLAMPED, in either direction, for the same reason `net_churn_rate` is not. NRR above `1`
 * is the whole point of the number — a base that grew on its own before a single new customer — and
 * capping it at `1` would erase exactly the months worth reporting.
 *
 * @param rate - The churn rate this retention rate inverts.
 * @returns `1 - rate`, or null when the rate itself was unmeasurable.
 */
const _retention = (rate: number | null): number | null => {
    if (rate === null || !Number.isFinite(rate)) {
        return null;
    }
    return 1 - rate;
};

/**
 * Builds one bucket member from whichever endpoints the shop appears at.
 *
 * Both `PayingShop` refs are carried through rather than reduced to two amounts, because the caller
 * needs facts off the OPENING one that no summary keeps: `last_charged_at` and `billing_interval` are
 * what date a churn, and a reduction to `{ previous_mrr, mrr }` throws them away.
 */
const _member = (shopKey: string, open: PayingShop | null, close: PayingShop | null): MovementMember => {
    const previous = open ? open.monthly_amount : 0;
    const current = close ? close.monthly_amount : 0;
    return {
        shop_key: shopKey,
        // The domain from whichever end we have. A store's domain does not change between two
        // boundaries, so either is the same answer; `''` means its payout rows never carried one.
        shop_domain: (close && close.shop_domain) || (open && open.shop_domain) || '',
        previous_mrr: previous,
        mrr: current,
        delta: current - previous,
        open,
        close
    };
};

/**
 * Orders a bucket by how much money moved, biggest first.
 *
 * `|delta|` rather than the raw amount, so one comparator serves all four buckets: for `new` the
 * magnitude IS the added MRR, for `churned` it IS the lost MRR, and for the two middle buckets it is
 * the step between the endpoints — which is the figure the panel's own "Change" column shows.
 *
 * A COPY is sorted. The arrays here are built fresh, so nothing is wrong today; it is free to keep an
 * in-place sort of something another pass counted from impossible rather than merely absent. The
 * domain tie-break is what stops two equal moves reshuffling between requests — on screen, a
 * reshuffle reads as the data changing.
 */
const _sortByMagnitude = (rows: MovementMember[]): MovementMember[] => {
    return [...rows].sort((a, b) => {
        const byMagnitude = Math.abs(b.delta) - Math.abs(a.delta);
        if (byMagnitude !== 0) {
            return byMagnitude;
        }
        return a.shop_domain.localeCompare(b.shop_domain);
    });
};

/**
 * MRR movement between two paying sets, with the stores behind every figure.
 *
 *  THROWS when the reconciliation identity fails. See the file header: a movement card whose six
 * numbers do not add up to the two balances printed above it is worse than no card, because a reader
 * who checks the arithmetic cannot tell which figure to distrust. The service's try/catch turns this
 * into an honest failure rather than a plausible lie.
 *
 * ⚠️ BOTH SETS MUST BE KEYED THE SAME WAY. They are, because both come from `liveSetAsOf` over ONE
 * history array — the repository's own docstring asks for exactly that ("one read; callers evaluate
 * the as-of predicate over it for as many dates as they need"). Two sets keyed differently — one by
 * Partner shop id, one by domain — would report every store as simultaneously churned and new, which
 * reconciles perfectly and is completely wrong.
 *
 * @param params0 - See {@link FoldMrrMovementInput}.
 * @param [params0.open_set] - The paying set at the period OPEN. Undefined is empty.
 * @param [params0.close_set] - The paying set at the period CLOSE. Undefined is empty.
 * @returns The totals, the four member lists, and the reconciliation.
 */
const foldMrrMovement = ({ open_set, close_set }: FoldMrrMovementInput): MrrMovementFold => {
    const open: Map<string, PayingShop> = open_set || new Map();
    const close: Map<string, PayingShop> = close_set || new Map();

    const buckets: MovementBuckets = { new: [], expansion: [], contraction: [], churned: [] };

    let startMrr = 0;
    let endMrr = 0;
    let newMrr = 0;
    let expansionMrr = 0;
    let contractionMrr = 0;
    let churnedMrr = 0;

    // ONE pass over each set, and every figure below is taken as the pass builds the lists — never
    // from a second reduction that could later disagree with them.
    for (const [, shop] of open) {
        startMrr += shop.monthly_amount;
    }
    for (const [, shop] of close) {
        endMrr += shop.monthly_amount;
    }

    for (const [shopKey, closeShop] of close) {
        const openShop = open.get(shopKey);
        if (!openShop) {
            const member = _member(shopKey, null, closeShop);
            newMrr += member.mrr;
            buckets.new.push(member);
            continue;
        }
        const member = _member(shopKey, openShop, closeShop);
        if (member.delta > 0) {
            expansionMrr += member.delta;
            buckets.expansion.push(member);
            continue;
        }
        if (member.delta < 0) {
            // A MAGNITUDE. The card carries the direction; see the file header.
            contractionMrr += -member.delta;
            buckets.contraction.push(member);
        }
        // A shop paying the same amount at both ends moves nothing and belongs to no bucket. It is
        // still counted in both balances, which is what makes the identity hold.
    }

    for (const [shopKey, openShop] of open) {
        if (close.has(shopKey)) {
            continue;
        }
        const member = _member(shopKey, openShop, null);
        churnedMrr += openShop.monthly_amount;
        buckets.churned.push(member);
    }

    // ──  THE IDENTITY, CHECKED BEFORE ANYTHING IS PUBLISHED ───────────────
    const expectedClosing = startMrr + newMrr + expansionMrr - contractionMrr - churnedMrr;
    const drift = endMrr - expectedClosing;
    // Scaled by the magnitude being reconciled, so the check is as strict on a small business as it
    // can be and no stricter than double precision allows on a large one.
    const allowed = _DRIFT_TOLERANCE * Math.max(1, Math.abs(endMrr), Math.abs(expectedClosing));
    //  `!Number.isFinite(drift)` COMES FIRST, AND IT IS NOT BELT-AND-BRACES. A `NaN` amount anywhere
    // in either set poisons both balances, and `NaN > allowed` is FALSE — so a magnitude comparison
    // alone lets the whole fold through and publishes six `NaN`s, which render as the literal word
    // "NaN" across the movement card. That is the one failure this assertion exists to catch dressed
    // as the one value the comparison cannot see.
    if (!Number.isFinite(drift) || Math.abs(drift) > allowed) {
        throw new Error(
            'MRR movement does not reconcile: opening + new + expansion - contraction - churned must equal '
            + `closing. opening=${startMrr}, new=${newMrr}, expansion=${expansionMrr}, `
            + `contraction=${contractionMrr}, churned=${churnedMrr}, expected_closing=${expectedClosing}, `
            + `closing=${endMrr}, drift=${drift}. A movement card whose figures do not add up to the two `
            + 'balances above it is worse than no card, so this refuses rather than publishing.'
        );
    }

    //  ONE NUMERATOR FOR BOTH RATES, AND IT IS THE SAME SHAPE `revenueChurn.helper` USES.
    // Everything the OPENING base lost: cancellations plus downgrades. Computed once and named, so
    // gross and net cannot drift apart again — see the file header for what happened when they did.
    const lostFromBase = churnedMrr + contractionMrr;
    const grossChurnRate = _rate(lostFromBase, startMrr);
    //  NOT CLAMPED. Negative is the good case and must survive to the screen.
    const netChurnRate = _rate(lostFromBase - expansionMrr, startMrr);

    const sorted: MovementBuckets = {
        new: _sortByMagnitude(buckets.new),
        expansion: _sortByMagnitude(buckets.expansion),
        contraction: _sortByMagnitude(buckets.contraction),
        churned: _sortByMagnitude(buckets.churned)
    };

    return {
        totals: {
            start_mrr: startMrr,
            end_mrr: endMrr,
            new_mrr: newMrr,
            expansion_mrr: expansionMrr,
            contraction_mrr: contractionMrr,
            churned_mrr: churnedMrr,
            //  READ OFF THE LISTS. The card prints these and opens those; one number, so they
            // cannot disagree.
            new_count: sorted.new.length,
            expanded_count: sorted.expansion.length,
            contracted_count: sorted.contraction.length,
            churned_count: sorted.churned.length,
            // CANCELLATIONS **PLUS DOWNGRADES**. This was `_rate(churnedMrr, startMrr)` — the
            // cancellations-only reading — while the Revenue → Churn tab published the documented
            // `(churned + contraction) / start` under the identical label. Reverting it to
            // `churnedMrr` alone re-opens the two-definitions bug; a cancellations-only figure needs
            // its own name (`cancellation_rate`), never this one.
            gross_churn_rate: grossChurnRate,
            net_churn_rate: netChurnRate,
            //  `1 − rate`, so an operator never has to do it by hand against whichever page they
            // had open. `null` propagates; neither is ever `1` for an empty opening base.
            gross_revenue_retention_rate: _retention(grossChurnRate),
            net_revenue_retention_rate: _retention(netChurnRate)
        },
        buckets: sorted,
        reconciliation: {
            opening: startMrr,
            closing: endMrr,
            expected_closing: expectedClosing,
            drift
        }
    };
};

/**
 * What has happened to one movement row's store between the period CLOSE and NOW.
 *
 * ⚠️ A DELTA, NOT A SNAPSHOT, and only about MONEY. `STOPPED_PAYING` means "not on a paid plan today"
 * and says nothing whatever about whether the app is still installed — that is a different fact from
 * a different source, and folding the two into one badge would lend event-sourced certainty to a
 * charge-row inference while hiding the most actionable row on the panel: a store that still has the
 * app and simply stopped paying.
 *
 * ⚠️ THE AMOUNT IS COMPARED BEFORE THE PLAN NAME. A merchant on the same price under a renamed plan
 * has not upgraded, and one paying more on an identically-named plan has. Ordering these the other
 * way round would report a marketing rename as revenue movement.
 *
 * @param params0 - See {@link MovementSinceInput}.
 * @param params0.was_paying_at_close - In the paying set at the period close?
 * @param params0.amount_at_close - Its monthly amount then.
 * @param params0.plan_at_close - Its plan name then, or `''`.
 * @param params0.is_paying_now - In the paying set now?
 * @param params0.amount_now - Its monthly amount now.
 * @param params0.plan_now - Its plan name now, or `''`.
 * @returns One of the six movement-since states.
 */
const movementSinceState = ({
    was_paying_at_close,
    amount_at_close,
    plan_at_close,
    is_paying_now,
    amount_now,
    plan_now
}: MovementSinceInput): MovementSinceState => {
    if (!is_paying_now) {
        return MOVEMENT_SINCE_STATES.STOPPED_PAYING;
    }
    // Paying now, and was not at the close: the churned bucket's happiest row. Reached only from
    // that bucket, because the other three are read out of the closing set by construction.
    if (!was_paying_at_close) {
        return MOVEMENT_SINCE_STATES.RESUBSCRIBED;
    }
    if (amount_now > amount_at_close) {
        return MOVEMENT_SINCE_STATES.UPGRADED;
    }
    if (amount_now < amount_at_close) {
        return MOVEMENT_SINCE_STATES.DOWNGRADED;
    }
    // Same money. A different name is worth showing — a plan migration at an unchanged price — but
    // only once the amounts have been found equal, or a rename would read as movement.
    //
    // ⚠️ BOTH NAMES MUST BE KNOWN. `''` is "no charge event names a plan for this store", not "a
    // different plan", and the badge for `PLAN_CHANGED` reads "Still paying the same amount, but on a
    // differently named plan" — a specific claim built entirely out of an absence. With one name
    // missing and the money unchanged, the conservative reading is that nothing happened.
    if (plan_at_close !== '' && plan_now !== '' && plan_now !== plan_at_close) {
        return MOVEMENT_SINCE_STATES.PLAN_CHANGED;
    }
    return MOVEMENT_SINCE_STATES.SAME_PLAN;
};

export = {
    foldMrrMovement,
    movementSinceState
};
