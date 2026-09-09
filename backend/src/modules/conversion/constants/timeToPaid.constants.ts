'use strict';

/**
 * ============================================================================
 *  TIME TO PAID — the histogram buckets, and the three ways a store leaves it
 * ============================================================================
 *
 *  The vocabulary behind `GET /api/conversion/time-to-paid`. Numbers and labels only.
 *
 *  ──  A STORE THAT HAS NOT CONVERTED IS NOT "DAY 0" AND NOT "60+ DAYS" ─────────────────────
 *
 *  It has NO time-to-paid, and the only honest thing to do with it is take it out of the histogram
 *  and say how many were taken out. Both of the tempting alternatives are fabrications:
 *
 *    - bucketing it at 0 puts every merchant who never paid into "Same day", which is the bar an
 *      operator reads as their best possible outcome. On a young app the first bar would be the
 *      tallest one on the chart and it would be made entirely of failures;
 *    - bucketing it in the last bucket claims they converted eventually and slowly, which moves the
 *      median and the p75 the strip beneath the chart prints as measurements.
 *
 *  `TimeToPaidHistogram.js:21` reads `data.total_paid_shops` and captions the chart with it, and
 *  `:47` divides every bar by that total — so the histogram is a partition of CONVERTED stores and
 *  nothing else. The exclusions are published in `excluded` and pushed into `warnings[]`.
 *
 *  ── THE BUCKET LABELS ARE REACT KEYS ────────────────────────────────────────────────────────
 *
 *  `TimeToPaidHistogram.js:48` keys each row by `b.label`. Two buckets sharing a label is a duplicate
 *  key — the second is dropped by React rather than drawn twice — so a bar disappears with its count
 *  and the percentages beside the survivors no longer sum. Every label below is distinct, and the
 *  ranges are contiguous and non-overlapping so a day lands in exactly one.
 * ============================================================================
 */

/**
 * The histogram buckets, in reading order.
 *
 * `max_days: null` means "no upper bound" — the open-ended tail. Bounds are INCLUSIVE on both ends
 * and the ranges are contiguous: 0 | 1–3 | 4–7 | 8–14 | 15–30 | 31–60 | 61+. A gap would silently
 * drop a day's worth of stores out of a chart that presents itself as a partition.
 */
const TIME_TO_PAID_BUCKETS: readonly { key: string; label: string; min_days: number; max_days: number | null }[] =
    Object.freeze([
        { key: 'd0', label: 'Same day', min_days: 0, max_days: 0 },
        { key: 'd1_3', label: '1–3 days', min_days: 1, max_days: 3 },
        { key: 'd4_7', label: '4–7 days', min_days: 4, max_days: 7 },
        { key: 'd8_14', label: '8–14 days', min_days: 8, max_days: 14 },
        { key: 'd15_30', label: '15–30 days', min_days: 15, max_days: 30 },
        { key: 'd31_60', label: '31–60 days', min_days: 31, max_days: 60 },
        { key: 'd61_plus', label: '60+ days', min_days: 61, max_days: null }
    ]);

/**
 * Why a store on the install spine produced no time-to-paid figure.
 *
 * THREE REASONS, SEPARATED, because they call for three different responses and only one of them
 * is about the merchant. Collapsing them into a single "excluded" count would hide a build-side
 * coverage problem inside a business-side one.
 */
const TIME_TO_PAID_EXCLUSIONS = Object.freeze({
    /** No subscription reached paid billing. The ordinary case, and a fact about the funnel. */
    NOT_CONVERTED: 'not_converted',
    /**
     * It DID reach paid billing, on settled-payout evidence, but Shopify supplied no `charge.billingOn`
     * — so there is no date to measure to. ⚠️ A COVERAGE gap, not a merchant behaviour: these stores
     * are real conversions missing from the histogram, so `total_paid_shops` is a FLOOR.
     */
    CONVERTED_WITHOUT_BILLING_DATE: 'converted_without_billing_date',
    /**
     * Its billing date sits BEFORE its install on the spine. A clock-skew or re-install artefact:
     * the store installed, subscribed, uninstalled and re-installed inside the window, so the spine's
     * `$min(occurred_at)` is later than the subscription that predates it. Counted rather than
     * clamped to 0, which would put a re-installer in the "Same day" bar.
     */
    CONVERTED_BEFORE_INSTALL: 'converted_before_install'
} as const);

/** Same two `data_state` values as every other cohort read, decided by the WATERMARK. */
const TIME_TO_PAID_DATA_STATES = Object.freeze({
    READY: 'READY',
    NEVER_SYNCED: 'NEVER_SYNCED'
} as const);

export = {
    TIME_TO_PAID_BUCKETS,
    TIME_TO_PAID_EXCLUSIONS,
    TIME_TO_PAID_DATA_STATES
};
