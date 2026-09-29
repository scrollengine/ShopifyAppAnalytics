'use strict';

/**
 * ============================================================================
 *  AUTH MAIL — how the auth services hand a message to the mail module
 * ============================================================================
 *
 *  One wrapper, so every flow reads a send's outcome the same way:
 *  `{ accepted, status, unconfirmed, msg }`, where `accepted` means the mail
 *  server ACCEPTED the message — never "delivered".
 *
 *  Callers pass `to` from the DATABASE ROW (never a request-body string) and a
 *  `link` from `authToken.service#buildAppLink` (never composed here). The mail
 *  module is called through its barrel OBJECT at call time, so a test can stub
 *  `sendTemplatedEmail` on it.
 *
 *  Internal to the auth services; not in the barrel.
 * ============================================================================
 */

import logger = require('../../../core/logger');
import mailModule = require('../../mail');

import type { IdentityObject } from '../../../types/service.types';

/** What a send came to, read one way by every flow. */
interface AuthEmailOutcome {
    accepted: boolean;
    /** SENT | FAILED | CAP_REACHED | UNCONFIRMED | NOT_CONFIGURED. */
    status: string;
    /** The deadline passed first; the message may still arrive. */
    unconfirmed: boolean;
    /** The mail module's own sentence for the outcome (safe to show an operator). */
    msg: string;
}

/**
 * Sends one templated message and reports the outcome. Never throws.
 *
 * @param params0 - The parameters object.
 * @param params0.identity - Who caused the send (a user, or an `AUTH_SERVICE_ACTORS` sentinel).
 * @param params0.to - The address ON THE DATABASE ROW.
 * @param params0.template - One of the mail module's `EMAIL_TEMPLATES`.
 * @param params0.vars - The template variables (`now`, `expires_at`, `link`, `ip`, …).
 * @param params0.trigger - ANONYMOUS | ADMIN | SECURITY (decides the cap share).
 * @param params0.deadline_ms - Admin-facing sends pass `ADMIN_SEND_DEADLINE_MS`.
 * @returns `{ accepted, status, unconfirmed, msg }`.
 */
const sendAuthEmail = async ({ identity, to, template, vars, trigger, deadline_ms }: {
    identity: IdentityObject;
    to: string;
    template: string;
    vars: { now: Date; expires_at?: Date | null; link?: string | null; ip?: string | null; inviter_name?: string | null; role_label?: string | null };
    trigger: string;
    deadline_ms?: number;
}): Promise<AuthEmailOutcome> => {
    const failed = mailModule.MAIL_SEND_STATUSES.FAILED;
    try {
        const templateKey = Object.values(mailModule.EMAIL_TEMPLATES).find((key) => key === template);
        const triggerKey = Object.values(mailModule.MAIL_TRIGGERS).find((key) => key === trigger);
        if (!templateKey || !triggerKey) {
            logger.customConsoleError('ERROR: auth sendAuthEmail — unknown template or trigger; nothing sent', { template: template, trigger: trigger });
            return { accepted: false, status: failed, unconfirmed: false, msg: '' };
        }
        const result = await mailModule.sendTemplatedEmail(identity, {
            to: to,
            template: templateKey,
            vars: vars,
            trigger: triggerKey,
            deadline_ms: deadline_ms
        });
        const data = result && result.data && typeof result.data === 'object' ? result.data : null;
        const status = data && typeof data.status === 'string' ? data.status : failed;
        const accepted = Boolean(result && result.status === true && data && data.accepted === true);
        return {
            accepted: accepted,
            status: status,
            unconfirmed: status === mailModule.MAIL_SEND_STATUSES.UNCONFIRMED,
            msg: result && typeof result.msg === 'string' ? result.msg : ''
        };
    } catch (error) {
        logger.customConsoleError('ERROR: auth sendAuthEmail — the mail module threw; treating the message as not sent', {
            template: template,
            error_name: error instanceof Error ? error.name : typeof error
        });
        return { accepted: false, status: failed, unconfirmed: false, msg: '' };
    }
};

/**
 * Queues the "your password was changed" notice (SECURITY trigger) AFTER the caller has resolved,
 * so SMTP latency never holds a response. Best-effort: the outcome is logged, nothing else.
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user whose password changed (the send's identity).
 * @param params0.to - Their address, from the database row.
 * @param params0.now - When it changed.
 * @param params0.ip - The requesting address, when known.
 * @returns Nothing; the send runs on the next turn of the event loop.
 */
const queuePasswordChangedNotice = ({ user_id, to, now, ip }: { user_id: string; to: string; now: Date; ip: string | null }): void => {
    setImmediate(() => {
        sendAuthEmail({
            identity: { user_id: user_id },
            to: to,
            template: mailModule.EMAIL_TEMPLATES.PASSWORD_CHANGED,
            vars: { now: now, ip: ip },
            trigger: mailModule.MAIL_TRIGGERS.SECURITY
        }).then((outcome) => {
            logger.customConsoleLog('INFO: auth: password-changed notice send attempt finished (email_status says whether the mail server accepted it)', { user_id: user_id, email_status: outcome.status });
        }).catch(() => {
            // sendAuthEmail never rejects; this only keeps a future change from becoming an unhandled rejection.
        });
    });
};

export = {
    sendAuthEmail,
    queuePasswordChangedNotice
};
