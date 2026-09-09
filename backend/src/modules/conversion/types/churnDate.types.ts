/**
 * Shapes for `helpers/churnDate.helper` — the one derivation of "when did this shop stop paying".
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 * `ChurnDateBasis` is NOT redeclared here. It is derived from `../constants/logoChurn.constants` in
 * `./logoChurn.types` and re-exported through it, because one wire value with two declarations is
 * one value with two spellings — and both churn endpoints publish this field.
 */

import type { ChurnDateBasis } from './logoChurn.types';

/** What `resolveChurnDate` needs in order to date one shop's exit. Every input is the caller's. */
export interface ResolveChurnDateInput {
    /**
     * The shop's FIRST settled subscription payout — when it started paying us.
     *
     * ⚠️ THE LOWER BOUND OF THE INTERVAL A DATED EVENT MUST FALL INSIDE, and it is the first payout
     * rather than the last on purpose: Shopify settles in arrears, so a merchant who cancels on the
     * 10th can have a final payout settle on the 25th, and a real cancellation is routinely EARLIER
     * than the ledger-derived instant. Bounding at the last payout would reject the true date.
     */
    activated_at: Date;
    /** The newest settled payout at or before the boundary that judged the shop to be paying. */
    last_charged_at: Date;
    /**
     * How long that payout keeps the shop live, in days — `liveWindowDaysFor(interval, windowDays)`.
     *
     * ⚠️ PASSED IN, never derived here. Reaching `modules/revenue` from a pure helper would pull the
     * model registry in at import and cost this file its testability; the caller already holds the
     * cadence and the configured window, and computing it there is what keeps the derived date and
     * the predicate that produced it in step.
     */
    live_window_days: number;
    /** A dated cancellation event, when the subscription side has one. `null` otherwise. */
    event_churn_date: Date | null;
    /** The judgement instant. Membership cannot end after the moment that judged it. */
    as_of: Date;
}

/** One shop's exit, and which evidence produced it. */
export interface ResolvedChurnDate {
    /** When membership ended. ⚠️ Read `basis` before quoting it — see `ChurnDateBasis`. */
    churned_at: Date;
    /** `partner_event` for a real cancellation, `ledger_window` for the derived boundary. */
    basis: ChurnDateBasis;
}
