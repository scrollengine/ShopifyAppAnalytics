/**
 * ============================================================================
 *  COVERAGE — how much of the partner history we actually hold
 * ============================================================================
 *
 *  This measures the one fact the entire design rests on and cannot assume:
 *  how far back the Partner API record really reaches, and whether `charge_id`
 *  genuinely bridges events to transactions.
 *
 *  It matters because every figure downstream is a fold over two collections,
 *  and an incomplete collection does not fail — it answers. A month that was
 *  never synced and a month in which nothing happened return the same empty
 *  result set, and the fold happily reports `0`. The honesty envelope can only
 *  refuse to publish that zero if something has measured the difference; these
 *  six numbers are that measurement, and they are written onto the app row as
 *  the coverage gates a service reads before it publishes anything.
 *
 *  PURE — no models, no config, no clock reads, no I/O. The extremes and counts
 *  are gathered by `repositories/partnerCoverage.repository` and handed in, so
 *  every rule below is a function of its arguments and can be unit-tested with
 *  no database. That is deliberate: this is the primitive that decides whether
 *  other numbers may be published, so it is the last place that should need a
 *  running Mongo to verify.
 *
 *  ── THE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────────
 *  `null` and `0` are different answers and are never interchangeable here.
 *      null = not measurable (nothing to measure it from)
 *      0    = measured, and the answer is none
 *  Every function below returns `null` rather than a comfortable zero whenever
 *  its denominator is empty. A caller that treats the two alike re-introduces
 *  exactly the failure this project exists to refuse.
 * ============================================================================
 */

import type { CoverageInputs, CoverageRecord, TransactionChargeRowCount } from '../types/coverage.types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Turns a ratio into a percentage in the 0–100 range, or null when there is nothing to divide by.
 *
 * Two deliberate behaviours:
 *
 *   - An empty denominator returns `null`, NOT `0`. "None of zero rows are missing a link" is not
 *     a statement that the links are fine; it is a statement that there was nothing to check.
 *   - A genuinely non-zero share never rounds down to `0`. One dangling link in 50,000 rows is
 *     0.002%, which two-decimal rounding would render as `0.00` — indistinguishable from a clean
 *     bill of health. It is floored at 0.01 instead, so "small" and "none" stay distinguishable.
 *
 * @param numerator - Rows exhibiting the condition.
 * @param denominator - Rows that could have exhibited it.
 * @returns 0–100 to two decimals, or null when the denominator is empty.
 */
const _toPercentage = (numerator: number, denominator: number): number | null => {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
        return null;
    }
    const _raw = (numerator / denominator) * 100;
    if (!Number.isFinite(_raw) || _raw <= 0) {
        return 0;
    }
    const _rounded = Math.round(_raw * 100) / 100;
    if (_rounded === 0) {
        return 0.01;
    }
    if (_rounded > 100) {
        return 100;
    }
    return _rounded;
};

/**
 * The longest run of consecutive EVENT-FREE days inside the covered window.
 *
 * ── The definition, precisely, because an ambiguous one makes the metric useless ──
 * Input is the set of distinct UTC days that carry at least one event. For each adjacent pair the
 * gap is the number of days BETWEEN them: events on the 1st and the 2nd give 0 (nothing missing),
 * the 1st and the 5th give 3. The answer is the widest such gap.
 *
 * So `0` means every day with an event sits next to another one, and `null` means fewer than two
 * days carry events at all — there is no pair, so no gap exists to be measured. An app with a
 * single day of history has an UNKNOWN gap, not a gap of zero.
 *
 * ── What it can and cannot tell you ──
 * A wide gap has two possible causes and the data alone cannot separate them: a genuinely quiet
 * stretch, or a sync window that failed and was never re-pulled. That is why this is published as a
 * caveat on any figure whose window spans it rather than resolved into a verdict — resolving it
 * would mean guessing, and a confident guess is the thing this codebase is built to avoid.
 *
 * The input is sorted defensively rather than trusted. An unsorted list would yield negative spans,
 * every one of which loses the `>` comparison below, and the function would quietly return a
 * too-small gap — a coverage metric that under-reports its own uncertainty is worse than none.
 *
 * @param dayBuckets - Distinct UTC day boundaries that carry at least one event.
 * @returns Widest run of empty days, or null when fewer than two days are usable.
 */
const computeEventHistoryGapDays = (dayBuckets: Date[]): number | null => {
    if (!Array.isArray(dayBuckets) || dayBuckets.length < 2) {
        return null;
    }

    const _timestamps: number[] = [];
    for (const day of dayBuckets) {
        // Re-wrapped rather than `.getTime()`-ed directly: the driver hands back real Dates, but a
        // hand-written fixture may hold an ISO string, and `new Date(…)` parses both. An unparseable
        // entry yields NaN and is skipped rather than poisoning every span that touches it.
        const _ms = new Date(day).getTime();
        if (Number.isFinite(_ms)) {
            _timestamps.push(_ms);
        }
    }
    if (_timestamps.length < 2) {
        return null;
    }
    _timestamps.sort((a, b) => a - b);

    let _widest = 0;
    for (let i = 1; i < _timestamps.length; i += 1) {
        // Rounded, not floored: these are `$dateTrunc` day boundaries, so the span is a whole
        // number of days already — except across a leap second or a clock that produced a value a
        // millisecond off, where flooring would silently drop a day from the gap.
        const _spanDays = Math.round((_timestamps[i] - _timestamps[i - 1]) / MS_PER_DAY);
        const _emptyDays = _spanDays - 1;
        if (_emptyDays > _widest) {
            _widest = _emptyDays;
        }
    }
    return _widest;
};

/**
 * The share of rows that COULD carry a charge link and carry none — the bridge is missing by
 * construction rather than merely unmatched.
 *
 *  The denominator is the whole point. It counts only the rows whose shape can hold a charge id:
 * the event types whose `charge { … }` fragment the sync's query requests, and the one transaction
 * type (`AppSubscriptionSale`) that carries `chargeId` on the wire. Every other row stores `''`
 * BECAUSE IT NEVER HAD ONE — an install has no charge, a usage sale carries no charge id — and
 * folding those into the denominator would publish a large, permanent, unfixable "missing links"
 * figure that measures the API's schema rather than our data. Someone would then chase it.
 *
 * Absent is kept separate from unresolved below because the two have different fixes: absent means
 * the link was never captured (re-sync repairs it), unresolved means it was captured and points at
 * nothing (widening the other side repairs it). A single combined "link quality" number would
 * average them into a figure that suggests neither.
 *
 * @param inputs - The gathered counts.
 * @returns 0–100, or null when no row could carry a link at all.
 */
const computeChargeLinkAbsentPct = (inputs: CoverageInputs): number | null => {
    const _linkable = (inputs.charge_linked_event_rows || 0) + (inputs.charge_bearing_transaction_rows || 0);
    const _absent = (inputs.charge_linked_event_rows_without_charge_id || 0) + (inputs.charge_bearing_transaction_rows_without_charge_id || 0);
    return _toPercentage(_absent, _linkable);
};

/**
 * The share of SETTLED ROWS whose charge id matches no event we hold — a dangling link.
 *
 *  MEASURED IN ONE DIRECTION ONLY: money → events. Every payout settles a subscription, so a
 * transaction whose charge id appears on no event means we are missing the event that created it,
 * and any per-subscription figure (trial conversion, MRR movement, revenue by plan) silently drops
 * that money.
 *
 * The reverse direction is NOT a defect and is deliberately not counted. An event whose charge
 * never appears in the ledger is the normal life of a trial that ended, a declined charge, or a
 * subscription accepted this week that Shopify has not settled yet. Counting those would report
 * something like half the charges as "unresolved" on perfectly healthy data — a coverage metric
 * that cries wolf gets ignored, and then it is not a coverage metric.
 *
 * Weighted by ROWS, not by distinct charge: one dangling annual charge with a single payout is a
 * smaller hole than one dangling monthly charge with thirty, and the percentage should say so.
 *
 * @param inputs - The gathered counts and both charge-id sets.
 * @returns 0–100, or null when no settled row carries a charge id.
 */
const computeChargeLinkUnresolvedPct = (inputs: CoverageInputs): number | null => {
    const _knownCharges = new Set<string>();
    const _eventChargeIds = Array.isArray(inputs.event_charge_ids) ? inputs.event_charge_ids : [];
    for (const chargeId of _eventChargeIds) {
        if (chargeId) {
            _knownCharges.add(String(chargeId));
        }
    }

    const _rows: TransactionChargeRowCount[] = Array.isArray(inputs.transaction_charge_row_counts) ? inputs.transaction_charge_row_counts : [];
    let _settledRows = 0;
    let _unresolvedRows = 0;
    for (const row of _rows) {
        if (!row || !row.charge_id) {
            continue;
        }
        const _count = Number(row.rows) || 0;
        if (_count <= 0) {
            continue;
        }
        _settledRows += _count;
        if (!_knownCharges.has(String(row.charge_id))) {
            _unresolvedRows += _count;
        }
    }

    return _toPercentage(_unresolvedRows, _settledRows);
};

/**
 * Builds the whole coverage record — the six gates, in the shape `gi_partner_apps` stores them.
 *
 * Called at the end of a SUCCESSFUL sync only. Recomputing it after a partial pull would stamp a
 * confident-looking coverage summary onto a record we already know is incomplete, and the summary
 * would then be used to justify publishing figures over the very window that failed.
 *
 * The two extremes pass straight through: they are what the repository measured, and a `null` from
 * an empty collection stays `null` — "we hold no events for this app" is a real and important
 * answer, and defaulting it to a date would invent coverage that does not exist.
 *
 * @param inputs - Extremes, day buckets and link counts, gathered by the repository.
 * @returns The six gates. Every field is null when it could not be measured.
 */
const computeCoverage = (inputs: CoverageInputs): CoverageRecord => {
    return {
        earliest_event_at: inputs.earliest_event_at || null,
        earliest_transaction_at: inputs.earliest_transaction_at || null,
        // Passes straight through for the same reason as the two above: it is what the repository
        // measured, and a `null` is a real answer — "no row we hold carries a store name" — not a
        // gap to be filled with a comfortable date. The caller reads it AGAINST `earliest_event_at`
        // to decide whether there is a boundary worth reporting at all.
        shop_name_coverage_since: inputs.earliest_named_event_at || null,
        event_history_gap_days: computeEventHistoryGapDays(inputs.event_day_buckets || []),
        charge_link_absent_pct: computeChargeLinkAbsentPct(inputs),
        charge_link_unresolved_pct: computeChargeLinkUnresolvedPct(inputs)
    };
};

export = {
    computeCoverage,
    computeEventHistoryGapDays,
    computeChargeLinkAbsentPct,
    computeChargeLinkUnresolvedPct
};
