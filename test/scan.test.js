/**
 * Reading a transcript, and pricing what was read.
 *
 * Everything this app says is downstream of one thing: the `usage` block on each
 * assistant reply, added up correctly. So the fixture below is a transcript in
 * the shape Claude Code actually writes — including a torn last line, a session
 * that switched models mid-run, and a cache write with no TTL breakdown — and
 * the assertions are about the arithmetic that a real bill would be checked
 * against.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/* `scan.js` resolves CLAUDE_HOME when it is imported, so the fixture has to
   exist and the variable has to be set before the dynamic import below. */
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-spend-test-'));
const projectDir = path.join(home, 'projects', '-Users-dev-checkout');
await fsp.mkdir(projectDir, { recursive: true });

const at = (min) => new Date(Date.UTC(2026, 0, 2, 10, min)).toISOString();

const reply = (model, usage, minute) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(minute),
    cwd: '/Users/dev/checkout',
    message: { model, usage },
  });

const TRANSCRIPT = [
  JSON.stringify({
    type: 'user',
    timestamp: at(0),
    cwd: '/Users/dev/checkout',
    message: { content: 'Make the spend page standalone' },
  }),
  reply(
    'claude-opus-5',
    {
      input_tokens: 1_000,
      output_tokens: 2_000,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 10_000,
      cache_creation: { ephemeral_1h_input_tokens: 8_000, ephemeral_5m_input_tokens: 2_000 },
    },
    1,
  ),
  // A tool result comes back as a user message and is not a prompt anybody typed.
  JSON.stringify({
    type: 'user',
    timestamp: at(2),
    message: { content: [{ type: 'tool_result', content: 'ok' }] },
  }),
  // Same session, different model, and no TTL breakdown on the cache write.
  reply(
    'claude-haiku-4-5-20251001',
    {
      input_tokens: 500,
      output_tokens: 300,
      cache_read_input_tokens: 20_000,
      cache_creation_input_tokens: 4_000,
    },
    3,
  ),
  // A synthetic reply carries no real model and must not become one.
  JSON.stringify({
    type: 'assistant',
    timestamp: at(4),
    message: { model: '<synthetic>', usage: { input_tokens: 10, output_tokens: 10 } },
  }),
  '{"type":"assistant","message":{"model":"claude-op', // torn mid-write
].join('\n');

await fsp.writeFile(
  path.join(projectDir, '11111111-2222-3333-4444-555555555555.jsonl'),
  TRANSCRIPT,
);

process.env.CLAUDE_HOME = home;
const { scan } = await import('../server/scan.js');
const { withEconomics } = await import('../server/store.js');
const { spendBreakdown } = await import('../server/spend.js');
const { costOf } = await import('../server/models.js');

const { sessions, workspaces } = await scan();

test('a transcript becomes exactly one session', () => {
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, '11111111-2222-3333-4444-555555555555');
});

test('a torn last line is skipped rather than throwing away the file', () => {
  // Transcripts are read while the agent is still appending to them, so a half
  // written final line is the normal case, not corruption.
  assert.equal(sessions[0].requests, 3);
});

test('token counts are the sum of every reply', () => {
  const u = sessions[0].usage;
  assert.equal(u.inputTokens, 1_510);
  assert.equal(u.outputTokens, 2_310);
  assert.equal(u.cacheReadTokens, 70_000);
  assert.equal(u.cacheWriteTokens, 14_000);
});

test('cache writes keep their TTL split, because the multipliers differ', () => {
  // 1.25x for 5m against 2x for 1h. Collapsing them understates or overstates a
  // heavy session by a third.
  const u = sessions[0].usage;
  assert.equal(u.cacheWrite1h, 8_000);
  // The 4,000 with no breakdown lands on 5m: the cheaper, default TTL, so an
  // unknown can never inflate the bill.
  assert.equal(u.cacheWrite5m, 6_000);
  assert.equal(u.cacheWrite5m + u.cacheWrite1h, u.cacheWriteTokens);
});

test('usage is kept apart by the model that served it', () => {
  const slices = sessions[0].usageByModel;
  assert.equal(slices.length, 2, 'a synthetic reply must not open a third slice');
  const opus = slices.find((s) => s.model === 'claude-opus-5');
  const haiku = slices.find((s) => s.model === 'claude-haiku-4-5-20251001');
  assert.equal(opus.outputTokens, 2_000);
  // A synthetic reply names no model, so its tokens bill to the last real one
  // rather than opening an "unknown" slice that nothing can price.
  assert.equal(haiku.outputTokens, 310);
  assert.equal(opus.requests + haiku.requests, 3);
});

test('peak context is the largest single turn, not the session total', () => {
  // 1,000 fresh + 50,000 read + 10,000 written on the first reply.
  assert.equal(sessions[0].peakContext, 61_000);
});

test('the session is named by the first thing the human typed', () => {
  assert.equal(sessions[0].title, 'Make the spend page standalone');
  assert.equal(sessions[0].cwd, '/Users/dev/checkout');
});

test('the project is derived from the transcript, not the slugified directory', () => {
  // `-Users-dev-checkout` decodes lossily, so the cwd recorded inside the file
  // wins whenever there is one.
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].name, 'checkout');
  assert.equal(workspaces[0].path, '/Users/dev/checkout');
});

/* ------------------------------------------------------------------ *
 * End to end: parsed tokens, priced
 * ------------------------------------------------------------------ */

const priced = sessions.map(withEconomics);

test('a mixed session is priced per slice rather than at one rate', () => {
  const slices = priced[0].usageByModel;
  const expected = slices.reduce((total, s) => total + costOf(s.model, s), 0);
  assert.ok(Math.abs(priced[0].economics.cost - expected) < 1e-9);
  // And that actually differs from charging everything at the headline model —
  // otherwise this test would pass on a broken implementation.
  assert.notEqual(expected, costOf('claude-opus-5', priced[0].usage));
});

test('the breakdown of a real transcript adds up to its own total', () => {
  const b = spendBreakdown(priced, workspaces);
  const sum = (rows) => rows.reduce((t, r) => t + r.cost, 0);
  for (const key of ['components', 'byModel', 'byProject', 'byDay']) {
    assert.ok(Math.abs(sum(b[key]) - b.total) < 1e-9, `${key} sums to ${sum(b[key])}`);
  }
  assert.ok(b.total > 0);
  assert.equal(b.unpriced.sessions, 0);
});

test.after(() => fsp.rm(home, { recursive: true, force: true }));
