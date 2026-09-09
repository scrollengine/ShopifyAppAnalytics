'use strict';

/**
 * ============================================================================
 *  WHEN A SHOP STOPPED PAYING — ONE DERIVATION, FOR BOTH CHURN PAGES
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, and NO CLOCK: `as_of` and the live window both
 *  arrive as parameters, so one row dates identically on a re-run, inside a test, and on either
 *  endpoint that calls it.
 *
 *  ──  WHY THIS IS A FILE AND NOT A BLOCK INSIDE ONE SERVICE ────────────────────────────────
 *
 *  It WAS a block inside `services/logoChurn.service`, and it stayed correct only while there was
 *  one caller. `GET /api/conversion/revenue-churn` is the second, and it lists THE SAME MERCHANTS
 *  LEAVING — Logo Churn counts them, Revenue Churn prices them. A second copy of this derivation
 *  would put two different churn dates on one merchant on two pages the operator reads side by side,
 *  with nothing on either screen to say which was right. That is precisely the divergence
 *  `modules/revenue/index.ts` records from the system this was extracted from, reached through a
 *  DATE rather than through an amount.
 *
 *  ── THE TWO BASES, AND WHY ONE OF THEM IS NOT A CANCELLATION DATE ───────────────────────────
 *
 *  A dated cancellation event is the real answer and is PREFERRED. It is accepted only when it sits
 *  inside the interval this row can vouch for — at or after the shop's FIRST settled payout, and at
 *  or before the judgement instant — because a shop that cancelled, resubscribed and churned again
 *  carries an OLD cancellation on its per-domain winner, and publishing that would date the row
 *  before the paying relationship it describes had begun.
 *
 *  ⚠️ THE LOWER BOUND IS THE FIRST PAYOUT, NOT THE LAST, so a `partner_event` date can legitimately
 *  sit EARLIER than the ledger-derived one. That is the ordinary shape rather than a defect: Shopify
 *  settles payouts in arrears, so a merchant who uninstalls on the 10th can have a final payout
 *  settle on the 25th, and ledger MEMBERSHIP then runs on for a live window past that.
 *
 *  Otherwise the instant the last settled payout aged out of the live window. ⚠️ That is NOT a
 *  cancellation date and must never be read as one — the payout ledger cannot date a cancellation,
 *  only the moment membership ended. It is always the LATER of the two, so a duration measured from
 *  it OVER-states how long the shop paid, and `basis` is published on the row so a reader can tell.
 *
 *  ──  THE CLAMP IS LOAD-BEARING, AND IT WAS ADDED AFTER A MEASURED DEFECT ──────────────────
 *
 *  The caller hands in the shop as it stood at the OPENING boundary, so `last_charged_at` is its
 *  newest payout at or before THAT instant — a different row from the one that decided the shop had
 *  left at `as_of`. Whenever a shop left through `liveSetAsOf`'s tombstone branch (`row.gross <= 0`)
 *  rather than by aging out, `last_charged_at + live window` lands AFTER `as_of`: a $0 or negative
 *  row — a 100%-discounted subscription charge, a negative adjustment filed under `APP_SUBSCRIPTION`,
 *  or an amount that failed to parse and stored as 0 — ends membership at a date the newest payout
 *  never reached.
 *
 *  Verified before the clamp existed: two rows for one shop, +29 at now-34d and -29 at now-5d,
 *  published a churn date FOUR DAYS IN THE FUTURE with a paid duration of 38 days over payouts
 *  spanning 34 — a future date in a table captioned "recently churned". Membership cannot end after
 *  the instant that judged it, so the derived date is capped there.
 *
 *  A NO-OP ON THE AGING-OUT PATH: there `last_charged_at + live window < as_of` by construction,
 *  which is what made the shop absent from the closing set at all.
 * ============================================================================
 */

import logoChurnConstants = require('../constants/logoChurn.constants');

import type { ResolveChurnDateInput, ResolvedChurnDate } from '../types/churnDate.types';

const { CHURN_DATE_BASES } = logoChurnConstants;

/** Milliseconds in a day. One literal, so the window conversion is not spelled a second way. */
const _DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A `Date` only when it genuinely is one and genuinely valid.
 *
 * An Invalid Date compares FALSE in every direction, so an unvalidated one would silently fail the
 * acceptance test below and fall through to the ledger boundary — a wrong basis on a row whose
 * evidence was actually present.
 *
 * @param value - Anything.
 * @returns The date, or null.
 */
const _validDate = (value: unknown): Date | null => {
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
};

/**
 * When one shop's paying relationship ended, and which evidence says so.
 *
 * @param params0 - See {@link ResolveChurnDateInput}.
 * @param params0.activated_at - The shop's FIRST settled subscription payout.
 * @param params0.last_charged_at - Its newest payout at or before the opening boundary.
 * @param params0.live_window_days - How long that payout keeps it live, cadence-aware.
 * @param params0.event_churn_date - A dated cancellation, when one exists.
 * @param params0.as_of - The judgement instant. Nothing may be dated after it.
 * @returns The instant, and the basis it came from.
 */
const resolveChurnDate = ({
    activated_at,
    last_charged_at,
    live_window_days,
    event_churn_date,
    as_of
}: ResolveChurnDateInput): ResolvedChurnDate => {
    const eventChurn = _validDate(event_churn_date);
    if (eventChurn
        && eventChurn.getTime() >= activated_at.getTime()
        && eventChurn.getTime() <= as_of.getTime()) {
        return { churned_at: eventChurn, basis: CHURN_DATE_BASES.PARTNER_EVENT };
    }

    //  CLAMPED TO THE JUDGEMENT INSTANT — see the file header for the row that shipped without it.
    const aged = last_charged_at.getTime() + live_window_days * _DAY_MS;
    return {
        churned_at: new Date(Math.min(aged, as_of.getTime())),
        basis: CHURN_DATE_BASES.LEDGER_WINDOW
    };
};

export = {
    resolveChurnDate
};
