'use strict';

/**
 * ============================================================================
 *  ONE SUBSCRIPTION ROW — the roster's row, restated in the paying vocabulary
 * ============================================================================
 *
 *  DOES NO I/O AND READS NO CLOCK: every input is passed in, so a row can be built from literals in
 *  a test with no database running. It lives in `resolvers/` rather than inside the service because
 *  this is where the honesty rules for a rendered row actually are, and those need to be reachable
 *  without one.
 *
 *  ──  IT PROJECTS, IT DOES NOT REBUILD ───────────────────────────────────────────────────
 *
 *  The input row came out of `resolvers/storeRow.resolver` — the SAME row `GET /api/stores` serves,
 *  from the same fold, with the same nulls in the same places. This file changes exactly three
 *  things about it, and every one of them is a consequence of the page rather than of the data:
 *
 *    1. `state` / `state_label` are DROPPED and `status` / `status_label` take their place;
 *    2. `activation_date` and `conversion_date_voided` are added, because this table has columns for
 *       them and the roster does not;
 *    3. `status_basis` is stated separately from the roster's `state_basis`, because they differ on
 *       exactly one kind of row and that is the row worth spotting.
 *
 *  Nothing else is touched. Re-deriving a money figure, a plan price or an install state here would
 *  be a second answer to a question the fold already answered, which is the whole failure this wave
 *  was written to avoid.
 *
 *  ──  WHY `state` MUST BE ABSENT AND NOT TRANSLATED ──────────────────────────────────────
 *
 *  `StoreTable._renderStatus` reads `row.state || row.status`. `state` WINS. The roster's `state` is
 *  the LIFECYCLE vocabulary (`CONVERTED`, `CHURNED_IN_TRIAL`, …); this page's tabs, facet group and
 *  CSV export all speak the SUBSCRIPTION vocabulary (`PAYING`, `CHURNED_DURING_TRIAL`, …). Leaving
 *  `state` on the row would badge a merchant "Converted" directly underneath a tab that says
 *  "Paying" — two names for one state, one column apart, on the same screen. Dropping it is what
 *  makes the badge, the tab, the chip and the export agree.
 *
 *  ──  THE ROW THE LEDGER PUT HERE AND THE EVENT RECORD CANNOT EXPLAIN ────────────────────
 *
 *  A merchant can be in the paying set with NO synced subscription event — an incremental sync whose
 *  window began after they subscribed is the ordinary cause, and `ledgerMrr.helper`'s header names
 *  precisely that case as the reason the ledger exists: *"a shop Shopify BILLED is a paying shop, no
 *  event history required."* Such a row is published as `PAYING` on the basis `settled_payout`,
 *  which is the same classification `subscriptionState.helper`'s second branch makes from the same
 *  evidence — money moved and nothing ended it.
 *
 *  It is NOT published as the lifecycle join-miss `INSTALLED` ("this store never subscribed"), which
 *  would contradict the predicate that put it in the list, and NOT as a blank, which would leave the
 *  tab counts short of `ALL` with nothing on screen to explain the gap. `ledger_only: true` marks it
 *  so the weaker footing is never silent, and its plan and activation columns stay EMPTY rather than
 *  being filled from the payout — a settled payout is not an activation date.
 * ============================================================================
 */

import conversion = require('../../conversion');
import subscriptionConstants = require('../constants/subscriptionList.constants');

import type { StateBasis } from '../../conversion/types/lifecycle.types';
import type { SubscriptionListRow, SubscriptionRowInput, SubscriptionStatus } from '../types/subscriptionList.types';

const { STATE_BASIS } = conversion;
const { SUBSCRIPTION_STATUSES, SUBSCRIPTION_STATUS_LABELS, LEDGER_ONLY_STATUS } = subscriptionConstants;

/**
 * Widened copy of the frozen label map, so a `string` status can index it without an `as` cast —
 * which this codebase reserves for the model chokepoint. Assignment widens; it re-types nothing.
 */
const _STATUS_LABELS: Readonly<Record<string, string>> = SUBSCRIPTION_STATUS_LABELS;

/**
 * Restates one roster row as a subscription row.
 *
 * @param input - The roster row, and the store's subscription if it has one.
 * @param input.row - The row `resolvers/storeRow.resolver` already built.
 * @param [input.subscription] - The winning subscription, or nothing.
 * @returns The row exactly as the Subscriptions table reads it.
 */
const resolveSubscriptionRow = ({ row, subscription }: SubscriptionRowInput): SubscriptionListRow => {
    /**
     *  THE REST SPREAD IS WHAT MAKES THE TWO ROWS THE SAME ROW, and it is the one place in this
     * codebase where a spread is the careful option rather than the lazy one. The barrels enumerate
     * their keys so a PUBLIC SURFACE stays readable; here the goal is the opposite property — that
     * this row cannot fall behind the roster's. Writing out forty fields would create a second list
     * that silently misses the next column `storeRow.resolver` gains, and the symptom would be a
     * cell that renders on the Stores page and an em dash on this one.
     *
     * The two fields that are NOT carried are named right here, which is the only part a reader has
     * to check. They are renamed to `_`-prefixed locals so the lint rule's `varsIgnorePattern`
     * recognises them as deliberately discarded.
     */
    const { state: _state, state_label: _stateLabel, ...shared } = row;

    // `lifecycle_state`, not `state`, decides whether the subscription is usable — exactly as
    // `resolveStoreRow` does. A subscription whose state lost its mapping is a defect in this build;
    // publishing its unmapped value would render a raw SCREAMING_SNAKE badge in no tab. The service
    // counts those (`unclassified_subscription_rows`) and warns.
    const usable = !!(subscription && subscription.lifecycle_state);

    // ⚠️ ANNOTATED, not inferred. Without the annotations these widen to the LITERALS `'PAYING'` and
    // `'settled_payout'`, and the branch below — the one that reads a real subscription's own state —
    // stops compiling. The default is the ledger's verdict; the type is the whole vocabulary.
    let status: SubscriptionStatus = LEDGER_ONLY_STATUS;
    let statusBasis: StateBasis = STATE_BASIS.SETTLED_PAYOUT;
    let activationDate: Date | null = null;
    if (usable && subscription) {
        status = subscription.state;
        statusBasis = subscription.state_basis;
        activationDate = subscription.trial_start;
    }

    return {
        ...shared,
        status,
        status_label: _STATUS_LABELS[status] || status,
        status_basis: statusBasis,
        //  TRUE means "the ledger knows this merchant and the event record does not", which is an
        // absence of evidence about their plan — never a free plan and never a missing trial.
        ledger_only: !usable,
        //  `null` on a ledger-only row, and NOT back-filled from `first_payment_at`. A settled
        // payout is later than the activation by however long Shopify took to settle, and this
        // column is the page's DEFAULT SORT — an invented value would reorder the whole list around
        // a date nobody measured.
        activation_date: activationDate,
        //  Requires BOTH a churn and a planned billing date. `conversion_date` is `charge.billingOn`
        // — the day billing would have begun — so a subscription that ended during the trial names a
        // date that never happened, and the table strikes it through rather than hiding it. With no
        // `conversion_date` there is nothing to strike, so this stays false rather than becoming a
        // claim about a date the row does not carry.
        conversion_date_voided: status === SUBSCRIPTION_STATUSES.CHURNED_DURING_TRIAL && row.conversion_date !== null,
        // The roster's own provenance, carried alongside rather than overwritten. The two differ
        // ONLY on a ledger-only row (`join_miss` here, `settled_payout` above), which is precisely
        // the row a reader wants to be able to pick out.
        roster_state_basis: row.state_basis
    };
};

export = {
    resolveSubscriptionRow
};
