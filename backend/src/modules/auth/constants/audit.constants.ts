'use strict';

/**
 * Audit vocabulary: every action the security log records, and the reasons an invite is revoked.
 *
 *  THE ACTION STRINGS ARE A CROSS-REPOSITORY CONTRACT. `frontend` keeps an `AUDIT_ACTION_LABELS`
 * map with exactly these keys (`test/permissionParity.test.js` asserts parity). They are also stored
 * on `gi_audit_events.action`, which is append-only with no retention for actor rows — so a rename
 * leaves old rows under a name nothing labels any more. Add; do not rename.
 *
 * The `details` keys each action records are listed beside it. `details` NEVER carries a token, a
 * hash, a password or a full link. Every role reference stores a `{ key, label }` snapshot, because
 * a custom role can be renamed or deleted after the fact.
 *
 * DEPENDENCY-FREE.
 */

const AUDIT_ACTIONS = Object.freeze({
    /** ANONYMOUS. `{ allowed }` — whether the address may claim setup. */
    SETUP_REQUESTED: 'SETUP_REQUESTED',
    SETUP_COMPLETED: 'SETUP_COMPLETED',
    /** SYSTEM. Boot inserted the owner a crashed setup had claimed but not written. */
    SETUP_RECONCILED: 'SETUP_RECONCILED',
    /** SYSTEM. `{ count }` */
    LEGACY_OPERATORS_MARKED: 'LEGACY_OPERATORS_MARKED',
    LOGIN_SUCCEEDED: 'LOGIN_SUCCEEDED',
    /** `{ reason }` — the attempted email only; never the password. */
    LOGIN_FAILED: 'LOGIN_FAILED',
    LOGOUT: 'LOGOUT',
    /** ANONYMOUS. */
    PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
    /** `{ email_status }` */
    PASSWORD_RESET_SENT_BY_ADMIN: 'PASSWORD_RESET_SENT_BY_ADMIN',
    PASSWORD_RESET_COMPLETED: 'PASSWORD_RESET_COMPLETED',
    PASSWORD_CHANGED: 'PASSWORD_CHANGED',
    /** `{ count }` */
    SESSIONS_SELF_REVOKED: 'SESSIONS_SELF_REVOKED',
    ACCOUNT_NAME_CHANGED: 'ACCOUNT_NAME_CHANGED',
    /** `{ role_key, role_label, email_status }` */
    INVITE_CREATED: 'INVITE_CREATED',
    /** `{ email_status }` */
    INVITE_RESENT: 'INVITE_RESENT',
    /** `{ reason }` — one of `INVITE_REVOKE_REASONS`. */
    INVITE_REVOKED: 'INVITE_REVOKED',
    INVITE_ACCEPTED: 'INVITE_ACCEPTED',
    /** `{ from: { key, label }, to: { key, label } }` */
    USER_ROLE_CHANGED: 'USER_ROLE_CHANGED',
    USER_DISABLED: 'USER_DISABLED',
    USER_ENABLED: 'USER_ENABLED',
    /** `{ count }` */
    USER_SESSIONS_REVOKED: 'USER_SESSIONS_REVOKED',
    /** `{ name, permissions }` */
    ROLE_CREATED: 'ROLE_CREATED',
    /** `{ name, added, removed }` */
    ROLE_UPDATED: 'ROLE_UPDATED',
    /** `{ name }` */
    ROLE_DELETED: 'ROLE_DELETED',
    /** CLI. `{ from, to }` */
    OWNERSHIP_TRANSFERRED: 'OWNERSHIP_TRANSFERRED',
    /** CLI. */
    OWNER_REPAIRED: 'OWNER_REPAIRED',
    CLI_SETUP_LINK_ISSUED: 'CLI_SETUP_LINK_ISSUED',
    CLI_RESET_LINK_ISSUED: 'CLI_RESET_LINK_ISSUED',
    /** `{ count }` */
    CLI_SESSIONS_REVOKED: 'CLI_SESSIONS_REVOKED',
    CLI_USER_ENABLED: 'CLI_USER_ENABLED'
} as const);

/** Why an invite was revoked. Stored on `gi_invites.revoked_reason` and in the INVITE_REVOKED details. */
const INVITE_REVOKE_REASONS = Object.freeze({
    /** An admin pressed Revoke. */
    MANUAL: 'MANUAL',
    /** The inviter was disabled; their outstanding invites die with their access. */
    INVITER_DISABLED: 'INVITER_DISABLED',
    /** The inviter's role changed (or ownership moved) and the management rule no longer allows the invite's role. */
    INVITER_NO_LONGER_PERMITTED: 'INVITER_NO_LONGER_PERMITTED',
    /** The custom role the invite named was deleted. */
    ROLE_DELETED: 'ROLE_DELETED',
    /** Another invite for the same address was accepted. */
    SUPERSEDED: 'SUPERSEDED'
} as const);

/** ANONYMOUS rows carry `expires_at = now + this` (TTL `ttl_audit_anonymous`); every other row is kept. */
const AUDIT_ANONYMOUS_RETENTION_DAYS = 180;

/** `GET /api/audit-events?limit=` — default and clamp bounds. */
const AUDIT_LIST_DEFAULT_LIMIT = 50;
const AUDIT_LIST_MAX_LIMIT = 200;

export = {
    AUDIT_ACTIONS,
    INVITE_REVOKE_REASONS,
    AUDIT_ANONYMOUS_RETENTION_DAYS,
    AUDIT_LIST_DEFAULT_LIMIT,
    AUDIT_LIST_MAX_LIMIT
};
