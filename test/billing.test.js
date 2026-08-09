import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeConfig, planPrice, PLANS, sanitizeConfig, compareBilling } from '../server/billing.js';

/**
 * `readConfig`/`writeConfig` touch a real path under `~/.config`, so what is
 * tested here is the sanitiser they both run through, plus the arithmetic that
 * consumes its output.
 *
 * The sanitiser is the load-bearing half. Without it, `POST /api/billing` would
 * write whatever it was handed straight to disk: an unknown `planId` then falls
 * through to the $0 plan and reads as "no subscription" — a claim, not a blank —
 * and a `monthlyOverride` of `"abc"` becomes `NaN` and empties every figure on
 * the page.
 */

test('every plan prices to a real number, for any seat count', () => {
  for (const plan of PLANS) {
    for (const seats of [1, 3, 40]) {
      const { monthly } = planPrice({ planId: plan.id, monthlyOverride: null, seats });
      assert.ok(Number.isFinite(monthly), `${plan.id} × ${seats} produced ${monthly}`);
      assert.ok(monthly >= 0, `${plan.id} × ${seats} priced below zero`);
      assert.equal(monthly, plan.monthly * seats);
    }
  }
});

test('an override replaces the plan price rather than adding to it', () => {
  const { monthly } = planPrice({ planId: 'pro', monthlyOverride: 55, seats: 2 });
  assert.equal(monthly, 110);
});

test('a zero override is honoured rather than treated as absent', () => {
  // The distinction that a truthiness check gets wrong: 0 is a real answer,
  // and "I pay nothing for this" is exactly what someone would set it to.
  const { monthly } = planPrice({ planId: 'max20', monthlyOverride: 0, seats: 1 });
  assert.equal(monthly, 0);
});

test('a null override falls back to the plan, not to zero', () => {
  const pro = PLANS.find((p) => p.id === 'pro');
  const { monthly } = planPrice({ planId: 'pro', monthlyOverride: null, seats: 1 });
  assert.equal(monthly, pro.monthly);
});

test('a seat count of zero never divides or zeroes the bill', () => {
  const { monthly } = planPrice({ planId: 'team', monthlyOverride: null, seats: 0 });
  const team = PLANS.find((p) => p.id === 'team');
  assert.equal(monthly, team.monthly);
});

/* ------------------------------------------------------------------ *
 * The sanitiser — what actually stops nonsense reaching the arithmetic
 * ------------------------------------------------------------------ */

test('an unknown plan never reaches storage, so it can never price as free', () => {
  const config = sanitizeConfig({ planId: 'not-a-real-plan' });
  assert.ok(
    PLANS.some((p) => p.id === config.planId),
    `stored "${config.planId}", which is not a plan`,
  );
  assert.notEqual(config.planId, 'not-a-real-plan');
});

test('an unparseable override is dropped rather than stored as NaN', () => {
  for (const bad of ['abc', {}, [], true, Infinity, NaN, -5]) {
    const { monthlyOverride } = sanitizeConfig({ monthlyOverride: bad });
    assert.ok(
      monthlyOverride === null || Number.isFinite(monthlyOverride),
      `${JSON.stringify(bad)} survived as ${monthlyOverride}`,
    );
  }
});

test('a negative or fractional seat count cannot be stored', () => {
  assert.equal(sanitizeConfig({ seats: -99 }).seats, 1);
  assert.equal(sanitizeConfig({ seats: 0 }).seats, 1);
  assert.equal(sanitizeConfig({ seats: 2.7 }).seats, 2);
  assert.equal(sanitizeConfig({ seats: 'lots' }).seats, 1);
});

test('a good config passes through unchanged', () => {
  const good = { planId: 'max5', monthlyOverride: 90, seats: 3 };
  assert.deepEqual(sanitizeConfig(good), good);
});

test('a patch changes what it names and nothing else', () => {
  // The endpoint names every field on every request, so most of them arrive
  // `undefined`. Spread straight over the stored config that reads as "set this
  // to nothing", and sanitising then replaces it with the default — so changing
  // the plan would silently reset a seat count set months ago.
  const stored = { planId: 'max20', monthlyOverride: null, seats: 2 };

  const afterPlanChange = mergeConfig(stored, {
    planId: 'max5',
    monthlyOverride: undefined,
    seats: undefined,
  });

  assert.equal(afterPlanChange.planId, 'max5', 'the field that was named did change');
  assert.equal(afterPlanChange.seats, 2, 'reset by an unrelated save');

  // `null` is not "declining to say" — it means use the plan's own price, and
  // has to survive the same filter that drops `undefined`.
  assert.equal(
    mergeConfig({ ...stored, monthlyOverride: 90 }, { monthlyOverride: null }).monthlyOverride,
    null,
  );
});

test('an explicit null override survives, because it means "use the plan price"', () => {
  assert.equal(sanitizeConfig({ planId: 'pro', monthlyOverride: null }).monthlyOverride, null);
});

test('a corrupt file on disk sanitises to the default rather than throwing', () => {
  for (const junk of [null, undefined, 'a string', 42, []]) {
    const config = sanitizeConfig(junk);
    assert.ok(PLANS.some((p) => p.id === config.planId));
    assert.ok(Number.isFinite(config.seats) && config.seats >= 1);
  }
});

test('whatever the sanitiser emits, the price is always a real number', () => {
  const nasty = [
    { planId: 'nope', monthlyOverride: 'abc', seats: -1 },
    { planId: null, monthlyOverride: Infinity, seats: 'x' },
    {},
  ];
  for (const raw of nasty) {
    const { monthly } = planPrice(sanitizeConfig(raw));
    assert.ok(Number.isFinite(monthly) && monthly >= 0, `${JSON.stringify(raw)} priced ${monthly}`);
  }
});

/* ------------------------------------------------------------------ *
 * The comparison
 * ------------------------------------------------------------------ */

const DAY = 86_400_000;
const config = { planId: 'pro', monthlyOverride: null, seats: 1 };

test('a part-month of work is charged as a whole month', () => {
  // You pay for the month even if you used four days of it, so rounding down
  // would report a subscription as cheaper than it is.
  const now = Date.now();
  const b = compareBilling({ apiEquivalent: 100, firstAt: now - 4 * DAY, lastAt: now, config });
  assert.equal(b.months, 1);
  assert.equal(b.subscriptionCost, 20);
});

test('a longer span is charged for every month it covers', () => {
  const now = Date.now();
  const b = compareBilling({ apiEquivalent: 100, firstAt: now - 70 * DAY, lastAt: now, config });
  assert.equal(b.months, 3);
  assert.equal(b.subscriptionCost, 60);
});

test('an empty index compares without producing NaN', () => {
  // Every bound is missing here, which is exactly the first-run state.
  const b = compareBilling({ apiEquivalent: 0, firstAt: 0, lastAt: 0, config });
  assert.equal(b.months, 1);
  assert.ok(Number.isFinite(b.subscriptionCost));
  assert.ok(Number.isFinite(b.apiEquivalent));
});

test('the plan price is never charged as a credit against the API balance', () => {
  // The claim the whole panel rests on: on a subscription, metered credits
  // spent is zero, whatever the token figure says.
  const b = compareBilling({ apiEquivalent: 5000, firstAt: 0, lastAt: 0, config });
  if (b.authMode === 'subscription') assert.equal(b.apiCreditsSpent, 0);
  else assert.equal(b.apiCreditsSpent, b.authMode === 'api' ? 5000 : 0);
});

test('choosing "no subscription" stops the app claiming you are on one', () => {
  const b = compareBilling({
    apiEquivalent: 5000,
    firstAt: 0,
    lastAt: 0,
    config: { planId: 'none', monthlyOverride: null, seats: 1 },
  });
  assert.equal(b.onSubscription, false);
  assert.equal(b.saved, 0);
});
