'use strict';

/**
 * ============================================================================
 *  securityHeaders — the response headers every reply carries
 * ============================================================================
 *
 *  One helmet instance, mounted as the FIRST layer in `src/apps/app.ts` so it
 *  covers everything: the guarded API, the public login, `/healthz`, a 404, and
 *  anything Express answers before a route is reached.
 *
 *  The dashboard keeps its bearer token in `localStorage`, which is the right
 *  trade here — an Authorization header is never attached automatically, so this
 *  API is structurally CSRF-immune in a way a cookie session is not. The cost is
 *  that script injection could read the token, and these headers are the second
 *  line against that.
 *
 *  ── ⚠️ The CSP governs THIS process, and this process serves JSON ───────────
 *  `default-src 'none'` is only defensible because nothing here renders a
 *  document: no `res.render`, no `sendFile`, no `express.static` anywhere in
 *  `src/`. The dashboard is a separate Next server on its own origin and sets
 *  its own headers in `frontend/next.config.js`; nothing in this file reaches
 *  that document, so no directive here can break Polaris or hydration.
 *
 *  CSP is enforced per DOCUMENT, so this policy is inert on a fetched JSON body
 *  and becomes live only when an operator navigates straight to `/api/...`.
 *
 *  IF THIS BACKEND EVER SERVES THE DASHBOARD ITSELF — a single-origin deploy, an
 *  `express.static` call, an HTML error page — this policy blocks every script
 *  and stylesheet and the page renders blank. Change it in the same commit
 *  rather than discovering it in a browser.
 *
 *  ── Two deliberate omissions ────────────────────────────────────────────────
 *  `upgrade-insecure-requests`: plain HTTP over a LAN is a supported deployment,
 *  and it is the one CSP clause that rewrites a request rather than describing
 *  what may load. Cross-Origin-Embedder-Policy: `require-corp` constrains what a
 *  DOCUMENT may embed, and this process serves none.
 * ============================================================================
 */

/*
 * ⚠️ A DEFAULT IMPORT, and the only one in this codebase — every other module here is imported with
 * `import x = require('…')`, which is the house form because every local module ends in `export =`.
 * helmet does not: it publishes an ESM-style DEFAULT export, so `import helmet = require('helmet')`
 * resolves to the module NAMESPACE and `helmet(...)` fails to compile with TS2349 ("has no call
 * signatures"). The default import is the correct form for this package and, with `esModuleInterop`
 * on (see tsconfig.json), it emits the `require` this CommonJS build needs.
 */
import helmet from 'helmet';

/**
 * HSTS lifetime, in seconds. 180 days.
 *
 * Shorter than helmet's one-year default, and that is the conservative direction:
 * an HSTS pin cannot be withdrawn from a browser that already holds it, only waited
 * out. 180 days is far longer than any deploy window and still bounded.
 */
const HSTS_MAX_AGE_SECONDS = 15552000;

/**
 * The single middleware. Built ONCE at module load — helmet's factory only closes over its
 * options, so there is no reason to rebuild it per request, and one instance means one place to
 * read the whole policy.
 *
 * Every option below that differs from helmet's default carries the reason it differs. Anything
 * not named here is helmet's default ON PURPOSE: `X-Content-Type-Options: nosniff`,
 * `X-Permitted-Cross-Domain-Policies: none`, `X-DNS-Prefetch-Control: off`,
 * `X-Download-Options: noopen`, `X-XSS-Protection: 0` (the header's own legacy auditor was a
 * vulnerability; `0` disables it, which is the current guidance), `Origin-Agent-Cluster: ?1`,
 * `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`.
 */
const securityHeaders = helmet({
    /*
     * ⚠️ AN API-ONLY POLICY. Read the header of this file before widening it — in particular
     * before adding `'self'` to anything, which is the natural first edit and is only ever
     * needed by a document this process does not serve.
     *
     * `useDefaults: false` so the emitted policy is EXACTLY these four directives. With the
     * default set merged in, a reader would have to know helmet's defaults to know what is
     * actually being sent, and `upgrade-insecure-requests` would come back with them.
     */
    contentSecurityPolicy: {
        useDefaults: false,
        directives: {
            // Loads nothing, because a JSON document legitimately loads nothing. Covers
            // script-src, img-src, style-src, connect-src and the rest by falling back.
            'default-src': ["'none'"],
            // Nobody may frame this, in any browser that understands CSP. `X-Frame-Options`
            // below says the same thing for the ones that do not.
            'frame-ancestors': ["'none'"],
            // No <base> can retarget a relative URL. Free to set on a document with no markup.
            'base-uri': ["'none'"],
            // No form on any page of ours can post anywhere. Same reasoning.
            'form-action': ["'none'"]
        }
    },

    /*
     * DIFFERS FROM HELMET'S DEFAULT, in two ways, and both are about not making a decision on
     * an operator's behalf that they cannot take back.
     *
     * `includeSubDomains` (helmet sets it) forces HTTPS on every subdomain of whatever host the
     * dashboard is reached at. Deployed at `analytics.example.com` that is harmless; deployed at
     * the apex `example.com` — which a self-hoster is perfectly entitled to do — it silently
     * takes down every unrelated subdomain of the company that is still on HTTP, and the pin
     * lives in each visitor's browser for a year afterwards. This project cannot know which
     * deployment it is in, so it does not assert authority it does not have.
     *
     * `preload` is left off for the same reason, harder: submission to the browser preload list
     * is months to reverse and affects people who have never visited this deployment.
     *
     * Sent unconditionally rather than only in production: browsers ignore HSTS delivered over
     * plain HTTP, so a LAN install on `http://` is unaffected, and gating on NODE_ENV would mean
     * the one deployment that needs the header is the one whose config most often drifts.
     */
    strictTransportSecurity: {
        maxAge: HSTS_MAX_AGE_SECONDS,
        includeSubDomains: false,
        preload: false
    },

    /*
     * DIFFERS FROM HELMET'S DEFAULT (`SAMEORIGIN`). Nothing this process returns is ever meant to
     * be framed by anything, including by the dashboard, so the stricter value is simply the
     * accurate one. The CSP above already says this; this is the same statement for a browser
     * old enough to need it.
     */
    xFrameOptions: { action: 'deny' },

    /*
     * Helmet's default already, stated explicitly because it is load-bearing rather than
     * incidental: a URL of this API must never travel to a third-party server in a `Referer`
     * header. The same argument the auth middleware makes for refusing a `?token=` query
     * parameter applies to every path here.
     */
    referrerPolicy: { policy: 'no-referrer' }
});

export = {
    /** The helmet instance. Mount it FIRST, before the body parser and before the routes. */
    securityHeaders
};
