/**
 * ============================================================================
 *  WHAT THE INSTALL-COHORT REPOSITORY HANDS BACK — the data layer's shapes
 * ============================================================================
 *
 *  Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 *  Deliberately SEPARATE from `installCohort.types.ts`. That file is the frozen response contract:
 *  every name in it is read by a React component, and a rename there blanks a column. Nothing in
 *  THIS file reaches the wire. Keeping the two apart is what stops a query's convenience field from
 *  drifting into the payload, and stops a payload rename from being blocked by a query.
 *
 *  ── Why the repository returns ROWS and not answers ─────────────────────────
 *  Every shape here is a projection of stored documents, not a judgement about them. Which
 *  attribution row wins, whether a settled payout counts, what a blank domain means — all of that is
 *  the service's, because the service is what a job runner or a test reaches and it must be possible
 *  to reach those decisions without a database. The repository's only opinions are which index to
 *  use and what to exclude, and it REPORTS every exclusion rather than absorbing it.
 * ============================================================================
 */

// ── The install spine ───────────────────────────────────────────────────────

/**
 * One store on the spine: it fired at least one INSTALL/REINSTALL inside the window.
 *
 * THIS IS THE POPULATION. Nothing downstream may add a row or remove one — every join is a LEFT
 * join onto this set, and a join that could drop a row would turn a missing subscription or a
 * missing attribution record into a missing MERCHANT.
 */
export interface InstallSpineRow {
    /** Already canonical — normalised on write. The row identity and every join key. */
    shop_domain: string;
    /** `$min(occurred_at)` across the window's install events for this store. */
    installed_at: Date;
    /** How many install events this store contributed. A reinstaller contributes more than one. */
    install_count: number;
}

/**
 * The spine plus the one thing a bare row list cannot say: what the query threw away.
 *
 * `shopless_install_events` exists because `shop_domain: { $ne: '' }` is LOAD-BEARING and its
 * exclusions are otherwise invisible. Drop the filter and every shopless event pools into one
 * synthetic store counted as 1; keep it and the rows vanish with no trace. Keeping the filter AND
 * returning the count is the only option that is neither wrong nor silent.
 */
export interface InstallSpineResult {
    /** Sorted by `shop_domain` ascending, so chunking and every downstream tie-break are stable. */
    rows: InstallSpineRow[];
    /** Install events inside the window whose `shop_domain` was blank or absent. */
    shopless_install_events: number;
}

// ── The attribution join ────────────────────────────────────────────────────

/**
 * One listing-analytics install record, projected to what the cohort row actually renders.
 *
 * A store can have SEVERAL of these — one per install the analytics export saw — which is exactly
 * why the whole list is returned rather than a per-domain winner. Picking the winner is a judgement
 * (nearest-in-time to the Partner install instant, not latest-overall) and judgements live in the
 * service, where they can be exercised against fixtures.
 *
 * ⚠️ `country` is deliberately NOT projected. It is the analytics export's `geo.country`, a common
 * NAME ("United States"), and `StoreTable` renders `country` in a two-character slot as an ISO-2
 * code. Fetching it would only make it tempting to emit it.
 */
export interface CohortAttributionRow {
    /** Canonical on write on BOTH sides of this join — match directly, never re-normalise. */
    shop_domain: string;
    /** From the analytics `shop_name` param. `''` is normal and renders as the domain. */
    shop_name: string;
    /**
     * The analytics install instant. ⚠️ A DIFFERENT CLOCK from `PartnerAppEventDoc.occurred_at`:
     * one is a server-side analytics hit, the other Shopify's `occurredAt`. They sit minutes to
     * hours apart, which is why the match is nearest-in-time and why the lag is published.
     */
    installed_at: Date;
    source: string;
    medium: string;
    campaign: string;
    /** `event_collected` | `user_first_acquisition` | `none`. Two scopes must never look alike. */
    attribution_source: string;
    surface_type: string;
    /**
     * Shopify's own handle for the placement — a homepage section handle, a category path, a
     * collection title.
     *
     * ⚠️ PROJECTED AND CARRIED DELIBERATELY: `classifyAcquisitionChannel` reads
     * `surface_type: home` plus `surface_detail: homepage-ads` to tell an ad click from organic
     * browsing (49 installs in production wear that pair against 3 under the `homepage_ad` surface
     * name). Drop it from the projection and those installs re-read as browsing, with nothing
     * failing to say so.
     */
    surface_detail: string;
    /** Optional on the stored document — a legacy row carries neither. The service folds to `null`. */
    surface_inter_position?: number | null;
    surface_intra_position?: number | null;
}

// ── The settled-payout evidence ─────────────────────────────────────────────

/**
 * Settled `APP_SUBSCRIPTION` payouts, grouped by the charge they settle.
 *
 * This is what makes the second branch of the state machine EVIDENCE rather than a guess: with no
 * `billingOn` from Shopify, money either provably moved for this charge or it provably did not.
 *
 * The join key is the BARE NUMERIC charge id on both sides — `gi_partner_app_events.charge_id`
 * and `gi_partner_app_transactions.charge_id` are each normalised on write through
 * `shared/helpers/chargeId.helper`. Storing one as a GID is why this join used to match nothing.
 */
export interface SettledSubscriptionChargeRow {
    /** `''` when the payout carried no charge id — then only the domain-scoped fallback can use it. */
    charge_id: string;
    /** Canonical on write. The coarser fallback key, used only for charge-less subscriptions. */
    shop_domain: string;
    /** Settled payouts observed. Only the SIGN is read — presence, never multiplicity. */
    settled_count: number;
    /**
     * The interval on the most recent settled payout for this charge, or `null`.
     *
     * `null` STAYS `null`. `FIDELITY.md` §5 records that a null interval booked as monthly is how
     * an annual subscriber gets reported at twelve times its true rate; the cohort table's price
     * sub-line is gated on this being truthy, so an unknown interval correctly hides the price
     * rather than captioning it with an invented cadence.
     */
    billing_interval: string | null;
}

// ── Query inputs ────────────────────────────────────────────────────────────

/** The window for the install spine. `since: null` is lifetime — the query then has no lower bound. */
export interface InstallSpineQuery {
    partner_app_id: string;
    since: Date | null;
    until: Date | null;
}

/**
 * The charge-event pull.
 *
 * THERE IS NO `since`, AND THAT IS THE POINT. A store that installed inside the window may have
 * subscribed at any moment before it; a lower bound on this scan hides that subscription and reports
 * a paying customer as `INSTALLED`.
 */
export interface CohortEventQuery {
    partner_app_id: string;
    /** The judgement instant. Bound the fetch here or a future event classifies a past row. */
    until: Date;
    /** The install spine. Fanned out in `DOMAIN_CHUNK_SIZE` chunks, sequentially. */
    domains: readonly string[];
}

/** A domain-scoped fan-out with no time bound of its own. */
export interface CohortDomainQuery {
    partner_app_id: string;
    domains: readonly string[];
}

/**
 * The settled-payout read: domain-scoped like its parent, and BOUNDED AT THE JUDGEMENT INSTANT.
 *
 * A SEPARATE SHAPE PURELY SO THE BOUND CANNOT BE FORGOTTEN. This read is the evidence behind
 * the second branch of the state machine, and it was once issued unbounded: a payout that settled in
 * June was admitted into a January window, and a store whose ACCEPTED event carried no
 * `charge.billingOn` was therefore reported CONVERTED — with `state_basis: 'settled_payout'`, on a
 * named merchant, as of a date they had not yet paid. The error only ever ran one way, because the
 * other two inputs ARE clamped (the event pull at `occurred_at: { $lte: as_of }`, and
 * `classifyAsOf`'s churn clamp): future churn was excluded while future revenue was admitted, so
 * `by_state.CONVERTED` over-counted and `ON_TRIAL` under-counted.
 *
 * Widening `CohortDomainQuery` itself would have handed the same field to the attribution read,
 * which does NOT bound on it — and a parameter that some readers honour and others ignore is how the
 * next reader concludes that everything here is as-of when only some of it is.
 */
export interface SettledChargeQuery extends CohortDomainQuery {
    /**
     * The judgement instant, matched against Shopify's SETTLEMENT timestamp.
     *
     * ⚠️ The field is `created_at` — when Shopify settled the money — and NOT `createdAt`, which
     * `timestamps` adds and records when we inserted the row. They are different facts one character
     * apart, and bounding on the wrong one does not error: it clamps by SYNC time, so a lifetime
     * backfill puts the whole ledger inside every window.
     */
    as_of: Date;
}
