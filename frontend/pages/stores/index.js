import {
    Page, Card, BlockStack, InlineStack, Text, Select,
    TextField, Pagination, Tabs, Button, Tooltip, Tag, Banner
} from '@shopify/polaris';
import { SortAscendingIcon, SortDescendingIcon } from '@shopify/polaris-icons';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import SideNavBar from '../../components/sideNavBar';
import LoaderContext from '../../contexts/loaderContext';
import { APPS_STATE, useGrowthIntel } from '../../contexts/growthIntelContext';
import GrowthIntelStoreApiService from '../../API_Services/growth-intel/storeService';
import StoreTable from '../../components/growth-intel/store/StoreTable';
import SubscriptionFacetFilter from '../../components/growth-intel/SubscriptionFacetFilter';
import { fmtDate } from '../../components/growth-intel/store/storePresentation';
import DataStateSection from '../../components/growth-intel/DataStateSection';
import { pendingDataState, readDataState } from '../../components/growth-intel/dataState';

const STORE_API = new GrowthIntelStoreApiService();

const PAGE_SIZE = 25;

// Install state leads: this page exists to answer "who has my app right now", and every other column
// is context for that. `came_from` sits next to identity, as on the other store tables.
const STORE_COLUMNS = [
    'store',
    'install_state',
    'came_from',
    'status',
    'plan',
    'monthly_spend',
    'total_spend',
    'installed_at'
];

const SORT_OPTIONS = [
    { label: 'First installed', value: 'installed_at' },
    { label: 'Install state changed', value: 'install_state_at' },
    { label: 'Last installed', value: 'latest_install_at' },
    { label: 'Store', value: 'customer_name' },
    { label: 'Domain', value: 'shop_domain' },
    { label: 'Monthly spend', value: 'monthly_spend' },
    { label: 'Total spend', value: 'total_spend' }
];

// A shortcut into the `install_states` facet group, exactly like the Subscriptions tabs are a shortcut
// into its `states` group.
const INSTALL_TABS = [
    { id: 'ALL', label: 'All' },
    { id: 'INSTALLED', label: 'Installed' },
    { id: 'UNINSTALLED', label: 'Uninstalled' },
    { id: 'UNKNOWN', label: 'Unknown' }
];

/**
 * Every facet group the server publishes, and ONLY those.
 *
 *  `countries` IS DELIBERATELY ABSENT, and `shopify_plans` is deliberately present. Both were
 * wrong the other way round:
 *
 *   · `countries` has NO facet group — the Revenue → By country tab links here with an ISO-2 code and the only
 *     per-store country this build holds is GA4's common NAME for the install traffic, so the server
 *     accepts the param, ignores it and warns. Seeded into this bag it was re-sent on EVERY request
 *     and warned about on every response, while no chip could render for it (chips are built from
 *     `facet_groups`) and "Clear all filters" only appears when chips exist — a permanent warning
 *     banner with no visible control to remove it. It is held in `countryParam` below instead: sent
 *     once, explained by the server's own sentence, and removable.
 *   · `shopify_plans` IS a published group, so selecting it worked — `setFacetGroup` adds the key and
 *     `fetchData` sends it — but it was silently dropped by "Clear all" and never seeded from the
 *     URL, because both iterate THIS object.
 */
const EMPTY_FACETS = {
    install_states: [], states: [], billing: [], store_records: [], store_statuses: [], shopify_plans: []
};

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
 * The "N stores · page X of Y" line, or null when the response carried no figures.
 *
 * It never falls back to `{ page: 1, pages: 1, total: 0 }`. That default is what let this page
 * publish "0 stores · page 1 of 1" underneath a `GET /api/stores` that does not exist — a checkable
 * claim about the operator's install base that no endpoint made. A missing figure withdraws the
 * sentence instead of inventing one; a total of 0 on a READY response is a MEASURED empty and still
 * prints, because that one is an answer.
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
    // `pages` is Math.ceil(total/limit) with no floor, so it is legitimately 0 on an empty
    // result — clamp for display only.
    return `${total.toLocaleString()} stores · page ${page} of ${Math.max(pages, 1)}`;
};

/**
 * Every store this app has been installed on, with its CURRENT install state — paying or not.
 *
 * The Subscriptions page cannot answer this: its population is stores currently on a paid, non-test,
 * non-free plan, so stores that never subscribed are absent, and so are stores that paid and then
 * uninstalled (the uninstall webhook resets their plan to the free one). Both are here.
 *
 * `GET /api/stores` now serves this page. It answers 200 with `items: []` rather than refusing when
 * nothing has synced, and `data_state` says which kind of empty it is — the discriminator is the
 * WATERMARK (`meta.last_synced_at`), never the row count.
 *
 * The table, the facet filters, the tab counts and the pagination summary all stay behind
 * `<DataStateSection>` anyway, and that gate is not vestigial: NEVER_SYNCED, an expired session and
 * a failed request all still reach it, and `readDataState` NULLS `data` in each. This page once drew
 * "0 stores · page 1 of 1" and "Last Partner sync: — · 0 stores ever seen" as finished UI over a
 * response nobody made, which are three checkable claims about the operator's install base.
 */
const StoresPage = () => {
    const { toastMarkup } = useContext(LoaderContext) || {};
    // `apps`/`appsState` are read for the two roster banners alone — the table itself is gated on
    // `appId`. `appsLoading` is deliberately NOT among them: it is false both before a request and
    // after one has failed, so it can never tell "still asking" from "we could not ask", which is
    // the whole of the distinction those banners exist to draw.
    const { apps, appId, appsState, appsError, refreshApps, hydrated: appHydrated } = useGrowthIntel();
    const router = useRouter();

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
    const [facets, setFacets] = useState(EMPTY_FACETS);
    /**
     * The country a Countries-page link arrived with, or `''`.
     *
     *  NOT A FACET, because the server has no `countries` group to evaluate — see EMPTY_FACETS.
     * It is sent so the SERVER's own sentence explains why the list below is unfiltered (that
     * sentence names the code-vs-name mismatch, which no banner written here would), and it is held
     * in its own state so the reader has a chip to remove it with. Left in the facet bag it was a
     * permanent warning banner with no control beside it.
     */
    const [countryParam, setCountryParam] = useState('');
    // Seeded ONCE from the URL. Without the guard the effect re-seeds on every router change and
    // silently undoes the user's own edits to the same group.
    const seededFromUrl = useRef(false);
    /**
     *  Gates the FIRST fetch until the URL seed has been applied.
     *
     * Both effects run in the same commit on mount, so without this the fetch fires once with EMPTY
     * facets and again with the seeded ones — and the unfiltered answer, being in flight first, is
     * free to land last and overwrite the filtered one. That is exactly what made `?countries=SL`
     * render the full 10,556-store list with the chip showing.
     */
    const [seedReady, setSeedReady] = useState(false);
    /**
     *  Monotonic request id. Only the LATEST response may write state.
     *
     * Nothing here cancels an in-flight request, so any two overlapping fetches race — flipping a
     * filter quickly is enough. Without this the loser writing last wins, silently.
     */
    const requestSeq = useRef(0);
    const [sort, setSort] = useState('installed_at');
    const [dir, setDir] = useState('desc');

    useEffect(() => {
        const t = setTimeout(() => { setAppliedQuery(query); setPage(1); }, 350);
        return () => clearTimeout(t);
    }, [query]);

    /**
     * Seed facets from the query string, so the Revenue → By country tab can hand a country over.
     *
     * ⚠️ Gated on `router.isReady`: on a statically-optimised page `router.query` is EMPTY on the
     * first render, so seeding before it resolves would read nothing and mark itself done.
     * Only groups declared in EMPTY_FACETS are honoured — an unknown key from the URL is ignored
     * rather than becoming a group the server has no predicate for.
     */
    useEffect(() => {
        if (!router.isReady || seededFromUrl.current) return;
        seededFromUrl.current = true;
        const seeded = {};
        for (const key of Object.keys(EMPTY_FACETS)) {
            const raw = router.query[key];
            if (!raw) continue;
            const values = String(Array.isArray(raw) ? raw.join(',') : raw)
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean);
            if (values.length > 0) seeded[key] = values;
        }
        if (Object.keys(seeded).length > 0) {
            setFacets((prev) => ({ ...prev, ...seeded }));
            setPage(1);
        }
        // Seeded separately, for the reason above: it is a parameter the server warns about rather
        // than a group it can filter on.
        const rawCountry = router.query.countries;
        if (rawCountry) {
            setCountryParam(String(Array.isArray(rawCountry) ? rawCountry.join(',') : rawCountry).trim());
            setPage(1);
        }
        // Set LAST, and unconditionally: fetching is unblocked whether or not the URL carried
        // anything, but never before the seed has been decided either way.
        setSeedReady(true);
    }, [router.isReady, router.query]);

    // Page 3 of one app's stores is not page 3 of another's.
    useEffect(() => { setPage(1); }, [appId]);

    const fetchData = useCallback((opts) => {
        if (!appId || !appHydrated || !seedReady) return;
        const seq = ++requestSeq.current;
        setLoading(true);
        const params = { partner_app_id: appId, page, limit: PAGE_SIZE, q: appliedQuery, sort, dir };
        // Empty groups are OMITTED — an empty group is a no-op server-side, and leaving it out keeps
        // the URL readable.
        for (const key of Object.keys(facets)) {
            if (facets[key].length > 0) {
                params[key] = facets[key].join(',');
            }
        }
        if (countryParam) {
            params.countries = countryParam;
        }
        if (opts && opts.refresh) params.refresh = true;
        STORE_API.list(params, (resp) => {
            // A superseded response must not write anything — not the data, and not `loading`,
            // which would otherwise clear the spinner while the current request is still running.
            if (seq !== requestSeq.current) return;
            setLoading(false);
            // The old guard here was `if (resp && resp.status && resp.data) ... else setData(null)`,
            // which folded "not built", "not connected", "never synced" and "the request failed" into
            // one indistinguishable null — and the page then drew its own zeros over the top.
            // `readDataState` keeps the four apart and carries the server's own sentence with them.
            setListState(readDataState(resp));
        });
    }, [appId, appHydrated, seedReady, page, appliedQuery, facets, countryParam, sort, dir]);

    useEffect(() => { fetchData(); }, [fetchData]);

    // The payload, or null. Null in PENDING, NOT_IMPLEMENTED, NOT_CONNECTED, NEVER_SYNCED and ERROR
    // alike, so every read below is a read of a measured answer or of nothing.
    const data = listState.data;
    /**
     * Null, NOT `[]`, when the response carried no array.
     *
     * `|| []` hands `StoreTable` an empty list, and its empty state — "No stores match these
     * filters" — is a claim about the operator's install base that no response made. The `loading`
     * prop below keeps the table in its skeleton form until a real list exists, so the only empty
     * state this page ever draws is a measured one.
     */
    const items = data && Array.isArray(data.items) ? data.items : null;
    // Null rather than `{ page: 1, pages: 1, total: 0 }`: the summary line is withheld when there is
    // nothing to state, rather than being printed with manufactured figures.
    const pagination = (data && data.pagination) || null;
    // These DO still default to empty, and it is not the same defaulting: an empty map or list here
    // renders nothing at all — no tab count, no chip, no freshness clause — so each withdraws a
    // claim instead of manufacturing one, and every consumer of them is inside the gated section.
    const counts = (data && data.install_state_counts) || {};
    // Counts with every OTHER facet applied, so a tab number predicts what clicking it shows.
    const countsFiltered = (data && data.install_state_counts_filtered) || counts;
    const facetGroups = (data && data.facet_groups) || [];
    const meta = (data && data.meta) || {};
    const warnings = (data && data.warnings) || [];

    // Withheld rather than zeroed: "Search 0 stores by name, domain or plan" is a claim, and before
    // the first response there is no count to make it with.
    const searchTotal = _figure(countsFiltered.ALL);
    let searchPlaceholder = 'Search stores by name, domain or plan';
    if (searchTotal !== null) {
        searchPlaceholder = `Search ${searchTotal.toLocaleString()} stores by name, domain or plan`;
    }

    const summaryLine = _paginationSummary(pagination);
    // `domains_seen` is dropped from the line entirely when the server published none. The old
    // `(meta.domains_seen || 0)` printed "0 stores ever seen", which reads as a dead app rather than
    // as an unanswered question — and read exactly the same on an app that has simply never synced.
    const seenTotal = _figure(meta.domains_seen);
    let freshnessLine = `Last Partner sync: ${fmtDate(meta.last_synced_at)}`;
    if (seenTotal !== null) {
        freshnessLine = `${freshnessLine} · ${seenTotal.toLocaleString()} stores ever seen`;
    }


    const tabs = useMemo(() => INSTALL_TABS.map((t) => {
        let label = t.label;
        if (countsFiltered[t.id] !== undefined) {
            label = `${t.label} (${countsFiltered[t.id].toLocaleString()})`;
        }
        return { id: t.id, content: label };
    }), [countsFiltered]);

    // A tab is only "selected" when exactly one install state is chosen; pick two from the popover and
    // no single tab describes the view, so it falls back to All rather than lying.
    let selectedTab = 0;
    if (facets.install_states.length === 1) {
        selectedTab = Math.max(INSTALL_TABS.findIndex((t) => t.id === facets.install_states[0]), 0);
    }

    const setFacetGroup = useCallback((key, next) => {
        setFacets((prev) => ({ ...prev, [key]: next }));
        // Without this the table can sit on page 5 of a 1-page result and render empty, which reads as
        // "the filter is broken" when it worked.
        setPage(1);
    }, []);

    const clearAllFacets = useCallback(() => {
        setFacets(EMPTY_FACETS);
        // Cleared with the rest: it is one of the chips, so "Clear all filters" has to mean it too.
        setCountryParam('');
        setPage(1);
    }, []);

    const handleTabChange = useCallback((idx) => {
        const id = INSTALL_TABS[idx].id;
        let next = [];
        if (id !== 'ALL') { next = [id]; }
        setFacetGroup('install_states', next);
    }, [setFacetGroup]);

    // Built by pushing into an array — a ternary chain can only ever render one chip.
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

    return (
        <SideNavBar>
            <Page
                fullWidth
                title="Stores"
                subtitle="Every store this app has been installed on, with its current install state — paying or not"
                secondaryActions={[
                    { content: 'Refresh', onAction: () => fetchData({ refresh: true }), loading }
                ]}
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

                    {/* ⚠️ "Nothing synced" and "no installs" are different facts and must never read the
                        same. The service returns domains_seen: 0 for the former and says so in a
                        warning; without this the page would present a never-synced app as a dead one. */}
                    {warnings.length > 0 ? (
                        <Banner tone="warning">
                            <BlockStack gap="100">
                                {warnings.map((w) => (<p key={w}>{w}</p>))}
                            </BlockStack>
                        </Banner>
                    ) : null}

                    {/* EVERYTHING THE CARD STATES IS A FIGURE, so the card itself is what is
                        gated — the table, the facet filters, the install-state tab counts and the
                        pagination summary alike. In a non-READY state this renders the server's own
                        sentence (which names `GET /api/stores`) and NOTHING in the card's place;
                        a "0 stores" line beside that banner is exactly the regression being fixed. */}
                    {/* THE `appId` GATE IS PART OF THE CONTRACT, not decoration. `fetchData`
                        returns early with no app selected and never touches `loading`, so this
                        section would otherwise sit in PENDING for good — and a permanent PENDING
                        under a permanent `loading: false` is the one thing this page cannot explain
                        with a banner, because no response exists to quote. With no app chosen there
                        is nothing to say about any app's stores, so nothing is said.
                        `loading={loading}` is the other half: it is the SAME flag `StoreTable` gets
                        below, so the skeleton the child draws for an in-flight request and the
                        nothing this wrapper draws for a request that was never made stay in step. */}
                    {appId ? (
                        <DataStateSection state={listState} loading={loading}>
                            <Card padding="0">
                                <Tabs tabs={tabs} selected={selectedTab} onSelect={handleTabChange} />
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
                                        <div style={{ flex: '0 0 auto', minWidth: 250 }}>
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

                                {appliedChips.length > 0 || countryParam ? (
                                    <div style={{ padding: '0 16px 12px' }}>
                                        <InlineStack gap="150" blockAlign="center" wrap>
                                            {appliedChips.map((chip) => (
                                                <Tag
                                                    key={chip.key}
                                                    onRemove={() => setFacetGroup(
                                                        chip.groupKey,
                                                        (facets[chip.groupKey] || []).filter((v) => v !== chip.value)
                                                    )}
                                                >
                                                    {chip.label}
                                                </Tag>
                                            ))}
                                            {/* The chip the server CANNOT honour, rendered anyway so the
                                                warning above it has a control beside it. Its own chip
                                                rather than one of `appliedChips`, which are built from
                                                `facet_groups` and so can only ever describe a group the
                                                server published. */}
                                            {countryParam ? (
                                                <Tag onRemove={() => { setCountryParam(''); setPage(1); }}>
                                                    {`Country: ${countryParam} (not applied)`}
                                                </Tag>
                                            ) : null}
                                            <Button variant="plain" onClick={clearAllFacets}>Clear all filters</Button>
                                        </InlineStack>
                                    </div>
                                ) : null}

                                <StoreTable
                                    rows={items}
                                    columns={STORE_COLUMNS}
                                    appId={appId}
                                    /* `items === null` means "no measured list", which includes the frame
                                       before the first response and an app that has not been chosen yet.
                                       Without it the table falls through to its empty state and announces
                                       "No stores match these filters" over a question nobody has answered. */
                                    loading={loading || items === null}
                                    emptyHeading="No stores match these filters"
                                    emptyBody={(
                                        <BlockStack gap="300" inlineAlign="center">
                                            <Text as="p" tone="subdued">Try removing a filter or clearing the search.</Text>
                                            {appliedChips.length > 0 || countryParam ? (
                                                <Button onClick={clearAllFacets}>Clear all filters</Button>
                                            ) : null}
                                        </BlockStack>
                                    )}
                                    rowKey={(row) => row.shop_domain}
                                />

                                {/* The whole footer exists only when the response carried figures. A count
                                    line beside an explanatory banner is the precise failure being fixed: the
                                    banner is abstract, "0 stores" is concrete, and the reader believes the
                                    concrete one. */}
                                {pagination ? (
                                    <div style={{ padding: '12px 16px', borderTop: '1px solid var(--p-color-border-secondary)' }}>
                                        <InlineStack align="space-between" blockAlign="center" wrap>
                                            <BlockStack gap="050">
                                                {summaryLine ? (
                                                    <Text as="span" variant="bodySm" tone="subdued">{summaryLine}</Text>
                                                ) : null}
                                                {/* Freshness beside the count, always. The install base is only as
                                                    complete as the last Partner sync, and a stale number that looks
                                                    authoritative is worse than one that admits its age. */}
                                                <Text as="span" variant="bodyXs" tone="subdued">{freshnessLine}</Text>
                                            </BlockStack>
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

                    {/* Held to READY with the card: this paragraph explains why a number reads lower
                        than the Partner dashboard's, and there is no number to explain when nothing
                        was published. */}
                    {listState.ready ? (
                        <>
                            {/* The definition, on the page. "Installed" here folds Shopify's Deactivated (the
                                merchant's account went away) in with Uninstalled, so this count reads LOWER than
                                the Partner dashboard's — stated plainly so the difference is not filed as a bug. */}
                            <Text as="span" variant="bodyXs" tone="subdued">
                                Install state is replayed from Partner API relationship events — a store counts as
                                installed when its most recent event is an install or reinstall. Shopify&apos;s
                                &quot;deactivated&quot; (the merchant&apos;s account closed) counts as not installed, so this
                                number reads lower than the Partner dashboard&apos;s install count.
                            </Text>
                        </>
                    ) : null}
                </BlockStack>
            </Page>
            {toastMarkup}
        </SideNavBar>
    );
};

export default StoresPage;
