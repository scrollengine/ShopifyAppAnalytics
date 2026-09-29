'use strict';

/**
 * The legacy operator accounts (`gi_admin_users`) from the single-operator build.
 *
 * NEVER READ BY SIGN-IN. The rows are read for exactly two things: the setup allow-list (while
 * `SETUP_OWNER_EMAIL` is unset, only these addresses may claim setup — spec §0.2 / A7) and the boot
 * marking (`legacy_at`). No function here returns or selects `password_hash`, and none should.
 */

import models = require('../../shared/repositories/models.repository');

import type { AdminUserDoc } from '../../shared/types/entity.types';

const { AdminUserModel } = models;

/**
 * Stamps `legacy_at` on every row that does not carry it yet. Idempotent: a second run matches
 * nothing.
 *
 * ⚠️ `{ legacy_at: null }` matches a missing field as well as an explicit null, which is what makes
 * this cover rows written by v0.1 (whose schema had no such field). The path is declared on the
 * schema — under `strictQuery: true` an undeclared filter path is stripped to `{}`.
 *
 * @param params0 - The parameters object.
 * @param params0.now - The instant to record.
 * @returns How many rows were marked by this call.
 */
const markAllLegacy = async ({ now }: { now: Date }): Promise<number> => {
    const result = await AdminUserModel.updateMany(
        { legacy_at: null },
        { $set: { legacy_at: now } }
    );
    return result.modifiedCount || 0;
};

/**
 * Every legacy operator email, REGARDLESS of `legacy_at` (spec A7) — the setup allow-list when no
 * `SETUP_OWNER_EMAIL` is pinned. Lowercased, trimmed and deduplicated here as well as on write, so a
 * row written by an older build with odd casing still compares equal.
 *
 * @returns The addresses, sorted. Empty when the collection is empty.
 */
const listLegacyEmails = async (): Promise<string[]> => {
    const rows = await AdminUserModel.find({})
        .select({ email: 1 })
        .lean<Array<Pick<AdminUserDoc, 'email'>>>();

    const emails = new Set<string>();
    for (const row of rows) {
        if (typeof row.email === 'string') {
            const normalised = row.email.trim().toLowerCase();
            if (normalised) {
                emails.add(normalised);
            }
        }
    }
    return Array.from(emails).sort();
};

/**
 * Counts every legacy row, marked or not.
 *
 * @returns The row count.
 */
const countLegacy = async (): Promise<number> => {
    return AdminUserModel.countDocuments({}).exec();
};

export = {
    markAllLegacy,
    listLegacyEmails,
    countLegacy
};
