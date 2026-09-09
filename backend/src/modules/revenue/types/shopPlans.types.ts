/**
 * ============================================================================
 *  BATCH SHOP-PLAN LOOKUP — the response contract
 * ============================================================================
 *
 *  Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 *  ── WHAT THIS ENDPOINT REPLACES, AND WHAT IT CANNOT ─────────────────────────────────────────
 *
 *  The dashboard this page came from read the live plan out of a vendor-owned `store_details`
 *  collection — a record of every merchant store, refreshed from the Shopify Admin API. A
 *  self-hosted install of this project has no such collection and no Admin API credential for
 *  anybody else's store: the ONLY data source here is the Partner API.
 *
 *  So the plan is served from what this build genuinely holds — `raw_event.charge.name` on the
 *  subscription charge events, folded through the canonical charge cohort — and the two facts that
 *  came from `store_details` and NOT from the Partner API are handled explicitly rather than
 *  guessed. See `store_active` below, which is the one that matters.
 *
 *  ──  EVERY REQUESTED DOMAIN GETS AN ENTRY ─────────────────────────────────────────────────
 *
 *  A domain with no subscription on record is published with `resolved: false` and a reason, NEVER
 *  omitted. Omission and "we looked and found nothing" are indistinguishable to a caller doing a map
 *  lookup, so a silent miss reads as a store the endpoint decided not to answer about — and the
 *  caller cannot tell whether to retry, to re-sync, or to stop asking.
 * ============================================================================
 */

/** What one requested domain resolved to. */
export interface ShopPlanRow {
    /** The canonical `shop_domain` the lookup was performed against, after normalisation. */
    shop_domain: string;
    /**
     * The plan's merchant-facing name, from `raw_event.charge.name`.
     *
     * `null` when no subscription charge event for this store names one — which happens when the
     * store's charge events were never synced, or when it has genuinely never subscribed. NEVER a
     * guess, and never borrowed from another store or from an amount.
     */
    plan_title: string | null;
    /** `charge.amount.amount` on the same charge, or `null`. ⚠️ `0` is a real price, not an absence. */
    plan_price: number | null;
    /** The currency that price is in. `''` when the charge payload named none. */
    currency: string;
    /** `PAYING` | `ON_TRIAL` | `CHURNED_DURING_TRIAL` | `CHURNED_AFTER_TRIAL`, or null. */
    subscription_state: string | null;
    /**
     * Whether the store is in the paying set RIGHT NOW, by the canonical as-of predicate.
     *
     * Published so a caller never has to infer "is this plan live" from the plan's NAME. A store can
     * hold a named plan and not be paying — that is precisely the row worth finding.
     */
    is_paying_now: boolean;
    /**
     * Whether the charge behind the plan is a TEST charge.
     *
     * ⚠️ ALWAYS `false`, AND THAT IS A MEASUREMENT RATHER THAN A DEFAULT. The charge cohort drops
     * `raw_event.charge.test === true` BEFORE folding, so a resolved subscription is non-test by
     * construction. A test-only store therefore never resolves at all and comes back with
     * `resolved: false` — which is the honest answer, since we hold no live subscription for it.
     */
    is_test: boolean;
    /**
     *  NOT A MEASUREMENT. Always `true`, and `store_active_measured` is the field that says so.
     *
     * The consumer renders a critical "Uninstalled" badge whenever this is FALSY, so the three
     * candidate values are not symmetric:
     *
     *   - `false`  ⇒ "this merchant removed the app" — a specific, checkable claim about a specific
     *                store, which nothing in this endpoint's data supports;
     *   - absent / `null` ⇒ the SAME badge, because `!undefined` is `true`;
     *   - `true`   ⇒ no badge at all, i.e. the endpoint makes no claim either way.
     *
     * Only the third says nothing, so it is the only honest value to send. Whether the app is still
     * installed is decided by the four relationship events (INSTALL / REINSTALL / UNINSTALL /
     * DEACTIVATED, latest wins, DEACTIVATED taking an exact tie) in
     * `modules/store/resolvers/installState.resolver` — private by that module's explicit design —
     * and the Stores page answers it properly. Deriving a second answer here would drift from that
     * one without either page looking wrong.
     */
    store_active: boolean;
    /**  `false`, always. The truth behind `store_active`: nothing here measured install state. */
    store_active_measured: boolean;
    /** True when a subscription was found for this domain. `false` is an ANSWER, not an omission. */
    resolved: boolean;
    /** Why nothing was found, in the reader's language. `null` on a resolved row. */
    unknown_reason: string | null;
}

/** The `data` payload of a successful `getShopPlans` call. */
export interface ShopPlansData {
    partner_app_id: string;
    /** ISO. The instant every row was classified at. */
    as_of: string;
    /**
     * Domain → row, keyed by the string the CALLER SENT, verbatim.
     *
     * ⚠️ Not by the normalised form. A caller does `plans[row.shop_domain]` with the domain it
     * already holds, and re-keying the answer under a canonicalised spelling would make every lookup
     * miss for any caller whose input was not already canonical — a total, silent failure that looks
     * exactly like "no store has a plan". The normalised domain the match was actually made on
     * travels INSIDE the row.
     */
    plans: Record<string, ShopPlanRow>;
    /** How many of the requested domains resolved to a subscription. */
    resolved_count: number;
    /** How many did not. Each still has an entry, with its own reason. */
    unresolved_count: number;
    /** ⚠️ UNIQUE STRINGS — a consumer keying them by content drops a duplicate and its condition. */
    warnings: string[];
    /** `READY` | `NEVER_SYNCED`, decided by the WATERMARK and never by a row count. */
    data_state: string;
    /** The reason nothing could be answered at all. `null` on a normal response. */
    unknown_reason: string | null;
}

/**
 * Input to `getShopPlans`.
 *
 * A POST body rather than a query string: the caller sends up to 200 domains at once, and a
 * 200-element repeated query parameter is at the mercy of every proxy's URL length limit — a limit
 * whose failure mode is a truncated list silently answering for fewer stores.
 */
export interface GetShopPlansParams {
    partner_app_id?: string;
    /**
     * The domains to look up.
     *
     * Accepts an array, or a comma-joined string, because both forms reach an Express handler
     * depending on how the client serialises. Blank and duplicate entries are dropped rather than
     * refused — a caller's list is data, not an argument worth failing a whole page over.
     */
    shop_domains?: string[] | string;
}
