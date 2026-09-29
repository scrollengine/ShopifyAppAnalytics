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
cp .env.example .env      # then fill in the TIER 1 values (incl. APP_PUBLIC_URL and SMTP_*)
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
| `npm test` | the test suite — 745 tests across 39 files when last counted, plain `node:test`, no database needed |
| `npm run lint` | style + the model-layer import guard (`--fix` autofixes style) |
| `npm run seed:demo` | write a fictional dataset so every screen fills in without a Partner account |
| `npm run seed:demo:down` | remove exactly what the seeder wrote |
| `npm run seed:demo:dist` / `:down:dist` | the same two, run from `dist/` — the only form that works inside the Docker image, which ships no `src/` and no `ts-node` |
| `npm run auth:admin -- <command>` | account recovery: `status`, `setup-link`, `reset-link`, `revoke-sessions`, `enable`, `transfer-owner`, `repair-owner`. Prints links instead of emailing them; never takes a password. `auth:admin:dist` in the image. See [`DEPLOYMENT.md`, Account recovery (CLI)](../DEPLOYMENT.md#account-recovery-cli) |

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

- **Tier 1 — required.** Eight entries in `TIER_1_KEYS` (`src/config/validate.ts`): `MONGO_URI`,
  `JWT_SECRET`, `APP_PUBLIC_URL` (the dashboard's address — every emailed link is built from it),
  `SMTP_HOST` and `SMTP_FROM` (a mail server is required: setup confirmation, invitations and
  password resets travel by email), `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_TOKEN` and
  `SHOPIFY_PARTNER_API_VERSION`. `SMTP_USER` / `SMTP_PASS` must be set together or not at all, and
  `SETUP_OWNER_EMAIL` — which pins who may claim first-run setup, and is strongly recommended — must
  be a bare address if set. The validator lists **every** problem at once and exits non-zero, so a
  fresh install is fixable in one pass. For Gmail, see [`SETUP.md` § 2.3](../SETUP.md#23-outgoing-mail).

  There is no sign-in password in `.env`. The first person through the dashboard's setup screen
  creates the owner account; everyone else is invited. `ADMIN_EMAIL` / `ADMIN_PASSWORD` /
  `ADMIN_PASSWORD_HASH` from the single-operator build are ignored, and boot warns while they are set.

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

`process.env` is read in exactly one file, `src/config/index.ts` — **70 names, and nothing else in
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
├── modules/       nine domains (auth, mail, partner, revenue, bigquery, sync, store,
│                  conversion, shared), each split by ROLE:
│                    services/     orchestration + business logic
│                    repositories/ model access — the only files that touch src/models
│                    resolvers/    resolve a value or state from mixed inputs
│                    clients/      external API boundaries
│                    helpers/      PURE — no I/O, no models, no clock reads
│                    constants/    vocabularies
│                    types/        declarations only
│                  plus an index.ts barrel enumerating each module's exports
│                  (8 of the 9 — `shared` has none, and is imported by deep path)
├── controllers/   <domain>.controller.ts — thin: validate, call a service, respond
├── routes/        <domain>.routes.ts — index.ts is the security seam
├── middlewares/   authenticate, requirePermission, loginRateLimit, authFlowRateLimit,
│                  securityHeaders, terminalErrorHandler
├── scripts/       seedDemo / teardownDemo, and authAdmin — the account-recovery CLI
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

Multi-user, with roles. The first-run setup screen creates the **owner**, once, and then locks for
good; everyone else joins by emailed **invitation**. There is no public sign-up. Four built-in roles
(Owner, Admin, Analyst, Viewer) and owner-made custom roles draw on a fixed catalogue of twelve
permissions. The full model is [`IMPLEMENTATION.md`](../IMPLEMENTATION.md) §3.5; the operator's view
is [`DEPLOYMENT.md`, Users, roles and permissions](../DEPLOYMENT.md#users-roles-and-permissions).

Of the 66 routes, **10 are public** — `GET /healthz`, sign-in, and the setup, invitation-acceptance
and password-reset flows under `/api/auth` — and **56 sit behind `authenticate`**, each also
declaring the one permission it needs (`requirePermission(...)`, or `requireSelf()` for
`/api/account`). Two tests walk the live Express router stack: one fails on any route reachable
without the guard, the other on any guarded route whose permission is missing, misplaced or not the
one its table names — because both failure modes are silent. A route file that mounts its handlers
bare looks completely correct in review and ships an unauthenticated analytics API.

The session token names a session row and a user and nothing else; every request re-reads both, plus
the role, so a sign-out, a disable or a role change takes effect on the next request. A database
failure while checking is a `503`, never a `401`, so it does not sign anyone out.

Four in-process rate limiters guard the public endpoints: sign-in (`AUTH_LOGIN_RATE_LIMIT_MAX`,
default 10 failed attempts per 15 minutes), and forgot-password, the setup request and the emailed-link
pages (`AUTH_PUBLIC_FLOW_RATE_LIMIT_MAX`, 10 per 15 minutes each). ⚠️ The first three are keyed on
`req.ip`: behind the dashboard's own proxy, which is always present, every caller shares one bucket
per limiter unless a real reverse proxy is in front and `TRUST_PROXY` is set for it — leave it unset
for the bundled stack alone (see `.env.example`). The emailed-link limiter is keyed on the link's
token instead. All four fail **open**, trickle one request every 30 seconds once spent, and hold no
state on disk, so a restart always clears a block. A sign-in success clears nothing, an abandoned
attempt is still charged, and a browser that has signed in before gets a device budget of its own on
its next sign-in, so a flood on the shared bucket does not keep a returning user out.

When mail or the dashboard cannot help — a forgotten password with mail down, the only admin
disabled, a missing owner — `npm run auth:admin -- <command>` works from the server's shell.

---

## Licence

See [`LICENSE`](../LICENSE) at the repository root. Source-available, not open source: free to run
and modify for your own company's internal business operations, including commercially; not to be
distributed or operated as a service for others.
