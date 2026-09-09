import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import GrowthIntelPartnerAppApiService from '../API_Services/growth-intel/partnerAppService';
import { isDashboardRoute } from '../utils/dashboardRoutes';

/**
 * The partner-app selection, shared by every growth-intelligence page.
 *
 * WHY THIS EXISTS
 * ---------------
 * Eleven pages each owned their own `appId` state AND their own `PARTNER_API.list` call. Two
 * consequences, both real:
 *   · walking the module refetched the same app list on every page load;
 *   · the selection did not survive navigation, so picking an app on Revenue and clicking through
 *     to Traffic Sources silently reset you to whichever app happened to sort first.
 * One selection, fetched once, persisted — and the picker moves into the side nav where it reads as
 * a property of the whole section rather than of one screen.
 *
 * SCOPED TO THE GROWTH SECTION ON PURPOSE
 * ---------------------------------------
 * The provider is mounted app-wide (it has to be, so the nav and the pages share one value) but it
 * only fetches while the current route is one of the twelve dashboard screens listed in
 * `utils/dashboardRoutes.js`. The root redirect and the login form know nothing about partner apps
 * and must not pay for a request they never read.
 *
 * "YOU HAVE NO APPS" AND "WE COULD NOT ASK" ARE DIFFERENT ANSWERS
 * ------------------------------------------------------------------
 * This callback used to read, in full:
 *
 *     setAppsLoading(false);
 *     if (!resp || !resp.status || !resp.data || !Array.isArray(resp.data.items)) {
 *         setApps([]);
 *         return;              // <- setFetched(true) never ran
 *     }
 *
 * and it shipped TWO defects on every page in the section at once, because this is the one context
 * they all depend on:
 *
 *   1. A 500, a dropped connection or an expired session all landed on `apps: []`, and `apps.length
 *      === 0` was rendered by the side-nav picker as "No partner apps yet" and by the Apps page as
 *      "Register your Shopify app to begin". A transport failure presented as a measured fact about
 *      the operator's account — the §4.5 regression, one layer further out than the pages that were
 *      hardened against it. `appsState` is what separates the two, and `apps` is NO LONGER EMPTIED
 *      on failure: a roster we did measure once stays on screen rather than being replaced by a
 *      claim we cannot support.
 *
 *      ⚠️ THE STATE ALONE FIXES NOTHING — IT HAS TO BE READ. Publishing `appsState` while twelve
 *      consumers still gated on `apps.length === 0` left the defect exactly where it was on eight
 *      of them, under a header claiming it was closed. All twelve are migrated now (the four
 *      revenue/churn/subscription pages, plus `sideNavBar`, `apps`, `stores`, `sync`, `funnel`,
 *      `trial-funnel`, `traffic-sources` and `countries`), and a NEW consumer that draws an empty
 *      roster is the only way back in. `apps` being `[]` on a FIRST-load failure is why keeping the
 *      last measured roster cannot cover for a missing gate: there is nothing to keep.
 *   2. The fetch effect guarded on `fetched`, which only ever became true on the success path, and
 *      DEPENDED on `appsLoading`, which had just gone false. So a failure re-armed the effect
 *      immediately and the section retried as fast as the API could fail. `attempted` is now set in
 *      EVERY branch — it records that we ASKED, not that we got an answer — and the in-flight guard
 *      moved to a ref so the loading flag is no longer a re-render trigger at all.
 *
 * AND THE 401 IS A THIRD CASE, NOT AN ERROR. `resource_access: 'NOT_ALLOWED'` means the axios
 * interceptor has already cleared the token and started the redirect to /login. Rendering "the app
 * list could not be loaded" over a session that merely timed out sends the operator to look at a
 * backend that is working. It gets its own state, and consumers draw nothing for it.
 */

const STORAGE_KEY = 'gi.partnerAppId';

const PARTNER_API = new GrowthIntelPartnerAppApiService();

/**
 * What is known about the ROSTER — never about the operator's business.
 *
 * Deliberately the same vocabulary as `components/growth-intel/dataState.js`, which decodes the
 * per-page endpoints, so a reader moving between the two is reading one idea. It is a separate,
 * smaller enum because the roster endpoint cannot answer NOT_IMPLEMENTED (it is live), and because
 * the 401 must NOT collapse into ERROR here — see the header.
 *
 * ⚠️ Consumers gate the empty state on `appsState === APPS_STATE.READY`, never on `apps.length
 * === 0` alone, and never on `!appsLoading` — that flag is false BEFORE a request and false after
 * one has FAILED, so it cannot tell "still asking" from "we could not ask". An empty roster is only
 * a fact about the account in READY; in every other state it is the absence of an answer.
 */
export const APPS_STATE = {
    /** No answer yet. Covers "never asked" (outside the section) and "asked, still in flight". */
    PENDING: 'PENDING',
    /** A measured roster. `apps` is the answer, and `[]` here genuinely means no partner apps. */
    READY: 'READY',
    /** We could not ask, or the API refused. `appsError` carries the server's own sentence. */
    ERROR: 'ERROR',
    /** The 401 sentinel. The redirect to /login is already under way; draw nothing. */
    UNAUTHENTICATED: 'UNAUTHENTICATED'
};

/** Used only when the API sent no message of its own — its sentence is always the better one. */
const APPS_ERROR_FALLBACK = 'The partner app list could not be loaded, so which apps exist is unknown.';

const GrowthIntelContext = createContext({
    apps: [],
    appId: '',
    setAppId: () => {},
    selectedApp: null,
    appsLoading: false,
    // What kind of nothing an empty `apps` is. See APPS_STATE.
    appsState: APPS_STATE.PENDING,
    appsError: null,
    // False until localStorage has been read. Pages MUST gate their fetches on this: rendering on
    // the server and on the first client tick yields the pre-hydration value, so firing a request
    // before it flips means one wasted call for the wrong app on every page load.
    hydrated: false,
    isGrowthRoute: false,
    refreshApps: () => {}
});

export const GrowthIntelProvider = ({ children }) => {
    const router = useRouter();
    /**
     * AN ALLOWLIST, NOT A PREFIX TEST — and it cannot go back to being one.
     *
     * This read `router.pathname.startsWith('/growth-intel')` while every screen sat under that
     * prefix. The routes are top-level now (`/overview`, `/funnel`, …), so there is no prefix left
     * that includes the twelve dashboard pages and excludes `/` and `/login` — the shortest one
     * that matches them all is `/`, which matches everything.
     *
     * The consequence of getting this wrong is invisible: `isGrowthRoute` false means `loadApps`
     * never fires, which means `apps` stays empty, which means EVERY page renders "No partner app
     * is selected". No error, no failed request, nothing in the console. See
     * `utils/dashboardRoutes.js`, which is the one place the twelve paths are written down.
     */
    const isGrowthRoute = isDashboardRoute(router.pathname);

    const [apps, setApps] = useState([]);
    const [appId, setAppIdState] = useState('');
    const [appsLoading, setAppsLoading] = useState(false);
    const [appsState, setAppsState] = useState(APPS_STATE.PENDING);
    const [appsError, setAppsError] = useState(null);
    const [hydrated, setHydrated] = useState(false);
    /**
     * "WE HAVE ASKED", NOT "WE HAVE AN ANSWER".
     *
     * Its predecessor `fetched` was set on the success path only, which turned a failing API into a
     * request loop: the effect below re-fires whenever this is false and nothing is in flight, and
     * the failure callback restored both conditions in the same tick. Set it in EVERY branch of the
     * callback, including the ones that have nothing to show for the call.
     */
    const [attempted, setAttempted] = useState(false);
    /**
     * The in-flight guard.
     *
     * A REF rather than `appsLoading`, deliberately: the loading flag was in the effect's dependency
     * array, so it was itself a re-trigger. A ref is read at call time and changes nothing about
     * when the effect runs, which leaves exactly one thing that can start a fetch — `attempted`
     * being false.
     */
    const inFlightRef = useRef(false);

    // Read the stored selection once. Deliberately separate from the fetch: the value is useful
    // before the list arrives, so a page can start its own request without waiting on the roster.
    useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }
        try {
            const stored = window.localStorage.getItem(STORAGE_KEY);
            if (stored) {
                setAppIdState(stored);
            }
        } catch (e) { /* private mode / storage disabled — fall through to the first app */ }
        setHydrated(true);
    }, []);

    /**
     * Fetches the roster and records WHICH KIND of answer came back.
     *
     * Also the manual retry: it is exposed as `refreshApps`, and it is the only way out of the ERROR
     * state — nothing retries on a timer, because a dashboard that hammers a failing API is how the
     * failure gets worse. A consumer showing the error should offer this as a "Try again" action.
     *
     * @returns {void}
     */
    const loadApps = useCallback(() => {
        // A second call while one is in flight would race two responses into one `setApps`, and the
        // loser would win. Cheap to prevent, impossible to debug from a screenshot.
        if (inFlightRef.current) {
            return;
        }
        inFlightRef.current = true;
        setAppsLoading(true);
        // THE GUARD ABOVE LATCHES IF THE CALL NEVER REACHES ITS CALLBACK, AND A LATCHED GUARD
        // MAKES "TRY AGAIN" A SILENT NO-OP UNDER A BANNER THAT IS STILL ON SCREEN — the worst
        // failure this file can have, because the operator's only way out of ERROR is `refreshApps`
        // and there is no timer behind it.
        //
        // `_get` in `partnerAppService` calls back on every settled promise (success, 401, enveloped
        // error, transport error), so the one path that skips it is a SYNCHRONOUS throw out of
        // `list` — a request interceptor blowing up, or a malformed base URL. That throw would
        // otherwise unwind past this function with the ref still true and the loading flag still set.
        //
        // ⚠️ THIS IS NOT A TIMEOUT AND MUST NOT BECOME ONE. A request that is genuinely still in
        // flight has to keep the guard: releasing it on a timer is how two responses race into one
        // `setApps` and the loser wins, which is the race the ref exists to prevent.
        try {
            PARTNER_API.list({ limit: 100, sort: 'createdAt', dir: 'desc' }, (resp) => {
                inFlightRef.current = false;
                setAppsLoading(false);
                // EVERY PATH BELOW LEAVES THIS TRUE. See the declaration: the retry storm was one
                // early `return` that skipped it.
                setAttempted(true);

                // 1. The session is gone and the redirect to /login has already started. Not an error to
                //    report — there is nothing here for the operator to do or fix, and a critical banner
                //    flashing up during a navigation they did not ask for reads as a broken backend.
                //    Checked FIRST because this envelope carries no `status` key at all.
                if (resp && resp.resource_access === 'NOT_ALLOWED') {
                    setAppsState(APPS_STATE.UNAUTHENTICATED);
                    setAppsError(null);
                    return;
                }

                // 2. No usable roster came back.
                //
                //    `apps` IS LEFT EXACTLY AS IT WAS. The old code called `setApps([])` here, and an
                //    empty roster is rendered across this section as "No partner apps yet" — so a failed
                //    refresh deleted a list we had successfully measured and replaced it with a false
                //    statement about the operator's account. Keeping the last measured value means the
                //    worst case is STALE, which `appsState`/`appsError` then say out loud.
                if (!resp || !resp.status || !resp.data || !Array.isArray(resp.data.items)) {
                    setAppsState(APPS_STATE.ERROR);
                    // The server's own sentence when there is one — it names the reason. The fallback
                    // says only THAT we could not ask, which is still the honest half of the claim.
                    setAppsError((resp && resp.msg) || APPS_ERROR_FALLBACK);
                    return;
                }

                const items = resp.data.items;
                setAppsState(APPS_STATE.READY);
                setAppsError(null);
                setApps(items);

                // Reconcile the stored selection against the list that actually came back. A stored id
                // for an app that has since been deleted, or that belongs to a different environment
                // (a local database restored from a different dump), would otherwise leave every page
                // querying an app_id the API rejects — which renders as "no data" rather than an error.
                //
                // ⚠️ Inside the READY branch on purpose. Reconciling against a list we never received
                // would clear a perfectly good selection because the network failed.
                setAppIdState((current) => {
                    if (current && items.some((a) => a.app_id === current)) {
                        return current;
                    }
                    if (items.length > 0) {
                        return items[0].app_id;
                    }
                    return '';
                });
            });
        } catch (e) {
            // The callback will never run. Leave exactly the state that callback's failure branch
            // would have left — including `apps` UNTOUCHED, so a roster we already measured is not
            // replaced by "No partner apps yet" — and release the guard so `refreshApps` works.
            inFlightRef.current = false;
            setAppsLoading(false);
            setAttempted(true);
            setAppsState(APPS_STATE.ERROR);
            setAppsError((e && e.message) || APPS_ERROR_FALLBACK);
        }
    }, []);

    // Fetch on first entry into the growth section, and never on the pages that do not use it.
    //
    // `appsLoading` IS NOT IN THIS ARRAY. It was, together with a guard that only ever cleared on
    // success, and the pair retried the request as fast as the API could refuse it. The two
    // conditions that remain are both monotonic: `hydrated` flips once, `attempted` flips once.
    useEffect(() => {
        if (!isGrowthRoute || !hydrated || attempted) {
            return;
        }
        loadApps();
    }, [isGrowthRoute, hydrated, attempted, loadApps]);

    const setAppId = useCallback((next) => {
        setAppIdState(next || '');
        if (typeof window === 'undefined') {
            return;
        }
        try {
            if (next) {
                window.localStorage.setItem(STORAGE_KEY, next);
            } else {
                window.localStorage.removeItem(STORAGE_KEY);
            }
        } catch (e) { /* storage blocked — the selection still applies for this session */ }
    }, []);

    const selectedApp = useMemo(
        () => apps.find((a) => a.app_id === appId) || null,
        [apps, appId]
    );

    const value = useMemo(() => ({
        apps,
        appId,
        setAppId,
        selectedApp,
        appsLoading,
        appsState,
        appsError,
        hydrated,
        isGrowthRoute,
        refreshApps: loadApps
    }), [apps, appId, setAppId, selectedApp, appsLoading, appsState, appsError, hydrated, isGrowthRoute, loadApps]);

    return (
        <GrowthIntelContext.Provider value={value}>
            {children}
        </GrowthIntelContext.Provider>
    );
};

/**
 * Reads the shared partner-app selection.
 *
 * A page replaces its own `apps` / `appId` state and its `PARTNER_API.list` call with this, and gates
 * every data fetch on `appId && hydrated` exactly as it previously gated on `appId`.
 *
 * ⚠️ A page that draws an empty-roster empty state MUST gate it on `appsState === APPS_STATE.READY`.
 * `apps.length === 0` on its own is true while the request is in flight, after it failed, and after
 * a 401 — three states in which "no partner apps yet" is a claim nothing measured.
 */
export const useGrowthIntel = () => useContext(GrowthIntelContext);

export default GrowthIntelContext;
