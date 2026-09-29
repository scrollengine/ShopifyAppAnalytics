'use strict';

/**
 * Input checks for the identity fields: email, display name, custom-role name, object ids.
 *
 * PURE: no I/O, no config, no clock. Every check starts with `typeof === 'string'` because the value
 * comes straight off a request body — a JSON array or object in an email field must be a 400, not a
 * `.trim is not a function` 500 or, worse, an operator object reaching a query.
 *
 * Emails and names end up in outgoing mail, in the audit log and on the users page, so the checks
 * refuse characters that can forge or reorder text there, not only malformed values.
 */

import authConstants = require('../constants/auth.constants');
import rolesConstants = require('../constants/roles.constants');

import type { ValidationResult, ValidRoleName } from '../types/auth.types';

const { EMAIL_MAX_LENGTH, NAME_MAX_LENGTH, ROLE_NAME_MAX_LENGTH, ROLE_DESCRIPTION_MAX_LENGTH, OBJECT_ID_REGEX } = authConstants;
const { RESERVED_ROLE_NAMES } = rolesConstants;

/**
 * Code points refused in any identity field: C0 controls and DEL (spec I12), plus C1 controls, the
 * Unicode line/paragraph separators, and the bidirectional embedding/override/isolate controls.
 *
 * The additions beyond I12 are the safest reading of "reject control chars": a U+202E in a name
 * reverses the rest of the line in an invite email ("…invited you" rendered backwards around a
 * spoofed address), and U+2028 splits a log line. None of them has a legitimate use in a name.
 */
const FORBIDDEN_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = Object.freeze([
    [0x0000, 0x001f],
    [0x007f, 0x009f],
    [0x2028, 0x2029],
    [0x202a, 0x202e],
    [0x2066, 0x2069]
] as const);

/**
 * Whether a string contains any code point in `FORBIDDEN_CODE_POINT_RANGES`.
 *
 * A code-point walk rather than a regex character class on purpose: the class would have to spell
 * the separators and bidi controls as escapes, and an escaped U+2028 that gets decoded on its way
 * into a source file becomes a literal line terminator that ends the regex mid-pattern.
 *
 * @param value - The string to scan.
 * @returns True when a forbidden code point is present.
 */
const _hasForbiddenCharacter = (value: string): boolean => {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint === undefined) {
            continue;
        }
        for (const [low, high] of FORBIDDEN_CODE_POINT_RANGES) {
            if (codePoint >= low && codePoint <= high) {
                return true;
            }
        }
    }
    return false;
};

/** Characters refused in an email on top of the controls (spec A2) — header and list syntax. */
const FORBIDDEN_EMAIL_PUNCTUATION = /[,;<>"()[\]\\:]/;

/** Spec I12 / A2 email shape. Deliberately loose: the mailbox proves itself by receiving the link. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Link-like text refused in names (spec A2). A name is interpolated into emails sent to OTHER people
 * (the invite names its sender), so a "name" of `www.evil.example` would put a clickable-looking
 * address into mail that carries this deployment's From line.
 */
const LINK_LIKE = /:\/\/|www\./i;

/**
 * Counts code points, not UTF-16 units, so an emoji counts once toward a length limit.
 *
 * @param value - The string to measure.
 * @returns The number of code points.
 */
const _codePointLength = (value: string): number => {
    return Array.from(value).length;
};

/**
 * Lowercases and trims an email for lookup — the same normalisation the schemas apply on write.
 *
 * @param email - Anything. Not trusted to be a string.
 * @returns The normalised email, or `''` for a non-string.
 */
const normaliseEmail = (email: unknown): string => {
    if (typeof email !== 'string') {
        return '';
    }
    return email.trim().toLowerCase();
};

/**
 * Validates and normalises an email address (spec I12 + A2).
 *
 * @param email - Raw request value.
 * @returns `{ ok: true, value }` with the trimmed, lowercased address, or `{ ok: false, reason }`.
 */
const validateEmail = (email: unknown): ValidationResult<string> => {
    if (typeof email !== 'string') {
        return { ok: false, value: null, reason: 'Enter an email address.' };
    }
    const normalised = email.trim().toLowerCase();
    if (normalised.length === 0) {
        return { ok: false, value: null, reason: 'Enter an email address.' };
    }
    if (normalised.length > EMAIL_MAX_LENGTH) {
        return { ok: false, value: null, reason: `An email address can be at most ${EMAIL_MAX_LENGTH} characters.` };
    }
    if (_hasForbiddenCharacter(normalised) || FORBIDDEN_EMAIL_PUNCTUATION.test(normalised)) {
        return { ok: false, value: null, reason: 'That email address contains characters that are not allowed.' };
    }
    if (normalised.split('@').length !== 2 || !EMAIL_SHAPE.test(normalised)) {
        return { ok: false, value: null, reason: 'Enter a valid email address.' };
    }
    return { ok: true, value: normalised, reason: null };
};

/**
 * Shared body of the name checks.
 *
 * @param name - Raw request value.
 * @param maxLength - Upper bound in code points after trimming.
 * @param label - What the field is called in the message.
 * @returns The trimmed name, or the reason it was refused.
 */
const _validateDisplayText = (name: unknown, maxLength: number, label: string): ValidationResult<string> => {
    if (typeof name !== 'string') {
        return { ok: false, value: null, reason: `Enter a ${label}.` };
    }
    const trimmed = name.trim();
    const length = _codePointLength(trimmed);
    if (length === 0) {
        return { ok: false, value: null, reason: `Enter a ${label}.` };
    }
    if (length > maxLength) {
        return { ok: false, value: null, reason: `A ${label} can be at most ${maxLength} characters.` };
    }
    if (_hasForbiddenCharacter(trimmed)) {
        return { ok: false, value: null, reason: `That ${label} contains characters that are not allowed.` };
    }
    if (trimmed.includes('@') || LINK_LIKE.test(trimmed)) {
        return { ok: false, value: null, reason: `A ${label} cannot contain an email address or a web address.` };
    }
    return { ok: true, value: trimmed, reason: null };
};

/**
 * Validates a person's display name (spec I12 + A2): 1–100 code points after trimming; no control
 * or bidi characters; no `@`, `://` or `www.`.
 *
 * @param name - Raw request value.
 * @returns `{ ok: true, value }` with the trimmed name, or `{ ok: false, reason }`.
 */
const validateName = (name: unknown): ValidationResult<string> => {
    return _validateDisplayText(name, NAME_MAX_LENGTH, 'name');
};

/**
 * Validates a custom-role name: the display-name rules capped at 60 code points, and the normalised
 * form must not be a built-in role's key (spec §4 + A2).
 *
 * `name_norm` is NFC + trim + lowercase. NFC is added to the spec's "lowercase trim" so that a
 * precomposed and a decomposed `é` cannot become two roles that look identical in every list.
 *
 * @param name - Raw request value.
 * @returns `{ ok: true, value: { name, name_norm } }`, or `{ ok: false, reason }`.
 */
const validateRoleName = (name: unknown): ValidationResult<ValidRoleName> => {
    const checked = _validateDisplayText(name, ROLE_NAME_MAX_LENGTH, 'role name');
    if (!checked.ok) {
        return checked;
    }
    const nameNorm = checked.value.normalize('NFC').trim().toLowerCase();
    if (RESERVED_ROLE_NAMES.includes(nameNorm)) {
        return { ok: false, value: null, reason: 'That name belongs to a built-in role. Choose another.' };
    }
    return { ok: true, value: { name: checked.value, name_norm: nameNorm }, reason: null };
};

/**
 * Validates a custom-role description: optional (absent ⇒ `''`), otherwise a string of at most 280
 * code points after trimming, with no control or bidi characters. Single line — it is shown inline
 * in the role editor.
 *
 * @param description - Raw request value.
 * @returns `{ ok: true, value }` with the trimmed description, or `{ ok: false, reason }`.
 */
const validateRoleDescription = (description: unknown): ValidationResult<string> => {
    if (description === undefined || description === null) {
        return { ok: true, value: '', reason: null };
    }
    if (typeof description !== 'string') {
        return { ok: false, value: null, reason: 'The description must be text.' };
    }
    const trimmed = description.trim();
    if (_codePointLength(trimmed) > ROLE_DESCRIPTION_MAX_LENGTH) {
        return { ok: false, value: null, reason: `A description can be at most ${ROLE_DESCRIPTION_MAX_LENGTH} characters.` };
    }
    if (_hasForbiddenCharacter(trimmed)) {
        return { ok: false, value: null, reason: 'The description contains characters that are not allowed.' };
    }
    return { ok: true, value: trimmed, reason: null };
};

/**
 * Whether a value is a canonical 24-character lowercase-hex ObjectId string (spec A2). Checked
 * before any lookup, so a malformed id is a 404 rather than a CastError 500.
 *
 * @param value - Raw request value.
 * @returns True only for a string matching `OBJECT_ID_REGEX`.
 */
const isObjectIdString = (value: unknown): value is string => {
    return typeof value === 'string' && OBJECT_ID_REGEX.test(value);
};

/**
 * Whether a value is usable as an id in a repository filter: a canonical id string, or an ObjectId
 * (whose string form is one). The repositories check this before every id-keyed query, so a value
 * that slipped past a service check matches nothing instead of throwing a CastError — and an
 * operator object (`{ $ne: null }`) can never reach a filter in an id position.
 *
 * ⚠️ An object qualifies only through a callable `toHexString` (what a bson ObjectId has), never
 * through `String(value)`: a JSON body can carry `{ "toString": "0123…" }`, which makes `String()`
 * THROW, and a plain object must never be mistaken for an id however it stringifies.
 *
 * @param value - An ObjectId, its string form, or anything else.
 * @returns True for a 24-character lowercase-hex string, or an object whose `toHexString()` is one.
 */
const isObjectIdLike = (value: unknown): boolean => {
    if (typeof value === 'string') {
        return OBJECT_ID_REGEX.test(value);
    }
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const toHexString: unknown = Reflect.get(value, 'toHexString');
    if (typeof toHexString !== 'function') {
        return false;
    }
    const hex: unknown = Reflect.apply(toHexString, value, []);
    return typeof hex === 'string' && OBJECT_ID_REGEX.test(hex);
};

export = {
    normaliseEmail,
    validateEmail,
    validateName,
    validateRoleName,
    validateRoleDescription,
    isObjectIdString,
    isObjectIdLike
};
