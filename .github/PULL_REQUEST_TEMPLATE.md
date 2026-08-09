<!--
Thank you. One concern per pull request, please — a price update and a UI change are two.
Delete any section that does not apply; an empty checklist is worse than a short one.
-->

## What this changes

<!-- One or two sentences. If it fixes an issue, "Fixes #123" here. -->

## What you verified by hand

<!--
The most useful sentence in the review. For example:

  Ran it against my own ~/.claude — 340 sessions, 18 projects. The headline matched the previous
  build to the cent, and the new column sums to it.

For anything visual, screenshots in both themes.
-->

## Checklist

- [ ] `npm test` passes
- [ ] No new dependencies (`package.json` still declares none)
- [ ] No outbound network call was added
- [ ] Nothing new is written outside `~/.config/real-cost-of-agent/config.json`

If arithmetic changed:

- [ ] Every breakdown still sums to the total, and any new bucket is in the loop in `test/spend.test.js`
- [ ] Sessions are still priced per model slice, not at one model
- [ ] No model can be priced at $0 — unknown ids are inferred at the tier's list rate, or counted in `unpriced`

If the catalog changed:

- [ ] The published source for the rate is linked below
- [ ] Superseded entries are marked `legacy: true` rather than deleted
- [ ] It is a list rate, not a promotion

If sharing changed:

- [ ] `shareFacts` still carries only aggregates, and the key assertion in `test/share.test.js` is updated
- [ ] Any new platform has an honest `prefills` flag and a text label rather than its logo

## Anything else

<!-- Trade-offs you made, things you were unsure about, a decision worth a second opinion. -->
