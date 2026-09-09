/**
 * ============================================================================
 *  EXPRESS REQUEST AUGMENTATION
 * ============================================================================
 *
 *  Declarations only. This file adds the fields our own middleware attaches to
 *  `req`, so a handler can read them without a cast.
 *
 *  ── Why the field is OPTIONAL ───────────────────────────────────────────────
 *  `user_id` is written by `middlewares/verifyAdmin` and by nothing else. Two
 *  route classes never pass through that middleware — `POST /api/auth/login`
 *  and `GET /healthz` — so a `Request` genuinely may not carry it, and typing it
 *  as `user_id: string` would be a lie the compiler then helps you believe.
 *
 *  Optional is also the honest shape for the guard's own contract: the ONLY way
 *  `req.user_id` is populated is a verified token, so a handler that finds it
 *  present knows the request authenticated, and one that finds it absent knows
 *  it did not. Nothing else in the codebase may assign to it — a second writer
 *  would turn "present" into "someone set this", which is not the same claim.
 *
 *  ⚠️ TypeScript cannot see an assignment made through bracket syntax
 *  (`req['user_id'] = …`), so the guard assigns it with dot syntax and this
 *  declaration is what makes that legal.
 * ============================================================================
 */

declare global {
    namespace Express {
        interface Request {
            /**
             * The authenticated operator's id — the `_id` of their `gi_admin_users` row, as a
             * string. Set by `verifyAdmin` after a token verifies, and never by anything else.
             *
             * Absent on unauthenticated routes. A handler behind the guard may rely on it being
             * present, because the guard returns 401 rather than calling `next()` when it is not.
             */
            user_id?: string;
        }
    }
}

export {};
