'use strict';

/**
 * ============================================================================
 *  THE DEMO DATASET GENERATOR — pure, deterministic, database-free
 * ============================================================================
 *
 *  Takes one instant and returns every row the demo needs. It touches no model,
 *  reads no clock of its own and performs no I/O, which is what lets the whole
 *  dataset be checked for internal consistency in a unit test — against the REAL
 *  MRR predicate and the REAL cohort resolver — with no database anywhere near it.
 *
 *  ── THE ONE RULE THIS FILE EXISTS TO KEEP ───────────────────────────────
 *
 *  EVERY PAGE CROSS-CHECKS. Stores, Subscriptions, Revenue, Trial Funnel and
 *  Logo Churn are five folds over the same two collections, so a shop that
 *  churns in one and pays in another does not render "slightly wrong" — it
 *  renders as a dashboard reporting a contradiction, which is exactly what this
 *  project's honesty machinery is built to do. The demo would then look broken
 *  while behaving correctly.
 *
 *  So the generator emits a store's history ONCE, as a lifecycle, and derives
 *  the events and the payouts from it:
 *
 *      install → [accept a charge] → [billing starts] → payouts every cycle
 *                                  → [cancel / uninstall / freeze] → payouts stop
 *
 *  Nothing here writes a state; the states are folded back out by the same code
 *  the dashboard uses. If a store must leave the paying set, it leaves because
 *  its payouts stopped and the predicate aged it out, not because a flag says so.
 *
 *  ── DETERMINISM ─────────────────────────────────────────────────────────────
 *  A seeded PRNG, never `Math.random`. The same anchor produces byte-identical
 *  rows, which is what makes re-running the seeder a no-op rather than a second
 *  dataset — see `DEMO_RANDOM_SEED` and the anchor note on `generateDemoDataset`.
 * ============================================================================
 */

import crypto = require('crypto');

import partnerVocab = require('../../constants/partnerVocab.constants');
import syncJobVocab = require('../../constants/syncJob.constants');
import partnerSyncConstants = require('../../modules/partner/constants/partnerSync.constants');
import funnelMath = require('../../modules/conversion/helpers/funnelMath.helper');
import demoConstants = require('../constants/demoSeed.constants');

import type {
    DemoAttributionRow,
    DemoDataset,
    DemoEventRow,
    DemoFunnelDayRow,
    DemoGeoDayRow,
    DemoSourceDayRow,
    DemoStoreSpec,
    DemoSubscriptionSpec,
    DemoSyncJobRow,
    DemoTransactionRow
} from '../types/demoSeed.types';
import type { PartnerEventType } from '../../types/partnerVocab.types';

const { PARTNER_EVENT_TYPES, PARTNER_TRANSACTION_TYPES } = partnerVocab;
const { SYNC_JOB_TYPES, SYNC_JOB_STATUS, SYNC_JOB_TRIGGERED_BY, SYNC_JOB_FAILURE_REASONS } = syncJobVocab;
const { PARTNER_API_EVENT_TYPENAME_MAP } = partnerSyncConstants;
/**
 * THE SAME `rate()` THE SYNC USES — THERE IS ONE SPELLING OF "DIVIDE" AND THIS IS IT.
 *
 * Imported by DEEP PATH to a PURE leaf, never through `modules/conversion`'s barrel: the barrel
 * would close a cycle that is silent at both typecheck and lint. `funnelMath.helper` reads no model,
 * no config and no clock, which is the whole reason a seeding script may reach for it.
 */
const { rate } = funnelMath;
const {
    DEMO_MARKER,
    DEMO_SEED_VERSION,
    DEMO_DOMAIN_SUFFIX,
    DEMO_DOMAIN_PREFIX,
    DEMO_APP,
    HISTORY_DAYS,
    QUIET_MONTHS_BACK,
    QUIET_PADDING_DAYS,
    QUIET_SAFE_BAND_DAYS,
    DEMO_RANDOM_SEED,
    SHOPIFY_FEE_RATE,
    DEMO_CURRENCY,
    MONTHLY_CYCLE_DAYS,
    ANNUAL_CYCLE_DAYS,
    DEMO_PLANS,
    DEMO_PLAN_MIX,
    DEMO_COUNTRIES,
    DEMO_TRAFFIC_SOURCES,
    DEMO_ATTRIBUTION_SURFACES,
    UNATTRIBUTED_INSTALL_SHARE,
    LISTING_VIEWS_START,
    LISTING_VIEWS_END,
    LISTING_WEEKDAY_FACTORS,
    LISTING_ENGAGED_VIEW_RATE,
    LISTING_INSTALL_CLICK_RATE,
    LISTING_CONSENT_START_RATE,
    LISTING_CONSENT_COMPLETE_RATE,
    LISTING_SESSION_RATE,
    LISTING_FIRST_VISIT_RATE,
    LISTING_INSTALL_RATE,
    PROCEDURAL_NO_TRIAL_SHARE,
    PROCEDURAL_NO_TRIAL_UNINSTALL_SHARE,
    PROCEDURAL_TRIAL_CONVERSION_SHARE,
    PROCEDURAL_MONTHLY_CHURN_HAZARD,
    PROCEDURAL_UPGRADE_SHARE,
    PROCEDURAL_DOWNGRADE_SHARE,
    DEMO_TRIAL_DAYS,
    DEMO_NAMED_STORES,
    DEMO_SYNC_JOB_COUNT,
    DEMO_SYNC_JOB_INTERVAL_HOURS
} = demoConstants;

const _DAY_MS = 24 * 60 * 60 * 1000;

/** Partner API `__typename` for each of our internal event types — the hash input the sync uses. */
const _TYPENAME_BY_EVENT_TYPE: Record<string, string> = (() => {
    const out: Record<string, string> = {};
    for (const [typename, eventType] of Object.entries(PARTNER_API_EVENT_TYPENAME_MAP)) {
        out[eventType] = typename;
    }
    return out;
})();

/** Word halves the procedural store names are built from. Deliberately pastoral and obviously invented. */
const _NAME_FIRST: readonly string[] = Object.freeze([
    'amber', 'willow', 'copper', 'harbor', 'thistle', 'juniper', 'marlow', 'birch',
    'holloway', 'sable', 'wren', 'clover', 'ember', 'foxglove', 'granite', 'hollis',
    'ivory', 'kestrel', 'larkspur', 'moss', 'nettle', 'orchard', 'pebble', 'quill',
    'rowan', 'saffron', 'tamarind', 'umber', 'verbena', 'wicker', 'yarrow', 'zephyr',
    'alder', 'brindle', 'cobalt', 'dovetail', 'elmwood', 'fennel', 'gable', 'heather'
]);

const _NAME_SECOND: readonly string[] = Object.freeze([
    'lane', 'field', 'harbour', 'forge', 'hollow', 'ridge', 'brook', 'gate',
    'court', 'row', 'yard', 'mill', 'wharf', 'green', 'grove', 'bank',
    'cross', 'moor', 'stone', 'vale', 'bay', 'point', 'reach', 'weald',
    'haven', 'march', 'spring', 'thorn', 'watch', 'well', 'wood', 'quay'
]);

/** Suffixes that make a slug read as a shop rather than a place. */
const _NAME_SUFFIX: readonly string[] = Object.freeze([
    'Supply Co', 'Goods', 'Studio', 'Trading Co', 'Mercantile', 'Home', 'Works',
    'Provisions', 'Collective', '& Co', 'Outfitters', 'Atelier'
]);

/**
 * A deterministic PRNG (mulberry32).
 *
 * ⚠️ `Math.random` would be a correctness bug here, not a style choice: the
 * seeder is idempotent only because a second run at the same anchor regenerates
 * the SAME rows, and every row's identity — the event hash, the transaction id —
 * is derived from its content. A random generator would make every re-run a
 * fresh dataset that upserts alongside the old one.
 *
 * @param seed - Any 32-bit integer.
 * @returns A function returning the next value in [0, 1).
 */
const _mulberry32 = (seed: number): (() => number) => {
    let a = seed >>> 0;
    return (): number => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

/** UTC midnight of the day `value` falls in. */
const _utcMidnight = (value: Date): Date => {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
};

/** `YYYY-MM` for a date, in UTC — the key every monthly fold in the application uses. */
const _monthKey = (at: Date): string => {
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** `YYYY-MM-DD` in UTC — the shape Shopify's `billingOn` Date scalar arrives in. */
const _dateOnly = (at: Date): string => {
    return at.toISOString().slice(0, 10);
};

/** Two decimal places. Money that carries float dust reconciles to within 1e-13 and reads as a bug. */
const _money = (value: number): number => {
    return Math.round(value * 100) / 100;
};

/**
 * A stable time of day for an event, derived from its own key.
 *
 * Events all landing on UTC midnight would make every daily bucket boundary a
 * tie, and ties are where ordering bugs hide. This spreads them across a working
 * day without introducing any randomness the anchor cannot reproduce.
 *
 * @param key - Anything stable and unique to the event.
 * @returns Milliseconds to add to a UTC midnight, inside 08:00–21:59.
 */
const _timeOfDayMs = (key: string): number => {
    let h = 0;
    for (let i = 0; i < key.length; i += 1) {
        h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
    }
    const positive = Math.abs(h);
    const hour = 8 + (positive % 14);
    const minute = (positive >>> 4) % 60;
    const second = (positive >>> 10) % 60;
    return ((hour * 60 + minute) * 60 + second) * 1000;
};

/** Picks by cumulative weight. `roll` is a value in [0, 1). */
const _pickWeighted = <T extends { weight: number }>(rows: readonly T[], roll: number): T => {
    let total = 0;
    for (const row of rows) {
        total += row.weight;
    }
    let cursor = roll * total;
    for (const row of rows) {
        cursor -= row.weight;
        if (cursor < 0) {
            return row;
        }
    }
    return rows[rows.length - 1];
};

/**
 * Splits `total` across weighted buckets so the parts sum EXACTLY to the total.
 *
 * Largest-remainder, not rounding each share independently. Independent rounding
 * is how a country breakdown ends up totalling 41 against a headline of 40 — and
 * a breakdown that does not add up to the number above it discredits both.
 *
 * @param total - The amount to divide. Non-negative integer.
 * @param weights - Relative weights, one per bucket.
 * @returns One integer per bucket, summing to `total`.
 */
const _splitByWeight = (total: number, weights: readonly number[]): number[] => {
    const weightSum = weights.reduce((sum, w) => sum + w, 0);
    if (total <= 0 || weightSum <= 0) {
        return weights.map(() => 0);
    }
    const exact = weights.map((w) => (total * w) / weightSum);
    const floors = exact.map((value) => Math.floor(value));
    let remaining = total - floors.reduce((sum, v) => sum + v, 0);
    const order = exact
        .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
        .sort((a, b) => (b.remainder - a.remainder) || (a.index - b.index));
    for (const entry of order) {
        if (remaining <= 0) {
            break;
        }
        floors[entry.index] += 1;
        remaining -= 1;
    }
    return floors;
};

/** The demo shop domain for a slug. Reserved TLD, `demo-` prefixed — see the marker note in the constants. */
const _domainFor = (slug: string): string => {
    return `${DEMO_DOMAIN_PREFIX}${slug}${DEMO_DOMAIN_SUFFIX}`;
};

/**
 * The idempotency key, computed exactly as `partner/services/partnerSync.service`
 * computes it: sha256 over app | typename | occurredAt | shop_id | shop_domain | charge_id.
 *
 * ⚠️ Reproduced here rather than imported because it is private to that service.
 * It must stay in step with it: the hash is the only thing standing between a
 * re-run and a doubled install count, and the `charge_id` term is what separates
 * the two charge events of a plan switch, which land in the same second.
 */
const _hashEventId = (input: {
    partner_api_app_id: string;
    event_typename: string;
    occurred_at: string;
    shop_id: string;
    shop_domain: string;
    charge_id: string;
}): string => {
    const payload = [
        input.partner_api_app_id,
        input.event_typename,
        input.occurred_at,
        input.shop_id,
        input.shop_domain,
        input.charge_id
    ].join('|');
    return crypto.createHash('sha256').update(payload).digest('hex');
};

/** The generator's mutable bookkeeping, threaded through the build rather than held in module scope. */
interface _BuildContext {
    anchor: Date;
    quietStart: Date;
    quietEnd: Date;
    rnd: () => number;
    shopSeq: number;
    chargeSeq: number;
    transactionSeq: number;
}

/** `daysAgo` before the anchor, at UTC midnight. */
const _dayAgo = (ctx: _BuildContext, daysAgo: number): Date => {
    return new Date(ctx.anchor.getTime() - daysAgo * _DAY_MS);
};

/** Whether an instant falls inside the deliberately empty stretch. */
const _inQuietWindow = (ctx: _BuildContext, at: Date): boolean => {
    return at.getTime() >= ctx.quietStart.getTime() && at.getTime() <= ctx.quietEnd.getTime();
};

/** Moves an instant out of the quiet window, forward. Used for procedural plan changes only. */
const _avoidQuietWindow = (ctx: _BuildContext, at: Date): Date => {
    if (!_inQuietWindow(ctx, at)) {
        return at;
    }
    return new Date(ctx.quietEnd.getTime() + _DAY_MS);
};


/* ==========================================================================
 *  1. THE STORE CAST
 * ========================================================================== */

/**
 * Builds one procedural store's whole lifecycle from three draws.
 *
 * The shape is identical to a hand-written store's, so everything downstream
 * treats the two populations the same way. What differs is only that these
 * offsets came from a seeded PRNG rather than from a comment explaining which
 * edge case they encode.
 *
 * @param ctx - Anchor, quiet window and the PRNG.
 * @param installedAt - The day this store installed.
 * @param slug - Unique slug for the domain.
 * @param name - Merchant-facing store name.
 * @returns A complete store.
 */
const _buildProceduralStore = (ctx: _BuildContext, installedAt: Date, slug: string, name: string): DemoStoreSpec => {
    const installedDaysAgo = Math.round((ctx.anchor.getTime() - installedAt.getTime()) / _DAY_MS);
    const country = _pickWeighted(DEMO_COUNTRIES, ctx.rnd()).name;

    let attribution: string | null = null;
    if (ctx.rnd() >= UNATTRIBUTED_INSTALL_SHARE) {
        const surfaceKeys = Object.keys(DEMO_ATTRIBUTION_SURFACES);
        const weighted = surfaceKeys.map((key) => ({ key, weight: DEMO_ATTRIBUTION_SURFACES[key].weight }));
        attribution = _pickWeighted(weighted, ctx.rnd()).key;
    }

    const store: DemoStoreSpec = {
        slug,
        name,
        country,
        installed_days_ago: installedDaysAgo,
        uninstalled_days_ago: null,
        reinstalled_days_ago: null,
        deactivated_days_ago: null,
        subscriptions: [],
        attribution,
        credits: []
    };

    // ── Never started a trial ────────────────────────────────────────────────
    if (ctx.rnd() < PROCEDURAL_NO_TRIAL_SHARE) {
        if (ctx.rnd() < PROCEDURAL_NO_TRIAL_UNINSTALL_SHARE) {
            const after = 5 + Math.floor(ctx.rnd() * 56);
            if (installedDaysAgo - after > 0) {
                store.uninstalled_days_ago = installedDaysAgo - after;
            }
        }
        return store;
    }

    const planKey = _pickWeighted(DEMO_PLAN_MIX, ctx.rnd()).plan;
    const acceptedDaysAgo = installedDaysAgo;
    const billingDaysAgo = acceptedDaysAgo - DEMO_TRIAL_DAYS;

    // ── Abandoned during the trial ───────────────────────────────────────────
    if (ctx.rnd() >= PROCEDURAL_TRIAL_CONVERSION_SHARE) {
        const leaveAfter = 2 + Math.floor(ctx.rnd() * 12);
        const leaveDaysAgo = acceptedDaysAgo - leaveAfter;
        // A trial that has not run out yet is still running: no uninstall, and the
        // classifier answers ON_TRIAL because `billingOn` is in the future.
        if (leaveDaysAgo > 0 && billingDaysAgo > 0) {
            store.uninstalled_days_ago = leaveDaysAgo;
        }
        store.subscriptions.push({
            plan: planKey,
            accepted_days_ago: acceptedDaysAgo,
            trial_days: DEMO_TRIAL_DAYS,
            converted: false,
            ended_days_ago: null,
            end_event: null,
            skip_last_payouts: 0,
            test: false,
            events_suppressed: false
        });
        return store;
    }

    // A trial that has not reached its billing date yet cannot have converted.
    if (billingDaysAgo <= 0) {
        store.subscriptions.push({
            plan: planKey,
            accepted_days_ago: acceptedDaysAgo,
            trial_days: DEMO_TRIAL_DAYS,
            converted: false,
            ended_days_ago: null,
            end_event: null,
            skip_last_payouts: 0,
            test: false,
            events_suppressed: false
        });
        return store;
    }

    // ── Converted. Now decide whether, and when, it ends ─────────────────────
    // Geometric survival at a constant monthly hazard: the memoryless assumption is
    // wrong in the real world (early months churn hardest) but it is honest about
    // being a model, and it produces a churn series that is neither flat nor tidy.
    const roll = ctx.rnd();
    const lifetimeMonths = Math.ceil(Math.log(1 - roll) / Math.log(1 - PROCEDURAL_MONTHLY_CHURN_HAZARD));
    const churnDaysAgo = billingDaysAgo - lifetimeMonths * MONTHLY_CYCLE_DAYS;
    const churns = churnDaysAgo > 0;

    if (churns) {
        store.subscriptions.push({
            plan: planKey,
            accepted_days_ago: acceptedDaysAgo,
            trial_days: DEMO_TRIAL_DAYS,
            converted: true,
            ended_days_ago: churnDaysAgo,
            end_event: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_CANCELLED,
            skip_last_payouts: 0,
            test: false,
            events_suppressed: false
        });
        // Most merchants remove the app around the time they cancel; some leave it
        // installed. Both are real, and the roster has to be able to show both.
        if (ctx.rnd() < 0.7) {
            const removeAfter = Math.floor(ctx.rnd() * 4);
            const removeDaysAgo = churnDaysAgo - removeAfter;
            if (removeDaysAgo > 0) {
                store.uninstalled_days_ago = removeDaysAgo;
            }
        }
        return store;
    }

    // ── Survives. Possibly changes plan once ─────────────────────────────────
    const planRoll = ctx.rnd();
    const isAnnual = DEMO_PLANS[planKey].interval === 'ANNUAL';
    const wantsUpgrade = !isAnnual && planRoll < PROCEDURAL_UPGRADE_SHARE;
    const wantsDowngrade = !isAnnual && !wantsUpgrade && planRoll < PROCEDURAL_UPGRADE_SHARE + PROCEDURAL_DOWNGRADE_SHARE;

    if (!wantsUpgrade && !wantsDowngrade) {
        store.subscriptions.push({
            plan: planKey,
            accepted_days_ago: acceptedDaysAgo,
            trial_days: DEMO_TRIAL_DAYS,
            converted: true,
            ended_days_ago: null,
            end_event: null,
            skip_last_payouts: 0,
            test: false,
            events_suppressed: false
        });
        return store;
    }

    const earliestChange = billingDaysAgo - 60;
    if (earliestChange <= 25) {
        store.subscriptions.push({
            plan: planKey,
            accepted_days_ago: acceptedDaysAgo,
            trial_days: DEMO_TRIAL_DAYS,
            converted: true,
            ended_days_ago: null,
            end_event: null,
            skip_last_payouts: 0,
            test: false,
            events_suppressed: false
        });
        return store;
    }

    const changeSpan = earliestChange - 25;
    let changeAt = _dayAgo(ctx, 25 + Math.floor(ctx.rnd() * changeSpan));
    changeAt = _avoidQuietWindow(ctx, changeAt);
    const changeDaysAgo = Math.round((ctx.anchor.getTime() - changeAt.getTime()) / _DAY_MS);

    const ladder = ['STARTER', 'GROWTH', 'PRO'];
    const currentRung = ladder.indexOf(planKey);
    let nextRung = currentRung;
    if (wantsUpgrade) {
        nextRung = Math.min(currentRung + 1, ladder.length - 1);
    } else {
        nextRung = Math.max(currentRung - 1, 0);
    }

    if (nextRung === currentRung) {
        store.subscriptions.push({
            plan: planKey,
            accepted_days_ago: acceptedDaysAgo,
            trial_days: DEMO_TRIAL_DAYS,
            converted: true,
            ended_days_ago: null,
            end_event: null,
            skip_last_payouts: 0,
            test: false,
            events_suppressed: false
        });
        return store;
    }

    // A plan change is TWO subscriptions, because that is what Shopify emits: the
    // old charge is cancelled and a new one is accepted in the same moment.
    store.subscriptions.push({
        plan: planKey,
        accepted_days_ago: acceptedDaysAgo,
        trial_days: DEMO_TRIAL_DAYS,
        converted: true,
        ended_days_ago: changeDaysAgo,
        end_event: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_CANCELLED,
        skip_last_payouts: 0,
        test: false,
        events_suppressed: false
    });
    store.subscriptions.push({
        plan: ladder[nextRung],
        accepted_days_ago: changeDaysAgo,
        trial_days: 0,
        converted: true,
        ended_days_ago: null,
        end_event: null,
        skip_last_payouts: 0,
        test: false,
        events_suppressed: false
    });
    return store;
};


/* ==========================================================================
 *  2. EVENTS AND PAYOUTS — one store's history, folded out
 * ========================================================================== */

/** Identity a store carries into every row it produces. */
interface _StoreIdentity {
    shop_domain: string;
    shop_id: string;
    shop_name: string;
}

/** One settled payout, before it becomes a transaction row. */
interface _Payout {
    at: Date;
    gross: number;
    billing_interval: string;
    charge_id: string;
}

/**
 * The instant a store's payouts must stop, which is NOT the same as the instant
 * its subscription ended.
 *
 * A frozen store (`RelationshipDeactivated`) emits no cancel event at all, and an
 * uninstall ends billing whatever the charge record says. Reading only the
 * subscription's own end leaves a deactivated store billing for ever — which then
 * reads as MRR that never churns, on a suspiciously flat line.
 *
 * @param store - The store.
 * @param subscription - The subscription being billed.
 * @param ctx - Anchor and helpers.
 * @param billingStart - When billing began.
 * @returns The last instant a payout may land on.
 */
const _payoutStopAt = (store: DemoStoreSpec, subscription: DemoSubscriptionSpec, ctx: _BuildContext, billingStart: Date): Date => {
    let stop = ctx.anchor;
    const candidates: Array<number | null> = [
        subscription.ended_days_ago,
        store.uninstalled_days_ago,
        store.deactivated_days_ago
    ];
    for (const daysAgo of candidates) {
        if (daysAgo === null) {
            continue;
        }
        const at = _dayAgo(ctx, daysAgo);
        // An uninstall BEFORE billing started belongs to an earlier chapter of this
        // store's life (it left, came back and then subscribed) and must not
        // truncate a series that had not begun.
        if (at.getTime() <= billingStart.getTime()) {
            continue;
        }
        if (at.getTime() < stop.getTime()) {
            stop = at;
        }
    }
    return stop;
};

/**
 * Turns one store into its events, its payouts and its attribution row.
 *
 * @param store - The store to fold out.
 * @param ctx - Anchor, quiet window, sequence counters.
 * @returns `{ events, payouts, credits, identity }`.
 */
const _foldStore = (store: DemoStoreSpec, ctx: _BuildContext): {
    events: DemoEventRow[];
    payouts: _Payout[];
    credits: Array<{ at: Date; amount: number }>;
    identity: _StoreIdentity;
} => {
    ctx.shopSeq += 1;
    const identity: _StoreIdentity = {
        shop_domain: _domainFor(store.slug),
        shop_id: `gid://shopify/Shop/${90000000000 + ctx.shopSeq}`,
        shop_name: store.name
    };

    const events: DemoEventRow[] = [];
    const payouts: _Payout[] = [];

    /**
     * Appends one event in the exact shape `_syncEvents` would have written it —
     * normalised scalars promoted out of an untouched Partner API node.
     */
    const _emit = (eventType: PartnerEventType, at: Date, chargeId: string, rawExtra: Record<string, unknown>): void => {
        const typename = _TYPENAME_BY_EVENT_TYPE[eventType] || eventType;
        const occurredAt = new Date(at.getTime() + _timeOfDayMs(`${identity.shop_domain}|${typename}|${at.toISOString()}|${chargeId}`));
        const occurredIso = occurredAt.toISOString();
        events.push({
            partner_event_id: _hashEventId({
                partner_api_app_id: DEMO_APP.partner_api_app_id,
                event_typename: typename,
                occurred_at: occurredIso,
                shop_id: identity.shop_id,
                shop_domain: identity.shop_domain,
                charge_id: chargeId
            }),
            event_type: eventType,
            shop_domain: identity.shop_domain,
            shop_id: identity.shop_id,
            shop_name: identity.shop_name,
            charge_id: chargeId,
            occurred_at: occurredAt,
            raw_event: {
                __typename: typename,
                occurredAt: occurredIso,
                shop: {
                    id: identity.shop_id,
                    myshopifyDomain: identity.shop_domain,
                    name: identity.shop_name,
                    avatarUrl: ''
                },
                // The marker a reader hits first when they open a raw row by hand.
                demo_dataset: DEMO_MARKER,
                ...rawExtra
            }
        });
    };

    // ── Relationship events ──────────────────────────────────────────────────
    if (store.installed_days_ago !== null) {
        _emit(PARTNER_EVENT_TYPES.INSTALL, _dayAgo(ctx, store.installed_days_ago), '', {});
    }
    if (store.uninstalled_days_ago !== null) {
        _emit(PARTNER_EVENT_TYPES.UNINSTALL, _dayAgo(ctx, store.uninstalled_days_ago), '', {
            reason: 'NO_LONGER_NEEDED',
            description: ''
        });
    }
    if (store.reinstalled_days_ago !== null) {
        _emit(PARTNER_EVENT_TYPES.REINSTALL, _dayAgo(ctx, store.reinstalled_days_ago), '', {});
    }
    if (store.deactivated_days_ago !== null) {
        _emit(PARTNER_EVENT_TYPES.DEACTIVATED, _dayAgo(ctx, store.deactivated_days_ago), '', {});
    }

    // ── Subscriptions ────────────────────────────────────────────────────────
    for (const subscription of store.subscriptions) {
        ctx.chargeSeq += 1;
        const chargeId = String(880000000000 + ctx.chargeSeq);
        const plan = DEMO_PLANS[subscription.plan];
        const acceptedAt = _dayAgo(ctx, subscription.accepted_days_ago);
        const billingStart = new Date(acceptedAt.getTime() + subscription.trial_days * _DAY_MS);

        const chargeNode = {
            id: `gid://shopify/AppSubscription/${chargeId}`,
            name: plan.name,
            test: subscription.test,
            billingOn: _dateOnly(billingStart),
            amount: { amount: plan.price, currencyCode: DEMO_CURRENCY }
        };

        if (!subscription.events_suppressed) {
            _emit(PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED, acceptedAt, chargeId, { charge: chargeNode });
            if (subscription.converted) {
                _emit(PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACTIVATED, billingStart, chargeId, { charge: chargeNode });
            }
            if (subscription.ended_days_ago !== null && subscription.end_event) {
                _emit(subscription.end_event as PartnerEventType, _dayAgo(ctx, subscription.ended_days_ago), chargeId, { charge: chargeNode });
            }
        }

        // A test charge is never settled by Shopify, so it must produce no payouts.
        // A payout against a test subscription would put money in the ledger for a
        // subscription every cohort excludes — the two sides would disagree by
        // construction.
        if (!subscription.converted || subscription.test) {
            continue;
        }

        const cycleDays = plan.interval === 'ANNUAL' ? ANNUAL_CYCLE_DAYS : MONTHLY_CYCLE_DAYS;
        const stopAt = _payoutStopAt(store, subscription, ctx, billingStart);
        const series: _Payout[] = [];
        for (let k = 0; ; k += 1) {
            const at = new Date(billingStart.getTime() + k * cycleDays * _DAY_MS);
            if (at.getTime() > stopAt.getTime()) {
                break;
            }
            series.push({ at, gross: plan.price, billing_interval: plan.interval, charge_id: chargeId });
        }
        // "Payouts are late" — drop the most recent settled cycles. The subscription
        // is unchanged; only Shopify's settlement is behind.
        const kept = subscription.skip_last_payouts > 0 ? series.slice(0, Math.max(series.length - subscription.skip_last_payouts, 0)) : series;
        payouts.push(...kept);
    }

    const credits = store.credits.map((credit) => ({ at: _dayAgo(ctx, credit.days_ago), amount: credit.amount }));

    return { events, payouts, credits, identity };
};

/** Builds the transaction rows for one store's payouts and credits. */
const _transactionsFor = (
    identity: _StoreIdentity,
    payouts: _Payout[],
    credits: Array<{ at: Date; amount: number }>,
    ctx: _BuildContext
): DemoTransactionRow[] => {
    const rows: DemoTransactionRow[] = [];

    const _row = (
        type: string,
        at: Date,
        gross: number,
        billingInterval: string | null,
        chargeId: string,
        typename: string
    ): DemoTransactionRow => {
        ctx.transactionSeq += 1;
        const fee = _money(gross * SHOPIFY_FEE_RATE);
        const net = _money(gross - fee);
        const createdAt = new Date(at.getTime() + _timeOfDayMs(`${identity.shop_domain}|txn|${ctx.transactionSeq}`));
        const id = `gid://partners/AppSaleDemo/${ctx.transactionSeq}`;
        return {
            shopify_transaction_id: id,
            type: type as DemoTransactionRow['type'],
            shop_domain: identity.shop_domain,
            shop_id: identity.shop_id,
            created_at: createdAt,
            billing_interval: billingInterval,
            charge_id: chargeId,
            net_amount: { amount: net, currency: DEMO_CURRENCY },
            gross_amount: { amount: gross, currency: DEMO_CURRENCY },
            shopify_fee: { amount: fee, currency: DEMO_CURRENCY },
            raw_transaction: {
                __typename: typename,
                id,
                createdAt: createdAt.toISOString(),
                billingInterval,
                chargeId: chargeId === '' ? null : `gid://shopify/AppSubscription/${chargeId}`,
                netAmount: { amount: net, currencyCode: DEMO_CURRENCY },
                grossAmount: { amount: gross, currencyCode: DEMO_CURRENCY },
                shopifyFee: { amount: fee, currencyCode: DEMO_CURRENCY },
                shop: {
                    id: identity.shop_id,
                    myshopifyDomain: identity.shop_domain,
                    name: identity.shop_name,
                    avatarUrl: ''
                },
                demo_dataset: DEMO_MARKER
            }
        };
    };

    for (const payout of payouts) {
        rows.push(_row(
            PARTNER_TRANSACTION_TYPES.APP_SUBSCRIPTION,
            payout.at,
            payout.gross,
            payout.billing_interval,
            payout.charge_id,
            'AppSubscriptionSale'
        ));
    }
    for (const credit of credits) {
        // NEGATIVE money, and deliberately NOT an APP_SUBSCRIPTION: a credit is cash
        // leaving, not a subscription charge. Typed as a subscription it would enter
        // the MRR predicate's history and, as the newest row for that shop, would
        // read as a shop paying a negative amount.
        rows.push(_row(
            PARTNER_TRANSACTION_TYPES.APP_CREDIT,
            credit.at,
            -credit.amount,
            null,
            '',
            'AppSaleCredit'
        ));
    }
    return rows;
};


/* ==========================================================================
 *  3. THE LISTING SIDE
 * ========================================================================== */

/** The per-day listing skeleton, before installs are joined in from the roster. */
interface _ListingDay {
    date: Date;
    views: number;
    engaged_views: number;
    install_clicks: number;
    consent_started: number;
    consent_completed: number;
}

/**
 * Builds the daily listing skeleton and the install budget it implies.
 *
 * ⚠️ VIEWS COME FIRST AND INSTALLS ARE DERIVED FROM THEM, not the other way
 * around, because the funnel has to stay MONOTONE: every step at least as large
 * as the step under it. A funnel whose installs exceed its consent completions
 * does not read as an approximation, it reads as a broken chart.
 *
 * @param ctx - Anchor, quiet window and the PRNG.
 * @returns `{ days, install_budget }` — one entry per day, oldest first.
 */
const _buildListingSkeleton = (ctx: _BuildContext): { days: _ListingDay[]; install_budget: number[] } => {
    const days: _ListingDay[] = [];
    const budget: number[] = [];
    let carry = 0;

    for (let i = 0; i < HISTORY_DAYS; i += 1) {
        const date = _dayAgo(ctx, HISTORY_DAYS - 1 - i);
        const progress = HISTORY_DAYS > 1 ? i / (HISTORY_DAYS - 1) : 1;
        const trend = LISTING_VIEWS_START + (LISTING_VIEWS_END - LISTING_VIEWS_START) * progress;
        const weekday = LISTING_WEEKDAY_FACTORS[date.getUTCDay()];
        const jitter = 0.82 + 0.36 * ctx.rnd();
        const views = Math.max(4, Math.round(trend * weekday * jitter));
        const engagedViews = Math.round(views * LISTING_ENGAGED_VIEW_RATE);
        const installClicks = Math.max(1, Math.round(views * LISTING_INSTALL_CLICK_RATE));
        const consentStarted = Math.round(installClicks * LISTING_CONSENT_START_RATE);
        const consentCompleted = Math.round(consentStarted * LISTING_CONSENT_COMPLETE_RATE);

        days.push({
            date,
            views,
            engaged_views: engagedViews,
            install_clicks: installClicks,
            consent_started: consentStarted,
            consent_completed: consentCompleted
        });

        if (_inQuietWindow(ctx, date)) {
            // The deliberately empty stretch. Merchants still browse — views continue —
            // but nobody installs, so this month's conversion rate is a measured zero
            // and its trial cohort is EMPTY, which is what makes one month's trial
            // conversion rate unmeasurable rather than 0%.
            budget.push(0);
            continue;
        }

        carry += views * LISTING_INSTALL_RATE;
        const whole = Math.floor(carry);
        carry -= whole;
        budget.push(whole);
    }

    return { days, install_budget: budget };
};


/* ==========================================================================
 *  4. THE WHOLE DATASET
 * ========================================================================== */

/**
 * Generates the complete demo dataset.
 *
 * ⚠️ THE ANCHOR IS THE IDENTITY OF THE DATASET. Every row's position is measured
 * back from it, and every row's key is derived from its position — so the same
 * anchor always produces the same rows and a re-run upserts over itself, while a
 * DIFFERENT anchor produces a different dataset that would sit alongside the
 * first. That is why the seeder stores the anchor on the app row and reuses it,
 * rather than taking "today" on every run.
 *
 * @param params0 - Generation inputs.
 * @param params0.anchor_at - The instant the history is measured back from.
 * @returns Every row, in memory, with nothing written anywhere.
 */
const generateDemoDataset = ({ anchor_at }: { anchor_at: Date }): DemoDataset => {
    if (!(anchor_at instanceof Date) || Number.isNaN(anchor_at.getTime())) {
        throw new TypeError('generateDemoDataset requires a valid `anchor_at` Date — there is no default anchor.');
    }

    const anchor = _utcMidnight(anchor_at);
    const quietMonthStart = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - QUIET_MONTHS_BACK, 1));
    const quietMonthEnd = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - QUIET_MONTHS_BACK + 1, 1) - _DAY_MS);
    const ctx: _BuildContext = {
        anchor,
        quietStart: new Date(quietMonthStart.getTime() - QUIET_PADDING_DAYS * _DAY_MS),
        quietEnd: new Date(quietMonthEnd.getTime() + QUIET_PADDING_DAYS * _DAY_MS),
        rnd: _mulberry32(DEMO_RANDOM_SEED),
        shopSeq: 0,
        chargeSeq: 0,
        transactionSeq: 0
    };

    // ⚠️ The guard that keeps the "one month with no measurable rate" case true as
    // the calendar moves. See QUIET_SAFE_BAND_DAYS.
    const quietStartDaysAgo = Math.round((anchor.getTime() - ctx.quietStart.getTime()) / _DAY_MS);
    const quietEndDaysAgo = Math.round((anchor.getTime() - ctx.quietEnd.getTime()) / _DAY_MS);
    if (quietEndDaysAgo < QUIET_SAFE_BAND_DAYS.from || quietStartDaysAgo > QUIET_SAFE_BAND_DAYS.to) {
        throw new Error(
            `The quiet month resolved to ${quietEndDaysAgo}–${quietStartDaysAgo} days ago, outside the safe band `
            + `${QUIET_SAFE_BAND_DAYS.from}–${QUIET_SAFE_BAND_DAYS.to} the hand-written store offsets were chosen against. `
            + 'Widen QUIET_SAFE_BAND_DAYS and re-check every offset in DEMO_NAMED_STORES before changing QUIET_MONTHS_BACK.'
        );
    }

    const { days: listingDays, install_budget: installBudget } = _buildListingSkeleton(ctx);

    // ── Assemble the cast ────────────────────────────────────────────────────
    const stores: DemoStoreSpec[] = [];
    const usedSlugs = new Set<string>();

    for (const named of DEMO_NAMED_STORES) {
        const spec: DemoStoreSpec = {
            slug: named.slug,
            name: named.name,
            country: named.country,
            installed_days_ago: named.installed_days_ago,
            uninstalled_days_ago: named.uninstalled_days_ago,
            reinstalled_days_ago: named.reinstalled_days_ago,
            deactivated_days_ago: named.deactivated_days_ago,
            subscriptions: named.subscriptions.map((subscription) => ({ ...subscription })),
            attribution: named.attribution,
            credits: named.credits.map((credit) => ({ ...credit }))
        };
        // Every hand-written offset that STARTS something must sit outside the quiet
        // window, or the empty month quietly stops being empty.
        const starts: Array<number | null> = [spec.installed_days_ago, spec.reinstalled_days_ago];
        for (const subscription of spec.subscriptions) {
            starts.push(subscription.accepted_days_ago);
        }
        for (const daysAgo of starts) {
            if (daysAgo === null) {
                continue;
            }
            if (_inQuietWindow(ctx, _dayAgo(ctx, daysAgo))) {
                throw new Error(
                    `Demo store '${spec.slug}' starts something ${daysAgo} days before the anchor, which falls inside the `
                    + 'deliberately empty month. Move the offset outside QUIET_SAFE_BAND_DAYS — the empty month is what '
                    + 'gives the dataset a trial cohort with no measurable rate.'
                );
            }
        }
        usedSlugs.add(spec.slug);
        stores.push(spec);
    }

    for (let i = 0; i < listingDays.length; i += 1) {
        const day = listingDays[i];
        for (let n = 0; n < installBudget[i]; n += 1) {
            const first = _NAME_FIRST[Math.floor(ctx.rnd() * _NAME_FIRST.length)];
            const second = _NAME_SECOND[Math.floor(ctx.rnd() * _NAME_SECOND.length)];
            const suffix = _NAME_SUFFIX[Math.floor(ctx.rnd() * _NAME_SUFFIX.length)];
            let slug = `${first}-${second}`;
            let disambiguator = 2;
            while (usedSlugs.has(slug)) {
                slug = `${first}-${second}-${disambiguator}`;
                disambiguator += 1;
            }
            usedSlugs.add(slug);
            const name = `${first[0].toUpperCase()}${first.slice(1)} ${second[0].toUpperCase()}${second.slice(1)} ${suffix}`;
            stores.push(_buildProceduralStore(ctx, day.date, slug, name));
        }
    }

    // ── Fold every store out into rows ───────────────────────────────────────
    const events: DemoEventRow[] = [];
    const transactions: DemoTransactionRow[] = [];
    const attributions: DemoAttributionRow[] = [];
    /** Attributed installs per day index, and how many of them came through an ad. */
    const attributedByDay = new Map<number, { installs: number; ad_installs: number }>();

    const dayIndexOf = (at: Date): number => {
        return Math.round((_utcMidnight(at).getTime() - listingDays[0].date.getTime()) / _DAY_MS);
    };

    for (const store of stores) {
        const { events: storeEvents, payouts, credits, identity } = _foldStore(store, ctx);
        events.push(...storeEvents);
        transactions.push(..._transactionsFor(identity, payouts, credits, ctx));

        if (store.attribution === null || store.installed_days_ago === null) {
            continue;
        }
        const surface = DEMO_ATTRIBUTION_SURFACES[store.attribution];
        const installedAt = _dayAgo(ctx, store.installed_days_ago);

        //  THE ATTRIBUTION TIMESTAMP IS DERIVED FROM THE INSTALL EVENT'S, NOT DRAWN
        // INDEPENDENTLY. `storeRow.resolver` publishes `attribution_lag_seconds` SIGNED and reads
        // the sign as a diagnostic: a consistent lag in one direction is export latency, an
        // inconsistent one is a MISMATCHED ROW. Two independent time-of-day draws would scatter the
        // lag either side of zero by hours, and the roster would correctly report that the demo's
        // own attribution join is unreliable.
        const installEvent = storeEvents.find((row) => row.event_type === PARTNER_EVENT_TYPES.INSTALL)
            || storeEvents.find((row) => row.event_type === PARTNER_EVENT_TYPES.REINSTALL);
        const lagSeconds = 45 + (_timeOfDayMs(`${identity.shop_domain}|lag`) % 555000) / 1000;
        const installedAtWithTime = installEvent
            ? new Date(installEvent.occurred_at.getTime() + Math.round(lagSeconds) * 1000)
            : new Date(installedAt.getTime() + _timeOfDayMs(`${identity.shop_domain}|attrib`));
        const isPaid = surface.surface_type.endsWith('_ad');
        const countryRow = DEMO_COUNTRIES.find((row) => row.name === store.country) || DEMO_COUNTRIES[0];

        attributions.push({
            shop_domain: identity.shop_domain,
            shop_url_raw: `https://${identity.shop_domain}`,
            shop_id: identity.shop_id,
            shop_name: identity.shop_name,
            installed_at: installedAtWithTime,
            install_date: installedAt,
            user_pseudo_id: `demo.${crypto.createHash('sha1').update(identity.shop_domain).digest('hex').slice(0, 16)}`,
            source: surface.source,
            medium: surface.medium,
            campaign: surface.campaign,
            attribution_source: surface.attribution_source,
            surface_type: surface.surface_type,
            surface_detail: surface.surface_detail,
            surface_inter_position: surface.surface_type === '' ? null : 1 + Math.floor(ctx.rnd() * 4),
            surface_intra_position: surface.surface_type === '' ? null : 1 + Math.floor(ctx.rnd() * 12),
            surface_via: surface.surface_via,
            surface_version: '2',
            ad_clicks_before_install: isPaid ? 1 + Math.floor(ctx.rnd() * 3) : 0,
            country: countryRow.name,
            locale: countryRow.locale,
            sync_job_id: ''
        });

        const index = dayIndexOf(installedAt);
        if (index >= 0 && index < listingDays.length) {
            const bucket = attributedByDay.get(index) || { installs: 0, ad_installs: 0 };
            bucket.installs += 1;
            if (isPaid) {
                bucket.ad_installs += 1;
            }
            attributedByDay.set(index, bucket);
        }
    }

    // ── The three listing rollups ────────────────────────────────────────────
    const funnelDays: DemoFunnelDayRow[] = [];
    const sourceDays: DemoSourceDayRow[] = [];
    const geoDays: DemoGeoDayRow[] = [];

    for (let i = 0; i < listingDays.length; i += 1) {
        const day = listingDays[i];
        const attributed = attributedByDay.get(i) || { installs: 0, ad_installs: 0 };

        // Lift each step to at least the step below it. A hand-written store landing
        // on a quiet day can push installs above the skeleton's consent completions;
        // raising the upper steps is the only repair that keeps the funnel readable.
        const installs = attributed.installs;
        const consentCompleted = Math.max(day.consent_completed, installs);
        const consentStarted = Math.max(day.consent_started, consentCompleted);
        const installClicks = Math.max(day.install_clicks, consentStarted);
        const engagedViews = Math.max(day.engaged_views, installClicks);
        const views = Math.max(day.views, engagedViews);

        funnelDays.push({
            date: day.date,
            views,
            engaged_views: engagedViews,
            install_clicks: installClicks,
            consent_started: consentStarted,
            consent_completed: consentCompleted,
            installs,
            ad_clicks: attributed.ad_installs,
            first_opens: installs,
            sessions: Math.round(views * LISTING_SESSION_RATE),
            first_visits: Math.round(views * LISTING_FIRST_VISIT_RATE),
            // `rate()`, NOT A SECOND `safeDiv`. A private `_safeDiv` used to live in this file
            // returning `0` for an absent denominator, under a comment claiming it matched
            // `bigQuerySync.service`. It stopped matching the day the sync switched to `rate()`, and
            // a seeder that plants `0` where the sync plants `null` puts rows in the demo database
            // that CONTRADICT the model's own contract — the demo then looks correct while the
            // shipped product looks broken, or the reverse. `bigQueryRow.helper` says the second
            // spelling of "divide" is how the first one comes back; this was the second spelling.
            overall_conversion_rate: rate(installs, views),
            ad_attributed_share: rate(attributed.ad_installs, installs),
            source_bq_query_id: '',
            bytes_scanned: 0
        });

        const sourceViews = _splitByWeight(views, DEMO_TRAFFIC_SOURCES.map((row) => row.weight));
        const sourceUsers = _splitByWeight(Math.round(views * 0.83), DEMO_TRAFFIC_SOURCES.map((row) => row.weight));
        const sourceClicks = _splitByWeight(installClicks, DEMO_TRAFFIC_SOURCES.map((row) => row.weight));
        const sourceInstalls = _splitByWeight(installs, DEMO_TRAFFIC_SOURCES.map((row) => row.weight));
        for (let s = 0; s < DEMO_TRAFFIC_SOURCES.length; s += 1) {
            if (sourceViews[s] === 0 && sourceInstalls[s] === 0) {
                continue;
            }
            sourceDays.push({
                date: day.date,
                traffic_source: DEMO_TRAFFIC_SOURCES[s].traffic_source,
                traffic_medium: DEMO_TRAFFIC_SOURCES[s].traffic_medium,
                users: sourceUsers[s],
                views: sourceViews[s],
                install_clicks: sourceClicks[s],
                installs: sourceInstalls[s]
            });
        }

        const geoViews = _splitByWeight(views, DEMO_COUNTRIES.map((row) => row.weight));
        const geoInstalls = _splitByWeight(installs, DEMO_COUNTRIES.map((row) => row.weight));
        for (let c = 0; c < DEMO_COUNTRIES.length; c += 1) {
            if (geoViews[c] === 0 && geoInstalls[c] === 0) {
                continue;
            }
            geoDays.push({
                date: day.date,
                country: DEMO_COUNTRIES[c].name,
                views: geoViews[c],
                installs: geoInstalls[c],
                // Same rule as the funnel row above: `null` for a bucket with no views, and a
                // measured `0` for views that produced no installs.
                conversion_rate: rate(geoInstalls[c], geoViews[c])
            });
        }
    }

    // ── Sync history ────────────────────────────────────────────────────────
    // ⚠️ EVERY ROW IS TERMINAL — SUCCESS or FAILED, never PENDING or RUNNING.
    // `gi_sync_jobs` is the QUEUE, not a log of one: a PENDING row seeded here
    // would be claimed by the job runner on the next poll and executed against a
    // Partner organisation the demo user does not have.
    const syncJobs: DemoSyncJobRow[] = [];
    for (let i = 0; i < DEMO_SYNC_JOB_COUNT; i += 1) {
        const finishedAt = new Date(anchor_at.getTime() - i * DEMO_SYNC_JOB_INTERVAL_HOURS * 60 * 60 * 1000);
        const durationMs = 4200 + ((i * 977) % 9000);
        const startedAt = new Date(finishedAt.getTime() - durationMs);
        let jobType: DemoSyncJobRow['job_type'] = SYNC_JOB_TYPES.PARTNER_SYNC;
        if (i % 4 === 1) {
            jobType = SYNC_JOB_TYPES.BIGQUERY_SYNC;
        } else if (i % 4 === 3) {
            jobType = SYNC_JOB_TYPES.INSTALL_ATTRIBUTION_SYNC;
        }

        // One failure, so the Sync page shows what a failed run looks like rather
        // than an unbroken column of green nobody has ever seen fail.
        const failed = i === 5;
        syncJobs.push({
            job_type: jobType,
            payload: { mode: 'AUTO', demo_dataset: DEMO_MARKER },
            status: failed ? SYNC_JOB_STATUS.FAILED : SYNC_JOB_STATUS.SUCCESS,
            triggered_by: i === 0 ? SYNC_JOB_TRIGGERED_BY.MANUAL : SYNC_JOB_TRIGGERED_BY.CRON,
            triggered_by_user_id: '',
            started_at: startedAt,
            completed_at: finishedAt,
            duration_ms: durationMs,
            error_message: failed ? 'Partner API responded 429 Too Many Requests after 4 retries.' : '',
            failure_reason: failed ? SYNC_JOB_FAILURE_REASONS.HANDLER_ERROR : '',
            result_summary: failed
                ? { demo_dataset: DEMO_MARKER }
                : { events_upserted: 0, transactions_upserted: 0, demo_dataset: DEMO_MARKER },
            attempts: 1
        });
    }

    return {
        anchor_at: anchor,
        app: {
            app_handle: DEMO_APP.app_handle,
            display_name: DEMO_APP.display_name,
            listing_url: DEMO_APP.listing_url,
            partner_api_app_id: DEMO_APP.partner_api_app_id,
            categories: [...DEMO_APP.categories],
            target_keywords: [...DEMO_APP.target_keywords],
            metadata: {
                demo: {
                    marker: DEMO_MARKER,
                    seed_version: DEMO_SEED_VERSION,
                    anchor_at: anchor.toISOString(),
                    generated_at: new Date().toISOString(),
                    notice: 'Synthetic demo data. Every shop domain ends in the reserved .example TLD and no figure '
                        + 'on this app describes a real business. Remove it with: npm run seed:demo:down'
                }
            }
        },
        stores,
        events,
        transactions,
        funnel_days: funnelDays,
        source_days: sourceDays,
        geo_days: geoDays,
        attributions,
        sync_jobs: syncJobs,
        quiet_window: {
            start: ctx.quietStart,
            end: ctx.quietEnd,
            month: _monthKey(quietMonthStart)
        }
    };
};

export = {
    generateDemoDataset,
    // Exported for the test, which checks the split adds up rather than trusting it.
    _splitByWeight
};
