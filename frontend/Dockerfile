# =============================================================================
#  shopify-app-analytics — DASHBOARD (Next.js 14, pages router)
# =============================================================================
#
#  Three stages, so the shipped image contains no source, no dev toolchain and
#  no build cache:
#
#      deps    node_modules only          — cached until package.json changes
#      build   next build                 — produces .next/standalone
#      runtime the standalone server      — what actually ships
#
#  Build:  docker build -t shopify-app-analytics-frontend .
#  Run:    docker run --init -p 3000:3000 \
#              -e NEXT_PUBLIC_API_BASE_URL=http://host.docker.internal:8080 \
#              shopify-app-analytics-frontend
#
#  Normally you want `docker compose up` from the repository root instead — see
#  ../docker-compose.yml, which wires this to the API and MongoDB.
# =============================================================================

# Alpine keeps the runtime image small, and Next 14 ships musl SWC binaries so
# there is no native-build penalty. Node 22 is pinned to a MAJOR deliberately:
# the backend requires >=22, and floating within the major keeps picking up
# security patches without silently changing language semantics under you.
ARG NODE_VERSION=22-alpine


# =============================================================================
#  STAGE 1 — deps.  Isolated so editing a page does not reinstall node_modules.
# =============================================================================
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

# The `package-lock.json*` glob is OPTIONAL on purpose: at the time of writing
# this project has no frontend lockfile. `package.json` matches, so the glob
# matching nothing is not an error.
COPY package.json package-lock.json* ./

# `npm ci` when a lockfile exists — it is faster and, more importantly,
# reproducible: it installs the exact resolved tree rather than re-resolving
# every `^` range at build time.
#
# ⚠️ There is currently NO frontend lockfile, so this falls back to `npm install`
# and your image contents depend on WHEN you build it. Fix that with:
#     (cd frontend && npm install && git add package-lock.json)
# after which every build of a given commit produces identical dependencies.
RUN if [ -f package-lock.json ]; then \
        echo "INFO: lockfile found — npm ci (reproducible)"; \
        npm ci; \
    else \
        echo "WARN: no package-lock.json — falling back to npm install."; \
        echo "WARN: builds are NOT reproducible until you commit a lockfile."; \
        npm install --no-audit --no-fund; \
    fi


# =============================================================================
#  STAGE 2 — build.
# =============================================================================
FROM node:${NODE_VERSION} AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Opt out of the anonymous build-time telemetry ping. A self-hosted analytics
# tool phoning home during its own build is a poor look, and this also avoids a
# needless network call on an air-gapped builder.
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

#  DO NOT TURN THIS INTO A BUILD ARG, AND DO NOT PUT A REAL HOSTNAME HERE.
#
# It is tempting: `rewrites()` reads NEXT_PUBLIC_API_BASE_URL, so baking the real
# value in "just works" for one deployment — and permanently welds that image to
# one backend, which is exactly the property this project was designed not to
# have (see the header of next.config.js and API_Services/apiClient.js).
#
# `next build` freezes the rewrite destination into its generated output, so the
# value cannot simply be supplied at runtime either. The resolution is this
# sentinel: build against a host that resolves NOWHERE, then substitute the real
# one at container start (docker-entrypoint.sh). The sentinel is deliberately
# not a valid hostname, so an image that somehow escapes substitution fails
# obviously instead of quietly proxying to the wrong place.
ENV NEXT_PUBLIC_API_BASE_URL=http://API_BASE_PLACEHOLDER

# `--no-lint` is deliberate, and it is not a way of hiding problems.
#
# `next build` runs ESLint and treats a rule violation as a BUILD FAILURE, which
# means a stylistic rule — an unescaped apostrophe in some JSX copy — can stop
# you shipping. Linting is a development and CI gate (`npm run lint`), not a
# packaging gate: the code that is about to run in production is byte-identical
# either way.
#
# ⚠️ At the time of writing `npm run build` DOES fail this way, on 5 pre-existing
# errors in 3 files (react/no-unescaped-entities x4, react/display-name x1).
# Run `npm run lint` to see them. Nothing here depends on their being fixed, but
# they are worth fixing.
RUN npx next build --no-lint

# Record which generated files carry the sentinel and stash pristine copies.
# The entrypoint restores from these on EVERY start, which is what keeps the
# substitution idempotent and lets a restart pick up a changed backend URL.
#
# Discovering the list here rather than hardcoding it means a future Next version
# that emits the destination somewhere new keeps working — and `test -s` turns
# "Next changed and we substitute nothing" into a BUILD failure rather than a
# mysterious runtime one.
RUN set -eu; \
    cd /app/.next/standalone; \
    mkdir -p /app/.origin; \
    grep -rlF 'http://API_BASE_PLACEHOLDER' . > /app/.origin/FILELIST; \
    test -s /app/.origin/FILELIST || { \
        echo "FATAL: sentinel not found in the build output — the substitution"; \
        echo "       mechanism in docker-entrypoint.sh would be a no-op."; exit 1; }; \
    while IFS= read -r f; do \
        mkdir -p "/app/.origin/$(dirname "$f")"; \
        cp "$f" "/app/.origin/$f"; \
    done < /app/.origin/FILELIST; \
    echo "INFO: sentinel recorded in:"; cat /app/.origin/FILELIST


# =============================================================================
#  STAGE 3 — runtime.
# =============================================================================
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# The standalone server reads both. HOSTNAME is set explicitly because the
# default only *happens* to be 0.0.0.0; binding to localhost inside a container
# makes the port unreachable from outside it, which looks like a crash.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as a non-root user: a dashboard that proxies an authenticated API has no
# reason to be able to write anywhere in the image. `node` (uid 1000) already
# exists in the base image, so no useradd is needed.
#
# --chown matters: the entrypoint REWRITES the generated files in place, so they
# must be owned by the user that runs them. Root-owned files would fail the
# substitution with a permission error at every start.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/.origin ./.origin

# Static assets. Tracing does not include `public/` because nothing imports it —
# it is read from disk at request time — so it must be copied explicitly or the
# dashboard's CSS 404s.
COPY --from=build --chown=node:node /app/public ./public

COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER node

EXPOSE 3000

# Liveness only. It asks the dashboard's own login page, NOT /healthz — /healthz
# proxies to the backend, which answers 503 until its first sync finishes, so
# using it here would mark a perfectly healthy dashboard unhealthy for as long as
# the initial Partner API sync takes.
#
# busybox wget is already present; adding curl would mean another package.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:3000/login || exit 1

# ⚠️ PID 1: this container expects an init process, supplied by `init: true` in
# docker-compose.yml (or `--init` on a bare `docker run`). Docker's init (tini)
# becomes PID 1 and forwards SIGTERM to node, which the kernel would otherwise
# discard — PID 1 ignores signals it has no explicit handler for, and Next's
# standalone server installs none. Without it, every `docker compose down` waits
# out the full 10s grace period and then SIGKILLs.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
