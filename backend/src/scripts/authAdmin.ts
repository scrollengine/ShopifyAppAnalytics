'use strict';

/**
 * ============================================================================
 *  ACCOUNT RECOVERY — `npm run auth:admin -- <command>`
 * ============================================================================
 *
 *      npm run auth:admin:dist -- status                        (in the Docker image)
 *      npm run auth:admin -- status                             (from a source checkout)
 *
 *  What an operator with shell access does when the dashboard cannot help:
 *  mail is not arriving, the only admin is disabled, or the owner account is
 *  gone. Shell access to the server is the trust boundary, so links are PRINTED
 *  here instead of emailed, and a refused `setup-link` names the addresses that
 *  would be accepted. The work itself lives in `modules/auth`
 *  (`recovery.service`, through the barrel); this file parses arguments, checks
 *  the two settings it needs, and prints.
 *
 *  ──  IT NEVER TAKES A PASSWORD ───────────────────────────────────────────
 *
 *  A password on a command line lands in shell history, in `ps` output and in
 *  whatever captured the terminal. Any option that looks like one is refused
 *  before anything else is read. To set a password, print a reset link and let
 *  the account holder choose one in the browser.
 *
 *  ──  WHY THIS DOES NOT CALL `validateConfig()` ────────────────────────────
 *
 *  Same reason as `seedDemo.ts`: the full TIER-1 set includes the Partner API
 *  and SMTP settings, and a recovery tool that refuses to run because SMTP is
 *  misconfigured cannot rescue the install from exactly that. So it checks
 *  MONGO_URI for every command, and APP_PUBLIC_URL (with the SAME checker boot
 *  uses, `config/validate#checkPublicUrl`) for the three commands that print a
 *  link. Nothing here reads `process.env` directly.
 *
 *  ── Lazy requires, for the reason `apps/app.ts` gives ──────────────────────
 *  `src/config` snapshots `process.env` at FIRST require, so dotenv has to run
 *  before anything that reaches config is required. Hoisting one of the requires
 *  below to module scope gives the whole script a config built from defaults.
 *
 *  ── Exit codes ────────────────────────────────────────────────────────────
 *      0  done
 *      1  the command ran and was refused or failed, or a setting is missing
 *      2  the command line was wrong (nothing was read or written)
 * ============================================================================
 */

import type { CliIssuedLink, RecoveryStatus } from '../modules/auth/types/auth.types';
import type { ServiceResult } from '../types/service.types';

type ConfigModule = typeof import('../config');
type ValidateModule = typeof import('../config/validate');
type DbModule = typeof import('../core/db');
type AuthModule = typeof import('../modules/auth');

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

/** Which options each command takes. `all` is a flag; the others take a value. */
const _COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    'status': [],
    'setup-link': ['email', 'name'],
    'reset-link': ['email'],
    'revoke-sessions': ['email', 'all'],
    'enable': ['email'],
    'transfer-owner': ['email'],
    'repair-owner': ['email', 'name']
});

/** The commands that print a link, and so need a usable APP_PUBLIC_URL before connecting. */
const _LINK_COMMANDS: readonly string[] = Object.freeze(['setup-link', 'reset-link', 'repair-owner']);

/** Options that are flags rather than `--key <value>`. */
const _FLAG_OPTIONS: readonly string[] = Object.freeze(['all']);

/**
 * Any option that could be carrying a password: `--password`, `--new-password=…`, `--pass`,
 * `--passphrase`. Matched on the option NAME only, so a value such as `--name Passmore` is fine.
 */
const _PASSWORD_OPTION_RE = /^-{1,2}[^=]*pass/i;

const _USAGE = [
    'Account recovery for Shopify App Analytics. Run it on the server, next to the backend\'s .env.',
    '',
    '  npm run auth:admin:dist -- <command> [options]     in the Docker image',
    '  npm run auth:admin -- <command> [options]          from a source checkout',
    '',
    'Commands:',
    '  status                                  setup state, owner, legacy addresses, user counts, mail',
    '  setup-link      --email <e> --name <n>  print a setup link (only while setup is incomplete)',
    '  reset-link      --email <e>             print a 15-minute password-reset link for an active user',
    '  revoke-sessions --email <e> | --all     sign one account, or every account, out everywhere',
    '  enable          --email <e>             re-enable a disabled account',
    '  transfer-owner  --email <e>             make an active account the owner',
    '  repair-owner    --email <e> --name <n>  recreate a missing owner account and print a reset link',
    '',
    'Links are printed here instead of emailed: treat them like passwords.',
    'This tool never takes a password. To set one, print a reset-link and open it.',
    ''
].join('\n');

/** What the command line asked for, once it has been checked. */
interface CliArgs {
    command: string;
    email: string | null;
    name: string | null;
    all: boolean;
}

type ParseOutcome =
    | { ok: true; args: CliArgs }
    | { ok: false; exit_code: number; message: string };

/**
 * Parses and checks the command line. Pure: no config, no I/O.
 *
 * The password refusal runs FIRST and over every argument, so it is what the operator sees even when
 * the same line has another mistake in it.
 *
 * @param argv - `process.argv.slice(2)`.
 * @returns The parsed arguments, or the message and exit code to stop with.
 */
const _parseArgs = (argv: readonly string[]): ParseOutcome => {
    for (const arg of argv) {
        if (_PASSWORD_OPTION_RE.test(arg)) {
            return {
                ok: false,
                exit_code: EXIT_USAGE,
                message: 'Refused: this tool never accepts a password. A password on a command line ends up in shell '
                    + 'history and in the process list.\nTo set a password, run reset-link and open the link it prints.\n'
            };
        }
    }

    const command = argv[0];
    if (command === undefined) {
        return { ok: false, exit_code: EXIT_USAGE, message: `No command given.\n\n${_USAGE}` };
    }
    if (command === 'help' || command === '--help' || command === '-h') {
        return { ok: false, exit_code: EXIT_OK, message: _USAGE };
    }
    if (!Object.prototype.hasOwnProperty.call(_COMMAND_OPTIONS, command)) {
        return { ok: false, exit_code: EXIT_USAGE, message: `Unknown command ${JSON.stringify(command)}.\n\n${_USAGE}` };
    }

    const allowed = _COMMAND_OPTIONS[command];
    const args: CliArgs = { command: command, email: null, name: null, all: false };
    const seen = new Set<string>();
    const rest = argv.slice(1);

    for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index];
        if (!arg.startsWith('--')) {
            //  Not echoed: a stray bare word is the likeliest place for a password typed by mistake.
            return {
                ok: false,
                exit_code: EXIT_USAGE,
                message: `Unexpected bare argument in position ${index + 2}. Values follow their option, e.g. --email you@example.com\n\n${_USAGE}`
            };
        }

        let key = arg.slice(2);
        let inline: string | null = null;
        const equals = key.indexOf('=');
        if (equals >= 0) {
            inline = key.slice(equals + 1);
            key = key.slice(0, equals);
        }

        if (!allowed.includes(key)) {
            return { ok: false, exit_code: EXIT_USAGE, message: `${command} does not take --${key}.\n\n${_USAGE}` };
        }
        if (seen.has(key)) {
            return { ok: false, exit_code: EXIT_USAGE, message: `--${key} was given more than once.\n` };
        }
        seen.add(key);

        if (_FLAG_OPTIONS.includes(key)) {
            if (inline !== null) {
                return { ok: false, exit_code: EXIT_USAGE, message: `--${key} takes no value.\n` };
            }
            args.all = true;
            continue;
        }

        let value = inline;
        if (value === null) {
            const next = rest[index + 1];
            //  A following option is not a value: `--email --all` means the address was forgotten,
            // and taking "--all" as the address would send the refusal somewhere confusing.
            value = next !== undefined && !next.startsWith('--') ? next : null;
            if (value !== null) {
                index += 1;
            }
        }
        if (value === null || value.trim() === '') {
            return { ok: false, exit_code: EXIT_USAGE, message: `--${key} needs a value.\n` };
        }
        if (key === 'email') {
            args.email = value;
        } else {
            args.name = value;
        }
    }

    const needsName = command === 'setup-link' || command === 'repair-owner';
    if (command === 'revoke-sessions') {
        if (args.all === (args.email !== null)) {
            return { ok: false, exit_code: EXIT_USAGE, message: `revoke-sessions takes exactly one of --email <address> or --all.\n` };
        }
    } else if (allowed.includes('email') && args.email === null) {
        return { ok: false, exit_code: EXIT_USAGE, message: `${command} needs --email <address>.\n` };
    }
    if (needsName && args.name === null) {
        return { ok: false, exit_code: EXIT_USAGE, message: `${command} needs --name <name> (quote it if it has spaces).\n` };
    }

    return { ok: true, args: args };
};

/**
 * A stored instant as ISO-8601 (always UTC), or a placeholder.
 *
 * @param value - A Date, or anything `new Date()` can read.
 * @returns ISO-8601, or `(unknown)`.
 */
const _isoOrUnknown = (value: unknown): string => {
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? '(unknown)' : date.toISOString();
};

/**
 * An expiry in UTC, ISO-8601, with the zone spelled out and the time remaining beside it. Never
 * `toLocaleString()`: the server's zone is not the reader's.
 *
 * @param value - The `expires_at` a service returned.
 * @returns e.g. `2026-09-28T12:15:00.000Z (UTC; about 15 minutes from now)`.
 */
const _utc = (value: unknown): string => {
    const iso = _isoOrUnknown(value);
    if (iso === '(unknown)') {
        return iso;
    }
    const minutes = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
    return `${iso} (UTC; about ${minutes} minute${minutes === 1 ? '' : 's'} from now)`;
};

/**
 * Prints a link a service issued, with its expiry and what opening it does.
 *
 * @param issued - `{ email, link, expires_at }`.
 * @param what - What opening the link lets someone do, as a sentence.
 * @param linkHostIsLoopback - Whether APP_PUBLIC_URL only resolves on this machine.
 */
const _printLink = (issued: CliIssuedLink, what: string, linkHostIsLoopback: boolean): void => {
    process.stdout.write(`\n  ${issued.link}\n\n`);
    process.stdout.write(`  expires_at: ${_utc(issued.expires_at)}\n\n`);
    process.stdout.write(`${what} It works once. Treat it like a password, and copy the WHOLE line: the part after "#" is the key.\n`);
    if (linkHostIsLoopback) {
        process.stdout.write('Note: APP_PUBLIC_URL points at this machine, so the link only opens in a browser running on the server itself.\n');
    }
    process.stdout.write('\n');
};

/** What each setup rule means, for an operator reading a refusal or `status`. */
const _SETUP_RULE_TEXT: Readonly<Record<string, string>> = Object.freeze({
    PIN: 'SETUP_OWNER_EMAIL is set, so only that address may claim setup.',
    LEGACY: 'This database holds accounts from the single-operator build, so only their addresses may claim setup. '
        + 'Set SETUP_OWNER_EMAIL (and restart the server) to choose a different address.',
    OPEN: 'No SETUP_OWNER_EMAIL and no legacy accounts: whoever submits the setup form first may claim it.'
});

/**
 * Prints a refusal or failure to stderr and returns the failure exit code.
 *
 * @param command - The command that ran.
 * @param result - The failure envelope.
 * @returns `EXIT_FAILED`.
 */
const _printFailure = (command: string, result: ServiceResult): number => {
    const error = result && result.error && typeof result.error === 'object' ? result.error : {};
    const code = typeof error.code === 'string' ? error.code : 'UNKNOWN';
    process.stderr.write(`\n${command} did not complete: ${result.msg} [${code}]\n`);

    if (code === 'SETUP_NOT_PERMITTED') {
        const ruleText = typeof error.rule === 'string' ? _SETUP_RULE_TEXT[error.rule] : undefined;
        process.stderr.write(`  Rule: ${error.rule || '(unknown)'}${ruleText ? ` — ${ruleText}` : ''}\n`);
        const permitted: unknown[] = Array.isArray(error.permitted_emails) ? error.permitted_emails : [];
        process.stderr.write('  Addresses that may claim setup:\n');
        if (permitted.length === 0) {
            process.stderr.write('      (none listed)\n');
        }
        for (const address of permitted) {
            process.stderr.write(`      ${String(address)}\n`);
        }
    }
    if (code === 'DATASTORE_ERROR') {
        process.stderr.write('  Check that MongoDB is running and that MONGO_URI points at it.\n');
    }
    process.stderr.write('\n');
    return EXIT_FAILED;
};

/**
 * Prints the `status` report.
 *
 * ⚠️ MAIL: this process has never talked to the mail server, so its own "last check" is always
 * "not checked" — printing that as the install's mail health would claim more than this command
 * knows. Only whether mail is CONFIGURED is reported; delivery is judged by the running server.
 *
 * @param status - The recovery status.
 */
const _printStatus = (status: RecoveryStatus): void => {
    const install = status.install;
    const lines: string[] = [''];

    if (!install.present) {
        lines.push('Install:  not created yet. The server creates it on first boot (setup-link also creates it).');
    } else if (install.setup_complete) {
        lines.push(`Setup:    complete (locked at ${_isoOrUnknown(install.setup_completed_at)} UTC). It never reopens.`);
    } else {
        lines.push('Setup:    NOT complete. The dashboard shows the setup page.');
    }

    if (status.setup_rule) {
        const when = install.setup_complete ? ' (applies only while setup is incomplete)' : '';
        lines.push(`Rule:     ${status.setup_rule}${when} — ${_SETUP_RULE_TEXT[status.setup_rule] || ''}`);
    } else {
        lines.push('Rule:     could not be read (database error); a setup request would be refused until it can.');
    }

    if (install.owner_email) {
        lines.push(`Owner:    ${install.owner_email} (user_id ${install.owner_user_id})`);
    } else if (install.owner_missing) {
        lines.push(`Owner:    MISSING. The owner pointer names user_id ${install.owner_user_id}, which does not exist.`);
        lines.push('          Recreate it:  npm run auth:admin:dist -- repair-owner --email <address> --name <name>');
        lines.push('          or promote an existing active account:  npm run auth:admin:dist -- transfer-owner --email <address>');
    } else if (install.setup_complete) {
        lines.push('Owner:    NONE. Setup is locked but no account is the owner.');
        lines.push('          Promote an existing active account:  npm run auth:admin:dist -- transfer-owner --email <address>');
        lines.push('          or create one:  npm run auth:admin:dist -- repair-owner --email <address> --name <name>');
    } else {
        lines.push('Owner:    none yet (created when setup completes).');
    }

    lines.push(`Users:    ${status.users.active} active, ${status.users.disabled} disabled`);

    if (status.legacy_emails.length === 0) {
        lines.push('Legacy:   no single-operator accounts.');
    } else {
        lines.push(`Legacy:   ${status.legacy_emails.length} single-operator account(s), never used for sign-in:`);
        for (const email of status.legacy_emails) {
            lines.push(`              ${email}`);
        }
    }

    if (status.mail.configured) {
        lines.push('Mail:     configured. This command does not test delivery; the running server checks it at boot and');
        lines.push('          the Users page shows the result. If mail is not arriving, use setup-link / reset-link.');
    } else {
        lines.push('Mail:     NOT configured (SMTP_HOST and a sender address are needed). Use setup-link / reset-link.');
    }

    lines.push('');
    process.stdout.write(lines.join('\n') + '\n');
};

/**
 * Runs one parsed command against the auth module and prints the outcome.
 *
 * The recovery services stamp their own CLI actor on every audit row, so the identity argument
 * carries nothing.
 *
 * @param authModule - The auth barrel.
 * @param args - The parsed command line.
 * @param linkHostIsLoopback - Whether printed links only open on this machine.
 * @returns The exit code.
 */
const _runCommand = async (authModule: AuthModule, args: CliArgs, linkHostIsLoopback: boolean): Promise<number> => {
    const identity = {};

    if (args.command === 'status') {
        const result = await authModule.recoveryStatus(identity);
        if (!result.status) {
            return _printFailure(args.command, result);
        }
        _printStatus(result.data);
        return EXIT_OK;
    }

    if (args.command === 'setup-link') {
        const result = await authModule.issueSetupLinkForCli(identity, { email: args.email, name: args.name });
        if (!result.status) {
            return _printFailure(args.command, result);
        }
        const issued: CliIssuedLink = result.data;
        process.stdout.write(`\nSetup link for ${issued.email}. No email was sent.\n`);
        _printLink(issued, `Whoever opens it sets the owner password for ${issued.email} and completes setup.`, linkHostIsLoopback);
        return EXIT_OK;
    }

    if (args.command === 'reset-link') {
        const result = await authModule.issueResetLinkForCli(identity, { email: args.email });
        if (!result.status) {
            return _printFailure(args.command, result);
        }
        const issued: CliIssuedLink = result.data;
        process.stdout.write(`\nPassword-reset link for ${issued.email}. No email was sent; earlier reset links for this account no longer work.\n`);
        _printLink(issued, `Whoever opens it chooses a new password for ${issued.email}, which signs that account out everywhere.`, linkHostIsLoopback);
        return EXIT_OK;
    }

    if (args.command === 'revoke-sessions') {
        const params = args.all ? { all: true } : { email: args.email };
        const result = await authModule.revokeSessionsForCli(identity, params);
        if (!result.status) {
            return _printFailure(args.command, result);
        }
        const whom = args.all ? 'every account' : String(args.email);
        process.stdout.write(`\nEvery sign-in that existed for ${whom} ends on its next request `
            + `(${result.data.users_affected} account(s); ${result.data.revoked} open session(s) marked revoked).\n`
            + 'Passwords are unchanged: anyone who knows one can sign in again.\n\n');
        return EXIT_OK;
    }

    if (args.command === 'enable') {
        const result = await authModule.enableUserForCli(identity, { email: args.email });
        if (!result.status) {
            return _printFailure(args.command, result);
        }
        process.stdout.write(`\nEnabled ${result.data.email} (user_id ${result.data.user_id}). They sign in with their existing `
            + 'password; if they no longer know it, run reset-link.\n\n');
        return EXIT_OK;
    }

    if (args.command === 'transfer-owner') {
        const result = await authModule.transferOwnershipForCli(identity, { email: args.email });
        if (!result.status) {
            return _printFailure(args.command, result);
        }
        const moved = result.data;
        process.stdout.write(`\nOwnership moved to ${moved.email} (user_id ${moved.to_user_id}).\n`);
        process.stdout.write(`  previous owner:        ${moved.from_user_id ? `user_id ${moved.from_user_id} — keeps the role stored on their account` : '(none)'}\n`);
        process.stdout.write(`  invitations moved:     ${moved.invites_reparented}\n`);
        process.stdout.write(`  invitations revoked:   ${moved.invites_revoked} (no longer allowed after the move)\n\n`);
        return EXIT_OK;
    }

    if (args.command === 'repair-owner') {
        const result = await authModule.repairOwnerForCli(identity, { email: args.email, name: args.name });
        if (!result.status) {
            return _printFailure(args.command, result);
        }
        const repaired = result.data;
        process.stdout.write(`\nOwner account recreated for ${repaired.email} (user_id ${repaired.user_id}). Nobody knows its password yet.\n`);
        _printLink(
            { email: repaired.email, link: repaired.link, expires_at: repaired.expires_at },
            `Whoever opens it chooses the owner's password for ${repaired.email}.`,
            linkHostIsLoopback
        );
        return EXIT_OK;
    }

    //  Unreachable: `_parseArgs` admits only the commands above. Kept so a command added to the
    // option table without a branch here fails loudly instead of exiting 0 having done nothing.
    process.stderr.write(`\n${args.command} is recognised but has no handler in authAdmin.ts.\n\n`);
    return EXIT_FAILED;
};

/**
 * Loads `.env`, checks the command line and the settings it needs, connects, runs one command.
 *
 * @returns The process exit code.
 */
const main = async (): Promise<number> => {
    require('dotenv').config();

    const parsed = _parseArgs(process.argv.slice(2));
    if (!parsed.ok) {
        const stream = parsed.exit_code === EXIT_OK ? process.stdout : process.stderr;
        stream.write(parsed.message);
        return parsed.exit_code;
    }
    const args = parsed.args;

    const config: ConfigModule = require('../config');
    if (!config.MONGO.URI) {
        process.stderr.write(
            'MONGO_URI is not set, so there is no database to recover.\n\n'
            + '  Run this where the backend\'s .env is (in Docker: docker compose exec backend npm run auth:admin:dist -- ...),\n'
            + '  or add the line to .env:\n\n'
            + '      MONGO_URI=mongodb://127.0.0.1:27017/shopify-app-analytics\n\n'
            + '  (Read at config.MONGO.URI.)\n'
        );
        return EXIT_FAILED;
    }

    let linkHostIsLoopback = false;
    if (_LINK_COMMANDS.includes(args.command)) {
        const validate: ValidateModule = require('../config/validate');
        const problem = validate.checkPublicUrl(config.APP.PUBLIC_URL);
        if (problem !== null) {
            const opening = config.APP.PUBLIC_URL ? `APP_PUBLIC_URL is set, but ${problem}.` : 'APP_PUBLIC_URL is not set.';
            process.stderr.write(
                `${opening}\n${args.command} cannot build a link without it: every link is built from APP_PUBLIC_URL, never from `
                + 'anything a request says.\n\n'
                + '  Set it in .env to the address people open the dashboard at:\n\n'
                + '      APP_PUBLIC_URL=https://analytics.yourcompany.com\n\n'
                + '  (Read at config.APP.PUBLIC_URL.)\n'
            );
            return EXIT_FAILED;
        }
        linkHostIsLoopback = validate.isLoopbackPublicUrl(config.APP.PUBLIC_URL);
    }

    const { initDb, closeDb }: DbModule = require('../core/db');
    const authModule: AuthModule = require('../modules/auth');

    try {
        await initDb();
    } catch (connectError) {
        //  The name and message only: the stack adds nothing an operator can act on. The URI's
        // user-info is blanked out of the message in case a driver error ever echoes it.
        const raw = connectError instanceof Error ? `${connectError.name}: ${connectError.message}` : String(connectError);
        const userInfo = /^mongodb(?:\+srv)?:\/\/([^@/]+)@/i.exec(config.MONGO.URI);
        const reason = userInfo ? raw.split(userInfo[1]).join('***') : raw;
        process.stderr.write(
            `Could not connect to MongoDB, so nothing was read or changed.\n  ${reason}\n\n`
            + '  Check that the database is running and that MONGO_URI (config.MONGO.URI) points at it.\n'
        );
        return EXIT_FAILED;
    }
    try {
        return await _runCommand(authModule, args, linkHostIsLoopback);
    } finally {
        await closeDb();
    }
};

main()
    .then((code) => {
        process.exit(code);
    })
    .catch((error: unknown) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        process.stderr.write(`\nauth:admin stopped with an unexpected error.\n${message}\n\n`);
        process.exit(EXIT_FAILED);
    });

// This file is an ENTRY POINT with no exports, and `export {}` is what makes TypeScript treat it as
// a module rather than a global script. Without it every top-level name here collides with the
// other entry points' names at compile time (TS2451), because global scripts share one scope.
export {};
