import { Banner, BlockStack, Box, Button, Card, Divider, InlineGrid, InlineStack, Page, Text } from '@shopify/polaris';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';

import SideNavBar from '../../components/sideNavBar';
import LoaderContext from '../../contexts/loaderContext';
import { APPS_STATE, useGrowthIntel } from '../../contexts/growthIntelContext';
import GrowthIntelPartnerAppApiService from '../../API_Services/growth-intel/partnerAppService';
import AppKpiCards from '../../components/growth-intel/AppKpiCards';
import InstallTrendSection from '../../components/growth-intel/InstallTrendSection';
import KpiWarningsCard from '../../components/growth-intel/KpiWarningsCard';
import DataStateSection from '../../components/growth-intel/DataStateSection';
import { pendingDataState, readDataState } from '../../components/growth-intel/dataState';
import { DASHBOARD_ROUTES, REVENUE_VIEWS, revenueViewHref } from '../../utils/dashboardRoutes';

/**
 * =============================================================================
 *  Overview — how the app is doing, on the page you land on.
 * =============================================================================
 *
 *  Installs, uninstalls, reinstalls and gross revenue for the selected partner
 *  app: the rolling window, the all-time totals, the caveats that qualify them,
 *  and the install trend behind them. It is the post-login landing screen
 *  (`pages/index.js` and `pages/login.js` both point here), and it is the parent
 *  route a reader lands on when they trim a path back.
 *
 *  ── WHY THESE FIGURES MOVED HERE ────────────────────────────────────────────
 *  They used to be visible only at the FOOT OF THE PARTNER APPS SETUP SCREEN,
 *  under a registration form and a roster of app cards. Partner Apps answers
 *  "which app is this install reporting on"; it is a configuration screen visited
 *  on day one and rarely after. "How is the business doing" is not a
 *  configuration question and was being answered three scrolls below one.
 *
 *  The Partner Apps page still shows them — this change did not take anything off
 *  it. That duplication is real and is worth resolving; it is not resolved here
 *  because stripping a screen nobody asked to have stripped is a decision for its
 *  owner, not for the change that happened to walk past it.
 *
 *  ── WHAT USED TO BE AT THIS ROUTE, AND THE LESSON IT LEFT ────────────────
 *  A contents page whose header stated, in confident detail, that "only Revenue
 *  is backed by a real endpoint and the other eight get the marked not
 *  implemented envelope". That was TRUE WHEN IT WAS WRITTEN. Every page it wrote
 *  off was served long before anyone read it, so what they read was a description
 *  of a build that no longer existed — and it read as authoritative precisely
 *  because it was specific.
 *
 *  The rule that comment broke is the same one every figure on this page obeys:
 *  DO NOT RESTATE A FACT YOU CANNOT KEEP CURRENT. Nothing below catalogues what
 *  the backend can answer. Each section asks its endpoint and renders the
 *  endpoint's own answer, including the endpoint's own refusal — that copy cannot
 *  go stale, because nobody is maintaining it.
 *
 *  ──  THE KPI READ GOES THROUGH `readDataState`, AND THAT IS LOAD-BEARING ───
 *  `GET /api/partner-apps/:id/kpi` answers HTTP 200 with `status: true` for an
 *  app that has NEVER SYNCED — every count, every money figure and `trend` all
 *  null, `data_state: 'NEVER_SYNCED'`, and the explanation on `unknown_reason`. A
 *  page that tested `resp.status && resp.data` would store that truthy-but-empty
 *  payload and render it: eight em-dash tiles under the heading "Last 30 days",
 *  on the first screen after login, for a deployment that has simply not synced
 *  yet. `readDataState` keys on the very fields that payload sets, so the whole
 *  section is replaced by one banner instead — and NOTHING is drawn in its place,
 *  because an empty KPI tile is indistinguishable from an app with no installs.
 *
 *  ──  ONE READ, NOT TWO — THE CHART COMES OUT OF THE SAME PAYLOAD ───────────
 *  It is tempting to fetch the tiles from `getKpi` and the trend from `getEvents`
 *  so that one can answer while the other cannot. This page deliberately does
 *  not, and the reason is in the KPI service's own header: "ONE WINDOW FOR
 *  EVERYTHING. The tiles and the chart are folded from the SAME relationship
 *  tally … so a reader who sums the bars and compares the answer with the tile
 *  above them gets the same number BY CONSTRUCTION rather than by agreement."
 *
 *  Two requests would spend that guarantee. They are two judgement instants, and
 *  a sync landing between them is all it takes for the bars to stop summing to
 *  the tile above them — a page that does not crash and does not error, and
 *  quietly disagrees with itself. That is the failure this project exists to
 *  prevent, and it would be bought with a resilience nobody can observe: both
 *  halves come from one endpoint, so there is no state in which one of them can
 *  answer and the other cannot.
 *
 *  What IS independent is what the payload says about each half, and that stays
 *  separate: `counts_measurable`, `revenue_measurable` and `all_time_measurable`
 *  are three gates that fail separately (`AppKpiCards` renders each unknown as an
 *  em dash, never a zero), and a READY payload with totals but no plottable
 *  points renders the tiles with an explanation where the chart would be, rather
 *  than a flat line at zero. See `InstallTrendSection`.
 *
 *  ── WHY THE CONTENTS LIST SURVIVED, AT THE BOTTOM ───────────────────────────
 *  The nav on the left is the primary way around and a second copy of it can
 *  drift, which is a real argument for deleting the list outright. It stays for
 *  one reason the nav cannot cover: THIS PAGE'S MOST COMMON STATE ON A FRESH
 *  INSTALL IS A BANNER TELLING THE READER TO REGISTER AN APP OR RUN A SYNC, and
 *  the list is where those two destinations are one click away, with a sentence
 *  saying what each screen answers — which a nav label cannot carry. It is kept
 *  BELOW the figures so the page is a summary first and a directory second, and
 *  it lists the Setup screens as well as the Performance ones, because the two
 *  Setup screens are the ones the empty states point at.
 * =============================================================================
 */

/** One service instance for the module. Constructing one per render builds a new axios client per render. */
const PARTNER_API = new GrowthIntelPartnerAppApiService();

/**
 * Rolling window asked of the KPI endpoint. Matches `AppKpiCards`' own default label.
 *
 * This page is now the ONLY reader of that endpoint — the identical block was removed from Partner
 * Apps, which answers "did my app sync?" with its own watermark timestamps instead.
 */
const KPI_PERIOD_DAYS = 30;

/**
 * Every other page in this dashboard, in the order the side nav lists them.
 *
 * ⚠️ ORDER AND GROUPING MATCH `components/sideNavBar.js` ON PURPOSE — two different orderings of the
 * same destinations makes both harder to scan. Change one, change the other.
 *
 * The HREFS are not written here: both this list and the nav read `DASHBOARD_ROUTES` from
 * `utils/dashboardRoutes.js`, so the two copies of the menu can disagree about wording or order —
 * which is visible — but never about where a row goes, which is not.
 *
 * The descriptions say what each page ANSWERS, which is the whole reason this list earns its place
 * next to a nav that already carries the labels. None of them claims anything about whether the data
 * is there: that is a fact each page reads from its own endpoint on open.
 */
const SECTION_CONTENTS = [
    {
        key: 'performance',
        title: 'Performance',
        pages: [
            {
                title: 'Funnel',
                desc: 'Views → install clicks → installs → trial → paid, with the install cohort behind it.',
                href: DASHBOARD_ROUTES.FUNNEL
            },
            {
                title: 'Traffic Sources',
                desc: 'Where installs come from — channel and medium attribution, plus a country breakdown.',
                href: DASHBOARD_ROUTES.TRAFFIC_SOURCES
            },
            {
                title: 'Trial Funnel',
                desc: 'Trial outcomes over time: how many converted, how many lapsed, and how quickly.',
                href: DASHBOARD_ROUTES.TRIAL_FUNNEL
            },
            {
                title: 'Logo Churn',
                desc: 'Customer counts in and out — stores gained and lost, regardless of what they paid.',
                href: DASHBOARD_ROUTES.LOGO_CHURN
            },
            {
                title: 'Stores',
                desc: 'Every store that has installed the app, whether or not it ever subscribed.',
                href: DASHBOARD_ROUTES.STORES
            },
            {
                title: 'Subscriptions',
                desc: 'Stores paying right now, with plan, state and acquisition channel.',
                href: DASHBOARD_ROUTES.SUBSCRIPTIONS
            },
            /*
             * ⚠️ THREE ENTRIES, ONE PAGE, AND THE HREFS ARE WHAT MAKE THAT WORK.
             *
             * Revenue, Revenue Country and Revenue Churn are three TABS of `/revenue` now, not
             * three pages. They keep three cards here — and the nav keeps ONE row — because a card
             * carries a sentence saying what the screen answers, and those three sentences are
             * three different questions that happen to share a URL. A nav row cannot say that, and
             * three rows all lighting up together would be worse than one.
             *
             * `revenueViewHref` builds each link, so the `?view=` values live in
             * `utils/dashboardRoutes.js` beside the page that reads them. Writing
             * `'/revenue?view=churn'` here would be a route literal, which is the drift the shared
             * module exists to prevent — and it would survive a rename silently, because an
             * unrecognised view falls back to the default rather than erroring.
             */
            {
                title: 'Revenue',
                desc: 'MRR, ARPU and the lifetime ledger as of the last sync, with the movement drill-down.',
                href: revenueViewHref(REVENUE_VIEWS.REVENUE)
            },
            {
                title: 'Revenue by country',
                desc: 'Paying customers and revenue by country, with the unattributed remainder shown. Lifetime — this one takes no date range.',
                href: revenueViewHref(REVENUE_VIEWS.COUNTRIES)
            },
            {
                title: 'Revenue churn',
                desc: 'Money in and out — new, expansion, contraction and churned MRR by month.',
                href: revenueViewHref(REVENUE_VIEWS.CHURN)
            }
        ]
    },
    {
        key: 'setup',
        title: 'Setup',
        pages: [
            {
                title: 'Partner Apps',
                desc: 'Register the app this install reports on, and choose which one every page is scoped to.',
                href: DASHBOARD_ROUTES.APPS
            },
            {
                title: 'Sync',
                desc: 'Run a Partner API sync, watch the job history, and see how far back the data reaches.',
                href: DASHBOARD_ROUTES.SYNC
            }
        ]
    }
];

/**
 * The Overview: the selected partner app's headline figures, and the way on to everything else.
 *
 * Takes no props — the partner-app selection it reads lives in `growthIntelContext`, shared with the
 * picker in the side nav, so the figures below follow whatever that picker is set to.
 *
 * @returns {JSX.Element} The framed page.
 */
const GrowthIntelOverviewPage = () => {
    const router = useRouter();
    const { toastMarkup } = useContext(LoaderContext) || {};
    const { apps, appId, appsState, appsError, hydrated, refreshApps } = useGrowthIntel();

    /**
     * The DECODED KPI envelope, never the raw payload.
     *
     *  `data` is null in every state but READY, so nothing below can draw a tile over a figure the
     * backend refused to publish. Four of the five states this can hold are empty and they mean
     * materially different things — an endpoint that does not exist, an upstream that is not
     * configured, a sync that has never run, a request that failed — which is why the state is held
     * rather than a boolean.
     */
    const [kpi, setKpi] = useState(pendingDataState());
    const [kpiLoading, setKpiLoading] = useState(false);

    /**
     * Monotonic request id. ONLY THE LATEST READ MAY WRITE STATE.
     *
     * Nothing here cancels an in-flight request, and two controls overlap them: the app picker in
     * the side nav, and this page's own Refresh action, which — unlike the context's `refreshApps`
     * and its `inFlightRef` — will happily issue a second concurrent request. Without this counter
     * the loser landing last wins, silently, and the screen shows an answer to a question the
     * reader has already moved on from: app A's installs and revenue under app B's name in the
     * picker. `stores/index.js` and `components/growth-intel/revenue/CountryView.js` hold the same
     * counter for the same reason.
     *
     * The deterministic case is worse than the race. The early return below resets to PENDING and
     * clears `kpiLoading` but CANNOT UNSEND a request already in flight, so without a bump on that
     * path a response for a now-deselected app still decodes to READY — and `DataStateSection`
     * mounts children on READY regardless of `loading`. A full grid of one app's tiles, underneath
     * the banner saying no partner app is registered.
     */
    const requestSeq = useRef(0);

    /**
     * Reads the headline KPIs for the selected app.
     *
     *  DECODED THROUGH `readDataState`, NOT BRANCHED ON `status` — see the file header.
     *
     * `kpiLoading` is tracked separately and is FALSE on the early return: a section left PENDING
     * with no request in flight must draw nothing at all, and `DataStateSection` uses this flag to
     * tell the two halves of PENDING apart.
     *
     * @returns {void}
     */
    const loadKpi = useCallback(() => {
        // BUMPED BEFORE THE GUARD, NOT AFTER IT. Abandoning a read is exactly the case where an
        // outstanding response must be disowned, so the early return has to invalidate too.
        const seq = ++requestSeq.current;
        if (!appId || !hydrated) {
            // No request was issued, so there is no answer and no claim in either direction.
            setKpi(pendingDataState());
            setKpiLoading(false);
            return;
        }
        setKpiLoading(true);
        setKpi(pendingDataState());
        PARTNER_API.getKpi(appId, { period_days: KPI_PERIOD_DAYS }, (resp) => {
            // A superseded response writes NOTHING — not the payload, and not `kpiLoading`, which
            // would otherwise clear the in-flight flag out from under the request that replaced it
            // and leave `DataStateSection` drawing PENDING-with-no-request over a live read.
            if (seq !== requestSeq.current) return;
            setKpi(readDataState(resp));
            setKpiLoading(false);
        });
    }, [appId, hydrated]);

    useEffect(() => { loadKpi(); }, [loadKpi]);

    // ── Which kind of "no figures" is this? ──────────────────────────────────────────────────
    // AN EMPTY ROSTER IS FOUR DIFFERENT ANSWERS AND ONLY ONE OF THEM IS ABOUT THE OPERATOR.
    // `apps.length === 0` is also true while the request is in flight, after it failed and after a
    // 401, so gating on it alone publishes "no partner apps yet" — a measured claim about somebody's
    // account — out of a dropped connection. `appsState` is the discriminator, exactly as on every
    // other page in this section: READY is the only state in which an empty roster is a fact.
    // UNAUTHENTICATED and PENDING draw nothing; the first is a redirect already under way, the
    // second is the first tick of every page load.
    //
    // These sit ABOVE the figures rather than replacing them, because a failed ROSTER refresh says
    // nothing about the KPI read that is already on screen.
    let rosterBanner = null;
    if (appsState === APPS_STATE.ERROR) {
        rosterBanner = (
            <Banner
                tone="critical"
                title="The partner app list could not be loaded"
                action={{ content: 'Try again', onAction: refreshApps }}
            >
                <p>{appsError}</p>
                <p>
                    Which apps exist — and therefore which one these figures belong to — is unknown until this
                    call succeeds. Nothing retries on a timer.
                </p>
            </Banner>
        );
    } else if (appsState === APPS_STATE.READY && apps.length === 0) {
        rosterBanner = (
            <Banner tone="warning" title="No partner app is registered">
                <p>
                    Every figure in this dashboard is read out of the Partner API history for a single app id, and
                    there is no default. Register the app this install reports on, then run the first sync.
                </p>
                <Box paddingBlockStart="200">
                    {/* InlineStack, not the surrounding stack: a Button dropped straight into a
                        BlockStack stretches to the full banner width. */}
                    <InlineStack>
                        <Button onClick={() => router.push(DASHBOARD_ROUTES.APPS)}>Open Partner Apps</Button>
                    </InlineStack>
                </Box>
            </Banner>
        );
    } else if (hydrated && apps.length > 0 && !appId) {
        // No state gate needed: `apps.length > 0` is only ever true of a roster we actually
        // received, and "none is selected" is a fact about this browser rather than about the
        // operator's business.
        rosterBanner = (
            <Banner tone="warning" title="No partner app is selected">
                <p>
                    Pick one from the picker in the side nav. The figures below are scoped by that selection, so
                    until it is made this page has asked for nothing and reports nothing.
                </p>
            </Banner>
        );
    }

    // ──  THE GATE, AND THE POINT OF IT IS THE `else` ───────────────────────────────────────
    // Not that the banner is informative — that eight KPI tiles and a chart are NOT MOUNTED unless
    // the endpoint actually answered. An explanatory sentence above a grid of em dashes loses to the
    // grid, because the figures are concrete and the sentence is not; and this is the first screen
    // anybody sees after signing in.
    //
    // `loading` IS NOT OPTIONAL. In PENDING this section renders its children only while a
    // request is genuinely in flight. `loadKpi` early-returns before `setKpiLoading(true)` whenever
    // no app is selected — so without this prop the section would sit in PENDING for ever and draw
    // its children over a request that was never issued.
    //
    // The inner test is on `kpi.ready`, not on `kpiLoading`: it is the payload's presence that
    // decides whether the tiles can be drawn, and reading it off the state that also null-guards
    // `data` means there is no second condition to get out of step with the first.
    const figuresSection = (
        <DataStateSection state={kpi} title="Installs and revenue" loading={kpiLoading}>
            {kpi.ready ? (
                <BlockStack gap="400">
                    <AppKpiCards kpi={kpi.data} />
                    {/* The caveats that change how a figure READS, in the server's own words,
                        directly beneath the figures they qualify. Renders nothing when the payload
                        raised none. */}
                    <KpiWarningsCard warnings={kpi.data.warnings} />
                    <InstallTrendSection kpi={kpi.data} title="Install activity" />
                </BlockStack>
            ) : (
                <Card><Text as="p">Reading installs and revenue…</Text></Card>
            )}
        </DataStateSection>
    );

    // ── The way on to everything else ────────────────────────────────────────────────────────
    // `router.push`, not a Polaris `Link`: no `linkComponent` is configured on the AppProvider, so a
    // Link here would render a plain anchor and reload the whole application on every click.
    const contentsGroups = SECTION_CONTENTS.map((group, index) => (
        <BlockStack key={group.key} gap="300">
            {index > 0 ? <Divider /> : null}
            <Text as="h3" variant="headingSm">{group.title}</Text>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="300">
                {/* `entry`, not `page`: `Page` is a Polaris component in scope in this file, and
                    a lower-case twin of it three lines from a `<Page>` tag is a needless re-read. */}
                {group.pages.map((entry) => (
                    <BlockStack key={entry.href} gap="050">
                        <InlineStack>
                            <Button variant="plain" onClick={() => router.push(entry.href)}>{entry.title}</Button>
                        </InlineStack>
                        <Text as="span" variant="bodySm" tone="subdued">{entry.desc}</Text>
                    </BlockStack>
                ))}
            </InlineGrid>
        </BlockStack>
    ));

    const contentsCard = (
        <Card>
            <BlockStack gap="400">
                <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">Everywhere else in this dashboard</Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                        Each screen reads its own endpoint and says for itself what it does and does not have.
                    </Text>
                </BlockStack>
                {contentsGroups}
            </BlockStack>
        </Card>
    );

    // Offered only when there is something to refresh. A Refresh button with no app selected would
    // re-run a callback that early-returns, which reads as a control that does nothing.
    let secondaryActions;
    if (appId) {
        secondaryActions = [{ content: 'Refresh', onAction: loadKpi, loading: kpiLoading }];
    }

    return (
        <SideNavBar>
            <Page
                title="Overview"
                subtitle="Installs, uninstalls and gross revenue for the selected partner app."
                fullWidth
                secondaryActions={secondaryActions}
            >
                <BlockStack gap="400">
                    {rosterBanner}
                    {figuresSection}
                    {contentsCard}
                    <Box paddingBlockEnd="400" />
                </BlockStack>
            </Page>
            {toastMarkup}
        </SideNavBar>
    );
};

export default GrowthIntelOverviewPage;
