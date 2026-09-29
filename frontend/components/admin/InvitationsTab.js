import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Badge,
    Banner,
    BlockStack,
    Button,
    Card,
    EmptyState,
    Form,
    FormLayout,
    IndexTable,
    InlineStack,
    Modal,
    Select,
    SkeletonBodyText,
    Text,
    TextField
} from '@shopify/polaris';

import UserAdminApiService from '../../API_Services/userAdminService';
import { PERMISSIONS } from '../../utils/permissions';
import useAdminSession from './useAdminSession';
import MailStatusBanner from './MailStatusBanner';
import LoadFailureBanner from './LoadFailureBanner';
import {
    DASH,
    INVITE_ACTIONABLE_STATES,
    INVITE_REVOKED_REASON_LABELS,
    INVITE_STATE_BADGE,
    assignableRoleOptions,
    describeEmailOutcome,
    errorCodeOf,
    failureMessage,
    formatDateTime,
    parseRoleOptionValue
} from './adminPresentation';

const API = new UserAdminApiService();

/**
 * The id of an invitation row, whichever spelling the payload uses.
 *
 * @param {Object} invite - An InviteView.
 * @returns {String}
 */
const _inviteId = (invite) => {
    const source = invite || {};
    const id = source.invite_id || source.id || source._id;
    return id ? String(id) : '';
};

/**
 * The notice for a create or resend that the server accepted: the invitation exists, and
 * separately, what the mail server said. The two are different facts; an invitation whose email
 * was refused still exists and can be re-sent.
 *
 * @param {String} verb - 'created' | 're-sent'.
 * @param {Object} data - The response payload.
 * @param {String} fallbackEmail - The address typed, when the payload does not echo one.
 * @returns {{tone: String, title: String, lines: Array<String>}}
 */
const _sentNotice = (verb, data, fallbackEmail) => {
    const invite = data && data.invite ? data.invite : {};
    const email = invite.email || fallbackEmail || 'this address';
    const outcome = describeEmailOutcome(data, email);
    const lines = [`${outcome.title}. ${outcome.body}`];
    if (invite.expires_at) {
        lines.push(`The link expires ${formatDateTime(invite.expires_at)}.`);
    }
    let tone = outcome.tone;
    if (tone === 'critical') {
        // The invitation itself was written; only the email failed. Critical is kept for failures
        // that left nothing behind.
        tone = 'warning';
    }
    return { tone: tone, title: `Invitation to ${email} ${verb}`, lines: lines };
};

/**
 * The Invitations tab: invite someone, and see / resend / revoke the invitations already sent.
 *
 * Every invitation's `state` (pending, expired, accepted, revoked) is the SERVER's; it is labelled
 * here and never recomputed from `expires_at`, because the browser clock is not the one that decides
 * whether the link still works.
 *
 * @returns {JSX.Element}
 */
const InvitationsTab = () => {
    const { can, noteForbidden } = useAdminSession();
    const canManageUsers = can(PERMISSIONS.USERS_MANAGE);

    const [load, setLoad] = useState({ state: 'loading', invites: null, mail: null, failure: null });
    const [roles, setRoles] = useState({ state: 'idle', roles: null, failure: null });

    const [email, setEmail] = useState('');
    const [roleChoice, setRoleChoice] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [formNotice, setFormNotice] = useState(null);
    const [enabling, setEnabling] = useState(false);

    const [listNotice, setListNotice] = useState(null);
    const [loopback, setLoopback] = useState(false);
    const [resendingId, setResendingId] = useState('');
    const [revokeTarget, setRevokeTarget] = useState(null);
    const [revoking, setRevoking] = useState(false);
    const [revokeError, setRevokeError] = useState('');

    const mountedRef = useRef(true);
    const loadSeqRef = useRef(0);
    const rolesSeqRef = useRef(0);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const loadInvites = useCallback(() => {
        loadSeqRef.current += 1;
        const seq = loadSeqRef.current;
        setLoad((prev) => ({ state: 'loading', invites: prev.invites, mail: prev.mail, failure: null }));
        API.listInvites().then((result) => {
            if (!mountedRef.current || seq !== loadSeqRef.current) {
                return;
            }
            if (result.status && Array.isArray(result.data.items)) {
                setLoad({ state: 'ready', invites: result.data.items, mail: result.data.mail || null, failure: null });
                return;
            }
            noteForbidden(result);
            let failure = result;
            if (result.status) {
                failure = { status: false, msg: 'The server answered without an invitation list.', error: {}, http_status: result.http_status };
            }
            setLoad({ state: 'error', invites: null, mail: null, failure: failure });
        });
    }, [noteForbidden]);

    const loadRoles = useCallback(() => {
        rolesSeqRef.current += 1;
        const seq = rolesSeqRef.current;
        setRoles((prev) => ({ state: 'loading', roles: prev.roles, failure: null }));
        API.listRoles().then((result) => {
            if (!mountedRef.current || seq !== rolesSeqRef.current) {
                return;
            }
            if (result.status && Array.isArray(result.data.roles)) {
                setRoles({ state: 'ready', roles: result.data.roles, failure: null });
                return;
            }
            noteForbidden(result);
            setRoles({ state: 'error', roles: null, failure: result });
        });
    }, [noteForbidden]);

    useEffect(() => {
        loadInvites();
    }, [loadInvites]);

    useEffect(() => {
        if (canManageUsers) {
            loadRoles();
        }
    }, [canManageUsers, loadRoles]);

    const submitInvite = useCallback(() => {
        const role = parseRoleOptionValue(roleChoice);
        const typed = email.trim();
        if (!typed || !role || submitting) {
            return;
        }
        setSubmitting(true);
        setFormNotice(null);
        API.createInvite({ email: typed, role_key: role.role_key, custom_role_id: role.custom_role_id }).then((result) => {
            if (!mountedRef.current) {
                return;
            }
            setSubmitting(false);
            if (result.status) {
                setFormNotice(Object.assign({ kind: 'sent' }, _sentNotice('created', result.data, typed)));
                setLoopback(result.data.link_host_is_loopback === true);
                setEmail('');
                setRoleChoice('');
                loadInvites();
                return;
            }
            const code = errorCodeOf(result);
            if (code === 'ALREADY_A_MEMBER') {
                const detail = result.error || {};
                if (detail.status === 'disabled' && detail.user_id) {
                    setFormNotice({
                        kind: 'disabled_member',
                        user_id: String(detail.user_id),
                        email: typed,
                        tone: 'warning',
                        title: `${typed} already has an account, and it is disabled`,
                        lines: ['Enable it instead of inviting again. They sign in with their existing password and keep their current role.']
                    });
                    return;
                }
                setFormNotice({
                    kind: 'member',
                    tone: 'info',
                    title: `${typed} is already a member`,
                    lines: [failureMessage(result, 'An account with this address already exists.')]
                });
                return;
            }
            if (code === 'INVITE_PENDING') {
                setFormNotice({
                    kind: 'pending',
                    tone: 'warning',
                    title: `An invitation to ${typed} already exists`,
                    lines: ['It has not been accepted or revoked. Resend it from the list below instead; an expired one can be resent too.']
                });
                return;
            }
            if (noteForbidden(result)) {
                loadRoles();
            }
            setFormNotice({
                kind: 'failed',
                tone: 'critical',
                title: 'No invitation was created',
                lines: [failureMessage(result, 'The invitation could not be created.')]
            });
        });
    }, [email, roleChoice, submitting, loadInvites, loadRoles, noteForbidden]);

    /**
     * "Enable instead": the ALREADY_A_MEMBER answer named a disabled account, and enabling it is
     * what the admin almost certainly meant. The server applies the management rule again.
     */
    const enableInstead = useCallback(() => {
        if (!formNotice || formNotice.kind !== 'disabled_member' || enabling) {
            return;
        }
        const target = formNotice;
        setEnabling(true);
        API.enableUser(target.user_id).then((result) => {
            if (!mountedRef.current) {
                return;
            }
            setEnabling(false);
            if (result.status) {
                setFormNotice({
                    kind: 'enabled',
                    tone: 'success',
                    title: `${target.email} is enabled`,
                    lines: ['They can sign in with their existing password. Their role is unchanged; change it from the Members tab if needed.']
                });
                setEmail('');
                setRoleChoice('');
                return;
            }
            noteForbidden(result);
            setFormNotice({
                kind: 'failed',
                tone: 'critical',
                title: `${target.email} was not enabled`,
                lines: [failureMessage(result, 'The account could not be enabled.')]
            });
        });
    }, [formNotice, enabling, noteForbidden]);

    const resend = useCallback((invite) => {
        const id = _inviteId(invite);
        if (!id || resendingId) {
            return;
        }
        setResendingId(id);
        setListNotice(null);
        API.resendInvite(id).then((result) => {
            if (!mountedRef.current) {
                return;
            }
            setResendingId('');
            if (result.status) {
                setListNotice(_sentNotice('re-sent', result.data, invite.email));
                setLoopback(result.data.link_host_is_loopback === true);
                loadInvites();
                return;
            }
            noteForbidden(result);
            let tone = 'critical';
            if (result.http_status === 429) {
                // The throttle: at most one send a minute and five a day per invitation.
                tone = 'warning';
            }
            setListNotice({
                tone: tone,
                title: `The invitation to ${invite.email || 'this address'} was not re-sent`,
                lines: [failureMessage(result, 'The invitation could not be re-sent.')]
            });
            loadInvites();
        });
    }, [resendingId, loadInvites, noteForbidden]);

    const closeRevoke = useCallback(() => {
        if (revoking) {
            return;
        }
        setRevokeTarget(null);
        setRevokeError('');
    }, [revoking]);

    const submitRevoke = useCallback(() => {
        const invite = revokeTarget;
        const id = _inviteId(invite);
        if (!id) {
            return;
        }
        setRevoking(true);
        setRevokeError('');
        API.revokeInvite(id).then((result) => {
            if (!mountedRef.current) {
                return;
            }
            setRevoking(false);
            if (result.status) {
                setListNotice({
                    tone: 'success',
                    title: `Invitation to ${invite.email || 'this address'} revoked`,
                    lines: ['The link in it no longer works.']
                });
                setRevokeTarget(null);
                loadInvites();
                return;
            }
            noteForbidden(result);
            setRevokeError(failureMessage(result, 'The invitation could not be revoked.'));
            // INVITE_NOT_PENDING means the row moved on (accepted or revoked elsewhere): show it.
            loadInvites();
        });
    }, [revokeTarget, loadInvites, noteForbidden]);

    // ── Invite form ───────────────────────────────────────────────────────────────────────────
    let formMarkup = null;
    if (canManageUsers) {
        const options = assignableRoleOptions(roles.roles);
        let roleControl = null;
        if (roles.state === 'error') {
            roleControl = <LoadFailureBanner result={roles.failure} what="The role list" onRetry={loadRoles} />;
        } else if (roles.roles === null) {
            roleControl = <SkeletonBodyText lines={1} />;
        } else if (options.length === 0) {
            roleControl = (
                <Banner tone="info" title="No role you can grant">
                    <p>You can only invite people to roles with strictly fewer permissions than your own, and none qualify.</p>
                </Banner>
            );
        } else {
            roleControl = (
                <Select
                    label="Role"
                    options={[{ label: 'Choose a role', value: '' }].concat(options)}
                    value={roleChoice}
                    onChange={setRoleChoice}
                    disabled={submitting}
                    helpText="Only roles with strictly fewer permissions than yours are listed."
                />
            );
        }

        let noticeMarkup = null;
        if (formNotice) {
            let action;
            if (formNotice.kind === 'disabled_member') {
                action = { content: 'Enable instead', onAction: enableInstead, loading: enabling };
            }
            noticeMarkup = (
                <Banner tone={formNotice.tone} title={formNotice.title} action={action} onDismiss={() => setFormNotice(null)}>
                    <BlockStack gap="100">
                        {formNotice.lines.map((line) => <Text as="p" key={line}>{line}</Text>)}
                    </BlockStack>
                </Banner>
            );
        }

        formMarkup = (
            <Card>
                <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">Invite a teammate</Text>
                    <Text as="p" tone="subdued">
                        They receive an email with a link to choose their name and password. The email is sent
                        now and can take up to 15 seconds to confirm.
                    </Text>
                    {noticeMarkup}
                    <Form onSubmit={submitInvite}>
                        <FormLayout>
                            <TextField
                                label="Email address"
                                type="email"
                                autoComplete="off"
                                value={email}
                                onChange={setEmail}
                                disabled={submitting}
                                maxLength={254}
                            />
                            {roleControl}
                            <InlineStack>
                                <Button
                                    submit
                                    variant="primary"
                                    loading={submitting}
                                    disabled={!email.trim() || !parseRoleOptionValue(roleChoice)}
                                >
                                    Send invitation
                                </Button>
                            </InlineStack>
                        </FormLayout>
                    </Form>
                </BlockStack>
            </Card>
        );
    }

    // ── List ──────────────────────────────────────────────────────────────────────────────────
    const invites = load.invites;

    const renderRow = (invite, index) => {
        const id = _inviteId(invite) || `row-${index}`;
        const state = typeof invite.state === 'string' ? invite.state : '';
        const badge = INVITE_STATE_BADGE[state] || { tone: undefined, label: state || 'Unknown' };

        let whenLine = DASH;
        if (state === 'accepted') {
            whenLine = `Accepted ${formatDateTime(invite.accepted_at)}`;
        } else if (state === 'revoked') {
            whenLine = `Revoked ${formatDateTime(invite.revoked_at)}`;
        } else if (invite.expires_at) {
            whenLine = `${state === 'expired' ? 'Expired' : 'Expires'} ${formatDateTime(invite.expires_at)}`;
        }

        let sentLine = formatDateTime(invite.last_sent_at);
        if (typeof invite.send_count === 'number' && invite.send_count > 1) {
            sentLine = `${sentLine} (sent ${invite.send_count} times)`;
        }

        const actionable = INVITE_ACTIONABLE_STATES.includes(state) && invite.can_manage !== false;

        return (
            <IndexTable.Row id={id} key={id} position={index}>
                <IndexTable.Cell>
                    <Text as="span" variant="bodyMd" fontWeight="semibold">{invite.email || DASH}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                    <Text as="span" variant="bodyMd">{invite.role_label || invite.role_key || DASH}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                    <BlockStack gap="050" inlineAlign="start">
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                        {state === 'revoked' && invite.revoked_reason ? (
                            <Text as="span" variant="bodyXs" tone="subdued">
                                {INVITE_REVOKED_REASON_LABELS[invite.revoked_reason] || String(invite.revoked_reason)}
                            </Text>
                        ) : null}
                    </BlockStack>
                </IndexTable.Cell>
                <IndexTable.Cell>
                    <Text as="span" variant="bodySm">{invite.invited_by_name || invite.invited_by_email || DASH}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                    <Text as="span" variant="bodySm">{sentLine}</Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                    <Text as="span" variant="bodySm">{whenLine}</Text>
                </IndexTable.Cell>
                {canManageUsers ? (
                    <IndexTable.Cell>
                        {actionable ? (
                            <InlineStack gap="200" wrap={false}>
                                <Button
                                    size="slim"
                                    onClick={() => resend(invite)}
                                    loading={resendingId === id}
                                    disabled={Boolean(resendingId) && resendingId !== id}
                                    accessibilityLabel={`Resend the invitation to ${invite.email || 'this address'}`}
                                >
                                    Resend
                                </Button>
                                <Button
                                    size="slim"
                                    tone="critical"
                                    variant="plain"
                                    onClick={() => {
                                        setRevokeError('');
                                        setRevokeTarget(invite);
                                    }}
                                    accessibilityLabel={`Revoke the invitation to ${invite.email || 'this address'}`}
                                >
                                    Revoke
                                </Button>
                            </InlineStack>
                        ) : null}
                    </IndexTable.Cell>
                ) : null}
            </IndexTable.Row>
        );
    };

    const headings = [
        { title: 'Email' },
        { title: 'Role' },
        { title: 'State' },
        { title: 'Invited by' },
        { title: 'Last sent' },
        { title: 'Expiry' }
    ];
    if (canManageUsers) {
        headings.push({ title: 'Actions' });
    }

    let listMarkup = null;
    if (invites === null && load.state === 'loading') {
        listMarkup = (
            <Card>
                <SkeletonBodyText lines={4} />
            </Card>
        );
    } else if (invites !== null) {
        listMarkup = (
            <Card padding="0">
                <IndexTable
                    resourceName={{ singular: 'invitation', plural: 'invitations' }}
                    itemCount={invites.length}
                    selectable={false}
                    loading={load.state === 'loading'}
                    headings={headings}
                    emptyState={(
                        <EmptyState heading="No invitations yet" image="">
                            <p>No invitation has been sent from this install.</p>
                        </EmptyState>
                    )}
                >
                    {invites.map(renderRow)}
                </IndexTable>
            </Card>
        );
    }

    return (
        <BlockStack gap="400">
            <MailStatusBanner mail={load.mail} />

            {loopback ? (
                <Banner tone="warning" title="Invitation links point at a loopback address" onDismiss={() => setLoopback(false)}>
                    <p>
                        APP_PUBLIC_URL on the backend is a loopback address (such as localhost), so the link in
                        this email only opens on the machine running the dashboard. Set APP_PUBLIC_URL to the
                        address your teammates use, restart the backend, then resend the invitation.
                    </p>
                </Banner>
            ) : null}

            {formMarkup}

            {listNotice ? (
                <Banner tone={listNotice.tone} title={listNotice.title} onDismiss={() => setListNotice(null)}>
                    <BlockStack gap="100">
                        {listNotice.lines.map((line) => <Text as="p" key={line}>{line}</Text>)}
                    </BlockStack>
                </Banner>
            ) : null}

            {load.state === 'error' ? (
                <LoadFailureBanner result={load.failure} what="The invitation list" onRetry={loadInvites} />
            ) : null}

            {listMarkup}

            <Modal
                open={Boolean(revokeTarget)}
                onClose={closeRevoke}
                title={revokeTarget ? `Revoke the invitation to ${revokeTarget.email || 'this address'}?` : ''}
                primaryAction={{ content: 'Revoke invitation', destructive: true, onAction: submitRevoke, loading: revoking }}
                secondaryActions={[{ content: 'Cancel', onAction: closeRevoke, disabled: revoking }]}
            >
                <Modal.Section>
                    <BlockStack gap="300">
                        {revokeError ? (
                            <Banner tone="critical" title="Not revoked">
                                <p>{revokeError}</p>
                            </Banner>
                        ) : null}
                        <Text as="p">
                            The link in the email stops working immediately. To let them join later, send a new
                            invitation.
                        </Text>
                    </BlockStack>
                </Modal.Section>
            </Modal>
        </BlockStack>
    );
};

export default InvitationsTab;
