import { useEffect, useRef } from 'react';
import { useRouter } from 'next/router';

import { hasAuthToken } from '../utils/auth';
import { DASHBOARD_HOME } from '../utils/dashboardRoutes';

/**
 * =============================================================================
 *  `/` — a signpost, not a screen. It renders nothing and forwards.
 * =============================================================================
 *
 *  The dashboard has one home page — `/overview`, the Overview — and this is
 *  not it. The root exists only to send a visitor to the right one of two places,
 *  and it does that instead of rendering a third thing to look at.
 *
 *  ── WHY THE OVERVIEW, AND WHY IT USED TO BE REVENUE ─────────────────────────
 *  This pointed at REVENUE for as long as the Overview was a contents page:
 *  landing a first-time operator on a list of links, none of which says anything
 *  until it is clicked, reads as a deployment with nothing to show, and Revenue was
 *  the densest screen that filled in from a single sync.
 *
 *  The Overview carries figures of its own now — installs, uninstalls, reinstalls
 *  and gross revenue for the selected app, with the install trend under them — so
 *  the argument that sent people past it no longer holds. It answers the question an
 *  operator arrives with in fewer figures than Revenue does, and it is the first
 *  screen the nav lists, so the section reads top to bottom from where you land. A
 *  home page nobody lands on is not a home page.
 *
 *  ⚠️ THE DESTINATION IS NOT WRITTEN HERE. It is `DASHBOARD_HOME` in
 *  `utils/dashboardRoutes.js`, and `pages/login.js` reads the SAME constant. Those
 *  two are the only places that choose a landing screen, and they used to hold
 *  matching literals under a comment saying "change both or neither" — which is a
 *  rule a reader has to notice. Sharing the constant is the version that cannot be
 *  half-applied: where an operator ends up no longer depends on whether they
 *  arrived already signed in.
 *
 *  ── THE SIGNED-OUT BRANCH IS USUALLY UNREACHABLE, AND STAYS ANYWAY ──────────
 *  `/` is not in `PUBLIC_ROUTES`, so the auth gate in `_app.js` normally redirects
 *  a token-less visitor to `/login?next=/` before this component ever mounts. The
 *  branch below is kept because this page must be correct about `/` on its own:
 *  if that route list or the gate's shape ever changes, the root must still not
 *  forward a signed-out visitor into a page whose every request will 401.
 *
 *  (When the gate does act first, the round trip is `/` → `/login?next=/` → `/` →
 *  the Overview. Two hops, terminating: `resolveDestination` in login.js passes
 *  `/` through unchanged, and this page then forwards it on.)
 * =============================================================================
 */

/** Where a signed-in visitor lands — the same constant `pages/login.js` sends people to. */
const AUTHENTICATED_DESTINATION = DASHBOARD_HOME;

/** Where a signed-out visitor lands. Matches the public route in `_app.js`. */
const LOGIN_ROUTE = '/login';

/**
 * Root route. Forwards to the Overview when a session token is present, to the
 * login screen when it is not, and renders nothing either way.
 *
 * @returns {null} Never any markup — see the header on why there is no third screen.
 */
const RootRedirect = () => {
    const router = useRouter();

    // ⚠️ Fires the navigation at most once. `useRouter()` returns a NEW object on every render, so
    // `router` in the dependency array can re-run this effect before the replace it already started
    // has committed — and a second replace to the same URL while the first is in flight is how a
    // redirect turns into a loop. Same guard, for the same reason, as `_app.js` and `login.js`.
    const redirectStartedRef = useRef(false);

    useEffect(() => {
        if (redirectStartedRef.current) {
            return;
        }
        redirectStartedRef.current = true;

        // `hasAuthToken` only proves a token EXISTS. An expired one still forwards to the Overview,
        // whose first request 401s, and the axios interceptor sends the operator to /login with the
        // dead token cleared. That round trip is correct: only the API can say whether a token is good.
        let destination = LOGIN_ROUTE;
        if (hasAuthToken()) {
            destination = AUTHENTICATED_DESTINATION;
        }

        // `replace`, not `push`: `/` is a signpost, and the back button should not return the
        // operator to it only to be forwarded again.
        router.replace(destination);
    }, [router]);

    // Nothing, on the server and on the first client paint alike. `localStorage` cannot be read
    // during SSR, so the destination is unknowable until mount — rendering a placeholder and
    // swapping it would hydrate a tree that says something this page has no way to know yet.
    return null;
};

export default RootRedirect;
