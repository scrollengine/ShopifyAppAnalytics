/**
 * The auth module's public surface. Everything outside `src/modules/auth/` imports
 * from here — the middleware, the controller, the boot sequence.
 *
 * Barrel rules — deep-path imports inside the folder, every key enumerated,
 * `export =` never `export default` — are stated once in IMPLEMENTATION.md
 * §3.13 and asserted by test/exportSurface.test.js.
 */

import adminAuthService = require('./services/adminAuth.service');
import authConstants = require('./constants/adminAuth.constants');

export = {
    /** Creates the single operator account at first boot. Idempotent; never updates an existing one. */
    seedAdminIfMissing: adminAuthService.seedAdminIfMissing,
    /** Exchanges an email and password for a session token. One message for every failure. */
    login: adminAuthService.login,
    /** Verifies a session token and returns `{ user_id, expires_at }`. */
    verifyToken: adminAuthService.verifyToken,
    /** The messages this module is allowed to say — including the single generic login failure. */
    AUTH_MESSAGES: authConstants.AUTH_MESSAGES,
    /** CREATED / ALREADY_PRESENT, so the boot sequence can tell a first run from a restart. */
    ADMIN_SEED_OUTCOMES: authConstants.ADMIN_SEED_OUTCOMES
};
