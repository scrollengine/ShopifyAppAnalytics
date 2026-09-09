'use strict';

/**
 * ============================================================================
 *  promiseReturnResult — the service response envelope
 * ============================================================================
 *
 *  Every service in this codebase resolves with the shape this builds. Services
 *  never reject: a failure is a value with `status: false`, so a caller that
 *  forgets a `.catch` cannot turn a handled failure into an unhandled rejection
 *  and take the process down.
 *
 *  The four fields are always present, in the same order, whatever happened —
 *  so a consumer never has to test for the existence of a key before reading it.
 * ============================================================================
 */

import type { ServiceResult } from '../types/service.types';

/**
 * Builds a service result envelope.
 *
 * @param status - True when the operation completed. False means it did not happen at all.
 * @param data - The payload on success. Pass `{}` on failure — never a partial payload, which a caller ignoring `status` would read as real.
 * @param error - The caught error on failure, `{}` otherwise. Kept for logs and diagnostics; controllers should not put it on the wire verbatim.
 * @param msg - Human-readable message, safe to show to the operator. On failure this is what they will actually read, so make it say what to do next.
 * @returns The envelope, with all four fields always present.
 */
const promiseReturnResult = <TData = any>(status: boolean, data: TData, error: any, msg: string): ServiceResult<TData> => {
    const result: ServiceResult<TData> = {
        status: false,
        data: {} as TData,
        error: {},
        msg: ''
    };

    result.status = status;
    result.data = data;
    result.error = error;
    result.msg = msg;

    return result;
};

export = {
    promiseReturnResult
};
