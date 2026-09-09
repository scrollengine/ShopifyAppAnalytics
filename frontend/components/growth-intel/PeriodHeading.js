import { BlockStack, Text } from '@shopify/polaris';

/**
 * The band that names the window the numbers below it describe.
 *
 * Generalises the heading pattern the Funnel page already shows — `FunnelStats` prints
 * `funnel.period_label` above its tiles, and keeps doing so; this is not an extraction of that
 * heading but the same affordance made reusable, so any page whose KPI cards depend on a selected
 * date range can state which range that is without re-deriving the copy.
 *
 * WHY THE SUBLINE MATTERS
 * -----------------------
 * A run-rate figure (MRR, ARPU, active subscribers) is a snapshot, not a sum over the window — so
 * "MRR for April" is meaningless without saying WHEN inside April it was measured. For a window that
 * has already closed that instant is the end of the window (`asOfLabel`); for a window still open it
 * is right now. The heading names the range, the subline names the measurement instant, and together
 * they make a screenshot of the cards self-describing.
 *
 * ⚠️ `inlineAlign="start"` is load-bearing: Polaris `BlockStack` defaults to align-items STRETCH, so
 * without it each `Text` becomes a full-width slab and the heading stops reading as a heading.
 *
 * @param {Object}  props
 * @param {String}  props.label          - the window's name, e.g. `Apr 1 – Apr 30, 2026`, `Last 1 year`,
 *   `All time`. Falsy renders nothing at all — there is no placeholder heading.
 * @param {String}  [props.asOfLabel]    - the measurement instant, used only when `isHistorical`.
 * @param {Boolean} [props.isHistorical] - true when the window has closed, so the figures were measured
 *   at `asOfLabel` rather than now.
 * @param {Boolean} [props.subdued]      - render the heading itself in the subdued tone, for a page
 *   that already has a louder title directly above this band.
 */
const PeriodHeading = ({ label, asOfLabel, isHistorical, subdued }) => {
    if (!label) return null;

    let subline = 'Run-rate figures measured now.';
    if (isHistorical) {
        // `asOfLabel` should always accompany a historical window; the guard is so a missing one
        // degrades to a sentence rather than a dangling "as of .".
        subline = 'Run-rate figures measured as of the end of the window.';
        if (asOfLabel) {
            subline = `Run-rate figures measured as of ${asOfLabel}.`;
        }
    }

    let headingTone;
    if (subdued) {
        headingTone = 'subdued';
    }

    return (
        <BlockStack gap="100" inlineAlign="start">
            <Text as="h3" variant="headingMd" tone={headingTone}>{label}</Text>
            <Text as="p" variant="bodySm" tone="subdued">{subline}</Text>
        </BlockStack>
    );
};

export default PeriodHeading;
