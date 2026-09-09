import { Page, Card, BlockStack, InlineStack, Text, Banner, IndexTable, Badge, Tooltip as PolarisTooltip } from '@shopify/polaris';
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
 * date knows which kind it is. Mirrors `RevenueMovementStoresPanel._renderChurnDate` and the copy in
 * `pages/revenue` deliberately: the same three lists name the same shops, and a caveat
 * shown on one and not the others reads as a difference in the data rather than in the rendering.
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
 * A count plotted DOWNWARDS on the movement chart — or `null` when the month was never measured.
 *
 *  `-null` IS `-0` IN JAVASCRIPT, AND `-0` IS A NUMBER. That is the whole reason this exists.
 * `monthly_trend` is legitimately MIXED: it stays an array whenever at least one month is
 * measurable, so a three-week-old deployment asking for twelve months gets eight nulls beside four
 * real months. The service correctly publishes `churned_in_month: null` for a month whose boundaries
 * the stored payout history cannot support — and `churned: -r.churned_in_month` turned every one of
 * them into `-0`, which passes the tooltip's `typeof value === 'number'` test and prints
 * "Churned 0": a measured claim of zero cancellations for a month nobody measured, sitting beside
 * "Gained —" and "Churn rate —" for that same month, which kept their nulls because nothing negated
 * them.
 *
 * Emitting a `0` from the service instead would violate the null-vs-zero rule the entire module is
 * built on, so the fix belongs here, at the coercion.
 *
 * A genuine measured `0` negates to `-0`, which plots identically to `0` and formats as "0" — a real
 * "nobody churned this month" still reads as one.
 *
 * @param {*} count - A count straight off the payload.
 * @returns {Number|null} The negated count, or null when the month carries no measurement.
 */
const _plotDown = (count) => (typeof count === 'number' && Number.isFinite(count) ? -count : null);


/**
 * Narrows the one endpoint's state down to the state of the MONTHLY TREND alone.
 *
 * `summary` and `monthly_trend` are two different measurements that can legitimately arrive
 * apart — `logoChurnService` aggregates the subscription snapshot for the tiles and walks the month
 * buckets for the trend — so a single `isNeverSynced: (d) => !d.summary` gate published the summary
 * and then mounted the titled, axed "Monthly subscriber movement" chart over `chartData = []`. An
 * empty chart under a title is read as a measurement: "we looked at these months and nothing moved".
 * Nobody looked. Rather than widen the endpoint-wide predicate — which would suppress four tiles the
 * backend DID publish whenever the trend is missing — the trend carries its own state and the page
 * can say the summary is here and the trend is not.
 *
 * An empty `monthly_trend` ARRAY is left READY on purpose: that one is a measured empty, the only
 * kind `dataState.js` considers worth drawing, and the chart is then an honest picture of a window
 * with no movement in it.
 *
 * @param {Object} state - The decoded state for the whole logo-churn response.
 * @returns {Object} `state` untouched, or a NEVER_SYNCED state scoped to the trend.
 */
const _trendDataState = (state) => {
    if (!state.ready || Array.isArray(state.data.monthly_trend)) {
        return state;
    }
    // THE SERVICE'S OWN SENTENCE FIRST. `trend_unknown_reason` names the payout coverage floor and
    // the active-subscription window that caused it — "the stored payout history for this app only
    // begins at <date>, so every month boundary in this range falls inside the run-up to it" — which
    // tells the reader what to do about it. The hardcoded fallback below says only THAT the trend is
    // missing, and it stands in for a response that predates the field.
    const reason = (state.data && state.data.trend_unknown_reason)
        || 'This response carried the churn summary but no month-by-month trend, so there is no measured movement to plot.';
    return {
        ...state,
        state: DATA_STATE.NEVER_SYNCED,
        data: null,
        ready: false,
        reason
    };
};

const StatCard = ({ label, value, tone }) => (
    <Card>
        <BlockStack gap="100">
            <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
            <Text as="span" variant="heading2xl" tone={tone}>{value}</Text>
        </BlockStack>
    </Card>
);

const LogoChurnPage = () => {
    const { toastMarkup } = useContext(LoaderContext) || {};
    // The app selection lives in the side nav now — one picker for the whole section.
    const { apps, appId, appsState, appsError, refreshApps, hydrated: appHydrated } = useGrowthIntel();
    const dateRange = useDateRangeState({ storageKey: 'gi.logoChurn.dateRange', defaultValue: { kind: 'preset', preset: 365 } });
    const months = dateRangeToMonths(dateRange.value);
    const [churn, setChurn] = useState(pendingDataState());
    const [loading, setLoading] = useState(false);

    const fetchData = useCallback(() => {
        if (!appId || !appHydrated) return;
        if (!dateRange.hydrated) return;
        setLoading(true);
        CONV_API.getLogoChurn({ partner_app_id: appId, months }, (resp) => {
            setLoading(false);
            // `if (resp.status && resp.data)` used to file the not-implemented envelope, an expired
            // session and a genuinely empty month under one `null`, and the page then drew nothing
            // at all. The decoder keeps them apart so the banner can name which one it is.
            //
            // A success carrying no `summary` block is NEVER_SYNCED rather than READY: the four
            // tiles below read `summary.current_active` and friends directly, and the only other
            // way to render them would be the `|| 0` that IMPLEMENTATION.md §4.5 forbids.
            setChurn(readDataState(resp, { isNeverSynced: (d) => !d.summary }));
        });
    }, [appId, appHydrated, months, dateRange.hydrated]);

    useEffect(() => { fetchData(); }, [fetchData]);

    // The payload, or null. `readDataState` nulls `data` in every state except READY, so this is
    // never a stand-in `{}`: every section below is gated on a decoded state — `churn` for the page,
    // `trendState` for the chart — and nothing is drawn over a figure the backend declined to publish.
    const data = churn.data;

    /**
     * Clicking a churned shop opens the shared store detail panel.
     *
     *  THE DOMAIN, AND ONLY THE DOMAIN. This mapped `tenant_id: r.shop_id`, carried across from the
     * system this page was extracted from, where `logoChurnService` really did build these rows with
     * `shop_id: s.tenant_id`. THIS build has no tenant, user_tenant or users graph at all, so no row
     * anywhere carries a tenant id and `shop_id` on a Partner-API row is a `gid://partners/Shop/…`.
     * Mapped, that gid won `storeRowKey`'s `||`, failed the 24-hex test in
     * `storeDetailRequestParams`, and went through `normaliseShopDomain` — which truncates at the
     * first `/` and yields the literal string `gid:` (verified). `GET /api/stores/detail` then
     * refuses it, so every drawer on this page would have opened onto a critical banner.
     *
     * Dormant until `GET /api/conversion/logo-churn` lands, which is exactly why it is fixed now:
     * the day it lands, nothing about this page will look like the cause.
     *
     * The `|| []` is the one that stays: it feeds a hook, which has to run on every render, and it
     * is never rendered as an answer — the table it steps through is not mounted unless the state
     * is READY.
     */
    const recentChurned = (data && data.recent_churned) || [];
    /**
     * Everything the service approximated, truncated or could not see, in its own words.
     *
     * These reached the wire and stopped there. The coverage floor ("no lifetime Partner sync has
     * completed, so every month below is a floor"), the clamped `months`, the withheld plan table,
     * the truncated churn list, and — the one that changes how a date is read — "N churned shop(s)
     * have no cancellation event on record, so their churn date is when their last settled payout
     * aged out rather than the day they cancelled", which makes those rows' paid duration an
     * over-estimate. A reader quoting a `churned_at` without that sentence quotes it wrong.
     *
     * `|| []` is safe here in a way it is not on a figure: an empty list renders NOTHING, so it
     * withdraws a claim rather than manufacturing one.
     */
    const warnings = (data && Array.isArray(data.warnings)) ? data.warnings : [];
    const shopDrawer = useStoreDetailDrawer({
        rows: recentChurned,
        appId,
        rowKey: (r, i) => `${r.shop_id || r.shop_domain}-${i}`,
        toStoreRow: (r) => ({ shop_domain: r.shop_domain })
    });

    // The trend is gated separately from the tiles. See `_trendDataState`.
    const trendState = _trendDataState(churn);

    const chartData = (data && data.monthly_trend) ? data.monthly_trend.map((r) => ({
        month: r.month,
        gained: r.gained_in_month,
        // Negated through `_plotDown`, NEVER with a bare unary minus — see that helper. An
        // unmeasured month must stay null so its bar is absent rather than drawn at zero.
        churned: _plotDown(r.churned_in_month),
        churn_rate_pct: _ratePct(r.churn_rate),
        active_at_start: r.active_at_start
    })) : [];

    return (
        <SideNavBar>
            <Page
                title="Logo Churn"
                subtitle="Paying customers lost over time. Trial cancellations are tracked separately."
                fullWidth
                backAction={{ content: 'Growth Intelligence', url: DASHBOARD_ROUTES.OVERVIEW }}
                primaryAction={appId ? <DateRangeFilter value={dateRange.value} onChange={dateRange.set} /> : null}
            >
                <BlockStack gap="400">
                    {/* AN EMPTY ROSTER IS THREE DIFFERENT ANSWERS, AND ONLY ONE OF THEM IS
                        ABOUT THE OPERATOR. This read `appHydrated && !appsLoading && apps.length
                        === 0`, which is also true after a 500, after a dropped connection and
                        after an expired session — so "No partner apps yet" was published as a
                        measured fact about the account whenever the roster request failed, on
                        every page in this section at once. `appsState` is the discriminator:
                        READY means the list was measured and is genuinely empty, ERROR means we
                        could not ask, and UNAUTHENTICATED draws NOTHING because the redirect to
                        /login is already under way and a critical banner mid-navigation reads as
                        a broken backend. PENDING draws nothing either — it is the first tick. */}
                    {appsState === APPS_STATE.READY && apps.length === 0 ? (
                        <Banner tone="info" title="No partner apps yet"><p>Add a partner app first.</p></Banner>
                    ) : null}

                    {/* The roster is the one request nothing on this page can route around: with
                        no app list there is no `appId`, so the section below never fires. Nothing
                        retries on a timer (the provider says why), so the way out is offered here. */}
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
                        <Card><Text as="p">Loading logo churn data…</Text></Card>
                    ) : appId ? (
                        /* One endpoint, so one section. The gate is the STATE, not the payload:
                           with `appId && data` a refused call rendered literally nothing under the
                           page title, which reads as a broken build rather than as an answer. */
                        <DataStateSection state={churn} loading={loading}>
                            {/* `loading` is what stops PENDING from drawing. This page early-returns
                                from `fetchData` when no app is selected without ever setting `loading`,
                                so PENDING is not always "the answer is coming" — it is sometimes "no
                                request was ever made", and only the first of those may mount a child.
                                Passing the page's own flag lets the section tell them apart. (The
                                branch above already swallows the in-flight case today; this stays
                                correct if that ternary is ever restructured.)

                                The payload is still checked once more below, because a PENDING child
                                paints before the request has answered and `data` is null until it does. */}
                            {data ? (
                                <BlockStack gap="400">
                                    <InlineStack gap="400" wrap>
                                        <div style={{ flex: '1 1 220px' }}><StatCard label="Currently active" value={_fmtNum(data.summary.current_active)} /></div>
                                        <div style={{ flex: '1 1 220px' }}><StatCard label="Churned (last 30 days)" value={_fmtNum(data.summary.churned_in_30d)} tone="critical" /></div>
                                        <div style={{ flex: '1 1 220px' }}><StatCard label="Churn rate (30d)" value={_fmtPct(data.summary.churn_rate_30d)} tone={data.summary.churn_rate_30d > 0.05 ? 'critical' : undefined} /></div>
                                        <div style={{ flex: '1 1 220px' }}><StatCard label="Churned (last 90 days)" value={_fmtNum(data.summary.churned_in_90d)} /></div>
                                    </InlineStack>

                                    {/* The trend has its OWN gate. `summary` and `monthly_trend` are separate
                                        measurements, so the page publishes the four tiles above and says
                                        plainly that the trend is unavailable, rather than mounting a titled,
                                        axed chart over an empty array — which reads as "we measured these
                                        months and nothing moved". See `_trendDataState`. */}
                                    <DataStateSection state={trendState} title="Monthly subscriber movement" loading={loading}>
                                        <Card>
                                            <BlockStack gap="300">
                                                <Text as="h3" variant="headingMd">Monthly subscriber movement</Text>
                                                <Text as="span" variant="bodySm" tone="subdued">Green = new paying customers, red = churned, line = churn rate %</Text>
                                                <div style={{ width: '100%', height: 360 }}>
                                                    <ResponsiveContainer>
                                                        <ComposedChart data={chartData} margin={{ top: 20, right: 30, bottom: 20, left: 0 }}>
                                                            <CartesianGrid strokeDasharray="3 3" />
                                                            <XAxis dataKey="month" />
                                                            <YAxis yAxisId="left" />
                                                            <YAxis yAxisId="right" orientation="right" tickFormatter={(v) => `${v.toFixed(1)}%`} />
                                                            <Tooltip
                                                                formatter={(value, name) => {
                                                                    // ⚠️ MATCH ON THE SERIES `name` AS WELL AS THE dataKey. recharts'
                                                                    // `getTooltipNameProp` passes `props.name` when a series has one and
                                                                    // falls back to the dataKey only when it does not — every series here
                                                                    // is named, so the three dataKey comparisons alone matched NOTHING and
                                                                    // every row fell through to `[value, name]`: a raw negative integer
                                                                    // under "Churned" and an unrounded 4.166666666666666 under
                                                                    // "Churn rate %". Same trap the trial-funnel chart already documents.
                                                                    if (name === 'Churn rate %' || name === 'churn_rate_pct') {
                                                                        // `Number(null).toFixed(2)` is "0.00" — the manufactured zero in the
                                                                        // one place the reader hovered to read it exactly.
                                                                        return [typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : '—', 'Churn rate'];
                                                                    }
                                                                    if (name === 'Gained' || name === 'gained') return [_fmtNum(value), 'Gained'];
                                                                    if (name === 'Churned' || name === 'churned') {
                                                                        // ⚠️ `Math.abs(null)` is `0`. Unguarded, it reinstates the exact
                                                                        // manufactured zero `_plotDown` was written to remove, one layer
                                                                        // further down. Flip the sign only once there is a sign to flip.
                                                                        return [_fmtNum(typeof value === 'number' && Number.isFinite(value) ? Math.abs(value) : value), 'Churned'];
                                                                    }
                                                                    return [value, name];
                                                                }}
                                                            />
                                                            <Legend />
                                                            <Bar yAxisId="left" dataKey="gained" name="Gained" fill="#50B83C" />
                                                            <Bar yAxisId="left" dataKey="churned" name="Churned" fill="#DE3618" />
                                                            <Line yAxisId="right" type="monotone" dataKey="churn_rate_pct" name="Churn rate %" stroke="#5C6AC4" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
                                                        </ComposedChart>
                                                    </ResponsiveContainer>
                                                </div>
                                            </BlockStack>
                                        </Card>
                                    </DataStateSection>

                                    {Array.isArray(data.by_plan) && data.by_plan.length > 0 ? (
                                        <Card padding="0">
                                            <div style={{ padding: '12px 16px' }}>
                                                <Text as="h3" variant="headingMd">Churn by plan (last 30 days)</Text>
                                            </div>
                                            <IndexTable
                                                resourceName={{ singular: 'plan', plural: 'plans' }}
                                                itemCount={data.by_plan.length}
                                                headings={[
                                                    { title: 'Plan' },
                                                    { title: 'Active now' },
                                                    { title: 'Active 30d ago' },
                                                    { title: 'Churned 30d' },
                                                    { title: 'Churn rate' }
                                                ]}
                                                selectable={false}
                                            >
                                                {data.by_plan.map((p, i) => (
                                                    <IndexTable.Row id={String(i)} key={p.plan_name + i} position={i}>
                                                        <IndexTable.Cell>{p.plan_name}</IndexTable.Cell>
                                                        <IndexTable.Cell>{_fmtNum(p.active_now)}</IndexTable.Cell>
                                                        <IndexTable.Cell>{_fmtNum(p.active_30d_ago)}</IndexTable.Cell>
                                                        <IndexTable.Cell>{_fmtNum(p.churned_in_30d)}</IndexTable.Cell>
                                                        <IndexTable.Cell>
                                                            <Text as="span" tone={p.churn_30d_pct > 0.1 ? 'critical' : 'subdued'}>{_fmtPct(p.churn_30d_pct)}</Text>
                                                        </IndexTable.Cell>
                                                    </IndexTable.Row>
                                                ))}
                                            </IndexTable>
                                        </Card>
                                    ) : null}

                                    {warnings.length > 0 ? (
                                        <Banner tone="warning">
                                            <BlockStack gap="100">
                                                {/* KEYED BY THE STRING, which is why the service's own catalogue
                                                    guarantees every sentence is unique — a duplicate is not drawn
                                                    twice, it is DROPPED along with its condition. */}
                                                {warnings.map((w) => (<p key={w}>{w}</p>))}
                                            </BlockStack>
                                        </Banner>
                                    ) : null}

                                    {Array.isArray(data.recent_churned) && data.recent_churned.length > 0 ? (
                                        <Card padding="0">
                                            <div style={{ padding: '12px 16px' }}>
                                                <Text as="h3" variant="headingMd">{`Recently churned (last 30 days — ${_fmtNum(data.recent_churned.length)} shops)`}</Text>
                                            </div>
                                            <IndexTable
                                                resourceName={{ singular: 'shop', plural: 'shops' }}
                                                itemCount={data.recent_churned.length}
                                                headings={[
                                                    { title: 'Shop' },
                                                    { title: 'Plan' },
                                                    { title: 'Activated on' },
                                                    { title: 'Churned on' },
                                                    { title: 'Paid duration' }
                                                ]}
                                                selectable={false}
                                            >
                                                {data.recent_churned.map((r, i) => {
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
                                                            <Text as="span" variant="bodyMd" fontWeight="semibold">{r.shop_domain || r.shop_id}</Text>
                                                        </IndexTable.Cell>
                                                        <IndexTable.Cell><Badge>{r.plan_name}</Badge></IndexTable.Cell>
                                                        <IndexTable.Cell>{_fmtDate(r.activated_at)}</IndexTable.Cell>
                                                        <IndexTable.Cell>{_renderChurnDate(r)}</IndexTable.Cell>
                                                        <IndexTable.Cell>{`${r.paid_days} days`}</IndexTable.Cell>
                                                    </IndexTable.Row>
                                                    );
                                                })}
                                            </IndexTable>
                                        </Card>
                                    ) : null}
                                </BlockStack>
                            ) : null}
                        </DataStateSection>
                    ) : null}
                </BlockStack>
            </Page>
            {shopDrawer.drawer}
            {toastMarkup}
        </SideNavBar>
    );
};

export default LogoChurnPage;
