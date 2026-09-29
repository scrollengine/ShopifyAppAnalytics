import { Page, Card, BlockStack, Box, InlineGrid, Text, Banner, Tabs, Divider } from '@shopify/polaris';
import { useCallback, useContext, useEffect, useState } from 'react';
import SideNavBar from '../../components/sideNavBar';
import LoaderContext from '../../contexts/loaderContext';
import { APPS_STATE, useGrowthIntel } from '../../contexts/growthIntelContext';
import GrowthIntelFunnelApiService from '../../API_Services/growth-intel/funnelService';
import GrowthIntelConversionApiService from '../../API_Services/growth-intel/conversionService';
import FunnelStats from '../../components/growth-intel/FunnelStats';
import DailyFunnelChart from '../../components/growth-intel/DailyFunnelChart';
import InstallCohortTable from '../../components/growth-intel/InstallCohortTable';
import DateRangeFilter, { useDateRangeState } from '../../components/growth-intel/DateRangeFilter';
import ConversionFunnelChart from '../../components/growth-intel/conversion/ConversionFunnelChart';
import PartnerFunnelChart from '../../components/growth-intel/PartnerFunnelChart';
import TrialOutcomeBar from '../../components/growth-intel/conversion/TrialOutcomeBar';
import CohortRetentionHeatmap from '../../components/growth-intel/conversion/CohortRetentionHeatmap';
import TimeToPaidHistogram from '../../components/growth-intel/conversion/TimeToPaidHistogram';
import PlanMixDonut from '../../components/growth-intel/conversion/PlanMixDonut';
import DataStateSection from '../../components/growth-intel/DataStateSection';
import { DATA_STATE, pendingDataState, readDataState } from '../../components/growth-intel/dataState';
import { DASHBOARD_ROUTES } from '../../utils/dashboardRoutes';
import { permissionLabel } from '../../utils/permissions';

const FUNNEL_API = new GrowthIntelFunnelApiService();
const CONV_API = new GrowthIntelConversionApiService();

const FUNNEL_EVENTS_STORAGE_KEY = 'gi.funnel.stepEvents';

/**
 * Used only if the server sent no sentence of its own — `unknown_reason` is the better one, because
 * it names the two things that actually fix this (widen the range, or extend the sync window).
 */
const EMPTY_WINDOW_FALLBACK =
    'The listing rollup holds no rows for these dates, so this window has no funnel to report. '
    + 'A sync has run — this is not a reading of zero traffic.';

/**
 * True for the ONE `/api/funnel` payload that means "we looked, and these days are not in the
 * rollup": `data_state: 'READY'` (the watermark is set, so a sync HAS completed), `summary: null`,
 * `trend: []`, and `unknown_reason` carrying the backend's EMPTY_WINDOW sentence.
 *
 * IT IS NOT NEVER_SYNCED, AND CONFLATING THEM SHIPPED A SELF-CONTRADICTING BANNER. This page
 * used to hand the decoder `isNeverSynced: (d) => !d.summary`, which swallowed this payload whole
 * and drew, in order: the heading "No listing-analytics sync has run yet", then the server's own
 * "A sync has run — this is not a reading of zero traffic", then the page's "run a sync from the
 * Sync page". Three sentences, two of them false, and the decoder had already nulled `funnel.data`
 * so the "Last BigQuery sync: <timestamp>" line — the one piece of evidence contradicting the
 * heading — was gone from the screen as well. `bigQuery.constants.ts` gives EMPTY_WINDOW_REASON its
 * own paragraph explaining that telling an operator to run a sync they have already run is how
 * they learn the banner is noise; this predicate is what makes that paragraph true on the page.
 *
 * AND THE OPPOSITE RELAXATION IS ALSO WRONG. Simply dropping the `isNeverSynced` hook decodes
 * this payload READY, mounts `FunnelStats` over `summary: null` and prints eight em-dash tiles
 * under a period label — "we measured nothing about this listing" — which is the regression this
 * page's own header documents. The payload is READY *and* undrawable, and both halves matter: the
 * ENVELOPE is a measured answer (window, watermark, the reason) while the BODY is null. So the
 * decode stays READY, the tiles and the chart are gated on the body, and the reason is rendered.
 *
 * Pinned on the backend by `test/listingRates.test.js` (" an empty window publishes summary: null"),
 * which asserts `data_state === 'READY'` and `unknown_reason !== NEVER_SYNCED_REASON` — the two
 * facts this predicate reads. If that test is ever relaxed, this branch stops firing.
 *
 * @param {Object|null} d - The decoded `/api/funnel` payload.
 * @returns {Boolean} True for a synced app whose window matched no rollup row.
 */
const _isEmptyWindow = (d) => Boolean(d) && d.data_state === DATA_STATE.READY && d.summary === null;

/**
 * The server's own caveats about a payload, rendered under the chart they belong to.
 *
 *  WITHOUT THIS THE HONESTY IS ON THE WIRE AND NOWHERE ELSE. Every conversion read publishes
 * `warnings[]`, and several of them change how a figure READS rather than whether it exists: a
 * listing tier that is cold makes the funnel's top four stages `null`, which the chart draws as
 * minimum-width bars with em-dash labels and NO sentence saying why; a cohort clamped to fewer weeks
 * than were asked for; a coverage boundary that makes an "all time" total a floor. The components
 * take no `warnings` prop and must not grow one here — they are shared — so the page renders them,
 * which is where `revenue/index.js` and the churn pages already put theirs.
 *
 * Rendered ONLY for a READY state: `state.data` is null in every other one, and the banner that
 * replaces the chart carries the reason for those.
 *
 * ⚠️ Keyed by the STRING. Every service in this backend de-duplicates its warnings for exactly this
 * reason — two identical strings would collide as React keys and one would be silently DROPPED,
 * taking its condition with it.
 *
 * @param {Object} props
 * @param {Object} props.state - A `readDataState()` result.
 * @returns {JSX.Element|null} One line per warning, or nothing.
 */
const PayloadWarnings = ({ state }) => {
    if (!state || !state.ready || !state.data || !Array.isArray(state.data.warnings)) {
        return null;
    }
    if (state.data.warnings.length === 0) {
        return null;
    }
    return (
        <Box paddingInlineStart="400" paddingInlineEnd="400" paddingBlockEnd="300">
            <BlockStack gap="100">
                {state.data.warnings.map((warning) => (
                    <Text key={warning} as="p" variant="bodySm" tone="subdued">{warning}</Text>
                ))}
            </BlockStack>
        </Box>
    );
};

const FunnelPage = () => {
    const { toastMarkup } = useContext(LoaderContext) || {};
    // The app selection lives in the side nav now — one picker for the whole section.
    const { apps, appId, appsState, appsError, refreshApps, hydrated: appHydrated } = useGrowthIntel();
    const dateRange = useDateRangeState({ storageKey: 'gi.funnel.dateRange' });
    const [tabIndex, setTabIndex] = useState(0);

    // Acquisition tab data. Traffic-source and geo breakdowns moved to
    // /traffic-sources — this page owns the drop-off chain only.
    /**
     * The DECODED /api/funnel envelope, never the raw payload.
     *
     * On `data_state: 'NEVER_SYNCED'` that endpoint answers HTTP 200 / status:true with
     * `summary: null` and `trend: null`. The old `if (resp && resp.status && resp.data)` stored that
     * truthy-but-empty object, so neither banner below fired and `FunnelStats` printed eight em-dash
     * tiles — which reads as "we measured nothing" when the truth is "nothing has ever run". The
     * refusal message is carried on `.reason` now, which is why the separate `funnelError` state is
     * gone: two variables holding two halves of one answer is how they drifted apart.
     *
     * ⚠️ THREE KINDS OF EMPTY COME OUT OF THIS ONE ENDPOINT, not two, and the third is READY:
     *   · never synced        `data_state: 'NEVER_SYNCED'` — decoder state NEVER_SYNCED, data null
     *   · synced, no rows     `data_state: 'READY'`, `summary: null` — decoder state READY, and the
     *                         page gates the body on {@link _isEmptyWindow} instead
     *   · synced, has rows    the ordinary answer
     * The middle one is why `funnel.data` alone is no longer the render gate — see `funnelPayload`.
     */
    const [funnel, setFunnel] = useState(pendingDataState());
    const [loading, setLoading] = useState(false);

    // Shopify-style step funnel. `null` selection means "use the server default"
    // so the first render does not have to know the catalog; the user's own
    // ordering is remembered per browser once they change it.
    // Holds the decoded envelope, not the payload. GET /api/conversion/custom-funnel serves this
    // now, but the decode still matters: that endpoint answers 200 WITH A PAYLOAD even when a tier
    // is cold, because listing analytics (BigQuery) and the Partner API fail separately and blanking
    // one over the other would throw away a correct funnel. Flattening it to `null` would hand
    // PartnerFunnelChart its own empty state — "No funnel data for this window yet — run a sync to
    // populate GA4 and Partner events" — over steps that are present, measured and on screen. The
    // payload's own `tiers`, per-step `unknown_reason` and `warnings[]` are what say which half is
    // missing, and only `data_state` (set when NEITHER tier can answer) nulls the whole thing.
    const [stepFunnel, setStepFunnel] = useState(pendingDataState());
    const [stepEvents, setStepEvents] = useState(null);
    const [stepLoading, setStepLoading] = useState(false);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        try {
            const raw = window.localStorage.getItem(FUNNEL_EVENTS_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length >= 2) setStepEvents(parsed);
            }
        } catch (e) { /* ignore malformed storage */ }
    }, []);

    const handleChangeStepEvents = useCallback((nextKeys) => {
        setStepEvents(nextKeys);
        if (typeof window === 'undefined') return;
        try {
            window.localStorage.setItem(FUNNEL_EVENTS_STORAGE_KEY, JSON.stringify(nextKeys));
        } catch (e) { /* storage full or blocked — selection still applies this session */ }
    }, []);

    // Who installed in the window, how they arrived, and where they got to. Fetched separately
    // from the funnel so changing a filter refetches only this table.
    // Decoded envelope, same reason as `stepFunnel`: GET /api/funnel/install-cohort serves this
    // now and answers 200 with `data_state` rather than refusing, so the decode is what separates
    // "never synced" from "genuinely no installs". InstallCohortTable's "No installs recorded for
    // this window …run a Partner sync if you expect some" is a claim about the operator's business,
    // and it must only ever be drawn on a READY answer that really is empty.
    const [cohort, setCohort] = useState(pendingDataState());
    const [cohortLoading, setCohortLoading] = useState(false);
    const [cohortFilters, setCohortFilters] = useState({ state: '', channel: '' });

    const handleCohortFilter = useCallback((key, value) => {
        setCohortFilters((prev) => ({ ...prev, [key]: value }));
    }, []);

    // Conversion tab data. Five separate endpoints, five separate decoded envelopes — one per chart,
    // because they are five routes that can be built (or fail) independently, and a single shared
    // "conversion data" flag would report the state of whichever one answered last.
    const [convFunnel, setConvFunnel] = useState(pendingDataState());
    const [trialOutcomes, setTrialOutcomes] = useState(pendingDataState());
    const [cohortRetention, setCohortRetention] = useState(pendingDataState());
    const [timeToPaid, setTimeToPaid] = useState(pendingDataState());
    const [planMix, setPlanMix] = useState(pendingDataState());
    const [loadingConversion, setLoadingConversion] = useState(false);

    const fetchAcquisition = useCallback(() => {
        if (!appId || !appHydrated) return;
        if (!dateRange.hydrated) return;
        setLoading(true);
        FUNNEL_API.getFunnel({ partner_app_id: appId, ...dateRange.params }, (resp) => {
            // Keep the refusal, AND keep it apart from the other kinds of nothing. When listing
            // analytics is not connected the backend answers status:false with a message naming the
            // exact environment variables to set. Dropping it and showing "no data for this window"
            // sends the operator to widen a date range and re-run a sync — two remedies that cannot
            // fix a missing credential, while the one sentence that names the fix is thrown away.
            //
            // `isNeverSynced` is the other half, and it is now `!d.summary && !_isEmptyWindow(d)`
            // rather than the bare `!d.summary` it was.
            //
            // The `!d.summary` half is still not `d.summary === null`, and still for the reason
            // written the second time: a payload that ships `trend` and simply omits `summary`
            // gives `summary === undefined`, which sails through a `=== null` test and puts the
            // eight em-dashes back by a route the strict test does not cover. It suppresses nothing
            // measured — a computed summary is an object, and `{}` is truthy.
            //
            // THE `&& !_isEmptyWindow(d)` IS THE FIX. Without it the one payload that means
            // "a sync HAS run, these dates simply are not in the rollup" was filed as
            // NEVER_SYNCED, and the banner below then contradicted itself in three consecutive
            // sentences while the decoder nulled away the sync timestamp that disproved its own
            // heading. The predicate's header has the full account. That payload decodes READY
            // here — its envelope IS an answer — and the page gates the tiles and the chart on
            // `funnelPayload` so nothing is drawn over the null body.
            setFunnel(readDataState(resp, { isNeverSynced: (d) => !d.summary && !_isEmptyWindow(d) }));
            setLoading(false);
        });
    }, [appId, appHydrated, dateRange.params, dateRange.hydrated]);

    // Kept out of fetchAcquisition so changing the step selection refetches only
    // this chart, and so it does not disturb that function's in-flight counter.
    const fetchStepFunnel = useCallback(() => {
        if (!appId || !appHydrated) return;
        if (!dateRange.hydrated) return;
        setStepLoading(true);
        const params = { partner_app_id: appId, ...dateRange.params };
        if (Array.isArray(stepEvents) && stepEvents.length > 0) {
            params.events = stepEvents.join(',');
        }
        CONV_API.getCustomFunnel(params, (resp) => {
            setStepFunnel(readDataState(resp));
            setStepLoading(false);
        });
    }, [appId, appHydrated, dateRange.params, dateRange.hydrated, stepEvents]);

    const fetchCohort = useCallback(() => {
        if (!appId || !appHydrated) return;
        if (!dateRange.hydrated) return;
        setCohortLoading(true);
        const params = { partner_app_id: appId, ...dateRange.params, limit: 500 };
        if (cohortFilters.state) {
            params.state = cohortFilters.state;
        }
        if (cohortFilters.channel) {
            params.channel = cohortFilters.channel;
        }
        FUNNEL_API.getInstallCohort(params, (resp) => {
            const next = readDataState(resp);
            if (next.ready) {
                // Echo the active filters back so the selects stay controlled without the table
                // needing its own copy of page state. Merged into `.data` and ONLY when READY: in
                // every other state `data` is null on purpose, and spreading two filter keys onto it
                // would manufacture the truthy payload the decoder just refused to hand over.
                setCohort({ ...next, data: { ...next.data, filter_state: cohortFilters.state, filter_channel: cohortFilters.channel } });
            } else {
                setCohort(next);
            }
            setCohortLoading(false);
        });
    }, [appId, appHydrated, dateRange.params, dateRange.hydrated, cohortFilters.state, cohortFilters.channel]);

    const fetchConversion = useCallback(() => {
        if (!appId || !appHydrated) return;
        if (!dateRange.hydrated) return;
        setLoadingConversion(true);
        let inflight = 5;
        const done = () => { inflight -= 1; if (inflight === 0) setLoadingConversion(false); };

        // All five are served now. The decode still matters for the same reason it did while they
        // were stubs: the old `else set…(null)` fed each chart its own empty state — "No data for
        // this window yet — run a partner sync to populate", "No installs in this window yet", "No
        // shops converted to paid in this window yet", "No active paid subscribers found yet" — four
        // sentences about the operator's business. Every one of these endpoints answers 200 with
        // `data_state: 'NEVER_SYNCED'` and a nulled payload before a sync has run, so without the
        // decode those four sentences would be printed over exactly the deployments that have not
        // measured anything at all.
        CONV_API.getFunnel({ partner_app_id: appId, ...dateRange.params }, (resp) => {
            setConvFunnel(readDataState(resp));
            done();
        });
        CONV_API.getTrialOutcomes({ partner_app_id: appId, ...dateRange.params }, (resp) => {
            setTrialOutcomes(readDataState(resp));
            done();
        });
        CONV_API.getCohortRetention({ partner_app_id: appId, weeks: 12 }, (resp) => {
            setCohortRetention(readDataState(resp));
            done();
        });
        CONV_API.getTimeToPaid({ partner_app_id: appId, ...dateRange.params }, (resp) => {
            setTimeToPaid(readDataState(resp));
            done();
        });
        CONV_API.getPlanMix({ partner_app_id: appId }, (resp) => {
            setPlanMix(readDataState(resp));
            done();
        });
    }, [appId, appHydrated, dateRange.params, dateRange.hydrated]);

    useEffect(() => { fetchAcquisition(); }, [fetchAcquisition]);
    useEffect(() => { fetchStepFunnel(); }, [fetchStepFunnel]);
    useEffect(() => { fetchCohort(); }, [fetchCohort]);
    useEffect(() => {
        // Only fetch the analysis data when its tab is visible — avoids a redundant burst of
        // 5 requests on every page load.
        if (tabIndex === 2) fetchConversion();
    }, [tabIndex, fetchConversion]);

    // An `analysisUnanswered` flag used to sit here — true while all five analysis states were still
    // PENDING — because `DataStateSection` rendered its children in PENDING unconditionally, and
    // these five charts take no `loading` prop, so each was handed `data: null` and drew its own "No
    // installs in this window yet". `DataStateSection` now takes `loading` and renders NOTHING in
    // PENDING when no request is in flight, which covers that frame at the source. The flag was also
    // wrong in its own right: on an unhydrated date range `fetchConversion` returns early, and the
    // flag then printed "Loading conversion analysis…" indefinitely for a request that was never
    // issued — the same lie about the data as the empty state it was added to suppress, in a
    // different costume. `loadingConversion` alone is now the placeholder's condition, and it is true
    // exactly while the five requests are actually outstanding.

    // Three questions, three tabs. They used to be two, with the step funnel, the daily trend and
    // the install cohort stacked into one — a page tall enough that the trend chart was below the
    // fold. Order follows the question you ask first: where do people drop out, is it trending, then
    // what happened to the ones who subscribed.
    const tabs = [
        { id: 'conversion',          content: 'Conversion' },
        { id: 'daily',               content: 'Daily funnel' },
        { id: 'conversion_analysis', content: 'Conversion analysis' }
    ];
    const TAB_CONVERSION = 0;
    const TAB_DAILY = 1;
    const TAB_ANALYSIS = 2;
    // Two different failures used to render one message. "Not connected" names environment variables
    // and is fixed in .env; "no data in this window" is fixed by syncing or widening the range. The
    // old copy offered the second remedy for both, so an operator with missing credentials was sent
    // to do two things that could not work.
    //
    // ONE banner for the whole acquisition dataset, kept here rather than pushed into a
    // <DataStateSection> around each consumer: `FunnelStats` (above the tabs) and `DailyFunnelChart`
    // (inside a tab) read the same single response, so a section wrapper on each would state the
    // same fact twice on the Daily tab. Both consumers are handed `funnelPayload`, which is null
    // whenever there is no body to draw, so neither renders over a figure the backend did not
    // publish — this sentence is the only thing rendered in their place, exactly as before.

    /**
     * The measured-empty window: a READY envelope whose body is null.
     *
     * `funnel.data` IS TRUTHY HERE AND MUST NOT BE THE RENDER GATE. The decode is READY on
     * purpose — the window echo, the `last_bq_synced_at` watermark and `unknown_reason` are all
     * measured facts, and they are exactly what the reader needs — but `summary` is `null` and
     * `trend` is `[]`. Gating on `funnel.data` alone would mount eight em-dash tiles over that
     * null; gating the whole envelope out (the old `isNeverSynced` catch-all) deleted the
     * timestamp that proves a sync has run. Splitting the two is the only reading that keeps both
     * halves honest: the envelope renders, the body does not.
     */
    const emptyWindow = funnel.ready && _isEmptyWindow(funnel.data);
    /** What the tiles and the chart may draw. Null in every state that has no measured body. */
    const funnelPayload = emptyWindow ? null : funnel.data;

    let acquisitionBanner = null;
    if (appId && !loading) {
        if (funnel.state === DATA_STATE.NOT_CONNECTED) {
            acquisitionBanner = (
                <Banner tone="warning" title="Listing analytics is not connected">
                    <p>{funnel.reason}</p>
                    <p>The install and revenue steps below still come from the Partner API and are unaffected.</p>
                </Banner>
            );
        } else if (funnel.state === DATA_STATE.NEVER_SYNCED) {
            acquisitionBanner = (
                <Banner tone="info" title="No listing-analytics sync has run yet">
                    {/* The server's own sentence first — the page's copy below it is orientation,
                        not the answer. "Widen the date range" is deliberately NOT offered here: no
                        window has an answer until a sync has completed once. */}
                    <p>{funnel.reason}</p>
                    <p>
                        Listing views, install clicks and the daily trend come from the GA4 BigQuery
                        export — run a sync from the Sync page.
                    </p>
                </Banner>
            );
        } else if (emptyWindow) {
            //  NEITHER THE NEVER-SYNCED HEADING NOR A SYNC BUTTON. A sync has run; this window
            // just holds no rows. The remedies are on the date range and the sync WINDOW, and both
            // are in the server's own sentence — so the page adds no second sentence of its own
            // here, because the one it used to add ("run a sync from the Sync page") was the false
            // half. Rendered as `info`: nothing is broken and nothing failed.
            //
            // The "Last BigQuery sync" line above stays on screen for this state, which is the
            // point — it is the evidence that this is not a never-synced app.
            acquisitionBanner = (
                <Banner tone="info" title="No listing rows in this date range">
                    <p>{funnel.data.unknown_reason || EMPTY_WINDOW_FALLBACK}</p>
                </Banner>
            );
        } else if (funnel.state === DATA_STATE.FORBIDDEN) {
            // A restriction, not a failure: info, in DataStateSection's words. And NO "the steps below
            // are unaffected" — every step on this page needs analytics:read too (GET
            // /api/conversion/funnel included), so each of them is restricted as well and says so.
            acquisitionBanner = (
                <Banner tone="info" title={`Restricted — your role does not include ${permissionLabel(funnel.permission)}`}>
                    <p>Listing analytics is not shown. This says nothing about the data, only about what your role may read. An Owner or Admin can change your role.</p>
                </Banner>
            );
        } else if (funnel.state !== DATA_STATE.READY && funnel.state !== DATA_STATE.PENDING) {
            // ERROR, and NOT_IMPLEMENTED should this route ever be stubbed out (FORBIDDEN is handled
            // above). Both carry a message the operator can act on, and neither is a statement about
            // the listing's traffic.
            acquisitionBanner = (
                <Banner tone={funnel.notImplemented ? 'warning' : 'critical'} title="Listing analytics could not be loaded">
                    <p>{funnel.reason}</p>
                    <p>The install and revenue steps below still come from the Partner API and are unaffected.</p>
                </Banner>
            );
        }
    }


    return (
        <SideNavBar>
            <Page
                title="Funnel"
                subtitle="Listing views → install clicks → installs → trial → paid, and who installed in the window."
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
                            <p>Add a partner app first, then come back here to view its conversion funnel.</p>
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

                    {/* Kept as a bare line rather than a card: the date filter it used to share a
                        card with is in the page header now, and freshness on its own does not warrant
                        a panel. Triggering the sync lives on the Sync page. */}
                    {appId && funnel.data && funnel.data.last_bq_synced_at ? (
                        <Text as="span" variant="bodySm" tone="subdued">
                            Last BigQuery sync: {new Date(funnel.data.last_bq_synced_at).toLocaleString()}
                        </Text>
                    ) : null}

                    {/* The GA4 window summary sits ABOVE the tabs: it describes the selected
                        date range, not any one view of it, so hiding it inside a tab would make the
                        headline numbers disappear when you switched. */}
                    {/* `funnelPayload`, not `funnel` and not `funnel.data`: null in every state
                        with no measured body — including the READY window that matched no rollup
                        row — and FunnelStats already renders nothing for a null funnel. The tiles
                        are therefore absent rather than filled with em-dashes the backend never
                        published. The banner below says which kind of nothing this is. */}
                    {appId && funnelPayload ? <FunnelStats funnel={funnelPayload} /> : null}

                    {/* Tabs and their content in ONE card. Previously the strip was its own card
                        floating above the content card, so every tab switch happened across a visible
                        seam — the tabs read as a separate control rather than as this panel's own
                        header. `padding="0"` on the shell plus `bare` on each child means the child
                        supplies its own padding and no Card nests inside another. Same shape as the
                        Traffic Sources page. */}
                    {appId ? (
                        <Card padding="0">
                            <Tabs tabs={tabs} selected={tabIndex} onSelect={setTabIndex} />

                            {tabIndex === TAB_CONVERSION ? (
                                <>
                                    <Divider />
                                    {/* `bare` on the section matches `bare` on the chart: the
                                        wrapper REPLACES the child when there is nothing to draw, so
                                        a mismatch would show a stray card border only on the days
                                        with no data. */}
                                    {/* `loading` IS THE SAME FLAG THE CHILD GETS, and it must be:
                                        in PENDING the section renders the child only while a request
                                        is genuinely in flight (the child then draws its own
                                        skeleton) and renders nothing otherwise. `fetchStepFunnel`
                                        returns early on an unhydrated date range without ever
                                        setting `stepLoading`, and that PENDING-with-nothing-in-
                                        flight is precisely the case that must not reach
                                        `PartnerFunnelChart` — it answers a null `data` with "No
                                        funnel data for this window yet — run a sync", a sentence
                                        about the operator's listing that no request was made to
                                        support. */}
                                    <DataStateSection state={stepFunnel} title="Conversion funnel" bare loading={stepLoading}>
                                        <PartnerFunnelChart
                                            data={stepFunnel.data}
                                            loading={stepLoading}
                                            onChangeEvents={handleChangeStepEvents}
                                            bare
                                        />
                                    </DataStateSection>
                                    <Divider />
                                    {/* `cohortLoading`, not `loading` — this table has its own
                                        endpoint and its own request, and the section's PENDING rule
                                        is about whether THAT request is in flight. Sharing the
                                        acquisition flag would let the table skeleton on a fetch that
                                        is not its own, and, worse, render it with `data: null` while
                                        its own request had never started. */}
                                    <DataStateSection state={cohort} title="Stores installed in this window" bare loading={cohortLoading}>
                                        <InstallCohortTable
                                            data={cohort.data}
                                            loading={cohortLoading}
                                            onFilterChange={handleCohortFilter}
                                            appId={appId}
                                            bare
                                        />
                                    </DataStateSection>
                                </>
                            ) : null}

                            {tabIndex === TAB_DAILY ? (
                                <>
                                    <Divider />
                                    {loading ? (
                                        <div style={{ padding: 'var(--p-space-400)' }}>
                                            <Text as="p" tone="subdued">Loading daily funnel…</Text>
                                        </div>
                                    ) : (
                                        /* Same `funnelPayload` rule as the tiles above, and it
                                           matters most here: on a READY-but-empty window the raw
                                           `funnel.data` carries `trend: []`, so the chart would
                                           mount and print its own "No daily rows for this window."
                                           beside the banner — two sentences for one fact, and the
                                           chart's own header calls that path defensive-only. The
                                           explanation for an absent chart is the one acquisition
                                           banner below the card; this endpoint feeds both, and
                                           saying it twice on this tab reads as two faults. */
                                        <DailyFunnelChart funnel={funnelPayload} bare />
                                    )}
                                </>
                            ) : null}

                            {tabIndex === TAB_ANALYSIS ? (
                                <>
                                    <Divider />
                                    {loadingConversion ? (
                                        <div style={{ padding: 'var(--p-space-400)' }}>
                                            <Text as="p" tone="subdued">Loading conversion analysis…</Text>
                                        </div>
                                    ) : (
                                        <>
                                            {/* One section per chart, not one around the tab: these
                                                are five independent endpoints and could arrive — or
                                                fail — one at a time, so a shared wrapper would hide
                                                four working charts behind the fifth's banner.

                                                `loading={loadingConversion}` ON ALL FIVE, and it
                                                is deliberately the same flag: the five go out as one
                                                burst behind a single in-flight counter, so there is
                                                one honest answer to "is a request outstanding for
                                                this chart" and this is it. It reads false inside
                                                this branch today, because the placeholder above
                                                already owns the in-flight case — passing it anyway
                                                puts the invariant on the section rather than on the
                                                branch, so a later edit to that placeholder cannot
                                                quietly hand these five a null payload. None of them
                                                takes a `loading` prop of its own, so PENDING here
                                                MUST render nothing: `ConversionFunnelChart`,
                                                `TrialOutcomeBar`, `TimeToPaidHistogram`,
                                                `CohortRetentionHeatmap` and `PlanMixDonut` each
                                                answer a null `data` with a sentence about the
                                                operator's business ("No installs in this window
                                                yet", "No shops converted to paid in this window
                                                yet") that no response ever made. */}
                                            <DataStateSection state={convFunnel} title="End-to-end conversion funnel" bare loading={loadingConversion}>
                                                <>
                                                    <ConversionFunnelChart data={convFunnel.data} bare />
                                                    {/*  The chart draws an unavailable stage as a
                                                        minimum-width bar with an em-dash label and
                                                        says nothing about why. These are the
                                                        sentences that say why — the cold listing
                                                        tier, the GA4 lag, the rates that cross a
                                                        measurement seam. */}
                                                    <PayloadWarnings state={convFunnel} />
                                                </>
                                            </DataStateSection>
                                            <Divider />
                                            <DataStateSection state={trialOutcomes} title="Trial outcomes" bare loading={loadingConversion}>
                                                <>
                                                    <TrialOutcomeBar data={trialOutcomes.data} bare />
                                                    <PayloadWarnings state={trialOutcomes} />
                                                </>
                                            </DataStateSection>
                                            <Divider />
                                            {/* Zero-gap grid with a hairline between, so the two read
                                                as one strip rather than two floating panels — the
                                                border is dropped at the breakpoint where the grid
                                                collapses to a single column. */}
                                            <InlineGrid columns={{ xs: 1, sm: 1, md: 2 }} gap="0">
                                                <div>
                                                    <DataStateSection state={timeToPaid} title="Time to paid" bare loading={loadingConversion}>
                                                        <>
                                                            <TimeToPaidHistogram data={timeToPaid.data} bare />
                                                            {/* The exclusions are the reason this
                                                                histogram's total is a FLOOR — shops
                                                                that converted with no billing date
                                                                are counted nowhere on the chart. */}
                                                            <PayloadWarnings state={timeToPaid} />
                                                        </>
                                                    </DataStateSection>
                                                </div>
                                                <div style={{ borderLeft: '1px solid var(--p-color-border-secondary)' }}>
                                                    <DataStateSection state={cohortRetention} title="Cohort retention" bare loading={loadingConversion}>
                                                        <>
                                                            <CohortRetentionHeatmap data={cohortRetention.data} bare />
                                                            <PayloadWarnings state={cohortRetention} />
                                                        </>
                                                    </DataStateSection>
                                                </div>
                                            </InlineGrid>
                                            <Divider />
                                            <DataStateSection state={planMix} title="Plan mix" bare loading={loadingConversion}>
                                                <>
                                                    <PlanMixDonut data={planMix.data} bare />
                                                    <PayloadWarnings state={planMix} />
                                                </>
                                            </DataStateSection>
                                        </>
                                    )}
                                </>
                            ) : null}
                        </Card>
                    ) : null}

                    {/* GA4 is forward-only and never backfilled, so an empty window is normal rather
                        than broken. The step funnel is Partner-API sourced and unaffected — which is
                        why this sits below the tabs rather than replacing them. */}
                    {acquisitionBanner}
                </BlockStack>
            </Page>
            {toastMarkup}
        </SideNavBar>
    );
};

export default FunnelPage;
