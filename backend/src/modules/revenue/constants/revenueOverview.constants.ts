'use strict';

/**
 * ============================================================================
 *  THE REVENUE OVERVIEW'S VOCABULARY
 * ============================================================================
 *
 *  Every enum, cap and label the windowed revenue view publishes. They live here rather than beside
 *  their use so that one wire value cannot acquire two spellings — the frontend mirrors three of
 *  these maps by hand (`components/growth-intel/store/storePresentation.js`), and a string that
 *  agrees by coincidence rather than by construction is a badge that silently renders its own raw
 *  SCREAMING_SNAKE value the day somebody renames it here.
 *
 *  ⚠️ `Object.freeze` stays on every value. Nothing here is a mongoose enum today, but these objects
 *  are read from a pure helper and a service in the same request, and a mutable shared vocabulary is
 *  a vocabulary one caller can edit for everybody else.
 * ============================================================================
 */

/**
 * The four forces that move MRR across a window, as the drill-down panel names them.
 *
 * ⚠️ THESE FOUR KEYS ARE THE PANEL'S OWN. `RevenueMovementStats` calls `onSelectBucket(b.key)` with
 * exactly these strings and `pages/revenue/index.js` then reads
 * `movement_shops[bucket]`, so the response's bucket names and the card's block keys are ONE
 * vocabulary. Renaming a member here without renaming it there opens an empty panel — no error, no
 * warning, just a drill-down that says "no store moved in this period" over stores that did.
 *
 * START and END are deliberately ABSENT. They are BALANCES rather than movements, so there is no set
 * of stores behind them to list, and the card never makes them clickable.
 */
const MOVEMENT_BUCKETS = Object.freeze({
    /** Paying at the close, absent at the open. */
    NEW: 'new',
    /** Paying at both ends, for MORE at the close. */
    EXPANSION: 'expansion',
    /** Paying at both ends, for LESS at the close. */
    CONTRACTION: 'contraction',
    /** Paying at the open, absent at the close. */
    CHURNED: 'churned'
} as const);

/** The buckets in equation order — Start, +new, +expansion, −contraction, −churn, End. */
const MOVEMENT_BUCKET_ORDER: readonly string[] = Object.freeze([
    MOVEMENT_BUCKETS.NEW,
    MOVEMENT_BUCKETS.EXPANSION,
    MOVEMENT_BUCKETS.CONTRACTION,
    MOVEMENT_BUCKETS.CHURNED
]);

/**
 * What has happened to a movement row's store BETWEEN the period close and NOW.
 *
 * ⚠️ A THIRD VOCABULARY, AND NO WORD IS SHARED WITH THE OTHER TWO. The lifecycle states
 * (`ON_TRIAL`, `PAYING`, …) and the install states (`INSTALLED`, `UNINSTALLED`, `UNKNOWN`) are both
 * SNAPSHOTS — "what is this store". These six are DELTAS — "what changed between two instants" —
 * which is the question the drill-down is actually asking. `INSTALLED` already means two different
 * things across the two existing groups and survives only because they are separately labelled; a
 * third meaning would make the collision unrecoverable.
 *
 * ⚠️ IT IS ONLY ABOUT MONEY. `STOPPED_PAYING` means "not on a paid plan today" and says NOTHING
 * about whether the app is still installed — that is a different fact from a different source. The
 * frontend keeps them in separate columns for exactly that reason.
 *
 * Word for word with `MOVEMENT_SINCE_LABELS` in
 * `frontend/components/growth-intel/store/storePresentation.js`, which maps each key to a badge.
 */
const MOVEMENT_SINCE_STATES = Object.freeze({
    /** Still paying, same plan name and same amount. */
    SAME_PLAN: 'SAME_PLAN',
    /** Still paying the same amount, on a differently named plan. */
    PLAN_CHANGED: 'PLAN_CHANGED',
    /** Paying MORE today than at the period close. */
    UPGRADED: 'UPGRADED',
    /** Paying LESS today, but still a paying customer. */
    DOWNGRADED: 'DOWNGRADED',
    /**
     * Not on a paid plan today.
     *
     * ⚠️ This CANNOT tell a move to the free plan from a charge that simply stopped, and it must
     * never be labelled either way. Both readings are consistent with the same absence.
     */
    STOPPED_PAYING: 'STOPPED_PAYING',
    /** Absent from the paying set at the period close and present in it today. */
    RESUBSCRIBED: 'RESUBSCRIBED'
} as const);

/*
 *  `CHURN_DATE_BASES` IS DELIBERATELY NOT DECLARED HERE.
 *
 * `partner_event` / `ledger_window` are ONE WIRE VALUE ON THREE ENDPOINTS — logo churn counts the
 * merchants leaving, revenue churn prices them, and this page lists them in its movement panel. The
 * vocabulary and the derivation that produces it both live in `modules/conversion` and are reached
 * through that barrel (`CHURN_DATE_BASES`, `resolveChurnDate`), never restated. A second copy of the
 * two literals in this module is how one string acquires two spellings and the same merchant reads
 * two different ways on two pages an operator has open side by side.
 */

/**
 * The plan label for a paying store whose subscription events we do not hold.
 *
 * ⚠️ A LABEL, NOT A GUESS. The store IS paying — the ledger says so — and we simply have no charge
 * event naming its plan. Filing it under the largest plan, or under the plan it is on today, would
 * move a customer between rows of a table that is supposed to partition the paying base.
 */
const UNKNOWN_PLAN_LABEL = 'Unknown plan';

/**
 * How many months of MRR-and-cash history the trend chart may carry.
 *
 * The floor exists because a one-month window would otherwise draw a chart with a single bar, which
 * reads as a business with one month of history. The window's own months are always in range; the
 * rest are drawn shaded, as context.
 */
const MIN_TREND_MONTHS = 6;
const MAX_TREND_MONTHS = 36;

/** How many shops the lifetime-cash ranking carries. Matches `GET /api/revenue/now`'s own cap. */
const TOP_SHOPS_LIMIT = 50;

/**
 *  THERE IS NO CAP ON `movement_shops`, AND ADDING ONE IS A BUG.
 *
 * The movement card prints "23 stores" from `new_count`, and clicking it opens `movement_shops.new`.
 * Those two numbers are the SAME number — the count is `list.length` — precisely so a card and its
 * drill-down cannot disagree. Truncating the list while keeping the count makes the card lie;
 * truncating both hides stores that moved. The constant below records the decision so that a future
 * "just add a limit" arrives as a conversation rather than as a silent divergence.
 */
const MOVEMENT_SHOPS_LIMIT = null;

/**
 * How many shop domains one `POST /api/revenue/shop-plans` call may resolve.
 *
 * Matches the `.slice(0, 200)` the Revenue page already applies before it calls, so the cap is a
 * restatement of the client's own bound rather than a new refusal. Over it, the request is CLAMPED
 * and warned about — never rejected: an oversized batch is a caller's bug, and answering 200 of 250
 * domains with a warning is more useful than answering none of them with a 400.
 */
const MAX_SHOP_PLAN_DOMAINS = 200;

/** Named for the reader, not for the file it came from — these appear on the dashboard. */
const SOURCE_PAYOUTS = 'settled payouts';
const SOURCE_CHARGE_EVENTS = 'partner charge events';

export = {
    MOVEMENT_BUCKETS,
    MOVEMENT_BUCKET_ORDER,
    MOVEMENT_SINCE_STATES,
    UNKNOWN_PLAN_LABEL,
    MIN_TREND_MONTHS,
    MAX_TREND_MONTHS,
    TOP_SHOPS_LIMIT,
    MAX_SHOP_PLAN_DOMAINS,
    MOVEMENT_SHOPS_LIMIT,
    SOURCE_PAYOUTS,
    SOURCE_CHARGE_EVENTS
};
