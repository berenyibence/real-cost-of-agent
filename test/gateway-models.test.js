/**
 * A session that mixes a priceable model with an id the catalog cannot parse.
 *
 * Gateways and proxies put their own route names in `message.model`, and those
 * name no tier to reason from. What used to happen to such a session depended
 * on something meaningless: `primaryModel` picked the busiest slice outright,
 * and when that one could not be priced it fell back to `session.model` — which
 * is whichever id answered *last*, and on these sessions is usually the same
 * unpriceable one. `spec` then came out null and the whole session went to
 * `unpriced`, taking every exactly-priceable token in it along.
 *
 * So the same tokens across the same two models priced at $0.00 or $27.51
 * according to which slice held more requests. One of those answers had to be
 * wrong, and request ordering decided which one you got.
 *
 * Now the headline model is the busiest one that *can* be priced, and the
 * slices that cannot are folded onto its rate — a real assumption, which is why
 * it is flagged all the way to the page rather than presented as a rate card.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { withEconomics } from '../server/store.js';
import { spendBreakdown } from '../server/spend.js';

const GATEWAY = 'my-gateway/route-a';

const slice = (model, requests, outputTokens) => ({
  model,
  speed: 'standard',
  inferenceGeo: 'global',
  requests,
  inputTokens: 1_000,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  webSearchRequests: 0,
});

/** `lastAnswered` is what `session.model` records — whichever replied last. */
const session = ({ gatewayRequests, opusRequests, lastAnswered = GATEWAY }) => ({
  id: 'mixed',
  workspaceId: 'w',
  title: 'a run through a gateway',
  cwd: '/x',
  startedAt: Date.parse('2026-08-01T10:00:00Z'),
  endedAt: Date.parse('2026-08-01T11:00:00Z'),
  model: lastAnswered,
  usage: {
    inputTokens: 2_000,
    outputTokens: 1_100_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    webSearchRequests: 0,
  },
  usageByModel: [
    slice(GATEWAY, gatewayRequests, 100_000),
    slice('claude-opus-5', opusRequests, 1_000_000),
  ],
  peakContext: 2_000,
  requests: gatewayRequests + opusRequests,
});

test('the same session costs the same however the requests were distributed', () => {
  const gatewayBusiest = withEconomics(session({ gatewayRequests: 100, opusRequests: 10 }));
  const opusBusiest = withEconomics(session({ gatewayRequests: 10, opusRequests: 100 }));

  assert.ok(gatewayBusiest.economics, 'a session with priceable work in it is priced');
  assert.ok(opusBusiest.economics);
  assert.equal(
    gatewayBusiest.economics.cost,
    opusBusiest.economics.cost,
    'request ordering is not a pricing input',
  );
});

test('priceable work is not thrown away because it shared a session with a gateway id', () => {
  const priced = withEconomics(session({ gatewayRequests: 100, opusRequests: 10 }));
  // The Opus 5 half alone, at $5/$25 per million.
  const opusAlone = (1_000 / 1e6) * 5 + (1_000_000 / 1e6) * 25;
  assert.ok(
    priced.economics.cost > opusAlone,
    `expected more than the Opus work alone (${opusAlone}), got ${priced.economics.cost}`,
  );

  const breakdown = spendBreakdown([priced], []);
  assert.equal(breakdown.unpriced.sessions, 0, 'nothing was dropped');
  assert.ok(Math.abs(breakdown.total - priced.economics.cost) < 1e-9);
});

test('the borrowed rate is declared rather than presented as a price', () => {
  const priced = withEconomics(session({ gatewayRequests: 100, opusRequests: 10 }));
  assert.equal(priced.economics.fallbackPriced, true);

  const breakdown = spendBreakdown([priced], []);
  assert.equal(breakdown.fallbackPricedSessions, 1);
  assert.equal(breakdown.bySession[0].fallbackPriced, true);
  // It is a different, larger assumption than an inferred tier, so it is not
  // quietly counted as one.
  assert.equal(breakdown.inferredSessions, 0);
});

test('a session with nothing priceable in it is still excluded and counted', () => {
  // The fix must not turn "cannot price this at all" into a confident figure.
  const hopeless = withEconomics({
    ...session({ gatewayRequests: 10, opusRequests: 0 }),
    model: GATEWAY,
    usageByModel: [slice(GATEWAY, 10, 100_000)],
  });
  assert.equal(hopeless.economics, null);

  const breakdown = spendBreakdown([hopeless], []);
  assert.equal(breakdown.total, 0);
  assert.equal(breakdown.unpriced.sessions, 1);
  assert.ok(breakdown.unpriced.tokens > 0, 'the tokens it left out are still reported');
  assert.deepEqual(breakdown.unpriced.models, [GATEWAY]);
});

test('an ordinary all-Claude session is not flagged as borrowing anything', () => {
  const clean = withEconomics({
    ...session({ gatewayRequests: 0, opusRequests: 10 }),
    model: 'claude-opus-5',
    usageByModel: [slice('claude-opus-5', 10, 1_000_000), slice('claude-haiku-4-5', 2, 5_000)],
  });
  assert.equal(clean.economics.fallbackPriced, false);
  assert.equal(spendBreakdown([clean], []).fallbackPricedSessions, 0);
});
