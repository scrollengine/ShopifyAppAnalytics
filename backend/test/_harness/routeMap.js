'use strict';

/**
 * ============================================================================
 *  ROUTE MAP — every endpoint the router tree publishes, with its guard chain
 * ============================================================================
 *
 *  Produces, for the whole mounted tree, one record per (method, full path):
 *  the complete ordered list of middleware a request to that path must pass
 *  through first. That list is what `routeGuard.test.js` checks for
 *  `verifyAdmin`.
 *
 *  ──  Why this instruments Express instead of reading its stack ────────────
 *  Express 5 does NOT keep the mount path. `Layer` sets `this.path = undefined`
 *  and compiles the path straight into `matchers`, an array of closures over a
 *  path-to-regexp matcher. There is no property anywhere on a router, a layer
 *  or a route that says "this sub-router is mounted at /api". Walking
 *  `router.stack` after the fact therefore yields the SHAPE of the tree and the
 *  route paths relative to their own router — but not the absolute paths, and
 *  an absolute path is exactly what an allowlist has to be written against.
 *
 *  (Express 4 exposed a `layer.regexp` that could be reverse-engineered back
 *  into a prefix. Tests that did that broke on the 5.0 upgrade. Recording the
 *  path at registration time is version-independent: it reads the argument the
 *  application itself passed.)
 *
 *  So `Router.prototype.use` and `Router.prototype.route` are wrapped for the
 *  duration of ONE require, recording `(router, path, handler)` as the tree is
 *  built, and restored in a `finally`. Every verb method — `router.get`,
 *  `.post`, and the rest — is defined in terms of `this.route(path)` in the
 *  `router` package, so wrapping those two functions captures every
 *  registration without touching the eleven method names individually.
 *
 *  ── Registration ORDER is part of the answer ────────────────────────────────
 *  Express runs a router's layers in the order they were registered. A
 *  middleware protects what was registered AFTER it and nothing that was
 *  registered before. So a guard is credited to a route only when it appears
 *  EARLIER in the same router (or in an ancestor), which is what makes this
 *  harness able to catch the specific regression of moving `verifyAdmin` below
 *  a mount that used to sit under it — a change that looks like a reordering
 *  and is actually an authentication bypass.
 * ============================================================================
 */

/**
 * Joins a mount prefix to a sub-path, collapsing duplicate and trailing slashes.
 *
 * @param {String} prefix - The accumulated absolute prefix, e.g. '/api'.
 * @param {String} segment - The path this layer was registered at, e.g. '/sync'.
 * @returns {String} The absolute path, always leading-slashed and never trailing-slashed.
 */
const _joinPath = (prefix, segment) => {
    const left = String(prefix || '');
    const right = String(segment || '');
    const combined = `${left}/${right}`.replace(/\/{2,}/g, '/');
    if (combined.length > 1 && combined.endsWith('/')) {
        return combined.slice(0, -1);
    }
    if (!combined.startsWith('/')) {
        return `/${combined}`;
    }
    return combined;
};

/**
 * True when a middleware mounted at `mount` runs for a request to `fullPath`.
 *
 * Prefix semantics, matching Express's own `end: false` mount matching: `/api` guards `/api`,
 * `/api/sync` and everything below, but NOT `/apiary` — hence the explicit boundary check rather
 * than a bare `startsWith`. A mount at `/` guards everything.
 *
 * @param {String} mount - Absolute path the middleware was mounted at.
 * @param {String} fullPath - Absolute path of the route being checked.
 * @returns {Boolean} True when the middleware is in that route's chain.
 */
const _guardApplies = (mount, fullPath) => {
    if (mount === '/' || mount === '') {
        return true;
    }
    if (fullPath === mount) {
        return true;
    }
    return fullPath.startsWith(`${mount}/`);
};

/**
 * True when a handler is a router rather than a plain middleware function.
 *
 * A router is a function (Express routers are callable) that also carries a layer `stack`. Checking
 * the shape rather than an `instanceof` keeps this working across the several ways a router can be
 * produced — `express.Router()`, `new Router()`, or the `router` package used directly.
 *
 * @param {*} handler - Anything passed to `.use()`.
 * @returns {Boolean} True when it is a mountable router.
 */
const _isRouter = (handler) => {
    return typeof handler === 'function' && Array.isArray(handler.stack);
};

/**
 * Builds the route map for a router tree.
 *
 * Wraps `Router.prototype.use` / `.route`, runs `load()` (which must require and return the ROOT
 * router), then restores the prototype and walks what was recorded.
 *
 * ⚠️ `load()` must perform the `require` itself. A module already in `require.cache` registers
 * nothing on a second require, so requiring the routes before calling this would produce an empty
 * map — a silently PASSING guard test over zero routes. `buildRouteMap` therefore throws when the
 * load records no routes at all, so that failure mode cannot be mistaken for success.
 *
 * @param {Object} params0 - The parameters object.
 * @param {*} params0.expressModule - The `express` module, whose `Router` prototype is wrapped.
 * @param {Function} params0.load - Returns the root router. Must require it inside this call.
 * @returns {{ routes: Array, root: Function, unanalysable: Array }} `routes` holds one record per
 * (method, path): `{ method, path, guards, route_middleware, handler }`. `unanalysable` names any
 * layer registered with a RegExp or array path, which cannot be resolved to an absolute string.
 */
const buildRouteMap = ({ expressModule, load }) => {
    const Router = expressModule.Router;
    const originalUse = Router.prototype.use;
    const originalRoute = Router.prototype.route;

    /** router function -> ordered registration entries. A Map, so router identity is the key. */
    const registry = new Map();
    const unanalysable = [];

    const _record = (routerInstance, entry) => {
        const existing = registry.get(routerInstance) || [];
        existing.push(entry);
        registry.set(routerInstance, existing);
    };

    let root = null;
    try {
        Router.prototype.use = function patchedUse(...args) {
            // Mirrors the `router` package's own argument disambiguation: the first argument is a
            // path only when it is not a function (and not an array that bottoms out in one).
            let mountPath = '/';
            let handlers = args;
            let first = args[0];
            while (Array.isArray(first) && first.length !== 0) {
                first = first[0];
            }
            if (args.length > 0 && typeof first !== 'function') {
                mountPath = args[0];
                handlers = args.slice(1);
            }
            for (const handler of handlers.flat(Infinity)) {
                if (typeof handler === 'function') {
                    _record(this, { path: mountPath, handle: handler });
                }
            }
            return originalUse.apply(this, args);
        };

        Router.prototype.route = function patchedRoute(path) {
            const created = originalRoute.call(this, path);
            _record(this, { path: path, route: created });
            return created;
        };

        root = load();
    } finally {
        // Restored even if `load()` throws, so one bad require cannot leave a patched Express
        // behind for every test that runs after it in this process.
        Router.prototype.use = originalUse;
        Router.prototype.route = originalRoute;
    }

    if (typeof root !== 'function') {
        throw new Error('load() did not return a router. It must require and return the root router.');
    }

    const routes = [];

    /**
     * Depth-first walk in registration order, carrying the guard chain down.
     *
     * @param {Function} routerInstance - The router to descend into.
     * @param {String} prefix - Absolute prefix this router is mounted at.
     * @param {Array} inheritedGuards - `{ name, mount }` guards from every ancestor.
     * @param {Set} seen - Cycle guard: a router mounted twice must not recurse forever.
     * @returns {void}
     */
    const _walk = (routerInstance, prefix, inheritedGuards, seen) => {
        if (seen.has(routerInstance)) {
            return;
        }
        seen.add(routerInstance);

        // Guards accumulate as the walk moves DOWN this router's entries, which is what encodes
        // "a middleware only protects what was registered after it".
        const activeGuards = inheritedGuards.slice();

        for (const entry of registry.get(routerInstance) || []) {
            if (typeof entry.path !== 'string') {
                unanalysable.push({ prefix: prefix, path: String(entry.path) });
                continue;
            }
            const fullPath = _joinPath(prefix, entry.path);

            if (entry.route) {
                const applicable = activeGuards
                    .filter((guard) => _guardApplies(guard.mount, fullPath))
                    .map((guard) => guard.name);
                // Middleware attached to the route itself (`router.get(path, mw, handler)`). The
                // LAST entry is the handler; anything before it guards this one route only.
                const routeLayerNames = entry.route.stack.map((layer) => layer.name);
                const handlerName = routeLayerNames[routeLayerNames.length - 1] || '<anonymous>';
                const routeMiddleware = routeLayerNames.slice(0, -1);

                for (const method of Object.keys(entry.route.methods || {})) {
                    routes.push({
                        method: method.toUpperCase(),
                        path: fullPath,
                        guards: applicable,
                        route_middleware: routeMiddleware,
                        handler: handlerName
                    });
                }
                continue;
            }

            if (_isRouter(entry.handle)) {
                const inherited = activeGuards.filter((guard) => _guardApplies(guard.mount, fullPath) || fullPath.startsWith(guard.mount));
                _walk(entry.handle, fullPath, inherited, seen);
                continue;
            }

            activeGuards.push({ name: entry.handle.name || '<anonymous>', mount: fullPath });
        }

        seen.delete(routerInstance);
    };

    _walk(root, '', [], new Set());

    if (routes.length === 0) {
        throw new Error(
            'The route map is EMPTY. Nothing was recorded, which means load() returned a router that '
            + 'was already in require.cache — so this run proves nothing. load() must perform the require itself.'
        );
    }

    return { routes, root, unanalysable };
};

/**
 * Formats one route record for an assertion message.
 *
 * @param {Object} route - A record from `buildRouteMap().routes`.
 * @returns {String} e.g. `GET /api/revenue/now  [guards: verifyAdmin]`.
 */
const describeRoute = (route) => {
    const chain = route.guards.concat(route.route_middleware);
    let guardText = '(NONE)';
    if (chain.length > 0) {
        guardText = chain.join(' -> ');
    }
    return `${route.method} ${route.path}  [guards: ${guardText}]  -> ${route.handler}`;
};

/**
 * Substitutes a placeholder for every `:param` so a route can actually be requested.
 *
 * @param {String} routePath - A path possibly containing `:name` segments.
 * @returns {String} A concrete, requestable path.
 */
const toConcretePath = (routePath) => routePath.replace(/:[^/]+/g, 'probe-value');

module.exports = {
    buildRouteMap,
    describeRoute,
    toConcretePath,
    _joinPath,
    _guardApplies
};
