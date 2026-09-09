'use strict';

/**
 * ============================================================================
 *  COHORT RETENTION — weekly install cohorts against fixed day checkpoints
 * ============================================================================
 *
 *  The vocabulary behind `GET /api/conversion/cohort-retention`. Dependency-free by design: it holds
 *  numbers and labels only, so a repository, a resolver and a service can all read it without
 *  dragging a layer sideways.
 *
 *  ──  A CHECKPOINT A COHORT HAS NOT REACHED HAS NO ANSWER ──────────────────────────────────
 *
 *  This is the whole endpoint. A cohort that installed last week has not lived long enough to have a
 *  +90d retention figure, and the honest publication for that cell is `null` — not `0`.
 *  `CohortRetentionHeatmap.js:12-17` grades a cell green→yellow→RED by its rate, so a `0` there
 *  paints the cell solid red at full opacity and captions it "0%": a specific, checkable, false claim
 *  that every merchant who installed last week had churned by month three. The component already
 *  knows how to draw the honest answer — `:82` reads `row.checkpoints['day_' + d]` and `:83` takes
 *  `pct` only when that object EXISTS, and `:87` titles a missing one "Cohort not aged enough" — so
 *  the null must be published as an ABSENT CHECKPOINT OBJECT rather than as an object with a null
 *  inside it, or the tooltip reads "—/— retained" instead of saying why.
 *
 *  ── THE CHECKPOINTS ARE A FRONTEND CONTRACT ─────────────────────────────────────────────────
 *
 *  `CohortRetentionHeatmap.js:35` falls back to `[1, 7, 30, 60, 90]` when the payload names none, and
 *  builds both its header row and its cell lookups from whatever `checkpoints_days` it is given
 *  (`:36`, `:65`, `:81`). Publishing a different list is therefore SAFE — the grid follows it — but
 *  publishing one whose members do not match the `day_N` keys underneath is not: every cell would
 *  miss and the whole heatmap would read "not aged enough". The service builds both from THIS array.
 *
 *  ── WEEKS, NOT MONTHS, AND WHY THE PAGE ASKS FOR TWELVE ─────────────────────────────────────
 *
 *  `frontend/pages/funnel/index.js:199` calls with `{ weeks: 12 }`. Twelve weeks against
 *  a +90d checkpoint means the OLDEST cohort has only just reached the LAST column — which is the
 *  intended shape of a retention triangle, not a defect.
 * ============================================================================
 */

/**
 * The retention checkpoints, in days after each store's own install.
 *
 * ⚠️ MEASURED PER STORE, NOT PER COHORT WEEK. A store that installed on the last day of a cohort
 * week has had one day less than one that installed on the first, and anchoring the checkpoint to
 * the WEEK would credit the late installer with six days it never lived through — which biases the
 * figure UPWARD, in the flattering direction, on precisely the newest cohorts a reader looks at
 * hardest. The cost is that a cohort can be PARTIALLY eligible at a checkpoint; the payload publishes
 * `eligible` beside `retained` so the denominator is visible, and warns when it is short.
 */
const RETENTION_CHECKPOINT_DAYS: readonly number[] = Object.freeze([1, 7, 30, 60, 90]);

/** The `checkpoints` object key for a checkpoint. ONE formatter, so the grid and the row agree. */
const retentionCheckpointKey = (days: number): string => `day_${days}`;

/** Weekly cohorts returned when the caller names none. Matches the page's own `weeks: 12`. */
const DEFAULT_RETENTION_WEEKS = 12;

/**
 * The ceiling. A year of weekly cohorts is 52 rows in a grid the page renders whole — there is no
 * pagination anywhere in `CohortRetentionHeatmap`, so a larger number is a taller page, never a
 * truncated one. Out of range is CLAMPED and reported, never refused.
 */
const MAX_RETENTION_WEEKS = 52;

/**
 * Which day a cohort week opens on, as `Date.prototype.getUTCDay()` — 1 is MONDAY.
 *
 * ⚠️ UTC, matching `helpers/monthBucket.helper` and `shared/helpers/dateRange.helper`. A week built
 * in the process's local zone would shift every cohort boundary by the host's offset, so the same
 * install would fall into different cohorts on two deployments of the same code.
 *
 * Monday rather than Sunday because the label the page prints is a DATE
 * (`CohortRetentionHeatmap.js:23-27`), and an operator reading "Mar 2, 2026" for a week that began on
 * the Sunday has to do the conversion in their head every time.
 */
const COHORT_WEEK_START_DAY = 1;

/**
 * The `data_state` values this endpoint publishes. Same two as every other cohort read, and the
 * discriminator is the WATERMARK — never the row count. An app that has synced and has no installs
 * in the last twelve weeks is a real, publishable answer.
 */
const RETENTION_DATA_STATES = Object.freeze({
    READY: 'READY',
    NEVER_SYNCED: 'NEVER_SYNCED'
} as const);

export = {
    RETENTION_CHECKPOINT_DAYS,
    retentionCheckpointKey,
    DEFAULT_RETENTION_WEEKS,
    MAX_RETENTION_WEEKS,
    COHORT_WEEK_START_DAY,
    RETENTION_DATA_STATES
};
