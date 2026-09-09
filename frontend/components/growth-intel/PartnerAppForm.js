import { Card, BlockStack, TextField, FormLayout, Button, InlineStack, Checkbox, Text } from '@shopify/polaris';
import { useCallback, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import LoaderContext from '../../contexts/loaderContext';
import GrowthIntelPartnerAppApiService from '../../API_Services/growth-intel/partnerAppService';
import { DASHBOARD_ROUTES } from '../../utils/dashboardRoutes';

const API = new GrowthIntelPartnerAppApiService();

const _emptyForm = {
    display_name: '',
    app_handle: '',
    listing_url: '',
    partner_api_app_id: '',
    categories: '',         // comma-separated; converted on submit
    target_keywords: '',    // comma-separated; converted on submit
    is_active: true
};

const _csvToArray = (s) => (s || '').split(',').map((t) => t.trim()).filter(Boolean);
const _arrayToCsv = (a) => Array.isArray(a) ? a.join(', ') : '';

/**
 * Reusable form for creating or editing a partner app.
 *
 * @param {Object} props
 * @param {Object} [props.initial] - Initial app values when editing (omit for create mode).
 * @param {String} [props.mode='create'] - 'create' or 'edit'.
 * @param {Function} [props.onSaved] - Called with the saved app doc after success.
 */
const PartnerAppForm = ({ initial, mode, onSaved }) => {
    const router = useRouter();
    const { showToast } = useContext(LoaderContext) || {};
    const _mode = mode || 'create';
    const _isEdit = _mode === 'edit';

    const [form, setForm] = useState(_emptyForm);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (initial) {
            setForm({
                display_name: initial.display_name || '',
                app_handle: initial.app_handle || '',
                listing_url: initial.listing_url || '',
                partner_api_app_id: initial.partner_api_app_id || '',
                categories: _arrayToCsv(initial.categories),
                target_keywords: _arrayToCsv(initial.target_keywords),
                is_active: typeof initial.is_active === 'boolean' ? initial.is_active : true
            });
        }
    }, [initial]);

    const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

    const handleSubmit = useCallback(() => {
        if (!form.display_name) { showToast && showToast('Display name is required.', true); return; }
        if (!form.app_handle) { showToast && showToast('App handle is required.', true); return; }
        if (!form.listing_url) { showToast && showToast('Listing URL is required.', true); return; }
        if (!_isEdit && !form.partner_api_app_id) { showToast && showToast('Partner API App ID is required.', true); return; }

        const body = {
            display_name: form.display_name.trim(),
            app_handle: form.app_handle.trim(),
            listing_url: form.listing_url.trim(),
            categories: _csvToArray(form.categories),
            target_keywords: _csvToArray(form.target_keywords),
            is_active: !!form.is_active
        };
        if (!_isEdit) {
            body.partner_api_app_id = form.partner_api_app_id.trim();
        }

        setSaving(true);
        const cb = (resp) => {
            setSaving(false);
            if (!resp || resp.resource_access === 'NOT_ALLOWED') {
                showToast && showToast('Permission denied. Please log in as super admin.', true);
                return;
            }
            if (!resp.status) {
                showToast && showToast(resp.msg || 'Save failed.', true);
                return;
            }
            const savedApp = resp.data && resp.data.app;
            showToast && showToast(_isEdit ? 'Partner app updated.' : 'Partner app created.', false);
            if (typeof onSaved === 'function') {
                try { onSaved(savedApp); } catch (e) { console.error('onSaved error', e); }
            } else if (savedApp && savedApp.app_id) {
                router.push(`${DASHBOARD_ROUTES.APPS}/${savedApp.app_id}`);
            }
        };

        if (_isEdit && initial && initial.app_id) {
            API.update(initial.app_id, body, cb);
        } else {
            API.create(body, cb);
        }
    }, [form, _isEdit, initial, onSaved, router, showToast]);

    return (
        <Card>
            <BlockStack gap="400">
                <Text as="h3" variant="headingMd">{_isEdit ? 'Edit partner app' : 'Add partner app'}</Text>
                <FormLayout>
                    <TextField
                        label="Display name"
                        value={form.display_name}
                        onChange={set('display_name')}
                        autoComplete="off"
                        requiredIndicator
                        helpText="Friendly label shown across dashboards."
                    />
                    <TextField
                        label="App handle"
                        value={form.app_handle}
                        onChange={set('app_handle')}
                        autoComplete="off"
                        requiredIndicator
                        helpText="App store URL slug (e.g. 'my-app-handle')."
                    />
                    <TextField
                        label="App Store listing URL"
                        value={form.listing_url}
                        onChange={set('listing_url')}
                        autoComplete="off"
                        requiredIndicator
                        type="url"
                    />
                    <TextField
                        label="Shopify Partner API App ID"
                        value={form.partner_api_app_id}
                        onChange={set('partner_api_app_id')}
                        autoComplete="off"
                        requiredIndicator={!_isEdit}
                        disabled={_isEdit}
                        helpText={_isEdit
                            ? 'Immutable. Re-create the entry to change this.'
                            : 'Format: gid://partners/App/<numericId>. You can also paste gid://shopify/App/<id> from the dashboard URL — we normalize it automatically.'}
                    />
                    <TextField
                        label="Categories"
                        value={form.categories}
                        onChange={set('categories')}
                        autoComplete="off"
                        helpText="Comma-separated, e.g. 'shipping, fulfillment'."
                    />
                    <TextField
                        label="Initial target keywords"
                        value={form.target_keywords}
                        onChange={set('target_keywords')}
                        autoComplete="off"
                        helpText="Comma-separated; we'll track ranks for these (Phase 4)."
                    />
                    <Checkbox
                        label="Active (sync this app)"
                        checked={!!form.is_active}
                        onChange={set('is_active')}
                    />
                </FormLayout>
                <InlineStack gap="200">
                    <Button variant="primary" loading={saving} disabled={saving} onClick={handleSubmit}>
                        {_isEdit ? 'Save changes' : 'Create partner app'}
                    </Button>
                    <Button onClick={() => router.push(DASHBOARD_ROUTES.APPS)}>Cancel</Button>
                </InlineStack>
            </BlockStack>
        </Card>
    );
};

export default PartnerAppForm;
