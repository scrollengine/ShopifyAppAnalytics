/**
 * Shapes for the mail module: the template variables, the send request and its outcome, and the
 * status the Users page and the setup screen read.
 *
 * Declarations only — no runtime imports, so importing this file loads neither nodemailer nor
 * config.
 */

type MailConstantsModule = typeof import('../constants/mail.constants');

/** `'SETUP_VERIFY' | 'INVITE' | 'PASSWORD_RESET' | 'PASSWORD_CHANGED'`. */
export type EmailTemplateKey = MailConstantsModule['EMAIL_TEMPLATES'][keyof MailConstantsModule['EMAIL_TEMPLATES']];

/** `'ANONYMOUS' | 'ADMIN' | 'SECURITY'`. */
export type MailTrigger = MailConstantsModule['MAIL_TRIGGERS'][keyof MailConstantsModule['MAIL_TRIGGERS']];

/** `'SENT' | 'FAILED' | 'CAP_REACHED' | 'UNCONFIRMED' | 'NOT_CONFIGURED'`. */
export type MailSendStatus = MailConstantsModule['MAIL_SEND_STATUSES'][keyof MailConstantsModule['MAIL_SEND_STATUSES']];

/** `'ok' | 'failed' | 'not_checked'`. */
export type MailCheckState = MailConstantsModule['MAIL_CHECK_STATES'][keyof MailConstantsModule['MAIL_CHECK_STATES']];

/** Which limit refused a send. */
export type MailCapReason = MailConstantsModule['MAIL_CAP_REASONS'][keyof MailConstantsModule['MAIL_CAP_REASONS']];

/**
 * Everything a template may interpolate. Which fields a template REQUIRES:
 *
 *   SETUP_VERIFY      now, link, expires_at
 *   INVITE            now, link, expires_at, inviter_name, role_label
 *   PASSWORD_RESET    now, link, expires_at
 *   PASSWORD_CHANGED  now
 *
 * Every value is HTML-escaped in the HTML part and stripped of control and bidi-override
 * characters in both parts.
 */
export interface EmailTemplateVars {
    /** The moment the message describes (the request, or the change). Passed in: the helper reads no clock. */
    now: Date;
    /** When the link stops working. Shown as a duration from `now` plus an ISO-8601 UTC timestamp. */
    expires_at?: Date | null;
    /**
     * The finished link, exactly as `buildAppLink` formed it from `config.APP.PUBLIC_URL`. Mail never
     * composes a URL; it only places this one. Must be absolute http(s).
     */
    link?: string | null;
    /** This install's public address, shown so the reader can tell which install wrote. Display only. */
    public_url?: string | null;
    /**
     * The requesting address. Pass it ONLY when `config.APP.TRUST_PROXY` is set and `clientIp(req)`
     * is non-null — otherwise it is the proxy's address, and printing it would state something false.
     */
    ip?: string | null;
    /** INVITE: the inviter's display name. */
    inviter_name?: string | null;
    /** INVITE: the role label the invitation grants. */
    role_label?: string | null;
}

/** A rendered message. The plain-text part is always present. */
export interface BuiltEmail {
    subject: string;
    text: string;
    html: string;
}

/** The request `sendTemplatedEmail` takes as its second parameter. */
export interface SendTemplatedEmailInput {
    /** The address stored on the database row — never a string from the request body. */
    to: string;
    template: EmailTemplateKey;
    vars: EmailTemplateVars;
    /** Who caused the send; decides the cap share. See MAIL_TRIGGERS. */
    trigger: MailTrigger;
    /**
     * Admin-facing sends pass `ADMIN_SEND_DEADLINE_MS`: past it the call resolves UNCONFIRMED while the
     * send carries on. Omitted for background sends, which rely on the socket timeouts.
     */
    deadline_ms?: number;
}

/**
 * The outcome of one send — ALWAYS present in `data`, on every branch.
 *
 * ⚠️ A deliberate exception to the `{}`-on-failure envelope rule: a caller needs `status` to tell
 * the admin (or the audit log) WHY a message was not sent, and `{ accepted: false, status: … }`
 * cannot be misread as a success the way a partial payload can. The envelope's own `status`
 * equals `accepted`.
 */
export interface SendTemplatedEmailData {
    /** True only when the mail server accepted the message. Never "delivered". */
    accepted: boolean;
    status: MailSendStatus;
    /** The server-assigned Message-ID, when accepted. */
    message_id?: string;
}

/**
 * What the dashboard may know about mail. Never the host, the login or the sender — this is served
 * to every signed-in user who can see the Users page, and to the anonymous setup screen in part.
 */
export interface MailStatus {
    /** `config.MAIL.ENABLED`. */
    configured: boolean;
    /** The last contact with the server: a boot check or a real send. */
    last_check: MailCheckState;
    /** When the server last accepted a connection or a message. Null until it has. */
    last_ok_at: Date | null;
    /** Checks and sends that have failed in a row since the last success. */
    consecutive_failures: number;
}

/** The boot check's result, as recorded. */
export interface MailVerifyData {
    ok: boolean;
    checked_at: Date;
    /** A coarse error class (`EAUTH`, `ETIMEDOUT`, `NOT_CONFIGURED`, …). Never a message that could carry a secret. */
    error_class: string | null;
}

/** One message for the SMTP client. `to` is a single bare address, already checked. */
export interface SendRawInput {
    to: string;
    subject: string;
    text: string;
    html: string;
}

/** What the SMTP client reports for an accepted message. */
export interface SendRawData {
    message_id: string;
}

/** One charged send, as the cap ledger remembers it. */
export interface MailSendEntry {
    /** Epoch milliseconds when the send was charged. */
    at_ms: number;
    trigger: MailTrigger;
    /** The recipient, lowercased. */
    recipient: string;
}

/** The limits a cap decision is made against. */
export interface MailCapLimits {
    max_per_hour: number;
    max_per_day: number;
    /** 0..1 — the share of each cap ANONYMOUS sends may use. */
    anonymous_share: number;
    per_recipient_max_per_day: number;
}

/** A cap decision. `reason` is null exactly when `allowed`. */
export interface MailCapDecision {
    allowed: boolean;
    reason: MailCapReason | null;
}
