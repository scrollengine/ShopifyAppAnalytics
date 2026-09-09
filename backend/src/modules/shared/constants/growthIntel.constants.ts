/**
 * Module-wide constants for the Performance suite.
 *
 * All enums, job-type identifiers, status values and timing thresholds live here. Services, models
 * and controllers import from this file so no raw string literal for any of them exists in another
 * layer — an enum with two spellings is an enum that eventually disagrees with itself.
 *
 * ⚠️ `Object.freeze` stays on every value: mongoose schemas do `enum: Object.values(X)`, so the
 * runtime immutability is load-bearing. `as const` is additive and compile-time only — it is what
 * gives each value its literal type, so a union derived from one of these objects widens
 * automatically when a member is added.
 *
 * Trimmed on extraction to the Performance vocabulary. The competitor, keyword, ranking, ads and LLM
 * enums are not here — they belong to the Market Intel suite, which is a later release, and carrying
 * their names now would advertise job types nothing can run.
 */

/**
 * A job kind the dispatcher knows how to run.
 *
 * There is no message queue in this build — the runner polls the sync-job collection — so this list
 * is the whole dispatch table and an unrecognised value fails the job rather than sitting unread on
 * a topic nobody consumes.
 */
const SYNC_JOB_TYPES = Object.freeze({
    // A no-op job that sleeps and succeeds. Exists so a fresh install can prove the runner works
    // end to end without a Partner API credential.
    DUMMY: 'DUMMY',
    PARTNER_SYNC: 'PARTNER_SYNC',
    BIGQUERY_SYNC: 'BIGQUERY_SYNC',
    // Per-install attribution: which store installed, and where it came from. Separate from
    // BIGQUERY_SYNC because it reads the whole event_params column — a far heavier scan than the
    // three daily rollups — and so needs its own watermark, cost budget and failure domain.
    INSTALL_ATTRIBUTION_SYNC: 'INSTALL_ATTRIBUTION_SYNC'
} as const);

const SYNC_JOB_STATUS = Object.freeze({
    PENDING: 'PENDING',
    RUNNING: 'RUNNING',
    SUCCESS: 'SUCCESS',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED'
} as const);

const SYNC_JOB_TRIGGERED_BY = Object.freeze({
    MANUAL: 'MANUAL',
    CRON: 'CRON'
} as const);

/**
 * Why a job ended up FAILED.
 *
 * Distinguishes a handler that threw from a job the sweeper timed out — the two look identical in a
 * status column and need completely different responses.
 *
 * The upstream module also carried a QUEUE_PUSH_FAILED reason. It is deliberately absent: this build
 * has no queue to push to, and a failure reason nothing can ever write is a name a future reader
 * will assume means something.
 */
const SYNC_JOB_FAILURE_REASONS = Object.freeze({
    STUCK_TIMEOUT: 'STUCK_TIMEOUT',
    HANDLER_ERROR: 'HANDLER_ERROR',
    UNKNOWN_JOB_TYPE: 'UNKNOWN_JOB_TYPE'
} as const);

const STUCK_JOB_THRESHOLD_MS = 30 * 60 * 1000;
const STUCK_PENDING_THRESHOLD_MS = 60 * 60 * 1000;
const STUCK_JOB_SWEEPER_INTERVAL_MS = 15 * 60 * 1000;
const BULK_WRITE_CHUNK_SIZE = 1000;

// How stale a RUNNING row must be before another dispatch may take it over.
// Deliberately LONGER than the longest legitimate job — a LIFETIME PARTNER_SYNC
// paginates the whole event history back to PARTNER_LIFETIME_SINCE_ISO and can
// run for well over an hour — so a reclaim can never execute concurrently with a
// handler that is merely slow. This is intentionally far above
// STUCK_JOB_THRESHOLD_MS: the sweeper flags a job as stuck (visible, alerted)
// long before we are willing to let anything else execute it.
const JOB_RECLAIM_AFTER_MS = 3 * 60 * 60 * 1000;

const MAX_SYNC_POLL_MS = 5 * 60 * 1000;
const SYNC_POLL_INTERVAL_MS = 2000;

const DEFAULT_DUMMY_SLEEP_MS = 5000;

// `readonly string[]` rather than a literal tuple: this list exists to be tested against a status
// read off a persisted job (`TERMINAL_JOB_STATUSES.includes(job.status)`), and a tuple of literals
// would reject that call outright.
const TERMINAL_JOB_STATUSES: readonly string[] = Object.freeze([
    SYNC_JOB_STATUS.SUCCESS,
    SYNC_JOB_STATUS.FAILED,
    SYNC_JOB_STATUS.CANCELLED
]);

const PARTNER_EVENT_TYPES = Object.freeze({
    INSTALL: 'INSTALL',
    UNINSTALL: 'UNINSTALL',
    REINSTALL: 'REINSTALL',
    DEACTIVATED: 'DEACTIVATED',
    SUBSCRIPTION_CHARGE_ACCEPTED: 'SUBSCRIPTION_CHARGE_ACCEPTED',
    SUBSCRIPTION_CHARGE_ACTIVATED: 'SUBSCRIPTION_CHARGE_ACTIVATED',
    SUBSCRIPTION_CHARGE_CANCELLED: 'SUBSCRIPTION_CHARGE_CANCELLED',
    SUBSCRIPTION_CHARGE_DECLINED: 'SUBSCRIPTION_CHARGE_DECLINED',
    SUBSCRIPTION_CHARGE_EXPIRED: 'SUBSCRIPTION_CHARGE_EXPIRED',
    ONE_TIME_CHARGE_ACCEPTED: 'ONE_TIME_CHARGE_ACCEPTED',
    USAGE_CHARGE_APPLIED: 'USAGE_CHARGE_APPLIED',
    OTHER: 'OTHER'
} as const);

const PARTNER_TRANSACTION_TYPES = Object.freeze({
    APP_SUBSCRIPTION: 'APP_SUBSCRIPTION',
    APP_USAGE: 'APP_USAGE',
    APP_ONE_TIME: 'APP_ONE_TIME',
    APP_CREDIT: 'APP_CREDIT',
    APP_ADJUSTMENT: 'APP_ADJUSTMENT',
    LEGACY: 'LEGACY',
    OTHER: 'OTHER'
} as const);

/** One of the `PARTNER_EVENT_TYPES` values. */
type PartnerEventTypeValue = typeof PARTNER_EVENT_TYPES[keyof typeof PARTNER_EVENT_TYPES];
/** One of the `PARTNER_TRANSACTION_TYPES` values. */
type PartnerTransactionTypeValue = typeof PARTNER_TRANSACTION_TYPES[keyof typeof PARTNER_TRANSACTION_TYPES];

// Maps Shopify Partner GraphQL event __typename → our internal event_type
//
// Keyed by `string`, not by the __typenames listed below: the key arrives from the Partner API, so
// the lookup is `MAP[node.__typename] || OTHER` and an unknown typename must remain expressible.
// Shopify adds event types without warning, and an unmapped one must land as OTHER rather than
// crashing a sync or — worse — being silently dropped from a count.
const PARTNER_API_EVENT_TYPENAME_MAP: Readonly<Record<string, PartnerEventTypeValue>> = Object.freeze({
    RelationshipInstalled: PARTNER_EVENT_TYPES.INSTALL,
    RelationshipUninstalled: PARTNER_EVENT_TYPES.UNINSTALL,
    RelationshipReactivated: PARTNER_EVENT_TYPES.REINSTALL,
    RelationshipDeactivated: PARTNER_EVENT_TYPES.DEACTIVATED,
    SubscriptionChargeAccepted: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED,
    SubscriptionChargeActivated: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACTIVATED,
    SubscriptionChargeCanceled: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_CANCELLED,
    SubscriptionChargeDeclined: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_DECLINED,
    SubscriptionChargeExpired: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_EXPIRED,
    OneTimeChargeAccepted: PARTNER_EVENT_TYPES.ONE_TIME_CHARGE_ACCEPTED,
    UsageChargeApplied: PARTNER_EVENT_TYPES.USAGE_CHARGE_APPLIED
});

// Maps Shopify Partner GraphQL transaction __typename → our internal transaction type
// Note: AppSaleCredit (not AppCredit), AppSaleAdjustment per partner schema 2026-01.
const PARTNER_API_TRANSACTION_TYPENAME_MAP: Readonly<Record<string, PartnerTransactionTypeValue>> = Object.freeze({
    AppSubscriptionSale: PARTNER_TRANSACTION_TYPES.APP_SUBSCRIPTION,
    AppUsageSale: PARTNER_TRANSACTION_TYPES.APP_USAGE,
    AppOneTimeSale: PARTNER_TRANSACTION_TYPES.APP_ONE_TIME,
    AppSaleCredit: PARTNER_TRANSACTION_TYPES.APP_CREDIT,
    AppSaleAdjustment: PARTNER_TRANSACTION_TYPES.APP_ADJUSTMENT,
    LegacyTransaction: PARTNER_TRANSACTION_TYPES.LEGACY
});

const DEFAULT_PARTNER_SYNC_LOOKBACK_DAYS = 90;
const PARTNER_API_PAGE_SIZE = 100;
const PARTNER_API_PAGE_DELAY_MS = 250;

const PARTNER_SYNC_MODES = Object.freeze({
    AUTO: 'AUTO', // pick LIFETIME if first sync, else INCREMENTAL
    LIFETIME: 'LIFETIME', // pull everything since PARTNER_LIFETIME_SINCE_ISO
    INCREMENTAL: 'INCREMENTAL' // pull last N days (overlap-safe)
} as const);
// Predates Shopify's app ecosystem (2009) — safe floor for "all history".
const PARTNER_LIFETIME_SINCE_ISO = '2009-01-01T00:00:00Z';
// On incremental syncs, re-pull this many days back from last_synced_at to
// catch any events that arrived late or were missed by a partial failure.
const PARTNER_INCREMENTAL_OVERLAP_DAYS = 7;

export = {
    SYNC_JOB_TYPES,
    SYNC_JOB_STATUS,
    SYNC_JOB_TRIGGERED_BY,
    SYNC_JOB_FAILURE_REASONS,
    STUCK_JOB_THRESHOLD_MS,
    STUCK_PENDING_THRESHOLD_MS,
    STUCK_JOB_SWEEPER_INTERVAL_MS,
    BULK_WRITE_CHUNK_SIZE,
    JOB_RECLAIM_AFTER_MS,
    MAX_SYNC_POLL_MS,
    SYNC_POLL_INTERVAL_MS,
    DEFAULT_DUMMY_SLEEP_MS,
    TERMINAL_JOB_STATUSES,
    PARTNER_EVENT_TYPES,
    PARTNER_TRANSACTION_TYPES,
    PARTNER_API_EVENT_TYPENAME_MAP,
    PARTNER_API_TRANSACTION_TYPENAME_MAP,
    DEFAULT_PARTNER_SYNC_LOOKBACK_DAYS,
    PARTNER_API_PAGE_SIZE,
    PARTNER_API_PAGE_DELAY_MS,
    PARTNER_SYNC_MODES,
    PARTNER_LIFETIME_SINCE_ISO,
    PARTNER_INCREMENTAL_OVERLAP_DAYS
};
