'use strict';

/**
 * ============================================================================
 *  DUMMY HANDLER — the smoke path
 * ============================================================================
 *
 *  Sleeps, then succeeds. It exists so a fresh install can prove the whole
 *  runner works — create a job, watch it be claimed, watch it go RUNNING, watch
 *  it close as SUCCESS with a duration — WITHOUT a Shopify Partner credential,
 *  a populated database, or a network.
 *
 *  That matters more here than it looks. When a self-hoster's first real sync
 *  produces nothing, there are two candidate explanations — "the runner is not
 *  working" and "the Partner API returned nothing" — and they need completely
 *  different fixes. Being able to run this job answers the first one in ten
 *  seconds, which is the difference between a five-minute setup and an
 *  afternoon.
 *
 *  It is registered by the runner itself, so it is never a job type that
 *  enqueues and then finds no handler.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import constants = require('../constants/sync.constants');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type { DummyJobInput, DummyJobResult } from '../types/dummyHandler.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { DEFAULT_DUMMY_SLEEP_MS } = constants;

/**
 * Runs the smoke job: sleep for a while, then report success.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The worker running the job.
 * @param params1 - The parameters object, taken verbatim from the job row's stored payload.
 * @param [params1.sleep_ms] - How long to sleep. Non-finite or non-positive values fall back to the default rather than returning instantly, so the job is always long enough to observe in the RUNNING state.
 * @returns Resolves success with the interval actually slept.
 */
const runDummyJob = ({ user_id }: IdentityObject, { sleep_ms }: DummyJobInput): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }

            let resolvedSleepMs = DEFAULT_DUMMY_SLEEP_MS;
            if (typeof sleep_ms === 'number' && Number.isFinite(sleep_ms) && sleep_ms > 0) {
                resolvedSleepMs = sleep_ms;
            }

            const startedAt = new Date();
            await new Promise((sleepResolve) => setTimeout(sleepResolve, resolvedSleepMs));

            const result: DummyJobResult = {
                dummy: true,
                slept_ms: resolvedSleepMs,
                started_at: startedAt.toISOString(),
                completed_at: new Date().toISOString()
            };

            return resolve(promiseReturnResult(true, result, {}, 'Dummy job completed.'));
        } catch (error) {
            customConsoleError('ERROR: [Sync] runDummyJob threw', { user_id, error });
            return resolve(promiseReturnResult(false, {}, error, 'Dummy job failed.'));
        }
    });
};

export = {
    runDummyJob
};
