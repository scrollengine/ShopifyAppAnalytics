/**
 * =============================================================================
 *  The "this backend does not have that endpoint yet" reply.
 * =============================================================================
 *
 *  The nine Performance pages were extracted from a dashboard whose API had
 *  ~30 growth endpoints. This backend has SEVEN, and the rest are being rebuilt.
 *  Every service method in this folder is still present — the pages call them by
 *  name and would crash on an undefined method — but the ones with no endpoint
 *  behind them answer with the envelope built here.
 *
 *  ── WHY NOT JUST `cb({})` ───────────────────────────────────────────────────
 *  Because `{}` is a lie that renders. Every ported page reads the response as
 *  `if (!resp.status) { setRows([]) }` and then draws its empty state — so an
 *  unbuilt endpoint and a genuinely empty result produce the SAME screen: "0
 *  stores", "no churn this month", a flat chart. A reader cannot tell "we have
 *  no data" from "we never asked", and neither can the person who later files a
 *  bug about the number being wrong. That failure is the exact one this whole
 *  project exists to avoid, so it must not be reintroduced in the API layer.
 *
 *  The envelope below therefore:
 *
 *    - keeps `status: false`, so every existing `if (!resp.status)` guard
 *      already handles it and no ported page needs editing;
 *    - carries `not_implemented: true` and an `error.code`, so a page (or a dev
 *      tools breakpoint) can say "not built yet" instead of "no results";
 *    - carries `msg` naming the endpoint that WOULD serve it, so the next
 *      person to work on the backend knows what to write;
 *    - logs once per method, loudly, on the console.
 *
 *  ── DELETING ONE ────────────────────────────────────────────────────────────
 *  When the backend grows the endpoint, replace the `_notImplemented(...)` call
 *  in the service with a real `_get(...)` and delete nothing else. The method
 *  name and callback contract are already what the page expects.
 * =============================================================================
 */

/** Machine-readable marker on `error.code`. Pages may branch on it; nothing else should. */
export const NOT_IMPLEMENTED_CODE = 'NOT_IMPLEMENTED';

/**
 * Methods already warned about, so a polling page logs once rather than every tick.
 * Keyed `service.method`, which is stable for the lifetime of the tab.
 */
const _warnedMethods = new Set();

/**
 * Calls back with the marked "no endpoint behind this yet" envelope.
 *
 * ⚠️ ASYNCHRONOUS ON PURPOSE. The real methods call back from an axios promise, so their callback
 * never runs during the caller's own synchronous block. A page that does
 * `API.getThing(p, cb); setLoading(true);` would have its `cb` — which almost always calls
 * `setLoading(false)` — run FIRST if this replied synchronously, leaving a spinner that never
 * stops. Deferring to a microtask makes the two paths behave identically.
 *
 * @param {Object} params - Description of the missing call.
 * @param {String} params.service - Service file name, e.g. 'conversionService'.
 * @param {String} params.method - Method name, e.g. 'getLogoChurn'.
 * @param {String} params.expected_endpoint - The path this method would call once it exists,
 * written as it should appear in the backend's routes, e.g. 'GET /api/conversion/logo-churn'.
 * @param {String} [params.note] - Optional extra context: what the backend would need in order to
 * answer it at all (a data source that is not synced yet, a computation that does not exist).
 * @param {Function} cb - The caller's callback. Receives the envelope.
 * @returns {void}
 */
export const notImplemented = ({ service, method, expected_endpoint, note }, cb) => {
    const key = `${service}.${method}`;

    let detail = `${key}() is not available: this backend does not implement ${expected_endpoint} yet.`;
    if (note) {
        detail = `${detail} ${note}`;
    }

    if (!_warnedMethods.has(key)) {
        _warnedMethods.add(key);
        // console.warn, not console.log: this is a real gap in the deployment, and it should stand
        // out in a console that a data-heavy page fills with noise.
        console.warn(`[not implemented] ${detail}`);
    }

    const envelope = {
        status: false,
        not_implemented: true,
        msg: detail,
        data: {},
        error: {
            code: NOT_IMPLEMENTED_CODE,
            service: service,
            method: method,
            expected_endpoint: expected_endpoint
        }
    };

    if (typeof cb !== 'function') {
        return;
    }
    Promise.resolve().then(() => cb(envelope));
};

export default notImplemented;
