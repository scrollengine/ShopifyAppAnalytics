/**
 * Input and payload shapes for the DUMMY smoke-path handler.
 *
 * Declarations only — no runtime imports, so importing this file costs nothing at run time.
 */

/**
 * The parameters object for `runDummyJob`.
 *
 * Every field is optional: this arrives as a job row's stored `payload`, which is JSON some caller
 * composed, not a shape this module controls.
 */
export interface DummyJobInput {
    /** Milliseconds to sleep. Anything non-finite or <= 0 falls back to `DEFAULT_DUMMY_SLEEP_MS`. */
    sleep_ms?: number;
}

/** The success payload of `runDummyJob`, stored verbatim as the job's `result_summary`. */
export interface DummyJobResult {
    /** Always true — the marker that tells an operator this row came from the smoke handler. */
    dummy: boolean;
    slept_ms: number;
    /** ISO-8601 instant the sleep began. */
    started_at: string;
    /** ISO-8601 instant the sleep finished. */
    completed_at: string;
}
