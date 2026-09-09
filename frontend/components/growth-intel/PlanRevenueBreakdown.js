import { BlockStack, InlineGrid, Text, IndexTable, Divider } from '@shopify/polaris';
import AttributionPieChart from './AttributionPieChart';
import { cardShell } from './cardShell';

const _fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');
const _fmtMoney = (n) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// One chart per metric rather than one chart with a toggle. Revenue share and subscriber share are
// different distributions of the same plans, and the gap between them IS the insight — the plan with
// 45% of MRR here has ONE subscriber, which a toggle hides behind a click. MRR first (left) because
// this is the Revenue page; the plan-mix breakdown on the funnel page leads with subscribers.
// The `key` must match a field on a /conversion/revenue-overview plan row — a typo renders an empty
// donut, not an error.
// ⚠️ `formatValue` PER METRIC. `AttributionPieChart` defaults to a plain count formatter, so without
// it the MRR donut labelled its slices `1,234` where the table one inch below said `1,234.00` for the
// same figure — two renderings of one number, on one card. `CountryMixCharts` already passes a money
// formatter for the same class of figure; this one did not. `undefined` on the subscriber metric is
// deliberate and means "take the default", which IS the count formatter.
const PLAN_METRICS = [
    { key: 'mrr_amount', label: 'MRR', title: 'MRR by plan', subtitle: 'Where the revenue comes from', formatValue: _fmtMoney },
    { key: 'active_subs', label: 'Subscribers', title: 'Subscribers by plan', subtitle: 'Who is on what', formatValue: undefined }
];

/**
 * Per-plan revenue: MRR share and subscriber share as two donuts, over the ARPU table.
 *
 * Extracted from the Revenue page, where it was ~60 lines of inline JSX in a 1:2 flex split — the
 * donut squeezed into a third of the width while the table's five columns took the rest, and the plan
 * list runs to dozens of rows so it set the height of the whole row and left most of the donut's
 * column empty. Charts across the top, table full width beneath: each gets the dimension it needs.
 *
 * Sibling of `conversion/PlanMixDonut`, deliberately NOT the same component — that one reads a
 * plan-mix payload (`active_now` / `avg_amount` / churn columns) and this one a revenue-overview
 * payload (`active_subs` / `arpu` / % of MRR). Sharing them would mean a field-mapping layer for two
 * callers, which is more indirection than the duplicated table markup costs.
 *
 * @param {Object}  props
 * @param {Array}   props.plans        - plan rows: { plan_name, active_subs, arpu, mrr_amount }.
 * @param {Number}  props.totalMrr     - current MRR, the denominator for "% of MRR".
 * @param {Number}  props.totalSubs
 * @param {String}  [props.asOfLabel]  - the instant these figures were measured, repeated INSIDE the
 *   card so a screenshot of it is self-describing. Every number here is a snapshot — MRR share and
 *   subscriber share as of one moment — and the page's date control is outside the crop. Optional:
 *   absent, the card renders exactly as it did before.
 * @param {Boolean} [props.bare]       - render without the surrounding Card, for a clubbed parent card.
 */
const PlanRevenueBreakdown = ({ plans, totalMrr, totalSubs, asOfLabel = '', bare = false }) => {
    // `padding="0"`: the IndexTable is full-bleed and each section pads itself.
    const wrap = cardShell(bare, { cardPadding: '0', padWhenBare: false });
    const rows = Array.isArray(plans) ? plans : [];

    if (rows.length === 0) {
        return wrap(
            <div style={{ padding: 'var(--p-space-400)' }}>
                <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">MRR by plan</Text>
                    <Text as="p" variant="bodySm" tone="subdued">No active paid subscribers yet.</Text>
                </BlockStack>
            </div>
        );
    }

    // Each donut carries its OWN total rather than both totals on one subtitle — the number under a
    // chart should be the number that chart is a breakdown of.
    const METRIC_TOTALS = {
        mrr_amount: `${_fmtMoney(totalMrr)} total MRR`,
        active_subs: `${_fmtNum(totalSubs)} active subscribers`
    };

    // Appended to both donut subtitles and folded into the "% of MRR" heading, so the date travels
    // with the numbers whichever part of the card gets cropped out.
    let asOfSuffix = '';
    let mrrShareHeading = '% of MRR';
    if (asOfLabel) {
        asOfSuffix = ` • as of ${asOfLabel}`;
        mrrShareHeading = `% of MRR (as of ${asOfLabel})`;
    }

    return wrap(
        <>
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
                            items={rows}
                            labelKey="plan_name"
                            title={m.title}
                            subtitle={`${m.subtitle} • ${METRIC_TOTALS[m.key]}${asOfSuffix}`}
                            topN={8}
                            metrics={[m]}
                            formatValue={m.formatValue}
                            bare
                        />
                    </div>
                ))}
            </InlineGrid>

            <Divider />

            <div style={{ padding: '12px 16px' }}>
                <Text as="h3" variant="headingMd">Per-plan ARPU + subscribers</Text>
            </div>
            <IndexTable
                resourceName={{ singular: 'plan', plural: 'plans' }}
                itemCount={rows.length}
                headings={[
                    { title: 'Plan' },
                    { title: 'Active subs', alignment: 'end' },
                    { title: 'ARPU', alignment: 'end' },
                    { title: 'MRR contribution', alignment: 'end' },
                    { title: mrrShareHeading, alignment: 'end' }
                ]}
                selectable={false}
            >
                {rows.map((p, i) => {
                    let share = '—';
                    if (totalMrr > 0) {
                        share = `${((p.mrr_amount / totalMrr) * 100).toFixed(1)}%`;
                    }
                    return (
                        <IndexTable.Row id={String(i)} key={p.plan_name + i} position={i}>
                            <IndexTable.Cell>
                                <Text as="span" fontWeight="semibold">{p.plan_name}</Text>
                            </IndexTable.Cell>
                            <IndexTable.Cell>
                                <Text as="span" alignment="end" numeric>{_fmtNum(p.active_subs)}</Text>
                            </IndexTable.Cell>
                            <IndexTable.Cell>
                                <Text as="span" alignment="end" numeric>{_fmtMoney(p.arpu)}</Text>
                            </IndexTable.Cell>
                            <IndexTable.Cell>
                                <Text as="span" alignment="end" numeric>{_fmtMoney(p.mrr_amount)}</Text>
                            </IndexTable.Cell>
                            <IndexTable.Cell>
                                <Text as="span" alignment="end" numeric>{share}</Text>
                            </IndexTable.Cell>
                        </IndexTable.Row>
                    );
                })}
            </IndexTable>
        </>
    );
};

export default PlanRevenueBreakdown;
