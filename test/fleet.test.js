/**
 * Pricing agents that are not this machine.
 *
 * `claude -p` in a container is handed an auth token and nothing else, and when
 * it exits its filesystem goes with it. So the transcripts have to land
 * somewhere durable while it runs — a directory on the host it writes into —
 * and this app has to be able to read a fleet of them rather than one `~/.claude`.
 *
 * Two things make that more than a loop. The first is attribution: every
 * container gets the same working directory, so the by-project cut collapses
 * the whole fleet into one row named `workspace`, and without a per-agent cut
 * there is no way to ask which agent spent the money. The second is trust. A
 * fleet root is written by a container, which is exactly the kind of directory
 * this process should not follow a symlink out of.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'rcoa-fleet-'));
const FLEET = path.join(ROOT, 'fleet');
const LOCAL = path.join(ROOT, 'local');
const OUTSIDE = path.join(ROOT, 'outside');

const at = (min) => new Date(Date.UTC(2026, 6, 9, 12, min)).toISOString();

/** A transcript in the shape a headless run writes: one prompt, one reply. */
function transcript({ prompt, requestId, outputTokens }) {
  return [
    JSON.stringify({
      type: 'user',
      timestamp: at(0),
      cwd: '/workspace',
      message: { content: prompt },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: at(1),
      cwd: '/workspace',
      requestId,
      message: {
        model: 'claude-opus-5',
        usage: { input_tokens: 10_000, output_tokens: outputTokens },
      },
    }),
  ].join('\n');
}

/**
 * One agent's transcript, at the path a `projects/` bind mount produces.
 *
 * `-workspace` for every agent on purpose: that is what Claude Code writes when
 * the container's working directory is `/workspace`, which is every container.
 */
async function agent(root, sessionId, body) {
  const dir = path.join(root, 'projects', '-workspace');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), body, 'utf8');
}

await fsp.mkdir(path.join(LOCAL, 'projects'), { recursive: true });
const run = (requestId, outputTokens) =>
  transcript({ prompt: 'Run the release checks', requestId, outputTokens });

await agent(path.join(FLEET, 'build-01'), 'aaaaaaaa-0001', run('r1', 3_000));
await agent(path.join(FLEET, 'build-02'), 'bbbbbbbb-0002', run('r2', 5_000));

/**
 * The same session id in two containers.
 *
 * Not far-fetched: `--session-id` can be pinned, and an image with a transcript
 * baked into it repeats on every container started from it. Grouped in one map
 * per project directory — which every agent shares the name of — the second
 * would have overwritten the first and taken its money with it.
 */
await agent(path.join(FLEET, 'twin-a'), 'cccccccc-0003', run('r3', 7_000));
await agent(path.join(FLEET, 'twin-b'), 'cccccccc-0003', run('r4', 11_000));

// A fleet entry that is not there. A typo in CLAUDE_FLEET and an agent that has
// not started yet look the same from here, and both have to be visible.
const MISSING = path.join(ROOT, 'not-mounted');

process.env.CLAUDE_HOME = LOCAL;
process.env.CLAUDE_FLEET = [FLEET, MISSING].join(path.delimiter);

const { scan, fleetDirs, listRoots } = await import('../server/scan.js');
const { withEconomics } = await import('../server/store.js');
const { spendBreakdown } = await import('../server/spend.js');

const index = await scan();
const priced = index.sessions.map(withEconomics);
const breakdown = spendBreakdown(priced, index.workspaces);
const source = (id) => index.sources.find((s) => s.id === id);

test('every container in the fleet is found, and says which one it is', () => {
  assert.deepEqual(
    index.sessions.map((s) => s.source).sort(),
    ['build-01', 'build-02', 'twin-a', 'twin-b'],
  );
});

test('two containers that ran the same session id are two sessions, not one', () => {
  // The failure this replaces is the one this project exists to catch: not a
  // wrong number on screen, but money with no row anywhere, under a heading
  // that promises a breakdown.
  const twins = index.sessions.filter((s) => s.id === 'cccccccc-0003');
  assert.equal(twins.length, 2);
  assert.deepEqual(twins.map((s) => s.source).sort(), ['twin-a', 'twin-b']);
  assert.notEqual(twins[0].usage.outputTokens, twins[1].usage.outputTokens);
});

test('one codebase is one project row however many containers built it', () => {
  // Every agent reports `/workspace`, because that is where every container
  // works. Splitting here would give four rows with the same name and no way to
  // tell them apart; the per-agent question is `bySource`'s to answer.
  assert.equal(breakdown.byProject.length, 1);
  assert.equal(breakdown.byProject[0].name, 'workspace');
});

test('the per-agent cut splits what the per-project cut cannot', () => {
  assert.deepEqual(
    breakdown.bySource.map((r) => r.id).sort(),
    ['build-01', 'build-02', 'twin-a', 'twin-b'],
  );
  // Ordered by cost, and the costs differ, so the cut answers "which agent is
  // expensive" rather than merely listing them.
  assert.ok(breakdown.bySource[0].cost > breakdown.bySource[3].cost);
});

test('the fleet total is the same money every other cut splits', () => {
  const sum = (rows) => rows.reduce((n, r) => n + r.cost, 0);
  for (const key of ['components', 'byModel', 'byProject', 'bySource', 'byDay', 'bySession']) {
    assert.ok(
      Math.abs(sum(breakdown[key]) - breakdown.total) < 1e-6,
      `${key} sums to ${sum(breakdown[key])}, total is ${breakdown.total}`,
    );
  }
});

test('a fleet path that is not there is reported rather than quietly skipped', () => {
  const missing = source('not-mounted');
  assert.ok(missing, 'a missing fleet entry should still appear as a source');
  assert.equal(missing.found, false);
  assert.equal(missing.sessions, 0);
});

test('a fleet entry that is not a directory is reported as unreadable', async () => {
  // A bind mount that landed as a file, a path that names a tarball, a volume
  // that is not mounted yet. Distinguished from "no transcripts here" because
  // one of them is a configuration mistake and the other is Tuesday.
  const file = path.join(ROOT, 'not-a-directory');
  await fsp.writeFile(file, 'this is not an agent', 'utf8');
  process.env.CLAUDE_FLEET = [FLEET, file].join(path.delimiter);
  try {
    const result = await scan();
    const entry = result.sources.find((s) => s.id === 'not-a-directory');
    assert.ok(entry, 'the entry should still be listed');
    assert.equal(entry.found, false);
    assert.equal(entry.unreadable, true, 'a path that is not a directory is not merely empty');
  } finally {
    process.env.CLAUDE_FLEET = [FLEET, MISSING].join(path.delimiter);
  }
});

test('this machine is scanned alongside the fleet, and says it found nothing', () => {
  // `projects/` exists and is empty — a host that runs containers and is also
  // somebody's laptop. Found, with nothing in it, is a different answer from
  // absent, and the page has a different sentence for each.
  assert.equal(source('local').found, true);
  assert.equal(source('local').sessions, 0);
});

test('agents are named by their directory, and two of a name stay two agents', async () => {
  const roots = await listRoots({
    CLAUDE_HOME: LOCAL,
    CLAUDE_FLEET: [FLEET, FLEET].join(path.delimiter),
  });
  const ids = roots.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `ids collide: ${ids.join(', ')}`);
  assert.ok(ids.includes('build-01') && ids.includes('build-01-2'));
});

test('a fleet entry may be one agent rather than a directory of them', async () => {
  // `projects/` is what makes a directory an agent's, so pointing straight at
  // one works without a second variable to say which shape it is.
  const roots = await listRoots({
    CLAUDE_HOME: LOCAL,
    CLAUDE_FLEET: path.join(FLEET, 'build-01'),
  });
  assert.deepEqual(
    roots.map((r) => r.id),
    ['local', 'build-01'],
  );
});

test('CLAUDE_FLEET splits on the delimiter of whichever OS is reading it', () => {
  // Windows separates path lists with `;` precisely because a drive letter has
  // a colon in it, so a POSIX split there would cut `C:\agents` in half.
  assert.deepEqual(fleetDirs({ CLAUDE_FLEET: '/a:/b' }, ':'), ['/a', '/b']);
  assert.deepEqual(fleetDirs({ CLAUDE_FLEET: 'C:\\agents;D:\\more' }, ';'), [
    'C:\\agents',
    'D:\\more',
  ]);
  assert.deepEqual(fleetDirs({}, ':'), []);
  assert.deepEqual(fleetDirs({ CLAUDE_FLEET: '  ' }, ':'), []);
});

test('nothing in a fleet root is written to', async () => {
  // `~/.claude` belongs to Claude Code and a fleet root belongs to a container.
  // This app writes exactly one file and it is not in either of them.
  const listing = async (dir) => {
    const out = [];
    for (const entry of await fsp.readdir(dir, { withFileTypes: true, recursive: true })) {
      const full = path.join(entry.parentPath ?? entry.path, entry.name);
      out.push(`${full}:${entry.isFile() ? (await fsp.stat(full)).size : 'dir'}`);
    }
    return out.sort();
  };
  const before = await listing(FLEET);
  await scan();
  assert.deepEqual(await listing(FLEET), before);
});

test('a symlink planted by a container is not followed out of its own directory', async (t) => {
  /*
   * The trust boundary. A fleet root is a directory a container writes into, so
   * a transcript path there is attacker-controlled in exactly the way a path
   * from a network request is: `projects/x -> /` would otherwise walk the host,
   * and `secret.jsonl -> /somewhere/private` would otherwise be parsed and
   * priced. `readdir` reports a symlink as neither a file nor a directory, and
   * the walk takes only what it reports.
   */
  const escapee = path.join(FLEET, 'sneaky', 'projects', '-workspace');
  await fsp.mkdir(escapee, { recursive: true });
  await fsp.mkdir(OUTSIDE, { recursive: true });
  const secret = path.join(OUTSIDE, 'secret.jsonl');
  await fsp.writeFile(
    secret,
    transcript({ prompt: 'Not this agent', requestId: 'r-secret', outputTokens: 999_999 }),
    'utf8',
  );

  try {
    await fsp.symlink(secret, path.join(escapee, 'linked.jsonl'));
    await fsp.symlink(OUTSIDE, path.join(escapee, 'linked-dir'));
  } catch (err) {
    // Windows refuses symlinks to an unprivileged process. The rule is not
    // platform-specific; the ability to set the trap up is.
    t.skip(`symlinks unavailable here: ${err.code}`);
    return;
  }

  const after = await scan();
  const sneaky = after.sessions.filter((s) => s.source === 'sneaky');
  assert.deepEqual(sneaky, [], 'a symlinked transcript was read');
  assert.ok(
    !after.sessions.some((s) => s.usage.outputTokens === 999_999),
    'content from outside the fleet root was priced',
  );
});

test('a root whose projects directory is itself a symlink is refused', async (t) => {
  /*
   * The layout that makes this reachable is the one people will use by mistake:
   * mount `<root>` rather than `<root>/projects`, and the container creates
   * `projects` itself — as whatever it likes. `readdir` follows the last
   * component of a path, so this is the one place a symlink would have been
   * followed; everything below it was already safe because the walk takes only
   * what `readdir` calls a directory.
   */
  const root = path.join(FLEET, 'relinked');
  await fsp.mkdir(root, { recursive: true });
  try {
    await fsp.symlink(path.join(FLEET, 'build-01', 'projects'), path.join(root, 'projects'));
  } catch (err) {
    t.skip(`symlinks unavailable here: ${err.code}`);
    return;
  }

  const after = await scan();
  const entry = after.sources.find((s) => s.id === 'relinked');
  assert.equal(entry.found, false);
  assert.equal(entry.unreadable, true, 'a symlinked projects dir is refused, and says so');
  assert.deepEqual(after.sessions.filter((s) => s.source === 'relinked'), []);

  // And the same symlink in the local root is followed, because that one is the
  // user's own home: relocating `~/.claude/projects` to another disk is a thing
  // people do, and refusing it would break a working install to defend somebody
  // against themselves.
  const relocated = path.join(ROOT, 'relocated-home');
  await fsp.mkdir(relocated, { recursive: true });
  await fsp.symlink(path.join(FLEET, 'build-01', 'projects'), path.join(relocated, 'projects'));
  const roots = await listRoots({ CLAUDE_HOME: relocated });
  assert.equal(roots[0].trusted, true);

  await fsp.rm(root, { recursive: true, force: true });
});

test.after(() => fsp.rm(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
