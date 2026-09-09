import { IndexTable, BlockStack, InlineStack, Text, Badge, Tooltip, Link, EmptyState } from '@shopify/polaris';
import useStoreDetailDrawer from './useStoreDetailDrawer';
import {
    STORE_STATE_TONE,
    STORE_STATE_LABELS,
    INSTALL_STATE_TONE,
    INSTALL_STATE_LABELS,
    ACQUISITION_CHANNEL_LABELS,
    ACQUISITION_CHANNEL_TONE,
    fmtMoney,
    fmtDate,
    planIntervalLabel,
    storeDetailUrl,
    isSearchSurface,
    isPaidSurface,
    surfaceLabel,
    surfacePositionLabel
} from './storePresentation';

/**
 * The one table that renders store rows — Subscriptions, the install cohort, and anything that
 * lists stores next.
 *
 * Columns are a REGISTRY, not props: each page passes an ordered list of column keys and gets the
 * same cell rendering, the same badge tones and the same date/money formats. Adding a store list
 * elsewhere means picking keys, not writing cells — which is what stops the next table from
 * drifting the way the first two did.
 *
 * A page may pass a key its rows do not populate; every renderer below degrades to an em dash
 * rather than throwing, so a column set is safe to reuse across endpoints that return different
 * subsets.
 */

const _dash = <Text as="span" variant="bodySm">—</Text>;

/**
 * Store identity: display name over domain, the shape the Subscriptions list already used.
 *
 * The name falls back to the domain rather than rendering blank — the install cohort is mostly
 * stores that never subscribed, and a name is not always resolvable for them. Showing the domain
 * twice would be noise, so the second line is dropped when they are the same.
 */
const _renderStore = (row, ctx) => {
    const name = row.customer_name || row.shop_name || row.shop_domain;
    const showDomain = row.shop_domain && row.shop_domain !== name;
    const url = storeDetailUrl(row, ctx.appId, ctx.from);

    let primary = <Text as="span" variant="bodyMd" fontWeight="semibold">{name}</Text>;
    if (url) {
        // An explicit Link as well as the row's own onClick: the row click is the convenience, the
        // link is what makes the destination keyboard-reachable and openable in a new tab.
        //
        //  The href is REAL — `AppProvider` is mounted with no `linkComponent`, so Polaris `Link`
        // renders a plain <a> and a click here is a FULL DOCUMENT navigation, not a Next transition.
        // The store name is the most obvious thing to click, so leaving this alone while only the
        // row's onClick opened the panel would have left half the clicks blowing the list away —
        // the exact problem the panel exists to solve. A plain left click therefore opens the panel
        // instead; the href stays so ⌘/Ctrl/middle-click, "open in new tab" and the keyboard still
        // reach the full page. Modified clicks are let through untouched: `preventDefault` on them
        // would silently break new-tab opening.
        primary = (
            <Link
                url={url}
                removeUnderline
                onClick={(e) => {
                    if (!e) return;
                    if (e.stopPropagation) e.stopPropagation();
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
                    if (!ctx.onSelect) return;
                    e.preventDefault();
                    ctx.onSelect();
                }}
            >
                <Text as="span" variant="bodyMd" fontWeight="semibold">{name}</Text>
            </Link>
        );
    }

    return (
        <BlockStack gap="050" inlineAlign="start">
            {primary}
            {showDomain ? <Text as="span" variant="bodySm" tone="subdued">{row.shop_domain}</Text> : null}
            {/* ISO-2, normalised server-side — the raw Shopify value is 'US' on some rows and
                'United States' on others. The readable name rides along as a tooltip so the cell
                stays narrow. */}
            {row.country && row.country !== 'UNKNOWN' ? (
                <Tooltip content={row.country_name || row.country}>
                    <Text as="span" variant="bodyXs" tone="subdued">{row.country}</Text>
                </Tooltip>
            ) : null}
        </BlockStack>
    );
};

/**
 * How the store arrived: the coarse channel as a badge, the raw source/medium underneath.
 *
 * `has_attribution === false` renders "Not attributed" and NOT "Direct". Direct is already the
 * largest bucket, so a store we cannot explain would vanish into it and be read as a confident
 * answer. The absence of a listing-analytics record is not evidence of a direct arrival.
 */
const _renderCameFrom = (row) => {
    // ONE return path for attributed and unattributed alike. The two used to be separate branches
    // with different wrappers, which is how they drifted — and the unattributed branch was in
    // practice unreachable here anyway: installCohortService always populates `channel` ('UNKNOWN',
    // labelled "Not attributed"), so `!row.channel` was false for every cohort row. The subscriptions
    // endpoint DOES leave `channel` undefined on a miss, hence the label fallback below.
    const attributed = !!row.has_attribution;
    const label = row.channel_label
        || ACQUISITION_CHANNEL_LABELS[row.channel]
        || ACQUISITION_CHANNEL_LABELS.UNKNOWN;

    // The tooltip exists ONLY to qualify an unattributed row. It is the honesty affordance that
    // stops "Not attributed" being read as a measured answer, so it is attached on that branch and
    // nowhere else — an attributed badge already says everything this cell knows.
    const tip = 'No listing-analytics record for this store — not evidence that it arrived directly.';

    let badge = <Badge tone={ACQUISITION_CHANNEL_TONE[row.channel]}>{label}</Badge>;
    if (!attributed) {
        badge = <Tooltip content={tip}>{badge}</Tooltip>;
    }

    return (
        //  `inlineAlign="start"` is load-bearing, not cosmetic. `.Polaris-BlockStack` is
        // `display:flex` with `align-items: var(--pc-block-stack-inline-align)`, and that variable
        // defaults to `initial` — which for a flex container computes to `normal`, i.e. STRETCH. A
        // Badge is `display:inline-flex`, but as a stretched flex item its box fills the whole cell,
        // so every badge rendered a full-column-width slab instead of a pill. Invisible for text
        // children (no background), which is why the sibling columns never showed it.
        <BlockStack gap="050" inlineAlign="start">
            {badge}
            {attributed && row.source ? (
                <Text as="span" variant="bodyXs" tone="subdued">
                    {`${row.source}${row.medium ? ` / ${row.medium}` : ''}`}
                </Text>
            ) : null}
        </BlockStack>
    );
};

/**
 * Lifecycle state, plus the two conditions that qualify it.
 *
 * `state` (lifecycle vocabulary) and `status` (subscription vocabulary) are both accepted — see the
 * mapping note in storePresentation.js. Whichever the endpoint emits, the tone is the same.
 */
const _renderStatus = (row) => {
    const key = row.state || row.status;
    if (!key) return _dash;
    const label = row.state_label || row.status_label || STORE_STATE_LABELS[key] || key;
    return (
        <InlineStack gap="150" blockAlign="center" wrap>
            <Badge tone={STORE_STATE_TONE[key]}>{label}</Badge>
            {row.billing_stale ? (
                <Tooltip content="Our records show this plan as active, but Shopify has not billed it recently.">
                    <Badge tone="warning">Billing stale</Badge>
                </Tooltip>
            ) : null}
            {row.store_active === false ? (
                <Tooltip content="The app is no longer installed on this store.">
                    <Badge>Uninstalled</Badge>
                </Tooltip>
            ) : null}
        </InlineStack>
    );
};

/**
 * Whether the app is on the store right now, from the Partner-API event replay.
 *
 * ⚠️ Not the same column as `status`. That one is the SUBSCRIPTION lifecycle, whose `INSTALLED` means
 * "never subscribed". A store can be currently installed and never have subscribed, or have converted
 * and since uninstalled — the two columns disagree by design.
 *
 * `install_state_conflict` means the replay says installed while the operator's own store record says
 * inactive. The replay stays authoritative (the record is app-blind and its uninstall fields are not
 * written), so this renders as a caption rather than changing the badge.
 */
const _renderInstallState = (row) => {
    if (!row.install_state) return _dash;
    const label = row.install_state_label || INSTALL_STATE_LABELS[row.install_state] || row.install_state;
    let badge = <Badge tone={INSTALL_STATE_TONE[row.install_state]}>{label}</Badge>;
    if (row.install_state === 'UNKNOWN') {
        badge = (
            <Tooltip content="No install or uninstall event has been synced for this store, so its state cannot be determined. This is not evidence that the app is absent.">
                {badge}
            </Tooltip>
        );
    }
    return (
        <BlockStack gap="050" inlineAlign="start">
            {badge}
            {row.install_state_conflict ? (
                <Tooltip content="The Partner API says this store is installed, but the store record says it is inactive — usually an uninstall webhook that never landed.">
                    <Text as="span" variant="bodyXs" tone="caution">Store record inactive</Text>
                </Tooltip>
            ) : null}
        </BlockStack>
    );
};

/**
 * The app's own plan for this store: its name, and — only when both were measured — what it costs.
 *
 *  THE PRICE GATE IS AN EXPLICIT NULL TEST, NOT `Number.isFinite(Number(...))`. `Number(null)` is
 * `0` and finite, so the old gate passed for a named plan whose amount Shopify never sent, and the
 * sub-line then rendered `$0.00 EVERY_30_DAYS` — a claim the plan is free, which
 * `storeRow.resolver.ts` publishes `plan_price: null` specifically to prevent.
 *
 * The cadence is a SEPARATE gate rather than part of the same one: `plan_interval` is null whenever
 * no settled payout has named a cadence, and a real price with an unknown cadence is still worth
 * showing. `planIntervalLabel` returns '' there, which drops the cadence and keeps the price.
 */
const _renderPlan = (row) => {
    if (!row.plan_name) return _dash;
    const hasPrice = row.plan_price !== null && row.plan_price !== undefined && Number.isFinite(Number(row.plan_price));
    const interval = planIntervalLabel(row.plan_interval);
    return (
        <BlockStack gap="050" inlineAlign="start">
            <Text as="span" variant="bodyMd">{row.plan_name}</Text>
            {hasPrice ? (
                <Text as="span" variant="bodySm" tone="subdued">
                    {`${fmtMoney(row.plan_price)}${interval ? ` \u00B7 ${interval}` : ''}`}
                </Text>
            ) : null}
        </BlockStack>
    );
};

/**
 * Organic vs paid for THIS install, as a badge.
 *
 * The one place the paid/organic split of an install is visible per store. `isPaidSurface` is a
 * SUFFIX test, not equality with 'search_ad' — production carries `homepage_ad` too — so a paid
 * variant of a surface nobody has enumerated still reads as paid here rather than as browsing.
 */
const _renderSurface = (row) => {
    if (!row.surface_type) return _dash;
    const isPaid = isPaidSurface(row.surface_type);

    let tone = undefined;
    if (isPaid) tone = 'success';
    else if (isSearchSurface(row.surface_type)) tone = 'info';

    return (
        <Tooltip content={`App Store surface: ${row.surface_type}`}>
            <Badge tone={tone}>{surfaceLabel(row.surface_type)}</Badge>
        </Tooltip>
    );
};

/**
 * Where Shopify actually served us for that visit — results page, then rank on it.
 *
 * Only the `listing_url` capture mechanism carries positions; the ad-click event never did. An em
 * dash therefore means "not measured", which is why nothing here ever renders a 0.
 */
const _renderSurfacePosition = (row) => {
    // ⚠️ Page vs Section is decided by the SURFACE, not chosen here — `surface_inter_position` is a
    // results page on search/category/collection and a section index on home/story/app_details.
    const label = surfacePositionLabel(row.surface_type, row.surface_inter_position, row.surface_intra_position);
    if (!label) return _dash;

    return (
        <Tooltip content="Where Shopify served this listing on the visit that ended in the install — the results page (or page section) and the position within it.">
            <Text as="span" variant="bodyMd" numeric>{label}</Text>
        </Tooltip>
    );
};

const _renderDate = (value) => <Text as="span" variant="bodySm">{fmtDate(value)}</Text>;

const _renderMoney = (value) => <Text as="span" alignment="end" numeric>{fmtMoney(value)}</Text>;

export const STORE_COLUMNS = {
    store: { title: 'Store', render: _renderStore },
    install_state: { title: 'Install state', render: _renderInstallState },
    came_from: { title: 'Came from', render: _renderCameFrom },
    surface: { title: 'Via', render: _renderSurface },
    surface_position: { title: 'Served at', render: _renderSurfacePosition },
    status: { title: 'Status', render: _renderStatus },
    plan: { title: 'Plan', render: _renderPlan },
    monthly_spend: { title: 'Monthly spend', alignment: 'end', render: (r) => _renderMoney(r.monthly_spend) },
    total_spend: { title: 'Total spend', alignment: 'end', render: (r) => _renderMoney(r.total_spend) },
    installed_at: { title: 'Installed', render: (r) => _renderDate(r.installed_at) },
    activation_date: { title: 'Activation date', render: (r) => _renderDate(r.activation_date) },
    // A trial cut short never reached its conversion date — the planned date is struck through
    // rather than hidden, so the intent stays visible.
    conversion_date: {
        title: 'Conversion date',
        render: (r) => (
            <Text as="span" variant="bodySm" tone={r.conversion_date_voided ? 'subdued' : undefined}>
                {r.conversion_date_voided ? <s>{fmtDate(r.conversion_date)}</s> : fmtDate(r.conversion_date)}
            </Text>
        )
    },
    churn_date: { title: 'Churn date', render: (r) => _renderDate(r.churn_date) },
    trial_end: { title: 'Trial ends', render: (r) => _renderDate(r.trial_end) }
};

/**
 * @param {Object}   props
 * @param {Array}    props.rows       - store rows from either endpoint.
 * @param {String[]} props.columns    - ordered STORE_COLUMNS keys.
 * @param {String}   props.appId      - partner app, needed to build detail links.
 * @param {Boolean}  [props.loading]
 * @param {String}   [props.emptyHeading]
 * @param {Node}     [props.emptyBody]
 * @param {Function} [props.rowKey]   - row => stable key. Defaults to tenant_id, then
 *   domain+install date: an install cohort can legitimately contain the SAME domain twice (install,
 *   uninstall, reinstall), so the domain alone is not unique.
 *
 * ROW CLICK OPENS A PANEL, NOT A PAGE
 * -----------------------------------
 * The detail drawer is owned HERE rather than by each page, for the same reason the columns are a
 * registry: every store list gets the identical behaviour without four call sites re-wiring it, and
 * `InstallCohortTable` — which threads no row callbacks at all — needs no change to inherit it.
 * The drawer portals itself out, so it does not matter that this component renders inside a
 * `Card` (a `z-index: 0` stacking context that also clips), inside `IndexTable`'s horizontal scroll
 * container, or inside another overlay — a store opened from `RevenueMovementStoresPanel`'s table
 * sits in a dialog that animates a `transform`, which would otherwise become the containing block
 * for anything `position: fixed` inside it.
 */
const StoreTable = ({ rows, columns, appId, loading, emptyHeading, emptyBody, rowKey }) => {
    const cols = columns.map((key) => ({ key, ...STORE_COLUMNS[key] })).filter((c) => c.render);
    const safeRows = Array.isArray(rows) ? rows : [];

    /**
     * The default SELECTION key is not the API identity: an install cohort can legitimately contain
     * the SAME domain twice (install, uninstall, reinstall), so the domain alone would highlight two
     * rows and confuse the stepper. The drawer derives the API key from the row separately.
     */
    const _key = rowKey || ((row) => row.tenant_id || `${row.shop_domain}-${row.installed_at || ''}`);

    // All the open/close/highlight/step machinery lives in the hook, so the hand-rolled shop tables
    // on Revenue, Revenue Churn, Logo Churn and Trial Funnel behave identically to this one.
    const { drawer, open: openPanel, isOpen, from } = useStoreDetailDrawer({
        rows: safeRows,
        appId,
        rowKey: _key
    });

    if (!loading && safeRows.length === 0) {
        // The panel is rendered on this branch too. A list that empties under an open panel — a
        // filter response landing late — must not take the panel down with it; the reader still gets
        // to read the store they opened, and to close it themselves.
        return (
            <>
                <EmptyState heading={emptyHeading || 'No stores match'} image="">
                    {emptyBody || <p>Try a different filter or clear the search.</p>}
                </EmptyState>
                {drawer}
            </>
        );
    }

    return (
        <>
            <IndexTable
                resourceName={{ singular: 'store', plural: 'stores' }}
                itemCount={safeRows.length}
                selectable={false}
                loading={loading}
                headings={cols.map((c) => ({ title: c.title, alignment: c.alignment }))}
            >
                {safeRows.map((row, index) => {
                    const id = String(_key(row));
                    const onSelect = () => openPanel(row, index);
                    return (
                        <IndexTable.Row
                            id={id}
                            key={id}
                            position={index}
                            /* `selectable={false}`, so this only tints the row — no checkbox
                               appears. It is what keeps the reader's place in the list while the
                               panel is open and while the stepper moves through it. */
                            selected={isOpen(row, index)}
                            onClick={onSelect}
                        >
                            {cols.map((c) => (
                                <IndexTable.Cell key={c.key}>
                                    {c.render(row, { appId, from, onSelect })}
                                </IndexTable.Cell>
                            ))}
                        </IndexTable.Row>
                    );
                })}
            </IndexTable>
            {drawer}
        </>
    );
};

export default StoreTable;
