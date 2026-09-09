'use strict';

/**
 * ============================================================================
 *  EXPORT-SURFACE EXTRACTION
 * ============================================================================
 *
 *  Reads a module's public key set out of its SOURCE TEXT, without requiring
 *  it. Ported from the system this project was extracted from, where the same
 *  harness locks the module barrels.
 *
 *  ── Why the surface is worth locking at all ─────────────────────────────────
 *  Every module here ends in `export = { … }` and every consumer destructures
 *  that object. TypeScript checks the destructure against the module's TYPE, so
 *  a key deleted from a barrel is a compile error — as long as the consumer is
 *  TypeScript. The two things that slip through are:
 *
 *    1. A SPREAD in the barrel (`...someService`). The types still resolve, so
 *       nothing complains, but the surface is no longer readable by anything
 *       that is not a compiler: not a reviewer, not a grep, not this harness.
 *       The list stops being a list.
 *    2. A key enumerated in the barrel whose VALUE is `undefined` — a typo in
 *       the member name, or a re-export of something a module no longer has.
 *       `{ foo: bar.typo }` is `undefined` at run time and, when `bar` came in
 *       through an untyped `require`, it type-checks perfectly.
 *
 *  So this file gives a test two independent readings of the same module — the
 *  STATIC one (parse the text) and the RUNTIME one (`Object.keys(require(…))`)
 *  — and the test asserts they agree. Disagreement is the whole signal: it
 *  means the enumerated list is no longer the surface.
 *
 *   `parseKeys` THROWS on a spread. That is not a limitation being worked
 *  around; it is the rule being enforced. Enumerate the keys.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

/**
 * Matches the LAST `export = { … }` / `module.exports = { … }` block in a file.
 *
 * Anchored to end-of-file, and `[\s\S]*` is greedy, so it starts matching at the FIRST such token
 * anywhere in the text. That is exactly why callers strip comments BEFORE matching — see
 * `readExportSurfaceStatic`.
 */
const EXPORT_BLOCK_RE = /(?:module\.exports|export)\s*=\s*\{([\s\S]*)\}\s*;?\s*$/;

/**
 * Strips line and block comments without touching string literals.
 *
 * String-aware on purpose: a `//` inside a URL in a string, or a `/*` inside a regex-ish literal,
 * must not open a comment. Quotes are tracked, escapes are consumed with their following character.
 *
 * @param {String} source - Raw source text.
 * @returns {String} The source with every comment removed and everything else intact.
 */
const stripComments = (source) => {
    let out = '';
    let mode = 'code';
    let quote = '';
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        const next = source[i + 1];
        if (mode === 'code') {
            if (quote) {
                out += ch;
                if (ch === '\\') {
                    out += next || '';
                    i += 1;
                } else if (ch === quote) {
                    quote = '';
                }
                continue;
            }
            if (ch === '"' || ch === "'" || ch === '`') {
                quote = ch;
                out += ch;
                continue;
            }
            if (ch === '/' && next === '/') {
                mode = 'line';
                i += 1;
                continue;
            }
            if (ch === '/' && next === '*') {
                mode = 'block';
                i += 1;
                continue;
            }
            out += ch;
            continue;
        }
        if (mode === 'line') {
            if (ch === '\n') {
                mode = 'code';
                out += ch;
            }
            continue;
        }
        if (mode === 'block' && ch === '*' && next === '/') {
            mode = 'code';
            i += 1;
        }
    }
    return out;
};

/**
 * Splits the body of an object literal into top-level entries and returns their key names.
 *
 * Depth-aware, so a nested object, array or call in a VALUE never yields a phantom key, and
 * quote-aware, so a brace inside a string does not shift the depth.
 *
 *  THROWS on a spread. A spread is the one thing that makes the surface unreadable statically,
 * which is precisely what this harness exists to prevent — so it is refused here rather than
 * silently skipped, and the message says what to do instead.
 *
 * @param {String} body - The text between the outermost braces of the export block.
 * @returns {String[]} The exported key names, sorted.
 */
const parseKeys = (body) => {
    const clean = stripComments(body);
    const entries = [];
    let depth = 0;
    let quote = '';
    let current = '';
    for (let i = 0; i < clean.length; i += 1) {
        const ch = clean[i];
        if (quote) {
            current += ch;
            if (ch === '\\') {
                current += clean[i + 1] || '';
                i += 1;
            } else if (ch === quote) {
                quote = '';
            }
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === '{' || ch === '[' || ch === '(') {
            depth += 1;
        }
        if (ch === '}' || ch === ']' || ch === ')') {
            depth -= 1;
        }
        if (ch === ',' && depth === 0) {
            entries.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    entries.push(current);

    const keys = [];
    for (const entry of entries) {
        const head = entry.split(':')[0].trim().replace(/^["'`]|["'`]$/g, '');
        if (/^\.\.\./.test(head)) {
            throw new Error(`Spread in the export block ("${head}") — the surface cannot be read statically. Enumerate the keys explicitly.`);
        }
        if (/^[A-Za-z_$][\w$]*$/.test(head)) {
            keys.push(head);
        }
    }
    return keys.sort();
};

/**
 * Reads a module's export key set from SOURCE TEXT. No require, no side effects.
 *
 * Comments are stripped BEFORE the regex runs, not merely from the captured body. Every barrel in
 * this codebase carries a header comment that quotes the `export =` convention, and an unstripped
 * match would begin at that comment, capture it plus the real block, and report every genuine key
 * as missing against a completely correct file.
 *
 * @param {String} filePath - Absolute path to a .ts or .js module.
 * @returns {String[]} Sorted export key names.
 */
const readExportSurfaceStatic = (filePath) => {
    const source = stripComments(fs.readFileSync(filePath, 'utf8'));
    const match = source.match(EXPORT_BLOCK_RE);
    if (!match) {
        throw new Error(`No trailing "export = { … }" block in ${filePath}. A module surface must be one flat object literal.`);
    }
    return parseKeys(match[1]);
};

/**
 * Reads a module's export key set by REQUIRING it.
 *
 * Safe here because nothing in this codebase opens a socket at import: `core/db` calls
 * `mongoose.connect` inside `initDb()`, and the schemas only register themselves. A module that
 * started connecting on require would make this reader hang, which is itself a finding.
 *
 * @param {String} modulePath - Absolute path to the module.
 * @returns {String[]} Sorted runtime key names.
 */
const readExportSurfaceRuntime = (modulePath) => Object.keys(require(modulePath)).sort();

/**
 * Diffs two key sets.
 *
 * @param {String[]} expected - The reference key set.
 * @param {String[]} actual - The key set under test.
 * @returns {{ added: String[], removed: String[], equal: Boolean }} What each side has that the other does not.
 */
const diffSurface = (expected, actual) => {
    const added = actual.filter((key) => !expected.includes(key));
    const removed = expected.filter((key) => !actual.includes(key));
    return { added, removed, equal: added.length === 0 && removed.length === 0 };
};

/**
 * Every `.ts` file under a directory, recursively, sorted for a stable test order.
 *
 * `.d.ts` files are skipped: they declare types and have no runtime surface to read.
 *
 * @param {String} dir - Absolute directory to walk.
 * @returns {String[]} Absolute file paths.
 */
const listTypeScriptFiles = (dir) => {
    const found = [];
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === 'dist') {
                    continue;
                }
                walk(full);
                continue;
            }
            if (entry.isFile() && full.endsWith('.ts') && !full.endsWith('.d.ts')) {
                found.push(full);
            }
        }
    };
    walk(dir);
    return found.sort();
};

/**
 * True when a file ends in an `export = { … }` object literal — i.e. it publishes a KEY SET rather
 * than a single value.
 *
 * The distinction matters because the two other legal shapes in this codebase publish no key set to
 * lock: a route file is `export = router` and the config is `export = Object.freeze(config)`. Those
 * are checked for the `export =` form itself, not for their keys.
 *
 * @param {String} filePath - Absolute path to a .ts file.
 * @returns {Boolean} True when the file's surface is a flat object literal.
 */
const hasObjectExportSurface = (filePath) => {
    return EXPORT_BLOCK_RE.test(stripComments(fs.readFileSync(filePath, 'utf8')));
};

module.exports = {
    readExportSurfaceStatic,
    readExportSurfaceRuntime,
    diffSurface,
    stripComments,
    parseKeys,
    listTypeScriptFiles,
    hasObjectExportSurface,
    EXPORT_BLOCK_RE
};
