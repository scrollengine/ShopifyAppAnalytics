'use strict';

/**
 * Every database read and write the auth module performs. Nothing else in `modules/auth/` touches a
 * model, and the service does not know that mongoose exists.
 *
 * ── The `select: false` contract ────────────────────────────────────────────────────────────────
 * `password_hash` is `select: false` on the schema, so an ordinary find does NOT return it. That is
 * deliberate and it is why there are two lookups here rather than one with a flag:
 *
 *   `findAdminByEmail`         — no hash. Every caller except login.
 *   `findAdminByEmailWithHash` — asks for the hash explicitly. ONE caller: the password comparison.
 *
 * A single function taking `{ include_hash: true }` would read identically at both call sites and
 * put the decision in a boolean that is easy to pass by accident; two names put it in the function
 * you chose to call. The hash is then structurally unreachable from anywhere that has not said the
 * word "hash" out loud.
 *
 * ⚠️ Lookups normalise the email themselves. Mongoose's `lowercase: true` casts a query on this path
 * as well as a write, so `{ email: 'A@B.com' }` would in fact match today — but that guarantee
 * evaporates the moment a lookup goes through an aggregate, which does not cast at all. Normalising
 * here means the module never depends on which query form it happens to be using.
 */

import models = require('../../shared/repositories/models.repository');
import type { AdminUserDoc } from '../../shared/types/entity.types';

/**
 * Normalises an email into the form the collection is keyed by: trimmed and lowercased.
 *
 * Mongo's default collation is case-SENSITIVE, so `Alice@x.com` and `alice@x.com` are two distinct
 * values as far as the unique index is concerned. The schema lowercases on write; this is the same
 * rule applied on read, so the two halves cannot disagree.
 *
 * @param email - Anything the caller received as an email. Not trusted to be a string.
 * @returns The normalised email, or '' when there was nothing usable.
 */
const normaliseEmail = (email: unknown): string => {
    if (typeof email !== 'string') {
        return '';
    }
    return email.trim().toLowerCase();
};

/**
 * Finds an operator by email, WITHOUT the password hash.
 *
 * @param params0 - The parameters object.
 * @param params0.email - The email to look up. Normalised here; the caller need not.
 * @returns The operator document, or null when no account has that email.
 */
const findAdminByEmail = async ({ email }: { email: string }): Promise<AdminUserDoc | null> => {
    const normalised = normaliseEmail(email);
    if (!normalised) {
        return null;
    }
    return models.AdminUserModel.findOne({ email: normalised }).lean<AdminUserDoc | null>().exec();
};

/**
 * Finds an operator by email WITH the password hash attached.
 *
 *  The only function in the codebase that produces a document carrying `password_hash`. Its result
 * must never be returned to a caller outside this module, spread into a response, or logged. The one
 * legitimate use is handing the hash to `bcrypt.compare`.
 *
 * @param params0 - The parameters object.
 * @param params0.email - The email to look up. Normalised here.
 * @returns The operator document including `password_hash`, or null.
 */
const findAdminByEmailWithHash = async ({ email }: { email: string }): Promise<AdminUserDoc | null> => {
    const normalised = normaliseEmail(email);
    if (!normalised) {
        return null;
    }
    return models.AdminUserModel.findOne({ email: normalised }).select('+password_hash').lean<AdminUserDoc | null>().exec();
};

/**
 * Inserts an operator.
 *
 * ⚠️ `password_hash` must ALREADY be a bcrypt hash. This function does no hashing and has no way to
 * tell a hash from a password — hashing belongs to the service, which is the only writer of this
 * field, and the parameter is named for what it must contain so a plaintext value reads as wrong at
 * the call site.
 *
 * Can reject with a duplicate-key error (code 11000) when two processes seed at once. That is a
 * benign race and the caller is expected to treat it as "already present", not as a failure.
 *
 * @param params0 - The parameters object.
 * @param params0.email - Login email. Normalised here.
 * @param params0.password_hash - The bcrypt hash. NEVER a plaintext password.
 * @returns The inserted document.
 */
const createAdminUser = async ({ email, password_hash }: { email: string; password_hash: string }): Promise<AdminUserDoc> => {
    const created = await models.AdminUserModel.create({
        email: normaliseEmail(email),
        password_hash: password_hash,
        last_login_at: null
    });
    return created.toObject();
};

/**
 * Stamps a successful login.
 *
 * Best-effort by contract: the caller must not fail a login because this write failed. Losing a
 * `last_login_at` costs an audit detail; refusing the session over it costs the operator their
 * dashboard.
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The operator's `_id`.
 * @param params0.now - The timestamp to record. Passed in rather than read here, so a test can pin it.
 * @returns Resolves once the update has been issued.
 */
const touchLastLogin = async ({ user_id, now }: { user_id: string; now: Date }): Promise<void> => {
    await models.AdminUserModel.updateOne({ _id: models.toObjectId(user_id) }, { $set: { last_login_at: now } }).exec();
};

/**
 * Counts operator accounts. Used by the boot sequence to report whether this is a fresh install.
 *
 * @returns How many operators exist.
 */
const countAdminUsers = async (): Promise<number> => {
    return models.AdminUserModel.countDocuments({}).exec();
};

export = {
    normaliseEmail,
    findAdminByEmail,
    findAdminByEmailWithHash,
    createAdminUser,
    touchLastLogin,
    countAdminUsers
};
