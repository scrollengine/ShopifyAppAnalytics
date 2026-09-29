'use strict';

/**
 * ============================================================================
 *  EXPORT SURFACE — every barrel enumerates its keys, and every key resolves
 * ============================================================================
 *
 *  Two rules, asserted rather than documented:
 *
 *    1. A module surface is a FLAT OBJECT LITERAL WITH EVERY KEY WRITTEN OUT.
 *       Never `...spread`. A spread type-checks perfectly and still destroys
 *       the property that makes the surface reviewable: that you can read a
 *       barrel and know what it publishes. Nothing that is not a compiler — no
 *       reviewer, no grep, no test — can answer that question through a spread.
 *
 *    2. EVERY ENUMERATED KEY RESOLVES TO SOMETHING. A key whose value is
 *       `undefined` is worse than a missing key: the import succeeds, the
 *       destructure succeeds, and the failure arrives later as
 *       `x is not a function` on whichever request touches it first.
 *
 *  ── Rule 2 is not hypothetical ──────────────────────────────────────────────
 *  This test, on its first run, found four of them. `models.repository.ts`
 *  published `ListingFunnelDailyModel`, `ListingSourceDailyModel`,
 *  `ListingGeoDailyModel` and `ListingInstallAttributionModel`, destructured
 *  from a model registry that exports none of them. The registry is consumed
 *  through a bare `require` — deliberately, so one file can hold every cast —
 *  so its type is `any`, all four destructured to `undefined`, and `undefined
 *  as mongoose.Model<T>` is a cast TypeScript accepts without complaint. Four
 *  published, typed, entirely non-existent models, and `tsc --noEmit` was
 *  clean. That is precisely the shape of bug this file exists to find.
 *
 *  ── Why static and runtime are compared, rather than a stored baseline ──────
 *  A checked-in baseline of key names has to be re-captured whenever the
 *  surface legitimately changes, and a blind re-capture launders exactly the
 *  regression it was supposed to catch. Comparing the module's own SOURCE TEXT
 *  against what it actually exports needs no baseline and cannot be laundered:
 *  it asserts that the enumerated list IS the surface, which is the property
 *  the convention was adopted for.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    readExportSurfaceStatic,
    readExportSurfaceRuntime,
    diffSurface,
    stripComments,
    parseKeys,
    listTypeScriptFiles,
    hasObjectExportSurface
} = require('./_harness/exportSurface');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(BACKEND_ROOT, 'src');

/** Path relative to the backend root, for readable assertion messages. */
const _rel = (filePath) => path.relative(BACKEND_ROOT, filePath);

/** Every `.ts` file under `src/`, `.d.ts` excluded. */
const ALL_TS_FILES = listTypeScriptFiles(SRC_ROOT);

/** The files that publish a key set: those ending in `export = { … }`. */
const OBJECT_SURFACE_FILES = ALL_TS_FILES.filter(hasObjectExportSurface);

/**
 * The module barrels — the surfaces that other modules import THROUGH, and therefore the ones whose
 * drift is felt furthest from where it was introduced.
 *
 * `src/routes/index.ts` is deliberately excluded by the object-surface filter: it is an index file
 * but it publishes a single VALUE (`export = router`), not a key set. Its own contract — that it is
 * a router and not an object — is asserted separately below.
 */
const BARRELS = ALL_TS_FILES
    .filter((filePath) => path.basename(filePath) === 'index.ts')
    .filter(hasObjectExportSurface);

/**
 * Files that publish a single VALUE rather than a key set, and are checked only for the `export =`
 * form: route files (`export = router`) and the config (`export = Object.freeze(config)`).
 *
 * @param {String} filePath - Absolute path to a .ts file.
 * @returns {Boolean} True when the file legitimately has no object surface.
 */
const _isSingleValueSurface = (filePath) => {
    const source = stripComments(fs.readFileSync(filePath, 'utf8'));
    return /export\s*=\s*[A-Za-z_$][\w$.]*\s*(?:\([\s\S]*?\))?\s*;?\s*$/.test(source);
};

/**
 * Process ENTRY POINTS — files that are executed, never imported.
 *
 * Each is invoked by `node <file>` (or an npm script), runs, and ends in
 * `process.exit`. They carry `export {}` purely to be modules under `isolatedModules`; publishing a
 * surface would be meaningless because nothing ever requires them.
 *
 * ENUMERATED BY EXACT PATH, NEVER BY DIRECTORY. The tempting shortcut when the demo seeder tripped
 * this was to skip `src/scripts/` wholesale — which would have silently stopped guarding
 * `src/scripts/{services,helpers,repositories,constants}`, every one of which IS a real module with a
 * published surface. An exemption that grows by directory stops being an exemption and becomes a
 * hole. If you are adding a fifth entry, it must genuinely be a file nothing imports.
 */
const ENTRY_POINTS = [
    path.join('src', 'apps', 'app.ts'),
    path.join('src', 'scripts', 'seedDemo.ts'),
    path.join('src', 'scripts', 'teardownDemo.ts'),
    path.join('src', 'scripts', 'authAdmin.ts')
];

/**
 * Files with no runtime surface at all: type declarations, and the process entry points.
 *
 * @param {String} filePath - Absolute path to a .ts file.
 * @returns {Boolean} True when the file is not expected to export anything at run time.
 */
const _isDeclarationOnly = (filePath) => {
    const rel = _rel(filePath);
    return rel.includes(`${path.sep}types${path.sep}`)
        || rel.endsWith('.types.ts')
        || ENTRY_POINTS.includes(rel);
};


/* ==========================================================================
 *  1. The rule itself: a spread is refused
 * ========================================================================== */

test(' a spread in an export block THROWS rather than being skipped', () => {
    // The enforcement, proven directly. If `parseKeys` ever started tolerating a spread — returning
    // the keys it could see and ignoring the rest — every assertion below would keep passing while
    // the surface quietly stopped being enumerable.
    assert.throws(
        () => parseKeys(' ...someService, explicitKey: value '),
        /Spread in the export block/,
        'parseKeys accepted a spread. The whole convention rests on this refusal.'
    );

    // And the keys around it are not what makes it throw — a fully enumerated block parses fine.
    assert.deepEqual(parseKeys(' alpha, beta: gamma.delta, "quoted": 1 '), ['alpha', 'beta', 'quoted']);
});

test('no module in src/ spreads into its export block', () => {
    const offenders = [];
    for (const filePath of OBJECT_SURFACE_FILES) {
        try {
            readExportSurfaceStatic(filePath);
        } catch (error) {
            offenders.push(`${_rel(filePath)}: ${error.message}`);
        }
    }
    assert.deepEqual(
        offenders,
        [],
        'Enumerate every key explicitly. A spread cannot be read by anything but the compiler.'
    );
});


/* ==========================================================================
 *  2. The barrels
 * ========================================================================== */

test('every module barrel was found', () => {
    // Guards against the whole file passing because the discovery walk returned nothing.
    const relative = BARRELS.map(_rel).sort();
    assert.ok(relative.length >= 5, `Only ${relative.length} barrels discovered: ${relative.join(', ')}`);
    for (const expected of ['auth', 'conversion', 'mail', 'partner', 'revenue', 'sync']) {
        assert.ok(
            relative.includes(path.join('src', 'modules', expected, 'index.ts')),
            `The ${expected} module has no index.ts barrel, or the walk missed it.`
        );
    }
});

test('the route index publishes a mountable router, not an object', () => {
    // The one index.ts in the codebase that is NOT a key-set barrel. It has to BE the router,
    // because `src/apps/app.ts` does `app.use(routes)` — hand Express anything else and every
    // route 404s at run time with nothing to say why.
    const routesIndex = require(path.join(SRC_ROOT, 'routes', 'index.ts'));
    assert.equal(typeof routesIndex, 'function', 'src/routes/index.ts must export the router itself.');
    assert.ok(Array.isArray(routesIndex.stack), 'src/routes/index.ts exported a function that is not an Express router.');
    assert.equal(routesIndex.default, undefined, 'The router is nested under .default — that is `export default`, and Express cannot mount it.');
});

test(' every barrel enumerates keys, and its written list IS its surface', () => {
    const mismatches = [];
    for (const filePath of BARRELS) {
        const declared = readExportSurfaceStatic(filePath);
        const actual = readExportSurfaceRuntime(filePath);
        const diff = diffSurface(declared, actual);
        if (!diff.equal) {
            mismatches.push(`${_rel(filePath)} — written but not exported: [${diff.removed.join(', ')}]; exported but not written: [${diff.added.join(', ')}]`);
        }
        assert.ok(declared.length > 0, `${_rel(filePath)} enumerates no keys at all.`);
    }
    assert.deepEqual(mismatches, [], 'A barrel says one thing and exports another:');
});

test(' no barrel publishes a key whose value is undefined', () => {
    const dangling = [];
    for (const filePath of BARRELS) {
        const surface = require(filePath);
        for (const key of Object.keys(surface)) {
            if (surface[key] === undefined) {
                dangling.push(`${_rel(filePath)} → ${key}`);
            }
        }
    }
    assert.deepEqual(
        dangling,
        [],
        'Each key above imports cleanly, destructures cleanly, and is undefined at the call site. '
        + 'The member it re-exports has been renamed or removed.'
    );
});


/* ==========================================================================
 *  3. Every module, not just the barrels
 * ========================================================================== */

test('every export = { … } module in src/ agrees with its own source text', () => {
    assert.ok(OBJECT_SURFACE_FILES.length >= 20, `Only ${OBJECT_SURFACE_FILES.length} modules found — the walk is not seeing src/.`);

    const mismatches = [];
    for (const filePath of OBJECT_SURFACE_FILES) {
        const declared = readExportSurfaceStatic(filePath);
        const actual = readExportSurfaceRuntime(filePath);
        const diff = diffSurface(declared, actual);
        if (!diff.equal) {
            mismatches.push(`${_rel(filePath)} — missing: [${diff.removed.join(', ')}]; unexpected: [${diff.added.join(', ')}]`);
        }
    }
    assert.deepEqual(mismatches, [], 'Source text and runtime surface disagree:');
});

test(' no module in src/ publishes a key whose value is undefined', () => {
    // The assertion that caught the four phantom Listing models. It reaches further than the barrel
    // version above because a repository or client is where an untyped `require` actually lives.
    const dangling = [];
    for (const filePath of OBJECT_SURFACE_FILES) {
        const surface = require(filePath);
        for (const key of Object.keys(surface)) {
            if (surface[key] === undefined) {
                dangling.push(`${_rel(filePath)} → ${key}`);
            }
        }
    }
    assert.deepEqual(dangling, [], 'Published, importable, and undefined:');
});


/* ==========================================================================
 *  4. The export= contract
 * ========================================================================== */

test(' nothing in src/ uses export default', () => {
    // `export default` nests the module one level deeper under `.default`. A parent that does
    // `import x = require('./routes')` then `router.use('/api', x)` hands Express an object it
    // cannot mount — at run time, with no build error, and the symptom is a 404 on every route
    // rather than anything that names the cause.
    const offenders = [];
    for (const filePath of ALL_TS_FILES) {
        const source = stripComments(fs.readFileSync(filePath, 'utf8'));
        if (/\bexport\s+default\b/.test(source)) {
            offenders.push(_rel(filePath));
        }
    }
    assert.deepEqual(offenders, [], 'Use `export =`. Consumers require these modules as CommonJS objects.');
});

test('every runtime module in src/ ends in an export assignment', () => {
    const missing = [];
    for (const filePath of ALL_TS_FILES) {
        if (_isDeclarationOnly(filePath)) {
            continue;
        }
        if (hasObjectExportSurface(filePath) || _isSingleValueSurface(filePath)) {
            continue;
        }
        missing.push(_rel(filePath));
    }
    assert.deepEqual(
        missing,
        [],
        'These files export nothing in the `export =` form. Either they are type declarations (put '
        + 'them under a types/ folder or name them *.types.ts) or they are missing their surface.'
    );
});
