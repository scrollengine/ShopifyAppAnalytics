'use strict';

/**
 * ============================================================================
 *  AUTH SERVICES — the races, the oracles and the fail-closed paths (spec §7, §15, A4, A6, A7, A13, A14, A20)
 * ============================================================================
 *
 *  Every repository is replaced by an in-memory fake whose compare-and-set
 *  writes behave like the real single-document CAS: check and set in one
 *  synchronous step, so two concurrent callers produce exactly one winner.
 *  That lets this file drive the services through the interleavings that
 *  matter — two setups racing for the lock, an accept racing a revoke, a
 *  password reset landing between a login's read and its session insert —
 *  without a database.
 *
 *  ── What the fakes are NOT ──────────────────────────────────────────────────
 *  They are not a second implementation of the queries. The CAS FILTERS the
 *  real repositories send are asserted separately at the bottom of this file,
 *  by stubbing `Model.findOneAndUpdate` and reading what was asked for. The
 *  fakes prove the services use the CAS correctly; the filter tests prove the
 *  CAS is the one the fakes assume.
 *
 *  ── No database, observed ───────────────────────────────────────────────────
 *  Every test fails if anything reached mongoose: with no connection, a query
 *  BUFFERS and the connection emits 'buffer'. An unstubbed repository call is a
 *  test testing something other than what it says.
 * ============================================================================
 */

// ── Environment, BEFORE any require (src/config snapshots process.env) ───────
process.env.LOG_LEVEL = 'silent';
process.env.JWT_SECRET = 'x'.repeat(32);
process.env.AUTH_BCRYPT_ROUNDS = '4';
process.env.APP_PUBLIC_URL = 'https://analytics.example.com';
for (const key of ['SETUP_OWNER_EMAIL', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_PASSWORD_HASH', 'TRUST_PROXY']) {
    delete process.env[key];
}

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

mongoose.set('bufferTimeoutMS', 400);

const SRC = path.resolve(__dirname, '..', 'src');
const AUTH = path.join(SRC, 'modules', 'auth');

const logger = require(path.join(SRC, 'core', 'logger.ts'));
const mailModule = require(path.join(SRC, 'modules', 'mail'));
const authModule = require(AUTH);
const modelsRepository = require(path.join(SRC, 'modules', 'shared', 'repositories', 'models.repository.ts'));
const authenticateMiddleware = require(path.join(SRC, 'middlewares', 'authenticate.ts'));

const setupService = require(path.join(AUTH, 'services', 'setup.service.ts'));
const sessionService = require(path.join(AUTH, 'services', 'session.service.ts'));
const principalService = require(path.join(AUTH, 'services', 'principal.service.ts'));
const passwordService = require(path.join(AUTH, 'services', 'password.service.ts'));
const inviteService = require(path.join(AUTH, 'services', 'invite.service.ts'));
const installStateService = require(path.join(AUTH, 'services', 'installState.service.ts'));
const userService = require(path.join(AUTH, 'services', 'user.service.ts'));

const userRepository = require(path.join(AUTH, 'repositories', 'user.repository.ts'));
const authTokenRepository = require(path.join(AUTH, 'repositories', 'authToken.repository.ts'));
const authSessionRepository = require(path.join(AUTH, 'repositories', 'authSession.repository.ts'));
const systemStateRepository = require(path.join(AUTH, 'repositories', 'systemState.repository.ts'));
const legacyOperatorRepository = require(path.join(AUTH, 'repositories', 'legacyOperator.repository.ts'));
const inviteRepository = require(path.join(AUTH, 'repositories', 'invite.repository.ts'));
const roleRepository = require(path.join(AUTH, 'repositories', 'role.repository.ts'));
const auditEventRepository = require(path.join(AUTH, 'repositories', 'auditEvent.repository.ts'));
const authIndexRepository = require(path.join(AUTH, 'repositories', 'authIndex.repository.ts'));

const tokenHelper = require(path.join(AUTH, 'helpers', 'token.helper.ts'));
const authConstants = require(path.join(AUTH, 'constants', 'auth.constants.ts'));

const { AUTH_MESSAGES, TOKEN_PURPOSES, JWT_AUDIENCE } = authConstants;

const OWNER_ID = '1'.repeat(24);
const ADMIN_ID = '2'.repeat(24);
const MEMBER_ID = '3'.repeat(24);
const GOOD_PASSWORD = 'plum tractor velvet ocean';

const MINUTE_MS = 60 * 1000;


/* ==========================================================================
 *  Stubbing, the no-database detector, and the in-memory world
 * ========================================================================== */

const STUBS = [];

/**
 * Replaces `target[key]`, remembering how to put it back (own property or inherited).
 *
 * @param {Object} target - A module object or a model.
 * @param {String} key - The property.
 * @param {*} value - The replacement.
 * @returns {void}
 */
const _stub = (target, key, value) => {
    STUBS.push({ target, key, had: Object.prototype.hasOwnProperty.call(target, key), original: target[key] });
    target[key] = value;
};

const _restoreAll = () => {
    while (STUBS.length > 0) {
        const entry = STUBS.pop();
        if (entry.had) {
            entry.target[entry.key] = entry.original;
        } else {
            delete entry.target[entry.key];
        }
    }
};

const BUFFERED = [];
mongoose.connection.on('buffer', (event) => BUFFERED.push(`${event.collectionName}.${event.method}`));

test.beforeEach(() => {
    BUFFERED.length = 0;
});

test.afterEach(() => {
    _restoreAll();
    installStateService.resetInstallStateServiceState();
    const touched = BUFFERED.splice(0);
    assert.deepEqual(touched, [], 'A query reached mongoose — a repository call this test did not stub.');
});

/** Lets every queued setImmediate / microtask run (the deferred halves of the anonymous flows). */
const _drain = async (turns) => {
    for (let index = 0; index < (turns || 25); index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

const _clone = (value) => (value === null || value === undefined ? null : Object.assign({}, value));
const _withoutHash = (row) => {
    const copy = _clone(row);
    if (copy) {
        delete copy.token_hash;
        delete copy.password_hash;
        delete copy.claim;
    }
    return copy;
};
const _newId = () => new mongoose.Types.ObjectId().toHexString();
const _duplicateKey = (field) => Object.assign(new Error(`E11000 duplicate key error: ${field}`), { name: 'MongoServerError', code: 11000, keyPattern: { [field]: 1 } });

/**
 * A fresh in-memory world and the fakes over it. Every fake records `{ name, args }` in
 * `world.calls`, which is what the "same calls before the response" assertions read.
 *
 * @param {Object} [seed] - Initial install / users / tokens / invites / legacy emails.
 * @returns {Object} The world.
 */
const _installWorld = (seed) => {
    const world = Object.assign({
        install: { _id: 'install', setup_completed_at: null, owner_user_id: null, setup_token_id: null },
        users: new Map(),
        tokens: [],
        sessions: new Map(),
        invites: [],
        roles: new Map(),
        legacy: [],
        legacy_throws: false,
        audits: [],
        mails: [],
        logs: [],
        calls: [],
        hooks: {}
    }, seed || {});

    const fake = (target, key, fn) => {
        _stub(target, key, async (...args) => {
            world.calls.push({ name: key, args: args });
            if (typeof world.hooks[key] === 'function') {
                await world.hooks[key](...args);
            }
            return fn(...args);
        });
    };

    // ── install ────────────────────────────────────────────────────────────
    fake(systemStateRepository, 'findInstallState', () => _clone(world.install));
    fake(systemStateRepository, 'ensureInstallDocument', () => ({ inserted: false }));
    fake(systemStateRepository, 'lockSetup', ({ owner_user_id, setup_token_id, now }) => {
        if (!world.install || world.install.setup_completed_at !== null) {
            return null;
        }
        Object.assign(world.install, { setup_completed_at: now, owner_user_id: owner_user_id, setup_token_id: setup_token_id });
        return _clone(world.install);
    });
    fake(legacyOperatorRepository, 'listLegacyEmails', () => {
        if (world.legacy_throws) {
            throw Object.assign(new Error('connection lost'), { name: 'MongoNetworkError' });
        }
        return world.legacy.slice();
    });

    // ── users ──────────────────────────────────────────────────────────────
    const byEmail = (email) => Array.from(world.users.values()).find((user) => user.email === email) || null;
    fake(userRepository, 'findById', (id) => _withoutHash(world.users.get(String(id))));
    fake(userRepository, 'findByIdWithHash', (id) => _clone(world.users.get(String(id))));
    fake(userRepository, 'findByEmail', (email) => _withoutHash(byEmail(email)));
    fake(userRepository, 'findByEmailWithHash', (email) => _clone(byEmail(email)));
    fake(userRepository, 'insertUser', (fields) => {
        const id = String(fields._id);
        if (world.users.has(id)) {
            throw _duplicateKey('_id');
        }
        if (byEmail(fields.email)) {
            throw _duplicateKey('email');
        }
        world.users.set(id, Object.assign({ status: 'active', session_epoch: 0, createdAt: new Date() }, fields, { _id: id }));
        return _withoutHash(world.users.get(id));
    });
    fake(userRepository, 'deleteUnacceptedInviteUser', ({ user_id }) => {
        const user = world.users.get(String(user_id));
        if (user && user.created_via === 'invite') {
            world.users.delete(String(user_id));
            return 1;
        }
        return 0;
    });
    fake(userRepository, 'updatePassword', ({ user_id, password_hash, now, expected_password_hash, changed_before }) => {
        const user = world.users.get(String(user_id));
        if (!user || user.status !== 'active') {
            return null;
        }
        if (expected_password_hash && user.password_hash !== expected_password_hash) {
            return null;
        }
        if (changed_before && user.password_changed_at && !(user.password_changed_at < changed_before)) {
            return null;
        }
        Object.assign(user, { password_hash: password_hash, password_changed_at: now, session_epoch: (user.session_epoch || 0) + 1 });
        return _withoutHash(user);
    });
    fake(userRepository, 'disableUser', ({ user_id, actor_user_id, now }) => {
        const user = world.users.get(String(user_id));
        if (!user || user.status !== 'active') {
            return null;
        }
        Object.assign(user, { status: 'disabled', disabled_at: now, disabled_by_user_id: actor_user_id, session_epoch: (user.session_epoch || 0) + 1 });
        return _withoutHash(user);
    });
    fake(userRepository, 'touchLastLogin', () => undefined);
    fake(userRepository, 'rehashPassword', () => false);

    // ── link tokens ────────────────────────────────────────────────────────
    const liveToken = (row, now) => row.used_at === null && row.revoked_at === null && row.expires_at > now;
    fake(authTokenRepository, 'insertToken', (fields) => {
        const row = Object.assign({ _id: _newId(), used_at: null, revoked_at: null, createdAt: new Date() }, fields);
        world.tokens.push(row);
        return _withoutHash(row);
    });
    fake(authTokenRepository, 'findLiveByTokenHash', ({ purpose, token_hash, now }) => {
        return _withoutHash(world.tokens.find((row) => row.purpose === purpose && row.token_hash === token_hash && liveToken(row, now)) || null);
    });
    fake(authTokenRepository, 'findAnyByTokenHash', ({ purpose, token_hash }) => {
        return _withoutHash(world.tokens.find((row) => row.purpose === purpose && row.token_hash === token_hash) || null);
    });
    fake(authTokenRepository, 'claimSetupToken', ({ token_id, name, password_hash, now }) => {
        const row = world.tokens.find((candidate) => candidate._id === String(token_id));
        if (!row || row.purpose !== TOKEN_PURPOSES.SETUP_VERIFY || !liveToken(row, now)) {
            return null;
        }
        Object.assign(row, { used_at: now, claim: { name: name, password_hash: password_hash } });
        return _withoutHash(row);
    });
    fake(authTokenRepository, 'spendToken', ({ token_id, purpose, now }) => {
        const row = world.tokens.find((candidate) => candidate._id === String(token_id));
        if (!row || row.purpose !== purpose || !liveToken(row, now)) {
            return null;
        }
        row.used_at = now;
        return _withoutHash(row);
    });
    fake(authTokenRepository, 'unsetClaim', ({ token_id }) => {
        const row = world.tokens.find((candidate) => candidate._id === String(token_id));
        if (row && row.claim) {
            delete row.claim;
            return true;
        }
        return false;
    });
    fake(authTokenRepository, 'revokeLiveTokens', ({ purpose, now, email, user_id, token_id, except_token_id }) => {
        let count = 0;
        for (const row of world.tokens) {
            const idMatches = (token_id === undefined || String(row._id) === String(token_id))
                && (except_token_id === undefined || String(row._id) !== String(except_token_id));
            const ownerMatches = (!email || row.email === email) && (!user_id || String(row.user_id) === String(user_id));
            if (row.purpose === purpose && liveToken(row, now) && idMatches && ownerMatches) {
                row.revoked_at = now;
                count += 1;
            }
        }
        return count;
    });
    fake(authTokenRepository, 'countLive', ({ purpose, now }) => world.tokens.filter((row) => row.purpose === purpose && liveToken(row, now)).length);
    fake(authTokenRepository, 'countLiveForEmail', ({ purpose, email, now }) => {
        return world.tokens.filter((row) => row.purpose === purpose && row.email === email && liveToken(row, now)).length;
    });
    fake(authTokenRepository, 'countForEmailSince', ({ purpose, email, since }) => {
        return world.tokens.filter((row) => row.purpose === purpose && row.email === email && row.createdAt >= since).length;
    });
    fake(authTokenRepository, 'findLatestForEmail', ({ purpose, email }) => {
        const rows = world.tokens.filter((row) => row.purpose === purpose && row.email === email);
        return _withoutHash(rows[rows.length - 1] || null);
    });

    // ── sessions ───────────────────────────────────────────────────────────
    fake(authSessionRepository, 'insertSession', (fields) => {
        const row = Object.assign({ _id: _newId(), revoked_at: null, revoked_reason: null }, fields);
        world.sessions.set(row._id, row);
        return _clone(row);
    });
    fake(authSessionRepository, 'findById', (id) => _clone(world.sessions.get(String(id))));
    fake(authSessionRepository, 'revokeSession', ({ session_id, user_id, reason, now }) => {
        const row = world.sessions.get(String(session_id));
        if (!row || String(row.user_id) !== String(user_id) || row.revoked_at) {
            return null;
        }
        Object.assign(row, { revoked_at: now, revoked_reason: reason });
        return _clone(row);
    });
    fake(authSessionRepository, 'revokeAllForUser', ({ user_id, reason, now, except_session_id }) => {
        let count = 0;
        for (const row of world.sessions.values()) {
            if (String(row.user_id) === String(user_id) && !row.revoked_at && String(row._id) !== String(except_session_id)) {
                Object.assign(row, { revoked_at: now, revoked_reason: reason });
                count += 1;
            }
        }
        return count;
    });

    // ── invites and roles ──────────────────────────────────────────────────
    const liveInvite = (row, now) => row.accepted_at === null && row.revoked_at === null && row.expires_at > now;
    fake(inviteRepository, 'findLiveByTokenHash', ({ token_hash, now }) => {
        return _withoutHash(world.invites.find((row) => row.token_hash === token_hash && liveInvite(row, now)) || null);
    });
    fake(inviteRepository, 'findAnyByTokenHash', ({ token_hash }) => _withoutHash(world.invites.find((row) => row.token_hash === token_hash) || null));
    fake(inviteRepository, 'findById', (id) => _withoutHash(world.invites.find((row) => row._id === String(id)) || null));
    fake(inviteRepository, 'acceptInvite', ({ invite_id, token_hash, accepted_user_id, now }) => {
        const row = world.invites.find((candidate) => candidate._id === String(invite_id));
        if (!row || row.token_hash !== token_hash || !liveInvite(row, now)) {
            return null;
        }
        Object.assign(row, { accepted_at: now, accepted_user_id: accepted_user_id });
        return _withoutHash(row);
    });
    fake(inviteRepository, 'revokeInvite', ({ invite_id, actor_user_id, reason, now }) => {
        const row = world.invites.find((candidate) => candidate._id === String(invite_id));
        if (!row || row.accepted_at !== null || row.revoked_at !== null) {
            return null;
        }
        Object.assign(row, { revoked_at: now, revoked_by_user_id: actor_user_id, revoked_reason: reason });
        return _withoutHash(row);
    });
    fake(inviteRepository, 'listOutstanding', ({ email, invited_by_user_id }) => {
        return world.invites
            .filter((row) => row.accepted_at === null && row.revoked_at === null)
            .filter((row) => email === undefined || row.email === email)
            .filter((row) => invited_by_user_id === undefined || String(row.invited_by_user_id) === String(invited_by_user_id))
            .map(_withoutHash);
    });
    fake(roleRepository, 'findById', (id) => _clone(world.roles.get(String(id))));

    // ── audit, mail, logger ────────────────────────────────────────────────
    fake(auditEventRepository, 'insertAuditEvent', (fields) => {
        world.audits.push(fields);
    });
    world.mail_outcome = { status: true, data: { accepted: true, status: 'SENT' }, error: {}, msg: 'The mail server accepted the message.' };
    _stub(mailModule, 'sendTemplatedEmail', async (identity, params) => {
        world.calls.push({ name: 'sendTemplatedEmail', args: [identity, params] });
        world.mails.push(params);
        return world.mail_outcome;
    });
    _stub(mailModule, 'recheckTransport', async () => {
        world.calls.push({ name: 'recheckTransport', args: [] });
    });
    for (const level of ['customConsoleLog', 'customConsoleWarn', 'customConsoleError', 'customConsoleDebug']) {
        _stub(logger, level, (message, payload) => {
            let rendered = '';
            try {
                rendered = JSON.stringify(payload === undefined ? null : payload);
            } catch (error) {
                rendered = '<unserialisable>';
            }
            world.logs.push(`${message} ${rendered}`);
        });
    }
    return world;
};

/** Makes `indexes_ready` true the way boot does (A7: user inserts refuse until then). */
const _indexesReady = async () => {
    _stub(authIndexRepository, 'createAuthIndexes', async () => ['gi_users', 'gi_invites']);
    await installStateService.ensureAuthIndexes();
    assert.equal(installStateService.areAuthIndexesReady(), true);
};

/** A link token and its stored row. */
const _linkToken = (overrides) => {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const row = Object.assign({
        _id: _newId(),
        purpose: TOKEN_PURPOSES.SETUP_VERIFY,
        token_hash: tokenHelper.hashToken(token),
        email: 'owner@example.com',
        user_id: null,
        name: 'Owner',
        expires_at: new Date(now + 30 * MINUTE_MS),
        used_at: null,
        revoked_at: null,
        request_ip: null,
        createdAt: new Date(now - MINUTE_MS)
    }, overrides || {});
    return { token, row };
};

/** Asserts no secret reached any log line. */
const _assertLogsClean = (world, secrets) => {
    const joined = world.logs.join('\n');
    for (const secret of secrets.filter(Boolean)) {
        assert.equal(joined.includes(secret), false, `A log line carried a secret: ${secret.slice(0, 12)}…`);
    }
    assert.equal(/#token=/.test(joined), false, 'A log line carried a link.');
    assert.equal(/\$2[aby]\$\d\d\$/.test(joined), false, 'A log line carried a bcrypt hash.');
};

/** A user row. */
const _user = (overrides) => Object.assign({
    _id: MEMBER_ID,
    email: 'member@example.com',
    name: 'Member',
    role_key: 'viewer',
    custom_role_id: null,
    status: 'active',
    session_epoch: 0,
    password_hash: null,
    password_changed_at: new Date(Date.now() - 24 * 60 * MINUTE_MS),
    created_via: 'invite',
    createdAt: new Date(Date.now() - 24 * 60 * MINUTE_MS)
}, overrides || {});

/** An express response double. */
const _res = () => {
    const res = {
        statusCode: 200,
        body: null,
        headersSent: false,
        headers: {},
        locals: {},
        status(code) {
            res.statusCode = code;
            return res;
        },
        json(body) {
            res.body = body;
            res.headersSent = true;
            return res;
        },
        setHeader(name, value) {
            res.headers[name.toLowerCase()] = value;
        }
    };
    return res;
};

/** Runs `authenticate` against a bearer token. */
const _authenticate = async (token) => {
    const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, originalUrl: '/api/account' };
    const res = _res();
    let nextCalled = false;
    await authenticateMiddleware.authenticate(req, res, () => {
        nextCalled = true;
    });
    return { req, res, nextCalled };
};


/* ==========================================================================
 *  1. Setup request — no oracle (A6, A7)
 * ========================================================================== */

test('setup request: allowed and disallowed addresses answer IDENTICALLY with the SAME repository calls before the response; only the allowed one gets mail', async () => {
    const world = _installWorld({ legacy: ['owner@example.com'] });

    const _preResponse = async (email) => {
        world.calls.length = 0;
        const result = await setupService.requestSetup({}, { email: email, name: 'Someone', request_ip: '203.0.113.9' });
        // `await` resumes in a microtask; the deferred job is a setImmediate, so nothing email-dependent has run yet.
        const calls = world.calls.map((call) => call.name);
        const argsText = JSON.stringify(world.calls.map((call) => call.args));
        await _drain();
        return { result, calls, argsText };
    };

    const allowed = await _preResponse('owner@example.com');
    const allowedMails = world.mails.length;
    const allowedTokens = world.tokens.length;
    const disallowed = await _preResponse('stranger@example.com');

    assert.deepEqual(allowed.result, disallowed.result, 'The two answers differ — that difference is an oracle for who may claim setup.');
    assert.equal(allowed.result.status, true);
    assert.deepEqual(allowed.result.data, { accepted: true });
    assert.deepEqual(allowed.calls, disallowed.calls, 'Different repository calls before the response are a timing oracle.');
    assert.ok(allowed.calls.length > 0, 'The response path made no repository call at all — the comparison above is vacuous.');
    for (const pre of [allowed, disallowed]) {
        assert.equal(pre.calls.includes('listLegacyEmails'), false, 'The allow-list was read before the response (A6: it belongs in the deferred job).');
        assert.equal(/example\.com/.test(pre.argsText), false, 'An email-dependent argument reached a repository before the response.');
    }

    // After the deferred job: the allowed address got exactly one token and one mail, the other nothing.
    assert.equal(allowedTokens, 1);
    assert.equal(allowedMails, 1);
    assert.equal(world.tokens.length, 1, 'A disallowed address must never get a token.');
    assert.equal(world.mails.length, 1, 'A disallowed address must never get mail.');

    const mail = world.mails[0];
    assert.equal(mail.to, 'owner@example.com');
    assert.equal(mail.template, mailModule.EMAIL_TEMPLATES.SETUP_VERIFY);
    assert.equal(mail.trigger, mailModule.MAIL_TRIGGERS.ANONYMOUS);
    assert.equal(JSON.stringify(mail.vars).includes('Someone'), false, 'The requester-supplied name must not be in the setup email (A7).');
    const match = /^https:\/\/analytics\.example\.com\/setup\/verify#token=([A-Za-z0-9_-]{43})$/.exec(mail.vars.link);
    assert.ok(match, `The link is built from APP_PUBLIC_URL with the token in the FRAGMENT: ${mail.vars.link}`);
    assert.equal(world.tokens[0].token_hash, tokenHelper.hashToken(match[1]), 'Only the sha256 of the token is stored.');
    assert.equal(JSON.stringify(world.tokens[0]).includes(match[1]), false, 'The raw token must never be stored.');

    const outcomes = world.audits.filter((row) => row.action === 'SETUP_REQUESTED').map((row) => row.details.allowed);
    assert.deepEqual(outcomes, [true, false], 'Both requests are audited, with allowed recorded honestly.');
    _assertLogsClean(world, [match[1], world.tokens[0].token_hash]);
});

test(' setup request: what GET /setup says about mail cannot tell the permitted address from a stranger\'s', async () => {
    // The reproduced oracle: only a permitted address reached a send, the send's outcome moved
    // `mail_last_check`, and GET /setup published it — so probing candidates and re-reading the
    // status named the pinned owner. Now every request (permitted, refused, or with an unreadable
    // rule) triggers the same address-independent re-check, and GET /setup reads only that check.
    const world = _installWorld({ legacy: ['owner@example.com'] });
    const _rechecksFor = async (email) => {
        world.calls.length = 0;
        await setupService.requestSetup({}, { email: email, name: 'Someone' });
        await _drain();
        return world.calls.filter((call) => call.name === 'recheckTransport').length;
    };
    assert.equal(await _rechecksFor('owner@example.com'), 1, 'The permitted address must trigger exactly one re-check.');
    assert.equal(await _rechecksFor('stranger@example.com'), 1, 'A refused address must trigger the same re-check as the permitted one.');
    world.legacy_throws = true;
    assert.equal(await _rechecksFor('owner@example.com'), 1, 'An unreadable rule must trigger it too.');

    // GET /setup publishes the transport check, never the send-driven status.
    _stub(mailModule, 'getMailStatus', () => ({ configured: true, last_check: 'failed', last_ok_at: null, consecutive_failures: 3 }));
    _stub(mailModule, 'getPublicMailCheck', () => 'ok');
    world.legacy_throws = false;
    const status = await installStateService.getSetupStatus();
    assert.equal(status.data.mail_last_check, 'ok', 'GET /setup published a status that sends (permitted addresses only) can move.');
});

test('setup request: a legacy-operator repository that THROWS sends nothing (fail closed) — and the answer is still the same 202', async () => {
    const world = _installWorld({ legacy_throws: true });

    const result = await setupService.requestSetup({}, { email: 'owner@example.com', name: 'Owner' });
    await _drain();

    assert.equal(result.status, true);
    assert.deepEqual(result.data, { accepted: true });
    assert.equal(world.tokens.length, 0, 'An unreadable allow-list must never mint a setup token.');
    assert.equal(world.mails.length, 0, 'An unreadable allow-list must never send mail.');
    assert.equal(world.calls.some((call) => call.name === 'insertToken'), false);
    assert.equal(world.audits.at(-1).details.outcome, 'RULE_UNREADABLE');

    // And GET /api/auth/setup reports the install as restricted rather than open (A7).
    const status = await installStateService.getSetupStatus();
    assert.equal(status.status, true);
    assert.equal(status.data.setup_restricted, true, 'A rule that cannot be read must not be advertised as open.');
    assert.equal(JSON.stringify(status.data).includes('owner@example.com'), false, 'GET /setup never echoes an email.');
});

test('setup request: refused shapes are 400 with no repository call; a locked install is 409; the global cap is 429', async () => {
    const world = _installWorld();
    for (const body of [{}, { email: 'not-an-email', name: 'X' }, { email: 'a@example.com' }, { email: ['a@example.com'], name: 'X' }, null]) {
        const result = await setupService.requestSetup({}, body);
        assert.equal(result.status, false);
        assert.equal(result.error.code, 'VALIDATION');
    }
    assert.deepEqual(world.calls, [], 'Shape validation must come before any read.');

    for (let index = 0; index < 10; index += 1) {
        world.tokens.push(_linkToken({ email: `p${index}@example.com` }).row);
    }
    const capped = await setupService.requestSetup({}, { email: 'owner@example.com', name: 'Owner' });
    assert.equal(capped.error.code, 'SETUP_CAPACITY');
    assert.equal(authModule.AUTH_ERROR_HTTP_STATUS.SETUP_CAPACITY, 429);

    world.install.setup_completed_at = new Date();
    const locked = await setupService.requestSetup({}, { email: 'owner@example.com', name: 'Owner' });
    assert.equal(locked.error.code, 'SETUP_ALREADY_COMPLETE');
    assert.equal(authModule.AUTH_ERROR_HTTP_STATUS.SETUP_ALREADY_COMPLETE, 409);
    await _drain();
    assert.equal(world.mails.length, 0);
});


/* ==========================================================================
 *  2. Setup completion — one winner (I10 CAS)
 * ========================================================================== */

test('setup complete: two DIFFERENT valid links racing produce exactly one owner (lock CAS); the loser gets 409 and its claim is unset', async () => {
    const world = _installWorld();
    await _indexesReady();
    const first = _linkToken({ email: 'first@example.com' });
    const second = _linkToken({ email: 'second@example.com' });
    world.tokens.push(first.row, second.row);

    // A barrier: neither lock attempt runs until BOTH links are claimed, so the two requests are
    // genuinely concurrent at the one step that must pick a winner.
    let release;
    const bothClaimed = new Promise((resolve) => {
        release = resolve;
    });
    world.hooks.lockSetup = async () => {
        if (world.tokens.filter((row) => row.claim).length >= 2) {
            release();
        }
        await Promise.race([bothClaimed, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
    };

    const [a, b] = await Promise.all([
        setupService.completeSetup({}, { token: first.token, name: 'First', password: GOOD_PASSWORD }),
        setupService.completeSetup({}, { token: second.token, name: 'Second', password: GOOD_PASSWORD })
    ]);

    const results = [a, b];
    const winners = results.filter((result) => result.status === true);
    const losers = results.filter((result) => result.status === false);
    assert.equal(winners.length, 1, 'Exactly one setup may complete.');
    assert.equal(losers.length, 1);
    assert.equal(losers[0].error.code, 'SETUP_ALREADY_COMPLETE');
    assert.deepEqual(winners[0].data, { setup_complete: true });

    assert.equal(world.users.size, 1, 'Exactly one owner row.');
    const owner = Array.from(world.users.values())[0];
    assert.equal(String(owner._id), String(world.install.owner_user_id), 'The owner row IS the pointer.');
    assert.equal(owner.role_key, 'admin', 'The stored role is the fallback admin; ownership is the pointer.');
    assert.ok(/^\$2[aby]\$04\$/.test(owner.password_hash), 'The owner password is a bcrypt hash at the configured cost.');
    assert.equal(world.tokens.filter((row) => row.claim).length, 0, 'Both claims are unset: the winner\'s after the insert, the loser\'s because it will never be rolled forward.');
    _assertLogsClean(world, [first.token, second.token, GOOD_PASSWORD]);
});

test('setup complete: the SAME link submitted twice concurrently is spent once (claim CAS) — reuse is refused', async () => {
    const world = _installWorld();
    await _indexesReady();
    const link = _linkToken({ email: 'owner@example.com' });
    world.tokens.push(link.row);

    const results = await Promise.all([
        setupService.completeSetup({}, { token: link.token, name: 'Owner', password: GOOD_PASSWORD }),
        setupService.completeSetup({}, { token: link.token, name: 'Owner', password: GOOD_PASSWORD })
    ]);
    const codes = results.map((result) => (result.status ? 'OK' : result.error.code)).sort();
    assert.deepEqual(codes, ['OK', 'TOKEN_USED'], 'One redemption wins; the other is told the link was used.');
    assert.equal(world.users.size, 1);

    // After completion, the lock answers first: 409 for good, whatever the link.
    const again = await setupService.completeSetup({}, { token: link.token, name: 'Owner', password: GOOD_PASSWORD });
    assert.equal(again.error.code, 'SETUP_ALREADY_COMPLETE');
    const inspect = await setupService.inspectSetupToken({}, { token: link.token });
    assert.equal(inspect.error.code, 'SETUP_ALREADY_COMPLETE');
});

test('setup complete: a policy refusal consumes nothing; inspect consumes nothing; indexes not ready is 503', async () => {
    const world = _installWorld();
    const link = _linkToken({ email: 'owner@example.com' });
    world.tokens.push(link.row);

    const notReady = await setupService.completeSetup({}, { token: link.token, name: 'Owner', password: GOOD_PASSWORD });
    assert.equal(notReady.error.code, 'INDEXES_NOT_READY', 'User inserts refuse until the unique gates exist (A7).');
    assert.equal(authModule.AUTH_ERROR_HTTP_STATUS.INDEXES_NOT_READY, 503);

    await _indexesReady();
    const inspected = await setupService.inspectSetupToken({}, { token: link.token });
    assert.equal(inspected.status, true);
    assert.deepEqual(Object.keys(inspected.data).sort(), ['email', 'expires_at', 'name']);

    const weak = await setupService.completeSetup({}, { token: link.token, name: 'Owner', password: 'short' });
    assert.equal(weak.error.code, 'PASSWORD_POLICY');
    assert.equal(weak.error.policy_code, 'TOO_SHORT');
    assert.equal(world.calls.some((call) => call.name === 'claimSetupToken'), false, 'A policy refusal must not spend the link.');
    assert.equal(world.tokens[0].used_at, null);

    const done = await setupService.completeSetup({}, { token: link.token, name: 'Owner', password: GOOD_PASSWORD });
    assert.equal(done.status, true, done.msg);
});


/* ==========================================================================
 *  3. Dead links say what is wrong with them (A14) — and never 401
 * ========================================================================== */

test('dead links: TOKEN_EXPIRED, TOKEN_USED, INVITE_REVOKED and TOKEN_INVALID are told apart, all 400, and a malformed token reads nothing', async () => {
    const world = _installWorld();
    const expired = _linkToken({ purpose: TOKEN_PURPOSES.PASSWORD_RESET, user_id: MEMBER_ID, email: 'member@example.com', expires_at: new Date(Date.now() - MINUTE_MS) });
    const used = _linkToken({ purpose: TOKEN_PURPOSES.PASSWORD_RESET, user_id: MEMBER_ID, email: 'member@example.com', used_at: new Date() });
    world.tokens.push(expired.row, used.row);

    const _reset = (token) => passwordService.resetPassword({}, { token: token, password: GOOD_PASSWORD });
    assert.equal((await _reset(expired.token)).error.code, 'TOKEN_EXPIRED');
    assert.equal((await _reset(used.token)).error.code, 'TOKEN_USED');
    assert.equal((await _reset(crypto.randomBytes(32).toString('base64url'))).error.code, 'TOKEN_INVALID');

    world.calls.length = 0;
    for (const malformed of ['short', 'A'.repeat(44), { $ne: null }, ['A'.repeat(43)], undefined]) {
        assert.equal((await _reset(malformed)).error.code, 'TOKEN_INVALID');
    }
    assert.deepEqual(world.calls, [], 'A malformed token must be refused before any query (I1).');

    const revokedInvite = _inviteRow({ revoked_at: new Date(Date.now() - MINUTE_MS), revoked_reason: 'MANUAL' });
    world.invites.push(revokedInvite.row);
    const revoked = await inviteService.inspectInvite({}, { token: revokedInvite.token });
    assert.equal(revoked.error.code, 'INVITE_REVOKED');

    for (const code of ['TOKEN_EXPIRED', 'TOKEN_USED', 'INVITE_REVOKED', 'TOKEN_INVALID']) {
        assert.equal(authModule.AUTH_ERROR_HTTP_STATUS[code], 400, `${code} must be 400 — a public token endpoint never answers 401.`);
    }
});


/* ==========================================================================
 *  4. Password reset — epoch bump, sessions revoked, single use
 * ========================================================================== */

test('password reset: sets the hash, bumps the epoch, revokes every session and other reset links, notifies — and the link works once', async () => {
    const world = _installWorld();
    world.users.set(MEMBER_ID, _user({ password_hash: await bcrypt.hash('old passphrase here', 4) }));
    world.sessions.set('s1', { _id: 's1', user_id: MEMBER_ID, epoch: 0, revoked_at: null, expires_at: new Date(Date.now() + 60 * MINUTE_MS) });
    world.sessions.set('s2', { _id: 's2', user_id: MEMBER_ID, epoch: 0, revoked_at: null, expires_at: new Date(Date.now() + 60 * MINUTE_MS) });
    const link = _linkToken({ purpose: TOKEN_PURPOSES.PASSWORD_RESET, user_id: MEMBER_ID, email: 'member@example.com', name: null });
    const sibling = _linkToken({ purpose: TOKEN_PURPOSES.PASSWORD_RESET, user_id: MEMBER_ID, email: 'member@example.com', name: null });
    world.tokens.push(link.row, sibling.row);

    const result = await passwordService.resetPassword({}, { token: link.token, password: GOOD_PASSWORD, request_ip: '203.0.113.9' });
    assert.equal(result.status, true, result.msg);
    assert.deepEqual(result.data, { password_reset: true }, 'A reset never signs anyone in.');

    const user = world.users.get(MEMBER_ID);
    assert.equal(user.session_epoch, 1, 'Every existing session must die by epoch (A4).');
    assert.equal(await bcrypt.compare(GOOD_PASSWORD.normalize('NFC'), user.password_hash), true);
    const updateCall = world.calls.find((call) => call.name === 'updatePassword');
    assert.equal(updateCall.args[0].changed_before.getTime(), link.row.createdAt.getTime(), 'The write is a CAS on password_changed_at < the link\'s issue time.');

    assert.deepEqual(Array.from(world.sessions.values()).map((row) => row.revoked_reason), ['PASSWORD_RESET', 'PASSWORD_RESET']);
    assert.ok(sibling.row.revoked_at, 'Other live reset links for the account are revoked.');

    await _drain();
    assert.equal(world.mails.length, 1);
    assert.equal(world.mails[0].template, mailModule.EMAIL_TEMPLATES.PASSWORD_CHANGED);
    assert.equal(world.mails[0].trigger, mailModule.MAIL_TRIGGERS.SECURITY);
    assert.equal(world.mails[0].to, 'member@example.com');

    const reuse = await passwordService.resetPassword({}, { token: link.token, password: 'another long passphrase' });
    assert.equal(reuse.error.code, 'TOKEN_USED', 'A reset link is single-use.');
    _assertLogsClean(world, [link.token, GOOD_PASSWORD, link.row.token_hash]);
});

test('password reset: refused for a link older than the last password change, a disabled account, or a re-addressed account', async () => {
    const world = _installWorld();
    const _attempt = async (userOverrides, tokenOverrides) => {
        world.users.set(MEMBER_ID, _user(Object.assign({ password_hash: '$2b$04$' + 'a'.repeat(53) }, userOverrides)));
        const link = _linkToken(Object.assign({ purpose: TOKEN_PURPOSES.PASSWORD_RESET, user_id: MEMBER_ID, email: 'member@example.com' }, tokenOverrides));
        world.tokens.push(link.row);
        return passwordService.resetPassword({}, { token: link.token, password: GOOD_PASSWORD });
    };
    assert.equal((await _attempt({ password_changed_at: new Date() })).error.code, 'TOKEN_INVALID', 'The password changed after the link was issued.');
    assert.equal((await _attempt({ status: 'disabled' })).error.code, 'TOKEN_INVALID');
    assert.equal((await _attempt({ email: 'moved@example.com' })).error.code, 'TOKEN_INVALID');
    assert.equal(world.calls.some((call) => call.name === 'spendToken'), false, 'None of these may spend the link.');
    assert.equal(world.calls.some((call) => call.name === 'updatePassword'), false);
});

test('forgot password: an unknown address and a real one answer identically, with NO repository call before the response', async () => {
    const world = _installWorld();
    world.users.set(MEMBER_ID, _user());
    _stub(userRepository, 'claimResetSendSlot', async () => _withoutHash(world.users.get(MEMBER_ID)));

    world.calls.length = 0;
    const real = await passwordService.requestPasswordReset({}, { email: 'member@example.com' });
    const realCalls = world.calls.length;
    await _drain();
    world.calls.length = 0;
    const unknown = await passwordService.requestPasswordReset({}, { email: 'nobody@example.com' });
    const unknownCalls = world.calls.length;
    await _drain();

    assert.deepEqual(real, unknown);
    assert.equal(realCalls, 0);
    assert.equal(unknownCalls, 0);
    assert.equal(world.mails.length, 1, 'Only the real, active account gets a reset email.');
    assert.equal(world.mails[0].template, mailModule.EMAIL_TEMPLATES.PASSWORD_RESET);
    assert.match(world.mails[0].vars.link, /^https:\/\/analytics\.example\.com\/reset-password#token=[A-Za-z0-9_-]{43}$/);
});


test(' forgot password: a link the mail caps refuse to send does NOT kill the working link the user already has', async () => {
    // The reproduced attack: while the caps were spent, a forgot-password request revoked the
    // victim's live link, then failed to send the replacement — leaving no working link at all.
    const world = _installWorld();
    world.users.set(MEMBER_ID, _user({ password_hash: await bcrypt.hash('old passphrase here', 4) }));
    _stub(userRepository, 'claimResetSendSlot', async () => _withoutHash(world.users.get(MEMBER_ID)));
    const earlier = _linkToken({ purpose: TOKEN_PURPOSES.PASSWORD_RESET, user_id: MEMBER_ID, email: 'member@example.com', name: null });
    world.tokens.push(earlier.row);

    for (const refused of ['CAP_REACHED', 'NOT_CONFIGURED', 'FAILED']) {
        world.mail_outcome = { status: false, data: { accepted: false, status: refused }, error: { code: refused }, msg: 'not sent' };
        const outcome = await passwordService.processPasswordResetRequest({ email: 'member@example.com', ip: null });
        assert.equal(outcome, 'LINK_ISSUED');
        assert.equal(earlier.row.revoked_at, null, `A ${refused} send revoked the link the user already had.`);
        const undelivered = world.tokens.at(-1);
        assert.notEqual(undelivered._id, earlier.row._id);
        assert.ok(undelivered.revoked_at, `The ${refused} (undelivered) link was left live.`);
        const row = world.audits.filter((entry) => entry.action === 'PASSWORD_RESET_REQUESTED').at(-1);
        assert.deepEqual(row.details, { outcome: 'LINK_ISSUED', email_status: refused }, 'The audit row must say what the mail server did, not claim SENT.');
    }

    const reset = await passwordService.resetPassword({}, { token: earlier.token, password: GOOD_PASSWORD });
    assert.equal(reset.status, true, `The earlier link no longer works: ${reset.msg}`);
});

test('forgot password: a link that WAS handed to the mail server retires the earlier ones', async () => {
    const world = _installWorld();
    world.users.set(MEMBER_ID, _user({ password_hash: await bcrypt.hash('old passphrase here', 4) }));
    _stub(userRepository, 'claimResetSendSlot', async () => _withoutHash(world.users.get(MEMBER_ID)));
    const earlier = _linkToken({ purpose: TOKEN_PURPOSES.PASSWORD_RESET, user_id: MEMBER_ID, email: 'member@example.com', name: null });
    world.tokens.push(earlier.row);

    for (const delivered of ['SENT', 'UNCONFIRMED']) {
        earlier.row.revoked_at = null;
        world.mail_outcome = delivered === 'SENT'
            ? { status: true, data: { accepted: true, status: 'SENT' }, error: {}, msg: 'ok' }
            : { status: false, data: { accepted: false, status: 'UNCONFIRMED' }, error: { code: 'UNCONFIRMED' }, msg: 'may still arrive' };
        await passwordService.processPasswordResetRequest({ email: 'member@example.com', ip: null });
        assert.ok(earlier.row.revoked_at, `After a ${delivered} send the earlier link must be revoked.`);
        assert.equal(world.tokens.at(-1).revoked_at, null, `The ${delivered} link itself must stay live.`);
    }
    const refused = await passwordService.resetPassword({}, { token: earlier.token, password: GOOD_PASSWORD });
    assert.equal(refused.error.code, 'TOKEN_INVALID');
});

test('forgot password: a CLI reset link survives an anonymous request the mail module cannot send (NOT_CONFIGURED)', async () => {
    const world = _installWorld();
    world.users.set(MEMBER_ID, _user({ password_hash: await bcrypt.hash('old passphrase here', 4) }));
    _stub(userRepository, 'claimResetSendSlot', async () => _withoutHash(world.users.get(MEMBER_ID)));
    const recoveryService = require(path.join(AUTH, 'services', 'recovery.service.ts'));

    const cli = await recoveryService.issueResetLinkForCli({}, { email: 'member@example.com' });
    assert.equal(cli.status, true, cli.msg);
    const cliToken = /#token=([A-Za-z0-9_-]{43})$/.exec(cli.data.link)[1];

    world.mail_outcome = { status: false, data: { accepted: false, status: 'NOT_CONFIGURED' }, error: { code: 'NOT_CONFIGURED' }, msg: 'no mail' };
    await passwordService.processPasswordResetRequest({ email: 'member@example.com', ip: null });

    const reset = await passwordService.resetPassword({}, { token: cliToken, password: GOOD_PASSWORD });
    assert.equal(reset.status, true, `The operator's CLI link was killed by a stranger's forgot-password request: ${reset.msg}`);
});

test('setup request: the audit row is written AFTER the send and carries the mail server\'s answer, never a premature SENT', async () => {
    const world = _installWorld();
    world.mail_outcome = { status: false, data: { accepted: false, status: 'FAILED' }, error: { code: 'FAILED' }, msg: 'refused' };
    await setupService.requestSetup({}, { email: 'owner@example.com', name: 'Owner' });
    await _drain();
    const sendAt = world.calls.findIndex((call) => call.name === 'sendTemplatedEmail');
    const auditAt = world.calls.findIndex((call) => call.name === 'insertAuditEvent');
    assert.ok(sendAt >= 0 && auditAt > sendAt, 'The audit row was written before the send it describes.');
    const row = world.audits.find((entry) => entry.action === 'SETUP_REQUESTED');
    assert.deepEqual(row.details, { allowed: true, outcome: 'LINK_ISSUED', email_status: 'FAILED' });
});


/* ==========================================================================
 *  5. Login — one message, dummy compare, ids-only token
 * ========================================================================== */

test('login: unknown email, wrong password and disabled account answer identically, and an unknown email still runs a bcrypt compare', async () => {
    const world = _installWorld();
    const hash = await bcrypt.hash(GOOD_PASSWORD, 4);
    world.users.set(MEMBER_ID, _user({ password_hash: hash }));
    world.users.set(ADMIN_ID, _user({ _id: ADMIN_ID, email: 'gone@example.com', password_hash: hash, status: 'disabled' }));

    const compared = [];
    const realCompare = bcrypt.compare;
    _stub(bcrypt, 'compare', (candidate, stored) => {
        compared.push(stored);
        return realCompare(candidate, stored);
    });

    const unknown = await sessionService.login({}, { email: 'nobody@example.com', password: GOOD_PASSWORD });
    const wrong = await sessionService.login({}, { email: 'member@example.com', password: 'not the right passphrase' });
    const disabled = await sessionService.login({}, { email: 'gone@example.com', password: GOOD_PASSWORD });

    assert.deepEqual(unknown, wrong);
    assert.deepEqual(wrong, disabled, 'A disabled account must not be distinguishable from a wrong password.');
    assert.equal(unknown.error.code, 'INVALID_CREDENTIALS');
    assert.equal(authModule.AUTH_ERROR_HTTP_STATUS.INVALID_CREDENTIALS, 401);

    assert.equal(compared.length, 3, 'Every attempt — including the unknown address — must pay one bcrypt compare.');
    assert.match(compared[0], /^\$2[aby]\$04\$/, 'The unknown-address compare runs against a dummy hash at the CONFIGURED cost.');
    assert.equal(world.sessions.size, 0);
    assert.deepEqual(world.audits.map((row) => row.details.reason), ['UNKNOWN_EMAIL', 'WRONG_PASSWORD', 'USER_DISABLED'], 'The audit row may be specific; the answer may not.');
    _assertLogsClean(world, [GOOD_PASSWORD, 'not the right passphrase']);
});

test('login: success issues an HS256 token carrying ids only (sub, sid, aud) and a session row with the user\'s epoch', async () => {
    const world = _installWorld();
    world.users.set(MEMBER_ID, _user({ password_hash: await bcrypt.hash(GOOD_PASSWORD, 4), session_epoch: 7 }));

    const result = await sessionService.login({}, { email: ' Member@Example.com ', password: GOOD_PASSWORD, request_ip: '203.0.113.9', user_agent: 'test' });
    assert.equal(result.status, true, result.msg);
    assert.deepEqual(Object.keys(result.data).sort(), ['device_token', 'email', 'expires_at', 'expires_in_seconds', 'token', 'user_id']);

    const decoded = jwt.verify(result.data.token, sessionService.sessionSigningKey(), { algorithms: ['HS256'], audience: JWT_AUDIENCE });
    assert.deepEqual(Object.keys(decoded).sort(), ['aud', 'exp', 'iat', 'sid', 'sub'], 'Permissions, email and role are NEVER in the token (I4).');
    assert.equal(decoded.sub, MEMBER_ID);
    const session = world.sessions.get(decoded.sid);
    assert.ok(session, 'The sid names the session row login created.');
    assert.equal(session.epoch, 7, 'The session carries the epoch read with the password check.');

    // The device token is bound to the email that signed in, names nobody, and proves nothing for another account.
    const device = result.data.device_token;
    assert.match(device, /^ld1\.[A-Za-z0-9_-]{22}\.\d+\.[A-Za-z0-9_-]{43}$/);
    assert.equal(device.toLowerCase().includes('member'), false, 'A device token must not carry the email.');
    assert.equal(typeof authModule.verifyLoginDeviceToken(device, 'member@example.com'), 'string');
    assert.equal(authModule.verifyLoginDeviceToken(device, 'owner@example.com'), null);
});

test(' rollback: a session token this build signs is REFUSED by the single-operator build\'s check (raw JWT_SECRET)', async () => {
    // The old build's verifyToken was `jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] })` and
    // nothing else — no session row, no user row — so it accepted every token this build issued, a
    // Viewer's and a disabled account's included, as the one full operator. Reproduced before the
    // signing key was derived; this is the regression guard for it.
    const world = _installWorld();
    world.users.set(MEMBER_ID, _user({ password_hash: await bcrypt.hash(GOOD_PASSWORD, 4), role_key: 'viewer' }));
    const result = await sessionService.login({}, { email: 'member@example.com', password: GOOD_PASSWORD });
    assert.equal(result.status, true, result.msg);

    const singleOperatorBuildVerify = (token) => jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    assert.throws(() => singleOperatorBuildVerify(result.data.token), /invalid signature/, 'A rolled-back build would accept this Viewer\'s token as the full operator.');
    assert.ok(jwt.verify(result.data.token, sessionService.sessionSigningKey(), { algorithms: ['HS256'], audience: JWT_AUDIENCE }), 'Control: this build verifies its own token.');
});


/* ==========================================================================
 *  6. The session-epoch race (A4) and the guard's 401/503 split (A9)
 * ========================================================================== */

test('epoch race: login reads the user → a reset commits → the session is inserted ⇒ that token is REFUSED (401)', async () => {
    const world = _installWorld();
    world.users.set(MEMBER_ID, _user({ password_hash: await bcrypt.hash(GOOD_PASSWORD, 4), session_epoch: 0 }));
    world.install = { _id: 'install', setup_completed_at: new Date(), owner_user_id: OWNER_ID, setup_token_id: null };

    // The reset lands AFTER login's user read and BEFORE its session insert.
    world.hooks.insertSession = async () => {
        world.users.get(MEMBER_ID).session_epoch += 1;
    };
    const login = await sessionService.login({}, { email: 'member@example.com', password: GOOD_PASSWORD });
    assert.equal(login.status, true, 'Login itself succeeds — its credential check was valid when it ran.');

    const guarded = await _authenticate(login.data.token);
    assert.equal(guarded.nextCalled, false, 'A session minted under a superseded epoch must not be admitted.');
    assert.equal(guarded.res.statusCode, 401);
    assert.match(guarded.res.body.msg, /^Not authenticated\./);

    const loaded = await principalService.loadPrincipal({}, { user_id: MEMBER_ID, session_id: jwt.decode(login.data.token).sid });
    assert.equal(loaded.error.code, 'SESSION_STALE');

    // Control: without the race, the same flow is admitted.
    delete world.hooks.insertSession;
    const clean = await sessionService.login({}, { email: 'member@example.com', password: GOOD_PASSWORD });
    const admitted = await _authenticate(clean.data.token);
    assert.equal(admitted.nextCalled, true, 'The control login was refused — the race assertion above proves nothing.');
    assert.ok(Object.isFrozen(admitted.req.auth));
    assert.equal(admitted.req.user_id, MEMBER_ID);
});

test('authenticate: no header ⇒ 401 with no read; auth failures ⇒ 401; a datastore failure ⇒ 503 (never a sign-out)', async () => {
    const world = _installWorld();
    world.users.set(MEMBER_ID, _user());
    const sessionId = _newId();
    world.sessions.set(sessionId, { _id: sessionId, user_id: MEMBER_ID, epoch: 0, revoked_at: null, expires_at: new Date(Date.now() + 60 * MINUTE_MS) });
    const token = jwt.sign({ sid: sessionId }, sessionService.sessionSigningKey(), { algorithm: 'HS256', subject: MEMBER_ID, audience: JWT_AUDIENCE, expiresIn: 3600 });

    const none = await _authenticate(null);
    assert.equal(none.res.statusCode, 401);
    assert.deepEqual(world.calls, [], 'A request without a token must not reach the datastore.');

    const ok = await _authenticate(token);
    assert.equal(ok.nextCalled, true);

    world.sessions.get(sessionId).revoked_at = new Date();
    const revoked = await _authenticate(token);
    assert.equal(revoked.res.statusCode, 401);
    world.sessions.get(sessionId).revoked_at = null;

    world.users.get(MEMBER_ID).status = 'disabled';
    const disabled = await _authenticate(token);
    assert.equal(disabled.res.statusCode, 401);
    world.users.get(MEMBER_ID).status = 'active';

    _stub(authSessionRepository, 'findById', async () => {
        throw Object.assign(new Error('server selection timed out'), { name: 'MongoServerSelectionError' });
    });
    const down = await _authenticate(token);
    assert.equal(down.nextCalled, false);
    assert.equal(down.res.statusCode, 503, 'A datastore outage must not answer 401 — the dashboard signs out on 401.');
    assert.deepEqual(down.res.body.error, { code: 'DATASTORE_ERROR' });

    // A loader that answers for someone other than the token's subject is refused.
    _stub(authModule, 'loadPrincipal', async () => ({
        status: true,
        data: { principal: { user_id: ADMIN_ID, email: 'x@example.com', name: 'X', is_owner: false, role_key: 'viewer', role_label: 'Viewer', custom_role_id: null, permissions: [] }, session: {} },
        error: {},
        msg: ''
    }));
    const mismatched = await _authenticate(token);
    assert.equal(mismatched.res.statusCode, 401);
    assert.equal(mismatched.nextCalled, false);
});


/* ==========================================================================
 *  7. Invitations — accept rollback, accept vs revoke, the inviter check
 * ========================================================================== */

/** An invite row and its token. */
function _inviteRow(overrides) {
    const token = crypto.randomBytes(32).toString('base64url');
    const row = Object.assign({
        _id: _newId(),
        email: 'new@example.com',
        role_key: 'viewer',
        custom_role_id: null,
        invited_by_user_id: OWNER_ID,
        token_hash: tokenHelper.hashToken(token),
        expires_at: new Date(Date.now() + 60 * MINUTE_MS),
        accepted_at: null,
        accepted_user_id: null,
        revoked_at: null,
        revoked_reason: null,
        createdAt: new Date(Date.now() - MINUTE_MS)
    }, overrides || {});
    return { token, row };
}

/** A locked install whose owner is OWNER_ID, and the owner's row. */
const _lockedWorld = () => {
    const world = _installWorld();
    world.install = { _id: 'install', setup_completed_at: new Date(), owner_user_id: OWNER_ID, setup_token_id: null };
    world.users.set(OWNER_ID, _user({ _id: OWNER_ID, email: 'owner@example.com', name: 'Owner', role_key: 'admin', created_via: 'setup' }));
    return world;
};

test('invite accept: when the accept CAS loses, the user row it inserted is DELETED and the answer names why', async () => {
    const world = _lockedWorld();
    await _indexesReady();
    const invite = _inviteRow();
    world.invites.push(invite.row);

    // Between the insert and the CAS, the invite is revoked.
    world.hooks.insertUser = async () => {
        invite.row.revoked_at = new Date();
        invite.row.revoked_reason = 'MANUAL';
    };
    const result = await inviteService.acceptInvite({}, { token: invite.token, name: 'New Person', password: GOOD_PASSWORD });

    assert.equal(result.status, false);
    assert.equal(result.error.code, 'INVITE_REVOKED');
    const inserted = world.calls.find((call) => call.name === 'insertUser').args[0];
    const deleted = world.calls.find((call) => call.name === 'deleteUnacceptedInviteUser');
    assert.ok(deleted, 'The orphaned user row must be removed.');
    assert.equal(String(deleted.args[0].user_id), String(inserted._id), 'The delete targets exactly the row this request inserted.');
    assert.equal(world.users.has(String(inserted._id)), false);
    assert.equal(world.users.size, 1, 'Only the owner remains.');
});

test('invite accept vs revoke: whichever CAS lands first wins, and the other loses cleanly — in BOTH orders', async () => {
    // ── Order 1: the revoke lands between accept's insert and accept's CAS ──
    {
        const world = _lockedWorld();
        await _indexesReady();
        const invite = _inviteRow();
        world.invites.push(invite.row);
        let revokeResult = null;
        world.hooks.insertUser = async () => {
            revokeResult = await inviteService.revokeInvite({ user_id: OWNER_ID }, { invite_id: invite.row._id });
        };
        const acceptResult = await inviteService.acceptInvite({}, { token: invite.token, name: 'New Person', password: GOOD_PASSWORD });
        assert.equal(revokeResult.status, true, 'The revoke landed first and must win.');
        assert.equal(acceptResult.status, false);
        assert.equal(acceptResult.error.code, 'INVITE_REVOKED');
        assert.equal(invite.row.accepted_at, null);
        assert.equal(world.users.size, 1, 'No member was left behind by the losing accept.');
        _restoreAll();
        installStateService.resetInstallStateServiceState();
    }

    // ── Order 2: the revoke READ the invite as pending, then the accept completed, then the revoke's CAS ──
    {
        const world = _lockedWorld();
        await _indexesReady();
        const invite = _inviteRow();
        world.invites.push(invite.row);
        let acceptResult = null;
        const pendingSnapshot = _withoutHash(invite.row);
        _stub(inviteRepository, 'findById', async () => {
            acceptResult = await inviteService.acceptInvite({}, { token: invite.token, name: 'New Person', password: GOOD_PASSWORD });
            return pendingSnapshot;
        });
        const revokeResult = await inviteService.revokeInvite({ user_id: OWNER_ID }, { invite_id: invite.row._id });
        assert.equal(acceptResult.status, true, 'The accept landed first and must win.');
        assert.equal(revokeResult.status, false);
        assert.equal(revokeResult.error.code, 'INVITE_NOT_PENDING');
        assert.equal(authModule.AUTH_ERROR_HTTP_STATUS.INVITE_NOT_PENDING, 409);
        assert.equal(invite.row.revoked_at, null, 'The revoke must not overwrite an accepted invite.');
        assert.equal(world.users.size, 2);
    }
});

test('invite accept: a DISABLED inviter kills the invite (revoked, INVITER_DISABLED) and no account is created', async () => {
    const world = _lockedWorld();
    await _indexesReady();
    world.users.set(ADMIN_ID, _user({ _id: ADMIN_ID, email: 'admin@example.com', name: 'Admin', role_key: 'admin', status: 'disabled' }));
    const invite = _inviteRow({ invited_by_user_id: ADMIN_ID });
    world.invites.push(invite.row);

    const result = await inviteService.acceptInvite({}, { token: invite.token, name: 'New Person', password: GOOD_PASSWORD });
    assert.equal(result.error.code, 'TOKEN_INVALID');
    assert.equal(invite.row.revoked_reason, 'INVITER_DISABLED');
    assert.ok(invite.row.revoked_at);
    assert.equal(world.calls.some((call) => call.name === 'insertUser'), false);
    assert.equal(world.audits.some((row) => row.action === 'INVITE_REVOKED' && row.details.reason === 'INVITER_DISABLED'), true);

    // The next attempt with the same link is told plainly that the invitation was withdrawn.
    const again = await inviteService.acceptInvite({}, { token: invite.token, name: 'New Person', password: GOOD_PASSWORD });
    assert.equal(again.error.code, 'INVITE_REVOKED');
});

test('invite accept: an inviter who may no longer grant the role kills the invite (INVITER_NO_LONGER_PERMITTED)', async () => {
    const world = _lockedWorld();
    await _indexesReady();
    // An active admin who invited someone as ADMIN — equal sets, which the rule refuses.
    world.users.set(ADMIN_ID, _user({ _id: ADMIN_ID, email: 'admin@example.com', name: 'Admin', role_key: 'admin' }));
    const invite = _inviteRow({ invited_by_user_id: ADMIN_ID, role_key: 'admin' });
    world.invites.push(invite.row);

    const result = await inviteService.acceptInvite({}, { token: invite.token, name: 'New Person', password: GOOD_PASSWORD });
    assert.equal(result.error.code, 'TOKEN_INVALID');
    assert.equal(invite.row.revoked_reason, 'INVITER_NO_LONGER_PERMITTED');
    assert.equal(world.users.size, 2, 'No account is created.');
});

test('invite accept: success creates the member with the invite\'s role and never signs anyone in', async () => {
    const world = _lockedWorld();
    await _indexesReady();
    const invite = _inviteRow({ role_key: 'analyst' });
    world.invites.push(invite.row);

    const result = await inviteService.acceptInvite({}, { token: invite.token, name: 'New Person', password: GOOD_PASSWORD });
    assert.equal(result.status, true, result.msg);
    assert.deepEqual(result.data, { accepted: true });
    const member = Array.from(world.users.values()).find((user) => user.email === 'new@example.com');
    assert.equal(member.role_key, 'analyst');
    assert.equal(member.created_via, 'invite');
    assert.equal(String(member.invited_by_user_id), OWNER_ID);
    assert.equal(String(invite.row.accepted_user_id), String(member._id));
    assert.equal(world.sessions.size, 0, 'Accepting an invitation never creates a session.');
    _assertLogsClean(world, [invite.token, GOOD_PASSWORD, invite.row.token_hash]);
});


/* ==========================================================================
 *  8. Administration — the actor is re-read, the rule applies, disable cascades
 * ========================================================================== */

test('disable: kills the target\'s sessions by epoch, marks them revoked, and revokes the invitations the target sent (INVITER_DISABLED)', async () => {
    const world = _lockedWorld();
    world.users.set(MEMBER_ID, _user({ role_key: 'analyst', email: 'analyst@example.com' }));
    world.sessions.set('s1', { _id: 's1', user_id: MEMBER_ID, epoch: 0, revoked_at: null, expires_at: new Date(Date.now() + 60 * MINUTE_MS) });
    const sent = _inviteRow({ invited_by_user_id: MEMBER_ID, email: 'friend@example.com' });
    const unrelated = _inviteRow({ invited_by_user_id: OWNER_ID, email: 'other@example.com' });
    world.invites.push(sent.row, unrelated.row);

    const result = await userService.disableUser({ user_id: OWNER_ID }, { user_id: MEMBER_ID });
    assert.equal(result.status, true, result.msg);
    assert.equal(world.users.get(MEMBER_ID).status, 'disabled');
    assert.equal(world.users.get(MEMBER_ID).session_epoch, 1, 'Disable bumps the epoch in the same update (A4).');
    assert.equal(world.sessions.get('s1').revoked_reason, 'USER_DISABLED');
    assert.equal(sent.row.revoked_reason, 'INVITER_DISABLED', 'Invitations a disabled user sent must die with their access.');
    assert.equal(unrelated.row.revoked_at, null, 'Only the disabled user\'s own invitations are revoked.');
    assert.equal(result.data.invites_revoked, 1);

    const again = await userService.disableUser({ user_id: OWNER_ID }, { user_id: MEMBER_ID });
    assert.equal(again.error.code, 'USER_STATUS_CONFLICT');
    assert.equal(authModule.AUTH_ERROR_HTTP_STATUS.USER_STATUS_CONFLICT, 409);
});

test('management rule in the services: nobody disables the owner, themselves, or an equal — and nothing is written when refused', async () => {
    const world = _lockedWorld();
    world.users.set(ADMIN_ID, _user({ _id: ADMIN_ID, role_key: 'admin', email: 'admin@example.com' }));
    world.users.set(MEMBER_ID, _user({ role_key: 'admin', email: 'admin2@example.com' }));

    const onOwner = await userService.disableUser({ user_id: ADMIN_ID }, { user_id: OWNER_ID });
    assert.deepEqual([onOwner.error.code, onOwner.error.reason], ['FORBIDDEN', 'TARGET_IS_OWNER']);
    const onSelf = await userService.disableUser({ user_id: OWNER_ID }, { user_id: OWNER_ID });
    assert.deepEqual([onSelf.error.code, onSelf.error.reason], ['FORBIDDEN', 'SELF']);
    const onEqual = await userService.disableUser({ user_id: ADMIN_ID }, { user_id: MEMBER_ID });
    assert.deepEqual([onEqual.error.code, onEqual.error.reason], ['FORBIDDEN', 'TARGET_NOT_BELOW_ACTOR'], 'Two admins must not be able to disable each other.');
    assert.equal(world.calls.some((call) => call.name === 'disableUser'), false, 'A refused action must not reach the write.');

    const malformed = await userService.disableUser({ user_id: OWNER_ID }, { user_id: 'probe-value' });
    assert.equal(malformed.error.code, 'NOT_FOUND', 'A malformed id is a 404, never a CastError 500 (A2).');
});

test('admin services re-load the ACTOR from the database: a demoted actor is refused, and an unreadable actor is 503 — never 401 or 403', async () => {
    const world = _lockedWorld();
    // The session said admin; the row now says viewer. The service must believe the row.
    world.users.set(ADMIN_ID, _user({ _id: ADMIN_ID, role_key: 'viewer', email: 'demoted@example.com' }));
    world.users.set(MEMBER_ID, _user({ role_key: 'viewer', email: 'viewer@example.com' }));
    const demoted = await userService.disableUser({ user_id: ADMIN_ID }, { user_id: MEMBER_ID });
    assert.equal(demoted.error.code, 'FORBIDDEN');
    assert.equal(world.users.get(MEMBER_ID).status, 'active');

    _stub(userRepository, 'findById', async () => {
        throw Object.assign(new Error('connection reset'), { name: 'MongoNetworkError' });
    });
    const unreadable = await userService.disableUser({ user_id: OWNER_ID }, { user_id: MEMBER_ID });
    assert.equal(unreadable.error.code, 'DATASTORE_ERROR');
    assert.equal(authModule.AUTH_ERROR_HTTP_STATUS.DATASTORE_ERROR, 503);
});


/* ==========================================================================
 *  9. The CAS filters the fakes assume — read off the real repositories
 * ========================================================================== */

/**
 * Stubs `Model.findOneAndUpdate`, capturing the filter and update, and answering with `doc`.
 *
 * @returns {Object} The capture: `{ filter, update, options }`.
 */
const _captureFindOneAndUpdate = (model, doc) => {
    const captured = {};
    _stub(model, 'findOneAndUpdate', (filter, update, options) => {
        Object.assign(captured, { filter, update, options });
        const query = {
            select() {
                return query;
            },
            lean: async () => (typeof doc === 'function' ? doc(filter) : doc)
        };
        return query;
    });
    return captured;
};

test('CAS filters: the setup lock, the setup claim, the reset spend, the invite accept and revoke match only an untouched row', async () => {
    const { SystemStateModel, AuthTokenModel, InviteModel, UserModel } = modelsRepository;
    const now = new Date();
    const id = 'a'.repeat(24);
    const hash = 'b'.repeat(64);

    const lock = _captureFindOneAndUpdate(SystemStateModel, { _id: 'install', setup_completed_at: now });
    await systemStateRepository.lockSetup({ owner_user_id: id, setup_token_id: id, now: now });
    assert.deepEqual(lock.filter, { _id: 'install', setup_completed_at: null });
    assert.equal(lock.options.returnDocument, 'after', 'A3: returnDocument, never new: true.');

    const claim = _captureFindOneAndUpdate(AuthTokenModel, null);
    await authTokenRepository.claimSetupToken({ token_id: id, name: 'Owner', password_hash: '$2b$04$x', now: now });
    assert.deepEqual(claim.filter, { _id: id, purpose: 'SETUP_VERIFY', used_at: null, revoked_at: null, expires_at: { $gt: now } });

    const spend = _captureFindOneAndUpdate(AuthTokenModel, null);
    await authTokenRepository.spendToken({ token_id: id, purpose: 'PASSWORD_RESET', now: now });
    assert.deepEqual(spend.filter, { _id: id, purpose: 'PASSWORD_RESET', used_at: null, revoked_at: null, expires_at: { $gt: now } });

    const accept = _captureFindOneAndUpdate(InviteModel, null);
    await inviteRepository.acceptInvite({ invite_id: id, token_hash: hash, accepted_user_id: id, now: now });
    assert.deepEqual(accept.filter, { _id: id, token_hash: hash, accepted_at: null, revoked_at: null, expires_at: { $gt: now } }, 'A13: the accept CAS includes token_hash.');

    const revoke = _captureFindOneAndUpdate(InviteModel, null);
    await inviteRepository.revokeInvite({ invite_id: id, actor_user_id: null, reason: 'MANUAL', now: now });
    assert.deepEqual(revoke.filter, { _id: id, accepted_at: null, revoked_at: null });

    // A4: the password write bumps the epoch in the SAME update.
    const password = _captureFindOneAndUpdate(UserModel, null);
    await userRepository.updatePassword({ user_id: id, password_hash: '$2b$04$y', now: now, changed_before: now });
    assert.deepEqual(password.update.$inc, { session_epoch: 1 });
    assert.equal(password.update.$set.password_hash, '$2b$04$y');
    assert.equal(password.filter.status, 'active');
});

test('CAS belt and braces (I8): a repository returns null when the matched row is not the one asked for', async () => {
    const { SystemStateModel, InviteModel } = modelsRepository;
    const now = new Date();
    const id = 'a'.repeat(24);
    const hash = 'b'.repeat(64);

    _captureFindOneAndUpdate(SystemStateModel, { _id: 'some-other-doc', setup_completed_at: now });
    assert.equal(await systemStateRepository.lockSetup({ owner_user_id: id, setup_token_id: id, now: now }), null);

    // strictQuery can strip a filter path and match the first document: the hash is compared in code.
    _captureFindOneAndUpdate(InviteModel, { _id: id, token_hash: 'c'.repeat(64), accepted_at: now });
    assert.equal(await inviteRepository.acceptInvite({ invite_id: id, token_hash: hash, accepted_user_id: id, now: now }), null);

    // And the hash never leaves the repository on the matching path.
    _captureFindOneAndUpdate(InviteModel, { _id: id, token_hash: hash, accepted_at: now, email: 'new@example.com' });
    const accepted = await inviteRepository.acceptInvite({ invite_id: id, token_hash: hash, accepted_user_id: id, now: now });
    assert.ok(accepted);
    assert.equal('token_hash' in accepted, false);
});

test('services never reject: hostile inputs resolve to an envelope, never throw', async () => {
    _installWorld();
    const hostile = [undefined, null, 42, 'string', [], { email: { $gt: '' } }, { token: { $ne: null }, password: ['x'] }, Object.create(null)];
    const services = [
        (body) => setupService.requestSetup({}, body),
        (body) => setupService.inspectSetupToken({}, body),
        (body) => setupService.completeSetup({}, body),
        (body) => sessionService.login({}, body),
        (body) => passwordService.requestPasswordReset({}, body),
        (body) => passwordService.resetPassword({}, body),
        (body) => inviteService.inspectInvite({}, body),
        (body) => inviteService.acceptInvite({}, body)
    ];
    for (const run of services) {
        for (const body of hostile) {
            const result = await run(body);
            assert.equal(typeof result, 'object');
            assert.equal(result.status, false, `${JSON.stringify(body)} was accepted`);
            assert.equal(typeof result.error.code, 'string');
            assert.ok(authModule.AUTH_ERROR_HTTP_STATUS[result.error.code] < 500, `${result.error.code} for ${JSON.stringify(body)} maps to a server error`);
        }
    }
    await _drain();
    assert.equal(AUTH_MESSAGES.SESSION_INVALID.startsWith('Not authenticated.'), true);
});

test('create invite: the rule caps the role, an existing member is 409 by name, and the link goes to the stored address with only its hash kept', async () => {
    const world = _lockedWorld();
    await _indexesReady();
    world.users.set(ADMIN_ID, _user({ _id: ADMIN_ID, role_key: 'admin', email: 'admin@example.com', name: 'Ada Admin' }));
    world.users.set(MEMBER_ID, _user({ email: 'member@example.com', status: 'disabled' }));
    _stub(inviteRepository, 'findOutstandingByEmail', async ({ email }) => world.invites.find((row) => row.email === email && !row.accepted_at && !row.revoked_at) || null);
    _stub(inviteRepository, 'countCreatedBySince', async () => 0);
    _stub(inviteRepository, 'insertInvite', async (fields) => {
        const defaults = { _id: _newId(), accepted_at: null, revoked_at: null, send_count: 1, createdAt: fields.now, last_sent_at: fields.now };
        const row = Object.assign(defaults, fields);
        world.invites.push(row);
        return _withoutHash(row);
    });

    const promote = await inviteService.createInvite({ user_id: ADMIN_ID }, { email: 'new@example.com', role_key: 'admin' });
    // For an invite the "target" IS the role, so the strict-subset check refuses it as not below the actor.
    assert.deepEqual([promote.error.code, promote.error.reason], ['FORBIDDEN', 'TARGET_NOT_BELOW_ACTOR'], 'An admin cannot invite another admin.');
    const owner = await inviteService.createInvite({ user_id: ADMIN_ID }, { email: 'new@example.com', role_key: 'owner' });
    assert.equal(owner.status, false, 'owner is never assignable.');

    const member = await inviteService.createInvite({ user_id: ADMIN_ID }, { email: ' MEMBER@example.com ', role_key: 'viewer' });
    assert.equal(member.error.code, 'ALREADY_A_MEMBER');
    assert.deepEqual([member.error.user_id, member.error.status], [MEMBER_ID, 'disabled'], 'A13: the 409 names the account so the admin can enable it instead.');

    const created = await inviteService.createInvite({ user_id: ADMIN_ID }, { email: ' New@Example.com ', role_key: 'analyst' });
    assert.equal(created.status, true, created.msg);
    assert.equal(created.data.email_sent, true);
    assert.equal(created.data.invite.email, 'new@example.com');
    assert.equal('token_hash' in created.data.invite, false, 'The view never carries the hash.');
    const mail = world.mails.at(-1);
    assert.equal(mail.to, 'new@example.com', 'Mail goes to the normalised, stored address (A2).');
    assert.equal(mail.trigger, mailModule.MAIL_TRIGGERS.ADMIN);
    assert.equal(mail.deadline_ms, mailModule.ADMIN_SEND_DEADLINE_MS, 'An admin-facing send is bounded (A10).');
    const token = /\/accept-invite#token=([A-Za-z0-9_-]{43})$/.exec(mail.vars.link)[1];
    assert.equal(world.invites.at(-1).token_hash, tokenHelper.hashToken(token));

    const pending = await inviteService.createInvite({ user_id: ADMIN_ID }, { email: 'new@example.com', role_key: 'viewer' });
    assert.equal(pending.error.code, 'INVITE_PENDING');
    _assertLogsClean(world, [token]);
});

test('create invite: a mail server that refuses still leaves the invitation (201, email_sent: false) — the admin can resend', async () => {
    const world = _lockedWorld();
    await _indexesReady();
    _stub(inviteRepository, 'findOutstandingByEmail', async () => null);
    _stub(inviteRepository, 'countCreatedBySince', async () => 0);
    _stub(inviteRepository, 'insertInvite', async (fields) => Object.assign({ _id: _newId(), accepted_at: null, revoked_at: null, createdAt: fields.now }, fields, { token_hash: undefined }));
    _stub(mailModule, 'sendTemplatedEmail', async () => ({ status: false, data: { accepted: false, status: 'FAILED' }, error: { code: 'FAILED' }, msg: 'The mail server did not accept the message.' }));

    const created = await inviteService.createInvite({ user_id: OWNER_ID }, { email: 'new@example.com', role_key: 'viewer' });
    assert.equal(created.status, true);
    assert.equal(created.data.email_sent, false);
    assert.equal(created.data.email_status, 'FAILED');
    assert.match(created.msg, /created/i, 'The message must say the invitation exists…');
    assert.match(created.msg, /re-?send/i, '…and how to retry.');
    assert.equal(world.audits.at(-1).details.email_status, 'FAILED');
});

test('boot roll-forward: a setup that crashed after the lock is finished from the token claim; a lost claim names repair-owner', async () => {
    const world = _installWorld();
    const ownerId = _newId();
    const link = _linkToken({ email: 'owner@example.com', used_at: new Date(Date.now() - MINUTE_MS) });
    link.row.claim = { name: 'Owner Person', password_hash: await bcrypt.hash(GOOD_PASSWORD, 4) };
    world.tokens.push(link.row);
    world.install = { _id: 'install', setup_completed_at: new Date(), owner_user_id: ownerId, setup_token_id: link.row._id };
    _stub(userRepository, 'existsById', async (id) => world.users.has(String(id)));
    _stub(authTokenRepository, 'findByIdWithClaim', async (id) => _clone(world.tokens.find((row) => row._id === String(id)) || null));

    const rolled = await installStateService.reconcileSetup();
    assert.equal(rolled.data.outcome, 'OWNER_INSERTED');
    const owner = world.users.get(ownerId);
    assert.ok(owner, 'The owner row must be written under the id the lock recorded.');
    assert.deepEqual([owner.email, owner.name, owner.role_key, owner.created_via], ['owner@example.com', 'Owner Person', 'admin', 'setup']);
    assert.equal(await bcrypt.compare(GOOD_PASSWORD, owner.password_hash), true, 'The owner signs in with the password chosen before the crash.');
    assert.equal(link.row.claim, undefined, 'The claim (a password hash) is removed once the owner exists.');

    assert.equal((await installStateService.reconcileSetup()).data.outcome, 'OWNER_PRESENT', 'Idempotent.');

    world.users.clear();
    const noClaim = await installStateService.reconcileSetup();
    assert.equal(noClaim.data.outcome, 'CLAIM_MISSING');
    assert.ok(world.logs.some((line) => /repair-owner --email <address> --name <name>/.test(line)), 'The ERROR must name the recovery command.');
    _assertLogsClean(world, [link.token, GOOD_PASSWORD]);
});

test(' repair-owner: a reused owner id inherits NOTHING — the departed owner\'s token is refused and their outstanding invite withdrawn', async () => {
    // The reproduced takeover: the owner row was deleted by hand, repair-owner recreated it under the
    // SAME id at session_epoch 0, and the departed owner's unexpired token authenticated as the new
    // owner with all 12 permissions. Their pending invitations came back under the new owner too.
    const world = _installWorld();
    await _indexesReady();
    world.install = { _id: 'install', setup_completed_at: new Date(Date.now() - 60 * MINUTE_MS), owner_user_id: OWNER_ID, setup_token_id: null };
    _stub(userRepository, 'existsById', async (id) => world.users.has(String(id)));
    const sessionId = _newId();
    world.sessions.set(sessionId, {
        _id: sessionId,
        user_id: OWNER_ID,
        epoch: 0,
        revoked_at: null,
        revoked_reason: null,
        expires_at: new Date(Date.now() + 60 * MINUTE_MS)
    });
    const departedToken = jwt.sign({ sid: sessionId }, sessionService.sessionSigningKey(), { algorithm: 'HS256', subject: OWNER_ID, audience: JWT_AUDIENCE, expiresIn: 3600 });
    world.invites.push({
        _id: _newId(),
        email: 'accomplice@example.com',
        role_key: 'admin',
        custom_role_id: null,
        invited_by_user_id: OWNER_ID,
        token_hash: 'f'.repeat(64),
        expires_at: new Date(Date.now() + 60 * MINUTE_MS),
        accepted_at: null,
        revoked_at: null
    });
    const recoveryService = require(path.join(AUTH, 'services', 'recovery.service.ts'));

    const repaired = await recoveryService.repairOwnerForCli({}, { email: 'successor@example.com', name: 'Successor' });
    assert.equal(repaired.status, true, repaired.msg);
    assert.equal(repaired.data.user_id, OWNER_ID, 'Precondition: this is the reuse path (spec A17).');
    assert.equal(world.users.get(OWNER_ID).email, 'successor@example.com');

    const loaded = await principalService.loadPrincipal({}, { user_id: OWNER_ID, session_id: sessionId });
    assert.equal(loaded.status, false, 'The departed owner\'s session authenticated as the NEW owner.');
    assert.equal(loaded.error.code, 'SESSION_REVOKED');
    const guarded = await _authenticate(departedToken);
    assert.equal(guarded.nextCalled, false);
    assert.equal(guarded.res.statusCode, 401);

    assert.ok(world.invites[0].revoked_at, 'The departed owner\'s pending invitation came back under the new owner.');
    assert.equal(world.invites[0].revoked_reason, 'INVITER_DISABLED');
    const audit = world.audits.find((row) => row.action === 'OWNER_REPAIRED');
    assert.deepEqual(audit.details, { sessions_revoked: 1, invites_revoked: 1 });
});

test('boot: an install document missing while users exist is created LOCKED with no owner — setup never reopens over real accounts (A7)', async () => {
    const world = _installWorld();
    world.install = null;
    world.users.set(MEMBER_ID, _user());
    const inserted = [];
    _stub(userRepository, 'countUsers', async () => world.users.size);
    _stub(systemStateRepository, 'ensureInstallDocument', async ({ locked_at }) => {
        inserted.push(locked_at);
        world.install = { _id: 'install', setup_completed_at: locked_at, owner_user_id: null, setup_token_id: null };
        return { inserted: true };
    });

    const result = await installStateService.ensureInstallState();
    assert.equal(result.status, true);
    assert.equal(inserted.length, 1);
    assert.ok(inserted[0] instanceof Date, 'With users present the document must be inserted LOCKED.');
    assert.equal(world.install.owner_user_id, null);
    assert.ok(world.logs.some((line) => /transfer-owner --email/.test(line)));

    const status = await installStateService.getSetupStatus();
    assert.deepEqual(status.data, { setup_complete: true }, 'After completion GET /setup says only that (A7).');
});

test('boot: ensureInstallState and ensureAuthIndexes THROW on a datastore failure (fatal, A8); the non-fatal steps resolve', async () => {
    _installWorld();
    const down = () => Object.assign(new Error('connection refused'), { name: 'MongoServerSelectionError' });
    _stub(systemStateRepository, 'findInstallState', async () => {
        throw down();
    });
    _stub(authIndexRepository, 'createAuthIndexes', async () => {
        throw down();
    });
    _stub(legacyOperatorRepository, 'markAllLegacy', async () => {
        throw down();
    });
    await assert.rejects(() => installStateService.ensureInstallState(), /connection refused/);
    await assert.rejects(() => installStateService.ensureAuthIndexes(), /connection refused/);
    assert.equal(installStateService.areAuthIndexesReady(), false, 'indexes_ready must stay false when the build failed.');
    const marked = await installStateService.markLegacyOperators();
    assert.equal(marked.status, false);
    const reconciled = await installStateService.reconcileSetup();
    assert.equal(reconciled.status, false);
    const logged = await installStateService.logSetupState();
    assert.equal(logged.status, false);
});

test('change password: a wrong CURRENT password is 400; success ends every other session and hands back a FRESH token (A4)', async () => {
    const world = _lockedWorld();
    const oldPassword = 'the old long passphrase';
    world.users.set(MEMBER_ID, _user({ password_hash: await bcrypt.hash(oldPassword, 4), session_epoch: 0 }));
    const current = _newId();
    const other = _newId();
    for (const id of [current, other]) {
        world.sessions.set(id, { _id: id, user_id: MEMBER_ID, epoch: 0, revoked_at: null, expires_at: new Date(Date.now() + 60 * MINUTE_MS) });
    }
    const oldToken = jwt.sign({ sid: current }, sessionService.sessionSigningKey(), { algorithm: 'HS256', subject: MEMBER_ID, audience: JWT_AUDIENCE, expiresIn: 3600 });
    assert.equal((await _authenticate(oldToken)).nextCalled, true, 'Control: the old token works before the change.');

    const wrong = await passwordService.changePassword({ user_id: MEMBER_ID }, { current_password: 'not it at all, sorry', new_password: GOOD_PASSWORD, session_id: current });
    assert.equal(wrong.error.code, 'CURRENT_PASSWORD_INCORRECT');
    assert.equal(authModule.AUTH_ERROR_HTTP_STATUS.CURRENT_PASSWORD_INCORRECT, 400, 'Never 401: the dashboard would sign the user out for a typo.');

    const changed = await passwordService.changePassword({ user_id: MEMBER_ID }, {
        current_password: oldPassword,
        new_password: GOOD_PASSWORD,
        session_id: current
    });
    assert.equal(changed.status, true, changed.msg);
    assert.deepEqual(Object.keys(changed.data).sort(), ['expires_at', 'expires_in_seconds', 'revoked', 'token']);
    assert.equal(changed.data.revoked, 1, 'Exactly the OTHER session is counted.');
    assert.equal(world.sessions.get(other).revoked_reason, 'PASSWORD_CHANGED');

    const stale = await _authenticate(oldToken);
    assert.equal(stale.res.statusCode, 401, 'The token the change was made with is dead afterwards.');
    const fresh = await _authenticate(changed.data.token);
    assert.equal(fresh.nextCalled, true, 'The fresh token carries the new epoch and is admitted.');
    await _drain();
    assert.equal(world.mails.filter((mail) => mail.template === mailModule.EMAIL_TEMPLATES.PASSWORD_CHANGED).length, 1);
    _assertLogsClean(world, [oldPassword, GOOD_PASSWORD, changed.data.token]);
});

test('the one code → status table covers every code a service can return; 401 means authentication and nothing else (I6)', () => {
    const table = authModule.AUTH_ERROR_HTTP_STATUS;
    const codes = [...Object.values(authModule.AUTH_ERROR_CODES), ...Object.values(authModule.SESSION_FAILURE_REASONS)];
    const unmapped = codes.filter((code) => typeof table[code] !== 'number');
    assert.deepEqual(unmapped, [], 'A code missing from the table answers 500 — add it in the change that first returns it.');

    const unauthenticated = Object.keys(table).filter((code) => table[code] === 401).sort();
    assert.deepEqual(unauthenticated, [
        'AUTH_HEADER_MISSING', 'INVALID_CREDENTIALS', 'NO_SESSION', 'NO_USER', 'SESSION_EXPIRED',
        'SESSION_INVALID', 'SESSION_REVOKED', 'SESSION_STALE', 'SESSION_USER_MISMATCH', 'USER_DISABLED'
    ].sort(), 'Only authentication failures may be 401 — the dashboard signs out on every 401.');
    assert.equal(table.DATASTORE_ERROR, 503);
    assert.equal(table.CURRENT_PASSWORD_INCORRECT, 400, 'A wrong CURRENT password is 400, not 401 (I6).');
    assert.equal(table.FORBIDDEN, 403);
});
