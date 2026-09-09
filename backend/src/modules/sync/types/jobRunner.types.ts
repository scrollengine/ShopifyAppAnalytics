/**
 * Shapes for the polling job runner.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 */

import type { IdentityObject, ServiceResult } from '../../../types/service.types';

/**
 * The contract every job handler satisfies.
 *
 * Identical to the project's service signature — `(identity, params)` resolving an envelope — so a
 * handler is an ordinary service and needs no adapter. The runner supplies the worker identity and
 * the job's own `payload`, with `sync_job_id` merged in.
 *
 * ⚠️ A handler must RESOLVE `status: false` rather than throw. The runner catches a throw anyway and
 * converts it, because a handler that takes the runner down stops every other job too — but a
 * caught throw loses the structured `msg` an operator reads on the sync screen.
 */
export type SyncJobHandler = (identity: IdentityObject, params: Record<string, any>) => Promise<ServiceResult>;

/** What `registerJobHandler` reports. */
export interface RegisterHandlerPayload {
    job_type: string;
    /** True when this registration REPLACED an existing handler for the same type. */
    replaced: boolean;
    /** Every job type that now has a handler, sorted — so a boot log states the whole dispatch table. */
    registered_types: string[];
}

/** What `startJobRunner` reports. */
export interface RunnerStartPayload {
    /** False when `config.SYNC.DISABLED` is set — the runner is up but deliberately claiming nothing. */
    started: boolean;
    poll_interval_ms: number;
    max_concurrent_jobs: number;
    max_attempts: number;
    registered_types: string[];
}

/** What `stopJobRunner` reports. */
export interface RunnerStopPayload {
    /** True when every in-flight handler finished inside the drain window. */
    drained: boolean;
    /** Handlers still running when the drain window expired. Non-zero means jobs were abandoned. */
    in_flight_at_exit: number;
    drain_waited_ms: number;
}

/** What one dispatched job reports internally. Not a public surface; it is what the runner logs. */
export interface RunJobPayload {
    job_id: string;
    /** False when the claim was lost to another runner — a normal, silent outcome. */
    claimed: boolean;
    job_type: string | null;
    /** Present only once the handler has actually run. */
    succeeded: boolean | null;
}
