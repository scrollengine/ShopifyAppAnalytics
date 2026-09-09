# Deployment

How to run **shopify-app-analytics** on your own hardware, from an empty directory to a dashboard
showing your real MRR.

For what the product *is*, see [`README.md`](./README.md). For what each published figure means and
how it can be wrong, see [`backend/docs/FIDELITY.md`](./backend/docs/FIDELITY.md) — read that before
you put any of these numbers in a deck.

---

## What you are deploying

Three containers, defined in [`docker-compose.yml`](./docker-compose.yml):

| service | image | port | what it is |
|---|---|---|---|
| `mongo` | `mongo:7.0` | **not published** | the only datastore. All history lives here. |
| `backend` | built from `./backend` | **not published** (8080 internally) | the JSON API and the Partner API sync job runner. One process; it is both. |
| `frontend` | built from `./frontend` | **3000 → your host** | the Next.js dashboard. The only thing you open in a browser. |

Only the dashboard is published. The browser talks to it and nothing else: `next.config.js` proxies
`/api/*` and `/healthz` through to the backend over the private compose network, which is why there
is no CORS configuration anywhere in this project and no reason to expose the API to your LAN.

> **Want to look around before wiring up credentials?** Bring the stack up with the two admin values
> and a `JWT_SECRET` only, then run
> `docker compose exec backend npm run seed:demo:dist`. It writes a self-consistent fictional dataset —
> stores, trials, subscriptions, payouts, listing attribution — sets the watermarks, and recomputes
> the coverage gates from the rows it wrote, so every screen fills in. It **refuses to run against
> a database holding real data**: it counts what is there first and stops if it finds anything it did
> not write. `docker compose exec backend npm run seed:demo:down:dist` removes exactly what it
> wrote. (The `:dist` suffix is not a typo: the image ships only compiled output, so the plain
> `seed:demo` — which loads TypeScript through ts-node — exists for a source checkout and cannot
> run in the container.) Do not run it on the deployment
> you intend to keep.

**Requirements:** Docker Engine with Compose v2 (`docker compose`, not `docker-compose`), about
2 GB of free RAM, and enough disk for your Partner history — the event and payout collections for a
mid-sized app are tens to hundreds of MB, not GB.

**There is nothing else to stand up.** No Redis, no message broker, no worker fleet, no cron daemon.
See [Production notes](#8-production-notes) for exactly what that costs you.

---

## 1. Quickstart

### Step 1 — get the code

```bash
git clone <your-clone-url> shopify-app-analytics
cd shopify-app-analytics
```

**You should see:** `docker-compose.yml`, `.env.example`, `backend/`, `frontend/` in `ls`.

---

### Step 2 — create your `.env`

```bash
cp .env.example .env
```

**You should see:** nothing. Confirm git will not commit it:

```bash
git check-ignore .env
```

**You should see:** `.env` echoed back. (*Silence* means it is **not** ignored — stop and add it to
`.gitignore` before you put a Partner API token in it.)

---

### Step 3 — fill in six values

Open `.env` and set these six. Everything else in the file is either pre-filled correctly for Docker
or genuinely optional.

```dotenv
SHOPIFY_PARTNER_ORG_ID=1234567
SHOPIFY_PARTNER_API_TOKEN=prtapi_xxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_PARTNER_APP_ID=7654321
ADMIN_EMAIL=you@yourcompany.com
ADMIN_PASSWORD=a-long-passphrase-you-will-type-at-the-login-screen
JWT_SECRET=<paste the output of: openssl rand -hex 32>
```

Where the first three come from is [section 2](#2-getting-the-credentials). `MONGO_URI` needs no
attention — `docker-compose.yml` sets it to the `mongo` service explicitly and that overrides
whatever is in your file.

> **The names in `.env.example` are the names the code reads.** Both example files were once out of
> step with `backend/src/config/index.ts` — they carried `PARTNER_ORGANIZATION_ID`,
> `PARTNER_API_ACCESS_TOKEN`, `PARTNER_APP_ID`, `PARTNER_SYNC_CRON` and `PARTNER_LOOKBACK_DAYS`,
> none of which anything reads. They have since been corrected and now use the `SHOPIFY_PARTNER_*`
> spellings above; those five old names appear nowhere in the repository.
>
> `backend/src/config/index.ts` remains the only file that reads `process.env`, so it is still the
> place to settle any doubt: `grep -n process.env backend/src/config/index.ts`. A name it does not
> read is simply ignored — the failure is loud in the other direction. Omit a required one and the
> backend refuses to start with `CONFIGURATION ERROR: SHOPIFY_PARTNER_ORG_ID is not set.` and
> restarts in a loop ([troubleshooting](#7-troubleshooting)).

> **The BigQuery values are optional, not inert.** `GCP_PROJECT_ID`, `BQ_DATASET` and credentials
> **are** read, and filling them in switches on Traffic Sources, the listing steps at the top of the
> Funnel, and per-install attribution. Leaving them blank is a supported configuration —
> everything from installs onward still works — but it is a choice, not a no-op. See
> [Tier 2](#tier-2--the-listing-analytics-tier-optional-and-fully-built).

---

### Step 4 — start the stack

```bash
docker compose up -d --build
```

The first run builds two images and compiles the backend's TypeScript, so expect a few minutes.

**You should see** the build finish and then, roughly:

```
 ✔ Container shopify-app-analytics-mongo-1     Healthy
 ✔ Container shopify-app-analytics-backend-1   Started
 ✔ Container shopify-app-analytics-frontend-1  Started
```

(Container names are prefixed with your directory name.) Confirm:

```bash
docker compose ps
```

**You should see** three services `running`, all three showing `(healthy)` after 30–60 seconds —
`mongo`, `backend` and `frontend` each ship a `HEALTHCHECK`. `backend` healthy here means *the process answers HTTP* — not that it has data yet.
That distinction is deliberate and is explained in [section 4](#4-the-first-sync).

Check the backend actually accepted its configuration:

```bash
docker compose logs backend | head -30
```

**You should see:**

```
[2026-09-02T10:44:01.123Z] [INFO] INFO: starting shopify-app-analytics backend
{ "node_env": "production", "port": 8080, "partner_org_id": "1234567",
  "partner_api_token_present": true, "partner_app_id": "7654321", ... }
[...] [INFO] INFO: connecting to mongo   { "uri": "mongodb://mongo:27017/shopify_app_analytics" }
[...] [INFO] INFO: mongo connected
[...] [INFO] INFO: auth: SEEDED the operator account — sign in with this email
[...] [INFO] INFO: [Partner:App] Registered partner app
[...] [INFO] INFO: api server listening
[...] [INFO] INFO: boot: complete   { "next_sync_at": "2026-09-03T03:00:00.000Z", ... }
```

`partner_api_token_present: true` is the token check — the value itself is never logged. If you see
a `CONFIGURATION ERROR` block instead, it names the exact variable to add; go back to step 3.

---

### Step 5 — open the dashboard and sign in

Open **<http://localhost:3000>**.

**You should see:** a redirect to `/login` and a sign-in form. Enter the `ADMIN_EMAIL` and
`ADMIN_PASSWORD` from your `.env`.

**You should see:** the Revenue page, with every figure reading `—` and saying it has no data.
That is correct at this point — nothing has been synced. `—` means *unknown*, never *zero*; the
project would rather tell you it does not know than show you a `0.00` that reads like a fact.

---

### Step 6 — confirm the app is registered

Go to **Partner Apps** in the side nav.

**You should see** one app listed, with the numeric id you put in `SHOPIFY_PARTNER_APP_ID`. The
backend registered it automatically at boot (that is the `[Partner:App] Registered partner app`
line above), so on a correctly configured install there is nothing to do here.

If instead you see *"Register your Shopify app to begin"*, the boot registration failed — almost
always because `SHOPIFY_PARTNER_APP_ID` is unset or is not the numeric app id. Saving the form calls
the same code path and will fail the same way with a message naming the variable; fix `.env` and
`docker compose up -d` instead.

> The app id cannot be set from the dashboard, by design. The form only supplies display fields
> (handle, name, listing URL); the id comes from the environment.

---

### Step 7 — run the first sync

Go to **Sync**.

**You should see** a *Backend readiness* card reading **`warming`**, with the reason *"The first
Partner API sync has not completed yet"*, and a **Run the first sync** button.

Click it.

**You should see** a *"Sync started."* toast. The button polls the job every 2 seconds and reports
the outcome. On a large app the sync outlasts the button's own 5-minute polling window, at which
point it says *"Sync is taking longer than expected. It will continue in the background."* — the job
keeps running server-side. [Section 4](#4-the-first-sync) is how to watch it properly.

---

### Step 8 — confirm it worked

When the sync completes:

```bash
docker compose exec backend node -e \
  'require("http").get("http://127.0.0.1:8080/healthz",r=>{console.log("HTTP",r.statusCode);r.pipe(process.stdout)})'
```

**You should see** `HTTP 200` and a body containing `"state":"ready"`.

Reload the **Sync** page.

**You should see** readiness go **`ready`**, and the *Coverage* card populate with real dates.
Then read [section 5](#5-verifying-the-install) — the coverage numbers are what tell you how much of
what the dashboard shows you can actually believe.

---

## 2. Getting the credentials

All three Shopify values come from <https://partners.shopify.com>. You need a Partner account with
API access; there is no Shopify app to install and no OAuth flow.

### `SHOPIFY_PARTNER_ORG_ID` — your organisation id

It is in the URL of every page of your Partner dashboard:

```
https://partners.shopify.com/1234567/apps
                             ^^^^^^^
```

Digits only. It is **not** your app id, your Client ID, or your email. The backend validates the
shape at boot (`it must be the numeric organisation id...`) and the Partner API answers **404** for a
wrong-but-numeric one, which the client reports as *"Check SHOPIFY_PARTNER_ORG_ID is your
organisation id"* rather than as a generic failure.

### `SHOPIFY_PARTNER_API_TOKEN` — the access token

**Partner dashboard → Settings → Partner API clients → Manage Partner API clients**, then create a
client (or open an existing one and copy its token).

**Permissions to grant:**

| permission | why this app needs it |
|---|---|
| **View financials** | the `transactions` connection — every settled payout. This is where MRR, ARPU, lifetime cash and the whole revenue side come from. |
| **Manage apps** | `App` resources and app-related **events** — installs, uninstalls, reinstalls, subscription charge accepted/activated/cancelled. |

Grant nothing else. *"Manage themes"* and *"Manage jobs"* are for entirely different Partner API
resources and this codebase never touches them.

> **"Manage apps" is Shopify's only scope that exposes app events — there is no read-only variant.**
> The app compensates on its own side rather than asking you to trust it: `partnerApi.client.ts`
> statically rejects any GraphQL document containing a `mutation` before the request leaves the
> process, so the token is used read-only regardless of what it is technically permitted to do.

The token is sent as `X-Shopify-Access-Token` to
`https://partners.shopify.com/<ORG_ID>/api/<VERSION>/graphql.json`. It is never logged — the boot
line reports `partner_api_token_present: true` and nothing more.

### `SHOPIFY_PARTNER_APP_ID` — which app to report on

Open the app in your Partner dashboard. The id is the number after `/apps/`:

```
https://partners.shopify.com/1234567/apps/7654321
                                          ^^^^^^^
```

Accepted forms: the bare number (`7654321`), the full gid (`gid://partners/App/7654321`), or the
dashboard URL itself. **A Client ID / API key will not work, and neither will an
`apps.shopify.com` listing URL** — the Partner API cannot look an app up by either.

> **This value is typed as optional; treat it as required.** Nothing resolves a blank one —
> `registerPartnerAppFromConfig`
> returns early when it is unset, so no app row is ever created, so there is nothing for the sync to
> run against. Without it you get a dashboard that boots, logs
> `WARN: boot: no partner app is registered, so nothing will sync`, and reports a business with no
> history.

---

## 3. Environment reference

Every variable below is read in exactly one file — `backend/src/config/index.ts` — and consumed
everywhere else as `config.<SECTION>.<FIELD>`. Nothing else in `backend/src` reads `process.env`, and
nothing writes to it.

**This table is generated against that file and is exhaustive for the backend**: it lists all 53
names `config/index.ts` reads, and nothing it does not. To check it yourself:

```bash
grep -oE 'process\.env\.[A-Z0-9_]+' backend/src/config/index.ts | sort -u
```

That command prints 54 lines: the 53 real names plus `process.env.X`, which occurs inside a comment
illustrating the gate pattern rather than in code.

(`NEXT_PUBLIC_API_BASE_URL`, at the end of Tier 3, is the one entry the backend does *not* read — it
belongs to the dashboard container and is listed here because you set it in the same file.)

### Tier 1 — required

The backend prints a named `CONFIGURATION ERROR` and **exits non-zero** if any of these is missing or
unusable. It lists every problem at once, so a fresh install is fixable in one pass.

| variable | required | default | what it does | what breaks without it |
|---|---|---|---|---|
| `MONGO_URI` | yes | *none* | The one datastore. Must start `mongodb://` or `mongodb+srv://`. | Refuses to boot. **Under Docker, compose sets this for you** (`mongodb://mongo:27017/shopify_app_analytics`) and its value overrides your `.env`. |
| `JWT_SECRET` | yes | *none* | Signs dashboard session tokens. Validated at **≥ 32 characters**. | Refuses to boot. There is deliberately no default: a shared one would let anyone mint an admin token for any install. |
| `ADMIN_EMAIL` | yes | *none* | The single operator login. Must contain `@`. | Refuses to boot. There is no signup flow and no second user. |
| `ADMIN_PASSWORD` | yes¹ | *none* | Plaintext password, bcrypt-hashed at **first boot only**. Validated at **≥ 12 characters**, and rejected if you paste a bcrypt hash into it. | Refuses to boot. Nobody can sign in. |
| `ADMIN_PASSWORD_HASH` | yes¹ | *none* | A pre-computed bcrypt hash, stored verbatim. **Wins over `ADMIN_PASSWORD` when both are set.** | — Preferred for production: a plaintext password in the environment is readable in `ps`, in shell history and in `docker inspect`. |
| `SHOPIFY_PARTNER_ORG_ID` | yes | *none* | Your Partner organisation id. Digits only. | Refuses to boot. |
| `SHOPIFY_PARTNER_API_TOKEN` | yes | *none* | Partner API access token. Never logged. | Refuses to boot. |
| `SHOPIFY_PARTNER_API_VERSION` | no | `2026-07` | Partner API version, `YYYY-MM`. Validated for shape. | Refuses to boot on a malformed value. An out-of-support version is a hard 404 from Shopify, not a degraded response — this is a value to keep current, not to pin and forget. |
| `SHOPIFY_PARTNER_APP_ID` | *in practice, yes* | *none* | Which app to report on. | **Warns and boots**, but no app row is created, so nothing ever syncs and every figure is unavailable. See [section 2](#2-getting-the-credentials). |

¹ Supply **one** of `ADMIN_PASSWORD` / `ADMIN_PASSWORD_HASH`. Generate a hash with:
`node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" 'your password'`

### Tier 2 — the listing-analytics tier: optional, and fully built

Shopify's listing analytics reach you as a GA4 property exported to BigQuery. It is the **second**
data source and the only one that can say how a merchant arrived at your listing — the Partner API
reports installs and payouts and is silent on traffic.

**Leaving this tier off is fully supported.** Everything from installs onward works without it, and
the views that need it say they have no data rather than showing zeros. But it is not inert: set
these and two sync jobs, two nightly crons, three daily rollups and per-install attribution switch
on.

> **This section is the reference — what each variable means and what it costs.** For the procedure
> (creating the GA4 → BigQuery export, making the service account, granting the two roles, and
> getting the key into a Docker container), see [`SETUP.md § 3`](./SETUP.md#3-tier-2--google-bigquery).

#### The switch

`config.BIGQUERY.ENABLED` is **derived, never set**. It is true only when all three of a project, a
dataset and credentials are present:

```
ENABLED = PROJECT_ID && DATASET && (GCP_SERVICE_ACCOUNT_JSON || GOOGLE_APPLICATION_CREDENTIALS)
```

Half-configured is the dangerous state — it looks configured in a `.env` file and produces nothing —
so the gate demands the whole set, and each service names the specific variable that is missing.
Everything that could spend money or arm a timer checks this first.

| variable | required for the tier | default | what it does |
|---|---|---|---|
| `GCP_PROJECT_ID` | yes | *none* | The GCP project holding the export. Blank ⇒ the whole tier is off. |
| `BQ_DATASET` | yes | *none* | The dataset the export writes into — typically GA4's `analytics_<propertyId>`. A project without a dataset addresses nothing. |
| `GCP_SERVICE_ACCOUNT_JSON` | one of these two | *none* | The key file's JSON on one line, **or** an absolute path to it. Grant `roles/bigquery.dataViewer` + `roles/bigquery.jobUser` and nothing more — the client refuses non-`SELECT` SQL, but IAM is the layer that holds when the client is wrong. |
| `GOOGLE_APPLICATION_CREDENTIALS` | one of these two | *none* | Google's own Application Default Credentials pointer, for a deployment running **on** GCP. Read here **only** so `ENABLED` can see that such a deployment is authenticated — nothing consumes the value; the Google client library reads the variable itself. Accepting only the service-account form would report a working ADC install as "not connected". |

#### The cost controls — read these before the first lifetime sync

BigQuery bills per byte **scanned**, and a lifetime sync fans concurrent scans across every daily
table since the floor date. These four are the ceilings.

| variable | required | default | what it does |
|---|---|---|---|
| `BQ_MAX_BYTES_BILLED` | no | `214748364800` (**200 GiB**) | ⚠️ **Hard per-query billing ceiling, in BYTES, as a string** (BigQuery's own parameter is a string because the value exceeds 2^53 at scale). A job whose estimate exceeds this is **rejected before it runs** rather than billed — which is why an over-cap dry run reports `exceeds_cap` rather than merely "expensive". Raise it only with an estimate in hand: the Sync page's **Estimate scan** button prices a run at zero cost. |
| `BQ_LIFETIME_FLOOR_DATE` | no | `2020-01-01` | `YYYY-MM-DD`. How far back a LIFETIME sync reaches, and therefore what it scans and what it costs. The GA4 export is **forward-only and never backfilled**, so a floor earlier than the day you switched the export on buys nothing but scanned bytes. Set it to that day. Validated at boot when the tier is on. |
| `BQ_LOOKBACK_DAYS` | no | `90` | The window used on a first sync, before any watermark exists. |
| `BQ_JOB_TIMEOUT_MS` | no | `300000` (5 min) | Server-side job ceiling. BigQuery cancels the job itself at this point. |

#### The rest of the tier

| variable | required | default | what it does |
|---|---|---|---|
| `BQ_TABLE_PATTERN` | no | `events_*` | The wildcard table the queries scan — GA4's daily-export naming. `_TABLE_SUFFIX BETWEEN @start AND @end` is what bounds a sync window to a date range, which is also what bounds its cost. |
| `BQ_MAX_RESULT_ROWS` | no | `500000` | Row ceiling per query. Hitting it is reported as a **failure**, not a truncation — a caller that persisted a truncated result would advance its watermark past data it never saw. |
| `BQ_PAGE_SIZE` | no | `50000` | Rows per result page. Results are paged explicitly rather than auto-paginated into the heap. |
| `BIGQUERY_SYNC_CRON` | no | `0 2 * * *` (UTC) | When the three daily rollups run. Same two-form grammar as `SYNC_DAILY_CRON`, validated at boot. 02:00 is an hour ahead of the Partner sync: the two read different upstreams and never contend. |
| `INSTALL_ATTRIBUTION_SYNC_CRON` | no | `0 6 * * *` (UTC) | When the per-install attribution sync runs — deliberately **after** the rollups and clear of the 03:00 Partner slot, so the heaviest query in the build never queues behind another long job. ⚠️ Without a schedule here nothing writes the attribution rows outside a manual trigger, and every store reads "not attributed" indefinitely. That failure is silent: the page renders, it is just empty. |

> **`BIGQUERY_SYNC` and `INSTALL_ATTRIBUTION_SYNC` are separate job types on purpose.** Attribution
> reads the whole event-parameter column, a far heavier scan than the three rollups, so it carries
> its own watermark, its own cost and its own failure domain — a costly failure there must not rewind
> the rollups into re-running their backfill.

### Tier 3 — tunables

Every one of these can be deleted and its default applies.

| variable | required | default | what it does | what breaks without it |
|---|---|---|---|---|
| `PORT` | no | **`4700`** in code | Port the API binds. | Nothing — but **leave it at `8080`**. `.env.example`, the backend image's `ENV PORT`, the healthchecks and the dashboard's proxy target (`http://backend:${PORT:-8080}`) all assume 8080; unsetting it entirely drops the process to 4700 while everything else still looks for 8080. |
| `NODE_ENV` | no | `development` (both images set `production`) | Log verbosity, plus **one** boot warning: under `production`, config validation warns (does not refuse) if `SHOPIFY_PARTNER_API_BASE_URL` points anywhere other than Shopify — i.e. that the dashboard is reading a fixture. It **never** switches business logic — the numbers must be identical in every environment, and it does **not** decide what an error tells a client: `terminalErrorHandler` redacts thrown errors to their class unconditionally, so that forgetting this variable is never a disclosure. | Nothing on the wire. You lose the base-URL boot warning, and the logs get louder. |
| `MONGO_DB_NAME` | no | *(from the URI path)* | Database-name override for URIs that carry no path. | Nothing. |
| `MONGO_MAX_POOL_SIZE` / `MONGO_MIN_POOL_SIZE` | no | `10` / `0` | Connection pool bounds. | Nothing. |
| `MONGO_SERVER_SELECTION_TIMEOUT_MS` | no | `10000` | How long the driver hunts for a node before failing a command. Kept short so a wrong URI fails at boot instead of hanging the first request. | Nothing. |
| `MONGO_DISABLE_AUTO_INDEX` | no | `false` | `autoIndex` is **on**, so indexes are built at boot and there is no migration step. Set `true` on a large existing database where an index build at boot is a stall. | Nothing. ⚠️ `autoIndex` creates but **never drops** — removing an index from a schema leaves the physical index in place. |
| `AUTH_TOKEN_TTL_HOURS` | no | `12` | Session lifetime. Must be ≥ 1 or no token is issued at all. | Nothing. Re-login is a password prompt, so short is cheap. |
| `AUTH_BCRYPT_ROUNDS` | no | `12` | Hash cost at seed time. Clamped to 4–31. | Nothing. Changing it later does not re-hash the stored password. |
| `AUTH_LOGIN_RATE_LIMIT_MAX` / `AUTH_LOGIN_RATE_LIMIT_WINDOW_MINUTES` | no | `10` / `15` | **Enforced** on `POST /api/auth/login` — the budget is *failed* attempts per client address, per rolling window. A success clears the tally and is never charged; a refusal is never charged either, so hammering cannot extend a block. Nothing is persisted: the state is one in-process Map, so **restarting the backend clears every block**. `AUTH_LOGIN_RATE_LIMIT_MAX=0` disables it. | Nothing. It fails **open** — a throw inside the limiter admits the request and logs, because a bug in a throttle must never become a denial of the only way in. |
| `TRUST_PROXY` | no | `false` | ⚠️ **Decides whose address `req.ip` is, and `req.ip` is what the login rate limit counts against.** Accepts Express's own forms: `false`, `true`, a hop count (`1`), `loopback`, `linklocal`, `uniquelocal`, or a comma-separated list of addresses/CIDRs. | **Leave it unset for the bundled compose stack; set `uniquelocal` only behind the nginx recipe below.** The dashboard's `/api` rewrite forwards a caller-supplied `X-Forwarded-For` unchanged and never appends the real peer, so trusting it with nothing in front lets a caller choose their own rate-limit bucket. nginx's `$proxy_add_x_forwarded_for` appends the true peer, which is what makes `uniquelocal` correct there. Unset, the limit is enforced per **deployment** rather than per address — stricter, not weaker. Either way a spent budget still trickles, so no flood can lock the operator out. |
| `ACTIVE_SUB_WINDOW_DAYS` | no | `38` | How recently Shopify must have billed a shop for it to count as an active paid subscriber. **A measurement decision, not a performance knob** — changing it changes what the dashboard says happened. | Nothing breaks, but both directions of getting it wrong have shipped: too narrow produced a **47.6% churn** month in which nobody cancelled; too wide produced **$45M of MRR against $10K of real payouts**. Read FIDELITY §5 before touching it. |
| `REVENUE_REPORTING_CURRENCY` | no | `USD` | A **label** for your payout currency. **Nothing in this codebase converts currencies.** | Nothing. If your payouts span currencies, `mrr` is downgraded to `estimated` and says so — but the *lifetime cash* block carries no such signal. |
| `REVENUE_HISTORY_FLOOR_DATE` | no | *(unset — warns at boot)* | `YYYY-MM-DD`; the earliest date your records actually cover. | ⚠️ **Validated, echoed at boot, and consumed by no published figure yet.** Setting it does not currently cause anything to be published as unknown. Until a windowed endpoint uses it, the honest floor is the measured `coverage.earliest_transaction_at`. |
| `SHOPIFY_PARTNER_LOOKBACK_DAYS` | no | `90` | How far back a routine (incremental) sync reaches. The first sync ignores it and pulls everything. | Nothing. Larger = slower syncs, more API calls, more tolerance for late-arriving events. |
| `SHOPIFY_PARTNER_MAX_RPS` | no | `4` | Proactive process-wide rate limit against Shopify's documented 4 req/s. | Nothing. Raising it invites 429s. |
| `SHOPIFY_PARTNER_MAX_RETRIES` / `SHOPIFY_PARTNER_MAX_RETRY_WAIT_MS` | no | `4` / `60000` | Bounded reactive backstop for 429 and transient 5xx. | Nothing. |
| `SHOPIFY_PARTNER_PAGE_DELAY_MS` | no | `250` | Courtesy delay between pages of a cursor walk. | Nothing. |
| `SHOPIFY_PARTNER_REQUEST_TIMEOUT_MS` | no | `60000` | Per-request HTTP timeout. | Nothing. |
| `SHOPIFY_PARTNER_API_BASE_URL` | no | `https://partners.shopify.com` | **For pointing the test suite at a fixture server.** | Nothing. Overriding it in production warns loudly, because every figure would then be coming from somewhere other than Shopify. |
| `SYNC_DISABLED` | no | `false` | `true` stops the runner claiming any job while leaving the API serving what is already stored. | Nothing breaks; it warns at boot. Every figure is then as old as your last successful sync. |
| `SYNC_DAILY_CRON` | no | `0 3 * * *` (UTC) | When the nightly sync is enqueued. **Only two shapes are understood:** `m h * * *` (daily) and `m h * * <dow>` (weekly, 0 = Sunday). Ranges, lists, steps and day-of-month are **rejected at boot** rather than silently never firing. | Refuses to boot on an unsupported expression — deliberately, so you find out now rather than at 3am. |
| `SYNC_POLL_INTERVAL_MS` | no | `15000` | How often the runner polls for claimable jobs. This is why a manually triggered sync can sit as `PENDING` for up to 15 seconds. | Nothing. |
| `SYNC_MAX_CONCURRENT_JOBS` | no | `1` | Jobs run at once. The Partner API rate limit is the real bottleneck, and serial execution makes a run reproducible. | Nothing. `0` genuinely pauses the runner (the config parser preserves a configured zero). |
| `SYNC_MAX_ATTEMPTS` | no | `3` | Attempts before a job is abandoned as `FAILED`. | Nothing. |
| `SYNC_STUCK_RUNNING_MS` | no | `1800000` (30 min) | A job `RUNNING` longer than this is presumed dead and swept to `FAILED`. | **Must exceed your longest legitimate sync.** A first lifetime sync on a large app can exceed 30 minutes — see [section 4](#4-the-first-sync). |
| `SYNC_STUCK_PENDING_MS` | no | `3600000` (1 h) | A job `PENDING` this long was never claimed, which means no runner is alive. Swept and surfaced. | Nothing. This is the check that catches "the dashboard quietly stopped updating". |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent`. An unrecognised value warns and falls back to `info`. | Nothing. |
| `LOG_JSON` | no | `false` | One JSON object per line instead of human-readable text. Set it when shipping to an aggregator. | Nothing. |
| `NEXT_PUBLIC_API_BASE_URL` | frontend only | `http://backend:8080` | Where the dashboard proxies `/api` and `/healthz`. **Compose sets it authoritatively** to `http://backend:${PORT:-8080}`. | The dashboard cannot reach the API. Must include a scheme — the frontend's entrypoint refuses to start without one and says so. |

---

## 4. The first sync

The first sync is a **lifetime** pull: every app event and every settled payout from 2009 to today.
That is not a default anybody chose to be dramatic — it is the only correct starting point, and
FIDELITY §3 explains why in detail. The short version:

> A Partner **event** happens once and is never re-emitted. A 90-day event window does not merely
> truncate history, it **erases entire shops** — a store that installed two years ago and has paid
> every month since has no event at all inside it. Anything folded over that window silently drops
> your longest-tenured customers first.

So `AUTO` mode resolves to `LIFETIME` while `lifetime_sync_completed_at` is null, and to
`INCREMENTAL` afterwards. A fresh install backfills itself; you do not have to remember to ask.

**It takes a while.** The client is paced to 4 requests/second process-wide, with a 250 ms delay
between pages of 100 records, and it walks the event and transaction connections concurrently. Ten
minutes is unremarkable; a large, old app takes considerably longer.

### `/healthz` answers 503 until it finishes — that is the design

| code | state | meaning |
|---|---|---|
| 503 | `warming` | Up and serving, but no sync has completed. Every figure would correctly read as unavailable. |
| 503 | `degraded` | Up, but Mongo could not be read. |
| 200 | `ready` | A Partner API sync has completed; stored history is available to query. |

Readiness is tied to the **data**, not to the socket. A freshly started instance answers every
endpoint truthfully — with `null` and a reason — and that is exactly what a half-broken instance
looks like too, so binding a port is not evidence of anything.

**Neither container's healthcheck uses this as liveness**, deliberately. Both check only that the
process answered HTTP at all and ignore the status code; the frontend's asks its own `/login` page.
Wiring readiness into a Docker `HEALTHCHECK` would mark a perfectly healthy stack `unhealthy` for
the entire duration of its first sync, and would restart-loop a container whose Mongo is down — which
cannot fix Mongo and throws away the readable 503 that explains it.

### Watching progress

**The log** is the honest view:

```bash
docker compose logs -f backend
```

**You should see** `INFO: [Sync] Dispatching job`, then:

```
[...] [INFO] INFO: [Partner:Sync] Starting sync
{ "requested_mode": "AUTO", "resolved_mode": "LIFETIME", "since": "2009-01-01T00:00:00Z", ... }
```

and, at the end:

```
[...] [INFO] INFO: [Partner:Sync] Sync complete
{ "mode": "LIFETIME", "events": {...}, "transactions": {...}, "coverage": {...} }
```

For page-by-page detail, set `LOG_LEVEL=debug` in `.env` and `docker compose up -d backend`.

**The Sync page** shows readiness and coverage and refreshes both when a job it started finishes. It
also lists the **whole job history** from `GET /api/sync/jobs` — filterable, with the ledger's own
tallies beside it — so a run that happened in another browser, or overnight, is still there. One
limit it is honest about: the trigger button stops polling after 5 minutes while the job carries on,
so a long backfill is followed from the history table or by job id rather than from the button.

**By job id**, from the trigger response — paste it into the *"Look up a job"* box on the Sync page,
or:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/sync/jobs/<job_id>
```

### If your first sync will take more than 30 minutes

`SYNC_STUCK_RUNNING_MS` defaults to 30 minutes, and a `RUNNING` job older than that is swept to
`FAILED` with `STUCK_TIMEOUT` — a status that is deliberately **not** retryable. The sweep is a
database write; the work itself carries on in-process. So you get a confusing split state rather
than a clean failure.

If you expect a long backfill, raise it **before** the first run:

```dotenv
SYNC_STUCK_RUNNING_MS=10800000   # 3 hours
```

then `docker compose up -d backend`.

### After it completes

- `last_synced_at` and `lifetime_sync_completed_at` are stamped on the app row, and the **six**
  coverage gates are re-measured **from the collections** (not from the run's own counters):
  `earliest_event_at`, `earliest_transaction_at`, `shop_name_coverage_since`,
  `event_history_gap_days`, `charge_link_absent_pct` and `charge_link_unresolved_pct`.
- A **partial** failure stamps nothing at all. That is on purpose: the watermark chooses the next
  window, so advancing it after a failed pull would permanently skip the backfill that did not
  happen. Re-run the sync.
- The nightly cron takes over at `SYNC_DAILY_CRON` (03:00 UTC) in `AUTO` → `INCREMENTAL` mode, which
  re-pulls the last 7 days on top of the watermark. Every write is an upsert against a unique key,
  so the overlap costs nothing and covers late-arriving rows.

---

## 5. Verifying the install

Work through this in order. It takes two minutes and it is the difference between a dashboard you
can quote and one you merely have.

### 5.1 The stack is up

```bash
docker compose ps
```
Three services `running`, all three `(healthy)`.

### 5.2 Readiness is `ready`

```bash
docker compose exec backend node -e \
  'require("http").get("http://127.0.0.1:8080/healthz",r=>{console.log(r.statusCode);r.pipe(process.stdout)})'
```
`200`, with `"state":"ready"`.

### 5.3 The coverage numbers on the Sync page

This is the important part. Every figure in the dashboard is a fold over synced history, and
**a missing row does not announce itself** — a month that was never pulled and a month in which
nothing happened produce the identical empty result. These six measurements are the only thing that
tells them apart. Read them **before** believing anything on the Revenue page.

Read them in this order:

| row | what to check |
|---|---|
| **Lifetime sync completed** | A date, not `—`. `—` means every "all time" total in the dashboard is a **floor** — whatever incremental windows happened to pull — and not a total. This is the gate to read first. |
| **Earliest settled payout held** | **The floor of every money figure in the system.** Nothing before this instant is complete. If it is `—`, no payout has been synced at all and every money figure is unavailable rather than zero. |
| **Earliest event held** | The floor of the install/uninstall history. |
| **Widest gap in the event history** | See below. |
| **Charge link absent** | Share of rows that *should* carry a charge id and carry none. Anything computed per subscription (plan mix, per-store revenue) is blind to that share. A small percentage is normal for older history; the page warns above 5%. |
| **Charge link unresolved** | Share of captured charge ids that match nothing on the other side — a *dangling* link rather than a missing one. Usually means one half of the history reaches further back than the other; a lifetime re-sync closes it. |

Each row carries a confidence badge (`measured` / `derived` / `estimated` / `unknown`) and a
`—` where the value is `null`. **`—` means never measured. It does not mean zero.**

> A seventh gate, `shop_name_coverage_since`, is measured and published on `GET /api/meta/coverage`
> but is not drawn on this page. Compare it with `earliest_event_at`: newer means the store names on
> older rows have not been backfilled yet, so a bare domain there is sync state rather than a
> missing name. FIDELITY §3 has the detail.

### `event_history_gap_days` — read this one properly

**The definition, exactly:** take the set of distinct UTC days that carry at least one event; for
each adjacent pair, count the days *between* them (events on the 1st and the 2nd → `0`; the 1st and
the 5th → `3`); the figure is the widest such run.

| value | what it means |
|---|---|
| `0` | Measured, and clean: every day carrying an event sits next to another one. This is the best answer the field can give. |
| `null` (`—`) | **Never measured** — fewer than two days carry events, so no pair exists and no gap can be computed. This is *not* "there are no gaps". An app with a single day of history has an unknown gap, not a gap of zero. |
| a small number | Usually a genuinely quiet stretch, especially on a small app. |
| **a large number** | **Your historical figures are limited, and they will not say so.** |

**Why a large value limits the historical figures.** A wide gap has exactly two possible causes —
a genuinely quiet stretch, or a sync window that failed and was never re-pulled — and *the data
cannot separate them*. The system refuses to guess, so it publishes the gap as a caveat rather than
resolving it into a verdict.

The consequence is concrete: every figure folded over the **event spine** — installs, uninstalls,
reinstalls, the trial ladder, cohorts and retention — silently under-reports across that stretch,
because a never-pulled window and an uneventful window produce the same empty result set. Nothing
errors. Nothing logs. The chart just draws a lower line.

The dashboard raises a warning banner at **7 days or more**. When you see one, run a **Full re-sync
(lifetime)** from the Sync page before trusting any period that spans the gap — and re-read the gap
afterwards. If it persists after a completed lifetime sync, the quiet stretch is real.

> The money figures (`mrr`, `active_subs`, `arpu`) are computed from the **payout ledger**, not from
> the event spine, precisely so they do not inherit this failure mode — a shop Shopify billed is a
> paying shop, no event history required. But `lifetime_sync_completed_at` and
> `earliest_transaction_at` still bound them. FIDELITY §3 has the full asymmetry.

### 5.4 The revenue figures and their two caveats

On the Revenue page — or `GET /api/revenue/now` — check the two inputs to the `mrr` caveat against
what you know about your own plan mix:

- **`billing_interval_unknown_shops`** — live shops whose `billing_interval` is null. Those are
  booked as **monthly**, so any annual subscriber among them is counted **12× too high**. When this
  is non-zero, `mrr` is downgraded from `measured` to `estimated` with a caveat naming the count and
  the direction of the error. A re-sync backfills the field.
- **`currencies`** — distinct currency codes across the live set. **More than one means `mrr` is a
  sum of unlike units**, because nothing in this codebase converts currencies. ⚠️ The *lifetime cash*
  block carries no equivalent signal, so read it with the same caution.

⚠️ **Test and development charges are not excluded from any figure.** The flag is stored
(`raw_event.charge.test`) but nothing reads it, and on the transaction side the Partner API supplies
no test marker at all. If your organisation's ledger contains test charges, they are in these
numbers.

### 5.5 What the API publishes, and what an empty page means

This build publishes **38 endpoints** — two public, 36 behind the admin guard. Every dashboard screen
has a working backend; none of them should be reporting "not built yet". (The screen count moved when
Revenue absorbed the country and churn views as tabs; the endpoint count did not — three tabs, three
endpoints, same three as before.)

Count them yourself:

```bash
grep -rE "^\s*router\.(get|post|put|patch|delete)\(" backend/src/routes/*.ts | wc -l
```

| area | endpoints |
|---|---|
| public | `GET /healthz`, `POST /api/auth/login` |
| partner apps (7) | `GET`/`POST` `/api/partner-apps`; `GET`/`PATCH`/`DELETE` `/api/partner-apps/:partner_app_id`; `GET .../events`; `GET .../kpi` |
| sync (8) | `GET /api/sync/health`, `GET /api/sync/jobs`, `GET /api/sync/jobs/:job_id`, `POST /api/sync/jobs/:job_id/cancel`, `POST /api/sync/partner`, `POST /api/sync/bigquery`, `POST /api/sync/install-attribution`, `POST /api/sync/dummy` |
| revenue (3) | `GET /api/revenue/now`, `GET /api/revenue/overview`, `POST /api/revenue/shop-plans` |
| listing funnel (4) | `GET /api/funnel`, `GET /api/funnel/traffic-source`, `GET /api/funnel/geo`, `GET /api/funnel/install-cohort` |
| conversion (9) | `GET /api/conversion/` + `funnel`, `custom-funnel`, `trial-outcomes`, `trial-trend`, `cohort-retention`, `time-to-paid`, `plan-mix`, `logo-churn`, `revenue-churn` |
| stores & subscriptions (4) | `GET /api/stores`, `GET /api/stores/detail`, `GET /api/stores/countries`, `GET /api/subscriptions` |
| meta (1) | `GET /api/meta/coverage` |

**If a page still says "not built yet", that is a real answer and worth reading.** The dashboard
decodes every response into one of five states, and only one of them is a measured answer:

| the page says | what it means | what to do |
|---|---|---|
| **Not built yet** | No route serves it. The banner names the endpoint that would. | Nothing on this install fixes it — no sync, date range or filter. Three sources are deliberately in this state: keyword rankings, competitor snapshots and LLM briefings. |
| **Data source not connected** | An upstream is unconfigured. The banner names the **missing environment variable**. | Set it and restart the backend — [section 3](#3-environment-reference). |
| **Nothing synced yet** | Configured, nothing has run. | Run a sync. This is not a reading of zero. |
| **This could not be loaded** | The call failed, or your session expired. | Check `docker compose logs backend`. |
| *(charts and tables)* | A measured answer. | Read it. |

The four non-ready states **draw nothing in place of the chart**. That is the point, not an
oversight: an explanatory banner above an empty chart is worse than useless, because the zeros are
concrete and the sentence above them is not.

### 5.6 If you use the API directly

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@yourcompany.com","password":"..."}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/partner-apps
```

⚠️ **Watch the id.** `GET /api/partner-apps` returns each app's Mongo `_id` as **`app_id`**, and
that is the value you pass as **`partner_app_id`** to `/api/meta/coverage` and `/api/sync/partner`.
The field called `partner_api_app_id` is Shopify's gid and is *not* interchangeable with it.

---

## 6. Upgrading, backup and restore

### Upgrading

```bash
cd shopify-app-analytics
git pull
docker compose build          # rebuilds backend and frontend
docker compose up -d          # recreates only what changed
docker compose logs -f backend
```

- **Your data survives.** The named volume `mongo_data` is untouched by `build`, `up` and `down`.
- **There is no migration step.** `autoIndex` is on, so any new index is built at boot. ⚠️ It
  **creates but never drops** — an index removed from a schema stays in the database until you drop
  it by hand.
- **Check the boot log after every upgrade.** New required configuration shows up as a named
  `CONFIGURATION ERROR` and a non-zero exit, which under `restart: unless-stopped` looks like a
  restart loop rather than a stop.
- **After changing `.env`, use `docker compose up -d`, not `restart`.** `restart` reuses the
  container with the environment it was created with; `up -d` recreates it with the new values.
  This matters most for `NEXT_PUBLIC_API_BASE_URL` and `PORT`.
- **Pinned image versions are deliberate** — `mongo:7.0` and `node:22-alpine`. Mongo's storage
  format is tied to its release series, so an unpinned tag can roll you onto a version that will not
  open your existing data files. Change the major only on purpose, with a backup in hand.

### Backup

Everything is in one Mongo database (`shopify_app_analytics`), in **nine** collections — one per
schema in `backend/src/models`, and there are no others:

| collection | holds |
|---|---|
| `gi_partner_apps` | the registered app rows, and the coverage gates written by a successful sync |
| `gi_partner_app_events` | the event spine — installs, uninstalls, reinstalls, subscription charge events |
| `gi_partner_app_transactions` | the payout ledger. **Every money figure is folded from this.** |
| `gi_sync_jobs` | the job ledger. This collection *is* the queue; there is no broker. |
| `gi_admin_users` | the single operator account |
| `gi_listing_funnel_dailies` | GA4 daily listing rollup — views, install clicks, installs |
| `gi_listing_source_dailies` | GA4 daily rollup by source/medium |
| `gi_listing_geo_dailies` | GA4 daily rollup by country |
| `gi_listing_install_attributions` | one row per install: its source, surface and result position |

The last four exist only if you configured the [listing-analytics tier](#tier-2--the-listing-analytics-tier-optional-and-fully-built).
Verify the list against the code with `ls backend/src/models/**/*.model.ts`.

There is deliberately **no store collection.** The store roster is folded on read from the three
Partner collections; see [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) §3.12 for why.

**Method A — volume snapshot (works regardless of what tools the image ships).** Stop the stack
first so the files are consistent:

```bash
docker compose down
docker run --rm \
  -v shopify-app-analytics_mongo_data:/data:ro \
  -v "$PWD:/backup" \
  alpine:3.20 tar czf /backup/mongo-$(date +%F).tar.gz -C /data .
docker compose up -d
```

The volume is named `<project>_mongo_data`; confirm yours with `docker volume ls`.

**Method B — logical dump (no downtime).** Check the tool is present first:

```bash
docker compose exec mongo mongodump --version
docker compose exec -T mongo mongodump --archive --gzip --db=shopify_app_analytics > dump-$(date +%F).gz
```

If `mongodump` is not in your Mongo image, use method A.

### Restore

**From a volume snapshot:**

```bash
docker compose down
docker volume rm shopify-app-analytics_mongo_data      # destroys current data
docker volume create shopify-app-analytics_mongo_data
docker run --rm \
  -v shopify-app-analytics_mongo_data:/data \
  -v "$PWD:/backup" \
  alpine:3.20 tar xzf /backup/mongo-2026-09-02.tar.gz -C /data
docker compose up -d
```

**From a logical dump:**

```bash
docker compose exec -T mongo mongorestore --archive --gzip --drop < dump-2026-09-02.gz
```

**If you lose the database entirely, you have not lost the data** — it is a mirror of the Partner
API. Bring the stack up with an empty volume and run a **Full re-sync (lifetime)**; it rebuilds
everything from Shopify. That is slow, not fatal, and it is why the sync is idempotent (every write
is an upsert against a unique key).

⚠️ `docker compose down -v` **destroys the volume.** Plain `down` does not.

---

## 7. Troubleshooting

| symptom | cause | fix |
|---|---|---|
| `backend` restarts in a loop; logs show `CONFIGURATION ERROR: SHOPIFY_PARTNER_ORG_ID is not set.` | A required value is missing or unusable. (Older notes blamed `.env.example` for carrying `PARTNER_ORGANIZATION_ID` and friends — it no longer does; those names are gone from the repository.) | Add the names from [step 3](#step-3--fill-in-six-values), then `docker compose up -d backend`. The error block lists **every** missing key at once — fix them in one pass. |
| `CONFIGURATION ERROR: JWT_SECRET is set, but it is 12 characters; use at least 32` | Short secret. | `openssl rand -hex 32`. |
| `CONFIGURATION ERROR: ADMIN_PASSWORD is set, but it is already a bcrypt hash` | Hash pasted into the plaintext variable. | Move it to `ADMIN_PASSWORD_HASH`. Hashing a hash produces a value that looks valid and matches nothing anyone can type. |
| Dashboard loads, every API call fails, browser console shows network errors | **`NEXT_PUBLIC_API_BASE_URL` points at `localhost`.** Inside the frontend container `localhost` *is* the frontend. | It must be the compose **service name**: `http://backend:8080`. Compose sets this for you — if you overrode it in `.env`, remove the override and `docker compose up -d`. The container logs `INFO: dashboard will proxy /api and /healthz to <URL>` at start, which tells you what it actually used. |
| Frontend container exits immediately with `FATAL: NEXT_PUBLIC_API_BASE_URL must include a scheme.` | You wrote a bare hostname (`backend:8080`). | Write `http://backend:8080`. |
| Sync page says **unreachable**: *"Nothing answered at /healthz"* | The backend is not running, or the proxy target is wrong. | `docker compose ps`, then `docker compose logs backend`. |
| `backend` logs `MONGO_URI is not set — cannot connect` or `MongooseServerSelectionError` | The backend cannot reach Mongo. Under compose this should not happen — `depends_on: service_healthy` waits for a real `ping`. | Confirm the `mongo` service is `(healthy)`. If you replaced `MONGO_URI` with an external cluster: `localhost` inside the container is the **backend**, not your host — use the service name, a real hostname, or `host.docker.internal`. Check credentials and IP allowlist for Atlas. |
| Everything is up but `/healthz` stays **503** with `"state":"warming"` | Correct behaviour, not a fault: no sync has completed. | Run the first sync ([step 7](#step-7--run-the-first-sync)). If it says *"No partner app is registered yet"*, set `SHOPIFY_PARTNER_APP_ID` and `docker compose up -d backend`. |
| `/healthz` 503 with `"state":"degraded"` | The datastore could not be read. | Check Mongo. Note this response can take ~10 s (mongoose's buffer timeout), so any probe you add must allow more than that or you will record a probe failure instead of the state. |
| The container is marked `unhealthy` during the first sync | Shouldn't happen — both healthchecks are liveness-only and ignore the status code. If you added your own probe against `/healthz` **status**, it will flap for the whole first sync. | Probe liveness, and read `data.state` for readiness. |
| Dashboard is **empty and every page says "no data"**, readiness `warming` | No partner app registered, or no sync has run. | Partner Apps page should list one app. If it shows *"Register your Shopify app to begin"*, `SHOPIFY_PARTNER_APP_ID` is unset or malformed — it is the number after `/apps/`, not a Client ID and not an `apps.shopify.com` URL. |
| Sync fails: *"Partner API authentication failed. Check SHOPIFY_PARTNER_API_TOKEN..."* | 401/403 from Shopify. | Re-copy the token (a trailing space is trimmed for you, so it is usually the token or the scopes). Confirm **View financials** *and* **Manage apps** are granted. |
| Sync fails: *"Partner API endpoint returned 404. Check SHOPIFY_PARTNER_ORG_ID..."* | Wrong organisation id. | It is the number in the dashboard URL, not the app id. |
| Sync fails: *"Partner API version ... is not supported"* | The pinned version aged out. Shopify keeps roughly the last four quarterly versions. | Set `SHOPIFY_PARTNER_API_VERSION` to a current `YYYY-MM` and `docker compose up -d backend`. |
| **401 loop**: signed in, then bounced straight back to `/login` | (a) the 12-hour token expired; (b) `JWT_SECRET` changed, which invalidates every issued token; (c) the browser holds a token from a different install. | Sign in again. A 401 from this API always means the token was rejected — the dashboard clears it and redirects exactly once per page load, by design. If it recurs immediately after a correct password, check `JWT_SECRET` is stable across restarts (it is only stable if it is in `.env`) and clear `localStorage` key `saa.authToken`. |
| Login always rejected, and you are sure the password is right | The operator account is **seeded once** and never rewritten. Editing `ADMIN_PASSWORD` after first boot does nothing. | See [changing the admin password](#changing-the-admin-password). Every failed login gives the same message whatever went wrong — that is deliberate; the detail is in the server log at `LOG_LEVEL=debug`. |
| Manual sync sits at `PENDING` for a few seconds | The runner polls every `SYNC_POLL_INTERVAL_MS` (15 s). | Wait. If it is still `PENDING` after an hour it is swept as `STUCK_TIMEOUT`, which means **no runner is alive** — check `SYNC_DISABLED` and the backend log. |
| Sync job reads `FAILED` / `STUCK_TIMEOUT` on a long first backfill | `SYNC_STUCK_RUNNING_MS` (30 min default) elapsed while the job was still running. | Raise it and re-run — see [section 4](#if-your-first-sync-will-take-more-than-30-minutes). |
| Sync "succeeded" but coverage did not move | A partial failure stamps nothing on purpose, so the next window cannot skip the backfill that did not happen. The message names which half failed. | Re-run the sync. |
| Warning banner: *"The event history has a N-day hole in it"* | Either a genuinely quiet stretch or a sync window that never ran — **the data cannot tell you which**. | Run a **Full re-sync (lifetime)**, then re-read the gap. See [5.3](#event_history_gap_days--read-this-one-properly). |
| A dashboard page says **"Not built yet"** | Only three sources are genuinely unbuilt (keyword rankings, competitor snapshots, LLM briefings). Every dashboard screen has a backend. | If a *screen* says it, read the banner — it names the endpoint. See [5.5](#55-what-the-api-publishes-and-what-an-empty-page-means). |
| A dashboard page says **"Data source not connected"** | The listing-analytics tier is off. The banner names the missing variable. | [Tier 2](#tier-2--the-listing-analytics-tier-optional-and-fully-built), then `docker compose up -d backend`. |
| `Sync is taking longer than expected. It will continue in the background.` | The button polls for 5 minutes; the job outlives it. | Watch `docker compose logs -f backend`, or look the job up by id on the Sync page. |
| Port 3000 already in use | Something else on your host has it. | Change the left-hand side only: `ports: - "3001:3000"`. |
| You want to `curl` the API directly | It is not published, on purpose. | `docker compose exec backend wget -qO- http://127.0.0.1:8080/healthz`, or go through the dashboard's proxy on `http://localhost:3000/api/...`, or uncomment the loopback-bound `ports` block in `docker-compose.yml`. |

---

## 8. Production notes

### Reverse proxy and TLS

Publish **one** thing: the dashboard on port 3000. Terminate TLS in front of it and proxy
everything through — `/api/*` and `/healthz` included, because the dashboard proxies those to the
backend itself. There is nothing else to route and no CORS to configure.

```nginx
server {
    listen 443 ssl http2;
    server_name analytics.example.com;

    ssl_certificate     /etc/letsencrypt/live/analytics.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/analytics.example.com/privkey.pem;

    # Defence in depth. The application throttles this endpoint too — see below.
    location = /api/auth/login {
        limit_req zone=login burst=5 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
(with `limit_req_zone $binary_remote_addr zone=login:10m rate=10r/m;` in the `http` block.)

Then bind the published port to loopback so the proxy is the only way in — edit
`docker-compose.yml`:

```yaml
ports:
    - "127.0.0.1:3000:3000"
```

**Do not publish the backend or Mongo.** Neither has a `ports` block and neither should get one:
Mongo runs with **no authentication configured**, which is safe only because it is reachable solely
from the private compose network.

⚠️ **Set `TRUST_PROXY` only once this nginx is in front.** The application throttles
`POST /api/auth/login` itself (`AUTH_LOGIN_RATE_LIMIT_MAX`, default 10 failures per 15 minutes), and
it counts against `req.ip`. Behind the dashboard's server-side proxy `req.ip` is a container address
unless Express is told which hops to trust, so **every login attempt in the world would share one
bucket**. With the nginx above — and *only* with it — that is fixed by:

```dotenv
TRUST_PROXY=uniquelocal
```

`uniquelocal` trusts hops on loopback and private ranges — the compose network and a local nginx —
and nothing on a public address. It is **not** a blanket `true`: the rightmost forwarded entry that
is not itself private wins, so a client forging `X-Forwarded-For` only forges an entry that nginx
then appends the real peer after.

**The `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` line above is what makes this
safe, and it is not decoration.** Next does not add a forwarded header of its own — it sets
`x-forwarded-for` only when the header is ABSENT, and its `/api` rewrite hands the request to
`http-proxy` with no `xfwd` option, so a caller-supplied value travels through to the backend
untouched. Remove that nginx line, or run the bare compose stack with port 3000 published and
`TRUST_PROXY=uniquelocal` set anyway, and the situation inverts: every request names its own bucket
and the per-address limit stops existing. Both directions were measured against `proxy-addr`.

So: **no proxy in front → leave `TRUST_PROXY` unset.** The limit is then per deployment rather than
per address, which is the stricter direction, and the limiter's trickle (below) is what keeps that
from being a lockout.

Keep the nginx `limit_req` rule as well. The application's limiter is deliberately in-process and
non-persistent — restarting the backend clears every block, which is the escape hatch that stops a
single-account install from being bricked — so it is a throttle, not a perimeter.

#### Two budgets, and why a refusal is a rate rather than a wall

There is one account, no password reset and no second user, so being locked out of this login is not
an inconvenience — it is the end of that install. Two mechanisms keep both failure directions closed:

- **A deployment-wide budget**, five times `AUTH_LOGIN_RATE_LIMIT_MAX`, keyed on nothing at all. It
  is what still bites when `req.ip` is attacker-chosen (the misconfiguration above): minting a
  thousand forwarded addresses evades the per-address tally and cannot evade this one. A single
  operator mistyping a password meets the per-address limit long before reaching it.
- **A trickle.** Once *any* budget is spent, one attempt every 30 seconds is admitted anyway, and a
  correct password on any of them clears both tallies outright. So a caller who floods the shared
  bucket cannot keep you out: you wait at most half a minute. An attacker is left with two guesses a
  minute against bcrypt, which is not a brute force.

The trickle is deliberately *not* available at the instant a budget runs out — it is scheduled from
when the window opened — so a burst cannot spend the budget and walk straight through the refusal.

### Changing the admin password

`seedAdminIfMissing` creates the operator account **only when none exists** and never rewrites one.
Editing `ADMIN_PASSWORD` in `.env` after the first boot therefore does nothing at all. That is
deliberate: a seeder that rewrote the hash on every boot would mean anyone who can edit `.env` can
take over the account.

There is no change-password endpoint in this build. To change it, delete the row and let the seeder
run again:

```bash
# 1. Put the new password in .env (ADMIN_PASSWORD, or preferably ADMIN_PASSWORD_HASH)
# 2. Remove the existing operator account
docker compose exec mongo mongosh --quiet shopify_app_analytics \
  --eval 'db.gi_admin_users.deleteMany({})'
# 3. Recreate the backend so it re-seeds
docker compose up -d --force-recreate backend
docker compose logs backend | grep 'SEEDED the operator account'
```

Existing sessions survive this — a token is valid for its full lifetime regardless of the account
behind it. Rotate `JWT_SECRET` in the same change if you need those killed too.

**For production, prefer `ADMIN_PASSWORD_HASH`.** A plaintext password in the environment is visible
in `ps`, in shell history, in `docker inspect` and in `docker compose config`, and it stays visible
for as long as the process runs:

```bash
node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" 'your new password'
```

The hash is stored verbatim — never re-hashed — and it wins over `ADMIN_PASSWORD` when both are set.

### Rotating `JWT_SECRET`

Changing it invalidates every issued token immediately, which is exactly how you log everybody out:

```bash
# put a new `openssl rand -hex 32` value in .env, then
docker compose up -d backend
```

Everyone is bounced to `/login` on their next request. Tokens are **stateless and cannot be revoked
individually** — rotating the secret is the only revocation mechanism there is. That, plus the
12-hour `AUTH_TOKEN_TTL_HOURS`, is the whole session model.

### Resource expectations

- **Steady state is nearly idle.** The job runner polls one small collection every 15 seconds and
  the API serves a handful of aggregations. 512 MB for the backend is comfortable.
- **The sync is I/O-bound, not CPU-bound** — it is rate-limited to 4 requests/second against
  Shopify by design. Giving the container more CPU will not make it finish sooner.
- **Mongo is the one to size.** Give it 1 GB and room to grow; storage scales with the number of
  Partner events and payouts you have ever had, which grows monotonically —
  **`gi_sync_jobs` has no TTL and is never pruned**, so it grows by one row per sync forever
  (about 365/year — small, but not zero).
- **The frontend is a static-ish Next.js standalone server.** 256 MB is plenty.
- **One backend replica.** See below.

### What is *not* included

Being explicit, because each of these is a deliberate omission rather than a missing feature:

- **No Redis.** Verified: zero references in `backend/src` and none in `package.json`. Nothing
  caches to an external store.
- **No message broker and no queue infrastructure.** Jobs are rows in `gi_sync_jobs` and the runner
  polls them. That is slower than a queue and enormously easier to self-host — one process, one
  database, nothing to stand up before the first number appears.
- **No cron daemon.** The nightly schedule is a self-rescheduling `setTimeout` inside the backend
  process, which is why `SYNC_DAILY_CRON` understands only `m h * * *` and `m h * * <dow>`, and
  rejects anything else at boot rather than never firing.
- **Single process, and effectively single instance.** The API and the sync runner are the same
  container. Job claims *are* atomic (a conditional update, with `modifiedCount === 1` as the gate),
  so a second replica would not double-execute a job — but nothing else about this build has been
  designed or tested for horizontal scale, and it does not need it.
- **No multi-tenancy.** `SHOPIFY_PARTNER_APP_ID` is the only scoping concept. One deployment reports
  on one organisation's apps.
- **No user management.** One operator account, from the environment. No signup, no password reset,
  no second user — absences that are the security model, not gaps in it.
- **No keyword rankings, competitor tracking or LLM briefings.** These three appear on the Sync page
  so the gap is visible, and are refused by name if you try to run one — there is no handler for any
  of them on the server. (The listing-analytics tier **is** built; see
  [Tier 2](#tier-2--the-listing-analytics-tier-optional-and-fully-built). Leave it unconfigured and
  Traffic Sources and the upper conversion funnel report that they have no data rather than showing
  zeros.)
- **No audit log** beyond the application's own log output. (Login rate limiting **is** built — see
  `AUTH_LOGIN_RATE_LIMIT_MAX` in [section 3](#tier-3--tunables) — but read the `TRUST_PROXY` row
  beside it: without that set correctly the limit counts the proxy's address, not the caller's.)

---

<sub>Not affiliated with or endorsed by Shopify. "Shopify" is a trademark of Shopify Inc.</sub>
