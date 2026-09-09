import { useCallback, useRef, useState } from 'react';

/**
 * Measure a node's width into state, keyed on the NODE'S LIFECYCLE rather than the component's.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * ------------------------------
 * The obvious shape — a `useRef` plus a `useEffect(..., [])` that reads `ref.current` and attaches a
 * ResizeObserver — is silently wrong whenever the measured node lives in only ONE of several return
 * paths. `PartnerFunnelChart` had exactly that: an early `if (!loading && steps.length === 0)` return
 * with no measured node, and a parent that initialises `loading` to `false` and its data to `null`.
 * So on every first page load the mount effect ran while the node did not exist, bailed out, and —
 * with `[]` deps — never ran again. The width stayed at its fallback for the life of the mount, and
 * the chart rendered letterboxed with its HTML label layer detached from its SVG bars. Switching tabs
 * "fixed" it only because that unmounts and remounts with data already present.
 *
 * A callback ref is the one mechanism whose invocation is defined by node attach/detach — which is
 * precisely the event the observer cares about. It needs to know nothing about loading flags, data
 * shape, tabs, or how many early returns the component has, and it stays correct when someone adds
 * another one.
 *
 *  DO NOT "fix" a stale measurement by adding the render predicate to a dep array. That duplicates
 * the invariant into two places that must be hand-maintained, and it is the change that looks right
 * while re-arming the bug the next time the guard changes.
 *
 * @param {Number} fallback - width used until the first real measurement.
 * @returns {[Number, Function]} `[width, measureRef]` — spread the ref onto the node whose width you
 *   want. Attach it to the SAME node that contains everything positioned from the measurement; an
 *   outer container picks up padding and reintroduces a subtle offset.
 */
export const useMeasuredWidth = (fallback) => {
    const [width, setWidth] = useState(fallback);
    const observerRef = useRef(null);

    const measureRef = useCallback((node) => {
        // Disconnected FIRST, before the null check, so this handles node→null and node→newNode
        // identically and is idempotent. React 18 IGNORES a value returned from a ref callback (that
        // is React 19 semantics), so a `return () => ro.disconnect()` here would never run and would
        // leak an observer on every detach.
        if (observerRef.current) {
            observerRef.current.disconnect();
            observerRef.current = null;
        }
        if (!node || typeof window === 'undefined') {
            return;
        }

        // Synchronous seed. A ResizeObserver delivers its FIRST observation asynchronously, so
        // without this the first painted frame is still in fallback coordinates — one invisible frame
        // on a fast machine, a visible jump on a slow load. Reading the box inside the ref callback
        // happens during commit, before paint.
        const seed = node.getBoundingClientRect().width;
        if (seed > 0) {
            setWidth(seed);
        }

        if (typeof window.ResizeObserver === 'undefined') {
            return;
        }
        const ro = new window.ResizeObserver((entries) => {
            for (const entry of entries) {
                const w = entry.contentRect && entry.contentRect.width;
                // A hidden or detached node reports 0. Callers clamp their geometry to a floor, so an
                // unguarded 0 collapses a chart to a sliver instead of failing loudly.
                if (w && w > 0) {
                    setWidth(w);
                }
            }
        });
        ro.observe(node);
        observerRef.current = ro;
        // Closes over nothing that changes — only `setWidth` (a stable setter) and `observerRef`. A
        // value referenced here would be pinned to the first render forever.
    }, []);

    return [width, measureRef];
};

export default useMeasuredWidth;
