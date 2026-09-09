import { useCallback, useState } from 'react';
import { useRouter } from 'next/router';
import StoreDetailDrawer from './StoreDetailDrawer';
import { storeRowKey } from './storePresentation';

/**
 * Attach the store detail slide-over to ANY table of shop rows.
 *
 * WHY A HOOK
 * ----------
 * `StoreTable` is the shared table, but it is not the only place a store is
 * listed: Revenue's "Top shops", Revenue Churn's churned-customer list, Logo
 * Churn's, and Trial Funnel's trial list are all hand-rolled `IndexTable`s with
 * columns that have no equivalent in the shared column registry (lifetime net,
 * paid days, trial dates). Rewriting them onto `StoreTable` would lose those
 * columns; re-implementing open/close/highlight/step in each would be four
 * copies of the fiddly part. So the behaviour lives here and every table — the
 * shared one included — spends three lines on it.
 *
 * A row is openable when it carries an identity the detail endpoint accepts: a
 * `tenant_id`, or failing that a `shop_domain`. Rows with neither (a partner
 * event whose shop never resolved to a domain) are simply not clickable —
 * `canOpen` says so, and the caller uses it to decide whether to wire `onClick`
 * at all, rather than offering a click that opens an error.
 *
 * @param {Object}   params
 * @param {Array}    params.rows      - The rows currently RENDERED, in render order. Drives the
 *   stepper and the "N of M" readout, so pass the visible slice, not the whole result set.
 * @param {String}   params.appId     - Partner app the rows belong to.
 * @param {Function} [params.rowKey]  - `(row, index) => key`, the SELECTION identity (which row is
 *   highlighted). Distinct from the API identity, which the drawer derives itself. Defaults to
 *   `tenant_id || shop_domain`; pass one whose value is unique per rendered row when a store can
 *   legitimately appear twice.
 * @param {Function} [params.toStoreRow] - `(row) => ({tenant_id?, shop_domain?, customer_name?})`,
 *   for tables whose rows do not already carry those field names. ⚠️ `shop_id` means DIFFERENT
 *   things per endpoint: on Logo Churn and Trial Funnel it is the `tenant_id`, while on
 *   Revenue and Revenue Churn it is Shopify's partner shop id, which the detail endpoint cannot
 *   resolve at all. Map it only where it really is a tenant id; elsewhere leave the domain to do
 *   the work.
 * @returns {Object} `{ drawer, open, close, isOpen, canOpen, selectedKey }` — render `drawer`
 *   anywhere (it portals itself out), call `open(row, index)` from the row's onClick, and use
 *   `isOpen(row, index)` for `IndexTable.Row`'s `selected`.
 */
const useStoreDetailDrawer = ({ rows, appId, rowKey, toStoreRow }) => {
    const router = useRouter();
    /**
     * The open store: BOTH its selection key and the row object itself.
     *
     *  Holding only the key, and resolving it to `rows[i]` on every render, looks tidier and is
     * wrong twice over. A list request landing after the panel opened replaces `rows`; if the open
     * store is not in the new set the panel vanishes on its own, and — worse — it is only HIDDEN,
     * because the key is still in state, so bringing the row back reopens a panel the reader closed
     * long ago. Keeping the row means the panel shows what was clicked until it is closed.
     *
     * The key is still kept, but only to locate the store in the CURRENT list, for the highlight and
     * the stepper. Both degrade to "not in this list" rather than to "closed".
     */
    const [selected, setSelected] = useState(null);

    // Stamped onto the drawer's "Open full page" link so that page's back arrow returns to THIS
    // list rather than to its hardcoded Subscriptions default.
    const from = router.asPath;

    const _key = rowKey || ((row) => storeRowKey(row));
    const _toStoreRow = toStoreRow || ((row) => row);
    const safeRows = Array.isArray(rows) ? rows : [];
    const selectedKey = selected ? selected.key : null;

    // -1 means "open, but its row is not in the list as it stands now".
    let selectedIndex = -1;
    if (selectedKey !== null) {
        selectedIndex = safeRows.findIndex((row, i) => String(_key(row, i)) === selectedKey);
    }
    // Prefer the live row while the store is still listed, so a refreshed list feeds the panel its
    // newer values; fall back to the row as clicked.
    let selectedRow = selected ? selected.row : null;
    if (selectedIndex >= 0) {
        selectedRow = _toStoreRow(safeRows[selectedIndex]);
    }

    const open = useCallback((row, index) => {
        if (!row) return;
        // The ADAPTED row is what gets stored: the drawer, its header and its "Open full page" link
        // all read `tenant_id`/`shop_domain`/`customer_name` off it, and the selection key is
        // computed from the ORIGINAL so it still matches what the render used.
        setSelected({ key: String(_key(row, index)), row: _toStoreRow(row) });
        // `_key` is rebuilt each render when no `rowKey` is passed, which is why it is a dependency
        // rather than being closed over — the identity has to match what the render used.
    }, [_key, _toStoreRow]);

    const close = useCallback(() => setSelected(null), []);

    const isOpen = useCallback(
        (row, index) => selectedKey !== null && String(_key(row, index)) === selectedKey,
        [selectedKey, _key]
    );

    // Whether the detail endpoint could resolve this row at all. `storeRowKey` returns '' when the
    // row carries neither a tenant id nor a domain.
    const canOpen = useCallback((row) => !!appId && !!storeRowKey(_toStoreRow(row)), [appId, _toStoreRow]);

    // Walks the rows currently listed. Clamped rather than wrapped: a stepper that jumps from the
    // last row back to the first reads as a bug, and the buttons are disabled at both ends anyway.
    const step = useCallback((delta) => {
        setSelected((current) => {
            if (!current) return current;
            const at = safeRows.findIndex((row, i) => String(_key(row, i)) === current.key);
            // Not in this list any more: there is no "next" to step to, so hold still. The stepper
            // is withheld in that state anyway.
            if (at < 0) return current;
            const next = at + delta;
            if (next < 0 || next >= safeRows.length) return current;
            return { key: String(_key(safeRows[next], next)), row: _toStoreRow(safeRows[next]) };
        });
    }, [safeRows, _key, _toStoreRow]);

    // Withheld when the open store is not in the current list — "2 of 25" would then be a lie, and
    // the drawer hides its whole stepper when `onStep` is absent.
    let stepHandler;
    if (selectedIndex >= 0) {
        stepHandler = step;
    }

    const drawer = (
        <StoreDetailDrawer
            row={selectedRow}
            appId={appId}
            onClose={close}
            onStep={stepHandler}
            position={selectedIndex + 1}
            total={safeRows.length}
            from={from}
        />
    );

    return { drawer, open, close, isOpen, canOpen, selectedKey, from };
};

export default useStoreDetailDrawer;
