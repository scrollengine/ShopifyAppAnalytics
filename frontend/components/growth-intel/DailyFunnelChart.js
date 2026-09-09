import { BlockStack, Text } from '@shopify/polaris';
import { cardShell } from './cardShell';
import dynamic from 'next/dynamic';

const ResponsiveContainer = dynamic(() => import('recharts').then((m) => m.ResponsiveContainer), { ssr: false });
const ComposedChart = dynamic(() => import('recharts').then((m) => m.ComposedChart), { ssr: false });
const Line = dynamic(() => import('recharts').then((m) => m.Line), { ssr: false });
const Bar = dynamic(() => import('recharts').then((m) => m.Bar), { ssr: false });
const XAxis = dynamic(() => import('recharts').then((m) => m.XAxis), { ssr: false });
const YAxis = dynamic(() => import('recharts').then((m) => m.YAxis), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then((m) => m.Tooltip), { ssr: false });
const Legend = dynamic(() => import('recharts').then((m) => m.Legend), { ssr: false });
const CartesianGrid = dynamic(() => import('recharts').then((m) => m.CartesianGrid), { ssr: false });

const _shortDate = (d) => {
    if (!d) return '';
    try {
        const dt = typeof d === 'string' ? new Date(d) : d;
        return dt.toISOString().slice(0, 10);
    } catch (e) { return String(d); }
};

/**
 * A stored rate as a percentage for the chart, or `null` when the day has no rate.
 *
 * THIS FUNCTION EXISTS BECAUSE `|| 0` WAS HERE. The mapper below read
 * `Number((r.overall_conversion_rate || 0) * 100)`, and a day whose listing had no views — so no
 * conversion rate to compute — was plotted at 0%. Recharts then drew the line THROUGH the floor
 * across that stretch, and a flat 0% conversion line over a week is a picture of a catastrophe that
 * did not happen. It is also the more forceful of the two renderings on this page: a tile states its
 * zero, a chart draws it.
 *
 * `null` instead, so recharts omits the point and `connectNulls={false}` breaks the series over the
 * gap (IMPLEMENTATION.md §3.11 — "a chart breaks the line rather than drawing a point at the
 * floor"). Copied deliberately from the Trial Funnel's `conversion_rate_pct` line, which solved the
 * same problem for the same reason.
 *
 * ⚠️ A MEASURED ZERO STILL PLOTS. `0` — real views, no installs — is finite, returns `0`, and draws
 * a point on the floor that has earned its place. Only null/undefined/non-finite break the line.
 *
 * @param {Number|null|undefined} rate - A rate in 0..1 as `/api/funnel` published it.
 * @returns {Number|null} The rate as a percentage, or null when there is none.
 */
const _pctOrNull = (rate) => {
    if (rate === null || rate === undefined || rate === '') return null;
    const v = Number(rate);
    if (!Number.isFinite(v)) return null;
    return v * 100;
};

/**
 * Day-by-day GA4 movement: views, installs and ad clicks as bars, conversion rate as a line on a
 * secondary axis.
 *
 * Its own tab now. Bundled under the funnel summary it was the third thing on a very tall page and
 * competed with the step funnel — which answers a different question ("where do people drop out")
 * from this one ("is the trend improving").
 *
 * @param {Object} props
 * @param {Object} props.funnel - response shape from the /funnel endpoint.
 */
const DailyFunnelChart = ({ funnel, bare = false }) => {
    const wrap = cardShell(bare);
    if (!funnel) return null;
    const trend = Array.isArray(funnel.trend) ? funnel.trend.map((r) => ({
        date: _shortDate(r.date),
        // The three bar series are COUNTS, and an absent count genuinely is zero occurrences — they
        // arrive as bare numbers and are plotted as they came. The rate below is the one field on
        // this row that can be unknown, and it is the one that must not be coerced.
        views: r.views,
        installs: r.installs,
        ad_clicks: r.ad_clicks,
        conv_pct: _pctOrNull(r.overall_conversion_rate)
    })) : [];

    return wrap(
        <BlockStack gap="200">
            <Text as="h3" variant="headingMd">Daily funnel</Text>
            {/* ⚠️ Reachable only as a defensive path. `/api/funnel` returns a non-null `summary`
                exactly when the rollup matched at least one row, and the trend read matches the same
                rows — so a mounted chart with an empty trend means the payload disagreed with
                itself. It says what is true of the DATA and does not prescribe a sync: for a window
                the rollup simply does not reach a sync has already run, and telling the operator to
                run another is how they learn to ignore the message. */}
            {trend.length === 0 ? (
                <Text as="p" variant="bodySm" tone="subdued">No daily rows for this window.</Text>
            ) : (
                <div style={{ width: '100%', height: 320 }}>
                    <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={trend} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#e1e3e5" />
                            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                            <YAxis yAxisId="left" tick={{ fontSize: 11 }} allowDecimals={false} />
                            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} tickFormatter={(v) => `${v.toFixed(1)}%`} />
                            <Tooltip />
                            <Legend />
                            <Bar yAxisId="left" dataKey="views" fill="#005abc" name="Views" />
                            <Bar yAxisId="left" dataKey="installs" fill="#1f9d55" name="Installs" />
                            <Bar yAxisId="left" dataKey="ad_clicks" fill="#bf2600" name="Ad clicks" />
                            {/* `connectNulls={false}` — STATED, NOT INHERITED. A day with no
                                conversion rate must leave a GAP: a line drawn straight through it
                                reads as continuous and measured, which is the one thing the null
                                above exists to prevent.

                                ⚠️ Recharts ALREADY DEFAULTS THIS TO `false` (3.10.1,
                                `cartesian/Line.js` defaultProps), so this prop changes no pixel
                                today — and an earlier version of this comment claimed the opposite,
                                that the default "bridges a gap". It is written out anyway, and must
                                stay: the correctness of every null in this series depends on it, and
                                a default is a promise the library can revise in a minor release
                                without anyone here reading the changelog. Keep the prop; do not keep
                                a reason for it that is false about the library.

                                `dot={{ r: 2 }}` so a single measured day surrounded by gaps is still
                                visible — a lone point with no dot draws nothing at all. */}
                            <Line
                                yAxisId="right"
                                type="monotone"
                                dataKey="conv_pct"
                                stroke="#9c6ade"
                                strokeWidth={2}
                                dot={{ r: 2 }}
                                name="Conv %"
                                connectNulls={false}
                            />
                        </ComposedChart>
                    </ResponsiveContainer>
                </div>
            )}
        </BlockStack>
    );
};

export default DailyFunnelChart;
