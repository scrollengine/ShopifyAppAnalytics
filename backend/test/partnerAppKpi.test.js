'use strict';

/**
 * ============================================================================
 *  THE INSTALL TREND, AND THE RAW EVENT LOG UNDER IT
 * ============================================================================
 *
 *  Exercises `getPartnerAppKpi` and `getPartnerAppEvents` with the read
 *  repository stubbed out, so bucket building → coverage gate → fold → payload
 *  runs against fixtures with no database.
 *
 *  ── 1.  THE RULE THIS FILE EXISTS FOR ────────────────────────────────────
 *
 *  A bucket with no MEASURABLE value publishes `null`, never `0`.
 *  `InstallTrendChart` plots with Recharts' default `connectNulls={false}`, so
 *  a null BREAKS the line — the honest rendering of "we hold no records here".
 *  A `0` runs the line along the floor and asserts that nobody installed the
 *  app that day, which is a claim about the merchant's business made out of an
 *  absence of data. The two are one keystroke apart in the source and worlds
 *  apart on the screen.
 *
 *  The inverse matters just as much and is tested beside it: a bucket INSIDE
 *  the covered record with no rows is a measured zero and must be published as
 *  `0`. Collapsing that into `null` would break the line over months that
 *  genuinely were quiet, which is the same failure pointed the other way.
 *
 *  ── 2. THE TILES AND THE CHART ARE ONE FOLD ────────────────────────────────
 *
 *  Both come from a single `(bucket, event_type)` tally, so a reader who sums
 *  the bars and compares the answer with the tile above them gets the same
 *  number by construction. The truncation test pins the one place they are
 *  deliberately allowed to differ — and why.
 *
 *  ── 3. THE EVENT LIST'S TREND IS NOT THE EVENT LIST ────────────────────────
 *
 *  A trend folded from the current page would change shape as the reader pages,
 *  and a `?type=`-filtered one would plot "installs" from a set that excludes
 *  installs. Both are asserted directly.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mongoose = require('mongoose');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const MODULE_ROOT = path.join(BACKEND_ROOT, 'src', 'modules', 'partner');

mongoose.set('bufferTimeoutMS', 400);

const appRepository = require(path.join(MODULE_ROOT, 'repositories', 'partnerApp.repository.ts'));
const readRepository = require(path.join(MODULE_ROOT, 'repositories', 'partnerAppRead.repository.ts'));

/**
 *  CAPTURED BEFORE ANY STUB IS INSTALLED, AND ASSERTED BELOW.
 *
 * `partnerAppRead.repository` re-exports two of `modules/revenue`'s own readers by deep path rather
 * than re-summing payouts locally. That is the reuse the design wants, and it is also the exact
 * shape of import that once closed a cycle in this codebase and left `liveSetAsOf` `undefined` at
 * load — typing perfectly, linting perfectly, and failing fifteen tests with "could not read".
 *
 * A cycle here would leave these two keys `undefined` and every money figure would silently vanish,
 * so the real, un-stubbed surface is snapshotted at require time and checked.
 */
const REAL_READ_REPOSITORY_SURFACE = Object.keys(readRepository)
    .map((key) => ({ key, type: typeof readRepository[key] }));

/** ⚠️ Relative to NOW — the services read the clock to clamp the judgement instant. */
const NOW = Date.now();
const _daysAgo = (days) => new Date(NOW - (days * 86400000));

/** UTC bucket keys, built exactly as the pipeline's `$dateToString` builds them. */
const _dayKey = (at) => at.toISOString().slice(0, 10);
const _monthKey = (at) => at.toISOString().slice(0, 7);

const BASE_APP = {
    _id: 'app-1',
    app_handle: 'demo-app',
    display_name: 'Demo App',
    listing_url: 'https://apps.shopify.com/demo',
    partner_api_app_id: 'gid://partners/App/7654321',
    categories: [],
    target_keywords: [],
    is_active: true,
    last_synced_at: _daysAgo(1),
    lifetime_sync_completed_at: _daysAgo(2),
    earliest_event_at: _daysAgo(900),
    earliest_transaction_at: _daysAgo(880),
    shop_name_coverage_since: _daysAgo(60),
    event_history_gap_days: 0,
    charge_link_absent_pct: 0,
    charge_link_unresolved_pct: 0,
    createdAt: _daysAgo(1000),
    updatedAt: _daysAgo(1)
};

/** ⚠️ Installed BEFORE the services are required — both destructure at module load. */
const STATE = {
    app: { ...BASE_APP },
    buckets: [],
    allTimeCounts: [],
    relationshipRows: [],
    currencies: ['USD'],
    windowCash: null,
    lifetimeCash: null,
    eventRows: [],
    eventTotal: 0,
    /** The query each read was handed, so the filter and the paging can be asserted. */
    lastBucketQuery: null,
    lastPageQuery: null
};

const _reset = () => {
    STATE.app = { ...BASE_APP };
    STATE.buckets = [];
    STATE.allTimeCounts = [];
    STATE.relationshipRows = [];
    STATE.currencies = ['USD'];
    STATE.windowCash = null;
    STATE.lifetimeCash = null;
    STATE.eventRows = [];
    STATE.eventTotal = 0;
    STATE.lastBucketQuery = null;
    STATE.lastPageQuery = null;
};

appRepository.findPartnerAppById = async (id) => {
    if (!STATE.app || String(STATE.app._id) !== String(id)) {
        return null;
    }
    return { ...STATE.app };
};

readRepository.aggregateRelationshipBuckets = async (query) => {
    STATE.lastBucketQuery = query;
    return STATE.buckets;
};
readRepository.aggregateRelationshipTypeCounts = async () => STATE.allTimeCounts;
readRepository.findAllRelationshipEvents = async () => ({
    rows: STATE.relationshipRows,
    shopless_relationship_events: 0
});
readRepository.aggregateWindowCurrencies = async () => STATE.currencies;
readRepository.getWindowCash = async () => STATE.windowCash;
readRepository.getLifetimeCash = async () => STATE.lifetimeCash;
readRepository.findPartnerEventPage = async (query) => {
    STATE.lastPageQuery = query;
    return { rows: STATE.eventRows, total: STATE.eventTotal };
};

const { getPartnerAppKpi } = require(path.join(MODULE_ROOT, 'services', 'partnerAppKpi.service.ts'));
const { getPartnerAppEvents } = require(path.join(MODULE_ROOT, 'services', 'partnerAppEvents.service.ts'));

const OPERATOR = { user_id: 'operator-1' };

/** One `(bucket, event_type)` tally, as the aggregate returns it. */
const _tally = (bucket, event_type, count, shopless = 0) => ({ bucket, event_type, count, shopless });

/** One raw event row as the paginated read projects it. */
const _eventRow = (overrides) => ({
    partner_event_id: 'ev-1',
    event_type: 'INSTALL',
    occurred_at: _daysAgo(3),
    shop_domain: 'a.myshopify.com',
    shop_name: 'Store A',
    shop_id: 'gid://partners/Shop/1',
    charge_id: '',
    ...overrides
});

/** The trend point for a bucket key, or undefined. */
const _pointAt = (trend, key) => trend.find((point) => point.date === key);


test(' every read-repository export resolves to a function — a cycle would leave one undefined', () => {
    // Snapshotted at require time, before the stubs below replaced them. See the constant's note.
    for (const entry of REAL_READ_REPOSITORY_SURFACE) {
        assert.equal(entry.type, 'function',
            `${entry.key} is ${entry.type}, not a function. The two money readers are re-exported from `
            + 'modules/revenue by deep path; a cycle would leave them undefined at load, which type-checks '
            + 'and lints perfectly and shows up only as every cash figure quietly disappearing.');
    }
    const names = REAL_READ_REPOSITORY_SURFACE.map((entry) => entry.key);
    assert.ok(names.includes('getWindowCash') && names.includes('getLifetimeCash'),
        'The money readers must come from modules/revenue. A local $sum here would restate two '
        + 'judgements — every transaction type, and created_at rather than createdAt — and the KPI tile '
        + 'would start disagreeing with the Revenue page.');
});


/* ==========================================================================
 *  1.  null, never 0 — and 0, never null
 * ========================================================================== */

test(' a bucket BELOW the coverage floor publishes four nulls and a reason — the line breaks', async () => {
    _reset();
    // No lifetime sync, and the oldest event held is ten days old. Everything before that is a
    // stretch nobody fetched.
    STATE.app.lifetime_sync_completed_at = null;
    STATE.app.earliest_event_at = _daysAgo(10);
    STATE.buckets = [_tally(_dayKey(_daysAgo(3)), 'INSTALL', 5)];

    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });

    assert.equal(result.status, true);
    const trend = result.data.trend;
    assert.ok(Array.isArray(trend) && trend.length > 0);

    const below = _pointAt(trend, _dayKey(_daysAgo(20)));
    assert.ok(below, 'The bucket must still be PLOTTED — a missing point is an axis that silently skips a day.');
    assert.equal(below.measurable, false);
    assert.equal(below.installs, null,
        ' null, NEVER 0. Recharts breaks the line on null and runs it along the floor on 0, and the '
        + 'second reads as "nobody installed the app" over a stretch nobody fetched.');
    assert.equal(below.uninstalls, null);
    assert.equal(below.reinstalls, null);
    assert.equal(below.deactivations, null);
    assert.ok(below.unknown_reason && below.unknown_reason.length > 0,
        'An unknown point carries its reason — a broken line with no explanation reads as a rendering bug.');
});

test(' a bucket INSIDE coverage with no rows publishes 0 — a measured empty is not an unknown', async () => {
    _reset();
    STATE.app.lifetime_sync_completed_at = null;
    STATE.app.earliest_event_at = _daysAgo(10);
    STATE.buckets = [_tally(_dayKey(_daysAgo(3)), 'INSTALL', 5)];

    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });
    const trend = result.data.trend;

    const quiet = _pointAt(trend, _dayKey(_daysAgo(4)));
    assert.ok(quiet);
    assert.equal(quiet.measurable, true);
    assert.equal(quiet.installs, 0,
        'Collapsing a measured zero into null would break the line over days that genuinely were '
        + 'quiet — the same failure pointed the other way.');
    assert.equal(quiet.unknown_reason, undefined,
        'A measurable point carries NO reason. Attaching one to every point trains a reader to ignore it.');

    const busy = _pointAt(trend, _dayKey(_daysAgo(3)));
    assert.equal(busy.installs, 5);
    assert.equal(busy.uninstalls, 0, 'A type with no tally in a measurable bucket is a real zero.');
});

test('a point is either fully measured or fully unknown — never three numbers and a null', async () => {
    _reset();
    STATE.app.lifetime_sync_completed_at = null;
    STATE.app.earliest_event_at = _daysAgo(10);
    STATE.buckets = [_tally(_dayKey(_daysAgo(3)), 'INSTALL', 5)];

    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });

    for (const point of result.data.trend) {
        const values = [point.installs, point.uninstalls, point.reinstalls, point.deactivations];
        const nulls = values.filter((v) => v === null).length;
        assert.ok(nulls === 0 || nulls === 4,
            `${point.date} mixes measured and unknown counts. The four are folded from one array in one `
            + 'pass, so a payload with three numbers and one null would be describing two windows.');
        if (nulls === 0) {
            for (const v of values) {
                assert.equal(typeof v, 'number');
            }
        }
    }
});

test(' an INCOMPLETE record with no measured floor publishes NOTHING as zero — not one flat line', async () => {
    _reset();
    //  THE REGRESSION THIS TEST EXISTS FOR. No lifetime sync has ever completed AND no earliest
    // event has been measured — an operator who forced INCREMENTAL on an app that was never
    // backfilled. "No floor" is ambiguous on its own: after a lifetime sync it means EVERYTHING is
    // measurable, and here it means NOTHING is. Reading one nullable date for both drew a flat line
    // at zero across the whole chart for exactly this deployment: an app nobody had backfilled,
    // rendered as an app nobody had installed.
    STATE.app.lifetime_sync_completed_at = null;
    STATE.app.earliest_event_at = null;
    STATE.app.earliest_transaction_at = null;

    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });

    assert.equal(result.status, true);
    assert.equal(result.data.data_state, 'READY', 'A sync HAS completed — this is not NEVER_SYNCED.');
    assert.equal(result.data.coverage.event_floor, null);
    assert.equal(result.data.coverage.all_time_measurable, false);
    assert.equal(result.data.coverage.counts_measurable, false);

    for (const point of result.data.trend) {
        assert.equal(point.measurable, false, `${point.date} must not claim to be measured.`);
        assert.equal(point.installs, null,
            ' Not one bucket may publish 0. A missing floor is not a licence to draw a line at the '
            + 'floor — it is the statement that nothing is known.');
    }
    assert.equal(result.data.counts.installs, null);
    assert.equal(result.data.revenue.gross_total, null);
    assert.ok(result.data.warnings.some((w) => /no earliest Partner event/i.test(w)));
});

test('the event read applies the same rule — no measured floor means an unknown chart, not a flat one', async () => {
    _reset();
    STATE.app.lifetime_sync_completed_at = null;
    STATE.app.earliest_event_at = null;
    STATE.eventRows = [_eventRow({})];
    STATE.eventTotal = 1;

    const result = await getPartnerAppEvents(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });

    assert.equal(result.status, true);
    assert.equal(result.data.items.length, 1, 'The rows we DO hold are still listed — they exist.');
    for (const point of result.data.trend) {
        assert.equal(point.installs, null);
    }
    assert.ok(result.data.warnings.some((w) => /no earliest Partner event/i.test(w)));
});

test('shopless events are COUNTED in the tiles but excluded from the estimated-active fold, and both are said', async () => {
    _reset();
    STATE.buckets = [_tally(_dayKey(_daysAgo(2)), 'INSTALL', 5, 2)];
    STATE.allTimeCounts = [_tally('', 'INSTALL', 40, 6)];
    STATE.relationshipRows = [
        { shop_domain: 'a.myshopify.com', event_type: 'INSTALL', occurred_at: _daysAgo(5), shop_id: 'gid://partners/Shop/1', shop_name: 'A' }
    ];

    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });

    assert.equal(result.data.counts.installs, 5,
        'An install event with no shop block is still an install — dropping it would shrink a '
        + 'published count.');
    assert.equal(result.data.diagnostics.window_shopless_events, 2);
    assert.equal(result.data.all_time.estimated_active, 1,
        'The estimated-active fold is over STORES, and a shopless event has no store to fold into.');
    // Two different exclusions, two different sentences — a shared wording would collapse into one
    // banner and take the other count with it.
    const windowWarning = result.data.warnings.find((w) => /selected period carry no shop domain/.test(w));
    const allTimeWarning = result.data.warnings.find((w) => /whole history carry no shop domain/.test(w));
    assert.ok(windowWarning && /^2 /.test(windowWarning));
    assert.ok(allTimeWarning && /^6 /.test(allTimeWarning));
});

test('every plotted point carries the `date` key the chart hard-codes, in the grain it declares', async () => {
    _reset();
    STATE.buckets = [];

    const short = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });
    assert.equal(short.data.trend_grain, 'day', 'A one-month window is plotted per day.');
    for (const point of short.data.trend) {
        assert.match(point.date, /^\d{4}-\d{2}-\d{2}$/,
            'InstallTrendChart hard-codes dataKey="date", and the apps page DROPS any row without one.');
    }

    _reset();
    const long = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 400 });
    assert.equal(long.data.trend_grain, 'month',
        'A multi-year window at day grain is thousands of points crushed into 280 pixels — a block of '
        + 'ink that reads as noise. The grain is published so nobody infers it from the label format.');
    for (const point of long.data.trend) {
        assert.match(point.date, /^\d{4}-\d{2}$/);
    }
});

test('the series is oldest-first — the order an x-axis reads in', async () => {
    _reset();
    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });
    const dates = result.data.trend.map((point) => point.date);
    const sorted = [...dates].sort();
    assert.deepEqual(dates, sorted);
});


/* ==========================================================================
 *  2. The tiles and the chart are one fold
 * ========================================================================== */

test('the window tiles are the SUM of the plotted points when every bucket is measurable', async () => {
    _reset();
    STATE.buckets = [
        _tally(_dayKey(_daysAgo(2)), 'INSTALL', 4),
        _tally(_dayKey(_daysAgo(5)), 'INSTALL', 6),
        _tally(_dayKey(_daysAgo(5)), 'UNINSTALL', 2),
        _tally(_dayKey(_daysAgo(9)), 'REINSTALL', 1),
        _tally(_dayKey(_daysAgo(9)), 'DEACTIVATED', 3)
    ];

    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });
    const trend = result.data.trend;
    const summed = trend.reduce((acc, point) => acc + (point.installs || 0), 0);

    assert.equal(result.data.counts.installs, 10);
    assert.equal(summed, 10,
        'A reader who sums the bars and compares the answer with the tile above them must get the same '
        + 'number. They come from one tally in one pass, so this holds by construction.');
    assert.equal(result.data.counts.uninstalls, 2);
    assert.equal(result.data.counts.reinstalls, 1);
    assert.equal(result.data.counts.deactivations, 3);
});

test(' a TRUNCATED chart does not shrink the tile above it — and says how many buckets it dropped', async () => {
    _reset();
    // ~132 calendar months, above the 120-point ceiling.
    STATE.buckets = [
        _tally(_dayKey(_daysAgo(2)).slice(0, 7), 'INSTALL', 7),
        // Filed in a month that falls off the front of the chart.
        _tally(_monthKey(_daysAgo(3900)), 'INSTALL', 40)
    ];

    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 4000 });

    assert.ok(result.data.diagnostics.withheld_trend_buckets > 0, 'The ceiling must have bitten.');
    assert.equal(result.data.trend.length, 120);
    assert.equal(result.data.counts.installs, 47,
        ' The window total is a fact about the ROWS in the window; the chart is a fact about the '
        + 'buckets that fit on it. Deriving one from the other would let a bounded chart silently '
        + 'shrink the number printed above it.');
    assert.ok(result.data.warnings.some((w) => /not plotted/.test(w)),
        'A silently truncated chart is a chart that lies about where its history starts.');
    assert.equal(_pointAt(result.data.trend, _monthKey(_daysAgo(2))).installs, 7,
        'The NEWEST buckets are the ones kept.');
});

test('a partial end bucket is flagged, because its bar is shorter for a reason the chart cannot show', async () => {
    _reset();
    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 400 });

    const partials = result.data.trend.filter((point) => point.is_partial);
    assert.ok(partials.length > 0,
        'A 400-day window at month grain always has at least a month-to-date bucket at the end.');
    assert.ok(result.data.warnings.some((w) => /partly inside/.test(w)));
});


/* ==========================================================================
 *  3. Money, and the currency it is denominated in
 * ========================================================================== */

test('a single currency captions the tile; more than one publishes NO caption and says why', async () => {
    _reset();
    STATE.windowCash = { gross: 100, net: 90, shopify_fee: 10, tx_count: 4 };
    STATE.currencies = ['USD'];

    const one = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });
    assert.equal(one.data.revenue.currency, 'USD');
    assert.equal(one.data.revenue.gross_total, 100);

    _reset();
    STATE.windowCash = { gross: 100, net: 90, shopify_fee: 10, tx_count: 4 };
    STATE.currencies = ['EUR', 'USD'];

    const many = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });
    assert.equal(many.data.revenue.currency, null,
        'There is no FX table anywhere in this build on purpose — a wrong rate produces a plausible '
        + 'wrong number — so a multi-currency total must not be captioned with one of their symbols.');
    assert.equal(many.data.revenue.gross_total, 100, 'The sum is still published; only the label is withheld.');
    assert.ok(many.data.warnings.some((w) => /EUR, USD/.test(w)));
});

test('all-time cash comes from the revenue ledger unchanged — nothing here re-sums payouts', async () => {
    _reset();
    STATE.lifetimeCash = { total_gross: 12345.67, total_net: 10000, total_fee: 2345.67, tx_count: 900, subscription_tx_count: 880 };

    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });
    assert.equal(result.data.all_time.gross_revenue, 12345.67);
    assert.equal(result.data.all_time.net_revenue, 10000);
    assert.equal(result.data.all_time.transaction_count, 900);
});


/* ==========================================================================
 *  4. The event list
 * ========================================================================== */

test('an empty page is a 200 with items: [] — a list has an honest empty rendering', async () => {
    _reset();
    STATE.eventRows = [];
    STATE.eventTotal = 0;

    const result = await getPartnerAppEvents(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });

    assert.equal(result.status, true);
    assert.equal(result.data.data_state, 'READY');
    assert.deepEqual(result.data.items, [], 'Not null — null is reserved for NEVER_SYNCED.');
    assert.equal(result.data.pagination.total, 0);
    assert.equal(result.data.pagination.total_pages, 0);
    assert.equal(result.data.pagination.has_more, false);
});

test(' an unsynced app returns items: null and NEVER_SYNCED — decided by the watermark', async () => {
    _reset();
    STATE.app.last_synced_at = null;
    STATE.eventRows = [_eventRow({})];
    STATE.eventTotal = 1;

    const result = await getPartnerAppEvents(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });

    assert.equal(result.data.data_state, 'NEVER_SYNCED');
    assert.equal(result.data.items, null,
        'null, not [] — an empty array is a MEASURED "nothing matched" and renders as an empty table '
        + 'over an app nobody has synced.');
    assert.equal(result.data.trend, null);
    assert.equal(STATE.lastPageQuery, null, 'Not one row may be read to decide this.');
});

test('an unrecognised ?type= WIDENS the list and warns — it never empties it', async () => {
    _reset();
    STATE.eventRows = [_eventRow({})];
    STATE.eventTotal = 1;

    const result = await getPartnerAppEvents(OPERATOR, { partner_app_id: 'app-1', period_days: 30, type: 'INSTALLL' });

    assert.equal(result.status, true);
    assert.equal(result.data.filters.type, null);
    assert.equal(result.data.filters.type_ignored, true);
    assert.equal(STATE.lastPageQuery.event_type, null,
        'A table rendering zero rows because of a typo in a query string is indistinguishable from an '
        + 'app with no events.');
    assert.ok(result.data.warnings.some((w) => /INSTALLL/.test(w)));
});

test('a recognised ?type= is applied, case-insensitively', async () => {
    _reset();
    STATE.eventRows = [_eventRow({})];
    STATE.eventTotal = 1;

    const result = await getPartnerAppEvents(OPERATOR, { partner_app_id: 'app-1', period_days: 30, type: 'uninstall' });

    assert.equal(result.data.filters.type, 'UNINSTALL');
    assert.equal(result.data.filters.type_ignored, false);
    assert.equal(STATE.lastPageQuery.event_type, 'UNINSTALL');
});

test(' the trend is NOT filtered by ?type= and NOT sliced by the page', async () => {
    _reset();
    STATE.eventRows = [];
    STATE.eventTotal = 500;
    STATE.buckets = [_tally(_dayKey(_daysAgo(2)), 'INSTALL', 9)];

    const result = await getPartnerAppEvents(OPERATOR, {
        partner_app_id: 'app-1',
        period_days: 30,
        type: 'UNINSTALL',
        page: 7,
        limit: 25
    });

    // The bucket read is issued with the WINDOW only — no event type, no skip, no limit.
    assert.equal(STATE.lastBucketQuery.event_type, undefined,
        'A trend built from a type-filtered read would plot "installs" from a set that excludes installs.');
    assert.equal(STATE.lastBucketQuery.skip, undefined);
    assert.equal(_pointAt(result.data.trend, _dayKey(_daysAgo(2))).installs, 9,
        'A trend that reshapes itself as the reader pages is the most convincing possible way to be wrong.');
    assert.equal(STATE.lastPageQuery.skip, 150, 'The PAGE is sliced; the trend is not.');
    assert.equal(STATE.lastPageQuery.limit, 25);
});

test('pagination arithmetic is derived from the matched total, not from the rows on this page', async () => {
    _reset();
    STATE.eventRows = [_eventRow({}), _eventRow({ partner_event_id: 'ev-2' })];
    STATE.eventTotal = 101;

    const result = await getPartnerAppEvents(OPERATOR, { partner_app_id: 'app-1', period_days: 30, page: 2, limit: 50 });

    assert.equal(result.data.pagination.total, 101);
    assert.equal(result.data.pagination.total_pages, 3);
    assert.equal(result.data.pagination.has_more, true);
    assert.equal(result.data.diagnostics.rows_returned, 2);
});

test('a junk page or limit is clamped rather than refused — a typo is a typo', async () => {
    _reset();
    STATE.eventTotal = 10;

    const result = await getPartnerAppEvents(OPERATOR, { partner_app_id: 'app-1', period_days: 30, page: 'banana', limit: '99999' });

    assert.equal(result.status, true);
    assert.equal(result.data.pagination.page, 1);
    assert.equal(result.data.pagination.limit, 200, 'Clamped to the ceiling, not refused.');
});

test('a page past the end says so — empty because the page does not exist, not because nothing matched', async () => {
    _reset();
    STATE.eventRows = [];
    STATE.eventTotal = 10;

    const result = await getPartnerAppEvents(OPERATOR, { partner_app_id: 'app-1', period_days: 30, page: 9, limit: 50 });

    assert.deepEqual(result.data.items, []);
    assert.ok(result.data.warnings.some((w) => /past the end/.test(w)));
});

test(' a blank shop_name is published as null and explained by the BOUNDARY — it never means "no name"', async () => {
    _reset();
    STATE.eventRows = [
        _eventRow({ partner_event_id: 'ev-old', shop_name: '' }),
        _eventRow({ partner_event_id: 'ev-new', shop_name: 'Store A' })
    ];
    STATE.eventTotal = 2;

    const result = await getPartnerAppEvents(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });

    assert.equal(result.data.items[0].shop_name, null);
    assert.equal(result.data.items[1].shop_name, 'Store A');
    const warning = result.data.warnings.find((w) => /store name/i.test(w));
    assert.ok(warning, 'The absence must be explained, or a half-named table reads as data loss.');
    assert.match(warning, /LIFETIME/,
        'The fix is one command, and the warning has to say which one.');
    assert.match(warning, new RegExp(_dayKey(BASE_APP.shop_name_coverage_since)),
        'The BOUNDARY, not a bare count — it is what turns "data was lost" into "sync state".');
});

test('a blank charge_id is null too, and that null is a MEASUREMENT — relationship events carry no charge', async () => {
    _reset();
    STATE.eventRows = [_eventRow({ event_type: 'INSTALL', charge_id: '' }), _eventRow({ partner_event_id: 'ev-2', event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED', charge_id: '111' })];
    STATE.eventTotal = 2;

    const result = await getPartnerAppEvents(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });

    assert.equal(result.data.items[0].charge_id, null);
    assert.equal(result.data.items[1].charge_id, '111',
        'Stored already normalised to the bare numeric id, so it joins the payout ledger directly.');
});

test('the raw Partner payload is withheld, and the response says so rather than leaving a gap', async () => {
    _reset();
    STATE.eventRows = [_eventRow({})];
    STATE.eventTotal = 1;

    const result = await getPartnerAppEvents(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });

    assert.equal(result.data.items[0].raw_event, undefined);
    assert.ok(result.data.warnings.some((w) => /raw Partner API payload/i.test(w)));
});

test('every warning string on both endpoints is unique — a duplicate is DROPPED by the renderer', async () => {
    _reset();
    STATE.app.lifetime_sync_completed_at = null;
    STATE.app.earliest_event_at = _daysAgo(10);
    STATE.eventRows = [_eventRow({ shop_name: '' })];
    STATE.eventTotal = 1;
    STATE.currencies = ['USD', 'EUR'];

    const kpi = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 400 });
    assert.equal(new Set(kpi.data.warnings).size, kpi.data.warnings.length);
    assert.ok(kpi.data.warnings.length > 0);

    const events = await getPartnerAppEvents(OPERATOR, { partner_app_id: 'app-1', period_days: 400 });
    assert.equal(new Set(events.data.warnings).size, events.data.warnings.length);
});

test('the coverage block travels with both payloads — the gates are public, not internal', async () => {
    _reset();
    const kpi = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });
    const events = await getPartnerAppEvents(OPERATOR, { partner_app_id: 'app-1', period_days: 30 });

    for (const data of [kpi.data, events.data]) {
        assert.ok(data.coverage);
        assert.equal(typeof data.coverage.counts_measurable, 'boolean');
        assert.equal(typeof data.coverage.all_time_measurable, 'boolean');
        assert.ok('event_floor' in data.coverage);
        assert.ok('last_synced_at' in data.coverage);
    }
    assert.equal(kpi.data.coverage.event_floor, null,
        'A completed LIFETIME sync means there is no floor at all — null here is COMPLETE, not unknown.');
});

test('an "all time" window starts the chart at the oldest event held, and says so', async () => {
    _reset();
    STATE.buckets = [];

    const result = await getPartnerAppKpi(OPERATOR, { partner_app_id: 'app-1', period_days: 'all' });

    assert.equal(result.data.is_lifetime, true);
    assert.equal(result.data.trend[0].date, _monthKey(BASE_APP.earliest_event_at),
        'Below the oldest event held there is nothing to plot, whatever the window says.');
    assert.ok(result.data.warnings.some((w) => /oldest Partner event on record/.test(w)));
});

test('events on an app that does not exist is a not-found', async () => {
    _reset();
    const result = await getPartnerAppEvents(OPERATOR, { partner_app_id: 'no-such-app', period_days: 30 });
    assert.equal(result.status, false);
    assert.match(result.msg, /not found/i);
});
