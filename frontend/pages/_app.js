/* Order matters: our own sheets first, Polaris last, so that on any tie Polaris
   wins and a local rule has to be deliberately more specific to override it. */
import '../styles/globals.css';
import '../public/css/custom_loader.css';
import '../public/css/index.css';
import '@shopify/polaris/build/esm/styles.css';
import enTranslations from '@shopify/polaris/locales/en.json';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { AppProvider, Banner, BlockStack, Button, Card, InlineStack, Modal, Page, Text, Toast } from '@shopify/polaris';

import LoaderContext from '../contexts/loaderContext';
import { GrowthIntelProvider } from '../contexts/growthIntelContext';
import { SESSION_STATES, SessionProvider, useSession } from '../contexts/sessionContext';
import SideNavBar from '../components/sideNavBar';
import { hasAuthToken } from '../utils/auth';
import { canViewPage, landingRouteFor, pagePermissionsFor, permissionLabel } from '../utils/permissions';
import { AUTH_ROUTES, isPublicRoute } from '../utils/publicRoutes';

/** Default lifetime of a toast, in ms. Callers may pass their own. */
const DEFAULT_TOAST_DURATION = 1500;

/**
 * Shown in place of the page when the account could not be read. No nav: the nav is filtered by the
 * role, and the role is exactly what we do not know.
 *
 * ⚠️ IT NEVER SIGNS ANYBODY OUT ON ITS OWN. A 503 while the datastore restarts is not a reason to
 * throw away a good token; "Sign out" is offered, never performed.
 *
 * @param {Object} props
 * @param {String} props.message - The server's sentence, or the context's fallback.
 * @param {Function} props.onRetry - `session.refresh`; returns a promise.
 * @param {Function} props.onSignOut - `session.logout`.
 * @returns {JSX.Element}
 */
const AccountLoadError = ({ message, onRetry, onSignOut }) => {
    const [busy, setBusy] = useState(false);

    const retry = () => {
        setBusy(true);
        Promise.resolve(onRetry()).then(() => setBusy(false));
    };

    return (
        <div className="login-viewport">
            <div className="login-panel">
                <Card>
                    <BlockStack gap="400">
                        <Text as="h1" variant="headingLg">Could not load your account</Text>
                        <Banner tone="critical">
                            <p>{message}</p>
                        </Banner>
                        <Text as="p" variant="bodyMd" tone="subdued">
                            You are still signed in. Nothing is shown until your role is known: a page drawn without
                            it would offer actions your role may not allow, or hide ones it does.
                        </Text>
                        <InlineStack gap="200">
                            <Button variant="primary" loading={busy} onClick={retry}>Retry</Button>
                            <Button onClick={onSignOut}>Sign out</Button>
                        </InlineStack>
                    </BlockStack>
                </Card>
            </div>
        </div>
    );
};

/**
 * Shown in place of a page the signed-in role cannot open. The page component is NEVER mounted, so
 * none of its requests fire — a page that mounted and then got 403 on every section would read as a
 * broken dashboard rather than as a closed door.
 *
 * Inside the normal shell, so the nav (already filtered to what the role can open) is the way on.
 *
 * @param {Object} props
 * @param {String} props.pathname - The page that was refused.
 * @returns {JSX.Element}
 */
const RestrictedPage = ({ pathname }) => {
    const router = useRouter();
    const { role, permissions } = useSession();

    let roleLabel = 'your role';
    if (role && role.label) {
        roleLabel = role.label;
    }

    const required = pagePermissionsFor(pathname);
    let explanation = 'This page is not registered in the dashboard\'s permission map, so it is closed to every role. That is a build problem, not a statement about your access.';
    if (required !== null && required.length > 0) {
        const needed = required.map((key) => permissionLabel(key)).join(' or ');
        explanation = `This page needs ${needed}, which the ${roleLabel} role does not include.`;
    }

    return (
        <SideNavBar>
            <Page title="Restricted" narrowWidth>
                <Card>
                    <BlockStack gap="300">
                        <Text as="h2" variant="headingMd">{`Your role (${roleLabel}) does not open this page`}</Text>
                        <Text as="p" variant="bodyMd">{explanation}</Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                            Nothing on it was loaded. An Owner or Admin can change your role.
                        </Text>
                        <InlineStack>
                            <Button variant="primary" onClick={() => router.replace(landingRouteFor(permissions))}>
                                Go to a page you can open
                            </Button>
                        </InlineStack>
                    </BlockStack>
                </Card>
            </Page>
        </SideNavBar>
    );
};

/**
 * Holds a protected page until the account is read, then mounts it — or says why it will not.
 *
 * @param {Object} props
 * @param {String} props.pathname - `router.pathname`.
 * @param {React.ReactNode} props.children - The page.
 * @returns {JSX.Element|null}
 */
const SessionGate = ({ pathname, children }) => {
    const session = useSession();

    // Nothing, as the token gate renders nothing while it checks: a page drawn before the role is
    // known is a page that flashes buttons it is about to take away.
    if (session.state === SESSION_STATES.LOADING) {
        return null;
    }
    if (session.state === SESSION_STATES.ERROR) {
        return <AccountLoadError message={session.error} onRetry={session.refresh} onSignOut={session.logout} />;
    }
    if (!canViewPage(session.permissions, pathname)) {
        return <RestrictedPage pathname={pathname} />;
    }
    return children;
};

/**
 * Application root: global styles, the Polaris provider, the shared loader/toast
 * context, the signed-in session, the partner-app selection, and the gates.
 *
 * ── THE GATES ───────────────────────────────────────────────────────────────
 * Three checks, in order, and every one of them is needed:
 *
 *   1. HERE, before render — no token means no protected page is ever mounted, so
 *      a signed-out visitor never fires a request that is guaranteed to 401 and
 *      never sees a flash of an empty dashboard.
 *   2. HERE, after the token — the page waits for `GET /api/account`, then mounts
 *      only if the role opens it (`canViewPage`); otherwise "Restricted" is drawn
 *      in its place. See `SessionGate`.
 *   3. In the axios client — a token that EXISTS but has expired or been revoked
 *      only fails at the API, so the 401 interceptor is what catches that case.
 *
 * None of this is a security boundary: nothing here protects data, because no
 * data is here — every figure comes from an API call the backend authenticates
 * AND authorises for itself, per request. Do not let these gates become an
 * argument for relaxing that.
 *
 * ⚠️ WHY THE GATE STARTS AS 'checking' ON THE SERVER TOO. `localStorage` cannot be
 * read during SSR, so the answer is unknowable until the component mounts. The
 * gate therefore renders nothing for a protected route on BOTH the server and the
 * first client paint, and only then resolves — which is what keeps server and
 * client markup identical. Rendering the page and hiding it afterwards would
 * hydrate mismatched trees and briefly show protected chrome.
 *
 * @param {Object} props - Next.js app props.
 * @param {React.ComponentType} props.Component - The page component being rendered.
 * @param {Object} props.pageProps - Props for that page.
 * @returns {JSX.Element} The fully provided application tree.
 */
function WrappedApp({ Component, pageProps }) {
    const router = useRouter();

    const [showLoader, setShowLoader] = useState(false);
    const [toastActive, setToastActive] = useState(false);
    const [toastMessage, setToastMessage] = useState('');
    const [toastErrorMessage, setToastErrorMessage] = useState(false);
    const [toastActiveDuration, setToastActiveDuration] = useState(DEFAULT_TOAST_DURATION);

    // 'checking' until the token has been looked for; 'allowed' once it has been found.
    // A missing token never reaches 'allowed' — it navigates away instead.
    const [gateState, setGateState] = useState('checking');

    // `utils/publicRoutes.js` is the one list of pages reachable without a session — the sign-in,
    // setup, invitation and password-reset screens, plus `/404` and `/_error` so a signed-out
    // visitor who mistypes a URL gets the error page rather than a blank one.
    const isPublic = isPublicRoute(router.pathname);

    // ⚠️ Fires the redirect at most once per protected visit. `useRouter()` hands back a NEW
    // object on each root render, so `router` in the dependency array can re-run this effect
    // before the navigation it already started has committed — and a second `replace` to the
    // same URL while the first is in flight is how a redirect turns into a loop.
    const redirectStartedRef = useRef(false);

    useEffect(() => {
        if (isPublic) {
            // Back on a public route: arm the guard again for the next protected visit.
            redirectStartedRef.current = false;
            return;
        }
        if (hasAuthToken()) {
            setGateState('allowed');
            return;
        }
        if (redirectStartedRef.current) {
            return;
        }
        redirectStartedRef.current = true;
        // `replace`, not `push`: the page they could not open should not be a back-button
        // destination that bounces them straight here again.
        // `asPath` rather than `pathname` so the query string survives the round trip — but never
        // the fragment: emailed links carry their token there, and `next` is echoed into the URL.
        router.replace({ pathname: AUTH_ROUTES.LOGIN, query: { next: router.asPath.split('#')[0] } });
    }, [isPublic, router]);

    /**
     * Shows a toast. Passed to every page through LoaderContext.
     *
     * @param {String} msg - Text to display.
     * @param {Boolean} errorMsg - True renders the toast in the error tone.
     * @param {Number} duration - Lifetime in ms.
     * @returns {void}
     */
    const constructToastStates = (msg, errorMsg, duration) => {
        setToastMessage(msg);
        setToastErrorMessage(errorMsg);
        setToastActive(true);
        setToastActiveDuration(duration || DEFAULT_TOAST_DURATION);
    };

    let toastMarkup = null;
    if (toastActive) {
        toastMarkup = (
            <Toast
                content={toastMessage}
                error={toastErrorMessage}
                duration={toastActiveDuration}
                onDismiss={() => setToastActive(false)}
            />
        );
    }

    // Pages render the toast themselves (`const { toastMarkup } = useContext(LoaderContext)`),
    // because a Polaris Toast must sit inside the Frame the page's nav provides.
    const loaderContextValue = {
        showLoader: setShowLoader,
        fetching: showLoader,
        showToast: constructToastStates,
        toastMarkup: toastMarkup
    };

    const sessionEnabled = !isPublic && gateState === 'allowed';

    let content = null;
    if (isPublic) {
        content = <Component {...pageProps} />;
    } else if (gateState === 'allowed') {
        content = (
            <SessionGate pathname={router.pathname}>
                <Component {...pageProps} />
            </SessionGate>
        );
    }

    return (
        <AppProvider i18n={enTranslations}>
            <LoaderContext.Provider value={loaderContextValue}>
                <SessionProvider enabled={sessionEnabled}>
                    <GrowthIntelProvider>
                        {content}
                    </GrowthIntelProvider>
                </SessionProvider>
            </LoaderContext.Provider>

            <Modal titleHidden noScroll open={showLoader} size="small" onClose={() => setShowLoader(false)}>
                <div className="custom-loader-container">
                    <div className="custom-loader" />
                    <p>Loading…</p>
                </div>
            </Modal>
        </AppProvider>
    );
}

export default WrappedApp;
