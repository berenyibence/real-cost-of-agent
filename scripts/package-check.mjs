/**
 * The published tarball, installed somewhere else and served from there.
 *
 * `files` in package.json is an allowlist, so anything new under `web/` or
 * `server/` that it does not cover is missing from the published package and
 * present in every clone. That failure is invisible to whoever added the file
 * and total for anybody arriving by `npx`, which is the documented way in — so
 * a clone can never catch it, and this installs the tarball like a user's.
 *
 * Written in Node rather than as a shell block so it runs on Windows as well as
 * Linux. The Windows half is not ceremony: `npm` there is a `.cmd` shim that
 * Node refuses to spawn without a shell, and the installed binary is a second
 * `.cmd` shim generated at install time. Neither exists on Linux, so neither was
 * ever exercised, and `npx real-cost-of-agent` on Windows went out unproven.
 *
 * Run by CI. Not in `files`, so it is not in the tarball it checks.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WINDOWS = process.platform === 'win32';

/**
 * `npm`, run somewhere.
 *
 * `shell: true` on Windows because npm is `npm.cmd` there and Node has refused
 * to spawn a `.cmd` without a shell since 20.12. Every argument passed here is a
 * literal or a bare filename — the directories travel as `cwd`, which is not
 * shell-quoted — so there is nothing for a space in a temp path to break.
 */
function npm(args, cwd) {
  const result = spawnSync(WINDOWS ? 'npm.cmd' : 'npm', args, {
    cwd,
    shell: WINDOWS,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `npm ${args.join(' ')} failed:\n${result.stderr ?? ''}`);
  return result.stdout ?? '';
}

/** The installed binary, run with arguments. */
function bin(args, cwd) {
  const relative = path.join('node_modules', '.bin', 'real-cost-of-agent');
  const result = spawnSync(WINDOWS ? `${relative}.cmd` : relative, args, {
    cwd,
    shell: WINDOWS,
    encoding: 'utf8',
  });
  return result;
}

/**
 * Stop the server, including on Windows, where `child.kill()` does not.
 *
 * The installed binary is a `.cmd` shim, so it is spawned through a shell — and
 * killing that child kills cmd.exe, leaving the node process it started running
 * with its handles open inside the consumer directory. The first Windows run of
 * this script failed on exactly that: every assertion passed, the cleanup then
 * could not remove the directory (EBUSY), and the runner reported a "Terminate
 * orphan process (node)" afterwards. `taskkill /T` takes the tree instead.
 *
 * The wait has a ceiling because a kill that did not work must not turn into a
 * job that hangs until the runner times out.
 */
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  if (WINDOWS) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

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

function status(port, target) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'rcoa-package-'));
const consumer = path.join(work, 'consumer');
const claudeHome = path.join(work, 'claude');
let packed;
let server;

try {
  // Packed into the project directory and then moved, so no path is ever an
  // argument: `--pack-destination` would put a temp path through cmd.exe.
  //
  // The tarball is found by looking rather than by parsing npm's output, which
  // is npm's to change and is not the same on both platforms.
  npm(['pack', '--silent'], ROOT);
  const packs = (await fsp.readdir(ROOT)).filter((f) => /^real-cost-of-agent-.*\.tgz$/.test(f));
  assert.equal(packs.length, 1, `expected one packed tarball, found ${packs.join(', ') || 'none'}`);
  const name = packs[0];
  packed = path.join(ROOT, name);
  const tarball = path.join(consumer, 'app.tgz');

  await fsp.mkdir(consumer, { recursive: true });
  await fsp.mkdir(path.join(claudeHome, 'projects'), { recursive: true });
  // Copied and deleted rather than renamed. On a Windows runner the checkout is
  // on `D:` and the temp directory is on `C:`, and a rename cannot cross a
  // volume — it fails with EXDEV, which on Linux never happens because both
  // paths are on the same filesystem.
  await fsp.copyFile(packed, tarball);
  await fsp.rm(packed, { force: true });
  packed = null;
  console.log(`packed ${name}, ${(fs.statSync(tarball).size / 1024).toFixed(0)}kB`);

  npm(['init', '-y'], consumer);
  npm(['install', 'app.tgz', '--no-audit', '--no-fund'], consumer);

  const installed = JSON.parse(
    await fsp.readFile(
      path.join(consumer, 'node_modules', 'real-cost-of-agent', 'package.json'),
      'utf8',
    ),
  );
  const version = bin(['--version'], consumer);
  assert.equal(version.status, 0, `--version failed:\n${version.stderr}`);
  assert.equal(version.stdout.trim(), installed.version);
  assert.equal(bin(['--help'], consumer).status, 0);
  console.log(`--version and --help answer, from the ${WINDOWS ? '.cmd' : 'shell'} shim`);

  const port = await freePort();
  const relative = path.join('node_modules', '.bin', 'real-cost-of-agent');
  server = spawn(WINDOWS ? `${relative}.cmd` : relative, [], {
    cwd: consumer,
    shell: WINDOWS,
    env: {
      ...process.env,
      CLAUDE_HOME: claudeHome,
      XDG_CONFIG_HOME: path.join(work, 'config'),
      APPDATA: path.join(work, 'config'),
      PORT: String(port),
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const listening = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 60_000);
    const done = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    server.stdout.on('data', (d) => {
      output += d;
      if (output.includes(`http://127.0.0.1:${port}`)) done(true);
    });
    server.stderr.on('data', (d) => (output += d));
    server.once('exit', () => done(false));
  });
  assert.ok(listening, `the installed binary never started:\n${output}`);

  // Every asset the page needs, served out of node_modules rather than a
  // checkout. A file missing from `files` 404s here and nowhere else.
  for (const target of [
    '/',
    '/index.html',
    '/theme.js',
    '/app.js',
    '/share.js',
    '/styles.css',
    '/brand/mark.svg',
    '/api/spend',
    '/api/billing',
  ]) {
    const code = await status(port, target);
    console.log(`  ${target} -> ${code}`);
    assert.equal(code, 200, `${target} answered ${code} from the installed package`);
  }
  console.log('the tarball is the whole app');
} finally {
  const stopped = server ? await stop(server) : true;
  // A pack that got as far as writing the tarball but no further would otherwise
  // leave it in the checkout, where it is untracked and easy to commit.
  if (packed) await fsp.rm(packed, { force: true });
  try {
    // `maxRetries` is for Windows, which can hold a handle open for a moment
    // after the process using it has gone.
    await fsp.rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    // Not fatal, and deliberately so: the question this script exists to answer
    // was answered above, and a temp directory the OS will reclaim is not a
    // packaging defect. Reporting one would be a red job that means nothing.
    console.warn(`could not remove ${work}: ${err.code ?? err.message}`);
  }
  // A server still running *is* worth failing on, because it is the thing that
  // makes the cleanup above fail and it means the kill above did not work.
  assert.ok(stopped, 'the installed binary did not stop when it was told to');
}
