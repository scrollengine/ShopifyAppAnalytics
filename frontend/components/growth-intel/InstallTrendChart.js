import { Card, BlockStack, Text } from '@shopify/polaris';
import dynamic from 'next/dynamic';

// Recharts is client-only — disable SSR to avoid window-not-defined errors.
const ResponsiveContainer = dynamic(() => import('recharts').then((m) => m.ResponsiveContainer), { ssr: false });
const LineChart = dynamic(() => import('recharts').then((m) => m.LineChart), { ssr: false });
const Line = dynamic(() => import('recharts').then((m) => m.Line), { ssr: false });
const XAxis = dynamic(() => import('recharts').then((m) => m.XAxis), { ssr: false });
const YAxis = dynamic(() => import('recharts').then((m) => m.YAxis), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then((m) => m.Tooltip), { ssr: false });
const Legend = dynamic(() => import('recharts').then((m) => m.Legend), { ssr: false });
const CartesianGrid = dynamic(() => import('recharts').then((m) => m.CartesianGrid), { ssr: false });

/**
 * Daily install / uninstall / reinstall line chart.
 *
 * EVERY MEASURED POINT IS DRAWN AS A DOT, AND THAT IS NOT DECORATION. An unmeasurable bucket
 * arrives with null counts and recharts' default `connectNulls` of false breaks the line over it,
 * which is the honest rendering — the alternative is one continuous line across a stretch nobody
 * measured. But a line is drawn BETWEEN points, so with dots switched off a measured bucket flanked
 * by two unmeasured ones has nothing to join to and renders as ZERO PIXELS: a real, non-zero day
 * that the chart simply does not show. The dots make the points themselves visible, so what is
 * missing from the picture is only ever what was missing from the data.
 *
 * `InstallTrendSection` is what decides there are points to draw at all, and it is the only caller;
 * the empty state below is unreachable from either page that mounts this.
 *
 * @param {Object} props
 * @param {Array}  props.data - Array of { date, installs, uninstalls, reinstalls }. Rows with null
 *   counts are KEPT and break the line; recharts draws no dot for them either.
 * @param {String} [props.title]
 */
const InstallTrendChart = ({ data, title }) => {
    const safe = Array.isArray(data) ? data : [];
    return (
        <Card>
            <BlockStack gap="300">
                <Text as="h3" variant="headingMd">{title || 'Install activity'}</Text>
                {safe.length === 0 ? (
                    <Text as="p" variant="bodySm" tone="subdued">No event data in this window yet. Trigger a sync to populate.</Text>
                ) : (
                    <div style={{ width: '100%', height: 280 }}>
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={safe} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#e1e3e5" />
                                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                                <Tooltip />
                                <Legend />
                                <Line type="monotone" dataKey="installs" stroke="#1f9d55" strokeWidth={2} dot={{ r: 2 }} />
                                <Line type="monotone" dataKey="uninstalls" stroke="#d72c0d" strokeWidth={2} dot={{ r: 2 }} />
                                <Line type="monotone" dataKey="reinstalls" stroke="#005abc" strokeWidth={2} dot={{ r: 2 }} />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                )}
            </BlockStack>
        </Card>
    );
};

export default InstallTrendChart;
