import { IndexTable, BlockStack, InlineStack, Text, Tooltip, EmptyState } from '@shopify/polaris';
import { fmtMoney } from './storePresentation';

/**
 * A count. `—` for an absence, never a fabricated `0`.
 *
 * ⚠️ IT USED TO BE `Number(n || 0)`, which prints a measured-looking zero for anything missing. Safe
 * only by coincidence — every countable field on a `CountryRollupRow` happens to be non-nullable — and
 * a coincidence is not a guard. The page's own `_isNum` already handles this correctly; the table was
 * the one place that did not.
 *
 * @param {*} n
 * @returns {String}
 */
const _num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : '—');

/**
 * A FRACTION as a percentage. `—` when there is no rate.
 *
 * ⚠️ `conversion_rate` is declared `number | null` — null when a country has no stores to divide by —
 * and `Number(null) || 0` printed `0%`, which reads as "nobody in this market converts". That is a
 * strong claim about a market manufactured out of an empty denominator.
 *
 * @param {*} v - a fraction, NOT an already-multiplied percentage.
 * @returns {String}
 */
const _pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 1000) / 10}%` : '—');

/**
 * Stores, installs, paying customers and MRR per country.
 *
 * Answers what the store list's facet counts cannot: a count says how many stores are in a bucket,
 * not how many are worth anything. Default order is PAYING customers, not store count — ranking by
 * volume buries a small market that converts well underneath a large one that never pays, which is
 * the exact comparison this table exists to make.
 *
 * @param {Object}   props
 * @param {Array}    props.rows      - `items` from /stores/countries.
 * @param {Boolean}  [props.loading]
 * @param {Function} props.onSelect  - (isoCode) => void; opens that country's stores.
 */
const CountryTable = ({ rows, loading, onSelect }) => {
    const all = Array.isArray(rows) ? rows : [];

    const markup = all.map((row, index) => (
        <IndexTable.Row
            id={row.country}
            key={row.country}
            position={index}
            onClick={() => onSelect && onSelect(row.country)}
        >
            <IndexTable.Cell>
                <InlineStack gap="150" blockAlign="center" wrap={false}>
                    <Text as="span" variant="bodyMd" fontWeight="semibold">{row.country_name}</Text>
                    {/* The ISO code alongside the name, except for the Unknown bucket, which has none
                        and would otherwise render the literal string "UNKNOWN" twice. */}
                    {row.country !== 'UNKNOWN' ? (
                        <Text as="span" variant="bodyXs" tone="subdued">{row.country}</Text>
                    ) : null}
                </InlineStack>
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Text as="span" variant="bodyMd" numeric>{_num(row.stores)}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Text as="span" variant="bodyMd" numeric>{_num(row.installed)}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                {row.paying > 0 ? (
                    <Tooltip content={`${_num(row.paying)} of ${_num(row.stores)} stores here are being billed right now.`}>
                        <BlockStack gap="050" inlineAlign="start">
                            <Text as="span" variant="bodyMd" numeric fontWeight="semibold">{_num(row.paying)}</Text>
                            <Text as="span" variant="bodyXs" tone="subdued">{_pct(row.conversion_rate)}</Text>
                        </BlockStack>
                    </Tooltip>
                ) : (
                    <Text as="span" variant="bodySm" tone="subdued">0</Text>
                )}
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Text as="span" variant="bodyMd" numeric>{_num(row.trialing)}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Tooltip content="Stores here that have settled at least one payment, ever — including ones that have since churned.">
                    <Text as="span" variant="bodyMd" numeric>{_num(row.ever_paid)}</Text>
                </Tooltip>
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Text as="span" alignment="end" numeric>{fmtMoney(row.mrr)}</Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Tooltip content="Gross — what merchants in this country paid, before Shopify's fee.">
                    <Text as="span" alignment="end" numeric>{fmtMoney(row.total_spend)}</Text>
                </Tooltip>
            </IndexTable.Cell>
            <IndexTable.Cell>
                <Tooltip content="Net — what we actually received, after Shopify's fee. This is the measure the Revenue page's lifetime figure uses.">
                    <Text as="span" alignment="end" numeric>{fmtMoney(row.net_revenue)}</Text>
                </Tooltip>
            </IndexTable.Cell>
        </IndexTable.Row>
    ));

    return (
        <IndexTable
            resourceName={{ singular: 'country', plural: 'countries' }}
            itemCount={all.length}
            selectable={false}
            loading={loading}
            emptyState={(
                <EmptyState heading="No countries match these filters" image="">
                    <Text as="p" tone="subdued">Try clearing a filter or the search.</Text>
                </EmptyState>
            )}
            headings={[
                { title: 'Country' },
                { title: 'Stores' },
                { title: 'Installed' },
                { title: 'Paying' },
                { title: 'On trial' },
                { title: 'Ever paid' },
                { title: 'MRR', alignment: 'end' },
                //  "Gross" / "Net" spelled out. This column summed GROSS while the Revenue page's
                // lifetime card showed NET, so the same word named two different numbers on adjacent
                // screens — which reads as one of them being broken.
                { title: 'Gross spend', alignment: 'end' },
                { title: 'Net revenue', alignment: 'end' }
            ]}
        >
            {markup}
        </IndexTable>
    );
};

export default CountryTable;
