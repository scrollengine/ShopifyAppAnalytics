import { BlockStack, Card, Text } from '@shopify/polaris';

import InstallTrendChart from './InstallTrendChart';

/**
 * =============================================================================
 *  The install trend, plus the one honest thing to say when there is no line.
 * =============================================================================
 *
 *  `InstallTrendChart` draws points. THIS decides whether there are any, and it
 *  is the deciding that is delicate — which is why it is one file rather than a
 *  copy on each of the two pages that show the chart (`/overview` and `/apps`).
 *  Three rules travel with it, and each of them was learned from something that
 *  shipped:
 *
 *    1. THE SERIES IS PUBLISHED AS `trend`, NOT `daily_trend`. The grain is not
 *       always days — `trend_grain` on the payload says which — so the key does
 *       not claim it is. The other two names are still accepted because this
 *       function is the fail-safe: an unrecognised shape yields `[]`, which OMITS
 *       the chart. That is the safe direction to be wrong in. A hidden chart is a
 *       visible gap; guessing a key and drawing whatever sat under it is a
 *       plausible wrong trend, which nobody can see is wrong.
 *
 *    2. A ROW WITH NULL COUNTS IS KEPT. That is an unmeasurable bucket, and
 *       recharts breaks the line over it — the honest rendering. Dropping it
 *       would close the gap and draw one continuous line across a stretch nobody
 *       measured. A row with no `date` IS dropped: there is no honest position to
 *       plot it at.
 *
 *    3. NO PAYLOAD MEANS NO SECTION. Handed `null`, this renders NOTHING —
 *       the same contract as its sibling `AppKpiCards`, and for a sharper reason.
 *       `<DataStateSection>` mounts its children in PENDING while a request is in
 *       flight, and `kpi.data` is null for the whole of that flight. The inline
 *       version of this block on the Partner Apps page therefore published, for
 *       as long as the KPI request took, the paragraph below: "the payload
 *       carries totals but no plottable points… this is a gap in the response".
 *       The payload had not arrived. Nothing about the response was yet known.
 *
 *  ── ⚠️ ONLY EVER HANDED A `READY` PAYLOAD ───────────────────────────────────
 *  Which is what makes the empty paragraph true. An app that has never synced
 *  sends `trend: null` with `data_state: 'NEVER_SYNCED'`, and `readDataState`
 *  replaces the whole section with a banner before this component is reached — so
 *  `[]` here means "this response carried no plottable points", never "nothing
 *  has ever run". The old page had no such interception and printed this
 *  paragraph at a reader whose response was exactly correct and whose sync had
 *  simply never happened.
 * =============================================================================
 */

/**
 * Pulls the install series out of a KPI payload, or returns `[]` when it carries none.
 *
 * Exported for the page that wants to know whether a chart WILL draw before it decides its own
 * layout — and so this rule can be tested without a renderer.
 *
 * @param {Object|null} kpi - A READY KPI payload.
 * @returns {Array} Rows of `{ date, installs, uninstalls, reinstalls }`, possibly empty.
 */
export const installTrendRows = (kpi) => {
    if (!kpi) {
        return [];
    }
    let rows = null;
    if (Array.isArray(kpi.daily_trend)) {
        rows = kpi.daily_trend;
    }
    if (!rows && Array.isArray(kpi.trend)) {
        rows = kpi.trend;
    }
    if (!rows && Array.isArray(kpi.install_trend)) {
        rows = kpi.install_trend;
    }
    if (!rows) {
        return [];
    }
    return rows.filter((row) => row && row.date);
};

/**
 * The install / reinstall / uninstall trend for one KPI payload.
 *
 * @param {Object} props
 * @param {Object|null} props.kpi - A READY KPI payload. `null` renders nothing — see rule 3.
 * @param {String} [props.title] - Heading, shared by the chart and by the no-points card so the
 *   section keeps its name in both.
 * @returns {JSX.Element|null}
 */
const InstallTrendSection = ({ kpi, title = 'Install activity' }) => {
    // Rule 3. Not a defensive `if (!kpi)` — it is the difference between saying nothing while a
    // request is in flight and describing a response that has not arrived.
    if (!kpi) {
        return null;
    }

    const rows = installTrendRows(kpi);

    if (rows.length > 0) {
        return <InstallTrendChart data={rows} title={title} />;
    }

    return (
        <Card>
            <BlockStack gap="200">
                <Text as="h3" variant="headingMd">{title}</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                    The KPI payload carries totals but no plottable points, so there is nothing to draw.
                    This is a gap in the response, not a stretch with no installs — a window with no events
                    still returns one point per bucket, and an unmeasurable bucket returns null counts that
                    break the line. The chart is omitted rather than drawn flat at zero.
                </Text>
            </BlockStack>
        </Card>
    );
};

export default InstallTrendSection;
