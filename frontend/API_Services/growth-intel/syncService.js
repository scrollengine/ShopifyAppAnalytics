import AxiosClientProvider from '../apiClient';
import { notImplemented } from './notImplemented';

/**
 * =============================================================================
 *  Sync — pull from the Shopify Partner API, then watch the job.
 * =============================================================================
 *
 *  Backs the Sync / status screen.
 *
 *  ── WHAT EXISTS TODAY ───────────────────────────────────────────────────────
 *      triggerSync                    →  POST /api/sync/partner              ✅
 *      triggerBigQuerySync            →  POST /api/sync/bigquery             ✅
 *      triggerInstallAttributionSync  →  POST /api/sync/install-attribution  ✅
 *      triggerDummySync               →  POST /api/sync/dummy                ✅
 *      getJob                         →  GET  /api/sync/jobs/:job_id         ✅
 *      listJobs                       →  GET  /api/sync/jobs                 ✅
 *      cancelJob                      →  POST /api/sync/jobs/:job_id/cancel  ✅
 *      getHealth                      →  GET  /api/sync/health               ✅
 *
 *  Every method in this file now reaches a real route. Nothing here answers the
 *  not-implemented envelope any more EXCEPT `triggerSync` handed a job type that
 *  genuinely has no trigger — see below.
 *
 *  ── THE ENDPOINT *IS* THE JOB TYPE ──────────────────────────────────────────
 *  There is no generic POST /sync/trigger on this backend — each runnable job
 *  type has its own route, which validates its own payload. `triggerSync` still
 *  accepts the source dashboard's `{ job_type, payload }` shape and DISPATCHES
 *  it to the matching method, and refuses a type with no route rather than
 *  quietly running a different sync and reporting that as success.
 *
 *  FOUR types are routed: PARTNER_SYNC, BIGQUERY_SYNC, INSTALL_ATTRIBUTION_SYNC
 *  and DUMMY. The remaining three (KEYWORD_RANKING, COMPETITOR_SNAPSHOT,
 *  LLM_INSIGHT) have no route AND no handler on the server — enqueueing one
 *  would be refused by name — so the refusal here is the honest answer rather
 *  than a gap in this file.
 *
 *  ──  A 200 FROM A BIGQUERY TRIGGER IS NOT PROOF BIGQUERY IS CONNECTED ──────
 *  Neither BigQuery trigger checks credentials: the CONTROLLER only validates
 *  the request shape, and the JOB checks configuration when it runs — then fails
 *  naming the environment variable that is missing. So an unconfigured install
 *  can queue both of these all day and collect FAILED jobs.
 *
 *  That is why the Sync page reads the tier's configuration separately (GET
 *  /api/funnel refuses with that same named message) and DISABLES the buttons,
 *  instead of queueing work that is certain to fail.
 *
 *  ──  A 200 FROM triggerSync MEANS *QUEUED*, NOT *SYNCED* ───────────────────
 *  There is no queue broker: the trigger writes a PENDING row and a poll loop in
 *  the backend process claims it on its next tick. So the response carries a
 *  `job_id` and nothing about what the sync found — the numbers on screen have
 *  not moved yet, and may never move if the job fails.
 *
 *  Anything that reports "synced" off the trigger response alone is lying by one
 *  poll interval on a good day and permanently on a bad one. POLL `getJob` with
 *  the returned id until its status is terminal (SUCCESS / FAILED / CANCELLED)
 *  before telling the operator anything happened.
 *
 *  Two job shapes are worth recognising while polling, because they read
 *  backwards:
 *    · PENDING with `attempts > 0` and an `error_message` set is a job that
 *      FAILED and is being RETRIED — not a fresh job carrying a stale error.
 *    · FAILED with `failure_reason: 'STUCK_TIMEOUT'` is TWO different faults
 *      wearing one reason code, and they take opposite remedies. The sweep that
 *      writes it runs over RUNNING rows (a claimed job whose process died — part
 *      of its output may already be written, so re-running it blindly is the one
 *      unsafe retry) and over PENDING rows (a queued job nothing ever claimed —
 *      nothing ran, nothing was written, and re-running is exactly right).
 *      `started_at === null && attempts === 0` is what separates them; the row
 *      carries both, and `getHealth` publishes the sentence for whichever it is.
 * =============================================================================
 */

/** File name used in the not-implemented envelopes, so a console warning names its source. */
const SERVICE = 'syncService';

/**
 * The four job types that have a trigger route on this backend.
 *
 * These string literals are a CROSS-REPOSITORY CONTRACT with the backend's
 * `modules/sync/constants/sync.constants.ts` and with `components/growth-intel/syncCategories.js`,
 * which keys its cards on the same literals. Renaming one breaks no build anywhere — it silently
 * orphans a card, which then reports no runs for a job that is running perfectly well.
 *
 * A job type absent from this list has no route here — KEYWORD_RANKING, COMPETITOR_SNAPSHOT and
 * LLM_INSIGHT have no trigger route and no handler either, so the server would refuse them by name
 * anyway — and a caller asking for one must be told no rather than quietly getting a different sync.
 */
const PARTNER_SYNC_JOB_TYPE = 'PARTNER_SYNC';
const BIGQUERY_SYNC_JOB_TYPE = 'BIGQUERY_SYNC';
const INSTALL_ATTRIBUTION_SYNC_JOB_TYPE = 'INSTALL_ATTRIBUTION_SYNC';
/**
 * The smoke path. Runs with no credential and no data source, which is the whole point: it is what
 * separates "the runner is broken" from "the Partner API returned nothing" — two diagnoses that look
 * identical from the outside and have completely different fixes.
 */
const DUMMY_SYNC_JOB_TYPE = 'DUMMY';

/**
 * Returned when the API refuses the call. See conversionService for the full note; in short, the
 * axios interceptor has already started the redirect to /login by the time a caller sees it.
 */
const resourceNotAllowed = { resource_access: 'NOT_ALLOWED' };

/**
 * True when an axios error carries the API's own response envelope rather than a transport failure.
 *
 * The discriminator that keeps the server's refusal sentence alive. Every `status: false` service
 * result is mapped onto an HTTP 500 by this backend, and the cancel route answers 400 and 404 with
 * envelopes of its own — so a client that only forwarded 2xx bodies would turn "That job is RUNNING;
 * nothing here can interrupt a handler mid-flight" into `{}`, which renders as a blank failure with
 * no reason attached.
 *
 * @param {Object} err - The axios error.
 * @returns {Boolean} True when `err.response.data` is a `{ status, msg, … }` envelope.
 */
const _hasEnvelope = (err) => {
    if (!err || !err.response || !err.response.data) {
        return false;
    }
    const body = err.response.data;
    if (typeof body !== 'object') {
        return false;
    }
    return Object.prototype.hasOwnProperty.call(body, 'status');
};

/**
 * GETs one sync read and hands the envelope back, untouched.
 *
 * Written once for all three reads (`getJob`, `listJobs`, `getHealth`) rather than inlined per
 * method, for the same reason `_post` below is: three copies of an error path is how one of them
 * ends up flattening the server's explanation to `{}`.
 *
 * @param {Object} apiClient - The axios instance.
 * @param {String} path - Endpoint path, relative to `/api/`.
 * @param {Object} params - Query parameters.
 * @param {String} label - Method name, for the console line.
 * @param {Function} cb - Receives the response envelope.
 * @returns {void}
 */
const _get = (apiClient, path, params, label, cb) => {
    apiClient
        .get(path, { params: params || {} })
        .then((response) => { cb(response && response.data ? response.data : {}); })
        .catch((err) => {
            if (err.response && err.response.status === 401) { cb(resourceNotAllowed); return; }
            if (_hasEnvelope(err)) { cb(err.response.data); return; }
            console.log(`GrowthIntel sync.${label} error`, err);
            cb({});
        });
};

/**
 * Builds the body every trigger route accepts, from whichever call shape arrived.
 *
 * `partner_app_id`, `mode` and `lookback_days` are the only keys forwarded — the endpoints ignore
 * anything else, and spreading a caller's object would let an unrelated field ride along into a
 * stored job document.
 *
 *  `lookback_days` is tested against '' as well as null/undefined: an empty text input is the
 * usual source of this value, and `Number('')` is 0, which the server would read as a deliberate
 * zero-day window rather than as "not supplied".
 *
 * @param {Object} source - The flat fields: `{ partner_app_id, mode?, lookback_days? }`.
 * @returns {Object} The request body.
 */
const _triggerPayload = (source) => {
    const payload = { partner_app_id: source.partner_app_id };
    if (source.mode) {
        payload.mode = source.mode;
    }
    if (source.lookback_days !== undefined && source.lookback_days !== null && source.lookback_days !== '') {
        payload.lookback_days = source.lookback_days;
    }
    return payload;
};

/**
 * POSTs one write and hands the envelope back, identically for every route.
 *
 * Written once because the four enqueue endpoints and the cancel owe a caller exactly the same
 * treatment, and copies of an error path are how one of them ends up flattening the server's
 * explanation to `{}` — which renders as "failed to start sync" with no reason attached.
 *
 *  EVERY ENVELOPE IS PASSED THROUGH, whatever its status code. On the triggers a 400 is an
 * operator-fixable problem (almost always a missing `partner_app_id`) and the API's own message says
 * which. On the CANCEL it is load-bearing in a stronger way: the backend answers 400 when the row
 * could not be cancelled and 404 when the id names nothing, and `data.reason` on that 400 is the
 * only thing that tells the operator the runner claimed the job first. Dropping those bodies would
 * turn "you lost the race, here is why" into a blank failure.
 *
 * @param {Object} apiClient - The axios instance.
 * @param {String} path - Endpoint path, relative to `/api/`.
 * @param {Object} payload - The request body.
 * @param {String} label - Method name, for the console line.
 * @param {Function} cb - Receives the response envelope.
 * @returns {void}
 */
const _post = (apiClient, path, payload, label, cb) => {
    apiClient
        .post(path, payload)
        .then((response) => { cb(response && response.data ? response.data : {}); })
        .catch((err) => {
            if (err.response && err.response.status === 401) { cb(resourceNotAllowed); return; }
            if (_hasEnvelope(err)) { cb(err.response.data); return; }
            console.log(`GrowthIntel sync.${label} error`, err);
            cb({});
        });
};

/**
 * Reads the trigger fields out of either call shape.
 *
 * The source dashboard sent `{ job_type, payload: { … } }` because one endpoint dispatched on the
 * type; this backend takes the fields flat. Both are accepted so an unported screen and a new one
 * can call the same method.
 *
 * @param {Object} body - Either shape.
 * @returns {Object} The flat field bag.
 */
const _triggerSource = (body) => {
    const _body = body || {};
    if (_body.payload) {
        return _body.payload;
    }
    return _body;
};

class GrowthIntelSyncApiService {
    constructor() {
        this.apiClient = new AxiosClientProvider().getClient();
    }

    /**
     * Enqueues a sync and returns the PENDING job row.
     *
     * ⚠️ Accepts BOTH call shapes. The source dashboard sent `{ job_type, payload: { … } }` because
     * one endpoint dispatched on the type; this backend takes the fields flat. Rather than edit
     * every call site, this method reads the payload from whichever place it is in — and when a
     * `job_type` names one of the other two routed jobs, it DISPATCHES to that method rather than
     * running a Partner API sync the caller did not ask for.
     *
     * @param {Object} body - Either `{ partner_app_id, mode?, lookback_days? }` or the legacy
     * `{ job_type, payload: { partner_app_id, mode?, lookback_days? } }`.
     * `mode` is AUTO (default) | LIFETIME | INCREMENTAL; an unrecognised value falls back to AUTO at
     * the server. `lookback_days` is consulted only for an INCREMENTAL run on an app that has never
     * synced.
     * @param {Function} cb - Receives `{ status, msg, data: { job } }` — a job that is QUEUED, not
     * finished — or `{}` / `resourceNotAllowed` on failure.
     * @returns {void}
     */
    triggerSync(body, cb) {
        const _body = body || {};
        const source = _triggerSource(_body);

        // Dispatch, rather than refuse: these three now have routes of their own, and answering
        // "not implemented" to a caller that named one would be a stale answer, not an honest one.
        if (_body.job_type === BIGQUERY_SYNC_JOB_TYPE) {
            this.triggerBigQuerySync(source, cb);
            return;
        }
        if (_body.job_type === INSTALL_ATTRIBUTION_SYNC_JOB_TYPE) {
            this.triggerInstallAttributionSync(source, cb);
            return;
        }
        if (_body.job_type === DUMMY_SYNC_JOB_TYPE) {
            this.triggerDummySync(source, cb);
            return;
        }

        //  Refuse a job type this backend cannot trigger, instead of running a different one.
        // The three that land here (KEYWORD_RANKING, COMPETITOR_SNAPSHOT, LLM_INSIGHT) have no
        // handler on the server either, so this refusal matches what an enqueue would answer — it
        // is the state of the build, not a gap in this file.
        if (_body.job_type && _body.job_type !== PARTNER_SYNC_JOB_TYPE) {
            notImplemented({
                service: SERVICE,
                method: 'triggerSync',
                expected_endpoint: `a trigger route for job_type ${_body.job_type}`,
                note: `Routed job types: ${PARTNER_SYNC_JOB_TYPE}, ${BIGQUERY_SYNC_JOB_TYPE}, ${INSTALL_ATTRIBUTION_SYNC_JOB_TYPE}, ${DUMMY_SYNC_JOB_TYPE}. There is no generic /sync/trigger endpoint, and this type has no handler on the server either, so it cannot be started from anywhere.`
            }, cb);
            return;
        }

        _post(this.apiClient, 'sync/partner', _triggerPayload(source), 'triggerSync', cb);
    }

    /**
     * Enqueues the GA4 → BigQuery listing rollups (the BIGQUERY_SYNC job).
     *
     * Feeds Traffic Sources and the listing-view steps at the top of the Funnel page: daily
     * views, install clicks and installs, rolled up by source/medium and by country.
     *
     * THIS DOES NOT CHECK THAT BIGQUERY IS CONFIGURED, and a 200 here does not mean it is. The
     * controller validates only the request shape; the JOB resolves credentials when it runs, and
     * then fails with a message naming the missing environment variable. An unconfigured install can
     * therefore queue this repeatedly and collect nothing but FAILED rows — which is why the Sync
     * page establishes configuration separately and disables the button rather than letting an
     * operator queue work that cannot succeed.
     *
     * @param {Object} body - `{ partner_app_id, mode?, lookback_days? }`, or the legacy
     * `{ payload: { … } }` shape. `mode` is AUTO (default) | LIFETIME | INCREMENTAL — AUTO pulls the
     * days since the last successful rollup, LIFETIME re-reads from `BQ_LIFETIME_FLOOR_DATE`.
     * @param {Function} cb - Receives `{ status, msg, data: { job } }` — QUEUED, not finished. Poll
     * `getJob(job_id)` to a terminal status before reporting that anything synced.
     * @returns {void}
     */
    triggerBigQuerySync(body, cb) {
        const source = _triggerSource(body);
        _post(this.apiClient, 'sync/bigquery', _triggerPayload(source), 'triggerBigQuerySync', cb);
    }

    /**
     * Enqueues the per-install attribution sync — or PRICES it, when `dry_run` is set.
     *
     * A separate job from the rollups above, deliberately: it reads the whole event-parameter
     * column, so it carries its own watermark, its own cost and its own failure domain. Running the
     * BigQuery sync does NOT run this one, and until this has run once every store reads
     * "Not attributed".
     *
     * ⚠️ THE RESPONSE SHAPE DEPENDS ON `dry_run`. A normal call answers `{ job }` and must be
     * polled; a dry run runs INLINE and answers an ESTIMATE — `{ gib_scanned, exceeds_cap, mode,
     * start, end }` and no job at all, because a queued job could never hand the estimate back to
     * the caller who asked what the scan would cost. Callers must branch on what they asked for;
     * handing a dry run to a poller would wait out its whole deadline on a job id that never exists.
     *
     * Configuration is not checked here either — see `triggerBigQuerySync`.
     *
     * @param {Object} body - `{ partner_app_id, mode?, lookback_days?, dry_run?,
     * include_collected_source? }`, or the legacy `{ payload: { … } }` shape. Set
     * `include_collected_source: false` when the GA4 export predates that column.
     * @param {Function} cb - Receives `{ status, msg, data }` — `data.job` normally, the estimate on
     * a dry run.
     * @returns {void}
     */
    triggerInstallAttributionSync(body, cb) {
        const source = _triggerSource(body);
        const payload = _triggerPayload(source);

        //  Sent only when the caller asked for it, and compared against `true` rather than
        // coerced: the server reads a truthy `dry_run` as "price it, do not run it", so forwarding a
        // stray string would silently turn a real sync into an estimate — and the caller would poll
        // a job id that was never created.
        if (source.dry_run === true) {
            payload.dry_run = true;
        }
        if (source.include_collected_source === false) {
            payload.include_collected_source = false;
        }

        _post(this.apiClient, 'sync/install-attribution', payload, 'triggerInstallAttributionSync', cb);
    }

    /**
     * Enqueues the infrastructure smoke test — a job that sleeps and succeeds.
     *
     *  THE ONLY JOB THAT RUNS WITH NO CREDENTIAL AND NO DATA SOURCE, which is exactly what makes
     * it worth a button. When a real sync is not producing anything there are two very different
     * causes — the runner is not claiming work at all, or it is claiming it and the upstream is
     * empty — and they look identical from the dashboard. This one isolates the first: if it goes
     * PENDING → RUNNING → SUCCESS, the queue, the claim and the polling all work, and the fault is
     * upstream of the runner.
     *
     * Takes no partner app: the job is GLOBAL, and passing one would imply a scope it does not have.
     *
     * @param {Object} body - `{ sleep_ms? }`, or the legacy `{ payload: { … } }` shape. Anything
     * else is dropped rather than forwarded onto the stored job document.
     * @param {Function} cb - Receives `{ status, msg, data: { job } }` — QUEUED, not finished. Poll
     * `getJob(job_id)` to a terminal status, exactly as for a real sync.
     * @returns {void}
     */
    triggerDummySync(body, cb) {
        const source = _triggerSource(body);
        const payload = {};

        //  `sleep_ms` is tested against '' as well as null/undefined, for the same reason
        // `lookback_days` is: an empty text input is the usual source of this value, and
        // `Number('')` is 0 — which the server would read as a deliberate zero-length sleep rather
        // than as "not supplied", quietly turning the smoke test into a no-op that proves less.
        if (source.sleep_ms !== undefined && source.sleep_ms !== null && source.sleep_ms !== '') {
            payload.sleep_ms = source.sleep_ms;
        }

        _post(this.apiClient, 'sync/dummy', payload, 'triggerDummySync', cb);
    }

    /**
     * Reads one sync job back by id. This is the polling call.
     *
     * @param {String} job_id - The id returned by `triggerSync`.
     * @param {Function} cb - Receives `{ status, msg, data: { job } }`, or `{}` / `resourceNotAllowed`
     * on failure. A 404 (unknown id) also arrives as the API's own `status: false` envelope.
     * @returns {void}
     */
    getJob(job_id, cb) {
        // A 404 here means "no such job", which is an ANSWER rather than a transport failure — and
        // `_get` forwards it, along with every other envelope the API composes, for that reason.
        _get(this.apiClient, `sync/jobs/${encodeURIComponent(job_id)}`, {}, 'getJob', cb);
    }

    /**
     * Lists sync jobs with filters and pagination — the job history table.
     *
     * ──  AN EMPTY LIST IS A 200, AND THE PAYLOAD SAYS WHICH KIND OF EMPTY ─────
     * "Nothing has ever run here", "nothing matches this filter" and "syncing is switched off" are
     * three different facts that render as the same empty table. They are separated on the payload,
     * never by a refusal: `ledger_state` says whether the ledger itself is empty, `sync_disabled`
     * says whether the runner is claiming anything at all, `pagination.total` counts what the
     * current filter selects, and `warnings[]` carries the sentences. A consumer that reads only
     * `items` and `pagination.total` will print "Trigger a sync to see jobs appear here" to an
     * operator who has SYNC_DISABLED set — an instruction that cannot work.
     *
     * ── FILTERS FAIL OPEN ───────────────────────────────────────────────────────
     * An unrecognised `job_type`, `status` or `triggered_by` is DROPPED and reported in
     * `warnings[]`, never matched — a table emptied by a typo is indistinguishable from a
     * deployment that has never run anything.
     *
     * ⚠️ `dir`, not `sort_dir`. `sort` accepts `createdAt` only; anything else is warned about and
     * ignored. `limit` is clamped to 100 and `page` to the last page that has rows.
     *
     * ── THE TALLIES ARE PRE-FILTER, THE TOTAL IS NOT ────────────────────────────
     * `job_type_counts`, `status_counts` and `triggered_by_counts` label the WHOLE ledger with every
     * key present at zero, so a facet a caller did not select still shows its real size.
     * `pagination.total` answers the different question of how many rows the current filter selects.
     *
     * @param {Object} params - { page?, limit?, job_type?, status?, triggered_by?, sort?, dir? }.
     * @param {Function} cb - Receives `{ status, msg, data: { items, pagination, as_of, filters,
     * job_type_counts, status_counts, triggered_by_counts, ledger_rows, ledger_state, sync_disabled,
     * warnings } }`, or `{}` / `resourceNotAllowed` on failure. Every figure is a BARE NUMBER.
     * @returns {void}
     */
    listJobs(params, cb) {
        _get(this.apiClient, 'sync/jobs', params, 'listJobs', cb);
    }

    /**
     * Cancels a PENDING sync job.
     *
     *  POST, NOT DELETE, AND ONLY A *PENDING* JOB CAN BE CANCELLED. `gi_sync_jobs` is the audit
     * ledger of every run this deployment has ever made, so the row stays and changes state. A
     * RUNNING job is REFUSED rather than marked cancelled: nothing in this build can interrupt a
     * handler mid-flight, so a CANCELLED status over a live run is one the system cannot keep — the
     * handler finishes and overwrites it, leaving an operator who believes nothing ran looking at a
     * job that reports SUCCESS. On a sync that WRITES, that belief is the dangerous half.
     *
     *  THE THREE OUTCOMES ARRIVE AS THREE STATUS CODES, AND A LOST RACE IS NOT A SUCCESS.
     *   200 — the row moved PENDING → CANCELLED, and this call is what moved it.
     *   400 — it could not be cancelled. `data.reason` says why, and the usual why is that the
     *         runner claimed it between the click and the write. That is an ordinary outcome, not an
     *         error, but it is NEVER reported as a cancellation that happened.
     *   404 — no such job.
     * All three carry the API's own envelope, which `_post` forwards intact — the 400's `reason` is
     * the only sentence that explains a cancel the operator watched fail.
     *
     * @param {String} job_id - The job to cancel.
     * @param {Function} cb - Receives `{ status, msg, data: { cancelled, job, reason? } }`, or `{}` /
     * `resourceNotAllowed` on failure.
     * @returns {void}
     */
    cancelJob(job_id, cb) {
        _post(this.apiClient, `sync/jobs/${encodeURIComponent(job_id)}/cancel`, {}, 'cancelJob', cb);
    }

    /**
     * The sync health snapshot: what is in the database, what last ran, what is armed, and how far
     * each app's data reaches.
     *
     *  ALWAYS A 200 WHEN THE READ ITSELF WORKED, however bad the news is. A health endpoint that
     * refuses when things are unhealthy reports nothing at the exact moment it is being read.
     *
     * ── EVERY JOB TYPE IS A KEY, `null` WHERE NOTHING RAN ───────────────────────
     * `last_success_per_type` and `last_run_per_type` carry EVERY storable job type, with an
     * explicit `null` for one that has never run. An ABSENT key makes `SyncCategoryCard` fall back
     * to "Never completed successfully" — a confident negative built from a gap in our own reading —
     * over a job that runs nightly.
     *
     * ── THE PAIR IS THE POINT ───────────────────────────────────────────────────
     * The last SUCCESS and the last RUN are published side by side because a deployment whose most
     * recent run FAILED looks perfectly healthy on the success block alone. `warnings[]` carries the
     * sentence, and a STUCK_TIMEOUT gets one of TWO sentences depending on whether the row was ever
     * claimed — see the header note on that reason code.
     *
     * ── `apps[]` IS WHERE THE THREE WATERMARKS LIVE ─────────────────────────────
     * `last_synced_at` (Partner API), `last_bq_synced_at` (GA4 rollups) and
     * `last_install_attrib_synced_at` (install attribution), per app, plus the six coverage gates as
     * BARE values — `null` means never measured, and on two of the numeric gates a measured `0` is
     * the reassuring answer, so they must not be coalesced.
     *
     * ⚠️ `collections[].state` is decided by the WATERMARK, never by the row count: "we have not
     * looked" and "there is nothing there" are different facts that a count renders identically.
     *
     * `schedules[]` is read from the live timer registry rather than re-derived from configuration,
     * so it reports what is actually armed in THIS process.
     *
     * @param {Function} cb - Receives `{ status, msg, data: { as_of, collections, apps,
     * last_success_per_type, last_run_per_type, job_status_counts, schedules, runner, warnings } }`,
     * or `{}` / `resourceNotAllowed` on failure.
     * @returns {void}
     */
    getHealth(cb) {
        _get(this.apiClient, 'sync/health', {}, 'getHealth', cb);
    }
}

export default GrowthIntelSyncApiService;
