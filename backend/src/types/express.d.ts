/**
 * ============================================================================
 *  EXPRESS REQUEST AUGMENTATION
 * ============================================================================
 *
 *  Declarations only. This file adds the fields our own middleware attaches to
 *  `req`, so a handler can read them without a cast.
 *
 *  ── Why both fields are OPTIONAL ────────────────────────────────────────────
 *  `user_id` and `auth` are written by `middlewares/authenticate` and by nothing
 *  else. The public routes — `GET /healthz` and the `/api/auth/*` flows — never
 *  pass through that middleware, so a `Request` genuinely may not carry them,
 *  and typing them as required would be a lie the compiler then helps you
 *  believe.
 *
 *  Optional is also the honest shape for the guard's own contract: the ONLY way
 *  they are populated is a verified session whose principal loaded from the
 *  database on THIS request, so a handler that finds them present knows the
 *  request authenticated, and one that finds them absent knows it did not.
 *  Nothing else in the codebase may assign to them — a second writer would turn
 *  "present" into "someone set this", which is not the same claim.
 *
 *  ⚠️ TypeScript cannot see an assignment made through bracket syntax
 *  (`req['user_id'] = …`), so the guard assigns with dot syntax and this
 *  declaration is what makes that legal.
 * ============================================================================
 */

import type { AuthContext } from '../modules/auth/types/auth.types';

declare global {
    namespace Express {
        interface Request {
            /**
             * The authenticated user's id — the `_id` of their `gi_users` row, as a string. Set by
             * `authenticate` after the session token verified AND the principal loaded, and never
             * by anything else.
             *
             * Absent on unauthenticated routes. A handler behind the guard may rely on it being
             * present, because the guard answers 401/503 rather than calling `next()` when it is not.
             */
            user_id?: string;

            /**
             * Who the caller is and what they may do, re-read from the database on this request
             * (session → user → install → role), plus the session id. FROZEN, so nothing downstream
             * can widen a permission set in place.
             *
             * ⚠️ Route policy only. Admin services re-load the actor themselves by `user_id` and never
             * trust this object; pass `req.user_id`, not `req.auth`, into a service.
             */
            auth?: Readonly<AuthContext>;
        }
    }
}

export {};
