/* Order matters: our own sheets first, Polaris last, so that on any tie Polaris
   wins and a local rule has to be deliberately more specific to override it. */
import '../styles/globals.css';
import '../public/css/custom_loader.css';
import '../public/css/index.css';
import '@shopify/polaris/build/esm/styles.css';
import enTranslations from '@shopify/polaris/locales/en.json';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { AppProvider, Modal, Toast } from '@shopify/polaris';

import LoaderContext from '../contexts/loaderContext';
import { GrowthIntelProvider } from '../contexts/growthIntelContext';
import { hasAuthToken } from '../utils/auth';

/**
 * Routes reachable without a session.
 *
 * `/login` is the real one. `/404` and `/_error` are here so a signed-out visitor
 * who mistypes a URL gets the error page rather than the blank screen the gate
 * would otherwise hold them on — a gate that hides Next's own error pages makes
 * every mistake look like the same broken app.
 */
const PUBLIC_ROUTES = ['/login', '/404', '/_error'];

/** Default lifetime of a toast, in ms. Callers may pass their own. */
const DEFAULT_TOAST_DURATION = 1500;

/**
 * Application root: global styles, the Polaris provider, the shared loader/toast
 * context, the partner-app selection, and the authentication gate.
 *
 * ── THE GATE ────────────────────────────────────────────────────────────────
 * There are two independent checks, and both are needed:
 *
 *   1. HERE, before render — no token means no protected page is ever mounted, so
 *      a signed-out visitor never fires a request that is guaranteed to 401 and
 *      never sees a flash of an empty dashboard.
 *   2. In the axios client — a token that EXISTS but has expired only fails at
 *      the API, so the 401 interceptor is what catches that case.
 *
 * This one is a convenience and a UX guard. It is not a security boundary: nothing
 * here protects data, because no data is here — every figure comes from an API
 * call the backend authenticates for itself. Do not let the presence of this gate
 * become an argument for relaxing that one.
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

    const isPublicRoute = PUBLIC_ROUTES.includes(router.pathname);

    // ⚠️ Fires the redirect at most once per protected visit. `useRouter()` hands back a NEW
    // object on each root render, so `router` in the dependency array can re-run this effect
    // before the navigation it already started has committed — and a second `replace` to the
    // same URL while the first is in flight is how a redirect turns into a loop.
    const redirectStartedRef = useRef(false);

    useEffect(() => {
        if (isPublicRoute) {
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
        // `asPath` rather than `pathname` so the query string survives the round trip.
        router.replace({ pathname: '/login', query: { next: router.asPath } });
    }, [isPublicRoute, router]);

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

    let content = null;
    if (isPublicRoute || gateState === 'allowed') {
        content = <Component {...pageProps} />;
    }

    return (
        <AppProvider i18n={enTranslations}>
            <LoaderContext.Provider value={loaderContextValue}>
                <GrowthIntelProvider>
                    {content}
                </GrowthIntelProvider>
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
