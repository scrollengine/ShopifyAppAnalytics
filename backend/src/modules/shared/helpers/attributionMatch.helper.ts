'use strict';

/**
 * ============================================================================
 *  WHICH LISTING-ANALYTICS RECORD DESCRIBES THIS INSTALL?
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, no clock. One rule, in one place, because two
 *  readers now need it: the install cohort (`modules/conversion`) and the store roster
 *  (`modules/store`). It lives in `shared/` for the same reason `shopDomain.helper` does — both
 *  sides of a join that is defined once cannot drift, and this IS a join, made in JavaScript
 *  because the two clocks it bridges never agree exactly.
 *
 *  ── NEAREST, NOT LATEST, AND THE DIFFERENCE HAS ALREADY COST DATA ──────────────────────────
 *
 *  The implementation this was ported from documented "nearest, not after" and actually took the
 *  LATEST row overall — so a shop that reinstalled a year later had the LATER visit's acquisition
 *  channel attached to the EARLIER install, silently rewriting how that store was acquired.
 *
 *  There is no tolerance window and there cannot be an exact match: `installed_at` on an attribution
 *  row is a server-side analytics hit timestamp and the Partner API's `occurredAt` is Shopify's own
 *  clock, and the two sit minutes to hours apart for the SAME install. Nearest-in-time is the honest
 *  rule; the caller publishes the matched row's own instant and the signed lag beside it so the
 *  match a reader is looking at can be audited rather than trusted.
 *
 *  Ties keep the EARLIER row, because callers pass their list sorted by `installed_at` ascending and
 *  the comparison below is strict — so the same request always picks the same row.
 * ============================================================================
 */

/**
 * The record nearest in time to a given instant.
 *
 * Generic over anything carrying an `installed_at`, so it needs no dependency on either module's
 * row type — a `.lean()` attribution document satisfies it, and so does a hand-built fixture.
 *
 * @param [rows] - Every record for one store, oldest first. May be empty.
 * @param installedAt - The instant to match against, normally the Partner install event.
 * @returns The nearest record, or null when there is none to pick from.
 */
const pickNearestByInstalledAt = <T extends { installed_at: Date }>(
    rows: readonly T[] | undefined | null,
    installedAt: Date
): T | null => {
    if (!rows || rows.length === 0) {
        return null;
    }
    const target = installedAt.getTime();
    let best: T | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;

    for (const row of rows) {
        const at = row.installed_at instanceof Date ? row.installed_at.getTime() : Number.NaN;
        if (!Number.isFinite(at)) {
            // `installed_at` is `required` on the schema, so this is unreachable from a stored
            // document. Skipped rather than defaulted: a row whose instant we cannot read cannot be
            // audited against the install it is being attached to.
            continue;
        }
        const delta = Math.abs(at - target);
        if (delta < bestDelta) {
            best = row;
            bestDelta = delta;
        }
    }

    return best;
};

export = { pickNearestByInstalledAt };
