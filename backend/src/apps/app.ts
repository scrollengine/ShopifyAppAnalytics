'use strict';

/**
 * ============================================================================
 *  API SERVER — the entry point
 * ============================================================================
 *
 *      npm start        node -r ts-node/register/transpile-only src/apps/app.ts
 *
 *  There is no build step. ts-node transpiles on the fly, so nothing is ever
 *  emitted next to a source file.
 *
 *  ──  Why almost nothing is imported at the top of this file ───────────────
 *  `src/config/index.ts` snapshots `process.env` ONCE, at first require. The
 *  only thing that loads `.env` is `bootstrap()`, and it does so before it
 *  requires config. So ANY module that reaches config — the logger, the routes,
 *  every module barrel — must be required INSIDE the `.then()` below, after
 *  bootstrap has run.
 *
 *  Hoist one of those requires to the top of the file and the whole application
 *  silently reads a config built entirely from defaults: no Mongo URI, no
 *  Partner token, an empty JWT secret. It does not crash. It boots, and it is
 *  wrong. The `typeof import(...)` aliases below keep those lazy requires fully
 *  typed, which is the same device `core/bootstrap.ts` uses for the same
 *  reason.
 *
 *  Only `express` (touches no config) and `core/bootstrap` (lazy internally)
 *  are safe at module scope. Type-only imports are always safe — they erase.
 *
 *  ── Boot order ──────────────────────────────────────────────────────────────
 *  The server LISTENS BEFORE the sync machinery starts. That is deliberate:
 *  `/healthz` answers 503 while the instance warms, so a rolling deploy can see
 *  "up but not ready" instead of a refused connection, which reads as a crash.
 *
 *  ONE `.then`, ONE fatal `.catch`. Every genuinely fatal step is allowed to
 *  throw so it lands in that single catch and exits non-zero for the
 *  supervisor to restart. Steps that are deliberately NON-fatal carry their own
 *  local guard and a comment saying why.
 * ============================================================================
 */

import express = require('express');
import bootstrapModule = require('../core/bootstrap');
import type { IdentityObject, ServiceResult } from '../types/service.types';

// Typed handles for the lazy requires inside the .then() — see the note above.
type ConfigModule = typeof import('../config');
type LoggerModule = typeof import('../core/logger');
type ShutdownModule = typeof import('../core/shutdown');
type RoutesModule = typeof import('../routes');
type SecurityHeadersModule = typeof import('../middlewares/securityHeaders');
type LoginRateLimitModule = typeof import('../middlewares/loginRateLimit');
type TerminalErrorHandlerModule = typeof import('../middlewares/terminalErrorHandler');
type AuthModule = typeof import('../modules/auth');
type MailModule = typeof import('../modules/mail');
type PartnerModule = typeof import('../modules/partner');
type SyncModule = typeof import('../modules/sync');

const { bootstrap } = bootstrapModule;

/**
 * Identity for the work this file does before any human has signed in.
 *
 * Services take an identity and refuse an empty one; at boot there is no request and no session.
 * This is the same named non-human caller device the job runner uses (`SYNC_WORKER`). It grants
 * nothing — permissions belong to signed-in users and are checked per route, and boot work passes
 * through no route — it only keeps the service signature uniform and makes the caller legible in a
 * log line.
 */
const BOOT_USER_ID = 'BOOT';

/** Largest JSON body accepted. Nothing here takes bulk input; a login and a few ids is the whole of it. */
const JSON_BODY_LIMIT = '1mb';

/**
 * How long a NON-fatal boot step may hold up the rest of boot. Past it the step is left to finish in
 * the background and boot moves on — a slow datastore must not keep the sync machinery from starting
 * over bookkeeping that nothing waits for.
 */
const NON_FATAL_BOOT_STEP_BUDGET_MS = 30 * 1000;

/**
 * Waits for a non-fatal boot step, but never longer than `budgetMs`.
 *
 * The step is not cancelled on timeout (nothing here can cancel a query); it keeps running and its
 * own logging still reports how it ended. A rejection counts as "did not finish" — boot steps resolve
 * by contract, and this keeps a future one that does not from taking boot down.
 *
 * @param step - The step's promise.
 * @param budgetMs - The most boot will wait.
 * @returns `{ finished: true, value }`, or `{ finished: false }` on timeout or rejection.
 */
const _awaitBootStep = <T>(step: Promise<T>, budgetMs: number): Promise<{ finished: true; value: T } | { finished: false }> => {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ finished: false }), budgetMs);
        // A pending budget timer must not be what keeps a shutting-down process alive.
        timer.unref();
        step.then(
            (value) => {
                clearTimeout(timer);
                resolve({ finished: true, value: value });
            },
            () => {
                clearTimeout(timer);
                resolve({ finished: false });
            }
        );
    });
};

bootstrap().then(async () => {
    // ── Lazy requires: safe only from here down, once dotenv has run ────────
    const config: ConfigModule = require('../config');
    const { customConsoleLog, customConsoleError, customConsoleWarn }: LoggerModule = require('../core/logger');
    const { registerGracefulShutdown }: ShutdownModule = require('../core/shutdown');
    const routes: RoutesModule = require('../routes');
    const { securityHeaders }: SecurityHeadersModule = require('../middlewares/securityHeaders');
    const { loginRateLimit, loginBodyParser, LOGIN_RATE_LIMIT_PATH }: LoginRateLimitModule = require('../middlewares/loginRateLimit');
    const { terminalErrorHandler }: TerminalErrorHandlerModule = require('../middlewares/terminalErrorHandler');
    const {
        ensureInstallState,
        markLegacyOperators,
        ensureAuthIndexes,
        reconcileSetup,
        logSetupState
    }: AuthModule = require('../modules/auth');
    const { verifyMailAtBoot }: MailModule = require('../modules/mail');
    const { registerPartnerAppFromConfig, runFullSync }: PartnerModule = require('../modules/partner');
    const {
        registerJobHandler,
        assertHandlersRegistered,
        startJobRunner,
        startPartnerSyncCron,
        startBigQuerySyncCrons,
        RUNNABLE_JOB_TYPES
    }: SyncModule = require('../modules/sync');

    // ── The app ─────────────────────────────────────────────────────────────
    const app = express();

    // Says nothing useful to a legitimate caller and names the stack to everyone else. `helmet`
    // removes this header too; the explicit disable stays because it is the one line that survives
    // somebody deciding helmet is optional.
    app.disable('x-powered-by');

    // ── Whose address is req.ip ─────────────────────────────────────────────
    //  SET BEFORE ANY MIDDLEWARE THAT READS AN ADDRESS. The login rate limit below — and the
    // setup-request and forgot-password limits in routes/auth.routes.ts — count against `req.ip`, and what `req.ip` MEANS is decided entirely here: with this
    // unset, every caller behind the dashboard's server-side proxy resolves to the proxy and shares
    // one budget; set too loosely, a forged `X-Forwarded-For` puts every attempt in a fresh one.
    // The default is Express's `false` because only the second of those failures is silent. Read
    // `_trustProxy` in src/config/index.ts before changing the deployment's TRUST_PROXY.
    app.set('trust proxy', config.APP.TRUST_PROXY);

    //  FIRST LAYER, so that everything carries the headers: the guarded API, the public login,
    // /healthz, a 404, and anything Express answers before a route is reached. Moving it below a
    // mount silently un-hardens whatever is registered above it.
    app.use(securityHeaders);

    // The enforcement behind AUTH_LOGIN_RATE_LIMIT_MAX, on the one unauthenticated endpoint that
    // checks a password. Mounted BEFORE the general body parser: a refused attempt should not get a
    // megabyte of JSON parsed on its behalf. The login path's own parser (8 KB) runs first because
    // the limiter reads the email and device token to find a device's own budget.
    // `LOGIN_RATE_LIMIT_PATH` has to agree with the mount in src/routes/index.ts, and
    // test/securityRateLimit.test.js asserts that it still does.
    app.use(LOGIN_RATE_LIMIT_PATH, loginBodyParser, loginRateLimit);

    app.use(express.json({ limit: JSON_BODY_LIMIT }));

    //  ONE mount. Everything the internet can reach is decided in src/routes/index.ts, and the
    // guard lives there — read that file before adding anything to this one. The other public-flow
    // limiters are ROUTE-level in routes/auth.routes.ts (the token-flow one needs the parsed body),
    // so nothing is added to this mount list for them.
    app.use(routes);

    // ── THE TERMINAL ERROR HANDLER — mounted LAST, and it must stay last ──────
    //
    // Without it Express falls through to `finalhandler`, which renders an HTML page carrying the
    // STACK TRACE whenever `NODE_ENV !== 'production'` — and config defaults NODE_ENV to
    // 'development'. That was reachable with no credential at all, because `express.json()` above
    // rejects a malformed body before any authentication runs, on any path including /healthz.
    //
    // Express walks this stack in registration order, so anything mounted BELOW this line has no
    // error handler. See src/middlewares/terminalErrorHandler.ts for why it ignores NODE_ENV.
    app.use(terminalErrorHandler);

    // ── Listen FIRST ────────────────────────────────────────────────────────
    // Before any sync work, so /healthz can answer 503-while-warming rather than refusing the
    // connection. A refused connection during a deploy looks like a crash; a 503 looks like what it
    // is, and carries the reason.
    const port = config.APP.PORT;
    const server = app.listen(port, () => {
        customConsoleLog('INFO: api server listening', {
            port: port,
            node_env: config.APP.NODE_ENV,
            health: `http://localhost:${port}/healthz`
        });
    });

    // Registered immediately, so a signal arriving during the slow steps below still winds the
    // process down cleanly instead of killing it outright.
    registerGracefulShutdown(server);

    // ── Accounts: install state, legacy accounts, auth indexes, setup (spec A8) ──
    // There is no seeded account. The first person through the setup screen becomes the owner, and
    // everyone else joins by invitation. These five steps make that state trustworthy before anyone
    // relies on it, in this order.

    //  FATAL — THROWS into the catch below. The install document is the ONLY record of whether
    // setup is open; without it the setup screen cannot say "locked", and a database that already
    // holds users is created LOCKED (never open) by this call. Refusing to start beats guessing.
    await ensureInstallState();

    // NON-FATAL, bounded. Stamps `legacy_at` on single-operator-build accounts. Sign-in never reads
    // them, so a failure here costs a provenance stamp, not access. Idempotent.
    const legacyMarking = await _awaitBootStep(markLegacyOperators(), NON_FATAL_BOOT_STEP_BUDGET_MS);
    if (!legacyMarking.finished) {
        customConsoleWarn('WARN: boot: marking legacy operator accounts did not finish in time — continuing; it carries on in the background');
    } else if (!legacyMarking.value.status) {
        customConsoleWarn('WARN: boot: could not mark legacy operator accounts — sign-in is unaffected (it never reads them)', { msg: legacyMarking.value.msg });
    }

    //  FATAL — THROWS into the catch below. The unique indexes ARE the gates: one account per email,
    // one outstanding invitation per address, one use per link. With MONGO_DISABLE_AUTO_INDEX=true
    // nothing else builds them, and the first insert without them could create a duplicate that no
    // later index build can repair. Account-creating requests answer 503 until this has succeeded.
    await ensureAuthIndexes();

    // NON-FATAL, bounded. Rolls a setup that crashed between locking the install and inserting the
    // owner forward from the claim it left behind (idempotent, so finishing late is harmless). Logs
    // the recovery command itself when it cannot.
    const reconciled = await _awaitBootStep(reconcileSetup(), NON_FATAL_BOOT_STEP_BUDGET_MS);
    if (!reconciled.finished) {
        customConsoleWarn('WARN: boot: setup reconciliation did not finish in time — continuing; it carries on in the background');
    } else if (!reconciled.value.status) {
        customConsoleError('ERROR: boot: setup reconciliation failed — if nobody can sign in, run `npm run auth:admin:dist -- status`', { msg: reconciled.value.msg });
    }

    // NON-FATAL, bounded. Says once who may claim setup, and WARNs loudly while it is open to whoever
    // reaches the dashboard first. Logs its own failure.
    const setupStateLogged = await _awaitBootStep(logSetupState(), NON_FATAL_BOOT_STEP_BUDGET_MS);
    if (!setupStateLogged.finished) {
        customConsoleWarn('WARN: boot: could not report the setup state in time — continuing');
    }

    // NON-FATAL and OFF the critical path: an SMTP server that is slow to answer must not hold up the
    // sync machinery. The check is bounded inside the mail module and logs its own outcome (a WARN on
    // failure); the Users page and GET /api/auth/setup report it from there. Not awaited.
    verifyMailAtBoot().catch((mailError: unknown) => {
        customConsoleWarn('WARN: boot: the mail check threw — mail state stays "not checked"', mailError);
    });

    // ── The app to report on ────────────────────────────────────────────────
    // NON-FATAL by choice. SHOPIFY_PARTNER_APP_ID is a config WARNING, not a required key, so a
    // fresh clone that has not set it yet must still boot: the server comes up, /healthz says
    // "no partner app is registered yet", and POST /api/partner-apps fixes it without a restart.
    // Idempotent — on every later boot this returns the existing row untouched.
    const bootIdentity: IdentityObject = { user_id: BOOT_USER_ID };
    const registration = await registerPartnerAppFromConfig(bootIdentity, {});
    if (!registration.status) {
        customConsoleWarn('WARN: boot: no partner app is registered, so nothing will sync', { msg: registration.msg });
    }

    // ── The sync machinery ──────────────────────────────────────────────────
    // The payload is read back off a STORED job row, so the three fields the sync accepts are
    // listed explicitly rather than spread. A stored document is data, not arguments.
    const _partnerSyncJobHandler = (identity: IdentityObject, params: Record<string, any>): Promise<ServiceResult> => {
        return runFullSync(identity, {
            partner_app_id: params.partner_app_id,
            mode: params.mode,
            lookback_days: params.lookback_days
        });
    };

    const handlerRegistration = registerJobHandler(RUNNABLE_JOB_TYPES.PARTNER_SYNC, _partnerSyncJobHandler);
    if (!handlerRegistration.status) {
        customConsoleError('ERROR: boot: could not register the partner sync handler', { msg: handlerRegistration.msg });
    }

    //  FATAL, and deliberately so: THROWS if any runnable job type has no handler. Without it the
    // failure surfaces at 03:00 as jobs failing with UNKNOWN_JOB_TYPE, which is a silent outage —
    // the dashboard keeps serving, it just stops moving. Better to refuse to start.
    const registeredTypes = assertHandlersRegistered();

    const runnerStart = startJobRunner();
    if (!runnerStart.status) {
        customConsoleError('ERROR: boot: the job runner did not start', { msg: runnerStart.msg });
    }

    //  FATAL on an unsupported SYNC_DAILY_CRON — it THROWS rather than firing at a time nobody
    // chose. Honours SYNC_DISABLED without throwing.
    const cronStart = startPartnerSyncCron();

    // The listing-analytics schedules. Arms NOTHING when BigQuery is not configured — that is the
    // ordinary state of a deployment that never set the tier up, and it is reported once here rather
    // than as a nightly error. Like the partner cron, it THROWS on a malformed expression, and that
    // reaches the fatal catch below: a scheduler that logged and continued would leave a process
    // that starts cleanly, reports healthy, and never syncs again.
    const bigQueryCronStart = startBigQuerySyncCrons();

    customConsoleLog('INFO: boot: complete', {
        registered_job_types: registeredTypes,
        job_runner_started: runnerStart.data && runnerStart.data.started,
        cron_started: cronStart.data && cronStart.data.started,
        next_sync_at: (cronStart.data && cronStart.data.next_fire_at) || '(none scheduled)',
        sync_disabled: config.SYNC.DISABLED,
        bigquery_configured: config.BIGQUERY.ENABLED,
        // Logged as its own line rather than folded into next_sync_at: an operator debugging "GA
        // events are not syncing" needs to see whether anything is scheduled at all, and the reason
        // when it is not.
        bigquery_schedules: (bigQueryCronStart.data && bigQueryCronStart.data.schedules) || [],
        bigquery_not_scheduled_because: (bigQueryCronStart.data && bigQueryCronStart.data.skipped_reason) || ''
    });
}).catch((error) => {
    // The single fatal path. Exit non-zero so the supervisor restarts us rather than leaving a
    // half-booted process listening and answering with data nothing is refreshing.
    //
    // The logger may not be loadable at this point (a config failure is one of the ways we get
    // here), so this reaches for it defensively and falls back to the console.
    try {
        const { customConsoleError }: LoggerModule = require('../core/logger');
        customConsoleError('FATAL: api server failed to start — exiting', error);
    } catch (loggerError) {
        console.error('FATAL: api server failed to start — exiting', error);
    }
    process.exit(1);
});
