'use strict';

/**
 * ============================================================================
 *  API RESPONSE HELPERS
 * ============================================================================
 *
 *  One envelope for every response this API produces:
 *
 *      { status: boolean, msg: string, data: object, error: object }
 *
 *  Field-for-field the same set as `ServiceResult` (src/types/service.types.ts),
 *  so a controller hands a service result to the wire without reshaping it and
 *  a client parses one shape whatever happened.
 *
 *  ── The HTTP status code means what it says ─────────────────────────────────
 *  An API that answers EVERY authentication failure with HTTP 200 and
 *  `{ status: false }` — usually because call sites came to depend on the 200
 *  before anyone noticed — ends up unable to use 401 for what it means. A 401
 *  then has to mean "authenticated fine, but not permitted", the opposite of what
 *  any reader assumes, and it is a permanent tax on debugging.
 *
 *  This build has no such legacy, so: 401 means not authenticated, 403 means
 *  authenticated but the role does not allow it, 404 means not found, 400 means
 *  the request was wrong, 409 means it conflicts with what is stored, 429 means
 *  later, 503 means the server could not consult its datastore, 500 means we
 *  broke. The envelope carries the detail; the status code carries the class.
 *
 *  ⚠️ 401 and 403 must never be swapped. The dashboard signs the user out on a
 *  401; a 403 renders "Restricted" and keeps them signed in. A permission refusal
 *  answered as 401 logs a legitimately signed-in user out on every page they are
 *  not allowed to see.
 * ============================================================================
 */

import type { Response } from 'express';

/** The single wire shape. `pagination` appears only on paginated responses. */
interface ResponseEnvelope {
    status: boolean;
    msg: string;
    data: any;
    error: any;
    pagination?: any;
}

/**
 * 200 — succeeded, nothing to return.
 *
 * @param res - Express response.
 * @param msg - Human-readable confirmation.
 * @returns The sent response.
 */
const successResponse = (res: Response, msg: string): Response => {
    const body: ResponseEnvelope = { status: true, msg: msg, data: {}, error: {} };
    return res.status(200).json(body);
};

/**
 * 200 — succeeded, with a payload.
 *
 * Note that a successful response may legitimately carry figures that are
 * `null` with a stated reason. An unknown value is not an error: it is a
 * successful answer of "we cannot tell you, and here is why". Do not map it
 * onto an error response, and do not let it become `0`.
 *
 * @param res - Express response.
 * @param msg - Human-readable confirmation.
 * @param data - The payload.
 * @returns The sent response.
 */
const successResponseWithData = (res: Response, msg: string, data: any): Response => {
    const body: ResponseEnvelope = { status: true, msg: msg, data: data, error: {} };
    return res.status(200).json(body);
};

/**
 * 200 — succeeded, with a payload and its pagination cursor/counters.
 *
 * @param res - Express response.
 * @param msg - Human-readable confirmation.
 * @param data - The page of results.
 * @param pagination - Page metadata: total, page, limit, or a cursor.
 * @returns The sent response.
 */
const successResponseWithDataPagination = (res: Response, msg: string, data: any, pagination: any): Response => {
    const body: ResponseEnvelope = { status: true, msg: msg, data: data, error: {}, pagination: pagination || {} };
    return res.status(200).json(body);
};

/**
 * 400 — the request itself was wrong: a missing parameter, an unparseable date,
 * a value outside its allowed set. The operator can fix this by asking again
 * differently.
 *
 * @param res - Express response.
 * @param msg - What was wrong with the request, specifically enough to act on.
 * @param [error] - Optional field-level detail.
 * @returns The sent response.
 */
const validationErrorResponse = (res: Response, msg: string, error?: any): Response => {
    const body: ResponseEnvelope = { status: false, msg: msg, data: {}, error: error || {} };
    return res.status(400).json(body);
};

/**
 * 401 — not authenticated. No token, an expired token, a bad signature, or bad
 * credentials at login.
 *
 * Deliberately says nothing about WHICH of those it was: distinguishing "no
 * such user" from "wrong password" tells an attacker which half of a guess was
 * right.
 *
 * @param res - Express response.
 * @param msg - A deliberately non-specific message.
 * @returns The sent response.
 */
const unauthorizedResponse = (res: Response, msg: string): Response => {
    const body: ResponseEnvelope = { status: false, msg: msg, data: {}, error: {} };
    return res.status(401).json(body);
};

/**
 * 404 — the thing addressed does not exist.
 *
 * @param res - Express response.
 * @param msg - What was not found.
 * @param [error] - Optional machine-readable detail, e.g. `{ code: 'NOT_FOUND' }`.
 * @returns The sent response.
 */
const notFoundResponse = (res: Response, msg: string, error?: any): Response => {
    const body: ResponseEnvelope = { status: false, msg: msg, data: {}, error: error || {} };
    return res.status(404).json(body);
};

/**
 * 201 — something was created.
 *
 * @param res - Express response.
 * @param msg - Human-readable confirmation.
 * @param data - The payload (the created thing's view, or a confirmation flag).
 * @returns The sent response.
 */
const createdResponse = (res: Response, msg: string, data: any): Response => {
    const body: ResponseEnvelope = { status: true, msg: msg, data: data, error: {} };
    return res.status(201).json(body);
};

/**
 * 202 — accepted; the work happens after this response.
 *
 * ⚠️ Says only that the request was well-formed and taken. The anonymous flows that answer 202
 * (setup request, forgot password) answer it IDENTICALLY whether or not anything will be sent, so
 * nothing may be added to `data` that depends on the outcome.
 *
 * @param res - Express response.
 * @param msg - The one acknowledgement.
 * @param data - The payload (`{ accepted: true }`).
 * @returns The sent response.
 */
const acceptedResponse = (res: Response, msg: string, data: any): Response => {
    const body: ResponseEnvelope = { status: true, msg: msg, data: data, error: {} };
    return res.status(202).json(body);
};

/**
 * 403 — authenticated, but the caller's role does not allow this.
 *
 * `error.code` is always `'FORBIDDEN'`; the dashboard keys its "Restricted" state on it. `permission`
 * names the catalogue key that was missing when a route policy refused; a refusal from the
 * management rule carries `reason` in `detail` instead and no `permission`.
 *
 * @param res - Express response.
 * @param msg - What the caller is told.
 * @param permission - The missing catalogue key, or `null` when the refusal is not about one key.
 * @param [detail] - Extra primitive fields (e.g. `{ reason }`). `code` and `permission` cannot be overwritten.
 * @returns The sent response.
 */
const forbiddenResponse = (res: Response, msg: string, permission: string | null, detail?: Record<string, unknown> | null): Response => {
    const error: Record<string, unknown> = {};
    if (detail && typeof detail === 'object') {
        for (const key of Object.keys(detail)) {
            error[key] = detail[key];
        }
    }
    if (typeof permission === 'string' && permission) {
        error.permission = permission;
    } else {
        delete error.permission;
    }
    error.code = 'FORBIDDEN';
    const body: ResponseEnvelope = { status: false, msg: msg, data: {}, error: error };
    return res.status(403).json(body);
};

/**
 * 409 — the request conflicts with what is stored (already a member, name taken, already revoked).
 *
 * @param res - Express response.
 * @param msg - What conflicts, specifically enough to act on.
 * @param code - The machine-readable reason.
 * @param [detail] - Extra primitive fields (e.g. `{ user_id, status }`). `code` cannot be overwritten.
 * @returns The sent response.
 */
const conflictResponse = (res: Response, msg: string, code: string, detail?: Record<string, unknown> | null): Response => {
    const error: Record<string, unknown> = {};
    if (detail && typeof detail === 'object') {
        for (const key of Object.keys(detail)) {
            error[key] = detail[key];
        }
    }
    error.code = code;
    const body: ResponseEnvelope = { status: false, msg: msg, data: {}, error: error };
    return res.status(409).json(body);
};

/**
 * 429 — later. A rate limit or a capacity limit refused the request.
 *
 * Sets no `Retry-After`: a limiter that knows its window sets that header itself before calling this.
 *
 * @param res - Express response.
 * @param msg - What the caller is told. Must say nothing about accounts.
 * @param [code] - `RATE_LIMITED` (default) or a more specific capacity code such as `SETUP_CAPACITY`.
 * @returns The sent response.
 */
const tooManyRequestsResponse = (res: Response, msg: string, code?: string): Response => {
    const body: ResponseEnvelope = { status: false, msg: msg, data: {}, error: { code: code || 'RATE_LIMITED' } };
    return res.status(429).json(body);
};

/**
 * 503 — the server could not consult its datastore, so it refused rather than guess.
 *
 * Distinct from 401 on purpose: the dashboard signs the user out on a 401, and a database blip must
 * not sign everyone out. Distinct from 500: nothing is broken in the code, and trying again later is
 * the right action.
 *
 * @param res - Express response.
 * @param msg - What the caller is told.
 * @param [error] - Optional `{ code }` (`DATASTORE_ERROR`, `INDEXES_NOT_READY`).
 * @returns The sent response.
 */
const serviceUnavailableResponse = (res: Response, msg: string, error?: any): Response => {
    const body: ResponseEnvelope = { status: false, msg: msg, data: {}, error: error || {} };
    return res.status(503).json(body);
};

/**
 * 500 — we broke.
 *
 * @param res - Express response.
 * @param msg - What failed, in the operator's terms.
 * @returns The sent response.
 */
const errorResponse = (res: Response, msg: string): Response => {
    const body: ResponseEnvelope = { status: false, msg: msg, data: {}, error: {} };
    return res.status(500).json(body);
};

/**
 * The only shape of a caught error that may reach a client.
 *
 * NEVER SERIALISE THE CAUGHT OBJECT. `promiseHelper` already states the rule — the error is
 * "kept for logs and diagnostics; controllers should not put it on the wire verbatim" — and this
 * function is what makes obeying it the default rather than a thing 30 call sites each remember.
 *
 * What the raw object leaks, verified rather than assumed:
 *   - an **axios** error defines its own `toJSON`, which `JSON.stringify` calls BEFORE any replacer,
 *     and it emits `config.headers` — including `X-Shopify-Access-Token`. That token reads the
 *     operator's entire Partner organisation. No controller reaches that path today; one that
 *     surfaces a sync result inline would, and nothing in the type system would flag it.
 *   - a **Mongoose** ValidationError/CastError emits `path`, `kind`, `valueType` and `stringValue`,
 *     handing a caller the internal field names of a collection.
 *   - any Error emits `stack`, and a stack carries absolute filesystem paths.
 *
 * @param error - The caught error, in whatever form.
 * @returns `{ name, code }` where known, and nothing else.
 */
const _safeErrorShape = (error: any): Record<string, string> => {
    if (!error || typeof error !== 'object') {
        return {};
    }
    const shape: Record<string, string> = {};
    if (typeof error.name === 'string' && error.name) {
        shape.name = error.name;
    }
    // An application error code (`ETIMEDOUT`, a service's own code) is useful and carries nothing.
    if (typeof error.code === 'string' && error.code) {
        shape.code = error.code;
    }
    return shape;
};

/**
 * 500 — we broke, with the CLASS of error attached.
 *
 * Named for what the 30 call sites already say; what actually reaches the client is
 * `_safeErrorShape(error)`, never `error`. Pass a caught error here freely — that is the point of
 * the function — but log it yourself if you need the message, because this does not.
 *
 * @param res - Express response.
 * @param msg - What failed, in the operator's terms. Written for a human, so keep host
 *                       names, queries and collection names out of it.
 * @param error - The caught error. Reduced to `{ name, code }`.
 * @returns The sent response.
 */
const errorResponseWithErrorObject = (res: Response, msg: string, error: any): Response => {
    const body: ResponseEnvelope = { status: false, msg: msg, data: {}, error: _safeErrorShape(error) };
    return res.status(500).json(body);
};

/**
 * True for a value that can go on the wire as refusal detail: a primitive, or a flat array of them.
 *
 * @param value - A field of a service's `error`.
 * @returns Whether it is safe to forward.
 */
const _isWireSafeValue = (value: unknown): boolean => {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return true;
    }
    if (Array.isArray(value)) {
        return value.every((entry) => entry === null || typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean');
    }
    return false;
};

/**
 * The refusal detail a service put in `error`, reduced to flat primitive fields.
 *
 * Services that use a code table promise that `error` never holds an exception. This enforces that
 * promise at the wire rather than trusting it: an object, a Date or a nested document is dropped, so
 * a future service that slips a caught error into `error` leaks nothing through this path.
 *
 * @param error - The service's `error`.
 * @returns A new object holding only the wire-safe fields.
 */
const _wireSafeDetail = (error: unknown): Record<string, unknown> => {
    const detail: Record<string, unknown> = {};
    if (!error || typeof error !== 'object' || Array.isArray(error)) {
        return detail;
    }
    for (const key of Object.keys(error)) {
        const value: unknown = Reflect.get(error, key);
        if (_isWireSafeValue(value)) {
            detail[key] = value;
        }
    }
    return detail;
};

/**
 * Answers a FAILED service result with the HTTP status its `error.code` maps to.
 *
 * The status comes from ONE table the caller passes (for the auth module, `AUTH_ERROR_HTTP_STATUS`),
 * so a controller never re-spells the mapping and two controllers cannot disagree about a code. A
 * code the table does not know, or no code at all, is a 500 — a new refusal must be added to the
 * table in the same change that first returns it.
 *
 * @param res - Express response.
 * @param serviceResponse - The failed envelope (`status: false`).
 * @param statusByCode - `error.code` → HTTP status.
 * @returns The sent response.
 */
const serviceFailureResponse = (
    res: Response,
    serviceResponse: { msg: string; error?: any },
    statusByCode: Readonly<Record<string, number>>
): Response => {
    const msg = serviceResponse.msg;
    const detail = _wireSafeDetail(serviceResponse.error);
    const code = typeof detail.code === 'string' ? detail.code : '';
    const status = code && Object.prototype.hasOwnProperty.call(statusByCode, code) ? statusByCode[code] : 500;

    if (status === 400) {
        return validationErrorResponse(res, msg, detail);
    }
    if (status === 401) {
        // Nothing beyond the message: an authentication refusal says nothing about why.
        return unauthorizedResponse(res, msg);
    }
    if (status === 403) {
        const permission = typeof detail.permission === 'string' ? detail.permission : null;
        return forbiddenResponse(res, msg, permission, detail);
    }
    if (status === 404) {
        return notFoundResponse(res, msg, { code: code });
    }
    if (status === 409) {
        return conflictResponse(res, msg, code, detail);
    }
    if (status === 429) {
        return tooManyRequestsResponse(res, msg, code);
    }
    if (status === 503) {
        return serviceUnavailableResponse(res, msg, { code: code });
    }
    return errorResponseWithErrorObject(res, msg, serviceResponse.error);
};

export = {
    successResponse,
    successResponseWithData,
    successResponseWithDataPagination,
    createdResponse,
    acceptedResponse,
    validationErrorResponse,
    unauthorizedResponse,
    forbiddenResponse,
    notFoundResponse,
    conflictResponse,
    tooManyRequestsResponse,
    serviceUnavailableResponse,
    errorResponse,
    errorResponseWithErrorObject,
    serviceFailureResponse
};
