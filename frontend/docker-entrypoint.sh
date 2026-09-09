#!/bin/sh
#
# =============================================================================
#  Point the built dashboard at the real API, at CONTAINER START.
# =============================================================================
#
#  WHY THIS FILE EXISTS
#  --------------------
#  `next build` resolves next.config.js's `rewrites()` ONCE and freezes the
#  destination into its generated output. The production server routes from that
#  frozen manifest and never calls `rewrites()` again — so without this script the
#  API location would be whatever was set when the IMAGE was built, and changing
#  NEXT_PUBLIC_API_BASE_URL later would do nothing at all.
#
#  The image is therefore built against a sentinel host that cannot resolve
#  anywhere, and this script swaps it for the real one before the server starts.
#  Net effect: one image, deployable against any backend, configured purely by
#  environment — no build ARG, no rebuild, nothing host-specific baked in.
#
#  WHY IT RESTORES FROM .origin FIRST
#  ----------------------------------
#  Substitution consumes the sentinel. If we edited in place, the FIRST start
#  would work and every later one would silently keep the first value — so
#  `docker compose restart` after editing .env would appear to do nothing. The
#  build stage stashes pristine copies in /app/.origin and we restore them on
#  every start, which makes this idempotent and re-configurable.
# =============================================================================

set -eu

PLACEHOLDER='http://API_BASE_PLACEHOLDER'
ORIGIN_DIR='/app/.origin'
FILELIST="${ORIGIN_DIR}/FILELIST"

# Default matches the compose service name, so the stack works with no env set.
: "${NEXT_PUBLIC_API_BASE_URL:=http://backend:8080}"

# Mirror next.config.js's own normalisation, so `http://backend:8080/` and
# `http://backend:8080` cannot produce a doubled slash in the proxied path.
API_BASE_URL="$(printf '%s' "${NEXT_PUBLIC_API_BASE_URL}" | sed 's|/*$||')"

# A bare hostname is the classic mistake here and produces a confusing runtime
# error rather than a clear one, so reject it up front and say what to write.
case "${API_BASE_URL}" in
    http://*|https://*) ;;
    *)
        echo "FATAL: NEXT_PUBLIC_API_BASE_URL must include a scheme." >&2
        echo "       got:      '${NEXT_PUBLIC_API_BASE_URL}'" >&2
        echo "       expected: 'http://backend:8080' (the compose service name)" >&2
        exit 1
        ;;
esac

if [ ! -s "${FILELIST}" ]; then
    echo "FATAL: ${FILELIST} is missing or empty — the image was built wrong." >&2
    echo "       The build stage should have recorded which generated files carry" >&2
    echo "       the '${PLACEHOLDER}' sentinel. Rebuild with: docker compose build --no-cache frontend" >&2
    exit 1
fi

# Substitute the real API base into each generated file, reading from the
# pristine copy and writing over the live one in a single pass.
#
# ⚠️ The shape of this loop is load-bearing — the two obvious ways to write it
# both fail as a non-root user, and only at RUN time:
#
#   `cp src dest`  — busybox cp unlinks an existing destination and recreates
#                    it, and `sed -i` writes a temp file then renames. BOTH need
#                    write permission on the DIRECTORY, not just the file.
#   /app is root-owned on purpose (the app user can modify the few files it must
#   and create or delete nothing), so both fail with a misleading
#   "cp: can't create './server.js': File exists".
#
# A plain `>` redirect opens the destination with O_TRUNC — no unlink, no temp
# file, no directory write — and preserves the file's owner and mode.
#
# Reading the file list from the build (rather than hardcoding three names) means
# this keeps working if a future Next version emits the destination elsewhere.
while IFS= read -r f; do
    [ -n "$f" ] || continue
    sed "s|${PLACEHOLDER}|${API_BASE_URL}|g" "${ORIGIN_DIR}/${f}" > "$f"
done < "${FILELIST}"

# Fail loudly rather than serving a dashboard whose API calls all 500. If the
# sentinel survived in a LIVE file, the substitution missed something and every
# proxied request would fail against a host that resolves nowhere.
#
# .origin is excluded because it is the pristine stash — those copies are meant
# to keep the sentinel, and that is what makes a restart re-configurable.
_leftover="$(grep -rlF "${PLACEHOLDER}" . 2>/dev/null | grep -v '^\./\.origin/' || true)"
if [ -n "${_leftover}" ]; then
    echo "FATAL: the '${PLACEHOLDER}' sentinel is still present after substitution." >&2
    echo "       Remaining in:" >&2
    echo "${_leftover}" >&2
    exit 1
fi

echo "INFO: dashboard will proxy /api and /healthz to ${API_BASE_URL}"

# `exec` so node REPLACES this shell and becomes the process Docker signals.
# Without it the shell stays as PID 1, node never sees SIGTERM, and every stop
# waits the full 10s grace period before a SIGKILL.
exec node server.js
