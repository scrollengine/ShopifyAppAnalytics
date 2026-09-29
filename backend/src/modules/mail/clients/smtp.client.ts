'use strict';

/**
 * ============================================================================
 *  SMTP CLIENT — the only code in this repository that talks to a mail server
 * ============================================================================
 *
 *  One nodemailer transport, created LAZILY on first use from `config.MAIL` and
 *  kept for the life of the process. Never at import: CI loads every module
 *  barrel in a fresh process with an EMPTY environment, and the scripts load
 *  modules without ever sending mail.
 *
 *  Transport security, fixed here rather than left to defaults:
 *    - `requireTLS` whenever the connection is not implicit TLS, so a server
 *      (or anything in the path) that drops STARTTLS gets a refusal, not the
 *      password in plain text. Nodemailer's default is opportunistic.
 *    - `rejectUnauthorized: true` and TLS 1.2 minimum.
 *    - `SMTP_ALLOW_INSECURE=true` lifts the first two, for a local test relay
 *      only; validation warns loudly while it is set.
 *    - Connection, greeting and socket timeouts in seconds, not nodemailer's
 *      minutes, so a dead server cannot hold a request open.
 *    - `disableFileAccess` / `disableUrlAccess`: no message here has an
 *      attachment, so nothing may make nodemailer read a file or fetch a URL.
 *
 *  Both functions resolve the house envelope and never reject. On failure the
 *  `error` is nodemailer's own error object, for `mail.service` to classify —
 *  it is never logged here and never sent anywhere.
 * ============================================================================
 */

import nodemailer = require('nodemailer');
import config = require('../../../config');
import promiseHelper = require('../../../utils/promiseHelper');

import type { SMTPSentMessageInfo, SMTPTransportOptions, Transporter } from 'nodemailer';
import type { ServiceResult } from '../../../types/service.types';
import type { SendRawData, SendRawInput } from '../types/mail.types';

const { promiseReturnResult } = promiseHelper;

let _transport: Transporter<SMTPSentMessageInfo, SMTPTransportOptions> | null = null;

/**
 * The transport options, from config. The password is placed here and nowhere else.
 *
 * @returns Options for `nodemailer.createTransport`.
 */
const _buildTransportOptions = (): SMTPTransportOptions => {
    const secure = config.MAIL.SMTP_SECURE;
    const allowInsecure = config.MAIL.SMTP_ALLOW_INSECURE;

    const options: SMTPTransportOptions = {
        host: config.MAIL.SMTP_HOST,
        port: config.MAIL.SMTP_PORT,
        secure: secure,
        requireTLS: !secure && !allowInsecure,
        tls: {
            rejectUnauthorized: !allowInsecure,
            minVersion: 'TLSv1.2'
        },
        connectionTimeout: config.MAIL.CONNECTION_TIMEOUT_MS,
        greetingTimeout: config.MAIL.GREETING_TIMEOUT_MS,
        socketTimeout: config.MAIL.SOCKET_TIMEOUT_MS,
        disableFileAccess: true,
        disableUrlAccess: true,
        // Nodemailer's protocol logger would write the AUTH exchange. Off, unconditionally.
        logger: false,
        debug: false
    };
    // Both or neither — validation refuses one without the other. An auth-less relay gets no
    // `auth` key at all rather than empty strings, which nodemailer would try to log in with.
    if (config.MAIL.SMTP_USER && config.MAIL.SMTP_PASS) {
        options.auth = { user: config.MAIL.SMTP_USER, pass: config.MAIL.SMTP_PASS };
    }
    return options;
};

/**
 * The transport, created on first call. Creating one opens no connection — nodemailer connects per
 * message — so the first caller pays nothing extra.
 *
 * @returns The shared transport.
 */
const _getTransport = (): Transporter<SMTPSentMessageInfo, SMTPTransportOptions> => {
    if (!_transport) {
        _transport = nodemailer.createTransport(_buildTransportOptions());
    }
    return _transport;
};

/**
 * Connects, negotiates TLS and logs in, without sending anything.
 *
 * @returns `status: true` when the server accepted the connection and (if configured) the login;
 * otherwise `status: false` with nodemailer's error in `error`.
 */
const verifyTransport = (): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            if (!config.MAIL.ENABLED) {
                return resolve(promiseReturnResult(false, {}, { code: 'NOT_CONFIGURED' }, 'Email is not configured.'));
            }
            await _getTransport().verify();
            return resolve(promiseReturnResult(true, {}, {}, 'The mail server accepted the connection.'));
        } catch (error) {
            return resolve(promiseReturnResult(false, {}, error, 'The mail server check failed.'));
        }
    });
};

/**
 * Hands one message to the mail server.
 *
 * `to` is passed as an address OBJECT, not a string: a string goes through nodemailer's address
 * parser, which reads `a@x.com, b@y.com` as two recipients. The caller has already checked it is a
 * single bare address; this is the second lock on the same door.
 *
 * @param params0 - The message.
 * @param params0.to - One bare address.
 * @param params0.subject - Fixed subject.
 * @param params0.text - Plain-text part.
 * @param params0.html - HTML part.
 * @returns `status: true` with `{ message_id }` when the server accepted the message for `to`;
 * otherwise `status: false` with the error.
 */
const sendRaw = ({ to, subject, text, html }: SendRawInput): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            if (!config.MAIL.ENABLED) {
                return resolve(promiseReturnResult(false, {}, { code: 'NOT_CONFIGURED' }, 'Email is not configured.'));
            }
            const info = await _getTransport().sendMail({
                from: { name: config.MAIL.SMTP_FROM_NAME, address: config.MAIL.SMTP_FROM },
                to: { name: '', address: to },
                subject,
                text,
                html,
                headers: {
                    // RFC 3834: tells auto-responders (vacation replies, ticket systems) not to answer.
                    'Auto-Submitted': 'auto-generated'
                }
            });

            const accepted = Array.isArray(info.accepted) && info.accepted.length > 0;
            const rejected = Array.isArray(info.rejected) && info.rejected.length > 0;
            if (!accepted || rejected) {
                return resolve(promiseReturnResult(false, {}, { code: 'EENVELOPE', responseCode: null }, 'The mail server refused the recipient.'));
            }

            const data: SendRawData = { message_id: String(info.messageId || '') };
            return resolve(promiseReturnResult(true, data, {}, 'The mail server accepted the message.'));
        } catch (error) {
            return resolve(promiseReturnResult(false, {}, error, 'The mail server did not accept the message.'));
        }
    });
};

export = {
    verifyTransport,
    sendRaw
};
