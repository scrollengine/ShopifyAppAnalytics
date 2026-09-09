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

- **What an attacker gets.** Read the store roster? Read revenue? Authenticate
  as the admin? Reach the Partner API token? "Improper input handling" without
  a consequence is hard to prioritise.
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

- The admin authentication model: `POST /api/auth/login`, the JWT it issues, and
  the `verifyAdmin` guard on every other route. A way to reach any `/api/*`
  endpoint without a valid token is the highest-severity report this project can
  receive, and `backend/test/routeGuard.test.js` exists specifically to assert it
  cannot happen. A case that test misses is a real finding about the test too.
- Any path that leaks one operator's data across the tenant boundary, or leaks a
  configured secret — the Partner API token, `JWT_SECRET`, the BigQuery service
  account — into a response, a log line, or an error message.
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
  reusing a weak `ADMIN_PASSWORD`, or committing a `.env` are misconfigurations,
  not vulnerabilities in the software. If the software makes one of those the
  easy or default path, though, that *is* a finding — say so and we will treat it
  as one.
- Missing security headers, cookie flags, or rate limiting on an endpoint with no
  demonstrated impact, and automated-scanner output with no analysis attached.

## The trust model, so reports can be calibrated

Knowing what this software assumes will save you writing up something already
documented as designed:

1. **There is one class of user: the operator.** No merchant, customer or
   end-user ever authenticates to this system. It is an internal tool, and the
   licence permits it only for your own company's internal business operations.
2. **One administrator credential guards everything.** `ADMIN_EMAIL` plus
   `ADMIN_PASSWORD` (or `ADMIN_PASSWORD_HASH`) buys a JWT, and that JWT opens
   the entire API. There are no roles and no per-endpoint permissions — by
   design, for now. Reporting "there is no RBAC" tells us something we know.
3. **The token is carried in `Authorization: Bearer` and nowhere else.** There is
   deliberately no `?token=` query fallback and no cookie fallback, because a
   token in a URL is written to every access log in plaintext. A change that
   reintroduces either is a vulnerability, not a convenience.
4. **`/healthz` and `POST /api/auth/login` are the only endpoints reachable
   without a token.** That list is asserted in `routeGuard.test.js`. A third one
   is a finding.
5. **The service is expected to run somewhere private** — a VPN, a private
   network, or behind your own reverse proxy — and to hold a Partner API token
   with read access to your entire app portfolio. Treat its host accordingly.

## If you are running this

Two things that are worth more than any patch we could ship:

- **Keep `.env` out of version control.** The root `.gitignore` covers `.env`,
  `.env.*`, `*.pem`, `*.key`, and the common service-account key filenames. A
  credential that reaches a public repository is compromised from the moment it
  is pushed; rotating it is the only remedy, and rewriting history does not help
  once it has been fetched.
- **Rotate the Partner API token** if the host is ever compromised. It reads
  revenue and merchant data for every app on the account.
