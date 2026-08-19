/**
 * Real Cost of Agent — the whole server.
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
import { requestAllowed } from './access.js';
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
  try {
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
          found: claudeCodeFound(),
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
  if (!claudeCodeFound()) {
    console.log(`[real-cost] no Claude Code transcripts found at ${CLAUDE_DIR}`);
  } else {
    console.log(
      `[real-cost] indexed ${idx.sessions.length} sessions across ${idx.workspaces.length} projects in ${took}ms`,
    );
  }
  console.log(`[real-cost] http://${HOST}:${PORT}`);
});

// A port already in use is the one failure worth explaining rather than
// dumping a stack for: it is almost always a second copy of this app.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[real-cost] port ${PORT} is busy. Try: PORT=4400 npm start`);
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
