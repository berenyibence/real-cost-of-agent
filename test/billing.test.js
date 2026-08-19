import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareBilling,
  mergeConfig,
  periodPrice,
  planPrice,
  planTotal,
  PLANS,
  sanitizeConfig,
  sanitizePeriod,
} from '../server/billing.js';

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

const first = (config) => sanitizeConfig(config).periods[0];

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
  const period = sanitizePeriod({ planId: 'not-a-real-plan' });
  assert.ok(
    PLANS.some((p) => p.id === period.planId),
    `stored "${period.planId}", which is not a plan`,
  );
  assert.notEqual(period.planId, 'not-a-real-plan');
});

test('an unparseable override is dropped rather than stored as NaN', () => {
  for (const bad of ['abc', {}, [], true, Infinity, NaN, -5]) {
    const { monthlyOverride } = sanitizePeriod({ monthlyOverride: bad });
    assert.ok(
      monthlyOverride === null || Number.isFinite(monthlyOverride),
      `${JSON.stringify(bad)} survived as ${monthlyOverride}`,
    );
  }
});

test('a negative or fractional seat count cannot be stored', () => {
  assert.equal(sanitizePeriod({ seats: -99 }).seats, 1);
  assert.equal(sanitizePeriod({ seats: 0 }).seats, 1);
  assert.equal(sanitizePeriod({ seats: 2.7 }).seats, 2);
  assert.equal(sanitizePeriod({ seats: 'lots' }).seats, 1);
});

test('a months override is a whole number of months, or absent', () => {
  // Absent is a real answer meaning "ask the transcripts", so it has to be
  // distinguishable from a value that failed to parse.
  assert.equal(sanitizePeriod({}).months, null);
  assert.equal(sanitizePeriod({ months: null }).months, null);
  assert.equal(sanitizePeriod({ months: 'ages' }).months, null);
  assert.equal(sanitizePeriod({ months: 0 }).months, null, 'nobody pays for zero months');
  assert.equal(sanitizePeriod({ months: -4 }).months, null);
  assert.equal(sanitizePeriod({ months: 3 }).months, 3);
  assert.equal(sanitizePeriod({ months: 3.9 }).months, 3);
  // A typo in a months box should not produce a six-figure plan.
  assert.equal(sanitizePeriod({ months: 1e9 }).months, 600);
});

test('a good period passes through unchanged', () => {
  const good = { planId: 'max5', monthlyOverride: 90, seats: 3, months: 4 };
  assert.deepEqual(sanitizePeriod(good), good);
});

test('a patch changes what it names and nothing else', () => {
  // The endpoint names every field on every request, so most of them arrive
  // `undefined`. Spread straight over the stored config that reads as "set this
  // to nothing", and sanitising then replaces it with the default — so changing
  // the plan would silently reset a seat count set months ago.
  const stored = { periods: [{ planId: 'max20', monthlyOverride: null, seats: 2, months: 5 }] };

  const afterPlanChange = mergeConfig(stored, {
    planId: 'max5',
    monthlyOverride: undefined,
    seats: undefined,
    months: undefined,
  });

  assert.equal(afterPlanChange.periods[0].planId, 'max5', 'the field that was named did change');
  assert.equal(afterPlanChange.periods[0].seats, 2, 'reset by an unrelated save');
  assert.equal(afterPlanChange.periods[0].months, 5, 'reset by an unrelated save');

  // `null` is not "declining to say" — it means use the plan's own price, and
  // has to survive the same filter that drops `undefined`.
  const cleared = mergeConfig({ periods: [{ ...stored.periods[0], monthlyOverride: 90 }] }, {
    monthlyOverride: null,
  });
  assert.equal(cleared.periods[0].monthlyOverride, null);
  // Same for months: clearing the box means "ask the transcripts again".
  assert.equal(mergeConfig(stored, { months: null }).periods[0].months, null);
});

test('an explicit null override survives, because it means "use the plan price"', () => {
  assert.equal(first({ planId: 'pro', monthlyOverride: null }).monthlyOverride, null);
});

test('a corrupt file on disk sanitises to the default rather than throwing', () => {
  for (const junk of [null, undefined, 'a string', 42, [], { periods: 'no' }, { periods: [] }]) {
    const config = sanitizeConfig(junk);
    assert.equal(config.periods.length, 1, `${JSON.stringify(junk)} left no period to edit`);
    assert.ok(PLANS.some((p) => p.id === config.periods[0].planId));
    assert.ok(Number.isFinite(config.periods[0].seats) && config.periods[0].seats >= 1);
  }
});

/* ------------------------------------------------------------------ *
 * Periods — a plan history, not a single tier
 * ------------------------------------------------------------------ */

test('a config stored before periods existed is read as one period', () => {
  // The pre-0.4 shape. Discarding it would silently reset somebody's plan to the
  // default, which is a plausible plan rather than a blank — so the page would
  // keep showing a confident comparison against a subscription they are not on.
  const config = sanitizeConfig({ planId: 'max5', monthlyOverride: 90, seats: 3 });
  assert.equal(config.periods.length, 1);
  assert.deepEqual(config.periods[0], {
    planId: 'max5',
    monthlyOverride: 90,
    seats: 3,
    months: null,
  });
});

test('there is always exactly one period to edit, however many were asked for', () => {
  assert.equal(sanitizeConfig({ periods: [] }).periods.length, 1);
  assert.equal(sanitizeConfig({ periods: [{}, {}, {}] }).periods.length, 3);
  // A malformed file should not render a plan editor with ten thousand rows.
  assert.equal(sanitizeConfig({ periods: new Array(500).fill({}) }).periods.length, 24);
});

test('a period with no length of its own takes the span the transcripts show', () => {
  // The whole no-override case: leave the box empty and the app works it out.
  const p = periodPrice({ planId: 'pro', months: null }, 7);
  assert.equal(p.months, 7);
  assert.equal(p.monthsDeclared, false);
  assert.equal(p.cost, 140);
});

test('a stated length wins over the transcripts, which is the point of stating it', () => {
  // You have been paying for eight months; this laptop holds two of them.
  const p = periodPrice({ planId: 'pro', months: 8 }, 2);
  assert.equal(p.months, 8);
  assert.equal(p.monthsDeclared, true);
  assert.equal(p.cost, 160);
});

test('periods on different tiers add up, rather than averaging into one price', () => {
  // Two months of Pro then three of Max 20x is $640, and no single tier says so.
  const { total, declaredMonths, periods } = planTotal(
    {
      periods: [
        { planId: 'pro', months: 2 },
        { planId: 'max20', months: 3 },
      ],
    },
    1,
  );
  assert.equal(periods[0].cost, 40);
  assert.equal(periods[1].cost, 600);
  assert.equal(total, 640);
  assert.equal(declaredMonths, 5);
});

test('seats and an override still apply per period', () => {
  const { total } = planTotal(
    {
      periods: [
        { planId: 'team', months: 2, seats: 4 },
        { planId: 'team', months: 1, seats: 4, monthlyOverride: 25 },
      ],
    },
    1,
  );
  assert.equal(total, 30 * 4 * 2 + 25 * 4 * 1);
});

test('a plan history is named by every tier in it', () => {
  const b = compareBilling({
    apiEquivalent: 5000,
    firstAt: 0,
    lastAt: 0,
    config: {
      periods: [
        { planId: 'pro', months: 2 },
        { planId: 'max20', months: 3 },
      ],
    },
  });
  assert.equal(b.planCost, 640);
  assert.equal(b.declaredMonths, 5);
  assert.equal(b.planLabel, 'Claude Pro + Claude Max 20×');
  assert.equal(b.periods.length, 2);
});

test('the declared plan and the transcripts covering different spans is stated, not hidden', () => {
  const DAYS = 86_400_000;
  const now = Date.now();
  const b = compareBilling({
    apiEquivalent: 500,
    firstAt: now - 40 * DAYS,
    lastAt: now,
    config: { periods: [{ planId: 'pro', months: 9 }] },
  });
  assert.equal(b.months, 2, 'the transcripts span two months');
  assert.equal(b.declaredMonths, 9, 'the plan is declared as nine');
  assert.equal(b.spanMismatch, true);
  assert.equal(b.planCost, 180);

  // And when they agree, there is nothing to say.
  const agreed = compareBilling({
    apiEquivalent: 500,
    firstAt: now - 40 * DAYS,
    lastAt: now,
    config: { periods: [{ planId: 'pro', months: 2 }] },
  });
  assert.equal(agreed.spanMismatch, false);
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

/* ------------------------------------------------------------------ *
 * Bounds
 *
 * `months` was capped from the start, with the reason written down: a typo in
 * a box should not produce an absurd plan. The other two numeric fields were
 * not, and the asymmetry had teeth.
 * ------------------------------------------------------------------ */

test('a typo in the seats box is clamped, the way a typo in months already was', () => {
  assert.equal(sanitizePeriod({ planId: 'team', seats: 1e9 }).seats, 10_000);
  assert.equal(sanitizePeriod({ planId: 'team', seats: 250 }).seats, 250, 'a real team is untouched');
  assert.equal(sanitizePeriod({ planId: 'team', seats: 1 }).seats, 1);
});

test('a plan price cannot be made large enough to overflow the comparison', () => {
  /**
   * At 1e308 over 600 months `planCost` reached `Infinity`, and the two halves
   * of the app then disagreed about the same config: the page reported
   * `api-ahead` with a difference of `-Infinity`, which renders as an em dash
   * ("costs — more than the usage"), while `shareFacts` ran it through
   * `finite()`, got 0, and the share card said no plan was set at all.
   */
  const period = { planId: 'custom', monthlyOverride: 1e308, months: 600 };
  assert.equal(sanitizePeriod(period).monthlyOverride, 1_000_000);

  const billing = compareBilling({
    apiEquivalent: 2_300,
    firstAt: Date.parse('2026-06-01T00:00:00Z'),
    lastAt: Date.parse('2026-08-01T00:00:00Z'),
    config: { periods: [period] },
  });
  assert.ok(Number.isFinite(billing.planCost), `planCost is ${billing.planCost}`);
  assert.ok(Number.isFinite(billing.difference));
  assert.ok(Number.isFinite(billing.ratio));
});

test('every period at every ceiling still produces a finite total', () => {
  // 24 periods is the cap, and all three fields at theirs is the largest config
  // the sanitiser will ever hand to the arithmetic.
  const maxed = Array.from({ length: 40 }, () => ({
    planId: 'custom',
    monthlyOverride: 1e308,
    seats: 1e9,
    months: 1e9,
  }));
  const { total, periods } = planTotal({ periods: maxed }, 1);
  assert.equal(periods.length, 24, 'the period list is capped');
  assert.ok(Number.isFinite(total), `total is ${total}`);
});
