'use strict';

/**
 * The request context an auth service records: the client address and the User-Agent.
 *
 * The controller supplies them (`clientIp(req)` from `utils/clientAddress`, and
 * `req.headers['user-agent']`); this is where a service reads them back out of `params`, so every
 * service applies the same shape rules to values that end up in `gi_auth_sessions`,
 * `gi_audit_events`, `gi_auth_tokens.request_ip` and the "requested from" line of an email.
 *
 * `request_ip` is the canonical key; `ip` (the name in `auth.types#RequestContext`) is read when
 * `request_ip` is absent, so a caller written against either spelling records the same thing.
 *
 * PURE: `net.isIP` is a syntax check, not I/O.
 */

import net = require('net');
import authConstants = require('../constants/auth.constants');

const { USER_AGENT_MAX_LENGTH } = authConstants;

/** The longest textual IP address (IPv4-mapped IPv6, full form). Same bound as `clientAddress`. */
const IP_MAX_LENGTH = 45;

/**
 * Keeps an address only when it is a syntactically valid IP of plausible length. Anything else is
 * `null`: a stored "address" someone else chose is worse than "unknown".
 *
 * @param value - The candidate.
 * @returns The address, or `null`.
 */
const _validIp = (value: unknown): string | null => {
    if (typeof value !== 'string' || value.length === 0 || value.length > IP_MAX_LENGTH) {
        return null;
    }
    return net.isIP(value) === 0 ? null : value;
};

/**
 * Reads `{ ip, user_agent }` out of a service's params.
 *
 * @param params - The service params (anything; not trusted to be an object).
 * @returns `ip` (valid IP or `null`) and `user_agent` (at most 200 code points, or `null`).
 */
const requestContextOf = (params: unknown): { ip: string | null; user_agent: string | null } => {
    if (params === null || typeof params !== 'object') {
        return { ip: null, user_agent: null };
    }
    const requestIp: unknown = Reflect.get(params, 'request_ip');
    const legacyIp: unknown = Reflect.get(params, 'ip');
    const ip = _validIp(requestIp !== undefined && requestIp !== null ? requestIp : legacyIp);

    const rawAgent: unknown = Reflect.get(params, 'user_agent');
    let userAgent: string | null = null;
    if (typeof rawAgent === 'string' && rawAgent.length > 0) {
        userAgent = Array.from(rawAgent).slice(0, USER_AGENT_MAX_LENGTH).join('');
    }
    return { ip: ip, user_agent: userAgent };
};

export = {
    requestContextOf
};
