import { useEffect, useRef } from 'react';
import { useRouter } from 'next/router';

import { SESSION_STATES, useSession } from '../contexts/sessionContext';
import { hasAuthToken } from '../utils/auth';
import { landingRouteFor } from '../utils/permissions';
import { AUTH_ROUTES } from '../utils/publicRoutes';

/**
 * =============================================================================
 *  `/` — a signpost, not a screen. It renders nothing and forwards.
 * =============================================================================
 *
 *  The root exists only to send a visitor to the right place, and it does that
 *  instead of rendering a third thing to look at.
 *
 *  ── WHERE, AND WHY IT DEPENDS ON THE ROLE ───────────────────────────────────
 *  Signed in, the destination is `landingRouteFor(permissions)` in
 *  `utils/permissions.js`: the first screen, in nav order, that this user's role
 *  opens. Every built-in role holds `financials:read`, so for them that is the
 *  Overview, which answers the question an operator arrives with in the fewest
 *  figures. It used to be the fixed `DASHBOARD_HOME` — and a fixed home breaks the
 *  moment a role cannot open it: a custom role without `financials:read` (a
 *  sync-only operator, say) would land on "Restricted" as its first screen after
 *  signing in.
 *
 *  ⚠️ THE DESTINATION IS NOT WRITTEN HERE, and it must not be. The sign-in page
 *  sends a user to `/` (or to the page they asked for) and lets THIS page choose,
 *  so where somebody ends up never depends on whether they arrived already signed
 *  in, and the rule lives in one function.
 *
 *  ── THE SESSION IS READ BEFORE THIS MOUNTS, AND IS CHECKED ANYWAY ───────────
 *  `_app.js` holds every protected page until `GET /api/account` has answered,
 *  so by the time this runs the role is known. The state check below stays
 *  because this page must be correct about `/` on its own: forwarding on an
 *  unread role would compute a landing screen from `[]` and send everybody to
 *  `/account`.
 *
 *  ── THE SIGNED-OUT BRANCH IS USUALLY UNREACHABLE, AND STAYS ANYWAY ──────────
 *  `/` is not a public route, so the auth gate in `_app.js` normally redirects a
 *  token-less visitor to `/login?next=/` before this component ever mounts. The
 *  branch is kept for the same reason as the state check: if the gate's shape
 *  ever changes, the root must still not forward a signed-out visitor into a page
 *  whose every request will 401.
 * =============================================================================
 */

/**
 * Root route. Forwards to the first screen the signed-in role can open, or to the login screen when
 * there is no token, and renders nothing either way.
 *
 * @returns {null} Never any markup — see the header on why there is no third screen.
 */
const RootRedirect = () => {
    const router = useRouter();
    const { state, permissions } = useSession();

    // ⚠️ Fires the navigation at most once. `useRouter()` returns a NEW object on every render, so
    // `router` in the dependency array can re-run this effect before the replace it already started
    // has committed — and a second replace to the same URL while the first is in flight is how a
    // redirect turns into a loop. Same guard, for the same reason, as `_app.js` and `login.js`.
    const redirectStartedRef = useRef(false);

    useEffect(() => {
        if (redirectStartedRef.current) {
            return;
        }

        // `hasAuthToken` only proves a token EXISTS. An expired one is caught by the account read in
        // `_app.js`, whose 401 sends the user to /login with the dead token cleared.
        if (!hasAuthToken()) {
            redirectStartedRef.current = true;
            router.replace(AUTH_ROUTES.LOGIN);
            return;
        }

        // Wait for the role. Not latched: this effect runs again when the session answers.
        if (state !== SESSION_STATES.READY) {
            return;
        }

        redirectStartedRef.current = true;
        // `replace`, not `push`: `/` is a signpost, and the back button should not return the
        // user to it only to be forwarded again.
        router.replace(landingRouteFor(permissions));
    }, [router, state, permissions]);

    // Nothing, on the server and on the first client paint alike. `localStorage` cannot be read
    // during SSR, so the destination is unknowable until mount — rendering a placeholder and
    // swapping it would hydrate a tree that says something this page has no way to know yet.
    return null;
};

export default RootRedirect;
