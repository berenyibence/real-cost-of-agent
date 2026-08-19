/**
 * The rate a request was billed at, end to end.
 *
 * `pricing.test.js` holds the rate card — what a model costs. This file holds
 * the other half of the same question: a model is not the whole rate. The same
 * Opus 5 request costs $5 or $10 per MTok depending on a `speed` field, and 10%
 * more again if inference was pinned to the US, and a web search alongside it is
 * charged per search and appears in no token count at all.
 *
 * All three arrive in the `usage` block Claude Code already writes, which is why
 * reading past them was a miscalculation rather than a missing feature. The
 * fixture is a transcript in the shape Claude Code writes; the assertions are
 * the arithmetic a real invoice would be checked against.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-spend-rates-'));
const projectDir = path.join(home, 'projects', '-Users-dev-checkout');
await fsp.mkdir(projectDir, { recursive: true });

const at = (min) => new Date(Date.UTC(2026, 0, 2, 10, min)).toISOString();

/** An assistant line with the full usage shape, modifiers included. */
const reply = (id, model, usage, minute) =>
  JSON.stringify({
    type: 'assistant',
    requestId: id,
    timestamp: at(minute),
    cwd: '/Users/dev/checkout',
    message: {
      id: `msg_${id}`,
      model,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: 'standard',
        speed: 'standard',
        inference_geo: 'not_available',
        ...usage,
      },
    },
  });

const TRANSCRIPT = [
  JSON.stringify({
    type: 'user',
    timestamp: at(0),
    cwd: '/Users/dev/checkout',
    message: { content: 'Price this correctly' },
  }),
  // $25: a million output tokens of standard Opus 5.
  reply('req_a', 'claude-opus-5', { output_tokens: 1_000_000 }, 1),
  // $50: the same million, after the user hit `/fast`.
  reply('req_b', 'claude-opus-5', { output_tokens: 1_000_000, speed: 'fast' }, 2),
  // $2.50 of tokens plus $1.00 of searches. The two fetches are free, and
  // charging for them would be inventing a rate.
  reply(
    'req_c',
    'claude-opus-5',
    {
      output_tokens: 100_000,
      server_tool_use: { web_search_requests: 100, web_fetch_requests: 2 },
    },
    3,
  ),
  // $5.50: a million Haiku output tokens at the 1.1x US-pinned rate.
  reply('req_d', 'claude-haiku-4-5-20251001', { output_tokens: 1_000_000, inference_geo: 'us' }, 4),
  // $27.50: Opus again, pinned. This one is here so that *one model* spans both
  // modifiers — standard/global, fast/global and standard/us. Without it the
  // model alone separated every rate in this fixture, and keying the slice on
  // model+speed but not geography passed the whole suite.
  reply('req_e', 'claude-opus-5', { output_tokens: 1_000_000, inference_geo: 'us' }, 5),
].join('\n');

await fsp.writeFile(
  path.join(projectDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'),
  TRANSCRIPT,
);

process.env.CLAUDE_HOME = home;
const { scan } = await import('../server/scan.js');
const { withEconomics } = await import('../server/store.js');
const { spendBreakdown } = await import('../server/spend.js');
const { costOf } = await import('../server/models.js');

const { sessions, workspaces } = await scan();
const priced = sessions.map(withEconomics);
const session = priced[0];
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

test('requests are kept apart by rate, not only by model', () => {
  const slices = session.usageByModel;
  assert.equal(slices.length, 4, 'four rates ran, so there are four slices');

  const opus = (speed, geo) =>
    slices.find((s) => s.model === 'claude-opus-5' && s.speed === speed && s.inferenceGeo === geo);

  // Two requests at the same rate do fold together — the split is by rate, not
  // one slice per request.
  assert.equal(opus('standard', 'global').requests, 2);
  assert.equal(opus('standard', 'global').outputTokens, 1_100_000);

  // Both modifiers split the same model apart, independently of each other.
  assert.equal(opus('fast', 'global').requests, 1);
  assert.equal(opus('fast', 'global').outputTokens, 1_000_000);
  assert.equal(opus('standard', 'us').requests, 1);
  assert.equal(opus('standard', 'us').outputTokens, 1_000_000);

  const haiku = slices.find((s) => s.model === 'claude-haiku-4-5-20251001');
  assert.equal(haiku.inferenceGeo, 'us');
});

test('searches are counted, and fetches are not', () => {
  // Both arrive in the same `server_tool_use` block. One is $10 per 1,000 and
  // the other is published at no charge, so treating them alike would be wrong
  // in one direction or the other whichever way it went.
  assert.equal(session.usage.webSearchRequests, 100);
  assert.equal(session.usage.webFetchRequests, undefined);
});

test('the session total is the sum of what each rate actually costs', () => {
  // 25 standard Opus + 50 fast Opus + 2.50 Opus tokens + 1.00 of searches
  // + 27.50 pinned Opus + 5.50 pinned Haiku.
  assert.ok(near(session.economics.cost, 111.5), `cost is ${session.economics.cost}`);
});

test('the naive reading — one model, one rate, tokens only — is measurably lower', () => {
  // What this app did before: every token at the primary model's standard rate,
  // and no searches at all. It is not a rounding difference.
  const naive = costOf('claude-opus-5', { outputTokens: session.usage.outputTokens });
  assert.ok(near(naive, 102.5), `naive is ${naive}`);
  assert.ok(session.economics.cost > naive);
});

test('the session is still described by the model that did the most work', () => {
  assert.equal(session.modelSpec.id, 'claude-opus-5');
  assert.equal(session.economics.mixedModels, true);
});

test('the primary model is the one with the most requests, not the biggest slice', () => {
  // Splitting a model across rates broke the old reading of this. It picked the
  // largest single slice, which was equivalent while a model could only have one
  // — and once `/fast` splits Opus in two, the biggest slice can belong to a
  // model that did less of the work. `byModel` attributes the whole session to
  // whatever this returns, so getting it wrong moves real money between models.
  const zero = {
    inputTokens: 0,
    outputTokens: 1_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    webSearchRequests: 0,
  };
  const split = withEconomics({
    model: 'claude-haiku-4-5',
    usage: { ...zero, outputTokens: 7_000 },
    peakContext: 1_000,
    usageByModel: [
      // Opus did four requests, but across two rates — so its largest slice is
      // smaller than Haiku's single slice of three.
      { model: 'claude-opus-5', speed: 'standard', inferenceGeo: 'global', requests: 2, ...zero },
      { model: 'claude-opus-5', speed: 'fast', inferenceGeo: 'global', requests: 2, ...zero },
      { model: 'claude-haiku-4-5', speed: 'standard', inferenceGeo: 'global', requests: 3, ...zero },
    ],
  });
  assert.equal(split.modelSpec.id, 'claude-opus-5');
});

test('every breakdown of these rates still adds up to the same total', () => {
  const b = spendBreakdown(priced, workspaces);
  const sum = (rows) => rows.reduce((t, r) => t + r.cost, 0);
  for (const key of ['components', 'byModel', 'byProject', 'byDay']) {
    assert.ok(near(sum(b[key]), b.total, 1e-6), `${key} sums to ${sum(b[key])}`);
  }
  assert.ok(near(b.total, 111.5));
  assert.equal(b.unpriced.sessions, 0);

  const searches = b.components.find((c) => c.id === 'webSearch');
  assert.equal(searches.count, 100);
  assert.ok(near(searches.cost, 1));
});

test('a search is not a token, and does not become one anywhere', () => {
  // The token columns have to keep totalling tokens: a $1 charge quietly folded
  // into "output" would balance the books and lie about what was bought.
  const b = spendBreakdown(priced, workspaces);
  const tokens = b.components
    .filter((c) => c.unit === 'tokens')
    .reduce((t, c) => t + c.count, 0);
  assert.equal(tokens, 4_100_000);
});

test.after(() => fsp.rm(home, { recursive: true, force: true }));
