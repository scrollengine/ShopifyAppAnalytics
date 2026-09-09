'use strict';

/**
 * ============================================================================
 *  BIGQUERY — module vocabulary and fixed limits
 * ============================================================================
 *
 *  Everything an operator should be able to tune already lives in `config.BIGQUERY` — the project,
 *  the dataset, the cost ceilings, the crons. What is here is INTERNAL MECHANICS and SHOPIFY'S OWN
 *  VOCABULARY: values where a knob would be a way to break the module rather than a way to fit it
 *  to a deployment, and event names that are Shopify's to change, not ours.
 *
 *  Dependency-free on purpose — nothing here imports config, a model, or another module — so the
 *  predicates built on it can be unit-tested without standing anything up.
 * ============================================================================
 */

// ── Read-only guard ─────────────────────────────────────────────────────────

/**
 * Statement keywords that may not appear ANYWHERE in a query this module sends.
 *
 * ⚠️ The scan is over the whole cleaned statement, STRING LITERALS INCLUDED. That is deliberately
 * blunt: a SQL parser good enough to know a keyword is "only inside a string" is a SQL parser we
 * would then be trusting with the security boundary. The cost is a real constraint on the queries —
 * `WHERE shop_name = 'Drop Anchor Supply'` is REFUSED, because `drop` is on this list and that is
 * exactly the shape merchant-supplied free text takes.
 *
 * So any value that could contain English words MUST travel as a query PARAMETER. Never inline
 * merchant text into SQL to get around this list.
 */
const FORBIDDEN_STATEMENTS: readonly string[] = Object.freeze([
    'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE',
    'CREATE', 'DROP', 'ALTER', 'RENAME',
    'GRANT', 'REVOKE',
    'CALL', 'EXPORT', 'LOAD',
    'BEGIN', 'COMMIT', 'ROLLBACK', 'SET', 'DECLARE',
    'ASSERT'
]);

/**
 * Characters permitted in an interpolated BigQuery identifier.
 *
 * BigQuery accepts no parameter in a table position, so the project, dataset and table pattern are
 * interpolated into the SQL text. This allowlist is the only thing standing between configuration
 * and that interpolation, which is why it is an allowlist rather than an escape.
 */
const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9_*-]+$/;

/** `YYYY-MM-DD`. The only shape `BQ_LIFETIME_FLOOR_DATE` may take. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Job polling ─────────────────────────────────────────────────────────────

/**
 * Backstop for polling a job that reports `jobComplete=false`.
 *
 * `config.BIGQUERY.JOB_TIMEOUT_MS` is the real ceiling — BigQuery cancels the job server-side when
 * it expires. These two only stop the result loop from spinning forever if that never lands.
 */
const INCOMPLETE_JOB_POLL_MS = 1000;
const INCOMPLETE_JOB_MAX_POLLS = 600;

/** Prefix stamped on every job this module creates, so a scan is attributable in GCP's own logs. */
const READ_ONLY_JOB_PREFIX = 'listing_analytics_readonly_';

// ── Shopify's event vocabulary ──────────────────────────────────────────────
//
// Shopify's names, verbatim. Safe to inline into SQL: none contains a token the read-only guard
// forbids. Anything MERCHANT-authored must not be — see FORBIDDEN_STATEMENTS.

/** Server-side, via the GA4 Measurement Protocol. Carries the store identity in `event_params`. */
const INSTALL_EVENT = 'shopify_app_install';
/** Fires on an AD click, so every surface it can produce is a paid one. */
const AD_CLICK_EVENT = 'shopify_app_ad_click';
/**
 * The ORGANIC half.
 *
 * Shopify appends `surface_*` to the listing URL on EVERY App Store referral, so a plain listing
 * pageview carries the surface for a visitor who never clicked an ad. Reading only the ad-click
 * event is why every stored `surface_type` once ended in `_ad`, and why the organic search query was
 * never observed at all.
 */
const PAGE_VIEW_EVENT = 'page_view';

// ── Attribution scopes ──────────────────────────────────────────────────────

/**
 * WHICH GA4 scope produced a row's source/medium. Stored on every attribution row.
 *
 * These are not interchangeable and must never be averaged together:
 *   `event_collected`         — the source collected ON THIS EVENT. Closest to "where did this
 *                               install come from", so it is preferred.
 *   `user_first_acquisition`  — how the USER was FIRST EVER acquired. A merchant who found us
 *                               organically months ago and installed from a paid ad reads as
 *                               organic here, permanently.
 *   `none`                    — the install arrived with no attribution at all. A KNOWN-UNKNOWN,
 *                               stored as one rather than folded into `(direct)`.
 */
const ATTRIBUTION_SCOPES = Object.freeze({
    EVENT_COLLECTED: 'event_collected',
    USER_FIRST_ACQUISITION: 'user_first_acquisition',
    NONE: 'none'
} as const);

/**
 * GA4's own sentinels, used verbatim rather than reinvented.
 *
 * ⚠️ `NOT_SET` and `UNATTRIBUTED` mean different things and the distinction is load-bearing. In GA4
 * a genuinely direct visit carries the literal `(direct)` / `(none)`; an EMPTY field means the value
 * was never populated. Defaulting an empty to `(direct)` invents a fact — and direct is already the
 * largest bucket, so the error would hide inside it.
 */
const ATTRIBUTION_SENTINELS = Object.freeze({
    /** One half of a scope was populated and the other was not. */
    NOT_SET: '(not set)',
    /** No scope carried anything. The install exists; where it came from is unknown. */
    UNATTRIBUTED: '(unattributed)'
} as const);

// ── Sync mechanics ──────────────────────────────────────────────────────────

/**
 * Days re-pulled before the watermark on an INCREMENTAL run.
 *
 * The install event is SERVER-SIDE and can land in the export a day or more late, so the overlap is
 * not paranoia — without it a late-arriving install is skipped permanently, because the next run
 * starts after the watermark that was stamped before it arrived. Re-pulling is free: every write is
 * an idempotent upsert keyed on the row's own identity.
 */
const BIGQUERY_INCREMENTAL_OVERLAP_DAYS = 7;

/** Rows per `bulkWrite` chunk. Bounds the driver's per-command payload on a LIFETIME backfill. */
const BULK_WRITE_CHUNK_SIZE = 1000;

/** Human-readable provenance for anything published out of this module. */
const LISTING_SOURCE_LABEL = 'shopify listing analytics (bigquery)';

/**
 * The message a view shows in place of its numbers when nothing has ever been synced.
 *
 * Not an empty chart and not zeros. The tier is connected, so this is a statement about our
 * pipeline rather than about the merchant's listing, and it names the job that would fix it.
 */
const NEVER_SYNCED_REASON =
    'No BigQuery sync has completed yet, so there is nothing to report for this listing. ' +
    'Run a BIGQUERY_SYNC job — this is not a reading of zero traffic.';

/**
 * The message `/api/funnel` publishes beside `summary: null` when a sync HAS run and the window
 * still holds no rollup row.
 *
 * A DIFFERENT FACT FROM `NEVER_SYNCED_REASON`, and the two must never be spelled the same way.
 * "We have never looked" is fixed by running a job; "we looked and these days are not in the rollup"
 * is fixed by moving the date range or extending the sync window, and telling an operator to run a
 * sync they have already run is how they learn the banner is noise.
 *
 * ⚠️ It is NOT a reading of zero traffic either. `aggregateFunnelTotals` returns null because
 * `$group` emits no document for an empty match — see `docs/FIDELITY.md` §4 (`/api/funnel`), which
 * requires that null be preserved rather than rebuilt as a zeroed row.
 */
const EMPTY_WINDOW_REASON =
    'The listing rollup holds no rows for these dates, so this window has no funnel to report. ' +
    'A sync has run — this is not a reading of zero traffic. Widen the date range, or extend the ' +
    'BigQuery sync window if these days are older than the rollup reaches.';

export = {
    FORBIDDEN_STATEMENTS,
    SAFE_IDENTIFIER_RE,
    ISO_DATE_RE,
    INCOMPLETE_JOB_POLL_MS,
    INCOMPLETE_JOB_MAX_POLLS,
    READ_ONLY_JOB_PREFIX,
    INSTALL_EVENT,
    AD_CLICK_EVENT,
    PAGE_VIEW_EVENT,
    ATTRIBUTION_SCOPES,
    ATTRIBUTION_SENTINELS,
    BIGQUERY_INCREMENTAL_OVERLAP_DAYS,
    BULK_WRITE_CHUNK_SIZE,
    LISTING_SOURCE_LABEL,
    NEVER_SYNCED_REASON,
    EMPTY_WINDOW_REASON
};
