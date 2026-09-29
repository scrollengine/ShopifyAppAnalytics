import AxiosClientProvider from '../apiClient';

/**
 * =============================================================================
 *  Conversion, retention, churn and revenue — the analytics half of the suite.
 * =============================================================================
 *
 *  FIVE of the nine Performance pages call into this one service: Trial Funnel,
 *  Logo Churn, Revenue, Revenue Churn, and the Funnel page (alongside
 *  funnelService). Method names and callback shapes are IDENTICAL to the source
 *  dashboard's, so those pages were carried across unedited.
 *
 *  ── WHAT ACTUALLY EXISTS TODAY — ALL OF IT ──────────────────────────────────
 *      getRevenueOverview  →  GET  /api/revenue/overview            ✅
 *      getShopPlans        →  POST /api/revenue/shop-plans          ✅
 *      getCustomFunnel     →  GET  /api/conversion/custom-funnel    ✅
 *      getFunnel           →  GET  /api/conversion/funnel           ✅
 *      getTrialOutcomes    →  GET  /api/conversion/trial-outcomes   ✅
 *      getTrialTrend       →  GET  /api/conversion/trial-trend      ✅
 *      getCohortRetention  →  GET  /api/conversion/cohort-retention ✅
 *      getTimeToPaid       →  GET  /api/conversion/time-to-paid     ✅
 *      getPlanMix          →  GET  /api/conversion/plan-mix         ✅
 *      getLogoChurn        →  GET  /api/conversion/logo-churn       ✅
 *      getRevenueChurn     →  GET  /api/conversion/revenue-churn    ✅
 *
 *  The backend's first slice was the ledger: what Shopify actually settled. Every read above was
 *  built on top of it and the subscription event stream, and the last of the not-implemented stubs
 *  is now gone from this file — which is why `./notImplemented.js` is no longer imported here. Do
 *  not reintroduce a `cb({})` in place of one: an empty envelope draws a flat chart that reads as a
 *  fact, which is the failure the whole `dataState` layer exists to refuse.
 *
 *  ── ⚠️ `null` IS AN UNKNOWN ON EVERY ONE OF THESE READS ─────────────────────
 *  A count, a rate, a money figure or a whole month can be `null`, and `null` never means zero. A
 *  month whose boundaries the stored history cannot support publishes EVERY figure as null — not
 *  just the rate — so a chart's line must be drawn with `connectNulls={false}` and BREAK over it. Do
 *  not coalesce with `|| 0` or negate with a unary minus: `-null` is `-0`, a number, which passes
 *  every `typeof === 'number'` guard downstream and prints as a measured zero for a month nobody
 *  measured. Ratios are FRACTIONS (0–1); the pages multiply.
 *
 *  ──  `revenue/overview` IS BARE NUMBERS. `revenue/now` IS ENVELOPES. ───────
 *  They are two endpoints over ONE ledger, and the difference is deliberate rather than an
 *  inconsistency. `GET /api/revenue/now` is a point-in-time snapshot whose every figure is a
 *  `{ value, confidence, source, reason? }` envelope; it is read by `/api/meta/coverage` and by an
 *  operator reading JSON, and both want the envelope. `GET /api/revenue/overview` is read by
 *  `pages/revenue/index.js`, whose formatters are `Number(n)` and
 *  `typeof n !== 'number'` — so an envelope there renders EVERY figure as an em dash, which is the
 *  honesty mechanism manufacturing the missing figure it exists to prevent.
 *
 *   `getRevenueOverview` USED TO CALL `/now`, AND THAT WAS THE WHOLE REVENUE PAGE. Four KPI cards,
 *  both donuts and five table columns rendered dashes, and `top_shops` arrived as an OBJECT — so the
 *  page's `(resp.data.top_shops || []).map(...)` was truthy and THREW on every successful response.
 *  Nothing below may point a page-facing read at `/now` again.
 *
 *  The overview discharges the honesty contract through fields that survive rendering instead:
 *  `null` for unknown and never `0`, `measurable` + `unknown_reason` per month, `before_coverage`,
 *  `coverage`, `data_state`, `notes[]`, `warnings[]` and `diagnostics`.
 * =============================================================================
 */

/**
 * Returned when the API refuses the call. By the time a caller sees this the axios interceptor has
 * already cleared the token and started the redirect to /login — this exists so a page that renders
 * before the navigation completes shows its empty state rather than throwing. It carries no
 * `status`, so every ported `if (!resp.status)` guard treats it as a failed call, which is correct.
 */
const resourceNotAllowed = { resource_access: 'NOT_ALLOWED' };

/**
 * The API's own 403 envelope, when that is what `err` carries.
 *
 * Forwarded INTACT rather than flattened to `{}`: its `error: { code: 'FORBIDDEN', permission }` is
 * what lets `readDataState` say "Restricted — your role does not include …". Flattened, a role that
 * lacks the permission would read "This could not be loaded" — a failure nobody can fix from a log,
 * reported in place of the access the reader actually lacks.
 *
 * @param {Object} err - The axios error.
 * @returns {Object|null} The envelope, or null when this is not a 403 with a body.
 */
const _forbiddenEnvelope = (err) => {
    if (!err || !err.response || err.response.status !== 403) {
        return null;
    }
    const body = err.response.data;
    if (!body || typeof body !== 'object') {
        return null;
    }
    return body;
};

class GrowthIntelConversionApiService {
    constructor() {
        this.apiClient = new AxiosClientProvider().getClient();
    }

    /**
     * Shared GET. Kept from the source so implemented methods stay one line, and so wiring up a
     * currently-unimplemented method later is a one-line change here rather than a new shape.
     *
     * @param {String} path - Path relative to the axios base (`/api/`), e.g. 'revenue/now'.
     * @param {Object} params - Query parameters.
     * @param {Function} cb - Receives the response envelope, the 403 envelope, `{}`, or `resourceNotAllowed`.
     * @param {String} ctx - Method name, for the console line on failure.
     * @returns {void}
     */
    _get(path, params, cb, ctx) {
        this.apiClient
            .get(path, { params: params || {} })
            .then((response) => { cb(response && response.data ? response.data : {}); })
            .catch((err) => {
                if (err.response && err.response.status === 401) { cb(resourceNotAllowed); return; }
                const forbidden = _forbiddenEnvelope(err);
                if (forbidden) { cb(forbidden); return; }
                console.log(`GrowthIntel conversion.${ctx} error`, err);
                cb({});
            });
    }

    /**
     * Shared POST. Same envelope, same 401 handling, same failure shape as `_get` — the only
     * difference is that the payload travels in the BODY.
     *
     * ⚠️ `apiClient.getClient()` returns a full axios instance. The `method: 'get'` in its
     * `axios.create` is a per-request DEFAULT, not a restriction, so `.post` is available and carries
     * the same bearer-token and 401-redirect interceptors as every other call in this app.
     *
     * @param {String} path - Path relative to the axios base (`/api/`), e.g. 'revenue/shop-plans'.
     * @param {Object} body - Sent as JSON.
     * @param {Function} cb - Receives the response envelope, the 403 envelope, `{}`, or `resourceNotAllowed`.
     * @param {String} ctx - Method name, for the console line on failure.
     * @returns {void}
     */
    _post(path, body, cb, ctx) {
        this.apiClient
            .post(path, body || {})
            .then((response) => { cb(response && response.data ? response.data : {}); })
            .catch((err) => {
                if (err.response && err.response.status === 401) { cb(resourceNotAllowed); return; }
                const forbidden = _forbiddenEnvelope(err);
                if (forbidden) { cb(forbidden); return; }
                console.log(`GrowthIntel conversion.${ctx} error`, err);
                cb({});
            });
    }

    /**
     * The fixed 7-stage end-to-end funnel: listing views → install clicks → consent → GA4 installs →
     * Partner installs → trials → paid.
     *
     * The FIXED sibling of `getCustomFunnel`, which takes an operator-chosen event list. This one is
     * `getCustomFunnel` with a fixed key list and a reshape — there is no second stage table, no
     * second `$in` and no second set of labels behind it.
     *
     * ── TWO TIERS THAT FAIL SEPARATELY, SO THE CALL ANSWERS 200 EITHER WAY ─────
     * The first four stages come from BigQuery/GA4 and the last three from the Partner API. Either
     * can be cold while the other is fine, so a refusal would blank Partner stages that are present
     * and correct. `tiers.{listing,partner}.state` says which is answering, and `data_state` is set
     * ONLY when NEITHER tier can answer anything at all.
     *
     * ──  `count: null` IS AN UNKNOWN, NEVER A ZERO ────────────────────────────
     * A null stage carries `available: false` and an `unknown_reason`. Do not coalesce it: the chart
     * already draws a null as a minimum-width bar with an em-dash label, and `|| 0` would turn a
     * statement about the DATA into a false statement about the BUSINESS. Every rate touching a null
     * is null too.
     *
     * ──  THE FUNNEL CROSSES TWO MEASUREMENT SEAMS ─────────────────────────────
     * `unit` and `population` change down the ladder — VISITORS above the GA4/Partner boundary,
     * SHOPS below it, SUBSCRIPTIONS at the bottom — so a "conversion rate" across one of them is not
     * a per-entity rate. Every stage carries `crosses_measurement_seam`; `seam_stage_index` publishes
     * the row the chart hard-codes, so the contract is checkable rather than assumed; and the two
     * headline rates ship `rate_definitions` plus a warning each. `overall_paid_conversion_rate` can
     * legitimately exceed 100% — subscriptions over stores.
     *
     * `seam_diagnostics.drift_pct` compares GA4's install count with the Partner API's. It is
     * SIGNED, and `null` — never `0` — when either side is unknown or GA4 counted no installs: a
     * zero there would assert the two systems AGREE, the most reassuring thing this payload can say
     * and the one it must not invent.
     *
     * ⚠️ The two halves cover different SPANS. GA4's export lags the day it describes, so listing
     * stages stop at `ga4_until` while Partner stages run to `until`, and every listing-to-install
     * rate reads high by roughly that fraction. `warnings[]` says so.
     *
     * @param {Object} params - { partner_app_id (required), period_days | since + until }.
     * @param {Function} cb - Receives `{ status, msg, data: { stages, stage_keys, seam_stage_index,
     * seam_diagnostics, overall_install_rate, overall_paid_conversion_rate, rate_definitions,
     * period_label, ga4_until, tiers, diagnostics, warnings, data_state?, unknown_reason? } }`, or
     * `{}` / `resourceNotAllowed` on failure. Rates are FRACTIONS (0–1); the page multiplies.
     * @returns {void}
     */
    getFunnel(params, cb) {
        this._get('conversion/funnel', params, cb, 'getFunnel');
    }

    /**
     * Shopify-Partner-style funnel over a chosen, ordered list of events, plus the trial-cohort
     * block that renders beneath the chart. Both come from THIS payload; there is no second call.
     *
     * ── ⚠️ `events` ORDER IS THE FUNNEL, AND THE PAGE SAVES IT BACK ─────────────
     * The order decides every step's denominator. The server returns the steps in exactly the order
     * it was given, and `funnel/index.js` persists `steps.map(s => s.key)` into
     * `localStorage['gi.funnel.stepEvents']` — so anything that rewrites the order rewrites the
     * operator's saved funnel with nothing on screen to undo it from. Pass the selection joined with
     * commas, and do not sort it.
     *
     * ── THIS ENDPOINT READS TWO TIERS THAT FAIL SEPARATELY ──────────────────
     * Listing-analytics steps come from BigQuery; install, subscription and payout steps come from
     * the Partner API. Either can be cold while the other is fine, so the call answers **200 with a
     * payload** even when a tier cannot answer — a refusal would blank Partner steps that are present
     * and correct. `data.tiers.{listing,partner}.state` says which, and `data.data_state` is set
     * ONLY when neither tier can answer anything at all.
     *
     * ── A `count: null` STEP IS AN UNKNOWN, NEVER A ZERO ────────────────────
     * `0` means "nobody did this". `null` means "the tier behind this step has nothing to answer
     * with", and it carries `available: false` plus an `unknown_reason`. Any rate touching a null is
     * `null` with `rate_basis: 'unavailable'`. Do NOT coalesce these with `|| 0` on the way to a
     * chart: `PartnerFunnelChart` already draws a null as an absent bar with an em-dash label, and a
     * zero would turn a statement about the DATA into a false statement about the BUSINESS. The same
     * rule holds for the headline `conversion_rate`, which is `null` — never `0` — when the first
     * step is unknown or empty, and also when fewer than two steps were selected.
     *
     * ⚠️ The two halves of the funnel cover different SPANS. The GA4 export lags the day it
     * describes, so listing steps stop at `data.ga4_until` while Partner steps run to `data.until`,
     * and every listing-to-install rate reads high by roughly that fraction. `data.warnings[]` says
     * so; render it — the chart already does, one `<p>` per string.
     *
     * @param {Object} params - { partner_app_id (required), events (comma-joined, ORDER MATTERS),
     * period_days | since + until }.
     * @param {Function} cb - Receives `{ status, msg, data }` where `data` carries `steps`,
     * `catalog`, `conversion_rate`, `trial_cohort`, `window_kpi`, `diagnostics`, `warnings` and
     * `tiers`; or `{}` / `resourceNotAllowed` on failure.
     * @returns {void}
     */
    getCustomFunnel(params, cb) {
        this._get('conversion/custom-funnel', params, cb, 'getCustomFunnel');
    }

    /**
     * Every subscription activated inside the window, classified as of TODAY.
     *
     * ── CONVERSION IS A DATE COMPARISON, NOT AN EVENT ───────────────────────────
     * A subscription converted iff it was still alive when its trial ran out — so a shop that paid
     * and later cancelled STILL CONVERTED, and `CHURNED_AFTER_TRIAL` is counted inside `converted`.
     * `CHURNED_DURING_TRIAL` never can be: that shop never paid, so it is a demand problem rather
     * than churn, and `cancellation_rollup` totals the trial-side losses on their own.
     *
     * ── THE UNDECIDED ARE EXCLUDED FROM THE RATE, NOT COUNTED AS FAILURES ───────
     * `trial_to_paid_rate` is measured over `decided_count` (= cohort − `still_on_trial`), and it is
     * `null` — never `0` — when nothing has been decided yet. `breakdown[].pct` is likewise null for
     * an empty cohort rather than `0/0`.
     *
     * ── ⚠️ `breakdown` IS `null`, NOT `[]`, WHEN NOTHING WAS MEASURED ───────────
     * An empty ARRAY is a measured empty and renders as four honest zeros; `null` means no Partner
     * sync has completed and must route the whole payload to the never-synced banner. The page's
     * `_outcomesNeverSynced` is `(d) => !Array.isArray(d.breakdown)` for exactly that reason.
     *
     * ── ⚠️ NO ASSUMED TRIAL LENGTH ──────────────────────────────────────────────
     * `shops[].trial_ends_at` has ONE source, Shopify's own `charge.billingOn`, and is `null` when
     * Shopify sent none. It is never `activated_at + N days`: a rendered date is a specific claim
     * about a specific merchant, and an assumed one is a specific false claim.
     *
     * ⚠️ The row's price field is `price`, not `plan_price` — this endpoint and `/api/subscriptions`
     * spell it differently, and each page reads the one its own endpoint publishes.
     *
     * @param {Object} params - { partner_app_id (required), period_days | since + until }.
     * `period_days` also accepts `'all'` for the lifetime cohort.
     * @param {Function} cb - Receives `{ status, msg, data: { breakdown, total_shops_in_cohort,
     * decided_count, still_on_trial, converted_count, trial_to_paid_rate, cancellation_rollup,
     * shops, shops_truncated, period_label, notes, warnings, diagnostics, data_state,
     * unknown_reason? } }`, or `{}` / `resourceNotAllowed` on failure.
     * @returns {void}
     */
    getTrialOutcomes(params, cb) {
        this._get('conversion/trial-outcomes', params, cb, 'getTrialOutcomes');
    }

    /**
     * Weekly install cohorts against retention checkpoints — the heatmap.
     *
     * ──  AN UNREACHED CHECKPOINT IS AN ABSENT OBJECT, NOT `{ pct: null }` AND NOT `0` ─
     * A cohort only two weeks old cannot answer day 30, and the honest rendering of that cell is
     * BLANK. It is therefore omitted from `checkpoints` entirely rather than published with a null
     * pct, and the checkpoint lands in the row's `unreached_checkpoints` with a reason. The page
     * reads `cp ? cp.pct : null`, so an absent object and a null pct look the same on screen — the
     * difference is that a published `0` would be a claim that everybody left.
     *
     * Eligibility is measured PER STORE from that store's own install instant, not per cohort from
     * the week boundary, so `eligible` and `retained` travel with every cell and a partially-eligible
     * checkpoint is flagged rather than averaged into a whole one.
     *
     * ── ⚠️ `cohorts` IS `null`, NOT `[]`, WHEN NOTHING HAS SYNCED ───────────────
     * An empty array is a measured empty and draws an empty heatmap; `null` means we have not
     * looked, and the decoder routes it to a banner.
     *
     * ⚠️ `checkpoints_days` is BOTH the column headers and the `day_N` key lookups — one array,
     * published once, so the two cannot drift. Do not hard-code `[1, 7, 30, 60, 90]` beside it.
     *
     * @param {Object} params - { partner_app_id (required), weeks }. Out of range is CLAMPED and
     * reported in `warnings[]`, never refused; `weeks` on the response is what was actually served.
     * @param {Function} cb - Receives `{ status, msg, data: { cohorts, checkpoints_days,
     * retention_basis, weeks, since, until, as_of, diagnostics, warnings, data_state,
     * unknown_reason? } }`, or `{}` / `resourceNotAllowed` on failure.
     * @returns {void}
     */
    getCohortRetention(params, cb) {
        this._get('conversion/cohort-retention', params, cb, 'getCohortRetention');
    }

    /**
     * Days from install to first paid billing, as a histogram plus five summary statistics.
     *
     * ──  `total_paid_shops` IS A FLOOR, AND THE EXCLUSIONS SAY BY HOW MUCH ────
     * Three populations are excluded and each is counted separately rather than lumped into one
     * "other": `not_converted` (never paid), `converted_without_billing_date` (paid, but Shopify sent
     * no billing date — these genuinely converted and simply cannot be dated, which is what makes the
     * total a floor) and `converted_before_install` (a negative span). The negative span is EXCLUDED
     * rather than clamped to zero: clamping would file every re-installer under "Same day", which is
     * the most-read bucket on the chart.
     *
     * ── ⚠️ `buckets` IS `null`, NOT `[]`, WHEN NOTHING HAS SYNCED ───────────────
     * An empty array is a measured empty and draws honest zero-height bars. `total_paid_shops: 0` is
     * likewise a measured answer — the page's own empty state — and never reaches it as a null,
     * because the decoder routes NEVER_SYNCED to a banner first.
     *
     * @param {Object} params - { partner_app_id (required), period_days | since + until }.
     * `period_days` also accepts `'all'` for the lifetime cohort.
     * @param {Function} cb - Receives `{ status, msg, data: { buckets, stats, total_paid_shops,
     * total_installed_shops, excluded, period_label, since, until, as_of, diagnostics, warnings,
     * data_state, unknown_reason? } }`, or `{}` / `resourceNotAllowed` on failure. `stats` carries
     * `median_days`, `mean_days`, `p25_days`, `p75_days`, `min_days` and `max_days` as bare numbers.
     * @returns {void}
     */
    getTimeToPaid(params, cb) {
        this._get('conversion/time-to-paid', params, cb, 'getTimeToPaid');
    }

    /**
     * Who is paying, on which plan, right now — plus how many of each plan churned in the window.
     *
     * ── MEMBERSHIP IS AN INSTANT, AND IT IS THE SAME PREDICATE AS EVERYWHERE ELSE ─
     * A shop counts as active when Shopify settled a subscription payout for it within
     * `active_sub_window_days` of the instant being measured — the identical as-of predicate behind
     * MRR and logo churn, so the Revenue, Logo Churn and Plan Mix pages cannot disagree about who is
     * paying. `membership_basis` publishes that sentence.
     *
     * ──  THE CHURN DENOMINATOR IS THE HISTORICAL PLAN, NOT TODAY'S ────────────
     * A shop that upgraded and then left churned from the plan it was ON, resolved at the historical
     * boundary rather than read off today's plan map. Attributing it to its current plan would move
     * churn between rows every time somebody upgrades.
     *
     * ── ⚠️ `plans` IS `null`, NOT `[]`, WHEN NOTHING HAS SYNCED ─────────────────
     * An empty array is a measured empty. `total_active_now: 0` is likewise measured — the donut's
     * own empty state — and the null never reaches the component, because the decoder banners
     * NEVER_SYNCED first.
     *
     * ⚠️ A plan the ledger cannot name is bucketed under `unknown_plan_label` — `'(plan unknown)'` —
     * rather than dropped, so the mix still sums to the population. `payload_health` counts the rows
     * whose charge payload never arrived, which is what makes a chunk of that bucket fixable by a
     * re-sync rather than permanent.
     *
     * ⚠️ Money is a BARE NUMBER with a separate `currency` label; nothing in this build converts
     * currencies, so a mix spanning several is labelled, not summed into one.
     *
     * @param {Object} params - { partner_app_id (required) }. This read has no window: it is a
     * snapshot at `as_of`, and a date range would imply otherwise.
     * @param {Function} cb - Receives `{ status, msg, data: { plans, total_active_now,
     * total_mrr_amount, currency, active_sub_window_days, churn_window_days, membership_basis,
     * unknown_plan_label, payload_health, as_of, diagnostics, warnings, data_state,
     * unknown_reason? } }`, or `{}` / `resourceNotAllowed` on failure.
     * @returns {void}
     */
    getPlanMix(params, cb) {
        this._get('conversion/plan-mix', params, cb, 'getPlanMix');
    }

    /**
     * Paying customers LOST, counted in customers — the four tiles, the monthly movement series, the
     * churn-by-plan table and the shops behind the 30-day figure.
     *
     * ── COUNTS LOGOS, NEVER MONEY ───────────────────────────────────────────────
     * Losing ten $9 merchants and losing one $500 merchant are the same revenue event and completely
     * different business events, so nothing in this payload carries an amount. Money is the Revenue
     * page's question; membership here comes through the SAME predicate that produces MRR, so the
     * two pages cannot disagree about who is paying.
     *
     * ── MEMBERSHIP IS AT AN INSTANT, NOT PER CALENDAR MONTH ─────────────────────
     * A shop counts as active when Shopify settled a subscription payout for it within
     * `summary.active_sub_window_days` of the instant being measured. Month-of-charge membership
     * would report a 30-day biller as churned in the one calendar month a year its cycle skips.
     *
     * ── ⚠️ `summary` AND `monthly_trend` FAIL SEPARATELY, AND THE PAGE MUST TOO ─
     * They are two different measurements — four instants versus every month boundary in the range —
     * so a young deployment can answer the tiles and not the trend. `monthly_trend` is `null` (with
     * `trend_unknown_reason`) only when NO month is measurable; when SOME are, it stays an ARRAY with
     * nulls inside it.
     *
     * ── ⚠️ A NULL MONTH NULLS EVERY COUNT, AND `-null` IS `-0` ──────────────────
     * `gained_in_month`, `churned_in_month`, `active_at_start`, `active_at_end` and `churn_rate` are
     * all null for an unmeasured month. The chart plots churn downwards, and negating a null yields
     * `-0` — a NUMBER, which passes the tooltip's `typeof` guard and prints "Churned 0" for a month
     * nobody measured. Test for null before negating.
     *
     * `recent_churned[].paid_days` is always a number (the page prints it unguarded) and
     * `churn_date_basis` says which evidence dated the row: `partner_event` is a real cancellation,
     * `ledger_window` is the instant the last settled payout aged out — always LATER than the real
     * cancellation, so its paid duration is an over-estimate.
     *
     * @param {Object} params - { partner_app_id (required), months }. Out of range is CLAMPED and
     * reported in `warnings[]`, never refused.
     * @param {Function} cb - Receives `{ status, msg, data: { summary, monthly_trend,
     * trend_unknown_reason, by_plan, recent_churned, recent_churned_truncated, shop_identity,
     * warnings, diagnostics, data_state, unknown_reason? } }`, or `{}` / `resourceNotAllowed` on
     * failure.
     * @returns {void}
     */
    getLogoChurn(params, cb) {
        this._get('conversion/logo-churn', params, cb, 'getLogoChurn');
    }

    /**
     * The MRR movement waterfall — new, expansion, contraction, churn — plus the shops behind the
     * last 30 days of it.
     *
     * ── MONEY, WHERE `getLogoChurn` COUNTS LOGOS ────────────────────────────────
     * Losing ten $9 merchants and losing one $500 merchant are the same revenue event and completely
     * different business events. This read prices them; `getLogoChurn` counts them. Membership on
     * both comes through the SAME as-of predicate that produces MRR, so the two pages and the Revenue
     * page cannot disagree about who is paying.
     *
     * ── ⚠️ AN UNMEASURED MONTH NULLS ALL SIX MONEY FIGURES, AND `-null` IS `-0` ─
     * `start_mrr`, `end_mrr`, `new_mrr`, `expansion_mrr`, `contraction_mrr` and `churned_mrr` are
     * `number | null`, and both churn rates are null with no denominator. The page plots contraction
     * and churn DOWNWARDS — negate through a null-guarding helper, never with a bare unary minus:
     * `-null` is `-0`, a NUMBER, which passes the tooltip's `typeof value === 'number'` test and
     * prints "Churned 0.00" for a month nobody measured.
     *
     * ── NET CHURN IS NOT CLAMPED AT ZERO ────────────────────────────────────────
     * When expansion outruns losses `net_churn_rate` goes NEGATIVE, and negative net churn is the
     * single best signal a subscription business has. Do not `Math.max(0, …)` it on the way to a
     * chart — that hides the best months.
     *
     * ── THE WATERFALL DESCRIBES THE LAST *COMPLETE* MONTH ───────────────────────
     * `summary.last_complete_month` names it, and `monthly_trend[].is_partial_month` flags the month
     * in progress. A waterfall drawn over an unfinished month reconciles with nothing beside it.
     *
     * ⚠️ This endpoint has no warnings banner on its page, so the service folds every warning into
     * `notes[]` — which the page DOES render. `top_churned_truncated` and `trend_unknown_reason`
     * reach the operator that way; do not "tidy" the notes fold away without adding one.
     *
     * @param {Object} params - { partner_app_id (required), months }. Out of range is CLAMPED and
     * reported, never refused.
     * @param {Function} cb - Receives `{ status, msg, data: { summary, monthly_trend,
     * trend_unknown_reason, top_churned_30d, top_churned_truncated, notes, warnings, diagnostics,
     * data_state, unknown_reason? } }`, or `{}` / `resourceNotAllowed` on failure. `summary: null` is
     * the never-synced signal the page routes to its banner.
     * @returns {void}
     */
    getRevenueChurn(params, cb) {
        this._get('conversion/revenue-churn', params, cb, 'getRevenueChurn');
    }

    /**
     * ONE cohort, folded once per calendar month — how each month's trial-starters resolved.
     *
     * The cohort is classified ONCE, as of today, and then bucketed by the month its subscriptions
     * started in. It is never re-classified per month, so the trend and the lifetime figures from
     * `getTrialOutcomes` are two views of the same classification rather than two measurements that
     * happen to be close.
     *
     * ── ⚠️ AN UNMEASURED MONTH NULLS EVERY COUNT, NOT ONLY THE RATE ─────────────
     * `trial_starts`, `converted`, `in_trial`, `cancelled`, `churned_after_paid` and `decided` are
     * all `null` for a month the stored event history cannot support, and `trial_to_paid_rate` is
     * null with `rate_basis: 'unavailable'`. Plot with `connectNulls={false}` so the line BREAKS:
     * `null * 100` is `0` in JavaScript, and a 0% conversion line is a strong claim about the
     * operator's funnel manufactured out of an absence.
     *
     * ── ⚠️ `cohort_aged_days` IS ALWAYS A NUMBER, INCLUDING ON AN UNMEASURED MONTH
     * The page badges a month "Aging" with `cohort_aged_days < 90`, and `null < 90` is TRUE — a null
     * there would badge a month out of an absence. It is measured against the calendar month end and
     * is published on every row.
     *
     * `cancelled` is the trend's name for a cancellation BEFORE the trial ended
     * (= `CHURNED_DURING_TRIAL`). `churned_after_paid` is a SUBSET of `converted`, not a sibling of
     * it — adding it as a fourth stack segment would overflow the month's own total, and summing the
     * two double-counts every shop that paid and then left.
     *
     * ── ⚠️ `monthly_trend` IS `null`, NOT `[]`, WHEN NOTHING WAS MEASURED ───────
     * An empty array is a measured empty; `null` means no Partner sync has completed.
     *
     * @param {Object} params - { partner_app_id (required), months }. Out of range is CLAMPED and
     * reported in `warnings[]`, never refused.
     * @param {Function} cb - Receives `{ status, msg, data: { monthly_trend, note, months, warnings,
     * diagnostics, data_state, unknown_reason? } }`, or `{}` / `resourceNotAllowed` on failure.
     * @returns {void}
     */
    getTrialTrend(params, cb) {
        this._get('conversion/trial-trend', params, cb, 'getTrialTrend');
    }

    /**
     * Revenue over a WINDOW: the KPI cards, the MRR movement card and its four drill-down lists, the
     * MRR-and-cash trend, the per-plan breakdown, the lifetime shop ranking and the reconciliation
     * block. The post-login landing page's only read.
     *
     *  `/api/revenue/overview`, NEVER `/api/revenue/now`. See the file header: `/now` wraps every
     * figure in a confidence envelope, and this page's formatters are `Number(n)` — which is `NaN`
     * for an object. Pointing this method back at `/now` blanks the entire screen and throws on
     * `top_shops`, which is an object there and an ARRAY here.
     *
     * ──  THE WINDOW, NOT A MONTH COUNT ────────────────────────────────────────
     * Collapsing the picked range to "N months" throws away WHERE it sits on the timeline, and an
     * April window then returns today's MRR over an August chart. Pass `dateRange.params` through:
     * `{ period_days }` or `{ since, until }`. The service resolves both into one `as_of` instant
     * that every point-in-time figure is measured at. `months` is accepted and ignored.
     *
     * ── EVERY FIGURE IS A BARE NUMBER, `null` FOR UNKNOWN ───────────────────────
     * `summary.current_mrr`, `summary.as_of.*`, `monthly_trend[].mrr` and the movement totals are all
     * `number | null`. A `null` is "we cannot answer", never "the answer is zero" — the page branches
     * on it to print "unknown, not zero" instead of a green $0.00. `monthly_trend[].measurable` and
     * `.unknown_reason` say which months could not be answered and why; plot the line with
     * `connectNulls={false}` so it BREAKS over them.
     *
     * ── CASH AND RUN-RATE ARE TWO DIFFERENT THINGS ──────────────────────────────
     * The chart's BARS are cash Shopify actually settled (every transaction type, lumpy); the LINE is
     * a run-rate from subscription payouts (smooth). `lifetime_*` and `window_cash` are cash;
     * `mrr` / `active_subs` / `arpu` are run-rate. They are not expected to track and must never be
     * summed together.
     *
     * ⚠️ `warnings[]` is where the caveats that change how a figure READS live — an annual subscriber
     * booked at twelve times its monthly run-rate, mixed currencies with no conversion anywhere in
     * this build, churn dates derived from the ledger rather than from a cancellation event. The page
     * renders them beside `notes[]`; a page that renders only `notes` silently drops all of them.
     *
     * @param {Object} params - { partner_app_id (required), period_days | since + until }.
     * @param {Function} cb - Receives `{ status, msg, data: { window, summary, monthly_trend, plans,
     * top_shops, top_shops_basis, movement_shops, movement_shops_since, coverage, notes, warnings,
     * diagnostics, data_state, unknown_reason } }`, or `{}` / `resourceNotAllowed` on failure.
     * `summary: null` is the never-synced signal.
     * @returns {void}
     */
    getRevenueOverview(params, cb) {
        this._get('revenue/overview', params, cb, 'getRevenueOverview');
    }

    /**
     * Batch-fetch the plan a list of myshopify domains is on right now.
     *
     * ⚠️ TAKES A PARAMS OBJECT, NOT A BARE ARRAY, and `partner_app_id` is REQUIRED — the endpoint
     * answers 400 without it. The old stub's signature was `(shop_domains, cb)`; a caller still
     * passing an array positionally 400s on every call, and the Revenue page's "Current plan" column
     * then falls back to the partner-journey plan while claiming to show the live source of truth.
     *
     * POST because up to 200 domains travel in the body: a query string that long is at the mercy of
     * every proxy in between, and its failure mode is a truncated list silently answering for fewer
     * stores. It reads nothing and writes nothing — the verb is about the payload size.
     *
     * ──  EVERY REQUESTED DOMAIN GETS AN ENTRY ─────────────────────────────────
     * `data.plans` is keyed by the domain string YOU SENT, verbatim, and a domain with no
     * subscription on record comes back PRESENT with `resolved: false` and an `unknown_reason` —
     * never omitted. Omission and "we looked and found nothing" are indistinguishable to a map
     * lookup, so do not filter the misses out.
     *
     * ── ⚠️ `store_active` IS ALWAYS `true`, AND THAT MEANS "NO CLAIM" ───────────
     * The consumer badges any FALSY value "Uninstalled". This build's only data source is the Partner
     * API, which cannot say whether the app is still installed — that is the Stores page's own
     * relationship-event fold — so the endpoint sends the one value that asserts nothing.
     * `store_active_measured: false` says so out loud. `is_test` is likewise always `false`: the
     * charge cohort drops test charges before folding, so a resolved row is non-test by construction.
     *
     * @param {Object} params - { partner_app_id (required), shop_domains } — an array of domains or
     * one comma-joined string. Blank and duplicate entries are dropped with a count, never refused.
     * @param {Function} cb - Receives `{ status, msg, data: { partner_app_id, as_of, plans,
     * resolved_count, unresolved_count, warnings, data_state, unknown_reason } }`, or `{}` /
     * `resourceNotAllowed` on failure.
     * @returns {void}
     */
    getShopPlans(params, cb) {
        this._post('revenue/shop-plans', params, cb, 'getShopPlans');
    }
}

export default GrowthIntelConversionApiService;
