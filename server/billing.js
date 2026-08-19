/**
 * Subscription versus API billing.
 *
 * Two different meters can produce the same tokens:
 *   - A **subscription** (Pro / Max) is authenticated over OAuth. Usage draws
 *     against plan limits and spends **no API credits**. The token cost this app
 *     computes is what the same work *would* have cost on the API — the value
 *     you are getting, not a charge you incurred.
 *   - **API billing** is authenticated with a key and bills per token. There the
 *     computed cost is the real charge.
 *
 * Which one is in play is detectable: Claude Code records its beta set in local
 * telemetry, and `oauth-2025-04-20` means subscription auth. What is *not* on
 * disk anywhere is the plan tier or its price, so those are the user's to set —
 * defaults are provided and are editable rather than asserted as current.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_DIR } from './scan.js';
import { CONFIG_DIR, LEGACY_CONFIG_DIR } from './paths.js';

const TELEMETRY_DIR = path.join(CLAUDE_DIR, 'telemetry');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LEGACY_CONFIG_FILE = path.join(LEGACY_CONFIG_DIR, 'config.json');

/**
 * Default monthly prices, in USD. These are starting points the user can edit —
 * published pricing changes, and this app should never quietly show a stale
 * number as fact.
 */
export const PLANS = [
  { id: 'none', name: 'No subscription', monthly: 0, note: 'Billing straight to API credits.' },
  { id: 'pro', name: 'Claude Pro', monthly: 20, note: 'Individual plan.' },
  { id: 'max5', name: 'Claude Max 5×', monthly: 100, note: 'Higher limits than Pro.' },
  { id: 'max20', name: 'Claude Max 20×', monthly: 200, note: 'Highest individual limits.' },
  { id: 'team', name: 'Team (per seat)', monthly: 30, note: 'Per-seat business plan.' },
  { id: 'custom', name: 'Custom', monthly: 0, note: 'Set your own monthly figure.' },
];

const DEFAULT_PERIOD = {
  planId: 'max20',
  monthlyOverride: null,
  seats: 1,
  /**
   * `null` means "however long the transcripts on this machine span".
   *
   * A number means the user knows better than the transcripts do, which is the
   * common case as soon as the history is incomplete: you have been paying for
   * eight months and this laptop has three of them on disk.
   */
  months: null,
};

/**
 * Somebody who has changed tier twice has three periods. Twenty-four is well
 * past any real billing history and stops a malformed file turning into a page
 * with ten thousand rows on it.
 */
const MAX_PERIODS = 24;

/** Fifty years. A typo in a months box should not produce a six-figure plan. */
const MAX_MONTHS = 600;

/**
 * The same reasoning as `MAX_MONTHS`, applied to the other two numbers — which
 * it was not, and that asymmetry was the bug.
 *
 * `seats` had no ceiling at all, so a fat-fingered `1000000000` in a box beside
 * a capped one produced a $360bn plan and a verdict computed against it. Worse,
 * `monthlyOverride` had none either: at 1e308 over 600 months `planCost`
 * overflows to `Infinity`, and the two halves of the app then tell different
 * stories about the same config. The page reports `api-ahead` with a difference
 * of `-Infinity` — rendered as an em dash, so the sentence reads "costs — more
 * than the usage" — while `shareFacts` runs it through `finite()`, gets 0, and
 * the share card says there is no plan set at all. One config, two
 * incompatible claims, which is the exact failure every breakdown summing to
 * the total exists to rule out.
 *
 * Clamped rather than rejected, because that is what `months` already does and
 * because this is a preference rather than a transaction: a plan that is too
 * large is shown at the ceiling, not thrown away.
 */
const MAX_SEATS = 10_000;
const MAX_MONTHLY = 1_000_000;

const DEFAULT_CONFIG = { periods: [{ ...DEFAULT_PERIOD }] };

/**
 * Force one period into a shape the arithmetic downstream can survive.
 *
 * Applied on the way in *and* on the way out, because there are two ways
 * nonsense arrives: a request body, and a file on disk that someone edited by
 * hand. Neither failure is loud on its own — an unknown `planId` falls through
 * to the $0 plan and reads as "no subscription", which is a claim rather than a
 * blank, and a `monthlyOverride` of `"abc"` becomes `NaN`, which propagates
 * through every comparison on the page as an empty figure.
 *
 * Bad values are dropped for the default rather than rejected. This is a
 * preference, not a transaction: the useful behaviour when the stored plan no
 * longer exists is to show a sensible one, not to break the page.
 */
export function sanitizePeriod(raw) {
  const period = { ...DEFAULT_PERIOD };
  if (!raw || typeof raw !== 'object') return period;

  if (PLANS.some((p) => p.id === raw.planId)) period.planId = raw.planId;

  // Explicit null means "use the plan's own price", which is different from an
  // unparseable value and has to survive.
  if (raw.monthlyOverride != null) {
    const monthly = Number(raw.monthlyOverride);
    if (Number.isFinite(monthly) && monthly >= 0) {
      period.monthlyOverride = Math.min(monthly, MAX_MONTHLY);
    }
  }

  const seats = Number(raw.seats);
  if (Number.isFinite(seats) && seats >= 1) {
    period.seats = Math.min(Math.floor(seats), MAX_SEATS);
  }

  // Same distinction again: null is "ask the transcripts", not "unparseable".
  if (raw.months != null) {
    const months = Number(raw.months);
    if (Number.isFinite(months) && months >= 1) {
      period.months = Math.min(Math.floor(months), MAX_MONTHS);
    }
  }

  return period;
}

/**
 * Force a whole config into shape.
 *
 * A config is a **list of periods**, because a year on one tier is not what most
 * people's billing history looks like: two months of Pro and then three of Max
 * is one plan cost, not an average of two prices. One period is always present —
 * the list is never empty, so the page never has to render a plan editor with
 * nothing in it.
 *
 * The pre-0.4 shape was a single flat plan. It is read as a one-period list
 * rather than discarded, so an existing config survives the change.
 */
export function sanitizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return { periods: [sanitizePeriod(null)] };

  if (Array.isArray(raw.periods)) {
    const periods = raw.periods.slice(0, MAX_PERIODS).map(sanitizePeriod);
    return { periods: periods.length ? periods : [sanitizePeriod(null)] };
  }

  return { periods: [sanitizePeriod(raw)] };
}

/** The stored preferences, falling back to the pre-rename location before the defaults. */
export function readConfig() {
  for (const file of [CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    try {
      return sanitizeConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      /* absent or unparseable — try the next, then the defaults */
    }
  }
  return sanitizeConfig(null);
}

/**
 * What the config becomes when a patch lands on it.
 *
 * A patch carrying `periods` **replaces** them. A list cannot be field-merged
 * without inventing a rule for which row a value belongs to, and the editor
 * always knows the whole list it is asking for.
 *
 * A patch carrying plain fields edits the **first** period instead. That is what
 * the pre-0.4 endpoint did, and what somebody scripting `{"planId": "pro"}`
 * against a one-plan config still means. `undefined` is dropped before that
 * merge — a plain spread does not distinguish it from an explicit value, and the
 * page names several fields per request, so a change of plan would otherwise
 * blank the seat count back to its default. `null` survives, because
 * `monthlyOverride: null` and `months: null` are both real values.
 */
export function mergeConfig(current, patch) {
  const base = sanitizeConfig(current);
  if (!patch || typeof patch !== 'object') return base;
  if (Array.isArray(patch.periods)) return sanitizeConfig({ periods: patch.periods });

  const given = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  const periods = base.periods.slice();
  periods[0] = sanitizePeriod({ ...periods[0], ...given });
  return { periods };
}

export async function writeConfig(patch) {
  const next = mergeConfig(readConfig(), patch);
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * What one period costs.
 *
 * `detectedMonths` is the span the transcripts cover, and is what a period with
 * no `months` of its own resolves to. That keeps the single-period case exactly
 * as it was before periods existed: leave the box empty and the app works the
 * length out for you.
 */
export function periodPrice(period, detectedMonths = 1) {
  const p = sanitizePeriod(period);
  const plan = PLANS.find((x) => x.id === p.planId) ?? PLANS[0];
  const base = p.monthlyOverride != null ? Number(p.monthlyOverride) : plan.monthly;
  const monthly = base * (p.seats || 1);
  const months = p.months ?? Math.max(1, Math.round(detectedMonths) || 1);
  return {
    planId: plan.id,
    planName: plan.name,
    note: plan.note,
    monthly,
    seats: p.seats,
    months,
    /** Whether this row's length was stated or worked out from the transcripts. */
    monthsDeclared: p.months != null,
    cost: monthly * months,
  };
}

/** The whole declared plan: every period priced, and what they add up to. */
export function planTotal(config = readConfig(), detectedMonths = 1) {
  const periods = sanitizeConfig(config).periods.map((p) => periodPrice(p, detectedMonths));
  return {
    periods,
    total: periods.reduce((sum, p) => sum + p.cost, 0),
    declaredMonths: periods.reduce((sum, p) => sum + p.months, 0),
  };
}

/** The first period's price, which is the whole story when there is only one. */
export function planPrice(config = readConfig(), detectedMonths = 1) {
  const first = periodPrice(sanitizeConfig(config).periods[0], detectedMonths);
  return { plan: PLANS.find((p) => p.id === first.planId) ?? PLANS[0], monthly: first.monthly };
}

/* ------------------------------------------------------------------ *
 * Auth-mode detection
 * ------------------------------------------------------------------ */

let authCache = null;

/**
 * Read local telemetry to work out how Claude Code is authenticating.
 * Cached — this reads a few hundred KB and the answer does not change often.
 */
export function detectAuth({ refresh = false } = {}) {
  if (authCache && !refresh) return authCache;

  const result = {
    mode: 'unknown',
    evidence: null,
    sampled: 0,
  };

  try {
    /**
     * The **newest** sixty files, not the first sixty the directory lists.
     *
     * Telemetry filenames are UUIDs, so directory order is unrelated to time,
     * and `slice(0, 60)` was therefore an arbitrary historical sample. That is
     * the wrong question: this function reports how Claude Code authenticates
     * *now*, because that is what decides which of the two figures on the page
     * is the hypothetical one.
     *
     * It also got the answer wrong outright for anyone who had switched. The
     * tally below requires `oauth >= apiKey`, so somebody who moved from an API
     * key to a subscription last week — with months of key-authenticated
     * telemetry still on disk — was reported as metered, and told the list-rate
     * figure was "what you were actually metered". Sampling newest-first makes
     * the recent state the one that wins.
     */
    const files = fs
      .readdirSync(TELEMETRY_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((name) => {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(path.join(TELEMETRY_DIR, name)).mtimeMs;
        } catch {
          /* vanished between the listing and the stat — sorts to the back */
        }
        return { name, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((f) => f.name);
    let oauth = 0;
    let apiKey = 0;
    for (const name of files.slice(0, 60)) {
      let text;
      try {
        text = fs.readFileSync(path.join(TELEMETRY_DIR, name), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim().replace(/,$/, '');
        if (!trimmed.startsWith('{')) continue;
        let evt;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const data = evt.event_data ?? {};
        if (typeof data.betas === 'string') {
          result.sampled += 1;
          if (data.betas.includes('oauth-')) oauth += 1;
          else apiKey += 1;
        }
      }
    }
    if (oauth > 0 && oauth >= apiKey) {
      result.mode = 'subscription';
      result.evidence = `oauth beta present in ${oauth} of ${result.sampled} sampled telemetry events`;
    } else if (apiKey > 0) {
      result.mode = 'api';
      result.evidence = `no oauth beta in ${apiKey} sampled telemetry events`;
    }
  } catch {
    /* no telemetry on disk — mode stays unknown */
  }

  authCache = result;
  return result;
}

/* ------------------------------------------------------------------ *
 * The comparison
 * ------------------------------------------------------------------ */

/**
 * How far apart the two prices are: 1.15 and 0.85 bracket a band where the
 * answer is "it makes no odds", which is a more useful thing to be told than a
 * winner declared by four percent.
 */
const PLAN_AHEAD = 1.15;
const API_AHEAD = 0.85;

/**
 * Compare **two prices, not two invoices.**
 *
 * Worth being exact about, because an earlier version of this was not. Nothing
 * in `~/.claude` records what anybody was charged: a transcript carries token
 * counts and a `service_tier`, and no field anywhere names a dollar, a credit
 * or an invoice. So both numbers here are computed, and neither is a bill:
 *
 * - `apiEquivalent` — the recorded tokens at published list rates.
 * - `planCost` — the prices *the user typed*, each over the months they declared.
 *
 * What is genuinely detectable is how Claude Code authenticates, and that says
 * which of the two is the hypothetical one. It does not say what anyone was
 * billed. This function used to return `apiCreditsSpent: 0` on the strength of
 * that detection, and the page printed it in a green tick box — a dollar figure
 * asserted from an auth heuristic, in the most confident presentation
 * available. It is gone, and nothing here replaces it, because there is nothing
 * on this machine that could.
 *
 * `firstAt`/`lastAt` bound the transcripts, giving the span a period falls back
 * to when it does not state its own length. Anything the user *does* state wins:
 * the history on one machine is not the history of the subscription, and after
 * a reinstall it is not even close.
 */
export function compareBilling({ apiEquivalent, firstAt, lastAt, config = readConfig() }) {
  const auth = detectAuth();

  const spanMs = Math.max(0, (lastAt ?? 0) - (firstAt ?? 0));
  const days = spanMs / 86_400_000;
  // Round up to whole months: you pay for a month even if you used four days of it.
  const months = Math.max(1, Math.ceil(days / 30.44));

  const { periods, total: planCost, declaredMonths } = planTotal(config, months);
  const first = periods[0];

  const ratio = planCost > 0 ? apiEquivalent / planCost : null;
  const difference = planCost > 0 ? apiEquivalent - planCost : 0;

  let verdict = 'unknown';
  if (planCost <= 0) verdict = 'no-plan';
  else if (apiEquivalent <= 0) verdict = 'no-usage';
  else if (ratio >= PLAN_AHEAD) verdict = 'plan-ahead';
  else if (ratio >= API_AHEAD) verdict = 'close';
  else verdict = 'api-ahead';

  // Several periods on the same tier read as one plan; different tiers get both
  // names, because "Claude Pro" alone would misdescribe half the money.
  const names = [...new Set(periods.filter((p) => p.cost > 0).map((p) => p.planName))];
  const planLabel = names.length ? names.join(' + ') : first.planName;

  return {
    authMode: auth.mode,
    authEvidence: auth.evidence,
    /** True when Claude Code authenticates with a key, so list rates *are* the bill. */
    metered: auth.mode === 'api',
    plan: { id: first.planId, name: first.planName, note: first.note, monthly: first.monthly },
    /** Every declared period, priced. One row is always present. */
    periods,
    /** "Claude Pro + Claude Max 20×" when the tier changed mid-history. */
    planLabel,
    /** The months the plan is charged for, which is the user's to declare. */
    declaredMonths,
    /**
     * The plan covers a different stretch of time from the transcripts.
     *
     * Not an error, and usually the point of the override: you have been paying
     * for eight months and this machine holds three of them. It does mean the
     * two sides of the comparison are measuring different spans, and the page
     * has to say so rather than quietly divide one by the other.
     */
    spanMismatch: declaredMonths !== months,
    /** The span the transcripts actually cover — the divisor for a run rate. */
    months,
    days: Math.round(days),
    /**
     * Whether the transcripts even cover the period being charged for.
     *
     * A fresh install has three days of history and gets billed for a whole
     * month, which makes any plan look like a bad deal. The comparison is still
     * shown — it is the honest one for the data present — but it has to say
     * that this is what it is looking at.
     */
    partialPeriod: days < 21,
    /** The recorded tokens at published list rates. */
    apiEquivalent,
    /** The plan price the user entered, over the months the work spans. */
    planCost,
    /** Positive: the plan is behind on volume. Negative: the plan cost more than the usage. */
    difference,
    /** "Every $1 of plan bought $N of API-rate usage." */
    ratio,
    /** 'plan-ahead' | 'close' | 'api-ahead' | 'no-plan' | 'no-usage' | 'unknown' */
    verdict,
    // Any declared period that costs something counts as being on a plan; a
    // history of "none" rows is not one however many of them there are.
    onSubscription: auth.mode === 'subscription' && planCost > 0,
  };
}
