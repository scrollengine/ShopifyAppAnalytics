import AxiosClientProvider from '../apiClient';

/**
 * =============================================================================
 *  Coverage — how far the synced history reaches, and what is missing from it.
 * =============================================================================
 *
 *  Every other endpoint answers "what are my numbers". This one answers "how
 *  much of that can you believe", and it is the honesty layer the rest of the
 *  suite is qualified by:
 *
 *      GET /api/meta/coverage?partner_app_id=…
 *        → { partner_app_id, app_handle, display_name, as_of, reporting_currency,
 *            active_sub_window_days, coverage: { … } }
 *
 *  ── NEW — NOT PORTED ────────────────────────────────────────────────────────
 *  The source dashboard had no equivalent, which is exactly why its figures
 *  could not say how complete they were. Belongs on the Sync / status screen,
 *  and as a caveat strip on Revenue.
 *
 *  ──  null MEANS "NEVER MEASURED", NOT ZERO ─────────────────────────────────
 *  Each field inside `coverage` is a `{ value, confidence, source, reason? }`
 *  envelope and each may be null. Rendering a null as 0 inverts its meaning, and
 *  most sharply on the two fields where 0 is the REASSURING value:
 *
 *    · `event_history_gap_days: 0` asserts the history has no holes at all;
 *    · `charge_link_absent_pct: 0` asserts every row is linked to a charge.
 *
 *  Show "not measured" for a null. And note `lifetime_sync_completed_at`: while
 *  it is null, every `lifetime_*` figure elsewhere is a FLOOR — whatever an
 *  incremental window happened to pull — not a total.
 * =============================================================================
 */

/**
 * Returned when the API refuses the call. See conversionService for the full note.
 */
const resourceNotAllowed = { resource_access: 'NOT_ALLOWED' };

/**
 * The API's own 403 envelope, when that is what `err` carries.
 *
 * Forwarded INTACT rather than flattened to `{}`: its `error: { code: 'FORBIDDEN', permission }` is
 * what lets `readDataState` say "Restricted — your role does not include …". Flattened, a role that
 * lacks the permission would read "This could not be loaded" — a failure nobody can fix from a log,
 * reported in place of the access the reader actually lacks.
 *
 * @param {Object} err - The axios error.
 * @returns {Object|null} The envelope, or null when this is not a 403 with a body.
 */
const _forbiddenEnvelope = (err) => {
    if (!err || !err.response || err.response.status !== 403) {
        return null;
    }
    const body = err.response.data;
    if (!body || typeof body !== 'object') {
        return null;
    }
    return body;
};

class GrowthIntelMetaApiService {
    constructor() {
        this.apiClient = new AxiosClientProvider().getClient();
    }

    /**
     * Reads the coverage measurements for one partner app.
     *
     * @param {Object} params - { partner_app_id } — required.
     * @param {Function} cb - Receives `{ status, msg, data }`, the 403 envelope when the role lacks
     * `apps:read`, or `{}` / `resourceNotAllowed` on failure.
     * @returns {void}
     */
    getCoverage(params, cb) {
        this.apiClient
            .get('meta/coverage', { params: params || {} })
            .then((response) => { cb(response && response.data ? response.data : {}); })
            .catch((err) => {
                if (err.response && err.response.status === 401) { cb(resourceNotAllowed); return; }
                const forbidden = _forbiddenEnvelope(err);
                if (forbidden) { cb(forbidden); return; }
                console.log('GrowthIntel meta.getCoverage error', err);
                cb({});
            });
    }
}

export default GrowthIntelMetaApiService;
