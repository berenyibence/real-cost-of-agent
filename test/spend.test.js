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

test('components still carry their counts, whatever the model mix', () => {
  const s = session({
    usageByModel: [
      { model: OPUS, requests: 1, ...usage({ outputTokens: 300 }) },
      { model: HAIKU, requests: 1, ...usage({ outputTokens: 700 }) },
    ],
  });
  const output = componentsOf(s).find((c) => c.id === 'output');
  assert.equal(output.count, 1000);
  assert.equal(output.unit, 'tokens');
});

test('the same model at two rates is decomposed at both of them', () => {
  // A `/fast` toggle mid-run splits one model into two slices at two prices. The
  // components used to read the rate off the model's catalog entry, which would
  // put the fast half back at the standard rate and leave the column
  // disagreeing with the total above it — the exact failure componentsOf exists
  // to prevent, arriving by a new route.
  const s = session({
    model: OPUS,
    usage: usage({ outputTokens: 2_000_000 }),
    usageByModel: [
      { model: OPUS, speed: 'standard', requests: 5, ...usage({ outputTokens: 1_000_000 }) },
      { model: OPUS, speed: 'fast', requests: 5, ...usage({ outputTokens: 1_000_000 }) },
    ],
  });
  // $25/MTok standard plus $50/MTok fast.
  assert.ok(near(s.economics.cost, 75), `cost is ${s.economics.cost}`);
  assert.ok(near(sum(componentsOf(s)), s.economics.cost));
});

test('searches are a component, so the breakdown still accounts for them', () => {
  // Web search is billed per search rather than per token. Leaving it out of the
  // components would be a charge in the total that no column explains; leaving
  // it out of the total would be money spent on this machine that the page never
  // mentions.
  const s = session({
    usage: { ...usage({ outputTokens: 1_000 }), webSearchRequests: 300 },
    usageByModel: [
      {
        model: OPUS,
        requests: 3,
        ...usage({ outputTokens: 1_000 }),
        webSearchRequests: 300,
      },
    ],
  });
  const searches = componentsOf(s).find((c) => c.id === 'webSearch');
  assert.equal(searches.count, 300);
  assert.equal(searches.unit, 'searches');
  assert.ok(near(searches.cost, 3));
  assert.ok(near(sum(componentsOf(s)), s.economics.cost));

  const b = spendBreakdown([s], []);
  for (const key of ['components', 'byModel', 'byProject', 'bySource', 'byDay', 'bySession']) {
    assert.ok(near(sum(b[key]), b.total, 1e-6), `${key} sums to ${sum(b[key])}`);
  }
});

test('a session with no model spec contributes no components', () => {
  assert.deepEqual(componentsOf({ usage: usage(), modelSpec: null }), []);
});

/* ------------------------------------------------------------------ *
 * The whole breakdown
 * ------------------------------------------------------------------ */

test('every breakdown adds up to the same total', () => {
  const sessions = [
    // Two agents and one session that names none, because a payload written
    // before sources existed still has to land somewhere: an undefined source
    // that fell out of `bySource` would leave that cut short of the total while
    // every other cut still agreed with it.
    session({ id: 'a', workspaceId: 'w1', source: 'agent-1' }),
    session({ id: 'b', workspaceId: 'w2', model: HAIKU, source: 'agent-2' }),
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

  for (const key of ['components', 'byModel', 'byProject', 'bySource', 'byDay', 'bySession']) {
    assert.ok(
      near(sum(b[key]), b.total, 1e-6),
      `${key} sums to ${sum(b[key])}, total is ${b.total}`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * The session cut
 *
 * This was a top twelve, which made it the one cut that did not sum to the
 * total. The tests below are what stops it going back: the list is complete, it
 * carries the token counts its dollars were derived from, and those counts agree
 * with the components cut that splits the same tokens the other way.
 * ------------------------------------------------------------------ */

test('every priced session gets a row, not just the loudest few', () => {
  // Comfortably more than the old cap of 12, and more than the page reveals at
  // once — neither of which is allowed to decide what the payload contains.
  const sessions = Array.from({ length: 40 }, (_, i) =>
    session({
      id: `s${i}`,
      workspaceId: `w${i % 3}`,
      // Descending, so a truncating implementation keeps the expensive rows and
      // drops the cheap tail — the exact shape that looks right until you total it.
      usage: usage({ inputTokens: 1000 * (40 - i), outputTokens: 500 * (40 - i) }),
    }),
  );
  const b = spendBreakdown(sessions, []);

  assert.equal(b.bySession.length, 40, 'a session is missing from the list');
  assert.ok(
    near(sum(b.bySession), b.total, 1e-6),
    `bySession sums to ${sum(b.bySession)}, total is ${b.total}`,
  );
  // The cheapest session is the one a cap would have dropped.
  assert.ok(
    b.bySession.some((r) => r.id === 's39'),
    'the cheapest session has no row anywhere',
  );
});

test('a session row carries the token counts its cost was computed from', () => {
  const b = spendBreakdown(
    [
      session({
        id: 'detailed',
        requests: 42,
        title: 'A named run',
        usage: usage({
          inputTokens: 1_000,
          outputTokens: 2_000,
          cacheReadTokens: 50_000,
          cacheWriteTokens: 7_000,
          cacheWrite5m: 7_000,
          webSearchRequests: 3,
        }),
      }),
    ],
    [],
  );
  const row = b.bySession[0];

  assert.equal(row.input, 1_000);
  assert.equal(row.output, 2_000);
  assert.equal(row.cacheRead, 50_000);
  assert.equal(row.cacheWrite, 7_000);
  assert.equal(row.searches, 3);
  assert.equal(row.requests, 42, 'the API call count is measured and must not be dropped');
  // `tokens` means all four kinds added together everywhere else on this
  // payload, and searches are not tokens — so they are not in it.
  assert.equal(row.tokens, 60_000);
});

test('every bucket carries the token split, not just a dollar figure', () => {
  const sessions = [
    session({ id: 'a', workspaceId: 'w1', usage: usage({ inputTokens: 900, outputTokens: 300 }) }),
    session({
      id: 'b',
      workspaceId: 'w2',
      model: HAIKU,
      usage: usage({ outputTokens: 1_200, cacheReadTokens: 20_000 }),
    }),
  ];
  const b = spendBreakdown(sessions, []);

  // A model row that shows only dollars cannot say why that model is the
  // expensive one, which is the only question the row provokes.
  for (const key of ['byModel', 'byProject', 'bySource', 'byDay']) {
    for (const row of b[key]) {
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'searches']) {
        assert.equal(typeof row[field], 'number', `${key} row is missing ${field}`);
      }
      // `tokens` is the total of the split it sits beside, not a separate tally
      // that can drift from it.
      assert.equal(row.tokens, row.input + row.output + row.cacheRead + row.cacheWrite);
    }
  }

  assert.equal(sum(b.byModel, 'output'), 1_500);
  assert.equal(sum(b.byModel, 'input'), 900);
  assert.equal(sum(b.byProject, 'cacheRead'), 20_000);
});

test('the token counts on a session agree with the components cut', () => {
  const sessions = [
    session({ id: 'a', usage: usage({ inputTokens: 900, outputTokens: 300, cacheReadTokens: 8_000 }) }),
    session({
      id: 'b',
      model: HAIKU,
      usage: usage({ outputTokens: 1_200, cacheWriteTokens: 4_000, cacheWrite5m: 4_000 }),
    }),
  ];
  const b = spendBreakdown(sessions, []);
  const count = (id) => b.components.find((c) => c.id === id).count;

  // Two different splits of the same tokens: one per session, one per billing
  // kind. If they disagree, one of the two views is describing usage that was
  // never recorded.
  assert.equal(sum(b.bySession, 'input'), count('input'));
  assert.equal(sum(b.bySession, 'output'), count('output'));
  assert.equal(sum(b.bySession, 'cacheRead'), count('cacheRead'));
  assert.equal(sum(b.bySession, 'cacheWrite'), count('cacheWrite5m') + count('cacheWrite1h'));
  assert.equal(sum(b.bySession, 'searches'), count('webSearch'));
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
