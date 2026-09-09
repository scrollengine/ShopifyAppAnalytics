'use strict';

/**
 * ============================================================================
 *  LOGGER — real exports, not globals
 * ============================================================================
 *
 *  `customConsoleLog` and `customConsoleError` are EXPORTED FUNCTIONS. Import
 *  them:
 *
 *      import logger = require('../core/logger');
 *      const { customConsoleLog, customConsoleError } = logger;
 *
 *  The system this was extracted from assigned these onto `globalThis` in each
 *  app entry point, so a file could call `customConsoleError(...)` with no
 *  import at all and still work — at run time, under that entry point. The
 *  costs were real and worth naming, because the shape is tempting:
 *
 *    - A file with a missing import is not a crash and not a lint error. It
 *      works in the server and throws ReferenceError in a script, a test, or a
 *      worker with a different entry point — discovered in production.
 *    - Nothing can be unit-tested without booting an app first.
 *    - Static analysis cannot tell you who logs what.
 *
 *  So: no globals. If a file logs, it imports the logger.
 *
 *  ── Contract ────────────────────────────────────────────────────────────────
 *  These functions NEVER THROW. Logging is instrumentation; instrumentation
 *  that can take down the thing it observes is a liability. A value that cannot
 *  be serialised is rendered as a placeholder, and a failure inside the logger
 *  itself is swallowed after a best-effort plain write.
 * ============================================================================
 */

import config = require('../config');

/** Ordered severities. `silent` is above every emitted level, so it suppresses all output. */
const LEVEL_RANK: Record<string, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 100
};

const DEFAULT_LEVEL = 'info';

/**
 * Resolved once, at module load — the level cannot change while the process
 * runs, so re-reading it on every line would be pure overhead. An unrecognised
 * value falls back to 'info' rather than silencing the process: a typo in a log
 * level must never be the reason nothing is logged. (`validateConfig` warns
 * about the same typo by name at boot.)
 */
const _threshold: number = LEVEL_RANK[config.LOG.LEVEL] ?? LEVEL_RANK[DEFAULT_LEVEL];

/**
 * Replacer that makes `JSON.stringify` survive the two things it otherwise
 * fails on: circular references, and Error objects.
 *
 * An Error stringifies to `{}` by default — every non-enumerable field, the
 * message and the stack included, is dropped. An error logged inside a context
 * object would therefore render as an empty object, which is worse than useless
 * because it looks like there was nothing to report.
 *
 * @returns A stateful replacer. One per `stringify` call — the seen-set must not be shared.
 */
const _safeReplacer = () => {
    const seen = new WeakSet<object>();
    return (_key: string, value: unknown): unknown => {
        if (value instanceof Error) {
            return {
                name: value.name,
                message: value.message,
                stack: value.stack
            };
        }
        if (typeof value === 'bigint') {
            return value.toString();
        }
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
                return '[Circular]';
            }
            seen.add(value);
        }
        return value;
    };
};

/**
 * Renders an arbitrary value as a log body. Total: every input produces a
 * string, including inputs that throw from their own `toString`.
 *
 * @param value - Anything the caller passed as the second argument.
 * @returns The rendered body, or '' when there was nothing to render.
 */
const _renderBody = (value: unknown): string => {
    if (value === undefined) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    if (value instanceof Error) {
        return value.stack || `${value.name}: ${value.message}`;
    }
    try {
        const json = JSON.stringify(value, _safeReplacer(), 2);
        if (typeof json === 'string') {
            return json;
        }
        return String(value);
    } catch (error) {
        try {
            return String(value);
        } catch (innerError) {
            return '[unserializable value]';
        }
    }
};

/**
 * Writes one log line. The single place output is produced, so text mode and
 * JSON mode can never drift apart.
 *
 * @param level - One of debug/info/warn/error.
 * @param message - The human-readable message. Should be a constant string, not an interpolation, so it stays greppable.
 * @param payload - Optional context object, error, or string.
 */
const _write = (level: string, message: string, payload: unknown): void => {
    try {
        if ((LEVEL_RANK[level] ?? LEVEL_RANK[DEFAULT_LEVEL]) < _threshold) {
            return;
        }

        const timestamp = new Date().toISOString();
        let sink = console.log;
        if (level === 'error') {
            sink = console.error;
        } else if (level === 'warn') {
            sink = console.warn;
        }

        if (config.LOG.JSON) {
            const record: Record<string, unknown> = {
                ts: timestamp,
                level: level,
                msg: String(message)
            };
            if (payload !== undefined) {
                record.data = payload;
            }
            let line = '';
            try {
                line = JSON.stringify(record, _safeReplacer());
            } catch (error) {
                line = JSON.stringify({ ts: timestamp, level: level, msg: String(message), data: '[unserializable value]' });
            }
            sink(line);
            return;
        }

        const body = _renderBody(payload);
        const head = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
        if (!body) {
            sink(head);
            return;
        }
        sink(`${head}\n${body}`);
    } catch (error) {
        // Last resort. The logger has already failed; the one thing it must not
        // do is propagate that failure into the caller's control flow.
        try {
            console.error(`[LOGGER FAILURE] ${String(message)}`);
        } catch (innerError) {
            // Nothing further is available. Swallow deliberately.
        }
    }
};

/**
 * Logs an informational message.
 *
 * @param message - Constant, greppable message text.
 * @param [payload] - Optional context: an object, an error, or a string.
 */
const customConsoleLog = (message: string, payload?: unknown): void => {
    _write('info', message, payload);
};

/**
 * Logs an error. Errors passed as the payload render with their stack rather
 * than as `{}`.
 *
 * @param message - Constant, greppable message text — e.g. 'ERROR: partnerSync fetchCharges'.
 * @param [payload] - The caught error, or a context object.
 */
const customConsoleError = (message: string, payload?: unknown): void => {
    _write('error', message, payload);
};

/**
 * Logs a warning: something is degraded or suspicious, but the operation
 * continued. Missing optional configuration and skipped work belong here.
 *
 * @param message - Constant, greppable message text.
 * @param [payload] - Optional context.
 */
const customConsoleWarn = (message: string, payload?: unknown): void => {
    _write('warn', message, payload);
};

/**
 * Logs a diagnostic detail. Off unless `LOG_LEVEL=debug`, so this is the right
 * place for per-page cursors, per-row decisions and other high-volume traces.
 *
 * @param message - Constant, greppable message text.
 * @param [payload] - Optional context.
 */
const customConsoleDebug = (message: string, payload?: unknown): void => {
    _write('debug', message, payload);
};

export = {
    customConsoleLog,
    customConsoleError,
    customConsoleWarn,
    customConsoleDebug
};
