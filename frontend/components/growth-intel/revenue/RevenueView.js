import { Card, BlockStack, InlineStack, Text, Banner, IndexTable, Badge, Tabs, Tooltip as PolarisTooltip } from '@shopify/polaris';
import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

import GrowthIntelConversionApiService from '../../../API_Services/growth-intel/conversionService';
import PlanRevenueBreakdown from '../PlanRevenueBreakdown';
import PeriodHeading from '../PeriodHeading';
import RevenueMovementStats from '../RevenueMovementStats';
import RevenueMovementStoresPanel from '../RevenueMovementStoresPanel';
import useStoreDetailDrawer from '../store/useStoreDetailDrawer';
import DataStateSection from '../DataStateSection';
import { pendingDataState, readDataState } from '../dataState';
import { fmtMoney, fmtNum, fmtDate, fmtMoneyOrDash, fmtNumOrDash } from '../moneyFormat';

/**
 * =============================================================================
 *  The Revenue tab — MRR, cash collected, ARPU, and the movement behind them.
 * =============================================================================
 *
 *  This was `pages/revenue/index.js` in its entirety until Revenue, By country and
 *  Churn were collapsed into one tabbed screen. Nothing about what it MEASURES
 *  changed in the move; what changed is who owns the chrome. The page now owns the
 *  shell, the roster banners, the tab strip and the date range, and hands the range
 *  down — so the three tabs cannot drift into three different windows.
 *
 *  ── WHY IT IS A COMPONENT AND NOT A SECTION OF THE PAGE ─────────────────────
 *  Three views inlined into one file is 2,160 lines, and — the part that matters —
 *  three fetches, three sets of decoded state and three sets of empty-state gating
 *  in one component. Separate components keep each view's `DataStateSection`
 *  gating local to the view that reads it, so a tab whose endpoint is refusing
 *  cannot blank a tab whose endpoint is answering.
 *
 *  ──  MOUNTED ONLY WHILE ITS TAB IS SELECTED ────────────────────────────────
 *  The page renders exactly one view at a time, which is what makes the fetch
 *  lazy: this component's `useEffect` is the request, so no request is issued for
 *  a tab nobody opened. Three endpoints behind one screen would otherwise be
 *  three requests every time the screen opens.
 *
 *  ⚠️ It also means switching away and back REFETCHES. That is deliberate and it
 *  is what `pages/funnel/index.js` already does (`if (tabIndex === 2)
 *  fetchConversion()` re-runs on every selection). Keeping a stale payload mounted
 *  behind a hidden tab would be worse than the extra request: recharts'
 *  `ResponsiveContainer` measures its parent, and a `display: none` parent measures
 *  0, so every chart here would come back collapsed.
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
const Cell = dynamic(() => import('recharts').then((m) => m.Cell), { ssr: false });

/**
 *  `Cell` is matched BY NAME, so the dynamic wrapper has to answer to it.
 *
 * `Bar` collects its per-bar overrides with `findAllByType(props.children, Cell)`, which compares
 * `child.type.displayName || child.type.name` against the string `'Cell'` (recharts
 * `util/ReactUtils`). `next/dynamic` returns `forwardRef(LoadableComponent)`, an OBJECT with no
 * `name` and no `displayName` — so every `<Cell>` below would be silently skipped and all bars
 * would take the series `fill`, which is the greying quietly not happening. `AttributionPieChart`
 * hit exactly this and worked around it by putting `fill` on each datum; `Bar` has no such path
 * (it only ever merges `cells[index].props`), so the identity has to be restored here.
 *
 * Nothing is ever mounted from this import — recharts reads the element's props and drops it — so
 * the loader never runs and there is no loading flash.
 */
Cell.displayName = 'Cell';

// In-window bars carry the full series colour; out-of-window padding months are drawn in a
// desaturated tint of the SAME hue, so they still read as the same series rather than as a third
// and fourth thing on the chart.
const CASH_GROSS_FILL = '#47C1BF';
const CASH_GROSS_FILL_MUTED = '#A7D9D8';
const CASH_NET_FILL = '#5C6AC4';
const CASH_NET_FILL_MUTED = '#BCC1E4';

const CONV_API = new GrowthIntelConversionApiService();

/**
 * A SYNC INSTANT, to the minute — or null when the response published none.
 *
 * ⚠️ Deliberately NOT `fmtDate`, which every other date on this page uses. A date alone cannot
 * separate a sync that finished four minutes ago from one that finished twenty hours ago, and
 * telling those apart is the entire job of this stamp: the figures above it are current as of the
 * last sync, not as of the page load. The other dates on this page describe the DATA (a churn date
 * is a day); this one describes the RECORD, and an hour matters to it.
 *
 * `null` rather than a fallback string, so the caller decides what to say about an absence instead
 * of this printing an invented one.
 *
 * @param {String|null} iso - `coverage.last_synced_at`.
 * @returns {String|null} The formatted instant, or null when there is nothing to format.
 */
const _fmtSyncStamp = (iso) => {
    if (!iso) {
        return null;
    }
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) {
            return null;
        }
        return d.toLocaleString(undefined, {
            month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
        });
    } catch (e) {
        return null;
    }
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
 * The date a store stopped paying, and — when it matters — WHAT DATED IT.
 *
 * ⚠️ TWO KINDS OF DATE UNDER ONE COLUMN HEADING. `churn_basis: 'partner_event'` is a real
 * cancellation carrying Shopify's own timestamp. `'ledger_window'` means no such event ever reached
 * us, so the date shown is the instant the store's last settled payout aged out of the active window
 * — ALWAYS LATER than the day it actually cancelled, by up to one billing cycle plus payout grace.
 * Printed bare the two are indistinguishable, and the second silently over-states how long the
 * merchant paid. `warnings[]` counts them; this marks the individual rows.
 *
 * Mirrors `RevenueMovementStoresPanel._renderChurnDate` and `ChurnView`'s copy of it deliberately:
 * these lists name the SAME stores, and a caveat shown in one and not the others reads as a
 * difference in the data rather than in the rendering. They are one tab apart now, which makes the
 * disagreement easier to notice and no less wrong.
 *
 * @param {Object} row - a movement row from the `churned` bucket.
 * @returns {React.ReactNode}
 */
const _renderChurnDate = (row) => {
    const shown = fmtDate(row.churn_date);
    if (row.churn_basis !== 'ledger_window') {
        return shown;
    }
    return (
        <PolarisTooltip content="No cancellation event reached us for this store, so this is the day its last settled payout aged out of the active window — always later than the day it actually cancelled.">
            <Text as="span" tone="subdued">{`${shown} (inferred)`}</Text>
        </PolarisTooltip>
    );
};

/**
 * One line of the reconciliation card: what was measured, and by which engine.
 */
const ReconciliationRow = ({ label, value }) => (
    <InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
        <Text as="span" variant="bodyMd" tone="subdued">{label}</Text>
        <Text as="span" variant="bodyMd" fontWeight="semibold" numeric>{value}</Text>
    </InlineStack>
);

/**
 * The Revenue view.
 *
 * @param {Object} props
 * @param {String} props.appId - The selected partner app. No request is issued without one.
 * @param {Boolean} props.appHydrated - True once the app selection has been read from storage.
 * @param {Object} props.dateRange - The PAGE's `useDateRangeState` result, shared by all three tabs.
 * @returns {JSX.Element}
 */
const RevenueView = ({ appId, appHydrated, dateRange }) => {
    /**
     * The DECODED state, not the rows.
     *
     *  THIS IS THE POST-LOGIN LANDING PAGE'S SIBLING, and it used to hold `useState(null)` and test
     * `if (resp && resp.status && resp.data)`. That collapses five materially different answers into
     * one blank screen: a stubbed endpoint, an expired session, an unconfigured upstream, an app
     * nothing has ever synced, and a genuinely empty window all rendered the same nothing — under a
     * title that says "Revenue", which reads as "you have none". `readDataState` keeps them apart and
     * `<DataStateSection>` renders the server's own sentence INSTEAD of the cards, never above them:
     * a banner over a page of zeros loses to the zeros, because the zeros are concrete.
     *
     * `pendingDataState()` rather than `null`: "the first request has not answered yet" is its own
     * state, and it is the one state that must draw neither a banner nor a figure.
     */
    const [overview, setOverview] = useState(pendingDataState());
    const [shopPlanMap, setShopPlanMap] = useState({});
    const [loading, setLoading] = useState(false);
    // Tracked by ID, not index: the tab list is built from what the response actually contains, so an
    // index would point at a different panel the moment one of them has no data.
    const [detailTab, setDetailTab] = useState('plans');
    // Which MRR movement bucket is drilled into, or null. Holds the bucket KEY rather than the rows:
    // the rows are re-derived from the current response below, so a refetch feeds the open panel its
    // newer list instead of leaving a snapshot of the previous one on screen.
    const [movementBucket, setMovementBucket] = useState(null);

    const fetchData = useCallback(() => {
        if (!appId || !appHydrated) return;
        if (!dateRange.hydrated) return;
        setLoading(true);
        setShopPlanMap({});
        //  The WINDOW, not a month count. Collapsing the picked range to `months` threw away WHERE
        // it sits on the timeline, so an April window returned today's MRR over an August chart.
        // `dateRange.params` emits `{ period_days }` or `{ since, until }` and the service resolves
        // both into one `as_of` instant that every point-in-time figure below is measured at.
        CONV_API.getRevenueOverview({ partner_app_id: appId, ...dateRange.params }, (resp) => {
            setLoading(false);
            // A success carrying no `summary` block is NEVER_SYNCED, not READY. Every KPI card below
            // reads `summary.as_of.*` directly, and "$0.00 MRR" in 32-point type is a claim about the
            // operator's business that nobody made — the endpoint sends `summary: null` precisely so
            // this page cannot draw one. Belt and braces beside the payload's own `data_state`.
            const next = readDataState(resp, { isNeverSynced: (d) => !d.summary });
            setOverview(next);

            // Enrich the lifetime ranking with the plan each store is on RIGHT NOW. A second call
            // (a) so the main view never blocks on it and (b) so the plan join lives in its own
            // read rather than widening the overview's own path.
            //
            // ⚠️ `Array.isArray`, not `|| []`. On `/api/revenue/now` — where this method used to
            // point — `top_shops` is an ENVELOPE OBJECT, which is truthy, so `.map` threw on every
            // successful response and took the whole page down with it. The guard is about the shape
            // being right, not about it being present.
            const rows = next.data && Array.isArray(next.data.top_shops) ? next.data.top_shops : [];
            const domains = rows.map((s) => s.shop_domain).filter(Boolean);
            if (domains.length > 0) {
                // ⚠️ A PARAMS OBJECT WITH `partner_app_id`. The endpoint answers 400 without it, and
                // a 400 here is silent: the column simply falls back to the partner-journey plan
                // while the code below claims to be showing the live one.
                CONV_API.getShopPlans({ partner_app_id: appId, shop_domains: domains.slice(0, 200) }, (planResp) => {
                    if (planResp && planResp.status && planResp.data && planResp.data.plans) {
                        setShopPlanMap(planResp.data.plans);
                    }
                });
            }
        });
    }, [appId, appHydrated, dateRange.params, dateRange.hydrated]);

    useEffect(() => { fetchData(); }, [fetchData]);

    /**
     * ⚠️ Close the movement drill-down whenever the QUESTION changes.
     *
     * The panel is named by a bucket key, and that key means something different for every app and
     * every window. Left open across a change it would keep its title and quietly re-render another
     * period's — or another app's — stores underneath it, which reads as data rather than as a stale
     * panel. Closing is the only honest response; the reader can reopen it against the new window.
     *
     * Keyed on `dateRange.params`, the same memoised object `fetchData` depends on, so this cannot
     * fire on a render where the fetch did not.
     */
    useEffect(() => { setMovementBucket(null); }, [appId, dateRange.params]);

    /**
     * The payload, or `null`.
     *
     * `readDataState` nulls `data` in every state except READY, so this is never a stand-in `{}` and
     * every derivation below is dead rather than invented when the endpoint could not answer.
     */
    const data = overview.data;

    /**
     * ⚠️ A NULL GUARD, NOT A VERSION CHECK.
     *
     * `GET /api/revenue/overview` publishes `window` and `summary.as_of` on every READY payload —
     * `summary` is `null` only on the never-synced path, which the fetch above routes to the banner —
     * so in practice this is always true wherever anything is drawn. It stays because every figure
     * below dereferences one of the three, and a contract violation should blank a card rather than
     * throw the page away.
     */
    const summary = (data && data.summary) || null;
    const w = (data && data.window) || null;
    let asOf = null;
    if (summary && summary.as_of) {
        asOf = summary.as_of;
    }
    const measured = !!(w && asOf);

    // `as_of_label` only exists on a windowed payload; the reconciliation card is gated on `as_of`
    // alone (per contract it can in principle arrive without a window), so it needs a safe noun.
    let asOfLabelText = 'the end of the window';
    if (w && w.as_of_label) {
        asOfLabelText = w.as_of_label;
    }

    // ── Trend ────────────────────────────────────────────────────────────────────────────────
    // Fed straight through: `mrr`/`active_subs` may be null (unknown, not zero), and re-mapping the
    // rows here is how a null gets accidentally coerced to 0 on its way to the chart.
    let trendRows = [];
    if (data && Array.isArray(data.monthly_trend)) {
        trendRows = data.monthly_trend;
    }

    // Resolved once per row so the two cash series can never disagree about which months are in the
    // window — and so a row that carries no `in_window` keeps its bar at full colour instead of
    // greying the whole chart.
    const trendFills = trendRows.map((r) => {
        let fills = { gross: CASH_GROSS_FILL, net: CASH_NET_FILL };
        if (measured && !r.in_window) {
            fills = { gross: CASH_GROSS_FILL_MUTED, net: CASH_NET_FILL_MUTED };
        }
        return fills;
    });

    const partialMonths = new Set();
    trendRows.forEach((r) => {
        if (r.is_partial_month) {
            partialMonths.add(r.month);
        }
    });
    // A month whose cash bar covers only part of it is labelled as such on the axis — otherwise the
    // current month always looks like a collapse in revenue.
    const formatMonthTick = (value) => {
        let label = value;
        if (partialMonths.has(value)) {
            label = `${value} (partial)`;
        }
        return label;
    };

    let chartSubtitle = 'Bars: cash Shopify settled that month. Line: MRR at the END of each month.';
    if (measured) {
        chartSubtitle = 'Bars: cash Shopify settled that month. Line: MRR at the END of each month. Shaded months sit outside the selected period and are shown for context.';
    }

    let truncationNote = null;
    if (w && w.trend_truncated) {
        truncationNote = (
            <Text as="p" variant="bodySm" tone="subdued">
                {`Showing the most recent ${w.trend_months} months; earlier history exists but is not plotted.`}
            </Text>
        );
    }

    /**
     * Why the MRR line has a gap in it, in the SERVER's words.
     *
     * ⚠️ A BREAK IN A LINE IS INVISIBLE UNLESS IT IS NAMED. `connectNulls={false}` is what stops the
     * chart drawing through a month nobody measured, but a reader who sees a gap has no way to tell
     * "no MRR that month" from "we could not answer for that month" — and those are opposite facts.
     * Every unmeasurable row carries `measurable: false` and its own `unknown_reason`, which names
     * either the payout coverage floor and the window it needs, or an empty subscription ledger. The
     * first such row speaks for the gap; they share a cause by construction.
     */
    let trendUnknownNote = null;
    const firstUnmeasured = trendRows.find((r) => r.measurable === false && r.unknown_reason);
    if (firstUnmeasured) {
        const gapCount = trendRows.filter((r) => r.measurable === false).length;
        const gapNoun = gapCount === 1 ? 'month' : 'months';
        trendUnknownNote = (
            <Text as="p" variant="bodySm" tone="subdued">
                {`The MRR line breaks over ${gapCount} ${gapNoun}: ${firstUnmeasured.unknown_reason}`}
            </Text>
        );
    }

    // ── KPI cards ────────────────────────────────────────────────────────────────────────────
    //  EVERY CARD STARTS AT `—` AND IS ONLY EVER FILLED FROM A FIGURE THE SERVER SENT. No card
    // seeds from `0`, and none is computed here from two others: a dash is the honest rendering of
    // an absence, and a zero is a measurement. The labels are seeded too, so a card that never gets
    // filled is still legible rather than blank.
    let mrrLabel = 'Current MRR';
    let mrrValue = '—';
    let mrrTone = 'success';
    let mrrHint = 'Recurring run-rate now';
    let subsValue = '—';
    let subsHint = 'Excludes free + test plans';
    let arpuValue = '—';
    let arpuHint = 'MRR ÷ active subs';
    let cashLabel = 'Lifetime net revenue';
    let cashValue = '—';
    let cashHint = '';

    // What the per-plan card is a partition OF. Windowed, that is the as-of set — NOT `current_mrr`,
    // which is measured at now from a different population and would not sum to these rows.
    let planTotalMrr = null;
    let planTotalSubs = null;
    let planAsOfLabel = '';

    // CASH first, and on its own: it is a different population from the run-rate below and shares
    // nothing with it but a row of cards. Lifetime by default; the window-bounded figure replaces it
    // further down when the window is bounded.
    if (summary) {
        cashValue = fmtMoney(summary.lifetime_net);
        cashHint = `${fmtNum(summary.lifetime_tx_count)} transactions • ${fmtMoney(summary.lifetime_shopify_fee)} Shopify fee`;
    }

    if (measured) {
        mrrLabel = 'MRR';
        mrrValue = fmtMoneyOrDash(asOf.mrr);
        subsValue = fmtNumOrDash(asOf.active_subs);
        arpuValue = fmtMoneyOrDash(asOf.arpu);
        planTotalMrr = asOf.mrr;
        planTotalSubs = asOf.active_subs;
        planAsOfLabel = w.as_of_label;

        let runRateHint = 'Recurring run-rate now • from charge records';
        if (w.is_historical) {
            runRateHint = `As of ${w.as_of_label} • from charge records`;
        }
        mrrHint = runRateHint;
        subsHint = runRateHint;
        // ARPU is measured at the same instant as its two inputs, so it carries the same date.
        // Leaving it as a bare formula was the one as-of card that did not say WHEN.
        arpuHint = 'MRR ÷ active subs';
        if (w.is_historical) {
            arpuHint = `MRR ÷ active subs, as of ${w.as_of_label}`;
        }

        //  A `—` never stands unexplained. The hint slot is free exactly when the value is
        // missing, and "unknown" and "zero" are different claims: one is about our records, the
        // other about the business. Say which one this is.
        //
        // ⚠️ THE SERVER'S OWN SENTENCE FIRST. `as_of.unknown_reason` names the active-subscription
        // window in days and the exact coverage floor — "deciding who was paying on a given date
        // needs the 38 days of payout history before it, and the stored history begins at …" — or
        // says the subscription ledger is empty, which is a completely different problem with a
        // completely different fix. The composed sentences below say only THAT it is unknown, and
        // stand in for a response that predates the field.
        let unknownHint = 'No subscription records for this period — unknown, not zero.';
        if (asOf.coverage_start) {
            unknownHint = `No subscription records before ${fmtDate(asOf.coverage_start)} — unknown, not zero.`;
        }
        if (asOf.unknown_reason) {
            unknownHint = asOf.unknown_reason;
        }
        if (asOf.mrr === null || asOf.mrr === undefined) {
            mrrHint = unknownHint;
            // Green is a claim about a number we do not have.
            mrrTone = undefined;
        }
        if (asOf.active_subs === null || asOf.active_subs === undefined) {
            subsHint = unknownHint;
        }
        if (asOf.arpu === null || asOf.arpu === undefined) {
            arpuHint = unknownHint;
        }

        // Cash bounded to the window replaces the lifetime card — except on a lifetime window,
        // where `window_cash` is null precisely because `lifetime_net` already says it.
        if (summary.window_cash) {
            cashLabel = 'Net revenue in period';
            cashValue = fmtMoney(summary.window_cash.net);
            cashHint = `${fmtNum(summary.window_cash.tx_count)} transactions • ${fmtMoney(summary.window_cash.shopify_fee)} Shopify fee`;
        }
    }

    let periodBand = null;
    if (measured) {
        periodBand = (
            <PeriodHeading
                label={w.period_label}
                asOfLabel={w.as_of_label}
                isHistorical={w.is_historical}
            />
        );
    }

    // ── Reconciliation ───────────────────────────────────────────────────────────────────────
    // Two engines answer "what is MRR", from two different populations. Both are on the page, so
    // the gap is something the reader can see and account for rather than discover.
    const reconciliationRows = [];
    if (asOf) {
        //  On a window ending today, `as_of.mrr` and `mrr_now_baseline` are the SAME instant of
        // the SAME engine — printing both is one number under two labels, which reads as a
        // coincidence worth explaining rather than an identity. Show the as-of row only when it
        // genuinely differs.
        let showAsOfRow = false;
        if (w && w.is_historical) {
            showAsOfRow = true;
        }
        if (showAsOfRow) {
            reconciliationRows.push({
                key: 'as_of',
                label: `As of ${asOfLabelText} (charge records)`,
                value: fmtMoneyOrDash(asOf.mrr)
            });
        }
        reconciliationRows.push({
            key: 'now_baseline',
            label: 'Today, charge records',
            value: fmtMoneyOrDash(asOf.mrr_now_baseline)
        });
        // ⚠️ NO "(subscription state)" SUFFIX. It named a second MRR engine, and this build has
        // exactly one — the settled payout ledger — so the parenthetical advertised an independent
        // measurement that does not exist while both rows printed the same number. `notes[]` (which
        // this page renders) explains why the card still carries both rows, and quotes this label
        // verbatim; keep the two in step.
        reconciliationRows.push({
            key: 'published',
            label: 'Today, published figure',
            value: fmtMoney(summary.current_mrr)
        });
        if (summary.ledger_cross_check) {
            reconciliationRows.push({
                key: 'ledger',
                label: 'Today, settled payouts',
                value: fmtMoney(summary.ledger_cross_check.mrr)
            });
        }
    }

    // `window_movement` is null for two DIFFERENT reasons — a lifetime window (no meaningful
    // opening base) and a window ending before our first record. Neither is "you have not picked a
    // range", so the generic empty state is suppressed rather than shown misleadingly.
    //
    // `movement_shops` is the member list behind those same figures, and it is null in exactly the
    // cases `window_movement` is. It is read separately rather than assumed present so a payload
    // from a backend that predates the drill-down still renders the card — just without the click.
    let movementShops = null;
    if (data && data.movement_shops) {
        movementShops = data.movement_shops;
    }

    // The set-level caveats behind the panel's "today" columns: which instants they compare, whether
    // the install replay has anything to say for this app, and how many uninstall events could not
    // be attributed. Read separately and defaulted to null so a payload from a backend that predates
    // the columns simply hides them instead of rendering a table of em dashes.
    let movementSince = null;
    if (data && data.movement_shops_since) {
        movementSince = data.movement_shops_since;
    }

    let movementCard = null;
    if (measured && summary.window_movement) {
        // Handed to the card ONLY when there are lists to open. Without it every block renders as
        // plain text, which is the correct affordance for a card that cannot drill down.
        let onSelectBucket;
        if (movementShops) {
            onSelectBucket = setMovementBucket;
        }
        movementCard = (
            <RevenueMovementStats
                movement={summary.window_movement}
                periodLabel={w.period_label}
                onSelectBucket={onSelectBucket}
            />
        );
    }

    let movementPanelRows = [];
    if (movementShops && movementBucket && Array.isArray(movementShops[movementBucket])) {
        movementPanelRows = movementShops[movementBucket];
    }

    let movementPeriodLabel = '';
    if (w && w.period_label) {
        movementPeriodLabel = w.period_label;
    }

    /**
     * The currency every money figure on this page is LABELLED in — never converted into.
     *
     * ⚠️ A LABEL, AND THE WORDING HAS TO SAY SO. `reporting_currency` names the organisation's
     * Shopify payout currency; nothing in this build converts between currencies, deliberately,
     * because a wrong exchange rate produces a plausible wrong number and those are the ones this
     * project exists to refuse. When paying stores genuinely span several currencies the warning
     * banner directly below says the totals are sums of unlike units — which is why this sentence
     * claims a label rather than a unit.
     *
     * Published on the payload and rendered nowhere until now, which left `moneyFormat.fmtMoney`
     * printing bare digits with no currency anywhere on the screen.
     */
    let reportingCurrency = '';
    if (data && data.reporting_currency) {
        reportingCurrency = data.reporting_currency;
    }

    /**
     * Everything the endpoint approximated, could not see, or had to warn about — in its own words.
     *
     *  THESE REACHED THE WIRE AND STOPPED THERE. This page rendered `notes` (methodology) and
     * NOTHING else, so every sentence that changes how a figure on it should be READ was dropped
     * silently: that an ANNUAL subscriber with no `billing_interval` is booked at TWELVE TIMES its
     * true monthly run-rate, so MRR/ARPU/the plan table all read high; that the paying stores span
     * several currencies and nothing in this build converts between them, so the totals are sums of
     * unlike units; that N stores in the churn list have no cancellation event, so their "Stopped
     * on" date is when their last payout aged out and is always LATER than the real one; that
     * all-time figures are a FLOOR because no lifetime sync has ever completed.
     *
     * Rendered directly beneath the KPI cards, not at the foot of the page: a caveat that changes
     * how a number reads has to be next to the number.
     *
     * `|| []` is safe here in a way it is not on a figure — an empty list renders NOTHING, which
     * withdraws a claim rather than manufacturing one.
     */
    let warnings = [];
    if (data && Array.isArray(data.warnings)) {
        warnings = data.warnings;
    }

    /**
     * "RECURRING RUN-RATE NOW", WITH NOTHING ON THE PAGE SAYING WHEN "NOW" WAS.
     *
     * The first four cards are stated in the present tense over data that is only as current as the
     * last Partner sync. `data.coverage` publishes `last_synced_at` on every READY payload and this
     * page read it ZERO times — so a sync that stopped running three weeks ago and a business that
     * lost three weeks of revenue rendered pixel-for-pixel identically, and the first of those is
     * the one the operator can fix.
     *
     * The By country tab stamps its own figures the same way ("last Partner sync …"); this is that
     * mark, in the one place where the missing freshness is most expensive.
     *
     * ⚠️ NOT a staleness judgement. It prints the instant and lets the reader decide — a threshold
     * ("stale after N hours") would be a number this build has no basis for, and a green "up to
     * date" badge would be a claim about a sync scheduler nothing here can see.
     */
    let freshnessLine = null;
    if (data) {
        const coverage = data.coverage || null;
        const syncedAt = _fmtSyncStamp(coverage && coverage.last_synced_at);
        if (syncedAt) {
            freshnessLine = `Measured from Partner data last synced ${syncedAt}. "Now" above means that instant, not this one.`;
        } else {
            // Should not happen on a READY payload — `data_state` is decided by this very watermark —
            // but a missing stamp is reported as missing rather than silently dropped, which would
            // leave the present-tense cards standing with nothing behind them.
            freshnessLine = 'This response carried no sync time, so how current the figures above are is unknown.';
        }
    }

    // ── Banners ──────────────────────────────────────────────────────────────────────────────
    // `!loading` because `data` is deliberately NOT cleared on a refetch — without the gate, a
    // scope/coverage claim about the PREVIOUS window stays on screen while the new one is in
    // flight, which is the one moment a reader is looking for it to change.
    let scopeBanner = null;
    let coverageBanner = null;
    if (asOf && !loading) {
        if (asOf.scope_tenant_count === 0) {
            scopeBanner = (
                <Banner tone="critical" title="No stores resolved for this app">
                    <p>No stores resolved for this app, so every figure below is unreliable.</p>
                </Banner>
            );
        }
        if (asOf.before_coverage) {
            let coverageSuffix = '';
            if (asOf.coverage_start) {
                coverageSuffix = ` (${fmtDate(asOf.coverage_start)})`;
            }
            coverageBanner = (
                <Banner tone="warning" title="Period predates our records">
                    <p>{`The selected period ends before the first subscription we have on record${coverageSuffix}. Run-rate figures are unknown, not zero.`}</p>
                </Banner>
            );
        }
    }

    // ── Tabs ─────────────────────────────────────────────────────────────────────────────────
    //
    //  AN ARRAY DEFAULT IS NOT A ZERO DEFAULT. `[]` here withdraws a claim — the tab is not built,
    // the table is not drawn, nothing is asserted — whereas `Number(x || 0)` on a figure INVENTS one.
    // That is the whole distinction §4.5 turns on, and it is why these three stay while every
    // numeric coalesce on this page is gone.
    //
    // ⚠️ `Array.isArray`, not a truthiness test. `/api/revenue/now` publishes `top_shops` as an
    // ENVELOPE OBJECT — truthy, so `|| []` passed it straight through, `.length` was `undefined`, and
    // `.map` threw. The guard is about the shape being right, not about the field being present.
    const planRows = data && Array.isArray(data.plans) ? data.plans : [];
    // ⚠️ `data.churned_in_window` is GONE — the same stores now arrive as one bucket of
    // `movement_shops`, derived from the very set the movement card's churn count is reduced from.
    // The tab stays: it is the same list reachable a second way, and it is the one section of this
    // page a reader goes looking for by name.
    const churnedRows = movementShops && Array.isArray(movementShops.churned) ? movementShops.churned : [];
    const topShops = data && Array.isArray(data.top_shops) ? data.top_shops : [];
    const detailTabs = [];
    if (planRows.length > 0) {
        detailTabs.push({ id: 'plans', content: `By plan (${planRows.length})` });
    }
    if (churnedRows.length > 0) {
        detailTabs.push({ id: 'churn', content: `Stopped paying (${churnedRows.length})` });
    }
    if (topShops.length > 0) {
        detailTabs.push({ id: 'shops', content: `Top shops · lifetime (${topShops.length})` });
    }
    // Clamped: switching partner app can empty a tab the user was sitting on, and an index past the
    // end renders a blank card rather than falling back to the tab that does have data.
    let detailIndex = detailTabs.findIndex((t) => t.id === detailTab);
    if (detailIndex < 0) {
        detailIndex = 0;
    }
    let activeDetail = null;
    if (detailTabs.length > 0) {
        activeDetail = detailTabs[detailIndex].id;
    }

    // The lifetime ranking does NOT follow the window and its badges are judged at now, so it says
    // so above the table rather than letting the period band a screen up speak for it.
    //
    // ⚠️ THE BASIS COMES OFF THE PAYLOAD. `top_shops_basis` is published for exactly this sentence,
    // and hardcoding an equivalent one here left two places to keep in step — the day the ranking
    // changes, the caption is the half that silently does not.
    let rankingBasis = 'lifetime cash';
    if (data && data.top_shops_basis) {
        rankingBasis = data.top_shops_basis;
    }
    let topShopsNote = `Ranked by ${rankingBasis}. Plan and status are as of today.`;
    if (measured) {
        topShopsNote = `Ranked by ${rankingBasis}. Plan and status are as of today, not ${w.as_of_label}.`;
    }

    /**
     * Clicking a shop opens the same store detail panel the Stores and Subscriptions lists use.
     *
     * Keyed on `shop_domain`: these rows carry no `tenant_id`, and a store appears at most once in
     * a lifetime-revenue ranking, so the domain is unique here. A row whose domain never resolved
     * is left unclickable rather than offering a click that can only fail — `canOpen` decides.
     *
     * ⚠️ Mounted unconditionally, NOT inside the `activeDetail === 'shops'` branch: hooks cannot be
     * called conditionally, and the panel must survive a tab switch out from under it.
     */
    const shopDrawer = useStoreDetailDrawer({
        rows: topShops,
        appId,
        rowKey: (s2) => s2.shop_domain || s2.shop_id
    });

    return (
        <>
            {scopeBanner}
            {coverageBanner}

            {/*  THE GATE, AND THE POINT OF IT IS THE `else`. Not that the banner is
                informative — that four KPI cards, a movement card, a chart and three tables
                are NOT MOUNTED unless the endpoint actually answered. An explanatory sentence
                above a page of em dashes and a flat $0.00 line loses to the figures, because
                the figures are concrete and the sentence is not.

                `loading` MUST be passed. In PENDING the section renders its children only
                while a request is genuinely in flight — `fetchData` early-returns before
                `setLoading(true)` when no app is selected or the date range has not hydrated,
                and without the prop that permanent PENDING would draw the loading line for
                ever under a page nobody asked for. */}
            <DataStateSection state={overview} loading={loading}>
                {loading || !data ? (
                    <Card><Text as="p">Loading revenue overview…</Text></Card>
                ) : (
                    <BlockStack gap="400">
                        {periodBand}

                        <InlineStack gap="400" wrap>
                            <div style={{ flex: '1 1 220px' }}>
                                <StatCard
                                    label={mrrLabel}
                                    value={mrrValue}
                                    tone={mrrTone}
                                    hint={mrrHint}
                                />
                            </div>
                            <div style={{ flex: '1 1 220px' }}>
                                <StatCard
                                    label="Active paid subs"
                                    value={subsValue}
                                    hint={subsHint}
                                />
                            </div>
                            <div style={{ flex: '1 1 220px' }}>
                                <StatCard
                                    label="ARPU"
                                    value={arpuValue}
                                    hint={arpuHint}
                                />
                            </div>
                            <div style={{ flex: '1 1 220px' }}>
                                <StatCard
                                    label={cashLabel}
                                    value={cashValue}
                                    hint={cashHint}
                                />
                            </div>
                        </InlineStack>

                        {/* THE FRESHNESS MARKER FOR THE FOUR PRESENT-TENSE FIGURES
                            ABOVE IT, and it sits directly beneath them for the same
                            reason the warnings do: a caveat that changes how a number
                            reads has to be next to the number. Without it "Recurring
                            run-rate now" is a claim about this instant made from data
                            of an unstated age, and a stalled sync is indistinguishable
                            from a collapse in revenue. */}
                        {freshnessLine ? (
                            <Text as="p" variant="bodySm" tone="subdued">{freshnessLine}</Text>
                        ) : null}

                        {reportingCurrency ? (
                            <Text as="p" variant="bodySm" tone="subdued">
                                {`Amounts are labelled in ${reportingCurrency}, the payout currency Shopify settles this organisation in. Nothing here converts between currencies.`}
                            </Text>
                        ) : null}

                        {/* ⚠️ THE CAVEATS THAT CHANGE HOW THE FOUR FIGURES ABOVE READ, in the
                            server's own words, directly beneath them. Keyed by the string itself,
                            which is why the service's warning catalogue guarantees each sentence
                            is unique — a duplicate is not drawn twice, it is DROPPED, and its
                            condition goes with it. `notes` (methodology, at the foot of the page)
                            is a different channel: it says how every figure was measured, and it
                            is true on every response. These are true only on this one. */}
                        {warnings.length > 0 ? (
                            <Banner tone="warning" title="Read these figures with this in mind">
                                <BlockStack gap="100">
                                    {warnings.map((warning) => (<p key={warning}>{warning}</p>))}
                                </BlockStack>
                            </Banner>
                        ) : null}

                        {/* Directly under the KPI cards, ABOVE the reconciliation and the chart.
                            The cards state the run-rate at each end of the window; this states how
                            it got from one to the other, so the two read as one thought. Keeping it
                            below the chart made the reader scroll past a six-month strip to find
                            the arithmetic behind the two numbers they had just looked at. */}
                        {movementCard}

                        {reconciliationRows.length > 0 ? (
                            <Card>
                                <BlockStack gap="300">
                                    <Text as="h3" variant="headingMd">Reconciliation</Text>
                                    <Text as="p" variant="bodySm" tone="subdued">
                                        The cards above use charge records, the only source that can be rewound to a
                                        past date: a merchant who has since uninstalled still counts in the months
                                        they were paying, which is the only way the churn on this chart is real.
                                        &quot;Published figure&quot; is the headline this page shows. In THIS build both
                                        rows come from that same settled-payout ledger, so they agree by construction
                                        rather than by coincidence — the card carries both for a deployment that also
                                        runs a live-subscription-state engine, where the gap between them is a
                                        difference in population and not an error.
                                    </Text>
                                    <BlockStack gap="200">
                                        {reconciliationRows.map((r) => (
                                            <ReconciliationRow key={r.key} label={r.label} value={r.value} />
                                        ))}
                                    </BlockStack>
                                </BlockStack>
                            </Card>
                        ) : null}

                        <Card>
                            <BlockStack gap="300">
                                <Text as="h3" variant="headingMd">MRR + cash collected per month</Text>
                                <Text as="span" variant="bodySm" tone="subdued">{chartSubtitle}</Text>
                                {truncationNote}
                                {trendUnknownNote}
                                <div style={{ width: '100%', height: 380 }}>
                                    <ResponsiveContainer>
                                        <ComposedChart data={trendRows} margin={{ top: 20, right: 30, bottom: 20, left: 0 }}>
                                            <CartesianGrid strokeDasharray="3 3" />
                                            <XAxis dataKey="month" tickFormatter={formatMonthTick} />
                                            <YAxis yAxisId="left" tickFormatter={(v) => fmtMoney(v)} />
                                            <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => fmtMoney(v)} />
                                            <Tooltip formatter={(value, name) => [fmtMoney(value), name]} />
                                            <Legend />
                                            {/*  Per-bar `<Cell>`s, NOT a `<ReferenceArea>`. A one-month window
                                                gives the band `x1 === x2`, which recharts renders at zero width —
                                                the exact case that was reported. Cells shade the months
                                                themselves, so a single out-of-window month is still visible. */}
                                            <Bar yAxisId="left" dataKey="gross_cash" name="Gross cash" fill={CASH_GROSS_FILL}>
                                                {trendRows.map((r, i) => (
                                                    <Cell key={`gross-${r.month}-${i}`} fill={trendFills[i].gross} />
                                                ))}
                                            </Bar>
                                            <Bar yAxisId="left" dataKey="net_cash" name="Net cash (after Shopify fee)" fill={CASH_NET_FILL}>
                                                {trendRows.map((r, i) => (
                                                    <Cell key={`net-${r.month}-${i}`} fill={trendFills[i].net} />
                                                ))}
                                            </Bar>
                                            {/*  `connectNulls={false}`: a null `mrr` is a month with no
                                                subscription evidence. Bridging the gap draws a line through
                                                revenue we never measured, so the line breaks instead.
                                                ⚠️ Recharts already defaults this to `false` (3.10.1) — this
                                                comment used to claim its default bridges the gap, which is
                                                untrue. Stated explicitly regardless: a default can change in
                                                a minor release, and `trendUnknownNote` above names the gap
                                                this prop is what creates. */}
                                            <Line
                                                yAxisId="right"
                                                type="monotone"
                                                dataKey="mrr"
                                                name="MRR (end of month)"
                                                stroke="#50B83C"
                                                strokeWidth={2}
                                                dot={{ r: 3 }}
                                                connectNulls={false}
                                            />
                                        </ComposedChart>
                                    </ResponsiveContainer>
                                </div>
                            </BlockStack>
                        </Card>

                        {/* ⚠️ The detail sections are TABS, not a stack. All of them are long — a
                            two-donut panel plus a per-plan table, a churn list, and a 50-row shop
                            table — and stacking them buried the later ones under a page of scrolling.

                            ⚠️ THESE ARE THE VIEW'S OWN TABS, NESTED INSIDE THE PAGE'S THREE. They
                            are a different kind of control and stay in local state deliberately:
                            nothing links to "the plan breakdown of the Revenue tab", and putting a
                            second parameter in the URL would make every share carry a detail
                            selection the sharer never thought about. The page's three views ARE
                            linked to — from the Overview and from two redirects — which is why
                            those live in the query string and these do not.

                             The inactive panel is UNMOUNTED, never CSS-hidden. recharts'
                            ResponsiveContainer measures its parent, and a `display:none` parent
                            measures 0 — the donuts would render collapsed and stay that way until
                            something forced a re-measure.

                            No `fitted` on Tabs: it stretches the strip edge to edge, so the tabs
                            read as giant buttons rather than a tab row. */}
                        {detailTabs.length > 0 ? (
                            <Card padding="0">
                                <Tabs
                                    tabs={detailTabs}
                                    selected={detailIndex}
                                    onSelect={(i) => setDetailTab(detailTabs[i].id)}
                                />
                                {activeDetail === 'plans' ? (
                                    <PlanRevenueBreakdown
                                        plans={planRows}
                                        totalMrr={planTotalMrr}
                                        totalSubs={planTotalSubs}
                                        asOfLabel={planAsOfLabel}
                                        bare
                                    />
                                ) : null}
                                {activeDetail === 'churn' ? (
                                    <>
                                        <div style={{ padding: '12px 16px' }}>
                                            <Text as="p" variant="bodySm" tone="subdued">
                                                Paying at the start of the period, not at the end. Stores that both
                                                started and stopped inside the period are not listed.
                                            </Text>
                                        </div>
                                        <IndexTable
                                            resourceName={{ singular: 'store', plural: 'stores' }}
                                            itemCount={churnedRows.length}
                                            headings={[
                                                { title: 'Shop' },
                                                { title: 'Plan' },
                                                { title: 'Lost MRR' },
                                                { title: 'Stopped on' }
                                            ]}
                                            selectable={false}
                                        >
                                            {churnedRows.map((c, i) => {
                                                // No "reason" column any more. Every row here is a subscription that
                                                // actually ended: the sets being diffed are no longer filtered by the
                                                // payout ledger, so a late-settling store can no longer appear.
                                                return (
                                                    <IndexTable.Row
                                                        id={`churn-${i}`}
                                                        key={`${c.shop_id || c.shop_domain || 'shop'}-${i}`}
                                                        position={i}
                                                    >
                                                        <IndexTable.Cell>
                                                            <Text as="span" variant="bodyMd" fontWeight="semibold">
                                                                {c.shop_domain || c.shop_id}
                                                            </Text>
                                                        </IndexTable.Cell>
                                                        <IndexTable.Cell>{c.plan_name || '—'}</IndexTable.Cell>
                                                        {/* `previous_mrr`, not the retired `lost_mrr`: a churned
                                                            movement row closes the window at zero, so what was
                                                            lost is what it was paying when the window opened. */}
                                                        <IndexTable.Cell>
                                                            <Text as="span" fontWeight="semibold" tone="critical">{fmtMoney(c.previous_mrr)}</Text>
                                                        </IndexTable.Cell>
                                                        {/* ⚠️ THE SAME BASIS CAVEAT THE MOVEMENT PANEL
                                                            PRINTS. This tab and that panel are two views of
                                                            ONE list, so a date qualified in one and bare in
                                                            the other is the page disagreeing with itself.
                                                            `ledger_window` means no cancellation event ever
                                                            reached us and the date shown is when the last
                                                            settled payout aged out — always LATER than the
                                                            day the merchant actually cancelled. */}
                                                        <IndexTable.Cell>{_renderChurnDate(c)}</IndexTable.Cell>
                                                    </IndexTable.Row>
                                                );
                                            })}
                                        </IndexTable>
                                    </>
                                ) : null}
                                {activeDetail === 'shops' ? (
                                    <>
                                        <div style={{ padding: '12px 16px' }}>
                                            <Text as="p" variant="bodySm" tone="subdued">{topShopsNote}</Text>
                                        </div>
                                        <IndexTable
                                            resourceName={{ singular: 'shop', plural: 'shops' }}
                                            itemCount={topShops.length}
                                            headings={[
                                                { title: 'Shop' },
                                                { title: 'Current plan' },
                                                { title: 'Lifetime net' },
                                                { title: 'Lifetime gross' },
                                                { title: 'First payment' },
                                                { title: 'Last payment' },
                                                { title: 'Txn count' }
                                            ]}
                                            selectable={false}
                                        >
                                            {topShops.map((s, i) => {
                                                // Prefer the plan `POST /api/revenue/shop-plans`
                                                // resolved over the one on the ranking row. Both are
                                                // folded from the SAME charge cohort — this build has
                                                // no vendor-owned `store_details` collection and no
                                                // Admin API credential for anybody else's store — but
                                                // the batch read is classified at the instant it ran,
                                                // so it is the fresher of the two.
                                                //
                                                // ⚠️ AN OWN-PROPERTY LOOKUP, not `map[domain]`. The
                                                // key is a domain string straight off the payload,
                                                // and a bare index into a JSON-parsed object finds
                                                // `Object.prototype` members for a handful of them —
                                                // `constructor` returns a FUNCTION, which is truthy,
                                                // carries no `store_active`, and would badge the row
                                                // out of nothing at all.
                                                let livePlan = null;
                                                if (s.shop_domain
                                                    && Object.prototype.hasOwnProperty.call(shopPlanMap, s.shop_domain)) {
                                                    livePlan = shopPlanMap[s.shop_domain];
                                                }
                                                const planLabel = (livePlan && livePlan.plan_title)
                                                    || s.current_plan
                                                    || null;
                                                let planTone;
                                                if (livePlan && livePlan.is_test) {
                                                    planTone = 'warning';
                                                }
                                                const canOpen = shopDrawer.canOpen(s);
                                                let onSelect;
                                                if (canOpen) {
                                                    onSelect = () => shopDrawer.open(s, i);
                                                }
                                                return (
                                                    <IndexTable.Row
                                                        id={String(i)}
                                                        key={s.shop_id + i}
                                                        position={i}
                                                        selected={shopDrawer.isOpen(s, i)}
                                                        onClick={onSelect}
                                                    >
                                                        <IndexTable.Cell>
                                                            <InlineStack gap="100" blockAlign="center">
                                                                <Text as="span" variant="bodyMd" fontWeight="semibold">{s.shop_domain || s.shop_id}</Text>
                                                                {/* The precise subscription state, not a paying/not-paying
                                                                binary. A store on the free plan or still in its trial has
                                                                not churned, and labelling it "Churned" contradicted the
                                                                MRR-by-plan table where the same store counts as active. */}
                                                                {(() => {
                                                                    if (s.is_active_now) {
                                                                        return (
                                                                            <PolarisTooltip content="Currently subscribed and paying">
                                                                                <Badge tone="success">Active</Badge>
                                                                            </PolarisTooltip>
                                                                        );
                                                                    }
                                                                    if (s.subscription_state === 'ON_TRIAL') {
                                                                        return (
                                                                            <PolarisTooltip content="Subscribed to a plan, still inside the free trial">
                                                                                <Badge tone="attention">On trial</Badge>
                                                                            </PolarisTooltip>
                                                                        );
                                                                    }
                                                                    if (s.subscription_state === 'CHURNED_DURING_TRIAL') {
                                                                        return (
                                                                            <PolarisTooltip content="Cancelled before the trial ended — never paid">
                                                                                <Badge tone="warning">Churned in trial</Badge>
                                                                            </PolarisTooltip>
                                                                        );
                                                                    }
                                                                    if (s.subscription_state === 'CHURNED_AFTER_TRIAL') {
                                                                        return (
                                                                            <PolarisTooltip content="Paid, then cancelled">
                                                                                <Badge tone="subdued">Churned</Badge>
                                                                            </PolarisTooltip>
                                                                        );
                                                                    }
                                                                    return (
                                                                        <PolarisTooltip content="No paid subscription — on the free plan or never subscribed. Not the same as having churned.">
                                                                            <Badge tone="subdued">No paid plan</Badge>
                                                                        </PolarisTooltip>
                                                                    );
                                                                })()}
                                                                {s.billing_stale ? (
                                                                    <PolarisTooltip content="Our records show an active plan, but Shopify has not billed this store recently">
                                                                        <Badge tone="warning">Billing stale</Badge>
                                                                    </PolarisTooltip>
                                                                ) : null}
                                                                {/* ⚠️ `=== false`, never a falsy test.
                                                                    The endpoint sends `true` on EVERY row
                                                                    precisely because this build cannot
                                                                    measure install state — its only source
                                                                    is the Partner API, and install state is
                                                                    the Stores page's relationship-event
                                                                    fold. `!undefined` on a row that never
                                                                    arrived would badge a merchant as having
                                                                    removed the app: a specific, checkable
                                                                    claim nothing here supports. */}
                                                                {livePlan && livePlan.store_active === false ? (
                                                                    <PolarisTooltip content="This store no longer has the app installed">
                                                                        <Badge tone="critical">Uninstalled</Badge>
                                                                    </PolarisTooltip>
                                                                ) : null}
                                                            </InlineStack>
                                                        </IndexTable.Cell>
                                                        <IndexTable.Cell>
                                                            {planLabel ? (
                                                                <Badge tone={planTone}>{planLabel}</Badge>
                                                            ) : (
                                                                <Text as="span" tone="subdued">—</Text>
                                                            )}
                                                        </IndexTable.Cell>
                                                        <IndexTable.Cell>
                                                            <Text as="span" fontWeight="semibold" tone="success">{fmtMoney(s.lifetime_net)}</Text>
                                                        </IndexTable.Cell>
                                                        <IndexTable.Cell>{fmtMoney(s.lifetime_gross)}</IndexTable.Cell>
                                                        <IndexTable.Cell>{fmtDate(s.first_tx_at)}</IndexTable.Cell>
                                                        <IndexTable.Cell>{fmtDate(s.last_tx_at)}</IndexTable.Cell>
                                                        <IndexTable.Cell>{fmtNum(s.tx_count)}</IndexTable.Cell>
                                                    </IndexTable.Row>
                                                );
                                            })}
                                        </IndexTable>
                                    </>
                                ) : null}
                            </Card>
                        ) : null}

                        {Array.isArray(data.notes) && data.notes.length > 0 ? (
                            <Banner tone="info" title="Methodology">
                                <ul style={{ paddingLeft: 18, margin: 0 }}>
                                    {data.notes.map((n, i) => <li key={i}>{n}</li>)}
                                </ul>
                            </Banner>
                        ) : null}
                    </BlockStack>
                )}
            </DataStateSection>

            {shopDrawer.drawer}
            {/* Rendered unconditionally — it portals itself out and returns null while `bucket` is
                null, so it costs nothing closed and keeps its exit animation on the way out. */}
            <RevenueMovementStoresPanel
                bucket={movementBucket}
                rows={movementPanelRows}
                since={movementSince}
                periodLabel={movementPeriodLabel}
                appId={appId}
                onClose={() => setMovementBucket(null)}
            />
        </>
    );
};

export default RevenueView;
