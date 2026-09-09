import { Card, BlockStack, InlineGrid, Text, Badge } from '@shopify/polaris';

/**
 * =============================================================================
 *  The KPI tiles — and the one unit on this payload that is not for sale.
 * =============================================================================
 *
 *  Eight figures for one partner app: installs, uninstalls, reinstalls and gross
 *  revenue over the rolling window, then the all-time counterparts plus the
 *  estimated-active fold. Rendered on the Overview (`/overview`) and at the
 *  foot of the Partner Apps setup screen, from a single READY payload.
 *
 *  ── THE WINDOW HAS A CURRENCY. THE LIFETIME TOTAL DOES NOT. ──────────────
 *  `revenue.currency` is the ONLY currency field on this payload, and the service
 *  sets it to `windowCurrencies.length === 1 ? windowCurrencies[0] : null` — the
 *  denomination of the payouts that settled INSIDE THE SELECTED WINDOW, gated on
 *  there being exactly one of them, with `mixedCurrencies` raised when there is
 *  not.
 *
 *  `all_time.gross_revenue` comes from a different read with no such gate:
 *  `getLifetimeCashTotals` groups on `_id: null` and sums `gross_amount.amount`
 *  over the WHOLE transaction history, across every currency in it, and returns
 *  no currency at all (`PartnerAppKpiAllTime` has no such field to return it in).
 *
 *  This file used to stamp the first onto the second. An app that took EUR two
 *  years ago and USD only in the last thirty days produced a single-currency
 *  window, NO `mixedCurrencies` warning, and a lifetime tile reading
 *  "1,234,567.89 USD" over a sum of USD + EUR + GBP — on the first screen after
 *  login. Nothing on the page contradicted it, and a reader cannot spot it: it is
 *  not a missing figure, it is a present one wearing a unit it never had.
 *
 *  So the rule, and it is the same rule `partnerAppRead.types` states for the
 *  window: A TOTAL OVER UNLIKE UNITS CARRIES NO UNIT. There is no FX table
 *  anywhere in this build on purpose — a wrong rate produces a plausible wrong
 *  number — and inheriting a neighbouring tile's label is the same lie for free.
 *  The lifetime figure renders BARE, with a line under it saying why, so the
 *  reader does not silently borrow the unit from the tile above.
 *
 *  ⚠️ THAT LINE IS NOT A SUBSTITUTE FOR THE FIELD. The honest fix lives in the
 *  service: publish `all_time.currency` (null when the history spans more than
 *  one) and an all-time counterpart to `mixedCurrencies`, then label off those.
 *  Until it exists this component cannot know the unit, and a component that does
 *  not know a unit must not print one.
 *
 *  ── EVERY UNKNOWN IS AN EM DASH, NEVER A ZERO ───────────────────────────────
 *  `counts`, `revenue` and `all_time` are three independently-nulled blocks —
 *  `counts_measurable`, `revenue_measurable` and `all_time_measurable` fail
 *  separately — and the service nulls each as a whole object, never field by
 *  field. The `|| {}` defaults below therefore yield `undefined` per field, which
 *  formats to "—". A `|| 0` anywhere in this file would turn "we did not measure
 *  this" into "the business earned nothing", which is the failure this project
 *  exists to prevent.
 * =============================================================================
 */

/**
 * A count, or an em dash when it is unknown.
 *
 * `null` AND `undefined` BOTH MEAN UNKNOWN AND NEITHER IS ZERO. A measured empty window
 * genuinely publishes `0` and that 0 is printed as a 0; the dash is reserved for the figures the
 * service withheld.
 *
 * @param {Number|null} n - The figure.
 * @returns {String} The formatted count, or '—'.
 */
const _fmtNumber = (n) => {
    if (n === null || n === undefined) return '—';
    if (typeof n !== 'number') return String(n);
    return n.toLocaleString();
};

/**
 * A money figure, denominated ONLY when the caller can prove the unit.
 *
 * `currency` IS OMITTED, NOT GUESSED. Called with no second argument the amount renders bare —
 * which is the correct rendering of a total whose denomination this payload does not state. See the
 * file header: the window's currency does not describe the lifetime sum.
 *
 * @param {Number|null} amount - The figure.
 * @param {String} [currency] - The currency code, when and only when it denominates THIS amount.
 * @returns {String} The formatted amount, or '—'.
 */
const _fmtMoney = (amount, currency) => {
    if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '—';
    const a = Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return currency ? `${a} ${currency}` : a;
};

const Kpi = ({ label, value, sub, tone }) => (
    <Card>
        <BlockStack gap="100">
            <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
            <Text as="span" variant="heading2xl">{value}</Text>
            {sub ? (typeof sub === 'string' ? <Text as="span" variant="bodySm" tone={tone || 'subdued'}>{sub}</Text> : sub) : null}
        </BlockStack>
    </Card>
);

/**
 * KPI tiles for a partner app: rolling-window installs/uninstalls/revenue
 * + all-time install / estimated-active counts.
 *
 * @param {Object} props
 * @param {Object} props.kpi - shape returned by /partner-apps/:id/kpi
 */
const AppKpiCards = ({ kpi }) => {
    if (!kpi) return null;

    const periodLabel = kpi.period_label || (kpi.is_lifetime ? 'All time' : `Last ${kpi.period_days || 30} days`);
    const counts = kpi.counts || {};
    const allTime = kpi.all_time || {};
    const revenue = kpi.revenue || {};

    /**
     * NAMED FOR THE WINDOW IT DESCRIBES, AND USED NOWHERE ELSE.
     *
     * It was called `inferredCurrency` while it was being stamped onto the lifetime total, and the
     * name is half of why: an "inferred" currency sounds like something that applies generally. It
     * does not. It is measured over `kpi.window` alone, so it labels `kpi.revenue` alone.
     */
    const windowCurrency = revenue.currency || '';

    /**
     * Is there a lifetime figure to qualify?
     *
     * The caveat below is about a NUMBER THAT IS ON SCREEN. With `all_time_measurable` false the
     * tile shows an em dash, the service has already said why in `noLifetimeSync`, and explaining
     * the denomination of a figure nobody was given reads as a fault rather than as a caution.
     */
    const lifetimeRevenueShown = allTime.gross_revenue !== null && allTime.gross_revenue !== undefined;

    return (
        <BlockStack gap="300">
            <Text as="h3" variant="headingMd">{periodLabel}</Text>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
                <Kpi label="Installs" value={_fmtNumber(counts.installs)} />
                <Kpi label="Uninstalls" value={_fmtNumber(counts.uninstalls)} />
                <Kpi label="Reinstalls" value={_fmtNumber(counts.reinstalls)} />
                {/* The window's own figures, and the only tile entitled to the window's currency.
                    When the payouts in it spanned more than one, the service sends `currency: null`
                    and raises `mixedCurrencies`; both the label and the amount then render bare. */}
                <Kpi label={`Gross revenue${windowCurrency ? ` (${windowCurrency})` : ''}`} value={_fmtMoney(revenue.gross_total, windowCurrency)} sub={`${_fmtNumber(revenue.transaction_count)} transactions`} />
            </InlineGrid>
            <Text as="h3" variant="headingMd">All-time</Text>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
                <Kpi label="Total installs" value={_fmtNumber(allTime.installs)} />
                <Kpi label="Total uninstalls" value={_fmtNumber(allTime.uninstalls)} />
                <Kpi
                    label="Estimated active"
                    value={_fmtNumber(allTime.estimated_active)}
                    sub={<Badge tone="info">estimate</Badge>}
                />
                <Kpi
                    label="Lifetime gross revenue"
                    /* NO CURRENCY ARGUMENT, AND NOT AN OVERSIGHT — see the file header. This is a
                       currency-blind sum over the whole payout history; the window's code above
                       does not denominate it, and no other field on this payload does either. */
                    value={_fmtMoney(allTime.gross_revenue)}
                    sub={(
                        <BlockStack gap="050">
                            <Text as="span" variant="bodySm" tone="subdued">
                                {`${_fmtNumber(allTime.transaction_count)} transactions`}
                            </Text>
                            {lifetimeRevenueShown ? (
                                <Text as="span" variant="bodySm" tone="subdued">
                                    Not denominated: summed across every payout on record, in whatever
                                    currencies those were. The currency on the period tiles above
                                    describes that window only.
                                </Text>
                            ) : null}
                        </BlockStack>
                    )}
                />
            </InlineGrid>
        </BlockStack>
    );
};

export default AppKpiCards;
