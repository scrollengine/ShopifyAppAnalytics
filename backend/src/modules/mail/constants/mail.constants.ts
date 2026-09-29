'use strict';

/**
 * ============================================================================
 *  MAIL — module vocabulary and fixed limits
 * ============================================================================
 *
 *  Everything an operator tunes lives in `config.MAIL` (server, sender, the
 *  hour/day caps). What is here is fixed on purpose: the template names, the
 *  subjects, and the limits whose job is to stop this install being used to
 *  send mail at somebody — a knob on those is a way to switch the protection
 *  off, not a way to fit a deployment.
 *
 *  Dependency-free, so the pure helpers built on it test without standing
 *  anything up.
 * ============================================================================
 */

/** The four messages this install ever sends. Nothing composes a free-form email. */
const EMAIL_TEMPLATES = Object.freeze({
    /** First-run setup: confirms the owner's address. Never carries the name the requester typed. */
    SETUP_VERIFY: 'SETUP_VERIFY',
    /** An invitation: who invited you, with which role, and the accept link. */
    INVITE: 'INVITE',
    /** A password-reset link, from forgot-password or sent by an admin. */
    PASSWORD_RESET: 'PASSWORD_RESET',
    /** Notice that a password changed. Carries no link. */
    PASSWORD_CHANGED: 'PASSWORD_CHANGED'
} as const);

/**
 * Subjects are fixed strings. Nothing a requester typed ever reaches a subject line, which is the
 * part of a message a mail client shows before anyone decides whether to trust it.
 */
const EMAIL_SUBJECTS = Object.freeze({
    SETUP_VERIFY: 'Confirm your email to finish setting up Shopify App Analytics',
    INVITE: 'You have been invited to Shopify App Analytics',
    PASSWORD_RESET: 'Reset your Shopify App Analytics password',
    PASSWORD_CHANGED: 'Your Shopify App Analytics password was changed'
} as const);

/** The button text for the templates that carry a link. */
const EMAIL_ACTION_LABELS = Object.freeze({
    SETUP_VERIFY: 'Confirm and choose a password',
    INVITE: 'Accept the invitation',
    PASSWORD_RESET: 'Choose a new password'
} as const);

/** The product name as it appears in message bodies. */
const PRODUCT_NAME = 'Shopify App Analytics';

/**
 * WHO caused a send, which decides which share of the caps it may use.
 *
 * ANONYMOUS is anything an unauthenticated request can trigger (setup verification, forgot-password).
 * It gets HALF of each hour/day cap and half of each recipient's daily cap, so nobody outside can
 * spend the budget that an invitation or a security notice needs.
 */
const MAIL_TRIGGERS = Object.freeze({
    ANONYMOUS: 'ANONYMOUS',
    ADMIN: 'ADMIN',
    SECURITY: 'SECURITY'
} as const);

/**
 * The outcome of one send. SENT means the mail server ACCEPTED the message — never that it was
 * delivered; nothing here can know that.
 */
const MAIL_SEND_STATUSES = Object.freeze({
    SENT: 'SENT',
    FAILED: 'FAILED',
    CAP_REACHED: 'CAP_REACHED',
    /** A deadline passed before the server answered. The message may still arrive. */
    UNCONFIRMED: 'UNCONFIRMED',
    NOT_CONFIGURED: 'NOT_CONFIGURED'
} as const);

/** What the last contact with the mail server said. Wire values — the frontend reads them. */
const MAIL_CHECK_STATES = Object.freeze({
    OK: 'ok',
    FAILED: 'failed',
    NOT_CHECKED: 'not_checked'
} as const);

/** Which limit refused a send. Logged, never shown to an anonymous caller. */
const MAIL_CAP_REASONS = Object.freeze({
    HOURLY_CAP: 'HOURLY_CAP',
    DAILY_CAP: 'DAILY_CAP',
    ANONYMOUS_HOURLY_SHARE: 'ANONYMOUS_HOURLY_SHARE',
    ANONYMOUS_DAILY_SHARE: 'ANONYMOUS_DAILY_SHARE',
    /** ANONYMOUS sends to one recipient have used their share of that recipient's daily cap. */
    RECIPIENT_ANONYMOUS_SHARE: 'RECIPIENT_ANONYMOUS_SHARE',
    RECIPIENT_DAILY_CAP: 'RECIPIENT_DAILY_CAP'
} as const);

/**
 * The share of each hour/day cap, AND of each recipient's daily cap, that ANONYMOUS-triggered mail
 * may use, rounded down.
 */
const ANONYMOUS_CAP_SHARE = 0.5;

/**
 * Messages to one address per rolling 24 hours, across every template. ANONYMOUS sends may use only
 * `ANONYMOUS_CAP_SHARE` of it (5 of 10), so a stranger requesting resets for a member's address can
 * never crowd out that member's PASSWORD_CHANGED notice or an admin-sent reset.
 */
const PER_RECIPIENT_MAX_PER_DAY = 10;

/**
 * The deadline an admin-facing send passes (`deadline_ms`). An admin is waiting on the response;
 * past this they are told the server did not confirm in time rather than left on a spinner.
 */
const ADMIN_SEND_DEADLINE_MS = 15000;

/** Upper bound on any `deadline_ms` a caller passes. */
const MAX_SEND_DEADLINE_MS = 60000;

/**
 * How long boot waits for the mail-server check before moving on and recording it as failed. A
 * later answer still updates the status. Covers the connection plus greeting timeouts.
 */
const BOOT_VERIFY_DEADLINE_MS = 20000;

/**
 * At most one re-check of the mail server (`recheckTransport`) starts per this interval, however
 * many anonymous setup requests ask for one: they must not turn this install into an SMTP-connection
 * amplifier.
 */
const TRANSPORT_RECHECK_MIN_INTERVAL_MS = 30000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** What this module says. Safe to show an operator; never names a server, a login or a link. */
const MAIL_MESSAGES = Object.freeze({
    SENT: 'The mail server accepted the message.',
    FAILED: 'The mail server did not accept the message.',
    CAP_REACHED: 'The message was not sent: this install has reached its email limit for now.',
    UNCONFIRMED: 'The mail server did not confirm in time; the message may still arrive.',
    NOT_CONFIGURED: 'Email is not configured on this install (SMTP_HOST and SMTP_FROM).',
    BUILD_FAILED: 'The message could not be built.',
    INVALID_RECIPIENT: 'The message was not sent: the recipient is not a single email address.',
    VERIFY_OK: 'The mail server accepted the connection and the login.',
    VERIFY_OK_NO_LOGIN: 'The mail server accepted the connection (no login is configured).',
    VERIFY_FAILED: 'The mail server check failed.'
} as const);

export = {
    EMAIL_TEMPLATES,
    EMAIL_SUBJECTS,
    EMAIL_ACTION_LABELS,
    PRODUCT_NAME,
    MAIL_TRIGGERS,
    MAIL_SEND_STATUSES,
    MAIL_CHECK_STATES,
    MAIL_CAP_REASONS,
    ANONYMOUS_CAP_SHARE,
    PER_RECIPIENT_MAX_PER_DAY,
    ADMIN_SEND_DEADLINE_MS,
    MAX_SEND_DEADLINE_MS,
    BOOT_VERIFY_DEADLINE_MS,
    TRANSPORT_RECHECK_MIN_INTERVAL_MS,
    HOUR_MS,
    DAY_MS,
    MAIL_MESSAGES
};
