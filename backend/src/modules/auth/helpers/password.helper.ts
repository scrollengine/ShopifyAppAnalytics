'use strict';

/**
 * The password policy (spec I9): NIST SP 800-63B-4 for a single-factor password.
 *
 *  - NFC-normalised before hashing AND before comparing, so the same passphrase typed on two
 *    keyboards (precomposed vs combining accents) is the same password.
 *  - At least 15 code points. No composition rules — length is what resists guessing, and
 *    composition rules push people toward `Password1!`-shaped strings.
 *  - At most 72 UTF-8 bytes, enforced by REFUSING when bcrypt would truncate. bcrypt silently
 *    ignores everything past byte 72, so accepting a longer password would store a hash of a prefix
 *    the user never chose as their password.
 *  - A blocklist: common passwords (NCSC list, entries ≥ 15 chars), the email local part, the
 *    person's own name, and a single repeated character.
 *
 * PURE: no I/O, no config, no clock. The byte rule is computed here (`Buffer.byteLength`, the same
 * UTF-8 count bcryptjs truncates on), and `truncates` — the service passes `bcrypt.truncates` — is
 * an OPTIONAL second opinion: a caller that forgets to inject it still gets the rule enforced, and a
 * bcrypt that ever counted differently would refuse more, never less.
 */

import authConstants = require('../constants/auth.constants');
import commonPasswordsConstants = require('../constants/commonPasswords.constants');

import type { PasswordPolicyInput, PasswordPolicyResult, PasswordPolicyCode } from '../types/auth.types';

const {
    PASSWORD_MIN_LENGTH,
    PASSWORD_MAX_BYTES,
    PASSWORD_EMAIL_LOCAL_PART_MIN_LENGTH,
    PASSWORD_POLICY_CODES,
    PASSWORD_POLICY_MESSAGES
} = authConstants;

/** Built once at load from a frozen constant — a lookup, not a scan, per check. */
const COMMON_PASSWORD_SET: ReadonlySet<string> = new Set(commonPasswordsConstants.COMMON_PASSWORDS);

/** Whitespace, punctuation and symbols — stripped before comparing a password with a name. */
const NON_ALPHANUMERIC = /[\s\p{P}\p{S}]/gu;

/**
 * NFC-normalises a password. Apply before `bcrypt.hash` AND before `bcrypt.compare`.
 *
 * @param password - The raw password (already checked to be a string).
 * @returns The NFC form.
 */
const normalisePassword = (password: string): string => {
    return password.normalize('NFC');
};

/**
 * Builds a refusal.
 *
 * @param code - The rule that refused.
 * @returns The failure result carrying the rule's message.
 */
const _refuse = (code: PasswordPolicyCode): PasswordPolicyResult => {
    return { ok: false, code: code, reason: PASSWORD_POLICY_MESSAGES[code] };
};

/**
 * Reduces text to lowercase letters and digits, for the name comparison.
 *
 * @param value - Text to reduce.
 * @returns The NFC, lowercased value with whitespace, punctuation and symbols removed.
 */
const _alphanumericKey = (value: string): string => {
    return value.normalize('NFC').toLowerCase().replace(NON_ALPHANUMERIC, '');
};

/**
 * Evaluates a candidate password against the policy.
 *
 * Rules run in a fixed order and the FIRST refusal is returned, so the message names one thing to
 * fix. The candidate is NFC-normalised here; the caller hashes `normalisePassword(password)`
 * separately.
 *
 * @param input - The candidate and its context.
 * @param input.password - Raw request value.
 * @param input.email - The account's email (local-part containment, when the local part is ≥ 4 chars).
 * @param input.name - The account's display name (refused when the password IS the name).
 * @param input.truncates - Optional `bcrypt.truncates`, consulted IN ADDITION to the byte count:
 *     either one saying "too long" refuses.
 * @returns `{ ok: true }`, or `{ ok: false, code, reason }` with the rule and a message safe to show.
 */
const evaluatePasswordPolicy = ({ password, email, name, truncates }: PasswordPolicyInput): PasswordPolicyResult => {
    if (typeof password !== 'string' || password.length === 0) {
        return _refuse(PASSWORD_POLICY_CODES.NOT_A_STRING);
    }

    const normalised = normalisePassword(password);
    const codePoints = Array.from(normalised);

    if (codePoints.length < PASSWORD_MIN_LENGTH) {
        return _refuse(PASSWORD_POLICY_CODES.TOO_SHORT);
    }

    const overBytes = Buffer.byteLength(normalised, 'utf8') > PASSWORD_MAX_BYTES;
    const bcryptWouldTruncate = typeof truncates === 'function' && truncates(normalised) === true;
    if (overBytes || bcryptWouldTruncate) {
        return _refuse(PASSWORD_POLICY_CODES.TOO_LONG);
    }

    if (codePoints.every((codePoint) => codePoint === codePoints[0])) {
        return _refuse(PASSWORD_POLICY_CODES.REPEATED_CHARACTER);
    }

    const lowered = normalised.toLowerCase();
    if (COMMON_PASSWORD_SET.has(lowered)) {
        return _refuse(PASSWORD_POLICY_CODES.COMMON_PASSWORD);
    }

    if (typeof email === 'string') {
        const localPart = email.trim().toLowerCase().normalize('NFC').split('@')[0] || '';
        if (Array.from(localPart).length >= PASSWORD_EMAIL_LOCAL_PART_MIN_LENGTH && lowered.includes(localPart)) {
            return _refuse(PASSWORD_POLICY_CODES.CONTAINS_EMAIL);
        }
    }

    if (typeof name === 'string') {
        const nameKey = _alphanumericKey(name);
        if (nameKey.length > 0 && _alphanumericKey(normalised) === nameKey) {
            return _refuse(PASSWORD_POLICY_CODES.MATCHES_NAME);
        }
    }

    return { ok: true, code: null, reason: null };
};

export = {
    normalisePassword,
    evaluatePasswordPolicy
};
