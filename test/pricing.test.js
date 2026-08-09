/**
 * Pricing, and the mixed-model bug it was hiding.
 *
 * A session is not one model. Switching mid-run is ordinary, the tiers differ
 * by 2x, and the whole session used to be priced at whichever model happened to
 * answer last — which on the largest real sessions here was out by thirty
 * percent, always in whichever direction the last model pointed.
 *
 * The cross-check that found it is the one worth keeping: the sum of the
 * per-request costs must equal the session's headline figure. Two ways of
 * computing the same number, from the same tokens, that disagreed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { costOf, lookupModel, uncachedCostOf, contextPressure } from '../server/models.js';

const usage = (over = {}) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  ...over,
});

test('cache multipliers are applied per TTL, not collapsed', () => {
  // Claude Code writes almost exclusively to the 1h cache. Collapsing the two
  // would understate a heavy session by about a third.
  const rate = lookupModel('claude-opus-5').inputRate / 1_000_000;
  assert.equal(
    costOf('claude-opus-5', usage({ cacheWrite5m: 1_000_000 })),
    rate * 1_000_000 * 1.25,
  );
  assert.equal(costOf('claude-opus-5', usage({ cacheWrite1h: 1_000_000 })), rate * 1_000_000 * 2);
  assert.equal(
    costOf('claude-opus-5', usage({ cacheReadTokens: 1_000_000 })),
    rate * 1_000_000 * 0.1,
  );
});

test('an unknown model is priced at nothing rather than at a guess', () => {
  assert.equal(costOf('gpt-not-a-claude-model', usage({ outputTokens: 1_000 })), null);
  assert.equal(lookupModel('gpt-not-a-claude-model'), null);
  assert.equal(lookupModel(undefined), null);
});

test('a dated model id resolves to its catalog entry', () => {
  assert.equal(lookupModel('claude-haiku-4-5-20251001')?.id, 'claude-haiku-4-5');
  assert.equal(lookupModel('anthropic.claude-opus-5')?.id, 'claude-opus-5');
});

test('the uncached counterfactual charges every input token at full rate', () => {
  const u = usage({
    inputTokens: 100,
    cacheReadTokens: 900,
    cacheWrite1h: 1_000,
    outputTokens: 50,
  });
  const spec = lookupModel('claude-sonnet-5');
  const inRate = spec.inputRate / 1_000_000;
  const expected = 2_000 * inRate + 50 * (spec.outputRate / 1_000_000);
  assert.equal(uncachedCostOf('claude-sonnet-5', u), expected);
});

test('caching is a bet that only pays once the prefix is read back', () => {
  // A 1h write costs 2x, so writing a prefix and reading it once is a loss —
  // the saving is real but it is not unconditional, and a test asserting
  // "cached is always cheaper" would be asserting something false.
  const writeOnly = usage({ cacheWrite1h: 1_000_000, cacheReadTokens: 1_000_000 });
  assert.ok(costOf('claude-opus-5', writeOnly) > uncachedCostOf('claude-opus-5', writeOnly));

  const readBackOften = usage({ cacheWrite1h: 1_000_000, cacheReadTokens: 20_000_000 });
  assert.ok(
    costOf('claude-opus-5', readBackOften) < uncachedCostOf('claude-opus-5', readBackOften),
  );
});

test('pricing a mixed-model session per slice differs from pricing it as one', () => {
  // The regression, in miniature. Fable is $10/MTok in and Opus 5 is $5, so a
  // half-and-half session priced entirely at either end is wrong by 33%.
  const half = usage({ inputTokens: 1_000_000 });
  const perSlice = costOf('claude-fable-5', half) + costOf('claude-opus-5', half);
  const asLastModel = costOf('claude-opus-5', usage({ inputTokens: 2_000_000 }));

  assert.equal(perSlice, 15);
  assert.equal(asLastModel, 10);
  assert.notEqual(perSlice, asLastModel);
});

test('context pressure is capped at the window and needs both numbers', () => {
  const p = contextPressure('claude-opus-5', 500_000);
  assert.equal(p.window, 1_000_000);
  assert.equal(p.ratio, 0.5);
  // A request larger than the window is a data problem, not a >100% reading.
  assert.equal(contextPressure('claude-opus-5', 2_000_000).ratio, 1);
  assert.equal(contextPressure('claude-opus-5', 0), null);
  assert.equal(contextPressure('nope', 100), null);
});

/* ------------------------------------------------------------------ *
 * Models the catalog has never heard of
 *
 * This catalog is written by hand and models ship without asking it. An id it
 * did not know used to return null all the way up — `economics` was null, the
 * spend breakdown skipped the session, and the statistics counted it as **$0**,
 * with nothing anywhere saying so. The first day work moved to a new Claude
 * model, every figure in the money view would have quietly dropped and read as
 * a saving.
 *
 * The rule now: infer the rate when the id names a tier, say it was inferred,
 * and stay silent rather than guess when it does not.
 * ------------------------------------------------------------------ */

test('an exact catalog hit is never marked inferred', () => {
  const spec = lookupModel('claude-opus-5');
  assert.equal(spec.inferred, false);
  assert.equal(spec.name, 'Opus 5');
});

test('a dated id is still an exact hit', () => {
  // `claude-haiku-4-5-20251001` is the same model as `claude-haiku-4-5`, and
  // treating the date suffix as an unknown model would price it by inference
  // when the real rate was right there.
  const spec = lookupModel('claude-haiku-4-5-20251001');
  assert.equal(spec.inferred, false);
  assert.equal(spec.tier, 'haiku');
});

test('a model that does not exist yet is priced at its tier, and says so', () => {
  const spec = lookupModel('claude-sonnet-9-9');
  assert.ok(spec, 'a future Sonnet must not price at nothing');
  assert.equal(spec.inferred, true);
  assert.equal(spec.tier, 'sonnet');
  assert.equal(spec.inputRate, lookupModel('claude-sonnet-4-6').inputRate);
  assert.match(spec.name, /claude-sonnet-9-9/, 'the name has to say what actually ran');
  assert.equal(spec.requested, 'claude-sonnet-9-9');
});

test('an inferred model produces a real cost rather than zero', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };
  assert.equal(costOf('claude-opus-7', usage), costOf('claude-opus-5', usage));
});

test('a provider prefix does not defeat the inference', () => {
  assert.equal(lookupModel('anthropic.claude-haiku-7-0')?.tier, 'haiku');
});

test('an id that names no tier stays unpriced rather than guessed at', () => {
  // The line this draws: a rate that is probably right beats a confident zero,
  // but an id carrying no information at all is not an invitation to invent one.
  for (const id of ['gpt-4o', 'unknown', 'my-local-model', '']) {
    assert.equal(lookupModel(id), null, id);
    assert.equal(costOf(id, { inputTokens: 1000 }), null, id);
  }
});

test('a tier word has to be a whole word', () => {
  // `claude-opusculum-1` contains "opus" and is not an Opus. Substring matching
  // would price it confidently and wrongly.
  assert.equal(lookupModel('claude-opusculum-1'), null);
});

test('a legacy entry is never what an unknown model is priced at', () => {
  // Legacy rows exist to price old sessions. A brand-new model inheriting a
  // superseded context window would misreport how full its window got.
  const inferred = lookupModel('claude-sonnet-8-0');
  assert.equal(inferred.context, lookupModel('claude-sonnet-4-6').context);
  assert.notEqual(inferred.context, lookupModel('claude-sonnet-4-5').context);
});

test("an inferred rate is the list rate, never someone else's promotion", () => {
  // A promotion is an offer on one named model for one stated period. Extending
  // it to an id nobody has published a price for would be inventing a discount,
  // which is the same failure as pricing at zero wearing a better hat.
  const sonnet5 = lookupModel('claude-sonnet-5');
  const future = lookupModel('claude-sonnet-9-9');
  assert.equal(future.inputRate, sonnet5.listInputRate);
  assert.equal(future.promoUntil, null, 'an inferred model is on no promotion');
  if (sonnet5.promoUntil) {
    assert.notEqual(future.inputRate, sonnet5.inputRate, 'the promo must not leak across');
  }
});
