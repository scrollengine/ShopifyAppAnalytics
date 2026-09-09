/**
 * Authentication vocabulary: the messages this module is allowed to say, and the outcomes the
 * seeder can report.
 *
 *  DEPENDENCY-FREE. Nothing is imported here, so the service, the middleware and any future test
 * can all read this file without dragging config, mongoose or a logger in behind it.
 *
 * ── Why the messages live in a constant at all ──────────────────────────────────────────────────
 * `INVALID_CREDENTIALS` is returned for BOTH "no account with that email" and "that password is
 * wrong", and the two must be textually identical — any difference at all, including punctuation,
 * is a user-enumeration oracle: an attacker learns which half of a guess was right and can confirm
 * an operator's email address without ever knowing their password.
 *
 * Written inline at two call sites, those two strings drift the first time somebody improves one of
 * them ("No account found with that email" is a very natural edit). Written once, referenced twice,
 * they cannot. That is the whole reason this constant exists — it is a security control, not tidiness.
 */

/** Everything this module is allowed to tell a caller. */
const AUTH_MESSAGES = Object.freeze({
    /**
     *  The single answer to every failed login, whatever actually went wrong. Do not add a second
     * variant, do not append a reason, and do not branch on the cause to make it friendlier.
     */
    INVALID_CREDENTIALS: 'Email or password is incorrect.',
    /**
     * The request did not carry both fields. Safe to be specific: it says nothing about whether any
     * account exists, so it is not an oracle — it is a malformed request.
     */
    CREDENTIALS_REQUIRED: 'Email and password are both required.',
    /** Login succeeded. */
    LOGIN_OK: 'Signed in.',
    /** The token verified. */
    TOKEN_VALID: 'Token is valid.',
    /**
     * Presented to the client for a missing, malformed, expired or badly-signed token — one message
     * for all four. The distinction matters to the operator reading logs, not to the caller, and
     * "your signature is wrong" is a hint worth withholding.
     */
    SESSION_INVALID: 'Not authenticated. Sign in again.',
    /** The guard found no `Authorization: Bearer <token>` header at all. */
    AUTH_HEADER_MISSING: 'Not authenticated. Send an Authorization: Bearer <token> header.',
    /** The seeder had no email to seed with. */
    SEED_NO_EMAIL: 'ADMIN_EMAIL is not set, so no operator account could be created.',
    /** The seeder had an email but no password material of either kind. */
    SEED_NO_PASSWORD: 'Neither ADMIN_PASSWORD nor ADMIN_PASSWORD_HASH is set, so no operator account could be created.',
    /** The seeder created the account. */
    SEED_CREATED: 'Operator account created.',
    /** The seeder found one already there and left it alone. */
    SEED_ALREADY_PRESENT: 'Operator account already exists — nothing was changed.',
    /** Something threw inside the seeder. */
    SEED_FAILED: 'Could not create the operator account.',
    /** Something threw inside login, before any credential decision was reached. */
    LOGIN_FAILED: 'Could not sign you in. Check the server logs.'
} as const);

/**
 * What `seedAdminIfMissing` did.
 *
 * A caller (the boot sequence, a test) needs to distinguish "I created the account" from "it was
 * already there" — both are success, and only one of them should print a first-run banner. Returning
 * a vocabulary term rather than a boolean means a third outcome can be added later without changing
 * the shape everyone reads.
 */
const ADMIN_SEED_OUTCOMES = Object.freeze({
    /** No account existed; one was inserted. */
    CREATED: 'CREATED',
    /** An account with this email already existed. Its password was NOT touched. */
    ALREADY_PRESENT: 'ALREADY_PRESENT'
} as const);

/** Where the seeded password hash came from. Logged, so a first-run install can be explained later. */
const ADMIN_PASSWORD_SOURCES = Object.freeze({
    /** `ADMIN_PASSWORD_HASH` — already a bcrypt hash, stored verbatim. */
    PRE_HASHED: 'ADMIN_PASSWORD_HASH',
    /** `ADMIN_PASSWORD` — plaintext from the environment, hashed here before it is stored. */
    HASHED_AT_SEED: 'ADMIN_PASSWORD'
} as const);

/*
 * ⚠️ No `export type` alongside the export assignment below — TypeScript refuses a module that has
 * both (TS2309). The unions derived from these objects therefore live in `../types/adminAuth.types`,
 * which pulls them out with `typeof import(...)`: erased at compile time, so it stays a
 * declarations-only file and this stays a dependency-free one, and neither can drift from the other.
 */

export = {
    AUTH_MESSAGES,
    ADMIN_SEED_OUTCOMES,
    ADMIN_PASSWORD_SOURCES
};
