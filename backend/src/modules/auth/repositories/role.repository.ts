'use strict';

/**
 * Every read and write on `gi_roles` — CUSTOM roles only. Built-in roles live in code
 * (`constants/roles.constants`) and are never stored.
 *
 * What a stored role GRANTS is decided by `role.helper#resolveStoredRole`, which drops unknown,
 * owner-only and prerequisite-less keys. This file returns the rows as stored; it never interprets
 * `permissions`.
 */

import models = require('../../shared/repositories/models.repository');
import identityHelper = require('../helpers/identity.helper');

import type { ObjectIdLike, RoleDoc } from '../../shared/types/entity.types';
import type { NewRoleFields, RoleUpdateFields } from '../types/auth.types';

const { RoleModel } = models;

/**
 * Reads a custom role by id.
 *
 * @param role_id - The `gi_roles._id`.
 * @returns The role, or `null` (also for a malformed id).
 */
const findById = async (role_id: ObjectIdLike): Promise<RoleDoc | null> => {
    if (!identityHelper.isObjectIdLike(role_id)) {
        return null;
    }
    const doc = await RoleModel.findById(role_id).lean<RoleDoc | null>();
    // Belt and braces (spec I8): the row that came back is the row that was asked for.
    if (!doc || String(doc._id) !== String(role_id)) {
        return null;
    }
    return doc;
};

/**
 * Reads several custom roles by id (labels for the invitations and users lists). Malformed ids are
 * skipped.
 *
 * @param role_ids - The ids.
 * @returns The roles found, in no particular order.
 */
const findByIds = async (role_ids: readonly ObjectIdLike[]): Promise<RoleDoc[]> => {
    const ids = Array.isArray(role_ids) ? role_ids.filter((id) => identityHelper.isObjectIdLike(id)) : [];
    if (ids.length === 0) {
        return [];
    }
    return RoleModel.find({ _id: { $in: ids } }).lean<RoleDoc[]>();
};

/**
 * Every custom role, by normalised name.
 *
 * @returns The roles. Empty is the normal state of a fresh install.
 */
const listRoles = async (): Promise<RoleDoc[]> => {
    return RoleModel.find({}).sort({ name_norm: 1, _id: 1 }).lean<RoleDoc[]>();
};

/**
 * Inserts a custom role (already validated by `role.helper#validateCustomRole`).
 *
 * THROWS E11000 with keyPattern `{ name_norm: 1 }` when the name is taken — the unique index is the
 * race-free gate, and the service maps it to ROLE_NAME_TAKEN.
 *
 * @param fields - The validated role and its creator.
 * @returns The inserted role.
 */
const insertRole = async (fields: NewRoleFields): Promise<RoleDoc> => {
    const created = await RoleModel.create({
        name: fields.name,
        name_norm: fields.name_norm,
        description: fields.description,
        permissions: fields.permissions,
        created_by_user_id: fields.created_by_user_id,
        updated_by_user_id: fields.created_by_user_id
    });
    const plain: RoleDoc = created.toObject();
    return plain;
};

/**
 * Replaces a custom role's name, description and permissions (already validated).
 *
 * THROWS E11000 with keyPattern `{ name_norm: 1 }` when renamed onto a taken name.
 *
 * @param fields - The role id and its new validated content.
 * @returns The updated role, or `null` when it no longer exists.
 */
const updateRole = async (fields: RoleUpdateFields): Promise<RoleDoc | null> => {
    if (!identityHelper.isObjectIdLike(fields.role_id)) {
        return null;
    }
    const doc = await RoleModel.findOneAndUpdate(
        { _id: fields.role_id },
        {
            $set: {
                name: fields.name,
                name_norm: fields.name_norm,
                description: fields.description,
                permissions: fields.permissions,
                updated_by_user_id: fields.updated_by_user_id
            }
        },
        { returnDocument: 'after' }
    ).lean<RoleDoc | null>();
    if (!doc || String(doc._id) !== String(fields.role_id)) {
        return null;
    }
    return doc;
};

/**
 * Deletes a custom role. The service checks ROLE_IN_USE first; a user or invite that races in and
 * references the deleted role resolves to NO permissions (`resolveStoredRole` treats a missing
 * custom role as "deny everything"), so the race fails narrow.
 *
 * @param params0 - The parameters object.
 * @param params0.role_id - The role to delete.
 * @returns The deleted role (for the audit snapshot), or `null` when it did not exist.
 */
const deleteRole = async ({ role_id }: { role_id: ObjectIdLike }): Promise<RoleDoc | null> => {
    if (!identityHelper.isObjectIdLike(role_id)) {
        return null;
    }
    const doc = await RoleModel.findOneAndDelete({ _id: role_id }).lean<RoleDoc | null>();
    if (!doc || String(doc._id) !== String(role_id)) {
        return null;
    }
    return doc;
};

export = {
    findById,
    findByIds,
    listRoles,
    insertRole,
    updateRole,
    deleteRole
};
