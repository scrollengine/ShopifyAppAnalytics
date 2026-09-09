/**
 * Input and payload shapes for the sync-job lifecycle service and its repository.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 *
 * ⚠️ Every `job_type` / `status` / `triggered_by` / `failure_reason` here is typed `string`, not the
 * matching literal union from `../constants/sync.constants`. That is deliberate. These values
 * arrive off an HTTP request or are read back off a persisted document, and the service validates
 * them against `Object.values(...)` at run time. Declaring the narrow union would describe what a
 * well-behaved caller sends rather than what the guard actually has to receive — and it would make
 * the guard itself look like dead code to a reader, which is how guards get deleted.
 */

/** The API shape of a `gi_sync_job` row — what `helpers/syncJobRow.helper` produces and every endpoint returns. */
export interface SerializedSyncJob {
    /** The document `_id`, stringified. */
    job_id: string;
    job_type: string;
    /** The partner app the job runs for, stringified, or `null` when the job is app-less. */
    partner_app_id: string | null;
    payload: Record<string, any>;
    status: string;
    triggered_by: string;
    triggered_by_user_id: string;
    started_at: Date | null;
    completed_at: Date | null;
    duration_ms: number | null;
    error_message: string;
    error_stack: string;
    failure_reason: string;
    result_summary: Record<string, any>;
    /** How many times the job has been CLAIMED. 1 on a first run; higher after a retry. */
    attempts: number;
    createdAt: Date | null;
    updatedAt: Date | null;
}

/** The parameters object for `createSyncJob`. */
export interface CreateSyncJobInput {
    /** One of the RUNNABLE `SYNC_JOB_TYPES`. Refused at run time if it is not. */
    job_type?: string;
    /** Job-specific input, handed to the handler unchanged. */
    payload?: Record<string, any>;
    /** One of `SYNC_JOB_TRIGGERED_BY`. Anything else — absent included — falls back to `MANUAL`. */
    triggered_by?: string;
}

/** The parameters object for `cancelSyncJob` and `markJobRunning`. */
export interface SyncJobIdInput {
    /** Mongo `_id` of the `gi_sync_job` row, as a 24-character hex string. */
    job_id?: string;
}

/** The parameters object for `markJobSuccess`. */
export interface MarkJobSuccessInput {
    job_id?: string;
    /** What the handler did — rows written, windows covered. Stored verbatim on the row. */
    result_summary?: Record<string, any>;
}

/** The parameters object for `markJobFailed`. */
export interface MarkJobFailedInput {
    job_id?: string;
    error_message?: string;
    /** Truncated to `ERROR_STACK_MAX_CHARS` before it is stored. */
    error_stack?: string;
    /** One of `SYNC_JOB_FAILURE_REASONS`; defaults to `HANDLER_ERROR`. */
    failure_reason?: string;
}

/**
 * The (empty) parameters object of `markStuckJobsAsFailed`.
 *
 * It still TAKES a second argument: it destructures one, so calling it with a single argument
 * throws — keeping every service in this codebase to the same two-parameter shape rather than
 * making the caller remember which ones are exceptions.
 */
export type NoDomainParamsInput = Record<string, never>;

/** The success payload of `createSyncJob`, `getSyncJobStatus`, `markJobSuccess` and `markJobFailed`. */
export interface SyncJobPayload {
    job: SerializedSyncJob | null;
}

/**
 * The payload of `markJobRunning` — the CLAIM.
 *
 *  `status: true` does NOT mean the job is yours. The claim can legitimately fail: another runner
 * won the race, or the row moved out of PENDING between the poll and the update. That is a normal
 * outcome, not an error, so it resolves `status: true` with `claimed: false` — and a caller that
 * branches on `status` alone will execute a job it does not own. `claimed` is the gate.
 */
export interface ClaimJobPayload {
    /** True only when this call is the one that transitioned the row. */
    claimed: boolean;
    /** The claimed row, present only when `claimed` is true. */
    job: SerializedSyncJob | null;
    /** On a lost claim, the status the row is actually in — for the log line that explains the skip. */
    current_status: string | null;
}

/**
 * The payload of `cancelSyncJob` — the CANCEL, which races the CLAIM and can lose.
 *
 *  `status: true` DOES NOT MEAN THE JOB WAS CANCELLED. The cancel is a conditional write against
 * `status: PENDING`, exactly like the claim, so the runner getting there first is an ordinary
 * outcome rather than an error — it resolves `status: true` with `cancelled: false`. A caller that
 * branches on `status` alone will tell an operator a running sync was stopped when it was not.
 * `cancelled` is the gate. Same contract, and same reasoning, as {@link ClaimJobPayload}.
 */
export interface CancelJobPayload {
    /** True only when THIS call moved the row from PENDING to CANCELLED. */
    cancelled: boolean;
    /** The row as it stands: the cancelled document, or — on a lost cancel — the row that refused. */
    job: SerializedSyncJob | null;
    /** The row's status after the attempt. `CANCELLED` on a win; whatever refused on a loss. */
    current_status: string | null;
    /**
     * An operator-facing sentence explaining a refusal, or `''` when the cancel succeeded.
     *
     * Populated rather than left to the caller because the three refusals mean different things and
     * need different actions: a RUNNING job must be waited out, a terminal job never had anything to
     * cancel. A single message covering both taught nobody anything.
     */
    reason: string;
}

/** The success payload of `markStuckJobsAsFailed`. */
export interface StuckJobSweepPayload {
    /** `swept_running + swept_pending`. */
    swept_count: number;
    /** Rows that were RUNNING past `config.SYNC.STUCK_RUNNING_MS` — a handler that died mid-flight. */
    swept_running: number;
    /** Rows that were PENDING past `config.SYNC.STUCK_PENDING_MS` — nothing is claiming work at all. */
    swept_pending: number;
}

// ── Repository shapes ───────────────────────────────────────────────────────

/** The document `insertSyncJob` writes. Everything else on the row comes from schema defaults. */
export interface NewSyncJobFields {
    job_type: string;
    /** OMITTED, never null, when the job is app-less — see the field comment on the schema. */
    partner_app_id?: string;
    payload: Record<string, any>;
    status: string;
    triggered_by: string;
    triggered_by_user_id: string;
}

/**
 * What a conditional write reports back.
 *
 * Both counts are carried because they mean different things: `matchedCount: 0` is "the row was not
 * in the state I required", while `matchedCount: 1, modifiedCount: 0` would be "it was, but nothing
 * changed". The claim can only ever produce the first case (its `$inc` guarantees a modification on
 * any match), and keeping both numbers visible is what makes that provable at the call site rather
 * than assumed.
 */
export interface ConditionalWriteResult {
    matchedCount: number;
    modifiedCount: number;
}

/** The `$set` a terminal transition applies. */
export interface TerminalJobFields {
    status: string;
    completed_at: Date | null;
    duration_ms: number | null;
    result_summary?: Record<string, any>;
    error_message?: string;
    error_stack?: string;
    failure_reason?: string;
}

/** The `$set` that returns a failed-but-retryable job to the claimable pool. */
export interface RetryJobFields {
    status: string;
    started_at: null;
    completed_at: null;
    duration_ms: number | null;
    /** KEPT, not cleared: a PENDING row that says why its last attempt failed is a better row. */
    error_message: string;
    error_stack: string;
    failure_reason: string;
}
