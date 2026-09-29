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
 *    TIER-1   — the app cannot produce a correct number, or cannot let anyone
 *               in, without it. Missing one exits non-zero.
 *    OPTIONAL — a capability is reduced, and the affected views say so at
 *               runtime rather than showing zeros. Missing one warns.
 *
 *  This module writes to stderr DIRECTLY rather than through core/logger, for
 *  two reasons: a configuration failure must print even when `LOG_LEVEL=silent`,
 *  and the logger reads the very config being validated.
 *
 *  The checkers below that take a value rather than the config (`checkPublicUrl`,
 *  `isLoopbackPublicUrl`, `isBareEmailAddress`) are exported so the recovery CLI
 *  and the auth and mail modules apply the SAME rule this file refuses to boot on,
 *  instead of a second spelling of it.
 * ============================================================================
 */

import net = require('net');
import config = require('./index');

/** The resolved configuration's shape. `collectConfigProblems` accepts one so tests can vary it. */
type ConfigShape = typeof config;

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
    read: (cfg: ConfigShape) => string;
    /**
     * Optional extra check applied to a NON-empty value. Returning a string
     * means "present but unusable", and the string explains why.
     */
    checkUsable?: (value: string, cfg: ConfigShape) => string | null;
}

/** A problem found in the resolved config: which key, and what to say about it. */
interface ConfigProblem {
    env: string;
    message: string;
    detail: string;
}

/** Everything `collectConfigProblems` found. */
interface ConfigReport {
    /** TIER-1 failures, in setup order. Any entry stops the boot. */
    problems: ConfigProblem[];
    /** Non-fatal notes, printed as `WARN: config:` lines. */
    warnings: string[];
    /**
     * A banner printed ABOVE the configuration error when this looks like an upgrade from the
     * single-operator build that has not yet set the settings this build added. Null otherwise.
     */
    upgrade_notice: string | null;
}

/** Anything shorter than this is guessable; a shared or blank secret is a full compromise. */
const MIN_JWT_SECRET_LENGTH = 32;

/** The three settings this build requires that the single-operator build did not. */
const UPGRADE_REQUIRED_ENV = ['APP_PUBLIC_URL', 'SMTP_HOST', 'SMTP_FROM'];

/** The DEPLOYMENT.md section the upgrade banner sends people to. Named, never a line number. */
const UPGRADE_DOC_SECTION = 'DEPLOYMENT.md, section "Upgrading from a single-operator build"';

/** RFC 5321's path limit. */
const MAX_EMAIL_LENGTH = 254;
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * Characters that turn one address into a header phrase, a group or a LIST of addresses. A `to` of
 * `a@x.com, b@y.com` is two recipients to a mail library, so they are refused rather than escaped.
 */
const EMAIL_FORBIDDEN_CHARS_RE = /[,;<>"()[\]\\:]/;
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/;

/** Gmail's SMTP host, and the length of the app passwords it issues (four groups of four letters). */
const GMAIL_SMTP_HOST = 'smtp.gmail.com';
const GMAIL_APP_PASSWORD_LENGTH = 16;

/** The compose service name and port of the backend — where the dashboard proxies to, not where people browse. */
const INTERNAL_BACKEND_HOST = 'backend';
const INTERNAL_BACKEND_PORT = '8080';

/**
 * Whether a string is ONE bare email address — `name@example.com`, nothing around it.
 *
 * No display name, no angle brackets, no list separators, no control characters, exactly one `@`,
 * at most 254 characters. Case is not touched: this is a predicate, not a normaliser.
 *
 * @param value - Anything.
 * @returns True only for a single bare address.
 */
const isBareEmailAddress = (value: unknown): boolean => {
    if (typeof value !== 'string') {
        return false;
    }
    if (!value || value.length > MAX_EMAIL_LENGTH) {
        return false;
    }
    if (value.split('@').length !== 2) {
        return false;
    }
    if (CONTROL_CHARS_RE.test(value) || EMAIL_FORBIDDEN_CHARS_RE.test(value)) {
        return false;
    }
    return EMAIL_SHAPE_RE.test(value);
};

/** Scheme plus authority, matched on the RAW text so the check does not depend on URL normalisation. */
const PUBLIC_URL_PREFIX_RE = /^https?:\/\/[^/?#]+/i;

/**
 * Checks an `APP_PUBLIC_URL` value: an absolute http(s) address with no credentials, no path other
 * than `/`, and no query or fragment.
 *
 * Both the raw text and the parsed URL are checked, because each misses something the other sees:
 * `new URL()` quietly turns `https:\\host\x` into a path and drops an empty `?`, and the raw text
 * cannot see a user name hiding in front of an `@`.
 *
 * @param value - The configured value (config has already stripped trailing slashes).
 * @returns Null when usable; otherwise why not, phrased to follow "APP_PUBLIC_URL is set, but ".
 */
const checkPublicUrl = (value: string): string | null => {
    if (typeof value !== 'string' || !value) {
        return 'it is empty';
    }
    const prefix = PUBLIC_URL_PREFIX_RE.exec(value);
    if (!prefix) {
        return 'it must be an absolute address starting with https:// (or http:// for a machine-local install), like https://analytics.yourcompany.com';
    }

    let url: URL;
    try {
        url = new URL(value);
    } catch (parseError) {
        return 'it is not a valid URL';
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return 'it must start with https:// or http://';
    }
    if (url.username || url.password) {
        return 'it contains a user name or password — remove the "user:pass@" part';
    }
    if (!url.hostname) {
        return 'it has no host name';
    }

    const rest = value.slice(prefix[0].length);
    if (url.search || url.hash || rest.includes('?') || rest.includes('#')) {
        return 'it has a query string or fragment — give only the site address';
    }
    if ((rest !== '' && rest !== '/') || url.pathname !== '/') {
        return `it has a path (${url.pathname}) — give the site's root address only; every link adds its own path to it`;
    }
    return null;
};

/**
 * Whether a host name only ever reaches the machine it is typed on: `localhost` (and `*.localhost`),
 * 127.0.0.0/8, `::1`, and the unspecified addresses `0.0.0.0` / `::`, which browsers send to the
 * local machine.
 *
 * @param hostname - A URL host name. IPv6 brackets are accepted.
 * @returns True for a loopback host.
 */
const _isLoopbackHost = (hostname: string): boolean => {
    const host = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost')) {
        return true;
    }
    if (net.isIPv4(host)) {
        return host.startsWith('127.') || host === '0.0.0.0';
    }
    if (net.isIPv6(host)) {
        // `::ffff:7f..` is an IPv4-mapped 127.x address after URL normalisation.
        return host === '::1' || host === '::' || host.startsWith('::ffff:7f');
    }
    return false;
};

/**
 * Whether links built from this public URL will only open on the machine that runs the server.
 *
 * The ONE definition of that fact: validation warns with it, and the invite endpoints report it as
 * `link_host_is_loopback` so the Users page can say the same thing.
 *
 * @param publicUrl - A value that passed `checkPublicUrl`, normally `config.APP.PUBLIC_URL`.
 * @returns True when the host is loopback; false for anything else, including an unparseable value.
 */
const isLoopbackPublicUrl = (publicUrl: string): boolean => {
    try {
        return _isLoopbackHost(new URL(publicUrl).hostname);
    } catch (parseError) {
        return false;
    }
};

/**
 * Checks the `SMTP_HOST` value's shape. Only catches the pastes that can never work — a URL, a
 * path, a port glued on — never whether the server exists; the boot mail check does that.
 *
 * @param value - The configured host.
 * @returns Null when usable; otherwise why not.
 */
const _checkSmtpHost = (value: string): string | null => {
    if (value.includes('://') || value.includes('/')) {
        return 'it must be a bare host name such as smtp.gmail.com — no scheme or path';
    }
    if (/\s/.test(value)) {
        return 'it contains whitespace';
    }
    if (/^[^:]+:\d+$/.test(value)) {
        return 'it includes a port — put only the host name here and the port in SMTP_PORT';
    }
    return null;
};

/**
 * The BigQuery tier's three required variables, in the order an operator sets them.
 *
 * Used ONLY to name what is missing in a warning. This tier is optional end to end — nothing here
 * can produce a TIER-1 problem, and no branch of it reaches `process.exit`.
 */
const BIGQUERY_REQUIRED_ENV: { env: string; read: (cfg: ConfigShape) => string }[] = [
    { env: 'GCP_PROJECT_ID', read: (cfg) => cfg.BIGQUERY.PROJECT_ID },
    { env: 'BQ_DATASET', read: (cfg) => cfg.BIGQUERY.DATASET },
    {
        // Either of two satisfies this one: an inline/keyfile service account, or Google's own
        // Application Default Credentials, which is how a process running ON GCP authenticates.
        env: 'GCP_SERVICE_ACCOUNT_JSON',
        read: (cfg) => cfg.BIGQUERY.SERVICE_ACCOUNT_JSON || cfg.BIGQUERY.ADC_CREDENTIALS_PATH
    }
];

/**
 * The TIER-1 table, in SETUP order — database, signing secret, the address
 * links are built from, the mail server that delivers them, then Shopify. The
 * first missing key is reported first, so an operator working through a fresh
 * install is walked forwards rather than bounced between unrelated sections.
 */
const TIER_1_KEYS: RequiredKey[] = [
    {
        env: 'MONGO_URI',
        path: 'config.MONGO.URI',
        why: 'Without a database there is nowhere to keep the history that makes past months answerable.',
        example: 'MONGO_URI=mongodb://127.0.0.1:27017/shopify-app-analytics',
        read: (cfg) => cfg.MONGO.URI,
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
        why: 'This signs your session tokens. There is deliberately no default: a shared default would let anyone mint a correctly signed token for any install.',
        example: 'JWT_SECRET=' + '<paste the output of: openssl rand -hex 32>',
        read: (cfg) => cfg.AUTH.JWT_SECRET,
        checkUsable: (value: string) => {
            if (value.length < MIN_JWT_SECRET_LENGTH) {
                return `it is ${value.length} characters; use at least ${MIN_JWT_SECRET_LENGTH} (openssl rand -hex 32)`;
            }
            return null;
        }
    },
    {
        env: 'APP_PUBLIC_URL',
        path: 'config.APP.PUBLIC_URL',
        why: 'The address people open the dashboard at. Every link in a setup, invitation or password-reset email is built from it — never from the incoming request, whose Host header is written by whoever sends it.',
        example: 'APP_PUBLIC_URL=https://analytics.yourcompany.com',
        read: (cfg) => cfg.APP.PUBLIC_URL,
        checkUsable: (value: string) => checkPublicUrl(value)
    },
    {
        env: 'SMTP_HOST',
        path: 'config.MAIL.SMTP_HOST',
        why: 'Setup verification, invitations and password resets are delivered by email; the dashboard has no other way to finish setup, let anyone join, or recover an account. Gmail works with an app password.',
        example: 'SMTP_HOST=smtp.gmail.com   # with SMTP_PORT=465, SMTP_SECURE=true, SMTP_USER, SMTP_PASS (an app password)',
        read: (cfg) => cfg.MAIL.SMTP_HOST,
        checkUsable: (value: string) => _checkSmtpHost(value)
    },
    {
        env: 'SMTP_FROM',
        path: 'config.MAIL.SMTP_FROM',
        why: 'The sender address on every email this install sends. It falls back to SMTP_USER when that is an email address; a relay whose login is not an address (SendGrid logs in as "apikey") needs it set.',
        example: 'SMTP_FROM=analytics@yourcompany.com',
        read: (cfg) => cfg.MAIL.SMTP_FROM,
        checkUsable: (value: string, cfg: ConfigShape) => {
            let reason: string | null = null;
            if (value.includes('<') || value.includes('>')) {
                reason = 'it contains a display name — put only the address in SMTP_FROM (analytics@yourcompany.com) and the name in SMTP_FROM_NAME';
            } else if (!isBareEmailAddress(value)) {
                reason = 'it is not a single bare email address like analytics@yourcompany.com';
            }
            if (reason && value === cfg.MAIL.SMTP_USER) {
                reason += ' (if you left SMTP_FROM blank, this is SMTP_USER, which is used in its place)';
            }
            return reason;
        }
    },
    {
        env: 'SHOPIFY_PARTNER_ORG_ID',
        path: 'config.PARTNER.ORG_ID',
        why: 'Identifies which Partner organisation to read. It is the number in your Partner dashboard URL.',
        example: 'SHOPIFY_PARTNER_ORG_ID=1234567',
        read: (cfg) => cfg.PARTNER.ORG_ID,
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
        read: (cfg) => cfg.PARTNER.API_TOKEN
    },
    {
        env: 'SHOPIFY_PARTNER_API_VERSION',
        path: 'config.PARTNER.API_VERSION',
        why: 'Partner API version. It has a default, but an out-of-shape value is worth catching here rather than as a 404 at 3am.',
        example: 'SHOPIFY_PARTNER_API_VERSION=2026-07',
        read: (cfg) => cfg.PARTNER.API_VERSION,
        checkUsable: (value: string) => {
            if (!/^\d{4}-\d{2}$/.test(value)) {
                return `'${value}' is not a Shopify API version — the form is YYYY-MM`;
            }
            return null;
        }
    }
];

/**
 * Lays out the explanatory block under a problem's headline.
 *
 * @param why - What breaks, in a sentence.
 * @param example - The line to add.
 * @param path - Where the value is read, `config.<SECTION>.<FIELD>`.
 * @returns The indented block.
 */
const _formatDetail = (why: string, example: string, path: string): string => {
    return [
        `  ${why}`,
        '',
        '  Add this to your .env file:',
        '',
        `      ${example}`,
        '',
        `  (Read at ${path}.)`
    ].join('\n');
};

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
    return { env: key.env, message, detail: _formatDetail(key.why, key.example, key.path) };
};

/**
 * The banner for an upgrade from the single-operator build that has not set this build's new
 * required settings yet — the one situation where "SMTP_HOST is not set" alone would leave the
 * reader asking why a working install suddenly needs a mail server.
 *
 * @param missing - Which of the three new settings have a problem.
 * @returns The banner text.
 */
const _buildUpgradeNotice = (missing: string[]): string => {
    return [
        '============================================================',
        ' UPGRADING FROM A SINGLE-OPERATOR BUILD',
        '============================================================',
        '',
        '  ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_PASSWORD_HASH are set, so this looks like an upgrade',
        '  from the single-operator build. This build signs people in with accounts created on a',
        '  first-run setup screen and by emailed invitation, and it needs three settings that build',
        '  did not:',
        '',
        '      APP_PUBLIC_URL   the address people open the dashboard at; email links are built from it',
        '      SMTP_HOST        your mail server (Gmail: smtp.gmail.com with an app password)',
        '      SMTP_FROM        the sender address on those emails',
        '',
        `  Still needing attention: ${missing.join(', ')}.`,
        `  Walk-through: ${UPGRADE_DOC_SECTION}.`,
        ''
    ].join('\n');
};

/**
 * Checks the resolved configuration WITHOUT touching the process.
 *
 * Kept separate from `validateConfig` so the rules can be unit-tested — a
 * validator that can only be exercised by killing the test runner does not get
 * tested, and then the boot-time guard is itself unverified.
 *
 * `src/config` snapshots `process.env` once, at first require, so a test cannot
 * vary the environment between cases in one process. It passes a config-shaped
 * object instead: `collectConfigProblems({ ...config, MAIL: { ...config.MAIL, SMTP_HOST: '' } })`.
 *
 * @param cfg - The configuration to check. Defaults to the real one.
 * @returns `{ problems, warnings, upgrade_notice }` — TIER-1 failures in setup order, non-fatal
 * notes, and the upgrade banner (or null).
 */
const collectConfigProblems = (cfg: ConfigShape = config): ConfigReport => {
    const problems: ConfigProblem[] = [];
    const warnings: string[] = [];

    for (const key of TIER_1_KEYS) {
        const value = key.read(cfg);
        if (!value) {
            problems.push(_describeProblem(key, null));
            continue;
        }
        if (key.checkUsable) {
            const reason = key.checkUsable(value, cfg);
            if (reason) {
                problems.push(_describeProblem(key, reason));
            }
        }
    }

    // ── Problems that are not "one key missing" ─────────────────────────────
    // Pairs and optional values that, once set, must be right: a half-set login or a pin nobody can
    // match fails later and quietly (a 535 in a log; a setup email that never arrives, by design
    // indistinguishable from a wrong address), so they are refused here, by name.

    const _hasSmtpUser = Boolean(cfg.MAIL.SMTP_USER);
    const _hasSmtpPass = Boolean(cfg.MAIL.SMTP_PASS);
    if (_hasSmtpUser !== _hasSmtpPass) {
        const setEnv = _hasSmtpUser ? 'SMTP_USER' : 'SMTP_PASS';
        const unsetEnv = _hasSmtpUser ? 'SMTP_PASS' : 'SMTP_USER';
        problems.push({
            env: unsetEnv,
            message: `${setEnv} is set, but ${unsetEnv} is not.`,
            detail: _formatDetail(
                'Set both (a server that needs a login, such as Gmail) or neither (a relay that accepts mail without one). One without the other can never log in.',
                'SMTP_USER=you@gmail.com   SMTP_PASS=<a Gmail app password, or your SMTP password>',
                'config.MAIL.SMTP_USER / config.MAIL.SMTP_PASS'
            )
        });
    }

    if (!Number.isInteger(cfg.MAIL.SMTP_PORT) || cfg.MAIL.SMTP_PORT < 1 || cfg.MAIL.SMTP_PORT > 65535) {
        problems.push({
            env: 'SMTP_PORT',
            message: `SMTP_PORT is set, but ${cfg.MAIL.SMTP_PORT} is not a TCP port.`,
            detail: _formatDetail(
                'The port the mail server listens on: 465 with SMTP_SECURE=true, or 587 (STARTTLS). Leave it unset to get the matching default.',
                'SMTP_PORT=465',
                'config.MAIL.SMTP_PORT'
            )
        });
    }

    if (cfg.AUTH.SETUP_OWNER_EMAIL && !isBareEmailAddress(cfg.AUTH.SETUP_OWNER_EMAIL)) {
        problems.push({
            env: 'SETUP_OWNER_EMAIL',
            message: 'SETUP_OWNER_EMAIL is set, but it is not a single bare email address.',
            detail: _formatDetail(
                'It pins which address may claim first-run setup. A value no address can match would leave setup unclaimable, and the setup screen answers every request identically, so nothing would say why.',
                'SETUP_OWNER_EMAIL=you@yourcompany.com',
                'config.AUTH.SETUP_OWNER_EMAIL'
            )
        });
    }

    let upgrade_notice: string | null = null;
    if (cfg.AUTH.LEGACY_ADMIN_ENV_PRESENT) {
        const upgradeMissing = UPGRADE_REQUIRED_ENV.filter((env) => problems.some((problem) => problem.env === env));
        if (upgradeMissing.length) {
            upgrade_notice = _buildUpgradeNotice(upgradeMissing);
        }
    }

    // ── Optional capabilities ───────────────────────────────────────────────
    // Each of these reduces what the dashboard can answer. None of them is a
    // reason to refuse to boot, because a partial dashboard that says which
    // parts are partial is more useful than no dashboard.

    if (!cfg.PARTNER.APP_ID) {
        warnings.push(
            'SHOPIFY_PARTNER_APP_ID is not set, so NOTHING WILL SYNC. Nothing discovers it for you: ' +
            'registerPartnerAppFromConfig returns early when it is blank, so no app row is created and every sync has no target. ' +
            'This variable is documented as optional but behaves as required — set it to the app id from your Partner dashboard URL.'
        );
    }

    if (!cfg.REVENUE.HISTORY_FLOOR_DATE) {
        warnings.push(
            'REVENUE_HISTORY_FLOOR_DATE is not set. Months before your records begin will be computed from partial history and will under-report ' +
            'instead of being published as "unknown". Set it to the date your data actually starts (YYYY-MM-DD).'
        );
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.REVENUE.HISTORY_FLOOR_DATE)) {
        warnings.push(
            `REVENUE_HISTORY_FLOOR_DATE is '${cfg.REVENUE.HISTORY_FLOOR_DATE}', which is not a YYYY-MM-DD date. It will be ignored.`
        );
    }

    // ── The BigQuery / listing-analytics tier ───────────────────────────────
    // Optional in full. It WARNS in three shapes and exits in none of them,
    // because a dashboard that answers everything from installs onward is worth
    // booting even when it cannot answer anything about the listing.
    const _bqMissing = BIGQUERY_REQUIRED_ENV.filter((key) => !key.read(cfg)).map((key) => key.env);
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

    if (cfg.BIGQUERY.ENABLED && !/^\d{4}-\d{2}-\d{2}$/.test(cfg.BIGQUERY.LIFETIME_FLOOR_DATE)) {
        //  Not cosmetic. The floor is parsed into a `YYYYMMDD` table suffix, and an unparseable
        // date yields a suffix BigQuery matches no table against — a query that succeeds, costs
        // nothing, and returns zero rows. The sync refuses by name rather than shipping that, so
        // this warning is the earlier of two chances to notice.
        warnings.push(
            `BQ_LIFETIME_FLOOR_DATE is '${cfg.BIGQUERY.LIFETIME_FLOOR_DATE}', which is not a YYYY-MM-DD date. ` +
            'A LIFETIME BigQuery sync will refuse to run rather than scan an unparseable window.'
        );
    }

    // ── Sign-in, links and mail ─────────────────────────────────────────────
    // Each of these is a setting that boots fine and then fails a person rather than a process: a
    // link that opens nowhere, a message that never leaves, a password typed over plain HTTP.

    if (cfg.AUTH.LEGACY_ADMIN_ENV_PRESENT) {
        warnings.push(
            'ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_PASSWORD_HASH are ignored by this build — delete them once you no longer need ' +
            'to roll back to a single-operator build. Sign-in uses the accounts created on the setup screen and by invitation.'
        );
    }

    if (cfg.APP.PUBLIC_URL && !checkPublicUrl(cfg.APP.PUBLIC_URL)) {
        const publicUrl = new URL(cfg.APP.PUBLIC_URL);
        if (isLoopbackPublicUrl(cfg.APP.PUBLIC_URL)) {
            warnings.push(
                `APP_PUBLIC_URL is ${cfg.APP.PUBLIC_URL}: links in invitation and password-reset emails will only open on this machine. ` +
                'Set it to the address other people use to reach the dashboard.'
            );
        } else if (publicUrl.protocol === 'http:') {
            warnings.push(
                `APP_PUBLIC_URL is ${cfg.APP.PUBLIC_URL}, plain HTTP on a host other than this machine. The setup, invitation and ` +
                'password-reset pages — and the passwords typed into them — would cross the network unencrypted. Serve the dashboard over https://.'
            );
        }
        if (publicUrl.hostname.toLowerCase() === INTERNAL_BACKEND_HOST || publicUrl.port === INTERNAL_BACKEND_PORT) {
            warnings.push(
                `APP_PUBLIC_URL is ${cfg.APP.PUBLIC_URL}, which looks like the backend's internal address (the host "backend" or port 8080 ` +
                'is where the dashboard proxies to inside the compose network). Email links are built from APP_PUBLIC_URL, so it must be the ' +
                'address people open in a browser — the dashboard\'s public URL.'
            );
        }
    }

    if (cfg.MAIL.SMTP_ALLOW_INSECURE) {
        warnings.push(
            'SMTP_ALLOW_INSECURE=true. The mail connection may be UNENCRYPTED and the server certificate is NOT VERIFIED: the SMTP password ' +
            'and every setup, invitation and password-reset link can be read or altered by anything on the network path. This exists for a ' +
            'local test relay only — unset it for any real mail server.'
        );
    }

    if (cfg.MAIL.SMTP_PORT === 465 && !cfg.MAIL.SMTP_SECURE) {
        warnings.push(
            'SMTP_PORT is 465 but SMTP_SECURE is not true. Port 465 expects TLS from the first byte; without SMTP_SECURE=true the connection ' +
            'waits for a greeting that never comes and every send times out. Set SMTP_SECURE=true.'
        );
    } else if (cfg.MAIL.SMTP_PORT === 587 && cfg.MAIL.SMTP_SECURE) {
        warnings.push(
            'SMTP_PORT is 587 but SMTP_SECURE=true. Port 587 starts in plain text and upgrades with STARTTLS, so opening it with TLS ' +
            'fails the handshake. Unset SMTP_SECURE (the STARTTLS upgrade is still required), or use port 465.'
        );
    }

    if (cfg.MAIL.SMTP_HOST.toLowerCase() === GMAIL_SMTP_HOST) {
        if (!cfg.MAIL.SMTP_USER) {
            warnings.push(
                'SMTP_HOST is smtp.gmail.com but SMTP_USER / SMTP_PASS are not set. Gmail accepts no mail without a login: set SMTP_USER to ' +
                'the Gmail address and SMTP_PASS to an app password (Google account > Security > 2-Step Verification > App passwords).'
            );
        } else if (cfg.MAIL.SMTP_PASS && cfg.MAIL.SMTP_PASS.length !== GMAIL_APP_PASSWORD_LENGTH) {
            // The length only, never the value. The usual cause is the Google ACCOUNT password pasted
            // where an app password belongs, which Gmail refuses with a 535 that reads as a typo.
            warnings.push(
                `SMTP_PASS for smtp.gmail.com is ${cfg.MAIL.SMTP_PASS.length} characters after removing spaces; Gmail app passwords are ` +
                `${GMAIL_APP_PASSWORD_LENGTH}. Gmail refuses the account password over SMTP — create an app password and use that.`
            );
        }
    }

    const _mailCaps: { env: string; value: number }[] = [
        { env: 'EMAIL_MAX_PER_HOUR', value: cfg.MAIL.MAX_PER_HOUR },
        { env: 'EMAIL_MAX_PER_DAY', value: cfg.MAIL.MAX_PER_DAY }
    ];
    for (const cap of _mailCaps) {
        if (cap.value <= 0) {
            warnings.push(
                `${cap.env} is ${cap.value}, so NO email will be sent: no setup verification, no invitation, no password reset. ` +
                'Zero is read as a cap of zero, not as "unlimited".'
            );
        } else if (cap.value < 2) {
            warnings.push(
                `${cap.env} is ${cap.value}. Mail triggered by an anonymous request (setup verification, forgot-password) may use half of ` +
                'each cap, rounded down — so at this value it gets none.'
            );
        }
    }

    const _linkTtls: { env: string; value: number; unit: string; fallback: number }[] = [
        { env: 'AUTH_SETUP_TOKEN_TTL_MINUTES', value: cfg.AUTH.SETUP_TOKEN_TTL_MINUTES, unit: 'minutes', fallback: 60 },
        { env: 'AUTH_INVITE_TTL_HOURS', value: cfg.AUTH.INVITE_TTL_HOURS, unit: 'hours', fallback: 72 },
        { env: 'AUTH_PASSWORD_RESET_TTL_MINUTES', value: cfg.AUTH.PASSWORD_RESET_TTL_MINUTES, unit: 'minutes', fallback: 30 }
    ];
    for (const ttl of _linkTtls) {
        if (ttl.value <= 0) {
            warnings.push(
                `${ttl.env} is ${ttl.value}, which is not a usable lifetime for an emailed link. Set a positive number of ` +
                `${ttl.unit} (the default is ${ttl.fallback}).`
            );
        }
    }

    // ── The rate limits, and whose address they count ───────────────────────
    // Both of these are about a security control being weaker than its configuration reads, which
    // is the exact failure this project once spent a change fixing: two keys that described a limit
    // nothing enforced. A control that is off, or that is bucketing every caller together, should
    // say so at boot rather than be discovered during an incident.

    if (cfg.AUTH.LOGIN_RATE_LIMIT_MAX <= 0) {
        warnings.push(
            `AUTH_LOGIN_RATE_LIMIT_MAX is ${cfg.AUTH.LOGIN_RATE_LIMIT_MAX}, which DISABLES login rate limiting. ` +
            'POST /api/auth/login is reachable without a token and guards every account on this deployment; nothing now ' +
            'limits how fast a password can be guessed. That is a supported setting — put the limit in your reverse proxy ' +
            'instead if you meant it.'
        );
    } else if (!cfg.APP.TRUST_PROXY) {
        // NOT pedantry. This backend always sits behind the dashboard's server-side proxy, so with
        // nothing trusted every caller resolves to that proxy's address and shares ONE bucket.
        // That is the SAFE direction to be wrong in. It is not a lockout for anyone signing in from
        // a browser they have used before (the device budget), and the trickle keeps the shared
        // budget a rate rather than a wall — but a caller who keeps polling can hold the trickle, so
        // a first sign-in from a new browser can wait for as long as a flood lasts. See
        // src/middlewares/loginRateLimit.ts.
        warnings.push(
            'TRUST_PROXY is not set, so every request appears to come from whichever machine opened the socket — ' +
            'which, because the dashboard proxies /api to this backend server-side, is always the dashboard itself. ' +
            `AUTH_LOGIN_RATE_LIMIT_MAX=${cfg.AUTH.LOGIN_RATE_LIMIT_MAX} is therefore enforced per DEPLOYMENT, not per source address, ` +
            'and so are the forgot-password and setup-request limits. ' +
            'This is the RECOMMENDED setting for the bundled docker-compose stack: the dashboard forwards a ' +
            'client-supplied X-Forwarded-For unchanged, so no value of TRUST_PROXY makes the caller address ' +
            'trustworthy there. Set it only when a real reverse proxy (nginx, Caddy, Traefik) sits in front and ' +
            'records the address it actually saw in that header (see TRUST_PROXY in DEPLOYMENT.md).'
        );
    } else {
        // Anything OTHER than unset means an X-Forwarded-For is being believed. That is correct only
        // behind a proxy that records the peer it actually saw, and wrong behind the bundled one,
        // which does not.
        //
        // Measured against proxy-addr rather than assumed: with a private-range peer and
        // TRUST_PROXY=uniquelocal, req.ip becomes whatever the caller put in X-Forwarded-For — a
        // fresh rate-limit bucket per request. Next's rewrite proxy sets that header with `??=` and
        // passes http-proxy no `xfwd`, so a client-supplied value arrives here untouched.
        //
        // ⚠️ APPENDING IS ENOUGH ONLY FOR A RANGE OR HOP COUNT. proxy-addr walks X-Forwarded-For from
        // the right and stops at the first untrusted hop, so nginx's `$proxy_add_x_forwarded_for`
        // (append the real peer) is correct with `uniquelocal` — the recipe DEPLOYMENT.md documents.
        // With `true` every hop is trusted and the LEFT-most, caller-written entry wins, so only a
        // proxy that overwrites the header is safe there.
        const _trustLabel = cfg.APP.TRUST_PROXY === true ? 'true' : String(cfg.APP.TRUST_PROXY);
        warnings.push(
            `TRUST_PROXY=${_trustLabel} makes this process BELIEVE the X-Forwarded-For header. That is correct only if ` +
            'a reverse proxy in front of it records the address it actually saw on every request — appending it ' +
            '(nginx\'s $proxy_add_x_forwarded_for) is enough with uniquelocal or a hop count; TRUST_PROXY=true needs a ' +
            'proxy that overwrites the header. It is WRONG behind the bundled ' +
            'docker-compose stack: the dashboard forwards a caller-supplied X-Forwarded-For unchanged, so every login ' +
            'attempt can claim a different source address, land in a fresh bucket, and never reach ' +
            `AUTH_LOGIN_RATE_LIMIT_MAX=${cfg.AUTH.LOGIN_RATE_LIMIT_MAX}. The deployment-wide budget still applies ` +
            '(see loginRateLimit.ts), but the per-address limit you configured does not. Unset TRUST_PROXY unless a ' +
            'real proxy is terminating requests in front of this process.'
        );
    }

    // The same "a control is off" rule as the login limit above. One setting feeds all three
    // public-flow limiters, so a 0 here silently removed every throttle on the signed-out endpoints.
    if (cfg.AUTH.PUBLIC_FLOW_RATE_LIMIT_MAX <= 0) {
        warnings.push(
            `AUTH_PUBLIC_FLOW_RATE_LIMIT_MAX is ${cfg.AUTH.PUBLIC_FLOW_RATE_LIMIT_MAX}, which DISABLES all three ` +
            'public-flow rate limits: forgot-password, the setup request, and the emailed-link pages (setup ' +
            'completion, invitation acceptance, password reset). Nothing now limits how fast those endpoints can be ' +
            'called; only the per-recipient throttles and the hourly and daily email caps still bound the email a ' +
            'stranger can trigger. That is a supported setting — put the limits in your reverse proxy instead if you ' +
            'meant it.'
        );
    }

    if (cfg.SYNC.DISABLED) {
        warnings.push(
            'SYNC_DISABLED=true. The API will serve whatever is already stored, and nothing will be refreshed. ' +
            'Every figure you see is as old as your last successful sync.'
        );
    }

    const knownLevels = ['debug', 'info', 'warn', 'error', 'silent'];
    if (!knownLevels.includes(cfg.LOG.LEVEL)) {
        warnings.push(
            `LOG_LEVEL is '${cfg.LOG.LEVEL}', which is not one of ${knownLevels.join(', ')}. Falling back to 'info'.`
        );
    }

    if (cfg.APP.NODE_ENV === 'production' && cfg.PARTNER.API_BASE_URL !== 'https://partners.shopify.com') {
        warnings.push(
            `SHOPIFY_PARTNER_API_BASE_URL is overridden to '${cfg.PARTNER.API_BASE_URL}' in production. ` +
            'That override exists for test fixtures — every figure on the dashboard is coming from somewhere other than Shopify.'
        );
    }

    return { problems, warnings, upgrade_notice };
};

/**
 * Validates configuration at boot.
 *
 * On the FIRST missing or unusable TIER-1 key: prints the key by name, what it
 * is for, and the line to add — then exits non-zero, so a process manager
 * reports a failed start rather than restarting into the same wrong state.
 * Any further TIER-1 problems are listed underneath, so a fresh install can be
 * fixed in one pass instead of one restart per variable. An upgrade from the
 * single-operator build gets a banner above all of it explaining why.
 *
 * Optional-capability problems are printed as warnings and do not stop the boot.
 *
 * @returns Returns only when the configuration is usable.
 */
const validateConfig = (): void => {
    const { problems, warnings, upgrade_notice } = collectConfigProblems();

    for (const warning of warnings) {
        process.stderr.write(`WARN: config: ${warning}\n`);
    }

    if (!problems.length) {
        return;
    }

    const first = problems[0];
    const lines: string[] = [''];
    if (upgrade_notice) {
        lines.push(upgrade_notice);
    }
    lines.push(
        '============================================================',
        ` CONFIGURATION ERROR: ${first.message}`,
        '============================================================',
        '',
        first.detail,
        ''
    );

    if (problems.length > 1) {
        lines.push(`  ${problems.length - 1} other required setting(s) also need attention:`);
        for (const problem of problems.slice(1)) {
            lines.push(`    - ${problem.message}`);
        }
        lines.push('');
    }

    lines.push('Refusing to start. A backend that boots without these serves numbers built from nothing, or lets nobody in.');
    lines.push('');

    process.stderr.write(lines.join('\n'));
    process.exit(1);
};

export = {
    validateConfig,
    collectConfigProblems,
    checkPublicUrl,
    isLoopbackPublicUrl,
    isBareEmailAddress
};
