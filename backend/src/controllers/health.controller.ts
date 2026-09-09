'use strict';

/**
 * ============================================================================
 *  HEALTH CONTROLLER — the only unauthenticated endpoint outside /api
 * ============================================================================
 *
 *  `GET /healthz` answers one question: is this instance ready to serve numbers
 *  that mean anything?
 *
 *    503  the process is up but has no synced data yet (or cannot reach Mongo)
 *    200  at least one registered app has completed a Partner API sync
 *
 *  ── Why readiness is "a sync completed", not "the port is open" ─────────────
 *  A freshly started instance answers every analytics endpoint correctly and
 *  truthfully — with `null` and a reason, because nothing has been synced. That
 *  is the right answer, and it is also exactly what a half-broken instance looks
 *  like. If /healthz returned 200 the moment the socket bound, a rolling deploy
 *  would shift traffic onto an instance whose whole dashboard reads "no data",
 *  and nothing would page. So readiness is tied to the data, not the transport.
 *
 *  ── Why it is deliberately uninformative ────────────────────────────────────
 *  This endpoint is reachable by anyone who can reach the port. It reports a
 *  state and a reason and NOTHING that identifies the business: no app name, no
 *  handle, no shop counts, no revenue, not even the last sync timestamp. An
 *  operator who wants those signs in and reads GET /api/meta/coverage, which is
 *  behind the guard and says far more.
 *
 *  ── Latency note ────────────────────────────────────────────────────────────
 *  The check really does hit Mongo, because "healthy while the database is
 *  gone" is precisely the lie a health endpoint must not tell. With Mongo down
 *  the driver buffers and this can take up to mongoose's buffer timeout (~10s)
 *  before answering 503 — so set any probe timeout ABOVE that, or a slow 503
 *  gets reported as a probe failure instead of the state it actually is.
 * ============================================================================
 */

import type { Request, Response } from 'express';
import logger = require('../core/logger');
import partnerModule = require('../modules/partner');

const { customConsoleError } = logger;
const { listPartnerApps } = partnerModule;

/**
 * Identity used for the probe's own read.
 *
 * `/healthz` carries no token by design, but every service in this codebase takes an identity and
 * refuses an empty one. This is the same device the job runner uses for its own unattended writes
 * (`SYNC_WORKER`): a named, non-human caller. It grants nothing — there is one operator account and
 * no per-user scoping anywhere in this system — it only keeps the service signature uniform and
 * makes the caller identifiable in a log line.
 */
const HEALTH_PROBE_USER_ID = 'HEALTH_PROBE';

/** Ready to serve: some app has synced at least once. */
const STATE_READY = 'ready';
/** Up, but nothing has been synced yet. Correct-but-empty answers. */
const STATE_WARMING = 'warming';
/** Up, but the datastore could not be read. */
const STATE_DEGRADED = 'degraded';

/**
 * Reports whether this instance has data worth serving.
 *
 * @param _req - Express request. Unused: the probe takes no input, and accepting one
 * would give an anonymous caller a knob on an unauthenticated endpoint.
 * @param res - Express response.
 * @returns 200 once a sync has completed, 503 before that or on a datastore
 * failure. The body is the standard envelope; `data.state` and `data.reason` carry the detail.
 */
const _healthLiveness = async (_req: Request, res: Response) => {
    const checkedAt = new Date();

    let state = STATE_DEGRADED;
    let reason = 'The readiness check did not complete.';

    try {
        const serviceResponse = await listPartnerApps({ user_id: HEALTH_PROBE_USER_ID }, {});

        if (!serviceResponse.status) {
            // The read itself failed — Mongo is unreachable, or the query threw. Say so plainly;
            // this is the case where reporting 200 would be actively harmful.
            reason = 'The datastore could not be read, so readiness is unknown. Check the server logs and the Mongo connection.';
            customConsoleError('ERROR: Health healthController _healthLiveness — readiness read failed', { msg: serviceResponse.msg });
        } else {
            // Structural cast, not the module's own type: the probe reads exactly one field, and
            // naming the full type here would couple a public endpoint to a module's internals for
            // no benefit. The service's payload is a union (`items` or an empty object on failure),
            // which is why the shape is asserted rather than narrowed.
            const payload = serviceResponse.data as { items?: Array<{ last_synced_at?: Date | null }> };
            const items = payload.items || [];

            let syncedCount = 0;
            for (const app of items) {
                if (app.last_synced_at) {
                    syncedCount += 1;
                }
            }

            if (items.length === 0) {
                state = STATE_WARMING;
                reason = 'No partner app is registered yet. Set SHOPIFY_PARTNER_APP_ID and restart, or POST /api/partner-apps.';
            } else if (syncedCount === 0) {
                state = STATE_WARMING;
                reason = 'The first Partner API sync has not completed yet. Every figure would read as unavailable until it does.';
            } else {
                state = STATE_READY;
                reason = 'A Partner API sync has completed; stored history is available to query.';
            }
        }
    } catch (error) {
        // A health endpoint that can throw is a health endpoint that reports nothing at the exact
        // moment it matters most. Everything lands in the envelope below.
        customConsoleError('ERROR: Health healthController _healthLiveness', error);
        reason = 'The readiness check threw. Check the server logs.';
    }

    const ready = state === STATE_READY;

    let httpStatus = 503;
    if (ready) {
        httpStatus = 200;
    }

    return res.status(httpStatus).json({
        status: ready,
        msg: reason,
        data: {
            ready: ready,
            state: state,
            reason: reason,
            checked_at: checkedAt,
            uptime_seconds: Math.floor(process.uptime())
        },
        error: {}
    });
};

export = {
    _healthLiveness
};
