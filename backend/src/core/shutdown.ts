'use strict';

/**
 * ============================================================================
 *  GRACEFUL SHUTDOWN
 * ============================================================================
 *
 *  One function: hand it the HTTP server and it wires SIGTERM/SIGINT to a
 *  shutdown sequence that stops work in dependency order rather than all at
 *  once.
 *
 *  ── Why the order below is the order ────────────────────────────────────────
 *
 *    1. Stop the CRON first. It only ever enqueues work. Leaving it armed while
 *       everything else winds down means a schedule can fire during the drain
 *       and write a PENDING row nothing will ever claim — which the stuck-job
 *       sweeper later reports as a failure that never actually happened.
 *
 *    2. Stop accepting new HTTP connections, but let in-flight requests finish.
 *       Idle keep-alive sockets are closed explicitly; without that, a browser
 *       or load balancer holding an idle connection keeps `server.close()`
 *       pending until its own timeout, and a shutdown that should take
 *       milliseconds takes a minute.
 *
 *    3. Drain the job runner. This is the slow step and the one worth waiting
 *       for: a sync killed mid-flight leaves its row RUNNING until the sweeper
 *       fails it half an hour later, and part of its output already written.
 *       `stopJobRunner` bounds its own wait, so this cannot hang forever.
 *
 *    4. Close Mongo — LAST, because steps 2 and 3 are still using it.
 *
 *  ── The watchdog ────────────────────────────────────────────────────────────
 *  If any of that wedges, a hard exit fires. Its timeout is deliberately longer
 *  than the job runner's own drain bound, so the watchdog is a backstop for a
 *  genuine hang and never a race that cuts a healthy drain short.
 * ============================================================================
 */

import type { Server } from 'node:http';
import logger = require('./logger');
import db = require('./db');
import syncModule = require('../modules/sync');

const { customConsoleLog, customConsoleError, customConsoleWarn } = logger;
const { closeDb } = db;
const { stopAllCrons, stopJobRunner } = syncModule;

/**
 * Hard-exit deadline for the whole sequence.
 *
 *  Must stay comfortably ABOVE the job runner's own drain timeout
 * (`SHUTDOWN_DRAIN_TIMEOUT_MS`, 10s in src/modules/sync/constants/sync.constants.ts). If it drops
 * below, this watchdog kills healthy drains and the RUNNING rows it was meant to prevent become the
 * normal case.
 */
const SHUTDOWN_WATCHDOG_MS = 25000;

/** Signals that mean "wind down": SIGTERM from a supervisor, SIGINT from a terminal. */
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * Latch. A second Ctrl-C, or a SIGTERM arriving while a SIGINT is already being handled, must not
 * start the sequence twice — two concurrent drains would race on the same server handle.
 */
let _shuttingDown = false;

/**
 * Closes the HTTP server, resolving once every in-flight request has finished.
 *
 * Idle keep-alive connections are closed explicitly first. `closeIdleConnections` exists on Node 18+
 * and is guarded anyway, because a shutdown path is the wrong place to assume a runtime feature.
 *
 * @param server - The listening HTTP server.
 * @returns Resolves when the server has closed, or immediately on a close error
 * (already-closed is not a fault worth failing a shutdown over).
 */
const _closeServer = (server: Server): Promise<void> => {
    return new Promise((resolve) => {
        if (typeof server.closeIdleConnections === 'function') {
            server.closeIdleConnections();
        }
        server.close((error) => {
            if (error) {
                customConsoleWarn('WARN: shutdown: http server close reported an error', error);
            }
            return resolve();
        });
    });
};

/**
 * Runs the shutdown sequence once, then exits the process.
 *
 * Every step is individually guarded: one failing step must not skip the ones after it, or a Mongo
 * connection is left open because a cron timer threw.
 *
 * @param signal - The signal that triggered this, for the log line.
 * @param server - The listening HTTP server.
 * @returns Does not resolve in practice — the process exits at the end.
 */
const _runShutdown = async (signal: string, server: Server): Promise<void> => {
    if (_shuttingDown) {
        customConsoleWarn('WARN: shutdown: already shutting down; ignoring repeat signal', { signal });
        return;
    }
    _shuttingDown = true;

    customConsoleLog('INFO: shutdown: signal received — winding down', { signal, watchdog_ms: SHUTDOWN_WATCHDOG_MS });

    // Unref'd on purpose: it must not be the reason the process stays alive. An unref'd timer still
    // FIRES while the loop is alive, which is exactly the case it is here to catch.
    const watchdog = setTimeout(() => {
        customConsoleError('ERROR: shutdown: did not complete in time — exiting hard. In-flight work may be half written.', {
            watchdog_ms: SHUTDOWN_WATCHDOG_MS
        });
        process.exit(1);
    }, SHUTDOWN_WATCHDOG_MS);
    if (typeof watchdog.unref === 'function') {
        watchdog.unref();
    }

    // 1. No new scheduled work.
    try {
        stopAllCrons();
    } catch (error) {
        customConsoleError('ERROR: shutdown: stopAllCrons threw', error);
    }

    // 2. No new HTTP work; let what is in flight finish.
    try {
        await _closeServer(server);
        customConsoleLog('INFO: shutdown: http server closed');
    } catch (error) {
        customConsoleError('ERROR: shutdown: closing the http server threw', error);
    }

    // 3. Drain the job runner. Bounded internally.
    try {
        const stopped = await stopJobRunner();
        customConsoleLog('INFO: shutdown: job runner stopped', stopped.data);
    } catch (error) {
        customConsoleError('ERROR: shutdown: stopJobRunner threw', error);
    }

    // 4. Datastore last — everything above may still have been using it.
    try {
        await closeDb();
    } catch (error) {
        customConsoleError('ERROR: shutdown: closeDb threw', error);
    }

    clearTimeout(watchdog);
    customConsoleLog('INFO: shutdown: complete', { signal });

    // Explicit rather than "let the loop drain": a stray unref'd handle or a driver socket that
    // lingers would otherwise turn a finished shutdown into a container that never exits.
    process.exit(0);
};

/**
 * Registers SIGTERM/SIGINT handlers that wind the process down cleanly.
 *
 * Call it immediately after `server.listen()` — before the sync machinery starts — so a signal
 * arriving during a slow boot is still handled rather than killing the process outright.
 *
 * @param server - The listening HTTP server returned by `app.listen()`.
 */
const registerGracefulShutdown = (server: Server): void => {
    for (const signal of SHUTDOWN_SIGNALS) {
        process.on(signal, () => {
            _runShutdown(signal, server).catch((error) => {
                // Unreachable — _runShutdown guards every step — but a shutdown path that can
                // itself throw unhandled is a process that hangs on exit.
                customConsoleError('ERROR: shutdown: sequence rejected', error);
                process.exit(1);
            });
        });
    }

    customConsoleLog('INFO: shutdown: handlers registered', { signals: SHUTDOWN_SIGNALS });
};

export = {
    registerGracefulShutdown
};
