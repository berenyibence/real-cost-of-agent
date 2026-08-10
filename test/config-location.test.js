/**
 * Where the preference file lives, across the rename.
 *
 * The project used to be called Agent Spend and kept its config under that name.
 * Moving it without a fallback would have been the quietest possible bug: the
 * default plan is a *plausible* plan rather than a blank, so a reset user would
 * keep seeing a confident comparison against a subscription they are not on, and
 * nothing on the page would suggest checking.
 *
 * This file owns the other half of that rule too — that the old location is only
 * ever read. Migrating it on startup would mean this app writing a second file,
 * which is a promise the README makes and this is the test that keeps it.
 *
 * `readConfig`/`writeConfig` resolve their paths at import time, so the
 * environment is set before the dynamic import below rather than in a `before`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rcoa-config-'));
process.env.XDG_CONFIG_HOME = root;
// Keep the scanner off the real ~/.claude — billing.js imports it for the
// telemetry directory.
process.env.CLAUDE_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'rcoa-claude-'));

const { CONFIG_DIR, LEGACY_CONFIG_DIR } = await import('../server/paths.js');
const { readConfig, writeConfig } = await import('../server/billing.js');

const CURRENT = path.join(CONFIG_DIR, 'config.json');
const LEGACY = path.join(LEGACY_CONFIG_DIR, 'config.json');

const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
};

const clear = () => {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  fs.rmSync(LEGACY_CONFIG_DIR, { recursive: true, force: true });
};

test('the two locations are distinct, and named what the docs say', () => {
  assert.equal(path.basename(CONFIG_DIR), 'real-cost-of-agent');
  assert.equal(path.basename(LEGACY_CONFIG_DIR), 'agent-spend');
  assert.notEqual(CONFIG_DIR, LEGACY_CONFIG_DIR);
  assert.equal(path.dirname(CONFIG_DIR), root, 'XDG_CONFIG_HOME must be honoured');
});

test('a plan saved before the rename is still found afterwards', () => {
  clear();
  // Written in the pre-0.4 flat shape, which is what a file from that era holds:
  // it survives both the rename and the move to a list of periods.
  write(LEGACY, { planId: 'max5', monthlyOverride: 90, seats: 3 });
  assert.deepEqual(readConfig(), {
    periods: [{ planId: 'max5', monthlyOverride: 90, seats: 3, months: null }],
  });
});

test('a plan history saved in the current location is read back intact', () => {
  clear();
  write(CURRENT, {
    periods: [
      { planId: 'pro', monthlyOverride: null, seats: 1, months: 2 },
      { planId: 'max20', monthlyOverride: null, seats: 1, months: 3 },
    ],
  });
  const config = readConfig();
  assert.equal(config.periods.length, 2);
  assert.equal(config.periods[0].months, 2);
  assert.equal(config.periods[1].planId, 'max20');
});

test('the current location wins when both exist', () => {
  clear();
  write(LEGACY, { planId: 'max5', monthlyOverride: 90, seats: 3 });
  write(CURRENT, { periods: [{ planId: 'pro', monthlyOverride: null, seats: 1, months: null }] });
  assert.equal(readConfig().periods[0].planId, 'pro');
});

test('an unreadable legacy file falls through to the defaults rather than throwing', () => {
  // Someone hand-edited it, or half a write survived a crash. The page has to
  // render either way, and with a period in it to edit.
  clear();
  write(LEGACY, '{ this is not json');
  const config = readConfig();
  assert.equal(config.periods.length, 1);
  assert.equal(typeof config.periods[0].planId, 'string');
  assert.ok(config.periods[0].seats >= 1);
});

test('saving writes the new location and never touches the old one', async () => {
  clear();
  write(LEGACY, { planId: 'max5', monthlyOverride: 90, seats: 3 });
  const before = fs.readFileSync(LEGACY, 'utf8');

  await writeConfig({ planId: 'max20' });

  assert.equal(fs.existsSync(CURRENT), true, 'the new location should now exist');
  assert.equal(fs.readFileSync(LEGACY, 'utf8'), before, 'the old file must be left alone');

  const saved = readConfig();
  assert.equal(saved.periods[0].planId, 'max20');
  // The patch named one field; the rest of the pre-rename config has to survive
  // it, or a rename plus a plan change silently drops the seat count.
  assert.equal(saved.periods[0].seats, 3);
  assert.equal(saved.periods[0].monthlyOverride, 90);
});

test('adding a period saves the whole list, and dropping one drops only it', async () => {
  clear();
  write(CURRENT, { periods: [{ planId: 'pro', monthlyOverride: null, seats: 1, months: 2 }] });

  await writeConfig({
    periods: [
      { planId: 'pro', months: 2 },
      { planId: 'max20', months: 3 },
    ],
  });
  assert.equal(readConfig().periods.length, 2);

  // A list patch replaces rather than merges — there is no sensible rule for
  // which stored row an incoming one corresponds to, and the editor always
  // knows the whole list it is asking for.
  await writeConfig({ periods: [{ planId: 'max20', months: 3 }] });
  const after = readConfig();
  assert.equal(after.periods.length, 1);
  assert.equal(after.periods[0].planId, 'max20');
});

test.after(async () => {
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(process.env.CLAUDE_HOME, { recursive: true, force: true });
});
