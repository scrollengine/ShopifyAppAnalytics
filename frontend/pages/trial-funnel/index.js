import { Page, Card, BlockStack, InlineStack, Text, Banner, IndexTable, Badge, Tabs, Tooltip as PolarisTooltip } from '@shopify/polaris';
import { useCallback, useContext, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import SideNavBar from '../../components/sideNavBar';
import LoaderContext from '../../contexts/loaderContext';
import { APPS_STATE, useGrowthIntel } from '../../contexts/growthIntelContext';
import GrowthIntelConversionApiService from '../../API_Services/growth-intel/conversionService';
import DateRangeFilter, { useDateRangeState, dateRangeToMonths } from '../../components/growth-intel/DateRangeFilter';
import useStoreDetailDrawer from '../../components/growth-intel/store/useStoreDetailDrawer';
import DataStateSection from '../../components/growth-intel/DataStateSection';
import { DATA_STATE, pendingDataState, readDataState } from '../../components/growth-intel/dataState';
import { DASHBOARD_ROUTES } from '../../utils/dashboardRoutes';

const ResponsiveContainer = dynamic(() => import('recharts').then((m) => m.ResponsiveContainer), { ssr: false });
const ComposedChart = dynamic(() => import('recharts').then((m) => m.ComposedChart), { ssr: false });
const Bar = dynamic(() => import('recharts').then((m) => m.Bar), { ssr: false });
const Line = dynamic(() => import('recharts').then((m) => m.Line), { ssr: false });
const XAxis = dynamic(() => import('recharts').then((m) => m.XAxis), { ssr: false });
const YAxis = dynamic(() => import('recharts').then((m) => m.YAxis), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then((m) => m.Tooltip), { ssr: false });
const Legend = dynamic(() => import('recharts').then((m) => m.Legend), { ssr: false });
const CartesianGrid = dynamic(() => import('recharts').then((m) => m.CartesianGrid), { ssr: false });

const CONV_API = new GrowthIntelConversionApiService();

const _fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');
const _fmtPct = (n) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return `${(Number(n) * 100).toFixed(1)}%`;
};
const _fmtDate = (d) => { if (!d) return '—'; try { return new Date(d).toLocaleDateString(); } catch (e) { return String(d); } };
const _fmtMoney = (n) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/**
 * The value when the backend actually published a number, and `null` — never `0` — when it did not.
 *
 * Every figure below used to be read as
 * `row.count || 0`, which hands the honest formatters above a number they can no longer question:
 * `_fmtNum`/`_fmtPct` return an em dash for a non-number, but they never saw one, because the
 * mappers had already turned every absence into a hard zero. The chart was worse than the tiles —
 * a missing `trial_to_paid_rate` plotted as a 0% conversion line, which is a strong claim about the
 * operator's trial funnel rather than the absence of one.
 *
 * The test mirrors the backend's own missing-value test (IMPLEMENTATION.md §3.11): null/undefined or
 * non-finite. Deliberately NOT `!value`, which would erase the measured zero this exists to protect —
 * a real "0 shops converted" is a finding and must still print as 0.
 *
 * @param {*} v - A value straight off a response payload.
 * @returns {Number|null} The number, or null when there is no answer.
 */
const _numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Adds, but only when every addend was actually measured.
 *
 * NULL DOES NOT PROPAGATE THROUGH `+` IN JAVASCRIPT — `null + 5` is `5`, so a plain sum silently
 * restores the zero-defaulting this file just removed, and does it inside a total the reader trusts
 * more than the parts. One unmeasured addend makes the whole total unmeasured.
 *
 * @param {...(Number|null|undefined)} vals - The addends.
 * @returns {Number|null} The sum, or null when any addend is missing.
 */
const _sumOrNull = (...vals) => {
    if (vals.some((v) => _numOrNull(v) === null)) {
        return null;
    }
    return vals.reduce((a, b) => a + b, 0);
};

/**
 * A rate that has ALREADY been multiplied to a percentage — the trend mapper's `conversion_rate_pct`,
 * which shares an axis with the chart line and so cannot be stored as a fraction.
 *
 * Kept separate from `_fmtPct`, which takes a fraction and would multiply a second time. Both return
 * an em dash for a non-number; this one exists so the month table can print the null the chart skips
 * rather than calling `.toFixed()` on it.
 *
 * @param {Number|null} n - A percentage, 0–100.
 * @returns {String} "12.3%", or an em dash when the month was never rated.
 */
const _fmtRatePct = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${n.toFixed(1)}%` : '—');

/**
 * A trial-outcomes success carrying no `breakdown` array has measured nothing.
 *
 * NAMING THE REGRESSION: `find()` below answers `{ count: 0 }` for any state it cannot see —
 * correct for a state missing from an enumeration, and a lie about a `breakdown` that is missing
 * altogether, which would render as four hard zeros beside a live conversion rate. That is the
 * manufactured-zero bug IMPLEMENTATION.md §4.5 asks reviewers to look for, and this test is what
 * keeps the two apart. A `breakdown: []` is left alone: an array IS an answer, and a cohort really
 * can be empty.
 *
 * @param {Object} d - The response's `data` object, already known to be a success.
 * @returns {Boolean} True when the response carries no measurement at all.
 */
const _outcomesNeverSynced = (d) => !Array.isArray(d.breakdown);

/**
 * A trial-trend success carrying no `monthly_trend` array has measured nothing.
 *
 * Same reasoning: the chart and the month table below map over that array, and an absent one draws
 * an empty chart — a flat line reads as "no trials happened", which nobody said.
 *
 * @param {Object} d - The response's `data` object, already known to be a success.
 * @returns {Boolean} True when the response carries no measurement at all.
 */
const _trendNeverSynced = (d) => !Array.isArray(d.monthly_trend);

/**
 * The four states the API actually emits, in the lifecycle order the trial-outcomes
 * endpoint returns them: a subscription is on trial, then paying, and leaves from
 * one side or the other.
 *
 * This page used to look up CONVERTED_TO_PAID / CHURNED / IN_TRIAL /
 * TRIAL_CANCELLED / TRIAL_ABANDONED / TRIAL_PAYMENT_FAILED — none of which the
 * service has emitted since trial outcomes were rebuilt on subscription state,
 * so every one of those cards fell through to a `{ count: 0 }` fallback and
 * rendered a hard zero beside a live conversion rate.
 */
const TRIAL_STATES = {
    PAYING: 'PAYING',
    ON_TRIAL: 'ON_TRIAL',
    CHURNED_DURING_TRIAL: 'CHURNED_DURING_TRIAL',
    CHURNED_AFTER_TRIAL: 'CHURNED_AFTER_TRIAL'
};

// Mirrors components/growth-intel/conversion/TrialOutcomeBar.js so one state is
// one colour wherever it is drawn.
const STATE_COLOR = {
    PAYING: '#50B83C',
    ON_TRIAL: '#FAD157',
    CHURNED_DURING_TRIAL: '#E3A008',
    CHURNED_AFTER_TRIAL: '#BF0711'
};

// Fallback only. Every breakdown row carries its own `label` (from
// SUBSCRIPTION_STATE_LABELS) and that is preferred, so a rename in the service
// reaches this page without a second edit.
// Polaris tones for the state column. Mirrors STATE_COLOR's meaning: paying is good, a mid-trial
// exit is a caution (nothing was lost), a post-trial exit is critical (revenue was).
const STATE_BADGE_TONE = {
    PAYING: 'success',
    ON_TRIAL: 'attention',
    CHURNED_DURING_TRIAL: 'warning',
    CHURNED_AFTER_TRIAL: 'critical'
};

const STATE_LABEL_FALLBACK = {
    PAYING: 'Paying',
    ON_TRIAL: 'On trial',
    CHURNED_DURING_TRIAL: 'Churned during trial',
    CHURNED_AFTER_TRIAL: 'Churned after trial'
};

const StatCard = ({ label, value, tone, hint }) => (
    <Card>
        <BlockStack gap="100">
            <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
            <Text as="span" variant="heading2xl" tone={tone}>{value}</Text>
            {hint ? <Text as="span" variant="bodySm" tone="subdued">{hint}</Text> : null}
        </BlockStack>
    </Card>
);

/**
 * One of the two ways a shop is lost, stated so it cannot be mistaken for the
 * other. Churning DURING a trial is not lost revenue — the shop never paid.
 * Churning AFTER converting is. They are never added together.
 */
const LossRow = ({ color, label, count, meaning }) => (
    <InlineStack gap="200" blockAlign="start" wrap={false}>
        <div style={{ width: 10, height: 10, borderRadius: 2, background: color, marginTop: 7, flex: '0 0 auto' }} />
        <BlockStack gap="050">
            {/* Spelled out rather than run through `_fmtNum`: a missing count in this sentence would
                read "Churned during trial — — shops", which looks like a rendering fault and invites
                the reader to assume it means zero. It does not. */}
            <Text as="span" fontWeight="semibold">
                {typeof count === 'number' ? `${label} — ${_fmtNum(count)} shops` : `${label} — count not reported`}
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">{meaning}</Text>
        </BlockStack>
    </InlineStack>
);

const TrialFunnelPage = () => {
    const { toastMarkup } = useContext(LoaderContext) || {};
    // The app selection lives in the side nav now — one picker for the whole section.
    const { apps, appId, appsState, appsError, refreshApps, hydrated: appHydrated } = useGrowthIntel();
    const dateRange = useDateRangeState({ storageKey: 'gi.trialFunnel.dateRange', defaultValue: { kind: 'preset', preset: 365 } });
    const months = dateRangeToMonths(dateRange.value);
    const [outcomesState, setOutcomesState] = useState(pendingDataState());
    const [windowOutcomesState, setWindowOutcomesState] = useState(pendingDataState());
    const [trendState, setTrendState] = useState(pendingDataState());
    const [loading, setLoading] = useState(false);
    const [cohortTab, setCohortTab] = useState('ALL');

    const fetchData = useCallback(() => {
        if (!appId || !appHydrated) return;
        if (!dateRange.hydrated) return;
        setLoading(true);
        let inflight = 3;
        const done = () => { inflight -= 1; if (inflight === 0) setLoading(false); };
        // The headline cards stay LIFETIME — they are labelled as such, and a "total trial starts"
        // that moves with the range is not a total. The date range scopes the trend chart and the
        // cohort list below it.
        CONV_API.getTrialOutcomes({ partner_app_id: appId, period_days: 'all' }, (resp) => {
            // `if (resp.status && resp.data)` filed the not-implemented envelope, an expired session
            // and a genuinely empty cohort under one `null`, and the page then rendered nothing at
            // all beneath its title. Each call keeps its own state because each is a separate
            // endpoint that will be built on its own day.
            setOutcomesState(readDataState(resp, { isNeverSynced: _outcomesNeverSynced }));
            done();
        });
        // An all-time range asks for the identical cohort the call above already fetched, and that
        // call is a full subscription-state rebuild — so it is reused rather than issued twice.
        if (dateRange.params.period_days === 'all') {
            // Back to PENDING, not to a decoded state: nothing was asked, so nothing is known, and
            // `cohortState` below reads that as "the lifetime call is the one describing these rows".
            setWindowOutcomesState(pendingDataState());
            done();
        } else {
            CONV_API.getTrialOutcomes({ partner_app_id: appId, ...dateRange.params }, (resp) => {
                setWindowOutcomesState(readDataState(resp, { isNeverSynced: _outcomesNeverSynced }));
                done();
            });
        }
        CONV_API.getTrialTrend({ partner_app_id: appId, months }, (resp) => {
            setTrendState(readDataState(resp, { isNeverSynced: _trendNeverSynced }));
            done();
        });
    }, [appId, appHydrated, months, dateRange.params, dateRange.hydrated]);

    useEffect(() => { fetchData(); }, [fetchData]);

    // The three payloads, or null. `readDataState` nulls `data` in every state except READY, so
    // these are never stand-in `{}`s: each section is gated on its own state object, and no tile,
    // chart or table is drawn over a figure the backend declined to publish.
    const outcomes = outcomesState.data;
    const windowOutcomes = windowOutcomesState.data;
    const trend = trendState.data;

    // Summary numbers from outcomes (lifetime by default).
    const summary = outcomes ? (() => {
        const rows = Array.isArray(outcomes.breakdown) ? outcomes.breakdown : [];
        /**
         * One lifecycle state's row, with the two possible kinds of nothing kept apart.
         *
         * ROW PRESENT, FIGURE ABSENT → null. The service sent this state and declined to put a
         * number on it; `_fmtNum`/`_fmtPct` print an em dash and the reader is told nothing.
         *
         * ROW ABSENT → `count: 0`, and that IS a real zero, not a manufactured one: `breakdown` is an
         * enumeration over the whole cohort, one row per state that has shops in it, so a state
         * missing from it has no shops. `pct`, though, stays null — the service computes it against
         * a denominator this page never sees, and 0/0 for an empty cohort is a rate nobody measured.
         * (`_outcomesNeverSynced` has already sent an ABSENT `breakdown` to NEVER_SYNCED, so an array
         * reaching here is genuinely an enumeration and this reasoning holds.)
         */
        const find = (state) => {
            const row = rows.find((b) => b.state === state);
            if (row) {
                return {
                    state,
                    label: row.label || STATE_LABEL_FALLBACK[state],
                    count: _numOrNull(row.count),
                    pct: _numOrNull(row.pct)
                };
            }
            return { state, label: STATE_LABEL_FALLBACK[state], count: 0, pct: null };
        };

        const paying = find(TRIAL_STATES.PAYING);
        const on_trial = find(TRIAL_STATES.ON_TRIAL);
        const churned_during_trial = find(TRIAL_STATES.CHURNED_DURING_TRIAL);
        const churned_after_trial = find(TRIAL_STATES.CHURNED_AFTER_TRIAL);

        // The service's own conversion definition: a shop converted iff it was
        // still alive when its trial ran out — so a shop that paid and later left
        // still converted. This is why CHURNED_AFTER_TRIAL belongs in this total
        // and CHURNED_DURING_TRIAL never can.
        const converted = _sumOrNull(paying.count, churned_after_trial.count);

        // Prefer the emitted denominator; the derived sum is only a fallback for a
        // response cached before those fields existed — and a fallback built out of
        // an unmeasured part is itself unmeasured, so it stays null rather than
        // reporting the measured half as if it were the whole.
        let decided_count = _sumOrNull(converted, churned_during_trial.count);
        if (typeof outcomes.decided_count === 'number') {
            decided_count = outcomes.decided_count;
        }
        let still_on_trial = on_trial.count;
        if (typeof outcomes.still_on_trial === 'number') {
            still_on_trial = outcomes.still_on_trial;
        }
        // The service rolls trial-side losses up on its own. Read its rollup rather
        // than re-deriving one here, so a future addition to it lands automatically.
        let trial_side_losses = churned_during_trial.count;
        if (outcomes.cancellation_rollup && typeof outcomes.cancellation_rollup.count === 'number') {
            trial_side_losses = outcomes.cancellation_rollup.count;
        }

        return {
            paying,
            on_trial,
            churned_during_trial,
            churned_after_trial,
            converted,
            decided_count,
            still_on_trial,
            trial_side_losses,
            trial_to_paid_rate: outcomes.trial_to_paid_rate
        };
    })() : null;

    // null, not 0, until something measured says otherwise: this is the page's headline figure, and
    // "Total trial starts 0" is the single most quotable manufactured number on the screen.
    let totalTrialStarts = null;
    if (summary) {
        totalTrialStarts = _sumOrNull(
            summary.paying.count,
            summary.on_trial.count,
            summary.churned_during_trial.count,
            summary.churned_after_trial.count
        );
        if (outcomes && typeof outcomes.total_shops_in_cohort === 'number') {
            totalTrialStarts = outcomes.total_shops_in_cohort;
        }
    }

    let periodLabel = 'all time';
    if (outcomes && outcomes.period_label) {
        periodLabel = outcomes.period_label.toLowerCase();
    }

    // Read straight off the payload's own scope/staleness discriminators rather
    // than asserting a methodology the response may contradict: each of these
    // silently REMOVES shops from the counts above, and without them the page
    // looks like the business has no customers instead of saying why.
    //
    // ⚠️ THIS BACKEND EMITS NEITHER `stale` NOR `scope`, so the banner below never appears on this
    // deployment. Every read is guarded, so nothing renders wrong — and the blocks are deliberately
    // NOT back-filled from the fields that do exist. `diagnostics.shopless_subscriptions` is the
    // nearest thing to `scope.unmatched_domain_count`, and it is a DIFFERENT population: "the
    // subscription carried no domain" is not "the domain matched no store record", and this copy
    // states the second. The equivalent facts arrive instead through `warnings[]`, rendered below,
    // each already written as a sentence about what it excluded.
    const dataCaveats = [];
    if (outcomes && outcomes.stale && outcomes.stale.demoted_count > 0) {
        let window_txt = 'the ledger window';
        if (outcomes.stale.billing_window_days) {
            window_txt = `the last ${outcomes.stale.billing_window_days} days`;
        }
        dataCaveats.push(`${_fmtNum(outcomes.stale.demoted_count)} subscription(s) still marked paying on the charge record had no settled charge in ${window_txt}, so they are excluded from these counts.`);
    }
    if (outcomes && outcomes.stale && outcomes.stale.unresolved_domain_count > 0) {
        dataCaveats.push(`${_fmtNum(outcomes.stale.unresolved_domain_count)} paying subscription(s) could not be matched to a store domain, so the ledger cross-check was not applied to them.`);
    }
    if (outcomes && outcomes.scope && outcomes.scope.unmatched_domain_count > 0) {
        dataCaveats.push(`${_fmtNum(outcomes.scope.unmatched_domain_count)} shop domain(s) seen for this app did not match a store record, so their subscriptions are outside this cohort.`);
    }

    // The cohort behind the counts, scoped to the selected range. An all-time range reuses the
    // lifetime response rather than re-fetching an identical one.
    const cohort = windowOutcomes || outcomes;
    // ...so the section reports the LIFETIME call's state whenever the windowed call was never
    // issued: its own state is held at PENDING on purpose. Reading that untouched state instead
    // would leave the cohort blank forever on every all-time range, now that PENDING draws nothing
    // once `loading` has gone false.
    const cohortState = windowOutcomesState.state === DATA_STATE.PENDING ? outcomesState : windowOutcomesState;

    /**
     * True when the cohort section would print, word for word, the banner "Trial outcomes" has
     * already printed further up the page.
     *
     * ONE REFUSAL, ONE SENTENCE. On the default all-time range the windowed call is deliberately
     * never issued and the cohort borrows the lifetime state — so a NOT_CONNECTED or NOT_IMPLEMENTED
     * answer produced two banners with the same heading and the same server sentence on one screen.
     * A reader shown the same warning twice stops reading warnings, and then misses the one on the
     * day it is different. The first banner is the whole explanation; this section draws nothing,
     * which is what it draws for every other kind of nothing.
     *
     * Matched on state AND reason rather than on "did we reuse the object", so two separate calls
     * that happen to fail for the identical reason collapse too — the reader cannot tell those
     * apart either.
     */
    const cohortBannerRepeatsOutcomes = cohortState.state !== DATA_STATE.READY
        && cohortState.state !== DATA_STATE.PENDING
        && cohortState.state === outcomesState.state
        && cohortState.reason === outcomesState.reason;
    const cohortShops = (cohort && Array.isArray(cohort.shops)) ? cohort.shops : [];

    /**
     * Everything the two responses approximated, excluded or truncated, in their own words.
     *
     * ONE LIST, DEDUPED, BECAUSE REACT KEYS THESE BY CONTENT. Each service guarantees ITS OWN
     * catalogue is unique, but the outcomes call and the trend call describe the same app from the
     * same cohort and legitimately raise the same sentence — the coverage floor, the excluded test
     * subscriptions, the inferred-state count. Rendered as two lists a reader sees the warning twice
     * and starts skipping them; merged without the Set, two identical keys collide in one list.
     *
     * The windowed cohort call is folded in too when it was actually issued: on an all-time range it
     * is never made and `windowOutcomes` IS `outcomes`, so the Set collapses it to nothing.
     */
    const allWarnings = [...new Set([
        ...((outcomes && Array.isArray(outcomes.warnings)) ? outcomes.warnings : []),
        ...((windowOutcomes && Array.isArray(windowOutcomes.warnings)) ? windowOutcomes.warnings : []),
        ...((trend && Array.isArray(trend.warnings)) ? trend.warnings : [])
    ])];

    let cohortPeriodLabel = 'all time';
    if (cohort && cohort.period_label) {
        cohortPeriodLabel = cohort.period_label.toLowerCase();
    }

    // Counts come from the ROWS, not from `cohort.breakdown` — the tab label has to describe the
    // list the tab actually opens. If the two ever disagree, the list is the honest one, and a tab
    // reading "(3)" over two rows is the kind of mismatch nobody can explain later.
    const cohortCounts = { ALL: cohortShops.length };
    Object.values(TRIAL_STATES).forEach((state) => {
        cohortCounts[state] = cohortShops.filter((r) => r.state === state).length;
    });

    // Every state gets a tab even at zero: "0 churned after trial" is a finding, and hiding the tab
    // turns it into a question about whether the page is broken.
    const cohortTabs = [
        { id: 'ALL', content: `All (${_fmtNum(cohortCounts.ALL)})` },
        { id: TRIAL_STATES.PAYING, content: `${STATE_LABEL_FALLBACK.PAYING} (${_fmtNum(cohortCounts.PAYING)})` },
        { id: TRIAL_STATES.ON_TRIAL, content: `${STATE_LABEL_FALLBACK.ON_TRIAL} (${_fmtNum(cohortCounts.ON_TRIAL)})` },
        { id: TRIAL_STATES.CHURNED_DURING_TRIAL, content: `${STATE_LABEL_FALLBACK.CHURNED_DURING_TRIAL} (${_fmtNum(cohortCounts.CHURNED_DURING_TRIAL)})` },
        { id: TRIAL_STATES.CHURNED_AFTER_TRIAL, content: `${STATE_LABEL_FALLBACK.CHURNED_AFTER_TRIAL} (${_fmtNum(cohortCounts.CHURNED_AFTER_TRIAL)})` }
    ];
    let cohortIndex = cohortTabs.findIndex((t) => t.id === cohortTab);
    if (cohortIndex < 0) {
        cohortIndex = 0;
    }
    let cohortRows = cohortShops;
    if (cohortTabs[cohortIndex].id !== 'ALL') {
        cohortRows = cohortShops.filter((r) => r.state === cohortTabs[cohortIndex].id);
    }

    /**
     * Clicking a shop opens the shared store detail panel.
     *
     *  THE DOMAIN, AND ONLY THE DOMAIN. This mapped `tenant_id: r.shop_id`, carried across from the
     * system this page was extracted from, where `trialOutcomeService` really did write
     * `String(sub.tenant_id)` into that field. THIS build has no tenant, user_tenant or users graph
     * at all, so no row anywhere carries a tenant id and `shop_id` on a Partner-API row is a
     * `gid://partners/Shop/…`. Mapped, that gid won `storeRowKey`'s `||`, failed the 24-hex test in
     * `storeDetailRequestParams`, and went through `normaliseShopDomain` — which truncates at the
     * first `/` and yields the literal string `gid:` (verified). `GET /api/stores/detail` then
     * refuses it, so every drawer on this page would have opened onto a critical banner.
     *
     * Dormant until `GET /api/conversion/trial-funnel` lands, which is exactly why it is fixed now:
     * the day it lands, nothing about this page will look like the cause.
     *
     * `rows` is the FILTERED cohort, not the whole set, so the stepper walks exactly what the reader
     * is looking at and "3 of 40" matches the tab they are on.
     */
    const shopDrawer = useStoreDetailDrawer({
        rows: cohortRows,
        appId,
        rowKey: (r, i) => `${r.shop_id || r.shop_domain}-${i}`,
        toStoreRow: (r) => ({ shop_domain: r.shop_domain })
    });

    /**
     * The trend response, month by month, with every absence carried through as `null`.
     *
     * A MONTH IS NOT A ZERO. This mapper is where `|| 0` did the most damage on this page: it fed
     * a CHART, and a chart states its zeros far more forcefully than a tile does. A month the service
     * could not measure came out of here as four zero-height bars under a conversion line pinned to
     * the floor — a picture of a month in which trials started and none of them converted, which is
     * a very specific and very wrong story about the operator's funnel.
     *
     * `null` instead, so recharts OMITS the point (see `connectNulls={false}` on the line below) and
     * the series breaks over the gap rather than diving through it — the rendering IMPLEMENTATION.md
     * §3.11 asks for: "a `null` renders as `—` with its reason, and a chart breaks the line rather
     * than drawing a point at the floor". A measured zero still arrives as `0` and still draws.
     */
    const trendChartData = trend && Array.isArray(trend.monthly_trend) ? trend.monthly_trend.map((r) => {
        // `trial_starts` is emitted — deriving it by summing buckets used to be
        // necessary and is now actively wrong, because `churned_after_paid` is a
        // SUBSET of `converted` rather than a sibling of it. Summing them would
        // double-count every shop that paid and then left.
        //
        // The fallback sum is null-propagating: a total derived from three buckets of which one was
        // never measured is not a total, and printing the other two as if they were the whole month
        // understates trial starts in exactly the direction that flatters the funnel.
        let trial_starts = _sumOrNull(r.converted, r.in_trial, r.cancelled);
        if (typeof r.trial_starts === 'number') {
            trial_starts = r.trial_starts;
        }
        return {
            month: r.month,
            trial_starts,
            converted: _numOrNull(r.converted),
            // `cancelled` is the trend's name for a cancellation BEFORE the trial
            // ended — i.e. CHURNED_DURING_TRIAL. Renamed here so the legend, the
            // tooltip and the table all speak the same vocabulary as the cards.
            churned_during_trial: _numOrNull(r.cancelled),
            churned_after_paid: _numOrNull(r.churned_after_paid),
            in_trial: _numOrNull(r.in_trial),
            // THE WORST OF THE SEVEN. `Number(r.trial_to_paid_rate || 0) * 100` turned a month the
            // service declined to rate into a plotted 0% — the one figure on this page an operator
            // would act on, manufactured out of `undefined`. Unmeasured months now break the line.
            conversion_rate_pct: _numOrNull(r.trial_to_paid_rate) === null ? null : r.trial_to_paid_rate * 100,
            is_aging: r.cohort_aged_days < 90
        };
    }) : [];

    return (
        <SideNavBar>
            <Page
                title="Trial Funnel"
                subtitle="Trial starts → what became of them. The cohort is every subscription activated in the window, each classified as of today."
                fullWidth
                backAction={{ content: 'Growth Intelligence', url: DASHBOARD_ROUTES.OVERVIEW }}
                primaryAction={appId ? <DateRangeFilter value={dateRange.value} onChange={dateRange.set} /> : null}
            >
                <BlockStack gap="400">
                    {/* `appsState === READY`, NOT `apps.length === 0`. An empty roster is a
                        fact about the account in READY and in NO OTHER STATE: after a 500 or a
                        dropped connection `apps` is still `[]` and `appsLoading` is already false,
                        so the old gate published "No partner apps yet" — a measured claim about the
                        operator's business — out of a transport failure. PENDING is the first tick
                        of every page load and UNAUTHENTICATED is a redirect already under way; both
                        draw nothing. */}
                    {appsState === APPS_STATE.READY && apps.length === 0 ? (
                        <Banner tone="info" title="No partner apps yet"><p>Add a partner app first.</p></Banner>
                    ) : null}

                    {/* THE OTHER HALF OF THE SAME FIX. `apps` is `[]` on a first-load failure —
                        it is the initial state — so the provider's "keep the last measured roster"
                        rule cannot save this path, and without this banner the page is simply blank
                        with no statement of why. Nothing retries on a timer (the provider says why),
                        so the way out is offered here. */}
                    {appsState === APPS_STATE.ERROR ? (
                        <Banner
                            tone="critical"
                            title="The partner app list could not be loaded"
                            action={{ content: 'Try again', onAction: refreshApps }}
                        >
                            <p>{appsError}</p>
                        </Banner>
                    ) : null}

                    {appId && loading ? (
                        <Card><Text as="p">Loading trial funnel data…</Text></Card>
                    ) : appId ? (
                        <BlockStack gap="400">
                            {/* One section per call. Trial outcomes, the windowed cohort and the
                                monthly trend are three separate endpoints that will be built on
                                three separate days, so each is gated on its own state and a refusal
                                of one leaves the other two on screen. */}
                            <DataStateSection state={outcomesState} title="Trial outcomes" loading={loading}>
                                {/* PENDING renders children, so the payload is checked once more:
                                    the first paint happens before the request has answered. */}
                                {summary ? (
                                    <BlockStack gap="400">
                                        <InlineStack gap="400" wrap>
                                            <div style={{ flex: '1 1 220px' }}>
                                                <StatCard
                                                    label="Total trial starts (lifetime)"
                                                    value={_fmtNum(totalTrialStarts)}
                                                    hint={`Subscriptions activated — ${periodLabel}`}
                                                />
                                            </div>
                                            <div style={{ flex: '1 1 220px' }}>
                                                <StatCard
                                                    label="Trial → Paid rate"
                                                    value={_fmtPct(summary.trial_to_paid_rate)}
                                                    tone="success"
                                                    hint={`Of ${_fmtNum(summary.decided_count)} decided trials — shops still on trial are excluded`}
                                                />
                                            </div>
                                            <div style={{ flex: '1 1 220px' }}>
                                                <StatCard
                                                    label="Converted (lifetime)"
                                                    value={_fmtNum(summary.converted)}
                                                    tone="success"
                                                    hint="Still alive when the trial ran out — includes those who later left"
                                                />
                                            </div>
                                        </InlineStack>

                                        <InlineStack gap="400" wrap>
                                            <div style={{ flex: '1 1 220px' }}>
                                                <StatCard
                                                    label={summary.paying.label}
                                                    value={_fmtNum(summary.paying.count)}
                                                    tone="success"
                                                    hint={`${_fmtPct(summary.paying.pct)} of cohort • Paying today`}
                                                />
                                            </div>
                                            <div style={{ flex: '1 1 220px' }}>
                                                <StatCard
                                                    label={summary.on_trial.label}
                                                    value={_fmtNum(summary.still_on_trial)}
                                                    hint={`${_fmtPct(summary.on_trial.pct)} of cohort • Outcome not yet decided`}
                                                />
                                            </div>
                                            <div style={{ flex: '1 1 220px' }}>
                                                <StatCard
                                                    label={summary.churned_during_trial.label}
                                                    value={_fmtNum(summary.churned_during_trial.count)}
                                                    tone="caution"
                                                    hint={`${_fmtPct(summary.churned_during_trial.pct)} of cohort • Never paid`}
                                                />
                                            </div>
                                            <div style={{ flex: '1 1 220px' }}>
                                                <StatCard
                                                    label={summary.churned_after_trial.label}
                                                    value={_fmtNum(summary.churned_after_trial.count)}
                                                    tone="critical"
                                                    hint={`${_fmtPct(summary.churned_after_trial.pct)} of cohort • Paid, then cancelled`}
                                                />
                                            </div>
                                        </InlineStack>

                                        <Card>
                                            <BlockStack gap="300">
                                                <Text as="h3" variant="headingMd">Where shops are lost</Text>
                                                <Text as="span" variant="bodySm" tone="subdued">
                                                    Two different losses. They are deliberately never combined into one number.
                                                </Text>
                                                {/* Side by side at full width, not stacked: the whole point of the card
                                                    is that these two losses are DIFFERENT, and reading them as a
                                                    vertical list invites totting them up into one number. */}
                                                <InlineStack gap="600" wrap align="start" blockAlign="start">
                                                    <div style={{ flex: '1 1 340px', minWidth: 280 }}>
                                                        <LossRow
                                                            color={STATE_COLOR.CHURNED_DURING_TRIAL}
                                                            label={summary.churned_during_trial.label}
                                                            count={summary.trial_side_losses}
                                                            meaning="Left before the trial ended, so they never paid. Nothing was earned and nothing was lost — this is a demand problem, not churn."
                                                        />
                                                    </div>
                                                    <div style={{ flex: '1 1 340px', minWidth: 280 }}>
                                                        <LossRow
                                                            color={STATE_COLOR.CHURNED_AFTER_TRIAL}
                                                            label={summary.churned_after_trial.label}
                                                            count={summary.churned_after_trial.count}
                                                            meaning="Reached the end of the trial, paid, then cancelled. This is real revenue lost, and it is counted inside Converted above."
                                                        />
                                                    </div>
                                                </InlineStack>
                                            </BlockStack>
                                        </Card>
                                    </BlockStack>
                                ) : null}
                            </DataStateSection>

                            {/* The month table and the trend's own note sit with the chart they
                                describe rather than at the foot of the page: they are read off the
                                same response, and a banner per block would repeat one refusal three
                                times. */}
                            <DataStateSection state={trendState} title="Monthly trial cohort trend" loading={loading}>
                                {trend ? (
                                    <BlockStack gap="400">
                                        <Card>
                                            <BlockStack gap="300">
                                                <Text as="h3" variant="headingMd">Monthly trial cohort trend</Text>
                                                <Text as="span" variant="bodySm" tone="subdued">
                                                    Stacked: how each month&apos;s trial-starters resolved. Line: trial→paid rate. Recent months are partial.
                                                </Text>
                                                {/* The stack is the cohort partitioned: converted + on trial +
                                                    churned during trial = trial starts. `churned_after_paid` is a
                                                    SUBSET of converted, so adding it as a fourth segment would
                                                    overflow the month's own total — it is a table column instead. */}
                                                <div style={{ width: '100%', height: 400 }}>
                                                    <ResponsiveContainer>
                                                        <ComposedChart data={trendChartData} margin={{ top: 20, right: 30, bottom: 20, left: 0 }}>
                                                            <CartesianGrid strokeDasharray="3 3" />
                                                            <XAxis dataKey="month" />
                                                            <YAxis yAxisId="left" />
                                                            <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => `${v.toFixed(0)}%`} />
                                                            <Tooltip formatter={(value, name) => {
                                                                // recharts passes the series' `name` prop here, falling back
                                                                // to its dataKey — so match on both rather than on the key
                                                                // alone, which never matched once the series was named.
                                                                if (name === 'Conversion rate %' || name === 'conversion_rate_pct') {
                                                                    // `Number(null).toFixed(1)` is "0.0" — the manufactured
                                                                    // zero again, in the one place the reader has hovered to
                                                                    // read it exactly. `_fmtRatePct` answers an em dash.
                                                                    return [_fmtRatePct(_numOrNull(value)), 'Conversion rate'];
                                                                }
                                                                return [_fmtNum(value), name];
                                                            }} />
                                                            <Legend />
                                                            <Bar yAxisId="left" dataKey="converted" stackId="a" name="Converted" fill={STATE_COLOR.PAYING} />
                                                            <Bar yAxisId="left" dataKey="in_trial" stackId="a" name="On trial" fill={STATE_COLOR.ON_TRIAL} />
                                                            <Bar yAxisId="left" dataKey="churned_during_trial" stackId="a" name="Churned during trial" fill={STATE_COLOR.CHURNED_DURING_TRIAL} />
                                                            {/*  `connectNulls={false}`: a null `conversion_rate_pct` is a
                                                                month the service never rated. Bridging the gap draws a
                                                                conversion rate through a month nobody measured, so the
                                                                line breaks instead (IMPLEMENTATION.md §3.11).
                                                                ⚠️ Recharts already defaults this to `false` (3.10.1) —
                                                                this comment used to claim its default bridges the gap,
                                                                which is untrue. Stated explicitly regardless: a default
                                                                can change in a minor release, and every null in this
                                                                series depends on the break. */}
                                                            <Line
                                                                yAxisId="right"
                                                                type="monotone"
                                                                dataKey="conversion_rate_pct"
                                                                name="Conversion rate %"
                                                                stroke="#5C6AC4"
                                                                strokeWidth={2}
                                                                dot={{ r: 3 }}
                                                                connectNulls={false}
                                                            />
                                                        </ComposedChart>
                                                    </ResponsiveContainer>
                                                </div>
                                            </BlockStack>
                                        </Card>

                                        {Array.isArray(trendChartData) && trendChartData.length > 0 ? (
                                            <Card padding="0">
                                                <div style={{ padding: '12px 16px' }}>
                                                    <Text as="h3" variant="headingMd">Monthly cohort detail</Text>
                                                </div>
                                                <IndexTable
                                                    resourceName={{ singular: 'month', plural: 'months' }}
                                                    itemCount={trendChartData.length}
                                                    headings={[
                                                        { title: 'Month' },
                                                        { title: 'Trial starts' },
                                                        { title: 'Converted' },
                                                        { title: 'On trial' },
                                                        { title: 'Churned during trial' },
                                                        { title: 'Churned after paid' },
                                                        { title: 'Conversion rate' }
                                                    ]}
                                                    selectable={false}
                                                >
                                                    {[...trendChartData].reverse().map((r, i) => (
                                                        <IndexTable.Row id={String(i)} key={r.month} position={i}>
                                                            <IndexTable.Cell>
                                                                <InlineStack gap="100" blockAlign="center">
                                                                    <Text as="span" fontWeight="semibold">{r.month}</Text>
                                                                    {r.is_aging ? (
                                                                        <PolarisTooltip content="This cohort is still aging — some on-trial shops may yet convert or churn.">
                                                                            <Badge tone="info">Aging</Badge>
                                                                        </PolarisTooltip>
                                                                    ) : null}
                                                                </InlineStack>
                                                            </IndexTable.Cell>
                                                            <IndexTable.Cell>{_fmtNum(r.trial_starts)}</IndexTable.Cell>
                                                            <IndexTable.Cell><Text as="span" tone="success">{_fmtNum(r.converted)}</Text></IndexTable.Cell>
                                                            <IndexTable.Cell>{_fmtNum(r.in_trial)}</IndexTable.Cell>
                                                            <IndexTable.Cell><Text as="span" tone="caution">{_fmtNum(r.churned_during_trial)}</Text></IndexTable.Cell>
                                                            <IndexTable.Cell><Text as="span" tone="critical">{_fmtNum(r.churned_after_paid)}</Text></IndexTable.Cell>
                                                            <IndexTable.Cell>
                                                                {/* `null < 20` is TRUE, so the unrated month the chart
                                                                    now skips would have been coloured critical red — the
                                                                    page shouting "bad conversion" about a month it has no
                                                                    reading for. No number, no verdict, no colour. */}
                                                                <Text
                                                                    as="span"
                                                                    tone={_numOrNull(r.conversion_rate_pct) === null
                                                                        ? 'subdued'
                                                                        : (r.conversion_rate_pct < 20 ? 'critical' : 'success')}
                                                                >
                                                                    {_fmtRatePct(r.conversion_rate_pct)}
                                                                </Text>
                                                            </IndexTable.Cell>
                                                        </IndexTable.Row>
                                                    ))}
                                                </IndexTable>
                                            </Card>
                                        ) : null}

                                        {trend && trend.note ? (
                                            <Banner tone="info">
                                                <p>{trend.note}</p>
                                            </Banner>
                                        ) : null}
                                    </BlockStack>
                                ) : null}
                            </DataStateSection>

                            {cohortBannerRepeatsOutcomes ? null : (
                                <DataStateSection state={cohortState} title="Shops in this cohort" loading={loading}>
                                    {cohort ? (
                                        <Card padding="0">
                                            <div style={{ padding: '12px 16px' }}>
                                                <BlockStack gap="100">
                                                    <Text as="h3" variant="headingMd">{`Shops in this cohort — ${cohortPeriodLabel}`}</Text>
                                                    <Text as="span" variant="bodySm" tone="subdued">
                                                        Every subscription activated in the selected range, listed under the state it is in TODAY — not the state it started in.
                                                    </Text>
                                                    {cohort && cohort.shops_truncated ? (
                                                        <Text as="span" variant="bodySm" tone="caution">
                                                            {`Showing the ${_fmtNum(cohortShops.length)} most recent trial starts. Narrow the date range to see the rest.`}
                                                        </Text>
                                                    ) : null}
                                                </BlockStack>
                                            </div>
                                            <Tabs
                                                tabs={cohortTabs}
                                                selected={cohortIndex}
                                                onSelect={(i) => setCohortTab(cohortTabs[i].id)}
                                            />
                                            {cohortRows.length > 0 ? (
                                                <IndexTable
                                                    resourceName={{ singular: 'shop', plural: 'shops' }}
                                                    itemCount={cohortRows.length}
                                                    headings={[
                                                        { title: 'Shop' },
                                                        { title: 'State' },
                                                        { title: 'Plan' },
                                                        { title: 'MRR' },
                                                        { title: 'Trial started' },
                                                        { title: 'Trial ended' },
                                                        { title: 'Churned at' }
                                                    ]}
                                                    selectable={false}
                                                >
                                                    {cohortRows.map((r, i) => {
                                                        let onSelect;
                                                        if (shopDrawer.canOpen(r)) {
                                                            onSelect = () => shopDrawer.open(r, i);
                                                        }
                                                        return (
                                                        <IndexTable.Row
                                                            id={String(i)}
                                                            key={`${r.shop_id}-${i}`}
                                                            position={i}
                                                            selected={shopDrawer.isOpen(r, i)}
                                                            onClick={onSelect}
                                                        >
                                                            <IndexTable.Cell>
                                                                {r.shop_domain ? (
                                                                    <Text as="span" variant="bodyMd" fontWeight="semibold">{r.shop_domain}</Text>
                                                                ) : (
                                                                    // The tenant id, labelled as one rather than printed bare where
                                                                    // it reads as the shop's name.
                                                                    <Text as="span" variant="bodySm" tone="subdued">{`No store record · ${r.shop_id}`}</Text>
                                                                )}
                                                            </IndexTable.Cell>
                                                            <IndexTable.Cell>
                                                                <Badge tone={STATE_BADGE_TONE[r.state]}>{r.label || STATE_LABEL_FALLBACK[r.state] || r.state}</Badge>
                                                            </IndexTable.Cell>
                                                            <IndexTable.Cell>
                                                                {r.plan_name ? <Text as="span">{r.plan_name}</Text> : <Text as="span" tone="subdued">—</Text>}
                                                            </IndexTable.Cell>
                                                            <IndexTable.Cell>{_fmtMoney(r.price)}</IndexTable.Cell>
                                                            <IndexTable.Cell>{_fmtDate(r.activated_at)}</IndexTable.Cell>
                                                            <IndexTable.Cell>{_fmtDate(r.trial_ends_at)}</IndexTable.Cell>
                                                            <IndexTable.Cell>{_fmtDate(r.churned_at)}</IndexTable.Cell>
                                                        </IndexTable.Row>
                                                        );
                                                    })}
                                                </IndexTable>
                                            ) : (
                                                <div style={{ padding: '16px' }}>
                                                    <Text as="p" tone="subdued">No shops in this state for the selected range.</Text>
                                                </div>
                                            )}
                                        </Card>
                                    ) : null}
                                </DataStateSection>
                            )}

                            {dataCaveats.length > 0 ? (
                                <Banner tone="warning" title="Some subscriptions are not counted">
                                    <ul style={{ paddingLeft: 18, margin: 0 }}>
                                        {dataCaveats.map((c, i) => <li key={i}>{c}</li>)}
                                    </ul>
                                </Banner>
                            ) : null}

                            {/* Everything the services could not see or had to approximate. Distinct
                                from the methodology notes below: those describe how the figures are
                                DEFINED and are the same on every request; these describe what THIS
                                response could not answer for and change with the deployment's
                                coverage — the lifetime-sync floor, the clamped month range, the
                                excluded test subscriptions, the truncated cohort. */}
                            {allWarnings.length > 0 ? (
                                <Banner tone="warning" title="What these figures could not cover">
                                    <ul style={{ paddingLeft: 18, margin: 0 }}>
                                        {allWarnings.map((w) => <li key={w}>{w}</li>)}
                                    </ul>
                                </Banner>
                            ) : null}

                            {/* The methodology notes are rendered from the payload rather than
                                restated here. The definition of "converted" has changed twice in
                                this module, and a note typed into the page cannot follow it. The
                                trend's own note is the same idea, beside the chart it annotates. */}
                            {outcomes && Array.isArray(outcomes.notes) && outcomes.notes.length > 0 ? (
                                <Banner tone="info" title="Methodology notes">
                                    <ul style={{ paddingLeft: 18, margin: 0 }}>
                                        {outcomes.notes.map((n, i) => <li key={i}>{n}</li>)}
                                    </ul>
                                </Banner>
                            ) : null}
                        </BlockStack>
                    ) : null}
                </BlockStack>
            </Page>
            {shopDrawer.drawer}
            {toastMarkup}
        </SideNavBar>
    );
};

export default TrialFunnelPage;
