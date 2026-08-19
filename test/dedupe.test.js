/**
 * One API call is billed once, however many lines it was written as.
 *
 * Claude Code writes an assistant turn as one line per content block — a
 * `thinking` block, then one per `tool_use` — and every one of those lines
 * carries a complete copy of the *same* `usage` object. Adding usage up line by
 * line therefore charges a request once per content block it happened to
 * contain.
 *
 * That is not a hypothetical. On the corpus this was written against it was
 * 21,131 lines for 10,422 real calls, and the total came out at $6,091 against a
 * true $2,490 — overstated by 2.45x. The fixture below is that shape, copied
 * from a real transcript: three lines, one `requestId`, one `message.id`, one
 * identical usage block on each.
 *
 * Halving a bill is the kind of correction that ought to be doubted, so here is
 * the evidence, re-measured on 20,689 usage-bearing lines / 10,310 distinct
 * `message.id`s:
 *
 *   1. **Context cannot stand still.** Call N's reply is appended to the
 *      messages before call N+1 is sent, so consecutive calls in one session
 *      must read a larger prompt. Line to line, **50.4%** of consecutive pairs
 *      report a *byte-identical* context — impossible for real calls. Call to
 *      call after deduplication: **0 out of 10,210**, with 99.9% strictly
 *      growing at a median of +844 tokens. That is the shape of a conversation.
 *   2. **The repeats are complementary, not whole.** All 5,938 multi-line groups
 *      carry identical usage (0 differ), and their blocks compose one turn —
 *      `thinking+text+tool_use`, `thinking+tool_use+tool_use` — with a single
 *      `stop_reason` across the group. `message.id` is the API's own response
 *      id, and one response is one billing event.
 *   3. **Physics.** The model emitted 17,056,762 characters, 99.5% of them
 *      ASCII. Deduplicated, that is 1.81 characters per output token — the right
 *      band for a corpus that is 75% tool-call JSON on the newer tokenizer.
 *      Summed per line it is **0.69**, and no ASCII token is shorter than one
 *      character.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'real-cost-dedupe-'));
const projectDir = path.join(home, 'projects', '-Users-dev-checkout');
await fsp.mkdir(projectDir, { recursive: true });

const at = (min) => new Date(Date.UTC(2026, 0, 2, 10, min)).toISOString();

/** One transcript line, in the shape Claude Code writes. */
const line = ({ requestId, id, block, usage, minute }) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(minute),
    cwd: '/Users/dev/checkout',
    ...(requestId ? { requestId } : {}),
    message: {
      ...(id ? { id } : {}),
      model: 'claude-opus-5',
      content: [{ type: block }],
      usage,
    },
  });

/** The usage block the three lines of one call all carry. */
const CALL_A = {
  input_tokens: 2,
  output_tokens: 651,
  cache_read_input_tokens: 40_644,
  cache_creation_input_tokens: 2_121,
  cache_creation: { ephemeral_1h_input_tokens: 2_121, ephemeral_5m_input_tokens: 0 },
};

const TRANSCRIPT = [
  // One call, three content blocks, three lines, the same usage on each.
  line({ requestId: 'req_A', id: 'msg_A', block: 'thinking', usage: CALL_A, minute: 1 }),
  line({ requestId: 'req_A', id: 'msg_A', block: 'tool_use', usage: CALL_A, minute: 1 }),
  line({ requestId: 'req_A', id: 'msg_A', block: 'tool_use', usage: CALL_A, minute: 1 }),
  // A second, ordinary call.
  line({
    requestId: 'req_B',
    id: 'msg_B',
    block: 'text',
    usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 500 },
    minute: 2,
  }),
  // No id of any kind. An unidentifiable call still happened and still cost money.
  line({
    block: 'text',
    usage: { input_tokens: 5, output_tokens: 50 },
    minute: 3,
  }),
  // A retry is a *separate* billed call under a new id, and must stay separate:
  // deduplication that keyed on content would silently swallow one of these.
  line({
    requestId: 'req_C',
    id: 'msg_C',
    block: 'text',
    usage: { input_tokens: 1, output_tokens: 7 },
    minute: 4,
  }),
  line({
    requestId: 'req_D',
    id: 'msg_D',
    block: 'text',
    usage: { input_tokens: 1, output_tokens: 7 },
    minute: 5,
  }),
].join('\n');

await fsp.writeFile(path.join(projectDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'), TRANSCRIPT);

process.env.CLAUDE_HOME = home;
const { scan } = await import('../server/scan.js');
const { withEconomics } = await import('../server/store.js');
const { costOf } = await import('../server/models.js');

const { sessions } = await scan();
const only = sessions[0];

test('a call written as several content blocks is billed once, not once per block', () => {
  // 651 output tokens, from one call recorded on three lines. Three times that
  // is the bug this file exists for.
  assert.equal(only.usage.outputTokens, 651 + 100 + 50 + 7 + 7);
  assert.equal(only.usage.inputTokens, 2 + 10 + 5 + 1 + 1);
  assert.equal(only.usage.cacheReadTokens, 40_644 + 500);
  assert.equal(only.usage.cacheWriteTokens, 2_121);
});

test('the request count is calls, not transcript lines', () => {
  // Seven lines carry usage; five API calls produced them.
  assert.equal(only.requests, 5);
});

test('a cache write is not multiplied by the number of blocks the reply had', () => {
  // The 1h multiplier is 2x, so counting this write three times is the most
  // expensive way to be wrong.
  assert.equal(only.usage.cacheWrite1h, 2_121);
  assert.equal(only.usage.cacheWrite5m, 0);
});

test('a line carrying no request id of any kind is still counted', () => {
  // Dropping it would understate the bill, which is the same class of error in
  // the opposite direction.
  assert.ok(only.usage.outputTokens >= 50);
  assert.equal(only.requests, 5);
});

test('a retry under a new id is two calls, because it was billed as two', () => {
  const slice = only.usageByModel.find((s) => s.model === 'claude-opus-5');
  assert.equal(slice.requests, 5);
  assert.equal(slice.outputTokens, 815);
});

test('peak context is one call, not the same call counted three times', () => {
  // 2 fresh + 40,644 read + 2,121 written. Deduplication must not turn the
  // largest turn into three of itself.
  assert.equal(only.peakContext, 42_767);
});

test('the priced total is what the calls cost, not what the lines cost', () => {
  const priced = withEconomics(only);
  const expected = costOf('claude-opus-5', {
    inputTokens: 19,
    outputTokens: 815,
    cacheReadTokens: 41_144,
    cacheWrite5m: 0,
    cacheWrite1h: 2_121,
  });
  assert.ok(Math.abs(priced.economics.cost - expected) < 1e-9);
  // And the per-line figure is measurably different, so this cannot pass on a
  // reader that never deduplicated.
  const perLine = costOf('claude-opus-5', {
    inputTokens: 21,
    outputTokens: 2_117,
    cacheReadTokens: 122_432,
    cacheWrite5m: 0,
    cacheWrite1h: 6_363,
  });
  assert.ok(perLine > priced.economics.cost * 2);
});

test.after(() => fsp.rm(home, { recursive: true, force: true }));
