import { Card, BlockStack, Text, InlineGrid } from '@shopify/polaris';

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
const _fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');

const Stat = ({ label, value, sub }) => (
    <Card>
        <BlockStack gap="100">
            <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
            <Text as="span" variant="headingLg">{value}</Text>
            {sub ? <Text as="span" variant="bodySm" tone="subdued">{sub}</Text> : null}
        </BlockStack>
    </Card>
);

/**
 * The GA4 window summary — eight tiles describing the selected date range.
 *
 * Split out of the old `FunnelChart`, which bundled these tiles, an `afterStats` slot and the daily
 * trend chart into one component. Two things came out of that bundling:
 *   · the slot existed only so the page could inject a chart BETWEEN the tiles and the trend, and
 *     the whole thing returned `null` when GA4 had no data — which would have taken the injected
 *     Partner-API chart down with it, so the page had to hoist it to a variable and render it twice;
 *   · the tiles and the trend chart could not live on different tabs.
 * Separate components make both problems disappear rather than be worked around.
 *
 * These are window-level facts, so the page keeps them visible above the tabs rather than inside
 * one of them.
 *
 * @param {Object} props
 * @param {Object} props.funnel - response shape from the /funnel endpoint.
 */
const FunnelStats = ({ funnel }) => {
    if (!funnel) return null;
    // ⚠️ `|| {}` IS A LAST DITCH, NOT A CONTRACT. `/api/funnel` publishes `summary: null` in two
    // different situations — never synced, and synced-but-no-rollup-row for this window — and in
    // BOTH the page must gate this component out through `DataStateSection` rather than mount it
    // over an empty object. Eight tiles of em dashes under a period label is not an honest empty
    // state; it looks like eight measurements that came back blank.
    //
    // The `{}` is kept only so a shape this component was never meant to see cannot crash the page:
    // every field then misses and every formatter below prints an em dash, which claims nothing.
    const summary = funnel.summary || {};

    return (
        <BlockStack gap="300">
            <Text as="h3" variant="headingMd">{funnel.period_label || 'Funnel summary'}</Text>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
                <Stat label="Listing views" value={_fmtNum(summary.views)} sub={`${_fmtNum(summary.sessions)} sessions`} />
                {/* EVERY `_fmtPct` HERE TAKES A `number | null`. The five summary rates come out
                    of the backend's one `rate()`, which answers null for an absent denominator, and
                    `_fmtPct` prints an em dash for it. A `|| 0` anywhere on the way in would put
                    "0.00%" back under the words "Conversion rate" — in headingLg type — which is
                    the exact defect `modules/conversion/helpers/funnelMath.helper` was written to
                    end. A measured zero still prints "0.00%" and still means something. */}
                <Stat label="Install clicks" value={_fmtNum(summary.install_clicks)} sub={`CTR ${_fmtPct(summary.click_through_rate)}`} />
                <Stat label="Installs" value={_fmtNum(summary.installs)} sub={`Conv ${_fmtPct(summary.overall_conversion_rate)}`} />
                <Stat label="Ad-attributed installs" value={_fmtNum(summary.ad_clicks)} sub={`${_fmtPct(summary.ad_attributed_share)} of installs`} />
            </InlineGrid>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
                <Stat label="Engaged views" value={_fmtNum(summary.engaged_views)} />
                <Stat label="Consent completion" value={_fmtPct(summary.consent_completion_rate)} sub={`${_fmtNum(summary.consent_completed)}/${_fmtNum(summary.consent_started)}`} />
                <Stat label="First opens (post-install)" value={_fmtNum(summary.first_opens)} sub={`${_fmtPct(summary.first_open_rate)} of installs`} />
                <Stat label="First-time visitors" value={_fmtNum(summary.first_visits)} />
            </InlineGrid>
        </BlockStack>
    );
};

export default FunnelStats;
