/**
 * Constants owned by the partner module: the Partner API's own vocabulary translated into ours,
 * plus the pull's sizing knobs.
 *
 * The VALUES this maps onto come from `src/constants/partnerVocab.constants` — the dependency-free
 * file the mongoose schemas build their `enum` gates from. That import direction is load-bearing:
 * a writer that mapped onto a SECOND copy of the vocabulary would produce values the schema
 * validates against a different list, and the two only agree until someone edits one of them.
 *
 * Sizing knobs that an operator should be able to change live in `config` (page delay, request
 * timeout, max RPS, lookback days). The ones here are structural — changing them changes how the
 * sync behaves rather than how hard it presses — so they are code, not environment.
 */

import partnerVocab = require('../../../constants/partnerVocab.constants');

import type { PartnerEventType, PartnerTransactionType } from '../../../types/partnerVocab.types';

const { PARTNER_EVENT_TYPES, PARTNER_TRANSACTION_TYPES } = partnerVocab;

/**
 * Shopify Partner GraphQL event `__typename` → our internal `event_type`.
 *
 * Keyed by `string`, NOT by the typenames listed: the key arrives from the Partner API, so the
 * lookup is `MAP[node.__typename] || OTHER` and an unknown typename has to remain expressible.
 * Shopify adds event types without warning, and an unmapped one must land as `OTHER` — stored,
 * countable, visible — rather than crashing the sync or being silently dropped from a count.
 */
const PARTNER_API_EVENT_TYPENAME_MAP: Readonly<Record<string, PartnerEventType>> = Object.freeze({
    RelationshipInstalled: PARTNER_EVENT_TYPES.INSTALL,
    RelationshipUninstalled: PARTNER_EVENT_TYPES.UNINSTALL,
    RelationshipReactivated: PARTNER_EVENT_TYPES.REINSTALL,
    RelationshipDeactivated: PARTNER_EVENT_TYPES.DEACTIVATED,
    SubscriptionChargeAccepted: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED,
    SubscriptionChargeActivated: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACTIVATED,
    // Shopify spells it with one 'l'; we store the two-'l' spelling. The map is the only place the
    // two spellings meet, which is the point of having it.
    SubscriptionChargeCanceled: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_CANCELLED,
    SubscriptionChargeDeclined: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_DECLINED,
    SubscriptionChargeExpired: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_EXPIRED,
    OneTimeChargeAccepted: PARTNER_EVENT_TYPES.ONE_TIME_CHARGE_ACCEPTED,
    UsageChargeApplied: PARTNER_EVENT_TYPES.USAGE_CHARGE_APPLIED
});

/**
 * Shopify Partner GraphQL transaction `__typename` → our internal `type`.
 *
 * Note the names: `AppSaleCredit` and `AppSaleAdjustment`, not `AppCredit` / `AppAdjustment`.
 */
const PARTNER_API_TRANSACTION_TYPENAME_MAP: Readonly<Record<string, PartnerTransactionType>> = Object.freeze({
    AppSubscriptionSale: PARTNER_TRANSACTION_TYPES.APP_SUBSCRIPTION,
    AppUsageSale: PARTNER_TRANSACTION_TYPES.APP_USAGE,
    AppOneTimeSale: PARTNER_TRANSACTION_TYPES.APP_ONE_TIME,
    AppSaleCredit: PARTNER_TRANSACTION_TYPES.APP_CREDIT,
    AppSaleAdjustment: PARTNER_TRANSACTION_TYPES.APP_ADJUSTMENT,
    LegacyTransaction: PARTNER_TRANSACTION_TYPES.LEGACY
});

/**
 * The event types whose `charge { … }` block the sync's GraphQL document actually requests, and
 * therefore the ONLY rows on which a missing `charge_id` means anything.
 *
 *  Read this before adding a type. `USAGE_CHARGE_APPLIED` is deliberately ABSENT even though it
 * is a billing event: the query asks for no charge fragment on `UsageChargeApplied`, so those rows
 * carry `charge_id: ''` BY CONSTRUCTION. Counting them as "absent" would publish a permanent,
 * unfixable link-quality gap that no re-sync could ever close — a coverage metric reporting a
 * problem that does not exist is worse than no metric, because someone will chase it.
 *
 * The four relationship events (INSTALL, UNINSTALL, REINSTALL, DEACTIVATED) are absent for the same
 * reason: they have no charge at all.
 *
 *  ONLY A FRAGMENT THAT REQUESTS A `charge { … }` BLOCK BELONGS IN THIS LIST. If you add one that
 * does, add its type here in the same change — and if you add one that does NOT, leave this alone.
 * `... on RelationshipUninstalled { reason description }` is the standing example: it is in the
 * query and asks for no charge, so listing UNINSTALL here would count every uninstall this app has
 * ever had as a missing charge link — a permanent, unfixable gap that measures the API's schema
 * instead of our data, which is the exact failure the paragraph above exists to prevent.
 */
const CHARGE_LINKED_EVENT_TYPES: readonly string[] = Object.freeze([
    PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED,
    PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACTIVATED,
    PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_CANCELLED,
    PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_DECLINED,
    PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_EXPIRED,
    PARTNER_EVENT_TYPES.ONE_TIME_CHARGE_ACCEPTED
]);

/**
 * The transaction types that carry a `chargeId` on the wire.
 *
 * Only `AppSubscriptionSale` does. A usage sale, a one-time sale, a credit and an adjustment all
 * arrive without one, so — exactly as above — they must stay out of any "missing charge link"
 * denominator or the metric measures the schema instead of the data.
 */
const CHARGE_BEARING_TRANSACTION_TYPES: readonly string[] = Object.freeze([
    PARTNER_TRANSACTION_TYPES.APP_SUBSCRIPTION
]);

/** Nodes per page. Shopify's documented maximum for these connections. */
const PARTNER_API_PAGE_SIZE = 100;

/**
 * Hard ceiling on pages per pull. At 100 nodes a page this is 100,000 nodes — far beyond any real
 * app's history, and a stop that surfaces as an explicit `truncated` failure rather than a loop.
 */
const PARTNER_API_MAX_PAGES = 1000;

/**
 * On an INCREMENTAL sync, re-pull this many days back from `last_synced_at`.
 *
 * Shopify can report an event after the fact, and a run that failed mid-window leaves a hole. The
 * upserts are idempotent, so overlapping costs a little API budget and nothing else, while NOT
 * overlapping loses events invisibly — the window that was skipped is never revisited.
 */
const PARTNER_INCREMENTAL_OVERLAP_DAYS = 7;

/**
 * Upserts per `bulkWrite` round trip.
 *
 * A lifetime sync writes tens of thousands of rows; one-at-a-time upserts turned that into roughly
 * ten minutes of sequential round trips. Chunked, it is a handful of round trips and a few seconds.
 */
const BULK_WRITE_CHUNK_SIZE = 1000;

export = {
    PARTNER_API_EVENT_TYPENAME_MAP,
    PARTNER_API_TRANSACTION_TYPENAME_MAP,
    CHARGE_LINKED_EVENT_TYPES,
    CHARGE_BEARING_TRANSACTION_TYPES,
    PARTNER_API_PAGE_SIZE,
    PARTNER_API_MAX_PAGES,
    PARTNER_INCREMENTAL_OVERLAP_DAYS,
    BULK_WRITE_CHUNK_SIZE
};
