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
 *  This build has no such legacy, so: 401 means not authenticated, 404 means
 *  not found, 400 means the request was wrong, 500 means we broke. The envelope
 *  carries the detail; the status code carries the class.
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
 * @returns The sent response.
 */
const notFoundResponse = (res: Response, msg: string): Response => {
    const body: ResponseEnvelope = { status: false, msg: msg, data: {}, error: {} };
    return res.status(404).json(body);
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

export = {
    successResponse,
    successResponseWithData,
    successResponseWithDataPagination,
    validationErrorResponse,
    unauthorizedResponse,
    notFoundResponse,
    errorResponse,
    errorResponseWithErrorObject
};
