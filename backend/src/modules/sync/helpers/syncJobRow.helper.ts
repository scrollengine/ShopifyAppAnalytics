'use strict';

/**
 * ============================================================================
 *  ONE JOB DOCUMENT -> THE ROW EVERY SYNC ENDPOINT PUBLISHES
 * ============================================================================
 *
 *  PURE. No models, no repository, no config, no clock. It takes a document and
 *  returns a plain object, so it can be exercised against literal rows.
 *
 *  ── Why this is a helper and not a private function in a service ────────────
 *  It started as `_serializeJob` inside `services/syncJob.service`, which was
 *  correct while ONE file produced job rows. `GET /api/sync/jobs` is the second,
 *  and `GET /api/sync/health` reads the same rows for its last-run block — so
 *  the alternative to extracting it was three spellings of "what a job row looks
 *  like on the wire".
 *
 *   Three copies of a serializer do not fail loudly; they DRIFT. One gains a
 *  field, one keeps returning `duration_ms` where another started sending
 *  `duration`, and the sync screen renders a dash for a job that ran perfectly
 *  well. There is exactly one definition, here, and every endpoint calls it.
 *
 *  ── Fields are PICKED, never spread ─────────────────────────────────────────
 *  Adding a column to the schema — an internal marker, a raw payload — must not
 *  silently widen what leaves the process. Every key below is written out, so a
 *  new stored field is published only when someone decides to publish it.
 * ============================================================================
 */

import type { SyncJobDoc } from '../../shared/types/entity.types';
import type { SerializedSyncJob } from '../types/syncJob.types';

/**
 * Serialises a job document into the shape every endpoint and log line uses.
 *
 * ⚠️ Dates are returned as `Date` objects, not ISO strings. `JSON.stringify` renders them as
 * ISO-8601 on the wire, which is what the dashboard's `new Date(iso)` expects — converting here
 * would be a second, redundant formatting decision, and one of the two would eventually differ.
 *
 * @param doc - A job document, or null.
 * @returns The serialised row, or null when there was no document.
 */
const serializeSyncJob = (doc: SyncJobDoc | null): SerializedSyncJob | null => {
    if (!doc) {
        return null;
    }

    let partnerAppId: string | null = null;
    if (doc.partner_app_id) {
        partnerAppId = String(doc.partner_app_id);
    }

    return {
        job_id: String(doc._id),
        job_type: doc.job_type,
        partner_app_id: partnerAppId,
        payload: doc.payload || {},
        status: doc.status,
        triggered_by: doc.triggered_by,
        triggered_by_user_id: doc.triggered_by_user_id || '',
        started_at: doc.started_at || null,
        completed_at: doc.completed_at || null,
        duration_ms: doc.duration_ms ?? null,
        error_message: doc.error_message || '',
        error_stack: doc.error_stack || '',
        failure_reason: doc.failure_reason || '',
        result_summary: doc.result_summary || {},
        attempts: doc.attempts ?? 0,
        createdAt: doc.createdAt || null,
        updatedAt: doc.updatedAt || null
    };
};

export = {
    serializeSyncJob
};
