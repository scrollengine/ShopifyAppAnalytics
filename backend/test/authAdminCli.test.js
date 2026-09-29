'use strict';

/**
 * ============================================================================
 *  THE RECOVERY CLI — refuses what it must before it reads anything (spec §13, A17, A20)
 * ============================================================================
 *
 *  `npm run auth:admin -- <command>` is what an operator runs when the
 *  dashboard cannot help. Two refusals matter more than any command:
 *
 *    - it NEVER takes a password. A password on a command line lands in shell
 *      history and in `ps`, so any option that looks like one is refused before
 *      anything else, and a stray bare word (where a mistyped password lands) is
 *      not echoed back;
 *    - a wrong command line exits non-zero having read and written nothing.
 *
 *  Each case runs the real script as a CHILD PROCESS with an empty environment
 *  (only PATH and the ts-node project pointer) from an empty temporary
 *  directory — so dotenv finds no .env, no database is configured, and a test
 *  that passes cannot have done so by reaching a real install.
 *
 *  Exit codes (from the script's header): 0 done, 1 refused / failed / a
 *  setting missing, 2 bad command line.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(BACKEND_ROOT, 'src', 'scripts', 'authAdmin.ts');
const TS_NODE_REGISTER = require.resolve('ts-node/register/transpile-only', { paths: [BACKEND_ROOT] });

const EMPTY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-admin-cli-'));

test.after(() => {
    fs.rmSync(EMPTY_DIR, { recursive: true, force: true });
});

/**
 * Runs the CLI with `args` and an environment of only `extraEnv`.
 *
 * @param {String[]} args - Command-line arguments.
 * @param {Object} [extraEnv] - Anything beyond PATH and the ts-node project.
 * @returns {{ status: Number, stdout: String, stderr: String, output: String }}
 */
const _cli = (args, extraEnv) => {
    const result = spawnSync(process.execPath, ['-r', TS_NODE_REGISTER, SCRIPT, ...args], {
        cwd: EMPTY_DIR,
        env: Object.assign({ PATH: process.env.PATH, TS_NODE_PROJECT: path.join(BACKEND_ROOT, 'tsconfig.json') }, extraEnv || {}),
        encoding: 'utf8',
        timeout: 60000
    });
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    return { status: result.status, stdout, stderr, output: stdout + stderr };
};


test('an unknown command exits 2 with the usage, having touched nothing', () => {
    const run = _cli(['make-me-admin', '--email', 'x@example.com']);
    assert.equal(run.status, 2, run.output);
    assert.match(run.stderr, /Unknown command "make-me-admin"/);
    assert.match(run.stderr, /Commands:/);
    assert.equal(/MONGO|connect/i.test(run.output), false, 'A bad command line must stop before any setting is read.');
});

test('--password is refused (exit 2) on every command — and the value is never echoed', () => {
    const attempts = [
        ['reset-link', '--email', 'owner@example.com', '--password', 'hunter2-secret-value'],
        ['repair-owner', '--email', 'owner@example.com', '--name', 'Owner', '--password=hunter2-secret-value'],
        ['setup-link', '--new-password', 'hunter2-secret-value', '--email', 'owner@example.com', '--name', 'Owner'],
        ['status', '--passphrase', 'hunter2-secret-value'],
        ['--pass', 'hunter2-secret-value', 'status'],
        ['make-me-admin', '-password', 'hunter2-secret-value']
    ];
    for (const args of attempts) {
        const run = _cli(args);
        assert.equal(run.status, 2, `${args.join(' ')} → ${run.status}\n${run.output}`);
        assert.match(run.stderr, /never accepts a password/);
        assert.equal(run.output.includes('hunter2-secret-value'), false, 'The refused password was printed back.');
    }
});

test('a stray bare word (where a mistyped password lands) is refused without being echoed', () => {
    const run = _cli(['reset-link', '--email', 'owner@example.com', 'correct-horse-battery']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /Unexpected bare argument/);
    assert.equal(run.output.includes('correct-horse-battery'), false);
});

test('no command, a missing required option, and a repeated option are all usage errors (exit 2)', () => {
    assert.equal(_cli([]).status, 2);
    assert.equal(_cli(['reset-link']).status, 2);
    assert.equal(_cli(['setup-link', '--email', 'owner@example.com']).status, 2, 'setup-link needs --name.');
    assert.equal(_cli(['revoke-sessions']).status, 2, 'revoke-sessions needs exactly one of --email or --all.');
    assert.equal(_cli(['revoke-sessions', '--all', '--email', 'a@example.com']).status, 2);
    assert.equal(_cli(['enable', '--email', 'a@example.com', '--email', 'b@example.com']).status, 2);
    assert.equal(_cli(['status', '--email', 'a@example.com']).status, 2, 'status takes no options.');
});

test('--help exits 0 with the usage on stdout', () => {
    const run = _cli(['--help']);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /never takes a password/);
});

test('a valid command with no MONGO_URI exits 1 naming the setting; a link command with no APP_PUBLIC_URL exits 1 before connecting', () => {
    const noDb = _cli(['status']);
    assert.equal(noDb.status, 1, noDb.output);
    assert.match(noDb.stderr, /MONGO_URI is not set/);

    // An address nothing listens on: if the script got as far as connecting, this would take the
    // driver's server-selection timeout and say "Could not connect" — it must refuse first.
    const noUrl = _cli(['reset-link', '--email', 'owner@example.com'], { MONGO_URI: 'mongodb://127.0.0.1:1/never-connected' });
    assert.equal(noUrl.status, 1, noUrl.output);
    assert.match(noUrl.stderr, /APP_PUBLIC_URL is not set/);
    assert.equal(/Could not connect/.test(noUrl.output), false);

    const pathUrl = _cli(['setup-link', '--email', 'owner@example.com', '--name', 'Owner'], {
        MONGO_URI: 'mongodb://127.0.0.1:1/never-connected',
        APP_PUBLIC_URL: 'https://analytics.example.com/dashboard'
    });
    assert.equal(pathUrl.status, 1);
    assert.match(pathUrl.stderr, /APP_PUBLIC_URL is set, but it has a path/);
});
