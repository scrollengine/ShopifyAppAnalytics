'use strict';

/**
 * ============================================================================
 *  AUTH — module barrel
 * ============================================================================
 *
 *  Multi-user sign-in, first-run setup, invitations, roles and the security
 *  log. Everything outside `src/modules/auth/` imports from here: the guard and
 *  the permission middleware, the controllers, the boot sequence and the
 *  recovery CLI.
 *
 *  Barrel rules — deep-path imports inside the folder, every key enumerated,
 *  `export =` never `export default` — are stated once in IMPLEMENTATION.md
 *  §3.13 and asserted by test/exportSurface.test.js.
 *
 *  ⚠️ Call through the barrel OBJECT at request time (`authModule.loadPrincipal(...)`),
 *  never a destructure at load: the permission-map tests stub these keys by
 *  assignment, and a destructured copy would keep calling the real one.
 *
 *  Service contract: every service takes `(identity, params)` and RESOLVES
 *  `{ status, data, error, msg }`, never rejects. A refusal carries
 *  `error.code`; map it to HTTP with `AUTH_ERROR_HTTP_STATUS` (one table).
 *  `params` carries `request_ip` (= `clientIp(req)`) and `user_agent`
 *  (= `req.headers['user-agent']`) where the flow records them.
 *  Exceptions: `ensureInstallState` and `ensureAuthIndexes` THROW on failure
 *  (boot must stop).
 *
 *  Not exported, deliberately: the repositories, the bcrypt wrapper, the token
 *  issuer and link builder (a caller holding them could mint a link past every
 *  check), the deferred halves of the anonymous flows, and the internal
 *  helpers other auth services share.
 * ============================================================================
 */

import authConstants = require('./constants/auth.constants');
import permissionsConstants = require('./constants/permissions.constants');
import rolesConstants = require('./constants/roles.constants');
import auditConstants = require('./constants/audit.constants');
import identityHelper = require('./helpers/identity.helper');
import roleHelper = require('./helpers/role.helper');
import tokenHelper = require('./helpers/token.helper');
import installStateService = require('./services/installState.service');
import setupService = require('./services/setup.service');
import sessionService = require('./services/session.service');
import principalService = require('./services/principal.service');
import passwordService = require('./services/password.service');
import inviteService = require('./services/invite.service');
import userService = require('./services/user.service');
import roleService = require('./services/role.service');
import accountService = require('./services/account.service');
import auditService = require('./services/audit.service');
import recoveryService = require('./services/recovery.service');
import loginDeviceService = require('./services/loginDevice.service');

export = {
    // ── Boot (spec §11 / A8) ────────────────────────────────────────────────
    /** FATAL: creates the install document (OPEN only when gi_users is empty). Throws on failure. */
    ensureInstallState: installStateService.ensureInstallState,
    /** FATAL: builds the auth indexes (the unique gates) and records indexes_ready. Throws on failure. */
    ensureAuthIndexes: installStateService.ensureAuthIndexes,
    /** Stamps legacy_at on single-operator accounts. Non-fatal, idempotent. */
    markLegacyOperators: installStateService.markLegacyOperators,
    /** Rolls a crashed setup forward from the token claim. Non-fatal, idempotent. */
    reconcileSetup: installStateService.reconcileSetup,
    /** Logs who may claim setup; WARNs when it is open to anyone. Non-fatal. */
    logSetupState: installStateService.logSetupState,

    // ── Public flows (no identity) ──────────────────────────────────────────
    /** GET /api/auth/setup — setup_complete, and while incomplete: mail state, restricted, public_url. */
    getSetupStatus: installStateService.getSetupStatus,
    /** POST /api/auth/setup — ALWAYS the same 202 for a well-formed request; the work is deferred. */
    requestSetup: setupService.requestSetup,
    /** POST /api/auth/setup/inspect — `{ email, name, expires_at }` for a live link. Consumes nothing. */
    inspectSetupToken: setupService.inspectSetupToken,
    /** POST /api/auth/setup/complete — claim, lock, create the owner. 201; never signs in. */
    completeSetup: setupService.completeSetup,
    /** POST /api/auth/login — `{ token, expires_in_seconds, expires_at, user_id, email }`; one message for every failure. */
    login: sessionService.login,
    /** POST /api/auth/password/forgot — ALWAYS the same 202 for a well-formed address; the work is deferred. */
    requestPasswordReset: passwordService.requestPasswordReset,
    /** POST /api/auth/password/reset — sets the password, ends every session. Never signs in. */
    resetPassword: passwordService.resetPassword,
    /** POST /api/auth/invites/inspect — `{ email, role_label, invited_by_name, expires_at }`. */
    inspectInvite: inviteService.inspectInvite,
    /** POST /api/auth/invites/accept — creates the account. 201; never signs in. */
    acceptInvite: inviteService.acceptInvite,

    // ── The guard (spec §8 / A9) ────────────────────────────────────────────
    /** Signature, alg, aud, exp; `sub` and `sid` 24-hex → `{ user_id, session_id, expires_at }`. 401 otherwise. */
    verifySessionToken: sessionService.verifySessionToken,
    /** Session → user → epoch → install → role → `{ principal, session }`. error.code: SESSION_FAILURE_REASONS. */
    loadPrincipal: principalService.loadPrincipal,
    /** The same without a session → `{ principal }`. */
    loadPrincipalByUserId: principalService.loadPrincipalByUserId,

    // ── Self-service (@self) ────────────────────────────────────────────────
    /** GET /api/account — `{ user, role, permissions, session }`. */
    getAccount: accountService.getAccount,
    /** PATCH /api/account — `{ user }`. */
    updateAccountName: accountService.updateAccountName,
    /** POST /api/account/password — returns a FRESH token (the old one is dead). */
    changePassword: passwordService.changePassword,
    /** POST /api/account/sessions/revoke-others — returns a FRESH token and `revoked`. */
    revokeOtherSessions: sessionService.revokeOtherSessions,
    /** POST /api/account/logout — revokes the current session only. */
    logout: sessionService.logout,

    // ── Administration (actor re-loaded from the database; management rule) ─
    /** GET /api/users (users:read) — `{ items, mail }`. */
    listUsers: userService.listUsers,
    /** PATCH /api/users/:user_id/role (users:manage) — `{ user, invites_revoked }`. */
    changeUserRole: userService.changeUserRole,
    /** POST /api/users/:user_id/disable (users:manage). */
    disableUser: userService.disableUser,
    /** POST /api/users/:user_id/enable (users:manage). */
    enableUser: userService.enableUser,
    /** POST /api/users/:user_id/sessions/revoke (users:manage) — `{ revoked }`. */
    revokeUserSessions: userService.revokeUserSessions,
    /** POST /api/users/:user_id/password-reset (users:manage) — `{ email_sent, email_status }`. */
    adminSendPasswordReset: passwordService.adminSendPasswordReset,
    /** POST /api/invites (users:manage) — 201 `{ invite, email_sent, email_status, link_host_is_loopback }`. */
    createInvite: inviteService.createInvite,
    /** POST /api/invites/:invite_id/resend (users:manage). */
    resendInvite: inviteService.resendInvite,
    /** POST /api/invites/:invite_id/revoke (users:manage). */
    revokeInvite: inviteService.revokeInvite,
    /** GET /api/invites (users:read) — `{ items, mail }`. */
    listInvites: inviteService.listInvites,
    /** GET /api/roles (users:read) — `{ catalogue, roles }`. */
    listRoles: roleService.listRoles,
    /** POST /api/roles (roles:manage) — 201 `{ role }`. */
    createRole: roleService.createRole,
    /** PATCH /api/roles/:role_id (roles:manage) — `{ role, invites_revoked }`. */
    updateRole: roleService.updateRole,
    /** DELETE /api/roles/:role_id (roles:manage) — `{ deleted, role_id, invites_revoked }`. */
    deleteRole: roleService.deleteRole,
    /** GET /api/audit-events (audit:read) — `{ items, next_before }`. */
    listAuditEvents: auditService.listAuditEvents,
    /** Appends a security-log row. Best-effort: never throws, never fails the caller. */
    recordAuditEvent: auditService.recordAuditEvent,

    // ── Recovery CLI (src/scripts/authAdmin.ts) ─────────────────────────────
    /** `status`: setup mode, legacy emails, owner, user counts, mail. */
    recoveryStatus: recoveryService.recoveryStatus,
    /** `setup-link --email --name`: prints a setup link (pin > legacy > open). */
    issueSetupLinkForCli: recoveryService.issueSetupLinkForCli,
    /** `reset-link --email`: prints a 15-minute reset link. */
    issueResetLinkForCli: recoveryService.issueResetLinkForCli,
    /** `revoke-sessions --email | --all`. */
    revokeSessionsForCli: recoveryService.revokeSessionsForCli,
    /** `enable --email`. */
    enableUserForCli: recoveryService.enableUserForCli,
    /** `transfer-owner --email`: CAS on the owner pointer. */
    transferOwnershipForCli: recoveryService.transferOwnershipForCli,
    /** `repair-owner --email --name`: recreates a missing owner and prints a reset link. */
    repairOwnerForCli: recoveryService.repairOwnerForCli,

    // ── Vocabulary other layers need ────────────────────────────────────────
    /** What this module may say. Both guard messages start with "Not authenticated." */
    AUTH_MESSAGES: authConstants.AUTH_MESSAGES,
    /** Every `error.code` a service returns. */
    AUTH_ERROR_CODES: authConstants.AUTH_ERROR_CODES,
    /** THE code → HTTP status table (includes the loadPrincipal reasons). */
    AUTH_ERROR_HTTP_STATUS: authConstants.AUTH_ERROR_HTTP_STATUS,
    /** Why loadPrincipal refused: all 401 except DATASTORE_ERROR (503). */
    SESSION_FAILURE_REASONS: authConstants.SESSION_FAILURE_REASONS,
    /** The permission keys (`PERMISSIONS.MERCHANTS_READ` …) routes declare. */
    PERMISSIONS: permissionsConstants.PERMISSIONS,
    /** The ordered catalogue `{ key, label, group, description, requires }`. */
    PERMISSION_CATALOGUE: permissionsConstants.PERMISSION_CATALOGUE,
    /** Every catalogue key, in catalogue order. */
    ALL_PERMISSION_KEYS: permissionsConstants.ALL_PERMISSION_KEYS,
    /** The built-in roles (owner, admin, analyst, viewer). */
    BUILT_IN_ROLES: rolesConstants.BUILT_IN_ROLES,
    /** Every audited action (cross-repo contract with the frontend labels). */
    AUDIT_ACTIONS: auditConstants.AUDIT_ACTIONS,
    /** Whether a value is a catalogue key — `requirePermission(key)` refuses anything else at construction. */
    isPermissionKey: roleHelper.isPermissionKey,
    /** Whether a value is a canonical 24-hex ObjectId string (the guard's `sub` / `sid` check). */
    isObjectIdString: identityHelper.isObjectIdString,
    /** Whether a request value has the exact link-token shape (43 base64url chars). */
    isWellFormedToken: tokenHelper.isWellFormedToken,
    /** sha256 hex of a link token — the token-flow rate limiter keys on it (never on the raw token). */
    hashToken: tokenHelper.hashToken,
    /** The device id a sign-in's `device_token` proves for its email, or null — the login limiter's own-budget key. */
    verifyLoginDeviceToken: loginDeviceService.verifyLoginDeviceToken
};
