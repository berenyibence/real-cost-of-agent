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
import {
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  costOf,
  lookupModel,
  uncachedCostOf,
  contextPressure,
} from '../server/models.js';

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
  // Against the tier's *newest* non-legacy entry, which is what TIER_DEFAULT
  // resolves to. This used to compare against Sonnet 4.6 and passed only
  // because both were $3 at the time — it could not have told the two apart.
  assert.equal(spec.inputRate, lookupModel('claude-sonnet-5-5').listInputRate);
  assert.match(spec.name, /claude-sonnet-9-9/, 'the name has to say what actually ran');
  assert.equal(spec.requested, 'claude-sonnet-9-9');
});

test('an inferred model produces a real cost rather than zero', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };
  assert.equal(costOf('claude-opus-7', usage), costOf('claude-opus-5-5', usage));
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

/* ------------------------------------------------------------------ *
 * The rate card
 * ------------------------------------------------------------------ */

/**
 * The published first-party rate card, transcribed from
 * platform.claude.com/docs/en/about-claude/pricing on 2026-08-11, and extended
 * with Fable 5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5 on 2026-09-30.
 *
 * Those three new cache-hit figures are the first that are not 0.1x input —
 * $0.25 on a $10 base, $0.20 on a $4 base — which is exactly the drift the
 * cache column exists to catch.
 *
 * Both halves of each row earn their place. The base rates catch a stale or
 * mistyped entry. The cache columns catch a drifted multiplier — and they
 * re-derive the base independently, which is how a real error surfaced here:
 * Sonnet 5 was carried as $3/$15 with a $2/$10 promotion expiring 2026-08-31,
 * but the published cache hit of $0.20/MTok is 0.1x of $2, not of $3. The
 * introductory rate had become the standard one, and the entry would have
 * repriced every Sonnet 5 session 50% higher the day the window closed.
 */
const RATE_CARD = [
  // id,                 input, output, 5m write, 1h write, cache hit
  ['claude-fable-5-1',   10,    50,     12.5,     20,       0.25],
  ['claude-mythos-5-1',  10,    50,     12.5,     20,       0.25],
  ['claude-fable-5',     10,    50,     12.5,     20,       1],
  ['claude-mythos-5',    10,    50,     12.5,     20,       1],
  ['claude-opus-5-5',    4,     20,     5,        8,        0.2],
  ['claude-opus-5',      5,     25,     6.25,     10,       0.5],
  ['claude-opus-4-8',    5,     25,     6.25,     10,       0.5],
  ['claude-opus-4-7',    5,     25,     6.25,     10,       0.5],
  ['claude-opus-4-6',    5,     25,     6.25,     10,       0.5],
  ['claude-opus-4-5',    5,     25,     6.25,     10,       0.5],
  ['claude-opus-4-1',    15,    75,     18.75,    30,       1.5],
  ['claude-opus-4-0',    15,    75,     18.75,    30,       1.5],
  ['claude-sonnet-5-5',  2,     10,     2.5,      4,        0.2],
  ['claude-sonnet-5',    2,     10,     2.5,      4,        0.2],
  ['claude-sonnet-4-6',  3,     15,     3.75,     6,        0.3],
  ['claude-sonnet-4-5',  3,     15,     3.75,     6,        0.3],
  ['claude-sonnet-4-0',  3,     15,     3.75,     6,        0.3],
  ['claude-haiku-4-5',   1,     5,      1.25,     2,        0.1],
  ['claude-3-5-haiku',   0.8,   4,      1,        1.6,      0.08],
];

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('every catalog rate matches the published rate card', () => {
  for (const [id, input, output] of RATE_CARD) {
    const spec = lookupModel(id);
    assert.ok(spec, `${id} is not in the catalog`);
    assert.equal(spec.inferred, false, `${id} is being inferred rather than priced`);
    assert.equal(spec.listInputRate, input, `${id} input`);
    assert.equal(spec.listOutputRate, output, `${id} output`);
  }
});

test('the cache columns the API publishes are the ones this app charges', () => {
  // Derived, not stored: base rate times the multiplier has to land on the
  // published dollar figure. A wrong base and a wrong multiplier both show up
  // here, and a base that disagrees with its own cache column cannot hide.
  for (const [id, , , write5m, write1h, hit] of RATE_CARD) {
    const rate = lookupModel(id).listInputRate;
    assert.ok(near(rate * CACHE_WRITE_5M_MULTIPLIER, write5m), `${id} 5m write`);
    assert.ok(near(rate * CACHE_WRITE_1H_MULTIPLIER, write1h), `${id} 1h write`);
    // Through `costOf`, not the spec field, so the multiplier the bill actually
    // uses is the one checked.
    assert.ok(near(costOf(id, usage({ cacheReadTokens: 1_000_000 })), hit), `${id} cache hit`);
  }
});

/**
 * The published fast-mode card, same source and date. Fast mode is the same
 * model at up to 2.5x the output speed, billed at its own rate — and only three
 * models have one.
 */
const FAST_RATE_CARD = [
  // id,               fast input, fast output
  ['claude-opus-5-5', 8, 40],
  ['claude-opus-5', 10, 50],
  ['claude-opus-4-8', 10, 50],
];

test('the models with fast-mode pricing carry the published fast rates', () => {
  for (const [id, input, output] of FAST_RATE_CARD) {
    const spec = lookupModel(id);
    assert.equal(spec.fastInputRate, input, `${id} fast input`);
    assert.equal(spec.fastOutputRate, output, `${id} fast output`);
  }
});

test('every other model has no fast rate at all, rather than a guessed one', () => {
  // Opus 4.7 had fast mode withdrawn and now errors on the request; Opus 4.6
  // accepts it, runs at standard speed and bills standard. Either way there is
  // no published premium, and inventing one is the mirror of inventing a
  // discount.
  const fast = new Set(FAST_RATE_CARD.map(([id]) => id));
  for (const [id] of RATE_CARD) {
    if (fast.has(id)) continue;
    assert.equal(lookupModel(id).fastInputRate, null, `${id} fast input`);
    assert.equal(lookupModel(id).fastOutputRate, null, `${id} fast output`);
  }
});

test('a request that ran fast is billed at the fast rate, not the standard one', () => {
  // Exactly 2x on both models that offer it, so pricing a fast request off the
  // standard column halves it. `/fast` is a keystroke inside Claude Code, which
  // puts this one toggle away from every figure on the page.
  const u = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.ok(near(costOf('claude-opus-5', u), 30));
  assert.ok(near(costOf('claude-opus-5', { ...u, speed: 'fast' }), 60));
});

test('a cache hit on Opus 5.5 and Fable 5.1 is billed below the usual tenth', () => {
  // The standard 0.1x would price a million cache reads at $0.40 and $1.00.
  const reads = usage({ cacheReadTokens: 1_000_000 });
  assert.ok(near(costOf('claude-opus-5-5', reads), 0.2));
  assert.ok(near(costOf('claude-fable-5-1', reads), 0.25));
  assert.ok(near(costOf('claude-fable-5', reads), 1), 'Fable 5 keeps the 0.1x hit');
  // Stacks with fast mode and the US pin like every other multiplier.
  assert.ok(near(costOf('claude-opus-5-5', { ...reads, speed: 'fast', inferenceGeo: 'us' }), 0.44));
});

test('the cache multipliers stack on top of the fast base rate', () => {
  // A 1h write on fast Opus 5 is 2x of $10, not 2x of $5.
  const u = { ...usage({ cacheWrite1h: 1_000_000, cacheReadTokens: 1_000_000 }), speed: 'fast' };
  assert.ok(near(costOf('claude-opus-5', u), 20 + 1));
});

test('the fast flag is ignored on a model that does not price it', () => {
  for (const id of ['claude-opus-4-6', 'claude-sonnet-5', 'claude-haiku-4-5']) {
    const u = usage({ outputTokens: 1_000_000 });
    assert.equal(costOf(id, { ...u, speed: 'fast' }), costOf(id, u), id);
  }
});

test('an inferred model inherits its tier default including the fast rate', () => {
  // Fast mode is a premium, not a promotion. Declining to apply it would
  // under-price a request whose own usage block says it ran fast, and
  // under-pricing is the flattering direction this app exists to catch.
  const standard = usage({ outputTokens: 1_000_000 });
  const fast = { ...standard, speed: 'fast' };
  assert.equal(costOf('claude-opus-9-9', fast), costOf('claude-opus-5-5', fast));
  assert.ok(costOf('claude-opus-9-9', fast) > costOf('claude-opus-9-9', standard));
});

test('US-pinned inference costs 1.1x on every category, cache included', () => {
  const u = usage({
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWrite1h: 1_000_000,
  });
  const pinned = costOf('claude-opus-5', { ...u, inferenceGeo: 'us' });
  assert.ok(near(pinned, costOf('claude-opus-5', u) * 1.1));
});

test('anything other than a US pin is standard pricing', () => {
  // Claude Code records `not_available` on an ordinary account. Reading that as
  // a pin would add 10% to every figure here.
  const u = usage({ outputTokens: 1_000 });
  for (const geo of ['global', 'not_available', null, undefined]) {
    assert.equal(
      costOf('claude-opus-5', { ...u, inferenceGeo: geo }),
      costOf('claude-opus-5', u),
      String(geo),
    );
  }
});

test('web search is charged per search, on top of the tokens it produced', () => {
  // $10 per 1,000 searches. It arrives as a request count rather than a token
  // count, so a total assembled only from tokens omits it and nothing about the
  // figure suggests anything is missing.
  const tokensOnly = usage({ outputTokens: 1_000 });
  const searched = { ...tokensOnly, webSearchRequests: 250 };
  const charge = (id) => costOf(id, searched) - costOf(id, tokensOnly);
  assert.ok(near(charge('claude-opus-5'), 2.5));
  // The same searches cost the same whatever model asked for them: this is an
  // API charge, not a model one.
  assert.ok(near(charge('claude-haiku-4-5'), 2.5));
});

test('the US multiplier is a token multiplier, and a search is not a token', () => {
  // The published 1.1x is enumerated over token categories — input, output, cache
  // writes, cache reads. Extending it to a per-search charge would be inventing a
  // rate that is not on the card, in the direction that overstates.
  const u = { ...usage(), webSearchRequests: 1_000 };
  assert.ok(near(costOf('claude-opus-5', u), 10));
  assert.ok(near(costOf('claude-opus-5', { ...u, inferenceGeo: 'us' }), 10));
});

test('a search costs the same cached or not, so it cannot read as a saving', () => {
  const saved = (x) => uncachedCostOf('claude-opus-5', x) - costOf('claude-opus-5', x);
  const cached = usage({ cacheReadTokens: 1_000_000 });
  assert.ok(near(saved({ ...cached, webSearchRequests: 100 }), saved(cached)));
});

test('what a session costs does not depend on what day it is read', () => {
  // A promotion makes the effective rate a function of the clock, so a total
  // can change without a single transcript changing. That is defensible while
  // an offer is genuinely running and indefensible once it has been withdrawn
  // or made permanent — so any entry still carrying one has to be deliberate.
  for (const [id] of RATE_CARD) {
    const spec = lookupModel(id);
    assert.equal(spec.promoUntil, null, `${id} is priced on a promotion`);
    assert.equal(spec.inputRate, spec.listInputRate, `${id} effective input`);
    assert.equal(spec.outputRate, spec.listOutputRate, `${id} effective output`);
  }
});
