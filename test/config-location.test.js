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
  write(LEGACY, { planId: 'max5', monthlyOverride: 90, seats: 3 });
  assert.deepEqual(readConfig(), { planId: 'max5', monthlyOverride: 90, seats: 3 });
});

test('the current location wins when both exist', () => {
  clear();
  write(LEGACY, { planId: 'max5', monthlyOverride: 90, seats: 3 });
  write(CURRENT, { planId: 'pro', monthlyOverride: null, seats: 1 });
  assert.equal(readConfig().planId, 'pro');
});

test('an unreadable legacy file falls through to the defaults rather than throwing', () => {
  // Someone hand-edited it, or half a write survived a crash. The page has to
  // render either way.
  clear();
  write(LEGACY, '{ this is not json');
  const config = readConfig();
  assert.equal(typeof config.planId, 'string');
  assert.ok(config.seats >= 1);
});

test('saving writes the new location and never touches the old one', async () => {
  clear();
  write(LEGACY, { planId: 'max5', monthlyOverride: 90, seats: 3 });
  const before = fs.readFileSync(LEGACY, 'utf8');

  await writeConfig({ planId: 'max20' });

  assert.equal(fs.existsSync(CURRENT), true, 'the new location should now exist');
  assert.equal(fs.readFileSync(LEGACY, 'utf8'), before, 'the old file must be left alone');
  assert.equal(readConfig().planId, 'max20');
  // The patch named one field; the rest of the pre-rename config has to survive
  // it, or a rename plus a plan change silently drops the seat count.
  assert.equal(readConfig().seats, 3);
  assert.equal(readConfig().monthlyOverride, 90);
});

test.after(async () => {
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(process.env.CLAUDE_HOME, { recursive: true, force: true });
});
