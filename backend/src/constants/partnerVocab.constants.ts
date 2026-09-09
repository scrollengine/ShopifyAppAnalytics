/**
 * Partner API vocabulary — the event types, transaction types, sync modes and history floor that
 * every layer of this application agrees on.
 *
 *  THIS FILE MUST STAY DEPENDENCY-FREE. It has zero imports and must keep zero imports.
 * Both the models (which build their mongoose `enum` gates from it) and the services (which branch
 * on its values) read it, so anything it required would be pulled into the model layer at require
 * time. In the system this was extracted from the same vocabulary lived under a service module the
 * models could not reach, which inverted the layering and forced the models to reach sideways into
 * a service folder; that is fixed here by making the vocabulary the bottom layer it always was.
 *
 * `Object.freeze` is load-bearing at RUN TIME, not decoration: the schemas do
 * `enum: Object.values(X)` and hold the resulting array for the process lifetime, so a mutation
 * here would silently widen or narrow a validation gate. `as const` is the additive compile-time
 * half — it is what gives each value its literal type, and the unions derived from those literals
 * live in `../types/partnerVocab.types` (a module ending in an export assignment cannot also export
 * types, so they cannot sit beside the values).
 */

/**
 * Our internal event type, after the Partner API `__typename` has been mapped onto it.
 *
 * FOUR relationship events, not two. `REINSTALL` is Shopify's `RelationshipReactivated` and
 * `DEACTIVATED` is `RelationshipDeactivated`. Any fold over install state that considers only
 * INSTALL/UNINSTALL leaves every reactivated shop permanently uninstalled and every frozen shop
 * permanently installed — both wrong, both silent.
 *
 * `OTHER` is the catch-all for a `__typename` Shopify emits that this build does not model. It
 * exists so an unknown event is STORED (and countable, and visible) rather than dropped at the
 * schema gate: an event we cannot classify is a known unknown, and dropping it would turn it into
 * an unknown unknown.
 */
const PARTNER_EVENT_TYPES = Object.freeze({
    /** First time the app was added to a store. */
    INSTALL: 'INSTALL',
    /** The app was removed from the store. */
    UNINSTALL: 'UNINSTALL',
    /** Shopify `RelationshipReactivated` — the app is back on a store that had it before. */
    REINSTALL: 'REINSTALL',
    /** Shopify `RelationshipDeactivated` — the store froze/paused rather than uninstalling. */
    DEACTIVATED: 'DEACTIVATED',
    /** Merchant approved a subscription charge. This is the TRIAL start, not the billing start. */
    SUBSCRIPTION_CHARGE_ACCEPTED: 'SUBSCRIPTION_CHARGE_ACCEPTED',
    /** The subscription began billing. On a trialling charge this lands when the trial runs out. */
    SUBSCRIPTION_CHARGE_ACTIVATED: 'SUBSCRIPTION_CHARGE_ACTIVATED',
    SUBSCRIPTION_CHARGE_CANCELLED: 'SUBSCRIPTION_CHARGE_CANCELLED',
    SUBSCRIPTION_CHARGE_DECLINED: 'SUBSCRIPTION_CHARGE_DECLINED',
    SUBSCRIPTION_CHARGE_EXPIRED: 'SUBSCRIPTION_CHARGE_EXPIRED',
    ONE_TIME_CHARGE_ACCEPTED: 'ONE_TIME_CHARGE_ACCEPTED',
    USAGE_CHARGE_APPLIED: 'USAGE_CHARGE_APPLIED',
    /** A `__typename` this build does not model. Stored, not dropped — see the note above. */
    OTHER: 'OTHER'
} as const);

/**
 * Our internal transaction type, after the Partner API `__typename` has been mapped onto it.
 *
 * These are SETTLED PAYOUTS — cash, not run-rate. Nothing in this vocabulary describes a
 * subscription's contracted value; that comes from the charge events above. The two are kept
 * strictly apart everywhere downstream because cash is lumpy (annual prepayments, refunds, payout
 * timing) and run-rate is smooth, and merging them makes both wrong.
 */
const PARTNER_TRANSACTION_TYPES = Object.freeze({
    /** Recurring subscription payout. The ONLY type that carries a `billingInterval`. */
    APP_SUBSCRIPTION: 'APP_SUBSCRIPTION',
    APP_USAGE: 'APP_USAGE',
    APP_ONE_TIME: 'APP_ONE_TIME',
    /** Shopify `AppSaleCredit` — a refund or credit. Negative money. */
    APP_CREDIT: 'APP_CREDIT',
    /** Shopify `AppSaleAdjustment` — a correction Shopify applied after the fact. */
    APP_ADJUSTMENT: 'APP_ADJUSTMENT',
    /** Pre-dates the current billing objects. Present in old accounts, absent in new ones. */
    LEGACY: 'LEGACY',
    /** A `__typename` this build does not model. Stored, not dropped. */
    OTHER: 'OTHER'
} as const);

/**
 * Which window a partner sync pulls.
 *
 * `AUTO` is the only value a scheduler should ever enqueue: it resolves to LIFETIME on an app that
 * has never completed one and INCREMENTAL thereafter, so a fresh install backfills itself without
 * anyone remembering to ask. The other two are explicit operator overrides — LIFETIME to repair a
 * suspected gap, INCREMENTAL to skip the expensive scan deliberately.
 */
const PARTNER_SYNC_MODES = Object.freeze({
    /** Pick LIFETIME if this app has never completed one, else INCREMENTAL. */
    AUTO: 'AUTO',
    /** Pull everything since `PARTNER_LIFETIME_SINCE_ISO`. */
    LIFETIME: 'LIFETIME',
    /** Pull a recent window only, overlapping the last watermark so nothing falls between runs. */
    INCREMENTAL: 'INCREMENTAL'
} as const);

/**
 * The floor for a LIFETIME pull — earlier than Shopify's app ecosystem existed (2009), so it is
 * safely "all history" for any app without hardcoding a date that could truncate an old account.
 *
 * ⚠️ This is the floor of the REQUEST, not of the ANSWER. What actually came back is recorded per
 * app on `partner_apps.earliest_event_at` / `earliest_transaction_at`, and it is those fields — not
 * this constant — that any coverage check must read. A figure whose window starts before the app's
 * real earliest record has no answer and must return `null` with that reason.
 */
const PARTNER_LIFETIME_SINCE_ISO = '2009-01-01T00:00:00Z';

export = {
    PARTNER_EVENT_TYPES,
    PARTNER_TRANSACTION_TYPES,
    PARTNER_SYNC_MODES,
    PARTNER_LIFETIME_SINCE_ISO
};
