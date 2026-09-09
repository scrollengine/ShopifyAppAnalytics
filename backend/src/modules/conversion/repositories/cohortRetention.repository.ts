'use strict';

/**
 * ============================================================================
 *  COHORT RETENTION — the ONE read it needs that no sibling already issues
 * ============================================================================
 *
 *  The install SPINE is not here: `installCohort.repository.aggregateInstallSpine` already answers
 *  "one row per store that installed or reinstalled inside a window, plus what the blank-domain
 *  filter excluded", which is exactly this endpoint's population. A second spine query would be a
 *  second definition of who is in a cohort, and the two would disagree the day one of them was
 *  corrected — with the retention grid and the install table sitting on the same page.
 *
 *  So this file holds one read: the RELATIONSHIP events behind "is the app still on this store?".
 *
 *  ──  THE `$in` COMES FROM `modules/store`, AND THAT IS THE POINT ─────────────────────────
 *
 *  The fold that consumes these rows is `modules/store/resolvers/installState.resolver` — this build
 *  has exactly one definition of install state and this endpoint reaches it rather than growing a
 *  second. A fold and its `$in` list must agree: a type fetched here that the fold does not recognise
 *  is counted `unrecognised_events` and dropped, and a type the fold recognises that is NOT fetched
 *  makes a store read as installed for ever. Restating the four strings locally would be exactly that
 *  hazard, latent, waiting for the day a fifth relationship event is added to one list only.
 *
 *  ⚠️ DEEP PATH TO A PURE CONSTANTS FILE, NEVER `require('../../store')`. That barrel loads every
 *  store service, each of which imports `modules/conversion`'s barrel — so the import would close a
 *  cycle and destructure half of this module as `undefined` at load.
 *  `modules/revenue/repositories/revenue.repository.ts:20-45` documents that exact failure, from the
 *  other direction, in this codebase, with the fifteen tests it broke.
 *  `store/constants/storeRoster.constants` imports only `src/constants/partnerVocab.constants`, so it
 *  has no edge back here and cannot close a loop.
 *
 *  ── THE TWO THINGS THAT ARE LOAD-BEARING ────────────────────────────────────────────────────
 *
 *  1. THE `$match` CASTS THROUGH `toObjectId`. `find` auto-casts and `aggregate` does not, and this
 *     file may grow an aggregate later — the cast is free and its absence is silent: an uncast id
 *     matches ZERO documents and raises NO error, so every cohort would publish 100% retention
 *     (nobody uninstalled) on a page that looks entirely healthy.
 *
 *  2. THE LOWER BOUND IS SAFE HERE, UNLIKE ON THE CHARGE-COHORT PULL. Every store in this population
 *     installed at or after `since`, so its uninstall — which must follow its install — is inside the
 *     range too. The charge cohort carries no `$gte` because a subscription may PREDATE the window;
 *     retention is measured forward from an in-window install, so nothing older can change an answer.
 *     Do not copy this bound onto a subscription read, and do not remove it from this one.
 *
 *  ── What is NOT here ────────────────────────────────────────────────────────────────────────
 *  No judgement. What "still installed" means, which event wins a tie, what an empty result means —
 *  all of that belongs to the fold and the service, because those are what a test reaches.
 * ============================================================================
 */

import models = require('../../shared/repositories/models.repository');
//  See the file header: a DEEP PATH to a pure constants file, never the store module's barrel.
import storeRosterConstants = require('../../store/constants/storeRoster.constants');

import type { RelationshipEventQuery, RelationshipEventRow } from '../types/cohortRetentionData.types';

const { PartnerAppEventModel, toObjectId } = models;
const { STORE_RELATIONSHIP_EVENT_TYPES } = storeRosterConstants;

/**
 * Every INSTALL / REINSTALL / UNINSTALL / DEACTIVATED event in the reported span.
 *
 * APP-WIDE rather than fanned out over the spine's domains, deliberately. The install-cohort read
 * chunks its joins because it enriches a spine of up to forty thousand stores from three other
 * collections; here the span is a fixed number of weeks and the events inside it are bounded by what
 * happened in those weeks, not by the app's whole install base. One indexed range scan beats N/500
 * round trips, and the accumulator-outside-the-loop hazard those chunked reads carry cannot arise.
 *
 * ⚠️ Rows carrying no `shop_domain` are NOT filtered out here. The fold counts them
 * (`diagnostics.shopless_events`) and the service publishes that count — filtering them in the query
 * would make the exclusion invisible, and the spine's own `shopless_install_events` counter exists
 * because blank domains genuinely occur in this data.
 *
 * Served by `idx_app_type_occurred` = `{ partner_app_id, event_type, occurred_at }`.
 *
 * @param params0 - See {@link RelationshipEventQuery}.
 * @returns The rows, unsorted — the fold does not depend on order.
 */
const findRelationshipEvents = async ({
    partner_app_id,
    since,
    until
}: RelationshipEventQuery): Promise<RelationshipEventRow[]> => {
    return PartnerAppEventModel.find({
        partner_app_id: toObjectId(partner_app_id),
        event_type: { $in: STORE_RELATIONSHIP_EVENT_TYPES },
        occurred_at: { $gte: since, $lte: until }
    })
        // `raw_event` is deliberately NOT projected: nothing in the install-state fold reads it, and
        // it is the Mixed blob that makes an event document large. The four charge-cohort reads
        // project it because trial ends, plan names and the test flag live nowhere else; retention
        // needs none of those.
        .select('event_type shop_domain shop_id shop_name occurred_at')
        .lean();
};

export = {
    findRelationshipEvents
};
