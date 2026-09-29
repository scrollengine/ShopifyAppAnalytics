# Security policy

The README asks you to report security problems. This is the page that says how,
so that "tell us" is an actual route rather than a gesture.

## Reporting a vulnerability

**Email <support@scrollengine.com> with `[SECURITY]` at the front of the subject
line.** That is the notices address in `LICENSE`, and it is the channel of
record for this repository.

**Please do not open a public issue for a vulnerability.** Everything in this
repository is a self-hosted deployment holding one company's revenue and
customer data; a public issue is a set of directions to somebody else's
revenue figures, published before they have had a chance to patch.

A report is most useful when it contains:

- **What an attacker gets.** Read the store roster? Read revenue? Sign in as
  someone else, claim the owner account, or do something their role does not
  allow? Reach the Partner API token? "Improper input handling" without a
  consequence is hard to prioritise.
- **How to reproduce it**, ideally as a `curl` — the request, the headers, and
  what came back.
- **The commit or version** you tested, and whether the BigQuery tier was
  configured.
- **Your assumption about the deployment**, because it changes everything: see
  the trust model below.

You do not need a proof-of-concept exploit. A precise description of the flaw is
worth more than a weaponised one, and please don't test against a deployment
that isn't yours.

## What to expect

This is a small project maintained by a small company, and honest numbers beat
flattering ones:

| | |
|---|---|
| Acknowledgement of your report | within **5 business days** |
| An assessment — confirmed, not-a-bug, or need-more-detail | within **15 business days** |
| Fix for a confirmed issue that exposes data or bypasses authentication | prioritised over everything else in flight |
| Disclosure | after a fix is published, or **90 days** after your report, whichever comes first |

If you have not heard anything in 5 business days, please send the mail again
rather than assuming it was received — mail gets filtered, and a silent inbox is
not a decision.

We will credit you by name or handle in the release notes for the fix unless you
ask us not to. There is no bug-bounty programme and no payment; saying so up
front is more respectful of your time than leaving it ambiguous.

## Supported versions

The project is **pre-release** and there are no tagged releases yet. The only
supported version is **the current `main`**. Fixes land there; there is no
backport branch to ask about.

## Scope

**In scope** — the code in this repository:

- The authentication and authorisation model: sign-in (`POST /api/auth/login`),
  the session token it issues, the `authenticate` guard on every other `/api/*`
  route, and the one permission each guarded route declares. A way to reach a
  guarded endpoint without a valid session is the highest-severity report this
  project can receive, and `backend/test/routeGuard.test.js` exists specifically
  to assert it cannot happen. A case that test misses is a real finding about the
  test too. A way to do what your role does not allow — read a page's data
  without its permission, manage someone at or above your own role, grant
  `roles:manage` — is the next one down.
- The account flows that work without a session: first-run setup, invitation
  acceptance, forgot-password and password reset. Claiming or reopening setup on
  a locked install, using an emailed link that should be dead, learning whether an
  address has an account, or getting a link built from anything other than
  `APP_PUBLIC_URL` are all findings.
- Any path that leaks data across the tenant boundary or past a role's
  permissions, or leaks a secret — the Partner API token, `JWT_SECRET`,
  `SMTP_PASS`, the BigQuery service account, a password hash, an emailed link's
  token — into a response, a log line, an email, or an error message.
- Injection into the Mongo query layer, or into the BigQuery statements built by
  the sync jobs.
- Anything in the container or compose setup that publishes something the
  operator did not ask to publish.
- The dashboard: authentication handling, token storage, XSS through data that
  arrives from the Partner API.

**Out of scope** — please report these elsewhere, or not at all:

- **Shopify's own systems**, including the Partner API and the Partner
  dashboard. Report those to Shopify. This project is not affiliated with
  Shopify.
- **Vulnerabilities in third-party dependencies** with no exploitable path
  through this code. Report them upstream. If you have a working exploit *via
  this project*, that is in scope and we want it.
- **An operator's own deployment.** Exposing this service to the public internet,
  leaving first-run setup open on a public address without `SETUP_OWNER_EMAIL`,
  giving a role more than it needs, or committing a `.env` are misconfigurations,
  not vulnerabilities in the software. If the software makes one of those the
  easy or default path, though, that *is* a finding — say so and we will treat it
  as one.
- Missing security headers, cookie flags, or rate limiting on an endpoint with no
  demonstrated impact, and automated-scanner output with no analysis attached.

## The trust model, so reports can be calibrated

Knowing what this software assumes will save you writing up something already
documented as designed:

1. **Every user is a member of your own organisation.** No merchant, customer or
   end-user ever authenticates to this system. It is an internal tool, and the
   licence permits it only for your own company's internal business operations.
   People get an account in exactly two ways: the first-run setup screen creates
   the **owner**, once, and then locks for good (a flag stored in the database,
   never "there is at least one user"); an emailed **invitation** creates
   everyone else. There is no public sign-up.
2. **Roles decide what each person may do, per route, per request.** Twelve
   permissions are fixed in code; four roles are built in (Owner, Admin, Analyst,
   Viewer), and the owner can create custom ones. Every guarded route declares
   exactly one permission beside its handler, and a key outside the catalogue
   stops the route file loading. Permissions are resolved from the database on
   every request and are never carried in the token, so a role change or a
   disable takes effect on the next request. `roles:manage` belongs to the owner
   alone and cannot be granted. Nobody acts on themselves through the user
   endpoints or on the owner through the API; anyone else with `users:manage` may
   act only on roles strictly below their own. What a role discloses is the
   owner's choice: an Admin or a Viewer seeing revenue and store names is the
   design, not a leak. The permission table is in `DEPLOYMENT.md`, section "Users,
   roles and permissions".
3. **The session token is carried in `Authorization: Bearer` and nowhere else.**
   There is deliberately no `?token=` query fallback and no cookie fallback,
   because a token in a URL is written to every access log in plaintext. A change
   that reintroduces either is a vulnerability, not a convenience. The token is an
   HS256 JWT with the algorithm and audience pinned; it carries a user id and a
   session id and nothing else, and the session row it names is re-read on every
   request, so signing out, a password change or reset, a disable and the CLI's
   `revoke-sessions` all end it immediately. A token without a session id (every
   token the single-operator build issued) is refused. It is signed with a key
   derived from `JWT_SECRET`, never the secret itself, so rolling back to the
   single-operator build — which trusted any token signed with the raw secret —
   does not turn this build's sessions into its operator's.
4. **The one exception: emailed links carry a token in the URL *fragment*.**
   Setup confirmation, invitation and password-reset links end in `#token=…`,
   never `?token=…`: a browser does not send the fragment to any server, so it
   reaches no access log and no `Referer`. The page removes it from the address
   bar and sends it in a POST body only when the person presses the button, so a
   mail scanner that opens the link spends nothing. These tokens are 32 random
   bytes, stored only as a sha256 hash, single-use, tied to one purpose and short
   lived — never JWTs. Links are built only from `APP_PUBLIC_URL`, never from a
   request's `Host` or `X-Forwarded-*` headers, and the backend's lint config
   refuses those reads. A change that moves a token into a query string or builds
   a link from the request is a vulnerability.
5. **Exactly ten endpoints are reachable without a session**, and that list is
   asserted by the `ALLOWLIST` in `routeGuard.test.js`:

   - `GET /healthz`
   - `POST /api/auth/login`
   - `GET /api/auth/setup`, `POST /api/auth/setup`,
     `POST /api/auth/setup/inspect`, `POST /api/auth/setup/complete`
   - `POST /api/auth/invites/inspect`, `POST /api/auth/invites/accept`
   - `POST /api/auth/password/forgot`, `POST /api/auth/password/reset`

   An eleventh is a finding. Sign-in, forgot-password and the setup request
   answer the same way whether or not an account exists or an address may claim
   setup, and the email-dependent work happens after the answer is sent, so
   neither the reply nor its timing says which. Each of these has its own rate
   limiter (sign-in and the two email-sending ones by address, the link pages by
   the link's token).
6. **Until setup completes, it is first-come unless pinned.** Whoever reaches the
   setup screen first can become the owner, unless `SETUP_OWNER_EMAIL` is set or
   the database holds accounts from a single-operator build, which restrict it to
   their addresses. The backend warns about the open window at every boot. An
   empty database — a new volume, `docker compose down -v` — reopens it. A way to
   claim or reopen setup on a locked install is a finding; the documented window
   on a fresh, unpinned one is not.
7. **Shell access to the server is owner access.** The recovery CLI
   (`npm run auth:admin:dist`) prints setup and password-reset links for any
   account, re-enables accounts and moves ownership — without mail and without
   rate limits. Write access to the database is the same. That is the recovery
   path when everything else has failed, by design.
8. **The service is expected to run somewhere private** — a VPN, a private
   network, or behind your own reverse proxy — and to hold a Partner API token
   with read access to your entire app portfolio. Treat its host accordingly.
9. **Known absences.** No multi-factor authentication, no single sign-on, no email
   change and no user deletion (a leaver is disabled). The rate limiters and email
   caps live in process memory, so a restart clears them. The API sends a strict
   Content-Security-Policy; the dashboard sends only `frame-ancestors 'none'` and
   has no script nonce yet. Reporting that one of these is missing tells us
   something we know. A concrete attack that works *because* of one is in scope.

## If you are running this

Four things that are worth more than any patch we could ship:

- **Set `SETUP_OWNER_EMAIL` before the first boot** on anything reachable by
  someone other than you. Until setup completes, the setup screen belongs to
  whoever reaches it first.
- **Keep `.env` out of version control.** The root `.gitignore` covers `.env`,
  `.env.*`, `*.pem`, `*.key`, and the common service-account key filenames. A
  credential that reaches a public repository is compromised from the moment it
  is pushed; rotating it is the only remedy, and rewriting history does not help
  once it has been fetched.
- **Rotate the Partner API token** if the host is ever compromised. It reads
  revenue and merchant data for every app on the account. Rotate `SMTP_PASS`
  (for Gmail, delete the app password) and `JWT_SECRET` at the same time.
- **Give each person the narrowest role that does their job.** Viewer and
  Analyst both see store names and money; a custom role without
  `merchants:read` and `financials:read` sees neither.
