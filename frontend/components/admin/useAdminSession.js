import { useCallback } from 'react';

import { useSession } from '../../contexts/sessionContext';
import { isForbiddenResponse } from '../../utils/permissions';

/** Stand-in for `can` when the session is unavailable: deny. */
const _denyAll = () => false;

/**
 * The slice of the session the admin tabs need, read defensively.
 *
 * FAILS NARROW. If the provider is missing or has not produced `can`, every permission reads as
 * not held, so a gated button is hidden rather than offered. The server re-checks every call
 * regardless; this only decides what the screen offers.
 *
 * `noteForbidden(result)` is what every tab calls on a failed result: when it is the backend's 403
 * envelope it asks the session to re-read the role (debounced to once per 30 s by the provider),
 * because a refusal of something the screen offered usually means the role changed underneath it.
 *
 * @returns {{can: Function, refresh: Function, noteForbidden: Function, currentUserId: String}}
 */
const useAdminSession = () => {
    const session = useSession() || {};
    const sessionRefresh = session.refresh;
    const sessionReportForbidden = session.reportForbidden;

    let can = _denyAll;
    if (typeof session.can === 'function') {
        can = session.can;
    }

    // Stable across renders so both can sit in effect dependency arrays.
    const refresh = useCallback(() => {
        if (typeof sessionRefresh === 'function') {
            sessionRefresh();
        }
    }, [sessionRefresh]);

    const noteForbidden = useCallback((result) => {
        if (!isForbiddenResponse(result)) {
            return false;
        }
        if (typeof sessionReportForbidden === 'function') {
            sessionReportForbidden();
        }
        return true;
    }, [sessionReportForbidden]);

    let currentUserId = '';
    if (session.user && session.user.user_id) {
        currentUserId = String(session.user.user_id);
    }

    return { can: can, refresh: refresh, noteForbidden: noteForbidden, currentUserId: currentUserId };
};

export default useAdminSession;
