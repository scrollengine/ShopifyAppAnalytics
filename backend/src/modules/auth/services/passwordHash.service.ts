'use strict';

/**
 * ============================================================================
 *  PASSWORD HASHING — the ONLY bcrypt caller in the codebase (spec I9)
 * ============================================================================
 *
 *  Internal to the auth services (setup, session, password, invite, recovery).
 *  Not in the barrel: nothing outside `modules/auth` hashes or compares a
 *  password, and this module is the only writer-side source of a
 *  `password_hash`.
 *
 *  Every password is NFC-normalised (`password.helper#normalisePassword`)
 *  before BOTH hashing and comparing, so the same passphrase typed on two
 *  keyboards (precomposed vs combining accents) is the same password.
 *
 *  These are plain async functions, not envelope services: they throw like the
 *  bcrypt calls they wrap, and every caller is a service that catches.
 * ============================================================================
 */

import bcrypt = require('bcryptjs');
import config = require('../../../config');
import logger = require('../../../core/logger');
import passwordHelper = require('../helpers/password.helper');

/** bcryptjs refuses a cost outside this range, so a mistyped config value is clamped, not passed through. */
const MIN_BCRYPT_ROUNDS = 4;
const MAX_BCRYPT_ROUNDS = 31;

/** The shape of a bcrypt hash: `$2a$`/`$2b$`/`$2y$`, a two-digit cost, 53 characters of salt + digest. */
const BCRYPT_HASH_SHAPE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/**
 * The salt-and-digest half of a bcrypt hash of a value nobody knows. The `$2b$<cost>$` prefix is
 * attached by `_dummyHash`. A literal, so it costs nothing at load; the only thing ever done with it
 * is a comparison that must fail.
 */
const ABSENT_ACCOUNT_DUMMY_DIGEST = 'Qw8kZ3rTn1vLpXy2Bd7cGeuJ4mHs6RfKtNbVdWxCyZaPqLoEiUgTr';

/** Resolved on first use, then fixed for the life of the process (config is frozen). */
let _rounds: number | null = null;

/**
 * The bcrypt cost factor, clamped into the range bcryptjs accepts. Resolved once, lazily, so a
 * misconfiguration warns once rather than on every sign-in — and not at import, which the CI
 * import-cycle step does with an empty environment.
 *
 * @returns A cost between 4 and 31.
 */
const bcryptRounds = (): number => {
    if (_rounds !== null) {
        return _rounds;
    }
    const configured = config.AUTH.BCRYPT_ROUNDS;
    let rounds = configured;
    if (!Number.isInteger(configured) || configured < MIN_BCRYPT_ROUNDS) {
        logger.customConsoleWarn('WARN: auth: AUTH_BCRYPT_ROUNDS is below the minimum (or not a number) — using the minimum instead', {
            configured: configured,
            using: MIN_BCRYPT_ROUNDS
        });
        rounds = MIN_BCRYPT_ROUNDS;
    } else if (configured > MAX_BCRYPT_ROUNDS) {
        logger.customConsoleWarn('WARN: auth: AUTH_BCRYPT_ROUNDS is above the maximum — using the maximum instead', {
            configured: configured,
            using: MAX_BCRYPT_ROUNDS
        });
        rounds = MAX_BCRYPT_ROUNDS;
    }
    _rounds = rounds;
    return rounds;
};

/**
 * The hash a sign-in for a NON-EXISTENT (or hash-less) account is compared against — the timing half
 * of "one message for every failed login".
 *
 * THE COST IS SPLICED IN, NOT HARDCODED. bcrypt reads its cost from the hash string, so a dummy
 * pinned at `$2b$12$` while real hashes were written at cost 10 makes the unknown-email path four
 * times SLOWER than the wrong-password path (measured on the single-operator build: 205 ms vs 52 ms)
 * — the same oracle pointing the other way.
 *
 * ⚠️ Residual, accepted: a stored hash carries the cost it was WRITTEN with. After
 * `AUTH_BCRYPT_ROUNDS` changes, old hashes differ from the dummy until each user signs in once (a
 * successful sign-in rehashes at the configured cost — spec A4).
 *
 * @returns A well-formed bcrypt hash at the configured cost that nothing matches.
 */
const _dummyHash = (): string => {
    return `$2b$${String(bcryptRounds()).padStart(2, '0')}$${ABSENT_ACCOUNT_DUMMY_DIGEST}`;
};

/**
 * Hashes a password for storage: NFC-normalised, bcrypt at the configured cost. The caller has
 * already run the policy (which refuses anything bcrypt would truncate).
 *
 * @param password - The plaintext password. Never logged.
 * @returns The bcrypt hash.
 */
const hashPassword = async (password: string): Promise<string> => {
    return bcrypt.hash(passwordHelper.normalisePassword(password), bcryptRounds());
};

/**
 * Compares a password with a stored hash — ALWAYS paying for one bcrypt comparison at the
 * configured cost, even when there is no hash (unknown account) or the stored value is not a bcrypt
 * hash (bcryptjs would return `false` instantly, which is a timing oracle).
 *
 * @param password - The submitted plaintext password (a string; the caller checked).
 * @param storedHash - The user's `password_hash`, or `null` when there is no account.
 * @returns True only when a real stored hash matches.
 */
const verifyPassword = async (password: string, storedHash: string | null | undefined): Promise<boolean> => {
    const usable = typeof storedHash === 'string' && BCRYPT_HASH_SHAPE.test(storedHash);
    const compared = usable ? storedHash : _dummyHash();
    const matches = await bcrypt.compare(passwordHelper.normalisePassword(password), compared);
    return usable && matches === true;
};

/**
 * bcrypt's own "would this be truncated" check, passed into `evaluatePasswordPolicy` as a second
 * opinion beside the helper's byte count.
 *
 * @param password - The NFC-normalised candidate.
 * @returns True when bcrypt would ignore part of it.
 */
const passwordTruncates = (password: string): boolean => {
    return bcrypt.truncates(password);
};

/**
 * Whether a stored hash was written at a cost other than the configured one (spec A4: rehash on the
 * next successful sign-in). A hash whose cost cannot be read is left alone.
 *
 * @param storedHash - The user's `password_hash`.
 * @returns True when a rehash is due.
 */
const needsRehash = (storedHash: string): boolean => {
    if (typeof storedHash !== 'string' || !BCRYPT_HASH_SHAPE.test(storedHash)) {
        return false;
    }
    const rounds = bcrypt.getRounds(storedHash);
    return Number.isInteger(rounds) && rounds !== bcryptRounds();
};

export = {
    bcryptRounds,
    hashPassword,
    verifyPassword,
    passwordTruncates,
    needsRehash
};
