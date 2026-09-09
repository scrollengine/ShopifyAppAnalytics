import { Card, BlockStack, InlineStack, Text } from '@shopify/polaris';
import { fmtMoneyOrDash, fmtNumOrDash, fmtPercentOrDash, fmtSigned } from './moneyFormat';

/**
 * One block in the movement strip. Private to this file, the same shape as `FunnelStats`' `Stat` and
 * the revenue page's `StatCard` — a label, a number, and a line of context under it.
 */
const MovementStat = ({ label, value, tone, sub }) => (
    <BlockStack gap="100" inlineAlign="start">
        <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="span" variant="headingLg" tone={tone}>{value}</Text>
        {sub ? <Text as="span" variant="bodySm" tone="subdued">{sub}</Text> : null}
    </BlockStack>
);

/**
 * Money with a FIXED direction, taken from the column rather than from the value's own sign.
 *
 * Contraction and churn are losses whichever way the backend chooses to express them — some payloads
 * send a magnitude, some a negative. Normalising to the magnitude and applying the column's direction
 * means the strip reads the same either way, and a sign flip on the API side can never turn a churn
 * column green.
 *
 * @param {Number|null} n
 * @param {Number} direction - 1 for a gain column, -1 for a loss column.
 */
const _directional = (n, direction) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return fmtSigned(Math.abs(Number(n)) * direction);
};

/**
 * The count line under a movement block. `null` when the count is absent, so the block simply drops
 * the line instead of printing "— stores".
 */
const _storeCount = (n) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return null;
    let noun = 'stores';
    if (Number(n) === 1) {
        noun = 'store';
    }
    return `${fmtNumOrDash(n)} ${noun}`;
};

/**
 * How MRR moved across the selected window: the opening balance, the four forces that acted on it,
 * and the closing balance.
 *
 * The strip is deliberately ordered as an equation — Start, then the two gains, then the two losses,
 * then End — so the eye can check that it balances. Gains carry `+` and the success tone, losses `−`
 * and the critical tone, and every block states how many STORES moved as well as how much money, so a
 * large number driven by one enterprise account cannot be mistaken for broad movement.
 *
 *  A null churn rate renders `—` and its clause is DROPPED from the footer rather than printed as
 * `0.0%`. Gross and net churn are ratios against the paying base at the START of the window; a window
 * that opened with no paying base (every "All time" window does) has no denominator, and `0.0%` there
 * tells the reader the business has never lost a customer. The retention line obeys the same rule and
 * is dropped whole rather than printed as `100.0%`, which is the identical lie wearing the other face.
 *
 * THE FOOTER NAMES WHAT GROSS CHURN INCLUDES, and it has to. `gross_churn_rate` is
 * `(churned + contraction) / start` — cancellations PLUS downgrades — the same definition
 * `/api/revenue/churn` publishes for the Revenue → Churn tab. The backend once computed it here as
 * cancellations only, so one month read 4% on this card and 7% on that page; a caption that says
 * merely "measured against the paying base" leaves a reader who spots a difference no way to tell a
 * definition apart from a bug.
 *
 * @param {Object}  props
 * @param {Object}  [props.movement]    - `null`, or `{ start_mrr, end_mrr, new_mrr, expansion_mrr,
 *   contraction_mrr, churned_mrr, new_count, expanded_count, contracted_count, churned_count,
 *   gross_churn_rate, net_churn_rate, gross_revenue_retention_rate, net_revenue_retention_rate }`.
 *   Every rate is a FRACTION and may be `null`; `net_revenue_retention_rate` may exceed `1`.
 * @param {String}  [props.periodLabel] - the window this movement covers, named in the subtitle.
 * @param {Boolean} [props.loading]     - true while the window's data is in flight.
 * @param {Function} [props.onSelectBucket] - `(bucketKey) => void`, called with `'new'`,
 *   `'expansion'`, `'contraction'` or `'churned'` when its block is activated. Omit it and every
 *   block renders exactly as it always has. Start and End are NEVER clickable: they are BALANCES,
 *   not movements, so there is no set of stores behind them to list.
 */
const RevenueMovementStats = ({ movement, periodLabel, loading, onSelectBucket }) => {
    if (loading) {
        return (
            <Card>
                <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">MRR movement</Text>
                    <Text as="p" variant="bodySm" tone="subdued">Loading MRR movement…</Text>
                </BlockStack>
            </Card>
        );
    }

    if (!movement) {
        return (
            <Card>
                <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">MRR movement</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                        Pick a date range to see how MRR moved over the period.
                    </Text>
                </BlockStack>
            </Card>
        );
    }

    let subtitle = 'How MRR moved over the selected period.';
    if (periodLabel) {
        subtitle = `How MRR moved over ${periodLabel}.`;
    }

    // Start and End have no store count in the payload — they are balances, not movements — so they
    // carry a positional line instead, which also keeps the six blocks the same height.
    //
    // `count` is carried alongside `sub` rather than parsed back out of it: `sub` is a rendered
    // string ("20 stores", or null), and it is the raw count that decides whether there is a list to
    // drill into. Its ABSENCE on Start and End is what makes those two unclickable.
    const blocks = [
        { key: 'start',       label: 'Start',       value: fmtMoneyOrDash(movement.start_mrr),          sub: 'At period start' },
        { key: 'new',         label: 'New',         value: _directional(movement.new_mrr, 1),           sub: _storeCount(movement.new_count),        tone: 'success',  count: movement.new_count },
        { key: 'expansion',   label: 'Expansion',   value: _directional(movement.expansion_mrr, 1),     sub: _storeCount(movement.expanded_count),   tone: 'success',  count: movement.expanded_count },
        { key: 'contraction', label: 'Contraction', value: _directional(movement.contraction_mrr, -1),  sub: _storeCount(movement.contracted_count), tone: 'critical', count: movement.contracted_count },
        { key: 'churned',     label: 'Churned',     value: _directional(movement.churned_mrr, -1),      sub: _storeCount(movement.churned_count),    tone: 'critical', count: movement.churned_count },
        { key: 'end',         label: 'End',         value: fmtMoneyOrDash(movement.end_mrr),            sub: 'At period end' }
    ];

    /**
     * One block, wrapped in a control only when there is something to open.
     *
     *  A real `<button>`, not an `onClick` on the wrapping `<div>`. A div with a click handler is
     * invisible to the keyboard and announced to a screen reader as a group of text — the drill-down
     * would exist only for a mouse. The button carries no chrome of its own (`background: none`,
     * `border: none`), so a clickable block looks identical to a static one until it is hovered or
     * focused; the affordance lives in `.se-movement-stat` in `public/css/index.css`, because a
     * `:hover` and a `:focus-visible` rule cannot be expressed as an inline style.
     */
    const _renderBlock = (b) => {
        const stat = <MovementStat label={b.label} value={b.value} tone={b.tone} sub={b.sub} />;
        // A bucket with a zero count has an empty list behind it — a click that opens "no stores" is
        // a dead end, so the block simply is not a control.
        let clickable = false;
        if (typeof onSelectBucket === 'function' && Number(b.count) > 0) {
            clickable = true;
        }
        if (!clickable) {
            return stat;
        }
        return (
            <button
                type="button"
                className="se-movement-stat"
                onClick={() => onSelectBucket(b.key)}
                aria-label={`${b.label}: ${b.value}. Show the ${b.sub} behind this figure.`}
            >
                {stat}
            </button>
        );
    };

    /**
     * One "Label 12.3%" clause, or nothing at all when the rate is absent.
     *
     * A rate that is null takes its WHOLE CLAUSE with it rather than printing `Gross churn —`, which
     * reads as a broken number rather than as an unmeasurable one; the sentence's own fallback says
     * why nothing could be measured. `fmtPercentOrDash` still guards the value — the check here is
     * about the SENTENCE, not the number.
     */
    const _clause = (label, rate) => {
        if (rate === null || rate === undefined || Number.isNaN(Number(rate))) return null;
        return `${label} ${fmtPercentOrDash(rate)}`;
    };

    const churnClauses = [
        _clause('Gross churn', movement.gross_churn_rate),
        _clause('Net churn', movement.net_churn_rate)
    ].filter(Boolean);
    let churnLine = 'Churn rate — no paying base at the start of this window to measure against.';
    if (churnClauses.length > 0) {
        // "cancellations plus downgrades" is not decoration. It is the sentence that lets a reader
        // reconcile this card with the Revenue → Churn tab instead of guessing which one to believe.
        churnLine = `${churnClauses.join(' • ')} — cancellations plus downgrades, measured against the `
            + 'paying base at the start of the window. Net churn subtracts expansion from that same base.';
    }

    // The same two facts read the other way up, because that is how retention targets are written.
    // Dropped entirely — not printed as 100.0% — when there was no opening base to retain.
    const retentionClauses = [
        _clause('Gross revenue retention', movement.gross_revenue_retention_rate),
        _clause('Net revenue retention', movement.net_revenue_retention_rate)
    ].filter(Boolean);
    let retentionLine = null;
    if (retentionClauses.length > 0) {
        retentionLine = `${retentionClauses.join(' • ')} — how much of that opening base's MRR was still `
            + 'being paid at the close. Gross ignores expansion; net counts it, so net can exceed 100%.';
    }

    return (
        <Card>
            <BlockStack gap="400">
                <BlockStack gap="100" inlineAlign="start">
                    <Text as="h3" variant="headingMd">MRR movement</Text>
                    <Text as="p" variant="bodySm" tone="subdued">{subtitle}</Text>
                </BlockStack>

                {/* `flex: '1 1 160px'` on each block rather than a fixed grid: six columns on a wide
                    screen, wrapping to three or two as the panel narrows, without a breakpoint list
                    that has to be kept in step with the block count. */}
                <InlineStack gap="400" wrap>
                    {blocks.map((b) => (
                        <div key={b.key} style={{ flex: '1 1 160px' }}>
                            {_renderBlock(b)}
                        </div>
                    ))}
                </InlineStack>

                <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">{churnLine}</Text>
                    {retentionLine ? (
                        <Text as="p" variant="bodySm" tone="subdued">{retentionLine}</Text>
                    ) : null}
                </BlockStack>
            </BlockStack>
        </Card>
    );
};

export default RevenueMovementStats;
