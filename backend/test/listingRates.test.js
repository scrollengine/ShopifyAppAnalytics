'use strict';

/**
 * ============================================================================
 *  THE LISTING TIER'S DIVISION — a rate that can say "I don't know"
 * ============================================================================
 *
 *  `modules/conversion/helpers/funnelMath.helper.ts` opens with an entire header about one
 *  substitution:
 *
 *      if (!b || b === 0) return 0;      //  a division that answers 0 for "no denominator"
 *
 *  That header is the specification. It was written when the CONVERSION tier was repaired, and the
 *  same function — spelled `safeDiv` — stayed alive in the LISTING tier at four layers plus two
 *  storage defaults. This file pins all six, and pins the thing that makes the repair worth
 *  anything: a MEASURED zero still comes back as `0`.
 *
 *  ──  WHY EACH LAYER IS TESTED SEPARATELY ─────────────────────────────────
 *
 *  Every one of them produces a well-formed number that no layer above can tell apart from a
 *  measurement, and each is reachable on its own:
 *
 *    1. the summary rates      `/api/funnel` — five of them, derived in the service
 *    2. the trend rates        the same endpoint's daily line, which a CHART draws
 *    3. `install_rate`         a `$cond` inside the traffic-source aggregation
 *    4. `conversion_rate`      the same `$cond` inside the geo aggregation
 *    5. the write path         `runDailySync`, whose rates are STORED and outlive the request
 *    6. the schema defaults    mongoose applies them on an upsert INSERT
 *
 *  ── AND THE SECOND DEFECT, WHICH IS THE FIRST ONE'S MIRROR ────────────────
 *
 *  `docs/FIDELITY.md` promises `/api/funnel` returns `summary: null` — "not a zeroed row" — when
 *  the window contains no rollup row. The repository honoured it and the service then rebuilt the
 *  zeroed row from `totals || { views: 0, … }` and derived five rates from it. So the endpoint
 *  published a complete, confident funnel for a window it had never read a row of, and the null the
 *  doc calls "the discriminator" survived only on a branch answering a different question.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';
//  The tier must be CONFIGURED or every read refuses before it reaches the arithmetic.
// `src/config` snapshots `process.env` at first require, so this precedes every require below.
process.env.GCP_PROJECT_ID = 'test-project';
process.env.BQ_DATASET = 'test_dataset';
process.env.GCP_SERVICE_ACCOUNT_JSON = '{}';
process.env.BQ_LIFETIME_FLOOR_DATE = '2024-01-01';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mongoose = require('mongoose');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(BACKEND_ROOT, 'src');
const BQ = path.join(SRC, 'modules', 'bigquery');

/** Never reached — every model and repository below is a stub — but a short buffer keeps a slip from hanging. */
mongoose.set('bufferTimeoutMS', 400);

const rowHelper = require(path.join(BQ, 'helpers', 'bigQueryRow.helper.ts'));
const funnelMathHelper = require(path.join(SRC, 'modules', 'conversion', 'helpers', 'funnelMath.helper.ts'));
const constants = require(path.join(BQ, 'constants', 'bigQuery.constants.ts'));

const { NEVER_SYNCED_REASON, EMPTY_WINDOW_REASON } = constants;

const OPERATOR = { user_id: 'operator-1' };
const APP_ID = 'app-1';
const _DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const _daysAgo = (days) => new Date(NOW - (days * _DAY_MS));

/** A synced app: the watermark is what makes `data_state` READY, and it is not a row count. */
const SYNCED_APP = {
    _id: APP_ID,
    is_active: true,
    last_bq_synced_at: _daysAgo(1)
};

/**
 * The state the repository stubs answer from.
 *
 * ⚠️ Installed BEFORE the services are required — both destructure their repositories at module
 * load, so a swap afterwards would be a test that passes while asserting nothing.
 */
const STATE = {
    app: { ...SYNCED_APP },
    totals: null,
    trend: [],
    /** Rows each write helper was handed, so the STORED rate can be asserted. */
    writtenFunnelDays: [],
    writtenGeoDays: [],
    /** Rows `runQuery` hands back, keyed by which section asked. */
    bqRowsBySection: { funnel: [], source: [], geo: [] }
};

const _reset = () => {
    STATE.app = { ...SYNCED_APP };
    STATE.totals = null;
    STATE.trend = [];
    STATE.writtenFunnelDays = [];
    STATE.writtenGeoDays = [];
    STATE.bqRowsBySection = { funnel: [], source: [], geo: [] };
};

const syncStateRepository = require(path.join(BQ, 'repositories', 'bigQuerySyncState.repository.ts'));
const listingRollupRepository = require(path.join(BQ, 'repositories', 'listingRollup.repository.ts'));
const bigQueryClient = require(path.join(BQ, 'clients', 'bigQuery.client.ts'));

syncStateRepository.findSyncTargetApp = async (id) => {
    if (!STATE.app || String(STATE.app._id) !== String(id)) {
        return null;
    }
    return { ...STATE.app };
};
syncStateRepository.stampRollupWatermark = async () => undefined;

listingRollupRepository.aggregateFunnelTotals = async () => STATE.totals;
listingRollupRepository.findFunnelTrend = async () => STATE.trend;

const _tally = (rows) => ({ upserted: rows.length, matched: 0, errors: 0 });
listingRollupRepository.upsertFunnelDays = async (_appId, rows) => {
    STATE.writtenFunnelDays = rows;
    return _tally(rows);
};
listingRollupRepository.upsertSourceDays = async (_appId, rows) => _tally(rows);
listingRollupRepository.upsertGeoDays = async (_appId, rows) => {
    STATE.writtenGeoDays = rows;
    return _tally(rows);
};

/** Which of the three concurrent section queries this is, read off the SQL the service built. */
const _sectionOf = (sql) => {
    if (/traffic_source/i.test(String(sql))) {
        return 'source';
    }
    if (/country/i.test(String(sql))) {
        return 'geo';
    }
    return 'funnel';
};

bigQueryClient.runQuery = async (_identity, { sql }) => ({
    status: true,
    data: { rows: STATE.bqRowsBySection[_sectionOf(sql)], bytes_scanned: 0, job_id: 'job-1' },
    error: {},
    msg: 'ok'
});

const { getFunnelData } = require(path.join(BQ, 'services', 'bigQueryAnalytics.service.ts'));
const { runDailySync } = require(path.join(BQ, 'services', 'bigQuerySync.service.ts'));

/** Window totals as `$group` emits them — every count present, because `$sum` always emits one. */
const _totals = (overrides) => ({
    views: 0,
    engaged_views: 0,
    install_clicks: 0,
    consent_started: 0,
    consent_completed: 0,
    installs: 0,
    ad_clicks: 0,
    first_opens: 0,
    sessions: 0,
    first_visits: 0,
    ...overrides
});

/** One stored funnel day, as `findFunnelTrend` returns it. */
const _day = (overrides) => ({
    date: _daysAgo(2),
    views: 0,
    engaged_views: 0,
    install_clicks: 0,
    consent_started: 0,
    consent_completed: 0,
    installs: 0,
    ad_clicks: 0,
    first_opens: 0,
    ...overrides
});


/* ==========================================================================
 *  0.  There is ONE division, and it is not in this module
 * ========================================================================== */

test('the row helper no longer publishes a division at all', () => {
    assert.equal(rowHelper.safeDiv, undefined,
        '`safeDiv` is back. It answered 0 for an absent denominator — see this file\'s header and '
        + '`funnelMath.helper`\'s. A second spelling of "divide" is how the first one comes back; the '
        + 'listing tier must use `funnelMath.helper.rate` and nothing else.');
    assert.equal(typeof funnelMathHelper.rate, 'function',
        'The one division must be reachable. A cycle through a module BARREL would leave this '
        + 'undefined at load — type-checking and linting perfectly — and every rate on the listing '
        + 'pages would silently become undefined.');
});

test(' `rate` distinguishes an absent denominator from a measured zero', () => {
    assert.equal(funnelMathHelper.rate(7, 0), null, 'no denominator is not a rate of zero');
    assert.equal(funnelMathHelper.rate(0, 100), 0,
        '0 IS a real answer — nobody out of a hundred converting is a measurement, and nulling it '
        + 'would be the same defect pointed the other way.');
    assert.equal(funnelMathHelper.rate(null, 100), null, 'an unknown numerator is not "none of them"');
});


/* ==========================================================================
 *  1.  /api/funnel — the five summary rates
 * ========================================================================== */

test(' installs with NO views publishes a null conversion rate, never 0.00%', async () => {
    _reset();
    // The shape the SQL genuinely produces: a window whose install events landed but whose
    // listing pageviews did not. `0` here renders "Installs 7 · Conv 0.00%" in one tile group.
    STATE.totals = _totals({ installs: 7, views: 0, ad_clicks: 3 });
    STATE.trend = [_day({ installs: 7, ad_clicks: 3 })];

    const result = await getFunnelData(OPERATOR, { partner_app_id: APP_ID, period_days: 30 });

    assert.equal(result.status, true);
    assert.equal(result.data.summary.overall_conversion_rate, null,
        ' null, NEVER 0. `_fmtPct(0)` renders "0.00%" under the words "Conversion rate" — a claim '
        + 'that nobody who saw the listing installed, made by an arithmetic convenience.');
    assert.equal(result.data.summary.click_through_rate, null, 'install_clicks ÷ 0 views is not 0%');
    assert.equal(result.data.summary.installs, 7, 'the COUNT is a bare number and is unaffected');
});

test(' "Consent completion 0.00% · 0/0" is not publishable', async () => {
    _reset();
    STATE.totals = _totals({ views: 400, consent_started: 0, consent_completed: 0 });
    STATE.trend = [_day({ views: 400 })];

    const result = await getFunnelData(OPERATOR, { partner_app_id: APP_ID, period_days: 30 });

    assert.equal(result.data.summary.consent_completion_rate, null,
        'A 0% completion rate over 0/0 claims every merchant abandoned a screen nobody reached.');
    assert.equal(result.data.summary.first_open_rate, null, 'first_opens ÷ 0 installs is unknown');
    assert.equal(result.data.summary.ad_attributed_share, null, 'ad_clicks ÷ 0 installs is unknown');
});

test(' a MEASURED zero still publishes 0 — the repair must not erase real answers', async () => {
    _reset();
    STATE.totals = _totals({
        views: 1000, installs: 0, install_clicks: 40,
        consent_started: 40, consent_completed: 0
    });
    STATE.trend = [_day({ views: 1000, install_clicks: 40, consent_started: 40 })];

    const result = await getFunnelData(OPERATOR, { partner_app_id: APP_ID, period_days: 30 });

    const summary = result.data.summary;
    assert.equal(summary.overall_conversion_rate, 0,
        'A thousand views and no installs IS a measurement. Nulling it would be the same bug in the '
        + 'flattering direction: the worst number on the page would render as an em dash.');
    assert.equal(summary.consent_completion_rate, 0, 'forty started, none finished — measured');
    assert.equal(summary.click_through_rate, 0.04, 'an ordinary rate still divides');
});


/* ==========================================================================
 *  2.  /api/funnel — the daily line, which a CHART draws
 * ========================================================================== */

test(' a day with no views plots a null conversion rate so the line BREAKS', async () => {
    _reset();
    STATE.totals = _totals({ views: 500, installs: 10 });
    STATE.trend = [
        // A day the old write path stored as `overall_conversion_rate: 0` — with no views behind
        // it. Reading the stored column verbatim republishes that zero for ever, because an
        // INCREMENTAL re-sync never reaches back over old days to repair them.
        _day({ date: _daysAgo(3), views: 0, installs: 0, overall_conversion_rate: 0, ad_attributed_share: 0 }),
        _day({ date: _daysAgo(2), views: 500, installs: 10, overall_conversion_rate: 0.02 })
    ];

    const result = await getFunnelData(OPERATOR, { partner_app_id: APP_ID, period_days: 30 });

    const [gap, measured] = result.data.trend;
    assert.equal(gap.overall_conversion_rate, null,
        ' null, NEVER 0. Recharts runs the line along the floor on 0 and breaks it on null, and a '
        + 'flat 0% conversion line across a week is a picture of a catastrophe that did not happen.');
    assert.equal(gap.ad_attributed_share, null, 'ad_clicks ÷ 0 installs is unknown on a day too');
    assert.equal(gap.views, 0, 'the COUNT stays a measured zero — only the RATE is unknown');
    assert.equal(measured.overall_conversion_rate, 0.02, 'a real day still plots its real rate');
});

test(' a day with views and no installs plots a measured 0, not a break', async () => {
    _reset();
    STATE.totals = _totals({ views: 300 });
    STATE.trend = [_day({ views: 300, installs: 0 })];

    const result = await getFunnelData(OPERATOR, { partner_app_id: APP_ID, period_days: 30 });

    assert.equal(result.data.trend[0].overall_conversion_rate, 0,
        'Three hundred views and no installs is the single most important point on this chart. It '
        + 'must draw, not vanish into a gap.');
});


/* ==========================================================================
 *  3.  FIDELITY.md — `summary: null`, not a zeroed row
 * ========================================================================== */

test(' an empty window publishes summary: null — NOT a zeroed funnel', async () => {
    _reset();
    // `$group` emits no document for an empty match, so the repository returns null. See
    // docs/FIDELITY.md §4 (`/api/funnel`): "Preserve that null."
    STATE.totals = null;
    STATE.trend = [];

    const result = await getFunnelData(OPERATOR, { partner_app_id: APP_ID, period_days: 30 });

    assert.equal(result.status, true, 'an empty window is an ordinary 200, never a refusal');
    assert.equal(result.data.summary, null,
        ' `const t = totals || { views: 0, … }` is back. It rebuilt the row the doc forbids and '
        + 'derived five rates from it, publishing a confident funnel for a window with no rows in it.');
    assert.deepEqual(result.data.trend, [],
        'The trend read matched the same rows the totals did, so `[]` is the SAME measured fact. A '
        + 'null here would claim a second unknown the query never encountered.');
});

test(' the empty window stays READY — it is not "never synced"', async () => {
    _reset();
    STATE.totals = null;

    const result = await getFunnelData(OPERATOR, { partner_app_id: APP_ID, period_days: 30 });

    assert.equal(result.data.data_state, 'READY',
        '`data_state` is decided by the WATERMARK, never by the row count. This app HAS synced; the '
        + 'window simply holds no rows, and calling that NEVER_SYNCED sends the operator to re-run a '
        + 'job they already ran.');
    assert.equal(result.data.unknown_reason, EMPTY_WINDOW_REASON,
        'The reader needs a sentence, and this is the field every consumer already prints.');
    assert.notEqual(result.data.unknown_reason, NEVER_SYNCED_REASON,
        'THE TWO SENTENCES MUST STAY DIFFERENT. One is fixed by running a sync, the other by moving '
        + 'the date range.');
    assert.match(result.data.unknown_reason, /not a reading of zero traffic/,
        'It must say what it is NOT, or an empty window reads as an empty listing.');
});

test(' NEVER_SYNCED still nulls BOTH halves, and keeps its own reason', async () => {
    _reset();
    STATE.app.last_bq_synced_at = null;
    // Rows that would be published if the branch were reached at all — it must not be.
    STATE.totals = _totals({ views: 999, installs: 9 });
    STATE.trend = [_day({ views: 999, installs: 9 })];

    const result = await getFunnelData(OPERATOR, { partner_app_id: APP_ID, period_days: 30 });

    assert.equal(result.status, true);
    assert.equal(result.data.data_state, 'NEVER_SYNCED');
    assert.equal(result.data.summary, null);
    assert.equal(result.data.trend, null,
        'NULL, not `[]`. Nothing has ever been fetched, so there is no measured empty to draw.');
    assert.equal(result.data.unknown_reason, NEVER_SYNCED_REASON);
});

test(' the two nulled payloads are told apart by (data_state, summary) — the pair the funnel page reads', async () => {
    //  THIS IS THE WIRE CONTRACT `frontend/pages/growth-intel/funnel/index.js` DECODES.
    //
    // That page hands its decoder `isNeverSynced: (d) => !d.summary && !_isEmptyWindow(d)`, and
    // `_isEmptyWindow` is exactly `d.data_state === 'READY' && d.summary === null`. Before it
    // existed, both payloads below were filed as NEVER_SYNCED and the empty window rendered the
    // heading "No listing-analytics sync has run yet" directly above this endpoint's own sentence
    // saying a sync HAD run — and, because the decoder nulls `data` for every non-READY state, the
    // "Last BigQuery sync" line that disproved the heading vanished with it.
    //
    // So this asserts the DISCRIMINATOR rather than either payload on its own: `summary` is null in
    // both, and `data_state` is the only field that separates them. Collapse the pair — publish
    // NEVER_SYNCED for an empty window, or drop `data_state` — and the banner starts lying again
    // with no test failing anywhere near the change.
    _reset();
    STATE.totals = null;
    const empty = await getFunnelData(OPERATOR, { partner_app_id: APP_ID, period_days: 30 });

    _reset();
    STATE.app.last_bq_synced_at = null;
    const never = await getFunnelData(OPERATOR, { partner_app_id: APP_ID, period_days: 30 });

    assert.equal(empty.data.summary, null, 'both null…');
    assert.equal(never.data.summary, null, '…so `summary` cannot be the discriminator');
    assert.notEqual(empty.data.data_state, never.data.data_state,
        '`data_state` IS the discriminator, and it is decided by the watermark.');

    // The evidence the page prints beside the empty-window banner. It comes from the window echo,
    // so a branch that stopped spreading `echo` would take it off the screen — which is precisely
    // how the false heading survived: the one fact contradicting it was gone too.
    assert.ok(empty.data.last_bq_synced_at instanceof Date,
        'The empty window MUST still carry the watermark: it is what proves a sync has run.');
    assert.equal(never.data.last_bq_synced_at, null,
        'And the never-synced payload must not invent one.');
});


/* ==========================================================================
 *  4.  The two `$cond` branches, asserted on the PIPELINE
 * ========================================================================== */

test(' install_rate and conversion_rate fall back to null, never 0', async () => {
    // The repository is stubbed for every other test in this file, so the real one is loaded fresh
    // here against recorder models — what is asserted is the pipeline Mongo would have received.
    const pipelines = [];
    const modelsRepository = require(path.join(SRC, 'modules', 'shared', 'repositories', 'models.repository.ts'));
    const _recorder = () => ({
        aggregate: async (pipeline) => {
            pipelines.push(pipeline);
            return [];
        }
    });

    const realSource = modelsRepository.ListingSourceDailyModel;
    const realGeo = modelsRepository.ListingGeoDailyModel;
    modelsRepository.ListingSourceDailyModel = _recorder();
    modelsRepository.ListingGeoDailyModel = _recorder();

    // A fresh copy: the module-level destructure at load is what binds the models.
    delete require.cache[require.resolve(path.join(BQ, 'repositories', 'listingRollup.repository.ts'))];
    const freshRepository = require(path.join(BQ, 'repositories', 'listingRollup.repository.ts'));

    await freshRepository.aggregateSourceBreakdown({
        partner_app_id: '64b7f9c2e1a2b3c4d5e6f701', date_match: {}, limit: 50
    });
    await freshRepository.aggregateGeoBreakdown({
        partner_app_id: '64b7f9c2e1a2b3c4d5e6f701', date_match: {}, limit: 50
    });

    modelsRepository.ListingSourceDailyModel = realSource;
    modelsRepository.ListingGeoDailyModel = realGeo;
    delete require.cache[require.resolve(path.join(BQ, 'repositories', 'listingRollup.repository.ts'))];

    const _projectOf = (pipeline) => pipeline.find((stage) => stage.$project).$project;

    const sourceRate = _projectOf(pipelines[0]).install_rate.$cond;
    assert.equal(sourceRate[2], null,
        ' `safeDiv` written in Mongo\'s aggregation language. The rollup deliberately KEEPS '
        + 'install-only buckets, so `views: 0, installs: 7` is a real row — and the else-branch `0` '
        + 'published "Installs 7 · Install rate 0.00%", a self-contradiction inside one table row.');
    assert.deepEqual(sourceRate[1], { $divide: ['$installs', '$views'] },
        'The then-branch still divides, so a measured zero (views, no installs) still publishes 0.');
    assert.deepEqual(sourceRate[0], { $gt: ['$views', 0] },
        'Mongo orders null BELOW every number, so `$gt … 0` is also the null-views guard.');

    assert.equal(_projectOf(pipelines[1]).conversion_rate.$cond[2], null,
        'Same rule in the geo aggregation: a country with installs and no views has no rate.');
});


/* ==========================================================================
 *  5.  The WRITE path — these rates are stored, so the substitution outlives the request
 * ========================================================================== */

test(' a synced day with no views STORES a null rate, not a zero', async () => {
    _reset();
    STATE.bqRowsBySection.funnel = [
        { date: '2026-03-01', views: 0, installs: 4, ad_clicks: 4 },
        { date: '2026-03-02', views: 500, installs: 0, ad_clicks: 0 },
        // The schema comment's own counterexample: forty ad clicks and no recorded installs. It
        // claimed the numerator "is genuinely 0 as well", and here it is 40.
        { date: '2026-03-03', views: 900, installs: 0, ad_clicks: 40 }
    ];
    STATE.bqRowsBySection.geo = [
        { date: '2026-03-01', country: 'United States', views: 0, installs: 2 },
        { date: '2026-03-02', country: 'United States', views: 300, installs: 0 }
    ];

    const result = await runDailySync(OPERATOR, { partner_app_id: APP_ID, mode: 'INCREMENTAL' });
    assert.equal(result.status, true, result.msg);

    const [noViews, measured, adClicksNoInstalls] = STATE.writtenFunnelDays;
    assert.equal(noViews.overall_conversion_rate, null,
        ' A STORED zero outlives the fix. An INCREMENTAL re-sync never reaches back over this day '
        + 'again, so a `0` written here republishes "0.00% converted" for ever.');
    assert.equal(noViews.ad_attributed_share, 1,
        'Four installs, all ad-attributed, IS measurable — the day is only unrateable in the other '
        + 'direction, and nulling both would be over-correction.');
    assert.equal(measured.overall_conversion_rate, 0, 'five hundred views and no installs is measured');
    assert.equal(adClicksNoInstalls.ad_attributed_share, null,
        'ad_clicks ÷ 0 installs — the numerator is NOT "genuinely 0 as well", which is exactly what '
        + 'the schema comment used to claim. Forty ad clicks over no installs is not "0% of installs '
        + 'were ad-attributed".');
    assert.equal(adClicksNoInstalls.overall_conversion_rate, 0,
        'The SAME row is measurable one way and not the other, which is why the two rates are '
        + 'decided separately rather than by a per-row "is this day usable" flag.');

    const [geoNoViews, geoMeasured] = STATE.writtenGeoDays;
    assert.equal(geoNoViews.conversion_rate, null, 'a country with installs and no views has no rate');
    assert.equal(geoMeasured.conversion_rate, 0, 'a country with views and no installs measured 0%');
});


/* ==========================================================================
 *  6.  The schema defaults — mongoose applies them on an upsert INSERT
 * ========================================================================== */

test(' the stored rate columns default to null while the COUNTS default to 0', () => {
    const { ListingFunnelDaily } = require(path.join(SRC, 'models', 'listing', 'listingFunnelDaily.model.ts'));
    const { ListingGeoDaily } = require(path.join(SRC, 'models', 'listing', 'listingGeoDaily.model.ts'));

    const funnelDay = new ListingFunnelDaily({});
    assert.equal(funnelDay.overall_conversion_rate, null,
        ' `default: 0` is not merely a fallback — mongoose applies it on an upsert INSERT, so it '
        + 'would resurrect the zero the write path no longer produces.');
    assert.equal(funnelDay.ad_attributed_share, null);
    assert.equal(funnelDay.views, 0,
        'The COUNTS must stay 0. An absent count genuinely IS zero occurrences, and nulling them '
        + 'would put em dashes over eight tiles that have real answers.');
    assert.equal(funnelDay.installs, 0);

    const geoDay = new ListingGeoDaily({});
    assert.equal(geoDay.conversion_rate, null);
    assert.equal(geoDay.views, 0);
    assert.equal(geoDay.installs, 0);
});
