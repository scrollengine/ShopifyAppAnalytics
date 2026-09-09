/**
 * Shapes the auth module hands back.
 *
 * Declarations only — no runtime imports. The two `typeof import(...)` references below are type
 * queries, erased entirely at compile time, so requiring anything that imports this file still costs
 * nothing at run time.
 */

/** The frozen vocabulary objects, as types. Erased — this loads nothing. */
type AuthConstantsModule = typeof import('../constants/adminAuth.constants');

/**
 * What the seeder did, derived from `ADMIN_SEED_OUTCOMES` rather than re-typed, so adding an outcome
 * to the constant is the only edit an outcome ever needs.
 */
export type AdminSeedOutcome = AuthConstantsModule['ADMIN_SEED_OUTCOMES'][keyof AuthConstantsModule['ADMIN_SEED_OUTCOMES']];

/** Which environment variable the seeded hash came from. Derived, for the same reason. */
export type AdminPasswordSource = AuthConstantsModule['ADMIN_PASSWORD_SOURCES'][keyof AuthConstantsModule['ADMIN_PASSWORD_SOURCES']];

/**
 * The payload of a session token.
 *
 * Deliberately tiny. A JWT is base64, not encrypted: everything in it is readable by anyone holding
 * the token, and it is copied into browser storage and every request log. So it carries an id and
 * nothing else — no email, no role, no settings. Anything a handler needs beyond the identity it
 * should read from the database, where it is current, rather than from a token minted twelve hours
 * ago.
 */
export interface AdminTokenPayload {
    /** The operator's `gi_admin_users` `_id`, as a string. */
    user_id: string;
}

/** What `verifyToken` resolves with on success. */
export interface VerifiedAdminToken {
    /** The operator id carried by the token. */
    user_id: string;
    /** Token expiry, as a Date, when the token carried an `exp` claim. */
    expires_at: Date | null;
}

/**
 * What `login` resolves with on success.
 *
 * ⚠️ There is no `password_hash` here and there never should be. The login path is the only place
 * that reads the hash at all, and the object it builds is assembled field by field from the stored
 * document rather than by spreading it — a spread is how a `select: false` field that someone later
 * makes selectable ends up on the wire.
 */
export interface AdminLoginResult {
    /** The signed session token. Send it back as `Authorization: Bearer <token>`. */
    token: string;
    /** Seconds until the token expires, so a client can schedule a re-login rather than discover it with a 401. */
    expires_in_seconds: number;
    /** Absolute expiry, for a client that would rather compare clocks. */
    expires_at: Date;
    /** The operator who signed in. */
    user_id: string;
    /** Their normalised (lowercased, trimmed) email. */
    email: string;
}

/** What `seedAdminIfMissing` resolves with. */
export interface AdminSeedResult {
    /** Whether an account was created or one was already there. Both are success. */
    outcome: AdminSeedOutcome;
    /** The operator id — of the account created, or of the one that already existed. */
    user_id: string;
    /** The normalised email the account is keyed by. */
    email: string;
    /**
     * Which environment variable supplied the hash, on a CREATE. Null when nothing was created.
     *
     * ⚠️ Never the password, hashed or otherwise. This field names a variable; it does not carry a
     * value from one.
     */
    password_source: AdminPasswordSource | null;
}
