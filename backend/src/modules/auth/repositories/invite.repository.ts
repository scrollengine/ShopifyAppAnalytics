'use strict';

/**
 * Every read and write on `gi_invites`.
 *
 * ── Token hashes never leave this file ──────────────────────────────────────────────────────────
 * `token_hash` is `select: false`. The two token lookups and the acceptance CAS ask for
 * `+token_hash`, compare it in code (`token.helper#verifyAndStripTokenHash` — belt and braces over
 * the query, spec I8) and DELETE it before returning. Every other function returns documents that
 * never carried it, and `insertInvite` strips the one it just wrote.
 *
 * ── "Live" vs "outstanding" ─────────────────────────────────────────────────────────────────────
 *  - LIVE = `accepted_at: null, revoked_at: null, expires_at > now` — the link works. The read-side
 *    twin of this filter is `invite.helper#inviteState === 'pending'`; the two must agree.
 *  - OUTSTANDING = `accepted_at: null, revoked_at: null` regardless of expiry — the invite still
 *    holds `pending_email`, so it still blocks a second invite to the address and can be re-sent.
 *    Revocations that follow a person's access (inviter disabled, role deleted, rule no longer
 *    met) act on OUTSTANDING invites, so an expired one cannot be resent back to life afterwards.
 *
 * Every state change is one `findOneAndUpdate` whose filter names the required state
 * (`returnDocument: 'after'`). Reads no clock: `now` is an argument everywhere.
 */

import models = require('../../shared/repositories/models.repository');
import identityHelper = require('../helpers/identity.helper');
import tokenHelper = require('../helpers/token.helper');

import type { InviteDoc, ObjectIdLike } from '../../shared/types/entity.types';
import type { NewInviteFields, SendSlotThrottle } from '../types/auth.types';

const { InviteModel } = models;

/**
 * Belt and braces (spec I8): the row that came back is the row that was asked for.
 *
 * @param doc - The document the query returned.
 * @param invite_id - The id that was asked for.
 * @returns The document, or `null` when absent or a different row.
 */
const _sameInvite = (doc: InviteDoc | null, invite_id: ObjectIdLike): InviteDoc | null => {
    if (!doc || String(doc._id) !== String(invite_id)) {
        return null;
    }
    return doc;
};

/**
 * Inserts an invite and records its first send. `pending_email` is set to the address, which is
 * what makes "one outstanding invite per address" a database guarantee (spec A13).
 *
 * THROWS E11000 with keyPattern `{ pending_email: 1 }` when the address already has an outstanding
 * invite (INVITE_PENDING — an expired-but-unrevoked one counts; re-send it).
 *
 * @param fields - The invite. `invited_by_user_id` is stored as both the current and the creating inviter.
 * @returns The inserted invite, WITHOUT `token_hash`.
 */
const insertInvite = async (fields: NewInviteFields): Promise<InviteDoc> => {
    const email = identityHelper.normaliseEmail(fields.email);
    const created = await InviteModel.create({
        email: email,
        pending_email: email,
        role_key: fields.role_key,
        custom_role_id: fields.custom_role_id,
        invited_by_user_id: fields.invited_by_user_id,
        created_by_user_id: fields.invited_by_user_id,
        token_hash: fields.token_hash,
        expires_at: fields.expires_at,
        accepted_at: null,
        accepted_user_id: null,
        revoked_at: null,
        revoked_by_user_id: null,
        revoked_reason: null,
        last_sent_at: fields.now,
        send_count: 1,
        send_log: [fields.now]
    });
    const plain: InviteDoc = created.toObject();
    delete plain.token_hash;
    return plain;
};

/**
 * Reads an invite by id.
 *
 * @param invite_id - The `gi_invites._id`.
 * @returns The invite (no hash), or `null` (also for a malformed id).
 */
const findById = async (invite_id: ObjectIdLike): Promise<InviteDoc | null> => {
    if (!identityHelper.isObjectIdLike(invite_id)) {
        return null;
    }
    const doc = await InviteModel.findById(invite_id).lean<InviteDoc | null>();
    return _sameInvite(doc, invite_id);
};

/**
 * Finds the LIVE invite a link token belongs to (spec A3).
 *
 * @param params0 - The parameters object.
 * @param params0.token_hash - sha256 hex of the presented token.
 * @param params0.now - Only invites with `expires_at > now` match.
 * @returns The invite WITHOUT `token_hash`, or `null` when no live invite has this hash.
 */
const findLiveByTokenHash = async ({ token_hash, now }: { token_hash: string; now: Date }): Promise<InviteDoc | null> => {
    if (!tokenHelper.isTokenHash(token_hash)) {
        return null;
    }
    const doc = await InviteModel.findOne({
        token_hash: token_hash,
        accepted_at: null,
        revoked_at: null,
        expires_at: { $gt: now }
    })
        .select('+token_hash')
        .lean<InviteDoc | null>();
    return tokenHelper.verifyAndStripTokenHash(doc, token_hash);
};

/**
 * Finds the invite a link token belongs to IN ANY STATE — only after the live lookup failed, to say
 * which specific error applies (expired / revoked / used — spec A14). Only the holder of a 256-bit
 * token can ask, so this leaks nothing.
 *
 * @param params0 - The parameters object.
 * @param params0.token_hash - sha256 hex of the presented token.
 * @returns The invite WITHOUT `token_hash`, or `null`.
 */
const findAnyByTokenHash = async ({ token_hash }: { token_hash: string }): Promise<InviteDoc | null> => {
    if (!tokenHelper.isTokenHash(token_hash)) {
        return null;
    }
    const doc = await InviteModel.findOne({ token_hash: token_hash })
        .select('+token_hash')
        .lean<InviteDoc | null>();
    return tokenHelper.verifyAndStripTokenHash(doc, token_hash);
};

/**
 * The OUTSTANDING invite holding an address (the one that makes a new invite answer
 * INVITE_PENDING), expired or not.
 *
 * @param params0 - The parameters object.
 * @param params0.email - The address; normalised here.
 * @returns The invite, or `null`.
 */
const findOutstandingByEmail = async ({ email }: { email: unknown }): Promise<InviteDoc | null> => {
    const normalised = identityHelper.normaliseEmail(email);
    if (!normalised) {
        return null;
    }
    const doc = await InviteModel.findOne({ pending_email: normalised }).lean<InviteDoc | null>();
    return doc && doc.pending_email === normalised ? doc : null;
};

/**
 * Every invite, newest first. Complete rather than paged: creation is capped per actor per day, and
 * a list that silently stopped at N would hide links that still work.
 *
 * @returns All invites, without token hashes.
 */
const listInvites = async (): Promise<InviteDoc[]> => {
    return InviteModel.find({}).sort({ createdAt: -1, _id: -1 }).lean<InviteDoc[]>();
};

/**
 * OUTSTANDING invites (not accepted, not revoked, expired or not), optionally narrowed. Used to
 * re-evaluate or revoke invites after an inviter is disabled, an inviter's role changes, a custom
 * role changes or is deleted, and to find siblings to supersede on acceptance.
 *
 * ⚠️ With no narrowing field this returns EVERY outstanding invite. A narrowing field that is
 * present but malformed returns `[]` — never "all".
 *
 * @param params0 - The parameters object.
 * @param params0.invited_by_user_id - Only invites this user currently answers for.
 * @param params0.custom_role_id - Only invites naming this custom role.
 * @param params0.email - Only invites to this address (normalised here).
 * @returns The invites, oldest first.
 */
const listOutstanding = async ({ invited_by_user_id, custom_role_id, email }: {
    invited_by_user_id?: ObjectIdLike;
    custom_role_id?: ObjectIdLike;
    email?: string;
}): Promise<InviteDoc[]> => {
    const filter: Record<string, unknown> = { accepted_at: null, revoked_at: null };
    if (invited_by_user_id !== undefined) {
        if (!identityHelper.isObjectIdLike(invited_by_user_id)) {
            return [];
        }
        filter.invited_by_user_id = invited_by_user_id;
    }
    if (custom_role_id !== undefined) {
        if (!identityHelper.isObjectIdLike(custom_role_id)) {
            return [];
        }
        filter.custom_role_id = custom_role_id;
    }
    if (email !== undefined) {
        const normalised = identityHelper.normaliseEmail(email);
        if (!normalised) {
            return [];
        }
        filter.email = normalised;
    }
    return InviteModel.find(filter).sort({ createdAt: 1, _id: 1 }).lean<InviteDoc[]>();
};

/**
 * Whether a LIVE invite names a custom role — the invite half of ROLE_IN_USE (spec §7.5).
 *
 * @param params0 - The parameters object.
 * @param params0.role_id - The `gi_roles._id`.
 * @param params0.now - Live means `expires_at > now`.
 * @returns True when at least one live invite names it.
 */
const existsLiveWithCustomRole = async ({ role_id, now }: { role_id: ObjectIdLike; now: Date }): Promise<boolean> => {
    if (!identityHelper.isObjectIdLike(role_id)) {
        return false;
    }
    const found = await InviteModel.exists({
        custom_role_id: role_id,
        accepted_at: null,
        revoked_at: null,
        expires_at: { $gt: now }
    });
    return found !== null;
};

/**
 * Counts invites an actor CREATED since an instant — the per-actor creation cap (≤ 20 per 24 h,
 * spec A13). Counts `created_by_user_id`, which never changes, so re-sends and ownership transfers
 * do not move invites between actors' budgets.
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The creating actor.
 * @param params0.since - Window start (inclusive).
 * @returns The count.
 */
const countCreatedBySince = async ({ user_id, since }: { user_id: ObjectIdLike; since: Date }): Promise<number> => {
    if (!identityHelper.isObjectIdLike(user_id)) {
        return 0;
    }
    return InviteModel.countDocuments({ created_by_user_id: user_id, createdAt: { $gte: since } }).exec();
};

/**
 *  THE ACCEPTANCE CAS. The filter names the invite, its token hash and the live state, so a link is
 * spent exactly once and a revoke racing an accept has exactly one winner. `pending_email` is
 * unset in the same update, freeing the address.
 *
 * @param params0 - The parameters object.
 * @param params0.invite_id - The invite the live lookup found.
 * @param params0.token_hash - sha256 hex of the presented token (re-asserted here, spec A13).
 * @param params0.accepted_user_id - The user row the acceptance just inserted.
 * @param params0.now - Recorded as `accepted_at`; also the liveness instant.
 * @returns The accepted invite WITHOUT `token_hash`, or `null` when it was no longer live — the
 *     caller then deletes the user it inserted.
 */
const acceptInvite = async ({ invite_id, token_hash, accepted_user_id, now }: {
    invite_id: ObjectIdLike;
    token_hash: string;
    accepted_user_id: ObjectIdLike;
    now: Date;
}): Promise<InviteDoc | null> => {
    if (!identityHelper.isObjectIdLike(invite_id) || !identityHelper.isObjectIdLike(accepted_user_id) || !tokenHelper.isTokenHash(token_hash)) {
        return null;
    }
    const doc = await InviteModel.findOneAndUpdate(
        {
            _id: invite_id,
            token_hash: token_hash,
            accepted_at: null,
            revoked_at: null,
            expires_at: { $gt: now }
        },
        {
            $set: { accepted_at: now, accepted_user_id: accepted_user_id },
            $unset: { pending_email: 1 }
        },
        { returnDocument: 'after' }
    )
        .select('+token_hash')
        .lean<InviteDoc | null>();
    return _sameInvite(tokenHelper.verifyAndStripTokenHash(doc, token_hash), invite_id);
};

/**
 * Revokes an OUTSTANDING invite (CAS on `accepted_at: null, revoked_at: null` — spec A13), freeing
 * its address. `null` back ⇒ INVITE_NOT_PENDING (already accepted or revoked) or not found.
 *
 * @param params0 - The parameters object.
 * @param params0.invite_id - The invite.
 * @param params0.actor_user_id - Who revoked it; `null` for a revocation the system made.
 * @param params0.reason - One of `INVITE_REVOKE_REASONS`.
 * @param params0.now - Recorded as `revoked_at`.
 * @returns The revoked invite, or `null`.
 */
const revokeInvite = async ({ invite_id, actor_user_id, reason, now }: {
    invite_id: ObjectIdLike;
    actor_user_id: ObjectIdLike | null;
    reason: string;
    now: Date;
}): Promise<InviteDoc | null> => {
    if (!identityHelper.isObjectIdLike(invite_id) || typeof reason !== 'string') {
        return null;
    }
    if (actor_user_id !== null && !identityHelper.isObjectIdLike(actor_user_id)) {
        return null;
    }
    const doc = await InviteModel.findOneAndUpdate(
        { _id: invite_id, accepted_at: null, revoked_at: null },
        {
            $set: { revoked_at: now, revoked_by_user_id: actor_user_id, revoked_reason: reason },
            $unset: { pending_email: 1 }
        },
        { returnDocument: 'after' }
    ).lean<InviteDoc | null>();
    return _sameInvite(doc, invite_id);
};

/**
 *  THE RESEND CAS (spec A13). One update that checks the throttle, rotates the token, resets the
 * expiry, hands the invite to the resender and records the send:
 *  - the invite is OUTSTANDING (an expired one may be re-sent; accepted/revoked may not);
 *  - interval: `last_sent_at` is null or at least `min_interval_ms` old;
 *  - window: `send_log.<max-1>` is absent or older than the window start (the log is kept NEWEST
 *    FIRST by `$sort: -1, $slice: keep`), i.e. fewer than `max_per_window` sends in the window.
 * `null` back ⇒ throttled (429) or no longer outstanding (409) — the caller re-reads to tell which.
 *
 * @param params0 - The parameters object.
 * @param params0.invite_id - The invite.
 * @param params0.actor_user_id - The resender, who has just passed the management rule; becomes `invited_by_user_id`.
 * @param params0.token_hash - sha256 hex of the NEW token (the old link stops working).
 * @param params0.expires_at - The new expiry.
 * @param params0.throttle - `now`, the interval, the window cap and size, and how many entries to keep.
 * @returns The updated invite (no hash), or `null`.
 */
const claimResend = async ({ invite_id, actor_user_id, token_hash, expires_at, throttle }: {
    invite_id: ObjectIdLike;
    actor_user_id: ObjectIdLike;
    token_hash: string;
    expires_at: Date;
    throttle: SendSlotThrottle;
}): Promise<InviteDoc | null> => {
    if (!identityHelper.isObjectIdLike(invite_id) || !identityHelper.isObjectIdLike(actor_user_id) || !tokenHelper.isTokenHash(token_hash)) {
        return null;
    }
    const { now, min_interval_ms, max_per_window, window_ms, keep } = throttle;
    if (!Number.isInteger(max_per_window) || max_per_window < 1 || !Number.isInteger(keep) || keep < max_per_window) {
        return null;
    }
    const intervalCutoff = new Date(now.getTime() - min_interval_ms);
    const windowStart = new Date(now.getTime() - window_ms);
    const oldestCounted = `send_log.${max_per_window - 1}`;

    const doc = await InviteModel.findOneAndUpdate(
        {
            _id: invite_id,
            accepted_at: null,
            revoked_at: null,
            $and: [
                { $or: [{ last_sent_at: null }, { last_sent_at: { $lte: intervalCutoff } }] },
                { $or: [{ [oldestCounted]: { $exists: false } }, { [oldestCounted]: { $lte: windowStart } }] }
            ]
        },
        {
            $set: {
                token_hash: token_hash,
                expires_at: expires_at,
                invited_by_user_id: actor_user_id,
                last_sent_at: now
            },
            $inc: { send_count: 1 },
            $push: { send_log: { $each: [now], $sort: -1, $slice: keep } }
        },
        { returnDocument: 'after' }
    ).lean<InviteDoc | null>();
    return _sameInvite(doc, invite_id);
};

/**
 * Hands every OUTSTANDING invite from one inviter to another (CLI `transfer-owner` re-parents the
 * previous owner's invites to the new owner — spec A13).
 *
 * @param params0 - The parameters object.
 * @param params0.from_user_id - The current inviter.
 * @param params0.to_user_id - The new inviter.
 * @returns How many invites moved.
 */
const reparentOutstanding = async ({ from_user_id, to_user_id }: { from_user_id: ObjectIdLike; to_user_id: ObjectIdLike }): Promise<number> => {
    if (!identityHelper.isObjectIdLike(from_user_id) || !identityHelper.isObjectIdLike(to_user_id)) {
        return 0;
    }
    const result = await InviteModel.updateMany(
        { invited_by_user_id: from_user_id, accepted_at: null, revoked_at: null },
        { $set: { invited_by_user_id: to_user_id } }
    );
    return result.modifiedCount || 0;
};

export = {
    insertInvite,
    findById,
    findLiveByTokenHash,
    findAnyByTokenHash,
    findOutstandingByEmail,
    listInvites,
    listOutstanding,
    existsLiveWithCustomRole,
    countCreatedBySince,
    acceptInvite,
    revokeInvite,
    claimResend,
    reparentOutstanding
};
