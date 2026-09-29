'use strict';

/**
 * Auth module vocabulary, messages and fixed limits.
 *
 * Three kinds of value live here:
 *   1. VOCABULARY re-exported BY REFERENCE from `src/constants/authVocab.constants` — the same frozen
 *      objects the auth schemas build their `enum` gates from, so a value this module writes cannot
 *      fail validation at insert time. Nothing is re-spelled.
 *   2. MESSAGES and CODES — what the module may say, and the `error.code` values controllers map to
 *      HTTP statuses. Messages that must be IDENTICAL across outcomes (the login failure, the
 *      setup-request and forgot-password acknowledgements) are single constants referenced from
 *      every branch: written inline twice they drift, and any difference is an enumeration oracle.
 *   3. FIXED LIMITS that are security policy rather than deployment tuning (token shape, password
 *      bounds, throttles). Anything an operator should tune is in `config.AUTH`.
 *
 * DEPENDENCY-FREE apart from the vocabulary leaf, so middleware, helpers and tests can read it.
 */

import authVocab = require('../../../constants/authVocab.constants');

/** Everything this module is allowed to tell a caller. */
const AUTH_MESSAGES = Object.freeze({
    /**
     * The single answer to every failed login — unknown email, wrong password, disabled user. Do
     * not add a variant or append a reason: any textual difference tells an attacker which half of
     * a guess was right.
     */
    INVALID_CREDENTIALS: 'Email or password is incorrect.',
    /** Not an oracle: it says nothing about whether any account exists. */
    CREDENTIALS_REQUIRED: 'Email and password are both required.',
    LOGIN_OK: 'Signed in.',
    /** Something threw inside login before a credential decision. A 500, never a 401. */
    LOGIN_FAILED: 'Could not sign you in. Check the server logs.',
    /**
     * ⚠️ BOTH guard messages must keep starting with "Not authenticated." — the route-guard test
     * matches that prefix to recognise a guard refusal.
     */
    SESSION_INVALID: 'Not authenticated. Sign in again.',
    AUTH_HEADER_MISSING: 'Not authenticated. Send an Authorization: Bearer <token> header.',
    /** The guard could not consult the datastore. 503: fail closed, but do not log the user out. */
    SESSION_CHECK_UNAVAILABLE: 'Could not verify your session right now. Try again in a moment.',
    LOGGED_OUT: 'Signed out.',
    /** A session token or a principal load that succeeded. Never shown to anyone in practice. */
    SESSION_OK: 'Session is valid.',

    /**
     * The ONE acknowledgement for `POST /api/auth/setup`, whether or not the address may set up this
     * install. The service appends the link lifetime (a config value, identical for every caller).
     */
    SETUP_REQUEST_ACCEPTED: 'If this address may set up this install, a verification email is on its way.',
    SETUP_ALREADY_COMPLETE: 'Setup is already complete. Sign in instead.',
    SETUP_CAPACITY: 'Too many setup requests are waiting to be confirmed. Use one of the links already sent, or try again later.',
    SETUP_COMPLETED: 'Setup is complete. Sign in with your new password.',

    TOKEN_INVALID: 'This link is not valid. Request a new one.',
    TOKEN_EXPIRED: 'This link has expired. Request a new one.',
    TOKEN_USED: 'This link has already been used.',
    INVITE_REVOKED: 'This invitation was withdrawn. Ask your admin to send a new one.',

    /** The ONE acknowledgement for `POST /api/auth/password/forgot`, whether or not an account exists. */
    PASSWORD_RESET_REQUESTED: 'If an active account uses this address, a password-reset email is on its way.',
    PASSWORD_RESET_DONE: 'Your password has been reset. Sign in with the new one.',
    PASSWORD_CHANGED: 'Your password has been changed. Your other sessions were signed out.',
    /** A 400, never a 401 — the frontend signs the user out on any 401. */
    CURRENT_PASSWORD_INCORRECT: 'Your current password is incorrect.',

    VALIDATION: 'The request is missing a field or has one in the wrong format.',
    NOT_FOUND: 'Not found.',
    FORBIDDEN: 'Your role does not allow this.',
    RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
    DATASTORE_ERROR: 'Could not reach the database. Try again in a moment.',
    INDEXES_NOT_READY: 'The server is still preparing its database. Try again in a moment.',

    ALREADY_A_MEMBER: 'Someone with this email address is already a member.',
    INVITE_PENDING: 'An invitation for this address is already outstanding. Re-send it instead.',
    INVITE_NOT_PENDING: 'This invitation has already been accepted or revoked.',
    INVITE_CREATED: 'Invitation sent.',
    /** 201 all the same: the invite exists. "Accepted by the mail server" is the most we ever claim. */
    INVITE_CREATED_EMAIL_NOT_SENT: 'The invitation was created, but the mail server did not accept the message. Re-send it once mail is working.',
    INVITE_RESENT: 'Invitation re-sent.',
    INVITE_REVOKED_OK: 'Invitation revoked.',
    INVITE_ACCEPTED: 'Your account is ready. Sign in with your new password.',

    ROLE_NAME_TAKEN: 'A role with this name already exists.',
    ROLE_IN_USE: 'This role is still assigned to a user or an outstanding invitation.',
    ROLE_NOT_FOUND: 'That custom role no longer exists.',

    /** Something threw that is not a datastore outage. A 500; the log carries the cause. */
    INTERNAL_ERROR: 'Something went wrong on the server. Check the server logs.',
    /** A link token the server could not form: APP_PUBLIC_URL is unusable (boot validation should have refused it). */
    PUBLIC_URL_MISSING: 'APP_PUBLIC_URL is not set to a usable address, so no link can be built.',

    SETUP_STATUS: 'Setup status.',
    /** A token inspect succeeded. Says nothing beyond "the link works". */
    TOKEN_OK: 'This link is valid.',

    PASSWORD_RESET_SENT: 'Password-reset email sent.',
    /** Prefix for an admin-triggered reset whose email was not confirmed; the mail module's sentence follows. */
    PASSWORD_RESET_LINK_CREATED: 'A new password-reset link was created.',
    INVITE_CREATED_PREFIX: 'The invitation was created.',
    INVITE_RESENT_PREFIX: 'The invitation was renewed.',
    /** Appended when the mail server refused, the cap was reached or mail is not configured. */
    EMAIL_RETRY_HINT: 'Re-send it once mail is working.',

    USERS_LISTED: 'Users.',
    INVITES_LISTED: 'Invitations.',
    ROLES_LISTED: 'Roles.',
    AUDIT_LISTED: 'Activity.',
    ACCOUNT_OK: 'Your account.',
    ACCOUNT_NAME_UPDATED: 'Your name has been updated.',
    SESSIONS_SELF_REVOKED: 'Your other sessions have been signed out.',

    USER_ROLE_CHANGED: 'Role changed.',
    USER_ROLE_UNCHANGED: 'This user already has that role.',
    USER_DISABLED: 'User disabled. Their sessions have ended.',
    USER_ENABLED: 'User enabled. They can sign in with their existing password.',
    USER_SESSIONS_REVOKED: 'The user has been signed out everywhere.',
    USER_ALREADY_DISABLED: 'This user is already disabled.',
    USER_ALREADY_ACTIVE: 'This user is already active.',
    /** An admin-triggered reset for a disabled user. */
    USER_NOT_ACTIVE: 'This user is disabled. Enable them before sending a password reset.',
    /** A CAS precondition on the target's role failed: someone else changed them in between. */
    TARGET_CHANGED: 'This user was changed by someone else just now. Reload and try again.',

    ROLE_CREATED: 'Role created.',
    ROLE_UPDATED: 'Role updated.',
    ROLE_DELETED: 'Role deleted.',

    // ── Boot and the recovery CLI (operator-facing; never sent to a browser) ──
    INSTALL_STATE_READY: 'Install state is present.',
    AUTH_INDEXES_READY: 'Auth indexes are in place.',
    LEGACY_OPERATORS_MARKED: 'Legacy operator accounts marked.',
    SETUP_RECONCILED: 'Setup reconciliation finished.',
    SETUP_STATE_LOGGED: 'Setup state logged.',
    RECOVERY_STATUS: 'Recovery status.',
    SETUP_NOT_PERMITTED: 'This address may not claim setup on this install.',
    SETUP_INCOMPLETE: 'Setup has not been completed on this install yet.',
    OWNER_PRESENT: 'The owner account exists. repair-owner is only for a missing owner; use transfer-owner to move ownership.',
    ALREADY_OWNER: 'That user is already the owner.',
    SETUP_LINK_ISSUED: 'Setup link created.',
    RESET_LINK_ISSUED: 'Password-reset link created.',
    CLI_SESSIONS_REVOKED: 'Sessions revoked.',
    CLI_USER_ENABLED: 'User enabled.',
    OWNERSHIP_TRANSFERRED: 'Ownership transferred.',
    OWNER_REPAIRED: 'Owner account recreated. Use the password-reset link to choose a password.'
} as const);

/**
 * The `error.code` values services put in a failure envelope. Controllers map these to HTTP
 * statuses with one table (spec §8): VALIDATION / TOKEN_* / INVITE_REVOKED / PASSWORD_POLICY /
 * CURRENT_PASSWORD_INCORRECT → 400; NOT_FOUND → 404; the conflicts → 409; FORBIDDEN → 403;
 * RATE_LIMITED / SETUP_CAPACITY → 429; DATASTORE_ERROR / INDEXES_NOT_READY → 503.
 */
const AUTH_ERROR_CODES = Object.freeze({
    VALIDATION: 'VALIDATION',
    CREDENTIALS_REQUIRED: 'CREDENTIALS_REQUIRED',
    INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
    AUTH_HEADER_MISSING: 'AUTH_HEADER_MISSING',
    SESSION_INVALID: 'SESSION_INVALID',
    TOKEN_INVALID: 'TOKEN_INVALID',
    TOKEN_EXPIRED: 'TOKEN_EXPIRED',
    TOKEN_USED: 'TOKEN_USED',
    INVITE_REVOKED: 'INVITE_REVOKED',
    PASSWORD_POLICY: 'PASSWORD_POLICY',
    CURRENT_PASSWORD_INCORRECT: 'CURRENT_PASSWORD_INCORRECT',
    NOT_FOUND: 'NOT_FOUND',
    SETUP_ALREADY_COMPLETE: 'SETUP_ALREADY_COMPLETE',
    SETUP_CAPACITY: 'SETUP_CAPACITY',
    ALREADY_A_MEMBER: 'ALREADY_A_MEMBER',
    INVITE_PENDING: 'INVITE_PENDING',
    INVITE_NOT_PENDING: 'INVITE_NOT_PENDING',
    ROLE_NAME_TAKEN: 'ROLE_NAME_TAKEN',
    ROLE_IN_USE: 'ROLE_IN_USE',
    ROLE_NOT_FOUND: 'ROLE_NOT_FOUND',
    FORBIDDEN: 'FORBIDDEN',
    RATE_LIMITED: 'RATE_LIMITED',
    DATASTORE_ERROR: 'DATASTORE_ERROR',
    INDEXES_NOT_READY: 'INDEXES_NOT_READY',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    /** Disable of a disabled user, enable of an active one, admin reset for a disabled one. 409. */
    USER_STATUS_CONFLICT: 'USER_STATUS_CONFLICT',
    /** The target's role changed between the management decision and the write (CAS lost). 409. */
    TARGET_CHANGED: 'TARGET_CHANGED',
    /** No link can be formed: APP_PUBLIC_URL is unusable. 500 (boot validation normally refuses first). */
    PUBLIC_URL_MISSING: 'PUBLIC_URL_MISSING',
    /** CLI only: `setup-link` for an address the pin / legacy rule refuses. */
    SETUP_NOT_PERMITTED: 'SETUP_NOT_PERMITTED',
    /** CLI only: a command that needs a locked install ran while setup is open. */
    SETUP_INCOMPLETE: 'SETUP_INCOMPLETE',
    /** CLI only: `repair-owner` while the owner row exists. */
    OWNER_PRESENT: 'OWNER_PRESENT'
} as const);

/**
 *  THE ONE code → HTTP status table (spec §8). Every `error.code` a service in this module can put in
 * a failure envelope is a key here, including the `loadPrincipal` refusal reasons, so the HTTP layer
 * maps with a lookup instead of re-spelling the table per controller. A code missing from this table
 * is a 500 — a new code must be added here in the same change that first returns it.
 *
 * ⚠️ A public token endpoint never answers 401 (the frontend signs out on any 401): TOKEN_* and
 * INVITE_REVOKED are 400, and so is CURRENT_PASSWORD_INCORRECT.
 */
const AUTH_ERROR_HTTP_STATUS = Object.freeze({
    VALIDATION: 400,
    CREDENTIALS_REQUIRED: 400,
    TOKEN_INVALID: 400,
    TOKEN_EXPIRED: 400,
    TOKEN_USED: 400,
    INVITE_REVOKED: 400,
    PASSWORD_POLICY: 400,
    CURRENT_PASSWORD_INCORRECT: 400,
    INVALID_CREDENTIALS: 401,
    AUTH_HEADER_MISSING: 401,
    SESSION_INVALID: 401,
    NO_SESSION: 401,
    SESSION_REVOKED: 401,
    SESSION_EXPIRED: 401,
    SESSION_USER_MISMATCH: 401,
    SESSION_STALE: 401,
    NO_USER: 401,
    USER_DISABLED: 401,
    FORBIDDEN: 403,
    SETUP_NOT_PERMITTED: 403,
    NOT_FOUND: 404,
    SETUP_ALREADY_COMPLETE: 409,
    ALREADY_A_MEMBER: 409,
    INVITE_PENDING: 409,
    INVITE_NOT_PENDING: 409,
    ROLE_NAME_TAKEN: 409,
    ROLE_IN_USE: 409,
    ROLE_NOT_FOUND: 409,
    USER_STATUS_CONFLICT: 409,
    TARGET_CHANGED: 409,
    SETUP_INCOMPLETE: 409,
    OWNER_PRESENT: 409,
    RATE_LIMITED: 429,
    SETUP_CAPACITY: 429,
    INTERNAL_ERROR: 500,
    PUBLIC_URL_MISSING: 500,
    DATASTORE_ERROR: 503,
    INDEXES_NOT_READY: 503
} as const);

/**
 * Why `loadPrincipal` refused. Every reason except DATASTORE_ERROR is an authentication failure
 * (401); DATASTORE_ERROR is 503 — fail closed without signing the user out.
 */
const SESSION_FAILURE_REASONS = Object.freeze({
    NO_SESSION: 'NO_SESSION',
    SESSION_REVOKED: 'SESSION_REVOKED',
    SESSION_EXPIRED: 'SESSION_EXPIRED',
    SESSION_USER_MISMATCH: 'SESSION_USER_MISMATCH',
    /** `session.epoch !== user.session_epoch` — a reset, disable or "sign out everywhere" happened after sign-in. */
    SESSION_STALE: 'SESSION_STALE',
    NO_USER: 'NO_USER',
    USER_DISABLED: 'USER_DISABLED',
    DATASTORE_ERROR: 'DATASTORE_ERROR'
} as const);

/** Why a session row was marked `revoked_at`. Stored on `gi_auth_sessions.revoked_reason`. */
const SESSION_REVOKE_REASONS = Object.freeze({
    /** The user signed out (current session only; no epoch bump). */
    LOGOUT: 'LOGOUT',
    PASSWORD_RESET: 'PASSWORD_RESET',
    /** The user changed their own password; every OTHER session ends. */
    PASSWORD_CHANGED: 'PASSWORD_CHANGED',
    /** "Sign out my other sessions". */
    SELF_REVOKED: 'SELF_REVOKED',
    USER_DISABLED: 'USER_DISABLED',
    /** An admin signed the user out. */
    ADMIN_REVOKED: 'ADMIN_REVOKED',
    /** The recovery CLI `revoke-sessions`. */
    CLI_REVOKED: 'CLI_REVOKED'
} as const);

/** Which password rule refused. Carried beside `error.code: 'PASSWORD_POLICY'`. */
const PASSWORD_POLICY_CODES = Object.freeze({
    NOT_A_STRING: 'NOT_A_STRING',
    TOO_SHORT: 'TOO_SHORT',
    /** Over 72 UTF-8 bytes: bcrypt would silently ignore the rest, so it is refused, never truncated. */
    TOO_LONG: 'TOO_LONG',
    REPEATED_CHARACTER: 'REPEATED_CHARACTER',
    COMMON_PASSWORD: 'COMMON_PASSWORD',
    CONTAINS_EMAIL: 'CONTAINS_EMAIL',
    MATCHES_NAME: 'MATCHES_NAME'
} as const);

/** The sentence shown for each policy refusal. Safe to show: it describes the rule, not the account. */
const PASSWORD_POLICY_MESSAGES = Object.freeze({
    NOT_A_STRING: 'Enter a password.',
    TOO_SHORT: 'Use at least 15 characters. A few unrelated words make a strong, memorable passphrase.',
    TOO_LONG: 'That password is too long (over 72 bytes). Use a shorter passphrase.',
    REPEATED_CHARACTER: 'A password made of one repeated character is too easy to guess.',
    COMMON_PASSWORD: 'That password appears on lists of commonly used passwords. Choose another.',
    CONTAINS_EMAIL: 'Your password must not contain your email address.',
    MATCHES_NAME: 'Your password must not be your name.'
} as const);

/**
 * Why the management rule (`management.helper#evaluateManagement`) refused. Surfaced as
 * `UserView.manage_block_reason` so the UI can say why a row's actions are disabled.
 */
const MANAGEMENT_BLOCK_REASONS = Object.freeze({
    /** Admin endpoints never act on the caller; `/api/account` is for that. */
    SELF: 'SELF',
    /** Nobody acts on the owner through the API; ownership moves only via the CLI. */
    TARGET_IS_OWNER: 'TARGET_IS_OWNER',
    MISSING_USERS_MANAGE: 'MISSING_USERS_MANAGE',
    /** The target's permissions are not a strict subset of the actor's. */
    TARGET_NOT_BELOW_ACTOR: 'TARGET_NOT_BELOW_ACTOR',
    /** The role being assigned or invited is not a strict subset of the actor's permissions. */
    ROLE_NOT_BELOW_ACTOR: 'ROLE_NOT_BELOW_ACTOR',
    /** The role carries an owner-only key; no one can hand it out. */
    ROLE_NOT_ASSIGNABLE: 'ROLE_NOT_ASSIGNABLE'
} as const);

/** Session JWT `aud`. Verify pins it, so a token minted for anything else is refused. */
const JWT_AUDIENCE = 'shopify-app-analytics';

/** Pinned on BOTH sign and verify. Unpinned, `jwt.verify` honours the `alg` the token itself declares. */
const TOKEN_ALGORITHM = 'HS256' as const;

/**
 * The session JWT is signed with HMAC-SHA256(JWT_SECRET, this label), never with JWT_SECRET itself.
 *
 * ⚠️ This is what makes a rollback safe. The single-operator build verified any HS256 token signed
 * with the raw JWT_SECRET and read nothing else (no session row, no user row), so it would accept
 * every token this build issues, including a Viewer's, a disabled account's and a signed-out
 * session's, as the one full operator. Reproduced against `git show HEAD`'s verifyToken before this
 * key existed. A token signed with the derived key fails that build's signature check. Changing the
 * label signs everyone out, exactly like rotating JWT_SECRET.
 */
const SESSION_SIGNING_KEY_LABEL = 'shopify-app-analytics/session-jwt/v2';

/** Sign-in device tokens are MACed with a key derived the same way, under their own label. */
const LOGIN_DEVICE_KEY_LABEL = 'shopify-app-analytics/login-device/v1';

/** How long a sign-in device token lasts. Every successful sign-in hands out a fresh one. */
const LOGIN_DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Email-link tokens: 32 random bytes, base64url → exactly 43 characters. */
const LINK_TOKEN_BYTES = 32;
const TOKEN_REGEX = /^[A-Za-z0-9_-]{43}$/;

/** A Mongo ObjectId in its canonical lowercase hex form. Checked before any lookup (no CastError 500s). */
const OBJECT_ID_REGEX = /^[0-9a-f]{24}$/;

/** NIST SP 800-63B-4 single-factor minimum, counted in code points after NFC. */
const PASSWORD_MIN_LENGTH = 15;
/** bcrypt reads at most 72 bytes; a longer password is REFUSED, never truncated. */
const PASSWORD_MAX_BYTES = 72;
/** The email local part is checked for containment only when it is at least this long. */
const PASSWORD_EMAIL_LOCAL_PART_MIN_LENGTH = 4;

const EMAIL_MAX_LENGTH = 254;
const NAME_MAX_LENGTH = 100;
const ROLE_NAME_MAX_LENGTH = 60;
const ROLE_DESCRIPTION_MAX_LENGTH = 280;
/** A custom-role `permissions` array longer than this is refused before it is walked. */
const ROLE_PERMISSIONS_INPUT_MAX = 64;
const USER_AGENT_MAX_LENGTH = 200;

/** Global cap on live SETUP_VERIFY tokens. Reached ⇒ 429 SETUP_CAPACITY; nothing is evicted. */
const SETUP_MAX_LIVE_TOKENS = 10;
/** Live SETUP_VERIFY tokens per address; extra requests are silently dropped. */
const SETUP_MAX_LIVE_PER_EMAIL = 3;
const SETUP_REQUEST_MIN_INTERVAL_MS = 60 * 1000;
const SETUP_REQUEST_MAX_PER_HOUR = 3;

const PASSWORD_RESET_MIN_INTERVAL_MS = 60 * 1000;
const PASSWORD_RESET_MAX_PER_WINDOW = 3;
const PASSWORD_RESET_WINDOW_MS = 60 * 60 * 1000;
/** Entries kept in `gi_users.reset_send_log` (newest first). Must exceed PASSWORD_RESET_MAX_PER_WINDOW. */
const RESET_SEND_LOG_KEEP = 10;
/** Lifetime of a reset link printed by the recovery CLI. */
const CLI_RESET_LINK_TTL_MINUTES = 15;

const INVITE_RESEND_MIN_INTERVAL_MS = 60 * 1000;
/** Sends (create included) per invite per rolling 24 h. */
const INVITE_MAX_SENDS_PER_WINDOW = 5;
const INVITE_SEND_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Entries kept in `gi_invites.send_log` (newest first). Must exceed INVITE_MAX_SENDS_PER_WINDOW. */
const INVITE_SEND_LOG_KEEP = 10;
/** Invites one actor may CREATE per rolling 24 h. */
const INVITE_CREATE_MAX_PER_WINDOW = 20;
const INVITE_CREATE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** `AUTH_INVITE_TTL_HOURS` is clamped into this range by the service. */
const INVITE_TTL_MIN_HOURS = 1;
const INVITE_TTL_MAX_HOURS = 168;

/**
 * `AUTH_SETUP_TOKEN_TTL_MINUTES` and `AUTH_PASSWORD_RESET_TTL_MINUTES` are clamped into this range.
 * The floor stops a 0 or negative value minting links that are dead on arrival; the ceiling (7 days,
 * the token TTL-index retention) stops an absurd value overflowing the Date.
 */
const LINK_TTL_MIN_MINUTES = 1;
const LINK_TTL_MAX_MINUTES = 7 * 24 * 60;

/**
 * The frontend pages an emailed link opens. `authToken.service#buildAppLink` refuses any other path,
 * so a link can only ever point at one of these on `APP_PUBLIC_URL`. The token rides in the
 * fragment (`#token=…`, spec I3). A CROSS-REPOSITORY CONTRACT with `frontend/pages/`.
 */
const APP_LINK_PATHS = Object.freeze({
    SETUP_VERIFY: '/setup/verify',
    ACCEPT_INVITE: '/accept-invite',
    RESET_PASSWORD: '/reset-password'
} as const);

/**
 * Sentinel `identity.user_id` values for work no signed-in user performs. The mail module refuses a
 * send without an identity, and a log line should name an actor rather than carry a blank.
 */
const AUTH_SERVICE_ACTORS = Object.freeze({
    /** A public, unauthenticated request (setup request, forgot-password, token pages). */
    ANONYMOUS: 'AUTH_ANONYMOUS_REQUEST',
    /** Boot work: install state, legacy marking, setup reconciliation. */
    SYSTEM: 'AUTH_SYSTEM',
    /** The recovery CLI. */
    CLI: 'AUTH_CLI'
} as const);

/**
 * Which rule decides who may claim setup (spec §0.2 / A7), in precedence order: a pinned
 * `SETUP_OWNER_EMAIL`; else the legacy operator emails when any legacy row exists; else OPEN
 * (first come, with a loud boot WARN).
 */
const SETUP_ELIGIBILITY_RULES = Object.freeze({
    PIN: 'PIN',
    LEGACY: 'LEGACY',
    OPEN: 'OPEN'
} as const);

export = {
    USER_STATUSES: authVocab.USER_STATUSES,
    ROLE_KEYS: authVocab.ROLE_KEYS,
    STORED_ROLE_KEYS: authVocab.STORED_ROLE_KEYS,
    CREATED_VIA: authVocab.CREATED_VIA,
    TOKEN_PURPOSES: authVocab.TOKEN_PURPOSES,
    AUDIT_ACTOR_TYPES: authVocab.AUDIT_ACTOR_TYPES,
    AUDIT_TARGET_TYPES: authVocab.AUDIT_TARGET_TYPES,
    INSTALL_STATE_ID: authVocab.INSTALL_STATE_ID,
    AUTH_MESSAGES,
    AUTH_ERROR_CODES,
    AUTH_ERROR_HTTP_STATUS,
    SESSION_FAILURE_REASONS,
    SESSION_REVOKE_REASONS,
    PASSWORD_POLICY_CODES,
    PASSWORD_POLICY_MESSAGES,
    MANAGEMENT_BLOCK_REASONS,
    JWT_AUDIENCE,
    TOKEN_ALGORITHM,
    SESSION_SIGNING_KEY_LABEL,
    LOGIN_DEVICE_KEY_LABEL,
    LOGIN_DEVICE_TTL_MS,
    LINK_TOKEN_BYTES,
    TOKEN_REGEX,
    OBJECT_ID_REGEX,
    PASSWORD_MIN_LENGTH,
    PASSWORD_MAX_BYTES,
    PASSWORD_EMAIL_LOCAL_PART_MIN_LENGTH,
    EMAIL_MAX_LENGTH,
    NAME_MAX_LENGTH,
    ROLE_NAME_MAX_LENGTH,
    ROLE_DESCRIPTION_MAX_LENGTH,
    ROLE_PERMISSIONS_INPUT_MAX,
    USER_AGENT_MAX_LENGTH,
    SETUP_MAX_LIVE_TOKENS,
    SETUP_MAX_LIVE_PER_EMAIL,
    SETUP_REQUEST_MIN_INTERVAL_MS,
    SETUP_REQUEST_MAX_PER_HOUR,
    PASSWORD_RESET_MIN_INTERVAL_MS,
    PASSWORD_RESET_MAX_PER_WINDOW,
    PASSWORD_RESET_WINDOW_MS,
    RESET_SEND_LOG_KEEP,
    CLI_RESET_LINK_TTL_MINUTES,
    INVITE_RESEND_MIN_INTERVAL_MS,
    INVITE_MAX_SENDS_PER_WINDOW,
    INVITE_SEND_WINDOW_MS,
    INVITE_SEND_LOG_KEEP,
    INVITE_CREATE_MAX_PER_WINDOW,
    INVITE_CREATE_WINDOW_MS,
    INVITE_TTL_MIN_HOURS,
    INVITE_TTL_MAX_HOURS,
    LINK_TTL_MIN_MINUTES,
    LINK_TTL_MAX_MINUTES,
    APP_LINK_PATHS,
    AUTH_SERVICE_ACTORS,
    SETUP_ELIGIBILITY_RULES
};
