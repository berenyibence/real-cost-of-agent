/**
 * What one bad clock does to the day axis.
 *
 * A transcript can carry a timestamp in the future — a machine with a skewed
 * clock writes them, and so does a `~/.claude` copied off one. That single
 * value used to reach all the way into the by-day breakdown and take most of
 * the money with it:
 *
 * `spendBreakdown` built the day list by walking `eachDay(first, last)` and
 * looking each date up, which made the *axis* the authority on which days
 * existed. `eachDay` stops after `MAX_SPAN_DAYS`, so a last day eleven years
 * out meant every real bucket past the cap was dropped — **71% of the total
 * vanished from that cut** in the case below, under a heading promising a
 * breakdown, while every other cut still agreed with the total. That is
 * invariant 1 failing silently, which is the failure this project exists for.
 *
 * Two things hold it now, and both are tested here: the buckets are the
 * authority and the filler is added around them, and the scanner refuses to
 * record a session as having ended after now.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'rcoa-clock-'));
process.env.CLAUDE_HOME = HOME;

const { scan } = await import('../server/scan.js');
const { spendBreakdown } = await import('../server/spend.js');

const priced = (endedAt, cost) => ({
  id: `s${endedAt}`,
  workspaceId: 'w',
  title: 'a run',
  cwd: '/x',
  startedAt: endedAt,
  endedAt,
  modelSpec: { id: 'claude-opus-5', name: 'Opus 5', tier: 'opus', inferred: false },
  economics: { cost, uncachedCost: cost * 2, saved: cost, cacheHitRate: 0, context: null },
  usage: {
    inputTokens: 10,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    webSearchRequests: 0,
  },
  usageByModel: [],
  requests: 1,
});

test('a day that cost money keeps its row however far the axis has to reach', () => {
  const breakdown = spendBreakdown(
    [
      priced(Date.parse('2026-08-01T12:00:00Z'), 100),
      // Past `MAX_SPAN_DAYS` from the first day, so the filler gives up long
      // before it gets here. The bucket still has to survive.
      priced(Date.parse('2099-01-01T00:00:00Z'), 250),
    ],
    [],
  );

  const sum = breakdown.byDay.reduce((n, row) => n + row.cost, 0);
  assert.ok(
    Math.abs(sum - breakdown.total) < 1e-9,
    `byDay sums to ${sum}, total is ${breakdown.total}`,
  );

  const earning = breakdown.byDay.filter((d) => d.cost > 0).map((d) => d.date);
  assert.deepEqual(earning, ['2026-08-01', '2099-01-01']);
});

test('an ordinary history is still an even axis, idle days included', () => {
  const breakdown = spendBreakdown(
    [
      priced(Date.parse('2026-08-01T12:00:00Z'), 10),
      priced(Date.parse('2026-08-05T12:00:00Z'), 20),
    ],
    [],
  );
  // The gap is the point of the filler: a week off is the most visible thing in
  // a spend chart, and only empty columns can show it.
  assert.deepEqual(
    breakdown.byDay.map((d) => d.date),
    ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'],
  );
  assert.equal(breakdown.byDay.filter((d) => d.cost === 0).length, 3);
});

test('a session cannot have ended in the future', async () => {
  const dir = path.join(HOME, 'projects', '-Users-dev-skewed');
  await fsp.mkdir(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'),
    `${JSON.stringify({
      type: 'assistant',
      requestId: 'req_future',
      timestamp: '2099-01-01T00:00:00.000Z',
      cwd: '/Users/dev/skewed',
      message: {
        id: 'msg_future',
        model: 'claude-opus-5',
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    })}\n`,
  );

  const before = Date.now();
  const { sessions } = await scan();
  const after = Date.now();

  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.ok(
    session.endedAt >= before && session.endedAt <= after,
    `endedAt ${new Date(session.endedAt).toISOString()} should have been clamped to now`,
  );
  assert.ok(session.startedAt <= session.endedAt, 'a run cannot start after it ends');
  // The work itself is untouched — only the clock claim was.
  assert.equal(session.requests, 1);
  assert.equal(session.usage.inputTokens, 100);

  await fsp.rm(HOME, { recursive: true, force: true });
});
