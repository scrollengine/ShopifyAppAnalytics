'use strict';

/**
 * ============================================================================
 *  RELATIONSHIP EVENTS  →  IS THE APP ON THIS STORE RIGHT NOW?
 * ============================================================================
 *
 *  Takes ALREADY-FETCHED relationship event rows and folds them into one answer per store. It
 *  reaches no repository and reads no clock: every input is data, which is what lets the whole fold
 *  be exercised against a handful of captured rows with no database. The `$in` list the fetch needs
 *  is `STORE_RELATIONSHIP_EVENT_TYPES` in the constants, not here — a repository importing a
 *  resolver would invert the layer direction.
 *
 *  ──  THIS IS A FOLD, AND IT MUST STAY ONE ────────────────────────────────────────────────
 *
 *  There is no `install_state` column anywhere in this build, and the reason is on record. The
 *  system this was extracted from declared an `uninstalled_at`, READ it in three services to build
 *  INSTALLED/UNINSTALLED facets — and WROTE it from nowhere. Those facets were silently wrong for
 *  the life of the product, because a column you forget to write looks exactly like a column whose
 *  value is legitimately null. A value derived from `RELATIONSHIP_UNINSTALLED.occurred_at` cannot
 *  fail that way: there is no column to forget.
 *
 *  ── THE STATE IS THE LATEST RELATIONSHIP EVENT, NOT A COUNT COMPARISON ────────────────────
 *
 *  Not "more installs than uninstalls", which gets a reinstalled store right by accident and a
 *  store with a lost uninstall event wrong for ever. The most recent of the four events wins, and
 *  which one it was rides along on `install_state_event` so the collapse below loses nothing.
 *
 *  ──  DEACTIVATED ENDS AN INSTALLATION, AND ON A TIE IT WINS ──────────────────────────────
 *
 *  `RelationshipDeactivated` is a shop frozen or closed rather than uninstalled.
 *  `partnerVocab.constants` states the rule: a fold that considers only INSTALL/UNINSTALL "leaves
 *  every reactivated shop permanently uninstalled and every frozen shop permanently installed —
 *  both wrong, both silent". So it ends the installation, and the row's LABEL says "Deactivated"
 *  while its STATE says `UNINSTALLED` — see the constants header for why the state vocabulary has
 *  exactly three members.
 *
 *  On an exact timestamp tie the CLOSING event wins. Shopify's `occurredAt` has no sub-second
 *  component, so two events can genuinely share an instant, and the tie has to break somewhere. It
 *  breaks toward "not installed" because the page's entire purpose is "who has my app RIGHT NOW",
 *  and over-claiming INSTALLED is the failure mode this whole design exists to refuse. The error is
 *  therefore bounded, directional and stated, rather than whichever way the array happened to be
 *  ordered.
 * ============================================================================
 */

import storeConstants = require('../constants/storeRoster.constants');
import partnerVocab = require('../../../constants/partnerVocab.constants');

import type {
    StoreInstallFold,
    StoreInstallStateResult,
    StoreInstallStateInput
} from '../types/installState.types';
import type { StoreRelationshipEventRow } from '../types/storeRosterData.types';

const {
    STORE_INSTALL_STATES,
    STORE_INSTALL_STATE_LABELS,
    STORE_INSTALL_STATE_EVENT_LABELS,
    STORE_INSTALL_EVENT_TYPES,
    STORE_UNINSTALL_EVENT_TYPES
} = storeConstants;
const { PARTNER_EVENT_TYPES } = partnerVocab;

/** A fresh fold for one store. One literal, so no branch can invent a partial one. */
const _emptyFold = (shopDomain: string): StoreInstallFold => ({
    shop_domain: shopDomain,
    shop_id: '',
    partner_shop_name: '',
    partner_name_at: null,
    install_state: STORE_INSTALL_STATES.UNKNOWN,
    install_state_label: STORE_INSTALL_STATE_LABELS.UNKNOWN,
    install_state_at: null,
    install_state_event: '',
    installed_at: null,
    latest_install_at: null,
    uninstalled_at: null,
    deactivated_at: null,
    install_count: 0,
    has_install_record: false
});

/**
 * A `Date` from a stored value, or `null`.
 *
 * `occurred_at` is `required: true` on the schema, so an unreadable value is unreachable from a
 * stored document — but it is checked rather than trusted, because the alternative to checking is
 * `new Date(undefined)`, which is an `Invalid Date` that compares false against everything and would
 * silently drop the row out of every extreme without changing a count.
 *
 * @param value - Anything off a lean document.
 * @returns The instant, or null when it could not be read.
 */
const _date = (value: unknown): Date | null => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value;
    }
    return null;
};

/** Trimmed string from anything, treating null/undefined as absent. */
const _text = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value).trim();
};

/**
 * Folds relationship events into one install state per store.
 *
 * ⚠️ `as_of` IS A PARAMETER, not a clock read, and it is applied as a CLAMP: an event that has not
 * happened yet from this request's point of view cannot decide the state. On this endpoint `as_of`
 * is always "now", so the clamp normally excludes nothing — what it actually catches is a
 * future-dated `occurred_at`, i.e. clock skew between Shopify and this host or a corrupted row.
 * Those are COUNTED (`future_events`) so the service can say so, rather than silently deciding a
 * store's state from an instant that has not arrived.
 *
 * @param input - The event rows and the judgement instant.
 * @returns One fold per store, plus everything the fold could not use.
 */
const resolveInstallStates = (input: StoreInstallStateInput): StoreInstallStateResult => {
    const asOf = input && input.as_of instanceof Date && !Number.isNaN(input.as_of.getTime()) ? input.as_of : null;
    if (!asOf) {
        // Validated ONCE, here, so no comparison below can be made against an Invalid Date — which
        // would evaluate false in every direction and quietly fold every store to UNKNOWN. There is
        // no honest default for the judgement instant; the service resolves it and passes it in.
        throw new TypeError('resolveInstallStates requires a valid `as_of` Date.');
    }

    const rows: readonly StoreRelationshipEventRow[] = Array.isArray(input.events) ? input.events : [];
    const installTypes = new Set(STORE_INSTALL_EVENT_TYPES);
    const uninstallTypes = new Set(STORE_UNINSTALL_EVENT_TYPES);

    const byDomain = new Map<string, StoreInstallFold>();
    /** The deciding event per store, kept beside the fold so the tie-break rule stays in one place. */
    const decidedAt = new Map<string, { at: number; closing: boolean }>();
    /** When the currently-held `partner_shop_name` / `shop_id` was observed, so the latest wins. */
    const namedAt = new Map<string, number>();
    const idAt = new Map<string, number>();

    const diagnostics = {
        events_read: rows.length,
        events_considered: 0,
        shopless_events: 0,
        undated_events: 0,
        future_events: 0,
        unrecognised_events: 0
    };

    for (const row of rows) {
        const shopDomain = _text(row && row.shop_domain);
        if (shopDomain === '') {
            // The repository already filters these and counts them; this is the same refusal made
            // where the fold can see it, because a synthetic key is not a smaller number — it is a
            // wrong one, and it looks exactly like a real store.
            diagnostics.shopless_events += 1;
            continue;
        }
        const at = _date(row.occurred_at);
        if (!at) {
            diagnostics.undated_events += 1;
            continue;
        }
        if (at.getTime() > asOf.getTime()) {
            diagnostics.future_events += 1;
            continue;
        }

        const eventType = _text(row.event_type);
        const isInstall = installTypes.has(eventType);
        const isUninstall = uninstallTypes.has(eventType);
        if (!isInstall && !isUninstall) {
            // Unreachable through the repository's `$in`, counted anyway: a fold that answers for
            // fewer events than it was given must say so rather than quietly return a smaller
            // number.
            diagnostics.unrecognised_events += 1;
            continue;
        }
        diagnostics.events_considered += 1;

        let fold = byDomain.get(shopDomain);
        if (!fold) {
            fold = _emptyFold(shopDomain);
            byDomain.set(shopDomain, fold);
        }

        const ms = at.getTime();

        // ── Identity: the LATEST non-empty value wins ───────────────────────
        // A merchant who renames their store should read as the new name, not whichever row the
        // scan reached first. An empty value never displaces a real one — `''` here means the row
        // predates the column, not that the store lost its name.
        const shopName = _text(row.shop_name);
        if (shopName !== '' && ms >= (namedAt.get(shopDomain) ?? Number.NEGATIVE_INFINITY)) {
            fold.partner_shop_name = shopName;
            //  The instant the NAME was observed, which is not the instant the STATE was decided:
            // a closing event routinely carries no name, so the two diverge on exactly the stores
            // that have churned. `storeField.resolver` compares this against an operator push's own
            // observation to decide which name is fresher, and handing it the later state instant
            // would win that contest by a margin it did not measure.
            fold.partner_name_at = at;
            namedAt.set(shopDomain, ms);
        }
        const shopId = _text(row.shop_id);
        if (shopId !== '' && ms >= (idAt.get(shopDomain) ?? Number.NEGATIVE_INFINITY)) {
            fold.shop_id = shopId;
            idAt.set(shopDomain, ms);
        }

        // ── Dates ──────────────────────────────────────────────────────────
        if (isInstall) {
            fold.install_count += 1;
            fold.has_install_record = true;
            if (!fold.installed_at || ms < fold.installed_at.getTime()) {
                fold.installed_at = at;
            }
            if (!fold.latest_install_at || ms > fold.latest_install_at.getTime()) {
                fold.latest_install_at = at;
            }
        } else if (eventType === PARTNER_EVENT_TYPES.UNINSTALL) {
            // ⚠️ The two closing events are kept as two DATES, not merged into one `ended_at`. A
            // merchant who removed the app and a shop Shopify froze are two different churn stories,
            // and the detail path has to be able to tell them apart on a row whose state says only
            // that the app is not live.
            if (!fold.uninstalled_at || ms > fold.uninstalled_at.getTime()) {
                fold.uninstalled_at = at;
            }
        } else if (!fold.deactivated_at || ms > fold.deactivated_at.getTime()) {
            fold.deactivated_at = at;
        }

        // ── The deciding event ─────────────────────────────────────────────
        // `>=` on the tie plus `closing` as the tie-break: on an exact timestamp match the closing
        // event wins whichever order the rows arrived in, so the answer is deterministic for a given
        // input rather than dependent on the scan.
        const previous = decidedAt.get(shopDomain);
        const isLater = !previous || ms > previous.at;
        const isTieWonByClosing = !!previous && ms === previous.at && isUninstall && !previous.closing;
        if (isLater || isTieWonByClosing) {
            decidedAt.set(shopDomain, { at: ms, closing: isUninstall });
            fold.install_state = isInstall ? STORE_INSTALL_STATES.INSTALLED : STORE_INSTALL_STATES.UNINSTALLED;
            fold.install_state_at = at;
            fold.install_state_event = eventType;
            // The per-event label override is the whole reason a deactivated store can carry an
            // `UNINSTALLED` state without the row claiming the merchant uninstalled.
            fold.install_state_label = STORE_INSTALL_STATE_EVENT_LABELS[eventType]
                || STORE_INSTALL_STATE_LABELS[fold.install_state];
        }
    }

    return { by_domain: byDomain, diagnostics };
};

export = {
    resolveInstallStates
};
