import { Schema, model } from 'mongoose';

/**
 * LEGACY — an operator account from the single-operator build (v0.1). NEVER READ BY SIGN-IN.
 *
 * Sign-in, sessions and permissions now live in `gi_users` (see `./user.model`). This collection is
 * kept for provenance and for exactly two reads:
 *
 *  1. Setup restriction. While `SETUP_OWNER_EMAIL` is unset, the emails on these rows are the only
 *     addresses that may claim first-run setup — so upgrading an existing install does not hand
 *     the owner account to whoever reaches `/setup` first.
 *  2. Boot marking. `markLegacyOperators()` stamps `legacy_at` on every row at boot, so an operator
 *     reading the collection can see that the row no longer grants anything.
 *
 * Nothing here is migrated into `gi_users`: the v0.1 password was chosen under a weaker policy, and
 * the new owner proves control of the mailbox before choosing a new one. The rows are not deleted
 * either, so rolling back to v0.1 (which ignores `legacy_at`) still finds its operator.
 *
 * NO PASSWORD-HASHING HOOK, ON PURPOSE (kept from v0.1 and still true of every auth schema here):
 * Mongoose 9 pre-hooks take no `next` callback, and the callback-style variant that "works"
 * persists the PLAINTEXT when the hook returns before its callback fires. Hashing is an explicit
 * call in the auth service, which is the only writer of any `password_hash`.
 */

const _modelName = 'gi_admin_user';
const _collectionName = 'gi_admin_users';

const adminUserSchema = new Schema(
    {
        /**
         * The v0.1 login identity, stored lowercased and trimmed. Read now only as the setup
         * allow-list (header, point 1), which compares it against an already-normalised address.
         */
        email: {
            type: String,
            required: true,
            trim: true,
            lowercase: true
        },
        /**
         * The v0.1 bcrypt hash. Nothing in the current build reads or writes it; it stays so a
         * rollback to v0.1 can still sign its operator in.
         *
         * ⚠️ `select: false`, so it is absent from every ordinary read and cannot leak through the
         * legacy listing. No current code path asks for `+password_hash` on this model, and none
         * should.
         */
        password_hash: {
            type: String,
            required: true,
            select: false
        },
        /** Last v0.1 login. Frozen at its last value: the current build never signs in against this row. */
        last_login_at: {
            type: Date,
            default: null
        },
        /**
         * When boot marked this row as legacy. `null` on a row the current build has not seen yet.
         *
         * ⚠️ DECLARED BECAUSE `markLegacyOperators()` FILTERS ON IT. `strictQuery: true` (core/db.ts)
         * strips an undeclared filter path, so `updateMany({ legacy_at: null }, …)` against a schema
         * without this field would run as `updateMany({}, …)`. That would still happen to be
         * idempotent here, but the same stripping turns a lookup into "match the first document",
         * so every filtered path on every auth schema is declared.
         */
        legacy_at: {
            type: Date,
            default: null
        }
    },
    {
        // Creation time is `createdAt` from here, NOT a hand-declared `created_at`.
        //
        // The two would be one character apart and mean nearly the same thing, which is how a sort
        // silently orders by the wrong field. The mirrored-name exception applies only to schemas
        // that carry an external system's own field names — `gi_partner_app_transactions.created_at`
        // is Shopify's settlement timestamp and has to keep Shopify's spelling. Nothing here mirrors
        // anything, so there is one creation timestamp with one name.
        timestamps: true
    }
);

// Kept from v0.1 (the index already exists on upgraded installs). NAMED deliberately: an unnamed
// unique resolves to the default `email_1`, and a second declaration resolving to that default with
// different options makes Mongo build the first and REJECT the second — the gate silently unbuilt
// while the schema still claims it. Every auth index in this folder is named for the same reason.
adminUserSchema.index({ email: 1 }, { unique: true, name: 'uniq_admin_user_email' });

const AdminUser = model(_modelName, adminUserSchema, _collectionName);

export = { AdminUser };
