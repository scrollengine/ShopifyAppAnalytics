'use strict';

/**
 * ============================================================================
 *  MAIL — module barrel
 * ============================================================================
 *
 *  Send one of four templated messages, check the server at boot, and report
 *  how mail is doing. That is the whole surface.
 *
 *  Barrel rules — deep-path imports inside the folder, every key enumerated,
 *  `export =` never `export default` — are stated once in IMPLEMENTATION.md
 *  §3.13 and asserted by test/exportSurface.test.js.
 *
 *  Dependencies point one way: this module imports config, core/logger and
 *  utils, and NEVER `modules/auth`. Auth calls mail; mail knows nothing about
 *  users, tokens or roles, which is what keeps the pair out of an import cycle.
 *
 *  Not exported, deliberately:
 *    - `clients/smtp.client` — a caller holding the raw transport could send
 *      anything to anyone, past the caps, the fixed subjects and the escaping;
 *    - the helpers — pure, imported by deep path from tests;
 *    - `resetMailState` — test-only, imported by deep path.
 * ============================================================================
 */

import mailService = require('./services/mail.service');
import mailConstants = require('./constants/mail.constants');

export = {
    /**
     * Sends one templated message. Never throws; `data` is `{ accepted, status, message_id? }` on
     * every branch, and `status: true` means the mail server ACCEPTED it — never "delivered".
     */
    sendTemplatedEmail: mailService.sendTemplatedEmail,
    /** Boot-time connect + login check, bounded, non-fatal. Records the result for `getMailStatus`. */
    verifyMailAtBoot: mailService.verifyMailAtBoot,
    /** `{ configured, last_check, last_ok_at, consecutive_failures }`. Synchronous. Never names the server. For signed-in admins. */
    getMailStatus: mailService.getMailStatus,
    /** The last connect-and-login check only ('ok' | 'failed' | 'not_checked') — what an ANONYMOUS caller may be told. */
    getPublicMailCheck: mailService.getPublicMailCheck,
    /** Re-checks the server (coalesced, never rejects) and records the result, public check included. */
    recheckTransport: mailService.recheckTransport,

    /** SETUP_VERIFY | INVITE | PASSWORD_RESET | PASSWORD_CHANGED. */
    EMAIL_TEMPLATES: mailConstants.EMAIL_TEMPLATES,
    /** ANONYMOUS | ADMIN | SECURITY — decides the cap share a send may use. */
    MAIL_TRIGGERS: mailConstants.MAIL_TRIGGERS,
    /** SENT | FAILED | CAP_REACHED | UNCONFIRMED | NOT_CONFIGURED. */
    MAIL_SEND_STATUSES: mailConstants.MAIL_SEND_STATUSES,
    /** 'ok' | 'failed' | 'not_checked' — the values of `getMailStatus().last_check`. */
    MAIL_CHECK_STATES: mailConstants.MAIL_CHECK_STATES,
    /** The `deadline_ms` an admin-facing send passes. */
    ADMIN_SEND_DEADLINE_MS: mailConstants.ADMIN_SEND_DEADLINE_MS
};
