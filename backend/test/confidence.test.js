'use strict';

/**
 * ============================================================================
 *  THE CONFIDENCE ENVELOPE — the project's core promise, under test
 * ============================================================================
 *
 *  The README makes one public commitment: a figure that cannot be computed is
 *  published as `null` WITH A REASON, never as `0`. Everything else in this
 *  backend is an implementation detail by comparison — a wrong MRR is a bug, but
 *  a `0` standing in for "we do not know" is a lie with a chart drawn under it,
 *  and it is indistinguishable from a real business outcome.
 *
 *  ── The two directions, both of which have to hold ──────────────────────────
 *  UNKNOWN MUST NOT BECOME ZERO. A month before our records start, a ratio with
 *  an empty denominator, a source never connected — each must surface as `null`
 *  plus a reason a human can read.
 *
 *  ZERO MUST NOT BECOME UNKNOWN. A measured `0` is a real answer about the
 *  business — "nobody was paying you in March" — and downgrading it to "we
 *  cannot say" is the same failure with the sign flipped. That is why the
 *  helper's missing-value check is `=== null || === undefined || !isFinite`
 *  and never `!value`: a falsy check would erase the exact zero this whole
 *  primitive exists to distinguish.
 *
 *  ── Why NaN and Infinity are treated as missing ─────────────────────────────
 *  They are what an empty denominator actually produces. Both are typed
 *  `number`, so every guard upstream passes them through, and both render as
 *  the literal words "NaN" and "Infinity" on a dashboard. They are not values;
 *  they are the arithmetic failing, and they belong in the same bucket as
 *  `null`.
 *
 *   These tests run in STRICT MODE deliberately ('use strict' above). The
 *  envelope is frozen, and a write to a frozen object THROWS in strict mode but
 *  silently no-ops in sloppy mode. A sloppy-mode test file would assert nothing
 *  about immutability while appearing to.
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const confidence = require(path.resolve(__dirname, '..', 'src', 'modules', 'shared', 'helpers', 'confidence.helper.ts'));

const { measured, derived, estimated, unknown } = confidence;

const SOURCE = 'settled payouts';

/**
 * Asserts that an envelope carries no answer, in every way a reader or a renderer might ask.
 *
 * The point of checking so many equivalent things is that they are NOT equivalent to a consumer:
 * `value == null` is true for `undefined` too, `!value` is true for `0`, and `JSON.stringify` is
 * where a `undefined` would silently vanish from the wire entirely. Only an exact `null` behaves
 * correctly at all three.
 *
 * @param {Object} envelope - The envelope under test.
 * @param {String} label - What produced it, for the failure message.
 * @returns {void}
 */
const assertNoAnswer = (envelope, label) => {
    assert.equal(envelope.confidence, 'unknown', `${label}: confidence must be 'unknown'`);
    assert.equal(envelope.value, null, `${label}: value must be null`);
    assert.ok(Object.is(envelope.value, null), `${label}: value must be exactly null, not undefined`);
    assert.notEqual(envelope.value, 0, `${label}:  value is 0 — unknown was coerced to zero`);
    assert.ok(!Object.is(envelope.value, 0) && !Object.is(envelope.value, -0), `${label}: value is a zero`);
    assert.equal(typeof envelope.reason, 'string', `${label}: an unknown must carry a reason`);
    assert.ok(envelope.reason.length > 0, `${label}: the reason must not be empty`);

    // The wire boundary. `undefined` would be dropped from the JSON entirely and the field would
    // read as absent rather than as unknown; a `0` would read as an answer.
    const wire = JSON.parse(JSON.stringify(envelope));
    assert.ok('value' in wire, `${label}: value disappeared from the serialised envelope`);
    assert.equal(wire.value, null, `${label}: serialised value is not null`);

    //  Nothing ANYWHERE in the envelope may be a zero standing in for the missing figure.
    for (const [key, entry] of Object.entries(envelope)) {
        assert.ok(
            !Object.is(entry, 0) && !Object.is(entry, -0),
            `${label}: field "${key}" is 0 inside an unknown envelope`
        );
    }
};

/**
 * Asserts that an envelope carries a real answer of the expected value and confidence.
 *
 * @param {Object} envelope - The envelope under test.
 * @param {*} expectedValue - The value it must hold, compared with Object.is so `0` and `-0` differ.
 * @param {String} expectedConfidence - measured / derived / estimated.
 * @param {String} label - What produced it, for the failure message.
 * @returns {void}
 */
const assertAnswer = (envelope, expectedValue, expectedConfidence, label) => {
    assert.equal(envelope.confidence, expectedConfidence, `${label}: wrong confidence`);
    assert.ok(Object.is(envelope.value, expectedValue), `${label}: expected ${String(expectedValue)}, got ${String(envelope.value)}`);
    assert.equal(envelope.reason, undefined, `${label}: an answered figure must not carry a reason`);
};


/* ==========================================================================
 *  1. unknown() — the constructor the promise rests on
 * ========================================================================== */

test(' unknown() yields value: null, never 0', () => {
    assertNoAnswer(unknown('no partner data before 2024-03', SOURCE), 'unknown()');
});

test('unknown() keeps the reason it was given and names its source', () => {
    const envelope = unknown('no partner data before 2024-03', SOURCE);
    assert.equal(envelope.reason, 'no partner data before 2024-03');
    assert.equal(envelope.source, SOURCE);
    assert.equal(envelope.caveat, undefined, 'an unknown has no caveat — the reason is the whole story');
});

test('unknown() refuses to publish an empty reason or an invented source', () => {
    // An unknown with a blank reason renders as an em dash with no explanation, which is
    // indistinguishable from a rendering bug. And a missing source must read as 'none' rather than
    // as a plausible-looking name nobody chose.
    const blank = unknown('');
    assert.ok(blank.reason.length > 0, 'a blank reason was published as-is');
    assert.equal(blank.source, 'none');
    assert.equal(blank.value, null);
});


/* ==========================================================================
 *  2. Missing values are downgraded, never zeroed
 * ========================================================================== */

test(' every constructor downgrades a missing value to unknown with value: null', () => {
    const missingValues = [
        ['null', null],
        ['undefined', undefined],
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
        ['0/0', 0 / 0],
        ['1/0', 1 / 0]
    ];

    for (const [label, value] of missingValues) {
        assertNoAnswer(measured(value, SOURCE), `measured(${label})`);
        assertNoAnswer(derived(value, SOURCE, 'mrr / active_subs'), `derived(${label})`);
        assertNoAnswer(estimated(value, SOURCE, 'assumes a 30-day settlement lag'), `estimated(${label})`);
    }
});

test('a downgraded figure says WHICH computation came up empty', () => {
    // "not available" tells a reader nothing they can act on. The downgrade carries the basis or
    // the source forward so the reason names the thing that failed.
    assert.match(derived(NaN, SOURCE, 'mrr / active_subs').reason, /mrr \/ active_subs/);
    assert.match(measured(null, 'partner api events').reason, /partner api events/);
    assert.match(estimated(undefined, SOURCE, 'x').reason, /settled payouts/);
});


/* ==========================================================================
 *  3. A real zero survives — the same failure with the sign flipped
 * ========================================================================== */

test(' a measured 0 stays a measured 0 and is NOT downgraded to unknown', () => {
    const envelope = measured(0, SOURCE);
    assertAnswer(envelope, 0, 'measured', 'measured(0)');

    const wire = JSON.parse(JSON.stringify(envelope));
    assert.equal(wire.value, 0, 'a real zero must reach the wire as 0');
    assert.notEqual(wire.value, null, 'a real zero was turned into null — "no customers" became "we cannot say"');
});

test('other falsy-but-real values survive: false, empty string, empty array', () => {
    // The guard is a missing-value check, not a truthiness check. If it ever became `!value`, each
    // of these would silently become "we cannot say".
    assertAnswer(measured(false, SOURCE), false, 'measured', 'measured(false)');
    assertAnswer(measured('', SOURCE), '', 'measured', "measured('')");

    const emptyList = measured([], SOURCE);
    assert.equal(emptyList.confidence, 'measured');
    assert.deepEqual(emptyList.value, [], 'an empty result set is a measured answer, not an unknown');
});

test('derived and estimated also keep a genuine zero', () => {
    assertAnswer(derived(0, SOURCE, 'churned_mrr / start_mrr'), 0, 'derived', 'derived(0)');
    assertAnswer(estimated(0, SOURCE, 'excludes refunds, so reads high'), 0, 'estimated', 'estimated(0)');
});


/* ==========================================================================
 *  4. The qualifier travels with the figure
 * ========================================================================== */

test('derived carries its basis, estimated carries its caveat, measured carries neither', () => {
    const measuredEnvelope = measured(42, SOURCE);
    assert.equal(measuredEnvelope.caveat, undefined, 'a measured figure has nothing to qualify');

    const derivedEnvelope = derived(12.5, SOURCE, 'mrr / active_subs');
    assert.equal(derivedEnvelope.caveat, 'mrr / active_subs', 'the arithmetic must travel with the number');

    const estimatedEnvelope = estimated(900, SOURCE, 'excludes refunds, so reads high');
    assert.equal(estimatedEnvelope.caveat, 'excludes refunds, so reads high');
});

test('a missing basis or caveat is stated as missing, not left blank', () => {
    assert.equal(derived(1, SOURCE, '').caveat, 'basis not stated');
    assert.equal(estimated(1, SOURCE, '').caveat, 'caveat not stated');
    assert.equal(measured(1, '').source, 'none');
});


/* ==========================================================================
 *  5. An envelope is a published claim — it cannot be edited afterwards
 * ========================================================================== */

test(' an unknown envelope cannot be given a value after the fact', () => {
    // The one mutation that would defeat the whole primitive: taking an honest `unknown` and
    // assigning a number onto it without going back through a constructor. Frozen, so in strict
    // mode this throws rather than silently succeeding.
    const envelope = unknown('the window predates our records', SOURCE);

    assert.throws(() => {
        envelope.value = 0;
    }, TypeError, 'an unknown envelope accepted a value assignment');

    assert.throws(() => {
        envelope.confidence = 'measured';
    }, TypeError, 'an envelope accepted a confidence upgrade');

    assert.equal(envelope.value, null, 'the value changed despite the freeze');
    assert.equal(envelope.confidence, 'unknown');
});

test('a measured envelope is frozen too', () => {
    const envelope = measured(10, SOURCE);
    assert.ok(Object.isFrozen(envelope));
    assert.throws(() => {
        envelope.value = 999;
    }, TypeError);
    assert.equal(envelope.value, 10);
});


/* ==========================================================================
 *  6. The surface
 * ========================================================================== */

test('the helper publishes exactly the four constructors', () => {
    // If a fifth appeared — a `raw()`, an `assume()` — it would be a way to publish a figure
    // without stating how well it is known, and every assertion above would still pass.
    assert.deepEqual(Object.keys(confidence).sort(), ['derived', 'estimated', 'measured', 'unknown']);
});

test('the helper is PURE — it reaches no model, config, clock or module of ours', () => {
    // A helper is only unit-testable without a database while this holds, and this one decides
    // whether other numbers may be published at all. It is the last file that should need a
    // running Mongo to verify.
    const fs = require('node:fs');
    const source = fs.readFileSync(
        path.resolve(__dirname, '..', 'src', 'modules', 'shared', 'helpers', 'confidence.helper.ts'),
        'utf8'
    );
    const runtimeImports = [...source.matchAll(/^\s*import\s+(?!type\b)[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    const requires = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);

    assert.deepEqual(runtimeImports, [], `confidence.helper acquired a runtime import: ${runtimeImports.join(', ')}`);
    assert.deepEqual(requires, [], `confidence.helper acquired a require: ${requires.join(', ')}`);
    assert.ok(!/Date\.now|new Date\(/.test(source), 'confidence.helper reads the clock — pass `now` in instead');
});
