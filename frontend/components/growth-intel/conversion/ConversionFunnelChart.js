import { BlockStack, InlineStack, Text, Badge, Banner } from '@shopify/polaris';
import { cardShell } from '../cardShell';
import { useMemo } from 'react';

const _fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');
const _fmtPct = (n) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return `${(Number(n) * 100).toFixed(1)}%`;
};

const STAGE_COLORS = {
    ga4: '#5C6AC4',
    partner: '#47C1BF'
};

/**
 * 7-stage conversion funnel rendered as horizontal bars whose widths shrink
 * with the stage count. Pure CSS (no recharts) — gives us full control over
 * label placement and the GA4↔Partner colour seam.
 */
const ConversionFunnelChart = ({ data, bare = false }) => {
    const wrap = cardShell(bare);
    const stages = (data && Array.isArray(data.stages)) ? data.stages : [];
    const maxCount = useMemo(() => stages.reduce((m, s) => Math.max(m, s.count || 0), 0), [stages]);

    if (stages.length === 0) {
        return wrap(
                <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">End-to-end conversion funnel</Text>
                    <Text as="p" variant="bodySm" tone="subdued">No data for this window yet — run a partner sync to populate.</Text>
                </BlockStack>
        );
    }

    const drift = data.seam_diagnostics && typeof data.seam_diagnostics.drift_pct === 'number' ? data.seam_diagnostics.drift_pct : null;
    const driftIsConcerning = drift !== null && Math.abs(drift) > 0.25;

    return wrap(
            <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center" wrap>
                    <BlockStack gap="050">
                        <Text as="h3" variant="headingMd">End-to-end conversion funnel</Text>
                        <Text as="span" variant="bodySm" tone="subdued">{data.period_label}</Text>
                    </BlockStack>
                    <InlineStack gap="200" blockAlign="center">
                        <Badge tone="info">Install rate: {_fmtPct(data.overall_install_rate)}</Badge>
                        <Badge tone="success">Paid conversion: {_fmtPct(data.overall_paid_conversion_rate)}</Badge>
                    </InlineStack>
                </InlineStack>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {stages.map((s, idx) => {
                        const widthPct = maxCount > 0 ? Math.max((s.count / maxCount) * 100, 2) : 2;
                        const isSeamRow = idx === 4; // "Installed" — where GA4 hands off to Partner
                        return (
                            <div key={s.key}>
                                <InlineStack gap="200" blockAlign="center" wrap={false}>
                                    <div style={{ width: 170, flexShrink: 0 }}>
                                        <Text as="span" variant="bodySm" fontWeight="semibold">{s.label}</Text>
                                        <div>
                                            <Text as="span" variant="bodySm" tone="subdued">
                                                {s.source === 'ga4' ? 'GA4' : 'Partner API'}
                                            </Text>
                                        </div>
                                    </div>
                                    <div style={{ flex: 1, position: 'relative', height: 36 }}>
                                        <div
                                            style={{
                                                width: `${widthPct}%`,
                                                height: '100%',
                                                background: STAGE_COLORS[s.source],
                                                borderRadius: 4,
                                                opacity: 0.9,
                                                transition: 'width 200ms ease-out',
                                                display: 'flex',
                                                alignItems: 'center',
                                                paddingLeft: 10
                                            }}
                                        >
                                            <Text as="span" variant="bodyMd" fontWeight="semibold" tone="text-inverse">
                                                <span style={{ color: '#fff' }}>{_fmtNum(s.count)}</span>
                                            </Text>
                                        </div>
                                    </div>
                                    <div style={{ width: 150, flexShrink: 0, textAlign: 'right' }}>
                                        {idx > 0 ? (
                                            <Text as="span" variant="bodySm" tone={s.drop_pct > 0.5 ? 'critical' : 'subdued'}>
                                                {`${_fmtPct(s.conversion_pct)} step • ${_fmtPct(s.cumulative_conversion_pct)} of views`}
                                            </Text>
                                        ) : (
                                            <Text as="span" variant="bodySm" tone="subdued">Entry stage</Text>
                                        )}
                                    </div>
                                </InlineStack>
                                {isSeamRow ? (
                                    <div style={{ marginTop: 6, marginLeft: 170, paddingLeft: 10 }}>
                                        <Text as="span" variant="bodySm" tone="subdued">
                                            ↑ Visitor-level (GA4) — ↓ Shop-level (Partner). Drift: {drift !== null ? _fmtPct(drift) : 'n/a'}
                                            {data.seam_diagnostics ? ` • GA4 installs: ${_fmtNum(data.seam_diagnostics.ga4_installs)}` : ''}
                                        </Text>
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}
                </div>

                {driftIsConcerning ? (
                    <Banner tone="warning" title="Install count drift > 25%">
                        <p>
                            GA4 and Partner API disagree on install count by {_fmtPct(Math.abs(drift))}. This usually means: late events, a GA4 tagging gap, or the Partner sync hasn't run for the window. Trigger a sync and re-check.
                        </p>
                    </Banner>
                ) : null}
            </BlockStack>
    );
};

export default ConversionFunnelChart;
