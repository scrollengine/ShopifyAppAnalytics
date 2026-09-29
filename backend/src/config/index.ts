'use strict';

/**
 * ============================================================================
 *  CONFIGURATION — THE ONLY FILE IN THIS REPOSITORY THAT READS process.env
 * ============================================================================
 *
 *  Every other file — apps, services, controllers, repositories, middlewares,
 *  scripts — consumes `config.<SECTION>.<FIELD>`. Nothing else reads
 *  `process.env`, and nothing anywhere WRITES to it. That is enforceable by
 *  grep, which is the point: when a self-hoster asks "what do I have to set?",
 *  the answer is one file rather than an archaeology exercise.
 *
 *  ── Load order (load-bearing) ───────────────────────────────────────────────
 *  This module snapshots `process.env` ONCE, at first require. `bootstrap()`
 *  (src/core/bootstrap.ts) therefore loads dotenv BEFORE it requires this file,
 *  and it is the only sanctioned entry point. Requiring this module before
 *  dotenv has run yields a config built entirely from defaults — which
 *  `validateConfig()` then rejects loudly by name, rather than the app booting
 *  against an empty configuration.
 *
 *  ── Conventions ─────────────────────────────────────────────────────────────
 *    - Booleans are opt-IN and resolved with `=== 'true'`. Anything that has to
 *      default to ON is therefore expressed as a NEGATIVE switch (`DISABLED`,
 *      `DISABLE_X`), never as a positive flag with an inverted parse — so
 *      reading a line here never requires knowing its default to understand it.
 *    - Numbers go through `_int`, which is `parseInt(x, 10)` with the falsy-zero
 *      trap removed (see its own comment). Defaults are inline, at the field.
 *    - Strings go through `_str`, which TRIMS. A trailing space on an API token
 *      pasted into a .env file otherwise produces a 401 nobody can explain.
 *    - Secrets have NO defaults. A blank secret must fail validation, never
 *      silently resolve to something that looks configured.
 * ============================================================================
 */

/**
 * Reads a string environment variable, trimming surrounding whitespace.
 *
 * The trim is the whole reason this exists. `.env` files are edited by hand and
 * pasted into, so `SHOPIFY_PARTNER_API_TOKEN=abc123 ` (one trailing space) is a
 * routine occurrence — and it produces an Authorization header the Partner API
 * rejects with a bare 401, which reads as "my token is wrong" rather than "my
 * token has a space on the end".
 *
 * @param raw - The raw `process.env` value.
 * @param fallback - Value to use when the variable is unset or blank. Defaults to ''.
 * @returns The trimmed value, or the fallback.
 */
const _str = (raw: string | undefined, fallback: string = ''): string => {
    if (typeof raw !== 'string') {
        return fallback;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        return fallback;
    }
    return trimmed;
};

/**
 * Reads an integer environment variable.
 *
 * This is `parseInt(raw, 10)` with one deliberate difference from the usual
 * `parseInt(x, 10) || default` idiom: a configured **zero** survives. Under
 * `||`, setting `SYNC_MAX_CONCURRENT_JOBS=0` (an operator deliberately pausing
 * the runner) silently resolves back to the default and the runner keeps
 * running — a falsy-default round-trip bug, and a particularly nasty one
 * because the operator can see their own setting in the file.
 *
 * Unset, blank, and non-numeric all fall back. `NaN` and `Infinity` never
 * escape this function.
 *
 * @param raw - The raw `process.env` value.
 * @param fallback - Value to use when the variable is unset or unparseable.
 * @returns The parsed integer, or the fallback.
 */
const _int = (raw: string | undefined, fallback: number): number => {
    const parsed = parseInt(_str(raw), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return parsed;
};

/**
 * Reads `TRUST_PROXY` into the shape Express's `app.set('trust proxy', …)` accepts.
 *
 * ⚠️ THIS SETTING DECIDES WHOSE ADDRESS `req.ip` IS, AND `req.ip` IS WHAT THE LOGIN RATE LIMIT
 * COUNTS AGAINST. Getting it wrong is not cosmetic in either direction:
 *
 *   TOO TRUSTING — trust an `X-Forwarded-For` that no proxy of yours wrote, and any caller can
 *   put a different address in that header on every request, land in a fresh bucket every time,
 *   and guess passwords without limit. A rate limiter that a header switches off is worse than
 *   none, because it is believed.
 *
 *   NOT TRUSTING ENOUGH — every request then appears to come from whichever machine actually
 *   opened the socket, which behind a proxy is the proxy. All callers share one bucket, so the
 *   limit becomes per-deployment rather than per-address: brute force is still stopped, but
 *   anyone who can reach the login can spend the whole budget and keep everyone else out of it
 *   until the window rolls.
 *
 * THE DEFAULT IS `false` — Express's own — because only one of those two failures is silent. An
 * over-trusting default would publish an enforcement that is disabled by one header, and nothing
 * in a log would say so.
 *
 * ── What to set, for the deployment in DEPLOYMENT.md ────────────────────────
 * The dashboard proxies `/api/*` to this backend server-side, so this process ALWAYS sits behind
 * at least one hop and its socket peer is always the dashboard container. Next does not add an
 * `X-Forwarded-For` of its own, but it forwards one verbatim, so with the documented nginx in
 * front (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`) the real client address
 * does arrive here:
 *
 *     TRUST_PROXY=uniquelocal    # trust hops on loopback/private ranges — the compose network
 *                                # and the local nginx — and nothing on a public address
 *
 * `uniquelocal` is the right value for that topology and NOT a blanket `true`: the rightmost
 * forwarded entry that is not itself a private address wins, so a client that forges the header
 * only forges an entry nginx then appends the real peer after.
 *
 * Other accepted forms, all Express's: `false`, `true`, a HOP COUNT (`1`), `loopback`,
 * `linklocal`, `uniquelocal`, or a comma-separated list of addresses/CIDRs
 * (`10.0.0.0/8,172.17.0.1`). Prefer naming your proxy's address over `true`, always.
 *
 * @param raw - The raw `process.env` value.
 * @returns `false` when unset; a number for a hop count; otherwise the
 * trimmed string, handed to Express as-is.
 */
const _trustProxy = (raw: string | undefined): boolean | number | string => {
    const value = _str(raw);
    if (!value || value.toLowerCase() === 'false') {
        return false;
    }
    if (value.toLowerCase() === 'true') {
        return true;
    }
    // A hop count. Matched strictly so that `1.2.3.4` stays a string rather than becoming the
    // number 1 — `parseInt` would happily return 1 for it, and "trust one hop" is a completely
    // different instruction from "trust this address".
    if (/^\d+$/.test(value)) {
        return parseInt(value, 10);
    }
    return value;
};

/*
 * The four BigQuery values `ENABLED` is derived from, read once here rather
 * than inline in the section below.
 *
 * A derived flag cannot reference its own siblings from inside the object
 * literal that defines them, and the alternative — recomputing
 * `_str(process.env.X)` a second time inside the expression — is how the gate
 * and the field it gates end up reading two different things after somebody
 * edits one of them.
 */
const _bqProjectId = _str(process.env.GCP_PROJECT_ID);
const _bqDataset = _str(process.env.BQ_DATASET);
const _bqServiceAccountJson = _str(process.env.GCP_SERVICE_ACCOUNT_JSON);
const _bqAdcCredentialsPath = _str(process.env.GOOGLE_APPLICATION_CREDENTIALS);

/** Gmail's SMTP host — the one host whose password gets the whitespace treatment in `_smtpPass`. */
const GMAIL_SMTP_HOST = 'smtp.gmail.com';

/**
 * Reads `SMTP_PASS`.
 *
 * `_str` trims the ends only. For `smtp.gmail.com` all internal whitespace is also removed, because
 * Google displays an app password as four groups of four letters and a paste keeps the spaces —
 * Gmail then answers `535 Username and Password not accepted`, which reads as "wrong password".
 * Nothing else ever alters the secret: any other server's password may legitimately contain spaces.
 *
 * @param raw - The raw `process.env` value.
 * @param host - The resolved SMTP host.
 * @returns The password, or '' when unset.
 */
const _smtpPass = (raw: string | undefined, host: string): string => {
    const value = _str(raw);
    if (host.toLowerCase() === GMAIL_SMTP_HOST) {
        return value.replace(/\s+/g, '');
    }
    return value;
};

/*
 * The MAIL values that other MAIL fields are derived from, read once here for the same reason as
 * the BigQuery block above: a derived field cannot see its siblings from inside the literal.
 */
const _smtpHost = _str(process.env.SMTP_HOST);
const _smtpSecure = process.env.SMTP_SECURE === 'true';
const _smtpUser = _str(process.env.SMTP_USER);
// SMTP_FROM falls back to SMTP_USER only when that is an address. Many relays log in with a
// username that is not one (SendGrid's is literally `apikey`), and a From built from it would be
// refused by every receiving server.
let _smtpFrom = _str(process.env.SMTP_FROM);
if (!_smtpFrom && _smtpUser.includes('@')) {
    _smtpFrom = _smtpUser;
}

const config = {

    // ── APP ─────────────────────────────────────────────────────────────────
    // Process-level settings. Not one of the six domain sections, but it has to
    // live here: `src/apps/*` may no more read `process.env` than anything else,
    // so the HTTP port has to come from somewhere.
    APP: {
        /** Port the API server binds. */
        PORT: _int(process.env.PORT, 4700),
        /**
         * 'production' | 'development' | 'test'. Read for error verbosity and
         * cookie flags — never to switch business logic, which must behave
         * identically in every environment or the numbers stop being comparable.
         */
        NODE_ENV: _str(process.env.NODE_ENV, 'development'),
        /**
         * Which upstream hops may be believed about the client's address —
         * handed straight to `app.set('trust proxy', …)` in `src/apps/app.ts`.
         *
         * Read `_trustProxy` above before changing it: this is the setting the
         * login rate limit's per-address bucketing depends on, and the two ways
         * of getting it wrong fail in opposite directions.
         */
        TRUST_PROXY: _trustProxy(process.env.TRUST_PROXY),
        /**
         * The address people open the dashboard at, e.g. `https://analytics.example.com`.
         * TIER-1. Trailing slashes are stripped.
         *
         * ⚠️ EVERY LINK IN AN EMAIL IS BUILT FROM THIS, AND FROM NOTHING ELSE. Never from the
         * request's Host, protocol or `X-Forwarded-*` headers: those are written by whoever sends
         * the request, so a password-reset link built from them points wherever an attacker says
         * and delivers the victim's token there. The lint config refuses those reads in `src/`.
         *
         * It must be the PUBLIC address — not `http://backend:8080`, which is where the dashboard
         * proxies to inside the compose network and opens nowhere else. Validation warns on that
         * shape and on a loopback host.
         */
        PUBLIC_URL: _str(process.env.APP_PUBLIC_URL).replace(/\/+$/, ''),
    },

    // ── MONGO ───────────────────────────────────────────────────────────────
    // The only datastore. History lives here: every Partner API event and
    // charge we have ever pulled, which is what makes "what was true on March
    // 31st" answerable at all.
    MONGO: {
        /** Full connection string. TIER-1: no default, validation refuses to boot without it. */
        URI: _str(process.env.MONGO_URI),
        /**
         * Optional database-name override. Normally left blank so the name in
         * the URI path wins — set it only when your URI carries no path
         * (some managed-cluster strings do not).
         */
        DB_NAME: _str(process.env.MONGO_DB_NAME),
        MAX_POOL_SIZE: _int(process.env.MONGO_MAX_POOL_SIZE, 10),
        MIN_POOL_SIZE: _int(process.env.MONGO_MIN_POOL_SIZE, 0),
        /**
         * How long the driver hunts for a reachable node before failing a
         * command. Kept short so a wrong URI fails at boot instead of hanging
         * the first request for the driver's 30s default.
         */
        SERVER_SELECTION_TIMEOUT_MS: _int(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS, 10000),
        /**
         * Escape hatch for `autoIndex`, which is ON by default here.
         *
         * Automatic index creation is right for a self-hosted single-tenant
         * install: nobody wants to run a migration step before their first
         * sync. It is worth disabling on a large existing database, where an
         * index build at boot is a stall rather than a convenience.
         *
         * Note that `autoIndex` CREATES but never DROPS — removing an index
         * from a schema leaves the physical index in place until someone drops
         * it by hand.
         */
        DISABLE_AUTO_INDEX: process.env.MONGO_DISABLE_AUTO_INDEX === 'true',
    },

    // ── AUTH ────────────────────────────────────────────────────────────────
    // Multi-user sign-in. People get an account in exactly two ways: the
    // first-run setup screen, which creates the owner and then locks for good
    // (a persisted flag, never re-derived from a user count), and an emailed
    // invitation from someone already inside. There is no public sign-up.
    // Forgotten passwords are recovered by an emailed, single-use, short-lived
    // link — which is why MAIL below is required rather than optional.
    AUTH: {
        /**
         * HMAC secret for session tokens. TIER-1, no default.
         *
         * A default here would be worse than useless: every self-hosted install
         * would share it, and anyone could mint a correctly signed token for
         * anyone else's dashboard. Validation additionally rejects a short secret.
         */
        JWT_SECRET: _str(process.env.JWT_SECRET),
        /** Issued-token lifetime. Re-login is a password prompt, so this can be short. */
        TOKEN_TTL_HOURS: _int(process.env.AUTH_TOKEN_TTL_HOURS, 12),
        /**
         * Whether `ADMIN_EMAIL`, `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH` is
         * still set. Read ONLY so validation can warn that they are ignored.
         *
         * They configured the single-operator build, and this build never reads
         * their VALUES — not for sign-in, not for setup, not for logging. They
         * are left in place deliberately until the operator is sure they will not
         * roll back, because the single-operator build still reads them.
         */
        LEGACY_ADMIN_ENV_PRESENT: Boolean(
            _str(process.env.ADMIN_EMAIL) || _str(process.env.ADMIN_PASSWORD) || _str(process.env.ADMIN_PASSWORD_HASH)
        ),
        /**
         * Pins which email address may claim first-run setup. Optional, and
         * lowercased here.
         *
         * Without it, setup is restricted to the accounts left by a
         * single-operator build when there are any, and is otherwise FIRST-COME:
         * whoever reaches the setup screen first becomes the owner. Setting this
         * closes that window. Never printed — boot logs only whether it is set.
         */
        SETUP_OWNER_EMAIL: _str(process.env.SETUP_OWNER_EMAIL).toLowerCase(),
        /** How long the setup-verification link stays usable, in minutes. */
        SETUP_TOKEN_TTL_MINUTES: _int(process.env.AUTH_SETUP_TOKEN_TTL_MINUTES, 60),
        /** How long an invitation link stays usable, in hours. The invite service clamps it to 1..168. */
        INVITE_TTL_HOURS: _int(process.env.AUTH_INVITE_TTL_HOURS, 72),
        /** How long a password-reset link stays usable, in minutes. Short: it is a bearer credential in an inbox. */
        PASSWORD_RESET_TTL_MINUTES: _int(process.env.AUTH_PASSWORD_RESET_TTL_MINUTES, 30),
        /** Cost factor used when hashing at runtime. 12 is ~250ms on modern hardware. */
        BCRYPT_ROUNDS: _int(process.env.AUTH_BCRYPT_ROUNDS, 12),
        /**
         * Failed logins allowed per window, per source address, before refusal.
         * Enforced by `src/middlewares/loginRateLimit.ts`, which is mounted on
         * `POST /api/auth/login` in `src/apps/app.ts`.
         *
         * ONLY REJECTED CREDENTIALS COUNT. A successful sign-in is never
         * charged, so ordinary daily use never walks toward the limit. It
         * clears nothing either: with more than one account, a success that
         * wiped the tally let any member reset it between guesses at another
         * account's password. A browser that has signed in before gets a
         * device budget of its own (see the middleware).
         *
         * ⚠️ "PER SOURCE ADDRESS" IS AS TRUE AS `TRUST_PROXY` IS CORRECT. This
         * backend always sits behind the dashboard's server-side proxy, so with
         * `TRUST_PROXY` unset every caller resolves to the same address and the
         * limit is effectively per-deployment. That still stops brute force; it
         * also means one attacker can spend the whole budget. See `_trustProxy`.
         *
         * SET IT TO 0 TO TURN THE LIMIT OFF. Zero survives `_int` deliberately
         * (see its comment), and zero or less is read as "disabled", not as
         * "refuse everyone" — an operator typing 0 is switching a limiter off,
         * and reading it the other way would lock them out of their own
         * dashboard on their first typo. It is the documented escape hatch for
         * an install where the limit is doing more harm than good.
         */
        LOGIN_RATE_LIMIT_MAX: _int(process.env.AUTH_LOGIN_RATE_LIMIT_MAX, 10),
        /**
         * How long that tally lives before it is discarded, in minutes.
         *
         * Nothing about a failed login is persisted anywhere: the refusal
         * EXPIRES. There is no lockout flag on the account, no counter in the
         * database and no state that survives a restart, so the worst anyone can
         * do to an account by guessing at it is make its owner wait this long.
         * A lockout that an attacker can trigger is a denial of service with
         * extra steps.
         *
         * A value of zero or less is treated as the 15-minute default rather
         * than as "never expires": a window that never rolls IS the permanent
         * lockout this design refuses to have.
         */
        LOGIN_RATE_LIMIT_WINDOW_MINUTES: _int(process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MINUTES, 15),
        /**
         * Budget for EACH of the rate limiters on the public account flows —
         * the emailed-link pages (keyed on the token itself), forgot-password
         * and the setup request (both keyed on the source address). Enforced by
         * `src/middlewares/authFlowRateLimit.ts`. Each limiter has its own
         * budget: spending one never throttles another, or sign-in.
         */
        PUBLIC_FLOW_RATE_LIMIT_MAX: _int(process.env.AUTH_PUBLIC_FLOW_RATE_LIMIT_MAX, 10),
        /** The window those budgets roll over, in minutes. */
        PUBLIC_FLOW_RATE_LIMIT_WINDOW_MINUTES: _int(process.env.AUTH_PUBLIC_FLOW_RATE_LIMIT_WINDOW_MINUTES, 15),
    },

    // ── MAIL ────────────────────────────────────────────────────────────────
    // Outgoing email, REQUIRED. Setup verification, invitations, password
    // resets and "your password was changed" notices all travel by email, and
    // the dashboard deliberately has no copy-this-link fallback: a link shown on
    // screen to whoever is signed in is a link handed to the wrong person the
    // first time an account is shared. (The recovery CLI can print one for
    // someone with shell access, which is a different trust level.)
    //
    // Any SMTP server, or Gmail with an app password. "Sent" anywhere in this
    // codebase means ACCEPTED BY THIS SERVER — never delivered.
    MAIL: {
        /** SMTP server host name, e.g. `smtp.gmail.com`. TIER-1. */
        SMTP_HOST: _smtpHost,
        /**
         * Implicit TLS from the first byte — the port-465 style. Leave unset for
         * port 587, where the connection upgrades with STARTTLS instead (and
         * `SMTP_ALLOW_INSECURE` below decides whether that upgrade is REQUIRED).
         */
        SMTP_SECURE: _smtpSecure,
        /** Defaults to 465 when `SMTP_SECURE=true`, else 587. Validation warns on the mismatched pairs. */
        SMTP_PORT: _int(process.env.SMTP_PORT, _smtpSecure ? 465 : 587),
        /**
         * ⚠️ NEGATIVE SWITCH, for a local test relay only. Default false, which
         * means STARTTLS is REQUIRED on a non-implicit-TLS connection and the
         * server certificate is VERIFIED. `true` allows a plaintext session and
         * any certificate — the SMTP password and every link in every email are
         * then readable and alterable by anything on the network path. Boot warns
         * loudly while it is set.
         */
        SMTP_ALLOW_INSECURE: process.env.SMTP_ALLOW_INSECURE === 'true',
        /**
         * Login for the SMTP server. `SMTP_USER` and `SMTP_PASS` are set
         * together or not at all (a relay that accepts mail without a login);
         * one without the other is a configuration error.
         */
        SMTP_USER: _smtpUser,
        /**
         * SMTP password. A secret: no default, never logged. See `_smtpPass`
         * for the one transformation it ever gets (Gmail app-password spaces).
         */
        SMTP_PASS: _smtpPass(process.env.SMTP_PASS, _smtpHost),
        /**
         * The sender ADDRESS — a bare address, no display name (that goes in
         * `SMTP_FROM_NAME`). Falls back to `SMTP_USER` when that is an address.
         * TIER-1 on the resolved value.
         */
        SMTP_FROM: _smtpFrom,
        /** Display name on the From line. */
        SMTP_FROM_NAME: _str(process.env.SMTP_FROM_NAME, 'Shopify App Analytics'),
        /**
         * Process-wide caps on messages handed to the server. Defaults sit well
         * under Gmail's 500-a-day ceiling for a personal account, which
         * suspends sending outright when crossed. Mail triggered by an anonymous
         * request (setup verification, forgot-password) may use at most half of
         * each, so nobody outside can spend the budget that invitations and
         * security notices need. Zero means NO mail is sent — validation warns.
         */
        MAX_PER_HOUR: _int(process.env.EMAIL_MAX_PER_HOUR, 30),
        MAX_PER_DAY: _int(process.env.EMAIL_MAX_PER_DAY, 200),
        /*
         * Socket timeouts, fixed rather than configurable: they bound how long a
         * dead mail server can hold a request, and no deployment is served by a
         * longer one. Nodemailer's own defaults are minutes.
         */
        CONNECTION_TIMEOUT_MS: 10000,
        GREETING_TIMEOUT_MS: 10000,
        SOCKET_TIMEOUT_MS: 30000,
        /**
         * Whether mail is configured AT ALL — derived, never set directly. A host
         * to talk to and an address to send from; credentials are optional
         * because an auth-less relay is a legitimate setup.
         */
        ENABLED: Boolean(_smtpHost && _smtpFrom),
    },

    // ── PARTNER ─────────────────────────────────────────────────────────────
    // The Shopify Partner API — the one hard external dependency. Everything
    // from installs onward is reconstructed from the events and transactions
    // this API returns. READ-ONLY by construction: the client rejects any
    // document containing a mutation before the request leaves the process.
    PARTNER: {
        /**
         * Partner organisation id — the number in your Partner dashboard URL:
         * `https://partners.shopify.com/<ORG_ID>/apps/...`. TIER-1.
         */
        ORG_ID: _str(process.env.SHOPIFY_PARTNER_ORG_ID),
        /** Partner API access token. TIER-1, no default, never logged. */
        API_TOKEN: _str(process.env.SHOPIFY_PARTNER_API_TOKEN),
        /**
         * Partner API version, `YYYY-MM`.
         *
         * Shopify keeps each quarterly version working for roughly 12 months and
         * then removes it — an unsupported version is a hard error, not a
         * degraded response, so this is a value to keep current rather than pin
         * and forget.
         */
        API_VERSION: _str(process.env.SHOPIFY_PARTNER_API_VERSION, '2026-07'),
        /**
         * Host root for the Partner GraphQL endpoint. Configurable ONLY so the
         * test suite can point the client at a local fixture server; there is no
         * production reason to change it.
         */
        API_BASE_URL: _str(process.env.SHOPIFY_PARTNER_API_BASE_URL, 'https://partners.shopify.com'),
        /**
         * Numeric id of the app to analyse.
         *
         * ⚠️ TYPED AS OPTIONAL, REQUIRED IN PRACTICE. Nothing resolves a blank
         * one: `registerPartnerAppFromConfig` returns early when it is unset, so
         * no app row is created and every sync has no target. `validate.ts`
         * warns about exactly this at boot. Set it to the numeric id in your
         * Partner dashboard URL.
         */
        APP_ID: _str(process.env.SHOPIFY_PARTNER_APP_ID),
        /** Days of history a routine (non-lifetime) sync pulls. */
        DEFAULT_LOOKBACK_DAYS: _int(process.env.SHOPIFY_PARTNER_LOOKBACK_DAYS, 90),
        /**
         * Proactive client-side rate limit. Shopify documents 4 requests/second
         * per client; the paginators run concurrently, so pacing has to be
         * process-wide rather than a sleep inside any one loop.
         */
        MAX_REQUESTS_PER_SECOND: _int(process.env.SHOPIFY_PARTNER_MAX_RPS, 4),
        /** Bounded reactive backstop for 429 / transient 5xx. */
        MAX_RETRIES: _int(process.env.SHOPIFY_PARTNER_MAX_RETRIES, 4),
        MAX_RETRY_WAIT_MS: _int(process.env.SHOPIFY_PARTNER_MAX_RETRY_WAIT_MS, 60000),
        /** Courtesy delay between pages of a cursor walk. */
        PAGE_DELAY_MS: _int(process.env.SHOPIFY_PARTNER_PAGE_DELAY_MS, 250),
        /** Per-request HTTP timeout. A sync is a background job; patience is cheap. */
        REQUEST_TIMEOUT_MS: _int(process.env.SHOPIFY_PARTNER_REQUEST_TIMEOUT_MS, 60000),
    },

    // ── REVENUE ─────────────────────────────────────────────────────────────
    // Knobs that change published figures. Everything here is a MEASUREMENT
    // DECISION, not a performance tunable — changing a value in this section
    // changes what the dashboard says happened.
    REVENUE: {
        /**
         * How recently Shopify must have billed a shop for it to count as an
         * active paid subscriber, in days. Default 38.
         *
         * WHY 38 — one 30-day billing cycle plus roughly a week of payout grace.
         * Both directions of getting this wrong have shipped and been measured:
         *
         *   TOO NARROW (e.g. 30): merchants bill on their own cycle and Shopify
         *   settles when it settles. A merchant whose payouts landed in April
         *   and then not again until July is not a cancellation, but a strict
         *   30-day window calls them churned for their full value. That produced
         *   a 47.6% churn reading for a month in which nobody actually cancelled.
         *
         *   TOO WIDE (or removed entirely): cancellations that never sync stay
         *   "active" forever. That produced an MRR reading of $45M against $10K
         *   of real settled payouts, on a suspiciously flat line — and a flat
         *   MRR line is itself the tell, because a real subscriber base moves.
         *
         * Widen it if your own billing lands irregularly, but widen it
         * deliberately and know that you are trading false churn for stale
         * subscribers.
         */
        ACTIVE_SUB_WINDOW_DAYS: _int(process.env.ACTIVE_SUB_WINDOW_DAYS, 38),
        /**
         * Currency every figure is reported in. The Partner API settles in the
         * organisation's payout currency, so this is a LABEL for that, not a
         * conversion instruction — nothing in this codebase converts currencies,
         * because a wrong exchange rate produces a plausible wrong number and
         * those are the ones this project exists to refuse.
         */
        REPORTING_CURRENCY: _str(process.env.REVENUE_REPORTING_CURRENCY, 'USD'),
        /**
         * `YYYY-MM-DD`. The earliest date your records actually cover — usually
         * the day you first ran a lifetime sync, or your app's launch date.
         *
         * This is the honesty primitive's floor. A month before this date has no
         * answer, and a figure with no answer is published as `null` with the
         * reason `NO_DATA_BEFORE_FLOOR` — never as `0.00`, which would be a
         * claim about your business rather than a statement about your data.
         *
         * Blank disables the floor: figures are then computed from whatever
         * history exists, and the earliest months will under-report silently.
         * Setting it is strongly recommended and validation warns when it is not.
         */
        HISTORY_FLOOR_DATE: _str(process.env.REVENUE_HISTORY_FLOOR_DATE),
    },

    // ── SYNC ────────────────────────────────────────────────────────────────
    // The background job runner. There is no message broker in this build: jobs
    // are rows in a collection and the runner polls them. That is slower than a
    // queue and enormously easier to self-host — one process, one database, no
    // infrastructure to stand up before the first number appears.
    SYNC: {
        /**
         * Kill switch. Set `SYNC_DISABLED=true` to stop the runner claiming any
         * job while leaving the API up and serving whatever is already stored.
         *
         * Expressed as a negative so the parse stays `=== 'true'` while the
         * default stays ON — a positive `SYNC_ENABLED` flag would mean a fresh
         * install that forgot one line silently never syncs, which is exactly
         * the class of quiet failure this project is about.
         */
        DISABLED: process.env.SYNC_DISABLED === 'true',
        /** How often the runner polls the job collection for claimable work. */
        POLL_INTERVAL_MS: _int(process.env.SYNC_POLL_INTERVAL_MS, 15000),
        /**
         * Jobs executed concurrently by one runner. Kept at 1 by default: the
         * Partner API rate limit is the real bottleneck, and serial execution
         * makes a run reproducible and its log readable.
         */
        MAX_CONCURRENT_JOBS: _int(process.env.SYNC_MAX_CONCURRENT_JOBS, 1),
        /** Attempts (initial + retries) before a job is abandoned as FAILED. */
        MAX_ATTEMPTS: _int(process.env.SYNC_MAX_ATTEMPTS, 3),
        /**
         * A job RUNNING longer than this is presumed dead — the process was
         * killed mid-flight — and is swept to FAILED so its lock is released.
         * Must exceed the longest legitimate sync you run.
         */
        STUCK_RUNNING_MS: _int(process.env.SYNC_STUCK_RUNNING_MS, 30 * 60 * 1000),
        /**
         * A job PENDING longer than this was never picked up at all, which
         * means no runner is alive. Swept and surfaced, because the failure
         * mode it catches is "the dashboard quietly stopped updating".
         */
        STUCK_PENDING_MS: _int(process.env.SYNC_STUCK_PENDING_MS, 60 * 60 * 1000),
        /**
         * When the daily Partner sync is enqueued, as `m h * * *` (UTC) or
         * `m h * * <dow>`. Only those two forms are understood — a step, range
         * or list expression does not error, it simply never fires, so the
         * scheduler validates this at boot rather than at 3am.
         */
        DAILY_CRON: _str(process.env.SYNC_DAILY_CRON, '0 3 * * *'),
    },

    // ── BIGQUERY ────────────────────────────────────────────────────────────
    // Shopify's listing-analytics export (a GA4 property, exported to BigQuery)
    // — the SECOND data source, and the only one that can say anything about
    // how a merchant arrived at the listing. The Partner API reports installs
    // and payouts and is silent on traffic.
    //
    // ENTIRELY OPTIONAL. Leave PROJECT_ID/DATASET blank and everything from
    // installs onward still works; the views that need this data report that
    // they have no data, with the reason attached. They do NOT show zeros —
    // a zero here would be a claim about the business rather than about the
    // data, and refusing to make it is the point of the project.
    BIGQUERY: {
        /** GCP project holding the export. Blank ⇒ the whole tier is off. */
        PROJECT_ID: _bqProjectId,
        /**
         * The dataset Shopify's export writes into — typically the GA4-style
         * `analytics_<propertyId>` dataset of daily `events_*` tables. Blank ⇒
         * the tier is off, because a project without a dataset addresses nothing.
         */
        DATASET: _bqDataset,
        /**
         * The wildcard table the queries scan. `events_*` is GA4's daily export
         * naming, and `_TABLE_SUFFIX BETWEEN @start AND @end` is what bounds a
         * sync window to a date range — which is also what bounds its COST.
         */
        TABLE_PATTERN: _str(process.env.BQ_TABLE_PATTERN, 'events_*'),
        /**
         * Service-account credentials: the key file's JSON on a single line, OR
         * an absolute path to it. Blank falls through to GCP's application
         * default credentials, which only resolve when running on GCP infra.
         *
         * Grant it `roles/bigquery.dataViewer` + `roles/bigquery.jobUser` and
         * nothing more — the client refuses non-SELECT SQL, but IAM is the layer
         * that holds when the client is wrong.
         */
        SERVICE_ACCOUNT_JSON: _bqServiceAccountJson,
        /** Window used on a first sync, before any watermark exists. */
        DEFAULT_LOOKBACK_DAYS: _int(process.env.BQ_LOOKBACK_DAYS, 90),
        /**
         * How far back a LIFETIME sync reaches. The GA4 export is forward-only
         * and is never backfilled, so a floor earlier than the day the export
         * was switched on buys nothing but scanned bytes.
         */
        LIFETIME_FLOOR_DATE: _str(process.env.BQ_LIFETIME_FLOOR_DATE, '2020-01-01'),
        /**
         * Hard per-query billing ceiling, in BYTES, as a string (BigQuery's own
         * parameter is a string because the value exceeds 2^53 at scale).
         *
         * BigQuery bills per byte SCANNED, and a LIFETIME sync fans three
         * concurrent scans across every daily table since LIFETIME_FLOOR_DATE.
         * A job whose estimate exceeds this is REJECTED BEFORE IT RUNS rather
         * than billed — which is why an over-cap dry run reports `exceeds_cap`
         * instead of merely "expensive".
         */
        MAX_BYTES_BILLED: _str(process.env.BQ_MAX_BYTES_BILLED, String(200 * 1024 * 1024 * 1024)),
        /** Server-side job ceiling. BigQuery cancels the job itself at this point. */
        JOB_TIMEOUT_MS: _int(process.env.BQ_JOB_TIMEOUT_MS, 300000),
        /**
         * Row ceiling per query. Results are paged explicitly rather than
         * auto-paginated into the heap; hitting this cap is reported as a
         * FAILURE, because a caller that persisted a truncated result would
         * advance its watermark past data it never saw.
         */
        MAX_RESULT_ROWS: _int(process.env.BQ_MAX_RESULT_ROWS, 500000),
        /** Rows per result page. */
        PAGE_SIZE: _int(process.env.BQ_PAGE_SIZE, 50000),
        /**
         * When the daily rollup sync runs, UTC. Same two-form grammar as
         * SYNC.DAILY_CRON — `m h * * *` or `m h * * <dow>`, validated at boot.
         *
         * 02:00 by default, an hour ahead of the Partner sync: the two read
         * different upstreams and never contend.
         */
        BIGQUERY_SYNC_CRON: _str(process.env.BIGQUERY_SYNC_CRON, '0 2 * * *'),
        /**
         * When the per-install attribution sync runs, UTC.
         *
         * 06:00 by default — deliberately AFTER the rollups, and clear of the
         * 03:00 Partner slot, so the heaviest query in the build never queues
         * behind another long job.
         *
         * ⚠️ Without a schedule here NOTHING would ever write the attribution
         * rows outside a manual trigger, and every store would read "not
         * attributed" indefinitely. That failure is silent: the page renders,
         * it is just empty.
         */
        INSTALL_ATTRIBUTION_SYNC_CRON: _str(process.env.INSTALL_ATTRIBUTION_SYNC_CRON, '0 6 * * *'),
        /**
         * Google's own Application Default Credentials pointer, read here ONLY
         * so `ENABLED` below can see that a deployment running on GCP is in
         * fact authenticated. Nothing consumes the value — the Google client
         * library reads this variable itself.
         */
        ADC_CREDENTIALS_PATH: _bqAdcCredentialsPath,
        /**
         * Whether this tier is configured AT ALL — derived, never set directly.
         *
         * THREE things are needed to run one query: a PROJECT to address and
         * bill, a DATASET to read, and CREDENTIALS. Credentials arrive one of
         * two ways — `GCP_SERVICE_ACCOUNT_JSON` (inline JSON or a key-file
         * path), or Google's Application Default Credentials, which is how a
         * process running ON GCP authenticates. Accepting only the first would
         * report a perfectly working ADC install as "not connected", which is a
         * dishonest answer in the other direction.
         *
         * Everything that could spend money or schedule a timer checks this
         * FIRST: an hourly cron firing into a credentials error is not a
         * diagnostic, it is log noise that trains an operator to ignore the log.
         *
         * Deliberately NOT "any BigQuery variable is set". HALF-configured is
         * the dangerous state — it looks configured in a .env file and produces
         * nothing at all — so the gate demands the whole set, and the services
         * name the specific variable that is missing when it does not hold.
         */
        ENABLED: Boolean(_bqProjectId && _bqDataset && (_bqServiceAccountJson || _bqAdcCredentialsPath)),
    },

    // ── LOG ─────────────────────────────────────────────────────────────────
    LOG: {
        /**
         * 'debug' | 'info' | 'warn' | 'error' | 'silent'. An unrecognised value
         * falls back to 'info' with a warning rather than silencing the process
         * — a typo in a log level must never be the reason nothing is logged.
         */
        LEVEL: _str(process.env.LOG_LEVEL, 'info'),
        /**
         * Emit one JSON object per line instead of human-readable text. Set this
         * when shipping to a log aggregator; leave it off in a terminal.
         */
        JSON: process.env.LOG_JSON === 'true',
    },
};

// Frozen so a stray assignment fails loudly at the write instead of quietly
// changing a published figure somewhere downstream. Shallow per section is
// enough: every leaf is a primitive.
Object.freeze(config.APP);
Object.freeze(config.MONGO);
Object.freeze(config.AUTH);
Object.freeze(config.MAIL);
Object.freeze(config.PARTNER);
Object.freeze(config.REVENUE);
Object.freeze(config.SYNC);
Object.freeze(config.BIGQUERY);
Object.freeze(config.LOG);

export = Object.freeze(config);
