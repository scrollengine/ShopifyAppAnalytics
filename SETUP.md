# Setup

From nothing to a running dashboard, in order.

This is the **procedural** guide: what to click, what to paste, what to check. It covers the two
credential sets — Shopify Partner (required) and Google BigQuery (optional) — and how to get each of
them into a Docker deployment.

It does not repeat the reference material. When you need to know what a variable *means* rather than
where to put it, [`DEPLOYMENT.md`](./DEPLOYMENT.md) is the reference; every table lives there.

| you want | read |
|---|---|
| **to get it running** | **this file** |
| what each variable means, defaults, what breaks without it | [`DEPLOYMENT.md § 3`](./DEPLOYMENT.md#3-environment-reference) |
| backups, TLS, upgrades, production notes | [`DEPLOYMENT.md § 6`–`§ 8`](./DEPLOYMENT.md#6-upgrading-backup-and-restore) |
| what a number on screen actually means | [`backend/docs/FIDELITY.md`](./backend/docs/FIDELITY.md) |

---

## 0. Before you start

You need:

- **Docker** with the Compose plugin (`docker compose version` should print v2 or later).
- **A Shopify Partner account** with at least one published app. Every figure in this system is
  scoped to one app id; there is no other tenancy concept.
- **About 10 minutes** for the required path. The optional BigQuery tier adds ~20 more, plus up to
  24 hours of waiting for Google's first export to land.

You do **not** need Node, npm, or MongoDB installed. The stack brings its own.

### The two tiers, and why the second one is optional

| tier | source | gives you | required? |
|---|---|---|---|
| **1** | Shopify Partner API | installs, uninstalls, subscriptions, trials, payouts, churn, MRR | **yes** |
| **2** | GA4 export in BigQuery | how a merchant *arrived* — listing views, traffic sources, ad vs organic, install country | no |

Tier 1 is the whole product minus attribution. The Partner API reports installs and payouts and is
**silent on traffic**, so without tier 2 the Traffic Sources page and the top of the Funnel have
nothing to draw. They say so explicitly rather than rendering zeros — which is the point of the
project, and the reason leaving tier 2 off is a supported configuration rather than a broken one.

**Start with tier 1. Get it working. Add BigQuery afterwards.** Half-configured BigQuery is the one
genuinely confusing state, and it is much easier to diagnose when everything else is already green.

---

## 1. Get the code and create your `.env`

```bash
git clone https://github.com/scrollengine/ShopifyAppAnalytics.git
cd ShopifyAppAnalytics
cp .env.example .env
```

Confirm git will not commit it:

```bash
git check-ignore .env
```

**Expect:** `.env` echoed back. Silence means it is **not** ignored — stop and fix `.gitignore`
before you put an API token in it.

> **One `.env`, at the repository root.** `docker-compose.yml` reads it with `env_file: .env` and
> hands the same values to the backend. `backend/.env.example` is the template for running the
> backend *without* Docker; you do not need it for the Docker path.

---

## 2. Tier 1 — the Shopify Partner credentials

Four values. Full walkthrough with screenshots-worth of detail is in
[`DEPLOYMENT.md § 2`](./DEPLOYMENT.md#2-getting-the-credentials); the short version:

| variable | where it comes from |
|---|---|
| `SHOPIFY_PARTNER_ORG_ID` | the number in your Partner dashboard URL: `partners.shopify.com/`**`<THIS>`**`/apps` |
| `SHOPIFY_PARTNER_API_TOKEN` | Partner dashboard → **Settings** → **Partner API clients** → create one. **READ scopes only.** |
| `SHOPIFY_PARTNER_APP_ID` | the number in your app's URL: `/apps/`**`<THIS>`** — the app id, not the client id |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | you choose these; they create the single operator account on first boot |

Also set `JWT_SECRET` to a long random string:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# or, without node:
openssl rand -hex 48
```

> **READ scopes are enough and are all this app ever uses.** The Partner client is hard-wired
> read-only: it rejects any GraphQL document containing a mutation before the request leaves the
> process. Do not grant write scopes.

### Start the stack

```bash
docker compose up -d --build
```

Then open **http://localhost:3000** and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

Trigger the first sync from the **Sync** page, and read
[`DEPLOYMENT.md § 4`](./DEPLOYMENT.md#4-the-first-sync) before you do — `/healthz` answers `503`
until it finishes, and that is deliberate rather than a fault.

**Stop here if you do not need traffic attribution.** Everything from installs onward now works.

---

## 3. Tier 2 — Google BigQuery

This tier exists because Shopify reports your listing analytics into a **GA4 property**, and GA4
exports to **BigQuery**. Three things have to be true before any credential matters:

1. a GA4 property is receiving your App Store listing events;
2. that property is linked to a BigQuery dataset, and at least one daily export has landed;
3. a service account can read that dataset.

Steps 3.1–3.3 below set those up in order. If your GA4 export already exists, skip to **3.3**.

### What the queries actually look for

Worth knowing before you start, because it tells you whether your property is the right one. The
scans read daily `events_*` tables for:

| event | what it gives |
|---|---|
| `shopify_app_install` | the install itself, and the attribution attached to it |
| `shopify_app_ad_click` | the **paid** half — every surface it produces is an ad surface |
| `page_view` | the **organic** half. Shopify appends `surface_*` parameters to the listing URL on *every* App Store referral, so a plain listing pageview carries the surface for a visitor who never clicked an ad |

If your GA4 property has no `shopify_app_install` events in it, it is not the property this tier
wants, and no amount of credential fixing will change that.

---

### 3.1 Point Shopify's listing analytics at a GA4 property

In the **Partner dashboard** → your app → **App Store listing**, add your GA4 **Measurement ID**
(`G-XXXXXXXXXX`) in the analytics field.

If you do not have a GA4 property yet, create one at
[analytics.google.com](https://analytics.google.com) → **Admin** → **Create property** → add a **Web**
data stream. The Measurement ID is on the stream's detail page.

Events take up to 24 hours to begin appearing. You can confirm they are arriving in GA4 under
**Reports** → **Realtime** (for a live click) or **Admin** → **DebugView**.

---

### 3.2 Link GA4 to BigQuery

In GA4: **Admin** → **Product links** → **BigQuery links** → **Link**.

- **Choose a BigQuery project.** Create one first at
  [console.cloud.google.com](https://console.cloud.google.com/projectcreate) if you have none. Note
  its **Project ID** (not the display name) — that is `GCP_PROJECT_ID`.
- **Billing must be enabled on the project.** BigQuery's free tier covers a small install base
  comfortably, but the export refuses to configure without a billing account attached.
- **Data location** — pick one near you; it cannot be changed later.
- **Export type** — **Daily** is what this tier reads. *Streaming* is an extra cost and nothing here
  uses it.

GA4 creates a dataset named `analytics_<propertyId>`. **That is `BQ_DATASET`.**

> **The first export lands the following day.** GA4's BigQuery export is *forward-only and is never
> backfilled* — it will not import history from before you linked it. This matters for
> `BQ_LIFETIME_FLOOR_DATE`: setting it earlier than the day you switched the export on buys nothing
> but scanned bytes. Set it to that day.

Confirm the export exists before going further —
[console.cloud.google.com/bigquery](https://console.cloud.google.com/bigquery) should show your
project → `analytics_<propertyId>` → a table named `events_YYYYMMDD`.

---

### 3.3 Create the service account and download its key

In the GCP console, with your project selected:

**1. Create the account** — **IAM & Admin** → **Service Accounts** → **Create service account**.

- Name it something you will recognise later, e.g. `shopify-app-analytics-reader`.
- Skip the optional "grant access" steps in the wizard; roles are granted next, deliberately
  narrowly.

**2. Grant exactly two roles, and no more.**

| role | where to grant it | why |
|---|---|---|
| `roles/bigquery.jobUser` | **on the project** (IAM → Grant access) | permission to *run* a query job. Without it every query is denied before it reads anything. |
| `roles/bigquery.dataViewer` | **on the dataset** (BigQuery → the dataset → **Sharing** → **Permissions** → **Add principal**) | permission to *read* the exported tables. |

> **Grant `dataViewer` on the dataset, not the project.** Both work; scoping it to the dataset means
> the key cannot read anything else in the project, ever. The client refuses non-`SELECT` SQL on its
> own, but IAM is the layer that still holds when the client is wrong.

**3. Download the key** — the service account → **Keys** → **Add key** → **Create new key** →
**JSON**. The file downloads once and Google keeps no copy.

Treat that file as a live credential. It is equivalent to read access to your analytics dataset, and
anyone holding it can spend your BigQuery quota.

---

### 3.4 Put it in `.env` for Docker

`GCP_SERVICE_ACCOUNT_JSON` accepts **either** the key file's JSON inline **or** a filesystem path,
and it decides which by the first character: a leading `{` means inline JSON, anything else is
treated as a path. Each branch fails with its own diagnosis, so a truncated paste tells you it was
truncated rather than handing you a confusing `ENOENT`.

#### Recommended for Docker: inline JSON

The shipped `docker-compose.yml` mounts **no volumes into the backend**, so a key *file* on your host
is not visible inside the container. Inline JSON needs no mount and works with the stack as shipped.

Flatten the downloaded key to one line and append it to `.env`:

```bash
# from the repository root, with the key file wherever your browser put it
python3 -c "import json,sys; print('GCP_SERVICE_ACCOUNT_JSON=' + json.dumps(json.load(open(sys.argv[1])), separators=(',',':')))" \
  ~/Downloads/your-project-abc123.json >> .env
```

or with `jq`:

```bash
echo "GCP_SERVICE_ACCOUNT_JSON=$(jq -c . ~/Downloads/your-project-abc123.json)" >> .env
```

Then fill in the other two by hand:

```dotenv
GCP_PROJECT_ID=your-project-id
BQ_DATASET=analytics_123456789
```

**This round-trips correctly.** Compose passes the value through intact, including the `\n`
sequences inside `private_key`, and `JSON.parse` turns them back into real newlines on the other
side. Do not "helpfully" reformat the private key or replace its `\n` with real line breaks — a
`.env` value must stay on one line.

> **Do not wrap the JSON in quotes,** and do not indent it. `KEY={"type":...}` — the value starts at
> the `{`.

#### Alternative: mount the key file

If you would rather keep the key as a file, note that **this requires adding a volume mount, which
the shipped compose file does not have.** Put the key in `backend/secret/` (already excluded by both
`.gitignore` and `.dockerignore`, so it can never be committed or baked into an image), then add to
the `backend` service in `docker-compose.yml`:

```yaml
    backend:
        # ... existing keys ...
        volumes:
            - ./backend/secret/your-key.json:/app/secret/key.json:ro
```

and in `.env`:

```dotenv
GCP_SERVICE_ACCOUNT_JSON=/app/secret/key.json
```

> **The path is the path *inside the container*, not on your host.** The backend checks the file
> exists at boot, and it is checking the container's filesystem. `/app` is the working directory and
> the process runs as the unprivileged `node` user, so mount it read-only (`:ro`) and make sure the
> file is world-readable on the host.

#### Running on GCP instead

If the backend itself runs on GCP (Cloud Run, GCE, GKE) with a service account attached, use
Application Default Credentials and set no key at all:

```dotenv
GOOGLE_APPLICATION_CREDENTIALS=/path/inside/container/adc.json
```

This variable is read here **only** so the availability gate can see that such a deployment is
authenticated — nothing consumes its value; Google's client library reads the variable itself.

---

### 3.5 Restart and verify

```bash
docker compose up -d
docker compose logs -f backend
```

The tier is **derived, never set**. It is on only when all three of a project, a dataset and
credentials are present:

```
ENABLED = GCP_PROJECT_ID && BQ_DATASET && (GCP_SERVICE_ACCOUNT_JSON || GOOGLE_APPLICATION_CREDENTIALS)
```

Half-configured is the state that looks right in a `.env` file and produces nothing, so the gate
demands the whole set and each service names the specific variable that is missing.

**Check it end to end:**

1. **Sync page** → the BigQuery card should offer **Sync listing analytics** rather than explaining
   that the tier is not connected.
2. Press **Estimate scan** first. It prices the BigQuery scan at **zero cost** — nothing runs,
   nothing is written — and tells you how many GiB a real run would read. Do this before the first
   lifetime sync; it is the most expensive query in the module.
3. Run the sync, then open **Traffic Sources**. Sources, surfaces and countries should populate.

---

## 4. Controlling BigQuery cost

BigQuery bills per **byte scanned**, and a lifetime sync fans concurrent scans across every daily
table in the range. Three controls matter, all documented in full in
[`DEPLOYMENT.md § 3`](./DEPLOYMENT.md#tier-2--the-listing-analytics-tier-optional-and-fully-built):

| variable | default | what it does |
|---|---|---|
| `BQ_MAX_BYTES_BILLED` | `214748364800` (200 GiB) | Hard per-query ceiling. A job estimated above it is **rejected before it runs** rather than billed — which is why an over-cap estimate reports `exceeds_cap` rather than merely "expensive". |
| `BQ_LIFETIME_FLOOR_DATE` | `2020-01-01` | How far back a lifetime sync reaches. **Set it to the day you enabled the GA4 export** — earlier buys nothing but scanned bytes. |
| `BQ_LOOKBACK_DAYS` | `90` | The window used on a first sync, before any watermark exists. |

Raise the cap only with an estimate in hand. **Estimate scan** is free.

---

## 5. Troubleshooting

### "Shopify listing analytics is not connected"

The message names the variables it needs. It is produced from your actual config, so it is telling
you the truth about what is missing:

```
Set BQ_DATASET (the dataset holding the daily export tables), GCP_SERVICE_ACCOUNT_JSON …
```

Fix those and restart. Note that the tier stays off until **all three** are present.

### `GCP_SERVICE_ACCOUNT_JSON starts with "{" so it is being read as inline JSON, but it does not parse`

The paste was truncated — the commonest accident, because the JSON is long. Re-run the flatten
command in **3.4** rather than copying by hand.

### `GCP_SERVICE_ACCOUNT_JSON is being read as a file path, and no file exists at "…"`

Either the value lost its leading `{` (so it fell into the path branch), or you gave a **host** path
where a **container** path was needed. See the mount note in **3.4**.

### Compose warns `The "xyz" variable is not set. Defaulting to a blank string.`

Compose interpolates `$` in `env_file` values, and it will silently eat `$name` out of your value.
Service-account keys are base64 (`A–Z a–z 0–9 + / =`) and contain no `$`, so this should not happen —
but if it does, escape each `$` as `$$`, and re-check the value with:

```bash
docker compose config | grep GCP_SERVICE_ACCOUNT_JSON
```

### `Access Denied` / `Permission denied` from BigQuery

Almost always a missing `roles/bigquery.jobUser` **on the project**. `dataViewer` alone lets the
account see the data but not run the job that reads it. Both are required, and they are granted in
two different places — see the table in **3.3**.

### The dataset exists but every table is empty

The GA4 export is forward-only. If you linked it today, the first `events_YYYYMMDD` table appears
tomorrow. Nothing is wrong.

### Everything else

[`DEPLOYMENT.md § 7`](./DEPLOYMENT.md#7-troubleshooting) covers the tier-1 and stack-level failures.

---

## 6. Security notes for the credential

- **Never commit the key — and check, because the default filename is not covered.** `.gitignore`
  excludes `secret/`, `*-key.json`, `*service-account*.json` and `*credentials*.json`. Google's
  download is named `<project-id>-<hash>.json`, which matches **none** of those. Verified:

  ```
  backend/secret/my-project-abc123.json   ignored  (secret/)
  my-project-abc123.json                  NOT ignored
  ```

  So the *directory* is what protects it, not the extension. Keep it in `backend/secret/`, or rename
  it to end in `-key.json`. Then confirm, rather than assuming:

  ```bash
  git check-ignore -v path/to/your-key.json    # must echo the matching rule
  git status --porcelain | grep -i json        # must not list your key
  ```

  `backend/.dockerignore` carries the same rules, so a key in `secret/` also stays out of every image
  layer — and a key swept into a layer is in that layer forever, readable by `docker history` and
  `docker save`.
- **Rotate it if it has ever been shared**, pasted into a chat, or committed anywhere. Delete the old
  key from the service account's **Keys** tab; deletion is immediate.
- **Two roles, no more.** If the key leaks, `dataViewer` on one dataset plus `jobUser` is the whole
  blast radius.
- **The `.env` holds your admin password, JWT secret and Partner API token too.** It is the single
  most sensitive file in the deployment. `chmod 600 .env` is not paranoid.
