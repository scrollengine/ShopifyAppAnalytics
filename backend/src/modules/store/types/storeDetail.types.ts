/**
 * ============================================================================
 *  ONE STORE'S RECORD — every name the drawer reads
 * ============================================================================
 *
 *  Declarations only — `typeof import(…)` is erased at compile time, so importing this file costs
 *  nothing at run time and does NOT pull the constants module in.
 *
 *  ── THE CONSUMER, AND WHY IT CONSTRAINS THE SHAPE THIS HARD ────────────────────────────────
 *
 *  `StoreDetailDrawer` has exactly TWO rendering paths: the full record, or a critical banner
 *  carrying one sentence. There is no third, and no per-field empty state. So every branch below is
 *  a choice between those two, and a field that arrives with the wrong SHAPE does not error — it
 *  renders as a confident blank inside a finished-looking panel. Four of these are pinned:
 *
 *     `acquisition: null` SELECTS THE "Not attributed" BRANCH (`StoreDetailContent.js:205-222`).
 *       `{}` or a synthesised `channel: 'DIRECT'` takes the ATTRIBUTED branch and presents a store
 *       we know nothing about as a confident direct arrival — hidden inside what is already the
 *       largest bucket.
 *
 *     `subscription.store_active` MUST BE PRESENT. `StoreStatusBadges` (`:136`) renders an
 *       "Uninstalled" badge on `!sub.store_active`, so an ABSENT field accuses every store.
 *       ⚠️ AND SO DOES `null` — see the field's own note; that is a frontend defect this module
 *       must not paper over by publishing a value it did not measure.
 *
 *     `subscription.status` IS THE LIFECYCLE VOCABULARY, not the install state. `INSTALLED` here
 *       means "never subscribed"; whether the app is on the store right now is `install_state`, in
 *       its own field, from a different source.
 *
 *     EVERY FIGURE IS A BARE VALUE, NEVER A `confidence.helper` ENVELOPE. `fmtMoney(envelope)` is
 *       `Number({…})` → `NaN` → an em dash, and it backs five figures on this panel. The honesty
 *       contract is discharged through `provenance`, `unavailable`, `attribution_state`,
 *       `data_state`, `state_basis`, `trial_days_source`, `customer_name_source` and `warnings[]` —
 *       fields that survive rendering.
 *
 *  ── DATES ──────────────────────────────────────────────────────────────────────────────────
 *
 *  The same split the roster uses, for the same reason: instants a COMPONENT formats are typed
 *  `Date` and serialise to ISO through `JSON.stringify` exactly as `StoreRosterRow`'s do; instants
 *  that are METADATA ABOUT THE READ (`as_of`, `meta.*`) are converted to ISO strings here, so the
 *  type says what actually crosses the wire.
 * ============================================================================
 */

import type { AcquisitionChannel, StoreLifecycleState, TrialDaysSource } from '../../conversion/types/lifecycle.types';
import type {
    StoreAttributionState,
    StoreDataState,
    StoreInstallState,
    StoreNameSource,
    StoreStateBasis
} from './storeRoster.types';
import type { StoreSpendTypeTotal } from './storeDetailData.types';

type StoreDetailConstants = typeof import('../constants/storeDetail.constants');

// ── Vocabulary unions ───────────────────────────────────────────────────────

/** `partner_event` | `transaction` | `ga4_attribution`. Keys into the drawer's own label map. */
export type StoreTimelineSource =
    StoreDetailConstants['TIMELINE_SOURCES'][keyof StoreDetailConstants['TIMELINE_SOURCES']];

/** `positive` | `negative` | `neutral`. Anything else is drawn as a grey dot. */
export type StoreTimelineTone =
    StoreDetailConstants['TIMELINE_TONES'][keyof StoreDetailConstants['TIMELINE_TONES']];

/** `NOT_EXPOSED` | `NOT_PUSHED`. The two kinds of nothing a FIELD can carry. */
export type StoreFieldUnavailableReason =
    StoreDetailConstants['FIELD_UNAVAILABLE_REASONS'][keyof StoreDetailConstants['FIELD_UNAVAILABLE_REASONS']];

// ── The timeline ────────────────────────────────────────────────────────────

/**
 * One thing that happened to this store, from whichever collection recorded it.
 *
 * NEWEST FIRST. `StoreDetailContent.js:350-363` groups consecutive entries by calendar day WITHOUT
 * sorting them first, so the order this array arrives in IS the order on screen — an unsorted array
 * renders one day heading per entry.
 */
export interface StoreTimelineEntry {
    /** When it happened. ⚠️ Never null: an undated row is excluded and counted, never shown at t=0. */
    at: Date;
    /** The headline, e.g. "App installed". Never blank — an unrecognised type still gets a label. */
    label: string;
    /** The second line: plan, amount, charge id, surface. `''` renders nothing rather than a gap. */
    detail: string;
    /** Which collection this came from, shown per entry so a gap in ONE source stays visible. */
    source: StoreTimelineSource;
    tone: StoreTimelineTone;
}

// ── The record itself ───────────────────────────────────────────────────────

/**
 * The store, as the drawer's header, badges and cards read it.
 *
 * ⚠️ FOLDED FROM THE SAME `resolveStoreRow` THE ROSTER USES, then projected onto the names these
 * components read. That is the whole point: the drawer opens OVER a table row, and a store that
 * reads "Converted" in the table and "On trial" in the panel over it is the exact failure
 * `modules/conversion`'s barrel was widened to prevent.
 */
export interface StoreDetailSubscription {
    /** Never blank — falls back to the domain, which always exists. */
    customer_name: string;
    /** Which source won the name. Published so a reader never has to guess from the value. */
    customer_name_source: StoreNameSource;
    /** The Partner API's `Shop.name`, or `''`. `''` does NOT mean the store has no name. */
    shop_name: string;
    shop_domain: string;
    /**
     * The Partner GID for the shop, e.g. `gid://partners/Shop/17`. `''` when no event carried one.
     *
     * ⚠️ Rendered as "Platform ID". ONE OF THREE ID NAMESPACES and never merged with the other two:
     * GA4's numeric shop id and the Admin API's numeric id are different identifiers for the same
     * shop, and a merged `platform_id` is sometimes a join key and sometimes garbage.
     */
    platform_id: string;

    /**
     * The SUBSCRIPTION lifecycle state, in the vocabulary `STORE_STATE_LABELS` keys on.
     *
     * ⚠️ `INSTALLED` here means "this store never subscribed", NOT "the app is installed".
     */
    status: StoreLifecycleState;
    status_label: string;
    /**
     * The same value under the name the table reads, assigned from the same variable.
     *
     * Two spellings of one fact, and that is a FRONTEND contract rather than a preference:
     * `StoreDetailContent` reads `status`, `StoreTable._renderStatus` reads `state`. They are
     * published from one variable precisely so they cannot drift; dropping either would blank a
     * badge on whichever component was not tested that day.
     */
    state: StoreLifecycleState;
    state_label: string;
    /** Which evidence produced it, or `join_miss` for a store with no subscription at all. */
    state_basis: StoreStateBasis;

    /**
     * Our records show a paid plan, and the canonical MRR predicate says no payout is live now.
     *
     * ⚠️ MEASURED, NOT ASSUMED, and it requires payout evidence to exist: a store with NO settled
     * payouts at all is `false` here, because "we have never fetched a payout" and "the payments
     * stopped" are different facts and only one of them is about the merchant. `false` therefore
     * means "not measured as stale", never "billing confirmed" — read it beside
     * `payouts.transaction_count` and `meta.earliest_transaction_at`.
     */
    billing_stale: boolean;
    /**
     * Whether the app is on the store right now. ⚠️ `null` — never `false` — when UNKNOWN.
     *
     *  AND THAT IS CURRENTLY MISRENDERED. `StoreStatusBadges` tests `!sub.store_active`, so `null`
     * draws the same "Uninstalled" badge an absent field would, on a store we know nothing about.
     * `StoreTable._renderStatus` already gets this right with `row.store_active === false`, and the
     * fix is to make the drawer's test match it. Publishing `true` here to dodge the badge would put
     * a value in the payload that no evidence supports, which is a worse failure in a more permanent
     * place: the panel is one line of JSX, the contract is forever.
     */
    store_active: boolean | null;

    /** `INSTALLED` | `UNINSTALLED` | `UNKNOWN` — a DIFFERENT question from `status`. */
    install_state: StoreInstallState;
    /** "Deactivated" when the deciding event was a deactivation; the merchant did not uninstall. */
    install_state_label: string;
    install_state_at: Date | null;
    /** The event type that decided the state, so the three-value collapse loses nothing. */
    install_state_event: string;
    installed_at: Date | null;
    latest_install_at: Date | null;
    /** ⚠️ `null` means "no uninstall event on record", NEVER "this store has not uninstalled". */
    uninstalled_at: Date | null;
    deactivated_at: Date | null;
    install_count: number;
    has_install_record: boolean;

    /** ⚠️ `plan_price`, NOT `price` — the drawer reads this name. `null`, never `0`. */
    plan_name: string;
    plan_price: number | null;
    plan_currency: string;
    /** From a settled payout for THIS charge only. `null` stays `null` — never booked as monthly. */
    plan_interval: string | null;
    /** Shopify's `charge.billingOn`.  NEVER an assumed 7 days — absent evidence renders as `—`. */
    trial_end: Date | null;
    trial_days_source: TrialDaysSource;

    /**
     * When this store's CURRENT subscription began — the trial start, i.e. the merchant's approval.
     *
     * ⚠️ NOT the install date. A store can be installed for a year before it subscribes, and the
     * "Lifecycle dates" card reads this beside `conversion_date` and `churn_date`, which are both
     * subscription facts. `null` for a store that has never subscribed.
     */
    activation_date: Date | null;
    conversion_date: Date | null;
    /**
     * The planned billing date never arrived: the subscription ended on or before it.
     *
     * The card strikes the date through rather than hiding it, so the INTENT stays visible — which
     * is why this is published as a flag beside a real date instead of nulling the date.
     */
    conversion_date_voided: boolean;
    churn_date: Date | null;

    /**
     * The MERCHANT'S REGISTERED COUNTRY as ISO-2.  ALWAYS `''` — see `unavailable.country`.
     *
     * ⚠️ NOT `acquisition.country`, which is where the install TRAFFIC came from. They disagree
     * routinely and legitimately, and publishing one under the other's name republishes a traffic
     * figure as a merchant fact.
     */
    country: string;
    country_name: string;
    /** The merchant's custom storefront domain.  ALWAYS `''` — operator-pushed, and none exist. */
    website: string;
    /** The merchant's SHOPIFY plan tier. ⚠️ NOT `plan_name`, which is YOUR app's charge name. */
    shopify_plan_name: string;
}

/** The four stat tiles and the Activity card. Bare numbers; `null` means "not measured". */
export interface StoreDetailSummary {
    /** Lifetime settled spend, gross, refunds included as negatives. `null` when no payouts exist. */
    lifetime_value: number | null;
    /**
     * `lifetime_value / tx_count`.  `null` when `tx_count` is 0 — a ratio with an empty
     * denominator is not zero, and `$0.00` on this tile is a fabricated business fact.
     */
    average_spend: number | null;
    /** The monthly run-rate NOW, from the canonical predicate. `0` is measured; `null` is absent. */
    mrr: number | null;
    /** Settled payout rows for this store. `0` is measured once a sync has run. */
    tx_count: number;
    first_payment_at: Date | null;
    last_payment_at: Date | null;
    /**
     * The earliest instant ANY collection has a record of this store — an event, a payout or a
     * listing-analytics row, whichever is oldest.
     *
     * ⚠️ Bounded below by what has been synced, so it is a FLOOR until a lifetime sync completes.
     * The drawer's hint currently reads "Store record created", which is wrong in this build (there
     * is no store record to create); it is a one-word copy fix on the frontend.
     */
    first_seen: Date | null;
}

/**
 * How the store arrived, from listing analytics.  THE WHOLE OBJECT IS `null` WHEN THERE IS NO
 * RECORD — see this file's header.
 */
export interface StoreDetailAcquisition {
    channel: AcquisitionChannel;
    channel_label: string;
    source: string;
    medium: string;
    campaign: string;
    /** `'none'` means a record exists and named no scope. `''` is impossible here — see the header. */
    attribution_source: string;
    surface_type: string;
    /**
     * Shopify's own handle for the placement — a homepage section handle, a category path, a
     * collection title. The drawer renders it as "Found via", which is a real answer for the 199
     * category and 59 home installs production carries.
     *
     * ⚠️ `''` on a SEARCH surface (`search` / `search_ad` / `guided_search`), where this same field
     * holds the merchant's typed query instead. This record does not blank it itself: it inherits
     * the value from `storeRow.resolver`'s fold, which is the single place that guard lives for
     * both the table row and the drawer over it.
     *
     * ⚠️ The KEY stays on every acquisition object regardless. `isPaidPlacement` reads
     * `homepage-ads` out of this field, so a build that drops it re-reads real ad clicks as
     * organic browsing and nothing anywhere fails.
     */
    surface_detail: string;
    surface_inter_position: number | null;
    surface_intra_position: number | null;
    /** The analytics install instant that was matched, so the match can be audited. */
    installed_at: Date | null;
    /** SIGNED seconds against Shopify's install instant. `null` when either side is missing. */
    lag_seconds: number | null;
    /**
     * GA4 `geo.country` for the install event — a common NAME, and the VISITOR's inferred
     * geolocation.  Published here and NEVER as `subscription.country`.
     */
    country: string;
}

/** One subscription this store has had. A store with two has two of these; the fold has a winner. */
export interface StoreDetailSubscriptionRecord {
    /** `chg:<charge_id>`, else `shop:<shop_domain>`. Never a pooled key. */
    bucket_key: string;
    /** `''` when the bucket is shop-keyed — a subscription whose events carried no charge id. */
    charge_id: string;
    plan_name: string;
    plan_price: number | null;
    currency: string;
    /** From a settled payout for THIS charge. `null` when none has settled. Never defaulted. */
    plan_interval: string | null;
    trial_start: Date | null;
    trial_end: Date | null;
    trial_days_source: TrialDaysSource;
    conversion_date: Date | null;
    churn_date: Date | null;
    /** The lifecycle state, or `null` if a subscription state ever loses its mapping. */
    state: StoreLifecycleState | null;
    state_label: string;
    state_basis: StoreStateBasis;
    /** Whether a settled `APP_SUBSCRIPTION` payout was observed for it. A boolean, not a count. */
    settled_payout_observed: boolean;
    /** `charge` | `domain` | `none`. `domain` is COARSER and must never read as per-charge. */
    settled_payout_scope: string;
    /**
     * Whether this is the subscription the `subscription` block above describes.
     *
     * Exactly one `true` when the store has any subscription at all — the latest trial start wins.
     * Published so the panel can show the superseded ones without implying they are current.
     */
    is_current: boolean;
}

/** The lifetime payout rollup. Cash, not run-rate — the two are never merged. */
export interface StoreDetailPayouts {
    /** `null`, never `0`, when this store has no payout rows at all. */
    total_gross: number | null;
    total_net: number | null;
    transaction_count: number;
    /**
     * The single currency this store's payouts are denominated in, or `''` when there is more than
     * one and the total is therefore a sum of unlike units. There is no FX table in this build.
     */
    currency: string;
    /** Every distinct currency seen, so a reader can see WHICH units were mixed. */
    currencies: string[];
    first_payment_at: Date | null;
    last_payment_at: Date | null;
    /** Per-type totals, biggest gross first. ⚠️ Credits and adjustments are NEGATIVE money. */
    by_type: StoreSpendTypeTotal[];
}

/**
 * The App Store review block.
 *
 *  ALWAYS `available: false` on this build, and that is a measurement rather than a stub: the
 * Partner API exposes no review or rating data for an app's listing on any version, and this tool
 * has no other source. `note` says so; `listing_url` still resolves, so the operator can go and look.
 */
export interface StoreDetailAppReview {
    available: boolean;
    /** `null` while `available` is false. A number would be a rating nobody measured. */
    rating: number | null;
    /** The sentence rendered in the rating's place. Never blank while `available` is false. */
    note: string;
    listing_url: string;
}

/** Why one field is empty, per field. See the constants: the two reasons must not be merged. */
export interface StoreFieldUnavailable {
    reason: StoreFieldUnavailableReason;
    message: string;
}

/**
 * WHERE each field that has more than one possible source actually came from.
 *
 * Only the fields whose provenance genuinely VARIES are here. A map that also listed the fields with
 * exactly one possible source would be a map nobody reads, and the two would then be equally
 * ignored.
 */
export interface StoreDetailProvenance {
    /** `operator` | `partner` | `listing` | `domain`. Which name won, and it is never blank. */
    customer_name: StoreNameSource;
    /** `billing_on` | `settled_payout` | `inferred` | `join_miss`. ⚠️ `inferred` is the one guess. */
    state: StoreStateBasis;
    /** `partner_billing_on` | `none`. There is deliberately no "assumed default" member. */
    trial_end: TrialDaysSource;
    /** `partner_events` when a relationship event decided it, `none` when nothing has. */
    install_state: string;
    /** `settled_payouts` when a payout was evaluated, `none` when there was nothing to evaluate. */
    monthly_spend: string;
    /** `listing_analytics` when an attribution row was matched, else the tier state that explains it. */
    acquisition: string;
}

/** Freshness and coverage for this record. ISO strings; `null` means "not measured". */
export interface StoreDetailMeta {
    last_synced_at: string | null;
    /** When an operator enrichment push last landed. ALWAYS `null` today — a watermark, not a count. */
    last_store_push_at: string | null;
    /** The floor of what the event record answers. An event before it is invisible, not absent. */
    earliest_event_at: string | null;
    /** The same floor for MONEY, tracked separately because payouts settle after the charge. */
    earliest_transaction_at: string | null;
    /** Until this is set, this store's history is a FLOOR rather than a complete record. */
    lifetime_sync_completed_at: string | null;
    shop_name_coverage_since: string | null;
}

/** Everything the reads excluded or could not use. Every number here is also a warning. */
export interface StoreDetailDiagnostics {
    /** Partner events this record was folded from, after the two reads were merged. */
    events_read: number;
    /**
     * Events the CHARGE-KEYED read recovered that the domain-keyed one could not see.
     *
     *  Almost always `0`, and the exceptions are the whole reason that read exists: a
     * `SubscriptionChargeCanceled` for a shop Shopify redacted between its install and its
     * cancellation carries no `shop_domain`, so a per-store read misses it and that subscription
     * never churns. A non-zero here is not a warning — it is this endpoint working.
     */
    charge_keyed_events_recovered: number;
    /** Those at or before the judgement instant — the only ones any STATE was decided from. */
    events_considered: number;
    /** Events dated AFTER the judgement instant. Shown on the timeline, excluded from every state. */
    future_events: number;
    /** Events with no readable `occurred_at`. They can be placed nowhere, so they are dropped. */
    undated_events: number;
    /** Settled payout rows fetched for this store, by DOMAIN. Every money figure comes from these. */
    transactions_read: number;
    /**
     * Payouts the CHARGE-KEYED read recovered that carry no `shop_domain`.
     *
     *  They are EVIDENCE and not money: they mark a charge as settled — which is what decides a
     * subscription Shopify gave no `billingOn` for — and they reach no total, no count and no
     * currency, because a payout that names no shop cannot be attributed to one. Almost always `0`.
     */
    charge_keyed_payouts_recovered: number;
    /** Payouts dated after the judgement instant. Excluded from every money figure, and REPORTED. */
    future_transactions: number;
    /** Payout rows with no readable `created_at`. */
    undated_transactions: number;
    /** Listing-analytics install records for this store. More than one means it installed twice. */
    attribution_rows: number;
    /** Subscriptions resolved for this store, superseded ones included. */
    subscriptions: number;
    /** Distinct test SUBSCRIPTIONS excluded. ⚠️ Asymmetric — relationship events carry no test flag. */
    test_subscriptions_excluded: number;
    /** Subscription events skipped for carrying neither a charge id nor a shop domain. */
    skipped_keyless_subscription_events: number;
    /** Entries the timeline actually carries, after the cap. */
    timeline_entries: number;
    /** Entries the cap withheld. `0` means the timeline below is complete. */
    timeline_truncated: number;
}

/**
 * One store's full record. Every empty state is either a populated field with a stated reason, or a
 * refusal carrying one — never a blank panel.
 */
export interface StoreDetailResponse {
    app_id: string;
    app_name: string;
    /** The ONE judgement instant this whole response was folded against. */
    as_of: string;

    subscription: StoreDetailSubscription;
    /**  `null` — never `{}` — when this store has no listing-analytics record. */
    acquisition: StoreDetailAcquisition | null;
    summary: StoreDetailSummary;
    /** NEWEST FIRST. The drawer groups by day without sorting, so this order is the screen order. */
    timeline: StoreTimelineEntry[];
    /** Every subscription this store has had, current first. Empty for a store that never subscribed. */
    subscriptions: StoreDetailSubscriptionRecord[];
    payouts: StoreDetailPayouts;
    app_review: StoreDetailAppReview;

    /**
     * The operator-pushed profile, or `null` when none has been pushed.
     *
     * ALWAYS `null` today: `gi_store_enrichments` does not exist. The key is published now so the
     * ingest wave fills a slot instead of adding one, and so `customer_name_source` can gain its
     * fourth value additively.
     */
    operator: null;
    provenance: StoreDetailProvenance;
    /** Field name → why it is empty. A field that was asked for and came back empty is NOT here. */
    unavailable: Record<string, StoreFieldUnavailable>;

    meta: StoreDetailMeta;
    /**
     * The partner tier's state. ⚠️ ALWAYS `READY` on a payload, BY CONSTRUCTION: a store cannot be
     * described from a tier that has never synced, so that case is a refusal carrying the reason
     * rather than a panel full of em dashes. Published anyway, because a consumer should not have to
     * know that to read the field.
     */
    data_state: StoreDataState;
    attribution_state: StoreAttributionState;
    /** De-duplicated. Operator-facing sentences, each naming what is missing and what would fix it. */
    warnings: string[];
    diagnostics: StoreDetailDiagnostics;
}

/**
 * The query bag, exactly as `storePresentation.storeDetailRequestParams` builds it.
 *
 * ⚠️ EXACTLY ONE IDENTITY KEY IS SENT — that helper picks `tenant_id` for a 24-hex string and
 * `shop_domain` for anything else, precisely so an OR-match cannot resolve two disagreeing keys to
 * the wrong store. This endpoint honours that: it never matches on both.
 */
export interface StoreDetailParams {
    partner_app_id?: string;
    /**
     * The store to describe. Normalised ONCE here, because a client may send a raw URL rather than
     * a bare domain, while every stored list carries it canonical.
     */
    shop_domain?: string;
    /**
     * ⚠️ ACCEPTED AND REFUSED WITH A REASON, never silently ignored.
     *
     * `tenant_id` is a concept from the system this was extracted from, and this build deliberately
     * does not inherit it: there is no tenant, user_tenant or users graph here, so no tenant id can
     * resolve to a store. Ignoring it and answering from `shop_domain` would be worse — the client
     * sends ONE key or the other, so a request carrying a tenant id carries no domain, and
     * "ignoring" it means describing whichever
     * store a missing needle happens to match.
     */
    tenant_id?: string;
}

/**
 * The blocks `resolvers/storeDetailRecord.resolver` assembles.
 *
 * Everything in it reaches the wire verbatim; the service adds only the envelope — identity, tier
 * states, timeline, meta, warnings and diagnostics. Split that way so the whole per-store
 * projection can be exercised against a literal row with no database and no clock.
 */
export interface StoreDetailRecord {
    subscription: StoreDetailSubscription;
    /**  `null`, never `{}`, when this store has no listing-analytics record. */
    acquisition: StoreDetailAcquisition | null;
    summary: StoreDetailSummary;
    /** Current first, then newest trial start. Empty for a store that never subscribed. */
    subscriptions: StoreDetailSubscriptionRecord[];
    payouts: StoreDetailPayouts;
    app_review: StoreDetailAppReview;
    provenance: StoreDetailProvenance;
    unavailable: Record<string, StoreFieldUnavailable>;
}
