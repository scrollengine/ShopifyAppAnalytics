'use strict';

/**
 * ============================================================================
 *  THE SYNC PAGE — job history, cancellation, and the health snapshot
 * ============================================================================
 *
 *  Four properties, and every one of them is a mistake this build could
 *  plausibly have shipped:
 *
 *    1.  THE CANCEL RESPECTS THE CLAIM. Cancelling is a conditional write
 *       against `status: PENDING` — the SAME precondition, in the SAME shape, as
 *       the runner's claim — so when the two race exactly one of them matches.
 *       A cancel that loses must LOSE CLEANLY: report that it did not happen,
 *       name the state that refused it, and NOT retry. A second spelling of that
 *       query, or a retry loop that eventually "wins", is how a job gets marked
 *       CANCELLED while its handler is still writing.
 *
 *    2. A TERMINAL JOB CANNOT BE CANCELLED, and the refusal says which terminal
 *       state it is in rather than a sentence covering three different cases.
 *
 *    3. THE LIST'S COUNTS ARE PRE-FILTER AND CARRY THEIR ZEROS. A tally built
 *       from the filtered page reports `0` for every job type the reader did not
 *       select, which looks like the history was deleted; a tally that omits its
 *       empty buckets reports a ledger of nothing but partner syncs as "100%
 *       partner syncs" instead of "the other three have never run here".
 *
 *    4. HEALTH REPORTS THE SIXTEEN COLLECTIONS THIS BUILD ACTUALLY HAS, and tells
 *       "never synced" from "synced and found nothing" BY THE WATERMARK. Both
 *       produce zero rows. Publishing them alike reports a quiet week as an
 *       outage, or an outage as a quiet week.
 *
 *  ── Why the BigQuery variables are deleted at the top ───────────────────────
 *  `src/config` snapshots `process.env` AT FIRST REQUIRE, so one process cannot
 *  exercise both tier states. This file runs with the listing tier OFF, which is
 *  what lets it assert the NOT_CONNECTED branch end to end. The other listing
 *  branches are asserted through `resolveCollectionState`, which is PURE and
 *  takes `listing_tier_connected` as an argument — no process state involved.
 *
 *  ⚠️ THE DELETES MUST STAY ABOVE EVERY REQUIRE. A `require` of the config
 *  anywhere earlier — even transitively, through a repository — freezes the
 *  snapshot and this file silently tests the connected path.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';
delete process.env.GCP_PROJECT_ID;
delete process.env.BQ_DATASET;
delete process.env.GCP_SERVICE_ACCOUNT_JSON;
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.SYNC_DISABLED;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mongoose = require('mongoose');

//  REUSED, not reimplemented. `stripComments` is string-aware — it will not open a comment on a
// `//` inside a string literal — and this file needs it to assert what the CODE does rather than
// what a JSDoc block happens to mention.
const { stripComments } = require('./_harness/exportSurface');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SYNC_ROOT = path.join(BACKEND_ROOT, 'src', 'modules', 'sync');

//  Short, so an unstubbed query FAILS FAST instead of hanging the suite for ten seconds. Every
// repository call below is stubbed; anything that reaches mongoose is a test that is not testing
// what it says it is.
mongoose.set('bufferTimeoutMS', 400);

const syncJobRepository = require(path.join(SYNC_ROOT, 'repositories', 'syncJob.repository.ts'));
const syncHealthRepository = require(path.join(SYNC_ROOT, 'repositories', 'syncHealth.repository.ts'));
const healthConstants = require(path.join(SYNC_ROOT, 'constants', 'syncHealth.constants.ts'));
const listConstants = require(path.join(SYNC_ROOT, 'constants', 'syncJobList.constants.ts'));
const syncConstants = require(path.join(SYNC_ROOT, 'constants', 'sync.constants.ts'));
const { resolveCollectionState } = require(path.join(SYNC_ROOT, 'helpers', 'collectionState.helper.ts'));

const { cancelSyncJob } = require(path.join(SYNC_ROOT, 'services', 'syncJob.service.ts'));
const { listSyncJobs } = require(path.join(SYNC_ROOT, 'services', 'syncJobList.service.ts'));
const { getSyncHealth } = require(path.join(SYNC_ROOT, 'services', 'syncHealth.service.ts'));
const { describeSchedules } = require(path.join(SYNC_ROOT, 'services', 'syncCronScheduler.service.ts'));

const syncController = require(path.join(BACKEND_ROOT, 'src', 'controllers', 'sync.controller.ts'));

const { HEALTH_COLLECTIONS, HEALTH_COLLECTION_STATES, HEALTH_COLLECTION_TIERS } = healthConstants;
const { SYNC_JOB_LEDGER_STATES } = listConstants;
const { SYNC_JOB_STATUS, STORABLE_JOB_TYPES } = syncConstants;

const IDENTITY = { user_id: 'operator-1' };
const JOB_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

/** Source text of a file under `src/`, for the structural assertions. */
const _source = (relative) => fs.readFileSync(path.join(BACKEND_ROOT, relative), 'utf8');

/** A stored job row, as `lean()` hands one back. */
const _jobDoc = (overrides) => Object.assign({
    _id: JOB_ID,
    job_type: STORABLE_JOB_TYPES.PARTNER_SYNC,
    payload: { partner_app_id: 'app-1' },
    status: SYNC_JOB_STATUS.PENDING,
    triggered_by: 'MANUAL',
    triggered_by_user_id: 'operator-1',
    started_at: null,
    completed_at: null,
    duration_ms: null,
    error_message: '',
    error_stack: '',
    failure_reason: '',
    result_summary: {},
    attempts: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z')
}, overrides || {});

/**
 * An Express response stub that records what a controller sent.
 *
 * Chains, because `apiResponse` calls `res.status(n).json(body)`.
 */
const _res = () => {
    const sent = { code: 0, body: null };
    const res = {
        sent: sent,
        status(code) {
            sent.code = code;
            return res;
        },
        json(body) {
            sent.body = body;
            return res;
        }
    };
    return res;
};

/** Restores every repository stub, so one test cannot leak into the next. */
const _restore = () => {
    delete syncJobRepository.cancelPendingSyncJob;
    delete syncJobRepository.findSyncJobById;
    delete syncJobRepository.claimPendingJob;
    delete syncJobRepository.aggregateSyncJobCounts;
    delete syncJobRepository.findSyncJobPage;
    delete syncHealthRepository.countAllCollections;
    delete syncHealthRepository.findPartnerAppHealthRows;
    delete syncHealthRepository.aggregateSyncJobHealth;
    delete syncHealthRepository.readAuthHealthFacts;
};

/**
 * Stubs the auth fact the health screen reads (spec A18). Every health test stubs it: left real, it
 * queries a database this file never connects and burns the 400 ms buffer timeout per call.
 *
 * @param {Boolean} ownerMissing - What the install document says about the owner row.
 * @returns {void}
 */
const _stubAuthFacts = (ownerMissing) => {
    syncHealthRepository.readAuthHealthFacts = async () => ({ owner_missing: Boolean(ownerMissing) });
};


/* ==========================================================================
 *  1.  THE CANCEL RESPECTS THE CLAIM
 * ========================================================================== */

test(' the conditional cancel is spelled ONCE, in the repository, and no service writes at all', () => {
    const repositorySource = _source('src/modules/sync/repositories/syncJob.repository.ts');

    // The cancel is the ONLY `findOneAndUpdate` on this collection, and the claim the only
    // `updateOne`. A second of either is a second spelling of a conditional write whose whole
    // safety property is that there is one of it.
    assert.equal(
        (repositorySource.match(/findOneAndUpdate\(/g) || []).length,
        1,
        'There is more than one findOneAndUpdate in the sync-job repository. The conditional cancel must exist exactly once — '
        + 'two spellings of it drift, and the drift is a job cancelled while its handler is still running.'
    );
    assert.equal(
        (repositorySource.match(/updateOne\(/g) || []).length,
        1,
        'There is more than one updateOne in the sync-job repository. THE CLAIM is the single most safety-critical query in '
        + 'the application and must have exactly one definition — a second one is how a job gets executed twice.'
    );

    // Every write lives behind the repository. A service issuing one is a second door to the same
    // race, and the ESLint layer guard does not catch it (a service may import a repository).
    const serviceDir = path.join(SYNC_ROOT, 'services');
    for (const file of fs.readdirSync(serviceDir)) {
        const text = fs.readFileSync(path.join(serviceDir, file), 'utf8');
        for (const forbidden of ['findOneAndUpdate(', 'updateOne(', 'updateMany(', 'findByIdAndUpdate(']) {
            assert.equal(
                text.includes(forbidden),
                false,
                `services/${file} issues ${forbidden} directly. Every write to gi_sync_jobs belongs in the repository, where the `
                + 'conditional claim and the conditional cancel can be read side by side.'
            );
        }
    }
});

test(' a cancel that LOSES the race to the claim reports that it did not happen, and says why', async () => {
    let cancelCalls = 0;
    let cancelledWith = null;

    // The conditional write matched NOTHING: the runner claimed the row first.
    syncJobRepository.cancelPendingSyncJob = async (jobId, params) => {
        cancelCalls += 1;
        cancelledWith = { jobId: jobId, params: params };
        return null;
    };
    // The row, as it now stands.
    syncJobRepository.findSyncJobById = async () => _jobDoc({
        status: SYNC_JOB_STATUS.RUNNING,
        started_at: new Date('2026-01-01T00:00:05.000Z'),
        attempts: 1
    });
    //  THROWS. The cancel path must never reach for the claim: re-issuing the claim's query to
    // "win" the race is the exact mistake that makes double-execution possible.
    syncJobRepository.claimPendingJob = async () => {
        throw new Error('the cancel path must never issue the claim query');
    };

    const result = await cancelSyncJob(IDENTITY, { job_id: JOB_ID });
    _restore();

    assert.equal(cancelCalls, 1, 'The conditional cancel was issued more than once. A retry loop is a cancel that eventually wins a race it already lost.');
    assert.ok(cancelledWith.params.now instanceof Date, 'The repository must be handed the instant, not read a clock of its own.');

    // ⚠️ A lost race is an ORDINARY OUTCOME, not a failure — same contract as a declined claim.
    assert.equal(result.status, true, 'A lost cancel is not an error; it resolves successfully with cancelled: false.');
    assert.equal(result.data.cancelled, false, ' THE GATE. A caller branching on `status` alone would report a cancellation that did not happen.');
    assert.equal(result.data.current_status, SYNC_JOB_STATUS.RUNNING, 'The refusal must name the state that actually refused it.');
    assert.match(result.data.reason, /RUNNING/, 'The reason must say the job is RUNNING, not offer a sentence covering three different cases.');
    assert.match(result.data.reason, /NOT cancelled/, 'The reason must state plainly that nothing was cancelled.');
    assert.match(result.data.job.status, /RUNNING/, 'The row is published as it stands, so the screen can show what actually happened to it.');
});

test(' a TERMINAL job cannot be cancelled, and the refusal names which terminal state', async () => {
    for (const terminal of [SYNC_JOB_STATUS.SUCCESS, SYNC_JOB_STATUS.FAILED, SYNC_JOB_STATUS.CANCELLED]) {
        syncJobRepository.cancelPendingSyncJob = async () => null;
        syncJobRepository.findSyncJobById = async () => _jobDoc({
            status: terminal,
            completed_at: new Date('2026-01-01T00:01:00.000Z'),
            attempts: 1
        });

        const result = await cancelSyncJob(IDENTITY, { job_id: JOB_ID });

        assert.equal(result.status, true, `${terminal}: a refusal is an outcome, not a transport failure.`);
        assert.equal(result.data.cancelled, false, `${terminal}: a finished job must never report as cancelled.`);
        assert.equal(result.data.current_status, terminal);
        assert.match(
            result.data.reason,
            new RegExp(terminal),
            `${terminal}: the reason must name the state, so an operator knows whether to wait or to stop waiting.`
        );
        assert.match(result.data.reason, /nothing left to cancel/, `${terminal}: the reason must say there is nothing to cancel.`);
    }
    _restore();
});

test('a PENDING job cancels, and the row comes back CANCELLED', async () => {
    syncJobRepository.cancelPendingSyncJob = async () => _jobDoc({
        status: SYNC_JOB_STATUS.CANCELLED,
        completed_at: new Date('2026-01-01T00:00:30.000Z')
    });
    //  THROWS. The winning path must not re-read the row: the conditional write already returned
    // the updated document, and a second read would be a second instant with nothing to gain.
    syncJobRepository.findSyncJobById = async () => {
        throw new Error('a successful cancel must not re-read the row');
    };

    const result = await cancelSyncJob(IDENTITY, { job_id: JOB_ID });
    _restore();

    assert.equal(result.status, true);
    assert.equal(result.data.cancelled, true);
    assert.equal(result.data.current_status, SYNC_JOB_STATUS.CANCELLED);
    assert.equal(result.data.job.status, SYNC_JOB_STATUS.CANCELLED);
    assert.equal(result.data.reason, '', 'A successful cancel carries no refusal reason.');
});

test('an unknown job id is a failure, not a "declined" cancel — the two are different answers', async () => {
    syncJobRepository.cancelPendingSyncJob = async () => null;
    syncJobRepository.findSyncJobById = async () => null;

    const result = await cancelSyncJob(IDENTITY, { job_id: JOB_ID });
    _restore();

    assert.equal(result.status, false, 'No such row is a failed call; `data` is empty and the controller answers 404.');
    assert.deepEqual(result.data, {});
});

test('a malformed job_id is refused before it reaches mongoose', async () => {
    syncJobRepository.cancelPendingSyncJob = async () => {
        throw new Error('a malformed id must never reach the repository');
    };

    const result = await cancelSyncJob(IDENTITY, { job_id: 'not-an-object-id' });
    _restore();

    assert.equal(result.status, false);
    assert.match(result.msg, /valid job_id/);
});

test(' the CONTROLLER turns a lost cancel back into a refusal on the wire — never a 200', async () => {
    syncJobRepository.cancelPendingSyncJob = async () => null;
    syncJobRepository.findSyncJobById = async () => _jobDoc({ status: SYNC_JOB_STATUS.RUNNING, attempts: 1 });

    const res = _res();
    await syncController._syncCancelJob({ params: { job_id: JOB_ID }, user_id: 'operator-1' }, res);
    _restore();

    assert.equal(res.sent.code, 400, 'A lost cancel must not be a 200. The service reports it as an ordinary outcome; the controller is what makes it a refusal.');
    assert.equal(res.sent.body.status, false, 'The envelope must say the operation did not happen.');
    assert.match(res.sent.body.msg, /RUNNING/, 'The wire message must carry the reason, not a generic failure.');
});

test('the controller answers 404 for an unknown job and 200 for a real cancellation', async () => {
    syncJobRepository.cancelPendingSyncJob = async () => null;
    syncJobRepository.findSyncJobById = async () => null;

    const missing = _res();
    await syncController._syncCancelJob({ params: { job_id: JOB_ID }, user_id: 'operator-1' }, missing);
    assert.equal(missing.sent.code, 404);

    syncJobRepository.cancelPendingSyncJob = async () => _jobDoc({ status: SYNC_JOB_STATUS.CANCELLED });
    const ok = _res();
    await syncController._syncCancelJob({ params: { job_id: JOB_ID }, user_id: 'operator-1' }, ok);
    _restore();

    assert.equal(ok.sent.code, 200);
    assert.equal(ok.sent.body.status, true);
    assert.equal(ok.sent.body.data.cancelled, true);
});


/* ==========================================================================
 *  2.  THE LIST'S COUNTS ARE PRE-FILTER, WITH THEIR ZEROS
 * ========================================================================== */

test(' the tally branches carry no $match — a pre-filter count that filters is not pre-filter', () => {
    const source = _source('src/modules/sync/repositories/syncJob.repository.ts');
    const facet = source.slice(source.indexOf('$facet:'), source.indexOf('const facets = rows[0]'));

    for (const branch of ['by_job_type', 'by_status', 'by_triggered_by']) {
        const line = facet.split('\n').find((row) => row.includes(`${branch}:`));
        assert.ok(line, `The ${branch} branch is missing from the counts aggregation.`);
        assert.equal(
            line.includes('$match'),
            false,
            `The ${branch} branch applies a $match, so its tally is post-filter. Every unselected value would then read 0 the `
            + 'moment one is chosen, which looks exactly like a filter that deleted the rest of the history.'
        );
    }

    const matchedLine = facet.split('\n').find((row) => row.includes('matched:'));
    assert.ok(matchedLine.includes('$match'), 'The `matched` branch must apply the filter — it is what pagination.total reports.');
});

test(' the counts are PRE-FILTER and carry a zero for every value that never occurred', async () => {
    let filterSeen = null;
    syncJobRepository.aggregateSyncJobCounts = async (filter) => {
        filterSeen = filter;
        return {
            // Filtered: only one FAILED row matches.
            total: 1,
            // Pre-filter: the whole ledger, which holds nothing but partner syncs.
            by_job_type: [{ _id: STORABLE_JOB_TYPES.PARTNER_SYNC, rows: 3 }],
            by_status: [{ _id: SYNC_JOB_STATUS.SUCCESS, rows: 2 }, { _id: SYNC_JOB_STATUS.FAILED, rows: 1 }],
            by_triggered_by: [{ _id: 'CRON', rows: 3 }]
        };
    };
    syncJobRepository.findSyncJobPage = async () => [_jobDoc({ status: SYNC_JOB_STATUS.FAILED })];

    const result = await listSyncJobs(IDENTITY, { status: SYNC_JOB_STATUS.FAILED });
    _restore();

    assert.equal(result.status, true);
    assert.deepEqual(filterSeen, { status: SYNC_JOB_STATUS.FAILED }, 'The validated filter reaches the repository verbatim.');

    //  EVERY storable job type has a key, and the three that never ran are 0 — not absent.
    assert.deepEqual(result.data.job_type_counts, {
        DUMMY: 0,
        PARTNER_SYNC: 3,
        BIGQUERY_SYNC: 0,
        INSTALL_ATTRIBUTION_SYNC: 0
    }, 'A tally that omits its empty buckets reports "100% partner syncs" instead of "three job types have never run here".');

    assert.deepEqual(result.data.status_counts, {
        PENDING: 0,
        RUNNING: 0,
        SUCCESS: 2,
        FAILED: 1,
        CANCELLED: 0
    });
    assert.deepEqual(result.data.triggered_by_counts, { MANUAL: 0, CRON: 3 });

    // The tally is unmoved by the filter; `pagination.total` is what the filter selects.
    assert.equal(result.data.job_type_counts.PARTNER_SYNC, 3, 'The pre-filter tally must not shrink to the filtered page.');
    assert.equal(result.data.pagination.total, 1, 'pagination.total is the POST-filter count — the other half of the pair.');
    assert.equal(result.data.ledger_rows, 3, 'ledger_rows is what the tallies sum to, so a reader can check the arithmetic.');
    assert.equal(result.data.ledger_state, SYNC_JOB_LEDGER_STATES.READY);
});

test('every number the table formats is a BARE NUMBER, never an envelope', async () => {
    syncJobRepository.aggregateSyncJobCounts = async () => ({
        total: 2,
        by_job_type: [{ _id: STORABLE_JOB_TYPES.DUMMY, rows: 2 }],
        by_status: [{ _id: SYNC_JOB_STATUS.SUCCESS, rows: 2 }],
        by_triggered_by: [{ _id: 'MANUAL', rows: 2 }]
    });
    syncJobRepository.findSyncJobPage = async () => [_jobDoc({ duration_ms: 1234 })];

    const result = await listSyncJobs(IDENTITY, {});
    _restore();

    const { pagination, ledger_rows, job_type_counts, items } = result.data;
    for (const [label, value] of [
        ['pagination.total', pagination.total],
        ['pagination.page', pagination.page],
        ['pagination.limit', pagination.limit],
        ['pagination.pages', pagination.pages],
        ['ledger_rows', ledger_rows],
        ['job_type_counts.DUMMY', job_type_counts.DUMMY],
        ['items[0].duration_ms', items[0].duration_ms],
        ['items[0].attempts', items[0].attempts]
    ]) {
        assert.equal(typeof value, 'number', `${label} is not a bare number. The dashboard does Number(n); an envelope is NaN, which renders as an em dash and blanks the figure.`);
    }
});

test('an EMPTY ledger is a 200 that says so — not an error and not a bare "no jobs yet"', async () => {
    syncJobRepository.aggregateSyncJobCounts = async () => ({ total: 0, by_job_type: [], by_status: [], by_triggered_by: [] });
    //  THROWS. Nothing matched, so the page read is a guaranteed-empty query and must be skipped.
    syncJobRepository.findSyncJobPage = async () => {
        throw new Error('the page read must be skipped when nothing matched');
    };

    const result = await listSyncJobs(IDENTITY, {});
    _restore();

    assert.equal(result.status, true, 'Empty results are 200s.');
    assert.deepEqual(result.data.items, []);
    assert.equal(result.data.ledger_rows, 0);
    assert.equal(result.data.pagination.pages, 0, 'Zero pages, not one — there is no page to turn to.');
    assert.equal(result.data.ledger_state, SYNC_JOB_LEDGER_STATES.EMPTY);
    assert.ok(
        result.data.warnings.some((warning) => /ever been recorded/.test(warning)),
        'An empty ledger must carry the sentence that says what the emptiness means.'
    );
});

test('a typo in a filter WIDENS the list and says so — it never empties it', async () => {
    let filterSeen = null;
    syncJobRepository.aggregateSyncJobCounts = async (filter) => {
        filterSeen = filter;
        return {
            total: 1,
            by_job_type: [{ _id: STORABLE_JOB_TYPES.PARTNER_SYNC, rows: 1 }],
            by_status: [{ _id: SYNC_JOB_STATUS.SUCCESS, rows: 1 }],
            by_triggered_by: [{ _id: 'CRON', rows: 1 }]
        };
    };
    syncJobRepository.findSyncJobPage = async () => [_jobDoc()];

    const result = await listSyncJobs(IDENTITY, { job_type: 'KEYWORD_RANKING', status: 'nonsense', triggered_by: 'ROBOT' });
    _restore();

    assert.deepEqual(filterSeen, {}, 'An unrecognised value must be DROPPED, never matched — matching it returns an empty table that reads as "nothing has ever run".');
    assert.deepEqual(result.data.filters, { job_type: [], status: [], triggered_by: [] });
    assert.equal(result.data.items.length, 1, 'The list widens rather than emptying.');
    for (const needle of ['KEYWORD_RANKING', 'nonsense', 'ROBOT']) {
        assert.ok(
            result.data.warnings.some((warning) => warning.includes(needle)),
            `The dropped value ${needle} must be named in a warning — a filter that silently does nothing is worse than a missing one.`
        );
    }
});

test('an over-large page size and a page past the end are CLAMPED, each with its own sentence', async () => {
    let pageQuery = null;
    syncJobRepository.aggregateSyncJobCounts = async () => ({
        total: 3,
        by_job_type: [{ _id: STORABLE_JOB_TYPES.PARTNER_SYNC, rows: 3 }],
        by_status: [{ _id: SYNC_JOB_STATUS.SUCCESS, rows: 3 }],
        by_triggered_by: [{ _id: 'CRON', rows: 3 }]
    });
    syncJobRepository.findSyncJobPage = async (query) => {
        pageQuery = query;
        return [_jobDoc()];
    };

    const result = await listSyncJobs(IDENTITY, { page: 9, limit: 5000 });
    _restore();

    assert.equal(result.data.pagination.limit, 100, 'The page size is clamped to the endpoint ceiling.');
    assert.equal(result.data.pagination.page, 1, 'A page past the end is clamped to the last page that exists — an empty page there would render as "no sync jobs yet" over a history that is not empty.');
    assert.equal(pageQuery.skip, 0, 'The clamped page is what is actually read.');
    assert.equal(pageQuery.limit, 100);
    assert.equal(pageQuery.sort_field, 'createdAt');
    assert.equal(pageQuery.sort_dir, -1, 'Newest first by default.');
    assert.equal(result.data.warnings.filter((warning) => /page size of 5000/.test(warning)).length, 1);
    assert.equal(result.data.warnings.filter((warning) => /^Page 9 was requested/.test(warning)).length, 1);
});

test('an unsortable column falls back to createdAt and NAMES the valid keys', async () => {
    syncJobRepository.aggregateSyncJobCounts = async () => ({
        total: 1,
        by_job_type: [{ _id: STORABLE_JOB_TYPES.PARTNER_SYNC, rows: 1 }],
        by_status: [{ _id: SYNC_JOB_STATUS.SUCCESS, rows: 1 }],
        by_triggered_by: [{ _id: 'CRON', rows: 1 }]
    });
    syncJobRepository.findSyncJobPage = async () => [_jobDoc()];

    const result = await listSyncJobs(IDENTITY, { sort: 'completed_at', dir: 'asc' });
    _restore();

    assert.equal(result.data.sort.key, 'createdAt', 'completed_at is null on every unfinished job; sorting on it ascending would put the never-completed at the top of a "completed" column.');
    assert.equal(result.data.sort.dir, 'asc', 'The direction is still honoured.');
    assert.ok(result.data.warnings.some((warning) => /completed_at/.test(warning) && /createdAt/.test(warning)));
});

test('a row from a build with a different vocabulary is COUNTED, not hidden, so the tallies reconcile', async () => {
    syncJobRepository.aggregateSyncJobCounts = async () => ({
        total: 5,
        by_job_type: [{ _id: STORABLE_JOB_TYPES.PARTNER_SYNC, rows: 3 }, { _id: 'AD_CSV_INGEST', rows: 2 }],
        by_status: [{ _id: SYNC_JOB_STATUS.SUCCESS, rows: 5 }],
        by_triggered_by: [{ _id: 'CRON', rows: 5 }]
    });
    syncJobRepository.findSyncJobPage = async () => [_jobDoc()];

    const result = await listSyncJobs(IDENTITY, {});
    _restore();

    assert.equal(result.data.job_type_counts.AD_CSV_INGEST, 2, 'An unknown job type is counted rather than dropped — a tally that discards rows is arithmetic nobody can check.');
    assert.equal(result.data.ledger_rows, 5, 'ledger_rows must still equal the sum of the tally.');
    assert.ok(result.data.warnings.some((warning) => /AD_CSV_INGEST/.test(warning)));
});

test('warnings are UNIQUE — the dashboard keys them by content, so a duplicate DROPS one', async () => {
    syncJobRepository.aggregateSyncJobCounts = async () => ({ total: 0, by_job_type: [], by_status: [], by_triggered_by: [] });
    syncJobRepository.findSyncJobPage = async () => [];

    const result = await listSyncJobs(IDENTITY, { job_type: 'NOPE', status: 'NOPE' });
    _restore();

    assert.equal(new Set(result.data.warnings).size, result.data.warnings.length, 'Two identical warning strings collide on the render key and one of them disappears, taking its condition with it.');
});


/* ==========================================================================
 *  3.  HEALTH — SIXTEEN COLLECTIONS, AND THE WATERMARK DECIDES
 * ========================================================================== */

test(' the health registry lists EXACTLY the collections this build registers — both directions', () => {
    // The model registry is the source of truth for what exists. Reading the PHYSICAL collection
    // name off each model ties the two together by the one string that cannot drift silently.
    const models = require(path.join(BACKEND_ROOT, 'src', 'models'));
    const registered = Object.values(models).map((model) => model.collection.name).sort();
    const reported = HEALTH_COLLECTIONS.map((entry) => entry.collection).sort();

    assert.equal(registered.length, 16, 'This build has sixteen collections. If that changed, the registry and this number change together.');
    assert.deepEqual(
        reported,
        registered,
        'The health screen reports a different set of collections from the ones this build registers. A collection reported but '
        + 'not registered renders as "0 rows", which is a MEASUREMENT — it sends an operator hunting for a sync that does not exist.'
    );

    const keys = HEALTH_COLLECTIONS.map((entry) => entry.key);
    assert.equal(new Set(keys).size, keys.length, 'Registry keys must be unique — a duplicate silently overwrites a collection in the row-count map.');

    // Every registry key must actually be counted by the repository, or it renders as 0 rows.
    const repositorySource = _source('src/modules/sync/repositories/syncHealth.repository.ts');
    for (const key of keys) {
        assert.ok(
            repositorySource.includes(`${key}:`),
            `syncHealth.repository does not return a count for "${key}", so that collection would report 0 rows whatever it holds.`
        );
    }
});

test(' never-synced and synced-but-empty are told apart BY THE WATERMARK, not by the row count', async () => {
    const _emptyCounts = () => {
        const counts = {};
        for (const entry of HEALTH_COLLECTIONS) {
            counts[entry.key] = 0;
        }
        counts.partner_apps = 1;
        return counts;
    };
    const _app = (overrides) => Object.assign({
        _id: 'app-1',
        app_handle: 'demo-app',
        display_name: 'Demo App',
        is_active: true,
        last_synced_at: null,
        last_bq_synced_at: null,
        last_install_attrib_synced_at: null,
        earliest_event_at: null,
        earliest_transaction_at: null,
        lifetime_sync_completed_at: null,
        shop_name_coverage_since: null,
        event_history_gap_days: null,
        charge_link_absent_pct: null,
        charge_link_unresolved_pct: null
    }, overrides || {});

    syncHealthRepository.countAllCollections = async () => _emptyCounts();
    _stubAuthFacts(false);
    syncHealthRepository.aggregateSyncJobHealth = async () => ({ last_success: [], last_run: [], by_status: [] });

    // ── Nothing has ever synced ──────────────────────────────────────────────
    syncHealthRepository.findPartnerAppHealthRows = async () => [_app()];
    const never = await getSyncHealth(IDENTITY, {});

    const _find = (payload, key) => payload.data.collections.find((entry) => entry.key === key);

    assert.equal(never.status, true, 'A health read never refuses — one that fails when things are unhealthy reports nothing at the moment it matters.');
    assert.equal(never.data.collections.length, 16);
    assert.equal(_find(never, 'partner_app_events').state, HEALTH_COLLECTION_STATES.NEVER_SYNCED);
    assert.equal(_find(never, 'partner_app_transactions').state, HEALTH_COLLECTION_STATES.NEVER_SYNCED);
    assert.match(_find(never, 'partner_app_events').reason, /we have not looked yet/);
    assert.ok(never.data.warnings.some((warning) => /No Partner API sync has ever completed/.test(warning)));

    // ── A sync ran and genuinely found nothing. SAME ZERO ROWS. ──────────────
    syncHealthRepository.findPartnerAppHealthRows = async () => [_app({ last_synced_at: new Date('2026-02-01T03:00:00.000Z') })];
    const measured = await getSyncHealth(IDENTITY, {});
    _restore();

    assert.equal(_find(measured, 'partner_app_events').rows, 0, 'The row count is identical in both scenarios — which is exactly why it cannot be the discriminator.');
    assert.equal(
        _find(measured, 'partner_app_events').state,
        HEALTH_COLLECTION_STATES.EMPTY,
        'A set watermark over zero rows is a MEASURED zero. Reporting it as NEVER_SYNCED turns a quiet week into an outage.'
    );
    assert.match(_find(measured, 'partner_app_events').reason, /measured zero, not a gap/);
    assert.equal(_find(measured, 'partner_app_events').watermark_at, '2026-02-01T03:00:00.000Z');
    assert.equal(
        measured.data.warnings.some((warning) => /No Partner API sync has ever completed/.test(warning)),
        false,
        'The never-synced warning must not fire once a sync has completed.'
    );
});

test('the OPTIONAL listing tier reports NOT_CONNECTED, never NEVER_SYNCED — absent is not broken', async () => {
    const counts = {};
    for (const entry of HEALTH_COLLECTIONS) {
        counts[entry.key] = 0;
    }
    counts.partner_apps = 1;

    syncHealthRepository.countAllCollections = async () => counts;
    _stubAuthFacts(false);
    syncHealthRepository.findPartnerAppHealthRows = async () => [];
    syncHealthRepository.aggregateSyncJobHealth = async () => ({ last_success: [], last_run: [], by_status: [] });

    const result = await getSyncHealth(IDENTITY, {});
    _restore();

    assert.equal(result.data.listing_tier_connected, false);
    for (const entry of result.data.collections) {
        if (entry.tier === HEALTH_COLLECTION_TIERS.LISTING) {
            assert.equal(
                entry.state,
                HEALTH_COLLECTION_STATES.NOT_CONNECTED,
                `${entry.key} reports ${entry.state}. BigQuery is optional — describing a deliberate choice as a fault sends an operator to fix nothing.`
            );
        }
    }
    assert.ok(result.data.warnings.some((warning) => /ordinary state/.test(warning)));
});

test(' a locked install whose owner row is gone raises ONE warning naming the repair command (spec A18)', async () => {
    const counts = {};
    for (const entry of HEALTH_COLLECTIONS) {
        counts[entry.key] = 0;
    }
    counts.partner_apps = 1;
    // Zero legacy operator rows and zero users: the retired "no operator account" advice (which told
    // the reader to set ADMIN_*) must not come back through either count.
    counts.admin_users = 0;
    counts.users = 0;

    syncHealthRepository.countAllCollections = async () => counts;
    syncHealthRepository.findPartnerAppHealthRows = async () => [];
    syncHealthRepository.aggregateSyncJobHealth = async () => ({ last_success: [], last_run: [], by_status: [] });

    _stubAuthFacts(true);
    const missing = await getSyncHealth(IDENTITY, {});
    _stubAuthFacts(false);
    const present = await getSyncHealth(IDENTITY, {});
    _restore();

    const ownerWarnings = missing.data.warnings.filter((warning) => /owner account is missing/.test(warning));
    assert.equal(ownerWarnings.length, 1, 'owner_missing must raise exactly one warning.');
    assert.match(ownerWarnings[0], /npm run auth:admin:dist -- repair-owner/, 'The warning must name the recovery command — setup never reopens.');
    assert.equal(
        present.data.warnings.some((warning) => /owner account is missing/.test(warning)),
        false,
        'The owner warning fired while the owner row exists.'
    );
    for (const result of [missing, present]) {
        assert.equal(
            result.data.warnings.some((warning) => /ADMIN_EMAIL|ADMIN_PASSWORD/.test(warning)),
            false,
            'A health warning still advises ADMIN_* — those variables are ignored by this build.'
        );
    }
});

test(' a job type that has never run is a NULL key, never an absent one', async () => {
    const counts = {};
    for (const entry of HEALTH_COLLECTIONS) {
        counts[entry.key] = 0;
    }
    counts.partner_apps = 1;
    counts.sync_jobs = 2;

    syncHealthRepository.countAllCollections = async () => counts;
    _stubAuthFacts(false);
    syncHealthRepository.findPartnerAppHealthRows = async () => [];
    syncHealthRepository.aggregateSyncJobHealth = async () => ({
        last_success: [{
            _id: STORABLE_JOB_TYPES.PARTNER_SYNC,
            doc: _jobDoc({
                status: SYNC_JOB_STATUS.SUCCESS,
                completed_at: new Date('2026-02-01T03:04:00.000Z'),
                duration_ms: 4200,
                attempts: 1
            })
        }],
        last_run: [{
            _id: STORABLE_JOB_TYPES.PARTNER_SYNC,
            doc: _jobDoc({
                status: SYNC_JOB_STATUS.FAILED,
                failure_reason: 'STUCK_TIMEOUT',
                error_message: 'Job was RUNNING for more than 1800s',
                completed_at: new Date('2026-02-02T03:04:00.000Z'),
                attempts: 1
            })
        }],
        by_status: [{ _id: SYNC_JOB_STATUS.SUCCESS, rows: 1 }, { _id: SYNC_JOB_STATUS.FAILED, rows: 1 }]
    });

    const result = await getSyncHealth(IDENTITY, {});
    _restore();

    //  The dashboard's sync registry keys its cards on these literals. An ABSENT key makes a card
    // fall back to "Never completed successfully" over a job that runs nightly.
    for (const jobType of Object.values(STORABLE_JOB_TYPES)) {
        assert.ok(jobType in result.data.last_success_per_type, `last_success_per_type is missing the key ${jobType}.`);
        assert.ok(jobType in result.data.last_run_per_type, `last_run_per_type is missing the key ${jobType}.`);
    }
    assert.equal(result.data.last_success_per_type.BIGQUERY_SYNC, null, 'A job type that has never succeeded is an explicit null.');
    assert.equal(result.data.last_success_per_type.PARTNER_SYNC.completed_at, '2026-02-01T03:04:00.000Z');
    assert.equal(typeof result.data.last_success_per_type.PARTNER_SYNC.duration_ms, 'number');

    //  The pair is the point: the last SUCCESS is older than the last RUN, which failed. On the
    // success block alone this deployment looks fine.
    assert.equal(result.data.last_run_per_type.PARTNER_SYNC.status, SYNC_JOB_STATUS.FAILED);
    assert.ok(result.data.warnings.some((warning) => /most recent PARTNER_SYNC run FAILED/.test(warning)));
    assert.ok(
        result.data.warnings.some((warning) => /NOT safe to/.test(warning)),
        'A STUCK_TIMEOUT is the one failure that must not be re-run blindly, and it needs its own sentence because the ACTION differs.'
    );

    assert.deepEqual(result.data.job_status_counts, { PENDING: 0, RUNNING: 0, SUCCESS: 1, FAILED: 1, CANCELLED: 0 });
});

test(' a PENDING-swept job is NOT reported as "died mid-run" — nothing ran, so re-running is the fix', async () => {
    const counts = {};
    for (const entry of HEALTH_COLLECTIONS) {
        counts[entry.key] = 0;
    }
    counts.partner_apps = 1;
    counts.sync_jobs = 1;

    syncHealthRepository.countAllCollections = async () => counts;
    _stubAuthFacts(false);
    syncHealthRepository.findPartnerAppHealthRows = async () => [];
    syncHealthRepository.aggregateSyncJobHealth = async () => ({
        last_success: [],
        last_run: [{
            _id: STORABLE_JOB_TYPES.BIGQUERY_SYNC,
            doc: _jobDoc({
                job_type: STORABLE_JOB_TYPES.BIGQUERY_SYNC,
                status: SYNC_JOB_STATUS.FAILED,
                //  THE SAME REASON CODE THE RUNNING SWEEP WRITES. `failStaleJobs` stamps
                // STUCK_TIMEOUT for both sweeps, which is exactly why the reason alone cannot decide
                // the sentence.
                failure_reason: 'STUCK_TIMEOUT',
                error_message: 'Job sat PENDING for more than 3600s and was never claimed',
                // Never claimed: `claimPendingJob` is the only writer of both of these, in one
                // conditional update, so this pair is the evidence that no handler ever opened it.
                started_at: null,
                attempts: 0,
                completed_at: new Date('2026-02-02T03:04:00.000Z')
            })
        }],
        by_status: [{ _id: SYNC_JOB_STATUS.FAILED, rows: 1 }]
    });

    const result = await getSyncHealth(IDENTITY, {});
    _restore();

    const warnings = result.data.warnings;

    // The screen an operator opens DURING an outage must not talk them out of the one action that
    // clears it. A queued job that was starved out wrote nothing at all.
    assert.ok(
        !warnings.some((warning) => /NOT safe to/.test(warning)),
        'A job that never started cannot have written a partial result, so the "not safe to re-run blindly" sentence is false '
        + 'for it — and it is the sentence that stops the operator re-running the job.'
    );
    assert.ok(
        !warnings.some((warning) => /died mid-run/.test(warning)),
        'Nothing held this job: it was swept out of PENDING, so no process died with it.'
    );
    assert.ok(
        warnings.some((warning) => /WITHOUT EVER STARTING/.test(warning)),
        'The PENDING sweep needs its own sentence — the reason code is shared with the RUNNING sweep and the ACTION is opposite.'
    );
    assert.ok(
        warnings.some((warning) => /safe and is the right thing to do/.test(warning)),
        'Re-running a job that never ran is the correct remedy, and the health screen has to say so.'
    );
    // Both possibilities are named because the row cannot separate them: the PENDING sweep matches
    // on createdAt, so a starved queue and a dead runner leave identical evidence.
    assert.ok(
        warnings.some((warning) => /MAX_CONCURRENT_JOBS/.test(warning)),
        'A single long run starves the queue at the default concurrency of 1, and that is indistinguishable from a dead runner.'
    );

    // The generic "last run FAILED" sentence still fires; the sweep sentence is IN ADDITION to it.
    assert.ok(warnings.some((warning) => /most recent BIGQUERY_SYNC run FAILED/.test(warning)));

    // The distinguishing fields are published, so a reader can check the verdict rather than trust it.
    assert.equal(result.data.last_run_per_type.BIGQUERY_SYNC.started_at, null);
    assert.equal(result.data.last_run_per_type.BIGQUERY_SYNC.attempts, 0);
});

test('the coverage gates travel as BARE values, and a measured 0 survives as 0', async () => {
    const counts = {};
    for (const entry of HEALTH_COLLECTIONS) {
        counts[entry.key] = 1;
    }

    syncHealthRepository.countAllCollections = async () => counts;
    _stubAuthFacts(false);
    syncHealthRepository.findPartnerAppHealthRows = async () => [{
        _id: 'app-1',
        app_handle: 'demo-app',
        display_name: 'Demo App',
        is_active: true,
        last_synced_at: new Date('2026-02-01T03:00:00.000Z'),
        last_bq_synced_at: null,
        last_install_attrib_synced_at: null,
        earliest_event_at: new Date('2025-01-01T00:00:00.000Z'),
        earliest_transaction_at: null,
        lifetime_sync_completed_at: null,
        shop_name_coverage_since: null,
        //  0 is the REASSURING value on both of these: no day-wide hole in the history, and every
        // charge-bearing row linked. `|| null` would rewrite the measurement as "never measured".
        event_history_gap_days: 0,
        charge_link_absent_pct: 0,
        charge_link_unresolved_pct: null
    }];
    syncHealthRepository.aggregateSyncJobHealth = async () => ({ last_success: [], last_run: [], by_status: [] });

    const result = await getSyncHealth(IDENTITY, {});
    _restore();

    const app = result.data.apps[0];
    assert.equal(app.coverage.event_history_gap_days, 0, 'A measured 0 must not be rewritten as null — it asserts the history has no day-wide holes at all.');
    assert.equal(app.coverage.charge_link_absent_pct, 0);
    assert.equal(app.coverage.charge_link_unresolved_pct, null, 'null still means NEVER MEASURED, and is not the same as 0.');
    assert.equal(app.coverage.earliest_event_at, '2025-01-01T00:00:00.000Z');
    assert.equal(app.coverage.earliest_transaction_at, null);
    assert.equal(app.last_synced_at, '2026-02-01T03:00:00.000Z');
});

test(' schedule state is OBSERVED from live timers, not inferred from config', () => {
    const schedules = describeSchedules();

    assert.equal(schedules.length, 3, 'Every known schedule is reported, armed or not — a registry-only listing would report nothing on the deployment that stopped syncing.');
    for (const schedule of schedules) {
        // Nothing armed a timer in this test process, and the answer says so rather than computing
        // a next-fire time from the expression and implying a run that is not going to happen.
        assert.equal(schedule.scheduled, false);
        assert.equal(schedule.next_fire_at, null, 'An unarmed schedule has NO next fire time. Reporting one would promise a sync nothing is going to run.');
        assert.equal(typeof schedule.expression, 'string');
        assert.notEqual(schedule.expression, '');
    }
    assert.deepEqual(
        schedules.map((schedule) => schedule.label).sort(),
        ['BIGQUERY_SYNC', 'INSTALL_ATTRIBUTION_SYNC', 'PARTNER_SYNC']
    );
});


/* ==========================================================================
 *  4. THE PURE STATE RESOLVER — every empty case, from literals
 * ========================================================================== */

test('resolveCollectionState separates the four ways of being empty', () => {
    const base = {
        rows: 0,
        tier: HEALTH_COLLECTION_TIERS.PARTNER,
        label: 'Partner events',
        watermark_field: 'last_synced_at',
        watermark_at: null,
        listing_tier_connected: true
    };

    assert.equal(resolveCollectionState(base).state, HEALTH_COLLECTION_STATES.NEVER_SYNCED);
    assert.equal(
        resolveCollectionState({ ...base, watermark_at: '2026-02-01T03:00:00.000Z' }).state,
        HEALTH_COLLECTION_STATES.EMPTY
    );
    assert.equal(resolveCollectionState({ ...base, rows: 12 }).state, HEALTH_COLLECTION_STATES.READY);
    assert.equal(
        resolveCollectionState({ ...base, tier: HEALTH_COLLECTION_TIERS.CONFIG, watermark_field: '' }).state,
        HEALTH_COLLECTION_STATES.NOT_CONFIGURED
    );
    assert.equal(
        resolveCollectionState({ ...base, tier: HEALTH_COLLECTION_TIERS.SYSTEM, watermark_field: '' }).state,
        HEALTH_COLLECTION_STATES.EMPTY,
        'The job ledger is written by this process itself, so its emptiness is a measurement rather than a gap.'
    );
});

test(' an unconfigured listing tier wins over every other reading of the same zero', () => {
    const listing = {
        rows: 0,
        tier: HEALTH_COLLECTION_TIERS.LISTING,
        label: 'Listing daily rollup',
        watermark_field: 'last_bq_synced_at',
        watermark_at: null,
        listing_tier_connected: false
    };

    const verdict = resolveCollectionState(listing);
    assert.equal(verdict.state, HEALTH_COLLECTION_STATES.NOT_CONNECTED);
    assert.match(verdict.reason, /BigQuery is optional/);

    // Stale rows from when the tier WAS configured: still NOT_CONNECTED, and the reason changes to
    // say the rows are real and nothing is refreshing them.
    const stale = resolveCollectionState({ ...listing, rows: 400 });
    assert.equal(stale.state, HEALTH_COLLECTION_STATES.NOT_CONNECTED);
    assert.match(stale.reason, /nothing is refreshing them/);

    // Connected and empty with no watermark is the ordinary never-synced reading.
    assert.equal(
        resolveCollectionState({ ...listing, listing_tier_connected: true }).state,
        HEALTH_COLLECTION_STATES.NEVER_SYNCED
    );
});

test('every state carries a reason — a token a screen colours is not something an operator can act on', () => {
    for (const tier of Object.values(HEALTH_COLLECTION_TIERS)) {
        for (const rows of [0, 7]) {
            for (const watermark of [null, '2026-02-01T03:00:00.000Z']) {
                for (const connected of [true, false]) {
                    const verdict = resolveCollectionState({
                        rows: rows,
                        tier: tier,
                        label: 'A collection',
                        watermark_field: 'last_synced_at',
                        watermark_at: watermark,
                        listing_tier_connected: connected
                    });
                    assert.ok(Object.values(HEALTH_COLLECTION_STATES).includes(verdict.state), `Unknown state ${verdict.state}.`);
                    assert.equal(typeof verdict.reason, 'string');
                    assert.notEqual(verdict.reason.trim(), '', `${tier}/${rows}/${watermark}/${connected} produced a state with no reason.`);
                }
            }
        }
    }
});


/* ==========================================================================
 *  5. ONE SERIALIZER, SHARED
 * ========================================================================== */

test(' there is exactly ONE definition of a job row, and every sync endpoint uses it', () => {
    const helperSource = _source('src/modules/sync/helpers/syncJobRow.helper.ts');
    assert.ok(helperSource.includes('const serializeSyncJob ='), 'The shared serializer must live in the pure helper.');

    // Nothing else may define one. Three copies of a serializer do not fail loudly — they DRIFT,
    // and the drift renders as a dash on the sync screen for a job that ran perfectly well.
    for (const dir of ['services', 'resolvers']) {
        const full = path.join(SYNC_ROOT, dir);
        if (!fs.existsSync(full)) {
            continue;
        }
        for (const file of fs.readdirSync(full)) {
            const text = fs.readFileSync(path.join(full, file), 'utf8');
            assert.equal(
                /const\s+_?serialize(Sync)?Job\s*=/.test(text),
                false,
                `${dir}/${file} defines its own job serializer. There must be exactly one, in helpers/syncJobRow.helper.`
            );
        }
    }

    // The helper is PURE: it must not reach a model, a repository, a config or a clock. A
    // serializer that read the clock would stamp a row with the instant it was RENDERED, which is
    // indistinguishable on screen from the instant the job actually finished.
    for (const forbidden of ['models', 'repositories', 'config']) {
        assert.equal(
            helperSource.includes(`require('${forbidden}`) || helperSource.includes(`/${forbidden}')`),
            false,
            `helpers/syncJobRow.helper imports ${forbidden}. Helpers are pure: no I/O, no models, no config.`
        );
    }
    //  Comments are stripped first: the helper's own JSDoc explains why it does NOT convert dates,
    // and matching that sentence would fail a perfectly pure file.
    const helperCode = stripComments(helperSource);
    for (const clock of ['Date.now(', 'new Date(']) {
        assert.equal(
            helperCode.includes(clock),
            false,
            `helpers/syncJobRow.helper reads the clock (${clock}). Pass the instant in — a helper that reads a clock cannot be tested without controlling one.`
        );
    }
});
