'use strict';

/**
 * ============================================================================
 *  DATABASE — MongoDB connection lifecycle
 * ============================================================================
 *
 *  `mongoose.connect` is called INSIDE `initDb()`, never at module load. That
 *  is deliberate and it is the difference between a testable codebase and one
 *  that opens a socket the moment anything, anywhere, transitively requires a
 *  file that reaches the model layer. Importing a module must never have an
 *  external side effect.
 *
 *  The practical consequence: a unit test can require a service, a repository
 *  or a helper without a database being reachable, and `--test` runs in
 *  milliseconds instead of timing out against a connection nobody asked for.
 *
 *  Connection state lives on mongoose's own singleton, so this module holds no
 *  state that could disagree with it beyond a listeners-registered latch.
 * ============================================================================
 */

import mongoose = require('mongoose');
import config = require('../config');
import logger = require('./logger');

const { customConsoleLog, customConsoleError, customConsoleWarn } = logger;

/**
 * Event listeners must be attached once. `initDb()` is idempotent and may be
 * called again after a `closeDb()`, and mongoose's emitter has no de-duplication
 * — re-registering would multiply every disconnect line by the number of calls.
 */
let _listenersRegistered = false;

/**
 * Strips credentials out of a connection string so it can be logged.
 *
 * A URI is the single most useful thing to print at boot and the single most
 * dangerous: `mongodb+srv://user:password@cluster/db` in a log file is a
 * credential leak that outlives the process. Everything between `//` and the
 * last `@` is replaced.
 *
 * Falls back to a fixed placeholder if the URI cannot be parsed — an
 * unparseable URI must never be printed raw on the assumption it contained no
 * password.
 *
 * @param uri - The raw connection string.
 * @returns The same URI with any userinfo replaced by `***`.
 */
const _redactUri = (uri: string): string => {
    if (!uri) {
        return '(unset)';
    }
    try {
        return uri.replace(/^(mongodb(?:\+srv)?:\/\/)([^@/]*@)?/i, (_match, scheme: string, userinfo?: string) => {
            if (!userinfo) {
                return scheme;
            }
            return `${scheme}***@`;
        });
    } catch (error) {
        return '(unprintable connection string)';
    }
};

/**
 * Attaches connection lifecycle listeners exactly once.
 *
 * These are not decoration. A dropped connection is the most common cause of a
 * dashboard that silently stops updating, and mongoose reconnects quietly by
 * default — so without these lines the only evidence is an absence of data.
 *
 */
const _registerListeners = (): void => {
    if (_listenersRegistered) {
        return;
    }
    _listenersRegistered = true;

    mongoose.connection.on('error', (error: unknown) => {
        customConsoleError('ERROR: mongo connection error', error);
    });
    mongoose.connection.on('disconnected', () => {
        customConsoleWarn('WARN: mongo disconnected — queries will queue or fail until it reconnects');
    });
    mongoose.connection.on('reconnected', () => {
        customConsoleLog('INFO: mongo reconnected');
    });
};

/**
 * Opens the MongoDB connection.
 *
 * Idempotent: calling it while already connected logs and returns, so a second
 * entry point cannot open a second pool.
 *
 * THROWS on failure rather than returning a result envelope. This is boot-time
 * infrastructure, not a service call — there is no useful way to continue
 * without a database, and `bootstrap()`'s caller exits non-zero so a process
 * manager reports a failed start instead of restarting into the same state.
 *
 * @returns Resolves once the connection is open.
 */
const initDb = async (): Promise<void> => {
    // 1 = connected, 2 = connecting. Either means someone already started this.
    if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
        customConsoleLog('INFO: mongo already connected — skipping duplicate initDb()');
        return;
    }

    if (!config.MONGO.URI) {
        // Unreachable through bootstrap(), which validates first. Kept because
        // initDb() is also callable from scripts, and mongoose's own error for
        // an empty URI does not say which setting is missing.
        throw new Error('MONGO_URI is not set — cannot connect. (config.MONGO.URI)');
    }

    // Mongoose 7+ defaults this to false, which silently DROPS query conditions
    // on paths not in the schema instead of erroring. For an analytics backend a
    // dropped condition is a wrong number, so conditions are made strict here.
    mongoose.set('strictQuery', true);

    const options: mongoose.ConnectOptions = {
        maxPoolSize: config.MONGO.MAX_POOL_SIZE,
        minPoolSize: config.MONGO.MIN_POOL_SIZE,
        serverSelectionTimeoutMS: config.MONGO.SERVER_SELECTION_TIMEOUT_MS,
        autoIndex: !config.MONGO.DISABLE_AUTO_INDEX
    };

    if (config.MONGO.DB_NAME) {
        options.dbName = config.MONGO.DB_NAME;
    }

    _registerListeners();

    customConsoleLog('INFO: connecting to mongo', { uri: _redactUri(config.MONGO.URI), db_name: config.MONGO.DB_NAME || '(from uri)' });
    await mongoose.connect(config.MONGO.URI, options);
    customConsoleLog('INFO: mongo connected', { database: mongoose.connection.name });
};

/**
 * Closes the MongoDB connection.
 *
 * Safe to call when nothing is open, so a shutdown handler needs no guard of
 * its own. Never throws: a shutdown path that throws turns a clean exit into a
 * crash and can mask the reason the process was stopping.
 *
 * @returns Resolves once the connection is closed, or immediately if it was not open.
 */
const closeDb = async (): Promise<void> => {
    // 0 = disconnected.
    if (mongoose.connection.readyState === 0) {
        return;
    }
    try {
        await mongoose.connection.close(false);
        customConsoleLog('INFO: mongo connection closed');
    } catch (error) {
        customConsoleError('ERROR: failed to close mongo connection', error);
    }
};

export = {
    initDb,
    closeDb
};
