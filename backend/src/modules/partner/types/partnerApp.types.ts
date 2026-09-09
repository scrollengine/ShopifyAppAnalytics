/**
 * Input and result shapes for the partner-app registration and read services.
 *
 * Declarations only — every import is `import type`, so this file is erased at compile time.
 */

/** What the operator may override when registering the app configured in the environment. */
export interface RegisterPartnerAppInput {
    /** The handle in `apps.shopify.com/<handle>`. Defaulted from the app id when not supplied. */
    app_handle?: string;
    /** Human name for the dashboard. Defaulted from the app id when not supplied. */
    display_name?: string;
    /** The public App Store listing URL. See the service for why the default is NOT guessed. */
    listing_url?: string;
}

/** Filter for the app list. There is normally exactly one row. */
export interface ListPartnerAppsInput {
    /** Omitted returns every app, active or not. */
    is_active?: boolean;
}

/**
 * ⚠️ Optional, like every other service input here: it arrives from a URL parameter or a job
 * payload, so a required declaration would be asserting something nobody has checked yet. The
 * service validates it and refuses with a readable message.
 */
export interface GetPartnerAppByIdInput {
    partner_app_id?: string;
}

/** The fields a new app row is created with. Everything else is defaulted by the schema. */
export interface PartnerAppCreateFields {
    app_handle: string;
    display_name: string;
    listing_url: string;
    /** Canonical `gid://partners/App/<id>` — never the raw value the operator typed. */
    partner_api_app_id: string;
}

/**
 * The app as it goes onto the wire.
 *
 *  The coverage gates are part of the PUBLIC shape on purpose. They are what a reader needs to
 * know how much weight the app's figures will bear, and a dashboard that shows the numbers while
 * keeping their coverage internal is the exact failure this project exists to refuse. `null` in any
 * of them means NOT MEASURED — never zero.
 */
export interface SerializedPartnerApp {
    app_id: string;
    app_handle: string;
    display_name: string;
    listing_url: string;
    partner_api_app_id: string;
    is_active: boolean;
    /**
     * App Store categories the listing sits in. Display metadata — nothing folds over it.
     *
     *  ON THE WIRE BECAUSE `PATCH` WRITES IT. The edit form seeds its inputs from this row, and an
     * omitted array loads as blank and saves back as `[]` — wiping stored values nobody edited.
     * Always an array, never null: absent and empty are the same fact for a list of labels.
     */
    categories: string[];
    /** Keywords to track ranks for. Same read/write symmetry rule as `categories`. */
    target_keywords: string[];
    /** Advanced ONLY after a fully successful pull, so it is a "we have everything up to here" mark. */
    last_synced_at: Date | null;
    /** Null until a LIFETIME pull has completed once. Until then every all-time figure is a floor. */
    lifetime_sync_completed_at: Date | null;
    coverage: {
        earliest_event_at: Date | null;
        earliest_transaction_at: Date | null;
        /**
         * Where real store names start. Published rather than kept internal for the same reason as
         * every other gate: it is what tells a reader that the bare domains further down the table
         * are a sync boundary with a one-command fix, not a column that lost its data.
         */
        shop_name_coverage_since: Date | null;
        event_history_gap_days: number | null;
        charge_link_absent_pct: number | null;
        charge_link_unresolved_pct: number | null;
    };
    createdAt?: Date;
    updatedAt?: Date;
}

/** `registerPartnerAppFromConfig` / `getPartnerAppById` payload. */
export interface PartnerAppEnvelope {
    app: SerializedPartnerApp | null;
    /** False when the app was already registered — the call is idempotent, not a no-op error. */
    created?: boolean;
}

/** `listPartnerApps` payload. */
export interface PartnerAppListPayload {
    items: SerializedPartnerApp[];
    total: number;
}
