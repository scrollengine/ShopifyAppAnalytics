'use strict';

/**
 * ============================================================================
 *  THE CONVERSION ANALYSIS TAB — the four fabrications it must not make
 * ============================================================================
 *
 *  Exercises `getFunnel`, `getCohortRetention`, `getTimeToPaid` and `getPlanMix` end to end with
 *  every REPOSITORY stubbed and every FOLD real. Nothing that decides a number is replaced: the
 *  charge-cohort resolver, the install-state fold, `liveSetAsOf` and `rate()` all run, because those
 *  are the things most likely to go wrong and a test that stubbed them would prove nothing.
 *
 *  ── 1. A COHORT TOO YOUNG FOR A CHECKPOINT PUBLISHES `null`, NOT `0` ────────────────────────
 *
 *  `CohortRetentionHeatmap.js:12-17` grades a cell green→yellow→RED by its rate, so a `0` in an
 *  unreached cell is painted solid red at full opacity and captioned "0%" — a specific, checkable
 *  claim that every merchant who installed last week had already churned by month three. And the
 *  publication has to be an ABSENT checkpoint object rather than an object of nulls: `:82-87` titles
 *  the cell "Cohort not aged enough" only when the object is falsy, so `{ pct: null }` renders the
 *  same grey cell with the WRONG tooltip.
 *
 *  ── 2. UNCONVERTED SHOPS ARE EXCLUDED FROM TIME-TO-PAID, AND COUNTED ────────────────────────
 *
 *  They are not "day 0" — which would make the first bar the tallest on the chart and fill it with
 *  merchants who never paid — and they are not in the last bucket, which would drag the median the
 *  strip beneath prints as a measurement. A third case is ours rather than the merchant's: a store
 *  that reached paid billing with no `charge.billingOn` cannot be DATED, so it is excluded too and
 *  `total_paid_shops` is a FLOOR. All three are counted separately.
 *
 *  ── 3. PLAN-MIX MEMBERSHIP IS THE REVENUE PREDICATE, NOT A SECOND ONE ───────────────────────
 *
 *  Asserted against `liveSetAsOf` itself, evaluated in the test over the same fixture. A shop whose
 *  last charge aged out and a shop whose last charge is a refund are both excluded by that predicate
 *  and must be absent from the donut — otherwise the subscriber count under the donut disagrees with
 *  the one behind the MRR figure on the Revenue page, with nothing on either screen to say which is
 *  right.
 *
 *  ── 4. A RATE CROSSING THE GA4/PARTNER SEAM IS MARKED ───────────────────────────────────────
 *
 *  Listing stages count VISITORS and Partner stages count SHOPS, and the chart marks exactly one
 *  boundary while this funnel crosses two — plus both headline badges, which it marks not at all.
 *  The marking has to survive on the payload: per stage, in `rate_definitions`, and in `warnings[]`.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mongoose = require('mongoose');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const MODULE_ROOT = path.join(BACKEND_ROOT, 'src', 'modules', 'conversion');

// Any query that escapes a stub fails fast instead of hanging the suite for the driver's default.
mongoose.set('bufferTimeoutMS', 400);

const config = require(path.join(BACKEND_ROOT, 'src', 'config', 'index.ts'));
const partnerVocab = require(path.join(BACKEND_ROOT, 'src', 'constants', 'partnerVocab.constants.ts'));
const bigQueryModule = require(path.join(BACKEND_ROOT, 'src', 'modules', 'bigquery', 'index.ts'));
const installCohortRepository = require(path.join(MODULE_ROOT, 'repositories', 'installCohort.repository.ts'));
const customFunnelRepository = require(path.join(MODULE_ROOT, 'repositories', 'customFunnel.repository.ts'));
const cohortRetentionRepository = require(path.join(MODULE_ROOT, 'repositories', 'cohortRetention.repository.ts'));
// ⚠️ THE REPOSITORY, NOT `modules/revenue`'s BARREL. `planMix.service` deep-paths this module
// directly — see its header on the cycle a barrel import closes — so the barrel's own copy of the
// function is not the one the service holds.
const revenueRepository = require(path.join(BACKEND_ROOT, 'src', 'modules', 'revenue', 'repositories', 'revenue.repository.ts'));

// PURE leaves, imported for the ASSERTIONS rather than stubbed. `liveSetAsOf` is the whole point of
// test 3: the endpoint must agree with it, so the test evaluates it independently.
const ledgerMrrHelper = require(path.join(BACKEND_ROOT, 'src', 'modules', 'revenue', 'helpers', 'ledgerMrr.helper.ts'));
const stageFunnelConstants = require(path.join(MODULE_ROOT, 'constants', 'stageFunnel.constants.ts'));
const funnelEventConstants = require(path.join(MODULE_ROOT, 'constants', 'funnelEvent.constants.ts'));
const cohortRetentionConstants = require(path.join(MODULE_ROOT, 'constants', 'cohortRetention.constants.ts'));
const timeToPaidConstants = require(path.join(MODULE_ROOT, 'constants', 'timeToPaid.constants.ts'));
const planMixConstants = require(path.join(MODULE_ROOT, 'constants', 'planMix.constants.ts'));
const logoChurnConstants = require(path.join(MODULE_ROOT, 'constants', 'logoChurn.constants.ts'));

const { PARTNER_EVENT_TYPES } = partnerVocab;
const { liveSetAsOf } = ledgerMrrHelper;
const { STAGE_FUNNEL_EVENT_KEYS, STAGE_FUNNEL_SEAM_INDEX } = stageFunnelConstants;
const { FUNNEL_EVENT_BY_KEY } = funnelEventConstants;
const { RETENTION_CHECKPOINT_DAYS } = cohortRetentionConstants;
const { TIME_TO_PAID_BUCKETS } = timeToPaidConstants;
const { PLAN_MIX_UNKNOWN_PLAN_LABEL, PLAN_MIX_CHURN_WINDOW_DAYS } = planMixConstants;
const { RECENT_CHURN_WINDOW_DAYS } = logoChurnConstants;

const WINDOW_DAYS = config.REVENUE.ACTIVE_SUB_WINDOW_DAYS;
const _DAY_MS = 24 * 60 * 60 * 1000;
const _daysAgo = (days) => new Date(Date.now() - days * _DAY_MS);
const _daysFromNow = (days) => new Date(Date.now() + days * _DAY_MS);

const APP = {
    _id: 'app-1',
    display_name: 'Demo App',
    last_synced_at: _daysAgo(1),
    last_bq_synced_at: _daysAgo(1),
    earliest_event_at: _daysAgo(900),
    earliest_transaction_at: _daysAgo(900),
    lifetime_sync_completed_at: _daysAgo(1),
    event_history_gap_days: 0
};

/**
 * ⚠️ Stubs installed BEFORE the services are required. Every service here destructures its
 * dependencies at MODULE LOAD, so a re-assignment afterwards has no effect at all.
 */
const STATE = {
    app: APP,
    bigQuery: { enabled: true, message: '' },
    ga4Totals: null,
    partnerShopSets: { rows: [], shopless_events: 0 },
    transactionShopSets: [],
    firstTransactionShops: 0,
    /** App-wide charge events — what `customFunnel.repository` serves. */
    appChargeEvents: [],
    appSettled: { charge_ids: [], shop_domains: [] },
    /** Spine-scoped charge events — what `installCohort.repository` serves. */
    spineChargeEvents: [],
    spineSettled: [],
    spine: { rows: [], shopless_install_events: 0 },
    relationshipEvents: [],
    history: []
};

installCohortRepository.findPartnerAppById = async () => STATE.app;
installCohortRepository.aggregateInstallSpine = async () => STATE.spine;
installCohortRepository.findChargeCohortEvents = async () => STATE.spineChargeEvents;
installCohortRepository.aggregateSettledSubscriptionCharges = async () => STATE.spineSettled;
customFunnelRepository.aggregatePartnerShopSets = async () => STATE.partnerShopSets;
customFunnelRepository.aggregateTransactionShopSets = async () => STATE.transactionShopSets;
customFunnelRepository.countFirstTransactionShops = async () => STATE.firstTransactionShops;
customFunnelRepository.findChargeCohortEvents = async () => STATE.appChargeEvents;
customFunnelRepository.aggregateSettledSubscriptionEvidence = async () => STATE.appSettled;
cohortRetentionRepository.findRelationshipEvents = async () => STATE.relationshipEvents;
revenueRepository.fetchSubscriptionChargeHistory = async () => STATE.history;
bigQueryModule.resolveBigQueryAvailability = () => STATE.bigQuery;
bigQueryModule.aggregateListingFunnelTotals = async () => STATE.ga4Totals;

const { getFunnel } = require(path.join(MODULE_ROOT, 'services', 'stageFunnel.service.ts'));
const { getCohortRetention } = require(path.join(MODULE_ROOT, 'services', 'cohortRetention.service.ts'));
const { getTimeToPaid } = require(path.join(MODULE_ROOT, 'services', 'timeToPaid.service.ts'));
const { getPlanMix } = require(path.join(MODULE_ROOT, 'services', 'planMix.service.ts'));

const _reset = () => {
    STATE.app = APP;
    STATE.bigQuery = { enabled: true, message: '' };
    STATE.ga4Totals = null;
    STATE.partnerShopSets = { rows: [], shopless_events: 0 };
    STATE.transactionShopSets = [];
    STATE.firstTransactionShops = 0;
    STATE.appChargeEvents = [];
    STATE.appSettled = { charge_ids: [], shop_domains: [] };
    STATE.spineChargeEvents = [];
    STATE.spineSettled = [];
    STATE.spine = { rows: [], shopless_install_events: 0 };
    STATE.relationshipEvents = [];
    STATE.history = [];
};

/**
 * Calls a service and asserts it did not refuse.
 *
 * @param {Function} fn - The service.
 * @param {Object} [params] - Query parameters, merged over `partner_app_id`.
 * @returns {Promise<Object>} The payload.
 */
const _read = async (fn, params = {}) => {
    const result = await fn({ user_id: 'operator-1' }, { partner_app_id: 'app-1', ...params });
    assert.equal(result.status, true, `the service refused: ${result.msg}`);
    return result.data;
};

/** One subscription-charge event, in the shape the cohort resolver reads. */
const _chargeEvent = ({ type, domain, chargeId, at, billingOn = null, plan = '', amount = null, currency = 'USD', test: isTest = false }) => ({
    event_type: type,
    shop_domain: domain,
    charge_id: chargeId,
    occurred_at: at,
    raw_event: {
        charge: {
            id: `gid://partners/AppSubscription/${chargeId}`,
            billingOn: billingOn ? billingOn.toISOString() : null,
            name: plan,
            amount: amount === null ? null : { amount: String(amount), currencyCode: currency },
            test: isTest
        }
    }
});

/** One relationship event, in the shape `modules/store`'s install-state fold reads. */
const _relationshipEvent = (type, domain, at) => ({
    event_type: type,
    shop_domain: domain,
    shop_id: `gid://partners/Shop/${domain}`,
    shop_name: domain,
    occurred_at: at
});

/** One settled `APP_SUBSCRIPTION` payout, as `fetchSubscriptionChargeHistory` flattens it. */
const _charge = (shopId, domain, createdAt, gross = 29, interval = null) => ({
    shop_id: shopId,
    shop_domain: domain,
    gross,
    currency: 'USD',
    billing_interval: interval,
    created_at: createdAt
});

/** NEWEST FIRST — `liveSetAsOf` accepts the first row it sees per shop and relies on that order. */
const _newestFirst = (rows) => [...rows].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

// ══════════════════════════════════════════════════════════════════════════════
//  THE FIXED 7-STAGE FUNNEL, AND THE SEAM IT CROSSES TWICE
// ══════════════════════════════════════════════════════════════════════════════

/**
 * A healthy mixed-tier window: 1,000 listing views narrowing to 100 GA4 installs, 90 Partner
 * installs, and 40 subscriptions of which 25 reached paid billing.
 */
const _seedStageFunnel = () => {
    _reset();
    STATE.ga4Totals = {
        views: 1000,
        engaged_views: 700,
        ad_clicks: 50,
        install_clicks: 300,
        consent_started: 150,
        consent_completed: 120,
        installs: 100,
        first_opens: 95
    };
    const installedShops = [];
    for (let i = 0; i < 90; i += 1) {
        installedShops.push(`shop-${i}.myshopify.com`);
    }
    STATE.partnerShopSets = {
        rows: [{ event_type: PARTNER_EVENT_TYPES.INSTALL, shops: installedShops }],
        shopless_events: 0
    };

    const events = [];
    const settledCharges = [];
    for (let i = 0; i < 40; i += 1) {
        const domain = `shop-${i}.myshopify.com`;
        const chargeId = `${1000 + i}`;
        // The first 25 converted: a billing date already in the past. The rest are still trialling.
        const billingOn = i < 25 ? _daysAgo(5) : _daysFromNow(5);
        events.push(_chargeEvent({
            type: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED,
            domain,
            chargeId,
            at: _daysAgo(20),
            billingOn,
            plan: 'Pro',
            amount: 29
        }));
        if (i < 25) {
            settledCharges.push(chargeId);
        }
    }
    STATE.appChargeEvents = events;
    STATE.appSettled = { charge_ids: settledCharges, shop_domains: [] };
};

test('the fixed funnel is SEVEN stages, in the catalog\'s own vocabulary, with the seam where the chart draws it', async () => {
    _seedStageFunnel();
    const data = await _read(getFunnel);

    assert.equal(data.stages.length, 7, 'the chart is built for exactly seven bars');
    assert.deepEqual(data.stages.map((s) => s.key), [...STAGE_FUNNEL_EVENT_KEYS]);
    //  EVERY stage key must be a REAL catalog entry. A hand-written stage table would be a second
    // vocabulary sitting one tab away from the operator's own funnel on the same page.
    for (const stage of data.stages) {
        const entry = FUNNEL_EVENT_BY_KEY[stage.key];
        assert.ok(entry, `stage "${stage.key}" is not in the funnel event catalog`);
        assert.equal(stage.label, entry.label, 'the stage label must be the catalog\'s, not a second spelling');
        assert.equal(stage.catalog_source, entry.source);
    }

    //  `ConversionFunnelChart.js:57` hard-codes `idx === 4` as the seam row and prints
    // "↑ Visitor-level (GA4) — ↓ Shop-level (Partner)" beneath it. Everything above must be `ga4`.
    assert.equal(data.seam_stage_index, STAGE_FUNNEL_SEAM_INDEX);
    assert.equal(data.stages[STAGE_FUNNEL_SEAM_INDEX].key, 'installed');
    for (let i = 0; i < STAGE_FUNNEL_SEAM_INDEX; i += 1) {
        assert.equal(data.stages[i].source, 'ga4', `stage ${i} sits above the seam caption and must be GA4`);
    }
    for (let i = STAGE_FUNNEL_SEAM_INDEX; i < data.stages.length; i += 1) {
        assert.equal(data.stages[i].source, 'partner', `stage ${i} sits below the seam caption and must be Partner`);
    }

    //  EXACTLY TWO source values reach the chart: `STAGE_COLORS[s.source]` is `undefined` for a
    // third, which draws an invisible bar with a real number beside it.
    for (const stage of data.stages) {
        assert.ok(stage.source === 'ga4' || stage.source === 'partner', `unrenderable source "${stage.source}"`);
    }
});

test('a rate crossing the GA4/Partner seam is MARKED — on the stage, in the definitions, and in warnings', async () => {
    _seedStageFunnel();
    const data = await _read(getFunnel);

    const byKey = new Map(data.stages.map((s) => [s.key, s]));

    // Two boundaries, and the chart marks only the first: visitors → shops, then shops →
    // subscriptions. Both must carry the flag.
    assert.equal(byKey.get('ga4_installs').population, 'visitors');
    assert.equal(byKey.get('installed').population, 'shops');
    assert.equal(byKey.get('trial_started').population, 'subscriptions');
    assert.equal(byKey.get('installed').crosses_measurement_seam, true, 'visitors → shops must be marked');
    assert.equal(byKey.get('trial_started').crosses_measurement_seam, true, 'shops → subscriptions must be marked');
    assert.equal(byKey.get('install_clicks').crosses_measurement_seam, false, 'visitors → visitors is not a seam');

    // The service that measured this already narrates the boundary in the operator's own words.
    assert.ok(
        data.warnings.some((w) => w.includes('count different things')),
        'the population-seam warning from the measuring service must survive the reshape'
    );

    //  BOTH HEADLINE BADGES CROSS A BOUNDARY AND THE CHART MARKS NEITHER — they are drawn as two
    // plain Badges above the bars. The payload is the only place that marking can live.
    assert.equal(data.overall_install_rate, 90 / 1000, 'Partner installs ÷ listing views');
    assert.equal(data.overall_paid_conversion_rate, 25 / 90, 'paid subscriptions ÷ Partner installs');
    assert.match(data.rate_definitions.install_rate, /STORES/);
    assert.match(data.rate_definitions.install_rate, /VISITORS/);
    assert.match(data.rate_definitions.paid_conversion_rate, /SUBSCRIPTIONS/);
    assert.ok(
        data.warnings.some((w) => w.startsWith('Install rate:')),
        'the install-rate badge divides stores by visitors and must say so'
    );
    assert.ok(
        data.warnings.some((w) => w.startsWith('Paid conversion:')),
        'the paid-conversion badge divides subscriptions by stores and must say so'
    );

    // The drift IS the seam, measured. Signed, so its direction survives.
    assert.equal(data.seam_diagnostics.ga4_installs, 100);
    assert.equal(data.seam_diagnostics.partner_installs, 90);
    assert.equal(data.seam_diagnostics.drift_pct, (90 - 100) / 100);
    assert.equal(data.seam_diagnostics.measurable, true);
    assert.equal(data.seam_diagnostics.unknown_reason, null);

    // React keys each warning by the string itself, so a duplicate is DROPPED with its condition.
    assert.equal(new Set(data.warnings).size, data.warnings.length, 'warnings must be unique');
});

test('an unmeasurable drift is null — never 0, which would assert the two systems agree', async () => {
    _seedStageFunnel();
    // The listing tier is unconfigured. The Partner half of the funnel is present and correct.
    STATE.bigQuery = { enabled: false, message: 'Set GCP_PROJECT_ID to enable listing analytics.' };
    STATE.ga4Totals = null;

    const data = await _read(getFunnel);

    const byKey = new Map(data.stages.map((s) => [s.key, s]));
    //  `null`, never `0`. A zero here is "nobody viewed your listing", which is a claim about the
    // business made out of a missing credential.
    assert.equal(byKey.get('views').count, null);
    assert.equal(byKey.get('views').available, false);
    assert.ok(byKey.get('views').unknown_reason, 'a null count must carry the sentence that says why');
    // The Partner half still answers.
    assert.equal(byKey.get('installed').count, 90);

    assert.equal(data.seam_diagnostics.drift_pct, null);
    assert.equal(data.seam_diagnostics.measurable, false);
    assert.ok(data.seam_diagnostics.unknown_reason, 'an unmeasurable drift must say why');
    assert.equal(data.overall_install_rate, null, 'a rate touching an unknown is null, never 0');
    // ⚠️ AND THE CAVEAT IS WITHHELD WITH IT. A warning about how to read an em dash teaches an
    // operator that the warnings block is noise.
    assert.equal(data.warnings.some((w) => w.startsWith('Install rate:')), false);
    assert.ok(data.warnings.some((w) => w.includes('drift')), 'the missing comparison must be explained');
    // ⚠️ NOT NEVER_SYNCED: one tier is READY, and nulling the whole payload would throw away a
    // correct Partner funnel over a missing BigQuery credential.
    assert.equal(data.data_state, undefined);
});

// ══════════════════════════════════════════════════════════════════════════════
//  COHORT RETENTION — THE CELL THAT HAS NO ANSWER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Two cohorts: an 80-day-old pair (one of which uninstalled at +45 days) and a three-day-old store.
 *
 * 80 days reaches +1/+7/+30/+60 and NOT +90; three days reaches +1 and nothing else. So the fixture
 * produces measured cells, an unreached cell on an OLD cohort, and a wholly unreached row.
 */
const _seedRetention = () => {
    _reset();
    const oldInstall = _daysAgo(80);
    const newInstall = _daysAgo(3);
    STATE.spine = {
        rows: [
            { shop_domain: 'stayer.myshopify.com', installed_at: oldInstall, install_count: 1 },
            { shop_domain: 'leaver.myshopify.com', installed_at: oldInstall, install_count: 1 },
            { shop_domain: 'newbie.myshopify.com', installed_at: newInstall, install_count: 1 }
        ],
        shopless_install_events: 0
    };
    STATE.relationshipEvents = [
        _relationshipEvent(PARTNER_EVENT_TYPES.INSTALL, 'stayer.myshopify.com', oldInstall),
        _relationshipEvent(PARTNER_EVENT_TYPES.INSTALL, 'leaver.myshopify.com', oldInstall),
        // +45 days after install, so it is AFTER the +30d checkpoint and BEFORE the +60d one.
        _relationshipEvent(PARTNER_EVENT_TYPES.UNINSTALL, 'leaver.myshopify.com', _daysAgo(35)),
        _relationshipEvent(PARTNER_EVENT_TYPES.INSTALL, 'newbie.myshopify.com', newInstall)
    ];
};

test('a cohort too young to have reached a checkpoint publishes NULL there, not 0', async () => {
    _seedRetention();
    const data = await _read(getCohortRetention, { weeks: 12 });

    assert.deepEqual([...data.checkpoints_days], [...RETENTION_CHECKPOINT_DAYS]);
    const young = data.cohorts.find((row) => row.installs === 1);
    assert.ok(young, 'the three-day-old cohort must have a row of its own');

    // It has lived one day, so +1d is a real measurement.
    assert.equal(young.checkpoints.day_1.eligible, 1);
    assert.equal(young.checkpoints.day_1.retained, 1);
    assert.equal(young.checkpoints.day_1.pct, 1);

    //  AND EVERY LATER CHECKPOINT IS `null` — STRICTLY null, not an object of nulls and never a
    // zero. The heatmap paints a `0` solid red and captions it "0%", which about a store that
    // installed three days ago is a checkable false claim; and an object whose members are null
    // renders the grey cell with the tooltip "—/— retained" instead of "Cohort not aged enough".
    for (const days of [7, 30, 60, 90]) {
        assert.strictEqual(young.checkpoints[`day_${days}`], null, `+${days}d has no answer for a 3-day-old cohort`);
    }
    assert.deepEqual(young.unreached_checkpoints, [7, 30, 60, 90]);
    assert.deepEqual(young.measured_checkpoints, [1]);
    // ⚠️ ALWAYS a number, so a reader can see WHY the right-hand columns are blank.
    assert.equal(typeof young.aged_days, 'number');

    assert.ok(
        data.warnings.some((w) => w.includes('has not aged far enough')),
        'the blank cells must be explained rather than left to look like a rendering fault'
    );
    assert.equal(new Set(data.warnings).size, data.warnings.length, 'warnings must be unique');
});

test('retention is the install-state fold, not a count comparison — an uninstall lowers exactly one cell onward', async () => {
    _seedRetention();
    // ⚠️ 13, not 12. Twelve weekly cohorts reach back 77 days plus however far into the current week
    // today is (0-6), so an 80-day-old install falls OUTSIDE the window on the first three days of
    // every week and this test failed on the calendar, not on the code. Thirteen reaches 84-90 days.
    const data = await _read(getCohortRetention, { weeks: 13 });

    const older = data.cohorts.find((row) => row.installs === 2);
    assert.ok(older, 'the 80-day-old cohort must have a row of its own');

    // Both stores were still installed at +1, +7 and +30 — the uninstall lands at +45.
    for (const days of [1, 7, 30]) {
        assert.equal(older.checkpoints[`day_${days}`].eligible, 2);
        assert.equal(older.checkpoints[`day_${days}`].retained, 2);
        assert.equal(older.checkpoints[`day_${days}`].pct, 1);
    }
    // At +60 the uninstall has happened for one of them. A REAL zero is still reachable, and a real
    // 0.5 is what this is: the null rule is about UNMEASURED cells, never about measured losses.
    assert.equal(older.checkpoints.day_60.eligible, 2);
    assert.equal(older.checkpoints.day_60.retained, 1);
    assert.equal(older.checkpoints.day_60.pct, 0.5);
    // 80 days old, so +90d has not arrived for EITHER store.
    assert.strictEqual(older.checkpoints.day_90, null);

    // The rows read oldest first — the order the heatmap's own rows are drawn in.
    const weeks = data.cohorts.map((row) => row.cohort_week);
    assert.deepEqual(weeks, [...weeks].sort(), 'cohort rows must be oldest first');
    assert.equal(data.data_state, 'READY');
});

test('cohort retention clamps an out-of-range weeks and SAYS SO — a typo widens, never empties', async () => {
    _seedRetention();
    const data = await _read(getCohortRetention, { weeks: 5000 });

    assert.equal(data.weeks, 52, 'clamped to the endpoint\'s ceiling');
    assert.equal(data.cohorts.length, 52);
    assert.ok(data.warnings.some((w) => w.includes('5000 weeks')), 'the clamp must be visible on the payload');
});

test('cohort retention NEVER_SYNCED nulls the grid — the WATERMARK decides, never the row count', async () => {
    _seedRetention();
    STATE.app = { ...APP, last_synced_at: null };

    const data = await _read(getCohortRetention, { weeks: 12 });
    // ⚠️ `null`, not `[]`. An empty ARRAY is a measured empty and the component draws "No install
    // cohorts in this window yet"; a null routes the whole payload to the never-synced banner.
    assert.equal(data.cohorts, null);
    assert.equal(data.data_state, 'NEVER_SYNCED');
    assert.ok(data.unknown_reason, 'without this the page prints the SUCCESS message under the banner heading');

    // And the inverse: a synced app with no installs is a MEASURED empty, not a banner.
    STATE.app = APP;
    STATE.spine = { rows: [], shopless_install_events: 0 };
    STATE.relationshipEvents = [];
    const empty = await _read(getCohortRetention, { weeks: 4 });
    assert.equal(empty.data_state, 'READY');
    assert.equal(empty.cohorts.length, 4, 'every week in the range is enumerated, zeros included');
    assert.equal(empty.cohorts[0].installs, 0);
    assert.strictEqual(empty.cohorts[0].checkpoints.day_1, null, 'a cohort with no stores has no answer, not a 0%');
});

// ══════════════════════════════════════════════════════════════════════════════
//  TIME TO PAID — WHO IS IN THE HISTOGRAM, AND WHO IS COUNTED OUTSIDE IT
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Five stores that installed 20 days ago:
 *   fast    — billed 2 days after install                       → the 1–3 days bucket
 *   slow    — billed 14 days after install                      → the 8–14 days bucket
 *   trial   — no billing date, no settled payout                → still trialling, EXCLUDED
 *   never   — no subscription at all                            → EXCLUDED
 *   undated — paid (settled payout) with no billing date        → EXCLUDED, and the headline is a floor
 */
const _seedTimeToPaid = () => {
    _reset();
    const installedAt = _daysAgo(20);
    const domains = ['fast', 'slow', 'trial', 'never', 'undated'].map((n) => `${n}.myshopify.com`);
    STATE.spine = {
        rows: domains.map((shop_domain) => ({ shop_domain, installed_at: installedAt, install_count: 1 })),
        shopless_install_events: 0
    };
    STATE.spineChargeEvents = [
        _chargeEvent({
            type: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED,
            domain: 'fast.myshopify.com',
            chargeId: '11',
            at: installedAt,
            billingOn: _daysAgo(18),
            plan: 'Starter',
            amount: 9
        }),
        _chargeEvent({
            type: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED,
            domain: 'slow.myshopify.com',
            chargeId: '12',
            at: installedAt,
            billingOn: _daysAgo(6),
            plan: 'Pro',
            amount: 29
        }),
        _chargeEvent({
            type: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED,
            domain: 'trial.myshopify.com',
            chargeId: '13',
            at: installedAt,
            billingOn: null,
            plan: 'Pro',
            amount: 29
        }),
        _chargeEvent({
            type: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED,
            domain: 'undated.myshopify.com',
            chargeId: '14',
            at: installedAt,
            billingOn: null,
            plan: 'Pro',
            amount: 29
        })
    ];
    // Only `undated` has money against it, which is what makes it PAYING with no date to measure to.
    STATE.spineSettled = [{ charge_id: '14', shop_domain: 'undated.myshopify.com', settled_count: 1, billing_interval: null }];
};

test('shops that have NOT converted are excluded from the histogram, and counted', async () => {
    _seedTimeToPaid();
    const data = await _read(getTimeToPaid, { period_days: 30 });

    assert.equal(data.total_installed_shops, 5);
    //  TWO. Not five, and not three: `undated` reached paid billing and still cannot be placed.
    assert.equal(data.total_paid_shops, 2);

    //  THE THREE EXCLUSIONS ARE SEPARATE, because only one of them is about the merchant.
    assert.equal(data.excluded.not_converted, 2, 'the still-trialling store and the one with no subscription');
    assert.equal(data.excluded.converted_without_billing_date, 1, 'paid, but Shopify sent no billing date');
    assert.equal(data.excluded.converted_before_install, 0);
    assert.equal(data.excluded.total, 3);

    //  AND NONE OF THEM LANDED IN A BUCKET. The histogram partitions the converted stores only, so
    // the bars must sum to `total_paid_shops` — a store bucketed at day 0 would make the first bar
    // the tallest on the chart and fill it with merchants who never paid.
    const bucketTotal = data.buckets.reduce((sum, b) => sum + b.count, 0);
    assert.equal(bucketTotal, data.total_paid_shops);
    const byLabel = new Map(data.buckets.map((b) => [b.label, b.count]));
    assert.equal(byLabel.get('Same day'), 0, 'an unconverted store is NOT day 0');
    assert.equal(byLabel.get('1–3 days'), 1);
    assert.equal(byLabel.get('8–14 days'), 1);
    assert.equal(byLabel.get('60+ days'), 0, 'an unconverted store is NOT in the last bucket either');

    // Every bucket comes back, zeros included: a bucket omitted for being empty does not draw an
    // empty bar, it VANISHES, and the histogram changes shape between two reads of the same app.
    assert.equal(data.buckets.length, TIME_TO_PAID_BUCKETS.length);
    assert.deepEqual(data.buckets.map((b) => b.label), TIME_TO_PAID_BUCKETS.map((b) => b.label));
    assert.equal(new Set(data.buckets.map((b) => b.label)).size, data.buckets.length, 'bucket labels are React keys');

    // The stats describe the two dated conversions and nothing else.
    assert.equal(data.stats.count, 2);
    assert.equal(data.stats.min_days, 2);
    assert.equal(data.stats.max_days, 14);
    assert.equal(data.stats.median_days, 8, 'the interpolated midpoint of 2 and 14');

    // Both exclusions are explained, and the coverage one says the headline is a FLOOR.
    assert.ok(data.warnings.some((w) => w.includes('not "day 0"')));
    assert.ok(data.warnings.some((w) => w.includes('FLOOR')), 'an undatable conversion makes the total a floor');
    assert.equal(new Set(data.warnings).size, data.warnings.length, 'warnings must be unique');
});

test('a measured-empty histogram is a 200 with zeros; an unsynced one is null and a banner', async () => {
    _seedTimeToPaid();
    // Nobody converted: every store is still trialling.
    STATE.spineChargeEvents = [];
    STATE.spineSettled = [];
    const measured = await _read(getTimeToPaid, { period_days: 30 });
    assert.equal(measured.data_state, 'READY');
    assert.equal(measured.total_paid_shops, 0, 'a BARE number — the page reads `typeof === "number"`');
    assert.equal(measured.stats, null, 'a zeroed stats block would claim every merchant paid on day one');
    assert.equal(measured.buckets.length, TIME_TO_PAID_BUCKETS.length);
    assert.equal(measured.excluded.not_converted, 5);

    _seedTimeToPaid();
    STATE.app = { ...APP, last_synced_at: null };
    const cold = await _read(getTimeToPaid, { period_days: 30 });
    assert.equal(cold.data_state, 'NEVER_SYNCED');
    assert.equal(cold.buckets, null);
    assert.equal(cold.total_paid_shops, null, 'never 0 — we have not looked');
    assert.ok(cold.unknown_reason);
});

// ══════════════════════════════════════════════════════════════════════════════
//  PLAN MIX — THE MEMBERSHIP THAT MUST MATCH THE REVENUE PAGE
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Four shops in the payout ledger, only two of which the as-of predicate calls paying:
 *   live-pro     — charged 3 days ago, $29 monthly            → PAYING
 *   live-annual  — charged 40 days ago, $240 ANNUAL           → PAYING, booked at $20/month
 *   aged-out     — last charged well beyond the live window   → NOT paying
 *   refunded     — newest row is a credit (gross <= 0)        → NOT paying
 *
 * `refunded` is the one a naive "has any positive charge" predicate would keep, and `live-annual` is
 * the one a naive fixed-window predicate would drop.
 */
const _seedPlanMix = () => {
    _reset();
    STATE.history = _newestFirst([
        _charge('shop-live-pro', 'live-pro.myshopify.com', _daysAgo(3), 29),
        _charge('shop-live-annual', 'live-annual.myshopify.com', _daysAgo(40), 240, 'ANNUAL'),
        _charge('shop-aged-out', 'aged-out.myshopify.com', _daysAgo(WINDOW_DAYS + 60), 29),
        _charge('shop-refunded', 'refunded.myshopify.com', _daysAgo(2), -29),
        _charge('shop-refunded', 'refunded.myshopify.com', _daysAgo(20), 29)
    ]);
    STATE.appChargeEvents = [
        _chargeEvent({
            type: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED,
            domain: 'live-pro.myshopify.com',
            chargeId: '21',
            at: _daysAgo(200),
            billingOn: _daysAgo(190),
            plan: 'Pro',
            amount: 29
        }),
        _chargeEvent({
            type: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED,
            domain: 'live-annual.myshopify.com',
            chargeId: '22',
            at: _daysAgo(400),
            billingOn: _daysAgo(390),
            plan: 'Annual',
            amount: 240,
            currency: 'USD'
        })
    ];
    STATE.appSettled = { charge_ids: ['21', '22'], shop_domains: [] };
};

test('plan-mix membership IS the revenue predicate — the same set, shop for shop', async () => {
    _seedPlanMix();
    const data = await _read(getPlanMix);

    // The predicate, evaluated independently over the same fixture. `liveSetAsOf` is NOT stubbed
    // anywhere in this file: if plan mix grew its own membership test, this is where it would show.
    const expected = liveSetAsOf(STATE.history, new Date(), WINDOW_DAYS);
    assert.equal(expected.size, 2, 'the fixture is only meaningful if the predicate rejects two of the four');
    assert.equal(data.total_active_now, expected.size);

    const totalFromPlans = data.plans.reduce((sum, p) => sum + p.active_now, 0);
    assert.equal(totalFromPlans, data.total_active_now, 'the plans must PARTITION the paying set');

    // The two the predicate rejects must be absent from every bucket.
    const planNames = data.plans.map((p) => p.plan_name).sort();
    assert.deepEqual(planNames, ['Annual', 'Pro']);
    assert.equal(data.plans.length, 2, 'an aged-out shop and a refunded one are not on a plan');

    // ⚠️ MRR IS THE LEDGER'S NORMALISED FIGURE. The annual subscriber is booked at $240/12, not at
    // $240 — booking the charge whole would overstate a monthly run-rate twelvefold, and this total
    // sits on the same screen as the Revenue page's MRR.
    const byPlan = new Map(data.plans.map((p) => [p.plan_name, p]));
    assert.equal(byPlan.get('Pro').mrr_amount, 29);
    assert.equal(byPlan.get('Annual').mrr_amount, 240 / 12);
    assert.equal(data.total_mrr_amount, 29 + 240 / 12);
    assert.equal(byPlan.get('Pro').avg_amount, 29, 'avg is mrr ÷ subscribers, guarded against an empty plan');

    assert.equal(data.data_state, 'READY');
    assert.equal(new Set(data.warnings).size, data.warnings.length, 'warnings must be unique');
});

test('plan mix and logo churn measure "who left" over the SAME window', () => {
    // ⚠️ Two independent constants, on purpose — `PlanMixDonut` and the Logo Churn page each caption
    // their own table "last 30 days" in hard-coded English, so neither may silently follow the other.
    // They are still the same measurement, so a drift between them is a real finding: the two pages
    // would disagree about the same merchants with nothing on either screen to say why.
    assert.equal(PLAN_MIX_CHURN_WINDOW_DAYS, RECENT_CHURN_WINDOW_DAYS);
});

test('a plan nobody was on 30 days ago publishes NO churn rate — never 0%', async () => {
    _seedPlanMix();
    // `live-pro` has been paying throughout; `newcomer` only started inside the churn window, so its
    // plan has an empty opening base.
    STATE.history = _newestFirst([
        ...STATE.history,
        _charge('shop-newcomer', 'newcomer.myshopify.com', _daysAgo(2), 99)
    ]);
    STATE.appChargeEvents = [
        ...STATE.appChargeEvents,
        _chargeEvent({
            type: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED,
            domain: 'newcomer.myshopify.com',
            chargeId: '23',
            at: _daysAgo(5),
            billingOn: _daysAgo(4),
            plan: 'Enterprise',
            amount: 99
        })
    ];
    STATE.appSettled = { charge_ids: ['21', '22', '23'], shop_domains: [] };

    const data = await _read(getPlanMix);
    const enterprise = data.plans.find((p) => p.plan_name === 'Enterprise');
    assert.ok(enterprise, 'the newcomer must appear in the current mix');
    assert.equal(enterprise.active_now, 1);
    assert.equal(enterprise.active_30d_ago, 0);
    assert.equal(enterprise.churned_in_30d, 0);
    //  `null`, never `0`. "0.0%" beside "Churn rate" is a claim of perfect retention over a plan
    // nobody was on.
    assert.strictEqual(enterprise.churn_30d_pct, null);
});

test('an un-nameable plan is labelled, counted and reported — never guessed into a real plan', async () => {
    _seedPlanMix();
    // The charge events for `live-pro` were never synced, so its plan cannot be named.
    STATE.appChargeEvents = STATE.appChargeEvents.filter((e) => e.shop_domain !== 'live-pro.myshopify.com');
    STATE.appSettled = { charge_ids: ['22'], shop_domains: [] };

    const data = await _read(getPlanMix);

    const unknown = data.plans.find((p) => p.plan_name === PLAN_MIX_UNKNOWN_PLAN_LABEL);
    assert.ok(unknown, 'the bucket must exist rather than the shop being dropped or guessed');
    assert.equal(unknown.active_now, 1);
    // ⚠️ SUBSCRIBERS, not plans — the page prints this as "N subscribers grouped under …".
    assert.equal(data.payload_health.plans_without_charge_payload, 1);
    //  The literal the renderer tests for. `PlanMixDonut.js:128` compares `=== '(plan unknown)'`
    // to decide whether to badge the row "Re-sync to enrich".
    assert.equal(data.unknown_plan_label, '(plan unknown)');
    assert.ok(data.warnings.some((w) => w.includes(PLAN_MIX_UNKNOWN_PLAN_LABEL)));
});

test('plan mix separates "never synced" from "synced, and nothing is billed"', async () => {
    _seedPlanMix();
    STATE.app = { ...APP, last_synced_at: null };
    const cold = await _read(getPlanMix);
    assert.equal(cold.data_state, 'NEVER_SYNCED');
    assert.equal(cold.plans, null);
    assert.equal(cold.total_active_now, null, 'never 0 — the page would print "No active paid subscribers"');
    assert.ok(cold.unknown_reason);

    //  A SYNCED APP WITH AN EMPTY LEDGER STAYS READY. The watermark is set; only the rows are
    // missing, and a row count is not a sync state.
    _seedPlanMix();
    STATE.history = [];
    const empty = await _read(getPlanMix);
    assert.equal(empty.data_state, 'READY');
    assert.equal(empty.plans, null, 'still withheld — there is no paying base to break down');
    assert.ok(empty.warnings.some((w) => w.includes('No settled subscription payouts')));
});
