'use strict';

/**
 * ============================================================================
 *  THE SYNC WINDOW — which days a run scans, and therefore what it costs
 * ============================================================================
 *
 *  PURE. No models, no config, and — the one that matters — NO CLOCK READ. `resolveSyncWindow`
 *  takes `now` as an argument, which is what makes the awkward cases testable at all: the very first
 *  run with no watermark, an INCREMENTAL run whose overlap reaches back before the export existed,
 *  a LIFETIME floor somebody typed as `01-01-2020`. A helper that reads the clock can only be tested
 *  by waiting.
 *
 *  ⚠️ The window IS the cost. BigQuery bills per byte scanned and the queries are bounded by
 *  `_TABLE_SUFFIX BETWEEN start AND end`, so every extra day this function returns is a whole extra
 *  daily table scanned on every one of the three rollups. Widening a window "for completeness" is
 *  spending money, not being thorough.
 * ============================================================================
 */

import constants = require('../constants/bigQuery.constants');

import type { BigQuerySyncWindow, ResolveSyncWindowInput } from '../types/bigQuery.types';

const { ISO_DATE_RE } = constants;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The three modes, spelled once. AUTO picks between the other two from the watermark. */
const SYNC_MODES = Object.freeze({
    AUTO: 'AUTO',
    LIFETIME: 'LIFETIME',
    INCREMENTAL: 'INCREMENTAL'
} as const);

/**
 * The `_TABLE_SUFFIX` form GA4's daily tables are named with: `YYYYMMDD`, UTC.
 *
 * UTC getters, never local ones. A local-time render would put a run in the western hemisphere on
 * yesterday's table for the first hours of every day — a window silently short by one day, on a
 * schedule, which is the kind of gap nothing ever notices.
 *
 * @param d - Any instant.
 * @returns `YYYYMMDD` in UTC.
 */
const yyyymmdd = (d: Date): string => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${m}${day}`;
};

/**
 * Whether a configured lifetime floor is usable.
 *
 * Both halves are needed. The shape test alone passes `2020-13-45`, which `new Date` turns into
 * an Invalid Date, which `yyyymmdd` renders as `NaNNaNNaN` — a table suffix BigQuery matches nothing
 * against. That is a query which SUCCEEDS, costs nothing, and returns zero rows: a plausible empty
 * answer, which is the precise failure this project exists to refuse. So a bad floor is refused by
 * name at the start of a sync instead.
 *
 * @param value - The configured `BQ_LIFETIME_FLOOR_DATE`.
 * @returns True when it is a real `YYYY-MM-DD` date.
 */
const isValidFloorDate = (value: unknown): boolean => {
    if (!value || typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
        return false;
    }
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
        return false;
    }
    // Round-trips only for a real calendar date: `2020-02-31` parses, but to March 2nd.
    return yyyymmdd(parsed) === value.replace(/-/g, '');
};

/**
 * Resolves which days a run covers, and in which mode.
 *
 * ── The mode ──
 * AUTO resolves to LIFETIME when there is no watermark and INCREMENTAL when there is. That is the
 * whole rule, and it is why the watermark must be stamped ONLY after a fully successful run: stamp
 * it after a partial one and AUTO never chooses LIFETIME again, so the backfill that failed is
 * skipped permanently and invisibly.
 *
 * ── The overlap ──
 * An INCREMENTAL window starts `overlap_days` BEFORE the watermark, not at it. Events land in the
 * export late — the install event especially, being server-side — and re-pulling is free because
 * every write is an idempotent upsert keyed on the row's own identity.
 *
 * @param params0 - See {@link ResolveSyncWindowInput}; every input is passed in, nothing is read.
 * @returns The resolved mode plus the window in both `YYYYMMDD` and ISO form.
 */
const resolveSyncWindow = ({
    watermark,
    mode,
    lifetime_floor_date,
    default_lookback_days,
    lookback_days,
    overlap_days,
    now
}: ResolveSyncWindowInput): BigQuerySyncWindow => {
    let _resolved = mode || SYNC_MODES.AUTO;
    if (_resolved !== SYNC_MODES.LIFETIME && _resolved !== SYNC_MODES.INCREMENTAL) {
        // Anything unrecognised is treated as AUTO rather than rejected. A stored job payload is
        // unvalidated input, and refusing a whole scheduled run over a typo in its mode would be a
        // worse outcome than picking the mode the watermark already implies.
        _resolved = SYNC_MODES.LIFETIME;
        if (watermark) {
            _resolved = SYNC_MODES.INCREMENTAL;
        }
    }

    const _end = new Date(now.getTime());
    let _start;
    if (_resolved === SYNC_MODES.LIFETIME) {
        _start = new Date(`${lifetime_floor_date}T00:00:00Z`);
    } else if (watermark) {
        _start = new Date(new Date(watermark).getTime() - (overlap_days * DAY_MS));
    } else {
        // INCREMENTAL was asked for explicitly but there is nothing to be incremental FROM.
        let _lb = default_lookback_days;
        if (typeof lookback_days === 'number' && Number.isFinite(lookback_days) && lookback_days > 0) {
            _lb = lookback_days;
        }
        _start = new Date(now.getTime() - (_lb * DAY_MS));
    }

    return {
        resolved_mode: _resolved,
        start_yyyymmdd: yyyymmdd(_start),
        end_yyyymmdd: yyyymmdd(_end),
        start_iso: _start.toISOString(),
        end_iso: _end.toISOString()
    };
};

export = {
    SYNC_MODES,
    yyyymmdd,
    isValidFloorDate,
    resolveSyncWindow
};
