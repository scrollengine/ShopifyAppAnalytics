/**
 * ============================================================================
 *  SHOPIFY PARTNER API — APP IDENTIFIER CANONICALIZATION
 * ============================================================================
 *
 *  The Partner GraphQL API addresses an app by a GID in the `partners`
 *  namespace — `gid://partners/App/<numeric id>` — for BOTH `app(id: ID!)` and
 *  `transactions(appId: ID)`. It does NOT accept a bare numeric id: the
 *  resolver rejects it with
 *      INVALID_GID — "Invalid GID '7654321'. Global ID's use the following
 *      format 'gid://partners/$ModelName/$ModelId'"
 *
 *  GraphQL type-checking gives ZERO protection here. The `ID` scalar accepts
 *  any string or integer, so a bare numeric passes schema validation and is
 *  only rejected server-side at resolve time — which means the value has to be
 *  canonicalized before the request leaves this process.
 *
 *  Note the namespace split for the SAME numeric id: the Admin API uses
 *  `gid://shopify/App/<id>` while the Partner API uses `gid://partners/App/<id>`.
 *
 *  The Partner API has no `apps` connection and no lookup by handle or by
 *  apiKey — `app(id:)` is the only entry point — so a wrong id can never be
 *  recovered at runtime. We therefore accept every paste shape that
 *  unambiguously carries the numeric app id and REJECT everything else, so a
 *  bad value surfaces when the operator saves it instead of as an INVALID_GID
 *  inside a 3am cron.
 * ============================================================================
 */

const PARTNER_APP_GID_PREFIX = 'gid://partners/App/';

// `gid://partners/App/123` and `gid://shopify/App/123` (the Admin-API
// namespace for the same numeric id). Case-insensitive, and tolerant of a
// mistyped slash run or a trailing slash.
const _GID_PATTERN = /^gid:\/{1,3}(?:partners|shopify)\/app\/(\d+)\/?$/i;

// Partner Dashboard / Dev Dashboard app URLs, with or without scheme and with
// any trailing path, query, or fragment:
//   https://partners.shopify.com/<org id>/apps/<app id>/overview?date_range=...
//   https://dev.shopify.com/dashboard/<org id>/apps/<app id>
const _DASHBOARD_URL_PATTERN = /^(?:https?:\/\/)?[a-z0-9.-]*shopify\.com\/\S*\/apps\/(\d+)(?:[/?#]\S*)?$/i;

const _BARE_NUMERIC_PATTERN = /^\d+$/;

// A real Shopify app id is a positive integer with no leading zeros. Rejecting
// rather than coercing keeps a typo from being persisted as a valid-looking id.
const _POSITIVE_ID_PATTERN = /^[1-9]\d*$/;

const _buildGid = (digits: string | undefined): string | null => {
    if (!digits || !_POSITIVE_ID_PATTERN.test(digits)) {
        return null;
    }
    return `${PARTNER_APP_GID_PREFIX}${digits}`;
};

/**
 * Canonicalizes any recognizable Shopify Partner app identifier to
 * `gid://partners/App/<numeric id>`.
 *
 * Accepted inputs (whitespace and wrapping quotes are tolerated):
 *   - a bare numeric id             → "7654321"
 *   - a partners-namespace GID      → "gid://partners/App/7654321"
 *   - a shopify-namespace GID       → "gid://shopify/App/7654321"
 *   - a Partner/Dev Dashboard URL   → "https://partners.shopify.com/123/apps/7654321/overview"
 *
 * Deliberately rejected (returns null) because they cannot be resolved to an
 * app id: a Client ID / API key, an apps.shopify.com listing URL, an app
 * handle, a non-App GID such as `gid://partners/Shop/123`, and any non-positive
 * or non-integer id.
 *
 * @returns The canonical GID, or null when the input is not a recognizable app id.
 */
const normalizePartnerAppGid = (value: unknown): string | null => {
    if (typeof value !== 'string' && typeof value !== 'number') {
        return null;
    }

    let _raw = String(value).trim();
    // Tolerate a value copied out of JSON with its surrounding quotes.
    if (_raw.length >= 2 && /^(["']).*\1$/.test(_raw)) {
        _raw = _raw.slice(1, -1).trim();
    }
    if (!_raw) {
        return null;
    }

    if (_BARE_NUMERIC_PATTERN.test(_raw)) {
        return _buildGid(_raw);
    }

    const _gidMatch = _raw.match(_GID_PATTERN);
    if (_gidMatch) {
        return _buildGid(_gidMatch[1]);
    }

    const _urlMatch = _raw.match(_DASHBOARD_URL_PATTERN);
    if (_urlMatch) {
        return _buildGid(_urlMatch[1]);
    }

    return null;
};

// Shown to the operator on both the create path and the sync path so a bad id
// is always explained the same way.
const PARTNER_APP_GID_HELP_MESSAGE = 'partner_api_app_id must be the Shopify Partner app id — the number after /apps/ in the Partner Dashboard URL (e.g. 7654321), or the full gid://partners/App/7654321. A Client ID / API key or an apps.shopify.com listing URL will not work.';

export = {
    normalizePartnerAppGid,
    PARTNER_APP_GID_PREFIX,
    PARTNER_APP_GID_HELP_MESSAGE
};
