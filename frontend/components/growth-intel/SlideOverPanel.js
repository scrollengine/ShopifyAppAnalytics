import {
    Backdrop, BlockStack, Button, InlineStack, Portal, Text, TrapFocus,
    _SECRET_INTERNAL_WITHIN_CONTENT_CONTEXT as WithinContentContext
} from '@shopify/polaris';
import { XIcon } from '@shopify/polaris-icons';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

/**
 *  Which panels are on screen, oldest first. Escape belongs to the LAST one only.
 *
 * Every panel binds its Escape handler to `document` in the CAPTURE phase, and
 * `stopPropagation()` does NOT stop other listeners already bound to the SAME node in
 * the SAME phase — that would need `stopImmediatePropagation`, which fires in
 * registration order and so would hand Escape to the OLDEST panel, exactly backwards.
 * So the panels arbitrate among themselves here: a panel opened from inside another
 * one (a store opened from the revenue-movement panel's table) closes alone, leaving
 * the panel underneath it open, and one Escape does not collapse the whole stack.
 *
 * `stopPropagation()` is still called by the topmost panel, because a Polaris `Modal`
 * underneath binds in the BUBBLE phase, where it does work.
 */
const _panelStack = [];

/**
 * Marks the panel body as a CONTENT CONTAINER, the way Polaris `Modal` does.
 *
 * `Banner` reads this context and renders two different ways: loud and page-level
 * outside a container, quiet and inline inside one. `Modal` wraps everything in
 * `<WithinContentContext.Provider value={true}>` (Modal.js:138), which is why the
 * banners in the modals this panel replaced were the quiet kind — and why, without
 * this, converting a modal silently changes every banner in it into a full-bleed
 * red slab, while banners nested in a `Card` stay quiet and the two clash.
 *
 * ⚠️ The export really is named `_SECRET_INTERNAL_…`. It is the only way Polaris
 * exposes the context, and composing an overlay is exactly what it is for — but
 * the name is a promise that it can move. Hence the fallback: if a future Polaris
 * drops it, banners get loud again rather than the app crashing on a
 * `.Provider` of undefined.
 */
const _WithinContent = ({ children }) => {
    if (!WithinContentContext || !WithinContentContext.Provider) return children;
    return <WithinContentContext.Provider value>{children}</WithinContentContext.Provider>;
};

/**
 * A right-side slide-over panel — a detail view that opens OVER the list that
 * launched it, so the list keeps its filters, its page and its scroll position.
 *
 * WHY NOT POLARIS
 * ---------------
 * `Sheet` is deprecated (it console-warns on every mount in development and is
 * documented as removable in a future major), is fixed at 23.75rem — far too
 * narrow for a detail view — and gives you no header, body or footer structure.
 * `Modal` is centred and caps at 61.25rem, and a centred dialog reads as
 * "you have left the list" rather than "the list is still there behind this".
 *
 * WHAT IT STILL BORROWS FROM POLARIS
 * ----------------------------------
 * `Backdrop`, which is not just a dim layer: it renders Polaris's `ScrollLock`,
 * whose manager is REFERENCE COUNTED across every overlay in the app. That is
 * what lets this panel open on top of an existing `Modal` without the two
 * fighting over `document.body` — closing the panel decrements to 1 and the
 * modal keeps its lock, closing the modal decrements to 0 and the page scroll
 * position is restored. A hand-rolled `body.style.overflow` would clobber it.
 *
 *  ESCAPE, WHEN SOMETHING IS OPEN UNDERNEATH
 * -------------------------------------------
 * Two different problems, two different mechanisms.
 *
 * Against a Polaris `Modal`: it closes on Escape via TWO document-level
 * `KeypressListener`s — one `keydown` (arms the close) and one `keyup`
 * (performs it), both in the BUBBLE phase. Both events are intercepted here on
 * `document` in the CAPTURE phase and stopped: capture at `document` runs before
 * the bubble-phase listeners on the same node, and `stopPropagation()` sets a
 * flag the dispatch algorithm re-checks for every later listener in the path,
 * including the bubble pass back at `document`. Handling only `keydown` would
 * leave the modal's `keyup` free to close the modal underneath.
 *
 * Against another PANEL: `stopPropagation()` is useless, because both panels
 * bind in the same phase on the same node — see `_panelStack` below.
 *
 * @param {Object}   props
 * @param {Boolean}  props.open                 - Panel visibility. Toggling to false plays the exit animation before unmounting.
 * @param {Function} props.onClose              - Called by the close button, the backdrop and Escape.
 * @param {Node}     [props.title]              - Heading content.
 * @param {Node}     [props.subtitle]           - Secondary line under the heading.
 * @param {Node}     [props.titleMetadata]      - Badges rendered beside the heading.
 * @param {Node}     [props.headerActions]      - Controls rendered left of the close button.
 * @param {Node}     [props.footer]             - Pinned footer content. Omitted entirely when absent.
 * @param {String}   [props.width]              - Any CSS width. Defaults to `min(52rem, 100vw)`.
 * @param {String}   [props.accessibilityLabel] - Screen-reader label for the dialog.
 * @param {*}        [props.scrollResetKey]     - Change it to scroll the body back to the top.
 * @param {Node}     props.children             - Scrolling body content.
 */

const SlideOverPanel = ({
    open,
    onClose,
    title,
    subtitle,
    titleMetadata,
    headerActions,
    footer,
    width,
    accessibilityLabel,
    scrollResetKey,
    children
}) => {
    /**
     * `mounted` outlives `open` by one animation so the panel can slide OUT
     * instead of disappearing. `entered` is the class that drives both
     * transforms, flipped one paint after mount so the browser has an initial
     * `translateX(100%)` to animate FROM — set in the same frame and the
     * transition is skipped entirely.
     */
    const [mounted, setMounted] = useState(false);
    const [entered, setEntered] = useState(false);
    const exitTimer = useRef(null);
    const rafIds = useRef([]);
    /**
     * What had focus when the panel opened, so it can be given back on close.
     *
     * Focus is moved INTO the panel on open (below) and nothing in Polaris records
     * where it came from — `TrapFocus` has no restore step at all. Without this,
     * closing leaves focus on `document.body`: a keyboard reader who tabbed down to
     * a store row, opened it and pressed Escape lands back at the top of the page
     * and has to tab all the way down again. The row is the natural landing place,
     * and restoring the activator is what Polaris's own `Sheet` does.
     */
    const returnFocusTo = useRef(null);
    const panelId = useId();
    const panelRef = useRef(null);
    const bodyRef = useRef(null);

    // One place to drop pending work, used by every path that unmounts or
    // re-runs the effect. A rAF or timeout that survives unmount would call
    // setState on a dead component.
    const cancelPending = useCallback(() => {
        if (exitTimer.current) {
            clearTimeout(exitTimer.current);
            exitTimer.current = null;
        }
        for (const id of rafIds.current) {
            cancelAnimationFrame(id);
        }
        rafIds.current = [];
    }, []);

    useEffect(() => {
        cancelPending();
        if (open) {
            // Recorded BEFORE `setMounted`, so it is still the element the reader
            // activated rather than anything TrapFocus has moved focus to. Only
            // recorded on the transition INTO open — re-recording while already
            // open (a step to the next store) would capture a control inside the
            // panel, which is about to be unmounted.
            if (!mounted) {
                returnFocusTo.current = document.activeElement;
            }
            setMounted(true);
            // Double rAF, not one: the first frame is where React's commit is
            // painted with the panel still off-screen, the second is the
            // earliest the class can flip and still produce a transition.
            const first = requestAnimationFrame(() => {
                const second = requestAnimationFrame(() => {
                    setEntered(true);
                    /**
                     *  Focus is moved EXPLICITLY, not left to `TrapFocus`.
                     *
                     * Polaris arbitrates focus through one app-wide `FocusManager`:
                     * `add` APPENDS to `trapFocusList` and every trap computes
                     * `canSafelyFocus = trapFocusList[0] === id` — so the FIRST trap
                     * registered owns focus, not the newest. Opened over anything
                     * that already traps — a Polaris `Modal`, or another panel such
                     * as the revenue-movement one whose table opens store details —
                     * this panel's `canSafelyFocus` is false and its `TrapFocus`
                     * never moves focus in. It would be unreachable by keyboard and
                     * unannounced to a screen reader, while looking perfectly fine
                     * on screen.
                     *
                     * The panel itself carries `tabIndex={-1}`, so focusing the
                     * container puts the reader at the top of the dialog and lets
                     * Tab walk it from there. `preventScroll` because the panel is
                     * still mid-transform and focusing it would otherwise scroll the
                     * locked page underneath.
                     */
                    const panel = panelRef.current;
                    if (panel && !panel.contains(document.activeElement)) {
                        panel.focus({ preventScroll: true });
                    }
                });
                rafIds.current.push(second);
            });
            rafIds.current.push(first);
            return cancelPending;
        }
        setEntered(false);
        // Matches --p-motion-duration-300, the transition on .se-slideover__panel.
        exitTimer.current = setTimeout(() => {
            setMounted(false);
            const target = returnFocusTo.current;
            returnFocusTo.current = null;
            // ⚠️ `isConnected`: the panel routinely outlives the element that opened
            // it — a filter can replace the whole table underneath. Focusing a
            // detached node silently drops focus to <body>, which is the outcome
            // this is here to avoid, so skip rather than pretend.
            if (target && target.isConnected && typeof target.focus === 'function') {
                target.focus();
            }
        }, 300);
        return cancelPending;
        // `mounted` is read to decide whether this is the transition INTO open; it
        // must not re-trigger the effect, which is why it is not a dependency.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, cancelPending]);

    /**
     * The body is ONE scroll container reused for every subject the panel shows, so
     * its `scrollTop` survives a change of contents. Stepping from a store read to
     * the bottom straight into another one would open the next store part-way down
     * its timeline. Forward steps hide this by accident — a fresh fetch renders a
     * short skeleton first, which clamps the offset — so it only surfaces on a cache
     * hit, i.e. when stepping BACK to a store already looked at.
     */
    useEffect(() => {
        if (!mounted) return;
        if (bodyRef.current) bodyRef.current.scrollTop = 0;
    }, [scrollResetKey, mounted]);

    /**
     * Escape. Bound while the panel is on screen, on `document`, in the capture
     * phase — see the note at the top of the file for why both key events are
     * stopped and why capture is the phase that matters.
     */
    useEffect(() => {
        if (!mounted || !open) return undefined;

        _panelStack.push(panelId);

        const handleKey = (event) => {
            if (event.key !== 'Escape' && event.keyCode !== 27) return;
            // Only the topmost panel reacts — see the note on `_panelStack`.
            if (_panelStack[_panelStack.length - 1] !== panelId) return;
            event.stopPropagation();
            // Only the release closes, mirroring Polaris so a keydown that
            // started outside the panel cannot close it on the way up.
            if (event.type === 'keyup') {
                onClose();
            }
        };

        document.addEventListener('keydown', handleKey, true);
        document.addEventListener('keyup', handleKey, true);
        return () => {
            document.removeEventListener('keydown', handleKey, true);
            document.removeEventListener('keyup', handleKey, true);
            // Spliced by identity, not popped: effects tear down in an order React
            // chooses, so the panel leaving is not always the one on top.
            const at = _panelStack.indexOf(panelId);
            if (at !== -1) _panelStack.splice(at, 1);
        };
    }, [mounted, open, onClose, panelId]);

    if (!mounted) return null;

    let rootClassName = 'se-slideover';
    if (entered) {
        rootClassName = 'se-slideover se-slideover--entered';
    }

    let panelStyle;
    if (width) {
        panelStyle = { '--se-slideover-width': width };
    }

    return (
        <Portal idPrefix="slideover">
            {/*
               `data-polaris-layer` is REQUIRED, and its absence fails silently.
              Polaris positions every Popover, Tooltip, Select menu and Autocomplete
              by walking up from the activator to the nearest `[data-polaris-layer]`
              and using ITS computed z-index + 1 (`PositionedOverlay`
              `getZIndexForLayerFromNode`). With no layer ancestor the lookup
              returns null and the overlay falls back to the stylesheet's 400 —
              BELOW this panel and below the backdrop. The panel header alone
              renders three Tooltips, and without this they simply never appear.
              It goes on the ROOT because that is the element with a resolved
              z-index; the panel's own is a local 1, which would put popovers at 2.
            */}
            <div className={rootClassName} data-polaris-layer="true">
                {/* Backdrop, not a plain div: this is where the reference-counted
                    scroll lock comes from. Its click closes the panel.

                    ⚠️ Never `transparent` — the exposed area would then pass clicks
                    through to the backdrop of whatever is underneath, so dismissing
                    this panel over a Modal would close the Modal too. */}
                <Backdrop onClick={onClose} />
                <TrapFocus trapping={open}>
                    <div
                        ref={panelRef}
                        className="se-slideover__panel"
                        style={panelStyle}
                        role="dialog"
                        aria-modal="true"
                        aria-label={accessibilityLabel || (typeof title === 'string' ? title : 'Details')}
                        tabIndex={-1}
                    >
                        <div className="se-slideover__header">
                            <InlineStack align="space-between" blockAlign="start" gap="300" wrap={false}>
                                <BlockStack gap="100">
                                    <InlineStack gap="200" blockAlign="center" wrap>
                                        {/* A plain string is wrapped so callers get the heading
                                            style for free; a node is trusted as-is. */}
                                        {typeof title === 'string' ? (
                                            <Text as="h2" variant="headingMd">{title}</Text>
                                        ) : title}
                                        {titleMetadata}
                                    </InlineStack>
                                    {subtitle ? (
                                        <Text as="span" variant="bodySm" tone="subdued">{subtitle}</Text>
                                    ) : null}
                                </BlockStack>
                                <InlineStack gap="200" blockAlign="center" wrap={false}>
                                    {headerActions}
                                    <Button
                                        icon={XIcon}
                                        variant="tertiary"
                                        onClick={onClose}
                                        accessibilityLabel="Close"
                                    />
                                </InlineStack>
                            </InlineStack>
                        </div>

                        {/* `data-polaris-scrollable` is how Polaris finds the scroll
                            parent — `Listbox` uses it to keep the highlighted option
                            in view, `Scrollable.forNode` to reposition. A Combobox or
                            Autocomplete added to a panel body without it scrolls the
                            wrong element. */}
                        <div ref={bodyRef} className="se-slideover__body" data-polaris-scrollable="true">
                            <_WithinContent>{children}</_WithinContent>
                        </div>

                        {footer ? <div className="se-slideover__footer">{footer}</div> : null}
                    </div>
                </TrapFocus>
            </div>
        </Portal>
    );
};

export default SlideOverPanel;
