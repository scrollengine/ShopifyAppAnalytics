'use strict';

/**
 * ============================================================================
 *  ADMIN AUTHENTICATION
 * ============================================================================
 *
 *  Three operations, and deliberately no more: seed the single operator account
 *  at first boot, exchange a password for a session token, and verify a token.
 *
 *  There is no sign-up, no password reset, no invite flow and no second role.
 *  This backend holds one company's revenue history and is run by the company
 *  that owns it, so the absence of those features is the security model rather
 *  than a gap in it — every one of them is an unauthenticated endpoint, and this
 *  API has exactly two (`POST /api/auth/login` and `GET /healthz`).
 *
 *  ── Password handling, in one place ─────────────────────────────────────────
 *  This module is the ONLY writer of `password_hash` and the only caller of
 *  bcrypt. The schema deliberately carries no hashing hook — see the header of
 *  `src/models/auth/adminUser.model.ts` for why a `pre('save')` hook is a trap
 *  under Mongoose 9 — so hashing is an explicit statement here, at the two
 *  places it happens, rather than an invisible side effect of saving.
 *
 *  ── Two deliberate choices, both noted where they occur ─────────────────────
 *
 *   1. TOKENS EXPIRE. Signing without an expiry is easy to do by accident and the
 *      consequence is permanent: a token with no expiry never stops being valid,
 *      so a leaked one is a permanent credential and the only revocation lever is
 *      rotating the signing secret for everybody at once. Here `expiresIn` is
 *      always set, from `config.AUTH.TOKEN_TTL_HOURS`.
 *
 *   2. FAILURES ARE 401s, not 200s. See `middlewares/verifyAdmin`.
 * ============================================================================
 */

import bcrypt = require('bcryptjs');
import jwt = require('jsonwebtoken');
import config = require('../../../config');
import logger = require('../../../core/logger');
import promiseHelper = require('../../../utils/promiseHelper');
import authConstants = require('../constants/adminAuth.constants');
import adminUserRepository = require('../repositories/adminUser.repository');
import type { IdentityObject, ServiceResult } from '../../../types/service.types';
import type { AdminLoginResult, AdminSeedResult, VerifiedAdminToken, AdminPasswordSource } from '../types/adminAuth.types';

const { customConsoleLog, customConsoleError, customConsoleWarn, customConsoleDebug } = logger;
const { promiseReturnResult } = promiseHelper;
const { AUTH_MESSAGES, ADMIN_SEED_OUTCOMES, ADMIN_PASSWORD_SOURCES } = authConstants;

/*
 * ⚠️ The TypeScript return type below is the unparameterised `ServiceResult`, while each JSDoc
 * `@returns` names the payload interface it carries on success. That is deliberate, not laziness:
 * a failure envelope carries `data: {}`, which is not assignable to `AdminLoginResult` — so
 * `Promise<ServiceResult<AdminLoginResult>>` would force a `{} as AdminLoginResult` cast at every
 * failure branch, and this codebase reserves `as` for `shared/repositories/models.repository` and
 * `as const`. The shape is still enforced where it matters: each success payload is built as a
 * typed local (`const loginResult: AdminLoginResult = {…}`), so a missing or misnamed field is a
 * compile error at the place it would actually be wrong.
 */

/**
 * The signing algorithm, pinned on BOTH sign and verify.
 *
 *  Pinning on verify is the load-bearing half. Left unpinned, `jwt.verify` will honour whatever
 * `alg` the TOKEN ITSELF declares — which is an attacker-supplied field. That is the algorithm
 * confusion family of attacks (`alg: none`, or an RS256 public key replayed as an HMAC key), and it
 * turns "verify this signature" into "ask the forger which signature scheme to check". One array
 * literal closes it.
 */
const TOKEN_ALGORITHM = 'HS256';

/** bcryptjs refuses a cost outside this range, so a mistyped config value must be clamped, not passed through. */
const MIN_BCRYPT_ROUNDS = 4;
const MAX_BCRYPT_ROUNDS = 31;

/**
 * The salt-and-digest half of a bcrypt hash of a value nobody knows. The `$2b$<cost>$` prefix is
 * attached by `_absentAccountDummyHash` below, which is where the interesting part is.
 *
 * A literal rather than something generated at module load, so it costs nothing at boot. It does not
 * need to be the hash of any particular password: the only thing ever done with it is a comparison
 * that must fail.
 */
const ABSENT_ACCOUNT_DUMMY_DIGEST = 'Qw8kZ3rTn1vLpXy2Bd7cGeuJ4mHs6RfKtNbVdWxCyZaPqLoEiUgTr';

/**
 * Builds the hash that a login for a NON-EXISTENT account is compared against.
 *
 *  This is a timing defence, and it is the other half of returning one message for both failure
 * modes. Skip the comparison entirely and an unknown email returns the moment the query comes back,
 * while a known one pays for a full bcrypt comparison (~250ms at cost 12) — a difference trivially
 * measurable over HTTP, so the identical message would still leak precisely what it exists to hide.
 *
 *  THE COST FACTOR IS SPLICED IN, NOT HARDCODED, and that is the whole point of this function.
 * bcrypt reads its cost from the hash STRING, so a dummy pinned at `$2b$12$` while the stored hash
 * was written at `AUTH_BCRYPT_ROUNDS=10` makes the unknown-email path do FOUR TIMES the work of the
 * wrong-password path — measured at 205ms against 52ms. That is the same oracle again, merely
 * pointing the other way, and it is arguably easier to read off a graph than the original. Matching
 * the cost makes the two paths genuinely equal.
 *
 * ⚠️ Residual, and accepted: the cost matched here is the one CURRENTLY configured, while a stored
 * hash carries the cost it was written with. An operator who changes `AUTH_BCRYPT_ROUNDS` after the
 * account was seeded reopens a smaller version of the same gap, and closing it would need a database
 * read to discover the stored cost — which is the very work the absent-account path is trying not to
 * betray. Re-seeding at the new cost is the fix.
 *
 * @param rounds - The cost factor to match, already clamped to bcrypt's accepted range.
 * @returns A well-formed bcrypt hash string at that cost, which nothing will ever match.
 */
const _absentAccountDummyHash = (rounds: number): string => {
    return `$2b$${String(rounds).padStart(2, '0')}$${ABSENT_ACCOUNT_DUMMY_DIGEST}`;
};

/**
 * Resolves the bcrypt cost factor, clamped into the range bcryptjs accepts.
 *
 * An out-of-range value is a typo (`AUTH_BCRYPT_ROUNDS=120`), and left alone it makes bcrypt throw
 * — turning a mistyped number into "the operator account could not be created", which reads as a
 * database problem. Clamping keeps the boot working; the warning names the variable so the typo is
 * still visible rather than absorbed.
 *
 * @returns A cost factor between 4 and 31.
 */
const _resolveBcryptRounds = (): number => {
    const configured = config.AUTH.BCRYPT_ROUNDS;
    if (configured < MIN_BCRYPT_ROUNDS) {
        customConsoleWarn('WARN: auth: AUTH_BCRYPT_ROUNDS is below the minimum — using the minimum instead', {
            configured: configured,
            using: MIN_BCRYPT_ROUNDS
        });
        return MIN_BCRYPT_ROUNDS;
    }
    if (configured > MAX_BCRYPT_ROUNDS) {
        customConsoleWarn('WARN: auth: AUTH_BCRYPT_ROUNDS is above the maximum — using the maximum instead', {
            configured: configured,
            using: MAX_BCRYPT_ROUNDS
        });
        return MAX_BCRYPT_ROUNDS;
    }
    return configured;
};

/**
 * The clamped bcrypt cost, resolved ONCE at module load.
 *
 * Config is frozen and read once, so this cannot change while the process runs — and resolving it
 * per call would re-emit the misconfiguration warning on every single login attempt, which turns one
 * useful line into a log flood exactly when someone is hammering the endpoint.
 */
const BCRYPT_ROUNDS = _resolveBcryptRounds();

/**
 * Session-token lifetime in seconds.
 *
 * Returns 0 for a non-positive configured TTL rather than substituting a default. A zero or negative
 * `AUTH_TOKEN_TTL_HOURS` produces a token that is already expired when it is handed over, and the
 * symptom — "I sign in and I am immediately signed out" — points at everything except the one line
 * of configuration that caused it. The caller refuses to sign and says so by name instead.
 *
 * @returns Seconds a token is valid for, or 0 when the configured TTL is unusable.
 */
const _resolveTokenTtlSeconds = (): number => {
    const hours = config.AUTH.TOKEN_TTL_HOURS;
    if (!Number.isFinite(hours) || hours <= 0) {
        return 0;
    }
    return Math.floor(hours * 60 * 60);
};

/**
 * Signs a session token for an operator.
 *
 * @param params0 - The parameters object.
 * @param params0.user_id - The operator id to put in the token.
 * @param params0.ttl_seconds - Lifetime in seconds. Must be positive; the caller checks.
 * @returns The signed JWT.
 */
const _signAdminToken = ({ user_id, ttl_seconds }: { user_id: string; ttl_seconds: number }): string => {
    return jwt.sign(
        { user_id: user_id },
        config.AUTH.JWT_SECRET,
        {
            algorithm: TOKEN_ALGORITHM,
            expiresIn: ttl_seconds,
            // `sub` is the standard place for a subject id. Set alongside the explicit `user_id`
            // claim so a token stays readable by a generic JWT tool as well as by this codebase.
            subject: user_id
        }
    );
};

/**
 * Creates the single operator account when it does not already exist.
 *
 * Called once by the boot sequence, before the HTTP server starts accepting requests. Idempotent:
 * running it against a database that already has the account is a no-op that reports
 * `ALREADY_PRESENT`, so it is safe on every restart.
 *
 * ── Where the password comes from ───────────────────────────────────────────────────────────────
 * Two sources, in this precedence:
 *
 *   1. `ADMIN_PASSWORD_HASH` — already a bcrypt hash. Stored VERBATIM. It is emphatically not
 *      re-hashed: hashing a hash produces a value that looks perfectly valid and matches nothing an
 *      operator can type, which is a lockout that survives every restart and explains itself nowhere.
 *   2. `ADMIN_PASSWORD` — plaintext, hashed HERE before it is stored, at `AUTH_BCRYPT_ROUNDS`.
 *
 * The hash is preferred because a plaintext password in the environment is visible in `ps`, in shell
 * history, in a PM2 dump and in `docker inspect`. The plaintext path exists because "put your
 * password in .env" is what a self-hoster expects to do, and a setup step involving a bcrypt
 * one-liner is where people give up. Either works; only one of them ends up in `ps`.
 *
 *  THIS FUNCTION NEVER UPDATES AN EXISTING ACCOUNT. Changing `ADMIN_PASSWORD` in `.env` after the
 * first boot has NO effect — the account already exists, so the seeder leaves it entirely alone. It
 * is named `seedAdminIfMissing`, not `syncAdmin`, for exactly that reason: a seeder that quietly
 * rewrote the stored hash on every boot would mean anyone who could edit `.env` could take over an
 * account, and an operator who had changed their password in the app would find it silently reverted
 * at the next restart. To change the password today, delete the row and restart.
 *
 * NEVER logs the password, hashed or otherwise — only which environment variable supplied it.
 *
 * @returns Resolves `status: true` for both CREATED and
 * ALREADY_PRESENT (both are a healthy boot), and `status: false` only when no account exists and
 * none could be made — which the caller should treat as fatal, since nobody can then log in.
 */
const seedAdminIfMissing = (): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const email = adminUserRepository.normaliseEmail(config.AUTH.ADMIN_EMAIL);
            if (!email) {
                customConsoleError('ERROR: auth adminAuth seedAdminIfMissing — ADMIN_EMAIL is not set');
                return resolve(promiseReturnResult(false, {}, {}, AUTH_MESSAGES.SEED_NO_EMAIL));
            }

            const existing = await adminUserRepository.findAdminByEmail({ email: email });
            if (existing) {
                customConsoleLog('INFO: auth: operator account already present — nothing seeded', { email: email });
                const presentResult: AdminSeedResult = {
                    outcome: ADMIN_SEED_OUTCOMES.ALREADY_PRESENT,
                    user_id: String(existing._id),
                    email: email,
                    password_source: null
                };
                return resolve(promiseReturnResult(true, presentResult, {}, AUTH_MESSAGES.SEED_ALREADY_PRESENT));
            }

            // ── Resolve the hash to store. Precedence documented above. ──────────────────────────
            let passwordHash = config.AUTH.ADMIN_PASSWORD_HASH;
            let passwordSource: AdminPasswordSource = ADMIN_PASSWORD_SOURCES.PRE_HASHED;
            if (!passwordHash) {
                const plaintextPassword = config.AUTH.ADMIN_PASSWORD;
                if (!plaintextPassword) {
                    customConsoleError('ERROR: auth adminAuth seedAdminIfMissing — neither ADMIN_PASSWORD nor ADMIN_PASSWORD_HASH is set');
                    return resolve(promiseReturnResult(false, {}, {}, AUTH_MESSAGES.SEED_NO_PASSWORD));
                }
                passwordHash = await bcrypt.hash(plaintextPassword, BCRYPT_ROUNDS);
                passwordSource = ADMIN_PASSWORD_SOURCES.HASHED_AT_SEED;
            }

            const created = await adminUserRepository.createAdminUser({ email: email, password_hash: passwordHash });

            // The password itself appears in NEITHER of these lines — only the NAME of the variable
            // it came from. That distinction is the whole discipline: `password_source` is
            // 'ADMIN_PASSWORD', a string that is the same on every install in the world.
            customConsoleLog('INFO: auth: SEEDED the operator account — sign in with this email', {
                email: email,
                user_id: String(created._id),
                password_source: passwordSource
            });

            // A second account appearing means ADMIN_EMAIL was changed after the first boot. The old
            // account still works with its old password, which is a live credential the operator
            // very likely thinks they replaced.
            const totalAdmins = await adminUserRepository.countAdminUsers();
            if (totalAdmins > 1) {
                customConsoleWarn('WARN: auth: this deployment now has more than one operator account', {
                    total_accounts: totalAdmins,
                    seeded_email: email,
                    note: 'ADMIN_EMAIL appears to have changed. The previous account still works with its own password — delete it if that was not intended.'
                });
            }

            const createdResult: AdminSeedResult = {
                outcome: ADMIN_SEED_OUTCOMES.CREATED,
                user_id: String(created._id),
                email: email,
                password_source: passwordSource
            };
            return resolve(promiseReturnResult(true, createdResult, {}, AUTH_MESSAGES.SEED_CREATED));
        } catch (error: any) {
            // Two processes booting at once both find no account and both insert. The unique index
            // on `email` lets exactly one through and rejects the other with E11000 — which is the
            // index doing its job, not a failure: the account the loser was trying to create now
            // exists. Reporting it as an error would make a healthy multi-process boot look broken.
            if (error && error.code === 11000) {
                customConsoleLog('INFO: auth: operator account was created concurrently by another process — nothing seeded here');
                const racedResult: AdminSeedResult = {
                    outcome: ADMIN_SEED_OUTCOMES.ALREADY_PRESENT,
                    user_id: '',
                    email: adminUserRepository.normaliseEmail(config.AUTH.ADMIN_EMAIL),
                    password_source: null
                };
                return resolve(promiseReturnResult(true, racedResult, {}, AUTH_MESSAGES.SEED_ALREADY_PRESENT));
            }
            customConsoleError('ERROR: auth adminAuth seedAdminIfMissing', error);
            return resolve(promiseReturnResult(false, {}, error, AUTH_MESSAGES.SEED_FAILED));
        }
    });
};

/**
 * Exchanges an email and password for a session token.
 *
 *  UNKNOWN EMAIL AND WRONG PASSWORD ARE INDISTINGUISHABLE, on purpose, in both directions that can
 * be observed:
 *
 *   - the MESSAGE is the same constant for both (`AUTH_MESSAGES.INVALID_CREDENTIALS`), and
 *   - the TIME is the same for both, because an email that matched nothing is still compared against
 *     a dummy hash so that the bcrypt cost is paid either way.
 *
 * Telling the two apart turns the login form into an oracle for "is this person's email an operator
 * of this deployment", which is a question worth answering for exactly nobody. Resist every future
 * request to make this message more helpful.
 *
 * @param params0 - The identity object. EMPTY here: there is no authenticated operator yet — establishing one is what this call does. The parameter is kept for signature symmetry with every other service.
 * @param params1 - The parameters object.
 * @param params1.email - The submitted email. Normalised before lookup.
 * @param params1.password - The submitted password, in plaintext. Never logged, never stored, never returned.
 * @returns Resolves with the token on success, or `status: false` with a deliberately non-specific message.
 */
const login = (
    _identity: Partial<IdentityObject>,
    { email, password }: { email?: string; password?: string }
): Promise<ServiceResult> => {
    return new Promise(async (resolve) => {
        try {
            const normalisedEmail = adminUserRepository.normaliseEmail(email);
            if (!normalisedEmail || !password) {
                // Not an oracle: this says the REQUEST was incomplete, which is knowable from the
                // request alone and reveals nothing about which accounts exist.
                return resolve(promiseReturnResult(false, {}, {}, AUTH_MESSAGES.CREDENTIALS_REQUIRED));
            }

            const ttlSeconds = _resolveTokenTtlSeconds();
            if (!ttlSeconds) {
                // Checked BEFORE the credential comparison so a broken TTL cannot be probed as a
                // credential response — every login fails identically either way, and this one names
                // the cause in the log rather than leaving "signed in, then immediately signed out".
                customConsoleError('ERROR: auth adminAuth login — AUTH_TOKEN_TTL_HOURS must be at least 1; refusing to issue an already-expired token', {
                    configured_hours: config.AUTH.TOKEN_TTL_HOURS
                });
                return resolve(promiseReturnResult(false, {}, {}, AUTH_MESSAGES.LOGIN_FAILED));
            }

            const adminUser = await adminUserRepository.findAdminByEmailWithHash({ email: normalisedEmail });

            // The dummy hash keeps the two failure paths the same length, at the SAME cost factor.
            // See `_absentAccountDummyHash`.
            let storedHash = _absentAccountDummyHash(BCRYPT_ROUNDS);
            if (adminUser && adminUser.password_hash) {
                storedHash = adminUser.password_hash;
            }
            const passwordMatches = await bcrypt.compare(password, storedHash);

            if (!adminUser || !passwordMatches) {
                // ONE branch for both causes, so there is no second `resolve` whose message could
                // drift away from this one. The log is allowed to be specific — it is read by the
                // operator, not by whoever is guessing.
                customConsoleWarn('WARN: auth: failed login attempt', {
                    email: normalisedEmail,
                    account_exists: Boolean(adminUser)
                });
                return resolve(promiseReturnResult(false, {}, {}, AUTH_MESSAGES.INVALID_CREDENTIALS));
            }

            const userId = String(adminUser._id);
            const token = _signAdminToken({ user_id: userId, ttl_seconds: ttlSeconds });
            const now = new Date();

            // Best-effort, and isolated: an audit stamp that failed to write is not a reason to
            // refuse a session that has already been legitimately established.
            try {
                await adminUserRepository.touchLastLogin({ user_id: userId, now: now });
            } catch (touchError) {
                customConsoleWarn('WARN: auth: could not record last_login_at — the sign-in itself succeeded', touchError);
            }

            customConsoleLog('INFO: auth: operator signed in', { email: normalisedEmail, user_id: userId });

            // Built field by field from the stored document rather than spread from it — a spread is
            // how `password_hash` reaches the wire the day somebody makes it selectable.
            const loginResult: AdminLoginResult = {
                token: token,
                expires_in_seconds: ttlSeconds,
                expires_at: new Date(now.getTime() + (ttlSeconds * 1000)),
                user_id: userId,
                email: normalisedEmail
            };
            return resolve(promiseReturnResult(true, loginResult, {}, AUTH_MESSAGES.LOGIN_OK));
        } catch (error) {
            customConsoleError('ERROR: auth adminAuth login', error);
            return resolve(promiseReturnResult(false, {}, error, AUTH_MESSAGES.LOGIN_FAILED));
        }
    });
};

/**
 * Verifies a session token and returns who it belongs to.
 *
 * Every way a token can be unacceptable — absent, malformed, expired, signed with the wrong secret,
 * or declaring an algorithm we do not accept — resolves to the SAME `status: false` with the same
 * message. The distinction is in the debug log, where the operator can see it and an attacker
 * cannot.
 *
 * ⚠️ This checks the TOKEN, not the account. A token stays valid for its full lifetime even if the
 * operator's row is deleted, because verifying would otherwise mean a database read on every single
 * request and a database blip would lock the dashboard out entirely. The revocation levers are
 * therefore the TTL (`AUTH_TOKEN_TTL_HOURS`, hours rather than never) and rotating `JWT_SECRET`,
 * which invalidates every issued token at once. That is a deliberate trade for a single-operator
 * deployment and should be revisited the day this grows a second user.
 *
 * @param token - The raw JWT, with no `Bearer ` prefix. The caller strips it.
 * @returns Resolves with `{ user_id, expires_at }` on success, or `status: false` with a non-specific message.
 */
const verifyToken = (token: string): Promise<ServiceResult> => {
    return new Promise((resolve) => {
        try {
            if (!token || typeof token !== 'string') {
                return resolve(promiseReturnResult(false, {}, {}, AUTH_MESSAGES.SESSION_INVALID));
            }

            // `algorithms` is the pin. See TOKEN_ALGORITHM.
            const decoded = jwt.verify(token, config.AUTH.JWT_SECRET, { algorithms: [TOKEN_ALGORITHM] });

            // `verify` returns a string for a token whose payload was signed as one. That is not a
            // shape this codebase ever mints, so it is refused rather than coerced.
            if (!decoded || typeof decoded === 'string') {
                customConsoleDebug('DEBUG: auth: token payload was not an object');
                return resolve(promiseReturnResult(false, {}, {}, AUTH_MESSAGES.SESSION_INVALID));
            }

            let userId = '';
            if (decoded.user_id) {
                userId = String(decoded.user_id);
            } else if (decoded.sub) {
                userId = String(decoded.sub);
            }
            if (!userId) {
                customConsoleDebug('DEBUG: auth: token carried no user id');
                return resolve(promiseReturnResult(false, {}, {}, AUTH_MESSAGES.SESSION_INVALID));
            }

            let expiresAt: Date | null = null;
            if (typeof decoded.exp === 'number') {
                expiresAt = new Date(decoded.exp * 1000);
            }

            const verified: VerifiedAdminToken = {
                user_id: userId,
                expires_at: expiresAt
            };
            return resolve(promiseReturnResult(true, verified, {}, AUTH_MESSAGES.TOKEN_VALID));
        } catch (error: any) {
            // Expired and tampered tokens are ROUTINE — an expiry happens to every honest operator
            // twice a day, and a probe happens to anything exposed. Logged at debug so a normal
            // install is not a wall of red, and so an attacker cannot fill the disk by looping.
            customConsoleDebug('DEBUG: auth: token rejected', { reason: error && error.message });
            return resolve(promiseReturnResult(false, {}, error, AUTH_MESSAGES.SESSION_INVALID));
        }
    });
};

export = {
    seedAdminIfMissing,
    login,
    verifyToken
};
