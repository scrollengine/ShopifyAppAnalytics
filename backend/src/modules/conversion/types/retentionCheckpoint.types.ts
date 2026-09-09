/**
 * Shapes for `resolvers/retentionCheckpoint.resolver` — the fold, not the wire.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 */

import type { RelationshipEventRow } from './cohortRetentionData.types';

/** One store in a cohort: its domain, and the instant every checkpoint is measured FROM. */
export interface RetentionCohortStore {
    shop_domain: string;
    /**
     * The store's OWN install instant — `$min(occurred_at)` over the reported span.
     *
     *  Checkpoints are measured from HERE, not from the cohort week's start. Anchoring them to the
     * week would credit a store that installed on the week's last day with six days it never lived
     * through, which biases retention UPWARD on exactly the newest cohorts a reader trusts least.
     */
    installed_at: Date;
}

/** What one cohort's checkpoint fold is handed. */
export interface RetentionCheckpointInput {
    stores: readonly RetentionCohortStore[];
    /** Relationship events grouped by domain ONCE by the caller, for every cohort in the request. */
    events_by_domain: Map<string, RelationshipEventRow[]>;
    /** The checkpoints, in days after each store's own install. */
    checkpoint_days: readonly number[];
    /** The judgement instant. A checkpoint after it has not arrived and makes a store INELIGIBLE. */
    as_of: Date;
}

/** One cohort measured at one checkpoint. Raw counts — the rate is the service's `rate()` call. */
export interface RetentionCheckpointCounts {
    /** Stores whose `installed_at + days` is at or before the judgement instant. */
    eligible: number;
    /** Of those, still installed at their own checkpoint instant. */
    retained: number;
}

/** What the fold answers for one cohort. */
export interface RetentionCheckpointResult {
    /** Checkpoint days → counts. Present for EVERY requested checkpoint, `eligible: 0` included. */
    by_checkpoint: Map<number, RetentionCheckpointCounts>;
    /**
     * Eligible stores the install-state fold produced no state for.
     *
     * ⚠️ Zero by construction — every cohort store has an install event at or before its own
     * checkpoint — so a non-zero value means the spine and the relationship pull disagree about a
     * store. That is a coverage fault worth SEEING rather than a retention figure worth publishing,
     * which is why it is counted here and excluded from `retained` rather than assumed either way.
     */
    stores_without_state: number;
}
