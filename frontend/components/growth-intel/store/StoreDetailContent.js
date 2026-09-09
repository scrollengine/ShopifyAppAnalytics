import { Badge, Banner, BlockStack, Box, Card, Divider, InlineStack, Link, Text } from '@shopify/polaris';
import { useMemo } from 'react';
import {
    STORE_STATE_LABELS,
    STORE_STATE_TONE,
    ACQUISITION_CHANNEL_TONE,
    fmtMoney,
    fmtDate,
    fmtDateLong,
    isSearchSurface,
    planIntervalLabel,
    surfacePositionLabel
} from './storePresentation';

/**
 * The body of a store's detail view, rendered identically by the full page
 * (`pages/subscriptions/[tenantId].js`) and by the slide-over
 * drawer that opens from any store table.
 *
 * WHY IT IS SHARED
 * ----------------
 * The drawer exists so a reader can inspect a store WITHOUT losing the list's
 * filters, page and scroll position — but the full page has to stay, because a
 * detail URL is what a deep link, a new tab and a middle-click resolve to. Two
 * copies of this markup would drift exactly the way the two store TABLES did
 * before `StoreTable` unified them, so there is one copy and the caller picks a
 * `layout`.
 *
 * `layout` is an explicit prop rather than a CSS breakpoint because the two
 * views differ in ORDER, not just in column count: the page reads as a left
 * rail beside a timeline, while the drawer is a single column that has to lead
 * with the plan and the acquisition — the two facts a reader opens a drawer
 * for — and let the timeline run long at the bottom. A media query keys off the
 * viewport, which says nothing about how wide the drawer is.
 */

/**
 * The one-line caption for a field that came back empty for a STRUCTURAL reason.
 *
 * ⚠️ Deliberately short. `data.unavailable[field].message` is a whole paragraph and every
 * NOT_EXPOSED field carries the SAME one, so printing it per field is the "twelve identical prompts
 * beside twelve em dashes" that the backend constant's own note says trains an operator to stop
 * reading the panel. The paragraph is stated once per card instead; this is what marks the field.
 */
const UNAVAILABLE_CAPTION = {
    NOT_EXPOSED: 'Not exposed by the Partner API',
    NOT_PUSHED: 'Not pushed yet'
};

/**
 * `breakWord` because these carry the values with no spaces in them — a shop
 * domain, a `gid://partners/Shop/…` platform id, a website. On the full-width
 * page an overflow bled harmlessly into ~1000px of right-column whitespace; in a
 * ~52rem drawer the same string runs off the panel edge.
 *
 * ⚠️ The `||` fallback is deliberate and load-bearing: several call sites pass
 * `null` precisely to get "None". Do not "fix" it to `??`.
 *
 *  `unavailable` IS NOT THE SAME AS "None", AND THAT IS THE WHOLE POINT OF THE PROP. "None" is a
 * MEASURED absence — we asked, and this merchant has no such value. A field in the response's
 * `unavailable` map was never obtainable at all: the Partner API's `Shop` object has four fields and
 * no merchant country on any version, so "Country: None" states a fact about the merchant that
 * nobody measured. The backend has published that distinction since the first release and nothing
 * rendered it, which left `NOT_EXPOSED_MESSAGE` written for a card header that did not exist.
 *
 * @param {Object} props
 * @param {String} props.label
 * @param {*} [props.value] - The value, or a falsy value to fall through to "None".
 * @param {Object} [props.unavailable] - `{ reason, message }` from `data.unavailable`, when this
 *   field's blank has a structural explanation. Ignored when `value` is present.
 */
const _SideField = ({ label, value, unavailable }) => {
    let body = <Text as="span" variant="bodyMd" breakWord>{value || 'None'}</Text>;
    if (!value && unavailable) {
        body = (
            <BlockStack gap="050">
                <Text as="span" variant="bodyMd">—</Text>
                <Text as="span" variant="bodyXs" tone="subdued">
                    {UNAVAILABLE_CAPTION[unavailable.reason] || unavailable.reason}
                </Text>
            </BlockStack>
        );
    }
    return (
        <BlockStack gap="050">
            <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
            {body}
        </BlockStack>
    );
};

const _StatTile = ({ label, value, hint }) => (
    <Card>
        <BlockStack gap="100">
            <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
            <Text as="span" variant="headingLg">{value}</Text>
            {hint ? <Text as="span" variant="bodySm" tone="subdued">{hint}</Text> : null}
        </BlockStack>
    </Card>
);

const TONE_COLOR = {
    positive: 'var(--p-color-bg-fill-success)',
    negative: 'var(--p-color-bg-fill-critical)',
    neutral: 'var(--p-color-border)'
};

// Where each timeline entry came from. Shown per entry so a gap in one source is
// visible rather than reading as "nothing happened".
const SOURCE_LABEL = {
    partner_event: 'Partner API',
    application_charge: 'Billing record',
    transaction: 'Payout ledger',
    // A source with no entry here renders its raw snake_case key — no error, just an ugly
    // string on screen. Add the label in the same change as any new backend source.
    ga4_attribution: 'Listing analytics'
};

const _TimelineEntry = ({ entry }) => (
    <InlineStack gap="300" blockAlign="start" wrap={false}>
        <div style={{ paddingTop: 6 }}>
            <div style={{
                width: 9, height: 9, borderRadius: '50%',
                background: TONE_COLOR[entry.tone] || TONE_COLOR.neutral
            }}
            />
        </div>
        {/* `wrap={false}` above keeps the dot beside the text, so the text block
            is what has to shrink — and a flex item's default `min-width: auto`
            refuses to shrink below its longest word. Charge ids and gids in
            `entry.detail` have no break opportunity, so without `minWidth: 0`
            they push the row wider than the panel. */}
        <div style={{ minWidth: 0 }}>
            <BlockStack gap="050">
                <InlineStack gap="200" blockAlign="center" wrap>
                    <Text as="span" variant="bodyMd" breakWord>{entry.label}</Text>
                    <Text as="span" variant="bodySm" tone="subdued">{SOURCE_LABEL[entry.source] || entry.source}</Text>
                </InlineStack>
                {entry.detail ? (
                    <Text as="span" variant="bodySm" tone="subdued" breakWord>{entry.detail}</Text>
                ) : null}
            </BlockStack>
        </div>
    </InlineStack>
);

/** Delegates to the shared formatter so "Page" vs "Section" cannot drift from the store table. */
const formatServedAt = (acquisition) => {
    if (!acquisition) return '';
    return surfacePositionLabel(
        acquisition.surface_type,
        acquisition.surface_inter_position,
        acquisition.surface_intra_position
    );
};

/**
 * The lifecycle badges that sit beside the store's name.
 *
 * Exported so the page header and the drawer header render the SAME set — this
 * used to be inline in the page's `titleMetadata` and the drawer would have had
 * to reproduce it from memory.
 *
 * @param {Object} props.subscription - `data.subscription` from the detail endpoint.
 */
export const StoreStatusBadges = ({ subscription }) => {
    const sub = subscription || {};
    return (
        <InlineStack gap="150" blockAlign="center" wrap>
            <Badge tone={STORE_STATE_TONE[sub.status]}>
                {STORE_STATE_LABELS[sub.status] || sub.status}
            </Badge>
            {sub.billing_stale ? <Badge tone="warning">Billing stale</Badge> : null}
            {/*  `=== false`, NEVER `!sub.store_active`. The detail endpoint publishes
                `store_active: null` for every store whose `install_state` is UNKNOWN — no
                relationship event has been synced for it, which is the ordinary state of a store
                whose install predates the incremental window. The loose test drew this badge on the
                null, so the drawer header accused a store we know nothing about of having removed
                the app. `StoreTable._renderStatus` has always tested `=== false`; the two now agree,
                and `storeDetail.types.ts` refuses to publish an unmeasured `true` to paper over it. */}
            {sub.store_active === false ? <Badge>Uninstalled</Badge> : null}
        </InlineStack>
    );
};

const _ActivityCard = ({ summary }) => (
    <Card>
        <BlockStack gap="300">
            <Text as="h2" variant="headingSm">Activity</Text>
            <InlineStack gap="600">
                <_SideField label="Lifetime value" value={fmtMoney(summary.lifetime_value)} />
                <_SideField label="Average spend" value={fmtMoney(summary.average_spend)} />
            </InlineStack>
            <Divider />
            <_SideField label="First payment" value={fmtDate(summary.first_payment_at)} />
            <_SideField label="Last payment" value={fmtDate(summary.last_payment_at)} />
        </BlockStack>
    </Card>
);

const _CameFromCard = ({ acquisition }) => (
    <Card>
        <BlockStack gap="300">
            <Text as="h2" variant="headingSm">Came from</Text>
            {acquisition ? (
                <BlockStack gap="200">
                    <InlineStack gap="200" blockAlign="center" wrap>
                        <Badge tone={ACQUISITION_CHANNEL_TONE[acquisition.channel]}>
                            {acquisition.channel_label}
                        </Badge>
                    </InlineStack>
                    {/* ⚠️ BROWSE SURFACES ONLY — the `isSearchSurface` test is a
                        gate, not a label switch. `surface_detail` is dual
                        purpose: on `home` it is the home-page section handle
                        and on `category` the category titles, which is
                        Shopify's own taxonomy and exactly what "Found via"
                        reports. On a search surface it is something else
                        entirely, so those rows are SKIPPED here rather than
                        relabelled — there is no taxonomy to report for them. */}
                    {acquisition.surface_detail && !isSearchSurface(acquisition.surface_type) ? (
                        <_SideField
                            label="Found via"
                            value={`“${acquisition.surface_detail}”`}
                        />
                    ) : null}
                    {/* The rank Shopify actually served this listing at, on the
                        visit that converted — a real merchant's result, not a
                        scraped ranking. Absent for installs captured before the
                        listing-URL parameters were read. */}
                    {formatServedAt(acquisition) ? (
                        <_SideField label="Served at" value={formatServedAt(acquisition)} />
                    ) : null}
                    {acquisition.source ? (
                        <_SideField
                            label="Source / medium"
                            value={`${acquisition.source}${acquisition.medium ? ` / ${acquisition.medium}` : ''}`}
                        />
                    ) : null}
                    {acquisition.campaign ? (
                        <_SideField label="Campaign" value={acquisition.campaign} />
                    ) : null}
                    <_SideField label="Arrived" value={fmtDate(acquisition.installed_at)} />
                    {/* Says which GA4 scope the numbers came from, so a
                        first-ever-acquisition value is never read as the
                        visit that actually converted. */}
                    {acquisition.attribution_source === 'user_first_acquisition' ? (
                        <Text as="span" variant="bodyXs" tone="subdued">
                            First-touch attribution — the visitor&apos;s first ever arrival, not
                            necessarily the visit that installed.
                        </Text>
                    ) : null}
                </BlockStack>
            ) : (
                <BlockStack gap="150" inlineAlign="start">
                    {/* `inlineAlign` so the Badge keeps its intrinsic width:
                        BlockStack's default align-items is stretch, which
                        turns a Badge into a full-width slab. The attributed
                        branch above escapes it only because its badge sits in
                        an InlineStack. */}
                    <Badge>Not attributed</Badge>
                    {/* Deliberately not "Direct". A missing listing-analytics
                        record is an absence of evidence, and Direct is already
                        the largest bucket for a wrong answer to hide in. */}
                    <Text as="span" variant="bodyXs" tone="subdued">
                        No listing-analytics record for this store. Listing analytics only
                        covers the period the BigQuery export reaches, and a merchant&apos;s
                        browser can block it entirely.
                    </Text>
                </BlockStack>
            )}
        </BlockStack>
    </Card>
);

/**
 * @param {Object} props
 * @param {Object} props.sub - `data.subscription`.
 * @param {Object} [props.unavailable] - `data.unavailable`, the field → reason map. Two of this
 *   card's four rows (`country`, `website`) are structurally unobtainable on this deployment, and
 *   without the map they printed "None", which reads as a measured fact about the merchant.
 */
const _CustomerDetailsCard = ({ sub, unavailable }) => {
    const unavail = unavailable || {};
    const countryGap = !sub.country ? unavail.country : null;
    const websiteGap = !sub.website ? unavail.website : null;
    // Stated ONCE per card, and only for a field on THIS card that actually came back blank. Both
    // entries carry the same paragraph, so a Set is what keeps it from being printed twice.
    const notes = [...new Set([countryGap, websiteGap].filter(Boolean).map((entry) => entry.message))];

    return (
        <Card>
            <BlockStack gap="300">
                <Text as="h2" variant="headingSm">Customer details</Text>
                <_SideField label="Country" value={sub.country} unavailable={countryGap} />
                <_SideField
                    label="Website"
                    value={sub.website ? (
                        <Link url={`https://${sub.website}`} target="_blank" removeUnderline>{sub.website}</Link>
                    ) : null}
                    unavailable={websiteGap}
                />
                <_SideField label="Store domain" value={sub.shop_domain} />
                {/* No `unavailable` entry: a blank Partner GID is a MEASURED absence — no synced
                    event for this store carried one — not a field the API cannot express. */}
                <_SideField label="Platform ID" value={sub.platform_id} />
                {notes.length > 0 ? (
                    <BlockStack gap="100">
                        {notes.map((note) => (
                            <Text as="span" key={note} variant="bodyXs" tone="subdued">{note}</Text>
                        ))}
                    </BlockStack>
                ) : null}
            </BlockStack>
        </Card>
    );
};

const _LifecycleDatesCard = ({ sub }) => (
    <Card>
        <BlockStack gap="300">
            <Text as="h2" variant="headingSm">Lifecycle dates</Text>
            <_SideField label="Activation date" value={fmtDate(sub.activation_date)} />
            <_SideField
                label="Conversion date"
                value={sub.conversion_date_voided ? (
                    <s>{fmtDate(sub.conversion_date)}</s>
                ) : fmtDate(sub.conversion_date)}
            />
            <_SideField label="Churn date" value={fmtDate(sub.churn_date)} />
            {sub.uninstalled_at ? (
                <_SideField label="Uninstalled" value={fmtDate(sub.uninstalled_at)} />
            ) : null}
        </BlockStack>
    </Card>
);

const _PlanCard = ({ sub, review, appName, columnMin }) => (
    <Card>
        <BlockStack gap="400">
            <InlineStack gap="200" blockAlign="center">
                <Badge tone="info">{appName}</Badge>
            </InlineStack>
            <Divider />
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${columnMin}, 1fr))`, gap: 16 }}>
                <BlockStack gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">Current plan</Text>
                    <Text as="span" variant="bodyMd" fontWeight="semibold" breakWord>{sub.plan_name || '—'}</Text>
                    {/* Gated on a plan PRICE that was actually published — `plan_price` is `null`
                        for a named plan whose amount Shopify never sent, and the cadence alone
                        ("EVERY_30_DAYS" under a blank) says nothing. `planIntervalLabel` turns the
                        raw enum into a word; it returns '' for a cadence no payout has named, which
                        drops the cadence and keeps the price. */}
                    {sub.plan_price === null || sub.plan_price === undefined ? null : (
                        <Text as="span" variant="bodySm" tone="subdued">
                            {`${fmtMoney(sub.plan_price)}${planIntervalLabel(sub.plan_interval) ? ` · ${planIntervalLabel(sub.plan_interval)}` : ''}`}
                        </Text>
                    )}
                </BlockStack>
                <BlockStack gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">Platform ID</Text>
                    {/* `breakWord`: a `gid://partners/Shop/123456789012` has no break
                        opportunity and is wider than this column at drawer widths, so
                        without it the id runs under "App review" next to it. */}
                    <Text as="span" variant="bodyMd" breakWord>{sub.platform_id || '—'}</Text>
                </BlockStack>
                <BlockStack gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">App review</Text>
                    {review.available ? (
                        <Text as="span" variant="bodyMd">{review.rating}</Text>
                    ) : (
                        <Text as="span" variant="bodySm" tone="subdued">{review.note}</Text>
                    )}
                    {review.listing_url ? (
                        <Link url={review.listing_url} target="_blank" removeUnderline>Open listing</Link>
                    ) : null}
                </BlockStack>
            </div>

            {sub.billing_stale ? (
                <Banner tone="warning" title="Billing looks stale">
                    <p>
                        Our records show this store on {sub.plan_name}, but no matching charge has
                        settled in the recent billing window. It may have cancelled without the
                        cancellation reaching us.
                    </p>
                </Banner>
            ) : null}
        </BlockStack>
    </Card>
);

const _TimelineCard = ({ groups, total }) => (
    <Card>
        <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingSm">Timeline</Text>
                <Text as="span" variant="bodySm" tone="subdued">{`${total} events`}</Text>
            </InlineStack>

            {groups.length === 0 ? (
                <Text as="span" tone="subdued">No events recorded for this store yet.</Text>
            ) : (
                <BlockStack gap="500">
                    {groups.map((group) => (
                        <BlockStack key={group.key} gap="300">
                            <Text as="span" variant="bodySm" fontWeight="semibold">
                                {fmtDateLong(group.at)}
                            </Text>
                            <Box paddingInlineStart="200">
                                <BlockStack gap="300">
                                    {group.entries.map((e, i) => (
                                        <_TimelineEntry key={`${group.key}-${i}`} entry={e} />
                                    ))}
                                </BlockStack>
                            </Box>
                        </BlockStack>
                    ))}
                </BlockStack>
            )}
        </BlockStack>
    </Card>
);

/**
 * @param {Object} props
 * @param {Object} props.data     - The `data` object from `subscriptions/detail`.
 * @param {String} [props.layout] - `'split'` (default, the full page) or `'stacked'` (the drawer).
 */
const StoreDetailContent = ({ data, layout = 'split' }) => {
    // Group the merged timeline by calendar day, preserving the newest-first order.
    const groupedTimeline = useMemo(() => {
        const entries = (data && data.timeline) || [];
        const groups = [];
        let current = null;
        for (const e of entries) {
            const key = e.at ? new Date(e.at).toDateString() : 'unknown';
            if (!current || current.key !== key) {
                current = { key, at: e.at, entries: [] };
                groups.push(current);
            }
            current.entries.push(e);
        }
        return groups;
    }, [data]);

    if (!data) return null;

    const sub = data.subscription || {};
    const summary = data.summary || {};
    const review = data.app_review || {};
    // `null` is meaningful: we looked for a GA4 attribution row and found none.
    const acquisition = data.acquisition || null;
    const stacked = layout === 'stacked';

    // A drawer is ~52rem wide, so `auto-fit` on the page's 200px track would fit
    // three of the four tiles across and orphan the fourth. Two fixed columns
    // give a 2×2 block that stays balanced at every drawer width.
    let statColumns = 'repeat(auto-fit, minmax(200px, 1fr))';
    if (stacked) {
        statColumns = 'repeat(2, minmax(0, 1fr))';
    }

    // Same reasoning one level down, for the plan card's three fields. The stacked
    // track is WIDER, not narrower: at 150px all three still fit across a 700px
    // panel and the platform gid crowded the review text beside it. 210px keeps
    // three across at the full 52rem panel and drops to two below ~800px.
    let planColumnMin = '180px';
    if (stacked) {
        planColumnMin = '210px';
    }

    const statsMarkup = (
        <div style={{ display: 'grid', gridTemplateColumns: statColumns, gap: 16 }}>
            <_StatTile
                label="Lifetime value"
                value={fmtMoney(summary.lifetime_value)}
                hint={summary.tx_count ? `${summary.tx_count} payment${summary.tx_count === 1 ? '' : 's'}` : 'No payments yet'}
            />
            <_StatTile label="Average spend" value={fmtMoney(summary.average_spend)} hint="Per settled payment" />
            <_StatTile
                label="MRR"
                value={fmtMoney(summary.mrr)}
                hint={sub.status === 'PAYING' ? 'Currently billing' : 'Not currently billing'}
            />
            {/* ⚠️ "Oldest record", NOT "store record created". There IS no store record in this
                build — the roster is folded on read — and `summary.first_seen` is the oldest dated
                fact from any collection (an event, a payout or a listing-analytics row), bounded
                below by what has been synced. "Created" would name a creation date this app has
                never held. */}
            <_StatTile label="First seen" value={fmtDate(summary.first_seen)} hint="Oldest record we hold" />
        </div>
    );

    const planMarkup = (
        <_PlanCard sub={sub} review={review} appName={data.app_name} columnMin={planColumnMin} />
    );
    const timelineMarkup = (
        <_TimelineCard groups={groupedTimeline} total={(data.timeline || []).length} />
    );

    if (stacked) {
        // Ordered by what a reader opens a drawer to check, most-asked first.
        // The timeline goes last because it is the only section with no bound on
        // its height — putting it higher would push everything else off-screen.
        return (
            <BlockStack gap="400">
                {statsMarkup}
                {planMarkup}
                <_CameFromCard acquisition={acquisition} />
                <_ActivityCard summary={summary} />
                <_LifecycleDatesCard sub={sub} />
                <_CustomerDetailsCard sub={sub} unavailable={data.unavailable} />
                {timelineMarkup}
            </BlockStack>
        );
    }

    return (
        <BlockStack gap="400">
            {statsMarkup}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: 16, alignItems: 'start' }}>
                <BlockStack gap="400">
                    <_ActivityCard summary={summary} />
                    <_CameFromCard acquisition={acquisition} />
                    <_CustomerDetailsCard sub={sub} unavailable={data.unavailable} />
                    <_LifecycleDatesCard sub={sub} />
                </BlockStack>
                <BlockStack gap="400">
                    {planMarkup}
                    {timelineMarkup}
                </BlockStack>
            </div>
        </BlockStack>
    );
};

export default StoreDetailContent;
