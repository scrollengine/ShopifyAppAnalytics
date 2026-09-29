import { useMemo } from 'react';
import { BlockStack, Checkbox, Text } from '@shopify/polaris';

import {
    BASELINE_PERMISSION,
    groupOfferableCatalogue,
    labelsFor,
    requiredByKeys,
    togglePermission
} from './permissionSelection';

/**
 * Permission checkboxes for a custom role, grouped the way the catalogue groups them.
 *
 * The selection rules live in `permissionSelection.js`; this component only renders them. A key
 * that another ticked key requires is shown ticked and disabled with the reason, rather than
 * silently re-ticking itself after an untick, so the effect of every click is visible.
 *
 * @param {Object} props - Component props.
 * @param {Array<Object>} props.catalogue - `PERMISSION_CATALOGUE` from GET /api/roles.
 * @param {Array<String>} props.value - The current selection (already normalised).
 * @param {Function} props.onChange - Receives the next selection.
 * @param {Boolean} [props.disabled] - Locks every checkbox (while saving).
 * @returns {JSX.Element}
 */
const PermissionPicker = ({ catalogue, value, onChange, disabled }) => {
    const groups = useMemo(() => groupOfferableCatalogue(catalogue), [catalogue]);
    const selected = Array.isArray(value) ? value : [];

    return (
        <BlockStack gap="400">
            {groups.map((group) => (
                <BlockStack gap="200" key={group.group}>
                    <Text as="h3" variant="headingSm">{group.group}</Text>
                    {group.entries.map((entry) => {
                        const isBaseline = entry.key === BASELINE_PERMISSION;
                        const dependents = requiredByKeys(entry.key, selected, catalogue);
                        const requires = Array.isArray(entry.requires) ? entry.requires : [];

                        let lockReason = '';
                        if (isBaseline) {
                            lockReason = 'Every role holds this.';
                        } else if (dependents.length > 0) {
                            lockReason = `Required by ${labelsFor(dependents, catalogue).join(', ')}. Untick those first.`;
                        }

                        const help = (
                            <BlockStack gap="050">
                                {entry.description ? <Text as="span" variant="bodySm">{entry.description}</Text> : null}
                                {requires.length > 0 ? (
                                    <Text as="span" variant="bodySm" tone="subdued">
                                        {`Requires ${labelsFor(requires, catalogue).join(', ')} (ticked automatically).`}
                                    </Text>
                                ) : null}
                                {lockReason ? <Text as="span" variant="bodySm" tone="subdued">{lockReason}</Text> : null}
                            </BlockStack>
                        );

                        return (
                            <Checkbox
                                key={entry.key}
                                label={`${entry.label || entry.key} (${entry.key})`}
                                checked={isBaseline || selected.includes(entry.key)}
                                disabled={Boolean(disabled) || lockReason !== ''}
                                helpText={help}
                                onChange={(checked) => onChange(togglePermission(entry.key, checked, selected, catalogue))}
                            />
                        );
                    })}
                </BlockStack>
            ))}
        </BlockStack>
    );
};

export default PermissionPicker;
