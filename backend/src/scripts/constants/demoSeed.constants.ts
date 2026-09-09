'use strict';

/**
 * ============================================================================
 *  THE DEMO DATASET — identity, markers, and the hand-written cast
 * ============================================================================
 *
 *  Everything here describes ONE fictional Shopify app so that a fresh clone can
 *  show eleven working pages without a Partner organisation, an API token or a
 *  completed lifetime sync. The README's roadmap listed exactly that as missing.
 *
 *  ──  THREE INDEPENDENT MARKERS, BECAUSE ONE CAN BE MISSED ─────────────────
 *
 *   1. `DEMO_APP.display_name` ends in "(DEMO DATA)". It is the app name every
 *      page header renders, so the label is on screen wherever the numbers are.
 *   2. Every shop domain ends in `.myshopify.example`. `.example` is reserved by
 *      RFC 2606 and can never be delegated, so no demo row can ever collide with
 *      — or be mistaken for — a real `*.myshopify.com` store. Every slug also
 *      starts with `demo-`, so a truncated table column still says so.
 *   3. `gi_partner_apps.metadata.demo` carries the marker the SCRIPT reads:
 *      the seeder refuses to touch an app row without it, and the teardown
 *      deletes only rows belonging to an app that has it. A human reads markers
 *      1 and 2; the code reads marker 3.
 *
 *  ── ⚠️ WHY THE CAST IS HAND-WRITTEN AND NOT ALL RANDOM ─────────────────────
 *
 *  A dashboard whose whole thesis is "an unanswerable question returns null with
 *  a reason" is only demonstrated by data that CONTAINS unanswerable questions.
 *  Uniformly random stores produce uniformly healthy pages and prove nothing. So
 *  the sixteen stores below are each here for one named edge case — the annual
 *  subscriber whose /12 must be visible, the shop whose install predates the
 *  synced window, the late payout that is not a cancellation, the abandoned
 *  trial beside the converted one, the store with no GA4 attribution — and the
 *  procedural cohort exists only to give them a plausible population to sit in.
 *
 *  Each store's comment says which case it is. Changing an offset changes what
 *  the demo demonstrates; read the comment before you move a number.
 * ============================================================================
 */

import partnerVocab = require('../../constants/partnerVocab.constants');

const { PARTNER_EVENT_TYPES } = partnerVocab;

// ── Identity and markers ────────────────────────────────────────────────────

/**
 * The value written to `gi_partner_apps.metadata.demo.marker`.
 *
 * ⚠️ This string is a CONTRACT between the seeder and the teardown, not a label.
 * The teardown deletes rows scoped to an app carrying it, and the seeder refuses
 * to overwrite an app row that does not. Changing it orphans every row a
 * previous run wrote — they stop being reachable by the teardown and start
 * looking like real data to the safety gate.
 */
const DEMO_MARKER = 'shopify-app-analytics:demo-dataset';

/** Bumped when the generated SHAPE changes, so a stale dataset is recognisable. */
const DEMO_SEED_VERSION = 1;

/** The reserved TLD every demo shop domain ends in. RFC 2606 — never delegated. */
const DEMO_DOMAIN_SUFFIX = '.myshopify.example';

/** Prefix on every demo shop slug, so a truncated column still reads "demo-…". */
const DEMO_DOMAIN_PREFIX = 'demo-';

/**
 * The fictional app.
 *
 * `partner_api_app_id` is a well-formed `gid://partners/App/<digits>` so the row
 * satisfies every reader that normalises it — but the id itself is nine nines,
 * which belongs to no organisation. A sync pointed at this row fails against
 * Shopify rather than quietly pulling somebody else's app.
 */
const DEMO_APP = Object.freeze({
    app_handle: 'restock-rocket-demo',
    display_name: 'Restock Rocket (DEMO DATA)',
    listing_url: 'https://apps.shopify.com/restock-rocket-demo',
    partner_api_app_id: 'gid://partners/App/999999999',
    categories: Object.freeze(['Inventory management', 'Merchandising']),
    target_keywords: Object.freeze(['back in stock', 'restock alerts', 'inventory notifications'])
});

// ── Shape of the generated history ──────────────────────────────────────────

/** How far back the EVENT history reaches. Eighteen months of installs and trials. */
const HISTORY_DAYS = 548;

/**
 * How far back the settled PAYOUT history reaches — deliberately further than
 * the events.
 *
 * This is what makes `earliest_event_at` and `earliest_transaction_at` differ on
 * the seeded app, which is the whole reason the schema keeps them as two fields.
 * One store (`saltmarsh`) is billed across the extra stretch and has no events at
 * all in it, so the Revenue page can answer months the Stores page cannot.
 */
const LEDGER_HISTORY_DAYS = 590;

/** Which calendar month back from the anchor is left empty. See `quiet_window`. */
const QUIET_MONTHS_BACK = 13;

/** Padding either side of the quiet month, so the stretch is visible in a daily series. */
const QUIET_PADDING_DAYS = 4;

/**
 * ⚠️ NO HAND-WRITTEN STORE MAY INSTALL, CONVERT OR CHANGE PLAN INSIDE THIS BAND.
 *
 * The quiet month is computed from the anchor and therefore MOVES with the
 * calendar: the thirteenth month back starts somewhere between 366 and 427 days
 * ago depending on the day the seeder runs. This band is that range widened at
 * both ends, and the generator asserts every hand-written offset falls outside
 * it. Land an offset inside and the "one month with no measurable rate" case
 * silently stops holding — which is the one thing this dataset exists to show.
 */
const QUIET_SAFE_BAND_DAYS = Object.freeze({ from: 350, to: 445 });

/** Deterministic PRNG seed. The same anchor always regenerates byte-identical rows. */
const DEMO_RANDOM_SEED = 0x5eed1234;

/**
 * Shopify's published revenue share on app sales above the first $1M/yr.
 *
 * Set to a non-zero rate deliberately: at 0% the Revenue page's gross/fee/net
 * columns are three copies of one number and the split is impossible to read.
 */
const SHOPIFY_FEE_RATE = 0.15;

/** Everything in the demo settles in one currency, matching `REVENUE_REPORTING_CURRENCY`. */
const DEMO_CURRENCY = 'USD';

/** How long one billing cycle is for a non-annual plan, in days. Shopify bills on 30, not calendar months. */
const MONTHLY_CYCLE_DAYS = 30;

/** How long one billing cycle is for an annual plan. */
const ANNUAL_CYCLE_DAYS = 365;

// ── Plans ───────────────────────────────────────────────────────────────────

/**
 * The four plans.
 *
 * ⚠️ `GROWTH_ANNUAL` is priced at 490, not 588, so that 490/12 = 40.8333… — a
 * number that cannot be produced by any other route. That is what makes the /12
 * rule VISIBLE on the Revenue page and assertable in the test: a round annual
 * price would divide into a monthly price that looks identical to a monthly plan.
 */
const DEMO_PLANS: Readonly<Record<string, Readonly<{ name: string; price: number; interval: string }>>> = Object.freeze({
    STARTER: Object.freeze({ name: 'Starter', price: 19, interval: 'EVERY_30_DAYS' }),
    GROWTH: Object.freeze({ name: 'Growth', price: 49, interval: 'EVERY_30_DAYS' }),
    PRO: Object.freeze({ name: 'Pro', price: 99, interval: 'EVERY_30_DAYS' }),
    GROWTH_ANNUAL: Object.freeze({ name: 'Growth Annual', price: 490, interval: 'ANNUAL' })
});

/** Plan mix for the procedural cohort, as cumulative weights over `DEMO_PLANS`. */
const DEMO_PLAN_MIX: readonly Readonly<{ plan: string; weight: number }>[] = Object.freeze([
    Object.freeze({ plan: 'STARTER', weight: 46 }),
    Object.freeze({ plan: 'GROWTH', weight: 38 }),
    Object.freeze({ plan: 'PRO', weight: 12 }),
    Object.freeze({ plan: 'GROWTH_ANNUAL', weight: 4 })
]);

// ── Geography ───────────────────────────────────────────────────────────────

/**
 * Countries, as FULL CLDR NAMES — what the GA4 export emits and what
 * `store/helpers/countryName.helper` resolves. An ISO code here would still
 * resolve, but the rollup would then be demonstrating a code path the real
 * export never takes.
 */
const DEMO_COUNTRIES: readonly Readonly<{ name: string; locale: string; weight: number }>[] = Object.freeze([
    Object.freeze({ name: 'United States', locale: 'en-US', weight: 48 }),
    Object.freeze({ name: 'United Kingdom', locale: 'en-GB', weight: 15 }),
    Object.freeze({ name: 'Canada', locale: 'en-CA', weight: 12 }),
    Object.freeze({ name: 'Australia', locale: 'en-AU', weight: 10 }),
    Object.freeze({ name: 'Germany', locale: 'de-DE', weight: 8 }),
    Object.freeze({ name: 'Netherlands', locale: 'nl-NL', weight: 7 })
]);

// ── Listing traffic ─────────────────────────────────────────────────────────

/** The (source, medium) pairs the daily source rollup is split across. */
const DEMO_TRAFFIC_SOURCES: readonly Readonly<{ traffic_source: string; traffic_medium: string; weight: number }>[] = Object.freeze([
    Object.freeze({ traffic_source: 'shopify_app_store', traffic_medium: 'organic', weight: 52 }),
    Object.freeze({ traffic_source: 'google', traffic_medium: 'organic', weight: 21 }),
    Object.freeze({ traffic_source: 'shopify_app_store', traffic_medium: 'cpc', weight: 14 }),
    Object.freeze({ traffic_source: '(direct)', traffic_medium: '(none)', weight: 8 }),
    Object.freeze({ traffic_source: 'youtube.com', traffic_medium: 'referral', weight: 5 })
]);

/**
 * The attribution shapes a store can be installed through, one per acquisition
 * channel `conversion/helpers/acquisitionChannel` can classify.
 *
 * ⚠️ The `surface_type` values are load-bearing, not decoration.
 * `shared/constants/surface.constants` decides PAID by the `_ad` suffix and
 * SEARCH by membership of a fixed list, so `search_ad` classifies as
 * APP_STORE_AD and `search` as APP_STORE_SEARCH. A blank surface falls through
 * to source/medium, which is how ORGANIC_SEARCH, REFERRAL and DIRECT are
 * reached. A store with NO attribution row at all is UNKNOWN — a real state,
 * and one of the cases this dataset has to contain.
 *
 * `surface_detail` is deliberately blank on the two SEARCH rows, and only there.
 * On a search surface that field is the merchant's typed App Store query, which
 * this build neither captures nor renders, so the demo dataset must not ship a
 * fabricated one either. On BROWSE surfaces the same field is Shopify's own
 * taxonomy handle and stays populated — `surface.constants` reads it to tell a
 * paid placement from organic browsing, so blanking it there would move installs
 * between columns.
 */
const DEMO_ATTRIBUTION_SURFACES: Readonly<Record<string, Readonly<{
    source: string;
    medium: string;
    campaign: string;
    attribution_source: string;
    surface_type: string;
    surface_detail: string;
    surface_via: string;
    weight: number;
}>>> = Object.freeze({
    SEARCH: Object.freeze({
        source: 'shopify_app_store',
        medium: 'organic',
        campaign: '',
        attribution_source: 'shopify_app_store',
        surface_type: 'search',
        surface_detail: '',
        surface_via: 'listing_url',
        weight: 40
    }),
    SEARCH_AD: Object.freeze({
        source: 'shopify_app_store',
        medium: 'cpc',
        campaign: 'app_store_search_ads',
        attribution_source: 'shopify_app_store',
        surface_type: 'search_ad',
        surface_detail: '',
        surface_via: 'ad_click_event',
        weight: 16
    }),
    BROWSE: Object.freeze({
        source: 'shopify_app_store',
        medium: 'organic',
        campaign: '',
        attribution_source: 'shopify_app_store',
        surface_type: 'category',
        surface_detail: 'inventory-management',
        surface_via: 'listing_url',
        weight: 18
    }),
    ORGANIC: Object.freeze({
        source: 'google',
        medium: 'organic',
        campaign: '',
        attribution_source: 'external',
        surface_type: '',
        surface_detail: '',
        surface_via: 'listing_url',
        weight: 14
    }),
    REFERRAL: Object.freeze({
        source: 'youtube.com',
        medium: 'referral',
        campaign: '',
        attribution_source: 'external',
        surface_type: '',
        surface_detail: '',
        surface_via: 'listing_url',
        weight: 7
    }),
    DIRECT: Object.freeze({
        source: '(direct)',
        medium: '(none)',
        campaign: '',
        attribution_source: 'external',
        surface_type: '',
        surface_detail: '',
        surface_via: 'listing_url',
        weight: 5
    })
});

/** Share of procedural installs GA4 never attributed. The rest of the funnel's honesty depends on this being non-zero. */
const UNATTRIBUTED_INSTALL_SHARE = 0.12;

// ── Listing funnel shape ────────────────────────────────────────────────────

/**
 * Daily listing views, growing across the window.
 *
 * The funnel below these is built TOP-DOWN from views and then LIFTED so every
 * step is at least as large as the step under it — see `_liftMonotone`. A funnel
 * whose installs exceed its consent completions is not a small inconsistency, it
 * is a chart that reads as broken.
 */
const LISTING_VIEWS_START = 26;
const LISTING_VIEWS_END = 62;

/** Weekday multipliers, Sunday first. Merchants browse the app store on weekdays. */
const LISTING_WEEKDAY_FACTORS: readonly number[] = Object.freeze([0.62, 1.12, 1.15, 1.10, 1.06, 0.95, 0.66]);

/** Fractions of views. Each is a real ratio from a small app's listing analytics. */
const LISTING_ENGAGED_VIEW_RATE = 0.58;
const LISTING_INSTALL_CLICK_RATE = 0.078;
const LISTING_CONSENT_START_RATE = 0.55;
const LISTING_CONSENT_COMPLETE_RATE = 0.80;
const LISTING_SESSION_RATE = 0.72;
const LISTING_FIRST_VISIT_RATE = 0.46;

/** Installs per view. Drives how many procedural stores the cohort ends up with. */
const LISTING_INSTALL_RATE = 0.012;

// ── The procedural cohort's lifecycle ───────────────────────────────────────

/** Share of installs that never start a trial at all. */
const PROCEDURAL_NO_TRIAL_SHARE = 0.34;
/** Of those, the share that later uninstall. */
const PROCEDURAL_NO_TRIAL_UNINSTALL_SHARE = 0.45;
/** Share of trials that reach billing. The rest abandon before `billing_on`. */
const PROCEDURAL_TRIAL_CONVERSION_SHARE = 0.52;
/** Monthly churn hazard applied to a converted subscription. */
const PROCEDURAL_MONTHLY_CHURN_HAZARD = 0.055;
/** Share of surviving subscriptions that upgrade once. */
const PROCEDURAL_UPGRADE_SHARE = 0.09;
/** Share of surviving subscriptions that downgrade once. */
const PROCEDURAL_DOWNGRADE_SHARE = 0.05;
/** The standard free trial. */
const DEMO_TRIAL_DAYS = 14;

// ── The hand-written cast ───────────────────────────────────────────────────

/**
 * Sixteen stores, each carrying one edge case the product exists to handle.
 *
 * ⚠️ Every `*_days_ago` here is checked against `QUIET_SAFE_BAND_DAYS` at
 * generation time. Read that constant before changing one.
 */
const DEMO_NAMED_STORES = Object.freeze([
    // The plain healthy case. Long-tenured, one plan, never changed — the row every
    // other row on the Stores page is read against.
    Object.freeze({
        slug: 'northwind',
        name: 'Northwind Supply',
        country: 'United States',
        installed_days_ago: 512,
        uninstalled_days_ago: null,
        reinstalled_days_ago: null,
        deactivated_days_ago: null,
        attribution: 'SEARCH',
        credits: Object.freeze([]),
        subscriptions: Object.freeze([
            Object.freeze({
                plan: 'GROWTH',
                accepted_days_ago: 512,
                trial_days: 14,
                converted: true,
                ended_days_ago: null,
                end_event: null,
                skip_last_payouts: 0,
                test: false,
                events_suppressed: false
            })
        ])
    }),

    // EXPANSION. Shopify does not "change a plan": it cancels one charge and accepts
    // another. Two subscriptions, one domain — which is also what makes
    // `subscriptions_superseded` non-zero and the per-domain winner rule visible.
    Object.freeze({
        slug: 'brightpath',
        name: 'Brightpath Goods',
        country: 'United Kingdom',
        installed_days_ago: 465,
        uninstalled_days_ago: null,
        reinstalled_days_ago: null,
        deactivated_days_ago: null,
        attribution: 'BROWSE',
        credits: Object.freeze([]),
        subscriptions: Object.freeze([
            Object.freeze({
                plan: 'STARTER',
                accepted_days_ago: 465,
                trial_days: 14,
                converted: true,
                ended_days_ago: 181,
                end_event: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_CANCELLED,
                skip_last_payouts: 0,
                test: false,
                events_suppressed: false
            }),
            Object.freeze({
                plan: 'PRO',
                accepted_days_ago: 181,
                trial_days: 0,
                converted: true,
                ended_days_ago: null,
                end_event: null,
                skip_last_payouts: 0,
                test: false,
                events_suppressed: false
            })
        ])
    }),

    // CONTRACTION — the same mechanism downward, so the movement card has a
    // contraction row that is not a churn.
    Object.freeze({
        slug: 'cedarworks',
        name: 'Cedar & Co Works',
        country: 'Canada',
        installed_days_ago: 340,
        uninstalled_days_ago: null,
        reinstalled_days_ago: null,
        deactivated_days_ago: null,
        attribution: 'SEARCH_AD',
        credits: Object.freeze([]),
        subscriptions: Object.freeze([
            Object.freeze({
                plan: 'PRO',
                accepted_days_ago: 340,
                trial_days: 14,
                converted: true,
                ended_days_ago: 124,
                end_event: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_CANCELLED,
                skip_last_payouts: 0,
                test: false,
                events_suppressed: false
            }),
            Object.freeze({
                plan: 'GROWTH',
                accepted_days_ago: 124,
                trial_days: 0,
                converted: true,
                ended_days_ago: null,
                end_event: null,
                skip_last_payouts: 0,
                test: false,
                events_suppressed: false
            })
        ])
    }),

    // THE ANNUAL SUBSCRIBER. One settled payout of 490 in the last 400 days and
    // none since. Under a fixed 38-day window this shop vanishes from MRR for
    // eleven months of every twelve; under the interval-aware window it stays live
    // and contributes 490/12 = 40.8333…, which is the /12 rule made visible.
    Object.freeze({
        slug: 'lumen',
        name: 'Lumen Atelier',
        country: 'Australia',
        installed_days_ago: 330,
        uninstalled_days_ago: null,
        reinstalled_days_ago: null,
        deactivated_days_ago: null,
        attribution: 'ORGANIC',
        credits: Object.freeze([]),
        subscriptions: Object.freeze([
            Object.freeze({
                plan: 'GROWTH_ANNUAL',
                accepted_days_ago: 330,
                trial_days: 14,
                converted: true,
                ended_days_ago: null,
                end_event: null,
                skip_last_payouts: 0,
                test: false,
                events_suppressed: false
            })
        ])
    }),

    // CHURNED AFTER CONVERTING, with a partial refund. Cancelled AND uninstalled, so
    // the end is unambiguous, and the credit is why cash and run-rate disagree that
    // month — which is the disagreement the Revenue page is built to show.
    Object.freeze({
        slug: 'quarry',
        name: 'Quarry Lane Ceramics',
        country: 'United States',
        installed_days_ago: 300,
        uninstalled_days_ago: 88,
        reinstalled_days_ago: null,
        deactivated_days_ago: null,
        attribution: 'SEARCH',
        credits: Object.freeze([Object.freeze({ days_ago: 86, amount: 49 })]),
        subscriptions: Object.freeze([
            Object.freeze({
                plan: 'GROWTH',
                accepted_days_ago: 300,
                trial_days: 14,
                converted: true,
                ended_days_ago: 88,
                end_event: PARTNER_EVENT_TYPES.SUBSCRIPTION_CHARGE_CANCELLED,
                skip_last_payouts: 0,
                test: false,
                events_suppressed: false
            })
        ])
    }),

    // ABANDONED IN TRIAL. The charge was ACCEPTED and carries a `billingOn` in the
    // future; no ACTIVATED ever followed and the merchant uninstalled first. The
    // trial's promised billing date exists on an abandoned trial too — reading it
    // as a conversion is the bug this row is here to keep visible.
    Object.freeze({
        slug: 'tidepool',
        name: 'Tidepool Provisions',
        country: 'Germany',
        installed_days_ago: 250,
        uninstalled_days_ago: 242,
        reinstalled_days_ago: null,
        deactivated_days_ago: null,
        attribution: 'BROWSE',
        credits: Object.freeze([]),
        subscriptions: Object.freeze([
            Object.freeze({
                plan: 'GROWTH',
                accepted_days_ago: 250,
                trial_days: 14,
                converted: false,
                ended_days_ago: null,
                end_event: null,
                skip_last_payouts: 0,
                test: false,
                events_suppressed: false
            })
        ])
    }),

    // LATE PAYOUTS, WHICH ARE NOT A CANCELLATION. Billing started 214 days ago,
    // so payouts land at 214, 184, … 34, 4 days ago — and the LAST one is dropped,
    // because Shopify has not settled the current cycle yet. The shop's most recent
    // settled charge is therefore 34 days old: older than a 30-day cycle, inside the
    // 38-day grace, and still paying. Narrow the window and this store falsely
    // churns; that is the reading that produced 47.6% churn in a month nobody left.
    Object.freeze({
        slug: 'harborline',
        name: 'Harborline Outfitters',
        country: 'United Kingdom',
        installed_days_ago: 232,
        uninstalled_days_ago: null,
        reinstalled_days_ago: null,
        deactivated_days_ago: null,
        attribution: 'SEARCH',
        credits: Object.freeze([]),
        subscriptions: Object.freeze([
            Object.freeze({
                plan: 'GROWTH',
                accepted_days_ago: 228,
                trial_days: 14,
                converted: true,
                ended_days_ago: null,
                end_event: null,
                skip_last_payouts: 1,
                test: false,
                events_suppressed: false
            })
        ])
    }),

    // INSTALLED BEFORE THE SYNCED WINDOW. No relationship events and no charge
    // events at all — only settled payouts, reaching further back than any event
    // this app holds. It is invisible to every fold over the event spine and fully
    // visible to the ledger, which is precisely why MRR is derived from payouts and
    // not from replayed timelines. It is also what makes `earliest_event_at` and
    // `earliest_transaction_at` differ on this app.
    Object.freeze({
        slug: 'saltmarsh',
        name: 'Saltmarsh Trading Co',
        country: 'United States',
        installed_days_ago: null,
        uninstalled_days_ago: null,
        reinstalled_days_ago: null,
        deactivated_days_ago: null,
        attribution: null,
        credits: Object.freeze([]),
        subscriptions: Object.freeze([
            Object.freeze({
                plan: 'PRO',
                accepted_days_ago: 590,
                trial_days: 0,
                converted: true,
                ended_days_ago: null,
                end_event: null,
                skip_last_payouts: 0,
                test: false,
                events_suppressed: true
            })
        ])
    }),

    // NO GA4 ATTRIBUTION. A paying store with no row in the attribution collection,
    // so its acquisition channel is UNKNOWN — "Not attributed", which is an answer,
    // not a zero.
    Object.freeze({
        slug: 'fernway',
        name: 'Fernway Home',
        country: 'Canada',
        installed_days_ago: 152,
        uninstalled_days_ago: null,
        reinstalled_days_ago: null,
        deactivated_days_ago: null,
        attribution: null,
        credits: Object.freeze([]),
        subscriptions: Object.freeze([
            Object.freeze({
                plan: 'STARTER',
                accepted_days_ago: 152,
                trial_days: 14,
                converted: true,
                ended_days_ago: null,
                end_event: null,
                skip_last_payouts: 0,
                test: false,
                events_suppressed: false
            })
        ])
    }),

    // A TEST SUBSCRIPTION. `charge.test` is true, so every cohort excludes it and
    // counts the exclusion — the store shows as installed-only with a warning that
    // says why, rather than silently reading as a lost conversion.
    Object.freeze({
        slug: 'forgeandlast',
        name: 'Forge & Last',
        country: 'United States',
        installed_days_ago: 140,
        uninstalled_days_ago: null,
        reinstalled_days_ago: null,
        deactivated_days_ago: null,
        attribution: 'DIRECT',
        credits: Object.freeze([]),
        subscriptions: Object.freeze([
            Object.freeze({
                plan: 'GROWTH',
                accepted_days_ago: 140,
                trial_days: 14,
                converted: true,
                ended_days_ago: null,
                end_event: null,
                skip_last_payouts: 0,
                test: true,
                events_suppressed: false
            })
        ])
    }),

    // Paid acquisition, still paying — the ad channel needs a converted store or the
    // channel breakdown has an empty leg.
    Object.freeze({
        slug: 'pinecrest',
        name: 'Pinecrest Outfitters',
        country: 'Australia',
        installed_days_ago: 121,
        uninstalled_days_ago: null,
        reinstalled_days_ago: null,
        deactivated_days_ago: null,
        attribution: 'SEARCH_AD',
        credits: Object.freeze([]),
        subscriptions: Object.freeze([
            Object.freeze({
                plan: 'GROWTH',
                accepted_days_ago: 121,
                trial_days: 14,
                converted: true,
                ended_days_ago: null,
                end_event: null,
                skip_last_payouts: 0,
                test: false,
                events_suppressed: false
            })
        ])
    }),

    // FROZEN, NOT CANCELLED. `RelationshipDeactivated` with no cancel event and no
    // further payouts. A fold that only knows INSTALL and UNINSTALL leaves this store
    // permanently installed and permanently paying; the ledger drops it 38 days after
    // its last settled charge, which is the correct answer arrived at honestly.
    Object.freeze({
        slug: 'stonebridge',
        name: 'Stonebridge Wares',
        country: 'Germany',
        installed_days_ago: 181,
        uninstalled_days_ago: null,
        reinstalled_days_ago: null,
        deactivated_days_ago: 70,
        attribution: 'ORGANIC',
        credits: Object.freeze([]),
        subscriptions: Object.freeze([
            Object.freeze({
                plan: 'STARTER',
                accepted_days_ago: 181,
                trial_days: 14,
                converted: true,
                ended_days_ago: null,
                end_event: null,
                skip_last_payouts: 0,
                test: false,
                events_suppressed: false
            })
        ])
    }),

    // UNINSTALL WITH NO INSTALL RECORD. The install predates the window; only the
    // departure is inside it. This is what makes `stores_without_install_record`
    // non-zero, and that warning is the difference between a coverage boundary being
    // reported and being mistaken for data loss.
    Object.freeze({
        slug: 'ashgrove',
        name: 'Ashgrove Handmade',
        country: 'United States',
        installed_days_ago: null,
        uninstalled_days_ago: 95,
        reinstalled_days_ago: null,
        deactivated_days_ago: null,
        attribution: null,
        credits: Object.freeze([]),
        subscriptions: Object.freeze([])
    }),

    // Referral acquisition, recently converted.
    Object.freeze({
        slug: 'riverbend',
        name: 'Riverbend Studio',
        country: 'Netherlands',
        installed_days_ago: 76,
        uninstalled_days_ago: null,
        reinstalled_days_ago: null,
        deactivated_days_ago: null,
        attribution: 'REFERRAL',
        credits: Object.freeze([]),
        subscriptions: Object.freeze([
            Object.freeze({
                plan: 'STARTER',
                accepted_days_ago: 76,
                trial_days: 14,
                converted: true,
                ended_days_ago: null,
                end_event: null,
                skip_last_payouts: 0,
                test: false,
                events_suppressed: false
            })
        ])
    }),

    // REINSTALL. Left 201 days ago, came back 61 days ago and converted. A fold that
    // ignores `RelationshipReactivated` leaves this store uninstalled for ever, which
    // is wrong and silent.
    Object.freeze({
        slug: 'meadowlark',
        name: 'Meadowlark & Sons',
        country: 'United Kingdom',
        installed_days_ago: 262,
        uninstalled_days_ago: 201,
        reinstalled_days_ago: 61,
        deactivated_days_ago: null,
        attribution: 'SEARCH',
        credits: Object.freeze([]),
        subscriptions: Object.freeze([
            Object.freeze({
                plan: 'GROWTH',
                accepted_days_ago: 61,
                trial_days: 14,
                converted: true,
                ended_days_ago: null,
                end_event: null,
                skip_last_payouts: 0,
                test: false,
                events_suppressed: false
            })
        ])
    }),

    // INSTALLED ONLY. Never started a trial. A real and common state, and the one
    // most easily lost by a funnel that starts at "trials".
    Object.freeze({
        slug: 'oakhollow',
        name: 'Oak Hollow Mercantile',
        country: 'United States',
        installed_days_ago: 45,
        uninstalled_days_ago: null,
        reinstalled_days_ago: null,
        deactivated_days_ago: null,
        attribution: 'DIRECT',
        credits: Object.freeze([]),
        subscriptions: Object.freeze([])
    }),

    // ON TRIAL RIGHT NOW. `billingOn` is five days in the FUTURE, so the classifier
    // must answer ON_TRIAL and not PAYING — the one case that depends on comparing
    // the promised billing date against the judgement instant.
    Object.freeze({
        slug: 'glasshouse',
        name: 'Glasshouse Botanics',
        country: 'United States',
        installed_days_ago: 9,
        uninstalled_days_ago: null,
        reinstalled_days_ago: null,
        deactivated_days_ago: null,
        attribution: 'SEARCH',
        credits: Object.freeze([]),
        subscriptions: Object.freeze([
            Object.freeze({
                plan: 'GROWTH',
                accepted_days_ago: 9,
                trial_days: 14,
                converted: false,
                ended_days_ago: null,
                end_event: null,
                skip_last_payouts: 0,
                test: false,
                events_suppressed: false
            })
        ])
    })
]);

// ── Sync history ────────────────────────────────────────────────────────────

/** How many completed runs the Sync page shows, so it is not an empty table. */
const DEMO_SYNC_JOB_COUNT = 12;

/** Hours between the demo's synthetic cron runs. */
const DEMO_SYNC_JOB_INTERVAL_HOURS = 6;

export = {
    DEMO_MARKER,
    DEMO_SEED_VERSION,
    DEMO_DOMAIN_SUFFIX,
    DEMO_DOMAIN_PREFIX,
    DEMO_APP,
    HISTORY_DAYS,
    LEDGER_HISTORY_DAYS,
    QUIET_MONTHS_BACK,
    QUIET_PADDING_DAYS,
    QUIET_SAFE_BAND_DAYS,
    DEMO_RANDOM_SEED,
    SHOPIFY_FEE_RATE,
    DEMO_CURRENCY,
    MONTHLY_CYCLE_DAYS,
    ANNUAL_CYCLE_DAYS,
    DEMO_PLANS,
    DEMO_PLAN_MIX,
    DEMO_COUNTRIES,
    DEMO_TRAFFIC_SOURCES,
    DEMO_ATTRIBUTION_SURFACES,
    UNATTRIBUTED_INSTALL_SHARE,
    LISTING_VIEWS_START,
    LISTING_VIEWS_END,
    LISTING_WEEKDAY_FACTORS,
    LISTING_ENGAGED_VIEW_RATE,
    LISTING_INSTALL_CLICK_RATE,
    LISTING_CONSENT_START_RATE,
    LISTING_CONSENT_COMPLETE_RATE,
    LISTING_SESSION_RATE,
    LISTING_FIRST_VISIT_RATE,
    LISTING_INSTALL_RATE,
    PROCEDURAL_NO_TRIAL_SHARE,
    PROCEDURAL_NO_TRIAL_UNINSTALL_SHARE,
    PROCEDURAL_TRIAL_CONVERSION_SHARE,
    PROCEDURAL_MONTHLY_CHURN_HAZARD,
    PROCEDURAL_UPGRADE_SHARE,
    PROCEDURAL_DOWNGRADE_SHARE,
    DEMO_TRIAL_DAYS,
    DEMO_NAMED_STORES,
    DEMO_SYNC_JOB_COUNT,
    DEMO_SYNC_JOB_INTERVAL_HOURS
};
