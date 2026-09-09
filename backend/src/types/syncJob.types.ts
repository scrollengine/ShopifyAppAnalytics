/**
 * The value unions of `../constants/syncJob.constants`.
 *
 * Declarations only, for the same reason as `partnerVocab.types`: the constants module ends in an
 * export assignment and so cannot export types alongside its values (TS2309). `typeof import(…)` is
 * erased at compile time, so this file has no run-time cost and pulls nothing in.
 */

type SyncJobModule = typeof import('../constants/syncJob.constants');

/** A job kind the runner knows how to execute. */
export type SyncJobType = SyncJobModule['SYNC_JOB_TYPES'][keyof SyncJobModule['SYNC_JOB_TYPES']];

/** Lifecycle state of a sync-job row. */
export type SyncJobStatus = SyncJobModule['SYNC_JOB_STATUS'][keyof SyncJobModule['SYNC_JOB_STATUS']];

/** Who asked for the job — an operator, or the schedule. */
export type SyncJobTriggeredBy = SyncJobModule['SYNC_JOB_TRIGGERED_BY'][keyof SyncJobModule['SYNC_JOB_TRIGGERED_BY']];

/** Why a job ended up FAILED. Distinguishes a handler throw from a sweeper timeout. */
export type SyncJobFailureReason = SyncJobModule['SYNC_JOB_FAILURE_REASONS'][keyof SyncJobModule['SYNC_JOB_FAILURE_REASONS']];
