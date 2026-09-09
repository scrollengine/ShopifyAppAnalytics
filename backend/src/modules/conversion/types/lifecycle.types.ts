/**
 * The value unions of `../constants/lifecycle.constants`, and the shapes the pure lifecycle layer
 * passes between its own functions.
 *
 * Declarations only — `typeof import(…)` is erased at compile time, so importing this file costs
 * nothing at run time and does NOT pull the constants module in.
 *
 * The unions live here rather than beside the values because `lifecycle.constants` ends in an export
 * assignment — which is what keeps its runtime surface a plain CommonJS object — and a module with
 * an export assignment cannot export anything else, types included (TS2309). Each union is derived
 * from `typeof` rather than restated, so a new member widens it automatically instead of leaving a
 * hand-written copy one member short.
 *
 *     import type { StoreLifecycleState } from '../types/lifecycle.types';
 */

type LifecycleConstants = typeof import('../constants/lifecycle.constants');

// ── Vocabulary unions ───────────────────────────────────────────────────────

/** One of the five states the install-cohort table renders. */
export type StoreLifecycleState =
    LifecycleConstants['STORE_LIFECYCLE_STATES'][keyof LifecycleConstants['STORE_LIFECYCLE_STATES']];

/** What one SUBSCRIPTION resolved to. Deliberately has no `INSTALLED` member. */
export type SubscriptionState =
    LifecycleConstants['SUBSCRIPTION_STATES'][keyof LifecycleConstants['SUBSCRIPTION_STATES']];

/** Which evidence produced a subscription state: `billing_on` | `settled_payout` | `inferred`. */
export type StateBasis = LifecycleConstants['STATE_BASIS'][keyof LifecycleConstants['STATE_BASIS']];

/** Where a rendered `trial_end` came from. There is no "assumed" member, on purpose. */
export type TrialDaysSource =
    LifecycleConstants['TRIAL_DAYS_SOURCES'][keyof LifecycleConstants['TRIAL_DAYS_SOURCES']];

/** How well a subscription is linked to its charge payload. */
export type ChargeLinkState =
    LifecycleConstants['CHARGE_LINK_STATES'][keyof LifecycleConstants['CHARGE_LINK_STATES']];

/** One of the eight coarse acquisition channels. */
export type AcquisitionChannel =
    LifecycleConstants['ACQUISITION_CHANNELS'][keyof LifecycleConstants['ACQUISITION_CHANNELS']];

/** Why attribution may be missing: `READY` | `NOT_CONNECTED` | `NEVER_SYNCED`. */
export type AttributionState =
    LifecycleConstants['ATTRIBUTION_STATES'][keyof LifecycleConstants['ATTRIBUTION_STATES']];

/** The partner tier's own state — the install spine. `READY` | `NEVER_SYNCED`. */
export type CohortDataState =
    LifecycleConstants['COHORT_DATA_STATES'][keyof LifecycleConstants['COHORT_DATA_STATES']];

/** A member of the sort allowlist. Widened to `string` because the constant is a `string[]`. */
export type InstallCohortSortKey = 'installed_at' | 'shop_domain' | 'state' | 'channel' | 'source';

/** Sort direction. Nulls sort LAST in both, because a missing date is not "earliest". */
export type SortDirection = 'asc' | 'desc';

// ── Compile-time proofs of the two invariants ───────────────────────────────

/** Fails to instantiate unless `T` is exactly `true`. The mechanism behind both assertions below. */
type Assert<T extends true> = T;

/**
 * COMPILE-TIME PROOF THAT EVERY SUBSCRIPTION STATE HAS A LIFECYCLE MAPPING.
 *
 * Add a member to `SUBSCRIPTION_STATES` without adding it to `SUBSCRIPTION_STATE_TO_LIFECYCLE` and
 * this alias fails with "Type 'false' does not satisfy the constraint 'true'" — at build time, in
 * this file, naming the problem. Without it the gap surfaces as an `undefined` lookup that a caller
 * defaults to `INSTALLED`, i.e. a paying customer reported as never having subscribed.
 *
 * Exported so `noUnusedLocals` cannot delete the guard as dead weight.
 */
export type AssertEverySubscriptionStateIsMapped = Assert<
    [SubscriptionState] extends [keyof LifecycleConstants['SUBSCRIPTION_STATE_TO_LIFECYCLE']] ? true : false
>;

/**
 * COMPILE-TIME PROOF THAT `INSTALLED` IS UNREACHABLE FROM ANY SUBSCRIPTION STATE.
 *
 * `INSTALLED` is the LEFT-JOIN MISS and nothing else. The moment a mapping points at it, a store we
 * classified from a real subscription lands in the "Installed only" box — the one state that asserts
 * the store never subscribed at all.
 */
export type AssertInstalledIsJoinMissOnly = Assert<
    'INSTALLED' extends LifecycleConstants['SUBSCRIPTION_STATE_TO_LIFECYCLE'][keyof LifecycleConstants['SUBSCRIPTION_STATE_TO_LIFECYCLE']]
        ? false
        : true
>;

// ── Acquisition classification ──────────────────────────────────────────────

/**
 * What the channel classifier reads off one attribution row.
 *
 * Declared STRUCTURALLY, and every field optional, so a `.lean()` `ListingInstallAttributionDoc`
 * satisfies it without this module depending on the document type — and so a caller holding a
 * partial row (a `$group` projection, say) can classify without inventing the missing fields.
 */
export interface AttributionSignal {
    /** The analytics `source`. `''` / `(unattributed)` / `(not set)` all mean UNKNOWN, never DIRECT. */
    source?: string | null;
    /** The analytics `medium`. Only consulted once surface and source have both declined to answer. */
    medium?: string | null;
    /** App Store `surface_type`. Surface WINS over referrer — it is first-hand, the referrer is not. */
    surface_type?: string | null;
    /**
     * The `surface_detail` that came with it. ⚠️ Load-bearing for the paid test, not decoration:
     * `home` + `homepage-ads` is an ad placement whose surface name does not say so.
     */
    surface_detail?: string | null;
}

// ── Subscription state machine ──────────────────────────────────────────────

/**
 * The `charge { … }` block off a Partner event, read into the five fields this build consumes.
 *
 * The Partner API's `AppSubscription` has exactly five fields — `amount`, `billingOn`, `id`, `name`,
 * `test` — and the sync already requests all five, so there is nothing further to extract.
 */
export interface PartnerChargePayload {
    /** Bare numeric charge id via `shared/helpers/chargeId.helper`. `''` when absent or unparseable. */
    charge_id: string;
    /**
     * `charge.billingOn` — the date Shopify itself says billing begins.
     * `null` when Shopify sent none. Never inferred from an ACCEPTED→ACTIVATED gap.
     *
     * ⚠️ IT ARRIVES ON `ACTIVATED`, NOT ON `ACCEPTED`, whatever the older comments in this module
     * say. Measured on a live operator database of 38,719 events: `SUBSCRIPTION_CHARGE_ACCEPTED`
     * fired 13 times and carried `billingOn` ZERO times; `SUBSCRIPTION_CHARGE_ACTIVATED` fired 1,632
     * times and carried it 1,632 times.
     *
     * AND IT IS NOT A TRIAL LENGTH. The gap from the announcing event to this date is bimodal on
     * that same database — ~854 charges at 6–7 days, ~547 at 29–30, and 23 NEGATIVE — with the same
     * plan names in both bands. The charge object has exactly five keys and there is no `trialDays`
     * on it or anywhere in the Partner API's `AppSubscription`, so a 30-day trial and a no-trial
     * subscription whose first billing is one cycle out are INDISTINGUISHABLE here. See
     * `FIDELITY.md` §5 and `CohortSubscription.billing_on_gap_days`.
     */
    billing_on: Date | null;
    /** `charge.name`, the plan as Shopify renders it. `''` when absent. */
    plan_name: string;
    /** `charge.amount.amount`. `null` when absent — never `0`, which is a real price. */
    plan_price: number | null;
    /** `charge.amount.currencyCode`. ⚠️ the RAW payload spelling; stored money subdocs say `currency`. */
    currency: string;
    /** `charge.test === true` only. An absent flag is NOT evidence the charge is live. */
    test: boolean;
    /** Whether a `charge` block was present at all. Separates "no charge" from "charge with no id". */
    present: boolean;
}

/** What `resolveTrialEnd` answers: the date, and where it came from. */
export interface ResolvedTrialEnd {
    /** `null` when Shopify supplied no `billingOn`. Renders as an em dash. Never an assumed date. */
    trial_end: Date | null;
    trial_days_source: TrialDaysSource;
}

/**
 * Everything the as-of state machine needs. `as_of` is a PARAMETER because a helper may not read
 * the clock: the same subscription must classify identically on a re-run and inside a test.
 */
export interface ClassifyAsOfInput {
    /** `charge.billingOn`, or `null` when unknown. Its presence chooses the machine's branch. */
    conversion_date?: Date | null;
    /** The first end event at or after this subscription's start, or `null`. */
    churn_date?: Date | null;
    /**
     * Settled `APP_SUBSCRIPTION` payouts observed for this subscription. `0` is a real measurement
     * ("money provably did not move"), which is what makes the settled-payout branch evidence
     * rather than a guess.
     */
    settled_payout_count?: number;
    /** The instant every comparison is made against. Required — there is no default clock here. */
    as_of: Date;
}

/** What the as-of state machine answers. */
export interface ClassifiedSubscription {
    state: SubscriptionState;
    /** ⚠️ Warn on `inferred`. It is the one branch that assumes rather than measures. */
    state_basis: StateBasis;
    /** The churn date AFTER clamping to `as_of` — a churn later than the judgement instant is not yet. */
    churn_date: Date | null;
}

// ── The charge cohort ───────────────────────────────────────────────────────

/**
 * One raw event row as the cohort resolver consumes it.
 *
 * Structural on purpose: a `.lean()` `PartnerAppEventDoc` satisfies it as-is, and so does a hand-built
 * fixture in a test with no database.
 */
export interface ChargeCohortEventRow {
    event_type: string;
    /** NORMALISED ON WRITE. Match it directly — do NOT normalise a stored value a second time. */
    shop_domain?: string | null;
    /** The bare numeric charge id, already normalised on write. `''` means "not about a charge". */
    charge_id?: string | null;
    occurred_at: Date | string | number;
    /** The untouched Partner node. `billingOn`, `name`, `amount` and `test` live nowhere else. */
    raw_event?: Record<string, any> | null;
}

/** What `resolveChargeCohortForDomains` is handed. Every input is DATA — this resolver does no I/O. */
export interface ChargeCohortInput {
    /** START and END events for the apps/domains of interest, in any order. */
    events: readonly ChargeCohortEventRow[];
    /** The judgement instant. Bound the FETCH at this too, or a future event will classify a past row. */
    as_of: Date;
    /** Charge ids (bare numeric) with at least one settled `APP_SUBSCRIPTION` payout. */
    settled_charge_ids?: Iterable<string> | null;
    /**
     * Shop domains with at least one settled `APP_SUBSCRIPTION` payout — the coarser fallback used
     * only for a subscription that carries no charge id at all.
     */
    settled_domains?: Iterable<string> | null;
    /**
     * When supplied, only these domains are folded — the install spine. Needles are normalised
     * through `shared/helpers/shopDomain.helper` before comparison (idempotent, so a caller passing
     * already-canonical values loses nothing).
     */
    domains?: Iterable<string> | null;
}

/** One SUBSCRIPTION — a charge bucket, not a store. A store with two subscriptions has two of these. */
export interface CohortSubscription {
    /** `chg:<charge_id>`, else `shop:<shop_domain>`. Never a pooled key — see the resolver header. */
    bucket_key: string;
    /** `''` when the bucket is shop-keyed. */
    charge_id: string;
    /** Already-canonical. `''` is possible and means the event carried no shop. */
    shop_domain: string;
    /** Earliest START event in the bucket. */
    trial_start: Date;
    /** `charge.billingOn`, else `null`. Never `trial_start + 7 days`. */
    conversion_date: Date | null;
    /** The same instant as `conversion_date` — Shopify's `billingOn` IS the trial end. */
    trial_end: Date | null;
    trial_days_source: TrialDaysSource;
    /** First end event at or after `trial_start`, clamped to `as_of`. */
    churn_date: Date | null;
    /**
     * WHICH Partner event ended it — `SUBSCRIPTION_CHARGE_CANCELLED`, `UNINSTALL`, `DEACTIVATED`, …
     *
     * `null` whenever `churn_date` is `null`, including when an end event existed but fell after the
     * judgement instant and was clamped away. The two must agree: a row naming the event that ended
     * it beside a null churn date asserts a departure this window has decided has not happened.
     *
     * It exists because "cancelled" and "uninstalled" are not the same fact. Shopify emits a plan
     * change as a CANCELLATION of the old charge in the same second as the replacement, so a
     * cancellation is the one end type that may not be a departure at all.
     */
    end_event_type: string | null;
    /**
     * The charge that started for this same store within the supersession window of THIS one's end.
     *
     * A MEASUREMENT, NOT A CORRECTION. When it is set, this subscription's end is very likely one
     * half of a plan change rather than a merchant leaving — but nothing is reclassified on it, no
     * count moves, and the end is not suppressed. Suppressing it would delete every genuine
     * cancel-then-resubscribe, which in this data is indistinguishable from an upgrade.
     *
     * ⚠️ A FLOOR. Both charges must carry an id: two shop-keyed buckets for one store cannot be told
     * apart from a store that genuinely subscribed twice, so those are left `null`.
     */
    superseded_by_charge_id: string | null;
    /**
     * The event type that SUPPLIED `conversion_date` — in practice `SUBSCRIPTION_CHARGE_ACTIVATED`.
     * `''` when no event carried a `billingOn`. Published so the provenance is checkable per row
     * rather than asserted in a comment, which is how it came to be wrong (see `billing_on` above).
     */
    conversion_source_event_type: string;
    /**
     * Days from that event to `conversion_date`. Exact fractional days; `null` when either is absent.
     *
     * NOT A TRIAL LENGTH AND MUST NEVER BE RENDERED AS ONE. Nothing classifies on it. It is
     * counted into `ChargeCohortDiagnostics.billing_on_gap` so an operator can see how much of their
     * trial data is a gap that cannot be a trial; it is not rounded, because rounding 29.6 to 30
     * manufactures a "30-day trial" reading out of a number equally consistent with a no-trial
     * subscription billing one cycle out.
     */
    billing_on_gap_days: number | null;
    state: SubscriptionState;
    state_basis: StateBasis;
    /** `null` only if a subscription state ever loses its mapping — never defaulted to `INSTALLED`. */
    lifecycle_state: StoreLifecycleState | null;
    charge_link: ChargeLinkState;
    /** `charge.name`. `''` when absent, which the table renders as an em dash. */
    plan_name: string;
    /** `charge.amount.amount`, or `null`. ⚠️ The table reads `plan_price`, NOT `price`. */
    plan_price: number | null;
    currency: string;
    /**
     * Whether ANY settled `APP_SUBSCRIPTION` payout was observed for this subscription.
     *
     * A boolean and not a count, deliberately: the resolver is handed a SET of settled charge ids,
     * so it knows presence and not multiplicity. Publishing a `1` here would be a number nobody
     * measured. Only the sign is ever read anyway — `classifyAsOf` tests `> 0`.
     */
    settled_payout_observed: boolean;
    /**
     * WHICH evidence produced it, so a domain-level fallback is never read as per-charge.
     * `domain` is COARSER: it is used only for a subscription that carries no charge id at all, and
     * a store with two subscriptions where one settled reads as settled on both.
     */
    settled_payout_scope: 'charge' | 'domain' | 'none';
}

/** Counts the service turns into `diagnostics` and `warnings[]`. Every exclusion here is REPORTED. */
export interface ChargeCohortDiagnostics {
    /** Rows handed in. */
    events_read: number;
    /** Rows that survived the test-charge and keyless gates and carried a known event type. */
    events_considered: number;
    /** EVENTS dropped for `raw_event.charge.test === true`. ⚠️ Asymmetric — see the resolver header. */
    test_excluded: number;
    /** Distinct SUBSCRIPTIONS those events belonged to — the number a warning string should quote. */
    test_subscriptions_excluded: number;
    /** Rows with neither a charge id nor a shop domain. SKIPPED and counted, never pooled. */
    skipped_keyless: number;
    /** Rows whose `shop_domain` was blank. They cannot join the install spine. */
    shopless_events: number;
    /**
     * Rows carrying no readable `occurred_at`. Unreachable from a stored document (the schema
     * declares it `required`), counted anyway so the fold never answers for fewer events than it was
     * given without saying so.
     */
    undated_events: number;
    /** Rows whose event type was in neither the START nor the END list. */
    unrecognised_events: number;
    /** Subscriptions dropped because their domain was outside the supplied spine. */
    out_of_spine: number;
    /** Subscriptions resolved. */
    subscriptions: number;
    /** Distinct domains after the latest-trial-start fold. */
    domains: number;
    /**
     * Subscriptions a shop had beyond its winning one — the per-domain fold's own loss, made visible.
     *
     * ⚠️ NOT THE CANCEL TRAP, and the names are close enough to be confused. This counts what the
     * LATEST-`trial_start`-wins fold discarded when reducing to one row per store. `supersession`
     * below counts something else entirely: subscriptions whose END looks like one half of a plan
     * change. A store can contribute to one, both, or neither.
     */
    subscriptions_superseded: number;
    /**
     * THE CANCEL-TRAP EXPOSURE. Measured only — no state, date or count is changed by it.
     *
     * Shopify emits a plan change as a cancellation of the old charge plus an acceptance of the new
     * one IN THE SAME SECOND, and this fold keys per charge. So one merchant upgrading once produces
     * two `trial_started`, an end event that is not a departure, and — when the change lands inside
     * the trial — a `CHURNED_DURING_TRIAL` against the merchant who upgraded. These counters say how
     * much of that is in the data; deciding what to do about it needs the number first.
     *
     * Every count here is a FLOOR: the pairing needs a charge id on both sides.
     */
    supersession: {
        /** Subscriptions whose end has a successor charge inside the window — the PREDECESSORS. */
        detected: number;
        /** Of those, the successor started in the same second. Shopify's own plan-change signature. */
        same_second: number;
        /**
         * Distinct SUCCESSOR charges — the honest inflation figure, and not the same number as
         * `detected`: two predecessors ending together can name one successor, and counting
         * predecessors would claim two extra trial starts where the fold produced one.
         */
        distinct_successors: number;
        /** Distinct stores with at least one detection. */
        shops: number;
        /** Of the detections, ones booked as an end DURING trial — the phantom churn, and the worst case. */
        churned_during_trial: number;
        /** Of the detections, ones booked as an end AFTER paying. */
        churned_after_trial: number;
        /** The pairing window actually used, in ms. Published so a warning cannot quote a stale number. */
        window_ms: number;
    };
    /**
     * The `announcing event → billingOn` gap, which we publish as trial length on our HIGHEST
     * confidence basis and which the data does not support to that standard.
     *
     * `negative` and `above_band` are DISJOINT and sum to "outside the plausible band". Being
     * INSIDE the band is not evidence of a trial: the gap is bimodal (~6–7 days and ~29–30 days on
     * the live database this was measured against, same plan names in both), and no stored field
     * discriminates a trial from a first billing one cycle out.
     */
    billing_on_gap: {
        /** Subscriptions where both the date and the event that announced it are known. The denominator. */
        measured: number;
        /** `billingOn` BEFORE the event that announced it. Cannot be a trial end under any reading. */
        negative: number;
        /** Gap longer than `band_max_days`. A billing anchor, not a trial. */
        above_band: number;
        /** The band actually applied, in days. Published so a warning cannot quote a stale number. */
        band_max_days: number;
    };
    charge_link: { resolved: number; unresolved: number; absent: number };
    state_basis: { billing_on: number; settled_payout: number; inferred: number };
    trial_days_source: { partner_billing_on: number; none: number };
}

/** What the cohort resolver answers. */
export interface ChargeCohortResult {
    /** Every subscription, in no guaranteed order. */
    subscriptions: CohortSubscription[];
    /** One winner per domain — latest `trial_start` wins. A `Map`, so a `''` domain cannot collide. */
    by_domain: Map<string, CohortSubscription>;
    diagnostics: ChargeCohortDiagnostics;
}
