import { Card, BlockStack, Box, InlineStack, Text, Banner, IndexTable, Badge, Tabs, Tooltip as PolarisTooltip } from '@shopify/polaris';
import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

import GrowthIntelConversionApiService from '../../../API_Services/growth-intel/conversionService';
import { dateRangeToMonths, dateRangeSpanDays } from '../DateRangeFilter';
import useStoreDetailDrawer from '../store/useStoreDetailDrawer';
import DataStateSection from '../DataStateSection';
import { pendingDataState, readDataState } from '../dataState';

/**
 * =============================================================================
 *  The Churn tab — MRR movement: new, expansion, contraction, churn.
 * =============================================================================
 *
 *  This was `pages/revenue-churn/index.js`. Its endpoint is the reason this file
 *  carries more prose about its own window than about its charts.
 *
 *  ── THE SHARED RANGE AND THIS ENDPOINT DO NOT SPEAK THE SAME LANGUAGE ────
 *  `GET /api/conversion/revenue-churn` takes `months` — a COUNT — and
 *  `buildMonthBuckets` counts them back from the instant of the request. It has
 *  no `since` and no `until`. The Revenue tab, one tab over, sends the picked
 *  range verbatim and gets a window positioned exactly where the reader put it.
 *  So one control drives two different kinds of window, and three things follow
 *  that the reader cannot see and this view therefore says out loud:
 *
 *    1. ROUNDING, AND IT IS NOT A ONE-WORD DIFFERENCE. `dateRangeToMonths` rounds
 *       the COUNT up — 45 days asks for 2 months — but the buckets are CALENDAR
 *       months ending with the one in progress, so the served span is not the
 *       picked one shifted or padded, it is a different span. Two months asked for
 *       on the 30th covers about 61 days; the same two asked for on the 2nd covers
 *       about 33. "Wider" and "narrower" are both wrong, which is why the notice
 *       below describes the shape of what was served instead of comparing them.
 *    2. POSITION. A custom range that ENDS IN THE PAST cannot be honoured at all:
 *       the months always end today. Pick 1 Jan → 14 Feb and this chart shows the
 *       two months ending now, which is a different span of time entirely while
 *       the Revenue tab beside it shows January and February. Two tabs, one
 *       control, two windows — and only this sentence says so.
 *    3. THE TILES DO NOT FOLLOW THE RANGE AT ALL. Every `last_month_*` figure is
 *       the last COMPLETE month, and so are the waterfall and the table. The range
 *       changes how far back the movement CHART reaches and nothing else — except
 *       at `months = 1`, where there is no complete month in range and all six
 *       tiles are honestly unknown.
 *
 *  ── WHY NOT JUST CONVERT THE RANGE PROPERLY ─────────────────────────────────
 *  Because the conversion does not exist. Nothing on the client can make an
 *  endpoint that counts back from now answer for a window that ended in March.
 *  The two available moves are to say what happened, or to let a reader believe
 *  the chart obeys the control above it. This project's whole premise is that the
 *  second is the expensive one: it does not crash, it returns a plausible wrong
 *  number.
 *
 *  ⚠️ IF `since`/`until` ARE EVER ADDED TO THAT ENDPOINT, delete `_windowNotice`
 *  and send `dateRange.params` like the Revenue tab does. A stale caveat about a
 *  limitation that has been fixed is its own kind of wrong number.
 * =============================================================================
 */

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

// `_fmtNum` came across from the old page and is not called by anything here; it was already dead
// there. Dead code carried into a new file reads as a formatter someone forgot to use, so it stopped
// at the door.
const _fmtMoney = (n) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const _fmtPct = (n) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return `${(Number(n) * 100).toFixed(1)}%`;
};
const _fmtDate = (d) => { if (!d) return '—'; try { return new Date(d).toLocaleDateString(); } catch (e) { return String(d); } };

/**
 * Parse a `yyyy-mm-dd` string as a LOCAL calendar date.
 *
 * `new Date('2026-03-01')` PARSES AS UTC MIDNIGHT, so west of Greenwich it prints as 28 February
 * — and the one place this view formats a raw range boundary is the sentence explaining that the
 * window is not what the reader picked. A caveat that misnames the date it is complaining about is
 * worse than no caveat. `DateRangeFilter` carries the identical parser for the identical reason;
 * it is not exported, so it is repeated rather than reached for.
 *
 * @param {String} s - A `yyyy-mm-dd` string, as `DateRangeFilter` stores it.
 * @returns {Date|null} A local-midnight Date, or null when the string is not a plain date.
 */
const _parseIsoDateOnly = (s) => {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};

/** Local midnight today, for comparing a picked end date against "now". */
const _today = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
};

const _fmtPretty = (iso) => {
    const d = _parseIsoDateOnly(iso);
    if (!d) return String(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

/**
 * The date a shop stopped paying, and — when it matters — WHAT DATED IT.
 *
 * ⚠️ TWO KINDS OF DATE UNDER ONE COLUMN HEADING. `churn_date_basis: 'partner_event'` is a real
 * cancellation carrying Shopify's own timestamp. `'ledger_window'` means NO SUCH EVENT EVER REACHED
 * US, so the date shown is the instant the shop's last settled payout aged out of the active window
 * — ALWAYS LATER than the day it actually cancelled, by up to one billing cycle plus payout grace.
 * Printed bare, the two are indistinguishable, and the second silently over-states how long the
 * merchant paid; the "Paid duration" in the next column is derived from it, so that figure is an
 * over-estimate on exactly these rows.
 *
 * The service counts them in `warnings[]` — this marks the INDIVIDUAL rows, so a reader quoting one
 * date knows which kind it is. Mirrors `RevenueMovementStoresPanel._renderChurnDate` and
 * `RevenueView`'s copy deliberately: the same three lists name the same shops, and a caveat shown on
 * one and not the others reads as a difference in the data rather than in the rendering. They are
 * one tab apart now, which makes the disagreement easier to spot and no less wrong.
 *
 * A row with no basis at all (an older payload) prints exactly as it did before.
 *
 * @param {Object} row - A churned shop row carrying `churned_at` and `churn_date_basis`.
 * @returns {React.ReactNode}
 */
const _renderChurnDate = (row) => {
    const shown = _fmtDate(row.churned_at);
    if (row.churn_date_basis !== 'ledger_window') {
        return shown;
    }
    return (
        <PolarisTooltip content="No cancellation event reached us for this shop, so this is the day its last settled payout aged out of the active window — always later than the day it actually cancelled, which makes the paid duration beside it an over-estimate.">
            <Text as="span" tone="subdued">{`${shown} (inferred)`}</Text>
        </PolarisTooltip>
    );
};

/**
 * A rate published as a fraction, rendered as a percentage — or `null` when it was never published.
 *
 * `null * 100 === 0` IN JAVASCRIPT. That is the whole reason this exists. A month the service
 * did not rate used to arrive at Recharts as a hard `0`, which draws a point on the axis floor and
 * says "this month's churn was zero" — a specific, confident, checkable claim about the operator's
 * business, manufactured by an arithmetic coercion nobody wrote deliberately. Paired with
 * `connectNulls={false}` on the series, a null now BREAKS THE LINE instead, which is what
 * IMPLEMENTATION.md §3.11 asks a chart to do with an unknown.
 *
 * A genuine measured `0` is a number, passes the typeof test, and still plots.
 *
 * @param {*} rate - The fraction from the payload, e.g. 0.042.
 * @returns {Number|null} The percentage, or null when no rate was published.
 */
const _ratePct = (rate) => (typeof rate === 'number' && Number.isFinite(rate) ? rate * 100 : null);

/**
 * Money plotted DOWNWARDS on the movement chart — or `null` when the month was never measured.
 *
 *  `-null` IS `-0` IN JAVASCRIPT, AND `-0` IS A NUMBER. That is the whole reason this exists.
 * `monthly_trend` is legitimately MIXED: it stays an array whenever at least one month is measurable,
 * so a young deployment asking for twelve months gets nulls beside real months. The service publishes
 * EVERY figure of an unmeasured month as `null` — `contraction_mrr` and `churned_mrr` included — and
 * `churned_mrr: -r.churned_mrr` turned each of those into `-0`, which passes the tooltip's
 * `typeof value === 'number'` test and prints "Churned 0.00": a measured claim of no revenue lost, in
 * a month nobody measured, sitting beside "New —" and "Gross churn —" that kept their nulls because
 * nothing negated them.
 *
 * Emitting `0` from the service instead would break the null-vs-zero rule the whole module is built
 * on, so the fix belongs here, at the coercion. `logo-churn/index.js` carries the identical helper for
 * the identical reason, one page over.
 *
 * A genuine measured `0` negates to `-0`, which plots and formats exactly like `0` — "nobody churned
 * this month" still reads as one.
 *
 * @param {*} amount - A money figure straight off the payload.
 * @returns {Number|null} The negated amount, or null when the month carries no measurement.
 */
const _plotDown = (amount) => (typeof amount === 'number' && Number.isFinite(amount) ? -amount : null);

/**
 * The magnitude of a plotted figure, for a tooltip — `—` when there is no figure.
 *
 * ⚠️ `Math.abs(null)` IS `0`. Unguarded, it reinstates the manufactured zero `_plotDown` was written
 * to remove, one layer further down and in the one place the reader hovered to read it exactly.
 *
 * @param {*} value - The value recharts handed the tooltip.
 * @returns {String} A money string, or an em dash.
 */
const _fmtPlotted = (value) => (
    typeof value === 'number' && Number.isFinite(value) ? _fmtMoney(Math.abs(value)) : '—'
);

// A missing duration is '—', never '0 days' or 'undefined days': the shop DID pay for some length of
// time, we just cannot date one end of it, and a zero would read as "churned the day it converted".
const _fmtDays = (n) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return `${Number(n).toLocaleString()} ${Number(n) === 1 ? 'day' : 'days'}`;
};

const StatCard = ({ label, value, tone, sub }) => (
    <Card>
        <BlockStack gap="100">
            <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
            <Text as="span" variant="heading2xl" tone={tone}>{value}</Text>
            {sub ? <Text as="span" variant="bodySm" tone="subdued">{sub}</Text> : null}
        </BlockStack>
    </Card>
);

/**
 * WHAT THE SHARED RANGE ACTUALLY BOUGHT THIS TAB, in sentences the reader can check.
 *
 * Every branch below exists because the picked range and the served window differ in a way that is
 * INVISIBLE on the chart. See the file header for the three ways they diverge; this is where each of
 * them becomes a sentence. Pure and separated from the component so the wording can be read in one
 * place rather than reconstructed from three nested ternaries in the JSX.
 *
 * @param {Object} params
 * @param {Object} params.value - `dateRange.value` — the picked range, as `DateRangeFilter` stores it.
 * @param {String} params.label - `dateRange.label` — how the control above spells that range.
 * @param {Number} params.months - What {@link dateRangeToMonths} turned it into, i.e. what was sent.
 * @param {Array|null} params.rows - `monthly_trend`, for naming the months actually plotted.
 * @returns {{ headline: String, reconciliation: String, drift: String|null }} Three sentences; `drift`
 *   is null unless the served window is somewhere the reader did not ask for.
 */
const _windowNotice = ({ value, label, months, rows }) => {
    const monthNoun = months === 1 ? 'month' : 'months';

    // The months ACTUALLY PLOTTED, taken from the rows rather than recomputed: they are the x-axis
    // labels verbatim, so the sentence and the chart cannot disagree. The payload's `since`/`until`
    // are ISO instants in UTC and formatting them locally can name the month before the first bar.
    let headline = `Bucketed by whole month: the ${months} most recent months, ending with the month in progress.`;
    if (months === 1) {
        headline = 'Bucketed by whole month: the month in progress, and nothing before it.';
    }
    if (Array.isArray(rows) && rows.length > 0) {
        const first = rows[0].month;
        const last = rows[rows.length - 1].month;
        headline = `Bucketed by whole month: ${rows.length} ${rows.length === 1 ? 'month' : 'months'}, ${first} → ${last}.`;
    }

    // ⚠️ NOT "A WIDER WINDOW" AND NOT A NARROWER ONE — it is a DIFFERENT one, and saying either of
    // the first two would be the plausible wrong number this whole file exists to refuse. The count
    // rounds up (`Math.ceil(days / 30)`), but the buckets are anchored to CALENDAR MONTHS ending with
    // the one in progress, so whether the served span is longer or shorter than the picked one
    // depends on today's day of the month: two months asked for on the 30th covers about 61 days, and
    // the same two asked for on the 2nd covers about 33. There is no true one-word comparison, so the
    // sentence describes the SHAPE of the served window and lets the reader compare it themselves.
    const anchor = 'counted back from today: the oldest begins on the 1st of its month rather than a fixed number of days ago, and the newest is the month in progress, so its bar covers only the days elapsed so far';

    // ── Presets ──────────────────────────────────────────────────────────────────────────────
    if (!value || value.kind !== 'custom') {
        if (value && value.preset === 'all') {
            return {
                headline,
                reconciliation: `"${label}" is served here as the 36 most recent months, which is the most this endpoint returns — anything earlier exists but is not plotted.`,
                drift: null
            };
        }
        return {
            headline,
            reconciliation: `"${label}" becomes ${months} whole calendar ${monthNoun}, ${anchor}.`,
            drift: null
        };
    }

    // ── Custom ranges — where the two windows genuinely come apart ────────────────────────────
    // NOT a local parse here. `months` below comes from `dateRangeToMonths`, which parses these
    // same strings as UTC; a second, local derivation of the span disagreed with it by a day across
    // a DST boundary, and this sentence quotes BOTH numbers in one breath.
    const spanDays = dateRangeSpanDays(value);

    let reconciliation = `Your range becomes ${months} whole calendar ${monthNoun}, ${anchor}.`;
    if (spanDays !== null) {
        reconciliation = `Your range spans ${spanDays} ${spanDays === 1 ? 'day' : 'days'} (${_fmtPretty(value.from)} → ${_fmtPretty(value.to)}). This view cannot take a start and an end — its endpoint asks for a NUMBER OF MONTHS — so those ${spanDays} days become ${months} whole calendar ${monthNoun}, ${anchor}. Those months are not the days you picked.`;
    }

    // THE EXPENSIVE CASE. A range that ended in the past is not merely rounded — it is MOVED.
    let drift = null;
    if (to && to.getTime() < _today().getTime()) {
        drift = `Your range ends on ${_fmtPretty(value.to)}, in the past, and this view cannot honour that: its endpoint takes a number of months and always counts them back from today. The months below are therefore the ${months} most recent, NOT the ones inside your range — while the Revenue tab, which does take a start and an end, is showing exactly the window you picked. The two tabs are describing different spans of time right now.`;
    }

    return { headline, reconciliation, drift };
};

/**
 * The Churn view.
 *
 * @param {Object} props
 * @param {String} props.appId - The selected partner app. No request is issued without one.
 * @param {Boolean} props.appHydrated - True once the app selection has been read from storage.
 * @param {Object} props.dateRange - The PAGE's `useDateRangeState` result, shared by all three tabs.
 * @returns {JSX.Element}
 */
const ChurnView = ({ appId, appHydrated, dateRange }) => {
    // ⚠️ Derived from the SHARED range, which is the whole point of the merge — and the reason
    // `_windowNotice` exists. This is the lossy step, and it is lossy in three directions at once.
    const months = dateRangeToMonths(dateRange.value);
    const [churn, setChurn] = useState(pendingDataState());
    const [loading, setLoading] = useState(false);
    const [chartTab, setChartTab] = useState('waterfall');

    const fetchData = useCallback(() => {
        if (!appId || !appHydrated) return;
        if (!dateRange.hydrated) return;
        setLoading(true);
        CONV_API.getRevenueChurn({ partner_app_id: appId, months }, (resp) => {
            setLoading(false);
            // `if (resp.status && resp.data)` used to collapse the not-implemented envelope, an
            // expired session and a real empty month into one `null`, after which the view drew
            // nothing beneath its title. The decoder keeps them apart so the banner can say which.
            //
            // A success carrying no `summary` block is NEVER_SYNCED rather than READY: the six MRR
            // tiles below read `summary.current_mrr` and friends directly, and "$0.00 current MRR"
            // is a claim about the business that no one made — the §4.5 regression exactly.
            setChurn(readDataState(resp, { isNeverSynced: (d) => !d.summary }));
        });
    }, [appId, appHydrated, months, dateRange.hydrated]);

    useEffect(() => { fetchData(); }, [fetchData]);

    // The payload, or null. `readDataState` nulls `data` in every state except READY, so this is
    // never a stand-in `{}`: the section below is gated on `churn`, and no waterfall, chart or tile
    // is drawn over a figure the backend declined to publish.
    const data = churn.data;

    /**
     * Clicking a churned shop opens the shared store detail panel.
     *
     * ⚠️ Keyed on `shop_domain` ALONE. `top_churned_30d[].shop_id` is Shopify's partner shop gid —
     * `ledgerMrr` reads it straight off `PartnerAppTransaction.shop_id`, which `partnerSyncService`
     * fills from `node.shop.id` — so the detail endpoint, which takes an internal store tenant id or
     * a myshopify domain, cannot resolve it. A row with no domain is therefore left unclickable,
     * which is exactly what its own "No store record" cell already says.
     *
     * The `|| []` is the one that stays: it feeds a hook, which has to run on every render, and it
     * is never rendered as an answer — the table it steps through is not mounted unless the state
     * is READY.
     */
    const topChurned = (data && data.top_churned_30d) || [];
    const shopDrawer = useStoreDetailDrawer({
        rows: topChurned,
        appId,
        rowKey: (r, i) => `${r.shop_domain || r.shop_id}-${i}`
    });

    const trendRows = (data && Array.isArray(data.monthly_trend)) ? data.monthly_trend : null;

    const chartData = trendRows ? trendRows.map((r) => ({
        month: r.month,
        new_mrr: r.new_mrr,
        expansion_mrr: r.expansion_mrr,
        // Negated through `_plotDown`, NEVER with a bare unary minus — see that helper. An unmeasured
        // month must stay null so its bar is ABSENT rather than drawn flat on the axis.
        contraction_mrr: _plotDown(r.contraction_mrr),
        churned_mrr: _plotDown(r.churned_mrr),
        gross_churn_pct: _ratePct(r.gross_churn_rate),
        net_churn_pct: _ratePct(r.net_churn_rate),
        end_mrr: r.end_mrr
    })) : [];

    // THE WATERFALL DESCRIBES THE LAST COMPLETE MONTH, NEVER THE ONE IN PROGRESS, and that rule
    // predates the tab merge and survives it unchanged. It used to take the final trend row, which is
    // the month IN PROGRESS, so a panel headed "Last month" drew an unfinished month that could not
    // reconcile with a single figure beside it — the six tiles above are all `last_month_*`, i.e. the
    // last COMPLETE month, and `summary.last_complete_month` names it. The two have to agree.
    let waterfallMonth = null;
    let waterfallIsPartial = false;
    if (trendRows && trendRows.length > 0) {
        const complete = trendRows.filter((r) => !r.is_partial_month);
        if (complete.length > 0) {
            waterfallMonth = complete[complete.length - 1];
        } else {
            // A one-month window can hold nothing but the month in progress. Drawing it beats an
            // empty panel, as long as the caption says which month it is and that it is unfinished.
            waterfallMonth = trendRows[trendRows.length - 1];
            waterfallIsPartial = true;
        }
    }

    let waterfallData = [];
    if (waterfallMonth) {
        waterfallData = [
            { name: 'Start MRR',    value: waterfallMonth.start_mrr,        fill: '#919EAB' },
            { name: '+ New',        value: waterfallMonth.new_mrr,          fill: '#50B83C' },
            { name: '+ Expansion',  value: waterfallMonth.expansion_mrr,    fill: '#47C1BF' },
            // Same `_plotDown` guard as the movement chart: the waterfall can be drawn over a month
            // in progress, and an unmeasured one publishes all six figures as null.
            { name: '− Contraction', value: _plotDown(waterfallMonth.contraction_mrr), fill: '#F49342' },
            { name: '− Churned',    value: _plotDown(waterfallMonth.churned_mrr),     fill: '#DE3618' },
            { name: 'End MRR',      value: waterfallMonth.end_mrr,          fill: '#5C6AC4' }
        ];
    }

    let waterfallCaption = 'start + new + expansion − contraction − churned = end.';
    if (waterfallMonth) {
        waterfallCaption = `${waterfallMonth.month} · start + new + expansion − contraction − churned = end.`;
    }
    if (waterfallMonth && waterfallIsPartial) {
        waterfallCaption = `${waterfallMonth.month} · month in progress, so these totals cover only the days elapsed so far.`;
    }

    // Tab ids, not indices: the strip is built from what actually has data, so an index would point
    // at a different chart depending on which ones rendered.
    const chartTabs = [];
    if (waterfallData.length > 0) {
        chartTabs.push({ id: 'waterfall', content: 'MRR waterfall' });
    }
    if (chartData.length > 0) {
        chartTabs.push({ id: 'movement', content: 'Monthly movement' });
    }
    let chartIndex = chartTabs.findIndex((t) => t.id === chartTab);
    if (chartIndex < 0) {
        chartIndex = 0;
    }
    let activeChart = null;
    if (chartTabs.length > 0) {
        activeChart = chartTabs[chartIndex].id;
    }

    const windowNotice = _windowNotice({
        value: dateRange.value,
        label: dateRange.label,
        months,
        rows: trendRows
    });

    /**
     * THE SHARED RANGE CAN EMPTY THE SIX TILES, AND THE TILES CANNOT SAY WHY.
     *
     * `summary.last_complete_month` is null when the requested range holds nothing but the month in
     * progress — which is exactly what the 30-day preset produces (`months = 1`). All six figures are
     * then `null` and render as `—`, correctly: they are unknown, not zero. But an em dash beside a
     * date control the reader has just moved reads as "we lost your data", and the remedy — widen the
     * range — is not guessable from a dash. It was not reachable at all before the merge, because
     * this view had its own range defaulting to a year; a shared control makes it one click away.
     */
    let noCompleteMonth = false;
    if (data && data.summary && !data.summary.last_complete_month) {
        noCompleteMonth = true;
    }

    return (
        <>
            {/* The page mounts this view only for a selected app, so the old `appId &&` guard on
                both arms is gone. With no app the fetch early-returns, `loading` stays false and the
                section below renders nothing — the same silence, decided one level up. */}
            {loading ? (
                <Card><Text as="p">Loading revenue churn data…</Text></Card>
            ) : (
                /* One endpoint, so one section. The gate is the STATE, not the payload:
                   with `appId && data` a refused call rendered literally nothing under the
                   page title, which reads as a broken build rather than as an answer. */
                <DataStateSection state={churn} loading={loading}>
                    {/* `loading` is what stops PENDING from drawing. This view early-returns
                        from `fetchData` when no app is selected without ever setting `loading`,
                        so PENDING is not always "the answer is coming" — it is sometimes "no
                        request was ever made", and only the first of those may mount a child.
                        Passing the view's own flag lets the section tell them apart. (The
                        branch above already swallows the in-flight case today; this stays
                        correct if that ternary is ever restructured.)

                        The payload is still checked once more below, because a PENDING child
                        paints before the request has answered and `data` is null until it does. */}
                    {data ? (
                        <BlockStack gap="400">
                            {/* WHAT THE CONTROL ABOVE ACTUALLY DID TO THIS TAB, FIRST THING AND
                                ABOVE THE FIGURES IT QUALIFIES. The rounding, the position and the
                                fixed last-complete-month basis are all invisible on the chart; see
                                the file header for why none of them can be fixed from here.

                                A `Box` and not a `Banner`: nothing failed, and a coloured alarm on
                                every visit is how an operator learns to stop reading banners. The
                                one genuinely dangerous case — a range that ends in the past, which
                                this view silently relocates — is a `critical` Banner of its own
                                below, because that one IS a disagreement between two tabs. */}
                            <Box
                                background="bg-surface-secondary"
                                padding="300"
                                borderRadius="200"
                                borderColor="border-secondary"
                                borderWidth="025"
                            >
                                <BlockStack gap="100">
                                    <Text as="p" variant="bodySm" fontWeight="semibold">{windowNotice.headline}</Text>
                                    <Text as="p" variant="bodySm" tone="subdued">{windowNotice.reconciliation}</Text>
                                    <Text as="p" variant="bodySm" tone="subdued">
                                        The range changes how far back the movement chart reaches and nothing
                                        else: the six figures below, the waterfall and the table are always the
                                        last COMPLETE month.
                                    </Text>
                                </BlockStack>
                            </Box>

                            {windowNotice.drift ? (
                                <Banner tone="critical" title="This tab is not showing the window you picked">
                                    <p>{windowNotice.drift}</p>
                                </Banner>
                            ) : null}

                            <InlineStack gap="400" wrap>
                                <div style={{ flex: '1 1 220px' }}><StatCard label="Current MRR" value={_fmtMoney(data.summary.current_mrr)} /></div>
                                <div style={{ flex: '1 1 220px' }}><StatCard label="New MRR (last month)" value={_fmtMoney(data.summary.last_month_new_mrr)} tone="success" /></div>
                                <div style={{ flex: '1 1 220px' }}><StatCard label="Churned MRR (last month)" value={_fmtMoney(data.summary.last_month_churned_mrr)} tone="critical" /></div>
                                <div style={{ flex: '1 1 220px' }}><StatCard label="Expansion MRR (last month)" value={_fmtMoney(data.summary.last_month_expansion_mrr)} /></div>
                            </InlineStack>

                            {/* BOTH CARDS CARRY A `sub`, AND THE GROSS ONE IS THE LOAD-BEARING HALF.
                                This figure is `(churned + contraction) / opening MRR` — it counts
                                DOWNGRADES, not just cancellations — and the Revenue tab publishes the
                                same number from `movementSince.helper` with the sentence
                                "cancellations plus downgrades, measured against the paying base at the
                                start of the window" beside it (`RevenueMovementStats.js`). The two
                                agree numerically; while only one of them SAID what it included, a
                                reader who compared the screens had no way to tell whether they were
                                looking at one definition or two, and the natural reading of a bare
                                "gross churn" is cancellations only — which is the reading this batch
                                just corrected in the backend. Keep the wording in step with
                                `revenueChurn.helper`'s `_lostFromBase`: if that sum ever changes, both
                                of these sentences are wrong on the same day. */}
                            <InlineStack gap="400" wrap>
                                <div style={{ flex: '1 1 220px' }}><StatCard label="Gross churn rate (last month)" value={_fmtPct(data.summary.last_month_gross_churn_rate)} tone={data.summary.last_month_gross_churn_rate > 0.05 ? 'critical' : undefined} sub="cancellations plus downgrades, against the opening base" /></div>
                                <div style={{ flex: '1 1 220px' }}><StatCard label="Net churn rate (last month)" value={_fmtPct(data.summary.last_month_net_churn_rate)} sub="the same, less expansion — 0 means expansion ≥ churn" /></div>
                            </InlineStack>

                            {/* THE DASHES ABOVE HAVE A CAUSE AND A REMEDY, and neither is legible
                                from a dash. See `noCompleteMonth`. Rendered BELOW the tiles it
                                explains rather than above them, because it is an answer to a question
                                the reader only has once they have seen them. */}
                            {noCompleteMonth ? (
                                <Banner tone="info" title="No complete month in this range">
                                    <p>
                                        The selected range covers only the month in progress, so there is no
                                        finished month to report and the last-month figures above are unknown
                                        rather than zero. Widen the range at the top of the page — 90 days or
                                        more — and they fill in.
                                    </p>
                                </Banner>
                            ) : null}

                            {/* Only the SELECTED chart is mounted. Hiding the other with `display:none`
                                would break it: ResponsiveContainer measures its parent, a hidden parent
                                measures 0, and the chart renders collapsed and stays that way until
                                something forces a re-measure.

                                No `fitted` on Tabs — it stretches the strip edge to edge, so two tabs
                                read as two giant buttons rather than a tab row. */}
                            {chartTabs.length > 0 ? (
                                <Card padding="0">
                                    <Tabs
                                        tabs={chartTabs}
                                        selected={chartIndex}
                                        onSelect={(i) => setChartTab(chartTabs[i].id)}
                                    />
                                    <div style={{ padding: '0 16px 16px' }}>
                                        {activeChart === 'waterfall' ? (
                                            <BlockStack gap="300">
                                                <Text as="span" variant="bodySm" tone="subdued">{waterfallCaption}</Text>
                                                <div style={{ width: '100%', height: 280 }}>
                                                    <ResponsiveContainer>
                                                        <ComposedChart data={waterfallData} margin={{ top: 20, right: 30, bottom: 20, left: 0 }}>
                                                            <CartesianGrid strokeDasharray="3 3" />
                                                            <XAxis dataKey="name" />
                                                            <YAxis tickFormatter={(v) => _fmtMoney(v)} />
                                                            <Tooltip formatter={(value) => [_fmtPlotted(value), 'MRR $']} />
                                                            <Bar dataKey="value" />
                                                        </ComposedChart>
                                                    </ResponsiveContainer>
                                                </div>
                                            </BlockStack>
                                        ) : null}
                                        {activeChart === 'movement' ? (
                                            <BlockStack gap="300">
                                                <Text as="span" variant="bodySm" tone="subdued">Bars: New + Expansion (green/teal) — Contraction + Churned (orange/red). Line: gross churn rate %.</Text>
                                                <div style={{ width: '100%', height: 380 }}>
                                                    <ResponsiveContainer>
                                                        <ComposedChart data={chartData} stackOffset="sign" margin={{ top: 20, right: 30, bottom: 20, left: 0 }}>
                                                            <CartesianGrid strokeDasharray="3 3" />
                                                            <XAxis dataKey="month" />
                                                            <YAxis yAxisId="left" tickFormatter={(v) => _fmtMoney(v)} />
                                                            <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => `${v.toFixed(1)}%`} />
                                                            {/* ⚠️ MATCH ON THE SERIES `name` AS WELL AS THE dataKey.
                                                                recharts' `getTooltipNameProp` passes `props.name` when a
                                                                series has one and falls back to the dataKey only when it
                                                                does not — every series here is named, so the dataKey
                                                                comparisons alone matched NOTHING and the churn-rate line
                                                                fell through to the MONEY branch, printing a percentage
                                                                with two decimal places and thousands separators as
                                                                though it were dollars. Same trap the logo-churn and
                                                                trial-funnel charts already document. */}
                                                            <Tooltip formatter={(value, name) => {
                                                                const pct = typeof value === 'number' && Number.isFinite(value)
                                                                    ? `${value.toFixed(2)}%`
                                                                    : '—';
                                                                if (name === 'Gross churn %' || name === 'gross_churn_pct') return [pct, 'Gross churn'];
                                                                if (name === 'Net churn %' || name === 'net_churn_pct') return [pct, 'Net churn'];
                                                                return [_fmtPlotted(value), name];
                                                            }} />
                                                            <Legend />
                                                            <Bar yAxisId="left" dataKey="new_mrr" stackId="a" name="New" fill="#50B83C" />
                                                            <Bar yAxisId="left" dataKey="expansion_mrr" stackId="a" name="Expansion" fill="#47C1BF" />
                                                            <Bar yAxisId="left" dataKey="contraction_mrr" stackId="a" name="Contraction" fill="#F49342" />
                                                            <Bar yAxisId="left" dataKey="churned_mrr" stackId="a" name="Churned" fill="#DE3618" />
                                                            <Line yAxisId="right" type="monotone" dataKey="gross_churn_pct" name="Gross churn %" stroke="#5C6AC4" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
                                                        </ComposedChart>
                                                    </ResponsiveContainer>
                                                </div>
                                            </BlockStack>
                                        ) : null}
                                    </div>
                                </Card>
                            ) : null}

                            {Array.isArray(data.top_churned_30d) && data.top_churned_30d.length > 0 ? (
                                <Card padding="0">
                                    <div style={{ padding: '12px 16px' }}>
                                        <Text as="h3" variant="headingMd">
                                            {/* The rows are the last COMPLETE month's churn, which is what the
                                                headline figures use — never a rolling 30 days. Naming the month
                                                is the difference between a number you can check and one you cannot. */}
                                            {data.summary && data.summary.last_complete_month
                                                ? `Top revenue lost in ${data.summary.last_complete_month}`
                                                : 'Top revenue lost (last complete month)'}
                                        </Text>
                                    </div>
                                    <IndexTable
                                        resourceName={{ singular: 'shop', plural: 'shops' }}
                                        itemCount={data.top_churned_30d.length}
                                        headings={[
                                            { title: 'Shop' },
                                            { title: 'Plan' },
                                            { title: 'Lost MRR' },
                                            { title: 'Paid from' },
                                            { title: 'Churned at' },
                                            { title: 'Paid duration' }
                                        ]}
                                        selectable={false}
                                    >
                                        {data.top_churned_30d.map((r, i) => {
                                            let onSelect;
                                            if (shopDrawer.canOpen(r)) {
                                                onSelect = () => shopDrawer.open(r, i);
                                            }
                                            return (
                                                <IndexTable.Row
                                                    id={String(i)}
                                                    key={r.shop_id + i}
                                                    position={i}
                                                    selected={shopDrawer.isOpen(r, i)}
                                                    onClick={onSelect}
                                                >
                                                    <IndexTable.Cell>
                                                        {r.shop_domain ? (
                                                            <Text as="span" variant="bodyMd" fontWeight="semibold">{r.shop_domain}</Text>
                                                        ) : (
                                                            // The tenant id, labelled as one. It used to be printed bare, where it
                                                            // read as the shop's name — a row you cannot act on, presented as one you can.
                                                            <Text as="span" variant="bodySm" tone="subdued">{`No store record · ${r.shop_id}`}</Text>
                                                        )}
                                                    </IndexTable.Cell>
                                                    <IndexTable.Cell>
                                                        {r.plan_name ? <Badge>{r.plan_name}</Badge> : <Text as="span" tone="subdued">—</Text>}
                                                    </IndexTable.Cell>
                                                    <IndexTable.Cell>
                                                        <Text as="span" tone="critical" fontWeight="semibold">{_fmtMoney(r.lost_mrr)}</Text>
                                                    </IndexTable.Cell>
                                                    <IndexTable.Cell>{_fmtDate(r.paid_from)}</IndexTable.Cell>
                                                    <IndexTable.Cell>{_renderChurnDate(r)}</IndexTable.Cell>
                                                    <IndexTable.Cell>{_fmtDays(r.paid_days)}</IndexTable.Cell>
                                                </IndexTable.Row>
                                            );
                                        })}
                                    </IndexTable>
                                </Card>
                            ) : null}

                            {/* ⚠️ ONE PROSE CHANNEL, AND `notes` IS IT. `revenueChurn.types.ts` says so
                                by name: `notes` is the methodology sentences FOLLOWED BY every entry of
                                `warnings`, precisely because this view has no warnings banner. Adding
                                one would print each caveat twice, and a reader who sees the same
                                sentence in two places reads it as two problems. */}
                            {Array.isArray(data.notes) && data.notes.length > 0 ? (
                                <Banner tone="info" title="Methodology notes">
                                    <ul style={{ paddingLeft: 18, margin: 0 }}>
                                        {data.notes.map((n, i) => <li key={i}>{n}</li>)}
                                    </ul>
                                </Banner>
                            ) : null}
                        </BlockStack>
                    ) : null}
                </DataStateSection>
            )}
            {shopDrawer.drawer}
        </>
    );
};

export default ChurnView;
