# Changelog

Notable changes, newest first. Dates are the day the change landed on `main`.

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
