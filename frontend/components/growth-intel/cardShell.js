import { Card } from '@shopify/polaris';

/**
 * The one implementation of "render me with my own Card, or bare inside someone else's".
 *
 * WHY IT EXISTS
 * -------------
 * A panel that owns its `<Card>` cannot be clubbed into a shared card — nesting one Card inside
 * another draws two borders. So each clubbable component takes a `bare` prop, and three of them had
 * already hand-rolled the same conditional with three slightly different results (one padded, two
 * not, one using `padding="0"`). This is that conditional, once.
 *
 *  USE IT FOR **EVERY** RETURN PATH IN A COMPONENT, including the empty state. A component whose
 * chart honours `bare` but whose "no data yet" branch still returns a `<Card>` looks correct in
 * every screenshot and breaks only on a day with no data — the single hardest case to notice.
 *
 * @param {Boolean} bare - true → no Card, just padding, for a caller that supplies the card.
 * @param {Object}  [opts]
 * @param {String}  [opts.cardPadding] - passed through to Card. Use "0" when the component's own
 *   content manages its edges (a full-bleed table, a tab strip).
 * @param {Boolean} [opts.padWhenBare=true] - false when the parent already pads this slot, or when
 *   the content is a full-bleed table that should touch the shared card's edges.
 * @returns {(children: React.ReactNode) => React.ReactNode}
 */
export const cardShell = (bare, { cardPadding, padWhenBare = true } = {}) => (children) => {
    if (!bare) {
        return <Card padding={cardPadding}>{children}</Card>;
    }
    if (!padWhenBare) {
        return <div>{children}</div>;
    }
    return <div style={{ padding: 'var(--p-space-400)' }}>{children}</div>;
};

export default cardShell;
