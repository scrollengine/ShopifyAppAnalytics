'use strict';

import { Schema, model } from 'mongoose';

/**
 * Install-wide state: whether first-run setup has completed, and who the owner is.
 *
 * ONE DOCUMENT, `_id: 'install'` (`INSTALL_STATE_ID`). Boot upserts it with `$setOnInsert`, so it
 * exists before any request can read it.
 *
 *  THE SETUP LOCK IS A PERSISTED FLAG, NEVER A USER COUNT. `setup_completed_at` is set exactly
 * once, by a compare-and-set whose filter names `setup_completed_at: null`; two concurrent setup
 * completions produce one match and one miss. Deriving "setup is open" from "gi_users is empty"
 * instead would reopen setup — to anyone — the moment that collection was emptied by a restore, a
 * bad migration or a `deleteMany`.
 *
 *  OWNERSHIP IS THE POINTER `owner_user_id`. No user row carries an owner flag, so there is one
 * place to read and one place to move (the CLI `transfer-owner`, by CAS on this pointer).
 *
 * `setup_token_id` records which SETUP_VERIFY token completed setup, so the boot roll-forward can
 * find the claimed name + password hash if the process died between the lock and the owner insert.
 */

const _modelName = 'gi_system_state';
const _collectionName = 'gi_system_states';

const systemStateSchema = new Schema(
    {
        /** Always `'install'`. A String `_id`, so the one document has a readable, fixed key. */
        _id: {
            type: String
        },
        /** `null` while setup is open. Set once, by CAS; never cleared by application code. */
        setup_completed_at: {
            type: Date,
            default: null
        },
        /**
         * The owner's `gi_users._id`. `null` before setup, and on an install created LOCKED because
         * gi_users already had rows (the CLI `transfer-owner` / `repair-owner` then sets it).
         */
        owner_user_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_user',
            default: null
        },
        /** The `gi_auth_tokens._id` whose claim completed setup. Read only by the boot roll-forward. */
        setup_token_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_auth_token',
            default: null
        }
    },
    {
        timestamps: true
    }
);

// No secondary index: every read and write addresses the single document by `_id`.

const SystemState = model(_modelName, systemStateSchema, _collectionName);

export = { SystemState };
