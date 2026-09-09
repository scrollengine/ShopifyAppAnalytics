'use strict';

/**
 * =============================================================================
 *  Next config — one job: put the API on the same origin as the dashboard.
 * =============================================================================
 *
 *  Every request the dashboard makes is to a RELATIVE path (`/api/...`). It never
 *  names the backend's host. The rewrite below is what turns that relative path
 *  into a call on the real API, and it runs inside the Next server — so:
 *
 *    - the browser only ever talks to one origin, which means there is no CORS
 *      preflight to configure, in dev or in production;
 *    - the backend needs no `Access-Control-Allow-Origin` for the dashboard at
 *      all, and can keep its allowlist for genuine third-party callers;
 *    - moving the API (a different port, a container name, a private hostname)
 *      is one env var here, with nothing rebuilt into the client bundle.
 *
 *  ⚠️ NEXT_PUBLIC_API_BASE_URL IS READ AT BOOT, not per request. `next dev` picks
 *  up a change on restart only. The `NEXT_PUBLIC_` prefix is kept because that is
 *  the name the rest of the project uses; nothing in the browser bundle actually
 *  reads it, because nothing in the browser needs to know where the API lives.
 *
 *  ⚠️ DO NOT ADD A `pages/api/` DIRECTORY. A plain `rewrites()` array is applied
 *  AFTER filesystem routes, so a file at `pages/api/foo.js` would shadow
 *  `/api/foo` and silently stop it reaching the backend.
 * =============================================================================
 */

/**
 * =============================================================================
 *   CORRECTION TO THE NOTE ABOVE — measured, not assumed (2026-09-02)
 * =============================================================================
 *
 *  "Read at boot" is true of THIS FILE but NOT of the rewrite it returns, and
 *  the difference matters the moment you build for production.
 *
 *  What `next build` actually does: it calls `rewrites()` ONCE, at BUILD time,
 *  and freezes the resolved destination string into `.next/routes-manifest.json`
 *  (and, for standalone output, into `server.js` and `required-server-files.json`
 *  as well). `next start` and the standalone server then route from that
 *  MANIFEST. They re-evaluate this file at boot — which is why the value looks
 *  runtime-configurable if you only read the source — but they never call
 *  `rewrites()` again, so a changed env var has no effect on where /api goes.
 *
 *  Verified empirically: built with the destination pointed at port 1111, then
 *  started with NEXT_PUBLIC_API_BASE_URL pointed at port 2222. The request
 *  arrived at 1111. `next dev` is the exception — it does re-evaluate, which is
 *  why the note above is correct for development.
 *
 *  Consequence for Docker: an image built with nothing set would bake in
 *  `http://localhost:8080`, and inside the frontend container `localhost` is the
 *  FRONTEND — so every API call would fail with a connection refused that names
 *  no cause. The Dockerfile therefore builds with the sentinel placeholder below
 *  and substitutes the real value into those generated files at CONTAINER START,
 *  which restores the build-once-deploy-anywhere property this file was designed
 *  to have. See `docker-entrypoint.sh`.
 *
 *  So: still NO build ARG, and NEXT_PUBLIC_API_BASE_URL is still a RUNTIME env
 *  var — but the mechanism that makes it one lives in the Dockerfile, not here.
 * =============================================================================
 */

// Trailing slashes are stripped so `http://host:8080/` and `http://host:8080`
// both produce `http://host:8080/api/...` rather than a doubled slash.
const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');

/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,

    // Says nothing useful to a legitimate visitor and names the framework and major version to
    // everyone else — which is the first step of matching a deployment against an advisory list.
    // The backend disables the same header in src/apps/app.ts; this is the dashboard's half.
    poweredByHeader: false,

    /**
     * Emit a self-contained server bundle at `.next/standalone`, with only the
     * node_modules actually reached by the traced import graph.
     *
     * This is what the Docker runtime stage copies: `.next/standalone` (which
     * includes its own `server.js` entry point), plus `.next/static` and
     * `public`, which tracing deliberately does NOT include because they are
     * served as files rather than imported. The runtime image then needs no
     * `npm install` and no dev toolchain at all — the command is `node server.js`.
     *
     * Harmless outside Docker: `next dev` ignores it and `next start` still works
     * from `.next` as before.
     */
    output: 'standalone',

    /**
     * =========================================================================
     *  Old bookmarks. Two moves, four rules.
     * =========================================================================
     *
     *  ── MOVE ONE: the screens left `/growth-intel/*` for the top level ──────
     *
     *  Two rules rather than twelve, and STRUCTURAL rather than enumerated: the
     *  flatten stripped one prefix and changed nothing else, so `/:path*` already
     *  describes every one of the sub-routes. A hand-written list would be a
     *  second copy of `utils/dashboardRoutes.js` living in a file that cannot
     *  import it (this is CommonJS, loaded by Node; that module is ESM) — which is
     *  precisely the drift the shared route module exists to prevent.
     *
     *  ── MOVE TWO: `/countries` and `/revenue-churn` became TABS of `/revenue` ─
     *
     *  These two ARE enumerated, and they have to be: they are not a prefix change
     *  but two whole routes folding into query strings on a third, so there is no
     *  pattern to write. The destinations carry `?view=`, whose values are declared
     *  in `utils/dashboardRoutes.js` (`REVENUE_VIEWS`) — unreachable from here for
     *  the CommonJS reason above, so THESE FOUR STRINGS ARE THE ONE PLACE THE VIEW
     *  NAMES ARE DUPLICATED IN THIS REPOSITORY. ⚠️ Rename a view there and these
     *  break SILENTLY: an unrecognised `?view=` falls back to the Revenue tab, so
     *  every old Country bookmark would quietly start opening the wrong screen with
     *  no error anywhere. `dashboardRoutes.js` carries the matching warning.
     *
     *  ⚠️ A CHAIN, NOT A LOOP, for the old prefixed paths. `/growth-intel/countries`
     *  matches rule 2 and becomes `/countries`; the browser follows that and matches
     *  rule 3, landing on `/revenue?view=countries`. Two 307s for a path nobody has
     *  used since the flatten, and no rule below can ever redirect to a source of
     *  another — `/revenue` is not a source here.
     *
     *  ⚠️ ORDER IS LOAD-BEARING. `:path*` matches ZERO or more segments, so the
     *  second rule would also catch a bare `/growth-intel` and send it to `/`.
     *  Redirects are applied in array order, so the exact rule must stay FIRST.
     *  `/` would then forward to the Overview anyway, but through an extra hop and
     *  a token check — a worse answer arrived at by accident.
     *
     *  ── WHY THESE ARE SAFE UNDER THE BUILD-TIME FREEZE ABOVE ────────────────
     *  `redirects()` is frozen into `routes-manifest.json` at build time exactly
     *  as `rewrites()` is. That is a problem for the API rewrite because its
     *  destination is an ENV VAR; it is a non-problem here because both
     *  destinations are literals. There is nothing to re-resolve at run time, so
     *  the frozen strings are already the right ones, and `docker-entrypoint.sh`
     *  has nothing to substitute — it replaces only the literal
     *  `http://API_BASE_PLACEHOLDER`, which appears nowhere below.
     *
     *  ── AND WHY THEY CANNOT SHADOW THE API PROXY ────────────────────────────
     *  Redirects run BEFORE filesystem routes and before a plain `rewrites()`
     *  array, so a redirect CAN shadow a rewrite. These cannot: every source below
     *  is either under `/growth-intel` or one of two exact literals — `/countries`
     *  and `/revenue-churn` — and none of those is `/api/:path*` or `/healthz`.
     *  The rule that stays dangerous is the one in the header — do not add a
     *  `pages/api/` directory.
     *
     *  Nor can they shadow a PAGE: `pages/countries/` and `pages/revenue-churn/`
     *  were deleted in the same change that added their rules, so there is no
     *  filesystem route left for either source to take precedence over. If one is
     *  ever recreated it will be dead on arrival — redirects win — which is why
     *  deleting the directories was part of the move rather than an afterthought.
     *
     *  ── 307, NOT 308 ────────────────────────────────────────────────────────
     *  `permanent: false`. A 308 is cached by the browser indefinitely and there
     *  is no way to flush it from an operator's machine — on a self-hosted tool
     *  with no control over its clients, that turns "we renamed a route" into a
     *  decision that cannot be taken back. A 307 costs one request per visit on a
     *  path nobody should be using for long, and stays reversible.
     * =========================================================================
     */
    /**
     * =========================================================================
     *  Response headers for the DOCUMENT, which helmet never sees
     * =========================================================================
     *
     *  The backend sets a strict header set on every reply it makes, but it only
     *  ever answers `/api/*` and `/healthz` with JSON. The thing a browser
     *  actually renders — the dashboard HTML, on this origin and this port — is
     *  served by Next, and inherited none of it.
     *
     *  The gap that mattered: nothing refused framing. An attacker's page could
     *  frame the signed-in dashboard and overlay it, turning one stray click into
     *  a partner-app deactivation or a LIFETIME re-sync. Auth is a bearer token in
     *  localStorage rather than a cookie, so a framed page cannot act on its own —
     *  which bounds the damage, and is not a reason to allow the frame.
     *
     *  No Content-Security-Policy beyond `frame-ancestors` is set here, and that
     *  is deliberate rather than an omission. Next's Pages Router injects inline
     *  bootstrap scripts, and Polaris injects styles, so a real `script-src`
     *  needs per-request nonces threaded through `_document.js`. A policy with
     *  `'unsafe-inline'` in it would only look like protection; the honest state
     *  is to say what is actually enforced.
     * =========================================================================
     */
    async headers() {
        return [
            {
                // Every document, asset and route on this origin.
                source: '/:path*',
                headers: [
                    // The one that closes clickjacking. `frame-ancestors` is the modern spelling
                    // and the one browsers honour; X-Frame-Options below is for older ones.
                    { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
                    { key: 'X-Frame-Options', value: 'DENY' },
                    // A JSON or text response can never be re-read as a script or stylesheet.
                    { key: 'X-Content-Type-Options', value: 'nosniff' },
                    // No URL of this dashboard — several carry ids in the query — reaches a third
                    // party in a Referer header. Matches the backend's own referrer policy.
                    { key: 'Referrer-Policy', value: 'no-referrer' },
                    // Nothing here needs a camera, a microphone or a location.
                    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' }
                ]
            }
        ];
    },

    async redirects() {
        return [
            // MUST STAY FIRST — see the ordering note above.
            {
                source: '/growth-intel',
                destination: '/overview',
                permanent: false
            },
            {
                source: '/growth-intel/:path*',
                destination: '/:path*',
                permanent: false
            },
            // The two screens that became tabs. See the ⚠️ above: these `?view=` values are the
            // only copy of `REVENUE_VIEWS` outside `utils/dashboardRoutes.js`, and a rename there
            // silently lands every one of these bookmarks on the wrong tab rather than erroring.
            {
                source: '/countries',
                destination: '/revenue?view=countries',
                permanent: false
            },
            {
                source: '/revenue-churn',
                destination: '/revenue?view=churn',
                permanent: false
            }
        ];
    },

    async rewrites() {
        return [
            // The whole authenticated API surface, plus the public login endpoint.
            {
                source: '/api/:path*',
                destination: `${API_BASE_URL}/api/:path*`
            },
            // The backend's readiness probe. Unauthenticated by design, and the
            // one thing the sync/status screen can ask before a token exists.
            {
                source: '/healthz',
                destination: `${API_BASE_URL}/healthz`
            }
        ];
    }
};

module.exports = nextConfig;
