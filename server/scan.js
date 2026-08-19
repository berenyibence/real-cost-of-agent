/**
 * Reading Claude Code's own record of what it did.
 *
 * Claude Code appends one JSON object per line to a transcript per session:
 *
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *
 * Every assistant reply in there carries the `usage` block the API returned for
 * that request. That block is the entire basis of this app: the token counts are
 * measurements taken by the thing that was billed, not estimates made afterwards
 * by counting characters.
 *
 * **A session is more than one file.** A subagent gets its own transcript, one
 * directory down:
 *
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl
 *
 * Those lines carry their own `requestId` and their own `usage`, because they
 * were their own API calls — billed, and frequently to a different model from
 * the one the parent was using. Reading only the top level therefore drops that
 * money on the floor, and it is the invariant-1 failure with no symptom: the
 * cuts still sum to the total, because the missing work never reaches any of
 * them. See `transcriptsUnder`.
 *
 * One API call is not one line either, and that distinction is load-bearing —
 * see `requests` in `parseTranscript`.
 *
 * Only what pricing needs is read. Transcripts routinely pass 10MB, so they are
 * streamed line by line, and a parsed summary is memoised on mtime+size — a
 * transcript that has not changed is never read twice.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

export const CLAUDE_DIR = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

/** Whether there is anything on this machine to read at all. */
export function claudeCodeFound() {
  return fs.existsSync(PROJECTS_DIR);
}

const EMPTY_USAGE = () => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  // Cache writes are billed at different multipliers by TTL (1.25x for 5m, 2x
  // for 1h), so the split is tracked separately rather than as one number.
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  // Not a token count, and the only charge here that no token count can find:
  // server-side web search is billed per search ($10 per 1,000) on top of the
  // tokens the results become.
  webSearchRequests: 0,
});

/**
 * Absolute transcript path -> { key, summary }, where key is `${mtimeMs}:${size}`.
 *
 * Keyed by path rather than by session id: the id is a filename, and two
 * project directories are free to contain the same one. Unlikely with UUIDs,
 * and silently fatal if it ever happened — one project's costs would be served
 * for another's.
 */
const summaryCache = new Map();

function ts(value) {
  if (!value) return 0;
  const n = Date.parse(value);
  return Number.isNaN(n) ? 0 : n;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/**
 * A model id, or null if the transcript recorded something that is not one.
 *
 * The pricing modules are total over any input now, but garbage should not get
 * this far in the first place: `scan.js` is the only thing here that reads
 * vendor JSON, so it is the right place to insist a model id is a string.
 * `<synthetic>` is Claude Code's marker for a line it generated itself rather
 * than something the API answered, and it names no model to price.
 */
function modelId(value) {
  return typeof value === 'string' && value && value !== '<synthetic>' ? value : null;
}

function truncate(str, max) {
  if (!str) return '';
  const clean = String(str).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Stream one transcript, keeping only what a cost figure is made of. */
async function parseTranscript(file) {
  const summary = {
    cwd: null,
    model: null,
    customTitle: null,
    aiTitle: null,
    firstPrompt: null,
    startedAt: 0,
    endedAt: 0,
    usage: EMPTY_USAGE(),
    /**
     * Usage split by what each request was billed as: the model that served it,
     * **and** the two request-level terms that change its rate.
     *
     * A session is not one model. Switching mid-run is common, and the tiers
     * differ by up to 2x, so pricing a whole session at whichever model happened
     * to answer last is not a rounding error — on the largest sessions it is out
     * by tens of percent, in whichever direction the last model pointed.
     *
     * Nor is a session one rate for a given model. `/fast` bills Opus 5 at
     * $10/$50 instead of $5/$25 and can be toggled mid-run, and US-pinned
     * inference adds 1.1x, so one model can appear in two slices at two prices.
     * Keying on the model alone collapsed them onto whichever rate the catalog
     * lists, which halves a fast request.
     */
    usageByModel: new Map(),
    peakContext: 0,
    requests: 0,
  };

  /**
   * One entry per API request — **not** per line.
   *
   * Claude Code writes a single assistant turn as one line per content block: a
   * line for the `thinking` block, then a line for each `tool_use`. Every one of
   * those lines carries a complete copy of the *same* `usage` object, because
   * they all came back from one API call.
   *
   * So summing usage line by line bills a request once per content block it
   * happened to contain. On the transcripts this was written against that was
   * 21,131 lines for 10,422 real requests, and the headline figure came out at
   * $6,091 against a true $2,490 — **overstated by 2.45x**, in the direction
   * that flatters the tool, with nothing on the page to suggest it. It is the
   * exact failure this app exists to catch, and it was in the reader.
   *
   * `requestId` is Claude Code's id for the call, `message.id` is the API's;
   * either identifies a request uniquely. Deduplication is per transcript,
   * because a transcript is a session and a session's cost is its own. A line
   * carrying neither id is counted on its own rather than dropped — an
   * unidentifiable request still happened.
   *
   * Later lines overwrite earlier ones, so a torn or partial first block can
   * never outweigh the finished usage for the same call.
   */
  const requests = new Map();
  let anonymous = 0;

  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue; // a torn last line while the agent is mid-write
      }

      const at = ts(evt.timestamp);
      if (at) {
        if (!summary.startedAt || at < summary.startedAt) summary.startedAt = at;
        if (at > summary.endedAt) summary.endedAt = at;
      }
      summary.cwd ||= evt.cwd ?? null;

      switch (evt.type) {
        case 'custom-title':
          summary.customTitle = evt.customTitle ?? summary.customTitle;
          break;
        case 'ai-title':
          summary.aiTitle = evt.aiTitle ?? summary.aiTitle;
          break;
        case 'user': {
          // The opening prompt, purely as a name for the row. Tool results come
          // back as user messages too and are not something anybody typed.
          const isToolResult =
            Array.isArray(evt.message?.content) &&
            evt.message.content.some((b) => b?.type === 'tool_result');
          if (!isToolResult) summary.firstPrompt ||= textOf(evt.message?.content) || null;
          break;
        }
        case 'assistant': {
          const msg = evt.message ?? {};
          const named = modelId(msg.model);
          if (named) summary.model = named;
          const u = msg.usage;
          if (!u) break;
          // Resolved here rather than in the fold below, because `summary.model`
          // moves as the file is read: a synthetic line belongs to the model
          // that was answering at the time, not to whichever answered last.
          const model = named ?? summary.model ?? 'unknown';
          requests.set(evt.requestId ?? msg.id ?? `anon:${anonymous++}`, { model, usage: u });
          break;
        }
        default:
          break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  /**
   * Everything from here counts each API call exactly once.
   *
   * `usage.iterations` is read past deliberately. It is an array of per-attempt
   * usage for server-side refusal fallbacks, and on every one of the 21,383
   * priced requests in the real index here it holds exactly one `message` entry
   * that repeats the top-level block — Claude Code does not pass `fallbacks`, so
   * there is never a second attempt to price. If one ever appears, the entries
   * carry no model id, and the fallback model's rate is what the extra attempt
   * would have to be priced at: unknowable from the line, so guessed at or left
   * out. Left out, and written down here so the next reader knows it was looked
   * at rather than missed.
   */
  for (const { model, usage: u } of requests.values()) {
    summary.usage.inputTokens += u.input_tokens ?? 0;
    summary.usage.outputTokens += u.output_tokens ?? 0;
    summary.usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    const written = u.cache_creation_input_tokens ?? 0;
    summary.usage.cacheWriteTokens += written;
    // The TTL split decides the billing multiplier. When the breakdown is
    // absent, attribute to 5m — the cheaper, default TTL, so an unknown never
    // inflates the bill.
    const oneHour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const fiveMin = u.cache_creation?.ephemeral_5m_input_tokens ?? written - oneHour;
    summary.usage.cacheWrite1h += oneHour;
    summary.usage.cacheWrite5m += Math.max(0, fiveMin);
    const searches = u.server_tool_use?.web_search_requests ?? 0;
    summary.usage.webSearchRequests += searches;

    /**
     * The same numbers again, kept apart by what they were billed as.
     *
     * `speed` and `inference_geo` are part of the key, not just the model: two
     * requests to Opus 5 cost different amounts if one of them ran under
     * `/fast`, so folding them together would price one of the two wrongly no
     * matter which rate won. Web fetch is deliberately absent — it is recorded
     * next to web search in `server_tool_use` and published at no charge.
     */
    const speed = u.speed === 'fast' ? 'fast' : 'standard';
    const inferenceGeo = u.inference_geo === 'us' ? 'us' : 'global';
    const key = `${model}|${speed}|${inferenceGeo}`;
    const slice =
      summary.usageByModel.get(key) ??
      summary.usageByModel
        .set(key, { model, speed, inferenceGeo, ...EMPTY_USAGE(), requests: 0 })
        .get(key);
    slice.requests += 1;
    slice.inputTokens += u.input_tokens ?? 0;
    slice.outputTokens += u.output_tokens ?? 0;
    slice.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    slice.cacheWriteTokens += written;
    slice.cacheWrite1h += oneHour;
    slice.cacheWrite5m += Math.max(0, fiveMin);
    slice.webSearchRequests += searches;

    // Everything the model read this turn — the context-window measure.
    const turnContext = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + written;
    if (turnContext > summary.peakContext) summary.peakContext = turnContext;
    summary.requests += 1;
  }

  return summary;
}

/**
 * Claude Code slugifies the cwd by replacing separators with dashes, which is
 * lossy: `-home-dev-my-app` could be `/home/dev/my-app` or `/home/dev/my/app`,
 * and nothing in the name says which. Used only when a transcript carries no
 * `cwd` of its own.
 */
function decodeProjectDir(dirName) {
  return dirName.replace(/^-/, '/').replace(/-/g, '/');
}

function titleFor(summary, sessionId) {
  return (
    summary.customTitle ||
    summary.aiTitle ||
    truncate(summary.firstPrompt, 80) ||
    `Session ${sessionId.slice(0, 8)}`
  );
}

async function summarise(file) {
  const stat = await fsp.stat(file);
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = summaryCache.get(file);
  if (hit && hit.key === key) return hit.summary;

  const summary = await parseTranscript(file);
  // A transcript with no timestamps still happened; the file's own mtime is the
  // best evidence of when, and a session with no date at all falls out of the
  // by-day breakdown entirely.
  if (!summary.endedAt) summary.endedAt = stat.mtimeMs;
  if (!summary.startedAt) summary.startedAt = stat.mtimeMs;

  /**
   * Nothing ran in the future.
   *
   * A skewed clock, or a `~/.claude` copied off a machine that had one, writes
   * timestamps ahead of now — and one of them stretches the by-day axis to
   * wherever it points. `spendBreakdown` no longer drops buckets when that
   * happens, but it would still fill years of empty columns and swell the
   * payload from 3KB to half a megabyte, so the honest reading is applied here
   * instead: a session that claims to have ended after now is recorded as
   * having ended now, which is the same treatment a session with no timestamps
   * at all already gets.
   */
  const now = Date.now();
  if (summary.endedAt > now) summary.endedAt = now;
  if (summary.startedAt > summary.endedAt) summary.startedAt = summary.endedAt;
  summaryCache.set(file, { key, summary });
  return summary;
}

/**
 * One session's transcripts folded into one summary.
 *
 * The first entry is the session's own transcript and owns everything
 * descriptive: the title, the cwd, and the headline model. A subagent's opening
 * "prompt" is the task it was handed rather than anything the user typed, and
 * its model is frequently not the one the session was being run at — Haiku doing
 * a search while the parent is on Opus is the ordinary case — so neither may be
 * allowed to name the row.
 *
 * Everything billable adds. Requests were deduplicated per file by `requestId`
 * and a request appears in exactly one file, so summing across them counts each
 * API call once, which is the property invariant 3 is about.
 *
 * Slices are **copied** before they are folded into. `summaryCache` hands back
 * the same summary object on every warm scan, so mutating one in place would
 * make a session's cost grow by its subagents' on every rescan — a leak that
 * only shows up after the app has been left running.
 */
const USAGE_FIELDS = Object.keys(EMPTY_USAGE());

function mergeSummaries(summaries) {
  const [primary, ...rest] = summaries;
  if (!rest.length) return primary;

  const merged = {
    ...primary,
    usage: { ...primary.usage },
    usageByModel: new Map(),
  };
  const sliceKey = (s) => `${s.model}|${s.speed}|${s.inferenceGeo}`;
  for (const slice of primary.usageByModel.values()) {
    merged.usageByModel.set(sliceKey(slice), { ...slice });
  }

  for (const extra of rest) {
    for (const field of USAGE_FIELDS) merged.usage[field] += extra.usage[field] ?? 0;
    merged.requests += extra.requests;
    merged.peakContext = Math.max(merged.peakContext, extra.peakContext);
    // A subagent runs inside its parent's span, but only if both recorded
    // timestamps. Widening to whichever is the real extreme costs nothing and
    // survives a transcript that recorded none.
    if (extra.startedAt && (!merged.startedAt || extra.startedAt < merged.startedAt)) {
      merged.startedAt = extra.startedAt;
    }
    if (extra.endedAt > merged.endedAt) merged.endedAt = extra.endedAt;

    for (const slice of extra.usageByModel.values()) {
      const key = sliceKey(slice);
      const into = merged.usageByModel.get(key);
      if (!into) {
        merged.usageByModel.set(key, { ...slice });
        continue;
      }
      into.requests += slice.requests;
      for (const field of USAGE_FIELDS) into[field] += slice[field] ?? 0;
    }
  }

  return merged;
}

/**
 * Every transcript belonging to one session: its own, then any subagent's.
 *
 * Walked rather than globbed for `subagents/`, because `spawnDepth` in the
 * sidecar metadata says a subagent can spawn one of its own, and a fixed two
 * segments of path would silently stop counting at whatever depth Claude Code
 * settles on. Symlinks are not followed — the walk is over a directory this app
 * does not own, and a loop there would hang the scan.
 */
async function transcriptsUnder(dir, depth = 0) {
  if (depth > 6) return [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await transcriptsUnder(full, depth + 1)));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
  }
  return found;
}

/** Bounded parallelism: transcripts are IO-heavy and there can be a lot of them. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await fn(items[i]);
      } catch {
        // One unreadable transcript must not empty the whole page.
        out[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return out.filter(Boolean);
}

/** Every session on this machine, with the usage that will be priced. */
export async function scan() {
  if (!claudeCodeFound()) return { workspaces: [], sessions: [] };

  const projectDirs = (await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const jobs = [];
  for (const dirName of projectDirs) {
    const dir = path.join(PROJECTS_DIR, dirName);
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    /**
     * `<sessionId>` -> the files that session was billed across.
     *
     * A session id names both a transcript and a sibling directory holding its
     * subagents' transcripts, so both are gathered under the one key. The
     * directory is collected even when the transcript beside it has gone: a
     * deleted parent does not un-bill the subagent, and money with no row is
     * the failure this app exists to catch.
     */
    const bySession = new Map();
    const slot = (id) => {
      const existing = bySession.get(id);
      if (existing) return existing;
      const fresh = { main: null, nested: [] };
      bySession.set(id, fresh);
      return fresh;
    };

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        slot(entry.name.replace(/\.jsonl$/, '')).main = path.join(dir, entry.name);
      } else if (entry.isDirectory()) {
        const nested = await transcriptsUnder(path.join(dir, entry.name));
        if (nested.length) slot(entry.name).nested.push(...nested.sort());
      }
    }

    for (const [sessionId, { main, nested }] of bySession) {
      // The session's own transcript leads, so it is the one `mergeSummaries`
      // takes the title, the cwd and the headline model from.
      const files = main ? [main, ...nested] : nested;
      if (files.length) jobs.push({ dirName, sessionId, files });
    }
  }

  // Forget transcripts that are no longer on disk. The process is long-lived
  // and the watcher rescans on every write, so without this a deleted session
  // holds its parsed summary for as long as the server runs.
  const live = new Set(jobs.flatMap((j) => j.files));
  for (const file of summaryCache.keys()) {
    if (!live.has(file)) summaryCache.delete(file);
  }

  const sessions = await mapLimit(jobs, 8, async (job) => {
    // Sequential within a job, so the bound above stays a bound: a session with
    // fifty subagents must not open fifty streams on top of the seven other
    // jobs running beside it.
    const summaries = [];
    for (const file of job.files) summaries.push(await summarise(file));
    const summary = mergeSummaries(summaries);
    return {
      id: job.sessionId,
      workspaceId: job.dirName,
      title: titleFor(summary, job.sessionId),
      cwd: summary.cwd || decodeProjectDir(job.dirName),
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
      model: summary.model ?? undefined,
      usage: summary.usage,
      // Each entry already names its model and its billing terms; the map key
      // exists only to keep the two apart while folding.
      usageByModel: [...summary.usageByModel.values()].sort((a, b) => b.requests - a.requests),
      peakContext: summary.peakContext,
      requests: summary.requests,
    };
  });

  sessions.sort((a, b) => b.endedAt - a.endedAt);

  const byWorkspace = new Map();
  for (const s of sessions) {
    const existing = byWorkspace.get(s.workspaceId);
    if (existing) {
      existing.sessionCount += 1;
      existing.lastActivity = Math.max(existing.lastActivity, s.endedAt);
    } else {
      byWorkspace.set(s.workspaceId, {
        id: s.workspaceId,
        name: path.basename(s.cwd || s.workspaceId),
        path: s.cwd || decodeProjectDir(s.workspaceId),
        sessionCount: 1,
        lastActivity: s.endedAt,
      });
    }
  }

  return {
    workspaces: [...byWorkspace.values()].sort((a, b) => b.lastActivity - a.lastActivity),
    sessions,
  };
}

/**
 * Re-run the scan when transcripts change.
 *
 * Best-effort: `fs.watch` with `recursive` is not supported everywhere, and the
 * page works fine without it — the button in the header does the same thing on
 * demand. Returns an unsubscribe function.
 */
export function watch(onChange) {
  if (!claudeCodeFound()) return () => {};
  let timer = null;
  const fire = () => {
    // Agents write constantly; one burst of appends is one rescan.
    clearTimeout(timer);
    timer = setTimeout(onChange, 1_000);
  };

  try {
    const w = fs.watch(PROJECTS_DIR, { recursive: true }, fire);
    w.on('error', () => {});
    return () => {
      clearTimeout(timer);
      w.close();
    };
  } catch {
    return () => clearTimeout(timer);
  }
}
