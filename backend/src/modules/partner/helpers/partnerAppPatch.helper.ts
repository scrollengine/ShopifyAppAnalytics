'use strict';

/**
 * ============================================================================
 *  VALIDATING A WRITE TO THE APP ROW
 * ============================================================================
 *
 *  PURE. No models, no repositories, no config, no clock. It takes the raw
 *  request body and answers with a `$set` document, the fields it refused, and
 *  the fields it did not recognise. Nothing here reads or writes anything, which
 *  is what lets every refusal below be exercised against a plain object with no
 *  database.
 *
 *  ──  REFUSING IS NOT THE SAME AS IGNORING, AND THE DIFFERENCE IS THE POINT ─
 *
 *  Three outcomes, deliberately three and not two:
 *
 *    SET      — an editable field with a usable value.
 *    REFUSED  — an identity, watermark or coverage field, or an editable field
 *               whose value cannot be stored. ANY refusal fails the WHOLE call.
 *    IGNORED  — a key this endpoint has never heard of. Warned about, not fatal.
 *
 *  A partial apply is the one outcome that is never offered. `PartnerAppForm`
 *  on the frontend posts seven fields, of which this backend can store three,
 *  and the page's own header records what happens when a form "posts one id,
 *  receives another, and reports created" — the operator has no way to learn
 *  which half of their save took effect. So a body containing
 *  `partner_api_app_id` fails outright, naming the field and saying where the
 *  value actually comes from, rather than quietly writing the display name and
 *  returning 200 over an unchanged app id.
 *
 *  ── WHY A WRITE FAILS CLOSED WHERE A FILTER FAILS OPEN ─────────────────────
 *
 *  The house rule for FILTERS is that an unrecognised value must WIDEN the
 *  result rather than empty it: a table showing zero rows because of a typo in
 *  a query string is indistinguishable from a business with no customers. The
 *  rule for WRITES is the reverse, for the same underlying reason — a write
 *  that silently does something other than what was asked is indistinguishable
 *  from one that did what was asked. Read: be generous. Write: be exact.
 * ============================================================================
 */

import constants = require('../constants/partnerAppAdmin.constants');

import type {
    PartnerAppPatchInput,
    PartnerAppPatchResult,
    PartnerAppPatchSet,
    RefusedPatchField
} from '../types/partnerAppAdmin.types';

const {
    PARTNER_APP_EDITABLE_FIELDS,
    PARTNER_APP_REFUSED_FIELDS,
    MAX_TEXT_FIELD_LENGTH,
    MAX_LIST_FIELD_ENTRIES
} = constants;

/** The three text fields, and whether each must look like a URL. */
const _TEXT_FIELDS: Readonly<Record<string, { label: string; requiresUrl: boolean }>> = Object.freeze({
    display_name: { label: 'display_name', requiresUrl: false },
    app_handle: { label: 'app_handle', requiresUrl: false },
    listing_url: { label: 'listing_url', requiresUrl: true }
});

/** The two list fields. Both are plain string lists on the schema, defaulted to `[]`. */
const _LIST_FIELDS: readonly string[] = Object.freeze(['categories', 'target_keywords']);

/**
 * `http://` or `https://` and nothing else.
 *
 * ⚠️ FAIL-CLOSED, unlike every FILTER in this codebase. `pages/apps/index.js` renders
 * this value through Polaris' `<Link url=…>`, so a value that is not a URL becomes a link that goes
 * nowhere — and a broken link on the one field that points at the operator's own listing reads as a
 * broken dashboard. A refusal names the problem; a stored `apps.shopify.com/foo` does not.
 */
const _URL_PATTERN = /^https?:\/\/\S+$/i;

/**
 * Whether a string is safe to render as an anchor href.
 *
 * Exported rather than kept private because there are TWO write paths for `listing_url` — the PATCH
 * below and `registerPartnerAppFromConfig` in the service — and for a while only this one checked.
 * The other accepted any non-empty string, which reaches `<Link url={...}>` and becomes a live
 * `href`. React 18's open-source build does not sanitise `javascript:` hrefs, so an unchecked value
 * there is a script the operator can click.
 *
 * A scheme allowlist rather than a `javascript:` denylist: `JavaScript:`, `java\tscript:` and a
 * `data:text/html` payload all defeat a denylist, and only `http`/`https` is ever a real listing.
 *
 * @param value - An already-trimmed candidate.
 * @returns True when the value may be rendered as a link.
 */
const isRenderableUrl = (value: string): boolean => {
    return typeof value === 'string' && _URL_PATTERN.test(value);
};

/**
 * A trimmed string, or `null` when the value is not a string at all.
 *
 * `typeof` rather than `String(value)`: coercing would turn `{}` into `"[object Object]"` and store
 * it as a display name, which is a write nobody asked for wearing a valid-looking value.
 *
 * @param value - The raw value off the request body.
 * @returns The trimmed string, or null when it was not a string.
 */
const _asTrimmedString = (value: unknown): string | null => {
    if (typeof value !== 'string') {
        return null;
    }
    return value.trim();
};

/**
 * Turns a raw body into a validated `$set`, a refusal list and an ignore list.
 *
 * ONE PASS over the body's own keys. Every key lands in exactly one of the three outcomes, so a
 * field can never be both written and reported as refused.
 *
 * ⚠️ A REFUSED FIELD IS REFUSED WHATEVER ITS VALUE. `{ "partner_api_app_id": "<the same id it
 * already holds>" }` still fails: honouring a no-op write of an identity field would mean the
 * endpoint's behaviour depended on data the caller cannot see, and the next call — with a different
 * id — would be the one that repoints every stored figure.
 *
 * @param input - The raw request body. Anything at all may be in it.
 * @returns `{ set, refused, ignored, warnings }`. `refused` non-empty ⇒ the caller must fail the whole call.
 */
const buildPartnerAppPatch = (input: PartnerAppPatchInput): PartnerAppPatchResult => {
    const set: PartnerAppPatchSet = {};
    const refused: RefusedPatchField[] = [];
    const ignored: string[] = [];
    const warnings: string[] = [];

    const body = input && typeof input === 'object' ? input : {};

    for (const field of Object.keys(body)) {
        const value = body[field];

        // ── 1. Identity, watermarks and coverage gates ─────────────────────
        //  `Object.hasOwn`, NEVER A BARE LOOKUP. A frozen object literal still inherits
        // `Object.prototype`, so `PARTNER_APP_REFUSED_FIELDS['toString']` resolves to a FUNCTION —
        // truthy. `PATCH { "toString": "x" }` therefore refused the call (fail-closed, so nothing
        // unsafe was ever written) but pushed a function as the `reason`: it serialises to
        // `undefined` in JSON, and the 400 message interpolated `function toString() { [native
        // code] }`. The guard that was supposed to explain the refusal produced the least
        // explanatory 400 in the codebase. `funnelMath.helper` already uses `Object.hasOwn` for
        // exactly this class of bug.
        const isRefusedField = Object.hasOwn(PARTNER_APP_REFUSED_FIELDS, field);
        const refusalReason = isRefusedField ? PARTNER_APP_REFUSED_FIELDS[field] : '';
        if (isRefusedField) {
            refused.push({ field, reason: refusalReason });
            continue;
        }

        // ── 2. Keys this endpoint has never heard of ───────────────────────
        if (PARTNER_APP_EDITABLE_FIELDS.indexOf(field) === -1) {
            ignored.push(field);
            continue;
        }

        // ── 3. The six editable fields ─────────────────────────────────────
        const textField = _TEXT_FIELDS[field];
        if (textField) {
            const trimmed = _asTrimmedString(value);
            if (trimmed === null) {
                refused.push({
                    field,
                    reason: `${field} must be a string. It was sent as ${typeof value}, and storing a coerced value would put something nobody typed on the app row.`
                });
                continue;
            }
            if (trimmed === '') {
                refused.push({
                    field,
                    reason: `${field} is required on the app row and cannot be cleared. Send a value, or leave the field out of the body entirely to keep the stored one.`
                });
                continue;
            }
            if (trimmed.length > MAX_TEXT_FIELD_LENGTH) {
                refused.push({
                    field,
                    reason: `${field} is longer than ${MAX_TEXT_FIELD_LENGTH} characters. Nothing on the dashboard renders a value that long, and truncating it silently would store something other than what was sent.`
                });
                continue;
            }
            if (textField.requiresUrl && !isRenderableUrl(trimmed)) {
                refused.push({
                    field,
                    reason: 'listing_url must start with http:// or https://. The dashboard renders it as a link, and a value that is not a URL becomes a link that goes nowhere.'
                });
                continue;
            }
            if (typeof value === 'string' && value !== trimmed) {
                warnings.push(`Surrounding whitespace was trimmed from ${field} before it was stored.`);
            }
            set[field as 'display_name' | 'app_handle' | 'listing_url'] = trimmed;
            continue;
        }

        if (_LIST_FIELDS.indexOf(field) !== -1) {
            if (!Array.isArray(value)) {
                refused.push({
                    field,
                    reason: `${field} must be an array of strings. A comma-separated string would be stored as one entry containing commas, which is not what a list of categories or keywords means.`
                });
                continue;
            }

            const seen = new Set<string>();
            const cleaned: string[] = [];
            let droppedBlanks = 0;
            let droppedDuplicates = 0;
            let nonString = false;
            for (const entry of value) {
                const trimmed = _asTrimmedString(entry);
                if (trimmed === null) {
                    nonString = true;
                    break;
                }
                if (trimmed === '') {
                    droppedBlanks += 1;
                    continue;
                }
                if (seen.has(trimmed)) {
                    droppedDuplicates += 1;
                    continue;
                }
                seen.add(trimmed);
                cleaned.push(trimmed);
            }
            if (nonString) {
                refused.push({
                    field,
                    reason: `Every entry in ${field} must be a string.`
                });
                continue;
            }
            if (cleaned.length > MAX_LIST_FIELD_ENTRIES) {
                //  REFUSED RATHER THAN TRUNCATED. Silently keeping the first 50 of 80 keywords
                // returns 200 over a list that is not the one that was sent, and the caller has no
                // way to notice.
                refused.push({
                    field,
                    reason: `${field} holds more than ${MAX_LIST_FIELD_ENTRIES} entries. It is refused rather than truncated: storing the first ${MAX_LIST_FIELD_ENTRIES} and answering 200 would report success over a list nobody sent.`
                });
                continue;
            }
            if (droppedBlanks > 0) {
                warnings.push(`${droppedBlanks} blank entr${droppedBlanks === 1 ? 'y was' : 'ies were'} dropped from ${field}.`);
            }
            if (droppedDuplicates > 0) {
                warnings.push(`${droppedDuplicates} duplicate entr${droppedDuplicates === 1 ? 'y was' : 'ies were'} dropped from ${field}.`);
            }
            set[field as 'categories' | 'target_keywords'] = cleaned;
            continue;
        }

        // `is_active` — the only remaining editable field.
        if (typeof value !== 'boolean') {
            refused.push({
                field,
                reason: 'is_active must be a JSON boolean (true or false). The string "false" is truthy in JavaScript, so accepting one would deactivate an app that was asked to stay active — or the reverse.'
            });
            continue;
        }
        set.is_active = value;
    }

    if (ignored.length > 0) {
        //  ONE warning naming every unrecognised key, not one per key. The strings have to be
        // unique — the frontend keys them by content — and "field X is not recognised" repeated
        // five times would collapse into one line with four fields silently missing from it.
        warnings.push(`These fields are not stored by this endpoint and were ignored: ${ignored.join(', ')}. The app row holds display_name, app_handle, listing_url, categories, target_keywords and is_active.`);
    }

    return { set, refused, ignored, warnings };
};

export = {
    buildPartnerAppPatch,
    isRenderableUrl
};
