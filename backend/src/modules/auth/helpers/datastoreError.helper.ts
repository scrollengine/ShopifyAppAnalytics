'use strict';

/**
 * Reads a MongoDB duplicate-key error (E11000) — which unique index refused a write.
 *
 * Several auth flows use a unique index as their race-free gate and branch on WHICH index fired
 * (spec A3): `{ _id: 1 }` ⇒ already inserted (idempotent), `{ email: 1 }` ⇒ ALREADY_A_MEMBER,
 * `{ pending_email: 1 }` ⇒ INVITE_PENDING, `{ name_norm: 1 }` ⇒ ROLE_NAME_TAKEN. Reading
 * `keyPattern` in one place keeps those branches from each parsing the error differently.
 *
 * PURE. Uses `Reflect.get` rather than a cast: the error is `unknown`, and this codebase reserves
 * `as` for the models chokepoint.
 */

/**
 * Whether an error is a MongoDB duplicate-key error.
 *
 * @param error - Anything thrown by a write.
 * @returns True for code 11000 / 11001.
 */
const isDuplicateKeyError = (error: unknown): boolean => {
    if (error === null || typeof error !== 'object') {
        return false;
    }
    const code = Reflect.get(error, 'code');
    return code === 11000 || code === 11001;
};

/**
 * Names the field(s) of the unique index a duplicate-key error came from.
 *
 * @param error - Anything thrown by a write.
 * @returns The index key fields joined with `,` (e.g. `'email'`, `'_id'`, `'pending_email'`), or
 *     `null` when the error is not a duplicate-key error or does not say which index fired.
 */
const duplicateKeyField = (error: unknown): string | null => {
    if (!isDuplicateKeyError(error) || error === null || typeof error !== 'object') {
        return null;
    }
    for (const property of ['keyPattern', 'keyValue']) {
        const value: unknown = Reflect.get(error, property);
        if (value !== null && typeof value === 'object') {
            const keys = Object.keys(value);
            if (keys.length > 0) {
                return keys.join(',');
            }
        }
    }
    return null;
};

export = {
    isDuplicateKeyError,
    duplicateKeyField
};
