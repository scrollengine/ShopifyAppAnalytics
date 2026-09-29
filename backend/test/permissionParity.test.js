'use strict';

/**
 * ============================================================================
 *  PERMISSION PARITY — the frontend's copy of the catalogue matches the backend (spec §14, A15, A20)
 * ============================================================================
 *
 *  `frontend/utils/permissions.js` is a COPY of three backend string sets: the
 *  permission keys, the keys each page needs, and a label for every audit
 *  action. Nothing at build time connects the two repositories, and a typo on
 *  either side compiles, lints and renders — as a nav row hidden from
 *  everybody, a button never enabled, or an activity-log row with no label.
 *
 *  The backend is the authority (it enforces; the frontend only decides what
 *  to OFFER), so this file loads the frontend module exactly as the dashboard
 *  is built from it and compares it to the backend's live constants.
 *
 *  The frontend file is an ES module in a package with no "type" field, so it
 *  is loaded with a dynamic `import()` and Node's module-syntax detection
 *  (default-on in every Node this project supports). Expect one
 *  MODULE_TYPELESS_PACKAGE_JSON warning on stderr; it is Node describing that
 *  detection, not a failure.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO_ROOT, 'backend', 'src');
const FRONTEND_PERMISSIONS = path.join(REPO_ROOT, 'frontend', 'utils', 'permissions.js');
const FRONTEND_ADMIN_PRESENTATION = path.join(REPO_ROOT, 'frontend', 'components', 'admin', 'adminPresentation.js');

const permissionsConstants = require(path.join(SRC, 'modules', 'auth', 'constants', 'permissions.constants.ts'));
const rolesConstants = require(path.join(SRC, 'modules', 'auth', 'constants', 'roles.constants.ts'));
const auditConstants = require(path.join(SRC, 'modules', 'auth', 'constants', 'audit.constants.ts'));
const authConstants = require(path.join(SRC, 'modules', 'auth', 'constants', 'auth.constants.ts'));
const syncConstants = require(path.join(SRC, 'modules', 'sync', 'constants', 'sync.constants.ts'));
const apiResponse = require(path.join(SRC, 'utils', 'apiResponse.ts'));

const { PERMISSIONS, ALL_PERMISSION_KEYS, OWNER_ONLY_PERMISSIONS } = permissionsConstants;
const { BUILT_IN_ROLES } = rolesConstants;
const { AUDIT_ACTIONS } = auditConstants;

/** Loads the frontend module once, the way the dashboard does. */
let _frontend = null;
const _loadFrontend = async () => {
    if (!_frontend) {
        _frontend = await import(pathToFileURL(FRONTEND_PERMISSIONS).href);
    }
    return _frontend;
};

const _sorted = (values) => Array.from(values).sort();


test('PERMISSIONS: the frontend copy has the same names AND the same values as the backend', async () => {
    const frontend = await _loadFrontend();
    assert.deepEqual({ ...frontend.PERMISSIONS }, { ...PERMISSIONS }, 'A key was added, removed or re-spelled on one side only.');
    assert.deepEqual(_sorted(frontend.PERMISSION_KEYS), _sorted(ALL_PERMISSION_KEYS));
    assert.deepEqual(_sorted(Object.keys(frontend.PERMISSION_LABELS)), _sorted(ALL_PERMISSION_KEYS), 'Every key needs an on-screen label.');
});

test('OWNER_ONLY_PERMISSIONS: the frontend copy equals the backend list — GET /api/roles marks nothing owner-only', async () => {
    const frontend = await _loadFrontend();
    assert.ok(OWNER_ONLY_PERMISSIONS.length > 0, 'precondition: the backend owner-only list is empty, so this comparison proves nothing');
    assert.deepEqual(
        _sorted(frontend.OWNER_ONLY_PERMISSIONS),
        _sorted(OWNER_ONLY_PERMISSIONS),
        'The role editor would offer a key the server refuses to grant, or hide one it allows.'
    );
});

test('PAGE_PERMISSIONS: every value is a catalogue key; the admin page needs users:read; /account needs nothing', async () => {
    const frontend = await _loadFrontend();
    const catalogue = new Set(ALL_PERMISSION_KEYS);
    for (const [route, keys] of Object.entries(frontend.PAGE_PERMISSIONS)) {
        assert.ok(Array.isArray(keys), `${route} has no key list.`);
        for (const key of keys) {
            assert.ok(catalogue.has(key), `${route} names "${key}", which is not a backend permission — that page would be hidden from everyone.`);
        }
    }
    assert.deepEqual([...frontend.PAGE_PERMISSIONS['/settings/users']], [PERMISSIONS.USERS_READ]);
    assert.deepEqual([...frontend.PAGE_PERMISSIONS['/account']], []);
    assert.deepEqual([...frontend.PAGE_PERMISSIONS['/sync']], [PERMISSIONS.SYNC_READ]);
    assert.deepEqual([...frontend.PAGE_PERMISSIONS['/apps']], [PERMISSIONS.APPS_READ]);
});

test('AUDIT_ACTION_LABELS: exactly the backend\'s AUDIT_ACTIONS — no row without a label, no label for a row that cannot exist', async () => {
    const frontend = await _loadFrontend();
    assert.deepEqual(_sorted(Object.keys(frontend.AUDIT_ACTION_LABELS)), _sorted(Object.values(AUDIT_ACTIONS)));
    for (const [action, label] of Object.entries(frontend.AUDIT_ACTION_LABELS)) {
        assert.equal(typeof label, 'string');
        assert.ok(label.length > 0, `${action} has an empty label.`);
    }
});

test('MANAGE_BLOCK_REASON_LABELS: a sentence for every MANAGEMENT_BLOCK_REASONS code — a locked row never shows a raw code', async () => {
    // `manage_block_reason` is a code (TARGET_NOT_BELOW_ACTOR, SELF …). The Members tab rendered it
    // verbatim as the tooltip and the screen-reader label until it went through this map.
    const presentation = await import(pathToFileURL(FRONTEND_ADMIN_PRESENTATION).href);
    const codes = Object.values(authConstants.MANAGEMENT_BLOCK_REASONS);
    assert.ok(codes.length > 0, 'precondition: no block reasons on the backend, so this comparison proves nothing');
    assert.deepEqual(_sorted(Object.keys(presentation.MANAGE_BLOCK_REASON_LABELS)), _sorted(codes));
    for (const [code, label] of Object.entries(presentation.MANAGE_BLOCK_REASON_LABELS)) {
        assert.ok(typeof label === 'string' && label.length > 0 && label !== code, `${code} has no sentence of its own.`);
    }
    assert.ok(presentation.MANAGE_BLOCK_FALLBACK.length > 0);
});

test('every built-in role lands somewhere it can open; an empty permission set still lands on /account', async () => {
    const frontend = await _loadFrontend();
    for (const [roleKey, role] of Object.entries(BUILT_IN_ROLES)) {
        const landing = frontend.landingRouteFor([...role.permissions]);
        assert.equal(typeof landing, 'string', `${roleKey} has no landing route.`);
        assert.equal(frontend.canViewPage([...role.permissions], landing), true, `${roleKey} lands on ${landing}, which it cannot open.`);
    }
    assert.equal(frontend.landingRouteFor([]), '/account');
    assert.equal(frontend.canViewPage([], '/settings/users'), false);
    assert.equal(frontend.canViewPage(ALL_PERMISSION_KEYS.slice(), '/some/unregistered/page'), false, 'An unregistered page is default-deny.');
});

test('sync triggers: the frontend gates each job type on the key the backend route demands', async () => {
    const frontend = await _loadFrontend();
    const expected = {
        PARTNER_SYNC: PERMISSIONS.SYNC_RUN,
        DUMMY: PERMISSIONS.SYNC_RUN,
        BIGQUERY_SYNC: PERMISSIONS.SYNC_RUN_BILLED,
        INSTALL_ATTRIBUTION_SYNC: PERMISSIONS.SYNC_RUN_BILLED
    };
    for (const jobType of Object.values(syncConstants.STORABLE_JOB_TYPES)) {
        assert.ok(jobType in expected, `The backend has a job type (${jobType}) this parity table does not know — add its route key here.`);
        assert.equal(frontend.syncTriggerPermissionFor(jobType), expected[jobType], jobType);
    }
    assert.equal(frontend.syncTriggerPermissionFor('SOMETHING_NEW'), PERMISSIONS.SYNC_RUN_BILLED, 'An unknown trigger gets the stricter key.');
});

test('the 403 envelope the frontend decodes is the one the backend sends', async () => {
    const frontend = await _loadFrontend();
    let sent = null;
    const res = {
        status() {
            return res;
        },
        json(body) {
            sent = body;
            return res;
        }
    };
    apiResponse.forbiddenResponse(res, 'Your role does not include this.', PERMISSIONS.MERCHANTS_READ);
    assert.equal(frontend.FORBIDDEN_CODE, sent.error.code);
    assert.equal(frontend.isForbiddenResponse(sent), true);
    assert.equal(frontend.forbiddenPermissionOf(sent), PERMISSIONS.MERCHANTS_READ);
});
