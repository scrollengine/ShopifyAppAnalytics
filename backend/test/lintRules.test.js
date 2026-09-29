'use strict';

/**
 * ============================================================================
 *  THE LINT GUARDS — proven to fire, not assumed to (spec I2, A12, A20)
 * ============================================================================
 *
 *  Two architectural rules live in eslint.config.js:
 *
 *    - the LINK-ORIGIN guard (I2): nothing under src/ reads the request's idea
 *      of its own address — `req.hostname`, `req.host`, `req.protocol`,
 *      `req.subdomains`, `req.get()`, `req.header()`, the Host header, any
 *      X-Forwarded-* header. An emailed reset link built from any of those
 *      points wherever the SENDER of the request chose, and carries the
 *      victim's token there when clicked.
 *    - the LAYER guard: src/models/** is imported only from repositories/.
 *
 *  A lint rule that silently stopped matching is indistinguishable from a
 *  codebase that obeys it. The obvious way to break these two: a second config
 *  object that sets `no-restricted-syntax` REPLACES the first one's options
 *  wholesale, so adding the host selectors "next to" the model selectors in a
 *  new block would switch the model guard off with no error anywhere. So each
 *  guard is run here, through the ESLint API, against in-memory snippets
 *  placed at realistic paths — and both must fire from the same file.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ESLint } = require('eslint');

const BACKEND_ROOT = path.resolve(__dirname, '..');

// One instance for the file: it reads the real eslint.config.js from the backend root.
const eslint = new ESLint({ cwd: BACKEND_ROOT });

/** A path that does not exist — ESLint only needs it to pick the config blocks. */
const CONTROLLER_PATH = path.join(BACKEND_ROOT, 'src', 'controllers', '__lintFixture.controller.ts');
const SERVICE_PATH = path.join(BACKEND_ROOT, 'src', 'modules', 'auth', 'services', '__lintFixture.service.ts');
const REPOSITORY_PATH = path.join(BACKEND_ROOT, 'src', 'modules', 'auth', 'repositories', '__lintFixture.repository.ts');

const GUARD_RULES = ['no-restricted-properties', 'no-restricted-syntax', '@typescript-eslint/no-restricted-imports'];

/**
 * Lints a snippet as if it lived at `filePath` and returns the guard findings.
 *
 * @param {String} code - TypeScript source.
 * @param {String} filePath - Where it pretends to live.
 * @returns {Promise<Array<{ rule: String, line: Number, message: String }>>}
 */
const _guardFindings = async (code, filePath) => {
    const [result] = await eslint.lintText(code, { filePath: filePath, warnIgnored: true });
    const fatal = result.messages.filter((message) => message.fatal);
    assert.deepEqual(fatal, [], `The fixture did not parse: ${JSON.stringify(fatal)}`);
    return result.messages
        .filter((message) => GUARD_RULES.includes(message.ruleId))
        .map((message) => ({ rule: message.ruleId, line: message.line, message: message.message }));
};

/** Wraps expressions in a handler so the snippet is realistic TypeScript. */
const _handler = (lines) => [
    '\'use strict\';',
    '',
    'import type { Request, Response } from \'express\';',
    '',
    'const _handle = (req: Request, res: Response): void => {',
    ...lines.map((line) => `    ${line}`),
    '    res.end();',
    '};',
    '',
    'export = { _handle };',
    ''
].join('\n');


test('link-origin guard: every way of reading the request\'s own address is an ERROR', async () => {
    const forbidden = {
        'req.hostname': 'const a = req.hostname;',
        'req.host': 'const a = req.host;',
        'req.protocol': 'const a = req.protocol;',
        'req.subdomains': 'const a = req.subdomains;',
        'req.get()': 'const a = req.get(\'host\');',
        'req.header()': 'const a = req.header(\'x-forwarded-host\');',
        'req.headers.host': 'const a = req.headers.host;',
        'req.headers[\'host\']': 'const a = req.headers[\'host\'];',
        'req.headers[\'x-forwarded-host\']': 'const a = req.headers[\'x-forwarded-host\'];',
        'req.headers[\'X-Forwarded-Proto\']': 'const a = req.headers[\'X-Forwarded-Proto\'];',
        'req.headers[\'x-forwarded-for\']': 'const a = req.headers[\'x-forwarded-for\'];'
    };
    for (const [label, line] of Object.entries(forbidden)) {
        const findings = await _guardFindings(_handler([line]), CONTROLLER_PATH);
        assert.equal(findings.length, 1, `${label} was not flagged exactly once: ${JSON.stringify(findings)}`);
        assert.match(findings[0].message, /PUBLIC_URL/, `${label}: the message must point at the one allowed origin.`);
    }
});

test('link-origin guard: ordinary header reads stay legal (user-agent, authorization) — the guard is not a blanket ban', async () => {
    const findings = await _guardFindings(_handler([
        'const agent = req.headers[\'user-agent\'];',
        'const auth = req.headers.authorization;',
        'const ip = req.ip;',
        'const body = req.body;',
        'void agent; void auth; void ip; void body;'
    ]), CONTROLLER_PATH);
    assert.deepEqual(findings, []);
});

test('BOTH guards fire from the SAME file — the host selectors did not replace the model selectors', async () => {
    const code = [
        '\'use strict\';',
        '',
        'import type { Request } from \'express\';',
        'import userModel = require(\'../../../models/auth/user.model\');',
        'import { AuthToken } from \'../../../models\';',
        'const legacy = require(\'../../../models/auth/adminUser.model\');',
        '',
        'const _origin = (req: Request): string => String(req.headers[\'x-forwarded-host\']) + req.protocol;',
        '',
        'export = { userModel, AuthToken, legacy, _origin };',
        ''
    ].join('\n');
    const findings = await _guardFindings(code, SERVICE_PATH);
    const byLine = findings.map((finding) => `${finding.line}:${finding.rule}`).sort();
    assert.deepEqual(byLine, [
        '4:@typescript-eslint/no-restricted-imports',
        '4:no-restricted-syntax',
        '5:@typescript-eslint/no-restricted-imports',
        '6:no-restricted-syntax',
        '8:no-restricted-properties',
        '8:no-restricted-syntax'
    ].sort(), `The layer guard or the link-origin guard stopped firing: ${JSON.stringify(findings)}`);
    assert.ok(findings.some((finding) => /repositories\/ folder/.test(finding.message)), 'The model-guard message is gone.');
});

test('repositories may import models, but still may not read the request\'s address', async () => {
    const code = [
        '\'use strict\';',
        '',
        'import userModel = require(\'../../../models/auth/user.model\');',
        '',
        'const _bad = (req: { hostname: string }): string => req.hostname;',
        '',
        'export = { userModel, _bad };',
        ''
    ].join('\n');
    const findings = await _guardFindings(code, REPOSITORY_PATH);
    assert.deepEqual(findings.map((finding) => `${finding.line}:${finding.rule}`), ['5:no-restricted-properties']);
});

test('the resolved config for a TypeScript file carries ONE no-restricted-syntax array holding both guards', async () => {
    const resolved = await eslint.calculateConfigForFile(SERVICE_PATH);
    const rule = resolved.rules['no-restricted-syntax'];
    assert.ok(Array.isArray(rule));
    const selectors = rule.slice(1).map((entry) => entry.selector);
    assert.ok(selectors.some((selector) => selector.includes('TSExternalModuleReference')), 'The model selectors are missing.');
    assert.ok(selectors.some((selector) => selector.includes('[Xx]-[Ff]orwarded-')), 'The X-Forwarded-* selector is missing.');
    assert.ok(selectors.some((selector) => selector.includes('property.name=\'host\'')), 'The req.headers.host selector is missing.');

    const properties = resolved.rules['no-restricted-properties'].slice(1).map((entry) => `${entry.object}.${entry.property}`).sort();
    assert.deepEqual(properties, ['req.get', 'req.header', 'req.host', 'req.hostname', 'req.protocol', 'req.subdomains']);
});
