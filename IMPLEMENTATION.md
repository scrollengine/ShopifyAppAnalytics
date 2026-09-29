# Implementation

How this application is built: the processes, the layers, the data model, the sync pipeline, the
analytics engines, and the rules that are enforced rather than merely written down.

This is the document for someone who is going to **read or change the code**. It is not a tutorial
and not a setup guide.

| document | answers |
|---|---|
| [`README.md`](./README.md) | What the product is and why it exists |
| [`DEPLOYMENT.md`](./DEPLOYMENT.md) | How to run it — Docker, credentials, first-run setup, roles, recovery, first sync, upgrades |
| [`SECURITY.md`](./SECURITY.md) | The trust model, and how to report a vulnerability |
| [`backend/README.md`](./backend/README.md) | How to run the backend on its own |
| [`backend/docs/FIDELITY.md`](./backend/docs/FIDELITY.md) | What each published figure means and how it can be wrong |
| **this file** | How it is put together |

Where this file and the code disagree, the code is right. Every claim below was read out of the
source; file paths are given so you can check.

---

## 0. The one idea everything else serves

Analytics code does not crash. It returns a **plausible wrong number**, and nobody gets paged.

So the whole architecture is organised around making the difference between *"the answer is zero"*
and *"we do not have an answer"* impossible to lose:

- a figure is never a bare number — it travels in an envelope that states how well it is known
  (§3.11);
- an empty result carries **which kind of empty** it is (§3.9);
- a count and the list behind it are computed from the same array, so they cannot drift;
- and the rules that keep this true are asserted by tests that walk the live application, not by
  convention (§5).

Read §3.11 and §5 first if you only read two sections.

---

## 1. The shape of the system

Three processes. Two of them are yours; the third is a database.

```
                    ┌───────────────────────────────────────────┐
                    │ Shopify Partner GraphQL API               │
                    │   app.events      (installs, charges)     │
                    │   transactions    (settled payouts)       │
                    └──────────────────┬────────────────────────┘
                                       │  read-only, mutations refused
                                       │  in the client itself
   ┌────────────────────────┐          ▼
   │ GA4 export in BigQuery │   ┌─────────────────────────────────┐
   │  (optional tier)       │──►│  BACKEND  (Node 22, TypeScript) │
   └────────────────────────┘   │                                 │
                                │  ┌───────────────────────────┐  │
                                │  │ job runner (polling loop) │  │
                                │  │  PARTNER_SYNC             │  │
                                │  │  BIGQUERY_SYNC            │  │
                                │  │  INSTALL_ATTRIBUTION_SYNC │  │
                                │  └───────────┬───────────────┘  │
                                │              ▼                  │
                                │        ┌──────────┐             │
                                │        │ MongoDB  │  16 colls   │
                                │        └────┬─────┘             │
                                │             ▼                   │
                                │  ┌────────────────────────────┐ │
                                │  │ read services → envelopes  │ │
                                │  └────────────┬───────────────┘ │
                                │   Express 5, all /api guarded   │
                                └────────────────┬────────────────┘
                                                 │ JSON
                                                 ▼
                                ┌────────────────────────────────┐
                                │ FRONTEND (Next.js 15, Polaris) │
                                │  proxies /api on its own origin│
                                └────────────────────────────────┘
```

**There is no message broker, no Redis, and no second worker process.** The job runner lives inside
the API process and claims work with an atomic MongoDB update (§3.7). That is a deliberate trade: a
self-hoster stands up two containers and a database, and nothing else, before the first number
appears.

**One more outbound connection is required: an SMTP server.** Accounts are created by first-run setup
and emailed invitation, and recovered by emailed link, so the backend refuses to boot without one
(§3.5). It is the only thing besides Shopify and the optional BigQuery tier that the backend talks to.

**Size, for orientation** (measured, and it moves — the commands are here so you can re-take it):

| | count | command |
|---|---|---|
| TypeScript files in `backend/src` | **313** | `find backend/src -name '*.ts' -type f \| wc -l` |
| lines of TypeScript | **~79k** | `find backend/src -name '*.ts' -exec cat {} + \| wc -l` |
| test suite files | **39** | `ls backend/test/*.test.js \| wc -l` |
| JavaScript files in `frontend` | **105** (~29k lines) | `find frontend -name '*.js' -not -path '*/node_modules/*' -not -path '*/.next/*' \| wc -l` |
| HTTP routes | **66** | `grep -rE "^\s*router\.(get\|post\|put\|patch\|delete)\(" backend/src/routes/*.ts \| wc -l` |

Much of that TypeScript volume is comment. This codebase argues with itself in the files rather than
in a wiki, deliberately: the reasoning that stops a figure being wrong has to be where the figure is
computed, or the next person deletes the guard as dead weight.

---

## 2. Repository layout

```
.
├── README.md  DEPLOYMENT.md  SETUP.md  IMPLEMENTATION.md  SECURITY.md  LICENSE
├── .env.example              one file drives both containers
├── docker-compose.yml        mongo + backend + frontend
│
├── backend/
│   ├── Dockerfile  eslint.config.js  tsconfig.json
│   ├── docs/FIDELITY.md
│   ├── test/                 39 suites + 2 harnesses (plain node:test)
│   └── src/
│       ├── apps/app.ts       the ONLY entry point
│       ├── scripts/          seedDemo.ts / teardownDemo.ts — the demo dataset;
│       │                     authAdmin.ts — the account-recovery CLI
│       ├── core/             bootstrap, db, logger, shutdown
│       ├── config/           index.ts (the only reader of process.env) + validate.ts
│       ├── constants/        cross-module vocabularies (authVocab, partnerVocab, syncJob)
│       ├── models/           16 mongoose schemas + the registry
│       ├── middlewares/      authenticate, requirePermission, loginRateLimit,
│       │                     authFlowRateLimit, securityHeaders, terminalErrorHandler
│       ├── routes/           index.ts = the security seam, + 15 domain route files
│       ├── controllers/      16 thin request handlers
│       ├── types/            express augmentation, service envelope types
│       ├── utils/            apiResponse, promiseHelper, clientAddress
│       └── modules/          the application itself — 9 of them, see §3.3
│           ├── auth/  mail/  partner/  revenue/  bigquery/
│           └── sync/  store/  conversion/  shared/
│
└── frontend/
    ├── Dockerfile  docker-entrypoint.sh  next.config.js
    ├── pages/**                10 dashboard routes (Overview + 7 Performance + apps + sync),
    │                           settings/users, account, and the public login, setup,
    │                           setup/verify, accept-invite, forgot-password, reset-password
    ├── components/growth-intel/   ⚠️ a DIRECTORY, not a URL — see §4.4b
    │   ├── dataState.js          the six-state decoder — see §4.4a
    │   └── DataStateSection.js    its render half
    ├── components/auth/        the public pages' shared pieces (fragment-token hook, password fields)
    ├── components/admin/       the Users & roles tabs
    ├── API_Services/           apiClient + authService + accountService + userAdminService
    │                           + 9 growth-intel services + notImplemented.js
    ├── utils/                  auth.js, publicRoutes.js, permissions.js, and dashboardRoutes.js —
    │                           the ten routes, the admin routes, the Revenue and Users tabs
    └── contexts/               sessionContext (who is signed in, their permissions),
                                growthIntelContext (selected app), loaderContext
```

---

## 3. Backend

### 3.1 Startup

One sequence, one place: `core/bootstrap.ts`, called by `apps/app.ts` and by nothing else.

```
dotenv  →  config  →  validate  →  logger  →  mongo
```

**Why nearly nothing is imported at the top of `apps/app.ts`.** `config/index.ts` snapshots
`process.env` **once**, at first require. `bootstrap()` is what loads `.env`. So any module that
reaches config — the logger, the routes, every module barrel — must be required *inside* the
`.then()` after bootstrap has run. Hoist one of those requires to module scope and the application
reads a config built entirely from defaults: no Mongo URI, no Partner token, an empty JWT secret. It
does not crash. **It boots, and it is wrong.**

The lazy requires stay fully typed through `typeof import('...')` aliases, which erase at compile
time and load nothing. `core/bootstrap.ts` uses the same device for the same reason. Everywhere else
in the codebase ordinary top-level imports are correct, and required.

**Boot order in `apps/app.ts`:**

1. build the Express app, mount `routes` (one `app.use`, §3.4);
2. **listen first** — so `/healthz` can answer *503 while warming* rather than refusing the
   connection, which during a rolling deploy reads as a crash;
3. register graceful shutdown immediately, so a signal during the slow steps still winds down;
4. the account steps (§3.5), in this order:
   - `ensureInstallState()` — **fatal**: the install document is the only record of whether setup
     is open, and a database that already holds users gets it LOCKED, never open;
   - `markLegacyOperators()` — non-fatal, bounded at 30 s: stamps `legacy_at` on accounts left by
     the single-operator build, which sign-in never reads;
   - `ensureAuthIndexes()` — **fatal**: builds the auth collections' indexes explicitly, even with
     `MONGO_DISABLE_AUTO_INDEX=true`, because the unique indexes *are* the gates (one account per
     address, one outstanding invitation per address, one use per link). Account-creating requests
     answer `503` until it has succeeded in this process;
   - `reconcileSetup()` — non-fatal, bounded: rolls a setup that crashed between locking the install
     and inserting the owner forward from the claim it left;
   - `logSetupState()` — non-fatal, bounded: says who may claim setup, WARNs while it is open to
     anyone, and logs the CLI command when the owner is missing;
   - `verifyMailAtBoot()` — non-fatal and **not awaited**: a slow mail server must not hold up the
     sync machinery. It bounds itself at 20 s and logs its own outcome;
5. register the partner app from config — **non-fatal**, so a fresh clone that has not set
   `SHOPIFY_PARTNER_APP_ID` still boots and can be fixed over the API without a restart;
6. register the `PARTNER_SYNC` job handler, then `assertHandlersRegistered()` — **fatal by design**:
   it throws if any runnable job type has no handler. Without it the failure surfaces at 03:00 as
   jobs failing with `UNKNOWN_JOB_TYPE`, which is a silent outage — the dashboard keeps serving, it
   just stops moving;
7. start the job runner and the crons. A malformed cron expression **throws**, rather than firing at
   a time nobody chose.

Because the server listens before step 4, a request can arrive while the account steps run; the
`503 INDEXES_NOT_READY` answer is what keeps an account from being created before its unique gate
exists.

One `.then`, one fatal `.catch`, `process.exit(1)` so the supervisor restarts rather than leaving a
half-booted process answering with data nothing is refreshing.

### 3.2 Configuration

`src/config/index.ts` is **the only file in the repository that reads `process.env`.** Everything
else consumes `config.<SECTION>.<FIELD>`. Sections: `APP`, `MONGO`, `AUTH`, `MAIL`, `PARTNER`,
`REVENUE`, `SYNC`, `BIGQUERY`, `LOG` — each frozen on its own line. 70 environment names are read;
three of them (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_PASSWORD_HASH`) only to set
`AUTH.LEGACY_ADMIN_ENV_PRESENT`, so boot can warn that they are ignored.

Two small readers do all the coercion — `_str` (trims, because `.env` files are hand-edited) and
`_int` (falls back on unset, blank, `NaN` and `Infinity` alike). Derived flags are computed from
locals rather than from siblings, e.g.

```ts
BIGQUERY.ENABLED = Boolean(projectId && dataset && (serviceAccountJson || adcPath))
```

`config/validate.ts` runs at boot and **refuses to start on a missing TIER-1 value, naming it** and
printing an example line. Tier 1 is **eight entries** in `TIER_1_KEYS`, in setup order: `MONGO_URI`,
`JWT_SECRET` (≥32 chars), `APP_PUBLIC_URL` (absolute http(s), no path, query, fragment or
credentials), `SMTP_HOST` (a bare host name), `SMTP_FROM` (the resolved value — it falls back to
`SMTP_USER` when that is an address — must be one bare address), `SHOPIFY_PARTNER_ORG_ID`,
`SHOPIFY_PARTNER_API_TOKEN` and `SHOPIFY_PARTNER_API_VERSION`. Three more refusals are explicit
checks after that loop: `SMTP_USER` / `SMTP_PASS` set one without the other, an `SMTP_PORT` outside
1–65535, and a `SETUP_OWNER_EMAIL` that is not a bare address. When the legacy `ADMIN_*` variables
are present and any of `APP_PUBLIC_URL` / `SMTP_HOST` / `SMTP_FROM` has a problem, the error is headed
`UPGRADING FROM A SINGLE-OPERATOR BUILD` and names the `DEPLOYMENT.md` section to read.

The value checkers (`checkPublicUrl`, `isLoopbackPublicUrl`, `isBareEmailAddress`) are exported, so the
recovery CLI and the auth and mail modules apply the rule boot refuses on rather than a second
spelling of it. `collectConfigProblems(cfg)` returns problems and warnings without touching the
process, so the rules are testable.

Settings that change what the numbers *say* — `ACTIVE_SUB_WINDOW_DAYS`, `REVENUE_REPORTING_CURRENCY`,
the sync windows — are documented in `FIDELITY.md` §7 rather than only here, because changing one is
a change to the published figures.

### 3.3 Module architecture

Everything under `src/modules/<module>/` is organised by **role folder**, with the role in the
filename:

```
modules/<module>/
├── index.ts                        the barrel — the only file at module root
├── services/     <name>.service.ts       orchestration + business logic
├── repositories/ <name>.repository.ts    model access — the ONLY files that touch src/models
├── helpers/      <name>.helper.ts        PURE: no I/O, no models, no config, no clock
├── resolvers/    <name>.resolver.ts      resolves a value/state from mixed inputs
├── clients/      <name>.client.ts        external API boundary
├── constants/    <name>.constants.ts     vocabularies (`as const`)
└── types/        <name>.types.ts         declarations only, zero runtime imports
```

Layer direction is one-way: `services → resolvers → helpers → constants/types`, with
`repositories` reachable from services and resolvers. A helper importing a model is a violation.

**The rule is machine-checked, not trusted.** `backend/eslint.config.js` restricts imports of
`src/models` to `src/**/repositories/**` and `src/models/**`, and it does so through **two** rules
because one is not enough: `@typescript-eslint/no-restricted-imports` catches
`import x from '../models/y'`, and a `no-restricted-syntax` selector catches
`import x = require('../models/y')` — the `export =` form, which a plain restricted-imports rule
does not see.

**The model chokepoint.** `modules/shared/repositories/models.repository.ts` is the only file that
may import `src/models`. It exists for two reasons. Types: the registry is a plain runtime object, so
requiring it anywhere yields `any` and every downstream `.find()` / `.lean()` silently loses its
typing — which is how a renamed field becomes a column of `undefined` instead of a compile error.
Casting once there buys mongoose's generics across the whole codebase. Layering: the rule is only
checkable because the import has exactly one legal location.

> ⚠️ A model published from that file must actually exist in `src/models/index.ts`. The registry
> arrives through a bare `require`, so a name that is not in it destructures to `undefined` and the
> cast happily types `undefined` as a model. Four such phantom handles shipped once and were caught
> by `exportSurface.test.js` (§5).

**Barrels.** Every module with a barrel ends in `export = { … }` with **every key enumerated**.
Eight of the nine have one; `modules/shared` deliberately does not, and is reached only by deep
path — there is no `require('../../shared')` anywhere. Never a spread — a
spread type-checks perfectly and destroys the one property that makes a surface reviewable, that you
can read the barrel and know what it publishes. And `export =`, never `export default`, because
consumers destructure a plain CommonJS object; a named import from an export assignment is TS2497,
which is why every internal import is `import x = require('./x')`.

Barrels are for consumers **outside** the module; siblings import by deep path.

**The nine modules, and the direction of dependency between them:**

| module | owns |
|---|---|
| `shared` | the model chokepoint, the confidence envelope, cross-module vocabularies and pure helpers |
| `auth` | accounts and access: first-run setup and the install lock, sign-in and sessions, the one principal derivation, the permission catalogue and roles, invitations, password reset and change, the security activity log, the recovery CLI's operations (§3.5) |
| `mail` | outgoing email: one SMTP transport, four fixed templates, the send caps, the boot check. Imports config, the logger and utils — **never `auth`**; auth calls mail, and mail knows nothing about users |
| `partner` | the Shopify Partner API client, the sync that fills the spine and the ledger, coverage |
| `bigquery` | the optional listing-analytics tier: the client, the two sync jobs, the read side |
| `revenue` | **the MRR ledger** — `liveSetAsOf` and every reduction of it |
| `conversion` | **the lifecycle fold** — trials, cohorts, retention, churn, `resolveChurnDate` |
| `store` | **the derived roster** — stores, subscriptions, the country rollup (§3.12) |
| `sync` | the job row, the runner, the crons, the health snapshot |

`store` and `conversion` sit downstream of `revenue` and `bigquery` and reach them through their
barrels. `sync` imports **nothing** from `auth`: the health snapshot's owner check reads the models
chokepoint directly, and the one shared value (`INSTALL_STATE_ID`) lives in the dependency-free
`src/constants/authVocab.constants.ts`, which the auth models and `auth.constants` also read. The reverse direction exists too — and **that** is where the barrel rule has teeth. See
§3.13 before adding any cross-module import.

### 3.4 The HTTP layer, and the security seam

`src/routes/index.ts` is the only place authentication is applied, and it is shaped so that the
default for a newly added router is **guarded**:

```ts
// 1. PUBLIC — two mounts, and both are argued for in the file
router.get('/healthz', _healthLiveness);
router.use('/api/auth', authRoutes);          // sign-in, setup, invitation acceptance, password reset

// 2. GUARDED — the guard is the router's FIRST layer
const guardedApiRouter = Router();
guardedApiRouter.use(authenticate);
guardedApiRouter.use('/account',       accountRoutes);
guardedApiRouter.use('/users',         userRoutes);
guardedApiRouter.use('/invites',       inviteRoutes);
guardedApiRouter.use('/roles',         roleRoutes);
guardedApiRouter.use('/audit-events',  auditRoutes);
guardedApiRouter.use('/partner-apps',  partnerAppRoutes);
guardedApiRouter.use('/sync',          syncRoutes);
guardedApiRouter.use('/revenue',       revenueRoutes);
guardedApiRouter.use('/funnel',        funnelRoutes);
guardedApiRouter.use('/conversion',    conversionRoutes);
guardedApiRouter.use('/stores',        storeRoutes);
guardedApiRouter.use('/stores',        countryRoutes);   // ⚠️ second router, same mount — see below
guardedApiRouter.use('/subscriptions', subscriptionRoutes);
guardedApiRouter.use('/meta',          metaRoutes);
router.use('/api', guardedApiRouter);
```

**Two routers share the `/stores` mount, on purpose.** `GET /api/stores/countries` is a rollup *of*
the roster and the frontend already documents that path, but it is its own area — its own
controller, service and vocabulary — so it gets its own file rather than a third line in
`store.routes.ts`. Express falls through a router that handles nothing, so `storeRoutes` declines
`/countries` and `countryRoutes` picks it up. Both are mounted on `guardedApiRouter`, so both are
behind `authenticate`.

Express runs a router's own middleware before dispatching to anything mounted on it, so a sub-router
added to `guardedApiRouter` is behind the guard **the moment it is added** — no second step, nothing
to remember.

The alternative — one router, with the guard applied one level up at a single mount and the route
files bare — is how a total authentication bypass ships unnoticed. Each route file reads as correct
in isolation, because nothing in it suggests a guard exists anywhere. Lift one into a new project, or
mount it on a different parent, and you publish a complete revenue dataset to anonymous callers.
Nothing throws, nothing logs, and it looks exactly like a working install.

`/api/auth` is registered **before** `/api`, so an unknown path under the public prefix falls
through to the guarded mount and answers **401 rather than 404** — the correct direction to be wrong
in.

**Authentication once, authorisation per route.** `authenticate` answers "who is this"; "may they do
*this*" is the one policy every guarded route declares as its **first route-level middleware**,
beside its handler — `requirePermission(PERMISSIONS.MERCHANTS_READ)`, or `requireSelf()` for the
`/api/account` routes any signed-in person may use. There is deliberately no router-level
permission: one line far from the handler covering everything below it is the shape this file exists
to avoid. An unknown key throws when the route file loads, so a typo stops the boot instead of
opening or closing a route silently (§3.5).

**The endpoint table as built — 66 routes, 10 public and 56 guarded.** Counted with:

```bash
grep -rE "^\s*router\.(get|post|put|patch|delete)\(" backend/src/routes/*.ts | wc -l   # 66
```

The policy column is what the route declares; `@self` is `requireSelf()`. The login limiter is
mounted in `apps/app.ts` behind the login path's own 8 KB parser (it reads the email and device
token) and before the general 1 MB one; the other three limiters are route-level in
`auth.routes.ts`, after it, because the token-flow one is keyed on the posted token.

| method | path | handler | policy |
|---|---|---|---|
| `GET` | `/healthz` | `_healthLiveness` | **public** |
| `POST` | `/api/auth/login` | `_createAuthSession` | **public** · `loginRateLimit` (app-level) |
| `GET` | `/api/auth/setup` | `_getAuthSetupStatus` | **public** |
| `POST` | `/api/auth/setup` | `_requestAuthSetup` | **public** · `setupRequestRateLimit` |
| `POST` | `/api/auth/setup/inspect` | `_inspectAuthSetupToken` | **public** · `tokenFlowRateLimit` |
| `POST` | `/api/auth/setup/complete` | `_completeAuthSetup` | **public** · `tokenFlowRateLimit` |
| `POST` | `/api/auth/invites/inspect` | `_inspectAuthInvite` | **public** · `tokenFlowRateLimit` |
| `POST` | `/api/auth/invites/accept` | `_acceptAuthInvite` | **public** · `tokenFlowRateLimit` |
| `POST` | `/api/auth/password/forgot` | `_requestAuthPasswordReset` | **public** · `passwordForgotRateLimit` |
| `POST` | `/api/auth/password/reset` | `_resetAuthPassword` | **public** · `tokenFlowRateLimit` |
| `GET` | `/api/account` | `_getAccountProfile` | @self |
| `PATCH` | `/api/account` | `_updateAccountName` | @self |
| `POST` | `/api/account/password` | `_changeAccountPassword` | @self |
| `POST` | `/api/account/logout` | `_logoutAccountSession` | @self |
| `POST` | `/api/account/sessions/revoke-others` | `_revokeAccountOtherSessions` | @self |
| `GET` | `/api/users` | `_listUsers` | `users:read` |
| `PATCH` | `/api/users/:user_id/role` | `_changeUserRole` | `users:manage` |
| `POST` | `/api/users/:user_id/disable` | `_disableUser` | `users:manage` |
| `POST` | `/api/users/:user_id/enable` | `_enableUser` | `users:manage` |
| `POST` | `/api/users/:user_id/sessions/revoke` | `_revokeUserSessions` | `users:manage` |
| `POST` | `/api/users/:user_id/password-reset` | `_sendUserPasswordReset` | `users:manage` |
| `GET` | `/api/invites` | `_listInvites` | `users:read` |
| `POST` | `/api/invites` | `_createInvite` | `users:manage` |
| `POST` | `/api/invites/:invite_id/resend` | `_resendInvite` | `users:manage` |
| `POST` | `/api/invites/:invite_id/revoke` | `_revokeInvite` | `users:manage` |
| `GET` | `/api/roles` | `_listRoles` | `users:read` |
| `POST` | `/api/roles` | `_createRole` | `roles:manage` |
| `PATCH` | `/api/roles/:role_id` | `_updateRole` | `roles:manage` |
| `DELETE` | `/api/roles/:role_id` | `_deleteRole` | `roles:manage` |
| `GET` | `/api/audit-events` | `_listAuditEvents` | `audit:read` |
| `GET` | `/api/partner-apps` | `_partnerAppList` | `apps:read` |
| `POST` | `/api/partner-apps` | `_partnerAppUpsert` | `apps:manage` |
| `GET` | `/api/partner-apps/:partner_app_id/kpi` | `_partnerAppKpi` | `financials:read` |
| `GET` | `/api/partner-apps/:partner_app_id/events` | `_partnerAppEvents` | `merchants:read` |
| `GET` | `/api/partner-apps/:partner_app_id` | `_partnerAppGet` | `apps:read` |
| `PATCH` | `/api/partner-apps/:partner_app_id` | `_partnerAppUpdate` | `apps:manage` |
| `DELETE` | `/api/partner-apps/:partner_app_id` | `_partnerAppDeactivate` | `apps:manage` |
| `POST` | `/api/sync/partner` | `_syncTriggerPartnerSync` | `sync:run` |
| `POST` | `/api/sync/bigquery` | `_syncTriggerBigQuerySync` | `sync:run_billed` |
| `POST` | `/api/sync/install-attribution` | `_syncTriggerInstallAttributionSync` | `sync:run_billed` |
| `POST` | `/api/sync/dummy` | `_syncTriggerDummySync` | `sync:run` |
| `GET` | `/api/sync/jobs` | `_syncListJobs` | `sync:read` |
| `GET` | `/api/sync/jobs/:job_id` | `_syncJobStatus` | `sync:read` |
| `POST` | `/api/sync/jobs/:job_id/cancel` | `_syncCancelJob` | `sync:run` |
| `GET` | `/api/sync/health` | `_syncHealth` | `sync:read` |
| `GET` | `/api/revenue/now` | `_revenueNowSummary` | `merchants:read` |
| `GET` | `/api/revenue/overview` | `_revenueWindowedOverview` | `merchants:read` |
| `POST` | `/api/revenue/shop-plans` | `_revenueShopPlans` | `merchants:read` |
| `GET` | `/api/funnel` | `_funnelOverview` | `analytics:read` |
| `GET` | `/api/funnel/traffic-source` | `_funnelTrafficSource` | `analytics:read` |
| `GET` | `/api/funnel/geo` | `_funnelGeo` | `analytics:read` |
| `GET` | `/api/funnel/install-cohort` | `_funnelInstallCohort` | `merchants:read` |
| `GET` | `/api/conversion/custom-funnel` | `_conversionCustomFunnel` | `analytics:read` |
| `GET` | `/api/conversion/funnel` | `_conversionFunnel` | `analytics:read` |
| `GET` | `/api/conversion/cohort-retention` | `_conversionCohortRetention` | `analytics:read` |
| `GET` | `/api/conversion/time-to-paid` | `_conversionTimeToPaid` | `analytics:read` |
| `GET` | `/api/conversion/plan-mix` | `_conversionPlanMix` | `financials:read` |
| `GET` | `/api/conversion/trial-outcomes` | `_conversionTrialOutcomes` | `merchants:read` |
| `GET` | `/api/conversion/trial-trend` | `_conversionTrialTrend` | `analytics:read` |
| `GET` | `/api/conversion/logo-churn` | `_conversionLogoChurn` | `merchants:read` |
| `GET` | `/api/conversion/revenue-churn` | `_conversionRevenueChurn` | `merchants:read` |
| `GET` | `/api/stores` | `_getStores` | `merchants:read` |
| `GET` | `/api/stores/detail` | `_getStoreDetail` | `merchants:read` |
| `GET` | `/api/stores/countries` | `_getCountries` | `financials:read` |
| `GET` | `/api/subscriptions` | `_getSubscriptions` | `merchants:read` |
| `GET` | `/api/meta/coverage` | `_metaCoverage` | `apps:read` |

⚠️ `POST /api/revenue/shop-plans` is a **read** served over POST. It takes up to two hundred shop
domains in one batch, and a query string that long is at the mercy of every proxy in between — the
verb is about the size of the payload, not about a mutation, which is why it carries a `:read`
permission. The route-guard test does not care about the verb, only about the guard.

**Controller contract.** Handlers are named `_<verbDomainResource>` and exported by that name;
`export = { … }`. They read the request bag through a single cast per handler
(`const q = (req.query || {}) as Record<string, any>`) — deliberately a cast, never a coercion
helper, because a helper that narrows query values to `string | undefined` silently discards
array-valued parameters at run time. They validate the *shape* of the request and nothing else:
every judgement about the **data**, including whether an empty answer means "not configured", "never
synced" or "genuinely no traffic", belongs to the service, which is also what the job runner and the
cron path reach. A second opinion formed in a controller is a second place for that answer to drift.

**Empty results are 200s.** The funnel endpoints answer successfully with an empty payload and a
populated reason. A 404 or a 500 collapses three different empty states into "something went wrong",
which is how a perfectly healthy unconfigured deployment starts looking broken.

**Service contract.** Every service takes `(identityObj, params)` and **resolves** a
`promiseReturnResult(status, data, error, msg)` envelope — it never rejects. `identityObj` is
`{ user_id }`; non-human callers use named ids (`BOOT`, `SYNC_WORKER`, and the auth module's own
sentinels for anonymous requests, the system and the CLI) so the caller is legible in a log line. The
two exceptions are the fatal boot steps `ensureInstallState` and `ensureAuthIndexes`, which throw so
that boot stops. An auth refusal carries `error.code`, and controllers map it to a status through
**one** table, `AUTH_ERROR_HTTP_STATUS`, via `apiResponse.serviceFailureResponse`.

### 3.5 Authentication, authorisation and mail

Multi-user sign-in with roles, in `modules/auth`, plus the `modules/mail` it sends through. People get
an account in **exactly two ways** — the first-run setup screen creates the owner, once, and an
emailed invitation creates everyone else. There is no public sign-up, no email change and no user
deletion (a leaver is disabled). Everything below was read out of the code; the operator's view of the
same thing is `DEPLOYMENT.md`, sections "Users, roles and permissions" and "Account recovery (CLI)".

**The install document is the setup lock.** `gi_system_states` holds one document, `_id: 'install'`,
with `setup_completed_at`, `owner_user_id` and `setup_token_id`. Setup is complete when
`setup_completed_at` is set — a persisted flag, **never** re-derived from a user count — and nothing
in the code ever unsets it. Ownership is the `owner_user_id` pointer and nothing else: there is no
owner flag on a user row (the owner's stored `role_key` is `admin`, which only matters if ownership
moves). Boot creates the document FATALLY (`ensureInstallState`), OPEN only when `gi_users` is empty;
a database that already holds users but no install document gets it LOCKED with no owner, and an
`ERROR` naming `transfer-owner`.

**Who may claim setup** is one rule, computed per call in `installState.service#resolveSetupRule` and
used by the setup request, setup completion, `GET /api/auth/setup` and the recovery CLI alike:
`SETUP_OWNER_EMAIL` if set; else the emails of every `gi_admin_users` row, if there are any (an
upgrade from the single-operator build); else **open**, which boot logs as a WARN. A datastore error
while reading it fails closed.

**Setup, in two steps.**

- `POST /api/auth/setup` answers the same `202` whether or not the address may claim setup. The
  response path does only email-independent work — shape, the lock, the global cap of 10 live setup
  links (`429 SETUP_CAPACITY`, nothing evicted) — and then **one deferred job** (`setImmediate`) does
  everything that depends on the address: the rule, the per-address throttles (≤3 live links, one a
  minute, three an hour), the token insert, the audit row and the send. Neither the answer nor its
  timing says whether the address is permitted; the log does.
- `POST /api/auth/setup/complete` is ordered so a crash anywhere leaves a recoverable state, with no
  transactions (Mongo standalone): shape → indexes ready (else `503`) → the install read → the live
  token (`400`, with the specific A14 code) → the address still permitted → the password policy
  (nothing consumed yet) → **claim** the token by compare-and-set, recording `{ name, password_hash }`
  on it → **lock** the install by compare-and-set to a pre-generated owner id → insert the owner row
  with that id → unset the claim and revoke every other live setup link → `201`. It never signs
  anyone in. A crash between the lock and the insert is rolled forward at the next boot from the
  claim (`reconcileSetup`); if the claim is gone too, boot logs the CLI command that repairs it.

**Sessions.** Sign-in (`session.service#login`) compares the password with bcrypt — against a dummy
hash when the address has no account, so an unknown address, a wrong password and a disabled account
cost the same time and get the same `401` — then writes a `gi_auth_sessions` row and signs an HS256
JWT carrying **ids only**: `sub` (user), `sid` (session), `aud: 'shopify-app-analytics'` and `exp`
from `AUTH_TOKEN_TTL_HOURS`. It is signed with HMAC-SHA256(`JWT_SECRET`, a fixed label), never with
`JWT_SECRET` itself: the single-operator build verified any HS256 token under the raw secret and read
nothing else, so a rollback would otherwise have accepted every token this build issued — a Viewer's,
a disabled account's — as its one full operator. Verification pins the algorithm and the audience; a
token without `sid`/`aud` — every token the single-operator build issued — is refused. A successful
sign-in re-hashes a password stored at a bcrypt cost other than `AUTH_BCRYPT_ROUNDS`.

**Every request re-reads who the caller is.** `middlewares/authenticate.ts` (the guard, first layer
of `guardedApiRouter`, §3.4) takes the bearer header only — missing ⇒ `401` before any database
access — verifies the JWT, then `principal.service#loadPrincipal` reads session → user → install
document → custom role. Any auth reason ⇒ `401`; a datastore failure ⇒ **`503`, never `401`**, so a
database hiccup does not sign anyone out. So a sign-out, a disable, a password reset or a role change
takes effect on the **next request**, not at token expiry. The session **epoch** closes the one race
in that: `gi_users.session_epoch` is copied onto a session at sign-in from the same user read the
bcrypt comparison used, and every "end all sessions" write (reset, disable, enable, sign-out
everywhere, the CLI) bumps it in the same update that changes the hash or status. A session whose
epoch no longer matches is `SESSION_STALE` ⇒ `401`. Change-password and "sign out my other sessions"
bump it too, and hand the caller a **fresh** token carrying the new epoch.

**One derivation of what a person may do.** `helpers/principal.helper.ts#resolvePrincipal` is pure
and is the only place role → permissions is computed: the owner pointer ⇒ every catalogue key; a
built-in role ⇒ its set from `roles.constants`; a custom role ⇒ its stored keys ∩ the catalogue, minus
owner-only keys, minus any key whose prerequisites are missing; a missing custom role ⇒ **no
permissions** (fail narrow, WARN). Permissions are never put in the token. `req.auth` is the frozen
result plus the session id.

**Authorisation is per route.** Each guarded route declares exactly one policy as its first
route-level middleware: `requirePermission(PERMISSIONS.X)` or `requireSelf()` (any signed-in person —
the `/api/account` routes). `requirePermission` throws **when the route file loads** if the key is not
in the catalogue, answers `401` with no `req.auth` (fail closed) and `403` with
`error: { code: 'FORBIDDEN', permission }` when the key is not held. The returned function is tagged in
a module-private `WeakMap` so a test can read which policy a route carries (`readPolicyTag`).
There is deliberately no router-level permission. Admin services re-load their **actor** from the
database by `identity.user_id` and re-check the permission themselves, rather than trusting anything a
controller hands in.

**The catalogue and the roles are code.** `constants/permissions.constants.ts` holds the twelve keys
in role-editor order, each with a label, a group, a description of what it discloses, and its direct
prerequisites; `roles.constants.ts` holds Owner (all), Admin (all but `roles:manage`), Analyst and
Viewer, nested Viewer ⊂ Analyst ⊂ Admin ⊂ Owner. Custom roles are rows in `gi_roles`, validated by one
pure helper (`role.helper`): ⊆ catalogue, `apps:read` present, prerequisites closed, no owner-only
key, name not a built-in's. The key strings are a cross-repository contract with
`frontend/utils/permissions.js`.

**One management rule.** `helpers/management.helper.ts#evaluateManagement` is the only definition of
"may this actor act on that person / invitation / role": never on yourself through the admin
endpoints, never on the owner through the API, the owner on anyone else, anyone else only with
`users:manage` and only where the target's permissions — and any role being granted — are a **strict**
subset of the actor's. It gates invite create/resend/revoke, role change, disable, enable, sign-out
everywhere and the admin-sent reset, and it computes `can_manage` / `manage_block_reason` on each
user row and which roles the UI offers. Writes re-assert the target's role in their compare-and-set
filter, so a decision taken against "Viewer" cannot land on someone promoted in between (`409
TARGET_CHANGED`).

**Invitations** (`invite.service`). One outstanding invitation per address is a database guarantee —
`pending_email` is set on create, unset on accept or revoke, and carries a unique **partial** index —
so a duplicate is `409 INVITE_PENDING` without a read-then-write race. Resend is one compare-and-set
that checks its own throttle (≥60 s since the last send, ≤5 sends in 24 h), rotates the token, resets
the expiry and makes the resender the inviter. Accept is one compare-and-set on (id, token hash,
live); a revoke racing an accept has exactly one winner, and an accept that loses deletes the user it
inserted. **An invitation is only as good as its inviter**: at inspect and accept time the inviter must
still be active and still allowed to grant the role, else the invite is revoked
(`INVITER_NO_LONGER_PERMITTED`). Role changes, role edits and ownership moves re-run that same check
over outstanding invitations (`reevaluateOutstandingInvites`, one spelling for all three), and
disabling someone revokes the invitations they sent.

**Passwords.** `helpers/password.helper.ts` is the policy: NFC-normalised, at least 15 code points,
at most 72 UTF-8 bytes (bcrypt would silently ignore the rest, so it is refused, never truncated), not
one repeated character, not on the 329-entry common-password list, not containing the email's local
part (when that is four or more characters), not equal to the name. No composition rules.
`services/passwordHash.service.ts` is the **only** bcrypt caller and the only source of a
`password_hash`. The schema carries no hashing hook, on purpose: under Mongoose 9 a `pre('save')` hook
receives its arguments directly and has no `next`, and a callback-style async hook lets the save
proceed before the callback runs — which is how a users collection ends up storing plaintext. Forgot
password answers the same `202` either way and defers everything email-dependent, like the setup
request; its per-account throttle is a compare-and-set on the user row. A reset link is refused once
the password has changed after it was issued. Wrong current password on change-password is `400`,
not `401` — a `401` would sign the dashboard out.

**Emailed links.** `services/authToken.service.ts` is the only `crypto.randomBytes` call for a link
token (32 bytes → 43 base64url characters) and the only place a link string is formed:
`${APP_PUBLIC_URL}${path}#token=…`, for exactly three paths (`/setup/verify`, `/accept-invite`,
`/reset-password`). Only the sha256 is stored (`select: false`, compared again in code after the
query); use is a compare-and-set, so a link works once; every lookup also requires
`expires_at > now` (the TTL index is cleanup only). The token rides in the **fragment**, so it reaches
no server log and no `Referer`, and the pages post it only on a button press. When a live-link lookup
fails, one more lookup by hash picks the specific answer — `TOKEN_EXPIRED`, `TOKEN_USED`,
`INVITE_REVOKED` or `TOKEN_INVALID` — which leaks nothing, since only the holder of a 256-bit token
can ask. Links are never built from the request: `eslint.config.js` refuses `req.hostname`, `req.host`,
`req.protocol`, `req.get()`, `req.header()`, `req.headers.host` and `x-forwarded-*` reads in `src/`.

**Mail** (`modules/mail`, which imports config, the logger and utils, and never `modules/auth`). One
lazily-created nodemailer transport: implicit TLS or required STARTTLS, certificate verified, TLS 1.2
minimum, 10/10/30 s timeouts — `SMTP_ALLOW_INSECURE=true` is the only way off that. Four templates
(setup confirmation, invitation, password reset, password changed) with **fixed subjects**, every
interpolated value HTML-escaped and stripped of control and bidi characters, a text part always, no
remote images, the expiry as a duration plus an ISO time in UTC, and the requesting IP only while
`TRUST_PROXY` is set. `sendTemplatedEmail` never throws and resolves one of `SENT` (accepted by the
server — never "delivered"), `FAILED`, `CAP_REACHED`, `UNCONFIRMED` (an admin-facing send passed its
15-second deadline; the message may still arrive) or `NOT_CONFIGURED`. The caps are in process memory:
`EMAIL_MAX_PER_HOUR`/`_PER_DAY`, of which anonymously-triggered mail may use half, and ≤10 per
recipient per 24 h, of which anonymously-triggered mail may again use half — so strangers requesting
resets for a member's address can never crowd out that member's password-changed notice or an
admin-sent reset. Boot checks the server once, off the critical path (`verifyMailAtBoot`).
`getMailStatus()` (every contact, sends included) feeds the Users page and the CLI; the setup
screen, which anyone can read, gets `getPublicMailCheck()` — the connect-and-login check only,
refreshed by `recheckTransport()` (coalesced, one per 30 s) on every setup request whatever the
address. A send happens only for a permitted setup address, so a status that sends could move would
name that address.

**Four rate limiters, one implementation.** `middlewares/loginRateLimit.ts#createRateLimiter` is the
factory; `loginRateLimit` (app-level, behind the login path's own 8 KB parser and before the general
one, charged only on `401`) and the three in
`authFlowRateLimit.ts` (route-level in `auth.routes.ts`) are instances. The token-flow one is keyed
on sha256 of the posted token and charged only for a dead link; forgot-password and the setup request
are keyed on `req.ip` and charged for everything except a shape `400`. Every one keeps the properties
the login limiter was designed around, because a lockout that one caller can impose on everybody is
worse than no limiter: a rolling **window**, never a lockout; refusals not charged; a deployment-wide
budget of 5× the per-key limit, with a key cap of 10,000 past which new keys charge that budget; a
30-second trickle once any budget is spent; nothing persisted, so a restart clears every block; and
**fail open** — a throw inside admits the request and logs. Two rules hold for all four: a success is
never charged and wipes nothing (when sign-in success cleared the tally, any member could reset the
count between guesses at the owner's password), and a caller who hangs up after the whole request
arrived is judged by the answer the handler still produces, never refunded for the hang-up (the
handler runs bcrypt either way). Sign-in adds a **device budget**: a successful sign-in returns a
`device_token` (HMAC under a key derived from `JWT_SECRET`, bound to the email, 90 days), and a later
attempt for that email carrying it is metered on the device's own budget instead of the shared ones —
the trickle alone admits whoever polls first, so it is the device budget that keeps a returning user
in during a flood. ⚠️ The address-keyed ones are only as per-address as `TRUST_PROXY` makes `req.ip`
(§7).

**The security activity log.** `gi_audit_events`, written by `audit.service#recordAuditEvent`, which is
best-effort (it never fails the action it describes) and refuses to store a token, password, hash,
secret or link under any key. Thirty actions, from `SETUP_REQUESTED` to `CLI_USER_ENABLED`; every
role reference carries a label snapshot. Rows from anonymous requests expire after 180 days; the rest
are kept. Read through `GET /api/audit-events` (`audit:read`), newest first, cursor-paged.

**The recovery CLI** (`src/scripts/authAdmin.ts`, `npm run auth:admin[:dist] -- <command>`) is the
path when the dashboard cannot help: `status`, `setup-link`, `reset-link` (15 minutes),
`revoke-sessions`, `enable`, `transfer-owner`, `repair-owner` (which revokes the missing owner's
sessions and withdraws their invitations before reusing the id). Shell access is the trust boundary, so
it prints links instead of mailing them and skips the per-address throttles; it never accepts a
password argument, never reopens setup, and audits as actor type `CLI`. It checks only `MONGO_URI`
(plus `APP_PUBLIC_URL` for link commands), not the full TIER-1 set, so it runs while a missing mail
setting keeps the server down. Exit codes: 0 done, 1 refused or failed, 2 bad command line.

**Status codes are a contract.** `400` bad input, a bad or expired link, or a password-policy refusal;
`401` only for authentication (the guard, or bad sign-in credentials) — a public token endpoint never
answers `401`, because the dashboard signs out on one; `403` permission denied or the management rule
refused; `404` an unknown id (ids are checked against `/^[0-9a-f]{24}$/` first, never a `CastError`
500); `409` a conflict; `429` a limiter or throttle; `503` the datastore could not be consulted, or
the auth indexes are not built yet. Services put a code in `error.code`; every controller maps it
through one table, `AUTH_ERROR_HTTP_STATUS`, via `apiResponse.serviceFailureResponse`.

Kept from the single-operator build, and still load-bearing:

- **Tokens expire.** `expiresIn` is always set from `AUTH.TOKEN_TTL_HOURS` (default 12). The system
  this was extracted from signed without one, and a token with no expiry stays valid forever.
- **Failures are real status codes**, with a JSON body. An API that answers every authentication
  failure with HTTP 200 and `{status:false}` can no longer use 401 for what it means — and now also
  needs 403 to mean "signed in, but not allowed", which it could not express at all.

### 3.6 The data model

Sixteen collections, all prefixed `gi_`. Mongoose 9, `autoIndex` on by default (right for a
single-tenant self-hosted install; `MONGO_DISABLE_AUTO_INDEX=true` opts out — except for the six auth
collections below whose indexes carry gates or TTLs, which boot builds explicitly either way, §3.1).

| collection | holds | unique key |
|---|---|---|
| `gi_partner_apps` | the app(s) being reported on, plus every **coverage watermark** | `partner_api_app_id` |
| `gi_partner_app_events` | install / uninstall / reinstall / deactivate / subscription-charge events | `partner_event_id` |
| `gi_partner_app_transactions` | settled payouts — the money ledger | `shopify_transaction_id` |
| `gi_listing_funnel_dailies` | daily listing funnel from GA4 | `(partner_app_id, date)` |
| `gi_listing_source_dailies` | daily traffic source × medium | `(partner_app_id, date, source, medium)` |
| `gi_listing_geo_dailies` | daily country split | `(partner_app_id, date, country)` |
| `gi_listing_install_attributions` | one row per install, with its acquisition surface | `(partner_app_id, shop, installed_at)` |
| `gi_sync_jobs` | the job queue and its history | — |
| `gi_system_states` | one document, `_id: 'install'`: the setup lock (`setup_completed_at`), the owner pointer (`owner_user_id`), the setup link that completed it | `_id` |
| `gi_users` | accounts: email, name, bcrypt `password_hash` (`select: false`), stored `role_key` + `custom_role_id`, status, `session_epoch`, the reset throttle log | `email` |
| `gi_roles` | custom roles only (built-ins are code): name, description, permission keys | `name_norm` |
| `gi_invites` | invitations and their fate — role, inviter, expiry, accepted / revoked and why, send log | `token_hash`; `pending_email` (**partial** — only while outstanding) |
| `gi_auth_tokens` | setup-confirmation and password-reset links, as hashes; the setup **claim** (`select: false`) until the owner row exists | `token_hash`; TTL: 7 days after `expires_at` |
| `gi_auth_sessions` | one row per sign-in: user, expiry, revocation and why, epoch, ip, user agent | `_id` (the JWT's `sid`); TTL at `expires_at` |
| `gi_audit_events` | the security activity log | — ; TTL at `expires_at`, set only on anonymous rows (180 days) |
| `gi_admin_users` | accounts from the single-operator build, stamped `legacy_at` at boot. Never read by sign-in; read only as the legacy setup allow-list, by the CLI's `status`, and counted by the health snapshot | `email` |

Every unique index is **explicitly named** (`uniq_partner_event_id`, `uniq_app_date`,
`uniq_user_email`, …). That is not cosmetic: mongoose's "Duplicate schema index" warning fires only
when two specs are unnamed and resolve to the same default name, and it masks an
`IndexOptionsConflict` that leaves the second index **silently unbuilt** — so a uniqueness guarantee
that is load-bearing for idempotency never exists.

⚠️ **`strictQuery: true` (set in `core/db.ts`) silently strips undeclared filter paths** — a filter
on a field the schema does not declare becomes `{}` and matches the first document. So every field
the auth code filters or `$set`s on is declared — `test/authQueryPaths.test.js` records every auth
repository's filters and updates and fails on an undeclared path — and every token and session
lookup **also compares the matched document's key field in code** after the query. The auth writes use single-document
compare-and-set (`findOneAndUpdate` with the expected state in the filter,
`returnDocument: 'after'`) as their only lock, and a duplicate-key error is read by its
`keyPattern` — `_id` means already done, `email` means already a member, `pending_email` means an
invitation is outstanding, `name_norm` means the role name is taken.

`gi_partner_apps` is the interesting one: alongside the app's identity it carries the measurements a
sync records **about its own completeness** — `earliest_event_at`, `earliest_transaction_at`,
`lifetime_sync_completed_at`, `event_history_gap_days`, `charge_link_absent_pct`,
`charge_link_unresolved_pct`, and the three `last_*_synced_at` watermarks. Those are the gates a read
service consults before it publishes anything, and the watermarks are what turn "no rows" into
"never synced" rather than "no traffic".

**Three join bridges, each defined once** in `modules/shared/helpers/`:

| bridge | file | why |
|---|---|---|
| shop domain | `shopDomain.helper.ts` | three systems store the myshopify domain in three shapes; normalised on **both** sides of every join so a scheme or a capital letter cannot drop a store out of a count |
| charge id | `chargeId.helper.ts` | Shopify hands the same charge as a GID and as a bare numeric id; normalised on the **write** side so readers match directly |
| partner app gid | `partnerGid.helper.ts` | the Partner API needs `gid://partners/App/<id>` and rejects a bare numeric at *resolve* time — GraphQL's `ID` scalar accepts it, so type-checking gives zero protection |

Each was hand-rolled per call site once, in slightly different forms. That is exactly how one bridge
acquires three spellings and the same store joins in one report and not another.

### 3.7 The job runner

The module this was extracted from ran on Azure Service Bus: it wrote a row to the job collection
*and* pushed a message naming that row. Every hard case in that design came from the two copies
disagreeing. Deleting the copy deletes the machinery, because **the durable truth was always the
row** — a message was a pointer, and a pointer to a row you can query for is not information.

Exactly-once ownership comes back from MongoDB directly: a single-document update is atomic, so a
conditional update naming the required state settles who owns a job with no coordination at all.

```
every SYNC_POLL_INTERVAL_MS (default 15s):
  1. sweep stuck rows          (throttled to STUCK_SWEEP_INTERVAL_MS = 15 min)
  2. ask for up to (MAX_CONCURRENT_JOBS − in-flight) candidate ids
  3. for each: CLAIM it, and run it only if the claim was WON
  4. reschedule
```

`setTimeout` re-armed after each tick, never `setInterval` — an interval fires on a fixed wall clock
regardless of whether the previous tick finished, so a slow database turns one poll into a pile-up.

The atomic write lives in `repositories/syncJob.repository.claimPendingJob`; the `modifiedCount === 1`
gate that interprets it lives in `syncJob.service.markJobRunning`. The runner **respects** the claim
and treats a lost one as an ordinary outcome. Neither is re-implemented in the runner, because a
second spelling of the most safety-critical query in the application is how the two drift and
double-execution becomes possible.

- **States:** `PENDING → RUNNING → SUCCESS | FAILED | CANCELLED`
- **Triggers:** `MANUAL` (a button) or `CRON`. Crons: `SYNC_DAILY_CRON` 03:00, `BIGQUERY_SYNC_CRON`
  02:00, `INSTALL_ATTRIBUTION_SYNC_CRON` 06:00
- **Handlers** are registered two ways: statically in the runner's table (`DUMMY`, `BIGQUERY_SYNC`,
  `INSTALL_ATTRIBUTION_SYNC`) and dynamically from `apps/app.ts` (`PARTNER_SYNC`, which would
  otherwise pull the partner module into the sync module). `assertHandlersRegistered()` covers both.

#### Retry is an allowlist, and a swept row is NOT on it

`RETRYABLE_FAILURE_REASONS` in `modules/sync/constants/sync.constants.ts` holds **exactly one**
entry:

```ts
const RETRYABLE_FAILURE_REASONS = Object.freeze([ SYNC_JOB_FAILURE_REASONS.HANDLER_ERROR ]);
```

`markJobFailed` returns a row to `PENDING` only when its reason is in that list *and* the attempt
budget is not spent. The two reasons that are **absent** are the content of the list:

| failure reason | who writes it | retried? | why |
|---|---|---|---|
| `HANDLER_ERROR` | the handler threw | **yes**, up to `SYNC_MAX_ATTEMPTS` (3) | A transient upstream is the common case. |
| `UNKNOWN_JOB_TYPE` | the runner, on a claim it cannot dispatch | **no** | It will never succeed. Retrying burns the attempt budget to reach the same answer three times and buries the one useful signal — that a handler is not registered — under duplicate failures. |
| `STUCK_TIMEOUT` | the **sweeper**, never a handler | **no** | A run killed mid-flight **may have written part of its output**. Blindly re-running a partially applied job is how a double-counted figure is created. A human decides whether that one is safe to re-run. |

So: rows `RUNNING` past `SYNC_STUCK_RUNNING_MS` (30 min) and rows `PENDING` past
`SYNC_STUCK_PENDING_MS` (60 min) are set to `FAILED` with `failure_reason: STUCK_TIMEOUT` —
**a terminal state.** They are not claimable again, and that is the safety property, not a gap.

⚠️ One `STUCK_TIMEOUT`, two opposite faults. Swept out of `RUNNING` means a job outlived the
threshold — usually a lifetime backfill against a value tuned for incrementals, so **raise the
threshold**. Swept out of `PENDING` means nothing ever *claimed* the row, so **no runner is alive** —
check `SYNC_DISABLED` and the process. `syncHealth.service` branches on the row's previous status to
give the right advice, because the reason string alone cannot.

### 3.8 The Partner sync

`modules/partner/services/partnerSync.service.ts` pulls the entire factual basis of the application:
two GraphQL connections, walked page by page and upserted.

**Idempotent by construction.** Each collection has a unique key and every write is an upsert against
it, so re-running the same window produces zero new rows. That is what makes overlap on incremental
runs free, and what makes "just re-sync it" a real repair rather than a duplication event.

**The client is read-only, three ways.** `clients/partnerApi.client.ts` rejects any document
containing a `mutation` before the HTTP call leaves the process; the sync service uses hard-coded
GraphQL documents with no runtime-constructed operation strings; and no other file in the codebase
imports axios for `partners.shopify.com`. The token is the operator's own Partner API token, and an
analytics tool has no business being able to change anything with it. Rate limiting is two-layered: a
process-wide `stopcock` token bucket (4 req/s by default), plus a bounded retry inside the request
on 429 and 5xx — and on an HTTP 200 whose GraphQL `errors` array reports throttling, which is the
second way Shopify says it.

**Why the charge block is requested.** Each subscription-charge event asks for
`charge { id name test billingOn amount { … } }`. `billingOn` **is the trial-end date** and is the
highest-fidelity input anything downstream has: with it, a trial's length is a fact Shopify told us;
without it the only alternative is inferring one from the gap between ACCEPTED and ACTIVATED, which
invents a number for every charge that never activated. `name` gives the plan, `test` marks charges
to exclude from revenue, `amount` is the contracted price.

#### The horizon asymmetry

One `since_iso` is applied to **both** connections, and the same window has completely different
consequences on the two sides. This is the single most important fidelity fact in the system, and
`FIDELITY.md` §3 covers it in full.

- **Events are horizon-bound in both directions.** An event is a point-in-time fact, emitted once and
  never re-emitted. A 90-day event window does not merely truncate history — it **erases entire
  shops**: a store that installed two years ago and has paid every month since has no event at all
  inside it.
- **Transactions are horizon-bound for history only.** A shop billed last week appears in a 90-day
  transaction window regardless of when it installed.

This asymmetry is why MRR is computed from the **payout ledger** rather than by replaying event
timelines (§3.10), and why `coverage.helper.ts` exists at all.

#### Coverage

`modules/partner/helpers/coverage.helper.ts` measures the fact the whole design rests on and cannot
assume: how far back the record really reaches, and whether `charge_id` genuinely bridges events to
transactions. An incomplete collection does not fail — it *answers*. A month that was never synced
and a month in which nothing happened return the same empty result set, and a naive fold reports `0`.

The helper is **pure** — the extremes and counts are gathered by
`repositories/partnerCoverage.repository` and handed in — and every function returns `null` rather
than a comfortable zero whenever its denominator is empty:

```
null = not measurable (nothing to measure it from)
0    = measured, and the answer is none
```

### 3.9 The listing-analytics tier (BigQuery)

Optional. Powers the Funnel page's upper steps, all of Traffic Sources, and install
attribution. Off unless `GCP_PROJECT_ID` + `BQ_DATASET` + credentials are all present — that is what
`BIGQUERY.ENABLED` means, and `startBigQuerySyncCrons()` arms nothing without it and says so once at
boot rather than as a nightly error.

**Write side** — `bigQuerySync.service.ts` runs three independent queries concurrently against the
GA4 daily export tables, each with its own counters, because "the card is empty" has three completely
different causes that must not look alike:

```
rows_fetched = 0                the QUERY found nothing (wrong window, or genuinely no traffic)
rows_fetched > 0, upserted = 0  the WRITE path is broken
skipped_no_date > 0             the rows came back unreadable
```

`installAttributionSync.service.ts` is separate and runs on its own schedule: one row per install
with its acquisition surface (`surface_type`, `surface_detail`, positions, `surface_via`), which is
what makes "which surface produced merchants who stayed" answerable. It supports `dry_run: true`,
which **prices** the scan (`gib_scanned`, `exceeds_cap`) instead of running it.

> ⚠️ **Cost.** Every run scans one daily table per day in the window, three times over. The window is
> the bill — see `helpers/syncWindow.helper.ts`. `BQ_MAX_BYTES_BILLED` (200 GiB default) is a hard
> cap on the job, and the dry run exists so an operator can see the number before spending it.

**Read side** — `bigQueryAnalytics.service.ts` serves the dashboard **entirely out of the Mongo
rollups**. Nothing on a request path touches BigQuery: a dashboard request must never be able to
start a billed scan.

#### Three ways to have nothing to show

```
1. NOT_CONNECTED    no credentials      status:false + a message naming the missing variable
2. NEVER_SYNCED     connected, no sync  status:true, items/summary NULL, data_state:'NEVER_SYNCED'
3. READY            synced, empty window status:true, items:[], real zeros
```

Case 2 collapsing into case 3 is the failure this whole project exists to refuse: an empty array and
a zeroed funnel are **claims about the merchant's listing**, and neither has been earned until a sync
has actually run.

**The discriminator is the watermark, never the row count.** A window with no rows is a perfectly
ordinary answer once a sync has happened. `last_bq_synced_at` is what separates the two, which is why
it is read here and turned into an explicit state rather than left implicit.

§4.5 covers the frontend half of this contract — and the fact that it was silently discarded once.

### 3.10 The revenue engine

`modules/revenue/helpers/ledgerMrr.helper.ts` is the canonical definition of *who is paying us and
how much*. Every MRR figure comes through it. It is published from the module barrel rather than kept
private precisely because the last time this logic was reachable only by copying it, two pages
reconstructed MRR independently and disagreed with each other.

**MRR is computed from the settled payout ledger, not from event replay.** Reconstructing it by
replaying each shop's event timeline (INSTALL → CHARGE_ACTIVATED → CANCELLED/UNINSTALL) requires a
complete lifetime event history per shop and silently drops any shop it cannot reconstruct — most
visibly a shop whose install predates the synced range even though it is actively paying today
(§3.8). A shop Shopify **billed** is a paying shop; no event history required.

**The as-of predicate, defined once and evaluated identically everywhere:**

> Shop *S* is paying as of *D* iff its most recent settled subscription charge at or before *D*
> carries a positive amount **and** landed within one billing cycle of *D*, plus grace.

Evaluating the same predicate at every boundary is what makes the headline figure and the monthly
series consistent by construction rather than by agreement.

Two defects this replaced, both caused by defining membership by **calendar month**:

1. **The annual blind spot.** An annual subscriber is billed once a year, so under a fixed 38-day
   window it vanished from MRR for ~11 months of every 12 — and the `/12` normalisation never got the
   chance to run. The window is now derived from the shop's own billing interval.
2. **Manufactured churn.** A 30-day cycle does not align to calendar months: 12 × 30 = 360, so every
   shop skips one calendar month a year. Calendar-month membership reported each of those as CHURNED
   and NEW the next — falsely churning ~1/12 of the base every month and inflating new MRR by the
   same amount. An as-of window wider than the cycle cannot produce that artefact.

**`ACTIVE_SUB_WINDOW_DAYS` (38) is one 30-day cycle plus a week of payout grace**, and both
directions of getting it wrong have shipped and been measured:

- **too narrow** — merchants bill on their own cycle and Shopify settles when it settles. One
  merchant's payouts landed in April and then not again until July; a naive recency check called them
  churned for their full value and produced a **47.6% churn reading for a month in which nobody
  cancelled**;
- **too wide, or removed** — cancellations that never sync stay in the paying set forever. Removing
  the check produced **$45M of MRR against $10K of real settled payouts**, on a suspiciously flat
  line. A flat MRR line is itself the tell: a real subscriber base moves.

**Two kinds of money, kept apart.** Run-rate (`mrr`, `active_subs`, `arpu`) is a point-in-time rate;
cash (`lifetime_*`) is what Shopify actually settled, all time. They are not two spellings of one
number and are not expected to track — cash is lumpy (annual prepayments, refunds, payout timing)
where a run-rate is smooth. Separate blocks, separate labels.

**Units.** `gross_amount` is what the merchant paid. Annual charges are divided by 12; a year of
revenue booked whole overstates a monthly run-rate twelvefold.

`revenueNow.service.ts` is deliberately thin — every figure is either read through
`repositories/revenue.repository` or computed by the helper, so it cannot disagree with any other
view built on the same ledger. Its three gates:

| state | result |
|---|---|
| no settled payouts at all | every figure `unknown` |
| payouts exist, none is a subscription charge | cash block `measured`, run-rate block `unknown` |
| subscription charges exist, none live right now | `mrr`/`active_subs` are a **measured zero** — a real answer, and it must not be downgraded either |

### 3.11 The confidence envelope

`modules/shared/helpers/confidence.helper.ts` is the only place an envelope is built. Four
constructors, and **an `Envelope` literal must not be written anywhere else** — an object literal can
claim `confidence: 'measured'` over a number nobody measured, or pair a `null` value with a
confidence that says the number is known, and both compile.

```json
{ "value": 1420.5, "confidence": "estimated", "source": "settled payouts",
  "caveat": "3 of 41 live shops carry no billing_interval; any annual subscriber among them is booked at 12x" }
```

| level | means | carries |
|---|---|---|
| `measured` | counted directly out of stored records | `source` |
| `derived` | computed from other figures | `source`, `caveat` = the arithmetic |
| `estimated` | approximated by a real method | `source`, `caveat` = the assumption **and its direction of error** |
| `unknown` | **there is no answer** — not a small one, not zero | `source`, `reason` |

The missing-value test is `=== null || === undefined || !isFinite(value)` and deliberately **not**
`!value`. A falsy check would erase the exact measured zero the primitive exists to distinguish, and
`false` and `''` are real answers too. `NaN` and `±Infinity` are treated as missing on purpose: they
are what an empty denominator produces, they are typed `number` so nothing upstream objects, and they
render as the literal words "NaN" and "Infinity" on a dashboard.

Rendering rules that follow from this, and that the frontend has to honour: a `null` renders as `—`
with its reason, and a chart **breaks the line** rather than drawing a point at the floor.

---

### 3.12 The derived store roster — and why there is no store collection

There is **no `gi_stores`** and no roster document anywhere. Every field on every row of
`GET /api/stores`, `GET /api/subscriptions` and `GET /api/stores/countries` is folded **on read**
from three collections that already hold it on the same normalised `shop_domain`:
`gi_partner_app_events`, `gi_partner_app_transactions` and `gi_listing_install_attributions`.

**Why.** A materialised roster would store a *derivable* value, so its only possible relationship
with truth is agreement or drift — and the drift is invisible and directional. Nothing errors when a
roster row goes stale; the page renders, and it renders a merchant in a state they left months ago.
The three source collections are append-mostly and upserted against unique keys, so the fold over
them is reproducible; a cached projection of them is not.

`repositories/storeRoster.repository.ts` carries the argument, the measured cost of deriving, and an
**escape ladder** to climb before anyone reconsiders. Its third rung is publishing
`install_state_counts: null` with a reason and serving the list alone. There is deliberately no rung
that materialises a count.

⚠️ `gi_store_enrichments` appears in several type comments as a *later* wave — operator-pushed store
profiles. It does not exist. The keys that would carry it (`operator`, the operator name candidates)
are declared now and are always `null`/empty, so landing that ingest fills a slot rather than
changing a signature.

#### The shared fold: `resolvers/storeRoster.resolver.ts`

Three services run the **same** fold, and it is a file rather than a block inside one of them:

```
GET /api/stores         → services/storeRoster.service      ┐
GET /api/subscriptions  → services/subscriptionList.service ├→ resolveStoreRosterFold()
GET /api/stores/countries → services/countryRollup.service  ┘
```

It was a block inside `storeRoster.service`, and it stayed correct only while there was one caller.
Copying it to serve the second would have created a **second definition of "is this shop paying"** —
the single failure `modules/revenue/index.ts` records from the system this was extracted from: *two
pages reconstructed MRR independently and disagreed with each other.*

What it publishes: the population, the paying set, the two tier states and every exclusion **count**.
What it does not decide: filtering, facets, counts-as-sentences, sort, paging, warnings, wire shape.
Turning a count into a sentence an operator reads is the service's job, because the sentence differs
per page ("this roster is a floor" vs "this list of paying merchants is a floor").

Two deliberate properties:

- **It is the one resolver in the codebase that does I/O.** Its four siblings fold already-fetched
  rows. This one issues its own five reads because *the reads and the fold over them are one
  decision*. A caller that fetched its own rows could bound them differently — the charge pull's
  `$lte: as_of` **with no `$gte`** is not a detail, it is what stops a paying customer being reported
  as never having subscribed — and the pages would drift apart through the query rather than the
  fold.
- **It still reads no clock.** `as_of` is a parameter, resolved once by the service, so a single
  response cannot classify one store as of two different milliseconds.

### 3.13 The three single derivations, and the barrel rule that protects them

Three definitions exist exactly once in this codebase. A second copy of any of them produces two
plausible numbers on two screens with nothing on either to say which is right — the failure class
this project exists to refuse.

| the one definition | lives in | published through | who folds from it |
|---|---|---|---|
| **`liveSetAsOf`** — *which shops are paying at an instant, and at what monthly amount* | `modules/revenue/helpers/ledgerMrr.helper.ts` (PURE) | `modules/revenue`'s barrel | the Revenue screen's Revenue and Churn tabs, Logo Churn, Plan Mix, Subscriptions, the country rollup, and the store roster |
| **`resolveChurnDate`** — *when a paying relationship ended, and which evidence says so* | `modules/conversion/helpers/churnDate.helper.ts` (PURE) | `modules/conversion`'s barrel | Logo Churn *counts* them, the Revenue screen's Churn tab *prices* them, its movement panel *lists* them with a "Stopped on" date |
| **`resolveInstallStates`** — *is the app on this store right now* | `modules/store/resolvers/installState.resolver.ts` (PURE) | deep path (see below) | Stores, Subscriptions, the country rollup, retention checkpoints, the Partner Apps KPI tile |

**`liveSetAsOf` is a membership predicate, and no module may define a second one.** Not "more
installs than uninstalls", not "billed in the last N days" written out again locally — the predicate
itself, or nothing. Its window is interval-aware (`liveWindowDaysFor`), which is why an annual biller
is not read as churned; a calendar-month membership test would falsely churn roughly 1/12 of the base
every month, because a 30-day biller skips one calendar month a year.

**`resolveChurnDate` publishes its date beside its `basis`, never instead of it.** The two bases are
not equally strong: `partner_event` is Shopify telling us a merchant cancelled, `ledger_window` is an
inference from silence — the instant the last settled charge aged out. A reader who cannot tell them
apart reads a window expiry as a cancellation the merchant made.

#### ⚠️ A module must not import another module's BARREL when that closes a cycle

The default is still: **siblings by deep path, other modules by their barrel.** Twenty-five
cross-module barrel imports exist and are correct — eighteen among the analytics modules, and seven
from `auth` services into `mail` — count them with:

```bash
grep -rhcE "^import \w+ = require\('\.\./\.\./(auth|mail|partner|revenue|bigquery|sync|store|conversion|shared)'\);" \
  backend/src --include=*.ts | awk '{t+=$1} END{print t}'   # 25
```

But a barrel **eagerly loads the whole module**, and in four places that closes an import cycle
between two files that have no edge between them at all.

**This failure is silent at typecheck AND at lint.** Node reports only
`Warning: Accessing non-existent property … inside circular dependency`, which is easy to scroll
past. The visible symptom is a destructured function that is `undefined` at load and throws on every
call, so the service resolves `status: false` and the page says "could not read". **It cost fifteen
tests once**, and the incident is recorded verbatim at the top of
`modules/revenue/repositories/revenue.repository.ts`:

```
revenue/index → services/revenueNow.service → repositories/revenue.repository
  → conversion/index → services/logoChurn.service → revenue/index   (still initialising)
```

`logoChurn.service` destructured `liveSetAsOf`, `liveWindowDaysFor` and `diffMonths` as `undefined`,
every call threw, and `getLogoChurn` resolved `status: false`.

The four deep-path exceptions, each annotated at its import site:

| in | reaches | by | because the barrel would |
|---|---|---|---|
| `revenue/repositories/revenue.repository` | `conversion/constants/lifecycle.constants` | deep | close the loop above |
| `revenue/services/revenueOverview.service` | `conversion/helpers/churnDate.helper` | deep | close the same loop |
| `conversion/services/planMix.service` | `revenue/helpers/ledgerMrr.helper`, `revenue/repositories/revenue.repository` | deep | load every revenue service, each reaching the model registry |
| `partner/**` (KPI service + read repository) | `store/resolvers/installState.resolver`, `store/constants/storeRoster.constants`, `revenue/repositories/revenue.repository` | deep | load four store services, each reaching the model registry |

**The reuse the barrel exists to enforce is fully preserved in all four.** Each reaches the
*canonical* definition rather than growing a second one; only the *path* changes. The rule for the
target is what makes it safe: **a deep path is only legal to a leaf that cannot close a loop** — a
PURE helper, a resolver that imports only constants, or a repository that imports only the model
chokepoint and a constants file.

**Before adding a cross-module import, check the direction.** `modules/store` and `modules/conversion`
may reach `modules/revenue` and `modules/bigquery` through their barrels; `modules/sync` may reach
`modules/bigquery`; `modules/auth` may reach `modules/mail`. The reverse — `revenue` or `partner`
reaching `conversion` or `store`, or `mail` reaching `auth` — must be a deep path to a leaf, and
`mail` has no reason to reach `auth` at all. `modules/sync` imports nothing from `auth`: the one value
they share lives in `src/constants/authVocab.constants.ts`, a leaf with no imports.

The graph is acyclic today: of 313 TypeScript files, **198 carry a value-import edge and there are
zero strongly-connected components**, measured by building the relative `import`/`require` graph over
`backend/src` (type-only imports excluded — they are erased and cannot cycle at run time) and running
Tarjan's algorithm over it. There is no npm script for this, but CI is not blind to it: the
`Import cycles` step in `.github/workflows/ci.yml` loads every `src/modules/*/index.ts` in a fresh
`node --trace-warnings` process and fails the job on a `circular dependency` warning or a module that
will not load at all (8 entry points, `mail` included, exit 0 as of this writing). That is a RUN-TIME probe of the
barrels, not the static whole-graph analysis above — a cycle reachable only through a deep path that
no barrel pulls in would still slip past it. If you want the stronger guard, Tarjan over the
`import x = require('…')` graph is the shape it needs.

The better long-term fix, named in the code: promote the genuinely cross-module vocabularies
(`CHARGE_COHORT_EVENT_TYPES` and friends) to `src/constants/`, where a cross-module list belongs, and
the cross-module import disappears entirely.

---

## 4. Frontend

Next.js 15 (pages router), React 18, Shopify Polaris 12, Recharts 3, axios. No state library — page
state is local, and three contexts carry what is genuinely shared (`sessionContext` = who is signed in
and what their role allows, §4.3a; `growthIntelContext` = the selected app; `loaderContext`).

### 4.1 One origin

Every request the dashboard makes is to a **relative** path. It never names the backend's host.
`next.config.js` rewrites `/api/:path*` and `/healthz` to the API inside the Next server, so:

- the browser talks to one origin — no CORS preflight anywhere, in dev or in production;
- the backend needs no `Access-Control-Allow-Origin` for the dashboard at all;
- moving the API is one environment variable, with nothing rebuilt into the client bundle.

> ⚠️ **Do not add a `pages/api/` directory.** A plain `rewrites()` array is applied *after* filesystem
> routes, so `pages/api/foo.js` would shadow `/api/foo` and silently stop it reaching the backend.

### 4.2 The build-time freeze, and the sentinel

`next build` calls `rewrites()` **once, at build time**, and freezes the resolved destination into
`.next/routes-manifest.json` (and, for `output: 'standalone'`, into `server.js` and
`required-server-files.json`). `next start` re-evaluates `next.config.js` at boot — which is why the
value *looks* runtime-configurable if you only read the source — but never calls `rewrites()` again.

Verified empirically: built pointing at port 1111, started with the variable pointing at port 2222;
the request arrived at 1111. `next dev` is the exception and does re-evaluate.

Consequence for Docker: an image built with nothing set bakes in `http://localhost:8080`, and inside
the frontend container `localhost` **is the frontend** — so every API call fails with a connection
refused that names no cause. The Dockerfile therefore builds with a **sentinel placeholder** and
`docker-entrypoint.sh` substitutes the real value into those generated files at container start,
restoring the build-once-deploy-anywhere property. `NEXT_PUBLIC_API_BASE_URL` stays a runtime
variable; the mechanism that makes it one lives in the Dockerfile, not the config.

### 4.3 The API client

`API_Services/apiClient.js` — one axios instance, `baseURL: '/api/'`, and the token read **per
request in an interceptor**.

That last part is not a style choice. Services are instantiated at module load
(`const API = new SomeService()` at the top of a page), which happens *before* the user logs in. A
client that reads the token in its constructor captures whatever was there at import time, so a fresh
login does not reach it until a full page reload — and a logout keeps being honoured. Reading per
request makes both immediate.

**401 and 403 mean different things, and the interceptor treats them differently.** A `401` from any
path outside `/api/auth/*` means the session is over: the token is cleared and the page redirects to
`/login` once, with `next` set to where you were (never carrying a URL fragment, which on a token page
is a credential). A `401` from `/api/auth/*` never clears or redirects — from sign-in it means a wrong
password, and the token flows never answer `401` by contract. A `403` is passed to the calling service
untouched, and listeners registered with `onForbiddenResponse` are told; the session context uses that
to re-read the account (§4.3a), because a `403` usually means the role just changed.

### 4.3a Who is signed in, and what they may open

**Public pages.** `utils/publicRoutes.js` lists them once — `/login`, the error pages, `/setup`,
`/setup/verify`, `/accept-invite`, `/forgot-password`, `/reset-password` — and `_app.js`,
`apiClient.js` and `login.js` all read that list. They render without a session and without the side
nav. The token pages read `#token=…` only once `router.isReady` (Next's own startup would otherwise
write the fragment back into the address bar), strip it with `history.replaceState` — from Next's
history entry too, so Back then Forward cannot restore it — inspect the link automatically, and spend
it only on a button press. `_document.js` sets `referrer: no-referrer` as a meta tag, because the meta
overrides the header.

**`contexts/sessionContext.js`** loads `GET /api/account` once the gate allows and exposes
`{ state, user, role, permissions, can(key), canAny(keys), refresh, logout, … }`. `state` is
`loading | ready | error`, and on any non-public page `_app.js` **holds rendering until `ready`**, so
nothing flashes a button the role cannot use. `error` renders a full page, *Could not load your
account*, with Retry — it is never read as "no permissions" and never signs anyone out, because a
`503` while the database restarts is not a reason to throw away a good token. The account is re-read
when the tab becomes visible, when another tab signs in or out (the `storage` event), and on a `403`
(at most once per 30 s). `logout` posts `POST /api/account/logout` best-effort, clears the token and
the remembered partner app, and does a full `window.location.replace('/login')` so no in-memory state
survives into the next person's session.

**Pages are gated by permission, default-deny.** `utils/permissions.js` maps every page path to the
keys that open it (`PAGE_PERMISSIONS` — the page opens when the role holds *any* of them). A page
missing from the map is refused for everyone, the owner included: loud on purpose, because the other
direction — a new page open to all until someone remembers to list it — fails silently. Once the
session is ready, a page the role cannot open renders a full-page *Restricted* notice naming the role,
**without mounting the page**, so none of its requests fire. The nav is filtered by the same map, `/`
forwards to `landingRouteFor(permissions)` (never null: `/account` needs nothing), and controls the
role cannot use are disabled with a reason (sync triggers) or hidden (app registration).

⚠️ `utils/permissions.js` carries a **copy** of the backend's permission keys, owner-only keys and
audit-action names — a cross-repository string contract. `backend/test/permissionParity.test.js` loads it and fails when
the two drift.

None of this is a security boundary. The backend authorises every request on its own (§3.4, §3.5); the
frontend only decides what to offer.

### 4.4 Pages, and what is behind them

Ten dashboard screens: eight in the **Performance** nav section — the Overview first — and two in
**Setup**. Then **Users & roles** under **Administration**, **Account** in the top-bar user menu, and
the six public pages of §4.3a. All of them have a working backend. The side nav shows only what the
signed-in role can open.

⚠️ **`/revenue` is one route carrying three views**, selected by `?view=` and listed separately in
the table below because they are three different endpoints and three different windows. See §4.4c.

| page | route | calls | serves |
|---|---|---|---|
| **Overview** *(home)* | `/overview` | `getKpi` | `/api/partner-apps/:partner_app_id/kpi` |
| Funnel | `/funnel` | `getFunnel`, `getInstallCohort`, `getCustomFunnel`, `getCohortRetention`, `getTimeToPaid`, `getPlanMix`, `getTrialOutcomes` | `/api/funnel`, `/api/funnel/install-cohort`, `/api/conversion/{funnel,custom-funnel,cohort-retention,time-to-paid,plan-mix,trial-outcomes}` |
| Traffic Sources | `/traffic-sources` | `getTrafficSource`, `getGeo` | `/api/funnel/traffic-source`, `/api/funnel/geo` |
| Trial Funnel | `/trial-funnel` | `getTrialOutcomes`, `getTrialTrend` | `/api/conversion/trial-outcomes`, `/api/conversion/trial-trend` |
| Logo Churn | `/logo-churn` | `getLogoChurn` | `/api/conversion/logo-churn` |
| Stores | `/stores` | `list`, `getDetail` | `/api/stores`, `/api/stores/detail` |
| Subscriptions | `/subscriptions` | `list`, `getDetail` | `/api/subscriptions`, `/api/stores/detail` |
| Revenue → *Revenue* tab | `/revenue` | `getRevenueOverview`, `getShopPlans` | `/api/revenue/overview`, `/api/revenue/shop-plans` |
| Revenue → *By country* tab | `/revenue?view=countries` | `list` | `/api/stores/countries` |
| Revenue → *Churn* tab | `/revenue?view=churn` | `getRevenueChurn` | `/api/conversion/revenue-churn` |
| **Partner Apps** *(Setup)* | `/apps` | `getKpi`, list/upsert/update/deactivate | `/api/partner-apps` and its four sub-routes |
| **Sync** *(Setup)* | `/sync` | `getHealth`, `getCoverage`, `listJobs`, `getJob`, triggers | `/api/sync/*`, `/api/meta/coverage` |
| **Users & roles** *(Administration)* | `/settings/users` — Members · Invitations · Roles · Activity, as `?view=` | `userAdminService` | `/api/users/*`, `/api/invites/*`, `/api/roles/*`, `/api/audit-events` |
| **Account** *(user menu)* | `/account` | `accountService` | `/api/account/*` |
| Sign-in and the public pages | `/login`, `/setup`, `/setup/verify`, `/accept-invite`, `/forgot-password`, `/reset-password` | `authService` | `/api/auth/*` |

⚠️ **The store drawer is served at `/api/stores/detail`, not `/api/subscriptions/detail`**, and both
list pages open the same one. The drawer's commonest subject is a store that never subscribed, so
naming the record after a population it does not belong to is the misreading `subscriptionService.js`
calls the most expensive in the suite.

⚠️ **Sync-category job types are a cross-repository string contract.** `components/growth-intel/syncCategories.js`
keys its cards on the literals `'BIGQUERY_SYNC'` and `'INSTALL_ATTRIBUTION_SYNC'`. Renaming either in
`constants/syncJob.constants.ts` breaks no build anywhere — it silently orphans the card, which then
reports no runs for a job that is running perfectly well.

#### The sync inventory, and why it lists things that do not work

`components/growth-intel/syncCategories.js` is an **inventory**, not a menu. It lists every data
source the product has a concept of, including the ones this build cannot run, because a source that
is merely *absent* from the page is indistinguishable from one that is running fine — and an operator
cannot ask about a gap they cannot see.

Job types with **no server handler** are refused **by name** by `syncService.triggerSync`, which is
the only `notImplemented(...)` call site left in the frontend. That refusal is correct rather than
stale: it reports the state of the build, and it matches what an enqueue would answer, because
`createSyncJob` validates against the runnable set and refuses an unrunnable type up front.

⚠️ **A category states its destination by HAVING an `entity_url`.** Cards scoped to an entity rather
than to the app cannot carry a "run it now" button — the run needs to know *which* competitor — so
they point at the page that owns the action instead. That button used to render unconditionally for
every entity-scoped category, which meant two cards shipped a CTA to `/competitors` and
`/insights`, **neither of which exists**: a 404 reached from a working screen. The CTA is
now conditional on a destination actually being present, and a category with no destination says
plainly that the feature is not in this build. **The presence of the key is the assertion** — do not
re-derive "does this page exist" anywhere else, or the two answers will drift and only one of them
will be rendered.

### 4.4a The data-state decoder — `dataState.js` + `DataStateSection.js`

This is the load-bearing piece of the frontend and the newest, so it is documented here in full.

**The problem.** Every growth-intel service can answer in six materially different ways, and **five
of them are not a measured answer**. A page that tests `if (resp && resp.status && resp.data)` collapses all four
into one and then draws its own empty state over the top. That is how this dashboard came to publish,
on a page whose endpoint was never called:

> "Paying customers 0 · 0% of 0 stores · Attributed MRR $0.00"

Four checkable claims about the operator's business, all four manufactured by `Number(undefined || 0)`.
The backend never said any of them. **§4.5 records this shipping twice before and asks for it to be
"checked for deliberately in review". Review did not catch the third.** So the check was made
mechanical.

**`components/growth-intel/dataState.js`** — one pure, synchronous function, `readDataState(resp)`,
with no React import, callable from inside an axios callback and unit-testable without a renderer.
It returns `{ state, data, reason, endpoint, notImplemented, ready }`, and **`data` is `null` in
every state except `READY`**.

| state | means | the sentence carries |
|---|---|---|
| `NOT_IMPLEMENTED` | No route serves this. | the endpoint that *would*. No sync will ever change it. |
| `FORBIDDEN` | The signed-in role lacks the permission (HTTP 403, `error.code: 'FORBIDDEN'`). | the permission's label: *"Restricted — your role does not include View merchants"*. Says nothing about the data, so it never draws an empty state. |
| `NOT_CONNECTED` | An upstream is unconfigured. | **the missing environment variable.** The single most valuable sentence the API emits, and the easiest to discard. |
| `NEVER_SYNCED` | Configured; nothing has run. | why. Figures are `null`, never `0`. |
| `READY` | A real answer. | — an empty array here is a *measured* empty, the only one worth drawing. |
| `ERROR` | The call failed, or the session expired. | Distinct from `NOT_CONNECTED` because one is fixed in `.env` and the other by reading a log. |

Plus `PENDING`, which `readDataState` never returns: it is what `pendingDataState()` gives a page
before its first response, and it renders as the child's own loading skeleton — never a banner, since
a banner that flashes on every navigation trains the operator to ignore banners.

**The order of the tests is the design**, and three of them are load-bearing:

1. **The 401 sentinel first.** It carries *no `status` key at all*. A decoder that reads `resp.status`
   first classifies an expired session as `NOT_CONNECTED` and sends the operator to check
   `GCP_PROJECT_ID` over a login that simply timed out.
2. **`not_implemented` before `status`.** That envelope sets `status: false` *on purpose*, so
   pre-existing `if (!resp.status)` guards keep working — reading `status` first therefore misfiles
   every stub as a connection failure, the exact confusion the decoder exists to end.
   **`FORBIDDEN` goes before the refusal/failure heuristic below for the same reason**: a 403 is
   `status: false` with a message, which that heuristic would file as a failure — sending the reader
   to a server log over a role only an owner or admin can change.
3. **`resp.data` is read with no `|| {}` default.** An earlier draft wrote `const data = resp.data || {}`,
   and that one expression reintroduces the bug inside the decoder built to prevent it: `status: true`
   with `data: null` becomes a truthy empty object, decodes as `READY`, and every page renders charts
   and tiles over a payload the server never sent.

One heuristic, and it is the only one: with no dedicated wire marker for "not connected", a **refusal**
is told from a **failure** by the shape the backend produces — a deliberate refusal resolves
`promiseReturnResult(false, {}, {}, msg)` with an *empty* error object, while a caught exception
passes the real error through. Both arrive as HTTP 500. It is wrong in the safe direction:
mislabelling a failure as `NOT_CONNECTED` still renders the server's own message. Give the backend a
real `error.code` for this and the heuristic can be deleted.

**`components/growth-intel/DataStateSection.js`** is the render half, and **the point is the `else`**:
the chart, the table and the KPI tiles are *not mounted* unless the state is `READY`. An explanatory
banner above an empty chart is worse than useless — the zeros are concrete and the sentence above them
is not. `NEVER_SYNCED` is toned `info`, not `warning`: a fresh install that has not synced yet is
working correctly, and a warning colour there reads as a fault to chase.

**Every page that reads an endpoint uses it** (`grep -rl DataStateSection pages/ components/`), which is every page
that renders a figure. Sync is the exception — it *is* the diagnostic screen and renders its own
states.

**The rule for any page added later:** hold `pendingDataState()` in state, set it from
`readDataState(resp)` in the callback, and wrap the child in `<DataStateSection>`. Never default
`data` to `{}` or `[]` at a call site. Some endpoints signal `NEVER_SYNCED` only by nulling their
payload (`/api/funnel` sends `summary: null`), which is what the `isNeverSynced` option is for.

### 4.4b `/growth-intel` names two different things, and only one of them moved

The screens above were served under a `/growth-intel/…` prefix and are top-level routes now.
The rename is worth a section because that string still appears throughout the frontend, meaning
something else entirely, and **a find-and-replace over it breaks the whole application**:

| what it looks like | what it is | did it change? |
|---|---|---|
| `'/growth-intel/stores'` in a `url:`, `router.push`, or a `pathname` test | a **ROUTE** | **yes** → `'/stores'` |
| `components/growth-intel/dataState` in an `import` | a **DIRECTORY ON DISK** | **no** |
| `API_Services/growth-intel/syncService` in an `import` | a **DIRECTORY ON DISK** | **no** |

The distinguisher is the **leading slash with no directory in front of it**. Roughly a hundred of the
occurrences are import specifiers; those directories keep their names, because renaming them would
rewrite an import in every page and component to change a URL that no user ever sees.

**And the flatten silently disarms every prefix test.** Two of them existed, and both had the same
shape — `pathname.startsWith('/growth-intel')`:

- `contexts/growthIntelContext.js` gated the partner-app roster fetch on it. Flattened routes make it
  false everywhere, `loadApps` never fires, and **every page renders "No partner app is selected"** —
  no error, no failed request, nothing in the console. The entire product looks unconfigured.
- `storePresentation.safeBackPath` used it as an open-redirect guard on the `from` query param.
  Flattened, it rejects every real destination and the back arrow lands on Subscriptions from
  everywhere.

There is **no prefix** that covers the dashboard routes and excludes `/` and `/login` — the shortest
one that matches them all is `/`, which matches everything. So the prefix test is replaced by an
allowlist: **`utils/dashboardRoutes.js` declares the ten paths once**, and the nav's `url`s, the
nav's selection predicates, the Overview's contents list, both landing-page constants, the roster gate
and `safeBackPath` all read it. Adding a screen to `pages/` and forgetting to add it there is the one
remaining way back into the silent failure — which is why the list carries that warning at the top.

⚠️ **`isRouteSelected(route, pathname)` matches the route exactly or followed by a separator, never as
a bare prefix.** `'/revenue-churn'.startsWith('/revenue')` is true, so a loose test lit the Revenue nav
row while you were reading Revenue Churn. That particular collision is gone — `/revenue-churn` is a
redirect source now and can never be a `router.pathname` (§4.4c) — but the helper stays: the next
sibling that shares a word gets the fix for free, and the row that gets it wrong is always the row
nobody re-read.

**Old bookmarks** are handled by four redirects in `next.config.js` — two structural ones for the
`/growth-intel` flatten (§4.1) and two exact ones for the routes that became tabs (§4.4c).

### 4.4c One control over three views that do not all honour it

Revenue, Revenue Country and Revenue Churn were three nav rows opening three pages, each with its own
date control set to its own remembered value. They are three **tabs** of `/revenue` now, under **one**
date range, so the three views of the money describe the same window instead of three windows nobody
set together.

**The tab is in the URL** — `/revenue`, `/revenue?view=countries`, `/revenue?view=churn`. The Funnel
page keeps its tab in `useState` and is right to; nothing links to a funnel tab. Two things link to
these: the Overview's contents cards, and the redirects from the retired paths, which cannot reach
into `useState`. `REVENUE_VIEWS`, `REVENUE_VIEW_ORDER`, `normaliseRevenueView` and `revenueViewHref`
live in `utils/dashboardRoutes.js` so no `?view=` string is written twice — with the exception of the
two redirect destinations in `next.config.js`, which is CommonJS and cannot import that ESM module.
Both files carry the warning: **rename a view and those redirects break silently**, because an
unrecognised `?view=` falls back to the Revenue tab rather than erroring.

**⚠️ The views are not in `DASHBOARD_ROUTES`.** A tab is not a route. `isRouteSelected` compares
pathnames, so `'/revenue?view=churn'` in that list would match nothing — and the thing that would
break is the roster gate, silently, exactly as in §4.4b. `router.pathname` is `/revenue` on all three
views, which is what lights one nav row for all of them with no special case anywhere.

**And this is the part that can publish a wrong number.** One control now sits above three endpoints
that take three different kinds of window:

| tab | endpoint takes | what the shared range does |
|---|---|---|
| Revenue | `since`/`until` or `period_days` | honoured exactly, window positioned where the reader put it |
| Churn | `months` — a **count**, counted back from *now* | converted, lossily, and the conversion is printed |
| By country | **nothing** — no date parameter exists | not sent; the tab prints that it is lifetime |

`CountryView` therefore takes **no `dateRange` prop at all**, deliberately: a prop it accepted and
quietly dropped would look, from every call site, exactly like one it honoured. `ChurnView` prints
what `dateRangeToMonths` produced — how many months, which ones, that the newest is still in progress
— and raises a `critical` banner when the picked range **ended in the past**, because that is the one
case it cannot honour at all and the Revenue tab beside it *is* showing the picked window. Two tabs,
one control, two spans of time: only that sentence says so.

Rounding is described, never compared. `Math.ceil(days / 30)` rounds the *count* up, but the buckets
are calendar months ending with the one in progress — two months asked for on the 30th covers ~61
days and on the 2nd covers ~33 — so "wider" and "narrower" are both wrong, and the notice states the
shape of what was served instead.

Each view fetches its own payload and gates it with its own `DataStateSection`, and only the selected
view is mounted: one of three endpoints can be refusing while the other two answer, and a tab whose
service is unconfigured must not blank the two that work. Unmounting is also what makes the fetch
lazy — a view's own effect *is* its request — and what keeps recharts honest, since a `display: none`
parent measures 0 and every chart on a hidden tab would come back collapsed.

### 4.5 The render boundary is part of the honesty contract

The backend distinguishes NOT_CONNECTED / NEVER_SYNCED / READY (§3.9) and even emits the sentence
*"This is NOT a reading of zero traffic — it is a missing data source."*

**Both listing pages threw all of it away.** `traffic-sources` had:

```js
if (resp && resp.status && resp.data) setSources(resp.data.items || []); else setSources([]);
```

That `|| []` turns a deliberate `items: null` into an empty array, and the `else` discards the
message naming the missing environment variable. All three states collapsed into one screen reading
*"No source data in this window yet."* — a claim about the merchant's traffic, shown to someone whose
only problem was an unset `GCP_PROJECT_ID`. The funnel page did the same, and its fallback advised
"run a sync, or widen the date range", both dead ends when a credential is missing.

Nothing type-checked wrong. No test failed. The page just quietly lied.

Both pages now decode the envelope into three distinct banners, and **charts and tables render only
in `READY`** — an empty chart under an explanatory banner still invites the reader to believe the
zeros.

**The rule, for any page added later:** if a service can answer "we do not know", the page must have
somewhere to *put* that answer. Do not `|| []` a null, do not collapse a message into an empty state,
and do not draw a chart over a figure the backend refused to publish.

> **Postscript, and the reason §4.4a exists.** When this section was written, the closing line was
> that this had happened twice and "is worth checking for deliberately in review". It then happened
> a **third** time, on a page whose endpoint was never called, and review did not catch it either.
> The conclusion is that a rule enforced by attention is not enforced. The whole frontend was
> converted to the shared decoder in §4.4a, which turns this contract from something a reviewer must
> remember into the path of least resistance: `readDataState` + `<DataStateSection>` is *less* code
> than the hand-rolled `if (resp && resp.status && resp.data)` it replaces, and it cannot be written
> in the broken way by accident. §4.5 is kept as the record of why.

---

## 5. What is asserted, and what is not

`npm test` in `backend/` — plain `node:test`, no framework, no database required. **745 tests across
39 suite files, all passing**, when this was last measured. Take the count rather than trusting this
line — it moves with every wave of work:

```bash
cd backend && npm test              # ℹ tests 745 · pass 745 · fail 0
ls backend/test/*.test.js | wc -l   # 39
```

The structural suites are the ones that guard the shape of the system rather than a figure:

| suite | asserts |
|---|---|
| `routeGuard.test.js` | **every `/api/*` route is behind `authenticate`**, and the only unauthenticated endpoints are the ten in `ALLOWLIST` |
| `permissionMap.test.js` | every guarded route declares **exactly one** policy, first among its route-level middleware, and it is the key a pinned table names for that route; the guard chain is exactly `authenticate`; every catalogue key is used; mutating verbs never carry a `:read` key except `POST /api/revenue/shop-plans`; behaviourally, a principal without the key gets `403` and one with it does not; the built-in roles nest |
| `permissionParity.test.js` | the frontend's copy of the permission keys, owner-only keys, page permissions and audit-action labels equals the backend's |
| `exportSurface.test.js` | every barrel enumerates its keys (no spread), and **every enumerated key resolves to something** |
| `lintRules.test.js` | the two lint guards actually fire — the request-address reads (§3.5) and the model-layer imports (§3.3) — by running ESLint over in-memory snippets |
| `confidence.test.js` | unknown never becomes zero, and a measured zero never becomes unknown |

The auth and mail suites drive the rules and the races without a database:

| suite | covers |
|---|---|
| `authHelpers.test.js` | the pure rules: password policy, token shape and hash, `resolvePrincipal`, the management rule, custom-role validation, invitation state |
| `authServices.test.js` | the services over in-memory repositories whose compare-and-set behaves like Mongo's: two setups racing for the lock, an accept racing a revoke, a reset landing between a sign-in's read and its session insert, permitted and non-permitted setup requests making the same calls before the answer |
| `authQueryPaths.test.js` | every auth repository filter and update names only fields the schema declares — under `strictQuery` an undeclared path is silently dropped, which would turn a compare-and-set into an unconditional write |
| `authFlowRateLimit.test.js` | the three public-flow limiters' keys, charging and isolation from each other and from sign-in |
| `mail.test.js` | fixed subjects, escaped bodies, the cap classes, never throwing, no link or token in a log |
| `configValidate.test.js` | the `APP_PUBLIC_URL`, SMTP and setup-owner rules, the warnings and the upgrade banner |
| `authAdminCli.test.js` | the recovery CLI, run as a child process: it refuses a password argument and exits non-zero on a bad command line having read nothing |

The rest are per-endpoint, per-fold and per-middleware: `cancelTrap`, `cancelTrapWire`,
`conversionAnalysis`, `countryRollup`, `customFunnel`, `errorEnvelope`, `installAttributionSurface`,
`installCohort`, `installCohortRepository`, `listingRates`, `logoChurn`, `partnerAppAdmin`,
`partnerAppKpi`, `revenueChurn`, `revenueMovement`, `revenueOverview`, `securityHeaders`,
`securityRateLimit`, `seedDemo`, `storeDetail`, `storeRoster`, `storeUnconfigured`, `subscriptionList`,
`surfacePlacement`, `syncJobs`, `trialOutcomes`.

`storeUnconfigured.test.js` exists because `src/config` snapshots `process.env` at first require —
one process cannot exercise both listing-tier states, so the BigQuery-off case needs its own file.

**The route guard test instruments Express rather than reading its stack.** Express 5 does not keep
the mount path — `Layer` sets `this.path = undefined` and compiles the path into closures, so there
is no property anywhere saying "this sub-router is mounted at `/api`". Walking `router.stack` yields
the tree's shape and route paths relative to their own router, but not the absolute paths an
allowlist has to be written against. `test/_harness/routeMap.js` records the path at registration
time instead, which is version-independent. (Express 4 exposed a `layer.regexp` that could be
reverse-engineered; tests that did that broke on the 5.0 upgrade.)

**The export-surface test is not hypothetical.** On its first run it found four phantom exports:
`models.repository.ts` published four listing-model handles destructured from a registry that
exported none of them. Each was `undefined` at run time and type-checked perfectly, because the
registry comes in through an untyped `require`. They would have failed as `x.find is not a function`
on whichever request touched them first.

**What is *not* covered.** There is no integration test, no database fixture, no frontend test, and
no end-to-end run — which now includes the setup, invitation and reset flows: the suites above prove
the rules and the interleavings against fakes, and nothing in the repository runs those flows against
a real Mongo or a real mail server. Treat `npm run typecheck` and `npm run lint` as part of the suite:
the lint config carries the layer guard and the request-address guard, and it is the only thing
enforcing either in code that has no test. Both are clean —
`tsc --noEmit` reports nothing and `eslint .` reports **0 errors** (12 `max-len` warnings, every
one of them a long function signature — not a comment).

⚠️ **No *test* covers import cycles**, but CI does check for them: the `Import cycles` step in
`.github/workflows/ci.yml` loads every `src/modules/*/index.ts` — eight barrels today, `mail`
included — in fresh processes with an empty environment and `--trace-warnings`, and fails on a
`circular dependency` warning. That catches the common case — a cross-module barrel import that
closes a loop, which passes typecheck *and* lint and fails only at run time. It does not catch a
cycle that no barrel reaches. The graph is clean today: 198 files with a value-import edge across 313,
zero strongly-connected components (a walk of relative `import`/`require` edges, `import type`
excluded).

---

## 6. Extending it

**Add an endpoint.** Service method → controller handler (`_verbDomainResource`, `export =`) → one
line in the domain's `.routes.ts`, **with its policy as the first route-level middleware** —
`router.get('/x', requirePermission(PERMISSIONS.MERCHANTS_READ), _handler)`, or `requireSelf()` —
→ import + one `guardedApiRouter.use(...)` line if the area is new. Then add the route and its key to
the pinned table in `test/permissionMap.test.js`. The route-guard test passes automatically; if it
fails you have mounted on the wrong parent, which is the whole point. Choose the key by what the
response **discloses**: anything that names a store is `merchants:read`, money without store names is
`financials:read`, counts and rates are `analytics:read`.

**Add a permission.** `modules/auth/constants/permissions.constants.ts` (key, label, group, a
description of what it discloses, its prerequisites) → the built-in roles that should hold it in
`roles.constants.ts` → the same key in `frontend/utils/permissions.js` and any page it opens →
the routes that demand it. `permissionParity.test.js` fails until the two copies agree. A key renamed
later is silently dropped from every custom role that held it, so treat the strings as permanent.

**Add a module.** `modules/<name>/` with only the role folders it needs, plus `index.ts` enumerating
every published key. Import siblings by deep path, other modules by their barrel.

**Add a job type.** Add it to `constants/syncJob.constants.ts`, then to `modules/sync/constants` if
it should be runnable, then register a handler — statically in `jobRunner.service.ts`, or from
`apps/app.ts` if registering it there would create a module cycle. `assertHandlersRegistered()` will
refuse to boot until you do, which is the intended failure.

**Add a figure.** It must come out of one of the four `confidence.helper` constructors, name a real
source, and get a row in `FIDELITY.md` — including what would make it wrong. A figure not in that
table is not published.

**Add a setting.** `config/index.ts` only, in the matching section. If the application cannot produce
a correct number — or cannot let anyone in — without it, add it to `TIER_1_KEYS` in
`config/validate.ts` with an example line, and give it a row in `DEPLOYMENT.md` §3.

---

## 7. Known gaps

Recorded because a gap you have written down is a different thing from one you have not noticed. This
list is re-verified against the code, not carried forward. Entries that were here previously and are
now **closed** are listed at the bottom so a returning reader does not go looking for them.

### Open

- **Test and development charges are not excluded from revenue.** The Partner API's `test` flag is
  requested and stored on `raw_event.charge.test`, and nothing reads it. On the transaction side the
  Partner API supplies no test marker at all, so the exclusion **cannot be made symmetric** even if
  the event side were filtered. If your organisation's ledger contains test charges, they are in
  these numbers. See `FIDELITY.md` §5.
- **Annual subscribers with a null `billing_interval` are booked at 12×.** The caveat is published on
  the figure — `mrr` downgrades from `measured` to `estimated` and
  `billing_interval_unknown_shops` gives you the count to check it against — rather than silently
  corrected.
- **`REVENUE_HISTORY_FLOOR_DATE` is validated, echoed at boot, and consumed by no published figure.**
  `config/validate.ts` warns when it is unset or malformed and `core/bootstrap.ts` prints it; no
  service reads it. Setting it does not currently cause anything to be published as unknown. Until a
  windowed endpoint uses it, the honest floor is the measured `coverage.earliest_transaction_at`.
- **No integration test, no database fixture, no frontend test, no end-to-end run** (§5).
- **Import-cycle detection is partial** (§3.13). CI loads the 8 module barrels and fails on a
  `circular dependency` warning, which is the common case; a cycle no barrel reaches is still silent
  at typecheck and lint alike. There is no whole-graph static check.
- **Single partner app in practice.** The schema and every query are keyed by `partner_app_id` and
  more than one row is supported, but multi-app aggregation is not a feature yet.
- **`gi_sync_jobs` grows without bound.** There is no TTL, *deliberately* — the model records the
  decision and asks for sign-off before one is added, because a row that expires takes the only
  evidence that a sync happened with it. It grows by roughly one row per sync (~365/year plus manual
  runs). Small, but monotonic; archive rather than expire.
- **The address-keyed rate limits are per-deployment unless a real proxy is in front.** Sign-in,
  forgot-password and the setup request count against `req.ip`. Behind the bundled stack alone the
  dashboard forwards a caller-supplied `X-Forwarded-For` unchanged, so the correct setting is to
  leave `TRUST_PROXY` unset — and then every caller shares one budget per limiter. That stops brute
  force, and a returning user signs in on their browser's device budget whatever the flood, but one
  caller can spend the shared budget and then take every trickle admission by polling, so a first
  sign-in from a new browser can be kept waiting for as long as they keep it up. Per-address limits
  need the nginx recipe in `DEPLOYMENT.md` with `TRUST_PROXY=uniquelocal`.
  The emailed-link limiter is keyed on the token and is not affected.
- **The token-flow limiter's deployment-wide budget can be spent by anyone.** An anonymous caller
  posting random well-formed tokens is charged for each dead link, and once the global budget (5 ×
  `AUTH_PUBLIC_FLOW_RATE_LIMIT_MAX`) is spent, setup completion, invitation acceptance and password
  reset admit one request per 30 s for everybody until the window rolls.
- **Rate limits and mail caps live in process memory.** A restart clears them, and a second replica
  would have its own. `AUTH_PUBLIC_FLOW_RATE_LIMIT_MAX=0` switches the three public-flow limiters off
  (boot warns while it does).
- **First-run setup is first-come unless `SETUP_OWNER_EMAIL` is set** (or legacy operator rows
  restrict it). Boot warns at every start while it is open, and an empty database reopens it.
- **No email change, no user deletion, no multi-factor authentication, no single sign-on.** A leaver
  is disabled; a new address is a new invitation; ownership moves only through the CLI.
- **The dashboard sends no script Content-Security-Policy.** `next.config.js` sets only
  `frame-ancestors 'none'`; a nonce-based policy is not built. The API's own responses carry a strict
  policy (helmet).
- **Change-password does not throttle wrong current-password guesses** beyond the bcrypt cost. It
  needs a signed-in session to reach.
- **The setup request's per-address caps are check-then-insert**, not atomic, so concurrent requests
  can exceed three an hour for one address. The global cap of ten live links still bounds it.
- **The "password changed" notice is sent after the response** and is not retried: a crash in between
  loses it.
- **The Users and Roles lists read every user and outstanding invitation per request.** Fine for a
  team; not built for thousands of accounts.
- **`gi_store_enrichments` is declared in types and does not exist** (§3.12). Every operator-profile
  key on the store record is permanently `null` in this build.

### Closed since this section was written

- ~~One operator account from the environment; no password reset, no second user, no roles, no
  audit trail.~~ **Closed.** First-run setup, invitations, a fixed permission catalogue with
  built-in and custom roles checked per route, forgot/reset/change password, a security activity log
  and a recovery CLI (§3.5). `ADMIN_*` are ignored.
- ~~`.env.example` names Partner variables the code does not read.~~ **Fixed.** Both example files
  now use the `SHOPIFY_PARTNER_*` spellings; the five old names appear nowhere in the repository.
  `DEPLOYMENT.md` §3's warning box has been rewritten to say so.
- ~~`DEPLOYMENT.md` still describes the BigQuery tier as unbuilt.~~ **Fixed.** That tier is built —
  three daily rollups, per-install attribution, two trigger endpoints, two crons and the read side —
  and `DEPLOYMENT.md` §3 Tier 2 now documents it, including the four cost controls.
- ~~Most dashboard endpoints are not built.~~ **Closed.** Every screen has a working backend
  across the 66 routes (§3.4, §4.4). The only remaining `notImplemented` call site is the deliberate
  refusal of three job types with no server handler.
- ~~Pages collapse the backend's empty states at the render boundary.~~ **Closed structurally**, by
  the shared decoder in §4.4a rather than by review discipline — see the postscript to §4.5.

---

## 8. Provenance

This was extracted from a private multi-tenant system, and the differences are deliberate:

| there | here | why |
|---|---|---|
| Azure Service Bus + a job row | job row only, atomic claim | the broker held no state the collection did not (§3.7) |
| guard applied at one mount, route files bare | guard is the guarded router's first layer, plus a test | the bare form is how a complete auth bypass ships unnoticed (§3.4) |
| auth failures answer HTTP 200 `{status:false}` | real 401s | too many call sites had come to depend on the 200 to change it there; this codebase has no such constraint |
| tokens signed with no expiry | `expiresIn` always set | a token with no expiry is a permanent credential once leaked |
| MRR replayed from event timelines, duplicated per page | one ledger predicate, published from the barrel | two pages disagreed with each other (§3.10) |
| cookie token read once at client construction | token read per request | a fresh login did not reach an already-constructed client |
| `services/v3/<module>/` with mixed conventions | role folders, lint-enforced | the layer rule is only checkable if it has one legal shape (§3.3) |

The comments in the source carry the same history in more detail, usually beside the line that would
otherwise look arbitrary. Where a rule is marked in the code, it names a regression that actually
shipped.
