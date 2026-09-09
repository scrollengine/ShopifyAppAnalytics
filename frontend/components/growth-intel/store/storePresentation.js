/**
 * ONE presentation vocabulary for store rows, wherever they are rendered.
 *
 * WHY
 * ---
 * Store data was being rendered by two unrelated tables — the Subscriptions list (Polaris
 * IndexTable) and the install cohort on Funnel (a hand-rolled <table>) — each with its
 * own date formatter, its own badge tones and its own idea of what a store row looks like. The same
 * store therefore read differently depending on which page you were on. Worst of it: ON_TRIAL was
 * `info` in one table and `attention` in the other, so identical state, different colour.
 *
 * TWO ENUMS, ONE LIFECYCLE
 * ------------------------
 * The backend deliberately keeps two vocabularies for the same journey and maps between them in
 * `conversion/shared/conversionConstants.ts` → SUBSCRIPTION_STATE_TO_LIFECYCLE:
 *
 *   subscription state        lifecycle state       (both mean the same thing)
 *   ON_TRIAL              →   ON_TRIAL
 *   PAYING                →   CONVERTED
 *   CHURNED_DURING_TRIAL  →   CHURNED_IN_TRIAL
 *   CHURNED_AFTER_TRIAL   →   CHURNED
 *   (no subscription)     →   INSTALLED
 *
 * Rather than rename either — the subscription values are the API's tab filters, and the lifecycle
 * values are the cohort's filter values — this file gives every key of BOTH enums the same tone, so
 * a state is always the same colour no matter which endpoint produced the row. Labels still come
 * from the endpoint (`state_label` / `status_label`) with these as the fallback.
 *
 * ⚠️ If a state is added to either enum in the backend, add it here in the same change. A key with
 * no entry renders an untoned badge with its raw SCREAMING_SNAKE value — no error, just wrong.
 */

// The only import this presentation module takes: the twelve dashboard paths, so `safeBackPath`
// tests one shared allowlist rather than a private copy that can drift from the router.
import { DASHBOARD_ROUTES, isDashboardRoute } from '../../../utils/dashboardRoutes';

// Keyed by BOTH vocabularies. The pairs below must agree: PAYING and CONVERTED are one state.
export const STORE_STATE_TONE = {
    // No subscription at all — a state, not a gap.
    INSTALLED: 'info',
    ON_TRIAL: 'attention',
    PAYING: 'success',
    CONVERTED: 'success',
    CHURNED_DURING_TRIAL: 'warning',
    CHURNED_IN_TRIAL: 'warning',
    CHURNED_AFTER_TRIAL: 'critical',
    CHURNED: 'critical'
};

export const STORE_STATE_LABELS = {
    INSTALLED: 'Installed only',
    ON_TRIAL: 'On trial',
    PAYING: 'Paying',
    CONVERTED: 'Converted',
    CHURNED_DURING_TRIAL: 'Churned during trial',
    CHURNED_IN_TRIAL: 'Left during trial',
    CHURNED_AFTER_TRIAL: 'Churned after trial',
    CHURNED: 'Churned'
};

// ⚠️ A SEPARATE vocabulary from STORE_STATE_* above, deliberately. There, `INSTALLED` means
// "installed and never subscribed" (a subscription lifecycle state). Here it means "the app is on the
// store right now" (an install state). A store can be one and not the other, so one map for both would
// make a single word mean two things.
export const INSTALL_STATE_LABELS = {
    INSTALLED: 'Installed',
    UNINSTALLED: 'Uninstalled',
    UNKNOWN: 'Install state unknown'
};

export const INSTALL_STATE_TONE = {
    INSTALLED: 'success',
    UNINSTALLED: 'critical',
    // Untoned on purpose: "we have no install/uninstall event for this store" is an absence of
    // evidence, not a bad outcome, and colouring it would read as one.
    UNKNOWN: undefined
};

/**
 * Shopify's billing cadence, as a word rather than as an API token.
 *
 * Mirrors `BILLING_INTERVAL_LABELS` in `backend/src/modules/store/constants/storeRoster.constants.ts`
 * — which existed from the first release but was reachable only as a FACET OPTION label, so the plan
 * sub-line on the table and the drawer both printed the raw enum: "$29.00 EVERY_30_DAYS".
 *
 * ⚠️ `UNKNOWN` is "no settled payout has named a cadence yet", NOT "monthly". The backend keeps the
 * interval null rather than defaulting it precisely because booking an annual subscription as
 * monthly reports that merchant at twelve times their true rate; the label says the unknown out loud
 * so nobody fills it in on the client instead.
 */
export const BILLING_INTERVAL_LABELS = {
    EVERY_30_DAYS: 'Monthly',
    ANNUAL: 'Annual',
    UNKNOWN: 'Cadence not settled yet'
};

/**
 * The readable cadence for a plan sub-line, or `''` when there is none to state.
 *
 * `''` rather than a fallback word, so the caller drops the line entirely: a cadence the ledger has
 * not named is exactly the case the backend publishes `null` for.
 *
 * @param {String|null} interval - `plan_interval` off a store row or detail record.
 * @returns {String} The label, the raw value for a cadence this build has not learned yet, or `''`.
 */
export const planIntervalLabel = (interval) => {
    if (!interval) return '';
    return BILLING_INTERVAL_LABELS[interval] || String(interval);
};

/**
 * A THIRD vocabulary, and deliberately so — it answers a question the other two cannot express.
 *
 * `STORE_STATE_*` and `INSTALL_STATE_*` above are both SNAPSHOTS ("what is this store"). This one
 * is a DELTA ("what changed between two instants"), which is what the MRR movement drill-down is
 * actually asking: they chose plan X back then — did they upgrade, downgrade, or leave?
 *
 *  NO WORD IS SHARED WITH EITHER MAP ABOVE. `INSTALLED` already means two different things across
 * the two existing groups and survives only because they are separately labelled; a third meaning
 * would make the collision unrecoverable. Every value here is a verb about movement, and none of
 * these six strings appears in the backend's INSTALL_STATES, STORE_LIFECYCLE_STATES or
 * SUBSCRIPTION_STATES. These six values mirror the movement-since vocabulary the analytics
 * backend emits; they are its keys, not ours, so they are not renamed for presentation.
 *
 *  IT IS ONLY ABOUT MONEY. `STOPPED_PAYING` means "not on a paid plan today" and says NOTHING
 * about whether the app is still installed — that is `install_state`, from a different source, in
 * its own column. Rendering them as one badge would attach event-sourced certainty to a charge-row
 * inference and would hide the most actionable row on the panel: a store that still has the app and
 * simply stopped paying.
 */
export const MOVEMENT_SINCE_LABELS = {
    SAME_PLAN: 'Same plan',
    PLAN_CHANGED: 'Changed plan',
    UPGRADED: 'Upgraded',
    DOWNGRADED: 'Downgraded',
    STOPPED_PAYING: 'Stopped paying',
    RESUBSCRIBED: 'Paying again'
};

// Tones agree with STORE_STATE_TONE's logic so one screen reads consistently: a full loss is
// `critical` (as CHURNED_AFTER_TRIAL is), a partial loss is `warning` (as CHURNED_DURING_TRIAL is),
// and revenue kept or gained is `success`. SAME_PLAN is untoned on purpose — it is the majority
// answer and the null result, and colouring the majority tells the reader nothing.
export const MOVEMENT_SINCE_TONE = {
    SAME_PLAN: undefined,
    PLAN_CHANGED: 'info',
    UPGRADED: 'success',
    DOWNGRADED: 'warning',
    STOPPED_PAYING: 'critical',
    RESUBSCRIBED: 'success'
};

/**
 * What each state means, spelled out — every one of these is a claim a reader will act on, and two
 * of them are claims about the LIMITS of the data rather than about the store.
 */
export const MOVEMENT_SINCE_HELP = {
    SAME_PLAN: 'Still paying, same plan and same amount.',
    PLAN_CHANGED: 'Still paying the same amount, but on a differently named plan.',
    UPGRADED: 'Paying more today than at the end of this period.',
    DOWNGRADED: 'Paying less today, but still a paying customer.',
    STOPPED_PAYING: 'Not on a paid plan today. This cannot tell a move to the free plan from a charge that simply stopped — check the install column for whether the app is still on the store.',
    RESUBSCRIBED: 'Stopped paying during this period and is paying again today.'
};

// Mirrors ACQUISITION_CHANNELS / ACQUISITION_CHANNEL_LABELS in conversionConstants.ts.
export const ACQUISITION_CHANNEL_LABELS = {
    APP_STORE_AD: 'Shopify App Store ad',
    APP_STORE_SEARCH: 'App Store search',
    APP_STORE_BROWSE: 'App Store browsing',
    REFERRAL: 'Referral',
    ORGANIC_SEARCH: 'Organic search',
    PAID: 'Paid campaign',
    DIRECT: 'Direct',
    UNKNOWN: 'Not attributed'
};

// Paid channels are the ones worth spotting at a glance, so they carry the only strong tone.
// DIRECT and UNKNOWN are deliberately untoned: between them they are the overwhelming majority of
// rows, and colouring the majority tells the reader nothing.
export const ACQUISITION_CHANNEL_TONE = {
    APP_STORE_AD: 'success',
    PAID: 'success',
    APP_STORE_SEARCH: 'info',
    ORGANIC_SEARCH: 'info',
    APP_STORE_BROWSE: 'info',
    REFERRAL: 'attention',
    DIRECT: undefined,
    UNKNOWN: undefined
};

/**
 * Tab order mirrors the lifecycle: live states first, then the two exits. The ids are the API's
 * own filter values, so they must not be renamed for presentation.
 */
export const SUBSCRIPTION_TABS = [
    { id: 'ALL', label: 'All' },
    { id: 'PAYING', label: 'Paying' },
    { id: 'ON_TRIAL', label: 'On trial' },
    { id: 'CHURNED_DURING_TRIAL', label: 'Churned during trial' },
    { id: 'CHURNED_AFTER_TRIAL', label: 'Churned after trial' }
];

/**
 * App Store surface vocabulary — the frontend mirror of the surface constants the analytics
 * backend attributes installs with.
 *
 * Defined ONCE here rather than re-derived in each renderer: three components branch on it, and a
 * surface added in one and missed in another shows up as a silently missing badge, not an error.
 */
export const SEARCH_SURFACES = ['search', 'search_ad', 'guided_search'];

const _cleanSurface = (t) => String(t || '').trim().toLowerCase();

/**
 * True on the App Store's search surfaces.
 *
 * This is the dividing line for `surface_detail`, which is DUAL PURPOSE. On every other surface it
 * is Shopify's own taxonomy or section handle — the home-page section on `home`, the category
 * titles on `category` — and can be shown as "Found via". On these three it is not taxonomy at all,
 * so callers gate on this rather than rendering the field everywhere.
 */
export const isSearchSurface = (t) => SEARCH_SURFACES.includes(_cleanSurface(t));

/**
 * True for any PAID surface.
 *
 *  Suffix, never equality with 'search_ad'. Production carries `homepage_ad`, which Shopify's own
 * documented value list omits, so per-surface ad variants exist for surfaces nobody has enumerated.
 */
export const isPaidSurface = (t) => {
    const s = _cleanSurface(t);
    return s.length > 3 && s.endsWith('_ad');
};

/**
 * Surfaces where `surface_inter_position` counts RESULT PAGES.
 *
 *  Elsewhere the same field is a SECTION index, numbered from the top of the page
 * (track-listing-traffic.md:214-219). Labelling every value "Page N" states a falsehood on half of
 * them: a homepage install found in the 4th section would read as "page 4 of the homepage".
 */
export const PAGE_INDEXED_SURFACES = ['search', 'search_ad', 'guided_search', 'category', 'collection'];

/**
 * "Page 2 · #4" or "Section 3 · #1" — whichever the surface actually means.
 *
 * Returns '' when nothing was captured, so callers render nothing at all rather than a 0, which
 * would read as an impossibly good rank instead of "not measured".
 */
export const surfacePositionLabel = (surfaceType, interPosition, intraPosition) => {
    const parts = [];
    if (interPosition) {
        const unit = PAGE_INDEXED_SURFACES.includes(_cleanSurface(surfaceType)) ? 'Page' : 'Section';
        parts.push(`${unit} ${interPosition}`);
    }
    if (intraPosition) {
        parts.push(`#${intraPosition}`);
    }
    return parts.join(' \u00B7 ');
};

/** Short human label for a surface: 'Organic' / 'Paid' / 'Guided', else the raw value. */
export const surfaceLabel = (t) => {
    const s = _cleanSurface(t);
    if (s === 'search') return 'Organic';
    if (s === 'search_ad') return 'Paid';
    if (s === 'guided_search') return 'Guided';
    return s;
};

/**
 *  THE NULL GUARD MUST COME BEFORE `Number()`, AND `Number.isFinite` IS NOT ONE.
 *
 * `Number(null)` is `0` and `Number('')` is `0`, and `Number.isFinite(0)` is `true` — so a
 * `!Number.isFinite(Number(n))` test reaches its dash branch for `undefined` and `NaN` and NEVER for
 * `null`, which is the ONE value the store endpoints publish to mean "not measured". Verified by
 * execution: `null -> $0.00`, `'' -> $0.00`, `undefined -> —`.
 *
 * That mattered on two whole surfaces at once. `GET /api/stores` deliberately returns
 * `monthly_spend: null` / `total_spend: null` / `plan_price: null` for a store that never settled a
 * subscription payout (`storeRow.resolver.ts` — "we did not evaluate this"), and
 * `GET /api/stores/detail` returns `lifetime_value: null` / `average_spend: null` / `mrr: null`.
 * Through the old test those became `$0.00`: two entire columns of fabricated zeros on the Stores
 * table, three of the four stat tiles and both Activity fields in the drawer — each one a specific,
 * checkable claim that a merchant pays nothing. It is IMPLEMENTATION.md §4.5's regression reaching
 * the screen through the formatter rather than through a `|| 0`, and it defeats the entire
 * null-vs-zero design of the store module.
 *
 * `components/growth-intel/moneyFormat.js` has always tested `n === null` FIRST, which is why its
 * copy was right; these three now do the same.
 *
 * @param {*} n - Any value off a response.
 * @returns {Boolean} True when the value is an absence rather than a number.
 */
const _isUnknown = (n) => {
    if (n === null || n === undefined || n === '') return true;
    return !Number.isFinite(Number(n));
};

/**
 * Money for DISPLAY: `$`, two decimals, locale-grouped. `—` for anything that is not a number.
 *
 * A null `mrr` / `plan_price` / `lifetime_value` is the API saying "no sync has run" or "we did not
 * measure this", and it must never render as a confident, specific, checkable amount the backend
 * never published. `—` is the only honest answer. `0` still prints `$0.00`, because a measured zero
 * is an answer.
 *
 * NOT re-exported from `../moneyFormat`, whose `fmtMoney` also returns the dash: that one emits the
 * digits WITHOUT a currency symbol, and every caller here relies on the `$`. The two agree on the
 * unknown case and differ on the symbol on purpose.
 *
 * @param {Number} n
 * @returns {String}
 */
export const fmtMoney = (n) => {
    if (_isUnknown(n)) return '—';
    const v = Number(n);
    return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** A count. `—` for an absence, `0` for a measured zero. Same guard as `fmtMoney`, same reason. */
export const fmtNum = (n) => {
    if (_isUnknown(n)) return '—';
    return Number(n).toLocaleString();
};

export const fmtDate = (d) => {
    if (!d) return '—';
    try {
        return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
        return String(d);
    }
};

export const fmtDateLong = (d) => {
    if (!d) return '—';
    try {
        return new Date(d).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    } catch (e) {
        return String(d);
    }
};

/**
 * A rate expressed as a FRACTION (0.15 → `15%`), rounded to whole percent.
 *
 * ⚠️ `null` is `—`, not `0%`. `installCohort`'s `summary.attribution_coverage` is null rather than 0
 * when there were no installs to attribute, and "0% of installs could be attributed" is a measured
 * claim about acquisition that nobody made.
 */
export const fmtPct = (n) => {
    if (_isUnknown(n)) return '—';
    return `${(Number(n) * 100).toFixed(0)}%`;
};

/**
 * The detail-page URL for a store row — `null` today, always, because there is no such page.
 *
 * THE PAGE THIS LINKED TO DOES NOT EXIST. It built `/subscriptions/<key>`, and
 * `pages/subscriptions/` holds a single `index.js` and NO dynamic route — nothing matches a
 * trailing path segment. Every store-name link, every ⌘/Ctrl-click and the drawer's "Open full
 * page" button landed on a 404. A dead link is the same failure as a manufactured zero: it asserts
 * something the app cannot back up, and the reader only finds out after paying for the click.
 *
 * TO RE-ENABLE: add `pages/subscriptions/[key].js` — reading `key` off the router
 * segment, `app` and `from` off the query, resolving the fetch through `storeDetailRequestParams`
 * and rendering `StoreDetailContent`. Then restore the body below; the arguments it needs are still
 * taken, so no call site changes on that day.
 *
 * The `from` argument records the page the reader came from so the detail page's back arrow can
 * return THERE rather than to a hardcoded Subscriptions, which is wrong from every other entry
 * point — the Stores list, the install cohort on Funnel — and silently loses the
 * filters, search and page the reader had set. `safeBackPath` below is what reads it back.
 *
 * Both call sites already branch on a null url and render plain text in place of the link
 * (`StoreTable._renderStore`, `StoreDetailDrawer`'s `fullPageMarkup`), so nothing renders as a
 * disabled or dead anchor.
 *
 * @param {Object} row - kept for the restored body: `tenant_id` when present, else `shop_domain`.
 * @param {String} appId - kept for the restored body: the `?app=` param.
 * @param {String} [from] - kept for the restored body: the current in-app path (e.g. `router.asPath`).
 * @returns {null} Until the dynamic route named above exists.
 */
export const storeDetailUrl = (row, appId, from) => null;

/**
 * Resolve a `from` query param into a safe in-app path.
 *
 *  NEVER navigate to a raw query param. `from=https://evil.com` or the protocol-relative
 * `from=//evil.com` would take the reader off the app — a client-side push, but still a redirect an
 * attacker controls via a link. Only a path that starts with a single `/` and NAMES ONE OF THE
 * TWELVE DASHBOARD ROUTES is accepted; anything else falls back to the default.
 *
 * THIS READ `from.startsWith('/growth-intel/')` WHILE THE SCREENS SAT UNDER THAT PREFIX, and the
 * flatten to top-level routes is exactly the edit a mechanical rewrite gets wrong here: swapping in
 * `/overview/` leaves a test that rejects `/stores`, `/revenue` and every other real destination,
 * so the back arrow would silently land on Subscriptions from everywhere. There is no prefix left
 * that covers the twelve and excludes the outside world — the allowlist in
 * `utils/dashboardRoutes.js` is what replaces it, and it is STRICTLY tighter than the prefix ever
 * was: `/\evil.com` and every other near-miss now fail on not being a known route at all.
 *
 * @param {String} from
 * @param {String} fallback
 */
export const safeBackPath = (from, fallback = DASHBOARD_ROUTES.SUBSCRIPTIONS) => {
    if (typeof from !== 'string' || !from) return fallback;
    // `//host` is protocol-relative and resolves to a DIFFERENT ORIGIN despite starting with a slash.
    if (!from.startsWith('/') || from.startsWith('//')) return fallback;
    // ⚠️ TEST THE PATH, RETURN THE WHOLE THING. `from` is `router.asPath`, so it carries the
    // reader's filters, search and page in the query string — which is the entire reason it is
    // passed. Matching the allowlist against the un-split string would reject every filtered list.
    if (!isDashboardRoute(from.split(/[?#]/)[0])) return fallback;
    return from;
};

/**
 * Reduce a shop URL or domain to the bare, lowercased myshopify domain.
 *
 * The client mirror of the analytics backend's own shop-domain normaliser. The
 * backend normalises every needle it receives, so this is NOT needed to make a
 * lookup succeed — it is needed so the CLIENT can recognise two spellings of one
 * store as the same store. Some rows carry the domain RAW off the GA4 export
 * while every other list carries it normalised, so `https://x.myshopify.com` and
 * `x.myshopify.com` would otherwise be cached, and re-fetched, as two different
 * stores.
 */
export const normaliseShopDomain = (rawUrl) => {
    if (!rawUrl) return '';
    let s = String(rawUrl).trim().toLowerCase();
    if (s === '') return '';
    s = s.replace(/^https?:\/\//, '');
    s = s.replace(/^www\./, '');
    const slash = s.indexOf('/');
    if (slash !== -1) {
        s = s.slice(0, slash);
    }
    s = s.replace(/\.$/, '');
    return s.trim();
};

/** A 24-character hex string is a Mongo id; anything else is a myshopify domain. */
const isObjectIdLike = (value) => /^[a-f0-9]{24}$/i.test(String(value || ''));

/**
 * The identity key for a store row: its tenant id when it has one, else its domain.
 *
 *  `tenant_id` is an EMPTY STRING — not null, not absent — on a store that
 * installed and never onboarded to the analytics backend, and it is missing entirely from
 * install-cohort rows. That population is the MAJORITY of any install base, so a
 * caller that reads `row.tenant_id` directly silently does nothing for most rows
 * rather than erroring. `||` is what makes the fallthrough work; do not "tidy"
 * it to `??`, which would keep the empty string.
 */
export const storeRowKey = (row) => (row && row.tenant_id) || (row && row.shop_domain) || '';

/**
 * Build the query params for `subscriptions/detail` from a store identity key.
 *
 *  Exactly ONE identity key goes on the wire. The service matches with an OR
 * (`row.tenant_id === needle || row.shop_domain === needle`), so sending both a
 * tenant id and a domain that disagree resolves to whichever row matches EITHER
 * — silently rendering the WRONG store. And a non-hex string sent as `tenant_id`
 * throws a CastError inside the installed-only fallback, which surfaces as a
 * generic "failed to fetch" rather than "not found".
 *
 * Shared by the detail page (whose key comes from the URL segment) and the
 * drawer (whose key comes from the clicked row) so the discriminator cannot
 * drift between them.
 *
 * @param {String} key   - `tenant_id` or `shop_domain`.
 * @param {String} appId - partner app id.
 * @returns {Object|null} params, or null when either input is missing.
 */
export const storeDetailRequestParams = (key, appId) => {
    if (!key || !appId) return null;
    const params = { partner_app_id: appId };
    if (isObjectIdLike(key)) {
        params.tenant_id = String(key);
    } else {
        params.shop_domain = normaliseShopDomain(key);
    }
    return params;
};
