'use strict';

/**
 * ============================================================================
 *  COUNTRY ROUTES — mounted GUARDED at /api/stores
 * ============================================================================
 *
 *  The Revenue → By country tab's whole-population rollup: `GET /api/stores/countries`.
 *
 *  Handlers are mounted BARE here. The guard is applied ONCE, on the parent sub-router in
 *  `src/routes/index.ts`, and this file inherits it by being mounted there — see that file's header
 *  for why the guard lives in one place rather than being repeated per route file.
 *  `test/routeGuard.test.js` walks the live Express stack and fails on any route reachable without
 *  `verifyAdmin`, so the mount is asserted rather than assumed the moment it is added.
 *
 *  ── ⚠️ WHY THIS IS A SECOND ROUTER ON `/stores` AND NOT A LINE IN `store.routes.ts` ─────────
 *
 *  The PATH is the frontend's, not a choice: `API_Services/growth-intel/countryService.js` already
 *  documents `GET /api/stores/countries`, so wiring the client up is deleting its stub rather than
 *  redesigning it. And the path is right on its own terms — this is a rollup OF the store roster,
 *  over the same population `/api/stores` lists.
 *
 *  Express matches mounts in registration order and falls THROUGH a router that handles nothing, so
 *  `storeRoutes` (which serves `/` and `/detail`) declines `/countries` and this router picks it up.
 *  Mounting it separately keeps the country rollup's own area — its controller, its service, its
 *  vocabulary — visible as one thing rather than buried as a third line in a file about the roster.
 *
 *  ── ⚠️ ORDERING, AND THE ONE ROUTE THAT WOULD BREAK IT ──────────────────────
 *
 *  `/countries` is a literal path, so its position relative to `store.routes.ts` does not matter
 *  today. IT WOULD THE MOMENT A `/:shop_domain` ROUTE IS ADDED TO EITHER FILE: Express matches in
 *  registration order, so a parameter route registered first would swallow this one and answer with a
 *  store named "countries". `store.routes.ts` carries the same warning. Register any such route LAST,
 *  in the LAST of the two routers.
 * ============================================================================
 */

import { Router } from 'express';
import countryController = require('../controllers/country.controller');

const { _getCountries } = countryController;

const router = Router();

// Stores, installs, paying customers, MRR and lifetime spend per country, over the WHOLE population.
//
// ⚠️ Country here is the country the INSTALL TRAFFIC came from (listing analytics geo), NOT the
// merchant's registered trading country — the Partner API's Shop object carries no country on any
// version. Every store without an attribution record is published in an explicit `UNKNOWN` row rather
// than dropped, so the breakdown always reconciles with the totals beside it.
//
// Answers 200 with an all-Unknown breakdown and a populated `attribution_state` / `warnings[]` when
// the listing tier is unconfigured or has never synced — deliberately NOT a refusal, which the page
// would render as though the operator had no stores.
router.get('/countries', _getCountries);

export = router;
