'use strict';

/**
 * ============================================================================
 *  MAIL SERVICE — send one templated message, and say how mail is doing
 * ============================================================================
 *
 *  `sendTemplatedEmail` is the only way anything in this codebase sends mail.
 *  It never throws and never rejects; every outcome is a value:
 *
 *      SENT            the mail server ACCEPTED it (never "delivered")
 *      FAILED          the server refused it, or it could not be built
 *      CAP_REACHED     a send cap refused it before the server was contacted
 *      UNCONFIRMED     the caller's deadline passed first; it may still arrive
 *      NOT_CONFIGURED  SMTP_HOST / SMTP_FROM are not set
 *
 *  The sink enforces three rules itself rather than trusting every caller:
 *    - a link must start with `config.APP.PUBLIC_URL` + '/' or nothing is sent
 *      (links come from `buildAppLink`; anything else is a bug that would mail
 *      somebody a link to wherever it points);
 *    - the requesting IP is printed only when `config.APP.TRUST_PROXY` is set —
 *      without it `req.ip` is the dashboard proxy, and the sentence would be false;
 *    - `to` must be a single bare address.
 *
 *  ⚠️ Nothing here logs a link, a token, a message body or the SMTP password.
 *  Logs carry the template, the recipient, the trigger and a coarse error class.
 *
 *  The logger and the SMTP client are called through their module objects, not
 *  destructured at load, so the test suite can stub them.
 * ============================================================================
 */

import config = require('../../../config');
import validate = require('../../../config/validate');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import mailConstants = require('../constants/mail.constants');
import emailTemplateHelper = require('../helpers/emailTemplate.helper');
import mailCapHelper = require('../helpers/mailCap.helper');
import smtpClient = require('../clients/smtp.client');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type {
    BuiltEmail,
    EmailTemplateVars,
    MailCapLimits,
    MailCheckState,
    MailSendEntry,
    MailSendStatus,
    MailStatus,
    MailTrigger,
    MailVerifyData,
    SendTemplatedEmailData,
    SendTemplatedEmailInput
} from '../types/mail.types';

const { promiseReturnResult } = promiseHelper;
const { isBareEmailAddress } = validate;
const { buildEmail } = emailTemplateHelper;
const { evaluateMailCaps, pruneMailSendLog } = mailCapHelper;
const {
    MAIL_TRIGGERS,
    MAIL_SEND_STATUSES,
    MAIL_CHECK_STATES,
    MAIL_MESSAGES,
    ANONYMOUS_CAP_SHARE,
    PER_RECIPIENT_MAX_PER_DAY,
    MAX_SEND_DEADLINE_MS,
    BOOT_VERIFY_DEADLINE_MS,
    TRANSPORT_RECHECK_MIN_INTERVAL_MS
} = mailConstants;

/** What this process knows about the mail server. Never exported as-is; see `getMailStatus`. */
interface MailHealthState {
    last_attempt_at: Date | null;
    last_ok_at: Date | null;
    last_error_class: string | null;
    consecutive_failures: number;
    last_check: MailCheckState;
}

/** Longest server text kept in a log line. */
const MAX_LOGGED_DETAIL = 200;

const KNOWN_TRIGGERS: readonly string[] = Object.values(MAIL_TRIGGERS);

/**
 * Error classes that are about ONE message rather than the server. A recipient the server refuses
 * (550 no such user) proves the connection and the login work, so it must not raise the Users
 * page's "mail is not being delivered" alarm.
 */
const MESSAGE_SPECIFIC_ERROR_CLASSES: readonly string[] = ['EENVELOPE'];

let _health: MailHealthState = {
    last_attempt_at: null,
    last_ok_at: null,
    last_error_class: null,
    consecutive_failures: 0,
    last_check: MAIL_CHECK_STATES.NOT_CHECKED
};

/** Every send charged in the last 24 hours. Bounded by the daily cap. */
let _sendLog: MailSendEntry[] = [];

/**
 * What an ANONYMOUS caller may be told about mail (`GET /api/auth/setup`): the result of the last
 * connect-and-login check only, never of a send.
 *
 * ⚠️ Kept apart from `_health` on purpose. A send happens only for a permitted setup address, so a
 * status that sends update would flip for the pinned owner's address and stay put for everyone
 * else's: reproduced as an oracle for the address setup is restricted to (`probe stranger : ok`,
 * `probe owner : failed`). Only `verifyMailAtBoot` and `recheckTransport`, which never depend on an
 * address, write this.
 */
let _publicCheck: MailCheckState = MAIL_CHECK_STATES.NOT_CHECKED;

/** The re-check in flight, so concurrent callers share one connection. */
let _recheckInFlight: Promise<void> | null = null;

/** When the last re-check started (epoch ms); 0 = never. */
let _lastRecheckStartedAt = 0;

/**
 * The caps, read from config at call time.
 *
 * @returns The limits for `evaluateMailCaps`.
 */
const _limits = (): MailCapLimits => {
    return {
        max_per_hour: config.MAIL.MAX_PER_HOUR,
        max_per_day: config.MAIL.MAX_PER_DAY,
        anonymous_share: ANONYMOUS_CAP_SHARE,
        per_recipient_max_per_day: PER_RECIPIENT_MAX_PER_DAY
    };
};

/**
 * A coarse, secret-free class for a nodemailer error: its code, plus the SMTP reply code when
 * there is one — `EAUTH_535`, `ETIMEDOUT`, `ECONNECTION`.
 *
 * @param error - Whatever the client put in `error`.
 * @returns The class; `UNKNOWN` when there is nothing to classify.
 */
const _errorClass = (error: any): string => {
    if (!error || typeof error !== 'object') {
        return 'UNKNOWN';
    }
    let code = 'UNKNOWN';
    if (typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)) {
        code = error.code;
    }
    if (Number.isInteger(error.responseCode)) {
        return `${code}_${error.responseCode}`;
    }
    return code;
};

/**
 * Server text worth an operator's eyes ("535 Username and Password not accepted"), made safe for a
 * log: one line, capped, token-shaped strings and the configured password removed. Neither ever
 * appears in a server reply; this is the second lock.
 *
 * @param error - Whatever the client put in `error`.
 * @returns The text, or null.
 */
const _safeErrorDetail = (error: any): string | null => {
    if (!error || typeof error !== 'object') {
        return null;
    }
    let raw = '';
    if (typeof error.response === 'string' && error.response) {
        raw = error.response;
    } else if (typeof error.message === 'string') {
        raw = error.message;
    }
    if (!raw) {
        return null;
    }
    let text = raw.replace(/[\r\n\t]+/g, ' ').replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]');
    const secret = config.MAIL.SMTP_PASS;
    if (secret && secret.length >= 4) {
        text = text.split(secret).join('[redacted]');
    }
    return text.slice(0, MAX_LOGGED_DETAIL);
};

/**
 * Records one contact with the server — a boot check or a send that got an answer.
 *
 * @param ok - Whether the server was healthy on this contact.
 * @param errorClass - The failure class, when not ok.
 */
const _recordContact = (ok: boolean, errorClass: string | null): void => {
    const at = new Date();
    _health.last_attempt_at = at;
    if (ok) {
        _health.last_ok_at = at;
        _health.last_error_class = null;
        _health.consecutive_failures = 0;
        _health.last_check = MAIL_CHECK_STATES.OK;
        return;
    }
    _health.last_error_class = errorClass;
    _health.consecutive_failures += 1;
    _health.last_check = MAIL_CHECK_STATES.FAILED;
};

/**
 * Records one connect-and-login check: the admin-facing health AND the public check.
 *
 * @param ok - Whether the check passed.
 * @param errorClass - The failure class, when not ok.
 */
const _recordTransportCheck = (ok: boolean, errorClass: string | null): void => {
    _recordContact(ok, errorClass);
    _publicCheck = ok ? MAIL_CHECK_STATES.OK : MAIL_CHECK_STATES.FAILED;
};

/**
 * What the boot check and a re-check log on success. Says "the login" only when there is one.
 *
 * @returns The sentence.
 */
const _verifyOkMessage = (): string => {
    return config.MAIL.SMTP_USER ? MAIL_MESSAGES.VERIFY_OK : MAIL_MESSAGES.VERIFY_OK_NO_LOGIN;
};

/**
 * Races a client call against a deadline. The call is not cancelled: it keeps going, and whatever
 * handlers are attached to it still run when it settles.
 *
 * @param promise - A client call. Client calls never reject; a rejection is still handled.
 * @param ms - The deadline.
 * @returns The call's envelope, or null when the deadline passed first.
 */
const _withDeadline = (promise: Promise<ServiceResult>, ms: number): Promise<ServiceResult | null> => {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        timer.unref();
        promise.then(
            (result) => {
                clearTimeout(timer);
                resolve(result);
            },
            (error) => {
                clearTimeout(timer);
                resolve(promiseReturnResult(false, {}, error, MAIL_MESSAGES.FAILED));
            }
        );
    });
};

/**
 * The caller's deadline, clamped. Anything unusable means "no deadline".
 *
 * @param deadlineMs - `deadline_ms` as passed.
 * @returns Milliseconds, or 0 for none.
 */
const _resolveDeadline = (deadlineMs: unknown): number => {
    if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= 0) {
        return 0;
    }
    return Math.min(deadlineMs, MAX_SEND_DEADLINE_MS);
};

/**
 * Builds the result envelope. `data` is populated on every branch (see `SendTemplatedEmailData`),
 * and the envelope's `status` is `accepted`.
 *
 * @param status - The outcome.
 * @param msg - What to say.
 * @param messageId - The server's Message-ID, when accepted.
 * @returns The envelope.
 */
const _result = (status: MailSendStatus, msg: string, messageId?: string): ServiceResult<SendTemplatedEmailData> => {
    const accepted = status === MAIL_SEND_STATUSES.SENT;
    const data: SendTemplatedEmailData = { accepted, status };
    if (accepted && messageId) {
        data.message_id = messageId;
    }
    let error: any = {};
    if (!accepted) {
        error = { code: status };
    }
    return promiseReturnResult(accepted, data, error, msg);
};

/**
 * Sends one of the four templated messages.
 *
 * Order: check the request → build the message → enforce the link origin → decide the caps and
 * charge them (synchronously, so two concurrent sends cannot share the last slot) → hand it to the
 * server, racing `deadline_ms` when given. A send that outlives its deadline still updates the mail
 * status and the log when it settles.
 *
 * `vars.public_url` is filled from `config.APP.PUBLIC_URL` here — callers need not pass it — and
 * `vars.ip` is dropped unless `config.APP.TRUST_PROXY` is set.
 *
 * @param identity - The identity object.
 * @param identity.user_id - Who caused the send: the acting user, or a stable sentinel for an anonymous flow.
 * @param params - The send.
 * @param params.to - The address stored on the database row. Never a request-body string.
 * @param params.template - Which message. See EMAIL_TEMPLATES.
 * @param params.vars - What it interpolates. See `EmailTemplateVars`.
 * @param params.trigger - ANONYMOUS | ADMIN | SECURITY. An unknown value is treated as ANONYMOUS, the narrowest share.
 * @param [params.deadline_ms] - Admin-facing sends pass ADMIN_SEND_DEADLINE_MS.
 * @returns Always resolves. `data` is `{ accepted, status, message_id? }` on every branch; the
 * envelope's `status` equals `accepted`.
 */
const sendTemplatedEmail = (
    identity: IdentityObject,
    params: SendTemplatedEmailInput
): Promise<ServiceResult<SendTemplatedEmailData>> => {
    return new Promise(async (resolve) => {
        // Hoisted for the outer catch's log line.
        let template: SendTemplatedEmailInput['template'] | null = null;
        try {
            // Destructured HERE, not in the signature: destructuring a missing argument in the
            // signature throws synchronously, before this promise exists, and callers are entitled to
            // `.then` this without a `.catch` (several send from `setImmediate`, where a throw is an
            // uncaught exception).
            const { user_id } = identity || ({} as IdentityObject);
            const { to, template: requestedTemplate, vars, trigger, deadline_ms } = params || ({} as SendTemplatedEmailInput);
            template = requestedTemplate || null;

            if (!user_id) {
                logger.customConsoleError('ERROR: mail sendTemplatedEmail — no identity; refusing to send', { template });
                return resolve(_result(MAIL_SEND_STATUSES.FAILED, 'User ID not available.'));
            }
            if (!isBareEmailAddress(to)) {
                logger.customConsoleError('ERROR: mail sendTemplatedEmail — recipient is not a single bare address; refusing to send', {
                    template,
                    requested_by: user_id
                });
                return resolve(_result(MAIL_SEND_STATUSES.FAILED, MAIL_MESSAGES.INVALID_RECIPIENT));
            }
            if (!config.MAIL.ENABLED) {
                logger.customConsoleWarn('WARN: mail: not sent — email is not configured (SMTP_HOST / SMTP_FROM)', { template, to });
                return resolve(_result(MAIL_SEND_STATUSES.NOT_CONFIGURED, MAIL_MESSAGES.NOT_CONFIGURED));
            }

            let effectiveTrigger: MailTrigger = trigger;
            if (!KNOWN_TRIGGERS.includes(trigger)) {
                logger.customConsoleWarn('WARN: mail sendTemplatedEmail — unknown trigger; charging it as ANONYMOUS', { template });
                effectiveTrigger = MAIL_TRIGGERS.ANONYMOUS;
            }

            const renderVars: EmailTemplateVars = {
                ...vars,
                public_url: config.APP.PUBLIC_URL || null,
                ip: config.APP.TRUST_PROXY && vars ? vars.ip : null
            };

            // A link that did not come from APP_PUBLIC_URL is refused, not sent. `+ '/'` so that
            // https://analytics.example.com cannot be satisfied by https://analytics.example.com.evil.
            if (renderVars.link !== undefined && renderVars.link !== null) {
                const origin = config.APP.PUBLIC_URL;
                if (!origin || typeof renderVars.link !== 'string' || !renderVars.link.startsWith(`${origin}/`)) {
                    logger.customConsoleError('ERROR: mail sendTemplatedEmail — link does not start with APP_PUBLIC_URL; refusing to send', {
                        template,
                        to
                    });
                    return resolve(_result(MAIL_SEND_STATUSES.FAILED, MAIL_MESSAGES.BUILD_FAILED));
                }
            }

            let built: BuiltEmail;
            try {
                built = buildEmail(requestedTemplate, renderVars);
            } catch (buildError) {
                // The helper's messages name the variable, never its value.
                logger.customConsoleError('ERROR: mail sendTemplatedEmail — message could not be built', {
                    template,
                    reason: buildError instanceof TypeError ? buildError.message : 'unexpected error'
                });
                return resolve(_result(MAIL_SEND_STATUSES.FAILED, MAIL_MESSAGES.BUILD_FAILED));
            }

            // ── Caps: decide and charge with no await in between ────────────
            const recipient = to.toLowerCase();
            const nowMs = Date.now();
            _sendLog = pruneMailSendLog(_sendLog, nowMs);
            const decision = evaluateMailCaps(_sendLog, {
                now_ms: nowMs,
                trigger: effectiveTrigger,
                recipient,
                limits: _limits()
            });
            if (!decision.allowed) {
                logger.customConsoleWarn('WARN: mail: not sent — send cap reached', {
                    template,
                    to,
                    trigger: effectiveTrigger,
                    cap: decision.reason
                });
                return resolve(_result(MAIL_SEND_STATUSES.CAP_REACHED, MAIL_MESSAGES.CAP_REACHED));
            }
            _sendLog.push({ at_ms: nowMs, trigger: effectiveTrigger, recipient });

            let settledAfterDeadline = false;
            const sendPromise: Promise<ServiceResult> = smtpClient.sendRaw({
                to,
                subject: built.subject,
                text: built.text,
                html: built.html
            }).then((sent) => {
                // Runs whether or not the caller is still waiting — the status and the log must
                // reflect a send that finished after its deadline too.
                try {
                    if (sent.status) {
                        _recordContact(true, null);
                        logger.customConsoleLog('INFO: mail: message accepted by the mail server', {
                            template,
                            to,
                            trigger: effectiveTrigger,
                            message_id: sent.data && sent.data.message_id,
                            after_deadline: settledAfterDeadline
                        });
                    } else {
                        const errorClass = _errorClass(sent.error);
                        const messageSpecific = MESSAGE_SPECIFIC_ERROR_CLASSES.some((prefix) => errorClass.startsWith(prefix));
                        _recordContact(messageSpecific, errorClass);
                        logger.customConsoleError('ERROR: mail: the mail server did not accept the message', {
                            template,
                            to,
                            trigger: effectiveTrigger,
                            error_class: errorClass,
                            server_said: _safeErrorDetail(sent.error),
                            after_deadline: settledAfterDeadline
                        });
                    }
                } catch (recordError) {
                    // Never let bookkeeping reject a promise nobody may be awaiting any more.
                }
                return sent;
            });

            const deadline = _resolveDeadline(deadline_ms);
            let outcome: ServiceResult | null;
            if (deadline) {
                outcome = await _withDeadline(sendPromise, deadline);
            } else {
                outcome = await sendPromise;
            }

            if (!outcome) {
                settledAfterDeadline = true;
                logger.customConsoleWarn('WARN: mail: the mail server did not confirm within the deadline; the message may still arrive', {
                    template,
                    to,
                    deadline_ms: deadline
                });
                return resolve(_result(MAIL_SEND_STATUSES.UNCONFIRMED, MAIL_MESSAGES.UNCONFIRMED));
            }
            if (outcome.status) {
                return resolve(_result(MAIL_SEND_STATUSES.SENT, MAIL_MESSAGES.SENT, outcome.data && outcome.data.message_id));
            }
            return resolve(_result(MAIL_SEND_STATUSES.FAILED, MAIL_MESSAGES.FAILED));
        } catch (error) {
            logger.customConsoleError('ERROR: mail sendTemplatedEmail', { template, error_class: _errorClass(error) });
            return resolve(_result(MAIL_SEND_STATUSES.FAILED, MAIL_MESSAGES.FAILED));
        }
    });
};

/**
 * Checks the mail server once at boot — connect, TLS, login — and records the result for
 * `getMailStatus`. Bounded by BOOT_VERIFY_DEADLINE_MS; a later answer is still recorded.
 *
 * NON-FATAL by design: a mail server that is down at boot must not take sign-in down with it.
 *
 * @returns Always resolves, `status` = the check passed, `data` = `{ ok, checked_at, error_class }`.
 */
const verifyMailAtBoot = (): Promise<ServiceResult<MailVerifyData>> => {
    return new Promise(async (resolve) => {
        const checkedAt = new Date();
        try {
            if (!config.MAIL.ENABLED) {
                logger.customConsoleWarn('WARN: mail: not configured — setup verification, invitations and password resets cannot be sent');
                const data: MailVerifyData = { ok: false, checked_at: checkedAt, error_class: 'NOT_CONFIGURED' };
                return resolve(promiseReturnResult(false, data, { code: 'NOT_CONFIGURED' }, MAIL_MESSAGES.NOT_CONFIGURED));
            }

            const verifyPromise: Promise<ServiceResult> = smtpClient.verifyTransport().then((checked) => {
                try {
                    if (checked.status) {
                        _recordTransportCheck(true, null);
                        logger.customConsoleLog(`INFO: mail: ${_verifyOkMessage()}`);
                    } else {
                        const errorClass = _errorClass(checked.error);
                        _recordTransportCheck(false, errorClass);
                        logger.customConsoleWarn('WARN: mail: the mail server check failed — emails will not be delivered until this is fixed', {
                            error_class: errorClass,
                            server_said: _safeErrorDetail(checked.error)
                        });
                    }
                } catch (recordError) {
                    // See sendTemplatedEmail.
                }
                return checked;
            });

            const outcome = await _withDeadline(verifyPromise, BOOT_VERIFY_DEADLINE_MS);
            if (!outcome) {
                logger.customConsoleWarn('WARN: mail: the mail server did not answer the boot check in time; its answer will be recorded when it arrives', {
                    deadline_ms: BOOT_VERIFY_DEADLINE_MS
                });
                const data: MailVerifyData = { ok: false, checked_at: checkedAt, error_class: 'BOOT_CHECK_TIMEOUT' };
                return resolve(promiseReturnResult(false, data, { code: 'BOOT_CHECK_TIMEOUT' }, MAIL_MESSAGES.VERIFY_FAILED));
            }
            if (outcome.status) {
                const data: MailVerifyData = { ok: true, checked_at: checkedAt, error_class: null };
                return resolve(promiseReturnResult(true, data, {}, _verifyOkMessage()));
            }
            const errorClass = _errorClass(outcome.error);
            const data: MailVerifyData = { ok: false, checked_at: checkedAt, error_class: errorClass };
            return resolve(promiseReturnResult(false, data, { code: errorClass }, MAIL_MESSAGES.VERIFY_FAILED));
        } catch (error) {
            logger.customConsoleError('ERROR: mail verifyMailAtBoot', { error_class: _errorClass(error) });
            const data: MailVerifyData = { ok: false, checked_at: checkedAt, error_class: _errorClass(error) };
            return resolve(promiseReturnResult(false, data, { code: data.error_class }, MAIL_MESSAGES.VERIFY_FAILED));
        }
    });
};

/**
 * Re-checks the mail server (connect, TLS, login) and records the result, including the public
 * check. The anonymous setup flow calls it for EVERY request, permitted address or not, so what
 * `GET /api/auth/setup` shows can move without saying anything about the address.
 *
 * Coalesced: one check in flight at a time, and at most one started per
 * TRANSPORT_RECHECK_MIN_INTERVAL_MS. Never rejects; does nothing when mail is not configured.
 *
 * @returns Resolves when this call's check (or the one it joined) has been recorded, or at once when skipped.
 */
const recheckTransport = (): Promise<void> => {
    try {
        if (!config.MAIL.ENABLED) {
            return Promise.resolve();
        }
        if (_recheckInFlight) {
            return _recheckInFlight;
        }
        const nowMs = Date.now();
        if (_lastRecheckStartedAt !== 0 && nowMs - _lastRecheckStartedAt < TRANSPORT_RECHECK_MIN_INTERVAL_MS) {
            return Promise.resolve();
        }
        _lastRecheckStartedAt = nowMs;
        const inFlight: Promise<void> = smtpClient.verifyTransport().then((checked) => {
            try {
                if (checked.status) {
                    _recordTransportCheck(true, null);
                    return;
                }
                const errorClass = _errorClass(checked.error);
                _recordTransportCheck(false, errorClass);
                logger.customConsoleWarn('WARN: mail: the mail server check failed — emails will not be delivered until this is fixed', {
                    error_class: errorClass,
                    server_said: _safeErrorDetail(checked.error)
                });
            } catch (recordError) {
                // See sendTemplatedEmail.
            }
        }, () => {
            // verifyTransport never rejects; nothing is recorded if a future change makes it.
        }).finally(() => {
            _recheckInFlight = null;
        });
        _recheckInFlight = inFlight;
        return inFlight;
    } catch (error) {
        logger.customConsoleError('ERROR: mail recheckTransport', { error_class: _errorClass(error) });
        return Promise.resolve();
    }
};

/**
 * What an anonymous caller may be told about mail: the last connect-and-login check, never a send's
 * outcome (see `_publicCheck`). Synchronous.
 *
 * @returns 'ok' | 'failed' | 'not_checked'.
 */
const getPublicMailCheck = (): MailCheckState => {
    return _publicCheck;
};

/**
 * What the dashboard may know about mail right now. Synchronous; reads module state only.
 *
 * @returns `{ configured, last_check, last_ok_at, consecutive_failures }` — never the host, the
 * login or the sender.
 */
const getMailStatus = (): MailStatus => {
    return {
        configured: config.MAIL.ENABLED,
        last_check: _health.last_check,
        last_ok_at: _health.last_ok_at,
        consecutive_failures: _health.consecutive_failures
    };
};

/**
 * Clears the send ledger and the recorded status. For the test suite, which exercises caps and
 * status transitions in one process — the same reason `createLoginRateLimiter` is exported.
 */
const resetMailState = (): void => {
    _health = {
        last_attempt_at: null,
        last_ok_at: null,
        last_error_class: null,
        consecutive_failures: 0,
        last_check: MAIL_CHECK_STATES.NOT_CHECKED
    };
    _sendLog = [];
    _publicCheck = MAIL_CHECK_STATES.NOT_CHECKED;
    _recheckInFlight = null;
    _lastRecheckStartedAt = 0;
};

export = {
    sendTemplatedEmail,
    verifyMailAtBoot,
    recheckTransport,
    getMailStatus,
    getPublicMailCheck,
    resetMailState
};
