/**
 * What the watcher attaches to, across a fleet that changes under it.
 *
 * Asserted on the directories `fs.watch` is handed rather than on events
 * arriving, because event delivery is the operating system's and differs on
 * all three that CI runs — macOS reports a directory's creation late, Linux
 * builds a recursive watch by walking the tree, Windows does neither. What this
 * file owns is the decision about *where* to watch, and that is the same
 * everywhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'rcoa-watch-'));
const FLEET = path.join(ROOT, 'fleet');
const OUTSIDE = path.join(ROOT, 'outside');
await fsp.mkdir(path.join(ROOT, 'local'), { recursive: true });
await fsp.mkdir(FLEET, { recursive: true });
await fsp.mkdir(OUTSIDE, { recursive: true });

process.env.CLAUDE_HOME = path.join(ROOT, 'local');
process.env.CLAUDE_FLEET = FLEET;

/** Every directory handed to `fs.watch`, and a way to deliver an event. */
const watched = new Map();
const realWatch = fs.watch;
fs.watch = (dir, opts, listener) => {
  const w = realWatch(dir, opts, listener);
  const entry = { recursive: !!opts?.recursive, listener };
  watched.set(dir, entry);
  // Only if it is still this watcher's entry: a watcher closed by an earlier
  // test can report it after a newer one has attached to the same directory.
  w.on('close', () => watched.get(dir) === entry && watched.delete(dir));
  return w;
};

const { watch } = await import('../server/scan.js');

test.after(() => {
  fs.watch = realWatch;
  return fsp.rm(ROOT, { recursive: true, force: true });
});

/** Poll rather than sleep, so a fast machine is not made to wait for a slow one. */
async function until(predicate, ms = 4_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

test('an agent that starts after the server is watched once it appears', async (t) => {
  // The rescan its arrival caused used to be the last one it ever got: the
  // roots were listed once at startup, so its later writes went unseen and its
  // figures froze at whatever it had written in its first second.
  let rescans = 0;
  const stop = watch(() => rescans++);
  t.after(stop);
  assert.ok(await until(() => watched.has(FLEET)), 'the fleet directory is not watched');

  const late = path.join(FLEET, 'late-agent');
  await fsp.mkdir(path.join(late, 'projects', '-workspace'), { recursive: true });
  watched.get(FLEET).listener('rename', 'late-agent');

  const projects = path.join(late, 'projects');
  assert.ok(await until(() => watched.has(projects)), 'the new agent was never watched');
  assert.equal(watched.get(projects).recursive, true);
  assert.ok(rescans >= 1, 'its arrival did not rescan');
});

test('an agent whose projects directory comes later is still caught', async (t) => {
  // A container creates its `.claude` before it has written a transcript. The
  // root is watched shallowly until `projects/` exists, then handed over.
  const early = path.join(FLEET, 'early-agent');
  await fsp.mkdir(early, { recursive: true });
  const stop = watch(() => {});
  t.after(stop);
  assert.ok(await until(() => watched.has(early)), 'the empty root is not watched');

  const projects = path.join(early, 'projects');
  await fsp.mkdir(projects);
  watched.get(early).listener('rename', 'projects');

  assert.ok(await until(() => watched.has(projects)), 'projects/ was never watched');
  assert.ok(await until(() => !watched.has(early)), 'the shallow watch outlived its purpose');
});

test('a projects symlink planted by a container is not watched through', async (t) => {
  // The scan refuses to read through it; a recursive watch would have followed
  // it anyway, and on Linux that means walking and watching every directory
  // underneath — `projects -> /` is the whole host.
  const evil = path.join(FLEET, 'evil-agent');
  await fsp.mkdir(evil, { recursive: true });
  try {
    await fsp.symlink(OUTSIDE, path.join(evil, 'projects'), 'junction');
  } catch (err) {
    t.skip(`symlinks unavailable here: ${err.code}`);
    return;
  }
  // The fleet directory is attached last, after every root has been decided,
  // so seeing it watched again means this agent has been considered.
  watched.clear();
  const stop = watch(() => {});
  t.after(stop);
  assert.ok(await until(() => watched.has(FLEET)), 'the fleet directory is not watched');

  for (const dir of watched.keys()) {
    assert.ok(!dir.startsWith(evil), `watched ${dir}`);
    assert.ok(!dir.startsWith(OUTSIDE), `watched ${dir}`);
  }
});
