'use strict';

/**
 * ============================================================================
 *  THE INSTALL-COHORT READS — the three bounds that are INVISIBLE when missing
 * ============================================================================
 *
 *  `installCohort.test.js` stubs this repository out and exercises everything above it. That is the
 *  right shape for a fold, and it is exactly why the QUERIES themselves need a file of their own:
 *  every defect below returns a well-formed result with a wrong number in it, and no layer above can
 *  tell the difference.
 *
 *  Each model is replaced with a recorder before the repository is required, so what is asserted is
 *  the query document Mongo would actually have received.
 *
 *  ──  1. THE SETTLED-PAYOUT READ IS BOUNDED AT `as_of` ─────────────────────
 *  It shipped unbounded. A payout settling in June was evidence inside a January window, so a
 *  subscription whose ACCEPTED event carried no `charge.billingOn` took the `conversion_date === null`
 *  branch, found `everSettled`, and was published CONVERTED on `state_basis: 'settled_payout'` — a
 *  named merchant, as of a date they had not paid. One-directional, because the other two inputs ARE
 *  clamped: future churn was excluded while future revenue was admitted.
 *
 *  ⚠️ And the bound is on `created_at`, Shopify's SETTLEMENT timestamp — never `createdAt`, which
 *  `timestamps` writes when WE inserted the row. Bounding on that one does not error; it clamps by
 *  sync time, so a lifetime backfill falls inside every window at once.
 *
 *  ──  2. THE SPINE EXCLUDES A MISSING `shop_domain`, NOT ONLY AN EMPTY ONE ─
 *  `$ne: ''` matches a document with no `shop_domain` FIELD, which then groups under `_id: null` and
 *  becomes a row whose domain is `null`. That row reaches `_compareRows`, which calls `localeCompare`
 *  on it, and the service's catch turns the TypeError into a refusal of the whole endpoint. The
 *  exclusion tally beside it always counted `{ $in: ['', null] }`, so the two lines disagreed about
 *  the same document.
 *
 *  ──  3. END EVENTS ARE ALSO FETCHED BY CHARGE ─────────────────────────────
 *  The domain-scoped pull cannot see a cancellation whose `shop_domain` is blank — a shop redacted
 *  between its INSTALL and its cancel — but churn evidence joins on `charge_id` and needs no domain.
 *  Without the second pass that store never churns and stays CONVERTED for ever.
 * ============================================================================
 */

process.env.LOG_LEVEL = 'silent';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mongoose = require('mongoose');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(BACKEND_ROOT, 'src');

/** Never reached — every model is a recorder — but a short buffer keeps a mistake from hanging. */
mongoose.set('bufferTimeoutMS', 400);

/** A real ObjectId, because `toObjectId` throws on anything else rather than matching nothing. */
const APP_ID = '64b7f9c2e1a2b3c4d5e6f701';

const CALLS = { find: [], aggregate: [], count: [] };

const _reset = () => {
    CALLS.find = [];
    CALLS.aggregate = [];
    CALLS.count = [];
};

/** The chainable `find` builder the repository uses: `.select(…).sort(…).lean()`. */
const _builder = (rows) => {
    const chain = {
        select() {
            return chain;
        },
        sort() {
            return chain;
        },
        lean: async () => rows
    };
    return chain;
};

const _recorder = (name, rows) => ({
    find: (query) => {
        CALLS.find.push({ model: name, query });
        return _builder(rows);
    },
    aggregate: async (pipeline) => {
        CALLS.aggregate.push({ model: name, pipeline });
        return rows;
    },
    countDocuments: async (query) => {
        CALLS.count.push({ model: name, query });
        return 0;
    }
});

/**
 * ⚠️ The models are swapped BEFORE the repository is required. It destructures them at module load,
 * so a swap afterwards would be a test that passes while asserting nothing.
 */
const modelsRepository = require(path.join(SRC, 'modules', 'shared', 'repositories', 'models.repository.ts'));

const EVENT_ROWS = [
    { event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED', shop_domain: 'a.myshopify.com', charge_id: '111', occurred_at: new Date('2026-08-01T00:00:00.000Z') },
    { event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED', shop_domain: 'b.myshopify.com', charge_id: '', occurred_at: new Date('2026-08-02T00:00:00.000Z') },
    { event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED', shop_domain: 'c.myshopify.com', charge_id: '111', occurred_at: new Date('2026-08-03T00:00:00.000Z') }
];

const EVENT_MODEL = _recorder('event', EVENT_ROWS);
modelsRepository.PartnerAppEventModel = EVENT_MODEL;
modelsRepository.PartnerAppTransactionModel = _recorder('transaction', []);
modelsRepository.ListingInstallAttributionModel = _recorder('attribution', []);

const repository = require(path.join(SRC, 'modules', 'conversion', 'repositories', 'installCohort.repository.ts'));

const DOMAINS = ['a.myshopify.com', 'b.myshopify.com', 'c.myshopify.com'];
const AS_OF = new Date('2026-08-31T23:59:59.999Z');

/** The `$match` stage of the one aggregate a call issued. */
const _matchOf = (call) => call.pipeline.find((stage) => stage.$match).$match;


/* ==========================================================================
 *  1. The settled-payout bound
 * ========================================================================== */

test('the settled-payout read is bounded at as_of, on Shopify\'s settlement timestamp', async () => {
    _reset();
    await repository.aggregateSettledSubscriptionCharges({
        partner_app_id: APP_ID,
        domains: DOMAINS,
        as_of: AS_OF
    });

    assert.equal(CALLS.aggregate.length, 1, 'One chunk, one aggregate.');
    const match = _matchOf(CALLS.aggregate[0]);

    assert.ok(match.created_at, 'UNBOUNDED, a June payout is evidence inside a January window and the '
        + 'store is published CONVERTED as of a date it had not paid.');
    assert.equal(match.created_at.$lte.getTime(), AS_OF.getTime());
    assert.equal(match.created_at.$gte, undefined,
        'A LOWER bound would be a different defect: a store that converted before this window would '
        + 'read as never having paid.');

    assert.equal(match.createdAt, undefined,
        '⚠️ `createdAt` is when WE inserted the row. Bounding on it does not error — it clamps by sync '
        + 'time, so a lifetime backfill falls inside every window at once.');

    assert.equal(match.type, 'APP_SUBSCRIPTION',
        'Usage and one-time charges are real money and are not evidence that a SUBSCRIPTION converted.');
    assert.deepEqual(match.shop_domain, { $in: DOMAINS });
    assert.ok(match.partner_app_id instanceof mongoose.Types.ObjectId,
        '`aggregate` does not auto-cast: an uncast string id matches ZERO documents and raises no error.');
});


/* ==========================================================================
 *  2. The spine's exclusion filter
 * ========================================================================== */

test('the spine excludes a MISSING shop_domain, not merely an empty one', async () => {
    _reset();
    await repository.aggregateInstallSpine({
        partner_app_id: APP_ID,
        since: new Date('2026-08-01T00:00:00.000Z'),
        until: AS_OF
    });

    const match = _matchOf(CALLS.aggregate[0]);
    assert.deepEqual(match.shop_domain, { $nin: ['', null] },
        '`$ne: ""` matches a document with NO shop_domain field, which groups under `_id: null` and '
        + 'becomes a row whose domain is null — which then throws inside `localeCompare` and refuses '
        + 'the whole endpoint.');

    assert.equal(CALLS.count.length, 1, 'The exclusion is counted, never merely applied.');
    assert.deepEqual(CALLS.count[0].query.shop_domain, { $in: ['', null] },
        'The tally and the filter must posit the SAME document, or one of them is measuring a threat '
        + 'the other does not believe in.');
    assert.deepEqual(match.occurred_at, { $gte: new Date('2026-08-01T00:00:00.000Z'), $lte: AS_OF });
});

test('a lifetime window carries no occurred_at clause at all', async () => {
    _reset();
    await repository.aggregateInstallSpine({ partner_app_id: APP_ID, since: null, until: null });

    assert.equal(_matchOf(CALLS.aggregate[0]).occurred_at, undefined,
        'A bound at the beginning of time makes the planner range-scan from 1970 for the same answer.');
});


/* ==========================================================================
 *  3. The charge-event pull, and the churn evidence it used to miss
 * ========================================================================== */

test('the charge-event pull has an upper bound and NO lower bound', async () => {
    _reset();
    await repository.findChargeCohortEvents({ partner_app_id: APP_ID, until: AS_OF, domains: DOMAINS });

    const domainPass = CALLS.find[0].query;
    assert.deepEqual(domainPass.occurred_at, { $lte: AS_OF },
        'A `$gte` here hides the subscription of a store that installed inside the window and '
        + 'subscribed before it — and reports a paying customer as INSTALLED.');
    assert.deepEqual(domainPass.shop_domain, { $in: DOMAINS });
});

test('END events are fetched by charge as well as by domain', async () => {
    _reset();
    await repository.findChargeCohortEvents({ partner_app_id: APP_ID, until: AS_OF, domains: DOMAINS });

    assert.equal(CALLS.find.length, 2,
        'Churn evidence joins on `charge_id` and needs no domain. Without the second pass a shop '
        + 'redacted between its INSTALL and its cancellation never churns and stays CONVERTED for ever.');

    const chargePass = CALLS.find[1].query;
    assert.deepEqual(chargePass.charge_id, { $in: ['111'] },
        'Deduped, and taken from the STORED column — the indexed field, normalised on write to the '
        + 'same bare numeric form as the money side.');
    assert.deepEqual(chargePass.shop_domain, { $in: ['', null] },
        'Disjoint from the first pass by construction, so no end date can be pushed into the fold twice.');
    assert.deepEqual(chargePass.occurred_at, { $lte: AS_OF },
        'Same judgement instant: a cancellation after it has not happened yet from this window.');
    assert.ok(!chargePass.event_type.$in.includes('SUBSCRIPTION_CHARGE_ACCEPTED'),
        'END types only. A blank-domain START would build a bucket the per-domain fold cannot place.');
    assert.ok(chargePass.event_type.$in.includes('SUBSCRIPTION_CHARGE_CANCELLED'));
    assert.ok(chargePass.event_type.$in.includes('UNINSTALL'),
        'Relationship ends carry no charge block, so they still arrive through the domain pass — but '
        + 'excluding them here would be a rule about a list rather than about the data.');
});

test('no second pass is issued when nothing named a charge', async () => {
    _reset();
    // ⚠️ The METHOD is swapped, never the object. The repository destructured the model at load, so
    // re-assigning `modelsRepository.PartnerAppEventModel` here would leave the repository pointing
    // at the old recorder and this test would assert nothing.
    const _restore = EVENT_MODEL.find;
    EVENT_MODEL.find = (query) => {
        CALLS.find.push({ model: 'event', query });
        return _builder([{ event_type: 'SUBSCRIPTION_CHARGE_ACCEPTED', shop_domain: 'b.myshopify.com', charge_id: '' }]);
    };

    try {
        await repository.findChargeCohortEvents({ partner_app_id: APP_ID, until: AS_OF, domains: DOMAINS });
        assert.equal(CALLS.find.length, 1, 'An empty `$in` is a query that reads the index to return nothing.');
    } finally {
        EVENT_MODEL.find = _restore;
    }
});
