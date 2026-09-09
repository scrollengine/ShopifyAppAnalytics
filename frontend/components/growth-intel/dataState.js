import { NOT_IMPLEMENTED_CODE } from '../../API_Services/growth-intel/notImplemented';

/**
 * =============================================================================
 *  The one decoder for "what KIND of nothing is this?"
 * =============================================================================
 *
 *  Every growth-intel service can answer in five materially different ways, and
 *  FOUR OF THEM ARE EMPTY. A page that tests `if (resp && resp.status &&
 *  resp.data)` collapses all four into one, and then draws its own empty state
 *  over the top — which is how this dashboard came to publish, on a page whose
 *  endpoint was never called:
 *
 *      "Paying customers 0 · 0% of 0 stores · Attributed MRR $0.00"
 *
 *  Those are four checkable claims about the operator's business, and all four
 *  were manufactured by `Number(undefined || 0)`. The backend never said them.
 *
 *  ── THIS IS THE THIRD TIME ────────────────────────────────────────────────
 *  IMPLEMENTATION.md §4.5 documents this regression shipping twice before, and
 *  asks for it to be "checked for deliberately in review". Review did not catch
 *  the third. That is what this file is: the check, made mechanical, so that
 *  honouring the contract is less work than breaking it.
 *
 *  ── THE FIVE STATES ─────────────────────────────────────────────────────────
 *
 *    NOT_IMPLEMENTED  No route serves this yet. `msg` names the endpoint that
 *                     WOULD. Nothing about the merchant's data is known, and no
 *                     sync will ever change that — which is why the generic
 *                     "run a sync" empty state is not merely unhelpful here, it
 *                     sends the operator to do something that cannot work.
 *    NOT_CONNECTED    An upstream is unconfigured. `reason` names the missing
 *                     environment variable. This is the single most valuable
 *                     sentence the API ever emits and the easiest to discard.
 *    NEVER_SYNCED     Configured, but no sync has completed. Figures are null,
 *                     never zero. A window with no rows is an ordinary answer
 *                     ONCE A SYNC HAS RUN; before that it is not an answer.
 *    READY            A real answer. `data` is trustworthy. An empty array here
 *                     is a measured empty — the only one worth drawing.
 *    ERROR            The call failed. Distinct from NOT_CONNECTED because one
 *                     is fixed in `.env` and the other by looking at a log.
 *
 *  ── WHY A FUNCTION AND NOT A HOOK ───────────────────────────────────────────
 *  Pure, synchronous, no React import. It is called from inside axios callbacks
 *  where hooks may not run, and it is unit-testable without a renderer.
 * =============================================================================
 */

/** The five states, plus PENDING for "the first request has not answered yet".
 *  Import these rather than writing the strings — a typo in a comparison
 *  silently selects the READY branch, which draws the chart. */
export const DATA_STATE = {
    NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
    NOT_CONNECTED: 'NOT_CONNECTED',
    NEVER_SYNCED: 'NEVER_SYNCED',
    READY: 'READY',
    ERROR: 'ERROR',
    /**
     * Not a decoded state — `readDataState` never returns it. It is what a page
     * holds before its first response, and it renders as the child component's
     * own loading skeleton rather than as a banner. Distinguished from READY
     * because a READY state with `data: null` would be a lie about a measured
     * answer, and from ERROR because nothing has failed.
     */
    PENDING: 'PENDING'
};

/** Default sentences, used only when the API sent none. The API's own message is
 *  always preferred: it is the one that names the variable or the endpoint. */
const FALLBACK_REASON = {
    NOT_IMPLEMENTED: 'This backend does not serve that endpoint yet.',
    NOT_CONNECTED: 'The data source for this view could not be reached.',
    NEVER_SYNCED: 'No sync has completed yet, so this window has no answer — which is not the same as an answer of zero.',
    ERROR: 'The request failed.'
};

/**
 * True when the response is the 401 sentinel.
 *
 * IT CARRIES NO `status` KEY AT ALL (`conversionService.js`'s
 * `resourceNotAllowed`). A decoder that reads `resp.status` first classifies an
 * expired session as NOT_CONNECTED and tells the operator to go and check
 * `GCP_PROJECT_ID` — sending them into their environment file over a login that
 * simply timed out. Tested first, before anything else looks at `status`.
 *
 * @param {Object} resp - The raw service response.
 * @returns {Boolean} True when the axios interceptor has already begun the redirect to /login.
 */
const _isAuthSentinel = (resp) => Boolean(resp && resp.resource_access === 'NOT_ALLOWED');

/**
 * True when the response is the marked "no endpoint behind this" envelope.
 *
 * Checked BEFORE `status`, because that envelope deliberately sets
 * `status: false` so pre-existing `if (!resp.status)` guards keep working
 * (`notImplemented.js`). Reading `status` first therefore misfiles every stub as
 * a connection failure — the exact confusion this decoder exists to end.
 *
 * @param {Object} resp - The raw service response.
 * @returns {Boolean} True for the notImplemented envelope.
 */
const _isNotImplemented = (resp) => {
    if (!resp) {
        return false;
    }
    if (resp.not_implemented === true) {
        return true;
    }
    return Boolean(resp.error && resp.error.code === NOT_IMPLEMENTED_CODE);
};

/**
 * Separates a REFUSAL the service composed from a FAILURE it caught.
 *
 * There is no dedicated marker on the wire for "not connected", so this reads
 * the shape the backend actually produces: a deliberate refusal resolves
 * `promiseReturnResult(false, {}, {}, <message naming the missing variable>)` —
 * an EMPTY error object — while a caught exception passes the real `error`
 * through. Both arrive as HTTP 500.
 *
 * ⚠️ A heuristic, and the only one in this file. It is wrong in the safe
 * direction: mislabelling a failure as NOT_CONNECTED still renders the server's
 * own message, which is what the operator needs either way. Give the backend a
 * real `error.code` for this and delete the heuristic.
 *
 * @param {Object} resp - The raw service response, already known to be status:false.
 * @returns {Boolean} True when the service refused rather than failed.
 */
const _looksLikeRefusal = (resp) => {
    if (!resp || !resp.msg) {
        return false;
    }
    const err = resp.error;
    if (!err) {
        return true;
    }
    if (typeof err !== 'object') {
        return false;
    }
    return Object.keys(err).length === 0;
};

/**
 * Decodes any growth-intel service response into one of the five states.
 *
 * NEVER DEFAULT `data` TO `{}` OR `[]` AT A CALL SITE. That is the bug. The
 * shape returned here always has a `data` key so destructuring is safe, but it
 * is `null` in every state except READY, and a component must not be rendered
 * with it. Use `<DataStateSection>` rather than testing the state by hand.
 *
 * @param {Object} resp - The raw response handed to a service callback.
 * @param {Object} [opts]
 * @param {Function} [opts.isNeverSynced] - Extra per-endpoint test for the NEVER_SYNCED state,
 *   receiving `data`. The listing endpoints signal it with `data_state`, which this decoder reads
 *   for itself; the hook is for what it cannot see — a payload that omits its body key under
 *   `status: true`, which must not reach a chart.
 *   A HOOK THAT IS TOO WIDE IS ITS OWN DEFECT, and it is the harder one to spot because it
 *   fails on the side of drawing less. `/api/funnel` nulls `summary` for TWO different facts —
 *   never synced, and synced-but-no-rows-for-these-dates — and the page that answered both with
 *   `(d) => !d.summary` headed the second "No listing-analytics sync has run yet", directly above
 *   the server's own sentence saying a sync HAD run; it also lost the "Last BigQuery sync"
 *   timestamp, because this decoder nulls `data` in every state but READY, so the one piece of
 *   evidence against the heading went with it. Discriminate on `data_state` inside the hook and let
 *   a measured empty decode READY. Return true to force NEVER_SYNCED.
 * @returns {{state: String, data: Object|null, reason: String, endpoint: String|null,
 *   notImplemented: Boolean, ready: Boolean}} `ready` is provided so a caller can guard with one
 *   boolean without importing DATA_STATE.
 */
export const readDataState = (resp, opts = {}) => {
    const _out = (state, data, reason, endpoint = null) => ({
        state,
        data: state === DATA_STATE.READY ? data : null,
        reason,
        endpoint,
        notImplemented: state === DATA_STATE.NOT_IMPLEMENTED,
        ready: state === DATA_STATE.READY
    });

    // 1. Session gone. Checked first: this response has no `status` key to read.
    if (_isAuthSentinel(resp)) {
        return _out(DATA_STATE.ERROR, null, 'Your session has expired. Signing you back in.');
    }

    // 2. No route behind it. Checked before `status`, which the stub sets false on purpose.
    if (_isNotImplemented(resp)) {
        const endpoint = (resp.error && resp.error.expected_endpoint) || null;
        return _out(
            DATA_STATE.NOT_IMPLEMENTED,
            null,
            resp.msg || FALLBACK_REASON.NOT_IMPLEMENTED,
            endpoint
        );
    }

    // 3. `{}` — the transport failed, or a service resolved nothing at all.
    if (!resp || typeof resp !== 'object' || Object.keys(resp).length === 0) {
        return _out(DATA_STATE.ERROR, null, FALLBACK_REASON.ERROR);
    }

    // 4. status:false — a refusal (name the variable) or a failure (name the log).
    if (resp.status !== true) {
        const refused = _looksLikeRefusal(resp);
        return _out(
            refused ? DATA_STATE.NOT_CONNECTED : DATA_STATE.ERROR,
            null,
            resp.msg || (refused ? FALLBACK_REASON.NOT_CONNECTED : FALLBACK_REASON.ERROR)
        );
    }

    // 5. A success. It may still be carrying "we have not measured this yet".
    //
    // `resp.data` is read WITHOUT a `|| {}` default, which is the whole point of this file. An
    // earlier draft wrote `const data = resp.data || {}` — and that one expression reintroduces the
    // bug in the decoder built to prevent it: `status: true` with `data: null` becomes a truthy
    // empty object, decodes as READY, and every page then renders its charts and tiles over a
    // payload the server never sent. A success that carries no payload has measured nothing.
    if (resp.data === null || resp.data === undefined) {
        return _out(
            DATA_STATE.NEVER_SYNCED,
            null,
            resp.msg || FALLBACK_REASON.NEVER_SYNCED
        );
    }

    const data = resp.data;

    if (data.data_state === DATA_STATE.NEVER_SYNCED || data.items === null) {
        return _out(
            DATA_STATE.NEVER_SYNCED,
            null,
            data.unknown_reason || resp.msg || FALLBACK_REASON.NEVER_SYNCED
        );
    }

    if (typeof opts.isNeverSynced === 'function' && opts.isNeverSynced(data)) {
        return _out(
            DATA_STATE.NEVER_SYNCED,
            null,
            data.unknown_reason || resp.msg || FALLBACK_REASON.NEVER_SYNCED
        );
    }

    return _out(DATA_STATE.READY, data, '');
};

/**
 * The state a page holds before its first request resolves.
 *
 * `<DataStateSection>` renders its children in PENDING exactly as it does in
 * READY, so the child shows its own loading skeleton off the `loading` prop the
 * page already passes. It must NOT render a banner: "not connected" flashing up
 * for one frame on every navigation is how an operator learns to ignore the
 * banner that matters.
 *
 * `data` is null and `ready` is false, so a page that reads `state.data`
 * directly gets nothing rather than a stale or invented payload.
 *
 * @returns {Object} A state carrying no claim in either direction.
 */
export const pendingDataState = () => ({
    state: DATA_STATE.PENDING,
    data: null,
    reason: '',
    endpoint: null,
    notImplemented: false,
    ready: false
});

export default readDataState;
