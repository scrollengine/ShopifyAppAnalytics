'use strict';

/**
 * ============================================================================
 *  THE APP ROW, AS IT GOES ONTO THE WIRE
 * ============================================================================
 *
 *  ONE serializer, reached by every endpoint in this area — register, list,
 *  read, update and soft delete. PURE: it takes a lean document and returns a
 *  plain object, with no repository, no config and no clock.
 *
 *  ── WHY THIS IS A FILE AND NOT A PRIVATE FUNCTION PER SERVICE ──────────────
 *
 *  Five endpoints return the same record. A second copy of this function would
 *  not fail loudly — it would drift: one endpoint's `coverage` block would gain
 *  a gate the other's did not, and an operator comparing the row they just
 *  saved against the row in the list would find fields that come and go with no
 *  pattern. The `??` on the numeric gates below is the specific thing a hand
 *  copy gets wrong, and it is the difference between "no gap wider than a day"
 *  and "never measured".
 *
 *  ── THE COVERAGE GATES TRAVEL WITH THE ROW, DELIBERATELY ───────────────────
 *
 *  They are what tells a reader how much weight this app's figures will bear,
 *  and a dashboard that shows the numbers while keeping their coverage internal
 *  is precisely the failure this project exists to refuse.
 * ============================================================================
 */

import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { SerializedPartnerApp } from '../types/partnerApp.types';

/**
 * Shapes an app row for the wire.
 *
 * `null` in any gate means NOT MEASURED — a reader must not render it as zero.
 *
 * @param doc - The lean document.
 * @returns The wire shape, or null when there was no document.
 */
const serializePartnerApp = (doc: PartnerAppDoc | null | undefined): SerializedPartnerApp | null => {
    if (!doc) {
        return null;
    }
    return {
        app_id: String(doc._id),
        app_handle: doc.app_handle,
        display_name: doc.display_name,
        listing_url: doc.listing_url,
        partner_api_app_id: doc.partner_api_app_id,
        is_active: doc.is_active,
        //  PUBLISHED BECAUSE PATCH ACCEPTS THEM. `PATCH /api/partner-apps/:id` writes
        // `categories` and `target_keywords`, and the edit form loads its initial values from THIS
        // row — so a row that omitted them handed the form two blank text inputs, and the form's
        // own `_csvToArray('')` is `[]`. Saving anything else on that screen would then have
        // written an empty array over stored values nobody touched: a silent wipe, with a
        // successful save toast on top of it. A field that is writable must be readable.
        //
        // `|| []` rather than `?? []`: the schema defaults both to `[]`, so the only falsy value
        // either can hold is a missing key on an older document — and an ABSENT array is the same
        // "nothing recorded" as an empty one. There is no zero-versus-unknown distinction to lose
        // here, unlike the numeric gates below.
        categories: doc.categories || [],
        target_keywords: doc.target_keywords || [],
        last_synced_at: doc.last_synced_at || null,
        lifetime_sync_completed_at: doc.lifetime_sync_completed_at || null,
        coverage: {
            earliest_event_at: doc.earliest_event_at || null,
            earliest_transaction_at: doc.earliest_transaction_at || null,
            shop_name_coverage_since: doc.shop_name_coverage_since || null,
            // `?? null`, not `|| null`: a measured ZERO is a real answer here — "no gap wider than a
            // day", "no missing charge links" — and `||` would turn every one of them into "never
            // measured". That is the exact zero-versus-unknown collapse the whole project is about,
            // and it is the line a hand-written second copy of this function gets wrong.
            event_history_gap_days: doc.event_history_gap_days ?? null,
            charge_link_absent_pct: doc.charge_link_absent_pct ?? null,
            charge_link_unresolved_pct: doc.charge_link_unresolved_pct ?? null
        },
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt
    };
};

export = {
    serializePartnerApp
};
