'use strict';

/**
 * ============================================================================
 *  THE PARTNER APP WRITE SURFACE — and the two things it refuses
 * ============================================================================
 *
 *  Exercises `updatePartnerApp`, `deactivatePartnerApp` and `getPartnerAppKpi`
 *  with both repositories stubbed out, so the whole assembly — patch validation
 *  → write → serialisation, and window → coverage gate → fold → payload — runs
 *  against fixtures with no database.
 *
 *  ── 1.  `update` MUST NOT BE ABLE TO REPOINT THE APP ─────────────────────
 *
 *  Every collection in this build is keyed by the app row's `_id`, which no
 *  request can change. `partner_api_app_id` is the field that says WHICH
 *  Shopify app those rows were pulled from — so editing it moves no data and
 *  relabels all of it. There is no repair: nothing on an event row records the
 *  app id it was fetched under.
 *
 *  The test therefore asserts three separate things, because only all three
 *  together are the guarantee: the call FAILS, NOTHING is written, and the
 *  refusal happens BEFORE the row is even looked up (so a caller cannot use
 *  the difference between "refused" and "not found" to probe which app ids
 *  exist).
 *
 *  ── 2.  `softDelete` MUST NOT DESTROY OR ORPHAN HISTORY ──────────────────
 *
 *  Deactivation, never deletion — and the response has to SAY so, because an
 *  operator who sends DELETE and receives 200 has every reason to assume rows
 *  went away. So the test checks the retained counts are published, that the
 *  repository has no delete function to call in the first place, and that the
 *  whole thing is reversible through the documented PATCH.
 *
 *  ── 3. EVERY KPI FIGURE IS A BARE NUMBER, AND AN UNMEASURED ONE IS `null` ──
 *
 *  `AppKpiCards` formats with `Number(n)`. A confidence envelope renders as an
 *  em dash and blanks the tile, which is the honesty mechanism manufacturing
 *  the absence it exists to prevent. `null` survives that renderer; an object
 *  does not.
 *
 *  ── 4. NEVER_SYNCED IS DECIDED BY THE WATERMARK, NEVER BY A ROW COUNT ──────
 *
 *  The fixture for that test deliberately has the aggregates ready to return
 *  real counts. The service must not reach them at all: an app whose merchants
 *  have not installed it this month and an app nobody has ever synced produce
 *  the identical empty result set, and only `last_synced_at` separates them.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';
//  Set BEFORE `src/config` is first required — it snapshots `process.env` at load. The soft
// delete compares this against the row's canonical GID to decide whether to warn that registering
// at boot will not reactivate the app.
process.env.SHOPIFY_PARTNER_APP_ID = '7654321';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mongoose = require('mongoose');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const MODULE_ROOT = path.join(BACKEND_ROOT, 'src', 'modules', 'partner');

// A stray un-stubbed model call must fail fast rather than hanging the suite for 10 seconds.
mongoose.set('bufferTimeoutMS', 400);

const appRepository = require(path.join(MODULE_ROOT, 'repositories', 'partnerApp.repository.ts'));
const readRepository = require(path.join(MODULE_ROOT, 'repositories', 'partnerAppRead.repository.ts'));

/** ⚠️ Relative to NOW — the services read the clock to clamp the judgement instant. */
const NOW = Date.now();
const _daysAgo = (days) => new Date(NOW - (days * 86400000));

/** The canonical form the create path stores. The env above is the bare numeric id on purpose. */
const CONFIGURED_GID = 'gid://partners/App/7654321';

const BASE_APP = {
    _id: 'app-1',
    app_handle: 'demo-app',
    display_name: 'Demo App',
    listing_url: 'https://apps.shopify.com/demo',
    partner_api_app_id: CONFIGURED_GID,
    categories: ['Marketing'],
    target_keywords: ['delivery'],
    is_active: true,
    last_synced_at: _daysAgo(1),
    lifetime_sync_completed_at: _daysAgo(2),
    earliest_event_at: _daysAgo(400),
    earliest_transaction_at: _daysAgo(390),
    shop_name_coverage_since: _daysAgo(400),
    event_history_gap_days: 0,
    charge_link_absent_pct: 0,
    charge_link_unresolved_pct: 0,
    createdAt: _daysAgo(500),
    updatedAt: _daysAgo(1)
};

/**
 * ⚠️ The stubs are installed BEFORE the services are required. Every service here destructures its
 * repository at MODULE LOAD, so re-assigning an export afterwards has no effect at all.
 */
const STATE = {
    app: { ...BASE_APP },
    /** How many times the row was looked up — proves a refusal happened before any lookup. */
    lookups: 0,
    /** The last `$set` the repository was handed, or null when no write was issued. */
    lastSet: null,
    /** How many aggregates ran — proves NEVER_SYNCED was decided without counting rows. */
    aggregateCalls: 0,
    retained: { event_rows: 41207, transaction_rows: 3115 },
    windowBuckets: [],
    allTimeCounts: [],
    relationshipRows: [],
    windowCash: null,
    lifetimeCash: null,
    currencies: []
};

const _reset = () => {
    STATE.app = { ...BASE_APP };
    STATE.lookups = 0;
    STATE.lastSet = null;
    STATE.aggregateCalls = 0;
    STATE.retained = { event_rows: 41207, transaction_rows: 3115 };
    STATE.windowBuckets = [];
    STATE.allTimeCounts = [];
    STATE.relationshipRows = [];
    STATE.windowCash = null;
    STATE.lifetimeCash = null;
    STATE.currencies = [];
};

appRepository.findPartnerAppById = async (id) => {
    STATE.lookups += 1;
    if (!STATE.app || String(STATE.app._id) !== String(id)) {
        return null;
    }
    return { ...STATE.app };
};
appRepository.listPartnerApps = async ({ is_active }) => {
    if (!STATE.app) {
        return [];
    }
    if (typeof is_active === 'boolean' && STATE.app.is_active !== is_active) {
        return [];
    }
    return [{ ...STATE.app }];
};
appRepository.updatePartnerAppFields = async ({ partner_app_id, set }) => {
    STATE.lastSet = set;
    if (!STATE.app || String(STATE.app._id) !== String(partner_app_id)) {
        return null;
    }
    STATE.app = { ...STATE.app, ...set };
    return { ...STATE.app };
};

readRepository.countAppScopedRows = async () => STATE.retained;
readRepository.aggregateRelationshipBuckets = async () => {
    STATE.aggregateCalls += 1;
    return STATE.windowBuckets;
};
readRepository.aggregateRelationshipTypeCounts = async () => {
    STATE.aggregateCalls += 1;
    return STATE.allTimeCounts;
};
readRepository.findAllRelationshipEvents = async () => {
    STATE.aggregateCalls += 1;
    return { rows: STATE.relationshipRows, shopless_relationship_events: 0 };
};
readRepository.aggregateWindowCurrencies = async () => {
    STATE.aggregateCalls += 1;
    return STATE.currencies;
};
readRepository.getWindowCash = async () => {
    STATE.aggregateCalls += 1;
    return STATE.windowCash;
};
readRepository.getLifetimeCash = async () => {
    STATE.aggregateCalls += 1;
    return STATE.lifetimeCash;
};

const { updatePartnerApp, deactivatePartnerApp } = require(path.join(MODULE_ROOT, 'services', 'partnerAppAdmin.service.ts'));
const { getPartnerAppKpi } = require(path.join(MODULE_ROOT, 'services', 'partnerAppKpi.service.ts'));

const OPERATOR = { user_id: 'operator-1' };

/**
 * The identity, watermark and coverage fields no request may ever write.
 *
 * ⚠️ Restated here rather than imported from the constants file ON PURPOSE. A test that reads the
 * production list asserts only "the code agrees with itself" — it would keep passing if somebody
 * deleted `partner_api_app_id` from that list, which is the single most dangerous edit in this
 * module. This list is the independent statement of the requirement.
 */
const MUST_BE_REFUSED = [
    'partner_api_app_id',
    'last_synced_at',
    'last_bq_synced_at',
    'last_install_attrib_synced_at',
    'lifetime_sync_completed_at',
    'earliest_event_at',
    'earliest_transaction_at',
    'shop_name_coverage_since',
    'event_history_gap_days',
    'charge_link_absent_pct',
    'charge_link_unresolved_pct'
];


/* ==========================================================================
 *  1. update — the identity refusal
 * ========================================================================== */

test(' update REFUSES partner_api_app_id, fails the whole call, and writes nothing', async () => {
    _reset();

    const result = await updatePartnerApp(OPERATOR, {
        partner_app_id: 'app-1',
        patch: { display_name: 'Renamed', partner_api_app_id: 'gid://partners/App/999999' }
    });

    assert.equal(result.status, false,
        'A body carrying partner_api_app_id must FAIL. Applying the writable half and returning 200 '
        + 'leaves the caller unable to say which of the fields they sent took effect.');
    assert.equal(result.error.code, 'PARTNER_APP_FIELD_REFUSED');
    assert.match(result.msg, /partner_api_app_id/,
        'The message must name the field. "Field not allowed" sends the operator to the source.');
    assert.equal(STATE.lastSet, null,
        ' NOTHING may be written. A refusal that still saves the display name is a partial apply '
        + 'wearing an error message.');
    assert.equal(STATE.app.display_name, 'Demo App', 'The stored row must be untouched.');
    assert.equal(STATE.app.partner_api_app_id, CONFIGURED_GID);
});

test(' the refusal happens BEFORE the row is looked up — a refused field cannot probe which app ids exist', async () => {
    _reset();

    const result = await updatePartnerApp(OPERATOR, {
        partner_app_id: 'no-such-app',
        patch: { partner_api_app_id: 'gid://partners/App/999999' }
    });

    assert.equal(result.status, false);
    assert.equal(result.error.code, 'PARTNER_APP_FIELD_REFUSED',
        'A non-existent id must produce the SAME refusal as a real one. Answering "not found" here and '
        + '"field refused" for a real id turns the error into an app-id oracle.');
    assert.equal(STATE.lookups, 0, 'The row must not even be read.');
});

test('every sync watermark and every coverage gate is refused — they are measurements, not settings', async () => {
    for (const field of MUST_BE_REFUSED) {
        _reset();
        const result = await updatePartnerApp(OPERATOR, {
            partner_app_id: 'app-1',
            patch: { [field]: field.endsWith('_pct') || field.endsWith('_days') ? 0 : new Date().toISOString() }
        });
        assert.equal(result.status, false, `${field} must be refused.`);
        assert.equal(result.error.code, 'PARTNER_APP_FIELD_REFUSED', `${field} must be refused.`);
        assert.equal(STATE.lastSet, null, `${field} must not reach a write.`);
    }
});

test('lifetime_sync_completed_at in particular cannot be typed in — it is the gate on every all-time figure', async () => {
    _reset();
    const result = await updatePartnerApp(OPERATOR, {
        partner_app_id: 'app-1',
        patch: { lifetime_sync_completed_at: new Date().toISOString() }
    });
    assert.equal(result.status, false);
    assert.match(result.msg, /lifetime_sync_completed_at/);
    assert.match(result.msg, /LIFETIME sync/,
        'The refusal must say how to actually earn the gate, not merely that the field is closed.');
});


/* ==========================================================================
 *  2. update — what it DOES write
 * ========================================================================== */

test('display metadata is written, and the identity fields around it are untouched', async () => {
    _reset();

    const result = await updatePartnerApp(OPERATOR, {
        partner_app_id: 'app-1',
        patch: {
            display_name: '  Route Planner  ',
            listing_url: 'https://apps.shopify.com/route-planner',
            categories: ['Fulfilment', 'Fulfilment', '  Shipping  ', '']
        }
    });

    assert.equal(result.status, true);
    assert.equal(result.data.changed, true);
    assert.deepEqual(result.data.updated_fields.sort(), ['categories', 'display_name', 'listing_url']);
    assert.equal(result.data.app.display_name, 'Route Planner', 'Surrounding whitespace is trimmed.');
    assert.deepEqual(result.data.app.partner_api_app_id, CONFIGURED_GID, 'Identity is untouched.');
    assert.deepEqual(STATE.lastSet.categories, ['Fulfilment', 'Shipping'],
        'Blanks and duplicates are dropped, and the drop is reported rather than silent.');
    assert.ok(result.data.warnings.some((w) => /duplicate/i.test(w)));
    assert.ok(result.data.warnings.some((w) => /blank/i.test(w)));
});

test(' every field PATCH can write, the row PUBLISHES — otherwise the edit form saves a blank over it', async () => {
    _reset();

    const result = await updatePartnerApp(OPERATOR, {
        partner_app_id: 'app-1',
        patch: { display_name: 'Route Planner' }
    });

    assert.equal(result.status, true);

    //  READ/WRITE SYMMETRY, AND IT IS NOT COSMETIC. `PartnerAppForm` seeds its inputs from this
    // row and turns each CSV box back into an array on save (`_csvToArray('') === []`). A row that
    // accepted `categories`/`target_keywords` on PATCH but omitted them on the way out loaded two
    // empty boxes, and the next save of ANY field on that screen wrote `[]` over stored values
    // nobody edited — a silent wipe, under a success toast.
    assert.deepEqual(result.data.app.categories, ['Marketing'],
        'categories is writable through PATCH, so it must be readable off the row the form loads from.');
    assert.deepEqual(result.data.app.target_keywords, ['delivery'],
        'target_keywords is writable through PATCH, so it must be readable off the row the form loads from.');

    // Always an ARRAY. For a list of labels "absent" and "empty" are the same fact, so there is no
    // zero-versus-unknown distinction to preserve here — unlike the numeric coverage gates, which
    // stay null.
    assert.ok(Array.isArray(result.data.app.categories));
    assert.ok(Array.isArray(result.data.app.target_keywords));
});

test('an app row written before these fields existed publishes empty arrays, never undefined', async () => {
    _reset();
    delete STATE.app.categories;
    delete STATE.app.target_keywords;

    const result = await updatePartnerApp(OPERATOR, {
        partner_app_id: 'app-1',
        patch: { display_name: 'Route Planner' }
    });

    assert.equal(result.status, true);
    // `undefined` disappears from the JSON entirely, which puts the form back where it started:
    // a key it cannot read is a key it overwrites.
    assert.deepEqual(result.data.app.categories, []);
    assert.deepEqual(result.data.app.target_keywords, []);
});

test('the write cannot reach anything outside the six editable fields', async () => {
    _reset();
    await updatePartnerApp(OPERATOR, { partner_app_id: 'app-1', patch: { display_name: 'X' } });

    assert.deepEqual(Object.keys(STATE.lastSet), ['display_name'],
        ' The `$set` document is built by the validator, not spread from the body. Only keys the '
        + 'validator produced may appear in it.');
});

test('a body with nothing writable in it is refused rather than answered 200', async () => {
    _reset();
    const result = await updatePartnerApp(OPERATOR, {
        partner_app_id: 'app-1',
        patch: { app_id: 'app-2' }
    });

    assert.equal(result.status, false);
    assert.equal(result.error.code, 'PARTNER_APP_FIELD_REFUSED',
        'app_id is this row\'s own identifier and belongs in the URL, so it is a refusal — not an '
        + 'unrecognised key.');
});

test('an unrecognised key is a WARNING, not a refusal — it is a typo, not an attack', async () => {
    _reset();
    const result = await updatePartnerApp(OPERATOR, {
        partner_app_id: 'app-1',
        patch: { display_name: 'X', totally_made_up: 1 }
    });

    assert.equal(result.status, true);
    assert.ok(result.data.warnings.some((w) => /totally_made_up/.test(w)),
        'The ignored key must be named. A silent no-op on a field somebody typed is the same failure '
        + 'as a silent partial apply.');
});

test('is_active accepts only a real boolean — the string "false" is truthy and would invert the request', async () => {
    _reset();
    const result = await updatePartnerApp(OPERATOR, {
        partner_app_id: 'app-1',
        patch: { is_active: 'false' }
    });

    assert.equal(result.status, false);
    assert.match(result.msg, /is_active/);
    assert.equal(STATE.app.is_active, true, 'The app must not have been deactivated by a coerced string.');
});

test('listing_url must be a URL — the dashboard renders it as a link', async () => {
    _reset();
    const result = await updatePartnerApp(OPERATOR, {
        partner_app_id: 'app-1',
        patch: { listing_url: 'apps.shopify.com/demo' }
    });

    assert.equal(result.status, false);
    assert.match(result.msg, /http/);
});

test('a required display field cannot be cleared to an empty string', async () => {
    _reset();
    const result = await updatePartnerApp(OPERATOR, {
        partner_app_id: 'app-1',
        patch: { display_name: '   ' }
    });

    assert.equal(result.status, false);
    assert.equal(STATE.lastSet, null);
});

test('resubmitting unchanged values issues NO write and reports changed:false', async () => {
    _reset();
    const result = await updatePartnerApp(OPERATOR, {
        partner_app_id: 'app-1',
        patch: { display_name: 'Demo App', categories: ['Marketing'] }
    });

    assert.equal(result.status, true);
    assert.equal(result.data.changed, false);
    assert.deepEqual(result.data.updated_fields, []);
    assert.equal(STATE.lastSet, null,
        'A `$set` that changes nothing still bumps `updatedAt`, which is the timestamp an operator '
        + 'reads to answer "when did this last change".');
});

test('update on an app that does not exist is a not-found, not a silent success', async () => {
    _reset();
    const result = await updatePartnerApp(OPERATOR, {
        partner_app_id: 'no-such-app',
        patch: { display_name: 'X' }
    });

    assert.equal(result.status, false);
    assert.match(result.msg, /not found/i);
    assert.deepEqual(result.error, {}, 'A missing row carries no error code — the controller maps it to 404.');
});


/* ==========================================================================
 *  3. softDelete — history is preserved, and the response proves it
 * ========================================================================== */

test(' softDelete DEACTIVATES: nothing is deleted, and the retained rows are counted on the response', async () => {
    _reset();

    const result = await deactivatePartnerApp(OPERATOR, { partner_app_id: 'app-1' });

    assert.equal(result.status, true);
    assert.equal(result.data.deleted, false, 'The payload must say plainly that nothing was deleted.');
    assert.equal(result.data.changed, true);
    assert.equal(result.data.app.is_active, false);
    assert.deepEqual(STATE.lastSet, { is_active: false },
        ' The ONLY field a soft delete writes. Anything else here is a delete wearing a flag.');
    assert.equal(result.data.retained.event_rows, 41207);
    assert.equal(result.data.retained.transaction_rows, 3115);
    assert.match(result.msg, /41207/,
        'The count belongs in the message too: an operator reading only the confirmation line still '
        + 'learns that nothing went away.');
    assert.match(result.data.hard_delete, /no hard delete/i);
    assert.match(result.data.semantics, /Deactivated, not deleted/);
});

test(' there is no delete function on the partner-app repositories at all', () => {
    // The strongest available statement of the design: not "the service chose not to call it", but
    // "there is nothing to call". A cascading delete would destroy the factual basis of every figure
    // this deployment has published; a non-cascading one would orphan those rows behind an id that
    // resolves to nothing, which reads exactly like a business with no customers.
    for (const surface of [appRepository, readRepository]) {
        for (const key of Object.keys(surface)) {
            assert.ok(!/^(delete|remove|drop|purge)/i.test(key),
                `${key} looks like a destructive operation. The partner app row is the scoping root for `
                + 'every collection in this build and nothing here may remove it or its facts.');
        }
    }
});

test(' softDelete IS REVERSIBLE — the documented PATCH puts it back, with history untouched', async () => {
    _reset();

    await deactivatePartnerApp(OPERATOR, { partner_app_id: 'app-1' });
    assert.equal(STATE.app.is_active, false);

    const restored = await updatePartnerApp(OPERATOR, {
        partner_app_id: 'app-1',
        patch: { is_active: true }
    });

    assert.equal(restored.status, true);
    assert.equal(restored.data.app.is_active, true);
    assert.deepEqual(restored.data.updated_fields, ['is_active']);
    // Nothing was ever removed, so nothing has to be re-fetched.
    const stillThere = await deactivatePartnerApp(OPERATOR, { partner_app_id: 'app-1' });
    assert.equal(stillThere.data.retained.event_rows, 41207);
});

test('the reversal is published ON the response — a soft delete with an undocumented undo is a hard delete with extra steps', async () => {
    _reset();
    const result = await deactivatePartnerApp(OPERATOR, { partner_app_id: 'app-1' });

    assert.match(result.data.reversal, /is_active/);
    assert.match(result.data.reversal, /PATCH/);
});

test('softDelete is idempotent — a retry does not fail because the first call worked', async () => {
    _reset();
    STATE.app.is_active = false;

    const result = await deactivatePartnerApp(OPERATOR, { partner_app_id: 'app-1' });

    assert.equal(result.status, true);
    assert.equal(result.data.changed, false);
    assert.equal(STATE.lastSet, null, 'No write is issued when the row already holds the value.');
    assert.ok(result.data.warnings.some((w) => /already deactivated/i.test(w)));
});

test('deactivating the CONFIGURED app warns that booting will not bring it back', async () => {
    _reset();
    const result = await deactivatePartnerApp(OPERATOR, { partner_app_id: 'app-1' });

    assert.ok(result.data.warnings.some((w) => /SHOPIFY_PARTNER_APP_ID/.test(w)),
        'Registration at boot is idempotent and does not touch `is_active`, so an operator would '
        + 'otherwise watch a healthy boot leave the dashboard reporting on an app nothing syncs.');
    assert.ok(result.data.warnings.some((w) => /only active app/i.test(w)));
});

test('every warning string is unique — the frontend keys them by content, so a duplicate is DROPPED', async () => {
    _reset();
    const result = await deactivatePartnerApp(OPERATOR, { partner_app_id: 'app-1' });
    const seen = new Set(result.data.warnings);
    assert.equal(seen.size, result.data.warnings.length);
});

test('softDelete on an app that does not exist is a not-found', async () => {
    _reset();
    const result = await deactivatePartnerApp(OPERATOR, { partner_app_id: 'no-such-app' });
    assert.equal(result.status, false);
    assert.match(result.msg, /not found/i);
});


/* ==========================================================================
 *  4. KPI — bare numbers, and null for what was not measured
 * ========================================================================== */

/** Relationship tallies as the aggregate returns them, filed under one bucket key. */
const _tally = (bucket, counts) => Object.keys(counts).map((event_type) => ({
    bucket,
    event_type,
    count: counts[event_type],
    shopless: 0
}));

test(' every KPI figure a component formats is a BARE NUMBER, never an envelope', async () => {
    _reset();
    STATE.windowBuckets = _tally('all', { INSTALL: 12, UNINSTALL: 3, REINSTALL: 1, DEACTIVATED: 2 });
    STATE.allTimeCounts = _tally('', { INSTALL: 400, UNINSTALL: 120, REINSTALL: 30, DEACTIVATED: 9 });
    STATE.relationshipRows = [
        { shop_domain: 'a.myshopify.com', event_type: 'INSTALL', occurred_at: _daysAgo(50), shop_id: 'gid://partners/Shop/1', shop_name: 'A' },
        { shop_domain: 'b.myshopify.com', event_type: 'INSTALL', occurred_at: _daysAgo(40), shop_id: 'gid://partners/Shop/2', shop_name: 'B' },
        { shop_domain: 'b.myshopify.com', event_type: 'UNINSTALL', occurred_at: _daysAgo(10), shop_id: 'gid://partners/Shop/2' }
    ];
    STATE.windowCash = { gross: 4321.5, net: 3800.1, shopify_fee: 521.4, tx_count: 47 };
    STATE.lifetimeCash = { total_gross: 98000, total_net: 85000, total_fee: 13000, tx_count: 1400, subscription_tx_count: 1350 };
    STATE.currencies = ['USD'];

    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });

    assert.equal(result.status, true);
    const d = result.data;
    assert.equal(d.data_state, 'READY');

    const figures = [
        d.counts.installs, d.counts.uninstalls, d.counts.reinstalls, d.counts.deactivations,
        d.all_time.installs, d.all_time.uninstalls, d.all_time.reinstalls, d.all_time.deactivations,
        d.all_time.estimated_active, d.all_time.gross_revenue, d.all_time.net_revenue, d.all_time.transaction_count,
        d.revenue.gross_total, d.revenue.net_total, d.revenue.transaction_count
    ];
    for (const figure of figures) {
        assert.equal(typeof figure, 'number',
            ' AppKpiCards formats with Number(n). An envelope is an object, Number({}) is NaN, and the '
            + 'tile renders an em dash — the honesty mechanism manufacturing the absence it exists to '
            + 'prevent.');
        assert.ok(Number.isFinite(figure));
    }

    assert.equal(d.counts.installs, 12);
    assert.equal(d.counts.uninstalls, 3, 'DEACTIVATED is NOT summed into uninstalls.');
    assert.equal(d.counts.deactivations, 2);
    assert.equal(d.all_time.gross_revenue, 98000, 'All-time cash comes from the revenue ledger, unchanged.');
    assert.equal(d.revenue.gross_total, 4321.5);
    assert.equal(d.revenue.currency, 'USD');
    // a.myshopify.com is still installed; b.myshopify.com uninstalled after installing.
    assert.equal(d.all_time.estimated_active, 1,
        'Estimated active is the canonical install fold — the LATEST relationship event per store, '
        + 'never a comparison of install and uninstall counts.');
});

test(' an UNMEASURED figure is null — never 0, and never an envelope', async () => {
    _reset();
    // No lifetime sync has completed, and the window opens 400 days back — below the oldest event
    // this deployment actually holds. Nothing about that stretch is known.
    STATE.app.lifetime_sync_completed_at = null;
    STATE.app.earliest_event_at = _daysAgo(90);
    STATE.app.earliest_transaction_at = _daysAgo(85);
    STATE.windowBuckets = _tally('all', { INSTALL: 12 });

    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 400 });

    assert.equal(result.status, true, 'An unmeasurable window is still a 200 — the page has a rendering for it.');
    const d = result.data;
    assert.equal(d.data_state, 'READY');

    for (const key of ['installs', 'uninstalls', 'reinstalls', 'deactivations']) {
        assert.equal(d.counts[key], null,
            `counts.${key} must be null, not 0. A zero here states that nobody installed the app in a `
            + 'stretch nobody fetched, which is a claim about the business rather than about this '
            + 'deployment\'s records.');
    }
    for (const key of ['installs', 'estimated_active', 'gross_revenue', 'transaction_count']) {
        assert.equal(d.all_time[key], null,
            `all_time.${key} must be null until a LIFETIME sync has completed — until then the stored `
            + 'history is whatever the incremental windows happened to pull.');
    }
    assert.equal(d.revenue.gross_total, null);
    assert.equal(d.coverage.counts_measurable, false);
    assert.equal(d.coverage.all_time_measurable, false);
    assert.ok(d.warnings.some((w) => /lifetime/i.test(w)));
});

test('a measured EMPTY window publishes 0, not null — the two are different answers', async () => {
    _reset();
    STATE.windowBuckets = [];
    STATE.allTimeCounts = [];
    STATE.relationshipRows = [];
    STATE.windowCash = null;
    STATE.lifetimeCash = null;

    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });

    assert.equal(result.data.counts.installs, 0,
        'A lifetime sync has completed and the window sits inside the record, so "no rows" is a real '
        + 'measurement of zero.');
    assert.equal(result.data.revenue.gross_total, 0);
    assert.equal(result.data.all_time.estimated_active, 0);
});


/* ==========================================================================
 *  5. NEVER_SYNCED — by the watermark, never by a row count
 * ========================================================================== */

test(' an unsynced app reports NEVER_SYNCED from the WATERMARK, and does not count a single row', async () => {
    _reset();
    STATE.app.last_synced_at = null;
    //  The aggregates are LOADED and would return real counts. The service must never reach them:
    // an app whose merchants have not installed it this month and an app nobody has ever synced
    // produce the identical empty result set, and only the watermark separates them.
    STATE.windowBuckets = _tally('all', { INSTALL: 99 });
    STATE.allTimeCounts = _tally('', { INSTALL: 99 });
    STATE.lifetimeCash = { total_gross: 5, total_net: 4, total_fee: 1, tx_count: 1, subscription_tx_count: 1 };

    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });

    assert.equal(result.status, true, 'NEVER_SYNCED is a 200 with a reason, not a failure envelope.');
    assert.equal(result.data.data_state, 'NEVER_SYNCED');
    assert.equal(STATE.aggregateCalls, 0,
        ' NOT ONE ROW MAY BE COUNTED. Deciding this from a row count is exactly the confusion the '
        + 'watermark exists to remove.');
    assert.equal(result.data.trend, null,
        'null, not [] — an empty array is a MEASURED "nothing happened" and renders as a chart-shaped '
        + 'gap over an app nobody has synced.');
    assert.equal(result.data.counts.installs, null);
    assert.equal(result.data.all_time.installs, null);
    assert.equal(result.data.revenue.gross_total, null);
    assert.ok(result.data.unknown_reason && result.data.unknown_reason.length > 0,
        'The banner body travels with the state — a state with no sentence renders an empty banner.');
});

test('a lifetime watermark set but no ordinary watermark still reads NEVER_SYNCED', async () => {
    _reset();
    STATE.app.last_synced_at = null;
    STATE.app.lifetime_sync_completed_at = _daysAgo(2);

    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });

    assert.equal(result.data.data_state, 'NEVER_SYNCED',
        '`last_synced_at` is the watermark stamped by EVERY successful run, including a lifetime one. '
        + 'Its absence is authoritative whatever else is set.');
});

test('an inactive app still answers its history, and says why nothing new will arrive', async () => {
    _reset();
    STATE.app.is_active = false;

    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });

    assert.equal(result.status, true, 'Deactivation stops the sync, not the reads.');
    assert.equal(result.data.data_state, 'READY');
    assert.ok(result.data.warnings.some((w) => /deactivated/i.test(w)));
});

test('KPI on an app that does not exist is a not-found rather than an empty dashboard', async () => {
    _reset();
    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'no-such-app', period_days: 30 });
    assert.equal(result.status, false);
    assert.match(result.msg, /not found/i);
});
