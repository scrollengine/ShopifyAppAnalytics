import {
    Card, BlockStack, Box, InlineStack, InlineGrid, Text, TextField,
    Select, Button, Tooltip, Banner, Badge
} from '@shopify/polaris';
import { RefreshIcon, SortAscendingIcon, SortDescendingIcon } from '@shopify/polaris-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';

import GrowthIntelCountryApiService from '../../../API_Services/growth-intel/countryService';
import CountryTable from '../store/CountryTable';
import CountryMixCharts from '../store/CountryMixCharts';
import SubscriptionFacetFilter from '../SubscriptionFacetFilter';
import DataStateSection from '../DataStateSection';
import { pendingDataState, readDataState } from '../dataState';
import { fmtMoney, fmtDate } from '../store/storePresentation';
import { DASHBOARD_ROUTES } from '../../../utils/dashboardRoutes';

/**
 * =============================================================================
 *  The By country tab — where the paying customers are.
 * =============================================================================
 *
 *  This was `pages/countries/index.js`. It is a tab of `/revenue` now, and the
 *  move raised one question that had a wrong answer available: the page above it
 *  carries a date range, and this view does not honour one.
 *
 *  ── THE RANGE ABOVE DOES NOT APPLY HERE, AND THE TAB SAYS SO ─────────────
 *  `GET /api/stores/countries` TAKES NO DATE PARAMETER. `CountryRollupParams`
 *  accepts `sort`, `dir` and five facet groups and nothing else; the service folds
 *  every store the Partner API knows at the instant of the request, and its money
 *  columns are all-time settled cash. There is no `since`, no `until`, no
 *  `period_days`, and no derivation of one that would be honest — clipping the
 *  rows client-side is impossible (the rollup arrives pre-aggregated, one row per
 *  country, with no dates on it to clip by).
 *
 *  So this tab does not pretend. It renders a visible statement that it is
 *  lifetime and unfiltered, next to the figures it qualifies. The alternative —
 *  sitting silently under a control that appears to govern it — is the worse
 *  failure by a distance: a reader sets the range to 30 days, reads "Paying
 *  customers 412", and takes away a 30-day figure that is really an all-time one.
 *  That is a plausible wrong number, which is the one thing this project exists to
 *  refuse. A tab that says it ignores the control is merely inconvenient.
 *
 *  ⚠️ IF A DATE PARAMETER IS EVER ADDED TO THAT ENDPOINT, the notice below is the
 *  first thing to delete and the page's per-tab window line is the second. Both
 *  are claims about the API's shape, and a stale claim about honesty is worse than
 *  no claim at all.
 * =============================================================================
 */

const COUNTRY_API = new GrowthIntelCountryApiService();

const SORT_OPTIONS = [
    { label: 'Paying customers', value: 'paying' },
    { label: 'MRR', value: 'mrr' },
    { label: 'Stores', value: 'stores' },
    { label: 'Installed', value: 'installed' },
    { label: 'Conversion rate', value: 'conversion_rate' },
    { label: 'On trial', value: 'trialing' },
    { label: 'Ever paid', value: 'ever_paid' },
    { label: 'Total spend', value: 'total_spend' },
    { label: 'Country', value: 'country_name' }
];

// `countries` is absent by design — filtering countries on the countries view would remove the rows
// being compared. The server refuses the param for the same reason.
const EMPTY_FACETS = { install_states: [], states: [], billing: [], store_records: [], store_statuses: [] };

/** What a figure the backend never sent is allowed to look like. Never `0`, never `$0.00`. */
const UNKNOWN = '—';

/**
 * True only when the API actually sent a number.
 *
 * `null` and `''` are spelled out because `Number(null)` and `Number('')` are both `0`, and
 * `Number.isFinite(0)` is true — so a bare `Number.isFinite(Number(n))` test passes "we were not
 * told" straight through as a measured zero, which is the whole bug.
 *
 * @param {Number|String|null|undefined} n - The value as the API sent it.
 * @returns {Boolean} True when there is a figure to render.
 */
const _isNum = (n) => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n));

/**
 * Formats a count, or says nothing when there is no count to format.
 *
 * THE REGRESSION THIS VIEW IS NAMED FOR (IMPLEMENTATION.md §4.5). This was
 * `Number(n || 0).toLocaleString()` applied to a `totals` that is `{}` — because the endpoint behind
 * this page did not exist — and it published "Paying customers 0 · 0% of 0 stores · Countries 0"
 * as finished UI. Four checkable claims about the operator's business, none of them made by the
 * backend.
 *
 * A measured `0` still renders as "0": that is an answer, and this replaces only the absence of one.
 *
 * @param {Number|String|null|undefined} n - The count as the API sent it.
 * @returns {String} The localised count, or an em dash when the API sent no count.
 */
const _num = (n) => (_isNum(n) ? Number(n).toLocaleString() : UNKNOWN);

/**
 * Formats money, or says nothing when there is no figure.
 *
 * `fmtMoney` cannot be used directly on a value that may be absent: it renders `undefined` as
 * "$0.00", which is a revenue claim rather than a formatting default. Every other page shares that
 * helper, so it is wrapped here rather than changed underneath them.
 *
 * @param {Number|String|null|undefined} n - The amount as the API sent it.
 * @returns {String} The formatted amount, or an em dash when the API sent no amount.
 */
const _money = (n) => (_isNum(n) ? fmtMoney(n) : UNKNOWN);

/**
 * The share of MRR that could not be placed on a map, or null when the server sent no ratio.
 *
 * `Math.round((1 - (coverage.mrr_coverage || 0)) * 1000) / 10` published "that is 100% of MRR"
 * whenever `mrr_coverage` was merely missing — the most alarming possible reading of "we were not
 * told", inside the one banner whose job is to explain a discrepancy.
 *
 * @param {Object|null} coverage - `data.coverage` as the API sent it.
 * @returns {String|null} A percentage string, or null when the sentence must not be written at all.
 */
const _uncoveredMrrShare = (coverage) => {
    if (!coverage || !_isNum(coverage.mrr_coverage)) {
        return null;
    }
    return `${Math.round((1 - Number(coverage.mrr_coverage)) * 1000) / 10}%`;
};

/**
 * The per-endpoint "it answered, but it told us nothing" test handed to `readDataState`.
 *
 * ── WHAT THE DECODER ALREADY DOES, SO THIS NO LONGER HAS TO ─────────────────────────────────────
 * `readDataState` now decodes a `status: true` response whose `data` is null or undefined as
 * NEVER_SYNCED on its own, and it decodes `data.items === null` the same way. So `data` is
 * guaranteed to be a real object by the time this runs, and no clause here is defending against a
 * missing payload any more — an earlier draft of this predicate was carrying that weight because
 * the decoder used to turn a null `data` into `{}` and hand it straight through as READY.
 *
 * ── WHAT IT IS STILL FOR ────────────────────────────────────────────────────────────────────────
 * The shape checks the decoder cannot know about, both specific to this endpoint:
 *   • `items` present but not an array (including absent entirely, which the decoder's `=== null`
 *     test does not cover) — every row of the table is read out of it.
 *   • `totals` absent or `{}` — every KPI on this tab is read out of it, and an empty `totals`
 *     reaching the tiles is exactly the §4.5 regression: "Paying customers 0 · 0% of 0 stores".
 *
 * A real answer that happens to carry an empty `totals` object would show the banner instead of the
 * tiles, and showing the banner over a genuine reading costs a reader nothing they cannot recover by
 * re-syncing, while the reverse costs them four wrong figures they have no way to tell are wrong.
 *
 * @param {Object} data - The response's `data` object. Never null — see above.
 * @returns {Boolean} True when the payload carries no measurement at all.
 */
const _isNeverSynced = (data) => !Array.isArray(data.items)
    || Object.keys(data.totals || {}).length === 0;

const Kpi = ({ label, value, sub, help }) => {
    let heading = <Text as="span" variant="bodySm" tone="subdued">{label}</Text>;
    if (help) {
        heading = (
            <Tooltip content={help}>
                <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
            </Tooltip>
        );
    }
    return (
        <Card>
            {/*  inlineAlign="start": BlockStack is a flex column whose align-items defaults to
                STRETCH, which turns any Badge child into a full-width slab. */}
            <BlockStack gap="100" inlineAlign="start">
                {heading}
                <Text as="span" variant="heading2xl">{value}</Text>
                {sub ? <Text as="span" variant="bodySm" tone="subdued">{sub}</Text> : null}
            </BlockStack>
        </Card>
    );
};

/**
 * Where the paying customers are, by country.
 *
 * The store list's facet counts cannot answer this: a count says how many stores are in a bucket,
 * not how many are worth anything. Default order is PAYING customers rather than store count,
 * because ranking by volume buries a small market that converts well underneath a large one that
 * never pays — which is the comparison this view exists to make.
 *
 * Country is resolved server-side from the geo on the install-attribution row, which is the only
 * per-store country this build records — the source system this view came from preferred a
 * merchant-declared country off its own store record and fell back to the install geo, and that
 * store record has no equivalent here. Whoever adds one must change the sentence at the foot of the
 * view too, because it is the reader's only account of where the number came from.
 *
 * Normalise to ISO-2 BEFORE grouping: the raw values arrive as 'US' on some rows and 'United States'
 * on others, which would otherwise split one country across two rows in every number here.
 *
 * ⚠️ TAKES NO `dateRange` PROP, AND THAT IS THE POINT. Its endpoint accepts no window (see the file
 * header), so there is nothing honest to do with one. A component that accepted the prop and quietly
 * dropped it would look, from every call site, exactly like one that honoured it.
 *
 * @param {Object} props
 * @param {String} props.appId - The selected partner app. No request is issued without one.
 * @param {Boolean} props.appHydrated - True once the app selection has been read from storage.
 * @returns {JSX.Element}
 */
const CountryView = ({ appId, appHydrated }) => {
    const router = useRouter();

    // ⚠️ Holds a DATA STATE, not a payload: `dataState.data` is null in every state except READY,
    // so no figure below can be drawn over an answer the backend never gave. See dataState.js.
    const [dataState, setDataState] = useState(pendingDataState());
    const [loading, setLoading] = useState(false);
    const [query, setQuery] = useState('');
    const [facets, setFacets] = useState(EMPTY_FACETS);
    const [sort, setSort] = useState('paying');
    const [dir, setDir] = useState('desc');

    /**
     *  Monotonic request id. Only the LATEST response may write state.
     *
     * Nothing here cancels an in-flight request, so any two overlapping fetches race — flipping a
     * filter or sort quickly is enough. Without this the loser landing last wins, silently, and the
     * screen shows an answer to a question the user has already moved on from.
     */
    const requestSeq = useRef(0);

    const fetchData = useCallback(() => {
        //  `hydrated` is GUARDED ON and therefore must be IN the dep array: guarding on a value
        // that is not a dependency means the effect never re-runs when it flips.
        if (!appId || !appHydrated) return;
        const seq = ++requestSeq.current;
        setLoading(true);
        //  The search is deliberately NOT sent. It must narrow only the TABLE — the KPIs and the
        // donuts describe the whole filtered population, and a server-side `q` would silently
        // reshape them too, so typing "united" would redraw the revenue mix as 100% of three
        // countries while the header still claimed the full total. A country list is ~200 rows, so
        // filtering it locally is free and removes a request per keystroke.
        //
        // AND NEITHER IS THE PAGE'S DATE RANGE, because the endpoint has no parameter for one.
        // See the file header: this view says so on screen rather than sending a window the service
        // would drop in silence.
        const params = { partner_app_id: appId, sort, dir };
        // Empty groups are OMITTED — an empty group is a no-op server-side, and leaving it out keeps
        // the URL readable.
        for (const key of Object.keys(facets)) {
            if (facets[key].length > 0) {
                params[key] = facets[key].join(',');
            }
        }
        COUNTRY_API.list(params, (resp) => {
            // A superseded response writes nothing — not the data, and not `loading`, which would
            // otherwise clear the spinner while the current request is still running.
            if (seq !== requestSeq.current) return;
            setLoading(false);
            // `if (resp && resp.status) ... else setData(null)` collapsed all four kinds of
            // nothing into one, and the render then drew an empty state over the top. The decoder
            // keeps them apart — including the not-implemented envelope this service actually
            // returns, which sets `status: false` on purpose so old guards keep working.
            setDataState(readDataState(resp, { isNeverSynced: _isNeverSynced }));
        });
    }, [appId, appHydrated, facets, sort, dir]);

    useEffect(() => { fetchData(); }, [fetchData]);

    const setFacetGroup = useCallback((groupKey, next) => {
        setFacets((prev) => ({ ...prev, [groupKey]: next }));
    }, []);

    const clearAllFacets = useCallback(() => setFacets(EMPTY_FACETS), []);

    /**
     * Hand the country to the stores list rather than filtering here — that is where stores live.
     *
     * THIS CLICK-THROUGH SURVIVED THE MOVE INTO A TAB, and it had to: `pages/stores/index.js`
     * reads `router.query.countries` and applies it as a filter that has no facet group behind it,
     * so this is the only control anywhere that can set it. It leaves `/revenue` for `/stores`, which
     * is a real navigation and not a tab switch — the country is being handed to a different screen,
     * not to a different view of this one.
     */
    const openStores = useCallback((code) => {
        router.push(`${DASHBOARD_ROUTES.STORES}?countries=${encodeURIComponent(code)}`);
    }, [router]);

    // ⚠️ `data` is null in every non-READY state, and everything derived from it below is
    // rendered ONLY inside <DataStateSection>. The `[]` / `{}` fallbacks here exist to keep the
    // hooks that follow unconditional; they are never drawn, and they are not empty states.
    const data = dataState.data;
    const items = (data && data.items) || [];

    // Table-only. Charts and KPIs stay on `items` — see the note in fetchData.
    const visibleItems = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return items;
        return items.filter((e) => (e.country_name || '').toLowerCase().includes(needle)
            || (e.country || '').toLowerCase().includes(needle));
    }, [items, query]);
    const totals = (data && data.totals) || {};
    const coverage = (data && data.coverage) || null;
    const facetGroups = (data && data.facet_groups) || [];
    const meta = (data && data.meta) || {};
    const warnings = (data && data.warnings) || [];
    const uncoveredMrrShare = _uncoveredMrrShare(coverage);
    // The count belongs to a placeholder, not a heading: with no count to state, the sentence drops
    // it rather than inviting the reader to "Search — countries".
    const countrySearchPlaceholder = _isNum(totals.countries)
        ? `Search ${_num(totals.countries)} countries by name or code`
        : 'Search countries by name or code';

    const appliedChips = useMemo(() => {
        const chips = [];
        for (const group of facetGroups) {
            for (const option of (group.options || [])) {
                if (((facets[group.key]) || []).includes(option.value)) {
                    chips.push({ key: `${group.key}:${option.value}`, label: `${group.label}: ${option.label}` });
                }
            }
        }
        return chips;
    }, [facetGroups, facets]);

    let topCountry = UNKNOWN;
    let topCountrySub = '';
    if (items.length > 0 && items[0].paying > 0) {
        topCountry = items[0].country_name;
        // `_money`, not `fmtMoney`: a top country whose row carries no `mrr` would otherwise be
        // published as earning exactly $0.00 while sitting at the top of a revenue ranking.
        topCountrySub = `${_num(items[0].paying)} paying · ${_money(items[0].mrr)} MRR`;
    }

    // Was `let payingRate = '0%'` — a conversion rate asserted for a population whose size
    // we had not been told. There is no rate when either side is missing, and none when the
    // denominator is a measured zero either: 0/0 is not 0%.
    let payingRate = UNKNOWN;
    if (_isNum(totals.paying) && _isNum(totals.stores) && Number(totals.stores) > 0) {
        payingRate = `${Math.round((totals.paying / totals.stores) * 1000) / 10}%`;
    }

    return (
        <>
            {warnings.length > 0 ? (
                <Banner tone="warning">
                    <BlockStack gap="100">
                        {warnings.map((w) => (<p key={w}>{w}</p>))}
                    </BlockStack>
                </Banner>
            ) : null}

            {/* EVERY figure in this view lives inside here. In any non-READY state
                this renders the server's own sentence and NOTHING ELSE — no KPI tiles holding
                em dashes, no donuts drawn from an empty array, no "0 countries" table. A banner
                above a row of zeros is worse than no banner at all: the zeros are concrete and
                the sentence is not, so the reader believes the zeros. (IMPLEMENTATION.md §4.5.)
                The closing note is inside too — "click a country to open its stores" is
                instructions for a table that is not on screen.

                ⚠️ SO IS THE LIFETIME NOTICE, and for the same reason inverted: it qualifies
                figures, so it must not outlive them. Printed over a refusal banner it would be a
                caveat about numbers that are not on screen, which reads as a second fault.

                `loading` is the view's own request flag, the same one CountryTable below
                receives. It is what separates the two halves of PENDING: a request that is
                genuinely in flight renders the children so the table shows its skeleton,
                while the PENDING that `fetchData`'s `if (!appId || !appHydrated) return;`
                leaves behind forever — no request was ever made, so `loading` was never
                set — renders nothing at all. Without it this view greets an operator who
                has not yet picked an app with a full set of em dashes and an empty donut,
                which reads as an answer. */}
            <DataStateSection state={dataState} loading={loading}>
                <BlockStack gap="400">
                    {/* THE TAB THAT DOES NOT FOLLOW THE CONTROL ABOVE IT SAYS SO, FIRST THING.
                        The date range in the page header governs the Revenue and Churn tabs and
                        cannot govern this one: `GET /api/stores/countries` accepts no window at all
                        (`CountryRollupParams` — sort, direction and five facet groups, and nothing
                        else). Sitting silently under that control is how a reader takes an all-time
                        figure away as a 30-day one, so the discrepancy is stated where the figures
                        are rather than left for them to discover.

                        A `Box` and not a `Banner`: nothing is wrong, nothing failed, and a coloured
                        alarm on every visit is how an operator learns to stop reading banners. */}
                    <Box
                        background="bg-surface-secondary"
                        padding="300"
                        borderRadius="200"
                        borderColor="border-secondary"
                        borderWidth="025"
                    >
                        <BlockStack gap="100">
                            <Text as="p" variant="bodySm" fontWeight="semibold">
                                Lifetime — the date range above does not apply to this tab.
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                                This breakdown covers every store the Partner API knows, judged at the
                                moment of the request: paying customers and MRR are as of now, spend is
                                all-time settled cash. The endpoint behind it accepts no date window, so
                                changing the range above leaves every figure here unchanged — which is
                                why it is said here rather than left to be noticed.
                            </Text>
                        </BlockStack>
                    </Box>

                    <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
                        <Kpi
                            label="Paying customers"
                            value={_num(totals.paying)}
                            sub={`${payingRate} of ${_num(totals.stores)} stores`}
                            help="Stores being billed right now. The same predicate as the Paying now filter, so the two can never disagree."
                        />
                        <Kpi
                            label="Attributed MRR"
                            value={_money(totals.mrr)}
                            sub={`${_money(totals.net_revenue)} lifetime net`}
                            help="MRR this view can place on a map. Lower than the Revenue tab's total whenever a paying store is missing from the Partner event replay — the remainder is called out below."
                        />
                        <Kpi
                            label="Countries"
                            value={_num(totals.countries)}
                            sub={`${_num(totals.installed)} stores installed now`}
                        />
                        <Kpi label="Top country" value={topCountry} sub={topCountrySub} />
                    </InlineGrid>

                    {/* ⚠️ The answer to "why is this MRR lower than the Revenue tab's". Rendered only
                        when there IS a remainder, so a fully-attributed app is not nagged about a
                        problem it does not have. */}
                    {coverage && coverage.unattributed_paying > 0 ? (
                        <Banner tone="info" title="Some paying stores cannot be placed on a map">
                            <BlockStack gap="100">
                                {/*  THE CAUSE, STATED CORRECTLY. This sentence used to read "have no
                                    install or uninstall event in the Partner replay" — the SOURCE
                                    system's reason, carried across with the component and false here.
                                    These stores are on the roster precisely BECAUSE the Partner API
                                    knows them; what they lack is a listing-analytics (GA4)
                                    install-ATTRIBUTION record, which is the only thing in this build
                                    that carries a country. `countryRollup.types.ts` flags the wrong
                                    wording by name, and the accurate sentence is already in
                                    `warnings[]` two banners above — so the screen was contradicting
                                    itself about why its own number is short, and sending the operator
                                    after a Partner re-sync that cannot fix it. */}
                                <Text as="p" variant="bodySm">
                                    {`${_num(coverage.attributed_paying)} paying stores (${_money(coverage.attributed_mrr)} MRR) are attributed to a country. `}
                                    {`${_num(coverage.unattributed_paying)} more (${_money(coverage.unattributed_mrr)} MRR) have no install-attribution record from listing analytics, so this build holds no country for them and they sit in the Unknown row rather than being dropped.`}
                                    {/* Written only when the server sent a coverage ratio — see `_uncoveredMrrShare`. */}
                                    {uncoveredMrrShare ? ` That is ${uncoveredMrrShare} of MRR.` : null}
                                </Text>
                                <Text as="p" variant="bodySm">
                                    Country here is where the INSTALL came from, recorded by listing
                                    analytics — the Partner API carries no trading country on any
                                    version. A store that installed before the analytics export began,
                                    or while it was disconnected, can never be attributed
                                    retrospectively, so this gap does not close by re-syncing the
                                    Partner API. The Revenue tab counts every paying store whether or
                                    not it can be placed on a map, which is why its MRR is higher.
                                </Text>
                            </BlockStack>
                        </Banner>
                    ) : null}

                    <CountryMixCharts rows={items} totals={totals} />

                    <Card padding="0">
                        <div style={{ padding: '12px 16px' }}>
                            <InlineStack gap="200" blockAlign="center" wrap>
                                <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                                    <TextField
                                        label=""
                                        labelHidden
                                        placeholder={countrySearchPlaceholder}
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
                                        onChange={setSort}
                                    />
                                </div>
                                <Tooltip content={dir === 'desc' ? 'Sorted high to low — switch to low to high' : 'Sorted low to high — switch to high to low'}>
                                    <Button
                                        icon={dir === 'desc' ? SortDescendingIcon : SortAscendingIcon}
                                        accessibilityLabel={dir === 'desc' ? 'Sort ascending' : 'Sort descending'}
                                        onClick={() => setDir(dir === 'desc' ? 'asc' : 'desc')}
                                    />
                                </Tooltip>
                                {/* ⚠️ THE REFRESH LIVES IN THE VIEW NOW, not in the page header. It
                                    was a `secondaryAction` on the old standalone page; a header
                                    button on a tabbed screen would have to mean something different
                                    on each tab, and a control whose target depends on an invisible
                                    selection is a control nobody can predict. Beside the filters it
                                    refreshes is unambiguous. */}
                                <Tooltip content="Re-read the country breakdown">
                                    <Button
                                        icon={RefreshIcon}
                                        accessibilityLabel="Refresh the country breakdown"
                                        onClick={fetchData}
                                        loading={loading}
                                    />
                                </Tooltip>
                            </InlineStack>
                        </div>

                        {appliedChips.length > 0 ? (
                            <div style={{ padding: '0 16px 12px' }}>
                                <InlineStack gap="150" blockAlign="center" wrap>
                                    {appliedChips.map((chip) => (<Badge key={chip.key}>{chip.label}</Badge>))}
                                    <Button variant="plain" onClick={clearAllFacets}>Clear all filters</Button>
                                </InlineStack>
                            </div>
                        ) : null}

                        <CountryTable rows={visibleItems} loading={loading} onSelect={openStores} />

                        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--p-color-border-secondary)' }}>
                            <Text as="span" variant="bodyXs" tone="subdued">
                                {`Showing ${_num(visibleItems.length)} of ${_num(totals.countries)} countries · last Partner sync ${fmtDate(meta.last_synced_at)}`}
                            </Text>
                        </div>
                    </Card>

                    {/* THIS SENTENCE IS RENDERED UI IN A PUBLIC REPOSITORY. It used to read "Country
                        comes from the <internal codename> store record", and two things were wrong with
                        it. The codename — the private system this dashboard was extracted from — is the
                        obvious one, and it is not repeated here for the same reason it was taken out of
                        the page. The one worth more is that the sentence described a mechanism that DOES
                        NOT EXIST HERE: this build keeps no per-store record to read a country off, so
                        there is no merchant-declared value and nothing for the install geo to be a
                        "fallback" to. Copy explaining a source the reader cannot inspect is worse than no
                        copy — it sends them looking for a table that is not in the schema. Below is what
                        this build actually has; keep the two in step if a store record is ever added. */}
                    <Text as="span" variant="bodyXs" tone="subdued">
                        Click a country to open its stores. Country comes from the geo recorded against each
                        install when the listing analytics were synced — that install row is the only place
                        this build stores a country per store, so a merchant who trades from somewhere other
                        than where they installed is counted where they installed. It is normalised to an ISO
                        code before counting, because the raw values arrive as &quot;US&quot; on some installs and
                        &quot;United States&quot; on others. Stores whose install carried no geo are grouped under
                        Unknown rather than dropped. Conversion is paying over stores, not over installs: a
                        store that uninstalled while paying is still revenue that country produced.
                    </Text>
                </BlockStack>
            </DataStateSection>
        </>
    );
};

export default CountryView;
