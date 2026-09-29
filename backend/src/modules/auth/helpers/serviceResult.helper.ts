'use strict';

/**
 * The auth services' failure envelopes, built ONE way.
 *
 * Every business refusal carries `error: { code, ...detail }` where `code` is an `AUTH_ERROR_CODES`
 * value (or a `SESSION_FAILURE_REASONS` value from `loadPrincipal`), so the HTTP layer maps the
 * outcome with one lookup (`AUTH_ERROR_HTTP_STATUS`) instead of reading prose.
 *
 * ⚠️ The HTTP layer may put `error` on the wire as-is for a business refusal (409 ALREADY_A_MEMBER
 * carries `user_id` and `status` by design). So `error` NEVER holds a caught exception here: a
 * thrown error is logged by the service and reduced to `{ code: DATASTORE_ERROR | INTERNAL_ERROR }`.
 * A Mongoose error serialises field paths and values; a stack carries filesystem paths.
 *
 * PURE: no I/O, no config, no clock.
 */

import promiseHelper = require('../../../utils/promiseHelper');
import authConstants = require('../constants/auth.constants');

import type { ServiceResult } from '../../../types/service.types';

const { AUTH_ERROR_CODES, AUTH_MESSAGES } = authConstants;

/**
 * Builds a failure envelope: `status: false`, `data: {}`, `error: { code, ...detail }`.
 *
 * @param code - The `error.code` the HTTP layer maps.
 * @param msg - What the caller is told. Safe to show.
 * @param detail - Extra primitive fields for `error` (never an exception, token, hash or password).
 * @returns The envelope.
 */
const authFailure = (code: string, msg: string, detail?: Record<string, unknown> | null): ServiceResult => {
    const error: Record<string, unknown> = {};
    if (detail && typeof detail === 'object') {
        for (const key of Object.keys(detail)) {
            error[key] = detail[key];
        }
    }
    // Written last so a detail key can never overwrite the code the HTTP layer branches on.
    error.code = code;
    return promiseHelper.promiseReturnResult(false, {}, error, msg);
};

/**
 * Whether a thrown value came from the MongoDB driver or Mongoose (connection loss, server
 * selection, buffering timeout, a server error). Read by name, not `instanceof`, so this file needs
 * neither package — and a duplicate-key error the caller did not expect is still a datastore error.
 *
 * @param error - Anything thrown.
 * @returns True for a `Mongo*` / `Mongoose*` error.
 */
const isDatastoreException = (error: unknown): boolean => {
    if (error === null || typeof error !== 'object') {
        return false;
    }
    const name: unknown = Reflect.get(error, 'name');
    return typeof name === 'string' && /^Mongo/.test(name);
};

/**
 * The failure envelope for an exception a service caught: 503 DATASTORE_ERROR for a datastore
 * error (fail closed, try again), 500 INTERNAL_ERROR for anything else (a bug). The caller logs the
 * exception itself; it never reaches `error`.
 *
 * @param error - The caught value.
 * @returns The envelope.
 */
const exceptionFailure = (error: unknown): ServiceResult => {
    if (isDatastoreException(error)) {
        return authFailure(AUTH_ERROR_CODES.DATASTORE_ERROR, AUTH_MESSAGES.DATASTORE_ERROR);
    }
    return authFailure(AUTH_ERROR_CODES.INTERNAL_ERROR, AUTH_MESSAGES.INTERNAL_ERROR);
};

/**
 * The 400 for a password the policy refused: `error: { code: 'PASSWORD_POLICY', policy_code }` and
 * the rule's own sentence as the message (it describes the rule, never the account).
 *
 * @param policy - The refusal from `password.helper#evaluatePasswordPolicy`.
 * @param policy.code - Which rule refused.
 * @param policy.reason - The sentence to show.
 * @returns The envelope.
 */
const passwordPolicyFailure = (policy: { code: string; reason: string }): ServiceResult => {
    return authFailure(AUTH_ERROR_CODES.PASSWORD_POLICY, policy.reason, { policy_code: policy.code });
};

/**
 * The message for an admin-facing action that ends in an email (invite create / resend, admin
 * password reset). "Sent" means ACCEPTED by the mail server, never delivered.
 *
 * @param params0 - The parameters object.
 * @param params0.accepted - Whether the mail server accepted the message.
 * @param params0.unconfirmed - Whether the deadline passed first (the message may still arrive).
 * @param params0.success_msg - Said when accepted.
 * @param params0.prefix - Said first otherwise (what DID happen: the invite exists, the link exists).
 * @param params0.mail_msg - The mail module's own sentence for the outcome.
 * @param params0.retry_hint - Appended when the message was definitely not sent.
 * @returns The message.
 */
const emailOutcomeMessage = ({ accepted, unconfirmed, success_msg, prefix, mail_msg, retry_hint }: {
    accepted: boolean;
    unconfirmed: boolean;
    success_msg: string;
    prefix: string;
    mail_msg: string;
    retry_hint: string;
}): string => {
    if (accepted) {
        return success_msg;
    }
    const mailSentence = typeof mail_msg === 'string' && mail_msg ? mail_msg : 'The mail server did not accept the message.';
    if (unconfirmed) {
        return `${prefix} ${mailSentence}`;
    }
    return `${prefix} ${mailSentence} ${retry_hint}`;
};

export = {
    authFailure,
    isDatastoreException,
    exceptionFailure,
    passwordPolicyFailure,
    emailOutcomeMessage
};
