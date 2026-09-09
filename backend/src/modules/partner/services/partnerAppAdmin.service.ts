'use strict';

/**
 * ============================================================================
 *  EDITING AND RETIRING AN APP ROW
 * ============================================================================
 *
 *  Serves `PATCH /api/partner-apps/:partner_app_id` and
 *  `DELETE /api/partner-apps/:partner_app_id`. Two writes, and both of them are
 *  mostly about what they REFUSE.
 *
 *  ──  1. `update` CANNOT CHANGE WHICH APP THIS IS ─────────────────────────
 *
 *  Every collection in this build is keyed by `partner_app_id` — the app row's
 *  `_id`, which no request can change. `partner_api_app_id` is a different
 *  field: it says WHICH Shopify app those millions of rows were pulled from.
 *  Editing it therefore does not move any data; it relabels all of it. Every
 *  install count, MRR figure and cohort on the dashboard would silently start
 *  claiming to describe an app that never earned them, and the next sync would
 *  append the new app's history to the old app's facts in one undifferentiated
 *  pile. Nothing on an event row records which app id it was fetched under, so
 *  there is no repair and no way to detect it afterwards.
 *
 *  So the field is REFUSED, and so is every sync watermark and every coverage
 *  gate — those are MEASUREMENTS written by the end of a successful sync, and
 *  an endpoint that let one be typed in would let an operator switch the
 *  honesty layer off by hand. `constants/partnerAppAdmin.constants` carries the
 *  list and the sentence each refusal explains itself with.
 *
 *  ──  2. `softDelete` DEACTIVATES; IT DOES NOT DELETE ─────────────────────
 *
 *  The question this endpoint had to answer is what "delete an app" means when
 *  several million event and payout rows point at it. Both deleting answers are
 *  wrong, and they are wrong in different ways:
 *
 *    A CASCADING delete destroys the entire factual basis of every figure this
 *    deployment has ever published — irreversibly, from one HTTP verb, over
 *    data that can only be re-fetched from an API with a rate budget and a
 *    history Shopify may no longer serve.
 *
 *    A NON-CASCADING delete is worse. It leaves those rows behind an id that
 *    resolves to nothing, so every read returns an empty result set — and an
 *    empty result set is indistinguishable from a business with no customers.
 *    That is precisely the failure this project exists to refuse: not a crash,
 *    a plausible wrong answer.
 *
 *  So the endpoint refuses what it cannot honestly do. It sets `is_active:
 *  false`, which has a real and checkable meaning already wired through this
 *  build: `syncJob.repository.findActivePartnerAppIds` stops fanning out to the
 *  app, and all three sync services refuse it with "Partner app is inactive".
 *  Nothing is removed, the response says how many rows were retained, and
 *  `PATCH { "is_active": true }` puts it back. A soft delete whose reversal is
 *  undocumented is a hard delete with extra steps, so the reversal travels on
 *  the payload.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import partnerGidHelper = require('../../shared/helpers/partnerGid.helper');
import adminConstants = require('../constants/partnerAppAdmin.constants');
import partnerAppPatchHelper = require('../helpers/partnerAppPatch.helper');
import partnerAppRecordResolver = require('../resolvers/partnerAppRecord.resolver');
import partnerAppRepository = require('../repositories/partnerApp.repository');
import partnerAppReadRepository = require('../repositories/partnerAppRead.repository');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type {
    DeactivatePartnerAppInput,
    DeactivatePartnerAppPayload,
    PartnerAppPatchSet,
    UpdatePartnerAppInput,
    UpdatePartnerAppPayload
} from '../types/partnerAppAdmin.types';

const { customConsoleLog, customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { normalizePartnerAppGid } = partnerGidHelper;
const { SOFT_DELETE_SEMANTICS, HARD_DELETE_REFUSAL } = adminConstants;
const { buildPartnerAppPatch } = partnerAppPatchHelper;
//  THE ONE SERIALIZER, shared with the register/list/read service rather than copied.
const { serializePartnerApp } = partnerAppRecordResolver;

/** How to undo a soft delete. Published on the payload — see the file header. */
const REVERSAL_INSTRUCTION = 'PATCH /api/partner-apps/:app_id with { "is_active": true } reactivates this '
    + 'app. Nothing was removed, so nothing has to be re-fetched: the sync cron picks it up again on its '
    + 'next pass and every stored figure is exactly where it was.';

/**
 * ⚠️ THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE. A duplicate is
 * dropped by the frontend rather than drawn twice, and its condition disappears with it.
 */
const _WARNINGS = Object.freeze({
    deactivatingConfiguredApp: 'This is the app named by SHOPIFY_PARTNER_APP_ID in the backend\'s .env. '
        + 'Registering at boot will NOT reactivate it — registration is idempotent and finds the existing row '
        + 'without touching `is_active` — so the dashboard will keep reporting on an app nothing is syncing '
        + 'until it is reactivated or the environment variable is pointed elsewhere.',

    deactivatingLastActiveApp: 'This was the only active app on this deployment. Every page in the '
        + 'Performance suite is scoped by an app selection, and with none active the picker has nothing to '
        + 'offer — the dashboard will read as an install that has never been set up. The data is untouched; '
        + 'reactivate the app to get it back.',

    alreadyInactive: 'This app was already deactivated, so nothing changed. The call is idempotent rather '
        + 'than an error — a retried request should not fail because the first one succeeded.',

    syncsWillRefuse: 'While this app is deactivated the sync cron skips it and every sync trigger refuses '
        + 'it with "Partner app is inactive". Its stored history stays readable: the KPI, event, revenue and '
        + 'store endpoints all still answer for it, they simply stop receiving anything new.',

    nothingChanged: 'Every submitted value already matched the stored row, so no write was issued. The '
        + 'response is the row as it stands, which is also the row that was sent.',

    handleChanged: 'app_handle is display metadata on this deployment only. It does not re-point anything: '
        + 'the Partner API cannot look an app up by handle, so nothing is fetched with this value and no '
        + 'stored figure depends on it.'
});

/**
 * Collects warnings while guaranteeing the strings are unique.
 *
 * @returns `{ push, list }`.
 */
const _warningCollector = () => {
    const seen = new Set<string>();
    const list: string[] = [];
    return {
        push: (message: string): void => {
            if (!message || seen.has(message)) {
                return;
            }
            seen.add(message);
            list.push(message);
        },
        list
    };
};

/**
 * True when a submitted value differs from what the row already holds.
 *
 * Arrays are compared by their ORDERED contents, because order is meaningful on `categories` and
 * `target_keywords` — a reordered list is a real edit, not a no-op — and because a length-only or
 * set-only comparison would report "nothing changed" over a write that did change something.
 *
 * @param next - The submitted value.
 * @param current - What the stored document holds.
 * @returns True when the write would change the row.
 */
const _isDifferent = (next: unknown, current: unknown): boolean => {
    if (Array.isArray(next)) {
        const before = Array.isArray(current) ? current : [];
        if (before.length !== next.length) {
            return true;
        }
        for (let i = 0; i < next.length; i += 1) {
            if (String(before[i]) !== String(next[i])) {
                return true;
            }
        }
        return false;
    }
    return next !== current;
};

/**
 * Updates one app row's display metadata.
 *
 *  ALL OR NOTHING. A body containing any refused field fails the whole call and writes nothing.
 * A partial apply would leave the caller unable to say which of the fields they sent took effect,
 * and a form that posts an app id, receives a 200 and shows the old value back is the exact failure
 * `frontend/API_Services/growth-intel/partnerAppService.js` documents in its own header.
 *
 * ⚠️ THE REFUSAL IS A `status: false`, WHICH THE CONTROLLER TURNS INTO A 400. It is not a warning on
 * a successful response: a caller that ignores warnings — which is most callers — would read a 200
 * as "saved" over a field this endpoint will never store.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The write. See {@link UpdatePartnerAppInput}.
 * @param params1.partner_app_id - The app to update.
 * @param params1.patch - The raw request body. Anything at all may be in it.
 * @returns `{ app, updated_fields, changed, warnings }` on success; `{}` with the refusal on failure.
 */
const updatePartnerApp = (
    { user_id }: IdentityObject,
    { partner_app_id, patch }: UpdatePartnerAppInput
): Promise<ServiceResult<UpdatePartnerAppPayload | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'partner_app_id is required. It goes in the URL: PATCH /api/partner-apps/:app_id.'));
            }

            const validated = buildPartnerAppPatch(patch || {});

            //  REFUSALS FIRST, BEFORE THE ROW IS EVEN LOOKED UP. A body that tries to repoint the
            // app must fail identically whether or not the app exists — answering "not found" for an
            // id that does exist, or "field refused" only for ids that do, would let a caller probe
            // which app ids are real.
            if (validated.refused.length > 0) {
                const _fields = validated.refused.map((entry) => entry.field).join(', ');
                const _explanations = validated.refused.map((entry) => `${entry.field}: ${entry.reason}`).join(' ');
                return resolve(promiseReturnResult(
                    false,
                    {},
                    { code: 'PARTNER_APP_FIELD_REFUSED', refused: validated.refused },
                    `This endpoint will not write ${_fields}, so nothing was saved. ${_explanations}`
                ));
            }

            const _setKeys = Object.keys(validated.set);
            if (_setKeys.length === 0) {
                return resolve(promiseReturnResult(
                    false,
                    {},
                    { code: 'PARTNER_APP_NOTHING_TO_UPDATE', ignored: validated.ignored },
                    'Nothing in the body can be written by this endpoint. It stores display_name, app_handle, listing_url, categories, target_keywords and is_active; everything else about this app comes from the environment or from a sync.'
                ));
            }

            const existing: PartnerAppDoc | null = await partnerAppRepository.findPartnerAppById(String(partner_app_id));
            if (!existing) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }

            const warnings = _warningCollector();
            for (const message of validated.warnings) {
                warnings.push(message);
            }

            const updatedFields: string[] = [];
            for (const key of _setKeys) {
                const _field = key as keyof PartnerAppPatchSet;
                if (_isDifferent(validated.set[_field], (existing as Record<string, any>)[key])) {
                    updatedFields.push(key);
                }
            }

            if (updatedFields.length === 0) {
                //  NO WRITE ISSUED. Resubmitting an unchanged form is the commonest PATCH there
                // is, and a `$set` that changes nothing still bumps `updatedAt` — which is the
                // timestamp an operator reads to answer "when did this last change".
                warnings.push(_WARNINGS.nothingChanged);
                return resolve(promiseReturnResult(true, {
                    app: serializePartnerApp(existing),
                    updated_fields: [],
                    changed: false,
                    warnings: warnings.list
                }, {}, 'Nothing to update — every submitted value already matched the stored row.'));
            }

            const updated = await partnerAppRepository.updatePartnerAppFields({
                partner_app_id: String(existing._id),
                set: validated.set
            });
            if (!updated) {
                // The row was removed between the read and the write. Reported rather than retried:
                // a retry would recreate nothing, and a success message over a row that no longer
                // exists is the one answer this endpoint must not give.
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app not found — it was removed while the update was in flight.'));
            }

            if (updatedFields.indexOf('app_handle') !== -1) {
                warnings.push(_WARNINGS.handleChanged);
            }
            if (updatedFields.indexOf('is_active') !== -1 && validated.set.is_active === false) {
                warnings.push(_WARNINGS.syncsWillRefuse);
            }

            customConsoleLog('INFO: [Partner:App] Updated partner app', {
                partner_app_id: String(updated._id),
                updated_fields: updatedFields
            });

            return resolve(promiseReturnResult(true, {
                app: serializePartnerApp(updated),
                updated_fields: updatedFields,
                changed: true,
                warnings: warnings.list
            }, {}, 'Partner app updated.'));
        } catch (error) {
            customConsoleError('ERROR: [Partner:App] updatePartnerApp threw', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not update the partner app.'));
        }
    });
};

/**
 * Deactivates one app row, preserving every fact that points at it.
 *
 *  THERE IS NO HARD DELETE, AND THE PAYLOAD SAYS SO. See the file header for why both deleting
 * answers are wrong. `deleted` is always `false` and `hard_delete` carries the refusal, so a caller
 * reading only the response — not this file — still learns what did and did not happen.
 *
 * IDEMPOTENT: deactivating an already-inactive app succeeds with `changed: false`. A retried request
 * must not fail because the first one worked.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The target. See {@link DeactivatePartnerAppInput}.
 * @param params1.partner_app_id - The app to deactivate.
 * @returns The payload on success; `{}` with a message on failure.
 */
const deactivatePartnerApp = (
    { user_id }: IdentityObject,
    { partner_app_id }: DeactivatePartnerAppInput
): Promise<ServiceResult<DeactivatePartnerAppPayload | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'partner_app_id is required. It goes in the URL: DELETE /api/partner-apps/:app_id.'));
            }

            const existing: PartnerAppDoc | null = await partnerAppRepository.findPartnerAppById(String(partner_app_id));
            if (!existing) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }

            const appId = String(existing._id);
            const warnings = _warningCollector();

            //  THE PROOF, not a claim. An operator who sends DELETE and receives 200 has every
            // reason to assume rows went away; these counts are what the response uses to say none
            // did. They are read BEFORE the flag is flipped and AFTER it — same numbers either way,
            // because nothing here touches those collections — so reading them once is enough.
            const retained = await partnerAppReadRepository.countAppScopedRows({ partner_app_id: appId });

            // Is this the app the environment names? Compared through the canonical GID rather than
            // by string equality: the env may hold a bare numeric id, a dashboard URL or either GID
            // namespace, while the row always holds the canonical form, so a raw compare would miss.
            const configuredGid = normalizePartnerAppGid(config.PARTNER.APP_ID);
            if (configuredGid && configuredGid === existing.partner_api_app_id) {
                warnings.push(_WARNINGS.deactivatingConfiguredApp);
            }

            if (!existing.is_active) {
                warnings.push(_WARNINGS.alreadyInactive);
                warnings.push(_WARNINGS.syncsWillRefuse);
                return resolve(promiseReturnResult(true, {
                    app: serializePartnerApp(existing),
                    deleted: false,
                    changed: false,
                    semantics: SOFT_DELETE_SEMANTICS,
                    hard_delete: HARD_DELETE_REFUSAL,
                    reversal: REVERSAL_INSTRUCTION,
                    retained,
                    warnings: warnings.list
                }, {}, 'Partner app was already deactivated. Nothing changed and nothing was deleted.'));
            }

            const activeApps = await partnerAppRepository.listPartnerApps({ is_active: true });
            const otherActive = activeApps.filter((row) => String(row._id) !== appId);
            if (otherActive.length === 0) {
                warnings.push(_WARNINGS.deactivatingLastActiveApp);
            }

            const updated = await partnerAppRepository.updatePartnerAppFields({
                partner_app_id: appId,
                set: { is_active: false }
            });
            if (!updated) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app not found — it was removed while the deactivation was in flight.'));
            }

            warnings.push(_WARNINGS.syncsWillRefuse);

            customConsoleLog('INFO: [Partner:App] Deactivated partner app', {
                partner_app_id: appId,
                partner_api_app_id: updated.partner_api_app_id,
                retained_event_rows: retained.event_rows,
                retained_transaction_rows: retained.transaction_rows
            });

            return resolve(promiseReturnResult(true, {
                app: serializePartnerApp(updated),
                deleted: false,
                changed: true,
                semantics: SOFT_DELETE_SEMANTICS,
                hard_delete: HARD_DELETE_REFUSAL,
                reversal: REVERSAL_INSTRUCTION,
                retained,
                warnings: warnings.list
            }, {}, `Partner app deactivated. Nothing was deleted — ${retained.event_rows} event row(s) and ${retained.transaction_rows} payout row(s) still reference it.`));
        } catch (error) {
            customConsoleError('ERROR: [Partner:App] deactivatePartnerApp threw', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not deactivate the partner app.'));
        }
    });
};

export = {
    updatePartnerApp,
    deactivatePartnerApp
};
