import { Badge, Banner, BlockStack, IndexTable, Text, Tooltip } from '@shopify/polaris';
import { useRef } from 'react';
import SlideOverPanel from './SlideOverPanel';
import useStoreDetailDrawer from './store/useStoreDetailDrawer';
import {
    INSTALL_STATE_LABELS,
    INSTALL_STATE_TONE,
    MOVEMENT_SINCE_HELP,
    MOVEMENT_SINCE_LABELS,
    MOVEMENT_SINCE_TONE
} from './store/storePresentation';
import { fmtDate, fmtMoney, fmtSigned } from './moneyFormat';

// The heading for each bucket. Named for the FORCE, not for the field — "New business" rather than
// "new", so the panel title reads as a sentence fragment about the period rather than as a payload key.
const BUCKET_TITLES = {
    new: 'New business',
    expansion: 'Expansion',
    contraction: 'Contraction',
    churned: 'Churned'
};

// Said in the bucket's own terms rather than one generic "no results": "nothing moved" is ambiguous
// about WHICH direction nothing moved in, and this panel only ever shows one direction at a time.
const BUCKET_EMPTY = {
    new: 'No store started paying in this period.',
    expansion: 'No store moved up in this period.',
    contraction: 'No store moved down in this period.',
    churned: 'No store stopped paying in this period.'
};

const _DASH = <Text as="span" tone="subdued">—</Text>;

/**
 * Adapt a movement row to the identity fields the store detail drawer reads.
 *
 * ⚠️ `shop_id` MEANS DIFFERENT THINGS PER ENDPOINT, AND IN THIS BUILD IT IS NEVER A TENANT ID. An
 * earlier version of this note claimed the opposite — that on a movement row `shop_id` "really is the
 * tenant id, whose map key is `String(subscription.tenant_id)`" — and that is false here:
 * `MovementMember.shop_key` is Shopify's PARTNER shop GID, read straight off
 * `PartnerAppTransaction.shop_id`, which the sync fills from `node.shop.id`. The detail endpoint
 * cannot resolve one.
 *
 * THE HEX GUARD IS WHAT MAKES THE CODE CORRECT REGARDLESS, and it is the only thing that does — a GID
 * (`gid://partners/Shop/123`) never matches 24 hex characters, so every row falls through to
 * `shop_domain`, which the endpoint CAN use. The guard is kept rather than replaced by a flat "never
 * send a tenant id" because it is written against the SHAPE, so a deployment whose movement rows do
 * carry an ObjectId is served correctly without this file having to know which is which.
 * `storeDetailRequestParams` discriminates the same way: a non-ObjectId key goes on the wire as a
 * `shop_domain`, and publishing a junk `tenant_id` would make `canOpen` say yes to a click that can
 * only fail.
 *
 * Declared at MODULE scope, not inside the component: the hook takes it as a dependency of its own
 * `useCallback`s, and a function rebuilt every render would invalidate them every render.
 *
 * @param {Object} row - a MovementShopRow.
 * @returns {Object} `{ tenant_id?, shop_domain }`
 */
const _toStoreRow = (row) => {
    const mapped = { shop_domain: row.shop_domain };
    if (row.shop_id && /^[a-f0-9]{24}$/i.test(String(row.shop_id))) {
        mapped.tenant_id = String(row.shop_id);
    }
    return mapped;
};

/**
 * The date a store stopped paying, and — when it matters — WHAT DATED IT.
 *
 * ⚠️ TWO KINDS OF DATE UNDER ONE COLUMN HEADING. `churn_basis: 'partner_event'` is a real
 * cancellation with Shopify's own timestamp on it. `'ledger_window'` means no such event ever reached
 * us, and the date shown is the instant the store's last settled payout aged out of the active
 * window — which is ALWAYS LATER than the day they actually cancelled, by up to one billing cycle
 * plus payout grace. Printed bare, the two are indistinguishable, and the second one silently
 * over-states how long the merchant paid.
 *
 * The endpoint publishes `churn_basis` on every churned row and warns about the count in
 * `warnings[]`; this marks the individual rows, so a reader quoting one date knows which kind it is.
 * A row with no basis at all (an older payload) is printed exactly as it was before.
 *
 * @param {Object} row - a MovementShopRow from the `churned` bucket.
 * @returns {React.ReactNode}
 */
const _renderChurnDate = (row) => {
    const shown = fmtDate(row.churn_date);
    if (row.churn_basis !== 'ledger_window') {
        return shown;
    }
    return (
        <Tooltip content="No cancellation event reached us for this store, so this is the day its last settled payout aged out of the active window — always later than the day it actually cancelled.">
            <Text as="span" tone="subdued">{`${shown} (inferred)`}</Text>
        </Tooltip>
    );
};

/**
 * "Plan today" — what the store is paying for NOW, and how that compares with the plan beside it.
 *
 *  Reads the MONEY vocabulary only (`MOVEMENT_SINCE_*`). Whether the app is still installed is a
 * different fact from a different source and lives in its own column; folding the two into one
 * "Left" badge would lend event-sourced certainty to a charge-row inference and would erase the row
 * a reader most wants to find — a store that still has the app and simply stopped paying.
 *
 *  The empty case says "Not on a paid plan", never "Free plan" and never "No plan". A store absent
 * from the paying set may have moved to the free plan or may have had its charge stop; nothing in
 * the data separates them, and naming either one states a fact we do not have.
 *
 * @param {Object} row - a MovementShopRow carrying the `*_now` fields.
 */
const _renderPlanToday = (row) => {
    const state = row.since_state;
    if (!state) {
        return _DASH;
    }

    const label = MOVEMENT_SINCE_LABELS[state] || state;
    let badge = <Badge tone={MOVEMENT_SINCE_TONE[state]}>{label}</Badge>;
    if (MOVEMENT_SINCE_HELP[state]) {
        badge = <Tooltip content={MOVEMENT_SINCE_HELP[state]}>{badge}</Tooltip>;
    }

    let detail = <Text as="span" variant="bodyXs" tone="subdued">Not on a paid plan</Text>;
    if (row.is_paying_now) {
        // The charge row does not always carry a plan title. Printing the money alone is the honest
        // fallback — inventing a name for it would be worse than leaving the question open.
        let line = fmtMoney(row.mrr_now);
        if (row.plan_name_now) {
            line = `${row.plan_name_now} · ${fmtMoney(row.mrr_now)}`;
        }
        detail = <Text as="span" variant="bodyXs">{line}</Text>;
    }

    //  `inlineAlign="start"` is load-bearing. `.Polaris-BlockStack` is `display:flex` with
    // `align-items` defaulting to STRETCH, so a Badge — an inline-flex box — fills the whole cell as
    // a full-width slab instead of a pill. Invisible on text-only children, which is why the
    // neighbouring columns never showed it.
    return (
        <BlockStack gap="050" inlineAlign="start">
            {badge}
            {detail}
        </BlockStack>
    );
};

/**
 * "Installed today" — whether the app is on the store RIGHT NOW, from the Partner event replay.
 *
 * ⚠️ Judged at now, NOT at the end of the selected period: a store can have left after the window
 * closed. The panel footer names both instants so the column is never read as period-scoped.
 *
 * ⚠️ `UNKNOWN` is an absence of evidence, not an uninstall — hence untoned, and tooltipped saying
 * exactly that. When NOTHING has synced for the app the column is not rendered at all (see
 * `showInstall` below): a whole table of "unknown" reads as N broken stores rather than one gap.
 *
 * ⚠️ `DEACTIVATED` folds to not-installed but means the merchant's Shopify account went away, not
 * that they removed the app. The caption distinguishes them because the two lead to different
 * follow-ups — and because this fold is why our count reads lower than Shopify's Partner dashboard.
 *
 * @param {Object} row - a MovementShopRow carrying the `install_*` fields.
 */
const _renderInstalledToday = (row) => {
    const state = row.install_state;
    if (!state) {
        return _DASH;
    }

    const label = INSTALL_STATE_LABELS[state] || state;
    let badge = <Badge tone={INSTALL_STATE_TONE[state]}>{label}</Badge>;
    if (state === 'UNKNOWN') {
        badge = (
            <Tooltip content="No install or uninstall event has ever synced for this store, so its state cannot be determined. This is not evidence that the app has been removed.">
                {badge}
            </Tooltip>
        );
    }

    let caption = null;
    if (state === 'UNINSTALLED') {
        let what = 'App removed';
        if (row.install_state_event === 'DEACTIVATED') {
            what = 'Shopify account closed';
        }
        caption = (
            <Text as="span" variant="bodyXs" tone="subdued">{`${what} ${fmtDate(row.install_state_at)}`}</Text>
        );
    }

    // Charge rows say we are still billing a store the event replay says the app has left. Worth
    // surfacing rather than reconciling silently: it is either a cancellation that never synced or
    // a subscription genuinely still running, and the two need opposite actions.
    let conflict = null;
    if (row.is_paying_now && state === 'UNINSTALLED') {
        conflict = (
            <Tooltip content="We are still counting MRR for this store, but the Partner API says the app is no longer on it — usually a cancellation that never reached us.">
                <Text as="span" variant="bodyXs" tone="caution">Still counted as paying</Text>
            </Tooltip>
        );
    }

    return (
        <BlockStack gap="050" inlineAlign="start">
            {badge}
            {caption}
            {conflict}
        </BlockStack>
    );
};

/**
 * The stores behind ONE figure on the MRR movement card.
 *
 *  NO FETCH. Unlike every other drill-down in this section, the rows are already in the revenue
 * page's response — `data.movement_shops` — and the counts printed on the card are DERIVED from
 * these very lists server-side. So the panel and the number that opened it cannot disagree, and
 * re-fetching would only introduce a way for them to.
 *
 * Each bucket gets the columns that answer its own question, because one shared column set would
 * print a column that is constant down the whole table: `new` has no "was" (it is always zero) and
 * `churned` has no "now" (it is always zero), while expansion and contraction are only legible as
 * both endpoints plus the step between them.
 *
 * WHY THIS IS NOT `StoreTable`
 * ----------------------------
 * `useStoreDetailDrawer`'s own JSDoc already settles it for this class of table: the shared registry
 * has no column for `previous_mrr`, `delta` or a per-bucket money pair, `StoreTable` accepts no
 * ad-hoc extra columns, and pushing four bucket-specific money keys into a registry shared by four
 * other pages would cost them width for columns they never render. What IS shared is the part that
 * drifts — the drawer BEHAVIOUR and the badge VOCABULARY, both imported rather than re-declared.
 *
 * @param {Object}   props
 * @param {String}   [props.bucket]      - `'new' | 'expansion' | 'contraction' | 'churned'`; null closes the panel.
 * @param {Array}    [props.rows]        - The bucket's `MovementShopRow`s, pre-sorted by |delta| descending.
 * @param {Object}   [props.since]       - `data.movement_shops_since`: the set-level caveats behind
 *   the "today" columns. Absent (a backend that predates them) hides those columns entirely rather
 *   than rendering a wall of em dashes.
 * @param {String}   [props.periodLabel] - The window the movement covers, named in the subtitle.
 * @param {String}   [props.appId]       - Partner app the rows belong to; the detail drawer needs it.
 * @param {Function} props.onClose
 */
const RevenueMovementStoresPanel = ({ bucket, rows, since, periodLabel, appId, onClose }) => {
    let incomingRows = [];
    if (Array.isArray(rows)) {
        incomingRows = rows;
    }

    /**
     * What the panel keeps SHOWING while it slides out.
     *
     * `bucket` going null is the close signal, but `SlideOverPanel` deliberately outlives it by one
     * animation. Rendering straight off the live props would therefore swap a full table for
     * "No store started paying in this period." and the heading for a generic one, for the whole
     * 300ms of the exit — the reader watches their data be replaced by an empty state on the way
     * out. Holding the last OPEN subject means the panel leaves showing what it was showing.
     *
     * `since` is held with the rows for the same reason: the columns it gates must not disappear
     * mid-exit if the page's payload is replaced while the panel is closing.
     *
     * Written during render rather than in an effect: an effect runs after paint, which is exactly
     * the frame this is here to fix. The write is idempotent — same input, same stored value — so a
     * double render cannot corrupt it.
     */
    const lastOpen = useRef({ bucket: null, rows: [], since: null });
    if (bucket) {
        lastOpen.current = { bucket, rows: incomingRows, since: since || null };
    }
    let shownBucket = lastOpen.current.bucket;
    let safeRows = lastOpen.current.rows;
    let shownSince = lastOpen.current.since;
    if (bucket) {
        shownBucket = bucket;
        safeRows = incomingRows;
        shownSince = since || null;
    }

    /**
     * Clicking a row opens the same store detail panel every other store list uses — over this one,
     * which keeps its place underneath. See `_panelStack` in SlideOverPanel for how Escape is
     * arbitrated between the two.
     *
     * Keyed on `shop_id || shop_domain`: a store can appear in at most one bucket and at most once
     * within it (the buckets are walked from a Map keyed by tenant), so either is unique here.
     */
    const drawer = useStoreDetailDrawer({
        rows: safeRows,
        appId,
        rowKey: (row) => row.shop_id || row.shop_domain,
        toStoreRow: _toStoreRow
    });

    const title = BUCKET_TITLES[shownBucket] || 'MRR movement';
    const emptyMessage = BUCKET_EMPTY[shownBucket] || 'Nothing moved in this bucket.';

    let noun = 'stores';
    if (safeRows.length === 1) {
        noun = 'store';
    }
    let subtitle = `${safeRows.length} ${noun}`;
    if (periodLabel) {
        subtitle = `${periodLabel} • ${safeRows.length} ${noun}`;
    }

    /**
     * WHICH "today" columns earn their place.
     *
     *  `close_is_now` is the whole reason this is conditional. When the selected period ends
     * today, the period close and "today" are the SAME instant, so for New / Expansion /
     * Contraction — all read out of the closing set — `plan_name_now` is literally `plan_name` and
     * every row's badge says "Same plan". That is a column of one repeated value, which is the exact
     * thing this panel's per-bucket column sets exist to avoid.
     *
     * The CHURNED bucket is exempt: its rows are measured at the period OPEN and are absent from the
     * close, so its comparison spans the whole period no matter when the period ends — and a store
     * that churned and came back is one of the most useful rows here.
     *
     * The install column is never redundant: a store can have started paying inside the period and
     * already removed the app. It is dropped only when NOTHING has synced for the app, where a whole
     * column of "unknown" would read as N broken stores instead of one missing sync.
     */
    let showPlanToday = false;
    let showInstall = false;
    if (shownSince) {
        showPlanToday = !shownSince.close_is_now || shownBucket === 'churned';
        showInstall = shownSince.install_state_available === true;
    }

    // "Plan" alone is ambiguous the moment a second plan column sits beside it, so the existing
    // column is renamed — not duplicated — when that happens. "Then" reads correctly for both
    // vintages: the period close for three buckets, the period open for churned.
    let planHeading = 'Plan';
    if (showPlanToday) {
        planHeading = 'Plan then';
    }

    // The columns AFTER Shop and Plan, chosen per bucket. Seeded with the two-column base so a
    // bucket key we do not recognise still renders a readable table instead of a headings/cells
    // mismatch.
    let headings = [{ title: 'Shop' }, { title: planHeading }];
    let renderValueCells = () => null;

    if (shownBucket === 'new') {
        headings = [{ title: 'Shop' }, { title: planHeading }, { title: 'MRR added' }];
        renderValueCells = (row) => (
            <IndexTable.Cell>
                <Text as="span" fontWeight="semibold" tone="success">{fmtMoney(row.mrr)}</Text>
            </IndexTable.Cell>
        );
    }

    if (shownBucket === 'expansion' || shownBucket === 'contraction') {
        headings = [
            { title: 'Shop' },
            { title: planHeading },
            { title: 'Was' },
            { title: 'Now' },
            { title: 'Change' }
        ];
        // Toned from the ROW's own delta rather than from the bucket: the two buckets share these
        // columns, and a row's sign is the thing being shown.
        renderValueCells = (row) => {
            let tone = 'success';
            if (Number(row.delta) < 0) {
                tone = 'critical';
            }
            return (
                <>
                    <IndexTable.Cell>{fmtMoney(row.previous_mrr)}</IndexTable.Cell>
                    <IndexTable.Cell>{fmtMoney(row.mrr)}</IndexTable.Cell>
                    <IndexTable.Cell>
                        <Text as="span" fontWeight="semibold" tone={tone}>{fmtSigned(row.delta)}</Text>
                    </IndexTable.Cell>
                </>
            );
        };
    }

    if (shownBucket === 'churned') {
        // `previous_mrr`, not `mrr`: a churned row closes the window at zero, so what was lost is
        // what it was paying when the window opened.
        headings = [
            { title: 'Shop' },
            { title: planHeading },
            { title: 'MRR lost' },
            { title: 'Stopped on' }
        ];
        renderValueCells = (row) => (
            <>
                <IndexTable.Cell>
                    <Text as="span" fontWeight="semibold" tone="critical">{fmtMoney(row.previous_mrr)}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>{_renderChurnDate(row)}</IndexTable.Cell>
            </>
        );
    }

    // Appended AFTER the per-bucket money columns so the row reads left to right as
    // "who → what they had → what it was worth → where they are now".
    if (showPlanToday) {
        headings = headings.concat([{ title: 'Plan today' }]);
    }
    if (showInstall) {
        headings = headings.concat([{ title: 'Installed today' }]);
    }

    const renderTodayCells = (row) => {
        let planCell = null;
        if (showPlanToday) {
            planCell = <IndexTable.Cell>{_renderPlanToday(row)}</IndexTable.Cell>;
        }
        let installCell = null;
        if (showInstall) {
            installCell = <IndexTable.Cell>{_renderInstalledToday(row)}</IndexTable.Cell>;
        }
        return (
            <>
                {planCell}
                {installCell}
            </>
        );
    };

    //  `domains_seen === 0` means NOTHING has synced for this partner app — it is not evidence
    // that nobody is installed, and rendering it as a per-store "unknown" would say exactly that.
    // Stated once, at the top, with the column removed.
    let syncBanner = null;
    if (shownSince && shownSince.install_state_available === false) {
        syncBanner = (
            <Banner tone="warning">
                <Text as="p" variant="bodySm">
                    No install or uninstall event has ever synced for this app, so whether these stores still
                    have it installed cannot be shown. This is a sync gap, not evidence that they uninstalled.
                </Text>
            </Banner>
        );
    }

    let body = <Text as="p" variant="bodySm" tone="subdued">{emptyMessage}</Text>;
    if (safeRows.length > 0) {
        body = (
            <IndexTable
                resourceName={{ singular: 'store', plural: 'stores' }}
                itemCount={safeRows.length}
                headings={headings}
                selectable={false}
            >
                {safeRows.map((row, i) => {
                    // A row whose identity the detail endpoint cannot resolve is left unclickable
                    // rather than offering a click that can only fail — `canOpen` decides.
                    const canOpen = drawer.canOpen(row);
                    let onSelect;
                    if (canOpen) {
                        onSelect = () => drawer.open(row, i);
                    }
                    return (
                        <IndexTable.Row
                            id={`movement-${i}`}
                            key={`${row.shop_id || row.shop_domain || 'shop'}-${i}`}
                            position={i}
                            selected={drawer.isOpen(row, i)}
                            onClick={onSelect}
                        >
                            <IndexTable.Cell>
                                <Text as="span" variant="bodyMd" fontWeight="semibold">
                                    {row.shop_domain || row.shop_id}
                                </Text>
                            </IndexTable.Cell>
                            <IndexTable.Cell>{row.plan_name || '—'}</IndexTable.Cell>
                            {renderValueCells(row)}
                            {renderTodayCells(row)}
                        </IndexTable.Row>
                    );
                })}
            </IndexTable>
        );
    }

    // Every "today" column is judged at a DIFFERENT instant from the money beside it, so the two
    // instants are named rather than left for the reader to assume they match.
    let todayNote = null;
    if (showPlanToday || showInstall) {
        todayNote = (
            <Text as="p" variant="bodySm" tone="subdued">
                &ldquo;Today&rdquo; is measured now, not at the end of the period — a store can have changed plan
                or removed the app since. &ldquo;Not on a paid plan&rdquo; cannot tell a move to the free plan from a
                charge that simply stopped.
            </Text>
        );
    }

    let closeIsNowNote = null;
    if (shownSince && shownSince.close_is_now && shownBucket !== 'churned') {
        closeIsNowNote = (
            <Text as="p" variant="bodySm" tone="subdued">
                This period ends today, so the plan at the period close is the plan today — only the install
                state adds anything here.
            </Text>
        );
    }

    let blankDomainNote = null;
    if (showInstall && shownSince.install_blank_domain_events > 0) {
        blankDomainNote = (
            <Text as="p" variant="bodySm" tone="caution">
                {`${shownSince.install_blank_domain_events} install/uninstall event(s) carry no shop domain and could not be attributed, so "Installed" reads slightly high.`}
            </Text>
        );
    }

    const footer = (
        <BlockStack gap="100">
            <Text as="p" variant="bodySm" tone="subdued">
                Measured between the start and end of the selected period.
            </Text>
            {todayNote}
            {closeIsNowNote}
            {blankDomainNote}
        </BlockStack>
    );

    return (
        <SlideOverPanel
            open={!!bucket}
            onClose={onClose}
            // Seven columns at the widest, which is what this width is sized for. `IndexTable`
            // brings its own horizontal scroll container, so anything still too wide scrolls inside
            // the table rather than breaking the panel.
            width="min(72rem, 100vw)"
            title={title}
            subtitle={subtitle}
            accessibilityLabel={`${title} — the stores behind this figure`}
            scrollResetKey={shownBucket}
            footer={footer}
        >
            <BlockStack gap="300">
                {syncBanner}
                {body}
            </BlockStack>
            {/* Portals itself out, so it paints ABOVE this panel rather than inside its body. */}
            {drawer.drawer}
        </SlideOverPanel>
    );
};

export default RevenueMovementStoresPanel;
