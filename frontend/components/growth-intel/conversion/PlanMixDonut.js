import { BlockStack, InlineStack, InlineGrid, Text, IndexTable, Badge, Banner, Divider } from '@shopify/polaris';
import AttributionPieChart from '../AttributionPieChart';
import { cardShell } from '../cardShell';

const _fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');
const _fmtPct = (n) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return `${(Number(n) * 100).toFixed(1)}%`;
};
const _fmtMoney = (amount, currency) => {
    if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '—';
    const v = Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return currency ? `${v} ${currency}` : v;
};

// One chart per metric rather than one chart with a toggle. Subscriber share and MRR share are
// different distributions of the same plans, and the gap between them IS the insight — a plan with
// many subscribers and little MRR is a different business than the reverse. Behind a toggle that
// comparison meant clicking back and forth holding a number in your head.
// The `key` must match the field on a /conversion/plan-mix row; a typo renders an empty donut.
const PLAN_METRICS = [
    { key: 'active_now', label: 'Subscribers', title: 'Subscribers by plan', subtitle: 'Who is on what' },
    { key: 'mrr_amount', label: 'MRR', title: 'MRR by plan', subtitle: 'Where the revenue comes from' }
];

/**
 * Plan mix: subscriber share and MRR share as two donuts, over a per-plan churn table.
 *
 * The table used to sit BESIDE the donut in a 1:2 flex split, which gave the chart barely a third of
 * the width and the table six columns squeezed into the rest — and the plan list runs to dozens of
 * rows, so it set the height of the whole row while the donut left most of its column empty. Charts
 * across the top, table full width beneath: each gets the dimension it actually needs.
 *
 * If many shops have no charge payload (older syncs), a warning banner asks the user to run the
 * Partner API lifetime re-sync (Sync page) to backfill plan names.
 */
const PlanMixDonut = ({ data, bare = false }) => {
    // `padding="0"`: the IndexTable below is full-bleed and each section pads itself.
    const wrap = cardShell(bare, { cardPadding: '0', padWhenBare: false });
    const plans = (data && Array.isArray(data.plans)) ? data.plans : [];
    const totalActive = data && typeof data.total_active_now === 'number' ? data.total_active_now : 0;
    const totalMrr = data && typeof data.total_mrr_amount === 'number' ? data.total_mrr_amount : 0;
    const missingPayload = data && data.payload_health ? data.payload_health.plans_without_charge_payload : 0;

    if (totalActive === 0) {
        return wrap(
            <div style={{ padding: 'var(--p-space-400)' }}>
                <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">Plan mix</Text>
                    <Text as="p" variant="bodySm" tone="subdued">No active paid subscribers found yet.</Text>
                </BlockStack>
            </div>
        );
    }

    const currency = plans[0] && plans[0].currency;
    // Each donut carries its OWN total rather than both totals on one subtitle — the number under a
    // chart should be the number that chart is a breakdown of.
    const METRIC_TOTALS = {
        active_now: `${_fmtNum(totalActive)} active subscribers`,
        mrr_amount: `${_fmtMoney(totalMrr, currency)} total MRR`
    };

    // ⚠️ MONEY IS FORMATTED AS MONEY IN THE DONUT TOO. Without a formatter the pie falls back to a
    // plain `toLocaleString`, so an MRR slice read "1,240" beside a table cell reading "1,240.00 USD"
    // — two renderings of one figure on one screen, one of which does not say what it is a quantity
    // of. `formatValue` is per-chart, and there is one chart per metric here, so each gets its own.
    const METRIC_FORMATTERS = {
        active_now: _fmtNum,
        mrr_amount: (value) => _fmtMoney(value, currency)
    };

    return wrap(
        <>
            {missingPayload > 0 ? (
                <div style={{ padding: 'var(--p-space-400)' }}>
                    <Banner tone="info" title={`${_fmtNum(missingPayload)} subscribers grouped under "(plan unknown)"`}>
                        <p>
                            Their plan names + amounts were not captured at sync time. Run the Partner API <strong>Full re-sync (lifetime)</strong> from <strong>Sync</strong> in the side nav to backfill plan names.
                        </p>
                    </Banner>
                </div>
            ) : null}

            {/* `gap="0"` plus a left border on the second cell: whitespace between charts reads as
                "separate things", a hairline reads as "one thing, divided". The border is dropped at
                the breakpoint where the grid collapses to one column, or it would appear as a stray
                line down the left edge of the stacked chart. */}
            <InlineGrid columns={{ xs: 1, sm: 1, md: 2 }} gap="0">
                {PLAN_METRICS.map((m, i) => (
                    <div
                        key={m.key}
                        style={i === 0 ? undefined : { borderLeft: '1px solid var(--p-color-border-secondary)' }}
                    >
                        <AttributionPieChart
                            items={plans}
                            labelKey="plan_name"
                            title={m.title}
                            subtitle={`${m.subtitle} • ${METRIC_TOTALS[m.key]}`}
                            topN={8}
                            metrics={[m]}
                            formatValue={METRIC_FORMATTERS[m.key]}
                            bare
                        />
                    </div>
                ))}
            </InlineGrid>

            <Divider />

            <div style={{ padding: '12px 16px' }}>
                <Text as="h3" variant="headingMd">Per-plan churn (last 30 days)</Text>
            </div>
            <IndexTable
                resourceName={{ singular: 'plan', plural: 'plans' }}
                itemCount={plans.length}
                headings={[
                    { title: 'Plan' },
                    { title: 'Active now', alignment: 'end' },
                    { title: 'Avg price', alignment: 'end' },
                    { title: 'MRR', alignment: 'end' },
                    { title: 'Churned 30d', alignment: 'end' },
                    { title: 'Churn rate', alignment: 'end' }
                ]}
                selectable={false}
            >
                {plans.map((p, i) => (
                    <IndexTable.Row id={String(i)} key={p.plan_name + i} position={i}>
                        <IndexTable.Cell>
                            <InlineStack gap="100" blockAlign="center">
                                <Text as="span" variant="bodyMd" fontWeight="semibold">{p.plan_name}</Text>
                                {p.plan_name === '(plan unknown)' ? <Badge tone="attention">Re-sync to enrich</Badge> : null}
                            </InlineStack>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                            <Text as="span" alignment="end" numeric>{_fmtNum(p.active_now)}</Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                            <Text as="span" alignment="end" numeric>{_fmtMoney(p.avg_amount, p.currency)}</Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                            <Text as="span" alignment="end" numeric>{_fmtMoney(p.mrr_amount, p.currency)}</Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                            <Text as="span" alignment="end" numeric>{_fmtNum(p.churned_in_30d)}</Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                            <Text as="span" alignment="end" numeric tone={p.churn_30d_pct > 0.1 ? 'critical' : 'subdued'}>
                                {_fmtPct(p.churn_30d_pct)}
                            </Text>
                        </IndexTable.Cell>
                    </IndexTable.Row>
                ))}
            </IndexTable>
        </>
    );
};

export default PlanMixDonut;
