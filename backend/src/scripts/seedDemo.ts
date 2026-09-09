'use strict';

/**
 * ============================================================================
 *  SEED THE DEMO DATASET — `npm run seed:demo`
 * ============================================================================
 *
 *      npm run seed:demo                 write it (refuses on a non-empty database)
 *      npm run seed:demo -- --force      write it anyway
 *      npm run seed:demo -- --reanchor   re-date an existing demo to today
 *      npm run seed:demo:down            remove exactly what it wrote
 *
 *  Fills a fresh install with one fictional Shopify app's history, so `docker
 *  compose up` reaches eleven working pages without a Partner organisation, an
 *  API token, or a completed lifetime sync. Everything it writes is marked; see
 *  `constants/demoSeed.constants` for the three markers and
 *  `services/demoSeed.service` for the refusal.
 *
 *  ──  WHY THIS DOES NOT CALL `validateConfig()` ────────────────────────────
 *
 *  `bootstrap()` validates the whole TIER-1 set, which includes
 *  SHOPIFY_PARTNER_ORG_ID and SHOPIFY_PARTNER_API_TOKEN. Requiring those here
 *  would mean the demo — whose entire purpose is to work WITHOUT a Partner
 *  account — could not be seeded by the person it exists for. So this entry
 *  point loads `.env`, requires config, and checks the one setting it actually
 *  needs: `MONGO_URI`. Nothing here reads `process.env` directly; that stays the
 *  privilege of `src/config`.
 *
 *  ── Lazy requires, for the reason `apps/app.ts` gives ──────────────────────
 *  `src/config` snapshots `process.env` at FIRST require, so dotenv has to run
 *  before anything that reaches config is required. Hoisting one of the requires
 *  below to module scope gives the whole script a config built from defaults —
 *  which does not crash, it just silently connects nowhere.
 *
 *  ── Exit codes, so a compose entrypoint can branch on them ─────────────────
 *      0  seeded (or already seeded — a re-run is a no-op)
 *      2  REFUSED: the database holds data this seeder did not write
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

/** Whether a flag was passed. `--force` and `-f`; long form is what the docs use. */
const _hasFlag = (argv: readonly string[], long: string, short: string): boolean => {
    return argv.includes(long) || argv.includes(short);
};

/** One line per collection, so the run can be checked without opening the dashboard. */
const _printCounts = (label: string, counts: Record<string, number>): void => {
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    process.stdout.write(`  ${label}: ${total}\n`);
    for (const [key, value] of Object.entries(counts)) {
        process.stdout.write(`      ${key.padEnd(14)} ${value}\n`);
    }
};

const main = async (): Promise<number> => {
    require('dotenv').config();

    const config: ConfigModule = require('../config');
    if (!config.MONGO.URI) {
        process.stderr.write(
            'MONGO_URI is not set, so there is nowhere to write the demo dataset.\n\n'
            + '  Add this to your .env file:\n\n'
            + '      MONGO_URI=mongodb://127.0.0.1:27017/shopify-app-analytics\n\n'
            + '  (Read at config.MONGO.URI.)\n'
        );
        return 1;
    }

    const argv = process.argv.slice(2);
    const force = _hasFlag(argv, '--force', '-f');
    const reanchor = _hasFlag(argv, '--reanchor', '-r');

    const { initDb, closeDb }: DbModule = require('../core/db');
    const demoSeedService: DemoSeedServiceModule = require('./services/demoSeed.service');

    await initDb();
    try {
        const outcome = await demoSeedService.seedDemoDataset({ force, reanchor, now: new Date() });

        if (outcome.status === 'REFUSED') {
            process.stderr.write(`\nREFUSED: ${outcome.message}\n\n`);
            return EXIT_REFUSED;
        }

        process.stdout.write(`\n${outcome.message}\n`);
        process.stdout.write(`  partner_app_id: ${outcome.partner_app_id}\n`);
        process.stdout.write(`  anchor:         ${outcome.anchor_at ? outcome.anchor_at.toISOString() : '(none)'}\n`);
        process.stdout.write(`  stores:         ${outcome.summary.stores}\n`);
        process.stdout.write(`  empty month:    ${outcome.summary.quiet_month} (no trials started — that month has no measurable rate)\n`);
        _printCounts('replaced', outcome.removed);
        _printCounts('written', outcome.written);
        process.stdout.write('  watermarks:\n');
        for (const [key, value] of Object.entries(outcome.watermarks)) {
            let printed = '(null)';
            if (value instanceof Date) {
                printed = value.toISOString();
            } else if (value !== null && value !== undefined) {
                printed = String(value);
            }
            process.stdout.write(`      ${key.padEnd(30)} ${printed}\n`);
        }
        process.stdout.write('\n  Every shop domain ends in the reserved .example TLD and the app is named "(DEMO DATA)".\n');
        process.stdout.write('  Remove it all with: npm run seed:demo:down\n\n');
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
        process.stderr.write(`\nThe demo seed failed and nothing further was written.\n${message}\n\n`);
        process.exit(1);
    });
