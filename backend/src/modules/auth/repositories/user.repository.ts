'use strict';

/**
 * Every read and write on `gi_users`.
 *
 * ── The `select: false` contract ────────────────────────────────────────────────────────────────
 * `password_hash` is absent from every ordinary read. The two functions that ask for it say so in
 * their name (`…WithHash`) and have one use each: the sign-in comparison and the change-password
 * comparison. A flag argument would read the same at every call site; a name puts the decision in
 * the function you chose to call. Writes that return a document return it WITHOUT the hash.
 *
 * ── Compare-and-set, never read-then-write ──────────────────────────────────────────────────────
 * Every state change is ONE `findOneAndUpdate` whose filter names the state the row must be in
 * (`returnDocument: 'after'`, never `new: true`). `null` back means "the row was not in that
 * state" — the caller re-reads to say why. There are no transactions here (spec I10).
 *
 * ── Session epoch (spec A4) ─────────────────────────────────────────────────────────────────────
 * Password writes, disable, enable and "sign out everywhere" `$inc` `session_epoch` in the SAME
 * update that changes the row, so a sign-in that read the user just before cannot mint a session
 * that survives the change. Role changes do NOT bump it: permissions are re-read per request.
 *
 * Emails are normalised here as well as by the service (trim + lowercase, the schema's own write
 * rule), so no lookup depends on which query form Mongoose happens to cast.
 */

import mongoose = require('mongoose');
import models = require('../../shared/repositories/models.repository');
import authVocab = require('../../../constants/authVocab.constants');
import identityHelper = require('../helpers/identity.helper');

import type { ObjectIdLike, UserDoc } from '../../shared/types/entity.types';
import type { ExpectedRole, NewUserFields, SendSlotThrottle } from '../types/auth.types';

const { UserModel } = models;
const { USER_STATUSES, CREATED_VIA } = authVocab;

/**
 * Adds an expected-role precondition to a filter, so a management decision taken against the
 * target's role cannot land after that role changed (e.g. an admin disabling someone the owner has
 * just promoted to Admin). `custom_role_id: null` matches null or missing.
 *
 * @param filter - The filter to extend (mutated and returned).
 * @param expected - The role the caller evaluated, or absent for no precondition.
 * @returns The filter, or `null` when `expected` is malformed (the write must then match nothing).
 */
const _withExpectedRole = (filter: Record<string, unknown>, expected: ExpectedRole | null | undefined): Record<string, unknown> | null => {
    if (expected === null || expected === undefined) {
        return filter;
    }
    if (typeof expected.role_key !== 'string') {
        return null;
    }
    if (expected.custom_role_id !== null && !identityHelper.isObjectIdLike(expected.custom_role_id)) {
        return null;
    }
    filter.role_key = expected.role_key;
    filter.custom_role_id = expected.custom_role_id;
    return filter;
};

/**
 * Belt and braces over the query (spec I8): the row that came back is the row that was asked for.
 *
 * @param doc - The document the query returned.
 * @param user_id - The id that was asked for.
 * @returns The document, or `null` when absent or a different row.
 */
const _sameUser = (doc: UserDoc | null, user_id: ObjectIdLike): UserDoc | null => {
    if (!doc || String(doc._id) !== String(user_id)) {
        return null;
    }
    return doc;
};

/**
 * A fresh id for a user row that is about to be inserted — generated BEFORE the insert because two
 * flows must name the row first: setup takes the install lock pointing at the owner's id and only
 * then inserts the owner (so a crash in between can be rolled forward), and invite acceptance
 * inserts the user and then records its id on the invite by CAS.
 *
 * @returns A new ObjectId as 24-character lowercase hex.
 */
const newUserId = (): string => {
    return new mongoose.Types.ObjectId().toHexString();
};

/**
 * Reads a user by id, WITHOUT the password hash.
 *
 * @param user_id - The `gi_users._id`.
 * @returns The user, or `null` (also for a malformed id).
 */
const findById = async (user_id: ObjectIdLike): Promise<UserDoc | null> => {
    if (!identityHelper.isObjectIdLike(user_id)) {
        return null;
    }
    const doc = await UserModel.findById(user_id).lean<UserDoc | null>();
    return _sameUser(doc, user_id);
};

/**
 * Reads a user by id WITH `password_hash`. One use: the change-password comparison. The result
 * must never reach a response, a log line or another module.
 *
 * @param user_id - The `gi_users._id`.
 * @returns The user including `password_hash`, or `null`.
 */
const findByIdWithHash = async (user_id: ObjectIdLike): Promise<UserDoc | null> => {
    if (!identityHelper.isObjectIdLike(user_id)) {
        return null;
    }
    const doc = await UserModel.findById(user_id).select('+password_hash').lean<UserDoc | null>();
    return _sameUser(doc, user_id);
};

/**
 * Reads a user by email, WITHOUT the password hash. Any status.
 *
 * @param email - The address; normalised here.
 * @returns The user, or `null` (also for a non-string or empty address).
 */
const findByEmail = async (email: unknown): Promise<UserDoc | null> => {
    const normalised = identityHelper.normaliseEmail(email);
    if (!normalised) {
        return null;
    }
    const doc = await UserModel.findOne({ email: normalised }).lean<UserDoc | null>();
    return doc && doc.email === normalised ? doc : null;
};

/**
 * Reads a user by email WITH `password_hash`. One use: the sign-in comparison — and the SAME read
 * supplies the `session_epoch` the new session copies (spec A4).
 *
 * @param email - The address; normalised here.
 * @returns The user including `password_hash`, or `null`.
 */
const findByEmailWithHash = async (email: unknown): Promise<UserDoc | null> => {
    const normalised = identityHelper.normaliseEmail(email);
    if (!normalised) {
        return null;
    }
    const doc = await UserModel.findOne({ email: normalised }).select('+password_hash').lean<UserDoc | null>();
    return doc && doc.email === normalised ? doc : null;
};

/**
 * Reads several users by id (e.g. the inviters named on the invitations list). Malformed ids are
 * skipped.
 *
 * @param user_ids - The ids.
 * @returns The users found, in no particular order.
 */
const findByIds = async (user_ids: readonly ObjectIdLike[]): Promise<UserDoc[]> => {
    const ids = Array.isArray(user_ids) ? user_ids.filter((id) => identityHelper.isObjectIdLike(id)) : [];
    if (ids.length === 0) {
        return [];
    }
    return UserModel.find({ _id: { $in: ids } }).lean<UserDoc[]>();
};

/**
 * Whether a user row with this id exists (the setup roll-forward's "is the owner inserted yet").
 *
 * @param user_id - The id.
 * @returns True when a row exists.
 */
const existsById = async (user_id: ObjectIdLike): Promise<boolean> => {
    if (!identityHelper.isObjectIdLike(user_id)) {
        return false;
    }
    const found = await UserModel.exists({ _id: user_id });
    return found !== null && String(found._id) === String(user_id);
};

/**
 * Every user, oldest first. The team is small by nature (everyone was invited by hand), so the list
 * is complete rather than paged — a users page that silently showed "the first N" would hide people
 * who can sign in.
 *
 * @returns All users, without password hashes.
 */
const listUsers = async (): Promise<UserDoc[]> => {
    return UserModel.find({}).sort({ createdAt: 1, _id: 1 }).lean<UserDoc[]>();
};

/**
 * Every user holding a given custom role (re-evaluating their outstanding invites after the role's
 * permissions change).
 *
 * @param params0 - The parameters object.
 * @param params0.role_id - The `gi_roles._id`.
 * @returns The users, oldest first. Empty for a malformed id.
 */
const listUsersByCustomRole = async ({ role_id }: { role_id: ObjectIdLike }): Promise<UserDoc[]> => {
    if (!identityHelper.isObjectIdLike(role_id)) {
        return [];
    }
    return UserModel.find({ role_key: authVocab.ROLE_KEYS.CUSTOM, custom_role_id: role_id })
        .sort({ createdAt: 1, _id: 1 })
        .lean<UserDoc[]>();
};

/**
 * Whether any user (any status) references a custom role — the user half of ROLE_IN_USE.
 *
 * @param params0 - The parameters object.
 * @param params0.role_id - The `gi_roles._id`.
 * @returns True when at least one user row points at it.
 */
const existsWithCustomRole = async ({ role_id }: { role_id: ObjectIdLike }): Promise<boolean> => {
    if (!identityHelper.isObjectIdLike(role_id)) {
        return false;
    }
    const found = await UserModel.exists({ custom_role_id: role_id });
    return found !== null;
};

/**
 * Counts user rows, any status. `ensureInstallState` creates the install LOCKED when this is
 * non-zero (spec A7).
 *
 * @returns The row count.
 */
const countUsers = async (): Promise<number> => {
    return UserModel.countDocuments({}).exec();
};

/**
 * Counts users by status, from ONE aggregation (one instant, so the two numbers cannot disagree).
 *
 * @returns `{ active, disabled }`. A status value this build does not know is not counted in either.
 */
const countUsersByStatus = async (): Promise<{ active: number; disabled: number }> => {
    const rows = await UserModel.aggregate<{ _id: unknown; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    const counts = { active: 0, disabled: 0 };
    for (const row of rows) {
        if (row._id === USER_STATUSES.ACTIVE) {
            counts.active = row.count || 0;
        } else if (row._id === USER_STATUSES.DISABLED) {
            counts.disabled = row.count || 0;
        }
    }
    return counts;
};

/**
 * Inserts a user. `status` is always `active`, `session_epoch` 0, `reset_send_log` empty.
 *
 * ⚠️ `password_hash` must ALREADY be a bcrypt hash of the NFC-normalised password. This function
 * cannot tell a hash from a password; the parameter is named for what it must contain.
 *
 * THROWS E11000 by design — the unique indexes are the race-free gates, and the caller branches on
 * `error.keyPattern` (`datastoreError.helper#duplicateKeyField`): `_id` ⇒ already inserted (setup
 * roll-forward, idempotent), `email` ⇒ ALREADY_A_MEMBER.
 *
 * @param fields - The new user.
 * @returns The inserted user, WITHOUT `password_hash`.
 */
const insertUser = async (fields: NewUserFields): Promise<UserDoc> => {
    const created = await UserModel.create({
        _id: fields._id,
        email: identityHelper.normaliseEmail(fields.email),
        name: fields.name,
        password_hash: fields.password_hash,
        role_key: fields.role_key,
        custom_role_id: fields.custom_role_id,
        status: USER_STATUSES.ACTIVE,
        email_verified_at: fields.email_verified_at,
        password_changed_at: fields.password_changed_at,
        last_login_at: null,
        invited_by_user_id: fields.invited_by_user_id,
        created_via: fields.created_via,
        disabled_at: null,
        disabled_by_user_id: null,
        session_epoch: 0,
        reset_send_log: []
    });
    const plain: UserDoc = created.toObject();
    delete plain.password_hash;
    return plain;
};

/**
 * Deletes a user an invite acceptance inserted, when the acceptance's CAS then lost (the invite was
 * revoked, expired or accepted in between — spec §7.3). Scoped to `created_via: 'invite'` so this
 * can never remove the owner or anyone setup created.
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The id the acceptance inserted.
 * @returns How many rows were deleted (0 or 1).
 */
const deleteUnacceptedInviteUser = async ({ user_id }: { user_id: ObjectIdLike }): Promise<number> => {
    if (!identityHelper.isObjectIdLike(user_id)) {
        return 0;
    }
    const result = await UserModel.deleteOne({ _id: user_id, created_via: CREATED_VIA.INVITE });
    return result.deletedCount || 0;
};

/**
 * Records a successful sign-in. The caller treats a failure here as non-fatal.
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user.
 * @param params0.now - The instant to record.
 * @returns Resolves once written.
 */
const touchLastLogin = async ({ user_id, now }: { user_id: ObjectIdLike; now: Date }): Promise<void> => {
    if (!identityHelper.isObjectIdLike(user_id)) {
        return;
    }
    await UserModel.updateOne({ _id: user_id }, { $set: { last_login_at: now } });
};

/**
 * Replaces a hash with one at the configured bcrypt cost after a successful sign-in (spec A4).
 * CAS on the hash that was compared, so a password change that landed in between is never
 * overwritten with the old password. Touches neither `password_changed_at` nor `session_epoch`.
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user.
 * @param params0.current_password_hash - The hash the sign-in compared against.
 * @param params0.password_hash - The new hash of the SAME (NFC) password.
 * @returns True when the row was updated.
 */
const rehashPassword = async ({ user_id, current_password_hash, password_hash }: {
    user_id: ObjectIdLike;
    current_password_hash: string;
    password_hash: string;
}): Promise<boolean> => {
    if (!identityHelper.isObjectIdLike(user_id) || typeof current_password_hash !== 'string' || !current_password_hash) {
        return false;
    }
    const result = await UserModel.updateOne(
        { _id: user_id, password_hash: current_password_hash },
        { $set: { password_hash: password_hash } }
    );
    return (result.modifiedCount || 0) === 1;
};

/**
 * Writes a new password hash, stamps `password_changed_at` and bumps `session_epoch` — one update,
 * so every session minted before it is refused from the next request on (spec A4).
 *
 * Only an ACTIVE user's password is written. Two optional preconditions make the write a CAS:
 *  - `expected_password_hash` (change-password): the hash the current password was checked against,
 *    so a reset that landed in between is not overwritten by a stale change.
 *  - `changed_before` (reset): the token's `createdAt`; the write matches only while
 *    `password_changed_at` is null or older, so a reset link cannot undo a later change.
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user.
 * @param params0.password_hash - The new bcrypt hash (of the NFC-normalised password).
 * @param params0.now - Recorded as `password_changed_at`.
 * @param params0.expected_password_hash - Optional CAS on the current hash.
 * @param params0.changed_before - Optional CAS on `password_changed_at`.
 * @returns The updated user (new `session_epoch`, no hash), or `null` when a precondition failed.
 */
const updatePassword = async ({ user_id, password_hash, now, expected_password_hash, changed_before }: {
    user_id: ObjectIdLike;
    password_hash: string;
    now: Date;
    expected_password_hash?: string | null;
    changed_before?: Date | null;
}): Promise<UserDoc | null> => {
    if (!identityHelper.isObjectIdLike(user_id) || typeof password_hash !== 'string' || !password_hash) {
        return null;
    }
    const filter: Record<string, unknown> = { _id: user_id, status: USER_STATUSES.ACTIVE };
    if (expected_password_hash !== undefined && expected_password_hash !== null) {
        if (typeof expected_password_hash !== 'string' || !expected_password_hash) {
            return null;
        }
        filter.password_hash = expected_password_hash;
    }
    if (changed_before !== undefined && changed_before !== null) {
        if (!(changed_before instanceof Date) || Number.isNaN(changed_before.getTime())) {
            return null;
        }
        filter.$or = [{ password_changed_at: null }, { password_changed_at: { $lt: changed_before } }];
    }
    const doc = await UserModel.findOneAndUpdate(
        filter,
        {
            $set: { password_hash: password_hash, password_changed_at: now },
            $inc: { session_epoch: 1 }
        },
        { returnDocument: 'after' }
    ).lean<UserDoc | null>();
    return _sameUser(doc, user_id);
};

/**
 * Bumps `session_epoch` — "sign out everywhere" (admin, CLI) and "sign out my other sessions"
 * (self; the service then mints the caller a fresh session carrying the new epoch).
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user.
 * @param params0.expected_role - Optional: the role the management decision was evaluated against.
 * @returns The updated user (new `session_epoch`), or `null` when absent or the role changed.
 */
const bumpSessionEpoch = async ({ user_id, expected_role }: {
    user_id: ObjectIdLike;
    expected_role?: ExpectedRole | null;
}): Promise<UserDoc | null> => {
    if (!identityHelper.isObjectIdLike(user_id)) {
        return null;
    }
    const filter = _withExpectedRole({ _id: user_id }, expected_role);
    if (filter === null) {
        return null;
    }
    const doc = await UserModel.findOneAndUpdate(
        filter,
        { $inc: { session_epoch: 1 } },
        { returnDocument: 'after' }
    ).lean<UserDoc | null>();
    return _sameUser(doc, user_id);
};

/**
 * Bumps EVERY user's `session_epoch` (CLI `revoke-sessions --all`): every session in the install
 * is refused from the next request on.
 *
 * @returns How many users were updated.
 */
const bumpAllSessionEpochs = async (): Promise<number> => {
    const result = await UserModel.updateMany({}, { $inc: { session_epoch: 1 } });
    return result.modifiedCount || 0;
};

/**
 * Disables an ACTIVE user and bumps `session_epoch` in the same update (every session dies with the
 * status change). CAS on `status: 'active'`.
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user to disable.
 * @param params0.actor_user_id - Who disabled them (`null` for the CLI).
 * @param params0.now - Recorded as `disabled_at`.
 * @param params0.expected_role - Optional: the role the management decision was evaluated against.
 * @returns The updated user, or `null` when not active (or absent, or the role changed).
 */
const disableUser = async ({ user_id, actor_user_id, now, expected_role }: {
    user_id: ObjectIdLike;
    actor_user_id: ObjectIdLike | null;
    now: Date;
    expected_role?: ExpectedRole | null;
}): Promise<UserDoc | null> => {
    if (!identityHelper.isObjectIdLike(user_id)) {
        return null;
    }
    if (actor_user_id !== null && !identityHelper.isObjectIdLike(actor_user_id)) {
        return null;
    }
    const filter = _withExpectedRole({ _id: user_id, status: USER_STATUSES.ACTIVE }, expected_role);
    if (filter === null) {
        return null;
    }
    const doc = await UserModel.findOneAndUpdate(
        filter,
        {
            $set: { status: USER_STATUSES.DISABLED, disabled_at: now, disabled_by_user_id: actor_user_id },
            $inc: { session_epoch: 1 }
        },
        { returnDocument: 'after' }
    ).lean<UserDoc | null>();
    return _sameUser(doc, user_id);
};

/**
 * Re-enables a DISABLED user and bumps `session_epoch` (spec A4 — a session that somehow survived
 * the disable stays dead). CAS on `status: 'disabled'`.
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user to enable.
 * @param params0.expected_role - Optional: the role the management decision was evaluated against.
 * @returns The updated user, or `null` when not disabled (or absent, or the role changed).
 */
const enableUser = async ({ user_id, expected_role }: {
    user_id: ObjectIdLike;
    expected_role?: ExpectedRole | null;
}): Promise<UserDoc | null> => {
    if (!identityHelper.isObjectIdLike(user_id)) {
        return null;
    }
    const filter = _withExpectedRole({ _id: user_id, status: USER_STATUSES.DISABLED }, expected_role);
    if (filter === null) {
        return null;
    }
    const doc = await UserModel.findOneAndUpdate(
        filter,
        {
            $set: { status: USER_STATUSES.ACTIVE, disabled_at: null, disabled_by_user_id: null },
            $inc: { session_epoch: 1 }
        },
        { returnDocument: 'after' }
    ).lean<UserDoc | null>();
    return _sameUser(doc, user_id);
};

/**
 * Changes a user's stored role (any status — spec A16 allows it on disabled users). No epoch bump:
 * permissions are resolved per request, so the change applies from the next request anyway.
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user.
 * @param params0.role_key - One of `STORED_ROLE_KEYS` (the schema enum refuses anything else, including `owner`).
 * @param params0.custom_role_id - The custom role's id iff `role_key === 'custom'`, else `null`.
 * @param params0.expected_role - Optional: the role the management decision was evaluated against.
 * @returns The updated user, or `null` when absent or the role changed since it was read.
 */
const changeRole = async ({ user_id, role_key, custom_role_id, expected_role }: {
    user_id: ObjectIdLike;
    role_key: string;
    custom_role_id: ObjectIdLike | null;
    expected_role?: ExpectedRole | null;
}): Promise<UserDoc | null> => {
    if (!identityHelper.isObjectIdLike(user_id) || typeof role_key !== 'string') {
        return null;
    }
    if (custom_role_id !== null && !identityHelper.isObjectIdLike(custom_role_id)) {
        return null;
    }
    const filter = _withExpectedRole({ _id: user_id }, expected_role);
    if (filter === null) {
        return null;
    }
    const doc = await UserModel.findOneAndUpdate(
        filter,
        { $set: { role_key: role_key, custom_role_id: custom_role_id } },
        { returnDocument: 'after', runValidators: true }
    ).lean<UserDoc | null>();
    return _sameUser(doc, user_id);
};

/**
 * Changes a user's display name (already validated by `identity.helper#validateName`).
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user.
 * @param params0.name - The new name.
 * @returns The updated user, or `null` when absent.
 */
const updateName = async ({ user_id, name }: { user_id: ObjectIdLike; name: string }): Promise<UserDoc | null> => {
    if (!identityHelper.isObjectIdLike(user_id) || typeof name !== 'string') {
        return null;
    }
    const doc = await UserModel.findOneAndUpdate(
        { _id: user_id },
        { $set: { name: name } },
        { returnDocument: 'after' }
    ).lean<UserDoc | null>();
    return _sameUser(doc, user_id);
};

/**
 *  THE PASSWORD-RESET SEND THROTTLE — a compare-and-set on `reset_send_log` (spec A16). Used by
 * forgot-password and by the admin-triggered reset (429 when it refuses).
 *
 * The log is kept NEWEST FIRST (`$push … $sort: -1, $slice: keep`), which is what lets two
 * positional predicates in the filter decide both rules in the same update that records the send:
 *  - interval: `reset_send_log.0` (the newest send) is absent or at least `min_interval_ms` old;
 *  - window: `reset_send_log.<max-1>` is absent or older than the window start — i.e. fewer than
 *    `max_per_window` sends inside it.
 * Two concurrent requests are serialised by the server; the second sees the first's entry.
 *
 * Only an ACTIVE user gets a slot (a reset for a disabled account is never sent).
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user.
 * @param params0.throttle - `now`, the interval, the window cap and size, and how many entries to keep.
 * @returns The updated user when a slot was claimed; `null` when throttled, not active, or absent.
 */
const claimResetSendSlot = async ({ user_id, throttle }: { user_id: ObjectIdLike; throttle: SendSlotThrottle }): Promise<UserDoc | null> => {
    if (!identityHelper.isObjectIdLike(user_id)) {
        return null;
    }
    const { now, min_interval_ms, max_per_window, window_ms, keep } = throttle;
    if (!Number.isInteger(max_per_window) || max_per_window < 1 || !Number.isInteger(keep) || keep < max_per_window) {
        return null;
    }
    const intervalCutoff = new Date(now.getTime() - min_interval_ms);
    const windowStart = new Date(now.getTime() - window_ms);
    const newest = 'reset_send_log.0';
    const oldestCounted = `reset_send_log.${max_per_window - 1}`;

    const doc = await UserModel.findOneAndUpdate(
        {
            _id: user_id,
            status: USER_STATUSES.ACTIVE,
            $and: [
                { $or: [{ [newest]: { $exists: false } }, { [newest]: { $lte: intervalCutoff } }] },
                { $or: [{ [oldestCounted]: { $exists: false } }, { [oldestCounted]: { $lte: windowStart } }] }
            ]
        },
        { $push: { reset_send_log: { $each: [now], $sort: -1, $slice: keep } } },
        { returnDocument: 'after' }
    ).lean<UserDoc | null>();
    return _sameUser(doc, user_id);
};

export = {
    newUserId,
    findById,
    findByIdWithHash,
    findByEmail,
    findByEmailWithHash,
    findByIds,
    existsById,
    listUsers,
    listUsersByCustomRole,
    existsWithCustomRole,
    countUsers,
    countUsersByStatus,
    insertUser,
    deleteUnacceptedInviteUser,
    touchLastLogin,
    rehashPassword,
    updatePassword,
    bumpSessionEpoch,
    bumpAllSessionEpochs,
    disableUser,
    enableUser,
    changeRole,
    updateName,
    claimResetSendSlot
};
