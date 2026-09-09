# Continuity

Where the build actually stands, how to prove it, and what is worth doing next.

`README.md` says what the product is. `IMPLEMENTATION.md` says how it is put together.
`backend/docs/FIDELITY.md` says what each figure means. **This file is for picking the work back up** —
it is the only document here that is allowed to go stale, so re-measure before trusting a number in it.

| document | answers |
|---|---|
| [`README.md`](./README.md) | what the product is |
| [`SETUP.md`](./SETUP.md) | how to get it running, step by step, incl. the BigQuery credential |
| [`DEPLOYMENT.md`](./DEPLOYMENT.md) | how to run it |
| [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) | how it is built |
| [`backend/docs/FIDELITY.md`](./backend/docs/FIDELITY.md) | what each figure means and how it can be wrong |
| **this file** | what is done, what is next, and how to check |

---

## 1. Measured state

Every figure below came from the command beside it. Re-run them rather than believing the number.

| | | command |
|---|---|---|
| endpoints | **38** | `grep -hcE 'router\.(get\|post\|put\|patch\|delete)\(' backend/src/routes/*.routes.ts` + `/healthz` |
| backend tests | **578 / 0 fail**, 27 suites | `cd backend && npm test` |
| TypeScript files | **248** | `find backend/src -name '*.ts' \| wc -l` |
| modules | **8** | `ls -d backend/src/modules/*/` |
| collections | **9** (`gi_*`) | `ls backend/src/models/**/*.model.ts` |
| dashboard pages | **11** | `find frontend/pages -name index.js` |
| nav rows | **10** | `grep -c 'url: DASHBOARD_ROUTES' frontend/components/sideNavBar.js` |
| unimplemented service methods | **1** | `grep -rc 'notImplemented({' frontend/API_Services/growth-intel/*.js` |
| import cycles | **0** | see §2 |
| middlewares | **4** | `ls backend/src/middlewares/*.ts` |
| frontend `npm audit` | **0 vulnerabilities** | `cd frontend && npm audit` |

That single remaining stub is **correct, not a gap**: `syncService.triggerSync` refuses job types the
server ships no handler for (`KEYWORD_RANKING`, `COMPETITOR_SNAPSHOT`, `LLM_INSIGHT`). Refusing
matches what an enqueue would answer.

---

## 2. The verification playbook

Run all of it before believing the build is healthy. Several defects here are invisible to
`typecheck` **and** `lint` and show up only in one of these steps.

```bash
# backend
cd backend
npm run typecheck                 # expect: no output
npm run lint                      # expect: 0 errors (12 pre-existing max-len warnings)
npm test                          # expect: 578 pass / 0 fail

# frontend
cd ../frontend
npx eslint pages components API_Services contexts utils   # expect: 5 errors (see below)
rm -rf .next && npx next build --no-lint; echo "exit=$?"  # expect: exit=0, 13 routes
```

The five frontend eslint errors are **pre-existing and unrelated to any recent change** — three
`react/no-unescaped-entities` (a `"` and `'` inside copy in `CohortRetentionHeatmap.js` and
`ConversionFunnelChart.js`) and one `react/display-name` in `cardShell.js`. They do not fail the
build, which is why they survived. Fix them or don't, but do not read "5 errors" as a regression.

**Capture the build's exit code explicitly.** Do not infer success from the absence of the word
"error" — and clear `.next` first, because a stale one from a concurrent build produces a spurious
`Cannot find module for page: /_document`.

**Import cycles are silent at typecheck and lint.** They surface only here, and one cost 15
failing tests:

```bash
cd backend
for m in auth partner revenue bigquery sync store conversion; do
  node -r ts-node/register/transpile-only -e "require('./src/modules/$m/index.ts')" 2>&1 \
    | grep -q circular && echo "CYCLE in $m"
done
```

**Every test file needs the loader.** `node --test test/foo.test.js` fails with `MODULE_NOT_FOUND`;
use `npm test`, or `node -r ts-node/register/transpile-only --test test/foo.test.js`.

---

## 3. Owner actions — not code, and nobody else can do them

1. **Rotate the GCP service-account key** and delete `backend/secret/`. It is git-ignored and was never committed, so `git push` will not publish it —
   but it is a live credential for an unrelated project sitting inside a public repo's directory, one
   `git add -f` or one zipped folder away from disclosure.
2. **Run a LIFETIME Partner sync.** `shop_name` is written by `$set`, so an incremental sync only
   fills names inside its window. Until a lifetime run completes, recent installs show a merchant
   name and older ones show a bare domain. The boundary is measured and published as
   `shop_name_coverage_since` on `GET /api/meta/coverage`, so the UI explains itself — but the fix is
   the re-sync.
3. **Leave `TRUST_PROXY` unset unless a real reverse proxy is in front.** Measured against
   `proxy-addr`: behind the bundled compose stack the dashboard forwards a caller-supplied
   `X-Forwarded-For` unchanged, so `uniquelocal` there lets a caller pick their own rate-limit
   bucket. It is correct *only* behind the nginx recipe in `DEPLOYMENT.md`, whose
   `$proxy_add_x_forwarded_for` appends the true peer. Unset means one shared bucket — stricter, and
   no longer a lockout now that a spent budget trickles.
4. **Consider `ADMIN_PASSWORD_HASH`** instead of the plaintext `ADMIN_PASSWORD` in `.env`. Both files
   are git-ignored, so nothing is exposed; the hash simply keeps the password out of `ps`, shell
   history and `docker inspect`.

---

## 4. What is worth doing next

Ranked. Nothing here is required for the product to work — all eleven screens do.

### 4.1 Render the evidence the payloads already carry

**The highest value-per-hour work in the codebase, and it needs no new query, collection or
computation.** The backend computes an honesty layer that the frontend largely drops:

| endpoint | publishes | rendered |
|---|---|---|
| `GET /api/stores/detail` | 18 top-level keys | ~7 |
| `GET /api/sync/health` | 9 blocks | ~2 |
| `GET /api/revenue/overview` | `coverage` (8 fields) + `diagnostics` (11 counters) | 0 of either |
| `GET /api/stores/countries` | `attribution_state`, `diagnostics`, … | 0 |

Suggested shape: three shared primitives — `PayloadWarnings`, `ProvenanceMark` (renders `*_basis` /
`unknown_reason` as an inline mark), `MeasuredAt` — then the **store detail drawer** as their first
consumer. That drawer is opened from seven tables and is the highest-leverage surface in the product.

### 4.2 The cancel trap — decide Tier 2

Shopify emits a plan change as cancel + accept **in the same second**
(`partnerSync.service.ts` documents this). Cohort buckets are keyed per charge, so one merchant
upgrading once produces two trial starts, one phantom churn and two conversions — and an *in-trial*
upgrade books `CHURNED_DURING_TRIAL` for the merchant who did the best possible thing.

**Tier 1 is done and published nothing new**: `diagnostics.supersession` now counts the pairs
(`detected` / `same_second` / `distinct_successors` / `shops` / …) on `/api/conversion/custom-funnel`
and `/api/funnel/install-cohort`, with a `warnings[]` line. Note `distinct_successors`, not
`detected`, is the over-count — two predecessors ending together can name one successor.

**Read that number against real data before deciding Tier 2** (suppressing a cancel when an
activation for the same shop lands within ~60s). Blast radius is Trial Funnel and the Funnel page's
trial block only; the ledger-keyed pages are unaffected.

### 4.3 Plan movement as funnel steps

`upgraded` / `downgraded` **are** derivable and already are — `movementSince.helper.ts` resolves
UPGRADED / DOWNGRADED / RESUBSCRIBED from consecutive charge amounts, comparing **amount before plan
name** so a rename is not reported as revenue movement. What is missing is exposing them as *funnel
steps*, which needs the two charges of a plan change **paired** — i.e. gated on §4.2.

Guards that must ride along: `null` when either price is null, when currencies differ (there is no FX
table and FIDELITY forbids one), or when billing intervals differ or are unknown — a monthly→annual
switch otherwise reads as a 12× upgrade.

### 4.4 Smaller, independent

- **Store enrichment.** Three Stores facets (`store_records`, `store_statuses`, `shopify_plans`) have
  only a `NOT_PUSHED` bucket because no enrichment collection exists. Either build the operator-push
  ingest, or remove the three dead facets — implying data that cannot arrive is its own defect.
- **`all_time.currency`.** The lifetime revenue tile renders **bare** because the payload has no
  all-time currency field and borrowing the window's label would be a false claim. Publishing
  `all_time.currency` (null when the history spans more than one) lets the tile label itself.
- **18 cross-module barrel imports** exist from inside modules — the shape §3.13 forbids. None closes
  a cycle today, so CI passes, but they are the exact form that did. A refactor, not a patch.
- **Tab bundle size.** All three revenue views ship in the `/revenue` chunk; fetches are lazy but the
  JS is not. `next/dynamic` would trim it.
- **Naming.** `/countries` and `/apps` do not match their nav labels ("Revenue Country",
  "Partner Apps"). The generic `/growth-intel/*` redirects already cover renames.

---

## 5. Traps that keep recurring

Read [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) §3.12, §3.13, §4.4a and §4.4b for the full treatment.
The short version, each of which has shipped here more than once:

1. **Two spellings of one derivation.** `gross_churn_rate` was computed two ways under one label; a
   date span was parsed as UTC in one file and LOCAL in another. Extract one function; do not make
   two copies agree.
2. **A comment stating the un-done half as fact.** `.env.example` naming variables the code never
   read crash-looped every new self-hoster. **Never cite a doc by line number — use a section
   anchor**; line numbers here have already gone stale twice.
3. **`|| []` / `|| 0` collapsing "unknown" into a rendered zero.** Fixed structurally by
   `dataState.js` + `DataStateSection` after shipping three times.
4. **Cross-module barrel imports closing a cycle.** Deep-path a pure leaf instead.
5. **A guard that does not fire.** `NaN > allowed` is `false`; test the guard, not just the happy path.
6. **Route-prefix detection.** Path changes silently disabled the partner-app fetch. Route matching
   now lives in `frontend/utils/dashboardRoutes.js` — one declaration, read by the nav, the fetch
   gate and every link.
