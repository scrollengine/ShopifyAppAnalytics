'use strict';

/**
 * ============================================================================
 *  PARTNER APP — registration and reads
 * ============================================================================
 *
 *  The app row is the scoping root for every collection in this application.
 *  In a self-hosted deployment there is normally exactly one, and it is created
 *  from configuration rather than through a form: the operator sets
 *  SHOPIFY_PARTNER_APP_ID once and this service turns it into the row
 *  everything else hangs off.
 *
 *  ⚠️ THE APP ID CANNOT BE DISCOVERED. The Partner GraphQL API has no `apps`
 *  connection and no lookup by handle or API key — `app(id:)` is the only entry
 *  point — so there is no "list my apps and pick one" fallback to write. An
 *  unset or unrecognisable id fails here, with the message that tells the
 *  operator exactly which number to copy out of which URL, rather than becoming
 *  an INVALID_GID inside a 3am cron.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import partnerGidHelper = require('../../shared/helpers/partnerGid.helper');
import partnerAppPatchHelper = require('../helpers/partnerAppPatch.helper');
import partnerAppRecordResolver = require('../resolvers/partnerAppRecord.resolver');
import partnerAppRepository = require('../repositories/partnerApp.repository');

import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type { EmptyPayload } from '../types/partnerResult.types';
import type {
    GetPartnerAppByIdInput,
    ListPartnerAppsInput,
    PartnerAppEnvelope,
    PartnerAppListPayload,
    RegisterPartnerAppInput,
    SerializedPartnerApp
} from '../types/partnerApp.types';

const { customConsoleLog, customConsoleWarn, customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { normalizePartnerAppGid, PARTNER_APP_GID_HELP_MESSAGE } = partnerGidHelper;
//  THE ONE SERIALIZER, shared with the update and soft-delete services rather than copied. See
// `resolvers/partnerAppRecord.resolver` for what a second copy of it gets wrong.
const { serializePartnerApp: _serializeApp } = partnerAppRecordResolver;

const APP_ID_MISSING_MESSAGE = 'SHOPIFY_PARTNER_APP_ID is not set. It is the number after /apps/ in your Partner dashboard URL (https://partners.shopify.com/<org>/apps/<THIS>). The Partner API cannot look an app up by name or handle, so there is nothing to discover it from — set it in your .env and restart.';

const LISTING_URL_REFUSED_MESSAGE = 'listing_url must start with http:// or https://. The dashboard renders it as a link, and a value that is not a URL becomes a link that goes nowhere — or, with a script scheme, one that should never have been clickable.';

/**
 * True when a write failed because it collided with the unique index on `partner_api_app_id`.
 *
 * Read defensively — the driver's error is `unknown` in a catch, and only its numeric `code`
 * distinguishes a duplicate from any other write failure.
 *
 * @param error - Whatever was thrown.
 * @returns True for a duplicate-key error.
 */
const _isDuplicateKeyError = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') {
        return false;
    }
    if (!('code' in error)) {
        return false;
    }
    // Narrowed through `typeof` rather than asserted: the value in a catch is whatever was thrown,
    // and `as` casts are confined to the model chokepoint by house rule.
    const _code: unknown = error.code;
    return typeof _code === 'number' && _code === 11000;
};

/**
 * Registers the app named by `SHOPIFY_PARTNER_APP_ID`, or returns the one already registered.
 *
 * IDEMPOTENT: calling it twice is not an error. The second call finds the existing row and reports
 * `created: false`, which is what lets it be run unconditionally at boot or by a setup script.
 *
 * ── Why the defaults are what they are ──
 * The schema requires a handle, a display name and a listing URL, and configuration carries only an
 * app id. So the first two are placeholders derived from the id, and the third is the app's PARTNER
 * DASHBOARD URL — which is real, and derivable from `ORG_ID` + the app id.
 *
 *  It is deliberately NOT a guessed `apps.shopify.com/<handle>`. That URL is only correct if the
 * guessed handle is correct, and a wrong one does not 404 quietly — it points at somebody else's
 * app. Publishing a link to a competitor's listing as though it were yours is a worse failure than
 * showing a dashboard link, so the honest URL wins until the operator supplies the real one.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - Optional overrides for the three display fields.
 * @param [params1.app_handle] - The handle in `apps.shopify.com/<handle>`.
 * @param [params1.display_name] - Human name for the dashboard.
 * @param [params1.listing_url] - The public App Store listing URL.
 * @returns `{ app, created }` on success; `{}` with a message on failure.
 */
const registerPartnerAppFromConfig = ({ user_id }: IdentityObject, { app_handle, display_name, listing_url }: RegisterPartnerAppInput): Promise<ServiceResult<PartnerAppEnvelope | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }

            const _configuredAppId = config.PARTNER.APP_ID;
            if (!_configuredAppId) {
                return resolve(promiseReturnResult(false, {}, {}, APP_ID_MISSING_MESSAGE));
            }

            // Canonicalise BEFORE persisting. The Partner API cannot look an app up by handle or
            // API key, so an unrecognisable id can never be recovered later — reject it here rather
            // than storing a value whose only possible outcome is an INVALID_GID inside a cron.
            const _partnerAppGid = normalizePartnerAppGid(_configuredAppId);
            if (!_partnerAppGid) {
                return resolve(promiseReturnResult(false, {}, {}, PARTNER_APP_GID_HELP_MESSAGE));
            }

            const _existing = await partnerAppRepository.findPartnerAppByGid(_partnerAppGid);
            if (_existing) {
                return resolve(promiseReturnResult(true, { app: _serializeApp(_existing), created: false }, {}, 'Partner app is already registered.'));
            }

            // A second row is LEGITIMATE — a partner organisation can publish several apps, and the
            // cron fans out over every active one. It is also what a typo in SHOPIFY_PARTNER_APP_ID
            // looks like, and that failure is silent: the new app syncs nothing, and a dashboard
            // pointed at it reports a business with no history rather than an error. So it is
            // allowed and announced, never blocked.
            const _existingApps = await partnerAppRepository.listPartnerApps({});
            if (_existingApps.length > 0) {
                customConsoleWarn('WARN: [Partner:App] Registering an ADDITIONAL partner app', {
                    new_partner_api_app_id: _partnerAppGid,
                    already_registered: _existingApps.map((app) => app.partner_api_app_id)
                });
            }

            const _numericAppId = _partnerAppGid.split('/').pop() || '';

            let _displayName = `Shopify app ${_numericAppId}`;
            if (typeof display_name === 'string' && display_name.trim()) {
                _displayName = display_name.trim();
            }
            let _appHandle = `app-${_numericAppId}`;
            if (typeof app_handle === 'string' && app_handle.trim()) {
                _appHandle = app_handle.trim();
            }
            // Same check the PATCH path applies, through the same function rather than a second
            // copy of the pattern. The value is rendered as an anchor href by the Apps page and the
            // store drawer, and React 18's open-source build does not sanitise `javascript:` hrefs.
            let _listingUrl = `https://partners.shopify.com/${config.PARTNER.ORG_ID}/apps/${_numericAppId}`;
            if (typeof listing_url === 'string' && listing_url.trim()) {
                const _candidate = listing_url.trim();
                if (!partnerAppPatchHelper.isRenderableUrl(_candidate)) {
                    return resolve(promiseReturnResult(false, {}, {}, LISTING_URL_REFUSED_MESSAGE));
                }
                _listingUrl = _candidate;
            }

            const _created = await partnerAppRepository.createPartnerApp({
                app_handle: _appHandle,
                display_name: _displayName,
                listing_url: _listingUrl,
                partner_api_app_id: _partnerAppGid
            });

            customConsoleLog('INFO: [Partner:App] Registered partner app', {
                partner_app_id: String(_created._id),
                partner_api_app_id: _partnerAppGid
            });

            return resolve(promiseReturnResult(true, { app: _serializeApp(_created), created: true }, {}, 'Partner app registered.'));
        } catch (error) {
            if (_isDuplicateKeyError(error)) {
                // Lost a race with another boot or another operator. The unique index did its job;
                // the outcome the caller wanted is nevertheless true.
                return resolve(promiseReturnResult(false, {}, error, 'That partner app is already registered. Run the call again to read it.'));
            }
            customConsoleError('ERROR: [Partner:App] registerPartnerAppFromConfig threw', error);
            return resolve(promiseReturnResult(false, {}, error, 'Failed to register the partner app.'));
        }
    });
};

/**
 * Lists registered apps, newest first.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The filter.
 * @param [params1.is_active] - Omitted lists every app, active or not.
 * @returns `{ items, total }` on success; `{}` with a message on failure.
 */
const listPartnerApps = ({ user_id }: IdentityObject, { is_active }: ListPartnerAppsInput): Promise<ServiceResult<PartnerAppListPayload | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }

            let _isActive: boolean | undefined;
            if (typeof is_active === 'boolean') {
                _isActive = is_active;
            }

            const _docs = await partnerAppRepository.listPartnerApps({ is_active: _isActive });
            const _items: SerializedPartnerApp[] = [];
            for (const doc of _docs) {
                const _serialized = _serializeApp(doc);
                if (_serialized) {
                    _items.push(_serialized);
                }
            }

            return resolve(promiseReturnResult(true, { items: _items, total: _items.length }, {}, 'Partner apps listed.'));
        } catch (error) {
            customConsoleError('ERROR: [Partner:App] listPartnerApps threw', error);
            return resolve(promiseReturnResult(false, {}, error, 'Failed to list partner apps.'));
        }
    });
};

/**
 * Reads one app by its Mongo `_id`.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The lookup.
 * @param params1.partner_app_id - The `_id` of the app row.
 * @returns `{ app }` on success; `{}` with a message on failure.
 */
const getPartnerAppById = ({ user_id }: IdentityObject, { partner_app_id }: GetPartnerAppByIdInput): Promise<ServiceResult<PartnerAppEnvelope | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'partner_app_id is required.'));
            }

            const _doc = await partnerAppRepository.findPartnerAppById(partner_app_id);
            if (!_doc) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }
            return resolve(promiseReturnResult(true, { app: _serializeApp(_doc) }, {}, 'Partner app fetched.'));
        } catch (error) {
            customConsoleError('ERROR: [Partner:App] getPartnerAppById threw', error);
            return resolve(promiseReturnResult(false, {}, error, 'Failed to fetch the partner app.'));
        }
    });
};

export = {
    registerPartnerAppFromConfig,
    listPartnerApps,
    getPartnerAppById
};
