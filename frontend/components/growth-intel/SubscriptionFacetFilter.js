import { Popover, Button, ChoiceList, BlockStack, InlineStack, Box, Divider, Scrollable, Text, TextField } from '@shopify/polaris';
import { FilterIcon } from '@shopify/polaris-icons';
import { useCallback, useState } from 'react';

/** Above this many options a group gets its own search box. Country ships ~100. */
const SEARCHABLE_THRESHOLD = 12;

/** Most choices rendered at once for a searched group — the rest are reachable by typing. */
const MAX_RENDERED_CHOICES = 60;

/**
 * Multi-select facet filter for a store list.
 *
 * One popover holding every facet group as a `ChoiceList allowMultiple`, so filters are COMBINED
 * rather than swapped: OR within a group, AND across groups, and an empty group imposes nothing.
 *
 * The option lists come from the server (`facet_groups` in the response) rather than being hardcoded
 * here — every option the server offers has a matching predicate on the server, so a checkbox can
 * never exist that the backend cannot evaluate.
 *
 * Deliberately NOT Polaris `IndexFilters`: it owns the tab row and unmounts it while filtering, so
 * opening the filters would hide the status counts this page exists to show — and its sort control
 * fuses key and direction, which would force a rewrite of the existing `sort`/`dir` params on both
 * client and server.
 *
 * @param {Object}   props
 * @param {Array}    props.groups   - [{ key, label, options: [{ value, label }] }] from the response.
 * @param {Object}   props.value    - { [groupKey]: string[] } currently selected.
 * @param {Function} props.onChange - (groupKey, nextArray) => void.
 * @param {Function} props.onClearAll
 */
const SubscriptionFacetFilter = ({ groups, value, onChange, onClearAll }) => {
    const [open, setOpen] = useState(false);
    // Per-group search text. Keyed by group so two large groups cannot share one box.
    const [queries, setQueries] = useState({});
    const allGroups = Array.isArray(groups) ? groups : [];

    /**
     * The choices to render for a group, after its search box.
     *
     *  Selected options are ALWAYS included, even when they do not match the query. Filtering them
     * out makes an applied filter look unapplied — you pick "United States", type "ind", and the US
     * checkbox vanishes while still constraining the table.
     */
    const visibleChoices = useCallback((group) => {
        const options = group.options || [];
        const selected = (value && value[group.key]) || [];
        const needle = String(queries[group.key] || '').trim().toLowerCase();

        let matched = options;
        if (needle) {
            matched = options.filter((o) => String(o.label || '').toLowerCase().includes(needle)
                || String(o.value || '').toLowerCase().includes(needle)
                || selected.includes(o.value));
        }

        // Never silently truncate: the caller renders the count of what was dropped.
        const shown = matched.slice(0, MAX_RENDERED_CHOICES);
        for (const option of options) {
            if (selected.includes(option.value) && !shown.some((o) => o.value === option.value)) {
                shown.push(option);
            }
        }
        return { shown, hidden: Math.max(matched.length - MAX_RENDERED_CHOICES, 0) };
    }, [value, queries]);

    let selectedCount = 0;
    for (const group of allGroups) {
        selectedCount += ((value && value[group.key]) || []).length;
    }

    const handleClearAll = useCallback(() => {
        onClearAll();
        // The popover stays OPEN: clearing is usually the first step of building a different
        // combination, and closing would make the user reopen it to carry on.
    }, [onClearAll]);

    return (
        <Popover
            active={open}
            onClose={() => setOpen(false)}
            preferredAlignment="right"
            activator={(
                <Button
                    icon={FilterIcon}
                    disclosure
                    onClick={() => setOpen((v) => !v)}
                >
                    {selectedCount === 0 ? 'Filters' : `Filters (${selectedCount})`}
                </Button>
            )}
        >
            <div style={{ width: 300 }}>
                <Scrollable style={{ maxHeight: 380 }}>
                    <Box padding="300">
                        <BlockStack gap="400">
                            {allGroups.map((group, i) => {
                                const searchable = (group.options || []).length > SEARCHABLE_THRESHOLD;
                                const { shown, hidden } = visibleChoices(group);
                                return (
                                    <BlockStack gap="200" key={group.key}>
                                        {i > 0 ? <Divider /> : null}
                                        {searchable ? (
                                            <BlockStack gap="100">
                                                <Text as="span" variant="headingXs">{group.label}</Text>
                                                <TextField
                                                    label={`Search ${group.label}`}
                                                    labelHidden
                                                    placeholder={`Search ${(group.options || []).length} options`}
                                                    value={queries[group.key] || ''}
                                                    onChange={(v) => setQueries((prev) => ({ ...prev, [group.key]: v }))}
                                                    clearButton
                                                    onClearButtonClick={() => setQueries((prev) => ({ ...prev, [group.key]: '' }))}
                                                    autoComplete="off"
                                                />
                                            </BlockStack>
                                        ) : null}
                                        <ChoiceList
                                            title={group.label}
                                            titleHidden={searchable}
                                            allowMultiple
                                            choices={shown.map((o) => ({ label: o.label, value: o.value }))}
                                            selected={(value && value[group.key]) || []}
                                            onChange={(next) => onChange(group.key, next)}
                                        />
                                        {hidden > 0 ? (
                                            <Text as="span" variant="bodyXs" tone="subdued">
                                                {`${hidden} more — type to narrow`}
                                            </Text>
                                        ) : null}
                                        {searchable && shown.length === 0 ? (
                                            <Text as="span" variant="bodyXs" tone="subdued">No match</Text>
                                        ) : null}
                                    </BlockStack>
                                );
                            })}
                        </BlockStack>
                    </Box>
                </Scrollable>
                <Divider />
                <Box padding="300">
                    <InlineStack align="space-between" blockAlign="center">
                        <Text as="span" variant="bodySm" tone="subdued">
                            {selectedCount === 0 ? 'No filters applied' : `${selectedCount} applied`}
                        </Text>
                        <Button variant="plain" disabled={selectedCount === 0} onClick={handleClearAll}>
                            Clear all
                        </Button>
                    </InlineStack>
                </Box>
            </div>
        </Popover>
    );
};

export default SubscriptionFacetFilter;
