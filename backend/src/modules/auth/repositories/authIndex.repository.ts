'use strict';

/**
 * Builds the auth collections' indexes explicitly at boot (spec §3, A8 — FATAL on failure).
 *
 * WHY EXPLICIT: several auth flows use a UNIQUE index as their race-free gate and branch on its
 * E11000 — `uniq_user_email` (ALREADY_A_MEMBER), `uniq_invite_pending_email` (INVITE_PENDING),
 * `uniq_role_name_norm` (ROLE_NAME_TAKEN), and the token-hash uniques. With
 * `MONGO_DISABLE_AUTO_INDEX=true` Mongoose never builds them, and even with autoIndex on the build
 * is asynchronous: the first insert can race it, and a gate that does not exist yet admits both
 * writers. So boot awaits `Model.createIndexes()` for each collection before the server accepts a
 * user-creating request (the service refuses those writes until this has succeeded).
 *
 * `createIndexes()` is idempotent for indexes that already exist with the same name and options. It
 * THROWS when an existing index conflicts (same keys under another name or options) — which is
 * correct to surface at boot rather than to run with a gate the schema claims but Mongo lacks.
 */

import models = require('../../shared/repositories/models.repository');

/**
 * Creates every declared index on the auth collections that carry gates or TTLs, one collection at
 * a time (a failure names the collection it happened on).
 *
 * `gi_system_states` is not listed: it has only `_id`. `gi_admin_users` is not listed: it is legacy
 * and its unique email index was built by v0.1.
 *
 * @returns The collection names whose indexes were ensured, in order.
 * @throws The first `createIndexes` failure, with the collection name prefixed to its message.
 */
const createAuthIndexes = async (): Promise<string[]> => {
    const targets = [
        { collection: 'gi_users', model: models.UserModel },
        { collection: 'gi_invites', model: models.InviteModel },
        { collection: 'gi_auth_tokens', model: models.AuthTokenModel },
        { collection: 'gi_auth_sessions', model: models.AuthSessionModel },
        { collection: 'gi_roles', model: models.RoleModel },
        { collection: 'gi_audit_events', model: models.AuditEventModel }
    ];
    const done: string[] = [];
    for (const target of targets) {
        try {
            await target.model.createIndexes();
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`createIndexes failed on ${target.collection}: ${detail}`, { cause: error });
        }
        done.push(target.collection);
    }
    return done;
};

export = {
    createAuthIndexes
};
