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
  assert.equal(b.planCost, 20);
});

test('a longer span is charged for every month it covers', () => {
  const now = Date.now();
  const b = compareBilling({ apiEquivalent: 100, firstAt: now - 70 * DAY, lastAt: now, config });
  assert.equal(b.months, 3);
  assert.equal(b.planCost, 60);
});

test('an empty index compares without producing NaN', () => {
  // Every bound is missing here, which is exactly the first-run state.
  const b = compareBilling({ apiEquivalent: 0, firstAt: 0, lastAt: 0, config });
  assert.equal(b.months, 1);
  assert.ok(Number.isFinite(b.planCost));
  assert.ok(Number.isFinite(b.apiEquivalent));
});

test('no dollar figure is reported that did not come off this machine', () => {
  // The rule this replaced a bug with. Nothing in ~/.claude records a charge:
  // transcripts carry token counts and a service_tier, and no field anywhere
  // names a dollar, a credit or an invoice. The previous version answered
  // "API credits spent: $0" from the auth heuristic alone and the page printed
  // it under a green tick, which is a measurement's worth of confidence behind
  // an inference.
  const b = compareBilling({ apiEquivalent: 5000, firstAt: 0, lastAt: 0, config });
  assert.equal('apiCreditsSpent' in b, false, 'a charged amount cannot be known here');

  // The two numbers that remain are both derivable: tokens at published rates,
  // and the price the user typed times the months the work spans.
  assert.equal(b.apiEquivalent, 5000);
  assert.equal(b.planCost, 20);
  assert.equal(b.difference, 4980);

  // Auth mode is still detected — it says which figure is the hypothetical one.
  assert.ok(['subscription', 'api', 'unknown'].includes(b.authMode));
  assert.equal(b.metered, b.authMode === 'api');
});

test('choosing "no subscription" stops the app claiming you are on one', () => {
  const b = compareBilling({
    apiEquivalent: 5000,
    firstAt: 0,
    lastAt: 0,
    config: { planId: 'none', monthlyOverride: null, seats: 1 },
  });
  assert.equal(b.onSubscription, false);
  assert.equal(b.planCost, 0);
  assert.equal(b.difference, 0, 'no plan means no gap to report, not a $5000 saving');
  assert.equal(b.ratio, null);
  assert.equal(b.verdict, 'no-plan');
});

test('a plan that costs more than the usage is reported as such', () => {
  // The unflattering verdict. A tool that can only conclude "your subscription
  // is excellent" is an advertisement, and this is the case that stops it being
  // one: $20 of plan against $3 of tokens.
  const b = compareBilling({ apiEquivalent: 3, firstAt: 0, lastAt: 0, config });
  assert.equal(b.verdict, 'api-ahead');
  assert.equal(b.difference, -17, 'the plan cost $17 more than the work was worth');
  assert.ok(b.ratio < 1);
});

test('near-parity is called a wash rather than a winner', () => {
  const b = compareBilling({ apiEquivalent: 21, firstAt: 0, lastAt: 0, config });
  assert.equal(b.verdict, 'close');
  assert.ok(b.ratio > 1, 'the plan is technically ahead, and it does not matter');
});

test('every verdict is one the page knows how to render', () => {
  const cases = [
    [5000, 'pro', 'plan-ahead'],
    [21, 'pro', 'close'],
    [3, 'pro', 'api-ahead'],
    [5000, 'none', 'no-plan'],
    [0, 'pro', 'no-usage'],
  ];
  for (const [apiEquivalent, planId, expected] of cases) {
    const b = compareBilling({
      apiEquivalent,
      firstAt: 0,
      lastAt: 0,
      config: { planId, monthlyOverride: null, seats: 1 },
    });
    assert.equal(b.verdict, expected, `${apiEquivalent} on ${planId}`);
  }
});

test('a few days of transcripts are flagged, not silently compared to a whole month', () => {
  // A fresh install has three days of history and is charged for a month, which
  // makes any plan look like a bad deal. The comparison is still the honest one
  // for the data present — but the page has to be able to say so.
  const now = Date.now();
  const fresh = compareBilling({ apiEquivalent: 4, firstAt: now - 3 * DAY, lastAt: now, config });
  assert.equal(fresh.partialPeriod, true);
  assert.equal(fresh.days, 3);

  const settled = compareBilling({ apiEquivalent: 400, firstAt: now - 40 * DAY, lastAt: now, config });
  assert.equal(settled.partialPeriod, false);
});
