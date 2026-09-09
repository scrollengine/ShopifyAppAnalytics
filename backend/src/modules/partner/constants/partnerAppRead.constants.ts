'use strict';

/**
 * ============================================================================
 *  THE PARTNER APPS PAGE — vocabulary shared by the KPI and the event reads
 * ============================================================================
 *
 *  Dependency-free apart from the Partner event vocabulary, so the pure trend
 *  helper and both services read it without any layer reaching sideways.
 *
 *  ── `data_state` IS A WIRE CONTRACT ────────────────────────────────────────
 *
 *  `frontend/components/growth-intel/dataState.js` decodes exactly these two
 *  strings. They are PINNED here rather than derived, and they are a fourth
 *  local spelling of the same pair — `modules/conversion`, `modules/store` and
 *  `modules/revenue` each declare their own, none publishes it on a barrel, and
 *  no module in this codebase reaches into another's constants folder for one.
 *  Two strings restated is cheaper than the import that would make them shared.
 *
 *  ──  THE TREND'S GRAIN IS DECIDED BY THE WINDOW, NOT BY THE CALLER ───────
 *
 *  `components/growth-intel/InstallTrendChart.js` renders one point per array
 *  entry with `dot={false}` and no downsampling, so an "All time" window at day
 *  grain is six thousand points crushed into 280 pixels — a solid block of ink
 *  that reads as noise. Above `TREND_DAY_GRAIN_MAX_DAYS` the series switches to
 *  calendar months and says so on the payload (`trend_grain`), so the reader is
 *  never left inferring the grain from the label format.
 * ============================================================================
 */

// `export =` module — a named import here is TS2497, so it is imported whole and destructured.
import partnerVocab = require('../../../constants/partnerVocab.constants');

const { PARTNER_EVENT_TYPES } = partnerVocab;

/**
 * ⚠️ `READY` | `NEVER_SYNCED`, decided by the WATERMARK and never by a row count.
 *
 * `last_synced_at` is stamped only when BOTH halves of a sync succeeded, so its absence is the one
 * authoritative "we have never looked". An empty event collection is not: an app whose merchants
 * have not installed it this month and an app nobody has ever synced produce the identical empty
 * result set, and only the watermark separates them.
 */
const PARTNER_APP_DATA_STATES = Object.freeze({
    READY: 'READY',
    NEVER_SYNCED: 'NEVER_SYNCED'
} as const);

/** The banner body published with `data_state: 'NEVER_SYNCED'`. */
const NEVER_SYNCED_REASON = 'No Partner API sync has completed for this app yet, so nothing has been '
    + 'fetched. Every figure here is withheld rather than shown as zero — we have not looked, which is not '
    + 'the same as an app nobody has installed. Trigger a sync from the Sync page and these fill in.';

/**
 * The four RELATIONSHIP event types, in the order the KPI publishes them.
 *
 * ⚠️ FOUR, NOT TWO. `partnerVocab.constants` states the rule: a fold that considers only
 * INSTALL/UNINSTALL "leaves every reactivated shop permanently uninstalled and every frozen shop
 * permanently installed — both wrong, both silent."
 *
 * ⚠️ `DEACTIVATED` IS PUBLISHED SEPARATELY AND IS NEVER SUMMED INTO `uninstalls`. A merchant who
 * removed the app and a shop Shopify froze are two different events with two different meanings, and
 * `AppKpiCards` prints the uninstall tile under the label "Uninstalls" — folding freezes into it
 * would accuse merchants of leaving who did nothing at all.
 */
const RELATIONSHIP_EVENT_TYPES: readonly string[] = Object.freeze([
    PARTNER_EVENT_TYPES.INSTALL,
    PARTNER_EVENT_TYPES.UNINSTALL,
    PARTNER_EVENT_TYPES.REINSTALL,
    PARTNER_EVENT_TYPES.DEACTIVATED
]);

/** The counted key each relationship event type lands on, so the mapping is declared once. */
const RELATIONSHIP_COUNT_KEYS: Readonly<Record<string, string>> = Object.freeze({
    [PARTNER_EVENT_TYPES.INSTALL]: 'installs',
    [PARTNER_EVENT_TYPES.UNINSTALL]: 'uninstalls',
    [PARTNER_EVENT_TYPES.REINSTALL]: 'reinstalls',
    [PARTNER_EVENT_TYPES.DEACTIVATED]: 'deactivations'
});

/** Every event type an `?type=` filter may name. Anything else WIDENS the result and warns. */
const FILTERABLE_EVENT_TYPES: readonly string[] = Object.freeze(Object.values(PARTNER_EVENT_TYPES));

// ── The window ──────────────────────────────────────────────────────────────

/**
 * The KPI's default window, matching `pages/apps/index.js`'s own `KPI_PERIOD_DAYS`
 * and `AppKpiCards`' fallback label ("Last 30 days"). An omitted range therefore resolves to the
 * window the page would have asked for, so the label the card prints is the window it was served.
 */
const DEFAULT_KPI_PERIOD_DAYS = 30;

/** Longest window that is plotted one point per DAY. Above it the series is monthly. */
const TREND_DAY_GRAIN_MAX_DAYS = 92;

/**
 * How far back an "All time" trend reaches when the app row carries NO `earliest_event_at`.
 *
 * ⚠️ A FALLBACK FOR THE AXIS, NEVER FOR A FIGURE. It is reached only when a sync has completed and
 * measured no earliest event — i.e. the collection holds nothing — so every bucket it produces is
 * empty by construction and no count depends on the number. Picking one is still better than an
 * unbounded walk back to 2009, which would draw two hundred blank months.
 */
const LIFETIME_TREND_FALLBACK_DAYS = 365;

/**
 * Hard ceiling on plotted points, applied to BOTH grains.
 *
 * The day grain cannot reach it (a 92-day window is 93 points); the month grain can, on a lifetime
 * window over a long-lived app. When it bites the series keeps the MOST RECENT buckets and the
 * response says how many were withheld — a silently truncated chart is a chart that lies about
 * where its history starts.
 */
const MAX_TREND_POINTS = 120;

/** Series grain, published on the payload so nobody infers it from the label format. */
const TREND_GRAINS = Object.freeze({
    DAY: 'day',
    MONTH: 'month'
} as const);

// ── The event list ──────────────────────────────────────────────────────────

/** Rows per page when the caller does not say. */
const DEFAULT_EVENT_PAGE_SIZE = 50;

/**
 * Ceiling on rows per page.
 *
 * ⚠️ Not a performance guess: `gi_partner_app_events` is the largest collection in this build, the
 * rows carry five projected scalars each, and a caller asking for 100,000 of them would be asking
 * this process to hold the whole install history in memory to serialise it once. Paging is the
 * supported way to walk it.
 */
const MAX_EVENT_PAGE_SIZE = 200;

/**
 * Ceiling on the page NUMBER.
 *
 * A page is served with `skip`, and Mongo walks every skipped document — so `?page=900000000` is a
 * request for the server to scan the whole collection and return nothing. The clamp is applied
 * silently and the response echoes the page it actually served, which is the fail-open direction: a
 * typo yields the last reachable page rather than a 400 over a query string.
 */
const MAX_EVENT_PAGE = 10000;

export = {
    PARTNER_APP_DATA_STATES,
    NEVER_SYNCED_REASON,
    RELATIONSHIP_EVENT_TYPES,
    RELATIONSHIP_COUNT_KEYS,
    FILTERABLE_EVENT_TYPES,
    DEFAULT_KPI_PERIOD_DAYS,
    TREND_DAY_GRAIN_MAX_DAYS,
    LIFETIME_TREND_FALLBACK_DAYS,
    MAX_TREND_POINTS,
    TREND_GRAINS,
    DEFAULT_EVENT_PAGE_SIZE,
    MAX_EVENT_PAGE_SIZE,
    MAX_EVENT_PAGE
};
