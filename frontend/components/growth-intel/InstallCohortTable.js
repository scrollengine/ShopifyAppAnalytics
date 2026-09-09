import { BlockStack, InlineStack, Text, Banner, Select, Button, Divider, Box } from '@shopify/polaris';
import { cardShell } from './cardShell';
import { useCallback, useMemo, useState } from 'react';
import StoreTable from './store/StoreTable';
import { fmtNum, fmtPct } from './store/storePresentation';

/**
 * Who installed in the window, how they arrived, and where they got to.
 *
 * The five lifecycle states, including the one no subscription query can produce: a store that
 * installed and never subscribed simply has no subscription to classify, so it shows as
 * "Installed only" rather than being absent from the list.
 *
 * A row with no GA4 attribution renders "Not attributed" — deliberately NOT "Direct". Direct is
 * already the largest bucket, so a store we cannot explain would disappear into it.
 */

// Ordered so the row reads as a journey rather than alphabetically.
const STATE_ORDER = ['INSTALLED', 'ON_TRIAL', 'CONVERTED', 'CHURNED_IN_TRIAL', 'CHURNED'];

// This table's slice of the shared column registry. Same keys, same renderers, same order as the
// Subscriptions list where the columns overlap.
const COHORT_COLUMNS = ['store', 'came_from', 'status', 'installed_at', 'plan', 'trial_end'];

const InstallCohortTable = ({ data, loading, onFilterChange, appId, bare = false }) => {
    const wrap = cardShell(bare);
    const [expanded, setExpanded] = useState(false);

    const items = useMemo(() => {
        if (data && Array.isArray(data.items)) return data.items;
        return [];
    }, [data]);

    const summary = (data && data.summary) || {};
    const stateLabels = (data && data.states) || {};
    const channelLabels = (data && data.channels) || {};
    const byState = summary.by_state || {};
    const byChannel = summary.by_channel || {};

    const handleFilter = useCallback((key, value) => {
        if (typeof onFilterChange === 'function') {
            onFilterChange(key, value);
        }
    }, [onFilterChange]);

    const stateOptions = useMemo(() => {
        const opts = [{ label: 'All states', value: '' }];
        for (const key of STATE_ORDER) {
            if (!stateLabels[key]) continue;
            opts.push({ label: `${stateLabels[key]} (${fmtNum(byState[key] || 0)})`, value: key });
        }
        return opts;
    }, [stateLabels, byState]);

    const channelOptions = useMemo(() => {
        const opts = [{ label: 'All channels', value: '' }];
        for (const key of Object.keys(channelLabels)) {
            const count = byChannel[key] || 0;
            if (count === 0) continue;
            opts.push({ label: `${channelLabels[key]} (${fmtNum(count)})`, value: key });
        }
        return opts;
    }, [channelLabels, byChannel]);

    const visible = useMemo(() => {
        if (expanded) return items;
        return items.slice(0, 10);
    }, [items, expanded]);

    if (!loading && items.length === 0) {
        return wrap(
                <BlockStack gap="300">
                    <Text as="h3" variant="headingMd">Stores installed in this window</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                        No installs recorded for this window. Install events come from the Partner API — run a
                        Partner sync if you expect some.
                    </Text>
                </BlockStack>
        );
    }

    const coverage = summary.attribution_coverage;

    return wrap(
            <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="start" wrap>
                    <BlockStack gap="050">
                        <Text as="h3" variant="headingMd">Stores installed in this window</Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                            {`${fmtNum(summary.installs)} installs · where they came from and where they got to`}
                        </Text>
                    </BlockStack>
                    <InlineStack gap="200" wrap={false}>
                        <div style={{ minWidth: 190 }}>
                            <Select
                                label="State"
                                labelHidden
                                options={stateOptions}
                                value={(data && data.filter_state) || ''}
                                onChange={(v) => handleFilter('state', v)}
                            />
                        </div>
                        <div style={{ minWidth: 190 }}>
                            <Select
                                label="Channel"
                                labelHidden
                                options={channelOptions}
                                value={(data && data.filter_channel) || ''}
                                onChange={(v) => handleFilter('channel', v)}
                            />
                        </div>
                    </InlineStack>
                </InlineStack>

                {/* State counts read as the journey, left to right. */}
                <InlineStack gap="200" wrap>
                    {STATE_ORDER.filter((k) => stateLabels[k]).map((key) => (
                        <Box
                            key={key}
                            padding="300"
                            background="bg-surface-secondary"
                            borderRadius="200"
                            minWidth="130px"
                        >
                            <BlockStack gap="050">
                                <Text as="span" variant="bodyXs" tone="subdued">{stateLabels[key]}</Text>
                                <Text as="p" variant="headingLg">{fmtNum(byState[key] || 0)}</Text>
                            </BlockStack>
                        </Box>
                    ))}
                </InlineStack>

                {typeof coverage === 'number' && coverage < 1 ? (
                    <Banner tone="info">
                        <p>
                            Attribution is available for {fmtNum(summary.with_attribution)} of{' '}
                            {fmtNum(summary.installs)} installs ({fmtPct(coverage)}). The rest show as{' '}
                            <strong>Not attributed</strong> — that means we have no listing-analytics record for
                            them, not that they arrived directly. Listing analytics only covers the period the
                            BigQuery export reaches, and a merchant&apos;s browser can block it entirely.
                        </p>
                    </Banner>
                ) : null}

                <Divider />

                {/* Same component the Subscriptions list renders, so a store reads identically
                    in both places — same identity cell, same badge tones, same date format. This
                    was a hand-rolled <table> with its own tone maps, and ON_TRIAL had drifted to a
                    different colour than the one Subscriptions used for the same state. */}
                <StoreTable
                    rows={visible}
                    columns={COHORT_COLUMNS}
                    appId={appId}
                    loading={loading}
                    emptyHeading="No installs match"
                    emptyBody={<p>Try a different state or channel filter.</p>}
                />

                {items.length > 10 ? (
                    <InlineStack align="center">
                        <Button variant="tertiary" onClick={() => setExpanded((v) => !v)}>
                            {expanded ? 'Show fewer' : `Show all ${fmtNum(items.length)}`}
                        </Button>
                    </InlineStack>
                ) : null}

                {Array.isArray(data && data.warnings) && data.warnings.length > 0 ? (
                    <Banner tone="warning">
                        <BlockStack gap="100">
                            {data.warnings.map((w) => (<p key={w}>{w}</p>))}
                        </BlockStack>
                    </Banner>
                ) : null}
            </BlockStack>
    );
};

export default InstallCohortTable;
