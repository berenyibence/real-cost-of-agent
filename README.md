<div align="center">

<img src="web/brand/mark.svg" width="72" height="72" alt="" />

# Real Cost of Agent

**What your agent would have cost.**

One local page that prices the transcripts Claude Code already writes to your disk.
No account, no API key, no build step, no dependencies — and nothing leaves your machine.

[![CI](https://github.com/berenyibence/real-cost-of-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/berenyibence/real-cost-of-agent/actions/workflows/ci.yml)
[![Licence](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.11-green.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

</div>

---

```bash
git clone https://github.com/berenyibence/real-cost-of-agent.git
cd real-cost-of-agent
node server/index.js
```

Then open **http://127.0.0.1:4319**.

That is the whole setup. There is no `npm install`, because there is nothing to install.

---

## The number nobody shows you

Claude Code writes a transcript of every session to `~/.claude`, and every assistant reply in it
carries the exact token counts the API measured — input, output, cache reads, cache writes, per
model, per request. The billing was done from those numbers. Almost nobody adds them up.

This does, and then compares it against what you pay.

![The plan-versus-list-rates panel](docs/screenshots/plan-vs-list-rates.png)

**Two prices, not two invoices.** Nothing in `~/.claude` records what you were charged. The
transcripts carry token counts and a `service_tier`; no field anywhere names a dollar, a credit or an
invoice. So both figures are computed, and the page says so next to them rather than in a footnote:

- **The left-hand number** is your recorded tokens at published list rates.
- **The middle number** is the plan price _you_ entered, times the months your transcripts span. Your
  tier is not on disk anywhere and published prices change, so it is editable rather than asserted.
- **Auth mode is detected**, from the beta set Claude Code records in local telemetry. That tells you
  which of the two figures is the hypothetical one. It does not tell you what you were billed, and
  the page no longer pretends otherwise.

**The verdict can go against the plan.** When your usage does not justify what you pay, the panel
says so and points at metered API billing — same voice, same size, same prominence as when it goes
the other way. A tool that can only ever conclude "your subscription is excellent" is an
advertisement.

**Where the money went.** The headline number is the top of a tree. Each cut re-splits the same
dollars a different way, so a figure can be opened until it stops being a mystery:

![What the tokens were, split five ways](docs/screenshots/where-the-money-went.png)

| Cut                  | Answers                                                    |
| -------------------- | ---------------------------------------------------------- |
| What the tokens were | Output, fresh input, cache reads, and 5m / 1h cache writes |
| By model             | Which models the money went to                             |
| By project           | Which codebases cost the most                              |
| By day               | When the spend happened                                    |
| By session           | The individual runs that dominate                          |

<details>
<summary><b>More cuts, and the light theme</b></summary>

<br />

![By model](docs/screenshots/by-model.png)

![By day](docs/screenshots/by-day.png)

![The same panel in the light theme](docs/screenshots/light-theme.png)

</details>

**What the total leaves out.** Two caveats travel with the figure rather than being buried: sessions
priced at their tier's rate because the exact model id is not in the catalog, and sessions excluded
entirely because no rate could be found — with the token count they represent, so you can tell a
footnote from a hole.

## Share it

Most people have no idea what their agent use is worth. The page will build the post for you — a
card image and the words to go with it — for X, Bluesky, LinkedIn, Threads, Reddit, Hacker News,
Facebook and Instagram.

![The share panel](docs/screenshots/share-panel.png)

**Four angles, because the same numbers persuade different people for different reasons.** Picking
one rewrites the words and the headline on the card together, so they can never contradict each
other:

| Angle         | The question it answers                                          | Best for                            |
| ------------- | ---------------------------------------------------------------- | ----------------------------------- |
| **Value**     | What did every $1 of plan actually buy?                          | A large multiple — often Pro at $20 |
| **Saved**     | How many dollars of work was I never billed for?                 | The number people repeat            |
| **Run rate**  | What would this habit cost per month if I paid per token?        | Deciding whether Max at $200 is worth it, or whether metered is even affordable |
| **Breakdown** | Where did it actually go — output, or cache?                     | A technical audience                |

Every angle names the gap, and **every angle survives it running the other way.** If your plan cost
more than your usage was worth, the card says that instead — the "Saved" angle inverts to what the
plan cost above metered rates. There is no combination of settings that produces a saving you did not
make.

Two more things are true of the panel, and both are deliberate:

- **Nothing is posted by this page.** Each button opens that platform's own composer in a new tab
  with the text already in it. The post is still yours to edit, or to abandon. Those links are the
  only thing in this project that points off your machine.
- **Only aggregates can travel.** The share panel is handed a fixed set of numbers — the total, your
  plan's name and price, the month count, how many sessions and projects, and the percentage split.
  Project names, file paths and session titles are not in the data it receives, so no amount of
  editing can put them in a post. That boundary is one function in [`web/share.js`](web/share.js),
  and [`test/share.test.js`](test/share.test.js) asserts it against a payload seeded with paths in
  every field that has one, across every angle.

The image is painted on a canvas in your browser and saved with **Download image**, at 1200×630 for
X, LinkedIn and Facebook, or 1080×1350 and 1080×1080 for Instagram and Threads.

## Requirements

- **Node 20.11 or newer.** Nothing else.
- **Claude Code, run at least once**, so there are transcripts to read. If there are none, the page
  says so and names the directory it looked in.

## What it touches

| Path                                        | Access     | Why                                             |
| ------------------------------------------- | ---------- | ----------------------------------------------- |
| `~/.claude/projects/**/*.jsonl`             | read       | token usage per request, per model              |
| `~/.claude/telemetry/*.json`                | read       | whether you authenticate by OAuth or an API key |
| `~/.config/real-cost-of-agent/config.json`  | read/write | your plan, its price, and seat count            |

**Nothing leaves your machine.** The server binds to loopback and makes no outbound request of any
kind — the only HTTP traffic is your browser talking to `127.0.0.1`. If the page is showing a number,
it came off your own disk. The share links are the single exception, and they are exactly that:
links, which do nothing until you click one.

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
tests will tell you if you break the arithmetic. That is [the most useful pull request you can
send](CONTRIBUTING.md#the-most-useful-contribution).

## Tests

```bash
npm test
```

Node's built-in runner, no framework. The suite covers the pricing rules, the plan arithmetic, the
config sanitiser, the share boundary, and an end-to-end pass over a fixture transcript. The property
that matters most is asserted directly: **every breakdown adds up to the same total.** A column that
quietly uses different arithmetic from the number above it is the worst way for a money view to be
wrong, because nothing on screen suggests you should check.

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
  share.js    the share card: the aggregate allowlist, the words, the canvas
  styles.css  design tokens and components, light and dark
  brand/      the mark, the lockup, and the repository's social preview
```

## Contributing

Yes, please — start with [CONTRIBUTING.md](CONTRIBUTING.md). Model prices move constantly and a
one-line catalog update is a genuinely valuable pull request. The house rules that matter most are
short: no dependencies, no build step, no network calls, and every breakdown has to add up.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security issue,
see [SECURITY.md](SECURITY.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE).

**Not affiliated with Anthropic.** Claude and Claude Code are trademarks of Anthropic. This is an
independent tool that reads files Claude Code writes locally, and the prices in it are a
hand-maintained copy of published rates — always check your real invoice before treating any figure
here as authoritative.
