/**
 * The server, actually started, on whatever machine is running this.
 *
 * Everything else in this suite calls a function. This boots `server/index.js`
 * the way a person does, asks it for every route, and reads the headers back —
 * which is the only way to catch the things that are true of a *process* rather
 * than of a module: that the access rules are wired into the request path at
 * all, that the policy header is really sent, that the asset the page needs is
 * really on disk under the name the page asks for.
 *
 * It lives here rather than in CI's shell script because the shell script only
 * ran on Linux. Every one of these assertions is about behaviour that can differ
 * on Windows — path containment, device names, how a URL decodes into a
 * filename — and testing them in bash meant testing them on the one platform
 * where they were already known to work. As a test file it runs on every OS and
 * every Node version in the matrix, and on a contributor's own machine.
 *
 * Nothing here reaches the network. Every request is to 127.0.0.1, which is the
 * same traffic the browser makes, and the *no network calls, ever* invariant is
 * about what leaves the machine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SERVER = path.join(ROOT, 'server', 'index.js');

/**
 * `~/.claude` with nothing in it yet.
 *
 * A machine with no transcripts is the first thing a new contributor sees, and
 * it is the state CI is always in — so it is the state worth booting against.
 */
const CLAUDE_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'rcoa-smoke-claude-'));
const CONFIG_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'rcoa-smoke-config-'));

/** A port the OS has just confirmed is free. Asked for rather than assumed. */
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Run the binary with arguments, and collect what it printed. */
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER, ...args], {
      env: { ...process.env, CLAUDE_HOME, XDG_CONFIG_HOME: CONFIG_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Boot the server and wait until it says it is listening.
 *
 * Waits for the line it prints rather than polling the port, so the test is not
 * racing its own timeout on a slow Windows runner. The retry is for the gap
 * between `freePort` closing its probe and the server binding — small, but this
 * runs on shared CI machines and a flaky suite is a suite people stop reading.
 */
async function boot() {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        CLAUDE_HOME,
        XDG_CONFIG_HOME: CONFIG_HOME,
        PORT: String(port),
        HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    const listening = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 30_000);
      const done = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      child.stdout.on('data', (d) => {
        output += d;
        if (output.includes(`http://127.0.0.1:${port}`)) done(true);
      });
      child.stderr.on('data', (d) => (output += d));
      child.once('exit', () => done(false));
    });

    if (listening) return { child, port };
    lastError = output;
    child.kill();
  }
  throw new Error(`the server never started:\n${lastError}`);
}

/**
 * One request, with the request-target sent exactly as given.
 *
 * `path` is handed to `http.request` unparsed, which is what `curl --path-as-is`
 * was doing in the shell version: a client that helpfully resolved `..` before
 * sending would be testing itself rather than the server.
 */
function request(port, target, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: target, headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const { child, port } = await boot();
const get = (target, options) => request(port, target, options);
const json = async (target, options) => JSON.parse((await get(target, options)).body);

test('every asset the page loads is served', async () => {
  for (const target of [
    '/',
    '/app.js',
    '/share.js',
    '/theme.js',
    '/styles.css',
    '/brand/mark.svg',
    '/api/spend',
    '/api/billing',
  ]) {
    const res = await get(target);
    assert.equal(res.status, 200, `${target} answered ${res.status}`);
  }
});

test('the page is served under a policy that forbids the network', async () => {
  // The *no network calls, ever* invariant, as something the browser enforces
  // rather than something the source merely happens to do. A CDN script or an
  // analytics beacon added later fails here first.
  const csp = (await get('/')).headers['content-security-policy'];
  for (const directive of ["default-src 'self'", "connect-src 'self'", "frame-ancestors 'none'"]) {
    assert.ok(csp.includes(directive), `the policy is missing ${directive}: ${csp}`);
  }
});

test('the theme is a file rather than an inline block, so the policy needs no hash', async () => {
  // An inline script would be blocked by the policy above, and the page would
  // flash the wrong theme. A hash in the policy is the alternative, and a hash
  // is the thing that silently stops matching the first time somebody edits the
  // script in a project with no build step to regenerate it.
  const html = await fsp.readFile(path.join(ROOT, 'web', 'index.html'), 'utf8');
  assert.ok(!/<script(\s[^>]*)?>[^<]/.test(html), 'web/index.html has an inline script');
});

test('nothing outside web/ is served, in any spelling either OS understands', async () => {
  /*
   * The first three are the POSIX spellings. The last two are Windows-only
   * escapes: `%5C` decodes to a path separator there, and a leading one is an
   * absolute root rather than an ordinary filename character, so both resolve
   * outside `web/` on Windows and to a nonexistent file on Linux.
   *
   * The assertion is on the property that matters — no 200, and no package.json
   * on the wire — rather than on which layer caught it, so a change to the URL
   * parser, the containment check or the platform still leaves this meaningful.
   */
  for (const target of [
    '/../package.json',
    '/%2e%2e/package.json',
    '/..%2fpackage.json',
    '/%5C..%5C..%5Cpackage.json',
    '/..\\..\\package.json',
  ]) {
    const res = await get(target);
    assert.notEqual(res.status, 200, `${target} was served`);
    assert.ok(!res.body.includes('"name": "real-cost-of-agent"'), `${target} served package.json`);
  }
});

test('a Windows device name is a missing file, not the console', async () => {
  // `web/con` on Windows is the terminal the server was started in: reading it
  // blocks on keyboard input, so the request never finishes and the user's own
  // typing is swallowed. `web/nul` is the null device, which without the rule
  // reads back as an empty 200 — an asset that does not exist, served. Both are
  // refused on every platform, so the rule is visible to whoever changes this
  // code rather than only to the Windows users it saves.
  for (const target of ['/con', '/nul', '/con.js', '/brand/aux.svg', '/COM1']) {
    const res = await get(target);
    assert.equal(res.status, 404, `${target} answered ${res.status}`);
  }
});

test('a machine with no transcripts says so rather than showing a dashboard of zeros', async () => {
  const spend = await json('/api/spend');
  assert.equal(spend.meta.found, false);
  assert.equal(spend.meta.sessions, 0);
});

test('a fresh Claude Code install is the third state, and is distinguishable', async () => {
  // The directory exists and holds nothing. That is different from "no directory
  // at all", and it used to be the one that rendered a comparison of zeros.
  await fsp.mkdir(path.join(CLAUDE_HOME, 'projects'), { recursive: true });
  const refreshed = await get('/api/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(refreshed.status, 200);

  const spend = await json('/api/spend');
  assert.equal(spend.meta.found, true, 'projects/ exists but found is false');
  assert.equal(spend.meta.sessions, 0);
});

test('a request naming somebody else’s host is refused', async () => {
  // `test/access.test.js` covers the predicate; this covers it being wired into
  // the request path, which is the part a refactor can quietly drop.
  const res = await get('/api/spend', { headers: { host: `evil.example:${port}` } });
  assert.equal(res.status, 403);
});

test('a cross-site write is refused', async () => {
  const res = await get('/api/billing', {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
    body: '{"planId":"none"}',
  });
  assert.equal(res.status, 403);
});

test('the documented way of running it works, in both spellings', async () => {
  for (const host of ['127.0.0.1', 'localhost']) {
    const res = await get('/api/spend', { headers: { host: `${host}:${port}` } });
    assert.equal(res.status, 200, `Host: ${host} answered ${res.status}`);
  }
});

test('the installed binary answers --version and --help', async () => {
  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const version = await run(['--version']);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), pkg.version);

  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /CLAUDE_HOME/);

  // Silently ignoring a flag is how somebody ends up believing `--port` worked.
  const wrong = await run(['--port', '4400']);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /unknown option --port/);
});

test.after(async () => {
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  // `maxRetries` is for Windows, which can hold a handle open for a moment after
  // the process using it has gone — the watcher had `projects/` open until just
  // now — and an unretried delete there fails with EBUSY.
  const gone = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
  await fsp.rm(CLAUDE_HOME, gone);
  await fsp.rm(CONFIG_HOME, gone);
});
