'use strict';

/**
 * ============================================================================
 *  GOOGLE BIGQUERY CLIENT — READ-ONLY
 * ============================================================================
 *
 *  This module is the ONLY way this codebase talks to Google BigQuery. By design it accepts ONLY
 *  read queries — any SQL that isn't a `SELECT` or `WITH … SELECT` is rejected before being sent.
 *
 *  Defense in depth:
 *    1. Static check `isReadOnlySql` rejects mutations / DML / DDL / DCL.
 *    2. A SELECT has no destination table, so a job from here cannot write one.
 *    3. The service account at the GCP level should be granted ONLY
 *       `roles/bigquery.dataViewer` + `roles/bigquery.jobUser` — verify in IAM before issuing the
 *       key. Layer 3 is your last line of defense.
 *
 *  Do not weaken this guard. If something ever needs to write to BigQuery, build a separate client
 *  in a different folder.
 *
 *  ── COST ────────────────────────────────────────────────────────────────────
 *  ⚠️ BigQuery bills per byte SCANNED, against the operator's own GCP project. Every job created
 *  here carries `maximumBytesBilled`, so a query whose estimate exceeds the ceiling is REJECTED
 *  BEFORE IT RUNS rather than billed. `dry_run` prices a query at zero cost and is the only safe way
 *  to learn what a new or widened one costs before spending it.
 * ============================================================================
 */

import fs = require('fs');
import { BigQuery } from '@google-cloud/bigquery';
import type { BigQueryOptions, Query, QueryResultsOptions } from '@google-cloud/bigquery';

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import constants = require('../constants/bigQuery.constants');
import sqlHelper = require('../helpers/bigQuerySql.helper');
import rowHelper = require('../helpers/bigQueryRow.helper');
import availabilityResolver = require('../resolvers/bigQueryAvailability.resolver');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type { BigQueryRow, RunQueryData, RunQueryInput } from '../types/bigQuery.types';

const { customConsoleLog, customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { INCOMPLETE_JOB_POLL_MS, INCOMPLETE_JOB_MAX_POLLS, READ_ONLY_JOB_PREFIX } = constants;
const { isReadOnlySql } = sqlHelper;
const { readMessage, readErrors } = rowHelper;
const { resolveBigQueryAvailability } = availabilityResolver;

const _sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A client, or the reason there is not one.
 *
 * Never both, and never neither. The message is operator-facing and names the environment variable
 * at fault — a Google auth stack trace tells the reader that something failed inside a library they
 * did not know they were using, which is not the same as telling them what to fix.
 */
interface ResolvedBigQueryClient {
    client: BigQuery | null;
    error: string;
}

let _bqSingleton: BigQuery | null = null;

/**
 * Turns `GCP_SERVICE_ACCOUNT_JSON` into client options, or explains why it cannot.
 *
 * The variable legitimately holds EITHER of two things — the key file's JSON pasted inline, or a
 * filesystem PATH to that file — and telling them apart matters more than it looks. The obvious
 * implementation is `try { JSON.parse(raw) } catch { keyFilename = raw }`, which is what this
 * replaces: under it, a TRUNCATED paste (the overwhelmingly common accident, because the JSON is
 * long and contains newlines) silently becomes a filename, and the operator is handed
 * `ENOENT: no such file or directory, open '{"type":"service_account",…'` — a message that names
 * neither the variable nor the actual mistake.
 *
 * So the first character decides, and each branch fails with its own diagnosis.
 *
 * @param raw - The configured value, already trimmed by config.
 * @returns `{ options, error }` — options to merge, or a message naming what is wrong.
 */
const _resolveCredentials = (raw: string): { options: Partial<BigQueryOptions>; error: string } => {
    if (!raw) {
        // Nothing set. Not an error here: Application Default Credentials may still resolve, and
        // whether that is acceptable was already decided by `config.BIGQUERY.ENABLED`.
        return { options: {}, error: '' };
    }

    if (raw.startsWith('{')) {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (parseError) {
            return {
                options: {},
                error: 'GCP_SERVICE_ACCOUNT_JSON starts with "{" so it is being read as inline JSON, ' +
                    'but it does not parse. Paste the WHOLE key file as a single line (newlines inside ' +
                    'the private key must stay as the literal \\n they already are), or set the variable ' +
                    'to the path of the key file instead.'
            };
        }
        if (!parsed || typeof parsed !== 'object') {
            return {
                options: {},
                error: 'GCP_SERVICE_ACCOUNT_JSON parsed as JSON but is not an object — it must be the ' +
                    'service-account key file\'s contents, or a path to that file.'
            };
        }
        return { options: { credentials: parsed }, error: '' };
    }

    if (!fs.existsSync(raw)) {
        return {
            options: {},
            error: `GCP_SERVICE_ACCOUNT_JSON is being read as a file path, and no file exists at "${raw}". ` +
                'Give the path to the service-account key file, or paste the key file\'s JSON inline.'
        };
    }
    return { options: { keyFilename: raw }, error: '' };
};

/**
 * Lazily builds (and caches) a BigQuery client.
 *
 * Auth sources, in order:
 *   1. `GCP_SERVICE_ACCOUNT_JSON` as inline JSON
 *   2. `GCP_SERVICE_ACCOUNT_JSON` as a filesystem path
 *   3. GCP Application Default Credentials — how a process running ON GCP authenticates
 *
 * Only a SUCCESSFULLY built client is cached. A configuration failure is re-evaluated on the next
 * call, which costs one `existsSync` and means an operator who drops the key file into place does
 * not have to restart the process to find out whether they got the path right.
 *
 * @returns The client, or the operator-facing reason there is none.
 */
const _getClient = (): ResolvedBigQueryClient => {
    if (_bqSingleton) {
        return { client: _bqSingleton, error: '' };
    }

    const availability = resolveBigQueryAvailability();
    if (!availability.enabled) {
        return { client: null, error: availability.message };
    }

    const credentials = _resolveCredentials(config.BIGQUERY.SERVICE_ACCOUNT_JSON);
    if (credentials.error) {
        return { client: null, error: credentials.error };
    }

    const opts: BigQueryOptions = { projectId: config.BIGQUERY.PROJECT_ID, ...credentials.options };
    _bqSingleton = new BigQuery(opts);
    return { client: _bqSingleton, error: '' };
};

/**
 * Run a single read-only SQL query against BigQuery.
 *
 * Uses parameterized variables for safety — never string-concat caller input into SQL. The read-only
 * guard scans string literals too, so any value that could contain English words (merchant-supplied
 * free text such as a store name, above all) MUST travel as a parameter rather than being inlined.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator, or the sync worker's sentinel.
 * @param params1 - The query.
 * @param params1.sql - The SELECT / WITH statement to execute.
 * @param [params1.params] - Named query parameters (key: value).
 * @param [params1.types] - Named-param type hints (key: 'STRING'|'DATE'|'INT64'…).
 * @param [params1.dry_run] - Price the query without executing it. Billed at zero.
 * @returns Rows plus the scan's provenance, or the refusal.
 */
const runQuery = ({ user_id }: IdentityObject, { sql, params, types, dry_run = false }: RunQueryInput): Promise<ServiceResult<RunQueryData>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!sql) {
                return resolve(promiseReturnResult(false, {}, {}, 'SQL is required.'));
            }

            if (!isReadOnlySql(sql)) {
                customConsoleError(
                    'FATAL: Non-read-only SQL blocked at bigQueryClient. This module is READ-ONLY.',
                    { sql_prefix: String(sql).slice(0, 200), user_id }
                );
                return resolve(promiseReturnResult(false, {}, {}, 'The BigQuery client is read-only: only SELECT/WITH queries are permitted.'));
            }

            const resolved = _getClient();
            if (!resolved.client) {
                return resolve(promiseReturnResult(false, {}, {}, resolved.error));
            }
            const client = resolved.client;

            const _options: Query = {
                query: sql,
                params: params || {},
                useLegacySql: false,
                jobPrefix: READ_ONLY_JOB_PREFIX,
                // BigQuery bills per byte SCANNED. A LIFETIME sync fans out three concurrent scans
                // across every daily table since the lifetime floor, so an unbounded job is an
                // unbounded bill. A job whose estimate exceeds this is REJECTED before it runs —
                // not billed.
                maximumBytesBilled: String(config.BIGQUERY.MAX_BYTES_BILLED),
                jobTimeoutMs: config.BIGQUERY.JOB_TIMEOUT_MS
            };
            if (types && typeof types === 'object') {
                _options.types = types;
            }

            // A dry run is BILLED AT ZERO by BigQuery: it validates the SQL and returns the byte
            // estimate without executing. It is the only safe way to learn what a new or widened
            // query costs before spending it — particularly one that reads the whole `event_params`
            // column, which is far heavier than the daily rollups. Returns before the result loop
            // because a dry-run job produces no rows.
            if (dry_run) {
                _options.dryRun = true;
                const [dryJob] = await client.createQueryJob(_options);
                const meta = (dryJob && dryJob.metadata) || {};
                const stats = meta.statistics || {};
                const bytes = Number(stats.totalBytesProcessed || 0);
                const cap = Number(config.BIGQUERY.MAX_BYTES_BILLED || 0);
                return resolve(promiseReturnResult(true, {
                    dry_run: true,
                    rows: [],
                    bytes_scanned: bytes,
                    gib_scanned: Math.round((bytes / (1024 ** 3)) * 100) / 100,
                    max_bytes_billed: cap,
                    // Surfaced rather than left for the caller to compute: a query over the cap is
                    // REJECTED before it runs, so this is the difference between "expensive" and
                    // "will not execute at all".
                    exceeds_cap: cap > 0 && bytes > cap
                }, {}, 'Dry run completed — no bytes billed.'));
            }

            const [job] = await client.createQueryJob(_options);

            // Page explicitly instead of auto-paginating every row into the heap — a wide LIFETIME
            // result set would otherwise be held in memory in full.
            //
            // getQueryResults returns a nextQuery that is null when the result set is exhausted,
            // carries a pageToken when more pages exist, and carries NEITHER while the job is still
            // executing. That last case must be polled — treating it as "done" would silently
            // return an empty result.
            const _maxRows = config.BIGQUERY.MAX_RESULT_ROWS;
            const _pageSize = config.BIGQUERY.PAGE_SIZE;
            const rows: BigQueryRow[] = [];
            let _pageToken: string | undefined = undefined;
            let _rowCapHit = false;
            let _stillRunning = false;
            let _polls = 0;

            while (true) {
                // Hoisted into an ANNOTATED const rather than passed inline: `_pageToken` is
                // reassigned from `nextQuery.pageToken` below, so an inline literal makes
                // `nextQuery`'s type depend on its own initializer (TS7022). The declared type
                // breaks the cycle; the call is byte-for-byte the same request.
                const _resultsOptions: QueryResultsOptions = {
                    autoPaginate: false,
                    maxResults: _pageSize,
                    pageToken: _pageToken
                };
                const [pageRows, nextQuery] = await job.getQueryResults(_resultsOptions);
                if (Array.isArray(pageRows) && pageRows.length > 0) {
                    rows.push(...pageRows);
                }

                if (!nextQuery) {
                    break;
                }

                if (nextQuery.pageToken) {
                    if (rows.length >= _maxRows) {
                        _rowCapHit = true;
                        break;
                    }
                    _pageToken = nextQuery.pageToken;
                    continue;
                }

                _polls += 1;
                if (_polls > INCOMPLETE_JOB_MAX_POLLS) {
                    _stillRunning = true;
                    break;
                }
                await _sleep(INCOMPLETE_JOB_POLL_MS);
            }

            const meta = job && job.metadata && job.metadata.statistics ? job.metadata.statistics : {};
            const bytesScanned = meta.query && meta.query.totalBytesProcessed ? Number(meta.query.totalBytesProcessed) : 0;

            if (_stillRunning) {
                customConsoleError('BigQuery job did not complete within the result-poll ceiling', {
                    polls: _polls,
                    job_id: job && job.id
                });
                return resolve(promiseReturnResult(false, { rows: [], bytes_scanned: bytesScanned, job_id: job && job.id }, {}, 'BigQuery job did not complete in time.'));
            }

            // Truncation is a correctness problem, not a warning: the caller would otherwise
            // persist a partial result set and advance its watermark past data it never saw. So this
            // resolves FALSE, with the partial rows attached for diagnosis only.
            if (_rowCapHit) {
                customConsoleError('BigQuery result row cap hit — result set is incomplete', {
                    max_result_rows: _maxRows,
                    rows_returned: rows.length,
                    bytes_scanned: bytesScanned,
                    job_id: job && job.id
                });
                return resolve(promiseReturnResult(false, {
                    rows,
                    bytes_scanned: bytesScanned,
                    job_id: job && job.id,
                    truncated: true
                }, {}, `BigQuery result exceeded the ${_maxRows}-row ceiling; result set is incomplete.`));
            }

            customConsoleLog('BigQuery query complete', {
                rows: rows.length,
                bytes_scanned: bytesScanned,
                job_id: job && job.id
            });

            return resolve(promiseReturnResult(true, {
                rows,
                bytes_scanned: bytesScanned,
                job_id: job && job.id,
                truncated: false
            }, {}, 'BigQuery query succeeded.'));
        } catch (error) {
            const _errors = readErrors(error);
            const _message = readMessage(error);
            let _msg = `BigQuery query failed: ${_message ? String(_message) : 'unknown error'}`;
            if (_errors && Array.isArray(_errors) && _errors.length > 0) {
                _msg = `BigQuery error: ${_errors.map((e) => readMessage(e)).filter(Boolean).join('; ')}`;
            }
            customConsoleError('Error in bigQueryClient.runQuery', { message: _message, user_id });
            return resolve(promiseReturnResult(false, {}, error, _msg));
        }
    });
};

export = {
    runQuery
};
