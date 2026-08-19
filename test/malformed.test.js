/**
 * Transcripts are written by another program, and this one does not get to
 * assume they are well formed.
 *
 * `scan.js` already survives a torn line and an unreadable file. What it did not
 * survive was a *well-formed* line carrying a badly-typed value: a transcript
 * recording `"model": 12345` — which a proxy or a gateway is entirely free to
 * write — reached `String.prototype.replace` on a number inside `lookupModel`
 * and threw.
 *
 * That throw did not stay local. `withEconomics` is mapped over every session in
 * `store.js`, outside the scanner's per-transcript `try`, so one malformed id
 * anywhere on disk emptied **the whole index** and the page rendered nothing.
 * The correct outcome is the one invariant 5 already describes: an id that says
 * nothing usable is excluded, counted in `unpriced`, and every other session is
 * priced as normal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupModel, requestRates, costOf, uncachedCostOf } from '../server/models.js';
import { withEconomics } from '../server/store.js';
import { spendBreakdown } from '../server/spend.js';

/** Values a JSON field can hold that are not the string this code wants. */
const NOT_A_MODEL_ID = [12345, -1, Infinity, -Infinity, true, {}, [], { id: 'claude-opus-5' }];

const usage = () => ({
  inputTokens: 1_000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  webSearchRequests: 0,
});

const session = (model) => ({
  id: `s-${String(model)}`,
  workspaceId: 'w',
  title: 'a run',
  cwd: '/x',
  startedAt: Date.parse('2026-08-01T10:00:00Z'),
  endedAt: Date.parse('2026-08-01T10:05:00Z'),
  model,
  usage: usage(),
  usageByModel: [{ model, speed: 'standard', inferenceGeo: 'global', requests: 1, ...usage() }],
  peakContext: 1_000,
  requests: 1,
});

test('a model id that is not a string is unpriced rather than fatal', () => {
  for (const value of NOT_A_MODEL_ID) {
    assert.doesNotThrow(() => lookupModel(value), `lookupModel(${String(value)})`);
    assert.equal(lookupModel(value), null, `${String(value)} names no model`);
    assert.equal(requestRates(value), null);
    assert.equal(costOf(value, usage()), null);
    assert.equal(uncachedCostOf(value, usage()), null);
  }
});

test('one malformed session does not empty the index for every other session', () => {
  const good = session('claude-opus-5');
  const sessions = [...NOT_A_MODEL_ID.map(session), good].map(withEconomics);

  const priced = sessions.filter((s) => s.economics);
  assert.equal(priced.length, 1, 'the good session is still priced');
  assert.ok(priced[0].economics.cost > 0);

  const breakdown = spendBreakdown(sessions, []);
  // Excluded *and counted*, which is the difference between a caveat and a hole.
  assert.equal(breakdown.unpriced.sessions, NOT_A_MODEL_ID.length);
  assert.ok(breakdown.unpriced.tokens > 0, 'the tokens it left out are reported');
  assert.ok(Math.abs(breakdown.total - priced[0].economics.cost) < 1e-9);

  for (const cut of ['components', 'byModel', 'byProject', 'byDay', 'bySession']) {
    const sum = breakdown[cut].reduce((n, row) => n + row.cost, 0);
    assert.ok(Math.abs(sum - breakdown.total) < 1e-9, `${cut} still sums to the total`);
  }
});

test('a string that merely looks wrong is still handled, not thrown at', () => {
  // The point is that nothing here throws; what each resolves to is invariant 5's
  // business, asserted in `test/pricing.test.js`.
  for (const value of ['', '   ', 'gpt-4o', 'claude-', 'anthropic.', '<synthetic>', 'unknown']) {
    assert.doesNotThrow(() => lookupModel(value), `lookupModel(${JSON.stringify(value)})`);
  }
});
