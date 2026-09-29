/**
 * The parts of this app that are quietly about which operating system it is on.
 *
 * There are two, and both had the same failure mode: they were written on a
 * POSIX machine, were correct there, and were wrong somewhere else in a way that
 * printed a plausible answer rather than an error. A Windows user saw a project
 * called `C//Users/...` in the by-project cut, and kept their plan in a dotfile
 * directory Windows has no convention for.
 *
 * Every case here is asked of every platform, from whichever one is running the
 * suite. `resolveConfigDirs` takes the platform, the environment and the home
 * directory as arguments precisely so that a Linux CI job can check the Windows
 * answer — a test that could only run on Windows is a test that would not have
 * caught either of these, because neither was written on Windows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveConfigDirs } from '../server/paths.js';

/* The scanner resolves CLAUDE_HOME at import time, so the fixture is built and
   the variable set before the dynamic import at the bottom of this block. */
const HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'rcoa-platform-'));
process.env.CLAUDE_HOME = HOME;

const at = (min) => new Date(Date.UTC(2026, 1, 3, 9, min)).toISOString();

/**
 * One transcript, in a project directory named the way Claude Code names them.
 *
 * `cwd` is optional here because that is the case the decoder exists for: a
 * transcript that recorded its own working directory needs no decoding, and one
 * that did not leaves the directory name as the only evidence of where the work
 * happened.
 */
async function project(dirName, { cwd } = {}) {
  const dir = path.join(HOME, 'projects', dirName);
  await fsp.mkdir(dir, { recursive: true });
  const line = (extra) => JSON.stringify({ timestamp: at(0), ...extra });
  await fsp.writeFile(
    path.join(dir, `${dirName}-session.jsonl`),
    [
      line({ type: 'user', cwd, message: { content: 'Price the transcripts' } }),
      line({
        type: 'assistant',
        cwd,
        requestId: `req-${dirName}`,
        message: {
          model: 'claude-opus-5',
          usage: { input_tokens: 1_000, output_tokens: 2_000 },
        },
      }),
    ].join('\n'),
    'utf8',
  );
}

// A Windows cwd loses its drive colon and its separators to the same dash, so
// `C:\Users\dev\checkout` is written as `C--Users-dev-checkout`. The POSIX
// spelling of the same idea sits beside it, and both are decoded in one scan.
await project('C--Users-dev-checkout');
await project('-home-dev-checkout');
// A transcript that did record its cwd, in the Windows spelling. Nothing has to
// be decoded here — but the project's *name* is still the last segment of it,
// and `path.basename` on Linux does not know that.
await project('D--work-api', { cwd: 'D:\\work\\api' });

const { scan } = await import('../server/scan.js');
const { workspaces } = await scan();
const workspace = (id) => workspaces.find((w) => w.id === id);

test('a Windows project directory decodes to a Windows path, not a mangled one', () => {
  // `C//Users/dev/checkout` is what the POSIX rule produced: a path that exists
  // on no machine, shown in the by-project cut as if it were where the work was.
  assert.equal(workspace('C--Users-dev-checkout').path, 'C:\\Users\\dev\\checkout');
});

test('a POSIX project directory still decodes the way it always did', () => {
  assert.equal(workspace('-home-dev-checkout').path, '/home/dev/checkout');
});

test('the project name is the last segment, whichever OS wrote the path', () => {
  // The bug this holds is not hypothetical on one platform only: `path.basename`
  // knows the separators of the machine it runs on, so the Windows path names
  // the project `checkout` on Windows and `C:\Users\dev\checkout` on Linux —
  // somebody's home directory printed in a column headed "project".
  assert.equal(workspace('C--Users-dev-checkout').name, 'checkout');
  assert.equal(workspace('-home-dev-checkout').name, 'checkout');
  assert.equal(workspace('D--work-api').name, 'api');
});

test('a recorded cwd is preferred over the directory name, on either platform', () => {
  // The decode is lossy — `D--work-api` could equally be `D:\work-api` — so a
  // transcript that says where it ran wins, and only the name is guessed at.
  assert.equal(workspace('D--work-api').path, 'D:\\work\\api');
});

test('Windows keeps its plan under %APPDATA%, not in a dotfile directory', () => {
  const { dir } = resolveConfigDirs({
    platform: 'win32',
    env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
    home: 'C:\\Users\\dev',
  });
  assert.equal(dir, 'C:\\Users\\dev\\AppData\\Roaming\\real-cost-of-agent');
});

test('an unset %APPDATA% falls back to what Windows defines it as', () => {
  const { dir } = resolveConfigDirs({ platform: 'win32', env: {}, home: 'C:\\Users\\dev' });
  assert.equal(dir, 'C:\\Users\\dev\\AppData\\Roaming\\real-cost-of-agent');
});

test('a plan saved by an older build on Windows is still read after the move', () => {
  // The move is only safe because of this: the default plan is a *plausible*
  // plan rather than a blank, so a user whose config went missing would keep
  // seeing a confident comparison against a subscription they are not on.
  const { fallbacks } = resolveConfigDirs({
    platform: 'win32',
    env: { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
    home: 'C:\\Users\\dev',
  });
  assert.ok(fallbacks.includes('C:\\Users\\dev\\.config\\real-cost-of-agent'));
  assert.ok(fallbacks.includes('C:\\Users\\dev\\.config\\agent-spend'));
});

test('macOS and Linux keep ~/.config, and a move would only lose someone their plan', () => {
  for (const [platform, home] of [
    ['darwin', '/Users/dev'],
    ['linux', '/home/dev'],
  ]) {
    const { dir, fallbacks } = resolveConfigDirs({ platform, env: {}, home });
    assert.equal(dir, `${home}/.config/real-cost-of-agent`);
    assert.deepEqual(fallbacks, [`${home}/.config/agent-spend`]);
  }
});

test('XDG_CONFIG_HOME is honoured on every platform, Windows included', () => {
  assert.equal(
    resolveConfigDirs({
      platform: 'win32',
      env: { XDG_CONFIG_HOME: 'D:\\config', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
      home: 'C:\\Users\\dev',
    }).dir,
    'D:\\config\\real-cost-of-agent',
  );
  assert.equal(
    resolveConfigDirs({ platform: 'linux', env: { XDG_CONFIG_HOME: '/srv/cfg' }, home: '/home/dev' })
      .dir,
    '/srv/cfg/real-cost-of-agent',
  );
});

test('a relative XDG_CONFIG_HOME is ignored rather than resolved against the cwd', () => {
  // The server's working directory is wherever it happened to be started from.
  // Writing a config into somebody's checkout because they exported a relative
  // path is worse than not honouring the variable at all.
  for (const [platform, home, expected] of [
    ['linux', '/home/dev', '/home/dev/.config/real-cost-of-agent'],
    ['win32', 'C:\\Users\\dev', 'C:\\Users\\dev\\AppData\\Roaming\\real-cost-of-agent'],
  ]) {
    const { dir } = resolveConfigDirs({ platform, env: { XDG_CONFIG_HOME: '../cfg' }, home });
    assert.equal(dir, expected);
  }
});

test('a redirected config is not quietly read from the home directory anyway', () => {
  // `XDG_CONFIG_HOME` set means the user pointed somewhere deliberately, and a
  // fallback reaching back to `~/.config` would mean a run with the variable set
  // could still answer with the very config it was pointed away from. It is also
  // what keeps the suite off a real home directory: `test/config-location.test.js`
  // sets the variable and then deletes every directory on this list.
  assert.deepEqual(
    resolveConfigDirs({ platform: 'linux', env: { XDG_CONFIG_HOME: '/srv/cfg' }, home: '/home/dev' })
      .fallbacks,
    ['/srv/cfg/agent-spend'],
  );
  assert.deepEqual(
    resolveConfigDirs({
      platform: 'win32',
      env: { XDG_CONFIG_HOME: 'D:\\config', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
      home: 'C:\\Users\\dev',
    }).fallbacks,
    ['D:\\config\\agent-spend'],
  );
});

test('nothing that is written is also on the list of places to read', () => {
  for (const [platform, env, home] of [
    ['win32', {}, 'C:\\Users\\dev'],
    ['darwin', {}, '/Users/dev'],
    ['linux', { XDG_CONFIG_HOME: '/srv/cfg' }, '/home/dev'],
  ]) {
    const { dir, fallbacks } = resolveConfigDirs({ platform, env, home });
    assert.ok(!fallbacks.includes(dir), `${platform} lists its own write location as a fallback`);
    assert.equal(new Set(fallbacks).size, fallbacks.length, `${platform} repeats a fallback`);
  }
});

test.after(() => fsp.rm(HOME, { recursive: true, force: true }));
