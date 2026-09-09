/**
 * ============================================================================
 *  SHARED SERVICE-LAYER TYPES
 * ============================================================================
 *
 *  The two conventions every service in this codebase follows: a destructured
 *  identity object as the first parameter, and a `promiseReturnResult` envelope
 *  as the resolved value.
 *
 *  Declarations only — no runtime imports, so importing this file costs nothing
 *  at run time and it can be referenced from anywhere, including pure helpers.
 * ============================================================================
 */

/**
 * The identity object every service takes as its FIRST parameter.
 *
 * ── Why there is no `tenant_id` and no `store_info` ──────────────────────────
 * The system this was extracted from is a multi-tenant SaaS, where every
 * service call carried `{ tenant_id, user_id, store_info }` and every query was
 * scoped by tenant. None of that applies here, and carrying it anyway would be
 * actively harmful:
 *
 *   - This backend analyses ONE Shopify app, self-hosted by the developer who
 *     owns it. There is no second tenant to be isolated from. A `tenant_id`
 *     threaded through every signature would be a value that is always the
 *     same, which is a field readers must check and can never trust.
 *
 *   - Scoping is by `partner_app_id` — the Shopify app the data belongs to,
 *     which comes from configuration and stored Partner API records, not from
 *     the caller. Letting a caller pass a scope is how a scoping bug becomes a
 *     data leak; not having the parameter at all makes that impossible.
 *
 *   - `store_info` was a resolved merchant-store document. Here, stores are the
 *     SUBJECT of the analysis rather than the identity of the caller.
 *
 * So identity is the acting operator, and only that.
 */
export interface IdentityObject {
    /**
     * The acting operator. Required.
     *
     * Background work (the sync runner, the cron scheduler, a maintenance
     * script) has no human behind it and passes a stable sentinel such as
     * `'SYNC_WORKER'`, so an audit trail always names an actor rather than
     * carrying a null that every reader has to interpret.
     */
    user_id: string;
}

/**
 * The `promiseReturnResult` envelope — the resolved value of every service call.
 *
 * Services always RESOLVE, never reject, so failure is carried in `status`
 * rather than thrown. Callers branch on `status`; reading `data` off a result
 * whose `status` is false is a bug, and this type exists partly to make that
 * visible at the call site.
 *
 * Note that this is about a call FAILING (the query threw, the API was
 * unreachable). It is a different thing from a figure being UNKNOWN, which is a
 * successful result whose value is `null` with a stated reason — the honesty
 * envelope. A successful call that could not compute a number returns
 * `status: true` and a null figure, never `status: false`, and never `0`.
 */
export interface ServiceResult<TData = any> {
    /** False means the operation did not happen; `data` is then an empty object. */
    status: boolean;
    /** The payload on success. `{}` on failure. */
    data: TData;
    /** The caught error on failure, `{}` otherwise. For logs and diagnostics — not for the wire. */
    error: any;
    /** Human-readable message, safe to surface to the client. */
    msg: string;
}

/**
 * The `{}` a FAILED service call carries in its envelope, given a name so it can be typed.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The house rule (see `utils/promiseHelper`) is that a failed call carries `{}` in `data` — never a
 * partial payload, which a caller ignoring `status` would read as real. But a service that declares
 * `ServiceResult<SomePayload>` and then resolves `{}` does not compile: `{}` is missing every
 * property of the payload.
 *
 * So a service whose failure path carries `{}` declares `ServiceResult<Payload | EmptyPayload>`. The
 * union is not decoration — it is the true shape of what comes back, and it forces a caller to check
 * `status` before reading a field rather than trusting a payload that may not be there.
 *
 * A service whose "empty" answer is genuinely representable does NOT use this. A payload of
 * `{ app: null }` is complete and honest, and typing it as a union would only add a check nobody
 * needs.
 *
 * `Record<string, never>` rather than a bare `{}` deliberately: the `{}` TYPE in TypeScript means
 * "any non-nullish value", so `Payload | {}` would collapse into something that accepts almost
 * anything and the union would stop meaning what it says.
 */
export type EmptyPayload = Record<string, never>;
