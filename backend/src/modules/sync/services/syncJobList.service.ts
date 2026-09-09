'use strict';

/**
 * ============================================================================
 *  WHAT HAS RUN — the job-history table
 * ============================================================================
 *
 *  Serves `GET /api/sync/jobs`, which backs `SyncJobHistoryTable`. Until this
 *  endpoint existed that component was written, imported and UNREACHABLE: the
 *  Sync page probed the list call once at mount and, on the not-implemented
 *  envelope, fell back to a session-scoped list of jobs this browser tab
 *  happened to trigger plus a lookup box for a job id you already knew. So the
 *  history of every run this deployment has ever made was visible only in the
 *  server log.
 *
 *  ──  WHY THE COUNTS DO NOT COME FROM `items` ──────────────────────────────
 *
 *  The house rule elsewhere is one array, one pass, every count folded from it.
 *  That rule exists so a number cannot be derived twice and disagree with
 *  itself, and it holds because those endpoints have to build their whole
 *  population in memory anyway — the state machine, the MRR predicate and the
 *  attribution join all need every row.
 *
 *  This endpoint has no fold. Its rows are the stored rows, and `gi_sync_jobs`
 *  is an APPEND-ONLY LEDGER WITH NO RETENTION (see the model file, which records
 *  that as a decision): it only ever grows. Folding it into memory to satisfy
 *  the letter of the rule would trade a bounded, indexed page read for an
 *  unbounded one that gets slower every day the deployment stays up — and it
 *  would still not be one pass, because the PRE-FILTER tallies describe the
 *  whole ledger while the page describes one slice of it.
 *
 *  So the rule's PURPOSE is kept and its mechanics are moved into the database:
 *  every count on this response is derived EXACTLY ONCE, in a single `$facet`
 *  aggregation, at a single instant. `ledger_rows`, the three tallies and
 *  `pagination.total` are read from the same scan and cannot disagree.
 *
 *  ⚠️ The page is a SECOND read, taken microseconds later. A job enqueued between
 *  the two shifts every row by one — inherent to paginating a live collection,
 *  and the reason the newest page is the one that moves. `as_of` stamps when the
 *  counts were taken.
 *
 *  ──  ZEROS ARE THE MOST USEFUL THING ON THIS RESPONSE ─────────────────────
 *
 *  `job_type_counts` carries a key for EVERY storable job type, including the
 *  ones at zero. A tally that listed only what occurred would render as a
 *  distribution over whatever happened to run — a ledger holding nothing but
 *  PARTNER_SYNC rows would read "100% partner syncs" rather than "the GA4
 *  rollups and install attribution have never run on this deployment", which is
 *  the single most actionable sentence this screen can produce.
 *
 *  ── PRE-FILTER, AND WHY ─────────────────────────────────────────────────────
 *
 *  The tallies ignore the caller's filter. A post-filter tally reports `0` for
 *  every job type the reader did not select, which looks exactly like a filter
 *  that deleted the rest of the history. What the current filter selects is
 *  `pagination.total`, published beside them.
 *
 *  ── FAIL-OPEN, ALWAYS ───────────────────────────────────────────────────────
 *
 *  An unrecognised `job_type`, `status`, `triggered_by` or `sort` is DROPPED and
 *  warned about, never matched. A typo must WIDEN the result set: a table that
 *  renders zero rows because of a bad query string is indistinguishable from a
 *  deployment that has never run anything, and the reader cannot tell which they
 *  are looking at. An over-large `limit` and a page past the end are CLAMPED for
 *  the same reason — the caller still wants the data.
 *
 *  ── EVERY NUMBER IS A BARE NUMBER ───────────────────────────────────────────
 *
 *  Not a confidence envelope. `pagination.total.toLocaleString()` throws on an
 *  object and takes the table's footer with it, and `Number({…})` is `NaN`,
 *  which renders as an em dash — MANUFACTURING the missing figure the rule
 *  exists to prevent. The honesty contract is discharged through `ledger_state`,
 *  `sync_disabled` and `warnings[]`, which survive rendering.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import listQueryHelper = require('../../shared/helpers/listQuery.helper');
import listConstants = require('../constants/syncJobList.constants');
import syncJobRowHelper = require('../helpers/syncJobRow.helper');
import syncJobRepository = require('../repositories/syncJob.repository');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type { SerializedSyncJob } from '../types/syncJob.types';
import type {
    SyncJobCountBucket,
    SyncJobCounts,
    SyncJobListFilters,
    SyncJobListParams,
    SyncJobListResponse
} from '../types/syncJobList.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { positiveInt } = listQueryHelper;
//  The SAME serializer every other sync endpoint uses. A local copy would be the second spelling
// of what a job row looks like, and two serializers drift silently rather than failing.
const { serializeSyncJob } = syncJobRowHelper;
const {
    SYNC_JOB_LIST_SORT_KEYS,
    DEFAULT_SYNC_JOB_SORT_KEY,
    DEFAULT_SYNC_JOB_SORT_DIR,
    SYNC_JOB_DEFAULT_LIMIT,
    SYNC_JOB_MAX_LIMIT,
    SYNC_JOB_FILTER_GROUPS,
    SYNC_JOB_FILTER_VOCABULARY,
    SYNC_JOB_LEDGER_STATES
} = listConstants;

/*
 * ⚠️ The TypeScript return type below is the UNPARAMETERISED `ServiceResult`, while the JSDoc
 * `@returns` names the payload it carries on success. Same convention as every other service here:
 * a failure envelope carries `data: {}`, which is not assignable to a payload interface, so
 * parameterising would force a cast at every failure branch — and this codebase reserves `as` for
 * `shared/repositories/models.repository` and `as const`. The success payload is still built as a
 * TYPED LOCAL, so a missing or misnamed field is a compile error where it would actually be wrong.
 */

/**
 * The groups a caller may filter by.
 *
 *  DERIVED FROM THE CONSTANT WITH `keyof`, never typed out. Adding a group to
 * `SYNC_JOB_FILTER_GROUPS` widens this union automatically, which then FAILS TO COMPILE at the two
 * places below that must be total over it — the vocabulary map and the validated selection. A
 * hand-written union would let a group gain a control and never gain a predicate, which is a filter
 * that ticks and changes nothing: worse than a missing filter, because it looks like it worked.
 */
type FilterGroupKey = keyof typeof SYNC_JOB_FILTER_GROUPS;

/**
 * Widened copies of the frozen vocabularies, so a `string` off the query bag can be tested against
 * them without an `as` cast. Assignment widens; it does not re-type anything.
 *
 * ⚠️ The annotation on `_VOCABULARY` is load-bearing rather than decorative: `Record<FilterGroupKey,
 * …>` is what makes a group declared in `SYNC_JOB_FILTER_GROUPS` and forgotten in
 * `SYNC_JOB_FILTER_VOCABULARY` a compile error here, at the assignment, instead of an `undefined`
 * vocabulary that rejects every value the group is given.
 */
const _VOCABULARY: Readonly<Record<FilterGroupKey, readonly string[]>> = SYNC_JOB_FILTER_VOCABULARY;
const _GROUP_LABELS: Readonly<Record<string, string>> = SYNC_JOB_FILTER_GROUPS;

/**
 *  THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * Warnings are rendered one per string and KEYED BY THE STRING ITSELF, so two identical strings are
 * a duplicate-key collision and one of them is silently dropped — a second copy of a message does
 * not double up, it DISAPPEARS, and takes its condition with it. Keeping them together is what makes
 * that checkable by eye; the emit path de-duplicates as well, so a message that can legitimately be
 * produced twice cannot take its own twin down.
 *
 * Each is written for an operator who cannot see this code: what is missing, what that does to the
 * numbers beside it, and what would fix it.
 */
const _WARNINGS = Object.freeze({
    /**
     *  THE EMPTY LEDGER, WHICH THE TABLE OTHERWISE RENDERS AS "No sync jobs yet · Trigger a sync to
     * see jobs appear here" — a cheerful instruction that is exactly wrong when the reason nothing is
     * there is that syncing is switched off and pressing the button will change nothing.
     */
    emptyLedger: 'No background job has ever been recorded on this deployment. This collection IS the '
        + 'queue — a job row is written the moment one is enqueued — so an empty history means nothing '
        + 'has been triggered here yet, by an operator or by the schedule.',

    syncDisabled: 'SYNC_DISABLED=true, so the runner claims nothing and no schedule is armed. Stored '
        + 'data is still served and every figure on this dashboard keeps rendering — it simply stops '
        + 'moving. Unset the variable and restart the API to resume syncing.',

    unrecognisedFilter: (group: string, value: string): string => `The ${group} filter "${value}" is not a `
        + 'value this endpoint can evaluate, so it has been ignored and the list below is wider than you '
        + 'asked for. Filtering on it would have returned an empty table, which is indistinguishable '
        + 'from a deployment that has never run anything.',

    unrecognisedSort: (value: string): string => `The sort key "${value}" is not sortable here, so the `
        + `default sort (${DEFAULT_SYNC_JOB_SORT_KEY}, newest first) has been used instead. Valid `
        + `values: ${SYNC_JOB_LIST_SORT_KEYS.join(', ')} — every other column on a job row is null `
        + 'until the job finishes, and sorting on an absence would put the jobs that have never '
        + 'completed at the top of a column headed "completed".',

    limitClamped: (requested: number, applied: number): string => `A page size of ${requested} was `
        + `requested; this endpoint serves at most ${applied} jobs per page, so the list below is one `
        + 'page of that size. The `pagination` block carries the real total.',

    pageClamped: (requested: number, applied: number): string => `Page ${requested} was requested and `
        + `this filter selects only ${applied} page(s), so the last page is shown instead. An empty page `
        + 'past the end would have rendered as "no sync jobs yet" over a history that is not empty.',

    unknownVocabulary: (group: string, values: string): string => `The ledger holds row(s) whose ${group} `
        + `is not a value this build knows: ${values}. They were written by a different version of this `
        + 'application, are counted in the tallies so the totals still reconcile, and are listed in the '
        + 'table like any other row — but they cannot be filtered for by name.'
});

/**
 * Turns a `$group` result into a tally that carries EVERY declared value, zeros included.
 *
 *  THE ZEROS ARE NOT PADDING. A tally built only from what occurred describes a distribution over
 * the rows that exist, and reads as a statement about the deployment: three job types missing from
 * the tally is "we only run partner syncs", when the truth is "the other three have never run here".
 *
 * ⚠️ A bucket OUTSIDE the declared vocabulary is kept rather than dropped, so the tally still sums to
 * `ledger_rows`. A tally that silently discarded rows would be arithmetic a reader could not check,
 * and the discarded rows are precisely the interesting ones — they came from another build.
 *
 * @param buckets - The raw `$group` output.
 * @param vocabulary - Every value that must appear, in report order.
 * @returns `{ counts, unknown }` — the zero-filled tally, and any value outside the vocabulary.
 */
const _zeroFilledCounts = (
    buckets: readonly SyncJobCountBucket[],
    vocabulary: readonly string[]
): { counts: SyncJobCounts; unknown: string[] } => {
    const counts: SyncJobCounts = {};
    for (const value of vocabulary) {
        counts[value] = 0;
    }

    const unknown: string[] = [];
    for (const bucket of buckets) {
        //  A null `_id` means rows exist that carry NO value for this field at all — impossible
        // through the schema's enum, possible from a hand-edited document. Named rather than
        // silently folded into a zero.
        const value = bucket._id === null || bucket._id === undefined ? '(none)' : String(bucket._id);
        if (!(value in counts)) {
            counts[value] = 0;
            if (unknown.indexOf(value) === -1) {
                unknown.push(value);
            }
        }
        counts[value] += bucket.rows || 0;
    }

    return { counts: counts, unknown: unknown };
};

/**
 * The one value of a filter group this endpoint will apply, or `''`.
 *
 * ⚠️ ONE VALUE PER GROUP, not a comma-separated list. That is the contract `SyncJobHistoryTable`
 * actually has — it takes a single `jobType` and a single `status` prop — and a multi-select would
 * need the echo, the tally and the predicate all widened to arrays for a control nothing renders.
 * A comma-separated value is simply not in the vocabulary, so it is dropped with a warning and the
 * table widens, which is the correct direction to be wrong in.
 *
 * ⚠️ FAIL-OPEN. An unrecognised value is dropped, never matched: matching it would return an empty
 * table, and an empty table is indistinguishable from a deployment that has never run anything.
 *
 * @param groupKey - The group being validated.
 * @param raw - The parameter exactly as it arrived.
 * @param warnings - Mutated: one operator-facing sentence per dropped value.
 * @returns The value worth applying, or `''` when the group constrains nothing.
 */
const _validateFilterValue = (groupKey: FilterGroupKey, raw: unknown, warnings: string[]): string => {
    if (raw === null || raw === undefined) {
        return '';
    }
    const value = String(raw).trim();
    if (value === '') {
        return '';
    }
    if (_VOCABULARY[groupKey].indexOf(value) === -1) {
        warnings.push(_WARNINGS.unrecognisedFilter(_GROUP_LABELS[groupKey], value));
        return '';
    }
    return value;
};

/**
 * Lists sync jobs — one page, with the whole ledger's tallies beside it.
 *
 *  A 200 WITH ZERO ROWS IS A REAL ANSWER, always. "Nothing has ever run here", "nothing matches
 * this filter" and "syncing is switched off" are separated by `ledger_state`, `pagination.total`,
 * `sync_disabled` and `warnings[]` — never by a refusal and never by a 404.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The operator asking.
 * @param params1 - The parameters object, straight off the query bag and entirely untrusted.
 * @param [params1.page] - 1-based page. Clamped to the last page that exists.
 * @param [params1.limit] - Rows per page. Clamped to `SYNC_JOB_MAX_LIMIT`.
 * @param [params1.job_type] - One storable job type, or absent.
 * @param [params1.status] - One lifecycle status, or absent.
 * @param [params1.triggered_by] - `MANUAL` or `CRON`, or absent.
 * @param [params1.sort] - Sort key. Only `createdAt` is servable.
 * @param [params1.dir] - `asc` or `desc`.
 * @returns Resolves with the page and the ledger's
 * tallies. Never rejects.
 */
const listSyncJobs = (
    { user_id }: IdentityObject,
    { page, limit, job_type, status, triggered_by, sort, dir }: SyncJobListParams
): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available, please log in and try again.'));
            }

            // THE ONE JUDGEMENT INSTANT, read once. Everything below is stamped with it.
            const asOf = new Date();
            const warnings: string[] = [];

            // ── A. Fail-open validation of everything the caller asked for ──
            //
            // WRITTEN OUT, not looped, so the COMPILER proves this is total over the filter
            // vocabulary: `Record<FilterGroupKey, string>` is derived from `SYNC_JOB_FILTER_GROUPS`,
            // so adding a group there without a line here stops compiling. Built as a loop it would
            // type-check with a group missing, and that group would render a control the server
            // silently ignores — a filter that ticks and changes nothing.
            const selected: Record<FilterGroupKey, string> = {
                job_type: _validateFilterValue('job_type', job_type, warnings),
                status: _validateFilterValue('status', status, warnings),
                triggered_by: _validateFilterValue('triggered_by', triggered_by, warnings)
            };

            //  A group that validated to `''` is OMITTED from the mongo filter rather than sent as
            // an empty match. An unconstrained group must constrain nothing; `{ status: '' }` would
            // match no row at all and empty the table, which is the failure fail-open exists to
            // prevent — arrived at from the other direction.
            const filters: SyncJobListFilters = {
                job_type: selected.job_type === '' ? [] : [selected.job_type],
                status: selected.status === '' ? [] : [selected.status],
                triggered_by: selected.triggered_by === '' ? [] : [selected.triggered_by]
            };
            const filter: Record<string, unknown> = {};
            //  `Object.entries`, not `Object.keys` + an index — the entries form carries the value
            // with the key, so this needs no `as` cast to read it back out. (This codebase reserves
            // `as` for the model chokepoint and `as const`.) Iterating the SELECTION rather than a
            // hand-written key list is what keeps this covering a group added later.
            for (const [key, value] of Object.entries(selected)) {
                if (value !== '') {
                    filter[key] = value;
                }
            }

            const rawSort = sort === undefined || sort === null ? '' : String(sort).trim();
            let sortKey = DEFAULT_SYNC_JOB_SORT_KEY;
            if (rawSort !== '' && rawSort !== DEFAULT_SYNC_JOB_SORT_KEY) {
                if (SYNC_JOB_LIST_SORT_KEYS.includes(rawSort)) {
                    sortKey = rawSort;
                } else {
                    warnings.push(_WARNINGS.unrecognisedSort(rawSort));
                }
            }
            const sortDir = String(dir || '').trim().toLowerCase() === 'asc' ? 'asc' : DEFAULT_SYNC_JOB_SORT_DIR;

            const pageLimit = positiveInt(limit, SYNC_JOB_DEFAULT_LIMIT, SYNC_JOB_MAX_LIMIT);
            const requestedLimit = positiveInt(limit, SYNC_JOB_DEFAULT_LIMIT, Number.MAX_SAFE_INTEGER);
            if (requestedLimit > pageLimit) {
                warnings.push(_WARNINGS.limitClamped(requestedLimit, pageLimit));
            }

            // ── B. Every count, from ONE pass at ONE instant ────────────────
            const counts = await syncJobRepository.aggregateSyncJobCounts(filter);

            const jobTypeTally = _zeroFilledCounts(counts.by_job_type, _VOCABULARY.job_type);
            const statusTally = _zeroFilledCounts(counts.by_status, _VOCABULARY.status);
            const triggeredByTally = _zeroFilledCounts(counts.by_triggered_by, _VOCABULARY.triggered_by);

            //  Summed from the job-type tally rather than counted separately, so `ledger_rows` and
            // the tallies are the same measurement by construction and cannot drift apart.
            let ledgerRows = 0;
            for (const value of Object.keys(jobTypeTally.counts)) {
                ledgerRows += jobTypeTally.counts[value];
            }

            if (jobTypeTally.unknown.length > 0) {
                warnings.push(_WARNINGS.unknownVocabulary(_GROUP_LABELS.job_type, jobTypeTally.unknown.join(', ')));
            }
            if (statusTally.unknown.length > 0) {
                warnings.push(_WARNINGS.unknownVocabulary(_GROUP_LABELS.status, statusTally.unknown.join(', ')));
            }
            if (triggeredByTally.unknown.length > 0) {
                warnings.push(_WARNINGS.unknownVocabulary(_GROUP_LABELS.triggered_by, triggeredByTally.unknown.join(', ')));
            }

            // ── C. The page ────────────────────────────────────────────────
            const total = counts.total;
            const pages = total > 0 ? Math.ceil(total / pageLimit) : 0;
            const requestedPage = positiveInt(page, 1, Number.MAX_SAFE_INTEGER);
            const pageNumber = Math.min(requestedPage, Math.max(pages, 1));
            if (requestedPage > pageNumber) {
                warnings.push(_WARNINGS.pageClamped(requestedPage, pages));
            }

            //  The read is SKIPPED when nothing matched. `skip`/`limit` over an empty match is a
            // guaranteed-empty query, and issuing it would make the log read as though a question had
            // been asked that had not.
            let items: SerializedSyncJob[] = [];
            if (total > 0) {
                const docs = await syncJobRepository.findSyncJobPage({
                    filter: filter,
                    sort_field: sortKey,
                    sort_dir: sortDir === 'asc' ? 1 : -1,
                    skip: (pageNumber - 1) * pageLimit,
                    limit: pageLimit
                });
                for (const doc of docs) {
                    const row = serializeSyncJob(doc);
                    //  `serializeSyncJob` returns null only for a null document, which `find`
                    // cannot produce. The guard is what lets `items` be typed without a cast.
                    if (row) {
                        items.push(row);
                    }
                }
            }

            // ── D. What the emptiness means ────────────────────────────────
            // Typed `string` rather than left to inference: the initialiser narrows to the literal
            // `'READY'`, and the EMPTY branch below would then be a compile error rather than a state.
            let ledgerState: string = SYNC_JOB_LEDGER_STATES.READY;
            if (ledgerRows === 0) {
                ledgerState = SYNC_JOB_LEDGER_STATES.EMPTY;
                warnings.push(_WARNINGS.emptyLedger);
            }
            if (config.SYNC.DISABLED) {
                warnings.push(_WARNINGS.syncDisabled);
            }

            const payload: SyncJobListResponse = {
                as_of: asOf.toISOString(),
                items: items,
                pagination: { page: pageNumber, limit: pageLimit, total: total, pages: pages },
                sort: { key: sortKey, dir: sortDir },
                filters: filters,
                job_type_counts: jobTypeTally.counts,
                status_counts: statusTally.counts,
                triggered_by_counts: triggeredByTally.counts,
                ledger_rows: ledgerRows,
                ledger_state: ledgerState,
                sync_disabled: config.SYNC.DISABLED,
                // DE-DUPLICATED, and not because any message here is expected twice: warnings are
                // rendered keyed by the string itself, so a duplicate is a key collision that DROPS
                // one of them — a message silently taking its own twin down with it.
                warnings: [...new Set(warnings)]
            };

            return resolve(promiseReturnResult(true, payload, {}, 'Sync jobs fetched.'));
        } catch (error) {
            customConsoleError('ERROR: Sync syncJobListService listSyncJobs', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read the sync job history. Please try again.'));
        }
    });
};

export = {
    listSyncJobs
};
