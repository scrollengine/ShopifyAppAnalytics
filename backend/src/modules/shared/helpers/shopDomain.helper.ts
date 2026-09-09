/**
 * THE join key for the whole growth module, in one place.
 *
 * Three systems each hold a shop's myshopify domain in a slightly different shape:
 *   - `gi_partner_app_events.shop_domain` — written RAW from Shopify's `myshopifyDomain`
 *   - `gi_listing_install_attributions.shop_domain` — from GA4's `shop_url` event param, which
 *     may or may not carry a scheme (Shopify's doc does not say)
 *   - `StoreDetail.store_url` — our own record
 *
 * Every join between them goes through this function, on BOTH sides, so a scheme or a capital
 * letter cannot silently drop a store out of a count. It lives here rather than beside any one
 * consumer because importing it from the BigQuery service would pull @google-cloud/bigquery into
 * the conversion path for the sake of a string helper.
 *
 * Historically this was hand-rolled per call site — `.trim().toLowerCase()` in one service,
 * `.trim()` only in another — which is exactly how two implementations of one bridge drift.
 */

/**
 * Reduces any shop URL or domain to the bare, lowercased myshopify domain used as the join key.
 *
 * Returns an empty string rather than null for anything unusable, so callers can compare without a
 * null check and an unresolvable value can never be mistaken for a real domain.
 */
const normaliseShopDomain = (rawUrl: unknown): string => {
    if (!rawUrl) {
        return '';
    }
    let s = String(rawUrl).trim().toLowerCase();
    if (s === '') {
        return '';
    }
    s = s.replace(/^https?:\/\//, '');
    s = s.replace(/^www\./, '');
    const slash = s.indexOf('/');
    if (slash !== -1) {
        s = s.slice(0, slash);
    }
    s = s.replace(/\.$/, '');
    return s.trim();
};

export = { normaliseShopDomain };
