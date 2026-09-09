import { BlockStack, InlineStack, Text, ButtonGroup, Button } from '@shopify/polaris';
import { cardShell } from './cardShell';
import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';

const ResponsiveContainer = dynamic(() => import('recharts').then((m) => m.ResponsiveContainer), { ssr: false });
const PieChart = dynamic(() => import('recharts').then((m) => m.PieChart), { ssr: false });
const Pie = dynamic(() => import('recharts').then((m) => m.Pie), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then((m) => m.Tooltip), { ssr: false });

// Side length of the donut's own box. The legend is OUR markup in a sibling column, so this box is
// never squeezed by label length and every panel draws an identically sized donut.
const CHART_BOX_PX = 260;

/**
 * Pluggable pie/donut chart for attribution-style breakdowns (traffic source,
 * country, etc). Buckets the long tail into "Other (N)" so we don't render a
 * 50-slice pie. Includes a metric toggle when `metrics` has more than one
 * entry — flips the chart between e.g. installs and views without refetching.
 */

const PALETTE = [
    '#5C6AC4', // indigo
    '#47C1BF', // teal
    '#F49342', // orange
    '#9C6ADE', // purple
    '#50B83C', // green
    '#FAD157', // yellow
    '#DE3618', // red
    '#006FBB', // azure
    '#BF0711', // crimson
    '#919EAB'  // gray (Other)
];

const _fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');

const AttributionPieChart = ({
    items,
    labelKey,
    metrics,           // [{ key: 'installs', label: 'Installs' }, { key: 'views', label: 'Views' }]
    title,
    subtitle,
    topN = 8,
    emptyMsg,
    // How a slice value renders in the legend, tooltip and total. Defaults to a plain localised
    // number; a money metric passes a currency formatter. Optional so every existing caller keeps
    // its exact output.
    formatValue,
    // Render without the surrounding <Card> so several charts can be clubbed into ONE card by the
    // caller. Opt-in, because the revenue page still relies on this component owning its own card.
    bare = false
}) => {
    const _format = typeof formatValue === 'function' ? formatValue : _fmtNum;

    const _metrics = Array.isArray(metrics) && metrics.length > 0
        ? metrics
        : [{ key: 'installs', label: 'Installs' }];
    const [activeMetricKey, setActiveMetricKey] = useState(_metrics[0].key);
    const activeMetric = _metrics.find((m) => m.key === activeMetricKey) || _metrics[0];

    const chartData = useMemo(() => {
        if (!Array.isArray(items) || items.length === 0) return [];
        // Aggregate by label so rows with the same label (e.g. google/organic +
        // google/cpc) collapse into a single slice.
        const groups = new Map();
        for (const it of items) {
            const rawLabel = it[labelKey];
            const k = String(rawLabel != null && rawLabel !== '' ? rawLabel : '(unknown)');
            const v = Number(it[activeMetric.key] || 0);
            if (v <= 0) continue;
            groups.set(k, (groups.get(k) || 0) + v);
        }
        const sorted = [...groups.entries()].sort((a, b) => b[1] - a[1]);
        if (sorted.length === 0) return [];

        // If only one item would land in Other, just keep it as its own slice
        // — "Other (1)" is uglier than just showing the value.
        const _effectiveN = sorted.length === topN + 1 ? topN + 1 : topN;
        const top = sorted.slice(0, _effectiveN);
        const rest = sorted.slice(_effectiveN);
        // Recharts v3 reliably picks fill from each datum when there are no
        // Cell children — that's why we set `fill` here directly. (Mapping
        // <Cell> as children through next/dynamic loses type identity and
        // recharts falls back to its default gray palette.)
        const data = top.map(([name, value], i) => {
            const fill = PALETTE[i] || PALETTE[PALETTE.length - 1];
            return { name, value, fill };
        });
        const otherTotal = rest.reduce((sum, [, v]) => sum + v, 0);
        if (otherTotal > 0) {
            data.push({
                name: `Other (${rest.length})`,
                value: otherTotal,
                fill: PALETTE[PALETTE.length - 1]
            });
        }
        return data;
    }, [items, labelKey, activeMetric.key, topN]);

    const total = useMemo(() => chartData.reduce((s, d) => s + d.value, 0), [chartData]);

    // A gap between slices is only legible while it is smaller than the slices it separates. These
    // breakdowns are routinely ~92% in one source, which leaves the rest under a degree each — at a
    // flat 1.5° the sub-1% slices were mostly gap, rendering as hairlines. Scale the gap to the
    // SMALLEST slice so it can never exceed a third of it.
    const padAngle = useMemo(() => {
        if (chartData.length < 2 || total <= 0) return 0;
        const smallestShare = Math.min(...chartData.map((d) => d.value)) / total;
        return Math.max(0, Math.min(1.5, (smallestShare * 360) / 3));
    }, [chartData, total]);

    const renderHeader = () => (
        <InlineStack align="space-between" blockAlign="center" wrap>
            <BlockStack gap="050">
                {title ? <Text as="h3" variant="headingMd">{title}</Text> : null}
                {subtitle ? <Text as="span" variant="bodySm" tone="subdued">{subtitle}</Text> : null}
            </BlockStack>
            {_metrics.length > 1 ? (
                <ButtonGroup variant="segmented">
                    {_metrics.map((m) => (
                        <Button
                            key={m.key}
                            size="slim"
                            pressed={activeMetricKey === m.key}
                            onClick={() => setActiveMetricKey(m.key)}
                        >
                            {m.label}
                        </Button>
                    ))}
                </ButtonGroup>
            ) : null}
        </InlineStack>
    );

    // One wrapper for both return paths — a bare/carded divergence between the empty state and the
    // chart is the kind of thing that only shows up on a day with no data.
    const wrap = cardShell(bare);

    if (chartData.length === 0) {
        return wrap(
            <BlockStack gap="200">
                {renderHeader()}
                <Text as="p" variant="bodySm" tone="subdued">
                    {emptyMsg || `No ${activeMetric.label.toLowerCase()} in this period.`}
                </Text>
            </BlockStack>
        );
    }

    return wrap(
        <BlockStack gap="300">
                {renderHeader()}
                {/* Donut and legend are SIBLING columns, not a chart with a built-in legend.
                    WHY: recharts resolves a Pie's cx against `offset` — the box AFTER it subtracts
                    the MEASURED width of a `<Legend layout="vertical" align="right">`
                    (lib/polar/Pie.js:112-123 ← selectChartOffsetInternal ← appendOffsetOfLegend,
                    util/ChartUtils.js:112-115). That width is uncapped: getWidthOrHeight applies its
                    maxWidth clamp to HORIZONTAL layout only, and DefaultLegendContent gives each
                    item `display:block` with no wrapping — so the single widest label sets
                    offset.right. A fixed `outerRadius={120}` did not shrink with the box, so
                    `cx - outerRadius` went negative and the browser cut the donut flat at the
                    <svg> viewport (recharts applies NO clipPath to the polar layer — verified: zero
                    clipPath references under polar/). Measured off a real screenshot: the 9-label
                    panels lost 5.5px and 6.5px off the donut's left edge, and each panel drew its
                    donut at a different size and offset because each legend measured differently.
                    Owning both columns fixes all of it — this box is ours, so the percentage radii
                    below cannot overflow it, and an over-long label ellipsizes instead of squeezing
                    the chart. It also removes recharts' two-pass reflow (legend size starts at 0,
                    so the first paint sized the pie for the full width and then re-rendered). */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                    <div style={{ flex: '0 0 auto', width: CHART_BOX_PX, maxWidth: '100%', height: CHART_BOX_PX }}>
                        <ResponsiveContainer>
                            <PieChart>
                                <Pie
                                    data={chartData}
                                    dataKey="value"
                                    nameKey="name"
                                    cx="50%"
                                    cy="50%"
                                    innerRadius="48%"
                                    outerRadius="92%"
                                    // Percentages resolve against min(width,height)/2 of the box
                                    // above, so the donut scales with its container instead of
                                    // outgrowing it.
                                    paddingAngle={padAngle}
                                    stroke="#fff"
                                    strokeWidth={2}
                                    isAnimationActive
                                />
                                <Tooltip
                                    formatter={(value, name) => {
                                        const pct = total > 0 ? Math.round((value / total) * 1000) / 10 : 0;
                                        return [`${_format(value)} (${pct}%)`, name];
                                    }}
                                    contentStyle={{ fontSize: 12, borderRadius: 6 }}
                                />
                            </PieChart>
                        </ResponsiveContainer>
                    </div>

                    {/* `minWidth: 0` lets this column actually shrink inside the flex row — without
                        it a long label sets the column's floor and pushes the donut out instead. */}
                    <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                        <BlockStack gap="100">
                            {chartData.map((d) => {
                                const pct = total > 0 ? Math.round((d.value / total) * 1000) / 10 : 0;
                                return (
                                    <div
                                        key={d.name}
                                        style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}
                                        title={`${d.name} — ${_format(d.value)} (${pct}%)`}
                                    >
                                        <span
                                            style={{
                                                flex: '0 0 auto',
                                                width: 10,
                                                height: 10,
                                                borderRadius: 2,
                                                background: d.fill
                                            }}
                                        />
                                        {/* The slice colour is carried by the swatch, not the text.
                                            recharts' own legend tinted each label to match its
                                            slice, which made the yellow and light-green entries
                                            unreadable on white. */}
                                        <span
                                            style={{
                                                flex: '1 1 auto',
                                                minWidth: 0,
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap'
                                            }}
                                        >
                                            <Text as="span" variant="bodySm">{d.name}</Text>
                                        </span>
                                        <span style={{ flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' }}>
                                            <Text as="span" variant="bodySm" tone="subdued">{`${pct}%`}</Text>
                                        </span>
                                    </div>
                                );
                            })}
                        </BlockStack>
                    </div>
                </div>
                <Text as="span" variant="bodySm" tone="subdued">
                    Total {activeMetric.label.toLowerCase()}: <strong>{_format(total)}</strong>
                    {chartData.length > 0 && chartData[chartData.length - 1].name.startsWith('Other (')
                        ? ` • Top ${topN} shown, remainder bucketed into Other`
                        : ''}
                </Text>
        </BlockStack>
    );
};

export default AttributionPieChart;
