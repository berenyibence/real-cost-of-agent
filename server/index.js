#!/usr/bin/env node
/**
 * Real Cost of Agent — the whole server.
 *
 * Local by design: it binds to loopback, reads files this machine already has,
 * and makes no outbound request of any kind. There is no account, no key, and
 * nothing to sign in to. If it is running, everything it knows came off your own
 * disk.
 *
 * This file is also the published binary, hence the shebang: `npx
 * real-cost-of-agent` runs exactly what `node server/index.js` runs.
 */

import fs from 'node:fs';
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestAllowed } from './access.js';
import { getIndex, refresh, startWatching } from './store.js';
import { CLAUDE_DIR } from './scan.js';
import { spendBreakdown } from './spend.js';
import { compareBilling, detectAuth, PLANS, readConfig, writeConfig } from './billing.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, '..', 'web');

/**
 * Read rather than imported.
 *
 * `import ... with { type: 'json' }` would be tidier and is not available on
 * every runtime this claims to support — `engines` says Node 20.11, and import
 * attributes are not a safe assumption that far back. This is one file read at
 * startup.
 */
function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

/**
 * What `--help` prints.
 *
 * Every setting is an environment variable, because that is what this had
 * before it was installable and changing it would break anybody's notes. The
 * flags are the two a published binary is expected to answer.
 */
const USAGE = `real-cost-of-agent — what your agent would have cost

  npx real-cost-of-agent          run it, then open the URL it prints
  node server/index.js            the same thing, from a clone

Options
  -h, --help                      show this and exit
  -v, --version                   print the version and exit

Environment
  PORT=4400                       listen on another port (default 4319)
  HOST=127.0.0.1                  bind address; loopback by default
  CLAUDE_HOME=/path/to/.claude    read transcripts from somewhere else
  CLAUDE_FLEET=/srv/agents        price containers too: a directory of
                                  agents, one agent, or several of either
                                  separated by : (; on Windows)
  XDG_CONFIG_HOME=/path/to/config where this app stores your plan

Runs on Linux, macOS and Windows. It reads ~/.claude, writes one
preference file — under %APPDATA% on Windows and ~/.config elsewhere —
and makes no network request of any kind. Nothing leaves this machine.
`;

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (argv.includes('-v') || argv.includes('--version')) {
  process.stdout.write(`${version()}\n`);
  process.exit(0);
}
// Silently ignoring a flag is how somebody ends up believing `--port 4400`
// worked. Everything here is an environment variable; say so.
const unknown = argv.filter((a) => a.startsWith('-'));
if (unknown.length) {
  process.stderr.write(`real-cost-of-agent: unknown option ${unknown[0]}\n\n${USAGE}`);
  process.exit(1);
}

// 4317 and 4318 are OpenTelemetry's default collector ports and are commonly
// taken on a machine that runs agents; 4319 is the next one up that is not
// claimed by anything standard.
const PORT = Number(process.env.PORT) || 4319;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * The promise in the README, written as a header the browser enforces.
 *
 * The "no network calls, ever" invariant says this project makes no network call — no CDN script, no
 * remote font, no analytics beacon. Until now that was a property of the source
 * that a reader had to take on trust, and that a careless patch could lose
 * without any test noticing. `default-src 'self'` makes the browser refuse it
 * instead: a script, style, font or image from anywhere but this server does
 * not load, and `connect-src 'self'` means a `fetch` to somewhere else fails in
 * the console rather than silently succeeding.
 *
 * The share panel is unaffected. Its platform links are top-level navigations
 * to a new tab, which no fetch directive governs — `form-action 'none'` is
 * about form posts, and there are no forms here.
 *
 * `frame-ancestors 'none'` is the one that is not about outbound traffic: it
 * stops a page in another tab framing this one, which is the clickjacking half
 * of the same confused-deputy problem `access.js` handles for fetches.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // An API response is not a document, but it is one navigation away from
    // being rendered as one, and `nosniff` above only helps if the type is
    // honoured. Costs nothing to say both.
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(json);
}

/**
 * A JSON request body, with a ceiling.
 *
 * The only POST here writes three numbers to a preference file. A body larger
 * than this is either a mistake or an attempt to make the process hold a
 * megabyte per connection, and neither deserves to be buffered.
 */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Names Windows resolves to a device rather than a file, in any directory.
 *
 * `web/con` is not a missing file on Windows — it is the console, and reading it
 * blocks on keyboard input from the terminal the server was started in, so the
 * request never finishes and the user's own typing is swallowed. The rule holds
 * with or without an extension, which is why `con.js` is on the list too.
 *
 * Applied on every platform, not just Windows. There is no file here by any of
 * these names and never will be, so nothing is lost by refusing them — and a
 * rule that only runs on one platform is a rule whoever changes this code will
 * not see run.
 */
const DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Serve the page.
 *
 * The path is resolved and then checked to still be inside `web/`, rather than
 * being pattern-matched for `..`. In practice the WHATWG URL parser above has
 * already flattened dot segments — including `%2e%2e`, which it decodes before
 * deciding whether a segment is a double dot — so most traversal never arrives
 * here at all.
 *
 * The check stays because that is a property of the parser, not of this
 * function: resolve-then-contain is the version that keeps holding if a route
 * is ever fed a path from somewhere other than a parsed URL, and a pattern
 * match for `..` is the version that has to be right about every spelling.
 *
 * It is also the half of this that is platform-independent. Windows adds two
 * spellings the parser does not flatten — `%5C` decodes to a separator there, so
 * `/%5C..%5C..%5Cpackage.json` escapes a directory the POSIX rules would keep it
 * inside, and a bare `\` is an absolute root rather than a filename character.
 * Both land outside `WEB_DIR` and are refused by the same comparison, which is
 * the argument for resolve-then-contain rather than a pattern match: the pattern
 * would have had to know about them.
 */
async function serveStatic(res, pathname) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    // `/%` and other malformed percent-encoding. That is a bad request, not a
    // fault in this server, and a 500 would say the opposite.
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request');
    return;
  }
  const file = path.resolve(WEB_DIR, rel);
  if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (rel.split(/[\\/]+/).some((segment) => DEVICE_NAMES.test(segment))) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  try {
    // Stat before read, so what gets opened is a file. A directory already
    // failed the read with EISDIR and 404'd; a device would not have.
    const stat = await fsp.stat(file);
    if (!stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    const body = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'content-length': body.length,
      'x-content-type-options': 'nosniff',
      'content-security-policy': CSP,
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  // A local server with no auth is still reachable by any page you happen to be
  // looking at. See `access.js` — this is the whole defence.
  if (!requestAllowed(req.headers)) {
    return send(res, 403, {
      error: 'this server answers only to a loopback or IP host, from its own origin',
    });
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/spend') {
      const idx = getIndex();
      const breakdown = spendBreakdown(idx.sessions, idx.workspaces);
      return send(res, 200, {
        ...breakdown,
        billing: compareBilling({
          apiEquivalent: breakdown.total,
          firstAt: breakdown.firstAt,
          lastAt: breakdown.lastAt,
        }),
        meta: {
          sessions: idx.sessions.length,
          workspaces: idx.workspaces.length,
          scannedAt: idx.scannedAt,
          claudeDir: CLAUDE_DIR,
          /**
           * Whether *any* agent had a `projects/` directory, not just this
           * machine. A host that only runs containers has no `~/.claude` of its
           * own, and telling it there is no Claude Code here would be true and
           * useless — the transcripts it is being asked about are in the fleet.
           */
          found: (idx.sources ?? []).some((s) => s.found),
          /**
           * One entry per agent, including the ones that came back empty. An
           * unreadable root is the failure mode worth naming: it looks exactly
           * like an agent that did no work, and this app exists not to report
           * numbers that quietly left something out.
           */
          sources: idx.sources ?? [],
        },
      });
    }

    if (pathname === '/api/billing' && req.method === 'POST') {
      const body = await readJson(req);
      // `periods` replaces the list; the flat fields still edit the first
      // period, so a one-plan caller written against the old endpoint works.
      const config = await writeConfig({
        periods: body.periods,
        planId: body.planId,
        monthlyOverride: body.monthlyOverride,
        seats: body.seats,
        months: body.months,
      });
      return send(res, 200, { ok: true, config });
    }

    if (pathname === '/api/billing') {
      return send(res, 200, {
        plans: PLANS,
        config: readConfig(),
        auth: detectAuth({ refresh: url.searchParams.get('refresh') === '1' }),
      });
    }

    if (pathname === '/api/refresh' && req.method === 'POST') {
      const idx = await refresh();
      return send(res, 200, { ok: true, scannedAt: idx.scannedAt, sessions: idx.sessions.length });
    }

    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'no such route' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { error: 'method not allowed' });
    }
    return await serveStatic(res, pathname);
  } catch (err) {
    // Nothing here is worth crashing the process over, and a page showing an
    // error is more use than a server that went away.
    console.error('[real-cost]', err);
    if (!res.headersSent) send(res, 500, { error: err.message });
    else res.end();
  }
});

const started = Date.now();
await refresh();
startWatching();

server.listen(PORT, HOST, () => {
  const idx = getIndex();
  const took = Date.now() - started;
  const sources = idx.sources ?? [];
  const live = sources.filter((s) => s.found);

  if (!live.length) {
    console.log(`[real-cost] no Claude Code transcripts found at ${CLAUDE_DIR}`);
  } else {
    // The agents that contributed, not the roots that were readable: a host
    // that runs containers has an empty `~/.claude` of its own, and counting it
    // would say "from 3 agents" about work that came from two.
    const worked = sources.filter((s) => s.sessions > 0);
    const agents = worked.length > 1 ? ` from ${worked.length} agents` : '';
    console.log(
      `[real-cost] indexed ${idx.sessions.length} sessions across ${idx.workspaces.length} projects${agents} in ${took}ms`,
    );
  }

  // Named at startup rather than only on the page, because the person who
  // mistyped `CLAUDE_FLEET` or mounted a volume the server cannot read is
  // looking at a terminal, and an agent contributing nothing is indistinguishable
  // from an agent that did nothing.
  for (const source of sources.filter((s) => !s.found)) {
    if (source.id === 'local' && sources.length > 1) continue;
    const why = source.unreadable ? 'not readable' : 'no transcripts';
    console.log(`[real-cost] ${source.id}: ${why} at ${source.path}`);
  }

  console.log(`[real-cost] http://${HOST}:${PORT}`);
});

// A port already in use is the one failure worth explaining rather than
// dumping a stack for: it is almost always a second copy of this app.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Named the way it was actually started, so the suggestion is copy-pasteable
    // whether that was npx or a clone — and in the shell it was started from.
    // `PORT=4400 npm start` is not a command on Windows, so a hint that spells it
    // that way is a hint that has to be translated before it can be used.
    const how = process.argv[1]?.includes('node_modules') ? 'npx real-cost-of-agent' : 'npm start';
    const setPort = process.platform === 'win32' ? '$env:PORT=4400;' : 'PORT=4400';
    console.error(`[real-cost] port ${PORT} is busy. Try: ${setPort} ${how}`);
    process.exit(1);
  }
  throw err;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Don't let an open keep-alive connection hold the process open forever.
    setTimeout(() => process.exit(0), 500).unref();
  });
}
