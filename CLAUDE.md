# Real Cost of Agent — notes for agents

A single local page that prices Claude Code's own transcripts, and will build the post about it. One
HTTP server, one page, **zero dependencies**, no build step, no bundler, no framework.

## Run it

```bash
node server/index.js
```

Serves http://127.0.0.1:4319. There is no install step — do not add one, and do not run
`npm install`; `package.json` has no `dependencies` and no `devDependencies`, and that is a
deliberate property of this project rather than an oversight.

```bash
npm test          # node --test, the whole suite, ~100ms
PORT=4400 npm start
CLAUDE_HOME=/tmp/fixture-claude npm start   # point it at a fixture instead of the real ~/.claude
```

To see a change, restart the server (there is no watcher for its own source) and reload the page.
`npm start` is the same thing as `node server/index.js`.

## Where things live

| File                | Owns                                                                     |
| ------------------- | ------------------------------------------------------------------------ |
| `server/index.js`   | routes and static serving. Every route is listed in one `if` chain        |
| `server/access.js`  | which hosts and origins the server answers at all — rebinding and CSRF    |
| `server/scan.js`    | **everything that knows what a Claude Code transcript looks like** — including that a session is several files |
| `server/store.js`   | the cached index, and `withEconomics` — pricing applied to a session      |
| `server/models.js`  | the catalog, and `requestRates` — what one request is billed at, fast mode and geography included |
| `server/spend.js`   | `spendBreakdown` — one set of dollars split five ways, each summing to the total |
| `server/billing.js` | plans, config sanitising, OAuth-vs-API detection, the comparison          |
| `web/app.js`        | the page. `h()` builds DOM; `render()` rebuilds it from `state`           |
| `web/share.js`      | the share card: the aggregate allowlist, the post text, the canvas        |
| `web/theme.js`      | the theme, set before first paint. A file, not an inline block, so the CSP needs no hash |
| `web/brand/`        | the mark, the lockup, and the repository's social preview                 |

The layering is worth preserving: `scan.js` is the only module that parses vendor JSON, and
`models.js`/`spend.js` are pure arithmetic over normalized numbers. Adding a second agent's
transcripts should mean writing one new scanner, not touching the pricing.

## Invariants — break one of these and the page lies

1. **Every breakdown sums to the total.** `components`, `byModel`, `byProject`, `byDay` and
   `bySession` each re-split the same dollars. `test/spend.test.js` and `test/scan.test.js` both
   assert it. A column using different arithmetic from the number above it is the failure mode this
   app exists to avoid.

   **A derived axis is never the authority on what exists.** `byDay` used to be built by walking
   `eachDay(first, last)` and looking each date up, so the filler that makes the chart an even time
   axis silently decided which days were in the cut at all — and `eachDay` has a cap. One transcript
   with a future timestamp put the last day eleven years out and took 71% of the money out of that
   breakdown. Build from the buckets and add filler around them; anything else lets a presentation
   concern delete data. `test/timestamps.test.js` holds it.

   **This includes not truncating.** `bySession` was `topSessions`, capped at 12 rows, and the cap
   was the same bug in a different costume: 45.5% of the money on a real index had no row anywhere,
   under a heading that promised a breakdown. Row limits belong in the page — `state.sessions.limit`
   reveals 25 at a time and the footer names both figures — never in the payload. If a cut cannot
   afford to be complete, the honest fix is for it to say what it is leaving out, the way `unpriced`
   does, not to quietly ship a prefix.
2. **A session is priced per billing slice**, never at whichever model answered last. Tiers differ by
   up to 2× — and so does one tier: `speed: "fast"` bills Opus 5 at $10/$50 instead of $5/$25, and
   `inference_geo: "us"` adds 1.1× on every category. Both are recorded per request, so a slice is a
   model *plus* those terms, and `requestRates` in `server/models.js` is the only place that resolves
   them. One model can appear in two slices at two prices; a session that toggled `/fast` mid-run is
   exactly that.
3. **One API call is billed once, not once per transcript line.** Claude Code writes an assistant
   turn as one line per content block — `thinking`, then one per `tool_use` — and every one of those
   lines repeats the *same* `usage` object verbatim. Summing per line overstated the total by 2.45×
   on a real index here ($6,091 against $2,490), scaling with tool use so the biggest sessions were
   the most wrong. `parseTranscript` keys usage by `requestId` (then `message.id`) and folds each
   call in once; a line with neither id counts on its own, because dropping it is the same error
   inverted. `test/dedupe.test.js` holds the line, with a fixture copied from a real transcript.
4. **A session is several files.** A subagent gets its own transcript, one directory below the
   session that spawned it: `projects/<encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl`. Those
   lines carry their own `requestId` and their own `usage` block, because they were their own API
   calls — and frequently to a different model, since a Haiku search inside an Opus session is the
   ordinary case. Reading only the top level of a project directory left that money out of every
   figure in the app, and left it out **with no symptom**: each cut still summed to a total the work
   had never reached, so invariant 1 held perfectly while the number it held was wrong. That is
   strictly worse than the `topSessions` cap, which at least had a heading you could hold against
   it. `transcriptsUnder` walks for them, `mergeSummaries` folds them into the parent — the session's
   own transcript keeps naming the row, because a subagent's opening line is the task it was handed
   rather than anything a person typed — and slices are **copied** before folding, since
   `summaryCache` hands the same object back on every warm scan and mutating it in place would grow
   a session's cost on each rescan. `test/subagents.test.js` holds all of it, including that a
   subagent whose parent transcript was deleted still gets counted.

5. **An unknown model is never priced at $0.** If the id names a tier it is priced at that tier's
   list rate and flagged `inferred`; if it names nothing usable it is excluded and _counted_ in
   `unpriced`, with its token total, so the page can say what it left out.

   **"Unusable" includes "not a string."** `lookupModel` is fed ids out of JSON another program
   wrote, and `normalise` used to call `.replace` on them directly — so `"model": 12345` threw. The
   throw escaped the scanner's per-transcript `try`, because `withEconomics` is mapped over sessions
   in `store.js`, and emptied the whole index: one malformed line anywhere, and the page showed
   nothing. Every pricing entry point is now total over any input, and `scan.js` refuses a
   non-string id where it reads the file. `test/malformed.test.js` holds it.
6. **A session is priced whenever any part of it can be, and a borrowed rate says so.** The headline
   model is the busiest one `lookupModel` resolves — *not* the busiest outright. Taking the busiest
   outright and falling back to `session.model` (whichever answered last) meant a gateway or proxy
   id could take a whole session to `unpriced` along with all the real Claude work in it, and the
   outcome depended on nothing meaningful: the same tokens across the same two models priced at
   $0.00 or $27.51 according to which slice held more requests. Slices that still cannot be priced
   are folded onto the headline rate and the session is flagged `fallbackPriced` — surfaced as
   `fallbackPricedSessions` and a "borrowed rate" pill, counted apart from `inferredSessions`
   because borrowing a rate from elsewhere in the session is a bigger assumption than reading a tier
   out of the id. `test/gateway-models.test.js` holds it.

7. **An inferred rate is the list rate, never a promotion.** A promotion applies to one named model
   for one stated period; extending it to an unpublished id invents a discount.
8. **Cache writes keep their TTL split** (1.25× for 5m, 2× for 1h). A write with no split recorded
   goes to 5m — the cheaper one, so an unknown cannot inflate a bill.
9. **Days are local days** (`server/day.js`). `toISOString().slice(0, 10)` files an evening session
   under tomorrow east of Greenwich.
10. **No network calls, ever**, and the browser is told so. Nothing in this repo opens a socket
   outbound, the README promises that, and `server/index.js` now serves the page under
   `default-src 'self'; connect-src 'self'` so a CDN script, a remote font or an analytics beacon is
   refused rather than merely absent by convention. That is why the theme lives in `web/theme.js`
   rather than an inline `<script>`: an inline block would need a hash in the policy, and a hash is
   the thing that silently stops matching the first time somebody edits the script in a project with
   no build step to regenerate it. CI asserts the header and the absence of an inline block. It is not a detail to trade away for a feature. The share panel's platform links are the one
   thing pointing off-machine, and they are `href`s a person clicks — no `fetch`, no beacon, no remote
   font, no CDN script, no analytics, and no platform logos fetched from anywhere.
11. **Only one file is ever written**: `~/.config/real-cost-of-agent/config.json`. `~/.claude` is
   read-only here — it belongs to Claude Code. The pre-rename `~/.config/agent-spend/config.json` is
   still _read_ as a fallback, and must never be written.
12. **No dollar figure is reported that did not come off this machine.** Nothing in `~/.claude`
   records a charge — transcripts carry token counts and a `service_tier`, and no field anywhere
   names a dollar, a credit or an invoice. There are exactly two money figures in this app: recorded
   tokens at published rates, and the plan price the user typed. `compareBilling` used to also return
   `apiCreditsSpent: 0`, inferred from the OAuth beta appearing in telemetry, and the page printed it
   under a green tick — a measurement's worth of confidence behind a guess. Auth detection says which
   of the two figures is the hypothetical one; it never says what anybody was billed.
13. **The verdict is allowed to be unflattering.** When a plan costs more than the usage was worth,
    `compareBilling` returns `api-ahead`, the page says so and points at metered billing, and every
    share angle inverts with it. Same voice, same size, same prominence as the good news. A tool that
    can only ever conclude "your subscription is excellent" is an advertisement, and the verdicts
    that go the other way are what make the rest of them worth believing.
14. **Not every charge is a token.** Server-side web search is $10 per 1,000 searches and arrives as
    a count in `server_tool_use`, so a total assembled from token counts omits it and says nothing.
    It is a component like any other, in `searches` rather than `tokens` — components carry `count`
    and `unit` for this reason — and it is inside the total that invariant 1 makes every breakdown
    sum to. The token columns still total tokens: folding a per-search charge into "output" would
    balance the books and misstate what was bought. Web fetch is recorded in the same block and is
    published at no charge; it is not billed here.
15. **No screenshot in `docs/` may show a session title, a project name or a path.** The app is a
   view of one person's private work: the by-session and by-project cuts render titles taken from
   whatever they typed first and directories from their own disk. That is exactly why `docs/` has
   never held a shot of either, and why the README illustrates those two cuts in prose instead.
   Shootable panels are the ones whose every string is written in this repo or is a model name:
   `where-the-money-went`, `by-model`, `by-day`, `plan-vs-list-rates`, `light-theme`, `share-panel`.
   Before adding an image here, read every string in it and ask which file it came from — if the
   answer is "the user's machine", it does not go in. The absence of a by-project shot is a decision,
   not a gap waiting to be filled.

16. **Nothing identifying leaves the share panel.** `shareFacts` in `web/share.js` is an allowlist of
   aggregates, deliberately an allowlist rather than a redaction pass — a new field on `/api/spend`
   should have to be invited into a post rather than arrive in one by default. Project names, paths
   and session titles are not in the shape it returns. `test/share.test.js` asserts this against a
   payload seeded with paths in every field that has one; extend that test when the shape changes.

## Common changes

**A new model, or a price change.** Edit `CATALOG` in `server/models.js`, then add the row to
`RATE_CARD` in `test/pricing.test.js` — base rates *and* the published cache columns, which re-derive
the base independently and are how a wrong rate gets caught. Order matters within a tier: the first
non-`legacy` entry is what unknown members of that tier are priced at. Mark superseded entries
`legacy: true` rather than deleting them — old sessions still need pricing. A model that publishes
fast-mode pricing also carries `fastInput`/`fastOutput` and a row in `FAST_RATE_CARD`; one that does
not must carry neither, since the same test asserts every other model has no fast rate at all.

**A new plan.** Add it to `PLANS` in `server/billing.js`. `test/billing.test.js` prices every plan at
several seat counts, so a malformed entry fails immediately.

**Anything about what the user pays.** The config is `{ periods: [...] }` — a plan *history*, not a
tier, because two months of Pro then three of Max is one cost that no single tier price describes.
Each period carries `planId`, `monthlyOverride`, `seats` and `months`, and `months: null` means "the
span the transcripts show". Keep that null distinct from a value that failed to parse: it is the
whole no-override case. One period always survives sanitising, so the editor is never empty, and the
pre-0.4 flat shape is read as a single period rather than dropped.

**A new cut of the data.** Add the bucket in `spendBreakdown` (`server/spend.js`), then a `CUTS`
entry and a renderer in `web/app.js`. The new bucket must sum to `total` — add it to the loop in
`test/spend.test.js` that asserts exactly that, and see invariant 1 on why "complete" and "sums" are
the same requirement.

**Anything in the session browser.** The rows are built in `web/app.js` from `bySession`, and the
filter box and list deliberately live outside the render tree: `render()` replaces `#root` wholesale,
so an input rebuilt per keystroke loses the caret on the first character. `paintSessions()` repaints
the list alone, and is what filtering, sorting and revealing all call. Note that `replaceChildren` is
the native DOM call rather than `h()`, so it will not skip a falsy child — it stringifies it, which
printed the word "false" in the footer once. Filter the array before spreading it.

**A new share platform.** Add it to `shareTargets` in `web/share.js` with an honest `prefills` flag,
and a `note` if it cannot take the text (Facebook and Instagram cannot). Add its host to the
assertion in `test/share.test.js`. Use a text label, never the platform's logo — a remote logo is a
network request this project does not make, and a bundled one ships somebody else's trademark under
our licence.

**Anything about the page.** `web/app.js` has no framework by design. `h('div.card', props, children)`
is the only builder; `render()` replaces the contents of `#root` wholesale. Do not introduce React,
a CDN script, or a build step — the CSP-free, install-free, single-`node`-command property is the
point of the project.

## Style

- **Refer to an invariant by its words, not its number.** The list gets inserted into, and a
  reference in another file does not move when it does — twice now a renumber has left `server/` and
  CI pointing at the wrong rule. "The *no network calls, ever* invariant" survives; "invariant 9"
  does not.
- **Nothing thrown while rendering may reach `render()`.** It empties `#root` before it rebuilds, so
  an exception raised while composing a panel leaves a blank application rather than a missing
  panel. The share panel did exactly that: `f.ratio` is null when there is no multiple to state, two
  of its four angles read `.toFixed` off it unguarded, and only an invariant held in two other
  modules kept the page up. Guard the value where it is read, not where it happens to be produced.
- **An empty view is a designed state, and there are three of them.** No `~/.claude/projects` at
  all, the directory with nothing in it, and real work. The middle one is a fresh Claude Code
  install and it used to fall through to the dashboard, which then rendered a comparison of zeros.
  `meta.found` alone does not distinguish them — `meta.sessions` is the other half. The same applies
  one level down: a cut with no rows returns a childless node so `whereItWent` can show its own
  empty state rather than drawing an empty chart.
- **Prose in the UI never points at a layout.** "The figure on the left" and "the one beside it"
  were accurate at desktop width and wrong below 720px, where the cells stack. Name the thing.
- **Text that carries information passes WCAG AA (4.5:1).** `--text-faint` is a hierarchy, not
  permission to become unreadable — it failed at 3.6:1 dark and 3.0:1 light while carrying the
  session facts line, the chart axis and every "N of M" footer. If a control says everything through
  a `title`, it also needs a text or ARIA equivalent: a hover is nothing on a touch screen.
- Comments explain **why**, especially where a plausible simpler version is wrong. Several comments
  here record a real bug; do not delete one without knowing which.
- Tests are named as sentences that state the rule, not `test('spendBreakdown works')`.
- Prose in the UI says what a number _is_, not what it might be. "API-equivalent" is not "cost", and
  a figure that had to guess says so where it is shown.
