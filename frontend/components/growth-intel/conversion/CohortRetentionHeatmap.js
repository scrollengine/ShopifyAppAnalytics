import { BlockStack, Text } from '@shopify/polaris';
import { cardShell } from '../cardShell';

const _fmtPct = (n) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return `${(Number(n) * 100).toFixed(0)}%`;
};
const _fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');

const _retentionColor = (pct) => {
    if (pct === null || pct === undefined) return '#f1f1f1';
    // Green at 100%, yellow at ~50%, red at 0%.
    const clamped = Math.max(0, Math.min(1, pct));
    if (clamped >= 0.7) return `rgba(31, 157, 85, ${0.3 + clamped * 0.7})`;
    if (clamped >= 0.4) return `rgba(138, 109, 0, ${0.3 + clamped * 0.7})`;
    return `rgba(191, 7, 17, ${0.3 + (1 - clamped) * 0.6})`;
};

const _fmtCohortDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

/**
 * Cohort retention heatmap. Rows = weekly install cohorts (oldest first).
 * Columns = retention checkpoints (+1d, +7d, +30d, +60d, +90d). Cells are
 * colour-graded green→yellow→red by retention rate. `null` checkpoints (the
 * cohort hasn't aged enough yet) render as muted "—".
 */
const CohortRetentionHeatmap = ({ data, bare = false }) => {
    const wrap = cardShell(bare);
    const cohorts = (data && Array.isArray(data.cohorts)) ? data.cohorts : [];
    const checkpoints = (data && Array.isArray(data.checkpoints_days)) ? data.checkpoints_days : [1, 7, 30, 60, 90];

    if (cohorts.length === 0) {
        return wrap(
                <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">Cohort retention</Text>
                    <Text as="p" variant="bodySm" tone="subdued">No install cohorts in this window yet.</Text>
                </BlockStack>
        );
    }

    return wrap(
            <BlockStack gap="300">
                <BlockStack gap="050">
                    <Text as="h3" variant="headingMd">Cohort retention</Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                        Weekly install cohorts • % still installed at each checkpoint
                    </Text>
                </BlockStack>

                <div style={{ overflowX: 'auto' }}>
                    <div style={{ display: 'inline-grid', gridTemplateColumns: `160px 90px repeat(${checkpoints.length}, 90px)`, gap: 4 }}>
                        {/* Header row */}
                        <div style={{ padding: '6px 8px' }}>
                            <Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">Cohort week</Text>
                        </div>
                        <div style={{ padding: '6px 8px', textAlign: 'right' }}>
                            <Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">Installs</Text>
                        </div>
                        {checkpoints.map((d) => (
                            <div key={d} style={{ padding: '6px 8px', textAlign: 'center' }}>
                                <Text as="span" variant="bodySm" fontWeight="semibold" tone="subdued">+{d}d</Text>
                            </div>
                        ))}

                        {/* Body */}
                        {cohorts.map((row) => (
                            <div key={row.cohort_week} style={{ display: 'contents' }}>
                                <div style={{ padding: '8px', background: '#fafbfb', borderRadius: 4 }}>
                                    <Text as="span" variant="bodySm">{_fmtCohortDate(row.cohort_week)}</Text>
                                </div>
                                <div style={{ padding: '8px', background: '#fafbfb', borderRadius: 4, textAlign: 'right' }}>
                                    <Text as="span" variant="bodySm" fontWeight="semibold">{_fmtNum(row.installs)}</Text>
                                </div>
                                {checkpoints.map((d) => {
                                    const cp = row.checkpoints && row.checkpoints[`day_${d}`];
                                    const pct = cp ? cp.pct : null;
                                    const bg = _retentionColor(pct);
                                    return (
                                        <div
                                            key={d}
                                            title={cp ? `${_fmtNum(cp.retained)}/${_fmtNum(cp.eligible)} retained` : 'Cohort not aged enough'}
                                            style={{
                                                padding: '8px',
                                                background: bg,
                                                borderRadius: 4,
                                                textAlign: 'center',
                                                color: pct !== null && pct < 0.4 ? '#fff' : '#111',
                                                fontWeight: 600
                                            }}
                                        >
                                            <Text as="span" variant="bodySm" fontWeight="semibold">{_fmtPct(pct)}</Text>
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                </div>

                <Text as="span" variant="bodySm" tone="subdued">
                    Each row = a weekly install cohort. Checkpoints marked "—" mean the cohort hasn't aged enough yet.
                </Text>
            </BlockStack>
    );
};

export default CohortRetentionHeatmap;
