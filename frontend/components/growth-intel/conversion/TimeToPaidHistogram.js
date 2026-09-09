import { BlockStack, InlineStack, Text } from '@shopify/polaris';
import { cardShell } from '../cardShell';
import { useMemo } from 'react';

const _fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');
const _fmtDays = (n) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    return `${n.toFixed(1)}d`;
};

/**
 * Time-to-paid histogram — bars sized by shop count per bucket. Plus a stats
 * strip below (mean / median / p25 / p75).
 */
const TimeToPaidHistogram = ({ data, bare = false }) => {
    const wrap = cardShell(bare);
    const buckets = (data && Array.isArray(data.buckets)) ? data.buckets : [];
    const stats = data && data.stats;
    const total = data && typeof data.total_paid_shops === 'number' ? data.total_paid_shops : 0;
    const maxCount = useMemo(() => buckets.reduce((m, b) => Math.max(m, b.count || 0), 0), [buckets]);

    if (total === 0) {
        return wrap(
                <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">Time to paid</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                        No shops converted to paid in this window yet.
                    </Text>
                </BlockStack>
        );
    }

    return wrap(
            <BlockStack gap="300">
                <BlockStack gap="050">
                    <Text as="h3" variant="headingMd">Time to paid</Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                        {`Days from install → first paid charge • ${_fmtNum(total)} shops${data.period_label ? ` • ${data.period_label.toLowerCase()}` : ''}`}
                    </Text>
                </BlockStack>

                <BlockStack gap="100">
                    {buckets.map((b) => {
                        const widthPct = maxCount > 0 ? Math.max((b.count / maxCount) * 100, 1) : 0;
                        const pctOfTotal = total > 0 ? (b.count / total) * 100 : 0;
                        return (
                            <InlineStack key={b.label} gap="200" blockAlign="center" wrap={false}>
                                <div style={{ width: 120, flexShrink: 0 }}>
                                    <Text as="span" variant="bodySm" fontWeight="semibold">{b.label}</Text>
                                </div>
                                <div style={{ flex: 1, position: 'relative', height: 24, background: '#f1f1f1', borderRadius: 3 }}>
                                    <div
                                        style={{
                                            width: `${widthPct}%`,
                                            height: '100%',
                                            background: '#5C6AC4',
                                            borderRadius: 3,
                                            transition: 'width 200ms ease-out'
                                        }}
                                    />
                                </div>
                                <div style={{ width: 110, flexShrink: 0, textAlign: 'right' }}>
                                    <Text as="span" variant="bodySm" tone="subdued">
                                        {`${_fmtNum(b.count)} (${pctOfTotal.toFixed(1)}%)`}
                                    </Text>
                                </div>
                            </InlineStack>
                        );
                    })}
                </BlockStack>

                {stats ? (
                    <div style={{ borderTop: '1px solid #e1e3e5', paddingTop: 12 }}>
                        <InlineStack gap="400" wrap>
                            <BlockStack gap="050">
                                <Text as="span" variant="bodySm" tone="subdued">Median</Text>
                                <Text as="span" variant="headingMd">{_fmtDays(stats.median_days)}</Text>
                            </BlockStack>
                            <BlockStack gap="050">
                                <Text as="span" variant="bodySm" tone="subdued">Mean</Text>
                                <Text as="span" variant="headingMd">{_fmtDays(stats.mean_days)}</Text>
                            </BlockStack>
                            <BlockStack gap="050">
                                <Text as="span" variant="bodySm" tone="subdued">P25</Text>
                                <Text as="span" variant="headingMd">{_fmtDays(stats.p25_days)}</Text>
                            </BlockStack>
                            <BlockStack gap="050">
                                <Text as="span" variant="bodySm" tone="subdued">P75</Text>
                                <Text as="span" variant="headingMd">{_fmtDays(stats.p75_days)}</Text>
                            </BlockStack>
                            <BlockStack gap="050">
                                <Text as="span" variant="bodySm" tone="subdued">Range</Text>
                                <Text as="span" variant="headingMd">{`${_fmtDays(stats.min_days)} – ${_fmtDays(stats.max_days)}`}</Text>
                            </BlockStack>
                        </InlineStack>
                    </div>
                ) : null}
            </BlockStack>
    );
};

export default TimeToPaidHistogram;
