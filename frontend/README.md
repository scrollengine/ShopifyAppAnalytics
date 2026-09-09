# shopify-app-analytics — dashboard

The web interface for [`shopify-app-analytics`](../README.md): the **Performance** suite — MRR,
cohorts, trials and churn for a Shopify app, read from the backend in this repo.

Next.js 14 (pages router), React 18, Shopify Polaris v12, Recharts. No database, no secrets, no
server-side state: it renders what the API returns and holds one bearer token in the browser.

---

## Quickstart

The backend must be running first — see [`../backend/README.md`](../backend/README.md).

```bash
cp .env.example .env.local     # only if your backend is not on localhost:8080
npm install
npm run dev                    # http://localhost:3000
```

Sign in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` from the **backend's** `.env`. There is no signup
and no user table — one operator account, configured where the data is.

| Script | |
|---|---|
| `npm run dev` | development server on :3000 |
| `npm run build` | production build |
| `npm start` | serve the production build |
| `npm run lint` | `next lint` |

---

## Configuration

One variable. That is the whole surface.

```
NEXT_PUBLIC_API_BASE_URL=http://localhost:8080
```

It is read **once, at boot, by `next.config.js`**, which proxies `/api/*` and `/healthz` to that
origin. Every request the dashboard makes is to a relative path, so the browser only ever talks to
one origin — which is why there is no CORS configuration anywhere in this project, in dev or in
production. Restart the dev server after changing it; a rewrite is not hot-reloaded.

Nothing else is configurable here on purpose. The Partner API token, the app id and the admin
credentials all live in the backend's `.env`, in one place, where the sync that uses them runs.

---

## How it authenticates

`POST /api/auth/login` issues a bearer JWT; every other call sends it as
`Authorization: Bearer <token>`. The token lives in `localStorage` (`utils/auth.js`) rather than a
cookie — an Authorization header is never attached to a cross-site request automatically, so this
API is not CSRF-exposed the way a cookie-authenticated one would be.

Two independent checks, and both are needed:

- **`pages/_app.js`** blocks a protected page from mounting when no token is stored, so a signed-out
  visitor never fires a request that is certain to 401.
- **`API_Services/apiClient.js`** watches for a real 401 — a token that exists but has *expired*
  only fails at the API — clears it, and redirects to `/login`. It deliberately does **not** redirect
  on a 401 from the login call itself; that one means "wrong password", and reloading the page would
  destroy the form before the operator could read the error.

Neither is a security boundary. No data lives in this app; every figure comes from a call the backend
authenticates for itself.

---

## Status — what is live against today's backend

**This section used to list, screen by screen, which endpoints existed and which were "awaiting a
later backend slice". It was accurate the day it was written and wrong within weeks** — every screen
it wrote off had been served long before anyone read it, and it read as authoritative precisely
because it was specific. `pages/overview/index.js` carries the same lesson in its header, about the
same paragraph in a different file: *do not restate a fact you cannot keep current.*

So the catalogue is gone rather than corrected, because a corrected catalogue goes stale the same
way. The route table in [`../IMPLEMENTATION.md`](../IMPLEMENTATION.md) is generated against the
router and is the place to look; and at runtime **each screen asks its own endpoint and renders that
endpoint's own answer, including its own refusal.**

That is not a fallback — it is the design. A response says which kind of nothing it is (never synced,
not connected, no route, an error, or a measured empty), `components/growth-intel/dataState.js`
decodes it, and `DataStateSection` renders the server's sentence *instead of* the chart rather than
above it. A view with no data behind it reports that it has no data. It does **not** render zeros —
that rule comes from the backend and it holds here too: an unavailable figure is `—` with a reason,
never `0.00`, because a zero is a claim about your business and a dash is a statement about your
data.

---

## Layout

```
pages/            _app.js (providers + auth gate), _document.js, and the screens
contexts/         loaderContext (toast/loader), growthIntelContext (partner-app selection)
components/       Polaris + Recharts building blocks
API_Services/     one axios provider + a service class per domain
utils/            the auth-token helpers, the ten dashboard route paths, and the
                  Revenue tab vocabulary those paths carry in a query string
public/css/       the two hand-written stylesheets — everything else is Polaris
styles/           global reset
```

Three conventions worth knowing before adding to it:

- **Screens are top-level routes** — `/overview`, `/funnel`, `/stores` and so on, one directory
  each under `pages/`. `components/growth-intel/` and `API_Services/growth-intel/` keep their names:
  those are DIRECTORIES ON DISK, not URLs, and renaming them would rewrite the import in every page
  and component for nothing. A leading-slash `/growth-intel` in this repo was a route and is gone; a
  `components/growth-intel/` is an import and stays.
- **Adding a screen is two edits, and the framework enforces only one of them.** Next routes whatever
  is in `pages/`; the app RECOGNISES only what is listed in `utils/dashboardRoutes.js`, which is where
  the ten paths are declared once and read by the nav, the Overview's contents list and
  `contexts/growthIntelContext.js`. That last one gates the partner-app fetch, so a page missing from
  the list renders "No partner app is selected" with nothing in the console to say why.
- **A tab is not a route.** `/revenue` carries three views — Revenue, By country, Churn — as
  `?view=` on one path, declared in the same module (`REVENUE_VIEWS`, `revenueViewHref`). They are
  deliberately *not* in `DASHBOARD_ROUTES`: `isRouteSelected` compares pathnames, so a query string
  in that list would match nothing and would silently close the roster gate. The retired
  `/countries` and `/revenue-churn` paths redirect to their tabs from `next.config.js`.
- **Comments in ported files are load-bearing.** Most of them record a bug that shipped — a stacking
  context that swallowed clicks, a cached id that was a string on a cache hit and an ObjectId on a
  miss. Keep them when you move code.

### Why Next 14

Polaris 12 ships one `@media` rule its own build failed to resolve. Webpack tolerates it; Turbopack —
the default builder from Next 16 — refuses to parse it and fails the build. On Next 14 this needs no
patch. If you upgrade, expect to strip that rule at install time.

---

## Licence

Same as the rest of the repository — **PolyForm Internal Use License 1.0.0**. See
[`../LICENSE`](../LICENSE).
