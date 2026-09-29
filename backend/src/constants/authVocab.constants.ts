'use strict';

/**
 * Authentication vocabulary shared by the auth models, the auth module and the sync health check.
 *
 *  DEPENDENCY-FREE, like `syncJob.constants`: the `gi_users` / `gi_invites` / `gi_auth_tokens` /
 * `gi_audit_events` schemas build their mongoose `enum` gates from these objects, and
 * `modules/auth/constants/auth.constants` re-exports them by reference. It lives here, below both,
 * so `modules/sync` can read a user status without importing `modules/auth` (which would close an
 * import cycle through the barrels — recurring failure mode #4).
 *
 * Every value is a stored string. Renaming one orphans every row already written with the old
 * spelling, so a value here is changed only with a migration.
 */

/** Whether a `gi_users` row may sign in. There is no deletion: a leaver is disabled. */
const USER_STATUSES = Object.freeze({
    ACTIVE: 'active',
    DISABLED: 'disabled'
} as const);

/**
 * Every role key a principal can resolve to.
 *
 * `owner` is NOT storable (see `STORED_ROLE_KEYS`): ownership is the pointer
 * `gi_system_states.owner_user_id`, never a value on a user row, so exactly one derivation decides
 * who the owner is.
 */
const ROLE_KEYS = Object.freeze({
    OWNER: 'owner',
    ADMIN: 'admin',
    ANALYST: 'analyst',
    VIEWER: 'viewer',
    CUSTOM: 'custom'
} as const);

/**
 * What `gi_users.role_key` and `gi_invites.role_key` may hold. `owner` is deliberately absent; the
 * owner's stored key is `admin`, a fallback that only matters if ownership moves away from them.
 */
const STORED_ROLE_KEYS = Object.freeze([
    ROLE_KEYS.ADMIN,
    ROLE_KEYS.ANALYST,
    ROLE_KEYS.VIEWER,
    ROLE_KEYS.CUSTOM
] as const);

/** How a `gi_users` row came to exist. */
const CREATED_VIA = Object.freeze({
    SETUP: 'setup',
    INVITE: 'invite'
} as const);

/** What a `gi_auth_tokens` row may be spent on. A token of one purpose is never accepted for another. */
const TOKEN_PURPOSES = Object.freeze({
    SETUP_VERIFY: 'SETUP_VERIFY',
    PASSWORD_RESET: 'PASSWORD_RESET'
} as const);

/** Who performed an audited action. */
const AUDIT_ACTOR_TYPES = Object.freeze({
    /** A signed-in user acting through the API. */
    USER: 'USER',
    /** A public, unauthenticated request (setup request, forgot-password). */
    ANONYMOUS: 'ANONYMOUS',
    /** The server itself — boot reconciliation, legacy marking. */
    SYSTEM: 'SYSTEM',
    /** The recovery CLI, run by someone with shell access. */
    CLI: 'CLI'
} as const);

/** What an audited action was performed on. `null` on a row means "no specific target". */
const AUDIT_TARGET_TYPES = Object.freeze({
    USER: 'USER',
    INVITE: 'INVITE',
    ROLE: 'ROLE',
    SESSION: 'SESSION',
    INSTALL: 'INSTALL'
} as const);

/** The `_id` of the one and only `gi_system_states` document. */
const INSTALL_STATE_ID = 'install';

export = {
    USER_STATUSES,
    ROLE_KEYS,
    STORED_ROLE_KEYS,
    CREATED_VIA,
    TOKEN_PURPOSES,
    AUDIT_ACTOR_TYPES,
    AUDIT_TARGET_TYPES,
    INSTALL_STATE_ID
};
