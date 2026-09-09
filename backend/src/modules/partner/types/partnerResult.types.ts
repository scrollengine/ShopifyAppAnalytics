/**
 * The `{}` a failed service call carries in its envelope, given a name so it can be typed.
 *
 * Declarations only — no runtime imports.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The house rule (see `utils/promiseHelper`) is that a FAILED call carries `{}` in `data` — never a
 * partial payload, which a caller ignoring `status` would read as real. But a service that declares
 * `ServiceResult<PartnerAppListPayload>` and then resolves `{}` does not compile: `{}` is missing
 * every property of the payload.
 *
 * So a service whose failure path carries `{}` declares `ServiceResult<Payload | EmptyPayload>`.
 * The union is not decoration — it is the true shape of what comes back, and it forces a caller to
 * check `status` before reading a field rather than trusting a payload that may not be there.
 *
 * A service whose "empty" answer is genuinely representable does NOT use this. `getPartnerAppById`
 * returns `{ app: null }`, which is a complete and honest payload, and typing it as a union would
 * only add a check nobody needs.
 */

/**
 * An object with no properties.
 *
 * ⚠️ RE-EXPORTED, not redeclared. The definition lives beside `ServiceResult` in
 * `src/types/service.types`, because every module's failure path carries this same `{}` and two
 * declarations of one idea are two things to keep in step. This alias stays so the partner module's
 * existing imports keep resolving.
 */
export type { EmptyPayload } from '../../../types/service.types';
