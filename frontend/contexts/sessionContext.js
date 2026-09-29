import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import AccountApiService from '../API_Services/accountService';
import { onForbiddenResponse } from '../API_Services/apiClient';
import { AUTH_TOKEN_KEY, clearAuthToken, getAuthToken, setAuthToken } from '../utils/auth';
import { PERMISSION_KEYS, holdsAny } from '../utils/permissions';
import { AUTH_ROUTES } from '../utils/publicRoutes';

/**
 * =============================================================================
 *  Who is signed in, and what their role lets the UI offer them.
 * =============================================================================
 *
 *  Read from `GET /api/account` once the auth gate in `_app.js` lets a
 *  protected page through, and published to every page and to the nav. The
 *  backend re-reads the role on EVERY request and never puts permissions in the
 *  token, so this copy is only ever a picture of the role as of the last read —
 *  good for deciding what to draw, never for deciding what is allowed.
 *
 *  ── THREE STATES, AND 'error' IS NOT "NO PERMISSIONS" ───────────────────────
 *    loading  Nothing has been read yet for this token. `_app.js` renders no
 *             protected page at all, so no page ever draws a button its role
 *             does not have and then takes it away (or the reverse).
 *    ready    `user`, `role` and `permissions` are a real answer.
 *    error    The FIRST read failed (a 503 while the datastore is down, a
 *             dropped connection). `_app.js` renders "Could not load your
 *             account" with Retry. It is NEVER treated as an empty role — that
 *             would render "Restricted" over every page and tell a user their
 *             access was removed because a request failed — and it never signs
 *             anybody out: the token may be perfectly good.
 *
 *  A failed REFRESH after a successful read keeps the account it already has.
 *  Stale beats absent here for the same reason it does for the partner-app
 *  roster: the worst case of a stale role is a button that answers 403 on the
 *  click, which the backend enforces anyway, while blanking the app over a
 *  background refresh would unmount whatever the user was doing.
 *
 *  ── WHEN IT RE-READS ────────────────────────────────────────────────────────
 *  · When the tab becomes visible again — an admin may have changed the role
 *    while it was in the background.
 *  · When the API refuses a permission, at most once per 30 s. A 403 on
 *    something the nav offered almost always means the role changed since the
 *    last read. The axios client reports every 403 from every service
 *    (`onForbiddenResponse`), so no page has to remember to; `reportForbidden`
 *    stays for callers that want to say so explicitly.
 *  · When the stored token is not the one the held account was read with —
 *    another tab signed out, or signed in as somebody else (localStorage is
 *    shared between tabs, and every request reads the token afresh). The held
 *    account is dropped FIRST, and until the new read answers the state reads
 *    'loading', so one user's role is never drawn over another's requests.
 *  · After `applyFreshToken`.
 * =============================================================================
 */

/** The three states. Compare against these, never against literals. */
export const SESSION_STATES = Object.freeze({
    LOADING: 'loading',
    READY: 'ready',
    ERROR: 'error'
});

/**
 * The partner-app selection's localStorage key.
 *
 * ⚠️ THE SAME LITERAL AS `STORAGE_KEY` IN `contexts/growthIntelContext.js`, which does not export
 * it. Sign-out clears it so the next person to sign in on this browser does not open on the last
 * one's app. Rename one, rename both.
 */
const PARTNER_APP_STORAGE_KEY = 'gi.partnerAppId';

/** The shortest gap between two permission-triggered re-reads. */
const FORBIDDEN_REFRESH_INTERVAL_MS = 30 * 1000;

/** Shown when the account read failed and the server said nothing of its own. */
const ACCOUNT_ERROR_FALLBACK = 'Your account could not be loaded.';

/** Handed out whenever there is no answer, so a consumer never has to null-check. */
const EMPTY_PERMISSIONS = Object.freeze([]);

const ACCOUNT_API = new AccountApiService();

/**
 * Forgets the partner-app selection. Storage may be blocked; that must not stop a sign-out.
 *
 * @returns {void}
 */
const _clearPartnerAppSelection = () => {
    if (typeof window === 'undefined') {
        return;
    }
    try {
        window.localStorage.removeItem(PARTNER_APP_STORAGE_KEY);
    } catch (e) { /* storage blocked — nothing was stored to forget */ }
};

/**
 * The local half of signing out: drop the credential and the selection, then leave with a full
 * document load.
 *
 * `window.location.replace` rather than the router, because in-memory state — the roster in
 * `growthIntelContext`, this context's account, whatever each page holds — survives a client-side
 * navigation, and a sign-out that leaves the previous user's figures in the tab is not one.
 *
 * @returns {void}
 */
const _signOutLocally = () => {
    clearAuthToken();
    _clearPartnerAppSelection();
    if (typeof window === 'undefined') {
        return;
    }
    window.location.replace(AUTH_ROUTES.LOGIN);
};

/**
 * Validates a `GET /api/account` envelope into the shape this context holds.
 *
 * Permission keys this copy of the catalogue does not know are DROPPED: the UI gates only on keys
 * it knows, so an unknown one grants nothing here, and keeping it would only put a string into
 * `permissions` that no check will ever match. Never widened, only narrowed.
 *
 * @param {Object} resp - The resolved envelope.
 * @returns {Object|null} `{ user, role, permissions, session }`, or null when it is not an account.
 */
const _readAccount = (resp) => {
    if (!resp || resp.status !== true || !resp.data || typeof resp.data !== 'object') {
        return null;
    }
    const data = resp.data;
    if (!data.user || typeof data.user !== 'object' || !data.role || typeof data.role !== 'object') {
        return null;
    }
    if (!Array.isArray(data.permissions)) {
        return null;
    }

    const permissions = data.permissions.filter((key) => typeof key === 'string' && PERMISSION_KEYS.includes(key));

    let roleLabel = data.role.label;
    if (typeof roleLabel !== 'string' || !roleLabel) {
        roleLabel = typeof data.role.key === 'string' ? data.role.key : 'your role';
    }

    let session = null;
    if (data.session && typeof data.session === 'object') {
        session = {
            session_id: data.session.session_id || null,
            expires_at: data.session.expires_at || null
        };
    }

    return {
        user: {
            user_id: data.user.user_id || null,
            email: typeof data.user.email === 'string' ? data.user.email : '',
            name: typeof data.user.name === 'string' ? data.user.name : '',
            created_at: data.user.created_at || null,
            last_login_at: data.user.last_login_at || null
        },
        role: {
            key: typeof data.role.key === 'string' ? data.role.key : '',
            label: roleLabel,
            is_owner: data.role.is_owner === true
        },
        permissions: Object.freeze(permissions),
        session: session
    };
};

/**
 * What a consumer sees with no provider above it: nothing is known and nothing is granted. Sign-out
 * still works, locally — a control that says "Log out" must never do nothing.
 */
const DEFAULT_SESSION = Object.freeze({
    state: SESSION_STATES.LOADING,
    user: null,
    role: null,
    permissions: EMPTY_PERMISSIONS,
    session: null,
    error: '',
    can: () => false,
    canAny: () => false,
    refresh: () => Promise.resolve(),
    logout: () => {
        _signOutLocally();
        return Promise.resolve();
    },
    applyFreshToken: () => false,
    reportForbidden: () => {}
});

const SessionContext = createContext(DEFAULT_SESSION);

/**
 * Provides the signed-in user's account to everything beneath it.
 *
 * @param {Object} props
 * @param {Boolean} props.enabled - True once the auth gate has let a protected page through (a token
 *   is present and the route is not public). Nothing is fetched while false.
 * @param {React.ReactNode} props.children
 * @returns {JSX.Element}
 */
export const SessionProvider = ({ enabled, children }) => {
    const [state, setStateValue] = useState(SESSION_STATES.LOADING);
    const [account, setAccount] = useState(null);
    const [error, setError] = useState('');

    // Mirrors of state for the window/document listeners, which must not be re-bound on every read.
    const stateRef = useRef(SESSION_STATES.LOADING);
    const hasAccountRef = useRef(false);
    // The token the held account was read with. null until the first read is started.
    const loadedTokenRef = useRef(null);
    // ONLY THE LATEST READ MAY WRITE STATE. `applyFreshToken` issues a read while an older one (made
    // with the now-dead token) may still be in flight; without this counter the older answer could
    // land last and win.
    const requestSeqRef = useRef(0);
    const inFlightRef = useRef(null);
    const lastForbiddenRefreshRef = useRef(0);
    const loggingOutRef = useRef(false);

    const _setState = useCallback((next) => {
        stateRef.current = next;
        setStateValue(next);
    }, []);

    /**
     * Issues one account read and records what it answered.
     *
     * @returns {Promise<void>} Settles when the read has been applied. Never rejects.
     */
    const _fetchAccount = useCallback(() => {
        const seq = ++requestSeqRef.current;
        const request = ACCOUNT_API.getAccount().then((resp) => {
            if (seq !== requestSeqRef.current) {
                return;
            }
            inFlightRef.current = null;

            // 401: the axios interceptor has cleared the token and is already navigating to /login.
            // Draw nothing new — an error page flashing up during that navigation reads as a fault.
            if (resp && resp.resource_access === 'NOT_ALLOWED') {
                return;
            }

            const parsed = _readAccount(resp);
            if (parsed) {
                hasAccountRef.current = true;
                setAccount(parsed);
                setError('');
                _setState(SESSION_STATES.READY);
                return;
            }

            if (hasAccountRef.current) {
                console.log('session: account refresh failed; keeping the account already read', resp && resp.msg);
                return;
            }
            setError((resp && resp.msg) || ACCOUNT_ERROR_FALLBACK);
            _setState(SESSION_STATES.ERROR);
        });
        inFlightRef.current = request;
        return request;
    }, [_setState]);

    /**
     * Re-reads the account. Joins a read already in flight rather than starting a second.
     *
     * Does NOT move the state back to 'loading': a refresh must never unmount the page the user is
     * on. From 'error' it is the Retry, and the error page shows its own busy state meanwhile.
     *
     * @returns {Promise<void>} Never rejects.
     */
    const refresh = useCallback(() => {
        if (inFlightRef.current) {
            return inFlightRef.current;
        }
        return _fetchAccount();
    }, [_fetchAccount]);

    /**
     * Starts a fresh first read when the stored credential is not the one the held account came from.
     *
     * A DIFFERENT CREDENTIAL IS A DIFFERENT PERSON until proven otherwise, so what is held is dropped
     * BEFORE asking and the state goes back to 'loading': the gate holds the page rather than drawing
     * the previous user's role. An EMPTY stored token is read too — the request then answers 401 and
     * the axios client takes this tab to /login, which is the right end for a tab whose session was
     * signed out elsewhere.
     *
     * @returns {Boolean} True when a new read was started; false when the credential is unchanged.
     */
    const _followStoredToken = useCallback(() => {
        const token = getAuthToken();
        if (loadedTokenRef.current === token) {
            return false;
        }
        loadedTokenRef.current = token;
        hasAccountRef.current = false;
        setAccount(null);
        setError('');
        _setState(SESSION_STATES.LOADING);
        _fetchAccount();
        return true;
    }, [_fetchAccount, _setState]);

    // First read, once the auth gate lets a protected page through.
    useEffect(() => {
        if (!enabled) {
            return;
        }
        _followStoredToken();
    }, [enabled, _followStoredToken]);

    /**
     * Asks for a re-read because the API refused a permission — at most once per 30 s.
     *
     * Leading edge, not trailing: the first 403 refreshes at once (it is the one that tells us the
     * role changed), and the burst that follows it — a page with eight sections fires eight — does
     * not queue eight reads behind it.
     *
     * @returns {void}
     */
    const reportForbidden = useCallback(() => {
        if (stateRef.current !== SESSION_STATES.READY) {
            return;
        }
        const now = Date.now();
        if (now - lastForbiddenRefreshRef.current < FORBIDDEN_REFRESH_INTERVAL_MS) {
            return;
        }
        lastForbiddenRefreshRef.current = now;
        refresh();
    }, [refresh]);

    useEffect(() => {
        if (!enabled || typeof document === 'undefined') {
            return undefined;
        }
        const onVisibilityChange = () => {
            if (document.visibilityState !== 'visible') {
                return;
            }
            // Signed out or in as somebody else while hidden: a first read, not a refresh.
            if (_followStoredToken()) {
                return;
            }
            // Still on the first read: it is already in flight, and another would only race it.
            if (stateRef.current === SESSION_STATES.LOADING) {
                return;
            }
            refresh();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => document.removeEventListener('visibilitychange', onVisibilityChange);
    }, [enabled, refresh, _followStoredToken]);

    // Another tab changed the stored token. The `storage` event fires only in the OTHER tabs, so a
    // write made here (sign-in, `applyFreshToken`) never lands in this handler.
    useEffect(() => {
        if (!enabled || typeof window === 'undefined') {
            return undefined;
        }
        const onStorage = (event) => {
            // `key` is null when the other tab called `localStorage.clear()`.
            if (event.key !== AUTH_TOKEN_KEY && event.key !== null) {
                return;
            }
            _followStoredToken();
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, [enabled, _followStoredToken]);

    // Every 403 from every service. The subscription lives in the axios client, the one place that sees
    // them all; the listener only asks for a (throttled) re-read and never touches the response.
    useEffect(() => {
        if (!enabled) {
            return undefined;
        }
        return onForbiddenResponse(() => reportForbidden());
    }, [enabled, reportForbidden]);

    /**
     * Stores the fresh token the server issues after a password change or "sign out my other
     * sessions", and re-reads the account (its session id and expiry changed).
     *
     * ⚠️ CALL IT THE MOMENT THE RESPONSE ARRIVES. Those two calls move the account's session epoch,
     * which kills the token this browser was holding; any request made with the old one answers 401.
     * Once the fresh token is stored, such a 401 no longer signs anyone out (the axios client clears
     * storage only when the token that failed is still the stored one) — but until it is stored, it
     * does.
     *
     * The held account is KEPT (same person, new credential), so the page is not unmounted.
     *
     * @param {Object} tokenPayload - `{ token, expires_at, expires_in_seconds }` from the response's `data`.
     * @returns {Boolean} True when the token was stored. False when there was no token to store, or
     *   storage refused it — in which case the next request will sign the user out, and the caller
     *   should say so.
     */
    const applyFreshToken = useCallback((tokenPayload) => {
        let token = '';
        if (tokenPayload && typeof tokenPayload.token === 'string') {
            token = tokenPayload.token;
        }
        // Never write an empty value: `setAuthToken('')` CLEARS the stored token, which would sign
        // the user out over a response that merely lacked the field.
        if (!token) {
            return false;
        }
        setAuthToken(token);
        if (getAuthToken() !== token) {
            return false;
        }
        loadedTokenRef.current = token;
        _fetchAccount();
        return true;
    }, [_fetchAccount]);

    /**
     * Signs out: ends this session on the server (best effort, bounded), then drops the token and the
     * partner-app selection and reloads onto /login.
     *
     * The server call comes FIRST because it needs the token to say which session to end. It never
     * blocks the local half: the service resolves on failure and gives up after a few seconds.
     *
     * @returns {Promise<void>} Never rejects. The page is navigating away when it settles.
     */
    const logout = useCallback(() => {
        if (loggingOutRef.current) {
            return Promise.resolve();
        }
        loggingOutRef.current = true;
        return ACCOUNT_API.logout().then(() => {
            _signOutLocally();
        });
    }, []);

    const ready = state === SESSION_STATES.READY;
    let permissions = EMPTY_PERMISSIONS;
    if (ready && account) {
        permissions = account.permissions;
    }

    const can = useCallback((key) => permissions.includes(key), [permissions]);
    const canAny = useCallback((keys) => holdsAny(permissions, keys), [permissions]);

    const value = useMemo(() => ({
        state,
        user: account ? account.user : null,
        role: account ? account.role : null,
        permissions,
        session: account ? account.session : null,
        error,
        can,
        canAny,
        refresh,
        logout,
        applyFreshToken,
        reportForbidden
    }), [state, account, permissions, error, can, canAny, refresh, logout, applyFreshToken, reportForbidden]);

    return (
        <SessionContext.Provider value={value}>
            {children}
        </SessionContext.Provider>
    );
};

/**
 * Reads the signed-in user's session.
 *
 * `{ state, user, role, permissions, session, error, can(key), canAny(keys), refresh(), logout(),
 * applyFreshToken(tokenPayload), reportForbidden() }`. `permissions` is `[]` and `can` answers false
 * in every state but 'ready' — check `state` before reading an empty list as "no access".
 *
 * @returns {Object}
 */
export const useSession = () => useContext(SessionContext);

export default SessionContext;
