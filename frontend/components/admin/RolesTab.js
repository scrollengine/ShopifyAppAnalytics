import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Badge,
    Banner,
    BlockStack,
    Button,
    Card,
    InlineStack,
    Modal,
    SkeletonBodyText,
    Text,
    TextField
} from '@shopify/polaris';

import UserAdminApiService from '../../API_Services/userAdminService';
import { PERMISSIONS } from '../../utils/permissions';
import useAdminSession from './useAdminSession';
import LoadFailureBanner from './LoadFailureBanner';
import PermissionPicker from './PermissionPicker';
import { normaliseSelection } from './permissionSelection';
import { errorCodeOf, failureMessage, permissionLabels } from './adminPresentation';

const API = new UserAdminApiService();

/** Server-side limits, mirrored so the form counts characters as the server will. */
const ROLE_NAME_MAX = 60;
const ROLE_DESCRIPTION_MAX = 280;

/**
 * "3 active, 1 disabled; 2 pending invitations" for a role, or '' when the payload has no counts.
 *
 * @param {Object} role - A RoleView.
 * @returns {String}
 */
const _usageLine = (role) => {
    const parts = [];
    const assigned = role.assigned_user_count;
    if (assigned && typeof assigned === 'object') {
        const active = typeof assigned.active === 'number' ? assigned.active : null;
        const disabled = typeof assigned.disabled === 'number' ? assigned.disabled : null;
        if (active !== null) {
            parts.push(`${active} active member${active === 1 ? '' : 's'}`);
        }
        if (disabled !== null && disabled > 0) {
            parts.push(`${disabled} disabled`);
        }
    } else if (typeof assigned === 'number') {
        parts.push(`${assigned} member${assigned === 1 ? '' : 's'}`);
    }
    let line = parts.join(', ');
    if (typeof role.pending_invite_count === 'number') {
        const pending = role.pending_invite_count;
        const invites = `${pending} pending invitation${pending === 1 ? '' : 's'}`;
        line = line ? `${line}; ${invites}` : invites;
    }
    return line;
};

/**
 * The Roles tab: built-in roles (read-only) and custom roles (create / edit / delete for
 * `roles:manage`, which only the owner holds).
 *
 * @returns {JSX.Element}
 */
const RolesTab = () => {
    const { can, refresh, noteForbidden } = useAdminSession();
    const canManageRoles = can(PERMISSIONS.ROLES_MANAGE);

    const [load, setLoad] = useState({ state: 'loading', roles: null, catalogue: null, failure: null });
    const [notice, setNotice] = useState(null);

    const [editor, setEditor] = useState(null);
    const [saving, setSaving] = useState(false);
    const [nameError, setNameError] = useState('');
    const [editorError, setEditorError] = useState('');

    const [deleteTarget, setDeleteTarget] = useState(null);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState('');

    const mountedRef = useRef(true);
    const loadSeqRef = useRef(0);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const loadRoles = useCallback(() => {
        loadSeqRef.current += 1;
        const seq = loadSeqRef.current;
        setLoad((prev) => ({ state: 'loading', roles: prev.roles, catalogue: prev.catalogue, failure: null }));
        API.listRoles().then((result) => {
            if (!mountedRef.current || seq !== loadSeqRef.current) {
                return;
            }
            if (result.status && Array.isArray(result.data.roles) && Array.isArray(result.data.catalogue)) {
                setLoad({ state: 'ready', roles: result.data.roles, catalogue: result.data.catalogue, failure: null });
                return;
            }
            noteForbidden(result);
            let failure = result;
            if (result.status) {
                failure = { status: false, msg: 'The server answered without the role list or the permission catalogue.', error: {}, http_status: result.http_status };
            }
            setLoad({ state: 'error', roles: null, catalogue: null, failure: failure });
        });
    }, [noteForbidden]);

    useEffect(() => {
        loadRoles();
    }, [loadRoles]);

    const catalogue = load.catalogue;

    const openCreate = useCallback(() => {
        setNameError('');
        setEditorError('');
        setEditor({ mode: 'create', role_id: '', name: '', description: '', permissions: normaliseSelection([], catalogue) });
    }, [catalogue]);

    const openEdit = useCallback((role) => {
        setNameError('');
        setEditorError('');
        setEditor({
            mode: 'edit',
            role_id: String(role.role_id),
            name: String(role.label || ''),
            description: String(role.description || ''),
            permissions: normaliseSelection(role.permissions, catalogue)
        });
    }, [catalogue]);

    const closeEditor = useCallback(() => {
        if (saving) {
            return;
        }
        setEditor(null);
    }, [saving]);

    const updateEditor = useCallback((field, value) => {
        setEditor((prev) => (prev ? Object.assign({}, prev, { [field]: value }) : prev));
        if (field === 'name') {
            setNameError('');
        }
    }, []);

    const submitEditor = useCallback(() => {
        if (!editor || saving) {
            return;
        }
        const body = {
            name: editor.name.trim(),
            description: editor.description.trim(),
            permissions: normaliseSelection(editor.permissions, catalogue)
        };
        if (!body.name) {
            setNameError('Give the role a name.');
            return;
        }
        setSaving(true);
        setNameError('');
        setEditorError('');
        let request = null;
        if (editor.mode === 'edit') {
            request = API.updateRole(editor.role_id, body);
        } else {
            request = API.createRole(body);
        }
        const mode = editor.mode;
        request.then((result) => {
            if (!mountedRef.current) {
                return;
            }
            setSaving(false);
            if (result.status) {
                const lines = [];
                const revoked = result.data.invites_revoked;
                if (typeof revoked === 'number' && revoked > 0) {
                    lines.push(`${revoked} pending invitation${revoked === 1 ? '' : 's'} ${revoked === 1 ? 'was' : 'were'} revoked, `
                        + 'because the sender can no longer grant this role as edited.');
                }
                setNotice({ tone: 'success', title: `Role "${body.name}" ${mode === 'edit' ? 'saved' : 'created'}`, lines: lines });
                setEditor(null);
                loadRoles();
                // A role's permissions are read per request; if the caller holds this role their own
                // permissions just changed, and the gated buttons must follow.
                refresh();
                return;
            }
            if (errorCodeOf(result) === 'ROLE_NAME_TAKEN') {
                setNameError(failureMessage(result, 'Another role already has this name.'));
                return;
            }
            noteForbidden(result);
            setEditorError(failureMessage(result, 'The role could not be saved.'));
        });
    }, [editor, saving, catalogue, loadRoles, refresh, noteForbidden]);

    const closeDelete = useCallback(() => {
        if (deleting) {
            return;
        }
        setDeleteTarget(null);
        setDeleteError('');
    }, [deleting]);

    const submitDelete = useCallback(() => {
        const role = deleteTarget;
        if (!role || deleting) {
            return;
        }
        setDeleting(true);
        setDeleteError('');
        API.deleteRole(role.role_id).then((result) => {
            if (!mountedRef.current) {
                return;
            }
            setDeleting(false);
            if (result.status) {
                setNotice({ tone: 'success', title: `Role "${role.label}" deleted`, lines: [] });
                setDeleteTarget(null);
                loadRoles();
                return;
            }
            noteForbidden(result);
            // ROLE_IN_USE: someone still holds it, or a live invitation offers it. The server's
            // message says which; the list is re-read so the counts beside the role catch up.
            setDeleteError(failureMessage(result, 'The role could not be deleted.'));
            if (errorCodeOf(result) === 'ROLE_IN_USE') {
                loadRoles();
            }
        });
    }, [deleteTarget, deleting, loadRoles, noteForbidden]);

    const renderRole = (role) => {
        const labels = permissionLabels(role.permissions, catalogue);
        const usage = _usageLine(role);
        const isCustom = !role.built_in;
        const key = isCustom ? `custom-${role.role_id}` : `builtin-${role.role_key}`;
        return (
            <Card key={key}>
                <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center" gap="200">
                        <InlineStack gap="200" blockAlign="center">
                            <Text as="h3" variant="headingSm">{role.label || role.role_key}</Text>
                            <Badge tone={isCustom ? 'info' : undefined}>{isCustom ? 'Custom' : 'Built-in'}</Badge>
                        </InlineStack>
                        {isCustom && canManageRoles ? (
                            <InlineStack gap="200">
                                <Button size="slim" onClick={() => openEdit(role)}>Edit</Button>
                                <Button
                                    size="slim"
                                    tone="critical"
                                    variant="plain"
                                    onClick={() => {
                                        setDeleteError('');
                                        setDeleteTarget(role);
                                    }}
                                >
                                    Delete
                                </Button>
                            </InlineStack>
                        ) : null}
                    </InlineStack>
                    {role.description ? <Text as="p" tone="subdued">{role.description}</Text> : null}
                    {usage ? <Text as="p" variant="bodySm">{usage}</Text> : null}
                    {labels.length > 0 ? (
                        <InlineStack gap="100">
                            {labels.map((entry) => <Badge key={entry.key}>{entry.label}</Badge>)}
                        </InlineStack>
                    ) : (
                        <Text as="p" variant="bodySm" tone="subdued">Holds no permissions.</Text>
                    )}
                </BlockStack>
            </Card>
        );
    };

    let body = null;
    if (load.roles === null && load.state === 'loading') {
        body = (
            <Card>
                <SkeletonBodyText lines={6} />
            </Card>
        );
    } else if (load.roles !== null) {
        const builtIn = load.roles.filter((role) => role && role.built_in);
        const custom = load.roles.filter((role) => role && !role.built_in);
        body = (
            <BlockStack gap="400">
                <BlockStack gap="200">
                    <Text as="h2" variant="headingMd">Built-in roles</Text>
                    <Text as="p" tone="subdued">Defined in the application and cannot be edited.</Text>
                    {builtIn.map(renderRole)}
                </BlockStack>
                <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                        <Text as="h2" variant="headingMd">Custom roles</Text>
                        {canManageRoles ? <Button variant="primary" onClick={openCreate}>Create custom role</Button> : null}
                    </InlineStack>
                    {canManageRoles ? null : (
                        <Text as="p" tone="subdued">Only the owner can create, edit or delete custom roles.</Text>
                    )}
                    {custom.length > 0 ? custom.map(renderRole) : (
                        <Card>
                            <Text as="p" tone="subdued">No custom roles have been created.</Text>
                        </Card>
                    )}
                </BlockStack>
            </BlockStack>
        );
    }

    return (
        <BlockStack gap="400">
            {notice ? (
                <Banner tone={notice.tone} title={notice.title} onDismiss={() => setNotice(null)}>
                    {notice.lines.length > 0 ? (
                        <BlockStack gap="100">
                            {notice.lines.map((line) => <Text as="p" key={line}>{line}</Text>)}
                        </BlockStack>
                    ) : null}
                </Banner>
            ) : null}

            {load.state === 'error' ? (
                <LoadFailureBanner result={load.failure} what="The role list" onRetry={loadRoles} />
            ) : null}

            {body}

            <Modal
                open={Boolean(editor)}
                onClose={closeEditor}
                size="large"
                title={editor && editor.mode === 'edit' ? 'Edit custom role' : 'Create custom role'}
                primaryAction={{
                    content: editor && editor.mode === 'edit' ? 'Save role' : 'Create role',
                    onAction: submitEditor,
                    loading: saving,
                    disabled: !editor || !editor.name.trim()
                }}
                secondaryActions={[{ content: 'Cancel', onAction: closeEditor, disabled: saving }]}
            >
                {editor ? (
                    <Modal.Section>
                        <BlockStack gap="400">
                            {editorError ? (
                                <Banner tone="critical" title="Not saved">
                                    <p>{editorError}</p>
                                </Banner>
                            ) : null}
                            <TextField
                                label="Name"
                                autoComplete="off"
                                value={editor.name}
                                onChange={(value) => updateEditor('name', value)}
                                maxLength={ROLE_NAME_MAX}
                                showCharacterCount
                                error={nameError || undefined}
                                disabled={saving}
                            />
                            <TextField
                                label="Description"
                                autoComplete="off"
                                multiline={3}
                                value={editor.description}
                                onChange={(value) => updateEditor('description', value)}
                                maxLength={ROLE_DESCRIPTION_MAX}
                                showCharacterCount
                                disabled={saving}
                            />
                            <BlockStack gap="200">
                                <Text as="h3" variant="headingSm">Permissions</Text>
                                <Text as="p" tone="subdued">
                                    Ticking a permission also ticks what it depends on. Managing roles is reserved to
                                    the owner and cannot be granted.
                                </Text>
                                <PermissionPicker
                                    catalogue={catalogue}
                                    value={editor.permissions}
                                    onChange={(next) => updateEditor('permissions', next)}
                                    disabled={saving}
                                />
                            </BlockStack>
                        </BlockStack>
                    </Modal.Section>
                ) : null}
            </Modal>

            <Modal
                open={Boolean(deleteTarget)}
                onClose={closeDelete}
                title={deleteTarget ? `Delete the role "${deleteTarget.label}"?` : ''}
                primaryAction={{ content: 'Delete role', destructive: true, onAction: submitDelete, loading: deleting }}
                secondaryActions={[{ content: 'Cancel', onAction: closeDelete, disabled: deleting }]}
            >
                <Modal.Section>
                    <BlockStack gap="300">
                        {deleteError ? (
                            <Banner tone="critical" title="Not deleted">
                                <p>{deleteError}</p>
                            </Banner>
                        ) : null}
                        <Text as="p">
                            A role can only be deleted when no member holds it and no pending invitation offers it.
                            Move those members to another role first.
                        </Text>
                        {deleteTarget && _usageLine(deleteTarget) ? (
                            <Text as="p" tone="subdued">{`Currently: ${_usageLine(deleteTarget)}.`}</Text>
                        ) : null}
                    </BlockStack>
                </Modal.Section>
            </Modal>
        </BlockStack>
    );
};

export default RolesTab;
