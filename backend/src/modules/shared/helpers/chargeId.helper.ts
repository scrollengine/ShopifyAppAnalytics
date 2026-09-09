/**
 * THE charge join key for the whole growth module, in one place.
 *
 * Shopify hands us the same charge under two spellings:
 *   - Partner API  — a GID: `gid://shopify/AppSubscription/12345` (on the event's `charge { id }`
 *     block, and on `AppSubscriptionSale.chargeId`)
 *   - our own DB   — `ApplicationCharge.id`, a **String** holding the bare numeric id
 *
 * Every join between them goes through this function, on the WRITE side now that
 * `gi_partner_app_event.charge_id` and `gi_partner_app_transaction.charge_id` are first-class
 * indexed fields — so a stored charge id is already the bare numeric form and a reader can match
 * `ApplicationCharge.id` directly instead of re-extracting a GID in JavaScript on every row.
 *
 * It lives here, beside `shopDomain`, for the same reason that one does: it is the second of the
 * module's three join bridges, and a bridge with two implementations is a bridge that drifts. The
 * loose variant still in `conversion/shared/shopJourneyBuilder._extractChargeNumericId` is exactly
 * that drift — it matches "the last run of digits anywhere" and returns the ORIGINAL STRING when
 * there are no digits at all. Do not use it as the model for anything new.
 */

/**
 * Strips a Shopify GID down to the bare numeric id that `ApplicationCharge.id`
 * stores, e.g. 'gid://shopify/AppSubscription/12345' -> '12345'.
 *
 * Deliberately anchored to the FINAL PATH SEGMENT rather than "the last run of
 * digits anywhere". The loose form silently returns the wrong id for anything
 * carrying a suffix (`.../12345?index=0` yields '0'), and — worse — returned the
 * ORIGINAL STRING when the input held no digits at all, which puts a GID into an
 * `$in` against numeric ids and matches nothing without ever erroring. A value we
 * cannot parse must be `null` so the caller can count it as unresolved.
 *
 * @param rawId - A GID, a bare numeric id, or anything at all.
 * @returns The numeric id as a String, or null when unparseable.
 */
const extractChargeNumericId = (rawId: any): string | null => {
    if (rawId === null || rawId === undefined) {
        return null;
    }
    const s = String(rawId).trim();
    if (s === '') {
        return null;
    }
    const lastSegment = s.split('/').pop() || '';
    const m = lastSegment.match(/^(\d+)$/);
    if (!m) {
        return null;
    }
    return m[1];
};

export = { extractChargeNumericId };
