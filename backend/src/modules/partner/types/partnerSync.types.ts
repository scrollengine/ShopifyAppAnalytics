/**
 * Input, write-row and result shapes for the partner sync.
 *
 * Declarations only — every import is `import type`, so this file is erased at compile time and
 * costs nothing at run time.
 */

import type { MoneyAmount, PartnerAppDoc } from '../../shared/types/entity.types';
import type { CoverageRecord } from './coverage.types';

/**
 * Money EXACTLY as the Partner API sends it.
 *
 * ⚠️ `currencyCode`, not `currency`. The stored shape (`MoneyAmount`) renames it on the way in, so
 * these two types describe the same money one rename apart — and a `.currencyCode` read off a
 * stored document is always `undefined`. Keeping both named types is what makes the seam visible.
 */
export interface PartnerApiMoney {
    amount?: string | number;
    currencyCode?: string;
}

/**
 * The six values that make up an event's LOCAL identity hash.
 *
 * The Partner API's event connection exposes no id of its own, so identity has to be derived from
 * the event's own content.
 *
 *  `charge_id` is in here for a reason that cost real data. Without it, two genuine events of the
 * same type for one shop in the same second hash IDENTICALLY and the second upserts straight over
 * the first — and a plan change is exactly that: Shopify cancels the old charge and accepts the new
 * one in the same second, and `occurredAt` has no sub-second component to separate them. Every
 * install, trial and conversion count is built by counting these rows, so a collapse understates
 * all of them, silently.
 */
export interface HashEventIdInput {
    partner_api_app_id?: string;
    event_typename?: string;
    occurred_at?: string;
    shop_id?: string;
    /** The NORMALISED domain — the hash must be over the value that is stored, or one event hashes two ways. */
    shop_domain?: string;
    /** '' for every event with no charge block, which keeps those rows on the original five-value behaviour. */
    charge_id?: string;
}

/**
 * One event as the service hands it to the repository — already mapped, normalised and hashed.
 *
 * The service does the interpretation (typename → our vocabulary, raw domain → join key, GID →
 * bare charge id) and the repository does the writing. Neither knows the other's business, which is
 * what keeps the upsert's identity/payload split (see the repository) in one place.
 */
export interface PartnerEventUpsertRow {
    partner_event_id: string;
    shop_domain: string;
    shop_id: string;
    /**
     * The Partner API's `Shop.name`, trimmed, `''` when the node carried none.
     *
     * ⚠️ NOT an input to `partner_event_id` — see `HashEventIdInput`, which is the complete list.
     * That is what makes it repairable: it is written as `$set` payload, so a re-sync fills it in
     * on rows that already exist instead of inserting second copies of them.
     */
    shop_name: string;
    charge_id: string;
    occurred_at: Date;
    event_type: string;
    raw_event: Record<string, any>;
}

/** One transaction as the service hands it to the repository. */
export interface PartnerTransactionUpsertRow {
    shopify_transaction_id: string;
    created_at: Date;
    type: string;
    shop_domain: string;
    shop_id: string;
    billing_interval: string | null;
    charge_id: string;
    net_amount: MoneyAmount;
    gross_amount: MoneyAmount;
    shopify_fee: MoneyAmount;
    raw_transaction: Record<string, any>;
}

/**
 * What a chunked bulkWrite actually did.
 *
 * `errors` is derived, not reported: a failed chunk tells us how many rows it upserted and matched,
 * and everything else in that chunk is counted as an error. Rows that vanish without being counted
 * are how a sync reports success over data it never wrote.
 */
export interface BulkWriteTally {
    upserted: number;
    matched: number;
    errors: number;
}

/** One half of a sync run — the events pull or the transactions pull. */
export interface PartnerSyncPullInput {
    partnerApp: PartnerAppDoc;
    /** Canonical `gid://partners/App/<id>`. The Partner API rejects a bare numeric id. */
    partner_app_gid: string;
    since_iso: string;
}

/**
 * Per-collection outcome.
 *
 * ⚠️ `partial` and `truncated` are not diagnostics — they are the two conditions under which the
 * caller must NOT advance its watermark. A run that skips a window never revisits it.
 */
export interface PartnerSyncStats {
    fetched: number;
    upserted: number;
    existed: number;
    skipped: number;
    partial: boolean;
    truncated: boolean;
}

/** The transactions pull additionally reports how many of the fetched nodes were relevant. */
export interface PartnerTransactionSyncStats extends PartnerSyncStats {
    relevant: number;
}

/** The whole run, as it is returned to the caller and stored on the job row. */
export interface PartnerSyncSummary {
    partner_app_id: string;
    /** The mode that was actually RUN — AUTO has already resolved to LIFETIME or INCREMENTAL. */
    mode: string;
    since: string;
    events: PartnerSyncStats | null;
    transactions: PartnerTransactionSyncStats | null;
    events_ok: boolean;
    transactions_ok: boolean;
    /**
     * The six coverage gates, recomputed from the collections AFTER a fully successful run.
     *
     * Null when the run did not fully succeed — the gates are then deliberately left as they were,
     * because measuring coverage over a half-written window would stamp a confident summary onto a
     * record we already know is incomplete.
     */
    coverage: CoverageRecord | null;
}

/** Inputs to the window resolver. */
export interface ResolveSinceInput {
    partnerApp: PartnerAppDoc;
    mode?: string;
    lookback_days?: number;
}

/** The window a run will actually pull, and the mode that produced it. */
export interface ResolvedSince {
    since_iso: string;
    /** Never AUTO — AUTO is resolved here, so everything downstream sees a concrete mode. */
    resolved_mode: string;
}

/**
 * The job payload.
 *
 * ⚠️ EVERY field is optional, `partner_app_id` included, and that is not laziness. This shape
 * arrives as `payload` off a stored job row — arbitrary JSON written by whoever enqueued it — so a
 * type declaring `partner_app_id: string` would be asserting something nobody checked. It is also
 * what makes the service assignable to the runner's `SyncJobHandler`, whose params are
 * `Record<string, any>`: a required field there is a compile error, which is TypeScript correctly
 * pointing out that the runner cannot promise to supply it.
 *
 * The service validates it at the top and refuses the job with a readable message.
 */
export interface RunFullSyncInput {
    partner_app_id?: string;
    /** AUTO / LIFETIME / INCREMENTAL. An unrecognised value falls back to AUTO rather than failing. */
    mode?: string;
    /** Only consulted for an INCREMENTAL run on an app with no watermark yet. */
    lookback_days?: number;
}
