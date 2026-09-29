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

On a fresh backend the dashboard sends you to **`/setup`**: enter your email and name, follow the
confirmation link that arrives by email, and choose a password. That creates the **owner** account and
locks setup for good; everyone else joins by invitation from **Users & roles**. There is no public
sign-up. (The backend needs a mail server for this — see [`../SETUP.md`](../SETUP.md) § 2.3 — and its
`APP_PUBLIC_URL` must be the address you open the dashboard at, `http://localhost:3000` here, because
the emailed links are built from it.)

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

Nothing else is configurable here on purpose. The Partner API token, the app id and the mail
settings all live in the backend's `.env`, in one place, where the code that uses them runs. There are
no credentials here at all: accounts live in the backend's database.

---

## How it authenticates

`POST /api/auth/login` issues a bearer token for a session; every other call sends it as
`Authorization: Bearer <token>`. The token lives in `localStorage` (`utils/auth.js`) rather than a
cookie — an Authorization header is never attached to a cross-site request automatically, so this
API is not CSRF-exposed the way a cookie-authenticated one would be. Sign-in also returns a *device
token*, kept under its own key and sent with the next sign-in: it is not a credential, only proof
that this browser signed in to that account before, which gives that sign-in a rate-limit budget no
one else can spend. Signing out leaves it in place on purpose.

**Public pages** — `/login`, `/setup`, `/setup/verify`, `/accept-invite`, `/forgot-password`,
`/reset-password` — are listed once in `utils/publicRoutes.js` and render without a session. The
token pages read the emailed link's token from the URL **fragment** (`#token=…`), remove it from the
address bar at once, and send it only when you press the button, so a mail scanner that opens the
link cannot use it up.

Everything else passes four checks:

- **`pages/_app.js`** blocks a protected page from mounting when no token is stored, so a signed-out
  visitor never fires a request that is certain to 401.
- **`contexts/sessionContext.js`** loads `GET /api/account` — who you are, your role, your
  permissions — and nothing renders until it has. If it cannot load, the page says so and offers
  Retry; it never guesses "no permissions" and never signs you out.
- **`utils/permissions.js`** decides which pages the role can open (`PAGE_PERMISSIONS`, default-deny)
  and filters the nav to match. A page the role cannot open shows *Restricted* without mounting.
- **`API_Services/apiClient.js`** watches for a real 401 — a session that has *ended* only fails at
  the API — clears the token, and redirects to `/login`, but only when the token that failed is
  still the stored one: a password change or "sign out my other sessions" in another tab stores a
  fresh token, and an in-flight request's 401 for the old one must not delete it. It deliberately
  does **not** do any of that for a 401 from `/api/auth/*`: from sign-in it means "wrong password",
  and reloading the page would destroy the form before anyone could read the error. A 403 is passed through to the page, which shows
  *Restricted — your role does not include …* in place of that section.

None of these is a security boundary. No data lives in this app; every figure comes from a call the
backend authenticates and authorises for itself.

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
contexts/         sessionContext (the signed-in account and its permissions),
                  loaderContext (toast/loader), growthIntelContext (partner-app selection)
components/       Polaris + Recharts building blocks
API_Services/     one axios provider + a service class per domain
utils/            the auth-token helpers, the public routes, the permission map, the ten
                  dashboard route paths plus the admin ones, and the tab vocabulary
                  (Revenue, Users & roles) those paths carry in a query string
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
