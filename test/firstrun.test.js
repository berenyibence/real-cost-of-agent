/**
 * The first run.
 *
 * Somebody clones this, starts it, and has never run Claude Code — or has, but
 * on another machine. That state is not an edge case, it is the first thing
 * anybody sees, and the failure it invites is quiet: an empty index divides by
 * zero in three places and produces a page full of `NaN` and `$—` rather than
 * an honest "there is nothing here yet".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-spend-empty-'));
process.env.CLAUDE_HOME = empty;

const { scan, claudeCodeFound } = await import('../server/scan.js');
const { spendBreakdown } = await import('../server/spend.js');
const { compareBilling } = await import('../server/billing.js');

test('a machine with no transcripts is detected rather than reported as free', () => {
  // The page needs to tell "you have spent nothing" apart from "I could not
  // find your transcripts", and only this flag can.
  assert.equal(claudeCodeFound(), false);
});

test('scanning nothing yields nothing, and does not throw', async () => {
  const { sessions, workspaces } = await scan();
  assert.deepEqual(sessions, []);
  assert.deepEqual(workspaces, []);
});

test('the whole payload is finite when there is no data at all', () => {
  const breakdown = spendBreakdown([], []);
  const billing = compareBilling({
    apiEquivalent: breakdown.total,
    firstAt: breakdown.firstAt,
    lastAt: breakdown.lastAt,
    config: { planId: 'max20', monthlyOverride: null, seats: 1 },
  });

  // `Math.min()` of an empty list is Infinity and `Math.max()` is -Infinity;
  // both survive JSON.stringify as `null` and then poison every comparison
  // downstream, which is why the bounds are asserted rather than assumed.
  assert.ok(Number.isFinite(breakdown.firstAt), `firstAt is ${breakdown.firstAt}`);
  assert.ok(Number.isFinite(breakdown.lastAt), `lastAt is ${breakdown.lastAt}`);
  assert.equal(breakdown.total, 0);
  assert.equal(breakdown.unpriced.sessions, 0);
  assert.deepEqual(breakdown.topSessions, []);

  for (const [key, value] of Object.entries(billing)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `billing.${key} is ${value}`);
  }
  assert.ok(billing.months >= 1, 'a subscription is never charged for zero months');
  assert.equal(billing.apiCreditsSpent, 0);
});

test('an empty index still serialises', () => {
  // The route JSON-stringifies this, and `Infinity` becomes `null` silently.
  const json = JSON.stringify(spendBreakdown([], []));
  assert.equal(json.includes('null'), false, json);
});

test.after(() => fsp.rm(empty, { recursive: true, force: true }));
