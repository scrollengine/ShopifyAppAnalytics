/**
 * Document shapes for the Performance-suite collections.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 * These describe what the mongoose models in `src/models/` actually persist. They are hand-written
 * rather than inferred: this file is the single description of these documents, and
 * `shared/repositories/models.repository` is the only place it is attached to a model.
 *
 * ⚠️ Every collection here is GLOBAL. There is no `tenant_id` on any of them and there is no
 * multi-tenancy in this build — you run it for your own app. The scoping root is `partner_app_id`
 * (a Shopify app *you* own), and a type that grows a `tenant_id` has almost certainly been copied
 * from somewhere it does not belong.
 *
 * ⚠️ Mongoose PLURALISES a model name into a collection name unless the schema pins `collection:`.
 * Only matters for a hand-written `$lookup` or a mongosh query — `Model.find` is unaffected.
 *
 * Trimmed on extraction to the Performance suite. The competitor, review, keyword, ad-metric,
 * ranking, LLM-insight, chat and alert documents are not here; they belong to the Market Intel
 * suite, which is a later release.
 */

import type { Types } from 'mongoose';

/** Mongo `_id`, or its string form once a document has crossed a JSON boundary. */
export type ObjectIdLike = Types.ObjectId | string;

/** Fields mongoose adds to every schema declared with `{ timestamps: true }`. */
export interface Timestamped {
    createdAt?: Date;
    updatedAt?: Date;
}

/**
 * Money as it is PERSISTED.
 *
 * ⚠️ Not the Partner API's own shape: the API returns `{ amount, currencyCode }` and the sync
 * renames the second field on the way in, so every stored money subdoc (`gross_amount`,
 * `net_amount`, `shopify_fee`) reads `currency`. A `.currencyCode` on a stored document is always
 * undefined — that name only exists on the raw `raw_event` / `raw_transaction` payloads, which are
 * `Record<string, any>` and typed nowhere.
 */
export interface MoneyAmount {
    amount?: number;
    currency?: string;
}

// ── Dimensions ──────────────────────────────────────────────────────────────

/** One Shopify app you own and track. The scoping root for the entire module. */
export interface PartnerAppDoc extends Timestamped {
    _id: ObjectIdLike;
    app_handle: string;
    display_name: string;
    /**
     * WHY not optional: the schema declares this `required: true`, so no stored document can lack it
     * and the create path rejects a missing value before the insert. Typing it `listing_url?: string`
     * would describe a state the schema forbids and push every reader into a dead `undefined`
     * branch. Narrowing only removes guards; it cannot make an existing caller unsafe.
     */
    listing_url: string;
    /**
     * The Partner API's app id. Stored as given — it may be a bare numeric id or a
     * `gid://partners/App/<id>` GID, which is why every read normalises it through
     * `shared/helpers/partnerGid.helper` rather than assuming a form.
     */
    partner_api_app_id: string;
    /** App Store categories the listing sits in. Defaulted to `[]`, so always present. */
    categories: string[];
    /** Keywords you want this app to rank for. Defaulted to `[]`, so always present. */
    target_keywords: string[];
    is_active: boolean;
    /** Watermark for PARTNER_SYNC. Advanced ONLY after a fully successful pull. */
    last_synced_at?: Date | null;
    /** Watermark for BIGQUERY_SYNC (the three daily rollups). */
    last_bq_synced_at?: Date | null;
    /** Watermark for INSTALL_ATTRIBUTION_SYNC. Separate: far heavier scan, own failure domain. */
    last_install_attrib_synced_at?: Date | null;

    // ── Coverage gates ──────────────────────────────────────────────────────
    //
    // Declared by `models/partner/partnerApp.model` and written at the end of each successful sync.
    // All six are `Date | null` / `Number | null` with a schema default of `null`, and that `null`
    // means NOT YET MEASURED — it is an unknown, never a zero. They are typed here because a figure
    // cannot refuse to publish itself without reading them, and an undeclared field would come back
    // `undefined` from every document while the compiler agreed the read was legitimate.

    /** Oldest `occurred_at` in `gi_partner_app_events`. The floor of what the event record answers. */
    earliest_event_at?: Date | null;
    /**
     * Oldest `created_at` in `gi_partner_app_transactions`. The floor for MONEY, tracked separately
     * from `earliest_event_at` because payouts settle later than the charges that earned them and a
     * lifetime sync of one can succeed while the other fails.
     */
    earliest_transaction_at?: Date | null;
    /**
     * When a LIFETIME sync last completed, or `null` if none ever has. Until it is set, every
     * all-time figure is a FLOOR rather than a total.
     */
    lifetime_sync_completed_at?: Date | null;
    /**
     * Oldest `occurred_at` among events that carry a `shop_name` — the point above which real
     * store names exist and below which rows show their domain instead.
     *
     * The column is written as `$set` payload, so an INCREMENTAL sync fills only its own window.
     * Compare with `earliest_event_at`: equal means there is no boundary left to report; a date
     * here with an older `earliest_event_at` is the sentence in the model's note; `null` with a
     * non-null `earliest_event_at` means no sync has run since the `name` selection landed.
     */
    shop_name_coverage_since?: Date | null;
    /** Widest gap in whole days between consecutive events inside the covered window. `0` is real. */
    event_history_gap_days?: number | null;
    /** Percent (0–100) of charge-bearing rows carrying NO `charge_id`: the link was never captured. */
    charge_link_absent_pct?: number | null;
    /** Percent (0–100) of rows whose `charge_id` matches nothing: the link is dangling, not missing. */
    charge_link_unresolved_pct?: number | null;
    metadata?: Record<string, unknown>;
}

// ── Partner API facts ───────────────────────────────────────────────────────

/**
 * One Shopify Partner lifecycle event.
 *
 * `partner_event_id` is a LOCAL sha256 of (app, typename, occurredAt, shop_id, shop_domain,
 * charge_id) — not a Shopify id. Two events that differ in NOTHING but their timestamp's sub-second
 * component therefore collapse into one row, and `occurredAt` has no sub-second component.
 *
 * `charge_id` is in the hash on purpose: a plan change fires an ACCEPTED for the new charge in the
 * same second the old one is cancelled, and without the charge in the key those two collapse into
 * one — silently losing exactly the event a plan-change metric is counting.
 */
export interface PartnerAppEventDoc extends Timestamped {
    _id: ObjectIdLike;
    partner_app_id: ObjectIdLike;
    partner_event_id: string;
    event_type: string;
    /**
     * Shopify's `myshopifyDomain`, NORMALISED ON WRITE through `shared/helpers/shopDomain.helper` —
     * match it directly, do NOT re-normalise. The stored value IS the join key (bare, lowercased, no
     * scheme, no `www.`), shared with `PartnerAppTransactionDoc.shop_domain` and
     * `ListingInstallAttributionDoc.shop_domain`; the raw value Shopify sent is still in
     * `raw_event.shop.myshopifyDomain`. Normalising a needle before comparing is harmless and
     * correct (the function is idempotent) — normalising the STORED value on read is the waste this
     * guarantee exists to remove.
     */
    shop_domain: string;
    /** The Partner GID for the shop. Never stripped anywhere today. */
    shop_id: string;
    /**
     * The merchant-facing store name as the Partner API reported it, promoted out of
     * `raw_event.shop.name` and written as `$set` payload so a re-sync repairs it.
     *
     *  OPTIONAL, AND THAT IS NOT A STYLE CHOICE. This column was added after the collection was
     * in use, and a mongoose default is not retroactive — a `.lean()` read of a row written before
     * it returns NO `shop_name` key at all, so a non-optional declaration would type `undefined` as
     * a string and hand every caller a `.trim()` that throws. Treat `undefined` and `''` alike.
     *
     * NEITHER VALUE MEANS "THIS STORE HAS NO NAME". Shopify's `Shop.name` is non-null, so a shop
     * without one does not exist; an empty value means this row was written before the sync that
     * would have filled it. Report the boundary — `gi_partner_apps.shop_name_coverage_since` — and
     * fall back to `shop_domain` for display. Rendering the blank is a claim nobody measured.
     */
    shop_name?: string;
    /**
     * The Shopify charge this event is about, promoted out of the Mixed `raw_event.charge.id` and
     * NORMALISED ON WRITE to the bare numeric id by `shared/helpers/chargeId.helper` — so it joins
     * `PartnerAppTransactionDoc.charge_id` (stored in the same form) directly, with no GID stripping
     * on either side. Do not re-extract.
     *
     * Not optional: the schema declares `default: ''` and the writer always sets it, so it is
     * present on every row. `''` means the event carries no charge block — the four relationship
     * events never do — so it reads as "not about a charge", never "unknown charge": the strict
     * extractor refuses to store an id it could not parse.
     */
    charge_id: string;
    occurred_at: Date;
    /** The whole Partner API node, including the `charge { … }` block when the query requested it. */
    raw_event: Record<string, any>;
}

/**
 * One settled payout line.
 *
 * ⚠️ Cash, not run-rate. These rows are lumpy — annual prepayments, refunds, payout timing — and
 * must never be merged into an MRR figure. The Revenue view keeps the two strictly apart and
 * publishes the gap between them as a reconciliation, because the gap is diagnostic.
 */
export interface PartnerAppTransactionDoc extends Timestamped {
    _id: ObjectIdLike;
    partner_app_id: ObjectIdLike;
    shopify_transaction_id: string;
    type: string;
    /**
     * NORMALISED ON WRITE through `shared/helpers/shopDomain.helper` — match it directly, do NOT
     * re-normalise. The same guarantee, and the same join key, as `PartnerAppEventDoc.shop_domain`;
     * the raw value is still in `raw_transaction.shop.myshopifyDomain`. This is the key every
     * shop-keyed money figure in the module joins on, so a spelling mismatch here does not shrink a
     * number — it drops a store's revenue out of the total.
     */
    shop_domain: string;
    /** Always present: the schema declares `default: ''`, so an unknown shop stores '' rather than nothing. */
    shop_id: string;
    /**
     * The charge this payout settles, NORMALISED ON WRITE to the bare numeric id by
     * `shared/helpers/chargeId.helper` — match `PartnerAppEventDoc.charge_id` directly, do not strip
     * a GID. Storing it as the GID Shopify sends is why this join used to match nothing.
     *
     * Not optional: the schema declares `default: ''` and the writer always sets it. `''` means the
     * transaction type carries no charge id at all — only `AppSubscriptionSale` does — or that the
     * value was unparseable, which the strict extractor refuses to store rather than passing through.
     */
    charge_id: string;
    billing_interval?: string | null;
    gross_amount?: MoneyAmount;
    net_amount?: MoneyAmount;
    /** Shopify's cut. Persisted by the sync; net is what revenue figures use. */
    shopify_fee?: MoneyAmount;
    created_at: Date;
    /** The whole Partner API transaction node, exactly as it arrived. Fields vary by `__typename`. */
    raw_transaction?: Record<string, any>;
}

// ── Listing analytics rollups ───────────────────────────────────────────────

/**
 * One day of listing-page counts. Grain: (partner_app_id, date). Carries NO shop identity.
 *
 * ⚠️ These count VISITORS. Everything from `PartnerAppEventDoc` onward counts SHOPS. Any percentage
 * that crosses that seam compares two different populations, which is why the funnel view marks the
 * seam instead of quietly presenting the ratio as fact.
 */
export interface ListingFunnelDailyDoc extends Timestamped {
    _id: ObjectIdLike;
    partner_app_id: ObjectIdLike;
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
     * installs / views. `null` when the day had no views.
     *
     * NULLABLE, AND THE `number` THAT STOOD HERE OUTLIVED THE FIX THAT MADE IT WRONG.
     * `listingFunnelDaily.model.ts` stores `default: null` and `bigQuerySync.service.ts` writes
     * `rate()`, which answers `null` for an absent denominator — while this declaration still
     * promised a number. `findFunnelTrend` returns `ListingFunnelDailyDoc[]`, so
     * `row.overall_conversion_rate.toFixed(2)` COMPILED and threw at runtime on the first day
     * synced with no views. A type that is wider than the data is a nuisance; a type that is
     * narrower is a crash the compiler signed off on.
     *
     * A MEASURED zero still stores `0` — views with no installs is a real 0% — so a reader must
     * test for `null` explicitly and never for falsiness.
     */
    overall_conversion_rate: number | null;
    /** ad_clicks / installs. `null` when the day had no installs — see above. */
    ad_attributed_share: number | null;
    bytes_scanned?: number;
    source_bq_query_id?: string;
}

/**
 * Grain: (partner_app_id, date, traffic_source, traffic_medium).
 *
 * ⚠️ `traffic_source`/`traffic_medium` come from the analytics export's `traffic_source.*`, which is
 * the USER'S FIRST-EVER acquisition — not the visit that converted. A merchant first seen organically
 * months ago and installing today from a paid ad is booked as organic here, permanently.
 */
export interface ListingSourceDailyDoc extends Timestamped {
    _id: ObjectIdLike;
    partner_app_id: ObjectIdLike;
    date: Date;
    traffic_source: string;
    traffic_medium: string;
    users: number;
    views: number;
    install_clicks: number;
    installs: number;
}

/** Grain: (partner_app_id, date, country). */
export interface ListingGeoDailyDoc extends Timestamped {
    _id: ObjectIdLike;
    partner_app_id: ObjectIdLike;
    date: Date;
    country: string;
    views: number;
    installs: number;
    /**
     * installs / views for this country. `null` when the bucket had no views.
     *
     * Nullable for the same reason as {@link ListingFunnelDailyDoc.overall_conversion_rate}:
     * `listingGeoDaily.model.ts` defaults it to `null` and the sync writes `rate()`. A measured
     * zero is still `0`.
     */
    conversion_rate: number | null;
}

/**
 * One install event, with the store identity read out of the analytics export's `event_params`.
 *
 * The only per-store record the listing-analytics side has. `shop_domain` is normalised and is the
 * join key into `PartnerAppEventDoc.shop_domain`.
 */
export interface ListingInstallAttributionDoc extends Timestamped {
    _id: ObjectIdLike;
    partner_app_id: ObjectIdLike;
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
    /** WHICH analytics scope produced source/medium. Never let two scopes look alike. */
    attribution_source: string;
    /**
     * Shopify's documented value list is INCOMPLETE — production also carries `homepage_ad`.
     * Classify paid by the `_ad` SUFFIX, never by equality against a known list.
     */
    surface_type: string;
    /**
     * Shopify's own handle for the placement the merchant arrived through — a homepage section
     * handle, a category path, a collection title.
     *
     * ⚠️ LOAD-BEARING for the paid/organic split: `isPaidPlacement` reads `surface_type: home`
     * together with `surface_detail: homepage-ads` to tell an ad click from organic browsing, so
     * this field is not optional decoration on the stored document.
     *
     * ⚠️ On a SEARCH surface (`search` / `search_ad` / `guided_search`) the same field is the
     * merchant's typed query instead. This build does not capture or serve that half — gate every
     * read on the surface type rather than assuming one meaning.
     */
    surface_detail: string;
    /** 1-based results PAGE. Null, never 0 — a 0 reads as an impossibly good rank. */
    surface_inter_position?: number | null;
    /** 1-based position within that page. */
    surface_intra_position?: number | null;
    /** `ad_click_event` (ad journeys only) | `listing_url` (the only organic-capable source). */
    surface_via?: string;
    /** App Store UI variant, e.g. `simplified`. Undocumented by Shopify; observed in listing URLs. */
    surface_version?: string;
    ad_clicks_before_install: number;
    country: string;
    locale?: string;
    sync_job_id?: string;
}

// ── Operational ─────────────────────────────────────────────────────────────

/**
 * One unit of background work, and the durable source of truth for it.
 *
 * There is no message queue in this build: the runner polls this collection, so a row IS the job
 * rather than a record of one that lives somewhere else.
 */
export interface SyncJobDoc extends Timestamped {
    _id: ObjectIdLike;
    job_type: string;
    /**
     * The partner app this job ran for, denormalised out of `payload` so it is indexable.
     *
     * ⚠️ OPTIONAL, and genuinely absent on many rows — never assume it:
     *   - app-less job types (DUMMY) never carry one at all;
     *   - the enqueue path drops a malformed value rather than failing the enqueue on a CastError,
     *     so a job CAN carry `payload.partner_app_id` while this field is absent;
     *   - rows written by a version predating the field lack it, and there is no backfill.
     * `payload.partner_app_id` therefore remains the value the handlers read; this field exists for
     * QUERYING (`{ partner_app_id: 1, createdAt: -1 }`), not as the source of truth.
     */
    partner_app_id?: ObjectIdLike;
    payload?: Record<string, any>;
    status: string;
    /**
     * WHY not optional: the schema declares `triggered_by` `required: true` with an enum, and the
     * single writer always resolves a value, falling back to `SYNC_JOB_TRIGGERED_BY.MANUAL`. Typing
     * it optional would describe an absence mongoose rejects at insert time, and would hide the fact
     * that a job with no trigger provenance cannot exist.
     */
    triggered_by: string;
    triggered_by_user_id?: string;
    started_at?: Date | null;
    /**
     * When the job reached a terminal status.
     *
     * ⚠️ This — not `finished_at` — is the field the schema declares and the one every writer and
     * reader uses. A phantom `finished_at` once sat beside it on no schema at all: code reaching for
     * that name would have read `undefined` from every document while the compiler agreed the field
     * was legitimate, giving a silently-wrong terminal timestamp on the durable job ledger. Do not
     * reintroduce it under any spelling.
     */
    completed_at?: Date | null;
    duration_ms?: number | null;
    error_message?: string;
    error_stack?: string;
    failure_reason?: string;
    result_summary?: Record<string, any>;
    attempts?: number;
}

// ── Operators ───────────────────────────────────────────────────────────────

/**
 * An operator who may log in to this deployment.
 *
 * The one document in this file that is not analytics data. It lives here anyway because this file
 * is where PERSISTED shapes are declared and `shared/repositories/models.repository` is the only
 * place a shape is attached to a model — a second home for document types would mean a second place
 * to look, and eventually a second place that casts.
 *
 * There is no `partner_app_id` on it, and that is not an omission: an operator is not scoped to an
 * app. This build analyses one app, and everyone who can log in sees it.
 */
export interface AdminUserDoc extends Timestamped {
    _id: ObjectIdLike;
    /**
     * Login identity, stored lowercased and trimmed by the schema.
     *
     * ⚠️ Normalise the same way BEFORE querying (`String(email).trim().toLowerCase()`). Mongoose
     * applies `lowercase` to writes and to query casting on this path, but an aggregate does not
     * cast at all — so code that leans on the schema works right up until someone reaches for a
     * pipeline, and then silently matches nothing.
     */
    email: string;
    /**
     * bcrypt hash of the operator's password.
     *
     * ⚠️ `select: false` on the schema, so this is ABSENT from an ordinary read and typing it
     * optional is the truthful shape — a reader that finds it undefined has almost certainly
     * forgotten `.select('+password_hash')`, which only the login path should ever write.
     */
    password_hash?: string;
    /** Last successful login. `null` on an account that has been created but never used. */
    last_login_at?: Date | null;
}
