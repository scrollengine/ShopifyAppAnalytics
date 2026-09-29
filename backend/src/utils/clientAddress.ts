'use strict';

/**
 * The client address the auth flows record — THE one source for a token row's `request_ip`, a
 * session's `ip`, an audit row's `ip` and the "requested from" line in an email (spec A11).
 *
 * It is `req.ip` and nothing else. What `req.ip` means is decided by `trust proxy` in `apps/app.ts`
 * (from `TRUST_PROXY`), so this never reads `X-Forwarded-For` itself — a second reading of that
 * header here would be a second, disagreeing answer to "who sent this", and the header is written by
 * whoever sends the request.
 *
 * The value is stored and later shown to people, so anything that is not a syntactically valid IP
 * address becomes `null` rather than being recorded as text someone else chose.
 */

import net = require('net');

/**
 * The longest textual IP address: an IPv4-mapped IPv6 address in full form
 * (`ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255`) is 45 characters.
 */
const CLIENT_IP_MAX_LENGTH = 45;

/**
 * Reads the client address Express resolved for a request.
 *
 * ⚠️ An address longer than 45 characters (only possible with an IPv6 zone suffix such as
 * `fe80::1%eth0`, which never arrives from a remote client) is returned as `null` rather than
 * truncated: a cut-off address is a different, wrong address, and a record should say "unknown"
 * before it says something false.
 *
 * @param req - An Express request, or anything carrying an `ip` property.
 * @returns The address when `net.isIP` accepts it and it fits in 45 characters, else `null`.
 */
const clientIp = (req: { ip?: unknown } | null | undefined): string | null => {
    if (req === null || req === undefined) {
        return null;
    }
    const ip = req.ip;
    if (typeof ip !== 'string' || ip.length === 0 || ip.length > CLIENT_IP_MAX_LENGTH) {
        return null;
    }
    return net.isIP(ip) === 0 ? null : ip;
};

export = {
    CLIENT_IP_MAX_LENGTH,
    clientIp
};
