import { Banner, BlockStack, Button, Card, Form, FormLayout, InlineStack, Layout, Page, Text, TextField } from '@shopify/polaris';
import { useCallback, useState } from 'react';

import SideNavBar from '../components/sideNavBar';
import PasswordFields, { passwordPairError } from '../components/auth/PasswordFields';
import { errorCodeOf } from '../components/auth/authResult';
import { useSession } from '../contexts/sessionContext';
import AccountApiService from '../API_Services/accountService';

/**
 * =============================================================================
 *  `/account` — the signed-in user's own page. Every role can open it.
 * =============================================================================
 *
 *  Name, password, "sign out my other sessions", sign out. Nothing here needs a
 *  permission (the `@self` routes), which is also why it is the landing page of
 *  last resort: `landingRouteFor` falls back to it for a role that opens nothing
 *  else, so it must never depend on anything a role could lack.
 *
 *  ── ⚠️ TWO ACTIONS END THIS BROWSER'S TOKEN, AND HAND BACK A NEW ONE ────────
 *  Changing the password and signing out the other sessions both move the
 *  account's session epoch on the server, which ends EVERY session — this one
 *  included. The response carries a fresh token for this browser, and it is
 *  stored through `session.applyFreshToken` before anything else is requested:
 *  one request made with the old token answers 401, and a 401 signs the user
 *  out. When the response has no usable token (or storage refuses it), the page
 *  says plainly that this browser is signed out too, rather than letting the
 *  next click discover it.
 *
 *  ── REFUSALS ARE FIELD ERRORS WHERE THEY BELONG TO A FIELD ──────────────────
 *  A wrong current password is a 400 `CURRENT_PASSWORD_INCORRECT` (never a 401,
 *  precisely so it cannot sign anybody out) and lands on the current-password
 *  field; a policy refusal lands on the new-password field with the server's own
 *  sentence, which says which rule. The policy is the server's alone — the only
 *  client-side check is that the two new fields match.
 *
 *  Results are inline Banners rather than toasts: "your other sessions were
 *  signed out" is a statement a reader may want to read twice.
 * =============================================================================
 */

const ACCOUNT_API = new AccountApiService();

/** The `error.code` values these routes answer with, per the backend's account controller. */
const ACCOUNT_ERROR_CODES = Object.freeze({
    CURRENT_PASSWORD_INCORRECT: 'CURRENT_PASSWORD_INCORRECT',
    PASSWORD_POLICY: 'PASSWORD_POLICY',
    VALIDATION: 'VALIDATION'
});

/** Shown when a token-rotating action succeeded but this browser could not keep a session. */
const SIGNED_OUT_HERE_MESSAGE = 'This browser could not be given a new session, so it is signed out too. Sign in again to carry on.';

/**
 * A timestamp in the browser's own time zone, or a dash when there is none.
 *
 * @param {String|null} iso - An ISO-8601 instant from the API.
 * @returns {String}
 */
const _formatWhen = (iso) => {
    if (!iso) {
        return '—';
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return '—';
    }
    return date.toLocaleString();
};

/**
 * True when a service answer is the 401 marker. The axios client is already taking the page to
 * /login, so nothing is drawn over it.
 *
 * @param {Object} resp - An `accountService` envelope.
 * @returns {Boolean}
 */
const _isSessionEnded = (resp) => Boolean(resp && resp.resource_access === 'NOT_ALLOWED');

/**
 * One label/value line of the profile card.
 *
 * @param {Object} props
 * @param {String} props.label
 * @param {String} props.value
 * @returns {JSX.Element}
 */
const FactLine = ({ label, value }) => (
    <InlineStack gap="200">
        <Text as="span" variant="bodyMd" tone="subdued">{`${label}:`}</Text>
        <Text as="span" variant="bodyMd">{value}</Text>
    </InlineStack>
);

/**
 * The account page.
 *
 * @returns {JSX.Element} The framed page.
 */
const AccountPage = () => {
    const session = useSession();
    const user = session.user || {};
    const role = session.role || {};
    const currentName = typeof user.name === 'string' ? user.name : '';
    const email = typeof user.email === 'string' ? user.email : '';

    // ── Name ─────────────────────────────────────────────────────────────────────────────────
    // null = "not being edited": the field shows the session's name. A value = the draft, and it is
    // kept after a successful save, so the field does not flash back to the old name while the
    // session re-reads (once it has, the two agree and Save disables itself).
    const [nameDraft, setNameDraft] = useState(null);
    const [nameBusy, setNameBusy] = useState(false);
    const [nameError, setNameError] = useState('');
    const [nameResult, setNameResult] = useState(null);

    // ── Password ─────────────────────────────────────────────────────────────────────────────
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [passwordBusy, setPasswordBusy] = useState(false);
    const [passwordAttempted, setPasswordAttempted] = useState(false);
    const [currentPasswordError, setCurrentPasswordError] = useState('');
    const [newPasswordError, setNewPasswordError] = useState('');
    const [passwordResult, setPasswordResult] = useState(null);

    // ── Sessions ─────────────────────────────────────────────────────────────────────────────
    const [sessionsBusy, setSessionsBusy] = useState(false);
    const [sessionsResult, setSessionsResult] = useState(null);
    const [signingOut, setSigningOut] = useState(false);

    const nameValue = nameDraft === null ? currentName : nameDraft;
    const nameChanged = nameValue.trim() !== currentName;

    const { refresh, applyFreshToken, logout } = session;

    /**
     * Saves the name. The server validates it (length, control characters, no links or addresses);
     * the page only refuses an empty one, which needs no round trip to explain.
     *
     * @returns {void}
     */
    const saveName = useCallback(() => {
        const trimmed = nameValue.trim();
        setNameResult(null);
        if (!trimmed) {
            setNameError('Enter your name.');
            return;
        }
        setNameError('');
        setNameBusy(true);
        ACCOUNT_API.updateName(trimmed).then((resp) => {
            setNameBusy(false);
            if (_isSessionEnded(resp)) {
                return;
            }
            if (!resp || resp.status !== true) {
                const msg = (resp && resp.msg) || 'Your name could not be saved.';
                if (errorCodeOf(resp) === ACCOUNT_ERROR_CODES.VALIDATION) {
                    setNameError(msg);
                    return;
                }
                setNameResult({ tone: 'critical', text: msg });
                return;
            }
            let saved = trimmed;
            if (resp.data && resp.data.user && typeof resp.data.user.name === 'string') {
                saved = resp.data.user.name;
            }
            setNameDraft(saved);
            setNameResult({ tone: 'success', text: 'Your name was updated.' });
            // The top bar reads the name from the session.
            refresh();
        });
    }, [nameValue, refresh]);

    /**
     * Changes the password, then stores the fresh token the server issues for this browser.
     *
     * @returns {void}
     */
    const changePassword = useCallback(() => {
        setPasswordAttempted(true);
        setPasswordResult(null);
        setCurrentPasswordError('');
        setNewPasswordError('');

        if (!currentPassword) {
            setCurrentPasswordError('Enter your current password.');
            return;
        }
        const pairError = passwordPairError(newPassword, confirmPassword);
        if (pairError) {
            setNewPasswordError(pairError);
            return;
        }

        setPasswordBusy(true);
        ACCOUNT_API.changePassword(currentPassword, newPassword).then((resp) => {
            setPasswordBusy(false);
            if (_isSessionEnded(resp)) {
                return;
            }
            if (!resp || resp.status !== true) {
                const code = errorCodeOf(resp);
                const msg = (resp && resp.msg) || 'Your password could not be changed.';
                if (code === ACCOUNT_ERROR_CODES.CURRENT_PASSWORD_INCORRECT) {
                    setCurrentPassword('');
                    setCurrentPasswordError(msg);
                    return;
                }
                if (code === ACCOUNT_ERROR_CODES.PASSWORD_POLICY) {
                    setNewPasswordError(msg);
                    return;
                }
                setPasswordResult({ tone: 'critical', text: msg });
                return;
            }

            // FIRST, before any other request: the token this browser held died with the change.
            const kept = applyFreshToken(resp.data);
            setCurrentPassword('');
            setNewPassword('');
            setConfirmPassword('');
            setPasswordAttempted(false);
            if (!kept) {
                setPasswordResult({ tone: 'warning', text: `Your password was changed. ${SIGNED_OUT_HERE_MESSAGE}`, signIn: true });
                return;
            }
            setPasswordResult({
                tone: 'success',
                text: 'Your password was changed. Every other browser and device signed in to this account has been signed out; this one stays signed in.'
            });
        });
    }, [currentPassword, newPassword, confirmPassword, applyFreshToken]);

    /**
     * Signs out every other session, then stores the fresh token issued for this browser.
     *
     * @returns {void}
     */
    const revokeOtherSessions = useCallback(() => {
        setSessionsResult(null);
        setSessionsBusy(true);
        ACCOUNT_API.revokeOtherSessions().then((resp) => {
            setSessionsBusy(false);
            if (_isSessionEnded(resp)) {
                return;
            }
            if (!resp || resp.status !== true) {
                setSessionsResult({ tone: 'critical', text: (resp && resp.msg) || 'Your other sessions could not be signed out.' });
                return;
            }

            const kept = applyFreshToken(resp.data);
            if (!kept) {
                setSessionsResult({ tone: 'warning', text: `Your other sessions were signed out. ${SIGNED_OUT_HERE_MESSAGE}`, signIn: true });
                return;
            }

            // The count is what the server says it revoked; with no count, say what is certain.
            let text = 'Every other browser and device signed in to this account has been signed out. This one stays signed in.';
            const revoked = resp.data ? resp.data.revoked : undefined;
            if (typeof revoked === 'number' && Number.isFinite(revoked)) {
                if (revoked === 0) {
                    text = 'No other session was signed in to this account. This one stays signed in.';
                } else if (revoked === 1) {
                    text = 'Signed out 1 other session. This one stays signed in.';
                } else {
                    text = `Signed out ${revoked} other sessions. This one stays signed in.`;
                }
            }
            setSessionsResult({ tone: 'success', text: text });
        });
    }, [applyFreshToken]);

    /**
     * Ends this session: on the server (best effort), then locally, then a full reload onto /login.
     *
     * @returns {void}
     */
    const signOut = useCallback(() => {
        setSigningOut(true);
        logout();
    }, [logout]);

    /**
     * A card's result Banner.
     *
     * @param {Object|null} result - `{ tone, text, signIn? }`.
     * @param {Function} clear - Dismisses it.
     * @returns {JSX.Element|null}
     */
    const _resultBanner = (result, clear) => {
        if (!result) {
            return null;
        }
        let action;
        if (result.signIn) {
            action = { content: 'Sign in again', onAction: signOut, loading: signingOut };
        }
        return (
            <Banner tone={result.tone} onDismiss={result.signIn ? undefined : clear} action={action}>
                <p>{result.text}</p>
            </Banner>
        );
    };

    let roleNote = 'Your role is set by an Owner or Admin on the Users & roles page.';
    if (role.is_owner === true) {
        roleNote = 'You own this install. Ownership can only be moved with the recovery command-line tool, never from this dashboard.';
    }

    let sessionExpiry = '—';
    if (session.session && session.session.expires_at) {
        sessionExpiry = _formatWhen(session.session.expires_at);
    }

    return (
        <SideNavBar>
            <Page title="Account" subtitle="Your name, your password and where you are signed in.">
                <Layout>
                    <Layout.AnnotatedSection
                        title="Profile"
                        description="Your email address is how you sign in and where password emails are sent. It cannot be changed here."
                    >
                        <Card>
                            <BlockStack gap="400">
                                <BlockStack gap="100">
                                    <FactLine label="Email" value={email || '—'} />
                                    <FactLine label="Role" value={role.label || '—'} />
                                    <FactLine label="Member since" value={_formatWhen(user.created_at)} />
                                    <FactLine label="Last sign-in" value={_formatWhen(user.last_login_at)} />
                                    <Text as="p" variant="bodySm" tone="subdued">{roleNote}</Text>
                                </BlockStack>
                                {_resultBanner(nameResult, () => setNameResult(null))}
                                <Form onSubmit={saveName}>
                                    <FormLayout>
                                        <TextField
                                            label="Name"
                                            value={nameValue}
                                            onChange={(value) => {
                                                setNameDraft(value);
                                                setNameError('');
                                            }}
                                            autoComplete="name"
                                            maxLength={100}
                                            error={nameError || undefined}
                                            disabled={nameBusy}
                                        />
                                        <InlineStack>
                                            <Button submit variant="primary" loading={nameBusy} disabled={!nameChanged || nameBusy}>
                                                Save name
                                            </Button>
                                        </InlineStack>
                                    </FormLayout>
                                </Form>
                            </BlockStack>
                        </Card>
                    </Layout.AnnotatedSection>

                    <Layout.AnnotatedSection
                        title="Password"
                        description="Changing it signs out every other browser and device signed in to this account. This one stays signed in."
                    >
                        <Card>
                            <BlockStack gap="400">
                                {_resultBanner(passwordResult, () => setPasswordResult(null))}
                                <Form onSubmit={changePassword}>
                                    <FormLayout>
                                        {/* For password managers: which account this new password belongs to. */}
                                        <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
                                        <TextField
                                            label="Current password"
                                            type="password"
                                            value={currentPassword}
                                            onChange={(value) => {
                                                setCurrentPassword(value);
                                                setCurrentPasswordError('');
                                            }}
                                            autoComplete="current-password"
                                            error={currentPasswordError || undefined}
                                            disabled={passwordBusy}
                                        />
                                        <PasswordFields
                                            password={newPassword}
                                            confirm={confirmPassword}
                                            onPasswordChange={(value) => {
                                                setNewPassword(value);
                                                setNewPasswordError('');
                                            }}
                                            onConfirmChange={setConfirmPassword}
                                            disabled={passwordBusy}
                                            showMismatch={passwordAttempted}
                                        />
                                        {newPasswordError ? (
                                            <Text as="p" variant="bodySm" tone="critical">{newPasswordError}</Text>
                                        ) : null}
                                        <InlineStack>
                                            <Button submit variant="primary" loading={passwordBusy} disabled={passwordBusy}>
                                                Change password
                                            </Button>
                                        </InlineStack>
                                    </FormLayout>
                                </Form>
                            </BlockStack>
                        </Card>
                    </Layout.AnnotatedSection>

                    <Layout.AnnotatedSection
                        title="Sessions"
                        description="Signed in on a shared or lost device? Sign every other session out. This browser stays signed in."
                    >
                        <Card>
                            <BlockStack gap="400">
                                {_resultBanner(sessionsResult, () => setSessionsResult(null))}
                                <FactLine label="This session expires" value={sessionExpiry} />
                                <InlineStack gap="200">
                                    <Button loading={sessionsBusy} disabled={sessionsBusy} onClick={revokeOtherSessions}>
                                        Sign out my other sessions
                                    </Button>
                                    <Button tone="critical" loading={signingOut} disabled={signingOut} onClick={signOut}>
                                        Sign out
                                    </Button>
                                </InlineStack>
                            </BlockStack>
                        </Card>
                    </Layout.AnnotatedSection>
                </Layout>
            </Page>
        </SideNavBar>
    );
};

export default AccountPage;
