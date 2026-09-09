# Contributing

Read this before you write code, because the honest answer is unusual and it is
better to hear it now than after you have spent an evening on a patch.

## The short version

| | |
|---|---|
| Bug reports | **Open now, and wanted.** |
| Reports of a wrong number | **The most valuable thing you can send.** |
| Questions, design discussion, "we tried this and it didn't fit" | **Open now, and wanted.** |
| Security reports | **Open now — [`SECURITY.md`](SECURITY.md), by email, not as an issue.** |
| Pull requests | **Not yet.** Please don't open one. See below. |

## Why pull requests are not open yet

This is not a policy about you. It is a licensing fact.

The project is under the **PolyForm Internal Use License 1.0.0** (see
[`LICENSE`](LICENSE)). That licence grants you the right to run, copy and modify
the software for your own company's internal business operations. It grants **no
distribution right at all** — that is the whole point of it, and it is deliberate.

Two consequences follow, and the second is the one that matters here.

**First: forking on GitHub is separately permitted.** Because PolyForm Internal
Use grants no distribution right, the licensor grants GitHub users the limited
licence in GitHub's Terms of Service §D.5 — to reproduce this repository *by
forking, within GitHub, through GitHub's own functionality*. That permission
comes from the licensor rather than from GitHub, is confined to GitHub, and adds
nothing to the licence. So you can fork it here and modify your fork for your own
internal use. You cannot republish it elsewhere.

**Second: the terms for inbound contributions do not exist yet.** Most projects
rely on an implicit "inbound = outbound" — you contribute under the same licence
the project ships under. That does not work here, because the outbound licence
grants no distribution right, so it cannot be the licence under which you hand us
code to redistribute. The project therefore needs an explicit inbound instrument
— a DCO or a CLA — and **it has not been published yet.** It is on the roadmap in
the README.

Taking a pull request before that instrument exists would mean merging code whose
terms nobody has written down. That is a mess for you and a worse one for anyone
who later runs the result. So: no pull requests yet. **Please don't invest work
in one.** If you open one anyway it will be closed with a pointer to this file,
which is a waste of your time that we would rather prevent.

There is no CLA to sign today, and no DCO to sign off on. Do not read this file
as implying either exists.

When the inbound terms are published, this file will be rewritten and the README
roadmap item will be ticked. Watch the repository if you want to know when.

## What is genuinely useful right now

### 1. Tell us about a number that was wrong

The README says it and it is not a figure of speech: **if a number on your own
dashboard has ever been confidently wrong, we want to hear about it.** Analytics
code fails silently — it does not crash, it returns a plausible wrong answer, and
the number ends up in a board deck. Most of the guards in this codebase exist
because a specific number was wrong once.

Useful shape for that report:

- what the number claimed, and what was actually true
- how you found out
- what produced the error — a definition, a join, a date boundary, a settlement
  delay
- whether it read as obviously wrong, or plausible

You do not need to be using this project to send one. Experience from any
Shopify-app analytics setup is relevant.

### 2. Report a bug in this project

Use the bug template. The single most useful fact is usually the response from
`GET /api/meta/coverage` for the app in question, because it says what the data
actually reaches — most "wrong number" reports turn out to be a coverage gap that
the endpoint already describes.

### 3. Ask the questions the documentation does not answer

If a definition is ambiguous — what counts as a conversion, what "active" means,
which population a percentage is over — that is a documentation bug, and it is
worth an issue. Ambiguity in a metric definition is how two people read the same
dashboard and disagree about the business.

## If you are running a modified copy

Entirely permitted, for your own company's internal business operations. Two
things that will make your life easier:

- **Run the tests.** `cd backend && npm ci && npm test`. They need no database,
  no network and no credentials. `test/routeGuard.test.js` is the one to care
  about: it asserts that every `/api/*` route is behind `verifyAdmin`, and that
  the only endpoints reachable without a token are `POST /api/auth/login` and
  `GET /healthz`. If you add a route, that test tells you whether you have just
  published it to the internet.
- **CI runs the same things** — see `.github/workflows/ci.yml`. It also checks
  for import cycles, which are invisible to both `tsc` and `eslint` in this
  codebase and have broken this test suite once already, with nothing in the
  failure naming a cycle.

If a modification you made for yourself would be useful to everyone, open an
issue describing it. That costs you nothing under the current terms, and it means
the change is already understood when pull requests do open.

## Conduct and contact

Participation is covered by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

The contact address for everything on this page — conduct, licensing, security,
and a commercial licence for rights the current one does not grant — is
**<support@scrollengine.com>**, the notices address in [`LICENSE`](LICENSE).
