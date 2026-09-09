# Backend

The data layer: it syncs your Shopify Partner API history into MongoDB, and serves the computed
analytics over a small authenticated JSON API.

For what the product is and why it exists, see the [repository README](../README.md). This file is
just how to run it.

---

## Quickstart

```bash
cd backend
npm install
cp .env.example .env      # then fill in the seven TIER 1 values
npm start
curl localhost:8080/healthz
```

For the Docker route — which is how this is meant to be run — see
[`DEPLOYMENT.md`](../DEPLOYMENT.md) at the repository root.

That's the whole setup. `npm start` runs the TypeScript directly through ts-node — for local work
there is no build step, and nothing is ever compiled next to the sources. (The Docker image is the
exception and compiles on purpose: its build stage runs `npx tsc` into `dist/` and the runtime stage
ships only that, with no `src/` and no ts-node.)

| | |
|---|---|
| `npm start` | run the API |
| `npm run dev` | same, restarting on file changes |
| `npm run typecheck` | `tsc --noEmit` — the real type check |
| `npm test` | the test suite — 519 tests across 23 files, plain `node:test`, no database needed |
| `npm run lint` | style + the model-layer import guard (`--fix` autofixes style) |
| `npm run seed:demo` | write a fictional dataset so every screen fills in without a Partner account |
| `npm run seed:demo:down` | remove exactly what the seeder wrote |
| `npm run seed:demo:dist` / `:down:dist` | the same two, run from `dist/` — the only form that works inside the Docker image, which ships no `src/` and no `ts-node` |

**The seeder writes fiction, so it refuses to run beside real data.** It counts what is already in
the collections first and stops if it finds an app row that is not the demo app, or a fact row scoped
to any other app id — the second check being the one that matters, since deleting an app row by hand
leaves its events and payouts behind and those are still somebody's history. `-- --force` overrides;
it is a flag a human types, never a default. A second run is a no-op rather than a second dataset,
and `-- --reanchor` re-dates a demo seeded months ago to today.

**Requires Node 22 or newer.**

---

## Configuration

Everything is environment variables, documented inline in [`.env.example`](./.env.example) in three
tiers.

- **Tier 1 — required.** Seven entries in `TIER_1_KEYS` (`src/config/validate.ts`): `MONGO_URI`,
  `JWT_SECRET`, `ADMIN_EMAIL`, the admin secret (`ADMIN_PASSWORD` **or** `ADMIN_PASSWORD_HASH` —
  the hash wins when both are set), `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_TOKEN` and
  `SHOPIFY_PARTNER_API_VERSION`. The validator lists **every** problem at once and exits non-zero, so
  a fresh install is fixable in one pass.

  ⚠️ `SHOPIFY_PARTNER_APP_ID` is *not* on that list. It **warns and boots** — but no app row is
  created, so nothing ever syncs and every figure is unavailable. In practice it is required.
  `SHOPIFY_PARTNER_API_VERSION` carries a default, so it can only fail the *shape* check, never the
  presence one.
- **Tier 2 — optional.** BigQuery access to Shopify's listing-analytics export. **Fully built**, and
  gated on a derived `BIGQUERY.ENABLED` that demands a project, a dataset *and* credentials —
  half-configured is the dangerous state, because it looks configured and produces nothing. Four of
  its variables are cost controls; read the `BQ_MAX_BYTES_BILLED` entry in
  [`DEPLOYMENT.md` §3](../DEPLOYMENT.md#tier-2--the-listing-analytics-tier-optional-and-fully-built)
  before the first lifetime sync.
- **Tier 3 — tunables.** Already filled in with working defaults. Delete any of them and the default
  applies. Two are **measurement decisions rather than performance knobs** — `ACTIVE_SUB_WINDOW_DAYS`
  and `REVENUE_REPORTING_CURRENCY` — and changing them changes what the dashboard says happened. See
  [`docs/FIDELITY.md`](./docs/FIDELITY.md) §7.

`process.env` is read in exactly one file, `src/config/index.ts` — **53 names, and nothing else in
`src` reads it.** Everywhere else consumes `config.<SECTION>.<FIELD>`. If you are adding a setting,
that is where it goes, and it needs a row in `DEPLOYMENT.md` §3, whose table is exhaustive against
this file.

```bash
grep -oE 'process\.env\.[A-Z0-9_]+' src/config/index.ts | sort -u
```

---

## What works without BigQuery

Most of it. The Partner API is the only hard requirement.

**Works with Tier 1 alone** — installs, uninstalls and reinstalls, trials, trial outcomes,
conversion to paid, subscription state, point-in-time MRR and MRR movement, plan mix, install cohorts
and retention, time-to-paid, logo churn, revenue churn, and the store and subscriber lists.

**Needs Tier 2** — because Shopify does not expose any of it through the Partner API:

- **Traffic Sources** entirely. Both of its reads (`/api/funnel/traffic-source`, `/api/funnel/geo`)
  are BigQuery-only.
- **The steps at the top of the conversion funnel** — listing page views, engaged views, install
  clicks. The Partner-sourced steps below them are unaffected and still render; the endpoint answers
  `200` with `count: null` (never `0`) on any step whose tier cannot answer, and names the reason.
- ⚠️ **Revenue Country, in substance.** It answers `200` without Tier 2, but the *only* per-store
  country this build holds is GA4's `geo.country` for the install event — the Partner API's `Shop`
  object has no country field on any version — so without the listing tier every store lands in the
  explicit `UNKNOWN` remainder. The page is honest about it (`country_basis`, `attribution_state`),
  but it has no geography to show you.
- **Per-install attribution** — the channel, source, surface and result position on a store row.

Without Tier 2 those views say they have no data. **They do not show zeros.** A figure that cannot be
computed comes back as `null` carrying the reason it is unavailable — never as `0`, which would be a
claim about your business rather than about your data. That behaviour is the project's core promise,
not an edge case: see [`docs/FIDELITY.md`](./docs/FIDELITY.md) for what each figure is derived from,
where the seams between data sources are, and which numbers are refused rather than estimated.

---

## Layout

```
src/
├── apps/          entry points (app.ts is the API server)
├── config/        the ONLY reader of process.env
├── core/          process bootstrap (database connection, shutdown)
├── models/        mongoose schemas — importable only from a repositories/ folder
├── modules/       eight domains (auth, partner, revenue, bigquery, sync, store,
│                  conversion, shared), each split by ROLE:
│                    services/     orchestration + business logic
│                    repositories/ model access — the only files that touch src/models
│                    resolvers/    resolve a value or state from mixed inputs
│                    clients/      external API boundaries
│                    helpers/      PURE — no I/O, no models, no clock reads
│                    constants/    vocabularies
│                    types/        declarations only
│                  plus an index.ts barrel enumerating each module's exports
│                  (7 of the 8 — `shared` has none, and is imported by deep path)
├── controllers/   <domain>.controller.ts — thin: validate, call a service, respond
├── routes/        <domain>.routes.ts — index.ts is the security seam
├── middlewares/   verifyAdmin, loginRateLimit, securityHeaders
├── constants/     cross-module vocabularies
├── types/         shared type declarations
└── utils/         shared helpers
```

The layering is enforced, not just documented: `npm run lint` fails on any import of `src/models/**`
from outside a `repositories/` folder, across all three import forms (`import`, `require`, and
`import x = require`).

⚠️ **One thing is *not* enforced: import cycles.** A module that reaches another module's **barrel**
in the wrong direction closes a loop that passes typecheck *and* lint, and fails only at run time —
a destructured function is `undefined` at load and every call throws. It has cost fifteen tests once.
The rule, the four legal deep-path exceptions and the incident are in
[`IMPLEMENTATION.md`](../IMPLEMENTATION.md) §3.13. Read it before adding any
`require('../../<other-module>')`.

---

## Authentication

Every `/api/*` route sits behind the admin guard — 36 of the 38 routes. The only open endpoints are
`POST /api/auth/login` and `GET /healthz`.

This is asserted by a test that walks the live Express router stack and fails on any route reachable
without the guard — because the failure mode here is silent. A route file that mounts its handlers
bare looks completely correct in review and ships an unauthenticated analytics API.

The login endpoint is throttled in-process (`AUTH_LOGIN_RATE_LIMIT_MAX`, default 10 failed attempts
per 15 minutes, keyed on `req.ip`). ⚠️ Behind any proxy — including the dashboard's own, which is
always present — set `TRUST_PROXY` or that key is a container address and every caller shares one
bucket. The limiter fails **open** and holds no state on disk, deliberately: there is one account and
no password reset, so a restart must always clear a block.

---

## Licence

See [`LICENSE`](../LICENSE) at the repository root. Source-available, not open source: free to run
and modify for your own company's internal business operations, including commercially; not to be
distributed or operated as a service for others.
