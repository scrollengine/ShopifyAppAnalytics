# =============================================================================
#  shopify-app-analytics — BACKEND IMAGE
# =============================================================================
#
#  Build:  docker build -t shopify-app-analytics-backend .
#  Run:    docker run --rm -p 8080:8080 --env-file .env shopify-app-analytics-backend
#
#  ── Why this is a multi-stage build and not a one-liner ─────────────────────
#  `npm start` in package.json is:
#
#      node -r ts-node/register/transpile-only src/apps/app.ts
#
#  and ts-node + typescript are DEV dependencies. So the obvious production
#  recipe — `npm ci --omit=dev` then `npm start` — fails at startup with
#  "Cannot find module 'ts-node/register/transpile-only'". Shipping ts-node to
#  production to paper over that would mean the compiler runs on every boot and
#  a type error only ever surfaces as a 3am crash loop.
#
#  So: compile ONCE in a throwaway stage, ship plain JavaScript, and run it with
#  plain `node`. `npm start` is a development convenience; it is deliberately
#  not the container's entrypoint.
#
#  ── Configuration ───────────────────────────────────────────────────────────
#  NOTHING is baked in. `.env` is excluded by .dockerignore (see that file for
#  why that matters), and src/config/index.ts is the only module that reads
#  process.env. Pass configuration at RUN time: --env-file .env, or compose's
#  `environment:`, or your orchestrator's secret store.
#
#  bootstrap() calls dotenv, which never overwrites a variable that is already
#  set — so a real container environment variable always beats a file, and a
#  missing .env is a no-op rather than an error.
#
#  Required (the process refuses to boot without them, naming the one it wants):
#      MONGO_URI  JWT_SECRET  ADMIN_EMAIL  ADMIN_PASSWORD (or ADMIN_PASSWORD_HASH)
#      SHOPIFY_PARTNER_ORG_ID  SHOPIFY_PARTNER_API_TOKEN  SHOPIFY_PARTNER_API_VERSION
# =============================================================================

# One place to pin the base image, shared by all three stages so they can never
# drift onto different Node minors. Override at build time to test a new Node:
#     docker build --build-arg NODE_IMAGE=node:22.14-alpine .
# For a fully reproducible build, pin a digest here (node:22-alpine@sha256:...).
ARG NODE_IMAGE=node:22-alpine


# =============================================================================
#  STAGE 1 — deps: the FULL dependency tree, devDependencies included
# =============================================================================
#  Separate from the build stage purely for layer caching: this layer is keyed
#  on package.json + package-lock.json alone, so editing a .ts file does not
#  re-run a two-minute install.
#
#  `npm ci` (not `npm install`) — it installs exactly what the lockfile says and
#  fails if package.json and the lockfile disagree, so the image can never be
#  built against silently different versions than the ones that were tested.
# =============================================================================
FROM ${NODE_IMAGE} AS deps

WORKDIR /app

# Only the manifests. Copying src here would invalidate this layer on every
# source edit, which is the whole thing this stage exists to avoid.
COPY package.json package-lock.json ./

# devDependencies are REQUIRED here — typescript is one of them, and stage 2
# cannot compile without it.
# --no-audit --no-fund: two network round-trips that produce advice nobody reads
# during a build, and that fail the build if the registry is having a bad day.
RUN npm ci --no-audit --no-fund


# =============================================================================
#  STAGE 2 — build: TypeScript -> JavaScript
# =============================================================================
FROM ${NODE_IMAGE} AS build

WORKDIR /app

# The installed tree from stage 1, unchanged. Nothing is installed here.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./

# tsconfig.json sets rootDir: ./src and outDir: ./dist, so src/apps/app.ts lands
# at dist/apps/app.js. It also `exclude`s test/, so nothing from the test tree is
# compiled even if it were present.
COPY tsconfig.json ./
COPY src ./src

# A full typecheck, not a transpile. tsconfig has strict + noUnusedLocals +
# noUnusedParameters + noImplicitReturns, and this is the ONLY place in the
# lifecycle where they are enforced — `npm start` uses ts-node's transpile-only
# hook, which reports no type errors at all. Failing the build here is the point:
# a type error becomes a red build instead of a runtime crash in production.
RUN npx tsc

# Fail loudly, now, if the entry point is not where the runtime stage expects it.
# Without this a bad rootDir/outDir change produces an image that builds fine and
# then exits with MODULE_NOT_FOUND on first run, which is a much worse place to
# find out.
RUN test -f dist/apps/app.js \
    || (echo "FATAL: dist/apps/app.js is missing — check rootDir/outDir in tsconfig.json" && exit 1)


# =============================================================================
#  STAGE 3 — runtime: production dependencies + compiled JS. No compiler.
# =============================================================================
FROM ${NODE_IMAGE} AS runtime

# ── PID 1 ───────────────────────────────────────────────────────────────────
# tini is here for one specific reason. The process started by CMD becomes PID 1,
# and the kernel gives PID 1 NO default signal handlers: a SIGTERM that a normal
# process would die from is simply DISCARDED unless the program installs its own
# handler. src/core/shutdown.ts does install one — but it is registered inside
# bootstrap().then(), so during the whole boot window (dotenv, config validation,
# the Mongo connection, the admin seed, the partner-app registration) there is no
# handler yet and a `docker stop` in that window is ignored until the 10s grace
# period expires and the daemon SIGKILLs.
#
# A SIGKILL skips the entire shutdown sequence: the cron is not stopped, in-flight
# HTTP requests are cut, and the job runner never drains — leaving sync rows stuck
# in RUNNING until the stuck-job sweeper fails them half an hour later.
#
# tini runs as PID 1 with proper default handlers, forwards signals to node, and
# reaps zombies. The alternatives are equivalent and both are fine if you prefer
# them: `docker run --init`, or `init: true` on the compose service — those inject
# Docker's own bundled tini and this ENTRYPOINT then simply becomes redundant.
#
# Deliberately unpinned: Alpine's apk index only ever carries the current revision
# of a package, so pinning `tini=0.19.0-rN` guarantees a build that breaks the next
# time Alpine rotates its index. This is the one place a floating version is the
# more reliable choice.
RUN apk add --no-cache tini

# Owned by node up front so the unprivileged user can actually write node_modules
# into it below. WORKDIR alone would create this root-owned.
RUN mkdir -p /app && chown node:node /app
WORKDIR /app

# ── Drop root BEFORE anything writes to /app ────────────────────────────────
# The node:*-alpine images already ship an unprivileged `node` user (uid 1000);
# creating another one would be pure ceremony. Switching here rather than at the
# end means every file below is created node-owned in the first place, so there
# is no `chown -R` layer duplicating the entire tree just to fix permissions.
# npm needs a writable HOME for its cache — /home/node exists and is node-owned.
USER node

COPY --chown=node:node package.json package-lock.json ./

# --omit=dev is what makes this image small and its attack surface honest:
# typescript, ts-node, eslint and their transitive trees never enter it. The
# nine runtime dependencies (@google-cloud/bigquery, axios, bcryptjs, dotenv,
# express, helmet, jsonwebtoken, mongoose, stopcock) are all pure JavaScript, so
# there is nothing to build here.
#
# ⚠️ This is also why `npm run seed:demo` does NOT work in this image: ts-node is
# a devDependency and src/ is never copied. Use `npm run seed:demo:dist`, which
# runs the compiled dist/scripts/seedDemo.js.
RUN npm ci --omit=dev --no-audit --no-fund

# The compiled output, and ONLY the compiled output. No src/, no tsconfig, no
# test/. The .js.map files that come with it are what makes --enable-source-maps
# below able to name the original .ts file and line in a stack trace.
COPY --chown=node:node --from=build /app/dist ./dist

# Read for error verbosity and cookie flags. It never switches business logic —
# the numbers this thing reports must be identical in every environment.
ENV NODE_ENV=production

# Pinned explicitly rather than left to the application default. src/config
# falls back to 4700 when PORT is unset, but .env.example and the frontend's
# rewrite target both use 8080 — so the image states 8080 outright and the
# EXPOSE line below cannot drift away from what the process actually binds.
# Override with `-e PORT=...` (change the EXPOSE/publish mapping to match).
ENV PORT=8080

EXPOSE 8080

# ── HEALTHCHECK ─────────────────────────────────────────────────────────────
# ANY HTTP response counts as healthy — including a 503. That is not laziness,
# it is the difference between the two questions:
#
#   /healthz answers READINESS: "is there synced data worth serving?" It returns
#   503 from the moment the socket binds until the first Partner API sync
#   completes, which on a fresh install is a full sync of your Partner history.
#   It also returns 503 whenever Mongo is unreachable.
#
#   A Docker HEALTHCHECK is consumed as LIVENESS: it drives `unhealthy`, which
#   orchestrators and `depends_on: condition: service_healthy` react to by
#   restarting or refusing to start dependents.
#
# Wire the first into the second and a perfectly healthy container is declared
# unhealthy for the entire duration of its first sync, and a container whose
# Mongo is down gets restarted forever — which cannot possibly fix Mongo, and
# throws away the readable 503 explaining what is actually wrong.
#
# So this check asks the liveness question only: did the event loop answer HTTP?
# For readiness, read the body — `data.state` is 'ready' | 'warming' | 'degraded'
# and `data.reason` is written for a human.
#
# --timeout=20s is above mongoose's ~10s buffer timeout on purpose: with Mongo
# down the handler genuinely takes that long to answer, and a shorter timeout
# would report a probe failure instead of the state the endpoint is trying to
# describe.
#
# node -e rather than curl/wget: curl is not in this image, and busybox wget
# exits non-zero on 503 — which is precisely the response we need to treat as
# alive. Node is already here and gives exact control over the exit code.
HEALTHCHECK --interval=30s --timeout=20s --start-period=60s --retries=3 \
    CMD node -e 'const q=require("http").get({host:"127.0.0.1",port:process.env.PORT||8080,path:"/healthz",timeout:15000},r=>process.exit(r.statusCode?0:1));q.on("error",()=>process.exit(1));q.on("timeout",()=>{q.destroy();process.exit(1)})'

# tini as PID 1 (see above); `--` so everything after it is the child command.
ENTRYPOINT ["/sbin/tini", "--"]

# Exec form: no shell wrapper, so node is tini's direct child and receives the
# forwarded SIGTERM itself. Shell form (`CMD node dist/...`) would interpose
# /bin/sh, which does not forward signals to its child.
#
# --enable-source-maps: consumes the .js.map files copied above so a stack trace
# names the .ts file and line it came from, rather than a compiled dist/ offset.
# Worth its small cost on a service whose failures show up in a log file.
CMD ["node", "--enable-source-maps", "dist/apps/app.js"]
