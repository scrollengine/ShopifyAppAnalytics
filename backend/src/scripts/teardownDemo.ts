'use strict';

/**
 * ============================================================================
 *  REMOVE THE DEMO DATASET — `npm run seed:demo:down`
 * ============================================================================
 *
 *  Deletes exactly what `seedDemo.ts` wrote: every fact row scoped to the demo
 *  app's `partner_app_id`, then the app row itself. Nothing else, and there is
 *  no `--force`.
 *
 *  ⚠️ IT REFUSES ON AN UNMARKED APP ROW. If the app registered on the demo GID
 *  does not carry the demo marker it was not written here, and deleting it would
 *  take a real app's whole history with it. See `services/demoSeed.service`.
 *
 *  Sign-in data is NOT touched: users, roles, invitations, sessions, the install
 *  state and the audit log. None of it is demo data — people create it through
 *  first-run setup and invitations — and removing it would lock them out of
 *  their own deployment.
 *
 *  ── Exit codes ──────────────────────────────────────────────────────────────
 *      0  removed, or there was nothing to remove
 *      2  REFUSED: the app row on the demo GID is not the demo app
 *      1  anything else went wrong
 * ============================================================================
 */

// This file is an ENTRY POINT with no exports, and `export {}` is what makes
// TypeScript treat it as a module rather than a global script. Without it every
// top-level name here collides with the other entry point's names at compile
// time (TS2451), because two global scripts share one scope.
export {};

type ConfigModule = typeof import('../config');
type DbModule = typeof import('../core/db');
type DemoSeedServiceModule = typeof import('./services/demoSeed.service');

/** Exit code for a deliberate refusal, kept distinct from a failure. */
const EXIT_REFUSED = 2;

const main = async (): Promise<number> => {
    require('dotenv').config();

    const config: ConfigModule = require('../config');
    if (!config.MONGO.URI) {
        process.stderr.write(
            'MONGO_URI is not set, so there is nothing to connect to.\n\n'
            + '  Add this to your .env file:\n\n'
            + '      MONGO_URI=mongodb://127.0.0.1:27017/shopify-app-analytics\n\n'
            + '  (Read at config.MONGO.URI.)\n'
        );
        return 1;
    }

    const { initDb, closeDb }: DbModule = require('../core/db');
    const demoSeedService: DemoSeedServiceModule = require('./services/demoSeed.service');

    await initDb();
    try {
        const outcome = await demoSeedService.teardownDemoDataset();

        if (outcome.status === 'REFUSED') {
            process.stderr.write(`\nREFUSED: ${outcome.message}\n\n`);
            return EXIT_REFUSED;
        }

        process.stdout.write(`\n${outcome.message}\n`);
        for (const [key, value] of Object.entries(outcome.removed)) {
            process.stdout.write(`      ${key.padEnd(14)} ${value}\n`);
        }
        process.stdout.write('\n');
        return 0;
    } finally {
        await closeDb();
    }
};

main()
    .then((code) => {
        process.exit(code);
    })
    .catch((error: unknown) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        process.stderr.write(`\nThe demo teardown failed. Nothing may have been removed.\n${message}\n\n`);
        process.exit(1);
    });
