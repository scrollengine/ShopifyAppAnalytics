'use strict';

/**
 * THE derivation of "who is this and what may they do" (spec §6, invariant I5).
 *
 * Nothing else in the codebase turns a user row into permissions. The guard, every admin service
 * (which re-loads the ACTOR from the database rather than trusting a principal handed in), the users
 * list and the account endpoint all call `resolvePrincipal` — recurring failure mode #1 is two
 * spellings of one derivation, and this one decides access.
 *
 * PURE: the reads (session → user → install → custom role) happen in
 * `principal.service#loadPrincipal`; this file only combines what was read.
 */

import authConstants = require('../constants/auth.constants');
import permissionsConstants = require('../constants/permissions.constants');
import rolesConstants = require('../constants/roles.constants');
import roleHelper = require('./role.helper');

import type { ObjectIdLike } from '../../shared/types/entity.types';
import type {
    Principal,
    PrincipalInstallInput,
    ResolvePrincipalInput,
    RoleAnomalies
} from '../types/auth.types';

const { ROLE_KEYS } = authConstants;
const { ALL_PERMISSION_KEYS } = permissionsConstants;
const { BUILT_IN_ROLES } = rolesConstants;

/** The owner's permission list: every catalogue key, sorted and frozen once. */
const OWNER_PERMISSIONS: readonly string[] = Object.freeze(Array.from(new Set(ALL_PERMISSION_KEYS)).sort());

/**
 * Whether a user id is the install's owner. The pointer is the only definition of ownership; a
 * missing install document or a null pointer means NOBODY is the owner (fails narrow, spec A9).
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The user's id.
 * @param params0.install - The install document, or `null` when it could not be found.
 * @returns True only when the pointer is set and equals the id.
 */
const isOwnerUserId = ({ user_id, install }: { user_id: ObjectIdLike | null | undefined; install: PrincipalInstallInput | null }): boolean => {
    if (user_id === null || user_id === undefined || install === null || install === undefined) {
        return false;
    }
    const pointer = install.owner_user_id;
    if (pointer === null || pointer === undefined) {
        return false;
    }
    const id = String(user_id);
    return id.length > 0 && id === String(pointer);
};

/**
 * Resolves the principal AND reports what was wrong with the stored role, so the service can log it
 * (this file does no I/O, so it cannot log). The principal is already narrowed either way.
 *
 * @param input - What the service read.
 * @param input.user - The `gi_users` row.
 * @param input.install - The install document, or `null` when absent.
 * @param input.custom_role - The `gi_roles` row for `user.custom_role_id`, or `null`.
 * @returns `{ principal, anomalies }`.
 */
const resolvePrincipalWithAnomalies = ({ user, install, custom_role }: ResolvePrincipalInput): { principal: Principal; anomalies: RoleAnomalies } => {
    const isOwner = isOwnerUserId({ user_id: user._id, install: install });

    if (isOwner) {
        const principal: Principal = Object.freeze({
            user_id: String(user._id),
            email: user.email,
            name: user.name,
            is_owner: true,
            role_key: ROLE_KEYS.OWNER,
            role_label: BUILT_IN_ROLES.owner.label,
            custom_role_id: null,
            permissions: OWNER_PERMISSIONS
        });
        return {
            principal: principal,
            anomalies: { unknown_role_key: null, missing_custom_role: false, dropped_permissions: [] }
        };
    }

    const role = roleHelper.resolveStoredRole({
        role_key: user.role_key,
        custom_role_id: user.custom_role_id,
        custom_role: custom_role
    });

    const principal: Principal = Object.freeze({
        user_id: String(user._id),
        email: user.email,
        name: user.name,
        is_owner: false,
        role_key: role.role_key,
        role_label: role.role_label,
        custom_role_id: role.custom_role_id,
        permissions: role.permissions
    });
    return { principal: principal, anomalies: role.anomalies };
};

/**
 * Resolves a principal (spec §6):
 *  - owner (by the install pointer) ⇒ `role_key: 'owner'`, every catalogue key;
 *  - built-in stored role ⇒ its set;
 *  - `custom` ⇒ the role's keys ∩ catalogue, minus owner-only keys and keys with unmet
 *    prerequisites; a missing custom role ⇒ `permissions: []` — never widened.
 *
 * @param input - What the service read (user, install or null, custom role or null).
 * @returns The frozen principal; `permissions` is sorted and frozen.
 */
const resolvePrincipal = (input: ResolvePrincipalInput): Principal => {
    return resolvePrincipalWithAnomalies(input).principal;
};

export = {
    isOwnerUserId,
    resolvePrincipal,
    resolvePrincipalWithAnomalies
};
