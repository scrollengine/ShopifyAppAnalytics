'use strict';

/**
 * ============================================================================
 *  CONFIGURATION — the settings that boot fine and then fail a PERSON (spec §2, A10, A20)
 * ============================================================================
 *
 *  Multi-user sign-in added settings whose failure mode is not a crash but a
 *  person stranded: an email link that opens the wrong host, a message that
 *  never leaves, a half-set SMTP login that fails with a 535 nobody reads.
 *  Each is refused (TIER-1) or warned about at boot, by name.
 *
 *  ── Two ways in, because config snapshots process.env at FIRST require ──────
 *   1. `collectConfigProblems(cfg)` takes a config SHAPE, so the rules are
 *      tested in-process on cloned shapes — no env juggling.
 *   2. The env → config PARSING (Gmail app-password spaces, the SMTP_FROM
 *      fallback, trailing slashes, the legacy ADMIN_* detector) and the boot
 *      banner can only be seen from a fresh process, so those run as child
 *      processes with an explicit, minimal environment — nothing inherited
 *      from whoever runs the suite.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(BACKEND_ROOT, 'src');

const config = require(path.join(SRC, 'config'));
const validate = require(path.join(SRC, 'config', 'validate.ts'));

const { collectConfigProblems, checkPublicUrl, isLoopbackPublicUrl, isBareEmailAddress } = validate;

/**
 * A complete, valid config shape with `overrides` applied section by section.
 *
 * @param {Object} [overrides] - `{ SECTION: { KEY: value } }`.
 * @returns {Object} A mutable config shape.
 */
const _cfg = (overrides) => {
    const shape = JSON.parse(JSON.stringify(config));
    Object.assign(shape.MONGO, { URI: 'mongodb://127.0.0.1:27017/test' });
    Object.assign(shape.AUTH, { JWT_SECRET: 'x'.repeat(32), LEGACY_ADMIN_ENV_PRESENT: false, SETUP_OWNER_EMAIL: '' });
    Object.assign(shape.APP, { PUBLIC_URL: 'https://analytics.example.com', TRUST_PROXY: false });
    Object.assign(shape.MAIL, {
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: 587,
        SMTP_SECURE: false,
        SMTP_ALLOW_INSECURE: false,
        SMTP_USER: 'mailer@example.com',
        SMTP_PASS: 'a-secret-value',
        SMTP_FROM: 'analytics@example.com',
        MAX_PER_HOUR: 30,
        MAX_PER_DAY: 200
    });
    Object.assign(shape.PARTNER, { ORG_ID: '1234567', API_TOKEN: 'prtapi_x', API_VERSION: '2026-07', APP_ID: '42' });
    for (const [section, values] of Object.entries(overrides || {})) {
        Object.assign(shape[section], values);
    }
    return shape;
};

const _problemEnvs = (report) => report.problems.map((problem) => problem.env);
const _warns = (report, pattern) => report.warnings.some((warning) => pattern.test(warning));


/* ==========================================================================
 *  In-process: the rules
 * ========================================================================== */

test('the baseline shape is clean — every refusal below is caused by its one change', () => {
    const report = collectConfigProblems(_cfg());
    assert.deepEqual(report.problems, []);
    assert.equal(report.upgrade_notice, null);
});

test('APP_PUBLIC_URL: an absolute http(s) site root — no credentials, no path, no query, no fragment', () => {
    const accepted = [
        'https://analytics.example.com',
        'https://analytics.example.com/',
        'http://localhost:3000',
        'https://analytics.example.com:8443',
        'http://127.0.0.1:3000',
        'https://[::1]:3000'
    ];
    for (const value of accepted) {
        assert.equal(checkPublicUrl(value), null, `${value} should be accepted`);
    }
    const refused = [
        '',
        'analytics.example.com',
        '//analytics.example.com',
        'ftp://analytics.example.com',
        'javascript:alert(1)',
        'https://user:pass@analytics.example.com',
        'https://user@analytics.example.com',
        'https://analytics.example.com/dashboard',
        'https://analytics.example.com//',
        'https://analytics.example.com/?next=/',
        'https://analytics.example.com?x=1',
        'https://analytics.example.com#frag',
        'https://analytics.example.com/#',
        'https:///nohost'
    ];
    for (const value of refused) {
        assert.notEqual(checkPublicUrl(value), null, `${JSON.stringify(value)} must be refused`);
    }
    // And through the report, by name.
    const report = collectConfigProblems(_cfg({ APP: { PUBLIC_URL: 'https://analytics.example.com/app' } }));
    assert.deepEqual(_problemEnvs(report), ['APP_PUBLIC_URL']);
    assert.match(report.problems[0].message, /path/);
    assert.deepEqual(_problemEnvs(collectConfigProblems(_cfg({ APP: { PUBLIC_URL: '' } }))), ['APP_PUBLIC_URL']);
});

test('APP_PUBLIC_URL warnings: loopback (links open only here), plain http elsewhere, and the internal backend address', () => {
    for (const value of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'http://app.localhost']) {
        assert.equal(isLoopbackPublicUrl(value), true, value);
        assert.ok(_warns(collectConfigProblems(_cfg({ APP: { PUBLIC_URL: value } })), /will only open on this machine/), `${value} must warn`);
    }
    assert.equal(isLoopbackPublicUrl('https://analytics.example.com'), false);
    assert.equal(_warns(collectConfigProblems(_cfg()), /only open on this machine|plain HTTP|internal address/), false);

    assert.ok(_warns(collectConfigProblems(_cfg({ APP: { PUBLIC_URL: 'http://analytics.example.com' } })), /plain HTTP/));
    assert.ok(_warns(collectConfigProblems(_cfg({ APP: { PUBLIC_URL: 'http://backend:8080' } })), /internal address/));
    assert.ok(_warns(collectConfigProblems(_cfg({ APP: { PUBLIC_URL: 'https://analytics.example.com:8080' } })), /internal address/));
});

test('SMTP_USER / SMTP_PASS: both or neither — one without the other is refused, naming the missing one', () => {
    assert.deepEqual(collectConfigProblems(_cfg({ MAIL: { SMTP_USER: '', SMTP_PASS: '' } })).problems, [], 'An auth-less relay is legitimate.');

    const userOnly = collectConfigProblems(_cfg({ MAIL: { SMTP_PASS: '' } }));
    assert.deepEqual(_problemEnvs(userOnly), ['SMTP_PASS']);
    assert.match(userOnly.problems[0].message, /SMTP_USER is set, but SMTP_PASS is not/);

    const passOnly = collectConfigProblems(_cfg({ MAIL: { SMTP_USER: '' } }));
    assert.deepEqual(_problemEnvs(passOnly), ['SMTP_USER']);
    for (const report of [userOnly, passOnly]) {
        assert.equal(JSON.stringify(report).includes('a-secret-value'), false, 'The SMTP password must never appear in a config message.');
    }
});

test('SMTP_HOST and SMTP_FROM are TIER-1; SMTP_FROM must be a single bare address (display name goes in SMTP_FROM_NAME)', () => {
    assert.deepEqual(_problemEnvs(collectConfigProblems(_cfg({ MAIL: { SMTP_HOST: '' } }))), ['SMTP_HOST']);
    for (const host of ['smtp://smtp.example.com', 'smtp.example.com:587', 'smtp .example.com']) {
        assert.deepEqual(_problemEnvs(collectConfigProblems(_cfg({ MAIL: { SMTP_HOST: host } }))), ['SMTP_HOST'], host);
    }

    assert.deepEqual(_problemEnvs(collectConfigProblems(_cfg({ MAIL: { SMTP_FROM: '' } }))), ['SMTP_FROM']);
    const named = collectConfigProblems(_cfg({ MAIL: { SMTP_FROM: 'Analytics <analytics@example.com>' } }));
    assert.deepEqual(_problemEnvs(named), ['SMTP_FROM']);
    assert.match(named.problems[0].message, /SMTP_FROM_NAME/, 'A display name in SMTP_FROM must say where the name belongs instead.');
    for (const from of ['a@example.com, b@example.com', 'a@b@example.com', 'not-an-address', 'a@example.com\n']) {
        assert.deepEqual(_problemEnvs(collectConfigProblems(_cfg({ MAIL: { SMTP_FROM: from } }))), ['SMTP_FROM'], JSON.stringify(from));
    }
    assert.equal(isBareEmailAddress('analytics@example.com'), true);

    // The fallback case says so: an SMTP_USER that is not an address (SendGrid's "apikey") is not a sender.
    const fallback = collectConfigProblems(_cfg({ MAIL: { SMTP_USER: 'apikey', SMTP_FROM: 'apikey' } }));
    assert.match(fallback.problems[0].message, /SMTP_USER, which is used in its place/);
});

test('SMTP transport warnings: SMTP_ALLOW_INSECURE, and a port/secure mismatch in either direction', () => {
    assert.ok(_warns(collectConfigProblems(_cfg({ MAIL: { SMTP_ALLOW_INSECURE: true } })), /SMTP_ALLOW_INSECURE=true/));
    assert.ok(_warns(collectConfigProblems(_cfg({ MAIL: { SMTP_PORT: 465, SMTP_SECURE: false } })), /465 but SMTP_SECURE is not true/));
    assert.ok(_warns(collectConfigProblems(_cfg({ MAIL: { SMTP_PORT: 587, SMTP_SECURE: true } })), /587 but SMTP_SECURE=true/));
    assert.equal(_warns(collectConfigProblems(_cfg({ MAIL: { SMTP_PORT: 465, SMTP_SECURE: true } })), /SMTP_SECURE/), false);
    assert.deepEqual(_problemEnvs(collectConfigProblems(_cfg({ MAIL: { SMTP_PORT: 70000 } }))), ['SMTP_PORT']);
});

test('Gmail: a pasted account password (not 16 characters) warns by LENGTH, never by value', () => {
    const report = collectConfigProblems(_cfg({ MAIL: { SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: 465, SMTP_SECURE: true, SMTP_USER: 'me@gmail.com', SMTP_PASS: 'myGooglePassword1' } }));
    assert.ok(_warns(report, /17 characters after removing spaces/));
    assert.equal(JSON.stringify(report).includes('myGooglePassword1'), false);
    const appPassword = collectConfigProblems(_cfg({ MAIL: { SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: 465, SMTP_SECURE: true, SMTP_USER: 'me@gmail.com', SMTP_PASS: 'abcdefghijklmnop' } }));
    assert.equal(_warns(appPassword, /Gmail app passwords/), false);
});

test('SETUP_OWNER_EMAIL, when set, must be an address someone could actually own', () => {
    assert.deepEqual(_problemEnvs(collectConfigProblems(_cfg({ AUTH: { SETUP_OWNER_EMAIL: 'owner@example.com' } }))), []);
    assert.deepEqual(_problemEnvs(collectConfigProblems(_cfg({ AUTH: { SETUP_OWNER_EMAIL: 'owner' } }))), ['SETUP_OWNER_EMAIL']);
});

test('upgrade from a single-operator build: leftover ADMIN_* warns "ignored", and a missing new setting heads the error with the upgrade banner', () => {
    const upgraded = collectConfigProblems(_cfg({ AUTH: { LEGACY_ADMIN_ENV_PRESENT: true } }));
    assert.deepEqual(upgraded.problems, []);
    assert.equal(upgraded.upgrade_notice, null, 'A complete upgrade needs no banner.');
    assert.ok(_warns(upgraded, /ignored by this build — delete them once you no longer need to roll back to a single-operator build/));

    const halfway = collectConfigProblems(_cfg({ AUTH: { LEGACY_ADMIN_ENV_PRESENT: true }, APP: { PUBLIC_URL: '' }, MAIL: { SMTP_HOST: '' } }));
    assert.ok(halfway.upgrade_notice);
    assert.match(halfway.upgrade_notice, /UPGRADING FROM A SINGLE-OPERATOR BUILD/);
    for (const env of ['APP_PUBLIC_URL', 'SMTP_HOST', 'SMTP_FROM']) {
        assert.ok(halfway.upgrade_notice.includes(env), `The banner must list ${env}.`);
    }
    assert.match(halfway.upgrade_notice, /Still needing attention: APP_PUBLIC_URL, SMTP_HOST\./);
    assert.match(halfway.upgrade_notice, /DEPLOYMENT\.md, section "Upgrading from a single-operator build"/);

    const fresh = collectConfigProblems(_cfg({ APP: { PUBLIC_URL: '' } }));
    assert.equal(fresh.upgrade_notice, null, 'A fresh install gets no upgrade banner.');
    assert.equal(_warns(fresh, /ADMIN_EMAIL/), false);
});

test('mail caps of zero or one, and non-positive link lifetimes, warn by name', () => {
    assert.ok(_warns(collectConfigProblems(_cfg({ MAIL: { MAX_PER_HOUR: 0 } })), /EMAIL_MAX_PER_HOUR is 0, so NO email will be sent/));
    assert.ok(_warns(collectConfigProblems(_cfg({ MAIL: { MAX_PER_DAY: 1 } })), /EMAIL_MAX_PER_DAY is 1/));
    assert.ok(_warns(collectConfigProblems(_cfg({ AUTH: { INVITE_TTL_HOURS: 0 } })), /AUTH_INVITE_TTL_HOURS is 0/));
});

test('AUTH_PUBLIC_FLOW_RATE_LIMIT_MAX of zero or less warns that all three public-flow limiters are OFF; the default does not', () => {
    const disabled = /AUTH_PUBLIC_FLOW_RATE_LIMIT_MAX is (0|-1), which DISABLES all three/;
    assert.equal(_warns(collectConfigProblems(_cfg()), disabled), false, 'The default budget raised the "disabled" warning.');
    assert.ok(_warns(collectConfigProblems(_cfg({ AUTH: { PUBLIC_FLOW_RATE_LIMIT_MAX: 0 } })), disabled));
    assert.ok(_warns(collectConfigProblems(_cfg({ AUTH: { PUBLIC_FLOW_RATE_LIMIT_MAX: -1 } })), disabled));
});

test('TRUST_PROXY: the warning accepts the documented nginx recipe (appending) for a range, and demands an overwrite only for true', () => {
    const report = collectConfigProblems(_cfg({ APP: { TRUST_PROXY: 'uniquelocal' } }));
    assert.ok(_warns(report, /TRUST_PROXY=uniquelocal makes this process BELIEVE/));
    assert.ok(_warns(report, /appending it \(nginx's \$proxy_add_x_forwarded_for\) is enough with uniquelocal/),
        'DEPLOYMENT.md tells operators to use uniquelocal behind an appending nginx; boot must not call that wrong.');
    assert.ok(_warns(report, /TRUST_PROXY=true needs a proxy that overwrites the header/));
});


/* ==========================================================================
 *  Child processes: env → config parsing, and the boot banner
 * ========================================================================== */

/**
 * Runs `script` in a fresh Node process with ONLY `env` (plus PATH), from the backend root.
 *
 * @param {String} script - JavaScript to evaluate.
 * @param {Object} env - The environment.
 * @returns {{ status: Number, stdout: String, stderr: String }}
 */
const _run = (script, env) => {
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
        cwd: BACKEND_ROOT,
        env: Object.assign({ PATH: process.env.PATH, LOG_LEVEL: 'silent' }, env),
        encoding: 'utf8',
        timeout: 60000
    });
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
};

const PARSE_SCRIPT = [
    'const c = require("./src/config");',
    'process.stdout.write(JSON.stringify({',
    '  pass: c.MAIL.SMTP_PASS, from: c.MAIL.SMTP_FROM, port: c.MAIL.SMTP_PORT, secure: c.MAIL.SMTP_SECURE,',
    '  enabled: c.MAIL.ENABLED, insecure: c.MAIL.SMTP_ALLOW_INSECURE, public_url: c.APP.PUBLIC_URL,',
    '  legacy: c.AUTH.LEGACY_ADMIN_ENV_PRESENT, pin: c.AUTH.SETUP_OWNER_EMAIL, frozen: Object.isFrozen(c.MAIL),',
    '  has_admin_keys: ["ADMIN_EMAIL", "ADMIN_PASSWORD", "ADMIN_PASSWORD_HASH"].some((k) => k in c.AUTH)',
    '}));'
].join('\n');

const _parse = (env) => {
    const run = _run(PARSE_SCRIPT, env);
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
};

test('parsing: Gmail app-password spaces are removed for smtp.gmail.com ONLY; other secrets are trimmed at the ends and never altered inside', () => {
    const gmail = _parse({ SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'me@gmail.com', SMTP_PASS: ' abcd efgh\tijkl mnop ' });
    assert.equal(gmail.pass, 'abcdefghijklmnop');
    const other = _parse({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'me@example.com', SMTP_PASS: '  pass with spaces  ' });
    assert.equal(other.pass, 'pass with spaces', 'Only the ends are trimmed; nothing else ever alters the secret.');
});

test('parsing: SMTP_FROM falls back to SMTP_USER only when that is an address; ENABLED needs a host and a sender', () => {
    const fallback = _parse({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'me@example.com', SMTP_PASS: 'x' });
    assert.equal(fallback.from, 'me@example.com');
    assert.equal(fallback.enabled, true);

    const apikey = _parse({ SMTP_HOST: 'smtp.sendgrid.net', SMTP_USER: 'apikey', SMTP_PASS: 'x' });
    assert.equal(apikey.from, '', 'A login that is not an address is never used as the sender.');
    assert.equal(apikey.enabled, false);

    const explicit = _parse({ SMTP_HOST: 'smtp.example.com', SMTP_USER: 'me@example.com', SMTP_PASS: 'x', SMTP_FROM: 'analytics@example.com' });
    assert.equal(explicit.from, 'analytics@example.com');
    assert.equal(_parse({}).enabled, false);
});

test('parsing: the SMTP port follows SMTP_SECURE; SMTP_ALLOW_INSECURE is a negative switch; MAIL is frozen', () => {
    assert.deepEqual([_parse({ SMTP_SECURE: 'true' }).port, _parse({ SMTP_SECURE: 'true' }).secure], [465, true]);
    assert.deepEqual([_parse({}).port, _parse({}).secure], [587, false]);
    assert.equal(_parse({ SMTP_PORT: '2525' }).port, 2525);
    assert.equal(_parse({}).insecure, false);
    assert.equal(_parse({ SMTP_ALLOW_INSECURE: 'yes' }).insecure, false, 'Only the exact string "true" loosens TLS.');
    assert.equal(_parse({ SMTP_ALLOW_INSECURE: 'true' }).insecure, true);
    assert.equal(_parse({}).frozen, true);
});

test('parsing: APP_PUBLIC_URL loses trailing slashes; SETUP_OWNER_EMAIL is lowercased; ADMIN_* only set a presence flag', () => {
    assert.equal(_parse({ APP_PUBLIC_URL: 'https://analytics.example.com///' }).public_url, 'https://analytics.example.com');
    assert.equal(_parse({ SETUP_OWNER_EMAIL: ' Owner@Example.COM ' }).pin, 'owner@example.com');

    const legacy = _parse({ ADMIN_EMAIL: 'op@example.com', ADMIN_PASSWORD: 'old-password' });
    assert.equal(legacy.legacy, true);
    assert.equal(legacy.has_admin_keys, false, 'The ADMIN_* values are never read into config — only their presence.');
    assert.equal(_parse({ ADMIN_EMAIL: '   ' }).legacy, false, 'A blank value is not present.');
    assert.equal(_parse({}).legacy, false);
});

test('boot: an upgrade with a missing setting prints the upgrade banner ABOVE the error, exits 1, and never prints a secret', () => {
    const run = _run('require("./src/config/validate.ts").validateConfig(); process.stdout.write("BOOTED");', {
        MONGO_URI: 'mongodb://127.0.0.1:27017/test',
        JWT_SECRET: 'x'.repeat(32),
        SHOPIFY_PARTNER_ORG_ID: '1234567',
        SHOPIFY_PARTNER_API_TOKEN: 'prtapi_x',
        ADMIN_EMAIL: 'op@example.com',
        ADMIN_PASSWORD: 'the-old-admin-password',
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'mailer@example.com',
        SMTP_PASS: 'smtp-secret-value'
    });
    assert.equal(run.status, 1, 'A missing TIER-1 setting must stop the boot.');
    assert.equal(run.stdout.includes('BOOTED'), false);
    const banner = run.stderr.indexOf('UPGRADING FROM A SINGLE-OPERATOR BUILD');
    const error = run.stderr.indexOf('CONFIGURATION ERROR: APP_PUBLIC_URL is not set.');
    assert.ok(banner >= 0, run.stderr);
    assert.ok(error > banner, 'The upgrade banner must head the configuration error.');
    for (const secret of ['smtp-secret-value', 'the-old-admin-password', 'x'.repeat(32)]) {
        assert.equal(run.stderr.includes(secret), false, 'A secret was printed at boot.');
    }
});
