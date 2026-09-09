import { Schema, model } from 'mongoose';
// `export =` module — a named import here is TS2497, so it is imported whole and destructured.
import syncJobVocab = require('../../constants/syncJob.constants');

const { SYNC_JOB_TYPES, SYNC_JOB_STATUS, SYNC_JOB_TRIGGERED_BY } = syncJobVocab;

/**
 * One background run — enqueued, claimed, and recorded.
 *
 *  THIS COLLECTION *IS* THE QUEUE, not a log of one. The system this was extracted from pushed
 * jobs onto a message broker and kept these rows only as an audit trail; a self-hostable build has
 * no broker, so the runner polls this collection instead: it claims the oldest PENDING row with a
 * conditional update to RUNNING, runs the handler, and writes the outcome back. That conditional
 * claim is what makes two runners safe — whichever update matches first owns the job, and the other
 * matches nothing.
 *
 * The broker's message id is therefore gone from this schema; `started_at` is the claim marker that
 * replaced it.
 */

const _modelName = 'gi_sync_job';
const _collectionName = 'gi_sync_jobs';

const syncJobSchema = new Schema(
    {
        /**
         * The partner app this job ran for — a first-class, INDEXED join key.
         *
         * It is also written into `payload`, because every handler destructures it from there and
         * that contract must not change. It is promoted out to here because Mongo cannot usefully
         * index a path inside a Mixed blob, so "which jobs ran for app X" — the question every sync
         * screen actually asks — was a full collection scan over untyped data.
         *
         * OPTIONAL on purpose: some job types are genuinely app-less (DUMMY carries no payload at
         * all, and any future global job would be the same). `required: true` would reject those
         * inserts.
         *
         * NO `default`, so an app-less job OMITS the field rather than storing an explicit `null`.
         * That keeps one fact — "not app-scoped" — in one stored representation, and it keeps a
         * partial index possible later: `{ $exists: true }` MATCHES an explicit null, so a
         * `default: null` here would silently defeat any future partial filter. Reads must
         * therefore tolerate the field's absence.
         */
        partner_app_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_partner_app'
        },
        /**
         * No field-level `index: true`: `job_type_1` would be a STRICT PREFIX of the
         * { job_type: 1, status: 1, createdAt: -1 } compound below, which serves every read
         * filtering on job type alone just as well.
         */
        job_type: {
            type: String,
            enum: Object.values(SYNC_JOB_TYPES),
            required: true
        },
        /** Handler input. Mixed because each job type takes a different shape. */
        payload: {
            type: Schema.Types.Mixed,
            default: {}
        },
        /**
         * No field-level `index: true`: `status_1` would be a STRICT PREFIX of BOTH the
         * { status: 1, createdAt: -1 } and { status: 1, started_at: 1 } compounds below — the claim
         * query and the stuck-job sweep respectively — so it would duplicate two indexes at once.
         */
        status: {
            type: String,
            enum: Object.values(SYNC_JOB_STATUS),
            default: SYNC_JOB_STATUS.PENDING
        },
        triggered_by: {
            type: String,
            enum: Object.values(SYNC_JOB_TRIGGERED_BY),
            required: true
        },
        /** Which admin pressed the button, on a MANUAL run. Empty for CRON. */
        triggered_by_user_id: {
            type: String,
            default: ''
        },
        /** Set by the claim. Its presence is what marks a row as owned by a running handler. */
        started_at: {
            type: Date,
            default: null
        },
        completed_at: {
            type: Date,
            default: null
        },
        duration_ms: {
            type: Number,
            default: null
        },
        error_message: {
            type: String,
            default: ''
        },
        /** Truncated by the failure writer — an unbounded stack is the one field that can bloat. */
        error_stack: {
            type: String,
            default: ''
        },
        /**
         * One of `SYNC_JOB_FAILURE_REASONS`, but stored as a free String with no `enum` gate on
         * purpose: a reason the current build does not know about must still be RECORDABLE. An enum
         * here would throw at write time on the failure path — losing the record of the failure
         * itself, which is the worst possible moment to be strict.
         */
        failure_reason: {
            type: String,
            default: ''
        },
        /** What the handler actually did — rows written, windows covered. Read by the sync screen. */
        result_summary: {
            type: Schema.Types.Mixed,
            default: {}
        },
        attempts: {
            type: Number,
            default: 0
        }
    },
    {
        timestamps: true
    }
);

// THE CLAIM INDEX. The runner's poll is
// `findOneAndUpdate({ status: PENDING }, { $set: { status: RUNNING, started_at } },
//                   { sort: { createdAt: 1 }, returnDocument: 'after' })`
// — oldest first, so a backlog drains in order. The compound is declared -1 to match the list read
// that also uses it; a trailing key can be walked in either direction, so the ascending claim sort
// is served by the same index.
//
// ⚠️ Mongoose 9: `returnDocument: 'after'`, never `new: true`. The old option still works but emits
// a deprecation warning on EVERY call, and the claim is the hottest write in the application.
syncJobSchema.index({ status: 1, createdAt: -1 }, { name: 'idx_status_created' });

// The filtered job list on the sync screen.
syncJobSchema.index({ job_type: 1, status: 1, createdAt: -1 }, { name: 'idx_type_status_created' });

// The stuck-job sweep: RUNNING rows whose `started_at` is older than any legitimate run. Ascending
// on `started_at` so the oldest — the ones that matter — come first.
syncJobSchema.index({ status: 1, started_at: 1 }, { name: 'idx_status_started' });

// The per-app ledger: `find({ partner_app_id }).sort({ createdAt: -1 })` — "which jobs ran for app
// X, newest first".
//
// WHY `createdAt` is the second key rather than `job_type` or `status`: every list read sorts by
// `createdAt` desc and its type/status filters are all OPTIONAL. With the sort key immediately
// after `partner_app_id`, the app-only query walks the index in sort order and stops at the page
// limit, and adding an optional filter degrades only to a residual predicate over an
// already-ordered scan. Putting `job_type` in between would leave a gap in the key pattern for the
// app-only query and give it a blocking in-memory SORT.
//
// NOT partial: app-less jobs all index under the single `null` key, which costs nothing at this
// collection's size, and a plain index is usable by the planner unconditionally — a
// `{ $exists: true }` partial is only used when the planner can prove the query implies the filter,
// which is an easy way to build an index that is silently never used.
syncJobSchema.index({ partner_app_id: 1, createdAt: -1 }, { name: 'idx_partner_app_created' });

/**
 * RETENTION — deliberately NONE. There is no TTL on this collection, and this comment is the record
 * of that being a decision rather than an oversight.
 *
 * ⚠️ Do not add a TTL here without deliberate sign-off. This is the durable audit ledger of every
 * background run the application has ever made, and since the rows ARE the queue there is no broker
 * holding a second copy: a row that expires takes the only evidence that a sync happened — or
 * failed — with it. Silently expiring an audit ledger is worse than an unbounded one.
 *
 * Growth is bounded and slow: a handful of rows per app per day. If retention is ever genuinely
 * needed, archive rather than expire; and if a TTL is still wanted, scope it with a
 * `partialFilterExpression` to `status: SUCCESS` and give it a long window, so the FAILED and
 * CANCELLED rows — the ones anyone ever goes looking for — survive.
 */

const SyncJob = model(_modelName, syncJobSchema, _collectionName);

export = { SyncJob };
