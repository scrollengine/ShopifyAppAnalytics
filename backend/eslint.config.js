'use strict';

/**
 * ============================================================================
 *  ESLint flat config — shopify-app-analytics-backend
 * ============================================================================
 *
 *  Formatting model: ESLint only, NO Prettier. ESLint enforces 4-space indent,
 *  single quotes, semicolons and brace style and AUTOFIXES them; it never
 *  reflows your lines. Where you break a chain or a long expression is yours.
 *
 *  Two rules here are architecture rather than style:
 *
 *    - the LAYER GUARD: `src/models/**` may be imported ONLY from a
 *      `repositories/` folder. That is what keeps the data layer from leaking
 *      into services, helpers and controllers, and it is enforced across all
 *      three import forms this codebase actually uses (see the comment on it).
 *    - the LINK-ORIGIN GUARD: TypeScript under src/ may not read the request's
 *      idea of its own address (Host, protocol, X-Forwarded-*). Email links are
 *      built from `config.APP.PUBLIC_URL` alone (see the comment on it).
 *
 *  Install:  npm i
 *  Run:      npm run lint   /   npm run lint:fix
 * ============================================================================
 */

const stylistic = require('@stylistic/eslint-plugin');
const globals = require('globals');

// Parser + plugin only. We deliberately do NOT spread a typescript-eslint
// preset: `recommended` turns on no-explicit-any and no-require-imports, and
// this codebase requires `import x = require('…')` by convention (every module
// ends in `export =`, and TypeScript rejects a named import from one — TS2497).
const tseslint = require('typescript-eslint');

// The "off-screen" threshold for the max-len WARNING. It only warns; it never
// wraps a line for you.
const MAX_LINE = 160;

// `varsIgnorePattern: '^_'` is load-bearing, not cosmetic: every controller
// handler is `_`-prefixed by house rule (`_getRevenueOverview`, …).
const UNUSED_VARS_OPTIONS = {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrors: 'none'
};

// ---------------------------------------------------------------------------
//  The layer guard.
// ---------------------------------------------------------------------------
//  Import SOURCE STRINGS that reach the model layer. Matched against the
//  literal text of the import, e.g. '../../models/subscriptionCharge'.
const MODEL_IMPORT_PATTERNS = ['**/models', '**/models/*', '**/models/**'];

const MODEL_IMPORT_MESSAGE =
    'src/models/** may only be imported from a repositories/ folder. ' +
    'Repositories are the single boundary that touches mongoose — put the query there and ' +
    'import the repository instead.';

//  esquery selector fragment matching the same thing for the CommonJS import
//  forms, which `no-restricted-imports` cannot see. NOTE: esquery regexes may
//  not contain a `/` at all (its grammar reads the literal as `[^/]+`), even
//  escaped — so the path separator is expressed as "not a word character"
//  instead. This matches '../models', '../../models/foo' and 'src/models/foo'
//  while leaving './dataModels' and '../utils/modelsHelper' alone.
const MODEL_PATH_RE = '/(^|[^A-Za-z0-9_])models($|[^A-Za-z0-9_])/';

const RESTRICTED_MODEL_SYNTAX = [
    {
        // require('../models/foo')
        selector: `CallExpression[callee.name='require'] > Literal[value=${MODEL_PATH_RE}]`,
        message: MODEL_IMPORT_MESSAGE
    },
    {
        // import foo = require('../models/foo')  — the house import form for
        // `export =` modules, and the one a plain no-restricted-imports misses.
        selector: `TSExternalModuleReference > Literal[value=${MODEL_PATH_RE}]`,
        message: MODEL_IMPORT_MESSAGE
    }
];

// ---------------------------------------------------------------------------
//  The link-origin guard.
// ---------------------------------------------------------------------------
//  Setup, invitation and password-reset links are built from
//  `config.APP.PUBLIC_URL` and from nothing the request says about itself. The
//  Host header, the protocol and every X-Forwarded-* header are written by
//  whoever sends the request, so a reset link built from them points wherever
//  the sender chooses — and carries the victim's token there when clicked.
//
//  `req.get()` and `req.header()` are banned outright because their argument
//  is a runtime string these rules cannot follow. Headers are read as
//  `req.headers['name']` (e.g. `req.headers['user-agent']`), which the
//  selectors below CAN see.
const LINK_ORIGIN_MESSAGE =
    'Never read the request\'s own address (Host, protocol, X-Forwarded-*): the caller writes it. ' +
    'Build links from config.APP.PUBLIC_URL only.';

const HEADER_ACCESSOR_MESSAGE =
    'Read headers as req.headers[\'name\'] so the link-origin guard can see which header is read. ' +
    'Never read Host or X-Forwarded-* at all — build links from config.APP.PUBLIC_URL.';

const RESTRICTED_REQ_PROPERTIES = [
    { object: 'req', property: 'hostname', message: LINK_ORIGIN_MESSAGE },
    { object: 'req', property: 'host', message: LINK_ORIGIN_MESSAGE },
    { object: 'req', property: 'protocol', message: LINK_ORIGIN_MESSAGE },
    { object: 'req', property: 'subdomains', message: LINK_ORIGIN_MESSAGE },
    { object: 'req', property: 'get', message: HEADER_ACCESSOR_MESSAGE },
    { object: 'req', property: 'header', message: HEADER_ACCESSOR_MESSAGE }
];

//  Appended to the SAME no-restricted-syntax array as the model guard: ESLint
//  replaces a rule's options wholesale, so a second config object setting this
//  rule would silently switch one of the two guards off.
const RESTRICTED_HOST_SYNTAX = [
    {
        // req.headers.host
        selector: `MemberExpression[object.object.name='req'][object.property.name='headers'][property.name='host']`,
        message: LINK_ORIGIN_MESSAGE
    },
    {
        // req.headers['host']
        selector: `MemberExpression[object.object.name='req'][object.property.name='headers'][property.value='host']`,
        message: LINK_ORIGIN_MESSAGE
    },
    {
        // req.headers['x-forwarded-host'], req.headers['x-forwarded-proto'], ...
        selector: `MemberExpression[object.object.name='req'][object.property.name='headers'][property.value=/^[Xx]-[Ff]orwarded-/]`,
        message: LINK_ORIGIN_MESSAGE
    }
];

// The house rule table. Applied verbatim to .js and .ts alike so the two can
// never drift; the TS block overrides exactly two entries, each documented at
// its override site.
const HOUSE_RULES = {
    // ---- Layout / formatting (autofixable) ----
    '@stylistic/indent': ['error', 4, { SwitchCase: 1 }],
    '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
    '@stylistic/semi': ['error', 'always'],
    '@stylistic/brace-style': ['error', '1tbs'],
    '@stylistic/object-curly-spacing': ['error', 'always'],
    '@stylistic/keyword-spacing': 'error',
    '@stylistic/space-before-blocks': 'error',
    '@stylistic/space-infix-ops': 'error',
    '@stylistic/comma-spacing': ['error', { before: false, after: true }],
    '@stylistic/key-spacing': ['error', { beforeColon: false, afterColon: true }],
    '@stylistic/arrow-spacing': 'error',
    '@stylistic/no-multi-spaces': 'error',
    '@stylistic/no-trailing-spaces': 'error',
    '@stylistic/eol-last': ['error', 'always'],
    '@stylistic/no-multiple-empty-lines': ['error', { max: 3, maxEOF: 1, maxBOF: 0 }],

    // Always braces — no brace-less one-liners.
    'curly': ['error', 'all'],

    // ---- Line breaks are YOURS, not the tool's ----
    '@stylistic/newline-per-chained-call': 'off',
    'max-len': ['warn', {
        code: MAX_LINE,
        tabWidth: 4,
        ignoreComments: true,
        ignoreTrailingComments: true,
        ignoreUrls: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreRegExpLiterals: true
    }],

    // ---- Correctness ----
    'no-undef': 'error',
    'no-unused-vars': ['warn', UNUSED_VARS_OPTIONS],
    'no-var': 'error',

    // ---- Deliberately off: would fight the house style ----
    'prefer-const': 'off',
    'eqeqeq': 'off',
    '@stylistic/comma-dangle': 'off'
};

module.exports = [
    {
        ignores: [
            'node_modules/**',
            'dist/**',
            'coverage/**',
            '**/*.min.js'
        ]
    },

    // ---------------------------------------------------------------- JS ----
    // This config file itself, and the test suite (tests are plain .js so they
    // run under `node --test` with no compile step). Tests may reach anywhere,
    // including the model layer — asserting on schemas is legitimate.
    {
        files: ['**/*.js'],
        plugins: {
            '@stylistic': stylistic
        },
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: {
                ...globals.node
            }
        },
        rules: {
            ...HOUSE_RULES
        }
    },

    // ---------------------------------------------------------------- TS ----
    {
        files: ['**/*.ts'],
        plugins: {
            '@stylistic': stylistic,
            '@typescript-eslint': tseslint.plugin
        },
        languageOptions: {
            // Must be >= 2015. At ecmaVersion 5 the TS parser still parses
            // everything, but ESLint injects only the ES5 global set and
            // no-undef then invents false positives for Promise / Map / Set.
            ecmaVersion: 2023,
            // 395-style top-level `require()` calls live in .ts files here.
            sourceType: 'commonjs',
            parser: tseslint.parser,
            // NO parserOptions.project — deliberately no type-aware linting.
            // Every rule above is syntactic, so type information buys nothing
            // and costs roughly 3x per file. `npm run typecheck` is the type
            // check; ESLint is the style and layer check.
            globals: {
                ...globals.node
            }
        },
        rules: {
            ...HOUSE_RULES,

            // ---- The two TS deltas ----

            // OFF, and this is typescript-eslint's own standing guidance, not a
            // relaxation: ESLint's scope analyser cannot see TYPE space, so
            // `NodeJS.Timeout`, any `declare global` binding and any
            // namespace-qualified type (`Express.Request`) are all reported as
            // undefined. The check is not lost — tsc reports ts(2304) in the
            // editor and under `npm run typecheck`.
            'no-undef': 'off',

            // Swapped for the typescript-eslint extension rule with the SAME
            // options object, so severity and behaviour stay at parity. The base
            // rule cannot see TS declaration forms and reports enum members,
            // ambient `declare` bindings and mapped-type keys as unused.
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', UNUSED_VARS_OPTIONS],

            // ---- The layer guard ----
            // Two rules, because no single one sees every import form:
            //   no-restricted-imports  → `import x from '../models/y'`
            //   no-restricted-syntax   → `require('../models/y')` and
            //                            `import x = require('../models/y')`
            // Dropping either one leaves a hole the house import style walks
            // straight through.
            '@typescript-eslint/no-restricted-imports': ['error', {
                patterns: [{
                    group: MODEL_IMPORT_PATTERNS,
                    message: MODEL_IMPORT_MESSAGE
                }]
            }],
            // Also carries the link-origin selectors: ONE array for both
            // guards (see RESTRICTED_HOST_SYNTAX for why).
            'no-restricted-syntax': ['error', ...RESTRICTED_MODEL_SYNTAX, ...RESTRICTED_HOST_SYNTAX],

            // ---- The link-origin guard ----
            'no-restricted-properties': ['error', ...RESTRICTED_REQ_PROPERTIES]
        }
    },

    // ------------------------------------------------- layer-guard exempt ----
    // Repositories are the boundary that is SUPPOSED to touch models — they are
    // the only files allowed to import them. Model files may also refer to each
    // other (a schema referencing a sibling).
    //
    // Ordering matters: flat config merges every matching block in order, so
    // this must come AFTER the `**/*.ts` block it narrows.
    //
    // Turning no-restricted-syntax off here also drops the link-origin
    // selectors for these files. That costs nothing: a repository or a schema
    // never holds a request. no-restricted-properties stays on everywhere.
    {
        files: ['src/**/repositories/**/*.ts', 'src/models/**/*.ts'],
        rules: {
            '@typescript-eslint/no-restricted-imports': 'off',
            'no-restricted-syntax': 'off'
        }
    },

    // ------------------------------------------------------------- .d.ts ----
    // `declare var` is the only ambient form that puts a name on
    // `typeof globalThis` — `declare let` / `declare const` do not — so an
    // ambient declaration file is CORRECT to use it, and no-var's fixer
    // declines to touch those, which would leave permanent unfixable errors.
    {
        files: ['**/*.d.ts'],
        rules: {
            'no-var': 'off'
        }
    }
];
