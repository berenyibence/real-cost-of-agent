# Changelog

Notable changes, newest first. Dates are the day the change landed on `main`.

## 0.7.0 — 2026-08-20

Windows and macOS are supported platforms rather than platforms nobody had checked. Three things
here were quietly POSIX, and each of them was wrong on Windows in the way that is hardest to notice:
it printed a plausible answer instead of an error.

### Fixed

- **A Windows project directory decoded to a path that exists on no machine.** Claude Code names a
  project directory after the working directory it ran in, with the separators replaced by dashes —
  and on Windows the drive's colon goes the same way, so `C:\Users\dev\checkout` is written as
  `C--Users-dev-checkout`. Read by the POSIX rule, that came back as `C//Users/dev/checkout` and was
  shown in the by-project cut as if it were where the work happened.

  The decoder now reads the leading `<letter>--` and produces a Windows path. The **name** decides,
  not the platform doing the reading, so a `~/.claude` copied off a Windows machine — or read from
  WSL, which is the ordinary case for anyone running both — decodes the same either way.

- **A project's name was its whole path, read across platforms.** `path.basename` knows only the
  separators of the host it is running on: on Linux a backslash is an ordinary filename character,
  so `C:\Users\dev\checkout` has no last segment to take and comes back whole. The project column
  then carried somebody's home directory instead of a project name. Split on both separators now.

- **The preference file went to `~/.config` on Windows.** That is not where a Windows application's
  per-user settings belong, and it is not a directory OneDrive's profile sync follows — so the one
  file this app writes was the one file that would not travel with the profile it belonged to. It
  now goes to `%APPDATA%\real-cost-of-agent\config.json`.

  A plan saved by an older build in the old place is still **read**, and still never written, which
  is the same rule the rename to this project's name already followed. A reset here would be the
  quietest kind of harmless bug: the default plan is a *plausible* plan rather than a blank, so the
  page would keep showing a confident comparison against a subscription the user is not on, with
  nothing on screen to suggest checking.

- **`web/con` was the console, not a missing file.** Windows resolves a handful of device names in
  any directory, so a request for `/con` opened the terminal the server was started in and blocked
  on keyboard input — the request never finished and the user's own typing went to it. `/nul` was
  worse in the other direction: an empty 200, an asset that does not exist, served. Both are 404s
  now, on every platform, and what gets read is checked to be a regular file first.

- **The port-busy hint was not a command on Windows.** `PORT=4400 npm start` is shell syntax, not
  something this program does, and PowerShell does not have it. The hint now names the spelling for
  the platform it is printing on.

### Added

- **The smoke test is a test.** It used to be a shell block in the CI workflow, which meant the
  assertions most likely to differ by platform — path containment, how a URL decodes into a
  filename, whether the access rules are wired into the request path at all — were the ones only
  ever checked on Linux. [`test/smoke.test.js`](test/smoke.test.js) boots `server/index.js`, asks it
  for every route, and reads the headers back. It runs in `npm test`, so it runs on every OS in the
  matrix and on a contributor's own machine.

- **CI runs on Linux, macOS and Windows.** Windows across all three supported Node versions, macOS
  on one — it shares every path decision with Linux, so what is being checked there is the platform
  rather than the matrix. The tarball check runs on Windows too, where `npm` and the `bin` shim are
  both `.cmd` files that do not exist on Linux, and `npx real-cost-of-agent` goes through both.

- **[`test/platform.test.js`](test/platform.test.js)**, which asks every platform's question from
  whichever platform is running it. `resolveConfigDirs` takes the platform, the environment and the
  home directory as arguments for exactly that reason: a test that could only run on Windows would
  not have caught any of the above, because none of it was written on Windows.

- **`.gitattributes`.** `.editorconfig` asks editors for LF endings; this is the half that holds for
  git. Without it a Windows clone with `core.autocrlf=true` gets CRLF everywhere, which is mostly
  invisible and twice not: `server/index.js` is the published binary and its shebang stops being one
  the moment a carriage return lands on the end of it.

### Changed

- The shell block that was CI's `smoke` job is gone, replaced by the test file above. The tarball
  check moved from a shell block to [`scripts/package-check.mjs`](scripts/package-check.mjs) for the
  same reason — it now runs where the shims it is checking actually exist.

## 0.6.0 — 2026-08-19

The first public release. Everything below landed between the last tagged version and going public.

### Fixed

- **Subagent work was billed to nobody.** Claude Code gives every subagent its own transcript, one
  directory below the session that spawned it —
  `projects/<encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl`. Those lines carry their own
  `requestId` and their own `usage` block, because they were their own API calls. The scanner read
  only the top level of each project directory, so none of it reached any figure in the app.

  This is the same failure as the twelve-row session list below, in its most invisible form. That
  one at least had a heading you could hold against it; this had nothing at all — every cut still
  summed to the total, because the missing money never arrived in any of them. Nothing on the page
  was wrong-looking, and nothing could be. The error scales with how much you delegate, so the
  people it understated most were the ones using the feature hardest.

  Subagent transcripts are now folded into the session that spawned them, which is where their cost
  belongs: the same run, the same project, the same day. The session's own transcript keeps naming
  the row — a subagent's opening line is the task it was handed, not anything a person typed — and
  each subagent's requests become their own billing slice, so a Haiku search inside an Opus session
  is priced as Haiku rather than absorbed into the parent's rate. A subagent whose parent transcript
  has been deleted still gets counted, because a missing parent does not un-bill the work. See
  [`test/subagents.test.js`](test/subagents.test.js).

- **A fresh install got a dashboard of zeros instead of the empty state written for it.**
  `claudeCodeFound()` only ever meant "the directory is there", and Claude Code creates
  `~/.claude/projects` before it writes a transcript into it — as does clearing the folder out. In
  that state the page skipped its empty state entirely and rendered a comparison of nothing: six $0
  component rows, a chart with no columns under two blank axis labels, a plan panel arguing about
  zero, and a subtitle reading "0 sessions across 0 projects".

  There are three states, not two, and the two empty ones want different sentences: "I could not
  find where your transcripts live" is a different problem from "I found where they live and there
  are none yet", and only the first is worth mentioning `CLAUDE_HOME` for. Both are now written and
  both now fire. A cut with no rows at all also falls through to "Nothing to split here yet" rather
  than drawing an empty chart — reachable with real sessions on disk, if every one of them used a
  model nothing could price.

- **The one animation that ignored `prefers-reduced-motion`.** The blanket rule in `styles.css`
  flattens CSS animations and transitions, and cannot reach a scroll asked for in JavaScript. The
  header's share button now checks the preference before scrolling smoothly.

- **A gateway id in a session threw away the priceable work beside it.** `primaryModel` took the
  busiest slice outright, and when the catalog could not price it fell back to `session.model` —
  whichever id answered *last*, which on these sessions is the same unpriceable one. `modelSpec`
  came out null and the **whole session dropped to `unpriced`**, including every exactly-priceable
  Claude token in it.

  What made it a bug rather than a policy is that the answer turned on nothing meaningful: the same
  tokens across the same two models priced at **$0.00 or $27.51 depending only on which slice held
  more requests.** Busiest-is-unpriceable threw the session away; busiest-is-Opus priced it and
  folded the unknown slice onto Opus's rate. One of those had to be wrong, and request ordering
  picked which one you saw. The headline model is now the busiest one that *can* be priced, so a
  session is priced whenever any part of it is.

  The slices that still cannot be priced are folded onto that rate, which is a real assumption and
  is now declared as one: `fallbackPricedSessions` on the payload, a sentence in the caveats box, and
  a **borrowed rate** pill on the session row. It is counted separately from `inferredSessions`
  because it is a larger guess — an inferred rate at least had a tier in the id to reason from, this
  one borrows a rate from elsewhere in the same session. A session with nothing priceable in it is
  still excluded and still counted, exactly as before. See
  [`test/gateway-models.test.js`](test/gateway-models.test.js).

- **One bad clock deleted most of the by-day breakdown.** `spendBreakdown` built the day list by
  walking `eachDay(first, last)` and looking each date up, which quietly made the *axis* the
  authority on which days existed. `eachDay` stops after `MAX_SPAN_DAYS`, so a single transcript
  carrying a future timestamp — a skewed clock, or a `~/.claude` copied off a machine that had one —
  put the last day eleven years out and **dropped every real bucket past the cap: 71% of the total
  gone from that cut**, under a heading promising a breakdown, while every other cut still agreed
  with the total. Invariant 1 failing exactly the way the twelve-row session list used to.

  The buckets are the authority now and the filler is added around them, so a day that cost money
  cannot be absent whatever the axis manages to cover. Separately, the scanner refuses to record a
  session as having ended after now — the same treatment a session with no timestamps already gets —
  which also stops one skewed file swelling the payload from 3KB to half a megabyte of empty
  columns. See [`test/timestamps.test.js`](test/timestamps.test.js).

- **A plan could be made expensive enough to break the comparison.** `months` was capped from the
  start, with the reason written down; `seats` and `monthlyOverride` were not. A fat-fingered
  `1000000000` in the seats box produced a $360bn plan, and at 1e308 `planCost` overflowed to
  `Infinity` — at which point the two halves of the app told **different stories about the same
  config**: the page reported `api-ahead` with a difference of `-Infinity`, rendering as "costs —
  more than the usage", while `shareFacts` ran it through `finite()`, got 0, and the share card said
  no plan was set at all. Both are clamped now, the way months always was.

- **Auth detection sampled the wrong sixty files.** Telemetry filenames are UUIDs, so directory
  order has nothing to do with time, and `slice(0, 60)` took an arbitrary historical sample. For
  anyone who had switched from an API key to a subscription it got the answer flatly wrong — the
  tally requires `oauth >= apiKey`, so months of old key-authenticated telemetry outvoted the recent
  truth, and the page told them the list-rate figure was "what you were actually metered". It now
  samples newest-first.

- **The rescan button never re-read the telemetry.** `/api/billing?refresh=1` has existed to bust
  the auth cache since auth detection was written, and nothing ever called it — so a user who
  switched auth mode kept the old answer until they restarted the server. "Re-read transcripts" now
  re-reads that too.

- **One badly-typed model id emptied the entire index.** `lookupModel` called
  `String.prototype.replace` on whatever the transcript recorded, so a line carrying
  `"model": 12345` — which a proxy or a gateway is free to write — threw a `TypeError`. The throw
  did not stay local: `withEconomics` is mapped over every session in `store.js`, outside the
  scanner's per-transcript `try`, so **one malformed id anywhere on disk produced a page with
  nothing on it**. `inferTier` beside it had always coerced; the inconsistency was the bug. An
  unusable id is now excluded and counted in `unpriced`, which is what invariant 5 always said
  should happen to it, and `scan.js` refuses a non-string id at the point it reads vendor JSON.
  See [`test/malformed.test.js`](test/malformed.test.js).

- **The share panel could take the whole page down with it.** `f.ratio` is null whenever there is
  no usable multiple to state. `number` guarded that; the "Value" headline and the "Run rate"
  caption did not, and read `.toFixed` off it. Because the panel is built inside `render()`, the
  resulting `TypeError` escaped past `#root.replaceChildren()` and left a **blank application**
  rather than a missing panel. In the shipped app two other modules happen to guarantee a positive
  ratio there, which is exactly the kind of invariant that gets inherited by the next angle somebody
  adds. Both sites now say nothing rather than build a sentence out of a null.

- **The panel pointed at a layout instead of naming the figures.** "The figure on the left … the one
  beside it" describes a three-column grid, and below 720px those cells stack — so on a phone the
  sentence directed the reader at positions that were not there. It names the two figures now.

- **A clipped name had nowhere else to be read.** `.name` is `text-overflow: ellipsis`, and a
  session or project title wide enough to truncate appeared in full nowhere on the page. Every row
  now carries the untruncated name as its `title`.

- **The faintest text failed WCAG AA in both themes.** `--text-faint` was 3.6:1 on dark and 3.0:1 on
  light, against the 4.5:1 that normal-size text needs — and it is the tier carrying the session
  facts line, the chart axis, the footers and every "N of M" count. It is now 4.7:1 and 4.9:1. Faint
  is a hierarchy, not a licence to stop being readable.

- **The by-day chart said everything through hover.** The columns carry their date and amount in a
  `title`, which is nothing at all on a touch screen or to a screen reader. The chart is now a
  labelled `role="img"` stating the span, how many days ran, and the peak.

- **"By day" showed thirty columns and did not say so.** The chart windows to the most recent thirty
  days, which is right — sixty columns on a phone is a grey smear — but it was a truncation
  performed silently, under a heading that said "By day". On the index this was found against that
  was **$693 of $2,294, 30% of the money, with nothing on screen to indicate the chart was not the
  whole history.** It now carries the same footer the session list does, naming both figures.

- **A plan price could not have a decimal point in it.** The `$/mo` box is `type="number"`, which
  defaults to `step="1"` — so $17.00, a grandfathered rate, or any tier converted out of another
  currency loaded as an invalid value and had its decimals rounded away by the spinner arrows. The
  box that exists precisely because *published prices are not your price* would not accept most of
  the prices people actually pay. Seats and months still step by whole numbers, because those are
  whole things.

- **The page and the share card wrote the same number two ways.** The card has always grouped
  thousands — `$2,288` — and the page printed `$2288`. Money on the page is now grouped as well, and
  a negative figure no longer collapses to `<$0.01`, which is what an unsigned magnitude test made
  of every amount below zero.

- **"By session" showed twelve rows and called itself a breakdown.** Every other cut on the page
  re-splits the whole total; this one was capped at the twelve most expensive sessions, with nothing
  on screen to say so. On the index it was developed against that was **$1,231 of $2,261 — 45.5% of
  the money had no row anywhere in the application**, and the remaining 55 sessions could not be
  reached at all.

  This is invariant 1 failing quietly, which is the failure this project exists to catch: a column
  that answers a smaller question than its heading asks, and looks right while doing it. The cut is
  now every priced session, it sums to the total like the other four, and `test/spend.test.js`
  includes it in the loop that asserts exactly that — so the cap cannot come back without a test
  going red.

- **A resumed session reported its wall-clock gap as a duration.** First-to-last timestamp is not
  time spent: one session here spans twelve days because it was picked up again the following week,
  and the row printed `287h 54m` beside its request count, where it reads as twelve days of work. An
  elapsed figure is now shown only when it is one — within a single local day — and a session that
  crosses days shows the date range instead, which cannot be misread.

### Polish

- **A row with real money in it drew no bar.** The fill is a share of the largest row, and on a real
  index the small rows are tiny shares: Sonnet 5 at $0.94 beside Opus 5 at $1,543 came out **0.39px
  wide**, Haiku 4.5 at $0.10 came out **0.04px**. Both rendered as an empty track. There is a 2px
  floor now, and it stops where honesty does — a row that genuinely cost nothing keeps its empty
  track, because a stub there would claim spending that did not happen. The day chart had the
  mirror image of the same problem: its floor was 2% of a 98px column, almost exactly the height of
  the idle tick beside it, so colour alone separated "a little" from "nothing". That floor is 4px.

- **The cut's one-line explanation rendered as a meaningless stub.** The picker is five fixed
  buttons, so all the hint's slack comes out of the viewport: at 760px it had 100px to work with and
  showed `Output, input, th…` — 21% of the sentence. It now takes its own line below 880px rather
  than ellipsizing into nothing, and sits *under* the picker rather than above it, which also means
  a longer hint can no longer move the picker at all. The header is the same height on every cut at
  every width, which is what the ellipsis was originally protecting.

- **A widow on the share card.** Greedy wrapping broke the caption as "…on Claude Pro over 2" /
  "months.", stranding one word under a full line — the first thing anyone notices on an image meant
  to be looked at rather than read. The last word of the line above now comes down to join it,
  without changing the line count the vertical centring depends on.

- **Percentages that would not line up.** The share column under each dollar figure was
  proportional-figured while the figure above it was tabular, so right-aligning it lined up the `%`
  and nothing else.

- **A tooltip repeating text already fully on screen.** The untruncated name added for clipped rows
  was going onto the component labels too, which are written in this repo and always fit.

### Added

- **`npx real-cost-of-agent`.** The package is published now, with a `bin`, so the documented way in
  is one command that needs no clone and no install — zero dependencies means `npx` fetches a single
  ~100kB tarball. `--help` and `--version` answer the way an installed binary should, and the
  port-busy hint names whichever way you started it. `files` is an allowlist, so the tarball is the
  app and nothing else: no screenshots, no tests, no workflows. CI packs it, installs it elsewhere
  and serves every asset from there, because a file missing from that allowlist is invisible in a
  clone and broken for everybody arriving by `npx`.

- **The screenshots are shot against a generated sample.** They were stale — taken before money was
  grouped, before the by-day chart declared its window, before the bar floors existed — and they
  came off a real machine. The by-project and by-session cuts render directory and session names
  straight off disk, so a fixture removes the question entirely: every figure in `docs/` now comes
  from invented projects and invented prompts, and the README says so. The absence of a by-project
  or by-session shot is still a decision rather than a gap.

- **A Content-Security-Policy, so "no network calls" is enforced rather than promised.** Invariant 8
  has always been true of the source and has always been checkable only by reading it. It is now a
  header: `default-src 'self'` with `connect-src 'self'`, so a CDN script, a remote font, an
  analytics beacon or a `fetch` to anywhere but this server is refused by the browser rather than
  merely absent by convention. `frame-ancestors 'none'` closes the clickjacking half of the
  confused-deputy problem `access.js` already handles for fetches.

  The theme script moved out of `index.html` into `web/theme.js` to make this a flat
  `script-src 'self'` with no hash in it. A hash is the version that works until somebody edits the
  script and does not regenerate it, and this project has no build step that could. CI asserts both
  the header and the absence of an inline block.

- **The token counts behind every session's dollar figure.** Each row carries fresh input, output,
  cache reads and cache writes separately — four numbers because they are billed at four different
  multipliers, so a single "tokens" total would hide the entire reason two sessions of the same size
  cost different amounts. Searches appear as their own labelled count when a session ran any, since
  they are billed per search rather than per token.

  These are the measured quantities every price on the page is derived from, and printing them is
  what makes a row checkable rather than merely believable. A new test asserts they agree with the
  components cut, which splits the same tokens the other way.

- **The API request count per session**, which the scanner has always measured and the page has
  always thrown away. It is the denominator for what a single request cost, and the thing that makes
  a short session comparable to a long one.

- **Controls, so the list can afford to be complete.** A filter over session and project names, sort
  by cost, recency, output, total tokens or requests, and a reveal that starts at 25 rows. The footer
  states what is on screen and what it is out of, in both rows and dollars — the old list said
  neither, which is how twelve rows could look like the whole story.

- **The same token split on every bucket, so "by model" can say _why_.** A model row showing one
  dollar figure and a session count invites exactly one question and cannot answer it: output at
  twenty times the input rate and a cache being rebuilt rather than read are completely different
  stories that look identical in a single total. By model, by project and by day now all carry fresh
  input, output, cache read and cache write separately, and `tokens` is derived from that split
  rather than accumulated beside it, so the two cannot drift.

### Fixed (interface)

- **The sort control did not show which sort was selected.** `segmented` bakes the active id in when
  it builds, and the repaint only rebuilt the list — so clicking "Recent" reordered the rows while
  the highlight stayed on "Cost". The buttons are now rebuilt with the list.

- **"Show more" redrew bars that were already on screen.** The bar scale was taken from the visible
  slice, so revealing a row more expensive than anything above it rescaled the whole list and a
  figure the reader had already taken in silently changed length. The scale now comes from every row
  the filter matched. Filtering still rescales, and should — a filter changes the question, so it
  changes what "the biggest" means; revealing more of the same answer does not.

- **The cut picker jumped when you switched cuts.** The hints differ in length by a factor of three,
  and the longest pushed the picker onto a second row — one header stood 91px tall against 61px for
  every other cut. The hint now takes the slack and ellipsizes, with the full sentence on hover. The
  fix is a `0` flex basis rather than `auto`: with `flex-wrap`, line breaking is decided from each
  item's hypothetical size *before* anything shrinks, so an `auto` basis let the hint claim its full
  content width and wrap the picker before shrinking could happen.

- **The share card's footer read as a spec sheet.** "no account · no API key" is a list of things
  that are absent, which invites the question of why either was ever on the table. It now says
  "nothing to sign up for", which is what it was promising.

### Changed

- **"Saved" is the default share angle, ahead of "Value".** A dollar figure is the one number a
  reader understands without being told what it is a ratio *of* — a multiple has to be explained
  before it can land, and a post that needs a sentence of setup is a post nobody finishes. The card
  now opens on `$1,644` rather than `3.6×`.

- **The README leads with a result rather than a `git clone`.** It asked for a checkout of an unknown
  repository two lines before it gave a single number. The headline figures, the panel, and the
  2.45× line-counting trap now come first; the install block follows them. The by-model shot also
  comes out of the collapsed section, because a token split per model is the thing that makes the
  bill arguable rather than merely readable.

### Documentation

- **The screenshots were two releases stale**, showing a cut label that no longer exists ("What the
  tokens were") and missing the web search component entirely. All re-shot, with a new one for the
  session cut.

## 0.5.0 — 2026-08-10

Every dollar figure this app has ever printed was too high. This is the release that fixes it.

### Fixed

- **One API call is billed once, not once per content block.** Claude Code writes a single assistant
  turn as several transcript lines — one for the `thinking` block, then one per `tool_use` — and
  **every one of those lines carries a complete copy of the same `usage` object.** The reader summed
  usage line by line, so a request was charged once for each block it happened to contain. On the
  corpus this was found against that was 21,131 lines for 10,422 real calls, and the headline came
  out at **$6,091 against a true $2,490 — overstated by 2.45×.**

  The error scaled with tool use, so the heaviest sessions were the most wrong, and it ran in the
  direction that flatters the tool. Nothing on the page suggested checking: every breakdown summed
  to the total perfectly, because they were all splitting the same inflated number. `scan.js` now
  keys usage by `requestId` (falling back to `message.id`) per transcript and folds each call in
  once. A line carrying neither id is still counted on its own — an unidentifiable call happened
  too, and dropping it would be the same mistake pointing the other way.

  Anyone who has quoted a number from this tool should re-run it. `test/dedupe.test.js` is the
  fixture, copied from a real transcript.

- **Sonnet 5's introductory price had become its standard price, and the catalog had not noticed.** It
  was carried as $3/$15 with a $2/$10 promotion expiring 2026-08-31. Anthropic cancelled the
  scheduled rise and made $2/$10 permanent, which left the entry wrong in two directions: on
  2026-09-01 every Sonnet 5 session would have **silently repriced 50% higher**, with nothing on the
  page to explain the jump; and until then any unrecognised Sonnet id was already priced at the
  withdrawn $3/$15, because an inferred rate is the list rate. The published cache columns are what
  settle it — Sonnet 5's cache hit is $0.20/MTok, which is 0.1× of $2, not of $3.

  The whole rate card is now asserted against the published figures in `test/pricing.test.js`,
  base rates *and* cache columns, so a base that disagrees with its own cache column cannot pass.
  A third test rejects any entry whose price depends on what day it is read. Verified against
  platform.claude.com on 2026-08-11; the cache multipliers (1.25× / 2× / 0.1×) were already exact.

- **A model is not the whole rate, and two of the three things that move it were being read past.**
  The catalog answered "what does Opus 5 cost" and that answer was applied to every Opus 5 request.
  But the same request costs a different amount depending on fields the transcript already records:

  - **Fast mode is billed at its own published rate, not the standard one.** `/fast` runs Opus 5 and
    Opus 4.8 at $10/$50 instead of $5/$25 — **exactly double** — and every request that used it
    records `speed: "fast"` in its usage. Pricing those off the standard column halves them. This is
    the same class of error as the per-line one above and a single keystroke away from any user's
    figures: it was invisible here only because this machine's 21,383 priced requests are all
    `standard`. The cache multipliers stack on the fast base, so a 1h write on fast Opus 5 is 2× of
    $10. A model with no published fast rate ignores the flag, which is what the API does too.
  - **US-pinned inference costs 1.1× on every category**, cache reads and writes included, and is
    recorded as `inference_geo`. Anything that is not `"us"` is standard, so an ordinary account's
    `not_available` cannot inflate anything.

  A usage slice is now keyed by the model **and** these terms, because a session that toggled
  `/fast` mid-run is one model at two prices; `componentsOf` decomposes each slice at the rate it was
  billed at, so the columns cannot drift from the total the way they did in 0.5.0's other fix.
  `test/rates.test.js` prices a fixture transcript that mixes all of it, end to end.

  Deliberately not modelled, and now written down in `models.js`: `service_tier`. Batch is 50% off
  and priority publishes no multiplier at all, and neither can reach a Claude Code transcript.
  Reading an unrecognised tier as standard can only overstate, which is the direction to err in.

- **Web search was money spent on this machine that no figure mentioned.** Server-side search is
  $10 per 1,000 searches on top of the tokens the results become, and it arrives as a count in
  `server_tool_use` rather than as tokens — so a total assembled from token counts omits it, and
  omits it silently. It is now a component of its own, in searches rather than tokens, so it is
  inside the total that every breakdown has to sum to. Web fetch sits in the same block and is
  published at no charge; charging for it would be inventing a rate.

  Component rows accordingly carry `count` and `unit` where they carried `tokens`. The token columns
  still total tokens: a per-search charge folded into "output" would balance the books and misstate
  what was bought.

- **Claude Haiku 3.5 is in the catalog** at its published $0.80/$4. It was falling through to the
  Haiku tier default and being charged at Haiku 4.5's $1/$5 — 25% over. Flagged as inferred, so not
  silent, but there is no reason to guess at a rate that is published. Marked `legacy`, so it never
  becomes what an unknown Haiku is priced at. Note the id order: `claude-3-5-haiku`.

- **The by-day chart no longer draws a fortnight's gap the same width as a night's.** `byDay` only
  had rows for days something ran, so scattered sessions were rendered as if they were consecutive.
  It now carries a row per calendar day across the span, idle days included, drawn as a baseline
  tick rather than a stub that reads as a little bit of spend. The filled rows cost zero, so every
  breakdown still sums to the total. The chart also scales to the maximum of the thirty days it is
  showing rather than of all history, which had made the visible bars a fraction of their height
  with nothing on screen to explain why.

### Added

- **The server checks who is talking to it** (`server/access.js`). There is no authentication and
  there should not be, but a local page with none is still reachable by any site you happen to be
  visiting, and `/api/spend` carries project names, working directories and session titles. A `Host`
  header naming a domain is refused, which ends DNS rebinding — a browser cannot be induced to send
  a host it did not resolve. A cross-site `Origin` is refused, which ends the silent plan rewrite
  that `POST /api/billing` was open to, since `content-type: text/plain` makes it a CORS *simple*
  request that no preflight protects. Loopback names and bare IP literals still pass, so
  `HOST=192.168.1.5` keeps working.

### Changed

- The plan editor's "saved" is a confirmation again rather than a permanent fixture: it clears after
  a couple of seconds, and does so without a re-render that would take the caret out of the next
  box. A preference that fails to write now says so in that same line instead of replacing the whole
  page with "the server did not answer" while every figure on screen is still good.
- Model ids are escaped before being interpolated into markup. They are the one string on the page
  that comes from a file rather than from this repository.
- The segmented pickers carry `aria-pressed`, and the two status lines are `aria-live`. Which cut is
  selected was obvious to look at and invisible otherwise.
- The parsed-transcript cache is keyed by path rather than by session id, and forgets files that
  have left the disk. Two project directories are free to contain the same session id, and the
  server is long-lived.
- A malformed percent-escape in a URL is a 400 rather than a 500.

## 0.4.0 — 2026-08-10

The plan stopped being a tier and became a history.

### Added

- **A months override per period.** Leave it empty and the transcripts decide the length, exactly as
  before. Type a number and it wins — which is the answer as soon as the history is incomplete, and
  it usually is: the app can only see the transcripts on _this_ machine, so a reinstall, a second
  laptop or a cleaned-out `~/.claude` all make the detected span shorter than what was actually paid
  for.
- **As many plan periods as the history needs.** Two months of Pro then three of Max 20× is $640
  over five months, and no single tier price says so. Each row carries its own tier, price override,
  seat count and length; rows can be added and removed, and one is always kept so the editor is never
  empty. `compareBilling` reports every period priced, their total, and a `planLabel` naming each
  distinct tier — "Claude Pro + Claude Max 20×" rather than whichever one happened to be first.
- **`spanMismatch`.** When the declared plan covers a different stretch of time from the transcripts,
  the page says so. It is usually the point of the override rather than a mistake, but the two sides
  of the comparison are then measuring different spans and a reader should not have to infer that
  from the numbers.

### Changed

- The stored config is now `{ periods: [...] }`. A pre-0.4 file is read as a single period rather
  than discarded — losing it would silently reset the plan to a default that is a plausible plan
  rather than a blank, and the page would go on showing a confident comparison against a subscription
  nobody is on.
- `POST /api/billing` takes `periods` to replace the list. The flat `planId` / `monthlyOverride` /
  `seats` fields still edit the first period, so anything written against the old endpoint keeps
  working.
- The share card names every tier in the history, counts the declared months rather than the
  transcript span for the plan clause, and says "on average" when quoting a monthly price blended
  across periods — a figure that is on nobody's invoice should not be presented as one.

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
