'use strict';

/**
 * ============================================================================
 *  strictQuery CANNOT SILENTLY WIDEN AN AUTH QUERY (spec I8)
 * ============================================================================
 *
 *  `core/db.ts` sets `strictQuery: true`, and under it Mongoose SILENTLY STRIPS
 *  a filter path the schema does not declare. Verified, not feared: a filter
 *  on an undeclared field becomes `{}` and matches the first document. For the
 *  auth collections that turns a compare-and-set into an unconditional write —
 *  `{ _id, used_at: null }` with `used_at` undeclared spends a token twice;
 *  `{ _id, session_epoch }` with the epoch undeclared keeps a dead session
 *  alive. Updates are stripped the same way under the schema's `strict` mode:
 *  `$inc: { session_epoch: 1 }` on an undeclared field is a password reset
 *  that signs nobody out.
 *
 *  This file drives EVERY auth repository function with the models' statics
 *  replaced by recorders (no database), then casts each recorded filter and
 *  update through the REAL model under `strictQuery: true` — exactly what
 *  Mongoose would do before sending it — and fails on any path that did not
 *  survive. Every `create()` document is checked the same way.
 *
 *  ⚠️ `Query#_castUpdate` is Mongoose-internal. It is the only way to see the
 *  update cast without a server; if a Mongoose upgrade removes it, the update
 *  half of this file fails loudly rather than passing vacuously.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mongoose = require('mongoose');

mongoose.set('bufferTimeoutMS', 400);
mongoose.set('strictQuery', true);

const SRC = path.resolve(__dirname, '..', 'src');
const REPOS = path.join(SRC, 'modules', 'auth', 'repositories');

const models = require(path.join(SRC, 'modules', 'shared', 'repositories', 'models.repository.ts'));
const userRepository = require(path.join(REPOS, 'user.repository.ts'));
const roleRepository = require(path.join(REPOS, 'role.repository.ts'));
const inviteRepository = require(path.join(REPOS, 'invite.repository.ts'));
const authTokenRepository = require(path.join(REPOS, 'authToken.repository.ts'));
const authSessionRepository = require(path.join(REPOS, 'authSession.repository.ts'));
const systemStateRepository = require(path.join(REPOS, 'systemState.repository.ts'));
const legacyOperatorRepository = require(path.join(REPOS, 'legacyOperator.repository.ts'));
const auditEventRepository = require(path.join(REPOS, 'auditEvent.repository.ts'));
const syncHealthRepository = require(path.join(SRC, 'modules', 'sync', 'repositories', 'syncHealth.repository.ts'));

const AUTH_MODELS = {
    UserModel: models.UserModel,
    RoleModel: models.RoleModel,
    InviteModel: models.InviteModel,
    AuthTokenModel: models.AuthTokenModel,
    AuthSessionModel: models.AuthSessionModel,
    SystemStateModel: models.SystemStateModel,
    AuditEventModel: models.AuditEventModel,
    AdminUserModel: models.AdminUserModel
};

const ID = 'a'.repeat(24);
const ID2 = 'b'.repeat(24);
const HASH = 'c'.repeat(64);
const BCRYPT = `$2b$04$${'d'.repeat(53)}`;
const BCRYPT2 = `$2b$04$${'e'.repeat(53)}`;
const NOW = new Date('2026-06-01T12:00:00.000Z');
const EMAIL = 'someone@example.com';

/** What a stubbed static answers — the empty result of its kind. */
const EMPTY_RESULTS = {
    find: [],
    findOne: null,
    findById: null,
    findOneAndUpdate: null,
    findOneAndDelete: null,
    updateOne: { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 },
    updateMany: { acknowledged: true, matchedCount: 0, modifiedCount: 0 },
    countDocuments: 0,
    exists: null,
    deleteOne: { acknowledged: true, deletedCount: 0 },
    aggregate: []
};

/** A chainable, awaitable stand-in for a Mongoose Query. */
const _query = (result) => {
    const query = {
        select: () => query,
        sort: () => query,
        limit: () => query,
        skip: () => query,
        lean: () => query,
        exec: async () => result,
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject)
    };
    return query;
};

/**
 * Replaces every query static on every auth model with a recorder, runs `drive`, restores them.
 *
 * @param {Function} drive - Calls repository functions.
 * @returns {Promise<Array>} `{ model_name, model, method, filter, update, doc, pipeline }` per call.
 */
const _record = async (drive) => {
    const captured = [];
    const replaced = [];
    for (const [modelName, model] of Object.entries(AUTH_MODELS)) {
        for (const method of Object.keys(EMPTY_RESULTS)) {
            replaced.push({ model, method });
            model[method] = (...args) => {
                const entry = { model_name: modelName, model, method };
                if (method === 'findById') {
                    entry.filter = { _id: args[0] };
                } else if (method === 'aggregate') {
                    entry.pipeline = args[0];
                } else {
                    entry.filter = args[0] || {};
                    if (['findOneAndUpdate', 'updateOne', 'updateMany'].includes(method)) {
                        entry.update = args[1];
                    }
                }
                captured.push(entry);
                return _query(EMPTY_RESULTS[method]);
            };
        }
        replaced.push({ model, method: 'create' });
        model.create = async (doc) => {
            captured.push({ model_name: modelName, model, method: 'create', doc: doc });
            return { toObject: () => Object.assign({ _id: ID }, doc) };
        };
    }
    try {
        await drive();
    } finally {
        for (const { model, method } of replaced) {
            delete model[method];
        }
    }
    return captured;
};

/** Field paths a filter names (operators skipped; $or / $and / $nor descended). */
const _filterPaths = (filter) => {
    const paths = new Set();
    const walk = (node) => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            return;
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === '$or' || key === '$and' || key === '$nor') {
                for (const element of value) {
                    walk(element);
                }
                continue;
            }
            if (!key.startsWith('$')) {
                paths.add(key);
            }
        }
    };
    walk(filter);
    return paths;
};

/** `op:path` pairs an update names; a bare top-level field counts as `$set`. */
const _updatePaths = (update) => {
    const paths = new Set();
    for (const [key, value] of Object.entries(update || {})) {
        if (key.startsWith('$')) {
            for (const field of Object.keys(value || {})) {
                paths.add(`${key}:${field}`);
            }
        } else {
            paths.add(`$set:${key}`);
        }
    }
    return paths;
};

/** Drives every auth repository function at least once. */
const _driveAllRepositories = async () => {
    const throttle = { now: NOW, min_interval_ms: 60000, max_per_window: 3, window_ms: 3600000, keep: 10 };
    const expectedCustom = { role_key: 'custom', custom_role_id: ID2 };
    const expectedViewer = { role_key: 'viewer', custom_role_id: null };

    // users
    await userRepository.findById(ID);
    await userRepository.findByIdWithHash(ID);
    await userRepository.findByEmail(EMAIL);
    await userRepository.findByEmailWithHash(EMAIL);
    await userRepository.findByIds([ID, ID2]);
    await userRepository.existsById(ID);
    await userRepository.listUsers();
    await userRepository.listUsersByCustomRole({ role_id: ID });
    await userRepository.existsWithCustomRole({ role_id: ID });
    await userRepository.countUsers();
    await userRepository.countUsersByStatus();
    await userRepository.insertUser({
        _id: ID, email: EMAIL, name: 'Someone', password_hash: BCRYPT, role_key: 'custom', custom_role_id: ID2,
        email_verified_at: NOW, password_changed_at: NOW, invited_by_user_id: ID2, created_via: 'invite'
    });
    await userRepository.deleteUnacceptedInviteUser({ user_id: ID });
    await userRepository.touchLastLogin({ user_id: ID, now: NOW });
    await userRepository.rehashPassword({ user_id: ID, current_password_hash: BCRYPT, password_hash: BCRYPT2 });
    await userRepository.updatePassword({ user_id: ID, password_hash: BCRYPT2, now: NOW, expected_password_hash: BCRYPT, changed_before: NOW });
    await userRepository.bumpSessionEpoch({ user_id: ID, expected_role: expectedCustom });
    await userRepository.bumpAllSessionEpochs();
    await userRepository.disableUser({ user_id: ID, actor_user_id: ID2, now: NOW, expected_role: expectedViewer });
    await userRepository.enableUser({ user_id: ID, expected_role: expectedCustom });
    await userRepository.changeRole({ user_id: ID, role_key: 'custom', custom_role_id: ID2, expected_role: expectedViewer });
    await userRepository.updateName({ user_id: ID, name: 'Someone Else' });
    await userRepository.claimResetSendSlot({ user_id: ID, throttle: throttle });

    // roles
    await roleRepository.findById(ID);
    await roleRepository.findByIds([ID]);
    await roleRepository.listRoles();
    await roleRepository.insertRole({ name: 'Support', name_norm: 'support', description: '', permissions: ['apps:read'], created_by_user_id: ID });
    await roleRepository.updateRole({ role_id: ID, name: 'Support', name_norm: 'support', description: 'd', permissions: ['apps:read'], updated_by_user_id: ID2 });
    await roleRepository.deleteRole({ role_id: ID });

    // invites
    await inviteRepository.insertInvite({ email: EMAIL, role_key: 'viewer', custom_role_id: null, invited_by_user_id: ID, token_hash: HASH, expires_at: NOW, now: NOW });
    await inviteRepository.findById(ID);
    await inviteRepository.findLiveByTokenHash({ token_hash: HASH, now: NOW });
    await inviteRepository.findAnyByTokenHash({ token_hash: HASH });
    await inviteRepository.findOutstandingByEmail({ email: EMAIL });
    await inviteRepository.listInvites();
    await inviteRepository.listOutstanding({ invited_by_user_id: ID });
    await inviteRepository.listOutstanding({ custom_role_id: ID });
    await inviteRepository.listOutstanding({ email: EMAIL });
    await inviteRepository.existsLiveWithCustomRole({ role_id: ID, now: NOW });
    await inviteRepository.countCreatedBySince({ user_id: ID, since: NOW });
    await inviteRepository.acceptInvite({ invite_id: ID, token_hash: HASH, accepted_user_id: ID2, now: NOW });
    await inviteRepository.revokeInvite({ invite_id: ID, actor_user_id: ID2, reason: 'MANUAL', now: NOW });
    await inviteRepository.claimResend({
        invite_id: ID, actor_user_id: ID2, token_hash: HASH, expires_at: NOW,
        throttle: { now: NOW, min_interval_ms: 60000, max_per_window: 5, window_ms: 86400000, keep: 10 }
    });
    await inviteRepository.reparentOutstanding({ from_user_id: ID, to_user_id: ID2 });

    // link tokens
    await authTokenRepository.insertToken({ purpose: 'PASSWORD_RESET', token_hash: HASH, email: EMAIL, user_id: ID, name: null, expires_at: NOW, request_ip: '203.0.113.9' });
    await authTokenRepository.insertToken({ purpose: 'SETUP_VERIFY', token_hash: HASH, email: EMAIL, user_id: null, name: 'Owner', expires_at: NOW, request_ip: null });
    await authTokenRepository.findLiveByTokenHash({ purpose: 'PASSWORD_RESET', token_hash: HASH, now: NOW });
    await authTokenRepository.findAnyByTokenHash({ purpose: 'SETUP_VERIFY', token_hash: HASH });
    await authTokenRepository.findByIdWithClaim(ID);
    await authTokenRepository.claimSetupToken({ token_id: ID, name: 'Owner', password_hash: BCRYPT, now: NOW });
    await authTokenRepository.spendToken({ token_id: ID, purpose: 'PASSWORD_RESET', now: NOW });
    await authTokenRepository.unsetClaim({ token_id: ID });
    await authTokenRepository.revokeLiveTokens({ purpose: 'SETUP_VERIFY', now: NOW, email: EMAIL });
    await authTokenRepository.revokeLiveTokens({ purpose: 'PASSWORD_RESET', now: NOW, user_id: ID, except_token_id: ID2 });
    await authTokenRepository.revokeLiveTokens({ purpose: 'PASSWORD_RESET', now: NOW, user_id: ID, token_id: ID2 });
    await authTokenRepository.countLive({ purpose: 'SETUP_VERIFY', now: NOW });
    await authTokenRepository.countLiveForEmail({ purpose: 'SETUP_VERIFY', email: EMAIL, now: NOW });
    await authTokenRepository.countForEmailSince({ purpose: 'SETUP_VERIFY', email: EMAIL, since: NOW });
    await authTokenRepository.findLatestForEmail({ purpose: 'SETUP_VERIFY', email: EMAIL });

    // sessions
    await authSessionRepository.insertSession({ user_id: ID, epoch: 3, expires_at: NOW, ip: '203.0.113.9', user_agent: 'test' });
    await authSessionRepository.findById(ID);
    await authSessionRepository.revokeSession({ session_id: ID, user_id: ID2, reason: 'LOGOUT', now: NOW });
    await authSessionRepository.revokeAllForUser({ user_id: ID, reason: 'PASSWORD_RESET', now: NOW, except_session_id: ID2 });
    await authSessionRepository.revokeAll({ reason: 'CLI_REVOKED', now: NOW });

    // install, legacy operators, audit, and the health screen's auth read
    await systemStateRepository.findInstallState();
    await systemStateRepository.ensureInstallDocument({ locked_at: null });
    await systemStateRepository.ensureInstallDocument({ locked_at: NOW });
    await systemStateRepository.lockSetup({ owner_user_id: ID, setup_token_id: ID2, now: NOW });
    await systemStateRepository.moveOwnerPointer({ from_owner_user_id: ID, to_owner_user_id: ID2 });
    await systemStateRepository.moveOwnerPointer({ from_owner_user_id: null, to_owner_user_id: ID2 });
    await legacyOperatorRepository.markAllLegacy({ now: NOW });
    await legacyOperatorRepository.listLegacyEmails();
    await legacyOperatorRepository.countLegacy();
    await auditEventRepository.insertAuditEvent({
        actor_type: 'USER', actor_user_id: ID, actor_email: EMAIL, action: 'LOGOUT', target_type: 'SESSION',
        target_id: ID2, target_email: null, ip: '203.0.113.9', details: { count: 1 }, expires_at: NOW
    });
    await auditEventRepository.listAuditEvents({ limit: 50, before: { created_at: NOW, id: ID } });
    await syncHealthRepository.readAuthHealthFacts();
};

let CAPTURED = null;

test.before(async () => {
    CAPTURED = await _record(_driveAllRepositories);
});


test('the recorder saw every kind of query the auth repositories issue — this file is not vacuous', () => {
    const methods = new Set(CAPTURED.map((entry) => entry.method));
    for (const method of ['find', 'findOne', 'findById', 'findOneAndUpdate', 'updateOne', 'updateMany', 'countDocuments', 'exists', 'create']) {
        assert.ok(methods.has(method), `No repository call reached ${method}.`);
    }
    const modelsSeen = new Set(CAPTURED.map((entry) => entry.model_name));
    assert.deepEqual(_sortedArray(modelsSeen), _sortedArray(Object.keys(AUTH_MODELS)));
    assert.ok(CAPTURED.filter((entry) => entry.update).length >= 20, 'Too few updates recorded.');
});

test('control: the cast really does strip an undeclared path, in a filter and in an update', () => {
    const query = models.UserModel.find({ _id: ID, not_a_declared_field: null, $or: [{ also_undeclared: 1 }, { status: 'active' }] });
    query.cast(models.UserModel);
    const kept = _filterPaths(query.getFilter());
    assert.equal(kept.has('not_a_declared_field'), false, 'strictQuery is not on in this process — every assertion below would be vacuous.');
    assert.equal(kept.has('also_undeclared'), false);
    assert.equal(kept.has('status'), true);

    const update = models.UserModel.findOneAndUpdate({}, { $set: { not_a_declared_field: 1, name: 'x' }, $inc: { undeclared_counter: 1 } });
    const casted = _updatePaths(update._castUpdate(update.getUpdate()) || {});
    assert.equal(casted.has('$set:not_a_declared_field'), false);
    assert.equal(casted.has('$inc:undeclared_counter'), false);
    assert.equal(casted.has('$set:name'), true);
});

test('every FILTER path survives the strictQuery cast — no compare-and-set can silently become unconditional', () => {
    const stripped = [];
    for (const entry of CAPTURED) {
        const filters = [];
        if (entry.filter) {
            filters.push(entry.filter);
        }
        for (const stage of entry.pipeline || []) {
            if (stage.$match) {
                filters.push(stage.$match);
            }
        }
        for (const filter of filters) {
            const query = entry.model.find(filter);
            query.cast(entry.model);
            const kept = _filterPaths(query.getFilter());
            for (const pathName of _filterPaths(filter)) {
                if (!kept.has(pathName)) {
                    stripped.push(`${entry.model_name}.${entry.method}: filter path "${pathName}" is not declared in the schema`);
                }
            }
        }
    }
    assert.deepEqual(stripped, [], 'strictQuery STRIPS these — the query would match more than it says:');
});

test('every UPDATE path survives the cast — no $set / $inc / $unset / $push is dropped by strict mode', () => {
    const stripped = [];
    for (const entry of CAPTURED.filter((candidate) => candidate.update)) {
        const query = entry.model.findOneAndUpdate({}, entry.update);
        assert.equal(typeof query._castUpdate, 'function', 'Mongoose no longer exposes Query#_castUpdate — replace this check before trusting it.');
        const casted = query._castUpdate(query.getUpdate()) || {};
        const kept = _updatePaths(casted);
        for (const pair of _updatePaths(entry.update)) {
            if (!kept.has(pair)) {
                stripped.push(`${entry.model_name}.${entry.method}: update "${pair}" is not declared in the schema`);
            }
        }
    }
    assert.deepEqual(stripped, [], 'strict mode DROPS these writes silently:');
});

test('every created document keeps every field it was given', () => {
    const dropped = [];
    for (const entry of CAPTURED.filter((candidate) => candidate.method === 'create')) {
        const kept = new entry.model(entry.doc).toObject();
        for (const field of Object.keys(entry.doc)) {
            if (entry.doc[field] !== undefined && !(field in kept)) {
                dropped.push(`${entry.model_name}.create: "${field}" is not declared in the schema`);
            }
        }
    }
    assert.deepEqual(dropped, []);
});

test('secrets are select:false — a plain read never carries a password hash, a token hash, or a setup claim', () => {
    const hidden = [
        [models.UserModel, 'password_hash'],
        [models.InviteModel, 'token_hash'],
        [models.AuthTokenModel, 'token_hash'],
        [models.AuthTokenModel, 'claim']
    ];
    for (const [model, field] of hidden) {
        const schemaPath = model.schema.path(field);
        assert.ok(schemaPath, `${model.modelName}.${field} is not declared.`);
        assert.equal(schemaPath.options.select, false, `${model.modelName}.${field} must be select:false.`);
    }
    // And every lookup that needs one asks for it explicitly, in a repository — never by default.
    const selects = CAPTURED.filter((entry) => entry.method !== 'create').length;
    assert.ok(selects > 0);
});

test('the named indexes the spec relies on exist on the schemas (unique gates, TTLs)', () => {
    const _index = (model, name) => model.schema.indexes().find(([, options]) => options && options.name === name);
    const expectations = [
        [models.UserModel, 'uniq_user_email', { email: 1 }, { unique: true }],
        [models.RoleModel, 'uniq_role_name_norm', { name_norm: 1 }, { unique: true }],
        [models.InviteModel, 'uniq_invite_token_hash', { token_hash: 1 }, { unique: true }],
        [models.InviteModel, 'uniq_invite_pending_email', { pending_email: 1 }, { unique: true, partialFilterExpression: { pending_email: { $exists: true } } }],
        [models.AuthTokenModel, 'uniq_auth_token_hash', { token_hash: 1 }, { unique: true }],
        [models.AuthTokenModel, 'ttl_auth_token_expires', { expires_at: 1 }, { expireAfterSeconds: 7 * 24 * 3600 }],
        [models.AuthSessionModel, 'ttl_session_expires', { expires_at: 1 }, { expireAfterSeconds: 0 }],
        [models.AuditEventModel, 'idx_audit_created', { createdAt: -1, _id: -1 }, {}],
        [models.AuditEventModel, 'ttl_audit_anonymous', { expires_at: 1 }, { expireAfterSeconds: 0 }]
    ];
    for (const [model, name, keys, options] of expectations) {
        const found = _index(model, name);
        assert.ok(found, `${model.modelName} has no index named ${name}.`);
        assert.deepEqual(found[0], keys, `${name} keys`);
        for (const [option, value] of Object.entries(options)) {
            assert.deepEqual(found[1][option], value, `${name}.${option}`);
        }
    }
});

/** Sorted array from any iterable. */
function _sortedArray(values) {
    return Array.from(values).sort();
}
