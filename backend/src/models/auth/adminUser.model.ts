import { Schema, model } from 'mongoose';

/**
 * An operator who may log in to this deployment.
 *
 * There is no self-registration and no tenancy: this is a self-hosted tool, and everyone with a row
 * here sees the same single app's analytics. Accounts are created by whoever runs the deployment.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  NO PASSWORD-HASHING HOOK ON THIS SCHEMA, ON PURPOSE.
 *
 * The conventional place to hash is a `pre('save')` hook, and it is a trap here twice over:
 *
 *  1. Mongoose 9 pre-hooks take NO `next` callback — they receive the hook's own arguments, so a
 *     hook written `function (next) {…}` binds `next` to the options object and `next()` throws
 *     `next is not a function`. Worse is the callback-style variant that "works": a hook calling a
 *     library's callback API completes the moment it RETURNS, before the callback fires, so the
 *     save proceeds with the field untouched and the PLAINTEXT password is persisted. This is a
 *     well-known Mongoose footgun and not a hypothetical one — it is the reason hashing is an
 *     explicit call here rather than a hook.
 *  2. Even written correctly, a hook makes hashing invisible and conditional — it has to sniff
 *     `isModified` to avoid double-hashing an already-hashed value on an unrelated update.
 *
 * So hashing lives in the auth SERVICE, which is the only writer of `password_hash`: it hashes,
 * then writes an already-hashed value. The model stores a hash and knows nothing about passwords.
 * This whole class of bug is avoided rather than navigated.
 *
 * The field name says `password_hash` rather than `password` for the same reason — a plaintext
 * value assigned here reads as obviously wrong at every call site.
 */

const _modelName = 'gi_admin_user';
const _collectionName = 'gi_admin_users';

const adminUserSchema = new Schema(
    {
        /**
         * Login identity. Lowercased and trimmed on write so `Alice@x.com` and `alice@x.com ` are
         * one account rather than two — the uniqueness gate below is only as good as the
         * normalisation in front of it, since Mongo's default collation is case-SENSITIVE.
         *
         * ⚠️ Lookups must normalise the same way (`String(email).trim().toLowerCase()`) before
         * querying. Mongoose's `lowercase` applies to writes and to query CASTING on this path, but
         * relying on that silently stops working the moment a lookup goes through an aggregate,
         * which does not cast.
         */
        email: {
            type: String,
            required: true,
            trim: true,
            lowercase: true
        },
        /**
         * The password hash. Written ONLY by the auth service — see the header note.
         *
         * ⚠️ `select: false`, so it is absent from every ordinary read and cannot be leaked by an
         * endpoint that returns a user object it did not shape. The login path — the one place that
         * needs it — must ask for it explicitly:
         *
         *     AdminUser.findOne({ email }).select('+password_hash')
         *
         * Without that, `password_hash` is `undefined` and every password comparison fails. That
         * failure is loud and immediate (nobody can log in, on the first attempt, in development),
         * which is the right direction for this particular field to fail in.
         */
        password_hash: {
            type: String,
            required: true,
            select: false
        },
        /**
         * Last successful login. `null` means the account has been created but never used — which
         * is a real and useful distinction from "logged in long ago", so it is not defaulted to the
         * creation time.
         */
        last_login_at: {
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

// The login lookup, and the gate that stops two accounts for one address. NAMED deliberately: an
// unnamed unique resolves to the default `email_1`, and if any future declaration on this schema
// ever resolves to that same default with different options, Mongo builds the first and REJECTS the
// second — leaving the uniqueness gate SILENTLY UNBUILT while the schema still claims it.
adminUserSchema.index({ email: 1 }, { unique: true, name: 'uniq_admin_user_email' });

const AdminUser = model(_modelName, adminUserSchema, _collectionName);

export = { AdminUser };
