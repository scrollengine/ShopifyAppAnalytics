'use strict';

/**
 * ============================================================================
 *  DEMO DATASET — the shapes the generator produces and the writer consumes
 * ============================================================================
 *
 *  Every row type here is the row a REAL sync would have written, not a
 *  convenience shape invented for the seeder. `DemoEventRow` mirrors
 *  `PartnerEventUpsertRow`, `DemoTransactionRow` mirrors
 *  `PartnerTransactionUpsertRow`, and the three listing rows mirror what
 *  `bigQuerySync.service` parses out of the GA4 export. That is deliberate: a
 *  seeder whose rows differ in shape from the sync's rows produces a dashboard
 *  that only works on demo data, which is worse than no demo at all.
 *
 *  They are declared here rather than imported from the partner/bigquery
 *  modules because those types are internal to their modules and importing them
 *  would couple this script to module internals it must not constrain — see
 *  the note on the generator.
 * ============================================================================
 */

import type { PartnerEventType, PartnerTransactionType } from '../../types/partnerVocab.types';
import type { SyncJobStatus, SyncJobTriggeredBy, SyncJobType } from '../../types/syncJob.types';

/** A money amount as both fact collections store it. */
export interface DemoMoney {
    amount: number;
    currency: string;
}

/** One row destined for `gi_partner_app_events`. */
export interface DemoEventRow {
    partner_event_id: string;
    event_type: PartnerEventType;
    shop_domain: string;
    shop_id: string;
    shop_name: string;
    charge_id: string;
    occurred_at: Date;
    raw_event: Record<string, unknown>;
}

/** One row destined for `gi_partner_app_transactions`. */
export interface DemoTransactionRow {
    shopify_transaction_id: string;
    type: PartnerTransactionType;
    shop_domain: string;
    shop_id: string;
    created_at: Date;
    billing_interval: string | null;
    charge_id: string;
    net_amount: DemoMoney;
    gross_amount: DemoMoney;
    shopify_fee: DemoMoney;
    raw_transaction: Record<string, unknown>;
}

/** One row destined for `gi_listing_funnel_dailies`. */
export interface DemoFunnelDayRow {
    date: Date;
    views: number;
    engaged_views: number;
    install_clicks: number;
    consent_started: number;
    consent_completed: number;
    installs: number;
    ad_clicks: number;
    first_opens: number;
    sessions: number;
    first_visits: number;
    /**
     * installs / views, and ad_clicks / installs — `null` when the day had no denominator.
     *
     * NULLABLE BECAUSE THE SEEDER MUST PLANT WHAT THE SYNC WOULD WRITE. These mirror
     * `ListingFunnelDailyDoc`, whose model defaults both to `null`; typing them `number` here let
     * the seeder keep a private zero-returning divide long after `bigQuerySync.service` had stopped
     * using one, so `npm run seed:demo` planted rows the model's own contract forbids.
     */
    overall_conversion_rate: number | null;
    ad_attributed_share: number | null;
    source_bq_query_id: string;
    bytes_scanned: number;
}

/** One row destined for `gi_listing_source_dailies`. */
export interface DemoSourceDayRow {
    date: Date;
    traffic_source: string;
    traffic_medium: string;
    users: number;
    views: number;
    install_clicks: number;
    installs: number;
}

/** One row destined for `gi_listing_geo_dailies`. */
export interface DemoGeoDayRow {
    date: Date;
    country: string;
    views: number;
    installs: number;
    /** installs / views for this country. `null` for a bucket with no views — see the funnel row. */
    conversion_rate: number | null;
}

/** One row destined for `gi_listing_install_attributions`. */
export interface DemoAttributionRow {
    shop_domain: string;
    shop_url_raw: string;
    shop_id: string;
    shop_name: string;
    installed_at: Date;
    install_date: Date;
    user_pseudo_id: string;
    source: string;
    medium: string;
    campaign: string;
    attribution_source: string;
    surface_type: string;
    surface_detail: string;
    surface_inter_position: number | null;
    surface_intra_position: number | null;
    surface_via: string;
    surface_version: string;
    ad_clicks_before_install: number;
    country: string;
    locale: string;
    sync_job_id: string;
}

/** One row destined for `gi_sync_jobs` — the run history the Sync page renders. */
export interface DemoSyncJobRow {
    job_type: SyncJobType;
    payload: Record<string, unknown>;
    status: SyncJobStatus;
    triggered_by: SyncJobTriggeredBy;
    triggered_by_user_id: string;
    started_at: Date | null;
    completed_at: Date | null;
    duration_ms: number | null;
    error_message: string;
    failure_reason: string;
    result_summary: Record<string, unknown>;
    attempts: number;
}

/**
 * One subscription in the demo cast, expressed the way SHOPIFY expresses one:
 * an accepted charge, an optional billing start, and an optional end.
 *
 * `converted` and `billing_on` are separate on purpose. `billing_on` is what
 * Shopify puts on the charge the moment the merchant approves it — it is a
 * PROMISE about when billing starts, present on abandoned trials too. `converted`
 * is whether a `SUBSCRIPTION_CHARGE_ACTIVATED` was ever emitted. Collapsing the
 * two is exactly how an abandoned trial gets mistaken for a conversion.
 */
export interface DemoSubscriptionSpec {
    /** Key into `DEMO_PLANS`. */
    plan: string;
    /** Days before the anchor that `SUBSCRIPTION_CHARGE_ACCEPTED` was emitted. */
    accepted_days_ago: number;
    /** Free-trial length. `billing_on = accepted_at + trial_days`. Zero means billing starts at once. */
    trial_days: number;
    /** Whether `SUBSCRIPTION_CHARGE_ACTIVATED` was emitted at `billing_on`. */
    converted: boolean;
    /** Days before the anchor that the subscription ended, or null while it runs. */
    ended_days_ago: number | null;
    /** The end event type, or null when the end is carried by an UNINSTALL/DEACTIVATED instead. */
    end_event: string | null;
    /**
     * Settled payouts to DROP from the tail of the series — the "payouts are late"
     * case. One dropped payout is a cycle Shopify has not settled yet, which reads
     * as an older `last_charged_at` and NOT as a cancellation.
     */
    skip_last_payouts: number;
    /** `charge.test` on the raw event. A test subscription is excluded from every cohort, and counted. */
    test: boolean;
    /**
     * Suppress the charge EVENTS while keeping the settled payouts — a subscription
     * whose lifecycle predates the synced event window. This is the shop the
     * ledger MRR predicate exists for: billed by Shopify, invisible to the events.
     */
    events_suppressed: boolean;
}

/** One store in the hand-written cast. Procedural stores are built into the same shape. */
export interface DemoStoreSpec {
    /** Slug — becomes `demo-<slug>.myshopify.example`. */
    slug: string;
    /** Merchant-facing store name, as the Partner API reports it. */
    name: string;
    /** Full CLDR country name — what the GA4 export emits, not an ISO code. */
    country: string;
    /** Days before the anchor of the INSTALL event, or null when the install predates the window. */
    installed_days_ago: number | null;
    uninstalled_days_ago: number | null;
    reinstalled_days_ago: number | null;
    deactivated_days_ago: number | null;
    subscriptions: DemoSubscriptionSpec[];
    /** Key into `DEMO_ATTRIBUTION_SURFACES`, or null for a store GA4 never attributed. */
    attribution: string | null;
    /** Refunds/credits, as `APP_CREDIT` payouts with a negative amount. */
    credits: Array<{ days_ago: number; amount: number }>;
}

/** The whole generated dataset, before anything touches a database. */
export interface DemoDataset {
    /** UTC midnight the dataset is measured back from. */
    anchor_at: Date;
    /** The app row's non-identity fields, including the demo marker in `metadata`. */
    app: {
        app_handle: string;
        display_name: string;
        listing_url: string;
        partner_api_app_id: string;
        categories: string[];
        target_keywords: string[];
        metadata: Record<string, unknown>;
    };
    stores: DemoStoreSpec[];
    events: DemoEventRow[];
    transactions: DemoTransactionRow[];
    funnel_days: DemoFunnelDayRow[];
    source_days: DemoSourceDayRow[];
    geo_days: DemoGeoDayRow[];
    attributions: DemoAttributionRow[];
    sync_jobs: DemoSyncJobRow[];
    /** The window with no installs and no trial starts, so one month has no measurable rate. */
    quiet_window: { start: Date; end: Date; month: string };
}

/** Row counts per collection, keyed by the seeder's own collection labels. */
export type DemoRowCounts = Record<string, number>;

/** What the seeder refused to do, or did. */
export interface DemoSeedOutcome {
    /** `SEEDED` | `REFUSED` — a refusal is a decision, not a failure. */
    status: 'SEEDED' | 'REFUSED';
    /** The operator-facing sentence. Says what was found and what to do about it. */
    message: string;
    /** The anchor the dataset was measured back from, when one was used. */
    anchor_at: Date | null;
    /** The app row's id, when one exists. */
    partner_app_id: string | null;
    /** Rows written per collection. */
    written: DemoRowCounts;
    /** Rows removed before writing (a re-seed replaces its own previous rows). */
    removed: DemoRowCounts;
    /** Watermarks and coverage gates written onto the app row. */
    watermarks: Record<string, unknown>;
    /** Headline figures, so the run can be checked without opening the dashboard. */
    summary: Record<string, unknown>;
}

/** What the teardown removed. */
export interface DemoTeardownOutcome {
    status: 'REMOVED' | 'NOTHING_TO_DO' | 'REFUSED';
    message: string;
    partner_app_id: string | null;
    removed: DemoRowCounts;
    app_rows_removed: number;
}
