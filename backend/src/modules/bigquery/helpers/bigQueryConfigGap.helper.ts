'use strict';

/**
 * ============================================================================
 *  WHAT TO SAY WHEN THERE IS NO DATA SOURCE
 * ============================================================================
 *
 *  PURE. No models, no config, no clock reads, no I/O — the values are passed in, so the message
 *  this produces can be asserted without an environment.
 *
 *  This is the honesty primitive for the whole BigQuery tier. Without a connection there is no
 *  DATA SOURCE, which is a completely different fact from a listing having had no traffic — and the
 *  second one is not ours to state. So an unconfigured deployment must never receive an empty result
 *  set that a page would draw as a flat line at zero. It receives THIS: a refusal that names the
 *  environment variable to set.
 *
 *  "Not available" is not an error message; it is a riddle. Every string below names a variable.
 * ============================================================================
 */

/** One required setting, and how a reader is told to supply it. */
interface BigQueryConfigKey {
    /** The environment variable, exactly as it must appear in .env. */
    env: string;
    /** The resolved value. Empty means missing. */
    value: string;
    /** What is lost without it, in one clause. */
    why: string;
}

/**
 * The tier's three requirements, in the order an operator would set them.
 *
 * ⚠️ Credentials are ONE requirement satisfied by EITHER variable. A deployment running on GCP
 * authenticates through Application Default Credentials and has no service-account JSON to paste;
 * demanding one anyway would report a perfectly working install as "not connected", which is the
 * same dishonesty pointing the other way.
 *
 * @param params0 - The resolved configuration values.
 * @param params0.project_id - `GCP_PROJECT_ID`.
 * @param params0.dataset - `BQ_DATASET`.
 * @param params0.service_account_json - `GCP_SERVICE_ACCOUNT_JSON`.
 * @param params0.adc_credentials_path - `GOOGLE_APPLICATION_CREDENTIALS`.
 * @returns The three requirements with their current values.
 */
const listBigQueryConfigKeys = ({ project_id, dataset, service_account_json, adc_credentials_path }: {
    project_id: string;
    dataset: string;
    service_account_json: string;
    adc_credentials_path: string;
}): BigQueryConfigKey[] => {
    return [
        {
            env: 'GCP_PROJECT_ID',
            value: project_id,
            why: 'the GCP project that holds the export and is billed for the scan'
        },
        {
            env: 'BQ_DATASET',
            value: dataset,
            why: 'the dataset holding the daily export tables'
        },
        {
            env: 'GCP_SERVICE_ACCOUNT_JSON',
            value: service_account_json || adc_credentials_path,
            why: 'credentials to read it (or GOOGLE_APPLICATION_CREDENTIALS, if you run on GCP)'
        }
    ];
};

/**
 * The operator-facing refusal for an unconfigured (or half-configured) tier.
 *
 * ⚠️ It says what is MISSING and it says what the emptiness is NOT. A reader who sees "no traffic
 * sources" has to be able to tell, from the message alone, that they are looking at an unconnected
 * pipeline rather than at a listing nobody visited.
 *
 * @param keys - The requirements, from `listBigQueryConfigKeys`.
 * @returns The message. Empty string when nothing is missing.
 */
const describeBigQueryConfigGap = (keys: BigQueryConfigKey[]): string => {
    const missing = keys.filter((key) => !key.value);
    if (missing.length === 0) {
        return '';
    }

    const named = missing.map((key) => `${key.env} (${key.why})`).join(', ');
    return (
        'Shopify listing analytics is not connected, so there is nothing to report here. ' +
        `Set ${named} in your environment and run a BIGQUERY_SYNC. ` +
        'This is NOT a reading of zero traffic — it is a missing data source.'
    );
};

export = {
    listBigQueryConfigKeys,
    describeBigQueryConfigGap
};
