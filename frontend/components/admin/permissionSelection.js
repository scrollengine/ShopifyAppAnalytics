import { OWNER_ONLY_PERMISSIONS, PERMISSIONS } from '../../utils/permissions';

/**
 * =============================================================================
 *  Pure selection rules for the custom-role permission picker.
 * =============================================================================
 *
 *  The catalogue (keys, labels, groups, descriptions, `requires`) comes from
 *  GET /api/roles, so the dependency graph is the server's own and is never
 *  restated here. What this file owns is how a TICK and an UNTICK move the
 *  selection so that it is always a set the server would accept:
 *
 *    · ticking a key also ticks everything it requires, transitively;
 *    · a key another ticked key requires cannot be unticked (untick the
 *      dependent first), so the selection never becomes one the server refuses;
 *    · `apps:read` is always held;
 *    · owner-only keys are never offered and never sent.
 *
 *  The server validates the same rules on save and is the authority. This is
 *  the convenience that keeps the form from offering a save that will fail.
 * =============================================================================
 */

/** Every role must hold it. Shown ticked and locked. */
export const BASELINE_PERMISSION = PERMISSIONS.APPS_READ;

/**
 * True when the key may never be granted to a custom role. The list lives in `utils/permissions.js`,
 * where `backend/test/permissionParity.test.js` holds it equal to the backend's; the catalogue from
 * `GET /api/roles` carries no owner-only marker of its own.
 *
 * @param {Object} entry - A catalogue entry.
 * @returns {Boolean}
 */
export const isOwnerOnly = (entry) => Boolean(entry) && OWNER_ONLY_PERMISSIONS.includes(entry.key);

/**
 * key → requires[] for the catalogue.
 *
 * @param {Array<Object>} catalogue - `PERMISSION_CATALOGUE`.
 * @returns {Map<String, Array<String>>}
 */
const _requiresIndex = (catalogue) => {
    const index = new Map();
    (Array.isArray(catalogue) ? catalogue : []).forEach((entry) => {
        if (entry && typeof entry.key === 'string') {
            index.set(entry.key, Array.isArray(entry.requires) ? entry.requires : []);
        }
    });
    return index;
};

/**
 * The keys plus everything they require, transitively, in catalogue order.
 *
 * Keys the catalogue does not know are DROPPED, as the server drops them: an unknown key is never
 * honoured, so carrying it in the form would only produce a save the server rejects.
 *
 * @param {Array<String>} keys - Starting keys.
 * @param {Array<Object>} catalogue - `PERMISSION_CATALOGUE`.
 * @returns {Array<String>}
 */
export const permissionClosure = (keys, catalogue) => {
    const index = _requiresIndex(catalogue);
    const reached = new Set();
    const stack = Array.isArray(keys) ? keys.slice() : [];
    while (stack.length > 0) {
        const key = stack.pop();
        if (reached.has(key) || !index.has(key)) {
            continue;
        }
        reached.add(key);
        index.get(key).forEach((required) => stack.push(required));
    }
    return (Array.isArray(catalogue) ? catalogue : [])
        .map((entry) => entry && entry.key)
        .filter((key) => reached.has(key));
};

/**
 * The selection the form holds and sends: closed under `requires`, always including the baseline,
 * never including an owner-only key, in catalogue order.
 *
 * @param {Array<String>} keys - Any starting keys (a role's stored permissions, say).
 * @param {Array<Object>} catalogue - `PERMISSION_CATALOGUE`.
 * @returns {Array<String>}
 */
export const normaliseSelection = (keys, catalogue) => {
    const entries = Array.isArray(catalogue) ? catalogue : [];
    const ownerOnly = entries.filter(isOwnerOnly).map((entry) => entry.key);
    const start = (Array.isArray(keys) ? keys : []).filter((key) => !ownerOnly.includes(key));
    start.push(BASELINE_PERMISSION);
    return permissionClosure(start, catalogue).filter((key) => !ownerOnly.includes(key));
};

/**
 * The selected keys (other than `key` itself) whose requirements include `key`, transitively.
 * Non-empty means `key` is locked on.
 *
 * @param {String} key - The key being considered for unticking.
 * @param {Array<String>} selected - The current selection.
 * @param {Array<Object>} catalogue - `PERMISSION_CATALOGUE`.
 * @returns {Array<String>}
 */
export const requiredByKeys = (key, selected, catalogue) => (Array.isArray(selected) ? selected : [])
    .filter((other) => other !== key && permissionClosure([other], catalogue).includes(key));

/**
 * The next selection after ticking or unticking one key.
 *
 * An untick that would break a requirement (or drop the baseline) returns the selection unchanged;
 * the picker renders such a checkbox locked anyway, so this is the backstop, not the UI.
 *
 * @param {String} key - The key toggled.
 * @param {Boolean} checked - The new checkbox state.
 * @param {Array<String>} selected - The current selection.
 * @param {Array<Object>} catalogue - `PERMISSION_CATALOGUE`.
 * @returns {Array<String>}
 */
export const togglePermission = (key, checked, selected, catalogue) => {
    const current = normaliseSelection(selected, catalogue);
    if (checked) {
        return normaliseSelection(current.concat([key]), catalogue);
    }
    if (key === BASELINE_PERMISSION || requiredByKeys(key, current, catalogue).length > 0) {
        return current;
    }
    return current.filter((held) => held !== key);
};

/**
 * The catalogue entries a custom role may be given, grouped by `group` in first-appearance order.
 *
 * @param {Array<Object>} catalogue - `PERMISSION_CATALOGUE`.
 * @returns {Array<{group: String, entries: Array<Object>}>}
 */
export const groupOfferableCatalogue = (catalogue) => {
    const groups = [];
    const byName = new Map();
    (Array.isArray(catalogue) ? catalogue : []).forEach((entry) => {
        if (!entry || typeof entry.key !== 'string' || isOwnerOnly(entry)) {
            return;
        }
        const name = typeof entry.group === 'string' && entry.group ? entry.group : 'Other';
        if (!byName.has(name)) {
            const group = { group: name, entries: [] };
            byName.set(name, group);
            groups.push(group);
        }
        byName.get(name).entries.push(entry);
    });
    return groups;
};

/**
 * Catalogue labels for a list of keys, for "Requires: …" / "Required by: …" hints.
 *
 * @param {Array<String>} keys - Permission keys.
 * @param {Array<Object>} catalogue - `PERMISSION_CATALOGUE`.
 * @returns {Array<String>}
 */
export const labelsFor = (keys, catalogue) => {
    const entries = Array.isArray(catalogue) ? catalogue : [];
    return (Array.isArray(keys) ? keys : []).map((key) => {
        const entry = entries.find((candidate) => candidate && candidate.key === key);
        return entry && entry.label ? String(entry.label) : String(key);
    });
};
