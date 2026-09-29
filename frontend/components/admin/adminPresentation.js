/**
 * =============================================================================
 *  Pure presentation helpers for the Users & roles screen.
 * =============================================================================
 *
 *  No I/O, no clock, no React. Every function takes what it formats as an
 *  argument, so the four tabs share one wording for one fact: an invitation
 *  state, an email outcome, a role option, an audit row.
 *
 *  ⚠️ NOTHING HERE DECIDES VALIDITY. An invitation's state comes from the
 *  server's `state` field and is only labelled here. Comparing `expires_at` to
 *  the browser clock would disagree with the server whenever the two clocks
 *  do, and the server is the one that honours or refuses the link.
 * =============================================================================
 */

/** Rendered where a value is absent. */
export const DASH = '—';

/**
 * Formats a timestamp in the BROWSER's time zone, with the zone named.
 *
 * Explicit fields rather than `dateStyle`/`timeStyle`: those two cannot be combined with
 * `timeZoneName` (the constructor throws a TypeError), and a time with no zone beside it is
 * ambiguous for a team spread across zones.
 *
 * @param {String|Date|null|undefined} value - An ISO string or Date.
 * @returns {String} The formatted time, `DASH` when absent, or the raw value when unparseable.
 */
export const formatDateTime = (value) => {
    if (value === null || value === undefined || value === '') {
        return DASH;
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }
    try {
        return date.toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short'
        });
    } catch (e) {
        return date.toISOString();
    }
};

/**
 * The server's business code from a service result, or '' when there is none.
 *
 * @param {Object} result - A `userAdminService` result.
 * @returns {String} `result.error.code`, or ''.
 */
export const errorCodeOf = (result) => {
    if (result && result.error && typeof result.error.code === 'string') {
        return result.error.code;
    }
    return '';
};

/**
 * The sentence to show for a failed call.
 *
 * @param {Object} result - A `userAdminService` result.
 * @param {String} fallback - Used when the server gave no message.
 * @returns {String}
 */
export const failureMessage = (result, fallback) => {
    if (result && typeof result.msg === 'string' && result.msg) {
        return result.msg;
    }
    return fallback;
};

/**
 * Badge tone and label for a user's status.
 */
export const USER_STATUS_BADGE = Object.freeze({
    active: Object.freeze({ tone: 'success', label: 'Active' }),
    disabled: Object.freeze({ tone: 'critical', label: 'Disabled' })
});

/**
 * Badge tone and label for each invitation state the server computes.
 */
export const INVITE_STATE_BADGE = Object.freeze({
    pending: Object.freeze({ tone: 'info', label: 'Pending' }),
    expired: Object.freeze({ tone: 'warning', label: 'Expired' }),
    accepted: Object.freeze({ tone: 'success', label: 'Accepted' }),
    revoked: Object.freeze({ tone: undefined, label: 'Revoked' })
});

/**
 * Why a row's actions are locked, in words. Keys are the backend's `MANAGEMENT_BLOCK_REASONS`
 * (`manage_block_reason` on a UserView / InviteView): a CODE, never a sentence, so it is never shown
 * as-is. An unknown code falls back to the generic sentence at the call site.
 */
export const MANAGE_BLOCK_REASON_LABELS = Object.freeze({
    SELF: 'You cannot change your own account here. Use the Account page.',
    TARGET_IS_OWNER: 'The owner can only be changed with the recovery command-line tool.',
    MISSING_USERS_MANAGE: 'Your role does not include managing users.',
    TARGET_NOT_BELOW_ACTOR: 'Their role has permissions yours does not, or the same ones.',
    ROLE_NOT_BELOW_ACTOR: 'That role has permissions yours does not.',
    ROLE_NOT_ASSIGNABLE: 'That role cannot be assigned.'
});

/** Shown for a locked row whose reason code is missing or not in MANAGE_BLOCK_REASON_LABELS. */
export const MANAGE_BLOCK_FALLBACK = 'You cannot manage this user.';

/**
 * Why an invitation was revoked, in words. Keys are the backend's `revoked_reason` values.
 */
export const INVITE_REVOKED_REASON_LABELS = Object.freeze({
    MANUAL: 'Revoked by an admin',
    INVITER_DISABLED: 'Revoked: the person who sent it was disabled',
    INVITER_NO_LONGER_PERMITTED: 'Revoked: the sender can no longer grant this role',
    ROLE_DELETED: 'Revoked: the role was deleted',
    SUPERSEDED: 'Revoked: another invitation to this address was accepted'
});

/**
 * States in which resend and revoke are offered. The server re-checks both and answers
 * 409 INVITE_NOT_PENDING (revoke) or 429 (resend throttle) when the row moved on meanwhile.
 */
export const INVITE_ACTIONABLE_STATES = Object.freeze(['pending', 'expired']);

/**
 * What happened to an email, in words that claim no more than the server knows.
 *
 * "Sent" means ACCEPTED BY THE MAIL SERVER. Nothing in this build can observe delivery, so no
 * sentence here says "delivered". `email_status` (SENT | FAILED | CAP_REACHED | UNCONFIRMED |
 * NOT_CONFIGURED) is preferred when the response carries it; the boolean `email_sent` is the
 * fallback, and it cannot tell a refusal from a timeout, so its false branch says only that the
 * server did not accept the message.
 *
 * @param {Object} data - The response payload: `{ email_sent?, email_status? }`.
 * @param {String} recipient - The address, for the sentence. Rendered as text by the caller.
 * @returns {{tone: String, title: String, body: String}} Banner props.
 */
export const describeEmailOutcome = (data, recipient) => {
    const source = data || {};
    const who = recipient ? recipient : 'the recipient';
    let status = '';
    if (typeof source.email_status === 'string' && source.email_status) {
        status = source.email_status;
    } else if (source.email_sent === true) {
        status = 'SENT';
    } else if (source.email_sent === false) {
        status = 'NOT_ACCEPTED';
    }

    if (status === 'SENT') {
        return {
            tone: 'success',
            title: 'Email accepted by the mail server',
            body: `The mail server accepted the message for ${who}. That is not proof of delivery: if it does not arrive, ask them to check spam.`
        };
    }
    if (status === 'UNCONFIRMED') {
        return {
            tone: 'warning',
            title: 'The mail server did not confirm in time',
            body: `The message to ${who} may still arrive. Wait a few minutes before sending it again.`
        };
    }
    if (status === 'CAP_REACHED') {
        return {
            tone: 'warning',
            title: 'Not sent: email limit reached',
            body: 'This install has reached its outgoing email limit (per hour, per day, or per recipient). Nothing was sent. Try again later.'
        };
    }
    if (status === 'NOT_CONFIGURED') {
        return {
            tone: 'critical',
            title: 'Not sent: email is not configured',
            body: 'The backend has no working SMTP configuration, so nothing was sent.'
        };
    }
    if (status === 'FAILED' || status === 'NOT_ACCEPTED') {
        return {
            tone: 'critical',
            title: 'The mail server did not accept the message',
            body: `Nothing was accepted for ${who}. Check the backend's SMTP settings and logs, then send it again.`
        };
    }
    return {
        tone: 'warning',
        title: 'Email outcome unknown',
        body: 'The server did not say whether the mail server accepted the message.'
    };
};

/**
 * The Select value for a role. Built-in roles are their key; custom roles are `custom:<role_id>`,
 * because every custom role shares `role_key: 'custom'` and only the id tells them apart.
 *
 * @param {Object} role - A RoleView.
 * @returns {String}
 */
export const roleOptionValue = (role) => {
    if (!role) {
        return '';
    }
    if (role.role_key === 'custom') {
        return `custom:${role.role_id}`;
    }
    return String(role.role_key || '');
};

/**
 * Inverse of {@link roleOptionValue}: the request body half for a chosen option.
 *
 * @param {String} value - A Select value.
 * @returns {{role_key: String, custom_role_id?: String}|null} Null when the value is empty.
 */
export const parseRoleOptionValue = (value) => {
    if (typeof value !== 'string' || !value) {
        return null;
    }
    if (value.indexOf('custom:') === 0) {
        return { role_key: 'custom', custom_role_id: value.slice('custom:'.length) };
    }
    return { role_key: value };
};

/**
 * The roles the caller may grant, as Select options.
 *
 * `assignable` is computed BY THE SERVER for the requesting actor (the management rule's
 * strict-subset test), so nothing here re-derives it. A missing or non-true flag means not offered.
 *
 * @param {Array<Object>} roles - RoleView[] from GET /api/roles.
 * @returns {Array<{label: String, value: String}>}
 */
export const assignableRoleOptions = (roles) => {
    if (!Array.isArray(roles)) {
        return [];
    }
    return roles
        .filter((role) => role && role.assignable === true)
        .map((role) => {
            let label = String(role.label || role.role_key || '');
            if (!role.built_in) {
                label = `${label} (custom)`;
            }
            return { label: label, value: roleOptionValue(role) };
        });
};

/**
 * The Select value that denotes a user's CURRENT role, so the change-role picker can mark it.
 *
 * @param {Object} user - A UserView.
 * @returns {String}
 */
export const userRoleOptionValue = (user) => {
    if (!user) {
        return '';
    }
    if (user.role_key === 'custom') {
        return `custom:${user.custom_role_id}`;
    }
    return String(user.role_key || '');
};

/**
 * Labels for the permission keys a role holds, in catalogue order. Keys the catalogue does not
 * know are shown raw rather than dropped, so a mismatch between the two is visible.
 *
 * @param {Array<String>} keys - Permission keys.
 * @param {Array<Object>} catalogue - `PERMISSION_CATALOGUE` from GET /api/roles.
 * @returns {Array<{key: String, label: String}>}
 */
export const permissionLabels = (keys, catalogue) => {
    const held = Array.isArray(keys) ? keys : [];
    const entries = Array.isArray(catalogue) ? catalogue : [];
    const known = entries.filter((entry) => entry && held.includes(entry.key))
        .map((entry) => ({ key: entry.key, label: String(entry.label || entry.key) }));
    const catalogueKeys = entries.map((entry) => entry && entry.key);
    const unknown = held.filter((key) => !catalogueKeys.includes(key))
        .map((key) => ({ key: String(key), label: String(key) }));
    return known.concat(unknown);
};

/** How each non-user actor type reads in the Activity table. */
const AUDIT_ACTOR_TYPE_LABELS = Object.freeze({
    ANONYMOUS: 'Anonymous visitor',
    SYSTEM: 'System',
    CLI: 'Server command line'
});

/**
 * Who did it.
 *
 * @param {Object} event - An audit row.
 * @returns {String}
 */
export const auditActorLabel = (event) => {
    const source = event || {};
    const email = typeof source.actor_email === 'string' ? source.actor_email : '';
    const typeLabel = AUDIT_ACTOR_TYPE_LABELS[source.actor_type] || '';
    if (typeLabel && email) {
        return `${typeLabel} (${email})`;
    }
    if (email) {
        return email;
    }
    if (typeLabel) {
        return typeLabel;
    }
    return DASH;
};

/** How each target type reads when no email names the target. */
const AUDIT_TARGET_TYPE_LABELS = Object.freeze({
    USER: 'User',
    INVITE: 'Invitation',
    ROLE: 'Role',
    SESSION: 'Session',
    INSTALL: 'This install'
});

/**
 * What it was done to.
 *
 * @param {Object} event - An audit row.
 * @returns {String}
 */
export const auditTargetLabel = (event) => {
    const source = event || {};
    if (typeof source.target_email === 'string' && source.target_email) {
        return source.target_email;
    }
    const details = source.details && typeof source.details === 'object' ? source.details : {};
    const typeLabel = AUDIT_TARGET_TYPE_LABELS[source.target_type] || '';
    if (source.target_type === 'ROLE' && typeof details.name === 'string' && details.name) {
        return `Role "${details.name}"`;
    }
    if (typeLabel) {
        return typeLabel;
    }
    return DASH;
};

/**
 * One role reference from an audit row (`{ key, label }` snapshot) in words.
 *
 * @param {*} ref - The snapshot.
 * @returns {String}
 */
const _roleRef = (ref) => {
    if (ref && typeof ref === 'object') {
        return String(ref.label || ref.key || DASH);
    }
    if (typeof ref === 'string') {
        return ref;
    }
    return DASH;
};

/**
 * A short summary of an audit row's `details`, as a list of plain sentences.
 *
 * Known keys get a sentence; any other primitive is shown as `key: value` rather than dropped, so a
 * detail the backend adds later is still visible. Objects and arrays of unknown shape are skipped.
 *
 * @param {Object} event - An audit row.
 * @returns {Array<String>}
 */
export const summariseAuditDetails = (event) => {
    const source = event || {};
    const details = source.details && typeof source.details === 'object' ? source.details : {};
    const lines = [];
    const handled = new Set();

    if (details.from !== undefined || details.to !== undefined) {
        // OWNERSHIP_TRANSFERRED carries emails or ids in from/to; USER_ROLE_CHANGED carries role snapshots.
        lines.push(`From ${_roleRef(details.from)} to ${_roleRef(details.to)}`);
        handled.add('from');
        handled.add('to');
    }
    if (typeof details.role_label === 'string' && details.role_label) {
        lines.push(`Role: ${details.role_label}`);
        handled.add('role_label');
        handled.add('role_key');
    }
    if (typeof details.email_status === 'string' && details.email_status) {
        lines.push(`Email: ${details.email_status === 'SENT' ? 'accepted by the mail server' : details.email_status}`);
        handled.add('email_status');
    }
    if (typeof details.reason === 'string' && details.reason) {
        lines.push(`Reason: ${INVITE_REVOKED_REASON_LABELS[details.reason] || details.reason}`);
        handled.add('reason');
    }
    if (typeof details.count === 'number') {
        lines.push(`Count: ${details.count}`);
        handled.add('count');
    }
    if (typeof details.allowed === 'boolean') {
        lines.push(details.allowed ? 'Address permitted to set up' : 'Address NOT permitted to set up (nothing sent)');
        handled.add('allowed');
    }
    if (Array.isArray(details.added) && details.added.length > 0) {
        lines.push(`Added: ${details.added.join(', ')}`);
    }
    handled.add('added');
    if (Array.isArray(details.removed) && details.removed.length > 0) {
        lines.push(`Removed: ${details.removed.join(', ')}`);
    }
    handled.add('removed');
    if (Array.isArray(details.permissions)) {
        lines.push(`Permissions: ${details.permissions.length ? details.permissions.join(', ') : 'none'}`);
        handled.add('permissions');
    }
    if (details.invalid_email === true) {
        lines.push('The submitted email was not a valid address and was not recorded');
        handled.add('invalid_email');
    }
    // The role name is already in the Target column for ROLE rows.
    if (source.target_type === 'ROLE') {
        handled.add('name');
    }

    Object.keys(details).forEach((key) => {
        if (handled.has(key)) {
            return;
        }
        const value = details[key];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            lines.push(`${key}: ${String(value)}`);
        }
    });
    return lines;
};

/**
 * A stable id for an audit row, for React keys and de-duplication across "Load more" pages.
 *
 * @param {Object} event - An audit row.
 * @returns {String} The id, or '' when the row carries none.
 */
export const auditEventId = (event) => {
    const source = event || {};
    const id = source.event_id || source.audit_event_id || source.id || source._id;
    return id ? String(id) : '';
};

/**
 * An audit row's timestamp field, whichever spelling the payload uses.
 *
 * @param {Object} event - An audit row.
 * @returns {String|null}
 */
export const auditEventTime = (event) => {
    const source = event || {};
    return source.created_at || source.createdAt || null;
};
