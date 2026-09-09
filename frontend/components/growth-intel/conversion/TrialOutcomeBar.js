import { BlockStack, InlineStack, Text, Tooltip, Button } from '@shopify/polaris';
import { cardShell } from '../cardShell';
import { useMemo, useState } from 'react';

const _fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');
const _fmtPct = (n) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return `${(Number(n) * 100).toFixed(1)}%`;
};

const STATE_STYLE = {
    // Current backend states (services/.../shared/subscriptionState.js).
    PAYING:                { color: '#50B83C', label: 'Paying',               legendOrder: 0 },
    ON_TRIAL:              { color: '#FAD157', label: 'On trial',             legendOrder: 1 },
    CHURNED_DURING_TRIAL:  { color: '#E3A008', label: 'Churned during trial', legendOrder: 2 },
    CHURNED_AFTER_TRIAL:   { color: '#BF0711', label: 'Churned after trial',  legendOrder: 3 },
    // Legacy keys, kept so an older cached response still renders in colour.
    STAYED_ON_FREE:        { color: '#919EAB', label: 'Stayed on free',    legendOrder: 6 },
    IN_TRIAL:              { color: '#FAD157', label: 'In trial',          legendOrder: 1 },
    CONVERTED_TO_PAID:     { color: '#50B83C', label: 'Converted to paid', legendOrder: 0 },
    CANCELLED_BY_USER:     { color: '#DE3618', label: 'Cancelled by user', legendOrder: 2 },
    UNINSTALLED_IN_TRIAL:  { color: '#BF0711', label: 'Uninstalled in trial', legendOrder: 3 },
    PAYMENT_FAILED:        { color: '#F49342', label: 'Payment failed',    legendOrder: 4 },
    CHURNED_AFTER_PAID:    { color: '#9C6ADE', label: 'Churned after paid', legendOrder: 5 }
};

const ROLLED_UP_CANCEL_STATE = '__CANCELLED_ALL__';

/**
 * Stacked horizontal bar for trial outcomes. Optionally rolls the three
 * cancellation sub-states into one combined "Cancelled (all)" bar so the eye
 * isn't fragmented; the toggle expands them back out.
 */
const TrialOutcomeBar = ({ data, bare = false }) => {
    const wrap = cardShell(bare);
    const [rolledUp, setRolledUp] = useState(false);

    const breakdown = (data && Array.isArray(data.breakdown)) ? data.breakdown : [];
    const total = data && typeof data.total_shops_in_cohort === 'number' ? data.total_shops_in_cohort : 0;

    const segments = useMemo(() => {
        if (!rolledUp) return breakdown.filter((b) => b.count > 0);
        // Combine the three cancellation states into one segment.
        // Trial-side losses only. Post-trial churn is real revenue loss and is
        // deliberately NOT rolled in with it.
        const cancelStates = ['CHURNED_DURING_TRIAL', 'CANCELLED_BY_USER', 'UNINSTALLED_IN_TRIAL', 'PAYMENT_FAILED'];
        const cancelCount = breakdown.filter((b) => cancelStates.includes(b.state)).reduce((s, b) => s + b.count, 0);
        const others = breakdown.filter((b) => !cancelStates.includes(b.state) && b.count > 0);
        if (cancelCount > 0) {
            others.push({
                state: ROLLED_UP_CANCEL_STATE,
                label: 'Cancelled (all)',
                count: cancelCount,
                pct: total > 0 ? cancelCount / total : 0
            });
        }
        return others.sort((a, b) => b.count - a.count);
    }, [breakdown, rolledUp, total]);

    if (total === 0) {
        return wrap(
                <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">Trial outcomes</Text>
                    <Text as="p" variant="bodySm" tone="subdued">No installs in this window yet.</Text>
                </BlockStack>
        );
    }

    return wrap(
            <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" wrap>
                    <BlockStack gap="050">
                        <Text as="h3" variant="headingMd">Trial outcomes</Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                            {`${_fmtNum(total)} shops installed${data.period_label ? ` in ${data.period_label.toLowerCase()}` : ''} • Trial → Paid rate: ${_fmtPct(data.trial_to_paid_rate)}`}
                        </Text>
                    </BlockStack>
                    <Button size="slim" pressed={rolledUp} onClick={() => setRolledUp((v) => !v)}>
                        {rolledUp ? 'Show all 3 cancel buckets' : 'Combine cancellations'}
                    </Button>
                </InlineStack>

                <div style={{ display: 'flex', width: '100%', height: 32, borderRadius: 6, overflow: 'hidden', background: '#f1f1f1' }}>
                    {segments.map((seg) => {
                        const style = STATE_STYLE[seg.state] || { color: '#637381', label: seg.label || seg.state };
                        const widthPct = total > 0 ? (seg.count / total) * 100 : 0;
                        return (
                            <Tooltip key={seg.state} content={`${style.label || seg.label}: ${_fmtNum(seg.count)} (${_fmtPct(seg.pct)})`}>
                                <div style={{ width: `${widthPct}%`, height: '100%', background: style.color || '#637381' }} />
                            </Tooltip>
                        );
                    })}
                </div>

                <InlineStack gap="300" wrap>
                    {segments.map((seg) => {
                        const style = STATE_STYLE[seg.state] || { color: '#637381', label: seg.label || seg.state };
                        return (
                            <InlineStack key={seg.state} gap="100" blockAlign="center">
                                <div style={{ width: 10, height: 10, borderRadius: 2, background: style.color || '#637381' }} />
                                <Text as="span" variant="bodySm">
                                    {`${style.label || seg.label} — ${_fmtNum(seg.count)} (${_fmtPct(seg.pct)})`}
                                </Text>
                            </InlineStack>
                        );
                    })}
                </InlineStack>
            </BlockStack>
    );
};

export default TrialOutcomeBar;
