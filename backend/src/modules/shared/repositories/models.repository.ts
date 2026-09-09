/**
 * THE model chokepoint — the only file in the codebase that may import `src/models`.
 *
 *  Nothing else requires the model registry. Not a service, not a controller, not a helper, not a
 * test fixture. Two things depend on that being literally true:
 *
 *   1. TYPES. The registry is a plain runtime object, so requiring it anywhere yields `any` and
 *      every downstream `.find()`, `.lean()` and `.findOneAndUpdate()` silently loses its typing —
 *      including the shape of what comes back, which is how a renamed field becomes a column of
 *      `undefined` instead of a compile error. Casting ONCE here buys mongoose's own generics across
 *      the whole codebase without writing a `.d.ts` for the registry.
 *   2. LAYERING. `repositories/` is the only role folder allowed to touch models at all; `helpers/`
 *      is pure and `services/` goes through a repository. That rule is only checkable because the
 *      import has exactly one legal location — `grep -rn "models" src --include=*.ts` returns this
 *      file or a violation, with nothing to argue about.
 *
 * RULE: `as` casts appear in THIS FILE and in `as const` only. A cast anywhere else in `src/modules/`
 * is a finding, because it means an `any` escaped containment.
 *
 * ⚠️ A model is published here ONLY once its schema file exists and `src/models/index.ts` exports
 * it. The registry comes in through a bare `require`, so a name that is not in it destructures to
 * `undefined` and TypeScript sees nothing wrong — the cast below happily types `undefined` as a
 * `Model<T>`, and the failure surfaces as `Cannot read properties of undefined (reading 'find')` on
 * whichever request first touches it. The four `Listing*` handles were once published exactly that
 * way — typed, enumerated, and `undefined` at run time — and were removed until their schemas
 * existed. They are back now because `src/models/listing/` and the registry entries are real;
 * `test/exportSurface.test.js` asserts no published key is `undefined`, which is what caught them
 * the first time and is what proves them now.
 *
 * Adding a model: add its document type to `../types/entity.types`, cast it here, and enumerate it
 * in the export object below. A model that is not re-exported here cannot be reached by anything,
 * which is the intended failure mode — it fails at the import, loudly, rather than by being quietly
 * required from somewhere it should not be.
 *
 * Usage:
 *
 *     import models = require('../../shared/repositories/models.repository');
 *     const events = await models.PartnerAppEventModel.find({ partner_app_id }).lean();
 */

import mongoose = require('mongoose');
import type {
    PartnerAppDoc,
    PartnerAppEventDoc,
    PartnerAppTransactionDoc,
    ListingFunnelDailyDoc,
    ListingSourceDailyDoc,
    ListingGeoDailyDoc,
    ListingInstallAttributionDoc,
    SyncJobDoc,
    AdminUserDoc
} from '../types/entity.types';

/*
 * Deliberately a bare `require` rather than an `import`: the registry is consumed for its runtime
 * shape and every document type it carries is declared in `../types/entity.types` instead. The
 * casts below are what attach the two, and they are the reason this file exists.
 */
const {
    PartnerApp,
    PartnerAppEvent,
    PartnerAppTransaction,
    ListingFunnelDaily,
    ListingSourceDaily,
    ListingGeoDaily,
    ListingInstallAttribution,
    SyncJob,
    AdminUser
} = require('../../../models');

const PartnerAppModel = PartnerApp as mongoose.Model<PartnerAppDoc>;
const PartnerAppEventModel = PartnerAppEvent as mongoose.Model<PartnerAppEventDoc>;
const PartnerAppTransactionModel = PartnerAppTransaction as mongoose.Model<PartnerAppTransactionDoc>;
const ListingFunnelDailyModel = ListingFunnelDaily as mongoose.Model<ListingFunnelDailyDoc>;
const ListingSourceDailyModel = ListingSourceDaily as mongoose.Model<ListingSourceDailyDoc>;
const ListingGeoDailyModel = ListingGeoDaily as mongoose.Model<ListingGeoDailyDoc>;
const ListingInstallAttributionModel =
    ListingInstallAttribution as mongoose.Model<ListingInstallAttributionDoc>;
const SyncJobModel = SyncJob as mongoose.Model<SyncJobDoc>;
const AdminUserModel = AdminUser as mongoose.Model<AdminUserDoc>;

/**
 * Casts a string id to an ObjectId.
 *
 *  Required for every `$match` in an AGGREGATE. Unlike `find`/`findOne`, aggregate does NOT
 * auto-cast — an uncast string id matches ZERO documents and raises no error, so the query simply
 * returns `[]` and the page renders as if the business had no data. That is the exact failure this
 * project exists to refuse: not a crash, a plausible empty answer.
 *
 * Throws on an unparseable id rather than returning something that would match nothing. A loud
 * failure inside a service's try/catch becomes an error response; a silent one becomes a wrong
 * number on a dashboard.
 *
 * @param id - An ObjectId, its string form, or anything stringifiable.
 * @returns The id as an ObjectId.
 */
const toObjectId = (id: unknown): mongoose.Types.ObjectId => {
    return new mongoose.Types.ObjectId(String(id));
};

export = {
    PartnerAppModel,
    PartnerAppEventModel,
    PartnerAppTransactionModel,
    ListingFunnelDailyModel,
    ListingSourceDailyModel,
    ListingGeoDailyModel,
    ListingInstallAttributionModel,
    SyncJobModel,
    AdminUserModel,
    toObjectId
};
