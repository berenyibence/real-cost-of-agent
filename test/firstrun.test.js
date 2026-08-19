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
  assert.deepEqual(breakdown.bySession, []);

  for (const [key, value] of Object.entries(billing)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `billing.${key} is ${value}`);
  }
  assert.ok(billing.months >= 1, 'a subscription is never charged for zero months');
  // Nothing to price means nothing to conclude, and in particular not that the
  // plan is bad value — which is what a naive ratio would say about $0 of usage.
  assert.equal(billing.verdict, 'no-usage');
  assert.equal(billing.apiEquivalent, 0);
});

test('an empty index still serialises', () => {
  // The route JSON-stringifies this, and `Infinity` becomes `null` silently.
  const json = JSON.stringify(spendBreakdown([], []));
  assert.equal(json.includes('null'), false, json);
});

test.after(() => fsp.rm(empty, { recursive: true, force: true }));

/* ------------------------------------------------------------------ *
 * The state between "nothing installed" and "something to show"
 * ------------------------------------------------------------------ */

test('an empty projects directory is a third state, not the same as no directory', async () => {
  /**
   * `claudeCodeFound()` only ever meant "the directory is there". A fresh Claude
   * Code install creates `~/.claude/projects` before it writes any transcript
   * into it, and so does clearing the folder out — and in that state the page
   * skipped its empty state entirely and rendered a comparison of zeros: six $0
   * component rows, a chart with no columns under two blank axis labels, and a
   * plan panel arguing about nothing.
   *
   * The page needs to tell three things apart, so the payload has to carry
   * enough to do it: no directory, a directory with nothing in it, and real
   * work. This asserts the two flags it decides on.
   */
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'rcoa-firstrun-'));
  await fsp.mkdir(path.join(home, 'projects'), { recursive: true });

  const previous = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = home;
  // `scan.js` resolves CLAUDE_HOME at import, so this needs its own module copy.
  const scanner = await import(`../server/scan.js?empty-projects=${Date.now()}`);

  assert.equal(scanner.claudeCodeFound(), true, 'the directory exists');
  const { sessions, workspaces } = await scanner.scan();
  assert.deepEqual(sessions, [], 'and holds no transcripts');
  assert.deepEqual(workspaces, []);

  // Together these two are what the page branches on: found-but-empty is the
  // case that used to fall through to the dashboard.
  const breakdown = spendBreakdown(sessions, workspaces);
  assert.equal(breakdown.total, 0);
  assert.deepEqual(breakdown.byDay, [], 'no days to draw a chart from');

  process.env.CLAUDE_HOME = previous;
  await fsp.rm(home, { recursive: true, force: true });
});
