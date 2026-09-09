/**
 * ============================================================================
 *  WHAT THE CUSTOM-FUNNEL REPOSITORY HANDS BACK — the data layer's shapes
 * ============================================================================
 *
 *  Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 *  Deliberately SEPARATE from `customFunnel.types.ts`, for the same reason `installCohortData` is
 *  separate from `installCohort`: that file is the frozen response contract, every name in it is
 *  read by a React component, and a rename there blanks part of a chart. Nothing in THIS file
 *  reaches the wire. Keeping them apart is what stops a query's convenience field from drifting
 *  into the payload, and stops a payload rename from being blocked by a query.
 *
 *  ── WHY EVERY SHOP SET IS KEYED ON `shop_domain` AND NOT `shop_id` ────────
 *
 *  The system this was ported from counted distinct `shop_id`. That column is the Partner GID and
 *  is `''` on older event rows in this build — which is the exact defect
 *  `resolvers/chargeCohort.resolver.ts` documents in its own header, where keying on it merged many
 *  subscriptions into one fabricated row. Here it would do something quieter and worse: `installed`
 *  would count a different population from `summary.installs` in the install-cohort table directly
 *  beneath it on the same page, and the two panels would disagree with no way to tell which was
 *  right. `shop_domain` is canonical on write (`partnerSync.service.ts`), is the join key every
 *  other shop-keyed figure in this application already uses, and is what the install spine is built
 *  from.
 * ============================================================================
 */

// ── Shop sets, per event or transaction type ────────────────────────────────

/**
 * The distinct shops that fired one event type inside the window.
 *
 * THE SET, NOT A COUNT. A funnel step may span several types, and its number is the UNION of
 * their shop sets — never the sum of their counts, which double-counts every shop that fired both
 * and produces a larger, entirely plausible figure. A repository returning per-type COUNTS makes
 * that mistake unavoidable at the next layer.
 */
export interface PartnerShopSetRow {
    event_type: string;
    /** Distinct `shop_domain`, already excluding the blanks (which are counted separately). */
    shops: string[];
}

/** Per-type shop sets plus the count of what the blank-domain filter excluded. */
export interface PartnerShopSetResult {
    rows: PartnerShopSetRow[];
    /**
     * Events in the window whose `shop_domain` was blank or absent.
     *
     * The filter is LOAD-BEARING and its exclusions are otherwise invisible. Drop it and every
     * shopless event pools into one synthetic shop counted as 1; keep it silently and the rows
     * vanish with no trace. Only "filter and report" is neither wrong nor silent.
     */
    shopless_events: number;
}

/** The distinct shops whose NET for one payout type was above zero inside the window. */
export interface TransactionShopSetRow {
    type: string;
    /**
     * ⚠️ Net is summed PER SHOP before the sign is tested, so a shop whose refunds cancel its
     * payments is correctly not counted as having paid. Testing each row's sign instead would count
     * it on the strength of the payment and ignore the credit.
     */
    shops: string[];
}

// ── Query inputs ────────────────────────────────────────────────────────────

/** A window over `occurred_at`. `since: null` is lifetime — the query then has no lower bound. */
export interface FunnelEventWindowQuery {
    partner_app_id: string;
    /** ONLY the types the selected steps actually need. An unbounded `$in` scans for nothing. */
    event_types: readonly string[];
    since: Date | null;
    until: Date | null;
}

/** A window over `created_at` — Shopify's SETTLEMENT timestamp, never our insert time. */
export interface FunnelTransactionWindowQuery {
    partner_app_id: string;
    types: readonly string[];
    since: Date | null;
    until: Date | null;
}

/**
 * The first-ever-payout read.
 *
 * ⚠️ The window is applied to the ALL-TIME `$min(created_at)`, not to the rows. That ordering is
 * what makes the answer "first ever, and it happened here" rather than "transacted in this window".
 */
export interface FunnelFirstTransactionQuery {
    partner_app_id: string;
    since: Date | null;
    until: Date | null;
}

/**
 * The charge-cohort event pull.
 *
 * THERE IS NO `since`, AND THAT IS THE POINT. A subscription that converts inside the window may
 * have started at any point before it; a lower bound here hides the start, and `window_kpi` then
 * reports fewer conversions than actually happened.
 */
export interface FunnelChargeCohortQuery {
    partner_app_id: string;
    /** The judgement instant. Bound the fetch here or a future event classifies a past row. */
    until: Date;
}

/** The settled-payout evidence read, bounded at the judgement instant like its cohort. */
export interface FunnelSettledChargeQuery {
    partner_app_id: string;
    /**
     * ⚠️ Matched against `created_at` — when Shopify settled the money — NEVER `createdAt`, which
     * `timestamps` writes when we inserted the row. Bounding on the wrong one does not error: it
     * clamps by sync time, so a lifetime backfill falls inside every window at once.
     */
    as_of: Date;
}

/** Charge ids and shop domains with at least one settled `APP_SUBSCRIPTION` payout. */
export interface FunnelSettledChargeResult {
    /** Bare numeric ids, joining `gi_partner_app_events.charge_id` directly. */
    charge_ids: string[];
    /** The coarser fallback, used only for a subscription carrying no charge id at all. */
    shop_domains: string[];
}
