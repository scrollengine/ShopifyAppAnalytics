import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActionList,
    Badge,
    Banner,
    BlockStack,
    Button,
    Card,
    EmptyState,
    IndexTable,
    InlineStack,
    Modal,
    Popover,
    Select,
    SkeletonBodyText,
    Text,
    Tooltip
} from '@shopify/polaris';

import UserAdminApiService from '../../API_Services/userAdminService';
import { PERMISSIONS } from '../../utils/permissions';
import useAdminSession from './useAdminSession';
import MailStatusBanner from './MailStatusBanner';
import LoadFailureBanner from './LoadFailureBanner';
import {
    DASH,
    MANAGE_BLOCK_FALLBACK,
    MANAGE_BLOCK_REASON_LABELS,
    USER_STATUS_BADGE,
    assignableRoleOptions,
    describeEmailOutcome,
    failureMessage,
    formatDateTime,
    parseRoleOptionValue,
    permissionLabels,
    roleOptionValue,
    userRoleOptionValue
} from './adminPresentation';

const API = new UserAdminApiService();

/**
 * What each confirm-first action says and does. One table so the four modals cannot drift apart
 * in shape; the wording is per action because the consequences are.
 */
const CONFIRM_ACTIONS = Object.freeze({
    disable: Object.freeze({
        title: (user) => `Disable ${user.name}?`,
        body: 'They are signed out everywhere at once and cannot sign in until they are enabled again. '
            + 'Invitations they sent that are still pending are revoked. Nothing they did is deleted.',
        confirm: 'Disable',
        destructive: true,
        run: (user) => API.disableUser(user.user_id)
    }),
    enable: Object.freeze({
        title: (user) => `Enable ${user.name}?`,
        body: 'They can sign in again with their existing password. Invitations that were revoked when they '
            + 'were disabled stay revoked.',
        confirm: 'Enable',
        destructive: false,
        run: (user) => API.enableUser(user.user_id)
    }),
    revoke_sessions: Object.freeze({
        title: (user) => `Sign ${user.name} out everywhere?`,
        body: 'Every session they hold ends now, on every device. They can sign straight back in with their '
            + 'password; to stop that, disable them instead.',
        confirm: 'Sign out everywhere',
        destructive: true,
        run: (user) => API.revokeUserSessions(user.user_id)
    }),
    password_reset: Object.freeze({
        title: (user) => `Send ${user.name} a password-reset email?`,
        body: 'They receive a link to choose a new password. You never see or set the password, and their '
            + 'current password keeps working until they use the link.',
        confirm: 'Send email',
        destructive: false,
        run: (user) => API.sendPasswordReset(user.user_id)
    })
});

/**
 * The result notice for a confirmed action that succeeded.
 *
 * @param {String} kind - A `CONFIRM_ACTIONS` key.
 * @param {Object} user - The target UserView.
 * @param {Object} data - The response payload.
 * @returns {{tone: String, title: String, body: String}}
 */
const _successNotice = (kind, user, data) => {
    if (kind === 'disable') {
        return { tone: 'success', title: `${user.name} is disabled`, body: 'They have been signed out everywhere.' };
    }
    if (kind === 'enable') {
        return { tone: 'success', title: `${user.name} is enabled`, body: 'They can sign in again.' };
    }
    if (kind === 'revoke_sessions') {
        let body = 'Every session they held has ended.';
        if (data && typeof data.revoked === 'number') {
            body = `${data.revoked} active session${data.revoked === 1 ? '' : 's'} ended.`;
        }
        return { tone: 'success', title: `${user.name} is signed out everywhere`, body: body };
    }
    return describeEmailOutcome(data, user.email);
};

/**
 * The Members tab: every user, their role and status, and the actions the caller may take on them.
 *
 * Whether a row can be acted on is the SERVER's answer (`can_manage`, computed by the management
 * rule for the requesting actor) combined with the session's `users:manage`. Neither is re-derived
 * here. `manage_block_reason` is a code, rendered through MANAGE_BLOCK_REASON_LABELS when a row is
 * locked.
 *
 * @returns {JSX.Element}
 */
const MembersTab = () => {
    const { can, noteForbidden, currentUserId } = useAdminSession();
    const canManageUsers = can(PERMISSIONS.USERS_MANAGE);

    // `users` stays null until a list has actually been received, so "not loaded" never renders as
    // "no members".
    const [load, setLoad] = useState({ state: 'loading', users: null, mail: null, failure: null });
    const [notice, setNotice] = useState(null);
    const [menuFor, setMenuFor] = useState('');

    const [roleTarget, setRoleTarget] = useState(null);
    const [roleCatalogue, setRoleCatalogue] = useState({ state: 'idle', roles: null, catalogue: null, failure: null });
    const [roleChoice, setRoleChoice] = useState('');

    const [confirm, setConfirm] = useState(null);
    const [busy, setBusy] = useState(false);
    const [modalError, setModalError] = useState('');

    const mountedRef = useRef(true);
    const loadSeqRef = useRef(0);
    const rolesSeqRef = useRef(0);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const loadUsers = useCallback(() => {
        loadSeqRef.current += 1;
        const seq = loadSeqRef.current;
        setLoad((prev) => ({ state: 'loading', users: prev.users, mail: prev.mail, failure: null }));
        API.listUsers().then((result) => {
            // A slower, older request must not overwrite a newer answer.
            if (!mountedRef.current || seq !== loadSeqRef.current) {
                return;
            }
            if (result.status && Array.isArray(result.data.items)) {
                setLoad({ state: 'ready', users: result.data.items, mail: result.data.mail || null, failure: null });
                return;
            }
            noteForbidden(result);
            let failure = result;
            if (result.status) {
                failure = { status: false, msg: 'The server answered without a user list.', error: {}, http_status: result.http_status };
            }
            setLoad({ state: 'error', users: null, mail: null, failure: failure });
        });
    }, [noteForbidden]);

    useEffect(() => {
        loadUsers();
    }, [loadUsers]);

    const loadRoles = useCallback(() => {
        rolesSeqRef.current += 1;
        const seq = rolesSeqRef.current;
        setRoleCatalogue({ state: 'loading', roles: null, catalogue: null, failure: null });
        API.listRoles().then((result) => {
            if (!mountedRef.current || seq !== rolesSeqRef.current) {
                return;
            }
            if (result.status && Array.isArray(result.data.roles)) {
                setRoleCatalogue({
                    state: 'ready',
                    roles: result.data.roles,
                    catalogue: Array.isArray(result.data.catalogue) ? result.data.catalogue : [],
                    failure: null
                });
                return;
            }
            noteForbidden(result);
            setRoleCatalogue({ state: 'error', roles: null, catalogue: null, failure: result });
        });
    }, [noteForbidden]);

    const openRoleModal = useCallback((user) => {
        setMenuFor('');
        setModalError('');
        setRoleTarget(user);
        setRoleChoice('');
        // Fetched on open, not on mount: `assignable` is computed for the caller at request time,
        // and a list read minutes ago can offer a role the caller can no longer grant.
        loadRoles();
    }, [loadRoles]);

    const closeRoleModal = useCallback(() => {
        if (busy) {
            return;
        }
        setRoleTarget(null);
        setModalError('');
    }, [busy]);

    const openConfirm = useCallback((kind, user) => {
        setMenuFor('');
        setModalError('');
        setConfirm({ kind: kind, user: user });
    }, []);

    const closeConfirm = useCallback(() => {
        if (busy) {
            return;
        }
        setConfirm(null);
        setModalError('');
    }, [busy]);

    /**
     * Handles a refused mutation: the message goes inline in the open modal, and a 403 also
     * re-reads the session and the list, because the caller's permissions or the target's
     * manageability changed underneath the screen.
     *
     * @param {Object} result - The failed result.
     * @param {String} fallback - Used when the server gave no message.
     * @returns {void}
     */
    const handleMutationFailure = useCallback((result, fallback) => {
        setModalError(failureMessage(result, fallback));
        if (noteForbidden(result)) {
            loadUsers();
        }
    }, [noteForbidden, loadUsers]);

    const submitRoleChange = useCallback(() => {
        const user = roleTarget;
        const role = parseRoleOptionValue(roleChoice);
        if (!user || !role) {
            return;
        }
        const chosen = (roleCatalogue.roles || []).find((candidate) => roleOptionValue(candidate) === roleChoice);
        setBusy(true);
        setModalError('');
        API.changeUserRole(user.user_id, role).then((result) => {
            if (!mountedRef.current) {
                return;
            }
            setBusy(false);
            if (!result.status) {
                handleMutationFailure(result, 'The role could not be changed.');
                return;
            }
            let body = '';
            const revoked = result.data.invites_revoked;
            if (typeof revoked === 'number' && revoked > 0) {
                body = `${revoked} pending invitation${revoked === 1 ? '' : 's'} they sent ${revoked === 1 ? 'was' : 'were'} `
                    + 'revoked, because their new role can no longer grant the role invited.';
            }
            const label = chosen ? chosen.label : 'the new role';
            setNotice({ tone: 'success', title: `${user.name} now has the role ${label}`, body: body });
            setRoleTarget(null);
            loadUsers();
        });
    }, [roleTarget, roleChoice, roleCatalogue.roles, handleMutationFailure, loadUsers]);

    const submitConfirm = useCallback(() => {
        if (!confirm) {
            return;
        }
        const action = CONFIRM_ACTIONS[confirm.kind];
        const user = confirm.user;
        setBusy(true);
        setModalError('');
        action.run(user).then((result) => {
            if (!mountedRef.current) {
                return;
            }
            setBusy(false);
            if (!result.status) {
                handleMutationFailure(result, 'The action could not be completed.');
                return;
            }
            setNotice(_successNotice(confirm.kind, user, result.data));
            setConfirm(null);
            loadUsers();
        });
    }, [confirm, handleMutationFailure, loadUsers]);

    // ── Rows ───────────────────────────────────────────────────────────────────────────────────
    const users = load.users;

    const renderActions = (user) => {
        const manageable = user.can_manage === true;
        if (!manageable) {
            const reason = MANAGE_BLOCK_REASON_LABELS[user.manage_block_reason] || MANAGE_BLOCK_FALLBACK;
            return (
                <Tooltip content={reason}>
                    <Button disabled disclosure accessibilityLabel={`Actions unavailable: ${reason}`}>Actions</Button>
                </Tooltip>
            );
        }
        const items = [{ content: 'Change role', onAction: () => openRoleModal(user) }];
        if (user.status === 'disabled') {
            items.push({ content: 'Enable', onAction: () => openConfirm('enable', user) });
        } else {
            items.push({ content: 'Send password-reset email', onAction: () => openConfirm('password_reset', user) });
            items.push({ content: 'Sign out everywhere', onAction: () => openConfirm('revoke_sessions', user) });
            items.push({ content: 'Disable', destructive: true, onAction: () => openConfirm('disable', user) });
        }
        return (
            <Popover
                active={menuFor === user.user_id}
                onClose={() => setMenuFor('')}
                activator={(
                    <Button
                        disclosure
                        onClick={() => setMenuFor(menuFor === user.user_id ? '' : user.user_id)}
                        accessibilityLabel={`Actions for ${user.name}`}
                    >
                        Actions
                    </Button>
                )}
            >
                <ActionList actionRole="menuitem" items={items} />
            </Popover>
        );
    };

    const renderRow = (user, index) => {
        const statusBadge = USER_STATUS_BADGE[user.status] || { tone: undefined, label: String(user.status || DASH) };
        const isSelf = currentUserId !== '' && String(user.user_id) === currentUserId;
        let lastSignIn = 'Never';
        if (user.last_login_at) {
            lastSignIn = formatDateTime(user.last_login_at);
        }
        return (
            <IndexTable.Row id={String(user.user_id)} key={String(user.user_id)} position={index}>
                <IndexTable.Cell>
                    <InlineStack gap="200" blockAlign="center" wrap={false}>
                        <Text as="span" variant="bodyMd" fontWeight="semibold">{user.name || DASH}</Text>
                        {isSelf ? <Badge>You</Badge> : null}
                    </InlineStack>
                </IndexTable.Cell>
                <IndexTable.Cell>
                    <Text as="span" variant="bodyMd">{user.email || DASH}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                    <InlineStack gap="100" blockAlign="center">
                        <Badge tone={user.is_owner ? 'magic' : undefined}>{user.role_label || user.role_key || 'Unknown role'}</Badge>
                        {user.role_key === 'custom' ? <Text as="span" variant="bodySm" tone="subdued">custom</Text> : null}
                    </InlineStack>
                </IndexTable.Cell>
                <IndexTable.Cell>
                    <Badge tone={statusBadge.tone}>{statusBadge.label}</Badge>
                </IndexTable.Cell>
                <IndexTable.Cell>
                    <Text as="span" variant="bodySm">{lastSignIn}</Text>
                </IndexTable.Cell>
                {canManageUsers ? <IndexTable.Cell>{renderActions(user)}</IndexTable.Cell> : null}
            </IndexTable.Row>
        );
    };

    const headings = [
        { title: 'Name' },
        { title: 'Email' },
        { title: 'Role' },
        { title: 'Status' },
        { title: 'Last sign-in' }
    ];
    if (canManageUsers) {
        headings.push({ title: 'Actions' });
    }

    let tableMarkup = null;
    if (users === null && load.state === 'loading') {
        tableMarkup = (
            <Card>
                <SkeletonBodyText lines={4} />
            </Card>
        );
    } else if (users !== null) {
        tableMarkup = (
            <Card padding="0">
                <IndexTable
                    resourceName={{ singular: 'member', plural: 'members' }}
                    itemCount={users.length}
                    selectable={false}
                    loading={load.state === 'loading'}
                    headings={headings}
                    emptyState={(
                        <EmptyState heading="No members" image="">
                            <p>The server returned no user accounts.</p>
                        </EmptyState>
                    )}
                >
                    {users.map(renderRow)}
                </IndexTable>
            </Card>
        );
    }

    // ── Change-role modal ─────────────────────────────────────────────────────────────────────
    let roleModalBody = null;
    if (roleTarget) {
        const options = assignableRoleOptions(roleCatalogue.roles);
        const currentValue = userRoleOptionValue(roleTarget);
        const chosen = (roleCatalogue.roles || []).find((candidate) => roleOptionValue(candidate) === roleChoice);
        if (roleCatalogue.state === 'loading' || roleCatalogue.state === 'idle') {
            roleModalBody = <SkeletonBodyText lines={3} />;
        } else if (roleCatalogue.state === 'error') {
            roleModalBody = <LoadFailureBanner result={roleCatalogue.failure} what="The role list" onRetry={loadRoles} />;
        } else if (options.length === 0) {
            roleModalBody = (
                <Banner tone="info" title="No role you can grant">
                    <p>Your role can only grant roles with strictly fewer permissions than your own, and none qualify.</p>
                </Banner>
            );
        } else {
            const selectOptions = [{ label: 'Choose a role', value: '' }].concat(options.map((option) => ({
                label: option.value === currentValue ? `${option.label} (current)` : option.label,
                value: option.value
            })));
            roleModalBody = (
                <BlockStack gap="300">
                    <Text as="p">{`Current role: ${roleTarget.role_label || roleTarget.role_key || 'Unknown'}`}</Text>
                    <Select
                        label="New role"
                        options={selectOptions}
                        value={roleChoice}
                        onChange={setRoleChoice}
                        disabled={busy}
                        helpText="Only roles with strictly fewer permissions than yours are listed. The change applies on their next request; they stay signed in."
                    />
                    {chosen ? (
                        <BlockStack gap="100">
                            {chosen.description ? <Text as="p" tone="subdued">{chosen.description}</Text> : null}
                            <Text as="p" variant="bodySm">
                                {`Grants: ${permissionLabels(chosen.permissions, roleCatalogue.catalogue).map((entry) => entry.label).join(', ') || 'nothing'}`}
                            </Text>
                        </BlockStack>
                    ) : null}
                </BlockStack>
            );
        }
    }

    const confirmAction = confirm ? CONFIRM_ACTIONS[confirm.kind] : null;

    return (
        <BlockStack gap="400">
            <MailStatusBanner mail={load.mail} />

            {notice ? (
                <Banner tone={notice.tone} title={notice.title} onDismiss={() => setNotice(null)}>
                    {notice.body ? <p>{notice.body}</p> : null}
                </Banner>
            ) : null}

            {load.state === 'error' ? (
                <LoadFailureBanner result={load.failure} what="The member list" onRetry={loadUsers} />
            ) : null}

            {tableMarkup}

            <Modal
                open={Boolean(roleTarget)}
                onClose={closeRoleModal}
                title={roleTarget ? `Change role for ${roleTarget.name}` : 'Change role'}
                primaryAction={{
                    content: 'Change role',
                    onAction: submitRoleChange,
                    loading: busy,
                    disabled: !roleChoice || roleChoice === userRoleOptionValue(roleTarget) || roleCatalogue.state !== 'ready'
                }}
                secondaryActions={[{ content: 'Cancel', onAction: closeRoleModal, disabled: busy }]}
            >
                <Modal.Section>
                    <BlockStack gap="300">
                        {modalError && roleTarget ? (
                            <Banner tone="critical" title="Not changed">
                                <p>{modalError}</p>
                            </Banner>
                        ) : null}
                        {roleModalBody}
                    </BlockStack>
                </Modal.Section>
            </Modal>

            <Modal
                open={Boolean(confirm)}
                onClose={closeConfirm}
                title={confirm ? confirmAction.title(confirm.user) : ''}
                primaryAction={confirm ? {
                    content: confirmAction.confirm,
                    destructive: confirmAction.destructive,
                    onAction: submitConfirm,
                    loading: busy
                } : undefined}
                secondaryActions={[{ content: 'Cancel', onAction: closeConfirm, disabled: busy }]}
            >
                <Modal.Section>
                    <BlockStack gap="300">
                        {modalError && confirm ? (
                            <Banner tone="critical" title="Not done">
                                <p>{modalError}</p>
                            </Banner>
                        ) : null}
                        {confirm && confirm.user.email ? (
                            <Text as="p" tone="subdued">{`Account: ${confirm.user.email}`}</Text>
                        ) : null}
                        {confirm ? <Text as="p">{confirmAction.body}</Text> : null}
                    </BlockStack>
                </Modal.Section>
            </Modal>
        </BlockStack>
    );
};

export default MembersTab;
