import { Page, Card, BlockStack, Banner, Tabs } from '@shopify/polaris';
import { useCallback, useContext } from 'react';
import { useRouter } from 'next/router';

import SideNavBar from '../../components/sideNavBar';
import LoaderContext from '../../contexts/loaderContext';
import { APPS_STATE, useGrowthIntel } from '../../contexts/growthIntelContext';
import DateRangeFilter, { useDateRangeState } from '../../components/growth-intel/DateRangeFilter';
import RevenueView from '../../components/growth-intel/revenue/RevenueView';
import CountryView from '../../components/growth-intel/revenue/CountryView';
import ChurnView from '../../components/growth-intel/revenue/ChurnView';
import {
    DASHBOARD_ROUTES,
    REVENUE_VIEWS,
    REVENUE_VIEW_ORDER,
    normaliseRevenueView,
    revenueViewHref
} from '../../utils/dashboardRoutes';

/**
 * =============================================================================
 *  Revenue — one screen, three views, one window.
 * =============================================================================
 *
 *  Revenue, Revenue Country and Revenue Churn were three nav rows opening three
 *  pages, each with its own date control set to its own value. Three screens that
 *  answer three halves of one question — what are we earning, where from, and
 *  what is moving — and no way to compare them without remembering what each one
 *  had been left filtered to. They are three TABS now, under ONE date range.
 *
 *  ── WHAT THIS FILE OWNS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────
 *  It owns the shell: the roster banners, the tab strip, the shared range, and
 *  which view is on screen. It owns NO data and NO endpoint. Each view fetches
 *  its own payload and gates it with its own `DataStateSection`, which is the
 *  property that matters most here — three endpoints behind one screen means one
 *  of them can be refusing while the other two answer, and a tab whose service is
 *  unconfigured must not blank the two that are working.
 *
 *  ──  THE TAB IS IN THE URL, AND THAT IS NOT DECORATION ─────────────────────
 *  `pages/funnel/index.js` keeps its tab in `useState(0)`. It is right to, and
 *  this page cannot: two things link INTO these views. The Overview's contents
 *  cards point at all three, and `next.config.js` redirects the retired
 *  `/countries` and `/revenue-churn` paths here — a bookmark from before the merge
 *  has to land on the screen it was bookmarked for, and a redirect cannot reach
 *  into `useState`. `utils/dashboardRoutes.js` owns the vocabulary
 *  (`REVENUE_VIEWS`, `revenueViewHref`) so no `?view=` string is written twice.
 *
 *  ── ONE CONTROL OVER THREE VIEWS THAT DO NOT ALL HONOUR IT ───────────────
 *  This is the dangerous part of the merge and it is worth stating in the file
 *  that creates the danger. The shared range is passed to the two views whose
 *  endpoints take a window, and the third is NOT given it:
 *
 *    · Revenue  — `GET /api/revenue/overview` takes `since`/`until` (or
 *                 `period_days`) and positions the window exactly. Honours it.
 *    · Churn    — `GET /api/conversion/revenue-churn` takes a COUNT OF MONTHS and
 *                 counts back from now. It cannot honour a range that ends in the
 *                 past, and it rounds a part-month UP. `ChurnView` says so on
 *                 screen, in the server's terms, every time.
 *    · Country  — `GET /api/stores/countries` takes NO date parameter at all. It
 *                 is handed no range and takes no `dateRange` prop, so it cannot
 *                 silently drop one; it prints a standing notice that it is
 *                 lifetime and unfiltered.
 *
 *  A control that appears to govern a figure it does not govern is exactly the
 *  plausible wrong number this project exists to refuse. Three tabs under one
 *  range must never LOOK like they share a window when they do not — which is why
 *  each view states its own, rather than this page stating one for all three.
 * =============================================================================
 */

/** What each view is called on the strip. The owner picked these three words. */
const TAB_LABELS = {
    [REVENUE_VIEWS.REVENUE]: 'Revenue',
    [REVENUE_VIEWS.COUNTRIES]: 'By country',
    [REVENUE_VIEWS.CHURN]: 'Churn'
};

/**
 * The tab strip itself.
 *
 * ⚠️ BUILT FROM `REVENUE_VIEW_ORDER`, not written out here: the index Polaris hands back from
 * `onSelect` is an index into THIS array, and it is resolved to a view id through that same list.
 * Two hand-maintained orderings would drift the day one gains a tab, and the drift would be silent —
 * clicking Churn would open By country.
 *
 * ⚠️ NO `accessibilityLabel` AND NO `panelID`, and both were written and removed.
 *
 * `accessibilityLabel` becomes the tab's `aria-label`, which REPLACES the visible text rather than
 * extending it — so a longer, more descriptive label would leave a voice-control user unable to say
 * "click Revenue" for a tab that plainly reads Revenue. `panelID` is dead config here: Polaris drops
 * it unless `Tabs` is given children (`panelID: children ? tabPanelID : undefined`), and the view is
 * rendered outside this Card rather than inside the strip. Configuration that does nothing is worse
 * than none — it reads as wired.
 */
const TABS = REVENUE_VIEW_ORDER.map((view) => ({
    // NAMESPACED. A bare `id: view` collides with the detail tabs INSIDE a view — RevenueView's
    // churned-stores tab is also `id: 'churn'` — putting two elements with the same DOM id on one
    // page. Polaris writes the id straight through to the button and derives `aria-controls` from
    // it, so a duplicate silently mis-wires the accessibility relationship and makes any
    // id-based selector ambiguous.
    id: `revenue-view-${view}`,
    content: TAB_LABELS[view]
}));

/**
 * The Revenue screen.
 *
 * Takes no props — the partner-app selection it reads lives in `growthIntelContext`, shared with the
 * picker in the side nav, so every figure below follows whatever that picker is set to.
 *
 * @returns {JSX.Element} The framed page.
 */
const RevenuePage = () => {
    const { toastMarkup } = useContext(LoaderContext) || {};
    // The app selection lives in the side nav — one picker for the whole section.
    const { apps, appId, appsState, appsError, refreshApps, hydrated: appHydrated } = useGrowthIntel();
    const router = useRouter();

    /**
     * ONE range for the whole screen, so figures on two tabs describe one window.
     *
     * ⚠️ THE KEY IS THE OLD REVENUE PAGE'S. Reusing `gi.revenue.dateRange` rather than minting a new
     * one means an operator's existing selection survives this change instead of silently reverting
     * to the default the first time they open the merged screen. The churn page's own
     * `gi.revenueChurn.dateRange` is simply no longer read; it is left in storage rather than
     * migrated, because merging two remembered ranges requires picking a loser and neither choice is
     * defensible.
     *
     * A year by default, which is what both of the two ranged views used to default to. It matters
     * for Churn: at 30 days the request is one month, the range then holds nothing but the month in
     * progress, and every `last_month_*` tile is honestly unknown. `ChurnView` explains that when it
     * happens; defaulting into it would have been a poor first impression of a working screen.
     */
    const dateRange = useDateRangeState({
        storageKey: 'gi.revenue.dateRange',
        defaultValue: { kind: 'preset', preset: 365 }
    });

    /**
     * THE VIEW IS READ FROM THE URL, AND ONLY ONCE THE URL IS READABLE.
     *
     * `router.query` is EMPTY on the first render of a statically optimised page — Next fills it in
     * after hydration and flips `isReady`. Deriving the tab from an empty query would resolve to the
     * default for one tick, and the cost is not a flicker: each view fetches on mount, so a deep link
     * to `?view=churn` would issue a Revenue request, throw it away, and then issue the Churn one.
     * `null` until ready, and nothing is mounted in the meantime.
     *
     * In practice this tick rarely happens at all — `_app.js` renders no page until its auth gate has
     * run in an effect, by which time the router is ready. It is guarded anyway, because "rarely" is
     * not a property anyone can see when it stops being true.
     */
    const view = router.isReady ? normaliseRevenueView(router.query.view) : null;
    let selectedIndex = 0;
    if (view) {
        selectedIndex = REVENUE_VIEW_ORDER.indexOf(view);
    }

    /**
     * Switch tabs by NAVIGATING, because the tab is a URL.
     *
     * `push`, not `replace`: these three were three separate pages with three separate history
     * entries until now, and Back returning to the view you came from is the behaviour people
     * already have. `shallow` because there is no server-side data fetching on this route — the URL
     * changes, the page does not remount, and each view's own effect handles its own reload.
     *
     * ⚠️ The index is resolved through `REVENUE_VIEW_ORDER`, the same list `TABS` was built from, so
     * the two cannot disagree about which tab index means which view.
     *
     * @param {Number} index - The tab index Polaris selected.
     * @returns {void}
     */
    const handleSelectTab = useCallback((index) => {
        const next = REVENUE_VIEW_ORDER[index];
        if (!next) {
            return;
        }
        // ⚠️ Polaris fires `onSelect` for a click on the ALREADY-SELECTED tab. Pushing there would
        // stack a history entry for the URL you are already on, so the first Back press would appear
        // to do nothing — once per idle click, invisibly accumulating.
        if (next === view) {
            return;
        }
        router.push(revenueViewHref(next), undefined, { shallow: true });
    }, [router, view]);

    let activeView = null;
    if (appId && view === REVENUE_VIEWS.REVENUE) {
        activeView = <RevenueView appId={appId} appHydrated={appHydrated} dateRange={dateRange} />;
    } else if (appId && view === REVENUE_VIEWS.COUNTRIES) {
        // ⚠️ NO `dateRange` PROP, deliberately — its endpoint accepts no window and a prop it
        // quietly ignored would look exactly like one it honoured. See `CountryView`'s header.
        activeView = <CountryView appId={appId} appHydrated={appHydrated} />;
    } else if (appId && view === REVENUE_VIEWS.CHURN) {
        activeView = <ChurnView appId={appId} appHydrated={appHydrated} dateRange={dateRange} />;
    }

    return (
        <SideNavBar>
            <Page
                title="Revenue"
                subtitle="What the app earns, where it comes from, and what is moving — three views of one period."
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
                        no app list there is no `appId`, so none of the three views ever fires.
                        Nothing retries on a timer (the provider says why), so the way out is
                        offered here. */}
                    {appsState === APPS_STATE.ERROR ? (
                        <Banner
                            tone="critical"
                            title="The partner app list could not be loaded"
                            action={{ content: 'Try again', onAction: refreshApps }}
                        >
                            <p>{appsError}</p>
                        </Banner>
                    ) : null}

                    {/* THE "NO APP SELECTED" CASE, which the Revenue page never had and the
                        Countries page did. Silence is safe but it is not an answer: an operator
                        who has not picked a partner app got a page with a title, a tab strip and a
                        blank body, which reads as a broken build.

                        No state gate needed: `apps.length > 0` is only ever true of a roster we
                        actually received, and "none is selected" is a fact about this browser
                        rather than about the operator's business. */}
                    {appHydrated && apps.length > 0 && !appId ? (
                        <Banner tone="info" title="Select a partner app">
                            <p>Choose an app from the picker in the side nav to see its revenue.</p>
                        </Banner>
                    ) : null}

                    {/* ⚠️ THE STRIP IS ITS OWN CARD AND THE VIEW IS NOT INSIDE IT. The funnel and
                        traffic-source pages put both in one `Card padding="0"` because their tab
                        content is a single panel; each view here is a whole page of Cards, and
                        nesting a Card inside a Card draws a border inside a border. The strip
                        therefore reads as what it is — a control that switches the page beneath it.

                        Gated on `view` rather than rendered eagerly: until the router is ready
                        there is no honest answer to "which tab is selected", and a strip that
                        highlights Revenue for one tick before jumping to Churn is a strip that
                        lies about where a deep link landed. */}
                    {/* ⚠️ NO PER-TAB WINDOW LINE HERE, and it was written and then taken out.
                        Each view already states its own window directly above its own figures —
                        `PeriodHeading` on Revenue, a standing notice on the other two — and a
                        second copy of that sentence fifty pixels higher is the "two sentences for
                        one fact" the funnel page documents: a reader meeting the same caveat twice
                        reads it as two separate problems. A caveat belongs next to the number it
                        qualifies, which is inside the view, not on the strip that switches views. */}
                    {appId && view ? (
                        <Card padding="0">
                            <Tabs tabs={TABS} selected={selectedIndex} onSelect={handleSelectTab} />
                        </Card>
                    ) : null}

                    {/* ONE VIEW MOUNTED AT A TIME, AND THE OTHER TWO GENUINELY UNMOUNTED.
                        Not CSS-hidden: recharts' ResponsiveContainer measures its parent, and a
                        `display: none` parent measures 0, so every chart on a hidden tab would come
                        back collapsed. Unmounting is also what makes the fetch lazy — a view's own
                        effect is its request, so no request is issued for a tab nobody opened. */}
                    {activeView}
                </BlockStack>
            </Page>
            {toastMarkup}
        </SideNavBar>
    );
};

export default RevenuePage;
