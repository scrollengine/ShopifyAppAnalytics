import { Badge, Banner, BlockStack, Box, Button, Card, Divider, InlineGrid, InlineStack, Page, Text, TextField } from '@shopify/polaris';
import { useCallback, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import SideNavBar from '../../components/sideNavBar';
import LoaderContext from '../../contexts/loaderContext';
import { APPS_STATE, useGrowthIntel } from '../../contexts/growthIntelContext';
import GrowthIntelFunnelApiService from '../../API_Services/growth-intel/funnelService';
import GrowthIntelHealthApiService from '../../API_Services/growth-intel/healthService';
import GrowthIntelMetaApiService from '../../API_Services/growth-intel/metaService';
import GrowthIntelSyncApiService from '../../API_Services/growth-intel/syncService';
import ManualSyncButton from '../../components/growth-intel/ManualSyncButton';
import SyncCategoryCard from '../../components/growth-intel/SyncCategoryCard';
import SyncJobHistoryTable from '../../components/growth-intel/SyncJobHistoryTable';
import SyncStatusBadge from '../../components/growth-intel/SyncStatusBadge';
import { SYNC_CATEGORIES } from '../../components/growth-intel/syncCategories';
import { DASHBOARD_ROUTES } from '../../utils/dashboardRoutes';

/**
 * =============================================================================
 *  Sync & status — is data flowing, when did it last run, and what does it cover?
 * =============================================================================
 *
 *  Three questions, in the order an operator actually asks them:
 *
 *    1. IS THE BACKEND ALIVE AND HOLDING ANYTHING?  `GET /healthz`
 *    2. HOW FAR BACK DOES THE DATA REACH?           `GET /api/meta/coverage`
 *    3. WHAT HAS RUN, AND CAN I FORCE ONE?          `GET  /api/sync/health`
 *                                                   `GET  /api/sync/jobs`
 *                                                   `GET  /api/sync/jobs/:job_id`
 *                                                   `POST /api/sync/partner` (+ 3 more triggers)
 *
 *  ──  COVERAGE IS THE MOST IMPORTANT BLOCK ON THIS SCREEN ───────────────────
 *  Every figure this dashboard publishes is a fold over the synced Partner API
 *  history, and a missing row does not announce itself: a month that was never
 *  pulled and a month in which nothing happened produce the identical empty
 *  result set. Coverage is the only place that distinguishes them, so it is
 *  rendered with a sentence of plain English per field rather than as a table of
 *  bare numbers — a reader who sees `event_history_gap_days: 34` and does not
 *  know what it implies has learned nothing.
 *
 *  Each coverage field arrives in a `{ value, confidence, source, reason? }`
 *  envelope, and `value: null` means NEVER MEASURED. It is rendered as `—` with
 *  its reason, never as `0` — which on two of these fields is the REASSURING
 *  value (`event_history_gap_days: 0` asserts the history has no holes at all;
 *  `charge_link_absent_pct: 0` asserts every row is linked to a charge).
 *
 *  ── WHERE EACH "LAST SUCCESS" COMES FROM ────────────────────────────────────
 *  `GET /api/sync/health` is the authority now, and it is read once per page load
 *  (and again after any job finishes). It publishes THREE things this screen
 *  could not previously know:
 *
 *    · `last_success_per_type[JOB_TYPE]` — every storable type is a key, with an
 *      explicit `null` where nothing has run. An ABSENT key would make
 *      `SyncCategoryCard` fall back to "Never completed successfully" over a job
 *      that runs nightly, which is a confident negative built from a gap in our
 *      own reading.
 *    · `apps[]` — each app's three watermarks: `last_synced_at` (Partner API),
 *      `last_bq_synced_at` (GA4 rollups) and `last_install_attrib_synced_at`
 *      (install attribution). The third had NO reader in the build before this
 *      one, which is why the attribution card used to report `—` with the
 *      sentence "no endpoint reports this one". It does now, and that sentence
 *      would be false on screen while hiding a real timestamp.
 *    · `warnings[]` — including the two different STUCK_TIMEOUT sentences, which
 *      take OPPOSITE remedies. See `syncService`'s header.
 *
 *   A NULL WATERMARK FROM `sync/health` IS A *KNOWN* NEVER, and the card may
 *  say so. A null because the health read itself failed is NOT, and the card gets
 *  `lastSuccessUnknownReason` instead. Those are different claims and the page
 *  keeps them apart deliberately — every fallback below is written so that a
 *  failure to READ never renders as a measurement of "never".
 *
 *  ── EVERY JOB WITH A HANDLER NOW HAS A TRIGGER ROUTE ────────────────────────
 *  `SYNC_CATEGORIES` is the registry of every job the module knows about, and
 *  FOUR of them can be started from here: the Partner API sync, the GA4 listing
 *  rollups, install attribution and the infrastructure smoke test. The remaining
 *  three (keyword rankings, competitor snapshots, the weekly LLM briefing) have
 *  no route AND no handler, so they are named in a note rather than given buttons
 *  that always fail.
 *
 *  ── THE GA4 SYNCS ARE OPTIONAL, AND MUST SAY SO RATHER THAN FAIL ─────────
 *  BigQuery is a SECOND upstream with its own credentials, and an install that
 *  never configured it is a normal install. Nothing on the enqueue path checks
 *  that: `POST /api/sync/bigquery` happily returns a queued job, which the runner
 *  then fails with a message naming the missing environment variable. A button
 *  wired straight to it would look like it worked and quietly manufacture FAILED
 *  rows.
 *
 *  So this page ESTABLISHES the tier's state first, from `GET /api/funnel` — the
 *  read endpoint whose refusal carries that same named message (over HTTP 500,
 *  which `funnelService` deliberately passes through intact). Four outcomes, and
 *  each drives the buttons differently:
 *
 *    connected — `status: true`. Buttons live. `last_bq_synced_at` arrives in the
 *      same payload and feeds the card's last-run, and a null one THERE is a
 *      known "never synced" rather than an unknown.
 *    not_configured — `status: false` and the message names a BigQuery variable.
 *      Buttons DISABLED, carrying that message plus what setting the variables
 *      unlocks. Offering a button that queues a job which cannot succeed is not
 *      an affordance, it is a trap.
 *    loading — the probe is in flight. Disabled, briefly, saying so.
 *    unknown — any other failure. Buttons LEFT ENABLED with a caution: we could
 *      not read the tier's state, and disabling on that would block a legitimate
 *      sync over an assumption about our own blind spot.
 *
 *  ⚠️ The BigQuery probe is still worth making even though `sync/health` reports
 *  `last_bq_synced_at` directly: the watermark says when the rollups last ran,
 *  and the probe says whether they COULD run now. An app that synced last month
 *  and had its credentials removed yesterday has a fresh watermark and a dead
 *  tier, and only the probe can tell you the second half.
 * =============================================================================
 */

const FUNNEL_API = new GrowthIntelFunnelApiService();
const HEALTH_API = new GrowthIntelHealthApiService();
const META_API = new GrowthIntelMetaApiService();
const SYNC_API = new GrowthIntelSyncApiService();

/**
 * The job types this dashboard can actually START — one trigger route each.
 *
 * Mirrors `RUNNABLE_JOB_TYPES` in the backend's `modules/sync/constants/sync.constants.ts` exactly:
 * every job type with a handler on the server now has an HTTP trigger, `DUMMY` included. Everything
 * else in `SYNC_CATEGORIES` is inventory — a job type with no route enqueues nowhere, and a button
 * for it would fail on every click.
 */
const PARTNER_JOB_TYPE = 'PARTNER_SYNC';
const BIGQUERY_JOB_TYPE = 'BIGQUERY_SYNC';
const ATTRIBUTION_JOB_TYPE = 'INSTALL_ATTRIBUTION_SYNC';
/**
 * The smoke path. GLOBAL scope — it takes no partner app, because it touches no data source.
 *
 * Worth a button precisely because it proves NOTHING about the data: when a real sync produces no
 * rows, "the runner never claimed the job" and "the runner ran and the upstream was empty" look
 * identical from this page, and they have completely different fixes. This one isolates the first.
 */
const DUMMY_JOB_TYPE = 'DUMMY';

/** Cards are rendered for these, in this order. Everything else is listed in a note. */
const TRIGGERABLE_JOB_TYPES = [PARTNER_JOB_TYPE, BIGQUERY_JOB_TYPE, ATTRIBUTION_JOB_TYPE, DUMMY_JOB_TYPE];

/**
 * The environment variables the backend names when the BigQuery tier is not configured.
 *
 * These three strings are how "not connected" is told apart from every other refusal the funnel
 * endpoint can answer with ('Partner app not found.', 'partner_app_id is required.', a thrown
 * read). The refusal is built by `describeBigQueryConfigGap` on the server and always names at
 * least one of them; no other message on that path mentions any.
 *
 * ⚠️ `GOOGLE_APPLICATION_CREDENTIALS` is deliberately absent. It is the ALTERNATIVE to
 * `GCP_SERVICE_ACCOUNT_JSON`, not a fourth requirement — it appears inside the credentials clause of
 * the server's message, so matching on it would report it as "missing" every time the pair is
 * unsatisfied and imply both must be set. The message itself explains the either/or.
 */
const BIGQUERY_ENV_KEYS = ['GCP_PROJECT_ID', 'BQ_DATASET', 'GCP_SERVICE_ACCOUNT_JSON'];

/** What the GA4 tier buys, in the reader's terms. Shown wherever the buttons are refused. */
const BIGQUERY_UNLOCKS = 'Connecting it fills the Traffic Sources page (source/medium and country breakdowns) and the listing-view steps at the top of the Funnel page — views, install clicks, installs. Until then those read as unavailable rather than as zero.';

/** Above this many event-free days, a gap is more likely a missed sync than a quiet stretch. */
const GAP_WARNING_DAYS = 7;

/** Above this percentage of unlinked charge rows, per-subscription figures stop being trustworthy. */
const CHARGE_LINK_WARNING_PCT = 5;

/** Readiness state → Polaris Badge tone. `degraded` is critical: the datastore could not be read. */
const HEALTH_STATE_TONE = {
    ready: 'success',
    warming: 'attention',
    degraded: 'critical'
};

/** Confidence → Polaris Badge tone. `unknown` gets the neutral tone; it is not a failure, it is a gap. */
const CONFIDENCE_TONE = {
    measured: 'success',
    derived: 'info',
    estimated: 'attention',
    unknown: 'new'
};

/**
 * A timestamp with its time of day, or `—`.
 *
 * @param {String|Date} value - An ISO string or Date.
 * @returns {String} Localised date and time, or the em dash.
 */
const _fmtWhen = (value) => {
    if (!value) {
        return '—';
    }
    try {
        return new Date(value).toLocaleString();
    } catch (e) {
        return String(value);
    }
};

/**
 * A duration in whole days.
 *
 *  A measured `0` renders as `0 days`, never as `—`. Zero here is a real answer — "no hole at all"
 * — and it is the best answer the field can carry, so hiding it behind a dash would invert it.
 *
 * @param {Number} value - Whole days.
 * @returns {String}
 */
const _fmtDays = (value) => {
    const n = Number(value);
    if (Number.isNaN(n)) {
        return '—';
    }
    if (n === 1) {
        return '1 day';
    }
    return `${n.toLocaleString()} days`;
};

/**
 * A percentage already expressed on a 0–100 scale (not a fraction).
 *
 * @param {Number} value - 0–100.
 * @returns {String}
 */
const _fmtPct = (value) => {
    const n = Number(value);
    if (Number.isNaN(n)) {
        return '—';
    }
    return `${n.toFixed(1)}%`;
};

/**
 * A duration in seconds, rendered as the largest sensible unit.
 *
 * @param {Number} seconds - Whole seconds.
 * @returns {String}
 */
const _fmtUptime = (seconds) => {
    const n = Number(seconds);
    if (Number.isNaN(n) || n < 0) {
        return '—';
    }
    if (n < 60) {
        return `${Math.floor(n)}s`;
    }
    if (n < 3600) {
        return `${Math.floor(n / 60)}m`;
    }
    if (n < 86400) {
        return `${Math.floor(n / 3600)}h`;
    }
    return `${Math.floor(n / 86400)}d`;
};

/**
 * A job's run time, or `—` while it has not finished.
 *
 * @param {Number} ms - Milliseconds.
 * @returns {String}
 */
const _fmtDuration = (ms) => {
    if (ms === null || ms === undefined) {
        return '—';
    }
    const n = Number(ms);
    if (Number.isNaN(n)) {
        return '—';
    }
    if (n < 1000) {
        return `${n}ms`;
    }
    return `${(n / 1000).toFixed(1)}s`;
};

/**
 * Reads the value out of a confidence envelope.
 *
 *  Returns `null` for BOTH a missing envelope and a `value: null` inside one, because they mean the
 * same thing to a reader — nobody has measured this. The distinction that must survive is
 * `null` versus `0`, and that one is preserved: a real `0` comes back as `0`.
 *
 * @param {Object} envelope - `{ value, confidence, source, reason?, caveat? }`.
 * @returns {*} The value, or null.
 */
const _envValue = (envelope) => {
    if (!envelope) {
        return null;
    }
    if (envelope.value === undefined || envelope.value === null) {
        return null;
    }
    return envelope.value;
};

/**
 * What a measured event-history gap actually implies, in words.
 *
 * @param {Number|null} days - The widest run of event-free days, or null when never measured.
 * @returns {String} A sentence for the reader.
 */
const _gapMeaning = (days) => {
    if (days === null) {
        return 'Never measured. That is not the same as "there are no gaps" — nobody has checked, so the history could have holes anywhere in it.';
    }
    if (days <= 0) {
        return 'No hole at all: every day carrying an event sits next to another one. This is a real measurement and it is the best answer the field can give.';
    }
    if (days < GAP_WARNING_DAYS) {
        return `The longest run of event-free days inside the covered window is ${days}. For a small app that is usually a genuinely quiet stretch rather than a missing pull.`;
    }
    return `The longest run of event-free days inside the covered window is ${days}. A hole that wide is more likely a sync that never ran than a fortnight in which nobody installed or uninstalled anything — and every figure folded over events (installs, uninstalls, the trial ladder, and the MRR built on top of it) silently under-reports across that stretch. Run a full lifetime re-sync before trusting any period that spans it.`;
};

/**
 * What a missing charge link implies.
 *
 * @param {Number|null} pct - 0–100, or null when never measured.
 * @returns {String} A sentence for the reader.
 */
const _absentMeaning = (pct) => {
    if (pct === null) {
        return 'Never measured, so it is unknown whether events can be tied to the money they produced.';
    }
    if (pct <= 0) {
        return 'Every row that could carry a charge id does carry one, so each subscription event can be tied to the payouts it produced.';
    }
    if (pct < CHARGE_LINK_WARNING_PCT) {
        return `${_fmtPct(pct)} of the rows that should carry a charge id carry none at all. Those rows cannot be attributed to a subscription; a small share is normal for older history.`;
    }
    return `${_fmtPct(pct)} of the rows that should carry a charge id carry none at all — the link was never captured. Anything computed per subscription (plan mix, trial-to-paid, per-store revenue) is blind to that share, and reports it as absent rather than as zero.`;
};

/**
 * What an unresolved charge link implies.
 *
 * @param {Number|null} pct - 0–100, or null when never measured.
 * @returns {String} A sentence for the reader.
 */
const _unresolvedMeaning = (pct) => {
    if (pct === null) {
        return 'Never measured, so it is unknown whether the charge ids that were captured actually match anything.';
    }
    if (pct <= 0) {
        return 'Every captured charge id matches a record on the other side. The event↔payout bridge holds.';
    }
    return `${_fmtPct(pct)} of the captured charge ids match nothing on the other side — the link is dangling rather than missing. That normally means one half of the history reaches further back than the other; a lifetime re-sync is what closes it.`;
};

/**
 * The most recent SUCCESS of one job type among the jobs this tab watched to completion.
 *
 * `sessionJobs` is newest-first, so the first match is the latest. This is a statement about THIS
 * BROWSER TAB and nothing more, and it is NOT the source of truth — `GET /api/sync/health` is. It
 * wins where it has an answer only because it is fresher by one poll interval: it is the run the
 * operator just watched, recorded before the health read that would report it has been re-issued.
 *
 * ⚠️ A MISS HERE MEANS NOTHING AT ALL. `null` is "this tab has not watched one", never "none has
 * run", so every caller falls back to a watermark rather than to a claim.
 *
 * @param {Array} jobs - The session job list, newest first.
 * @param {String} jobType - The job type to look for.
 * @returns {Object|null} The job row, or null.
 */
const _latestSessionSuccess = (jobs, jobType) => {
    const match = jobs.find((job) => job.job_type === jobType && job.status === 'SUCCESS' && job.completed_at);
    if (!match) {
        return null;
    }
    return match;
};

/**
 * The newest successful run of one job type, as `GET /api/sync/health` reports it.
 *
 *  `null` HERE IS A *KNOWN* NEVER, and the caller may render "Never completed successfully" from
 * it — the endpoint publishes every job type as a key precisely so that an absent one cannot be
 * mistaken for one that has not run. `null` because the health READ failed is a different fact, and
 * the caller must check `healthState` before it decides which of the two it is holding.
 *
 * ⚠️ CROSS-APP. `last_success_per_type` is "the newest run of this type anywhere", not "for the app
 * selected in the side nav" — which is why the cards below prefer this app's own watermark where one
 * exists and label the scope they are actually showing.
 *
 * @param {Object|null} health - The `sync/health` payload.
 * @param {String} jobType - One of the storable job-type literals.
 * @returns {Object|null} `{ job_id, completed_at, duration_ms, triggered_by }`, or null.
 */
const _healthLastSuccess = (health, jobType) => {
    if (!health || !health.last_success_per_type) {
        return null;
    }
    const row = health.last_success_per_type[jobType];
    if (!row || !row.completed_at) {
        return null;
    }
    return row;
};

/**
 * The selected app's row out of `sync/health`'s `apps[]` — where all three watermarks live.
 *
 * `last_synced_at`, `last_bq_synced_at` and `last_install_attrib_synced_at` are per-app and are the
 * only app-scoped answer to "when did this last run". The third of them had no reader at all before
 * this endpoint existed.
 *
 * @param {Object|null} health - The `sync/health` payload.
 * @param {String} appId - The selected partner app id.
 * @returns {Object|null} The app's health row, or null.
 */
const _healthAppRow = (health, appId) => {
    if (!health || !Array.isArray(health.apps) || !appId) {
        return null;
    }
    return health.apps.find((row) => row && row.partner_app_id === appId) || null;
};

/**
 * One coverage measurement: the number, how well it is known, and what it implies.
 *
 * @param {Object} props
 * @param {String} props.label - The measurement's name in the reader's language.
 * @param {Object} [props.envelope] - `{ value, confidence, source, reason?, caveat? }`.
 * @param {Function} props.format - Formats a non-null value.
 * @param {String} props.note - The plain-English meaning. Always shown; it is the point of the row.
 * @returns {JSX.Element}
 */
const CoverageRow = ({ label, envelope, format, note }) => {
    const value = _envValue(envelope);

    let confidence = 'unknown';
    if (envelope && envelope.confidence) {
        confidence = envelope.confidence;
    }
    let tone = CONFIDENCE_TONE[confidence];
    if (!tone) {
        tone = 'new';
    }

    //  `—` for a null, the formatter for anything else — INCLUDING a real 0.
    let valueText = '—';
    if (value !== null) {
        valueText = format(value);
    }

    let sourceText = '';
    if (envelope && envelope.source) {
        sourceText = `Source: ${envelope.source}`;
    }
    if (value === null && envelope && envelope.reason) {
        sourceText = envelope.reason;
    }
    if (value === null && (!envelope || !envelope.reason)) {
        sourceText = 'This install has never reported a value for this measurement.';
    }

    let caveatMarkup = null;
    if (envelope && envelope.caveat) {
        caveatMarkup = <Text as="span" variant="bodyXs" tone="subdued">{envelope.caveat}</Text>;
    }

    return (
        <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center" wrap>
                <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
                <Badge tone={tone}>{confidence}</Badge>
            </InlineStack>
            <Text as="span" variant="headingLg" numeric>{valueText}</Text>
            <Text as="span" variant="bodySm">{note}</Text>
            <Text as="span" variant="bodyXs" tone="subdued">{sourceText}</Text>
            {caveatMarkup}
        </BlockStack>
    );
};

/**
 * One row of the session job list.
 *
 * @param {Object} props
 * @param {Object} props.job - A serialized `gi_sync_job` row.
 * @returns {JSX.Element}
 */
const SessionJobRow = ({ job }) => {
    //  `??`, not `||`. `attempts` is a claim count and a genuine `0` means the row was never
    // claimed — `|| 1` would render that as a first attempt, which is the opposite of what it says.
    let attemptsText = '—';
    if (job.attempts !== null && job.attempts !== undefined) {
        attemptsText = String(job.attempts);
    }

    let outcomeMarkup = null;
    if (job.error_message) {
        outcomeMarkup = <Text as="span" variant="bodySm" tone="critical">{job.error_message}</Text>;
    }
    if (!job.error_message && job.result_summary && Object.keys(job.result_summary).length > 0) {
        outcomeMarkup = (
            <Text as="span" variant="bodyXs" tone="subdued">{JSON.stringify(job.result_summary)}</Text>
        );
    }

    return (
        <BlockStack gap="100">
            <InlineStack align="space-between" blockAlign="center" gap="400" wrap>
                <InlineStack gap="200" blockAlign="center" wrap>
                    <Text as="span" variant="bodyMd" fontWeight="semibold">{job.job_type}</Text>
                    <SyncStatusBadge status={job.status} />
                </InlineStack>
                <Text as="span" variant="bodySm" tone="subdued">
                    {`Finished ${_fmtWhen(job.completed_at)} · ran for ${_fmtDuration(job.duration_ms)}`}
                </Text>
            </InlineStack>
            <Text as="span" variant="bodyXs" tone="subdued">
                {`${job.job_id} · triggered by ${job.triggered_by || '—'} · attempts ${attemptsText}`}
            </Text>
            {outcomeMarkup}
        </BlockStack>
    );
};

/**
 * The Sync & status screen: backend readiness, data coverage, the sync console, and job history.
 *
 * Takes no props — the partner app every coverage figure is scoped by comes from
 * `growthIntelContext`, chosen in the side nav.
 *
 * @returns {JSX.Element} The framed page.
 */
const SyncStatusPage = () => {
    const router = useRouter();
    const { showToast, toastMarkup } = useContext(LoaderContext) || {};
    const { appId, selectedApp, apps, appsState, appsError, refreshApps, hydrated } = useGrowthIntel();

    const [health, setHealth] = useState(null);
    // 'loading' · 'answered' (200 or 503, both real readings) · 'silent' (nothing responded at all).
    const [healthState, setHealthState] = useState('loading');

    const [coverage, setCoverage] = useState(null);
    // 'idle' (no app selected) · 'loading' · 'ready' · 'error'.
    const [coverageState, setCoverageState] = useState('idle');
    const [coverageReason, setCoverageReason] = useState('');

    // `GET /api/sync/health` — the authority for every "last success" on this screen.
    // 'loading' · 'ready' · 'error'. NEVER collapse the last two: a null watermark from a READ that
    // worked is a known "never ran", and a null from one that failed is not a measurement at all.
    const [syncHealth, setSyncHealth] = useState(null);
    const [syncHealthState, setSyncHealthState] = useState('loading');
    const [syncHealthReason, setSyncHealthReason] = useState('');

    const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
    const [sessionJobs, setSessionJobs] = useState([]);
    const [lookupId, setLookupId] = useState('');
    const [lookupBusy, setLookupBusy] = useState(false);

    // The BigQuery tier, established from GET /api/funnel — see the file header.
    // 'idle' (no app selected) · 'loading' · 'connected' · 'not_configured' · 'unknown'.
    const [bqState, setBqState] = useState('idle');
    const [bqMessage, setBqMessage] = useState('');
    const [bqMissingEnv, setBqMissingEnv] = useState([]);
    // The BIGQUERY_SYNC watermark, readable only while the tier answers. Null is ambiguous on its
    // own — pair it with `bqState` before deciding whether it means "never" or "we cannot tell".
    const [bqLastSyncedAt, setBqLastSyncedAt] = useState(null);

    /**
     * Reads `GET /healthz`.
     *
     *  A 503 is an ANSWER, not a failure — `warming` is the normal state of a fresh install, and
     * `healthService` hands the 503 body back as data. Only an empty envelope means nothing
     * responded, and that is the one case reported as unreachable.
     *
     * @returns {void}
     */
    const loadHealth = useCallback(() => {
        setHealthState('loading');
        HEALTH_API.getSnapshot((resp) => {
            if (!resp || !resp.data || !resp.data.state) {
                setHealth(null);
                setHealthState('silent');
                return;
            }
            setHealth(resp.data);
            setHealthState('answered');
        });
    }, []);

    /**
     * Reads `GET /api/meta/coverage` for the selected app.
     *
     * @returns {void}
     */
    const loadCoverage = useCallback(() => {
        if (!appId || !hydrated) {
            setCoverage(null);
            setCoverageState('idle');
            return;
        }
        setCoverageState('loading');
        META_API.getCoverage({ partner_app_id: appId }, (resp) => {
            if (!resp || !resp.status || !resp.data) {
                setCoverage(null);
                let reason = 'The coverage request did not come back. Check the browser console and the server logs.';
                if (resp && resp.msg) {
                    reason = resp.msg;
                }
                setCoverageReason(reason);
                setCoverageState('error');
                return;
            }
            setCoverage(resp.data);
            setCoverageState('ready');
        });
    }, [appId, hydrated]);

    /**
     * Establishes whether the BigQuery tier is connected, from `GET /api/funnel`.
     *
     * THE ONLY HONEST WAY TO ANSWER THIS FROM THE BROWSER. Nothing publishes the tier's
     * configuration directly, and the trigger endpoint accepts a job whether or not it can run —
     * so asking the enqueue path would always answer "yes". The funnel read refuses with the
     * server's own message naming the missing variable, which is both the signal AND the text an
     * operator needs.
     *
     * `period_days: 1` because the answer wanted is the ENVELOPE, not the numbers: a one-day window
     * is the cheapest read that still carries `data_state` and `last_bq_synced_at`. The endpoint
     * queries Mongo only — it can never start a billed BigQuery scan.
     *
     * @returns {void}
     */
    const loadBigQueryProbe = useCallback(() => {
        if (!appId || !hydrated) {
            setBqState('idle');
            setBqMessage('');
            setBqMissingEnv([]);
            setBqLastSyncedAt(null);
            return;
        }
        setBqState('loading');
        FUNNEL_API.getFunnel({ partner_app_id: appId, period_days: 1 }, (resp) => {
            if (resp && resp.status && resp.data) {
                // A null watermark here is a KNOWN never-synced — the server read the app row and
                // told us — so it is passed through as-is rather than reported as unknown. It is a
                // FALLBACK now rather than the only source: `sync/health` publishes the same field
                // on `apps[]` and does so whether or not the tier is reachable, which is the answer
                // the card prefers.
                setBqLastSyncedAt(resp.data.last_bq_synced_at || null);
                setBqMessage('');
                setBqMissingEnv([]);
                setBqState('connected');
                return;
            }

            setBqLastSyncedAt(null);

            let msg = '';
            if (resp && resp.msg) {
                msg = resp.msg;
            }
            const missing = BIGQUERY_ENV_KEYS.filter((key) => msg.indexOf(key) !== -1);
            if (missing.length > 0) {
                setBqMissingEnv(missing);
                setBqMessage(msg);
                setBqState('not_configured');
                return;
            }

            // Anything else — a 401 mid-redirect, a thrown read, an app the API does not know. We
            // did not learn the tier's state, and claiming either answer would be a guess. The
            // buttons stay live; the note says why.
            setBqMissingEnv([]);
            let reason = 'The listing-analytics endpoint did not answer, so whether BigQuery is connected could not be established.';
            if (msg) {
                reason = msg;
            }
            setBqMessage(reason);
            setBqState('unknown');
        });
    }, [appId, hydrated]);

    /**
     * Reads `GET /api/sync/health` — the last run of every job type, every app's watermarks, what is
     * armed, and how many rows each collection holds.
     *
     *  NOT SCOPED BY THE SELECTED APP, and deliberately so: the collection states, the schedule
     * registry and the per-type last-run block are properties of the DEPLOYMENT. The per-app
     * watermarks arrive inside it, on `apps[]`, and are picked out where they are used.
     *
     *  This read ALWAYS answers 200 when it worked, however bad the news is — a health endpoint
     * that refuses when things are unhealthy reports nothing at the moment it matters. So a failure
     * here means the request itself did not come back, which is a different fact from "nothing has
     * ever run", and the cards below say so rather than printing a confident "never".
     *
     * @returns {void}
     */
    const loadSyncHealth = useCallback(() => {
        setSyncHealthState('loading');
        SYNC_API.getHealth((resp) => {
            if (!resp || !resp.status || !resp.data) {
                setSyncHealth(null);
                let reason = 'The sync health request did not come back. Check the browser console and the server logs.';
                if (resp && resp.msg) {
                    reason = resp.msg;
                }
                setSyncHealthReason(reason);
                setSyncHealthState('error');
                return;
            }
            setSyncHealth(resp.data);
            setSyncHealthReason('');
            setSyncHealthState('ready');
        });
    }, []);

    useEffect(() => { loadHealth(); }, [loadHealth]);
    useEffect(() => { loadCoverage(); }, [loadCoverage]);
    useEffect(() => { loadBigQueryProbe(); }, [loadBigQueryProbe]);
    useEffect(() => { loadSyncHealth(); }, [loadSyncHealth]);

    /**
     * Records a job that reached a terminal status, and re-reads everything it could have changed.
     *
     * `job` is null when the trigger was refused, or when the 5-minute poll gave up while the job
     * was still running — in which case there is nothing to record, and the lookup box below is how
     * the operator finds out what happened to it.
     *
     * @param {Object|null} job - The terminal job row, or null.
     * @returns {void}
     */
    const handleJobFinished = useCallback((job) => {
        setHistoryRefreshKey((key) => key + 1);
        loadHealth();
        loadCoverage();
        // A finished BIGQUERY_SYNC moves `last_bq_synced_at`, and a finished anything may have been
        // the run that first connected the tier. Cheaper to re-read than to reason about which.
        loadBigQueryProbe();
        // Any terminal job moves `last_run_per_type`, and a successful one moves both a watermark
        // and `last_success_per_type`. Re-read rather than patch the held payload: a locally applied
        // edit is a second copy of the server's rules about which watermark a job type advances.
        loadSyncHealth();
        if (!job || !job.job_id) {
            return;
        }
        setSessionJobs((previous) => {
            const next = previous.filter((row) => row.job_id !== job.job_id);
            next.unshift(job);
            return next.slice(0, 20);
        });
    }, [loadHealth, loadCoverage, loadBigQueryProbe, loadSyncHealth]);

    /**
     * Reads one job by id through `GET /api/sync/jobs/:job_id` and adds it to the list.
     *
     * The intended path after a "taking longer than expected" toast, which leaves the job running
     * with nothing watching it: the poll deadline is five minutes and a lifetime sync can outlast
     * it, so the id from that toast is looked up here once the run has had time to finish. The list
     * above will show it too — this answers the narrower question of "what became of THIS one".
     *
     * @returns {void}
     */
    const handleLookup = useCallback(() => {
        const id = lookupId.trim();
        if (!id) {
            if (showToast) {
                showToast('Paste a job id first.', true);
            }
            return;
        }
        setLookupBusy(true);
        SYNC_API.getJob(id, (resp) => {
            setLookupBusy(false);
            let job = null;
            if (resp && resp.status && resp.data) {
                job = resp.data.job;
            }
            if (!job) {
                let msg = 'No job with that id.';
                if (resp && resp.msg) {
                    msg = resp.msg;
                }
                if (showToast) {
                    showToast(msg, true);
                }
                return;
            }
            setSessionJobs((previous) => {
                const next = previous.filter((row) => row.job_id !== job.job_id);
                next.unshift(job);
                return next.slice(0, 20);
            });
            setLookupId('');
        });
    }, [lookupId, showToast]);

    // ── Readiness ────────────────────────────────────────────────────────────────────────────
    let healthBadge = <Badge tone="new">unknown</Badge>;
    let healthReason = 'Reading the backend readiness probe…';
    let healthMeta = '';

    if (healthState === 'silent') {
        healthBadge = <Badge tone="critical">unreachable</Badge>;
        healthReason = 'Nothing answered at /healthz. The backend is not running, or the Next.js rewrite is not pointed at it (NEXT_PUBLIC_API_BASE_URL, read at boot — restart after changing it).';
    }
    if (healthState === 'answered' && health) {
        let tone = HEALTH_STATE_TONE[health.state];
        if (!tone) {
            tone = 'new';
        }
        healthBadge = <Badge tone={tone}>{health.state}</Badge>;
        healthReason = health.reason || '';
        healthMeta = `Checked ${_fmtWhen(health.checked_at)} · process up ${_fmtUptime(health.uptime_seconds)}`;
    }

    // A first-sync affordance, and only that. Once the backend is `ready` the console below is the
    // place to run one, and two buttons doing the same thing is worse than one in the right spot.
    let firstSyncMarkup = null;
    if (healthState === 'answered' && health && health.state === 'warming' && appId) {
        firstSyncMarkup = (
            <InlineStack gap="300" blockAlign="center" wrap>
                <ManualSyncButton
                    jobType={PARTNER_JOB_TYPE}
                    payload={{ partner_app_id: appId, mode: 'AUTO' }}
                    label="Run the first sync"
                    onFinish={handleJobFinished}
                />
                <Text as="span" variant="bodySm" tone="subdued">
                    Pulls every event and transaction from 2009 to today — this is the run that makes the rest of
                    the dashboard answerable. It can take a while; the button polls until it finishes.
                </Text>
            </InlineStack>
        );
    }

    // Hoisted rather than assembled inside the JSX: `healthMeta` is empty until the probe answers,
    // and a separator glued on unconditionally would render a stray "·" on the first paint.
    let healthFootnote = 'GET /healthz — unauthenticated, and deliberately says nothing that identifies the business.';
    if (healthMeta) {
        healthFootnote = `${healthMeta} · ${healthFootnote}`;
    }

    const healthCard = (
        <Card>
            <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center" wrap>
                    <Text as="h2" variant="headingMd">Backend readiness</Text>
                    {healthBadge}
                </InlineStack>
                <Text as="p" variant="bodyMd">{healthReason}</Text>
                <Text as="span" variant="bodyXs" tone="subdued">
                    {healthFootnote}
                </Text>
                {firstSyncMarkup}
                <InlineStack>
                    <Button onClick={loadHealth}>Re-check</Button>
                </InlineStack>
            </BlockStack>
        </Card>
    );

    // ── Coverage ─────────────────────────────────────────────────────────────────────────────
    const cov = (coverage && coverage.coverage) || {};

    const earliestEvent = _envValue(cov.earliest_event_at);
    const earliestTransaction = _envValue(cov.earliest_transaction_at);
    const lifetimeCompleted = _envValue(cov.lifetime_sync_completed_at);
    const gapDays = _envValue(cov.event_history_gap_days);
    const absentPct = _envValue(cov.charge_link_absent_pct);
    const unresolvedPct = _envValue(cov.charge_link_unresolved_pct);

    let reachSentence = 'How far back this install\'s history reaches has not been measured yet, so no period can be described as covered or uncovered.';
    if (earliestEvent && earliestTransaction) {
        reachSentence = `The oldest event held is ${_fmtWhen(earliestEvent)} and the oldest settled payout is ${_fmtWhen(earliestTransaction)}. A question about any period before those instants has no answer here — it reports as unknown, not as zero.`;
    }
    if (earliestEvent && !earliestTransaction) {
        reachSentence = `The oldest event held is ${_fmtWhen(earliestEvent)}. No settled payout has been synced at all, so every money figure in this install is unavailable rather than zero.`;
    }
    if (!earliestEvent && earliestTransaction) {
        reachSentence = `The oldest settled payout is ${_fmtWhen(earliestTransaction)}, but no event has been synced at all — so installs, uninstalls and everything derived from them are unavailable rather than zero.`;
    }

    let lifetimeNote = 'No lifetime sync has completed, so every "all time" total in this dashboard is a FLOOR — whatever incremental windows happened to pull — and not a total. Run the full re-sync below to turn them into totals.';
    if (lifetimeCompleted) {
        lifetimeNote = 'A lifetime sync has completed, so "all time" totals really are totals rather than floors.';
    }

    let syncedNote = 'Nothing has been pulled at all. Every Performance page will correctly report that it has no data.';
    if (_envValue(cov.last_synced_at)) {
        syncedNote = 'Nothing that happened after this instant has been pulled yet, so the most recent installs, cancellations and payouts may not be represented.';
    }

    const coverageRows = [
        {
            key: 'last_synced_at',
            label: 'Last successful sync',
            envelope: cov.last_synced_at,
            format: _fmtWhen,
            note: syncedNote
        },
        {
            key: 'earliest_event_at',
            label: 'Earliest event held',
            envelope: cov.earliest_event_at,
            format: _fmtWhen,
            note: 'The floor of the install/uninstall history. Anything before it is outside our records.'
        },
        {
            key: 'earliest_transaction_at',
            label: 'Earliest settled payout held',
            envelope: cov.earliest_transaction_at,
            format: _fmtWhen,
            note: 'The floor of every money figure in the system — revenue, ARPU, lifetime cash.'
        },
        {
            key: 'lifetime_sync_completed_at',
            label: 'Lifetime sync completed',
            envelope: cov.lifetime_sync_completed_at,
            format: _fmtWhen,
            note: lifetimeNote
        },
        {
            key: 'event_history_gap_days',
            label: 'Widest gap in the event history',
            envelope: cov.event_history_gap_days,
            format: _fmtDays,
            note: _gapMeaning(gapDays)
        },
        {
            key: 'charge_link_absent_pct',
            label: 'Charge link absent',
            envelope: cov.charge_link_absent_pct,
            format: _fmtPct,
            note: _absentMeaning(absentPct)
        },
        {
            key: 'charge_link_unresolved_pct',
            label: 'Charge link unresolved',
            envelope: cov.charge_link_unresolved_pct,
            format: _fmtPct,
            note: _unresolvedMeaning(unresolvedPct)
        }
    ];

    // The one measurement worth interrupting the page for: a wide hole means several figures
    // under-report without saying so, which is precisely the failure a coverage block exists to
    // surface. Only raised on a REAL measurement — a null gap raises nothing, because nothing
    // is known.
    let gapBanner = null;
    if (coverageState === 'ready' && gapDays !== null && gapDays >= GAP_WARNING_DAYS) {
        gapBanner = (
            <Banner tone="warning" title={`The event history has a ${gapDays}-day hole in it`}>
                <p>{_gapMeaning(gapDays)}</p>
            </Banner>
        );
    }

    let coverageBody = null;
    if (coverageState === 'idle') {
        coverageBody = (
            <Text as="p" variant="bodyMd" tone="subdued">
                Coverage is measured per partner app. Select one in the side nav to read it.
            </Text>
        );
    }
    if (coverageState === 'loading') {
        coverageBody = <Text as="p">Reading the coverage measurements…</Text>;
    }
    if (coverageState === 'error') {
        coverageBody = (
            <BlockStack gap="200">
                <Text as="p" variant="bodyMd" tone="critical">Coverage could not be read.</Text>
                <Text as="p" variant="bodySm" tone="subdued">{coverageReason}</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                    Nothing is shown in its place: without coverage there is no way to say how much of this
                    install&apos;s data is real, and a blank table would read as &quot;no gaps&quot;.
                </Text>
            </BlockStack>
        );
    }
    if (coverageState === 'ready') {
        // Published because it is a MEASUREMENT DECISION rather than a tunable: `active_subs` means
        // nothing without it. Omitted entirely when absent — an empty line would imply the
        // definition is "none" rather than "not stated".
        let windowNote = null;
        if (coverage && coverage.active_sub_window_days) {
            windowNote = (
                <Text as="span" variant="bodyXs" tone="subdued">
                    {`A shop counts as still paying if Shopify billed it within the last ${coverage.active_sub_window_days} days. That is a measurement decision, not a tunable — change it and the dashboard says something different happened.`}
                </Text>
            );
        }

        let currencyNote = null;
        if (coverage && coverage.reporting_currency) {
            currencyNote = (
                <Text as="span" variant="bodyXs" tone="subdued">
                    {`Money is reported in ${coverage.reporting_currency}. Nothing in this system converts currencies, so this is a label rather than a promise that every row shares it.`}
                </Text>
            );
        }

        coverageBody = (
            <BlockStack gap="400">
                <Text as="p" variant="bodyMd">{reachSentence}</Text>
                <InlineGrid columns={{ xs: 1, sm: 1, md: 2 }} gap="400">
                    {coverageRows.map((row) => (
                        <CoverageRow
                            key={row.key}
                            label={row.label}
                            envelope={row.envelope}
                            format={row.format}
                            note={row.note}
                        />
                    ))}
                </InlineGrid>
                <Divider />
                <BlockStack gap="100">
                    {windowNote}
                    {currencyNote}
                    <Text as="span" variant="bodyXs" tone="subdued">
                        {`Measured as of ${_fmtWhen(coverage && coverage.as_of)} · GET /api/meta/coverage`}
                    </Text>
                </BlockStack>
            </BlockStack>
        );
    }

    const coverageCard = (
        <Card>
            <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Coverage — how much of this you can believe</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                    Every figure in this dashboard is a fold over the synced Partner API history, and a missing row
                    does not announce itself: a month that was never pulled and a month in which nothing happened
                    produce the identical empty result. These measurements are the only thing that tells them apart.
                    A value of <b>—</b> means never measured, which is not the same as zero.
                </Text>
                {coverageBody}
            </BlockStack>
        </Card>
    );

    // ── The sync console ─────────────────────────────────────────────────────────────────────
    const partnerCategory = SYNC_CATEGORIES.find((category) => category.job_type === PARTNER_JOB_TYPE) || null;
    const bigQueryCategory = SYNC_CATEGORIES.find((category) => category.job_type === BIGQUERY_JOB_TYPE) || null;
    const attributionCategory = SYNC_CATEGORIES.find((category) => category.job_type === ATTRIBUTION_JOB_TYPE) || null;
    const dummyCategory = SYNC_CATEGORIES.find((category) => category.job_type === DUMMY_JOB_TYPE) || null;

    const otherCategoryTitles = SYNC_CATEGORIES
        .filter((category) => TRIGGERABLE_JOB_TYPES.indexOf(category.job_type) === -1)
        .map((category) => category.title);

    // ── Where each card's "last success" comes from ──────────────────────────────────────────
    // The selected app's row out of `sync/health`, which is where all three per-app watermarks live.
    const healthApp = _healthAppRow(syncHealth, appId);

    /**
     * The sentence a card shows INSTEAD of "Never completed successfully" when we could not read.
     *
     *  THE WHOLE POINT OF THIS FUNCTION IS THAT IT RETURNS `''` WHEN THE READ WORKED. An empty
     * string lets the card assert "Never completed successfully", which is correct and useful — the
     * server read the app row and told us the watermark is null. Every other case is a gap in OUR
     * reading, and a gap must never render as a measurement.
     *
     * @param {Boolean} appScoped - True when the watermark is recorded per app.
     * @returns {String} The reason, or '' when a "never" is a real answer.
     */
    const _watermarkUnknownReason = (appScoped) => {
        if (appScoped && !appId) {
            return 'it is recorded per app, and no partner app is selected.';
        }
        if (syncHealthState === 'loading') {
            return 'still reading it.';
        }
        if (syncHealthState === 'error') {
            return `the sync health endpoint did not answer, so this is unread rather than unrun. ${syncHealthReason}`;
        }
        if (appScoped && !healthApp) {
            return 'the sync health snapshot carries no row for the selected app.';
        }
        return '';
    };

    //  `last_synced_at` is stamped only after a Partner API sync succeeded IN FULL (both halves
    // written AND coverage re-measured), so it is the same fact as a successful run — and it is
    // app-scoped, which `last_success_per_type` is not. A run watched in this tab wins over it: same
    // fact, fresher by one poll interval.
    let partnerLastSuccess = null;
    if (healthApp && healthApp.last_synced_at) {
        partnerLastSuccess = { completed_at: healthApp.last_synced_at };
    }
    if (!partnerLastSuccess && selectedApp && selectedApp.last_synced_at) {
        // The roster's copy of the same field, used while the health read is still in flight so the
        // card does not flash "Never completed successfully" on every navigation.
        partnerLastSuccess = { completed_at: selectedApp.last_synced_at };
    }
    const partnerSessionSuccess = _latestSessionSuccess(sessionJobs, PARTNER_JOB_TYPE);
    if (partnerSessionSuccess) {
        partnerLastSuccess = { completed_at: partnerSessionSuccess.completed_at };
    }
    let partnerUnknownReason = '';
    if (!partnerLastSuccess) {
        partnerUnknownReason = _watermarkUnknownReason(true);
    }

    //  READ FROM THE APP ROW, NOT FROM THE BIGQUERY PROBE. The probe answers only while the tier
    // is configured, so a deployment that synced last month and lost its credentials yesterday used
    // to report the watermark as unreadable. `sync/health` reads the stored row regardless of
    // whether BigQuery can be reached, which is the honest source for "when did this last run".
    let bigQueryLastSuccess = null;
    if (healthApp && healthApp.last_bq_synced_at) {
        bigQueryLastSuccess = { completed_at: healthApp.last_bq_synced_at };
    }
    if (!bigQueryLastSuccess && bqLastSyncedAt) {
        bigQueryLastSuccess = { completed_at: bqLastSyncedAt };
    }
    const bigQuerySessionSuccess = _latestSessionSuccess(sessionJobs, BIGQUERY_JOB_TYPE);
    if (bigQuerySessionSuccess) {
        bigQueryLastSuccess = { completed_at: bigQuerySessionSuccess.completed_at };
    }
    let bigQueryUnknownReason = '';
    if (!bigQueryLastSuccess) {
        bigQueryUnknownReason = _watermarkUnknownReason(true);
    }

    //  THE WATERMARK THAT HAD NO READER. `last_install_attrib_synced_at` is stamped by the
    // install-attribution job and nothing served it before `GET /api/sync/health` existed, so this
    // card used to print "no endpoint reports this one" — a sentence that is now false on screen AND
    // hides a real timestamp. It is published on `apps[]` and read here like the other two.
    let attributionLastSuccess = null;
    if (healthApp && healthApp.last_install_attrib_synced_at) {
        attributionLastSuccess = { completed_at: healthApp.last_install_attrib_synced_at };
    }
    const attributionSessionSuccess = _latestSessionSuccess(sessionJobs, ATTRIBUTION_JOB_TYPE);
    if (attributionSessionSuccess) {
        attributionLastSuccess = { completed_at: attributionSessionSuccess.completed_at };
    }
    let attributionUnknownReason = '';
    if (!attributionLastSuccess) {
        attributionUnknownReason = _watermarkUnknownReason(true);
    }

    // The smoke test is GLOBAL — it takes no app — so `last_success_per_type` is exactly the right
    // scope for it, and the card's default "Last success (any app)" label is the accurate one.
    let dummyLastSuccess = _healthLastSuccess(syncHealth, DUMMY_JOB_TYPE);
    const dummySessionSuccess = _latestSessionSuccess(sessionJobs, DUMMY_JOB_TYPE);
    if (dummySessionSuccess) {
        dummyLastSuccess = { completed_at: dummySessionSuccess.completed_at };
    }
    let dummyUnknownReason = '';
    if (!dummyLastSuccess) {
        dummyUnknownReason = _watermarkUnknownReason(false);
    }

    // ── Whether the GA4 buttons may be pressed ───────────────────────────────────────────────
    // Both GA4 jobs read the same tier through the same credentials, so one verdict drives both.
    let bigQueryDisabled = false;
    let bigQueryDisabledReason = '';
    if (bqState === 'loading') {
        bigQueryDisabled = true;
        bigQueryDisabledReason = 'Checking whether BigQuery is connected…';
    }
    if (bqState === 'not_configured') {
        bigQueryDisabled = true;
        // The server's own sentence, verbatim, because it names the variables AND says what the
        // emptiness is not. Rewriting it into something friendlier is how the detail an operator
        // actually needs gets lost.
        bigQueryDisabledReason = `Not connected, so this cannot run. Missing: ${bqMissingEnv.join(', ')}. ${bqMessage} ${BIGQUERY_UNLOCKS} Set the variables in the API's environment and restart it, then run this sync.`;
    }

    //  Not disabled. We failed to READ the tier's state; that is a gap in our own reading, and
    // blocking a legitimate sync over it would be the same class of mistake as reporting a zero.
    let bigQueryUnknownNote = null;
    if (bqState === 'unknown') {
        bigQueryUnknownNote = (
            <Card>
                <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">Whether BigQuery is connected could not be established</Text>
                    <Text as="p" variant="bodySm" tone="subdued">{bqMessage}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                        The buttons above are left enabled: this says nothing about the tier, only that the check
                        failed. If it is in fact unconfigured, the job will start and then fail naming the
                        environment variable that is missing — which is the same answer, one poll later.
                    </Text>
                </BlockStack>
            </Card>
        );
    }

    // ── The cards ────────────────────────────────────────────────────────────────────────────
    let partnerCardMarkup = (
        <Card>
            <Text as="p" variant="bodyMd" tone="critical">
                The Partner API sync is missing from the job registry, so there is nothing to trigger. This is a build
                problem, not an empty state.
            </Text>
        </Card>
    );
    if (partnerCategory) {
        partnerCardMarkup = (
            <SyncCategoryCard
                category={partnerCategory}
                lastSuccess={partnerLastSuccess}
                lastSuccessLabel="Last success (this app)"
                lastSuccessUnknownReason={partnerUnknownReason}
                appId={appId}
                showToast={showToast}
                onFinish={handleJobFinished}
                onNavigate={(url) => router.push(url)}
            />
        );
    }

    let bigQueryCardMarkup = (
        <Card>
            <Text as="p" variant="bodyMd" tone="critical">
                {`The GA4 rollup sync (${BIGQUERY_JOB_TYPE}) is missing from the job registry, so it cannot be triggered from here even though the API serves POST /api/sync/bigquery. This is a build problem, not an empty state.`}
            </Text>
        </Card>
    );
    if (bigQueryCategory) {
        bigQueryCardMarkup = (
            <SyncCategoryCard
                category={bigQueryCategory}
                lastSuccess={bigQueryLastSuccess}
                lastSuccessLabel="Last success (this app)"
                lastSuccessUnknownReason={bigQueryUnknownReason}
                appId={appId}
                disabled={bigQueryDisabled}
                disabledReason={bigQueryDisabledReason}
                showToast={showToast}
                onFinish={handleJobFinished}
                onNavigate={(url) => router.push(url)}
            />
        );
    }

    let attributionCardMarkup = (
        <Card>
            <Text as="p" variant="bodyMd" tone="critical">
                {`The install-attribution sync (${ATTRIBUTION_JOB_TYPE}) is missing from the job registry, so it cannot be triggered from here even though the API serves POST /api/sync/install-attribution. This is a build problem, not an empty state.`}
            </Text>
        </Card>
    );
    if (attributionCategory) {
        attributionCardMarkup = (
            <SyncCategoryCard
                category={attributionCategory}
                lastSuccess={attributionLastSuccess}
                lastSuccessLabel="Last success (this app)"
                lastSuccessUnknownReason={attributionUnknownReason}
                appId={appId}
                disabled={bigQueryDisabled}
                disabledReason={bigQueryDisabledReason}
                showToast={showToast}
                onFinish={handleJobFinished}
                onNavigate={(url) => router.push(url)}
            />
        );
    }

    let dummyCardMarkup = (
        <Card>
            <Text as="p" variant="bodyMd" tone="critical">
                {`The infrastructure test (${DUMMY_JOB_TYPE}) is missing from the job registry, so it cannot be triggered from here even though the API serves POST /api/sync/dummy. This is a build problem, not an empty state.`}
            </Text>
        </Card>
    );
    if (dummyCategory) {
        //  NOT disabled by the BigQuery verdict, and not gated on an app. This job touches no
        // credential and no data source — that is the entire reason it is worth running — so the one
        // thing that could stop it is the runner itself, which is precisely what it tests.
        dummyCardMarkup = (
            <SyncCategoryCard
                category={dummyCategory}
                lastSuccess={dummyLastSuccess}
                lastSuccessUnknownReason={dummyUnknownReason}
                appId={appId}
                showToast={showToast}
                onFinish={handleJobFinished}
                onNavigate={(url) => router.push(url)}
            />
        );
    }

    let otherCategoriesNote = null;
    if (otherCategoryTitles.length > 0) {
        otherCategoriesNote = (
            <Card>
                <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">Not triggerable from here</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                        {`The job registry also names ${otherCategoryTitles.join(', ')}. Neither this API nor its worker has anything behind them — no trigger route and no handler — so a button for one would enqueue nothing on a good day and a job that dies as UNKNOWN_JOB_TYPE on a bad one. They are listed here rather than given buttons that always fail.`}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                        Every job type that DOES have a handler now has a trigger route, the infrastructure test
                        included — that card is above, alongside the three data syncs.
                    </Text>
                </BlockStack>
            </Card>
        );
    }

    // ── Job history ──────────────────────────────────────────────────────────────────────────
    //  `GET /api/sync/jobs` IS SERVED NOW, so the one-shot probe that used to gate this section
    // is gone along with the "there is no job list endpoint" banner it selected. The probe was a
    // stale question: a failure today means the request did not come back, not that the route is
    // missing, and reporting the second over the first would send an operator to read the routes
    // file instead of the server log. `SyncJobHistoryTable` reads the payload's own `ledger_state`,
    // `sync_disabled` and `warnings[]`, so an empty ledger explains ITSELF rather than being
    // captioned from out here.
    //
    // The lookup box stays. It is the only way to see a job whose poll timed out and carried on in
    // the background, and it answers from `GET /api/sync/jobs/:job_id` — a different question from
    // the list's, not a fallback for it.
    let sessionBody = (
        <Text as="p" variant="bodySm" tone="subdued">
            No job has finished in this browser tab yet. That is a statement about this tab, not about the
            install — the full history is in the table above.
        </Text>
    );
    if (sessionJobs.length > 0) {
        sessionBody = (
            <BlockStack gap="300">
                {sessionJobs.map((job, index) => {
                    let dividerMarkup = null;
                    if (index > 0) {
                        dividerMarkup = <Divider />;
                    }
                    return (
                        <BlockStack key={job.job_id} gap="300">
                            {dividerMarkup}
                            <SessionJobRow job={job} />
                        </BlockStack>
                    );
                })}
            </BlockStack>
        );
    }

    const historyBody = (
        <BlockStack gap="400">
            <SyncJobHistoryTable refreshKey={historyRefreshKey} limit={20} />

            <Card>
                <BlockStack gap="400">
                    <BlockStack gap="150">
                        <Text as="h3" variant="headingSm">Watched in this tab</Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                            Jobs this page polled to completion, newest first — including any looked up below. The
                            table above is the whole ledger; this is just what happened while you were watching.
                        </Text>
                    </BlockStack>

                    {sessionBody}

                    <Divider />

                    <BlockStack gap="200">
                        <Text as="span" variant="bodySm" tone="subdued">
                            Look up any job by id — including one whose poll timed out and carried on in the background.
                        </Text>
                        <InlineStack gap="200" blockAlign="end" wrap>
                            <div style={{ minWidth: 320 }}>
                                <TextField
                                    label="Job id"
                                    labelHidden
                                    value={lookupId}
                                    onChange={setLookupId}
                                    autoComplete="off"
                                    placeholder="e.g. 66f0c1a2b3c4d5e6f7a8b9c0"
                                />
                            </div>
                            {/* InlineStack keeps the button at its natural width — inside the
                                surrounding BlockStack it would render as a full-width slab. */}
                            <Button loading={lookupBusy} disabled={lookupBusy} onClick={handleLookup}>Look up</Button>
                        </InlineStack>
                    </BlockStack>
                </BlockStack>
            </Card>
        </BlockStack>
    );

    // ── No app selected ──────────────────────────────────────────────────────────────────────
    //
    // "NO PARTNER APP IS REGISTERED" IS A MEASURED CLAIM, and this page is the worst place to
    // guess it: it sends the operator to go and register an app they may already have, on the one
    // screen whose whole job is telling them whether the pipeline is working. The gate was
    // `!appsLoading && apps.length === 0`, and `appsLoading` is false after a FAILURE exactly as it
    // is after a success — with `apps` still `[]` from the initial state on a first load — so a 500
    // on the roster call published it. `appsState === READY` is the only state that licenses it.
    let noAppBanner = null;
    if (appsState === APPS_STATE.ERROR) {
        // Said INSTEAD of the two below: with no roster we know neither whether an app exists nor
        // whether one is selected, and this page's own health and job-history reads do not depend on
        // the roster at all — so the rest of the screen stays up and only this claim is withdrawn.
        noAppBanner = (
            <Banner
                tone="critical"
                title="The partner app list could not be loaded"
                action={{ content: 'Try again', onAction: refreshApps }}
            >
                <p>{appsError}</p>
                <p>
                    Whether an app is registered — and which one is selected — is unknown until this call
                    succeeds. Sync health and the job history below do not depend on it and are unaffected.
                </p>
            </Banner>
        );
    } else if (appsState === APPS_STATE.READY && apps.length === 0) {
        noAppBanner = (
            <Banner tone="warning" title="No partner app is registered">
                <p>
                    Coverage and the Partner API sync are both scoped to an app, so neither can run yet. Register one
                    on the Partner Apps page first.
                </p>
                <Box paddingBlockStart="200">
                    <InlineStack>
                        <Button onClick={() => router.push(DASHBOARD_ROUTES.APPS)}>Open Partner Apps</Button>
                    </InlineStack>
                </Box>
            </Banner>
        );
    } else if (hydrated && apps.length > 0 && !appId) {
        noAppBanner = (
            <Banner tone="warning" title="No partner app is selected">
                <p>Pick one in the side nav — coverage and the sync triggers are both scoped by that selection.</p>
            </Banner>
        );
    }

    return (
        <SideNavBar>
            <Page
                title="Sync & status"
                subtitle="Whether data is flowing, when it last ran, and how far back it actually reaches."
                fullWidth
                backAction={{ content: 'Growth Intelligence', url: DASHBOARD_ROUTES.OVERVIEW }}
            >
                <BlockStack gap="400">
                    {noAppBanner}
                    {gapBanner}
                    {healthCard}
                    {coverageCard}
                    <BlockStack gap="300">
                        <Text as="h2" variant="headingMd">Run a sync</Text>
                        {partnerCardMarkup}
                        <Text as="p" variant="bodySm" tone="subdued">
                            The two GA4 jobs below read the same BigQuery export through the same credentials, but they
                            are separate runs: the rollups do not fetch attribution, and attribution does not fetch the
                            rollups. Each carries its own watermark, its own scan cost and its own way of failing, so
                            running one says nothing about the other.
                        </Text>
                        {bigQueryCardMarkup}
                        {attributionCardMarkup}
                        {bigQueryUnknownNote}
                        <Text as="p" variant="bodySm" tone="subdued">
                            The smoke test below reads nothing and writes nothing. Run it FIRST when a real sync is
                            not producing rows: it separates &quot;the runner never claimed the job&quot; from &quot;the runner ran
                            and the upstream had nothing&quot; — two diagnoses that look identical from this page and have
                            completely different fixes.
                        </Text>
                        {dummyCardMarkup}
                        {otherCategoriesNote}
                    </BlockStack>
                    <BlockStack gap="300">
                        <Text as="h2" variant="headingMd">Job history</Text>
                        {historyBody}
                    </BlockStack>
                    <Box paddingBlockEnd="400" />
                </BlockStack>
            </Page>
            {toastMarkup}
        </SideNavBar>
    );
};

export default SyncStatusPage;
