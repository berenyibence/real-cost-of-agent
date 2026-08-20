# Contributing to Real Cost of Agent

Thank you for looking. This is a small project with a small number of firm rules, and knowing them
up front is worth more than a long style guide.

## Getting set up

There is no setup.

```bash
git clone https://github.com/berenyibence/real-cost-of-agent.git
cd real-cost-of-agent
node server/index.js     # http://127.0.0.1:4319
npm test                 # the whole suite, about a second
```

**Do not run `npm install`.** `package.json` has no `dependencies` and no `devDependencies`, and
that is a property of the project rather than an oversight. If your change needs a package, it needs
a discussion first — open an issue and make the case.

Working against someone else's data, or a fixture:

```bash
CLAUDE_HOME=/tmp/fixture-claude npm start
PORT=4400 npm start
```

`VAR=value command` is shell syntax; in PowerShell that is `$env:PORT=4400; npm start`. The app runs
on Linux, macOS and Windows, and so does the suite.

There is no watcher for the server's own source. Restart it to see a change.

## The most useful contribution

**A price or a model that is out of date.** Rates move, models ship, and this catalog is maintained
by hand — so a five-line pull request against `CATALOG` in [`server/models.js`](server/models.js) is
worth more to everyone than most features.

Two rules apply when you edit it:

- **Order matters within a tier.** The first non-`legacy` entry is what unknown members of that tier
  get priced at.
- **Mark superseded entries `legacy: true` rather than deleting them.** Sessions from last year
  still need pricing, and deleting a rate does not delete the transcripts that need it.

Please link the published source for the rate in your pull request. "I saw it on the pricing page"
with a URL is entirely sufficient; a screenshot is even better.

## The rules that are not negotiable

These are not preferences. A change that breaks one of them will be asked to change, however good it
is otherwise.

1. **Every breakdown sums to the total.** `components`, `byModel`, `byProject` and `byDay` each
   re-split the same dollars. A column using different arithmetic from the number above it is the
   exact failure this application exists to avoid, and it is invisible on screen. `test/spend.test.js`
   asserts it; a new cut must be added to that loop.
2. **A session is priced per model slice**, never at whichever model answered last. Tiers differ by
   up to 2×.
3. **An unknown model is never priced at $0.** If the id names a tier, price it at that tier's list
   rate and flag it `inferred`. If it names nothing usable, exclude it and _count_ it in `unpriced`
   with its token total, so the page can say what it left out. A confident zero is the one error that
   reads as good news.
4. **An inferred rate is the list rate, never a promotion.** A promotion applies to one named model
   for one stated period; extending it to an unpublished id invents a discount that nobody offered.
5. **Cache writes keep their TTL split** (1.25× for 5m, 2× for 1h). A write with no split recorded
   goes to 5m — the cheaper one, so an unknown can never inflate a bill.
6. **Days are local days** (`server/day.js`). `toISOString().slice(0, 10)` files an evening session
   under tomorrow, east of Greenwich.
7. **No network calls, ever.** Nothing in this repository opens an outbound socket, and the README
   promises it. The share panel's platform links are the one thing that points off-machine, and they
   are `href`s a person clicks — no `fetch`, no beacon, no remote font, no CDN script, no analytics.
   This is not a detail to trade away for a feature.
8. **Only one file is ever written**: `~/.config/real-cost-of-agent/config.json`. `~/.claude` is
   read-only here — it belongs to Claude Code, and corrupting somebody's transcripts to compute a
   statistic about them would be unforgivable.
9. **No dollar figure is reported that did not come off this machine.** Nothing in `~/.claude`
   records a charge — transcripts carry token counts and a `service_tier`, and no field anywhere
   names a dollar, a credit or an invoice. There are exactly two money figures: recorded tokens at
   published rates, and the plan price the user typed. Auth detection says which of them is the
   hypothetical one; it never says what anybody was billed. An earlier version reported
   `apiCreditsSpent: 0` from the auth heuristic and the page printed it under a green tick, which is
   a measurement's worth of confidence behind a guess.
10. **The verdict is allowed to be unflattering.** When a plan costs more than the usage was worth,
    the page says so and points at metered billing, in the same voice and at the same size as the
    good news, and every share angle inverts with it. A tool that can only conclude "your
    subscription is excellent" is an advertisement.
11. **Nothing identifying leaves the share panel.** `shareFacts` in [`web/share.js`](web/share.js) is
   an allowlist of aggregates, and it is deliberately an allowlist rather than a redaction pass: a
   new field on `/api/spend` should have to be invited into a post. If you add something shareable,
   add it to the key assertion in `test/share.test.js` too.

## Architecture, briefly

The layering is worth preserving.

| File                | Owns                                                                |
| ------------------- | ------------------------------------------------------------------- |
| `server/index.js`   | routes and static serving. Every route is listed in one `if` chain   |
| `server/scan.js`    | **everything that knows what a Claude Code transcript looks like** — including that a session spans several files, subagents included |
| `server/store.js`   | the cached index, and `withEconomics` — pricing applied to a session |
| `server/models.js`  | the catalog: rates, context windows, cache multipliers, tiers        |
| `server/spend.js`   | `spendBreakdown` — one set of dollars split five ways                |
| `server/billing.js` | plans, config sanitising, OAuth-vs-API detection, the comparison     |
| `web/app.js`        | the page. `h()` builds DOM; `render()` rebuilds it from `state`      |
| `web/share.js`      | the aggregate allowlist, the post text, the canvas card              |
| `web/theme.js`      | light or dark before first paint. A file, not an inline block — the CSP forbids one |
| `server/paths.js`   | where this app's one preference file goes, on each platform, and everywhere an older build may have put it |

Adding a file under `server/` or `web/` means checking `files` in `package.json`: it is an allowlist,
so anything it does not cover works in your clone and is missing from `npx real-cost-of-agent`. CI's
`package` job installs the tarball elsewhere and serves the page from there, which is what catches it.

`scan.js` is the only module that parses vendor JSON, and `models.js` / `spend.js` are pure
arithmetic over normalized numbers. **Adding a second agent's transcripts should mean writing one new
scanner, not touching the pricing.** If you are here to add support for another tool, that is the
shape to aim for, and it is a very welcome contribution.

`web/app.js` has no framework by design. `h('div.card', props, children)` is the only builder, and
`render()` replaces the contents of `#root` wholesale. Do not introduce React, a CDN script, or a
build step — the install-free, single-`node`-command property is the point of the project.

## Common changes

**A new plan.** Add it to `PLANS` in `server/billing.js`. `test/billing.test.js` prices every plan at
several seat counts, so a malformed entry fails immediately.

**Anything about what the user pays.** The config is `{ periods: [...] }` — a plan _history_, not a
tier, because two months of Pro then three of Max is one cost that no single tier price describes.
Each period carries `planId`, `monthlyOverride`, `seats` and `months`. `months: null` means "the span
the transcripts show", and keeping that distinct from a value that failed to parse is the whole
no-override case. Sanitising always leaves at least one period, so the editor is never empty, and the
pre-0.4 flat shape is read as a single period rather than dropped — a config silently reset to the
default is a config showing a confident comparison against a subscription nobody is on.

**A new cut of the data.** Add the bucket in `spendBreakdown` (`server/spend.js`), then a `CUTS`
entry and a renderer in `web/app.js`. Add the new bucket to the loop in `test/spend.test.js` that
asserts everything sums to the total.

**A new share platform.** Add it to `shareTargets` in `web/share.js` with an honest `prefills` flag,
and a `note` if it cannot take the text. Add its host to the assertion in `test/share.test.js`. Use a
text label, not the platform's logo: a remote logo is a network request this project does not make,
and a bundled one is somebody else's trademark shipped under our licence.

**A new share angle.** Add an entry to `ANGLES` in `web/share.js`. It supplies the words and the
card's headline together, so they cannot drift apart. Three things every angle owes the reader, all
of them asserted in `test/share.test.js`:

- It names the gap between the plan and the list-rate figure. That is the number people repeat.
- It survives the gap running the **other** way. Write the losing case first — the test seeds a plan
  that cost more than the work was worth and fails any angle that still claims a saving.
- Its short post fits 280 characters, for every plan name and every magnitude of number. `shareText`
  degrades in a fixed order to guarantee this, so the thing to check is that your headline is not so
  long it forces the fallback on ordinary data.

## Style

- **Comments explain why**, especially where a plausible simpler version is wrong. Several comments
  in this codebase record a real bug that was shipped and then found. Do not delete one without
  knowing which.
- **Tests are named as sentences that state the rule.** `test('an unknown model is never priced at
  zero')`, not `test('lookupModel works')`. The name is the specification.
- **Prose in the UI says what a number _is_,** not what it might be. "API-equivalent" is not "cost",
  and a figure that had to guess says so where it is shown.
- Two-space indent, single quotes, semicolons, trailing commas in multi-line literals. Match the file
  you are in; there is no formatter to argue with.

## Pull requests

- One concern per pull request. A price update and a UI change are two.
- `npm test` must pass. Add a test for anything with arithmetic or a boundary in it.

  It is `node --test` with no argument on purpose. `node --test "test/*.test.js"` needs the runner to
  expand the glob itself, which it did not learn to do until after 20.11 — the floor `engines`
  claims — and `node --test test/` is the mirror image, working on 20.11 and failing on 24 and
  later. Bare discovery is the only spelling that holds across the whole supported range, and it
  leans on no shell, which matters because CI runs on Windows too.

  Bare discovery also means **every `.js` file under `test/` is run**, not only `*.test.js`. A
  helper module dropped in there is executed as a test file; put shared fixtures inside the test
  that needs them.
- **Anything platform-specific gets a test that can run anywhere.** `resolveConfigDirs` takes the
  platform, the environment and the home directory as arguments for exactly this reason: the
  Windows answer is checkable from Linux. A test that only runs on Windows would not have caught
  either of the bugs that rule exists for, because neither was written on Windows. Where the
  behaviour genuinely is the platform's — how a URL decodes into a filename, what `web/con` opens —
  `test/smoke.test.js` boots the server and asks, and CI runs it on all three.
- Say what you verified by hand. "Ran it against my own `~/.claude`, 300 sessions, totals matched the
  old build to the cent" is the most useful sentence in a review.
- Screenshots for anything visual, in both themes if you touched colour.

## Reporting a bug

Open an issue with the templates provided. The single most useful thing you can include is **what
number you expected and what you got** — this is a tool about arithmetic, and "it looks wrong" is
hard to act on where "the by-model column adds to $4 more than the headline" is a five-minute fix.

Never paste raw transcript content into an issue. It contains your source code and your prompts.
Session ids, token counts and model names are safe and are usually all that is needed.

For anything with a security or privacy dimension, see [SECURITY.md](SECURITY.md) instead.

## Code of Conduct

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

Contributions are accepted under the [Apache-2.0](LICENSE) licence that covers the project. There is
no CLA.
