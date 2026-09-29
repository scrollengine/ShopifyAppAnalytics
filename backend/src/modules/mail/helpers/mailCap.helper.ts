'use strict';

/**
 * ============================================================================
 *  MAIL CAPS — the one decision on whether a send may be charged
 * ============================================================================
 *
 *  PURE: takes the ledger, the clock and the limits as arguments, reads no
 *  config and no clock, mutates nothing. `mail.service` owns the ledger and the
 *  order of operations (decide, then charge, with no await in between, so two
 *  concurrent sends cannot both take the last slot).
 *
 *  Why caps at all: every flow that sends mail is reachable by someone, and two
 *  of them (setup, forgot-password) by anyone. Without a ceiling this install is
 *  a way to make a Gmail account send 500 messages at a stranger — after which
 *  Google suspends the account and invitations stop too.
 * ============================================================================
 */

import mailConstants = require('../constants/mail.constants');
import type { MailCapDecision, MailCapLimits, MailSendEntry, MailTrigger } from '../types/mail.types';

const { MAIL_TRIGGERS, MAIL_CAP_REASONS, HOUR_MS, DAY_MS } = mailConstants;

/**
 * A limit as a usable number. Anything non-finite becomes 0, i.e. "refuse": `count >= NaN` is
 * false, so a NaN limit would otherwise be a cap that never fires.
 *
 * @param value - The configured limit.
 * @returns The limit, or 0.
 */
const _limit = (value: number): number => {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return value;
};

/**
 * Decides whether one more send may be charged.
 *
 * Checks, in order: the hourly and daily totals (every trigger counts), then the ANONYMOUS share of
 * each (only for an ANONYMOUS send, and counting only ANONYMOUS entries), then the ANONYMOUS share
 * of the per-recipient cap (same rule, per recipient), then the per-recipient daily cap. The first
 * limit reached is the reason.
 *
 * ⚠️ The per-recipient share is what keeps anonymous traffic from spending a mailbox's whole cap.
 * Without it, ten forgot-password requests for a member's address (the per-account throttle allows
 * them over a few hours) refused every message to that address for a day, the PASSWORD_CHANGED
 * notice and an admin-sent reset included. Strangers now get at most half of it; the rest is left
 * for ADMIN and SECURITY sends.
 *
 * An entry stamped in the future (the clock stepped back) still counts: miscounting in that
 * direction refuses a message, the other direction sends one past the cap.
 *
 * @param entries - The charged sends. Entries older than 24 hours are ignored.
 * @param params - The request.
 * @param params.now_ms - The current time, epoch milliseconds.
 * @param params.trigger - Who caused this send.
 * @param params.recipient - The recipient, lowercased.
 * @param params.limits - The caps.
 * @returns `{ allowed, reason }`.
 */
const evaluateMailCaps = (
    entries: readonly MailSendEntry[],
    { now_ms, trigger, recipient, limits }: { now_ms: number; trigger: MailTrigger; recipient: string; limits: MailCapLimits }
): MailCapDecision => {
    const hourStart = now_ms - HOUR_MS;
    const dayStart = now_ms - DAY_MS;

    let hourTotal = 0;
    let dayTotal = 0;
    let hourAnonymous = 0;
    let dayAnonymous = 0;
    let recipientDay = 0;
    let recipientDayAnonymous = 0;

    for (const entry of entries) {
        if (entry.at_ms <= dayStart) {
            continue;
        }
        const isAnonymous = entry.trigger === MAIL_TRIGGERS.ANONYMOUS;
        dayTotal += 1;
        if (isAnonymous) {
            dayAnonymous += 1;
        }
        if (entry.recipient === recipient) {
            recipientDay += 1;
            if (isAnonymous) {
                recipientDayAnonymous += 1;
            }
        }
        if (entry.at_ms > hourStart) {
            hourTotal += 1;
            if (isAnonymous) {
                hourAnonymous += 1;
            }
        }
    }

    const maxPerHour = _limit(limits.max_per_hour);
    const maxPerDay = _limit(limits.max_per_day);
    const perRecipientPerDay = _limit(limits.per_recipient_max_per_day);
    const share = Math.min(Math.max(_limit(limits.anonymous_share), 0), 1);

    if (hourTotal >= maxPerHour) {
        return { allowed: false, reason: MAIL_CAP_REASONS.HOURLY_CAP };
    }
    if (dayTotal >= maxPerDay) {
        return { allowed: false, reason: MAIL_CAP_REASONS.DAILY_CAP };
    }
    if (trigger === MAIL_TRIGGERS.ANONYMOUS) {
        if (hourAnonymous >= Math.floor(maxPerHour * share)) {
            return { allowed: false, reason: MAIL_CAP_REASONS.ANONYMOUS_HOURLY_SHARE };
        }
        if (dayAnonymous >= Math.floor(maxPerDay * share)) {
            return { allowed: false, reason: MAIL_CAP_REASONS.ANONYMOUS_DAILY_SHARE };
        }
        if (recipientDayAnonymous >= Math.floor(perRecipientPerDay * share)) {
            return { allowed: false, reason: MAIL_CAP_REASONS.RECIPIENT_ANONYMOUS_SHARE };
        }
    }
    if (recipientDay >= perRecipientPerDay) {
        return { allowed: false, reason: MAIL_CAP_REASONS.RECIPIENT_DAILY_CAP };
    }
    return { allowed: true, reason: null };
};

/**
 * Drops entries that no longer count toward any cap. Returns a NEW array.
 *
 * @param entries - The ledger.
 * @param now_ms - The current time, epoch milliseconds.
 * @returns The entries from the last 24 hours (and any stamped in the future).
 */
const pruneMailSendLog = (entries: readonly MailSendEntry[], now_ms: number): MailSendEntry[] => {
    const dayStart = now_ms - DAY_MS;
    return entries.filter((entry) => entry.at_ms > dayStart);
};

export = {
    evaluateMailCaps,
    pruneMailSendLog
};
