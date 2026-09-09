/**
 * Input and result shapes for the partner-app WRITE services — update and soft delete.
 *
 * Declarations only — every import is `import type`, so this file is erased at compile time.
 */

import type { SerializedPartnerApp } from './partnerApp.types';

// ── The patch ───────────────────────────────────────────────────────────────

/**
 * The body of `PATCH /api/partner-apps/:app_id`, as it reaches the pure patch helper.
 *
 * ⚠️ EVERY FIELD IS `unknown`, DELIBERATELY. This is an unvalidated request body: the controller
 * does shape validation only and hands the bag through, so declaring `display_name?: string` here
 * would be asserting something nobody has checked. The helper narrows each one and refuses what it
 * cannot narrow, which is the only place the type and the value are made to agree.
 */
export interface PartnerAppPatchInput {
    [field: string]: unknown;
}

/** One field the write refused, and the sentence the operator reads. */
export interface RefusedPatchField {
    field: string;
    reason: string;
}

/** The fields a validated patch will actually `$set`. Only the six editable ones can appear. */
export interface PartnerAppPatchSet {
    display_name?: string;
    app_handle?: string;
    listing_url?: string;
    categories?: string[];
    target_keywords?: string[];
    is_active?: boolean;
}

/**
 * What the pure patch helper answers.
 *
 *  `refused` NON-EMPTY MEANS THE WHOLE CALL FAILS — it is not a per-field skip list. A partial
 * apply would leave the caller unable to say which of the fields they sent took effect, and a form
 * that posts an app id, receives a 200 and shows the old value back is the exact failure the
 * frontend's own `partnerAppService` header describes.
 */
export interface PartnerAppPatchResult {
    /** The `$set` document. Empty when the body carried nothing writable. */
    set: PartnerAppPatchSet;
    /** Identity, watermark and coverage fields the body tried to write. Any entry fails the call. */
    refused: RefusedPatchField[];
    /** Keys that are neither editable nor refused — typos. Warned about, never fatal. */
    ignored: string[];
    /** Per-field notes: a value that was trimmed, deduplicated or clamped says so. */
    warnings: string[];
}

/** `updatePartnerApp` input. `partner_app_id` comes from the URL; `patch` is the raw body. */
export interface UpdatePartnerAppInput {
    /** ⚠️ Optional like every service input here — it arrives from a URL parameter. */
    partner_app_id?: string;
    patch?: PartnerAppPatchInput;
}

/** `updatePartnerApp` payload. */
export interface UpdatePartnerAppPayload {
    app: SerializedPartnerApp | null;
    /** Which fields the write actually changed. Empty when every value already matched. */
    updated_fields: string[];
    /**
     * False when the stored row already held every submitted value.
     *
     * Published rather than inferred from `updated_fields.length`: a caller that resubmits an
     * unchanged form gets a 200 and needs to know nothing moved, without having to compare the
     * document it sent against the one it got back.
     */
    changed: boolean;
    warnings: string[];
}

// ── The soft delete ─────────────────────────────────────────────────────────

/** `deactivatePartnerApp` input. */
export interface DeactivatePartnerAppInput {
    /** ⚠️ Optional like every service input here — it arrives from a URL parameter. */
    partner_app_id?: string;
}

/**
 * What a soft delete retained. Published on the response, not merely logged.
 *
 *  THESE TWO COUNTS ARE THE PROOF. An operator who sends DELETE and receives 200 has every
 * reason to assume rows went away; a response that states how many still reference the app is the
 * difference between "it worked" and "it did what I thought it did".
 */
export interface DeactivatePartnerAppRetained {
    /** Rows still in `gi_partner_app_events` for this app. Unchanged by this call. */
    event_rows: number;
    /** Rows still in `gi_partner_app_transactions` for this app. Unchanged by this call. */
    transaction_rows: number;
}

/** `deactivatePartnerApp` payload. */
export interface DeactivatePartnerAppPayload {
    app: SerializedPartnerApp | null;
    /** ALWAYS false. The field exists so the wire says so; there is no hard-delete path. */
    deleted: boolean;
    /** False when the app was already inactive — the call is idempotent, not a no-op error. */
    changed: boolean;
    /** What deactivation means here, in the operator's language. */
    semantics: string;
    /** Why there is no hard delete, and what to do instead. */
    hard_delete: string;
    /**
     * How to undo it. A soft delete whose reversal is undocumented is a hard delete with extra
     * steps, so the path travels with the response.
     */
    reversal: string;
    retained: DeactivatePartnerAppRetained;
    warnings: string[];
}
