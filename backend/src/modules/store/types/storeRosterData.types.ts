/**
 * ============================================================================
 *  WHAT THE STORE-ROSTER REPOSITORY HANDS BACK — the data layer's shapes
 * ============================================================================
 *
 *  Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 *  Deliberately SEPARATE from `storeRoster.types.ts`. That file is the response contract: every name
 *  in it is read by a React component, and a rename there blanks a column. Nothing in THIS file
 *  reaches the wire. Keeping the two apart is what stops a query's convenience field from drifting
 *  into the payload, and stops a payload rename from being blocked by a query.
 *
 *  ── Why the repository returns ROWS and not answers ─────────────────────────
 *  Every shape here is a projection of stored documents, not a judgement about them. Which name
 *  wins, whether a store counts as installed, what a blank domain means — all of that belongs to the
 *  resolvers and the service, because those are what a test reaches, and it must be possible to
 *  reach them without a database. The repository's only opinions are which index to use and what to
 *  exclude, and it REPORTS every exclusion rather than absorbing it.
 * ============================================================================
 */

// ── The relationship spine ──────────────────────────────────────────────────

/**
 * One INSTALL / REINSTALL / UNINSTALL / DEACTIVATED event, projected to what the install-state fold
 * reads.
 *
 * ⚠️ `raw_event` IS NOT PROJECTED, and that absence is the single biggest cost decision in this
 * module. It is a Mixed blob holding the whole Partner node; pulling it for every relationship event
 * in the install base would multiply the bytes crossing the wire by an order of magnitude for two
 * fields that are already columns. `shop_name` is a column because phase 1 promoted it precisely so
 * this read would not need the blob.
 */
export interface StoreRelationshipEventRow {
    /** Already canonical — normalised on write. The row identity and every join key. */
    shop_domain: string;
    event_type: string;
    occurred_at: Date;
    /**
     * ⚠️ OPTIONAL AND OFTEN ABSENT. The column postdates the collection, and a mongoose default is
     * not retroactive: a `.lean()` read of a row written before it returns NO key at all. `undefined`
     * and `''` must be treated alike, and NEITHER means "this store has no name" — Shopify's
     * `Shop.name` is non-null. It means this row predates the sync that would have filled it, which
     * is what `gi_partner_apps.shop_name_coverage_since` measures.
     */
    shop_name?: string;
    /** The Partner GID for the shop, e.g. `gid://partners/Shop/17`. `''` on rows that carried none. */
    shop_id: string;
}

/**
 * The relationship events plus the one thing a bare row list cannot say: what the query threw away.
 *
 * `shopless_relationship_events` exists because the blank-domain filter is LOAD-BEARING and its
 * exclusions are otherwise invisible. Drop the filter and every shopless event pools into one
 * synthetic store; keep it silently and the rows vanish with no trace. Keeping it AND returning the
 * count is the only option that is neither wrong nor silent.
 */
export interface StoreRelationshipEventResult {
    rows: StoreRelationshipEventRow[];
    /** Relationship events whose `shop_domain` was blank or absent, and so joined nothing. */
    shopless_relationship_events: number;
}

// ── The money side ──────────────────────────────────────────────────────────

/**
 * Lifetime settled payouts for one store, across EVERY transaction type.
 *
 * ⚠️ `total_gross` is the sum of what the MERCHANT paid, and it includes `APP_CREDIT` and
 * `APP_ADJUSTMENT`, which are negative. That is deliberate: "total spend" net of refunds is the
 * honest reading of what this store has paid, and excluding credits would publish a lifetime figure
 * larger than the money that actually changed hands.
 */
export interface StoreSpendRow {
    shop_domain: string;
    /** Sum of `gross_amount.amount` — merchant-facing, refunds included as negatives. */
    total_gross: number;
    /** Sum of `net_amount.amount` — after Shopify's cut. Published beside gross, never merged. */
    total_net: number;
    /** How many settled payout rows this store has. A count, not an amount. */
    transaction_count: number;
    first_payment_at: Date | null;
    last_payment_at: Date | null;
    /**
     * Every distinct currency seen on this store's payouts.
     *
     *  Usually one entry, and the fold publishes a currency only when it IS one. `FIDELITY.md`
     * records the unconverted-currency sum as a standing caveat on every money figure in this build:
     * there is no FX table here, so a store billed in two currencies has a `total_spend` that is a
     * sum of unlike units. Publishing the SET is what lets the read layer refuse to caption it.
     */
    currencies: string[];
}

/**
 * Settled `APP_SUBSCRIPTION` payouts, grouped by the charge they settle.
 *
 * Three answers come out of one read, because they are three readings of the same fact:
 *   - the SIGN of `settled_count`, which decides the state of any subscription Shopify gave us no
 *     `billingOn` for — money either moved for that charge or it provably did not;
 *   - `billing_interval`, the ONLY place Shopify exposes a subscription's cadence, taken from the
 *     most recent payout for that charge;
 *   - the newest payout's amount and instant, which is what the canonical MRR predicate
 *     (`modules/revenue`'s `liveSetAsOf`) evaluates to decide whether the store is paying TODAY.
 *
 * Restricted to `APP_SUBSCRIPTION`: usage and one-time charges are real money and are not evidence
 * that a SUBSCRIPTION converted. Counting them would report a store that bought a single add-on as a
 * paying subscriber.
 */
export interface StoreSettledChargeRow {
    /** `''` when the payout carried no charge id — then only the domain-scoped fallback can use it. */
    charge_id: string;
    /** Canonical on write. The coarser fallback key, used only for charge-less subscriptions. */
    shop_domain: string;
    /** Settled payouts observed for this charge. Only the SIGN is read — presence, not multiplicity. */
    settled_count: number;
    /**
     * The interval on the most recent settled payout for this charge, or `null`.
     *
     * `null` STAYS `null`. A null interval booked as monthly is how an annual subscriber gets
     * reported at twelve times their true rate.
     */
    billing_interval: string | null;
    /** `gross_amount.amount` of the most recent settled payout for this charge. */
    latest_gross: number;
    /** `gross_amount.currency` of that same payout. */
    latest_currency: string;
    /** Shopify's SETTLEMENT instant for it. ⚠️ `created_at`, never `createdAt`. */
    latest_settled_at: Date | null;
}

// ── The attribution join ────────────────────────────────────────────────────

/**
 * One listing-analytics install record, projected to what a store row renders.
 *
 * A store can have SEVERAL of these — one per install the analytics export saw — which is why the
 * whole list is returned rather than a per-domain winner. Picking the winner is a judgement
 * (nearest-in-time to the Partner install instant, not latest-overall) and judgements live above the
 * repository, where they can be exercised against fixtures.
 *
 * ⚠️ `country` IS projected here, unlike the install cohort's twin read which deliberately omits it.
 * The difference is the field it feeds: this module publishes it as `install_country` — the country
 * the INSTALL TRAFFIC came from — and never as `country`, which is the merchant's registered country
 * and is operator-only. The install cohort has no `install_country` field, so for that read the
 * value could only have been misused.
 */
export interface StoreAttributionRow {
    shop_domain: string;
    /** From the analytics `shop_name` param. `''` is normal and falls back to the partner name. */
    shop_name: string;
    /**
     * The analytics install instant. ⚠️ A DIFFERENT CLOCK from `PartnerAppEventDoc.occurred_at`: one
     * is a server-side analytics hit, the other Shopify's `occurredAt`. They sit minutes to hours
     * apart, which is why the match is nearest-in-time and why the lag is published.
     */
    installed_at: Date;
    source: string;
    medium: string;
    campaign: string;
    /** `event_collected` | `user_first_acquisition` | `none`. Two scopes must never look alike. */
    attribution_source: string;
    surface_type: string;
    /**
     * Shopify's own handle for the placement the merchant arrived through — a homepage section
     * handle, a category path, a collection title.
     *
     * ⚠️ LOAD-BEARING, and the reason this field must stay projected out of Mongo and carried on
     * this row. `isPaidPlacement` reads `surface_type: home` together with
     * `surface_detail: homepage-ads` to tell an ad click from organic browsing — production held 49
     * installs labelled that way against just 3 under the `homepage_ad` surface name, so dropping
     * this value re-reads those 49 as organic and nothing errors.
     */
    surface_detail: string;
    /** Optional on the stored document — a legacy row carries neither. The fold folds to `null`. */
    surface_inter_position?: number | null;
    surface_intra_position?: number | null;
    /**
     * GA4 `geo.country` for the install event: a common NAME ("United States"), inferred from the
     * VISITOR's geolocation on a server-side Measurement Protocol hit.
     *
     *  NOT the merchant's registered country, and the two must never be merged into one column.
     * They disagree routinely and legitimately — an agency in Ireland setting up a US merchant's
     * store, a founder installing while travelling.
     */
    country: string;
}

// ── Query inputs ────────────────────────────────────────────────────────────

/** Every read here is app-scoped and lifetime. The roster has no window; see the service. */
export interface StoreRosterQuery {
    partner_app_id: string;
}

/**
 * A read bounded at the judgement instant.
 *
 * A SEPARATE SHAPE PURELY SO THE BOUND CANNOT BE FORGOTTEN. The install cohort's twin read was once
 * issued unbounded and reported a named merchant as CONVERTED before they had paid, because future
 * revenue was admitted while future churn was excluded. Every read that feeds a STATE takes this
 * shape; the ones that feed identity do not, because identity has no as-of.
 */
export interface StoreRosterAsOfQuery extends StoreRosterQuery {
    /**
     * The instant every comparison in one request is made against.
     *
     * ⚠️ On the transaction reads this is matched against `created_at` — Shopify's SETTLEMENT
     * timestamp — and NEVER `createdAt`, which `timestamps` writes when WE inserted the row. They
     * are different facts one character apart, and bounding on the wrong one does not error: it
     * clamps by sync time, so a lifetime backfill falls inside every window at once.
     */
    as_of: Date;
}
