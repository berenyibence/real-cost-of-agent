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
});

/** sessionId -> { key, summary } where key is `${mtimeMs}:${size}`. */
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
     * Usage split by the model that actually served each request.
     *
     * A session is not one model. Switching mid-run is common, and the tiers
     * differ by up to 2x, so pricing a whole session at whichever model happened
     * to answer last is not a rounding error — on the largest sessions it is out
     * by tens of percent, in whichever direction the last model pointed.
     */
    usageByModel: new Map(),
    peakContext: 0,
    requests: 0,
  };

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
          if (msg.model && msg.model !== '<synthetic>') summary.model = msg.model;
          const u = msg.usage;
          if (!u) break;

          summary.usage.inputTokens += u.input_tokens ?? 0;
          summary.usage.outputTokens += u.output_tokens ?? 0;
          summary.usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
          const written = u.cache_creation_input_tokens ?? 0;
          summary.usage.cacheWriteTokens += written;
          // The TTL split decides the billing multiplier. When the breakdown is
          // absent, attribute to 5m — the cheaper, default TTL, so an unknown
          // never inflates the bill.
          const oneHour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
          const fiveMin = u.cache_creation?.ephemeral_5m_input_tokens ?? written - oneHour;
          summary.usage.cacheWrite1h += oneHour;
          summary.usage.cacheWrite5m += Math.max(0, fiveMin);

          // The same numbers again, kept apart by which model served them.
          const key =
            msg.model && msg.model !== '<synthetic>' ? msg.model : (summary.model ?? 'unknown');
          const slice =
            summary.usageByModel.get(key) ??
            summary.usageByModel.set(key, { ...EMPTY_USAGE(), requests: 0 }).get(key);
          slice.requests += 1;
          slice.inputTokens += u.input_tokens ?? 0;
          slice.outputTokens += u.output_tokens ?? 0;
          slice.cacheReadTokens += u.cache_read_input_tokens ?? 0;
          slice.cacheWriteTokens += written;
          slice.cacheWrite1h += oneHour;
          slice.cacheWrite5m += Math.max(0, fiveMin);

          // Everything the model read this turn — the context-window measure.
          const turnContext = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + written;
          if (turnContext > summary.peakContext) summary.peakContext = turnContext;
          summary.requests += 1;
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

  return summary;
}

/**
 * Claude Code slugifies the cwd by replacing separators with dashes, which is
 * lossy (`-home-dev-my-app`). Used only when a transcript carries no `cwd`.
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

async function summarise(file, sessionId) {
  const stat = await fsp.stat(file);
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = summaryCache.get(sessionId);
  if (hit && hit.key === key) return hit.summary;

  const summary = await parseTranscript(file);
  // A transcript with no timestamps still happened; the file's own mtime is the
  // best evidence of when, and a session with no date at all falls out of the
  // by-day breakdown entirely.
  if (!summary.endedAt) summary.endedAt = stat.mtimeMs;
  if (!summary.startedAt) summary.startedAt = stat.mtimeMs;
  summaryCache.set(sessionId, { key, summary });
  return summary;
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
    let files = [];
    try {
      files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      jobs.push({ dirName, file: path.join(dir, f), sessionId: f.replace(/\.jsonl$/, '') });
    }
  }

  const sessions = await mapLimit(jobs, 8, async (job) => {
    const summary = await summarise(job.file, job.sessionId);
    return {
      id: job.sessionId,
      workspaceId: job.dirName,
      title: titleFor(summary, job.sessionId),
      cwd: summary.cwd || decodeProjectDir(job.dirName),
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
      model: summary.model ?? undefined,
      usage: summary.usage,
      usageByModel: [...summary.usageByModel.entries()]
        .map(([model, usage]) => ({ model, ...usage }))
        .sort((a, b) => b.requests - a.requests),
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
