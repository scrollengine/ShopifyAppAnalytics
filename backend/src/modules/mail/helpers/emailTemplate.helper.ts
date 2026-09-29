'use strict';

/**
 * ============================================================================
 *  EMAIL TEMPLATES — the four messages, rendered
 * ============================================================================
 *
 *  PURE: `buildEmail(template, vars)` → `{ subject, text, html }`. No config,
 *  no clock (`now` is a parameter), no I/O. It throws a TypeError on a
 *  programming error (unknown template, a required variable missing); the
 *  thrown message names the variable and never contains its value.
 *
 *  The rules every template follows:
 *    - The subject is a fixed string from constants. Nothing typed by anyone
 *      reaches it.
 *    - Every interpolated value is HTML-escaped in the HTML part, and stripped
 *      of control and bidi-override characters in both parts. The HTML is built
 *      so that NOTHING reaches it unescaped: whole paragraphs go through
 *      `escapeHtml`, fixed copy included.
 *    - A plain-text part always exists. No remote images, no tracking, no
 *      external CSS.
 *    - A link is placed, never composed: `link` arrives finished from
 *      `buildAppLink`, which builds it from `config.APP.PUBLIC_URL` alone.
 *    - Expiry reads as a duration ("expires in 30 minutes") AND an ISO-8601
 *      UTC timestamp — never `toLocaleString()`, whose output depends on the
 *      server's locale and says nothing about the reader's.
 *    - Each message says what to do if the reader did not ask for it.
 *    - SETUP_VERIFY never carries the name the requester typed: anyone can
 *      request setup for any address, and the name would be their text in
 *      somebody else's inbox.
 * ============================================================================
 */

import mailConstants = require('../constants/mail.constants');
import type { BuiltEmail, EmailTemplateKey, EmailTemplateVars } from '../types/mail.types';

const { EMAIL_TEMPLATES, EMAIL_SUBJECTS, EMAIL_ACTION_LABELS, PRODUCT_NAME } = mailConstants;

const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;'
};

/**
 * C0 controls, DEL, and the Unicode bidi embeddings/overrides/isolates. A name carrying U+202E
 * renders reversed in most mail clients, which is the classic way to make one address read as
 * another.
 */
const UNSAFE_CHARS_RE = /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;

/** The same class WITHOUT the `g` flag, for `.test()` — a global regex's `.test()` is stateful. */
const HAS_UNSAFE_CHAR_RE = /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;

/** Longest a free-text value (a name, a role label) may be once cleaned. */
const MAX_VALUE_LENGTH = 200;

/** Longest a link may be. A token link is the public URL plus ~70 characters. */
const MAX_LINK_LENGTH = 2048;

const ABSOLUTE_HTTP_URL_RE = /^https?:\/\/\S+$/i;

/**
 * Escapes the five characters that matter in HTML text and double-quoted attributes.
 *
 * @param value - Plain text.
 * @returns The text, safe to place in HTML.
 */
const escapeHtml = (value: string): string => {
    return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
};

/**
 * Normalises a free-text value for display: unsafe characters become spaces, the ends are trimmed,
 * and an over-long value is cut with an ellipsis.
 *
 * @param value - The raw value.
 * @returns The cleaned text; '' for null/undefined.
 */
const _cleanValue = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }
    const cleaned = String(value).replace(UNSAFE_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length > MAX_VALUE_LENGTH) {
        return `${cleaned.slice(0, MAX_VALUE_LENGTH)}…`;
    }
    return cleaned;
};

/**
 * A required free-text variable.
 *
 * @param value - The raw value.
 * @param name - The variable name, for the error.
 * @returns The cleaned, non-empty text.
 */
const _requireText = (value: unknown, name: string): string => {
    const cleaned = _cleanValue(value);
    if (!cleaned) {
        throw new TypeError(`buildEmail: ${name} is required for this template`);
    }
    return cleaned;
};

/**
 * A required link. Refused rather than repaired: a link that is not absolute http(s) is a bug
 * upstream, and cutting or cleaning one would email a link that does not work.
 *
 * @param value - The finished link.
 * @returns The link, unchanged.
 */
const _requireLink = (value: unknown): string => {
    if (typeof value !== 'string' || !value) {
        throw new TypeError('buildEmail: link is required for this template');
    }
    if (value.length > MAX_LINK_LENGTH || !ABSOLUTE_HTTP_URL_RE.test(value) || HAS_UNSAFE_CHAR_RE.test(value)) {
        throw new TypeError('buildEmail: link must be an absolute http(s) URL');
    }
    return value;
};

/**
 * A required, valid Date.
 *
 * @param value - The value.
 * @param name - The variable name, for the error.
 * @returns The Date.
 */
const _requireDate = (value: unknown, name: string): Date => {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new TypeError(`buildEmail: ${name} must be a valid Date`);
    }
    return value;
};

/**
 * `1 minute` / `3 minutes`.
 *
 * @param count - The number.
 * @param unit - The singular unit.
 * @returns The phrase.
 */
const _plural = (count: number, unit: string): string => {
    if (count === 1) {
        return `1 ${unit}`;
    }
    return `${count} ${unit}s`;
};

/**
 * A duration in words, to the nearest minute: `30 minutes`, `1 hour 30 minutes`, `3 days`. At most
 * two units are shown; when a third was dropped the phrase starts with "about".
 *
 * @param ms - The duration in milliseconds.
 * @returns The phrase. Under half a minute reads "less than a minute".
 */
const formatDuration = (ms: number): string => {
    const totalMinutes = Math.round(ms / 60000);
    if (!Number.isFinite(totalMinutes) || totalMinutes < 1) {
        return 'less than a minute';
    }
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    const units: string[] = [];
    if (days) {
        units.push(_plural(days, 'day'));
    }
    if (hours) {
        units.push(_plural(hours, 'hour'));
    }
    if (minutes) {
        units.push(_plural(minutes, 'minute'));
    }
    if (units.length > 2) {
        return `about ${units.slice(0, 2).join(' ')}`;
    }
    return units.join(' ');
};

/**
 * An instant as ISO-8601 in UTC, to the second, with the zone spelled out for readers who do not
 * know what the `Z` means: `2026-09-28T14:30:00Z (UTC)`.
 *
 * @param date - The instant.
 * @returns The timestamp.
 */
const formatUtcTimestamp = (date: Date): string => {
    return `${date.toISOString().slice(0, 19)}Z (UTC)`;
};

/** A message as data, before rendering. Every string is plain text. */
interface EmailContent {
    /** Paragraphs before the action. */
    intro: string[];
    /** The button, when the message carries a link. */
    action: { label: string; link: string } | null;
    /** Paragraphs after the action: expiry, requesting address. */
    details: string[];
    /** The "if this wasn't you" paragraph. */
    closing: string;
}

/**
 * The context that identifies this install in a sentence: ` at https://analytics.example.com`, or
 * nothing when no public URL was passed.
 *
 * @param vars - The template variables.
 * @returns The clause, with its leading space.
 */
const _siteClause = (vars: EmailTemplateVars): string => {
    const publicUrl = _cleanValue(vars.public_url);
    if (!publicUrl) {
        return '';
    }
    return ` at ${publicUrl}`;
};

/**
 * The expiry sentence.
 *
 * @param noun - "This link" / "This invitation".
 * @param vars - The template variables (`now`, `expires_at`).
 * @returns The sentence.
 */
const _expirySentence = (noun: string, vars: EmailTemplateVars): string => {
    const now = _requireDate(vars.now, 'now');
    const expiresAt = _requireDate(vars.expires_at, 'expires_at');
    const duration = formatDuration(expiresAt.getTime() - now.getTime());
    return `${noun} expires in ${duration} (at ${formatUtcTimestamp(expiresAt)}) and works once.`;
};

/**
 * The requesting-address sentence, or null when no address was passed.
 *
 * @param lead - "This request came from" / "The change was made from".
 * @param vars - The template variables.
 * @returns The sentence, or null.
 */
const _ipSentence = (lead: string, vars: EmailTemplateVars): string | null => {
    const ip = _cleanValue(vars.ip);
    if (!ip) {
        return null;
    }
    return `${lead} IP address ${ip}.`;
};

/**
 * @param vars - The template variables.
 * @returns The SETUP_VERIFY content. Uses no name: see the file header.
 */
const _setupVerifyContent = (vars: EmailTemplateVars): EmailContent => {
    const details = [_expirySentence('This link', vars)];
    const ipSentence = _ipSentence('This request came from', vars);
    if (ipSentence) {
        details.push(ipSentence);
    }
    return {
        intro: [
            `Someone asked to set up ${PRODUCT_NAME}${_siteClause(vars)} with this email address as the owner account.`,
            'To confirm it was you, open the link below and choose a password.'
        ],
        action: { label: EMAIL_ACTION_LABELS.SETUP_VERIFY, link: _requireLink(vars.link) },
        details,
        closing: 'If this wasn\'t you, ignore this email. Nothing is set up unless the link is opened and a password is chosen.'
    };
};

/**
 * @param vars - The template variables.
 * @returns The INVITE content.
 */
const _inviteContent = (vars: EmailTemplateVars): EmailContent => {
    const inviterName = _requireText(vars.inviter_name, 'inviter_name');
    const roleLabel = _requireText(vars.role_label, 'role_label');
    return {
        intro: [
            `${inviterName} invited you to join ${PRODUCT_NAME}${_siteClause(vars)}. Your role: ${roleLabel}.`,
            'To accept, open the link below and choose a password for your account.'
        ],
        action: { label: EMAIL_ACTION_LABELS.INVITE, link: _requireLink(vars.link) },
        details: [_expirySentence('This invitation', vars)],
        closing: 'If you weren\'t expecting this, ignore this email. No account is created unless the invitation is accepted.'
    };
};

/**
 * @param vars - The template variables.
 * @returns The PASSWORD_RESET content.
 */
const _passwordResetContent = (vars: EmailTemplateVars): EmailContent => {
    const details = [_expirySentence('This link', vars)];
    const ipSentence = _ipSentence('This request came from', vars);
    if (ipSentence) {
        details.push(ipSentence);
    }
    return {
        intro: [
            `Someone asked to reset the password for your ${PRODUCT_NAME} account${_siteClause(vars)}.`,
            'To choose a new password, open the link below.'
        ],
        action: { label: EMAIL_ACTION_LABELS.PASSWORD_RESET, link: _requireLink(vars.link) },
        details,
        closing: 'If this wasn\'t you, ignore this email. Your password stays the same unless the link is used.'
    };
};

/**
 * @param vars - The template variables.
 * @returns The PASSWORD_CHANGED content. No link: the way back is the sign-in page's own
 * "Forgot your password?", which the reader reaches by typing the address they already know.
 */
const _passwordChangedContent = (vars: EmailTemplateVars): EmailContent => {
    const now = _requireDate(vars.now, 'now');
    const details: string[] = [];
    const ipSentence = _ipSentence('The change was made from', vars);
    if (ipSentence) {
        details.push(ipSentence);
    }
    return {
        intro: [`The password for your ${PRODUCT_NAME} account${_siteClause(vars)} was changed at ${formatUtcTimestamp(now)}.`],
        action: null,
        details,
        closing: 'If you made this change, you can ignore this email. If you didn\'t, reset your password now with ' +
            `"Forgot your password?" on the sign-in page${_siteClause(vars)}, and tell whoever runs this install.`
    };
};

/**
 * The footer line every message ends with.
 *
 * @param vars - The template variables.
 * @returns The sentence.
 */
const _footer = (vars: EmailTemplateVars): string => {
    return `Sent automatically by ${PRODUCT_NAME}${_siteClause(vars)}.`;
};

/**
 * Renders the plain-text part.
 *
 * @param content - The message.
 * @param footer - The footer line.
 * @returns The text, paragraphs separated by a blank line.
 */
const _renderText = (content: EmailContent, footer: string): string => {
    const blocks: string[] = [...content.intro];
    if (content.action) {
        blocks.push(`${content.action.label}:\n${content.action.link}`);
    }
    blocks.push(...content.details, content.closing, footer);
    return `${blocks.join('\n\n')}\n`;
};

const FONT_STACK = '-apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif';
const P_STYLE = 'margin:0 0 16px;font-size:15px;line-height:1.5;color:#202223;';
const SMALL_STYLE = 'margin:0 0 16px;font-size:13px;line-height:1.5;color:#616161;';
const BUTTON_STYLE = 'display:inline-block;padding:10px 18px;background:#303030;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:15px;';

/**
 * Renders the HTML part. Every string passes through `escapeHtml` on its way in — fixed copy,
 * values, link and label alike — so there is no path for an unescaped value.
 *
 * @param subject - The fixed subject, used as the document title.
 * @param content - The message.
 * @param footer - The footer line.
 * @returns A self-contained HTML document: inline styles, no images, no external resources.
 */
const _renderHtml = (subject: string, content: EmailContent, footer: string): string => {
    const paragraph = (text: string, style: string = P_STYLE): string => `<p style="${style}">${escapeHtml(text)}</p>`;

    const parts: string[] = content.intro.map((text) => paragraph(text));
    if (content.action) {
        const href = escapeHtml(content.action.link);
        parts.push(`<p style="margin:24px 0;"><a href="${href}" style="${BUTTON_STYLE}">${escapeHtml(content.action.label)}</a></p>`);
        parts.push(
            `<p style="${SMALL_STYLE}">${escapeHtml('If the button does not work, copy this address into your browser:')}<br>` +
            `<span style="word-break:break-all;">${href}</span></p>`
        );
    }
    for (const text of content.details) {
        parts.push(paragraph(text));
    }
    parts.push(paragraph(content.closing));
    parts.push(paragraph(footer, SMALL_STYLE));

    return [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>${escapeHtml(subject)}</title></head>`,
        `<body style="margin:0;padding:24px;background:#f6f6f7;font-family:${escapeHtml(FONT_STACK)};">`,
        '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px;">',
        ...parts,
        '</div>',
        '</body>',
        '</html>',
        ''
    ].join('\n');
};

/**
 * Builds one of the four messages.
 *
 * @param template - Which message. See EMAIL_TEMPLATES.
 * @param vars - What it interpolates. Required fields per template are listed on `EmailTemplateVars`.
 * @returns `{ subject, text, html }`.
 * @throws TypeError on an unknown template or a missing/invalid required variable. The message names
 * the variable, never its value.
 */
const buildEmail = (template: EmailTemplateKey, vars: EmailTemplateVars): BuiltEmail => {
    if (!vars || typeof vars !== 'object') {
        throw new TypeError('buildEmail: vars is required');
    }
    _requireDate(vars.now, 'now');

    let content: EmailContent;
    if (template === EMAIL_TEMPLATES.SETUP_VERIFY) {
        content = _setupVerifyContent(vars);
    } else if (template === EMAIL_TEMPLATES.INVITE) {
        content = _inviteContent(vars);
    } else if (template === EMAIL_TEMPLATES.PASSWORD_RESET) {
        content = _passwordResetContent(vars);
    } else if (template === EMAIL_TEMPLATES.PASSWORD_CHANGED) {
        content = _passwordChangedContent(vars);
    } else {
        throw new TypeError('buildEmail: unknown template');
    }

    const subject = EMAIL_SUBJECTS[template];
    const footer = _footer(vars);
    return {
        subject,
        text: _renderText(content, footer),
        html: _renderHtml(subject, content, footer)
    };
};

export = {
    buildEmail,
    escapeHtml,
    formatDuration,
    formatUtcTimestamp
};
