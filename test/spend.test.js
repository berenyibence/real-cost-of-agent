import assert from 'node:assert/strict';
import test from 'node:test';
import { componentsOf, spendBreakdown } from '../server/spend.js';
import { costOf, lookupModel, uncachedCostOf } from '../server/models.js';

/* ------------------------------------------------------------------ *
 * Where the money went
 *
 * Every breakdown here splits the same dollars a different way, so the property
 * that matters is not any single figure — it is that all of them add up to the
 * same total. A column that quietly uses different arithmetic from the number
 * above it is the worst way for a money view to be wrong, because nothing on
 * screen suggests you should check.
 * ------------------------------------------------------------------ */

const OPUS = 'claude-opus-5';
const HAIKU = 'claude-haiku-4-5-20251001';

const usage = (over = {}) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  ...over,
});

/** A session shaped the way the store hands them to spend.js. */
function session(over = {}) {
  const model = over.model ?? OPUS;
  const use =
    over.usage ?? usage({ inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 50_000 });
  const slices = over.usageByModel ?? null;
  const cost = slices
    ? slices.reduce((t, s) => t + (costOf(s.model, s) ?? 0), 0)
    : (costOf(model, use) ?? 0);
  return {
    id: 'ses-1',
    workspaceId: 'w1',
    model,
    modelSpec: lookupModel(model),
    usage: use,
    usageByModel: slices,
    endedAt: Date.now(),
    economics: {
      cost,
      uncachedCost: slices
        ? slices.reduce((t, s) => t + (uncachedCostOf(s.model, s) ?? 0), 0)
        : (uncachedCostOf(model, use) ?? 0),
    },
    ...over,
  };
}

const sum = (rows, key = 'cost') => rows.reduce((t, r) => t + (r[key] ?? 0), 0);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

test('the components of a single-model session sum to its cost', () => {
  const s = session();
  assert.ok(near(sum(componentsOf(s)), s.economics.cost));
});

test('a session that switched models prices each slice at its own rate', () => {
  // The bug this exists for: components used to charge the whole token count at
  // the session's *primary* model, while the total priced each slice
  // separately. The components then added up to more than the total they were
  // decomposing — by 8.5% on a real index, and by more the more a run switched.
  const s = session({
    model: OPUS,
    usage: usage({ inputTokens: 2000, outputTokens: 4000, cacheReadTokens: 100_000 }),
    usageByModel: [
      {
        model: OPUS,
        requests: 10,
        ...usage({ inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 50_000 }),
      },
      {
        model: HAIKU,
        requests: 10,
        ...usage({ inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 50_000 }),
      },
    ],
  });
  assert.ok(
    near(sum(componentsOf(s)), s.economics.cost, 1e-6),
    `components ${sum(componentsOf(s))} vs total ${s.economics.cost}`,
  );
});

test('pricing a mixed session at one model is measurably wrong', () => {
  // Confirms the two rates actually differ, so the test above is not passing
  // because the models happen to cost the same.
  const mixed = usage({ inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 50_000 });
  assert.notEqual(costOf(OPUS, mixed), costOf(HAIKU, mixed));
});

test('components still carry their token counts, whatever the model mix', () => {
  const s = session({
    usageByModel: [
      { model: OPUS, requests: 1, ...usage({ outputTokens: 300 }) },
      { model: HAIKU, requests: 1, ...usage({ outputTokens: 700 }) },
    ],
  });
  const output = componentsOf(s).find((c) => c.id === 'output');
  assert.equal(output.tokens, 1000);
});

test('a session with no model spec contributes no components', () => {
  assert.deepEqual(componentsOf({ usage: usage(), modelSpec: null }), []);
});

/* ------------------------------------------------------------------ *
 * The whole breakdown
 * ------------------------------------------------------------------ */

test('every breakdown adds up to the same total', () => {
  const sessions = [
    session({ id: 'a', workspaceId: 'w1' }),
    session({ id: 'b', workspaceId: 'w2', model: HAIKU }),
    session({
      id: 'c',
      workspaceId: 'w1',
      usageByModel: [
        { model: OPUS, requests: 4, ...usage({ inputTokens: 500, outputTokens: 900 }) },
        { model: HAIKU, requests: 6, ...usage({ inputTokens: 800, outputTokens: 300 }) },
      ],
    }),
  ];
  const workspaces = [
    { id: 'w1', name: 'one' },
    { id: 'w2', name: 'two' },
  ];
  const b = spendBreakdown(sessions, workspaces);

  for (const key of ['components', 'byModel', 'byProject', 'byDay']) {
    assert.ok(
      near(sum(b[key]), b.total, 1e-6),
      `${key} sums to ${sum(b[key])}, total is ${b.total}`,
    );
  }
});

test('caching saved is the gap between what was billed and the uncached price', () => {
  const b = spendBreakdown([session()], []);
  assert.ok(near(b.uncached - b.total, b.saved, 1e-6));
  assert.ok(b.saved >= 0, 'caching cannot cost more than not caching');
});

test('a session without economics is skipped rather than counted as free', () => {
  const b = spendBreakdown([session(), { id: 'no-econ', usage: usage() }], []);
  const only = spendBreakdown([session()], []);
  assert.equal(b.total, only.total);
});

test('an empty index produces zeroes, not NaN', () => {
  const b = spendBreakdown([], []);
  assert.equal(b.total, 0);
  assert.ok(Number.isFinite(b.uncached));
  assert.ok(Number.isFinite(b.saved));
  for (const c of b.components) assert.ok(Number.isFinite(c.cost), `${c.id} is ${c.cost}`);
});
