import { BlockStack, InlineStack, Text, Button, Popover, Checkbox, Scrollable, Banner, Tooltip, Divider, Box } from '@shopify/polaris';
import { cardShell } from './cardShell';
import { useMeasuredWidth } from './useMeasuredWidth';
import { ArrowUpIcon, ArrowDownIcon } from '@shopify/polaris-icons';
import { useCallback, useMemo, useState } from 'react';
import { buildGeometry, PLOT_HEIGHT, AXIS_LEFT, AXIS_RIGHT } from './funnelScale';

/**
 * Shopify-Partner-style acquisition funnel.
 *
 * Vertical bars on a LOG scale with wedge connectors, per-step conversion
 * badges and a headline conversion rate — the same reading as the Partner
 * dashboard funnel, rendered in light Polaris to match the rest of the dashboard.
 *
 * Hand-rolled SVG rather than recharts: a log-scale bar chart with trapezoid
 * connectors, value labels above bars and percentage chips between the ticks is
 * a fight against recharts' layout, and the sibling ConversionFunnelChart is
 * already hand-rolled for the same reason.
 */

const FALLBACK_WIDTH = 960;

const COLORS = {
    barTop: '#8B5CF6',
    barBottom: '#A78BFA',
    connector: 'rgba(139, 92, 246, 0.10)',
    grid: '#E3E3E3',
    axisText: '#616161',
    valueText: '#303030'
};

const _fmtNum = (n) => {
    if (typeof n !== 'number' || Number.isNaN(n)) return '—';
    return n.toLocaleString();
};

const _fmtPct = (n) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return `${(Number(n) * 100).toFixed(1)}%`;
};

const _fmtHeadline = (n) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return `${(Number(n) * 100).toFixed(2)}%`;
};

const _tickLabel = (v) => {
    if (v >= 1000000) return `${v / 1000000}M`;
    if (v >= 1000) return `${v / 1000}K`;
    return String(v);
};

// Display metadata only. The group LIST is derived from whatever sources the
// backend catalog actually contains — hardcoding it here meant the backend's
// `subscription` source (6 catalog entries, including both trial steps) rendered
// no checkboxes at all, so those steps could not be selected or deselected.
// A source missing from this map still renders, under its raw name.
const SOURCE_META = {
    ga4: { title: 'Listing analytics (GA4)', note: 'Counted per visitor' },
    partner: { title: 'Partner API events', note: 'Counted per shop' },
    subscription: { title: 'Subscription lifecycle', note: 'Counted per subscription, dated from the charge the merchant approved' },
    transaction: { title: 'Payouts', note: 'Counted per shop' }
};

// Funnel-reading order: audience, then relationship, then money.
const SOURCE_ORDER = ['ga4', 'partner', 'subscription', 'transaction'];

const _sourceRank = (source) => {
    const i = SOURCE_ORDER.indexOf(source);
    if (i === -1) {
        return SOURCE_ORDER.length;
    }
    return i;
};

const PartnerFunnelChart = ({ data, loading, onChangeEvents, bare = false }) => {
    const wrap = cardShell(bare);
    // Attached by NODE lifecycle, not component mount. The measured div below exists only in this
    // component's populated return path, and the parent initialises `loading` to false with null
    // data — so on a first page load the early return at the bottom of this function renders first
    // and a mount-time effect would find no node, bail out, and (with `[]` deps) never look again.
    // That left `width` frozen at FALLBACK_WIDTH for the whole mount: the SVG letterboxed inside its
    // element and the absolutely-positioned HTML label layer, which reads the same `width` in raw
    // px, drifted off its bars. A tab switch appeared to fix it only because that remounts with data
    // already present. See useMeasuredWidth for the full account.
    const [width, measureRef] = useMeasuredWidth(FALLBACK_WIDTH);
    const [pickerOpen, setPickerOpen] = useState(false);

    const steps = useMemo(() => {
        if (data && Array.isArray(data.steps)) return data.steps;
        return [];
    }, [data]);

    const catalog = useMemo(() => {
        if (data && Array.isArray(data.catalog)) return data.catalog;
        return [];
    }, [data]);

    const selectedKeys = useMemo(() => steps.map((s) => s.key), [steps]);
    const maxEvents = (data && data.max_events) || 10;

    // Derived from the catalog, never hardcoded — a source the backend adds shows
    // up here automatically instead of silently having no checkboxes.
    const sourceGroups = useMemo(() => {
        const present = [...new Set(catalog.map((c) => c.source).filter(Boolean))];
        present.sort((a, b) => _sourceRank(a) - _sourceRank(b));
        return present.map((source) => {
            const meta = SOURCE_META[source] || {};
            return { source, title: meta.title || source, note: meta.note || '' };
        });
    }, [catalog]);

    // The trial cohort's own figures, independent of which steps are selected —
    // so the honest trial-to-paid rate is readable even when the funnel's first
    // step is a GA4 visitor count and the headline rate crosses the seam.
    const trialCohort = useMemo(() => {
        if (data && data.trial_cohort) return data.trial_cohort;
        return null;
    }, [data]);

    const windowKpi = useMemo(() => {
        if (data && data.window_kpi) return data.window_kpi;
        return null;
    }, [data]);

    const warnings = useMemo(() => {
        if (data && Array.isArray(data.warnings)) return data.warnings;
        return [];
    }, [data]);

    // How many trial lengths were READ from the merchant's charge versus inferred.
    // Surfaced because an inferred trial moves the conversion date, and a run of
    // them is the first symptom of the charge-id join failing.
    const trialSourcing = useMemo(() => {
        const d = data && data.diagnostics;
        if (!d || !d.charge_link) return '';
        const resolved = Number(d.charge_link.resolved) || 0;
        const total = resolved + (Number(d.charge_link.unresolved) || 0) + (Number(d.charge_link.absent) || 0);
        if (total === 0) return '';
        let msg = `Trial length read from the merchant's own charge for ${resolved} of ${total} subscription${total === 1 ? '' : 's'}`;
        const inferred = total - resolved;
        if (inferred > 0) {
            msg += `; ${inferred} inferred from the plan or a default`;
        }
        return `${msg}.`;
    }, [data]);

    const geometry = useMemo(() => buildGeometry({ steps, width }), [steps, width]);

    const applySelection = useCallback((nextKeys) => {
        if (typeof onChangeEvents === 'function') {
            onChangeEvents(nextKeys);
        }
    }, [onChangeEvents]);

    const toggleEvent = useCallback((key, checked) => {
        let next = selectedKeys.slice();
        if (checked) {
            if (next.includes(key) || next.length >= maxEvents) {
                return;
            }
            next.push(key);
        } else {
            // A funnel needs at least two steps to mean anything.
            if (next.length <= 2) {
                return;
            }
            next = next.filter((k) => k !== key);
        }
        applySelection(next);
    }, [selectedKeys, maxEvents, applySelection]);

    const moveEvent = useCallback((key, delta) => {
        const idx = selectedKeys.indexOf(key);
        const target = idx + delta;
        if (idx < 0 || target < 0 || target >= selectedKeys.length) {
            return;
        }
        const next = selectedKeys.slice();
        next[idx] = next[target];
        next[target] = key;
        applySelection(next);
    }, [selectedKeys, applySelection]);

    const orderedSelection = useMemo(
        () => selectedKeys.map((k) => catalog.find((c) => c.key === k)).filter(Boolean),
        [selectedKeys, catalog]
    );

    const picker = (
        <Popover
            active={pickerOpen}
            onClose={() => setPickerOpen(false)}
            preferredAlignment="right"
            activator={(
                <Button disclosure onClick={() => setPickerOpen((v) => !v)}>
                    {`${selectedKeys.length} funnel event${selectedKeys.length === 1 ? '' : 's'}`}
                </Button>
            )}
        >
            <div style={{ width: 340 }}>
                <Box padding="300">
                    <BlockStack gap="150">
                        <Text as="h4" variant="headingSm">Funnel steps, in order</Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                            Order decides each step&apos;s conversion. Up to {maxEvents} steps.
                        </Text>
                    </BlockStack>
                </Box>
                <Divider />
                <Box padding="200">
                    <BlockStack gap="100">
                        {orderedSelection.map((entry, idx) => (
                            <InlineStack key={entry.key} align="space-between" blockAlign="center" wrap={false}>
                                <InlineStack gap="150" blockAlign="center" wrap={false}>
                                    <Text as="span" variant="bodySm" tone="subdued">{idx + 1}</Text>
                                    <Text as="span" variant="bodySm">{entry.label}</Text>
                                </InlineStack>
                                <InlineStack gap="050" blockAlign="center" wrap={false}>
                                    <Button
                                        size="micro"
                                        variant="tertiary"
                                        icon={ArrowUpIcon}
                                        disabled={idx === 0}
                                        onClick={() => moveEvent(entry.key, -1)}
                                        accessibilityLabel={`Move ${entry.label} earlier`}
                                    />
                                    <Button
                                        size="micro"
                                        variant="tertiary"
                                        icon={ArrowDownIcon}
                                        disabled={idx === orderedSelection.length - 1}
                                        onClick={() => moveEvent(entry.key, 1)}
                                        accessibilityLabel={`Move ${entry.label} later`}
                                    />
                                </InlineStack>
                            </InlineStack>
                        ))}
                    </BlockStack>
                </Box>
                <Divider />
                <Scrollable style={{ maxHeight: 300 }}>
                    <Box padding="300">
                        <BlockStack gap="300">
                            {sourceGroups.map((group) => {
                                const entries = catalog.filter((c) => c.source === group.source);
                                if (entries.length === 0) return null;
                                return (
                                    <BlockStack key={group.source} gap="100">
                                        <BlockStack gap="050">
                                            <Text as="h5" variant="headingXs">{group.title}</Text>
                                            <Text as="span" variant="bodyXs" tone="subdued">{group.note}</Text>
                                        </BlockStack>
                                        {entries.map((entry) => {
                                            const checked = selectedKeys.includes(entry.key);
                                            const atCap = !checked && selectedKeys.length >= maxEvents;
                                            const isLastPair = checked && selectedKeys.length <= 2;
                                            return (
                                                <Checkbox
                                                    key={entry.key}
                                                    label={entry.label}
                                                    checked={checked}
                                                    disabled={atCap || isLastPair}
                                                    onChange={(v) => toggleEvent(entry.key, v)}
                                                />
                                            );
                                        })}
                                    </BlockStack>
                                );
                            })}
                        </BlockStack>
                    </Box>
                </Scrollable>
            </div>
        </Popover>
    );

    const header = (
        <InlineStack align="space-between" blockAlign="start" wrap>
            <BlockStack gap="050">
                <Text as="span" variant="bodySm" tone="subdued">Conversion rate</Text>
                <Text as="p" variant="heading2xl">{_fmtHeadline(data && data.conversion_rate)}</Text>
                {steps.length >= 2 ? (
                    <Text as="span" variant="bodySm" tone="subdued">
                        {`${steps[0].label} → ${steps[steps.length - 1].label}${data && data.period_label ? ` • ${data.period_label}` : ''}`}
                    </Text>
                ) : null}
            </BlockStack>
            {picker}
        </InlineStack>
    );

    if (!loading && steps.length === 0) {
        return wrap(
                <BlockStack gap="300">
                    <Text as="h3" variant="headingMd">Conversion funnel</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                        No funnel data for this window yet — run a sync to populate GA4 and Partner events.
                    </Text>
                </BlockStack>
        );
    }

    return wrap(
            <BlockStack gap="400">
                {header}

                <div ref={measureRef} style={{ width: '100%', opacity: loading ? 0.5 : 1, transition: 'opacity 150ms ease-out' }}>
                    <svg width="100%" height={PLOT_HEIGHT} viewBox={`0 0 ${width} ${PLOT_HEIGHT}`} role="img" aria-label="Conversion funnel">
                        <defs>
                            <linearGradient id="giFunnelBar" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={COLORS.barTop} />
                                <stop offset="100%" stopColor={COLORS.barBottom} />
                            </linearGradient>
                        </defs>

                        {geometry.ticks.map((t) => {
                            const y = geometry.yFor(t);
                            return (
                                <g key={t}>
                                    <line x1={AXIS_LEFT} y1={y} x2={width - AXIS_RIGHT} y2={y} stroke={COLORS.grid} strokeWidth="1" />
                                    <text x={AXIS_LEFT - 10} y={y + 4} textAnchor="end" fontSize="11" fill={COLORS.axisText}>
                                        {_tickLabel(t)}
                                    </text>
                                </g>
                            );
                        })}

                        {/* Wedges first so bars paint over them. */}
                        {geometry.bars.map((bar, i) => {
                            const next = geometry.bars[i + 1];
                            if (!next) return null;
                            const x1 = bar.x + geometry.barWidth;
                            const x2 = next.x;
                            if (x2 <= x1) return null;
                            const pts = `${x1},${bar.top} ${x2},${next.top} ${x2},${geometry.baseline} ${x1},${geometry.baseline}`;
                            return <polygon key={`w-${bar.step.key}`} points={pts} fill={COLORS.connector} />;
                        })}

                        {geometry.bars.map((bar) => (
                            <g key={bar.step.key}>
                                {bar.height > 0 ? (
                                    <rect
                                        x={bar.x}
                                        y={bar.top}
                                        width={geometry.barWidth}
                                        height={bar.height}
                                        rx="3"
                                        fill="url(#giFunnelBar)"
                                    />
                                ) : null}
                                <text
                                    x={bar.centre}
                                    y={bar.top - 9}
                                    textAnchor="middle"
                                    fontSize="13"
                                    fontWeight="600"
                                    fill={COLORS.valueText}
                                >
                                    {_fmtNum(bar.step.count)}
                                </text>
                            </g>
                        ))}

                        <line
                            x1={AXIS_LEFT}
                            y1={geometry.baseline}
                            x2={width - AXIS_RIGHT}
                            y2={geometry.baseline}
                            stroke={COLORS.grid}
                            strokeWidth="1"
                        />
                    </svg>

                    {/* Step labels + between-step conversion chips, laid out on the same
                        slot grid as the bars so they stay aligned at any width. */}
                    <div style={{ position: 'relative', height: 46, marginTop: 2 }}>
                        {geometry.bars.map((bar) => (
                            <div
                                key={`l-${bar.step.key}`}
                                style={{
                                    position: 'absolute',
                                    left: bar.slotStart,
                                    width: geometry.slot,
                                    textAlign: 'center',
                                    padding: '0 4px',
                                    boxSizing: 'border-box'
                                }}
                            >
                                <Text as="span" variant="bodySm">{bar.step.label}</Text>
                            </div>
                        ))}
                        {geometry.bars.map((bar, i) => {
                            const next = geometry.bars[i + 1];
                            if (!next) return null;
                            const chipCentre = (bar.centre + next.centre) / 2;
                            const step = next.step;

                            // Three readings, three treatments. Written out rather
                            // than nested inline so the seam case and the maturity
                            // case can never be confused for each other.
                            let tooltip = `${_fmtNum(step.count)} of ${_fmtNum(bar.step.count)} continued from ${bar.step.label}.`;
                            let marker = '';
                            let chipStyle = { background: '#F1F1F1', color: '#616161', border: '1px solid transparent' };

                            if (step.rate_basis === 'decided') {
                                // Denominator excludes shops that could not yet have
                                // converted. Say so, and say how many were excluded —
                                // otherwise this looks like a plain step ratio that
                                // happens not to add up.
                                tooltip = `${_fmtNum(step.count)} of ${_fmtNum(step.rate_denominator)} subscriptions that reached the end of their trial converted.`;
                                if (step.undecided > 0) {
                                    tooltip += ` ${_fmtNum(step.undecided)} more are still inside their trial and are excluded from both sides of this rate — counting them as failures would understate it.`;
                                }
                                marker = ' †';
                                chipStyle = { background: '#EDF7F0', color: '#0C5132', border: '1px solid #B5DFC5' };
                            } else if (step.unit_change) {
                                let fromUnit = 'shops';
                                if (bar.step.unit === 'events') {
                                    fromUnit = 'visitor events';
                                }
                                let toUnit = 'shops';
                                if (step.unit === 'events') {
                                    toUnit = 'visitor events';
                                }
                                tooltip = `${_fmtPct(step.conversion_pct)} — ratio across different populations (${fromUnit} → ${toUnit}), not a true step conversion.`;
                                marker = ' *';
                                chipStyle = { background: '#FFF1E3', color: '#5E4200', border: '1px solid #FFD79D' };
                            }

                            return (
                                <div
                                    key={`p-${step.key}`}
                                    style={{
                                        position: 'absolute',
                                        left: chipCentre - 40,
                                        top: 22,
                                        width: 80,
                                        textAlign: 'center'
                                    }}
                                >
                                    <Tooltip content={tooltip}>
                                        <span
                                            style={{
                                                display: 'inline-block',
                                                padding: '1px 8px',
                                                borderRadius: 8,
                                                fontSize: 12,
                                                whiteSpace: 'nowrap',
                                                ...chipStyle
                                            }}
                                        >
                                            {_fmtPct(step.conversion_pct)}
                                            {marker}
                                        </span>
                                    </Tooltip>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {data && data.crosses_unit_seam ? (
                    <Banner tone="info">
                        <p>
                            Steps marked <strong>*</strong> cross a measurement seam: listing-analytics steps are GA4
                            hits counted per <strong>visitor</strong>, while Partner API steps are distinct{' '}
                            <strong>shops</strong>. Those percentages compare two different populations, so read them as
                            directional. A funnel built only from Partner API events avoids the seam entirely.
                        </p>
                    </Banner>
                ) : null}

                {trialCohort ? (
                    <>
                        <Divider />
                        <BlockStack gap="200">
                            <InlineStack gap="600" wrap>
                                <BlockStack gap="050">
                                    <Text as="span" variant="bodyXs" tone="subdued">Trials started</Text>
                                    <Text as="p" variant="headingMd">{_fmtNum(trialCohort.trial_started)}</Text>
                                </BlockStack>
                                <BlockStack gap="050">
                                    <Text as="span" variant="bodyXs" tone="subdued">Still in trial</Text>
                                    <Text as="p" variant="headingMd">{_fmtNum(trialCohort.still_on_trial)}</Text>
                                </BlockStack>
                                <BlockStack gap="050">
                                    <Text as="span" variant="bodyXs" tone="subdued">Converted</Text>
                                    <Text as="p" variant="headingMd">{_fmtNum(trialCohort.trial_converted)}</Text>
                                </BlockStack>
                                <BlockStack gap="050">
                                    <Text as="span" variant="bodyXs" tone="subdued">Trial-to-paid rate</Text>
                                    <Text as="p" variant="headingMd">{_fmtHeadline(trialCohort.conversion_rate)}</Text>
                                    <Text as="span" variant="bodyXs" tone="subdued">
                                        {`of ${_fmtNum(trialCohort.decided)} decided`}
                                    </Text>
                                </BlockStack>
                                {windowKpi ? (
                                    <BlockStack gap="050">
                                        <Text as="span" variant="bodyXs" tone="subdued">Conversions this period</Text>
                                        <Text as="p" variant="headingMd">{_fmtNum(windowKpi.converted_in_window)}</Text>
                                        <Text as="span" variant="bodyXs" tone="subdued">any cohort</Text>
                                    </BlockStack>
                                ) : null}
                            </InlineStack>

                            <Text as="p" variant="bodyXs" tone="subdued">
                                Steps marked <strong>†</strong> exclude subscriptions still inside their trial from both
                                sides of the rate — they have not had the chance to convert yet, so counting them as
                                failures would understate it. <strong>Conversions this period</strong> is a different
                                question: every trial that ended in this window, whichever cohort it started in. It is
                                deliberately not a funnel step, because it draws from a different population than the
                                step above it.
                            </Text>

                            {trialSourcing ? (
                                <Text as="p" variant="bodyXs" tone="subdued">{trialSourcing}</Text>
                            ) : null}
                        </BlockStack>
                    </>
                ) : null}

                {warnings.length > 0 ? (
                    <Banner tone="warning">
                        <BlockStack gap="100">
                            {warnings.map((w) => (
                                <p key={w}>{w}</p>
                            ))}
                        </BlockStack>
                    </Banner>
                ) : null}
            </BlockStack>
    );
};

export default PartnerFunnelChart;
