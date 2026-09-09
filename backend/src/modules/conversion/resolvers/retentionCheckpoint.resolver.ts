'use strict';

/**
 * ============================================================================
 *  ONE COHORT × ONE CHECKPOINT  →  "HOW MANY STILL HAVE THE APP?"
 * ============================================================================
 *
 *  Takes ALREADY-FETCHED relationship events and folds them. It reaches no repository and reads no
 *  clock: `as_of` is a parameter, so a cohort answers identically on a re-run and inside a test.
 *
 *  ──  IT DOES NOT DECIDE INSTALL STATE, AND IT MUST NEVER LEARN HOW ───────────────────────
 *
 *  There is exactly ONE definition of "is the app on this store at instant D" in this codebase —
 *  `modules/store/resolvers/installState.resolver` — and this file calls it. The rule it encodes is
 *  not obvious and is easy to get subtly wrong in a second copy:
 *
 *    - the state is the LATEST relationship event at or before D, never "more installs than
 *      uninstalls" (which gets a reinstalled store right by accident and a store with a lost
 *      uninstall wrong for ever);
 *    - `DEACTIVATED` — a shop Shopify froze or closed — ENDS an installation, so a fold that
 *      considered only INSTALL/UNINSTALL would leave every frozen shop permanently installed;
 *    - on an exact timestamp tie the CLOSING event wins, because Shopify's `occurredAt` has no
 *      sub-second component and the tie has to break toward "not installed" rather than toward
 *      whichever order the array happened to be in.
 *
 *  A retention grid built on a second, slightly different reading of those three would disagree with
 *  the Stores page about the same merchant, on the same day — and retention would read HIGH, which is
 *  the flattering direction and therefore the one nobody questions.
 *
 *  ── ⚠️ WHY IT CALLS THAT FOLD ONCE PER (STORE, CHECKPOINT) ────────────────────────────────
 *
 *  Because every store's checkpoint instant is DIFFERENT — `installed_at + N days`, per store — so
 *  the calls cannot be batched by instant. They are batched by DATA instead: each call is handed only
 *  that ONE store's events, so the total work is `checkpoints × total events` rather than
 *  `stores × checkpoints × total events`. For a twelve-week grid that is five passes over the event
 *  list, which is cheaper than the single unbatched pass the naive version would do.
 *
 *  The alternative — flattening each store's events into a sorted transition list here and
 *  binary-searching it — would be faster still and would be a SECOND DEFINITION of install state.
 *  It is not worth it; measure before reaching for it, and if you do, put the timeline in
 *  `modules/store` beside the fold it has to agree with.
 * ============================================================================
 */

import storeRosterConstants = require('../../store/constants/storeRoster.constants');
//  DEEP PATH TO A PURE RESOLVER, never `require('../../store')`. That barrel loads every store
// service, each of which imports THIS module's barrel, so the import would close a cycle and
// destructure half of this module as `undefined` at load — see
// `modules/revenue/repositories/revenue.repository.ts:20-45` for that exact failure and the fifteen
// tests it broke. `installState.resolver` imports only constants, so it has no edge back here.
import installStateResolver = require('../../store/resolvers/installState.resolver');

import type {
    RetentionCheckpointCounts,
    RetentionCheckpointInput,
    RetentionCheckpointResult
} from '../types/retentionCheckpoint.types';

const { STORE_INSTALL_STATES } = storeRosterConstants;
const { resolveInstallStates } = installStateResolver;

/** Milliseconds in a day. One literal, so the checkpoint offset is not spelled a second way. */
const _DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Measures one cohort against every checkpoint.
 *
 * ⚠️ ELIGIBILITY IS PER STORE, AND IT IS THE DENOMINATOR. A store whose `installed_at + N days` has
 * not arrived yet is not "churned" and not "retained" — it has no answer for that checkpoint, and
 * counting it either way would be a claim about a merchant nobody has observed for long enough. The
 * caller publishes `null` for a checkpoint no store reached and marks a checkpoint SOME stores
 * reached as `partial`.
 *
 * @param input - The cohort, its events, the checkpoints and the instant.
 * @returns Counts per checkpoint, plus the stores the fold could not place.
 */
const resolveRetentionCheckpoints = (input: RetentionCheckpointInput): RetentionCheckpointResult => {
    const asOf = input && input.as_of instanceof Date && !Number.isNaN(input.as_of.getTime()) ? input.as_of : null;
    if (!asOf) {
        // Validated ONCE, here, so `resolveInstallStates` — which THROWS on an unusable instant —
        // can never fire mid-fold and leave a half-measured grid. There is no honest default for a
        // judgement instant; the service resolves it and passes it in.
        throw new TypeError('resolveRetentionCheckpoints requires a valid `as_of` Date.');
    }

    const days: readonly number[] = Array.isArray(input.checkpoint_days) ? input.checkpoint_days : [];
    const stores = Array.isArray(input.stores) ? input.stores : [];
    const eventsByDomain = input.events_by_domain instanceof Map ? input.events_by_domain : new Map();

    const byCheckpoint = new Map<number, RetentionCheckpointCounts>();
    for (const day of days) {
        // Pre-filled so every requested checkpoint comes back, `eligible: 0` included. A checkpoint
        // absent from this map would be indistinguishable, one layer up, from a checkpoint nobody
        // asked for.
        byCheckpoint.set(day, { eligible: 0, retained: 0 });
    }

    let storesWithoutState = 0;
    const asOfMs = asOf.getTime();

    for (const store of stores) {
        const installedAt = store.installed_at instanceof Date && !Number.isNaN(store.installed_at.getTime())
            ? store.installed_at
            : null;
        if (!installedAt || store.shop_domain === '') {
            // A store with no usable install instant has no checkpoint to be measured at. It is
            // already counted in the spine's own totals; inventing an instant for it would put a
            // fabricated row in every column.
            continue;
        }
        const events = eventsByDomain.get(store.shop_domain) || [];

        for (const day of days) {
            const counts = byCheckpoint.get(day);
            if (!counts) {
                continue;
            }
            const at = new Date(installedAt.getTime() + day * _DAY_MS);
            if (at.getTime() > asOfMs) {
                //  NOT ELIGIBLE, which is different from "not retained". See the docstring.
                continue;
            }
            const fold = resolveInstallStates({ events, as_of: at }).by_domain.get(store.shop_domain);
            if (!fold) {
                // The spine says this store installed and the relationship pull has no event for it
                // at that instant — unreachable by construction, since the pull is a SUPERSET of the
                // spine's event types over the same span and every checkpoint is at least a day after
                // the install it is measured from.
                //
                // ⚠️ COUNTED AND EXCLUDED FROM BOTH SIDES, never counted as eligible-and-lost. A store
                // we have no answer for is not a store that churned; leaving it in the denominator
                // would publish a specific merchant's absence as a specific merchant's departure,
                // which is the same fabrication as a `0` in an unreached cell, one row down.
                storesWithoutState += 1;
                continue;
            }
            counts.eligible += 1;
            if (fold.install_state === STORE_INSTALL_STATES.INSTALLED) {
                counts.retained += 1;
            }
        }
    }

    return { by_checkpoint: byCheckpoint, stores_without_state: storesWithoutState };
};

export = {
    resolveRetentionCheckpoints
};
