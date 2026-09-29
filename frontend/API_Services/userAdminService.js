import AxiosClientProvider from './apiClient';

/**
 * =============================================================================
 *  Users & roles administration: members, invitations, roles and the audit log.
 * =============================================================================
 *
 *      GET    /api/users                               listUsers           users:read
 *      PATCH  /api/users/:user_id/role                 changeUserRole      users:manage
 *      POST   /api/users/:user_id/disable              disableUser         users:manage
 *      POST   /api/users/:user_id/enable               enableUser          users:manage
 *      POST   /api/users/:user_id/sessions/revoke      revokeUserSessions  users:manage
 *      POST   /api/users/:user_id/password-reset       sendPasswordReset   users:manage
 *      GET    /api/invites                             listInvites         users:read
 *      POST   /api/invites                             createInvite        users:manage
 *      POST   /api/invites/:invite_id/resend           resendInvite        users:manage
 *      POST   /api/invites/:invite_id/revoke           revokeInvite        users:manage
 *      GET    /api/roles                               listRoles           users:read
 *      POST   /api/roles                               createRole          roles:manage
 *      PATCH  /api/roles/:role_id                      updateRole          roles:manage
 *      DELETE /api/roles/:role_id                      deleteRole          roles:manage
 *      GET    /api/audit-events?limit&before           listAuditEvents     audit:read
 *
 *  Every method resolves and none rejects. A refusal is a normal answer on this
 *  screen (409 ALREADY_A_MEMBER, 409 ROLE_IN_USE, 429 on a resend inside the
 *  throttle window, 403 when the management rule says no), so each path
 *  resolves one shape:
 *
 *      { status, msg, data, error, http_status }
 *
 *  `http_status` is 0 when nothing answered. `error.code` is the server's
 *  business code and is what the tabs branch on, never `msg`, which is prose.
 *
 *  ⚠️ `data` IS `{}` ON EVERY FAILURE. It is not an empty result and must not be
 *  read as one: check `status` first. A members table drawn from `data.items`
 *  after a 500 would publish "no members" as a measured fact.
 *
 *  A 401 has already been handled by the axios interceptor (token cleared,
 *  redirect under way) by the time the result arrives here; it still resolves
 *  so a page mid-navigation does not throw.
 * =============================================================================
 */

/** Shown when the request never reached the API, or the answer could not be read. */
const NETWORK_FAILURE_MESSAGE = 'Could not reach the server. Check that the backend is running and try again.';

/** Last-resort text when the API answers a failure with no message of its own. */
const GENERIC_FAILURE_MESSAGE = 'The request failed and the server gave no reason. Check the server logs.';

/**
 * Reduces an axios response (or an axios error's response) to the one shape every method resolves.
 *
 * A 2xx whose body is not `status: true` is a failure: a half-formed answer must not render as a
 * success that then reads `data.items` off nothing.
 *
 * @param {Object} response - The axios response object.
 * @param {Boolean} fromError - True when it came from the rejection path; forces `status: false`.
 * @returns {{status: Boolean, msg: String, data: Object, error: Object, http_status: Number}} The result.
 */
const _toResult = (response, fromError) => {
    let body = {};
    if (response && response.data && typeof response.data === 'object') {
        body = response.data;
    }
    const ok = !fromError && body.status === true;

    let msg = typeof body.msg === 'string' ? body.msg : '';
    if (!ok && !msg) {
        msg = GENERIC_FAILURE_MESSAGE;
    }

    let data = {};
    if (ok && body.data && typeof body.data === 'object') {
        data = body.data;
    }

    let error = {};
    if (body.error && typeof body.error === 'object') {
        error = body.error;
    }

    let httpStatus = 0;
    if (response && typeof response.status === 'number') {
        httpStatus = response.status;
    }

    return { status: ok, msg: msg, data: data, error: error, http_status: httpStatus };
};

/**
 * Runs one request and resolves the result shape, whatever happens.
 *
 * @param {Promise} request - The axios promise.
 * @param {String} label - Method name, for the console line on a transport failure.
 * @returns {Promise<Object>} Always resolves `{ status, msg, data, error, http_status }`.
 */
const _settle = (request, label) => request
    .then((response) => _toResult(response, false))
    .catch((err) => {
        if (err && err.response) {
            return _toResult(err.response, true);
        }
        // No response at all: connection refused, DNS, the proxy target down.
        // The error CLASS only, never `err`: an axios error carries `config.data` (for
        // changePassword, both plaintext passwords) and `config.headers.Authorization`.
        console.log(`userAdmin.${label} transport error`, (err && (err.code || err.message)) || 'unknown');
        return { status: false, msg: NETWORK_FAILURE_MESSAGE, data: {}, error: {}, http_status: 0 };
    });

/**
 * URL-safe path segment for an id. Encoding keeps a malformed id from breaking the URL; validating
 * it is the server's job (a non-24-hex id answers 404 there).
 *
 * @param {String} id - A user, invite or role id.
 * @returns {String} The encoded segment.
 */
const _seg = (id) => encodeURIComponent(String(id === undefined || id === null ? '' : id));

/**
 * The role half of a role-change or invite body.
 *
 * ⚠️ `custom_role_id` IS SENT ONLY FOR `role_key: 'custom'`. The server answers 400 when it is
 * present with a built-in role, so a form that always posted the field (even as null) would fail
 * every built-in assignment.
 *
 * @param {Object} role - `{ role_key, custom_role_id? }`.
 * @returns {Object} `{ role_key }` or `{ role_key, custom_role_id }`.
 */
const _roleBody = (role) => {
    const source = role || {};
    const body = { role_key: source.role_key };
    if (source.role_key === 'custom') {
        body.custom_role_id = source.custom_role_id;
    }
    return body;
};

class UserAdminApiService {
    constructor() {
        this.apiClient = new AxiosClientProvider().getClient();
    }

    /**
     * Lists every user, with `can_manage` and `manage_block_reason` computed for the caller.
     *
     * @returns {Promise<Object>} Resolves `data: { items: UserView[], mail }`.
     */
    listUsers() {
        return _settle(this.apiClient.get('users'), 'listUsers');
    }

    /**
     * Changes a user's role. Allowed on disabled users.
     *
     * @param {String} user_id - The target user.
     * @param {Object} role - `{ role_key, custom_role_id? }`; `custom_role_id` only for 'custom'.
     * @returns {Promise<Object>} Resolves `data: { user, invites_revoked? }`.
     */
    changeUserRole(user_id, role) {
        return _settle(this.apiClient.patch(`users/${_seg(user_id)}/role`, _roleBody(role)), 'changeUserRole');
    }

    /**
     * Disables a user: signs them out everywhere and revokes the invitations they sent.
     *
     * @param {String} user_id - The target user.
     * @returns {Promise<Object>} Resolves the envelope.
     */
    disableUser(user_id) {
        return _settle(this.apiClient.post(`users/${_seg(user_id)}/disable`, {}), 'disableUser');
    }

    /**
     * Re-enables a disabled user. Their existing password works again.
     *
     * @param {String} user_id - The target user.
     * @returns {Promise<Object>} Resolves the envelope.
     */
    enableUser(user_id) {
        return _settle(this.apiClient.post(`users/${_seg(user_id)}/enable`, {}), 'enableUser');
    }

    /**
     * Ends every session the user holds.
     *
     * @param {String} user_id - The target user.
     * @returns {Promise<Object>} Resolves `data: { revoked }`.
     */
    revokeUserSessions(user_id) {
        return _settle(this.apiClient.post(`users/${_seg(user_id)}/sessions/revoke`, {}), 'revokeUserSessions');
    }

    /**
     * Emails the user a password-reset link. The admin never sees or sets the password.
     *
     * @param {String} user_id - The target user.
     * @returns {Promise<Object>} Resolves `data: { email_sent, email_status? }`; 429 when throttled.
     */
    sendPasswordReset(user_id) {
        return _settle(this.apiClient.post(`users/${_seg(user_id)}/password-reset`, {}), 'sendPasswordReset');
    }

    /**
     * Lists invitations, newest first, each with a server-computed `state`.
     *
     * @returns {Promise<Object>} Resolves `data: { items: InviteView[], mail }`.
     */
    listInvites() {
        return _settle(this.apiClient.get('invites'), 'listInvites');
    }

    /**
     * Creates an invitation and sends its email synchronously.
     *
     * @param {Object} params - `{ email, role_key, custom_role_id? }`.
     * @returns {Promise<Object>} Resolves 201 `data: { invite, email_sent, email_status?,
     * link_host_is_loopback }`; 409 ALREADY_A_MEMBER carries `error: { code, user_id, status }`.
     */
    createInvite(params) {
        const source = params || {};
        const body = Object.assign({ email: source.email }, _roleBody(source));
        return _settle(this.apiClient.post('invites', body), 'createInvite');
    }

    /**
     * Re-sends an invitation with a fresh link and expiry.
     *
     * @param {String} invite_id - The invitation.
     * @returns {Promise<Object>} Resolves `data: { invite, email_sent, email_status?,
     * link_host_is_loopback }`; 429 inside the throttle window.
     */
    resendInvite(invite_id) {
        return _settle(this.apiClient.post(`invites/${_seg(invite_id)}/resend`, {}), 'resendInvite');
    }

    /**
     * Revokes a pending invitation.
     *
     * @param {String} invite_id - The invitation.
     * @returns {Promise<Object>} Resolves the envelope; 409 INVITE_NOT_PENDING when already settled.
     */
    revokeInvite(invite_id) {
        return _settle(this.apiClient.post(`invites/${_seg(invite_id)}/revoke`, {}), 'revokeInvite');
    }

    /**
     * Lists the permission catalogue and every role (built-in and custom).
     *
     * @returns {Promise<Object>} Resolves `data: { catalogue, roles: RoleView[] }`. `assignable` on
     * each role is computed for the caller.
     */
    listRoles() {
        return _settle(this.apiClient.get('roles'), 'listRoles');
    }

    /**
     * Creates a custom role.
     *
     * @param {Object} params - `{ name, description, permissions: String[] }`.
     * @returns {Promise<Object>} Resolves 201; 409 ROLE_NAME_TAKEN.
     */
    createRole(params) {
        const source = params || {};
        return _settle(this.apiClient.post('roles', {
            name: source.name,
            description: source.description,
            permissions: source.permissions
        }), 'createRole');
    }

    /**
     * Replaces a custom role's name, description and permissions.
     *
     * @param {String} role_id - The custom role.
     * @param {Object} params - `{ name, description, permissions: String[] }`.
     * @returns {Promise<Object>} Resolves 200; 409 ROLE_NAME_TAKEN.
     */
    updateRole(role_id, params) {
        const source = params || {};
        return _settle(this.apiClient.patch(`roles/${_seg(role_id)}`, {
            name: source.name,
            description: source.description,
            permissions: source.permissions
        }), 'updateRole');
    }

    /**
     * Deletes a custom role.
     *
     * @param {String} role_id - The custom role.
     * @returns {Promise<Object>} Resolves 200; 409 ROLE_IN_USE while a user or live invite holds it.
     */
    deleteRole(role_id) {
        return _settle(this.apiClient.delete(`roles/${_seg(role_id)}`), 'deleteRole');
    }

    /**
     * One page of the security activity log, newest first.
     *
     * ⚠️ `before` IS AN OPAQUE CURSOR (`'<iso>|<objectId>'`). Pass back exactly the `next_before`
     * the previous page returned; building one from a row's timestamp would skip every event that
     * shares that millisecond.
     *
     * @param {Object} params - `{ limit?, before? }`. The server clamps `limit` to 1..200.
     * @returns {Promise<Object>} Resolves `data: { items, next_before }`; `next_before` is null at the end.
     */
    listAuditEvents(params) {
        const source = params || {};
        const query = {};
        if (source.limit !== undefined && source.limit !== null) {
            query.limit = source.limit;
        }
        if (typeof source.before === 'string' && source.before) {
            query.before = source.before;
        }
        return _settle(this.apiClient.get('audit-events', { params: query }), 'listAuditEvents');
    }
}

export default UserAdminApiService;
