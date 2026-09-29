'use strict';

/**
 * Every read and write on `gi_auth_sessions`. A session's `_id` IS the JWT `sid`.
 *
 * The guard re-reads the session on every request (`principal.service#loadPrincipal`), so what this
 * file writes takes effect on the NEXT request, not at token expiry. Revocation marks `revoked_at`
 * (kept for audit) — it never deletes; the TTL index removes rows after `expires_at`.
 *
 * Mass sign-outs ALSO bump `gi_users.session_epoch` (user.repository) in the same update that
 * changes the user; marking rows here is the audit trail and the belt to that brace (spec A4).
 *
 * Reads no clock: `now` is an argument everywhere.
 */

import models = require('../../shared/repositories/models.repository');
import authConstants = require('../constants/auth.constants');
import identityHelper = require('../helpers/identity.helper');

import type { AuthSessionDoc, ObjectIdLike } from '../../shared/types/entity.types';
import type { NewSessionFields } from '../types/auth.types';

const { AuthSessionModel } = models;
const { USER_AGENT_MAX_LENGTH } = authConstants;

/**
 * Belt and braces (spec I8): the row that came back is the row that was asked for.
 *
 * @param doc - The document the query returned.
 * @param session_id - The id that was asked for.
 * @returns The document, or `null` when absent or a different row.
 */
const _sameSession = (doc: AuthSessionDoc | null, session_id: ObjectIdLike): AuthSessionDoc | null => {
    if (!doc || String(doc._id) !== String(session_id)) {
        return null;
    }
    return doc;
};

/**
 * Trims a User-Agent header to what is stored: a string of at most 200 characters, or `null`.
 *
 * @param userAgent - The raw header value.
 * @returns The stored form.
 */
const _storedUserAgent = (userAgent: unknown): string | null => {
    if (typeof userAgent !== 'string' || userAgent.length === 0) {
        return null;
    }
    return Array.from(userAgent).slice(0, USER_AGENT_MAX_LENGTH).join('');
};

/**
 * Inserts a session. `epoch` MUST be the `session_epoch` from the same user read the credential
 * check used (spec A4) — a later read could carry an epoch a concurrent reset already bumped past.
 *
 * @param fields - The new session.
 * @returns The inserted session (its `_id` is the `sid` to sign).
 */
const insertSession = async (fields: NewSessionFields): Promise<AuthSessionDoc> => {
    const created = await AuthSessionModel.create({
        user_id: fields.user_id,
        epoch: fields.epoch,
        expires_at: fields.expires_at,
        revoked_at: null,
        revoked_reason: null,
        ip: typeof fields.ip === 'string' ? fields.ip : null,
        user_agent: _storedUserAgent(fields.user_agent)
    });
    const plain: AuthSessionDoc = created.toObject();
    return plain;
};

/**
 * Reads a session by id, in any state (the guard decides what revoked / expired / stale mean).
 *
 * @param session_id - The JWT `sid`.
 * @returns The session, or `null` (also for a malformed id).
 */
const findById = async (session_id: ObjectIdLike): Promise<AuthSessionDoc | null> => {
    if (!identityHelper.isObjectIdLike(session_id)) {
        return null;
    }
    const doc = await AuthSessionModel.findById(session_id).lean<AuthSessionDoc | null>();
    return _sameSession(doc, session_id);
};

/**
 * Revokes one session (sign-out — current session only, no epoch bump). CAS on `revoked_at: null`
 * and on the owning user, so a sid presented with someone else's `sub` revokes nothing.
 *
 * @param params0 - The parameters object.
 * @param params0.session_id - The session.
 * @param params0.user_id - The user it must belong to.
 * @param params0.reason - One of `SESSION_REVOKE_REASONS`.
 * @param params0.now - Recorded as `revoked_at`.
 * @returns The revoked session, or `null` when already revoked, absent or not this user's.
 */
const revokeSession = async ({ session_id, user_id, reason, now }: {
    session_id: ObjectIdLike;
    user_id: ObjectIdLike;
    reason: string;
    now: Date;
}): Promise<AuthSessionDoc | null> => {
    if (!identityHelper.isObjectIdLike(session_id) || !identityHelper.isObjectIdLike(user_id) || typeof reason !== 'string') {
        return null;
    }
    const doc = await AuthSessionModel.findOneAndUpdate(
        { _id: session_id, user_id: user_id, revoked_at: null },
        { $set: { revoked_at: now, revoked_reason: reason } },
        { returnDocument: 'after' }
    ).lean<AuthSessionDoc | null>();
    return _sameSession(doc, session_id);
};

/**
 * Marks every LIVE session of a user revoked, optionally keeping one (change-password and
 * "sign out my other sessions" keep the caller's — which the service then replaces with a fresh
 * session carrying the new epoch).
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user.
 * @param params0.reason - One of `SESSION_REVOKE_REASONS`.
 * @param params0.now - Recorded as `revoked_at`; also the liveness instant.
 * @param params0.except_session_id - A session to leave alone.
 * @returns How many sessions were revoked (the `{ revoked: n }` the API reports).
 */
const revokeAllForUser = async ({ user_id, reason, now, except_session_id }: {
    user_id: ObjectIdLike;
    reason: string;
    now: Date;
    except_session_id?: ObjectIdLike;
}): Promise<number> => {
    if (!identityHelper.isObjectIdLike(user_id) || typeof reason !== 'string') {
        return 0;
    }
    const filter: Record<string, unknown> = { user_id: user_id, revoked_at: null, expires_at: { $gt: now } };
    if (except_session_id !== undefined) {
        if (!identityHelper.isObjectIdLike(except_session_id)) {
            return 0;
        }
        filter._id = { $ne: except_session_id };
    }
    const result = await AuthSessionModel.updateMany(filter, { $set: { revoked_at: now, revoked_reason: reason } });
    return result.modifiedCount || 0;
};

/**
 * Marks EVERY live session revoked (CLI `revoke-sessions --all`). The CLI also bumps every user's
 * epoch; this is the audit trail.
 *
 * @param params0 - The parameters object.
 * @param params0.reason - One of `SESSION_REVOKE_REASONS`.
 * @param params0.now - Recorded as `revoked_at`; also the liveness instant.
 * @returns How many sessions were revoked.
 */
const revokeAll = async ({ reason, now }: { reason: string; now: Date }): Promise<number> => {
    if (typeof reason !== 'string') {
        return 0;
    }
    const result = await AuthSessionModel.updateMany(
        { revoked_at: null, expires_at: { $gt: now } },
        { $set: { revoked_at: now, revoked_reason: reason } }
    );
    return result.modifiedCount || 0;
};

export = {
    insertSession,
    findById,
    revokeSession,
    revokeAllForUser,
    revokeAll
};
