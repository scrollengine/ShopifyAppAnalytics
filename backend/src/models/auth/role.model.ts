'use strict';

import { Schema, model } from 'mongoose';

/**
 * A CUSTOM role created by the owner. Built-in roles (owner/admin/analyst/viewer) live in code
 * (`modules/auth/constants/roles.constants`), so an empty collection is the normal state.
 *
 * `permissions` holds catalogue keys as written by `role.helper#validateCustomRole`. A key read back
 * that the running build does not know (renamed, removed, or hand-edited in) is DROPPED by
 * `resolvePrincipal` and logged — never honoured — so a stale row can only narrow access.
 */

const _modelName = 'gi_role';
const _collectionName = 'gi_roles';

const roleSchema = new Schema(
    {
        /** Display name as the owner typed it (trimmed). */
        name: {
            type: String,
            required: true,
            trim: true
        },
        /**
         * The uniqueness key: the name NFC-normalised, trimmed and lowercased, so `Support` and
         * `support ` are one role. Written only from `identity.helper#validateRoleName`.
         */
        name_norm: {
            type: String,
            required: true
        },
        /** Shown in the role editor. At most 280 characters, enforced by the validator before any write. */
        description: {
            type: String,
            default: ''
        },
        /** Catalogue keys, deduplicated and sorted by the validator. */
        permissions: {
            type: [String],
            default: []
        },
        created_by_user_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_user',
            default: null
        },
        updated_by_user_id: {
            type: Schema.Types.ObjectId,
            ref: 'gi_user',
            default: null
        }
    },
    {
        timestamps: true
    }
);

// Create/rename rely on the E11000 from this index (keyPattern `{ name_norm: 1 }`) as their
// ROLE_NAME_TAKEN signal, so boot builds it explicitly before the first write.
roleSchema.index({ name_norm: 1 }, { unique: true, name: 'uniq_role_name_norm' });

const Role = model(_modelName, roleSchema, _collectionName);

export = { Role };
