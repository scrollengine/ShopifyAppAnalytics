'use strict';

/**
 * ============================================================================
 *  WHO IS PAYING YOU RIGHT NOW, AND ON WHAT PLAN
 * ============================================================================
 *
 *  Serves the Subscriptions page. The population is "on a paid plan RIGHT NOW", and the whole value
 *  of this endpoint depends on the reader knowing that before they read a number.
 *
 *  ──  TWO GROUPS ARE ABSENT, AND NEITHER APPEARS WITH A DIFFERENT STATUS ─────────────────
 *
 *    · a store that never subscribed;
 *    · a store that paid for a year and then stopped.
 *
 *  Both are simply NOT HERE. So a count taken from this list is not "our customers to date", and a
 *  trend built from it cannot show churn — the churned LEAVE the population rather than changing
 *  state within it. `GET /api/stores` is the list whose population is every store ever, and it is
 *  the one that can answer that question.
 *
 *  That is a trap you can walk into with entirely correct numbers, so the response SAYS SO: the
 *  `population` block names the predicate, names the two absent groups, names the endpoint that has
 *  them, and publishes the counts of what it excluded so a reader can reconcile
 *  `stores_known === status_counts.ALL + never_settled + settled_but_not_paying_now` by hand.
 *
 *  ──  MEMBERSHIP IS `modules/revenue`'s `liveSetAsOf`. IT IS NOT RE-DERIVED HERE. ─────────
 *
 *  Not "state === CONVERTED", not "monthly_spend > 0", not a second window: the paying set arrives
 *  on the fold, already computed by the canonical predicate, and this file only asks whether a
 *  domain is in it. `modules/revenue/index.ts` records what happens otherwise — *"two pages
 *  reconstructed MRR independently and disagreed with each other"* — and the disagreement this
 *  prevents would be the worst possible one: the Revenue page's MRR summing over shops that this
 *  page says are not customers.
 *
 *  ⚠️ WHAT THAT DOES AND DOES NOT GUARANTEE, STATED PRECISELY RATHER THAN OPTIMISTICALLY. Both
 *  pages evaluate the SAME predicate, over the SAME `APP_SUBSCRIPTION` ledger, with the same window,
 *  each at its own request's instant — so no merchant can be paying on one page and not on the other
 *  because of a DEFINITION. They do key differently: `modules/revenue` groups by the Partner
 *  `shop_id` and drops payout rows whose `shop_id` is blank, while this fold groups by `shop_domain`
 *  and drops rows whose domain is blank (see the resolver, which says why). Wherever a payout row
 *  carries both identifiers — the normal case — the two sets are the same shops and the two sums
 *  agree. Where they diverge, the cause is a payout row missing one of its keys, which is a gap in
 *  the SYNC rather than a difference of opinion about who is paying. ⚠️ That gap is NOT visible from
 *  this endpoint: a payout carrying a domain and no `shop_id` is counted here and dropped there, and
 *  nothing on this response can see the other side. `diagnostics.paying_domains_without_a_row` below
 *  measures a different thing — a paying domain this fold produced no store row for.
 *
 *  ──  AND THE STATUS COLUMN IS NOT THE MEMBERSHIP TEST ───────────────────────────────────
 *
 *  Every row here is paying. `status` says what the SUBSCRIPTION EVENTS make of that merchant, which
 *  is a different question with a different source, and the two disagree legitimately: a merchant who
 *  cancelled three days into a cycle they had already paid for is `CHURNED_AFTER_TRIAL` and is still
 *  on this list until that cycle runs out. Collapsing the four tabs into "everyone is PAYING" would
 *  hide the single most actionable row on the page.
 *
 *  ── ONE `rows` ARRAY. ONE PASS. EVERY NUMBER DERIVED FROM IT. ────────────────────────────
 *
 *  There is no second `countDocuments` and no second aggregation. The tab counts, the facet counts,
 *  the pagination total and the rows in the table are all folds over the SAME array. `status_counts`
 *  is PRE-FILTER and `status_counts_filtered` applies every OTHER facet — not a violation of that
 *  rule but a consequence of it: the first labels the tab row (a post-filter count would make every
 *  unselected tab read `(0)` the moment one is chosen), the second predicts what clicking a tab
 *  actually shows.
 *
 *  ── ONE JUDGEMENT INSTANT, RESOLVED ONCE, THREADED EVERYWHERE ────────────────────────────
 *
 *  `as_of` is read from the clock exactly once, HERE, and passed into the fold. Nothing below it
 *  touches `new Date()`. Without that the payout rollup, the state machine and the install fold each
 *  answer as of a different millisecond, and a store can be simultaneously CHURNED and paying.
 *
 *  ── EVERY NUMBER ON THE WIRE IS A BARE NUMBER ────────────────────────────
 *
 *  Not a `confidence.helper` envelope. `fmtMoney(envelope)` is `Number({…})` → `NaN` → an em dash,
 *  and `pagination.total.toLocaleString()` throws outright and takes the page's footer with it.
 *  Wrapping these MANUFACTURES the missing figure the rule exists to prevent. The honesty contract is
 *  discharged through fields that survive rendering: `population`, `ledger_only`, `status_basis`,
 *  `has_attribution`, `install_state: 'UNKNOWN'`, `trial_days_source`, `data_state`,
 *  `attribution_state`, `meta`, `diagnostics` and `warnings[]`.
 *
 *  ── THE DISCRIMINATOR IS THE WATERMARK, NEVER THE ROW COUNT ─────────────────
 *
 *  No paying stores plus `last_synced_at` is a real, publishable "nobody is paying you right now".
 *  No paying stores and no watermark is "we have not looked yet". Those must never render alike.
 *
 *   AND THE WATERMARK IS `last_synced_at`, NOT `earliest_transaction_at` — see
 *  `constants/subscriptionList.constants`. The second is `$min(created_at)` over the payout rows,
 *  i.e. a row count in disguise, and using it would turn "this app genuinely has no payouts yet" into
 *  "nothing has synced". The empty ledger is reported through `warnings[]` instead, which is where a
 *  fact this endpoint cannot resolve belongs.
 * ============================================================================
 */

import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import listQueryHelper = require('../../shared/helpers/listQuery.helper');
import conversion = require('../../conversion');
import storeConstants = require('../constants/storeRoster.constants');
import subscriptionConstants = require('../constants/subscriptionList.constants');
import storeFacetHelper = require('../helpers/storeFacet.helper');
import storeSortHelper = require('../helpers/storeSort.helper');
import storeRosterResolver = require('../resolvers/storeRoster.resolver');
import subscriptionRowResolver = require('../resolvers/subscriptionRow.resolver');

import type { EmptyPayload, IdentityObject, ServiceResult } from '../../../types/service.types';
import type { PartnerAppDoc } from '../../shared/types/entity.types';
import type { StoreFacetOption, StoreSortDirection } from '../types/storeRoster.types';
import type {
    SubscriptionFacetGroup,
    SubscriptionFacetGroupKey,
    SubscriptionFacetSelection,
    SubscriptionListDiagnostics,
    SubscriptionListParams,
    SubscriptionListResponse,
    SubscriptionListRow,
    SubscriptionListSortKey,
    SubscriptionPopulationExclusions,
    SubscriptionStatusCounts
} from '../types/subscriptionList.types';

const { customConsoleError } = logger;
const { promiseReturnResult } = promiseHelper;
const { positiveInt } = listQueryHelper;
const { resolveStoreRosterFold } = storeRosterResolver;
const { resolveSubscriptionRow } = subscriptionRowResolver;
// Through the barrel. `STATE_BASIS.INFERRED` is the one branch of the state machine that guesses,
// and `modules/conversion` owns the vocabulary that names it.
const { STATE_BASIS } = conversion;
const {
    STORE_INSTALL_STATE_LABELS,
    STORE_INSTALL_STATE_ORDER,
    NOT_PUSHED_FACET,
    NOT_PUSHED_FACET_LABEL,
    BILLING_INTERVAL_UNKNOWN,
    BILLING_INTERVAL_LABELS,
    STORE_ATTRIBUTION_STATES
} = storeConstants;
const {
    SUBSCRIPTION_STATUS_LABELS,
    SUBSCRIPTION_STATUS_ORDER,
    ALL_COUNT_KEY,
    POPULATION_KEY,
    POPULATION_LABEL,
    POPULATION_STATEMENT,
    SUBSCRIPTION_LIST_SORT_KEYS,
    DEFAULT_SUBSCRIPTION_SORT_KEY,
    DEFAULT_SUBSCRIPTION_SORT_DIR,
    SUBSCRIPTION_DEFAULT_LIMIT,
    SUBSCRIPTION_MAX_LIMIT,
    SUBSCRIPTION_FACET_GROUPS,
    SUBSCRIPTION_DATA_STATES
} = subscriptionConstants;
const { subscriptionFacetValue, matchesAllFacets, matchesSearch } = storeFacetHelper;
const { compareSubscriptionRows } = storeSortHelper;

/**
 * The declared facet groups, as an array, so every loop over them covers all of them.
 *
 * ⚠️ A WIDENING of `Object.keys`, which is typed `string[]` whatever it is given — not an escape
 * from a lost type. The alternative, a hand-written list of the four keys, can drift from
 * `SUBSCRIPTION_FACET_GROUPS`, and a group that gains a checkbox without gaining a predicate is
 * exactly the failure the facet helper's header describes.
 */
const _FACET_KEYS = Object.keys(SUBSCRIPTION_FACET_GROUPS) as SubscriptionFacetGroupKey[];

/**
 * Widened copies of the frozen vocabularies, so a `string` from the query bag can be tested against
 * them and a `string` value can index a label map — both without an `as` cast, which this codebase
 * reserves for the model chokepoint. Assignment widens; it does not re-type anything.
 */
const _STATUS_KEYS: readonly string[] = SUBSCRIPTION_STATUS_ORDER;
const _STATUS_LABEL_MAP: Readonly<Record<string, string>> = SUBSCRIPTION_STATUS_LABELS;
const _INSTALL_STATE_KEYS: readonly string[] = STORE_INSTALL_STATE_ORDER;
const _INSTALL_STATE_LABEL_MAP: Readonly<Record<string, string>> = STORE_INSTALL_STATE_LABELS;

/** @param value - A candidate sort key. @returns Whether it is in the allowlist. */
const _isSortKey = (value: string): value is SubscriptionListSortKey => SUBSCRIPTION_LIST_SORT_KEYS.includes(value);

/**
 *  THE WARNING CATALOGUE, IN ONE BLOCK, BECAUSE EVERY STRING MUST BE UNIQUE.
 *
 * These are rendered one `<p>` per warning, KEYED BY THE STRING ITSELF. Two identical strings are a
 * duplicate-key React collision and one of them is silently dropped — so a second copy of a message
 * does not double up, it DISAPPEARS, and takes its condition with it. Keeping them together is what
 * makes that checkable by eye; the emit path also de-duplicates, so a message that can legitimately
 * be produced twice cannot take its own twin down.
 *
 * ⚠️ EVERY SENTENCE IS WORDED FOR THIS POPULATION, not copied from the roster's. "This roster is a
 * floor" and "this list of paying merchants is a floor" are different claims about different sets,
 * and an operator acting on the wrong one draws the wrong conclusion about their revenue.
 *
 * Each is written for an operator who cannot see this code: it says what is missing, what that does
 * to the numbers beside it, and what would fix it.
 */
const _WARNINGS = Object.freeze({
    neverSynced: 'No Partner sync has completed for this app yet, so no subscription events and no '
        + 'settled payouts have been fetched. An empty list below means we have not looked — not that '
        + 'nobody is paying you.',

    /**
     *  THE MOST DANGEROUS EMPTY STATE ON THIS ENDPOINT, AND IT IS NOT A `data_state`.
     *
     * This list's entire population is the settled-payout ledger. With no payout rows at all the
     * list is empty, and an empty list on a page titled "Subscriptions" reads as "you have no paying
     * customers" — a claim about the operator's business that no data made. It cannot be a
     * NEVER_SYNCED state because the only field that would decide it (`earliest_transaction_at`) is
     * `$min(created_at)` OVER THE ROWS, so it cannot tell "never fetched" from "genuinely none". The
     * sentence therefore says out loud which two things it cannot separate.
     */
    noTransactions: 'No settled payouts have ever been fetched for this app. Every store on this page '
        + 'is here because Shopify billed it, so with an empty payout ledger this list is empty for a '
        + 'reason that has nothing to do with your customers. This build cannot tell "the payouts have '
        + 'never been fetched" from "this app has genuinely never been paid" — run a Partner sync, and '
        + 'check that your Partner API token has payout access.',

    lifetimeFloor: 'No lifetime Partner sync has ever completed for this app, so this list is a FLOOR '
        + 'rather than a total — a merchant whose subscription and payouts both predate the synced '
        + 'window is paying you and is missing from this page.',

    /** ⚠️ Carries the availability message verbatim, so the operator reads the missing variable names. */
    attributionNotConnected: (message: string): string => `${message} `
        + 'Every merchant below therefore shows as "Not attributed" in the "Came from" column; that is a '
        + 'missing data source, not evidence that they arrived directly. Nothing else on this page '
        + 'depends on it — the list, the plans and the money all come from the Partner API.',

    attributionNeverSynced: 'Listing analytics is configured, but the install-attribution sync has never '
        + 'completed for this app, so the "Came from" column is at best partial. A merchant showing as '
        + '"Not attributed" reflects that missing sync rather than evidence of direct arrival.',

    ledgerOnlyRows: (rows: number): string => `${rows} merchant(s) below are listed because Shopify `
        + 'settled a payout for them inside their billing window, and no subscription event has been '
        + 'synced for them — usually an incremental sync whose window began after they subscribed. '
        + 'Their plan, activation date and trial columns are blank because we hold no charge record, '
        + 'not because they are on a free plan, and their status is the payout ledger\'s verdict rather '
        + 'than a subscription\'s. A LIFETIME Partner sync fills these in.',

    /**
     * ⚠️ Fires on the app-level measurement, which records the WIDEST gap in the whole event history
     * and NOT where it sits. `null` is "never measured" and `0` is a real, reassuring "no day-wide
     * hole"; neither warns.
     */
    eventHistoryGap: (days: number): string => `The Partner event history for this app contains a stretch `
        + `of ${days} day(s) carrying no events at all. A subscription that started or ended inside that `
        + 'stretch is missing from the plan and status columns below, so a merchant can appear here with '
        + 'a blank plan or an out-of-date status. The data cannot say whether it was a genuinely quiet '
        + 'period or a sync window that failed and was never re-pulled, which is why it is published '
        + 'here rather than resolved.',

    shopNameCoverage: (since: string): string => `Store names are filled from the Partner API only for `
        + `events synced since ${since}. Older merchants show their myshopify domain instead, which is not `
        + 'a missing name — run a LIFETIME Partner sync to fill in the rest.',

    shopNameCoverageNone: 'No synced Partner event carries a store name yet, so EVERY merchant below '
        + 'shows its myshopify domain. That is sync state rather than missing data — store names were '
        + 'added to the event record after this collection was in use, and only a sync that has run since '
        + 'then fills them. Run a LIFETIME Partner sync.',

    storesWithoutInstallRecord: (stores: number): string => `${stores} paying merchant(s) below have no `
        + 'install or uninstall event on record and show an unknown install state. Their install usually '
        + 'predates the synced event history — it is not evidence that the app has been removed.',

    mixedSpendCurrency: (stores: number): string => `${stores} merchant(s) have settled payouts in more `
        + 'than one currency. Their total spend is a sum of unlike units — this build holds no exchange '
        + 'rates — so those rows publish no currency and the figure should not be read as an amount in '
        + 'any one of them.',

    testSubscriptionsExcluded: (subscriptions: number): string => `${subscriptions} test subscription(s) `
        + 'were excluded from the Status column. A test subscription settles no real payout, so it cannot '
        + 'put a merchant on this list — but if one of these belongs to a merchant who is here for a '
        + 'different, real charge, their status is drawn from the real one alone.',

    skippedKeylessSubscriptionEvents: (events: number): string => `${events} subscription event(s) carried `
        + 'neither a charge id nor a shop domain and were skipped rather than pooled. Pooling them would '
        + 'have invented one merged subscription out of many.',

    inferredStatusRows: (rows: number): string => `${rows} merchant(s) below show a status resolved on `
        + 'the weakest evidence available: Shopify supplied no billing date for their subscription and '
        + 'no payout has settled against that particular charge. Their MEMBERSHIP of this list is '
        + 'measured — money moved — but the status beside it is the reading that claims no revenue and '
        + 'no loss rather than a measured one.',

    unclassifiedSubscriptions: (rows: number): string => `${rows} merchant(s) have a subscription whose `
        + 'state could not be mapped to one of the four statuses, so their status falls back to the payout '
        + 'ledger\'s verdict. That is a defect in this build, not a fact about those merchants — please '
        + 'report it.',

    /**
     *  Structurally impossible today, and warned about anyway. Every settled `APP_SUBSCRIPTION`
     * payout also lands in the all-type spend rollup, which is one of the three sources of the
     * roster's population — so a paying domain always has a row. A fold that silently dropped a
     * PAYING CUSTOMER is the one defect this endpoint must never have quietly, so it is counted.
     */
    payingDomainsWithoutARow: (domains: number): string => `${domains} merchant(s) that the payout ledger `
        + 'says are paying could not be matched to a store record and are MISSING from the list below, so '
        + 'the count and the revenue on this page are both understated. This should not be possible and is '
        + 'a defect in this build — please report it.',

    unrecognisedFacet: (group: string, value: string): string => `The ${group} filter "${value}" is not a `
        + 'value this endpoint can evaluate, so it has been ignored and the list below is wider than you '
        + 'asked for.',

    unrecognisedSort: (value: string): string => `The sort key "${value}" is not sortable here, so the `
        + `default sort (${DEFAULT_SUBSCRIPTION_SORT_KEY}, newest first) has been used instead. Valid `
        + `values: ${SUBSCRIPTION_LIST_SORT_KEYS.join(', ')}.`,

    limitClamped: (requested: string, applied: number): string => `A page size of ${requested} was `
        + `requested; this endpoint serves at most ${applied} subscriptions per page, so the list below is `
        + 'one page of that size. The `pagination` block carries the real total.'
});

/**
 * An ISO string, or null.
 *
 * @param [value] - Any stored or resolved date.
 * @returns The ISO form, or null when there is no date.
 */
const _iso = (value?: Date | null): string | null => {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        return null;
    }
    return value.toISOString();
};

/**
 * A comma-joined query parameter split into distinct, non-empty values.
 *
 * De-duplicated because a repeated value would tally its warning twice and, worse, would be
 * indistinguishable from two different unrecognised values in the diagnostics echo.
 *
 * @param raw - The parameter as it arrived: a string, or anything at all.
 * @returns The values, in the order given, without repeats.
 */
const _splitCsv = (raw: unknown): string[] => {
    if (raw === null || raw === undefined) {
        return [];
    }
    const out: string[] = [];
    for (const part of String(raw).split(',')) {
        const value = part.trim();
        if (value !== '' && out.indexOf(value) === -1) {
            out.push(value);
        }
    }
    return out;
};

/**
 * The groups whose vocabulary is CLOSED — the endpoint knows every value they can take.
 *
 *  THREE OF THE FOUR. Treating a closed group as open lets `?billing=MONTHLY` or `?states=PAID` be
 * ACCEPTED, match no row, and return an EMPTY table with NO warning — which on this page reads as
 * "you have no paying customers". That is the "a typo must widen, not empty" rule the facet helper's
 * header states, and it is the outcome this endpoint can least afford.
 *
 * ⚠️ `store_statuses` holds operator-pushed free text and MUST stay open: rejecting a value the
 * operator legitimately pushed would be a filter that refuses its own data.
 */
const _CLOSED_FACET_VOCABULARY: Partial<Record<SubscriptionFacetGroupKey, readonly string[]>> = Object.freeze({
    states: _STATUS_KEYS,
    install_states: _INSTALL_STATE_KEYS,
    billing: Object.keys(BILLING_INTERVAL_LABELS)
});

/**
 * Every value the LIST actually produced for one group.
 *
 *  THE ESCAPE HATCH THAT KEEPS THE CLOSED CHECK FROM CONTRADICTING THE CHECKBOXES. The options a
 * group offers are `_alwaysOffered` plus whatever `subscriptionFacetValue` returned over the rows, so
 * a cadence Shopify sends that this build has never seen would be OFFERED as an option and then
 * REJECTED on selection — a checkbox that ticks and empties the table, which is worse than the bug
 * the closed check fixes. Consulted only when the declared vocabulary has already said no, so it
 * costs a pass over the list on a rejected value and nothing at all otherwise.
 *
 * @param rows - The whole list.
 * @param groupKey - The group.
 * @returns Every bucket at least one row is in.
 */
const _observedFacetValues = (rows: readonly SubscriptionListRow[], groupKey: SubscriptionFacetGroupKey): Set<string> => {
    const seen = new Set<string>();
    for (const row of rows) {
        seen.add(subscriptionFacetValue(row, groupKey));
    }
    return seen;
};

/**
 * The values of one facet group that this endpoint can actually evaluate.
 *
 * ⚠️ FAIL-OPEN. Anything unrecognised is DROPPED and reported, never matched — a typo must widen the
 * result set, not empty it. A value survives when the group's vocabulary is open, when the declared
 * vocabulary contains it, or when the list in front of us actually produced it.
 *
 * @param groupKey - The group.
 * @param raw - The parameter exactly as it arrived.
 * @param rows - The whole list, for the observed-value fallback above.
 * @param rejected - Mutated: every dropped value is appended as `group=value`.
 * @param warnings - Mutated: one operator-facing sentence per dropped value.
 * @returns The values worth applying.
 */
const _validateFacetValues = (
    groupKey: SubscriptionFacetGroupKey,
    raw: unknown,
    rows: readonly SubscriptionListRow[],
    rejected: string[],
    warnings: string[]
): string[] => {
    const values = _splitCsv(raw);
    if (values.length === 0) {
        return [];
    }
    const vocabulary = _CLOSED_FACET_VOCABULARY[groupKey];
    let observed: Set<string> | null = null;
    const out: string[] = [];
    for (const value of values) {
        let ok = true;
        if (vocabulary && vocabulary.indexOf(value) === -1) {
            if (observed === null) {
                observed = _observedFacetValues(rows, groupKey);
            }
            ok = observed.has(value);
        }
        if (ok) {
            out.push(value);
        } else {
            rejected.push(`${groupKey}=${value}`);
            warnings.push(_WARNINGS.unrecognisedFacet(SUBSCRIPTION_FACET_GROUPS[groupKey], value));
        }
    }
    return out;
};

/**
 * A tally of one facet group's values over the rows that pass every OTHER group.
 *
 *  THE OPTIONS AND THE PREDICATE COME FROM THE SAME FUNCTION. `subscriptionFacetValue` decides a
 * row's bucket here and inside `matchesAllFacets`, so a checkbox the backend cannot evaluate is
 * unrepresentable rather than merely unlikely.
 *
 * @param rows - The whole list.
 * @param groupKey - The group being tallied.
 * @param selection - Every group's validated values.
 * @param needle - The lowercased search query, applied to the tally like any other filter.
 * @returns Value → count, in first-seen order.
 */
const _tallyFacet = (
    rows: readonly SubscriptionListRow[],
    groupKey: SubscriptionFacetGroupKey,
    selection: SubscriptionFacetSelection,
    needle: string
): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const row of rows) {
        if (!matchesSearch(row, needle) || !matchesAllFacets(row, selection, subscriptionFacetValue, groupKey)) {
            continue;
        }
        const value = subscriptionFacetValue(row, groupKey);
        counts.set(value, (counts.get(value) || 0) + 1);
    }
    return counts;
};

/**
 * The on-screen label for one facet value.
 *
 * @param groupKey - The group.
 * @param value - The value.
 * @returns The label, falling back to the raw value — never blank.
 */
const _facetLabel = (groupKey: SubscriptionFacetGroupKey, value: string): string => {
    if (groupKey === 'states') {
        return _STATUS_LABEL_MAP[value] || value;
    }
    if (groupKey === 'install_states') {
        return _INSTALL_STATE_LABEL_MAP[value] || value;
    }
    if (groupKey === 'billing') {
        return BILLING_INTERVAL_LABELS[value] || value;
    }
    return value === NOT_PUSHED_FACET ? NOT_PUSHED_FACET_LABEL : value;
};

/**
 * The values a group must offer even when no row is in them.
 *
 *  A GROUP THAT OMITS ITS EMPTY BUCKETS MAKES A SAMPLE LOOK LIKE A DISTRIBUTION. Two merchants on
 * an annual plan with every other cadence unsettled renders as "100% annual" unless the "Cadence not
 * settled yet" bucket is there holding the denominator. The two closed vocabularies publish every
 * member for the same reason: a status missing because its count is zero reads as "we did not
 * measure it".
 *
 * @param groupKey - The group.
 * @returns Values to include at zero if nothing else produced them.
 */
const _alwaysOffered = (groupKey: SubscriptionFacetGroupKey): readonly string[] => {
    if (groupKey === 'states') {
        return _STATUS_KEYS;
    }
    if (groupKey === 'install_states') {
        return _INSTALL_STATE_KEYS;
    }
    if (groupKey === 'billing') {
        return [BILLING_INTERVAL_UNKNOWN];
    }
    return [NOT_PUSHED_FACET];
};

/**
 * One facet group, built from the list it will filter.
 *
 * Ordering: the always-offered values first, in vocabulary order, then whatever the data produced,
 * commonest first. Vocabulary order is a contract for the closed groups (the status tabs iterate it),
 * and count order is the only useful ordering for an open one.
 *
 * @param groupKey - The group.
 * @param rows - The whole list.
 * @param selection - Every group's validated values.
 * @param needle - The lowercased search query.
 * @returns The group, its label and its options with counts.
 */
const _buildFacetGroup = (
    groupKey: SubscriptionFacetGroupKey,
    rows: readonly SubscriptionListRow[],
    selection: SubscriptionFacetSelection,
    needle: string
): SubscriptionFacetGroup => {
    const counts = _tallyFacet(rows, groupKey, selection, needle);
    const options: StoreFacetOption[] = [];
    const seen = new Set<string>();

    for (const value of _alwaysOffered(groupKey)) {
        seen.add(value);
        options.push({ value, label: _facetLabel(groupKey, value), count: counts.get(value) || 0 });
    }

    const rest = [...counts.entries()]
        .filter(([value]) => !seen.has(value))
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
    for (const [value, count] of rest) {
        options.push({ value, label: _facetLabel(groupKey, value), count });
    }

    return { key: groupKey, label: SUBSCRIPTION_FACET_GROUPS[groupKey], options };
};

/**
 * Status tallies over a set of rows, with every status present and the `ALL` key the tab row reads.
 *
 * ⚠️ Zeros are PRESENT, never omitted. A key missing because its count is zero removes that tab's
 * number entirely, which reads on screen as "we did not measure it" rather than as "it is zero" —
 * and `sum(tabs) === ALL` silently stops holding with nothing to explain it.
 *
 * @param rows - The rows to tally.
 * @returns Every status at its count, plus `ALL`.
 */
const _statusCounts = (rows: readonly SubscriptionListRow[]): SubscriptionStatusCounts => {
    const counts: SubscriptionStatusCounts = { [ALL_COUNT_KEY]: rows.length };
    for (const status of _STATUS_KEYS) {
        counts[status] = 0;
    }
    for (const row of rows) {
        counts[row.status] = (counts[row.status] || 0) + 1;
    }
    return counts;
};

/**
 * Which coverage gates on the app row make this list a floor rather than a total.
 *
 * These read the measurements a sync records ABOUT ITS OWN COMPLETENESS. They never change a number
 * — they say what the number cannot include.
 *
 * @param app - The app row.
 * @param storesKnown - How many stores the fold produced, so the empty-ledger warning is not
 *   fired at an app that has no stores either.
 * @returns Zero or more warning strings.
 */
const _coverageWarnings = (app: PartnerAppDoc, storesKnown: number): string[] => {
    const out: string[] = [];
    if (!app.lifetime_sync_completed_at) {
        // This list is an all-time question — "who is paying right now" is judged against the whole
        // ledger — so the gate applies unconditionally rather than only for a lifetime window.
        out.push(_WARNINGS.lifetimeFloor);
    }

    // ⚠️ `> 0` and an explicit finite check, never truthiness: `0` is a MEASURED "no day-wide hole",
    // the most reassuring value the field can take, and `null` is "never measured". Warning on
    // either would fire the banner on healthy data, which is how a warning stops being read.
    const gapDays = app.event_history_gap_days;
    if (typeof gapDays === 'number' && Number.isFinite(gapDays) && gapDays > 0) {
        out.push(_WARNINGS.eventHistoryGap(gapDays));
    }

    // The store-name backfill boundary, and it has THREE states rather than two. Equal to the
    // earliest event ⇒ there is no boundary left to report and the sentence would be noise; NEWER ⇒
    // the rows below it show a domain; NULL beside a real `earliest_event_at` ⇒ the boundary is the
    // whole history and NO row carries a name at all.
    const nameSince = app.shop_name_coverage_since;
    const earliest = app.earliest_event_at;
    if (nameSince instanceof Date) {
        if (!(earliest instanceof Date) || nameSince.getTime() > earliest.getTime()) {
            out.push(_WARNINGS.shopNameCoverage(nameSince.toISOString()));
        }
    } else if (earliest instanceof Date) {
        out.push(_WARNINGS.shopNameCoverageNone);
    }

    //  THE ONE THAT MATTERS MOST HERE. The population IS the payout ledger, so an empty ledger
    // empties this page — and an empty Subscriptions page reads as "you have no paying customers".
    if (storesKnown > 0 && !app.earliest_transaction_at) {
        out.push(_WARNINGS.noTransactions);
    }
    return out;
};

/**
 * Every merchant currently on a paid plan, with their plan, status and spend.
 *
 * @param params0 - The identity object.
 * @param params0.user_id - The acting operator.
 * @param params1 - The query, already cast (not coerced) by the controller.
 * @param params1.partner_app_id - The app to report on. Required.
 * @param [params1.page] - 1-based page.
 * @param [params1.limit] - Page size, clamped to SUBSCRIPTION_MAX_LIMIT.
 * @param [params1.q] - Free text over name, domain and plan.
 * @param [params1.sort] - One of the allowlisted sort keys. Unrecognised ⇒ ignored + warned.
 * @param [params1.dir] - `asc` or `desc`.
 * @param [params1.states] - Comma-joined SUBSCRIPTION statuses. Unrecognised ⇒ ignored + warned.
 * @param [params1.install_states] - Comma-joined install states.
 * @param [params1.billing] - Comma-joined billing cadences.
 * @param [params1.store_statuses] - The operator's Admin-API reachability verdict.
 * @param [params1.refresh] - Accepted and ignored: there is no cache to invalidate.
 * @returns The list, or an honest
 *   refusal carrying `{}`.
 */
const getSubscriptionList = (
    { user_id }: IdentityObject,
    {
        partner_app_id,
        page,
        limit,
        q,
        sort,
        dir,
        states,
        install_states,
        billing,
        store_statuses
    }: SubscriptionListParams
): Promise<ServiceResult<SubscriptionListResponse | EmptyPayload>> => {
    return new Promise(async (resolve) => {
        try {
            if (!user_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'User ID not available.'));
            }
            if (!partner_app_id) {
                return resolve(promiseReturnResult(false, {}, {}, 'partner_app_id is required. Read it from GET /api/partner-apps.'));
            }

            // THE ONE JUDGEMENT INSTANT. Read once, HERE, and threaded into the fold. Without it the
            // payout rollup, the state machine and the install fold each answer as of a different
            // millisecond, and a store can be simultaneously CHURNED and paying.
            const asOf = new Date();

            // ── THE POPULATION, FOLDED ONCE, SHARED WITH `GET /api/stores` ──
            //
            //  The fold — five reads, the install-state replay, the charge cohort, the canonical MRR
            // predicate, the attribution join and the row build — is the SAME code the Stores roster
            // runs. Nothing about "is this shop paying" is decided in this file.
            const fold = await resolveStoreRosterFold({ partner_app_id: String(partner_app_id), as_of: asOf });
            if (!fold) {
                return resolve(promiseReturnResult(false, {}, {}, 'Partner app not found.'));
            }

            const app: PartnerAppDoc = fold.app;
            const appId = String(app._id);
            const foldDiagnostics = fold.diagnostics;
            const warnings: string[] = [];
            const rejectedFilters: string[] = [];

            const dataState = fold.data_state === SUBSCRIPTION_DATA_STATES.NEVER_SYNCED
                ? SUBSCRIPTION_DATA_STATES.NEVER_SYNCED
                : SUBSCRIPTION_DATA_STATES.READY;
            if (dataState === SUBSCRIPTION_DATA_STATES.NEVER_SYNCED) {
                warnings.push(_WARNINGS.neverSynced);
            }

            const attributionState = fold.attribution_state;
            if (attributionState === STORE_ATTRIBUTION_STATES.NOT_CONNECTED) {
                //  NOT a refusal. This list comes from the Partner API's payout ledger and is
                // complete without listing analytics; only the "Came from" column is empty.
                warnings.push(_WARNINGS.attributionNotConnected(fold.attribution_message));
            } else if (attributionState === STORE_ATTRIBUTION_STATES.NEVER_SYNCED) {
                warnings.push(_WARNINGS.attributionNeverSynced);
            }

            // ── A. MEMBERSHIP. ONE PASS OVER THE FOLD'S ROWS ─────────────────
            //
            //  THE PREDICATE IS `paying_by_domain.has(domain)` AND NOTHING ELSE. Not
            // `state === 'CONVERTED'` (an event-record reading, which disagrees with the ledger for a
            // merchant mid-cancellation), and not `monthly_spend > 0` (a numeric restatement of the
            // same predicate that would silently diverge the day the ledger admits a zero-value
            // member). The set arrives already computed by `modules/revenue`'s `liveSetAsOf`, so this
            // page and the Revenue page cannot disagree about who is paying.
            //
            // Iterating the ROWS rather than the paying map is deliberate: a domain in the map with
            // no row would otherwise become a row built from nothing. That is structurally impossible
            // today — see the diagnostic below — and this loop makes it impossible to publish.
            const rows: SubscriptionListRow[] = [];
            const listed = new Set<string>();
            let neverSettledASubscription = 0;
            let settledButNotPayingNow = 0;
            let ledgerOnlyRows = 0;
            let inferredStatusRows = 0;
            let storesWithoutInstallRecord = 0;
            let storesWithMixedSpendCurrency = 0;

            for (const rosterRow of fold.rows) {
                if (!fold.paying_by_domain.has(rosterRow.shop_domain)) {
                    //  `null` and `0` are DIFFERENT ANSWERS, and they are the two halves of "why is
                    // this merchant not on the list". `null` is "no subscription payout has ever
                    // settled for them" — they never subscribed, or nothing has settled yet. `0` is
                    // measured: money moved once and their billing window has since run out, which is
                    // the CHURN this population cannot show. Counting them apart is what lets the
                    // `population` block reconcile.
                    if (rosterRow.monthly_spend === null) {
                        neverSettledASubscription += 1;
                    } else {
                        settledButNotPayingNow += 1;
                    }
                    continue;
                }

                const row = resolveSubscriptionRow({
                    row: rosterRow,
                    subscription: fold.subscriptions_by_domain.get(rosterRow.shop_domain)
                });
                rows.push(row);
                listed.add(row.shop_domain);

                if (row.ledger_only) {
                    ledgerOnlyRows += 1;
                }
                //  The ONE branch of the state machine that guesses. It is conservative — it claims
                // no revenue and no loss — but on THIS page it sits beside a measured monthly figure,
                // so a reader would otherwise take the status for measured too.
                if (row.status_basis === STATE_BASIS.INFERRED) {
                    inferredStatusRows += 1;
                }
                if (!row.has_install_record) {
                    storesWithoutInstallRecord += 1;
                }
                //  MEMBERSHIP IN THE FOLD'S OWN SET, never a re-derivation from `spend_currency`.
                // That field is `''` both for a sum of unlike units AND for a store whose payouts
                // named no currency at all, so testing it here would count a second, different thing
                // under the same warning.
                if (fold.mixed_spend_currency_domains.has(row.shop_domain)) {
                    storesWithMixedSpendCurrency += 1;
                }
            }

            //  A PAYING MERCHANT THE FOLD PRODUCED NO ROW FOR WOULD BE SILENTLY MISSING, AND THE
            // PAGE WOULD UNDERSTATE BOTH THE COUNT AND THE REVENUE. It cannot happen — every settled
            // `APP_SUBSCRIPTION` payout also lands in the all-type spend rollup, which is one of the
            // three sources of the roster's population — but "cannot happen" is a belief, and this is
            // a measurement. It costs one pass over a map that is at most the size of the paying base.
            let payingDomainsWithoutARow = 0;
            for (const domain of fold.paying_by_domain.keys()) {
                if (!listed.has(domain)) {
                    payingDomainsWithoutARow += 1;
                }
            }

            // ── B. Fail-open validation of everything the caller asked for ───
            const needle = String(q === undefined || q === null ? '' : q).trim().toLowerCase();

            // WRITTEN OUT, not looped, so the COMPILER proves the map is total over this list's facet
            // vocabulary: add a group to `SUBSCRIPTION_FACET_GROUPS` without a line here and this
            // stops compiling. Built as a loop it would type-check with a group missing, and that
            // group would then render a checkbox the server silently ignores.
            const selection: SubscriptionFacetSelection = {
                states: _validateFacetValues('states', states, rows, rejectedFilters, warnings),
                install_states: _validateFacetValues('install_states', install_states, rows, rejectedFilters, warnings),
                billing: _validateFacetValues('billing', billing, rows, rejectedFilters, warnings),
                store_statuses: _validateFacetValues('store_statuses', store_statuses, rows, rejectedFilters, warnings)
            };

            const rawSort = sort === undefined || sort === null ? '' : String(sort).trim();
            let sortKey: SubscriptionListSortKey = DEFAULT_SUBSCRIPTION_SORT_KEY;
            if (rawSort !== '') {
                if (_isSortKey(rawSort)) {
                    sortKey = rawSort;
                } else {
                    rejectedFilters.push(`sort=${rawSort}`);
                    warnings.push(_WARNINGS.unrecognisedSort(rawSort));
                }
            }
            const sortDir: StoreSortDirection = String(dir || '').trim().toLowerCase() === 'asc'
                ? 'asc'
                : DEFAULT_SUBSCRIPTION_SORT_DIR;

            // ── C. Filter, count, sort, page — all from `rows` ───────────────
            const filtered = rows.filter((row) => matchesSearch(row, needle)
                && matchesAllFacets(row, selection, subscriptionFacetValue));

            const statusCounts = _statusCounts(rows);
            // Every OTHER facet applied, plus the search, so a tab's number predicts what clicking it
            // will show. The tab row itself is a shortcut into the `states` group, which is exactly
            // why that group is the one excluded.
            const statusCountsFiltered = _statusCounts(
                rows.filter((row) => matchesSearch(row, needle)
                    && matchesAllFacets(row, selection, subscriptionFacetValue, 'states'))
            );
            const facetGroups = _FACET_KEYS.map((key) => _buildFacetGroup(key, rows, selection, needle));

            // SORT A COPY. `filter` happens to return a new array today, so nothing is wrong right
            // now — but every tally above was taken from `rows`, and the day someone skips the filter
            // when nothing is selected, an in-place sort reorders the very array those tallies came
            // from. It is free to make that impossible rather than true by coincidence.
            const sorted = [...filtered].sort((a, b) => compareSubscriptionRows(a, b, sortKey, sortDir));

            const total = sorted.length;
            const pageLimit = positiveInt(limit, SUBSCRIPTION_DEFAULT_LIMIT, SUBSCRIPTION_MAX_LIMIT);
            const requestedLimit = positiveInt(limit, SUBSCRIPTION_DEFAULT_LIMIT, Number.MAX_SAFE_INTEGER);
            if (requestedLimit > pageLimit) {
                warnings.push(_WARNINGS.limitClamped(String(requestedLimit), pageLimit));
            }
            const pages = total > 0 ? Math.ceil(total / pageLimit) : 0;
            const pageNumber = Math.min(positiveInt(page, 1, Number.MAX_SAFE_INTEGER), Math.max(pages, 1));
            const items = sorted.slice((pageNumber - 1) * pageLimit, pageNumber * pageLimit);

            // ── D. Everything that was excluded, said out loud ───────────────
            warnings.push(..._coverageWarnings(app, fold.rows.length));
            if (ledgerOnlyRows > 0) {
                warnings.push(_WARNINGS.ledgerOnlyRows(ledgerOnlyRows));
            }
            if (inferredStatusRows > 0) {
                warnings.push(_WARNINGS.inferredStatusRows(inferredStatusRows));
            }
            if (payingDomainsWithoutARow > 0) {
                warnings.push(_WARNINGS.payingDomainsWithoutARow(payingDomainsWithoutARow));
            }
            if (storesWithoutInstallRecord > 0) {
                warnings.push(_WARNINGS.storesWithoutInstallRecord(storesWithoutInstallRecord));
            }
            if (storesWithMixedSpendCurrency > 0) {
                warnings.push(_WARNINGS.mixedSpendCurrency(storesWithMixedSpendCurrency));
            }
            if (foldDiagnostics.test_subscriptions_excluded > 0) {
                warnings.push(_WARNINGS.testSubscriptionsExcluded(foldDiagnostics.test_subscriptions_excluded));
            }
            if (foldDiagnostics.skipped_keyless_subscription_events > 0) {
                warnings.push(_WARNINGS.skippedKeylessSubscriptionEvents(foldDiagnostics.skipped_keyless_subscription_events));
            }
            if (foldDiagnostics.unclassified_subscription_rows > 0) {
                warnings.push(_WARNINGS.unclassifiedSubscriptions(foldDiagnostics.unclassified_subscription_rows));
            }

            const diagnostics: SubscriptionListDiagnostics = {
                ledger_only_rows: ledgerOnlyRows,
                inferred_status_rows: inferredStatusRows,
                paying_domains_without_a_row: payingDomainsWithoutARow,
                stores_without_install_record: storesWithoutInstallRecord,
                stores_with_mixed_spend_currency: storesWithMixedSpendCurrency,
                //  The fold's counters, which are about the WHOLE population rather than about the
                // rows listed here. They are still this page's business: a subscription event that
                // was skipped is a status column that may be wrong for someone on this list.
                unclassified_subscription_rows: foldDiagnostics.unclassified_subscription_rows,
                skipped_keyless_subscription_events: foldDiagnostics.skipped_keyless_subscription_events,
                test_subscriptions_excluded: foldDiagnostics.test_subscriptions_excluded,
                unrecognised_filters: rejectedFilters
            };

            /**
             *  WHO IS IN THIS LIST, AND WHO IS NOT, WITH THE ARITHMETIC TO CHECK IT.
             *
             * `stores_known === rows.length + never_settled_a_subscription + settled_but_not_paying_now`
             * by construction — the loop above puts every fold row in exactly one of the three, and
             * `rows.length` is what `status_counts.ALL` publishes. A reader who suspects the
             * population can therefore verify it rather than trust it.
             *
             * ⚠️ It reconciles against `status_counts.ALL` and NOT against `pagination.total`, which
             * is post-filter and post-search.
             */
            const excluded: SubscriptionPopulationExclusions = {
                stores_known: fold.rows.length,
                never_settled_a_subscription: neverSettledASubscription,
                settled_but_not_paying_now: settledButNotPayingNow
            };

            const payload: SubscriptionListResponse = {
                app_id: appId,
                app_name: app.display_name,
                as_of: asOf.toISOString(),

                population: {
                    key: POPULATION_KEY,
                    label: POPULATION_LABEL,
                    statement: POPULATION_STATEMENT,
                    //  The knob that decides membership, published beside the membership. Widen it
                    // and merchants join this list; narrow it and they leave it, having done nothing.
                    // An operator comparing this page with Shopify's own has to be able to see it.
                    live_window_days: config.REVENUE.ACTIVE_SUB_WINDOW_DAYS,
                    excluded
                },

                items,
                pagination: { page: pageNumber, limit: pageLimit, total, pages },
                sort: { key: sortKey, dir: sortDir },

                status_counts: statusCounts,
                status_counts_filtered: statusCountsFiltered,
                facet_groups: facetGroups,
                filters: {
                    q: needle,
                    states: selection.states,
                    install_states: selection.install_states,
                    billing: selection.billing,
                    store_statuses: selection.store_statuses
                },

                meta: {
                    last_synced_at: _iso(app.last_synced_at),
                    earliest_event_at: _iso(app.earliest_event_at),
                    earliest_transaction_at: _iso(app.earliest_transaction_at),
                    lifetime_sync_completed_at: _iso(app.lifetime_sync_completed_at),
                    shop_name_coverage_since: _iso(app.shop_name_coverage_since),
                    domains_seen: fold.rows.length
                },
                statuses: SUBSCRIPTION_STATUS_LABELS,
                install_states: STORE_INSTALL_STATE_LABELS,

                data_state: dataState,
                attribution_state: attributionState,
                // DE-DUPLICATED, and not because any message here is expected twice: warnings are
                // rendered keyed by the string itself, so a duplicate is a React key collision that
                // DROPS one of them — a message silently taking its own twin down with it.
                warnings: [...new Set(warnings)],
                diagnostics
            };

            // THE BANNER'S BODY, AND THE ONLY WAY IT SURVIVES THE FRONTEND'S GATE. `dataState.js`
            // intercepts `data_state === 'NEVER_SYNCED'`, NULLS `data` — warnings and all — and
            // renders the banner body as `data.unknown_reason || resp.msg`. Without this field that
            // resolves to the SUCCESS message, so the page prints "Subscriptions resolved." under the
            // heading "Nothing synced yet", and the explanation above is discarded with the payload.
            if (dataState === SUBSCRIPTION_DATA_STATES.NEVER_SYNCED) {
                payload.unknown_reason = _WARNINGS.neverSynced;
            }

            //  A 200 with zero rows, always. "Nothing synced yet" and "nobody is paying you right
            // now" are separated by `data_state`, `population.excluded` and `warnings[]` — never by a
            // refusal, and never by a 404.
            return resolve(promiseReturnResult(true, payload, {}, 'Subscription list resolved.'));
        } catch (error) {
            customConsoleError('ERROR: Store subscriptionListService getSubscriptionList', error);
            return resolve(promiseReturnResult(false, {}, error, 'Could not read the subscription list. Please try again.'));
        }
    });
};

export = {
    getSubscriptionList
};
