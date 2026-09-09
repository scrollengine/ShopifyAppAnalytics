'use strict';

/**
 * ============================================================================
 *  JOB-HISTORY LIST — the vocabulary the table filters, sorts and pages by
 * ============================================================================
 *
 *  Everything `GET /api/sync/jobs` will accept, in one place. Nothing here is
 *  re-spelled from `sync.constants`: the three filterable groups all take their
 *  values from the vocabulary the SCHEMA enforces, so a filter can never name a
 *  value the collection cannot hold, and a rename in one place is a compile
 *  error rather than a filter that quietly matches nothing.
 *
 *  ──  WHY `createdAt` IS THE ONLY SORT KEY ─────────────────────────────────
 *
 *  It is not a shortcut, it is the nulls-last rule applied honestly.
 *
 *  Every other candidate — `completed_at`, `started_at`, `duration_ms` — is
 *  `null` on every row that has not finished, and MongoDB sorts a null FIRST in
 *  an ascending sort. So "oldest completion first" would open with every PENDING
 *  job in the queue, presenting an ABSENCE as an extreme value: the reader sees
 *  the jobs that have never completed at the top of a column headed "completed".
 *  Fixing that per-field means a computed sort key and a blocking in-memory
 *  sort, for an ordering nothing on the dashboard asks for.
 *
 *  `createdAt` is written by mongoose on every insert, so it is present on every
 *  row, has no null branch at all, and is the leading-or-trailing key of three
 *  of this collection's four indexes — the sort is served by an index walk in
 *  either direction rather than by a sort stage.
 *
 *  Anything else a caller asks for is REFUSED FAIL-OPEN: the default is used and
 *  a warning names the valid keys. A sort key that silently did nothing would be
 *  a table that ignores the column you clicked.
 * ============================================================================
 */

import syncConstants = require('./sync.constants');

const { STORABLE_JOB_TYPES, SYNC_JOB_STATUS, SYNC_JOB_TRIGGERED_BY } = syncConstants;

/**
 * The sort keys this endpoint can serve. See the header for why there is exactly one.
 *
 * `readonly string[]` rather than a literal tuple: it is tested against a raw query-bag value
 * (`SYNC_JOB_LIST_SORT_KEYS.includes(rawSort)`), and a tuple of literals would reject that call.
 */
const SYNC_JOB_LIST_SORT_KEYS: readonly string[] = Object.freeze(['createdAt']);

/** Newest first — the order the history table renders, and the one its index is built for. */
const DEFAULT_SYNC_JOB_SORT_KEY = 'createdAt';
const DEFAULT_SYNC_JOB_SORT_DIR = 'desc';

/**
 * Page size when the caller names none.
 *
 * 20, matching `SyncJobHistoryTable`'s own `limit || 20` default, so a caller that omits the
 * parameter and a caller that sends the component's default get the same page — a mismatch here
 * would show up as the footer's "Showing 1–20 of N" disagreeing with the number of rows on screen.
 */
const SYNC_JOB_DEFAULT_LIMIT = 20;

/**
 * Largest page this endpoint will serve.
 *
 * A ceiling rather than an error: an over-large request is CLAMPED and warned about, because the
 * caller still wants the data and `pagination.total` tells them how much of it they did not get.
 */
const SYNC_JOB_MAX_LIMIT = 100;

/**
 * The filterable groups, and the CLOSED vocabulary each one accepts.
 *
 *  All three vocabularies are enforced by the schema's own `enum`, so the database physically
 * cannot hold a value outside them — which is what makes rejecting an unrecognised filter value
 * safe here, where the store lists needed an observed-values escape hatch. A value outside these
 * sets could only reach the collection from a build with a different vocabulary, and the response
 * reports any such row in `job_type_counts` / `status_counts` so the tallies still reconcile.
 *
 * ⚠️ `job_type` is the STORABLE set, not the runnable one. The ledger is an audit record: a row
 * written by an older or newer build must still be findable, and filtering it out of existence
 * would make the history lie about what has run.
 */
const SYNC_JOB_FILTER_GROUPS = Object.freeze({
    job_type: 'job type',
    status: 'status',
    triggered_by: 'trigger'
});

/** The values each filter group accepts, in the order they are reported with their zeros. */
const SYNC_JOB_FILTER_VOCABULARY = Object.freeze({
    job_type: Object.freeze(Object.values<string>(STORABLE_JOB_TYPES)),
    status: Object.freeze(Object.values<string>(SYNC_JOB_STATUS)),
    triggered_by: Object.freeze(Object.values<string>(SYNC_JOB_TRIGGERED_BY))
});

/**
 * What the ledger itself is holding.
 *
 *  THE ONE PLACE IN THIS CODEBASE WHERE A ROW COUNT IS A LEGITIMATE STATE, and it needs saying out
 * loud because the rule everywhere else is the opposite. Every other collection is a PROJECTION of an
 * upstream we might have failed to read, so "no rows" there is ambiguous between "nothing happened"
 * and "we never looked" — which is why those states are decided by a watermark.
 *
 * `gi_sync_jobs` has no upstream. It is written by this process, on enqueue, and the row IS the job.
 * There is nothing that could have been enqueued and be missing, so an empty ledger is a measurement
 * rather than a gap: nothing has ever been enqueued on this deployment. The warning that accompanies
 * `EMPTY` names `SYNC_DISABLED` as the likeliest cause, because that is the state in which an empty
 * ledger stays empty forever while everything else looks healthy.
 */
const SYNC_JOB_LEDGER_STATES = Object.freeze({
    /** The collection holds no job rows at all: nothing has ever been enqueued here. */
    EMPTY: 'EMPTY',
    /** At least one job has been enqueued. */
    READY: 'READY'
});

export = {
    SYNC_JOB_LIST_SORT_KEYS,
    DEFAULT_SYNC_JOB_SORT_KEY,
    DEFAULT_SYNC_JOB_SORT_DIR,
    SYNC_JOB_DEFAULT_LIMIT,
    SYNC_JOB_MAX_LIMIT,
    SYNC_JOB_FILTER_GROUPS,
    SYNC_JOB_FILTER_VOCABULARY,
    SYNC_JOB_LEDGER_STATES
};
