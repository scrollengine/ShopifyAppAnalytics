'use strict';

/**
 * ============================================================================
 *  BOOTSTRAP — the one startup sequence
 * ============================================================================
 *
 *  dotenv -> config -> validate -> logger -> db, in that order. Every entry
 *  point (the API server, the sync worker, any script) calls this first and
 *  nothing else does startup work of its own, so there is exactly one order to
 *  reason about.
 *
 *      import bootstrap = require('./core/bootstrap');
 *
 *      bootstrap.bootstrap().then(() => {
 *          // Only NOW require anything that reads config.
 *          const app = require('./app');
 *          ...
 *      }).catch((error) => {
 *          console.error('FATAL: failed to start', error);
 *          process.exit(1);
 *      });
 *
 *  ── Why the requires below are inside the function ──────────────────────────
 *  The order is not a stylistic preference, it is a data dependency:
 *  `src/config/index.ts` snapshots `process.env` at first require, so anything
 *  that pulls config in before dotenv has run gets a config built entirely from
 *  defaults. A top-level `import config = require('../config')` in THIS file
 *  would execute the moment an entry point required this module — before
 *  `bootstrap()` was ever called, and therefore before dotenv.
 *
 *  So config, validate, logger and db are required INSIDE `bootstrap()`, in
 *  sequence. Their types are still bound, via `typeof import(...)` type
 *  aliases, which are erased at compile time and load nothing.
 *
 *  This is the only file in the codebase that needs this treatment. Everything
 *  else is required after bootstrap has returned, so ordinary top-level imports
 *  are correct everywhere else — and mandatory, per the import rules.
 * ============================================================================
 */

type ConfigModule = typeof import('../config');
type ValidateModule = typeof import('../config/validate');
type LoggerModule = typeof import('./logger');
type DbModule = typeof import('./db');

/**
 * Runs the startup sequence and returns the resolved configuration.
 *
 * Steps, in order:
 *   1. dotenv    — populate `process.env` from `.env`. Never overwrites a
 *                  variable already set in the real environment, so a container
 *                  or systemd unit always beats a checked-in file.
 *   2. config    — snapshot `process.env` into the frozen config object.
 *   3. validate  — refuse to boot on a missing TIER-1 setting, naming it.
 *                  Exits the process; anything after this line has usable config.
 *   4. logger    — first line of real output, echoing what was resolved. No
 *                  secret (and no pinned owner email) is printed, only whether
 *                  one is present.
 *   5. db        — open the MongoDB connection.
 *
 * Throws if the database cannot be reached. The caller is expected to log and
 * exit non-zero, so a process manager reports a failed start rather than
 * restarting into an identical failure.
 *
 * @returns The resolved config, so the caller need not require it separately.
 */
const bootstrap = async (): Promise<ConfigModule> => {
    // 1. Environment.
    require('dotenv').config();

    // 2. Configuration — first require, so this is where process.env is read.
    const config: ConfigModule = require('../config');

    // 3. Validation. Exits the process on a missing TIER-1 key, by name.
    const { validateConfig }: ValidateModule = require('../config/validate');
    validateConfig();

    // 4. Logging.
    const { customConsoleLog }: LoggerModule = require('./logger');
    customConsoleLog('INFO: starting shopify-app-analytics backend', {
        node_env: config.APP.NODE_ENV,
        port: config.APP.PORT,
        log_level: config.LOG.LEVEL,
        partner_org_id: config.PARTNER.ORG_ID,
        partner_api_version: config.PARTNER.API_VERSION,
        // Presence, never the value. An operator needs to know the token was
        // picked up; nobody needs it in a log file.
        partner_api_token_present: Boolean(config.PARTNER.API_TOKEN),
        partner_app_id: config.PARTNER.APP_ID || '(resolved at first sync)',
        active_sub_window_days: config.REVENUE.ACTIVE_SUB_WINDOW_DAYS,
        history_floor_date: config.REVENUE.HISTORY_FLOOR_DATE || '(none — early months will under-report)',
        sync_disabled: config.SYNC.DISABLED,
        // The address email links are built from, and the server they leave through. Neither is a
        // secret. SMTP_PASS and SETUP_OWNER_EMAIL are reported by presence only: a boot log is
        // shipped to places the people named in it never agreed to be.
        public_url: config.APP.PUBLIC_URL || '(not set)',
        mail_configured: config.MAIL.ENABLED,
        smtp_host: config.MAIL.SMTP_HOST || '(not set)',
        smtp_port: config.MAIL.SMTP_PORT,
        smtp_secure: config.MAIL.SMTP_SECURE,
        smtp_login_present: Boolean(config.MAIL.SMTP_USER && config.MAIL.SMTP_PASS),
        setup_owner_email_pinned: Boolean(config.AUTH.SETUP_OWNER_EMAIL)
    });

    // 5. Database.
    const { initDb }: DbModule = require('./db');
    await initDb();

    return config;
};

export = {
    bootstrap
};
