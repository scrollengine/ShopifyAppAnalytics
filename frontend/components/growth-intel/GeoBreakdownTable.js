import { BlockStack, InlineStack, Text, IndexTable, Pagination } from '@shopify/polaris';
import { cardShell } from './cardShell';
import { useEffect, useMemo, useState } from 'react';

const _fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');
/**
 * A rate as a percentage, or an em dash when there is no rate.
 *
 * `null` MUST REACH THIS AS `null`. `/api/funnel` publishes every rate through the backend's one
 * `rate()`, which answers `null` for an absent denominator — `installs ÷ 0 views` is not "0.00%
 * converted", and "Consent completion 0.00% · 0/0" is a claim that every merchant abandoned a
 * screen nobody reached. Never `?? 0` or `|| 0` a rate on the way in here: the coalesce is the bug,
 * and it is invisible because "0.00%" renders perfectly.
 *
 * ⚠️ A MEASURED ZERO STILL PRINTS "0.00%". `0` is a real answer — a hundred views and no installs
 * is a measurement — so the guard tests for null/undefined/'' and non-finite values EXPLICITLY
 * rather than for falsiness. `if (!n) return '—'` would erase every genuine zero on this page.
 *
 * @param {Number|null|undefined} n - A rate in 0..1, or null when unmeasured.
 * @returns {String} `NN.NN%`, or an em dash.
 */
const _fmtPct = (n) => {
    if (n === null || n === undefined || n === '') return '—';
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return `${(v * 100).toFixed(2)}%`;
};

const PAGE_SIZE = 15;

/**
 * Aggregated geographic-breakdown table by country. Paginated client-side at
 * `PAGE_SIZE` rows per page (the API already returns the full slice ≤ 250).
 *
 * @param {Object} props
 * @param {Array}  props.items - rows from /funnel/geo
 * @param {String} [props.title]
 */
const GeoBreakdownTable = ({ items, title, bare = false }) => {
    const rows = Array.isArray(items) ? items : [];
    const [page, setPage] = useState(1);

    useEffect(() => { setPage(1); }, [items]);

    const totalPages = Math.max(Math.ceil(rows.length / PAGE_SIZE), 1);
    const safePage = Math.min(page, totalPages);
    const startIdx = (safePage - 1) * PAGE_SIZE;
    const endIdx = Math.min(startIdx + PAGE_SIZE, rows.length);
    const pageRows = useMemo(() => rows.slice(startIdx, endIdx), [rows, startIdx, endIdx]);

    // Rendered without a <Card> when the caller is clubbing several sections into one card. One
    // wrapper for both paths so the empty state cannot diverge from the populated one.
    const wrap = cardShell(bare, { cardPadding: '0', padWhenBare: false });

    if (rows.length === 0) {
        return wrap(
            <div style={{ padding: '12px 16px' }}>
                <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">{title || 'Geographic breakdown'}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">No geo data in this window yet.</Text>
                </BlockStack>
            </div>
        );
    }

    return wrap(
        <>
            <div style={{ padding: '12px 16px' }}>
                <Text as="h3" variant="headingMd">{title || 'Geographic breakdown'}</Text>
            </div>
            <IndexTable
                resourceName={{ singular: 'country', plural: 'countries' }}
                itemCount={pageRows.length}
                headings={[
                    { title: 'Country' },
                    { title: 'Views' },
                    { title: 'Installs' },
                    { title: 'Conversion rate' }
                ]}
                selectable={false}
            >
                {pageRows.map((r, i) => {
                    const absIdx = startIdx + i;
                    return (
                        <IndexTable.Row id={String(absIdx)} key={absIdx} position={absIdx}>
                            <IndexTable.Cell>{r.country || '(unknown)'}</IndexTable.Cell>
                            <IndexTable.Cell>{_fmtNum(r.views)}</IndexTable.Cell>
                            <IndexTable.Cell>{_fmtNum(r.installs)}</IndexTable.Cell>
                            {/* NULLABLE, same rule as the traffic-source table's `install_rate`:
                                a country with installs and no views has no conversion rate, and
                                "0.00%" beside a views count of 0 is a claim about that country's
                                merchants rather than about our data. Em dash. */}
                            <IndexTable.Cell>{_fmtPct(r.conversion_rate)}</IndexTable.Cell>
                        </IndexTable.Row>
                    );
                })}
            </IndexTable>
            {rows.length > PAGE_SIZE ? (
                <div style={{ padding: '12px 16px', borderTop: '1px solid #e1e3e5' }}>
                    <InlineStack align="space-between" blockAlign="center">
                        <Text as="span" variant="bodySm" tone="subdued">
                            {`Showing ${startIdx + 1}–${endIdx} of ${rows.length}`}
                        </Text>
                        <Pagination
                            hasPrevious={safePage > 1}
                            onPrevious={() => setPage((p) => Math.max(p - 1, 1))}
                            hasNext={safePage < totalPages}
                            onNext={() => setPage((p) => Math.min(p + 1, totalPages))}
                            label={`Page ${safePage} of ${totalPages}`}
                        />
                    </InlineStack>
                </div>
            ) : null}
        </>
    );
};

export default GeoBreakdownTable;
