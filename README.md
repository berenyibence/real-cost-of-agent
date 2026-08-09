# Agent Spend

**What your Claude Code sessions cost, where the money went, and whether you actually paid it.**

One local page. No account, no API key, no build step, and no dependencies — it reads the transcripts
Claude Code already writes on your machine and prices them.

```bash
node server/index.js
```

Then open **http://127.0.0.1:4319**.

That is the whole setup. There is no `npm install`, because there is nothing to install.

---

## What you get

**Subscription vs API.** The same tokens mean different things on different meters, so the page
refuses to print one number:

- **Auth mode is detected, not assumed.** Claude Code records its beta set in local telemetry, and
  the presence of the OAuth beta means subscription authentication.
- **On a subscription, API credits spent is $0** — and the page says so plainly. The token figure is
  what the work _would_ have cost on the API: value received, not money charged.
- Set your plan, and the page compares its price over the period against the API-equivalent spend to
  give the effective multiple. Your plan tier is not recorded anywhere on disk, and published prices
  change — so both are editable rather than asserted as fact.

**Where the money went.** The headline number is the top of a tree. Each cut re-splits the same
dollars a different way, so a figure can be opened until it stops being a mystery:

| Cut                   | Answers                                                            |
| --------------------- | ------------------------------------------------------------------ |
| What the tokens were  | Output, fresh input, cache reads, and 5m / 1h cache writes          |
| By model              | Which models the money went to                                     |
| By project            | Which codebases cost the most                                      |
| By day                | When the spend happened                                            |
| By session            | The individual runs that dominate                                  |

**What the total leaves out.** Two caveats travel with the figure rather than being buried: sessions
priced at their tier's rate because the exact model id is not in the catalog, and sessions excluded
entirely because no rate could be found — with the token count they represent, so you can tell a
footnote from a hole.

## Requirements

- **Node 20.11 or newer.** Nothing else.
- **Claude Code, run at least once**, so there are transcripts to read. If there are none, the page
  says so and names the directory it looked in.

## What it touches

| Path                                | Access     | Why                                            |
| ----------------------------------- | ---------- | ---------------------------------------------- |
| `~/.claude/projects/**/*.jsonl`      | read       | token usage per request, per model             |
| `~/.claude/telemetry/*.json`         | read       | whether you authenticate by OAuth or an API key |
| `~/.config/agent-spend/config.json`  | read/write | your plan, its price, and seat count            |

**Nothing leaves your machine.** The server binds to loopback and makes no outbound request of any
kind — the only HTTP traffic is your browser talking to `127.0.0.1`. If the page is showing a number,
it came off your own disk.

## Configuration

Every setting is an environment variable, and every one has a working default:

```bash
PORT=4400 node server/index.js          # default 4319
HOST=127.0.0.1 node server/index.js     # loopback; change at your own risk
CLAUDE_HOME=/path/to/.claude npm start  # read someone else's export, or a backup
XDG_CONFIG_HOME=~/.config npm start     # where this app stores your plan
```

Ports 4317 and 4318 are OpenTelemetry's collector defaults and are often already taken on a machine
that runs agents, which is why the default here is 4319.

## How the money is worked out

Every figure comes from the `usage` block the API returned on each assistant reply — measurements
taken by the thing that was billed, not an estimate made afterwards by counting characters.

- **Rates are per model, in `server/models.js`.** They are USD per million tokens as published for
  the first-party Anthropic API. Partner platforms (Bedrock, Vertex) price separately and are not
  modelled.
- **Cache traffic is billed at its real multipliers**: reads at 0.1×, 5-minute writes at 1.25×,
  1-hour writes at 2×. The transcript records the TTL split per request, so this is computed rather
  than assumed. When a write carries no split it is attributed to 5m — the cheaper TTL, so an
  unknown can never inflate the bill.
- **A session is priced per model, not as one.** Switching mid-run is ordinary and the tiers differ
  by up to 2×, so each slice of a session is priced at its own rate.
- **A model the catalog has not heard of is priced at its tier's list rate and flagged as inferred.**
  A confident $0 for a model that shipped last week is the one error that reads as good news, so it
  is not an option here.

Prices change. Edit the `CATALOG` in `server/models.js` when they do — it is a plain object, and the
tests will tell you if you break the arithmetic.

## Tests

```bash
npm test
```

Node's built-in runner, no framework. The suite covers the pricing rules, the plan arithmetic, the
config sanitiser, and an end-to-end pass over a fixture transcript. The property that matters most is
asserted directly: **every breakdown adds up to the same total.** A column that quietly uses
different arithmetic from the number above it is the worst way for a money view to be wrong, because
nothing on screen suggests you should check.

## Layout

```
server/
  index.js    HTTP: three read routes, one write route, static files
  scan.js     reads ~/.claude transcripts → sessions with token counts
  store.js    the in-memory index, and pricing applied to it
  models.js   the model catalog: rates, context windows, cache multipliers
  spend.js    the breakdown — the same dollars, split five ways
  billing.js  subscription vs API: plans, auth detection, the comparison
  day.js      local calendar days, so an evening session is filed today
  paths.js    where this app keeps its one preference file
web/
  index.html  the page
  app.js      the page's behaviour — plain DOM, no framework
  styles.css  design tokens and components, light and dark
```

## Licence

Apache-2.0. See [LICENSE](LICENSE).
