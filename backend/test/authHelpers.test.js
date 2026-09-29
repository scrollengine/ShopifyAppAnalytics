'use strict';

/**
 * ============================================================================
 *  AUTH PURE HELPERS — the rules every service leans on (spec §5, §6, I1, I9, I12, A2)
 * ============================================================================
 *
 *  These functions decide access and validate hostile input, and each is the
 *  ONLY definition of its rule (recurring failure mode #1: two spellings of one
 *  derivation). They are pure, so they are tested here directly and
 *  exhaustively; the services' tests then only have to prove the services
 *  call them.
 *
 *  Nothing in this file touches a database, the config or the clock — `now`
 *  is always passed in, which is the property that makes these helpers
 *  testable at all.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const AUTH_ROOT = path.resolve(__dirname, '..', 'src', 'modules', 'auth');

const passwordHelper = require(path.join(AUTH_ROOT, 'helpers', 'password.helper.ts'));
const tokenHelper = require(path.join(AUTH_ROOT, 'helpers', 'token.helper.ts'));
const principalHelper = require(path.join(AUTH_ROOT, 'helpers', 'principal.helper.ts'));
const managementHelper = require(path.join(AUTH_ROOT, 'helpers', 'management.helper.ts'));
const roleHelper = require(path.join(AUTH_ROOT, 'helpers', 'role.helper.ts'));
const identityHelper = require(path.join(AUTH_ROOT, 'helpers', 'identity.helper.ts'));
const inviteHelper = require(path.join(AUTH_ROOT, 'helpers', 'invite.helper.ts'));
const auditHelper = require(path.join(AUTH_ROOT, 'helpers', 'audit.helper.ts'));
const authConstants = require(path.join(AUTH_ROOT, 'constants', 'auth.constants.ts'));
const permissionsConstants = require(path.join(AUTH_ROOT, 'constants', 'permissions.constants.ts'));
const rolesConstants = require(path.join(AUTH_ROOT, 'constants', 'roles.constants.ts'));
const commonPasswordsConstants = require(path.join(AUTH_ROOT, 'constants', 'commonPasswords.constants.ts'));

const { PASSWORD_POLICY_CODES, MANAGEMENT_BLOCK_REASONS } = authConstants;
const { PERMISSIONS, ALL_PERMISSION_KEYS } = permissionsConstants;
const { BUILT_IN_ROLES } = rolesConstants;

const P = PERMISSIONS;

/** Shorthand: the policy code for a candidate (null when accepted). */
const _policy = (password, context) => passwordHelper.evaluatePasswordPolicy(Object.assign({ password: password }, context || {})).code;

const OWNER_ID = '1'.repeat(24);
const ADMIN_ID = '2'.repeat(24);
const ANALYST_ID = '3'.repeat(24);
const ROLE_ID = '4'.repeat(24);


/* ==========================================================================
 *  Password policy (I9)
 * ========================================================================== */

test('password: at least 15 CODE POINTS, counted after NFC — not UTF-16 units, not bytes', () => {
    assert.equal(_policy('plum tractor ve'), null, '15 characters is the minimum and must pass.');
    assert.equal(_policy('plum tractor v'), PASSWORD_POLICY_CODES.TOO_SHORT);

    // 14 astral-plane characters are 28 UTF-16 units. `.length` would call that long enough.
    const astral = '\u{1F600}\u{1F680}\u{1F30D}\u{1F34E}\u{1F355}\u{1F3B8}\u{1F40D}';
    assert.equal(_policy(astral + astral), PASSWORD_POLICY_CODES.TOO_SHORT, '14 code points must be refused even though .length is 28.');
    assert.equal(_policy(astral + astral + '\u{1F981}'), null, '15 code points (60 bytes) is acceptable.');

    // 14 accented letters typed DECOMPOSED are 28 code points before NFC and 14 after it. The rule
    // counts the normalised form — the form that is hashed.
    const decomposed = 'éàôüíñç'.repeat(2);
    assert.equal(Array.from(decomposed).length, 28);
    assert.equal(_policy(decomposed), PASSWORD_POLICY_CODES.TOO_SHORT);
});

test('password: over 72 UTF-8 bytes is REFUSED (never truncated), and an injected truncates() is a second opinion', () => {
    assert.equal(_policy('a1'.repeat(36)), null, 'Exactly 72 bytes is the maximum and must pass.');
    assert.equal(_policy('a1'.repeat(36) + 'b'), PASSWORD_POLICY_CODES.TOO_LONG);

    // 37 two-byte letters: only 37 code points, but 74 bytes — bcrypt would hash a prefix.
    assert.equal(_policy('éñ'.repeat(18) + 'ü'), PASSWORD_POLICY_CODES.TOO_LONG);

    // A bcrypt that says "I would truncate" refuses even when the byte count says fine.
    assert.equal(_policy('plum tractor velvet', { truncates: () => true }), PASSWORD_POLICY_CODES.TOO_LONG);
    assert.equal(_policy('plum tractor velvet', { truncates: () => false }), null);
});

test('password: NFC is applied before hashing and comparing — two keyboards, one password', () => {
    assert.equal(passwordHelper.normalisePassword('café'), 'café');
    assert.equal(passwordHelper.normalisePassword('café'), 'café');
});

test('password: blocklist — common passwords (any case), email local part, own name, one repeated character', () => {
    const commonLong = commonPasswordsConstants.COMMON_PASSWORDS.find((entry) => /^[a-z0-9]{15,}$/.test(entry) && /[a-z]/.test(entry));
    assert.ok(commonLong, 'The blocklist has no plain alphanumeric entry to test with.');
    assert.equal(_policy(commonLong), PASSWORD_POLICY_CODES.COMMON_PASSWORD);
    assert.equal(_policy(commonLong.toUpperCase()), PASSWORD_POLICY_CODES.COMMON_PASSWORD, 'The blocklist is case-insensitive.');
    assert.equal(_policy('123456789012345'), PASSWORD_POLICY_CODES.COMMON_PASSWORD);

    assert.equal(_policy('aaaaaaaaaaaaaaaa'), PASSWORD_POLICY_CODES.REPEATED_CHARACTER);
    assert.equal(_policy('\u{1F600}'.repeat(16)), PASSWORD_POLICY_CODES.REPEATED_CHARACTER);

    assert.equal(
        _policy('my Jordan.Smith passphrase', { email: 'jordan.smith@example.com' }),
        PASSWORD_POLICY_CODES.CONTAINS_EMAIL,
        'A password containing the address\'s local part is refused, case-insensitively.'
    );
    // A local part shorter than the minimum is not treated as identifying (every password contains "a").
    assert.equal(_policy('a perfectly fine long phrase', { email: 'al@example.com' }), null);

    assert.equal(_policy('Jordan Smith-Example!', { name: 'jordan smith example' }), PASSWORD_POLICY_CODES.MATCHES_NAME);
    assert.equal(_policy('Jordan Smith is my teammate', { name: 'Jordan Smith' }), null, 'Containing the name is allowed; being the name is not.');
});

test('password: no composition rules, and a non-string is refused before anything else', () => {
    assert.equal(_policy('plum tractor velvet ocean'), null, 'Lowercase letters and spaces only is a fine passphrase.');
    assert.equal(_policy('ploughshares and sundials'), null);
    for (const hostile of [undefined, null, 123456789012345, ['plum tractor velvet'], { password: 'x' }, '']) {
        assert.equal(_policy(hostile), PASSWORD_POLICY_CODES.NOT_A_STRING, `${JSON.stringify(hostile)} must be refused as not-a-string.`);
    }
    const refusal = passwordHelper.evaluatePasswordPolicy({ password: 'short' });
    assert.equal(refusal.ok, false);
    assert.equal(typeof refusal.reason, 'string', 'Every refusal carries a sentence the page can show.');
});


/* ==========================================================================
 *  Link tokens (I1, A3, A14)
 * ========================================================================== */

test('token: exactly 43 base64url characters, a string, nothing else', () => {
    const real = crypto.randomBytes(32).toString('base64url');
    assert.equal(real.length, 43, 'A 256-bit token in base64url is 43 characters.');
    assert.equal(tokenHelper.isWellFormedToken(real), true);
    assert.equal(tokenHelper.isWellFormedToken('A'.repeat(43)), true);
    assert.equal(tokenHelper.isWellFormedToken('-_'.repeat(21) + 'z'), true);

    for (const bad of ['A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42) + '+', 'A'.repeat(42) + '/', 'A'.repeat(42) + '=',
        'A'.repeat(43) + '\n', ' ' + 'A'.repeat(42), '', undefined, null, 43, ['A'.repeat(43)], { $gt: '' }]) {
        assert.equal(tokenHelper.isWellFormedToken(bad), false, `${JSON.stringify(bad)} must not pass as a token.`);
    }
});

test('token: stored only as sha256 hex; compared in constant time; stripped before a service sees it', () => {
    assert.equal(tokenHelper.hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = tokenHelper.hashToken(token);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(tokenHelper.isTokenHash(hash), true);
    assert.equal(tokenHelper.isTokenHash(hash.toUpperCase()), false);

    assert.equal(tokenHelper.tokenHashesEqual(hash, hash), true);
    assert.equal(tokenHelper.tokenHashesEqual(hash, tokenHelper.hashToken(token + 'x')), false);
    assert.equal(tokenHelper.tokenHashesEqual(undefined, hash), false, 'A row read WITHOUT +token_hash must never match.');
    assert.equal(tokenHelper.tokenHashesEqual('', ''), false);

    const row = { _id: 'r1', token_hash: hash, email: 'a@example.com' };
    const kept = tokenHelper.verifyAndStripTokenHash(row, hash);
    assert.equal(kept, row);
    assert.equal('token_hash' in kept, false, 'The hash must be deleted before the row leaves the repository.');
    assert.equal(tokenHelper.verifyAndStripTokenHash({ token_hash: hash }, tokenHelper.hashToken('other')), null);
    assert.equal(tokenHelper.verifyAndStripTokenHash(null, hash), null);
});

test('token: the specific dead-link code (A14) — used before revoked before expired', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    const past = new Date('2026-06-01T11:00:00.000Z');
    const future = new Date('2026-06-01T13:00:00.000Z');
    const _code = (row, revokedCode) => tokenHelper.deadLinkCode({ row: row, now: now, revoked_code: revokedCode || 'INVITE_REVOKED' });

    assert.equal(_code(null), 'TOKEN_INVALID');
    assert.equal(_code({ used_at: past, expires_at: past }), 'TOKEN_USED');
    assert.equal(_code({ accepted_at: past, revoked_at: past, expires_at: past }), 'TOKEN_USED');
    assert.equal(_code({ revoked_at: past, expires_at: past }), 'INVITE_REVOKED');
    assert.equal(_code({ revoked_at: past, expires_at: future }, 'TOKEN_INVALID'), 'TOKEN_INVALID');
    assert.equal(_code({ expires_at: past }), 'TOKEN_EXPIRED');
    assert.equal(_code({ expires_at: now }), 'TOKEN_EXPIRED', 'expires_at == now is expired: the live filter is $gt now.');
    assert.equal(_code({ expires_at: 'garbage' }), 'TOKEN_EXPIRED', 'An unreadable expiry fails narrow.');
    assert.equal(_code({ expires_at: future }), 'TOKEN_INVALID', 'A live-looking row the live query missed is not described.');
});


/* ==========================================================================
 *  resolvePrincipal (§6, I5)
 * ========================================================================== */

const _user = (overrides) => Object.assign({
    _id: ANALYST_ID,
    email: 'member@example.com',
    name: 'Member',
    role_key: 'analyst',
    custom_role_id: null
}, overrides || {});

test('principal: ownership is ONLY the install pointer, whatever the stored role says', () => {
    const owner = principalHelper.resolvePrincipal({
        user: _user({ _id: OWNER_ID, role_key: 'viewer' }),
        install: { owner_user_id: OWNER_ID },
        custom_role: null
    });
    assert.equal(owner.is_owner, true);
    assert.equal(owner.role_key, 'owner');
    assert.equal(owner.role_label, 'Owner');
    assert.deepEqual([...owner.permissions], ALL_PERMISSION_KEYS.slice().sort());

    // Same row, the pointer elsewhere: the stored role applies — and it is NOT widened to admin.
    const demoted = principalHelper.resolvePrincipal({
        user: _user({ _id: OWNER_ID, role_key: 'viewer' }),
        install: { owner_user_id: ADMIN_ID },
        custom_role: null
    });
    assert.equal(demoted.is_owner, false);
    assert.equal(demoted.role_key, 'viewer');
    assert.deepEqual([...demoted.permissions], BUILT_IN_ROLES.viewer.permissions.slice().sort());

    // A missing install document or a null pointer makes NOBODY the owner (A9: fails narrow).
    for (const install of [null, { owner_user_id: null }, {}]) {
        const principal = principalHelper.resolvePrincipal({ user: _user({ _id: OWNER_ID, role_key: 'admin' }), install: install, custom_role: null });
        assert.equal(principal.is_owner, false);
        assert.equal(principal.permissions.includes(P.ROLES_MANAGE), false, 'Without the pointer, roles:manage is never held.');
    }
});

test('principal: a missing or mismatched custom role grants NOTHING — never widened', () => {
    const missing = principalHelper.resolvePrincipal({
        user: _user({ role_key: 'custom', custom_role_id: ROLE_ID }),
        install: { owner_user_id: OWNER_ID },
        custom_role: null
    });
    assert.deepEqual([...missing.permissions], []);
    assert.equal(missing.role_key, 'custom');

    const mismatched = principalHelper.resolvePrincipal({
        user: _user({ role_key: 'custom', custom_role_id: ROLE_ID }),
        install: { owner_user_id: OWNER_ID },
        custom_role: { _id: '5'.repeat(24), name: 'Other', permissions: ALL_PERMISSION_KEYS.slice() }
    });
    assert.deepEqual([...mismatched.permissions], [], 'A role row that is not the one the user points at must grant nothing.');

    const unknownRoleKey = principalHelper.resolvePrincipal({ user: _user({ role_key: 'superuser' }), install: null, custom_role: null });
    assert.deepEqual([...unknownRoleKey.permissions], []);
    assert.equal(principalHelper.resolvePrincipal({ user: _user({ role_key: 'owner' }), install: null, custom_role: null }).permissions.length, 0,
        'A stored role_key of "owner" is not a built-in a user row may hold — it must grant nothing.');
});

test('principal: unknown, owner-only and unsupported keys read back from a custom role are DROPPED', () => {
    const { principal, anomalies } = principalHelper.resolvePrincipalWithAnomalies({
        user: _user({ role_key: 'custom', custom_role_id: ROLE_ID }),
        install: { owner_user_id: OWNER_ID },
        custom_role: {
            _id: ROLE_ID,
            name: 'Support',
            permissions: [P.APPS_READ, P.ANALYTICS_READ, 'bogus:key', P.ROLES_MANAGE, P.MERCHANTS_READ, 42, P.ANALYTICS_READ]
        }
    });
    // merchants:read requires financials:read, which the row lacks, so it is dropped too.
    assert.deepEqual([...principal.permissions], [P.ANALYTICS_READ, P.APPS_READ]);
    assert.equal(principal.role_label, 'Support');
    assert.equal(principal.custom_role_id, ROLE_ID);
    for (const dropped of ['bogus:key', P.ROLES_MANAGE, P.MERCHANTS_READ]) {
        assert.ok(anomalies.dropped_permissions.includes(dropped), `${dropped} should be reported as dropped.`);
    }
});

test('principal: the result and its permission list are frozen and sorted', () => {
    const principal = principalHelper.resolvePrincipal({ user: _user({ role_key: 'admin' }), install: { owner_user_id: OWNER_ID }, custom_role: null });
    assert.ok(Object.isFrozen(principal));
    assert.ok(Object.isFrozen(principal.permissions));
    assert.deepEqual([...principal.permissions], principal.permissions.slice().sort());
    assert.throws(() => {
        'use strict';
        principal.permissions.push(P.ROLES_MANAGE);
    });
});


/* ==========================================================================
 *  The management rule (§5)
 * ========================================================================== */

const _actor = (roleKey, userId, isOwner) => ({
    user_id: userId,
    email: `${roleKey}@example.com`,
    name: roleKey,
    is_owner: Boolean(isOwner),
    role_key: isOwner ? 'owner' : roleKey,
    role_label: roleKey,
    custom_role_id: null,
    permissions: Object.freeze((isOwner ? ALL_PERMISSION_KEYS : BUILT_IN_ROLES[roleKey].permissions).slice().sort())
});

const OWNER = _actor('owner', OWNER_ID, true);
const ADMIN = _actor('admin', ADMIN_ID, false);
const ANALYST = _actor('analyst', ANALYST_ID, false);

const _manage = (actor, target) => managementHelper.evaluateManagement(Object.assign({
    actor: actor,
    target_is_owner: false,
    target_user_id: '9'.repeat(24),
    target_permissions: BUILT_IN_ROLES.viewer.permissions,
    new_permissions: undefined
}, target));

test('management: nobody acts on themselves — not even the owner', () => {
    assert.deepEqual(_manage(OWNER, { target_user_id: OWNER_ID, target_is_owner: true }), { allowed: false, reason: MANAGEMENT_BLOCK_REASONS.SELF });
    assert.deepEqual(
        _manage(ADMIN, { target_user_id: ADMIN_ID, target_permissions: ADMIN.permissions }),
        { allowed: false, reason: MANAGEMENT_BLOCK_REASONS.SELF }
    );
});

test('management: nobody acts on the owner through the API; an unknown owner flag fails narrow', () => {
    assert.equal(_manage(ADMIN, { target_is_owner: true, target_permissions: [] }).reason, MANAGEMENT_BLOCK_REASONS.TARGET_IS_OWNER);
    assert.equal(_manage(OWNER, { target_is_owner: undefined }).allowed, false, 'target_is_owner must be an explicit false.');
});

test('management: the owner may act on any other user and assign any assignable role', () => {
    assert.equal(_manage(OWNER, { target_permissions: BUILT_IN_ROLES.admin.permissions }).allowed, true);
    assert.equal(_manage(OWNER, { new_permissions: BUILT_IN_ROLES.admin.permissions }).allowed, true);
    // ...but nobody hands out an owner-only key, the owner included.
    assert.equal(_manage(OWNER, { new_permissions: ALL_PERMISSION_KEYS }).reason, MANAGEMENT_BLOCK_REASONS.ROLE_NOT_ASSIGNABLE);
});

test('management: everyone else needs users:manage and a STRICT subset — equal sets are refused', () => {
    assert.equal(_manage(ADMIN, { target_permissions: BUILT_IN_ROLES.analyst.permissions }).allowed, true);
    assert.equal(
        _manage(ADMIN, { target_permissions: BUILT_IN_ROLES.admin.permissions }).reason,
        MANAGEMENT_BLOCK_REASONS.TARGET_NOT_BELOW_ACTOR,
        'Two admins must not be able to disable each other.'
    );
    assert.equal(
        _manage(ADMIN, { target_permissions: BUILT_IN_ROLES.viewer.permissions, new_permissions: BUILT_IN_ROLES.admin.permissions }).reason,
        MANAGEMENT_BLOCK_REASONS.ROLE_NOT_BELOW_ACTOR,
        'An admin must not promote anyone to their own level.'
    );
    assert.equal(_manage(ANALYST, { target_permissions: BUILT_IN_ROLES.viewer.permissions }).reason, MANAGEMENT_BLOCK_REASONS.MISSING_USERS_MANAGE);

    // A target holding a key the actor lacks is not below the actor even if it holds fewer keys.
    const lopsided = _actor('admin', ADMIN_ID, false);
    const withoutAudit = Object.assign({}, lopsided, { permissions: lopsided.permissions.filter((key) => key !== P.AUDIT_READ) });
    assert.equal(_manage(withoutAudit, { target_permissions: [P.APPS_READ, P.AUDIT_READ] }).allowed, false);
});

test('management: the assignable-role list is filtered by the SAME rule', () => {
    const customRoles = [
        { _id: ROLE_ID, name: 'Support', permissions: [P.APPS_READ, P.ANALYTICS_READ] },
        { _id: '5'.repeat(24), name: 'Broken', permissions: ['bogus:key'] }
    ];
    const forOwner = managementHelper.assignableRolesFor(OWNER, customRoles).map((role) => role.label);
    assert.deepEqual(forOwner, ['Admin', 'Analyst', 'Viewer', 'Support'], 'A custom role that resolves to nothing is never offered.');

    const forAdmin = managementHelper.assignableRolesFor(ADMIN, customRoles).map((role) => role.label);
    assert.deepEqual(forAdmin, ['Analyst', 'Viewer', 'Support'], 'An admin cannot offer Admin.');

    assert.deepEqual(managementHelper.assignableRolesFor(ANALYST, customRoles), [], 'No users:manage, nothing to offer.');
});


/* ==========================================================================
 *  Custom roles
 * ========================================================================== */

test('custom role: a valid body is normalised — deduplicated, sorted, trimmed, name_norm lowercased', () => {
    const result = roleHelper.validateCustomRole({
        name: '  Support Team ',
        description: ' Reads the numbers. ',
        permissions: [P.ANALYTICS_READ, P.APPS_READ, P.ANALYTICS_READ]
    });
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.value, {
        name: 'Support Team',
        name_norm: 'support team',
        description: 'Reads the numbers.',
        permissions: [P.ANALYTICS_READ, P.APPS_READ]
    });
});

test('custom role: every refusal names its field — baseline, unknown, owner-only, unmet prerequisites, types', () => {
    const _refusal = (body) => roleHelper.validateCustomRole(Object.assign({ name: 'Support', description: '', permissions: [P.APPS_READ] }, body));

    const noBaseline = _refusal({ permissions: [P.ANALYTICS_READ] });
    assert.equal(noBaseline.ok, false);
    assert.deepEqual(noBaseline.keys, [P.APPS_READ]);

    const unknown = _refusal({ permissions: [P.APPS_READ, 'apps:delete'] });
    assert.deepEqual([unknown.ok, unknown.field, unknown.keys], [false, 'permissions', ['apps:delete']]);

    const ownerOnly = _refusal({ permissions: [P.APPS_READ, P.USERS_READ, P.ROLES_MANAGE] });
    assert.deepEqual([ownerOnly.ok, ownerOnly.keys], [false, [P.ROLES_MANAGE]]);

    const unmet = _refusal({ permissions: [P.APPS_READ, P.MERCHANTS_READ] });
    assert.deepEqual([unmet.ok, unmet.keys], [false, [P.FINANCIALS_READ]], 'merchants:read requires financials:read.');

    for (const permissions of [[], 'apps:read', null, [P.APPS_READ, 7], [P.APPS_READ, { $ne: 1 }]]) {
        assert.equal(_refusal({ permissions: permissions }).ok, false, `${JSON.stringify(permissions)} must be refused.`);
    }
    assert.equal(_refusal({ permissions: new Array(65).fill(P.APPS_READ) }).ok, false, 'An absurdly long list is refused before any work.');
});

test('custom role: names — 1..60 chars, no control characters, no links, never a built-in name; description ≤ 280', () => {
    const _field = (body) => {
        const result = roleHelper.validateCustomRole(Object.assign({ name: 'Support', description: '', permissions: [P.APPS_READ] }, body));
        return result.ok ? null : result.field;
    };
    assert.equal(_field({ name: 'x'.repeat(60) }), null);
    assert.equal(_field({ name: 'x'.repeat(61) }), 'name');
    assert.equal(_field({ name: '   ' }), 'name');
    assert.equal(_field({ name: 'Bad\u0007Name' }), 'name');
    assert.equal(_field({ name: 'Click www.example.com' }), 'name');
    for (const reserved of ['Owner', ' admin ', 'ANALYST', 'Viewer']) {
        assert.equal(_field({ name: reserved }), 'name', `"${reserved}" is a built-in role name.`);
    }
    assert.equal(_field({ description: 'x'.repeat(280) }), null);
    assert.equal(_field({ description: 'x'.repeat(281) }), 'description');
    assert.equal(_field({ description: 42 }), 'description');
});

test('custom role: the permission closure follows requires transitively', () => {
    assert.deepEqual(roleHelper.permissionClosure([P.MERCHANTS_READ]), [P.APPS_READ, P.FINANCIALS_READ, P.MERCHANTS_READ]);
    assert.deepEqual(roleHelper.permissionClosure([P.USERS_MANAGE]), [P.APPS_READ, P.USERS_MANAGE, P.USERS_READ]);
    assert.deepEqual(roleHelper.missingRequirements([P.SYNC_RUN, P.APPS_READ]), [P.SYNC_READ]);
    assert.deepEqual(roleHelper.permissionClosure(['bogus:key']), []);
});

test('role assignment: custom_role_id is present iff role_key is custom (A2)', () => {
    assert.equal(roleHelper.validateRoleAssignment({ role_key: 'viewer' }).ok, true);
    assert.equal(roleHelper.validateRoleAssignment({ role_key: 'viewer', custom_role_id: ROLE_ID }).ok, false);
    assert.equal(roleHelper.validateRoleAssignment({ role_key: 'custom' }).ok, false);
    assert.equal(roleHelper.validateRoleAssignment({ role_key: 'custom', custom_role_id: 'not-an-id' }).code, 'NOT_FOUND', 'A malformed id is a 404, never a CastError 500.');
    assert.equal(roleHelper.validateRoleAssignment({ role_key: 'custom', custom_role_id: ROLE_ID }).ok, true);
    assert.equal(roleHelper.validateRoleAssignment({ role_key: 'owner' }).ok, false, 'owner is never assignable.');
    assert.equal(roleHelper.validateRoleAssignment({ role_key: ['admin'] }).ok, false);
});


/* ==========================================================================
 *  Identity input (I12, A2)
 * ========================================================================== */

test('email: trimmed and lowercased; one @; no dangerous punctuation or control characters; ≤ 254', () => {
    assert.deepEqual(identityHelper.validateEmail('  Jordan.Smith@Example.COM '), { ok: true, value: 'jordan.smith@example.com', reason: null });
    const local = 'a'.repeat(64);
    const longest = `${local}@${'b'.repeat(254 - 64 - 1 - 4)}.com`;
    assert.equal(longest.length, 254);
    assert.equal(identityHelper.validateEmail(longest).ok, true);
    assert.equal(identityHelper.validateEmail(`x${longest}`).ok, false);

    for (const bad of ['', 'no-at-sign', 'two@@example.com', 'a@b@example.com', 'a@example', 'a b@example.com',
        '"quoted"@example.com', 'a,b@example.com', 'a;b@example.com', '<a@example.com>', 'a(b)@example.com',
        'a[b]@example.com', 'a\\b@example.com', 'a:b@example.com', 'a\u0000b@example.com', 'a@exa‮mple.com',
        ['a@example.com'], { $gt: '' }, 12]) {
        assert.equal(identityHelper.validateEmail(bad).ok, false, `${JSON.stringify(bad)} must be refused.`);
    }
});

test('name: trimmed, 1..100 code points, no control or bidi characters, no email or web address', () => {
    assert.deepEqual(identityHelper.validateName('  Jordan Smith  '), { ok: true, value: 'Jordan Smith', reason: null });
    assert.equal(identityHelper.validateName('é'.repeat(100)).ok, true);
    assert.equal(identityHelper.validateName('x'.repeat(101)).ok, false);
    for (const bad of ['', '   ', 'Line\nbreak', 'Tab\tbed', 'Del\u007f', 'Evil‮Name', 'me@example.com',
        'see https://evil.example', 'visit www.evil.example', null, 7, ['Jordan']]) {
        assert.equal(identityHelper.validateName(bad).ok, false, `${JSON.stringify(bad)} must be refused.`);
    }
});

test('object ids: exactly 24 lowercase hex characters', () => {
    assert.equal(identityHelper.isObjectIdString('a'.repeat(24)), true);
    for (const bad of ['A'.repeat(24), 'a'.repeat(23), 'a'.repeat(25), 'probe-value', { $ne: null }, 24, null]) {
        assert.equal(identityHelper.isObjectIdString(bad), false, `${JSON.stringify(bad)} is not an id.`);
    }
});


/* ==========================================================================
 *  Invite state and the audit helpers
 * ========================================================================== */

test('invite state: computed from timestamps — accepted > revoked > expired > pending', () => {
    const now = new Date('2026-06-01T12:00:00.000Z');
    const past = new Date('2026-06-01T11:00:00.000Z');
    const future = new Date('2026-06-01T13:00:00.000Z');
    const _state = (invite) => inviteHelper.inviteState({ invite: invite, now: now });

    assert.equal(_state({ accepted_at: past, revoked_at: past, expires_at: past }), 'accepted');
    assert.equal(_state({ accepted_at: null, revoked_at: past, expires_at: future }), 'revoked');
    assert.equal(_state({ accepted_at: null, revoked_at: null, expires_at: past }), 'expired');
    assert.equal(_state({ accepted_at: null, revoked_at: null, expires_at: now }), 'expired', 'The live filter is $gt now; the view must agree.');
    assert.equal(_state({ accepted_at: null, revoked_at: null, expires_at: future }), 'pending');
    assert.equal(_state({ accepted_at: null, revoked_at: null, expires_at: 'not a date' }), 'expired');
    assert.equal(inviteHelper.inviteState({ invite: { expires_at: future }, now: 'garbage' }), 'expired');
});

test('audit: anonymous email strings are recorded only when valid; anonymous rows expire after 180 days', () => {
    assert.deepEqual(auditHelper.sanitiseAuditEmail(' Someone@Example.com '), { email: 'someone@example.com', invalid: false });
    assert.deepEqual(auditHelper.sanitiseAuditEmail('<script>@x'), { email: null, invalid: true });
    assert.deepEqual(auditHelper.sanitiseAuditEmail(undefined), { email: null, invalid: false });

    const now = new Date('2026-06-01T00:00:00.000Z');
    assert.equal(auditHelper.auditExpiresAt({ actor_type: 'ANONYMOUS', now: now }).toISOString(), '2026-11-28T00:00:00.000Z');
    for (const actorType of ['USER', 'SYSTEM', 'CLI']) {
        assert.equal(auditHelper.auditExpiresAt({ actor_type: actorType, now: now }), undefined, `${actorType} rows never expire.`);
    }
});

test('audit: the page cursor round-trips, refuses garbage, and the limit clamps to 1..200', () => {
    const at = new Date('2026-06-01T10:00:00.123Z');
    const id = 'c'.repeat(24);
    const cursor = auditHelper.encodeAuditCursor({ created_at: at, id: id });
    assert.equal(cursor, `${at.toISOString()}|${id}`);
    const decoded = auditHelper.decodeAuditCursor(cursor);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.cursor.created_at.getTime(), at.getTime());
    assert.equal(decoded.cursor.id, id);

    assert.deepEqual(auditHelper.decodeAuditCursor(undefined), { ok: true, cursor: null });
    for (const bad of ['yesterday', `${at.toISOString()}|zz`, `${at.toISOString()}|${id}|x`, { $gt: '' }, 'x'.repeat(200)]) {
        assert.equal(auditHelper.decodeAuditCursor(bad).ok, false, `${JSON.stringify(bad)} must be refused.`);
    }

    assert.equal(auditHelper.clampAuditLimit(undefined), 50);
    assert.equal(auditHelper.clampAuditLimit('0'), 1);
    assert.equal(auditHelper.clampAuditLimit(5000), 200);
    assert.equal(auditHelper.clampAuditLimit('25'), 25);
    assert.equal(auditHelper.clampAuditLimit('abc'), null);
    assert.equal(auditHelper.clampAuditLimit(2.5), null);
});
