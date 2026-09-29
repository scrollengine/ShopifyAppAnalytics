import { Banner, BlockStack, Text } from '@shopify/polaris';

import { permissionLabel } from '../../utils/permissions';
import { cardShell } from './cardShell';
import { DATA_STATE } from './dataState';

/**
 * =============================================================================
 *  Renders the children, or renders WHY it will not.
 * =============================================================================
 *
 *  THE POINT IS THE `else`. Not that the banner is pretty — that the chart,
 *  the table and the KPI tiles are NOT MOUNTED unless the state is READY.
 *
 *  An explanatory banner above an empty chart is worse than useless: the reader
 *  sees the zeros, the zeros are concrete, and the sentence above them is not.
 *  `apps/index.js` already worked this out and says so in its own words —
 *  "An empty KPI tile and an empty chart are indistinguishable from an app with
 *  no installs" — and then draws nothing in their place. This is that decision,
 *  hoisted out of the one page that made it.
 *
 *  ── WHAT EACH STATE LOOKS LIKE ──────────────────────────────────────────────
 *      PENDING          children (their own loading skeleton). No banner: a
 *                       banner that flashes on every navigation trains the
 *                       operator to ignore banners.
 *      READY            children.
 *      NOT_IMPLEMENTED  warning banner naming the endpoint that would serve it.
 *      FORBIDDEN        info banner: "Restricted — your role does not include
 *                       <permission>". Info, not critical: nothing is broken,
 *                       and nothing the reader can fix. Never the empty state,
 *                       never the chart — the data behind it may be full, and a
 *                       blank section would read as "there is none". (The
 *                       session re-reads the role on its own: the axios client
 *                       reports every 403 to it, so this component need not.)
 *      NOT_CONNECTED    warning banner carrying the server's own sentence,
 *                       which names the missing environment variable.
 *      NEVER_SYNCED     info banner — nothing is broken, nothing has run yet.
 *      ERROR            critical banner.
 *
 *  ── USAGE ───────────────────────────────────────────────────────────────────
 *      const [cohort, setCohort] = useState(pendingDataState());
 *      // ...
 *      API.getInstallCohort(params, (resp) => { setCohort(readDataState(resp)); });
 *      // ...
 *      <DataStateSection state={cohort} title="Stores installed in this window" bare>
 *          <InstallCohortTable data={cohort.data} loading={loading} bare />
 *      </DataStateSection>
 *
 *  `bare` is forwarded to `cardShell` so this drops into a slot inside a shared
 *  Card without drawing a second border. Use the SAME `bare` the child would
 *  have used — the wrapper replaces the child on the non-ready paths, so if the
 *  two disagree the border appears only on the days there is no data, which is
 *  the single hardest case to notice.
 * =============================================================================
 */

/** Polaris tone per state. NEVER_SYNCED is `info`, deliberately: a fresh install
 *  that has not synced yet is working correctly, and a warning colour there
 *  reads as a fault the operator must chase. */
const TONE = {
    [DATA_STATE.NOT_IMPLEMENTED]: 'warning',
    [DATA_STATE.FORBIDDEN]: 'info',
    [DATA_STATE.NOT_CONNECTED]: 'warning',
    [DATA_STATE.NEVER_SYNCED]: 'info',
    [DATA_STATE.ERROR]: 'critical'
};

/** Banner heading per state. Says what is true of the DATA, never of the
 *  merchant's business — "no installs recorded" is a claim, "this endpoint is
 *  not built" is a fact. */
const HEADING = {
    [DATA_STATE.NOT_IMPLEMENTED]: 'Not built yet',
    [DATA_STATE.FORBIDDEN]: 'Restricted',
    [DATA_STATE.NOT_CONNECTED]: 'Data source not connected',
    [DATA_STATE.NEVER_SYNCED]: 'Nothing synced yet',
    [DATA_STATE.ERROR]: 'This could not be loaded'
};

/**
 * The sentence that follows the server's own message, per state.
 *
 * Kept apart from the server's `reason` so the two are never confused: `reason`
 * is what the API said and is the authoritative half; this is orientation for a
 * reader who has just been told a thing they did not ask about.
 *
 * @param {String} state - One of DATA_STATE.
 * @param {String|null} endpoint - The route that would serve it, when known.
 * @returns {String} A sentence, or '' when the server's message stands alone.
 */
const _guidance = (state, endpoint) => {
    if (state === DATA_STATE.NOT_IMPLEMENTED) {
        const route = endpoint ? `${endpoint} ` : '';
        return `Nothing is drawn in its place. ${route}does not exist in this backend, so no sync, date range or filter will fill it — the data may well be on disk already.`;
    }
    if (state === DATA_STATE.NOT_CONNECTED) {
        return 'Set the variable named above and restart the backend. Nothing is drawn in the meantime, because an empty chart here would be a claim about your listing rather than about your configuration.';
    }
    if (state === DATA_STATE.NEVER_SYNCED) {
        return 'This is not a reading of zero — it is the absence of a reading. Run a sync from the Sync page and it will fill in.';
    }
    if (state === DATA_STATE.FORBIDDEN) {
        return 'Nothing is drawn in its place: this says nothing about the data, only about what your role may read. An Owner or Admin can change your role.';
    }
    return '';
};

/**
 * The banner heading for a state.
 *
 * FORBIDDEN names the permission in the heading itself, because it is the whole of the message: the
 * reader needs to know WHICH access is missing, and a heading of just "Restricted" leaves them to
 * find that in the small print.
 *
 * @param {String} state - One of DATA_STATE.
 * @param {String|null} permission - The key a FORBIDDEN answer named.
 * @returns {String}
 */
const _heading = (state, permission) => {
    if (state === DATA_STATE.FORBIDDEN) {
        return `${HEADING[DATA_STATE.FORBIDDEN]} — your role does not include ${permissionLabel(permission)}`;
    }
    return HEADING[state] || HEADING[DATA_STATE.ERROR];
};

/**
 * Gates a section of a page on its data state.
 *
 * @param {Object} props
 * @param {Object} props.state - The object from `readDataState()` / `pendingDataState()`.
 * @param {String} [props.title] - Section heading, shown above the banner so the reader knows which
 *   part of the page is missing. Omit inside a slot that already has one.
 * @param {Boolean} [props.bare=false] - Forwarded to `cardShell`; true when the caller supplies the Card.
 * @param {String} [props.cardPadding] - Forwarded to `cardShell`.
 * @param {Boolean} [props.padWhenBare=true] - Forwarded to `cardShell`.
 * @param {Boolean} [props.loading=false] - True while a request for this section is actually in
 *   flight. It is what separates "the answer is coming" from "no request was ever made", and only
 *   the first of those may render the child. See the PENDING note below.
 * @param {React.ReactNode} props.children - Rendered in READY, and in PENDING only while `loading`.
 * @returns {React.ReactNode}
 */
export const DataStateSection = ({
    state,
    title,
    bare = false,
    cardPadding,
    padWhenBare = true,
    loading = false,
    children
}) => {
    const current = (state && state.state) || DATA_STATE.ERROR;

    if (current === DATA_STATE.READY) {
        return children;
    }

    // PENDING IS TWO DIFFERENT SITUATIONS AND ONLY ONE OF THEM MAY DRAW.
    //
    // A request in flight is transient, and the child's own loading skeleton is the right thing to
    // show. But every page here early-returns from its fetch when no partner app is selected —
    // `if (!appId || !appHydrated) return;` — WITHOUT setting `loading`. That leaves the section in
    // PENDING permanently, and a child handed `data: null` does not skeleton: it draws its own empty
    // state. On the Revenue → By country tab that is the sentence "No paying customers", shown to an
    // operator who has simply not picked an app yet.
    //
    // So PENDING renders the child only while a request is genuinely outstanding, and otherwise
    // renders nothing at all. Nothing is always safe; a chart over a payload that was never
    // requested is the exact failure this component exists to prevent.
    if (current === DATA_STATE.PENDING) {
        return loading ? children : null;
    }

    const wrap = cardShell(bare, { cardPadding, padWhenBare });
    const guidance = _guidance(current, state && state.endpoint);
    const permission = (state && state.permission) || null;

    // For FORBIDDEN the heading already names the permission, from the server's own structured field.
    // The server's sentence is shown only when it named none — then it is the only detail there is.
    let reasonText = (state && state.reason) || '';
    if (current === DATA_STATE.FORBIDDEN && permission) {
        reasonText = '';
    }

    return wrap(
        <BlockStack gap="300">
            {title ? <Text as="h3" variant="headingMd">{title}</Text> : null}
            <Banner tone={TONE[current] || 'critical'} title={_heading(current, permission)}>
                <BlockStack gap="200">
                    {/* The server's own sentence, verbatim. It is the half that names the missing
                        environment variable or the missing route, and paraphrasing it here would
                        cost the operator the one string they can act on. */}
                    {reasonText ? <Text as="p" variant="bodySm">{reasonText}</Text> : null}
                    {guidance ? <Text as="p" variant="bodySm" tone="subdued">{guidance}</Text> : null}
                </BlockStack>
            </Banner>
        </BlockStack>
    );
};

export default DataStateSection;
