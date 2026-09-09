'use strict';

/**
 * ============================================================================
 *  SHOPIFY PARTNER API CLIENT — READ-ONLY
 * ============================================================================
 *
 *  This module is the ONLY way this application talks to the Shopify Partner
 *  GraphQL API. By design it accepts ONLY GraphQL queries — any document
 *  containing a `mutation` operation is rejected before the HTTP call leaves
 *  the process.
 *
 *  Do not add a mutation pathway. If you ever need to write to Shopify, build a
 *  separate client in a different folder with its own auth + audit log — do not
 *  weaken this one. The token this client carries is the operator's own Partner
 *  API token, and a self-hosted analytics tool has no business being able to
 *  change anything with it.
 *
 *  Defense in depth:
 *    1. Static check in runQuery (this file) — rejects mutations.
 *    2. Hard-coded GraphQL documents in `services/partnerSync.service` — no
 *       runtime-constructed operation strings.
 *    3. Only this module talks to partners.shopify.com; no other file in the
 *       codebase imports axios for that host.
 * ============================================================================
 */

import axios from 'axios';
import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');

import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type {
    PartnerApiHttpError,
    PartnerFetchAllPagesInput,
    PartnerPageResult,
    PartnerRunQueryInput
} from '../types/partnerApi.types';

const { customConsoleLog, customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;

// No type declarations ship with stopcock, so it comes in through `require` and is `any` here. It
// is a two-argument call used once, immediately below, which is the whole of the exposure.
const stopcock = require('stopcock');

const _sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Rate limiting ───────────────────────────────────────────────────────────
//
// TWO layers, and both are required:
//
//  1. PROACTIVE — a process-wide stopcock token bucket. The per-page sleep in
//     fetchAllPages is NOT sufficient on its own: the event and transaction
//     paginators run CONCURRENTLY under Promise.all, so two paginators each
//     pacing at 250ms produce up to 8 req/s against a documented 4 req/s limit
//     whenever round-trip latency is under 250ms.
//  2. REACTIVE — a bounded 429 / transient-5xx retry inside the request itself.
//     stopcock paces this process and knows nothing about the server's ACTUAL
//     remaining budget — another sync running elsewhere, or a bucket already
//     drained before this process started, are both invisible to it. So the
//     retry is the real guarantee; the bucket only keeps us from reaching it.
//
// Deleting either one looks harmless in testing (a small app never hits the
// limit) and then fails on the first lifetime sync of a large one.

const _rawPost = (endpoint: string, body: Record<string, any>, options: AxiosRequestConfig): Promise<AxiosResponse<any>> => axios.post(endpoint, body, options);

const _PARTNER_MAX_RPS: number = config.PARTNER.MAX_REQUESTS_PER_SECOND;
const _throttledPost = stopcock(_rawPost, {
    limit: _PARTNER_MAX_RPS,
    interval: 1000,
    bucketSize: _PARTNER_MAX_RPS
});

// Retried: throttling and transient gateway errors. Everything else (400/401/
// 403/404) is terminal and returns immediately so callers can branch on it.
const _RETRYABLE_STATUS: number[] = [429, 500, 502, 503, 504];

/**
 * Narrows the `unknown` a `catch` binds to the axios-shaped error this client reads.
 *
 * Establishes only that the value is an object — every field on `PartnerApiHttpError` is optional,
 * so each access below stays guarded exactly as the original `error && error.response && …` chain
 * was. A thrown string or a thrown function narrows to nothing here, which is the same `undefined`
 * the property chain produced.
 *
 * @param error - Whatever was thrown.
 * @returns True when the value is object-shaped enough to read `.response` off.
 */
const _isHttpError = (error: unknown): error is PartnerApiHttpError => !!error && typeof error === 'object';

/**
 * Resolves how long to wait before a retry: the provider's `Retry-After` header when present
 * (seconds or an HTTP date), otherwise capped exponential backoff.
 *
 * Always bounded by `MAX_RETRY_WAIT_MS`. A server is free to send a `Retry-After` of an hour, and
 * an unbounded wait inside a job runner is a hang rather than a delay.
 *
 * @param headers - Response headers, if the call got far enough to have any.
 * @param attempt - Zero-based retry attempt, used for the backoff exponent.
 * @returns Milliseconds to sleep before retrying.
 */
const _resolveRetryDelayMs = (headers: Record<string, any> | undefined, attempt: number): number => {
    const _maxWait: number = config.PARTNER.MAX_RETRY_WAIT_MS;
    const _retryAfter = headers && (headers['retry-after'] || headers['Retry-After']);

    if (_retryAfter) {
        const _asSeconds = Number(_retryAfter);
        if (Number.isFinite(_asSeconds) && _asSeconds >= 0) {
            return Math.min(_asSeconds * 1000, _maxWait);
        }
        const _asDate = Date.parse(_retryAfter);
        if (!Number.isNaN(_asDate)) {
            return Math.min(Math.max(_asDate - Date.now(), 0), _maxWait);
        }
    }

    return Math.min(1000 * Math.pow(2, attempt), _maxWait);
};

/**
 * Shopify reports throttling TWO ways: an HTTP 429, and an HTTP 200 whose GraphQL `errors` array
 * carries a THROTTLED extensions code. Both must be treated as retryable, or a 200-throttle aborts
 * the whole paginated pull halfway through and the caller sees a "successful" partial answer.
 *
 * @param body - The parsed response body.
 * @returns True when the body is a throttle notice wearing a 200.
 */
const _isThrottledGraphQlBody = (body: any): boolean => {
    if (!body || !Array.isArray(body.errors)) {
        return false;
    }
    return body.errors.some((e: any) => {
        const _code = e && e.extensions && e.extensions.code;
        return String(_code || '').toUpperCase() === 'THROTTLED';
    });
};

/**
 * Reads a dotted path out of a response object, returning undefined rather than throwing on any
 * missing link in the chain.
 *
 * @param obj - The GraphQL `data` payload.
 * @param dottedPath - e.g. 'app.events'.
 * @returns The value at that path, or undefined.
 */
const _resolveByPath = (obj: any, dottedPath: string): any => {
    if (!obj || !dottedPath) {
        return undefined;
    }
    return dottedPath.split('.').reduce((acc: any, key: string) => (acc == null ? acc : acc[key]), obj);
};

/**
 * Strict read-only guard. Strips GraphQL line comments (#…) and matches the `mutation` operation
 * declaration token: `mutation`, `mutation Name`, `mutation Name(...)`, or `mutation Name @directive`.
 *
 * @param query - The document about to be sent.
 * @returns True if the document contains any mutation operation.
 */
const _containsMutation = (query: unknown): boolean => {
    if (!query || typeof query !== 'string') {
        return false;
    }
    const withoutComments = query.replace(/#[^\n]*/g, '');
    return /\bmutation\b\s*(?:[A-Za-z_]\w*\s*)?(?:\([^)]*\))?\s*(?:@[A-Za-z_]\w*[^{]*)?\{/m.test(withoutComments);
};

/**
 * Builds the Partner GraphQL endpoint from configuration.
 *
 * `API_BASE_URL` is configurable ONLY so the test suite can point at a local fixture server; the
 * organisation id and version are the two values an operator actually sets.
 *
 * @returns The endpoint, or null when the Partner API is not configured.
 */
const _buildEndpoint = (): string | null => {
    const orgId: string = config.PARTNER.ORG_ID;
    const version: string = config.PARTNER.API_VERSION;
    const base: string = config.PARTNER.API_BASE_URL;
    if (!orgId || !version || !base) {
        return null;
    }
    const _root = base.replace(/\/+$/, '');
    return `${_root}/${orgId}/api/${version}/graphql.json`;
};

/**
 * Single GraphQL call against the Shopify Partner API.
 *
 * Retries only throttling and transient gateway failures, bounded by `MAX_RETRIES` and
 * `MAX_RETRY_WAIT_MS`. Authentication and version errors return immediately with a message that
 * names the environment variable to fix, because those are configuration problems and a retry loop
 * only delays finding that out.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator, or a worker sentinel.
 * @param params1 - The call.
 * @param params1.query - The GraphQL document. A mutation is refused here, not sent.
 * @param [params1.variables] - GraphQL variables.
 * @returns `data` is the GraphQL `data` payload on success, `{}` on every failure.
 */
const runQuery = ({ user_id }: IdentityObject, { query, variables }: PartnerRunQueryInput): Promise<ServiceResult<Record<string, any>>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!query) {
                return resolve(promiseReturnResult(false, {}, {}, 'GraphQL query is required.'));
            }

            // Hard read-only guarantee. Refuse to send any mutation regardless of caller. Logged
            // loudly because it indicates a bug somewhere upstream.
            if (_containsMutation(query)) {
                customConsoleError(
                    'FATAL: Mutation blocked at partnerApi.client. This module is READ-ONLY.',
                    { query: String(query).slice(0, 200), user_id }
                );
                return resolve(promiseReturnResult(false, {}, {}, 'The Partner API client is read-only: mutations are not permitted.'));
            }

            const endpoint = _buildEndpoint();
            const token: string = config.PARTNER.API_TOKEN;
            if (!endpoint || !token) {
                return resolve(promiseReturnResult(false, {}, {}, 'The Shopify Partner API is not configured. Set SHOPIFY_PARTNER_ORG_ID, SHOPIFY_PARTNER_API_VERSION and SHOPIFY_PARTNER_API_TOKEN.'));
            }

            const _requestOptions: AxiosRequestConfig = {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': token
                },
                timeout: config.PARTNER.REQUEST_TIMEOUT_MS
            };
            const _maxRetries: number = config.PARTNER.MAX_RETRIES;

            let response: AxiosResponse<any> | undefined;
            let attempt = 0;
            // Bounded retry on throttling / transient gateway errors only.
            while (true) {
                let _retryDelayMs: number | null = null;
                try {
                    response = await _throttledPost(endpoint, { query, variables: variables || {} }, _requestOptions);
                    // A 200 can still carry a THROTTLED GraphQL error.
                    if (attempt < _maxRetries && _isThrottledGraphQlBody(response && response.data)) {
                        _retryDelayMs = _resolveRetryDelayMs(response && response.headers, attempt);
                    }
                } catch (requestError) {
                    let _status: number | undefined;
                    let _headers: Record<string, any> | undefined;
                    if (_isHttpError(requestError) && requestError.response) {
                        _status = requestError.response.status;
                        _headers = requestError.response.headers;
                    }
                    if (attempt >= _maxRetries || _status === undefined || !_RETRYABLE_STATUS.includes(_status)) {
                        throw requestError;
                    }
                    _retryDelayMs = _resolveRetryDelayMs(_headers, attempt);
                }

                if (_retryDelayMs === null) {
                    break;
                }
                customConsoleLog('INFO: [Partner:ApiClient] Throttled — retrying', {
                    attempt: attempt + 1,
                    max_retries: _maxRetries,
                    wait_ms: _retryDelayMs
                });
                await _sleep(_retryDelayMs);
                attempt += 1;
            }

            const body = response && response.data;
            if (body && Array.isArray(body.errors) && body.errors.length > 0) {
                const errMsg = body.errors.map((e: any) => e && e.message).filter(Boolean).join('; ');
                customConsoleError('ERROR: [Partner:ApiClient] Partner API returned GraphQL errors', body.errors);
                return resolve(promiseReturnResult(false, {}, body.errors, `Partner API error: ${errMsg}`));
            }

            return resolve(promiseReturnResult(true, body && body.data ? body.data : {}, {}, 'Partner API query succeeded.'));
        } catch (error) {
            let statusCode: number | undefined;
            let respBody: any;
            let _errMessage: string | undefined;
            if (_isHttpError(error)) {
                statusCode = error.response && error.response.status;
                respBody = error.response && error.response.data;
                _errMessage = error.message;
            }
            customConsoleError('ERROR: [Partner:ApiClient] runQuery failed', { statusCode, respBody, message: _errMessage });

            const errMessages: string[] = (respBody && Array.isArray(respBody.errors) ? respBody.errors : [])
                .map((e: any) => e && e.message)
                .filter(Boolean);
            const versionInvalid = statusCode === 404 && errMessages.some((m) => /api version/i.test(m));

            let _msg;
            if (statusCode === 401 || statusCode === 403) {
                _msg = 'Partner API authentication failed. Check SHOPIFY_PARTNER_API_TOKEN, and that the token has the required read scopes.';
            } else if (versionInvalid) {
                const v = config.PARTNER.API_VERSION;
                _msg = `Partner API version "${v}" is not supported (Shopify keeps roughly the last four quarterly versions). Set SHOPIFY_PARTNER_API_VERSION to a current one (e.g. 2026-07) and restart.`;
            } else if (statusCode === 404) {
                _msg = 'Partner API endpoint returned 404. Check SHOPIFY_PARTNER_ORG_ID is your organisation id — the number in your Partner dashboard URL.';
            } else if (errMessages.length > 0) {
                _msg = `Partner API error: ${errMessages.join('; ')}`;
            } else {
                _msg = `Partner API request failed${statusCode ? ` (HTTP ${statusCode})` : ''}.`;
            }
            return resolve(promiseReturnResult(false, {}, error, _msg));
        }
    });
};

/**
 * An EMPTY-but-COMPLETE pagination result.
 *
 * Early validation failures in `fetchAllPages` still resolve with the full `PartnerPageResult`
 * shape rather than a bare `{}` — the caller persists whatever came back and reads `partial` to
 * decide whether it may advance its watermark, and a missing `partial` field would read as `false`,
 * i.e. "this run was complete". An empty answer must never be able to look like a finished one.
 *
 * @returns Zero nodes, flagged as an incomplete run.
 */
const _emptyPageResult = (): PartnerPageResult => {
    return {
        nodes: [],
        pages_fetched: 0,
        truncated: false,
        partial: true,
        resume_cursor: null
    };
};

/**
 * Auto-paginates a cursor-paginated GraphQL connection and returns the flat list of nodes across
 * every page. Sleeps `config.PARTNER.PAGE_DELAY_MS` between pages.
 *
 * The query MUST accept `$first: Int!` and `$after: String`, and the connection MUST expose
 * `edges { cursor node { … } } pageInfo { hasNextPage }`.
 *
 *  A FAILED run resolves with `status: false` and the SAME payload shape, carrying whatever was
 * collected plus a resume cursor. That is deliberate: on a lifetime pull, failing at page 900 used
 * to discard all 90,000 nodes already fetched. The caller persists the partial set (the upserts are
 * idempotent) but must NOT advance its watermark — `partial` and `truncated` are how it knows.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator, or a worker sentinel.
 * @param params1 - The walk.
 * @param params1.query - The GraphQL document.
 * @param [params1.variables] - Everything except `after`, which the paginator manages.
 * @param params1.connectionPath - Dot path to the connection inside `data`.
 * @param [params1.pageSize=100] - Nodes per page.
 * @param [params1.maxPages=1000] - Hard ceiling, to avoid runaway pagination.
 * @returns Nodes, page count, and the two incompleteness flags.
 */
const fetchAllPages = ({ user_id }: IdentityObject, { query, variables, connectionPath, pageSize, maxPages }: PartnerFetchAllPagesInput): Promise<ServiceResult<PartnerPageResult>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, _emptyPageResult(), {}, 'User ID not available.'));
            }
            if (!query || !connectionPath) {
                return resolve(promiseReturnResult(false, _emptyPageResult(), {}, 'query and connectionPath are required.'));
            }
            const _pageSize = pageSize || 100;
            const _maxPages = maxPages || 1000;

            const allNodes: any[] = [];
            let cursor: string | null = null;
            let pagesFetched = 0;
            let hasNext = false;
            let failureResp: ServiceResult<any> | null = null;
            let lastGoodCursor: string | null = null;

            while (pagesFetched < _maxPages) {
                const vars = Object.assign({}, variables || {}, { first: _pageSize, after: cursor });
                const queryResp = await runQuery({ user_id }, { query, variables: vars });
                if (!queryResp.status) {
                    failureResp = queryResp;
                    break;
                }
                const conn = _resolveByPath(queryResp.data, connectionPath);
                if (!conn) {
                    failureResp = promiseReturnResult(false, {}, {}, `Connection not found at path '${connectionPath}' in response.`);
                    break;
                }
                const edges: any[] = Array.isArray(conn.edges) ? conn.edges : [];
                for (const edge of edges) {
                    if (edge && edge.node) {
                        allNodes.push(edge.node);
                    }
                }
                pagesFetched += 1;

                hasNext = !!(conn.pageInfo && conn.pageInfo.hasNextPage);
                let lastCursor = null;
                if (edges.length > 0) {
                    lastCursor = edges[edges.length - 1].cursor;
                }
                if (!hasNext || !lastCursor) {
                    break;
                }
                cursor = lastCursor;
                lastGoodCursor = lastCursor;

                if (pagesFetched < _maxPages) {
                    await _sleep(config.PARTNER.PAGE_DELAY_MS);
                }
            }

            // Hit the page ceiling with more data still available: the result set is incomplete, and
            // silently succeeding would let the caller advance its sync watermark past data it never
            // fetched — which is unrecoverable, because the next run starts after the gap.
            const _truncated = pagesFetched >= _maxPages && hasNext;

            const _pageData: PartnerPageResult = {
                nodes: allNodes,
                pages_fetched: pagesFetched,
                truncated: _truncated,
                partial: !!failureResp,
                resume_cursor: lastGoodCursor
            };

            if (failureResp) {
                customConsoleError('ERROR: [Partner:ApiClient] Pagination failed mid-run', {
                    connectionPath,
                    pages_fetched: pagesFetched,
                    nodes_collected: allNodes.length,
                    msg: failureResp.msg
                });
                return resolve(promiseReturnResult(false, _pageData, failureResp.error, failureResp.msg));
            }

            if (_truncated) {
                customConsoleError('ERROR: [Partner:ApiClient] Pagination hit the maxPages ceiling with more data available', {
                    connectionPath,
                    max_pages: _maxPages,
                    nodes_collected: allNodes.length
                });
                return resolve(promiseReturnResult(false, _pageData, {}, `Partner API pagination stopped at the ${_maxPages}-page ceiling with more data available; the result set is incomplete.`));
            }

            customConsoleLog('INFO: [Partner:ApiClient] Pagination complete', {
                connectionPath,
                pages: pagesFetched,
                nodes: allNodes.length
            });

            return resolve(promiseReturnResult(true, _pageData, {}, 'Partner API pagination complete.'));
        } catch (error) {
            customConsoleError('ERROR: [Partner:ApiClient] fetchAllPages failed', error);
            return resolve(promiseReturnResult(false, _emptyPageResult(), error, 'Partner API pagination failed.'));
        }
    });
};

export = {
    runQuery,
    fetchAllPages
};
