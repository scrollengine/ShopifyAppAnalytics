import { Page, Card, BlockStack, Divider, InlineGrid, Text, Banner, Tabs } from '@shopify/polaris';
import { useCallback, useContext, useEffect, useState } from 'react';
import SideNavBar from '../../components/sideNavBar';
import LoaderContext from '../../contexts/loaderContext';
import { APPS_STATE, useGrowthIntel } from '../../contexts/growthIntelContext';
import GrowthIntelFunnelApiService from '../../API_Services/growth-intel/funnelService';
import TrafficSourceTable from '../../components/growth-intel/TrafficSourceTable';
import GeoBreakdownTable from '../../components/growth-intel/GeoBreakdownTable';
import AttributionPieChart from '../../components/growth-intel/AttributionPieChart';
import DateRangeFilter, { useDateRangeState } from '../../components/growth-intel/DateRangeFilter';
import DataStateSection from '../../components/growth-intel/DataStateSection';
import { DATA_STATE, pendingDataState, readDataState } from '../../components/growth-intel/dataState';
import { DASHBOARD_ROUTES } from '../../utils/dashboardRoutes';

const FUNNEL_API = new GrowthIntelFunnelApiService();

// THERE IS NO "WORST STATE" FOLD HERE ANY MORE, AND THERE MUST NOT BE ONE AGAIN.
//
// This page makes two calls — /funnel/traffic-source and /funnel/geo — and it used to rank their two
// decoded states (ERROR 4 > NOT_IMPLEMENTED 3 > NOT_CONNECTED 2 > NEVER_SYNCED 1) to pick a single
// winner for a single page-level banner. Every ranking of that shape throws a message away, and this
// one threw away the message worth the most:
//
//   • NOT_CONNECTED ranked BELOW ERROR and NOT_IMPLEMENTED, so whenever the two endpoints disagreed
//     the half discarded was the only one naming the environment variable that is unset — the one
//     string on this page an operator can act on. `dataState.js` calls it "the single most valuable
//     sentence the API ever emits and the easiest to discard". The fold discarded it.
//   • Reversing the order does not fix that, it only reverses whose sentence is lost: promote
//     NOT_CONNECTED and a real ERROR on the other endpoint hides behind "set this variable", sending
//     the operator into `.env` over a stack trace. Both directions are silent, and silence is the
//     failure.
//   • READY ranked 0, so a healthy endpoint was suppressed by its neighbour's failure: a 500 on
//     /funnel/geo replaced a perfectly good channel breakdown with a banner about geography.
//
// No precedence is right, because the premise is wrong. The two states are not two opinions about
// one thing: `sources` fills the Channel tab, `geo` fills the Geography tab, they are separate reads
// of separate rollups, and each tab shows exactly one of them. So each tab now carries its OWN
// <DataStateSection>, and each endpoint's own sentence is rendered in the place its own data would
// have occupied. Nothing is folded, nothing is outranked, and no banner speaks for a request it did
// not come from.

// One chart per metric rather than one chart with a toggle. The `key` must match the field name on
// the /funnel/traffic-source and /funnel/geo rows — a typo here renders an empty donut, not an error.
const TRAFFIC_METRICS = [
    { key: 'installs', label: 'Installs', title: 'Installs by source', subtitle: 'Where installs actually came from' },
    { key: 'install_clicks', label: 'Install clicks', title: 'Install clicks by source', subtitle: 'Intent — clicked Add app' },
    { key: 'views', label: 'Views', title: 'Views by source', subtitle: 'Reach — listing page views' }
];

const GEO_METRICS = [
    { key: 'installs', label: 'Installs', title: 'Installs by country', subtitle: 'Where installs came from' },
    { key: 'views', label: 'Views', title: 'Views by country', subtitle: 'Listing reach by country' }
];

// Channel and geography answer different questions — "which channel should we invest in" versus
// "which market is converting" — and they were competing for one screen. Tabbed rather than stacked
// so each gets the full width, which the 6-column source table needs anyway.
const TABS = [
    { id: 'channel', content: 'Channel' },
    { id: 'geography', content: 'Geography' }
];

/**
 * Three (or two) donuts as ONE continuous strip inside the parent card.
 *
 * `gap="0"` plus a left border on every cell after the first: whitespace between cards reads as
 * "separate things", a hairline reads as "one thing, divided". The border is dropped at the small
 * breakpoint where the grid collapses to a single column, or it would appear as a stray line down
 * the left edge of each stacked chart.
 *
 * @param {Object} props
 * @param {Array<Object>} props.metrics - One `{ key, label, title, subtitle }` per donut.
 * @param {Array<Object>} props.items - THE ROWS, never the decoded state object that carries them.
 *   `AttributionPieChart` guards this prop with `!Array.isArray(items)` and then draws its own
 *   "No installs in this period." — so handing it an envelope produced five empty donuts above a
 *   table full of real rows, on a page whose data was perfectly healthy.
 * @param {String} props.labelKey - Row field the slices are named by ('traffic_source' | 'country').
 * @returns {React.ReactNode}
 */
const ChartStrip = ({ metrics, items, labelKey }) => (
    <InlineGrid columns={{ xs: 1, sm: 1, md: metrics.length }} gap="0">
        {metrics.map((m, i) => (
            <div
                key={m.key}
                style={i === 0 ? undefined : { borderLeft: '1px solid var(--p-color-border-secondary)' }}
            >
                <AttributionPieChart
                    items={items}
                    labelKey={labelKey}
                    title={m.title}
                    subtitle={m.subtitle}
                    topN={8}
                    metrics={[m]}
                    bare
                />
            </div>
        ))}
    </InlineGrid>
);

/**
 * Where installs come from — traffic source/medium attribution and the country
 * breakdown, both from the GA4 listing rollups.
 *
 * Split out of the Funnel page: attribution answers "which channel should we
 * invest in", which is a different question from "where do people drop out of
 * the funnel", and the two were competing for the same screen. The funnel page
 * keeps the drop-off chain; this page owns the breakdowns.
 */
const TrafficSourcesPage = () => {
    const { toastMarkup } = useContext(LoaderContext) || {};
    // The app selection lives in the side nav now — one picker for the whole section.
    const { apps, appId, appsState, appsError, refreshApps, hydrated: appHydrated } = useGrowthIntel();
    const dateRange = useDateRangeState({ storageKey: 'gi.trafficSources.dateRange' });

    const [tabIndex, setTabIndex] = useState(0);

    // Both tabs are fetched together rather than lazily on tab open. There are only two requests and
    // both are small rollup reads, so paying them up front is cheaper than putting a spinner in front
    // of every tab switch — and switching back and forth to compare channel against geography is the
    // main reason to have tabs at all.
    // The DECODED STATE, not just the rows. The backend distinguishes states that look identical
    // once flattened to an array — not connected / connected but never synced / genuinely no traffic —
    // and only the first two carry an explanation the operator needs. Reducing this to `items || []`
    // discarded the sentence naming the missing environment variable and rendered "no traffic in this
    // window", which is a claim about the merchant's listing rather than about our own configuration.
    //
    // This page used to decode that envelope with a local helper of its own, which is the helper
    // `readDataState` was generalised from. Two decoders for one wire contract is one decoder more
    // than the contract has, and the spare one drifts — so the shared one is the only one now.
    // `pendingDataState()` rather than `null`: "the request has not answered yet" is its own state,
    // and it is the one state that must draw neither a banner nor a chart.
    const [sources, setSources] = useState(pendingDataState());
    const [geo, setGeo] = useState(pendingDataState());
    const [loading, setLoading] = useState(false);

    const fetchBreakdowns = useCallback(() => {
        if (!appId || !appHydrated) return;
        if (!dateRange.hydrated) return;
        setLoading(true);
        let inflight = 2;
        const done = () => { inflight -= 1; if (inflight === 0) setLoading(false); };

        FUNNEL_API.getTrafficSource({ partner_app_id: appId, ...dateRange.params, limit: 100 }, (resp) => {
            setSources(readDataState(resp));
            done();
        });
        FUNNEL_API.getGeo({ partner_app_id: appId, ...dateRange.params, limit: 100 }, (resp) => {
            setGeo(readDataState(resp));
            done();
        });
    }, [appId, appHydrated, dateRange.params, dateRange.hydrated]);

    useEffect(() => { fetchBreakdowns(); }, [fetchBreakdowns]);

    // Nothing has answered yet on the first paint, and nothing current has answered during a refetch.
    // Both cases must show the loading line rather than the charts: this page's children have no
    // skeleton of their own, so left alone they would draw empty donuts and an empty table — a
    // measured "no traffic" that nobody measured.
    //
    // The PENDING terms are only safe because this is now evaluated INSIDE the gate's children.
    // PENDING without `loading` means no request was ever made — `fetchBreakdowns` early-returns
    // before `setLoading(true)` when the app or the date range has not hydrated — and in that case
    // `<DataStateSection>` renders nothing at all, rather than letting this line stand on the screen
    // promising an answer that nobody asked for.
    const awaitingAnswer = loading
        || sources.state === DATA_STATE.PENDING
        || geo.state === DATA_STATE.PENDING;

    // THE ROWS, NOT THE STATE OBJECT. `AttributionPieChart` and both tables guard their `items`
    // prop with `!Array.isArray(items)` and then quietly render their own empty state, so handing
    // them the envelope drew "No installs in this period." across all five donuts of a healthy READY
    // page whose tables two inches below were listing real rows. It reported the shape of a variable
    // as a fact about the merchant's acquisition.
    // `state.data` is null in every state but READY, and READY carries `items` as an array (the
    // backend sends null only alongside NEVER_SYNCED) — so `[]` here is only ever reached in a state
    // whose section is not drawn at all, or on a window the backend really did measure as empty.
    let sourceItems = [];
    let geoItems = [];
    if (sources.data && Array.isArray(sources.data.items)) {
        sourceItems = sources.data.items;
    }
    if (geo.data && Array.isArray(geo.data.items)) {
        geoItems = geo.data.items;
    }

    // Declared once and rendered inside each tab's gate rather than above both of them, so the gate
    // still owns the decision about whether anything is drawn at all. Hoisting it above the gates
    // would put a permanent "Loading…" on the screen in the PENDING-with-no-request case.
    const loadingLine = (
        <div style={{ padding: 'var(--p-space-400)' }}>
            <Text as="p" tone="subdued">Loading traffic breakdowns…</Text>
        </div>
    );

    return (
        <SideNavBar>
            <Page
                title="Traffic Sources"
                subtitle="Where your installs come from — channel attribution and country breakdown, from the GA4 listing rollups."
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
                        <Banner tone="info" title="No partner apps yet">
                            <p>Add a partner app first, then come back here to see where its installs come from.</p>
                        </Banner>
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

                    {/* ONE card for tabs + charts + table. Previously each was its own card with a
                        gap between, which read as four unrelated panels stacked up rather than one
                        view of one thing — and the gaps ate vertical space on a page that is already
                        tall. The charts sit in a zero-gap grid separated by borders instead of
                        whitespace, so the three donuts read as one strip.

                        The state gate now sits INSIDE the card, one per tab, over the contents each
                        endpoint fills. The tab strip stays outside it: a tab strip is navigation and
                        asserts no figure, and keeping it mounted is what lets an operator whose
                        Channel data is unreachable still reach a Geography tab that is fine. Every
                        element that DOES assert a figure — both donut strips, both tables — is
                        mounted only on the READY path. `bare` because the Card is ours, and the
                        default `padWhenBare` gives the banner back the edge space `padding="0"`
                        takes away. */}
                    {appId ? (
                        <Card padding="0">
                            <Tabs tabs={TABS} selected={tabIndex} onSelect={setTabIndex} />

                            {/* The banner IS the feature. Without it every state renders the same
                                empty table under the sentence "No source data in this window yet." —
                                a statement about the merchant's listing, and false in all of them
                                but one. Each gate below reports the ONE endpoint that fills its tab
                                (the note at the top of this file says why the two are no longer
                                folded into a single verdict), and draws that endpoint's own sentence
                                INSTEAD of the tab's contents — an explanatory banner sitting above
                                an empty chart loses to the chart, because the zeros are concrete and
                                the sentence is not. */}

                            {/* One chart per metric, no toggle. A single donut used to carry a
                                three-way metric toggle, so comparing installs against install-clicks
                                against views meant clicking through and holding the last number in
                                your head. The comparison IS the insight — a source with heavy views
                                and no installs is a different problem from one with no views at
                                all. */}
                            {tabIndex === 0 ? (
                                <DataStateSection state={sources} loading={loading} bare>
                                    {awaitingAnswer ? loadingLine : (
                                        <>
                                            <ChartStrip metrics={TRAFFIC_METRICS} items={sourceItems} labelKey="traffic_source" />
                                            <Divider />
                                            <TrafficSourceTable items={sourceItems} title="Traffic sources" bare />
                                        </>
                                    )}
                                </DataStateSection>
                            ) : null}

                            {tabIndex === 1 ? (
                                <DataStateSection state={geo} loading={loading} bare>
                                    {awaitingAnswer ? loadingLine : (
                                        <>
                                            <ChartStrip metrics={GEO_METRICS} items={geoItems} labelKey="country" />
                                            <Divider />
                                            <GeoBreakdownTable items={geoItems} title="Geographic breakdown" bare />
                                        </>
                                    )}
                                </DataStateSection>
                            ) : null}
                        </Card>
                    ) : null}
                </BlockStack>
            </Page>
            {toastMarkup}
        </SideNavBar>
    );
};

export default TrafficSourcesPage;
