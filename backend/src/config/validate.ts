'use strict';

/**
 * ============================================================================
 *  CONFIGURATION VALIDATION — fail at boot, by name
 * ============================================================================
 *
 *  A misconfigured analytics backend does not crash. It starts, serves, and
 *  reports numbers built from an empty database — which is the single failure
 *  mode this whole project exists to refuse. So configuration is checked once,
 *  at boot, and a missing TIER-1 value stops the process.
 *
 *  The output names the exact environment variable and shows the line to add.
 *  "Invalid configuration" is not an error message; it is a riddle.
 *
 *  TIER-1 vs optional:
 *    TIER-1   — the app cannot produce a correct number without it. Missing one
 *               exits non-zero.
 *    OPTIONAL — a capability is reduced, and the affected views say so at
 *               runtime rather than showing zeros. Missing one warns.
 *
 *  This module writes to stderr DIRECTLY rather than through core/logger, for
 *  two reasons: a configuration failure must print even when `LOG_LEVEL=silent`,
 *  and the logger reads the very config being validated.
 * ============================================================================
 */

import config = require('./index');

/** A TIER-1 requirement: what it is, how to read it, and how to tell if it is usable. */
interface RequiredKey {
    /** The environment variable name, exactly as it must appear in .env. */
    env: string;
    /** `config.<SECTION>.<FIELD>` path, for the "where does this live" line. */
    path: string;
    /** One sentence on what breaks without it. */
    why: string;
    /** An example line the operator can copy. */
    example: string;
    /** Reads the resolved value out of config. */
    read: () => string;
    /**
     * Optional extra check applied to a NON-empty value. Returning a string
     * means "present but unusable", and the string explains why.
     */
    checkUsable?: (value: string) => string | null;
}

/** A problem found in the resolved config: which key, and what to say about it. */
interface ConfigProblem {
    env: string;
    message: string;
    detail: string;
}

/** Anything shorter than this is guessable; a shared or blank secret is a full compromise. */
const MIN_JWT_SECRET_LENGTH = 32;

/** bcrypt hashes are `$2a$`, `$2b$` or `$2y$` followed by a cost and a 53-char payload. */
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/**
 * Shortest acceptable PLAINTEXT `ADMIN_PASSWORD`.
 *
 * Only applies to the plaintext path — a pre-computed `ADMIN_PASSWORD_HASH` says nothing about the
 * length of what produced it, and there is no way to check it from here.
 */
const MIN_ADMIN_PASSWORD_LENGTH = 12;

/**
 * Which variable supplied the operator password, resolved at module load so the error message names
 * the one the operator actually set rather than the one they did not.
 *
 * `ADMIN_PASSWORD_HASH` wins when both are present, matching the precedence the seeder applies.
 */
let ADMIN_SECRET_ENV = 'ADMIN_PASSWORD';
if (config.AUTH.ADMIN_PASSWORD_HASH) {
    ADMIN_SECRET_ENV = 'ADMIN_PASSWORD_HASH';
}

/**
 * The BigQuery tier's three required variables, in the order an operator sets them.
 *
 * Used ONLY to name what is missing in a warning. This tier is optional end to end — nothing here
 * can produce a TIER-1 problem, and no branch of it reaches `process.exit`.
 */
const BIGQUERY_REQUIRED_ENV: { env: string; read: () => string }[] = [
    { env: 'GCP_PROJECT_ID', read: () => config.BIGQUERY.PROJECT_ID },
    { env: 'BQ_DATASET', read: () => config.BIGQUERY.DATASET },
    {
        // Either of two satisfies this one: an inline/keyfile service account, or Google's own
        // Application Default Credentials, which is how a process running ON GCP authenticates.
        env: 'GCP_SERVICE_ACCOUNT_JSON',
        read: () => config.BIGQUERY.SERVICE_ACCOUNT_JSON || config.BIGQUERY.ADC_CREDENTIALS_PATH
    }
];

/**
 * The TIER-1 table, in SETUP order — database, then the operator account, then
 * Shopify. The first missing key is reported first, so an operator working
 * through a fresh install is walked forwards rather than bounced between
 * unrelated sections.
 */
const TIER_1_KEYS: RequiredKey[] = [
    {
        env: 'MONGO_URI',
        path: 'config.MONGO.URI',
        why: 'Without a database there is nowhere to keep the history that makes past months answerable.',
        example: 'MONGO_URI=mongodb://127.0.0.1:27017/shopify-app-analytics',
        read: () => config.MONGO.URI,
        checkUsable: (value: string) => {
            if (!value.startsWith('mongodb://') && !value.startsWith('mongodb+srv://')) {
                return 'it must start with mongodb:// or mongodb+srv://';
            }
            return null;
        }
    },
    {
        env: 'JWT_SECRET',
        path: 'config.AUTH.JWT_SECRET',
        why: 'This signs your session tokens. There is deliberately no default: a shared default would let anyone mint an admin token for any install.',
        example: 'JWT_SECRET=' + '<paste the output of: openssl rand -hex 32>',
        read: () => config.AUTH.JWT_SECRET,
        checkUsable: (value: string) => {
            if (value.length < MIN_JWT_SECRET_LENGTH) {
                return `it is ${value.length} characters; use at least ${MIN_JWT_SECRET_LENGTH} (openssl rand -hex 32)`;
            }
            return null;
        }
    },
    {
        env: 'ADMIN_EMAIL',
        path: 'config.AUTH.ADMIN_EMAIL',
        why: 'The single operator account that can sign in. There is no sign-up flow.',
        example: 'ADMIN_EMAIL=you@yourcompany.com',
        read: () => config.AUTH.ADMIN_EMAIL,
        checkUsable: (value: string) => {
            if (!value.includes('@')) {
                return 'it does not look like an email address';
            }
            return null;
        }
    },
    {
        // EITHER of two variables satisfies this requirement, so the label is resolved above from
        // whichever one the operator actually set. Both are checked here rather than in the seeder,
        // because a password problem discovered at first boot is a message on the console, while one
        // discovered at first LOGIN is an operator locked out of their own dashboard.
        env: ADMIN_SECRET_ENV,
        path: 'config.AUTH.ADMIN_PASSWORD_HASH / config.AUTH.ADMIN_PASSWORD',
        why: 'The operator password. Set ADMIN_PASSWORD (plaintext, hashed with bcrypt at first boot) or, preferably, ADMIN_PASSWORD_HASH — a plaintext password in the environment is readable in ps output, shell history and container inspects.',
        example: 'ADMIN_PASSWORD=a-long-passphrase   # or: ADMIN_PASSWORD_HASH=$2b$12$....  from  node -e "console.log(require(\'bcryptjs\').hashSync(process.argv[1], 12))" \'your password\'',
        read: () => config.AUTH.ADMIN_PASSWORD_HASH || config.AUTH.ADMIN_PASSWORD,
        checkUsable: (value: string) => {
            if (config.AUTH.ADMIN_PASSWORD_HASH) {
                if (!BCRYPT_HASH_RE.test(value)) {
                    return 'it is not a bcrypt hash — this variable takes the HASH; put the password itself in ADMIN_PASSWORD instead';
                }
                return null;
            }
            if (BCRYPT_HASH_RE.test(value)) {
                // Hashing a hash produces a value that looks entirely valid and matches nothing
                // anybody can type. Caught here rather than at the login screen.
                return 'it is already a bcrypt hash — set it as ADMIN_PASSWORD_HASH, or it will be hashed a second time and match nothing';
            }
            if (value.length < MIN_ADMIN_PASSWORD_LENGTH) {
                return `it is ${value.length} characters; use at least ${MIN_ADMIN_PASSWORD_LENGTH} — this is the only credential on the whole deployment`;
            }
            return null;
        }
    },
    {
        env: 'SHOPIFY_PARTNER_ORG_ID',
        path: 'config.PARTNER.ORG_ID',
        why: 'Identifies which Partner organisation to read. It is the number in your Partner dashboard URL.',
        example: 'SHOPIFY_PARTNER_ORG_ID=1234567',
        read: () => config.PARTNER.ORG_ID,
        checkUsable: (value: string) => {
            if (!/^\d+$/.test(value)) {
                return 'it must be the numeric organisation id from https://partners.shopify.com/<ORG_ID>/...';
            }
            return null;
        }
    },
    {
        env: 'SHOPIFY_PARTNER_API_TOKEN',
        path: 'config.PARTNER.API_TOKEN',
        why: 'Read-only Partner API access token. Everything from installs onward is reconstructed from what this token can read.',
        example: 'SHOPIFY_PARTNER_API_TOKEN=prtapi_xxxxxxxxxxxxxxxxxxxxxxxx',
        read: () => config.PARTNER.API_TOKEN
    },
    {
        env: 'SHOPIFY_PARTNER_API_VERSION',
        path: 'config.PARTNER.API_VERSION',
        why: 'Partner API version. It has a default, but an out-of-shape value is worth catching here rather than as a 404 at 3am.',
        example: 'SHOPIFY_PARTNER_API_VERSION=2026-07',
        read: () => config.PARTNER.API_VERSION,
        checkUsable: (value: string) => {
            if (!/^\d{4}-\d{2}$/.test(value)) {
                return `'${value}' is not a Shopify API version — the form is YYYY-MM`;
            }
            return null;
        }
    }
];

/**
 * Builds the operator-facing text for one missing or unusable TIER-1 key.
 *
 * @param key - The requirement that failed.
 * @param unusableReason - Null when the value is absent; otherwise why the present value cannot be used.
 * @returns The named problem, ready to print.
 */
const _describeProblem = (key: RequiredKey, unusableReason: string | null): ConfigProblem => {
    let message = `${key.env} is not set.`;
    if (unusableReason) {
        message = `${key.env} is set, but ${unusableReason}.`;
    }
    const detail = [
        `  ${key.why}`,
        '',
        '  Add this to your .env file:',
        '',
        `      ${key.example}`,
        '',
        `  (Read at ${key.path}.)`
    ].join('\n');
    return { env: key.env, message, detail };
};

/**
 * Checks the resolved configuration WITHOUT touching the process.
 *
 * Kept separate from `validateConfig` so the rules can be unit-tested — a
 * validator that can only be exercised by killing the test runner does not get
 * tested, and then the boot-time guard is itself unverified.
 *
 * @returns `{ problems, warnings }` — TIER-1 failures in setup order, and non-fatal notes.
 */
const collectConfigProblems = (): { problems: ConfigProblem[]; warnings: string[] } => {
    const problems: ConfigProblem[] = [];
    const warnings: string[] = [];

    for (const key of TIER_1_KEYS) {
        const value = key.read();
        if (!value) {
            problems.push(_describeProblem(key, null));
            continue;
        }
        if (key.checkUsable) {
            const reason = key.checkUsable(value);
            if (reason) {
                problems.push(_describeProblem(key, reason));
            }
        }
    }

    // ── Optional capabilities ───────────────────────────────────────────────
    // Each of these reduces what the dashboard can answer. None of them is a
    // reason to refuse to boot, because a partial dashboard that says which
    // parts are partial is more useful than no dashboard.

    if (!config.PARTNER.APP_ID) {
        warnings.push(
            'SHOPIFY_PARTNER_APP_ID is not set, so NOTHING WILL SYNC. Nothing discovers it for you: ' +
            'registerPartnerAppFromConfig returns early when it is blank, so no app row is created and every sync has no target. ' +
            'This variable is documented as optional but behaves as required — set it to the app id from your Partner dashboard URL.'
        );
    }

    if (!config.REVENUE.HISTORY_FLOOR_DATE) {
        warnings.push(
            'REVENUE_HISTORY_FLOOR_DATE is not set. Months before your records begin will be computed from partial history and will under-report ' +
            'instead of being published as "unknown". Set it to the date your data actually starts (YYYY-MM-DD).'
        );
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(config.REVENUE.HISTORY_FLOOR_DATE)) {
        warnings.push(
            `REVENUE_HISTORY_FLOOR_DATE is '${config.REVENUE.HISTORY_FLOOR_DATE}', which is not a YYYY-MM-DD date. It will be ignored.`
        );
    }

    // ── The BigQuery / listing-analytics tier ───────────────────────────────
    // Optional in full. It WARNS in three shapes and exits in none of them,
    // because a dashboard that answers everything from installs onward is worth
    // booting even when it cannot answer anything about the listing.
    const _bqMissing = BIGQUERY_REQUIRED_ENV.filter((key) => !key.read()).map((key) => key.env);
    const _bqSetCount = BIGQUERY_REQUIRED_ENV.length - _bqMissing.length;

    if (_bqSetCount === 0) {
        warnings.push(
            'The BigQuery tier is not configured (GCP_PROJECT_ID, BQ_DATASET, GCP_SERVICE_ACCOUNT_JSON). ' +
            'Traffic Sources and the upper steps of the funnel — listing views, engaged views, install clicks — ' +
            'have no data source. Those views will say so and name the variable; they will NOT show zeros. ' +
            'Everything from installs onward is unaffected.'
        );
    } else if (_bqMissing.length > 0) {
        //  The dangerous shape, and the reason this warning is separate from the one above. A
        // half-filled .env LOOKS configured to the person who filled it, syncs nothing, and leaves
        // every listing view empty — so the missing variables are named individually rather than
        // being folded into "the tier is off".
        warnings.push(
            `The BigQuery tier is PARTIALLY configured: ${_bqSetCount} of ${BIGQUERY_REQUIRED_ENV.length} settings are present and ` +
            `${_bqMissing.join(', ')} ${_bqMissing.length === 1 ? 'is' : 'are'} missing. It is treated as OFF — ` +
            'a partial connection cannot run a query, and half a credential set is not a smaller version of a working one.'
        );
    }

    if (config.BIGQUERY.ENABLED && !/^\d{4}-\d{2}-\d{2}$/.test(config.BIGQUERY.LIFETIME_FLOOR_DATE)) {
        //  Not cosmetic. The floor is parsed into a `YYYYMMDD` table suffix, and an unparseable
        // date yields a suffix BigQuery matches no table against — a query that succeeds, costs
        // nothing, and returns zero rows. The sync refuses by name rather than shipping that, so
        // this warning is the earlier of two chances to notice.
        warnings.push(
            `BQ_LIFETIME_FLOOR_DATE is '${config.BIGQUERY.LIFETIME_FLOOR_DATE}', which is not a YYYY-MM-DD date. ` +
            'A LIFETIME BigQuery sync will refuse to run rather than scan an unparseable window.'
        );
    }

    // ── The login throttle, and whose address it counts ─────────────────────
    // Both of these are about a security control being weaker than its configuration reads, which
    // is the exact failure this project just spent a change fixing: two keys that described a limit
    // nothing enforced. A control that is off, or that is bucketing every caller together, should
    // say so at boot rather than be discovered during an incident.

    if (config.AUTH.LOGIN_RATE_LIMIT_MAX <= 0) {
        warnings.push(
            `AUTH_LOGIN_RATE_LIMIT_MAX is ${config.AUTH.LOGIN_RATE_LIMIT_MAX}, which DISABLES login rate limiting. ` +
            'POST /api/auth/login is one of two endpoints reachable without a token and guards the only credential ' +
            'on this deployment; nothing now limits how fast it can be guessed. That is a supported setting — put ' +
            'the limit in your reverse proxy instead if you meant it.'
        );
    } else if (!config.APP.TRUST_PROXY) {
        // NOT pedantry. This backend always sits behind the dashboard's server-side proxy, so with
        // nothing trusted every caller resolves to that proxy's address and shares ONE bucket.
        // That is the SAFE direction to be wrong in, and since the limiter grew a trickle it is no
        // longer a lockout either — see src/middlewares/loginRateLimit.ts.
        warnings.push(
            'TRUST_PROXY is not set, so every request appears to come from whichever machine opened the socket — ' +
            'which, because the dashboard proxies /api to this backend server-side, is always the dashboard itself. ' +
            `AUTH_LOGIN_RATE_LIMIT_MAX=${config.AUTH.LOGIN_RATE_LIMIT_MAX} is therefore enforced per DEPLOYMENT, not per source address. ` +
            'This is the RECOMMENDED setting for the bundled docker-compose stack: the dashboard forwards a ' +
            'client-supplied X-Forwarded-For unchanged, so no value of TRUST_PROXY makes the caller address ' +
            'trustworthy there. Set it only when a real reverse proxy (nginx, Caddy, Traefik) sits in front and ' +
            'OVERWRITES that header.'
        );
    } else {
        // Anything OTHER than unset means an X-Forwarded-For is being believed. That is correct only
        // behind a proxy that overwrites the header, and wrong behind the bundled one, which does not.
        //
        // Measured against proxy-addr rather than assumed: with a private-range peer and
        // TRUST_PROXY=uniquelocal, req.ip becomes whatever the caller put in X-Forwarded-For — a
        // fresh rate-limit bucket per request. Next's rewrite proxy sets that header with `??=` and
        // passes http-proxy no `xfwd`, so a client-supplied value arrives here untouched.
        const _trustLabel = config.APP.TRUST_PROXY === true ? 'true' : String(config.APP.TRUST_PROXY);
        warnings.push(
            `TRUST_PROXY=${_trustLabel} makes this process BELIEVE the X-Forwarded-For header. That is correct only if ` +
            'a reverse proxy in front of it OVERWRITES that header on every request. It is WRONG behind the bundled ' +
            'docker-compose stack: the dashboard forwards a caller-supplied X-Forwarded-For unchanged, so every login ' +
            'attempt can claim a different source address, land in a fresh bucket, and never reach ' +
            `AUTH_LOGIN_RATE_LIMIT_MAX=${config.AUTH.LOGIN_RATE_LIMIT_MAX}. The deployment-wide budget still applies ` +
            '(see loginRateLimit.ts), but the per-address limit you configured does not. Unset TRUST_PROXY unless a ' +
            'real proxy is terminating requests in front of this process.'
        );
    }

    if (config.SYNC.DISABLED) {
        warnings.push(
            'SYNC_DISABLED=true. The API will serve whatever is already stored, and nothing will be refreshed. ' +
            'Every figure you see is as old as your last successful sync.'
        );
    }

    const knownLevels = ['debug', 'info', 'warn', 'error', 'silent'];
    if (!knownLevels.includes(config.LOG.LEVEL)) {
        warnings.push(
            `LOG_LEVEL is '${config.LOG.LEVEL}', which is not one of ${knownLevels.join(', ')}. Falling back to 'info'.`
        );
    }

    if (config.APP.NODE_ENV === 'production' && config.PARTNER.API_BASE_URL !== 'https://partners.shopify.com') {
        warnings.push(
            `SHOPIFY_PARTNER_API_BASE_URL is overridden to '${config.PARTNER.API_BASE_URL}' in production. ` +
            'That override exists for test fixtures — every figure on the dashboard is coming from somewhere other than Shopify.'
        );
    }

    return { problems, warnings };
};

/**
 * Validates configuration at boot.
 *
 * On the FIRST missing or unusable TIER-1 key: prints the key by name, what it
 * is for, and the line to add — then exits non-zero, so a process manager
 * reports a failed start rather than restarting into the same wrong state.
 * Any further TIER-1 problems are listed underneath, so a fresh install can be
 * fixed in one pass instead of one restart per variable.
 *
 * Optional-capability problems are printed as warnings and do not stop the boot.
 *
 * @returns Returns only when the configuration is usable.
 */
const validateConfig = (): void => {
    const { problems, warnings } = collectConfigProblems();

    for (const warning of warnings) {
        process.stderr.write(`WARN: config: ${warning}\n`);
    }

    if (!problems.length) {
        return;
    }

    const first = problems[0];
    const lines: string[] = [
        '',
        '============================================================',
        ` CONFIGURATION ERROR: ${first.message}`,
        '============================================================',
        '',
        first.detail,
        ''
    ];

    if (problems.length > 1) {
        lines.push(`  ${problems.length - 1} other required setting(s) also need attention:`);
        for (const problem of problems.slice(1)) {
            lines.push(`    - ${problem.message}`);
        }
        lines.push('');
    }

    lines.push('Refusing to start. A backend that boots without these serves numbers built from nothing.');
    lines.push('');

    process.stderr.write(lines.join('\n'));
    process.exit(1);
};

export = {
    validateConfig,
    collectConfigProblems
};
