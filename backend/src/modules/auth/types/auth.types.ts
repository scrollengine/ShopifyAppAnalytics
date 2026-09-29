/**
 * Shapes the auth module hands around: the principal, the API views, the service parameters, and
 * the inputs/outputs of the pure helpers and the repositories.
 *
 * Declarations only — no runtime imports. The `typeof import(...)` references are type queries,
 * erased at compile time, so importing this file loads nothing. The unions below are DERIVED from
 * the frozen constant objects rather than re-typed, so adding a value to a constant is the only
 * edit a new code/reason/action ever needs.
 *
 * ⚠️ Request-body fields are typed `unknown` on purpose. They arrive off the wire, and every one is
 * checked `typeof === 'string'` (or `Array.isArray`) before any normalisation or query (spec A2).
 * Typing them `string` would describe what a well-behaved client sends, not what the check has to
 * receive — and would make the check look like dead code, which is how checks get deleted.
 */

import type { ObjectIdLike } from '../../shared/types/entity.types';

type AuthConstantsModule = typeof import('../constants/auth.constants');
type PermissionsConstantsModule = typeof import('../constants/permissions.constants');
type AuditConstantsModule = typeof import('../constants/audit.constants');

type ValueOf<T> = T[keyof T];

// ── Vocabulary unions (derived) ─────────────────────────────────────────────

/** Every role key a principal can resolve to, `owner` included. */
export type RoleKey = ValueOf<AuthConstantsModule['ROLE_KEYS']>;
/** What `gi_users.role_key` / `gi_invites.role_key` may hold — never `owner`. */
export type StoredRoleKey = AuthConstantsModule['STORED_ROLE_KEYS'][number];
export type UserStatus = ValueOf<AuthConstantsModule['USER_STATUSES']>;
export type CreatedVia = ValueOf<AuthConstantsModule['CREATED_VIA']>;
export type TokenPurpose = ValueOf<AuthConstantsModule['TOKEN_PURPOSES']>;
export type AuditActorType = ValueOf<AuthConstantsModule['AUDIT_ACTOR_TYPES']>;
export type AuditTargetType = ValueOf<AuthConstantsModule['AUDIT_TARGET_TYPES']>;
export type PermissionKey = ValueOf<PermissionsConstantsModule['PERMISSIONS']>;
export type AuthErrorCode = ValueOf<AuthConstantsModule['AUTH_ERROR_CODES']>;
/** Why `loadPrincipal` refused. All ⇒ 401 except `DATASTORE_ERROR` ⇒ 503. */
export type SessionFailureReason = ValueOf<AuthConstantsModule['SESSION_FAILURE_REASONS']>;
export type SessionRevokeReason = ValueOf<AuthConstantsModule['SESSION_REVOKE_REASONS']>;
export type PasswordPolicyCode = ValueOf<AuthConstantsModule['PASSWORD_POLICY_CODES']>;
export type ManagementBlockReason = ValueOf<AuthConstantsModule['MANAGEMENT_BLOCK_REASONS']>;
export type AuditAction = ValueOf<AuditConstantsModule['AUDIT_ACTIONS']>;
export type InviteRevokeReason = ValueOf<AuditConstantsModule['INVITE_REVOKE_REASONS']>;
/** Computed ONCE, by `invite.helper#inviteState`. Never stored. */
export type InviteState = 'pending' | 'expired' | 'accepted' | 'revoked';

// ── Catalogue and built-in roles ────────────────────────────────────────────

/** One `PERMISSION_CATALOGUE` entry. `requires` lists DIRECT prerequisites only. */
export interface PermissionCatalogueEntry {
    readonly key: string;
    readonly label: string;
    readonly group: string;
    readonly description: string;
    readonly requires: readonly string[];
}

/** One `BUILT_IN_ROLES` entry. */
export interface BuiltInRoleDefinition {
    readonly key: RoleKey;
    readonly label: string;
    readonly description: string;
    readonly permissions: readonly string[];
    /** Whether an invite or a role change may name it at all (`owner` never). */
    readonly assignable: boolean;
}

// ── The principal ───────────────────────────────────────────────────────────

/**
 * Who is making this request and what they may do. Built ONLY by
 * `principal.helper#resolvePrincipal`, from a fresh read of the user, the install document and the
 * custom role — never from a JWT and never from anything a controller hands a service.
 */
export interface Principal {
    user_id: string;
    email: string;
    name: string;
    /** `String(user._id) === String(install.owner_user_id)` — the pointer is the only definition. */
    is_owner: boolean;
    role_key: RoleKey;
    /** Built-in label, the custom role's name, or a fixed label for a missing/unknown role. */
    role_label: string;
    /** Set only when `role_key === 'custom'` (and never for the owner). */
    custom_role_id: string | null;
    /** Sorted, deduplicated, frozen. Catalogue keys only; never an owner-only key unless `is_owner`. */
    permissions: readonly string[];
}

/** What `authenticate` puts on `req.auth` (frozen). */
export type AuthContext = Principal & { session_id: string };

/**
 * What resolving a stored role found wrong, for the service to LOG. The principal itself is already
 * narrowed (unknown keys dropped, missing role ⇒ no permissions); this only says why.
 */
export interface RoleAnomalies {
    /** The stored `role_key` when it is not one of `STORED_ROLE_KEYS`, else `null`. */
    unknown_role_key: string | null;
    /** `role_key === 'custom'` but the role row is absent or does not match `custom_role_id`. */
    missing_custom_role: boolean;
    /** Stored keys that were not honoured: unknown, owner-only, or with an unmet prerequisite. */
    dropped_permissions: string[];
}

/** The role half of a principal, resolved from a stored `(role_key, custom_role_id)` pair. */
export interface RoleResolution {
    role_key: RoleKey;
    role_label: string;
    custom_role_id: string | null;
    permissions: readonly string[];
    anomalies: RoleAnomalies;
}

/** The user fields `resolvePrincipal` reads. Structural, so a `UserDoc` or a test literal both fit. */
export interface PrincipalUserInput {
    _id: ObjectIdLike;
    email: string;
    name: string;
    role_key: string;
    custom_role_id?: ObjectIdLike | null;
}

/** The install fields `resolvePrincipal` reads. A missing install document is passed as `null`. */
export interface PrincipalInstallInput {
    owner_user_id?: ObjectIdLike | null;
}

/** The custom-role fields `resolvePrincipal` reads. */
export interface CustomRoleInput {
    _id: ObjectIdLike;
    name: string;
    permissions?: unknown;
}

export interface ResolvePrincipalInput {
    user: PrincipalUserInput;
    install: PrincipalInstallInput | null;
    /** The `gi_roles` row for `user.custom_role_id`, or `null` (not custom, or not found). */
    custom_role: CustomRoleInput | null;
}

export interface ResolveStoredRoleInput {
    role_key: string;
    custom_role_id?: ObjectIdLike | null;
    custom_role: CustomRoleInput | null;
}

// ── Management rule ─────────────────────────────────────────────────────────

export interface ManagementInput {
    /** Re-loaded from the DB by the service — never a principal handed in by a controller. */
    actor: Principal;
    target_is_owner: boolean;
    /** The target user's id; `null` when the target is an invite. */
    target_user_id: string | null;
    /** The target's current permissions (for an invite: the invite role's permissions). */
    target_permissions: readonly string[];
    /** The role being assigned or invited, when the action assigns one. */
    new_permissions?: readonly string[] | null;
}

export interface ManagementDecision {
    allowed: boolean;
    /** `null` exactly when `allowed`. */
    reason: ManagementBlockReason | null;
}

/** A role the actor may hand out, as `assignableRolesFor` lists it. */
export interface AssignableRole {
    role_key: StoredRoleKey;
    /** The `gi_roles._id` for a custom role; `null` for a built-in. */
    role_id: string | null;
    label: string;
    permissions: readonly string[];
}

// ── Pure-helper results ─────────────────────────────────────────────────────

/** An input check. `reason` is a sentence safe to show the caller. */
export type ValidationResult<T> =
    | { ok: true; value: T; reason: null }
    | { ok: false; value: null; reason: string };

/** A role an invite or a role change names, after `role.helper#validateRoleAssignment`. */
export interface RoleAssignment {
    /** `admin` / `analyst` / `viewer` / `custom` — never `owner`. */
    role_key: StoredRoleKey;
    /** The 24-hex custom role id iff `role_key === 'custom'`, else `null` (stored as null — spec A2). */
    custom_role_id: string | null;
}

/**
 * `code` says which status the refusal maps to: `VALIDATION` ⇒ 400 (wrong type, unknown role key,
 * `custom_role_id` present for a built-in or absent for `custom`); `NOT_FOUND` ⇒ 404 (a
 * `custom_role_id` string that is not a 24-hex id — spec A2: a malformed id is a 404, never a
 * CastError 500). Whether a well-formed custom role id EXISTS is the service's read.
 */
export type RoleAssignmentValidation =
    | { ok: true; value: RoleAssignment; code: null; reason: null }
    | { ok: false; value: null; code: 'VALIDATION' | 'NOT_FOUND'; reason: string };

export interface ValidRoleName {
    /** Trimmed, as typed. */
    name: string;
    /** NFC + trim + lowercase — the uniqueness key. */
    name_norm: string;
}

export interface PasswordPolicyInput {
    /** Raw from the request body. NFC-normalised inside the check. */
    password: unknown;
    /** The account's (or invitee's) email, for the local-part containment rule. */
    email?: string | null;
    /** The account's display name, for the name rule. */
    name?: string | null;
    /**
     * Optional `bcrypt.truncates`, checked in addition to the helper's own UTF-8 byte count (which
     * enforces the 72-byte rule on its own). Injected, so the helper has no bcrypt dependency.
     */
    truncates?: ((password: string) => boolean) | null;
}

export type PasswordPolicyResult =
    | { ok: true; code: null; reason: null }
    | { ok: false; code: PasswordPolicyCode; reason: string };

/** The body of `POST /api/roles` / `PATCH /api/roles/:role_id`, unchecked. */
export interface CustomRoleBody {
    name: unknown;
    description: unknown;
    permissions: unknown;
}

export interface ValidCustomRole {
    name: string;
    name_norm: string;
    description: string;
    /** Deduplicated, sorted, closed under `requires`, `apps:read` present, no owner-only key. */
    permissions: string[];
}

export type CustomRoleValidation =
    | { ok: true; value: ValidCustomRole; reason: null; field: null; keys: string[] }
    | {
        ok: false;
        value: null;
        reason: string;
        field: 'name' | 'description' | 'permissions';
        /** The offending keys: unknown, owner-only, or missing prerequisites (empty when not about keys). */
        keys: string[];
    };

export interface InviteStateInput {
    invite: {
        accepted_at?: Date | null;
        revoked_at?: Date | null;
        expires_at?: Date | null;
    };
    now: Date;
}

/** The decoded `next_before` cursor: `'<iso>|<objectId>'`. */
export interface AuditCursor {
    created_at: Date;
    id: string;
}

export type AuditCursorDecode =
    | { ok: true; cursor: AuditCursor | null }
    | { ok: false; cursor: null };

export interface SanitisedAuditEmail {
    /** The normalised address when it passes `validateEmail`, else `null`. */
    email: string | null;
    /** True when something was supplied but refused — recorded as `details.invalid_email: true`. */
    invalid: boolean;
}

// ── API views ───────────────────────────────────────────────────────────────

export interface UserView {
    user_id: string;
    email: string;
    name: string;
    status: UserStatus;
    is_owner: boolean;
    /** From `resolvePrincipal` — the owner reads `'owner'` / `'Owner'`. */
    role_key: RoleKey;
    role_label: string;
    custom_role_id: string | null;
    last_login_at: Date | null;
    created_at: Date | null;
    /** The management rule, evaluated for the REQUESTING actor. */
    can_manage: boolean;
    manage_block_reason: ManagementBlockReason | null;
}

export interface InviteView {
    invite_id: string;
    email: string;
    role_key: StoredRoleKey;
    /** Built-in label or the custom role's current name. */
    role_label: string;
    custom_role_id: string | null;
    state: InviteState;
    invited_by_user_id: string;
    invited_by_name: string | null;
    expires_at: Date;
    created_at: Date | null;
    last_sent_at: Date | null;
    send_count: number;
    accepted_at: Date | null;
    revoked_at: Date | null;
    revoked_reason: InviteRevokeReason | string | null;
    can_manage: boolean;
    manage_block_reason: ManagementBlockReason | null;
}

export interface RoleView {
    role_key: RoleKey;
    /** `gi_roles._id` for a custom role; `null` for a built-in. */
    role_id: string | null;
    label: string;
    description: string;
    permissions: readonly string[];
    built_in: boolean;
    /** Assignable BY THE REQUESTING ACTOR under the management rule. */
    assignable: boolean;
    assigned_user_count: { active: number; disabled: number };
    pending_invite_count: number;
}

export interface AccountView {
    user: {
        user_id: string;
        email: string;
        name: string;
        created_at: Date | null;
        last_login_at: Date | null;
    };
    role: { key: RoleKey; label: string; is_owner: boolean };
    permissions: readonly string[];
    session: { session_id: string; expires_at: Date | null };
}

export interface AuditEventView {
    event_id: string;
    created_at: Date | null;
    actor_type: string;
    actor_user_id: string | null;
    actor_email: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    target_email: string | null;
    ip: string | null;
    details: Record<string, unknown>;
}

export interface AuditEventList {
    items: AuditEventView[];
    /** `'<iso>|<objectId>'` of the last item when a further page may exist, else `null`. */
    next_before: string | null;
}

// ── Session tokens ──────────────────────────────────────────────────────────

/** The JWT payload. Deliberately tiny: ids only, no email, no role, no permissions. */
export interface SessionTokenClaims {
    /** The `gi_users._id`. */
    sub: string;
    /** The `gi_auth_sessions._id`. */
    sid: string;
    aud: string;
    iat?: number;
    exp?: number;
}

/** What `verifySessionToken` resolves with on success. */
export interface VerifiedSessionToken {
    user_id: string;
    session_id: string;
    expires_at: Date | null;
}

/** A freshly minted session token (login; and change-password / revoke-others per A4). */
export interface FreshSessionToken {
    token: string;
    expires_at: Date;
    expires_in_seconds: number;
}

/** `POST /api/auth/login` success body — same shape as the single-operator build. */
export interface LoginResult extends FreshSessionToken {
    user_id: string;
    email: string;
    /** Gives this browser its own sign-in budget next time (`services/loginDevice.service`). Not a credential. */
    device_token: string | null;
}

// ── Service parameters (request fields are `unknown` — see the header) ──────

/**
 * Request context every flow records. From `utils/clientAddress#clientIp` and
 * `req.headers['user-agent']`. `request_ip` is the canonical key; `ip` is read when it is absent
 * (`requestContext.helper#requestContextOf`). Both are re-checked there — never trusted as given.
 */
export interface RequestContext {
    request_ip?: string | null;
    ip?: string | null;
    user_agent?: string | null;
}

export interface LoginParams extends RequestContext {
    email: unknown;
    password: unknown;
}

export interface SetupRequestParams extends RequestContext {
    email: unknown;
    name: unknown;
}

export interface TokenParams extends RequestContext {
    token: unknown;
}

export interface SetupCompleteParams extends RequestContext {
    token: unknown;
    name: unknown;
    password: unknown;
}

export interface SetupStatus {
    setup_complete: boolean;
    /** Present only while setup is incomplete. */
    mail_configured?: boolean;
    mail_last_check?: 'ok' | 'failed' | 'not_checked';
    setup_restricted?: boolean;
    public_url?: string;
}

export interface InviteCreateParams extends RequestContext {
    email: unknown;
    role_key: unknown;
    custom_role_id?: unknown;
}

export interface InviteIdParams extends RequestContext {
    invite_id: unknown;
}

export interface AcceptInviteParams extends RequestContext {
    token: unknown;
    name: unknown;
    password: unknown;
}

export interface ForgotPasswordParams extends RequestContext {
    email: unknown;
}

export interface ResetPasswordParams extends RequestContext {
    token: unknown;
    password: unknown;
}

export interface ChangePasswordParams extends RequestContext {
    current_password: unknown;
    new_password: unknown;
    /** The caller's current session (`req.auth.session_id`) — replaced by a fresh one; every other session ends. */
    session_id?: unknown;
}

/** `verifySessionToken` — the raw bearer token, `Bearer ` already stripped. */
export interface VerifySessionTokenParams {
    token: unknown;
}

/** `loadPrincipal` — the ids a verified session token carries. */
export interface LoadPrincipalParams {
    user_id: unknown;
    session_id: unknown;
}

/** `loadPrincipalByUserId` — no session: the actor re-load inside admin services, and the inviter check. */
export interface LoadPrincipalByUserIdParams {
    user_id: unknown;
}

/** What `loadPrincipal` resolves with. The guard freezes `principal` + `session_id` onto `req.auth`. */
export interface LoadedPrincipal {
    principal: Principal;
    session: { session_id: string; expires_at: Date | null };
}

/** Self-service calls that act on the caller's own session (logout, revoke-others, account). */
export interface SessionParams extends RequestContext {
    /** `req.auth.session_id`. */
    session_id?: unknown;
}

/** A fresh session (change-password, revoke-others — spec A4) and how many OTHER sessions ended. */
export interface FreshSessionWithCount extends FreshSessionToken {
    revoked: number;
}

/** Which setup rule applies, and whether one address passes it (spec A7). */
export interface SetupEligibility {
    rule: 'PIN' | 'LEGACY' | 'OPEN';
    allowed: boolean;
    /** The addresses the rule permits: the pin, or the legacy emails; empty for OPEN. Shell-only detail — never sent to a browser. */
    permitted_emails: string[];
}

/** POST /api/invites and resend. */
export interface InviteMutationResult {
    invite: InviteView;
    /** True only when the mail server ACCEPTED the message. */
    email_sent: boolean;
    /** SENT | FAILED | CAP_REACHED | UNCONFIRMED | NOT_CONFIGURED. */
    email_status: string;
    /** APP_PUBLIC_URL is loopback: the link opens only on the server's own machine. */
    link_host_is_loopback: boolean;
}

/** POST /api/users/:user_id/password-reset. */
export interface PasswordResetSentResult {
    email_sent: boolean;
    email_status: string;
}

/** PATCH /api/users/:user_id/role, and PATCH /api/roles/:role_id's re-evaluation count. */
export interface UserRoleChangeResult {
    user: UserView;
    /** Outstanding invites the user had sent that the new role can no longer grant (revoked, spec A13). */
    invites_revoked: number;
}

/** POST /api/users/:user_id/sessions/revoke. */
export interface SessionsRevokedResult {
    revoked: number;
}

export interface RoleMutationResult {
    role: RoleView;
    invites_revoked: number;
}

export interface RoleDeleteResult {
    deleted: true;
    role_id: string;
    invites_revoked: number;
}

/** The body of `recordAuditEvent` (the audit service builds the row from it). */
export interface AuditRecordParams {
    actor_type: AuditActorType;
    actor_user_id?: ObjectIdLike | null;
    /** Recorded only when it passes `validateEmail` (spec A15). */
    actor_email?: unknown;
    action: AuditAction;
    target_type?: AuditTargetType | null;
    target_id?: unknown;
    target_email?: unknown;
    ip?: string | null;
    details?: Record<string, unknown> | null;
    /** Defaults to the current time. */
    now?: Date;
}

// ── Recovery CLI ────────────────────────────────────────────────────────────

export interface CliEmailParams {
    email: unknown;
}

export interface CliSetupLinkParams {
    email: unknown;
    name: unknown;
}

export interface CliRevokeSessionsParams {
    email?: unknown;
    /** `--all`: every session in the install. Exactly one of `email` / `all`. */
    all?: unknown;
}

/** A link the CLI prints. `expires_at` is printed in UTC. */
export interface CliIssuedLink {
    email: string;
    link: string;
    expires_at: Date;
}

export interface RecoveryStatus {
    install: {
        present: boolean;
        setup_complete: boolean;
        setup_completed_at: Date | null;
        owner_user_id: string | null;
        /** The owner pointer is set but no user row has that id. */
        owner_missing: boolean;
        owner_email: string | null;
    };
    /** Null when the rule could not be read (datastore error). */
    setup_rule: 'PIN' | 'LEGACY' | 'OPEN' | null;
    legacy_emails: string[];
    users: { active: number; disabled: number };
    mail: {
        configured: boolean;
        last_check: string;
        last_ok_at: Date | null;
        consecutive_failures: number;
    };
}

export interface UserIdParams extends RequestContext {
    user_id: unknown;
}

export interface ChangeUserRoleParams extends RequestContext {
    user_id: unknown;
    role_key: unknown;
    custom_role_id?: unknown;
}

export interface RoleIdParams extends RequestContext {
    role_id: unknown;
}

export interface CustomRoleParams extends RequestContext, CustomRoleBody {}

export interface UpdateCustomRoleParams extends CustomRoleParams {
    role_id: unknown;
}

export interface AuditListParams {
    limit?: unknown;
    before?: unknown;
}

export interface UpdateAccountParams extends RequestContext {
    name: unknown;
}

// ── Repository inputs ───────────────────────────────────────────────────────

export interface NewUserFields {
    /** Pre-generated by the service (setup: the id the install lock already points at). */
    _id: ObjectIdLike;
    email: string;
    name: string;
    /** ALREADY a bcrypt hash of the NFC-normalised password. Never plaintext. */
    password_hash: string;
    role_key: StoredRoleKey;
    custom_role_id: ObjectIdLike | null;
    email_verified_at: Date;
    password_changed_at: Date;
    invited_by_user_id: ObjectIdLike | null;
    created_via: CreatedVia;
}

export interface NewInviteFields {
    email: string;
    role_key: StoredRoleKey;
    custom_role_id: ObjectIdLike | null;
    /** The creating actor — stored as both `invited_by_user_id` and `created_by_user_id`. */
    invited_by_user_id: ObjectIdLike;
    token_hash: string;
    expires_at: Date;
    /** Recorded as the first send (`last_sent_at`, `send_log`, `send_count: 1`). */
    now: Date;
}

export interface NewAuthTokenFields {
    purpose: TokenPurpose;
    token_hash: string;
    email: string;
    user_id: ObjectIdLike | null;
    name: string | null;
    expires_at: Date;
    request_ip: string | null;
}

export interface NewSessionFields {
    user_id: ObjectIdLike;
    /** `session_epoch` from the SAME user read the credential check used. */
    epoch: number;
    expires_at: Date;
    ip: string | null;
    /** Truncated to `USER_AGENT_MAX_LENGTH` by the repository. */
    user_agent: string | null;
}

export interface NewAuditEventFields {
    actor_type: AuditActorType;
    actor_user_id: ObjectIdLike | null;
    actor_email: string | null;
    action: AuditAction;
    target_type: AuditTargetType | null;
    target_id: string | null;
    target_email: string | null;
    ip: string | null;
    details: Record<string, unknown>;
    /** Set ONLY for ANONYMOUS rows (`audit.helper#auditExpiresAt`). */
    expires_at?: Date;
}

export interface NewRoleFields {
    name: string;
    name_norm: string;
    description: string;
    permissions: string[];
    created_by_user_id: ObjectIdLike;
}

export interface RoleUpdateFields {
    role_id: string;
    name: string;
    name_norm: string;
    description: string;
    permissions: string[];
    updated_by_user_id: ObjectIdLike;
}

/**
 * The stored role a management decision was evaluated against. Passed to the user-row writes so the
 * write's filter re-asserts it: a decision taken against "Viewer" cannot land on someone who became
 * "Admin" in between. `custom_role_id: null` matches null or missing.
 */
export interface ExpectedRole {
    role_key: string;
    custom_role_id: ObjectIdLike | null;
}

/** The throttle a send-log CAS enforces. All durations in ms; `now` passed in (repositories read no clock). */
export interface SendSlotThrottle {
    now: Date;
    /** Refuse when the newest entry is newer than `now - min_interval_ms`. */
    min_interval_ms: number;
    /** Refuse when this many entries already fall inside the window. */
    max_per_window: number;
    window_ms: number;
    /** Entries kept after the push (newest first). Must exceed `max_per_window`. */
    keep: number;
}
