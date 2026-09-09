'use strict';

/**
 * ============================================================================
 *  WHAT IS THIS SUBSCRIPTION, AS OF A GIVEN INSTANT?
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, and — the one that matters most here — NO CLOCK.
 *  `as_of` is a parameter on every function that needs it, so the same subscription classifies
 *  identically on a re-run, inside a test, and when a caller asks for a historical window.
 *
 *  ──  THE TWO-BRANCH MACHINE, AND WHY THE SECOND BRANCH EXISTS ────────────────────────────────
 *
 *  The system this was ported from resolved a trial end from a five-tier ladder that read its own
 *  `ApplicationCharge` and `BillingPlan` tables. NEITHER EXISTS HERE — `grep -rn
 *  "ApplicationCharge\|BillingPlan"` across this repo returns only doc comments. Four of the five
 *  tiers are therefore gone, and porting the machine verbatim produces two separate catastrophes:
 *
 *   1. `Number(charge && charge.trial_days)` on a NULL charge coerces to `0`, hits the
 *      "explicit no-trial" branch, and marks every subscription PAYING from the instant it started
 *      — a ~100% trial-to-paid rate that looks entirely plausible. Not ported.
 *
 *   2. `classifyAsOf` with `conversion_date === null` FALLS THROUGH TO `CHURNED_AFTER_TRIAL`
 *      for every churned store. That claims a conversion AND a lost customer for a merchant who
 *      never paid us a cent — it inflates trial-to-paid and it inflates paid churn, from the same
 *      row, in the same pass. The second branch below replaces that fall-through.
 *
 *  The replacement is EVIDENCE, not an assumption: a settled `APP_SUBSCRIPTION` payout means money
 *  actually moved. `gi_partner_app_transactions.charge_id` and `gi_partner_app_events.charge_id`
 *  are both normalised to the same bare numeric form on write (`shared/helpers/chargeId.helper`),
 *  and `idx_app_charge` serves the join, so "did this subscription ever settle" is a lookup rather
 *  than a guess. Only the last branch of the four guesses at all, it guesses CONSERVATIVELY (it
 *  never claims revenue), and it must be counted and pushed into `warnings[]` by its caller.
 *
 *  ──  THERE IS NO `DEFAULT_TRIAL_DAYS = 7` ─────────────────────────────────────────────────
 *  `trial_end` is a RENDERED COLUMN. An assumed date sits in the table beside real ones, in the same
 *  format, with nothing to mark it, and a reader plans around it. Absent evidence produces `null`,
 *  which renders as an em dash. Do not reintroduce the fallback to "fill the column".
 * ============================================================================
 */

import chargeIdHelper = require('../../shared/helpers/chargeId.helper');
import lifecycleConstants = require('../constants/lifecycle.constants');

import type {
    ClassifiedSubscription,
    ClassifyAsOfInput,
    ChargeLinkState,
    PartnerChargePayload,
    ResolvedTrialEnd,
    StoreLifecycleState
} from '../types/lifecycle.types';

const { extractChargeNumericId } = chargeIdHelper;
const {
    SUBSCRIPTION_STATES,
    SUBSCRIPTION_STATE_TO_LIFECYCLE,
    STATE_BASIS,
    TRIAL_DAYS_SOURCES,
    CHARGE_LINK_STATES
} = lifecycleConstants;

/** The empty charge payload — one literal, so "no charge block" cannot be spelled two ways. */
const _NO_CHARGE: PartnerChargePayload = Object.freeze({
    charge_id: '',
    billing_on: null,
    plan_name: '',
    plan_price: null,
    currency: '',
    test: false,
    present: false
});

/**
 * A `Date` from a Partner-payload timestamp, or `null`.
 *
 * ⚠️ NOT a replacement for `shared/helpers/dateRange.helper`, which parses a caller's `YYYY-MM-DD`
 * query parameter into calendar-day boundaries. That is a different job with different rules; this
 * one only re-hydrates a value Shopify or mongoose already produced (a `Date` from `.lean()`, an
 * ISO string or a `Date` scalar off `raw_event`).
 *
 * An unparseable value is `null`, never "now" and never epoch zero — a date we could not read is
 * unknown, and 1970 sorts to the top of an "oldest first" list as though it were real.
 *
 * @param value - A Date, an ISO string, a `YYYY-MM-DD` string, or an epoch number.
 * @returns The instant, or null when it could not be read.
 */
const toDate = (value: unknown): Date | null => {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === 'number') {
        const fromNumber = new Date(value);
        return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
    }
    if (typeof value !== 'string') {
        return null;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * A finite number, or `null`.
 *
 * ⚠️ `null` for an empty string and for null/undefined, so a missing price cannot become `0` — a
 * `0` price is a real, renderable claim ("this plan is free"), and the money sub-line is gated on
 * `Number.isFinite`, which `0` passes.
 *
 * @param value - Anything off a raw payload, including a GraphQL Decimal string.
 */
const _toFiniteNumber = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

/** A `Date` only when it is genuinely one and genuinely valid. Used on every comparison boundary. */
const _validDate = (value: unknown): Date | null => {
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
};

/**
 * Reads the `charge { … }` block off a Partner event into the five fields this build consumes.
 *
 * The Partner API's `AppSubscription` has exactly five fields — `amount`, `billingOn`, `id`, `name`,
 * `test` — and the sync already requests all five, so there is nothing left to extract. They live
 * ONLY inside the Mixed `raw_event`, which is why the cohort's event pull must keep it projected.
 *
 * `charge.id` goes through `shared/helpers/chargeId.helper` rather than a local regex: it is one of
 * the module's three join bridges, and the loose "last run of digits anywhere" variant returns `'0'`
 * for `.../12345?index=0` and passes an unparseable string straight through, which then matches
 * nothing in an `$in` without ever erroring.
 *
 * @param [rawEvent] - A `raw_event` payload, or nothing.
 * @returns Always a full object; `present: false` when there was no charge block.
 */
const readPartnerCharge = (rawEvent?: Record<string, any> | null): PartnerChargePayload => {
    if (!rawEvent || typeof rawEvent !== 'object') {
        return { ..._NO_CHARGE };
    }
    const charge = (rawEvent as Record<string, any>).charge;
    if (!charge || typeof charge !== 'object') {
        return { ..._NO_CHARGE };
    }

    const amount = charge.amount && typeof charge.amount === 'object' ? charge.amount : null;

    return {
        charge_id: extractChargeNumericId(charge.id) || '',
        // Shopify's own first-billing date, in practice carried by the ACTIVATED event (ACCEPTED
        // carries it on 0 of 13 real occurrences; ACTIVATED on 1,632 of 1,632).
        //
        // A FIRST-BILLING DATE, NOT A PROVEN TRIAL END. The gap to it is bimodal and no stored
        // field says which mode a row is in — see `FIDELITY.md` §5. Still preferred over inferring a
        // length from an event gap, which would invent a number for every charge that never
        // activated; the caveat rides on the published figure instead.
        billing_on: toDate(charge.billingOn),
        plan_name: charge.name === null || charge.name === undefined ? '' : String(charge.name).trim(),
        plan_price: amount ? _toFiniteNumber(amount.amount) : null,
        // ⚠️ `currencyCode` is the RAW Partner payload's spelling. The sync renames it to `currency`
        // on the way into `net_amount`/`gross_amount`, so a stored money subdoc reads `currency` and
        // this one does not. Both are accepted here rather than assuming which side a caller holds.
        currency: amount ? String(amount.currencyCode || amount.currency || '').trim() : '',
        // `=== true` only. An ABSENT flag is not evidence the charge is live — it is evidence
        // nobody told us. The distinction matters because the exclusion built on it is asymmetric:
        // relationship events carry no test flag at all, so the install spine still contains test
        // stores while the subscription side has dropped them.
        test: charge.test === true,
        present: true
    };
};

/**
 * The trial end, and where it came from.
 *
 * There is exactly one source: Shopify's `charge.billingOn`, which IS the date the trial ends and
 * billing begins. Where Shopify sent none, the answer is `null` and the source records that.
 *
 * Do not add a `trial_start + N days` branch. See the file header.
 *
 * @param [conversionDate] - `charge.billingOn`, already parsed.
 * @returns The date (or null) and the source that produced it.
 */
const resolveTrialEnd = (conversionDate?: Date | null): ResolvedTrialEnd => {
    const billingOn = _validDate(conversionDate);
    if (billingOn) {
        return { trial_end: billingOn, trial_days_source: TRIAL_DAYS_SOURCES.PARTNER_BILLING_ON };
    }
    return { trial_end: null, trial_days_source: TRIAL_DAYS_SOURCES.NONE };
};

/**
 * How well this subscription is linked to a charge payload.
 *
 * Redefined against the upstream meaning because this build has no `ApplicationCharge` table to
 * resolve an id AGAINST: `resolved` means the payload carried a usable `billingOn`, which is the
 * fact the trial ladder actually consumes. That keeps the operator-facing sentence at
 * `PartnerFunnelChart.js:133-152` true with no frontend change.
 *
 * ⚠️ A charge block carrying a `billingOn` whose `id` failed to parse lands in `absent`. That is the
 * spec's own ordering and it is left as-is: the case is vanishing (Shopify always sends an id with a
 * charge), and no trial-end date is lost by it — the row's own `trial_days_source` still records the
 * date as measured. Only this diagnostic's bucketing is coarse there.
 *
 * @param chargeId - The bare numeric charge id, or `''`.
 * @param [billingOn] - `charge.billingOn`, already parsed.
 * @returns `resolved` | `unresolved` | `absent`.
 */
const resolveChargeLinkState = (chargeId: unknown, billingOn?: Date | null): ChargeLinkState => {
    if (!chargeId || String(chargeId) === '') {
        return CHARGE_LINK_STATES.ABSENT;
    }
    if (_validDate(billingOn)) {
        return CHARGE_LINK_STATES.RESOLVED;
    }
    return CHARGE_LINK_STATES.UNRESOLVED;
};

/**
 * The as-of state machine. Two branches, four outcomes each.
 *
 *     if (churn && churn > as_of) churn = null;          // not yet, from here
 *
 *     conversion_date KNOWN                                        basis = 'billing_on'
 *         churn && churn <= conversion_date  -> CHURNED_DURING_TRIAL
 *         churn                              -> CHURNED_AFTER_TRIAL
 *         conversion_date > as_of            -> ON_TRIAL
 *         else                               -> PAYING
 *
 *     conversion_date UNKNOWN
 *         churn &&  ever_settled -> CHURNED_AFTER_TRIAL          basis = 'settled_payout'
 *         churn && !ever_settled -> CHURNED_DURING_TRIAL         basis = 'settled_payout'
 *        !churn &&  ever_settled -> PAYING                       basis = 'settled_payout'
 *        !churn && !ever_settled -> ON_TRIAL                     basis = 'inferred'   ⚠️ warn
 *
 * The churn clamp comes first and applies to both branches: an end event later than the judgement
 * instant has not happened yet from this window's point of view, and letting it through would churn
 * a store retroactively in every historical view.
 *
 * THROWS on an invalid `as_of`, rather than defaulting. There is no honest default for the
 * judgement instant — substituting `new Date()` would make a pure helper read the clock and would
 * make a historical window silently answer as of today. Validate `as_of` ONCE at the resolver's
 * entry (it does) so this can never fire mid-fold.
 *
 * @param input - Conversion date, churn date, settled-payout count, and `as_of`.
 * @returns The state, the evidence behind it, and the clamped churn date.
 */
const classifyAsOf = (input: ClassifyAsOfInput): ClassifiedSubscription => {
    const asOf = _validDate(input && input.as_of);
    if (!asOf) {
        throw new TypeError('classifyAsOf requires a valid `as_of` Date — there is no default judgement instant.');
    }

    let churn = _validDate(input.churn_date);
    if (churn && churn.getTime() > asOf.getTime()) {
        churn = null;
    }

    const conversion = _validDate(input.conversion_date);

    if (conversion) {
        if (churn && churn.getTime() <= conversion.getTime()) {
            // Ended on or before the day billing would have started: this merchant never paid us.
            return {
                state: SUBSCRIPTION_STATES.CHURNED_DURING_TRIAL,
                state_basis: STATE_BASIS.BILLING_ON,
                churn_date: churn
            };
        }
        if (churn) {
            return {
                state: SUBSCRIPTION_STATES.CHURNED_AFTER_TRIAL,
                state_basis: STATE_BASIS.BILLING_ON,
                churn_date: churn
            };
        }
        if (conversion.getTime() > asOf.getTime()) {
            return {
                state: SUBSCRIPTION_STATES.ON_TRIAL,
                state_basis: STATE_BASIS.BILLING_ON,
                churn_date: null
            };
        }
        return {
            state: SUBSCRIPTION_STATES.PAYING,
            state_basis: STATE_BASIS.BILLING_ON,
            churn_date: null
        };
    }

    // ── conversion date unknown: the branch the upstream machine did not have ──
    // `> 0` on a count, not a truthiness test on an object: `0` here is a real measurement — money
    // provably did not move — which is what makes this branch evidence rather than a guess.
    const everSettled = Number(input.settled_payout_count || 0) > 0;

    if (churn) {
        return {
            state: everSettled ? SUBSCRIPTION_STATES.CHURNED_AFTER_TRIAL : SUBSCRIPTION_STATES.CHURNED_DURING_TRIAL,
            state_basis: STATE_BASIS.SETTLED_PAYOUT,
            churn_date: churn
        };
    }
    if (everSettled) {
        return {
            state: SUBSCRIPTION_STATES.PAYING,
            state_basis: STATE_BASIS.SETTLED_PAYOUT,
            churn_date: null
        };
    }
    // The only guess in the machine, and it is the conservative one: a live subscription with no
    // billing date and no settled money is booked ON_TRIAL, which claims no revenue and no loss.
    // ⚠️ The caller MUST count these and say so in `warnings[]`.
    return {
        state: SUBSCRIPTION_STATES.ON_TRIAL,
        state_basis: STATE_BASIS.INFERRED,
        churn_date: null
    };
};

/**
 * Subscription state → the lifecycle state the table renders.
 *
 * RETURNS `null` FOR AN UNRECOGNISED STATE — never `INSTALLED`. `INSTALLED` means "this store has
 * no subscription we can find"; defaulting an unmapped subscription state to it would report a
 * PAYING CUSTOMER AS NEVER HAVING SUBSCRIBED, which is the exact regression the upstream unit test
 * `installCohort.test.js:145-184` was written to pin. A `null` renders as an em dash and stays out
 * of every `by_state` tally, which is the honest shape for "we have a subscription and cannot name
 * its state".
 *
 * The map is proved TOTAL over `SUBSCRIPTION_STATES` at compile time by
 * `AssertEverySubscriptionStateIsMapped` in `types/lifecycle.types.ts`, so in practice this returns
 * null only for a value that was cast past the type system or read back off an old document.
 *
 * @param state - A subscription state key.
 * @returns The lifecycle state, or null when the key is not mapped.
 */
const toLifecycleState = (state: unknown): StoreLifecycleState | null => {
    const key = String(state === null || state === undefined ? '' : state);
    const map = SUBSCRIPTION_STATE_TO_LIFECYCLE as Record<string, StoreLifecycleState>;
    return map[key] || null;
};

export = {
    toDate,
    readPartnerCharge,
    resolveTrialEnd,
    resolveChargeLinkState,
    classifyAsOf,
    toLifecycleState
};
