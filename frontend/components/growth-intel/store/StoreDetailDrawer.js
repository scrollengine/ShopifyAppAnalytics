import { Banner, BlockStack, Button, Card, InlineStack, SkeletonBodyText, Spinner, Text, Tooltip } from '@shopify/polaris';
import { ChevronDownIcon, ChevronUpIcon, ExternalIcon } from '@shopify/polaris-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import SlideOverPanel from '../SlideOverPanel';
import GrowthIntelSubscriptionApiService from '../../../API_Services/growth-intel/subscriptionService';
import StoreDetailContent, { StoreStatusBadges } from './StoreDetailContent';
import { normaliseShopDomain, storeDetailRequestParams, storeDetailUrl, storeRowKey } from './storePresentation';

const SUBS_API = new GrowthIntelSubscriptionApiService();

/**
 * How many stores' details are kept in memory.
 *
 * Every open costs the server 5–7 Mongo round trips PLUS a full JSON.parse and
 * date-rehydration of the app's ENTIRE cached subscription row set — the detail
 * response itself is not cached server-side at all, only the row set it is
 * looked up in (180s TTL). So stepping back to a store already opened is the one
 * place a client cache genuinely pays. Bounded because a single store's timeline
 * can carry ~1,100 entries (500 partner events + up to 2 per 200 charges + 200
 * transactions + 1 acquisition); an unbounded map is a slow leak across a long
 * reading session.
 */
const DETAIL_CACHE_LIMIT = 30;

/** The 401 sentinel every growth-intel API service resolves with. It carries no `status`. */
const isNotAllowed = (resp) => !!resp && resp.resource_access === 'NOT_ALLOWED';

/**
 * A store's full detail, in a slide-over over the list that opened it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Clicking a store used to navigate to `/subscriptions/[tenantId]`,
 * which is right as a URL but wrong as an interaction: a list's filters, search,
 * sort and page are React state, not URL state, so coming back re-mounted a
 * fresh unfiltered page 1. Reading down a list of stores meant re-applying the
 * filter for every single one. The panel keeps the list mounted underneath, and
 * the ↑/↓ stepper walks the rows without closing it at all.
 *
 * The full page is still there and still linked — the store-name cell keeps its
 * real `href` (so ⌘-click, middle-click and keyboard still reach it) and the
 * panel header carries an "Open full page" action. A detail URL has to stay
 * shareable and deep-linkable.
 *
 * ⚠️ Deliberately does NOT write the open store into the URL. It could — nothing
 * in this dashboard listens on `routeChangeStart` and the Stores page's URL seeding is
 * behind a one-shot ref guard — but a shallow push per row read would leave the
 * reader ten Back presses from the list, and a reloaded `?store=` would restore a
 * panel over a list whose filters are gone anyway. Escape, the backdrop and the
 * close button are the affordances.
 *
 * @param {Object}   props
 * @param {Object}   props.row        - The clicked store row. `null` closes the panel.
 * @param {String}   props.appId      - Partner app the row belongs to.
 * @param {Function} props.onClose
 * @param {Function} [props.onStep]   - `(delta) => void`, called by the ↑/↓ stepper.
 * @param {Number}   [props.position] - 1-based index of `row` among the rows currently listed.
 * @param {Number}   [props.total]    - How many rows are currently listed.
 * @param {String}   [props.from]     - The list's own path, stamped on the full-page link so that
 *   page's back arrow returns here rather than to its hardcoded Subscriptions default.
 */
const StoreDetailDrawer = ({ row, appId, onClose, onStep, position, total, from }) => {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    /**
     *  Monotonic request id. Only the LATEST response may write state.
     *
     * Nothing cancels an in-flight request, and the stepper fires one per store —
     * so two are routinely in flight at once, and the server has no in-flight
     * coalescing of its own. Without this the loser landing last paints ANOTHER
     * store's detail under the current store's name, silently. Same guard the
     * Stores list uses for its own fetches.
     */
    const requestSeq = useRef(0);
    // Insertion-ordered, so the oldest key is simply the first one Map yields.
    const cache = useRef(new Map());

    /**
     * The lookup key, normalised.
     *
     * Some rows carry the domain RAW off the GA4 export while every other list
     * carries it normalised — without this the same store would occupy two
     * cache slots and be fetched twice. A tenant id passes through untouched
     * (`normaliseShopDomain` only ever lowercases a hex string).
     */
    const rawKey = storeRowKey(row);
    let rowKey = rawKey;
    if (rawKey && !/^[a-f0-9]{24}$/i.test(rawKey)) {
        rowKey = normaliseShopDomain(rawKey);
    }

    // Derived from the row rather than a separate flag, so the two can never
    // disagree while the panel plays its exit animation.
    const open = !!row && !!rowKey && !!appId;

    const readCache = useCallback((key) => {
        if (!key || !appId) return null;
        return cache.current.get(`${appId}|${key}`) || null;
    }, [appId]);

    const writeCache = useCallback((key, payload) => {
        if (!key || !appId) return;
        const map = cache.current;
        map.set(`${appId}|${key}`, payload);
        while (map.size > DETAIL_CACHE_LIMIT) {
            // `Map` iterates in insertion order, so the first key is the oldest.
            const oldest = map.keys().next();
            if (oldest.done) break;
            map.delete(oldest.value);
        }
    }, [appId]);

    useEffect(() => {
        if (!open) return;

        const cached = readCache(rowKey);
        if (cached) {
            // Bump the request id even on a hit: a fetch still in flight for the
            // PREVIOUS store must not overwrite this one when it lands.
            requestSeq.current += 1;
            setData(cached);
            setError('');
            setLoading(false);
            return;
        }

        const params = storeDetailRequestParams(rowKey, appId);
        if (!params) return;

        const seq = ++requestSeq.current;
        setData(null);
        setError('');
        setLoading(true);

        SUBS_API.getDetail(params, (resp) => {
            if (seq !== requestSeq.current) return;
            setLoading(false);
            if (resp && resp.status && resp.data) {
                setData(resp.data);
                setError('');
                writeCache(rowKey, resp.data);
                return;
            }
            setData(null);
            // ⚠️ A 401 resolves with `{resource_access:'NOT_ALLOWED'}` and no
            // `status`, so it lands in this same branch. Said plainly rather
            // than as "could not load", which reads as a broken store record.
            if (isNotAllowed(resp)) {
                setError('You do not have access to this store’s data.');
                return;
            }
            setError((resp && resp.msg) || 'Could not load this store.');
        });
    }, [open, rowKey, appId, readCache, writeCache]);

    const handleStep = useCallback((delta) => {
        if (typeof onStep === 'function') onStep(delta);
    }, [onStep]);


    /**
     * The header renders from the LAST OPEN state, not the live props.
     *
     * Closing nulls `row` synchronously, but the panel stays mounted for another
     * 300ms playing its slide-out — so reading the live props would empty the
     * header while it is still fully visible: the "Open full page" button and the
     * whole stepper unmount and the remaining controls reflow, and if the fetch
     * had not landed yet the heading flips to a literal "Store". Frozen, the panel
     * leaves looking exactly as it did. `open` below still tracks the LIVE `row` —
     * only what is painted is frozen.
     */
    const lastOpen = useRef(null);
    if (row) {
        lastOpen.current = { row, onStep, position, total, from };
    }
    const shown = lastOpen.current || {};
    const shownRow = shown.row || null;

    const sub = (data && data.subscription) || {};
    // Falls back to the row while the fetch is in flight, so the header names the
    // store from the moment it opens instead of flashing an empty title.
    const title = sub.customer_name || (shownRow && (shownRow.customer_name || shownRow.shop_name || shownRow.shop_domain)) || 'Store';
    let subtitle = sub.shop_domain || (shownRow && shownRow.shop_domain) || '';
    // The same rule the store cell uses: rows outside the Stores/Subscriptions lists carry no
    // `customer_name`, so the title falls back to the domain and printing it again underneath is
    // pure noise — visible on Revenue, Revenue Churn, Logo Churn and Trial Funnel, and on every
    // store while its fetch is still in flight.
    if (subtitle === title) {
        subtitle = '';
    }
    // `from` is passed through: without it `safeBackPath` falls back to its hardcoded
    // '/subscriptions', so the full page's back arrow would land somewhere the
    // reader never was. The store-name anchor in the row already stamps it.
    const fullPageUrl = storeDetailUrl(shownRow || {}, appId, shown.from);

    const canStep = typeof shown.onStep === 'function'
        && Number.isFinite(shown.position)
        && Number.isFinite(shown.total)
        && shown.total > 1;

    let stepperMarkup = null;
    if (canStep) {
        stepperMarkup = (
            <InlineStack gap="100" blockAlign="center" wrap={false}>
                <Tooltip content="Previous store">
                    <Button
                        icon={ChevronUpIcon}
                        variant="tertiary"
                        disabled={shown.position <= 1}
                        onClick={() => handleStep(-1)}
                        accessibilityLabel="Previous store"
                    />
                </Tooltip>
                {/* ⚠️ `total` is the rows RENDERED, which is one page of results (25 on the
                    Stores and Subscriptions lists) and only the first 10 on a collapsed install
                    cohort — never the list's full size, which the footer states separately. The
                    tooltip says so rather than letting "3 of 25" contradict "10,562 stores". */}
                <Tooltip content="Position among the rows listed on this page">
                    <Text as="span" variant="bodySm" tone="subdued">{`${shown.position} of ${shown.total}`}</Text>
                </Tooltip>
                <Tooltip content="Next store">
                    <Button
                        icon={ChevronDownIcon}
                        variant="tertiary"
                        disabled={shown.position >= shown.total}
                        onClick={() => handleStep(1)}
                        accessibilityLabel="Next store"
                    />
                </Tooltip>
            </InlineStack>
        );
    }

    let fullPageMarkup = null;
    if (fullPageUrl) {
        fullPageMarkup = (
            <Tooltip content="Open the full detail page in a new tab">
                {/* A new tab, not this one. The list's filters, sort and page are
                    component state, so navigating away in this tab throws away
                    exactly the context the panel exists to preserve. */}
                <Button
                    url={fullPageUrl}
                    target="_blank"
                    icon={ExternalIcon}
                    variant="tertiary"
                    accessibilityLabel="Open full page"
                />
            </Tooltip>
        );
    }

    let bodyMarkup = null;
    if (loading && !data) {
        bodyMarkup = <Card><SkeletonBodyText lines={12} /></Card>;
    } else if (error || !data) {
        bodyMarkup = (
            <Banner tone="critical" title="Not available">
                <p>{error || 'This store has no record for the selected app.'}</p>
            </Banner>
        );
    } else {
        bodyMarkup = (
            <BlockStack gap="400">
                {loading ? (
                    <InlineStack gap="200" blockAlign="center">
                        <Spinner size="small" />
                        <Text as="span" tone="subdued">Refreshing…</Text>
                    </InlineStack>
                ) : null}
                <StoreDetailContent data={data} layout="stacked" />
            </BlockStack>
        );
    }

    let titleMetadata = null;
    if (data) {
        titleMetadata = <StoreStatusBadges subscription={sub} />;
    }

    return (
        <SlideOverPanel
            open={open}
            onClose={onClose}
            title={title}
            subtitle={subtitle}
            titleMetadata={titleMetadata}
            accessibilityLabel={`${title} store details`}
            scrollResetKey={rowKey}
            headerActions={(
                <InlineStack gap="200" blockAlign="center" wrap={false}>
                    {stepperMarkup}
                    {fullPageMarkup}
                </InlineStack>
            )}
        >
            {bodyMarkup}
        </SlideOverPanel>
    );
};

export default StoreDetailDrawer;
