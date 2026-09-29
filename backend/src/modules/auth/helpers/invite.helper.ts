'use strict';

/**
 * An invite's state, computed ONCE from its timestamps. The state is never stored — a stored state
 * would disagree with `expires_at` the moment the clock passed it.
 *
 * ⚠️ The query-side spelling of "pending" is `invite.repository`'s live filter
 * (`accepted_at: null, revoked_at: null, expires_at: { $gt: now }`). The two must agree; this is the
 * read-side definition every view and count uses, and that filter is the write-side precondition.
 *
 * PURE: `now` is passed in.
 */

import type { InviteState, InviteStateInput } from '../types/auth.types';

/**
 * Computes an invite's state. Accepted wins over revoked (it happened, and a user exists), revoked
 * over expired. An unreadable `expires_at` or `now` counts as EXPIRED: `NaN > x` is false, which
 * here fails narrow — an invite whose expiry cannot be read is not offered as live.
 *
 * @param params0 - The parameters object.
 * @param params0.invite - The invite's `accepted_at`, `revoked_at` and `expires_at`.
 * @param params0.now - The instant to evaluate at.
 * @returns `'accepted' | 'revoked' | 'expired' | 'pending'`.
 */
const inviteState = ({ invite, now }: InviteStateInput): InviteState => {
    if (invite.accepted_at) {
        return 'accepted';
    }
    if (invite.revoked_at) {
        return 'revoked';
    }
    const expiresAt = invite.expires_at instanceof Date ? invite.expires_at.getTime() : NaN;
    const at = now instanceof Date ? now.getTime() : NaN;
    if (!(expiresAt > at)) {
        return 'expired';
    }
    return 'pending';
};

export = {
    inviteState
};
