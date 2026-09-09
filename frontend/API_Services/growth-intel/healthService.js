import AxiosClientProvider from '../apiClient';

/**
 * =============================================================================
 *  Readiness — is this backend serving numbers that mean anything?
 * =============================================================================
 *
 *      GET /healthz
 *        200 → data.state 'ready'    a sync has completed; stored history exists
 *        503 → data.state 'warming'  up, but nothing synced yet
 *            → data.state 'degraded' up, but the datastore could not be read
 *
 *  ── ⚠️ THE ONE PATH THAT IS NOT UNDER /api ───────────────────────────────────
 *  `/healthz` sits at the server root, so this is the single call in the whole
 *  app that overrides the axios `baseURL`. Without the override, axios joins it
 *  onto the base and requests `/api/healthz`, which does not exist — and the
 *  page would report "degraded" for a perfectly healthy backend.
 *
 *  ── UNAUTHENTICATED, AND DELIBERATELY UNINFORMATIVE ─────────────────────────
 *  It is reachable by anyone who can reach the port, so it names no app, no shop
 *  counts, no revenue and not even the last sync time. It is the one thing a
 *  status screen can ask BEFORE a token exists. For anything richer, sign in and
 *  read `metaService.getCoverage`.
 *
 *  ──  A 503 IS AN ANSWER, NOT A FAILURE ─────────────────────────────────────
 *  'warming' is the normal state of a fresh install and it arrives as a 503, so
 *  the catch below reads the body rather than discarding it — treating a 503 as
 *  a transport error would report a working, empty install as broken.
 *
 *  ⚠️ The check really does hit Mongo, because "healthy while the database is
 *  gone" is the one lie a readiness probe must not tell. With Mongo down it can
 *  take up to the driver's buffer timeout (~10s) to answer, so give any polling
 *  loop a timeout above that or a slow 503 gets reported as no answer at all.
 * =============================================================================
 */

/**
 * Returned when the API refuses the call. Not expected here — `/healthz` takes no token — but kept
 * so every service in this folder answers 401 the same way.
 */
const resourceNotAllowed = { resource_access: 'NOT_ALLOWED' };

class GrowthIntelHealthApiService {
    constructor() {
        this.apiClient = new AxiosClientProvider().getClient();
    }

    /**
     * Reads the backend's readiness state.
     *
     * @param {Function} cb - Receives `{ status, msg, data: { state, reason, checked_at } }` for both
     * the 200 and the 503 — the 503 body is the answer, not an error — or `{}` when nothing
     * responded at all.
     * @returns {void}
     */
    getSnapshot(cb) {
        this.apiClient
            .get('healthz', { baseURL: '/' })
            .then((response) => { cb(response && response.data ? response.data : {}); })
            .catch((err) => {
                if (err.response && err.response.status === 401) { cb(resourceNotAllowed); return; }
                // 503 'warming' / 'degraded' is a real reading of the backend's state.
                if (err.response && err.response.data) {
                    cb(err.response.data);
                    return;
                }
                console.log('GrowthIntel health.getSnapshot error', err);
                cb({});
            });
    }
}

export default GrowthIntelHealthApiService;
