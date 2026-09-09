import { ButtonGroup, Button, Popover, DatePicker, BlockStack, InlineStack, Text } from '@shopify/polaris';
import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Shared date-range filter for every Growth-Intel page that supports time
 * windowing. Renders four presets plus a Custom popover.
 *
 * Behaviour:
 *   - Default value: { kind: 'preset', preset: 30 } (last 30 days).
 *   - Selecting a preset persists immediately.
 *   - Selecting Custom opens a DatePicker popover; the selected range only
 *     persists when Apply is clicked.
 *   - When `storageKey` is provided, the selection survives reloads + back/
 *     forth navigation via window.localStorage.
 *
 * The companion `useDateRangeState` hook exposes a `params` object you can
 * spread directly into API service calls — emits `{ period_days }` for presets
 * or `{ since, until }` (ISO yyyy-mm-dd) for custom.
 */

const PRESETS = [
    { label: 'All time', value: 'all' },
    { label: '1 year', value: 365 },
    { label: '90 days', value: 90 },
    { label: '30 days', value: 30 }
];

export const DEFAULT_DATE_RANGE = { kind: 'preset', preset: 30 };

/**
 * Convert a DateRangeFilter value into a "months of history" integer for the
 * backend services that bucket by month (logoChurn, revenueChurn, trialTrend,
 * revenueOverview). Caps at 36 so the trend chart never exceeds the service
 * limit. Rounds up so a 90-day window asks for 3 monthly buckets, not 2.
 */
export const dateRangeSpanDays = (value) => {
    if (!value || value.kind !== 'custom' || !value.from || !value.to) return null;
    // UTC, AND EVERY CALLER MUST USE THIS ONE. `new Date('2026-03-01')` parses an ISO date-only
    // string as UTC midnight; `new Date(2026, 2, 1)` parses it as LOCAL midnight. A caller that
    // rolled its own local parse and compared it against the months derived here disagreed by a day
    // across a DST boundary — and the screen then printed a sentence contradicting its own
    // arithmetic ("those 31 days become 1 whole calendar month"). One derivation, so they cannot.
    const a = new Date(value.from);
    const b = new Date(value.to);
    return Math.max(1, Math.ceil((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000)));
};

export const dateRangeToMonths = (value) => {
    if (!value) return 12;
    const days = dateRangeSpanDays(value);
    if (days !== null) {
        return Math.min(36, Math.max(1, Math.ceil(days / 30)));
    }
    if (value.preset === 'all') return 36;
    if (value.preset === 365) return 12;
    if (value.preset === 90) return 3;
    if (value.preset === 30) return 1;
    return Math.max(1, Math.min(36, Math.ceil((value.preset || 30) / 30)));
};

const _today = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
};

const _isoDateOnly = (d) => {
    if (!d) return '';
    if (typeof d === 'string') return d.slice(0, 10);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
};

const _parseIsoDateOnly = (s) => {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};

const _fmtPretty = (iso) => {
    const d = _parseIsoDateOnly(iso);
    if (!d) return iso;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const _isValidValue = (v) => {
    if (!v || typeof v !== 'object') return false;
    if (v.kind === 'preset') {
        return v.preset === 'all' || v.preset === 365 || v.preset === 90 || v.preset === 30;
    }
    if (v.kind === 'custom') {
        return !!(v.from && v.to && _parseIsoDateOnly(v.from) && _parseIsoDateOnly(v.to));
    }
    return false;
};

/**
 * Hook that owns the date-range value, hydrates/persists it via localStorage,
 * and exposes a ready-to-spread `params` object for API calls.
 *
 * @param {Object} opts
 * @param {String} [opts.storageKey] - localStorage key. Omit to skip persistence.
 * @param {Object} [opts.defaultValue=DEFAULT_DATE_RANGE]
 */
export const useDateRangeState = ({ storageKey, defaultValue = DEFAULT_DATE_RANGE } = {}) => {
    const [value, setValue] = useState(defaultValue);
    const [hydrated, setHydrated] = useState(false);

    useEffect(() => {
        if (typeof window === 'undefined' || !storageKey) {
            setHydrated(true);
            return;
        }
        try {
            const raw = window.localStorage.getItem(storageKey);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (_isValidValue(parsed)) {
                    setValue(parsed);
                }
            }
        } catch (e) {
            // Ignore corrupt cache.
        }
        setHydrated(true);
    }, [storageKey]);

    const update = useCallback((next) => {
        if (!_isValidValue(next)) return;
        setValue(next);
        if (typeof window !== 'undefined' && storageKey) {
            try {
                window.localStorage.setItem(storageKey, JSON.stringify(next));
            } catch (e) {
                // Storage may be full or blocked — UI still works without persistence.
            }
        }
    }, [storageKey]);

    const params = useMemo(() => {
        if (value.kind === 'custom') {
            return { since: value.from, until: value.to };
        }
        return { period_days: value.preset };
    }, [value]);

    const label = useMemo(() => {
        if (value.kind === 'custom') {
            return `${_fmtPretty(value.from)} → ${_fmtPretty(value.to)}`;
        }
        if (value.preset === 'all') return 'All time';
        if (value.preset === 365) return 'Last 1 year';
        if (value.preset === 90) return 'Last 90 days';
        if (value.preset === 30) return 'Last 30 days';
        return `Last ${value.preset} days`;
    }, [value]);

    return { value, set: update, params, label, hydrated };
};

const DateRangeFilter = ({ value, onChange }) => {
    const isCustom = value && value.kind === 'custom';
    const [popoverOpen, setPopoverOpen] = useState(false);
    const [pendingFrom, setPendingFrom] = useState(null);
    const [pendingTo, setPendingTo] = useState(null);
    const [{ month, year }, setVisibleMonth] = useState(() => {
        const d = _today();
        return { month: d.getMonth(), year: d.getFullYear() };
    });

    const openPopover = useCallback(() => {
        // Seed the picker with the current value if custom, else default to
        // last 30 days as a sensible starting span.
        if (isCustom) {
            setPendingFrom(_parseIsoDateOnly(value.from));
            setPendingTo(_parseIsoDateOnly(value.to));
            const start = _parseIsoDateOnly(value.from) || _today();
            setVisibleMonth({ month: start.getMonth(), year: start.getFullYear() });
        } else {
            const to = _today();
            const from = new Date(to);
            from.setDate(from.getDate() - 29);
            setPendingFrom(from);
            setPendingTo(to);
            setVisibleMonth({ month: from.getMonth(), year: from.getFullYear() });
        }
        setPopoverOpen(true);
    }, [isCustom, value]);

    const handleApply = useCallback(() => {
        if (!pendingFrom || !pendingTo) return;
        const from = pendingFrom <= pendingTo ? pendingFrom : pendingTo;
        const to = pendingFrom <= pendingTo ? pendingTo : pendingFrom;
        onChange({
            kind: 'custom',
            from: _isoDateOnly(from),
            to: _isoDateOnly(to)
        });
        setPopoverOpen(false);
    }, [pendingFrom, pendingTo, onChange]);

    const customButtonLabel = useMemo(() => {
        if (isCustom) return `${_fmtPretty(value.from)} → ${_fmtPretty(value.to)}`;
        return 'Custom';
    }, [isCustom, value]);

    return (
        <ButtonGroup variant="segmented">
            {PRESETS.map((opt) => (
                <Button
                    key={String(opt.value)}
                    pressed={!isCustom && value && value.preset === opt.value}
                    onClick={() => onChange({ kind: 'preset', preset: opt.value })}
                >
                    {opt.label}
                </Button>
            ))}
            <Popover
                active={popoverOpen}
                onClose={() => setPopoverOpen(false)}
                preferredAlignment="right"
                activator={
                    <Button pressed={isCustom} onClick={openPopover} disclosure>
                        {customButtonLabel}
                    </Button>
                }
            >
                <div style={{ padding: 16, width: 360 }}>
                    <BlockStack gap="300">
                        <Text as="h4" variant="headingSm">Custom date range</Text>
                        <DatePicker
                            month={month}
                            year={year}
                            onMonthChange={(m, y) => setVisibleMonth({ month: m, year: y })}
                            selected={pendingFrom && pendingTo ? { start: pendingFrom, end: pendingTo } : undefined}
                            onChange={({ start, end }) => {
                                setPendingFrom(start);
                                setPendingTo(end);
                            }}
                            allowRange
                            disableDatesAfter={_today()}
                        />
                        {pendingFrom && pendingTo ? (
                            <Text as="p" variant="bodySm" tone="subdued">
                                {`${_fmtPretty(_isoDateOnly(pendingFrom))} → ${_fmtPretty(_isoDateOnly(pendingTo))}`}
                            </Text>
                        ) : (
                            <Text as="p" variant="bodySm" tone="subdued">Pick a start and end date.</Text>
                        )}
                        <InlineStack align="end" gap="200">
                            <Button onClick={() => setPopoverOpen(false)}>Cancel</Button>
                            <Button variant="primary" onClick={handleApply} disabled={!pendingFrom || !pendingTo}>
                                Apply
                            </Button>
                        </InlineStack>
                    </BlockStack>
                </div>
            </Popover>
        </ButtonGroup>
    );
};

export default DateRangeFilter;
