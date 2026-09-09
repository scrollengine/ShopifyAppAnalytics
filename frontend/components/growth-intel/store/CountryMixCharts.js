import { BlockStack, InlineGrid, Text, Banner } from '@shopify/polaris';
import AttributionPieChart from '../AttributionPieChart';
import { cardShell } from '../cardShell';
import { fmtMoney } from './storePresentation';

const _num = (n) => Number(n || 0).toLocaleString();

/**
 * Two donuts, side by side: where the customers are, and where the money is.
 *
 * ⚠️ They are deliberately NOT the same shape, and the difference is the point. A country can hold a
 * large share of the paying customers and a small share of the MRR, or the reverse — a handful of
 * high-plan merchants in one market can outweigh ten times as many on the entry plan somewhere else.
 * A single "stores by country" pie hides exactly that, which is why revenue gets its own donut
 * rather than a column in a table nobody scrolls to.
 *
 * Zero-value countries never reach the chart: AttributionPieChart drops non-positive values, so the
 * paying donut is not 160 invisible slices.
 *
 * @param {Object}  props
 * @param {Array}   props.rows  - `items` from /stores/countries.
 * @param {Object}  props.totals
 * @param {Boolean} [props.bare]
 */
const CountryMixCharts = ({ rows, totals, bare = false }) => {
    const all = Array.isArray(rows) ? rows : [];
    const wrap = cardShell(bare, { cardPadding: '0', padWhenBare: false });

    const t = totals || {};
    const payingTotal = Number(t.paying) || 0;
    const mrrTotal = Number(t.mrr) || 0;

    //  Applied to EVERY return path including this one. A component whose chart honours `bare` but
    // whose empty state still returns its own Card looks right in every screenshot and breaks only
    // on a day with no data.
    if (all.length === 0 || (payingTotal === 0 && mrrTotal === 0)) {
        return wrap(
            <div style={{ padding: 'var(--p-space-400)' }}>
                <Banner tone="info">
                    <Text as="p" variant="bodySm">
                        No paying customers in this selection yet, so there is no revenue mix to plot.
                        The table below still shows every country with installs.
                    </Text>
                </Banner>
            </div>
        );
    }

    const CHARTS = [
        {
            key: 'customers',
            title: 'Where the customers are',
            subtitle: `${_num(payingTotal)} paying of ${_num(t.stores)} stores`,
            // A toggle rather than three panels: the same question asked at three depths of the
            // funnel, and flipping between them is how a market that installs but never converts
            // becomes obvious.
            metrics: [
                { key: 'paying', label: 'Paying' },
                { key: 'stores', label: 'Stores' },
                { key: 'installed', label: 'Installed' }
            ],
            formatValue: undefined
        },
        {
            key: 'money',
            title: 'Where the money is',
            subtitle: `${fmtMoney(mrrTotal)} MRR · ${fmtMoney(t.net_revenue)} lifetime net`,
            // Gross AND net, named. They differ by Shopify's fee, and showing only one of them under
            // the word "spend" is what made this page disagree with the Revenue card.
            metrics: [
                { key: 'mrr', label: 'MRR' },
                { key: 'net_revenue', label: 'Net' },
                { key: 'total_spend', label: 'Gross' }
            ],
            formatValue: fmtMoney
        }
    ];

    return wrap(
        <BlockStack gap="0">
            {/* `gap="0"` plus a left border on the second cell: whitespace between charts reads as
                "separate things", a hairline reads as "one thing, divided". The border is dropped at
                the breakpoint where the grid collapses to one column, or it would appear as a stray
                line down the left edge of the stacked chart. */}
            <InlineGrid columns={{ xs: 1, sm: 1, md: 2 }} gap="0">
                {CHARTS.map((c, i) => (
                    <div
                        key={c.key}
                        style={i === 0 ? undefined : { borderLeft: '1px solid var(--p-color-border-secondary)' }}
                    >
                        <AttributionPieChart
                            items={all}
                            labelKey="country_name"
                            title={c.title}
                            subtitle={c.subtitle}
                            metrics={c.metrics}
                            formatValue={c.formatValue}
                            topN={8}
                            bare
                        />
                    </div>
                ))}
            </InlineGrid>
        </BlockStack>
    );
};

export default CountryMixCharts;
