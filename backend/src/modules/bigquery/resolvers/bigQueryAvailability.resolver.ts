'use strict';

/**
 * ============================================================================
 *  IS THIS TIER CONNECTED? — one answer, read from config, used everywhere
 * ============================================================================
 *
 *  THE FIRST THING EVERY SERVICE IN THIS MODULE CALLS. Sync services check it before they can
 *  spend money; read services check it before they can return an empty array that a page would draw
 *  as a flat line at zero.
 *
 *  It exists as its own file because the alternative — each service testing
 *  `config.BIGQUERY.PROJECT_ID` in its own way — is how five call sites end up with five different
 *  ideas of "configured", and the one that is wrong is the one that returns `[]`.
 *
 *  A resolver rather than a helper: it READS CONFIG, which a pure helper may not do. The judgement
 *  itself lives in `helpers/bigQueryConfigGap.helper`, where it can be tested against values.
 * ============================================================================
 */

import config = require('../../../config');
import configGapHelper = require('../helpers/bigQueryConfigGap.helper');

import type { BigQueryAvailability } from '../types/bigQuery.types';

const { listBigQueryConfigKeys, describeBigQueryConfigGap } = configGapHelper;

/**
 * Whether BigQuery can be reached, and what to tell the operator when it cannot.
 *
 * Reads config at CALL time, not at module load. Config is frozen and read once from the
 * environment, so the result never changes within a process — but resolving lazily keeps this file
 * importable from a test that has set its own environment, and costs nothing.
 *
 * @returns `enabled`, the missing variable names, and the message to resolve.
 */
const resolveBigQueryAvailability = (): BigQueryAvailability => {
    const keys = listBigQueryConfigKeys({
        project_id: config.BIGQUERY.PROJECT_ID,
        dataset: config.BIGQUERY.DATASET,
        service_account_json: config.BIGQUERY.SERVICE_ACCOUNT_JSON,
        adc_credentials_path: config.BIGQUERY.ADC_CREDENTIALS_PATH
    });

    const missing_env = keys.filter((key) => !key.value).map((key) => key.env);
    // `config.BIGQUERY.ENABLED` is the same judgement made in the config file, and the two are
    // asserted against each other here rather than trusted to agree: a gate and its message drifting
    // apart would mean a service that refuses without saying why, or worse, one that proceeds while
    // the message says it cannot.
    const enabled = config.BIGQUERY.ENABLED && missing_env.length === 0;

    return {
        enabled,
        missing_env,
        message: describeBigQueryConfigGap(keys)
    };
};

export = {
    resolveBigQueryAvailability
};
