import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';

/**
 * =============================================================================
 *  The emailed token: read from the URL fragment ONCE, then removed from it.
 * =============================================================================
 *
 *  Setup, invitation and reset emails link to `<page>#token=<43 chars>`. The
 *  FRAGMENT, never the query string: a fragment is not sent to the server, not
 *  written to proxy logs and not put in a Referer. This hook takes it out of the
 *  address bar and history as soon as it has been read, and hands it to the page
 *  to hold in React state. Nothing is submitted until the person presses a button,
 *  so a mail scanner that opens the link consumes nothing.
 *
 *  ── ⚠️ WHY IT WAITS FOR router.isReady ──────────────────────────────────────
 *  Every page here is statically optimised and next.config.js has rewrites, so
 *  Next's client bootstrap runs a hydration-time `router.replace(…, asPath)` in
 *  its root `componentDidMount` (next/dist/client/index.js, Next 15.5) — and
 *  that `asPath` was captured at boot WITH the fragment. The replace is async:
 *  if the fragment were stripped in a plain mount effect, that replace could land
 *  afterwards and write `#token=…` straight back into the address bar. `isReady`
 *  flips on the render that follows Next's own `replaceState`, so stripping on
 *  it runs after Next is done. Verified against next/dist/shared/lib/router/router.js
 *  (`change()`: `changeState` before `set`).
 *
 *  ── ⚠️ WHY THE REF ──────────────────────────────────────────────────────────
 *  `reactStrictMode` runs every effect twice in development. The second run
 *  would read the ALREADY-STRIPPED fragment and report the token missing. The
 *  ref makes the read happen once per mount, whatever React does with effects.
 *
 *  ⚠️ A RELOAD LOSES THE TOKEN. That is the point of stripping it; the pages'
 *  "missing link" copy tells the person to open the email link again.
 * =============================================================================
 */

/** Shape of every token this backend mints: 32 random bytes, base64url, no padding. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The fragment parameter the backend's link builder writes. */
const TOKEN_FRAGMENT_KEY = 'token';

/**
 * The outcome of reading the fragment.
 *
 *   reading   — not read yet (server render, first paint, router not ready);
 *   present   — a well-formed token is in `token`;
 *   missing   — the page was opened with no token (or reloaded after it was stripped);
 *   malformed — something was there but cannot be a token (a truncated link, usually).
 */
export const FRAGMENT_TOKEN_STATES = Object.freeze({
    READING: 'reading',
    PRESENT: 'present',
    MISSING: 'missing',
    MALFORMED: 'malformed'
});

/**
 * Parses a location fragment for the token. Pure.
 *
 * A malformed value is reported as such and never returned — it would only be refused by the server
 * with the same answer, and sending it would spend the shared "malformed" rate-limit bucket.
 *
 * @param {*} hash - `window.location.hash`, with or without its leading '#'.
 * @returns {{ state: String, token: String }} One of {@link FRAGMENT_TOKEN_STATES} and the token ('' unless present).
 */
export const parseFragmentToken = (hash) => {
    if (typeof hash !== 'string' || !hash || hash === '#') {
        return { state: FRAGMENT_TOKEN_STATES.MISSING, token: '' };
    }
    let raw = null;
    try {
        raw = new URLSearchParams(hash.charAt(0) === '#' ? hash.slice(1) : hash).get(TOKEN_FRAGMENT_KEY);
    } catch (e) {
        return { state: FRAGMENT_TOKEN_STATES.MALFORMED, token: '' };
    }
    if (raw === null || raw === '') {
        return { state: FRAGMENT_TOKEN_STATES.MISSING, token: '' };
    }
    if (!TOKEN_PATTERN.test(raw)) {
        return { state: FRAGMENT_TOKEN_STATES.MALFORMED, token: '' };
    }
    return { state: FRAGMENT_TOKEN_STATES.PRESENT, token: raw };
};

/**
 * Removes the fragment from the address bar AND from the current history entry.
 *
 * `history.state` is rewritten too, not just the URL: Next keeps its own copy of the URL in the entry's
 * state (`as`), captured with the fragment, and replays it on back/forward. Leaving it would put the
 * token back in the address bar the first time someone pressed Back and then Forward.
 *
 * (Next's in-memory `router.asPath` still holds the fragment until the next navigation. Nothing on a
 * public page reads it, and it never leaves this tab.)
 *
 * @returns {void}
 */
export const stripFragmentFromUrl = () => {
    if (typeof window === 'undefined') {
        return;
    }
    const cleanUrl = window.location.pathname + window.location.search;
    let state = window.history.state;
    if (state && typeof state === 'object' && typeof state.as === 'string') {
        const hashAt = state.as.indexOf('#');
        if (hashAt !== -1) {
            state = { ...state, as: state.as.slice(0, hashAt) };
        }
    }
    try {
        window.history.replaceState(state, '', cleanUrl);
    } catch (e) {
        // A browser that refuses replaceState (sandboxed frame, odd privacy mode). The token stays in
        // the address bar; the page still works, and no-referrer keeps it out of request headers.
    }
};

/**
 * Reads the emailed token from the fragment once the router is ready, strips it from the URL, and
 * returns it for the page to hold in state.
 *
 * @returns {{ state: String, token: String }} See {@link FRAGMENT_TOKEN_STATES}.
 */
export const useFragmentToken = () => {
    const router = useRouter();
    const readRef = useRef(false);
    const [result, setResult] = useState({ state: FRAGMENT_TOKEN_STATES.READING, token: '' });

    useEffect(() => {
        if (!router.isReady || readRef.current) {
            return;
        }
        readRef.current = true;
        const parsed = parseFragmentToken(window.location.hash);
        // Strip whatever was there — a malformed or truncated token is still part of a secret.
        if (window.location.hash) {
            stripFragmentFromUrl();
        }
        setResult(parsed);
    }, [router.isReady]);

    return result;
};

export default useFragmentToken;
