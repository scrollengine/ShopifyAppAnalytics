'use strict';

/**
 * ============================================================================
 *  THREE COLLECTIONS  →  ONE STORE'S TIMELINE
 * ============================================================================
 *
 *  DOES NO I/O AND READS NO CLOCK: every input is data, so the whole merge can be exercised against
 *  literal rows with no database. It lives in `resolvers/` rather than inside the service because
 *  the labelling and tone rules ARE judgements about what happened to a merchant, and those have to
 *  be reachable without one.
 *
 *  ──  THE SOURCE RIDES ON EVERY ENTRY, AND THAT IS THE WHOLE POINT ────────────────────────
 *
 *  A merged timeline with no per-entry provenance is a lie by omission: a store whose Partner events
 *  are synced and whose PAYOUTS ARE NOT renders as a store that installed and never paid, which is a
 *  specific false claim about a named business. `StoreDetailContent.js:69` says the same thing from
 *  the other side — *"Shown per entry so a gap in one source is visible rather than reading as
 *  'nothing happened'."* So the source is a required field on the entry type, not an option.
 *
 *  ── TONE IS READ FROM THE SIGN OF THE MONEY, NEVER FROM THE PAYOUT TYPE ────────────────────
 *
 *  `APP_ADJUSTMENT` is a correction Shopify applied after the fact and it can be positive or
 *  negative; `APP_CREDIT` is a refund and is negative. A tone table keyed by type would colour half
 *  the adjustments wrong, and the one an operator is looking for — the refund that explains a dip —
 *  is exactly the one that would be green.
 *
 *  ── AMOUNTS ARE FORMATTED HERE, AND ONLY IN `detail` ───────────────────────────────────────
 *
 *  ⚠️ Not a layering slip. `entry.detail` is a SENTENCE the drawer prints verbatim; it is not a
 *  figure the frontend formats. Formatting it here is what lets a EUR payout say `EUR 29.00`, which
 *  the page's own `fmtMoney` cannot — it hard-codes a `$` and would render that same payout as
 *  `$29.00`, a right number under a wrong currency. Every FIGURE on this response is still a bare
 *  number in its own field; this is prose.
 *
 *  ── FUTURE-DATED ROWS ARE SHOWN HERE AND EXCLUDED EVERYWHERE ELSE ──────────────────────────
 *
 *  A row dated after the judgement instant is clock skew between Shopify and this host, or a
 *  corrupted row. It decides no state, no total and no MRR figure — the install fold clamps it, the
 *  spend fold clamps it, the cohort is handed a clamped list — but it IS shown on the timeline,
 *  because this is the audit surface and hiding the evidence from the one screen built to display it
 *  turns a diagnosable row into an invisible one. The service warns about the count.
 *
 *  ── WHAT THIS DELIBERATELY DOES NOT COUNT ──────────────────────────────────────────────────
 *
 *  Rows carrying no readable instant are skipped and NOT reported here, which is the one exception
 *  to the house rule that a fold reports every exclusion. They are the same rows two other folds
 *  scan and count — `resolveInstallStates` (`undated_events`) and `foldStoreSpend`
 *  (`undated_transactions`) — and a third counter over the same rows would be a second number for
 *  one fact, which is how two figures for one exclusion end up disagreeing on screen.
 * ============================================================================
 */

import storeDetailConstants = require('../constants/storeDetail.constants');
import partnerVocab = require('../../../constants/partnerVocab.constants');

import type { StoreTimelineEntry } from '../types/storeDetail.types';
import type {
    StoreTimelineInput,
    StoreTimelineResult,
    StoreTimelineEventRow
} from '../types/storeTimeline.types';

const {
    TIMELINE_SOURCES,
    TIMELINE_TONES,
    TIMELINE_EVENT_LABELS,
    TIMELINE_EVENT_TONES,
    TRANSACTION_TYPE_LABELS
} = storeDetailConstants;
const { PARTNER_TRANSACTION_TYPES } = partnerVocab;

/** A `Date` only when it genuinely is one and genuinely valid. */
const _date = (value: unknown): Date | null => {
    return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
};

/** Trimmed string from anything, treating null/undefined as `''`. Never `'null'`. */
const _text = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value).trim();
};

/**
 * Narrows a tone from the vocabulary table onto the union the entry type declares.
 *
 * ⚠️ NOT a cast. `TIMELINE_EVENT_TONES` is declared `Record<string, string>` so it can be keyed by a
 * stored event type, which means indexing it yields `string`. Comparing against the three members
 * narrows it the way the compiler can check — and the same three branches ARE the run-time rule that
 * an unlisted tone falls back to neutral, so the type-safety and the behaviour cannot drift apart.
 *
 * @param [value] - A tone from the table, or undefined for an event type it does not list.
 * @returns One of the three tones the drawer can render.
 */
const _tone = (value?: string): StoreTimelineEntry['tone'] => {
    if (value === TIMELINE_TONES.POSITIVE) {
        return TIMELINE_TONES.POSITIVE;
    }
    if (value === TIMELINE_TONES.NEGATIVE) {
        return TIMELINE_TONES.NEGATIVE;
    }
    //  Neutral by default. An event is not bad because we have no opinion about it.
    return TIMELINE_TONES.NEUTRAL;
};

/**
 * An amount as prose, carrying its real currency.
 *
 * ⚠️ Two decimals ALWAYS, and the currency code before the number rather than a symbol: there is no
 * symbol table in this build, and inventing one is how a EUR payout acquires a `$`.
 *
 * @param amount - The gross amount, which may legitimately be negative.
 * @param currency - The ISO code, or `''` when the payout named none.
 * @returns e.g. `USD 29.00`, or `29.00` when no currency was recorded.
 */
const _money = (amount: number, currency: string): string => {
    const value = Number.isFinite(amount) ? amount.toFixed(2) : '0.00';
    return currency === '' ? value : `${currency} ${value}`;
};

/**
 * The second line under one Partner event.
 *
 * Names the plan when the charge is one we resolved, and the charge id either way — the id is what
 * an operator pastes into the Partner dashboard, and it is the only way to tell two subscriptions on
 * one store apart.
 *
 * @param row - The event.
 * @param planNames - Charge id → plan name, from the cohort fold.
 * @returns The detail line, or `''` when the event concerns no charge.
 */
const _eventDetail = (row: StoreTimelineEventRow, planNames: ReadonlyMap<string, string>): string => {
    const chargeId = _text(row.charge_id);
    if (chargeId === '') {
        return '';
    }
    const planName = _text(planNames.get(chargeId));
    if (planName === '') {
        return `Charge ${chargeId}`;
    }
    return `${planName} · charge ${chargeId}`;
};

/**
 * Merges one store's events, payouts and listing-analytics records into a single ordered timeline.
 *
 * @param input - The already-fetched rows and the entry cap.
 * @returns The entries, newest first, plus how many the cap withheld.
 */
const resolveStoreTimeline = (input: StoreTimelineInput): StoreTimelineResult => {
    const events = Array.isArray(input && input.events) ? input.events : [];
    const transactions = Array.isArray(input && input.transactions) ? input.transactions : [];
    const attribution = Array.isArray(input && input.attribution) ? input.attribution : [];
    const planNames: ReadonlyMap<string, string> = input && input.plan_name_by_charge
        ? input.plan_name_by_charge
        : new Map<string, string>();

    const entries: StoreTimelineEntry[] = [];

    for (const row of events) {
        const at = _date(row && row.occurred_at);
        if (!at) {
            continue;
        }
        const eventType = _text(row.event_type);
        entries.push({
            at,
            // The raw stored type when the vocabulary has no label for it, so an event this build
            // does not model is still identifiable rather than blank.
            label: TIMELINE_EVENT_LABELS[eventType] || eventType,
            detail: _eventDetail(row, planNames),
            source: TIMELINE_SOURCES.PARTNER_EVENT,
            tone: _tone(TIMELINE_EVENT_TONES[eventType])
        });
    }

    for (const row of transactions) {
        const at = _date(row && row.created_at);
        if (!at) {
            continue;
        }
        const type = _text(row.type);
        const grossRaw = Number(row.gross_amount && row.gross_amount.amount);
        const gross = Number.isFinite(grossRaw) ? grossRaw : 0;
        const currency = _text(row.gross_amount && row.gross_amount.currency);

        let tone: StoreTimelineEntry['tone'] = TIMELINE_TONES.NEUTRAL;
        if (gross > 0) {
            tone = TIMELINE_TONES.POSITIVE;
        } else if (gross < 0) {
            // A refund or a negative adjustment. Read from the SIGN, never from the type — see the
            // file header.
            tone = TIMELINE_TONES.NEGATIVE;
        }

        const parts = [_money(gross, currency)];
        const chargeId = _text(row.charge_id);
        if (type === PARTNER_TRANSACTION_TYPES.APP_SUBSCRIPTION && chargeId !== '') {
            const planName = _text(planNames.get(chargeId));
            parts.push(planName === '' ? `charge ${chargeId}` : `${planName} · charge ${chargeId}`);
        }

        entries.push({
            at,
            label: TRANSACTION_TYPE_LABELS[type] || type,
            detail: parts.join(' · '),
            source: TIMELINE_SOURCES.TRANSACTION,
            tone
        });
    }

    for (const row of attribution) {
        const at = _date(row && row.installed_at);
        if (!at) {
            continue;
        }
        const source = _text(row.source);
        const medium = _text(row.medium);
        const surface = _text(row.surface_type);
        const parts: string[] = [];
        if (source !== '') {
            parts.push(medium === '' ? source : `${source} / ${medium}`);
        }
        if (surface !== '') {
            parts.push(surface);
        }
        entries.push({
            at,
            label: 'Install seen by listing analytics',
            detail: parts.join(' · '),
            source: TIMELINE_SOURCES.LISTING_ATTRIBUTION,
            //  NEUTRAL, always. This entry records that we OBSERVED the install, not that
            // anything good or bad happened — the install itself is a Partner event with its own
            // tone, and colouring both would double-count one moment in the merchant's history.
            tone: TIMELINE_TONES.NEUTRAL
        });
    }

    // NEWEST FIRST, with a deterministic tie-break. Shopify's `occurredAt` has no sub-second
    // component, so a payout and the event that earned it routinely share an instant; without the
    // tie-break the order of two entries on one day would depend on the scan and the panel would
    // reshuffle between requests. Source first (the event before the money it produced reads as the
    // story it is), then the label.
    entries.sort((a, b) => {
        const byTime = b.at.getTime() - a.at.getTime();
        if (byTime !== 0) {
            return byTime;
        }
        const bySource = a.source.localeCompare(b.source);
        if (bySource !== 0) {
            return bySource;
        }
        return a.label.localeCompare(b.label);
    });

    const limit = Number.isFinite(Number(input && input.limit)) && Number(input.limit) > 0
        ? Math.floor(Number(input.limit))
        : entries.length;
    const kept = entries.slice(0, limit);

    return {
        entries: kept,
        //  REPORTED, never silent. A truncated audit surface that does not say so is
        // indistinguishable from a complete one, and the reader would conclude the store's history
        // begins wherever the cap fell.
        truncated: Math.max(entries.length - kept.length, 0)
    };
};

export = {
    resolveStoreTimeline
};
