/**
 * Agent Spend — the whole server.
 *
 * Local by design: it binds to loopback, reads files this machine already has,
 * and makes no outbound request of any kind. There is no account, no key, and
 * nothing to sign in to. If it is running, everything it knows came off your own
 * disk.
 */

import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getIndex, refresh, startWatching } from './store.js';
import { CLAUDE_DIR, claudeCodeFound } from './scan.js';
import { spendBreakdown } from './spend.js';
import { compareBilling, detectAuth, PLANS, readConfig, writeConfig } from './billing.js';

// 4317 and 4318 are OpenTelemetry's default collector ports and are commonly
// taken on a machine that runs agents; 4319 is the next one up that is not
// claimed by anything standard.
const PORT = Number(process.env.PORT) || 4319;
const HOST = process.env.HOST || '127.0.0.1';
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
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
 * Serve the page.
 *
 * The path is resolved and then checked to still be inside `web/`, rather than
 * being pattern-matched for `..`. Encoded traversal (`%2e%2e`) survives the
 * pattern and does not survive the check.
 */
async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(WEB_DIR, rel);
  if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'content-length': body.length,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

const server = http.createServer(async (req, res) => {
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
          found: claudeCodeFound(),
        },
      });
    }

    if (pathname === '/api/billing' && req.method === 'POST') {
      const body = await readJson(req);
      const config = await writeConfig({
        planId: body.planId,
        monthlyOverride: body.monthlyOverride,
        seats: body.seats,
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
    console.error('[agent-spend]', err);
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
  if (!claudeCodeFound()) {
    console.log(`[agent-spend] no Claude Code transcripts found at ${CLAUDE_DIR}`);
  } else {
    console.log(
      `[agent-spend] indexed ${idx.sessions.length} sessions across ${idx.workspaces.length} projects in ${took}ms`,
    );
  }
  console.log(`[agent-spend] http://${HOST}:${PORT}`);
});

// A port already in use is the one failure worth explaining rather than
// dumping a stack for: it is almost always a second copy of this app.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[agent-spend] port ${PORT} is busy. Try: PORT=4400 npm start`);
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
