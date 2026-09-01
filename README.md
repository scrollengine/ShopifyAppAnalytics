# Shopify App Analytics

**The performance dashboard the Shopify Partner dashboard doesn't give you.**

Point-in-time MRR, cohort funnels, trial outcomes and churn analysis for Shopify app developers —
built from the Partner API, your own billing records, and Shopify's listing analytics export.

> **Status: pre-release.** This runs in production today and is being extracted for release. Star or
> watch if you want to know when it lands.
>
> **Source-available, not open source.** Free to run and modify for your own company's internal
> business operations, including commercially. It may not be distributed, operated as a service for
> others, or bundled into a product you supply. See [Licence](#licence) for the exact terms.

---

## Why this exists

Shopify's Partner dashboard tells you what you earned. It does not tell you:

- What was our MRR on **March 31st** — and which merchants made up that number?
- Of everyone who installed in January, how many were still paying in June?
- Did that store **upgrade, downgrade, or leave** — and when?
- Are we losing a few large customers, or a lot of small ones?
- How many trials actually convert, and do people quit *during* the trial or *after* it?
- Is our churn real, or is Shopify just settling payouts late?

That last question is why this project is careful rather than clever. Analytics code fails
**silently**. It doesn't crash — it returns a plausible wrong number. Nobody gets paged, and the
number ends up in a board deck.

---

## What's in this release

The **Performance** suite — nine views covering acquisition through revenue and churn.

### Conversion Funnel

The whole path in one picture: listing page views → engaged views → install clicks → installs →
trials started → converted to paid → churned, each step showing its conversion rate off the one
before it.

It also carries **install cohorts** and **retention curves**, so you can ask "of the merchants who
installed in a given month, what share were still here N months later" instead of only ever looking
at today's snapshot.

One thing the page is explicit about: the early steps come from Shopify's listing analytics and count
**visitors**, while the later steps come from the Partner API and count **shops**. Any percentage
crossing that seam compares two different populations. The page marks the seam rather than quietly
presenting the ratio as fact.

### Traffic Sources

Where your listing traffic and installs actually come from — the split between organic discovery and
paid placement, plus the geography of who is finding you.

This answers the question ad reporting can't on its own: not "how many clicks did we buy", but which
sources produce merchants who install and stay.

### Trial Funnel

Trial starts over time, how many convert, and — the part most dashboards miss — **where people quit**.
Abandoning on day three of a seven-day trial and cancelling two months after converting are entirely
different problems, so they are counted separately.

Conversion here is a date comparison, not an event: a merchant converted if they were still around
when the trial ran out. Counting the subscription event instead marks every trialling shop as
converted the moment they sign up, which inflates the number and hides trial abandonment completely.

### Logo Churn

Churn measured in **customers**, not money. Deliberately its own page, because losing ten $9
merchants and losing one $500 merchant are the same revenue event and completely different business
events. A dashboard that shows only one of the two hides which is actually happening.

### Stores

Every merchant who has ever touched your app, with their lifecycle and whether the app is installed
right now — filterable by plan, state, country and install status.

Install state is reconstructed from the relationship events Shopify emits (install, reinstall,
uninstall, deactivate), so it survives a merchant leaving. A store that installed, paid and left is
still there with its history intact, rather than vanishing from your records.

### Subscriptions

Who is paying you right now, and on what plan.

Worth being precise about what this list is: merchants **currently on a paid plan**. Someone who
never subscribed and someone who paid for a year then uninstalled are both absent. That's the right
definition of "who is paying us today" and the wrong one for "everyone we've ever billed" — the page
says which it is, so the two don't get confused.

### Revenue

The headline view: **MRR, active subscribers, ARPU and cash collected — measured at any date you
pick, not just today.** Choose a past month and every figure on the page reports what was true then.

- **MRR movement** for the period — new business, expansion, contraction and churn, reconciling from
  the opening balance to the closing one.
- **Click any of those figures** to see the merchants behind it, each showing the plan they were on
  then, their plan today, whether they're still installed, and whether they upgraded, downgraded or
  left.
- **Revenue by plan**, so you can see which tier the money actually comes from.
- **A reconciliation panel** showing the same figure computed three independent ways — contracted
  run-rate, live subscription state, and settled payouts. The gaps between them are diagnostic, so
  they're published rather than hidden.

Cash and run-rate are kept strictly apart throughout. Cash is lumpy — annual prepayments, refunds,
payout timing. MRR is smooth. Merging them makes both wrong.

### Revenue Country

Where the money comes from geographically — revenue and merchant counts by country.

Country data arrives in inconsistent forms, so names are normalised before grouping; otherwise one
country lands in two buckets and both are wrong. Anything that can't be attributed is **published as
an explicit remainder** rather than quietly dropped, so the breakdown always reconciles with the
total on the Revenue page.

### Revenue Churn

Revenue lost per month, gross and net, with the merchants behind each figure.

Net churn is not clamped at zero — when expansion outruns losses it goes negative, and negative net
churn is the single best signal a subscription business has. Rounding it up to zero would hide your
best months.

---

## Why you can trust the numbers

Most of the work here isn't features. It's refusing to publish confident wrong answers. Each of the
following was a real bug that shipped, got caught, and is now permanently guarded.

**A past month has to actually be a past month.** The obvious way to compute historical MRR is to
take today's subscriber list and value it at old prices. That's wrong invisibly: when a merchant
uninstalls, their plan reference gets reset, so they contribute *nothing* to any historical month.
Every past month under-reports, while erasing exactly the churn you were trying to measure.

**Late payment is not cancellation.** Merchants bill on their own cycle and Shopify settles when it
settles. One merchant's payouts landed in April and then not again until July. A naive "have we been
paid recently?" check called them churned for their full value — producing a **47.6% churn reading
for a month in which nobody cancelled.**

**But cancellations that never sync can't count forever either.** Removing that check entirely
produced the opposite failure: an MRR reading of **$45M against $10K of real settled payouts**, on a
suspiciously flat line. A flat MRR line is a tell — a real subscriber base moves.

**Unknown is not zero.** A month before your records begin has no answer. Showing `0.00` there claims
your business had no customers, which is a statement about the world rather than about your data.
Unknown values render as `—` with the reason, and charts break the line instead of drawing it to the
floor.

**Every number carries its own scope.** Any figure that could be screenshotted out of context states
its own date and source. A lifetime total never sits unlabelled beside a windowed one.

**If a card says "23 stores", clicking it shows 23 stores** — the count is derived from that list, not
calculated separately in a way that can drift from it.

---

## Not in this release

Coming in a later drop, once this one has settled:

- Competitor tracking — listing snapshots, review mining, positioning over time
- Keyword rankings and App Store position monitoring
- Search-term attribution
- Shopify Ads spend and performance
- LLM-generated insights

---

## What you'll need

- A Shopify Partner account with API access — the only hard requirement
- Somewhere to run it, and a database to keep history in
- *Optional:* access to Shopify's listing analytics export, which powers the Conversion Funnel's
  upper steps and all of Traffic Sources

Without the optional piece everything from installs onward still works; the listing-analytics views
report that they have no data rather than showing zeros.

---

## Roadmap

- [ ] Extract into a standalone, installable release
- [ ] Publish inbound contribution terms (DCO or CLA) and open pull requests
- [ ] Ship the dashboard interface alongside the data layer
- [ ] One-command quickstart
- [ ] A demo dataset, so the dashboard is explorable without a Partner account
- [ ] The Market Intel suite listed above

---

## Contributing

**Pull requests are not being accepted yet** — the extraction has to land first, and the inbound
contribution terms have to be published with it. Please don't invest work in a PR until that's in
place. Issues and discussion are very welcome right now, especially from other Shopify app
developers.

**If a number on your own dashboard has ever been confidently wrong, I'd like to hear about it.**
Those stories are what this project is made of.

---

## Licence

**PolyForm Internal Use License 1.0.0** — source-available, not open source.

You may run, copy and modify this for the **internal business operations of you and your company** —
which the licence defines to include organisations under common control with yours. Commercial use
inside your own company is fine. What you may **not** do is distribute it, or use it for any other
purpose.

| | |
|---|---|
| ✅ | Run it on your own app's data, at work, commercially |
| ✅ | Modify it and self-host it, across your own portfolio of apps |
| ❌ | Distribute it — publish copies, or pass it to anyone outside your company |
| ❌ | Operate it as a service for anyone outside your company |
| ❌ | Bundle it into a product you supply to others |

**Forking on GitHub — a separate permission, not part of the licence.** PolyForm Internal Use grants
no distribution right at all; that is unusual and deliberate. Separately from it, by publishing this
repository publicly we grant GitHub users the limited licence described in GitHub's Terms of Service
§D.5: to reproduce it *by forking, within GitHub, through GitHub's own functionality*. That
permission is ours as repository owner rather than GitHub's, it is confined to GitHub, and it adds
nothing to the licence. Republishing the code elsewhere is not permitted. The same wording appears in
`LICENSE`, so the two agree.

> The table above is a plain-English summary for orientation only. The `LICENSE` file is the licence;
> where the two differ, the `LICENSE` file governs.

Want to do something the licence doesn't allow? A separate commercial licence is available — see the
contact address in `LICENSE`.

**Why not MIT?** So teams can use and learn from this freely, without it becoming someone else's paid
product. PolyForm Internal Use says exactly that in about a page of plain English, which is why it
was chosen over a bespoke licence nobody's lawyer has seen before.

---

<sub>Not affiliated with or endorsed by Shopify. "Shopify" is a trademark of Shopify Inc.</sub>
