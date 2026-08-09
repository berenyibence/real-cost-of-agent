# Agent Spend — notes for agents

A single local page that prices Claude Code's own transcripts. One HTTP server, one page, **zero
dependencies**, no build step, no bundler, no framework.

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
| `server/scan.js`    | **everything that knows what a Claude Code transcript looks like**        |
| `server/store.js`   | the cached index, and `withEconomics` — pricing applied to a session      |
| `server/models.js`  | the catalog: rates, context windows, cache multipliers, tier inference    |
| `server/spend.js`   | `spendBreakdown` — one set of dollars split five ways                     |
| `server/billing.js` | plans, config sanitising, OAuth-vs-API detection, the comparison          |
| `web/app.js`        | the page. `h()` builds DOM; `render()` rebuilds it from `state`           |

The layering is worth preserving: `scan.js` is the only module that parses vendor JSON, and
`models.js`/`spend.js` are pure arithmetic over normalized numbers. Adding a second agent's
transcripts should mean writing one new scanner, not touching the pricing.

## Invariants — break one of these and the page lies

1. **Every breakdown sums to the total.** `components`, `byModel`, `byProject` and `byDay` each
   re-split the same dollars. `test/spend.test.js` and `test/scan.test.js` both assert it. A column
   using different arithmetic from the number above it is the failure mode this app exists to avoid.
2. **A session is priced per model slice**, never at whichever model answered last. Tiers differ by
   up to 2×.
3. **An unknown model is never priced at $0.** If the id names a tier it is priced at that tier's
   list rate and flagged `inferred`; if it names nothing usable it is excluded and _counted_ in
   `unpriced`, with its token total, so the page can say what it left out.
4. **An inferred rate is the list rate, never a promotion.** A promotion applies to one named model
   for one stated period; extending it to an unpublished id invents a discount.
5. **Cache writes keep their TTL split** (1.25× for 5m, 2× for 1h). A write with no split recorded
   goes to 5m — the cheaper one, so an unknown cannot inflate a bill.
6. **Days are local days** (`server/day.js`). `toISOString().slice(0, 10)` files an evening session
   under tomorrow east of Greenwich.
7. **No network calls, ever.** Nothing in this repo opens a socket outbound, and the README promises
   that. It is not a detail to trade away for a feature.
8. **Only one file is ever written**: `~/.config/agent-spend/config.json`. `~/.claude` is read-only
   here — it belongs to Claude Code.

## Common changes

**A new model, or a price change.** Edit `CATALOG` in `server/models.js`. Order matters within a
tier: the first non-`legacy` entry is what unknown members of that tier are priced at. Mark
superseded entries `legacy: true` rather than deleting them — old sessions still need pricing.

**A new plan.** Add it to `PLANS` in `server/billing.js`. `test/billing.test.js` prices every plan at
several seat counts, so a malformed entry fails immediately.

**A new cut of the data.** Add the bucket in `spendBreakdown` (`server/spend.js`), then a `CUTS`
entry and a renderer in `web/app.js`. The new bucket must sum to `total` — add it to the loop in
`test/spend.test.js` that asserts exactly that.

**Anything about the page.** `web/app.js` has no framework by design. `h('div.card', props, children)`
is the only builder; `render()` replaces the contents of `#root` wholesale. Do not introduce React,
a CDN script, or a build step — the CSP-free, install-free, single-`node`-command property is the
point of the project.

## Style

- Comments explain **why**, especially where a plausible simpler version is wrong. Several comments
  here record a real bug; do not delete one without knowing which.
- Tests are named as sentences that state the rule, not `test('spendBreakdown works')`.
- Prose in the UI says what a number _is_, not what it might be. "API-equivalent" is not "cost", and
  a figure that had to guess says so where it is shown.
