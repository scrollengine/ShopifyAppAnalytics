import {
    Page, Card, BlockStack, InlineStack, Text, Select, Badge,
    TextField, Pagination, Tabs, Button, Tooltip, Tag, Banner
} from '@shopify/polaris';
import { SortAscendingIcon, SortDescendingIcon } from '@shopify/polaris-icons';
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import SideNavBar from '../../components/sideNavBar';
import LoaderContext from '../../contexts/loaderContext';
import { APPS_STATE, useGrowthIntel } from '../../contexts/growthIntelContext';
import GrowthIntelSubscriptionApiService from '../../API_Services/growth-intel/subscriptionService';
import StoreTable from '../../components/growth-intel/store/StoreTable';
import {
    SUBSCRIPTION_TABS,
    STORE_STATE_LABELS as SUBSCRIPTION_STATE_LABELS
} from '../../components/growth-intel/store/storePresentation';
import SubscriptionFacetFilter from '../../components/growth-intel/SubscriptionFacetFilter';
import DataStateSection from '../../components/growth-intel/DataStateSection';
import { pendingDataState, readDataState } from '../../components/growth-intel/dataState';

const SUBS_API = new GrowthIntelSubscriptionApiService();

const PAGE_SIZE = 25;

// This page's slice of the shared column registry. `came_from` sits right after the store so the
// question "where did this customer come from" is answered next to who they are, the same position
// it occupies in the install cohort.
const SUBSCRIPTION_COLUMNS = [
    'store',
    'came_from',
    'plan',
    'status',
    'monthly_spend',
    'total_spend',
    'activation_date',
    'conversion_date',
    'churn_date'
];

const SORT_OPTIONS = [
    { label: 'Activation date', value: 'activation_date' },
    { label: 'Conversion date', value: 'conversion_date' },
    { label: 'Churn date', value: 'churn_date' },
    { label: 'Monthly spend', value: 'monthly_spend' },
    { label: 'Total spend', value: 'total_spend' },
    { label: 'Customer', value: 'customer_name' },
    { label: 'Plan', value: 'plan_name' }
];

/**
 * A figure the server actually published, or null.
 *
 * ⚠️ `Number(null)` is 0, so the obvious `Number.isFinite(Number(v))` test converts a deliberate
 * null — the shape this API uses for "not measured" — into a confident zero. That is the
 * IMPLEMENTATION.md §4.5 regression in miniature, which is why the null check comes first.
 *
 * @param {*} value - A count taken off a response.
 * @returns {Number|null} The number, or null when the server published none.
 */
const _figure = (value) => {
    if (value === null || value === undefined) {
        return null;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

/**
 * The "N subscriptions · page X of Y" line, or null when the response carried no figures.
 *
 * It never falls back to `{ page: 1, pages: 1, total: 0 }`. That default is what let this page
 * publish "0 subscriptions · page 1 of 1" underneath a `GET /api/subscriptions` that does not exist
 * — a checkable claim about the operator's paying customers that no endpoint made. A missing figure
 * withdraws the sentence instead of inventing one; a total of 0 on a READY response is a MEASURED
 * empty and still prints, because that one is an answer.
 *
 * @param {Object|null} pagination - The response's `pagination` block, or null.
 * @returns {String|null} The summary, or null when it cannot be stated.
 */
const _paginationSummary = (pagination) => {
    if (!pagination) {
        return null;
    }
    const total = _figure(pagination.total);
    const page = _figure(pagination.page);
    const pages = _figure(pagination.pages);
    if (total === null || page === null || pages === null) {
        return null;
    }
    // `pages` is `Math.ceil(total/limit)` with no floor, so it is legitimately 0 on an empty
    // result — clamp for display only.
    return `${total.toLocaleString()} subscriptions · page ${page} of ${Math.max(pages, 1)}`;
};

/**
 * The reconciliation line: who the fold SAW and this list does not show.
 *
 * The service publishes `population.excluded` so a reader can CHECK the population by hand —
 * `stores_known === status_counts.ALL + never_settled_a_subscription + settled_but_not_paying_now`
 * holds by construction. None of it reached the screen, so the page asserted a population it never
 * described and could not be reconciled against the Stores page at all.
 *
 * ⚠️ EVERY FIGURE THROUGH `_figure`, and a missing one WITHDRAWS ITS CLAUSE rather than printing 0.
 * "0 stores settled a subscription and have since stopped paying" is a specific all-clear about
 * churn, and a response that omitted the field made no such claim.
 *
 * @param {Object|null} excluded - `population.excluded` as the API sent it.
 * @returns {String|null} The sentence, or null when no figure supports one.
 */
const _exclusionSummary = (excluded) => {
    if (!excluded) {
        return null;
    }
    const known = _figure(excluded.stores_known);
    const neverSettled = _figure(excluded.never_settled_a_subscription);
    const stopped = _figure(excluded.settled_but_not_paying_now);

    // Built by pushing into an array rather than by a ternary chain — the chain can only ever
    // render one clause, which is a bug that exists elsewhere in this repo.
    const clauses = [];
    if (neverSettled !== null) {
        clauses.push(`${neverSettled.toLocaleString()} never settled a subscription`);
    }
    if (stopped !== null) {
        clauses.push(`${stopped.toLocaleString()} settled one and have since stopped paying`);
    }
    if (clauses.length === 0) {
        return null;
    }

    let lead = 'Absent from this list: ';
    if (known !== null) {
        lead = `Of the ${known.toLocaleString()} stores this app has any record of, `;
    }
    return `${lead}${clauses.join(' and ')}. Both groups are ABSENT here rather than present with a `
        + 'different status, so no count and no trend taken from this page can include them.';
};

/**
 * THE EXCLUSION A READER CAME FOR: the churn this list is structurally unable to show.
 *
 * `settled_but_not_paying_now` is the stores that paid and stopped. On a page titled
 * "Subscriptions" their absence looks exactly like their non-existence, and the service's own
 * header calls that "a trap you can walk into with entirely correct numbers". Counting them here is
 * the only thing on the page that makes the absence visible.
 *
 * Withheld at 0 on purpose: a measured zero is already stated by the reconciliation line above, and
 * repeating it in bold as "0 stores churned" reads as a finding rather than as an empty set.
 *
 * @param {Object|null} excluded - `population.excluded` as the API sent it.
 * @returns {String|null} The sentence, or null when there is nothing to report.
 */
const _churnAbsenceLine = (excluded) => {
    if (!excluded) {
        return null;
    }
    const stopped = _figure(excluded.settled_but_not_paying_now);
    if (stopped === null || stopped <= 0) {
        return null;
    }
    const subject = stopped === 1
        ? '1 store paid at some point and is not paying now'
        : `${stopped.toLocaleString()} stores paid at some point and are not paying now`;
    return `${subject} — that is churn, and this list cannot show it. The Logo Churn and Revenue `
        + 'Churn pages measure it; the Stores page is the list whose population is every store ever.';
};

/**
 * The knob that decides membership, published beside the membership.
 *
 * A MEASUREMENT DECISION rather than a tunable: widen the window and stores join this list, narrow
 * it and they leave, having done nothing at all. An operator reconciling this page against
 * Shopify's own has to be able to see it.
 *
 * @param {Object|null} population - `data.population` as the API sent it.
 * @returns {String|null} The sentence, or null when the response published no window.
 */
const _liveWindowLine = (population) => {
    const days = _figure(population && population.live_window_days);
    if (days === null) {
        return null;
    }
    return `Membership is decided over a ${days.toLocaleString()}-day live window on the settled-payout `
        + 'ledger — the same predicate the Revenue page uses, so the two cannot disagree about who is paying.';
};

/**
 * Every store on this app that is CURRENTLY PAYING, with its plan, lifecycle status and spend.
 *
 * ⚠️ Read the population before reading the numbers: stores that never subscribed and stores that
 * paid and then churned are both ABSENT here rather than present with a different status. The Stores
 * page is the one whose population is every store ever — see `subscriptionService`'s own note.
 *
 * `GET /api/subscriptions` IS LIVE. It answered with the not-implemented envelope until the
 * per-shop projection over the payout ledger was built, and every render below took a non-READY
 * path. The gating stays exactly as it was: the table, the facet filters, the status tab counts and
 * the pagination summary are all held behind `<DataStateSection>`, because the four kinds of nothing
 * it separates — not built, not connected, never synced, request failed — did not go away when one
 * of them did. This page previously drew "0 subscriptions · page 1 of 1" as finished UI, which is a
 * claim about the operator's paying customers that no response produced.
 *
 * ⚠️ `data_state` is decided by the WATERMARK, never the row count, so `items: []` on a READY
 * response is a MEASURED empty and the table's own empty state is the honest thing to draw. An app
 * that has synced and genuinely has no paying customers says so through `warnings[]`.
 *
 * @returns {JSX.Element}
 */
const SubscriptionsPage = () => {
    const { toastMarkup } = useContext(LoaderContext) || {};

    // The app selection lives in the side nav now — one picker for the whole section.
    // `apps`/`appsState`/`appsError` are read for the roster banners alone — the table itself is
    // gated on `appId`. ⚠️ `appsLoading` is NOT taken any more: an empty roster while a request is in
    // flight and an empty roster after one failed are not the same answer, and `appsState` is the
    // field that knows which. `refreshApps` is the only retry — nothing re-asks on a timer.
    const { apps, appId, appsState, appsError, refreshApps, hydrated: appHydrated } = useGrowthIntel();
    /**
     * The decoded response, not the payload.
     *
     * Holds one of the six DATA_STATE values, and `pendingDataState()` until the first answer lands.
     * `readDataState` nulls `.data` in every state except READY, so nothing downstream can read a
     * figure out of a refusal.
     */
    const [listState, setListState] = useState(pendingDataState());
    const [loading, setLoading] = useState(false);

    const [page, setPage] = useState(1);
    const [query, setQuery] = useState('');
    // Debounced separately so typing does not fire a request per keystroke.
    const [appliedQuery, setAppliedQuery] = useState('');
    // The status tabs are now a shortcut into the `states` facet group rather than a second,
    // competing filter mechanism — one selected state means one highlighted tab.
    const [facets, setFacets] = useState({ states: [], install_states: [], billing: [], store_statuses: [] });
    const [sort, setSort] = useState('activation_date');
    const [dir, setDir] = useState('desc');

    useEffect(() => {
        const t = setTimeout(() => {
            setAppliedQuery(query);
            setPage(1);
        }, 350);
        return () => clearTimeout(t);
    }, [query]);

    // Switching the app from the side nav has to reset pagination — page 3 of one app's
    // subscriptions is not page 3 of another's, and the server would return an empty page.
    // The old in-page picker did this in its onChange; the selection is now external, so the
    // reset has to hang off the value itself.
    useEffect(() => { setPage(1); }, [appId]);

    const fetchData = useCallback((opts) => {
        if (!appId || !appHydrated) return;
        setLoading(true);
        const params = { partner_app_id: appId, page, limit: PAGE_SIZE, q: appliedQuery, sort, dir };
        // Empty groups are OMITTED rather than sent as '' — an empty group is a no-op server-side,
        // and leaving it out keeps the URL readable.
        for (const key of Object.keys(facets)) {
            if (facets[key].length > 0) {
                params[key] = facets[key].join(',');
            }
        }
        // The row set is cached server-side for a few minutes; this forces a rebuild.
        if (opts && opts.refresh) params.refresh = true;
        SUBS_API.list(params, (resp) => {
            setLoading(false);
            // The old guard here was `if (resp && resp.status && resp.data) ... else setData(null)`,
            // which folded "not built", "not connected", "never synced" and "the request failed" into
            // one indistinguishable null — and the page then drew its own zeros over the top.
            // `readDataState` keeps the four apart and carries the server's own sentence with them.
            setListState(readDataState(resp));
        });
    }, [appId, appHydrated, page, appliedQuery, facets, sort, dir]);

    useEffect(() => { fetchData(); }, [fetchData]);

    // The payload, or null. Null in PENDING, NOT_IMPLEMENTED, NOT_CONNECTED, NEVER_SYNCED and ERROR
    // alike, so every read below is a read of a measured answer or of nothing.
    const data = listState.data;
    /**
     * Null, NOT `[]`, when the response carried no array.
     *
     * `|| []` hands `StoreTable` an empty list, and its empty state — "No stores match these
     * filters" — is a claim about the operator's paying customers that no response made. The
     * `loading` prop below keeps the table in its skeleton form until a real list exists, so the only
     * empty state this page ever draws is a measured one.
     */
    const items = data && Array.isArray(data.items) ? data.items : null;
    // Null rather than `{ page: 1, pages: 1, total: 0 }`: the summary line is withheld when there is
    // nothing to state, rather than being printed with manufactured figures.
    const pagination = (data && data.pagination) || null;
    // These DO still default to empty, and it is not the same defaulting: an empty map or list here
    // renders nothing at all — no tab count, no chip — so each withdraws a claim instead of
    // manufacturing one, and every consumer of them is inside the gated section.
    const counts = (data && data.status_counts) || {};
    // Counts with every OTHER facet applied, so a tab number predicts how many rows clicking it
    // shows. Falls back to the app-wide map on an older response that lacks the field.
    const countsFiltered = (data && data.status_counts_filtered) || counts;
    const facetGroups = (data && data.facet_groups) || [];
    /**
     * What the response could not cover, in the service's own words.
     *
     *  THE ONE THAT MATTERS MOST ON THIS PAGE is the empty-ledger sentence: this list's entire
     * population comes from the settled-payout ledger, so an empty ledger empties the table — and an
     * empty Subscriptions table reads as "you have no paying customers". The service publishes that
     * distinction as a warning rather than as a `data_state`, because `earliest_transaction_at` is a
     * row count in disguise and cannot tell "we never fetched any" from "this app genuinely has
     * none". Without this banner the page shows the empty table and says nothing.
     *
     * Also carries the BigQuery-unconfigured notice — attribution answers `has_attribution: false`
     * with a reason rather than refusing, and this is where the reason surfaces.
     */
    const warnings = (data && Array.isArray(data.warnings)) ? data.warnings : [];

    /**
     * WHAT THIS LIST IS A LIST OF — published on every response, and rendered nowhere.
     *
     * The page's subtitle read "Every store on this app with its plan, lifecycle status and spend"
     * over a population of `CURRENTLY_PAYING`, which is the exact opposite claim: stores that never
     * subscribed and stores that paid and then churned are both absent. The service publishes
     * `population.key`, `.label`, `.statement`, `.live_window_days` and `.excluded` precisely so the
     * page cannot say that — and the page read none of them.
     *
     * `null` outside READY, like every other derivation here, so the panel below is drawn only over
     * a payload that actually described its own population.
     */
    const population = (data && data.population) || null;
    const populationExcluded = (population && population.excluded) || null;
    const exclusionSummary = _exclusionSummary(populationExcluded);
    const churnAbsence = _churnAbsenceLine(populationExcluded);
    const liveWindowLine = _liveWindowLine(population);

    /**
     * The subtitle, taken from the response wherever the response has one.
     *
     * ⚠️ The fallback is a statement about the ENDPOINT, not about the data: this route's population
     * is fixed by its contract, so "who is paying for this app right now" is true before any payload
     * arrives and stays true when none does. Restating the old "every store on this app" here would
     * reintroduce the defect on exactly the paths that have no payload to correct it.
     */
    let pageSubtitle = 'Who is paying for this app right now — one row per store on a paid plan today';
    if (population && population.label) {
        pageSubtitle = `${population.label} — each store's plan, lifecycle status and spend`;
    }

    // Withheld rather than zeroed: "Search 0 subscriptions by store, domain or plan" is a claim, and
    // before the first response there is no count to make it with.
    const searchTotal = _figure(countsFiltered.ALL);
    let searchPlaceholder = 'Search subscriptions by store, domain or plan';
    if (searchTotal !== null) {
        searchPlaceholder = `Search ${searchTotal.toLocaleString()} subscriptions by store, domain or plan`;
    }

    const summaryLine = _paginationSummary(pagination);

    const tabs = useMemo(() => SUBSCRIPTION_TABS.map((t) => {
        let label = t.label;
        if (countsFiltered[t.id] !== undefined) {
            label = `${t.label} (${countsFiltered[t.id].toLocaleString()})`;
        }
        return { id: t.id, content: label };
    }), [countsFiltered]);

    // A tab is only "selected" when exactly one state is chosen. Pick two from the Filters popover
    // and no single tab describes the view, so it falls back to ALL rather than lying about which
    // one is active.
    let selectedTab = 0;
    if (facets.states.length === 1) {
        selectedTab = Math.max(SUBSCRIPTION_TABS.findIndex((t) => t.id === facets.states[0]), 0);
    }

    const setFacetGroup = useCallback((key, next) => {
        setFacets((prev) => ({ ...prev, [key]: next }));
        // Without this the table can sit on page 5 of a 1-page result and render empty, which reads
        // as "the filter is broken" when it worked.
        setPage(1);
    }, []);

    const clearAllFacets = useCallback(() => {
        setFacets({ states: [], install_states: [], billing: [], store_statuses: [] });
        setPage(1);
    }, []);

    const handleTabChange = useCallback((idx) => {
        const id = SUBSCRIPTION_TABS[idx].id;
        // ALL clears the group; any other tab selects exactly that one state, replacing whatever the
        // popover had. The tabs are a shortcut, so they take over the group rather than adding to it.
        let next = [];
        if (id !== 'ALL') {
            next = [id];
        }
        setFacetGroup('states', next);
    }, [setFacetGroup]);

    // Chips for what is applied, built by pushing into an array — a ternary chain here can only ever
    // render one pill (a bug that exists elsewhere in this repo).
    const appliedChips = useMemo(() => {
        const chips = [];
        for (const group of facetGroups) {
            for (const option of (group.options || [])) {
                if (((facets[group.key]) || []).includes(option.value)) {
                    chips.push({
                        key: `${group.key}:${option.value}`,
                        label: `${group.label}: ${option.label}`,
                        groupKey: group.key,
                        value: option.value
                    });
                }
            }
        }
        return chips;
    }, [facetGroups, facets]);

    const handleExport = useCallback(() => {
        // No measured list, nothing to export. The action is disabled in that state; this guard is
        // what stops a keyboard-triggered export from writing a header-only CSV, which reads as a
        // confident "this app has no subscriptions" once it is out of the dashboard and in a
        // spreadsheet where no banner travels with it.
        if (!items || items.length === 0) {
            return;
        }
        // Exports the CURRENT page only — the endpoint is paginated, and silently
        // re-fetching every page here would misrepresent what was exported.
        const header = [
            'Customer', 'Domain', 'Plan', 'Plan price', 'Status',
            'Monthly spend', 'Total spend', 'Activation date', 'Conversion date', 'Churn date'
        ];
        const rows = items.map((r) => [
            r.customer_name, r.shop_domain, r.plan_name, r.plan_price,
            SUBSCRIPTION_STATE_LABELS[r.status] || r.status,
            r.monthly_spend, r.total_spend,
            r.activation_date || '', r.conversion_date || '', r.churn_date || ''
        ]);
        const csv = [header, ...rows]
            .map((line) => line.map((c) => `"${String(c === null || c === undefined ? '' : c).replace(/"/g, '""')}"`).join(','))
            .join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        // A file name, not a published figure — so a fallback is harmless here, and `pagination` is
        // non-null on every path that reaches this line anyway (`items` is only an array in READY).
        a.download = `subscriptions-page-${(pagination && pagination.page) || 1}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }, [items, pagination]);

    return (
        <SideNavBar>
            <Page
                fullWidth
                title="Subscriptions"
                subtitle={pageSubtitle}
                secondaryActions={[
                    { content: 'Refresh', onAction: () => fetchData({ refresh: true }), loading },
                    // `!items` — no measured list — disables it too, so the action is never offered
                    // over a response that does not exist.
                    { content: 'Export page', onAction: handleExport, disabled: !items || items.length === 0 }
                ]}
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

                    {/* THE POPULATION, ABOVE THE FIGURES IT GOVERNS.
                        Not decoration and not a footnote: every count on this page is correct AND
                        misleading unless the reader knows the churned are absent rather than
                        present-with-a-status. `subscriptionList.service` calls it "a trap you can
                        walk into with entirely correct numbers" and publishes the whole block for
                        this panel; until now the block reached the wire and stopped there.

                        A sibling of the gated card rather than a child, for the same reason the
                        warnings banner is: `population` is derived from `data`, which is null in
                        every state except READY, so this draws nothing on the paths where the
                        DataStateSection below is already explaining the absence. */}
                    {population ? (
                        <Card>
                            <BlockStack gap="200">
                                <InlineStack gap="200" blockAlign="center" wrap>
                                    <Text as="h2" variant="headingSm">Who is on this list</Text>
                                    {population.label ? <Badge tone="info">{population.label}</Badge> : null}
                                </InlineStack>
                                {/* THE SERVICE'S OWN SENTENCE, not a paraphrase. It names the
                                    predicate, names the two absent groups and names the endpoint
                                    that has them; a copy here would be the half that silently stops
                                    matching the day the predicate changes. */}
                                {population.statement ? (
                                    <Text as="p" variant="bodySm" tone="subdued">{population.statement}</Text>
                                ) : null}
                                {exclusionSummary ? (
                                    <Text as="p" variant="bodySm" tone="subdued">{exclusionSummary}</Text>
                                ) : null}
                                {/* Not subdued, deliberately: this is the number a reader of a churn
                                    figure needs and the one the page cannot otherwise show. */}
                                {churnAbsence ? (
                                    <Text as="p" variant="bodySm">{churnAbsence}</Text>
                                ) : null}
                                {liveWindowLine ? (
                                    <Text as="p" variant="bodyXs" tone="subdued">{liveWindowLine}</Text>
                                ) : null}
                            </BlockStack>
                        </Card>
                    ) : null}

                    {/* Sibling of the gated card, not a child of it: `data` is null in every state
                        except READY, so this renders nothing on the paths where the banner below is
                        already explaining the absence — and it never competes with it. Keyed by the
                        string, which the service's catalogue guarantees is unique. */}
                    {warnings.length > 0 ? (
                        <Banner tone="warning">
                            <BlockStack gap="100">
                                {warnings.map((w) => (<p key={w}>{w}</p>))}
                            </BlockStack>
                        </Banner>
                    ) : null}

                    {/* EVERYTHING THE CARD STATES IS A FIGURE, so the card itself is what is
                        gated — the table, the facet filters, the status tab counts and the
                        pagination summary alike. In a non-READY state this renders the server's own
                        sentence (which names `GET /api/subscriptions`) and NOTHING in the card's
                        place; a "0 subscriptions" line beside that banner is exactly the regression
                        being fixed. */}
                    {/* THE `appId` GATE IS PART OF THE CONTRACT, not decoration. `fetchData`
                        returns early with no app selected and never touches `loading`, so this
                        section would otherwise sit in PENDING for good — and a permanent PENDING
                        under a permanent `loading: false` is the one thing this page cannot explain
                        with a banner, because no response exists to quote. With no app chosen there
                        is nothing to say about any app's subscriptions, so nothing is said.
                        `loading={loading}` is the other half: it is the SAME flag `StoreTable` gets
                        below, so the skeleton the child draws for an in-flight request and the
                        nothing this wrapper draws for a request that was never made stay in step. */}
                    {appId ? (
                        <DataStateSection state={listState} loading={loading}>
                            <Card padding="0">
                                <Tabs tabs={tabs} selected={selectedTab} onSelect={handleTabChange} />
                                {/* Sort sits in the SAME row as the search rather than in a card of its own
                                    above the table: both narrow the same list, and a separate panel read as
                                    a page-level setting instead of a filter on this table. `wrap` (not
                                    wrap={false}) so the controls stack on a narrow viewport instead of
                                    crushing the search field. */}
                                <div style={{ padding: '12px 16px' }}>
                                    <InlineStack gap="200" blockAlign="center" wrap>
                                        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                                            <TextField
                                                label=""
                                                labelHidden
                                                placeholder={searchPlaceholder}
                                                value={query}
                                                onChange={setQuery}
                                                clearButton
                                                onClearButtonClick={() => setQuery('')}
                                                autoComplete="off"
                                            />
                                        </div>
                                        <SubscriptionFacetFilter
                                            groups={facetGroups}
                                            value={facets}
                                            onChange={setFacetGroup}
                                            onClearAll={clearAllFacets}
                                        />
                                        {/* `labelInline` keeps "Sort by" visible inside the control. Without
                                            it a bare "Activation date" gives no clue what it does, and a
                                            stacked label would misalign against the single-row search. */}
                                        <div style={{ flex: '0 0 auto', minWidth: 230 }}>
                                            <Select
                                                label="Sort by"
                                                labelInline
                                                options={SORT_OPTIONS}
                                                value={sort}
                                                onChange={(v) => { setSort(v); setPage(1); }}
                                            />
                                        </div>
                                        <Tooltip content={dir === 'desc' ? 'Sorted high to low — switch to low to high' : 'Sorted low to high — switch to high to low'}>
                                            <Button
                                                icon={dir === 'desc' ? SortDescendingIcon : SortAscendingIcon}
                                                accessibilityLabel={dir === 'desc' ? 'Sort ascending' : 'Sort descending'}
                                                onClick={() => { setDir(dir === 'desc' ? 'asc' : 'desc'); setPage(1); }}
                                            />
                                        </Tooltip>
                                    </InlineStack>
                                </div>

                                {/* What is applied, as removable chips. Combining four groups from inside a
                                    popover is otherwise invisible once it closes — the count on the button
                                    says how many, the chips say which. */}
                                {appliedChips.length > 0 ? (
                                    <div style={{ padding: '0 16px 12px' }}>
                                        <InlineStack gap="150" blockAlign="center" wrap>
                                            {appliedChips.map((chip) => (
                                                <Tag
                                                    key={chip.key}
                                                    onRemove={() => setFacetGroup(
                                                        chip.groupKey,
                                                        facets[chip.groupKey].filter((v) => v !== chip.value)
                                                    )}
                                                >
                                                    {chip.label}
                                                </Tag>
                                            ))}
                                            <Button variant="plain" onClick={clearAllFacets}>Clear all filters</Button>
                                        </InlineStack>
                                    </div>
                                ) : null}

                                <StoreTable
                                    rows={items}
                                    columns={SUBSCRIPTION_COLUMNS}
                                    appId={appId}
                                    /* `items === null` means "no measured list", which includes the frame
                                       before the first response and an app that has not been chosen yet.
                                       Without it the table falls through to its empty state and announces
                                       "No stores match these filters" over a question nobody has answered. */
                                    loading={loading || items === null}
                                    emptyHeading="No stores match these filters"
                                    emptyBody={(
                                        <BlockStack gap="300" inlineAlign="center">
                                            <Text as="p" tone="subdued">
                                                Try removing a filter or clearing the search.
                                            </Text>
                                            {appliedChips.length > 0 ? (
                                                <Button onClick={clearAllFacets}>Clear all filters</Button>
                                            ) : null}
                                        </BlockStack>
                                    )}
                                />

                                {/* The whole footer exists only when the response carried figures. A count
                                    line beside an explanatory banner is the precise failure being fixed: the
                                    banner is abstract, "0 subscriptions" is concrete, and the reader believes
                                    the concrete one. */}
                                {pagination ? (
                                    <div style={{ padding: '12px 16px', borderTop: '1px solid var(--p-color-border-secondary)' }}>
                                        <InlineStack align="space-between" blockAlign="center">
                                            {summaryLine ? (
                                                <Text as="span" variant="bodySm" tone="subdued">{summaryLine}</Text>
                                            ) : null}
                                            <Pagination
                                                hasPrevious={pagination.page > 1}
                                                onPrevious={() => setPage((p) => Math.max(p - 1, 1))}
                                                hasNext={pagination.page < pagination.pages}
                                                onNext={() => setPage((p) => p + 1)}
                                            />
                                        </InlineStack>
                                    </div>
                                ) : null}
                            </Card>
                        </DataStateSection>
                    ) : null}
                </BlockStack>
            </Page>
            {toastMarkup}
        </SideNavBar>
    );
};

export default SubscriptionsPage;
