'use strict';

/**
 * ============================================================================
 *  RAW CHARGE EVENTS  →  ONE ROW PER SUBSCRIPTION  →  ONE WINNER PER STORE
 * ============================================================================
 *
 *  Takes ALREADY-FETCHED event rows and folds them. It reaches no repository and reads no clock: a
 *  resolver is permitted a repository, but every input here is data, which is what lets the whole
 *  fold be exercised against a handful of captured rows with no database. The next layer wires the
 *  fetch; the `$in` list it needs is `CHARGE_COHORT_EVENT_TYPES` in the constants, not here — a
 *  repository importing a resolver would invert the layer direction.
 *
 *  ──  THE BUCKET KEY, AND THE ROW THAT MUST NOT BE POOLED ─────────────────────────────────────
 *
 *      chg:<charge_id>       when the event names a charge
 *      shop:<shop_domain>    otherwise
 *      neither               SKIPPED AND COUNTED — never pooled
 *
 *  `shop_domain`, NOT `shop_id`. The upstream implementation keyed on `shop_id`, which is `''`
 *  on older event rows — so every such row shared one key and MERGED INTO A SINGLE FABRICATED
 *  SUBSCRIPTION, one row where there were many. The same failure is what makes the keyless case a
 *  skip rather than a fallback bucket: a synthetic key is not a smaller number, it is a wrong one,
 *  and it looks exactly like a real subscription. The skip is counted so the service can say so.
 *
 *  ──  END EVENTS: THE FIRST ONE AT OR AFTER THE START, NOT THE EARLIEST EVER ────────────────
 *
 *  The upstream fold took the EARLIEST end event per shop, all-time. A store that subscribed in
 *  January, uninstalled in February and resubscribed in March gets February — which is BEFORE the
 *  March subscription's start, so its `end_at` stayed null and that subscription NEVER CHURNED. Every
 *  multi-subscription store was systematically under-churned and over-converted. Here the end dates
 *  are kept as a sorted list per key and the first one at or after the bucket's start is taken.
 *
 *  Which list depends on how the bucket is keyed, because `UNINSTALL` and `DEACTIVATED` are
 *  RELATIONSHIP events and carry no charge block at all:
 *    - a charge-keyed bucket looks at its own charge's end events PLUS that shop's charge-less end
 *      events. A different charge's cancellation must not end this one — that is a plan switch, and
 *      folding it in would churn a customer who upgraded.
 *    - a shop-keyed bucket has no charge to discriminate with, so it looks at every end event for
 *      the shop. Coarser, and unavoidably so; it applies only to rows that carried no charge id.
 *
 *  ──  THE TEST-CHARGE EXCLUSION IS ASYMMETRIC AND CANNOT BE MADE SYMMETRIC ──────────────────
 *
 *  A subscription is excluded on `raw_event.charge.test === true`. Partner RELATIONSHIP events —
 *  INSTALL, UNINSTALL, REINSTALL, DEACTIVATED — carry NO test flag anywhere (`FIDELITY.md` §5, "The test-charge exclusion is asymmetric"
 *  confirms nothing reads one), so the install spine still contains test stores while the
 *  subscription side has dropped them. The funnel can therefore show an impossible drop between
 *  "Installed" and "Trial started". There is no data that would fix it. The only honest response is
 *  to REPORT it: `diagnostics.test_excluded` / `test_subscriptions_excluded` are published for
 *  exactly that, and the service must warn when either is above zero.
 *
 *  ── THE CANCEL TRAP: A PLAN CHANGE ARRIVES AS A CANCELLATION ─────────────────────────────
 *
 *  Shopify emits a plan change as a CANCEL of the old charge and an ACCEPT of the new one IN THE
 *  SAME SECOND. `modules/partner/services/partnerSync.service.ts` documents this on `_hashEventId`,
 *  where `charge_id` had to be added to the event hash or the two collapsed into one stored row.
 *
 *  This fold keys a bucket per CHARGE, so one merchant upgrading once produces TWO buckets — and
 *  therefore two `trial_started`, one end event that is not a departure, and two entries in whatever
 *  the two charges classify as. When the change happens INSIDE the trial, the old charge's end lands
 *  at or before its own `billingOn` and `classifyAsOf` books it `CHURNED_DURING_TRIAL`: the merchant
 *  who did the best possible thing is counted as having walked out.
 *
 *  THIS FOLD MEASURES THAT EXPOSURE AND CHANGES NOTHING ELSE. `end_event_type` records WHICH
 *  event ended a subscription and `superseded_by_charge_id` names the charge that started for the
 *  same shop within `SUPERSESSION_WINDOW_MS` of that end; `diagnostics.supersession` counts them and
 *  `describeChargeCohortExposure` turns the counts into the operator-facing sentences. No state is
 *  reclassified, no end is suppressed, and no count moves — deciding what to DO about a detected
 *  plan change is a separate decision that needs this number first. Suppressing the cancel here
 *  would silently delete every genuine cancellation that happens to be followed by a new charge.
 *
 *  ⚠️ The detection is a FLOOR, and deliberately so. Both sides must be CHARGE-KEYED: a shop-keyed
 *  bucket carries no charge id, so pairing two of them for one store cannot be told apart from a
 *  store that genuinely subscribed twice. Undetectable is reported as undetected, never as detected.
 *
 *  ── ⚠️ `billingOn` ARRIVES ON `ACTIVATED`, NOT ON `ACCEPTED` ─────────────────────────────────
 *
 *  Measured on a live operator database of 38,719 events: `SUBSCRIPTION_CHARGE_ACCEPTED` fired 13
 *  times and carried `billingOn` ZERO times; `SUBSCRIPTION_CHARGE_ACTIVATED` fired 1,632 times and
 *  carried it 1,632 times. So the merge branch below — "a later ACTIVATED fills in facts the
 *  ACCEPTED did not carry" — is not the exception it reads as. It is essentially the ONLY path by
 *  which a subscription acquires a `conversion_date`, and comments elsewhere that name ACCEPTED as
 *  the source of the trial-end date describe a path the data does not take.
 *
 *  `conversion_source_event_type` publishes which event actually supplied it, per row, so that fact
 *  is checkable rather than asserted. `billing_on_gap_days` publishes the distance from that event
 *  to the date it announced — see `FIDELITY.md` §5 for why that gap is NOT a trial length.
 * ============================================================================
 */

import shopDomainHelper = require('../../shared/helpers/shopDomain.helper');
import lifecycleConstants = require('../constants/lifecycle.constants');
import subscriptionStateHelper = require('../helpers/subscriptionState.helper');

import type {
    ChargeCohortDiagnostics,
    ChargeCohortEventRow,
    ChargeCohortInput,
    ChargeCohortResult,
    CohortSubscription
} from '../types/lifecycle.types';

const { normaliseShopDomain } = shopDomainHelper;
const { SUBSCRIPTION_START_EVENT_TYPES, SUBSCRIPTION_END_EVENT_TYPES, SUBSCRIPTION_STATES } = lifecycleConstants;
const {
    toDate,
    readPartnerCharge,
    resolveTrialEnd,
    resolveChargeLinkState,
    classifyAsOf,
    toLifecycleState
} = subscriptionStateHelper;

const _DAY_MS = 86400000;

/**
 * How close another charge's start must be to this subscription's end to be called its SUCCESSOR.
 *
 * Shopify emits the two halves of a plan change in the SAME SECOND, and `occurredAt` has no
 * sub-second component at all — so the true signature is a delta of exactly zero. The window is
 * wider than that on purpose: the two events are separate rows written by separate mutations, and a
 * pairing rule that only accepts an exact tie would silently miss every plan change that straddled a
 * second boundary. One minute is the smallest span that is robust to that and still far shorter than
 * any interval in which a merchant plausibly cancels and then independently re-subscribes.
 *
 * ⚠️ WIDENING THIS DOES NOT MAKE THE DETECTION BETTER. Every millisecond added admits more genuine
 * cancel-then-resubscribe pairs, and the counter's whole value is that it is a floor an operator can
 * trust rather than an estimate they have to discount. `same_second` is published alongside for
 * exactly that reason: it is the subset that carries Shopify's own signature and needs no judgement.
 */
const SUPERSESSION_WINDOW_MS = 60000;

/** A delta strictly inside one second — the same-second signature, at `occurredAt`'s own resolution. */
const SAME_SECOND_MS = 1000;

/**
 * The widest `event → billingOn` gap that could still plausibly be a free trial.
 *
 * A REPORTING BAND AND NOTHING ELSE. No row is reclassified on it, no state depends on it, and no
 * published figure moves when it changes. It exists so an operator can see how much of their trial
 * data is a gap that cannot be a trial at all, and it is deliberately generous so that being ABOVE
 * it is a strong statement rather than a borderline one.
 *
 * ⚠️ BEING INSIDE THE BAND IS NOT EVIDENCE OF A TRIAL. On the live database this was measured
 * against, the gap is bimodal — ~854 charges at 6–7 days and ~547 at 29–30 — with the same plan
 * names in both bands. The stored charge object has exactly five keys (`id`, `name`, `test`,
 * `billingOn`, `amount`) and the Partner API's `AppSubscription` exposes no more, so there is no
 * `trialDays` anywhere and NOTHING distinguishes a 30-day trial from a no-trial subscription whose
 * first billing simply falls one cycle out. A threshold that split the two bands would be an
 * invention, which is why there is not one.
 */
const BILLING_ON_GAP_MAX_PLAUSIBLE_TRIAL_DAYS = 90;

/**
 * One end event, carrying WHICH event it was.
 *
 * The type is kept beside the instant rather than discarded because "this subscription ended" and
 * "this subscription was CANCELLED, as opposed to the store uninstalling" are different facts, and
 * the cancel trap is only legible in terms of the second one. A bare `Date[]` cannot answer it.
 */
interface _EndEvent {
    at: Date;
    /** The Partner event type — `SUBSCRIPTION_CHARGE_CANCELLED`, `UNINSTALL`, `DEACTIVATED`, … */
    type: string;
}

/** One subscription mid-fold, before it has been classified. */
interface _Bucket {
    bucket_key: string;
    charge_id: string;
    shop_domain: string;
    trial_start: Date;
    conversion_date: Date | null;
    /**
     * `occurred_at` of the event that SUPPLIED `conversion_date`, and its type.
     *
     * ⚠️ Kept because the provenance is not what the comments in this build assumed. On live data
     * `billingOn` arrives on `SUBSCRIPTION_CHARGE_ACTIVATED` essentially 100% of the time and on
     * `SUBSCRIPTION_CHARGE_ACCEPTED` never — see the file header. Publishing the source event makes
     * that checkable per row instead of asserted in a comment.
     */
    conversion_source_at: Date | null;
    conversion_source_event_type: string;
    plan_name: string;
    plan_price: number | null;
    currency: string;
}

/** A fresh, all-zero counter set. One literal, so no caller can invent a partial diagnostics object. */
const _emptyDiagnostics = (): ChargeCohortDiagnostics => ({
    events_read: 0,
    events_considered: 0,
    test_excluded: 0,
    test_subscriptions_excluded: 0,
    skipped_keyless: 0,
    shopless_events: 0,
    undated_events: 0,
    unrecognised_events: 0,
    out_of_spine: 0,
    subscriptions: 0,
    domains: 0,
    subscriptions_superseded: 0,
    supersession: {
        detected: 0,
        same_second: 0,
        distinct_successors: 0,
        shops: 0,
        churned_during_trial: 0,
        churned_after_trial: 0,
        window_ms: SUPERSESSION_WINDOW_MS
    },
    billing_on_gap: {
        measured: 0,
        negative: 0,
        above_band: 0,
        band_max_days: BILLING_ON_GAP_MAX_PLAUSIBLE_TRIAL_DAYS
    },
    charge_link: { resolved: 0, unresolved: 0, absent: 0 },
    state_basis: { billing_on: 0, settled_payout: 0, inferred: 0 },
    trial_days_source: { partner_billing_on: 0, none: 0 }
});

/**
 * A `Set` of normalised domains from any iterable, dropping the unusable ones.
 *
 * The NEEDLES are normalised; the stored `shop_domain` on an event is left exactly as it is. Both
 * sides of this join are canonicalised on write (`partnerSync.service.ts:440`,
 * `listingInstallAttribution.model.ts`), so re-normalising a stored value is the waste that
 * guarantee exists to remove — while normalising a caller-supplied needle is free and idempotent,
 * and is what stops a hand-typed domain from silently matching nothing.
 */
const _domainSet = (values?: Iterable<string> | null): Set<string> => {
    const out = new Set<string>();
    if (!values) {
        return out;
    }
    for (const value of values) {
        const domain = normaliseShopDomain(value);
        if (domain !== '') {
            out.add(domain);
        }
    }
    return out;
};

/** A `Set` of charge ids, as strings, dropping empties. Ids are already bare numeric on both sides. */
const _idSet = (values?: Iterable<string> | null): Set<string> => {
    const out = new Set<string>();
    if (!values) {
        return out;
    }
    for (const value of values) {
        const id = String(value === null || value === undefined ? '' : value).trim();
        if (id !== '') {
            out.add(id);
        }
    }
    return out;
};

/** Appends to a keyed list, creating it on first use. Order in = order out, so lists stay sorted. */
const _push = (map: Map<string, _EndEvent[]>, key: string, event: _EndEvent): void => {
    const list = map.get(key);
    if (list) {
        list.push(event);
        return;
    }
    map.set(key, [event]);
};

/**
 * The first date at or after `start`, from a list already in ascending order.
 *
 * "At or after", never "the earliest in the list" — see the header. Linear because these lists
 * hold a handful of entries each (a subscription's own cancellation, a store's uninstalls); a binary
 * search here would be more code guarding the same answer.
 */
const _firstAtOrAfter = (events: _EndEvent[] | undefined, start: Date): _EndEvent | null => {
    if (!events || events.length === 0) {
        return null;
    }
    const floor = start.getTime();
    for (const event of events) {
        if (event.at.getTime() >= floor) {
            return event;
        }
    }
    return null;
};

/** The earlier of two candidate end events, tolerating nulls on either side. */
const _earlier = (a: _EndEvent | null, b: _EndEvent | null): _EndEvent | null => {
    if (!a) {
        return b;
    }
    if (!b) {
        return a;
    }
    return a.at.getTime() <= b.at.getTime() ? a : b;
};

/**
 * Folds raw subscription-charge events into per-subscription cohort rows, then into one winner per
 * store.
 *
 * ⚠️ The caller must bound its FETCH at `as_of` (`occurred_at: { $lte: until }`) and must NOT apply
 * a lower bound: a store that installed inside the window may have subscribed at any point before
 * it, and cutting the scan at the window's start misreports that store as never having subscribed.
 *
 * The pipeline:
 *   1. Sort a COPY of the rows by `occurred_at` ascending, so every "earliest wins" decision below
 *      is deterministic and every end list comes out sorted. A copy — sorting the caller's array
 *      in place mutates data it may already have tallied.
 *   2. Partition into START buckets and END date-lists, excluding test charges and counting them.
 *   3. Per bucket: find the end EVENT, read the settled-payout evidence, classify as of `as_of`.
 *  3b. MEASURE the cancel trap — name each subscription's successor, and change nothing else.
 *   4. Fold to one subscription per domain — LATEST `trial_start` WINS.
 *
 * @param input - Events, the judgement instant, and the optional evidence sets.
 * @returns Subscriptions, the per-domain winners, and every exclusion counted.
 */
const resolveChargeCohortForDomains = (input: ChargeCohortInput): ChargeCohortResult => {
    const diagnostics = _emptyDiagnostics();
    const asOf = input && input.as_of instanceof Date && !Number.isNaN(input.as_of.getTime()) ? input.as_of : null;
    if (!asOf) {
        // Validated ONCE, here, so `classifyAsOf` can never throw mid-fold and leave a half-built
        // cohort. There is no honest default for the judgement instant — see that helper's header.
        throw new TypeError('resolveChargeCohortForDomains requires a valid `as_of` Date.');
    }

    const rows: ChargeCohortEventRow[] = Array.isArray(input.events) ? input.events.slice() : [];
    diagnostics.events_read = rows.length;

    const startTypes = new Set(SUBSCRIPTION_START_EVENT_TYPES);
    const endTypes = new Set(SUBSCRIPTION_END_EVENT_TYPES);
    const spine = input.domains ? _domainSet(input.domains) : null;
    const settledCharges = _idSet(input.settled_charge_ids);
    const settledDomains = _domainSet(input.settled_domains);

    // ── 1. Deterministic order ──────────────────────────────────────────────
    const dated: Array<{ row: ChargeCohortEventRow; at: Date }> = [];
    for (const row of rows) {
        const at = toDate(row && row.occurred_at);
        if (!at) {
            // `occurred_at` is `required: true` on the schema, so this is unreachable from a stored
            // document. It is counted rather than ignored because the alternative — dropping a row
            // silently — is how a fold quietly answers for fewer events than it was given.
            diagnostics.undated_events += 1;
            continue;
        }
        dated.push({ row, at });
    }
    dated.sort((a, b) => a.at.getTime() - b.at.getTime());

    // ── 2. Partition ────────────────────────────────────────────────────────
    const buckets = new Map<string, _Bucket>();
    /** End events that name a charge, keyed by it. */
    const endsByCharge = new Map<string, _EndEvent[]>();
    /** End events with NO charge — the relationship events. Keyed by shop. */
    const endsByShopRelationship = new Map<string, _EndEvent[]>();
    /** Every end event for a shop, whatever it names. Only a shop-keyed bucket may use this. */
    const endsByShopAny = new Map<string, _EndEvent[]>();
    /**
     * Distinct bucket keys seen on a test charge, so the count is subscriptions and not events.
     *
     * NOT ITSELF THE PUBLISHED NUMBER — see the reconciliation after the loop. A key lands here
     * because ONE event carried `charge.test`, which is not the same fact as the subscription having
     * been excluded.
     */
    const testBucketKeys = new Set<string>();

    for (const { row, at } of dated) {
        const eventType = String(row.event_type || '');
        const isStart = startTypes.has(eventType);
        const isEnd = endTypes.has(eventType);
        if (!isStart && !isEnd) {
            diagnostics.unrecognised_events += 1;
            continue;
        }

        const charge = readPartnerCharge(row.raw_event);
        // The stored column first: it is normalised on write and indexed. The raw payload is the
        // fallback for a row whose column was never populated — same bridge either way, because
        // `readPartnerCharge` runs the id through `shared/helpers/chargeId.helper` too.
        const chargeId = String(row.charge_id || '') || charge.charge_id;
        // ⚠️ Do NOT re-normalise: `gi_partner_app_events.shop_domain` is canonical on write.
        const shopDomain = String(row.shop_domain || '');

        if (charge.test) {
            diagnostics.test_excluded += 1;
            // ⚠️ A KEYLESS TEST EVENT CONTRIBUTES NO KEY. Adding the literal `shop:` for it made one
            // synthetic entry that every other keyless test event then collapsed into — a bucket key
            // naming no bucket, counted as a subscription. The event is still counted above, which
            // is where "we dropped a row" belongs; `skipped_keyless` is deliberately NOT incremented
            // as well, because this row was excluded for being a TEST, and one exclusion counted
            // under two headings is a number that cannot be reconciled with anything.
            if (chargeId !== '' || shopDomain !== '') {
                testBucketKeys.add(chargeId !== '' ? `chg:${chargeId}` : `shop:${shopDomain}`);
            }
            continue;
        }

        if (shopDomain === '') {
            diagnostics.shopless_events += 1;
        }

        if (isEnd) {
            // The keyless gate applies to an END row exactly as it does to a START row. Without
            // this the row lands in NO end map, is dropped, and is still counted as `considered` —
            // a counter whose own definition is "survived the keyless gate", reporting a row that
            // did not. The fold would then answer for more events than it actually used.
            if (chargeId === '' && shopDomain === '') {
                diagnostics.skipped_keyless += 1;
                continue;
            }
            diagnostics.events_considered += 1;
            // ⚠️ The TYPE travels with the instant. `end_event_type` on the row is what lets an
            // operator tell a `SUBSCRIPTION_CHARGE_CANCELLED` — the half of a plan change Shopify
            // emits in the same second as the replacement — from an `UNINSTALL`, which is a merchant
            // actually leaving. Collapsing these back to bare dates re-hides the cancel trap.
            const endEvent: _EndEvent = { at, type: eventType };
            if (chargeId !== '') {
                _push(endsByCharge, chargeId, endEvent);
            } else {
                // No charge id but a domain — a RELATIONSHIP end (uninstall, deactivation), which
                // is the only end signal a charge-keyed bucket may borrow from its shop.
                _push(endsByShopRelationship, shopDomain, endEvent);
            }
            if (shopDomain !== '') {
                _push(endsByShopAny, shopDomain, endEvent);
            }
            continue;
        }

        // ── START ───────────────────────────────────────────────────────────
        let bucketKey = '';
        if (chargeId !== '') {
            bucketKey = `chg:${chargeId}`;
        } else if (shopDomain !== '') {
            bucketKey = `shop:${shopDomain}`;
        }
        if (bucketKey === '') {
            // Skipped, never pooled. See the header.
            diagnostics.skipped_keyless += 1;
            continue;
        }
        diagnostics.events_considered += 1;

        const existing = buckets.get(bucketKey);
        if (!existing) {
            buckets.set(bucketKey, {
                bucket_key: bucketKey,
                charge_id: chargeId,
                shop_domain: shopDomain,
                trial_start: at,
                conversion_date: charge.billing_on,
                // Provenance travels with the date, or the pair is a claim nobody can check.
                conversion_source_at: charge.billing_on ? at : null,
                conversion_source_event_type: charge.billing_on ? eventType : '',
                plan_name: charge.plan_name,
                plan_price: charge.plan_price,
                currency: charge.currency
            });
            continue;
        }

        // Rows arrive in ascending time, so the bucket already holds the EARLIEST start; a later
        // event only fills in facts the earlier one did not carry. Nothing already known is
        // overwritten — a second, later value for the same field would silently move the trial end.
        //
        // ⚠️ THIS BRANCH IS THE NORMAL PATH FOR `conversion_date`, NOT THE EXCEPTION, and the
        // comment here used to imply the reverse. Measured on a live operator database of 38,719
        // events: ACCEPTED fired 13 times and carried `billingOn` ZERO times, while ACTIVATED fired
        // 1,632 times and carried it every single time. So a trial end essentially always arrives on
        // the SECOND start event, through here — which is why the source event is recorded with it.
        if (!existing.conversion_date && charge.billing_on) {
            existing.conversion_date = charge.billing_on;
            existing.conversion_source_at = at;
            existing.conversion_source_event_type = eventType;
        }
        if (existing.plan_name === '' && charge.plan_name !== '') {
            existing.plan_name = charge.plan_name;
        }
        if (existing.plan_price === null && charge.plan_price !== null) {
            existing.plan_price = charge.plan_price;
        }
        if (existing.currency === '' && charge.currency !== '') {
            existing.currency = charge.currency;
        }
        if (existing.shop_domain === '' && shopDomain !== '') {
            existing.shop_domain = shopDomain;
        }
    }

    // WHAT WAS ACTUALLY EXCLUDED, not what carried a test flag. The two differ whenever a
    // subscription's START is live and a LATER event on the same charge is flagged — a CANCELLED
    // carrying `charge.test === true` against a real ACCEPTED, say. The bucket survives and is
    // reported in full, so counting its key here made the rendered warning "N test subscription(s)
    // were excluded" claim more than the fold had dropped. Set-difference against the surviving
    // buckets is the honest count: a test key that named no live subscription.
    //
    // ⚠️ The residual is real and is NOT counted here: that flagged CANCELLED's churn date was
    // dropped, so its store can read as still-converted. It belongs to `test_excluded`, which counts
    // events and is already published beside this — there is no data that would let the fold decide
    // whether the flag or the subscription is the mistake.
    let testSubscriptionsExcluded = 0;
    for (const key of testBucketKeys) {
        if (!buckets.has(key)) {
            testSubscriptionsExcluded += 1;
        }
    }
    diagnostics.test_subscriptions_excluded = testSubscriptionsExcluded;

    // ── 3. Classify ─────────────────────────────────────────────────────────
    const subscriptions: CohortSubscription[] = [];

    for (const bucket of buckets.values()) {
        if (spine && !spine.has(bucket.shop_domain)) {
            diagnostics.out_of_spine += 1;
            continue;
        }

        let endEvent: _EndEvent | null;
        if (bucket.charge_id !== '') {
            endEvent = _earlier(
                _firstAtOrAfter(endsByCharge.get(bucket.charge_id), bucket.trial_start),
                _firstAtOrAfter(endsByShopRelationship.get(bucket.shop_domain), bucket.trial_start)
            );
        } else {
            endEvent = _firstAtOrAfter(endsByShopAny.get(bucket.shop_domain), bucket.trial_start);
        }

        // Settled money, per charge where we can and per shop where we cannot. The per-shop fallback
        // is COARSER and says so: a store with two subscriptions where only one ever settled reads as
        // settled on both. It applies only to buckets that carry no charge id at all, which is the
        // one case where nothing finer exists.
        let settledObserved = false;
        let settledScope: CohortSubscription['settled_payout_scope'] = 'none';
        if (bucket.charge_id !== '' && settledCharges.has(bucket.charge_id)) {
            settledObserved = true;
            settledScope = 'charge';
        } else if (bucket.charge_id === '' && bucket.shop_domain !== '' && settledDomains.has(bucket.shop_domain)) {
            settledObserved = true;
            settledScope = 'domain';
        }

        const classified = classifyAsOf({
            conversion_date: bucket.conversion_date,
            // The INSTANT only. `classifyAsOf` decides states from dates, and handing it the event
            // TYPE as well would invite a branch on it — which is how "measure the cancel trap"
            // quietly becomes "act on the cancel trap". The type is recorded on the ROW instead.
            churn_date: endEvent ? endEvent.at : null,
            // Only the SIGN of this is read (`> 0`). We know presence, not a count, so a count is
            // never published on the row — `settled_payout_observed` is the honest shape there.
            settled_payout_count: settledObserved ? 1 : 0,
            as_of: asOf
        });

        const trial = resolveTrialEnd(bucket.conversion_date);
        const chargeLink = resolveChargeLinkState(bucket.charge_id, bucket.conversion_date);

        // ⚠️ GATED ON THE CLAMPED DATE, not on `endEvent`. `classifyAsOf` discards an end later than
        // the judgement instant, and a row publishing "ended by UNINSTALL" beside `churn_date: null`
        // would assert a departure the window has explicitly decided has not happened yet.
        const endEventType = classified.churn_date && endEvent ? endEvent.type : null;

        /**
         * Days from the event that ANNOUNCED `billingOn` to `billingOn` itself.
         *
         * NOT A TRIAL LENGTH, and it must never be published as one. Exact fractional days, not
         * rounded: rounding 29.6 to 30 manufactures a "30-day trial" reading out of a number that is
         * equally consistent with a no-trial subscription billing one cycle out. Nothing classifies
         * on it — it is counted into `diagnostics.billing_on_gap` and left alone.
         */
        const gapDays = bucket.conversion_date && bucket.conversion_source_at
            ? (bucket.conversion_date.getTime() - bucket.conversion_source_at.getTime()) / _DAY_MS
            : null;

        if (gapDays !== null) {
            diagnostics.billing_on_gap.measured += 1;
            if (gapDays < 0) {
                // A billing date BEFORE the event that announced it cannot be a trial end under any
                // reading. Counted on its own line rather than folded into `above_band`, because the
                // two are different defects: one is a gap too long to be a trial, the other is a
                // date that runs backwards. The two counters are DISJOINT and sum to "outside band".
                diagnostics.billing_on_gap.negative += 1;
            } else if (gapDays > BILLING_ON_GAP_MAX_PLAUSIBLE_TRIAL_DAYS) {
                diagnostics.billing_on_gap.above_band += 1;
            }
        }

        subscriptions.push({
            bucket_key: bucket.bucket_key,
            charge_id: bucket.charge_id,
            shop_domain: bucket.shop_domain,
            trial_start: bucket.trial_start,
            conversion_date: bucket.conversion_date,
            trial_end: trial.trial_end,
            trial_days_source: trial.trial_days_source,
            churn_date: classified.churn_date,
            end_event_type: endEventType,
            // Filled by the supersession pass below, which cannot run until every bucket exists.
            superseded_by_charge_id: null,
            conversion_source_event_type: bucket.conversion_source_event_type,
            billing_on_gap_days: gapDays,
            state: classified.state,
            state_basis: classified.state_basis,
            lifecycle_state: toLifecycleState(classified.state),
            charge_link: chargeLink,
            plan_name: bucket.plan_name,
            plan_price: bucket.plan_price,
            currency: bucket.currency,
            settled_payout_observed: settledObserved,
            settled_payout_scope: settledScope
        });

        diagnostics.charge_link[chargeLink] += 1;
        diagnostics.state_basis[classified.state_basis] += 1;
        diagnostics.trial_days_source[trial.trial_days_source === 'partner_billing_on' ? 'partner_billing_on' : 'none'] += 1;
    }

    diagnostics.subscriptions = subscriptions.length;

    // ── 3b. THE CANCEL TRAP — MEASURED, NEVER ACTED ON ───────────────────
    //
    // Shopify emits a plan change as a cancellation of the old charge and an acceptance of the new
    // one IN THE SAME SECOND. This fold keys per charge, so that one merchant action produces two
    // buckets: two `trial_started`, an end event that is not a departure, and — when the change
    // happens inside the trial — a `CHURNED_DURING_TRIAL` booked against the merchant who upgraded.
    //
    // NOTHING BELOW CHANGES A STATE, A DATE OR A COUNT. It records `superseded_by_charge_id` on
    // the predecessor and tallies the exposure, and that is the whole of it. Suppressing the cancel
    // instead would delete every genuine cancellation that happens to be followed by a new charge —
    // a merchant who cancels and re-subscribes a minute later is indistinguishable from an upgrader
    // in this data, and the honest response to an indistinguishable pair is to count it, not to pick.
    //
    // ⚠️ BOTH SIDES MUST BE CHARGE-KEYED. A shop-keyed bucket names no charge, so pairing two of
    // them for one store cannot be told from a store that genuinely subscribed twice; those are left
    // undetected rather than guessed at, which is what makes every count here a FLOOR.
    const startsByShop = new Map<string, Array<{ charge_id: string; at: number }>>();
    for (const subscription of subscriptions) {
        if (subscription.shop_domain === '' || subscription.charge_id === '') {
            continue;
        }
        const entry = { charge_id: subscription.charge_id, at: subscription.trial_start.getTime() };
        const list = startsByShop.get(subscription.shop_domain);
        if (list) {
            list.push(entry);
        } else {
            startsByShop.set(subscription.shop_domain, [entry]);
        }
    }

    const supersededShops = new Set<string>();
    /**
     * The DISTINCT successors, which is the honest inflation figure and not the same number as
     * `detected`: two predecessors ending together can name one successor, and counting predecessors
     * would then claim two extra trial starts where the fold produced one.
     */
    const supersedingCharges = new Set<string>();

    for (const subscription of subscriptions) {
        // The CLAMPED churn date, so a supersession is never inferred across the judgement instant.
        if (!subscription.churn_date || subscription.charge_id === '' || subscription.shop_domain === '') {
            continue;
        }
        const candidates = startsByShop.get(subscription.shop_domain);
        if (!candidates) {
            continue;
        }
        const endMs = subscription.churn_date.getTime();
        const startMs = subscription.trial_start.getTime();

        let best: { charge_id: string; at: number } | null = null;
        let bestDelta = Number.POSITIVE_INFINITY;
        for (const candidate of candidates) {
            if (candidate.charge_id === subscription.charge_id) {
                continue;
            }
            // A charge that opened BEFORE this one did is a predecessor, not a successor. Without
            // this both halves of one plan change point at each other and the pair is counted twice.
            if (candidate.at < startMs) {
                continue;
            }
            // Symmetric: Shopify does not guarantee which half of a plan change it writes first, and
            // at `occurredAt`'s one-second resolution the accept can land marginally before the
            // cancel. A forward-only window would miss exactly those.
            const delta = Math.abs(candidate.at - endMs);
            if (delta > SUPERSESSION_WINDOW_MS) {
                continue;
            }
            // Nearest in time wins; the smaller charge id breaks a tie, so the answer is
            // deterministic for a given input rather than dependent on iteration order.
            if (delta < bestDelta || (delta === bestDelta && best !== null && candidate.charge_id < best.charge_id)) {
                best = candidate;
                bestDelta = delta;
            }
        }
        if (!best) {
            continue;
        }

        subscription.superseded_by_charge_id = best.charge_id;
        diagnostics.supersession.detected += 1;
        if (bestDelta < SAME_SECOND_MS) {
            diagnostics.supersession.same_second += 1;
        }
        if (subscription.state === SUBSCRIPTION_STATES.CHURNED_DURING_TRIAL) {
            diagnostics.supersession.churned_during_trial += 1;
        } else if (subscription.state === SUBSCRIPTION_STATES.CHURNED_AFTER_TRIAL) {
            diagnostics.supersession.churned_after_trial += 1;
        }
        supersededShops.add(subscription.shop_domain);
        supersedingCharges.add(best.charge_id);
    }

    diagnostics.supersession.shops = supersededShops.size;
    diagnostics.supersession.distinct_successors = supersedingCharges.size;

    // ── 4. Fold to one winner per store ─────────────────────────────────────
    // LATEST `trial_start` WINS. A store that trialled, left, and came back is described by its most
    // recent attempt; the earlier one is counted in `subscriptions_superseded` rather than dropped
    // without trace. Ties keep the incumbent, and `buckets` is in first-start order, so the fold is
    // deterministic for a given input.
    const byDomain = new Map<string, CohortSubscription>();
    for (const subscription of subscriptions) {
        if (subscription.shop_domain === '') {
            // Cannot join the install spine, so it can never become a row. Already counted in
            // `shopless_events` at the event level.
            continue;
        }
        const incumbent = byDomain.get(subscription.shop_domain);
        if (!incumbent) {
            byDomain.set(subscription.shop_domain, subscription);
            continue;
        }
        diagnostics.subscriptions_superseded += 1;
        if (subscription.trial_start.getTime() > incumbent.trial_start.getTime()) {
            byDomain.set(subscription.shop_domain, subscription);
        }
    }

    diagnostics.domains = byDomain.size;

    return { subscriptions, by_domain: byDomain, diagnostics };
};

/**
 * The exposure counters, in the sentences an operator reads.
 *
 * ONE WORDING, IN ONE PLACE. `diagnostics.subscriptions_superseded` has been computed since this
 * resolver shipped and is read by NOTHING — a counter with no reader is a measurement nobody has
 * ever seen, which is indistinguishable from not having measured. These sentences exist so that the
 * new counters cannot end up in the same position, and they live HERE rather than in each service so
 * that two screens cannot describe one fact two ways. `test/cancelTrap.test.js` pins the wording
 * against the counters, because warning text that nothing asserts drifts out of agreement with the
 * number it is describing and then reads as a different, smaller problem.
 *
 * ⚠️ EVERY SENTENCE STATES A DIRECTION. "N superseded" is not actionable; "trial starts are
 * over-counted by up to N, so trial abandonment reads HIGH" is. A count with no direction is the
 * shape of warning an operator learns to scroll past.
 *
 * PURE, and returns `[]` when there is nothing to say. A caller pushes the result into its own
 * `warnings[]`; it must NOT re-word, re-order or truncate them.
 *
 * @param diagnostics - The counters this resolver produced.
 * @returns Zero, one or two sentences. Never a sentence about a zero.
 */
const describeChargeCohortExposure = (diagnostics: ChargeCohortDiagnostics): string[] => {
    const out: string[] = [];
    if (!diagnostics) {
        return out;
    }

    const superseded = diagnostics.supersession;
    if (superseded && superseded.detected > 0) {
        const seconds = Math.round(superseded.window_ms / 1000);
        out.push(
            `Shopify emits a plan change as a cancellation plus a replacement charge in the same second, and `
            + `${superseded.detected} subscription(s) across ${superseded.shops} store(s) end within ${seconds}s of `
            + `another charge starting for the same store (${superseded.same_second} in the same second). Trial starts `
            + `and conversions here are therefore OVER-counted by up to ${superseded.distinct_successors}, and `
            + `${superseded.churned_during_trial} of these ends are counted as leaving during a trial by a merchant who `
            + `changed plan rather than leaving — so trial abandonment reads HIGH and trial-to-paid reads LOW. No figure `
            + `has been adjusted for this, and the detection is a floor: it can only pair two charges that both carry an id.`
        );
    }

    const gap = diagnostics.billing_on_gap;
    if (gap && (gap.negative > 0 || gap.above_band > 0)) {
        const clauses: string[] = [];
        if (gap.negative > 0) {
            clauses.push(`${gap.negative} put it BEFORE the event that announced it, which cannot be a trial end at all`);
        }
        if (gap.above_band > 0) {
            clauses.push(
                `${gap.above_band} put it more than ${gap.band_max_days} days after, which is a billing anchor rather than a trial`
            );
        }
        out.push(
            `Trial length here is Shopify's own charge.billingOn, and of ${gap.measured} dated subscription(s) `
            + `${clauses.join(', and ')}. No stored field separates a free trial from a first billing one cycle out — the `
            + `Partner API's AppSubscription carries no trialDays — so wherever the two are mixed, trial lengths and the `
            + `trial end dates derived from them read LONG.`
        );
    }

    return out;
};

export = {
    resolveChargeCohortForDomains,
    describeChargeCohortExposure,
    //  EXPORTED SO A TEST PINS THE SHIPPED VALUE rather than retyping it. A test that hard-codes
    // `60000` still passes after someone widens the window, which is the one change these two
    // constants exist to make visible.
    SUPERSESSION_WINDOW_MS,
    BILLING_ON_GAP_MAX_PLAUSIBLE_TRIAL_DAYS
};
