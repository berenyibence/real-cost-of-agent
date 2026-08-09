# Changelog

Notable changes, newest first. Dates are the day the change landed on `main`.

## 0.3.0 — 2026-08-09

The billing panel stopped claiming something it could not know, and the share card learned to argue
four different ways — including against the plan.

### Removed

- **"API credits spent: $0."** The green tick block is gone, and `compareBilling` no longer returns
  `apiCreditsSpent`. Nothing in `~/.claude` records a charge: the transcripts carry token counts and
  a `service_tier`, and no field anywhere names a dollar, a credit or an invoice. That figure was
  inferred from the OAuth beta appearing in local telemetry — a reasonable inference, printed under a
  tick mark with a measurement's worth of confidence. Auth mode is still detected and still shown,
  because it says which of the two prices is the hypothetical one; it never says what anyone was
  billed.

### Added

- **A verdict, which is allowed to go against the plan.** `compareBilling` returns `plan-ahead`,
  `close`, `api-ahead`, `no-plan` or `no-usage`, and the panel renders each in the same voice at the
  same size. When the plan costs more than the usage was worth, the page says so and points at
  metered API billing rather than quietly reporting a smaller multiple.
- **`partialPeriod`.** A fresh install has three days of history and is charged for a whole month,
  which makes any plan look like a bad deal. The comparison is still shown — it is the honest one for
  the data present — and the page now says what it is looking at.
- **Four share angles**, each supplying the post and the card headline together so they cannot
  contradict each other: **Value** (what $1 of plan bought), **Saved** (the dollars, and the number
  people repeat), **Run rate** (what the habit costs per month metered — the "is Max worth it?" and
  "could I afford this at all?" question), and **Breakdown** (output versus cache, for an audience
  that would rather argue about that).
  - Every angle names the gap, and every angle inverts when the gap runs the other way. The "Saved"
    angle becomes what the plan cost *above* metered rates. No combination of settings produces a
    saving that did not happen.
- **Screenshots in the README**, generated from real data with the by-project and by-session cuts
  deliberately excluded.

### Changed

- **Short posts are fitted to 280 characters rather than written and hoped for.** Four angles times a
  plan that may be ahead or behind times numbers from $4 to $987,654 is more combinations than anyone
  re-counts by hand, and an overrun costs the end of the post — which is the link. `shareText` now
  degrades in a fixed order: the session and project counts go first, then the sentence naming the
  tool, and the link never goes at all.
- **The portrait and square cards render the split as a list** with a bar per component, instead of a
  legend under a stacked bar. It reads at arm's length on a phone, and it was the content the extra
  height was missing — 4:5 filled by stretching gaps alone is a dense block in an empty frame.
- `subscriptionCost` is now `planCost`, and `saved` is now `difference` and signed.
- The warning amber is a token in both themes; the dark theme's `#f0a35e` is 2.1:1 on white.
- The share panel's character count states the consequence instead of scolding — a long post is
  *meant* to be over 280, and only turns amber when the length contradicts the length you asked for.

## 0.2.0 — 2026-08-09

Renamed to **Real Cost of Agent**, and given a way to say the number out loud.

### Added

- **The share panel.** Builds the post and the card image from what the page already computed, for
  X, Bluesky, LinkedIn, Threads, Reddit, Hacker News, Facebook and Instagram. The image is painted on
  a canvas in the browser at 1200×630, 1080×1350 or 1080×1080, and copied or downloaded from there.
  - Nothing is posted by the page. Each platform link opens that platform's own composer with the
    text in it; the post is still made by a person.
  - The box is the post: every button sends exactly the characters visible in the textarea, so there
    is no second, unedited version of your words going anywhere.
  - Facebook and Instagram cannot be prefilled — Facebook's sharer takes a URL and nothing else, and
    Instagram has no web composer. Both say so, and put the text on the clipboard instead.
- **`shareFacts`, an allowlist**, as the only door between the spend payload and anything shareable.
  It carries the total, the plan's name, the month count, session and project counts, and the
  percentage split. Project names, file paths and session titles are structurally absent, and
  `test/share.test.js` asserts it against a payload seeded with paths in every field that has one.
- **A brand**: a receipt mark, the lockup, and a social preview card, in `web/brand/`.
- **CI** on Node 20.11, 22 and 24, across Linux and Windows, with a smoke test that boots the server
  against an empty `CLAUDE_HOME` and checks every route — including that nothing outside `web/` is
  served.
- Contributing guide, code of conduct, security policy, and issue and pull request templates.

### Changed

- The application is now **Real Cost of Agent**; the page, the title, the log prefix and the package
  name follow.
- Config moved to `~/.config/real-cost-of-agent/config.json`. The old
  `~/.config/agent-spend/config.json` is still read as a fallback, so nobody's plan is silently reset
  — a rename that quietly restores the default plan would keep showing a confident comparison against
  a subscription you are not on.
- The comment on `serveStatic` now says what actually happens: the URL parser resolves dot segments,
  including `%2e%2e`, before the handler sees them. The containment check stays as the layer that
  does not depend on that.

## 0.1.0

First version.

- Prices `~/.claude` transcripts from the `usage` block on each assistant reply, per model slice,
  with cache traffic at its real multipliers.
- Subscription versus API: auth mode detected from local telemetry, and API credits reported as $0
  on a subscription rather than as a charge.
- Five cuts of the same dollars — components, model, project, day, session — each of which sums to
  the total.
- Unknown models priced at their tier's list rate and flagged, or excluded and counted, never
  silently zero.
