'use strict';

/**
 * ============================================================================
 *  THE EXPOSURE ON THE WIRE — the counters, the null, and the figures that must not move
 * ============================================================================
 *
 *  `test/cancelTrap.test.js` pins the FOLD. This file pins what reaches an operator, because a
 *  counter that never leaves the resolver is the exact defect this work was opened to fix:
 *  `diagnostics.subscriptions_superseded` was computed on every request and read by NOTHING.
 *
 *  Three things are held here, and each has already failed once somewhere in this codebase:
 *
 *  ── 1. THE SUB-OBJECTS' KEY SETS ARE PINNED ──────────────────────────────
 *
 *  `customFunnel.test.js:813` pins `diagnostics.charge_link`'s three keys the same way, for the same
 *  reason: a nested counter block is exactly the kind of thing a refactor drops a key from without
 *  anything failing. `Object.keys().sort()` is what turns that into a red test.
 *
 *  ── 2. `null` IS NOT A ZEROED OBJECT ─────────────────────────────────────
 *
 *  When no subscription step is selected, the charge cohort is never folded — so a zeroed
 *  `supersession` block would report "we looked for superseded subscriptions and found none" on a
 *  request that never looked. That is the same manufactured-measurement error `FIDELITY.md` §1
 *  forbids one layer down, and `charge_link` already answers `null` here for it.
 *
 *  ── 3. NOT ONE PUBLISHED FIGURE MOVES ─────────────────────────────────
 *
 *  This is Tier 1: quantify the exposure, change nothing. The plan-change fixture below is asserted
 *  at its UNADJUSTED trial counts on the wire, so a later change that silently compensates has to
 *  edit an assertion that says, in words, that it must not.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';
//  What `resolveBigQueryAvailability` reads. Nothing here ever reaches BigQuery — the barrel is
// stubbed — but the real config is loaded on import and these keep it from complaining.
process.env.GCP_PROJECT_ID = 'test-project';
process.env.BQ_DATASET = 'test_dataset';
process.env.GCP_SERVICE_ACCOUNT_JSON = '{}';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mongoose = require('mongoose');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(BACKEND_ROOT, 'src');
const MODULE_ROOT = path.join(SRC, 'modules', 'conversion');

/** Never reached — every repository call is stubbed — but a short buffer keeps a mistake from hanging. */
mongoose.set('bufferTimeoutMS', 400);

const funnelRepository = require(path.join(MODULE_ROOT, 'repositories', 'customFunnel.repository.ts'));
const cohortRepository = require(path.join(MODULE_ROOT, 'repositories', 'installCohort.repository.ts'));
const bigQueryModule = require(path.join(SRC, 'modules', 'bigquery', 'index.ts'));
const partnerVocab = require(path.join(SRC, 'constants', 'partnerVocab.constants.ts'));

const { PARTNER_EVENT_TYPES } = partnerVocab;
const ACCEPTED = PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACCEPTED;
const ACTIVATED = PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_ACTIVATED;
const CANCELLED = PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_CANCELLED;
const INSTALL = PARTNER_EVENT_TYPES.INSTALL;

const _at = (iso) => new Date(iso);
const _DAY_MS = 86400000;

const APP = {
    _id: 'app-1',
    display_name: 'Demo App',
    last_synced_at: _at('2026-09-01T00:00:00.000Z'),
    last_bq_synced_at: null,
    last_install_attrib_synced_at: null,
    earliest_event_at: _at('2024-01-01T00:00:00.000Z'),
    earliest_transaction_at: _at('2024-01-01T00:00:00.000Z'),
    lifetime_sync_completed_at: _at('2026-09-01T00:00:00.000Z'),
    event_history_gap_days: 0
};

/**
 * ONE merchant, ONE mid-trial upgrade — the canonical trap.
 *
 * `100` is accepted on 1 August with billing due on the 8th. On the 4th, inside that trial, Shopify
 * cancels `100` and accepts `200` in the SAME SECOND. `300` is an unrelated store whose ACTIVATED
 * announces a billing date 200 days out, which no trial explains.
 */
const _charge = (id, plan, billingOn) => ({
    id: `gid://shopify/AppSubscription/${id}`,
    name: plan,
    test: false,
    billingOn: billingOn ? billingOn.toISOString().slice(0, 10) : null,
    amount: { amount: '29.00', currencyCode: 'USD' }
});

const COHORT_EVENTS = [
    {
        event_type: ACCEPTED,
        shop_domain: 'up.myshopify.com',
        charge_id: '100',
        occurred_at: _at('2026-08-01T09:00:00.000Z'),
        raw_event: { charge: _charge('100', 'Starter', _at('2026-08-08T00:00:00.000Z')) }
    },
    {
        event_type: CANCELLED,
        shop_domain: 'up.myshopify.com',
        charge_id: '100',
        occurred_at: _at('2026-08-04T12:00:00.000Z'),
        raw_event: { charge: _charge('100', 'Starter', null) }
    },
    {
        event_type: ACCEPTED,
        shop_domain: 'up.myshopify.com',
        charge_id: '200',
        occurred_at: _at('2026-08-04T12:00:00.000Z'),
        raw_event: { charge: _charge('200', 'Pro', _at('2026-08-11T00:00:00.000Z')) }
    },
    {
        event_type: ACTIVATED,
        shop_domain: 'anchor.myshopify.com',
        charge_id: '300',
        occurred_at: _at('2026-08-02T00:00:00.000Z'),
        raw_event: { charge: _charge('300', 'Pro', new Date(_at('2026-08-02T00:00:00.000Z').getTime() + 200 * _DAY_MS)) }
    }
];

const AVAILABLE = Object.freeze({ enabled: true, missing_env: [], message: 'BigQuery is configured.' });

const STATE = { cohortEvents: COHORT_EVENTS };

// ⚠️ Installed BEFORE either service is required: both destructure their repository functions at
// module load, so a stub applied afterwards would be ignored and the real one would query a database
// that is not there.
cohortRepository.findPartnerAppById = async () => APP;
cohortRepository.aggregateInstallSpine = async () => ({
    rows: [
        { shop_domain: 'up.myshopify.com', shop_name: 'Upgrader', installed_at: _at('2026-08-01T00:00:00.000Z'), event_type: INSTALL, install_events: 1 },
        { shop_domain: 'anchor.myshopify.com', shop_name: 'Anchor', installed_at: _at('2026-08-02T00:00:00.000Z'), event_type: INSTALL, install_events: 1 }
    ],
    shopless_install_events: 0
});
cohortRepository.findChargeCohortEvents = async () => STATE.cohortEvents;
cohortRepository.aggregateSettledSubscriptionCharges = async () => [];
cohortRepository.findInstallAttributionRows = async () => [];

bigQueryModule.resolveBigQueryAvailability = () => AVAILABLE;
bigQueryModule.aggregateListingFunnelTotals = async () => null;

funnelRepository.aggregatePartnerShopSets = async () => ({
    rows: [{ event_type: INSTALL, shops: ['up.myshopify.com', 'anchor.myshopify.com'] }],
    shopless_events: 0
});
funnelRepository.aggregateTransactionShopSets = async () => [];
funnelRepository.countFirstTransactionShops = async () => 0;
funnelRepository.findChargeCohortEvents = async () => STATE.cohortEvents;
funnelRepository.aggregateSettledSubscriptionEvidence = async () => ({ charge_ids: [], shop_domains: [] });

const { getCustomFunnel } = require(path.join(MODULE_ROOT, 'services', 'customFunnel.service.ts'));
const { getInstallCohort } = require(path.join(MODULE_ROOT, 'services', 'installCohort.service.ts'));

const WINDOW = { partner_app_id: 'app-1', since: '2026-08-01', until: '2026-08-31' };

const _funnel = async (params = {}) => {
    const result = await getCustomFunnel({ user_id: 'operator-1' }, { ...WINDOW, ...params });
    assert.equal(result.status, true, `the service refused: ${result.msg}`);
    return result.data;
};

const _cohort = async (params = {}) => {
    const result = await getInstallCohort({ user_id: 'operator-1' }, { ...WINDOW, ...params });
    assert.equal(result.status, true, `the service refused: ${result.msg}`);
    return result.data;
};

/** The keys every `supersession` block must carry, wherever it is published. */
const SUPERSESSION_KEYS = [
    'churned_after_trial',
    'churned_during_trial',
    'detected',
    'distinct_successors',
    'same_second',
    'shops',
    'window_ms'
];

/** And the gap block's. `band_max_days` travels with the counts so a warning cannot quote a stale bound. */
const GAP_KEYS = ['above_band', 'band_max_days', 'measured', 'negative'];

// ═══════════════════════════════════════════════════════════════════════════

test('the custom funnel publishes the supersession counters, with their exact key sets', async () => {
    const data = await _funnel({ events: 'installed,trial_started,trial_converted' });
    const d = data.diagnostics;

    // Pinned the way `charge_link` is pinned: a nested counter block loses a key to a refactor with
    // nothing else failing, and these counters are precisely what a refactor would drop.
    assert.deepEqual(Object.keys(d.supersession).sort(), SUPERSESSION_KEYS);
    assert.deepEqual(Object.keys(d.billing_on_gap).sort(), GAP_KEYS);

    assert.equal(d.supersession.detected, 1, 'the mid-trial upgrade is on the wire');
    assert.equal(d.supersession.same_second, 1);
    assert.equal(d.supersession.distinct_successors, 1);
    assert.equal(d.supersession.churned_during_trial, 1);
    assert.equal(d.billing_on_gap.above_band, 1, 'and so is the 200-day billing anchor');
});

test('and NOT ONE published figure has been adjusted for it', async () => {
    const data = await _funnel({ events: 'installed,trial_started,trial_converted' });
    const steps = Object.fromEntries(data.steps.map((step) => [step.key, step]));

    // One merchant upgrading once is still two trial starts, and the store that never upgraded is
    // still one — three subscriptions from two merchants. Tier 1 measures; it does not compensate.
    assert.equal(data.trial_cohort.counts.trial_started, 3);
    assert.equal(data.trial_cohort.counts.churned_during_trial, 1, 'the phantom churn is still counted');
    assert.equal(steps.trial_started.count, 3, 'and the step reads the same number as the block');
    assert.equal(steps.installed.count, 2, 'over two actual stores');
});

test('the exposure reaches `warnings[]` in the resolver’s own words, once', async () => {
    const data = await _funnel({ events: 'installed,trial_started,trial_converted' });
    const hits = data.warnings.filter((line) => /same second/i.test(line));

    assert.equal(hits.length, 1, 'exactly one supersession line');
    assert.match(hits[0], /has been adjusted/i, 'and it says no figure was corrected');
    assert.equal(new Set(data.warnings).size, data.warnings.length, 'warnings are keyed by content — all unique');
});

test('with NO subscription step the counters are `null`, never a zeroed object', async () => {
    const data = await _funnel({ events: 'installed,uninstalled' });

    // The cohort was never folded. `{detected: 0, …}` would claim we looked and found nothing, on a
    // request that did not look — the same error `charge_link: null` beside it exists to avoid.
    assert.equal(data.diagnostics.supersession, null);
    assert.equal(data.diagnostics.billing_on_gap, null);
    assert.equal(data.diagnostics.charge_link, null, 'and it matches the sibling that already did this');
    assert.equal(data.warnings.filter((line) => /same second/i.test(line)).length, 0, 'and nothing is warned about');
});

test('the install cohort publishes the same counters, and they are never null there', async () => {
    const data = await _cohort();
    const d = data.diagnostics;

    // ⚠️ NOT nullable on this endpoint: it always folds the charge cohort, so there is no
    // "was not looked for" state to distinguish and a `0` here is a genuine measurement.
    assert.deepEqual(Object.keys(d.supersession).sort(), SUPERSESSION_KEYS);
    assert.deepEqual(Object.keys(d.billing_on_gap).sort(), GAP_KEYS);
    assert.equal(d.supersession.detected, 1);
    assert.equal(d.supersession.churned_during_trial, 1);

    const hits = data.warnings.filter((line) => /same second/i.test(line));
    assert.equal(hits.length, 1, 'and this payload does not de-duplicate, so it must be pushed once');
});

test('the install cohort’s own figures are unmoved — the upgrader still reads CHURNED', async () => {
    const data = await _cohort();
    const rows = Object.fromEntries(data.items.map((row) => [row.shop_domain, row]));

    // The store's winning subscription is the REPLACEMENT charge (latest `trial_start` wins), so the
    // row itself is not the phantom churn — but the exposure is real one level down and is what
    // `diagnostics.supersession` publishes. Pinned so a compensating change has to touch it.
    assert.equal(rows['up.myshopify.com'].state, 'CONVERTED');
    assert.equal(data.summary.installs, 2, 'two stores, unadjusted');
});
